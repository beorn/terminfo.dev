import { loadProbes, featureSlug, catLabel, terminalSlug, loadAnalysis, loadFeaturesMeta } from "../data/load-probes"
import { linkifyContent } from "../data/linkify-content"

export default {
  paths() {
    const data = loadProbes()
    const featuresMeta = loadFeaturesMeta()

    // Build terminal info list with stats
    const terminals = data.backends.map((b) => {
      const meta = data.meta[b.name] ?? {}
      const stats = data.stats[b.name]
      if (!stats) throw new Error(`Missing site statistics for selected terminal ${b.name}`)
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
    for (const [index, left] of terminals.entries()) {
      for (const right of terminals.slice(index + 1)) {
        // Always put alphabetically-first slug as A for deterministic URLs
        const [a, b] = left.slug.localeCompare(right.slug) <= 0 ? [left, right] : [right, left]

        // Build per-feature results for both terminals
        const catResults = categories.map((cat) => ({
          name: cat.name,
          label: cat.label,
          features: cat.features.map((f) => {
            const resultA = data.results[a.name]?.[f.id] ?? "unknown"
            const resultB = data.results[b.name]?.[f.id] ?? "unknown"
            const noteA = data.selectedByBackend[a.name]?.selected.cells[f.id]?.note ?? ""
            const noteB = data.selectedByBackend[b.name]?.selected.cells[f.id]?.note ?? ""
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
            if (f.resultA === "yes" && f.resultB === "no") onlyA++
            if (f.resultB === "yes" && f.resultA === "no") onlyB++
            if ((f.resultA === "yes" && f.resultB === "no") || (f.resultA === "no" && f.resultB === "yes")) differ++
          }
        }

        const compareId = `${a.slug}-vs-${b.slug}`
        const an = allAnalysis["compare/" + compareId]

        pairs.push({
          params: {
            id: compareId,
            termAId: a.name,
            termBId: b.name,
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
            termAPct: a.stats.pct === null ? "" : String(a.stats.pct),
            termBPct: b.stats.pct === null ? "" : String(b.stats.pct),
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
            analysis: linkifyContent(an?.analysis ?? ""),
            analysisDate: an?.date ?? "",
            analysisChanges: an?.changes ?? "",
          },
        })
      }
    }

    return pairs
  },
}
