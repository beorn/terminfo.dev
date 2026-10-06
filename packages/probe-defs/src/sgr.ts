import type { ProbeDefinition, ProbeResult, TermContext, TermlessContext } from "./types.ts"
import { parserStateResult, sgrProbe, probe } from "./helpers.ts"

const requestedUnderlineColor = { r: 255, g: 0, b: 128 }

function sameRgb(a: { r: number; g: number; b: number }, b: { r: number; g: number; b: number }): boolean {
  return a.r === b.r && a.g === b.g && a.b === b.b
}

/** A cursor reply proves consumption of the SGR sequence, never the visual attribute. */
async function consumedSgr(ctx: TermContext, sequence: string): Promise<ProbeResult> {
  try {
    ctx.write("\x1b[1;1H\x1b[2K")
    ctx.write(sequence + "X")
    const pos = await ctx.queryCursorPosition()
    if (!pos) {
      return {
        pass: false,
        note: "No cursor response",
        observation: { outcome: "inconclusive", reason: "no-response", evidence: "query" },
      }
    }
    return {
      pass: false,
      note: "Cursor advance does not verify SGR styling",
      response: `${pos.row};${pos.col}`,
      observation: {
        outcome: "inconclusive",
        reason: "insufficient-evidence",
        evidence: pos.row === 1 && pos.col === 2 ? "consumed" : "query",
        note: "Cursor advance does not verify SGR styling",
      },
    }
  } finally {
    ctx.write("\x1b[0m")
  }
}

function rgbUnderlineProbe(id: string): ProbeDefinition {
  const sequence = "\x1b[4m\x1b[58;2;255;0;128m"
  const original = sgrProbe(id, sequence, () => null)
  return {
    ...original,
    termless(ctx) {
      // Two default-color controls distinguish an exposed, foreground-following
      // underline from a backend that simply ignores SGR 58.
      ctx.feed("\x1b[4m\x1b[59m\x1b[38;2;0;0;255mA\x1b[38;2;0;255;0mB\x1b[58;2;255;0;128mX")
      const blueControl = ctx.getCell(0, 0)
      const greenControl = ctx.getCell(0, 1)
      const target = ctx.getCell(0, 2)
      const state = { blueControl, greenControl, target }
      const expected = `${id}: X has explicit rgb(255,0,128) underline distinct from the reset/default B cell`
      if (
        blueControl.char !== "A" ||
        greenControl.char !== "B" ||
        target.char !== "X" ||
        !blueControl.underline ||
        !greenControl.underline ||
        !target.underline ||
        target.underlineColor == null
      ) {
        return parserStateResult(null, expected, state, "Underlined control, target, or target color was not exposed")
      }
      if (greenControl.underlineColor && sameRgb(greenControl.underlineColor, requestedUnderlineColor)) {
        return parserStateResult(null, expected, state, "Default underline already matches the requested color")
      }
      if (sameRgb(target.underlineColor, requestedUnderlineColor)) return parserStateResult(true, expected, state)
      if (
        blueControl.fg &&
        greenControl.fg &&
        !sameRgb(blueControl.fg, greenControl.fg) &&
        blueControl.underlineColor &&
        greenControl.underlineColor &&
        !sameRgb(blueControl.underlineColor, greenControl.underlineColor)
      ) {
        return parserStateResult(false, expected, state)
      }
      return parserStateResult(null, expected, state, "Underline color readback was not calibrated for a negative")
    },

    termlessObservationEvidence: "parser-state",
  }
}

type ResetAttribute = "bold" | "dim" | "italic" | "underline" | "inverse"
type ResetCell = ReturnType<TermlessContext["getCell"]>

function measuredAttribute(cell: ResetCell, attribute: ResetAttribute): boolean | null {
  const value: unknown = cell[attribute]
  if (value === undefined) return null
  if (attribute === "underline") return value !== false && value !== null && value !== "none"
  return typeof value === "boolean" ? value : null
}

