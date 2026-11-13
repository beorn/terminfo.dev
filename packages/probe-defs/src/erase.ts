import type {
  ObservationFrame,
  ObservationReason,
  ProbeDefinition,
  ProbeCallbackResult,
  TerminalScrollbackReading,
  TermProbeSource,
} from "./types.ts"
import { regionReadbackProbe, type RegionReadbackRow } from "./region-readback-kind.ts"
import { beginCaptureLifecycle, endCaptureLifecycle } from "./region-readback.ts"
import {
  probe,
  parserStateResult,
  notTestedResult,
  declaredUntestableResult,
  libvtermHistoryReview,
  sameFrame,
} from "./helpers.ts"

/**
 * The nine measured Erase rows, as one region-readback kind table (28450; @cto 218ec7fe's rule
 * applied to Erase). Each row holds its claim ONCE: the lib arm reads its seed, its steps and its
 * target cells against the parser, and the kind derives the capture-region oracle's frames from the
 * same fields, so the two arms cannot grade two fixtures.
 *
 * One row stays HAND-WRITTEN, with its one-line coverage record:
 *  - erase.screen.scrollback: the claim is HISTORY (ED3 removes measured scrollback while screen
 *    geometry stays), not a cell window.
 *
 * erase.el-with-attrs moved onto the table with the attribute-carrying cell (@cto 2026-10-18, the
 * 218ec7fe conversion trigger): its background claim is now declared by the cells themselves, so an
 * ignoring terminal reads unsupported on BOTH arms instead of being graded by one and guessed by the
 * other.
 */
/**
 * A control is a cell OUTSIDE the claim whose change means the FIXTURE failed; a cell whose
 * preservation IS the claim is a claim cell and stays in `after`. Every erase row's preserved cells
 * are part of its claim — the un-erased side of EL or ED, the neighbour row of EL 2, the cells past
 * ECH's span — so none of these rows declares a control, and an over-erase reads unsupported instead
 * of inconclusive (@cto 28450 must-fix 2, 2026-10-12). The setup's own witness is each step's CUP
 * cursor report.
 */
