import type { ProbeDefinition, ProbeResult, TermContext, TermlessContext } from "./types.ts"
import { probe, decrpmModeProbe, parserStateResult, isBlank } from "./helpers.ts"
import { parseSgrReport } from "./sgr.ts"

function sameRgb(a: { r: number; g: number; b: number }, b: { r: number; g: number; b: number }): boolean {
  return a.r === b.r && a.g === b.g && a.b === b.b
}

const ALT_1049_SEED_A = "PRIMARY-A"
const ALT_1049_SEED_B = "PRIMARY-B"
const ALT_1049_MARK = "ALT-MARK"

/** Read the exact characters of a horizontal span; never an inequality shortcut. */
function readAlt1049Span(ctx: TermlessContext, row: number, length: number): string {
  let text = ""
  for (let index = 0; index < length; index += 1) text += ctx.getCell(row, index).char
  return text
}

function alt1049SpanBlank(ctx: TermlessContext, row: number, length: number): boolean {
  for (let index = 0; index < length; index += 1) {
    if (!isBlank(ctx.getCell(row, index).char)) return false
  }
  return true
}

/**
 * One measured 1049 roundtrip shared by the enter and exit callbacks. Existing ctx only: feed,
 * getCell, getCursor, getScrollback and cols. No rows API and no entry-homing requirement.
 * BOTH callbacks grade supported only when the entire seeded roundtrip holds: blank alternate
 * spans, distinct ALT-MARK readback, exact PRIMARY-A/PRIMARY-B restoration, ALT-MARK absent from
 * the restored position, and saved-cursor restoration. Inadequate geometry, an unmeasured seed,
 * an unavailable readback and an unattributed restoration failure are inconclusive; a negative needs
 * measured setup plus a feature-specific failed assertion. Cleanup returns to normal mode in
 * finally and stays loud: a cleanup failure is never swallowed into a result.
 */
function altScreen1049Roundtrip(ctx: TermlessContext, phase: "enter" | "exit"): ProbeResult {
  const expected =
    phase === "enter"
      ? "CSI ? 1049 h switches to a cleared alternate buffer (full seeded roundtrip)"
      : "CSI ? 1049 l restores the primary buffer and the saved cursor"
  const rows = ctx.getScrollback().screenLines
  const cols = ctx.cols
  const needed = Math.max(ALT_1049_SEED_A.length, ALT_1049_SEED_B.length, ALT_1049_MARK.length)
  // Pre-cursor parks at row 4/col 6 (\x1b[5;7H): the measured geometry must cover the seeds,
  // the marker AND that saved cursor, so 5 rows are required, not just 3.
  if (!Number.isSafeInteger(rows) || !Number.isSafeInteger(cols) || rows < 5 || cols < needed) {
    return parserStateResult(
      null,
      expected,
      { rows, cols, needed },
      "1049 fixture needs at least 5 visible rows and " + needed + " columns",
    )
  }
  ctx.feed("\x1b[2J\x1b[1;1H" + ALT_1049_SEED_A)
  ctx.feed("\x1b[3;1H" + ALT_1049_SEED_B)
  ctx.feed("\x1b[5;7H")
  let before: { x: number; y: number }
  let seedA: string
  let seedB: string
  try {
    before = { ...ctx.getCursor() }
    seedA = readAlt1049Span(ctx, 0, ALT_1049_SEED_A.length)
    seedB = readAlt1049Span(ctx, 2, ALT_1049_SEED_B.length)
  } catch (error) {
    return alt1049ReadbackInconclusive(expected, "Primary seed readback failed", error)
  }
  if (seedA !== ALT_1049_SEED_A || seedB !== ALT_1049_SEED_B) {
    return parserStateResult(null, expected, { rows, cols, seedA, seedB }, "Primary seed was not measured")
  }
  // The saved-cursor claim is only measurable if the pre-cursor was actually parked at the
  // commanded row 4/col 6. A constant getCursor would make before==after trivially true, so an
  // unmeasured or mismatched pre-cursor is setup failure, checked before 1049h is fed.
  if (!Number.isSafeInteger(before.x) || !Number.isSafeInteger(before.y) || before.x !== 6 || before.y !== 4) {
    return parserStateResult(
      null,
      expected,
      { before, expectedCursor: { x: 6, y: 4 } },
      "Parked pre-cursor was not measured at row 4/col 6",
    )
  }
  try {
    ctx.feed("\x1b[?1049h")
    let blankA: boolean
    let blankB: boolean
    try {
      blankA = alt1049SpanBlank(ctx, 0, ALT_1049_SEED_A.length)
      blankB = alt1049SpanBlank(ctx, 2, ALT_1049_SEED_B.length)
    } catch (error) {
      return alt1049ReadbackInconclusive(expected, "Alternate-buffer readback failed", error)
    }
    if (!blankA || !blankB) {
      if (phase === "exit") {
        return parserStateResult(
          null,
          expected,
          { seedA, seedB, blankA, blankB },
          "Entry did not clear the seeded primary spans; exit cannot be attributed",
        )
      }
      return parserStateResult(
        false,
        expected,
        { seedA, seedB, blankA, blankB },
        "CSI ? 1049 h did not clear the seeded primary spans",
      )
    }
    ctx.feed("\x1b[1;1H" + ALT_1049_MARK)
    let mark: string
    try {
      mark = readAlt1049Span(ctx, 0, ALT_1049_MARK.length)
    } catch (error) {
      return alt1049ReadbackInconclusive(expected, "Alternate-marker readback failed", error)
    }
    if (mark !== ALT_1049_MARK) {
      return parserStateResult(null, expected, { mark }, "Alternate marker was not measured")
    }
    ctx.feed("\x1b[?1049l")
    let restoredA: string
    let restoredB: string
    let leaked: boolean
    let after: { x: number; y: number }
    try {
      restoredA = readAlt1049Span(ctx, 0, ALT_1049_SEED_A.length)
      restoredB = readAlt1049Span(ctx, 2, ALT_1049_SEED_B.length)
      leaked = readAlt1049Span(ctx, 0, ALT_1049_MARK.length) === ALT_1049_MARK
      after = { ...ctx.getCursor() }
    } catch (error) {
      return alt1049ReadbackInconclusive(expected, "Restored-primary readback failed", error)
    }
    const state = { before, seedA, seedB, mark, restoredA, restoredB, leaked, after }
    const failures: string[] = []
    if (restoredA !== ALT_1049_SEED_A) failures.push("PRIMARY-A not restored")
    if (restoredB !== ALT_1049_SEED_B) failures.push("PRIMARY-B not restored")
    if (leaked) failures.push("ALT-MARK leaked into the restored position")
    if (after.x !== before.x || after.y !== before.y) failures.push("saved cursor not restored")
    if (failures.length === 0) return parserStateResult(true, expected, state, undefined)
    return parserStateResult(
      null,
      expected,
      state,
      "1049 roundtrip failed: " +
        failures.join("; ") +
        "; cannot attribute failure to enter or exit: blank spans and ALT-MARK do not distinguish an alternate buffer from erasure, and cursor mismatch does not distinguish save from restore",
    )
  } finally {
    ctx.feed("\x1b[?1049l\x1b[0m")
  }
}

