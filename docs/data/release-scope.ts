/** Release 1 measurement claim: 62 query/reply features of the 270-feature catalog. */

export interface ReleaseFeature {
  id: string
  name: string
  status: "not measured in this release"
}

export interface ReleaseScope {
  tier: number
  method: string
  measuredIds: string[]
  measuredCount: number
  catalogCount: number
  unmeasured: ReleaseFeature[]
}

export interface MeasuredBar {
  denominator: number
  supported: number
  unsupported: number
  inconclusive: number
  errors: number
  untested: number
  conclusive: number
  fillPct: number
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

export function barOverMeasured(
  cells: Record<string, { outcome: string; conclusive?: boolean }>,
  measuredIds: readonly string[],
): MeasuredBar {
  let supported = 0
  let unsupported = 0
  let inconclusive = 0
  let errors = 0
  let untested = 0
  for (const id of measuredIds) {
    const cell = cells[id]
    if (!cell) untested++
    else if (cell.outcome === "error") errors++
    else if (cell.conclusive && cell.outcome === "supported") supported++
    else if (cell.conclusive && cell.outcome === "unsupported") unsupported++
    else inconclusive++
  }
  const denominator = measuredIds.length
  return {
    denominator,
    supported,
    unsupported,
    inconclusive,
    errors,
    untested,
    conclusive: supported + unsupported,
    fillPct: denominator === 0 ? 0 : Math.round((supported / denominator) * 100),
  }
}

export function coverageSentence(bar: MeasuredBar): string {
  if (!bar.denominator) return "No selected run"
  return `${bar.supported} supported · ${bar.unsupported} unsupported · ${bar.inconclusive} inconclusive · ${bar.errors} errors · ${bar.untested} untested`
}

/**
 * The bar's supported share, named for what it counts. fillPct is supported/denominator — NOT the
 * decisive share, which is conclusive/denominator (supported + unsupported) and is what the D3
 * verdict reads. Calling this one "decisive" put two different numbers under one word on the same
 * page (measured 2026-10-07 on the built site: "pass · 52/52 · 40% decisive of 62").
 */
export function supportedShare(bar: MeasuredBar): string {
  if (!bar.denominator) return "No selected run"
  return `${bar.fillPct}% supported of ${bar.denominator}`
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
export function barVerdict(bar: MeasuredBar): D3Verdict | undefined {
  return bar.denominator > 0 ? d3Verdict(bar.conclusive, bar.denominator) : undefined
}

/**
 * The included tier-1 52 = the declared 62 minus the ten F2 movers (silent-consumed / fixture-gated
 * osc rows) named in the 27832 audit § "F2 mover list". There is no machine-readable mover list yet;
 * this is the audited list, hard-coded, and the 62-vs-52 disagreement is a separate ruling. The ten
 * are excluded by contract and are never counted as included.
 */
export const F2_MOVERS = [
  "extensions.osc777-notify",
  "extensions.osc666-termprop",
  "extensions.osc3008-context",
  "extensions.osc440-audio",
  "extensions.osc555-flash",
  "extensions.osc176-app-id",
  "extensions.osc22-pointer",
  "extensions.osc52-clipboard",
  "extensions.osc52-read",
  "extensions.osc52-write",
] as const

export const INCLUDED_TIER1_COUNT = 52

/** The included 52: the declared 62 minus the F2 movers, refusing loudly if the audited list no longer fits. */
export function includedTierOneIds(declaredIds: readonly string[]): string[] {
  const declared = new Set(declaredIds)
  const missing = F2_MOVERS.filter((id) => !declared.has(id))
  if (missing.length) {
    throw new Error(`F2 movers (27832) are not all in the declared tier-1 set: ${missing.join(", ")}`)
  }
  const movers = new Set<string>(F2_MOVERS)
  const included = declaredIds.filter((id) => !movers.has(id))
  if (included.length !== INCLUDED_TIER1_COUNT) {
    throw new Error(`included tier-1 set is ${included.length}, expected ${INCLUDED_TIER1_COUNT}`)
  }
  return included
}
