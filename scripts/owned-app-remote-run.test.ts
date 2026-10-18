/**
 * @failure An owned-app run started on a remote host is credited without proving exact source, the
 *   resource bytes it ran against, the host it ran on, or that the bytes returned are the bytes the
 *   host measured — or the transport silently accepts a stage it cannot vouch for.
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
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

const driver = fileURLToPath(new URL("./owned-app-remote-run.ts", import.meta.url))
const REVISION_PLACEHOLDER = "0".repeat(40)

let root: string
let code: string
let source: string
let shims: string
let stage: string
let output: string
let knownHosts: string
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

  writeFileSync(knownHosts, "fixture.invalid ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGZpeHR1cmVrZXk=\n")

  executable(join(shims, "ssh"), '#!/bin/sh\nwhile [ "$1" = "-o" ]; do shift 2; done\nshift\nexec /bin/sh -c "$*"\n')
  executable(
    join(shims, "rsync"),
    [
      "#!/bin/sh",
      "set -e",
      'while [ $# -gt 2 ]; do case "$1" in -a|--delete|-v) shift ;; --exclude=*) shift ;; *) break ;; esac; done',
      'src="$1"; dest="$2"',
      'case "$src" in *:*) src="${src#*:}" ;; esac',
      'case "$dest" in *:*) dest="${dest#*:}" ;; esac',
      'if [ "${SHIM_RSYNC_SKIP_BACK:-}" = 1 ]; then case "$1" in *:*) exit 0 ;; esac; fi',
      'case "$src" in */) mkdir -p "$dest"; cp -R "$src". "$dest" ;; *) [ -d "$dest" ] && find "$dest" -depth -delete; mkdir -p "$(dirname "$dest")"; cp -R "$src" "$dest" ;; esac',
      'if [ "${SHIM_RSYNC_TAMPER:-}" = 1 ]; then case "$dest" in */source/package.json) printf \'tampered\' >> "$dest" ;; esac; fi',
    ].join("\n"),
  )
  executable(
    join(shims, "ssh-keygen"),
    [
      "#!/bin/sh",
      'if [ "$1" = -F ]; then host="$2"; file="$4"',
      '  line=$(grep -m1 "^$host " "$file" || true)',
      '  if [ -z "$line" ]; then echo "host $host not found" >&2; exit 1; fi',
      '  echo "$host ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGZpeHR1cmVrZXk="',
      "  exit 0",
      "fi",
      "echo '256 SHA256:fixtureSHA256fingerprint fixture.invalid (ED25519)'",
    ].join("\n"),
  )
  executable(
    join(shims, "bun"),
    [
      "#!/bin/sh",
      "out=''",
      'while [ $# -gt 0 ]; do case "$1" in --output) shift; out="$1" ;; esac; shift; done',
      'printf \'{"target":{"id":"kitty"}}\\n\' > "$out/v2-run.json"',
      "echo 'fixture probe stdout'",
    ].join("\n"),
  )
  executable(join(shims, "kitty"), "#!/bin/sh\necho 'kitty 0.49.1'\n")
  executable(
    join(shims, "sw_vers"),
    '#!/bin/sh\ncase "$1" in -productVersion) echo 15.0 ;; -buildVersion) echo 24A335 ;; *) echo 15.0 ;; esac\n',
  )
}

function run(
  extraEnv: Record<string, string> = {},
  extraArgs: string[] = [],
  argv: string[] = ["packages/admin/src/index.ts", "probe", "app", "kitty"],
  context = "kitty",
) {
  const env = {
    ...process.env,
    PATH: `${shims}:/usr/bin:/bin`,
    OWNED_APP_TRANSPORT_SOURCE_ROOT: source,
    OWNED_APP_TRANSPORT_RESOURCE_ROOT: code,
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
      stage,
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
      hostKeyFingerprint: "SHA256:fixtureSHA256fingerprint",
    })
    expect(recorded.resourceManifestSha256).toMatch(/^[a-f0-9]{64}$/)

    const transport = join(output, "transport")
    const receipt = JSON.parse(readFileSync(join(transport, "transport-receipt.json"), "utf8")) as {
      kind: string
      grants: string
      sourceRevision: string
      identity: { hostname: string }
      output: { files: Array<{ path: string; sha256: string }> }
      hostKeyFingerprint: string
    }
    expect(receipt.kind).toBe("owned-app-transport")
    expect(receipt.grants).toBe("nothing")
    expect(receipt.sourceRevision).toBe(revision)
    expect(receipt.hostKeyFingerprint).toBe("SHA256:fixtureSHA256fingerprint")
    expect(receipt.identity.hostname).not.toBe("")
    expect(receipt.output.files).toHaveLength(1)
    const runBytes = readFileSync(join(transport, "v2-run.json"))
    expect(createHash("sha256").update(runBytes).digest("hex")).toBe(receipt.output.files[0]!.sha256)
    expect(readFileSync(join(transport, "launcher.stdout.log"), "utf8")).toContain("fixture probe stdout")
    expect(git(join(stage, "source", "vendor", "terminfo.dev"), "rev-parse", "HEAD")).toBe(revision)
    expect(existsSync(stage)).toBe(true)
  }, 60_000)

  it("keeps the persistent stage and refreshes it to the exact source on the next run", () => {
    expect(run().status).toBe(0)
    const again = run({}, [], ["packages/admin/src/index.ts"], "wezterm")
    expect(again.status, again.stderr).toBe(0)
    expect(git(join(stage, "source", "vendor", "terminfo.dev"), "rev-parse", "HEAD")).toBe(revision)
  }, 60_000)

  it("removes the stage only when asked", () => {
    expect(run({}, ["--remove-stage"]).status).toBe(0)
    expect(existsSync(stage)).toBe(false)
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

  it("refuses a host whose key is not trusted by the environment-owned known-hosts file", () => {
    writeFileSync(knownHosts, "other.invalid ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIG90aGVy\n")
    const result = run()
    expect(result.status).toBe(1)
    expect(result.stderr).toContain("host key mismatch")
  }, 60_000)

  it("refuses source the bundle cannot carry", () => {
    revision = "a".repeat(40)
    const result = run({}, [], ["packages/admin/src/index.ts"])
    expect(result.status).toBe(1)
    expect(result.stderr).toMatch(/bundle missing objects/)
  }, 60_000)

  it("refuses a stage whose checkout holds changes no source revision names", () => {
    mkdirSync(join(stage, "source", "vendor", "terminfo.dev"), { recursive: true })
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

  it("refuses a host with no kitty", () => {
    rmSync(join(shims, "kitty"))
    const result = run()
    expect(result.status).toBe(1)
    expect(result.stderr).toContain("kitty absent")
  }, 60_000)

  it("refuses to overwrite a remote output directory from an earlier run", () => {
    mkdirSync(join(stage, "runs", `${revision.slice(0, 12)}-kitty`), { recursive: true })
    const result = run()
    expect(result.status).toBe(1)
    expect(result.stderr).toContain("output collision")
  }, 60_000)

  it("refuses a copy-back that did not arrive", () => {
    const result = run({ SHIM_RSYNC_SKIP_BACK: "1" })
    expect(result.status).toBe(1)
    expect(result.stderr).toMatch(/rsync incomplete|receipt mismatch/)
  }, 60_000)
})
