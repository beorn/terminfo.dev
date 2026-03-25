import type { ProbeDefinition } from "./types.ts"
import { probe } from "./helpers.ts"

export const scrollbackProbes: ProbeDefinition[] = [
  probe(
    "scrollback.accumulate",
    (ctx) => {
      for (let i = 0; i < 30; i++) ctx.feed(`line ${i}\r\n`)
      return { pass: ctx.getScrollback().totalLines > 24 }
    },
    async (ctx) => {
      const sizeMatch = await ctx.queryWithSentinel("\x1b[18t", /\x1b\[8;(\d+);(\d+)t/)
      const rows = sizeMatch ? parseInt(sizeMatch[1]!, 10) : 24
      ctx.write("\x1b[2J\x1b[H") // clear + home
      const lineCount = rows + 10
      for (let i = 0; i < lineCount; i++) {
        ctx.write(`line-${i}\n`)
      }
      const pos = await ctx.queryCursorPosition()
      if (!pos) return { pass: false, note: "No cursor response" }
      return {
        pass: pos.row <= rows,
        note: pos.row <= rows ? undefined : `cursor at row ${pos.row}, expected <= ${rows}`,
      }
    },
  ),

  probe(
    "scrollback.total-lines",
    (ctx) => {
      for (let i = 0; i < 30; i++) ctx.feed(`line ${i}\r\n`)
      return { pass: ctx.getScrollback().totalLines >= 30 }
    },
    async (ctx) => {
      ctx.write("\x1b[2J\x1b[H") // clear
      for (let i = 0; i < 30; i++) ctx.write(`total-${i}\n`)
      ctx.write("\x1b[5;1H") // move to row 5
      const pos = await ctx.queryCursorPosition()
      if (!pos) return { pass: false, note: "No cursor response" }
      return { pass: true, note: "Content written to scrollback" }
    },
  ),

  probe(
    "scrollback.scroll-up",
    (ctx) => {
      ctx.feed("TOP\r\n")
      for (let i = 0; i < 23; i++) ctx.feed("line\r\n")
      ctx.feed("\x1b[S")
      return { pass: ctx.getCell(0, 0).char !== "T" }
    },
    async (ctx) => {
      ctx.write("\x1b[5;5H") // Move to row 5, col 5
      ctx.write("\x1b[1S") // SU 1
      const pos = await ctx.queryCursorPosition()
      if (!pos) return { pass: false, note: "No cursor response after SU" }
      return {
        pass: pos.row === 5 && pos.col === 5,
        note: pos.row === 5 && pos.col === 5 ? undefined : `cursor at ${pos.row};${pos.col}, expected 5;5`,
      }
    },
  ),

  probe(
    "scrollback.reverse-index",
    (ctx) => {
      ctx.feed("A\r\nB\r\nC")
      ctx.feed("\x1b[H\x1bM")
      const c = ctx.getCell(0, 0).char
      return { pass: c === "" || c === " " }
    },
    async (ctx) => {
      ctx.write("\x1b[1;5H") // row 1, col 5
      ctx.write("\x1bM") // RI — reverse index
      const pos = await ctx.queryCursorPosition()
      if (!pos) return { pass: false, note: "No cursor response after RI" }
      return {
        pass: pos.row === 1 && pos.col === 5,
        note: pos.row === 1 && pos.col === 5 ? undefined : `got ${pos.row};${pos.col}, expected 1;5`,
      }
    },
  ),

  probe(
    "scrollback.scroll-down",
    (ctx) => {
      ctx.feed("LINE1\r\nLINE2\r\nLINE3")
      ctx.feed("\x1b[T")
      const c = ctx.getCell(0, 0).char
      return { pass: c === "" || c === " " }
    },
    async (ctx) => {
      ctx.write("\x1b[5;5H") // Move to row 5, col 5
      ctx.write("\x1b[1T") // SD 1
      const pos = await ctx.queryCursorPosition()
      if (!pos) return { pass: false, note: "No cursor response after SD" }
      return {
        pass: pos.row === 5 && pos.col === 5,
        note: pos.row === 5 && pos.col === 5 ? undefined : `cursor at ${pos.row};${pos.col}, expected 5;5`,
      }
    },
  ),

  probe(
    "scrollback.set-region",
    (ctx) => {
      ctx.feed("\x1b[5;10r")
      const cursor = ctx.getCursor()
      ctx.feed("\x1b[r") // reset
      return { pass: cursor.x === 0 && cursor.y === 0 }
    },
    async (ctx) => {
      ctx.write("\x1b[5;10r") // Set scroll region rows 5-10
      ctx.write("\x1b[r") // Reset scroll region
      const pos = await ctx.queryCursorPosition()
      if (!pos) return { pass: false, note: "No cursor response after DECSTBM" }
      return { pass: true }
    },
  ),

  probe(
    "scrollback.alt-screen",
    (ctx) => {
      ctx.feed("NORMAL")
      ctx.feed("\x1b[?1049h")
      return { pass: ctx.getMode("altScreen") === true }
    },
    async (ctx) => {
      ctx.write("\x1b[2J\x1b[H")
      ctx.write("MAIN_SCREEN_MARKER")
      const pos1 = await ctx.queryCursorPosition()
      if (!pos1) return { pass: false, note: "No cursor response" }
      // Enter alt screen
      ctx.write("\x1b[?1049h")
      ctx.write("\x1b[2J\x1b[H")
      ctx.write("ALT_SCREEN")
      // Exit alt screen
      ctx.write("\x1b[?1049l")
      const pos2 = await ctx.queryCursorPosition()
      if (!pos2) return { pass: false, note: "No cursor response after alt screen exit" }
      return {
        pass: pos2.row === pos1.row && pos2.col === pos1.col,
        note:
          pos2.row === pos1.row && pos2.col === pos1.col
            ? undefined
            : `cursor at ${pos2.row};${pos2.col}, expected ${pos1.row};${pos1.col}`,
      }
    },
  ),
]
