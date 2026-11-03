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
import { readFileSync, mkdtempSync, rmSync } from "node:fs"
import { createHash } from "node:crypto"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { loadFeatures, type FeatureCatalog, type Slice } from "@terminfo/catalog"
import {
  ENVIRONMENT_GROUP_IDS,
  SOURCE_ANSWERS,
  gradedFeatureIds,
  sourceAnswerKey,
  sourceAnswerVersionLabel,
  type ProbeResult,
  type ProbeStatus,
} from "@terminfo/probe-defs"
import { loadStoredRuns } from "../packages/admin/corpus-placement.ts"
import { loadCategories, orderedCategoryIds } from "../docs/data/categories.ts"
import {
  PROBE_METHODS,
  PROBE_METHOD_RANK,
  aggregateCurrentResults,
  classifyResultMethod,
  completenessTierOf,
  isStaleRelation,
  rankOpenProbes,
  rollupSubjectMethodFindings,
  rollupTerminalStatuses,
  staleCaption,
  type MinimumMethodMap,
  type ProbeMethod,
} from "../docs/data/release-scope.ts"
import { generateApi } from "./generate-api.ts"

const root = join(import.meta.dirname, "..")

const contentDir = join(root, "content")
const catalog = loadFeatures(contentDir)
const categories = loadCategories(contentDir)

// CTO ruling 2026-11-03: the retired projection was the last production reader; keep slice behaviour
// with the cohort contract instead of retaining an unused package API (#31824).
function slice(features: FeatureCatalog, categories: Readonly<Record<string, { slice: Slice }>>, id: string): Slice {
  const feature = features[id]
  if (!feature) throw new Error(`slice(): no feature "${id}" in the catalog`)
  if (feature.tier1 !== undefined) return "tier1"
  const key = id.split(".")[0] ?? ""
  const category = categories[key]
  if (!category) throw new Error(`slice(): feature "${id}" has prefix "${key}", which is not a category`)
  return category.slice
}

// CTO ruling 2026-10-23: retain these accepted contracts at their only caller, this test boundary.
/** The category facts a cohort's order needs: its slice label and its site order. */
export interface CohortCategoryMeta {
  slice: Slice
  order: number
}

/**
 * A cohort in its published order: every catalog row whose CATEGORY slice is one of `slices`, category
 * by category in the category catalog's own `order`, each category's ids ascending. That is the ONE
 * category order the site prints, so the cohort cannot disagree with the category blocks beside it.
 * A cohort that keeps every row of its slices leaves `excludingTier1` off; a cohort that is the tier
 * it ADDS asks for the exclusion and drops exactly the rows the catalog labels tier 1.
 */
export function cohortIds(
  catalog: FeatureCatalog,
  categories: Readonly<Record<string, CohortCategoryMeta>>,
  slices: readonly Slice[],
  options: { readonly excludingTier1: boolean },
): string[] {
  const wanted = new Set<string>(slices)
  // Refuse a slice no category carries BEFORE walking ids: a set of slices is a request, and a
  // mistyped or retired one must be named rather than dropped while the rest quietly answers.
  const carried = new Set(Object.values(categories).map((category) => category.slice))
  const unknown = [...wanted].filter((name) => !carried.has(name))
  if (unknown.length > 0) {
    throw new Error(
      `cohort asks for slice ${unknown.join(", ")}, which no category carries; carried slices: ${[...carried].sort().join(", ")}`,
    )
  }
  if (wanted.size === 0) throw new Error("cohort asks for no slices; name at least one")
  const selected = orderedCategoryIds(categories).filter((id) => {
    const sliceName = categories[id]?.slice
    return sliceName !== undefined && wanted.has(sliceName)
  })
  const ids: string[] = []
  let droppedTier1 = 0
  for (const key of selected) {
    const prefix = `${key}.`
    for (const id of Object.keys(catalog)
      .filter((id) => id.startsWith(prefix))
      .sort()) {
      // A cohort that measures a release's additions drops the rows already measured by tier 1.
      // The exclusion is data, never a per-cohort branch in a reader.
      if (options.excludingTier1 && slice(catalog, categories, id) === "tier1") {
        droppedTier1 += 1
        continue
      }
      ids.push(id)
    }
  }
  if (ids.length === 0) {
    throw new Error(
      droppedTier1 > 0
        ? `cohort is empty: every row of slices ${slices.join(", ")} is already tier 1, so the exclusion leaves nothing`
        : `cohort is empty: the categories for slices ${slices.join(", ")} carry no rows`,
    )
  }
  return ids
}

