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
import { linkifyContentExcluding } from "./data/linkify-content"

const __dirname = dirname(fileURLToPath(import.meta.url))

/** Load terminals.json for historical terminal body content */
function loadTerminals(): Record<string, { body?: string; [k: string]: unknown }> {
  const path = join(__dirname, "..", "content", "terminals.json")
  return JSON.parse(readFileSync(path, "utf-8")) as Record<string, { body?: string }>
}

/** Map standard/tag IDs to their corresponding historical terminal entry in terminals.json */
const tagToHistoricalTerminal: Record<string, string> = {
  vt100: "vt100-historical",
  vt220: "vt220-historical",
  vt510: "vt510-historical",
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

    // Collect tags that collide with categories — their features will be merged
    const allTags = getAllTags()
    const collidingTags = new Set(allTags.filter((tag) => Object.keys(data.categories).includes(tag)))

    const categoryPages = Object.entries(data.categories).map(([cat, features]) => {
      // If this category ID also matches a tag, merge tagged features from other categories
      const taggedIds = collidingTags.has(cat) ? new Set(getFeaturesForTag(cat)) : new Set<string>()
      const categoryFeatureIds = new Set(features.map((f) => f.id))

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

      // Add tagged features not already in the category (e.g. text.wide.* tagged "unicode")
      for (const fid of taggedIds) {
        if (categoryFeatureIds.has(fid)) continue
        const desc = data.featureDescriptions[fid]
        if (!desc) continue
        const fcat = fid.split(".")[0]
        const results: Record<string, { result: string; note: string }> = {}
        for (const b of sortedBackends) {
          const result = data.results[b.name]?.[fid] ?? "unknown"
          const ann = data.annotations?.[`${b.name}:${fid}`]
          const note = ann?.note ?? data.notes[b.name]?.[fid] ?? ""
          results[b.name] = { result, note }
        }
        featureRows.push({
          id: fid,
          slug: featureSlug(fid),
          category: fcat,
          name: desc?.name ?? fid,
          url: featuresMeta[fid]?.url ?? "",
          tags: featuresMeta[fid]?.tags ?? [],
          results,
        })
      }

      const a = allAnalysis[cat]

      // If this category ID also exists as a standard/tag, include body content
      const catBody = tagBodies[cat] ?? ""
      const catHistTermKey = tagToHistoricalTerminal[cat]
      const catHistBody = catHistTermKey ? (terminals[catHistTermKey]?.body ?? "") : ""

      const selfHrefs = new Set([`/${cat}`])

      return {
        params: {
          id: cat,
          pageType: "category",
          categoryName: catLabel(cat),
          categoryDescription: linkifyContentExcluding(categoryDescriptions[cat] ?? "", selfHrefs),
          body: linkifyContentExcluding(catBody, selfHrefs),
          historicalBody: linkifyContentExcluding(catHistBody, selfHrefs),
          specUrl: tagUrls[cat] ?? "",
          featureCount: String(featureRows.length),
          features: JSON.stringify(featureRows),
          backends: JSON.stringify(backends),
          analysis: linkifyContentExcluding(a?.analysis ?? "", selfHrefs),
          analysisDate: a?.date ?? "",
          analysisChanges: a?.changes ?? "",
        },
      }
    })

    // --- Tag pages ---
    // Skip tags that collide with category IDs — those features are merged into the category page
    const tags = allTags.filter((tag) => !collidingTags.has(tag))
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

      // Sort features by sequence number extracted from names
      // Matches: "Hyperlinks (OSC 8)" → 8, "OSC 52 clipboard write" → 52, "Bold (SGR 1)" → 1
      featureRows.sort((a, b) => {
        const numA = a.name.match(/(?:^|\()(?:OSC|SGR|CSI)\s+(\d+)/)
        const numB = b.name.match(/(?:^|\()(?:OSC|SGR|CSI)\s+(\d+)/)
        if (numA && numB) return parseInt(numA[1], 10) - parseInt(numB[1], 10)
        if (numA) return -1
        if (numB) return 1
        return a.name.localeCompare(b.name)
      })

      const a = allAnalysis[tag]

      // Historical terminal body for standards with a corresponding hardware terminal
      const histTermKey = tagToHistoricalTerminal[tag]
      const histBody = histTermKey ? (terminals[histTermKey]?.body ?? "") : ""

      const selfHrefs = new Set([`/${tag}`])

      return {
        params: {
          id: tag,
          pageType: "tag",
          categoryName: tagLabel(tag),
          categoryDescription: linkifyContentExcluding(tagDescriptions[tag] ?? "", selfHrefs),
          specUrl: tagUrls[tag] ?? "",
          body: linkifyContentExcluding(tagBodies[tag] ?? "", selfHrefs),
          historicalBody: linkifyContentExcluding(histBody, selfHrefs),
          featureCount: String(featureIds.length),
          features: JSON.stringify(featureRows),
          backends: JSON.stringify(backends),
          analysis: linkifyContentExcluding(a?.analysis ?? "", selfHrefs),
          analysisDate: a?.date ?? "",
          analysisChanges: a?.changes ?? "",
        },
      }
    })

    return [...categoryPages, ...tagPages]
  },
}
