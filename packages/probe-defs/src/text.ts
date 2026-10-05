import type { ObservationEvidence, ProbeDefinition, ProbeResult, TermContext, TermlessContext } from "./types.ts"
import { isBlank, parserStateResult, probe, unmeasuredCellResult } from "./helpers.ts"

/** Each tab probe owns its stops; the app runner supplies a disposable terminal fixture. */
function installTabFixture(write: (sequence: string) => void): void {
  write("\x1b[3g\x1b[1;9H\x1bH\x1b[1;17H\x1bH\x1b[1;1H")
}

/** Restore the conventional eight-column fixture, not an unknown pre-existing custom layout. */
function restoreDefaultTabs(write: (sequence: string) => void, cols: number): void {
  let sequence = "\x1b[3g"
  for (let col = 9; col <= cols; col += 8) sequence += `\x1b[1;${col}H\x1bH`
  write(sequence + "\x1b[1;1H")
}

function tooSmall(ctx: TermContext, rows: number, cols: number): ProbeResult | undefined {
  if (validSize(ctx.rows, rows) && validSize(ctx.cols, cols)) return undefined
  return {
    pass: false,
    observation: {
      outcome: "inconclusive",
      reason: "insufficient-evidence",
      evidence: "none",
      note: `Text fixture needs at least ${rows}x${cols}; measured ${ctx.rows}x${ctx.cols}`,
    },
  }
}

function validSize(value: number, minimum: number): boolean {
  return Number.isSafeInteger(value) && value >= minimum
}

type CursorPosition = { row: number; col: number }

/** DECAWM (mode 7) governs right-margin wrapping; without it a wrap probe cannot conclude. */
const DECAWM_MODE = 7

/**
 * Combined HT/HTS fixture: the home position, a comparison stop at column 9 and the owned stop
 * at column 6 must each be qualified by their own measured CPR, so a constant, spoofed or
 * unqualified reply provider stays inconclusive and only a genuinely ignored owned stop is
 * unsupported. Isolation of either primitive is out of scope, so the assertion names the
 * combined fixture rather than attributing a primitive failure.
 */
function tabCombinedResult(
  home: CursorPosition | null,
  comparison: CursorPosition | null,
  owned: CursorPosition | null,
  cols: number,
): ProbeResult {
  const response = JSON.stringify({ cols, home, comparison, owned })
  if (!home) {
    return { pass: false, response, observation: { outcome: "inconclusive", reason: "no-response", evidence: "query" } }
  }
  if (home.row !== 1 || home.col !== 1) {
    return {
      pass: false,
      response,
      observation: {
        outcome: "inconclusive",
        reason: "insufficient-evidence",
        evidence: "query",
        note: "Measured home position was not row 1, column 1; the cursor-query provider is not position-sensitive",
      },
    }
  }
  if (!comparison) {
    return { pass: false, response, observation: { outcome: "inconclusive", reason: "no-response", evidence: "query" } }
  }
  if (comparison.row !== 1 || comparison.col !== 9) {
    return {
      pass: false,
      response,
      observation: {
        outcome: "inconclusive",
        reason: "insufficient-evidence",
        evidence: "query",
        note: "Comparison stop at column 9 was not established; fixture setup not qualified",
      },
    }
  }
  if (!owned) {
    return { pass: false, response, observation: { outcome: "inconclusive", reason: "no-response", evidence: "query" } }
  }
  const expected = "combined HT/HTS fixture advances to the nearest owned stop at row 1, column 6"
  if (owned.row === 1 && owned.col === 6) {
    return {
      pass: true,
      response,
      observation: { outcome: "supported", evidence: "query" },
      assertions: [{ kind: "positive", expected, observed: JSON.stringify({ home, comparison, owned }) }],
    }
  }
  if (owned.row === 1 && owned.col === 9) {
    return {
      pass: false,
      response,
      observation: {
        outcome: "unsupported",
        evidence: "query",
        note: "Owned stop at column 6 was ignored; tab fell through to the measured comparison stop (home 1;1 and comparison 1;9 were both qualified)",
      },
      assertions: [{ kind: "negative", expected, observed: JSON.stringify({ home, comparison, owned }) }],
    }
  }
  return {
    pass: false,
    response,
    observation: { outcome: "inconclusive", reason: "insufficient-evidence", evidence: "query" },
  }
}

function tabClearResult(
  positions: {
    oldFirst: { row: number; col: number } | null
    oldSecond: { row: number; col: number } | null
    oldThird: { row: number; col: number } | null
    after: { row: number; col: number } | null
  },
  cols: number,
  evidence: ObservationEvidence,
): ProbeResult {
  const response = JSON.stringify({ cols, ...positions })
  const { oldFirst, oldSecond, oldThird, after } = positions
  if (!oldFirst || !oldSecond || !oldThird || !after) {
    return {
      pass: false,
      response,
      observation: { outcome: "inconclusive", reason: "no-response", evidence },
    }
  }
  if (
    oldFirst.row !== 1 ||
    oldFirst.col !== 9 ||
    oldSecond.row !== 1 ||
    oldSecond.col !== 17 ||
    oldThird.row !== 1 ||
    oldThird.col !== 25
  ) {
    return {
      pass: false,
      response,
      observation: {
        outcome: "inconclusive",
        reason: "insufficient-evidence",
        evidence,
        note: "Could not establish owned tab stops at columns 9, 17 and 25",
      },
    }
  }
  const pass = after.row === 1 && after.col === cols
  const failedClear = after.row === 1 && [1, 9, 17, 25].includes(after.col)
  return {
    pass,
    response,
    observation: {
      outcome: pass ? "supported" : failedClear ? "unsupported" : "inconclusive",
      ...(pass || failedClear ? {} : { reason: "insufficient-evidence" as const }),
      evidence,
    },
    ...(pass || failedClear
      ? {
          assertions: [
            {
              kind: pass ? ("positive" as const) : ("negative" as const),
              expected: "After clearing old stops at columns 9, 17 and 25, tab reaches the right margin",
              observed: response,
            },
          ],
        }
      : {}),
  }
}

