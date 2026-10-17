/**
 * @failure A reset-family row's capture arm compares a control frame and a target frame from two
 *   different paint contexts and grades "the frames differ" as support: a terminal that ignores the
 *   reset still differs from a control painted with a different setup, and a sequence that never
 *   reached the screen is reported as a capability claim. The nine reset-family rows therefore
 *   declare one capture-region row each: seed, expected and ignored frames are painted in the same
 *   run and compared cell-for-cell by the exact-digest oracle.
 * @level l1
 * @consumer The capture arms of sgr.ts (default colours, underline colour reset, selective resets,
 *   SGR 0) and reset.ts (reset.sgr) on owned contexts.
 * @testonly none
 */
import type { RegionReadback } from "./region-readback.ts"

/** The cells the row compares: the two YY cells, never the XX cells nor the witness. */
const REGION = { top: 3, left: 5, bottom: 3, right: 6 } as const
const SENTINEL = { row: 1, col: 1 } as const
const CURSOR_ROW = 4

/**
 * One frame of the fixture. XX carries the setup attribute in EVERY frame, so the comparison is
 * only ever about YY; YY carries either the setup attribute (the seed and the ignored frame) or just
 * the attributes the row says survive the reset (the expected frame).
 *
 * YY is painted FIRST, immediately after the frame's own reset, so a "default" YY never depends on
 * the sequence under test. XX is painted afterwards and cannot repaint YY's cells.
 */
function frame(setup: string, yy: string, repaint = "\x1b[0m\x1b[2J"): string {
  return `${repaint}\x1b[3;5H${yy}\x1b[3;3H${setup}XX\x1b[${CURSOR_ROW};1H`
}

/**
 * The expected frame. Its state before the neutral reference is FULLY SPECIFIED by painting the
 * setup attribute on the compared cells first; the reference then clears the screen and the SGR
 * state, and only the attributes the row says survive are painted afterwards.
 *
 * That pre-paint is what makes the reference safe. A frame painted straight after a reset (SGR 0 or
 * RIS) inherits whatever the TARGET step left when that reset fails to clear part of the state, so
 * a broken reset would reproduce its own fault in the expected frame and the row would read
 * supported (SGR 0 clears bold+inverse but retains italic, so
 * seed is bold+italic+inverse, after is italic, expected is italic — supported while claiming
 * italic was cleared). With the pre-paint, a reference that does NOTHING leaves the expected frame
 * equal to the ignored frame, which is the cannot-separate branch (inconclusive), never a pass.
 *
 * ED (`\x1b[2J`) clears cells only: it never changes SGR state and is not the sequence under test.
 *
 * RIS is the reference for the SIX single-attribute rows. The three rows whose reset clears TWO OR
 * MORE attributes (reset.sgr: three, sgr.reset: three, sgr.selective-reset.bold: bold+faint) cannot
 * use it: a reset under test and a RIS that both miss the same part of the cleared set leave
 * expected equal to after and different from ignored, so the row reads supported while the attribute
 * survived. They carry
 * `noIndependentReference`, and the pixel oracle declines them BY NAME before a byte.
 */
function expectedFrame(setup: string, residual: string): string {
  return (
    `\x1b[2J\x1b[3;3H${setup}XX\x1b[3;5H${setup}YY` +
    // The INDEPENDENT neutral reference. It is not the sequence under test on any of these rows.
    "\x1bc\x1b[?25l" +
    `\x1b[3;5H${residual}YY\x1b[3;3H${setup}XX\x1b[${CURSOR_ROW};1H`
  )
}

function row(setup: string, reset: string, residual: string): Omit<RegionReadback, "pixelGeometry"> {
  const styledYY = `${setup}YY`
  const seed = frame(setup, styledYY)
  return {
    region: { ...REGION },
    sentinel: { ...SENTINEL },
    cursorRow: CURSOR_ROW,
    seed,
    edit: `\x1b[3;3H${setup}XX${reset}YY\x1b[${CURSOR_ROW};1H`,
    expected: expectedFrame(setup, residual),
    // The frame a terminal that IGNORED this reset leaves: the setup attribute still on YY. It is
    // the seed frame by construction, so the "cannot separate" branch can never fire on a row with a
    // real discriminator, and a no-op still reads as the measured negative through `after == ignored`.
    ignored: seed,
    timeoutMs: 5000,
    pollMs: 250,
    minRows: CURSOR_ROW,
    minCols: REGION.right,
  }
}

/**
 * The nine reset-family rows, keyed by the probe id that owns each claim.
 * `residual` is the SGR the expected frame paints on YY: the attribute set the row says the reset
 * preserves. Empty means the row's claim is "back to the terminal default".
 */
export const RESET_FAMILY_CAPTURE: Record<string, Omit<RegionReadback, "pixelGeometry">> = {
  "reset.sgr": {
    ...row("\x1b[1;3;7m", "\x1b[0m", ""),
    noIndependentReference: "no reference independent of a full reset",
  },
  "sgr.reset": {
    ...row("\x1b[1;3;4m", "\x1b[0m", ""),
    noIndependentReference: "no reference independent of a full reset",
  },
  "sgr.fg.default": row("\x1b[31m", "\x1b[39m", ""),
  "sgr.bg.default": row("\x1b[42m", "\x1b[49m", ""),
  "sgr.underline-color-reset": row("\x1b[4m\x1b[58;2;255;0;128m", "\x1b[59m", "\x1b[4m"),
  "sgr.selective-reset.bold": {
    ...row("\x1b[1;2;3m", "\x1b[22m", "\x1b[3m"),
    noIndependentReference: "no reference independent of a full reset",
  },
  "sgr.selective-reset.underline": row("\x1b[1;4m", "\x1b[24m", "\x1b[1m"),
  "sgr.selective-reset.italic": row("\x1b[1;3m", "\x1b[23m", "\x1b[1m"),
  "sgr.selective-reset.inverse": row("\x1b[1;7m", "\x1b[27m", "\x1b[1m"),
}
