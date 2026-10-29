/**
 * @failure A context with no run, an ambiguous selection, or a run on another suite could print as
 *   zero percent or as collected, an engine with runs on several operating systems could be silently
 *   reduced to one, or a reviewed instrument limit could leak onto another context.
 * @level l2
 * @consumer the full-273 row builder (docs/data/full-project.ts, step 7)
 * @source-grep nothing but these fixtures exercise the ambiguous, off-suite, missing and multi-OS
 *   shapes together; the real corpus covers only the shapes that happen to exist today.
 * @testonly none
 */
import { describe, expect, it } from "vitest"
import { buildFullProjectRows } from "../docs/data/full-project.ts"
import type { ProbeResult, ProbeStatus } from "@terminfo/probe-defs"
import type { ContextCandidate } from "../docs/data/run-selection.ts"
import type { CensusContext } from "../docs/data/full-census.ts"

const recorded = (ids: readonly string[], status: ProbeStatus = "test-todo"): ProbeResult[] =>
  ids.map((featureId) => ({
    featureId,
    status,
    attempt: status === "test-todo" ? { scope: "none" } : { scope: "probe", startedAt: "2026-10-21T05:00:00.000Z" },
    tests: [],
  }))

const suite = "suite-current"
const catalogIds = ["a.one", "a.two", "b.one"]

function candidate(
  overrides: Partial<ContextCandidate> & Pick<ContextCandidate, "terminalId" | "os" | "kind">,
): ContextCandidate {
  return {
    key: `${overrides.kind}:${overrides.terminalId}@${overrides.os}`,
    permissions: null,
    results: recorded(catalogIds),
    states: {},
    sources: [
      {
        runId: `run-${overrides.terminalId}-${overrides.os}`,
        measuredAt: "2026-10-17T00:00:00Z",
        suiteId: suite,
        suiteRelation: "release",
      },
    ],
    ...overrides,
  }
}

const app: CensusContext = { context: "kitty/linux", terminalId: "kitty", os: "linux", kind: "term" }
const other: CensusContext = { context: "xterm/linux", terminalId: "xterm", os: "linux", kind: "term" }
const engine: CensusContext = { context: "libvterm/headless", terminalId: "libvterm", os: "headless", kind: "lib" }

