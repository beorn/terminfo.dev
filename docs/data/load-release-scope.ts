/**
 * Node-only loader for the Release 1 measurement scope and the candidate-2 classic cohort.
 *
 * Both are DERIVED from the catalogs, never from a declaration file (@cto 2026-10-12, item 3): the
 * declared tier-1 rows are the catalog rows `slice()` labels `tier1` (52 `included`, ten `excluded`),
 * and the candidate-2 cohort is every catalog row whose CATEGORY slice is `classics` (125). The two
 * scope files (`content/release-scope.json`, `content/release-scope-candidate2.json`) are deleted; a
 * release's frozen suite is the one suite manifest whose `freeze.release` names it.
 */
import { splitAppObservable } from "@terminfo/probe-defs"
import { slice, type FeatureCatalog, type Slice, type SliceCatalog } from "@terminfo/catalog"
import type { ReleaseFeature, ReleaseScope } from "./release-scope.ts"
export { frozenSuiteIdFor } from "../../packages/admin/suite-manifest.ts"

/** Release 1's own two constants, the ones its tier line prints. */
const RELEASE_1_TIER = 1
const RELEASE_1_METHOD = "query/reply"

/** The category facts the classic cohort order needs: its slice label and its site order. */
export interface CohortCategoryMeta {
  slice: Slice
  order: number
}

export interface FeatureCohort {
  name: "candidate2"
  frozenSuiteId: string
  measuredIds: string[]
  /** The cohort ids an APP run can decide, in cohort order — the scored denominator. */
  scoredIds: string[]
  /** The cohort rows an app run cannot decide, in cohort order, named and never scored. */
  libraryOnlyIds: string[]
}

/**
 * The candidate-2 cohort in its published order: every catalog row whose CATEGORY slice is `classics`,
 * category by category in the category catalog's own `order`, each category's ids ascending. That is
 * the ONE category order the site prints (@cto 2026-10-12, item 3), so the cohort cannot disagree
 * with the category blocks beside it. The two classic rows that also carry a `tier1` field stay IN
 * the cohort: the filter is the category's slice, matching 28018's accepted 125.
 */
export function classicCohortIds(
  catalog: FeatureCatalog,
  categories: Readonly<Record<string, CohortCategoryMeta>>,
): string[] {
  const classic = Object.entries(categories)
    .filter(([, category]) => category.slice === "classics")
    .sort((left, right) => left[1].order - right[1].order)
  const ids: string[] = []
  for (const [key] of classic) {
    const prefix = `${key}.`
    for (const id of Object.keys(catalog)
      .filter((id) => id.startsWith(prefix))
      .sort()) {
      ids.push(id)
    }
  }
  if (ids.length === 0) {
    throw new Error('classics cohort is empty: no category carries slice "classics"')
  }
  return ids
}

/** The candidate-2 cohort derived from the catalog, with the release's frozen suite named. */
export function loadFeatureCohort(args: {
  catalog: FeatureCatalog
  categories: Readonly<Record<string, CohortCategoryMeta>>
  frozenSuiteId: string
}): FeatureCohort {
  const measuredIds = classicCohortIds(args.catalog, args.categories)
  const { scoredIds, libraryOnlyIds } = splitAppObservable(measuredIds)
  return {
    name: "candidate2",
    frozenSuiteId: args.frozenSuiteId,
    measuredIds,
    scoredIds: [...scoredIds],
    libraryOnlyIds: [...libraryOnlyIds],
  }
}

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
