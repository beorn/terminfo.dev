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
import { loadFeatures, slice, type FeatureCatalog, type Slice } from "@terminfo/catalog"
import { ENVIRONMENT_GROUP_IDS, type ProbeStatus } from "@terminfo/probe-defs"
import { parseSuiteManifest } from "@terminfo/run-parser"
import { loadCategories, orderedCategoryIds } from "../docs/data/categories.ts"
import { frozenSuiteIdFor, loadReleaseScope } from "../docs/data/load-release-scope.ts"
import {
  aggregateCurrentResults,
  completenessTierOf,
  isStaleRelation,
  rankOpenProbes,
  rollupTerminalStatuses,
  staleCaption,
  treeMovedPastRelease,
} from "../docs/data/release-scope.ts"

const root = join(import.meta.dirname, "..")

const contentDir = join(root, "content")
const catalog = loadFeatures(contentDir)
const categories = loadCategories(contentDir)

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

/** Write one suite manifest from a freeze pointer, for the registry tests below. */
function writeSuite(dir: string, probeHash: string, freeze?: { release: string; at: string }): void {
  writeFileSync(
    join(dir, `${probeHash}.json`),
    JSON.stringify({
      schemaVersion: 4 as const,
      probeHash,
      adapterVersion: "4.0.0",
      ...(freeze === undefined ? {} : { freeze }),
      probes: { term: [], lib: [], mux: [] },
    }),
  )
}

describe("the derived scope, the classic cohort and the suite pointer", () => {
  it("derives the declared 62 tier-1 rows from the catalog's tier1 labels, never a scope file", () => {
    const scope = loadReleaseScope({ catalog, categories })
    expect(scope.measuredCount).toBe(62)
    expect(scope.measuredIds).toEqual([...scope.measuredIds].sort())
    const included = scope.measuredIds.filter((id) => catalog[id]?.tier1 === "included")
    expect(included).toHaveLength(52)
    expect(scope.measuredIds).toContain("device.primary-da")
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

describe("Phase 2.4 single status-and-rollup computation (rollupTerminalStatuses + rankOpenProbes)", () => {
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
    expect(
      Object.values(rollup.families).reduce((sum, fam) => sum + fam.positions, 0),
    ).toBe(264)
    expect(
      Object.values(rollup.families).reduce((sum, fam) => sum + fam.positions + fam.environmentPositions, 0),
    ).toBe(273)
    expect(rollup.families.device?.positions).toBe(19)
    expect(rollup.families.device?.environmentPositions).toBe(9)
    expect(
      Object.values(rollup.families).reduce((sum, fam) => sum + fam.open, 0),
    ).toBe(rollup.open)
    expect(
      Object.values(rollup.families).reduce((sum, fam) => sum + fam.decided, 0),
    ).toBe(rollup.decided)
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

  it("ranks open probes deterministically by (-totalOpen, -libOpen, -(libFailure + appFailure), featureId) over graded ids only", () => {
    const subsetIds = ["device.env-term", "sgr.bold", "sgr.faint", "cursor.up", "modes.decckm"]
    const libCells = {
      vterm: {
        "device.env-term": "test-todo",
        "sgr.bold": "supported",
        "sgr.faint": "test-todo",
        "cursor.up": "test-failure",
        "modes.decckm": "test-todo",
      },
      kitty: {
        "device.env-term": "test-todo",
        "sgr.bold": "supported",
        "sgr.faint": "test-todo",
        "cursor.up": "test-todo",
        "modes.decckm": "supported",
      },
    }
    const appCells = {
      "app:kitty": {
        "device.env-term": "test-todo",
        "sgr.bold": "supported",
        "sgr.faint": "supported",
        "cursor.up": "supported",
        "modes.decckm": "test-failure",
      },
    }
    const ranked = rankOpenProbes(libCells, subsetIds, appCells)
    // device.env-term is excluded; 4 graded rows remain.
    expect(ranked.map((row) => row.featureId)).toEqual([
      "cursor.up",    // totalOpen=2, libOpen=2, failures=1
      "sgr.faint",    // totalOpen=2, libOpen=2, failures=0
      "modes.decckm", // totalOpen=2, libOpen=1, failures=1
      "sgr.bold",     // totalOpen=0
    ])
    expect(ranked[0]).toEqual({
      featureId: "cursor.up",
      family: "cursor",
      libOpen: 2,
      libFailure: 1,
      libTodo: 1,
      appOpen: 0,
      appFailure: 0,
      appTodo: 0,
      totalOpen: 2,
    })
  })
})
