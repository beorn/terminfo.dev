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

const WORKTREE_SYNC_FILES = [
  "packages/admin/versions.ts",
  "packages/admin/suite-manifest.ts",
  "packages/terminfo.dev/src/serve.ts",
  "packages/terminfo.dev/src/index.tsx",
  "packages/terminfo.dev/bin/terminfo.mjs",
  "scripts/build-cli.ts",
  "scripts/suite-manifest.ts",
  "scripts/linux-container-run.sh",
]

function createComposedFixture(root: string): { fixture: string; git: (...args: string[]) => string } {
  const fixture = join(root, "composed")
  // REPO_ROOT may itself be a detached checkout (a submodule at a shared-main pin): cloning it
  // then prints git's detached-HEAD advice on stderr, which execFileSync inherits and the Vitest
  // output gate rejects. `advice.detachedHead=false` keeps the clone quiet in both states.
  execFileSync("git", ["-c", "advice.detachedHead=false", "clone", "--shared", "--quiet", REPO_ROOT, fixture], {
    encoding: "utf8",
  })
  const rootNodeModules = join(REPO_ROOT, "..", "..", "node_modules")
  if (existsSync(rootNodeModules)) symlinkSync(rootNodeModules, join(root, "node_modules"))
  symlinkSync(join(REPO_ROOT, "node_modules"), join(fixture, "node_modules"))
  const git = (...args: string[]): string =>
    execFileSync("git", args, { cwd: fixture, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
  git("config", "user.email", "fixture@example.invalid")
  git("config", "user.name", "fixture")
  for (const relativePath of WORKTREE_SYNC_FILES) {
    copyFileSync(join(REPO_ROOT, relativePath), join(fixture, relativePath))
  }
  // A composed probe change moves the suite hash; the manifest for that hash is never committed.
  appendFileSync(join(fixture, "packages/probes/vitest.config.ts"), "\n// composed tree: a suite nobody declared\n")
  git("add", "packages/probes/vitest.config.ts", ...WORKTREE_SYNC_FILES)
  git("commit", "-q", "-m", "fixture: composed probe change")
  git("update-ref", "refs/remotes/origin/main", git("rev-parse", "HEAD").trim())
  expect(() => git("merge-base", "--is-ancestor", "HEAD", "refs/remotes/origin/main")).not.toThrow()
  return { fixture, git }
}

it("refuses dirty collector sources before building a CLI bundle", () => {
  const root = mkdtempSync(join(tmpdir(), "terminfo-dirty-tree-"))
  try {
    const { fixture } = createComposedFixture(root)
    appendFileSync(join(fixture, "packages/probes/vitest.config.ts"), "// uncommitted collector edit\n")
    const build = spawnSync("bun", ["scripts/build-cli.ts"], { cwd: fixture, encoding: "utf8" })
    expect(build.status).not.toBe(0)
    expect(build.stderr).toContain("Cannot bundle an uncommitted CLI collector")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

/**
 * On a composed tree whose HEAD is on origin/main and whose suite has no committed declaration file,
 * the build derives the suite in memory without writing content/suites/<probeHash>.json, emits a
 * live-identity receipt without manifestSha256 or suiteState, and both launchers accept it and
 * verify the bundle's reported suite hash against the receipt.
 */
it("stays green on a composed tree and records the live suite identity that the launchers accept", () => {
  const root = mkdtempSync(join(tmpdir(), "terminfo-composed-tree-"))
  try {
    const { fixture, git } = createComposedFixture(root)
    const headRevision = git("rev-parse", "HEAD").trim()

    const build = spawnSync("bun", ["scripts/build-cli.ts"], { cwd: fixture, encoding: "utf8" })
    expect(build.stderr).toBe("")
    expect(build.status).toBe(0)

    const receiptPath = join(fixture, "packages/terminfo.dev/dist/terminfo.bundle.receipt.json")
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8")) as {
      schemaVersion: number
      probeHash: string
      collectorRevision: string
      bundleSha256: string
      manifestSha256?: unknown
      suiteState?: unknown
    }
    expect(Object.keys(receipt).sort()).toEqual(["bundleSha256", "collectorRevision", "probeHash", "schemaVersion"])
    expect(receipt.schemaVersion).toBe(1)
    expect(receipt.probeHash).toMatch(/^[0-9a-f]{12}$/)
    expect(receipt.collectorRevision).toBe(headRevision)
    expect(receipt.bundleSha256).toMatch(/^[0-9a-f]{64}$/)
    expect(receipt.manifestSha256).toBeUndefined()
    expect(receipt.suiteState).toBeUndefined()

    const launcherBin = join(fixture, "packages/terminfo.dev/bin/terminfo.mjs")
    const hosted = spawnSync(process.execPath, [launcherBin, "--version"], { encoding: "utf8" })
    expect(hosted.stderr).toBe("")
    expect(hosted.status).toBe(0)
    expect(hosted.stdout.trim()).toMatch(new RegExp(`\\(${receipt.probeHash}\\)$`))

    const gate = spawnSync(
      "bash",
      [
        "-c",
        'source "$1"; require_cli_producer_receipt "$2" "$3"',
        "_",
        join(fixture, "scripts/linux-container-run.sh"),
        receiptPath,
        launcherBin,
      ],
      { encoding: "utf8" },
    )
    expect(gate.stderr).toBe("")
    expect(gate.status).toBe(0)
    expect(gate.stdout.trim()).toBe(receipt.probeHash)

    // When the receipt's probeHash disagrees with the bundle's embedded suite, the launcher refuses.
    writeFileSync(receiptPath, `${JSON.stringify({ ...receipt, probeHash: "0".repeat(12) }, null, 2)}\n`)
    const divergedGate = spawnSync(
      "bash",
      [
        "-c",
        'source "$1"; require_cli_producer_receipt "$2" "$3"',
        "_",
        join(fixture, "scripts/linux-container-run.sh"),
        receiptPath,
        launcherBin,
      ],
      { encoding: "utf8" },
    )
    expect(divergedGate.status).toBe(2)
    expect(divergedGate.stderr).toContain(
      `CLI bundle suite ${receipt.probeHash} differs from producer receipt ${"0".repeat(12)}`,
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
