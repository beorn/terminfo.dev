import { loadProbes, featureSlug, catLabel, terminalSlug, loadAnalysis, loadFeaturesMeta } from "../data/load-probes"
import { linkifyContent } from "../data/linkify-content"

export default {
  paths() {
    const data = loadProbes()
    const featuresMeta = loadFeaturesMeta()

    // Build terminal info list with stats
    const terminals = data.backends.map((b) => {
      const meta = data.meta[b.name] ?? {}
      const stats = data.stats[b.name] ?? { total: 0, yes: 0, no: 0, partial: 0, pct: 0 }
      const slug = terminalSlug(b.name, data.meta)
      return {
        name: b.name,
        slug,
        label: meta.label ?? b.name,
        description: meta.description ?? "",
        url: meta.url ?? "",
        type: meta.type ?? "",
        stats,
      }
    })

    // Build categories with features for comparison
    const categories: Array<{
      name: string
      label: string
      features: Array<{
        id: string
        slug: string
        category: string
        name: string
        tags: string[]
        url: string
      }>
    }> = []

    for (const [cat, features] of Object.entries(data.categories)) {
      categories.push({
        name: cat,
        label: catLabel(cat),
        features: features.map((f) => {
          const desc = data.featureDescriptions[f.id]
          return {
            id: f.id,
            slug: featureSlug(f.id),
            category: f.category,
            name: desc?.name ?? f.name,
            tags: featuresMeta[f.id]?.tags ?? [],
            url: featuresMeta[f.id]?.url ?? "",
          }
        }),
      })
    }

    const allAnalysis = loadAnalysis()

    // Generate all unique pairs (alphabetical slug order for deterministic URLs)
    const pairs = []
    for (let i = 0; i < terminals.length; i++) {
      for (let j = i + 1; j < terminals.length; j++) {
        // Always put alphabetically-first slug as A for deterministic URLs
        const [a, b] =
          terminals[i]!.slug.localeCompare(terminals[j]!.slug) <= 0
            ? [terminals[i]!, terminals[j]!]
            : [terminals[j]!, terminals[i]!]

        // Build per-feature results for both terminals
        const catResults = categories.map((cat) => ({
          name: cat.name,
          label: cat.label,
          features: cat.features.map((f) => {
            const resultA = data.results[a.name]?.[f.id] ?? "unknown"
            const resultB = data.results[b.name]?.[f.id] ?? "unknown"
            const annA = data.annotations?.[`${a.name}:${f.id}`]
            const annB = data.annotations?.[`${b.name}:${f.id}`]
            const noteA = annA?.note ?? data.notes[a.name]?.[f.id] ?? ""
            const noteB = annB?.note ?? data.notes[b.name]?.[f.id] ?? ""
            return {
              id: f.id,
              slug: f.slug,
              category: f.category,
              name: f.name,
              tags: f.tags,
              url: f.url,
              resultA,
              resultB,
              noteA,
              noteB,
            }
          }),
        }))

        // Count features unique to each terminal
        let onlyA = 0
        let onlyB = 0
        let differ = 0
        for (const cat of catResults) {
          for (const f of cat.features) {
            const aPass = f.resultA === "yes" || f.resultA === "partial"
            const bPass = f.resultB === "yes" || f.resultB === "partial"
            if (aPass && !bPass) onlyA++
            if (bPass && !aPass) onlyB++
            if (f.resultA !== f.resultB) differ++
          }
        }

        const compareId = `${a.slug}-vs-${b.slug}`
        const an = allAnalysis["compare/" + compareId]

        pairs.push({
          params: {
            id: compareId,
            termASlug: a.slug,
            termBSlug: b.slug,
            termALabel: a.label,
            termBLabel: b.label,
            termADescription: a.description,
            termBDescription: b.description,
            termAUrl: a.url,
            termBUrl: b.url,
            termAType: a.type,
            termBType: b.type,
            termAPct: String(a.stats.pct),
            termBPct: String(b.stats.pct),
            termAPass: String(a.stats.yes),
            termBPass: String(b.stats.yes),
            termAPartial: String(a.stats.partial),
            termBPartial: String(b.stats.partial),
            termATotal: String(a.stats.total),
            termBTotal: String(b.stats.total),
            onlyA: String(onlyA),
            onlyB: String(onlyB),
            differ: String(differ),
            categories: JSON.stringify(catResults),
            analysis: an?.analysis ?? "",
            analysisDate: an?.date ?? "",
            analysisChanges: an?.changes ?? "",
          },
        })
      }
    }

    return pairs
  },
}