export const eraseReadbackRows: readonly RegionReadbackRow[] = [
  {
    id: "erase.character",
    textClaim: "characters",
    expected: "ECH erases the requested cells from the cursor, leaving the preceding column intact",
    seed: "\x1b[1;1HABCDE",
    before: [["A", "B", "C", "D", "E"]],
    steps: [
      {
        write: "\x1b[1;2H\x1b[2X",
        cursor: { x: 1, y: 0, note: "ECH erases at the cursor; a CUP the terminal ignored erases the wrong cells" },
      },
    ],
    after: [["A", " ", " ", "D", "E"]],
    controls: [],
    seedNote: "ECH seed was not measured",
    controlNote: "ECH names no control: its preserved cells are the claim",
    reset: "",
  },
  {
    id: "erase.line.right",
    textClaim: "characters",
    expected: "EL0 erases from the cursor to the end of the row and preserves the adjacent row",
    seed: "\x1b[1;1HABCDE\x1b[2;1HKEEP!",
    before: [
      ["A", "B", "C", "D", "E"],
      ["K", "E", "E", "P", "!"],
    ],
    steps: [
      {
        write: "\x1b[1;3H\x1b[K",
        cursor: { x: 2, y: 0, note: "EL0 erases from the cursor; a CUP the terminal ignored erases the wrong span" },
      },
    ],
    after: [
      ["A", "B", " ", " ", " "],
      ["K", "E", "E", "P", "!"],
    ],
    controls: [],
    seedNote: "EL0 seed was not measured",
    controlNote: "EL0 names no control: its preserved cells are the claim",
    reset: "",
  },
  {
    id: "erase.line.left",
    textClaim: "characters",
    expected: "EL1 erases from the row start through the cursor",
    seed: "\x1b[1;1HABCDE\x1b[2;1HKEEP!",
    before: [
      ["A", "B", "C", "D", "E"],
      ["K", "E", "E", "P", "!"],
    ],
    steps: [
      {
        write: "\x1b[1;3H\x1b[1K",
        cursor: { x: 2, y: 0, note: "EL1 erases through the cursor; a CUP the terminal ignored erases the wrong span" },
      },
    ],
    after: [
      [" ", " ", " ", "D", "E"],
      ["K", "E", "E", "P", "!"],
    ],
    controls: [],
    seedNote: "EL1 seed was not measured",
    controlNote: "EL1 names no control: its preserved cells are the claim",
    reset: "",
  },
  {
    id: "erase.line.all",
    textClaim: "characters",
    expected: "EL2 erases the whole row and preserves the adjacent row",
    seed: "\x1b[1;1HABCDE\x1b[2;1HKEEP!",
    before: [
      ["A", "B", "C", "D", "E"],
      ["K", "E", "E", "P", "!"],
    ],
    steps: [
      {
        write: "\x1b[1;3H\x1b[2K",
        cursor: { x: 2, y: 0, note: "EL2 erases the whole row at the cursor; an ignored CUP would still erase it" },
      },
    ],
    after: [
      [" ", " ", " ", " ", " "],
      ["K", "E", "E", "P", "!"],
    ],
    controls: [],
    seedNote: "EL2 seed was not measured",
    controlNote: "EL2 names no control: its neighbour row is the claim",
    reset: "",
  },
  {
    id: "erase.screen.below",
    textClaim: "characters",
    expected: "ED0 erases from the cursor to the end of the screen and preserves the row above",
    seed: "\x1b[1;1HAAAAA\x1b[2;1HBBBBB\x1b[3;1HCCCCC",
    before: [
      ["A", "A", "A", "A", "A"],
      ["B", "B", "B", "B", "B"],
      ["C", "C", "C", "C", "C"],
    ],
    steps: [
      {
        write: "\x1b[2;3H\x1b[J",
        cursor: { x: 2, y: 1, note: "ED0 erases below the cursor; a CUP the terminal ignored erases the wrong side" },
      },
    ],
    after: [
      ["A", "A", "A", "A", "A"],
      ["B", "B", " ", " ", " "],
      [" ", " ", " ", " ", " "],
    ],
    controls: [],
    seedNote: "ED0 seed was not measured",
    controlNote: "ED0 names no control: its preserved row is the claim",
    reset: "",
  },
  {
    id: "erase.screen.above",
    textClaim: "characters",
    expected: "ED1 erases from the screen start through the cursor and preserves the row below",
    seed: "\x1b[1;1HAAAAA\x1b[2;1HBBBBB\x1b[3;1HCCCCC",
    before: [
      ["A", "A", "A", "A", "A"],
      ["B", "B", "B", "B", "B"],
      ["C", "C", "C", "C", "C"],
    ],
    steps: [
      {
        write: "\x1b[2;3H\x1b[1J",
        cursor: { x: 2, y: 1, note: "ED1 erases above the cursor; a CUP the terminal ignored erases the wrong side" },
      },
    ],
    after: [
      [" ", " ", " ", " ", " "],
      [" ", " ", " ", "B", "B"],
      ["C", "C", "C", "C", "C"],
    ],
    controls: [],
    seedNote: "ED1 seed was not measured",
    controlNote: "ED1 names no control: its preserved row is the claim",
    reset: "",
    // #32581 (@cto 52b0229c, a290eaa2): Alacritty 0.17.0 skips the line above a cursor on row 2, which
    // the whole-region digest can only call a third frame. The cursor stays on row 2: moving it would
    // hide that fault.
    cursorRowGroups: {
      rowsAbove: 1,
      unsupportedNote:
        "ED1 left the row above the cursor unchanged, with the cursor on row 2; the rows at and below the cursor match the expected frame. A lower cursor is not run.",
    },
  },
  {
    id: "erase.screen.all",
    textClaim: "characters",
    expected: "ED2 erases the whole screen",
    seed: "\x1b[1;1HAAAAA\x1b[2;1HBBBBB\x1b[3;1HCCCCC",
    before: [
      ["A", "A", "A", "A", "A"],
      ["B", "B", "B", "B", "B"],
      ["C", "C", "C", "C", "C"],
    ],
    steps: [
      {
        write: "\x1b[2;3H\x1b[2J",
        cursor: { x: 2, y: 1, note: "ED2 erases the screen at the cursor; the cursor must not move" },
      },
    ],
    after: [
      [" ", " ", " ", " ", " "],
      [" ", " ", " ", " ", " "],
      [" ", " ", " ", " ", " "],
    ],
    controls: [],
    seedNote: "ED2 seed was not measured",
    controlNote: "ED2 names no control: nothing is preserved",
    reset: "",
  },
  {
    id: "erase.selective",
    textClaim: "characters",
    expected: "Selective erase clears unprotected cells and keeps the DECSCA-protected cell",
    seed: '\x1b[1;1H\x1b[1"qP\x1b[0"qABCDE',
    before: [["P", "A", "B", "C", "D", "E"]],
    steps: [
      {
        write: "\x1b[1;1H\x1b[?2J",
        cursor: {
          x: 0,
          y: 0,
          note: "Selective erase runs from the cursor; a CUP the terminal ignored clears the wrong cells",
        },
      },
    ],
    after: [["P", " ", " ", " ", " ", " "]],
    // NO control, deliberately: the discriminator is the DECSCA-protected P. A terminal that takes it
    // also clears every other cell, so a flank control would move and the row would read inconclusive
    // where it must read unsupported (@chief 2026-10-11T22:58Z).
    controls: [],
    // A selective erase that drops the protection erases the protected P too - a measured negative.
    ignored: [[" ", " ", " ", " ", " ", " "]],
    seedNote: "Selective-erase seed was not measured",
    controlNote: "Selective erase has no preserved cell besides the protected one",
    reset: "",
  },
  {
    id: "erase.ed-scroll-region",
    textClaim: "characters",
    expected: "ED0 erases below the cursor inside a scroll region and preserves the preceding row",
    seed: "\x1b[1;1HKEEP!\x1b[3;1HERASE",
    before: [
      ["K", "E", "E", "P", "!"],
      [" ", " ", " ", " ", " "],
      ["E", "R", "A", "S", "E"],
    ],
    steps: [
      {
        write: "\x1b[3;10r\x1b[3;1H\x1b[J",
        cursor: {
          x: 0,
          y: 2,
          note: "Scroll-region ED0 runs from the cursor; a CUP the terminal ignored erases the wrong row",
        },
      },
    ],
    after: [
      ["K", "E", "E", "P", "!"],
      [" ", " ", " ", " ", " "],
      [" ", " ", " ", " ", " "],
    ],
    controls: [],
    seedNote: "Scroll-region ED0 seed was not measured",
    controlNote: "Scroll-region ED0 names no control: its preserved row is the claim",
    reset: "\x1b[r",
    cleanup: "\x1b[r",
    // The sequence sets a scroll region whose bottom is row 10, so the fixture needs ten rows even
    // though it compares three.
    minRows: 10,
  },
  {
    id: "erase.el-with-attrs",
    expected: "EL carries the current background onto the erased cells",
    region: { top: 1, left: 1 },
    // A named SGR 42 resolves through each terminal's own palette, so the claim is relative: the
    // seed cells must report SOME background, and the erased cells must keep it.
    seed: "\x1b[1;1H\x1b[42mXXXXX\x1b[0m\x1b[2;1H",
    before: [
      [
        { char: "X", attributes: { bg: "present" } },
        { char: "X", attributes: { bg: "present" } },
        { char: "X", attributes: { bg: "present" } },
        { char: "X", attributes: { bg: "present" } },
        { char: "X", attributes: { bg: "present" } },
      ],
    ],
    // The step ends ON the CUP that positions the erase, so the cursor it declares is the witness
    // that the erase target was measured at all: an ignored CUP leaves the parked row and reads
    // inconclusive before any cell is graded. The kind appends the park itself.
    steps: [
      {
        write: "\x1b[1;1H\x1b[42m\x1b[0K\x1b[0m",
        cursor: {
          x: 0,
          y: 0,
          note: "EL background: the CUP to the seeded row was ignored, so the erase target was not measured",
        },
      },
    ],
    after: [
      [
        { char: " ", attributes: { bg: "same-as-before" } },
        { char: " ", attributes: { bg: "same-as-before" } },
        { char: " ", attributes: { bg: "same-as-before" } },
        { char: " ", attributes: { bg: "same-as-before" } },
        { char: " ", attributes: { bg: "same-as-before" } },
      ],
    ],
    paint: { bg: "\x1b[42m" },
    // The default-background fixture the painted seed must DIFFER from: a backend that reports one
    // concrete default RGB and ignores SGR 42 would otherwise satisfy present + same-as-before and
    // grade an ordinary EL supported on a colour that was never painted (review2 97414a37 P2 1).
    baseline: {
      seed: "\x1b[1;1HXXXXX",
      cells: [["X", "X", "X", "X", "X"]],
    },
    baselineNote: "EL background: the default-background seed was not measured",
    // An EL that drops back to the default background is a measured negative: the claim IS the
    // carried background, so that frame is exactly what "ignored" names.
    ignored: [[" ", " ", " ", " ", " "]],
    controls: [],
    seedNote: "EL background seed was not measured",
    controlNote: "EL names no control: the erased cells are the claim",
    reset: "\x1b[0m",
  },
]

