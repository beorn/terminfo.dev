/**
 * @failure Release 1 pages would read as measuring the whole catalog, so an unmeasured feature looks like a pass.
 * @level l2
 * @consumer terminfo.dev front page and every terminal page
 * @reach fs-walk vendor/terminfo.dev/docs/ vendor/terminfo.dev/scripts/
 * @source-grep the VitePress pages and the probes.data.ts loader are wired by text, and the browser-bundled release-scope
 *   helper must import no node:fs; only a full site build exercises either at runtime
 * @reach fs-walk vendor/terminfo.dev/docs/** vendor/terminfo.dev/scripts/**
 * @testonly none
 */
import { readFileSync, readdirSync, mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs"
import { join, relative } from "node:path"
import { tmpdir } from "node:os"
import { describe, expect, it } from "vitest"
import { loadFeatures } from "@terminfo/catalog"
import { loadCategories } from "../docs/data/categories.ts"
import { cohortIds, frozenSuiteIdFor, loadFeatureCohort, loadReleaseScope } from "../docs/data/load-release-scope.ts"
import {
  aggregateCells,
  classifyCells,
  coverageSentence,
  supportedShare,
  isStaleRelation,
  treeMovedPastRelease,
  staleCaption,
  tier1Included,
  tierLine,
} from "../docs/data/release-scope.ts"

/**
 * Every non-test TypeScript or Markdown source under one directory, so a VitePress page's `<script
 * setup>` is read exactly like a module. Build caches and node_modules are skipped.
 */
function readSourceFiles(dir: string): Array<{ path: string; text: string }> {
  const out: Array<{ path: string; text: string }> = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "cache" || entry.name === "dist") continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...readSourceFiles(path))
      continue
    }
    if (!/\.(ts|tsx|md)$/.test(entry.name) || entry.name.includes(".test.")) continue
    out.push({ path: relative(root, path), text: readFileSync(path, "utf8") })
  }
  return out
}

/** The one line a match sits on, for reading a function's own definition out of a call list. */
function lineAt(text: string, index: number): string {
  const end = text.indexOf("\n", index)
  return text.slice(text.lastIndexOf("\n", index) + 1, end === -1 ? undefined : end)
}

/** The named function a match sits inside: the nearest preceding `function` declaration. */
function enclosingFunction(text: string, index: number): string {
  const declared = [...text.slice(0, index).matchAll(/^(?:export )?(?:async )?function (\w+)/gm)]
  const last = declared.at(-1)
  return last?.[1] ?? "(module scope)"
}

const root = join(import.meta.dirname, "..")

const contentDir = join(root, "content")
const catalog = loadFeatures(contentDir)
const categories = loadCategories(contentDir)

/** Write one suite manifest from a freeze pointer, for the registry tests below. */
function writeSuite(dir: string, probeHash: string, freeze?: { release: string; at: string }): void {
  writeFileSync(
    join(dir, `${probeHash}.json`),
    JSON.stringify({
      probeHash,
      adapterVersion: "4.0.0",
      ...(freeze === undefined ? {} : { freeze }),
      probes: { app: [], headless: [], mux: [] },
    }),
  )
}

