/**
 * Node-only loader for the Release 1 measurement scope, derived from catalog tier labels.
 * A release's frozen suite is the one suite manifest whose `freeze.release` names it.
 */
import { splitAppObservable } from "@terminfo/probe-defs"
import { slice, type FeatureCatalog, type SliceCatalog } from "@terminfo/catalog"
import type { ReleaseFeature, ReleaseScope } from "./release-scope.ts"
export { frozenSuiteIdFor } from "../../packages/admin/suite-manifest.ts"

/** Release 1's own two constants, the ones its tier line prints. */
const RELEASE_1_TIER = 1
const RELEASE_1_METHOD = "query/reply"

/**
 * The Release 1 tier-1 scope, derived from the catalog: every row `slice()` labels `tier1`. The
 * unmeasured rows keep the reader's own name and status, in catalog-id order.
 */
export function loadReleaseScope(args: { catalog: FeatureCatalog; categories: SliceCatalog }): ReleaseScope {
  const catalogIds = Object.keys(args.catalog)
  const measuredIds = catalogIds.filter((id) => slice(args.catalog, args.categories, id) === "tier1").sort()
  if (measuredIds.length === 0) throw new Error("Release 1 scope is empty: no catalog row carries a tier1 field")
  const { scoredIds, libraryOnlyIds } = splitAppObservable(measuredIds)
  const measured = new Set(measuredIds)
  const unmeasured: ReleaseFeature[] = []
  for (const id of catalogIds) {
    if (measured.has(id)) continue
    const entry = args.catalog[id]
    if (!entry) throw new Error(`catalog lost ${id} while listing unmeasured features`)
    unmeasured.push({ id, name: entry.name, status: "not measured in this release" })
  }
  unmeasured.sort((left, right) => left.id.localeCompare(right.id))
  return {
    tier: RELEASE_1_TIER,
    method: RELEASE_1_METHOD,
    measuredIds,
    scoredIds: [...scoredIds],
    libraryOnlyIds: [...libraryOnlyIds],
    measuredCount: measuredIds.length,
    catalogCount: catalogIds.length,
    unmeasured,
  }
}
