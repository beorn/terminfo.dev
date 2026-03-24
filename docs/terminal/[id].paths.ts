import { loadCensus, featureSlug, catLabel, terminalSlug } from "../data/load-census"

export default {
  paths() {
    const data = loadCensus()

    return data.backends.map((b) => {
      const meta = data.meta[b.name] ?? {}
      const stats = data.stats[b.name] ?? { total: 0, yes: 0, no: 0, partial: 0, pct: 0 }
      const slug = terminalSlug(b.name, data.meta)

      // Build feature results grouped by category
      const categories: Array<{
        name: string
        label: string
        features: Array<{
          id: string
          slug: string
          category: string
          name: string
          result: string
          note: string
        }>
      }> = []

      for (const [cat, features] of Object.entries(data.categories)) {
        const catFeatures = features.map((f) => {
          const result = data.results[b.name]?.[f.id] ?? "unknown"
          const ann = data.annotations?.[`${b.name}:${f.id}`]
          const note = ann?.note ?? data.notes[b.name]?.[f.id] ?? ""
          const desc = data.featureDescriptions[f.id]
          return {
            id: f.id,
            slug: featureSlug(f.id),
            category: f.category,
            name: desc?.name ?? f.name,
            result,
            note,
          }
        })
        categories.push({
          name: cat,
          label: catLabel(cat),
          features: catFeatures,
        })
      }

      const terminal = (meta as any).terminal ?? {}

      return {
        params: {
          id: slug,
          backendId: b.name,
          backendName: meta.label ?? b.name,
          backendDescription: meta.description ?? "",
          backendUrl: meta.url ?? "",
          backendUpstream: meta.upstream ?? "",
          backendType: meta.type ?? "",
          backendCaveat: meta.caveat ?? "",
          // Terminal app info (separate from backend)
          terminalName: terminal.name ?? meta.label ?? b.name,
          terminalDescription: terminal.description ?? "",
          terminalBody: terminal.body ?? "",
          terminalUrl: terminal.url ?? meta.url ?? "",
          terminalRepo: terminal.repo ?? "",
          terminalAuthor: terminal.author ?? "",
          version: b.version,
          engine: b.engine,
          generated: data.generated,
          total: String(stats.total),
          yes: String(stats.yes),
          no: String(stats.no),
          partial: String(stats.partial),
          pct: String(stats.pct),
          categories: JSON.stringify(categories),
        },
      }
    })
  },
}
