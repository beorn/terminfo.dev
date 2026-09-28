/**
 * @failure An installed CLI silently falls back to absent source files when its compiled suite receipt is missing.
 * @level l1
 * @consumer Published terminfo.dev bin entry
 * @testonly none
 */
import { spawnSync } from "node:child_process"
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs"
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