describe("full-scope rows", () => {
  // CTO436fd774: showing retained off-suite support must not raise the required-suite release score.
  // Whole-run fixtures cannot distinguish a visible retained cell from admitted release evidence.
  it("keeps mixed required-suite scoring neutral while exposing held original cells", () => {
    const onSuite = candidate({
      kind: "term",
      terminalId: "kitty",
      os: "linux",
      results: [...recorded(["a.one"], "supported"), ...recorded(["a.two", "b.one"])],
    })
    const oldSource = {
      runId: "older-original",
      measuredAt: "2026-10-16T00:00:00Z",
      suiteId: "older-suite",
      suiteRelation: "older" as const,
    }
    const oldResults = recorded(catalogIds, "supported")
    const original = { ...onSuite.sources[0]!, results: onSuite.results! }
    const older = { ...oldSource, results: oldResults }
    const cells = Object.fromEntries(
      catalogIds.map((id, index) => {
        const run = index === 1 ? older : original
        return [id, { origin: { runId: run.runId, resultId: id }, run, result: run.results[index]! }]
      }),
    )
    const mixed = {
      ...onSuite,
      sources: [onSuite.sources[0]!, oldSource],
      results: Object.values(cells).map((cell) => cell.result),
      context: {
        contextKey: onSuite.key,
        cells,
        catalogIds,
        contributingRunIds: [original.runId, older.runId],
        attempts: [],
        missingIds: [],
        counts: {},
        score: { supported: 2, all: 3 },
        complete: false,
      },
    } as unknown as ContextCandidate
    const build = (entry: ContextCandidate) =>
      buildFullProjectRows({ census: [app], catalogIds, candidates: [entry], requiredSuiteId: suite }).contexts[0]
    const before = build(onSuite)
    const after = build(mixed)
    if (!before?.collected || !after?.collected) throw new Error("Both evidence-bearing contexts must remain collected")
    expect(after.result.fraction).toBe(before.result.fraction)
    expect(after.result.fraction).toBe("1/3")
    expect(after).toMatchObject({ heldIds: ["a.two"], sources: mixed.sources })
    expect(after.observations[1]).toMatchObject({
      id: "a.two",
      state: "supported",
      origin: { runId: older.runId, resultId: "a.two" },
      suiteId: "older-suite",
      measuredAt: older.measuredAt,
      hold: "retained from suite older-suite, measured 2026-10-16T00:00:00Z; not release evidence",
    })
  })
  it("scores a collected context over the whole catalog", () => {
    const rows = buildFullProjectRows({
      census: [app],
      catalogIds,
      candidates: [
        candidate({
          kind: "term",
          terminalId: "kitty",
          os: "linux",
          results: [...recorded(["a.one"], "supported"), ...recorded(["a.two"], "unsupported"), ...recorded(["b.one"])],
        }),
      ],
      requiredSuiteId: suite,
    })
    const [row] = rows.contexts
    expect(row?.collected).toBe(true)
    if (!row?.collected) throw new Error("expected a collected row")
    expect(row.result.fraction).toBe("1/3")
    expect(row.result.complete).toBe(false)
    expect(row.observations).toMatchObject([
      { id: "a.one", state: "supported", method: null, note: null, reason: null },
      { id: "a.two", state: "unsupported", method: null, note: null, reason: null },
      { id: "b.one", state: "test-todo", method: null, note: null, reason: null },
    ])
    expect(rows.collected).toBe(1)
    expect(rows.notCollected).toBe(0)
  })

  it("names a run on another suite as not collected, with its cause and no score", () => {
    const rows = buildFullProjectRows({
      census: [app],
      catalogIds,
      candidates: [
        candidate({
          kind: "term",
          terminalId: "kitty",
          os: "linux",
          sources: [
            {
              runId: "older-original",
              suiteId: "an-older-suite",
              suiteRelation: "older",
              measuredAt: "2026-10-17T00:00:00Z",
            },
          ],
        }),
      ],
      requiredSuiteId: suite,
    })
    const [row] = rows.contexts
    expect(row).toEqual({
      context: "kitty/linux",
      terminalId: "kitty",
      os: "linux",
      kind: "term",
      collected: false,
      cause: "selected run is on suite an-older-suite; required suite-current; sources older-original",
    })
    expect(rows.notCollected).toBe(1)
  })

  it("names a context with no run rather than printing a zero", () => {
    const rows = buildFullProjectRows({ census: [other], catalogIds, candidates: [], requiredSuiteId: suite })
    expect(rows.contexts[0]).toMatchObject({
      context: "xterm/linux",
      collected: false,
      cause: "no selected run for this context",
    })
  })

  it("refuses to pick one operating system for an engine with two current runs", () => {
    const rows = buildFullProjectRows({
      census: [engine],
      catalogIds,
      candidates: [
        candidate({ kind: "lib", terminalId: "libvterm", os: "linux" }),
        candidate({ kind: "lib", terminalId: "libvterm", os: "macos" }),
      ],
      requiredSuiteId: suite,
    })
    expect(rows.contexts[0]).toMatchObject({
      collected: false,
      cause: "engine has current runs on linux, macos; one headless context cannot choose an operating system",
    })
  })

  it("keeps reviewed Untestable in the full denominator and can finish with no supported capabilities", () => {
    const rows = buildFullProjectRows({
      census: [app],
      catalogIds,
      candidates: [
        candidate({ kind: "term", terminalId: "kitty", os: "linux", results: recorded(catalogIds, "untestable") }),
      ],
      requiredSuiteId: suite,
    })
    const row = rows.contexts[0]
    if (!row?.collected) throw new Error("expected collected row")
    expect(row.result.denominator).toBe(3)
    expect(row.result.fraction).toBe("0/3")
    expect(row.result.complete).toBe(true)
    expect(rows.complete).toBe(true)
  })

  it("carries the run's own observation method and words for every catalog row", () => {
    const rows = buildFullProjectRows({
      census: [app],
      catalogIds,
      candidates: [
        candidate({
          kind: "term",
          terminalId: "kitty",
          os: "linux",
          results: recorded(catalogIds).map((result) =>
            result.featureId === "a.one"
              ? {
                  ...result,
                  status: "test-failure",
                  assertionType: "buffer_state",
                  reason: "terminal never answered; timeout",
                }
              : result,
          ),
        }),
      ],
      requiredSuiteId: suite,
    })
    const [row] = rows.contexts
    if (!row?.collected) throw new Error("expected a collected row")
    expect(row.observations[0]).toMatchObject({
      id: "a.one",
      state: "test-failure",
      method: "buffer_state",
      note: null,
      reason: "terminal never answered; timeout",
    })
    expect(row.observations).toHaveLength(catalogIds.length)
  })

  // The old excluded-denominator fixtures cannot prove the strengthened 33 × 273 finish rule.
  it("requires all 9009 recorded positions and zero TODO/failure in every context", () => {
    const ids = Array.from({ length: 273 }, (_, index) => `capability.${index}`)
    const census = Array.from({ length: 33 }, (_, index): CensusContext => ({
      context: `terminal-${index}/linux`,
      terminalId: `terminal-${index}`,
      os: "linux",
      kind: "term",
    }))
    const candidates = census.map((context) =>
      candidate({
        kind: context.kind,
        terminalId: context.terminalId,
        os: context.os,
        results: recorded(ids, "unsupported"),
      }),
    )
    const finished = buildFullProjectRows({ census, catalogIds: ids, candidates, requiredSuiteId: suite })
    expect(finished.recordedPositions).toBe(9009)
    expect(finished.complete).toBe(true)
    expect(finished.contexts.every((row) => row.collected && row.result.fraction === "0/273")).toBe(true)
    candidates[32]!.results![272]!.status = "test-todo"
    const pending = buildFullProjectRows({ census, catalogIds: ids, candidates, requiredSuiteId: suite })
    expect(pending.recordedPositions).toBe(9009)
    expect(pending.complete).toBe(false)
    candidates[32]!.results![272]!.status = "test-failure"
    expect(buildFullProjectRows({ census, catalogIds: ids, candidates, requiredSuiteId: suite }).complete).toBe(false)
  })

  // The page test reads the live corpus, so the wholly-empty witness lives here, next to the row
  // builder that owns the behavior: the same 33 contexts and 273 positions, with no runs at all.
  it("keeps an all-history corpus incomplete without inventing a current score", () => {
    const ids = Array.from({ length: 273 }, (_, index) => `capability.${index}`)
    const census = Array.from({ length: 33 }, (_, index): CensusContext => ({
      context: `terminal-${index}/linux`,
      terminalId: `terminal-${index}`,
      os: "linux",
      kind: "term",
    }))
    const rows = buildFullProjectRows({ census, catalogIds: ids, candidates: [], requiredSuiteId: suite })
    expect(rows.collected).toBe(0)
    expect(rows.notCollected).toBe(33)
    expect(rows.recordedPositions).toBe(0)
    expect(rows.complete).toBe(false)
    expect(rows.contexts.every((row) => !("result" in row) && row.cause.trim() !== "")).toBe(true)
  })

  it("refuses a missing required suite", () => {
    expect(() => buildFullProjectRows({ census: [app], catalogIds, candidates: [], requiredSuiteId: "" })).toThrow(
      /needs the suite/,
    )
  })
})
