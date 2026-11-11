/**
 * @failure A Kitty frame-two-only animation negative publishes as Unsupported when no subject under the same suite
 *   read the same bytes Supported, so a probe whose own frames never animate anywhere grades every terminal Unsupported.
 * @level l1
 * @consumer composeContextSummaries and publicResults, through applyHeld and publicHeldReason (33034).
 * @testonly none
 */
import { expect, test } from "vitest"
import type { LoadedRun } from "@terminfo/run-parser"
import { KITTY_FRAME_TWO_ONLY_BRANCH } from "../packages/probe-defs/src/kitty-capture.ts"
import { applyHeld, HELD_NEGATIVES, publicHeldReason, supportedSuites } from "../docs/data/held-negatives.ts"
import type { SelectedContextCell } from "../docs/data/selected-results.ts"

const ANIMATION = "extensions.kitty-graphics.animation"

function loaded(
  runId: string,
  suiteId: string,
  status: string,
  options: { criterionBranch?: string; assertionType?: string; assertionKind?: "positive" | "negative" | null } = {},
): LoadedRun {
  // A Supported reading defaults to the painted shape the probe records: screenshot type, positive assertion.
  const assertionType = options.assertionType ?? "screenshot"
  const kind =
    options.assertionKind === undefined ? (status === "supported" ? "positive" : "negative") : options.assertionKind
  return {
    runId,
    suiteId,
    results: [
      {
        featureId: ANIMATION,
        status,
        assertionType,
        ...(options.criterionBranch && { criterionBranch: options.criterionBranch }),
      },
    ],
    assertions: kind === null ? [] : [{ featureId: ANIMATION, kind, assertionType }],
  } as unknown as LoadedRun
}

function cell(run: LoadedRun, status = "unsupported"): SelectedContextCell {
  const result = run.results![0]!
  return {
    origin: { runId: run.runId, resultId: ANIMATION },
    run,
    result,
    featureResult: { featureId: ANIMATION, status, strength: 3, probeId: ANIMATION, conflictingProbes: [] },
  } as unknown as SelectedContextCell
}

test("the gate keys on the branch the animation probe records", () => {
  expect(HELD_NEGATIVES.map((row) => [row.featureId, row.criterionBranch])).toEqual([
    [ANIMATION, KITTY_FRAME_TWO_ONLY_BRANCH],
  ])
})

test("a frame-two-only negative publishes only beside a Supported reading in its own suite", () => {
  const wezterm = loaded("wez", "suite-b", "unsupported", { criterionBranch: KITTY_FRAME_TWO_ONLY_BRANCH })
  // Supported only under another suite: those were other bytes, so the negative is held.
  const unwitnessed = { [ANIMATION]: cell(wezterm) }
  const heldIds = applyHeld(
    unwitnessed,
    HELD_NEGATIVES,
    supportedSuites([wezterm, loaded("kitty", "suite-a", "supported")], HELD_NEGATIVES),
  )
  expect(heldIds).toEqual([ANIMATION])
  expect(unwitnessed[ANIMATION]).toMatchObject({
    featureResult: { status: "probe-invalid", strength: null },
    result: { status: "unsupported" },
    held: { criterionBranch: KITTY_FRAME_TWO_ONLY_BRANCH, suiteId: "suite-b" },
  })
  expect(publicHeldReason(unwitnessed[ANIMATION]!.held!)).toBe(
    "Unsupported not published: no subject measured under suite suite-b reads Supported with the same bytes, and a terminal that plays these exact frames shows the probe's bytes can animate.",
  )
  // The same suite reads Supported on another subject: the negative publishes.
  const witnessed = { [ANIMATION]: cell(wezterm) }
  expect(
    applyHeld(
      witnessed,
      HELD_NEGATIVES,
      supportedSuites([wezterm, loaded("kitty", "suite-b", "supported")], HELD_NEGATIVES),
    ),
  ).toEqual([])
  expect(witnessed[ANIMATION]).toMatchObject({ featureResult: { status: "unsupported" } })
  expect(witnessed[ANIMATION]!.held).toBeUndefined()
})

test("other negatives and other readings pass through untouched", () => {
  const none = supportedSuites([], HELD_NEGATIVES)
  // A refusal-decided negative carries no frame-two-only branch.
  const refused = { [ANIMATION]: cell(loaded("kitty-old", "suite-b", "unsupported")) }
  // A probe-invalid reading with the branch is not a negative.
  const invalid = {
    [ANIMATION]: cell(
      loaded("wez", "suite-b", "probe-invalid", { criterionBranch: KITTY_FRAME_TWO_ONLY_BRANCH }),
      "probe-invalid",
    ),
  }
  for (const cells of [refused, invalid]) {
    const before = cells[ANIMATION]
    expect(applyHeld(cells, HELD_NEGATIVES, none)).toEqual([])
    expect(cells[ANIMATION]).toBe(before)
  }
})

// @cto 413dbac4: only a Supported reading that painted the frames witnesses the bytes.
test("a witness is a Supported reading decided by a positive screenshot on the probe", () => {
  const wezterm = loaded("wez", "suite-b", "unsupported", { criterionBranch: KITTY_FRAME_TWO_ONLY_BRANCH })
  for (const [label, witness, counts] of [
    ["painted", loaded("kitty", "suite-b", "supported"), true],
    ["query reply", loaded("kitty", "suite-b", "supported", { assertionType: "query_reply" }), false],
    ["no positive assertion", loaded("kitty", "suite-b", "supported", { assertionKind: null }), false],
    ["negative assertion", loaded("kitty", "suite-b", "supported", { assertionKind: "negative" }), false],
  ] as const) {
    const cells = { [ANIMATION]: cell(wezterm) }
    const held = applyHeld(cells, HELD_NEGATIVES, supportedSuites([wezterm, witness], HELD_NEGATIVES))
    expect([label, held]).toEqual([label, counts ? [] : [ANIMATION]])
  }
})