const SCROLLBACK_ED3_EXPECTED =
  "ED3 removes captured history: wheel-up after ED3 no longer shows the pre-ED3 history frame"

/** Why two frames disagree, in the terms the next run needs to tell the causes apart. Both frames
 * carrying equal digests would have read as the same frame, so only two causes reach here. */
function frameDivergence(settled: ObservationFrame, bottom: ObservationFrame): string {
  if (
    (settled.regionDigest !== undefined && bottom.regionDigest !== undefined) ||
    (settled.pixelsDigest !== undefined && bottom.pixelsDigest !== undefined)
  ) {
    return "the captured pixels differ"
  }
  return "the frame refs differ and no pixel digest was carried"
}

/** Each multiplexer's one history reader: the owned terminal's getScrollback runs it on the probe's own session (linux-clipboard.ts). */
const MUX_HISTORY_QUERY: Record<"tmux" | "screen", string> = {
  tmux: 'tmux display-message -p "#{history_size} #{pane_height} #{scroll_position} #{pane_in_mode}"',
  screen: "screen -X hardcopy -h",
}
type MuxHistory = number | { reason: ObservationReason; note: string }

/**
 * A multiplexer's history line count through its owned reader, or why it could not be read, named loudly
 * (never a silent notTested). Because `tmux display-message` and `screen -X hardcopy -h` inspect the
 * multiplexer over its socket out-of-band from the pane's inner PTY, fence each read with a DSR 6
 * cursor-position round-trip so the multiplexer has consumed the preceding PTY write (`seed` or `ED3`).
 */
