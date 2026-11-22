/**
 * @failure The generated analysis text counts or links the nine environment positions (`device.env-*`): "covers 28
 *   features" on the device page, "273 features" on the features index, "9 features have no recorded support", and
 *   an analysis entry for each environment feature page, though no public page may show them (@cpo/term f16a5a52 Q2).
 * @level l2
 * @consumer terminfo.dev category, standard, feature and index analysis (scripts/generate-analysis.ts, read by the
 *   route loaders through docs/data/load-probes.ts)
 * @reach fs-read vendor/terminfo.dev/content/*.json (the real feature, category, standard and terminal catalogues)
 * @testonly none
 */
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"
import { loadFeatures } from "@terminfo/catalog"
import { isEnvironmentGroup } from "@terminfo/probe-defs"
import { generateAnalysis } from "./generate-analysis.ts"

// One reviewed context over the REAL catalogue stands in for the stored corpus: every graded id Supported, the
// nine environment positions recorded as stored (ungraded), so the analysis runs its own code on every id.
const corpus = vi.hoisted(() => ({ context: undefined as unknown }))
vi.mock("../docs/data/current-results.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../docs/data/current-results.ts")>()),
  loadCurrentResults: () => {
    const fixture = corpus.context as { projection: unknown } | undefined
    if (!fixture) throw new Error("analysis-public-features.test: no corpus fixture was set")
    return { projection: fixture.projection }
  },
  compatibilitySubjects: () => (corpus.context as { subjects: unknown }).subjects,
  joinedAppCells: () => (corpus.context as { joined: unknown }).joined,
}))

const root = join(import.meta.dirname, "..")
const catalog = loadFeatures(join(root, "content"))
const catalogIds = Object.keys(catalog)
const shownIds = catalogIds.filter((id) => !isEnvironmentGroup(id))
const TERMINAL = "ghostty"
const CONTEXT = "term:ghostty"

function storeOneContext(): void {
  const cells = Object.fromEntries(
    catalogIds.map((featureId) => [
      featureId,
      isEnvironmentGroup(featureId)
        ? { result: { featureId, status: "probe-todo" } }
        : { result: { featureId, status: "supported" }, featureResult: { featureId, status: "supported" } },
    ]),
  )
  const joinedCells = Object.fromEntries(
    shownIds.map((featureId) => [
      featureId,
      { status: "supported", from: [{ context: CONTEXT, status: "supported" }] },
    ]),
  )
  const run = {
    runId: "run-1",
    sha256: "a".repeat(64),
    measuredAt: "2026-11-08T00:00:00Z",
    suiteId: "fixture",
    subject: { version: "1.2.0" },
  }
  corpus.context = {
    projection: { history: { [CONTEXT]: [run] } },
    subjects: new Map([
      [
        TERMINAL,
        {
          contextKey: CONTEXT,
          routeKey: TERMINAL,
          os: "macos",
          selected: { subject: { id: TERMINAL, kind: "term" }, cells, contributingRunIds: ["run-1"], catalogIds },
        },
      ],
    ]),
    joined: new Map([[TERMINAL, { contexts: [CONTEXT], cells: joinedCells, counts: {} }]]),
  }
}

describe("the generated analysis covers the public catalogue only", () => {
  it("counts, lists and links no environment position", () => {
    storeOneContext()
    const analysis = generateAnalysis()
    const hiddenKeys = catalogIds
      .filter((id) => isEnvironmentGroup(id))
      .map((id) => `${id.split(".")[0]}/${catalog[id]?.slug ?? id.replaceAll(".", "-")}`)
    expect.soft(Object.keys(analysis).filter((key) => hiddenKeys.includes(key))).toEqual([])

    const device = shownIds.filter((id) => id.startsWith("device.") || catalog[id]?.tags?.includes("device"))
    expect.soft(analysis.device?.analysis).toContain(`category covers ${device.length} features`)
    expect.soft(analysis["features-index"]?.analysis).toContain(`covers <strong>${shownIds.length}</strong> features`)
    // Every graded id is Supported here, so a feature with no support could only be an environment position.
    expect.soft(analysis["features-index"]?.analysis).not.toContain("no recorded support")
    const tagged = (tag: string) => shownIds.filter((id) => catalog[id]?.tags?.includes(tag)).length
    expect.soft(analysis.iterm2?.analysis).toContain(`defines ${tagged("iterm2")} features`)
    for (const [key, entry] of Object.entries(analysis)) {
      expect
        .soft(
          hiddenKeys.filter((page) => entry.analysis.includes(`/${page}"`)),
          key,
        )
        .toEqual([])
    }
  })
})
