/**
 * @failure Malformed probe input is accepted or skipped, v2 files disappear from inventory, or legacy files without replies are falsely reported as measured DA1 mismatches.
 * @level l2
 * @consumer The content-validation CLI used before site publication.
 * @testonly none
 */
import { spawnSync } from "node:child_process"
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "vitest"

test("validation inventories v2 targets and refuses malformed probe data with its path", () => {
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
    const v2Path = join(root, "content", "probes-libs", "v2-observations.json")
    const v2Probe = { schemaVersion: 2, target: { kind: "headless", id: "libvterm" }, observations: [] }
    // This metadata check does not perform the shared Run parser's schema/admission validation.
    writeFileSync(v2Path, JSON.stringify(v2Probe))

    const script = join(root, "scripts", "validate.ts")
    const baseline = spawnSync(process.execPath, [script], { encoding: "utf8", timeout: 10_000 })
    expect(baseline.error).toBeUndefined()
    expect(baseline.status, baseline.stderr).toBe(0)
    expect(baseline.stdout).toContain("0 errors")
    expect(baseline.stdout).toContain("Legacy annotation coverage: 0/0")
    expect(baseline.stdout).not.toContain('Terminal "libvterm" (libvterm (Neovim fork)) has no probe data files')
    expect(baseline.stdout).toContain("With probe data: 1")
    expect(baseline.stdout).toContain("Without probe data: 23")

    writeFileSync(v2Path, JSON.stringify({ ...v2Probe, target: { kind: "headless", id: "unknown-backend" } }))
    const unknownV2 = spawnSync(process.execPath, [script], { encoding: "utf8", timeout: 10_000 })
    expect(unknownV2.error).toBeUndefined()
    expect(unknownV2.status, unknownV2.stdout + unknownV2.stderr).toBe(1)
    expect(unknownV2.stdout).toContain(
      'Probe file "probes-libs/v2-observations.json" targets undeclared headless:unknown-backend',
    )

    // A legacy run keeps the warning: it carries no explicit target, so its backend name is only a hint.
    writeFileSync(v2Path, JSON.stringify(v2Probe))
    const legacyUnknown = join(root, "content", "probes-libs", "legacy-unknown.json")
    writeFileSync(legacyUnknown, JSON.stringify({ backend: "legacy-unknown", results: {} }))
    const legacyWarn = spawnSync(process.execPath, [script], { encoding: "utf8", timeout: 10_000 })
    expect(legacyWarn.error).toBeUndefined()
    expect(legacyWarn.status, legacyWarn.stdout + legacyWarn.stderr).toBe(0)
    expect(legacyWarn.stdout).toContain('Probe file "probes-libs/legacy-unknown.json" references "legacy-unknown"')
    rmSync(legacyUnknown)

    for (const target of [undefined, { kind: "app", id: "libvterm" }, { kind: "headless", id: " " }]) {
      writeFileSync(v2Path, JSON.stringify({ ...v2Probe, target }))
      const invalidV2 = spawnSync(process.execPath, [script], { encoding: "utf8", timeout: 10_000 })
      expect(invalidV2.error).toBeUndefined()
      expect(invalidV2.status, invalidV2.stdout + invalidV2.stderr).toBe(1)
      expect(invalidV2.stdout).toMatch(/probes-libs\/v2-observations\.json.*target/i)
    }
    writeFileSync(v2Path, JSON.stringify(v2Probe))

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

    const noProfilePath = join(root, "content", "probes-apps", "wezterm-noprofile.json")
    writeFileSync(
      noProfilePath,
      JSON.stringify({
        terminal: "wezterm",
        responses: { "device.primary-da": "\x1b[?62;52;c", "device.xtversion": "WezTerm 20240203" },
        results: { "sgr.bold": true },
      }),
    )
    const noProfile = spawnSync(process.execPath, [script], { encoding: "utf8", timeout: 10_000 })
    expect(noProfile.error).toBeUndefined()
    expect(noProfile.status, noProfile.stdout + noProfile.stderr).toBe(0)
    expect(noProfile.stdout).toMatch(/unchecked|no identity profile/i)
    expect(noProfile.stdout).not.toContain("failed terminal identity check")
    rmSync(noProfilePath)

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

    rmSync(legacyAppPath)
    writeFileSync(
      join(root, "content", "probes-libs", "broken.json"),
      JSON.stringify({ schemaVersion: 3, backend: "xtermjs", results: {} }),
    )
    const unsupportedVersion = spawnSync(process.execPath, [script], { encoding: "utf8", timeout: 10_000 })
    expect(unsupportedVersion.error).toBeUndefined()
    expect(unsupportedVersion.status, unsupportedVersion.stdout + unsupportedVersion.stderr).toBe(1)
    expect(unsupportedVersion.stdout).toContain("probes-libs/broken.json")
    expect(unsupportedVersion.stdout).toContain("unsupported schemaVersion 3")

    rmSync(join(root, "content", "probes-libs", "broken.json"))
    writeFileSync(
      legacyAppPath,
      JSON.stringify({
        terminal: "terminal-app",
        responses: { "device.primary-da": ["\x1b[?1;2c"], "device.secondary-da": "\x1b[>1;95;0c" },
        results: { "sgr.bold": true },
      }),
    )
    const nonStringReply = spawnSync(process.execPath, [script], { encoding: "utf8", timeout: 10_000 })
    expect(nonStringReply.error).toBeUndefined()
    expect(nonStringReply.status, nonStringReply.stdout + nonStringReply.stderr).toBe(1)
    expect(nonStringReply.stdout).toContain("probes-apps/terminal-app-legacy.json")
    expect(nonStringReply.stdout).toContain("identity responses must be string values")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
