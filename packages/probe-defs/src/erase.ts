import type { ProbeDefinition, ProbeResult, TermlessContext } from "./types.ts"
import { probe, isBlank, parserStateResult, unmeasuredCellResult, selectiveEraseResult } from "./helpers.ts"

type ErasedCell = string | null

function rowCells(ctx: TermlessContext, row: number): ErasedCell[] {
  return Array.from({ length: 5 }, (_, col) => {
    const char: unknown = ctx.getCell(row, col).char
    return typeof char === "string" ? char : null
  })
}

/** Record the entire small grid fixture, including cells that must survive the erase. */
function eraseRowResult(
  ctx: TermlessContext,
  setup: string,
  sequence: string,
  expected: readonly (string | "blank")[],
  adjacentRow = false,
  expectedCursorX?: number,
): ProbeResult {
  const rows = ctx.getScrollback().screenLines
  if (!Number.isSafeInteger(ctx.cols) || ctx.cols < 6 || !Number.isSafeInteger(rows) || rows < (adjacentRow ? 2 : 1)) {
    return parserStateResult(
      null,
      "Complete erase row fixture",
      { cols: ctx.cols, rows },
      "Measured geometry cannot fit the erase fixture",
    )
  }
  ctx.feed(setup)
  const before = rowCells(ctx, 0)
  const neighborBefore = adjacentRow ? rowCells(ctx, 1) : undefined
  const cursorBefore = expectedCursorX === undefined ? undefined : ctx.getCursor()
  ctx.feed(sequence)
  const after = rowCells(ctx, 0)
  const neighborAfter = adjacentRow ? rowCells(ctx, 1) : undefined
  const response = JSON.stringify({
    before,
    ...(cursorBefore && { cursorBefore: { x: cursorBefore.x, y: cursorBefore.y } }),
    after,
    ...(adjacentRow && { neighborBefore, neighborAfter }),
  })
  const fixtureReady =
    before.join("") === "ABCDE" &&
    (!adjacentRow || neighborBefore?.join("") === "KEEP!") &&
    (expectedCursorX === undefined || (cursorBefore?.x === expectedCursorX && cursorBefore?.y === 0))
  const measured = [...after, ...(neighborAfter ?? [])]
  if (!fixtureReady || measured.some((char) => char === null)) {
    return {
      pass: false,
      response,
      note: "Erase fixture, cursor setup, or cell metadata unavailable",
      observation: { outcome: "inconclusive", reason: "insufficient-evidence", evidence: "parser-state" },
    }
  }
  const exact = expected.every((char, col) => (char === "blank" ? isBlank(after[col] ?? "\0") : after[col] === char))
  const neighborPreserved = !adjacentRow || neighborAfter?.join("") === "KEEP!"
  const supported = exact && neighborPreserved
  return {
    pass: supported,
    response,
    observation: { outcome: supported ? "supported" : "unsupported", evidence: "parser-state" },
    assertions: [
      {
        kind: supported ? "positive" : "negative",
        expected: `row 0 ${expected.join(",")}${adjacentRow ? "; row 1 KEEP!" : ""}${expectedCursorX === undefined ? "" : `; cursor before ${expectedCursorX},0`}`,
        observed: response,
      },
    ],
  }
}