async function muxHistoryLines(
  ctx: TermProbeSource,
  mux: "tmux" | "screen",
  stage: "seed" | "ED3",
): Promise<MuxHistory> {
  const query = MUX_HISTORY_QUERY[mux]
  if (!ctx.getScrollback) return { reason: "collector-error", note: `this run has no reader for ${query}` }
  if (!(await ctx.queryCursorPosition())) {
    return { reason: "no-response", note: `no cursor-position reply to fence ${stage} before ${query}` }
  }
  let reading: TerminalScrollbackReading
  try {
    reading = await ctx.getScrollback()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { reason: "collector-error", note: `${query} failed: ${message}` }
  }
  const lines = reading.screenLines === undefined ? Number.NaN : reading.totalLines - reading.screenLines
  if (!Number.isSafeInteger(lines) || lines < 0) {
    return { reason: "invalid-reply", note: `${query} gave no history count: ${JSON.stringify(reading)}` }
  }
  return lines
}

/**
 * A multiplexer decides ED3 from its own history count before and after (#32774, #32784, @cto e078c568, addfd7b2):
 * tmux's first wheel-up only enters copy mode and Screen does not scroll its buffer on X11 wheel events, so the
 * captured frames stay in the result as corroboration while the pane's history count decides.
 */
function muxScrollbackResult(
  mux: "tmux" | "screen",
  before: MuxHistory,
  after: MuxHistory,
  observed: object,
  frames: ObservationFrame[],
): ProbeCallbackResult {
  const query = MUX_HISTORY_QUERY[mux]
  const countLabel = mux === "tmux" ? "history_size" : "history"
  const state = {
    ...observed,
    frames: frames.map(({ ref, label }) => ({ ref, label })),
    muxHistory: { mux, before, after },
  }
  const invalid = (reason: ObservationReason, note: string): ProbeCallbackResult => ({
    pass: false,
    response: JSON.stringify(state),
    note,
    observation: { outcome: "inconclusive", reason, assertionType: "buffer_state", note },
  })
  if (typeof before !== "number") return invalid(before.reason, before.note)
  if (before === 0) {
    return invalid(
      "insufficient-evidence",
      `the seeding never reached ${mux} history: ${query} read ${countLabel} 0 before ED3`,
    )
  }
  if (typeof after !== "number") return invalid(after.reason, after.note)
  const erased = after === 0
  const note = `${mux} ${countLabel} ${before} -> ${after} for the probe's own pane${erased ? "" : ": ED3 left the history in place"}`
  return parserStateResult(erased, `ED3 removes ${mux} history: ${countLabel} drops from above 0 to 0`, state, note)
}

