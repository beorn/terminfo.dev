#!/usr/bin/env bun
/**
 * Transport-only driver for an owned-app measurement on an EXISTING remote macOS host.
 *
 * Transport changes WHERE a run starts, never what it may do: the identical owned-app argv
 * is executed on the host, under the host's own authority, from an exact-source checkout. This file
 * moves bytes and proves identity; it never parses or classifies a run, and it never decides what a
 * run may touch.
 *
 * Everything it needs is environment-owned configuration supplied by explicit arguments — the ssh
 * destination, the persistent stage directory, the known-hosts file. No host, account or key
 * material is product content; `--stage` names the only remote subtree this driver writes, and a
 * stage without this driver's marker is refused rather than deleted.
 *
 * ONE ssh command serves every transfer: the same options reach `ssh` and `rsync -e`, and
 * `-F /dev/null` keeps the user's ssh_config out of both, so no transfer picks up a ProxyJump, a
 * KnownHostsCommand or a host alias from it. GlobalKnownHostsFile=/dev/null keeps trust to the one
 * file the caller named.
 *
 * Steps, each refusing by name:
 *   host unreachable | host key mismatch | bundle missing objects | stage source mismatch |
 *   stage dirty tree | resource manifest mismatch | broken staged symlink | bun absent |
 *   kitty absent | output collision | rsync incomplete | receipt mismatch |
 *   invalid stage | stage not owned | stage removal failed | invalid context | invalid argv |
 *   owned-app probe failed | link closure exceeds N passes | timeout | invalid timeout
 *
 * The local resource manifest is computed BEFORE anything is staged and the remote recompute must
 * match it byte for byte; that compare is the proof, not the act of re-staging. The source half of
 * the manifest is measured from `git archive` of the exact revision, because that is exactly what
 * the bundle can carry — a working tree's ignored files are not staged and so cannot be compared.
 */
import { spawnSync } from "node:child_process"
import { createHash, randomBytes } from "node:crypto"
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, isAbsolute, join, relative as relativePath, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { TRANSPORT_RECEIPT_KIND } from "../packages/terminfo.dev/src/disposable-receipt.ts"
import { KITTY_BINARY_PATH } from "../packages/admin/src/kitty-binary.ts"

/** Production roots. The two environment names exist so this file's own tests can point at an
 * owned fixture tree. They are honoured only when VITEST=true, which the test runner sets, and a
 * run without it refuses them: that stops an override left in a shell from silently diverting a
 * real run. It is not a security boundary, since VITEST is environment too. */
const DEFAULT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
function rootOverride(name: string, fallback: string): string {
  const value = process.env[name]
  if (value === undefined || value === "") return fallback
  if (process.env.VITEST !== "true") {
    throw new Error(
      `${name} is a test-only override; a real transport run takes its trees and its kitty from fixed positions`,
    )
  }
  return value
}
const ROOT = rootOverride("OWNED_APP_TRANSPORT_SOURCE_ROOT", DEFAULT_ROOT)
const CODE_ROOT = rootOverride("OWNED_APP_TRANSPORT_RESOURCE_ROOT", resolve(ROOT, "../.."))
/** The kitty the owned-app producer launches; the receipt records this path, never a PATH lookup. */
const KITTY = rootOverride("OWNED_APP_TRANSPORT_KITTY_PATH", KITTY_BINARY_PATH)

/** Directories copied beside the checkout, and single files. Directory sources are sent with a
 * trailing slash so rsync copies their CONTENTS: a nested copy would duplicate the tree the
 * manifest then compares. */
const RESOURCE_DIRS = ["node_modules", "vendor/silvery", "vendor/termless"] as const
const RESOURCE_FILES = ["package.json", "bun.lock", "tsconfig.json"] as const
const STAGED_FROM_BUNDLE = "vendor/terminfo.dev"
const STAGE_MARKER = ".owned-app-transport-stage"
const STAGE_MARKER_VALUE = "owned-app-transport stage v1"
const CONNECT_TIMEOUT_SECONDS = "15"
/** Default limits. Both are parameters so a test can drive a small one and prove the refusal. */
const DEFAULT_SSH_TIMEOUT_MS = 15 * 60_000
const DEFAULT_RSYNC_TIMEOUT_MS = 30 * 60_000
/** Link-closure passes before the run refuses: a deeper chain is named, never cut short. */
const CLOSURE_PASSES = 3
/** The os this driver's hosts run; the identity sampler is told it, never left to infer it. */
const OWNED_HOST_OS = "macOS"
const CONTEXT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

export interface OwnedAppRemoteOptions {
  readonly transport: string
  readonly stage: string
  readonly output: string
  readonly sourceRevision: string
  readonly context: string
  readonly knownHosts: string
  readonly removeStage: boolean
  readonly sshTimeoutMs: number
  readonly rsyncTimeoutMs: number
  readonly argv: readonly string[]
}

export interface OwnedAppTransportProof {
  readonly runner: string
  readonly hostKeyFingerprint: string
  readonly resourceManifestSha256: string
  readonly resourceFiles: number
  readonly receiptSha256: string
  readonly remoteOutput: string
}

function fail(name: string, detail: string): never {
  throw new Error(`${name}: ${detail}`)
}

function sha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex")
}

