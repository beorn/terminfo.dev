import { loadCensus, featureSlug, catLabel, categoryDescriptions, terminalSlug } from "./data/load-census"

export default {
  paths() {
    const data = loadCensus()

    // Sort backends by score (highest first)
    const sortedBackends = [...data.backends].sort((a, b) => {
      const aPct = data.stats[a.name]?.pct ?? 0
      const bPct = data.stats[b.name]?.pct ?? 0
      return bPct - aPct
    })

    return Object.entries(data.categories).map(([cat, features]) => {
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
          results,
        }
      })

      const backends = sortedBackends.map((b) => ({
        name: b.name,
        slug: terminalSlug(b.name, data.meta),
        label: data.meta[b.name]?.label ?? b.name,
        version: b.version,
      }))

      return {
        params: {
          id: cat,
          categoryName: catLabel(cat),
          categoryDescription: categoryDescriptions[cat] ?? "",
          featureCount: String(features.length),
          features: JSON.stringify(featureRows),
          backends: JSON.stringify(backends),
        },
      }
    })
  },
}
