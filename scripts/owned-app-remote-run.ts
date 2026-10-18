#!/usr/bin/env bun
/**
 * 15323: transport-only driver for an owned-app measurement on an EXISTING remote macOS host.
 *
 * Transport changes WHERE a run starts, never what it may do (CTO C1): the identical owned-app argv
 * is executed on the host, under the host's own authority, from an exact-source checkout. This file
 * moves bytes and proves identity; it never parses or classifies a run, and it never decides what a
 * run may touch.
 *
 * Everything it needs is environment-owned configuration supplied by explicit arguments — the ssh
 * destination, the persistent stage directory, the known-hosts file. No host, account or key
 * material is product content; `--stage` names the only remote subtree this driver writes.
 *
 * Steps, each refusing by name:
 *   host unreachable | host key mismatch | bundle missing objects | stage source mismatch |
 *   stage dirty tree | resource manifest mismatch | broken staged symlink | bun absent |
 *   kitty absent | output collision | rsync incomplete | receipt mismatch
 *
 * The local resource manifest is computed BEFORE anything is staged and the remote recompute must
 * match it byte for byte; that compare is the proof, not the act of re-staging.
 */
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"

/** Production roots. The two environment names exist only so the transport's own tests can point
 * at an owned fixture tree; a real invocation leaves them unset and this file's position decides. */
const ROOT = process.env.OWNED_APP_TRANSPORT_SOURCE_ROOT ?? join(dirname(fileURLToPath(import.meta.url)), "..")
const CODE_ROOT = process.env.OWNED_APP_TRANSPORT_RESOURCE_ROOT ?? resolve(ROOT, "../..")

/** What a staged tree must contain beyond the checkout. Paths are relative to the CODE root; the
 * component subtree itself arrives from the bundle at STAGED_FROM_BUNDLE. */
const RESOURCES = [
  "node_modules",
  "vendor/silvery",
  "vendor/termless",
  "vendor/terminfo.dev",
  "package.json",
  "bun.lock",
  "tsconfig.json",
] as const
const STAGED_FROM_BUNDLE = "vendor/terminfo.dev"

