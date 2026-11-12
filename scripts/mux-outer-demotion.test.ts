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

// The placed tmux run #33304 closed on (measured 2026-11-11T12:47:51Z) and the placed Kitty 0.49.2 runs beside it.
const TMUX_RUN = "fb5ebbe99ab6bbf784f279a1d5d99301"
const FIVE = [
  "input.modify-other-keys",
  "input.modify-other-keys-3",
  "input.pixel-mouse",
  "input.x10-mouse",
  "modes.application-keypad",
]

const placed = loadStoredRuns(CONTENT_DIR, Object.keys(loadFeatures(CONTENT_DIR)))
const tmux = placed.find((run) => run.runId === TMUX_RUN)
const kitty = placed.filter(
  (run) => run.subject.kind === "term" && run.subject.id === "kitty" && run.subject.os === "linux",
)

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
  if (!tmux) throw new Error(`placed tmux run ${TMUX_RUN} is absent from ${CONTENT_DIR}`)
  expect(tmux.subject.outerTerminal).toBe("kitty")
  expect(tmux.outerApp?.subject.version).toBe("0.49.2")
  const cells = cellsOf(tmux)
  const before = Object.fromEntries(Object.entries(cells).map(([id, cell]) => [id, cell.featureResult?.status]))
  expect(applyOuterAbsent("mux:tmux", cells, placed)).toEqual([])
  const demoted = Object.keys(cells).filter((id) => cells[id]?.outerAbsent !== undefined)
  expect(demoted.sort()).toEqual(FIVE)
  // The outer run is the newest placed Kitty at the version the tmux run recorded.
  const outer = kitty
    .filter((run) => run.subject.version === "0.49.2")
    .sort((a, b) => b.measuredAt.localeCompare(a.measuredAt))[0]!
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
  if (!tmux) throw new Error(`placed tmux run ${TMUX_RUN} is absent from ${CONTENT_DIR}`)
  const none = cellsOf(tmux)
  const [missing] = applyOuterAbsent("mux:tmux", none, [])
  expect(missing).toMatch(/no complete bare run of outer terminal kitty in placed kitty\/linux runs \(0\)/)
  expect(Object.values(none).some((cell) => cell.outerAbsent !== undefined)).toBe(false)
  const otherVersion = kitty.map((run) => ({ ...run, subject: { ...run.subject, version: "0.48.0" } }) as LoadedRun)
  const stale = cellsOf(tmux)
  const [mismatch] = applyOuterAbsent("mux:tmux", stale, otherVersion)
  expect(mismatch).toMatch(/is 0\.48\.0, the mux run recorded 0\.49\.2/)
  expect(Object.values(stale).some((cell) => cell.outerAbsent !== undefined)).toBe(false)
})

test("composition (projectResults, the site's one read) grades the five tmux cells Untestable with the marker", () => {
  if (!tmux) throw new Error(`placed tmux run ${TMUX_RUN} is absent from ${CONTENT_DIR}`)
  // The composition every site reader takes, over the placed tmux run and the placed Kitty runs only: a revert of the
  // composeContextSummaries call is red here while the direct applyOuterAbsent rows above stay green.
  const catalog = Object.keys(loadFeatures(CONTENT_DIR))
  const projection = projectResults([tmux, ...kitty], catalog, { currentProbeHash: probeHash() }, [])
  const context = Object.values(projection.contexts).find((summary) => summary.subject?.id === "tmux")
  if (!context) throw new Error(`no tmux context composed from run ${TMUX_RUN}`)
  expect(
    FIVE.map((id) => [id, context.cells[id]?.featureResult?.status, context.cells[id]?.outerAbsent?.measured]),
  ).toEqual(FIVE.map((id) => [id, "untestable", "unsupported"]))
  expect(context.outerAbsentRefusals).toBeUndefined()
}, 30_000)