function alt1049ReadbackInconclusive(expected: string, note: string, error: unknown): ProbeResult {
  const message = error instanceof Error ? error.message : String(error)
  return parserStateResult(null, expected, { readbackError: message }, note)
}

function xtsaveRestoreTermless(id: string, ctx: TermlessContext): ProbeResult {
  const expected = `${id}: mode 7 is saved with ?7s, inverted with ?7l, and restored with ?7r`
  const originallyEnabled = ctx.getMode("autoWrap")
  try {
    ctx.feed("\x1b[?7h")
    const setupEnabled = ctx.getMode("autoWrap")
    if (setupEnabled !== true) {
      return parserStateResult(null, expected, { setupEnabled }, "Mode 7 enable (?7h) not reflected by terminal")
    }
    ctx.feed("\x1b[?7s")
    ctx.feed("\x1b[?7l")
    const inverted = ctx.getMode("autoWrap")
    if (inverted !== false) {
      return parserStateResult(
        null,
        expected,
        { inverted },
        "Mode 7 inversion (?7l) not reflected by terminal; cannot qualify save/restore",
      )
    }
    ctx.feed("\x1b[?7r")
    const restored = ctx.getMode("autoWrap")
    if (restored === true) {
      return parserStateResult(true, expected, { restored })
    }
    return parserStateResult(
      null,
      expected,
      { restored },
      "Mode 7 save/restore roundtrip failed; cannot attribute failure to save vs restore",
    )
  } finally {
    ctx.feed(originallyEnabled ? "\x1b[?7h" : "\x1b[?7l")
  }
}

async function xtsaveRestoreTerm(id: string, ctx: TermContext): Promise<ProbeResult> {
  if (!Number.isSafeInteger(ctx.rows) || !Number.isSafeInteger(ctx.cols) || ctx.rows < 2 || ctx.cols < 2) {
    ctx.write("\x1b[?7s")
    try {
      const pos = await ctx.queryCursorPosition()
      if (!pos) {
        return { pass: false, observation: { outcome: "inconclusive", reason: "no-response", evidence: "query" } }
      }
      return {
        pass: false,
        response: JSON.stringify(pos),
        observation: {
          outcome: "inconclusive",
          reason: "insufficient-evidence",
          evidence: "consumed",
          note: "Cursor responsiveness does not measure saved/restored state",
        },
      }
    } finally {
      ctx.write("\x1b[?7r")
    }
  }

  const initialMode = typeof ctx.queryMode === "function" ? await ctx.queryMode(7) : null
  try {
    if (typeof ctx.queryMode === "function") {
      ctx.write("\x1b[?7h")
      const setupMode = await ctx.queryMode(7)
      if (setupMode !== "set") {
        return {
          pass: false,
          response: setupMode ?? undefined,
          observation: {
            outcome: "inconclusive",
            reason: "insufficient-evidence",
            evidence: "query",
            note: `${id}: Mode 7 enable (?7h) not reflected by terminal`,
          },
        }
      }
      ctx.write("\x1b[?7s")
      ctx.write("\x1b[?7l")
      const intermediateMode = await ctx.queryMode(7)
      if (intermediateMode !== "reset") {
        return {
          pass: false,
          response: intermediateMode ?? undefined,
          observation: {
            outcome: "inconclusive",
            reason: "insufficient-evidence",
            evidence: "query",
            note: `${id}: Mode 7 inversion (?7l) not reflected by terminal; cannot qualify save/restore`,
          },
        }
      }
      ctx.write("\x1b[?7r")
      const restoredMode = await ctx.queryMode(7)
      const expected = `${id}: mode 7 restored to set via ?7r after ?7s and ?7l`
      if (restoredMode === "set") {
        return {
          pass: true,
          response: restoredMode,
          observation: { outcome: "supported", evidence: "query" },
          assertions: [{ kind: "positive", expected, observed: restoredMode }],
        }
      }
      return {
        pass: false,
        response: restoredMode ?? undefined,
        observation: {
          outcome: "inconclusive",
          reason: "insufficient-evidence",
          evidence: "query",
          note: `${id}: Mode 7 save/restore roundtrip failed; cannot attribute failure to save vs restore`,
        },
      }
    }

    ctx.write("\x1b[?7h\x1b[?7s\x1b[?7l\x1b[?7r")
    ctx.write(`\x1b[1;${ctx.cols}HX`)
    const pos = await ctx.queryCursorPosition()
    if (pos) {
      const wrapped = pos.row === 2 && pos.col === 1
      return {
        pass: wrapped,
        response: `${pos.row};${pos.col}`,
        observation: { outcome: wrapped ? "supported" : "unsupported", evidence: "behavior" },
        assertions: [
          {
            kind: wrapped ? "positive" : "negative",
            expected: `${id}: cursor wraps to next line when mode 7 is restored`,
            observed: `${pos.row};${pos.col}`,
          },
        ],
      }
    }
    return {
      pass: false,
      observation: {
        outcome: "inconclusive",
        reason: "no-response",
        evidence: "query",
        note: "Mode 7 query and behavior could not be determined",
      },
    }
  } finally {
    if (initialMode === "reset") {
      ctx.write("\x1b[?7l")
    } else if (initialMode === "set") {
      ctx.write("\x1b[?7h")
    }
  }
}

function xtpushpopsgrTermless(id: string, ctx: TermlessContext): ProbeResult {
  const expected = `${id}: SGR stack push and pop restores bold attribute on cell`
  let pushed = false
  try {
    ctx.feed("C")
    const baseline = ctx.getCell(0, 0)
    if (baseline.char !== "C" || baseline.bold) {
      return parserStateResult(null, expected, { baseline }, "Neutral baseline cell not measured")
    }
    ctx.feed("\x1b[1mA")
    const setupCell = ctx.getCell(0, 1)
    if (setupCell.char !== "A" || setupCell.bold !== true) {
      return parserStateResult(null, expected, { setupCell }, "Bold setup not reflected by terminal")
    }
    ctx.feed("\x1b[#{")
    pushed = true
    ctx.feed("\x1b[0mB")
    const intermediateCell = ctx.getCell(0, 2)
    if (intermediateCell.char !== "B" || intermediateCell.bold === true) {
      return parserStateResult(null, expected, { intermediateCell }, "Intermediate cleared styling not measured")
    }
    ctx.feed("\x1b[#}")
    pushed = false
    ctx.feed("X")
    const finalCell = ctx.getCell(0, 3)
    if (finalCell.char !== "X") {
      return parserStateResult(null, expected, { finalCell }, "Rendered final cell was not exposed")
    }
    if (finalCell.bold === true) {
      return parserStateResult(true, expected, { baseline, setupCell, intermediateCell, finalCell })
    }
    return parserStateResult(
      null,
      expected,
      { baseline, setupCell, intermediateCell, finalCell },
      "SGR stack roundtrip failed; cannot attribute failure to push vs pop",
    )
  } finally {
    if (pushed) {
      ctx.feed("\x1b[#}")
      pushed = false
    }
    ctx.feed("\x1b[0m")
  }
}

