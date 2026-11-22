/**
 * @failure A public page prints a stored unstable version such as `0-unstable-2026-11-08` where a reader expects a
 *   date they can read, instead of "dev snapshot 2026-11-08" (@cpo/term f16a5a52 Q3), at one of the sites that
 *   print a version: the matrix data every page loader reads, the terminal page's version table and source lines,
 *   the compare page, the home tooltip and the evidence cell's label and popover (@cto 97ba8eea D11).
 * @level l2
 * @consumer terminfo.dev pages that print a measured version (probes.data.ts, terminals/[id], compare/[id], index.md,
 *   ResultEvidenceCell.vue); the stored version and the public JSON keep the raw value
 * @source-grep the terminal, compare and home pages and the evidence cell print versions from VitePress <script setup>
 *   blocks and Vue templates, which no unit runner imports; each of those sites is pinned by its source: every
 *   `subject.version` it prints reads through displayVersion, and the loader sites are driven directly.
 * @reach fs-read vendor/terminfo.dev/content/*.json (the real feature catalogue)
 * @testonly none
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"
import { loadFeatures } from "@terminfo/catalog"
import { isEnvironmentGroup } from "@terminfo/probe-defs"
import { aggregateCurrentResults, rollupInputs } from "../docs/data/release-scope.ts"
import { displayVersion, displayVersions } from "../docs/.vitepress/theme/display-version.ts"
import { loadFullProbes } from "../docs/data/probes.data.ts"
import { versionsForBackend } from "../docs/terminals/[id].paths.ts"

const corpus = vi.hoisted(() => ({ published: undefined as unknown }))
vi.mock("../docs/data/current-results.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../docs/data/current-results.ts")>()),
  loadCurrentResults: () => ({ projection: { table: {} } }),
  compatibilitySubjects: () => new Map(),
  joinedAppCells: () => new Map(),
}))
vi.mock("../docs/data/public-results.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../docs/data/public-results.ts")>()),
  publicResults: () => {
    if (!corpus.published) throw new Error("display-version.test: no published fixture was set")
    return corpus.published
  },
}))

const root = join(import.meta.dirname, "..")
const source = (path: string) => readFileSync(join(root, path), "utf8")
const UNSTABLE = "0-unstable-2026-11-08"
const SNAPSHOT = "dev snapshot 2026-11-08"

/** Every `subject.version` read in `text` that is not the argument of displayVersion(...). */
function rawVersionReads(text: string): string[] {
  return [...text.matchAll(/(displayVersion\(\s*)?([\w$.?]*subject\??\.version)\b/g)]
    .filter((match) => match[1] === undefined)
    .map((match) => match[2] ?? "")
}

describe("displayVersion", () => {
  it.each([
    [UNSTABLE, SNAPSHOT],
    ["12-unstable-2025-01-31", "dev snapshot 2025-01-31"],
  ])("reads the stored unstable form %s as %s", (stored, shown) => {
    expect(displayVersion(stored)).toBe(shown)
  })

  it.each([
    "0.17.0",
    "411",
    "1.2.0-unstable",
    "unstable-2026-11-08",
    "0-unstable-2026-11-08-r2",
    "v0-unstable-2026-11-08",
    "",
  ])("returns %j unchanged", (version) => {
    expect(displayVersion(version)).toBe(version)
  })

  it("lists distinct shown versions in first-seen order", () => {
    const runs = [UNSTABLE, "0.17.0", UNSTABLE].map((version) => ({ subject: { version } }))
    expect(displayVersions(runs)).toEqual([SNAPSHOT, "0.17.0"])
  })
})

describe("displayVersion at each call site that prints a version (D11)", () => {
  it("1. probes.data.ts loadFullProbes: backends[].versions, which every page loader's version column reads", () => {
    const catalog = loadFeatures(join(root, "content"))
    const catalogIds = Object.keys(catalog)
    const featureResults = Object.fromEntries(
      catalogIds.map((featureId) => [
        featureId,
        { featureId, status: isEnvironmentGroup(featureId) ? "probe-todo" : "supported" },
      ]),
    )
    const bar = aggregateCurrentResults(rollupInputs("fixture", { featureResults, catalogIds } as never), catalogIds)
    const run = (runId: string, version: string) => ({
      runId,
      subject: { version },
      measuredAt: "2026-11-08T00:00:00Z",
      suiteRelation: "tree",
    })
    const selected = {
      subject: { id: "fixture", kind: "lib", os: null },
      sources: { a: run("a", UNSTABLE), b: run("b", "0.17.0"), c: run("c", UNSTABLE) },
      catalogIds,
      featureResults,
      counts: bar.counts,
      score: { supported: bar.supported, all: bar.denominator },
      derivedIds: [],
      complete: bar.complete,
    }
    corpus.published = {
      selectedByBackend: {
        fixture: { contextKey: "lib:fixture", routeKey: "fixture", os: null, selected, states: {} },
      },
      projection: { contexts: {}, versions: {}, history: {}, contextCount: 1, exclusions: [] },
    }
    const data = loadFullProbes()
    expect(data.backends.map((backend) => backend.versions)).toEqual([[SNAPSHOT, "0.17.0"]])
    // The stored fact is unchanged; only the printed copy is converted.
    expect(selected.sources.a.subject.version).toBe(UNSTABLE)
  })

  it("2. terminals/[id].paths.ts versionsForBackend: the terminal page's version table", () => {
    const subject = { id: "fixture", kind: "lib" }
    const reviewed = (version: string) => ({
      subject: { ...subject, version },
      score: { all: 10, supported: 4 },
      suiteFreshness: "current",
    })
    const data = {
      selectedByBackend: { fixture: { contextKey: "lib:fixture", selected: { subject } } },
      selected: { versions: { "lib:fixture": [reviewed(UNSTABLE), reviewed("0.17.0")] } },
    }
    const versions = versionsForBackend(data as never, "fixture").map((row) => row.version)
    expect(versions.toSorted()).toEqual(["0.17.0", SNAPSHOT])
  })

  it("3. terminals/[id].md: the source-versions line, the run picker label, the OS columns and the original-run list", () => {
    const page = source("docs/terminals/[id].md")
    expect(rawVersionReads(page)).toEqual([])
    expect(page).toContain("displayVersions(runs).join(', ')")
    expect(page).toContain("${displayVersion(run.subject.version)} · ${run.subject.os")
    expect(page).toContain("· {{ displayVersion(run.subject.version) }} · measured")
    // A dev snapshot never reads "vdev snapshot …".
    expect(page).not.toContain("· v{{")
  })

  it("4. compare/[id].paths.ts: each side's source versions", () => {
    const loader = source("docs/compare/[id].paths.ts")
    expect(rawVersionReads(loader)).toEqual([])
    expect(loader).toContain('termAVersion: displayVersions(Object.values(a.selected.sources)).join(", ")')
    expect(loader).toContain('termBVersion: displayVersions(Object.values(b.selected.sources)).join(", ")')
  })

  it("5. compare/[id].md: the original-measurement and original-source lists", () => {
    const page = source("docs/compare/[id].md")
    expect(rawVersionReads(page)).toEqual([])
    expect(page.match(/\{\{ displayVersion\(run\.subject\.version\) \}\}/g)).toHaveLength(3)
  })

  it("6. ResultEvidenceCell.vue accessibleName: the cell's aria-label", () => {
    const cell = source("docs/.vitepress/theme/ResultEvidenceCell.vue")
    expect(cell).toContain('sourceRun.value ? ` ${displayVersion(sourceRun.value.subject.version)}` : ""')
    // The identity key stays raw: it names the stored run, it is not text a reader sees.
    expect(rawVersionReads(cell)).toEqual(["sourceRun.value?.subject.version"])
  })

  it("7. ResultEvidenceCell.vue popover: the compact context line", () => {
    const cell = source("docs/.vitepress/theme/ResultEvidenceCell.vue")
    expect(cell).toContain("· {{ displayVersion(sourceRun.subject.version) }} · {{ sourceRun.subject.os }}")
    expect(cell.match(/\{\{ sourceRun\.subject\.version \}\}/g)).toBeNull()
  })

  it("8. index.md backendTooltip: names who the terminal is, never a source run (#37761 item 10)", () => {
    const home = source("docs/index.md")
    expect(rawVersionReads(home)).toEqual([])
    // The operator: no hashes, suite ids or ISO times in a name's hover; name, platform, one line, website.
    expect(home).not.toContain("source.runId")
    expect(home).not.toContain("source.measuredAt")
  })
})