function measuredReset(
  ctx: TermlessContext,
  id: string,
  setup: string,
  reset: string,
  set: readonly ResetAttribute[],
  preserve: readonly ResetAttribute[],
): ProbeResult {
  ctx.feed(`C${setup}X${reset}Y`)
  const baseline = ctx.getCell(0, 0)
  const before = ctx.getCell(0, 1)
  const after = ctx.getCell(0, 2)
  const state = { baseline, before, after }
  const expected = `${id}: measured setup attributes clear on Y and unrelated attributes remain set`
  if (baseline.char !== "C" || before.char !== "X" || after.char !== "Y") {
    return parserStateResult(null, expected, state, "Baseline, styled, or reset cell was not exposed")
  }
  const attributes = [...new Set([...set, ...preserve])]
  if (
    attributes.some((attribute) => measuredAttribute(baseline, attribute) !== false) ||
    attributes.some((attribute) => measuredAttribute(before, attribute) !== true) ||
    attributes.some((attribute) => measuredAttribute(after, attribute) === null)
  ) {
    return parserStateResult(
      null,
      expected,
      state,
      "Neutral baseline, styled setup, or reset readback was not measured",
    )
  }
  const cleared = set.every((attribute) => measuredAttribute(after, attribute) === false)
  const retained = preserve.every((attribute) => measuredAttribute(after, attribute) === true)
  return parserStateResult(cleared && retained, expected, state)
}

async function consumedResetSgr(ctx: TermContext, setup: string, reset: string): Promise<ProbeResult> {
  try {
    ctx.write("\x1b[1;1H\x1b[2K")
    ctx.write(`${setup}X${reset}Y`)
    const pos = await ctx.queryCursorPosition()
    if (!pos) {
      return {
        pass: false,
        observation: { outcome: "inconclusive", reason: "no-response", evidence: "query" },
      }
    }
    const advanced = pos.row === 1 && pos.col === 3
    return {
      pass: false,
      response: `${pos.row};${pos.col}`,
      observation: {
        outcome: "inconclusive",
        reason: "insufficient-evidence",
        evidence: advanced ? "consumed" : "query",
        note: advanced ? "Cursor advance does not verify SGR reset" : "Cursor did not reach the expected position",
      },
    }
  } finally {
    ctx.write("\x1b[0m")
  }
}

function resetProbe(
  id: string,
  setup: string,
  reset: string,
  set: readonly ResetAttribute[],
  preserve: readonly ResetAttribute[] = [],
): ProbeDefinition {
  return {
    ...probe(
      id,
      (ctx) => measuredReset(ctx, id, setup, reset, set, preserve),
      (ctx) => consumedResetSgr(ctx, setup, reset),
      "consumed",
    ),
    termlessObservationEvidence: "parser-state",
  }
}

type ColorChannel = "fg" | "bg"
type Color = NonNullable<ResetCell["fg"]>

function sameCellColor(a: Color | null | undefined, b: Color | null | undefined): boolean {
  if (a === undefined || b === undefined) return false
  if (a === null || b === null) return a === b
  return sameRgb(a, b)
}

function namedColorProbe(id: string, channel: ColorChannel, firstCode: number, secondCode: number): ProbeDefinition {
  const first = `\x1b[${firstCode}m`
  const second = `\x1b[${secondCode}m`
  return {
    ...probe(
      id,
      (ctx) => {
        ctx.feed(`C${first}X${second}Y`)
        const baseline = ctx.getCell(0, 0)
        const firstCell = ctx.getCell(0, 1)
        const secondCell = ctx.getCell(0, 2)
        const state = { baseline, first: firstCell, second: secondCell }
        const expected = `${id}: the two named colors select distinct exposed ${channel} RGB values`
        if (baseline.char !== "C" || firstCell.char !== "X" || secondCell.char !== "Y") {
          return parserStateResult(null, expected, state, "Neutral control or named-color cells were not exposed")
        }
        const neutral = baseline[channel]
        const a = firstCell[channel]
        const b = secondCell[channel]
        if (neutral !== undefined && a && b && !sameCellColor(neutral, a) && !sameRgb(a, b)) {
          return parserStateResult(true, expected, state)
        }
        return parserStateResult(
          null,
          expected,
          state,
          "Baseline, theme colors, or color readback were indistinguishable",
        )
      },
      (ctx) => consumedSgr(ctx, first),
      "consumed",
    ),
    termlessObservationEvidence: "parser-state",
  }
}

