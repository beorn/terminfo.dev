/**
 * @failure The mux-input demotion (@cto fa07833c, #33304) ran only in the instrument's cells.json, so the site and the
 *   status map, which read placed raw drafts, graded tmux's x10-mouse, application-keypad, modify-other-keys,
 *   modify-other-keys-3 and pixel-mouse Unsupported although outer Kitty of the same version reads them Unsupported too.
 * @level l1
 * @consumer composeContextSummaries (loadSelectedResults, write-selection, public results) through applyOuterAbsent (#33665).
 * @testonly none
 */
import { expect, test } from "vitest"
import { loadFeatures } from "@terminfo/catalog"
import type { LoadedRun } from "@terminfo/run-parser"
import { CONTENT_DIR, loadStoredRuns } from "../packages/admin/corpus-placement.ts"
import { probeHash } from "../packages/admin/versions.ts"
import { applyOuterAbsent } from "../docs/data/mux-outer-demotion.ts"
import { projectResults, type SelectedContextCell } from "../docs/data/selected-results.ts"

// #33665 recorded this placed pair when all five Kitty rows measured Unsupported.
const TMUX_RUN = "fb5ebbe99ab6bbf784f279a1d5d99301"
const KITTY_UNSUPPORTED_RUN = "ce4f24d228321812c6a4d4b36c76690b"
const KITTY_TODO_RUN = "987caecbe543d98b0f7ac47b822d9641"
const FIVE = [
  "input.modify-other-keys",
  "input.modify-other-keys-3",
  "input.pixel-mouse",
  "input.x10-mouse",
  "modes.application-keypad",
]

// 34760: keep only the runs this file asserts on. Retaining the whole parsed corpus peaked at 3.7 GiB in one
// worker, above the 3 GiB worker RSS cap, so the watchdog SIGKILLed the file; the projecting form drops every
// other run as soon as it is parsed.
const catalog = Object.keys(loadFeatures(CONTENT_DIR))
const fixtureIds = new Set([TMUX_RUN, KITTY_UNSUPPORTED_RUN, KITTY_TODO_RUN])
const placed = loadStoredRuns(CONTENT_DIR, catalog, (run) => (fixtureIds.has(run.runId) ? run : null))

function placedRun(runId: string): LoadedRun {
  const run = placed.find((candidate) => candidate?.runId === runId)
  if (!run) throw new Error(`placed run ${runId} is absent from ${CONTENT_DIR}`)
  return run
}

/** One context's cells as composition leaves them before the demotion: each result graded as measured. */
function cellsOf(run: LoadedRun): Record<string, SelectedContextCell> {
  return Object.fromEntries(
    (run.results ?? []).map((result) => [
      result.featureId,
      {
        origin: { runId: run.runId, resultId: result.featureId },
        run,
        result,
        featureResult: {
          featureId: result.featureId,
          status: result.status,
          strength: 3,
          probeId: result.featureId,
          conflictingProbes: [],
        },
      } as unknown as SelectedContextCell,
    ]),
  )
}

test("the placed tmux run's five input rows read Untestable beside outer Kitty, measured status and outer run kept", () => {
  const tmux = placedRun(TMUX_RUN)
  const outer = placedRun(KITTY_UNSUPPORTED_RUN)
  expect(tmux.subject.outerTerminal).toBe("kitty")
  expect(tmux.outerApp?.subject.version).toBe("0.49.2")
  const cells = cellsOf(tmux)
  const before = Object.fromEntries(Object.entries(cells).map(([id, cell]) => [id, cell.featureResult?.status]))
  expect(applyOuterAbsent("mux:tmux", cells, [outer])).toEqual([])
  const demoted = Object.keys(cells).filter((id) => cells[id]?.outerAbsent !== undefined)
  expect(demoted.sort()).toEqual(FIVE)
  for (const id of FIVE) {
    expect(cells[id]).toMatchObject({
      featureResult: { status: "untestable", strength: null },
      result: { status: "unsupported" },
      origin: { runId: TMUX_RUN },
      outerAbsent: { terminalId: "kitty", version: "0.49.2", runId: outer.runId, measured: "unsupported" },
    })
    expect(cells[id]!.outerAbsent!.reason).toBe(
      `Untestable (no setup): ${tmux.results!.find((r) => r.featureId === id)!.reason ? `${tmux.results!.find((r) => r.featureId === id)!.reason}; ` : ""}outer kitty 0.49.2 reads Unsupported on this row in run ${outer.runId}`,
    )
  }
  // Every other cell keeps the status it was composed with, including Unsupported rows outside the five.
  for (const [id, cell] of Object.entries(cells)) {
    if (!FIVE.includes(id)) expect(cell.featureResult?.status).toBe(before[id])
  }
})

test("no placed outer Kitty, or none at the recorded version: no demotion, and the refusal names why", () => {
  const tmux = placedRun(TMUX_RUN)
  const outer = placedRun(KITTY_UNSUPPORTED_RUN)
  const none = cellsOf(tmux)
  const [missing] = applyOuterAbsent("mux:tmux", none, [])
  expect(missing).toMatch(/no complete bare run of outer terminal kitty in placed kitty\/linux runs \(0\)/)
  expect(Object.values(none).some((cell) => cell.outerAbsent !== undefined)).toBe(false)
  const otherVersion: LoadedRun = { ...outer, subject: { ...outer.subject, version: "0.48.0" } }
  const stale = cellsOf(tmux)
  const [mismatch] = applyOuterAbsent("mux:tmux", stale, [otherVersion])
  expect(mismatch).toMatch(/is 0\.48\.0, the mux run recorded 0\.49\.2/)
  expect(Object.values(stale).some((cell) => cell.outerAbsent !== undefined)).toBe(false)
})

test.each([
  { newest: "Unsupported", kitty: [KITTY_UNSUPPORTED_RUN], grade: "untestable", measured: "unsupported" },
  { newest: "Probe TODO", kitty: [KITTY_UNSUPPORTED_RUN, KITTY_TODO_RUN], grade: "unsupported", measured: undefined },
])(
  "composition uses the newest placed outer reading when it is $newest",
  ({ kitty, grade, measured }) => {
    const runs = [placedRun(TMUX_RUN), ...kitty.map(placedRun)]
    const projection = projectResults(runs, catalog, { currentProbeHash: probeHash() }, [])
    const context = Object.values(projection.contexts).find((summary) => summary.subject?.id === "tmux")
    if (!context) throw new Error(`no tmux context composed from run ${TMUX_RUN}`)
    expect(
      FIVE.map((id) => [id, context.cells[id]?.featureResult?.status, context.cells[id]?.outerAbsent?.measured]),
    ).toEqual(FIVE.map((id) => [id, grade, measured]))
    expect(context.outerAbsentRefusals).toBeUndefined()
  },
  30_000,
)