/** Minutes of a millisecond limit, printed without trailing zeros. */
function minutesOf(milliseconds: number): string {
  return (milliseconds / 60_000).toFixed(2).replace(/\.?0+$/, "")
}

function shq(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/** rsync splits `-e` itself, not through a shell: a quote groups, a doubled quote inside it is a
 * literal quote, and a backslash is literal. shq's `'\''` would end rsync's quote instead. */
function rsyncWord(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

/** Canonical manifest lines: sorted `path<TAB>kind:value`. The same canonical text is produced from
 * the remote recompute, so equal digests mean equal bytes. */
function manifestScan(
  root: string,
  entries: readonly string[],
  missing: string,
  also: readonly string[] = [],
): { lines: string[]; linkTargets: string[] } {
  const lines: string[] = []
  // Staged-relative paths every link depends on: each hop's own lexical target AND the final real
  // target, so a chain a -> bridge/pkg -> ag/pkg stages bridge as well as ag.
  const linkTargets: string[] = []
  // Containment is decided on PHYSICAL roots, the same on both sides: a root under a symlinked
  // ancestor (macOS /tmp -> /private/tmp) would otherwise read its own targets as escapes. `also`
  // names further roots holding the same staged tree (the closure reaches declared resources
  // through the code root); each maps onto the same staged-relative paths.
  const physical = [root, ...also].map((path) => realpathSync(path))
  const stagedPath = (path: string): string | undefined => {
    for (const base of physical) {
      if (path === base) return ""
      if (path.startsWith(`${base}${sep}`)) return relativePath(base, path).split(sep).join("/")
    }
    return undefined
  }
  const walk = (path: string): void => {
    let info
    try {
      info = lstatSync(path)
    } catch {
      fail(missing, `declared resource ${JSON.stringify(path.slice(root.length + 1))} is absent`)
    }
    const relative = path.slice(root.length + 1)
    if (info.isSymbolicLink()) {
      const target = readlinkSync(path)
      // A link's text is what the stage will hold, and the host resolves it from a different
      // location. An absolute target would resolve against the HOST's filesystem, so identical
      // text and identical staged bytes could still read a file this run never measured.
      if (isAbsolute(target)) {
        fail("broken staged symlink", `${relative} -> ${target} is absolute and cannot be relocated into the stage`)
      }
      const resolved = resolve(dirname(path), target)
      // The hop's own text must stay inside the tree, or the host resolves it outside the stage.
      const hop =
        resolved === root ? "" : resolved.startsWith(`${root}${sep}`) ? resolved.slice(root.length + 1) : undefined
      if (hop === undefined) fail("resource manifest mismatch", `${relative} -> ${target} escapes the staged tree`)
      let real: string
      try {
        real = realpathSync(resolved)
      } catch {
        fail("broken staged symlink", `${relative} -> ${target} does not resolve`)
      }
      // The real path follows every intermediate link, so a chain that leaves the tree and comes
      // back — or leaves it for good — is refused on the bytes, not on the lexical text.
      const staged = stagedPath(real)
      if (staged === undefined) {
        fail("resource manifest mismatch", `${relative} -> ${target} escapes the staged tree`)
      }
      linkTargets.push(hop, staged)
      lines.push(`${relative}\tsymlink:${target}\tresolved:${staged}`)
      return
    }
    if (info.isDirectory()) {
      for (const child of readdirSync(path).sort()) {
        if (child === ".git") continue
        walk(join(path, child))
      }
      return
    }
    if (!info.isFile()) fail(missing, `${relative} is neither a file, a directory nor a symlink`)
    lines.push(`${relative}\tsha256:${sha256(readFileSync(path))}`)
  }
  if (entries.length === 0) {
    walk(root)
  } else {
    for (const entry of entries) walk(join(root, entry))
  }
  lines.sort()
  return { lines, linkTargets }
}

/** Every directory a resolving link reaches must ALSO be staged, or the staged tree holds a link
 * the local tree could resolve and the host cannot. Two segments are kept for vendor/* because the
 * bundle owns vendor/terminfo.dev and must never be rsynced over it; a link to the root, to vendor/
 * or to any other ancestor of that tree is refused here, before anything is staged. */
function extraRootsFor(targets: readonly string[], declared: readonly string[]): string[] {
  const extras = new Set<string>()
  for (const relative of targets) {
    if (relative.startsWith(`${STAGED_FROM_BUNDLE}/`) || relative === STAGED_FROM_BUNDLE) continue
    if (relative === "" || STAGED_FROM_BUNDLE.startsWith(`${relative}/`)) {
      fail(
        "resource manifest mismatch",
        `a staged link reaches ${JSON.stringify(relative || ".")}, which holds the bundle-owned ${STAGED_FROM_BUNDLE}; staging it would copy over the exact-source checkout`,
      )
    }
    const parts = relative.split("/").filter(Boolean)
    const first = parts[0]
    if (first === undefined) continue
    const candidate = first === "vendor" && parts[1] !== undefined ? `vendor/${parts[1]}` : first
    if (candidate === STAGED_FROM_BUNDLE || candidate.startsWith(`${STAGED_FROM_BUNDLE}/`)) continue
    if (declared.some((entry) => candidate === entry || candidate.startsWith(`${entry}/`))) continue
    extras.add(candidate)
  }
  return [...extras].sort()
}

function digestValue(lines: readonly string[]): { sha256: string; files: number } {
  return { sha256: sha256(lines.join("\n")), files: lines.length }
}

/** Rebuild the same canonical text from the remote file/symlink listing. */
function canonicalRemote(
  files: readonly string[],
  links: readonly string[],
): { sha256: string; files: number; lines: string[] } {
  const lines = files.map((line) => {
    const match = /^([a-f0-9]{64})[ \t]+\*?\.?\/(.+)$/.exec(line.trim())
    const [, hash, path] = match ?? []
    if (hash === undefined || path === undefined) {
      fail("resource manifest mismatch", `remote listing line is not a sha256 file record: ${JSON.stringify(line)}`)
    }
    return `${path.replace(/\\/g, "/")}\tsha256:${hash}`
  })
  for (const line of links) {
    const [rawPath, target, state, resolved] = line.split("\t")
    if (rawPath === undefined || target === undefined || state === undefined || resolved === undefined) {
      fail("resource manifest mismatch", `remote symlink line is malformed: ${JSON.stringify(line)}`)
    }
    const relative = rawPath.replace(/^\.\//, "")
    // A link the host cannot resolve, or resolves outside the staged tree, is a staged tree that
    // differs from the one measured locally even when the target text is byte-identical: refusal,
    // never a manifest match. The resolved path is compared too, so an escape by any other route
    // cannot ride on matching link text.
    if (state !== "ok") {
      fail("broken staged symlink", `${relative} -> ${target} resolves ${state} in the stage (${resolved})`)
    }
    lines.push(`${relative}\tsymlink:${target}\tresolved:${resolved}`)
  }
  lines.sort()
  return { ...digestValue(lines), lines }
}

/** The first line the two manifests disagree on, so a mismatch says WHICH byte differed. */
function firstDifference(local: readonly string[], remote: readonly string[]): string {
  for (let index = 0; index < Math.max(local.length, remote.length); index += 1) {
    if (local[index] !== remote[index]) {
      return `line ${String(index + 1)}: local ${JSON.stringify(local[index] ?? "<absent>")} != staged ${JSON.stringify(remote[index] ?? "<absent>")}`
    }
  }
  return "none"
}

type Parsed = OwnedAppRemoteOptions

function parseArgs(argv: readonly string[]): Parsed {
  const values: Record<string, string> = {}
  let removeStage = false
  let index = 0
  for (; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === undefined) usage()
    if (arg === "--") {
      index += 1
      break
    }
    if (arg === "--remove-stage") {
      removeStage = true
      continue
    }
    if (
      ![
        "--transport",
        "--stage",
        "--output",
        "--source-revision",
        "--context",
        "--known-hosts",
        "--ssh-timeout-ms",
        "--rsync-timeout-ms",
      ].includes(arg)
    ) {
      usage()
    }
    const value = argv[index + 1]
    if (value === undefined || value.startsWith("--")) usage()
    values[arg.slice(2)] = value
    index += 1
  }
  const rest = argv.slice(index)
  const transport = values.transport ?? usage()
  const rawStage = values.stage ?? usage()
  const output = values.output ?? usage()
  const sourceRevision = values["source-revision"] ?? usage()
  const context = values.context ?? usage()
  const knownHosts = values["known-hosts"] ?? usage()
  const sshTimeoutMs = limitOf(values["ssh-timeout-ms"], DEFAULT_SSH_TIMEOUT_MS)
  const rsyncTimeoutMs = limitOf(values["rsync-timeout-ms"], DEFAULT_RSYNC_TIMEOUT_MS)
  if (!rest.length) usage()
  if (!/^ssh:[A-Za-z0-9._-]+@[A-Za-z0-9._-]+$/.test(transport)) {
    fail(
      "host unreachable",
      `unsupported transport ${JSON.stringify(transport)}; this driver speaks ssh:<user>@<host> only`,
    )
  }
  if (!/^[a-f0-9]{40}$/.test(sourceRevision)) {
    fail("bundle missing objects", `source revision ${JSON.stringify(sourceRevision)} is not a full sha`)
  }
  if (!CONTEXT_PATTERN.test(context)) {
    fail(
      "invalid context",
      `context ${JSON.stringify(context)} is not a plain identifier (letters, digits, dot, underscore, dash; no separators)`,
    )
  }
  const stage = rawStage.replace(/\/+$/, "")
  validateStage(stage)
  return {
    transport,
    stage,
    output: resolve(output),
    sourceRevision,
    context,
    knownHosts: resolve(knownHosts),
    removeStage,
    sshTimeoutMs,
    rsyncTimeoutMs,
    argv: rest,
  }
}

/** A positive whole number of milliseconds, or the default. */
function limitOf(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < 1) {
    fail(
      "invalid timeout",
      `--ssh-timeout-ms/--rsync-timeout-ms take positive whole milliseconds, got ${JSON.stringify(raw)}`,
    )
  }
  return value
}

/** A stage is a driver-owned directory: absolute, normalized, neither the root nor a path whose
 * deletion would take a parent with it. The remote home check happens once the host answers. */
function validateStage(stage: string): void {
  if (!stage.startsWith("/")) fail("invalid stage", `stage ${JSON.stringify(stage)} must be an absolute path`)
  if (resolve(stage) !== stage) fail("invalid stage", `stage ${JSON.stringify(stage)} is not a normalized path`)
  const segments = stage.split("/").filter(Boolean)
  if (segments.length < 2) fail("invalid stage", `stage ${JSON.stringify(stage)} is too close to the root to own`)
  // A stage travels into rsync's remote operand, so every segment is a plain name: no spaces, no
  // shell metacharacters, no separators beyond the path slashes already split on.
  if (segments.some((segment) => !/^[A-Za-z0-9._-]+$/.test(segment) || segment === ".." || segment === ".")) {
    fail("invalid stage", `stage ${JSON.stringify(stage)} carries a segment that is not a plain name`)
  }
}

function usage(): never {
  console.error(
    "Usage: bun scripts/owned-app-remote-run.ts --transport ssh:<user>@<host> --stage <remote-dir>\n" +
      "         --output <local-output-dir> --source-revision <sha> --context <id>\n" +
      "         --known-hosts <path> [--remove-stage] [--ssh-timeout-ms <ms>]\n" +
      "         [--rsync-timeout-ms <ms>] -- <owned-app argv starting with bun>",
  )
  process.exit(2)
}

/** The one ssh command every transfer uses. The known-hosts file is environment-owned input, named
 * explicitly; nothing here writes to it, and the global file is disabled so trust is exactly what
 * the caller named. `-F /dev/null` keeps every ssh_config file out, the user's and the system's;
 * and since ssh keeps the FIRST value it reads for an option, nothing may be placed ahead of these. */
function sshOptions(options: Parsed): string[] {
  return [
    "-F",
    "/dev/null",
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    `UserKnownHostsFile=${options.knownHosts}`,
    "-o",
    "GlobalKnownHostsFile=/dev/null",
    "-o",
    `ConnectTimeout=${CONNECT_TIMEOUT_SECONDS}`,
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=4",
  ]
}

/** rsync splits `-e` with its own quote rule, so every token is quoted for that rule. */
function sshCommandLine(options: Parsed): string {
  return ["ssh", ...sshOptions(options)].map(rsyncWord).join(" ")
}

/** A refusal raised by a timeout: the remote side may still be running, so nothing removes the stage. */
function isTimeout(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith("timeout: ")
}

function sshRun(
  options: Parsed,
  label: string,
  failure: string,
  command: string,
  extra: { input?: string; verbose?: boolean } = {},
): { stdout: string; stderr: string } {
  const result = spawnSync(
    "ssh",
    [...sshOptions(options), ...(extra.verbose ? ["-v"] : []), "--", options.transport.slice(4), command],
    // A wedged connection must fail the run by name rather than hang a collector forever. Killing
    // the local ssh does not stop a remote command started without a tty, so the refusal says so.
    { encoding: "utf8", input: extra.input, maxBuffer: 64 * 1024 * 1024, timeout: options.sshTimeoutMs },
  )
  if (result.error) {
    if ((result.error as NodeJS.ErrnoException).code === "ETIMEDOUT") {
      fail(
        "timeout",
        `${label} exceeded ${minutesOf(options.sshTimeoutMs)} min; the remote command may still be running on ${options.transport.slice(4)}, so the stage is kept`,
      )
    }
    fail("host unreachable", `${label}: ${result.error.message}`)
  }
  if (result.status !== 0) {
    const detail = `${result.stderr}${result.stdout}`.trim()
    // ssh names a rejected host key on its own rail; the run is refused as a trust failure, not as
    // an unreachable host, so the operator sees which one it was.
    if (/Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/.test(detail)) {
      fail("host key mismatch", `${label}: ${detail}`)
    }
    fail(failure, `${label} exited ${String(result.status)}: ${detail}`)
  }
  return { stdout: result.stdout, stderr: result.stderr }
}

/** The key ssh ACTUALLY negotiated, not the first record the known-hosts file happens to hold for
 * the host: ssh names it on its own verbose rail after the handshake. Exactly one such line is
 * required; two mean a second hop answered too, and which key is the host's is then a guess. */
function hostKeyOf(verboseStderr: string): { algorithm: string; fingerprint: string } {
  const matches = [...verboseStderr.matchAll(/Server host key: (\S+) (SHA256:\S+)/g)]
  const match = matches[0]
  if (matches.length !== 1 || !match?.[1] || !match[2]) {
    fail(
      "host key mismatch",
      matches.length === 0
        ? "ssh did not report the host key it verified; no trust is assumed"
        : `ssh reported ${String(matches.length)} server host keys; exactly one is required, so no trust is assumed`,
    )
  }
  return { algorithm: match[1], fingerprint: match[2] }
}

/** The bundle is the only way source reaches the host: an exact sha, verified before it is used. */
function createBundle(options: Parsed, directory: string): string {
  const path = join(directory, "source.bundle")
  const git = (...args: string[]): string => {
    const result = spawnSync("git", ["-C", ROOT, ...args], { encoding: "utf8" })
    if (result.error || result.status !== 0) {
      fail("bundle missing objects", `git ${args.join(" ")}: ${result.error?.message ?? result.stderr.trim()}`)
    }
    return result.stdout.trim()
  }
  const head = git("rev-parse", "HEAD")
  if (head !== options.sourceRevision) {
    fail(
      "bundle missing objects",
      `HEAD is ${head} but the run names source ${options.sourceRevision}; the transport bundles the checked-out revision, never another`,
    )
  }
  git("bundle", "create", path, "HEAD")
  const verify = spawnSync("git", ["-C", ROOT, "bundle", "verify", path], { encoding: "utf8" })
  if (verify.error || verify.status !== 0) {
    fail(
      "bundle missing objects",
      `git bundle verify refused ${path}: ${verify.error?.message ?? verify.stderr.trim()}`,
    )
  }
  return path
}

/** Exactly what the bundle can carry for the source half: the tracked tree at the exact revision.
 * A working-tree walk would count ignored files the staged checkout never receives. */
function archiveOf(options: Parsed, destination: string): string {
  // The extraction is rooted where the checkout will be, so every manifest path is the path the
  // host will hold: vendor/terminfo.dev/... and never a flattened collision with a resource file.
  const extractRoot = join(destination, STAGED_FROM_BUNDLE)
  mkdirSync(extractRoot, { recursive: true })
  const archivePath = join(destination, "..", "source.tar")
  const archive = spawnSync("git", ["-C", ROOT, "archive", "--format=tar", "-o", archivePath, options.sourceRevision], {
    encoding: "utf8",
  })
  if (archive.error || archive.status !== 0) {
    fail(
      "bundle missing objects",
      `git archive ${options.sourceRevision}: ${archive.error?.message ?? archive.stderr.trim()}`,
    )
  }
  const extract = spawnSync("tar", ["-x", "-f", archivePath, "-C", extractRoot], { encoding: "utf8" })
  if (extract.error || extract.status !== 0) {
    fail("bundle missing objects", `tar -x: ${extract.error?.message ?? extract.stderr.trim()}`)
  }
  return destination
}

/** The closure root mirrors CODE_ROOT's top level with links, so a link inside an extracted root
 * can be checked for existence before its own target root is added. Each added root then replaces
 * its mirror link with a tracked extract. */
function closureMirror(closure: string): void {
  mkdirSync(join(closure, "vendor"), { recursive: true })
  for (const entry of readdirSync(CODE_ROOT)) {
    if (entry !== "vendor" && entry !== ".git") symlinkSync(join(CODE_ROOT, entry), join(closure, entry))
  }
  const vendor = join(CODE_ROOT, "vendor")
  if (!existsSync(vendor)) return
  for (const entry of readdirSync(vendor)) symlinkSync(join(vendor, entry), join(closure, "vendor", entry))
}

/** A link-closure root ships ONLY what CODE_ROOT's HEAD tracks for it, at the revision HEAD records:
 * a submodule at its gitlink, a directory at its tree. Untracked and ignored files never reach the
 * host, and a root HEAD does not track as a directory is refused rather than copied from the disk. */
function trackedExtract(entry: string, closure: string): void {
  const listed = spawnSync("git", ["-C", CODE_ROOT, "ls-tree", "HEAD", "--", entry], { encoding: "utf8" })
  const [, type, object] = /^\d{6} (commit|tree) ([0-9a-f]{40,64})\t/.exec(listed.stdout ?? "") ?? []
  if (listed.error || listed.status !== 0 || type === undefined || object === undefined) {
    fail(
      "resource manifest mismatch",
      `a staged link reaches ${entry}, which ${CODE_ROOT} HEAD does not track as a directory; only tracked files are staged${listed.status === 0 ? "" : ` (${listed.error?.message ?? listed.stderr.trim()})`}`,
    )
  }
  const destination = join(closure, entry)
  rmSync(destination, { force: true })
  mkdirSync(destination, { recursive: true })
  const archivePath = join(dirname(closure), `${entry.replace(/\//g, "_")}.tar`)
  const repository = type === "commit" ? join(CODE_ROOT, entry) : CODE_ROOT
  const archive = spawnSync("git", ["-C", repository, "archive", "--format=tar", "-o", archivePath, object], {
    encoding: "utf8",
  })
  if (archive.error || archive.status !== 0) {
    fail(
      "resource manifest mismatch",
      `git archive ${object} for ${entry}: ${archive.error?.message ?? archive.stderr.trim()}`,
    )
  }
  const extract = spawnSync("tar", ["-x", "-f", archivePath, "-C", destination], { encoding: "utf8" })
  if (extract.error || extract.status !== 0) {
    fail("resource manifest mismatch", `tar -x for ${entry}: ${extract.error?.message ?? extract.stderr.trim()}`)
  }
}

/** Removal renames the stage aside first, so an interrupted delete never leaves a half-deleted
 * directory at the stage path that the next run would read as a stranger's: the stage path is
 * either whole or gone, and only the aside can be partial. */
function removeStage(options: Parsed): void {
  const stage = options.stage
  sshRun(
    options,
    "stage removal",
    "stage not owned",
    `test "$(cat ${shq(`${stage}/${STAGE_MARKER}`)} 2>/dev/null)" = ${shq(STAGE_MARKER_VALUE)} || { echo ${shq(`stage ${stage} has no valid marker; refusing to delete it`)} >&2; exit 7; }`,
  )
  const aside = `${stage}.removing-${randomBytes(6).toString("hex")}`
  sshRun(
    options,
    "stage removal",
    "stage removal failed",
    `mv -- ${shq(stage)} ${shq(aside)} || exit 1; find ${shq(aside)} -depth -delete || { echo ${shq(`the stage was moved to ${aside} and only part of it was deleted`)} >&2; exit 1; }`,
  )
}

function rsync(
  options: Parsed,
  label: string,
  source: string,
  destination: string,
  extra: readonly string[] = [],
): void {
  const result = spawnSync("rsync", ["-a", "-e", sshCommandLine(options), ...extra, "--", source, destination], {
    encoding: "utf8",
    timeout: options.rsyncTimeoutMs,
  })
  if (result.error) {
    if ((result.error as NodeJS.ErrnoException).code === "ETIMEDOUT") {
      fail(
        "timeout",
        `${label} exceeded ${minutesOf(options.rsyncTimeoutMs)} min; the remote rsync may still be running on ${options.transport.slice(4)}, so the stage is kept`,
      )
    }
    fail("rsync incomplete", `rsync ${source} -> ${destination}: ${result.error.message}`)
  }
  if (result.status !== 0) {
    fail(
      "rsync incomplete",
      `rsync ${source} -> ${destination} exited ${String(result.status)}: ${result.stderr.trim()}`,
    )
  }
}

function main(options: Parsed): OwnedAppTransportProof {
  const userAndHost = options.transport.slice(4)
  const stage = options.stage
  const source = `${stage}/source`
  const checkout = `${source}/${STAGED_FROM_BUNDLE}`

  // One verbose probe answers reachability, the remote home, and the key ssh verified.
  const reach = sshRun(options, "reachability probe", "host unreachable", `printf '%s\\n%s\\n' "$(hostname)" "$HOME"`, {
    verbose: true,
  })
  const [hostname, home] = reach.stdout.trim().split("\n")
  if (!hostname) fail("host unreachable", `${userAndHost} answered no hostname`)
  const key = hostKeyOf(reach.stderr)
  if (home === undefined || !home.startsWith("/")) {
    fail("invalid stage", `${hostname} answered no usable home directory; the stage cannot be checked against it`)
  }
  if (stage === home || home.startsWith(`${stage}/`)) {
    fail("invalid stage", `stage ${JSON.stringify(stage)} is the remote home or contains it`)
  }
  if (!existsSync(options.knownHosts)) {
    fail("host key mismatch", `no environment-owned known-hosts file at ${options.knownHosts}; trust is never invented`)
  }

  // The local manifest is bound before a single byte is staged: source from git archive, resources
  // from the code tree that will actually be copied.
  const scratch = mkdtempSync(join(tmpdir(), "owned-app-transport-"))
  // Set once this run has verified or written the stage marker: from then on a failed run still
  // honours --remove-stage, except after a timeout, when the remote side may still be using it.
  let owned = false
  try {
    const archived = archiveOf(options, join(scratch, "archive"))
    const declared = [...RESOURCE_DIRS, ...RESOURCE_FILES]
    const scan = manifestScan(CODE_ROOT, declared, "resource manifest mismatch")
    // Roots a link reaches beyond the declared resources ship from tracked extracts only, so the
    // closure is walked over the extracts, never over a working tree's untracked files.
    const closure = join(scratch, "closure")
    closureMirror(closure)
    let extras: string[] = []
    const closureLines: string[] = []
    let targets = scan.linkTargets
    for (let pass = 0; ; pass += 1) {
      const added = extraRootsFor(targets, [...declared, ...extras]).filter((root) => !extras.includes(root))
      if (added.length === 0) break
      if (pass === CLOSURE_PASSES) {
        fail(
          `link closure exceeds ${String(CLOSURE_PASSES)} passes`,
          `links still reach ${added.join(", ")} after ${String(CLOSURE_PASSES)} rounds of staging their targets; the chain is refused, never cut short`,
        )
      }
      for (const entry of added) trackedExtract(entry, closure)
      extras = [...extras, ...added]
      const next = manifestScan(closure, added, "resource manifest mismatch", [CODE_ROOT])
      closureLines.push(...next.lines)
      targets = next.linkTargets
    }
    const localLines = [
      ...manifestScan(archived, [], "resource manifest mismatch").lines,
      ...scan.lines,
      ...closureLines,
    ]
    localLines.sort()
    const local = digestValue(localLines)
    if (local.files === 0) fail("resource manifest mismatch", "the declared resources produced no files")

    const bundle = createBundle(options, scratch)

    // A stage that already exists must be one this driver made; a stranger's directory is refused,
    // never adopted and never deleted.
    sshRun(
      options,
      "stage ownership",
      "stage not owned",
      [
        `if [ -e ${shq(stage)} ]; then`,
        `  test "$(cat ${shq(`${stage}/${STAGE_MARKER}`)} 2>/dev/null)" = ${shq(STAGE_MARKER_VALUE)} || {`,
        `    echo ${shq(`stage ${stage} exists without this driver's marker; refusing to adopt or delete it`)} >&2`,
        `    exit 7`,
        `  }`,
        `fi`,
        `mkdir -p ${shq(`${stage}/runs`)}`,
        `printf '%s\\n' ${shq(STAGE_MARKER_VALUE)} > ${shq(`${stage}/${STAGE_MARKER}`)}`,
      ].join("\n"),
    )
    owned = true
    rsync(options, "bundle transfer", bundle, `${userAndHost}:${stage}/source.bundle`)
    // Source reaches the host as a bundle and is fetched by the exact ref the bundle records, so a
    // revision that is not the current HEAD still lands; git's own stderr is kept on failure.
    sshRun(
      options,
      "stage checkout",
      "stage source mismatch",
      [
        `set -e`,
        `mkdir -p ${shq(`${source}/vendor`)}`,
        `if [ ! -d ${shq(`${checkout}/.git`)} ]; then git init -q ${shq(checkout)}; fi`,
        `git -C ${shq(checkout)} fetch --force ${shq(`${stage}/source.bundle`)} 'HEAD:refs/owned-app/source'`,
        `git -C ${shq(checkout)} cat-file -e ${shq(`${options.sourceRevision}^{commit}`)}`,
        `git -C ${shq(checkout)} checkout --detach ${shq(options.sourceRevision)}`,
        `test "$(git -C ${shq(checkout)} rev-parse HEAD)" = ${shq(options.sourceRevision)}`,
      ].join("\n"),
    )
    const dirty = sshRun(
      options,
      "clean-tree check",
      "stage dirty tree",
      `git -C ${shq(checkout)} status --porcelain`,
    ).stdout.trim()
    if (dirty) fail("stage dirty tree", `the staged checkout holds changes no source revision names:\n${dirty}`)

    for (const [from, entry] of [
      ...RESOURCE_DIRS.map((entry) => [CODE_ROOT, entry] as const),
      ...extras.map((entry) => [closure, entry] as const),
    ]) {
      rsync(options, `resource transfer ${entry}`, `${from}/${entry}/`, `${userAndHost}:${source}/${entry}/`, [
        "--delete",
        "--exclude=.git",
      ])
    }
    for (const entry of RESOURCE_FILES) {
      rsync(options, `resource transfer ${entry}`, `${CODE_ROOT}/${entry}`, `${userAndHost}:${source}/${entry}`)
    }

    const files = sshRun(
      options,
      "remote file listing",
      "resource manifest mismatch",
      `cd ${shq(source)} && find . \\( -name .git -prune \\) -o -type f -print0 | LC_ALL=C sort -z | xargs -0 shasum -a 256`,
    ).stdout
    const links = sshRun(
      options,
      "remote symlink listing",
      "broken staged symlink",
      [
        // The physical root, never the logical $PWD: under a symlinked ancestor (macOS /tmp) realpath
        // answers physically, so a logical root would read every valid link as an escape.
        `cd ${shq(source)} && R=$(pwd -P) && export R &&`,
        `find . \\( -name .git -prune \\) -o -type l -exec sh -c '`,
        `  target=$(readlink "$1")`,
        `  if [ ! -e "$1" ]; then printf "%s\\t%s\\tdangling\\t%s\\n" "$1" "$target" "-"; exit 0; fi`,
        `  real=$(realpath "$1")`,
        `  case "$real" in`,
        `    "$R") printf "%s\\t%s\\tok\\t%s\\n" "$1" "$target" "" ;;`,
        `    "$R"/*) printf "%s\\t%s\\tok\\t%s\\n" "$1" "$target" "\${real#"$R"/}" ;;`,
        `    *) printf "%s\\t%s\\tescaped\\t%s\\n" "$1" "$target" "$real" ;;`,
        `  esac`,
        `' _ {} \\;`,
      ].join("\n"),
    ).stdout
    const remote = canonicalRemote(files.trim().split("\n").filter(Boolean), links.trim().split("\n").filter(Boolean))
    if (remote.sha256 !== local.sha256) {
      fail(
        "resource manifest mismatch",
        `local ${local.sha256} (${String(local.files)} files) != staged ${remote.sha256} (${String(remote.files)} files); ${firstDifference(localLines, remote.lines)}`,
      )
    }

    const bun = sshRun(options, "bun lookup", "bun absent", "command -v bun").stdout.trim()
    if (!bun) fail("bun absent", `no bun on ${hostname}; the probe cannot start`)
    const kitty = sshRun(
      options,
      "kitty lookup",
      "kitty absent",
      `test -x ${shq(KITTY)} && echo ${shq(KITTY)} || true`,
    ).stdout.trim()
    if (!kitty) fail("kitty absent", `no kitty at ${KITTY} on ${hostname}, the path the owned-app producer launches`)

    const remoteOutput = `${stage}/runs/${options.sourceRevision.slice(0, 12)}-${options.context}`
    sshRun(options, "remote output directory", "output collision", `mkdir -m 700 ${shq(remoteOutput)}`)

    // EEXIST is the refusal: mkdir without --parents fails on an existing directory instead of
    // silently reusing bytes from an earlier run.
    const localOutput = join(options.output, "transport")
    if (existsSync(localOutput)) fail("output collision", `${localOutput} already holds a transport run`)
    mkdirSync(localOutput, { mode: 0o700 })

    // The argv's first token names the runtime; the host's verified bun replaces it, so the probe
    // never reaches the host as "bun bun ...".
    const [runtime, ...probeArgs] = options.argv
    if (runtime !== "bun") {
      fail("invalid argv", `the owned-app argv must start with the bun runtime token, got ${JSON.stringify(runtime)}`)
    }
    const probe = sshRun(
      options,
      "owned-app probe",
      "owned-app probe failed",
      `cd ${shq(checkout)} && ${shq(bun)} ${probeArgs.map(shq).join(" ")} --output ${shq(remoteOutput)}`,
    )
    if (/ENOENT|not found/i.test(probe.stdout) && /kitty/i.test(probe.stdout)) {
      fail("kitty absent", `the owned-app probe on ${hostname} could not launch kitty: ${probe.stdout.trim()}`)
    }
    writeFileSync(join(localOutput, "launcher.stdout.log"), probe.stdout)
    writeFileSync(join(localOutput, "launcher.stderr.log"), probe.stderr)

    const measured = sshRun(
      options,
      "output listing",
      "rsync incomplete",
      `cd ${shq(remoteOutput)} && find . -type f -print0 | LC_ALL=C sort -z | xargs -0 shasum -a 256`,
    ).stdout
    const outputs = measured
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const match = /^([a-f0-9]{64})[ \t]+\*?\.\/(.+)$/.exec(line)
        const [, hash, path] = match ?? []
        if (hash === undefined || path === undefined) {
          fail("receipt mismatch", `remote output line is not a sha256 record: ${JSON.stringify(line)}`)
        }
        return { path, sha256: hash }
      })
    const runJson = outputs.filter((file) => !file.path.includes("/") && file.path.endsWith(".json"))
    if (runJson.length !== 1 || !runJson[0]) {
      fail(
        "receipt mismatch",
        `the remote probe produced ${String(runJson.length)} run JSON files; expected exactly one`,
      )
    }

    const samplerScript = join(stage, "identity.ts")
    sshRun(options, "identity sampler", "receipt mismatch", `cat > ${shq(samplerScript)}`, {
      // The os is named here, explicitly: an owned host is not a hosted runner, so no hosted-runner
      // variable is set for the sampler to read.
      input:
        `import { sampleOwnedHostIdentity } from ${JSON.stringify(`${checkout}/packages/terminfo.dev/src/disposable-receipt.ts`)}\n` +
        `process.stdout.write(JSON.stringify(sampleOwnedHostIdentity(${JSON.stringify(OWNED_HOST_OS)})))\n`,
    })
    const sampled = sshRun(
      options,
      "identity sample",
      "receipt mismatch",
      `cd ${shq(stage)} && ${shq(bun)} ${shq(samplerScript)}`,
    )
    let identity: Record<string, string>
    try {
      identity = JSON.parse(sampled.stdout) as Record<string, string>
    } catch {
      fail("receipt mismatch", `the host identity sampler returned no JSON: ${JSON.stringify(sampled.stdout.trim())}`)
    }
    if (Object.keys(identity).length === 0) {
      fail("receipt mismatch", "the host identity sampler produced no ratified identity field")
    }

    const bunVersion = sshRun(options, "bun --version", "receipt mismatch", `${shq(bun)} --version`).stdout.trim()
    const kittyVersion = sshRun(
      options,
      "kitty --version",
      "receipt mismatch",
      `${shq(kitty)} --version 2>/dev/null || true`,
    ).stdout.trim()
    if (!kittyVersion) fail("receipt mismatch", `${kitty} reported no version; the runtime identity is incomplete`)
    const receipt = {
      schemaVersion: 1,
      kind: TRANSPORT_RECEIPT_KIND,
      grants: "nothing",
      transport: options.transport,
      host: { hostname, home },
      hostKey: { algorithm: key.algorithm, fingerprint: key.fingerprint },
      hostKeyFingerprint: key.fingerprint,
      identity,
      runtime: { bun: { path: bun, version: bunVersion }, kitty: { path: kitty, version: kittyVersion } },
      sourceRevision: options.sourceRevision,
      resourceManifestSha256: local.sha256,
      resourceFiles: local.files,
      stage: { directory: stage, marker: STAGE_MARKER_VALUE },
      output: { directory: remoteOutput, files: outputs },
    }
    const bytes = `${JSON.stringify(receipt, null, 2)}\n`
    sshRun(options, "receipt write", "receipt mismatch", `cat > ${shq(`${remoteOutput}/transport-receipt.json`)}`, {
      input: bytes,
    })

    rsync(options, "copy-back", `${userAndHost}:${remoteOutput}/`, `${localOutput}/`)
    for (const file of outputs) {
      const localPath = join(localOutput, file.path)
      if (!existsSync(localPath)) fail("rsync incomplete", `${file.path} did not arrive from ${hostname}`)
      if (sha256(readFileSync(localPath)) !== file.sha256) {
        fail("receipt mismatch", `${file.path} arrived with bytes the host did not measure`)
      }
    }
    const receiptPath = join(localOutput, "transport-receipt.json")
    if (!existsSync(receiptPath)) fail("rsync incomplete", "the transport receipt did not arrive from the host")
    const receiptSha256 = sha256(readFileSync(receiptPath))
    if (receiptSha256 !== sha256(bytes)) {
      fail("receipt mismatch", "the returned receipt differs from the bytes written on the host")
    }

    if (options.removeStage) {
      owned = false
      removeStage(options)
    }

    return {
      runner: options.transport,
      hostKeyFingerprint: key.fingerprint,
      resourceManifestSha256: local.sha256,
      resourceFiles: local.files,
      receiptSha256,
      remoteOutput,
    }
  } catch (error) {
    if (options.removeStage && owned && !isTimeout(error)) {
      try {
        removeStage(options)
      } catch (removal) {
        throw new Error(`${String((error as Error).message)}; ${String((removal as Error).message)}`)
      }
    }
    throw error
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

if (import.meta.main) {
  try {
    const proof = main(parseArgs(process.argv.slice(2)))
    console.log(JSON.stringify(proof))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}
