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

export function isStaleSuite(suiteFreshness: string): boolean {
  return !suiteFreshness.startsWith("current")
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

export function decisiveShare(bar: MeasuredBar): string {
  if (!bar.denominator) return "No conclusive score"
  return `${bar.fillPct}% decisive of ${bar.denominator}`
}
