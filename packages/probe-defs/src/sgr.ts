import type { ProbeDefinition, ProbeCallbackResult, TermContext, TermlessContext } from "./types.ts"
import {
  notTestedResult,
  parserStateResult,
  sameRgb,
  sgrProbe,
  sgrCaptureFrames,
  sgrCaptureTooSmall,
  sgrPlainFixtureTooSmall,
  sgrReadbackDecision,
  type SgrReadback,
  probe,
} from "./helpers.ts"
import { captureRegionVerdict } from "./region-readback.ts"
import { RESET_FAMILY_CAPTURE } from "./reset-family-capture.ts"
import { COLOUR_CAPTURE, colourCaptureVerdict } from "./sgr-colour-capture.ts"

const requestedUnderlineColor = { r: 255, g: 0, b: 128 }

/**
 * An adapter that does not populate `underlineColor` reports null on every cell, so a cell fed an
 * explicit SGR 58 color that reads back none has no observable for the claim (a coverage record,
 * TEST TODO), never a negative (#30701, @cto ruling C: TEST TODO only where the cell field is missing).
 */
const UNDERLINE_COLOR_UNEXPOSED =
  "the underline color field (cell.underlineColor): the headless readback reports none on a cell fed an explicit SGR 58 color"

/**
 * Prefer the terminal's own DECRQSS SGR report over the pixel/cursor fallback path. A terminal that
 * answers decides the claim structurally; one that stays silent keeps the probe's existing evidence.
 */
export function sgrTermReadback(
  id: string,
  sequence: string,
  readback: SgrReadback,
  fallback: (ctx: TermContext) => ProbeCallbackResult | Promise<ProbeCallbackResult>,
  setup?: Parameters<typeof sgrReadbackDecision>[4],
): (ctx: TermContext) => Promise<ProbeCallbackResult> {
  return async (ctx) => {
    // The capture fixture guard refuses before any bytes on a measured small terminal, so the
    // readback must not emit its own sequences ahead of it.
    if (ctx.capture) {
      const refusal = sgrCaptureTooSmall(ctx, "SGR fixture")
      if (refusal) return refusal
    }
    const decided = await sgrReadbackDecision(ctx, id, sequence, readback, setup)
    if (decided) return decided
    // The readback may have written its sequence and query before returning no decisive answer, so a
    // named refusal from the region oracle after it is truthful QUERY evidence, never the zero-byte
    // "none" shape run-parser demands. A caller that wrote nothing still passes "none".
    const region = RESET_FAMILY_CAPTURE[id]
    if (region) {
      const verdict = await captureRegionVerdict(ctx, id, region, "query")
      if (verdict) return verdict
    }
    const colour = COLOUR_CAPTURE[id]
    if (colour) {
      const verdict = await captureRegionVerdict(ctx, id, colour, "query")
      if (verdict) return colourCaptureVerdict(id, verdict)
    }
    return fallback(ctx)
  }
}

