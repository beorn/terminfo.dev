import type { ProbeDefinition } from "./types.ts"
import { probe } from "./helpers.ts"

export const textProbes: ProbeDefinition[] = [
  probe(
    "text.basic",
    (ctx) => {
      ctx.feed("Hello")
      return { pass: ctx.getText().includes("Hello") }
    },
    async (ctx) => {
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

  probe(
    "text.newline",
    (ctx) => {
      ctx.feed("A\r\nB")
      return { pass: ctx.getCell(0, 0).char === "A" && ctx.getCell(1, 0).char === "B" }
    },
    async (ctx) => {
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

  probe(
    "text.wrap",
    (ctx) => {
      ctx.feed("X".repeat(85))
      return { pass: ctx.getCell(1, 0).char === "X" }
    },
    async (ctx) => {
      const cols = ctx.cols
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

  probe(
    "text.tab",
    (ctx) => {
      ctx.feed("\tX")
      return { pass: ctx.getCell(0, 8).char === "X" }
    },
    async (ctx) => {
      ctx.write("\x1b[1;1H\x1b[2K") // Clear line, move to col 1
      ctx.write("\t") // Tab
      const pos = await ctx.queryCursorPosition()
      if (!pos) return { pass: false, note: "No cursor response" }
      return {
        pass: pos.col === 9,
        note: pos.col === 9 ? undefined : `cursor at col ${pos.col}, expected 9`,
      }
    },
  ),

  probe(
    "text.wide.emoji",
    (ctx) => {
      ctx.feed("\u{1f389}")
      return { pass: ctx.getCell(0, 0).wide === true }
    },
    async (ctx) => {
      const width = await ctx.measureRenderedWidth("\u{1F600}")
      if (width === null) return { pass: false, note: "Cannot measure width" }
      return {
        pass: width === 2,
        note: width === 2 ? undefined : `width=${width}, expected 2`,
      }
    },
  ),

  probe(
    "text.wide.cjk",
    (ctx) => {
      ctx.feed("\u4e2d")
      return { pass: ctx.getCell(0, 0).wide === true }
    },
    async (ctx) => {
      const width = await ctx.measureRenderedWidth("\u4e2d")
      if (width === null) return { pass: false, note: "Cannot measure width" }
      return {
        pass: width === 2,
        note: width === 2 ? undefined : `width=${width}, expected 2`,
      }
    },
  ),

  probe(
    "text.overwrite",
    (ctx) => {
      ctx.feed("AB\x1b[1GC")
      return { pass: ctx.getCell(0, 0).char === "C" }
    },
    async (ctx) => {
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

  probe(
    "text.cr",
    (ctx) => {
      ctx.feed("AB\rC")
      return { pass: ctx.getCell(0, 0).char === "C" && ctx.getCell(0, 1).char === "B" }
    },
    async (ctx) => {
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

  probe(
    "text.backspace",
    (ctx) => {
      ctx.feed("AB\x08C")
      return { pass: ctx.getCell(0, 0).char === "A" && ctx.getCell(0, 1).char === "C" }
    },
    async (ctx) => {
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

  probe(
    "text.index",
    (ctx) => {
      ctx.feed("A\x1bD")
      return { pass: ctx.getCursor().y === 1 }
    },
    async (ctx) => {
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

  probe(
    "text.next-line",
    (ctx) => {
      ctx.feed("ABC\x1bE")
      return { pass: ctx.getCursor().y === 1 && ctx.getCursor().x === 0 }
    },
    async (ctx) => {
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

  probe(
    "text.reverse-index-scroll",
    (ctx) => {
      ctx.feed("\x1b[1;5r") // Set scroll region to lines 1-5
      ctx.feed("\x1b[H") // Move to top (row 0)
      ctx.feed("MARKER")
      ctx.feed("\x1b[H") // Back to top
      ctx.feed("\x1bM") // Reverse index at top — should scroll region down
      // MARKER should have moved from row 0 to row 1
      const cell = ctx.getCell(1, 0)
      ctx.feed("\x1b[r") // reset scroll region
      return {
        pass: cell.char === "M",
        note: cell.char === "M" ? undefined : `row 1 char='${cell.char}', expected 'M' (MARKER shifted down)`,
      }
    },
    async (ctx) => {
      ctx.write("\x1b[3;10r") // scroll region rows 3-10
      ctx.write("\x1b[3;1H") // move to row 3 (top of region)
      ctx.write("\x1bM") // RI — reverse index at top of region
      const pos = await ctx.queryCursorPosition()
      ctx.write("\x1b[r") // reset scroll region
      if (!pos) return { pass: false, note: "No cursor response after RI in region" }
      return {
        pass: pos.row === 3,
        note: pos.row === 3 ? undefined : `cursor at row ${pos.row}, expected 3`,
      }
    },
  ),

  probe(
    "text.combining",
    (ctx) => {
      ctx.feed("e\u0301X")
      return { pass: ctx.getCell(0, 1).char === "X" }
    },
    async (ctx) => {
      const width = await ctx.measureRenderedWidth("e\u0301")
      if (width === null) return { pass: false, note: "Cannot measure width" }
      return {
        pass: width === 1,
        note: width === 1 ? undefined : `width=${width}, expected 1`,
      }
    },
  ),

  probe(
    "text.wide.emoji-flags",
    (ctx) => {
      ctx.feed("\u{1F1FA}\u{1F1F8}X")
      return { pass: ctx.getCell(0, 0).wide === true }
    },
    async (ctx) => {
      const width = await ctx.measureRenderedWidth("\u{1F1FA}\u{1F1F8}")
      if (width === null) return { pass: false, note: "Cannot measure width" }
      return {
        pass: width === 2,
        note: width === 2 ? undefined : `width=${width}, expected 2`,
      }
    },
  ),

  probe(
    "text.wide.emoji-vs16",
    (ctx) => {
      ctx.feed("\u263A\uFE0FX")
      return { pass: ctx.getCell(0, 0).wide === true }
    },
    async (ctx) => {
      const width = await ctx.measureRenderedWidth("\u263A\uFE0F")
      if (width === null) return { pass: false, note: "Cannot measure width" }
      return {
        pass: width === 2,
        note: width === 2 ? undefined : `width=${width}, expected 2`,
      }
    },
  ),

  probe(
    "text.wide.emoji-zwj",
    (ctx) => {
      ctx.feed("\u{1F468}\u200D\u{1F469}\u200D\u{1F467}X")
      return { pass: ctx.getText().includes("X") }
    },
    async (ctx) => {
      const width = await ctx.measureRenderedWidth("\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}")
      if (width === null) return { pass: false, note: "Cannot measure width" }
      return {
        pass: width === 2,
        note: width === 2 ? undefined : `width=${width}, expected 2`,
      }
    },
  ),
]
