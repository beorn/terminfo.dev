import { loadProbes, featureSlug, catLabel, terminalSlug, loadFeaturesMeta } from "../data/load-probes"
import type { PublicCell, PublicVersion } from "../data/public-results"

function resultFor(cell: PublicCell | undefined): "yes" | "no" | "unknown" {
  if (!cell?.conclusive) return "unknown"
  if (cell.outcome === "supported") return "yes"
  if (cell.outcome === "unsupported") return "no"
  return "unknown"
}

function recordedScope(selected: PublicVersion): unknown[] {
  return [
    selected.target.kind,
    selected.target.os,
    selected.target.osVersion,
    selected.target.outerTerminal,
    selected.target.mux,
    selected.target.config,
    selected.target.permissions,
    selected.suiteId,
    selected.probeHash,
  ]
}

export default {
  paths() {
    const data = loadProbes()
    const featuresMeta = loadFeaturesMeta()

    // Build terminal info from reviewed selected runs.
    const terminals = data.backends.map((b) => {
      const meta = data.meta[b.name] ?? {}
      const selected = data.selectedByBackend[b.name]?.selected
      if (!selected) throw new Error(`Missing selected run for comparison terminal ${b.name}`)
      const slug = terminalSlug(b.name, data.meta)
      return {
        name: b.name,
        slug,
        label: meta.label ?? b.name,
        description: meta.description ?? "",
        url: meta.url ?? "",
        type: meta.type ?? "",
        selected,
      }
    })

    // Build categories with features for comparison
    const categories: Array<{
      name: string
      label: string
      features: Array<{
        id: string
        slug: string
        category: string
        name: string
        tags: string[]
        url: string
      }>
    }> = []

    for (const [cat, features] of Object.entries(data.categories)) {
      categories.push({
        name: cat,
        label: catLabel(cat),
        features: features.map((f) => {
          const desc = data.featureDescriptions[f.id]
          return {
            id: f.id,
            slug: featureSlug(f.id),
            category: f.category,
            name: desc?.name ?? f.name,
            tags: featuresMeta[f.id]?.tags ?? [],
            url: featuresMeta[f.id]?.url ?? "",
          }
        }),
      })
    }

    // Generate all unique pairs (alphabetical slug order for deterministic URLs)
    const pairs = []
    for (const [index, left] of terminals.entries()) {
      for (const right of terminals.slice(index + 1)) {
        // Always put alphabetically-first slug as A for deterministic URLs
        const [a, b] = left.slug.localeCompare(right.slug) <= 0 ? [left, right] : [right, left]

        const targetA = a.selected.target
        const targetB = b.selected.target
        const comparableScope = Boolean(
          targetA.os &&
          targetB.os &&
          a.selected.probeHash &&
          b.selected.probeHash &&
          a.selected.suite.complete &&
          b.selected.suite.complete &&
          JSON.stringify(recordedScope(a.selected)) === JSON.stringify(recordedScope(b.selected)),
        )

        // Build per-feature results for both terminals
        const catResults = categories.map((cat) => ({
          name: cat.name,
          label: cat.label,
          features: cat.features.map((f) => {
            const cellA = a.selected.cells[f.id]
            const cellB = b.selected.cells[f.id]
            const resultA = resultFor(cellA)
            const resultB = resultFor(cellB)
            const comparable = Boolean(
              comparableScope &&
              cellA?.conclusive &&
              cellB?.conclusive &&
              cellA.evidence === cellB.evidence &&
              resultA !== "unknown" &&
              resultB !== "unknown",
            )
            const noteA = cellA?.note ?? ""
            const noteB = cellB?.note ?? ""
            return {
              id: f.id,
              slug: f.slug,
              category: f.category,
              name: f.name,
              tags: f.tags,
              url: f.url,
              resultA,
              resultB,
              comparable,
              noteA,
              noteB,
            }
          }),
        }))

        // Count only shared features measured conclusively by the same method.
        let differ = 0
        let jointConclusive = 0
        let supportedA = 0
        let supportedB = 0
        for (const cat of catResults) {
          for (const f of cat.features) {
            if (!f.comparable) continue
            jointConclusive++
            if (f.resultA === "yes") supportedA++
            if (f.resultB === "yes") supportedB++
            if ((f.resultA === "yes" && f.resultB === "no") || (f.resultA === "no" && f.resultB === "yes")) differ++
          }
        }

        const compareId = `${a.slug}-vs-${b.slug}`

        pairs.push({
          params: {
            id: compareId,
            termAId: a.name,
            termBId: b.name,
            termASlug: a.slug,
            termBSlug: b.slug,
            termALabel: a.label,
            termBLabel: b.label,
            termADescription: a.description,
            termBDescription: b.description,
            termAUrl: a.url,
            termBUrl: b.url,
            termAType: a.type,
            termBType: b.type,
            termAKind: targetA.kind,
            termBKind: targetB.kind,
            termAVersion: targetA.version,
            termBVersion: targetB.version,
            termAOs: targetA.os ?? "Not recorded",
            termBOs: targetB.os ?? "Not recorded",
            termAOsVersion: targetA.osVersion ?? "Not recorded",
            termBOsVersion: targetB.osVersion ?? "Not recorded",
            termAOuter: targetA.outerTerminal ?? "Not recorded",
            termBOuter: targetB.outerTerminal ?? "Not recorded",
            termAMux: targetA.mux ?? "Not recorded",
            termBMux: targetB.mux ?? "Not recorded",
            termAConfig: targetA.config ?? "Not recorded",
            termBConfig: targetB.config ?? "Not recorded",
            termAPermissions: targetA.permissions ?? "Not recorded",
            termBPermissions: targetB.permissions ?? "Not recorded",
            termASuite: a.selected.suiteId,
            termBSuite: b.selected.suiteId,
            termASuiteComplete: String(a.selected.suite.complete),
            termBSuiteComplete: String(b.selected.suite.complete),
            comparableScope: String(comparableScope),
            termAPass: String(a.selected.counts.supported),
            termBPass: String(b.selected.counts.supported),
            termATotal: String(a.selected.counts.conclusive),
            termBTotal: String(b.selected.counts.conclusive),
            jointConclusive: comparableScope ? String(jointConclusive) : "",
            supportedA: comparableScope ? String(supportedA) : "",
            supportedB: comparableScope ? String(supportedB) : "",
            differ: comparableScope ? String(differ) : "",
            categories: JSON.stringify(catResults),
          },
        })
      }
    }

    return pairs
  },
}
