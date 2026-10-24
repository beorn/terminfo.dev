import {
  CAPABILITY_STATUSES,
  type CapabilityResult,
  type CapabilityStatus,
} from "../../packages/probe-defs/src/types.ts"
import { environmentGroupIds, gradedFeatureIds } from "../../packages/probe-defs/src/environment-groups.ts"
import type { PublicVersion, PublicCapabilityResult } from "./public-results.ts"

/** Read a current (schema-3) published result without manufacturing any legacy observation. */
export function publicResultFor(
  version: PublicVersion | undefined,
  featureId: string,
): PublicCapabilityResult | undefined {
  if (!version) return undefined
  return version.results.find((result) => result.featureId === featureId)
}

/** Release 1 measurement claim: 62 query/reply features of the 270-feature catalog. */

/** The populated categories a page displays, preserving the catalog's supplied order. */
export function visibleCategoryIds(
  categoryOrder: readonly string[],
  categories: Readonly<Record<string, readonly unknown[]>>,
): string[] {
  return categoryOrder.filter((id) => (categories[id]?.length ?? 0) > 0)
}

export interface ReleaseFeature {
  id: string
  name: string
  status: "not measured in this release"
}

export interface ReleaseScope {
  tier: number
  method: string
  measuredIds: string[]
  /**
   * The declared ids an APP run can decide: `measuredIds` minus the app-unobservable rows. This is
   * the denominator every decisive share is scored over, so a row whose decider is the parser
   * surface only (see `@terminfo/probe-defs` `APP_UNOBSERVABLE_ROWS`) never reads as a terminal
   * undecidability.
   */
  scoredIds: string[]
  /** The declared rows an app run cannot decide, in declaration order, named and never scored. */
  libraryOnlyIds: string[]
  measuredCount: number
  catalogCount: number
  unmeasured: ReleaseFeature[]
}

/**
 * The five states one measured cell can be in. Current readings publish sealed `CapabilityStatus`
 * values directly; these names survive for the archived legacy evidence the v1 API still renders.
 *
 * Presentation states retain their existing keys: inconclusive is reserved for reviewed Untestable
 * claims, error is TEST FAILURE, and untested is TEST TODO. A missing cell or evidence "none" means
 * no feature measurement started; an undecided attempt is a failed test, not terminal non-support.
 */
export type CellState = "supported" | "unsupported" | "inconclusive" | "error" | "untested"

function utcDate(measuredAt: string): string {
  const value = new Date(measuredAt)
  if (Number.isNaN(value.getTime())) throw new Error(`invalid measuredAt ${measuredAt}`)
  return value.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" })
}

export function staleCaption(measuredAt: string): string {
  return `not re-measured since ${utcDate(measuredAt)}`
}

/**
 * Which suite a run was measured on, relative to the two facts the site must never conflate:
 * the RELEASE suite (the scope's `frozenSuiteId`) and the live TREE suite (`probeHash()` at build time).
 */
export type SuiteRelation = "release" | "tree" | "older" | "partial"

/**
 * A run measured on the release suite or on the live tree suite is current; "older" and "partial" are
 * stale. This is the ONE staleness fact — never re-derive it by re-parsing the display label.
 */
export function isStaleRelation(relation: SuiteRelation): boolean {
  return relation === "older" || relation === "partial"
}

/** True when the live tree has moved past the release suite, so a banner must say so (one, not two). */
export function treeMovedPastRelease(treeSuiteId: string | null, releaseSuiteId: string | null): boolean {
  return Boolean(treeSuiteId) && Boolean(releaseSuiteId) && treeSuiteId !== releaseSuiteId
}

/**
 * One basis counted over a CLASSIFIED cell map (28792 item 1). This is the ONE aggregation: the
 * projection classifies every cell once, and every bar, page and CLI view folds that table here
 * instead of walking raw cells itself. `MeasuredBar` and `barOverMeasured` — the raw-cell fold — are
 * retired with it, so no second copy can survive behind a parity test.
 */
export interface CellAggregate {
  denominator: number
  counts: Readonly<Record<CellState, number>>
  /**
   * The named ids in each state, in basis order: the row names behind each count, so a view that names
   * a bucket (the inconclusive rows today) reads them here rather than re-walking the basis.
   */
  idsByState: Readonly<Record<CellState, readonly string[]>>
}

