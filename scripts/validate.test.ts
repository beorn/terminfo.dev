/**
 * @failure Content validation accepts a run the canonical decoder rejects, or retains another schema reader.
 * @level l2
 * @consumer Content-validation CLI before the site build.
 * @testonly none
 */
import { spawnSync } from "node:child_process"
import { copyFileSync, cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "vitest"

test("validates retained runs through the canonical decoder and names rejected input", () => {
  const source = join(import.meta.dirname, "..")
  const root = mkdtempSync(join(tmpdir(), "terminfo-validate-"))
  try {
    cpSync(join(source, "content"), join(root, "content"), { recursive: true })
    cpSync(join(source, "scripts"), join(root, "scripts"), { recursive: true })
    for (const name of ["packages", "docs", "node_modules"]) {
      symlinkSync(join(source, name), join(root, name), "dir")
    }
    const script = join(root, "scripts", "validate.ts")
    const run = () => spawnSync(process.execPath, [script], { encoding: "utf8", timeout: 10_000 })
    const baseline = run()
    expect(baseline.error).toBeUndefined()
    expect(baseline.status, baseline.stdout + baseline.stderr).toBe(0)
    expect(baseline.stdout).toContain("0 errors")
    const featuresPath = join(root, "content/features.json")
    const features = readFileSync(featuresPath, "utf8")
    const catalog = JSON.parse(features) as Record<string, unknown>
    delete catalog["input.modify-other-keys"]
    writeFileSync(featuresPath, JSON.stringify(catalog))
    const missingFeature = run()
    expect(missingFeature.status, missingFeature.stdout + missingFeature.stderr).toBe(1)
    expect(missingFeature.stdout + missingFeature.stderr).toContain(
      'Probe definition "input.modify-other-keys" has no features.json catalog row',
    )
    writeFileSync(featuresPath, features)
    const path = join(root, "content/probes-apps/alacritty-0.17.0-linux-f504922f67f074794c588cf3a14e2114.json")
    const raw = JSON.parse(readFileSync(path, "utf8")) as { results: Array<{ status: string }> }
    // Metadata-only inventory previously accepted an invalid stored grade without decoding the run.
    raw.results[0]!.status = "invented-grade"
    writeFileSync(path, JSON.stringify(raw))
    const malformed = run()
    expect(malformed.error).toBeUndefined()
    expect(malformed.status, malformed.stdout + malformed.stderr).toBe(1)
    expect(malformed.stdout + malformed.stderr).toMatch(/alacritty.*invalid probe status/)
    for (const schemaVersion of [undefined, 3, 5]) {
      writeFileSync(path, JSON.stringify({ schemaVersion, terminal: "alacritty", results: {} }))
      const retired = run()
      expect(retired.status, retired.stdout + retired.stderr).toBe(1)
      expect(retired.stdout + retired.stderr).toContain("unsupported schemaVersion")
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
