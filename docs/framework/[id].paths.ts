import { loadProbes, terminalSlug, loadAnalysis } from "../data/load-probes"
import { readFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))

interface FrameworkMeta {
  label: string
  url: string
  repo: string
  language: string
  runtime: string
  description: string
  baseline: string
  body: string
}

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

    // Load frameworks.json
    const frameworksPath = join(__dirname, "..", "..", "content", "frameworks.json")
    const frameworks = JSON.parse(readFileSync(frameworksPath, "utf-8")) as Record<string, FrameworkMeta>

    // Load baselines.json
    const baselinesPath = join(__dirname, "..", "..", "content", "baselines.json")
    const baselines = JSON.parse(readFileSync(baselinesPath, "utf-8")) as Record<string, BaselineMeta>

    // Sort backends by score (highest first)
    const sortedBackends = [...data.backends].sort((a, b) => {
      const aPct = data.stats[a.name]?.pct ?? 0
      const bPct = data.stats[b.name]?.pct ?? 0
      return bPct - aPct
    })

    const allAnalysis = loadAnalysis()

    return Object.entries(frameworks).map(([id, fw]) => {
      const bl = baselines[fw.baseline]
      const baselineFeatureIds = data.baselines[fw.baseline] ?? []

      // Compute per-backend scores for the required baseline
      const scores = sortedBackends.map((b) => {
        const bs = data.baselineStats[b.name]?.[fw.baseline]
        // Count partial results for this baseline's features
        let partial = 0
        for (const fid of baselineFeatureIds) {
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

      const a = allAnalysis["framework/" + id]

      return {
        params: {
          id,
          label: fw.label,
          url: fw.url,
          repo: fw.repo,
          language: fw.language,
          runtime: fw.runtime,
          description: fw.description,
          baseline: fw.baseline,
          baselineLabel: bl?.label ?? fw.baseline,
          baselineEmoji: bl?.emoji ?? "",
          baselineColor: bl?.color ?? "",
          baselineTagline: bl?.tagline ?? "",
          body: fw.body,
          featureCount: String(baselineFeatureIds.length),
          scores: JSON.stringify(scores),
          analysis: a?.analysis ?? "",
          analysisDate: a?.date ?? "",
          analysisChanges: a?.changes ?? "",
        },
      }
    })
  },
}
