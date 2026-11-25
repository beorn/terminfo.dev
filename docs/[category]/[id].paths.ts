import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { loadFeatures } from "@terminfo/catalog"
import {
  loadProbes,
  featureSlug,
  terminalSlug,
  tagLabel as getTagLabel,
  catLabel,
  loadAnalysis,
} from "../data/load-probes"
import { linkifyContentExcluding } from "../data/linkify-content"
import { probeStatusOf } from "../data/probe-status"
import { isPublishedStatus } from "../data/app-cells"

const __dirname = dirname(fileURLToPath(import.meta.url))
const contentDir = join(__dirname, "..", "..", "content")

/**
 * The route of one feature's page, as this loader builds it: `/<category>/<id>`. docs/public/_redirects sends each
 * hidden feature's old page to its category page, and its test derives those URLs from here, never by hand.
 */
export function featurePageParams(featureId: string): { category: string; id: string } {
  const category = featureId.split(".")[0]
  if (!category) throw new Error(`Feature ${featureId} has no category, so it has no page route`)
  return { category, id: featureSlug(featureId) }
}

export default {
  paths() {
    const data = loadProbes()
    const featuresMeta = loadFeatures(contentDir)
    const allAnalysis = loadAnalysis()

    return data.features.map((f) => {
      const { category, id: slug } = featurePageParams(f.id)
      const desc = data.featureDescriptions[f.id]
      const meta = featuresMeta[f.id]

      // Build per-backend results for this feature
      const backendResults: Array<{
        name: string
        slug: string
        label: string
        description: string
        version: string
        type: string
        result: string
        note: string
      }> = []

      for (const b of data.backends) {
        // #37341 Q1: an absent result is no result yet, so its row reads "unknown" and carries no note. A result we
        // haven't decided never reaches this page; one that does is a loader bug, refused here rather than counted.
        const result = data.results[b.name]?.[f.id] ?? "unknown"
        if (result !== "unknown" && !isPublishedStatus(result)) {
          throw new Error(`${b.name}: ${f.id} reached the feature page with undecided result ${JSON.stringify(result)}`)
        }
        const note = result === "unknown" ? "" : (data.notes[b.name]?.[f.id] ?? "")
        const bmeta = data.meta[b.name]
        backendResults.push({
          name: b.name,
          slug: terminalSlug(b.name, data.meta),
          label: bmeta?.label ?? b.name,
          description: bmeta?.description ?? "",
          version: b.versions.join(", "),
          type: b.type ?? "lib",
          result,
          note,
        })
      }

      // Sort: yes first, then partial, then no/unknown
      backendResults.sort((a, b) => {
        const order: Record<string, number> = {
          supported: 0,
          unsupported: 1,
          untestable: 2,
        }
        return (order[a.result] ?? 3) - (order[b.result] ?? 3)
      })

      const yesCount = backendResults.filter((r) => r.result === "supported").length
      // Subjects with a decided result for this feature; a result we haven't decided is not counted.
      const totalCount = backendResults.filter((r) => isPublishedStatus(r.result)).length
      const noResultCount = backendResults.length - totalCount

      // Build tags with labels for display
      const tags = (meta?.tags ?? []).map((t: string) => ({
        id: t,
        label: getTagLabel(t),
      }))

      // Detect sub-features by prefix (e.g., extensions.kitty-keyboard.* for extensions.kitty-keyboard)
      const subFeatures: Array<{
        id: string
        name: string
        slug: string
        results: Record<string, string> // backend name -> result
      }> = []
      const prefix = f.id + "."
      for (const sf of data.features) {
        if (sf.id.startsWith(prefix) && sf.id.split(".").length === f.id.split(".").length + 1) {
          const sfDesc = data.featureDescriptions[sf.id]
          const sfResults: Record<string, string> = {}
          for (const b of data.backends) {
            sfResults[b.name] = data.results[b.name]?.[sf.id] ?? "unknown"
          }
          subFeatures.push({
            id: sf.id,
            name: sfDesc?.name ?? sf.name,
            slug: featureSlug(sf.id),
            results: sfResults,
          })
        }
      }

      // Detect parent feature (e.g., extensions.kitty-keyboard for extensions.kitty-keyboard.disambiguate)
      const parts = f.id.split(".")
      let parentFeatureId = ""
      let parentFeatureName = ""
      let parentFeatureSlug = ""
      if (parts.length >= 3) {
        // Try progressively shorter prefixes to find the parent
        for (let i = parts.length - 1; i >= 2; i--) {
          const candidate = parts.slice(0, i).join(".")
          const parentDesc = data.featureDescriptions[candidate]
          if (parentDesc) {
            parentFeatureId = candidate
            parentFeatureName = parentDesc.name ?? candidate
            parentFeatureSlug = featureSlug(candidate)
            break
          }
        }
      }

      const a = allAnalysis[`${f.category}/${slug}`]
      const selfHrefs = new Set([`/${f.category}/${slug}`])

      return {
        params: {
          category,
          id: slug,
          featureId: f.id,
          featureName: desc?.name ?? f.name,
          featureCategory: f.category,
          categoryLabel: catLabel(f.category),
          specUrl: desc?.url ?? f.spec ?? "",
          featureBody: linkifyContentExcluding(meta?.body ?? "", selfHrefs),
          probeMethod: linkifyContentExcluding(meta?.probe ?? "", selfHrefs),
          baseline: meta?.baseline ?? "",
          probeStatus: probeStatusOf(f.id, featuresMeta),
          sequence: meta?.sequence ?? "",
          featureTags: JSON.stringify(tags),
          backendResults: JSON.stringify(backendResults),
          yesCount: String(yesCount),
          totalCount: String(totalCount),
          noResultCount: String(noResultCount),
          analysis: linkifyContentExcluding(a?.analysis ?? "", selfHrefs),
          analysisDate: a?.date ?? "",
          analysisChanges: a?.changes ?? "",
          parentFeatureId,
          parentFeatureName,
          parentFeatureSlug,
          subFeatures: JSON.stringify(subFeatures),
          backendNames: JSON.stringify(
            data.backends.map((b) => ({
              name: b.name,
              label: data.meta[b.name]?.label ?? b.name,
              slug: terminalSlug(b.name, data.meta),
              type: b.type ?? "lib",
            })),
          ),
        },
      }
    })
  },
}
