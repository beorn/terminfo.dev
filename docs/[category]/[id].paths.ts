import { loadProbes, featureSlug, terminalSlug, loadFeaturesMeta, tagLabel as getTagLabel, loadAnalysis } from "../data/load-probes"

export default {
  paths() {
    const data = loadProbes()
    const featuresMeta = loadFeaturesMeta()
    const allAnalysis = loadAnalysis()

    return data.features.map((f) => {
      const slug = featureSlug(f.id)
      const desc = data.featureDescriptions[f.id]
      const meta = featuresMeta[f.id]

      // Build per-backend results for this feature
      const backendResults: Array<{
        name: string
        slug: string
        label: string
        description: string
        version: string
        type: string
        result: string
        note: string
        url: string
      }> = []

      for (const b of data.backends) {
        const result = data.results[b.name]?.[f.id] ?? "unknown"
        const ann = data.annotations?.[`${b.name}:${f.id}`]
        const note = ann?.note ?? data.notes[b.name]?.[f.id] ?? ""
        const url = ann?.url ?? ""
        const bmeta = data.meta[b.name]
        backendResults.push({
          name: b.name,
          slug: terminalSlug(b.name, data.meta),
          label: bmeta?.label ?? b.name,
          description: bmeta?.description ?? "",
          version: b.version,
          type: b.type ?? "headless",
          result,
          note,
          url,
        })
      }

      // Sort: yes first, then partial, then no/unknown
      backendResults.sort((a, b) => {
        const order: Record<string, number> = { yes: 0, partial: 1, no: 2, unknown: 3 }
        return (order[a.result] ?? 3) - (order[b.result] ?? 3)
      })

      const yesCount = backendResults.filter((r) => r.result === "yes").length
      const totalCount = backendResults.length

      // Build tags with labels for display
      const tags = (meta?.tags ?? []).map((t: string) => ({
        id: t,
        label: getTagLabel(t),
      }))

      const a = allAnalysis[`${f.category}/${slug}`]

      return {
        params: {
          category: f.category,
          id: slug,
          featureId: f.id,
          featureName: desc?.name ?? f.name,
          featureCategory: f.category,
          specUrl: desc?.url ?? f.spec ?? "",
          featureBody: meta?.body ?? "",
          probeMethod: meta?.probe ?? "",
          featureTags: JSON.stringify(tags),
          backendResults: JSON.stringify(backendResults),
          yesCount: String(yesCount),
          totalCount: String(totalCount),
          analysis: a?.analysis ?? "",
          analysisDate: a?.date ?? "",
          analysisChanges: a?.changes ?? "",
        },
      }
    })
  },
}
