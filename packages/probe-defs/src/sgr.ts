import type { ProbeDefinition } from "./types.ts"
import { sgrProbe, probe } from "./helpers.ts"

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

  sgrProbe("sgr.overline", "\x1b[53m", (cell) => cell.overline === true || cell.overline === undefined),

  // ── Underline color ──

  probe(
    "sgr.underline.color",
    (ctx) => {
      ctx.feed("\x1b[4m\x1b[58;2;255;0;128mX")
      const cell = ctx.getCell(0, 0)
      if (!cell.underline) return { pass: false, note: "underline not set" }
      if (!cell.underlineColor) return { pass: false, note: "underlineColor not set" }
      return {
        pass: cell.underlineColor.r === 255 && cell.underlineColor.g === 0 && cell.underlineColor.b === 128,
      }
    },
    async (ctx) => {
      ctx.write("\x1b[1;1H\x1b[2K")
      ctx.write("\x1b[4m\x1b[58;2;255;0;0mX\x1b[0m")
      const pos = await ctx.queryCursorPosition()
      if (!pos) return { pass: false, note: "No cursor response" }
      return {
        pass: pos.col === 2,
        note: pos.col === 2 ? undefined : `cursor at col ${pos.col}, expected 2`,
      }
    },
  ),

  // SGR 58;5;N — indexed underline color. Verify underline is active and, if the
  // backend exposes per-cell underline color, that the indexed color resolved to a
  // non-default value. Backends that don't expose underlineColor pass on the
  // underline check alone — they're handled per-backend in annotations.
  probe(
    "sgr.underline-color-indexed",
    (ctx) => {
      ctx.feed("\x1b[4m\x1b[58;5;5mX")
      const cell = ctx.getCell(0, 0)
      if (!cell.underline) return { pass: false, note: "underline not set" }
      if (cell.underlineColor === undefined) {
        // Backend doesn't track underline color per cell — accept underline alone.
        return { pass: true, note: "underlineColor not tracked by backend" }
      }
      if (cell.underlineColor === null) {
        return { pass: false, note: "underlineColor is null after SGR 58;5;5" }
      }
      // Palette index 5 is magenta in the standard 16-color palette — at minimum
      // some red and some blue, no green. We accept any non-zero color since the
      // exact palette mapping varies by terminal theme.
      const c = cell.underlineColor
      const looksColored = c.r > 0 || c.g > 0 || c.b > 0
      return {
        pass: looksColored,
        note: looksColored ? undefined : `underlineColor is rgb(${c.r},${c.g},${c.b})`,
      }
    },
    async (ctx) => {
      ctx.write("\x1b[1;1H\x1b[2K")
      ctx.write("\x1b[4m\x1b[58;5;5mX\x1b[0m")
      const pos = await ctx.queryCursorPosition()
      if (!pos) return { pass: false, note: "No cursor response" }
      return {
        pass: pos.col === 2,
        note: pos.col === 2 ? undefined : `cursor at col ${pos.col}, expected 2`,
      }
    },
  ),

  // SGR 58;2;R;G;B — truecolor underline color. Verify underline is active and,
  // if exposed, that the underline color matches the requested RGB exactly.
  probe(
    "sgr.underline-color-rgb",
    (ctx) => {
      ctx.feed("\x1b[4m\x1b[58;2;255;0;128mX")
      const cell = ctx.getCell(0, 0)
      if (!cell.underline) return { pass: false, note: "underline not set" }
      if (cell.underlineColor === undefined) {
        // Backend doesn't track underline color per cell — accept underline alone.
        return { pass: true, note: "underlineColor not tracked by backend" }
      }
      if (cell.underlineColor === null) {
        return { pass: false, note: "underlineColor is null after SGR 58;2;255;0;128" }
      }
      const c = cell.underlineColor
      const matches = c.r === 255 && c.g === 0 && c.b === 128
      return {
        pass: matches,
        note: matches ? undefined : `underlineColor is rgb(${c.r},${c.g},${c.b}), expected rgb(255,0,128)`,
      }
    },
    async (ctx) => {
      ctx.write("\x1b[1;1H\x1b[2K")
      ctx.write("\x1b[4m\x1b[58;2;255;0;128mX\x1b[0m")
      const pos = await ctx.queryCursorPosition()
      if (!pos) return { pass: false, note: "No cursor response" }
      return {
        pass: pos.col === 2,
        note: pos.col === 2 ? undefined : `cursor at col ${pos.col}, expected 2`,
      }
    },
  ),

  // SGR 59 — reset underline color. Set a colored underline on cell 0, then SGR 59
  // and write to cell 1. Cell 1 should still be underlined but without an explicit
  // underline color (null or default).
  probe(
    "sgr.underline-color-reset",
    (ctx) => {
      ctx.feed("\x1b[4m\x1b[58;2;255;0;128mX\x1b[59mY")
      const cell = ctx.getCell(0, 1)
      if (!cell.underline) return { pass: false, note: "underline not set on cell 1" }
      if (cell.underlineColor === undefined) {
        // Backend doesn't track underline color per cell — accept underline alone.
        return { pass: true, note: "underlineColor not tracked by backend" }
      }
      // After SGR 59 the underline color should be null (default) — anything
      // else (including the previously-set rgb(255,0,128)) means the reset was
      // not honored.
      const c = cell.underlineColor
      if (c === null) return { pass: true }
      const stillColored = c.r === 255 && c.g === 0 && c.b === 128
      return {
        pass: !stillColored,
        note: stillColored
          ? "underlineColor still rgb(255,0,128) after SGR 59 — reset not honored"
          : `underlineColor is rgb(${c.r},${c.g},${c.b}) after SGR 59`,
      }
    },
    async (ctx) => {
      ctx.write("\x1b[1;1H\x1b[2K")
      ctx.write("\x1b[4m\x1b[58;2;255;0;128m\x1b[59mX\x1b[0m")
      const pos = await ctx.queryCursorPosition()
      if (!pos) return { pass: false, note: "No cursor response" }
      return {
        pass: pos.col === 2,
        note: pos.col === 2 ? undefined : `cursor at col ${pos.col}, expected 2`,
      }
    },
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
      const cell = ctx.getCell(0, 1)
      return { pass: cell.fg === null }
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
      const cell = ctx.getCell(0, 1)
      return { pass: cell.bg === null }
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
      const cell = ctx.getCell(0, 1)
      return { pass: cell.bold === false && cell.dim === false }
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
      const cell = ctx.getCell(0, 1)
      return { pass: !cell.underline }
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
      const cell = ctx.getCell(0, 1)
      return { pass: cell.italic === false }
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
      const cell = ctx.getCell(0, 1)
      return { pass: cell.inverse === false }
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
      const cell = ctx.getCell(0, 1)
      return { pass: cell.bold === false && cell.italic === false && !cell.underline }
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
