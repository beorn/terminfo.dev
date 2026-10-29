/**
 * @failure Imported probe definitions can change while the shared suite hash remains unchanged.
 * @level l1
 * @consumer Headless probe cache and selected-run suite identity
 * @testonly none
 * @reach fs-walk vendor/terminfo.dev/content/features.json vendor/terminfo.dev/packages/probe-defs/src/** vendor/terminfo.dev/packages/probes/** vendor/terminfo.dev/packages/terminfo.dev/src/** vendor/terminfo.dev/packages/run-parser/src/** vendor/terminfo.dev/packages/admin/**
 */
import { readFileSync } from "node:fs"
import { dirname, join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import ts from "typescript"
import { expect, test, vi } from "vitest"

const changed = vi.hoisted(() => ({
  file: "",
  extraCatalog: false,
  declaration: "original" as "original" | "null" | "absent",
}))
vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>()
  return {
    ...fs,
    readFileSync(path: string, encoding?: BufferEncoding) {
      if (encoding) return fs.readFileSync(path, encoding)
      const bytes = fs.readFileSync(path)
      if (changed.declaration !== "original" && path.endsWith("packages/probe-defs/src/helpers.ts")) {
        // Snapshot hashes definition bytes verbatim: an explicit null is not an omitted declaration.
        return Buffer.concat([
          bytes,
          Buffer.from(`
const retainedObservableDeclarationFixture = ${changed.declaration === "null" ? "{ termAssertionType: null }" : "{}"}
`),
        ])
      }
      return changed.file && path.endsWith(changed.file) ? Buffer.concat([bytes, Buffer.from("\n// changed")]) : bytes
    },
  }
})

vi.mock("@terminfo/catalog", async (importOriginal) => {
  const original = await importOriginal<typeof import("@terminfo/catalog")>()
  return {
    ...original,
    loadFeatures(contentDir: string) {
      const features = original.loadFeatures(contentDir)
      return changed.extraCatalog ? { ...features, "runtime.unscheduled": features["sgr.bold"] } : features
    },
  }
})

import { loadFeatures } from "@terminfo/catalog"
import { ALL_PROBES } from "@terminfo/probe-defs"
import { derivedSuiteManifest, probeHash, probeSuiteSnapshot } from "./versions.ts"

// #31692: hashing the catalogue did not prove that its non-environment IDs were reachable.
test("every non-environment catalogue ID is reachable by a declared probe selection", () => {
  const snapshot = probeSuiteSnapshot()
  const environment = new Set([
    "device.env-colorterm",
    "device.env-kitty",
    "device.env-lc-terminal",
    "device.env-no-color",
    "device.env-term",
    "device.env-term-program",
    "device.env-vte-version",
    "device.env-wezterm",
    "device.env-wt-session",
  ])
  const reachable = new Set(Object.values(snapshot.probes).flat())
  expect(snapshot.catalogIds.filter((id) => !environment.has(id) && !reachable.has(id))).toEqual([])
  expect(snapshot.probes.lib).toContain("extensions.osc99-kitty-notify")
})

test("suite hash changes when either imported mode or extension definitions change", () => {
  const baseline = probeHash()
  for (const file of ["modes.ts", "extensions.ts"]) {
    changed.file = file
    expect(probeHash()).not.toBe(baseline)
  }
  changed.file = ""
})

test("suite identity changes with executable collection, ownership, capture and identity source", () => {
  const baseline = probeHash()
  for (const file of [
    "packages/probes/collect-headless.ts",
    "packages/probes/headless-batch.ts",
    "packages/probes/headless-identity.ts",
    "packages/admin/versions.ts",
    "packages/admin/src/terminal-app-receipt.ts",
    "packages/terminfo.dev/src/terminal-app-window.ts",
    "packages/terminfo.dev/src/probe-output.ts",
    "packages/terminfo.dev/src/probes/unified.ts",
    "packages/terminfo.dev/src/tty.ts",
    "packages/terminfo.dev/src/linux-clipboard.ts",
    "packages/terminfo.dev/src/owned-terminal.ts",
    "packages/terminfo.dev/src/disposable-receipt.ts",
    "packages/terminfo.dev/src/linux-capture.ts",
    "packages/terminfo.dev/src/capture-core.ts",
    "packages/terminfo.dev/src/darwin-capture.ts",
    "packages/terminfo.dev/src/darwin-terminal-text.ts",
    "packages/terminfo.dev/src/capture-calibration.ts",
    "packages/terminfo.dev/src/linux-input.ts",
    "packages/terminfo.dev/src/serve.ts",
    "packages/terminfo.dev/src/detect.ts",
    "packages/terminfo.dev/src/identity-guard.ts",
    "packages/run-parser/src/index.ts",
    "packages/run-parser/src/app-launch.ts",
    "scripts/release1-collection.ts",
    "packages/terminfo.dev/src/daemon-client.ts",
    "scripts/interpretations.ts",
    "packages/probe-defs/src/helpers.ts",
  ]) {
    changed.file = file
    expect(probeHash(), file).not.toBe(baseline)
  }
  changed.file = ""
  const snapshot = probeSuiteSnapshot()
  expect(snapshot.probes.term).toHaveLength(263)
  expect(snapshot.probes.lib).toHaveLength(252)
  expect(snapshot.probes.mux).toEqual(snapshot.probes.term)
  expect(snapshot.probes.term).toContain("extensions.kitty-keyboard")
  expect(snapshot.probes.term).toContain("input.xtest-key")
  expect(snapshot.probes.term).toEqual([...snapshot.probes.term].sort())
  expect(snapshot.sourcePaths).toContain("packages/terminfo.dev/src/tty.ts")
  expect(snapshot.sourcePaths).toContain("packages/terminfo.dev/src/linux-input.ts")
})