/**
 * App ED3 cannot read history as cells. Compose existing XTEST wheel + capture:
 * prove history is observable, then grade whether ED3 removes it.
 * Never enable mouse tracking — that would steal the wheel into stdin.
 * Multiplexers decide from their own history count instead (muxScrollbackResult); their frames only corroborate.
 */
async function scrollbackEraseApp(ctx: TermProbeSource): Promise<ProbeCallbackResult> {
  if (ctx.scrollbackUnavailable) return declaredUntestableResult(ctx.scrollbackUnavailable, {})
  if (ctx.scrollbackProbeTodo) return notTestedResult(ctx.scrollbackProbeTodo, {})
  if (!Number.isSafeInteger(ctx.rows) || !Number.isSafeInteger(ctx.cols) || ctx.rows < 5 || ctx.cols < 5) {
    return {
      pass: false,
      tests: [
        {
          id: "criterion",
          status: "probe-todo",
          reason: `Erase fixture needs at least 5x5, measured ${ctx.rows}x${ctx.cols}`,
        },
      ],
    }
  }
  const capture = ctx.capture
  const input = ctx.input
  const readInput = ctx.readInput
  if (!capture || !input || !readInput) {
    return notTestedResult("OS-level scrollback dump or XTEST wheel+capture", {
      capture: Boolean(capture),
      input: Boolean(input),
      readInput: Boolean(readInput),
    })
  }

  const control = (await readInput(/^a/, 1000, () => input.injectKey("a")))?.[0]
  if (!control) throw new Error("XTEST delivery control failed: plain a did not reach the app")

  try {
    // The visible cursor is a cell like any other: without DECTCEM off the wheel-down restore
    // differs from the seeded bottom frame by one cell and the arm grades its own cursor.
    beginCaptureLifecycle(ctx)
    const mux = ctx.mux
    const mark = Math.min(ctx.cols, 40)
    ctx.write("\x1b[2J\x1b[H")
    ctx.write(`${"H".repeat(mark)}\r\n`.repeat(ctx.rows + 2))
    ctx.write("B".repeat(mark))
    const bottom = await capture({ role: "control", label: "Bottom of seeded buffer" })
    const historyBefore = mux ? await muxHistoryLines(ctx, mux, "seed") : undefined
    await input.injectClick(4)
    const history = await capture({ role: "control", label: "After wheel-up before ED3" })
    if (!mux && sameFrame(history, bottom)) {
      return notTestedResult("wheel-up did not change captured pixels; cannot observe history", {
        control,
        bottom,
        history,
      })
    }
    await input.injectClick(5)
    const restored = await capture({ role: "control", label: "After wheel-down before ED3" })
    if (!mux && !sameFrame(restored, bottom)) {
      return {
        pass: false,
        response: JSON.stringify({
          control,
          bottom: bottom.ref,
          history: history.ref,
          restored: restored.ref,
        }),
        observation: {
          outcome: "inconclusive",
          reason: "insufficient-evidence",
          assertionType: "screenshot",
          screenshotRef: restored.ref,
          note: `wheel-down did not return to the bottom frame: ${frameDivergence(restored, bottom)}`,
        },
      }
    }
    ctx.write("\x1b[3J")
    const erased = await capture({ role: "control", label: "After ED3 at bottom" })
    const historyAfter = mux ? await muxHistoryLines(ctx, mux, "ED3") : undefined
    await input.injectClick(4)
    const after = await capture({ role: "target", label: "After ED3 then wheel-up" })
    const observed = {
      control,
      bottom: bottom.ref,
      history: history.ref,
      restored: restored.ref,
      erased: erased.ref,
      after: after.ref,
    }
    const frames = [bottom, history, restored, erased, after]
    if (mux && historyBefore !== undefined && historyAfter !== undefined) {
      return muxScrollbackResult(mux, historyBefore, historyAfter, observed, frames)
    }
    if (sameFrame(after, history)) {
      return {
        pass: false,
        response: JSON.stringify(observed),
        observation: {
          outcome: "unsupported",
          assertionType: "screenshot",
          screenshotRef: after.ref,
          frames,
        },
        assertions: [
          {
            assertionType: "screenshot" as const,
            kind: "negative",
            expected: SCROLLBACK_ED3_EXPECTED,
            observed: JSON.stringify(observed),
            action: "erase.screen.scrollback:ed3",
          },
        ],
      }
    }
    if (sameFrame(after, erased)) {
      return {
        pass: true,
        response: JSON.stringify(observed),
        observation: {
          outcome: "supported",
          assertionType: "screenshot",
          screenshotRef: after.ref,
          frames,
        },
        assertions: [
          {
            assertionType: "screenshot" as const,
            kind: "positive",
            expected: SCROLLBACK_ED3_EXPECTED,
            observed: JSON.stringify(observed),
            action: "erase.screen.scrollback:ed3",
          },
        ],
      }
    }
    return {
      pass: false,
      response: JSON.stringify(observed),
      observation: {
        outcome: "inconclusive",
        reason: "insufficient-evidence",
        assertionType: "screenshot",
        screenshotRef: after.ref,
        frames,
        note: "Post-ED3 wheel-up matched neither the history frame nor the post-ED3 bottom",
      },
    }
  } finally {
    await input.injectClick(5)
    endCaptureLifecycle(ctx)
  }
}

