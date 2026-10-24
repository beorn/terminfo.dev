/**
 * @failure A run's nine environment positions print as TEST TODO, so "manual by design" reads as
 *   unmeasured work and the published denominator disagrees with the bars, tooltips and sentences.
 * @level l2
 * @consumer terminfo.dev home, baseline, terminal, compare and full-scope pages plus the admin matrix
 * @source-grep the status words live in VitePress <script setup> blocks and Vue components, which no
 *   unit runner imports; each site is therefore pinned by the predicate and the words it must print,
 *   and the arithmetic it prints is exercised directly through the fold and the sentence.
 * @testonly none
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { ENVIRONMENT_GROUP_IDS } from "@terminfo/probe-defs"
import type { CapabilityResult } from "@terminfo/probe-defs"
import { currentCoverageSentence, aggregateCurrentResults } from "../docs/data/release-scope.ts"
import { scopeAggregate } from "../docs/data/full-scope.ts"
import { evidenceStatus, MANUAL_BY_DESIGN_STATUS } from "../docs/.vitepress/theme/evidence-status.ts"

const root = join(import.meta.dirname, "..")
const source = (path: string) => readFileSync(join(root, path), "utf8")
const PHRASE = "manual by design (catalogue), NOT MEASURED"
const gradedIds = Array.from({ length: 264 }, (_, index) => `capability.${index}`)
const catalogIds = [...ENVIRONMENT_GROUP_IDS, ...gradedIds]
const todos = (): CapabilityResult[] =>
  catalogIds.map((featureId) => ({
    featureId,
    status: "test-todo",
    attempt: { scope: "none" },
    checks: [],
    reason: "No implementation",
  }))

describe("#30917 environment groups are named, never TEST TODO", () => {
  it("names the groups the run recorded and leaves the graded counts alone", () => {
    const bar = aggregateCurrentResults(todos(), catalogIds)
    expect(bar.denominator).toBe(264)
    expect(currentCoverageSentence(bar, catalogIds)).toBe(
      `0 Supported · 0 Unsupported · 0 Untestable · 264 TEST TODO · 0 TEST FAILURE · ${ENVIRONMENT_GROUP_IDS.length} environment groups ${PHRASE}`,
    )
    // A caller that does not know the catalogue never invents a count for it.
    expect(currentCoverageSentence(bar)).not.toContain("environment groups")
  })

  it("scores 264 of 273 catalogue positions and keeps every recorded position counted as one", () => {
    const scope = scopeAggregate({ scope: "app:kitty", catalogIds, results: todos() })
    expect(scope.catalogRows).toBe(273)
    expect(scope.denominator).toBe(264)
    expect(scope.fraction).toBe("0/264")
    const manual = scope.groups.filter((group) => group.key === "capability")
    expect(manual.map((group) => group.catalogRows)).toEqual([264])
  })

  it("wires the home page bar, tooltip and legend to the one predicate", () => {
    const home = source("docs/index.md")
    expect(home).toContain("!isEnvironmentGroup(result.featureId)")
    expect(home).toContain("currentCoverageSentence(bar, displayedSelections[backendName]?.selected.catalogIds)")
    expect(home).toContain(PHRASE)
  })

  it("wires the baseline bar and its meta line to the one predicate", () => {
    const baseline = source("docs/baseline/[id].md")
    expect(baseline).toContain("if (isEnvironmentGroup(f.id)) continue")
    expect(baseline).toContain(PHRASE)
    // The bar width and the printed share read the projection's single denominator.
    expect(baseline).toContain("s.counts[segment] / s.score.all")
    expect(baseline).toContain("${s.score.supported}/${s.score.all} supported")
  })

  it("wires the terminal page's coverage sentence to the run's own catalogue", () => {
    const terminal = source("docs/terminals/[id].md")
    expect(terminal).toContain("currentCoverageSentence(measuredBar, selectedRun.catalogIds)")
    expect(terminal).toContain("aggregateCurrentResults(selectedRun.value.results, selectedRun.value.catalogIds)")
  })

  it("gives the evidence cell the manual-by-design words only for a stored TEST TODO", () => {
    const cell = source("docs/.vitepress/theme/ResultEvidenceCell.vue")
    expect(cell).toContain("evidenceStatus(props.featureId, currentResult.value?.status)")
  })

  it("renders a stored supported environment row as Supported, never NOT MEASURED (D1)", () => {
    // @cto 98cd142b D1: the projection keeps a stored status on an environment row, so a blanket
    // environment override would publish "NOT MEASURED" over a real measurement.
    expect(evidenceStatus("device.env-term", "supported")).toEqual({ text: "Supported", icon: "✓", tone: "yes" })
    expect(evidenceStatus("device.env-term", "unsupported").text).toBe("Unsupported")
    expect(evidenceStatus("device.env-term", "test-failure").text).toBe("TEST FAILURE")
    // Only the catalogue's own TEST TODO wears the manual-by-design words, and never the TODO label.
    expect(evidenceStatus("device.env-term", "test-todo")).toEqual(MANUAL_BY_DESIGN_STATUS)
    expect(evidenceStatus("device.env-term", "test-todo").text).not.toBe("TEST TODO")
    expect(MANUAL_BY_DESIGN_STATUS.text).toBe("Manual by design (catalogue), NOT MEASURED")
    // A graded row keeps its stored status untouched.
    expect(evidenceStatus("sgr.bold", "test-todo").text).toBe("TEST TODO")
    expect(evidenceStatus("sgr.bold", undefined)).toEqual({ text: "", icon: "–", tone: "unknown" })
  })

  it("publishes the graded denominator and the ungraded nine as contract text", () => {
    const api = source("docs/api.md")
    expect(api).toContain("graded** catalog positions")
    expect(api).toContain("manual by design (catalogue), NOT MEASURED")
    const full = source("docs/release/full-273.md")
    expect(full).toContain("data.gradedRows")
    expect(full).toContain("data.environmentGroups")
    expect(full).toContain("zero TEST TODO and zero TEST FAILURE among the graded capabilities")
  })

  it("names the nine on the OS page tooltip too (D2)", () => {
    const os = source("docs/os/[id].paths.ts")
    expect(os).toContain("currentCoverageSentence(stats, data.selectedByBackend[source.name]?.selected.catalogIds)")
  })
})
