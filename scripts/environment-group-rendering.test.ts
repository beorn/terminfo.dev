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
import { beforeAll, describe, expect, it, vi } from "vitest"
import { Command } from "@silvery/commander"
import { ENVIRONMENT_GROUP_IDS, initializeRunDraft } from "@terminfo/probe-defs"
import type { ProbeResult, CapturedRunDraft, ProbeSuiteManifest } from "@terminfo/probe-defs"
import * as publicCollector from "../packages/terminfo.dev/src/serve.ts"
import { currentCoverageSentence, aggregateCurrentResults } from "../docs/data/release-scope.ts"
import { scopeAggregate } from "../docs/data/full-scope.ts"
import { evidenceStatus, MANUAL_BY_DESIGN_STATUS } from "../docs/.vitepress/theme/evidence-status.ts"

const root = join(import.meta.dirname, "..")
const source = (path: string) => readFileSync(join(root, path), "utf8")
const PHRASE = "manual by design (catalogue), ungraded"
vi.mock("../packages/terminfo.dev/src/serve.ts", () => ({
  collectProbeRun: vi.fn(),
  getTrustedSuiteReceipt: vi.fn(),
  getCliSuiteProbeHash: () => "abcdef123456",
}))
const gradedIds = Array.from({ length: 264 }, (_, index) => `capability.${index}`)
const catalogIds = [...ENVIRONMENT_GROUP_IDS, ...gradedIds]
const todos = (): ProbeResult[] =>
  catalogIds.map((featureId) => ({
    featureId,
    status: "test-todo",
    attempt: { scope: "none" },
    checks: [],
    reason: "No implementation",
  }))

describe("public test CLI coverage uses the collected manifest", () => {
  let program: Command

  beforeAll(async () => {
    const parse = vi.spyOn(Command.prototype, "parse").mockReturnThis()
    try {
      await import("../packages/terminfo.dev/src/index.tsx")
      const parsed = parse.mock.contexts[0]
      if (!parsed) throw new Error("CLI entry point did not parse its command")
      program = parsed
    } finally {
      parse.mockRestore()
    }
  })

  it.each([
    ["current", catalogIds, ` · 9 environment groups ${PHRASE}`],
    ["historical", gradedIds, ""],
  ] as const)("prints the %s catalogue's environment clause", async (_label, ids, clause) => {
    const manifest = {
      probeHash: "abcdef123456",
      sourceRevision: "a".repeat(40),
      generatedAt: "2026-10-25T00:00:00.000Z",
      adapterVersion: "test",
      catalogIds: [...ids],
      probes: { app: [], headless: [], mux: [] },
    } satisfies ProbeSuiteManifest
    const run: CapturedRunDraft = {
      ...initializeRunDraft({
        runId: "1234567890abcdef1234567890abcdef",
        sourceRevision: manifest.sourceRevision,
        manifest,
        intendedContext: { kind: "app", id: "kitty", version: "1" },
      }),
      target: {
        kind: "app",
        id: "kitty",
        version: "1",
        os: "linux",
        osVersion: null,
        outerTerminal: null,
        mux: null,
        config: null,
        permissions: null,
      },
      identity: "unverified",
      measuredAt: "2026-10-25T00:00:00.000Z",
      origin: { kind: "collector" },
    }
    vi.mocked(publicCollector.collectProbeRun).mockResolvedValue(run)
    vi.mocked(publicCollector.getTrustedSuiteReceipt).mockReturnValue({
      manifest,
      collectorRevision: manifest.sourceRevision,
    })
    const output = vi.spyOn(console, "log").mockImplementation(() => {})
    try {
      await program.parseAsync(["test"], { from: "user" })
      const summary = output.mock.calls.map(([line]) => line).find((line) => line.includes("TEST FAILURE"))
      expect(summary).toBe(`0 Supported · 0 Unsupported · 0 Untestable · 264 TEST TODO · 0 TEST FAILURE${clause}`)
    } finally {
      output.mockRestore()
    }
  })
})

describe("#30917 environment groups are named, never TEST TODO", () => {
  it("names the groups the run recorded and leaves the graded counts alone", () => {
    const bar = aggregateCurrentResults(todos(), catalogIds)
    expect(bar.denominator).toBe(264)
    expect(currentCoverageSentence(bar, catalogIds)).toBe(
      `0 Supported · 0 Unsupported · 0 Untestable · 264 TEST TODO · 0 TEST FAILURE · ${ENVIRONMENT_GROUP_IDS.length} environment groups manual by design (catalogue), ungraded`,
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
    expect(api).toContain("ungraded: **manual by design (catalogue)**")
    expect(api).toContain("only a stored TEST TODO")
    const full = source("docs/release/full-273.md")
    expect(full).toContain("data.gradedRows")
    expect(full).toContain("data.environmentGroups")
    expect(full).toContain("(manual by design, ungraded)")
    expect(full).toContain("zero TEST TODO and zero TEST FAILURE among the graded capabilities")
  })

  it("names the nine on the OS page tooltip too (D2)", () => {
    const os = source("docs/os/[id].paths.ts")
    expect(os).toContain("currentCoverageSentence(stats, data.selectedByBackend[source.name]?.selected.catalogIds)")
  })
})
