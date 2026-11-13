/**
 * @failure An owned-app run started on a remote host is credited without proving exact source, the
 *   resource bytes it ran against, the host it ran on, or that the bytes returned are the bytes the
 *   host measured — or the transport silently accepts a stage it cannot vouch for, drops its ssh
 *   pinning on a transfer, or hands the host an argv the collector never composed.
 * @level l1 — runs the real driver against owned temporary trees and PATH shims for ssh/rsync.
 * @consumer scripts/owned-app-remote-run.ts and the local-owned-app branch of release1-collection.
 * @reach fs-walk <fixture-only: one owned temporary fixture tree per test>
 * @reach fs-walk vendor/terminfo.dev/scripts/**
 * @testonly none
 * @source-grep artifact equality, not source semantics: the fixture stages the identity script
 *   (scripts/owned-host-identity.ts) as the remote's own file, and the test compares the emitted
 *   sampler with those source bytes so a transport that rewrites or drops the payload cannot pass;
 *   the other reads are transport receipts hashed against their recorded sha256.
 */
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

const driver = fileURLToPath(new URL("./owned-app-remote-run.ts", import.meta.url))
const identityScript = fileURLToPath(new URL("./owned-host-identity.ts", import.meta.url))

let root: string
let code: string
let source: string
let shims: string
let stage: string
let output: string
let knownHosts: string
let sshLog: string
let rsyncLog: string
let revision: string