describe("the derived scope, the classic cohort and the suite pointer", () => {
  it("derives the declared 62 tier-1 rows from the catalog's tier1 labels, never a scope file", () => {
    const scope = loadReleaseScope({ catalog, categories })
    expect(scope.measuredCount).toBe(62)
    expect(scope.measuredIds).toEqual([...scope.measuredIds].sort())
    expect(tier1Included(catalog, scope.measuredIds)).toHaveLength(52)
    expect(scope.measuredIds).toContain("device.primary-da")
    expect(tier1Included(catalog, scope.measuredIds)).not.toContain("extensions.osc777-notify")
  })

  it("derives candidate 4 as the extensions and input slices, 44 ids, and refuses an unknown slice", () => {
    // Candidate 4 is the tier it ADDS: every extensions and input row that is not already tier 1
    // (extensions holds 79 rows, 45 labelled tier 1; input holds 11, 1 labelled tier 1).
    const extensions = cohortIds(catalog, categories, ["extensions"], { excludingTier1: true })
    const input = cohortIds(catalog, categories, ["input"], { excludingTier1: true })
    expect(extensions).toHaveLength(34)
    expect(input).toHaveLength(10)
    expect(cohortIds(catalog, categories, ["extensions"], { excludingTier1: false })).toHaveLength(79)
    expect(cohortIds(catalog, categories, ["input"], { excludingTier1: false })).toHaveLength(11)
    const ids = cohortIds(catalog, categories, ["extensions", "input"], { excludingTier1: true })
    expect(ids).toHaveLength(44)
    expect(new Set(ids).size).toBe(44)
    // One order: the category catalog opens with extensions and closes with input, and the cohort
    // follows that order rather than any per-call grouping.
    expect(ids.slice(0, extensions.length)).toEqual(extensions)
    expect(ids.slice(extensions.length)).toEqual(input)
    // A requested slice no category carries refuses and NAMES it.
    expect(() => cohortIds(catalog, categories, ["nonesuch" as never], { excludingTier1: false })).toThrow(
      /asks for slice nonesuch, which no category carries/,
    )
    // The same exclusion over classics drops exactly the two rows the candidate-2 count treats as
    // not new (125 catalog rows, 123 new), so the option is the tier filter and nothing else.
    expect(cohortIds(catalog, categories, ["classics"], { excludingTier1: true })).toHaveLength(123)
  })

  it("refuses an unknown slice by name even when mixed with a valid slice", () => {
    // Silently dropping the unknown member would answer with the valid slice's 125 rows instead of
    // refusing the mistyped request.
    expect(() => cohortIds(catalog, categories, ["classics", "nonesuch" as never], { excludingTier1: false })).toThrow(
      /asks for slice nonesuch, which no category carries/,
    )
  })

  it("refuses a cohort request that names no slices", () => {
    expect(() => cohortIds(catalog, categories, [], { excludingTier1: false })).toThrow(
      /asks for no slices; name at least one/,
    )
  })

  it("refuses an empty cohort and blames tier-1 exclusion only when rows were actually dropped", () => {
    const allTier1: Record<string, { slice: "tier1"; order: number }> = {
      sgr: { slice: "tier1", order: 1 },
    }
    expect(() => cohortIds(catalog, allTier1, ["tier1"], { excludingTier1: true })).toThrow(
      /already tier 1, so the exclusion leaves nothing/,
    )
    // When the category itself carries zero catalog rows, even with excludingTier1 enabled, the
    // refusal blames the empty categories rather than claiming rows were already tier 1.
    expect(() =>
      cohortIds(catalog, { ghosts: { slice: "classics", order: 1 } }, ["classics"], {
        excludingTier1: true,
      }),
    ).toThrow(/cohort is empty: the categories for slices classics carry no rows/)
  })

  it("derives the 125 classic cohort in the category catalog's order and refuses an empty classics slice", () => {
    const ids = cohortIds(catalog, categories, ["classics"], { excludingTier1: false })
    expect(ids).toHaveLength(125)
    // The two classic rows that also carry a tier1 field stay in the cohort: the filter is the
    // CATEGORY slice, matching the accepted 125.
    expect(ids).toContain("cursor.position-report")
    expect(ids).toContain("editing.decrqcra")
    // ONE category order: the cohort follows each category's own `order`, the same field the site's
    // category blocks print in, so Erase (order 4) precedes Editing (order 5) and Scrollback (7)
    // precedes Reset (8). The 125-member SET is pinned by SHA in decisive-share.test.ts.
    expect(ids.indexOf("erase.character")).toBeLessThan(ids.indexOf("editing.decrqcra"))
    expect(ids.indexOf("scrollback.accumulate")).toBeLessThan(ids.indexOf("reset.method"))
    const cohort = loadFeatureCohort({
      catalog,
      categories,
      name: "candidate2",
      slices: ["classics"],
      excludingTier1: false,
      frozenSuiteId: "abc123abc123",
    })
    expect(cohort.name).toBe("candidate2")
    expect(cohort.frozenSuiteId).toBe("abc123abc123")
    expect(cohort.measuredIds).toEqual(ids)
    // A slice the category map carries but no catalog row populates is an EMPTY cohort, a different
    // refusal from an unknown slice; it names the requested slices whose categories carry no rows.
    expect(() =>
      cohortIds(catalog, { ghosts: { slice: "classics", order: 1 } }, ["classics"], {
        excludingTier1: false,
      }),
    ).toThrow(/cohort is empty: the categories for slices classics carry no rows/)
  })

  it("reads a release's suite from the one manifest that freezes it, refusing none and refusing two", () => {
    expect(frozenSuiteIdFor(contentDir, "candidate2")).toBe("67ad1f1d1580")
    // Candidate 4 keeps its own freeze, a different declaration from candidate 2's, while its COHORT
    // reads candidate 2's suite (@chief convergence ruling, 2026-10-18). The registry lookup and the
    // cohort spec answer two separate questions and must not be conflated.
    expect(frozenSuiteIdFor(contentDir, "candidate4")).toBe("4f6fcc8c3ff7")
    const dir = mkdtempSync(join(tmpdir(), "suite-registry-"))
    try {
      mkdirSync(join(dir, "suites"))
      const at = "2026-10-12T03:33:42.000Z"
      writeSuite(join(dir, "suites"), "aaaa00000000", { release: "candidate2", at })
      expect(frozenSuiteIdFor(dir, "candidate2")).toBe("aaaa00000000")
      expect(() => frozenSuiteIdFor(dir, "candidate9")).toThrow(
        /no suite manifest declares freeze.release "candidate9"/,
      )
      writeSuite(join(dir, "suites"), "bbbb11111111", { release: "candidate2", at })
      expect(() => frozenSuiteIdFor(dir, "candidate2")).toThrow(/2 suite manifests claim release "candidate2"/)
      expect(() => frozenSuiteIdFor(join(dir, "absent"), "candidate2")).toThrow(/the suite registry is required/)
    } finally {
      rmSync(dir, { recursive: true })
    }
  })
})