type HistoryState = ReturnType<import("./types.ts").LibProbeSource["getScrollback"]>

// These are the original ED3 predicates, shared by legacy and retained native checks.
export const eraseHistoryPredicates = {
  screenRows(rows: number) {
    return Number.isSafeInteger(rows) && rows >= 1 && rows <= 1000
  },
  history(before: HistoryState, rows: number) {
    return Number.isSafeInteger(before.totalLines) && before.totalLines > rows && before.screenLines === rows
  },
  geometry(after: HistoryState, rows: number) {
    return Number.isSafeInteger(after.totalLines) && after.totalLines >= rows && after.screenLines === rows
  },
  erased(after: HistoryState, rows: number) {
    return after.totalLines === rows
  },
}

export function createEraseProbes(
  checks?: NonNullable<Parameters<typeof regionReadbackProbe>[1]> & {
    history: typeof eraseHistoryPredicates
  },
): ProbeDefinition[] {
  const history = checks?.history ?? eraseHistoryPredicates
  return [
    ...eraseReadbackRows.map((row) => regionReadbackProbe(row, checks)),

    {
      ...probe(
        "erase.screen.scrollback",
        (ctx) => {
          const review = libvtermHistoryReview(ctx)
          if (review) return review
          const expected = "ED3 removes measured scrollback while keeping screen geometry"
          const initial = ctx.getScrollback()
          const rows = initial.screenLines
          if (!history.screenRows(rows)) {
            return parserStateResult(null, expected, { initial }, "Need a measured screen size for history setup")
          }
          ctx.feed("\r\n".repeat(rows + 2))
          const before = ctx.getScrollback()
          if (!history.history(before, rows)) {
            return parserStateResult(null, expected, { initial, before }, "No measured scrollback to erase")
          }
          ctx.feed("\x1b[3J")
          const after = ctx.getScrollback()
          const measured = history.geometry(after, rows)
          return parserStateResult(
            measured ? history.erased(after, rows) : null,
            expected,
            { before, after },
            measured ? undefined : "Scrollback readback or geometry changed unexpectedly",
          )
        },
        scrollbackEraseApp,
      ),
      termNeedsGeometry: true,
    },
  ]
}

export const eraseProbes = createEraseProbes()
