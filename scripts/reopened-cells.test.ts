/**
 * @failure A ruling-withdrawn grade stays published, a reopen follows a run id instead of its cell, a stale or
 *   unmatched row silently does nothing, or the page shows a bare probe-todo with no reason.
 * @level l2
 * @consumer projectResults and publicResults, the one selection every site page, census and script reads (33164).
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
import { cellLabel, loadReopenedCells, publicReopenedReason, type ReopenedCell } from "../docs/data/reopened-cells.ts"
import { projectResults } from "../docs/data/selected-results.ts"
import { publicResults } from "../docs/data/public-results.ts"

const VERSION = "extensions.osc702-version"
const BLINK = "sgr.blink"
const ids = [VERSION, BLINK, "sgr.bold"]
const suite = (probeHash: string): ProbeSuiteManifest & { schemaVersion: 4 } => ({
  schemaVersion: 4,
  probeHash,
  sourceRevision: "1".repeat(40),
  generatedAt: "2026-11-10T05:00:00.000Z",
  adapterVersion: "3.3.2",
  catalogIds: ids,
  probes: { term: [], lib: [], mux: [] },
})
const OLD = suite("old-suite")
const NEW = suite("new-suite")
const SILENCE = "DA1 answered at +1ms; no reply through the 250 ms window"

type Measured = Record<string, "supported" | "unsupported">

/** One schema-4 xterm run on Linux: every id an untouched TODO except the measured ones; negatives observe silence. */
function run(runId: string, measured: Measured, measuredAt: string, manifest = OLD) {
  const attempt = { scope: "probe" as const, startedAt: measuredAt }
  const draft = initializeRunDraft({
    runId,
    sourceRevision: manifest.sourceRevision!,
    manifest,
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
        observed: status === "supported" ? "ACK" : SILENCE,
      })),
    }),
    ids,
    new Map([
      [OLD.probeHash, OLD],
      [NEW.probeHash, NEW],
    ]),
  )
}

const silenceRow = (overrides: Partial<ReopenedCell> = {}): ReopenedCell => ({
  kind: "term",
  id: "xterm",
  os: "linux",
  featureId: VERSION,
  graded: "unsupported",
  reason: "the criterion text does not say a silent terminal is Unsupported",
  reopenedOn: "2026-11-10",
  ruling: "@cto 2026-11-10 12:21 PST (0a45cb8b), issue 33164",
  evidence: "test",
  exit: { kind: "criterion-text", criterionSha256: "0".repeat(64) },
  witnesses: [{ runId: "first", assertionIndex: 0 }],
  ...overrides,
})
const blinkRow = (suiteIds: string[]): ReopenedCell => ({
  ...silenceRow(),
  featureId: BLINK,
  reason: "withdrawn until it is measured again",
  ruling: "@cto 2026-11-10 12:42 PST (f58c5889) item 3, issue 33117",
  exit: { kind: "remeasured", suiteIds },
  witnesses: [{ runId: "first", assertionIndex: 1 }],
})

const project = (runs: ReturnType<typeof run>[], reopened: ReopenedCell[]) =>
  projectResults(runs, ids, { currentProbeHash: NEW.probeHash, reopened }, [])

const first = run(
  "first",
  { [VERSION]: "unsupported", [BLINK]: "unsupported", "sgr.bold": "supported" },
  "2026-11-10T05:00:00.000Z",
)