/** ED0/1/2 must change the requested cells while preserving the opposite side. */
function eraseScreenResult(
  ctx: TermlessContext,
  sequence: string,
  expected: readonly [string, string, string],
): ProbeResult {
  const initialScrollback = ctx.getScrollback()
  const lines = initialScrollback.screenLines
  if (!Number.isSafeInteger(lines) || lines < 3 || !Number.isSafeInteger(ctx.cols) || ctx.cols < 6) {
    return {
      pass: false,
      response: JSON.stringify({ initialScrollback }),
      observation: {
        outcome: "inconclusive",
        reason: "insufficient-evidence",
        evidence: "parser-state",
        note: "Screen fixture needs at least three measured rows and six columns",
      },
    }
  }
  const middle = Math.floor(lines / 2)
  const rows = [0, middle, lines - 1] as const
  ctx.feed(`\x1b[1;1HAAAAA\x1b[${middle + 1};1HBBBBB\x1b[${lines};1HCCCCC\x1b[${middle + 1};3H`)
  const before = rows.map((row) => rowCells(ctx, row))
  const cursorBefore = ctx.getCursor()
  const scrollbackBefore = ctx.getScrollback()
  ctx.feed(sequence)
  const after = rows.map((row) => rowCells(ctx, row))
  const cursorAfter = ctx.getCursor()
  const scrollbackAfter = ctx.getScrollback()
  const response = JSON.stringify({
    rows,
    before,
    cursorBefore: { x: cursorBefore.x, y: cursorBefore.y },
    scrollbackBefore,
    after,
    cursorAfter: { x: cursorAfter.x, y: cursorAfter.y },
    scrollbackAfter,
  })
  const fixtureReady =
    before.every((row, i) => row.join("") === ["AAAAA", "BBBBB", "CCCCC"][i]) &&
    cursorBefore.x === 2 &&
    cursorBefore.y === middle &&
    Number.isInteger(scrollbackBefore.totalLines) &&
    scrollbackBefore.totalLines >= lines &&
    !after.some((row) => row.some((char) => char === null))
  if (!fixtureReady) {
    return {
      pass: false,
      response,
      observation: {
        outcome: "inconclusive",
        reason: "insufficient-evidence",
        evidence: "parser-state",
        note: "Screen fixture, cursor setup, or cell readback unavailable",
      },
    }
  }
  const cellsMatch = expected.every((expectedRow, row) =>
    [...expectedRow].every((expectedChar, col) => {
      const actual = after[row]?.[col]
      return expectedChar === " " ? isBlank(actual ?? "\0") : actual === expectedChar
    }),
  )
  const preservedCursor = cursorAfter.x === cursorBefore.x && cursorAfter.y === cursorBefore.y
  // ED0/1/2 specify visible cells; some terminals also move old rows into scrollback.
  const supported = cellsMatch && preservedCursor
  return {
    pass: supported,
    response,
    observation: { outcome: supported ? "supported" : "unsupported", evidence: "parser-state" },
    assertions: [
      {
        kind: supported ? "positive" : "negative",
        expected: `rows ${rows.join(",")}: ${expected.join("/")}; cursor preserved`,
        observed: response,
      },
    ],
  }
}