describe("release 1 measurement scope", () => {
  const scope = loadReleaseScope({ catalog, categories })

  it("declares 62 of 273 features as tier 1 query/reply", () => {
    expect(scope.catalogCount).toBe(273)
    expect(scope.measuredCount).toBe(62)
    expect(scope.unmeasured).toHaveLength(211)
    expect(scope.tier).toBe(1)
    expect(scope.method).toBe("query/reply")
    expect(tierLine(scope)).toBe("62 of 273 features (tier 1), measured per terminal; next tiers in progress")
  })

  it("names every unmeasured catalog feature as not measured in this release", () => {
    const measured = new Set(scope.measuredIds)
    expect(scope.unmeasured.every((row) => catalog[row.id] && !measured.has(row.id))).toBe(true)
    expect(new Set(scope.unmeasured.map((row) => row.id)).size).toBe(211)
    expect(scope.unmeasured.every((row) => row.status === "not measured in this release")).toBe(true)
    expect(scope.unmeasured.every((row) => row.name.length > 0)).toBe(true)
  })

  it("dates the tier line and records a stale measurement as not re-measured since that date", () => {
    expect(tierLine(scope, { measuredAt: "2026-10-04T17:46:58Z" })).toBe(
      "62 of 273 features (tier 1), measured per terminal; next tiers in progress · measured October 4, 2026",
    )
    expect(staleCaption("2026-10-04T17:46:58Z")).toBe("not re-measured since October 4, 2026")
    expect(isStaleRelation("release")).toBe(false)
    expect(isStaleRelation("tree")).toBe(false)
    expect(isStaleRelation("older")).toBe(true)
    expect(isStaleRelation("partial")).toBe(true)
    // One banner only when the live tree has actually moved past the release suite.
    expect(treeMovedPastRelease("21739d9e768f", "a8bafe49cdd4")).toBe(true)
    expect(treeMovedPastRelease("a8bafe49cdd4", "a8bafe49cdd4")).toBe(false)
    expect(treeMovedPastRelease("a8bafe49cdd4", null)).toBe(false)
  })

  it("does not let supported outcomes outside the 62 fill the bar", () => {
    const cells: Record<string, { outcome: "supported" | "unsupported"; conclusive: boolean }> = {}
    for (const row of scope.unmeasured) cells[row.id] = { outcome: "supported", conclusive: true }
    const firstMeasured = scope.measuredIds[0]
    if (!firstMeasured) throw new Error("release scope has no measured ids")
    cells[firstMeasured] = { outcome: "unsupported", conclusive: true }
    const bar = aggregateCells(classifyCells(cells), scope.measuredIds)
    expect(bar.denominator).toBe(62)
    expect(bar.counts.supported).toBe(0)
    expect(bar.counts.unsupported).toBe(1)
    expect(supportedShare(bar)).toBe("0% supported of 62")
    expect(bar.counts.untested).toBe(61)
  })

  it("scores fill percent over the 62 even when every measured cell is untested", () => {
    const bar = aggregateCells({}, scope.measuredIds)
    expect(bar.denominator).toBe(62)
    expect(bar.counts.supported + bar.counts.unsupported).toBe(0)
    expect(supportedShare(bar)).toBe("0% supported of 62")
    expect(bar.counts.untested).toBe(62)
  })

  it("names each row's SUPPORTED share over the 62, never as the decisive share", () => {
    const firstMeasured = scope.measuredIds[0]
    if (!firstMeasured) throw new Error("release scope has no measured ids")
    const oneSupported = aggregateCells(
      classifyCells({ [firstMeasured]: { outcome: "supported", conclusive: true } }),
      scope.measuredIds,
    )
    // 1/62 rounds to 2%: the label reads the SUPPORTED share of the 62, never the decisive share.
    expect(supportedShare(oneSupported)).toBe("2% supported of 62")
    expect(supportedShare(aggregateCells({}, scope.measuredIds))).toBe("0% supported of 62")
    expect(supportedShare({ ...oneSupported, denominator: 0 })).toBe("No selected run")
  })

  it("names coverage over the 62 so unmeasured catalog features are not inconclusive", () => {
    const cells: Record<string, { outcome: "supported" | "inconclusive"; conclusive?: boolean }> = {}
    for (const row of scope.unmeasured) cells[row.id] = { outcome: "inconclusive" }
    const firstMeasured = scope.measuredIds[0]
    if (!firstMeasured) throw new Error("release scope has no measured ids")
    cells[firstMeasured] = { outcome: "supported", conclusive: true }
    const bar = aggregateCells(classifyCells(cells), scope.measuredIds)
    expect(coverageSentence(bar)).toBe("1 supported · 0 unsupported · 0 inconclusive · 0 errors · 61 untested")
    expect(coverageSentence(aggregateCells({}, scope.measuredIds))).toBe(
      "0 supported · 0 unsupported · 0 inconclusive · 0 errors · 62 untested",
    )
  })

  it("prints the D3 verdict beside the label on the front page, every terminal page and the loader", () => {
    const home = readFileSync(join(root, "docs", "index.md"), "utf8")
    const terminal = readFileSync(join(root, "docs", "terminals", "[id].md"), "utf8")
    const loader = readFileSync(join(root, "docs", "data", "probes.data.ts"), "utf8")
    expect(home).toContain("data.releaseVerdicts[backendName]")
    expect(home).toContain("verdict.text")
    expect(terminal).toContain("barVerdict(aggregateCells(")
    expect(terminal).toContain("tier1Included(data.featureDescriptions, data.releaseScope.scoredIds)")
    expect(terminal).toContain("measuredVerdict.text")
    expect(loader).toContain("tier1Included(featureDescriptions, release.scoredIds)")
    expect(loader).toContain("releaseVerdicts[key] = d3Verdict(")
  })

  it("puts the tier line on the front page and every terminal page", () => {
    const home = readFileSync(join(root, "docs", "index.md"), "utf8")
    const terminal = readFileSync(join(root, "docs", "terminals", "[id].md"), "utf8")
    for (const source of [home, terminal]) {
      expect(source).toContain("data.releaseScope.line")
      expect(source).toContain("not measured in this release")
    }
    expect(terminal).toContain("staleCaption")
    expect(terminal).toContain("aggregateCells")
    expect(home).toContain("coverageSentence")
    // The label is one owner: the loader computes it with supportedShare, the page only prints it.
    expect(home).toContain("data.releaseShares[backendName]")
    expect(home).not.toMatch(/function coverageLabel[\s\S]*selected\.counts/)
    expect(terminal).toContain("measuredShare")
    expect(terminal).toContain("supportedShare(")
    // One word, one number: the D3 verdict owns "decisive"; the bar's fill is "supported".
    expect(terminal).not.toContain("% decisive of")
    expect(home).not.toContain("decisive of ${bar.denominator}")
    expect(terminal).toContain("measuredBar.counts.supported")
    expect(terminal).toContain("measuredBar.counts.inconclusive")
    expect(terminal).toContain("measuredBar.counts.untested")
    const loader = readFileSync(join(root, "docs", "data", "probes.data.ts"), "utf8")
    expect(loader).toContain("isStaleRelation")
    expect(loader).toContain("staleCaption")
    expect(loader).toContain("releaseStale")
    expect(loader).toContain("releaseShares[key] = supportedShare(")
    const helper = readFileSync(join(root, "docs", "data", "release-scope.ts"), "utf8")
    expect(helper).not.toMatch(/from ["']node:fs["']/)
  })

  it("keeps the ONE classifier inside the projection and its development entry", () => {
    // Every source the site builds or the CLI runs, tests excluded. A page or a script that classified
    // raw cells itself would be a second copy of the five-way chain, which is what item 1 removes
    // (28792 item 1, @cto 2026-10-12 must-fix).
    const sources = [...readSourceFiles(join(root, "docs")), ...readSourceFiles(join(root, "scripts"))]
    const callSites = (name: string) =>
      sources.flatMap((file) =>
        [...file.text.matchAll(new RegExp(`\\b${name}\\(`, "g"))].flatMap((match) =>
          lineAt(file.text, match.index).includes(`function ${name}(`)
            ? []
            : [{ file: file.path, caller: enclosingFunction(file.text, match.index) }],
        ),
      )
    expect(callSites("classifyCell")).toEqual([
      { file: join("docs", "data", "release-scope.ts"), caller: "classifyCells" },
    ])
    expect(callSites("classifyCells")).toEqual([
      // CTO 716686ae authorizes the development entry beside projectRun; no page/script classifies raw cells.
      { file: join("docs", "data", "selected-results.ts"), caller: "classifyDevelopmentRun" },
      { file: join("docs", "data", "selected-results.ts"), caller: "projectResults" },
    ])
  })

  it("names the 211 unmeasured features on every terminal page, including pages with no selected run", () => {
    const terminal = readFileSync(join(root, "docs", "terminals", "[id].md"), "utf8")
    const unmeasuredStart = terminal.indexOf('class="unmeasured"')
    const scoreCardStart = terminal.indexOf('v-if="!isHistorical && selectedRun"')
    expect(unmeasuredStart).toBeGreaterThan(-1)
    expect(scoreCardStart).toBeGreaterThan(-1)
    expect(unmeasuredStart).toBeLessThan(scoreCardStart)
    expect(terminal).toContain("data.releaseScope.unmeasured")
  })
})
