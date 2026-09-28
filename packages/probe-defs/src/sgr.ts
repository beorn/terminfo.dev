import type { ProbeDefinition, ProbeResult, TermContext, TermlessContext } from "./types.ts"
import { parserStateResult, sgrProbe, probe } from "./helpers.ts"

const requestedUnderlineColor = { r: 255, g: 0, b: 128 }

function sameRgb(a: { r: number; g: number; b: number }, b: { r: number; g: number; b: number }): boolean {
  return a.r === b.r && a.g === b.g && a.b === b.b
}

function rgbUnderlineApplied(cell: ReturnType<TermlessContext["getCell"]>): boolean | null {
  if (cell.underline === undefined || cell.underlineColor === undefined) return null
  return (
    Boolean(cell.underline) && cell.underlineColor !== null && sameRgb(cell.underlineColor, requestedUnderlineColor)
  )
}

/** A cursor reply proves consumption of the SGR sequence, never the visual attribute. */
async function consumedSgr(ctx: TermContext, sequence: string): Promise<ProbeResult> {
  ctx.write("\x1b[1;1H\x1b[2K")
  ctx.write(sequence + "X\x1b[0m")
  const pos = await ctx.queryCursorPosition()
  if (!pos) {
    return {
      pass: false,
      note: "No cursor response",
      observation: { outcome: "inconclusive", reason: "no-response", evidence: "query" },
    }
  }
  return {
    pass: pos.col === 2,
    note: "Cursor advance does not verify SGR styling",
    response: `${pos.row};${pos.col}`,
    observation: {
      outcome: "inconclusive",
      reason: "insufficient-evidence",
      evidence: "consumed",
      note: "Cursor advance does not verify SGR styling",
    },
  }
}

