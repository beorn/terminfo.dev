/**
 * @failure An open cell no probe can answer stays counted as open with no reason, a declaration overrides a real
 *   probe result, a row with no second person's review lands, a row that matches nothing does nothing, or a reviewed
 *   declaration is folded into probe-answered counts without a split.
 * @level l2
 * @consumer projectResults, publicResults and currentCoverageSentence, the one selection and the one coverage line
 *   every site page, census and script reads (@cto 82a54984 (c), PLAN GO b0d3cd4e).
 * @testonly none
 */
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { parseRun } from "@terminfo/run-parser"
import type { ProbeResult, ProbeSuiteManifest } from "@terminfo/probe-defs"
import { initializeRunDraft } from "@terminfo/probe-defs"
import { finalizeCollectedDraft } from "../packages/terminfo.dev/src/capture-writer.ts"
import {
  DECLARED_UNTESTABLE_FILE,
  loadDeclaredUntestable,
  publicDeclaredReason,
  type DeclaredUntestableCell,
} from "../docs/data/declared-untestable.ts"
import type { ReopenedCell } from "../docs/data/reopened-cells.ts"
import { projectResults } from "../docs/data/selected-results.ts"
import { publicResults } from "../docs/data/public-results.ts"
import { aggregateCurrentResults, currentCoverageSentence } from "../docs/data/release-scope.ts"

const MARKS = "extensions.osc133-marks"
const BLINK = "sgr.blink"
const ids = [MARKS, BLINK, "sgr.bold"]
const SUITE: ProbeSuiteManifest & { schemaVersion: 4 } = {
  schemaVersion: 4,
  probeHash: "suite",
  sourceRevision: "1".repeat(40),
  generatedAt: "2026-11-13T05:00:00.000Z",
  adapterVersion: "3.3.2",
  catalogIds: ids,
  probes: { term: [], lib: [], mux: [] },
}

/** One schema-4 alacritty run on Linux: every id an untouched TODO except the measured ones. */
function run(runId: string, measured: Record<string, "supported" | "unsupported">, measuredAt: string) {
  const attempt = { scope: "probe" as const, startedAt: measuredAt }
  const draft = initializeRunDraft({
    runId,
    sourceRevision: SUITE.sourceRevision!,
    manifest: SUITE,
    source: { kind: "live" },
    intendedSubject: { kind: "term", id: "alacritty" },
  })
  draft.subject = {
    kind: "term",
    id: "alacritty",
    version: "0.15.1",
    os: "linux",
    osVersion: "7.0.0",
    outerTerminal: null,
    mux: null,
    config: "alacritty bun collector",
    permissions: null,
  }
  draft.identity = "verified"
  draft.measuredAt = measuredAt
  draft.origin = { kind: "collector" }
  const entries = Object.entries(measured)
  draft.rawReplies = Object.fromEntries(entries.map(([id, status]) => [id, status === "supported" ? "ACK" : "NO"]))
  draft.results = ids.map((featureId): ProbeResult => {
    const index = entries.findIndex(([id]) => id === featureId)
    const status = measured[featureId]
    if (!status) return { featureId, status: "probe-todo", attempt: { scope: "none" }, tests: [], reason: "Not run" }
    return {
      featureId,
      status,
      assertionType: "query_reply",
      rawReplyRef: featureId,
      attempt,
      tests: [{ id: "criterion", status, attempt, assertionRefs: [index], rawReplyRef: featureId }],
    }
  })
  const value = finalizeCollectedDraft(draft as Parameters<typeof finalizeCollectedDraft>[0])
  return parseRun(
    `${runId}.json`,
    JSON.stringify({
      ...value,
      assertions: entries.map(([featureId, status]) => ({
        featureId,
        kind: status === "supported" ? "positive" : "negative",
        assertionType: "query_reply",
        rawReplyRef: featureId,
        expected: "a reply",
        observed: status === "supported" ? "ACK" : "DA1 answered at +1ms; no reply through the 250 ms window",
      })),
    }),
    ids,
    new Map([[SUITE.probeHash, SUITE]]),
  )
}

