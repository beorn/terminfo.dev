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
]