export const sgrProbes: ProbeDefinition[] = [
  // ── Attributes ──

  sgrProbe("sgr.bold", "\x1b[1m", (cell) => cell.bold === true),

  sgrProbe("sgr.faint", "\x1b[2m", (cell) => cell.dim === true),

  sgrProbe("sgr.italic", "\x1b[3m", (cell) => cell.italic === true),

  sgrProbe("sgr.underline.single", "\x1b[4m", (cell) => !!cell.underline),

  sgrProbe("sgr.underline.double", "\x1b[21m", (cell) => cell.underline === "double"),

  sgrProbe("sgr.underline.curly", "\x1b[4:3m", (cell) => cell.underline === "curly"),

  sgrProbe("sgr.underline.dotted", "\x1b[4:4m", (cell) => cell.underline === "dotted"),

  sgrProbe("sgr.underline.dashed", "\x1b[4:5m", (cell) => cell.underline === "dashed"),

  sgrProbe("sgr.blink", "\x1b[5m", (cell) => cell.blink === true),

  sgrProbe("sgr.inverse", "\x1b[7m", (cell) => cell.inverse === true),

  sgrProbe("sgr.hidden", "\x1b[8m", (cell) => cell.hidden === true),

  sgrProbe("sgr.strikethrough", "\x1b[9m", (cell) => cell.strikethrough === true),

  sgrProbe("sgr.overline", "\x1b[53m", (cell) => (cell.overline === undefined ? null : cell.overline === true)),

  // ── Underline color ──

  sgrProbe("sgr.underline.color", "\x1b[4m\x1b[58;2;255;0;128m", rgbUnderlineApplied),

  // Index values may be theme-specific. Compare two distinct palette controls
  // to their underline colors; one coincidental/default color cannot prove SGR 58.
  probe(
    "sgr.underline-color-indexed",
    (ctx) => {
      ctx.feed("\x1b[4m\x1b[38;5;4m\x1b[58;5;4mX\x1b[38;5;5m\x1b[58;5;5mY")
      const index4 = ctx.getCell(0, 0)
      const index5 = ctx.getCell(0, 1)
      const state = {
        index4: {
          char: index4.char,
          underline: index4.underline as unknown,
          fg: index4.fg,
          underlineColor: index4.underlineColor,
        },
        index5: {
          char: index5.char,
          underline: index5.underline as unknown,
          fg: index5.fg,
          underlineColor: index5.underlineColor,
        },
      }
      const expected = "SGR 58 index 4/5 underline colors equal the distinct SGR 38 index 4/5 foreground colors"
      if (
        index4.char !== "X" ||
        index5.char !== "Y" ||
        index4.underline === undefined ||
        index5.underline === undefined ||
        !index4.fg ||
        !index5.fg ||
        index4.underlineColor === undefined ||
        index5.underlineColor === undefined
      ) {
        return parserStateResult(null, expected, state, "Palette control or underline cell state was not exposed")
      }
      if (sameRgb(index4.fg, index5.fg)) {
        return parserStateResult(null, expected, state, "Palette controls resolve to indistinguishable colors")
      }
      const matches =
        Boolean(index4.underline) &&
        Boolean(index5.underline) &&
        index4.underlineColor !== null &&
        index5.underlineColor !== null &&
        sameRgb(index4.fg, index4.underlineColor) &&
        sameRgb(index5.fg, index5.underlineColor)
      return parserStateResult(matches, expected, state)
    },
    (ctx) => consumedSgr(ctx, "\x1b[4m\x1b[58;5;5m"),
    "consumed",
  ),

  sgrProbe("sgr.underline-color-rgb", "\x1b[4m\x1b[58;2;255;0;128m", rgbUnderlineApplied),

  // SGR 59 — reset underline color. Set a colored underline on cell 0, then SGR 59
  // and write to cell 1. Cell 1 should still be underlined but without an explicit
  // underline color (null or default).
  probe(
    "sgr.underline-color-reset",
    (ctx) => {
      ctx.feed("\x1b[4m\x1b[58;2;255;0;128mX\x1b[59mY")
      const before = ctx.getCell(0, 0)
      const after = ctx.getCell(0, 1)
      const state = { before, after }
      const expected = "X has underline rgb(255,0,128); Y remains underlined with default/null color after SGR 59"
      if (
        before.char !== "X" ||
        after.char !== "Y" ||
        before.underline === undefined ||
        after.underline === undefined ||
        before.underlineColor === undefined ||
        after.underlineColor === undefined
      ) {
        return parserStateResult(null, expected, state, "Before/after underline cell state was not exposed")
      }
      if (!before.underline || !before.underlineColor || !sameRgb(before.underlineColor, requestedUnderlineColor)) {
        return parserStateResult(null, expected, state, "Requested colored underline prerequisite was not observed")
      }
      return parserStateResult(Boolean(after.underline) && after.underlineColor === null, expected, state)
    },
    (ctx) => consumedSgr(ctx, "\x1b[4m\x1b[58;2;255;0;128m\x1b[59m"),
    "consumed",
  ),

  // ── Colors ──

  probe(
    "sgr.fg.standard",
    (ctx) => {
      ctx.feed("\x1b[31mX")
      const fg = ctx.getCell(0, 0).fg
      if (!fg) return { pass: false, note: "fg is null" }
      return { pass: fg.r > 100 }
    },
    async (ctx) => {
      ctx.write("\x1b[1;1H\x1b[2K")
      ctx.write("\x1b[31mX\x1b[0m")
      const pos = await ctx.queryCursorPosition()
      if (!pos) return { pass: false, note: "No cursor response" }
      return {
        pass: pos.col === 2,
        note: pos.col === 2 ? undefined : `cursor at col ${pos.col}, expected 2`,
      }
    },
  ),

  probe(
    "sgr.bg.standard",
    (ctx) => {
      ctx.feed("\x1b[42mX")
      const bg = ctx.getCell(0, 0).bg
      if (!bg) return { pass: false, note: "bg is null" }
      return { pass: bg.g > 100 }
    },
    async (ctx) => {
      ctx.write("\x1b[1;1H\x1b[2K")
      ctx.write("\x1b[41mX\x1b[0m")
      const pos = await ctx.queryCursorPosition()
      if (!pos) return { pass: false, note: "No cursor response" }
      return {
        pass: pos.col === 2,
        note: pos.col === 2 ? undefined : `cursor at col ${pos.col}, expected 2`,
      }
    },
  ),

  probe(
    "sgr.fg.bright",
    (ctx) => {
      ctx.feed("\x1b[91mX")
      const fg = ctx.getCell(0, 0).fg
      if (!fg) return { pass: false, note: "fg is null" }
      return { pass: fg.r > 150 }
    },
    async (ctx) => {
      ctx.write("\x1b[1;1H\x1b[2K")
      ctx.write("\x1b[91mX\x1b[0m")
      const pos = await ctx.queryCursorPosition()
      if (!pos) return { pass: false, note: "No cursor response" }
      return {
        pass: pos.col === 2,
        note: pos.col === 2 ? undefined : `cursor at col ${pos.col}, expected 2`,
      }
    },
  ),

  probe(
    "sgr.bg.bright",
    (ctx) => {
      ctx.feed("\x1b[102mX")
      const bg = ctx.getCell(0, 0).bg
      if (!bg) return { pass: false, note: "bg is null" }
      return { pass: bg.g > 150 }
    },
    async (ctx) => {
      ctx.write("\x1b[1;1H\x1b[2K")
      ctx.write("\x1b[101mX\x1b[0m")
      const pos = await ctx.queryCursorPosition()
      if (!pos) return { pass: false, note: "No cursor response" }
      return {
        pass: pos.col === 2,
        note: pos.col === 2 ? undefined : `cursor at col ${pos.col}, expected 2`,
      }
    },
  ),

  probe(
    "sgr.fg.default",
    (ctx) => {
      ctx.feed("\x1b[31mX\x1b[39mY")
      const before = ctx.getCell(0, 0)
      const after = ctx.getCell(0, 1)
      return { pass: before.char === "X" && Boolean(before.fg) && after.char === "Y" && after.fg === null }
    },
    async (ctx) => {
      ctx.write("\x1b[1;1H\x1b[2K")
      ctx.write("\x1b[39mX\x1b[0m")
      const pos = await ctx.queryCursorPosition()
      if (!pos) return { pass: false, note: "No cursor response" }
      return {
        pass: pos.col === 2,
        note: pos.col === 2 ? undefined : `cursor at col ${pos.col}, expected 2`,
      }
    },
  ),

  probe(
    "sgr.bg.default",
    (ctx) => {
      ctx.feed("\x1b[42mX\x1b[49mY")
      const before = ctx.getCell(0, 0)
      const after = ctx.getCell(0, 1)
      return { pass: before.char === "X" && Boolean(before.bg) && after.char === "Y" && after.bg === null }
    },
    async (ctx) => {
      ctx.write("\x1b[1;1H\x1b[2K")
      ctx.write("\x1b[49mX\x1b[0m")
      const pos = await ctx.queryCursorPosition()
      if (!pos) return { pass: false, note: "No cursor response" }
      return {
        pass: pos.col === 2,
        note: pos.col === 2 ? undefined : `cursor at col ${pos.col}, expected 2`,
      }
    },
  ),

  probe(
    "sgr.fg.256",
    (ctx) => {
      ctx.feed("\x1b[38;5;196mX")
      const fg = ctx.getCell(0, 0).fg
      if (!fg) return { pass: false, note: "fg is null" }
      return { pass: fg.r > 200 }
    },
    async (ctx) => {
      ctx.write("\x1b[1;1H\x1b[2K")
      ctx.write("\x1b[38;5;196mX\x1b[0m")
      const pos = await ctx.queryCursorPosition()
      if (!pos) return { pass: false, note: "No cursor response" }
      return {
        pass: pos.col === 2,
        note: pos.col === 2 ? undefined : `cursor at col ${pos.col}, expected 2`,
      }
    },
  ),

  probe(
    "sgr.bg.256",
    (ctx) => {
      ctx.feed("\x1b[48;5;21mX")
      const bg = ctx.getCell(0, 0).bg
      if (!bg) return { pass: false, note: "bg is null" }
      return { pass: bg.b > 100 }
    },
    async (ctx) => {
      ctx.write("\x1b[1;1H\x1b[2K")
      ctx.write("\x1b[48;5;21mX\x1b[0m")
      const pos = await ctx.queryCursorPosition()
      if (!pos) return { pass: false, note: "No cursor response" }
      return {
        pass: pos.col === 2,
        note: pos.col === 2 ? undefined : `cursor at col ${pos.col}, expected 2`,
      }
    },
  ),

  probe(
    "sgr.fg.truecolor",
    (ctx) => {
      ctx.feed("\x1b[38;2;255;128;0mX")
      const fg = ctx.getCell(0, 0).fg
      if (!fg) return { pass: false, note: "fg is null" }
      return { pass: fg.r === 255 && fg.g === 128 && fg.b === 0 }
    },
    async (ctx) => {
      ctx.write("\x1b[1;1H\x1b[2K")
      ctx.write("\x1b[38;2;255;0;128mX\x1b[0m")
      const pos = await ctx.queryCursorPosition()
      if (!pos) return { pass: false, note: "No cursor response" }
      return {
        pass: pos.col === 2,
        note: pos.col === 2 ? undefined : `cursor at col ${pos.col}, expected 2`,
      }
    },
  ),

  probe(
    "sgr.bg.truecolor",
    (ctx) => {
      ctx.feed("\x1b[48;2;0;255;128mX")
      const bg = ctx.getCell(0, 0).bg
      if (!bg) return { pass: false, note: "bg is null" }
      return { pass: bg.r === 0 && bg.g === 255 && bg.b === 128 }
    },
    async (ctx) => {
      ctx.write("\x1b[1;1H\x1b[2K")
      ctx.write("\x1b[48;2;0;255;64mX\x1b[0m")
      const pos = await ctx.queryCursorPosition()
      if (!pos) return { pass: false, note: "No cursor response" }
      return {
        pass: pos.col === 2,
        note: pos.col === 2 ? undefined : `cursor at col ${pos.col}, expected 2`,
      }
    },
  ),

  // ── Selective resets ──

  probe(
    "sgr.selective-reset.bold",
    (ctx) => {
      ctx.feed("\x1b[1mX\x1b[22mY")
      const before = ctx.getCell(0, 0)
      const after = ctx.getCell(0, 1)
      return {
        pass:
          before.char === "X" &&
          before.bold === true &&
          after.char === "Y" &&
          after.bold === false &&
          after.dim === false,
      }
    },
    async (ctx) => {
      ctx.write("\x1b[1;1H\x1b[2K")
      ctx.write("\x1b[1m\x1b[22mX\x1b[0m")
      const pos = await ctx.queryCursorPosition()
      if (!pos) return { pass: false, note: "No cursor response" }
      return {
        pass: pos.col === 2,
        note: pos.col === 2 ? undefined : `cursor at col ${pos.col}, expected 2`,
      }
    },
  ),

  probe(
    "sgr.selective-reset.underline",
    (ctx) => {
      ctx.feed("\x1b[4mX\x1b[24mY")
      const before = ctx.getCell(0, 0)
      const after = ctx.getCell(0, 1)
      return {
        pass:
          before.char === "X" &&
          Boolean(before.underline) &&
          after.char === "Y" &&
          after.underline !== undefined &&
          !after.underline,
      }
    },
    async (ctx) => {
      ctx.write("\x1b[1;1H\x1b[2K")
      ctx.write("\x1b[4m\x1b[24mX\x1b[0m")
      const pos = await ctx.queryCursorPosition()
      if (!pos) return { pass: false, note: "No cursor response" }
      return {
        pass: pos.col === 2,
        note: pos.col === 2 ? undefined : `cursor at col ${pos.col}, expected 2`,
      }
    },
  ),

  probe(
    "sgr.selective-reset.italic",
    (ctx) => {
      ctx.feed("\x1b[3mX\x1b[23mY")
      const before = ctx.getCell(0, 0)
      const after = ctx.getCell(0, 1)
      return { pass: before.char === "X" && before.italic === true && after.char === "Y" && after.italic === false }
    },
    async (ctx) => {
      ctx.write("\x1b[1;1H\x1b[2K")
      ctx.write("\x1b[3m\x1b[23mX\x1b[0m")
      const pos = await ctx.queryCursorPosition()
      if (!pos) return { pass: false, note: "No cursor response" }
      return {
        pass: pos.col === 2,
        note: pos.col === 2 ? undefined : `cursor at col ${pos.col}, expected 2`,
      }
    },
  ),

  probe(
    "sgr.selective-reset.inverse",
    (ctx) => {
      ctx.feed("\x1b[7mX\x1b[27mY")
      const before = ctx.getCell(0, 0)
      const after = ctx.getCell(0, 1)
      return { pass: before.char === "X" && before.inverse === true && after.char === "Y" && after.inverse === false }
    },
    async (ctx) => {
      ctx.write("\x1b[1;1H\x1b[2K")
      ctx.write("\x1b[7m\x1b[27mX\x1b[0m")
      const pos = await ctx.queryCursorPosition()
      if (!pos) return { pass: false, note: "No cursor response" }
      return {
        pass: pos.col === 2,
        note: pos.col === 2 ? undefined : `cursor at col ${pos.col}, expected 2`,
      }
    },
  ),

  // ── Full SGR reset ──

  probe(
    "sgr.reset",
    (ctx) => {
      ctx.feed("\x1b[1;3;4mX\x1b[0mY")
      const before = ctx.getCell(0, 0)
      const after = ctx.getCell(0, 1)
      return {
        pass:
          before.char === "X" &&
          before.bold === true &&
          before.italic === true &&
          Boolean(before.underline) &&
          after.char === "Y" &&
          after.bold === false &&
          after.italic === false &&
          after.underline !== undefined &&
          !after.underline,
      }
    },
    async (ctx) => {
      ctx.write("\x1b[1;1H\x1b[2K")
      ctx.write("\x1b[1m\x1b[0mX\x1b[0m")
      const pos = await ctx.queryCursorPosition()
      if (!pos) return { pass: false, note: "No cursor response" }
      return {
        pass: pos.col === 2,
        note: pos.col === 2 ? undefined : `cursor at col ${pos.col}, expected 2`,
      }
    },
  ),
]
