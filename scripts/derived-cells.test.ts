/**
 * @failure A refused parent leaves its child reading Untestable, a child derives from a parent that is open, invalid,
 *   missing, Supported, reopened or itself derived, a derived cell looks like a direct measurement, or a Supported
 *   child under a refused parent passes silently.
 * @level l2
 * @consumer projectResults and publicResults, the one selection every site page, census and script reads (33019).
 * @testonly none
 */
import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { parseRun } from "@terminfo/run-parser"
import type { ProbeResult, ProbeSuiteManifest } from "@terminfo/probe-defs"
import { initializeRunDraft } from "@terminfo/probe-defs"
import { finalizeCollectedDraft } from "../packages/terminfo.dev/src/capture-writer.ts"
import { DERIVED_UNSUPPORTED, publicDerivedReason } from "../docs/data/derived-cells.ts"
import type { ReopenedCell } from "../docs/data/reopened-cells.ts"
import { projectResults } from "../docs/data/selected-results.ts"
import { publicResults } from "../docs/data/public-results.ts"
import {
  aggregateCurrentResults,
  currentCoverageSentence,
  decisiveCells,
  runDecidedNothing,
} from "../docs/data/release-scope.ts"

const catalogue = JSON.parse(readFileSync(new URL("../content/features.json", import.meta.url), "utf8")) as Record<
  string,
  { probe?: string } | undefined
>

const TRANSMIT = "extensions.kitty-graphics.transmit"
const DISPLAY = "extensions.kitty-graphics.display"
const ids = [TRANSMIT, DISPLAY, "sgr.bold"]
const SUITE: ProbeSuiteManifest & { schemaVersion: 4 } = {
  schemaVersion: 4,
  probeHash: "suite",
  sourceRevision: "1".repeat(40),
  generatedAt: "2026-11-10T05:00:00.000Z",
  adapterVersion: "3.3.2",
  catalogIds: ids,
  probes: { term: [], lib: [], mux: [] },
}
const SILENCE = "DA1 answered at +0ms; no reply through the 250 ms window"
const NO_SETUP =
  "Untestable (no setup): Kitty graphics transmit has no reply to either a=t or a=q after their DA1 controls, so the display cell has no image to place"

type Row =
  | { status: "supported" | "unsupported" }
  | { status: "untestable" | "probe-invalid" | "probe-todo"; reason: string }

/** One schema-4 xterm run on Linux; decided rows carry a query_reply witness, open rows only their reason. */
function run(runId: string, rows: Record<string, Row>) {
  const measuredAt = "2026-11-10T05:00:00.000Z"
  const attempt = { scope: "probe" as const, startedAt: measuredAt }
  const draft = initializeRunDraft({
    runId,
    sourceRevision: SUITE.sourceRevision!,
    manifest: SUITE,
    source: { kind: "live" },
    intendedSubject: { kind: "term", id: "xterm" },
  })
  draft.subject = {
    kind: "term",
    id: "xterm",
    version: "411",
    os: "linux",
    osVersion: "7.0.0",
    outerTerminal: null,
    mux: null,
    config: "xterm bun collector",
    permissions: null,
  }
  draft.identity = "verified"
  draft.measuredAt = measuredAt
  draft.origin = { kind: "collector" }
  const decided = Object.entries(rows).filter(([, row]) => row.status === "supported" || row.status === "unsupported")
  draft.rawReplies = Object.fromEntries(
    Object.entries(rows).map(([id, row]) => [id, row.status === "supported" ? "ACK" : "NO"]),
  )
  draft.results = ids.map((featureId): ProbeResult => {
    const row = rows[featureId]
    if (!row) return { featureId, status: "probe-todo", attempt: { scope: "none" }, tests: [], reason: "Not run" }
    if ("reason" in row) {
      // The stored shape of an open row (xterm 411's kitty display row): one test carrying the reason.
      const testId = row.status === "untestable" ? "declared-untestable" : "criterion"
      return {
        featureId,
        status: row.status,
        attempt,
        rawReplyRef: featureId,
        reason: row.reason,
        ...(row.status === "untestable" && { criterionBranch: "headless-observable-review" }),
        tests: [
          { id: testId, status: row.status, attempt, assertionRefs: [], rawReplyRef: featureId, reason: row.reason },
        ],
      }
    }
    const index = decided.findIndex(([id]) => id === featureId)
    return {
      featureId,
      status: row.status,
      assertionType: "query_reply",
      rawReplyRef: featureId,
      ...(row.status === "unsupported" && { reason: SILENCE }),
      attempt,
      tests: [{ id: "criterion", status: row.status, attempt, assertionRefs: [index], rawReplyRef: featureId }],
    }
  })
  const value = finalizeCollectedDraft(draft as Parameters<typeof finalizeCollectedDraft>[0])
  return parseRun(
    `${runId}.json`,
    JSON.stringify({
      ...value,
      assertions: decided.map(([featureId, row]) => ({
        featureId,
        kind: row.status === "supported" ? "positive" : "negative",
        assertionType: "query_reply",
        rawReplyRef: featureId,
        expected: "a reply",
        observed: row.status === "supported" ? "ACK" : SILENCE,
      })),
    }),
    ids,
    new Map([[SUITE.probeHash, SUITE]]),
  )
}

