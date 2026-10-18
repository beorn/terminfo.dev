/**
 * @failure An owned-app run started on a remote host is credited without proving exact source, the
 *   resource bytes it ran against, the host it ran on, or that the bytes returned are the bytes the
 *   host measured — or the transport silently accepts a stage it cannot vouch for, drops its ssh
 *   pinning on a transfer, or hands the host an argv the collector never composed.
 * @level l1 — runs the real driver against owned temporary trees and PATH shims for ssh/rsync.
 * @consumer scripts/owned-app-remote-run.ts and the local-owned-app branch of release1-collection.
 * @reach fs-walk <fixture-only: one owned temporary fixture tree per test>
 * @reach fs-walk vendor/terminfo.dev/scripts/
 * @testonly none
 */
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

const driver = fileURLToPath(new URL("./owned-app-remote-run.ts", import.meta.url))

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
    "export function sampleOwnedHostIdentity(os: string): Record<string, string> { return { os } }\n",
  )
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
      'exec /bin/sh -c "$command"',
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
    ].join("\n"),
  )
  executable(
    join(shims, "bun"),
    [
      "#!/bin/sh",
      'case "$*" in',
      '  *identity.ts*) printf \'%s\' \'{"machineIdSha256":"aaaa","productUuidSha256":"bbbb","bootIdSha256":"cccc"}\' ;;',
      "  *) out=''",
      '     while [ $# -gt 0 ]; do case "$1" in --output) shift; out="$1" ;; esac; shift; done',
      '     mkdir -p "$out/nested"',
      '     [ "${SHIM_PROBE_CLOBBER_MARKER:-}" = 1 ] && printf \'not ours\\n\' > "$out/../../.owned-app-transport-stage"',
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
  stageArgument = stage,
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
    ...extraEnv,
  }
  rmSync(join(output, "transport"), { recursive: true, force: true })
  const result = spawnSync(
    process.execPath,
    [
      driver,
      "--transport",
      "ssh:fixture@fixture.invalid",
      "--stage",
      stageArgument,
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
    expect(run().status).toBe(0)
    const sampler = readFileSync(join(stage, "identity.ts"), "utf8")
    expect(sampler).toContain('sampleOwnedHostIdentity("macOS")')
    expect(sampler).not.toContain("RUNNER_OS")
    expect(sampler).toContain(
      join(stage, "source", "vendor", "terminfo.dev", "packages", "terminfo.dev", "src", "disposable-receipt.ts"),
    )
    const sampleSpawn = lines(sshLog).find((spawn) => spawn.includes("identity.ts") && !spawn.includes("cat >"))
    expect(sampleSpawn).toBeDefined()
    expect(sampleSpawn).not.toContain("RUNNER_OS")
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

  it("removes the stage only when asked", () => {
    expect(run({}, ["--remove-stage"]).status).toBe(0)
    expect(existsSync(stage)).toBe(false)
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

  it("stages a closure root at its tracked revision only, never untracked or modified working files", () => {
    writeFileSync(join(code, "extra", "pkg", "untracked.ts"), "export const untracked = 1\n")
    writeFileSync(join(code, "extra", "pkg", "index.ts"), "export const extra = 'modified, uncommitted'\n")
    const result = run()
    expect(result.status, result.stderr).toBe(0)
    expect(existsSync(join(stage, "source", "extra", "pkg", "untracked.ts"))).toBe(false)
    expect(readFileSync(join(stage, "source", "extra", "pkg", "index.ts"), "utf8")).toBe(
      "export const extra = 'fixture'\n",
    )
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
    mkdirSync(join(stage, "runs", "locked"), { recursive: true })
    writeFileSync(join(stage, ".owned-app-transport-stage"), "owned-app-transport stage v1\n")
    writeFileSync(join(stage, "runs", "locked", "held.txt"), "cannot be unlinked\n")
    chmodSync(join(stage, "runs", "locked"), 0o555)
    try {
      const result = run({}, ["--remove-stage"])
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
      const result = run({ HOME: home })
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