function tabPositionResult(
  position: { row: number; col: number } | null,
  expectedCol: number,
  evidence: ObservationEvidence,
): ProbeResult {
  if (!position) {
    return {
      pass: false,
      note: "No cursor response",
      observation: { outcome: "inconclusive", reason: "no-response", evidence },
    }
  }
  const response = JSON.stringify(position)
  const pass = position.row === 1 && position.col === expectedCol
  return {
    pass,
    response,
    observation: { outcome: pass ? "supported" : "unsupported", evidence },
    assertions: [{ kind: pass ? "positive" : "negative", expected: `row 1, col ${expectedCol}`, observed: response }],
  }
}

/** Exact declared-width samples measured by the shared termless emoji-width helper. */
type DeclaredWidthSample = {
  /** The declared sample, written verbatim after setup qualification. */
  sample: string
  /** Worst-case columns the sample's scalars may occupy when the terminal does not combine them. */
  maxColumns: number
}

/** A lone UTF-16 surrogate half means the scalar was split rather than decoded faithfully. */
function isLoneSurrogate(value: string): boolean {
  if (value.length !== 1) return false
  const code = value.charCodeAt(0)
  return code >= 0xd800 && code <= 0xdfff
}

/**
 * Measure a declared-width emoji sample from the headless parser grid without trusting the sample's
 * expected two-column offset. Setup, readout and the sentinel are each qualified independently:
 * distinct ASCII calibration proves cells and cursor move together, a supplementary-plane control
 * proves scalars survive encoding, and the width is taken from wherever the unique ASCII sentinel
 * actually landed. A genuinely different measured width therefore concludes unsupported instead of
 * being discarded as insufficient evidence, while constant/stale/wrapped/ambiguous readbacks stay
 * inconclusive. Width two is claimed only for the declared sample, never for a rendered glyph.
 */
function emojiWidthResult(ctx: TermlessContext, { sample, maxColumns }: DeclaredWidthSample): ProbeResult {
  const expected = "Declared-width sample occupies two parser columns after qualified setup"
  const home = "\x1b[1;1H\x1b[2K"
  const marker = "X"
  const supplementary = "\u{1F30D}"
  const required = maxColumns + 2
  if (!Number.isSafeInteger(ctx.cols) || ctx.cols < required) {
    return {
      pass: false,
      observation: {
        outcome: "inconclusive",
        reason: "insufficient-evidence",
        evidence: "none",
        note: `Emoji width fixture needs at least ${required} columns to place the sample and sentinel without wrapping; measured ${ctx.cols}`,
      },
    }
  }
  try {
    // 1. Readout qualification: distinct ASCII, exact advance, then erased home.
    ctx.feed(home)
    ctx.feed("ABX")
    const calibration = [ctx.getCell(0, 0).char, ctx.getCell(0, 1).char, ctx.getCell(0, 2).char]
    const calibrationCursor = ctx.getCursor()
    ctx.feed(home)
    const erased = Array.from({ length: required }, (_, col) => ctx.getCell(0, col).char)
    const homeCursor = ctx.getCursor()
    const readoutQualified =
      calibration[0] === "A" &&
      calibration[1] === "B" &&
      calibration[2] === "X" &&
      calibrationCursor.y === 0 &&
      calibrationCursor.x === 3 &&
      erased.every(isBlank) &&
      homeCursor.y === 0 &&
      homeCursor.x === 0
    if (!readoutQualified) {
      return parserStateResult(
        null,
        expected,
        { calibration, calibrationCursor, erased, homeCursor },
        "ASCII calibration, erase or home readout was not coherent; cells or cursor are constant, stale or unqualified",
      )
    }

    // 2. Supplementary-plane control: a faithful scalar and the sentinel must both survive encoding.
    ctx.feed(supplementary + marker)
    const control = Array.from({ length: 4 }, (_, col) => ctx.getCell(0, col).char)
    const controlCursor = ctx.getCursor()
    const controlIndex = control.indexOf(marker)
    const controlTarget = controlIndex < 0 ? control : control.slice(0, controlIndex)
    const controlQualified =
      controlIndex >= 1 &&
      controlCursor.y === 0 &&
      controlCursor.x === controlIndex + 1 &&
      controlTarget.some((char) => char !== "" && !isLoneSurrogate(char)) &&
      !controlTarget.some(isLoneSurrogate)
    if (!controlQualified) {
      return parserStateResult(
        null,
        expected,
        { control, controlCursor, controlIndex },
        controlTarget.some(isLoneSurrogate)
          ? "Supplementary-plane control exposed lone surrogate halves, so scalar encoding is ambiguous"
          : "Supplementary-plane control did not expose a faithful scalar with the sentinel surviving",
      )
    }
    ctx.feed(home)

    // 3. Target: exact sample plus unique sentinel, located wherever it actually landed.
    const cursorBefore = ctx.getCursor()
    ctx.feed(sample + marker)
    const row = Array.from({ length: ctx.cols }, (_, col) => ctx.getCell(0, col).char)
    const cursorAfter = ctx.getCursor()
    const markerColumns: number[] = []
    for (let col = 0; col < row.length; col += 1) if (row[col] === marker) markerColumns.push(col)
    const state = { sample, cursorBefore, cursorAfter, row, markerColumns }
    if (markerColumns.length === 0) {
      return parserStateResult(null, expected, state, "Sentinel marker was not exposed after the sample")
    }
    if (markerColumns.length > 1) {
      return parserStateResult(
        null,
        expected,
        state,
        "Sentinel marker was duplicated; target advance cannot be attributed",
      )
    }
    if (cursorBefore.x !== 0 || cursorBefore.y !== 0) {
      return parserStateResult(null, expected, state, "Home before the target was not measured")
    }
    if (cursorAfter.y !== 0 || cursorAfter.x >= ctx.cols) {
      return parserStateResult(
        null,
        expected,
        state,
        "Sample plus sentinel wrapped the row; width is not measurable in this geometry",
      )
    }
    const markerColumn = markerColumns[0]
    const target = row.slice(0, markerColumn)
    if (target.some(isLoneSurrogate)) {
      return parserStateResult(
        null,
        expected,
        state,
        "Sample cells exposed lone surrogate halves, so target encoding is ambiguous",
      )
    }
    if (ctx.getCell(0, markerColumn).wide || cursorAfter.x !== markerColumn + 1) {
      return parserStateResult(
        null,
        expected,
        state,
        "Sentinel cursor or cell disagreed; the marker is not a validated one-column glyph",
      )
    }
    const width = markerColumn
    return parserStateResult(
      width === 2,
      expected,
      { ...state, width },
      width === 2 ? undefined : "Declared sample measured a width other than two parser columns",
    )
  } finally {
    ctx.feed(home)
  }
}

