/**
 * Current full-catalogue arithmetic: Supported/all over the GRADED capabilities. The nine environment
 * positions stay in `catalogRows` (a run records them) but are ungraded, so they are never in
 * `denominator` — D132 B (#30917).
 */
import type { CapabilityResult, CapabilityStatus } from "@terminfo/probe-defs"
import { aggregateCurrentResults } from "./release-scope.ts"

/** Current execution score: every frozen graded capability stays in the denominator. */
export interface ScopeResult {
  scope: string
  catalogRows: number
  denominator: number
  supported: number
  counts: Record<CapabilityStatus, number>
  fraction: string
  pct: number
  complete: boolean
  groups: readonly {
    key: string
    catalogRows: number
    supported: number
    counts: Record<CapabilityStatus, number>
    fraction: string
    pct: number
    complete: boolean
  }[]
}

export function scopeAggregate(input: {
  scope: string
  catalogIds: readonly string[]
  results: readonly CapabilityResult[]
}): ScopeResult {
  const aggregate = aggregateCurrentResults(input.results, input.catalogIds)
  const grouped = new Map<string, string[]>()
  for (const id of input.catalogIds) {
    const key = id.split(".")[0] ?? id
    grouped.set(key, [...(grouped.get(key) ?? []), id])
  }
  return {
    scope: input.scope,
    catalogRows: input.catalogIds.length,
    denominator: aggregate.denominator,
    supported: aggregate.supported,
    counts: aggregate.counts,
    fraction: `${aggregate.supported}/${aggregate.denominator}`,
    pct: Math.round((100 * aggregate.supported) / aggregate.denominator),
    complete: aggregate.complete,
    groups: [...grouped].map(([key, ids]) => {
      const members = new Set(ids)
      const group = aggregateCurrentResults(
        input.results.filter((result) => members.has(result.featureId)),
        ids,
      )
      return {
        key,
        catalogRows: ids.length,
        supported: group.supported,
        counts: group.counts,
        fraction: `${group.supported}/${group.denominator}`,
        pct: Math.round((100 * group.supported) / group.denominator),
        complete: group.complete,
      }
    }),
  }
}
