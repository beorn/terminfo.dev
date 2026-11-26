/**
 * @failure A library is graded on a feature only an app window can measure (OS input, glyph drawing), an App only cell
 *   is counted as Supported, Unsupported or open on the library row, the stored library result is rewritten, or a
 *   terminal row loses its graded cell to the label.
 * @level l2
 * @consumer projectResults, the one selection every site page, census and script reads (#38772, @cto e777b8ab).
 * @testonly none
 */
import { describe, expect, it } from "vitest"
import { parseRun } from "@terminfo/run-parser"
import type { ProbeResult, ProbeSuiteManifest } from "@terminfo/probe-defs"
import { initializeRunDraft } from "@terminfo/probe-defs"
import { finalizeCollectedDraft } from "../packages/terminfo.dev/src/capture-writer.ts"
import { APP_ONLY, featurePageCounts, joinContextCells, type ContextCellFacts } from "../docs/data/app-cells.ts"
import { aggregateCurrentResults, currentCoverageSentence } from "../docs/data/release-scope.ts"
import { categoryIds } from "../docs/data/result-categories.ts"
import { evidenceStatus, evidenceStatusWords } from "../docs/.vitepress/theme/evidence-status.ts"
import { catalogAppOnly } from "../docs/data/app-only-cells.ts"
import { projectResults } from "../docs/data/selected-results.ts"
import { UNANSWERED_QUERY } from "./stored-exchange.fixture.ts"

const CLICK = "input.xtest-click"
const BOLD = "sgr.bold"
const ids = [CLICK, BOLD]
const SUITE: ProbeSuiteManifest & { schemaVersion: 4 } = {
  schemaVersion: 4,
  probeHash: "suite",
  sourceRevision: "1".repeat(40),
  generatedAt: "2026-11-10T05:00:00.000Z",
  adapterVersion: "3.3.2",
  catalogIds: ids,
  probes: { term: [], lib: [], mux: [] },
}
const OS_INPUT = "OS input reaches only an app window; a library gets no OS keys or clicks."
const APP_ONLY_ROWS = new Map([[CLICK, { reason: OS_INPUT }]])
/** A retained xterm.js runtime identity, as consumer-selection.test.ts records one. */
const LIB_RUNTIME = {
  kind: "js",
  adapterVersion: "0.10.2",
  termlessRevision: "4b39770c169ec393cfd6ec7f59110e91c9c9d0c5",
  resolvedPath: "node_modules/.bun/@xterm+headless@6.0.0/node_modules/@xterm/headless/lib-headless/xterm-headless.js",
  integrity: {
    kind: "registry",
    lockIntegrity: "sha512-5Yj1QINYCyzrZtf8OFIHi47iQtI+0qYFPHmouEfG8dHNxbZ9Tb9YGSuLcsEwj9Z+OL75GJqPyJbyoFer80a2Hw==",
  },
  runtimeFormat: "js",
  engineVersion: "6.0.0",
}

/** One schema-4 Linux run of a terminal or a library in which both features read Supported by a query reply. */
function run(kind: "term" | "lib", runId: string) {
  const measuredAt = "2026-11-10T05:00:00.000Z"
  const attempt = { scope: "probe" as const, startedAt: measuredAt }
  const id = kind === "term" ? "xterm" : "xtermjs"
  const draft = initializeRunDraft({
    runId,
    sourceRevision: SUITE.sourceRevision!,
    manifest: SUITE,
    source: { kind: "live" },
    intendedSubject: { kind, id },
  })
  draft.subject = {
    kind,
    id,
    version: kind === "term" ? "411" : "6.0.0",
    os: "linux",
    osVersion: "7.0.0",
    outerTerminal: null,
    mux: null,
    config: kind === "term" ? "xterm bun collector" : "80x24 default Termless backend",
    permissions: null,
  }
  draft.identity = "verified"
  draft.measuredAt = measuredAt
  draft.origin = { kind: "collector" }
  draft.rawReplies = Object.fromEntries(ids.map((featureId) => [featureId, UNANSWERED_QUERY]))
  draft.results = ids.map((featureId, index): ProbeResult => ({
    featureId,
    status: "supported",
    assertionType: "query_reply",
    rawReplyRef: featureId,
    attempt,
    tests: [{ id: "criterion", status: "supported", attempt, assertionRefs: [index], rawReplyRef: featureId }],
  }))
  const value = finalizeCollectedDraft(draft as Parameters<typeof finalizeCollectedDraft>[0])
  return parseRun(
    `${runId}.json`,
    JSON.stringify({
      ...value,
      ...(kind === "lib" && { runtimeIdentity: LIB_RUNTIME }),
      assertions: ids.map((featureId) => ({
        featureId,
        kind: "positive",
        assertionType: "query_reply",
        rawReplyRef: featureId,
        expected: "a reply",
        observed: "ACK",
      })),
    }),
    ids,
    new Map([[SUITE.probeHash, SUITE]]),
  )
}