/**
 * The D3 verdict ladder (@chief 2026-10-07, from the operator's 20:04Z "let's make pass mean a %"):
 * a terminal PASSES when at least 90% of the INCLUDED capabilities read decisive (47 of 52),
 * "with gaps" from 70%, "fail" below — the fraction is always printed beside the label
 * (pass · 47/52). @chief's cited prior art is Lighthouse's 0-100 with 90+ green: a per-product
 * score, unlike caniuse's per-feature yes/partial/no.
 */
export const D3_VERDICT_BAR = { passPct: 90, gapsPct: 70 } as const

export type D3Label = "pass" | "with gaps" | "fail"

export interface D3Verdict {
  label: D3Label
  decisive: number
  denominator: number
  pct: number
  fraction: string
  text: string
}

/**
 * The one owner of the D3 rule. The label reads the same rounded percentage the fraction prints,
 * so a printed number can never disagree with the label beside it. A verdict over zero included
 * capabilities is refused loudly: it is not "fail", it is not measured.
 */
export function d3Verdict(decisive: number, denominator: number): D3Verdict {
  if (denominator <= 0) {
    throw new Error(`D3 verdict needs a positive denominator of included capabilities, got ${denominator}`)
  }
  if (decisive < 0 || decisive > denominator) {
    throw new Error(`D3 verdict needs 0 <= decisive <= denominator, got ${decisive}/${denominator}`)
  }
  const pct = Math.round((decisive / denominator) * 100)
  const label: D3Label = pct >= D3_VERDICT_BAR.passPct ? "pass" : pct >= D3_VERDICT_BAR.gapsPct ? "with gaps" : "fail"
  const fraction = `${decisive}/${denominator}`
  return { label, decisive, denominator, pct, fraction, text: `${label} · ${fraction}` }
}

describe("the derived scope and the classic cohort", () => {
  it("derives the declared 62 tier-1 rows from the catalog's tier1 labels, never a scope file", () => {
    const ids = Object.keys(catalog)
      .filter((id) => slice(catalog, categories, id) === "tier1")
      .sort()
    expect(ids).toHaveLength(62)
    const included = ids.filter((id) => catalog[id]?.tier1 === "included")
    expect(included).toHaveLength(52)
    expect(ids).toContain("device.primary-da")
    expect(included).not.toContain("extensions.osc777-notify")
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
    // A slice the category map carries but no catalog row populates is an EMPTY cohort, a different
    // refusal from an unknown slice; it names the requested slices whose categories carry no rows.
    expect(() =>
      cohortIds(catalog, { ghosts: { slice: "classics", order: 1 } }, ["classics"], {
        excludingTier1: false,
      }),
    ).toThrow(/cohort is empty: the categories for slices classics carry no rows/)
  })
})

