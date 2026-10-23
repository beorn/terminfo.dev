/**
 * @failure Release 1 pages would read as measuring the whole catalog, so an unmeasured feature looks like a pass.
 * @level l2
 * @consumer terminfo.dev front page and every terminal page
 * @reach fs-walk vendor/terminfo.dev/docs/** vendor/terminfo.dev/scripts/**
 * @source-grep the VitePress pages and the probes.data.ts loader are wired by text, and the browser-bundled release-scope
 *   helper must import no node:fs; only a full site build exercises either at runtime
 * @reach fs-walk vendor/terminfo.dev/docs/** vendor/terminfo.dev/scripts/**
 * @testonly none
 */
import { readFileSync, mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs"
import { createHash } from "node:crypto"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { describe, expect, it } from "vitest"
import { loadFeatures } from "@terminfo/catalog"
import { parseSuiteManifest } from "@terminfo/run-parser"
import { loadCategories } from "../docs/data/categories.ts"
import { cohortIds, frozenSuiteIdFor, loadFeatureCohort, loadReleaseScope } from "../docs/data/load-release-scope.ts"
import {
  aggregateCells,
  d3Verdict,
  isStaleRelation,
  treeMovedPastRelease,
  staleCaption,
  tier1Included,
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
    // The same exclusion over classics drops exactly the two rows the candidate cohort count treats as
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
    // Independent ratification snapshot, moved here when the decisive-share tool retired (#30759):
    // SHA256 over the sorted 125 IDs, not a prefix census. A swap of one member for another keeps the
    // length and both sample memberships below, so only this pin catches it.
    expect(
      createHash("sha256")
        .update(JSON.stringify([...ids].sort()))
        .digest("hex"),
    ).toBe("1a2012751b148b0230b97e27c74c11868ec36f1b3dd202fb798d42ec8abda17a")
    // The two classic rows that also carry a tier1 field stay in the cohort: the filter is the
    // CATEGORY slice, matching the accepted 125.
    expect(ids).toContain("cursor.position-report")
    expect(ids).toContain("editing.decrqcra")
    // ONE category order: the cohort follows each category's own `order`, the same field the site's
    // category blocks print in, so Erase (order 4) precedes Editing (order 5) and Scrollback (7)
    // precedes Reset (8). The 125-member SET is pinned by SHA above.
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
    // candidate 2 moved 67ad1f1d1580 -> c24025ea22fc on 2026-10-18 through the supported writer (28018),
    // then c24025ea22fc -> f9450b3bc56a on 2026-10-19 when the five Linux contexts were admitted on the
    // suite the pin then built (28023), then f9450b3bc56a -> 448ce7769d2c when the all-platform
    // collection landed (30286), so every ruled context including both Windows rows is measured on the
    // live suite. The suite a move leaves keeps no claim of its own, so the lineage carried on the new
    // record is the only place the older suites are still named.
    const suiteId = frozenSuiteIdFor(contentDir, "candidate2")
    expect(suiteId).toBe("00da53623456")
    const suitePath = join(contentDir, "suites", `${suiteId}.json`)
    expect(
      parseSuiteManifest(suitePath, readFileSync(suitePath, "utf8")).freeze?.previous?.map((entry) => entry.suite),
    ).toContain("c24025ea22fc")
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
  })

  it("names every unmeasured catalog feature as not measured in this release", () => {
    const measured = new Set(scope.measuredIds)
    expect(scope.unmeasured.every((row) => catalog[row.id] && !measured.has(row.id))).toBe(true)
    expect(new Set(scope.unmeasured.map((row) => row.id)).size).toBe(211)
    expect(scope.unmeasured.every((row) => row.status === "not measured in this release")).toBe(true)
    expect(scope.unmeasured.every((row) => row.name.length > 0)).toBe(true)
  })

  it("records a stale measurement as not re-measured since that date", () => {
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
    const states: Record<string, "supported" | "unsupported"> = {}
    for (const row of scope.unmeasured) states[row.id] = "supported"
    const firstMeasured = scope.measuredIds[0]
    if (!firstMeasured) throw new Error("release scope has no measured ids")
    states[firstMeasured] = "unsupported"
    const bar = aggregateCells(states, scope.measuredIds)
    expect(bar.denominator).toBe(62)
    expect(bar.counts.supported).toBe(0)
    expect(bar.counts.unsupported).toBe(1)
    expect(bar.counts.untested).toBe(61)
  })

  it("scores fill percent over the 62 even when every measured cell is untested", () => {
    const bar = aggregateCells({}, scope.measuredIds)
    expect(bar.denominator).toBe(62)
    expect(bar.counts.supported + bar.counts.unsupported).toBe(0)
    expect(bar.counts.untested).toBe(62)
  })

  it("labels the D3 verdict: pass from 90% decisive of the included cohort, with gaps from 70%, fail below", () => {
    // Kept when the decisive-share tool was retired (#30759): the rail itself is a surviving
    // release-scope contract, so its boundaries stay pinned even though no page prints it.
    expect(d3Verdict(52, 52)).toMatchObject({ label: "pass", pct: 100, text: "pass · 52/52" })
    expect(d3Verdict(47, 52)).toMatchObject({ label: "pass", pct: 90, text: "pass · 47/52" })
    expect(d3Verdict(46, 52)).toMatchObject({ label: "with gaps", pct: 88, text: "with gaps · 46/52" })
    expect(d3Verdict(37, 52)).toMatchObject({ label: "with gaps", pct: 71 })
    expect(d3Verdict(36, 52)).toMatchObject({ label: "fail", pct: 69, text: "fail · 36/52" })
    expect(d3Verdict(0, 52).label).toBe("fail")
    // A verdict over zero included capabilities is not "fail" — it is not measured, and it refuses.
    expect(() => d3Verdict(0, 0)).toThrow(/positive denominator/)
    expect(() => d3Verdict(3, 2)).toThrow(/0 <= decisive <= denominator/)
  })

  it("wires current pages to the frozen-catalog execution aggregate and Supported/all formatter", () => {
    const home = readFileSync(join(root, "docs", "index.md"), "utf8")
    const terminal = readFileSync(join(root, "docs", "terminals", "[id].md"), "utf8")
    const loader = readFileSync(join(root, "docs", "data", "probes.data.ts"), "utf8")
    expect(home).toContain("currentCoverageSentence(bar)")
    expect(home).toContain("data.releaseShares[backendName]")
    expect(terminal).toContain("aggregateCurrentResults(selectedRun.value.results, selectedRun.value.catalogIds)")
    expect(terminal).toContain("currentSupportedShare(measuredBar.value)")
    expect(loader).toContain("aggregateCurrentResults(original.results, original.catalogIds)")
    expect(loader).toContain("releaseShares[key] = currentSupportedShare(bar)")
    for (const source of [home, terminal, loader]) {
      expect(source).not.toContain("releaseVerdicts[")
      expect(source).not.toContain("d3Verdict(")
    }
    const helper = readFileSync(join(root, "docs", "data", "release-scope.ts"), "utf8")
    expect(helper).not.toMatch(/from ["']node:fs["']/)
  })
})