async function xtpushpopsgrTerm(id: string, ctx: TermContext): Promise<ProbeResult> {
  if (!Number.isSafeInteger(ctx.rows) || !Number.isSafeInteger(ctx.cols) || ctx.rows < 2 || ctx.cols < 2) {
    ctx.write("\x1b[#{")
    try {
      const pos = await ctx.queryCursorPosition()
      if (!pos) {
        return { pass: false, observation: { outcome: "inconclusive", reason: "no-response", evidence: "query" } }
      }
      return {
        pass: false,
        response: JSON.stringify(pos),
        observation: {
          outcome: "inconclusive",
          reason: "insufficient-evidence",
          evidence: "consumed",
          note: "Cursor responsiveness does not measure saved/restored state",
        },
      }
    } finally {
      ctx.write("\x1b[#}")
    }
  }

  let pushed = false
  try {
    if (typeof ctx.queryWithSentinelOutcome === "function") {
      // Step 1: Baseline query (verify bold not set)
      const baselineOutcome = await ctx.queryWithSentinelOutcome(
        "\x1bP$qm\x1b\\",
        /\x1bP([01])\$r([0-9:;]*)m(?:\x1b\\|\x07)/,
      )
      if (baselineOutcome?.match && baselineOutcome.match[1] === "1") {
        let baselineParsed = parseSgrReport(baselineOutcome.match[2] ?? "")
        if (baselineParsed && (baselineParsed.attributes.has("bold") || baselineParsed.rawCodes.includes("1"))) {
          ctx.write("\x1b[0m")
          const reread = await ctx.queryWithSentinelOutcome(
            "\x1bP$qm\x1b\\",
            /\x1bP([01])\$r([0-9:;]*)m(?:\x1b\\|\x07)/,
          )
          baselineParsed = reread?.match ? parseSgrReport(reread.match[2] ?? "") : null
          if (!baselineParsed || baselineParsed.attributes.has("bold") || baselineParsed.rawCodes.includes("1")) {
            return {
              pass: false,
              response: reread?.raw,
              observation: {
                outcome: "inconclusive",
                reason: "insufficient-evidence",
                evidence: "query",
                note: `${id}: Baseline bold styling active and could not be neutralized; cannot qualify push/pop`,
              },
            }
          }
        }
      }

      // Step 2: Setup styled state (bold) and qualify it
      ctx.write("\x1b[1m")
      const setupOutcome = await ctx.queryWithSentinelOutcome(
        "\x1bP$qm\x1b\\",
        /\x1bP([01])\$r([0-9:;]*)m(?:\x1b\\|\x07)/,
      )
      if (setupOutcome?.match && setupOutcome.match[1] === "1") {
        const setupParsed = parseSgrReport(setupOutcome.match[2] ?? "")
        if (!setupParsed || (!setupParsed.attributes.has("bold") && !setupParsed.rawCodes.includes("1"))) {
          return {
            pass: false,
            response: setupOutcome.raw,
            observation: {
              outcome: "inconclusive",
              reason: "insufficient-evidence",
              evidence: "query",
              note: `${id}: Setup bold styling not reflected in DECRQSS; cannot qualify push/pop`,
            },
          }
        }
      }

      // Step 3: Push styled state to stack
      ctx.write("\x1b[#{")
      pushed = true

      // Step 4: Clear styling (intermediate state)
      ctx.write("\x1b[0m")
      const intermediateOutcome = await ctx.queryWithSentinelOutcome(
        "\x1bP$qm\x1b\\",
        /\x1bP([01])\$r([0-9:;]*)m(?:\x1b\\|\x07)/,
      )
      if (intermediateOutcome?.match && intermediateOutcome.match[1] === "1") {
        const intermediateParsed = parseSgrReport(intermediateOutcome.match[2] ?? "")
        if (!intermediateParsed) {
          return {
            pass: false,
            response: intermediateOutcome.raw,
            observation: {
              outcome: "inconclusive",
              reason: "insufficient-evidence",
              evidence: "query",
              note: `${id}: Intermediate SGR report contains invalid parameters; cannot qualify restore`,
            },
          }
        }
        const intermediateCleared =
          !intermediateParsed.attributes.has("bold") && !intermediateParsed.rawCodes.includes("1")
        if (!intermediateCleared) {
          return {
            pass: false,
            response: intermediateOutcome.raw,
            observation: {
              outcome: "inconclusive",
              reason: "insufficient-evidence",
              evidence: "query",
              note: `${id}: Intermediate cleared styling not reflected in DECRQSS; cannot qualify restore`,
            },
          }
        }

        // Step 5: Pop stack
        ctx.write("\x1b[#}")
        pushed = false

        // Step 6: Verify restored bold state
        const finalOutcome = await ctx.queryWithSentinelOutcome(
          "\x1bP$qm\x1b\\",
          /\x1bP([01])\$r([0-9:;]*)m(?:\x1b\\|\x07)/,
        )
        if (finalOutcome?.match && finalOutcome.match[1] === "1") {
          const finalParsed = parseSgrReport(finalOutcome.match[2] ?? "")
          if (!finalParsed) {
            return {
              pass: false,
              response: finalOutcome.raw,
              observation: {
                outcome: "inconclusive",
                reason: "insufficient-evidence",
                evidence: "query",
                note: `${id}: Restored SGR report contains invalid parameters; cannot qualify restore`,
              },
            }
          }
          const restored = finalParsed.attributes.has("bold") || finalParsed.rawCodes.includes("1")
          if (restored) {
            // Parameter reporting acknowledged. Do not promote to rendering support without capture.
            if (!ctx.capture) {
              return {
                pass: false,
                response: finalOutcome.raw,
                observation: {
                  outcome: "inconclusive",
                  reason: "insufficient-evidence",
                  evidence: "query",
                  note: "DECRQSS confirmed SGR stack parameter restoration; visual rendering not measured",
                },
              }
            }
          } else {
            return {
              pass: false,
              response: finalOutcome.raw,
              observation: {
                outcome: "inconclusive",
                reason: "insufficient-evidence",
                evidence: "query",
                note: `${id}: SGR stack roundtrip failed to restore bold; cannot attribute failure to push vs pop`,
              },
            }
          }
        }
      }
    }

    if (ctx.capture) {
      const sample = "AaBb 0123456789 - terminal text"
      ctx.write("\x1b[0m\x1b[2J\x1b[3;3H" + sample)
      const control = await ctx.capture({ role: "control", label: "Unstyled text sample" })
      if (!pushed) {
        ctx.write("\x1b[1m\x1b[#{")
        pushed = true
      }
      ctx.write("\x1b[0m\x1b[#}")
      pushed = false
      ctx.write(sample)
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

    const pos = await ctx.queryCursorPosition()
    if (!pos) {
      return { pass: false, observation: { outcome: "inconclusive", reason: "no-response", evidence: "query" } }
    }
    return {
      pass: false,
      response: JSON.stringify(pos),
      observation: {
        outcome: "inconclusive",
        reason: "insufficient-evidence",
        evidence: "consumed",
        note: "Cursor responsiveness does not measure saved/restored state",
      },
    }
  } finally {
    if (pushed) {
      ctx.write("\x1b[#}")
      pushed = false
    }
    ctx.write("\x1b[0m")
  }
}

function xtpushpopcolorsTermless(id: string, ctx: TermlessContext): ProbeResult {
  const expected = `${id}: color palette push and pop restores slot 1 palette color`
  let pushed = false
  try {
    ctx.feed("\x1b[38;5;1mC\x1b[0m")
    const baseline = ctx.getCell(0, 0)
    if (baseline.char !== "C" || !baseline.fg) {
      return parserStateResult(null, expected, { baseline }, "Baseline palette slot 1 cell not exposed")
    }
    const initialFg = { ...baseline.fg }
    const green = { r: 0, g: 255, b: 0 }
    if (sameRgb(initialFg, green)) {
      return parserStateResult(null, expected, { baseline }, "Initial palette already matches green test color")
    }

    ctx.feed("\x1b[#P")
    pushed = true
    ctx.feed("\x1b]4;1;rgb:0000/ffff/0000\x07")
    ctx.feed("\x1b[38;5;1mG\x1b[0m")
    const mutated = ctx.getCell(0, 1)
    if (mutated.char !== "G" || !mutated.fg || !sameRgb(mutated.fg, green)) {
      return parserStateResult(
        null,
        expected,
        { baseline, mutated },
        "Palette mutation to green was not reflected; cannot qualify restore",
      )
    }

    ctx.feed("\x1b[#Q")
    pushed = false
    ctx.feed("\x1b[38;5;1mX\x1b[0m")
    const restored = ctx.getCell(0, 2)
    if (restored.char !== "X" || !restored.fg) {
      return parserStateResult(null, expected, { restored }, "Restored palette cell not exposed")
    }
    if (sameRgb(restored.fg, initialFg)) {
      return parserStateResult(true, expected, { baseline, mutated, restored })
    }
    return parserStateResult(
      null,
      expected,
      { baseline, mutated, restored },
      "Palette push/pop roundtrip failed to restore slot 1; cannot attribute failure to push vs pop",
    )
  } finally {
    if (pushed) {
      ctx.feed("\x1b[#Q")
      pushed = false
    }
    if (initialFg) {
      const hexR = initialFg.r.toString(16).padStart(2, "0")
      const hexG = initialFg.g.toString(16).padStart(2, "0")
      const hexB = initialFg.b.toString(16).padStart(2, "0")
      ctx.feed(`\x1b]4;1;rgb:${hexR}${hexR}/${hexG}${hexG}/${hexB}${hexB}\x07`)
    }
    ctx.feed("\x1b[0m")
  }
}

function parseOsc4Rgb(spec: string): { r: number; g: number; b: number } | null {
  const parts = spec.split("/")
  if (parts.length !== 3) return null
  const [rs, gs, bs] = parts
  if (!/^[0-9a-fA-F]+$/.test(rs) || !/^[0-9a-fA-F]+$/.test(gs) || !/^[0-9a-fA-F]+$/.test(bs)) {
    return null
  }
  const parseChan = (hex: string) => {
    if (hex.length === 1) return parseInt(hex, 16) * 17
    if (hex.length === 2) return parseInt(hex, 16)
    if (hex.length === 3) return Math.round((parseInt(hex, 16) / 0xfff) * 255)
    if (hex.length === 4) return Math.round((parseInt(hex, 16) / 0xffff) * 255)
    return null
  }
  const r = parseChan(rs)
  const g = parseChan(gs)
  const b = parseChan(bs)
  if (r === null || g === null || b === null) return null
  return { r, g, b }
}

async function xtpushpopcolorsTerm(id: string, ctx: TermContext): Promise<ProbeResult> {
  if (!Number.isSafeInteger(ctx.rows) || !Number.isSafeInteger(ctx.cols) || ctx.rows < 2 || ctx.cols < 2) {
    ctx.write("\x1b[#P")
    try {
      const pos = await ctx.queryCursorPosition()
      if (!pos) {
        return { pass: false, observation: { outcome: "inconclusive", reason: "no-response", evidence: "query" } }
      }
      return {
        pass: false,
        response: JSON.stringify(pos),
        observation: {
          outcome: "inconclusive",
          reason: "insufficient-evidence",
          evidence: "consumed",
          note: "Cursor responsiveness does not measure saved/restored state",
        },
      }
    } finally {
      ctx.write("\x1b[#Q")
    }
  }

  let initialColor: string | null = null
  let initialParsed: { r: number; g: number; b: number } | null = null
  let pushed = false
  const green = { r: 0, g: 255, b: 0 }
  try {
    if (typeof ctx.queryWithSentinelOutcome === "function") {
      const outcome = await ctx.queryWithSentinelOutcome(
        "\x1b]4;1;?\x07",
        /\x1b\]4;1;rgb:([0-9a-fA-F/]+)(?:\x07|\x1b\\)/,
      )
      if (outcome?.match) {
        initialColor = outcome.match[1] ?? null
        initialParsed = initialColor ? parseOsc4Rgb(initialColor) : null
      }
    }

    if (initialParsed && typeof ctx.queryWithSentinelOutcome === "function") {
      if (sameRgb(initialParsed, green)) {
        return {
          pass: false,
          observation: {
            outcome: "inconclusive",
            reason: "insufficient-evidence",
            evidence: "query",
            note: `${id}: Initial palette slot 1 already matches green test color; cannot qualify mutation`,
          },
        }
      }

      ctx.write("\x1b[#P")
      pushed = true
      ctx.write("\x1b]4;1;rgb:0000/ffff/0000\x07")
      const intermediateOutcome = await ctx.queryWithSentinelOutcome(
        "\x1b]4;1;?\x07",
        /\x1b\]4;1;rgb:([0-9a-fA-F/]+)(?:\x07|\x1b\\)/,
      )
      const intermediateColor = intermediateOutcome?.match ? intermediateOutcome.match[1] : null
      const intermediateParsed = intermediateColor ? parseOsc4Rgb(intermediateColor) : null
      const isGreen = intermediateParsed ? sameRgb(intermediateParsed, green) : false
      if (!isGreen) {
        return {
          pass: false,
          response: intermediateOutcome?.raw,
          observation: {
            outcome: "inconclusive",
            reason: "insufficient-evidence",
            evidence: "query",
            note: `${id}: OSC 4 palette mutation to green not reflected; cannot qualify restore`,
          },
        }
      }

      ctx.write("\x1b[#Q")
      pushed = false
      const checkOutcome = await ctx.queryWithSentinelOutcome(
        "\x1b]4;1;?\x07",
        /\x1b\]4;1;rgb:([0-9a-fA-F/]+)(?:\x07|\x1b\\)/,
      )
      if (checkOutcome?.match) {
        const restoredColor = checkOutcome.match[1]
        const restoredParsed = restoredColor ? parseOsc4Rgb(restoredColor) : null
        const matches = restoredParsed ? sameRgb(restoredParsed, initialParsed) : false
        if (matches) {
          // Parameter reporting acknowledged. Do not promote to rendering support without capture.
          if (!ctx.capture) {
            return {
              pass: false,
              response: checkOutcome.raw,
              observation: {
                outcome: "inconclusive",
                reason: "insufficient-evidence",
                evidence: "query",
                note: `${id}: OSC 4 confirmed palette stack parameter restoration; visual rendering not measured`,
              },
              assertions: [
                {
                  kind: "positive",
                  expected: `${id}: OSC 4 palette slot 1 restored to ${initialColor} after push/change/pop`,
                  observed: checkOutcome.raw,
                },
              ],
            }
          }
        } else {
          return {
            pass: false,
            response: checkOutcome.raw,
            observation: {
              outcome: "inconclusive",
              reason: "insufficient-evidence",
              evidence: "query",
              note: `${id}: Palette push/pop roundtrip failed to restore slot 1; cannot attribute failure to push vs pop`,
            },
          }
        }
      }
    }

    if (ctx.capture) {
      ctx.write("\x1b[0m\x1b[2J\x1b[3;3H\x1b[38;5;1mSample Text")
      const control = await ctx.capture({ role: "control", label: "Initial palette sample" })
      if (!pushed) {
        ctx.write("\x1b[#P")
        pushed = true
      }
      ctx.write("\x1b]4;1;rgb:0000/ffff/0000\x07\x1b[#Q")
      pushed = false
      ctx.write("\x1b[0m\x1b[2J\x1b[3;3H\x1b[38;5;1mSample Text")
      const target = await ctx.capture({ role: "target", label: id })
      return {
        pass: false,
        observation: {
          outcome: "inconclusive",
          reason: "insufficient-evidence",
          evidence: "pixels",
          screenshotRef: target.ref,
          frames: [control, target],
          note: "Palette push/pop captured; visual interpretation requires review",
        },
      }
    }

    const pos = await ctx.queryCursorPosition()
    if (!pos) {
      return { pass: false, observation: { outcome: "inconclusive", reason: "no-response", evidence: "query" } }
    }
    return {
      pass: false,
      response: JSON.stringify(pos),
      observation: {
        outcome: "inconclusive",
        reason: "insufficient-evidence",
        evidence: "consumed",
        note: "Cursor responsiveness does not measure saved/restored state",
      },
    }
  } finally {
    if (pushed) {
      ctx.write("\x1b[#Q")
      pushed = false
    }
    if (initialColor) {
      ctx.write(`\x1b]4;1;rgb:${initialColor}\x07`)
    }
    ctx.write("\x1b[0m")
  }
}

