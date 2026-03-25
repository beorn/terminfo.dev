import type { ProbeDefinition } from "./types.ts"
import { probe } from "./helpers.ts"

export const unicodeProbes: ProbeDefinition[] = [
  probe(
    "unicode.east-asian-ambiguous",
    (ctx) => {
      ctx.feed("●X")
      const c1 = ctx.getCell(0, 1)
      const c2 = ctx.getCell(0, 2)
      return { pass: c1.char === "X" || c2.char === "X" }
    },
    async (ctx) => {
      const width = await ctx.measureRenderedWidth("●")
      if (width === null) return { pass: false, note: "Cannot measure width" }
      return {
        pass: width === 1 || width === 2,
        note: `width=${width} (ambiguous chars vary by terminal/locale)`,
        response: String(width),
      }
    },
  ),

  probe(
    "unicode.grapheme-cursor",
    (ctx) => {
      ctx.feed("\u{1F468}\u200D\u{1F469}\u200D\u{1F467}X")
      return { pass: ctx.getText().includes("X") }
    },
    async (ctx) => {
      const width = await ctx.measureRenderedWidth("\u{1F468}\u200D\u{1F469}\u200D\u{1F467}")
      if (width === null) return { pass: false, note: "Cannot measure width" }
      return {
        pass: width === 2,
        note: width === 2 ? undefined : `width=${width}, expected 2`,
      }
    },
  ),

  probe(
    "unicode.wrap-boundary",
    (ctx) => {
      ctx.feed("A".repeat(79) + "\u4e2d")
      return { pass: ctx.getCell(1, 0).char === "\u4e2d" }
    },
    async (ctx) => {
      const cols = ctx.cols
      ctx.write("\x1b[1;1H\x1b[2J")
      ctx.write("A".repeat(cols - 1))
      ctx.write("\u4e2d") // CJK char (2 cols wide)
      const pos = await ctx.queryCursorPosition()
      if (!pos) return { pass: false, note: "No cursor response" }
      return {
        pass: pos.row === 2,
        note: pos.row === 2 ? undefined : `cursor at row ${pos.row}, expected 2 (wide char should wrap)`,
      }
    },
  ),

  probe(
    "unicode.tab-stops",
    (ctx) => {
      ctx.feed("A\tB")
      return { pass: ctx.getCell(0, 8).char === "B" }
    },
    async (ctx) => {
      ctx.write("\x1b[1;1H\x1b[2K")
      ctx.write("A\tB")
      const pos = await ctx.queryCursorPosition()
      if (!pos) return { pass: false, note: "No cursor response" }
      return {
        pass: pos.col === 10,
        note: pos.col === 10 ? undefined : `cursor at col ${pos.col}, expected 10 (A + tab to 9 + B)`,
      }
    },
  ),
]
