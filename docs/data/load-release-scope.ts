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

export type FeatureCohortName = "candidate2" | "candidate4"

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
 * category order the site prints (@cto 2026-10-12, item 3), so the cohort cannot disagree with the
 * category blocks beside it. Candidate 2 keeps every classic row, including the two that carry a
 * `tier1` field, because its filter is the category's slice (28018's accepted 125). Candidate 4 is
 * the tier it ADDS, so it asks for `excludingTier1` and drops exactly the rows already labelled tier 1.
 */
export function cohortIds(
  catalog: FeatureCatalog,
  categories: Readonly<Record<string, CohortCategoryMeta>>,
  slices: readonly Slice[],
  options: { readonly excludingTier1?: boolean } = {},
): string[] {
  const wanted = new Set<string>(slices)
  const selected = Object.entries(categories)
    .filter(([, category]) => wanted.has(category.slice))
    .sort((left, right) => left[1].order - right[1].order)
  const ids: string[] = []
  for (const [key] of selected) {
    const prefix = `${key}.`
    for (const id of Object.keys(catalog)
      .filter((id) => id.startsWith(prefix))
      .sort()) {
      // A tier-1 row is measured by its own release; candidate 4 is the tier this cohort ADDS, so it
      // drops exactly those rows. The exclusion is data, never a per-cohort branch in a reader.
      if (options.excludingTier1 && catalog[id]?.tier1 !== undefined) continue
      ids.push(id)
    }
  }
  if (ids.length === 0) {
    throw new Error(
      `cohort is empty: no category carries any of the slices ${slices.join(", ") || "(none given)"}` +
        (options.excludingTier1 ? " after excluding the tier-1 rows" : ""),
    )
  }
  return ids
}

/** The candidate-2 cohort derived from the catalog, with the release's frozen suite named. */
export function loadFeatureCohort(args: {
  catalog: FeatureCatalog
  categories: Readonly<Record<string, CohortCategoryMeta>>
  name: FeatureCohortName
  slices: readonly Slice[]
  excludingTier1?: boolean
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