/**
 * 28786: `ADAPTER_SOURCE_PATHS` is a HAND-TYPED list of "the collector's executed local imports", and a
 * hand-typed list silently falls behind (the bead's own bug: disposable-receipt.ts and run-parser omitted,
 * terminal-app-window.ts listed though neither collector entry reaches it). A set whose members can be DERIVED must be checked
 * against its derivation. This walks the static local import closure of both collector entries and asserts
 * the two sets are EQUAL, naming every file on one side only — so a newly reached source fails here until it
 * is hashed, and a listed source nothing runs fails until it is removed.
 */
const COLLECTOR_ENTRIES = ["packages/terminfo.dev/src/serve.ts", "packages/probes/collect-headless.ts"]
const SUITE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..")

/**
 * The static local import closure of the collector entries: repo sources only, tests and node_modules excluded.
 * The scanner is `typescript`'s own `preProcessFile` — a declared devDependency of this package — so it reads the
 * import forms the bundler does, and resolution is `typescript`'s own resolver, which follows each workspace
 * `exports`. Resolution only maps a specifier to a path: no module is loaded, so no second CommonJS instance
 * can appear (the singleton-split class the repo's no-createRequire guard exists to catch).
 */
const MODULE_RESOLUTION: ts.CompilerOptions = {
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  module: ts.ModuleKind.Preserve,
  allowImportingTsExtensions: true,
}

function collectorImportClosure(): { found: string[]; unresolved: string[] } {
  const seen = new Set<string>()
  const unresolved: string[] = []
  const queue = COLLECTOR_ENTRIES.map((entry) => join(SUITE_ROOT, entry))
  while (queue.length > 0) {
    const file = queue.pop()!
    if (seen.has(file)) continue
    seen.add(file)
    const { importedFiles } = ts.preProcessFile(readFileSync(file, "utf8"), true, true)
    for (const { fileName } of importedFiles) {
      if (fileName.startsWith("node:") || fileName.startsWith("bun:") || fileName === "bun") continue
      const { resolvedModule } = ts.resolveModuleName(fileName, file, MODULE_RESOLUTION, ts.sys)
      if (!resolvedModule) {
        unresolved.push(`${relative(SUITE_ROOT, file)} -> ${fileName}: unresolved`)
        continue
      }
      const resolved = resolvedModule.resolvedFileName
      if (resolved.includes("/node_modules/") || !resolved.startsWith(`${join(SUITE_ROOT, "packages")}/`)) continue
      if (/\.(test|spec)\.tsx?$/.test(resolved)) continue
      queue.push(resolved)
    }
  }
  return { found: [...seen].map((file) => relative(SUITE_ROOT, file)).sort(), unresolved }
}

/**
 * probeSuiteSnapshot() also hashes two families it DISCOVERS by scanning a directory (the probe files and the
 * probe-defs sources), plus the probe test config and the adapter package manifest. None is reached by an
 * import, so the closure cannot derive them and both sides of the equality drop them.
 */
const scannedSuiteFamily = (path: string): boolean =>
  path.startsWith("packages/probe-defs/src/") || (path.startsWith("packages/probes/") && path.endsWith(".probe.ts"))
const NOT_IMPORTED_SUITE_INPUTS = new Set(["packages/probes/vitest.config.ts", "packages/terminfo.dev/package.json"])

test("28786: the hashed adapter sources cover the collector import closure and declared finalization stages", () => {
  const { found, unresolved } = collectorImportClosure()
  expect(unresolved, "every first-party import in the closure must resolve").toEqual([])

  const derived = found.filter((path) => !scannedSuiteFamily(path))
  const declared = probeSuiteSnapshot()
    .sourcePaths.filter((path) => !scannedSuiteFamily(path) && !NOT_IMPORTED_SUITE_INPUTS.has(path))
    .sort()

  const missing = derived.filter((path) => !declared.includes(path))
  // The v3 contract additionally hashes dispatch, final-save and review producers outside these
  // two capture entry points. The executable-source mutation case above exercises those stages.
  expect(missing, "every capture import remains hashed alongside the finalization stages").toEqual([])
})

// Presentation-only source does not execute in capture, enrichment or review finalization.
test("28786: presentation-only source does not move the suite hash", () => {
  const baseline = probeHash()
  changed.file = "docs/.vitepress/theme/ResultEvidenceCell.vue"
  expect(probeHash(), "presentation changes cannot rewrite execution suite identity").toBe(baseline)
  changed.file = ""
})

