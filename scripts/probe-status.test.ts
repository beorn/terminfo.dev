/**
 * @failure Syncing callback presence erased reviewed partial probe status and reported counts from callbacks instead of saved metadata.
 * @level l1
 * @consumer The probe-status CLI and curated feature metadata.
 * @testonly none
 */
import { spawnSync } from "node:child_process"
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "vitest"

function withSyncFixture(run: (fixtureRoot: string, script: string, featurePath: string) => void) {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "terminfo-probe-status-"))
  try {
    const scriptsDir = join(fixtureRoot, "scripts")
    const contentDir = join(fixtureRoot, "content")
    mkdirSync(scriptsDir)
    mkdirSync(contentDir)
    const script = join(scriptsDir, "sync-probe-status.ts")
    copyFileSync(join(import.meta.dirname, "sync-probe-status.ts"), script)
    symlinkSync(join(import.meta.dirname, "..", "packages"), join(fixtureRoot, "packages"), "dir")
    symlinkSync(join(import.meta.dirname, "..", "node_modules"), join(fixtureRoot, "node_modules"), "dir")
    run(fixtureRoot, script, join(contentDir, "features.json"))
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true })
  }
}

test("sync preserves reviewed statuses and counts the resulting metadata", () => {
  withSyncFixture((fixtureRoot, script, featurePath) => {
    const features = {
      "extensions.osc0-icon-title": { probeStatus: "partial", name: "Icon and title", probe: "reviewed partial" },
      "input.modify-other-keys": { probeStatus: "manual", name: "Modified keys", probe: "manual event capture" },
      "extensions.reflow": { probeStatus: "unprobed", name: "Resize reflow", probe: "needs controlled resize" },
      "extensions.osc8": { probeStatus: "automated", name: "OSC 8", probe: "automated metadata" },
      "extensions.osc22-pointer": { name: "Pointer shape", probe: "no headless callback" },
    }
    writeFileSync(featurePath, JSON.stringify(features, null, 2) + "\n")

    const result = spawnSync(process.execPath, [script], { cwd: fixtureRoot, encoding: "utf8", timeout: 10_000 })
    expect(result.error).toBeUndefined()
    expect(result.status, result.stderr).toBe(0)
    const saved = JSON.parse(readFileSync(featurePath, "utf8"))
    expect(saved).toEqual({
      ...features,
      "extensions.osc8": { name: "OSC 8", probe: "automated metadata" },
      "extensions.osc22-pointer": { name: "Pointer shape", probe: "no headless callback", probeStatus: "partial" },
    })
    const output = result.stdout.replace(/\x1b\[[\d;]*m/g, "")
    expect(output).toContain("Final: 1 automated, 2 partial, 1 manual, 1 unprobed (of 5 with probes)")
  })
})

// Malformed catalogs must fail at the CLI boundary, before success or a write.
test.each(["[]", "null", "42", '"text"', '{"extensions.osc8":null}', '{"extensions.osc8":[]}', "{"])(
  "sync rejects invalid feature metadata without changing it: %s",
  (source) => {
    withSyncFixture((fixtureRoot, script, featurePath) => {
      writeFileSync(featurePath, source)
      const result = spawnSync(process.execPath, [script], { cwd: fixtureRoot, encoding: "utf8", timeout: 10_000 })
      expect(result.error).toBeUndefined()
      expect(result.status).toBe(1)
      expect(result.stderr).toContain(featurePath)
      expect(result.stdout).not.toContain("No changes needed")
      expect(readFileSync(featurePath, "utf8")).toBe(source)
    })
  },
)
