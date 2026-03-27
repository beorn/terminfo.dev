import { readFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { loadProbes, featureSlug, catLabel, terminalSlug, loadAnalysis } from "../data/load-probes"
import { linkifyContent } from "../data/linkify-content"

const __dirname = dirname(fileURLToPath(import.meta.url))

interface HistoricalTerminal {
  label: string
  slug: string
  url?: string
  description?: string
  body?: string
  platforms?: string[]
  historical?: boolean
  year?: number
  manufacturer?: string
  cpu?: string
  significance?: string
  repo?: string
}

export default {
  paths() {
    const data = loadProbes()
    const allAnalysis = loadAnalysis()

    const pages = data.backends.map((b) => {
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
          tags: string[]
          specUrl: string
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
            tags: desc?.tags ?? [],
            specUrl: desc?.url ?? "",
          }
        })
        categories.push({
          name: cat,
          label: catLabel(cat),
          features: catFeatures,
        })
      }

      const terminal = (meta as any).terminal ?? {}

      const a = allAnalysis["terminals/" + slug]

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
          terminalName: (meta as any).label ?? terminal.name ?? b.name,
          terminalDescription: (meta as any).description ?? terminal.description ?? "",
          terminalBody: (meta as any).body ?? terminal.body ?? "",
          terminalUrl: meta.url ?? terminal.url ?? "",
          terminalRepo: (meta as any).repo ?? terminal.repo ?? "",
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
          analysis: a?.analysis ?? "",
          analysisDate: a?.date ?? "",
          analysisChanges: a?.changes ?? "",
          historical: "false",
        },
      }
    })

    // Load terminals.json for historical terminals and terminal type classification
    const terminalsPath = join(__dirname, "..", "..", "content", "terminals.json")
    const terminalsData = JSON.parse(readFileSync(terminalsPath, "utf-8")) as Record<
      string,
      HistoricalTerminal & { intermediary?: boolean; headlessBackends?: string[] }
    >

    // Classify terminal type from terminals.json metadata
    function getTerminalType(backendName: string): string {
      for (const [, entry] of Object.entries(terminalsData)) {
        if (entry.slug === terminalSlug(backendName, data.meta)) {
          if (entry.historical) return "historical"
          if (entry.intermediary) return "mux"
          // JS-package terminals with headless backends are libraries
          if (entry.headlessBackends?.length && entry.label?.endsWith(".js")) return "headless"
          if (entry.headlessBackends?.length) return "app+headless"
          return "app"
        }
      }
      return "app"
    }

    // Enrich pages with terminal type
    for (const page of pages) {
      ;(page.params as any).terminalType = getTerminalType(page.params.backendId)
    }

    const existingSlugs = new Set(pages.map((p) => p.params.id))

    for (const [termId, term] of Object.entries(terminalsData)) {
      if (!term.historical) continue
      if (existingSlugs.has(term.slug)) continue

      const a = allAnalysis["terminals/" + term.slug]

      pages.push({
        params: {
          id: term.slug,
          backendId: termId,
          backendName: term.label,
          backendDescription: "",
          backendUrl: "",
          backendUpstream: "",
          backendType: "",
          backendCaveat: "",
          terminalName: term.label,
          terminalDescription: term.description ?? "",
          terminalBody: term.body ?? "",
          terminalUrl: term.url ?? "",
          terminalRepo: term.repo ?? "",
          terminalAuthor: "",
          version: "",
          engine: "",
          generated: "",
          total: "",
          yes: "",
          no: "",
          partial: "",
          pct: "",
          categories: "",
          analysis: a?.analysis ?? "",
          analysisDate: a?.date ?? "",
          analysisChanges: a?.changes ?? "",
          historical: "true",
          terminalType: "historical",
          year: String(term.year ?? ""),
          manufacturer: term.manufacturer ?? "",
          significance: term.significance ?? "",
        } as any,
      })
    }

    return pages
  },
}