// 30035: the writer must derive claims from explicit app definitions, and never backfill old snapshots.
// Existing suite tests cover membership/hash, not the new trusted declaration relation.
test("text claims derive only from explicitly eligible app definitions and survive the manifest writer", () => {
  const app = ALL_PROBES.find((probe) => probe.term !== null)!
  const headless = ALL_PROBES.find((probe) => probe.id !== app.id)!
  const headlessTerm = headless.term
  const baselineClaims = probeSuiteSnapshot().textClaims ?? []
  const appClaim = app.textClaim
  const headlessClaim = headless.textClaim
  try {
    app.textClaim = "characters"
    headless.term = null
    headless.textClaim = "characters"
    const snapshot = probeSuiteSnapshot()
    const expected = [...new Set([...baselineClaims.filter((id) => id !== headless.id), app.id])].sort()
    expect(snapshot.textClaims).toEqual(expected)
    expect(snapshot.textClaims).not.toContain(headless.id)
    expect(derivedSuiteManifest(snapshot)).toMatchObject({
      textClaims: expected,
      textQualification: { version: 1, recipe: "macos-text-cells-v1" },
    })
    const { textClaims: _claims, textQualification: _spec, ...old } = snapshot
    expect(derivedSuiteManifest(old)).not.toHaveProperty("textClaims")
    expect(derivedSuiteManifest(old)).not.toHaveProperty("textQualification")
  } finally {
    headless.term = headlessTerm
    if (appClaim === undefined) delete app.textClaim
    else app.textClaim = appClaim
    if (headlessClaim === undefined) delete headless.textClaim
    else headless.textClaim = headlessClaim
  }
})

// 30035 AC2/AC4: real suite declarations must retain the reviewed character-only boundary.
// Synthetic forwarding tests cannot detect an unmarked or blanket-promoted production definition.
test("the trusted manifest declares exactly the 37 reviewed character claims without expanding capabilities", () => {
  const manifest = derivedSuiteManifest()
  expect(manifest.textClaims).toEqual([
    "charsets.dec-line-drawing",
    "charsets.dec-special",
    "charsets.g0-g1-switching",
    "cursor.cup-scroll-region",
    "editing.deccra",
    "editing.decdc",
    "editing.decera",
    "editing.decfra",
    "editing.decic",
    "editing.decsera",
    "editing.delete-chars",
    "editing.delete-lines",
    "editing.insert-chars",
    "editing.insert-lines",
    "editing.repeat-char",
    "editing.sl",
    "editing.sr",
    "erase.character",
    "erase.ed-scroll-region",
    "erase.line.all",
    "erase.line.left",
    "erase.line.right",
    "erase.screen.above",
    "erase.screen.all",
    "erase.screen.below",
    "erase.selective",
    "modes.origin",
    "reset.decaln",
    "scrollback.alt-screen",
    "scrollback.decstbm",
    "scrollback.decstbm-reset",
    "scrollback.reverse-index",
    "scrollback.scroll-down",
    "scrollback.scroll-up",
    "scrollback.set-region",
    "text.overwrite",
    "text.reverse-index-scroll",
  ])
  for (const id of ["charsets.utf8", "editing.deccara", "editing.decrara", "erase.el-with-attrs"]) {
    expect(manifest.textClaims).not.toContain(id)
    expect(ALL_PROBES.find((probe) => probe.id === id)?.textClaim).toBeUndefined()
  }
  expect(Object.keys(loadFeatures(join(SUITE_ROOT, "content")))).toHaveLength(273)
  expect(manifest.probes.term).toHaveLength(263)
  expect(manifest.probes.lib).toHaveLength(252)
})

// Fixed denominator/frozen membership: callback-only schedule hash coverage misses new
// catalogue-only IDs, which must become explicit TODO and change executable suite identity.
test("freezes all catalogue IDs and changes suite identity for unscheduled additions", () => {
  const original = probeSuiteSnapshot()
  expect(original.catalogIds).toHaveLength(273)
  expect(original.catalogIds).toContain("device.env-term")
  expect(original.probes.term).not.toContain("device.env-term")
  try {
    changed.extraCatalog = true
    const expanded = probeSuiteSnapshot()
    expect(expanded.catalogIds).toContain("runtime.unscheduled")
    expect(expanded.probeHash).not.toBe(original.probeHash)
    expect(expanded.probes).toEqual(original.probes)
    expect(derivedSuiteManifest(expanded).catalogIds).toEqual(expanded.catalogIds)
    expect(original.catalogIds).not.toContain("runtime.unscheduled")
  } finally {
    changed.extraCatalog = false
  }
})

// Nullable declarations preserve partial versus undeclared; their source identities must stay distinct.
test("suite hashing distinguishes an explicit null declaration from absence", () => {
  try {
    changed.declaration = "null"
    const explicitNull = probeSuiteSnapshot()
    changed.declaration = "absent"
    expect(probeSuiteSnapshot().probeHash).not.toBe(explicitNull.probeHash)
  } finally {
    changed.declaration = "original"
  }
})
