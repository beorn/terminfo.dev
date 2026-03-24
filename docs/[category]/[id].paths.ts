import { loadCensus, featureSlug, terminalSlug } from "../data/load-census"

export default {
  paths() {
    const data = loadCensus()

    return data.features.map((f) => {
      const slug = featureSlug(f.id)
      const desc = data.featureDescriptions[f.id]

      // Build per-backend results for this feature
      const backendResults: Array<{
        name: string
        slug: string
        label: string
        version: string
        result: string
        note: string
      }> = []

      for (const b of data.backends) {
        const result = data.results[b.name]?.[f.id] ?? "unknown"
        const ann = data.annotations?.[`${b.name}:${f.id}`]
        const note = ann?.note ?? data.notes[b.name]?.[f.id] ?? ""
        backendResults.push({
          name: b.name,
          slug: terminalSlug(b.name, data.meta),
          label: data.meta[b.name]?.label ?? b.name,
          version: b.version,
          result,
          note,
        })
      }

      // Sort: yes first, then partial, then no/unknown
      backendResults.sort((a, b) => {
        const order: Record<string, number> = { yes: 0, partial: 1, no: 2, unknown: 3 }
        return (order[a.result] ?? 3) - (order[b.result] ?? 3)
      })

      const yesCount = backendResults.filter((r) => r.result === "yes").length
      const totalCount = backendResults.length

      return {
        params: {
          category: f.category,
          id: slug,
          featureId: f.id,
          featureName: desc?.name ?? f.name,
          featureCategory: f.category,
          specUrl: desc?.url ?? f.spec ?? "",
          backendResults: JSON.stringify(backendResults),
          yesCount: String(yesCount),
          totalCount: String(totalCount),
        },
      }
    })
  },
}