export const eraseProbes: ProbeDefinition[] = [
  {
    ...probe(
      "erase.line.right",
      (ctx) => eraseRowResult(ctx, "ABCDE\x1b[3G", "\x1b[K", ["A", "B", "blank", "blank", "blank"], false, 2),
      async (ctx) => {
        if (!Number.isSafeInteger(ctx.rows) || !Number.isSafeInteger(ctx.cols) || ctx.rows < 1 || ctx.cols < 6) {
          return {
            pass: false,
            observation: {
              outcome: "inconclusive",
              reason: "insufficient-evidence",
              evidence: "none",
              note: `Erase fixture needs at least 1x6, measured ${ctx.rows}x${ctx.cols}`,
            },
          }
        }
        ctx.write("\x1b[1;1H\x1b[2K") // Clear line
        ctx.write("ABCDE")
        ctx.write("\x1b[1;3H") // Move to col 3
        ctx.write("\x1b[0K") // EL 0 — erase to right
        const pos = await ctx.queryCursorPosition()
        return unmeasuredCellResult(pos, "erased cells or scrollback")
      },
    ),
    termNeedsGeometry: true,

    termlessObservationEvidence: "parser-state",
  },

  {
    ...probe(
      "erase.line.left",
      (ctx) => eraseRowResult(ctx, "ABCDE\x1b[3G", "\x1b[1K", ["blank", "blank", "blank", "D", "E"], false, 2),
      async (ctx) => {
        if (!Number.isSafeInteger(ctx.rows) || !Number.isSafeInteger(ctx.cols) || ctx.rows < 1 || ctx.cols < 6) {
          return {
            pass: false,
            observation: {
              outcome: "inconclusive",
              reason: "insufficient-evidence",
              evidence: "none",
              note: `Erase fixture needs at least 1x6, measured ${ctx.rows}x${ctx.cols}`,
            },
          }
        }
        ctx.write("\x1b[1;1H\x1b[2K")
        ctx.write("ABCDE")
        ctx.write("\x1b[1;3H") // Move to col 3
        ctx.write("\x1b[1K") // EL 1 — erase to left
        const pos = await ctx.queryCursorPosition()
        return unmeasuredCellResult(pos, "erased cells or scrollback")
      },
    ),
    termNeedsGeometry: true,

    termlessObservationEvidence: "parser-state",
  },

  {
    ...probe(
      "erase.line.all",
      (ctx) =>
        eraseRowResult(ctx, "ABCDE\r\nKEEP!\x1b[1;3H", "\x1b[2K", ["blank", "blank", "blank", "blank", "blank"], true),
      async (ctx) => {
        if (!Number.isSafeInteger(ctx.rows) || !Number.isSafeInteger(ctx.cols) || ctx.rows < 1 || ctx.cols < 6) {
          return {
            pass: false,
            observation: {
              outcome: "inconclusive",
              reason: "insufficient-evidence",
              evidence: "none",
              note: `Erase fixture needs at least 1x6, measured ${ctx.rows}x${ctx.cols}`,
            },
          }
        }
        ctx.write("\x1b[1;1H\x1b[2K")
        ctx.write("ABCDE")
        ctx.write("\x1b[1;3H") // Move to col 3
        ctx.write("\x1b[2K") // EL 2 — erase entire line
        const pos = await ctx.queryCursorPosition()
        return unmeasuredCellResult(pos, "erased cells or scrollback")
      },
    ),
    termNeedsGeometry: true,

    termlessObservationEvidence: "parser-state",
  },

  {
    ...probe(
      "erase.screen.below",
      (ctx) => eraseScreenResult(ctx, "\x1b[0J", ["AAAAA", "BB   ", "     "]),
      async (ctx) => {
        if (!Number.isSafeInteger(ctx.rows) || !Number.isSafeInteger(ctx.cols) || ctx.rows < 5 || ctx.cols < 5) {
          return {
            pass: false,
            observation: {
              outcome: "inconclusive",
              reason: "insufficient-evidence",
              evidence: "none",
              note: `Erase fixture needs at least 5x5, measured ${ctx.rows}x${ctx.cols}`,
            },
          }
        }
        ctx.write("\x1b[5;5H") // Move to known position
        ctx.write("\x1b[0J") // ED 0 — erase below
        const pos = await ctx.queryCursorPosition()
        return unmeasuredCellResult(pos, "erased cells or scrollback")
      },
    ),
    termNeedsGeometry: true,

    termlessObservationEvidence: "parser-state",
  },

  {
    ...probe(
      "erase.screen.above",
      (ctx) => eraseScreenResult(ctx, "\x1b[1J", ["     ", "   BB", "CCCCC"]),
      async (ctx) => {
        if (!Number.isSafeInteger(ctx.rows) || !Number.isSafeInteger(ctx.cols) || ctx.rows < 5 || ctx.cols < 5) {
          return {
            pass: false,
            observation: {
              outcome: "inconclusive",
              reason: "insufficient-evidence",
              evidence: "none",
              note: `Erase fixture needs at least 5x5, measured ${ctx.rows}x${ctx.cols}`,
            },
          }
        }
        ctx.write("\x1b[5;5H") // Move to known position
        ctx.write("\x1b[1J") // ED 1 — erase above
        const pos = await ctx.queryCursorPosition()
        return unmeasuredCellResult(pos, "erased cells or scrollback")
      },
    ),
    termNeedsGeometry: true,

    termlessObservationEvidence: "parser-state",
  },

  {
    ...probe(
      "erase.screen.all",
      (ctx) => eraseScreenResult(ctx, "\x1b[2J", ["     ", "     ", "     "]),
      async (ctx) => {
        if (!Number.isSafeInteger(ctx.rows) || !Number.isSafeInteger(ctx.cols) || ctx.rows < 5 || ctx.cols < 5) {
          return {
            pass: false,
            observation: {
              outcome: "inconclusive",
              reason: "insufficient-evidence",
              evidence: "none",
              note: `Erase fixture needs at least 5x5, measured ${ctx.rows}x${ctx.cols}`,
            },
          }
        }
        ctx.write("\x1b[5;5H") // Move to known position
        ctx.write("\x1b[2J") // ED 2 — erase entire screen
        const pos = await ctx.queryCursorPosition()
        return unmeasuredCellResult(pos, "erased cells or scrollback")
      },
    ),
    termNeedsGeometry: true,

    termlessObservationEvidence: "parser-state",
  },

  {
    ...probe(
      "erase.screen.scrollback",
      (ctx) => {
        const expected = "ED3 removes measured scrollback while keeping screen geometry"
        const initial = ctx.getScrollback()
        const rows = initial.screenLines
        if (!Number.isSafeInteger(rows) || rows < 1 || rows > 1000) {
          return parserStateResult(null, expected, { initial }, "Need a measured screen size for history setup")
        }
        ctx.feed("\r\n".repeat(rows + 2))
        const before = ctx.getScrollback()
        if (!Number.isSafeInteger(before.totalLines) || before.totalLines <= rows || before.screenLines !== rows) {
          return parserStateResult(null, expected, { initial, before }, "No measured scrollback to erase")
        }
        ctx.feed("\x1b[3J")
        const after = ctx.getScrollback()
        const measured =
          Number.isSafeInteger(after.totalLines) && after.totalLines >= rows && after.screenLines === rows
        return parserStateResult(
          measured ? after.totalLines === rows : null,
          expected,
          { before, after },
          measured ? undefined : "Scrollback readback or geometry changed unexpectedly",
        )
      },
      async (ctx) => {
        if (!Number.isSafeInteger(ctx.rows) || !Number.isSafeInteger(ctx.cols) || ctx.rows < 5 || ctx.cols < 5) {
          return {
            pass: false,
            observation: {
              outcome: "inconclusive",
              reason: "insufficient-evidence",
              evidence: "none",
              note: `Erase fixture needs at least 5x5, measured ${ctx.rows}x${ctx.cols}`,
            },
          }
        }
        ctx.write("\x1b[5;5H") // Move to known position
        ctx.write("\x1b[3J") // ED 3 — erase scrollback
        const pos = await ctx.queryCursorPosition()
        return unmeasuredCellResult(pos, "erased cells or scrollback")
      },
    ),
    termNeedsGeometry: true,
  },

  {
    ...probe(
      "erase.character",
      (ctx) => eraseRowResult(ctx, "ABCDE\x1b[1G", "\x1b[3X", ["blank", "blank", "blank", "D", "E"], false, 0),
      async (ctx) => {
        if (!Number.isSafeInteger(ctx.rows) || !Number.isSafeInteger(ctx.cols) || ctx.rows < 1 || ctx.cols < 6) {
          return {
            pass: false,
            observation: {
              outcome: "inconclusive",
              reason: "insufficient-evidence",
              evidence: "none",
              note: `Erase fixture needs at least 1x6, measured ${ctx.rows}x${ctx.cols}`,
            },
          }
        }
        ctx.write("\x1b[1;1H\x1b[2K")
        ctx.write("ABCD")
        ctx.write("\x1b[1;2H") // Move to col 2
        ctx.write("\x1b[2X") // ECH 2
        const pos = await ctx.queryCursorPosition()
        return unmeasuredCellResult(pos, "erased cells or scrollback")
      },
    ),
    termNeedsGeometry: true,

    termlessObservationEvidence: "parser-state",
  },

  {
    ...probe(
      "erase.selective",
      (ctx) => selectiveEraseResult(ctx, "\x1b[?2J", false),
      async (ctx) => {
        if (!Number.isSafeInteger(ctx.rows) || !Number.isSafeInteger(ctx.cols) || ctx.rows < 1 || ctx.cols < 6) {
          return {
            pass: false,
            observation: {
              outcome: "inconclusive",
              reason: "insufficient-evidence",
              evidence: "none",
              note: `Erase fixture needs at least 1x6, measured ${ctx.rows}x${ctx.cols}`,
            },
          }
        }
        ctx.write("\x1b[1;1H\x1b[2K")
        ctx.write("ABCDE")
        ctx.write("\x1b[?2J") // DECSED
        const pos = await ctx.queryCursorPosition()
        return unmeasuredCellResult(pos, "erased cells or scrollback")
      },
    ),
    termNeedsGeometry: true,
  },

  // EL with background color — erased cells should inherit current bg
  {
    ...probe(
      "erase.el-with-attrs",
      (ctx) => {
        const expected = "EL erases X while preserving its measured non-default background"
        try {
          ctx.feed("\x1b[42m\x1b[1;1HXXXXX\x1b[1;1H")
          const before = ctx.getCell(0, 0)
          if (before.char !== "X" || before.bg == null) {
            return parserStateResult(null, expected, { before }, "Colored X setup was not measured")
          }
          ctx.feed("\x1b[K")
          const after = ctx.getCell(0, 0)
          const measured = typeof after.char === "string" && after.bg != null
          return parserStateResult(
            measured
              ? isBlank(after.char) &&
                  after.bg?.r === before.bg.r &&
                  after.bg?.g === before.bg.g &&
                  after.bg?.b === before.bg.b
              : null,
            expected,
            { before, after },
            measured ? undefined : "Erased cell background metadata unavailable",
          )
        } finally {
          ctx.feed("\x1b[0m")
        }
      },
      async (ctx) => {
        if (!Number.isSafeInteger(ctx.rows) || !Number.isSafeInteger(ctx.cols) || ctx.rows < 1 || ctx.cols < 6) {
          return {
            pass: false,
            observation: {
              outcome: "inconclusive",
              reason: "insufficient-evidence",
              evidence: "none",
              note: `Erase fixture needs at least 1x6, measured ${ctx.rows}x${ctx.cols}`,
            },
          }
        }
        ctx.write("\x1b[1;1H\x1b[2K")
        try {
          ctx.write("\x1b[42m") // green bg
          ctx.write("XXXXX")
          ctx.write("\x1b[1;1H")
          ctx.write("\x1b[K") // EL 0
          const pos = await ctx.queryCursorPosition()
          return unmeasuredCellResult(pos, "erased cells or scrollback")
        } finally {
          ctx.write("\x1b[0m")
        }
      },
    ),
    termNeedsGeometry: true,
  },

  // ED0 preserves rows preceding the cursor, including above a scrolling region.
  {
    ...probe(
      "erase.ed-scroll-region",
      (ctx) => {
        const expected = "ED0 erases measured cells below the cursor and preserves the preceding row"
        const rows = ctx.getScrollback().screenLines
        if (!Number.isSafeInteger(rows) || rows < 10 || !Number.isSafeInteger(ctx.cols) || ctx.cols < 10) {
          return parserStateResult(null, expected, { rows, cols: ctx.cols }, "Need a measured 10x10 fixture")
        }
        try {
          ctx.feed("\x1b[1;1HKEEP!\x1b[3;1HERASE\x1b[3;10r\x1b[3;1H")
          const before = { control: rowCells(ctx, 0), target: rowCells(ctx, 2), cursor: ctx.getCursor() }
          if (
            before.control.join("") !== "KEEP!" ||
            before.target.join("") !== "ERASE" ||
            before.cursor.x !== 0 ||
            before.cursor.y !== 2
          ) {
            return parserStateResult(null, expected, { before }, "Erase region seed or cursor setup failed")
          }
          ctx.feed("\x1b[J")
          const after = { control: rowCells(ctx, 0), target: rowCells(ctx, 2) }
          const valid = after.control.join("") === "KEEP!" && after.target.every((char) => char !== null)
          return parserStateResult(
            valid ? after.target.every((char) => char !== null && isBlank(char)) : null,
            expected,
            { before, after },
            valid ? undefined : "Preceding row or cell metadata was not preserved",
          )
        } finally {
          ctx.feed("\x1b[r")
        }
      },
      async (ctx) => {
        if (!Number.isSafeInteger(ctx.rows) || !Number.isSafeInteger(ctx.cols) || ctx.rows < 10 || ctx.cols < 10) {
          return {
            pass: false,
            observation: {
              outcome: "inconclusive",
              reason: "insufficient-evidence",
              evidence: "none",
              note: `Erase fixture needs at least 10x10, measured ${ctx.rows}x${ctx.cols}`,
            },
          }
        }
        ctx.write("\x1b[2J\x1b[H") // clear
        ctx.write("KEEP_THIS\r\n")
        for (let i = 1; i <= 5; i++) ctx.write(`row${i}\r\n`)
        try {
          ctx.write("\x1b[3;10r") // scroll region rows 3-10
          ctx.write("\x1b[3;1H") // inside region
          ctx.write("\x1b[J") // ED 0
          const pos = await ctx.queryCursorPosition()
          return unmeasuredCellResult(pos, "erased cells or scrollback")
        } finally {
          ctx.write("\x1b[r") // Restore the owned fixture to full-screen margins.
        }
      },
    ),
    termNeedsGeometry: true,
  },
]
