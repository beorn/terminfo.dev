import type { ProbeDefinition } from "./types.ts"
import { probe, isBlank } from "./helpers.ts"

export const eraseProbes: ProbeDefinition[] = [
  probe(
    "erase.line.right",
    (ctx) => {
      ctx.feed("XXXXX\x1b[1G\x1b[K")
      return { pass: isBlank(ctx.getCell(0, 0).char) }
    },
    async (ctx) => {
      ctx.write("\x1b[1;1H\x1b[2K") // Clear line
      ctx.write("ABCDE")
      ctx.write("\x1b[1;3H") // Move to col 3
      ctx.write("\x1b[0K") // EL 0 — erase to right
      const pos = await ctx.queryCursorPosition()
      if (!pos) return { pass: false, note: "No cursor response" }
      return {
        pass: pos.col === 3,
        note: pos.col === 3 ? undefined : `cursor at col ${pos.col}, expected 3`,
      }
    },
  ),

  probe(
    "erase.line.left",
    (ctx) => {
      ctx.feed("XXXXX\x1b[3G\x1b[1K")
      return { pass: isBlank(ctx.getCell(0, 0).char) }
    },
    async (ctx) => {
      ctx.write("\x1b[1;1H\x1b[2K")
      ctx.write("ABCDE")
      ctx.write("\x1b[1;3H") // Move to col 3
      ctx.write("\x1b[1K") // EL 1 — erase to left
      const pos = await ctx.queryCursorPosition()
      if (!pos) return { pass: false, note: "No cursor response" }
      return {
        pass: pos.col === 3,
        note: pos.col === 3 ? undefined : `cursor at col ${pos.col}, expected 3`,
      }
    },
  ),

  probe(
    "erase.line.all",
    (ctx) => {
      ctx.feed("XXXXX\x1b[2K")
      return { pass: isBlank(ctx.getCell(0, 0).char) }
    },
    async (ctx) => {
      ctx.write("\x1b[1;1H\x1b[2K")
      ctx.write("ABCDE")
      ctx.write("\x1b[1;3H") // Move to col 3
      ctx.write("\x1b[2K") // EL 2 — erase entire line
      const pos = await ctx.queryCursorPosition()
      if (!pos) return { pass: false, note: "No cursor response" }
      return {
        pass: pos.col === 3,
        note: pos.col === 3 ? undefined : `cursor at col ${pos.col}, expected 3`,
      }
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
    (ctx) => {
      ctx.feed("ABCDE\x1b[1G\x1b[3X")
      return {
        pass:
          isBlank(ctx.getCell(0, 0).char) &&
          isBlank(ctx.getCell(0, 1).char) &&
          isBlank(ctx.getCell(0, 2).char) &&
          ctx.getCell(0, 3).char === "D",
      }
    },
    async (ctx) => {
      ctx.write("\x1b[1;1H\x1b[2K")
      ctx.write("ABCD")
      ctx.write("\x1b[1;2H") // Move to col 2
      ctx.write("\x1b[2X") // ECH 2
      const pos = await ctx.queryCursorPosition()
      if (!pos) return { pass: false, note: "No cursor response" }
      return {
        pass: pos.col === 2,
        note: pos.col === 2 ? undefined : `cursor at col ${pos.col}, expected 2`,
      }
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
