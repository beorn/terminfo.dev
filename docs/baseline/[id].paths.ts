import { loadProbes, featureSlug, terminalSlug, loadAnalysis } from "../data/load-probes"
import { linkifyContentExcluding } from "../data/linkify-content"
import { readFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { loadFeatures } from "@terminfo/catalog"

const __dirname = dirname(fileURLToPath(import.meta.url))
const contentDir = join(__dirname, "..", "..", "content")

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
    const featuresMeta = loadFeatures(contentDir)

    // Load baselines.json
    const baselinesPath = join(__dirname, "..", "..", "content", "baselines.json")
    const baselines = JSON.parse(readFileSync(baselinesPath, "utf-8")) as Record<string, BaselineMeta>

    // Keep terminal rows easy to scan. Baseline percentages are subset-specific,
    // so sorting by the global score makes the row order disagree with the values.
    const sortedBackends = [...data.backends].sort((a, b) =>
      (data.meta[a.name]?.label ?? a.name).localeCompare(data.meta[b.name]?.label ?? b.name),
    )

    const backends = sortedBackends.map((b) => ({
      name: b.name,
      slug: terminalSlug(b.name, data.meta),
      label: data.meta[b.name]?.label ?? b.name,
      description: data.meta[b.name]?.description ?? "",
      url: data.meta[b.name]?.url ?? "",
      version: b.versions.join(", "),
      type: b.type ?? "lib",
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
          const note = data.notes[b.name]?.[fid] ?? ""
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
        if (!bs) throw new Error(`Missing ${id} baseline stats for ${b.name}`)
        return {
          name: b.name,
          slug: terminalSlug(b.name, data.meta),
          label: data.meta[b.name]?.label ?? b.name,
          description: data.meta[b.name]?.description ?? "",
          url: data.meta[b.name]?.url ?? "",
          version: b.versions.join(", "),
          type: b.type ?? "lib",
          platforms: b.platforms ?? [],
          score: bs.score,
          counts: bs.counts,
          complete: bs.complete,
          pct: bs.pct,
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
          description: linkifyContentExcluding(bl.description, new Set([`/baseline/${id}`])),
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
