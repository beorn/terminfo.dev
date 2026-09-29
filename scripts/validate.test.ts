/**
 * @failure Malformed probe JSON is skipped, while legacy files without replies are falsely reported as measured DA1 mismatches.
 * @level l2
 * @consumer The content-validation CLI used before site publication.
 * @testonly none
 */
import { spawnSync } from "node:child_process"
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "vitest"

test("validation refuses malformed library probe data with its path", () => {
  const source = join(import.meta.dirname, "..")
  const root = mkdtempSync(join(tmpdir(), "terminfo-validate-"))
  try {
    mkdirSync(join(root, "scripts"))
    copyFileSync(join(source, "scripts", "validate.ts"), join(root, "scripts", "validate.ts"))
    symlinkSync(join(source, "packages"), join(root, "packages"), "dir")
    for (const dir of ["probes-apps", "probes-libs", "probes-mux"]) {
      mkdirSync(join(root, "content", dir), { recursive: true })
    }
    for (const name of ["features", "standards", "categories", "terminals", "platforms", "annotations", "baselines"]) {
      copyFileSync(join(source, "content", `${name}.json`), join(root, "content", `${name}.json`))
    }
    writeFileSync(
      join(root, "content", "probes-libs", "v2-observations.json"),
      // This syntax check does not perform the shared Run parser's schema/admission validation.
      JSON.stringify({ schemaVersion: 2, observations: [] }),
    )

    const script = join(root, "scripts", "validate.ts")
    const baseline = spawnSync(process.execPath, [script], { encoding: "utf8", timeout: 10_000 })
    expect(baseline.error).toBeUndefined()
    expect(baseline.status, baseline.stderr).toBe(0)
    expect(baseline.stdout).toContain("0 errors")
    expect(baseline.stdout).toContain("Legacy annotation coverage: 0/0")

    writeFileSync(join(root, "content", "probes-libs", "broken.json"), "{")
    const corrupt = spawnSync(process.execPath, [script], { encoding: "utf8", timeout: 10_000 })
    expect(corrupt.error).toBeUndefined()
    expect(corrupt.status, corrupt.stdout + corrupt.stderr).toBe(1)
    expect(corrupt.stdout + corrupt.stderr).toMatch(/probes-libs\/broken\.json.*(?:parse|JSON|Unexpected)/i)

    writeFileSync(join(root, "content", "probes-libs", "broken.json"), JSON.stringify({ backend: "xtermjs" }))
    const missingLegacyResults = spawnSync(process.execPath, [script], { encoding: "utf8", timeout: 10_000 })
    expect(missingLegacyResults.error).toBeUndefined()
    expect(missingLegacyResults.status, missingLegacyResults.stdout + missingLegacyResults.stderr).toBe(1)
    expect(missingLegacyResults.stdout + missingLegacyResults.stderr).toContain(
      'Probe file "probes-libs/broken.json" could not be parsed: legacy probe results must be a JSON object',
    )

    rmSync(join(root, "content", "probes-libs", "broken.json"))
    const legacyAppPath = join(root, "content", "probes-apps", "terminal-app-legacy.json")
    writeFileSync(legacyAppPath, JSON.stringify({ terminal: "terminal-app", results: { "sgr.bold": true } }))
    const unverified = spawnSync(process.execPath, [script], { encoding: "utf8", timeout: 10_000 })
    expect(unverified.error).toBeUndefined()
    expect(unverified.status, unverified.stdout + unverified.stderr).toBe(0)
    expect(unverified.stdout).toContain("probes-apps/terminal-app-legacy.json")
    expect(unverified.stdout).toMatch(/unverified|unchecked/i)
    expect(unverified.stdout).not.toContain("DA1 mismatch")

    writeFileSync(
      legacyAppPath,
      JSON.stringify({
        terminal: "terminal-app",
        responses: { "device.primary-da": "\x1b[?62c" },
        results: { "sgr.bold": true },
      }),
    )
    const wrongReply = spawnSync(process.execPath, [script], { encoding: "utf8", timeout: 10_000 })
    expect(wrongReply.error).toBeUndefined()
    expect(wrongReply.status, wrongReply.stdout + wrongReply.stderr).toBe(1)
    expect(wrongReply.stdout).toContain("probes-apps/terminal-app-legacy.json")
    expect(wrongReply.stdout).toContain("DA1 mismatch")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
