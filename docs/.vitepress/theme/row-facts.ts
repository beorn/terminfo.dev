/**
 * #37761: the one set of facts every per-terminal bar row and every per-terminal result row reads: the short name
 * (no platform words, no "(term)"), the platform as an icon, the bar's categories, and how one feature reads as a
 * popover or list row. Home, the Baseline pages and the feature pages call these, so no page keeps its own copy.
 */
import type { ProbeData } from "../../data/probes.data.ts"
import { categoryIds, categoryIdsWithin, categoryOf, type CategoryId } from "../../data/result-categories.ts"
import { platformIcon } from "./platform-icons.ts"

type RowData = Pick<
  ProbeData,
  "meta" | "selectedByBackend" | "releaseBars" | "featureDescriptions" | "features" | "platformLabels" | "notes"
>

export interface FeatureRow {
  readonly id: string
  readonly name: string
  readonly href?: string
  readonly note?: string
}

export function rowFacts(data: RowData) {
  const featureSlug = (id: string) => data.featureDescriptions[id]?.slug ?? id.replace(/\./gu, "-")
  let featureHrefs: Map<string, string> | undefined
  const featureHref = (id: string) => {
    featureHrefs ??= new Map(
      data.features.map((feature) => [feature.id, `/${feature.category}/${featureSlug(feature.id)}`]),
    )
    return featureHrefs.get(id)
  }
  const describers = new Map<string, (featureId: string, category: CategoryId) => FeatureRow>()
  const withinCache = new Map<string, Record<CategoryId, readonly string[]> | undefined>()

  const os = (key: string): string | null => data.selectedByBackend[key]?.selected.subject?.os ?? null
  const platform = (key: string): string | undefined => {
    const id = os(key)
    return id ? (data.platformLabels?.[id] ?? id) : undefined
  }
  const within = (key: string, featureIds: readonly string[], scope: string) => {
    const cacheKey = `${key}|${scope}`
    if (!withinCache.has(cacheKey)) {
      const bar = data.releaseBars[key]
      withinCache.set(cacheKey, bar ? categoryIdsWithin(bar, featureIds) : undefined)
    }
    return withinCache.get(cacheKey)
  }
  return {
    featureHref,
    termHref: (key: string) => `/terminals/${data.meta[key]?.slug ?? key}`,
    /** Beside its platform icon a name never repeats the platform (shortLabel); "(term)" is never printed. */
    name: (key: string) => data.meta[key]?.shortLabel ?? data.meta[key]?.label ?? key,
    os,
    platform,
    /** A terminal's hover (#37761 item 10): name · platform, one line, website. No run ids, suite ids or times. */
    about: (key: string) => {
      const meta = data.meta[key]
      const name = meta?.shortLabel ?? meta?.label ?? key
      const line = meta?.description?.split(/(?<=[.!?])\s/u)[0]
      return [[name, platform(key)].filter(Boolean).join(" · "), line, meta?.url].filter(Boolean).join("\n")
    },
    icon: (key: string) => {
      const id = os(key)
      return id ? platformIcon(id) : ""
    },
    ids: (key: string) => {
      const bar = data.releaseBars[key]
      return bar ? categoryIds(bar) : undefined
    },
    /** The same categories limited to one feature set (a Baseline); `scope` names the set for the cache. */
    within,
    /** Supported over the set's features (#37761 7b), so it matches the bar and never counts an untested feature. */
    percentWithin: (key: string, featureIds: readonly string[], scope: string) => {
      const ids = within(key, featureIds, scope)
      return ids && featureIds.length ? `${Math.round((ids.supported.length / featureIds.length) * 100)}%` : ""
    },
    /** One feature's category in this terminal's bar: the mark and colour its result row shows. */
    categoryOf: (key: string, featureId: string) => categoryOf(data.releaseBars[key], featureId),
    /** One feature as a popover row: its name, a link to its result, and the result's reason unless Supported. */
    describe: (key: string) => {
      if (!describers.has(key)) {
        const results = data.selectedByBackend[key]?.selected.featureResults ?? {}
        describers.set(key, (featureId, category) => ({
          id: featureId,
          name: data.featureDescriptions[featureId]?.name ?? featureId,
          href: featureHref(featureId),
          note:
            category === "supported" || category === "no-result"
              ? undefined
              : (data.notes[key]?.[featureId] ?? results[featureId]?.reason),
        }))
      }
      return describers.get(key)!
    },
  }
}