function indexedColorProbe(id: string, channel: ColorChannel): ProbeDefinition {
  const sgr = channel === "fg" ? 38 : 48
  const first: Color = { r: 95, g: 135, b: 175 }
  const second: Color = { r: 215, g: 135, b: 95 }
  return {
    ...probe(
      id,
      (ctx) => {
        ctx.feed(`C\x1b[${sgr};2;95;135;175mA\x1b[${sgr};2;215;135;95mB\x1b[${sgr};5;67mX\x1b[${sgr};5;173mY`)
        const baseline = ctx.getCell(0, 0)
        const directFirst = ctx.getCell(0, 1)
        const directSecond = ctx.getCell(0, 2)
        const indexedFirst = ctx.getCell(0, 3)
        const indexedSecond = ctx.getCell(0, 4)
        const state = { baseline, directFirst, directSecond, indexedFirst, indexedSecond }
        const expected = `${id}: indices 67 and 173 match two independently observed canonical RGB cube references`
        if (
          baseline.char !== "C" ||
          directFirst.char !== "A" ||
          directSecond.char !== "B" ||
          indexedFirst.char !== "X" ||
          indexedSecond.char !== "Y"
        ) {
          return parserStateResult(null, expected, state, "Indexed or direct-RGB control cells were not exposed")
        }
        const a = directFirst[channel]
        const b = directSecond[channel]
        const x = indexedFirst[channel]
        const y = indexedSecond[channel]
        if (a && b && x && y && sameRgb(a, first) && sameRgb(b, second) && sameRgb(x, a) && sameRgb(y, b)) {
          return parserStateResult(true, expected, state)
        }
        return parserStateResult(
          null,
          expected,
          state,
          "RGB reference was not calibrated, or the backend may use a custom indexed palette",
        )
      },
      (ctx) => consumedSgr(ctx, `\x1b[${sgr};5;67m`),
      "consumed",
    ),
    termlessObservationEvidence: "parser-state",
  }
}

function truecolorProbe(id: string, channel: ColorChannel): ProbeDefinition {
  const sgr = channel === "fg" ? 38 : 48
  const ordinary = channel === "fg" ? [31, 34] : [41, 44]
  const first: Color = channel === "fg" ? { r: 255, g: 128, b: 0 } : { r: 0, g: 255, b: 128 }
  const second: Color = { r: 17, g: 97, b: 201 }
  return {
    ...probe(
      id,
      (ctx) => {
        ctx.feed(
          `C\x1b[${ordinary[0]}mA\x1b[${ordinary[1]}mB\x1b[${sgr};2;${first.r};${first.g};${first.b}mX\x1b[${sgr};2;17;97;201mY`,
        )
        const baseline = ctx.getCell(0, 0)
        const controlFirst = ctx.getCell(0, 1)
        const controlSecond = ctx.getCell(0, 2)
        const targetFirst = ctx.getCell(0, 3)
        const targetSecond = ctx.getCell(0, 4)
        const state = { baseline, controlFirst, controlSecond, targetFirst, targetSecond }
        const expected = `${id}: two distinct direct-RGB samples are exposed at their exact requested values`
        if (
          baseline.char !== "C" ||
          controlFirst.char !== "A" ||
          controlSecond.char !== "B" ||
          targetFirst.char !== "X" ||
          targetSecond.char !== "Y"
        ) {
          return parserStateResult(
            null,
            expected,
            state,
            "RGB target or independent color-control cells were not exposed",
          )
        }
        const x = targetFirst[channel]
        const y = targetSecond[channel]
        if (!x || !y) return parserStateResult(null, expected, state, "RGB target readback was absent")
        const preceding = controlSecond[channel]
        if (!preceding || sameRgb(preceding, first)) {
          return parserStateResult(null, expected, state, "The preceding color can mimic an ignored first RGB request")
        }
        if (sameRgb(x, first) && sameRgb(y, second)) return parserStateResult(true, expected, state)
        const a = controlFirst[channel]
        const b = controlSecond[channel]
        if (a && b && !sameRgb(a, b)) return parserStateResult(false, expected, state)
        return parserStateResult(null, expected, state, "Independent color-channel calibration was absent")
      },
      (ctx) => consumedSgr(ctx, `\x1b[${sgr};2;${first.r};${first.g};${first.b}m`),
      "consumed",
    ),
    termlessObservationEvidence: "parser-state",
  }
}