const marksRow = (overrides: Partial<DeclaredUntestableCell> = {}): DeclaredUntestableCell => ({
  kind: "term",
  id: "alacritty",
  os: "linux",
  featureId: MARKS,
  reason: "the terminal has no observer that reads its prompt marks back",
  testableIf: "the terminal exposes its marks to a script, or a probe reads them from the screen",
  declaredBy: "@dev/18",
  declaredOn: "2026-11-13",
  reviewedBy: "@cpo/term",
  reviewedOn: "2026-11-13",
  ruling: "@cto 2026-11-13 09:55 PST (b0d3cd4e), test row",
  ...overrides,
})

const first = run("first", { [BLINK]: "unsupported", "sgr.bold": "supported" }, "2026-11-13T05:00:00.000Z")
const project = (
  runs: ReturnType<typeof run>[],
  declared: DeclaredUntestableCell[],
  extra: { reopened?: ReopenedCell[]; log?: (line: string) => void } = {},
) => projectResults(runs, ids, { currentProbeHash: SUITE.probeHash, declared, ...extra }, [])

describe("declared-untestable cells (@cto 82a54984 (c))", () => {
  it("moves one open cell: open -1, untestable +1, by review +1, nothing else; result and origin stay", () => {
    const before = project([first], []).contexts["term:alacritty"]!
    const lines: string[] = []
    const after = project([first], [marksRow()], { log: (line) => lines.push(line) }).contexts["term:alacritty"]!
    expect(before.cells[MARKS]!.featureResult!.status).toBe("probe-todo")
    expect(after.cells[MARKS]!.featureResult).toMatchObject({ status: "untestable", strength: null })
    expect(after.cells[MARKS]!.result).toEqual(before.cells[MARKS]!.result)
    expect(after.cells[MARKS]!.origin).toEqual(before.cells[MARKS]!.origin)
    expect(after.cells[MARKS]!.declared).toEqual({
      reason: "the terminal has no observer that reads its prompt marks back",
      testableIf: "the terminal exposes its marks to a script, or a probe reads them from the screen",
      reviewedOn: "2026-11-13",
    })
    for (const id of [BLINK, "sgr.bold"]) {
      expect(JSON.stringify(after.cells[id]), id).toBe(JSON.stringify(before.cells[id]))
    }
    // Condition 5: the counts move by exactly the declared cell, and the split is visible.
    const counts = (summary: typeof before) =>
      aggregateCurrentResults(
        ids.map((featureId) => ({
          featureId,
          status: summary.cells[featureId]!.featureResult!.status,
          ...(summary.cells[featureId]!.declared && { declared: summary.cells[featureId]!.declared }),
        })),
        ids,
      )
    const was = counts(before)
    const now = counts(after)
    expect(now.counts["probe-todo"]).toBe(was.counts["probe-todo"] - 1)
    expect(now.counts.untestable).toBe(was.counts.untestable + 1)
    expect(now.byReview).toBe(was.byReview + 1)
    expect(now.counts.supported).toBe(was.counts.supported)
    expect(now.counts.unsupported).toBe(was.counts.unsupported)
    expect(now.supported).toBe(was.supported)
    expect(now.derived).toBe(was.derived)
    expect(currentCoverageSentence(now)).toContain("1 Untestable (1 by review) · 0 PROBE TODO")
    // A bar with no declared cell prints exactly what it printed before the table existed.
    expect(currentCoverageSentence(was)).toContain("0 Untestable · 1 PROBE TODO")
    // Condition 3: the build output lists every cell a row changed.
    expect(lines).toContain(
      "declared untestable by review: term:alacritty/extensions.osc133-marks (row term:alacritty/linux/extensions.osc133-marks)",
    )
  })

  it("publishes a reviewed sentence, never a grade, and never the declarer, reviewer or ruling", () => {
    const projection = project([first], [marksRow()])
    const cell = publicResults(projection, new Map()).projection.contexts["term:alacritty"]!.featureResults[MARKS]!
    expect(cell.status).toBe("untestable")
    expect(cell.reason).toBe(
      "untestable by review 2026-11-13: the terminal has no observer that reads its prompt marks back; testable once " +
        "the terminal exposes its marks to a script, or a probe reads them from the screen",
    )
    expect(JSON.stringify(cell)).not.toMatch(/@|b0d3cd4e|unsupported/i)
  })

  it("a probe result beats a declaration: a measured, reopened or missing cell throws naming the row to remove", () => {
    const measured = run("measured", { [MARKS]: "supported" }, "2026-11-13T06:00:00.000Z")
    expect(() => project([first, measured], [marksRow()])).toThrow(
      /Declared-untestable cell term:alacritty\/linux\/extensions\.osc133-marks reads supported in term:alacritty \(run measured\); a probe result beats a declaration, so remove this row from content\/declared-untestable\.json/,
    )
    expect(() => project([first], [marksRow({ featureId: BLINK })])).toThrow(/reads unsupported .*remove this row/)
    const reopened: ReopenedCell = {
      kind: "term",
      id: "alacritty",
      os: "linux",
      featureId: BLINK,
      graded: "unsupported",
      reason: "withdrawn until it is measured again",
      reopenedOn: "2026-11-13",
      ruling: "test",
      evidence: "test",
      exit: { kind: "remeasured", suiteIds: [first.suiteId] },
      witnesses: [{ runId: "first", assertionIndex: 0 }],
    }
    expect(() => project([first], [marksRow({ featureId: BLINK })], { reopened: [reopened] })).toThrow(
      /reads reopened .*remove this row/,
    )
    expect(() => project([first], [marksRow({ id: "kitty" })])).toThrow(
      /1 declared-untestable row\(s\) match no context cell: term:kitty\/linux\/extensions\.osc133-marks; remove this row/,
    )
  })
})

