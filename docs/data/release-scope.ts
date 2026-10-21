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
 * The five states one measured cell can be in. This is the ONE classification: the bar, the
 * decisive-share CLI and the page templates all read it, so they cannot drift into five copies.
 */
export type CellState = "supported" | "unsupported" | "inconclusive" | "error" | "untested"

/**
 * Presentation states retain their existing keys: inconclusive is reserved for reviewed Untestable
 * claims, error is TEST FAILURE, and untested is TEST TODO. A missing cell or evidence "none" means
 * no feature measurement started; an undecided attempt is a failed test, not terminal non-support.
 * Historical booleans or records without an attempt method require a rerun, not a guessed failure.
 * Existing refusals never establish that a capability is impossible to test in its context.
 */
export function classifyCell(
  cell: { outcome: string; conclusive?: boolean; evidence?: string; reason?: string } | undefined,
): CellState {
  if (!cell) return "untested"
  if (cell.outcome === "error") return "error"
  if (cell.evidence === "none" || cell.evidence === "legacy") return "untested"
  if (cell.conclusive && cell.outcome === "supported") return "supported"
  if (cell.conclusive && cell.outcome === "unsupported") return "unsupported"
  if (!cell.evidence) return "untested"
  return "error"
}

/** Classify a whole prepared cell map with the ONE classifier. Its two callers live in
 * `selected-results.ts`: `projectResults` fills the product table, while `classifyDevelopmentRun`
 * returns private development states. Neither pages nor scripts classify raw cells (28792 item 1). */
export function classifyCells(cells: Record<string, Parameters<typeof classifyCell>[0]>): Record<string, CellState> {
  const states: Record<string, CellState> = {}
  for (const [featureId, cell] of Object.entries(cells)) states[featureId] = classifyCell(cell)
  return states
}

function utcDate(measuredAt: string): string {
  const value = new Date(measuredAt)
  if (Number.isNaN(value.getTime())) throw new Error(`invalid measuredAt ${measuredAt}`)
  return value.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" })
}

export function tierLine(scope: ReleaseScope, options?: { measuredAt?: string }): string {
  const base = `${scope.measuredCount} of ${scope.catalogCount} features (tier ${scope.tier}), measured per terminal; next tiers in progress`
  return options?.measuredAt ? `${base} · measured ${utcDate(options.measuredAt)}` : base
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

export function coverageSentence(aggregate: CellAggregate): string {
  if (!aggregate.denominator) return "No selected run"
  const { counts } = aggregate
  return `${counts.supported} Supported · ${counts.unsupported} Unsupported · ${counts.inconclusive} Untestable · ${counts.untested} TEST TODO · ${counts.error} TEST FAILURE`
}

/**
 * The basis's supported share, named for what it counts. It is supported/denominator — NOT the
 * decisive share, which is conclusive/denominator (supported + unsupported) and is what the D3
 * verdict reads. Calling this one "decisive" put two different numbers under one word on the same
 * page (measured 2026-10-07 on the built site: "pass · 52/52 · 40% decisive of 62").
 */
export function supportedShare(aggregate: CellAggregate): string {
  if (!aggregate.denominator) return "No selected run"
  const pct = Math.round((aggregate.counts.supported / aggregate.denominator) * 100)
  return `${pct}% supported of ${aggregate.denominator}`
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
  return d3Verdict(aggregate.counts.supported + aggregate.counts.unsupported, aggregate.denominator)
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