/** A cursor reply proves consumption of the SGR sequence, never the visual attribute. */
async function consumedSgr(
  ctx: TermContext,
  id: string,
  sequence: string,
  controlLabel = `${id} control`,
): Promise<ProbeCallbackResult> {
  if (ctx.capture) {
    const refusal = sgrCaptureTooSmall(ctx, id)
    if (refusal) return refusal
    const sample = "AaBb 0123456789 - terminal text"
    try {
      return await sgrCaptureFrames(
        ctx,
        "\x1b[0m\x1b[2J\x1b[3;3H" + sample,
        "\x1b[0m\x1b[2J\x1b[3;3H" + sequence + sample,
        id,
        { sample, startRow: 3, startCol: 3, sampleCells: sample.length },
        undefined,
        controlLabel,
      )
    } finally {
      ctx.write("\x1b[0m")
    }
  }
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

/**
 * Capture check for a reset sequence (SGR 39/49/59). The control renders the same XXYY run under
 * `controlPrefix` (empty for a plain default-color comparison, SGR 4 for an underlined default);
 * the target renders the setup value on XX and the reset on YY, so an ignored reset cannot look
 * identical to a supported one. Consumption alone never proves the visual reset.
 */
async function consumedSgrReset(
  ctx: TermContext,
  id: string,
  setup: string,
  reset: string,
  controlPrefix = "",
): Promise<ProbeCallbackResult> {
  if (ctx.capture) {
    const refusal = sgrCaptureTooSmall(ctx, id)
    if (refusal) return refusal
    // A reset-family row never reaches this fallback: the DECRQSS readback path in
    // sgrTermReadback asks the same-run region oracle first and returns its verdict.
    try {
      return await sgrCaptureFrames(
        ctx,
        `\x1b[0m\x1b[2J\x1b[3;3H${controlPrefix}XXYY`,
        `\x1b[0m\x1b[2J\x1b[3;3H${setup}XX${reset}YY`,
        id,
        { startRow: 3, startCol: 3, setupCells: 2, resetCells: 2, controlPrefix },
        "XX carries the setup value and YY carries the reset; compare each against the control run before grading the reset",
      )
    } finally {
      ctx.write("\x1b[0m")
    }
  }
  try {
    ctx.write("\x1b[1;1H\x1b[2K")
    ctx.write(setup + "X" + reset + "Y")
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
      note: "Cursor advance does not verify the reset rendered",
      response: `${pos.row};${pos.col}`,
      observation: {
        outcome: "inconclusive",
        reason: "insufficient-evidence",
        evidence: pos.row === 1 && pos.col === 3 ? "consumed" : "query",
        note: "Cursor advance does not verify the reset rendered",
      },
    }
  } finally {
    ctx.write("\x1b[0m")
  }
}

function rgbUnderlineProbe(id: string): ProbeDefinition {
  const sequence = "\x1b[4m\x1b[58;2;255;0;128m"
  // DECRQSS must report the requested RGB, not merely SGR 58; the termless path independently
  // calibrates the exact color against default-color controls.
  const readback: SgrReadback = { require: [4, 58], requireTokens: ["58:2:255:0:128"] }
  const armed = sgrTermReadback(id, sequence, readback, (ctx) => consumedSgr(ctx, id, sequence, "Unstyled text sample"))
  return {
    ...probe(
      id,
      (ctx) => {
        // Two default-color controls distinguish an exposed, foreground-following
        // underline from a backend that simply ignores SGR 58.
        ctx.feed("\x1b[4m\x1b[59m\x1b[38;2;0;0;255mA\x1b[38;2;0;255;0mB\x1b[58;2;255;0;128mX")
        const blueControl = ctx.getCell(0, 0)
        const greenControl = ctx.getCell(0, 1)
        const target = ctx.getCell(0, 2)
        const state = { blueControl, greenControl, target }
        const expected = `${id}: X has explicit rgb(255,0,128) underline distinct from the reset/default B cell`
        const framed = blueControl.char === "A" && greenControl.char === "B" && target.char === "X"
        if (framed && target.underlineColor == null) return notTestedResult(UNDERLINE_COLOR_UNEXPOSED, state)
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
      async (ctx) => {
        // The readback writes the sequence before it answers, so the fixture's own geometry refusal
        // has to run ahead of it — a 1x2 terminal must refuse with a zero-byte trace.
        const refusal = sgrPlainFixtureTooSmall(ctx)
        return refusal ?? (await armed(ctx))
      },
      // Unchanged from the sgrProbe this replaced: an exception in this arm is recorded as query
      // evidence, because the arm asks DECRQSS before any capture falls back.
      "query",
    ),
    termNeedsGeometry: true,
    termlessObservationEvidence: "parser-state",
  }
}

type ResetAttribute = "bold" | "dim" | "italic" | "underline" | "inverse"
type ResetCell = ReturnType<TermlessContext["getCell"]>

/** DECRQSS parameter code reported while each resettable attribute is active. */
const RESET_ATTRIBUTE_CODE: Record<ResetAttribute, number> = { bold: 1, dim: 2, italic: 3, underline: 4, inverse: 7 }

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
): ProbeCallbackResult {
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
  // The claim is over the MEASURED setup attributes (#30701, @cto ruling C): an attribute the styled
  // setup does not show (a field the adapter never populates, or an intensity the backend keeps
  // exclusive) is left out of the grade. A measured miss is a negative; with no shown set attribute or
  // an unshown preserved one, the claim has no observable (a coverage record, TEST TODO).
  const shown = (attribute: ResetAttribute) => measuredAttribute(before, attribute) === true
  const graded = attributes.filter(shown)
  if (
    graded.some((attribute) => measuredAttribute(baseline, attribute) !== false) ||
    graded.some((attribute) => measuredAttribute(after, attribute) === null)
  ) {
    return parserStateResult(null, expected, state, "Neutral baseline or reset readback was not measured")
  }
  const unshown = attributes.filter((attribute) => !shown(attribute))
  const cleared = set.filter(shown).every((attribute) => measuredAttribute(after, attribute) === false)
  const retained = preserve.filter(shown).every((attribute) => measuredAttribute(after, attribute) === true)
  if (cleared && retained && (!set.some(shown) || !preserve.every(shown))) {
    return notTestedResult(`${unshown.join(" and ")} on the styled setup cell in the headless readback`, state)
  }
  return parserStateResult(
    cleared && retained,
    expected,
    state,
    unshown.length > 0
      ? `Graded on the measured setup; ${unshown.join(" and ")} not shown by the styled setup`
      : undefined,
  )
}

