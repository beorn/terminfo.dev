import type { ProbeDefinition, ProbeResult, TermlessContext } from "./types.ts"
import { probe, isBlank } from "./helpers.ts"

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

function appErasePositionResult(position: { row: number; col: number } | null): ProbeResult {
  return {
    pass: false,
    note: position
      ? `CPR ${position.row};${position.col} shows responsiveness, not erased cells`
      : "No cursor response after erase",
    observation: {
      outcome: "inconclusive",
      reason: position ? "insufficient-evidence" : "no-response",
      evidence: "query",
    },
  }
}

export const eraseProbes: ProbeDefinition[] = [
  probe(
    "erase.line.right",
    (ctx) => eraseRowResult(ctx, "ABCDE\x1b[3G", "\x1b[K", ["A", "B", "blank", "blank", "blank"], false, 2),
    async (ctx) => {
      ctx.write("\x1b[1;1H\x1b[2K") // Clear line
      ctx.write("ABCDE")
      ctx.write("\x1b[1;3H") // Move to col 3
      ctx.write("\x1b[0K") // EL 0 — erase to right
      const pos = await ctx.queryCursorPosition()
      return appErasePositionResult(pos)
    },
  ),

  probe(
    "erase.line.left",
    (ctx) => eraseRowResult(ctx, "ABCDE\x1b[3G", "\x1b[1K", ["blank", "blank", "blank", "D", "E"], false, 2),
    async (ctx) => {
      ctx.write("\x1b[1;1H\x1b[2K")
      ctx.write("ABCDE")
      ctx.write("\x1b[1;3H") // Move to col 3
      ctx.write("\x1b[1K") // EL 1 — erase to left
      const pos = await ctx.queryCursorPosition()
      return appErasePositionResult(pos)
    },
  ),

  probe(
    "erase.line.all",
    (ctx) =>
      eraseRowResult(ctx, "ABCDE\r\nKEEP!\x1b[1;3H", "\x1b[2K", ["blank", "blank", "blank", "blank", "blank"], true),
    async (ctx) => {
      ctx.write("\x1b[1;1H\x1b[2K")
      ctx.write("ABCDE")
      ctx.write("\x1b[1;3H") // Move to col 3
      ctx.write("\x1b[2K") // EL 2 — erase entire line
      const pos = await ctx.queryCursorPosition()
      return appErasePositionResult(pos)
    },
  ),

  probe(
    "erase.screen.below",
    (ctx) => {
      ctx.feed("AAA\r\nBBB\r\nCCC\x1b[H\x1b[J")
      return { pass: !ctx.getText().includes("BBB") }
    },
    async (ctx) => {
      ctx.write("\x1b[5;5H") // Move to known position
      ctx.write("\x1b[0J") // ED 0 — erase below
      const pos = await ctx.queryCursorPosition()
      if (!pos) return { pass: false, note: "No cursor response after ED 0" }
      return {
        pass: pos.row === 5 && pos.col === 5,
        note: pos.row === 5 && pos.col === 5 ? undefined : `cursor at ${pos.row};${pos.col}, expected 5;5`,
      }
    },
  ),

  probe(
    "erase.screen.above",
    (ctx) => {
      ctx.feed("AAA\r\nBBB\r\nCCC\x1b[3;2H\x1b[1J")
      return { pass: isBlank(ctx.getCell(0, 0).char) }
    },
    async (ctx) => {
      ctx.write("\x1b[5;5H") // Move to known position
      ctx.write("\x1b[1J") // ED 1 — erase above
      const pos = await ctx.queryCursorPosition()
      if (!pos) return { pass: false, note: "No cursor response after ED 1" }
      return {
        pass: pos.row === 5 && pos.col === 5,
        note: pos.row === 5 && pos.col === 5 ? undefined : `cursor at ${pos.row};${pos.col}, expected 5;5`,
      }
    },
  ),

  probe(
    "erase.screen.all",
    (ctx) => {
      ctx.feed("AAA\r\nBBB\r\nCCC\x1b[2J")
      return { pass: ctx.getText().trim() === "" }
    },
    async (ctx) => {
      ctx.write("\x1b[5;5H") // Move to known position
      ctx.write("\x1b[2J") // ED 2 — erase entire screen
      const pos = await ctx.queryCursorPosition()
      if (!pos) return { pass: false, note: "No cursor response after ED 2" }
      return {
        pass: pos.row === 5 && pos.col === 5,
        note: pos.row === 5 && pos.col === 5 ? undefined : `cursor at ${pos.row};${pos.col}, expected 5;5`,
      }
    },
  ),

  probe(
    "erase.screen.scrollback",
    (ctx) => {
      for (let i = 0; i < 30; i++) ctx.feed(`line ${i}\r\n`)
      ctx.feed("\x1b[3J")
      const scroll = ctx.getScrollback()
      return { pass: scroll.totalLines <= scroll.screenLines }
    },
    async (ctx) => {
      ctx.write("\x1b[5;5H") // Move to known position
      ctx.write("\x1b[3J") // ED 3 — erase scrollback
      const pos = await ctx.queryCursorPosition()
      if (!pos) return { pass: false, note: "No cursor response after ED 3" }
      return {
        pass: pos.row === 5 && pos.col === 5,
        note: pos.row === 5 && pos.col === 5 ? undefined : `cursor at ${pos.row};${pos.col}, expected 5;5`,
      }
    },
  ),

  probe(
    "erase.character",
    (ctx) => eraseRowResult(ctx, "ABCDE\x1b[1G", "\x1b[3X", ["blank", "blank", "blank", "D", "E"], false, 0),
    async (ctx) => {
      ctx.write("\x1b[1;1H\x1b[2K")
      ctx.write("ABCD")
      ctx.write("\x1b[1;2H") // Move to col 2
      ctx.write("\x1b[2X") // ECH 2
      const pos = await ctx.queryCursorPosition()
      return appErasePositionResult(pos)
    },
  ),

  probe(
    "erase.selective",
    (ctx) => {
      ctx.feed("ABCDE")
      ctx.feed("\x1b[H") // back to top-left
      ctx.feed("\x1b[?2J") // DECSED — selective erase display
      const cell = ctx.getCell(0, 0)
      return {
        pass: isBlank(cell.char),
        note: isBlank(cell.char) ? undefined : `cell='${cell.char}', expected empty`,
      }
    },
    async (ctx) => {
      ctx.write("\x1b[1;1H\x1b[2K")
      ctx.write("ABCDE")
      ctx.write("\x1b[?2J") // DECSED
      const pos = await ctx.queryCursorPosition()
      if (!pos) return { pass: false, note: "No cursor response after DECSED" }
      return { pass: true }
    },
  ),

  // EL with background color — erased cells should inherit current bg
  probe(
    "erase.el-with-attrs",
    (ctx) => {
      ctx.feed("\x1b[42m") // set green background
      ctx.feed("XXXXX")
      ctx.feed("\x1b[1G") // move to col 0
      ctx.feed("\x1b[K") // EL 0 — erase to right
      const cell = ctx.getCell(0, 0)
      // Erased cells should have the green background color
      const hasBg = cell.bg !== null && cell.bg.g > 100
      ctx.feed("\x1b[0m") // reset
      return {
        pass: hasBg,
        note: hasBg ? undefined : `bg=${JSON.stringify(cell.bg)}, expected green`,
      }
    },
    async (ctx) => {
      ctx.write("\x1b[1;1H\x1b[2K")
      ctx.write("\x1b[42m") // green bg
      ctx.write("XXXXX")
      ctx.write("\x1b[1;1H")
      ctx.write("\x1b[K") // EL 0
      ctx.write("\x1b[0m")
      const pos = await ctx.queryCursorPosition()
      if (!pos) return { pass: false, note: "No cursor response" }
      return {
        pass: pos.col === 1,
        note: pos.col === 1 ? undefined : `cursor at col ${pos.col}, expected 1`,
      }
    },
  ),

  // ED inside scroll region should not affect lines outside the region
  probe(
    "erase.ed-scroll-region",
    (ctx) => {
      // Write text on row 0 (outside future scroll region)
      ctx.feed("KEEP_THIS\r\n")
      // Write text on rows 1-5
      for (let i = 1; i <= 5; i++) ctx.feed(`row${i}\r\n`)
      // Set scroll region to rows 3-10 (1-based)
      ctx.feed("\x1b[3;10r")
      // Move cursor inside scroll region and erase below
      ctx.feed("\x1b[3;1H")
      ctx.feed("\x1b[J") // ED 0 — erase below
      // Row 0 should still have "KEEP_THIS"
      const cell = ctx.getCell(0, 0)
      const pass = cell.char === "K"
      ctx.feed("\x1b[r") // reset scroll region
      return {
        pass,
        note: pass ? undefined : `row 0 char='${cell.char}', expected 'K'`,
      }
    },
    async (ctx) => {
      ctx.write("\x1b[2J\x1b[H") // clear
      ctx.write("KEEP_THIS\r\n")
      for (let i = 1; i <= 5; i++) ctx.write(`row${i}\r\n`)
      ctx.write("\x1b[3;10r") // scroll region rows 3-10
      ctx.write("\x1b[3;1H") // inside region
      ctx.write("\x1b[J") // ED 0
      ctx.write("\x1b[r") // reset
      const pos = await ctx.queryCursorPosition()
      if (!pos) return { pass: false, note: "No cursor response" }
      return { pass: true }
    },
  ),
]
