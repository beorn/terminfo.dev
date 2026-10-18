/**
 * Node-only loader for the Release 1 measurement scope and the feature cohorts.
 *
 * Everything here is DERIVED from the catalogs, never from a declaration file: the declared tier-1
 * rows are the catalog rows `slice()` labels `tier1`, and a cohort is the catalog rows whose CATEGORY
 * slice is one of the cohort's slices, in the category catalog's own order. A release's frozen suite
 * is the one suite manifest whose `freeze.release` names it.
 */
import { splitAppObservable } from "@terminfo/probe-defs"
import { slice, type FeatureCatalog, type Slice, type SliceCatalog } from "@terminfo/catalog"
import type { ReleaseFeature, ReleaseScope } from "./release-scope.ts"
import { orderedCategoryIds } from "./categories.ts"
export { frozenSuiteIdFor, frozenSuiteLineage } from "../../packages/admin/suite-manifest.ts"

/** Release 1's own two constants, the ones its tier line prints. */
const RELEASE_1_TIER = 1
const RELEASE_1_METHOD = "query/reply"

/** The category facts a cohort's order needs: its slice label and its site order. */
export interface CohortCategoryMeta {
  slice: Slice
  order: number
}

export type FeatureCohortName = "candidate2" | "candidate3" | "candidate4"

export interface FeatureCohort {
  name: FeatureCohortName
  frozenSuiteId: string
  measuredIds: string[]
  /** The cohort ids an APP run can decide, in cohort order — the scored denominator. */
  scoredIds: string[]
  /** The cohort rows an app run cannot decide, in cohort order, named and never scored. */
  libraryOnlyIds: string[]
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

/** One cohort derived from the catalog, with the suite its reading is taken on named. */
export function loadFeatureCohort(args: {
  catalog: FeatureCatalog
  categories: Readonly<Record<string, CohortCategoryMeta>>
  name: FeatureCohortName
  slices: readonly Slice[]
  excludingTier1: boolean
  frozenSuiteId: string
}): FeatureCohort {
  const measuredIds = cohortIds(args.catalog, args.categories, args.slices, {
    excludingTier1: args.excludingTier1,
  })
  const { scoredIds, libraryOnlyIds } = splitAppObservable(measuredIds)
  return {
    name: args.name,
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
