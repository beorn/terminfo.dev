import {
  loadCensus,
  featureSlug,
  catLabel,
  categoryDescriptions,
  terminalSlug,
  loadFeaturesMeta,
  getAllTags,
  getFeaturesForTag,
  tagLabel,
  tagDescriptions,
  tagUrls,
} from "./data/load-census"

export default {
  paths() {
    const data = loadCensus()
    const featuresMeta = loadFeaturesMeta()

    // Sort backends by score (highest first)
    const sortedBackends = [...data.backends].sort((a, b) => {
      const aPct = data.stats[a.name]?.pct ?? 0
      const bPct = data.stats[b.name]?.pct ?? 0
      return bPct - aPct
    })

    const backends = sortedBackends.map((b) => ({
      name: b.name,
      slug: terminalSlug(b.name, data.meta),
      label: data.meta[b.name]?.label ?? b.name,
      version: b.version,
    }))

    // --- Category pages ---
    const categoryPages = Object.entries(data.categories).map(([cat, features]) => {
      const featureRows = features.map((f) => {
        const desc = data.featureDescriptions[f.id]
        const results: Record<string, { result: string; note: string }> = {}
        for (const b of sortedBackends) {
          const result = data.results[b.name]?.[f.id] ?? "unknown"
          const ann = data.annotations?.[`${b.name}:${f.id}`]
          const note = ann?.note ?? data.notes[b.name]?.[f.id] ?? ""
          results[b.name] = { result, note }
        }
        return {
          id: f.id,
          slug: featureSlug(f.id),
          category: cat,
          name: desc?.name ?? f.name,
          url: featuresMeta[f.id]?.url ?? "",
          tags: featuresMeta[f.id]?.tags ?? [],
          results,
        }
      })

      return {
        params: {
          id: cat,
          pageType: "category",
          categoryName: catLabel(cat),
          categoryDescription: categoryDescriptions[cat] ?? "",
          featureCount: String(features.length),
          features: JSON.stringify(featureRows),
          backends: JSON.stringify(backends),
        },
      }
    })

    // --- Tag pages ---
    const tags = getAllTags()
    const tagPages = tags.map((tag) => {
      const featureIds = getFeaturesForTag(tag)

      const featureRows = featureIds.map((fid) => {
        const desc = data.featureDescriptions[fid]
        const category = fid.split(".")[0]
        const results: Record<string, { result: string; note: string }> = {}
        for (const b of sortedBackends) {
          const result = data.results[b.name]?.[fid] ?? "unknown"
          const ann = data.annotations?.[`${b.name}:${fid}`]
          const note = ann?.note ?? data.notes[b.name]?.[fid] ?? ""
          results[b.name] = { result, note }
        }
        return {
          id: fid,
          slug: featureSlug(fid),
          category,
          name: desc?.name ?? fid,
          url: featuresMeta[fid]?.url ?? "",
          tags: featuresMeta[fid]?.tags ?? [],
          results,
        }
      })

      return {
        params: {
          id: tag,
          pageType: "tag",
          categoryName: tagLabel(tag),
          categoryDescription: tagDescriptions[tag] ?? "",
          specUrl: tagUrls[tag] ?? "",
          featureCount: String(featureIds.length),
          features: JSON.stringify(featureRows),
          backends: JSON.stringify(backends),
        },
      }
    })

    return [...categoryPages, ...tagPages]
  },
}