describe("reopened cells (33164)", () => {
  it("reopens a criterion-text cell: the feature result reads probe-todo, the witnessed original and every other cell stay", () => {
    const without = project([first], [])
    const withIt = project([first], [silenceRow()])
    const before = without.contexts["term:xterm"]!
    const after = withIt.contexts["term:xterm"]!
    expect(before.cells[VERSION]!.featureResult!.status).toBe("unsupported")
    expect(after.cells[VERSION]!.featureResult).toMatchObject({ status: "probe-todo", strength: null })
    expect(after.cells[VERSION]!.result).toEqual(before.cells[VERSION]!.result)
    expect(after.cells[VERSION]!.origin).toEqual(before.cells[VERSION]!.origin)
    expect(after.cells[VERSION]!.reopened).toEqual({
      reason: "the criterion text does not say a silent terminal is Unsupported",
      reopenedOn: "2026-11-10",
      exit: "criterion-text",
    })
    for (const id of [BLINK, "sgr.bold"]) {
      expect(JSON.stringify(after.cells[id]), id).toBe(JSON.stringify(before.cells[id]))
    }
    // The published total moves by exactly the reopened cells: one unsupported becomes one open.
    expect(after.counts.unsupported).toBe(before.counts.unsupported - 1)
    expect(after.counts["probe-todo"]).toBe(before.counts["probe-todo"] + 1)
  })

  it("follows the cell, not the run: a newer run of the same cell graded the same way stays reopened", () => {
    const later = run("later", { [VERSION]: "unsupported" }, "2026-11-10T06:00:00.000Z")
    const after = project([first, later], [silenceRow()]).contexts["term:xterm"]!
    expect(after.cells[VERSION]!.origin.runId).toBe("later")
    expect(after.cells[VERSION]!.featureResult!.status).toBe("probe-todo")
  })

  it("shows the reason and the date in words on the published cell, never the ruling's seat, ids or issue", () => {
    const projection = project([first], [silenceRow()])
    const cell = publicResults(projection, new Map()).projection.contexts["term:xterm"]!.featureResults[VERSION]!
    expect(cell.status).toBe("probe-todo")
    expect(cell.reason).toBe("reopened 2026-11-10: the criterion text does not say a silent terminal is Unsupported")
    expect(JSON.stringify(cell)).not.toMatch(/@|0a45cb8b|33164/)
  })

  it("reopens a remeasured cell only under the suites it names; a later suite's grade makes the row throw", () => {
    const suiteId = first.suiteId
    expect(project([first], [blinkRow([suiteId])]).contexts["term:xterm"]!.cells[BLINK]!.featureResult!.status).toBe(
      "probe-todo",
    )
    const remeasured = run("remeasured", { [BLINK]: "unsupported" }, "2026-11-10T07:00:00.000Z", NEW)
    expect(() => project([first, remeasured], [blinkRow([suiteId])])).toThrow(
      /Reopened cell term:xterm\/linux\/sgr\.blink is graded unsupported .* by run remeasured under suite .*which the row does not name; it was re-measured, so delete the row/,
    )
  })

  it("never matches silently: a cell no longer graded as withdrawn, or a missing witness, throws naming the row", () => {
    const fixed = run("fixed", { [VERSION]: "supported" }, "2026-11-10T06:00:00.000Z")
    expect(() => project([first, fixed], [silenceRow()])).toThrow(
      /1 reopened row\(s\) match no context cell graded as withdrawn; delete or re-confirm: term:xterm\/linux\/extensions\.osc702-version \(unsupported\)/,
    )
    expect(() => project([first], [silenceRow({ id: "kitty" })])).toThrow(/match no context cell/)
    expect(() => project([first], [silenceRow({ witnesses: [{ runId: "gone", assertionIndex: 0 }] })])).toThrow(
      /cites witness run gone, which is not placed/,
    )
    expect(() => project([first], [silenceRow({ witnesses: [{ runId: "first", assertionIndex: 1 }] })])).toThrow(
      /cites first assertion 1, which is for sgr\.blink/,
    )
  })
})

describe("loadReopenedCells", () => {
  const write = (rows: unknown[]): string => {
    const dir = mkdtempSync(join(tmpdir(), "reopened-"))
    writeFileSync(join(dir, "reopened-cells.json"), JSON.stringify({ rows }))
    return dir
  }
  const features = { [VERSION]: { probe: "Missing or malformed replies remain inconclusive." } }
  const sha = "7d3c1d9d7c1f2a7b3f0d4b8e6a5c9e2f1a0b3c4d5e6f708192a3b4c5d6e7f809"

  it("throws when the criterion text under a criterion-text row changed, naming the row", () => {
    const dir = write([silenceRow({ exit: { kind: "criterion-text", criterionSha256: sha } })])
    expect(() => loadReopenedCells(dir, features)).toThrow(
      /the criterion text changed under 1 reopened row\(s\); delete or re-confirm: term:xterm\/linux\/extensions\.osc702-version/,
    )
  })

  it("refuses a duplicate cell, an exit without its fence, and an empty witness list", () => {
    expect(() => loadReopenedCells(write([blinkRow(["s"]), blinkRow(["s"])]), features)).toThrow(/reopened twice/)
    expect(() =>
      loadReopenedCells(write([{ ...blinkRow(["s"]), exit: { kind: "remeasured", suiteIds: [] } }]), features),
    ).toThrow(/a remeasured exit names its suite ids/)
    expect(() => loadReopenedCells(write([{ ...blinkRow(["s"]), witnesses: [] }]), features)).toThrow(
      /witnesses must be non-empty/,
    )
  })

  it("refuses a public reason that names a seat, a hex id or an issue number, and a missing date", () => {
    for (const reason of ["withdrawn per @cto", "withdrawn by f58c5889", "see #33117", "see issue 33164"]) {
      expect(() => loadReopenedCells(write([{ ...silenceRow(), reason }]), features), reason).toThrow(
        /the public reason names a seat, an id or an issue number/,
      )
    }
    expect(() => loadReopenedCells(write([{ ...blinkRow(["s"]), reopenedOn: "today" }]), features)).toThrow(
      /reopenedOn must be YYYY-MM-DD/,
    )
  })

  it("the committed file holds the generated 42 rows (39 criterion-text, 3 remeasured), all current", async () => {
    const content = join(import.meta.dirname, "..", "content")
    const { loadFeatures } = await import("@terminfo/catalog")
    const rows = loadReopenedCells(content, loadFeatures(content))
    expect(rows).toHaveLength(42)
    expect(rows.filter((row) => row.exit.kind === "criterion-text")).toHaveLength(39)
    expect(rows.filter((row) => row.exit.kind === "remeasured").map((row) => `${row.id}/${row.featureId}`)).toEqual([
      "alacritty/sgr.blink",
      "ghostty/sgr.blink",
      "iterm2/sgr.blink",
    ])
    for (const row of rows) expect(publicReopenedReason(row), cellLabel(row)).not.toMatch(/@|\b[0-9a-f]{7,}\b|#\d|\b\d{5}\b/)
  })
})
