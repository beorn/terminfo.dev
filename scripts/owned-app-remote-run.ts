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
import { randomBytes } from "node:crypto"
import {
  existsSync,
  openSync,
  closeSync,
  statSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { TRANSPORT_RECEIPT_KIND } from "../packages/terminfo.dev/src/disposable-receipt.ts"
import { KITTY_BINARY_PATH } from "../packages/admin/src/kitty-binary.ts"
import { RESOURCE_EXCLUDES, manifestScan, digestValue, sha256 } from "./owned-app-resource-manifest.ts"

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

/** Written by a run that passed the FULL comparison, and the only thing a light run trusts its
 * node_modules trees through. It names the lock the trees were installed from and the digest they
 * hashed to, so a changed lock, a missing marker or a marker from another tool restages fully. */
const RESOURCE_MARKER = ".owned-app-transport-resources"
const RESOURCE_MARKER_VERSION = 1

interface ResourceMarker {
  readonly version: number
  readonly lockSha256: string
  readonly manifestSha256: string
  readonly files: number
  readonly sourceRevision: string
}

/** How deep a run checks the staged tree. `full` hashes every tracked file and every resource on
 * both sides and is the only depth a placed run may use; `light` trusts node_modules through the
 * stage's resource marker and the tracked source through its git tree id, and its receipt says so. */
type CheckDepth = "full" | "light"

/**
 * The gitignored dependency-link directories INSIDE the bundle-owned checkout that exist in the code
 * tree: its own node_modules and each packages/<name>/node_modules. The bundle cannot carry them (git
 * never tracks node_modules), and under bun's isolated install a package's own dependencies resolve
 * only through them, never from a hoisted root entry: without them the probe failed at import with
 * "Cannot find package 'protobufjs'" (33587 run 2). They are the one exception to "nothing copies
 * over the bundle-owned tree": a checkout never writes an ignored path, so the clean-tree check still
 * holds, and their links resolve into the declared root node_modules or the link closure.
 */
function bundleLinkDirs(): string[] {
  const base = join(CODE_ROOT, STAGED_FROM_BUNDLE)
  const packages = join(base, "packages")
  const candidates = [
    `${STAGED_FROM_BUNDLE}/node_modules`,
    ...(existsSync(packages)
      ? readdirSync(packages)
          .sort()
          .map((name) => `${STAGED_FROM_BUNDLE}/packages/${name}/node_modules`)
      : []),
  ]
  return candidates.filter((entry) => {
    const path = join(CODE_ROOT, entry)
    return existsSync(path) && lstatSync(path).isDirectory()
  })
}
const STAGE_MARKER = ".owned-app-transport-stage"
const STAGE_MARKER_VALUE = "owned-app-transport stage v1"
/** Written only when the staged index is proven unreadable; the checkout step reads it. */
const STAGE_REBUILD_MARKER = ".owned-app-transport-rebuild"
const CONNECT_TIMEOUT_SECONDS = "15"
/** Default limits. Both are parameters so a test can drive a small one and prove the refusal. */
const DEFAULT_SSH_TIMEOUT_MS = 15 * 60_000
const DEFAULT_RSYNC_TIMEOUT_MS = 30 * 60_000
/** Link-closure passes before the run refuses: a deeper chain is named, never cut short. */
const CLOSURE_PASSES = 3
/** The os this driver's hosts run; the identity sampler is told it, never left to infer it. */
const OWNED_HOST_OS = "macOS"
/** The tracked identity sampler, run by path inside the staged checkout with the os as its argument. */
const IDENTITY_SCRIPT = "scripts/owned-host-identity.ts"
const CONTEXT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

export interface OwnedAppRemoteOptions {
  readonly transport: string
  readonly stage?: string
  readonly output: string
  readonly sourceRevision: string
  readonly context: string
  readonly knownHosts: string
  readonly removeStage: boolean
  readonly check: CheckDepth
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
  readonly check: CheckDepth
}

function fail(name: string, detail: string): never {
  throw new Error(`${name}: ${detail}`)
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
        "--check",
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
  const rawStage = values.stage
  const output = values.output ?? usage()
  const sourceRevision = values["source-revision"] ?? usage()
  const context = values.context ?? usage()
  const knownHosts = values["known-hosts"] ?? usage()
  const sshTimeoutMs = limitOf(values["ssh-timeout-ms"], DEFAULT_SSH_TIMEOUT_MS)
  const rsyncTimeoutMs = limitOf(values["rsync-timeout-ms"], DEFAULT_RSYNC_TIMEOUT_MS)
  const rawCheck = values.check
  if (rawCheck !== undefined && rawCheck !== "full" && rawCheck !== "light") {
    fail(
      "invalid check",
      `--check ${JSON.stringify(rawCheck)} is not a check depth; the depths are full (hash everything, the only placable one) and light (uncounted runs only)`,
    )
  }
  const check: CheckDepth = rawCheck === "light" ? "light" : "full"
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
  const stage = rawStage?.replace(/\/+$/, "")
  if (stage !== undefined) validateStage(stage)
  return {
    transport,
    stage,
    output: resolve(output),
    sourceRevision,
    context,
    knownHosts: resolve(knownHosts),
    removeStage,
    check,
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
function validateStage(stage: string, hint = ""): void {
  if (!stage.startsWith("/")) fail("invalid stage", `stage ${JSON.stringify(stage)} must be an absolute path${hint}`)
  if (resolve(stage) !== stage) fail("invalid stage", `stage ${JSON.stringify(stage)} is not a normalized path${hint}`)
  const segments = stage.split("/").filter(Boolean)
  if (segments.length < 2) {
    fail("invalid stage", `stage ${JSON.stringify(stage)} is too close to the root to own${hint}`)
  }
  // A stage travels into rsync's remote operand, so every segment is a plain name: no spaces, no
  // shell metacharacters, no separators beyond the path slashes already split on.
  if (segments.some((segment) => !/^[A-Za-z0-9._-]+$/.test(segment) || segment === ".." || segment === ".")) {
    fail("invalid stage", `stage ${JSON.stringify(stage)} carries a segment that is not a plain name${hint}`)
  }
}

function usage(): never {
  console.error(
    "Usage: bun scripts/owned-app-remote-run.ts --transport ssh:<user>@<host> [--stage <remote-dir>]\n" +
      "         --output <local-output-dir> --source-revision <sha> --context <id>\n" +
      "         --known-hosts <path> [--remove-stage] [--check full|light] [--ssh-timeout-ms <ms>]\n" +
      "         [--rsync-timeout-ms <ms>] -- <owned-app argv starting with bun>\n" +
      "       Without --stage the run uses <remote-home>/.cache/terminfo.dev/owned-app-stage.",
  )
  process.exit(2)
}

/** The stage a run uses when none is named: a fixed cache directory under the home the host answered. */
function defaultStage(home: string): string {
  const stage = `${home.replace(/\/+$/, "")}/.cache/terminfo.dev/owned-app-stage`
  validateStage(
    stage,
    " (defaulted from the remote home; pass --owned-app-stage, or this driver's --stage, to choose one)",
  )
  console.error(`owned-app transport: no --stage given; using ${stage} on the remote host`)
  return stage
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

/** The light check's exit witness: a `git status` that could not run must never read as clean. */
const LIGHT_STATUS_WITNESS = "__terminfo_git_status_exit="

/** What a light run checks before it may skip the node_modules hashing: the stage's resource
 * marker still names the lock this machine holds, and the staged checkout still holds the named
 * revision's own tree. Every failure is a reason to restage fully, never a silent shorter check. */
function readLightStage(
  options: Parsed,
  stage: string,
  checkout: string,
  lockSha256: string,
): { ok: true; marker: ResourceMarker } | { ok: false; reason: string } {
  const raw = sshRun(
    options,
    "resource marker read",
    "stage not owned",
    `cat ${shq(`${stage}/${RESOURCE_MARKER}`)} || true`,
  ).stdout
  if (raw.trim() === "") return { ok: false, reason: "the stage holds no resource marker" }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw) as unknown
  } catch {
    return {
      ok: false,
      reason: `the stage's resource marker is not JSON (${JSON.stringify(raw.trim().slice(0, 80))})`,
    }
  }
  // JSON parses `null` and every scalar, and reading `.version` off those throws instead of taking
  // the named full-restage fallback. Only an object can hold a marker.
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      ok: false,
      reason: `the stage's resource marker is not a JSON object (${JSON.stringify(raw.trim().slice(0, 80))})`,
    }
  }
  const marker = parsed as Partial<ResourceMarker>
  if (marker.version !== RESOURCE_MARKER_VERSION) {
    return {
      ok: false,
      reason: `the stage's resource marker is version ${JSON.stringify(marker.version)}, not ${String(RESOURCE_MARKER_VERSION)}`,
    }
  }
  if (
    typeof marker.lockSha256 !== "string" ||
    typeof marker.manifestSha256 !== "string" ||
    typeof marker.files !== "number"
  ) {
    return { ok: false, reason: "the stage's resource marker omits the lock, the manifest or its file count" }
  }
  if (marker.lockSha256 !== lockSha256) {
    return { ok: false, reason: "bun.lock is not the lock the stage was last fully hashed against" }
  }
  // The tracked half, measured by git on the host: the checkout must hold the named revision's own
  // tree, hold that revision's object, and hold nothing no revision names.
  // One probe per fact, each answer trimmed on its own: a command that prints nothing must never
  // shift another's answer, which is how a clean checkout once read as a missing revision.
  const head = sshRun(
    options,
    "staged source head",
    "stage source mismatch",
    `git -C ${shq(checkout)} rev-parse HEAD || true`,
  ).stdout.trim()
  const tree = sshRun(
    options,
    "staged source tree",
    "stage source mismatch",
    `git -C ${shq(checkout)} rev-parse ${shq("HEAD^{tree}")} || true`,
  ).stdout.trim()
  // The exit witness is part of the answer, never a decoration: a status that could not RUN (an
  // unreadable index, a locked ref store) exits non-zero with empty stdout, and empty stdout read as
  // "clean" would trust a checkout whose dirt was never observed.
  const statusProbe = sshRun(
    options,
    "staged source clean",
    "stage source mismatch",
    `git -C ${shq(checkout)} status --porcelain; printf '\\n${LIGHT_STATUS_WITNESS}%s\\n' "$?"`,
  )
  const witness = new RegExp(`(?:^|\\n)${LIGHT_STATUS_WITNESS}(\\d+)\\s*$`).exec(statusProbe.stdout)
  if (witness === null) {
    return {
      ok: false,
      reason: "the staged checkout's dirty state could not be read (the probe answered no exit code)",
    }
  }
  const statusExit = Number(witness[1])
  if (statusExit !== 0) {
    // git's own words, not ssh's: the first stderr line of the whole call can be a login-shell or
    // connection notice, so a line that names itself as git's failure wins, and the last line is the
    // fallback because a shell wrapper's noise comes before the command that failed (@dev/15 R3 nit).
    const stderrLines = statusProbe.stderr
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "")
    const detail = stderrLines.find((line) => /^(fatal|error):/.test(line)) ?? stderrLines.at(-1) ?? ""
    return {
      ok: false,
      reason: `the staged checkout's dirty state could not be read (git status exited ${String(statusExit)}${detail === "" ? "" : `: ${detail.slice(0, 120)}`})`,
    }
  }
  const status = statusProbe.stdout.slice(0, witness.index).trim()
  if (head !== options.sourceRevision) {
    return {
      ok: false,
      reason: `the staged checkout is at ${JSON.stringify(head ?? "")}, not the named ${options.sourceRevision}`,
    }
  }
  if (tree === undefined || tree === "") return { ok: false, reason: "the staged checkout answered no tree id" }
  const expected = spawnSync("git", ["-C", ROOT, "rev-parse", `${options.sourceRevision}^{tree}`], {
    encoding: "utf8",
  })
  if (expected.error || expected.status !== 0) {
    fail(
      "bundle missing objects",
      `git rev-parse ${options.sourceRevision}^{tree}: ${expected.error?.message ?? expected.stderr.trim()}`,
    )
  }
  const named = expected.stdout.trim()
  if (tree !== named) {
    return { ok: false, reason: `the staged tree ${tree} is not ${options.sourceRevision}'s tree ${named}` }
  }
  if (status !== "") {
    return {
      ok: false,
      reason: `the staged checkout holds changes no revision names (${(status ?? "").split("\n")[0] ?? ""})`,
    }
  }
  return { ok: true, marker: marker as ResourceMarker }
}
/** Whether a stage is there at all, asked without writing anything: a light run may only trust a
 * stage an earlier run left, and this answers presence alone, never ownership. */