describe("loadDeclaredUntestable", () => {
  const write = (rows: unknown[]): string => {
    const dir = mkdtempSync(join(tmpdir(), "declared-"))
    writeFileSync(join(dir, DECLARED_UNTESTABLE_FILE), JSON.stringify({ rows }))
    return dir
  }

  it("reads a reviewed row; a missing file is no rows", () => {
    expect(loadDeclaredUntestable(write([marksRow()]))).toEqual([marksRow()])
    expect(loadDeclaredUntestable(mkdtempSync(join(tmpdir(), "declared-none-")))).toEqual([])
  })

  it("refuses a row without its review, a reviewer who is the declarer, and a duplicate cell", () => {
    const { reviewedBy: _by, ...noReviewer } = marksRow()
    expect(() => loadDeclaredUntestable(write([noReviewer]))).toThrow(/reviewedBy must be a non-empty string/)
    expect(() => loadDeclaredUntestable(write([{ ...marksRow(), reviewedOn: "today" }]))).toThrow(
      /reviewedOn must be YYYY-MM-DD/,
    )
    expect(() => loadDeclaredUntestable(write([marksRow({ reviewedBy: "@dev/18" })]))).toThrow(
      /reviewedBy is the declarer \(@dev\/18\); a row needs a second person's review/,
    )
    expect(() => loadDeclaredUntestable(write([marksRow(), marksRow()]))).toThrow(/declared twice/)
    const { testableIf: _exit, ...noExit } = marksRow()
    expect(() => loadDeclaredUntestable(write([noExit]))).toThrow(/testableIf must be a non-empty string/)
  })

  it("refuses public words that name a seat, an id or an issue, or that read as a grade", () => {
    for (const reason of ["declared per @cto", "see b0d3cd4e", "see #33117", "see issue 33164"]) {
      expect(() => loadDeclaredUntestable(write([marksRow({ reason })])), reason).toThrow(
        /the public reason names a seat, an id or an issue number/,
      )
    }
    expect(() => loadDeclaredUntestable(write([marksRow({ reason: "marks are unsupported here" })]))).toThrow(
      /the public reason reads as a grade/,
    )
    expect(() => loadDeclaredUntestable(write([marksRow({ testableIf: "it becomes supported" })]))).toThrow(
      /the public testableIf reads as a grade/,
    )
    expect(publicDeclaredReason(marksRow())).not.toMatch(/@/)
  })

  it("the committed table is absent or holds only reviewed rows", () => {
    const content = join(import.meta.dirname, "..", "content")
    for (const row of loadDeclaredUntestable(content)) {
      expect(row.reviewedBy).not.toBe(row.declaredBy)
    }
  })
})