export const textProbes: ProbeDefinition[] = [
  {
    ...probe(
      "text.basic",
      (ctx) => {
        ctx.feed("\x1b[2J\x1b[H")
        const before = ctx.getText()
        ctx.feed("Hello")
        const after = ctx.getText()
        return parserStateResult(
          before.includes("Hello") ? null : after.includes("Hello"),
          "Hello appears after a measured empty control",
          { before, after },
          before.includes("Hello") ? "Control already contained Hello" : undefined,
        )
      },
      async (ctx) => {
        const refusal = tooSmall(ctx, 1, 6)
        if (refusal) return refusal
        ctx.write("\x1b[1;1H\x1b[2K") // clear line, move to 1;1
        const before = await ctx.queryCursorPosition()
        if (!before) {
          return { pass: false, observation: { outcome: "inconclusive", reason: "no-response", evidence: "query" } }
        }
        if (before.row !== 1 || before.col !== 1) {
          return {
            pass: false,
            response: JSON.stringify({ before }),
            observation: {
              outcome: "inconclusive",
              reason: "insufficient-evidence",
              evidence: "query",
              note: "Measured home position was not row 1, column 1; the cursor-query provider is not position-sensitive",
            },
          }
        }
        ctx.write("Hello")
        const pos = await ctx.queryCursorPosition()
        if (!pos) {
          return { pass: false, observation: { outcome: "inconclusive", reason: "no-response", evidence: "query" } }
        }
        const pass = pos.row === 1 && pos.col === 6
        return {
          pass,
          response: JSON.stringify({ before, pos }),
          observation: { outcome: pass ? "supported" : "unsupported", evidence: "query" },
          assertions: [
            {
              kind: pass ? "positive" : "negative",
              expected: "writing Hello advances the cursor five columns to row 1, column 6",
              observed: JSON.stringify({ before, pos }),
            },
          ],
        }
      },
    ),
    termNeedsGeometry: true,
  },

  {
    ...probe(
      "text.newline",
      (ctx) => {
        ctx.feed("\x1b[2J\x1b[H")
        const before = [ctx.getCell(0, 0), ctx.getCell(1, 0)]
        ctx.feed("A\r\nB")
        const first = ctx.getCell(0, 0)
        const second = ctx.getCell(1, 0)
        const ready = before.every((cell) => isBlank(cell.char))
        return parserStateResult(
          ready ? first.char === "A" && second.char === "B" : null,
          "CRLF places B below A",
          { before, first, second },
          ready ? undefined : "Control cells were not blank",
        )
      },
      async (ctx) => {
        const refusal = tooSmall(ctx, 4, 5)
        if (refusal) return refusal
        ctx.write("\x1b[3;5H") // move to row 3, col 5
        const before = await ctx.queryCursorPosition()
        ctx.write("\n") // LF
        const pos = await ctx.queryCursorPosition()
        if (!before || !pos) {
          return { pass: false, observation: { outcome: "inconclusive", reason: "no-response", evidence: "query" } }
        }
        if (before.row !== 3 || before.col !== 5) {
          return {
            pass: false,
            response: JSON.stringify({ before, pos }),
            observation: {
              outcome: "inconclusive",
              reason: "insufficient-evidence",
              evidence: "query",
              note: "Could not establish starting cursor position",
            },
          }
        }
        // LNM or TTY output processing may also return to column 1. The
        // feature claim is vertical movement; retain the column as evidence.
        const pass = pos.row === 4
        return {
          pass,
          response: JSON.stringify({ before, pos }),
          observation: {
            outcome: pass ? "supported" : "unsupported",
            evidence: "query",
            ...(pos.col !== 5 && {
              note: `Column changed from 5 to ${pos.col}; this probe does not distinguish terminal newline mode from TTY output processing`,
            }),
          },
          assertions: [
            {
              kind: pass ? "positive" : "negative",
              expected: "LF advances from row 3 to row 4",
              observed: JSON.stringify({ before, pos }),
            },
          ],
        }
      },
    ),
    termNeedsGeometry: true,
  },

  {
    ...probe(
      "text.wrap",
      (ctx) => {
        if (!validSize(ctx.cols, 2) || !validSize(ctx.getScrollback().screenLines, 2)) {
          return {
            pass: false,
            observation: { outcome: "inconclusive", reason: "insufficient-evidence", evidence: "none" },
          }
        }
        ctx.feed("\x1b[2J\x1b[H")
        const before = [ctx.getCell(0, ctx.cols - 1), ctx.getCell(1, 0)]
        ctx.feed("X".repeat(ctx.cols + 1))
        const last = ctx.getCell(0, ctx.cols - 1)
        const next = ctx.getCell(1, 0)
        const ready = before.every((cell) => isBlank(cell.char))
        return parserStateResult(
          ready ? last.char === "X" && next.char === "X" : null,
          "The next X wraps to the measured second row",
          { cols: ctx.cols, before, last, next },
          ready ? undefined : "Control cells were not blank",
        )
      },
      async (ctx) => {
        const cols = ctx.cols
        if (!validSize(ctx.rows, 2) || !validSize(cols, 2)) {
          return {
            pass: false,
            observation: {
              outcome: "inconclusive",
              reason: "insufficient-evidence",
              evidence: "none",
              note: `Wrap fixture needs at least 2x2, measured ${ctx.rows}x${cols}`,
            },
          }
        }
        const decawm = await ctx.queryMode(DECAWM_MODE)
        if (decawm !== "set") {
          return {
            pass: false,
            response: JSON.stringify({ cols, decawm }),
            observation: {
              outcome: "inconclusive",
              reason: decawm === null ? "no-response" : "insufficient-evidence",
              evidence: "query",
              note:
                decawm === null
                  ? "DECAWM setup did not reply"
                  : `DECAWM measured ${decawm}; right-margin wrap not qualified`,
            },
          }
        }
        ctx.write("\x1b[1;1H")
        const home = await ctx.queryCursorPosition()
        if (!home) {
          return {
            pass: false,
            response: JSON.stringify({ cols, decawm }),
            observation: { outcome: "inconclusive", reason: "no-response", evidence: "query" },
          }
        }
        if (home.row !== 1 || home.col !== 1) {
          return {
            pass: false,
            response: JSON.stringify({ cols, decawm, home }),
            observation: {
              outcome: "inconclusive",
              reason: "insufficient-evidence",
              evidence: "query",
              note: "Measured home position was not row 1, column 1; the cursor-query provider is not position-sensitive",
            },
          }
        }
        ctx.write("\x1b[1;1H\x1b[2K")
        ctx.write("W".repeat(cols - 1))
        const control = await ctx.queryCursorPosition()
        if (!control) {
          return {
            pass: false,
            response: JSON.stringify({ cols, decawm, home }),
            observation: { outcome: "inconclusive", reason: "no-response", evidence: "query" },
          }
        }
        if (control.row !== 1 || control.col !== cols) {
          return {
            pass: false,
            response: JSON.stringify({ cols, decawm, home, control }),
            observation: {
              outcome: "inconclusive",
              reason: "insufficient-evidence",
              evidence: "query",
              note: "Control did not leave the cursor at the right margin; wrap not qualified",
            },
          }
        }
        ctx.write("\x1b[1;1H\x1b[2K")
        ctx.write("W".repeat(cols) + "X")
        const target = await ctx.queryCursorPosition()
        if (!target) {
          return {
            pass: false,
            response: JSON.stringify({ cols, decawm, home, control }),
            observation: { outcome: "inconclusive", reason: "no-response", evidence: "query" },
          }
        }
        const pass = target.row === 2 && target.col === 2
        return {
          pass,
          response: JSON.stringify({ cols, decawm, home, control, target }),
          observation: { outcome: pass ? "supported" : "unsupported", evidence: "query" },
          assertions: [
            {
              kind: pass ? "positive" : "negative",
              expected: `wrap after ${cols} columns lands the cursor at row 2, column 2`,
              observed: JSON.stringify({ home, control, target }),
            },
          ],
        }
      },
    ),
    termNeedsGeometry: true,
  },

  {
    ...probe(
      "text.tab",
      (ctx) => {
        if (!validSize(ctx.cols, 9)) {
          return {
            pass: false,
            observation: { outcome: "inconclusive", reason: "insufficient-evidence", evidence: "none" },
          }
        }
        try {
          ctx.feed("\x1b[3g\x1b[1;9H\x1bH\x1b[1;1H\tX")
          const cell = ctx.getCell(0, 8)
          return parserStateResult(cell.char === "X", "HT moves X to the owned stop at column 9", { cell })
        } finally {
          restoreDefaultTabs(ctx.feed, ctx.cols)
        }
      },
      async (ctx) => {
        const refusal = tooSmall(ctx, 1, 9)
        if (refusal) return refusal
        try {
          ctx.write("\x1b[3g\x1b[1;1H")
          const home = await ctx.queryCursorPosition()
          ctx.write("\x1b[1;9H\x1bH\x1b[1;1H")
          ctx.write("\t")
          const comparison = await ctx.queryCursorPosition()
          ctx.write("\x1b[1;6H\x1bH\x1b[1;1H")
          ctx.write("\t")
          const owned = await ctx.queryCursorPosition()
          return tabCombinedResult(home, comparison, owned, ctx.cols)
        } finally {
          restoreDefaultTabs(ctx.write, ctx.cols)
        }
      },
    ),
    termNeedsGeometry: true,
  },

  {
    ...probe(
      "text.wide.emoji",
      (ctx) => {
        ctx.feed("AA")
        const ascii = [ctx.getCell(0, 0), ctx.getCell(0, 1)]
        ctx.feed("\x1b[1;1H\x1b[2K")
        ctx.feed("\u{1f389}")
        const cell = ctx.getCell(0, 0)
        const ready = ascii[0]?.char === "A" && ascii[1]?.char === "A" && cell.char === "🎉"
        return parserStateResult(
          ready ? cell.wide === true : null,
          "Emoji occupies a wide parser cell",
          { ascii, cell },
          ready ? undefined : "ASCII control or emoji cell was not exposed",
        )
      },
      async (ctx) => {
        const refusal = tooSmall(ctx, 1, 3)
        if (refusal) return refusal
        const ascii = await ctx.measureRenderedWidth("AA")
        const width = await ctx.measureRenderedWidth("\u{1f389}")
        if (ascii !== 2 || width === null) {
          return {
            pass: false,
            response: JSON.stringify({ ascii, width }),
            observation: {
              outcome: "inconclusive",
              reason: "insufficient-evidence",
              evidence: "query",
              note: "ASCII width control or emoji width was unavailable",
            },
          }
        }
        const pass = width === 2
        return {
          pass,
          response: JSON.stringify({ ascii, width }),
          observation: { outcome: pass ? "supported" : "unsupported", evidence: "query" },
          assertions: [
            {
              kind: pass ? "positive" : "negative",
              expected: "🎉 occupies two columns after ASCII calibration",
              observed: JSON.stringify({ ascii, width }),
            },
          ],
        }
      },
    ),
    termNeedsGeometry: true,
  },

  {
    ...probe(
      "text.wide.cjk",
      (ctx) => {
        ctx.feed("AA")
        const ascii = [ctx.getCell(0, 0), ctx.getCell(0, 1)]
        ctx.feed("\x1b[1;1H\x1b[2K")
        ctx.feed("\u4e2d")
        const cell = ctx.getCell(0, 0)
        const ready = ascii[0]?.char === "A" && ascii[1]?.char === "A" && cell.char === "中"
        return parserStateResult(
          ready ? cell.wide === true : null,
          "CJK sample occupies a wide parser cell",
          { ascii, cell },
          ready ? undefined : "ASCII control or CJK cell was not exposed",
        )
      },
      async (ctx) => {
        const refusal = tooSmall(ctx, 1, 3)
        if (refusal) return refusal
        const ascii = await ctx.measureRenderedWidth("AA")
        const width = await ctx.measureRenderedWidth("\u4e2d")
        if (ascii !== 2 || width === null) {
          return {
            pass: false,
            response: JSON.stringify({ ascii, width }),
            observation: {
              outcome: "inconclusive",
              reason: "insufficient-evidence",
              evidence: "query",
              note: "ASCII width control or CJK width was unavailable",
            },
          }
        }
        const pass = width === 2
        return {
          pass,
          response: JSON.stringify({ ascii, width }),
          observation: { outcome: pass ? "supported" : "unsupported", evidence: "query" },
          assertions: [
            {
              kind: pass ? "positive" : "negative",
              expected: "中 occupies two columns after ASCII calibration",
              observed: JSON.stringify({ ascii, width }),
            },
          ],
        }
      },
    ),
    termNeedsGeometry: true,
  },

  {
    ...probe(
      "text.overwrite",
      (ctx) => {
        ctx.feed("AB")
        const before = [ctx.getCell(0, 0), ctx.getCell(0, 1)]
        ctx.feed("\x1b[1GC")
        const first = ctx.getCell(0, 0)
        const second = ctx.getCell(0, 1)
        const ready = before[0]?.char === "A" && before[1]?.char === "B"
        return parserStateResult(
          ready ? first.char === "C" && second.char === "B" : null,
          "C overwrites A while B remains",
          { before, first, second },
          ready ? undefined : "AB control was not measured",
        )
      },
      async (ctx) => {
        const capture = ctx.capture
        if (capture) {
          const refusal = tooSmall(ctx, 1, 3)
          if (refusal) return refusal
          try {
            ctx.write("\x1b[0m\x1b[1;1H\x1b[2K")
            ctx.write("AB")
            const control = await capture({
              role: "control",
              label: "Row 1 shows AB before the overwrite write",
            })
            ctx.write("\x1b[1;2H")
            ctx.write("X")
            const target = await capture({
              role: "target",
              label: "Row 1 shows AX after writing X over B at column 2",
            })
            return {
              pass: false,
              response: JSON.stringify({
                rows: ctx.rows,
                cols: ctx.cols,
                control: control.label,
                target: target.label,
              }),
              observation: {
                outcome: "inconclusive",
                reason: "insufficient-evidence",
                evidence: "pixels",
                screenshotRef: target.ref,
                frames: [control, target],
                note: "The second cell changing from B to X requires independent pixel review; cursor position does not measure cell contents",
              },
            }
          } finally {
            ctx.write("\x1b[0m\x1b[1;1H\x1b[2K")
          }
        }
        const refusal = tooSmall(ctx, 1, 3)
        if (refusal) return refusal
        ctx.write("\x1b[1;1H\x1b[2K")
        ctx.write("AB") // cursor at col 3
        ctx.write("\x1b[1;2H") // move back to col 2
        ctx.write("X") // overwrite B
        const pos = await ctx.queryCursorPosition()
        return unmeasuredCellResult(pos, "overwritten B cell")
      },
    ),
    termNeedsGeometry: true,
  },

  {
    ...probe(
      "text.cr",
      (ctx) => {
        ctx.feed("AB")
        const before = [ctx.getCell(0, 0), ctx.getCell(0, 1)]
        ctx.feed("\rC")
        const first = ctx.getCell(0, 0)
        const second = ctx.getCell(0, 1)
        const ready = before[0]?.char === "A" && before[1]?.char === "B"
        return parserStateResult(
          ready ? first.char === "C" && second.char === "B" : null,
          "CR returns C to the first column while B remains",
          { before, first, second },
          ready ? undefined : "AB control was not measured",
        )
      },
      async (ctx) => {
        const refusal = tooSmall(ctx, 1, 3)
        if (refusal) return refusal
        ctx.write("\x1b[1;1H\x1b[2K")
        ctx.write("AB")
        const before = await ctx.queryCursorPosition()
        ctx.write("\r") // CR
        const pos = await ctx.queryCursorPosition()
        if (!before || !pos) {
          return { pass: false, observation: { outcome: "inconclusive", reason: "no-response", evidence: "query" } }
        }
        if (before.row !== 1 || before.col !== 3) {
          return {
            pass: false,
            response: JSON.stringify({ before, pos }),
            observation: {
              outcome: "inconclusive",
              reason: "insufficient-evidence",
              evidence: "query",
              note: "Could not establish cursor at 1;3 before CR",
            },
          }
        }
        const pass = pos.row === 1 && pos.col === 1
        return {
          pass,
          response: JSON.stringify({ before, pos }),
          observation: { outcome: pass ? "supported" : "unsupported", evidence: "query" },
          assertions: [
            {
              kind: pass ? "positive" : "negative",
              expected: "CR moves cursor from 1;3 to 1;1",
              observed: JSON.stringify({ before, pos }),
            },
          ],
        }
      },
    ),
    termNeedsGeometry: true,
  },

  {
    ...probe(
      "text.backspace",
      (ctx) => {
        ctx.feed("AB")
        const before = [ctx.getCell(0, 0), ctx.getCell(0, 1)]
        ctx.feed("\x08C")
        const first = ctx.getCell(0, 0)
        const second = ctx.getCell(0, 1)
        const ready = before[0]?.char === "A" && before[1]?.char === "B"
        return parserStateResult(
          ready ? first.char === "A" && second.char === "C" : null,
          "Backspace lets C overwrite B while A remains",
          { before, first, second },
          ready ? undefined : "AB control was not measured",
        )
      },
      async (ctx) => {
        const refusal = tooSmall(ctx, 1, 5)
        if (refusal) return refusal
        ctx.write("\x1b[1;5H") // Move to col 5
        const before = await ctx.queryCursorPosition()
        ctx.write("\b") // BS
        const pos = await ctx.queryCursorPosition()
        if (!before || !pos) {
          return { pass: false, observation: { outcome: "inconclusive", reason: "no-response", evidence: "query" } }
        }
        if (before.row !== 1 || before.col !== 5) {
          return {
            pass: false,
            response: JSON.stringify({ before, pos }),
            observation: {
              outcome: "inconclusive",
              reason: "insufficient-evidence",
              evidence: "query",
              note: "Could not establish cursor at 1;5 before BS",
            },
          }
        }
        const pass = pos.row === 1 && pos.col === 4
        return {
          pass,
          response: JSON.stringify({ before, pos }),
          observation: { outcome: pass ? "supported" : "unsupported", evidence: "query" },
          assertions: [
            {
              kind: pass ? "positive" : "negative",
              expected: "BS moves from 1;5 to 1;4",
              observed: JSON.stringify({ before, pos }),
            },
          ],
        }
      },
    ),
    termNeedsGeometry: true,
  },

  {
    ...probe(
      "text.index",
      (ctx) => {
        ctx.feed("A")
        const before = ctx.getCursor()
        ctx.feed("\x1bD")
        const after = ctx.getCursor()
        const ready = before.y === 0 && before.x === 1
        return parserStateResult(
          ready ? after.y === 1 && after.x === 1 : null,
          "IND advances the parser cursor one row",
          { before, after },
          ready ? undefined : "Starting cursor position was not measured",
        )
      },
      async (ctx) => {
        const refusal = tooSmall(ctx, 4, 5)
        if (refusal) return refusal
        ctx.write("\x1b[3;5H") // move to row 3, col 5
        const before = await ctx.queryCursorPosition()
        ctx.write("\x1bD") // IND
        const pos = await ctx.queryCursorPosition()
        if (!before || !pos) {
          return { pass: false, observation: { outcome: "inconclusive", reason: "no-response", evidence: "query" } }
        }
        if (before.row !== 3 || before.col !== 5) {
          return {
            pass: false,
            response: JSON.stringify({ before, pos }),
            observation: {
              outcome: "inconclusive",
              reason: "insufficient-evidence",
              evidence: "query",
              note: "Could not establish starting cursor position",
            },
          }
        }
        const pass = pos.row === 4 && pos.col === 5
        return {
          pass,
          response: JSON.stringify({ before, pos }),
          observation: { outcome: pass ? "supported" : "unsupported", evidence: "query" },
          assertions: [
            {
              kind: pass ? "positive" : "negative",
              expected: "IND advances cursor from 3;5 to 4;5",
              observed: JSON.stringify({ before, pos }),
            },
          ],
        }
      },
    ),
    termNeedsGeometry: true,
  },

  {
    ...probe(
      "text.next-line",
      (ctx) => {
        ctx.feed("ABC")
        const before = ctx.getCursor()
        ctx.feed("\x1bE")
        const after = ctx.getCursor()
        const ready = before.y === 0 && before.x === 3
        return parserStateResult(
          ready ? after.y === 1 && after.x === 0 : null,
          "NEL advances the parser cursor to row 2 column 1",
          { before, after },
          ready ? undefined : "Starting cursor position was not measured",
        )
      },
      async (ctx) => {
        const refusal = tooSmall(ctx, 4, 5)
        if (refusal) return refusal
        ctx.write("\x1b[3;5H") // move to row 3, col 5
        const before = await ctx.queryCursorPosition()
        ctx.write("\x1bE") // NEL
        const pos = await ctx.queryCursorPosition()
        if (!before || !pos) {
          return { pass: false, observation: { outcome: "inconclusive", reason: "no-response", evidence: "query" } }
        }
        if (before.row !== 3 || before.col !== 5) {
          return {
            pass: false,
            response: JSON.stringify({ before, pos }),
            observation: {
              outcome: "inconclusive",
              reason: "insufficient-evidence",
              evidence: "query",
              note: "Could not establish starting cursor position",
            },
          }
        }
        const pass = pos.row === 4 && pos.col === 1
        return {
          pass,
          response: JSON.stringify({ before, pos }),
          observation: { outcome: pass ? "supported" : "unsupported", evidence: "query" },
          assertions: [
            {
              kind: pass ? "positive" : "negative",
              expected: "NEL advances cursor from 3;5 to 4;1",
              observed: JSON.stringify({ before, pos }),
            },
          ],
        }
      },
    ),
    termNeedsGeometry: true,
  },

  {
    ...probe(
      "text.reverse-index-scroll",
      (ctx) => {
        if (!validSize(ctx.getScrollback().screenLines, 5)) {
          return {
            pass: false,
            observation: { outcome: "inconclusive", reason: "insufficient-evidence", evidence: "none" },
          }
        }
        try {
          ctx.feed("\x1b[1;5r") // Set scroll region to lines 1-5
          ctx.feed("\x1b[H") // Move to top (row 0)
          ctx.feed("MARKER")
          const before = ctx.getCell(0, 0)
          ctx.feed("\x1b[H") // Back to top
          ctx.feed("\x1bM") // Reverse index at top — should scroll region down
          // MARKER should have moved from row 0 to row 1
          const cell = ctx.getCell(1, 0)
          return parserStateResult(
            before.char === "M" ? cell.char === "M" : null,
            "RI moves the measured MARKER to row 2",
            { before, cell },
            before.char === "M" ? undefined : "MARKER control was not measured",
          )
        } finally {
          ctx.feed("\x1b[r") // reset scroll region
        }
      },
      async (ctx) => {
        const capture = ctx.capture
        if (capture) {
          const refusal = tooSmall(ctx, 10, 7)
          if (refusal) return refusal
          try {
            ctx.write("\x1b[0m\x1b[2J\x1b[H")
            ctx.write("\x1b[3;10r") // scroll region rows 3-10
            ctx.write("\x1b[3;1HMARKER")
            ctx.write("\x1b[4;1Hregion4")
            const control = await capture({
              role: "control",
              label: "MARKER on row 3 at the region top with region4 on row 4",
            })
            ctx.write("\x1b[3;1H\x1bM") // RI at the region top
            const target = await capture({
              role: "target",
              label: "After reverse index at the region top: MARKER moved down to row 4",
            })
            return {
              pass: false,
              response: JSON.stringify({
                rows: ctx.rows,
                cols: ctx.cols,
                control: control.label,
                target: target.label,
              }),
              observation: {
                outcome: "inconclusive",
                reason: "insufficient-evidence",
                evidence: "pixels",
                screenshotRef: target.ref,
                frames: [control, target],
                note: "MARKER shifting down one row after RI at the region top requires independent pixel review; cursor position does not measure region contents",
              },
            }
          } finally {
            ctx.write("\x1b[r\x1b[0m\x1b[2J\x1b[H")
          }
        }
        const refusal = tooSmall(ctx, 10, 1)
        if (refusal) return refusal
        try {
          ctx.write("\x1b[3;10r") // scroll region rows 3-10
          ctx.write("\x1b[3;1H") // move to row 3 (top of region)
          ctx.write("\x1bM") // RI — reverse index at top of region
          const pos = await ctx.queryCursorPosition()
          return unmeasuredCellResult(pos, "RI scrolling of region contents")
        } finally {
          ctx.write("\x1b[r") // reset scroll region
        }
      },
    ),
    termNeedsGeometry: true,
  },

  {
    ...probe(
      "text.combining",
      (ctx) => {
        ctx.feed("AB")
        const ascii = [ctx.getCell(0, 0), ctx.getCell(0, 1)]
        ctx.feed("\x1b[1;1H\x1b[2K")
        ctx.feed("e\u0301X")
        const first = ctx.getCell(0, 0)
        const second = ctx.getCell(0, 1)
        const ready = ascii[0]?.char === "A" && ascii[1]?.char === "B" && first.char.includes("e")
        return parserStateResult(
          ready ? second.char === "X" : null,
          "Combining accent keeps X in the next parser cell",
          { ascii, first, second },
          ready ? undefined : "ASCII control or combining sample was not measured",
        )
      },
      async (ctx) => {
        const refusal = tooSmall(ctx, 1, 3)
        if (refusal) return refusal
        const ascii = await ctx.measureRenderedWidth("A")
        const width = await ctx.measureRenderedWidth("e\u0301")
        if (ascii !== 1 || width === null) {
          return {
            pass: false,
            response: JSON.stringify({ ascii, width }),
            observation: {
              outcome: "inconclusive",
              reason: "insufficient-evidence",
              evidence: "query",
              note: "ASCII width control or combining width was unavailable",
            },
          }
        }
        const pass = width === 1
        return {
          pass,
          response: JSON.stringify({ ascii, width }),
          observation: { outcome: pass ? "supported" : "unsupported", evidence: "query" },
          assertions: [
            {
              kind: pass ? "positive" : "negative",
              expected: "e plus accent occupies one column after ASCII calibration",
              observed: JSON.stringify({ ascii, width }),
            },
          ],
        }
      },
    ),
    termNeedsGeometry: true,
  },

  // HTS — set tab stop
  {
    ...probe(
      "text.hts",
      (ctx) => {
        try {
          ctx.feed("\x1b[3g\x1b[6G\x1bH\x1b[1G\t")
          const cursor = ctx.getCursor()
          return parserStateResult(cursor.x === 5 && cursor.y === 0, "HTS makes the tab advance to column 6", {
            cursor,
          })
        } finally {
          restoreDefaultTabs(ctx.feed, ctx.cols)
        }
      },
      async (ctx) => {
        const refusal = tooSmall(ctx, 1, 9)
        if (refusal) return refusal
        try {
          ctx.write("\x1b[3g\x1b[1;1H")
          const home = await ctx.queryCursorPosition()
          ctx.write("\x1b[1;9H\x1bH\x1b[1;1H")
          ctx.write("\t")
          const comparison = await ctx.queryCursorPosition()
          ctx.write("\x1b[1;6H\x1bH\x1b[1;1H")
          ctx.write("\t")
          const owned = await ctx.queryCursorPosition()
          return tabCombinedResult(home, comparison, owned, ctx.cols)
        } finally {
          restoreDefaultTabs(ctx.write, ctx.cols)
        }
      },
    ),
    termNeedsGeometry: true,
  },

  // TBC — clear tab stop
  {
    ...probe(
      "text.tbc",
      (ctx) => {
        const cols = ctx.cols
        if (!validSize(cols, 34)) {
          return {
            pass: false,
            observation: {
              outcome: "inconclusive",
              reason: "insufficient-evidence",
              evidence: "parser-state",
              note: "Tab fixture needs at least 34 columns",
            },
          }
        }
        try {
          installTabFixture(ctx.feed)
          ctx.feed("\x1b[1;25H\x1bH\x1b[1;1H")
          ctx.feed("\t")
          const oldFirst = ctx.getCursor()
          ctx.feed("\t")
          const oldSecond = ctx.getCursor()
          ctx.feed("\t")
          const oldThird = ctx.getCursor()
          ctx.feed("\x1b[3g\x1b[1;1H\t")
          const after = ctx.getCursor()
          const position = (cursor: { x: number; y: number }) => ({ row: cursor.y + 1, col: cursor.x + 1 })
          return tabClearResult(
            {
              oldFirst: position(oldFirst),
              oldSecond: position(oldSecond),
              oldThird: position(oldThird),
              after: position(after),
            },
            cols,
            "parser-state",
          )
        } finally {
          restoreDefaultTabs(ctx.feed, cols)
        }
      },
      async (ctx) => {
        if (!validSize(ctx.cols, 34)) {
          return {
            pass: false,
            observation: {
              outcome: "inconclusive",
              reason: "insufficient-evidence",
              evidence: "none",
              note: "Tab fixture needs at least 34 columns",
            },
          }
        }
        try {
          installTabFixture(ctx.write)
          ctx.write("\x1b[1;25H\x1bH\x1b[1;1H")
          ctx.write("\t")
          const oldFirst = await ctx.queryCursorPosition()
          ctx.write("\t")
          const oldSecond = await ctx.queryCursorPosition()
          ctx.write("\t")
          const oldThird = await ctx.queryCursorPosition()
          ctx.write("\x1b[3g\x1b[1;1H\t")
          const after = await ctx.queryCursorPosition()
          return tabClearResult({ oldFirst, oldSecond, oldThird, after }, ctx.cols, "behavior")
        } finally {
          restoreDefaultTabs(ctx.write, ctx.cols)
        }
      },
      "behavior",
    ),
    termNeedsGeometry: true,

    termlessObservationEvidence: "parser-state",
  },

  // CHT — cursor horizontal forward tab
  {
    ...probe(
      "text.cht",
      (ctx) => {
        const cols = ctx.cols
        if (!validSize(cols, 21)) {
          return {
            pass: false,
            observation: {
              outcome: "inconclusive",
              reason: "insufficient-evidence",
              evidence: "parser-state",
              note: "Tab fixture needs at least 21 columns",
            },
          }
        }
        try {
          installTabFixture(ctx.feed)
          ctx.feed("\x1b[2I")
          const cursor = ctx.getCursor()
          return tabPositionResult({ row: cursor.y + 1, col: cursor.x + 1 }, 17, "parser-state")
        } finally {
          restoreDefaultTabs(ctx.feed, cols)
        }
      },
      async (ctx) => {
        if (!validSize(ctx.cols, 21)) {
          return {
            pass: false,
            observation: {
              outcome: "inconclusive",
              reason: "insufficient-evidence",
              evidence: "none",
              note: "Tab fixture needs at least 21 columns",
            },
          }
        }
        try {
          installTabFixture(ctx.write)
          ctx.write("\x1b[2I")
          return tabPositionResult(await ctx.queryCursorPosition(), 17, "behavior")
        } finally {
          restoreDefaultTabs(ctx.write, ctx.cols)
        }
      },
      "behavior",
    ),
    termNeedsGeometry: true,

    termlessObservationEvidence: "parser-state",
  },

  // CBT — cursor backward tab
  {
    ...probe(
      "text.cbt",
      (ctx) => {
        const cols = ctx.cols
        if (!validSize(cols, 21)) {
          return {
            pass: false,
            observation: {
              outcome: "inconclusive",
              reason: "insufficient-evidence",
              evidence: "parser-state",
              note: "Tab fixture needs at least 21 columns",
            },
          }
        }
        try {
          installTabFixture(ctx.feed)
          ctx.feed("\x1b[1;21H\x1b[Z")
          const cursor = ctx.getCursor()
          return tabPositionResult({ row: cursor.y + 1, col: cursor.x + 1 }, 17, "parser-state")
        } finally {
          restoreDefaultTabs(ctx.feed, cols)
        }
      },
      async (ctx) => {
        if (!validSize(ctx.cols, 21)) {
          return {
            pass: false,
            observation: {
              outcome: "inconclusive",
              reason: "insufficient-evidence",
              evidence: "none",
              note: "Tab fixture needs at least 21 columns",
            },
          }
        }
        try {
          installTabFixture(ctx.write)
          ctx.write("\x1b[1;21H\x1b[Z")
          return tabPositionResult(await ctx.queryCursorPosition(), 17, "behavior")
        } finally {
          restoreDefaultTabs(ctx.write, ctx.cols)
        }
      },
      "behavior",
    ),
    termNeedsGeometry: true,

    termlessObservationEvidence: "parser-state",
  },

  {
    ...probe(
      "text.wide.emoji-flags",
      (ctx) => emojiWidthResult(ctx, { sample: "\u{1F1FA}\u{1F1F8}", maxColumns: 4 }),
      async (ctx) => {
        const refusal = tooSmall(ctx, 1, 4)
        if (refusal) return refusal
        const ascii = await ctx.measureRenderedWidth("AA")
        const width = await ctx.measureRenderedWidth("\u{1F1FA}\u{1F1F8}")
        if (ascii !== 2 || width === null) {
          return {
            pass: false,
            response: JSON.stringify({ ascii, width }),
            observation: {
              outcome: "inconclusive",
              reason: "insufficient-evidence",
              evidence: "query",
              note: "ASCII width control or flag width was unavailable",
            },
          }
        }
        const pass = width === 2
        return {
          pass,
          response: JSON.stringify({ ascii, width }),
          observation: { outcome: pass ? "supported" : "unsupported", evidence: "query" },
          assertions: [
            {
              kind: pass ? "positive" : "negative",
              expected: "Flag sample occupies two columns after ASCII calibration",
              observed: JSON.stringify({ ascii, width }),
            },
          ],
        }
      },
    ),
    termNeedsGeometry: true,
  },

  {
    ...probe(
      "text.wide.emoji-vs16",
      (ctx) => emojiWidthResult(ctx, { sample: "\u263A\uFE0F", maxColumns: 2 }),
      async (ctx) => {
        const refusal = tooSmall(ctx, 1, 3)
        if (refusal) return refusal
        const ascii = await ctx.measureRenderedWidth("AA")
        const width = await ctx.measureRenderedWidth("\u263A\uFE0F")
        if (ascii !== 2 || width === null) {
          return {
            pass: false,
            response: JSON.stringify({ ascii, width }),
            observation: {
              outcome: "inconclusive",
              reason: "insufficient-evidence",
              evidence: "query",
              note: "ASCII width control or VS16 width was unavailable",
            },
          }
        }
        const pass = width === 2
        return {
          pass,
          response: JSON.stringify({ ascii, width }),
          observation: { outcome: pass ? "supported" : "unsupported", evidence: "query" },
          assertions: [
            {
              kind: pass ? "positive" : "negative",
              expected: "VS16 sample occupies two columns after ASCII calibration",
              observed: JSON.stringify({ ascii, width }),
            },
          ],
        }
      },
    ),
    termNeedsGeometry: true,
  },

  {
    ...probe(
      "text.wide.emoji-zwj",
      (ctx) => emojiWidthResult(ctx, { sample: "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}", maxColumns: 6 }),
      async (ctx) => {
        const refusal = tooSmall(ctx, 1, 4)
        if (refusal) return refusal
        const ascii = await ctx.measureRenderedWidth("AA")
        const width = await ctx.measureRenderedWidth("\u{1F468}\u200D\u{1F469}\u200D\u{1F467}")
        if (ascii !== 2 || width === null) {
          return {
            pass: false,
            response: JSON.stringify({ ascii, width }),
            observation: {
              outcome: "inconclusive",
              reason: "insufficient-evidence",
              evidence: "query",
              note: "ASCII width control or ZWJ width was unavailable",
            },
          }
        }
        const pass = width === 2
        return {
          pass,
          response: JSON.stringify({ ascii, width }),
          observation: { outcome: pass ? "supported" : "unsupported", evidence: "query" },
          assertions: [
            {
              kind: pass ? "positive" : "negative",
              expected: "ZWJ sample occupies two columns after ASCII calibration",
              observed: JSON.stringify({ ascii, width }),
            },
          ],
        }
      },
    ),
    termNeedsGeometry: true,
  },
]
