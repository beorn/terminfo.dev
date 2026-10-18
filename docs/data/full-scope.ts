/**
 * The all-catalog scope of the private 273-capability project.
 *
 * This module owns the arithmetic the project's done text requires, and nothing else: for one
 * context it folds the ONE classified cell table over ALL catalog rows and prints four facts
 * together — the decisive score S/D, the measurable denominator D, the ceiling D/N and the
 * inclusion label. It does not read runs, choose versions or decide that a context was collected;
 * the caller passes the classified cells for one selected run, or renders NOT COLLECTED itself.
 *
 * The three named sets are data, never per-context branches:
 *  - DESIGN EXCLUSIONS leave every context's denominator for a stated design reason;
 *  - INSTRUMENT LIMITS leave one context's denominator for a reviewed observation limit;
 *  - MISSING DEFINITIONS stay IN the denominator as open work and are named beside the score.
 * Overlapping exclusions are counted once. A missing definition can never be an exclusion.
 */
import { aggregateCells, d3Verdict, type CellState, type D3Verdict } from "./release-scope.ts"

/**
 * The issued design-exclusion set: the ten manual rows plus the three rows the denominator ruling
 * excludes by design, each with the cause that removes it. Nine of the ten manual rows are the device
 * environment contract; the tenth is the viewport hold row. These rows keep their original
 * observations visible even though they leave no context's score.
 */
const DESIGN_EXCLUSIONS = [
  ["device.env-term", "manual environment contract"],
  ["device.env-colorterm", "manual environment contract"],
  ["device.env-term-program", "manual environment contract"],
  ["device.env-lc-terminal", "manual environment contract"],
  ["device.env-vte-version", "manual environment contract"],
  ["device.env-kitty", "manual environment contract"],
  ["device.env-wezterm", "manual environment contract"],
  ["device.env-wt-session", "manual environment contract"],
  ["device.env-no-color", "manual environment contract"],
  ["scrollback.viewport-hold-output", "manual viewport interaction"],
  ["reset.method", "named parser-only design exclusion"],
  ["scrollback.accumulate", "named parser-only design exclusion"],
  ["scrollback.total-lines", "named parser-only design exclusion"],
] as const

export const DESIGN_EXCLUSION_IDS = DESIGN_EXCLUSIONS.map(([id]) => id)

/** The stated cause for each design exclusion, so a printed row is named and explained. */
export const DESIGN_EXCLUSION_CAUSES: Readonly<Record<string, string>> = Object.fromEntries(DESIGN_EXCLUSIONS)

/**
 * The catalog rows with no probe definition yet. They are WORK, not exclusions: they remain in the
 * denominator, score as untested until measured, and are named beside every context's score.
 */
export const MISSING_DEFINITION_IDS = [] as const

/** One row that leaves a denominator, with the set that excludes it. */
export interface Exclusion {
  id: string
  cause: "design" | "instrument"
}

/** A reviewed instrument limit: the row and the named observation limit that no planned work cures. */
export interface InstrumentLimit {
  id: string
  cause: string
}

export interface ScopeInput {
  /** The context name this scope is scored for, printed in every refusal. */
  scope: string
  /** Every catalog row, in the site's category order. Its length is N. */
  catalogIds: readonly string[]
  /** The ONE classified table for the selected run; an absent id classifies as untested. */
  cells: Readonly<Record<string, CellState>>
  designExclusions?: readonly string[]
  instrumentLimits?: readonly InstrumentLimit[]
  missingDefinitions?: readonly string[]
}

/** A group's slice of one context's score, carrying the same four facts as the context. */
export interface ScopeGroup {
  key: string
  catalogRows: number
  denominator: number
  decisive: number
  /** The states behind the group's non-decisive rows, so a below-bar label can name its causes. */
  counts: Readonly<Record<CellState, number>>
  /** Empty when every row of the group is excluded: no denominator, so no score is printed. */
  fraction: string
  pct: number | null
  ceiling: string
  verdict: D3Verdict | null
  included: boolean
}

export interface ScopeResult {
  scope: string
  /** N: every catalog row this scope scores over. */
  catalogRows: number
  /** B ∪ I, in catalog order, with the set that named each row. */
  excluded: readonly Exclusion[]
  /** D = N − |B ∪ I|. */
  denominator: number
  decisive: number
  /** The remaining states over D, so a page can name causes without re-walking cells. */
  counts: Readonly<Record<CellState, number>>
  /** S/D, printed beside its percentage and label. */
  fraction: string
  pct: number
  /** D/N: the ceiling that shows how much of the catalog the denominator covers. */
  ceiling: string
  verdict: D3Verdict
  included: boolean
  /** Missing definitions kept IN the denominator, named as open work. */
  missingDefinitions: readonly string[]
  /** Excluded rows keep their observation; bar exclusion never erases an observed outcome. */
  excludedObservations: readonly { id: string; cause: Exclusion["cause"]; state: CellState }[]
  groups: readonly ScopeGroup[]
}

/**
 * Fold one context's classified cells over the full catalog. Refusals are loud and name the row:
 * an exclusion the catalog does not carry, a missing definition that was excluded, or a scope that
 * excludes every row would each produce a number that reads like a measurement but is not one.
 */
