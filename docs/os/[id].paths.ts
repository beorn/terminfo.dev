import { readFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { loadProbes, terminalSlug, loadPlatformsMeta } from "../data/load-probes"

const __dirname = dirname(fileURLToPath(import.meta.url))
const contentDir = join(__dirname, "..", "..", "content")

interface TerminalMeta {
  label: string
  slug: string
  url?: string
  description?: string
  headlessBackends?: string[]
  manifestBackend?: string
  intermediary?: boolean
  historical?: boolean
}

interface TerminalRow {
  id: string
  label: string
  slug: string
  url: string
  description: string
  kind: "app" | "parser" | "mux"
  score: string
  yes: string
  total: string
  evidence: string
  evidenceKind: "measured" | "parser" | "inherited" | "reference" | "unprobed"
  sourceBackendId: string
  sourcePlatforms: string
  note: string
}

function loadTerminals(): Record<string, TerminalMeta> {
  return JSON.parse(readFileSync(join(contentDir, "terminals.json"), "utf-8")) as Record<string, TerminalMeta>
}

export default {
  paths() {
    const data = loadProbes()
    const platforms = loadPlatformsMeta()
    const terminals = loadTerminals()

    function backendLabel(name: string): string {
      return data.meta[name]?.label ?? terminals[name]?.label ?? name
    }

    function findBackend(name: string, type?: string) {
      return data.backends.find((b) => b.name === name && (!type || b.type === type))
    }

    function rowForTerminal(id: string, platformId: string, kind: "app" | "parser" | "mux"): TerminalRow | null {
      const term = terminals[id]
      if (!term) return null

      const app = findBackend(id, kind === "mux" ? "mux" : "app")
      const parserName = term.headlessBackends?.find((b) => findBackend(b, "headless"))
      const parser = parserName ? findBackend(parserName, "headless") : undefined
      const inherited = term.manifestBackend ? findBackend(term.manifestBackend) : undefined

      let source = app
      let evidenceKind: TerminalRow["evidenceKind"] = "unprobed"
      let evidence = "Not probed"
      let note = "No automated probe data is currently available."

      if (app?.platforms?.includes(platformId)) {
        evidenceKind = "measured"
        evidence =
          kind === "mux"
            ? `Multiplexer probe on ${platforms[platformId]?.label}`
            : `App probe on ${platforms[platformId]?.label}`
        note = "Platform-specific full-stack probe."
      } else if (inherited?.platforms?.includes(platformId) && inherited.name !== id) {
        source = inherited
        evidenceKind = "inherited"
        evidence = `Inherited from ${backendLabel(inherited.name)}`
        note =
          inherited.type === "headless"
            ? "Uses the underlying parser/backend reference score; not a platform-specific app probe."
            : "Uses the same underlying terminal engine; not probed separately."
      } else if (parser?.platforms?.includes(platformId)) {
        source = parser
        evidenceKind = "parser"
        evidence = "Parser probe"
        note = "Parser/state-machine coverage only; renderer, font, input, and compositor behavior are not included."
      } else if (app) {
        source = app
        evidenceKind = "reference"
        evidence = `${(app.platforms ?? []).map((p) => platforms[p]?.label ?? p).join(", ")} app probe only`
        note = `Available on ${platforms[platformId]?.label}, but not yet app-probed on this OS.`
      } else if (inherited && inherited.name !== id) {
        source = inherited
        evidenceKind = "reference"
        evidence = `Reference from ${backendLabel(inherited.name)}`
        note = "Engine-equivalent reference score; not a platform-specific app probe."
      } else if (parser) {
        source = parser
        evidenceKind = "parser"
        evidence = "Parser probe"
        note = "Parser/state-machine coverage only; no full app probe is currently available."
      }

      const stats = source ? data.stats[source.name] : undefined
      const slug = term.slug ?? (source ? terminalSlug(source.name, data.meta) : id)

      return {
        id,
        label: term.label,
        slug,
        url: term.url ?? "",
        description: term.description ?? "",
        kind,
        score: stats?.total ? String(stats.pct) : "",
        yes: stats?.total ? String(stats.yes) : "",
        total: stats?.total ? String(stats.total) : "",
        evidence,
        evidenceKind,
        sourceBackendId: stats?.total && source ? source.name : "",
        sourcePlatforms: source?.platforms?.map((p) => platforms[p]?.label ?? p).join(", ") ?? "",
        note,
      }
    }

    function rowsFor(ids: string[], platformId: string, kind: "app" | "parser" | "mux"): TerminalRow[] {
      return ids.map((id) => rowForTerminal(id, platformId, kind)).filter((row): row is TerminalRow => row !== null)
    }

    return Object.entries(platforms).map(([id, platform]) => {
      const appRows = rowsFor(platform.appTerminalIds ?? [], id, "app")
      const parserRows = rowsFor(platform.parserBackendIds ?? [], id, "parser")
      const muxRows = rowsFor(platform.multiplexerIds ?? [], id, "mux")
      const allRows = [...appRows, ...parserRows, ...muxRows]
      const measuredAppCount = appRows.filter((r) => r.evidenceKind === "measured").length
      const scoredCount = allRows.filter((r) => r.sourceBackendId).length

      return {
        params: {
          id: platform.slug,
          label: platform.label,
          tagline: platform.tagline,
          description: platform.description,
          appRows: JSON.stringify(appRows),
          parserRows: JSON.stringify(parserRows),
          muxRows: JSON.stringify(muxRows),
          gapRows: JSON.stringify(platform.untrackedTerminals ?? []),
          notes: JSON.stringify(platform.notes ?? []),
          sources: JSON.stringify(platform.sources ?? []),
          appCount: String(appRows.length),
          measuredAppCount: String(measuredAppCount),
          parserCount: String(parserRows.length),
          muxCount: String(muxRows.length),
          scoredCount: String(scoredCount),
          gapCount: String(platform.untrackedTerminals?.length ?? 0),
        },
      }
    })
  },
}
