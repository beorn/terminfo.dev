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
    "export function sampleHostedIdentity(required: (key: string) => string): Record<string, string> { return { required: required('RUNNER_OS') } }\n",
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
      'while [ "$1" = "-o" ]; do shift 2; done',
      'while [ "$1" = "-v" ]; do shift; done',
      '[ "$1" = "--" ] && shift',
      "shift",
      'command="$*"',
      'if [ "${SHIM_STAGE_CHECKOUT_FAIL:-}" = 1 ]; then',
      '  case "$command" in *"checkout --detach"*) echo "fatal: reference is not a tree: deadbeef" >&2; exit 128 ;; esac',
      "fi",
      "[ \"$verbose\" = 1 ] && echo 'debug1: Server host key: ssh-ed25519 SHA256:fixtureNegotiated' >&2",
      'exec /bin/sh -c "$command"',
    ].join("\n"),
  )
  executable(
    join(shims, "rsync"),
    [
      "#!/bin/sh",
      "{ printf 'RSYNC'; for a in \"$@\"; do printf '\\t%s' \"$a\"; done; printf '\\n'; } >> \"${SHIM_RSYNC_LOG:-/dev/null}\"",
      "set -e",
      'while [ $# -gt 2 ]; do case "$1" in -a|--delete|-v) shift ;; -e) shift 2 ;; --exclude=*) shift ;; --) shift ;; *) break ;; esac; done',
      'src="$1"; dest="$2"',
      'case "$src" in *:*) src="${src#*:}" ;; esac',
      'case "$dest" in *:*) dest="${dest#*:}" ;; esac',
      'if [ "${SHIM_RSYNC_SKIP_BACK:-}" = 1 ]; then case "$1" in *:*) exit 0 ;; esac; fi',
      'if [ "${SHIM_RSYNC_SKIP_EXTRA:-}" = 1 ]; then case "$src" in */extra/) exit 0 ;; esac; fi',
      'case "$src" in */) mkdir -p "$dest"; cp -R "$src". "$dest" ;; *) [ -d "$dest" ] && find "$dest" -depth -delete; mkdir -p "$(dirname "$dest")"; cp -R "$src" "$dest" ;; esac',
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
      '     printf \'{\"target\":{\"id\":\"kitty\"}}\\n\' > "$out/kitty-1.0-macos-run1.json"',
      "     printf 'fixture nested output\\n' > \"$out/nested/extra.log\"",
      "     echo 'fixture probe stdout' ;;",
      "esac",
    ].join("\n"),
  )
  executable(join(shims, "kitty"), "#!/bin/sh\necho 'kitty 0.49.1'\n")
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
    SHIM_SSH_LOG: sshLog,
    SHIM_RSYNC_LOG: rsyncLog,
    ...extraEnv,
  }
  rmSync(join(output, "transport"), { recursive: true, force: true })
  return spawnSync(
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

    // Every ssh spawn and every rsync transfer carried the same pinned trust; rsync's -e is the
    // proof that no transfer fell back to the user's ssh_config.
    const sshSpawns = lines(sshLog)
    expect(sshSpawns.length).toBeGreaterThan(3)
    for (const spawn of sshSpawns) {
      expect(spawn).toContain("BatchMode=yes")
      expect(spawn).toContain("StrictHostKeyChecking=yes")
      expect(spawn).toContain(`UserKnownHostsFile=${knownHosts}`)
      expect(spawn).toContain("GlobalKnownHostsFile=/dev/null")
      expect(spawn).toContain("ConnectTimeout=15")
    }
    const transfers = lines(rsyncLog)
    expect(transfers.length).toBeGreaterThan(1)
    for (const transfer of transfers) {
      expect(transfer).toContain("-e")
      expect(transfer).toContain("BatchMode=yes")
      expect(transfer).toContain("StrictHostKeyChecking=yes")
      expect(transfer).toContain(`UserKnownHostsFile=${knownHosts}`)
    }

    // The probe reaches the host as ONE bun: the runtime token is replaced, never prefixed twice.
    const probeSpawn = sshSpawns.find((spawn) => spawn.includes("packages/admin/src/index.ts"))
    expect(probeSpawn).toBeDefined()
    expect(probeSpawn).not.toMatch(/'bun'/)
    expect(probeSpawn).toContain(join(shims, "bun"))

    // Identity comes from the shared sampler, executed from the staged checkout.
    expect(readFileSync(join(stage, "identity.ts"), "utf8")).toContain("sampleHostedIdentity")
    expect(readFileSync(join(stage, "identity.ts"), "utf8")).toContain(
      join(stage, "source", "vendor", "terminfo.dev", "packages", "terminfo.dev", "src", "disposable-receipt.ts"),
    )

    // The producer's own filename contract is carried: the driver never renames or demands a name.
    expect(receipt.output.files.map((file) => file.path)).toContain("kitty-1.0-macos-run1.json")
    // Every returned file is hashed, not just the ones at depth 1.
    expect(receipt.output.files).toHaveLength(2)
    for (const file of receipt.output.files) {
      const bytes = readFileSync(join(transport, file.path))
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(file.sha256)
    }
  }, 60_000)

  it("keeps the persistent stage and refreshes it to the exact source on the next run", () => {
    expect(run().status).toBe(0)
    const again = run({}, [], ["bun", "packages/admin/src/index.ts"], "wezterm")
    expect(again.status, again.stderr).toBe(0)
    expect(git(join(stage, "source", "vendor", "terminfo.dev"), "rev-parse", "HEAD")).toBe(revision)
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
    expect(result.stderr).toContain("bun absent")
    expect(result.stderr).toContain("runtime token")
  }, 60_000)

  it("refuses a host with no kitty", () => {
    rmSync(join(shims, "kitty"))
    const result = run()
    expect(result.status).toBe(1)
    expect(result.stderr).toContain("kitty absent")
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
})