/** Fold one basis over a classified cell map. A cell the map does not name is untested, as in the table. */
export function aggregateCells(cells: Readonly<Record<string, CellState>>, ids: readonly string[]): CellAggregate {
  const counts: Record<CellState, number> = { supported: 0, unsupported: 0, inconclusive: 0, error: 0, untested: 0 }
  const idsByState: Record<CellState, string[]> = {
    supported: [],
    unsupported: [],
    inconclusive: [],
    error: [],
    untested: [],
  }
  for (const id of ids) {
    const state = cells[id] ?? "untested"
    counts[state]++
    idsByState[state].push(id)
  }
  return { denominator: ids.length, counts, idsByState }
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

/** The verdict of a measured bar, or undefined when nothing was measured. */
export function barVerdict(aggregate: CellAggregate): D3Verdict | undefined {
  if (aggregate.denominator <= 0) return undefined
  return d3Verdict(decisiveCells(aggregate.counts), aggregate.denominator)
}

/**
 * The included tier-1 rows of a declared set: those whose `tier1` label is `included`. The ten rows
 * excluded by contract (the silent-consumed or fixture-gated osc rows the 27832 audit names) carry
 * `tier1: "excluded"` in the catalog, so the included set is a filter of a stored label, never a
 * second hard-coded mover list that can drift from it.
 */
export function tier1Included(catalog: Readonly<Record<string, { tier1?: string }>>, ids: readonly string[]): string[] {
  return ids.filter((id) => catalog[id]?.tier1 === "included")
}

/** Current score and completion fold recorded statuses over exactly the frozen catalogue. */
export interface CurrentAggregate {
  denominator: number
  counts: Record<CapabilityStatus, number>
  idsByState: Record<CapabilityStatus, string[]>
  supported: number
  complete: boolean
}

export function aggregateCurrentResults(
  results: readonly CapabilityResult[],
  catalogIds: readonly string[],
): CurrentAggregate {
  if (!catalogIds.length || new Set(catalogIds).size !== catalogIds.length) {
    throw new Error("Current aggregate requires a nonempty unique frozen catalogue")
  }
  const counts: Record<CapabilityStatus, number> = {
    supported: 0,
    unsupported: 0,
    untestable: 0,
    "test-todo": 0,
    "test-failure": 0,
  }
  const idsByState: Record<CapabilityStatus, string[]> = {
    supported: [],
    unsupported: [],
    untestable: [],
    "test-todo": [],
    "test-failure": [],
  }
  const byId = new Map(results.map((result) => [result.featureId, result]))
  if (byId.size !== results.length || results.length !== catalogIds.length || catalogIds.some((id) => !byId.has(id))) {
    throw new Error("Current results differ from frozen catalogue membership")
  }
  // D132 B (#30917): grading covers the graded ids only. The nine environment groups stay in the
  // catalogue — the membership check above still requires all 273 — but they are not capabilities and
  // a run cannot grade them, so they are counted below as visible ungraded, never as TEST TODO.
  const gradedIds = gradedFeatureIds(catalogIds)
  for (const id of gradedIds) {
    const result = byId.get(id)
    if (!result || !CAPABILITY_STATUSES.includes(result.status)) {
      throw new Error(`Invalid stored current status for ${id}`)
    }
    counts[result.status]++
    idsByState[result.status].push(id)
  }
  return {
    denominator: gradedIds.length,
    counts,
    idsByState,
    supported: counts.supported,
    complete: counts["test-todo"] === 0 && counts["test-failure"] === 0,
  }
}

export function currentCoverageSentence(
  aggregate: Pick<CurrentAggregate, "counts">,
  catalogIds?: readonly string[],
): string {
  const counts = aggregate.counts
  const graded = `${counts.supported} Supported · ${counts.unsupported} Unsupported · ${counts.untestable} Untestable · ${counts["test-todo"]} TEST TODO · ${counts["test-failure"]} TEST FAILURE`
  // D132 B (#30917): an exclusion the site cannot explain reads as a terminal verdict, so a caller
  // that knows the run's catalogue names the environment groups it recorded as ungraded.
  const environmentGroups = catalogIds ? environmentGroupIds(catalogIds).length : 0
  return environmentGroups === 0
    ? graded
    : `${graded} · ${environmentGroups} environment groups manual by design (catalogue), NOT MEASURED`
}

export function currentSupportedShare(aggregate: CurrentAggregate): string {
  // #30784: the same rule as a baseline row, one level up. A run whose every cell is TEST TODO or
  // TEST FAILURE decided nothing, so "0/264 supported (0%)" would read as a measured fail.
  if (runDecidedNothing(aggregate.counts)) return NOT_MEASURED_TEXT
  return `${aggregate.supported}/${aggregate.denominator} supported (${Math.round((100 * aggregate.supported) / aggregate.denominator)}%)`
}

/**
 * The cells of a bar that carry a verdict about the terminal: Supported and Unsupported. A reviewed
 * Untestable claim says the row cannot be probed, not that the terminal was judged, and TEST TODO /
 * TEST FAILURE decide nothing. This is the ONE owner of that sum: `barVerdict`, the decisive-share
 * reader and the baseline row readout all call it, so no caller can drift into a second definition.
 */
export function decisiveCells(counts: { readonly supported: number; readonly unsupported: number }): number {
  return counts.supported + counts.unsupported
}

/**
 * Whether a run judged nothing at all (#30784): every cell is TEST TODO, TEST FAILURE or a reviewed
 * Untestable claim. This is the run-level twin of `notMeasuredReadout`, and the ONE predicate every
 * whole-run readout asks, so a page cannot print a measured-looking zero for it.
 */
export function runDecidedNothing(counts: Readonly<Record<CapabilityStatus, number>>): boolean {
  return decisiveCells(counts) === 0
}

/**
 * The words a baseline row prints in place of a percentage when its run judged nothing (#30763):
 * "0%" there reads as a measured fail for a terminal no run ever decided. The counts stay in the
 * row's tooltip.
 *
 * TBD (#30763 AC5): the operator's naming menu has not ruled between "Not tested yet" and
 * "Not measured yet"; this placeholder ships until that approval lands.
 */
export const NOT_MEASURED_TEXT = "Not measured yet"

/**
 * The one thing both baseline pages share for a row that decided nothing (#30763): the not-measured
 * words, with what the row looked at in its title. A row with any decisive cell returns undefined and
 * each page keeps its own decided-row text, byte-identical to what it printed before the fix — the
 * defect is the false "0%", and nothing beside it may move.
 */
export function notMeasuredReadout(
  counts: Readonly<Record<CapabilityStatus, number>>,
): { text: string; title: string } | undefined {
  if (decisiveCells(counts) > 0) return undefined
  return { text: NOT_MEASURED_TEXT, title: currentCoverageSentence({ counts }) }
}