async function consumedResetSgr(ctx: TermContext, id: string, setup: string, reset: string): Promise<ProbeCallbackResult> {
  if (ctx.capture) {
    const refusal = sgrCaptureTooSmall(ctx, id)
    if (refusal) return refusal
    // A reset-family row never reaches this fallback: the DECRQSS readback path in
    // sgrTermReadback asks the same-run region oracle first and returns its verdict.
    try {
      return await sgrCaptureFrames(
        ctx,
        "\x1b[0m\x1b[2J\x1b[3;3H" + setup + "X",
        "\x1b[0m\x1b[2J\x1b[3;3H" + setup + "X" + reset + "Y",
        id,
        { setup, reset },
        "The control shows the styled X without the reset; the target adds the reset Y, so review can compare the reset effect",
      )
    } finally {
      ctx.write("\x1b[0m")
    }
  }
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
      sgrTermReadback(
        id,
        reset,
        {
          require: preserve.map((attribute) => RESET_ATTRIBUTE_CODE[attribute]),
          forbid: set.map((attribute) => RESET_ATTRIBUTE_CODE[attribute]),
        },
        (ctx) => consumedResetSgr(ctx, id, setup, reset),
        {
          sequence: setup,
          baseline: { require: [], forbid: [...set, ...preserve].map((attribute) => RESET_ATTRIBUTE_CODE[attribute]) },
          readback: { require: [...set, ...preserve].map((attribute) => RESET_ATTRIBUTE_CODE[attribute]) },
        },
      ),
      "consumed",
    ),
    termNeedsGeometry: true,
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
        // An undefined neutral is the default reported as absent, which already differs from an
        // exposed RGB value (#30701, @cto ruling C).
        if (a && b && !sameCellColor(neutral, a) && !sameRgb(a, b)) {
          return parserStateResult(true, expected, state)
        }
        // Both named colors left the cell at an exposed default: the backend ignored them. A neutral
        // and two targets that all read no color show nothing about the color field, so that is a
        // coverage record, as in the truecolor and default-color arms (#30701, @cto cd391424).
        if (neutral && sameCellColor(neutral, a) && sameCellColor(neutral, b)) {
          return parserStateResult(false, expected, state)
        }
        if (!neutral && !a && !b) {
          return notTestedResult(
            `the ${channel} color field in the headless readback (neutral, SGR ${firstCode} and SGR ${secondCode} cells all read no color)`,
            state,
          )
        }
        return parserStateResult(
          null,
          expected,
          state,
          "Baseline, theme colors, or color readback were indistinguishable",
        )
      },
      sgrTermReadback(id, first, { require: [firstCode] }, (ctx) => consumedSgr(ctx, id, first)),
      "consumed",
    ),
    termNeedsGeometry: true,
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
        // #30701, @cto ruling C: direct RGB that does not read back its fed value is a reference that
        // cannot be calibrated (TEST TODO). A calibrated reference the indices miss is a custom indexed
        // palette OR an adapter that does not resolve indices to RGB (wezterm reports an index as
        // {r: index, g: 0, b: 0}; #30703), so it stays inconclusive until an in-probe control shows the
        // adapter resolves indices (@cto cd391424).
        if (!a || !b || !sameRgb(a, first) || !sameRgb(b, second)) {
          return notTestedResult(
            `direct RGB ${channel} readback matching the fed value (SGR ${sgr};2 reference cells A and B)`,
            state,
          )
        }
        if (x && y && sameRgb(x, a) && sameRgb(y, b)) return parserStateResult(true, expected, state)
        return parserStateResult(
          null,
          expected,
          state,
          "Direct RGB references matched; indices 67 and 173 did not resolve to them: a custom indexed palette, or an adapter that does not resolve indices",
        )
      },
      sgrTermReadback(id, `\x1b[${sgr};5;67m`, { require: [sgr], requireTokens: [`${sgr}:5:67`] }, (ctx) =>
        consumedSgr(ctx, id, `\x1b[${sgr};5;67m`),
      ),
      "consumed",
    ),
    termNeedsGeometry: true,
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
        const a = controlFirst[channel]
        const b = controlSecond[channel]
        const calibrated = !!a && !!b && !sameRgb(a, b)
        if (!x || !y) {
          // #30701, @cto ruling C: a target that reads no color is a measured ignore while the
          // independent controls show two distinct colors; without them the channel is not shown.
          if (calibrated) return parserStateResult(false, expected, state)
          return notTestedResult(
            `independent ${channel} color controls (SGR ${ordinary[0]} and ${ordinary[1]}) distinguishable in the headless readback`,
            state,
          )
        }
        const preceding = controlSecond[channel]
        if (!preceding || sameRgb(preceding, first)) {
          return parserStateResult(null, expected, state, "The preceding color can mimic an ignored first RGB request")
        }
        if (sameRgb(x, first) && sameRgb(y, second)) return parserStateResult(true, expected, state)
        if (calibrated) return parserStateResult(false, expected, state)
        return parserStateResult(null, expected, state, "Independent color-channel calibration was absent")
      },
      sgrTermReadback(
        id,
        `\x1b[${sgr};2;${first.r};${first.g};${first.b}m`,
        { require: [sgr], requireTokens: [`${sgr}:2:${first.r}:${first.g}:${first.b}`] },
        (ctx) => consumedSgr(ctx, id, `\x1b[${sgr};2;${first.r};${first.g};${first.b}m`),
      ),
      "consumed",
    ),
    termNeedsGeometry: true,
    termlessObservationEvidence: "parser-state",
  }
}