function executable(path: string, body: string): void {
  writeFileSync(path, body, { mode: 0o755 })
  chmodSync(path, 0o755)
}

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" })
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`)
  return result.stdout.trim()
}

function nestedBinFixture(missingCommit = false): { nested: string; pinned: string } {
  const parent = join(code, "km")
  const nested = join(parent, "apps", "maddoc")
  const payload = join(nested, "payload")
  for (const repository of [parent, nested, payload]) {
    mkdirSync(repository, { recursive: true })
    git(repository, "init", "-q", "-b", "main")
    git(repository, "config", "user.email", "fixture@example.invalid")
    git(repository, "config", "user.name", "fixture")
  }
  writeFileSync(join(payload, "maddoc.ts"), "export const bin = 'pinned'\n")
  git(payload, "add", "maddoc.ts")
  git(payload, "commit", "-q", "-m", "pinned bin")
  git(nested, "update-index", "--add", "--cacheinfo", `160000,${git(payload, "rev-parse", "HEAD")},payload`)
  mkdirSync(join(nested, "bin"))
  symlinkSync(join("..", "payload", "maddoc.ts"), join(nested, "bin", "maddoc.ts"))
  git(nested, "add", "bin")
  git(nested, "commit", "-q", "-m", "nested app")
  const pinned = missingCommit ? "1234567890123456789012345678901234567890" : git(nested, "rev-parse", "HEAD")
  git(parent, "update-index", "--add", "--cacheinfo", `160000,${pinned},apps/maddoc`)
  git(parent, "commit", "-q", "-m", "parent records app")
  git(code, "update-index", "--add", "--cacheinfo", `160000,${git(parent, "rev-parse", "HEAD")},km`)
  git(code, "commit", "-q", "-m", "root records parent")
  writeFileSync(join(payload, "maddoc.ts"), "export const bin = 'new HEAD'\n")
  git(payload, "add", "maddoc.ts")
  git(payload, "commit", "-q", "-m", "advance checkout past pin")
  writeFileSync(join(payload, "maddoc.ts"), "export const bin = 'dirty'\n")
  writeFileSync(join(payload, "untracked.ts"), "untracked\n")
  symlinkSync(join("..", "km", "apps", "maddoc"), join(code, "node_modules", "maddoc"))
  mkdirSync(join(code, "node_modules", ".bin"), { recursive: true })
  symlinkSync(join("..", "maddoc", "bin", "maddoc.ts"), join(code, "node_modules", ".bin", "maddoc"))
  return { nested, pinned }
}

function fixture(): void {
  root = mkdtempSync(join(tmpdir(), "owned-app-transport-"))
  code = join(root, "code")
  source = join(code, "vendor", "terminfo.dev")
  shims = join(root, "shims")
  stage = join(root, "remote", "stage")
  output = join(root, "out")
  knownHosts = join(root, "known_hosts")
  sshLog = join(root, "ssh.log")
  rsyncLog = join(root, "rsync.log")
  mkdirSync(source, { recursive: true })
  mkdirSync(shims, { recursive: true })
  mkdirSync(output, { recursive: true })

  writeFileSync(
    join(source, "package.json"),
    JSON.stringify({ name: "terminfo.dev", private: true, type: "module" }, null, 2),
  )
  mkdirSync(join(source, "packages", "admin", "src"), { recursive: true })
  writeFileSync(join(source, "packages", "admin", "src", "index.ts"), "export const probe = 'fixture'\n")
  mkdirSync(join(source, "packages", "run-parser"), { recursive: true })
  writeFileSync(join(source, "packages", "run-parser", "index.ts"), "export const parser = 'fixture'\n")
  mkdirSync(join(source, "packages", "terminfo.dev", "src"), { recursive: true })
  writeFileSync(
    join(source, "packages", "terminfo.dev", "src", "disposable-receipt.ts"),
    "export function sampleOwnedHostIdentity(os: string): Record<string, string> {\n" +
      "  return { os, machineIdSha256: 'aaaa', productUuidSha256: 'bbbb', bootIdSha256: 'cccc' }\n}\n",
  )
  // The real tracked sampler, so the stand-in host runs the very file the driver names.
  mkdirSync(join(source, "scripts"), { recursive: true })
  writeFileSync(join(source, "scripts", "owned-host-identity.ts"), readFileSync(identityScript))
  git(source, "init", "-q", "-b", "main")
  git(source, "config", "user.email", "fixture@example.invalid")
  git(source, "config", "user.name", "fixture")
  git(source, "add", "-A")
  git(source, "commit", "-q", "-m", "fixture source")
  revision = git(source, "rev-parse", "HEAD")

  for (const entry of ["package.json", "bun.lock", "tsconfig.json"]) {
    writeFileSync(join(code, entry), `fixture ${entry}\n`)
  }
  mkdirSync(join(code, "vendor", "silvery"), { recursive: true })
  writeFileSync(join(code, "vendor", "silvery", "index.ts"), "export const silvery = 'fixture'\n")
  mkdirSync(join(code, "vendor", "termless"), { recursive: true })
  writeFileSync(join(code, "vendor", "termless", "index.ts"), "export const termless = 'fixture'\n")
  mkdirSync(join(code, "node_modules", "@terminfo"), { recursive: true })
  symlinkSync(
    join("..", "..", "vendor", "terminfo.dev", "packages", "run-parser"),
    join(code, "node_modules", "@terminfo", "run-parser"),
  )
  // A second link reaches a directory that is NOT declared as a resource: it exists locally and the
  // transport must stage its target or the host holds a link it cannot resolve.
  mkdirSync(join(code, "extra", "pkg"), { recursive: true })
  writeFileSync(join(code, "extra", "pkg", "index.ts"), "export const extra = 'fixture'\n")
  symlinkSync(join("..", "..", "extra", "pkg"), join(code, "node_modules", "@terminfo", "extra"))
  // The code tree is a repository too: a closure root ships only what its HEAD tracks.
  git(code, "init", "-q", "-b", "main")
  git(code, "config", "user.email", "fixture@example.invalid")
  git(code, "config", "user.name", "fixture")
  git(code, "add", "extra")
  git(code, "commit", "-q", "-m", "fixture code")

  writeFileSync(knownHosts, "fixture.invalid ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGZpeHR1cmVrZXk=\n")

  // The ssh shim records the argv the driver actually spawned, drops the options it cannot honour
  // in-process, and reports the key it "negotiated" on its verbose rail.
  executable(
    join(shims, "ssh"),
    [
      "#!/bin/sh",
      "{ printf 'SSH'; for a in \"$@\"; do printf '\\t%s' \"$(printf '%s' \"$a\" | tr '\\n' ' ')\"; done; printf '\\n'; } >> \"${SHIM_SSH_LOG:-/dev/null}\"",
      "if [ \"${SHIM_SSH_UNTRUSTED:-}\" = 1 ]; then echo 'Host key verification failed.' >&2; exit 255; fi",
      "verbose=0",
      'for a in "$@"; do [ "$a" = "-v" ] && verbose=1; done',
      'while [ "$1" = "-o" ] || [ "$1" = "-F" ] || [ "$1" = "-l" ]; do shift 2; done',
      'while [ "$1" = "-v" ]; do shift; done',
      '[ "$1" = "--" ] && shift',
      "shift",
      '[ -n "${SHIM_SSH_SLEEP:-}" ] && sleep "$SHIM_SSH_SLEEP"',
      'command="$*"',
      'if [ -n "${SHIM_SSH_SLEEP_ON:-}" ]; then case "$command" in *"$SHIM_SSH_SLEEP_ON"*) sleep 5 ;; esac; fi',
      'if [ "${SHIM_STAGE_CHECKOUT_FAIL:-}" = 1 ]; then',
      '  case "$command" in *"checkout --detach"*) echo "fatal: reference is not a tree: deadbeef" >&2; exit 128 ;; esac',
      "fi",
      '[ "$verbose" = 1 ] && [ "${SHIM_SSH_TWO_KEYS:-}" = 1 ] && echo \'debug1: Server host key: ssh-ed25519 SHA256:fixtureJumpHost\' >&2',
      "[ \"$verbose\" = 1 ] && echo 'debug1: Server host key: ssh-ed25519 SHA256:fixtureNegotiated' >&2",
      'HOME="${SHIM_SSH_HOME:-$HOME}" exec /bin/sh -c "$command"',
    ].join("\n"),
  )
  executable(
    join(shims, "rsync"),
    [
      "#!/bin/sh",
      'REAL_RSYNC="${REAL_RSYNC:-/usr/bin/rsync}"',
      'if [ "$1" = "--server" ]; then exec "$REAL_RSYNC" "$@"; fi',
      "{ printf 'RSYNC'; for a in \"$@\"; do printf '\\t%s' \"$a\"; done; printf '\\n'; } >> \"${SHIM_RSYNC_LOG:-/dev/null}\"",
      "set -e",
      'prev=""',
      'src=""',
      'dest=""',
      'for a in "$@"; do',
      '  if [ "$prev" = "-e" ]; then prev=""; continue; fi',
      '  case "$a" in',
      "    -a|--delete|-v|--) ;;",
      '    -e) prev="-e" ;;',
      "    --exclude=*) ;;",
      "    -*) ;;",
      '    *) src="$dest"; dest="$a" ;;',
      "  esac",
      "done",
      'case "$src" in *:*) src="${src#*:}" ;; esac',
      'case "$dest" in *:*) dest="${dest#*:}" ;; esac',
      '[ -n "${SHIM_RSYNC_SLEEP:-}" ] && sleep "$SHIM_RSYNC_SLEEP"',
      'if [ "${SHIM_RSYNC_SKIP_BACK:-}" = 1 ]; then case "$src" in *remote/*) exit 0 ;; esac; fi',
      'if [ "${SHIM_RSYNC_SKIP_EXTRA:-}" = 1 ]; then case "$src" in */extra/) exit 0 ;; esac; fi',
      '"$REAL_RSYNC" "$@"',
      'if [ "${SHIM_RSYNC_TAMPER:-}" = 1 ]; then case "$dest" in */source/package.json) printf \'tampered\' >> "$dest" ;; esac; fi',
      'if [ "${SHIM_RSYNC_TAMPER_RECEIPT:-}" = 1 ]; then case "$dest" in */transport/) printf \' \' >> "$dest/transport-receipt.json" ;; esac; fi',
      'if [ "${SHIM_RSYNC_TAMPER_NESTED:-}" = 1 ]; then case "$dest" in */transport/) printf \'tampered\' >> "$dest/nested/extra.log" ;; esac; fi',
      'if [ "${SHIM_RSYNC_TAMPER_ROOT_LINK:-}" = 1 ]; then case "$dest" in */source/node_modules/) ln -sfn ../.. "$dest/@terminfo/run-parser" ;; esac; fi',
    ].join("\n"),
  )
  executable(
    join(shims, "bun"),
    [
      "#!/bin/sh",
      'if [ "$1" = "--version" ] || [ "$1" = "--eval" ]; then exec "$REAL_BUN" "$@"; fi',
      'case "$*" in',
      '  *owned-host-identity.ts*) exec "$REAL_BUN" "$@" ;;',
      "  *) out=''",
      '     while [ $# -gt 0 ]; do case "$1" in --output) shift; out="$1" ;; esac; shift; done',
      '     mkdir -p "$out/nested"',
      '     [ "${SHIM_PROBE_CLOBBER_MARKER:-}" = 1 ] && printf \'not ours\\n\' > "$out/../../.owned-app-transport-stage"',
      '     if [ "${SHIM_PROBE_LOCK:-}" = 1 ]; then mkdir -p "$out/../locked"; printf \'cannot be unlinked\\n\' > "$out/../locked/held.txt"; chmod 555 "$out/../locked"; fi',
      '     printf \'{\"target\":{\"id\":\"kitty\"}}\\n\' > "$out/kitty-1.0-macos-run1.json"',
      "     printf 'fixture nested output\\n' > \"$out/nested/extra.log\"",
      "     echo 'fixture probe stdout' ;;",
      "esac",
    ].join("\n"),
  )
  // The kitty the producer launches lives at a fixed path, off PATH; a decoy on PATH proves the
  // receipt records the launched one, not whichever kitty a lookup finds first.
  mkdirSync(join(root, "app"), { recursive: true })
  executable(join(root, "app", "kitty"), "#!/bin/sh\necho 'kitty 0.49.1'\n")
  executable(join(shims, "kitty"), "#!/bin/sh\necho 'kitty 0.0.0-decoy'\n")
}

function run(
  extraEnv: Record<string, string> = {},
  extraArgs: string[] = [],
  argv: string[] = ["bun", "packages/admin/src/index.ts", "probe", "app", "kitty"],
  context = "kitty",
  stageArgument: string | null = stage,
) {
  const env = {
    ...process.env,
    PATH: `${shims}:/usr/bin:/bin`,
    OWNED_APP_TRANSPORT_SOURCE_ROOT: source,
    OWNED_APP_TRANSPORT_RESOURCE_ROOT: code,
    OWNED_APP_TRANSPORT_KITTY_PATH: join(root, "app", "kitty"),
    SHIM_SSH_LOG: sshLog,
    SHIM_RSYNC_LOG: rsyncLog,
    REAL_RSYNC: "/usr/bin/rsync",
    REAL_BUN: process.execPath,
    ...extraEnv,
  }
  rmSync(join(output, "transport"), { recursive: true, force: true })
  const result = spawnSync(
    process.execPath,
    [
      driver,
      "--transport",
      "ssh:fixture@fixture.invalid",
      ...(stageArgument === null ? [] : ["--stage", stageArgument]),
      "--output",
      output,
      "--source-revision",
      revision,
      "--context",
      context,
      "--known-hosts",
      knownHosts,
      ...extraArgs,
      "--",
      ...argv,
    ],
    { encoding: "utf8", env },
  )
  return result
}

/** The pinned ssh options, in order, exactly as every ssh spawn and rsync -e must carry them. */
function pinned(hosts: string): string[] {
  return [
    "-F",
    "/dev/null",
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    `UserKnownHostsFile=${hosts}`,
    "-o",
    "GlobalKnownHostsFile=/dev/null",
    "-o",
    "ConnectTimeout=15",
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=4",
  ]
}

function proof(result: ReturnType<typeof run>) {
  const line = result.stdout.trim().split("\n").at(-1) ?? ""
  return JSON.parse(line) as Record<string, unknown>
}

function lines(path: string): string[] {
  return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean) : []
}

beforeEach(() => {
  fixture()
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe("owned-app ssh transport", () => {
  // Real staging and receipt subprocesses exceeded the 5 s default under fleet load (7.04 s).
  it("stages portable resource modes without source-host privilege bits", () => {
    const resources = join(code, "node_modules", "portable-modes")
    mkdirSync(resources)
    writeFileSync(join(resources, "executable"), "#!/bin/sh\nprintf 'resource bytes\\n'\n")
    writeFileSync(join(resources, "data"), "unchanged data\n")
    symlinkSync("executable", join(resources, "link"))
    chmodSync(resources, 0o2755)
    chmodSync(join(resources, "executable"), 0o6755)
    chmodSync(join(resources, "data"), 0o644)

    const result = run()
    expect(result.status, result.stderr).toBe(0)
    const staged = join(stage, "source", "node_modules", "portable-modes")
    expect(statSync(staged).mode & 0o7777).toBe(0o755)
    expect(statSync(join(staged, "executable")).mode & 0o7777).toBe(0o755)
    expect(statSync(join(staged, "data")).mode & 0o7777).toBe(0o644)
    expect(readFileSync(join(staged, "executable"))).toEqual(readFileSync(join(resources, "executable")))
    expect(readFileSync(join(staged, "data"))).toEqual(readFileSync(join(resources, "data")))
    expect(readlinkSync(join(staged, "link"))).toBe("executable")
    expect(readFileSync(join(staged, "link"))).toEqual(readFileSync(join(resources, "executable")))
    expect(statSync(resources).mode & 0o7777).toBe(0o2755)
    expect(statSync(join(resources, "executable")).mode & 0o7777).toBe(0o6755)
  }, 10_000)

  it("stages exact source, runs the identical argv on the host, and proves the returned bytes", () => {
    const result = run()
    expect(result.stderr).toBe("")
    expect(result.status, result.stderr).toBe(0)
    const recorded = proof(result)
    expect(recorded).toMatchObject({
      runner: "ssh:fixture@fixture.invalid",
      hostKeyFingerprint: "SHA256:fixtureNegotiated",
    })
    expect(recorded.resourceManifestSha256).toMatch(/^[a-f0-9]{64}$/)

    const transport = join(output, "transport")
    const receipt = JSON.parse(readFileSync(join(transport, "transport-receipt.json"), "utf8")) as {
      kind: string
      grants: string
      sourceRevision: string
      identity: Record<string, string>
      hostKey: { algorithm: string; fingerprint: string }
      host: { hostname: string }
      output: { files: Array<{ path: string; sha256: string }> }
      hostKeyFingerprint: string
    }
    expect(receipt.kind).toBe("owned-app-transport")
    expect(receipt.grants).toBe("nothing")
    expect(receipt.sourceRevision).toBe(revision)
    expect(receipt.hostKey).toEqual({ algorithm: "ssh-ed25519", fingerprint: "SHA256:fixtureNegotiated" })
    expect(receipt.identity).toMatchObject({ machineIdSha256: "aaaa", productUuidSha256: "bbbb" })
    expect(receipt.host.hostname).not.toBe("")
    expect(readFileSync(join(transport, "launcher.stdout.log"), "utf8")).toContain("fixture probe stdout")
    expect(git(join(stage, "source", "vendor", "terminfo.dev"), "rev-parse", "HEAD")).toBe(revision)
    expect(existsSync(stage)).toBe(true)

    // The probe reaches the host as ONE bun: the runtime token is replaced, never prefixed twice.
    const sshSpawns = lines(sshLog)
    const probeSpawn = sshSpawns.find((spawn) => spawn.includes("packages/admin/src/index.ts"))
    expect(probeSpawn).toBeDefined()
    expect(probeSpawn).not.toMatch(/'bun'/)
    expect(probeSpawn).toContain(join(shims, "bun"))

    // The producer's own filename contract is carried: the driver never renames or demands a name.
    expect(receipt.output.files.map((file) => file.path)).toContain("kitty-1.0-macos-run1.json")
    // Every returned file is hashed, not just the ones at depth 1.
    expect(receipt.output.files).toHaveLength(2)
    for (const file of receipt.output.files) {
      const bytes = readFileSync(join(transport, file.path))
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(file.sha256)
    }
  }, 60_000)

  it.each([false, true])(
    "retains large rsync diagnostics without a pipe-buffer abort (failure=%s)",
    (failure) => {
      // Real child output must exceed spawnSync's pipe cap; small shim errors miss the staging bug.
      const shim = join(shims, "rsync")
      const emit = `"$REAL_BUN" -e 'process.stdout.write("large-output-start\\n" + "o".repeat(1200000) + "\\nlarge-output-end\\n"); process.stderr.write("large-error-start\\n" + "e".repeat(1200000) + "\\nlarge-error-end\\n")'`
      writeFileSync(
        shim,
        readFileSync(shim, "utf8").replace(
          '\n"$REAL_RSYNC" "$@"\n',
          `\n${emit}\n${failure ? "exit 23" : '"$REAL_RSYNC" "$@"'}\n`,
        ),
      )
      const result = run()
      if (failure) {
        expect(result.status).not.toBe(0)
        expect(result.stderr).toContain("rsync incomplete")
        expect(result.stderr).toContain("exited 23")
        const path = /diagnostics: ([^\n]+)/.exec(result.stderr)?.[1]
        expect(path, result.stderr).toBeTruthy()
        const diagnostics = readFileSync(path!, "utf8")
        expect(diagnostics).toContain("large-output-start\n" + "o".repeat(1200000) + "\nlarge-output-end\n")
        expect(diagnostics).toContain("large-error-start\n" + "e".repeat(1200000) + "\nlarge-error-end\n")
      } else {
        expect(result.status, result.stderr).toBe(0)
        expect(existsSync(join(output, "transport", "transport-receipt.json"))).toBe(true)
      }
      expect(result.stderr).not.toContain("ENOBUFS")
    },
    60_000,
  )

  it("pins every ssh spawn and every rsync -e to the same options, with -F /dev/null first", () => {
    expect(run().status).toBe(0)
    // An exact prefix, not presence: ssh keeps the FIRST value it reads, so an option placed ahead
    // of the pins would win, and -F /dev/null keeps the user's ssh_config out of both. rsync's own
    // ssh spawns name the host with -l; the driver's name it after --.
    const sshSpawns = lines(sshLog)
    expect(sshSpawns.length).toBeGreaterThan(3)
    const prefix = ["SSH", ...pinned(knownHosts)].join("\t")
    for (const spawn of sshSpawns) {
      expect(spawn.startsWith(`${prefix}\t`), spawn).toBe(true)
      expect(spawn.slice(prefix.length), spawn).toMatch(
        /^\t((-v\t)?--\tfixture@fixture\.invalid|-l\tfixture\tfixture\.invalid)\t/,
      )
    }
    const transfers = lines(rsyncLog)
    expect(transfers.length).toBeGreaterThan(1)
    const shell = ["ssh", ...pinned(knownHosts)].map((token) => `'${token}'`).join(" ")
    for (const transfer of transfers) {
      const fields = transfer.split("\t")
      expect(fields.slice(0, 4), transfer).toEqual(["RSYNC", "-a", "-e", shell])
      expect(fields.at(-3), transfer).toBe("--")
    }
  }, 60_000)

  it("tells the identity sampler the os explicitly, inventing no hosted-runner variable", () => {
    const result = run()
    expect(result.status, result.stderr).toBe(0)
    const sampler = join(stage, "source", "vendor", "terminfo.dev", "scripts", "owned-host-identity.ts")
    // The staged checkout carries the tracked sampler, and nothing writes a sampler on the host.
    expect(readFileSync(sampler, "utf8")).toBe(readFileSync(identityScript, "utf8"))
    expect(lines(sshLog).some((spawn) => spawn.includes("cat >") && spawn.includes("identity"))).toBe(false)
    const sampleSpawn = lines(sshLog).find((spawn) => spawn.includes("owned-host-identity.ts"))
    expect(sampleSpawn).toContain(`'${sampler}' 'macOS'`)
    expect(sampleSpawn).not.toContain("RUNNER_OS")
    const receipt = JSON.parse(readFileSync(join(output, "transport", "transport-receipt.json"), "utf8")) as {
      identity: Record<string, string>
    }
    expect(receipt.identity).toMatchObject({ os: "macOS" })
  }, 60_000)

  it("runs the tracked sampler for the os its one argument names, and refuses a missing one by name", () => {
    const missing = spawnSync(process.execPath, [identityScript], { encoding: "utf8" })
    expect(missing.status).not.toBe(0)
    expect(missing.stderr).toContain("owned-host-identity: missing os argument")
    const unknown = spawnSync(process.execPath, [identityScript, "Plan9"], { encoding: "utf8" })
    expect(unknown.status).not.toBe(0)
    expect(unknown.stderr).toContain('Owned host identity has no source table for os "Plan9"')
  }, 60_000)

  it("keeps the persistent stage and refreshes it to new source bytes and a new sha", () => {
    expect(run().status).toBe(0)
    writeFileSync(join(source, "README.md"), "second revision\n")
    git(source, "add", "-A")
    git(source, "commit", "-q", "-m", "second revision")
    revision = git(source, "rev-parse", "HEAD")
    const again = run({}, [], ["bun", "packages/admin/src/index.ts"], "wezterm")
    expect(again.status, again.stderr).toBe(0)
    expect(git(join(stage, "source", "vendor", "terminfo.dev"), "rev-parse", "HEAD")).toBe(revision)
    expect(readFileSync(join(stage, "source", "vendor", "terminfo.dev", "README.md"), "utf8")).toBe("second revision\n")
  }, 60_000)

  it("refreshes a persistent stage at the same sha: every resource is sent again, so host drift is replaced or deleted", () => {
    expect(run().status).toBe(0)
    const staged = join(stage, "source", "vendor", "silvery")
    writeFileSync(join(staged, "index.ts"), "export const silvery = 'drifted on the host'\n")
    writeFileSync(join(staged, "stray.ts"), "export const stray = 'left on the host'\n")
    const again = run({}, [], ["bun", "packages/admin/src/index.ts"], "wezterm")
    expect(again.status, again.stderr).toBe(0)
    expect(git(join(stage, "source", "vendor", "terminfo.dev"), "rev-parse", "HEAD")).toBe(revision)
    expect(readFileSync(join(staged, "index.ts"), "utf8")).toBe("export const silvery = 'fixture'\n")
    expect(existsSync(join(staged, "stray.ts"))).toBe(false)
  }, 60_000)

  it("does not stage or witness mutable test caches", () => {
    // 33797: the witness must not spawn readlink once per staged link. Count actual tool calls
    // while retaining the existing transport/cache assertions; no production-only test seam.
    const linkCalls = join(root, "resource-readlink-calls")
    writeFileSync(linkCalls, "")
    executable(
      join(shims, "readlink"),
      `#!${process.execPath}\n` +
        `import { appendFileSync } from "node:fs"\n` +
        `appendFileSync(${JSON.stringify(linkCalls)}, "readlink\\n")\n` +
        `const result = Bun.spawnSync(["/usr/bin/readlink", ...process.argv.slice(2)], { stdout: "inherit", stderr: "inherit" })\n` +
        `process.exit(result.exitCode)\n`,
    )
    writeFileSync(join(code, "node_modules", "resource with space.txt"), "same witnessed bytes\n")
    symlinkSync("resource with space.txt", join(code, "node_modules", "link with space"))
    const caches = [".vitest", ".cache", ".vitest-cache"]
    for (const cache of caches) {
      const directory = join(code, "node_modules", cache)
      mkdirSync(directory, { recursive: true })
      writeFileSync(join(directory, "results.json"), "before\n")
    }
    const first = run()
    expect(first.status, first.stderr).toBe(0)
    for (const cache of caches) {
      expect(existsSync(join(stage, "source", "node_modules", cache))).toBe(false)
      writeFileSync(join(code, "node_modules", cache, "results.json"), "changed while other tests run\n")
    }
    const again = run({}, [], ["bun", "packages/admin/src/index.ts"], "wezterm")
    expect(again.status, again.stderr).toBe(0)
    expect(proof(again).resourceManifestSha256).toBe(proof(first).resourceManifestSha256)
    expect(readFileSync(linkCalls, "utf8"), "resource witness spawned a child for a link").toBe("")
  }, 60_000)

  it("removes the stage only when asked", () => {
    expect(run({}, ["--remove-stage"]).status).toBe(0)
    expect(existsSync(stage)).toBe(false)
  }, 60_000)

  it("keeps a stage that existed before this run even when asked to remove it, so an earlier run's outputs survive", () => {
    // 33587 run 2: --remove-stage on the default stage deleted an earlier run's retained runs/ with it.
    expect(run().status).toBe(0)
    const earlier = readdirSync(join(stage, "runs"))
    expect(earlier.length).toBeGreaterThan(0)
    const again = run({}, ["--remove-stage"], ["bun", "packages/admin/src/index.ts"], "wezterm")
    expect(again.status, again.stderr).toBe(0)
    expect(again.stderr).toContain(`${stage} existed before this run; --remove-stage keeps it`)
    for (const entry of earlier) expect(existsSync(join(stage, "runs", entry)), entry).toBe(true)
  }, 60_000)

  it("stages the bundle checkout's own package node_modules links, so a package's dependency resolves on the host", () => {
    // 33587 run 2: under bun's isolated install packages/terminfo.dev resolves protobufjs only
    // through its own gitignored node_modules link, which the bundle cannot carry.
    const store = join(code, "node_modules", ".bun", "dep@1.0.0", "node_modules", "dep")
    mkdirSync(store, { recursive: true })
    writeFileSync(join(store, "index.js"), "export const dep = 'fixture'\n")
    const links = join(source, "packages", "terminfo.dev", "node_modules")
    mkdirSync(links, { recursive: true })
    const target = join("..", "..", "..", "..", "..", "node_modules", ".bun", "dep@1.0.0", "node_modules", "dep")
    symlinkSync(target, join(links, "dep"))
    const result = run()
    expect(result.status, result.stderr).toBe(0)
    const staged = join(stage, "source", "vendor", "terminfo.dev", "packages", "terminfo.dev", "node_modules", "dep")
    expect(readlinkSync(staged)).toBe(target)
    expect(readFileSync(join(staged, "index.js"), "utf8")).toBe("export const dep = 'fixture'\n")
  }, 60_000)

  it("refuses an unmarked stage and leaves it untouched rather than deleting a stranger's directory", () => {
    mkdirSync(join(stage, "runs"), { recursive: true })
    writeFileSync(join(stage, "unrelated.txt"), "not ours\n")
    const result = run({}, ["--remove-stage"])
    expect(result.status).toBe(1)
    expect(result.stderr).toContain("stage not owned")
    expect(readFileSync(join(stage, "unrelated.txt"), "utf8")).toBe("not ours\n")
  }, 60_000)

  it("refuses a stage path that would take its parent with it", () => {
    const result = run({}, ["--remove-stage"], undefined, "kitty", "/")
    expect(result.status).toBe(1)
    expect(result.stderr).toContain("invalid stage")
    expect(existsSync("/runs")).toBe(false)
  }, 60_000)

  it("refuses a stage whose path carries a shell separator or a space", () => {
    for (const candidate of ["/remote/stage;rm", "/remote/st age"]) {
      const result = run({}, [], undefined, "kitty", candidate)
      expect(result.status, candidate).toBe(1)
      expect(result.stderr).toContain("invalid stage")
    }
  }, 60_000)

  it("stages the directory a resolving link reaches, so the host can resolve it too", () => {
    const result = run()
    expect(result.status, result.stderr).toBe(0)
    expect(readFileSync(join(stage, "source", "extra", "pkg", "index.ts"), "utf8")).toContain("fixture")
    expect(existsSync(join(stage, "source", "node_modules", "@terminfo", "extra"))).toBe(true)
  }, 60_000)

  it("refuses a staged link the host cannot resolve, even when its target text matches", () => {
    const result = run({ SHIM_RSYNC_SKIP_EXTRA: "1" })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain("broken staged symlink")
  }, 60_000)

  it("refuses an absolute resource link, whose text would resolve against the host's filesystem", () => {
    symlinkSync(join(code, "extra", "pkg"), join(code, "node_modules", "@terminfo", "absolute"))
    const result = run()
    expect(result.status).toBe(1)
    expect(result.stderr).toContain("broken staged symlink")
    expect(result.stderr).toContain("absolute")
    expect(lines(sshLog)).toHaveLength(1)
  }, 60_000)

  it("refuses a relative link whose real target leaves the tree through another link", () => {
    mkdirSync(join(root, "outside"), { recursive: true })
    writeFileSync(join(root, "outside", "payload.ts"), "export const outside = 'not ours'\n")
    symlinkSync(join("..", "outside"), join(code, "hop"))
    symlinkSync(join("..", "..", "hop"), join(code, "node_modules", "@terminfo", "chain"))
    const result = run()
    expect(result.status).toBe(1)
    expect(result.stderr).toContain("escapes the staged tree")
    expect(lines(sshLog)).toHaveLength(1)
  }, 60_000)

  it("refuses a context that would escape the stage, before touching the host", () => {
    const result = run({}, [], undefined, "x/../../../escaped")
    expect(result.status).toBe(1)
    expect(result.stderr).toContain("invalid context")
    expect(lines(sshLog)).toHaveLength(0)
    expect(existsSync(join(root, "escaped"))).toBe(false)
  }, 60_000)

  it("refuses an unreachable host by name", () => {
    executable(
      join(shims, "ssh"),
      "#!/bin/sh\necho 'ssh: connect to host fixture.invalid port 22: Connection refused' >&2\nexit 255\n",
    )
    const result = run()
    expect(result.status).toBe(1)
    expect(result.stderr).toContain("host unreachable")
    expect(existsSync(join(stage, "source"))).toBe(false)
  }, 60_000)

  it("refuses a host whose key the pinned trust rejects", () => {
    const result = run({ SHIM_SSH_UNTRUSTED: "1" })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain("host key mismatch")
  }, 60_000)

  it("names the ssh step that outlived its limit instead of calling the host unreachable", () => {
    const result = run({ SHIM_SSH_SLEEP: "5" }, ["--ssh-timeout-ms", "300"])
    expect(result.status).toBe(1)
    expect(result.stderr).toContain("timeout: reachability probe exceeded")
    expect(result.stderr).toContain("min")
    expect(result.stderr).not.toContain("host unreachable")
  }, 30_000)

  it("names the rsync step that outlived its limit instead of calling the transfer incomplete", () => {
    const result = run({ SHIM_RSYNC_SLEEP: "5" }, ["--rsync-timeout-ms", "300"])
    expect(result.status).toBe(1)
    expect(result.stderr).toContain("timeout: bundle transfer exceeded")
    expect(result.stderr).toContain("min")
    expect(result.stderr).not.toContain("rsync incomplete")
  }, 30_000)

  it("refuses source the bundle cannot carry", () => {
    revision = "a".repeat(40)
    const result = run({}, [], ["bun", "packages/admin/src/index.ts"])
    expect(result.status).toBe(1)
    expect(result.stderr).toMatch(/bundle missing objects/)
  }, 60_000)

  it("refuses a stage checkout that cannot reach the named revision, keeping git's own words", () => {
    const result = run({ SHIM_STAGE_CHECKOUT_FAIL: "1" })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain("stage source mismatch")
    expect(result.stderr).toContain("reference is not a tree")
  }, 60_000)

  it("refuses a stage whose checkout holds changes no source revision names", () => {
    mkdirSync(join(stage, "source", "vendor", "terminfo.dev"), { recursive: true })
    writeFileSync(join(stage, ".owned-app-transport-stage"), "owned-app-transport stage v1\n")
    git(stage, "clone", "-q", source, join(stage, "source", "vendor", "terminfo.dev"))
    writeFileSync(join(stage, "source", "vendor", "terminfo.dev", "untracked.txt"), "not in any revision\n")
    const result = run()
    expect(result.status).toBe(1)
    expect(result.stderr).toContain("stage dirty tree")
  }, 60_000)

  it("refuses bytes staged that differ from the manifest bound before staging", () => {
    const result = run({ SHIM_RSYNC_TAMPER: "1" })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain("resource manifest mismatch")
  }, 60_000)

  it("refuses a broken symlink in the declared resources", () => {
    rmSync(join(code, "node_modules", "@terminfo", "run-parser"))
    symlinkSync(join("..", "missing"), join(code, "node_modules", "@terminfo", "run-parser"))
    const result = run()
    expect(result.status).toBe(1)
    expect(result.stderr).toContain("broken staged symlink")
  }, 60_000)

  it("refuses a host with no bun", () => {
    rmSync(join(shims, "bun"))
    const result = run()
    expect(result.status).toBe(1)
    expect(result.stderr).toContain("bun absent")
    expect(existsSync(join(output, "transport"))).toBe(false)
  }, 60_000)

  it("refuses an argv that does not name the bun runtime token", () => {
    const result = run({}, [], ["/usr/local/bin/bun", "packages/admin/src/index.ts"])
    expect(result.status).toBe(1)
    expect(result.stderr).toContain("invalid argv")
    expect(result.stderr).not.toContain("bun absent")
    expect(result.stderr).toContain("runtime token")
  }, 60_000)

  it("refuses a host with no kitty", () => {
    rmSync(join(root, "app", "kitty"))
    const result = run()
    expect(result.status).toBe(1)
    expect(result.stderr).toContain("kitty absent")
  }, 60_000)

  it("records the kitty the producer launches, not whichever kitty PATH finds first", () => {
    const result = run()
    expect(result.status, result.stderr).toBe(0)
    const receipt = JSON.parse(readFileSync(join(output, "transport", "transport-receipt.json"), "utf8")) as {
      runtime: { kitty: { path: string; version: string } }
    }
    expect(receipt.runtime.kitty).toEqual({ path: join(root, "app", "kitty"), version: "kitty 0.49.1" })
  }, 60_000)

  it("refuses to overwrite a remote output directory from an earlier run", () => {
    mkdirSync(join(stage, "runs", `${revision.slice(0, 12)}-kitty`), { recursive: true })
    writeFileSync(join(stage, ".owned-app-transport-stage"), "owned-app-transport stage v1\n")
    const result = run()
    expect(result.status).toBe(1)
    expect(result.stderr).toContain("output collision")
  }, 60_000)

  it("refuses to reuse a local output directory that already holds a transport run", () => {
    mkdirSync(join(output, "transport"), { recursive: true })
    const result = spawnSync(
      process.execPath,
      [
        driver,
        "--transport",
        "ssh:fixture@fixture.invalid",
        "--stage",
        stage,
        "--output",
        output,
        "--source-revision",
        revision,
        "--context",
        "kitty",
        "--known-hosts",
        knownHosts,
        "--",
        "bun",
        "packages/admin/src/index.ts",
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${shims}:/usr/bin:/bin`,
          OWNED_APP_TRANSPORT_SOURCE_ROOT: source,
          OWNED_APP_TRANSPORT_RESOURCE_ROOT: code,
          OWNED_APP_TRANSPORT_KITTY_PATH: join(root, "app", "kitty"),
          SHIM_SSH_LOG: sshLog,
          SHIM_RSYNC_LOG: rsyncLog,
          REAL_BUN: process.execPath,
        },
      },
    )
    expect(result.status).toBe(1)
    expect(result.stderr).toContain("output collision")
    expect(existsSync(join(stage, "runs", `${revision.slice(0, 12)}-kitty`))).toBe(true)
  }, 60_000)

  it("refuses a copy-back that did not arrive", () => {
    const result = run({ SHIM_RSYNC_SKIP_BACK: "1" })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain("rsync incomplete")
  }, 60_000)

  it("refuses a returned receipt the host did not write", () => {
    const result = run({ SHIM_RSYNC_TAMPER_RECEIPT: "1" })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain("receipt mismatch")
    expect(result.stderr).toContain("differs from the bytes written on the host")
  }, 60_000)

  it("refuses a nested returned file whose bytes changed", () => {
    const result = run({ SHIM_RSYNC_TAMPER_NESTED: "1" })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain("receipt mismatch")
    expect(result.stderr).toContain("nested/extra.log")
  }, 60_000)

  it("accepts a stage under a symlinked ancestor: the host compares against the physical root", () => {
    // A real symlinked directory, as macOS /tmp -> /private/tmp: realpath answers physically, so a
    // logical $PWD root would read every valid staged link as an escape.
    mkdirSync(join(root, "real-parent"), { recursive: true })
    symlinkSync(join(root, "real-parent"), join(root, "linked-parent"))
    const result = run({}, [], undefined, "kitty", join(root, "linked-parent", "stage"))
    expect(result.status, result.stderr).toBe(0)
    expect(existsSync(join(root, "real-parent", "stage", "source", "extra", "pkg", "index.ts"))).toBe(true)
  }, 60_000)

  it("accepts a code root reached through a symlink: local containment uses the physical root too", () => {
    symlinkSync(code, join(root, "code-link"))
    const result = run({ OWNED_APP_TRANSPORT_RESOURCE_ROOT: join(root, "code-link") })
    expect(result.status, result.stderr).toBe(0)
  }, 60_000)

  it("stages every hop of a link chain, not only its final target", () => {
    // node_modules/@terminfo/bridged -> bridge/pkg -> agx/pkg: the staged first link still needs
    // bridge, so staging only agx would leave it dangling on the host.
    mkdirSync(join(code, "agx", "pkg"), { recursive: true })
    writeFileSync(join(code, "agx", "pkg", "index.ts"), "export const agx = 'bridged'\n")
    mkdirSync(join(code, "bridge"), { recursive: true })
    symlinkSync(join("..", "agx", "pkg"), join(code, "bridge", "pkg"))
    git(code, "add", "agx", "bridge")
    git(code, "commit", "-q", "-m", "fixture bridge")
    symlinkSync(join("..", "..", "bridge", "pkg"), join(code, "node_modules", "@terminfo", "bridged"))
    const result = run()
    expect(result.status, result.stderr).toBe(0)
    expect(readFileSync(join(stage, "source", "node_modules", "@terminfo", "bridged", "index.ts"), "utf8")).toBe(
      "export const agx = 'bridged'\n",
    )
  }, 60_000)

  it("refuses a link to vendor/ before any transfer, so nothing copies over the bundle-owned tree", () => {
    symlinkSync(join("..", "..", "vendor"), join(code, "node_modules", "@terminfo", "vendor-root"))
    const result = run()
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('reaches "vendor", which holds the bundle-owned vendor/terminfo.dev')
    expect(lines(rsyncLog)).toHaveLength(0)
  }, 60_000)

  it("reads a local link to the code root itself as inside the tree, so it is refused as bundle-owned, never as an escape", () => {
    symlinkSync(join("..", ".."), join(code, "node_modules", "@terminfo", "code-root"))
    const result = run()
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('reaches ".", which holds the bundle-owned vendor/terminfo.dev')
    expect(result.stderr).not.toContain("escapes the staged tree")
    expect(lines(rsyncLog)).toHaveLength(0)
  }, 60_000)

  it("reads a host link to the staged root itself as inside the stage, so the changed target is named, never an escape", () => {
    const result = run({ SHIM_RSYNC_TAMPER_ROOT_LINK: "1" })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain("resource manifest mismatch")
    expect(result.stderr).toContain('staged "node_modules/@terminfo/run-parser\\tsymlink:../..\\tresolved:"')
    expect(result.stderr).not.toContain("escaped")
  }, 60_000)

  it("stages a closure root at its tracked revision only, never untracked or modified working files", () => {
    nestedBinFixture()
    writeFileSync(join(code, "extra", "pkg", "untracked.ts"), "export const untracked = 1\n")
    writeFileSync(join(code, "extra", "pkg", "index.ts"), "export const extra = 'modified, uncommitted'\n")
    const result = run()
    expect(result.status, result.stderr).toBe(0)
    expect(existsSync(join(stage, "source", "extra", "pkg", "untracked.ts"))).toBe(false)
    expect(readFileSync(join(stage, "source", "extra", "pkg", "index.ts"), "utf8")).toBe(
      "export const extra = 'fixture'\n",
    )
    expect(readFileSync(join(stage, "source", "node_modules", ".bin", "maddoc"), "utf8")).toBe(
      "export const bin = 'pinned'\n",
    )
    expect(existsSync(join(stage, "source", "km", "apps", "maddoc", "payload", "untracked.ts"))).toBe(false)
  }, 60_000)

  it("names the nested path, recorded commit and repository when the tracked object is unavailable", () => {
    const { nested, pinned } = nestedBinFixture(true)
    const result = run()
    expect(result.status).toBe(1)
    expect(result.stderr).toContain("resource manifest mismatch")
    expect(result.stderr).toContain("km/apps/maddoc")
    expect(result.stderr).toContain(pinned)
    expect(result.stderr).toContain(nested)
    expect(lines(rsyncLog)).toHaveLength(0)
  }, 60_000)

  it("refuses a closure root its HEAD does not track", () => {
    mkdirSync(join(code, "loose", "pkg"), { recursive: true })
    writeFileSync(join(code, "loose", "pkg", "index.ts"), "export const loose = 1\n")
    symlinkSync(join("..", "..", "loose", "pkg"), join(code, "node_modules", "@terminfo", "loose"))
    const result = run()
    expect(result.status).toBe(1)
    expect(result.stderr).toContain("reaches loose, which")
    expect(result.stderr).toContain("only tracked files are staged")
    expect(lines(rsyncLog)).toHaveLength(0)
  }, 60_000)

  it("refuses a link closure deeper than its pass limit by name instead of cutting it short", () => {
    // Each pass stages one more hop (the final real target, d5, is found at once), so five
    // directories need a fourth pass.
    for (const [from, to] of [
      ["d1", "d2"],
      ["d2", "d3"],
      ["d3", "d4"],
      ["d4", "d5"],
    ] as const) {
      mkdirSync(join(code, from, "x"), { recursive: true })
      symlinkSync(join("..", "..", to, "x"), join(code, from, "x", "next"))
    }
    mkdirSync(join(code, "d5", "x"), { recursive: true })
    writeFileSync(join(code, "d5", "x", "end.ts"), "export const end = 1\n")
    git(code, "add", "d1", "d2", "d3", "d4", "d5")
    git(code, "commit", "-q", "-m", "fixture chain")
    symlinkSync(join("..", "..", "d1", "x"), join(code, "node_modules", "@terminfo", "chain"))
    const result = run()
    expect(result.status).toBe(1)
    expect(result.stderr).toContain("link closure exceeds 3 passes: links still reach d4")
    expect(lines(rsyncLog)).toHaveLength(0)
  }, 60_000)

  it("refuses a host that reports two server host keys, since which one is the host's is a guess", () => {
    const result = run({ SHIM_SSH_TWO_KEYS: "1" })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain("host key mismatch: ssh reported 2 server host keys")
    expect(existsSync(stage)).toBe(false)
  }, 60_000)

  it("quotes rsync's -e by rsync's own rule, so a known-hosts path holding a quote stays one word", () => {
    mkdirSync(join(root, "kh'q"))
    const quoted = join(root, "kh'q", "known_hosts")
    writeFileSync(quoted, readFileSync(knownHosts))
    knownHosts = quoted
    const result = run()
    expect(result.status, result.stderr).toBe(0)
    const transfers = lines(rsyncLog)
    expect(transfers.length).toBeGreaterThan(1)
    for (const transfer of transfers) expect(transfer).toContain(`'UserKnownHostsFile=${quoted.replace(/'/g, "''")}'`)
  }, 60_000)

  it("names a timed-out step that may still be running and keeps the stage even when asked to remove it", () => {
    const result = run({ SHIM_SSH_SLEEP_ON: "checkout --detach" }, ["--ssh-timeout-ms", "3000", "--remove-stage"])
    expect(result.status).toBe(1)
    expect(result.stderr).toContain("timeout: stage checkout exceeded 0.05 min")
    expect(result.stderr).toContain("may still be running on fixture@fixture.invalid, so the stage is kept")
    expect(readFileSync(join(stage, ".owned-app-transport-stage"), "utf8")).toBe("owned-app-transport stage v1\n")
  }, 30_000)

  it("removes an owned stage after a failed run when asked, renaming it aside before deleting", () => {
    const result = run({ SHIM_RSYNC_TAMPER: "1" }, ["--remove-stage"])
    expect(result.status).toBe(1)
    expect(result.stderr).toContain("resource manifest mismatch")
    expect(existsSync(stage)).toBe(false)
    expect(readdirSync(join(root, "remote"))).toEqual([])
    expect(
      lines(sshLog).some((spawn) => /mv -- '[^']*\/stage' '[^']*\/stage\.removing-[0-9a-f]{12}'/.test(spawn)),
    ).toBe(true)
  }, 60_000)

  it("leaves only the renamed aside when a removal is interrupted, so the stage path is free again", () => {
    // The run creates the stage (only a stage it created is removed), and its probe leaves a
    // directory that cannot be emptied, so the removal stops part-way.
    try {
      const result = run({ SHIM_PROBE_LOCK: "1" }, ["--remove-stage"])
      expect(result.status).toBe(1)
      expect(result.stderr).toContain("stage removal failed")
      expect(result.stderr).toMatch(/moved to \S*\/stage\.removing-[0-9a-f]{12} and only part of it was deleted/)
      expect(existsSync(stage)).toBe(false)
      const again = run()
      expect(again.status, again.stderr).toBe(0)
    } finally {
      for (const entry of readdirSync(join(root, "remote"))) {
        const locked = join(root, "remote", entry, "runs", "locked")
        if (existsSync(locked)) chmodSync(locked, 0o755)
      }
    }
  }, 60_000)

  it("refuses to remove a stage whose marker changed during the run", () => {
    const result = run({ SHIM_PROBE_CLOBBER_MARKER: "1" }, ["--remove-stage"])
    expect(result.status).toBe(1)
    expect(result.stderr).toContain("stage not owned")
    expect(result.stderr).toContain("has no valid marker; refusing to delete it")
    expect(existsSync(join(stage, "runs"))).toBe(true)
  }, 60_000)

  it("refuses a stage that is the remote home or holds it", () => {
    for (const home of [stage, join(stage, "home")]) {
      // Only the remote shell owns this HOME; local Bun may populate its own cache.
      const result = run({ SHIM_SSH_HOME: home })
      expect(result.status, home).toBe(1)
      expect(result.stderr, home).toContain("is the remote home or contains it")
    }
    expect(existsSync(stage)).toBe(false)
  }, 60_000)

  it("refuses a stage that is not normalized or too shallow to own, before any spawn", () => {
    for (const [candidate, reason] of [
      [`${join(root, "remote")}//stage`, "is not a normalized path"],
      [`${join(root, "remote")}/./stage`, "is not a normalized path"],
      ["/stage", "is too close to the root to own"],
    ] as const) {
      const result = run({}, [], undefined, "kitty", candidate)
      expect(result.status, candidate).toBe(1)
      expect(result.stderr, candidate).toContain(reason)
    }
    expect(lines(sshLog)).toHaveLength(0)
  }, 60_000)
})

