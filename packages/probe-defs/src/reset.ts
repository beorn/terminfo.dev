import type { ProbeDefinition } from "./types.ts"
import { probe } from "./helpers.ts"

export const resetProbes: ProbeDefinition[] = [
  probe(
    "reset.sgr",
    (ctx) => {
      ctx.feed("\x1b[1;3;7mX\x1b[0mY")
      const cell = ctx.getCell(0, 1)
      return { pass: cell.bold === false && cell.italic === false && !cell.underline }
    },
    async (ctx) => {
      ctx.write("\x1b[1;1H\x1b[2K")
      ctx.write("\x1b[1m") // bold
      ctx.write("\x1b[0m") // reset
      ctx.write("X")
      const pos = await ctx.queryCursorPosition()
      if (!pos) return { pass: false, note: "No cursor response" }
      return {
        pass: pos.col === 2,
        note: pos.col === 2 ? undefined : `cursor at col ${pos.col}, expected 2`,
      }
    },
  ),

  probe(
    "reset.ris",
    (ctx) => {
      ctx.feed("Hello World")
      ctx.feed("\x1bc")
      return { pass: ctx.getCursor().x === 0 && ctx.getCursor().y === 0 }
    },
    async (ctx) => {
      ctx.write("\x1b[5;5H") // Move somewhere away from 1;1
      ctx.write("\x1bc") // RIS — full reset
      const pos = await ctx.queryCursorPosition()
      if (!pos) return { pass: false, note: "No cursor response after RIS" }
      return {
        pass: pos.row === 1 && pos.col === 1,
        note: pos.row === 1 && pos.col === 1 ? undefined : `cursor at ${pos.row};${pos.col}, expected 1;1`,
      }
    },
  ),

  probe(
    "reset.soft",
    (ctx) => {
      ctx.feed("\x1b[?1h") // enable application cursor
      ctx.feed("Hello")
      ctx.feed("\x1b[!p")
      return { pass: ctx.getMode("applicationCursor") === false }
    },
    async (ctx) => {
      ctx.write("\x1b[5;5H") // Move to known position
      ctx.write("\x1b[!p") // DECSTR — soft reset
      const pos = await ctx.queryCursorPosition()
      if (!pos) return { pass: false, note: "No cursor response after DECSTR" }
      return { pass: true }
    },
  ),

  // DECALN — screen alignment test (fill screen with 'E')
  probe(
    "reset.decaln",
    (ctx) => {
      ctx.feed("\x1b#8") // DECALN — fill screen with 'E'
      const cell = ctx.getCell(0, 0)
      return {
        pass: cell.char === "E",
        note: cell.char === "E" ? undefined : `cell (0,0) char='${cell.char}', expected 'E'`,
      }
    },
    async (ctx) => {
      ctx.write("\x1b#8") // DECALN
      const pos = await ctx.queryCursorPosition()
      if (!pos) return { pass: false, note: "No cursor response after DECALN" }
      // DECALN should reset cursor to home position (1,1)
      return {
        pass: pos.row === 1 && pos.col === 1,
        note:
          pos.row === 1 && pos.col === 1
            ? undefined
            : `cursor at ${pos.row};${pos.col}, expected 1;1`,
      }
    },
  ),

  probe(
    "reset.method",
    (ctx) => {
      ctx.feed("Hello World")
      ctx.reset()
      return { pass: ctx.getCursor().x === 0 && ctx.getCursor().y === 0 }
    },
    async (ctx) => {
      ctx.write("\x1b[5;5H") // Move away from 1;1
      ctx.write("\x1b[!p") // DECSTR
      const pos = await ctx.queryCursorPosition()
      if (!pos) return { pass: false, note: "No cursor response after DECSTR" }
      return { pass: true, note: `cursor at ${pos.row};${pos.col} after DECSTR` }
    },
  ),
]
