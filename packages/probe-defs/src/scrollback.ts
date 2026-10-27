import type { ProbeDefinition, ProbeCallbackResult, TermProbeSource } from "./types.ts"
import { probe, parserStateResult } from "./helpers.ts"
import { regionReadbackProbes, type RegionReadbackRow } from "./region-readback-kind.ts"

/**
 * The measured readback for the scrollback rows the VIEWPORT can actually see, as one
 * region-readback kind table (@cto A2; 28450 slices B and C). Same three-frame shape as the editing
 * specs: seed, the sequence applied on top of it, and the frame it must leave. History-buffer cells
 * that leave the window lie in NO row's region; they stay named unavailable, never graded as a
 * terminal failure.
 *
 * Each row keeps the region WIDTH, the cursor row and the sentinel the hand-written spec measured,
 * and each declares its own mode reset, so nothing about the fixture is implied twice. `region` is a
 * top-left corner — its bottom and right derive from the grid, so a region can no longer disagree
 * with the cells it compares — and the MINIMUM GEOMETRY derives from the cursor row, the sentinel and
 * the region (the kind's `assertRegionReadbackShape`), because a hand-picked minimum was itself a
 * hiding place: reverse-index's explicit 7 was the only thing keeping a cursor-row-6 fixture inside a
 * need of 5.
 *
 * Two deliberate changes, both named in the diff that carries this table to @cto:
 *  - scroll-up's region is rows 1..5, not rows 2..4: its claim ("A and E stay") controls the rows
 *    just outside the scrolled band, and only a region that covers them lets BOTH arms check them.
 *  - the derived edit parks the cursor at the row's own cursorRow, which two of the hand-written
 *    edits declared but never reached.
 */