describe("release status and verdicts", () => {
  it("records a stale measurement as not re-measured since that date", () => {
    expect(staleCaption("2026-10-04T17:46:58Z")).toBe("not re-measured since October 4, 2026")
    expect(isStaleRelation("tree")).toBe(false)
    expect(isStaleRelation("older")).toBe(true)
    expect(isStaleRelation("partial")).toBe(true)
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
    expect(home).toContain("currentCoverageSentence(bar, displayedSelections[backendName]?.selected.catalogIds)")
    expect(home).toContain("data.releaseShares[backendName]")
    // The composed-context migration removes whole-run results from this page. The
    // projection/consumer parity suites exercise its aggregate inputs; avoid pinning call syntax.
    expect(terminal).toContain("currentSupportedShare(measuredBar.value)")
    expect(loader).toContain("releaseShares[key] = currentSupportedShare(bar)")
    for (const source of [home, terminal, loader]) {
      expect(source).not.toContain("releaseVerdicts[")
      expect(source).not.toContain("d3Verdict(")
    }
    const helper = readFileSync(join(root, "docs", "data", "release-scope.ts"), "utf8")
    expect(helper).not.toMatch(/from ["']node:fs["']/)
  })
})

describe("Phase 2.4 single status-and-rollup computation (rollupTerminalStatuses)", () => {
  const allCatalogIds = Object.keys(catalog).sort()

  it("partitions the 273 catalogue into 264 graded positions + 9 environment positions across 13 families", () => {
    const statuses: Record<string, ProbeStatus> = {}
    for (const id of allCatalogIds) {
      statuses[id] = ENVIRONMENT_GROUP_IDS.includes(id as (typeof ENVIRONMENT_GROUP_IDS)[number])
        ? "test-todo"
        : id.startsWith("sgr.")
          ? "supported"
          : id.startsWith("cursor.")
            ? "unsupported"
            : id.startsWith("modes.")
              ? "untestable"
              : id === "input.kitty-click-events"
                ? "test-failure"
                : "test-todo"
    }
    const rollup = rollupTerminalStatuses(statuses, allCatalogIds)
    expect(rollup.positions).toBe(264)
    expect(rollup.environmentPositions).toBe(9)
    expect(Object.keys(rollup.families)).toHaveLength(13)
    expect(Object.values(rollup.families).reduce((sum, fam) => sum + fam.positions, 0)).toBe(264)
    expect(Object.values(rollup.families).reduce((sum, fam) => sum + fam.positions + fam.environmentPositions, 0)).toBe(
      273,
    )
    expect(rollup.families.device?.positions).toBe(19)
    expect(rollup.families.device?.environmentPositions).toBe(9)
    expect(Object.values(rollup.families).reduce((sum, fam) => sum + fam.open, 0)).toBe(rollup.open)
    expect(Object.values(rollup.families).reduce((sum, fam) => sum + fam.decided, 0)).toBe(rollup.decided)
    expect(rollup.decisive).toBe(rollup.counts.supported + rollup.counts.unsupported)
    expect(rollup.decided).toBe(rollup.decisive + rollup.counts.untestable)
    expect(rollup.open).toBe(rollup.counts["test-todo"] + rollup.counts["test-failure"])
    expect(rollup.decided + rollup.open).toBe(264)
    expect(rollup.completenessTier).toBe(1)

    // A2: no compat aliases on TerminalStatusRollup.
    expect(Object.keys(rollup).sort()).toEqual([
      "completenessTier",
      "counts",
      "decided",
      "decisive",
      "donePct",
      "environmentPositions",
      "families",
      "open",
      "positions",
      "supportedPct",
    ])

    // Strict exclusion of ENVIRONMENT_GROUP_IDS even if synthetic non-todo statuses are supplied on env rows.
    const syntheticEnv: Record<string, ProbeStatus> = { ...statuses }
    for (const envId of ENVIRONMENT_GROUP_IDS) {
      syntheticEnv[envId] = "supported"
    }
    const syntheticRollup = rollupTerminalStatuses(syntheticEnv, allCatalogIds)
    expect(syntheticRollup.counts).toEqual(rollup.counts)
    expect(syntheticRollup.families.device).toEqual(rollup.families.device)

    // All 4 probeStatus: "partial" features are included in the 264 graded positions.
    const partialIds = [
      "scrollback.viewport-hold-output",
      "extensions.osc52-clipboard",
      "extensions.osc52-write",
      "extensions.osc52-read",
    ]
    for (const id of partialIds) {
      expect(ENVIRONMENT_GROUP_IDS).not.toContain(id)
    }

    // Lossless JSON serialization round-trip (including supportedPct: null when decisive === 0).
    expect(JSON.parse(JSON.stringify(rollup))).toEqual(rollup)
    const allTodoStatuses = Object.fromEntries(allCatalogIds.map((id) => [id, "test-todo" as const]))
    const undecidedRollup = rollupTerminalStatuses(allTodoStatuses, allCatalogIds)
    expect(undecidedRollup.decisive).toBe(0)
    expect(undecidedRollup.supportedPct).toBeNull()
    expect(JSON.parse(JSON.stringify(undecidedRollup))).toEqual(undecidedRollup)
  })

  it("projects aggregateCurrentResults and completenessTierOf from rollupTerminalStatuses with identical outputs", () => {
    const results = allCatalogIds.map((featureId, index) => ({
      featureId,
      status: (["supported", "unsupported", "untestable", "test-todo", "test-failure"] as const)[index % 5]!,
    }))
    const statuses = Object.fromEntries(results.map((r) => [r.featureId, r.status]))
    const rollup = rollupTerminalStatuses(statuses, allCatalogIds)
    const aggregate = aggregateCurrentResults(results, allCatalogIds)
    const tier = completenessTierOf(statuses)

    expect(aggregate.denominator).toBe(rollup.positions)
    expect(aggregate.counts).toEqual(rollup.counts)
    expect(aggregate.supported).toBe(rollup.counts.supported)
    expect(aggregate.complete).toBe(rollup.completenessTier === 3)
    expect(tier).toEqual({
      completenessTier: rollup.completenessTier,
      todo: rollup.counts["test-todo"],
      failure: rollup.counts["test-failure"],
      positions: rollup.positions,
    })
  })

  it("ranks open graded probes by (-libOpen, -libFailure, featureId), excludes environment groups, and refuses missing or invalid cells (A5)", () => {
    const libCells = {
      vterm: {
        "device.env-term": "test-todo",
        "sgr.bold": "test-failure",
        "sgr.faint": "test-todo",
        "cursor.up": "supported",
        "erase.line": "test-todo",
      },
      xtermjs: {
        "device.env-term": "test-failure",
        "sgr.bold": "test-todo",
        "sgr.faint": "test-todo",
        "cursor.up": "test-failure",
        "erase.line": "supported",
      },
    }
    const rows = rankOpenProbes(libCells)
    // Environment group device.env-term is excluded even with open statuses.
    expect(rows.map((r) => r.featureId)).toEqual(["sgr.bold", "sgr.faint", "cursor.up", "erase.line"])
    // sgr.bold and sgr.faint tie on libOpen=2; sgr.bold wins on -libFailure (1 vs 0).
    // cursor.up and erase.line tie on libOpen=1; cursor.up wins on -libFailure (1 vs 0).
    expect(rows).toEqual([
      {
        featureId: "sgr.bold",
        family: "sgr",
        libOpen: 2,
        libFailure: 1,
        libTodo: 1,
      },
      {
        featureId: "sgr.faint",
        family: "sgr",
        libOpen: 2,
        libFailure: 0,
        libTodo: 2,
      },
      {
        featureId: "cursor.up",
        family: "cursor",
        libOpen: 1,
        libFailure: 1,
        libTodo: 0,
      },
      {
        featureId: "erase.line",
        family: "erase",
        libOpen: 1,
        libFailure: 0,
        libTodo: 1,
      },
    ])
    // A5: only fields with a caller in Step 2 (no app* or status maps on ProbeOpenRankRow).
    expect(Object.keys(rows[0]!).sort()).toEqual(["family", "featureId", "libFailure", "libOpen", "libTodo"])
    // Fail loud on invalid stored status or a missing graded cell in any library map.
    expect(() => rankOpenProbes({ vterm: { "sgr.bold": "bogus" } })).toThrow(
      /Invalid stored current status for sgr\.bold/,
    )
    expect(() =>
      rankOpenProbes({
        vterm: { "sgr.bold": "supported", "sgr.faint": "test-todo" },
        xtermjs: { "sgr.bold": "supported" },
      }),
    ).toThrow(/Invalid stored current status for sgr\.faint/)
  })
})

describe("Phase 2.4 report-only method, confidence & feature findings (rollupSubjectMethodFindings)", () => {
  const allCatalogIds = Object.keys(catalog).sort()
  const gradedIds = gradedFeatureIds(allCatalogIds)
  const storedRuns = loadStoredRuns(contentDir, allCatalogIds)

  it("maps every graded cell across all 12 corpus runs (loadStoredRuns) with 0 unmapped, 0 mixed, 30 source-reading, 118 kept-answer-not-reverified (30 rowAlsoHoldsCitedAnswerCount), and 3 wouldBeConflicts", () => {
    expect(PROBE_METHODS).toEqual(["source-reading", "library", "app-text", "app-screenshot", "real-os-device"])
    expect(PROBE_METHOD_RANK).toEqual({
      "source-reading": 1,
      library: 2,
      "app-text": 3,
      "app-screenshot": 4,
      "real-os-device": 5,
    })

    const minSourceReading: MinimumMethodMap = Object.fromEntries(
      gradedIds.map((id) => [id, { lib: "source-reading", term: "source-reading", mux: "source-reading" }]),
    )

    let totalPositions = 0
    let totalSourceReading = 0
    let totalLibrary = 0
    let totalAppText = 0
    let totalAppScreenshot = 0
    let totalRealOsDevice = 0
    let totalKeptNotReverified = 0
    let totalRowAlsoHoldsCited = 0
    let totalUnmapped = 0
    let totalMixed = 0
    let totalWouldBeConflicts = 0

    for (const run of storedRuns) {
      const report = rollupSubjectMethodFindings([run], minSourceReading, run.catalogIds ?? allCatalogIds)
      expect(report.positions).toBe(264)
      expect(report.environmentPositions).toBe(9)
      expect(report.buckets.unmapped).toEqual([])
      expect(report.buckets.mixed).toEqual([])
      expect(report.buckets.noMinimum).toEqual([])
      expect(report.buckets.keptAnswerNotReverified.label).toBe("kept answer, not re-verified")
      expect(report.buckets.keptAnswerNotReverified.rowAlsoHoldsCitedAnswerLabel).toBe(
        "row also holds a cited answer; not proof it applied",
      )

      totalPositions += report.positions
      totalKeptNotReverified += report.buckets.keptAnswerNotReverified.count
      totalRowAlsoHoldsCited += report.buckets.keptAnswerNotReverified.rowAlsoHoldsCitedAnswerCount
      totalUnmapped += report.buckets.unmapped.length
      totalMixed += report.buckets.mixed.length
      totalWouldBeConflicts += report.buckets.wouldBeConflicts.length

      for (const finding of Object.values(report.findings)) {
        for (const obs of finding.observedMethods) {
          if (obs === "source-reading") totalSourceReading++
          else if (obs === "library") totalLibrary++
          else if (obs === "app-text") totalAppText++
          else if (obs === "app-screenshot") totalAppScreenshot++
          else if (obs === "real-os-device") totalRealOsDevice++
        }
      }
    }

    expect(storedRuns).toHaveLength(12)
    expect(totalPositions).toBe(3168)
    expect(totalUnmapped).toBe(0)
    expect(totalMixed).toBe(0)
    expect(totalSourceReading).toBe(30)
    // #32181 replaced Ghostty 3f3e920e with 3bacc3ae; the other eleven runs are unchanged.
    expect(totalKeptNotReverified).toBe(118)
    expect(totalRowAlsoHoldsCited).toBe(30)
    expect(totalLibrary).toBe(824)
    expect(totalAppText).toBe(1194)
    expect(totalAppScreenshot).toBe(282)
    expect(totalRealOsDevice).toBe(57)
    expect(totalWouldBeConflicts).toBe(3)
  })

  it("enforces the suffix rule for source-reading vs kept-answer-not-reverified, routes empty matching to unmapped, routes multiple assertion types to mixed, and relies on sourceAnswerForRef throw", () => {
    const sampleRow = SOURCE_ANSWERS.find((r) => r.answers.some((a) => a.citedBlobs.length > 0))
    if (!sampleRow || !sampleRow.answers[0]) {
      throw new Error("Expected a sample cited source-answer row")
    }
    const ref = sourceAnswerKey(sampleRow.subject, sampleRow.featureId)
    const answerStatus = sampleRow.answers[0].status
    const missingStatus = (["supported", "unsupported", "untestable"] as const).find(
      (s) => !sampleRow.answers.some((a) => a.status === s),
    )
    if (!missingStatus) {
      throw new Error("Expected a status absent from sampleRow.answers")
    }

    const baseResult: ProbeResult = {
      featureId: sampleRow.featureId,
      status: answerStatus,
      attempt: { scope: "none" },
      tests: [],
      reviewRef: ref,
      reason: "Verified against source blob",
    }

    // 1. No unverified version suffix -> rank 1 source-reading
    expect(classifyResultMethod(baseResult, sampleRow.subject, [])).toEqual({
      kind: "method",
      method: "source-reading",
      confidenceRank: 1,
      source: "review-ref",
    })

    // 2. Unverified version suffix present (including when the run's own version differs from a cross-version reviewRef row's version) -> kept-answer-not-reverified (not source-reading)
    const crossVersionSubject = { ...sampleRow.subject, version: `${sampleRow.subject.version}-own-run` }
    expect(
      classifyResultMethod(
        {
          ...baseResult,
          reason: `Verified against source blob; ${sourceAnswerVersionLabel(crossVersionSubject.version)}`,
        },
        crossVersionSubject,
        [],
      ),
    ).toEqual({
      kind: "kept-answer-not-reverified",
      label: "kept answer, not re-verified",
      reviewRef: ref,
      rowAlsoHoldsCitedAnswer: true,
    })

    // 3. Stored status not among row.answers (matching.length === 0) -> unmapped (never uncited)
    const unmappedClass = classifyResultMethod({ ...baseResult, status: missingStatus }, sampleRow.subject, [])
    expect(unmappedClass.kind).toBe("unmapped")
    if (unmappedClass.kind === "unmapped") {
      expect(unmappedClass.reason).toContain(missingStatus)
    }

    // 4. Multiple distinct assertion types on one result -> mixed
    expect(
      classifyResultMethod(
        {
          featureId: "sgr.bold",
          status: "supported",
          attempt: { scope: "none" },
          assertionType: "buffer_state",
          tests: [{ id: "main", status: "supported", attempt: { scope: "none" }, assertionRefs: [0] }],
        },
        { kind: "term", version: "1.0.0" },
        [{ assertionType: "screenshot" }],
      ),
    ).toEqual({
      kind: "mixed",
      assertionTypes: ["buffer_state", "screenshot"],
    })

    // 5. Unknown reviewRef throws via sourceAnswerForRef
    const missingRef = sourceAnswerKey({ kind: "lib", id: "nonexistent", version: "0.0.0", os: "linux" }, "sgr.bold")
    expect(() =>
      classifyResultMethod({ ...baseResult, reviewRef: missingRef }, { kind: "lib", version: "0.0.0" }, []),
    ).toThrow(/Missing source-answer row/)
  })

  it("emits test-conflict when two qualifying results disagree (including untestable vs supported or across different ranks), settles winningMethod by highest rank only when all qualifying results agree, detects C1 disagreements via publicSourceAnswerPendingLabel, and rejects subject version/os mismatches or missing results", () => {
    const fAgree = "sgr.bold"
    const fConflictDiffRank = "sgr.faint"
    const fConflictUntestable = "sgr.italic"
    const fC1Disagree = "sgr.underline"
    const miniCatalog = [fAgree, fConflictDiffRank, fConflictUntestable, fC1Disagree]

    const makeRun = (results: ProbeResult[], assertions: Array<{ assertionType: "buffer_state" | "screenshot" }>) => ({
      subject: { kind: "term" as const, id: "wezterm", version: "20240203", os: "linux" as const },
      assertions,
      results,
    })

    // Run 1: app-text (rank 3)
    const run1 = makeRun(
      [
        {
          featureId: fAgree,
          status: "supported",
          attempt: { scope: "none" },
          assertionType: "buffer_state",
          tests: [],
        },
        {
          featureId: fConflictDiffRank,
          status: "supported",
          attempt: { scope: "none" },
          assertionType: "buffer_state",
          tests: [],
        },
        {
          featureId: fConflictUntestable,
          status: "untestable",
          attempt: { scope: "none" },
          assertionType: "buffer_state",
          tests: [],
        },
        {
          featureId: fC1Disagree,
          status: "test-todo",
          attempt: { scope: "none" },
          tests: [],
          reason: 'kept answers disagree: ["term","wezterm","20240203","linux","sgr.underline"]',
        },
      ],
      [],
    )

    // Run 2: app-screenshot (rank 4)
    const run2 = makeRun(
      [
        {
          featureId: fAgree,
          status: "supported",
          attempt: { scope: "none" },
          assertionType: "screenshot",
          tests: [],
        },
        {
          featureId: fConflictDiffRank,
          status: "unsupported",
          attempt: { scope: "none" },
          assertionType: "screenshot",
          tests: [],
        },
        {
          featureId: fConflictUntestable,
          status: "supported",
          attempt: { scope: "none" },
          assertionType: "screenshot",
          tests: [],
        },
        {
          featureId: fC1Disagree,
          status: "test-todo",
          attempt: { scope: "none" },
          tests: [],
          reason: 'kept answers disagree: ["term","wezterm","20240203","linux","sgr.underline"]',
        },
      ],
      [],
    )

    const minMap: MinimumMethodMap = {
      [fAgree]: { term: "app-text" },
      [fConflictDiffRank]: { term: "app-text" },
      [fConflictUntestable]: { term: "app-text" },
      [fC1Disagree]: { term: "source-reading" },
    }

    const report = rollupSubjectMethodFindings([run1, run2], minMap, miniCatalog)

    // Both qualify (rank 3 and rank 4 >= rank 3) and agree on "supported" -> highest rank ("app-screenshot") wins
    expect(report.findings[fAgree]).toMatchObject({
      runStatuses: ["supported", "supported"],
      findingStatus: "supported",
      winningMethod: "app-screenshot",
      neededMethod: null,
    })

    // Both qualify (rank 3 and rank 4 >= rank 3) and disagree ("supported" vs "unsupported") -> test-conflict (higher rank does NOT settle disagreement)
    expect(report.findings[fConflictDiffRank]).toMatchObject({
      runStatuses: ["supported", "unsupported"],
      findingStatus: "test-conflict",
      winningMethod: null,
      neededMethod: null,
    })

    // Both qualify and disagree ("untestable" vs "supported") -> test-conflict
    expect(report.findings[fConflictUntestable]).toMatchObject({
      runStatuses: ["untestable", "supported"],
      findingStatus: "test-conflict",
      winningMethod: null,
      neededMethod: null,
    })

    // C1 disagreement at minimumMethod "source-reading" -> findingStatus "test-conflict", runStatuses remains ["test-todo", "test-todo"], listed in wouldBeConflicts
    expect(report.findings[fC1Disagree]).toMatchObject({
      runStatuses: ["test-todo", "test-todo"],
      findingStatus: "test-conflict",
      winningMethod: null,
      neededMethod: null,
    })
    expect(report.buckets.wouldBeConflicts).toEqual([fC1Disagree])

    // Subject version or OS mismatch throws
    expect(() =>
      rollupSubjectMethodFindings(
        [run1, { ...run2, subject: { ...run2.subject, version: "20240101" } }],
        minMap,
        miniCatalog,
      ),
    ).toThrow(/Method findings require runs for one subject/)
    expect(() =>
      rollupSubjectMethodFindings([run1, { ...run2, subject: { ...run2.subject, os: "macos" } }], minMap, miniCatalog),
    ).toThrow(/Method findings require runs for one subject/)

    // Missing graded result throws "Missing result for <featureId>"
    expect(() =>
      rollupSubjectMethodFindings([{ ...run1, results: run1.results.slice(1) }], minMap, miniCatalog),
    ).toThrow(/Missing result for sgr\.bold/)
  })

  it("emits no-minimum-declared when minimumMethod is null/absent, and places both test-todo and test-failure findings that lack a qualifying result into neededMethod and needsByMethod", () => {
    const fNoMin = "sgr.bold"
    const fTodo = "sgr.faint"
    const fFailure = "sgr.italic"
    const fBelowMin = "sgr.underline"
    const miniCatalog = [fNoMin, fTodo, fFailure, fBelowMin]

    const run = {
      subject: { kind: "term" as const, id: "kitty", version: "0.40.0", os: "linux" as const },
      assertions: [],
      results: [
        {
          featureId: fNoMin,
          status: "supported" as const,
          attempt: { scope: "none" as const },
          assertionType: "buffer_state" as const,
          tests: [],
        },
        { featureId: fTodo, status: "test-todo" as const, attempt: { scope: "none" as const }, tests: [] },
        {
          featureId: fFailure,
          status: "test-failure" as const,
          attempt: { scope: "none" as const },
          assertionType: "screenshot" as const,
          tests: [],
        },
        {
          featureId: fBelowMin,
          status: "supported" as const,
          attempt: { scope: "none" as const },
          assertionType: "buffer_state" as const,
          tests: [],
        },
      ],
    }

    const minMap: MinimumMethodMap = {
      [fNoMin]: { term: null },
      [fTodo]: { term: "app-text" },
      [fFailure]: { term: "app-screenshot" },
      [fBelowMin]: { term: "app-screenshot" },
    }

    const report = rollupSubjectMethodFindings([run], minMap, miniCatalog)

    // 1. minimumMethod: null -> findingStatus: "no-minimum-declared" and buckets.noMinimum
    expect(report.findings[fNoMin]).toMatchObject({
      runStatuses: ["supported"],
      minimumMethod: null,
      findingStatus: "no-minimum-declared",
      winningMethod: null,
      neededMethod: null,
    })
    expect(report.buckets.noMinimum).toEqual([fNoMin])

    // 2. test-todo with minimumMethod "app-text" -> findingStatus "test-todo", neededMethod "app-text", in needsByMethod["app-text"]
    expect(report.findings[fTodo]).toMatchObject({
      runStatuses: ["test-todo"],
      minimumMethod: "app-text",
      findingStatus: "test-todo",
      winningMethod: null,
      neededMethod: "app-text",
    })
    expect(report.needsByMethod["app-text"]).toEqual([fTodo])

    // 3. Adjustment 6: test-failure (even with a screenshot assertion) never counts as valid; findingStatus is "test-failure", neededMethod is "app-screenshot", and it enters needsByMethod["app-screenshot"]
    expect(report.findings[fFailure]).toMatchObject({
      runStatuses: ["test-failure"],
      minimumMethod: "app-screenshot",
      findingStatus: "test-failure",
      winningMethod: null,
      neededMethod: "app-screenshot",
    })

    // 4. Decided "app-text" (rank 3) below minimumMethod "app-screenshot" (rank 4) -> findingStatus "test-todo", neededMethod "app-screenshot", enters needsByMethod["app-screenshot"]
    expect(report.findings[fBelowMin]).toMatchObject({
      runStatuses: ["supported"],
      minimumMethod: "app-screenshot",
      findingStatus: "test-todo",
      winningMethod: null,
      neededMethod: "app-screenshot",
    })
    expect(report.needsByMethod["app-screenshot"]).toEqual([fFailure, fBelowMin])
  })

  it("keeps rollupTerminalStatuses and generateApi outputs byte-identical on the 12 corpus runs (Adjustment 5)", () => {
    const rollups = storedRuns.map((loaded) => ({
      path: loaded.path.slice(contentDir.length + 1),
      sha256: loaded.sha256,
      rollup: rollupTerminalStatuses(
        Object.fromEntries((loaded.results ?? []).map((r) => [r.featureId, r.status])),
        loaded.catalogIds ?? allCatalogIds,
      ),
    }))
    const rollupsSha256 = createHash("sha256").update(JSON.stringify(rollups)).digest("hex")
    expect(rollupsSha256).toBe("76777dda7e9fc0070652bd1de95e1571bdf02368afddcbda7dc5ed8abdda6169")

    const outDir = mkdtempSync(join(tmpdir(), "terminfo-api-verify-"))
    try {
      const { dataPath } = generateApi(outDir, { contentDir, working: null })
      const apiDataSha256 = createHash("sha256").update(readFileSync(dataPath)).digest("hex")
      const apiEvidenceInventorySha256 = createHash("sha256")
        .update(readFileSync(join(outDir, "api", "v3", "evidence-files.json")))
        .digest("hex")
      expect(apiDataSha256).toBe("20e654d599388c546dfdcff55199892f2c73e8ab4b160134c9174037e019fb4f")
      expect(apiEvidenceInventorySha256).toBe("8142edbd5803aead9ae3f2bc1d520e2f6a5c3746dd5410274ef2f9ef48c0a5ad")
    } finally {
      // raw-delete-allow: standalone component repository whose CI installs without hh's workspace, so removely is
      // unavailable; `outDir` is this test's own mkdtempSync scratch root.
      rmSync(outDir, { recursive: true, force: true })
    }
  })
})