function defaultColorProbe(id: string, channel: ColorChannel): ProbeDefinition {
  const setup = channel === "fg" ? 31 : 42
  const reset = channel === "fg" ? 39 : 49
  return {
    ...probe(
      id,
      (ctx) => {
        ctx.feed(`C\x1b[${setup}mX\x1b[${reset}mR`)
        const baseline = ctx.getCell(0, 0)
        const before = ctx.getCell(0, 1)
        const after = ctx.getCell(0, 2)
        const state = { baseline, before, after }
        const expected = `${id}: reset R restores the measured C ${channel} after a distinct colored X`
        if (baseline.char !== "C" || before.char !== "X" || after.char !== "R") {
          return parserStateResult(null, expected, state, "Baseline, colored, or reset cell was not exposed")
        }
        const baseColor = baseline[channel]
        const changed = before[channel]
        const resetColor = after[channel]
        if (!changed || sameCellColor(baseColor, changed) || resetColor === undefined) {
          return parserStateResult(null, expected, state, "Distinct colored setup or reset color readback was absent")
        }
        return parserStateResult(sameCellColor(baseColor, resetColor), expected, state)
      },
      (ctx) => consumedSgr(ctx, `\x1b[${reset}m`),
      "consumed",
    ),
    termlessObservationEvidence: "parser-state",
  }
}