export const scrollbackReadbackRows: readonly RegionReadbackRow[] = [
  {
    id: "scrollback.scroll-up",
    textClaim: "characters",
    expected: "Interior-region SU shifts the measured middle and bottom rows up, clearing the region bottom",
    region: { top: 1, left: 1 },
    seed: "\x1b[1;1HA\x1b[2;1HB\x1b[3;1HC\x1b[4;1HD\x1b[5;1HE\x1b[2;4r",
    before: [["A"], ["B"], ["C"], ["D"], ["E"]],
    steps: [{ write: "\x1b[2;1H" }, { write: "\x1b[S" }, { write: "\x1b[r" }],
    after: [["A"], ["C"], ["D"], [""], ["E"]],
    controls: [
      { row: 0, col: 0, char: "A" },
      { row: 4, col: 0, char: "E" },
    ],
    cursorRow: 6,
    sentinel: { row: 7, col: 1 },
    reset: "\x1b[r",
    cleanup: "\x1b[r",
    seedNote: "Interior-region SU seed or history was not established",
    controlNote: "Interior-region SU controls or output were not measured",
  },
  {
    id: "scrollback.reverse-index",
    textClaim: "characters",
    expected: "A blank row is inserted above the measured A marker, pushing it down one row",
    region: { top: 1, left: 1 },
    seed: "\x1b[1;1HA\x1b[2;1HB\x1b[3;1HC",
    before: [["A"], ["B"], ["C"]],
    steps: [{ write: "\x1b[H" }, { write: "\x1bM" }],
    after: [[""], ["A"], ["B"]],
    controls: [],
    cursorRow: 6,
    sentinel: { row: 5, col: 1 },
    reset: "",
    seedNote: "Seed marker rows were not measured",
    controlNote: "Seed marker rows were lost or did not move together; cannot attribute a blank-row insertion",
  },
  {
    id: "scrollback.scroll-down",
    textClaim: "characters",
    expected: "A blank row is inserted above the measured LINE1 row, pushing the three measured lines down",
    region: { top: 1, left: 1 },
    seed: "\x1b[1;1HLINE1\x1b[2;1HLINE2\x1b[3;1HLINE3",
    before: [
      ["L", "I", "N", "E", "1"],
      ["L", "I", "N", "E", "2"],
      ["L", "I", "N", "E", "3"],
    ],
    steps: [{ write: "\x1b[H" }, { write: "\x1b[T" }],
    after: [
      ["", "", "", "", ""],
      ["L", "I", "N", "E", "1"],
      ["L", "I", "N", "E", "2"],
    ],
    controls: [],
    cursorRow: 5,
    sentinel: { row: 6, col: 1 },
    reset: "",
    seedNote: "Seed marker rows were not measured",
    controlNote: "Marker rows were lost or did not move together; cannot attribute a blank-row insertion",
  },
  {
    id: "scrollback.set-region",
    textClaim: "characters",
    expected: "DECSTBM sets the region: a marker on the requested top row scrolls out while the row above it stays",
    region: { top: 1, left: 1 },
    seed: "\x1b[1;1HFIXED\x1b[5;1HA\x1b[6;1HB\x1b[7;1HC",
    before: [["F"], [""], [""], [""], ["A"], ["B"], ["C"]],
    steps: [{ write: "\x1b[5;10r" }, { write: "\x1b[10;1H" }, { write: "\n" }, { write: "\x1b[r" }],
    after: [["F"], [""], [""], [""], ["B"], ["C"], [""]],
    controls: [{ row: 0, col: 0, char: "F" }],
    cursorRow: 11,
    sentinel: { row: 12, col: 1 },
    reset: "\x1b[r",
    cleanup: "\x1b[r",
    seedNote: "Region-top markers were not measured",
    controlNote: "The row above the region moved with the region",
  },
  {
    // The claim is two-sided — ENTER the alt grid and LEAVE it — so the frame after ONE pass has to
    // witness both: main row 1 restored AND a live mark written on main row 2 after the leave (@cto
    // 2026-10-12, must-fix 1). A different marker inside the alt grid plus a live marker on main
    // separates the failures that a bare enter/leave could not:
    //  - ignoring 1049 leaves the alt marker on main row 2, so OK overwrites only its first two cells;
    //  - staying on the alt grid leaves main row 1 blank;
    //  - clearing main on exit leaves main row 1 blank too.
    // Each differs from `after`, and `after` differs from the seed frame, so no survivor reads supported.
    id: "scrollback.alt-screen",
    textClaim: "characters",
    expected: "ESC[?1049h swaps to a separate alt grid and ESC[?1049l restores the measured main grid",
    region: { top: 1, left: 1 },
    seed: "\x1b[1;1HMAIN_SCREEN_MARKER",
    before: [
      ["M", "A", "I", "N", "_", "S", "C", "R", "E", "E", "N", "_", "M", "A", "R", "K", "E", "R"],
      ["", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", ""],
    ],
    steps: [
      { write: "\x1b[?1049h" },
      { write: "\x1b[2;1HALT_SCREEN_MARKER" },
      { write: "\x1b[?1049l" },
      { write: "\x1b[2;1HOK" },
    ],
    after: [
      ["M", "A", "I", "N", "_", "S", "C", "R", "E", "E", "N", "_", "M", "A", "R", "K", "E", "R"],
      ["O", "K", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", ""],
    ],
    // The frame a surface that IGNORES 1049 leaves: the alt marker stays on main row 2 and OK
    // overwrites only its first two cells. A measured negative, so it reads unsupported BY NAME.
    ignored: [
      ["M", "A", "I", "N", "_", "S", "C", "R", "E", "E", "N", "_", "M", "A", "R", "K", "E", "R"],
      ["O", "K", "T", "_", "S", "C", "R", "E", "E", "N", "_", "M", "A", "R", "K", "E", "R", ""],
    ],
    controls: [],
    cursorRow: 3,
    sentinel: { row: 4, col: 1 },
    reset: "\x1b[?1049l",
    cleanup: "\x1b[?1049l",
    seedNote: "Main-screen marker was not measured",
    controlNote: "The main grid changed while the alt grid was active",
  },
  {
    id: "scrollback.decstbm",
    textClaim: "characters",
    expected: "DECSTBM confines the scroll: the inner marker scrolls while the row above the region stays",
    region: { top: 1, left: 1 },
    seed: "\x1b[1;1HFIXED\x1b[3;1HA\x1b[4;1HB\x1b[5;1HC",
    before: [["F"], [""], ["A"], ["B"], ["C"]],
    steps: [{ write: "\x1b[3;6r" }, { write: "\x1b[6;1H" }, { write: "\n" }, { write: "\x1b[r" }],
    after: [["F"], [""], ["B"], ["C"], [""]],
    controls: [{ row: 0, col: 0, char: "F" }],
    cursorRow: 7,
    sentinel: { row: 8, col: 1 },
    reset: "\x1b[r",
    cleanup: "\x1b[r",
    seedNote: "FIXED_TOP or the inner markers were not measured",
    controlNote: "FIXED_TOP outside the region moved with the region",
  },
  {
    id: "scrollback.decstbm-reset",
    textClaim: "characters",
    expected: "After ESC[r the full screen scrolls again, lifting the row-3 marker onto the measured row 2",
    region: { top: 1, left: 1 },
    seed: "\x1b[1;1HA\x1b[3;1HA",
    before: [["A"], [""]],
    steps: [{ write: "\x1b[4;6r" }, { write: "\x1b[S" }, { write: "\x1b[r" }, { write: "\x1b[S" }],
    after: [[""], ["A"]],
    controls: [],
    cursorRow: 6,
    sentinel: { row: 8, col: 1 },
    reset: "\x1b[r",
    cleanup: "\x1b[r",
    seedNote: "The row-3 marker or the row-1 control was not measured",
    controlNote: "The measured rows did not move as a full-screen scroll, so the reset cannot be read",
  },
]

function tooSmall(ctx: TermProbeSource, rows: number, cols: number): ProbeCallbackResult | undefined {
  if (validSize(ctx.rows, rows) && validSize(ctx.cols, cols)) return undefined
  return {
    pass: false,
    tests: [
      {
        id: "criterion",
        status: "test-todo",
        reason: `Scrollback fixture needs at least ${rows}x${cols}; measured ${ctx.rows}x${ctx.cols}`,
      },
    ],
  }
}

function validSize(value: number, minimum: number): boolean {
  return Number.isSafeInteger(value) && value >= minimum
}

export const scrollbackProbes: ProbeDefinition[] = [
  {
    ...probe(
      "scrollback.accumulate",
      (ctx) => {
        const baseline = ctx.getScrollback()
        const rows = baseline.screenLines
        if (!validSize(rows, 1) || !validSize(ctx.cols, `line ${rows + 9}`.length)) {
          return {
            pass: false,
            tests: [{ id: "criterion", status: "test-todo", reason: "insufficient-evidence" }],
          }
        }
        for (let i = 0; i < rows + 10; i++) ctx.feed(`line ${i}\r\n`)
        const scroll = ctx.getScrollback()
        return parserStateResult(
          scroll.totalLines > baseline.totalLines,
          "Written lines increase measured scrollback history",
          { baseline, scroll },
        )
      },
      async (ctx) => {
        const capture = ctx.capture
        if (capture) {
          const refusal = tooSmall(ctx, 3, `line-${ctx.rows + 9}`.length)
          if (refusal) return refusal
          try {
            ctx.write("\x1b[0m\x1b[2J\x1b[H")
            ctx.write("TOP\r\nline-0\r\nline-1")
            const control = await capture({
              role: "control",
              label: "Before overflow: TOP marker on row 1 with two written lines",
            })
            // Start below row 1 so TOP scrolls off only when the screen actually scrolls; a home
            // here would overwrite TOP and make its disappearance no scrolling control.
            ctx.write("\x1b[2;1H")
            const lineCount = ctx.rows + 10
            for (let i = 0; i < lineCount; i++) ctx.write(`line-${i}\r\n`)
            const target = await capture({
              role: "target",
              label: `After writing ${lineCount} lines: TOP has scrolled off the top and row 1 shows an advanced line-N`,
            })
            return {
              pass: false,
              response: JSON.stringify({
                rows: ctx.rows,
                cols: ctx.cols,
                lineCount,
                control: control.label,
                target: target.label,
              }),
              observation: {
                outcome: "inconclusive",
                reason: "insufficient-evidence",
                assertionType: "screenshot",
                screenshotRef: target.ref,
                frames: [control, target],
                note: "A line numbering beyond the TOP control shows the viewport scrolled past one screen; whether the terminal retained those lines as scrollback history, and how many, is not readable from the screen",
              },
            }
          } finally {
            ctx.write("\x1b[0m\x1b[2J\x1b[H")
          }
        }
        const refusal = tooSmall(ctx, 1, `line-${ctx.rows + 9}`.length)
        if (refusal) return refusal
        const rows = ctx.rows
        ctx.write("\x1b[2J\x1b[H") // clear + home
        const lineCount = rows + 10
        for (let i = 0; i < lineCount; i++) {
          ctx.write(`line-${i}\n`)
        }
        const pos = await ctx.queryCursorPosition()
        if (!pos) {
          return { pass: false, tests: [{ id: "criterion", status: "test-failure", reason: "no-response" }] }
        }
        return {
          pass: false,
          response: JSON.stringify(pos),
          observation: {
            outcome: "inconclusive",
            reason: "insufficient-evidence",
            assertionType: "query_reply",
            note: "Cursor position does not measure scrollback history",
          },
        }
      },
    ),
    termNeedsGeometry: true,
  },

  {
    ...probe(
      "scrollback.total-lines",
      (ctx) => {
        const baseline = ctx.getScrollback()
        const rows = baseline.screenLines
        if (!validSize(rows, 1) || !validSize(ctx.cols, `line ${rows + 9}`.length)) {
          return {
            pass: false,
            tests: [{ id: "criterion", status: "test-todo", reason: "insufficient-evidence" }],
          }
        }
        const lineCount = rows + 10
        for (let i = 0; i < lineCount; i++) ctx.feed(`line ${i}\r\n`)
        const scroll = ctx.getScrollback()
        return parserStateResult(
          scroll.totalLines > baseline.totalLines,
          "Measured total lines increase after writing beyond the screen",
          { baseline, lineCount, scroll },
        )
      },
      async (ctx) => {
        const capture = ctx.capture
        if (capture) {
          const refusal = tooSmall(ctx, 5, `total-${ctx.rows + 9}`.length)
          if (refusal) return refusal
          try {
            ctx.write("\x1b[0m\x1b[2J\x1b[H")
            ctx.write("TOP")
            const control = await capture({
              role: "control",
              label: "Before overflow: TOP marker on row 1 with no history written",
            })
            // Start below row 1 so TOP is not overwritten before scrolling can be observed.
            ctx.write("\x1b[2;1H")
            const lineCount = ctx.rows + 10
            for (let i = 0; i < lineCount; i++) ctx.write(`total-${i}\n`)
            const target = await capture({
              role: "target",
              label: `After writing ${lineCount} lines: TOP has scrolled off, showing total lines exceeded one screen`,
            })
            return {
              pass: false,
              response: JSON.stringify({
                rows: ctx.rows,
                cols: ctx.cols,
                lineCount,
                control: control.label,
                target: target.label,
              }),
              observation: {
                outcome: "inconclusive",
                reason: "insufficient-evidence",
                assertionType: "screenshot",
                screenshotRef: target.ref,
                frames: [control, target],
                note: "The TOP control leaving the top of the screen after more lines than a screen can hold shows the viewport scrolled past its height; retained-history existence and count are not readable from the screen",
              },
            }
          } finally {
            ctx.write("\x1b[0m\x1b[2J\x1b[H")
          }
        }
        const refusal = tooSmall(ctx, 5, `total-${ctx.rows + 9}`.length)
        if (refusal) return refusal
        ctx.write("\x1b[2J\x1b[H") // clear
        for (let i = 0; i < ctx.rows + 10; i++) ctx.write(`total-${i}\n`)
        ctx.write("\x1b[5;1H") // move to row 5
        const pos = await ctx.queryCursorPosition()
        if (!pos) {
          return { pass: false, tests: [{ id: "criterion", status: "test-failure", reason: "no-response" }] }
        }
        return {
          pass: false,
          response: JSON.stringify(pos),
          observation: {
            outcome: "inconclusive",
            reason: "insufficient-evidence",
            assertionType: "query_reply",
            note: "Cursor position does not measure total scrollback lines",
          },
        }
      },
    ),
    termNeedsGeometry: true,
  },

  ...regionReadbackProbes(scrollbackReadbackRows),
]
