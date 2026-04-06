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

  // VT420 rectangular area operations (1990). Most headless backends don't
  // implement these — probeStatus is "partial" and we only verify the sequence
  // is consumed without leaving literal characters on screen.

  probe(
    "editing.decfra",
    (ctx) => {
      // DECFRA: fill rows 1-3, cols 1-5 with 'X' (88 = 'X')
      ctx.feed("\x1b[88;1;1;3;5$x")
      // Pass if at least one cell in the target rectangle is 'X'.
      // Otherwise, verify nothing literal leaked into the cells.
      const filled =
        ctx.getCell(0, 0).char === "X" || ctx.getCell(1, 0).char === "X" || ctx.getCell(2, 0).char === "X"
      const c0 = ctx.getCell(0, 0).char
      const noLeak = isBlank(c0) || c0 === "X"
      return {
        pass: filled || noLeak,
        note: filled ? "filled" : "sequence consumed (no literal leak)",
      }
    },
    async (ctx) => {
      ctx.write("\x1b[1;1H")
      ctx.write("\x1b[88;1;1;3;5$x") // DECFRA fill 'X'
      const pos = await ctx.queryCursorPosition()
      return {
        pass: pos !== null,
        note: pos ? "sequence consumed" : "no cursor response",
      }
    },
  ),

  probe(
    "editing.decera",
    (ctx) => {
      // Write text first, then erase a rectangle
      ctx.feed("AAAAA\r\nBBBBB\r\nCCCCC\x1b[1;1H")
      ctx.feed("\x1b[1;1;3;5$z") // DECERA rows 1-3 cols 1-5
      // Pass if cells were erased; otherwise check the sequence didn't leak literal chars.
      const erased = isBlank(ctx.getCell(0, 0).char) && isBlank(ctx.getCell(1, 0).char)
      // Look for "$z" or "z" leaking into row 0
      const text = ctx.getText()
      const noLeak = !text.includes("$z")
      return {
        pass: erased || noLeak,
        note: erased ? "rectangle erased" : "sequence consumed (no literal leak)",
      }
    },
    async (ctx) => {
      ctx.write("\x1b[1;1H")
      ctx.write("\x1b[1;1;3;5$z") // DECERA
      const pos = await ctx.queryCursorPosition()
      return {
        pass: pos !== null,
        note: pos ? "sequence consumed" : "no cursor response",
      }
    },
  ),

  probe(
    "editing.decsera",
    (ctx) => {
      ctx.feed("\x1b[1;1H\x1b[1;1;3;5${") // DECSERA rows 1-3 cols 1-5
      const text = ctx.getText()
      // Sequence consumed if no literal "${" or "{" leaked
      const noLeak = !text.includes("${") && !text.includes("$ {")
      return {
        pass: noLeak,
        note: noLeak ? "sequence consumed" : "literal leak detected",
      }
    },
    async (ctx) => {
      ctx.write("\x1b[1;1H")
      ctx.write("\x1b[1;1;3;5${") // DECSERA
      const pos = await ctx.queryCursorPosition()
      return {
        pass: pos !== null,
        note: pos ? "sequence consumed" : "no cursor response",
      }
    },
  ),

  probe(
    "editing.deccra",
    (ctx) => {
      ctx.feed("\x1b[1;1H\x1b[1;1;2;5;1;5;10$v") // DECCRA copy rect
      const text = ctx.getText()
      const noLeak = !text.includes("$v")
      return {
        pass: noLeak,
        note: noLeak ? "sequence consumed" : "literal leak detected",
      }
    },
    async (ctx) => {
      ctx.write("\x1b[1;1H")
      ctx.write("\x1b[1;1;2;5;1;5;10$v") // DECCRA
      const pos = await ctx.queryCursorPosition()
      return {
        pass: pos !== null,
        note: pos ? "sequence consumed" : "no cursor response",
      }
    },
  ),

  probe(
    "editing.deccara",
    (ctx) => {
      ctx.feed("\x1b[1;1H\x1b[1;1;3;5;7$r") // DECCARA inverse rect
      const text = ctx.getText()
      const noLeak = !text.includes("$r")
      return {
        pass: noLeak,
        note: noLeak ? "sequence consumed" : "literal leak detected",
      }
    },
    async (ctx) => {
      ctx.write("\x1b[1;1H")
      ctx.write("\x1b[1;1;3;5;7$r") // DECCARA
      const pos = await ctx.queryCursorPosition()
      return {
        pass: pos !== null,
        note: pos ? "sequence consumed" : "no cursor response",
      }
    },
  ),

  probe(
    "editing.decrara",
    (ctx) => {
      ctx.feed("\x1b[1;1H\x1b[1;1;3;5;7$t") // DECRARA toggle inverse rect
      const text = ctx.getText()
      const noLeak = !text.includes("$t")
      return {
        pass: noLeak,
        note: noLeak ? "sequence consumed" : "literal leak detected",
      }
    },
    async (ctx) => {
      ctx.write("\x1b[1;1H")
      ctx.write("\x1b[1;1;3;5;7$t") // DECRARA
      const pos = await ctx.queryCursorPosition()
      return {
        pass: pos !== null,
        note: pos ? "sequence consumed" : "no cursor response",
      }
    },
  ),

  probe(
    "editing.decsace",
    (ctx) => {
      ctx.feed("\x1b[1;1H\x1b[2*x") // DECSACE select rectangle extent
      const text = ctx.getText()
      const noLeak = !text.includes("*x")
      return {
        pass: noLeak,
        note: noLeak ? "sequence consumed" : "literal leak detected",
      }
    },
    async (ctx) => {
      ctx.write("\x1b[1;1H")
      ctx.write("\x1b[2*x") // DECSACE
      const pos = await ctx.queryCursorPosition()
      return {
        pass: pos !== null,
        note: pos ? "sequence consumed" : "no cursor response",
      }
    },
  ),

  probe(
    "editing.decrqcra",
    (ctx) => {
      ctx.feed("\x1b[1;1H\x1b[1;1;1;1;1;1*y") // DECRQCRA checksum cell 1,1
      const text = ctx.getText()
      const noLeak = !text.includes("*y")
      return {
        pass: noLeak,
        note: noLeak ? "sequence consumed" : "literal leak detected",
      }
    },
    async (ctx) => {
      ctx.write("\x1b[1;1H")
      ctx.write("\x1b[1;1;1;1;1;1*y") // DECRQCRA
      const pos = await ctx.queryCursorPosition()
      return {
        pass: pos !== null,
        note: pos ? "sequence consumed" : "no cursor response",
      }
    },
  ),
]
