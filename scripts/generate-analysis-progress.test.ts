/**
 * @failure  generate-analysis runs silently for minutes during site builds without naming its current phase, count,
 *           or per-phase durations (#38708).
 * @level    l1 — unit tests of createAnalysisProgress with a synthetic clock plus generateAnalysis phase reporting
 *           over a one-context fixture.
 * @consumer scripts/generate-analysis.ts and terminfo-site landed builds.
 * @testonly none
 */
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"
import { loadFeatures } from "@terminfo/catalog"
import { isEnvironmentGroup } from "@terminfo/probe-defs"
import { createAnalysisProgress, DEFAULT_ANALYSIS_PROGRESS_INTERVAL_MS } from "../docs/data/analysis-progress.ts"
import { generateAnalysis } from "./generate-analysis.ts"

const corpus = vi.hoisted(() => ({ context: undefined as unknown }))
vi.mock("../docs/data/current-results.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../docs/data/current-results.ts")>()),
  loadCurrentResults: (
    _dir: string,
    options?: { progress?: { phase: (n: string, t?: number) => void; tick: (c?: number, t?: number) => void } },
  ) => {
    options?.progress?.phase("load-stored-runs", 2)
    options?.progress?.tick(2, 2)
    options?.progress?.phase("verify-artifacts", 2)
    options?.progress?.tick(2, 2)
    options?.progress?.phase("project-results", 1)
    options?.progress?.tick(1, 1)
    return { projection: (corpus.context as { projection: unknown }).projection }
  },
  compatibilitySubjects: () => (corpus.context as { subjects: unknown }).subjects,
  joinedAppCells: () => (corpus.context as { joined: unknown }).joined,
}))

function seedOneContextFixture(): void {
  const root = join(import.meta.dirname, "..")
  const catalog = loadFeatures(join(root, "content"))
  const catalogIds = Object.keys(catalog)
  const shownIds = catalogIds.filter((id) => !isEnvironmentGroup(id))
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
      { status: "supported", from: [{ context: "term:ghostty", status: "supported" }] },
    ]),
  )
  const run = {
    runId: "run-1",
    sha256: "a".repeat(64),
    measuredAt: "2026-11-26T00:00:00Z",
    suiteId: "fixture",
    subject: { version: "1.2.0" },
  }
  corpus.context = {
    projection: { history: { "term:ghostty": [run] } },
    subjects: new Map([
      [
        "ghostty",
        {
          contextKey: "term:ghostty",
          routeKey: "ghostty",
          os: "macos",
          selected: { subject: { id: "ghostty", kind: "term" }, cells, contributingRunIds: ["run-1"], catalogIds },
        },
      ],
    ]),
    joined: new Map([["ghostty", { contexts: ["term:ghostty"], cells: joinedCells, counts: {} }]]),
  }
}

describe("generate-analysis progress reporting (#38708)", () => {
  it("defaults to an interval under 30 s and emits phase + count at every interval with per-phase summary", () => {
    expect(DEFAULT_ANALYSIS_PROGRESS_INTERVAL_MS).toBeLessThanOrEqual(30_000)

    let clock = 1000
    const lines: string[] = []
    const progress = createAnalysisProgress({
      intervalMs: 15_000,
      now: () => clock,
      emit: (line) => lines.push(line),
    })

    progress.phase("load-stored-runs", 100)
    clock += 10_000
    progress.tick(40, 100)
    expect(lines).toEqual([])

    clock += 6_000 // +16s total -> emits
    progress.tick(65, 100)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toBe("generate-analysis: phase load-stored-runs 65/100 (16.0s in phase, 16.0s total)")

    clock += 20_000 // +36s total -> phase transition emits before switching
    progress.phase("working-history", 50)
    expect(lines).toHaveLength(2)
    expect(lines[1]).toBe("generate-analysis: phase load-stored-runs 65/100 (36.0s in phase, 36.0s total)")

    clock += 15_000
    progress.tick(25, 50)
    expect(lines).toHaveLength(3)
    expect(lines[2]).toBe("generate-analysis: phase working-history 25/50 (15.0s in phase, 51.0s total)")

    clock += 5_000
    progress.tick(50, 50)
    const result = progress.finish()
    expect(result.totalMs).toBe(56_000)
    expect(result.phases).toEqual([
      { phase: "load-stored-runs", ms: 36_000, count: 65, total: 100 },
      { phase: "working-history", ms: 20_000, count: 50, total: 50 },
    ])
    expect(progress.formatSummary()).toBe(
      "generate-analysis: phase durations — load-stored-runs 36.0s (65/100); working-history 20.0s (50) (total 56.0s)",
    )
  })

  it("reports every generateAnalysis phase with counts and emits periodic progress lines", () => {
    seedOneContextFixture()
    let clock = 0
    const lines: string[] = []
    const progress = createAnalysisProgress({
      intervalMs: 15_000,
      now: () => {
        clock += 5_000
        return clock
      },
      emit: (line) => lines.push(line),
    })

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      generateAnalysis(progress)
    } finally {
      warnSpy.mockRestore()
    }
    const done = progress.finish()
    expect(done.phases.map((p) => p.phase)).toEqual([
      "load-stored-runs",
      "verify-artifacts",
      "project-results",
      "build-result-map",
      "compute-stats",
      "generate-entries",
      "linkify",
    ])
    expect(lines.length).toBeGreaterThan(0)
    expect(lines.some((line) => line.includes("phase linkify "))).toBe(true)
    expect(lines.some((line) => line.includes("phase generate-entries "))).toBe(true)
  })
})
