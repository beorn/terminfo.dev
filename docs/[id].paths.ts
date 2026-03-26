import { readFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import {
  loadProbes,
  featureSlug,
  catLabel,
  categoryDescriptions,
  terminalSlug,
  loadFeaturesMeta,
  getAllTags,
  getFeaturesForTag,
  tagLabel,
  tagDescriptions,
  tagUrls,
  tagBodies,
  loadAnalysis,
} from "./data/load-probes"
import { linkifyContent } from "./data/linkify-content"

const __dirname = dirname(fileURLToPath(import.meta.url))

/** Load terminals.json for historical terminal body content */
function loadTerminals(): Record<string, { body?: string; [k: string]: unknown }> {
  const path = join(__dirname, "..", "content", "terminals.json")
  return JSON.parse(readFileSync(path, "utf-8")) as Record<string, { body?: string }>
}

/** Map standard/tag IDs to their corresponding historical terminal entry in terminals.json */
const tagToHistoricalTerminal: Record<string, string> = {
  "vt100": "vt100-historical",
  "vt220": "vt220-historical",
  "vt510": "vt510-historical",
  "xterm-extensions": "xterm-historical",
}

export default {
  paths() {
    const data = loadProbes()
    const featuresMeta = loadFeaturesMeta()

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

    // --- Category pages ---
    // Load terminals early so category pages can include historical body
    // when a category ID matches a standard/tag ID (e.g. "unicode")
    const terminals = loadTerminals()

    const categoryPages = Object.entries(data.categories).map(([cat, features]) => {
      const featureRows = features.map((f) => {
        const desc = data.featureDescriptions[f.id]
        const results: Record<string, { result: string; note: string }> = {}
        for (const b of sortedBackends) {
          const result = data.results[b.name]?.[f.id] ?? "unknown"
          const ann = data.annotations?.[`${b.name}:${f.id}`]
          const note = ann?.note ?? data.notes[b.name]?.[f.id] ?? ""
          results[b.name] = { result, note }
        }
        return {
          id: f.id,
          slug: featureSlug(f.id),
          category: cat,
          name: desc?.name ?? f.name,
          url: featuresMeta[f.id]?.url ?? "",
          tags: featuresMeta[f.id]?.tags ?? [],
          results,
        }
      })

      const a = allAnalysis[cat]

      // If this category ID also exists as a standard/tag, include body content
      const catBody = tagBodies[cat] ?? ""
      const catHistTermKey = tagToHistoricalTerminal[cat]
      const catHistBody = catHistTermKey ? terminals[catHistTermKey]?.body ?? "" : ""

      return {
        params: {
          id: cat,
          pageType: "category",
          categoryName: catLabel(cat),
          categoryDescription: linkifyContent(categoryDescriptions[cat] ?? ""),
          body: linkifyContent(catBody),
          historicalBody: linkifyContent(catHistBody),
          specUrl: tagUrls[cat] ?? "",
          featureCount: String(features.length),
          features: JSON.stringify(featureRows),
          backends: JSON.stringify(backends),
          analysis: a?.analysis ?? "",
          analysisDate: a?.date ?? "",
          analysisChanges: a?.changes ?? "",
        },
      }
    })

    // --- Tag pages ---
    const tags = getAllTags()
    const tagPages = tags.map((tag) => {
      const featureIds = getFeaturesForTag(tag)

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

      const a = allAnalysis[tag]

      // Historical terminal body for standards with a corresponding hardware terminal
      const histTermKey = tagToHistoricalTerminal[tag]
      const histBody = histTermKey ? terminals[histTermKey]?.body ?? "" : ""

      return {
        params: {
          id: tag,
          pageType: "tag",
          categoryName: tagLabel(tag),
          categoryDescription: linkifyContent(tagDescriptions[tag] ?? ""),
          specUrl: tagUrls[tag] ?? "",
          body: linkifyContent(tagBodies[tag] ?? ""),
          historicalBody: linkifyContent(histBody),
          featureCount: String(featureIds.length),
          features: JSON.stringify(featureRows),
          backends: JSON.stringify(backends),
          analysis: a?.analysis ?? "",
          analysisDate: a?.date ?? "",
          analysisChanges: a?.changes ?? "",
        },
      }
    })

    return [...categoryPages, ...tagPages]
  },
}
