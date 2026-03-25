import type { ProbeDefinition } from "./types.ts"
import { probe } from "./helpers.ts"

export const charsetsProbes: ProbeDefinition[] = [
  probe(
    "charsets.dec-special",
    (ctx) => {
      ctx.feed("\x1b(0q\x1b(B")
      const cell = ctx.getCell(0, 0)
      return { pass: cell.char !== "q" }
    },
    async (ctx) => {
      ctx.write("\x1b[1;1H\x1b[2K")
      ctx.write("\x1b(0") // Switch to DEC special graphics
      ctx.write("q") // should render as horizontal line
      ctx.write("\x1b(B") // Switch back to ASCII
      const pos = await ctx.queryCursorPosition()
      if (!pos) return { pass: false, note: "No cursor response" }
      return {
        pass: pos.col === 2,
        note: pos.col === 2 ? undefined : `cursor at col ${pos.col}, expected 2`,
      }
    },
  ),

  probe(
    "charsets.utf8",
    (ctx) => {
      ctx.feed("\u00e9")
      const pass1 = ctx.getCell(0, 0).char === "\u00e9"
      ctx.feed("\x1b[1G\u4e16")
      const pass2 = ctx.getCell(0, 0).char === "\u4e16"
      return { pass: pass1 && pass2 }
    },
    async (ctx) => {
      ctx.write("\x1b[1;1H\x1b[2K")
      ctx.write("\u00e9") // e-acute (2-byte UTF-8, 1 column)
      const pos = await ctx.queryCursorPosition()
      if (!pos) return { pass: false, note: "No cursor response" }
      return {
        pass: pos.col === 2,
        note: pos.col === 2 ? undefined : `cursor at col ${pos.col}, expected 2`,
      }
    },
  ),

  // G0/G1 switching via SI/SO — ESC(0 designates G0 as DEC Special, then test switching
  probe(
    "charsets.g0-g1-switching",
    (ctx) => {
      ctx.feed("\x1b(0") // designate G0 = DEC Special Graphics
      ctx.feed("l") // should render as ┌ (top-left corner)
      ctx.feed("\x1b(B") // restore G0 = ASCII
      const cell = ctx.getCell(0, 0)
      return {
        pass: cell.char !== "l",
        note: cell.char !== "l" ? `rendered as '${cell.char}'` : "rendered as literal 'l', expected box-drawing",
      }
    },
    async (ctx) => {
      ctx.write("\x1b[1;1H\x1b[2K")
      ctx.write("\x1b(0") // DEC Special Graphics
      ctx.write("l") // ┌
      ctx.write("\x1b(B") // back to ASCII
      const pos = await ctx.queryCursorPosition()
      if (!pos) return { pass: false, note: "No cursor response" }
      return {
        pass: pos.col === 2,
        note: pos.col === 2 ? undefined : `cursor at col ${pos.col}, expected 2`,
      }
    },
  ),

  // DEC line drawing — full set of box-drawing chars
  probe(
    "charsets.dec-line-drawing",
    (ctx) => {
      ctx.feed("\x1b(0") // DEC Special Graphics
      ctx.feed("jklmqx") // ┘┐┌└─│
      ctx.feed("\x1b(B") // restore ASCII
      // Verify none of the cells contain the literal ASCII chars
      const chars = [
        ctx.getCell(0, 0).char, // j → ┘
        ctx.getCell(0, 1).char, // k → ┐
        ctx.getCell(0, 2).char, // l → ┌
        ctx.getCell(0, 3).char, // m → └
        ctx.getCell(0, 4).char, // q → ─
        ctx.getCell(0, 5).char, // x → │
      ]
      const allMapped = chars.every((c, i) => c !== "jklmqx"[i])
      return {
        pass: allMapped,
        note: allMapped ? `rendered: ${chars.join("")}` : `some chars not mapped: ${chars.join("")}`,
      }
    },
    async (ctx) => {
      ctx.write("\x1b[1;1H\x1b[2K")
      ctx.write("\x1b(0") // DEC Special Graphics
      ctx.write("jklmqx") // box-drawing chars
      ctx.write("\x1b(B") // back to ASCII
      const pos = await ctx.queryCursorPosition()
      if (!pos) return { pass: false, note: "No cursor response" }
      return {
        pass: pos.col === 7,
        note: pos.col === 7 ? undefined : `cursor at col ${pos.col}, expected 7`,
      }
    },
  ),
]