export function scopeAggregate(input: ScopeInput): ScopeResult {
  const catalogIds = uniqueCatalog(input.catalogIds, input.scope)
  const design = [...(input.designExclusions ?? DESIGN_EXCLUSION_IDS)]
  const instruments = [...(input.instrumentLimits ?? [])]
  const missing = [...new Set(input.missingDefinitions ?? MISSING_DEFINITION_IDS)]

  const exclusions: Exclusion[] = []
  const seen = new Set<string>()
  for (const id of design) {
    const entry = exclusion(id, "design", catalogIds, seen)
    if (entry) exclusions.push(entry)
  }
  for (const limit of instruments) {
    if (!limit.cause.trim()) {
      throw new Error(`instrument limit ${limit.id} in ${input.scope} carries no cause; a limit is named or absent`)
    }
    const entry = exclusion(limit.id, "instrument", catalogIds, seen)
    if (entry) exclusions.push(entry)
  }

  for (const id of missing) {
    if (!catalogIds.has(id)) {
      throw new Error(`missing definition ${id} is not a catalog row of ${input.scope}`)
    }
    if (seen.has(id)) {
      throw new Error(
        `missing definition ${id} is excluded in ${input.scope}; a missing definition is open work and stays in the denominator`,
      )
    }
  }

  const denominatorIds = input.catalogIds.filter((id) => !seen.has(id))
  if (denominatorIds.length === 0) {
    throw new Error(
      `scope ${input.scope} excludes all ${input.catalogIds.length} catalog rows; a zero denominator has no score`,
    )
  }

  const aggregate = aggregateCells(input.cells, denominatorIds)
  const decisive = aggregate.counts.supported + aggregate.counts.unsupported
  const verdict = d3Verdict(decisive, aggregate.denominator)

  return {
    scope: input.scope,
    catalogRows: input.catalogIds.length,
    excluded: exclusions,
    denominator: aggregate.denominator,
    decisive,
    counts: aggregate.counts,
    fraction: verdict.fraction,
    pct: verdict.pct,
    ceiling: `${aggregate.denominator}/${input.catalogIds.length}`,
    verdict,
    included: verdict.label === "pass",
    missingDefinitions: missing,
    excludedObservations: exclusions.map((entry) => ({
      id: entry.id,
      cause: entry.cause,
      state: input.cells[entry.id] ?? "untested",
    })),
    groups: groupsFor(input.catalogIds, seen, input.cells),
  }
}

/** One context the project cannot score yet: a named cause, never 0% and never included. */
export interface NotCollectedScope {
  scope: string
  collected: false
  cause: string
}

/** The label every uncollected context prints, with its cause and no score. */
export function notCollected(scope: string, cause: string): NotCollectedScope {
  if (!cause.trim()) throw new Error(`uncollected scope ${scope} must name its cause`)
  return { scope, collected: false, cause }
}

function uniqueCatalog(ids: readonly string[], scope: string): Set<string> {
  if (ids.length === 0) throw new Error(`scope ${scope} has no catalog rows to score`)
  const unique = new Set<string>()
  for (const id of ids) {
    if (!id) throw new Error(`scope ${scope} carries an empty catalog id`)
    if (unique.has(id)) throw new Error(`scope ${scope} repeats catalog row ${id}`)
    unique.add(id)
  }
  return unique
}

function exclusion(
  id: string,
  cause: Exclusion["cause"],
  catalogIds: ReadonlySet<string>,
  seen: Set<string>,
): Exclusion | undefined {
  if (!catalogIds.has(id)) throw new Error(`${cause} exclusion ${id} is not a catalog row`)
  if (seen.has(id)) return undefined
  seen.add(id)
  return { id, cause }
}

function groupsFor(
  catalogIds: readonly string[],
  excluded: ReadonlySet<string>,
  cells: Readonly<Record<string, CellState>>,
): ScopeGroup[] {
  const order: string[] = []
  const idsByGroup = new Map<string, string[]>()
  for (const id of catalogIds) {
    const key = id.split(".")[0] ?? ""
    if (!key) throw new Error(`catalog row ${id} has no group prefix`)
    let ids = idsByGroup.get(key)
    if (!ids) {
      ids = []
      idsByGroup.set(key, ids)
      order.push(key)
    }
    ids.push(id)
  }
  return order.map((key) => {
    const ids = idsByGroup.get(key) ?? []
    const denominatorIds = ids.filter((id) => !excluded.has(id))
    if (denominatorIds.length === 0) {
      // Every row leaves this group's denominator: there is no score to print, and an empty
      // fraction must never read as a zero. The caller prints the group as wholly excluded.
      return {
        key,
        catalogRows: ids.length,
        denominator: 0,
        decisive: 0,
        counts: { supported: 0, unsupported: 0, inconclusive: 0, error: 0, untested: 0 },
        fraction: "",
        pct: null,
        ceiling: `0/${ids.length}`,
        verdict: null,
        included: false,
      }
    }
    const aggregate = aggregateCells(cells, denominatorIds)
    const decisive = aggregate.counts.supported + aggregate.counts.unsupported
    const verdict = d3Verdict(decisive, aggregate.denominator)
    return {
      key,
      catalogRows: ids.length,
      denominator: aggregate.denominator,
      decisive,
      counts: aggregate.counts,
      fraction: verdict.fraction,
      pct: verdict.pct,
      ceiling: `${aggregate.denominator}/${ids.length}`,
      verdict,
      included: verdict.label === "pass",
    }
  })
}
