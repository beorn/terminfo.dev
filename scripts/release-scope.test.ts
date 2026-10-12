/**
 * @failure Release 1 pages would read as measuring the whole catalog, so an unmeasured feature looks like a pass.
 * @level l2
 * @consumer terminfo.dev front page and every terminal page
 * @source-grep the VitePress pages and the probes.data.ts loader are wired by text, and the browser-bundled release-scope
 *   helper must import no node:fs; only a full site build exercises either at runtime
 * @testonly none
 */
import { readFileSync, mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { describe, expect, it } from "vitest"
import { loadFeatures } from "@terminfo/catalog"
import { loadCategories } from "../docs/data/categories.ts"
import {
  classicCohortIds,
  frozenSuiteIdFor,
  loadFeatureCohort,
  loadReleaseScope,
} from "../docs/data/load-release-scope.ts"
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

  it("derives the 125 classic cohort in the category catalog's order and refuses an empty classics slice", () => {
    const ids = classicCohortIds(catalog, categories)
    expect(ids).toHaveLength(125)
    // The two classic rows that also carry a tier1 field stay in the cohort: the filter is the
    // CATEGORY slice, matching 28018's accepted 125.
    expect(ids).toContain("cursor.position-report")
    expect(ids).toContain("editing.decrqcra")
    // ONE category order: the cohort follows each category's own `order`, the same field the site's
    // category blocks print in, so Erase (order 4) precedes Editing (order 5) and Scrollback (7)
    // precedes Reset (8). The 125-member SET is pinned by SHA in decisive-share.test.ts.
    expect(ids.indexOf("erase.character")).toBeLessThan(ids.indexOf("editing.decrqcra"))
    expect(ids.indexOf("scrollback.accumulate")).toBeLessThan(ids.indexOf("reset.method"))
    const cohort = loadFeatureCohort({ catalog, categories, frozenSuiteId: "abc123abc123" })
    expect(cohort.name).toBe("candidate2")
    expect(cohort.frozenSuiteId).toBe("abc123abc123")
    expect(cohort.measuredIds).toEqual(ids)
    expect(() => classicCohortIds(catalog, { sgr: { slice: "extensions", order: 1 } })).toThrow(
      /classics cohort is empty/,
    )
  })

  it("reads a release's suite from the one manifest that freezes it, refusing none and refusing two", () => {
    expect(frozenSuiteIdFor(contentDir, "candidate2")).toBe("c3d1fbb77561")
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
