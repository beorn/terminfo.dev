/**
 * @failure An installed CLI silently falls back to absent source files when its compiled suite receipt is missing.
 * @level l1
 * @consumer Published terminfo.dev bin entry
 * @reach fs-walk <fixture-only: the composed tree is one owned temporary clone with a symlinked node_modules>
 * @testonly none
 */
import { execFileSync, spawnSync } from "node:child_process"
import {
  appendFileSync,
  copyFileSync,
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
import { expect, it } from "vitest"

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")

it("fails explicitly when the installed CLI bundle is missing", () => {
  const root = mkdtempSync(join(tmpdir(), "terminfo-cli-pack-"))
  try {
    const binDir = join(root, "bin")
    mkdirSync(binDir)
    copyFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "..", "packages", "terminfo.dev", "bin", "terminfo.mjs"),
      join(binDir, "terminfo.mjs"),
    )
    const result = spawnSync(process.execPath, [join(binDir, "terminfo.mjs"), "--help"], { encoding: "utf8" })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toMatch(/CLI bundle missing/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

it("refuses an absent or mismatched packed bundle receipt before execution", () => {
  const root = mkdtempSync(join(tmpdir(), "terminfo-cli-pack-"))
  try {
    const binDir = join(root, "bin")
    const distDir = join(root, "dist")
    mkdirSync(binDir)
    mkdirSync(distDir)
    const bin = join(binDir, "terminfo.mjs")
    copyFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "..", "packages", "terminfo.dev", "bin", "terminfo.mjs"),
      bin,
    )
    writeFileSync(join(distDir, "terminfo.bundle.mjs"), "throw new Error('bundle executed before receipt check')\n")
    const absent = spawnSync(process.execPath, [bin, "--version"], { encoding: "utf8" })
    expect(absent.status).not.toBe(0)
    expect(absent.stderr).toMatch(/receipt/i)
    writeFileSync(
      join(distDir, "terminfo.bundle.receipt.json"),
      JSON.stringify({
        schemaVersion: 1,
        probeHash: "a".repeat(12),
        collectorRevision: "b".repeat(40),
        manifestSha256: "c".repeat(64),
        bundleSha256: "d".repeat(64),
      }),
    )
    const mismatch = spawnSync(process.execPath, [bin, "--version"], { encoding: "utf8" })
    expect(mismatch.status).not.toBe(0)
    expect(mismatch.stderr).toMatch(/bundle.*digest|SHA256.*mismatch/i)
    expect(mismatch.stderr).not.toMatch(/bundle executed before receipt check/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

/**
 * The 27864 fixture: a NON-FAST-FORWARD COMPOSE lands a suite nobody declared. The tree's HEAD is
 * on origin/main (so it cannot author a declaration) and its composed suite has no manifest. The
 * BUILD must run and stay GREEN there — not only `--check` — and the receipt must carry the state,
 * which the launcher then refuses BY NAME before any container starts. RED BEFORE: the build threw
 * out of `declaredSuiteManifest()` on exactly this tree.
 */
it("stays green on a composed tree and hands the launcher a receipt it refuses by name", () => {
  const root = mkdtempSync(join(tmpdir(), "terminfo-composed-tree-"))
  try {
    const fixture = join(root, "composed")
    // REPO_ROOT may itself be a detached checkout (a submodule at a shared-main pin): cloning it
    // then prints git's detached-HEAD advice on stderr, which execFileSync inherits and the Vitest
    // output gate rejects. `advice.detachedHead=false` keeps the clone quiet in both states.
    execFileSync("git", ["-c", "advice.detachedHead=false", "clone", "--shared", "--quiet", REPO_ROOT, fixture], {
      encoding: "utf8",
    })
    symlinkSync(join(REPO_ROOT, "node_modules"), join(fixture, "node_modules"))
    const git = (...args: string[]): string =>
      execFileSync("git", args, { cwd: fixture, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
    git("config", "user.email", "fixture@example.invalid")
    git("config", "user.name", "fixture")
    // A composed probe change moves the suite hash; the manifest for that hash is never committed.
    appendFileSync(join(fixture, "packages/probes/vitest.config.ts"), "\n// composed tree: a suite nobody declared\n")
    git("add", "packages/probes/vitest.config.ts")
    git("commit", "-q", "-m", "fixture: composed probe change")
    git("update-ref", "refs/remotes/origin/main", git("rev-parse", "HEAD").trim())
    expect(() => git("merge-base", "--is-ancestor", "HEAD", "refs/remotes/origin/main")).not.toThrow()

    // The build is a Bun program (Bun.build + TS entrypoints), so it runs on the repo's bun, the
    // same binary the launcher itself invokes.
    const build = spawnSync("bun", ["scripts/build-cli.ts"], { cwd: fixture, encoding: "utf8" })
    expect(build.stderr).toBe("")
    expect(build.status).toBe(0)
    expect(build.stdout).toContain("suite undeclared on this checkout")

    const receiptPath = join(fixture, "packages/terminfo.dev/dist/terminfo.bundle.receipt.json")
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8")) as {
      probeHash: string
      manifestSha256: unknown
      suiteState: unknown
    }
    expect(receipt.suiteState).toBe("undeclared")
    expect(receipt.manifestSha256).toBeNull()
    expect(receipt.probeHash).toMatch(/^[0-9a-f]{12}$/)

    const gate = spawnSync(
      "bash",
      [
        "-c",
        'source "$1"; require_cli_producer_receipt "$2"',
        "_",
        join(fixture, "scripts/linux-container-run.sh"),
        receiptPath,
      ],
      { encoding: "utf8" },
    )
    expect(gate.status).toBe(2)
    expect(gate.stderr).toContain(`Suite ${receipt.probeHash} is undeclared on this checkout`)
    expect(gate.stderr).not.toContain("Invalid CLI producer receipt")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