function defaultColorProbe(id: string, channel: ColorChannel): ProbeDefinition {
  const setup = channel === "fg" ? 31 : 42
  const reset = channel === "fg" ? 39 : 49
  // Default means no explicit color in this channel, not just absence of the setup sample.
  const firstColor = channel === "fg" ? 30 : 40
  const nondefaultColors = [
    ...Array.from({ length: 8 }, (_, index) => firstColor + index),
    ...Array.from({ length: 8 }, (_, index) => firstColor + 60 + index),
    firstColor + 8,
  ]
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
          // #30701, @cto ruling C: the colored X is the reference the reset is read against; a setup
          // that reads back as the default leaves the reset with no observable (TEST TODO).
          return notTestedResult(
            `a colored ${channel} setup cell (SGR ${setup}) distinct from the default, and the reset cell's ${channel}, in the headless readback`,
            state,
          )
        }
        return parserStateResult(sameCellColor(baseColor, resetColor), expected, state)
      },
      sgrTermReadback(
        id,
        `\x1b[${reset}m`,
        { require: [], forbid: nondefaultColors },
        (ctx) => consumedSgrReset(ctx, id, `\x1b[${setup}m`, `\x1b[${reset}m`),
        {
          sequence: `\x1b[${setup}m`,
          baseline: { require: [], forbid: nondefaultColors },
          readback: { require: [setup] },
        },
      ),
      "consumed",
    ),
    termNeedsGeometry: true,
    termlessObservationEvidence: "parser-state",
  }
}