describe("default stage", () => {
  it("derives the stage under the home the host answers and names it once", () => {
    const home = join(root, "remote", "home")
    mkdirSync(home, { recursive: true })
    const result = run({ SHIM_SSH_HOME: home }, [], undefined, undefined, null)
    expect(result.status, result.stderr).toBe(0)
    const defaultStage = join(home, ".cache", "terminfo.dev", "owned-app-stage")
    const mentions = result.stderr
      .trim()
      .split("\n")
      .filter((line) => line.includes(defaultStage))
    expect(mentions).toHaveLength(1)
    const receipt = JSON.parse(readFileSync(join(output, "transport", "transport-receipt.json"), "utf8")) as {
      stage: unknown
    }
    expect(receipt.stage).toEqual({ directory: defaultStage, marker: "owned-app-transport stage v1" })
    expect(readFileSync(join(defaultStage, ".owned-app-transport-stage"), "utf8").trim()).toBe(
      "owned-app-transport stage v1",
    )
  })

  it("refuses a default stage that exists without the marker and leaves it untouched", () => {
    const home = join(root, "remote", "home")
    const defaultStage = join(home, ".cache", "terminfo.dev", "owned-app-stage")
    mkdirSync(defaultStage, { recursive: true })
    writeFileSync(join(defaultStage, "stranger.txt"), "not ours\n")
    const result = run({ SHIM_SSH_HOME: home }, [], undefined, undefined, null)
    expect(result.status).not.toBe(0)
    expect(result.stderr).toMatch(/stage not owned/)
    expect(readFileSync(join(defaultStage, "stranger.txt"), "utf8")).toBe("not ours\n")
  })

  it("refuses a home whose path cannot carry a stage, naming the default and the flag", () => {
    const home = join(root, "remote", "home with space")
    mkdirSync(home, { recursive: true })
    const result = run({ SHIM_SSH_HOME: home }, [], undefined, undefined, null)
    expect(result.status).not.toBe(0)
    expect(result.stderr).toMatch(/invalid stage/)
    expect(result.stderr).toContain("home with space")
    expect(result.stderr).toMatch(/--owned-app-stage|--stage/)
  })

  // Requirement: an uncounted run must not pay for hashing and re-sending a node_modules tree an
  // earlier full run already hashed, and its receipt must say so; a changed lock must restage it.
  it("reuses a stage a full run hashed, re-sending no node_modules, and names the light check", () => {
    const first = run()
    expect(first.status, first.stderr).toBe(0)
    expect(proof(first).check).toBe("full")
    const markerPath = join(stage, ".owned-app-transport-resources")
    expect(existsSync(markerPath)).toBe(true)
    const marker = JSON.parse(readFileSync(markerPath, "utf8")) as Record<string, unknown>
    expect(marker.lockSha256).toBe(
      createHash("sha256")
        .update(readFileSync(join(code, "bun.lock")))
        .digest("hex"),
    )
    expect(marker.manifestSha256).toBe(proof(first).resourceManifestSha256)

    const before = lines(rsyncLog).length
    const second = run({}, ["--check", "light"], undefined, "kitty-light")
    expect(second.status, second.stderr).toBe(0)
    const light = proof(second)
    expect(light.check).toBe("light")
    // The node_modules trees are what the marker stands for: no transfer and no hash this run.
    const transferred = lines(rsyncLog).slice(before)
    expect(transferred.filter((line) => line.includes("node_modules"))).toEqual([])
    // The receipt still names the digest those trees last hashed to, and says where it came from.
    const receipt = JSON.parse(readFileSync(join(output, "transport", "transport-receipt.json"), "utf8")) as Record<
      string,
      unknown
    >
    expect(receipt.check).toBe("light")
    expect(receipt.resourceManifestSha256).toBe(marker.manifestSha256)
    expect(receipt.resourceManifestBasis).toBe("stage marker from an earlier full run")
    expect(typeof receipt.lightManifestSha256).toBe("string")
    // The marker is not rewritten by a run that did not hash the trees it stands for.
    expect(readFileSync(markerPath, "utf8")).toBe(JSON.stringify(marker, null, 2) + "\n")
  }, 60_000)

  it("restages fully when the lock is not the one the stage was hashed against", () => {
    const first = run()
    expect(first.status, first.stderr).toBe(0)
    writeFileSync(join(code, "bun.lock"), "changed lock\n")
    const second = run({}, ["--check", "light"], undefined, "kitty-restage")
    expect(second.status, second.stderr).toBe(0)
    expect(second.stderr).toContain("light check declined")
    expect(second.stderr).toContain("restaging fully")
    expect(proof(second).check).toBe("full")
  }, 60_000)

  // Requirement: a `git status` that could not RUN is not a clean checkout. Before the exit witness,
  // `|| true` turned git's exit 128 into empty stdout, and empty stdout read as clean.
  it("declines the light check when the staged checkout's dirty state cannot be read", () => {
    const first = run()
    expect(first.status, first.stderr).toBe(0)
    expect(proof(first).check).toBe("full")
    const index = join(stage, "source", "vendor", "terminfo.dev", ".git", "index")
    expect(existsSync(index)).toBe(true)
    writeFileSync(index, "short")
    const second = run({}, ["--check", "light"], undefined, "kitty-unreadable")
    expect(second.status, second.stderr).toBe(0)
    expect(second.stderr).toContain("light check declined")
    // Pinned to the exit-128 branch, not the shared prefix: the no-exit-code branch says so instead.
    expect(second.stderr).toMatch(/dirty state could not be read \(git status exited 128: fatal: \.git\/index/)
    expect(second.stderr).toContain("restaging fully")
    // The rebuild is named where the operator can read it, and the proof says the projection moved.
    expect(second.stderr).toContain(
      "the staged index is unreadable; the staged projection, including any tracked edits, is replaced",
    )
    expect(proof(second).check).toBe("full")
    expect(proof(second).stageRebuild).toBe("index unreadable")
  }, 60_000)

  // Requirement: only a PROVEN index fault may rebuild the stage. A git that cannot read its own
  // config refuses by name and leaves the index alone — deleting it there made the next run read a
  // tree it could not describe, and only a hand repair could bring the stage back (@dev/15 R3).
  it("refuses by name when git cannot read its config in the staged checkout, and keeps the index", () => {
    const first = run()
    expect(first.status, first.stderr).toBe(0)
    const index = join(stage, "source", "vendor", "terminfo.dev", ".git", "index")
    const config = join(stage, "source", "vendor", "terminfo.dev", ".git", "config")
    chmodSync(config, 0o000)
    const second = run({}, [], undefined, "kitty-refused-config")
    chmodSync(config, 0o644)
    expect(second.status).not.toBe(0)
    expect(second.stderr).toContain("stage git unusable")
    expect(second.stderr).toContain("git cannot run in the staged checkout, so this is not an index fault")
    expect(existsSync(index)).toBe(true)
  }, 60_000)

  // Requirement: a decision belongs to the run that made it. An interrupted run leaves the rebuild
  // marker behind, and a later run that finds a READABLE dirty index must refuse that dirt instead of
  // force-cleaning it on the previous run's decision (@dev/3 R4).
  it("never rebuilds on a marker an earlier interrupted run left behind", () => {
    const first = run()
    expect(first.status, first.stderr).toBe(0)
    const checkout = join(stage, "source", "vendor", "terminfo.dev")
    const marker = join(stage, ".owned-app-transport-rebuild")
    writeFileSync(marker, "left-behind-by-an-interrupted-run\n")
    const trackedName = spawnSync("git", ["-C", checkout, "ls-files"], { encoding: "utf8" })
      .stdout.trim()
      .split("\n")[0]!
    const tracked = join(checkout, trackedName)
    const original = readFileSync(tracked, "utf8")
    writeFileSync(tracked, `${original}\nlocal edit nobody's revision names\n`)

    const second = run()

    // The readable index keeps its dirt: the run refuses the dirty stage, and the stale marker is gone.
    expect(second.status).not.toBe(0)
    expect(second.stderr).toContain("stage dirty tree")
    expect(existsSync(marker)).toBe(false)
    expect(readFileSync(tracked, "utf8")).toContain("local edit nobody's revision names")
  }, 60_000)

  // Requirement: a marker that parses as JSON but is not an object must decline by name. JSON null
  // parsed cleanly and then threw on `.version`, skipping the full-restage fallback entirely.
  it("declines the light check by name when the stage's resource marker is JSON null", () => {
    const first = run()
    expect(first.status, first.stderr).toBe(0)
    writeFileSync(join(stage, ".owned-app-transport-resources"), "null\n")
    const second = run({}, ["--check", "light"], undefined, "kitty-null-marker")
    expect(second.status, second.stderr).toBe(0)
    expect(second.stderr).toContain("light check declined")
    expect(second.stderr).toContain("not a JSON object")
    expect(second.stderr).toContain("restaging fully")
    expect(proof(second).check).toBe("full")
  }, 60_000)
})