const project = (runs: ReturnType<typeof run>[]) =>
  projectResults(runs, ids, { currentProbeHash: SUITE.probeHash, appOnly: APP_ONLY_ROWS }, [])

describe("App only on library rows (#38772)", () => {
  it("shows an app-only feature as App only on a library row, keeping the stored result and leaving it uncounted", () => {
    const ctx = project([run("lib", "l1")]).contexts["lib:xtermjs"]!
    const cell = ctx.cells[CLICK]!
    expect(cell.appOnly).toEqual({ reason: OS_INPUT })
    expect(cell.result.status).toBe("supported")
    expect(ctx.appOnlyIds).toEqual([CLICK])
    expect(ctx.counts).toMatchObject({ supported: 1, [APP_ONLY]: 1 })
    expect(ctx.score).toEqual({ supported: 1, all: 1 })
    expect(ctx.complete).toBe(true)
    // The site's coverage sentence names the catalogue it prints for; an App only cell is in that catalogue but out of
    // the counts, so the check must allow for it (the queue's site build refused 260 vs 264 without this).
    expect(currentCoverageSentence({ counts: ctx.counts }, ids)).toBe("1 of 1 tested")
  })

  it("leaves a terminal row graded as measured", () => {
    const ctx = project([run("term", "t1")]).contexts["term:xterm"]!
    expect(ctx.cells[CLICK]!.appOnly).toBeUndefined()
    expect(ctx.appOnlyIds).toEqual([])
    expect(ctx.counts).toMatchObject({ supported: 2, [APP_ONLY]: 0 })
    expect(ctx.score).toEqual({ supported: 2, all: 2 })
  })

  it("reads App only through the join and on the row: a label in its own tab, counted by no other category", () => {
    const facts = (runId: string, appOnly?: boolean): ContextCellFacts => ({
      status: "supported",
      version: "6.0.0",
      suite: "suite",
      entryHash: "entry",
      sourceRevision: "a".repeat(40),
      runId,
      ...(appOnly && { appOnly }),
    })
    const joined = joinContextCells(
      { key: "lib:a", cells: { [CLICK]: facts("l1", true), [BOLD]: facts("l1") } },
      [{ key: "lib:b", cells: { [CLICK]: facts("l2", true), [BOLD]: facts("l2") } }],
      ids,
      () => null,
    )
    expect(joined.cells[CLICK]).toMatchObject({ status: APP_ONLY, from: [] })
    expect(joined.counts).toMatchObject({ supported: 1, [APP_ONLY]: 1 })
    const bar = aggregateCurrentResults(
      [
        { featureId: CLICK, status: APP_ONLY },
        { featureId: BOLD, status: "supported" },
      ],
      ids,
    )
    expect(bar.denominator).toBe(1)
    const row = categoryIds(bar)
    expect(row["app-only"]).toEqual([CLICK])
    expect(row.supported).toEqual([BOLD])
    expect(row["no-result"]).toEqual([])
    expect(evidenceStatusWords(evidenceStatus(CLICK, APP_ONLY))).toBe("App only")
  })

  it("reaches the feature page as App only, in no count; an undecided result still refuses (the site build refused it)", () => {
    const rows = [
      { name: "vterm", result: APP_ONLY },
      { name: "xterm", result: "supported" },
      { name: "kitty", result: "unknown" },
    ]
    expect(featurePageCounts(rows, CLICK)).toEqual({ yesCount: 1, totalCount: 1, noResultCount: 1 })
    expect(() => featurePageCounts([{ name: "vterm", result: "probe-todo" }], CLICK)).toThrow(/undecided result "probe-todo"/)
  })

  it("reads the catalogue's declarations by default: the four features @cpo/term ruled (20882c8a), each with a reason", () => {
    const declared = catalogAppOnly()
    expect([...declared.keys()].sort()).toEqual([
      "extensions.font-ligatures",
      "input.xtest-click",
      "input.xtest-key",
      "input.xtest-wheel",
    ])
    expect(declared.get(CLICK)).toEqual({ reason: OS_INPUT })
  })
})
