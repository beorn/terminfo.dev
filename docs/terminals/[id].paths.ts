import { readFileSync, readdirSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { loadProbes, featureSlug, catLabel, terminalSlug, loadAnalysis } from "../data/load-probes"
import { linkifyContentExcluding } from "../data/linkify-content"

const __dirname = dirname(fileURLToPath(import.meta.url))
const contentDir = join(__dirname, "..", "..", "content")
const probesAppsDir = join(contentDir, "probes-apps")
const probesMuxDir = join(contentDir, "probes-mux")
const probesLibsDir = join(contentDir, "probes-libs")

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
  pct: number
}

/**
 * Scan probe result directories for all version files matching a backend.
 * Applies annotation overrides for consistency with the main score.
 * Returns version info sorted newest-first (by version string, numeric sort).
 */
function loadVersionsForBackend(
  backendName: string,
  backendType?: string,
  annotations?: Record<string, { note: string; result?: string }>,
): VersionInfo[] {
  const versions: VersionInfo[] = []

  // Collect annotation result overrides for this backend
  const resultOverrides: Record<string, string> = {}
  if (annotations) {
    for (const [key, ann] of Object.entries(annotations)) {
      if (!ann.result) continue
      const [backend, ...fp] = key.split(":")
      if (backend === backendName) {
        resultOverrides[fp.join(":")] = ann.result
      }
    }
  }

  /** Count "yes" results after applying annotation overrides */
  function countYes(rawResults: Record<string, any>, isBoolean: boolean): { total: number; yes: number } {
    const entries = Object.entries(rawResults)
    let yes = 0
    for (const [id, val] of entries) {
      const override = resultOverrides[id]
      if (override) {
        if (override === "yes") yes++
      } else if (isBoolean) {
        if (val === true) yes++
      } else {
        if (val === "yes") yes++
      }
    }
    return { total: entries.length, yes }
  }

  if (backendType === "headless" || !backendType) {
    // Scan probes-libs/ for files with this backend name
    try {
      for (const file of readdirSync(probesLibsDir).filter((f) => f.endsWith(".json") && f !== "unified.json")) {
        try {
          const raw = JSON.parse(readFileSync(join(probesLibsDir, file), "utf-8")) as any
          if (raw.backend !== backendName) continue
          const { total, yes } = countYes(raw.results ?? {}, true)
          versions.push({
            version: raw.version ?? "",
            total,
            yes,
            pct: total > 0 ? Math.round((yes / total) * 100) : 0,
          })
        } catch {}
      }
    } catch {}
  }

  if (backendType === "app" || backendType === "mux" || !backendType) {
    // Scan probes-apps/ and probes-mux/ for files with this terminal name
    const dirs = backendType === "mux" ? [probesMuxDir] : [probesAppsDir, probesMuxDir]
    for (const dir of dirs) {
      try {
        for (const file of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
          try {
            const raw = JSON.parse(readFileSync(join(dir, file), "utf-8")) as any
            if (raw.terminal !== backendName) continue
            const { total, yes } = countYes(raw.results ?? {}, true)
            versions.push({
              version: raw.terminalVersion ?? "",
              total,
              yes,
              pct: total > 0 ? Math.round((yes / total) * 100) : 0,
            })
          } catch {}
        }
      } catch {}
    }
  }

  // Deduplicate by version (keep the entry with most probes)
  const byVersion = new Map<string, VersionInfo>()
  for (const v of versions) {
    const existing = byVersion.get(v.version)
    if (!existing || v.total > existing.total) {
      byVersion.set(v.version, v)
    }
  }

  // Sort newest first (numeric version sort)
  return [...byVersion.values()].sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }))
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

      // Load all version results for this backend
      const versions = loadVersionsForBackend(b.name, b.type, data.annotations)

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
          terminalBody: linkifyContentExcluding(
            (meta as any).body ?? terminal.body ?? "",
            new Set([`/terminals/${slug}`]),
          ),
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
          versions: JSON.stringify(versions),
          analysis: linkifyContentExcluding(a?.analysis ?? "", new Set([`/terminals/${slug}`])),
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
      HistoricalTerminal & {
        intermediary?: boolean
        headlessBackends?: string[]
        manifestBackend?: string
      }
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

    // Index probed pages by backendId so unprobed terminals can inherit via manifestBackend
    const pagesByBackendId = new Map<string, (typeof pages)[number]>()
    for (const page of pages) {
      pagesByBackendId.set(page.params.backendId, page)
    }

    const existingSlugs = new Set(pages.map((p) => p.params.id))

    // Add pages for ALL terminals in terminals.json that don't have probe results
    // This covers: historical terminals, unprobed terminals (like cmux), and metadata-only entries
    for (const [termId, term] of Object.entries(terminalsData)) {
      if (existingSlugs.has(term.slug)) continue

      const a = allAnalysis["terminals/" + term.slug]

      // If this terminal declares a manifestBackend, inherit probe results from it.
      // This lets terminals like cmux (built on libghostty) show Ghostty's feature data
      // without running separate probes. We do NOT recurse: the inherited page must
      // itself have probe results, otherwise we fall back to an empty page.
      let inheritedFrom = ""
      let inheritedFromLabel = ""
      let inheritedStats: {
        version: string
        engine: string
        generated: string
        total: string
        yes: string
        no: string
        partial: string
        pct: string
        categories: string
        versions?: string
      } = {
        version: "",
        engine: "",
        generated: "",
        total: "",
        yes: "",
        no: "",
        partial: "",
        pct: "",
        categories: "",
      }

      const backendName = term.manifestBackend
      if (backendName) {
        const source = pagesByBackendId.get(backendName)
        // Only inherit if source has actual probe results (total !== "")
        if (source?.params?.total) {
          inheritedFrom = backendName
          inheritedFromLabel = (source.params as any).terminalName ?? backendName
          inheritedStats = {
            version: source.params.version ?? "",
            engine: (source.params as any).engine ?? "",
            generated: source.params.generated ?? "",
            total: source.params.total ?? "",
            yes: source.params.yes ?? "",
            no: source.params.no ?? "",
            partial: source.params.partial ?? "",
            pct: source.params.pct ?? "",
            categories: source.params.categories ?? "",
            versions: (source.params as any).versions ?? "",
          }
        }
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
          terminalType: term.historical ? "historical" : (term as any).intermediary ? "mux" : "app",
          year: String(term.year ?? ""),
          manufacturer: term.manufacturer ?? "",
          significance: term.significance ?? "",
        } as any,
      })
    }

    return pages
  },
}
