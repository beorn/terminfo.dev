import type { ObservationEvidence, ProbeDefinition, ProbeResult, TermContext } from "./types.ts"
import { probe } from "./helpers.ts"

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
  const pass = after.row === 1 && after.col === 33
  const staleStop = after.row === 1 && [9, 17, 25].includes(after.col)
  return {
    pass,
    response,
    observation: {
      outcome: pass ? "supported" : staleStop ? "unsupported" : "inconclusive",
      ...(pass || staleStop ? {} : { reason: "insufficient-evidence" as const }),
      evidence,
    },
    ...(pass || staleStop
      ? {
          assertions: [
            {
              kind: pass ? ("positive" as const) : ("negative" as const),
              expected: "After clearing old stops at columns 9, 17 and 25, tab reaches new stop at column 33",
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

export const textProbes: ProbeDefinition[] = [
  {
    ...probe(
      "text.basic",
      (ctx) => {
        ctx.feed("Hello")
        return { pass: ctx.getText().includes("Hello") }
      },
      async (ctx) => {
        const refusal = tooSmall(ctx, 1, 6)
        if (refusal) return refusal
        ctx.write("\x1b[1;1H\x1b[2K") // clear line, move to 1;1
        ctx.write("Hello")
        const pos = await ctx.queryCursorPosition()
        if (!pos) return { pass: false, note: "No cursor response" }
        return {
          pass: pos.col === 6,
          note: pos.col === 6 ? undefined : `cursor at col ${pos.col}, expected 6`,
        }
      },
    ),
    termNeedsGeometry: true,
  },

  {
    ...probe(
      "text.newline",
      (ctx) => {
        ctx.feed("A\r\nB")
        return { pass: ctx.getCell(0, 0).char === "A" && ctx.getCell(1, 0).char === "B" }
      },
      async (ctx) => {
        const refusal = tooSmall(ctx, 4, 5)
        if (refusal) return refusal
        ctx.write("\x1b[3;5H") // move to row 3, col 5
        ctx.write("\n") // LF
        const pos = await ctx.queryCursorPosition()
        if (!pos) return { pass: false, note: "No cursor response" }
        return {
          pass: pos.row === 4,
          note: pos.row === 4 ? undefined : `cursor at row ${pos.row}, expected 4`,
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
        ctx.feed("X".repeat(ctx.cols + 1))
        return { pass: ctx.getCell(1, 0).char === "X" }
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
        ctx.write("\x1b[1;1H\x1b[2K")
        const line = "W".repeat(cols) + "X"
        ctx.write(line)
        const pos = await ctx.queryCursorPosition()
        if (!pos) return { pass: false, note: "No cursor response" }
        return {
          pass: pos.row === 2 && pos.col === 2,
          note: pos.row === 2 && pos.col === 2 ? undefined : `cursor at ${pos.row};${pos.col}, expected 2;2`,
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
          return { pass: ctx.getCell(0, 8).char === "X" }
        } finally {
          restoreDefaultTabs(ctx.feed, ctx.cols)
        }
      },
      async (ctx) => {
        const refusal = tooSmall(ctx, 1, 9)
        if (refusal) return refusal
        try {
          ctx.write("\x1b[3g\x1b[1;9H\x1bH\x1b[1;1H")
          ctx.write("\t")
          const pos = await ctx.queryCursorPosition()
          if (!pos) return { pass: false, note: "No cursor response" }
          return {
            pass: pos.col === 9,
            note: pos.col === 9 ? undefined : `cursor at col ${pos.col}, expected 9`,
          }
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
        ctx.feed("\u{1f389}")
        return { pass: ctx.getCell(0, 0).wide === true }
      },
      async (ctx) => {
        const refusal = tooSmall(ctx, 1, 3)
        if (refusal) return refusal
        const width = await ctx.measureRenderedWidth("\u{1F600}")
        if (width === null) return { pass: false, note: "Cannot measure width" }
        return {
          pass: width === 2,
          note: width === 2 ? undefined : `width=${width}, expected 2`,
        }
      },
    ),
    termNeedsGeometry: true,
  },

  {
    ...probe(
      "text.wide.cjk",
      (ctx) => {
        ctx.feed("\u4e2d")
        return { pass: ctx.getCell(0, 0).wide === true }
      },
      async (ctx) => {
        const refusal = tooSmall(ctx, 1, 3)
        if (refusal) return refusal
        const width = await ctx.measureRenderedWidth("\u4e2d")
        if (width === null) return { pass: false, note: "Cannot measure width" }
        return {
          pass: width === 2,
          note: width === 2 ? undefined : `width=${width}, expected 2`,
        }
      },
    ),
    termNeedsGeometry: true,
  },

  {
    ...probe(
      "text.overwrite",
      (ctx) => {
        ctx.feed("AB\x1b[1GC")
        return { pass: ctx.getCell(0, 0).char === "C" }
      },
      async (ctx) => {
        const refusal = tooSmall(ctx, 1, 3)
        if (refusal) return refusal
        ctx.write("\x1b[1;1H\x1b[2K")
        ctx.write("AB") // cursor at col 3
        ctx.write("\x1b[1;2H") // move back to col 2
        ctx.write("X") // overwrite B
        const pos = await ctx.queryCursorPosition()
        if (!pos) return { pass: false, note: "No cursor response" }
        return {
          pass: pos.col === 3,
          note: pos.col === 3 ? undefined : `cursor at col ${pos.col}, expected 3`,
        }
      },
    ),
    termNeedsGeometry: true,
  },

  {
    ...probe(
      "text.cr",
      (ctx) => {
        ctx.feed("AB\rC")
        return { pass: ctx.getCell(0, 0).char === "C" && ctx.getCell(0, 1).char === "B" }
      },
      async (ctx) => {
        const refusal = tooSmall(ctx, 1, 3)
        if (refusal) return refusal
        ctx.write("\x1b[1;1H\x1b[2K")
        ctx.write("AB")
        ctx.write("\r") // CR
        const pos = await ctx.queryCursorPosition()
        if (!pos) return { pass: false, note: "No cursor response" }
        return {
          pass: pos.col === 1,
          note: pos.col === 1 ? undefined : `cursor at col ${pos.col}, expected 1`,
        }
      },
    ),
    termNeedsGeometry: true,
  },

  {
    ...probe(
      "text.backspace",
      (ctx) => {
        ctx.feed("AB\x08C")
        return { pass: ctx.getCell(0, 0).char === "A" && ctx.getCell(0, 1).char === "C" }
      },
      async (ctx) => {
        const refusal = tooSmall(ctx, 1, 5)
        if (refusal) return refusal
        ctx.write("\x1b[1;5H") // Move to col 5
        ctx.write("\b") // BS
        const pos = await ctx.queryCursorPosition()
        if (!pos) return { pass: false, note: "No cursor response" }
        return {
          pass: pos.col === 4,
          note: pos.col === 4 ? undefined : `cursor at col ${pos.col}, expected 4`,
        }
      },
    ),
    termNeedsGeometry: true,
  },

  {
    ...probe(
      "text.index",
      (ctx) => {
        ctx.feed("A\x1bD")
        return { pass: ctx.getCursor().y === 1 }
      },
      async (ctx) => {
        const refusal = tooSmall(ctx, 4, 5)
        if (refusal) return refusal
        ctx.write("\x1b[3;5H") // move to row 3, col 5
        ctx.write("\x1bD") // IND
        const pos = await ctx.queryCursorPosition()
        if (!pos) return { pass: false, note: "No cursor response" }
        return {
          pass: pos.row === 4 && pos.col === 5,
          note: pos.row === 4 && pos.col === 5 ? undefined : `got ${pos.row};${pos.col}, expected 4;5`,
        }
      },
    ),
    termNeedsGeometry: true,
  },

  {
    ...probe(
      "text.next-line",
      (ctx) => {
        ctx.feed("ABC\x1bE")
        return { pass: ctx.getCursor().y === 1 && ctx.getCursor().x === 0 }
      },
      async (ctx) => {
        const refusal = tooSmall(ctx, 4, 5)
        if (refusal) return refusal
        ctx.write("\x1b[3;5H") // move to row 3, col 5
        ctx.write("\x1bE") // NEL
        const pos = await ctx.queryCursorPosition()
        if (!pos) return { pass: false, note: "No cursor response" }
        return {
          pass: pos.row === 4 && pos.col === 1,
          note: pos.row === 4 && pos.col === 1 ? undefined : `got ${pos.row};${pos.col}, expected 4;1`,
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
          ctx.feed("\x1b[H") // Back to top
          ctx.feed("\x1bM") // Reverse index at top — should scroll region down
          // MARKER should have moved from row 0 to row 1
          const cell = ctx.getCell(1, 0)
          return {
            pass: cell.char === "M",
            note: cell.char === "M" ? undefined : `row 1 char='${cell.char}', expected 'M' (MARKER shifted down)`,
          }
        } finally {
          ctx.feed("\x1b[r") // reset scroll region
        }
      },
      async (ctx) => {
        const refusal = tooSmall(ctx, 10, 1)
        if (refusal) return refusal
        try {
          ctx.write("\x1b[3;10r") // scroll region rows 3-10
          ctx.write("\x1b[3;1H") // move to row 3 (top of region)
          ctx.write("\x1bM") // RI — reverse index at top of region
          const pos = await ctx.queryCursorPosition()
          if (!pos) return { pass: false, note: "No cursor response after RI in region" }
          return {
            pass: pos.row === 3,
            note: pos.row === 3 ? undefined : `cursor at row ${pos.row}, expected 3`,
          }
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
        ctx.feed("e\u0301X")
        return { pass: ctx.getCell(0, 1).char === "X" }
      },
      async (ctx) => {
        const refusal = tooSmall(ctx, 1, 3)
        if (refusal) return refusal
        const width = await ctx.measureRenderedWidth("e\u0301")
        if (width === null) return { pass: false, note: "Cannot measure width" }
        return {
          pass: width === 1,
          note: width === 1 ? undefined : `width=${width}, expected 1`,
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
          return { pass: ctx.getCursor().x === 5 }
        } finally {
          restoreDefaultTabs(ctx.feed, ctx.cols)
        }
      },
      async (ctx) => {
        if (!validSize(ctx.cols, 6)) {
          return {
            pass: false,
            observation: {
              outcome: "inconclusive",
              reason: "insufficient-evidence",
              evidence: "none",
              note: "HTS fixture needs at least 6 columns",
            },
          }
        }
        try {
          ctx.write("\x1b[3g\x1b[1;6H\x1bH\x1b[1;1H\t")
          const pos = await ctx.queryCursorPosition()
          return { pass: pos?.col === 6, ...(pos ? {} : { note: "No cursor response" }) }
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
          ctx.feed("\x1b[3g\x1b[1;33H\x1bH\x1b[1;1H\t")
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
          ctx.write("\x1b[3g\x1b[1;33H\x1bH\x1b[1;1H\t")
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
      (ctx) => {
        ctx.feed("\u{1F1FA}\u{1F1F8}X")
        return { pass: ctx.getCell(0, 0).wide === true }
      },
      async (ctx) => {
        const refusal = tooSmall(ctx, 1, 4)
        if (refusal) return refusal
        const width = await ctx.measureRenderedWidth("\u{1F1FA}\u{1F1F8}")
        if (width === null) return { pass: false, note: "Cannot measure width" }
        return {
          pass: width === 2,
          note: width === 2 ? undefined : `width=${width}, expected 2`,
        }
      },
    ),
    termNeedsGeometry: true,
  },

  {
    ...probe(
      "text.wide.emoji-vs16",
      (ctx) => {
        ctx.feed("\u263A\uFE0FX")
        return { pass: ctx.getCell(0, 0).wide === true }
      },
      async (ctx) => {
        const refusal = tooSmall(ctx, 1, 3)
        if (refusal) return refusal
        const width = await ctx.measureRenderedWidth("\u263A\uFE0F")
        if (width === null) return { pass: false, note: "Cannot measure width" }
        return {
          pass: width === 2,
          note: width === 2 ? undefined : `width=${width}, expected 2`,
        }
      },
    ),
    termNeedsGeometry: true,
  },

  {
    ...probe(
      "text.wide.emoji-zwj",
      (ctx) => {
        ctx.feed("\u{1F468}\u200D\u{1F469}\u200D\u{1F467}X")
        return { pass: ctx.getText().includes("X") }
      },
      async (ctx) => {
        const refusal = tooSmall(ctx, 1, 4)
        if (refusal) return refusal
        const width = await ctx.measureRenderedWidth("\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}")
        if (width === null) return { pass: false, note: "Cannot measure width" }
        return {
          pass: width === 2,
          note: width === 2 ? undefined : `width=${width}, expected 2`,
        }
      },
    ),
    termNeedsGeometry: true,
  },
]
