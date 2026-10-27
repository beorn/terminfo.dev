import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { loadFeatures } from "@terminfo/catalog"
import { loadProbes, featureSlug, catLabel, terminalSlug } from "../data/load-probes"
import type { PublicVersion } from "../data/public-results"
import { publicResultFor } from "../data/release-scope"
import type { ProbeStatus } from "@terminfo/probe-defs"

const __dirname = dirname(fileURLToPath(import.meta.url))
const contentDir = join(__dirname, "..", "..", "content")

/**
 * The reader's ONE classification, said in the compare page's own words. This is presentation over the
 * state, never a second chain over the raw cell (28792 item 1).
 */
function resultFor(state: ProbeStatus | undefined): "yes" | "no" | "unknown" {
  if (state === "supported") return "yes"
  if (state === "unsupported") return "no"
  return "unknown"
}

/** The two states the reader calls decided; inconclusive, error and untested are all not decided. */
function decided(state: ProbeStatus | undefined): boolean {
  return state === "supported" || state === "unsupported"
}

function recordedScope(selected: PublicVersion): unknown[] {
  return [
    selected.subject.kind,
    selected.subject.os,
    selected.subject.osVersion,
    selected.subject.outerTerminal,
    selected.subject.mux,
    selected.subject.config,
    selected.subject.permissions,
    selected.suiteId,
    selected.probeHash,
  ]
}

export default {
  paths() {
    const data = loadProbes()
    const featuresMeta = loadFeatures(contentDir)

    // Build terminal info from reviewed selected runs.
    const terminals = data.backends.map((b) => {
      const meta = data.meta[b.name] ?? {}
      const selected = data.selectedByBackend[b.name]?.selected
      if (!selected) throw new Error(`Missing selected run for comparison terminal ${b.name}`)
      const states = data.selectedByBackend[b.name]?.states
      if (!states) throw new Error(`Missing classified states for comparison terminal ${b.name}`)
      const slug = terminalSlug(b.name, data.meta)
      return {
        name: b.name,
        slug,
        label: meta.label ?? b.name,
        description: meta.description ?? "",
        url: meta.url ?? "",
        type: meta.type ?? "",
        selected,
        states,
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

        const subjectA = a.selected.subject
        const subjectB = b.selected.subject
        const comparableScope = Boolean(
          subjectA.os &&
          subjectB.os &&
          a.selected.probeHash &&
          b.selected.probeHash &&
          a.selected.complete &&
          b.selected.complete &&
          JSON.stringify(recordedScope(a.selected)) === JSON.stringify(recordedScope(b.selected)),
        )

        // Build per-feature results for both terminals
        const catResults = categories.map((cat) => ({
          name: cat.name,
          label: cat.label,
          features: cat.features.map((f) => {
            const cellA = publicResultFor(a.selected, f.id)
            const cellB = publicResultFor(b.selected, f.id)
            const stateA = a.states[f.id]
            const stateB = b.states[f.id]
            const resultA = resultFor(stateA)
            const resultB = resultFor(stateB)
            const comparable = Boolean(
              comparableScope &&
              decided(stateA) &&
              decided(stateB) &&
              cellA !== undefined &&
              cellB !== undefined &&
              // Evidence is a raw field, not a classification: the same-method check still reads it.
              cellA.assertionType !== undefined &&
              cellA.assertionType === cellB.assertionType &&
              resultA !== "unknown" &&
              resultB !== "unknown",
            )
            const noteA = (cellA && "reason" in cellA ? cellA.reason : undefined) ?? ""
            const noteB = (cellB && "reason" in cellB ? cellB.reason : undefined) ?? ""
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
            termAKind: subjectA.kind,
            termBKind: subjectB.kind,
            termAVersion: subjectA.version,
            termBVersion: subjectB.version,
            termAOs: subjectA.os ?? "Not recorded",
            termBOs: subjectB.os ?? "Not recorded",
            termAOsVersion: subjectA.osVersion ?? "Not recorded",
            termBOsVersion: subjectB.osVersion ?? "Not recorded",
            termAOuter: subjectA.outerTerminal ?? "Not recorded",
            termBOuter: subjectB.outerTerminal ?? "Not recorded",
            termAMux: subjectA.mux ?? "Not recorded",
            termBMux: subjectB.mux ?? "Not recorded",
            termAConfig: subjectA.config ?? "Not recorded",
            termBConfig: subjectB.config ?? "Not recorded",
            termAPermissions: subjectA.permissions ?? "Not recorded",
            termBPermissions: subjectB.permissions ?? "Not recorded",
            termASuite: a.selected.suiteId,
            termBSuite: b.selected.suiteId,
            termASuiteComplete: String(a.selected.complete),
            termBSuiteComplete: String(b.selected.complete),
            comparableScope: String(comparableScope),
            termAPass: String(a.selected.counts.supported),
            termBPass: String(b.selected.counts.supported),
            termATotal: String(a.selected.score.all),
            termBTotal: String(b.selected.score.all),
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
