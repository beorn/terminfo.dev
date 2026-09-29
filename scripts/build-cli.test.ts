/**
 * @failure An installed CLI silently falls back to absent source files when its compiled suite receipt is missing.
 * @level l1
 * @consumer Published terminfo.dev bin entry
 * @testonly none
 */
import { spawnSync } from "node:child_process"
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, it } from "vitest"

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