function stagePresence(options: Parsed, stage: string): boolean {
  const answer = sshRun(options, "stage presence", "stage not owned", `test -e ${shq(stage)} && echo present || true`)
  return answer.stdout.trim() === "present"
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
function trackedExtract(entry: string, closure: string, recorded?: { repository: string; object: string }): void {
  if (recorded === undefined) {
    const listed = spawnSync("git", ["-C", CODE_ROOT, "ls-tree", "HEAD", "--", entry], { encoding: "utf8" })
    const [, type, object] = /^\d{6} (commit|tree) ([0-9a-f]{40,64})\t/.exec(listed.stdout ?? "") ?? []
    if (listed.error || listed.status !== 0 || type === undefined || object === undefined) {
      fail(
        "resource manifest mismatch",
        `a staged link reaches ${entry}, which ${CODE_ROOT} HEAD does not track as a directory; only tracked files are staged${listed.status === 0 ? "" : ` (${listed.error?.message ?? listed.stderr.trim()})`}`,
      )
    }
    recorded = { repository: type === "commit" ? join(CODE_ROOT, entry) : CODE_ROOT, object }
    // Only the closure root is a mirror symlink; nested gitlinks are empty archive directories.
    rmSync(join(closure, entry), { force: true })
  }
  const { repository, object } = recorded
  const destination = join(closure, entry)
  mkdirSync(destination, { recursive: true })
  const archivePath = join(dirname(closure), `${entry.replace(/\//g, "_")}.tar`)
  const archive = spawnSync("git", ["-C", repository, "archive", "--format=tar", "-o", archivePath, object], {
    encoding: "utf8",
  })
  if (archive.error || archive.status !== 0) {
    fail(
      "resource manifest mismatch",
      `git archive ${object} for ${entry} in ${repository}: ${archive.error?.message ?? archive.stderr.trim()}`,
    )
  }
  const extract = spawnSync("tar", ["-x", "-f", archivePath, "-C", destination], { encoding: "utf8" })
  if (extract.error || extract.status !== 0) {
    fail("resource manifest mismatch", `tar -x for ${entry}: ${extract.error?.message ?? extract.stderr.trim()}`)
  }
  // Archive leaves gitlinks empty. Follow the parent's recorded objects, never checkout HEADs.
  const nested = spawnSync("git", ["-C", repository, "ls-tree", "-r", "-z", object], { encoding: "utf8" })
  if (nested.error || nested.status !== 0) {
    fail(
      "resource manifest mismatch",
      `git ls-tree ${object} for ${entry} in ${repository}: ${nested.error?.message ?? nested.stderr.trim()}`,
    )
  }
  for (const record of nested.stdout.split("\0")) {
    const [, nestedObject, nestedPath] = /^160000 commit ([0-9a-f]{40,64})\t([\s\S]+)$/.exec(record) ?? []
    if (nestedObject === undefined || nestedPath === undefined) continue
    const child = join(entry, nestedPath)
    trackedExtract(child, closure, { repository: join(CODE_ROOT, child), object: nestedObject })
  }
}

/** Removal renames the stage aside first, so an interrupted delete never leaves a half-deleted
 * directory at the stage path that the next run would read as a stranger's: the stage path is
 * either whole or gone, and only the aside can be partial. */
function removeStage(options: Parsed, stage: string): void {
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
  // Dependency trees can produce more diagnostics than spawnSync's pipe buffer holds.
  // Keep the complete child output even when the transfer fails before copy-back exists.
  mkdirSync(options.output, { recursive: true, mode: 0o700 })
  const diagnostics = join(mkdtempSync(join(options.output, "rsync-")), "diagnostics.log")
  const descriptor = openSync(diagnostics, "wx", 0o600)
  let result: ReturnType<typeof spawnSync>
  try {
    // Shared source trees can inherit setgid; runtime resources keep ordinary modes, not host privilege bits.
    result = spawnSync(
      "rsync",
      ["-a", "-e", sshCommandLine(options), "--chmod=ug-s", ...extra, "--", source, destination],
      {
        stdio: ["ignore", descriptor, descriptor],
        timeout: options.rsyncTimeoutMs,
      },
    )
  } finally {
    closeSync(descriptor)
  }
  if (result.error) {
    if ((result.error as NodeJS.ErrnoException).code === "ETIMEDOUT") {
      fail(
        "timeout",
        `${label} exceeded ${minutesOf(options.rsyncTimeoutMs)} min; the remote rsync may still be running on ${options.transport.slice(4)}, so the stage is kept; diagnostics: ${diagnostics}`,
      )
    }
    fail("rsync incomplete", `rsync ${source} -> ${destination}: ${result.error.message}; diagnostics: ${diagnostics}`)
  }
  if (result.status !== 0) {
    fail(
      "rsync incomplete",
      `rsync ${source} -> ${destination} exited ${String(result.status)}; diagnostics: ${diagnostics}`,
    )
  }
  if (statSync(diagnostics).size > 0) console.error(`rsync ${label} diagnostics: ${diagnostics}`)
}

function main(options: Parsed): OwnedAppTransportProof {
  const userAndHost = options.transport.slice(4)

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
  const stage = options.stage ?? defaultStage(home)
  if (stage === home || home.startsWith(`${stage}/`)) {
    fail("invalid stage", `stage ${JSON.stringify(stage)} is the remote home or contains it`)
  }
  const source = `${stage}/source`
  const checkout = `${source}/${STAGED_FROM_BUNDLE}`
  if (!existsSync(options.knownHosts)) {
    fail("host key mismatch", `no environment-owned known-hosts file at ${options.knownHosts}; trust is never invented`)
  }

  // The local manifest is bound before a single byte is staged: source from git archive, resources
  // from the code tree that will actually be copied.
  const scratch = mkdtempSync(join(tmpdir(), "owned-app-transport-"))
  // Set once this run has CREATED the stage: from then on a failed run still honours
  // --remove-stage, except after a timeout, when the remote side may still be using it. A stage
  // that already existed (an earlier run's, marked by this driver) is reused but never removed:
  // --remove-stage once deleted an earlier run's retained outputs with it (33587 run 2).
  let owned = false
  let created = false
  // Named when the preflight proved the staged index unreadable and the stage was rebuilt from the
  // named revision. It travels into the receipt because a rebuild replaces whatever edits the stage
  // held, and a proof that omits it cannot say the projection was replaced.
  let stageRebuild: string | null = null
  try {
    // A light run's two trusts are read before any hashing: the stage's resource marker, which
    // names the lock its node_modules trees were installed from, and the local lock's own bytes.
    // Every refusal here sends the run down the full path; none of them shortens a check silently.
    const lockSha256 = sha256(readFileSync(join(CODE_ROOT, "bun.lock")))
    let light = false
    let trusted: ResourceMarker | undefined
    if (options.check === "light") {
      const held = stagePresence(options, stage)
        ? readLightStage(options, stage, checkout, lockSha256)
        : { ok: false as const, reason: "no stage exists yet" }
      if (held.ok) {
        light = true
        trusted = held.marker
      } else {
        console.error(`owned-app transport: light check declined (${held.reason}); restaging fully`)
      }
    }
    if (light && trusted === undefined) fail("invalid check", "a light run holds no stage marker to trust")
    const linkDirs = bundleLinkDirs()
    const declared = [...RESOURCE_DIRS, ...linkDirs, ...RESOURCE_FILES]
    // A light run hashes everything it stages EXCEPT the node_modules trees, which it trusts
    // through the marker: skipping those hashes is the whole saving. A full run hashes them too,
    // so a full digest still stands for every staged byte.
    const checked = light ? declared.filter((entry) => entry !== "node_modules") : declared
    const scan = manifestScan(CODE_ROOT, checked, "resource manifest mismatch")
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
      ...(light
        ? []
        : manifestScan(archiveOf(options, join(scratch, "archive")), [], "resource manifest mismatch").lines),
      ...scan.lines,
      ...closureLines,
    ]
    localLines.sort()
    const local = digestValue(localLines)
    if (local.files === 0) fail("resource manifest mismatch", "the declared resources produced no files")
    // A stage that already exists must be one this driver made; a stranger's directory is refused,
    // never adopted and never deleted.
    const ownership = sshRun(
      options,
      "stage ownership",
      "stage not owned",
      [
        `if [ -e ${shq(stage)} ]; then`,
        `  test "$(cat ${shq(`${stage}/${STAGE_MARKER}`)} 2>/dev/null)" = ${shq(STAGE_MARKER_VALUE)} || {`,
        `    echo ${shq(`stage ${stage} exists without this driver's marker; refusing to adopt or delete it`)} >&2`,
        `    exit 7`,
        `  }`,
        `  echo existed`,
        `else`,
        `  echo created`,
        `fi`,
        `mkdir -p ${shq(`${stage}/runs`)}`,
        `printf '%s\\n' ${shq(STAGE_MARKER_VALUE)} > ${shq(`${stage}/${STAGE_MARKER}`)}`,
      ].join("\n"),
    ).stdout.trim()
    created = ownership === "created"
    owned = created
    if (options.removeStage && !created) {
      console.error(`owned-app transport: ${stage} existed before this run; --remove-stage keeps it`)
    }

    // A light run leaves the staged source exactly as the earlier full run left it: the
    // revision and its tree were checked against git objects above, so nothing is moved.
    if (!light) {
      const bundle = createBundle(options, scratch)
      rsync(options, "bundle transfer", bundle, `${userAndHost}:${stage}/source.bundle`)
      // Source reaches the host as a bundle and is fetched by the exact ref the bundle records, so a
      // revision that is not the current HEAD still lands; git's own stderr is kept on failure.
      const rebuildMarker = `${stage}/${STAGE_REBUILD_MARKER}`
      // The marker names THIS run. An interrupted run (a killed ssh, a died fetch) leaves it behind,
      // and a later run that finds a readable-but-dirty index must refuse that dirt, not force it
      // clean on a decision a previous run made (@dev/3 R4).
      const rebuildToken = randomBytes(16).toString("hex")
      // Decide the index rebuild BEFORE the checkout, and only for a proven index fault: git that
      // cannot run at all (127), a refused config or dubious ownership (128) and a killed process all
      // fail here by name instead of deleting the index, because deleting it makes the next run read
      // a tree it cannot describe ("untracked working tree files would be overwritten") with no way
      // back. `ls-files -s` is the read that proves the index itself is what failed (@dev/15 R3).
      // The preflight answers one of `fresh`, `kept` or `rebuilt`, and it refuses by name anything
      // that is not an index fault. A rebuild is not free — the forcing checkout replaces the staged
      // projection, tracked edits included — so the answer is printed, kept, and carried into the
      // receipt rather than happening quietly (@dev/15 R3).
      const stagePreflight = sshRun(
        options,
        "stage index preflight",
        "stage git unusable",
        [
          `set -e`,
          `if [ ! -d ${shq(`${checkout}/.git`)} ]; then printf 'fresh\\n'; exit 0; fi`,
          `if git -C ${shq(checkout)} status --porcelain >/dev/null 2>&1; then printf 'kept\\n'; exit 0; fi`,
          `if ! git -C ${shq(checkout)} --version >/dev/null 2>&1 || ! git -C ${shq(checkout)} config --list >/dev/null 2>&1; then`,
          `  printf '%s\\n' "git cannot run in the staged checkout, so this is not an index fault:" >&2`,
          `  git -C ${shq(checkout)} status --porcelain 2>&1 | head -5 | sed 's/^/  /' >&2 || true`,
          `  exit 1`,
          `fi`,
          `if git -C ${shq(checkout)} ls-files -s >/dev/null 2>&1; then`,
          `  printf '%s\\n' "git status failed while the index reads, so this is not an index fault:" >&2`,
          `  git -C ${shq(checkout)} status --porcelain 2>&1 | head -5 | sed 's/^/  /' >&2 || true`,
          `  exit 1`,
          `fi`,
          `printf '%s\\n' ${shq(rebuildToken)} > ${shq(rebuildMarker)}`,
          `printf '%s\\n' "owned-app transport: the staged index is unreadable; the staged projection, including any tracked edits, is replaced from the named revision" >&2`,
          `printf 'rebuilt\\n'`,
        ].join("\n"),
      )
      // The rebuild's own words are on the host's stderr, which sshRun keeps rather than prints; a
      // rebuild the operator never sees is the silent fallback this revise exists to remove.
      if (stagePreflight.stdout.trim() === "rebuilt") {
        stageRebuild = "index unreadable"
        const note = stagePreflight.stderr.trim()
        if (note !== "") console.error(note)
      }
      const checkoutScript = [
        `set -e`,
        // `fetch` reads the index before `checkout` ever runs (it dies on a corrupt one), so a
        // proven-unreadable index is removed first. The preflight proved git runs and the index
        // alone is what fails, so nothing git could have read is discarded.
        `if [ "$(cat ${shq(rebuildMarker)} 2>/dev/null)" = ${shq(rebuildToken)} ]; then rm -f ${shq(`${checkout}/.git/index`)}; fi`,
        `mkdir -p ${shq(`${source}/vendor`)}`,
        `if [ ! -d ${shq(`${checkout}/.git`)} ]; then git init -q ${shq(checkout)}; fi`,
        `git -C ${shq(checkout)} fetch --force ${shq(`${stage}/source.bundle`)} 'HEAD:refs/owned-app/source'`,
        `git -C ${shq(checkout)} cat-file -e ${shq(`${options.sourceRevision}^{commit}`)}`,
        // The forcing checkout replaces the projection only when the preflight proved the index
        // unreadable; a readable index keeps its dirty state so the refusal below still fires.
        // The checkout writes a fresh index and, with -f, replaces any tracked edits it finds.
        `if [ "$(cat ${shq(rebuildMarker)} 2>/dev/null)" = ${shq(rebuildToken)} ]; then`,
        `  git -C ${shq(checkout)} checkout --detach -f ${shq(options.sourceRevision)}`,
        `else`,
        `  git -C ${shq(checkout)} checkout --detach ${shq(options.sourceRevision)}`,
        `fi`,
        `rm -f ${shq(rebuildMarker)}`,
        `test "$(git -C ${shq(checkout)} rev-parse HEAD)" = ${shq(options.sourceRevision)}`,
      ].join("\n")
      sshRun(options, "stage checkout", "stage source mismatch", checkoutScript)
      const dirty = sshRun(
        options,
        "clean-tree check",
        "stage dirty tree",
        `git -C ${shq(checkout)} status --porcelain`,
      ).stdout.trim()
      if (dirty) fail("stage dirty tree", `the staged checkout holds changes no source revision names:\n${dirty}`)
    }

    for (const [from, entry] of [
      ...RESOURCE_DIRS.map((entry) => [CODE_ROOT, entry] as const),
      ...linkDirs.map((entry) => [CODE_ROOT, entry] as const),
      ...extras.map((entry) => [closure, entry] as const),
    ]) {
      // The node_modules trees are what the marker already stands for; a light run never re-sends
      // them, which is the other half of the saving beside their hashes.
      if (light && entry === "node_modules") continue
      rsync(options, `resource transfer ${entry}`, `${from}/${entry}/`, `${userAndHost}:${source}/${entry}/`, [
        "--delete",
        ...[...RESOURCE_EXCLUDES].map((name) => "--exclude=" + name),
      ])
    }
    for (const entry of RESOURCE_FILES) {
      rsync(options, `resource transfer ${entry}`, `${CODE_ROOT}/${entry}`, `${userAndHost}:${source}/${entry}`)
    }

    const bun = sshRun(options, "bun lookup", "bun absent", "command -v bun").stdout.trim()
    if (!bun) fail("bun absent", `no bun on ${hostname}; the probe cannot start`)
    const bunVersion = sshRun(options, "bun --version", "receipt mismatch", `${shq(bun)} --version`).stdout.trim()
    // Execute trusted LOCAL checker bytes, never a module from the tree being witnessed.
    // Both sides use the same fs/path/crypto walk; no child process is spawned for a file or link.
    const checker = readFileSync(new URL("./owned-app-resource-manifest.ts", import.meta.url), "utf8")
    const invocation = `\nconsole.log(JSON.stringify(manifestScan(${JSON.stringify(source)}, ${JSON.stringify(light ? checked : [])}, "resource manifest mismatch").lines))`
    const witnessed = sshRun(
      options,
      "remote resource witness",
      "resource manifest mismatch",
      `${shq(bun)} --eval ${shq(checker + invocation)}`,
    ).stdout
    let remoteLines: unknown
    try {
      remoteLines = JSON.parse(witnessed)
    } catch {
      fail("resource manifest mismatch", `remote witness returned invalid JSON: ${JSON.stringify(witnessed)}`)
    }
    if (!Array.isArray(remoteLines) || !remoteLines.every((line): line is string => typeof line === "string")) {
      fail("resource manifest mismatch", "remote witness did not return canonical manifest lines")
    }
    const remote = { ...digestValue(remoteLines), lines: remoteLines }
    if (remote.sha256 !== local.sha256) {
      fail(
        "resource manifest mismatch",
        `local ${local.sha256} (${String(local.files)} files) != staged ${remote.sha256} (${String(remote.files)} files); ${firstDifference(localLines, remote.lines)}`,
      )
    }

    // Only a run that hashed the whole staged tree may write the marker a later light run trusts:
    // it names the lock its node_modules came from and the digest they hashed to.
    if (!light) {
      const marker: ResourceMarker = {
        version: RESOURCE_MARKER_VERSION,
        lockSha256,
        manifestSha256: local.sha256,
        files: local.files,
        sourceRevision: options.sourceRevision,
      }
      sshRun(
        options,
        "resource marker write",
        "resource manifest mismatch",
        `cat > ${shq(`${stage}/${RESOURCE_MARKER}`)}`,
        { input: `${JSON.stringify(marker, null, 2)}\n` },
      )
    }

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
      `cd ${shq(checkout)} && ${process.env.TERMINFO_CAPTURE_RUN_ID ? `TERMINFO_CAPTURE_RUN_ID=${shq(process.env.TERMINFO_CAPTURE_RUN_ID)} ` : ""}${shq(bun)} ${probeArgs.map(shq).join(" ")} --output ${shq(remoteOutput)}`,
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

    // The sampler is a tracked file of the staged checkout, and the os is named as its argument,
    // explicitly: an owned host is not a hosted runner, so no hosted-runner variable is set.
    const sampled = sshRun(
      options,
      "identity sample",
      "receipt mismatch",
      `cd ${shq(stage)} && ${shq(bun)} ${shq(`${checkout}/${IDENTITY_SCRIPT}`)} ${shq(OWNED_HOST_OS)}`,
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
      // A full run's digest is over every staged byte of THIS run. A light run cannot say that, so
      // it carries the marker's digest, named as such, and its own lighter digest beside it.
      check: light ? "light" : "full",
      resourceManifestSha256: light && trusted ? trusted.manifestSha256 : local.sha256,
      resourceFiles: light && trusted ? trusted.files : local.files,
      resourceManifestBasis: light ? "stage marker from an earlier full run" : "this run",
      ...(light ? { lightManifestSha256: local.sha256, lightResourceFiles: local.files } : {}),
      ...(stageRebuild === null ? {} : { stageRebuild }),
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

    if (options.removeStage && created) {
      owned = false
      removeStage(options, stage)
    }

    return {
      runner: options.transport,
      hostKeyFingerprint: key.fingerprint,
      resourceManifestSha256: local.sha256,
      resourceFiles: local.files,
      receiptSha256,
      remoteOutput,
      check: light ? "light" : "full",
      ...(stageRebuild === null ? {} : { stageRebuild }),
    }
  } catch (error) {
    if (options.removeStage && owned && !isTimeout(error)) {
      try {
        removeStage(options, stage)
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
