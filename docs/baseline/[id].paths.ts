import { loadProbes, featureSlug, terminalSlug, loadFeaturesMeta, loadAnalysis } from "../data/load-probes"
import { linkifyContentExcluding } from "../data/linkify-content"
import { readFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))

interface BaselineMeta {
  label: string
  emoji: string
  color: string
  order: number
  tagline: string
  description: string
  forDevelopers: string
  forTerminalAuthors: string
}

export default {
  paths() {
    const data = loadProbes()
    const featuresMeta = loadFeaturesMeta()

    // Load baselines.json
    const baselinesPath = join(__dirname, "..", "..", "content", "baselines.json")
    const baselines = JSON.parse(readFileSync(baselinesPath, "utf-8")) as Record<string, BaselineMeta>

    // Sort backends by score (highest first)
    const sortedBackends = [...data.backends].sort((a, b) => {
      const aPct = data.stats[a.name]?.pct ?? 0
      const bPct = data.stats[b.name]?.pct ?? 0
      return bPct - aPct
    })

    const backends = sortedBackends.map((b) => ({
      name: b.name,
      slug: terminalSlug(b.name, data.meta),
      label: data.meta[b.name]?.label ?? b.name,
      description: data.meta[b.name]?.description ?? "",
      url: data.meta[b.name]?.url ?? "",
      version: b.version,
      type: b.type ?? "headless",
      platforms: b.platforms ?? [],
    }))

    const allAnalysis = loadAnalysis()

    return Object.entries(baselines).map(([id, bl]) => {
      // Get feature IDs in this baseline
      const featureIds = data.baselines[id] ?? []

      const featureRows = featureIds.map((fid) => {
        const desc = data.featureDescriptions[fid]
        const category = fid.split(".")[0]
        const results: Record<string, { result: string; note: string }> = {}
        for (const b of sortedBackends) {
          const result = data.results[b.name]?.[fid] ?? "unknown"
          const ann = data.annotations?.[`${b.name}:${fid}`]
          const note = ann?.note ?? data.notes[b.name]?.[fid] ?? ""
          results[b.name] = { result, note }
        }
        return {
          id: fid,
          slug: featureSlug(fid),
          category,
          name: desc?.name ?? fid,
          url: featuresMeta[fid]?.url ?? "",
          tags: featuresMeta[fid]?.tags ?? [],
          results,
        }
      })

      // Compute per-backend scores for this baseline
      const scores = sortedBackends.map((b) => {
        const bs = data.baselineStats[b.name]?.[id]
        // Count partial results for this baseline's features
        let partial = 0
        for (const fid of featureIds) {
          if (data.results[b.name]?.[fid] === "partial") partial++
        }
        return {
          name: b.name,
          slug: terminalSlug(b.name, data.meta),
          label: data.meta[b.name]?.label ?? b.name,
          description: data.meta[b.name]?.description ?? "",
          url: data.meta[b.name]?.url ?? "",
          version: b.version,
          type: b.type ?? "headless",
          platforms: b.platforms ?? [],
          yes: bs?.yes ?? 0,
          partial,
          total: bs?.total ?? 0,
          pct: bs?.pct ?? 0,
        }
      })

      const a = allAnalysis["baseline/" + id]

      return {
        params: {
          id,
          label: bl.label,
          emoji: bl.emoji,
          color: bl.color,
          tagline: bl.tagline,
          description: bl.description,
          forDevelopers: bl.forDevelopers,
          forTerminalAuthors: bl.forTerminalAuthors,
          featureCount: String(featureIds.length),
          features: JSON.stringify(featureRows),
          backends: JSON.stringify(backends),
          scores: JSON.stringify(scores),
          analysis: linkifyContentExcluding(a?.analysis ?? "", new Set([`/baseline/${id}`])),
          analysisDate: a?.date ?? "",
          analysisChanges: a?.changes ?? "",
        },
      }
    })
  },
}
