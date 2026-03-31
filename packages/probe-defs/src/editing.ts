import type { ProbeDefinition } from "./types.ts"
import { probe, isBlank } from "./helpers.ts"

export const editingProbes: ProbeDefinition[] = [
  probe(
    "editing.insert-chars",
    (ctx) => {
      ctx.feed("ABCDE\x1b[1G\x1b[2@")
      return {
        pass:
          isBlank(ctx.getCell(0, 0).char) &&
          isBlank(ctx.getCell(0, 1).char) &&
          ctx.getCell(0, 2).char === "A" &&
          ctx.getCell(0, 3).char === "B",
      }
    },
    async (ctx) => {
      ctx.write("\x1b[1;1H\x1b[2K") // Clear line
      ctx.write("ABCD")
      ctx.write("\x1b[1;2H") // Move to col 2
      ctx.write("\x1b[1@") // ICH 1
      const pos = await ctx.queryCursorPosition()
      if (!pos) return { pass: false, note: "No cursor response" }
      return {
        pass: pos.col === 2,
        note: pos.col === 2 ? undefined : `cursor at col ${pos.col}, expected 2`,
      }
    },
  ),

  probe(
    "editing.delete-chars",
    (ctx) => {
      ctx.feed("ABCDE\x1b[1G\x1b[2P")
      return {
        pass: ctx.getCell(0, 0).char === "C" && ctx.getCell(0, 1).char === "D" && ctx.getCell(0, 2).char === "E",
      }
    },
    async (ctx) => {
      ctx.write("\x1b[1;1H\x1b[2K") // Clear line
      ctx.write("ABCD")
      ctx.write("\x1b[1;2H") // Move to col 2
      ctx.write("\x1b[1P") // DCH 1
      const pos = await ctx.queryCursorPosition()
      if (!pos) return { pass: false, note: "No cursor response" }
      return {
        pass: pos.col === 2,
        note: pos.col === 2 ? undefined : `cursor at col ${pos.col}, expected 2`,
      }
    },
  ),

  probe(
    "editing.insert-lines",
    (ctx) => {
      ctx.feed("LINE1\r\nLINE2\r\nLINE3\x1b[2;1H\x1b[1L")
      const r1 = ctx.getCell(1, 0).char
      return { pass: isBlank(r1) && ctx.getCell(2, 0).char === "L" }
    },
    async (ctx) => {
      ctx.write("\x1b[3;5H") // Move to row 3, col 5
      ctx.write("\x1b[1L") // IL 1
      const pos = await ctx.queryCursorPosition()
      if (!pos) return { pass: false, note: "No cursor response" }
      return {
        pass: pos.row === 3,
        note: pos.row === 3 ? undefined : `cursor at row ${pos.row}, expected 3`,
      }
    },
  ),

  probe(
    "editing.delete-lines",
    (ctx) => {
      ctx.feed("LINE1\r\nLINE2\r\nLINE3\x1b[2;1H\x1b[1M")
      return { pass: ctx.getCell(1, 0).char === "L" && ctx.getCell(1, 4).char === "3" }
    },
    async (ctx) => {
      ctx.write("\x1b[3;5H") // Move to row 3, col 5
      ctx.write("\x1b[1M") // DL 1
      const pos = await ctx.queryCursorPosition()
      if (!pos) return { pass: false, note: "No cursor response" }
      return {
        pass: pos.row === 3,
        note: pos.row === 3 ? undefined : `cursor at row ${pos.row}, expected 3`,
      }
    },
  ),

  probe(
    "editing.repeat-char",
    (ctx) => {
      ctx.feed("X\x1b[4b")
      return {
        pass: ctx.getCell(0, 0).char === "X" && ctx.getCell(0, 1).char === "X" && ctx.getCell(0, 4).char === "X",
      }
    },
    async (ctx) => {
      ctx.write("\x1b[1;1H\x1b[2K") // clear line
      ctx.write("X") // write X (cursor at col 2)
      ctx.write("\x1b[4b") // REP 4
      const pos = await ctx.queryCursorPosition()
      if (!pos) return { pass: false, note: "No cursor response" }
      return {
        pass: pos.col === 6,
        note: pos.col === 6 ? undefined : `cursor at col ${pos.col}, expected 6`,
      }
    },
  ),
]