export interface OwnedAppRemoteOptions {
  readonly transport: string
  readonly stage: string
  readonly output: string
  readonly sourceRevision: string
  readonly context: string
  readonly knownHosts: string
  readonly removeStage: boolean
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

function shq(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/** Canonical manifest over the declared resources: sorted `path<TAB>kind:value` lines. The same
 * canonical text is produced from the remote recompute, so equal digests mean equal bytes. */
function digestOf(root: string, entries: readonly string[], missing: string): { sha256: string; files: number } {
  const lines: string[] = []
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
      const resolved = resolve(dirname(path), target)
      if (!existsSync(resolved)) fail("broken staged symlink", `${relative} -> ${target} does not resolve`)
      if (resolved !== root && !resolved.startsWith(`${root}${sep}`)) {
        fail("resource manifest mismatch", `${relative} -> ${target} escapes the staged tree`)
      }
      lines.push(`${relative}\tsymlink:${target}`)
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
  for (const entry of entries) walk(join(root, entry))
  lines.sort()
  return { sha256: sha256(lines.join("\n")), files: lines.length }
}

/** Rebuild the same canonical text from the remote file/symlink listing. */
function canonicalRemote(files: readonly string[], links: readonly string[]): { sha256: string; files: number } {
  const lines = files.map((line) => {
    const match = /^([a-f0-9]{64})[ \t]+\*?\.?\/(.+)$/.exec(line.trim())
    const [, hash, path] = match ?? []
    if (hash === undefined || path === undefined) {
      fail("resource manifest mismatch", `remote listing line is not a sha256 file record: ${JSON.stringify(line)}`)
    }
    return `${path.replace(/\\/g, "/")}\tsha256:${hash}`
  })
  for (const line of links) {
    const tab = line.indexOf("\t")
    if (tab < 0) fail("resource manifest mismatch", `remote symlink line is malformed: ${JSON.stringify(line)}`)
    const relative = line.slice(0, tab).replace(/^\.\//, "")
    lines.push(`${relative}\tsymlink:${line.slice(tab + 1)}`)
  }
  lines.sort()
  return { sha256: sha256(lines.join("\n")), files: lines.length }
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
    if (!["--transport", "--stage", "--output", "--source-revision", "--context", "--known-hosts"].includes(arg)) {
      usage()
    }
    const value = argv[index + 1]
    if (value === undefined || value.startsWith("--")) usage()
    values[arg.slice(2)] = value
    index += 1
  }
  const rest = argv.slice(index)
  const transport = values.transport ?? usage()
  const stage = values.stage ?? usage()
  const output = values.output ?? usage()
  const sourceRevision = values["source-revision"] ?? usage()
  const context = values.context ?? usage()
  const knownHosts = values["known-hosts"] ?? usage()
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
  if (!stage.startsWith("/")) fail("stage source mismatch", `stage ${JSON.stringify(stage)} must be an absolute path`)
  return {
    transport,
    stage,
    output: resolve(output),
    sourceRevision,
    context,
    knownHosts: resolve(knownHosts),
    removeStage,
    argv: rest,
  }
}

function usage(): never {
  console.error(
    "Usage: bun scripts/owned-app-remote-run.ts --transport ssh:<user>@<host> --stage <remote-dir>\n" +
      "         --output <local-output-dir> --source-revision <sha> --context <id>\n" +
      "         [--known-hosts <path>] [--remove-stage] -- <owned-app argv...>",
  )
  process.exit(2)
}

/** ssh with pinned host trust. The known-hosts file is environment-owned input, named explicitly;
 * nothing here writes to it and none of it is product content. */
function sshPrefix(options: Parsed): string[] {
  return ["-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", `UserKnownHostsFile=${options.knownHosts}`]
}

function sshRun(options: Parsed, label: string, failure: string, command: string, input?: string): string {
  const result = spawnSync("ssh", [...sshPrefix(options), options.transport.slice(4), command], {
    encoding: "utf8",
    input,
    maxBuffer: 64 * 1024 * 1024,
  })
  if (result.error) fail("host unreachable", `${label}: ${result.error.message}`)
  if (result.status !== 0) {
    const detail = `${result.stderr}${result.stdout}`.trim()
    fail(failure, `${label} exited ${String(result.status)}: ${detail}`)
  }
  return result.stdout
}

function hostKeyFingerprint(options: Parsed): string {
  const host = options.transport.slice(4).split("@")[1]
  if (!host) fail("host key mismatch", `transport ${JSON.stringify(options.transport)} carries no host`)
  if (!existsSync(options.knownHosts)) {
    fail("host key mismatch", `no environment-owned known-hosts file at ${options.knownHosts}; trust is never invented`)
  }
  const match = spawnSync("ssh-keygen", ["-F", host, "-f", options.knownHosts], { encoding: "utf8" })
  if (match.error) fail("host key mismatch", `ssh-keygen -F failed: ${match.error.message}`)
  const line = match.stdout.trim()
  if (match.status !== 0 || !line) {
    fail("host key mismatch", `${host} has no entry in ${options.knownHosts}; the host key is not trusted here`)
  }
  const scratch = mkdtempSync(join(tmpdir(), "owned-app-hoc-"))
  try {
    const file = join(scratch, "known_hosts")
    writeFileSync(file, `${line}\n`)
    const read = spawnSync("ssh-keygen", ["-lf", file], { encoding: "utf8" })
    if (read.error || read.status !== 0) {
      fail("host key mismatch", `ssh-keygen -lf refused ${host}: ${read.error?.message ?? read.stderr.trim()}`)
    }
    const fingerprint = /^\d+\s+(SHA256:\S+)/.exec(read.stdout.trim())?.[1]
    if (!fingerprint) fail("host key mismatch", `ssh-keygen -lf returned no SHA256 fingerprint: ${read.stdout.trim()}`)
    return fingerprint
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
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

function rsync(source: string, destination: string, extra: readonly string[] = []): void {
  const result = spawnSync("rsync", ["-a", ...extra, source, destination], { encoding: "utf8" })
  if (result.error) fail("rsync incomplete", `rsync ${source} -> ${destination}: ${result.error.message}`)
  if (result.status !== 0) {
    fail(
      "rsync incomplete",
      `rsync ${source} -> ${destination} exited ${String(result.status)}: ${result.stderr.trim()}`,
    )
  }
}

function main(options: Parsed): OwnedAppTransportProof {
  const userAndHost = options.transport.slice(4)
  const stage = options.stage.replace(/\/+$/, "")
  const source = `${stage}/source`
  const [hostname] = sshRun(options, "reachability probe", "host unreachable", "hostname").trim().split("\n")
  if (!hostname) fail("host unreachable", `${userAndHost} answered no hostname`)
  const fingerprint = hostKeyFingerprint(options)

  // The local manifest is bound before a single byte is staged.
  const local = digestOf(CODE_ROOT, RESOURCES, "resource manifest mismatch")
  if (local.files === 0) fail("resource manifest mismatch", "the declared resources produced no files")

  const scratch = mkdtempSync(join(tmpdir(), "owned-app-transport-"))
  try {
    const bundle = createBundle(options, scratch)
    sshRun(
      options,
      "stage directory",
      "stage source mismatch",
      `mkdir -p ${shq(stage)} && mkdir -p ${shq(`${stage}/runs`)}`,
    )
    rsync(bundle, `${userAndHost}:${stage}/source.bundle`)
    sshRun(
      options,
      "stage checkout",
      "stage source mismatch",
      [
        `set -e`,
        `if [ -d ${shq(`${source}/${STAGED_FROM_BUNDLE}/.git`)} ]; then`,
        `  git -C ${shq(`${source}/${STAGED_FROM_BUNDLE}`)} fetch --force ${shq(`${stage}/source.bundle`)} '+refs/*:refs/*' >/dev/null 2>&1`,
        `else`,
        `  mkdir -p ${shq(source)}`,
        `  git clone --no-checkout ${shq(`${stage}/source.bundle`)} ${shq(`${source}/${STAGED_FROM_BUNDLE}`)} >/dev/null 2>&1`,
        `fi`,
        `git -C ${shq(`${source}/${STAGED_FROM_BUNDLE}`)} checkout --detach ${shq(options.sourceRevision)} >/dev/null 2>&1`,
        `test "$(git -C ${shq(`${source}/${STAGED_FROM_BUNDLE}`)} rev-parse HEAD)" = ${shq(options.sourceRevision)}`,
      ].join("\n"),
    )
    const dirty = sshRun(
      options,
      "clean-tree check",
      "stage dirty tree",
      `git -C ${shq(`${source}/${STAGED_FROM_BUNDLE}`)} status --porcelain`,
    ).trim()
    if (dirty) fail("stage dirty tree", `the staged checkout holds changes no source revision names:\n${dirty}`)

    for (const entry of RESOURCES.filter((name) => name !== STAGED_FROM_BUNDLE)) {
      rsync(`${CODE_ROOT}/${entry}`, `${userAndHost}:${source}/${entry}`, ["--delete", "--exclude=.git/"])
    }

    const files = sshRun(
      options,
      "remote file listing",
      "resource manifest mismatch",
      `cd ${shq(source)} && find . \\( -name .git -prune \\) -o -type f -print0 | LC_ALL=C sort -z | xargs -0 shasum -a 256`,
    )
    const links = sshRun(
      options,
      "remote symlink listing",
      "broken staged symlink",
      `cd ${shq(source)} && find . \\( -name .git -prune \\) -o -type l -exec sh -c 'printf "%s\\t%s\\n" "$1" "$(readlink "$1")"' _ {} \\;`,
    )
    const remote = canonicalRemote(files.trim().split("\n").filter(Boolean), links.trim().split("\n").filter(Boolean))
    if (remote.sha256 !== local.sha256) {
      fail(
        "resource manifest mismatch",
        `local ${local.sha256} (${String(local.files)} files) != staged ${remote.sha256} (${String(remote.files)} files)`,
      )
    }

    const bun = sshRun(options, "bun lookup", "bun absent", "command -v bun").trim()
    if (!bun) fail("bun absent", `no bun on ${hostname}; the probe cannot start`)
    const kitty = sshRun(options, "kitty lookup", "kitty absent", "command -v kitty || true").trim()
    if (!kitty) fail("kitty absent", `no kitty executable on ${hostname}; the owned-app probe cannot launch it`)

    const remoteOutput = `${stage}/runs/${options.sourceRevision.slice(0, 12)}-${options.context}`
    sshRun(options, "remote output directory", "output collision", `mkdir -m 700 ${shq(remoteOutput)}`)

    const localOutput = join(options.output, "transport")
    if (existsSync(localOutput)) fail("output collision", `${localOutput} already holds a transport run`)
    mkdirSync(localOutput, { recursive: true, mode: 0o700 })

    const probe = spawnSync(
      "ssh",
      [
        ...sshPrefix(options),
        userAndHost,
        `cd ${shq(`${source}/${STAGED_FROM_BUNDLE}`)} && ${shq(bun)} ${options.argv.map(shq).join(" ")} --output ${shq(remoteOutput)}`,
      ],
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    )
    const probeDetail = `${probe.stdout}${probe.stderr}`
    if (probe.error || probe.status !== 0) {
      const failure =
        /ENOENT|not found/i.test(probeDetail) && /kitty/i.test(probeDetail) ? "kitty absent" : "owned-app probe failed"
      fail(failure, `the owned-app probe on ${hostname} exited ${String(probe.status)}: ${probeDetail.trim()}`)
    }
    writeFileSync(join(localOutput, "launcher.stdout.log"), probe.stdout)
    writeFileSync(join(localOutput, "launcher.stderr.log"), probe.stderr)

    const outputs = sshRun(
      options,
      "output listing",
      "rsync incomplete",
      `cd ${shq(remoteOutput)} && find . -maxdepth 1 -type f -print0 | LC_ALL=C sort -z | xargs -0 shasum -a 256`,
    )
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
    if (outputs.length !== 1 || !outputs[0]) {
      fail(
        "receipt mismatch",
        `the remote probe produced ${String(outputs.length)} output files; expected exactly one run JSON`,
      )
    }

    const productVersion = sshRun(options, "sw_vers", "receipt mismatch", "sw_vers -productVersion").trim()
    const buildVersion = sshRun(options, "sw_vers -buildVersion", "receipt mismatch", "sw_vers -buildVersion").trim()
    const bunVersion = sshRun(options, "bun --version", "receipt mismatch", `${shq(bun)} --version`).trim()
    const kittyVersion = sshRun(
      options,
      "kitty --version",
      "receipt mismatch",
      `${shq(kitty)} --version 2>/dev/null || true`,
    ).trim()
    const receipt = {
      schemaVersion: 1,
      kind: "owned-app-transport",
      grants: "nothing",
      transport: options.transport,
      identity: { hostname, productVersion, buildVersion },
      runtime: { bun: { path: bun, version: bunVersion }, kitty: { path: kitty, version: kittyVersion } },
      sourceRevision: options.sourceRevision,
      resourceManifestSha256: local.sha256,
      resourceFiles: local.files,
      hostKeyFingerprint: fingerprint,
      output: { directory: remoteOutput, files: outputs },
    }
    const bytes = `${JSON.stringify(receipt, null, 2)}\n`
    sshRun(
      options,
      "receipt write",
      "receipt mismatch",
      `cat > ${shq(`${remoteOutput}/transport-receipt.json`)}`,
      bytes,
    )

    rsync(`${userAndHost}:${remoteOutput}/`, `${localOutput}/`)
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
      sshRun(options, "stage removal", "stage source mismatch", `find ${shq(stage)} -depth -delete`)
    }

    return {
      runner: options.transport,
      hostKeyFingerprint: fingerprint,
      resourceManifestSha256: local.sha256,
      resourceFiles: local.files,
      receiptSha256,
      remoteOutput,
    }
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