const project = (runs: ReturnType<typeof run>[], reopened: ReopenedCell[] = []) =>
  projectResults(runs, ids, { currentProbeHash: SUITE.probeHash, reopened }, [])
const context = (runs: ReturnType<typeof run>[], reopened: ReopenedCell[] = []) =>
  project(runs, reopened).contexts["term:xterm"]!

describe("unsupported, derived (33019)", () => {
  it("derives the child from a parent refused with its own witness, keeping the child's own reading as a note", () => {
    const measured = run("r1", {
      [TRANSMIT]: { status: "unsupported" },
      [DISPLAY]: { status: "untestable", reason: NO_SETUP },
    })
    const ctx = context([measured])
    const cell = ctx.cells[DISPLAY]!
    expect(cell.featureResult).toMatchObject({ status: "unsupported", strength: null })
    expect(cell.result.status).toBe("untestable")
    expect(cell.derived).toEqual({
      parent: TRANSMIT,
      parentName: "Kitty graphics transmit",
      parentRunId: "r1",
      parentReason: SILENCE,
      needs: "an image must be transmitted before it can be displayed",
      ownStatus: "untestable",
      ownReason: NO_SETUP,
    })
    expect(ctx.derivedIds).toEqual([DISPLAY])
    expect(ctx.counts.unsupported).toBe(2)
    expect(ctx.counts.untestable).toBe(0)
    const published = publicResults(project([measured]), new Map()).projection.contexts["term:xterm"]!
    expect(published.featureResults[DISPLAY]!.status).toBe("unsupported")
    expect(published.featureResults[DISPLAY]!.reason).toBe(
      `Unsupported, derived: Kitty graphics transmit was refused in run r1 (${SILENCE}); an image must be transmitted before it can be displayed.`,
    )
    expect(published.derivedIds).toEqual([DISPLAY])
  })

  it("counts a derived cell inside Unsupported, says so beside it, and never as a measurement (@cto 448e41b5)", () => {
    const projection = project([
      run("r1", {
        [TRANSMIT]: { status: "unsupported" },
        [DISPLAY]: { status: "untestable", reason: NO_SETUP },
        "sgr.bold": { status: "untestable", reason: "Untestable (no way): declared" },
      }),
    ])
    const ctx = projection.contexts["term:xterm"]!
    expect(ctx.counts.unsupported).toBe(2)
    expect(ctx.derivedIds).toHaveLength(1)
    expect(decisiveCells(ctx.counts, ctx.derivedIds.length)).toBe(1)
    // The page bar path: an aggregate over the published feature results carries the same split.
    const published = publicResults(projection, new Map()).projection.contexts["term:xterm"]!
    const bar = aggregateCurrentResults(Object.values(published.featureResults), published.catalogIds)
    expect(bar.counts.unsupported).toBe(2)
    expect(bar.derived).toBe(1)
    expect(currentCoverageSentence(bar)).toContain("2 Unsupported (of which derived: 1)")
    expect(runDecidedNothing(bar.counts, bar.derived)).toBe(false)
  })

  it("a run whose only Unsupported cells are derived decided nothing", () => {
    expect(
      runDecidedNothing({ supported: 0, unsupported: 2, untestable: 0, "probe-todo": 0, "probe-invalid": 0 }, 2),
    ).toBe(true)
  })

  it.each([
    ["untestable", { status: "untestable", reason: "Untestable (no way): declared" }],
    ["probe-invalid", { status: "probe-invalid", reason: "control failed" }],
    ["probe-todo", { status: "probe-todo", reason: "Not run" }],
    ["supported", { status: "supported" }],
  ] as const)("a %s parent entails nothing: the child keeps its own reading", (_label, parent) => {
    const ctx = context([run("r1", { [TRANSMIT]: parent, [DISPLAY]: { status: "untestable", reason: NO_SETUP } })])
    expect(ctx.cells[DISPLAY]!.featureResult!.status).toBe("untestable")
    expect(ctx.cells[DISPLAY]!.derived).toBeUndefined()
    expect(ctx.derivedIds).toEqual([])
  })

  it("a missing parent entails nothing", () => {
    const ctx = context([run("r1", { [DISPLAY]: { status: "untestable", reason: NO_SETUP } })])
    expect(ctx.cells[DISPLAY]!.featureResult!.status).toBe("untestable")
    expect(ctx.derivedIds).toEqual([])
  })

  it("a child already decided Unsupported stays direct", () => {
    const ctx = context([run("r1", { [TRANSMIT]: { status: "unsupported" }, [DISPLAY]: { status: "unsupported" } })])
    expect(ctx.cells[DISPLAY]!.derived).toBeUndefined()
    expect(ctx.derivedIds).toEqual([])
  })

  it("a Supported child under a refused parent throws, naming the pair and @cto", () => {
    expect(() =>
      context([run("r1", { [TRANSMIT]: { status: "unsupported" }, [DISPLAY]: { status: "supported" } })]),
    ).toThrow(
      /Derived pair extensions\.kitty-graphics\.transmit -> extensions\.kitty-graphics\.display in term:xterm: .*bring it to @cto/,
    )
  })

  it("a parent reopened by a ruling reads probe-todo, so the child is no longer derived", () => {
    const measured = run("r1", {
      [TRANSMIT]: { status: "unsupported" },
      [DISPLAY]: { status: "untestable", reason: NO_SETUP },
    })
    const reopened: ReopenedCell = {
      kind: "term",
      id: "xterm",
      os: "linux",
      featureId: TRANSMIT,
      graded: "unsupported",
      reason: "withdrawn",
      reopenedOn: "2026-11-10",
      ruling: "test",
      evidence: "test",
      exit: { kind: "remeasured", suiteIds: [SUITE.probeHash] },
      witnesses: [{ runId: "r1", assertionIndex: 0 }],
    }
    const ctx = context([measured], [reopened])
    expect(ctx.cells[TRANSMIT]!.featureResult!.status).toBe("probe-todo")
    expect(ctx.cells[DISPLAY]!.featureResult!.status).toBe("untestable")
    expect(ctx.derivedIds).toEqual([])
  })

  it("never derives from a derived parent: a declared chain stops at the first link", () => {
    const chain = [
      { child: DISPLAY, parent: TRANSMIT, parentName: "transmit", needs: "a" },
      { child: "sgr.bold", parent: DISPLAY, parentName: "display", needs: "b" },
    ]
    const measured = run("r1", {
      [TRANSMIT]: { status: "unsupported" },
      [DISPLAY]: { status: "untestable", reason: NO_SETUP },
      "sgr.bold": { status: "untestable", reason: "Untestable (no way): declared" },
    })
    const ctx = projectResults([measured], ids, { currentProbeHash: SUITE.probeHash, derived: chain }, []).contexts[
      "term:xterm"
    ]!
    expect(ctx.derivedIds).toEqual([DISPLAY])
    expect(ctx.cells["sgr.bold"]!.featureResult!.status).toBe("untestable")
  })

  it("every declared pair names features in the catalogue, and no child is its own parent", () => {
    for (const pair of DERIVED_UNSUPPORTED) {
      // #33441: a misspelt child silently never fires - applyDerived skips an id it cannot find - so membership is
      // asserted against the recorded catalogue itself, not against a second hand-kept list.
      expect(catalogue[pair.child], `${pair.child} must exist in the recorded catalogue`).toBeDefined()
      expect(catalogue[pair.parent], `${pair.parent} must exist in the recorded catalogue`).toBeDefined()
      expect(pair.child).not.toBe(pair.parent)
      expect(
        publicDerivedReason({
          ...pair,
          parentRunId: "r",
          parentReason: null,
          ownStatus: "untestable",
          ownReason: null,
        }),
      ).toMatch(/^Unsupported, derived: .+ was refused in run r; .+\.$/)
    }
    expect(new Set(DERIVED_UNSUPPORTED.map((pair) => pair.child)).size).toBe(DERIVED_UNSUPPORTED.length)
  })
})
