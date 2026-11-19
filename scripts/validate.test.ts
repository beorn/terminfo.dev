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

// Copying the live content tree plus THREE validator runs is past the 5s default, and both budgets have
// to clear that cost: ~11 s per full run measured 2026-11-17 on an idle host, ~20 s at load 17 on
// 32 cores. The 60 s outer budget this test used to carry was already under the work: the whole body
// measured 72 s at load 17 (#34896), so it could only pass when the host was idle. Each spawn gets
// 60 s and the outer timeout 240 s, twice the slowest measured body: the budget guards a hang, and the
// assertions below are what actually judge the run.
test("validates retained runs through the canonical decoder and names rejected input", { timeout: 240_000 }, () => {
  const source = join(import.meta.dirname, "..")
  const root = mkdtempSync(join(tmpdir(), "terminfo-validate-"))
  try {
    cpSync(join(source, "content"), join(root, "content"), { recursive: true })
    cpSync(join(source, "scripts"), join(root, "scripts"), { recursive: true })
    for (const name of ["packages", "docs", "node_modules"]) {
      symlinkSync(join(source, name), join(root, name), "dir")
    }
    const script = join(root, "scripts", "validate.ts")
    // bun, as the scripts run (package.json, CI): a Node-launched vitest would hand validate.ts to Node, whose
    // strip-only TypeScript refuses corpus-placement.ts's parameter property (33336).
    // Measured 2026-11-17 on an idle host: the script alone takes 9.7-10.9 s over three runs at two
    // commits, i.e. straight through the old 10 s budget, so this assert failed on host load rather than
    // on a hang. Keep the budget equal to the test timeout above: it guards a hang, and the assertions
    // below are what actually judge the run.
    const run = () => spawnSync("bun", [script], { encoding: "utf8", timeout: 60_000 })
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
    // 35009: a listed artifact removed from content/artifacts is an error that names the run, the ref and the file.
    const listingRun = join(root, "content/probes-apps/alacritty-0.17.0-linux-f504922f67f074794c588cf3a14e2114.json")
    const listedRef = (JSON.parse(readFileSync(listingRun, "utf8")) as { screenshotRefs: string[] }).screenshotRefs[0]
    if (listedRef === undefined) throw new Error("fixture run lists no screenshot")
    const listedFile = join(root, "content/artifacts", `${listedRef.slice("sha256:".length)}.png`)
    const listedBytes = readFileSync(listedFile)
    rmSync(listedFile)
    const missingArtifact = run()
    expect(missingArtifact.status, missingArtifact.stdout + missingArtifact.stderr).toBe(1)
    expect(missingArtifact.stdout).toContain(
      `alacritty-0.17.0-linux-f504922f67f074794c588cf3a14e2114.json lists screenshot ${listedRef}, but content/artifacts/${listedRef.slice("sha256:".length)}.png is missing`,
    )
    writeFileSync(listedFile, listedBytes)
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
