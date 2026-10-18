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
import type { ContextCandidate } from "../docs/data/run-selection.ts"
import type { CensusContext } from "../docs/data/full-census.ts"

const suite = "suite-current"
const catalogIds = ["a.one", "a.two", "b.one"]

function candidate(
  overrides: Partial<ContextCandidate> & Pick<ContextCandidate, "terminalId" | "os" | "kind">,
): ContextCandidate {
  return {
    key: `${overrides.kind}:${overrides.terminalId}@${overrides.os}`,
    runId: `run-${overrides.terminalId}-${overrides.os}`,
    permissions: null,
    version: "1.0.0",
    measuredAt: "2026-10-17T00:00:00Z",
    suiteId: suite,
    suiteFreshness: "current",
    suiteRelation: "release",
    cells: {},
    states: {},
    ...overrides,
  }
}

const app: CensusContext = { context: "kitty/linux", terminalId: "kitty", os: "linux", kind: "app" }
const other: CensusContext = { context: "xterm/linux", terminalId: "xterm", os: "linux", kind: "app" }
const engine: CensusContext = { context: "libvterm/headless", terminalId: "libvterm", os: "headless", kind: "headless" }

describe("full-scope rows", () => {
  it("scores a collected context over the whole catalog", () => {
    const rows = buildFullProjectRows({
      census: [app],
      catalogIds,
      candidates: [
        candidate({
          kind: "app",
          terminalId: "kitty",
          os: "linux",
          states: { "a.one": "supported", "a.two": "unsupported", "b.one": "untested" },
        }),
      ],
      requiredSuiteId: suite,
      designExclusions: [],
      missingDefinitions: [],
    })
    const [row] = rows.contexts
    expect(row?.collected).toBe(true)
    if (!row?.collected) throw new Error("expected a collected row")
    expect(row.result.fraction).toBe("2/3")
    expect(row.result.ceiling).toBe("3/3")
    expect(row.result.included).toBe(false)
    expect(row.observations).toEqual([
      { id: "a.one", state: "supported", method: null, note: null, reason: null },
      { id: "a.two", state: "unsupported", method: null, note: null, reason: null },
      { id: "b.one", state: "untested", method: null, note: null, reason: null },
    ])
    expect(rows.collected).toBe(1)
    expect(rows.notCollected).toBe(0)
  })

  it("names a run on another suite as not collected, with its cause and no score", () => {
    const rows = buildFullProjectRows({
      census: [app],
      catalogIds,
      candidates: [candidate({ kind: "app", terminalId: "kitty", os: "linux", suiteId: "an-older-suite" })],
      requiredSuiteId: suite,
    })
    const [row] = rows.contexts
    expect(row).toEqual({
      context: "kitty/linux",
      terminalId: "kitty",
      os: "linux",
      kind: "app",
      collected: false,
      cause: "selected run is on suite an-older-suite; required suite-current",
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
        candidate({ kind: "headless", terminalId: "libvterm", os: "linux" }),
        candidate({ kind: "headless", terminalId: "libvterm", os: "macos" }),
      ],
      requiredSuiteId: suite,
    })
    expect(rows.contexts[0]).toMatchObject({
      collected: false,
      cause: "engine has current runs on linux, macos; one headless context cannot choose an operating system",
    })
  })

  it("applies reviewed instrument limits to one context only", () => {
    const rows = buildFullProjectRows({
      census: [app],
      catalogIds,
      candidates: [candidate({ kind: "app", terminalId: "kitty", os: "linux", states: { "a.one": "supported" } })],
      requiredSuiteId: suite,
      instrumentLimitsFor: (context) =>
        context.context === "kitty/linux" ? [{ id: "a.two", cause: "no capture on this host" }] : [],
      designExclusions: [],
      missingDefinitions: [],
    })
    const [row] = rows.contexts
    if (!row?.collected) throw new Error("expected a collected row")
    expect(row.result.denominator).toBe(2)
    expect(row.result.ceiling).toBe("2/3")
    expect(row.result.excluded).toEqual([{ id: "a.two", cause: "instrument" }])
  })

  it("carries the run's own observation method and words for every catalog row", () => {
    const rows = buildFullProjectRows({
      census: [app],
      catalogIds,
      candidates: [
        candidate({
          kind: "app",
          terminalId: "kitty",
          os: "linux",
          states: { "a.one": "inconclusive" },
          cells: {
            "a.one": { outcome: "unknown", evidence: "text cells", note: "terminal never answered", reason: "timeout" },
          },
        }),
      ],
      requiredSuiteId: suite,
      designExclusions: [],
      missingDefinitions: [],
    })
    const [row] = rows.contexts
    if (!row?.collected) throw new Error("expected a collected row")
    expect(row.observations[0]).toEqual({
      id: "a.one",
      state: "inconclusive",
      method: "text cells",
      note: "terminal never answered",
      reason: "timeout",
    })
    expect(row.observations).toHaveLength(catalogIds.length)
  })

  it("refuses a missing required suite", () => {
    expect(() => buildFullProjectRows({ census: [app], catalogIds, candidates: [], requiredSuiteId: "" })).toThrow(
      /needs the suite/,
    )
  })
})
