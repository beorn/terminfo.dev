import type { ProbeDefinition, ProbeResult, TermContext, TermlessContext } from "./types.ts"
import { parserStateResult, sgrProbe, probe } from "./helpers.ts"

const requestedUnderlineColor = { r: 255, g: 0, b: 128 }

function sameRgb(a: { r: number; g: number; b: number }, b: { r: number; g: number; b: number }): boolean {
  return a.r === b.r && a.g === b.g && a.b === b.b
}

export type ResetAttribute = "bold" | "dim" | "italic" | "underline" | "inverse"

export interface ParsedSgrColor {
  kind: "indexed" | "rgb"
  target: "38" | "48" | "58"
  index?: number
  r?: number
  g?: number
  b?: number
}

export interface ParsedSgrReport {
  attributes: Set<ResetAttribute>
  colors: ParsedSgrColor[]
  rawCodes: string[]
  normalizedString: string
}

export function parseSgrReport(params: string): ParsedSgrReport | null {
  const attributes = new Set<ResetAttribute>()
  const colors: ParsedSgrColor[] = []
  const rawCodes: string[] = []

  const rawTrimmed = params.trim()
  if (rawTrimmed === "" || rawTrimmed === "0") {
    return {
      attributes,
      colors,
      rawCodes: rawTrimmed === "0" ? ["0"] : [],
      normalizedString: "",
    }
  }

  // Reject empty semicolon parameters (e.g. "38;5;;1" or leading/trailing semicolons)
  if (rawTrimmed.includes(";;") || rawTrimmed.startsWith(";") || rawTrimmed.endsWith(";")) {
    return null
  }

  const elements = rawTrimmed.split(";")
  for (const el of elements) {
    if (el.trim() === "") return null
  }

  for (let i = 0; i < elements.length; i++) {
    const elem = elements[i].trim()

    // Colon-separated subparameters, e.g. "38:5:1", "38:2::255:0:128", "4:3"
    if (elem.includes(":")) {
      const sub = elem.split(":")
      const leader = sub[0]
      if (leader === "38" || leader === "48" || leader === "58") {
        const target = leader as "38" | "48" | "58"
        if (sub[1] === "5") {
          if (sub.length !== 3 || sub[2] === "" || isNaN(Number(sub[2]))) return null
          const idx = Number(sub[2])
          if (!Number.isInteger(idx) || idx < 0 || idx > 255) return null
          colors.push({ kind: "indexed", target, index: idx })
          rawCodes.push(`${target}:5:${idx}`)
          continue
        } else if (sub[1] === "2") {
          let r: number, g: number, b: number
          if (sub.length === 5) {
            if (sub[2] === "" || sub[3] === "" || sub[4] === "") return null
            r = Number(sub[2])
            g = Number(sub[3])
            b = Number(sub[4])
          } else if (sub.length === 6) {
            // Colorspace slot: sub[2] must be empty "" or "0" (sRGB)
            if (sub[2] !== "" && sub[2] !== "0") return null
            if (sub[3] === "" || sub[4] === "" || sub[5] === "") return null
            r = Number(sub[3])
            g = Number(sub[4])
            b = Number(sub[5])
          } else {
            return null
          }
          if (
            !Number.isInteger(r) ||
            !Number.isInteger(g) ||
            !Number.isInteger(b) ||
            r < 0 ||
            r > 255 ||
            g < 0 ||
            g > 255 ||
            b < 0 ||
            b > 255
          ) {
            return null
          }
          colors.push({ kind: "rgb", target, r, g, b })
          rawCodes.push(elem)
          continue
        } else {
          return null
        }
      } else if (leader === "4") {
        if (sub[1] === "0") {
          attributes.delete("underline")
        } else if (["1", "2", "3", "4", "5"].includes(sub[1])) {
          attributes.add("underline")
          rawCodes.push(elem)
        }
        continue
      } else {
        rawCodes.push(elem)
        continue
      }
    }

    // Semicolon-separated color entities: "38;5;n" or "38;2;r;g;b"
    if (elem === "38" || elem === "48" || elem === "58") {
      const target = elem as "38" | "48" | "58"
      if (i + 1 >= elements.length) return null
      const format = elements[i + 1]
      if (format === "5") {
        if (i + 2 >= elements.length || elements[i + 2] === "" || isNaN(Number(elements[i + 2]))) return null
        const idx = Number(elements[i + 2])
        if (!Number.isInteger(idx) || idx < 0 || idx > 255) return null
        colors.push({ kind: "indexed", target, index: idx })
        rawCodes.push(`${target};5;${idx}`)
        i += 2
        continue
      } else if (format === "2") {
        if (i + 4 < elements.length) {
          const r = Number(elements[i + 2])
          const g = Number(elements[i + 3])
          const b = Number(elements[i + 4])
          if (
            Number.isInteger(r) &&
            Number.isInteger(g) &&
            Number.isInteger(b) &&
            r >= 0 &&
            r <= 255 &&
            g >= 0 &&
            g <= 255 &&
            b >= 0 &&
            b <= 255
          ) {
            colors.push({ kind: "rgb", target, r, g, b })
            rawCodes.push(`${target};2;${r};${g};${b}`)
            i += 4
            continue
          }
        }
        if (i + 5 < elements.length) {
          const cs = elements[i + 2]
          if (cs === "" || cs === "0") {
            const r = Number(elements[i + 3])
            const g = Number(elements[i + 4])
            const b = Number(elements[i + 5])
            if (
              Number.isInteger(r) &&
              Number.isInteger(g) &&
              Number.isInteger(b) &&
              r >= 0 &&
              r <= 255 &&
              g >= 0 &&
              g <= 255 &&
              b >= 0 &&
              b <= 255
            ) {
              colors.push({ kind: "rgb", target, r, g, b })
              rawCodes.push(`${target};2;${cs};${r};${g};${b}`)
              i += 5
              continue
            }
          }
        }
        return null
      } else {
        return null
      }
    }

    // Standalone attribute / reset / color codes
    rawCodes.push(elem)
    if (elem === "0") {
      attributes.clear()
    } else if (elem === "1") {
      attributes.add("bold")
    } else if (elem === "2") {
      attributes.add("dim")
    } else if (elem === "3") {
      attributes.add("italic")
    } else if (elem === "4" || elem === "21") {
      attributes.add("underline")
    } else if (elem === "7") {
      attributes.add("inverse")
    } else if (elem === "22") {
      attributes.delete("bold")
      attributes.delete("dim")
    } else if (elem === "23") {
      attributes.delete("italic")
    } else if (elem === "24") {
      attributes.delete("underline")
    } else if (elem === "27") {
      attributes.delete("inverse")
    }
  }

  return {
    attributes,
    colors,
    rawCodes,
    normalizedString: rawCodes.join(";"),
  }
}