export const modesProbes: ProbeDefinition[] = [
  // Alt screen enter — measured roundtrip (narrow CTO-approved 1049 slice)
  decrpmModeProbe("modes.alt-screen.enter", 1049, (ctx) => altScreen1049Roundtrip(ctx, "enter")),

  // Alt screen exit
  {
    ...probe(
      "modes.alt-screen.exit",
      (ctx) => altScreen1049Roundtrip(ctx, "exit"),
      async (ctx) => {
        if (!Number.isSafeInteger(ctx.rows) || !Number.isSafeInteger(ctx.cols) || ctx.rows < 3 || ctx.cols < 3) {
          return {
            pass: false,
            observation: {
              outcome: "inconclusive",
              reason: "insufficient-evidence",
              evidence: "none",
              note: `Alt-screen exit fixture needs at least 3x3, measured ${ctx.rows}x${ctx.cols}`,
            },
          }
        }
        ctx.write("\x1b[?1049h") // enter
        try {
          ctx.write("\x1b[3;3H") // move somewhere in alt
        } finally {
          ctx.write("\x1b[?1049l") // exit the fixture's alt screen
        }
        const pos = await ctx.queryCursorPosition()
        if (!pos) {
          return { pass: false, observation: { outcome: "inconclusive", reason: "no-response", evidence: "query" } }
        }
        return {
          pass: false,
          response: JSON.stringify(pos),
          observation: {
            outcome: "inconclusive",
            reason: "insufficient-evidence",
            evidence: "query",
            note: "Cursor responsiveness after exit does not measure the restored buffer",
          },
        }
      },
    ),
    termNeedsGeometry: true,
  },

  // Bracketed paste
  decrpmModeProbe("modes.bracketed-paste", 2004, (ctx) => {
    ctx.feed("\x1b[?2004h")
    return parserStateResult(
      null,
      "Bracketed paste emits delimited paste events",
      { mode: ctx.getMode("bracketedPaste") },
      "Mode metadata does not measure input events",
    )
  }),

  // Application cursor keys
  decrpmModeProbe("modes.application-cursor", 1, (ctx) => {
    ctx.feed("\x1b[?1h")
    return parserStateResult(
      null,
      "Application cursor mode changes generated key events",
      { mode: ctx.getMode("applicationCursor") },
      "Mode metadata does not measure key events",
    )
  }),

  // Auto wrap
  decrpmModeProbe("modes.auto-wrap", 7, (ctx) => {
    const expected = "DECAWM wraps Y after a full measured row of X"
    const rows = ctx.getScrollback().screenLines
    if (!Number.isSafeInteger(ctx.cols) || ctx.cols < 2 || !Number.isSafeInteger(rows) || rows < 2) {
      return parserStateResult(null, expected, { rows, cols: ctx.cols }, "Measured grid needs two rows")
    }
    const originallyEnabled = ctx.getMode("autoWrap")
    try {
      ctx.feed("\x1b[?7h")
      const enabled = ctx.getMode("autoWrap")
      if (!enabled) {
        return parserStateResult(null, expected, { originallyEnabled, enabled }, "Auto-wrap setup was not measured")
      }
      ctx.feed("X".repeat(ctx.cols) + "Y")
      const last = ctx.getCell(0, ctx.cols - 1)
      const next = ctx.getCell(1, 0)
      return parserStateResult(last.char === "X" && next.char === "Y", expected, {
        rows,
        cols: ctx.cols,
        originallyEnabled,
        enabled,
        last,
        next,
      })
    } finally {
      ctx.feed(originallyEnabled ? "\x1b[?7h" : "\x1b[?7l")
    }
  }),

  // Mouse tracking
  decrpmModeProbe("modes.mouse-tracking", 1000, (ctx) => {
    ctx.feed("\x1b[?1000h")
    return parserStateResult(
      null,
      "Mouse tracking emits encoded mouse events",
      { mode: ctx.getMode("mouseTracking") },
      "Mode metadata does not measure mouse events",
    )
  }),

  // Focus tracking
  decrpmModeProbe("modes.focus-tracking", 1004, (ctx) => {
    ctx.feed("\x1b[?1004h")
    return parserStateResult(
      null,
      "Focus tracking emits focus events",
      { mode: ctx.getMode("focusTracking") },
      "Mode metadata does not measure focus events",
    )
  }),

  // Reverse video
  decrpmModeProbe("modes.reverse-video", 5, (ctx) => {
    ctx.feed("\x1b[?5h")
    return parserStateResult(
      null,
      "Reverse video changes rendered colors",
      { mode: ctx.getMode("reverseVideo") },
      "Mode metadata does not measure pixels",
    )
  }),

  // Synchronized output
  decrpmModeProbe("modes.synchronized-output", 2026, (ctx) => {
    ctx.feed("\x1b[?2026h")
    ctx.feed("Hello")
    ctx.feed("\x1b[?2026l")
    return parserStateResult(
      null,
      "Synchronized output holds and releases complete frames",
      { text: ctx.getText() },
      "Final text does not measure frame timing",
    )
  }),

  // Origin mode
  decrpmModeProbe("modes.origin", 6, (ctx) => {
    ctx.feed("\x1b[?6h")
    const result = ctx.getMode("originMode") === true
    ctx.feed("\x1b[?6l")
    return parserStateResult(
      null,
      "Origin mode changes cursor addressing within margins",
      { mode: result },
      "Mode metadata does not measure addressing",
    )
  }),

  // Insert/replace mode (IRM)
  {
    ...probe(
      "modes.insert-replace",
      (ctx) => {
        const expected = "IRM inserts X before measured ABC instead of replacing A"
        const rows = ctx.getScrollback().screenLines
        if (!Number.isSafeInteger(ctx.cols) || ctx.cols < 4 || !Number.isSafeInteger(rows) || rows < 1) {
          return parserStateResult(null, expected, { cols: ctx.cols, rows }, "IRM fixture needs at least 1x4")
        }
        ctx.feed("\x1b[4l\x1b[1;1H\x1b[2KABC")
        const seed = Array.from({ length: 4 }, (_, col) => ctx.getCell(0, col).char)
        ctx.feed("\x1b[1;1H")
        const origin = ctx.getCursor()
        if (
          seed[0] !== "A" ||
          seed[1] !== "B" ||
          seed[2] !== "C" ||
          !isBlank(seed[3] ?? "\0") ||
          origin.x !== 0 ||
          origin.y !== 0
        ) {
          return parserStateResult(null, expected, { seed, origin }, "Cannot verify IRM seed and cursor origin")
        }
        try {
          ctx.feed("\x1b[4h")
          ctx.feed("X")
          const after = Array.from({ length: 4 }, (_, col) => ctx.getCell(0, col).char)
          const inserted = after[0] === "X" && after[1] === "A" && after[2] === "B" && after[3] === "C"
          const replaced = after[0] === "X" && after[1] === "B" && after[2] === "C" && isBlank(after[3] ?? "\0")
          return parserStateResult(
            inserted ? true : replaced ? false : null,
            expected,
            { seed, origin, after },
            inserted || replaced ? undefined : "Measured cells match neither insertion nor replacement",
          )
        } finally {
          ctx.feed("\x1b[4l")
        }
      },
      async (ctx) => {
        if (!Number.isSafeInteger(ctx.rows) || !Number.isSafeInteger(ctx.cols) || ctx.rows < 1 || ctx.cols < 5) {
          return {
            pass: false,
            observation: {
              outcome: "inconclusive",
              reason: "insufficient-evidence",
              evidence: "none",
              note: `Insert-replace fixture needs at least 1x5, measured ${ctx.rows}x${ctx.cols}`,
            },
          }
        }
        ctx.write("\x1b[1;1H\x1b[2K")
        ctx.write("ABCD")
        ctx.write("\x1b[1;2H") // move to col 2
        ctx.write("\x1b[4h") // enable insert mode
        try {
          ctx.write("X")
        } finally {
          ctx.write("\x1b[4l") // disable this fixture's insert mode
        }
        const pos = await ctx.queryCursorPosition()
        if (!pos) {
          return { pass: false, observation: { outcome: "inconclusive", reason: "no-response", evidence: "query" } }
        }
        return {
          pass: false,
          response: JSON.stringify(pos),
          observation: {
            outcome: "inconclusive",
            reason: "insufficient-evidence",
            evidence: "query",
            note: "Cursor advance does not measure whether X displaced the existing cells",
          },
        }
      },
    ),
    termNeedsGeometry: true,
  },

  // SGR mouse encoding
  decrpmModeProbe("modes.mouse-sgr", 1006, (ctx) => {
    ctx.feed("\x1b[?1006h")
    const pass = ctx.getMode("sgrMouse") === true
    ctx.feed("\x1b[?1006l")
    return parserStateResult(
      null,
      "SGR mouse mode changes encoded mouse events",
      { mode: pass },
      "Mode metadata does not measure mouse events",
    )
  }),

  // All-motion mouse tracking
  decrpmModeProbe("modes.mouse-all", 1003, (ctx) => {
    ctx.feed("\x1b[?1003h")
    const pass = ctx.getMode("mouseTracking") === true
    ctx.feed("\x1b[?1003l")
    return parserStateResult(
      null,
      "All-motion mouse mode emits movement events",
      { mode: pass },
      "Mode metadata does not measure mouse events",
    )
  }),

  // Application keypad
  probe(
    "modes.application-keypad",
    (ctx) => {
      ctx.feed("\x1b=")
      const on = ctx.getMode("applicationKeypad") === true
      ctx.feed("\x1b>")
      const off = ctx.getMode("applicationKeypad") === false
      return parserStateResult(
        null,
        "Application keypad mode changes keypad input",
        { on, off },
        "Mode metadata does not measure keypad events",
      )
    },
    () =>
      Promise.resolve({
        pass: false,
        observation: {
          outcome: "inconclusive",
          reason: "insufficient-evidence",
          evidence: "none",
          note: "Keypad mode left unchanged; this probe does not measure keypad input encoding",
        },
      }),
  ),

  // Left/right margin mode
  probe(
    "modes.left-right-margin",
    (ctx) => {
      ctx.feed("\x1b[?69h")
      const pass = ctx.getMode("leftRightMargin") === true
      ctx.feed("\x1b[?69l")
      return parserStateResult(
        null,
        "Left-right margin mode constrains horizontal operations",
        { mode: pass },
        "Mode metadata does not measure margins",
      )
    },
    () =>
      Promise.resolve({
        pass: false,
        observation: {
          outcome: "inconclusive",
          reason: "insufficient-evidence",
          evidence: "none",
          note: "Margin mode left unchanged; this probe does not measure left/right margin behavior",
        },
      }),
  ),

  // ?47 — legacy alt screen (no cursor save)
  probe(
    "modes.altscreen-47",
    (ctx) => {
      ctx.feed("\x1b[?47h")
      const entered = ctx.getMode("altScreen") === true
      ctx.feed("\x1b[?47l")
      const exited = ctx.getMode("altScreen") === false
      return parserStateResult(
        null,
        "?47 swaps the visible screen buffer",
        { entered, exited },
        "Mode metadata does not measure the buffer",
      )
    },
    () =>
      Promise.resolve({
        pass: false,
        observation: {
          outcome: "inconclusive",
          reason: "insufficient-evidence",
          evidence: "none",
          note: "Alternate buffer left unchanged; this probe does not measure its visible contents",
        },
      }),
  ),

  // ?1047 — alt screen, clear on enter
  probe(
    "modes.altscreen-1047",
    (ctx) => {
      ctx.feed("\x1b[?1047h")
      const entered = ctx.getMode("altScreen") === true
      ctx.feed("\x1b[?1047l")
      const exited = ctx.getMode("altScreen") === false
      return parserStateResult(
        null,
        "?1047 swaps and clears the visible alternate buffer",
        { entered, exited },
        "Mode metadata does not measure the buffer",
      )
    },
    async (ctx) => {
      const decrpmResult = await ctx.queryMode(1047)
      return {
        pass: false,
        ...(decrpmResult !== null && { response: decrpmResult }),
        observation: {
          outcome: "inconclusive",
          reason: decrpmResult === null ? "no-response" : "insufficient-evidence",
          evidence: "query",
          note:
            decrpmResult === null
              ? "No DECRPM reply; alternate-buffer clearing was not measured"
              : "DECRPM status does not measure alternate-buffer clearing",
        },
      }
    },
    "query",
  ),

  // ?1048 — save/restore cursor only (no alt screen)
  {
    ...probe(
      "modes.altscreen-1048",
      (ctx) => {
        const expected = "?1048 restores saved cursor from 15;20 to 5;10"
        const rows = ctx.getScrollback().screenLines
        if (!Number.isSafeInteger(rows) || !Number.isSafeInteger(ctx.cols) || rows < 15 || ctx.cols < 20) {
          return parserStateResult(null, expected, { rows, cols: ctx.cols }, "Cursor-save fixture needs at least 15x20")
        }
        ctx.feed("\x1b[5;10H") // row 5, col 10 (1-based) — termless 0-based: y=4, x=9
        const before = { ...ctx.getCursor() }
        if (before.y !== 4 || before.x !== 9) {
          return parserStateResult(
            null,
            expected,
            { before },
            "Cursor-save fixture did not establish its start position",
          )
        }
        ctx.feed("\x1b[?1048h") // save
        let displaced: ReturnType<typeof ctx.getCursor>
        try {
          ctx.feed("\x1b[15;20H")
          displaced = { ...ctx.getCursor() }
          if (displaced.y !== 14 || displaced.x !== 19) {
            return parserStateResult(
              null,
              expected,
              { before, displaced },
              "Cursor-save fixture did not measure displacement",
            )
          }
        } finally {
          ctx.feed("\x1b[?1048l") // restore this fixture's saved cursor
        }
        const after = ctx.getCursor()
        return parserStateResult(after.y === 4 && after.x === 9, expected, {
          before,
          displaced,
          after,
        })
      },
      async (ctx) => {
        if (!Number.isSafeInteger(ctx.rows) || !Number.isSafeInteger(ctx.cols) || ctx.rows < 15 || ctx.cols < 20) {
          return {
            pass: false,
            observation: {
              outcome: "inconclusive",
              reason: "insufficient-evidence",
              evidence: "none",
              note: `Cursor-save fixture needs at least 15x20, measured ${ctx.rows}x${ctx.cols}`,
            },
          }
        }
        ctx.write("\x1b[5;10H") // row 5, col 10
        const before = await ctx.queryCursorPosition()
        if (!before || before.row !== 5 || before.col !== 10) {
          return {
            pass: false,
            observation: {
              outcome: "inconclusive",
              reason: before ? "insufficient-evidence" : "no-response",
              evidence: "query",
              note: "Cursor-save fixture did not establish its start position",
            },
          }
        }
        ctx.write("\x1b[?1048h") // save
        let displaced: { row: number; col: number } | null = null
        try {
          ctx.write("\x1b[15;20H") // move
          displaced = await ctx.queryCursorPosition()
          if (!displaced || displaced.row !== 15 || displaced.col !== 20) {
            return {
              pass: false,
              observation: {
                outcome: "inconclusive",
                reason: displaced ? "insufficient-evidence" : "no-response",
                evidence: "query",
                note: "Cursor-save fixture did not measure displacement",
              },
            }
          }
        } finally {
          ctx.write("\x1b[?1048l") // restore this fixture's saved cursor
        }
        const pos = await ctx.queryCursorPosition()
        if (!pos) {
          return { pass: false, observation: { outcome: "inconclusive", reason: "no-response", evidence: "query" } }
        }
        const measured = { before, displaced, after: pos }
        const pass = pos.row === 5 && pos.col === 10
        return {
          pass,
          response: JSON.stringify(measured),
          observation: { outcome: pass ? "supported" : "unsupported", evidence: "query" },
          assertions: [
            {
              kind: pass ? "positive" : "negative",
              expected: "?1048 restores cursor from 15;20 to 5;10",
              observed: JSON.stringify(measured),
            },
          ],
        }
      },
    ),
    termNeedsGeometry: true,
  },

  // ?1007 — alt-scroll mouse wheel
  decrpmModeProbe("modes.alt-scroll-1007", 1007, (ctx) => {
    ctx.feed("\x1b[?1007h")
    // Verify via DECRPM query — response CSI ? 1007 ; Ps $ y where Ps=1 means set
    const response = ctx.feedCapture("\x1b[?1007$p")
    ctx.feed("\x1b[?1007l")
    if (response.includes("$y")) {
      return parserStateResult(
        null,
        "Alt-scroll changes wheel behavior",
        { response },
        "DECRPM reports a mode state, not a wheel event",
      )
    }
    // Fallback: verify sequence didn't break the terminal
    ctx.feed("X")
    const ok = ctx.getCell(0, 0).char === "X"
    return parserStateResult(
      null,
      "Alt-scroll changes wheel behavior",
      { responsive: ok },
      "Parser responsiveness does not measure wheel behavior",
    )
  }),

  // ?1005 — UTF-8 mouse encoding (legacy)
  decrpmModeProbe("modes.utf8-mouse-1005", 1005, (ctx) => {
    ctx.feed("\x1b[?1005h")
    // Verify via DECRPM query — response CSI ? 1005 ; Ps $ y where Ps=1 means set
    const response = ctx.feedCapture("\x1b[?1005$p")
    ctx.feed("\x1b[?1005l")
    if (response.includes("$y")) {
      return parserStateResult(
        null,
        "UTF-8 mouse mode encodes input events",
        { response },
        "DECRPM reports a mode state, not an encoded mouse event",
      )
    }
    // Fallback: verify sequence didn't break the terminal
    ctx.feed("X")
    const ok = ctx.getCell(0, 0).char === "X"
    return parserStateResult(
      null,
      "UTF-8 mouse mode encodes input events",
      { responsive: ok },
      "Parser responsiveness does not measure mouse input",
    )
  }),

  // ?3 — DECCOLM 80/132 column switch
  decrpmModeProbe("modes.deccolm", 3, (ctx) => {
    ctx.feed("\x1b[?3h")
    // Verify via DECRPM query — response CSI ? 3 ; Ps $ y where Ps=1 means set
    const response = ctx.feedCapture("\x1b[?3$p")
    ctx.feed("\x1b[?3l")
    if (response.includes("$y")) {
      return parserStateResult(
        null,
        "DECCOLM switches the measured grid width",
        { response, cols: ctx.cols },
        "DECRPM state does not establish a width transition",
      )
    }
    // Fallback: verify sequence didn't break the terminal
    ctx.feed("X")
    const ok = ctx.getText().includes("X")
    return parserStateResult(
      null,
      "DECCOLM switches the measured grid width",
      { responsive: ok, cols: ctx.cols },
      "Parser responsiveness does not measure a width transition",
    )
  }),

  // ?4 — DECSCLM smooth scroll mode. This is observable through DECRPM even
  // though modern emulators often render both smooth and jump scrolling instantly.
  decrpmModeProbe("modes.decsclm", 4, (ctx) => {
    ctx.feed("\x1b[?4h")
    const response = ctx.feedCapture("\x1b[?4$p")
    ctx.feed("\x1b[?4l")
    return parserStateResult(
      null,
      "DECSCLM changes scroll timing",
      { response },
      "DECRPM state does not measure scroll timing",
    )
  }),

  // Mode 2031 — color scheme reporting (dark/light mode notifications)
  // Adopted by: iTerm2, tmux 3.6, Contour, foot, kitty
  {
    ...probe(
      "modes.color-scheme-reporting",
      (ctx) => {
        const initiallyEnabled = ctx.getMode("colorSchemeReporting")
        try {
          ctx.feed("\x1b[?2031h")
          const enabled = ctx.getMode("colorSchemeReporting")
          return parserStateResult(
            null,
            "Mode 2031 emits color-scheme changes",
            { enabled },
            "Mode metadata does not measure update events",
          )
        } finally {
          ctx.feed(initiallyEnabled ? "\x1b[?2031h" : "\x1b[?2031l")
        }
      },
      async (ctx) => {
        const result = await ctx.queryMode(2031)
        const recognized = result === "set" || result === "reset"
        const note =
          result === null
            ? "No DECRPM 2031 reply; update events were not tested"
            : result === "unknown"
              ? "DECRPM 2031 explicitly unrecognized"
              : `DECRPM 2031 recognized (${result}); update events were not tested`
        return {
          pass: recognized,
          note,
          response: result ?? undefined,
          observation: {
            outcome: result === null ? "inconclusive" : recognized ? "supported" : "unsupported",
            evidence: "query",
            ...(result === null && { reason: "no-response" as const }),
            note,
          },
          ...(result !== null && {
            assertions: [
              {
                kind: recognized ? ("positive" as const) : ("negative" as const),
                expected: "DECRPM 2031 recognizes color-scheme reporting mode",
                observed: result,
              },
            ],
          }),
        }
      },
      "query",
    ),
    termWrites: "query",
  },

  // XTPUSHSGR — push SGR stack (CSI # {)
  probe(
    "modes.xtpushsgr",
    (ctx) => xtpushpopsgrTermless("modes.xtpushsgr", ctx),
    (ctx) => xtpushpopsgrTerm("modes.xtpushsgr", ctx),
  ),

  // XTPOPSGR — pop SGR stack (CSI # })
  probe(
    "modes.xtpopsgr",
    (ctx) => xtpushpopsgrTermless("modes.xtpopsgr", ctx),
    (ctx) => xtpushpopsgrTerm("modes.xtpopsgr", ctx),
  ),

  // XTSAVE — save DEC private modes (CSI ? Pm s). Use DECAWM (mode 7) — universally supported.
  probe(
    "modes.xtsave",
    (ctx) => xtsaveRestoreTermless("modes.xtsave", ctx),
    (ctx) => xtsaveRestoreTerm("modes.xtsave", ctx),
  ),

  // XTRESTORE — restore DEC private modes (CSI ? Pm r). Pair with a save first.
  probe(
    "modes.xtrestore",
    (ctx) => xtsaveRestoreTermless("modes.xtrestore", ctx),
    (ctx) => xtsaveRestoreTerm("modes.xtrestore", ctx),
  ),

  // XTPUSHCOLORS — push color palette (CSI # P)
  probe(
    "modes.xtpushcolors",
    (ctx) => xtpushpopcolorsTermless("modes.xtpushcolors", ctx),
    (ctx) => xtpushpopcolorsTerm("modes.xtpushcolors", ctx),
  ),

  // XTPOPCOLORS — pop color palette (CSI # Q). Push first so the pop is meaningful.
  probe(
    "modes.xtpopcolors",
    (ctx) => xtpushpopcolorsTermless("modes.xtpopcolors", ctx),
    (ctx) => xtpushpopcolorsTerm("modes.xtpopcolors", ctx),
  ),
]