export const sgrProbes: ProbeDefinition[] = [
  // ── Attributes ──

  sgrProbe("sgr.bold", "\x1b[1m", (cell) => cell.bold === true, undefined, { require: [1] }),

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

  sgrProbe(
    "sgr.overline",
    "\x1b[53m",
    (cell) => (cell.overline === undefined ? null : cell.overline === true),
    (cell) => (cell.overline === undefined ? "cell.overline field not exposed" : null),
  ),

  // ── Underline color ──

  rgbUnderlineProbe("sgr.underline.color"),

  // Index values may be theme-specific. Compare two distinct palette controls
  // to their underline colors; one coincidental/default color cannot prove SGR 58.
  {
    ...probe(
      "sgr.underline-color-indexed",
      (ctx) => {
        ctx.feed("\x1b[4;38;5;4m\x1b[59mA\x1b[58;5;5mX\x1b[38;5;5m\x1b[59mB\x1b[58;5;4mY")
        const default4 = ctx.getCell(0, 0)
        const target5 = ctx.getCell(0, 1)
        const default5 = ctx.getCell(0, 2)
        const target4 = ctx.getCell(0, 3)
        const state = {
          default4,
          target5,
          default5,
          target4,
        }
        const expected =
          "SGR 58 index 5/4 underline colors match the opposite SGR 38 palette controls, not their same-foreground defaults"
        if (
          default4.char !== "A" ||
          target5.char !== "X" ||
          default5.char !== "B" ||
          target4.char !== "Y" ||
          !default4.underline ||
          !target5.underline ||
          !default5.underline ||
          !target4.underline ||
          !default4.fg ||
          !default5.fg ||
          target5.underlineColor == null ||
          target4.underlineColor == null
        ) {
          return parserStateResult(null, expected, state, "Palette control or underline cell state was not exposed")
        }
        if (sameRgb(default4.fg, default5.fg)) {
          return parserStateResult(null, expected, state, "Palette controls resolve to indistinguishable colors")
        }
        const matches =
          sameRgb(default5.fg, target5.underlineColor) &&
          sameRgb(default4.fg, target4.underlineColor) &&
          (!default4.underlineColor || !sameRgb(default4.underlineColor, target5.underlineColor)) &&
          (!default5.underlineColor || !sameRgb(default5.underlineColor, target4.underlineColor))
        if (matches) return parserStateResult(true, expected, state)
        if (
          default4.underlineColor &&
          default5.underlineColor &&
          !sameRgb(default4.underlineColor, default5.underlineColor)
        ) {
          return parserStateResult(false, expected, state)
        }
        return parserStateResult(null, expected, state, "Underline color readback was not calibrated for a negative")
      },
      (ctx) => consumedSgr(ctx, "\x1b[4m\x1b[58;5;5m"),
      "consumed",
    ),
    termlessObservationEvidence: "parser-state",
  },

  rgbUnderlineProbe("sgr.underline-color-rgb"),

  // SGR 59 — compare its actual reset value with an earlier reset-state control.
  {
    ...probe(
      "sgr.underline-color-reset",
      (ctx) => {
        ctx.feed("\x1b[4m\x1b[59mC\x1b[58;2;255;0;128mX\x1b[59mY")
        const baseline = ctx.getCell(0, 0)
        const before = ctx.getCell(0, 1)
        const after = ctx.getCell(0, 2)
        const state = { baseline, before, after }
        const expected =
          "X has explicit underline rgb(255,0,128); SGR 59 restores Y to the measured reset-state C color"
        if (
          baseline.char !== "C" ||
          before.char !== "X" ||
          after.char !== "Y" ||
          !baseline.underline ||
          !before.underline ||
          !after.underline ||
          baseline.underlineColor === undefined ||
          before.underlineColor === undefined ||
          after.underlineColor === undefined
        ) {
          return parserStateResult(null, expected, state, "Reset control or underline cell state was not exposed")
        }
        if (
          !before.underlineColor ||
          !sameRgb(before.underlineColor, requestedUnderlineColor) ||
          (baseline.underlineColor && sameRgb(baseline.underlineColor, requestedUnderlineColor))
        ) {
          return parserStateResult(null, expected, state, "Requested colored underline prerequisite was not observed")
        }
        if (after.underlineColor && sameRgb(after.underlineColor, before.underlineColor)) {
          return parserStateResult(false, expected, state)
        }
        if (baseline.underlineColor === null || after.underlineColor === null) {
          if (baseline.underlineColor === after.underlineColor) return parserStateResult(true, expected, state)
          return parserStateResult(null, expected, state, "Reset-state color readback changed representation")
        }
        return parserStateResult(sameRgb(baseline.underlineColor, after.underlineColor), expected, state)
      },
      (ctx) => consumedSgr(ctx, "\x1b[4m\x1b[58;2;255;0;128m\x1b[59m"),
      "consumed",
    ),
    termlessObservationEvidence: "parser-state",
  },

  // ── Colors ──

  namedColorProbe("sgr.fg.standard", "fg", 31, 34),
  namedColorProbe("sgr.bg.standard", "bg", 41, 44),
  namedColorProbe("sgr.fg.bright", "fg", 91, 94),
  namedColorProbe("sgr.bg.bright", "bg", 101, 104),
  defaultColorProbe("sgr.fg.default", "fg"),
  defaultColorProbe("sgr.bg.default", "bg"),
  indexedColorProbe("sgr.fg.256", "fg"),
  indexedColorProbe("sgr.bg.256", "bg"),
  truecolorProbe("sgr.fg.truecolor", "fg"),
  truecolorProbe("sgr.bg.truecolor", "bg"),

  // ── Selective resets ──

  resetProbe("sgr.selective-reset.bold", "\x1b[1;2;3m", "\x1b[22m", ["bold", "dim"], ["italic"]),

  resetProbe("sgr.selective-reset.underline", "\x1b[1;4m", "\x1b[24m", ["underline"], ["bold"]),

  resetProbe("sgr.selective-reset.italic", "\x1b[1;3m", "\x1b[23m", ["italic"], ["bold"]),

  resetProbe("sgr.selective-reset.inverse", "\x1b[1;7m", "\x1b[27m", ["inverse"], ["bold"]),

  // ── Full SGR reset ──

  resetProbe("sgr.reset", "\x1b[1;3;4m", "\x1b[0m", ["bold", "italic", "underline"]),
]