export interface DecrqssSgrCheck {
  expectedParam: string | RegExp | ((codes: string[]) => boolean)
  description: string
}

export async function measuredSgrTerm(
  ctx: TermContext,
  id: string,
  sequence: string,
  check?: DecrqssSgrCheck,
): Promise<ProbeResult> {
  const minRows = ctx.capture ? 3 : 1
  const minCols = ctx.capture ? 34 : 2
  const rows = ctx.rows
  const cols = ctx.cols
  if (!Number.isSafeInteger(rows) || !Number.isSafeInteger(cols) || rows < minRows || cols < minCols) {
    return {
      pass: false,
      observation: {
        outcome: "inconclusive",
        reason: "insufficient-evidence",
        evidence: "none",
        note: `SGR fixture needs at least ${minRows}x${minCols}, measured ${rows}x${cols}`,
      },
    }
  }

  try {
    ctx.write(sequence)

    // 1. Try DECRQSS query if available
    if (check && typeof ctx.queryWithSentinelOutcome === "function") {
      const outcome = await ctx.queryWithSentinelOutcome("\x1bP$qm\x1b\\", /\x1bP([01])\$r([0-9:;]*)m(?:\x1b\\|\x07)/)
      if (outcome?.match) {
        const status = outcome.match[1]
        const params = outcome.match[2] ?? ""
        if (status === "1") {
          const parsed = parseSgrReport(params)
          if (!parsed) {
            return {
              pass: false,
              response: outcome.raw,
              observation: {
                outcome: "inconclusive",
                reason: "insufficient-evidence",
                evidence: "query",
                note: `${id}: DECRQSS SGR report contains truncated or invalid parameters: ${params}`,
              },
            }
          }
          let matches = false
          if (typeof check.expectedParam === "function") {
            matches = check.expectedParam(parsed.rawCodes)
          } else if (typeof check.expectedParam === "string") {
            matches = parsed.rawCodes.includes(check.expectedParam)
          } else if (check.expectedParam instanceof RegExp) {
            matches =
              check.expectedParam.test(params) ||
              check.expectedParam.test(parsed.normalizedString) ||
              parsed.rawCodes.some((code) => check.expectedParam instanceof RegExp && check.expectedParam.test(code))
          }
          if (matches) {
            if (!ctx.capture) {
              return {
                pass: false,
                response: outcome.raw,
                observation: {
                  outcome: "inconclusive",
                  reason: "insufficient-evidence",
                  evidence: "query",
                  note: "DECRQSS confirmed reported parameters; rendering observable not measured",
                },
              }
            }
          } else {
            return {
              pass: false,
              response: outcome.raw,
              observation: { outcome: "unsupported", evidence: "query" },
              assertions: [
                {
                  kind: "negative",
                  expected: `${id}: DECRQSS SGR report matches ${check.description}`,
                  observed: outcome.raw,
                },
              ],
            }
          }
        } else if (status === "0") {
          return {
            pass: false,
            response: outcome.raw,
            observation: { outcome: "unsupported", evidence: "query" },
          }
        }
      }
    }

    // 2. Try pixel capture if available
    if (ctx.capture) {
      const sample = "AaBb 0123456789 - terminal text"
      ctx.write("\x1b[0m\x1b[2J\x1b[3;3H" + sample)
      const control = await ctx.capture({ role: "control", label: "Unstyled text sample" })
      ctx.write("\x1b[0m\x1b[2J\x1b[3;3H" + sequence + sample)
      const target = await ctx.capture({ role: "target", label: id })
      return {
        pass: false,
        observation: {
          outcome: "inconclusive",
          reason: "insufficient-evidence",
          evidence: "pixels",
          screenshotRef: target.ref,
          frames: [control, target],
          note: "Control and target pixels captured; visual interpretation requires review",
        },
      }
    }

    // 3. Fallback to CPR cursor advance
    ctx.write("\x1b[1;1H\x1b[2K" + sequence + "X")
    const pos = await ctx.queryCursorPosition()
    if (!pos) {
      return {
        pass: false,
        note: "No cursor response",
        observation: { outcome: "inconclusive", reason: "no-response", evidence: "query" },
      }
    }
    const advanced = pos.row === 1 && pos.col >= 2
    return {
      pass: false,
      note: "Cursor advance does not verify SGR styling",
      response: `${pos.row};${pos.col}`,
      observation: {
        outcome: "inconclusive",
        reason: "insufficient-evidence",
        evidence: advanced ? "consumed" : "query",
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
    async term(ctx) {
      return measuredSgrTerm(ctx, id, sequence, {
        expectedParam: /58[;: ]2[;: ]255[;: ]0[;: ]128/,
        description: "SGR 58;2;255;0;128",
      })
    },
    termlessObservationEvidence: "parser-state",
  }
}

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

export async function measuredResetSgrTerm(
  ctx: TermContext,
  id: string,
  setup: string,
  reset: string,
  set: readonly ResetAttribute[],
  preserve: readonly ResetAttribute[] = [],
  cleanInFinally = true,
): Promise<ProbeResult> {
  const minRows = ctx.capture ? 3 : 1
  const minCols = ctx.capture ? 34 : 2
  const rows = ctx.rows
  const cols = ctx.cols
  if (!Number.isSafeInteger(rows) || !Number.isSafeInteger(cols) || rows < minRows || cols < minCols) {
    return {
      pass: false,
      observation: {
        outcome: "inconclusive",
        reason: "insufficient-evidence",
        evidence: "none",
        note: `SGR fixture needs at least ${minRows}x${minCols}, measured ${rows}x${cols}`,
      },
    }
  }

  let setupApplied = false
  try {
    if (typeof ctx.queryWithSentinelOutcome === "function") {
      // Phase 1: Measure baseline and ensure neutral control state
      const baselineOutcome = await ctx.queryWithSentinelOutcome(
        "\x1bP$qm\x1b\\",
        /\x1bP([01])\$r([0-9:;]*)m(?:\x1b\\|\x07)/,
      )
      if (baselineOutcome?.match && baselineOutcome.match[1] === "1") {
        let baselineParsed = parseSgrReport(baselineOutcome.match[2] ?? "")
        if (!baselineParsed) {
          return {
            pass: false,
            response: baselineOutcome.raw,
            observation: {
              outcome: "inconclusive",
              reason: "insufficient-evidence",
              evidence: "query",
              note: `${id}: Baseline SGR report contains invalid parameters; cannot qualify reset`,
            },
          }
        }
        if (set.some((attr) => baselineParsed!.attributes.has(attr))) {
          ctx.write("\x1b[0m")
          const rereadOutcome = await ctx.queryWithSentinelOutcome(
            "\x1bP$qm\x1b\\",
            /\x1bP([01])\$r([0-9:;]*)m(?:\x1b\\|\x07)/,
          )
          baselineParsed = rereadOutcome?.match ? parseSgrReport(rereadOutcome.match[2] ?? "") : null
          if (!baselineParsed || set.some((attr) => baselineParsed!.attributes.has(attr))) {
            return {
              pass: false,
              response: rereadOutcome?.raw,
              observation: {
                outcome: "inconclusive",
                reason: "insufficient-evidence",
                evidence: "query",
                note: `${id}: Baseline styling active and could not be neutralized with SGR 0`,
              },
            }
          }
        }

        // Phase 2: Apply setup and qualify intermediate state
        ctx.write(setup)
        setupApplied = true
        const setupOutcome = await ctx.queryWithSentinelOutcome(
          "\x1bP$qm\x1b\\",
          /\x1bP([01])\$r([0-9:;]*)m(?:\x1b\\|\x07)/,
        )
        if (setupOutcome?.match && setupOutcome.match[1] === "1") {
          const setupParsed = parseSgrReport(setupOutcome.match[2] ?? "")
          if (!setupParsed) {
            return {
              pass: false,
              response: setupOutcome.raw,
              observation: {
                outcome: "inconclusive",
                reason: "insufficient-evidence",
                evidence: "query",
                note: `${id}: Setup SGR report contains truncated or invalid parameters`,
              },
            }
          }
          const requiredAttrs = [...new Set([...set, ...preserve])]
          const setupAppliedAttrs = requiredAttrs.every((attr) => setupParsed.attributes.has(attr))
          if (!setupAppliedAttrs) {
            return {
              pass: false,
              response: setupOutcome.raw,
              observation: {
                outcome: "inconclusive",
                reason: "insufficient-evidence",
                evidence: "query",
                note: `${id}: Setup attributes (${requiredAttrs.join(",")}) not reflected by terminal; cannot qualify reset`,
              },
            }
          }

          // Phase 3: Apply reset and verify clearing of target attributes and preservation of others
          ctx.write(reset)
          const resetOutcome = await ctx.queryWithSentinelOutcome(
            "\x1bP$qm\x1b\\",
            /\x1bP([01])\$r([0-9:;]*)m(?:\x1b\\|\x07)/,
          )
          if (resetOutcome?.match && resetOutcome.match[1] === "1") {
            const resetParsed = parseSgrReport(resetOutcome.match[2] ?? "")
            if (!resetParsed) {
              return {
                pass: false,
                response: resetOutcome.raw,
                observation: {
                  outcome: "inconclusive",
                  reason: "insufficient-evidence",
                  evidence: "query",
                  note: `${id}: Reset SGR report contains truncated or invalid parameters`,
                },
              }
            }
            const cleared = set.every((attr) => !resetParsed.attributes.has(attr))
            const retained = preserve.every((attr) => resetParsed.attributes.has(attr))
            const matches = cleared && retained
            if (matches) {
              // DECRQSS confirmed reported parameters; visual rendering is not measured by query alone.
              if (!ctx.capture) {
                return {
                  pass: false,
                  response: resetOutcome.raw,
                  observation: {
                    outcome: "inconclusive",
                    reason: "insufficient-evidence",
                    evidence: "query",
                    note: `${id}: DECRQSS confirmed reported reset parameters; rendering observable not measured`,
                  },
                  assertions: [
                    {
                      kind: "positive",
                      expected: `${id}: DECRQSS SGR report clears ${set.join(",")} and preserves ${preserve.join(",")}`,
                      observed: resetOutcome.raw,
                    },
                  ],
                }
              }
            } else {
              return {
                pass: false,
                response: resetOutcome.raw,
                observation: { outcome: "unsupported", evidence: "query" },
                assertions: [
                  {
                    kind: "negative",
                    expected: `${id}: DECRQSS SGR report clears ${set.join(",")} and preserves ${preserve.join(",")}`,
                    observed: resetOutcome.raw,
                  },
                ],
              }
            }
          }
        }
      }
    }

    if (ctx.capture) {
      const sample = "AaBb 0123456789 - terminal text"
      ctx.write("\x1b[0m\x1b[2J\x1b[3;3H" + sample)
      const control = await ctx.capture({ role: "control", label: "Unstyled text sample" })
      ctx.write("\x1b[0m\x1b[2J\x1b[3;3H" + setup + reset + sample)
      const target = await ctx.capture({ role: "target", label: id })
      return {
        pass: false,
        observation: {
          outcome: "inconclusive",
          reason: "insufficient-evidence",
          evidence: "pixels",
          screenshotRef: target.ref,
          frames: [control, target],
          note: "Control and target pixels captured; visual interpretation requires review",
        },
      }
    }

    ctx.write("\x1b[1;1H\x1b[2K" + setup + "X" + reset + "Y")
    const pos = await ctx.queryCursorPosition()
    if (!pos) {
      return {
        pass: false,
        observation: { outcome: "inconclusive", reason: "no-response", evidence: "query" },
      }
    }
    const advanced = pos.row === 1 && pos.col >= 2
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
    if (cleanInFinally) {
      ctx.write("\x1b[0m")
    }
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
      (ctx) => measuredResetSgrTerm(ctx, id, setup, reset, set, preserve),
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
      (ctx) =>
        measuredSgrTerm(ctx, id, first, {
          expectedParam: String(firstCode),
          description: `SGR param ${firstCode}`,
        }),
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
      (ctx) =>
        measuredSgrTerm(ctx, id, `\x1b[${sgr};5;67m`, {
          expectedParam: new RegExp(`${sgr}[;: ]5[;: ]67`),
          description: `SGR ${sgr};5;67`,
        }),
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
      (ctx) =>
        measuredSgrTerm(ctx, id, `\x1b[${sgr};2;${first.r};${first.g};${first.b}m`, {
          expectedParam: new RegExp(`${sgr}[;: ]2[;: ]${first.r}[;: ]${first.g}[;: ]${first.b}`),
          description: `SGR ${sgr};2;${first.r};${first.g};${first.b}`,
        }),
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
      async (ctx) => {
        const minRows = ctx.capture ? 3 : 1
        const minCols = ctx.capture ? 34 : 2
        if (
          !Number.isSafeInteger(ctx.rows) ||
          !Number.isSafeInteger(ctx.cols) ||
          ctx.rows < minRows ||
          ctx.cols < minCols
        ) {
          return {
            pass: false,
            observation: {
              outcome: "inconclusive",
              reason: "insufficient-evidence",
              evidence: "none",
              note: `SGR fixture needs at least ${minRows}x${minCols}, measured ${ctx.rows}x${ctx.cols}`,
            },
          }
        }
        try {
          if (typeof ctx.queryWithSentinelOutcome === "function") {
            ctx.write(`\x1b[${setup}m`)
            const setupOutcome = await ctx.queryWithSentinelOutcome(
              "\x1bP$qm\x1b\\",
              /\x1bP([01])\$r([0-9:;]*)m(?:\x1b\\|\x07)/,
            )
            if (setupOutcome?.match && setupOutcome.match[1] === "1") {
              const setupParsed = parseSgrReport(setupOutcome.match[2] ?? "")
              const setupActive = setupParsed?.rawCodes.includes(String(setup))
              if (!setupActive) {
                return {
                  pass: false,
                  response: setupOutcome.raw,
                  observation: {
                    outcome: "inconclusive",
                    reason: "insufficient-evidence",
                    evidence: "query",
                    note: `${id}: Setup color ${setup} not reflected by terminal; cannot qualify reset`,
                  },
                }
              }
              ctx.write(`\x1b[${reset}m`)
              const resetOutcome = await ctx.queryWithSentinelOutcome(
                "\x1bP$qm\x1b\\",
                /\x1bP([01])\$r([0-9:;]*)m(?:\x1b\\|\x07)/,
              )
              if (resetOutcome?.match && resetOutcome.match[1] === "1") {
                const resetParsed = parseSgrReport(resetOutcome.match[2] ?? "")
                const cleared =
                  !resetParsed?.rawCodes.includes(String(setup)) || resetParsed?.rawCodes.includes(String(reset))
                return {
                  pass: cleared,
                  response: resetOutcome.raw,
                  observation: { outcome: cleared ? "supported" : "unsupported", evidence: "query" },
                  assertions: [
                    {
                      kind: cleared ? "positive" : "negative",
                      expected: `${id}: reset clears color ${setup} or selects ${reset}`,
                      observed: resetOutcome.raw,
                    },
                  ],
                }
              }
            }
          }
          if (ctx.capture) {
            const sample = "AaBb 0123456789 - terminal text"
            ctx.write("\x1b[0m\x1b[2J\x1b[3;3H" + sample)
            const control = await ctx.capture({ role: "control", label: "Unstyled text sample" })
            ctx.write(`\x1b[0m\x1b[2J\x1b[3;3H\x1b[${setup}m\x1b[${reset}m` + sample)
            const target = await ctx.capture({ role: "target", label: id })
            return {
              pass: false,
              observation: {
                outcome: "inconclusive",
                reason: "insufficient-evidence",
                evidence: "pixels",
                screenshotRef: target.ref,
                frames: [control, target],
                note: "Control and target pixels captured; visual interpretation requires review",
              },
            }
          }
          ctx.write(`\x1b[1;1H\x1b[2K\x1b[${setup}mX\x1b[${reset}mY`)
          const pos = await ctx.queryCursorPosition()
          if (!pos) {
            return { pass: false, observation: { outcome: "inconclusive", reason: "no-response", evidence: "query" } }
          }
          const advanced = pos.row === 1 && pos.col >= 2
          return {
            pass: false,
            response: `${pos.row};${pos.col}`,
            observation: {
              outcome: "inconclusive",
              reason: "insufficient-evidence",
              evidence: advanced ? "consumed" : "query",
              note: advanced
                ? "Cursor advance does not verify SGR reset"
                : "Cursor did not reach the expected position",
            },
          }
        } finally {
          ctx.write("\x1b[0m")
        }
      },
      "consumed",
    ),
    termlessObservationEvidence: "parser-state",
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
      (ctx) =>
        measuredSgrTerm(ctx, "sgr.underline-color-indexed", "\x1b[4m\x1b[58;5;5m", {
          expectedParam: /58[;: ]5[;: ]5/,
          description: "SGR 58;5;5",
        }),
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
      async (ctx) => {
        const minRows = ctx.capture ? 3 : 1
        const minCols = ctx.capture ? 34 : 2
        if (
          !Number.isSafeInteger(ctx.rows) ||
          !Number.isSafeInteger(ctx.cols) ||
          ctx.rows < minRows ||
          ctx.cols < minCols
        ) {
          return {
            pass: false,
            observation: {
              outcome: "inconclusive",
              reason: "insufficient-evidence",
              evidence: "none",
              note: `SGR fixture needs at least ${minRows}x${minCols}, measured ${ctx.rows}x${ctx.cols}`,
            },
          }
        }
        try {
          if (typeof ctx.queryWithSentinelOutcome === "function") {
            ctx.write("\x1b[4m\x1b[58;2;255;0;128m")
            const setupOutcome = await ctx.queryWithSentinelOutcome(
              "\x1bP$qm\x1b\\",
              /\x1bP([01])\$r([0-9:;]*)m(?:\x1b\\|\x07)/,
            )
            if (setupOutcome?.match && setupOutcome.match[1] === "1") {
              const setupParsed = parseSgrReport(setupOutcome.match[2] ?? "")
              const setupActive =
                setupParsed?.colors.some((c) => c.target === "58") ||
                setupParsed?.rawCodes.some((c) => c.startsWith("58"))
              if (!setupActive) {
                return {
                  pass: false,
                  response: setupOutcome.raw,
                  observation: {
                    outcome: "inconclusive",
                    reason: "insufficient-evidence",
                    evidence: "query",
                    note: "sgr.underline-color-reset: Setup underline color 58 not reflected by terminal; cannot qualify reset",
                  },
                }
              }
              ctx.write("\x1b[59m")
              const resetOutcome = await ctx.queryWithSentinelOutcome(
                "\x1bP$qm\x1b\\",
                /\x1bP([01])\$r([0-9:;]*)m(?:\x1b\\|\x07)/,
              )
              if (resetOutcome?.match && resetOutcome.match[1] === "1") {
                const resetParsed = parseSgrReport(resetOutcome.match[2] ?? "")
                const cleared =
                  !resetParsed?.colors.some((c) => c.target === "58") &&
                  !resetParsed?.rawCodes.some((c) => c.startsWith("58"))
                return {
                  pass: cleared,
                  response: resetOutcome.raw,
                  observation: { outcome: cleared ? "supported" : "unsupported", evidence: "query" },
                  assertions: [
                    {
                      kind: cleared ? "positive" : "negative",
                      expected: "sgr.underline-color-reset: reset clears SGR 58",
                      observed: resetOutcome.raw,
                    },
                  ],
                }
              }
            }
          }
          if (ctx.capture) {
            const sample = "AaBb 0123456789 - terminal text"
            ctx.write("\x1b[0m\x1b[2J\x1b[3;3H" + sample)
            const control = await ctx.capture({ role: "control", label: "Unstyled text sample" })
            ctx.write("\x1b[0m\x1b[2J\x1b[3;3H\x1b[4m\x1b[58;2;255;0;128m\x1b[59m" + sample)
            const target = await ctx.capture({ role: "target", label: "sgr.underline-color-reset" })
            return {
              pass: false,
              observation: {
                outcome: "inconclusive",
                reason: "insufficient-evidence",
                evidence: "pixels",
                screenshotRef: target.ref,
                frames: [control, target],
                note: "Control and target pixels captured; visual interpretation requires review",
              },
            }
          }
          ctx.write("\x1b[1;1H\x1b[2K\x1b[4m\x1b[58;2;255;0;128mX\x1b[59mY")
          const pos = await ctx.queryCursorPosition()
          if (!pos) {
            return { pass: false, observation: { outcome: "inconclusive", reason: "no-response", evidence: "query" } }
          }
          const advanced = pos.row === 1 && pos.col >= 2
          return {
            pass: false,
            response: `${pos.row};${pos.col}`,
            observation: {
              outcome: "inconclusive",
              reason: "insufficient-evidence",
              evidence: advanced ? "consumed" : "query",
              note: advanced
                ? "Cursor advance does not verify SGR reset"
                : "Cursor did not reach the expected position",
            },
          }
        } finally {
          ctx.write("\x1b[0m")
        }
      },
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