export const sgrProbes: ProbeDefinition[] = [
  // ── Attributes ──

  sgrProbe("sgr.bold", "\x1b[1m", (cell) => cell.bold === true, undefined, { require: [1] }),

  sgrProbe("sgr.faint", "\x1b[2m", (cell) => cell.dim === true, undefined, { require: [2] }),

  sgrProbe("sgr.italic", "\x1b[3m", (cell) => cell.italic === true, undefined, { require: [3] }),

  sgrProbe("sgr.underline.single", "\x1b[4m", (cell) => !!cell.underline, undefined, { require: [4] }),

  sgrProbe("sgr.underline.double", "\x1b[21m", (cell) => cell.underline === "double", undefined, { require: [21] }),

  sgrProbe("sgr.underline.curly", "\x1b[4:3m", (cell) => cell.underline === "curly", undefined, {
    require: [4],
    requireTokens: ["4:3"],
  }),

  sgrProbe("sgr.underline.dotted", "\x1b[4:4m", (cell) => cell.underline === "dotted", undefined, {
    require: [4],
    requireTokens: ["4:4"],
  }),

  sgrProbe("sgr.underline.dashed", "\x1b[4:5m", (cell) => cell.underline === "dashed", undefined, {
    require: [4],
    requireTokens: ["4:5"],
  }),

  sgrProbe("sgr.blink", "\x1b[5m", (cell) => cell.blink === true, undefined, { require: [5] }),

  sgrProbe("sgr.inverse", "\x1b[7m", (cell) => cell.inverse === true, undefined, { require: [7] }),

  sgrProbe("sgr.hidden", "\x1b[8m", (cell) => cell.hidden === true, undefined, { require: [8] }),

  sgrProbe("sgr.strikethrough", "\x1b[9m", (cell) => cell.strikethrough === true, undefined, { require: [9] }),

  sgrProbe(
    "sgr.overline",
    "\x1b[53m",
    (cell) => (cell.overline === undefined ? null : cell.overline === true),
    (cell) => (cell.overline === undefined ? "cell.overline field not exposed" : null),
    { require: [53] },
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
        const framed = default4.char === "A" && target5.char === "X" && default5.char === "B" && target4.char === "Y"
        if (framed && target5.underlineColor == null && target4.underlineColor == null) {
          return notTestedResult(UNDERLINE_COLOR_UNEXPOSED, state)
        }
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
      sgrTermReadback(
        "sgr.underline-color-indexed",
        "\x1b[4m\x1b[58;5;5m",
        { require: [4, 58], requireTokens: ["58:5:5"] },
        (ctx) => consumedSgr(ctx, "sgr.underline-color-indexed", "\x1b[4m\x1b[58;5;5m"),
      ),
      "consumed",
    ),
    termNeedsGeometry: true,
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
        const framed = baseline.char === "C" && before.char === "X" && after.char === "Y"
        if (framed && before.underlineColor == null) return notTestedResult(UNDERLINE_COLOR_UNEXPOSED, state)
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
      sgrTermReadback(
        "sgr.underline-color-reset",
        "\x1b[59m",
        { require: [4], forbid: [58] },
        (ctx) =>
          consumedSgrReset(ctx, "sgr.underline-color-reset", "\x1b[4m\x1b[58;2;255;0;128m", "\x1b[59m", "\x1b[4m"),
        {
          sequence: "\x1b[4m\x1b[58;2;255;0;128m",
          baseline: { require: [], forbid: [4, 58] },
          readback: { require: [4, 58], requireTokens: ["58:2:255:0:128"] },
        },
      ),
      "consumed",
    ),
    termNeedsGeometry: true,
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
