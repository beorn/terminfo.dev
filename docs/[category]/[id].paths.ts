import {
  loadProbes,
  featureSlug,
  terminalSlug,
  loadFeaturesMeta,
  tagLabel as getTagLabel,
  catLabel,
  loadAnalysis,
} from "../data/load-probes"
import { linkifyContentExcluding } from "../data/linkify-content"

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

      // Detect sub-features by prefix (e.g., extensions.kitty-keyboard.* for extensions.kitty-keyboard)
      const subFeatures: Array<{
        id: string
        name: string
        slug: string
        results: Record<string, string> // backend name -> result
      }> = []
      const prefix = f.id + "."
      for (const sf of data.features) {
        if (sf.id.startsWith(prefix) && sf.id.split(".").length === f.id.split(".").length + 1) {
          const sfDesc = data.featureDescriptions[sf.id]
          const sfResults: Record<string, string> = {}
          for (const b of data.backends) {
            sfResults[b.name] = data.results[b.name]?.[sf.id] ?? "unknown"
          }
          subFeatures.push({
            id: sf.id,
            name: sfDesc?.name ?? sf.name,
            slug: featureSlug(sf.id),
            results: sfResults,
          })
        }
      }

      // Detect parent feature (e.g., extensions.kitty-keyboard for extensions.kitty-keyboard.disambiguate)
      const parts = f.id.split(".")
      let parentFeatureId = ""
      let parentFeatureName = ""
      let parentFeatureSlug = ""
      if (parts.length >= 3) {
        // Try progressively shorter prefixes to find the parent
        for (let i = parts.length - 1; i >= 2; i--) {
          const candidate = parts.slice(0, i).join(".")
          const parentDesc = data.featureDescriptions[candidate]
          if (parentDesc) {
            parentFeatureId = candidate
            parentFeatureName = parentDesc.name ?? candidate
            parentFeatureSlug = featureSlug(candidate)
            break
          }
        }
      }

      const a = allAnalysis[`${f.category}/${slug}`]
      const selfHrefs = new Set([`/${f.category}/${slug}`])

      return {
        params: {
          category: f.category,
          id: slug,
          featureId: f.id,
          featureName: desc?.name ?? f.name,
          featureCategory: f.category,
          categoryLabel: catLabel(f.category),
          specUrl: desc?.url ?? f.spec ?? "",
          featureBody: linkifyContentExcluding(meta?.body ?? "", selfHrefs),
          probeMethod: linkifyContentExcluding(meta?.probe ?? "", selfHrefs),
          sequence: (meta as any)?.sequence ?? "",
          featureTags: JSON.stringify(tags),
          backendResults: JSON.stringify(backendResults),
          yesCount: String(yesCount),
          totalCount: String(totalCount),
          analysis: linkifyContentExcluding(a?.analysis ?? "", selfHrefs),
          analysisDate: a?.date ?? "",
          analysisChanges: a?.changes ?? "",
          parentFeatureId,
          parentFeatureName,
          parentFeatureSlug,
          subFeatures: JSON.stringify(subFeatures),
          backendNames: JSON.stringify(
            data.backends.map((b) => ({
              name: b.name,
              label: data.meta[b.name]?.label ?? b.name,
              slug: terminalSlug(b.name, data.meta),
              type: b.type ?? "headless",
            })),
          ),
        },
      }
    })
  },
}
