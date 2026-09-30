import { readFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { loadProbes, featureSlug, catLabel, terminalSlug, loadAnalysis } from "../data/load-probes"
import { linkifyContentExcluding } from "../data/linkify-content"

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

interface VersionInfo {
  version: string
  total: number
  yes: number
  pct: number | null
}

/** Versions displayed on a terminal page come only from reviewed, exact-context runs. */
function versionsForBackend(data: ReturnType<typeof loadProbes>, backendName: string): VersionInfo[] {
  const current = data.selectedByBackend[backendName]
  if (!current) return []
  const contextKey = current?.contextKey
  const versions = (contextKey ? (data.selected.versions[contextKey] ?? []) : [])
    .filter(
      (selected) =>
        selected.target.id === current?.selected.target.id && selected.target.kind === current.selected.target.kind,
    )
    .map((selected) => ({
      version: selected.target.version,
      total: selected.counts.conclusive,
      yes: selected.counts.supported,
      pct:
        selected.counts.conclusive > 0
          ? Math.round((selected.counts.supported / selected.counts.conclusive) * 100)
          : null,
    }))
  return versions.sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }))
}

export default {
  paths() {
    const data = loadProbes()
    const allAnalysis = loadAnalysis()

    const pages: Array<{ params: Record<string, string> }> = data.backends.map((b) => {
      const meta = data.meta[b.name] ?? {}
      const stats = data.stats[b.name]
      if (!stats) throw new Error(`Missing site statistics for selected terminal ${b.name}`)
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
          const note = data.selectedByBackend[b.name]?.selected.cells[f.id]?.note ?? ""
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

      const terminal = meta.terminal ?? {}

      const selected = data.selectedByBackend[b.name]?.selected
      // A parser and its app can share a public slug; measured analysis belongs to the selected run.
      const slugAnalysis = allAnalysis["terminals/" + slug]
      const a =
        selected && selected.counts.conclusive > 0
          ? Object.entries(allAnalysis).find(
              ([key, entry]) => key.startsWith("terminals/") && entry.runSha256 === selected.sha256,
            )?.[1]
          : slugAnalysis?.runSha256
            ? undefined
            : slugAnalysis
      if (selected && selected.counts.conclusive > 0 && !a) {
        throw new Error(`Missing terminal analysis for ${b.name} selected run ${selected.sha256}`)
      }

      // Load all version results for this backend
      const versions = versionsForBackend(data, b.name)
      const otherRuns = selected
        ? Object.values(data.selected.versions)
            .flat()
            .filter(
              (run) =>
                run.target.id === selected.target.id &&
                run.target.kind === selected.target.kind &&
                run.sha256 !== selected.sha256,
            )
        : []

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
          terminalName: meta.label ?? terminal.name ?? b.name,
          terminalDescription: meta.description ?? terminal.description ?? "",
          terminalBody: linkifyContentExcluding(meta.body ?? terminal.body ?? "", new Set([`/terminals/${slug}`])),
          terminalUrl: meta.url ?? terminal.url ?? "",
          terminalRepo: meta.repo ?? terminal.repo ?? "",
          terminalAuthor: terminal.author ?? "",
          version: b.version,
          engine: b.engine,
          generated: selected?.measuredAt ?? "",
          runSha256: selected?.sha256 ?? "",
          suiteFreshness: selected?.suiteFreshness ?? "",
          total: String(stats.total),
          yes: String(stats.yes),
          no: String(stats.no),
          partial: String(stats.partial),
          pct: stats.pct === null ? "" : String(stats.pct),
          categories: JSON.stringify(categories),
          versions: JSON.stringify(versions),
          otherRuns: JSON.stringify(otherRuns),
          analysis: linkifyContentExcluding(a?.analysis ?? "", new Set([`/terminals/${slug}`])),
          analysisDate: a?.date ?? "",
          analysisChanges: a?.changes ?? "",
          historical: "false",
          terminalType: "app",
        },
      }
    })

    // Load terminals.json for historical terminals and terminal type classification
    const terminalsPath = join(__dirname, "..", "..", "content", "terminals.json")
    const terminalsData = JSON.parse(readFileSync(terminalsPath, "utf-8")) as Record<
      string,
      HistoricalTerminal & {
        kind?: "app" | "headless" | "mux"
        intermediary?: boolean
        headlessBackends?: string[]
        manifestBackend?: string
      }
    >

    // Classify terminal type from terminals.json metadata
    function getTerminalType(backendName: string): string {
      const selectedKind = data.selectedByBackend[backendName]?.selected.target.kind
      if (selectedKind) return selectedKind
      for (const [, entry] of Object.entries(terminalsData)) {
        if (entry.slug === terminalSlug(backendName, data.meta)) {
          if (entry.historical) return "historical"
          if (entry.kind === "headless" || entry.kind === "mux") return entry.kind
          if (entry.headlessBackends?.length) return "app+headless"
          return "app"
        }
      }
      return "app"
    }

    // Enrich pages with terminal type
    for (const page of pages) {
      page.params.terminalType = getTerminalType(page.params.backendId ?? "")
    }

    const existingSlugs = new Set(pages.map((p) => p.params.id))

    // Add pages for ALL terminals in terminals.json that don't have probe results
    // This covers: historical terminals, unprobed terminals (like cmux), and metadata-only entries
    for (const [termId, term] of Object.entries(terminalsData)) {
      if (existingSlugs.has(term.slug)) continue

      const a = allAnalysis["terminals/" + term.slug]

      // A declared parser engine is metadata, not evidence about this app's behavior.
      const inheritedFrom = ""
      const inheritedFromLabel = ""
      const inheritedStats = {
        version: "",
        engine: "",
        generated: "",
        total: "",
        yes: "",
        no: "",
        partial: "",
        pct: "",
        categories: "",
        versions: "",
      }

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
          terminalBody: linkifyContentExcluding(term.body ?? "", new Set([`/terminals/${term.slug}`])),
          terminalUrl: term.url ?? "",
          terminalRepo: term.repo ?? "",
          terminalAuthor: "",
          version: inheritedStats.version,
          engine: inheritedStats.engine,
          generated: inheritedStats.generated,
          total: inheritedStats.total,
          yes: inheritedStats.yes,
          no: inheritedStats.no,
          partial: inheritedStats.partial,
          pct: inheritedStats.pct,
          categories: inheritedStats.categories,
          versions: inheritedStats.versions ?? "",
          inheritedFrom,
          inheritedFromLabel,
          inheritedFromSlug: inheritedFrom ? terminalSlug(inheritedFrom, data.meta) : "",
          analysis: linkifyContentExcluding(a?.analysis ?? "", new Set([`/terminals/${term.slug}`])),
          analysisDate: a?.date ?? "",
          analysisChanges: a?.changes ?? "",
          historical: term.historical ? "true" : "false",
          terminalType: term.historical ? "historical" : (term.kind ?? "app"),
          year: String(term.year ?? ""),
          manufacturer: term.manufacturer ?? "",
          significance: term.significance ?? "",
        },
      })
    }

    return pages
  },
}
