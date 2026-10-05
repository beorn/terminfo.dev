import type { ProbeDefinition, ProbeResult, TermContext, TermlessContext } from "./types.ts"
import { probe, decrpmModeProbe, parserStateResult, notTestedResult, isBlank } from "./helpers.ts"

/** Refuse a modes capture fixture before any bytes when the measured geometry is too small. */
function captureRefusal(ctx: TermContext, minRows: number, minCols: number, feature: string): ProbeResult | undefined {
  if (!ctx.capture) return undefined
  if (Number.isSafeInteger(ctx.rows) && Number.isSafeInteger(ctx.cols) && ctx.rows >= minRows && ctx.cols >= minCols) {
    return undefined
  }
  return {
    pass: false,
    observation: {
      outcome: "inconclusive",
      reason: "insufficient-evidence",
      evidence: "none",
      note: `${feature} capture needs at least ${minRows}x${minCols}, measured ${ctx.rows}x${ctx.cols}`,
    },
  }
}

/** SGR-stack capture: the control leaves Y plain; the target pushes bold, styles X, pops, so Y must be bold. */
async function xtSgrStackCapture(ctx: TermContext, id: string, label: string): Promise<ProbeResult> {
  const refusal = captureRefusal(ctx, 3, 6, id)
  if (refusal) return refusal
  try {
    ctx.write("\x1b[0m\x1b[2J\x1b[3;3H\x1b[1m\x1b[3mX\x1b[0mY")
    const control = await ctx.capture!({
      role: "control",
      label: `${id}: X bold+italic, Y plain after SGR 0 (no stack)`,
    })
    ctx.write("\x1b[0m\x1b[2J\x1b[3;3H\x1b[1m\x1b[#{\x1b[3mX\x1b[#}Y")
    const target = await ctx.capture!({
      role: "target",
      label: `${id}: ${label} — Y should carry the bold saved before X`,
    })
    const observed = JSON.stringify({ control: control.label, target: target.label })
    return {
      pass: false,
      response: observed,
      observation: {
        outcome: "inconclusive",
        reason: "insufficient-evidence",
        evidence: "pixels",
        screenshotRef: target.ref,
        frames: [control, target],
        note: "Control shows Y plain; the target pushes the bold, styles X italic, then pops, so Y must be bold again if the SGR stack round-tripped. Requires independent pixel review",
      },
    }
  } finally {
    ctx.write("\x1b[0m\x1b[2J\x1b[H")
  }
}

/** Mode save/restore capture: wrap is off in the control; the target saves wrap on, disables then restores it. */
async function xtModeSaveCapture(ctx: TermContext, id: string): Promise<ProbeResult> {
  const refusal = captureRefusal(ctx, 3, 12, id)
  if (refusal) return refusal
  try {
    ctx.write("\x1b[?7l\x1b[0m\x1b[2J\x1b[1;1HXXXXXXXXXX!")
    const control = await ctx.capture!({
      role: "control",
      label: `${id}: auto-wrap off, so the overflow ! stays on row 1`,
    })
    ctx.write("\x1b[?7h\x1b[?7s\x1b[?7l\x1b[?7r\x1b[0m\x1b[2J\x1b[1;1HXXXXXXXXXX!")
    const target = await ctx.capture!({
      role: "target",
      label: `${id}: wrap saved on, disabled and restored; the overflow ! should wrap to row 2`,
    })
    const observed = JSON.stringify({ control: control.label, target: target.label })
    return {
      pass: false,
      response: observed,
      observation: {
        outcome: "inconclusive",
        reason: "insufficient-evidence",
        evidence: "pixels",
        screenshotRef: target.ref,
        frames: [control, target],
        note: "Control keeps the overflow on row 1 with wrap off; the target saves wrap on, disables it, then restores it, so the overflow should wrap to row 2. Whether the restore re-enabled wrap requires independent pixel review",
      },
    }
  } finally {
    ctx.write("\x1b[?7h\x1b[0m\x1b[2J\x1b[H")
  }
}

/** Color-stack capture: palette index 1 is green in both frames; only the popped target restores it for Y. */
async function xtColorStackCapture(ctx: TermContext, id: string): Promise<ProbeResult> {
  const refusal = captureRefusal(ctx, 3, 8, id)
  if (refusal) return refusal
  try {
    ctx.write("\x1b[0m\x1b[2J\x1b[1;1H\x1b]4;1;rgb:00/ff/00\x07\x1b[38;5;1mXY")
    const control = await ctx.capture!({
      role: "control",
      label: `${id}: palette index 1 redefined to green; X and Y both use it`,
    })
    ctx.write("\x1b[0m\x1b[2J\x1b[1;1H\x1b[#P\x1b]4;1;rgb:00/ff/00\x07\x1b[38;5;1mX\x1b[#Q\x1b[38;5;1mY")
    const target = await ctx.capture!({
      role: "target",
      label: `${id}: X uses the pushed green index 1; Y uses the index 1 restored by the pop`,
    })
    const observed = JSON.stringify({ control: control.label, target: target.label })
    return {
      pass: false,
      response: observed,
      observation: {
        outcome: "inconclusive",
        reason: "insufficient-evidence",
        evidence: "pixels",
        screenshotRef: target.ref,
        frames: [control, target],
        note: "Control shows X and Y in the redefined green index 1; the target pushes the palette, redefines index 1, prints X, then pops before Y, so Y should return to the original index 1. Requires independent pixel review",
      },
    }
  } finally {
    ctx.write("\x1b[#Q\x1b]104\x07\x1b[0m\x1b[2J\x1b[H")
  }
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
        const refusal = captureRefusal(ctx, 3, 8, "Alt-screen exit")
        if (refusal) return refusal
        if (ctx.capture) {
          try {
            ctx.write("\x1b[?1049l\x1b[0m\x1b[2J\x1b[H")
            ctx.write("\x1b[1;1HPRIMARY")
            const control = await ctx.capture!({
              role: "control",
              label: "Primary-screen marker PRIMARY before entering the alternate screen",
            })
            ctx.write("\x1b[?1049h")
            ctx.write("\x1b[1;1HALTONLY")
            const alternate = await ctx.capture!({
              role: "target",
              label: "Alternate-screen marker ALTONLY while ?1049 is set",
            })
            ctx.write("\x1b[?1049l")
            const restored = await ctx.capture!({
              role: "target",
              label: "Primary-screen marker after ?1049l: PRIMARY restored and ALTONLY absent",
            })
            const observed = JSON.stringify({
              rows: ctx.rows,
              cols: ctx.cols,
              control: control.label,
              alternate: alternate.label,
              restored: restored.label,
            })
            return {
              pass: false,
              response: observed,
              observation: {
                outcome: "inconclusive",
                reason: "insufficient-evidence",
                evidence: "pixels",
                screenshotRef: restored.ref,
                frames: [control, alternate, restored],
                note: "Control shows PRIMARY; the alternate frame shows ALTONLY; the restored frame must show PRIMARY again with ALTONLY gone. Whether the primary buffer came back requires independent pixel review, because CPR after exit proves nothing about buffer contents",
              },
            }
          } finally {
            ctx.write("\x1b[?1049l\x1b[0m\x1b[2J\x1b[H")
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
    return notTestedResult("input events", { mode: ctx.getMode("bracketedPaste") })
  }),

  // Application cursor keys
  decrpmModeProbe("modes.application-cursor", 1, (ctx) => {
    ctx.feed("\x1b[?1h")
    return notTestedResult("key events", { mode: ctx.getMode("applicationCursor") })
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
    return notTestedResult("mouse events", { mode: ctx.getMode("mouseTracking") })
  }),

  // Focus tracking
  decrpmModeProbe("modes.focus-tracking", 1004, (ctx) => {
    ctx.feed("\x1b[?1004h")
    return notTestedResult("focus events", { mode: ctx.getMode("focusTracking") })
  }),

  // Reverse video
  decrpmModeProbe("modes.reverse-video", 5, (ctx) => {
    ctx.feed("\x1b[?5h")
    return notTestedResult("rendered colors (pixels)", { mode: ctx.getMode("reverseVideo") })
  }),

  // Synchronized output
  decrpmModeProbe("modes.synchronized-output", 2026, (ctx) => {
    ctx.feed("\x1b[?2026h")
    ctx.feed("Hello")
    ctx.feed("\x1b[?2026l")
    return notTestedResult("frame timing", { text: ctx.getText() })
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
        const refusal = captureRefusal(ctx, 1, 6, "Insert/replace")
        if (refusal) return refusal
        if (ctx.capture) {
          try {
            ctx.write("\x1b[?4l\x1b[0m\x1b[2J\x1b[1;1HABCD\x1b[1;2HX")
            const control = await ctx.capture!({
              role: "control",
              label: "Seed ABCD with X typed at column 2 in replace mode: expect XBCD",
            })
            ctx.write("\x1b[1;1HABCD\x1b[1;2H\x1b[4hX")
            const target = await ctx.capture!({
              role: "target",
              label: "Seed ABCD with X typed at column 2 under IRM (?4h): expect XABCD",
            })
            const observed = JSON.stringify({
              rows: ctx.rows,
              cols: ctx.cols,
              seed: "ABCD",
              typed: { row: 1, col: 2, char: "X" },
              control: control.label,
              target: target.label,
            })
            return {
              pass: false,
              response: observed,
              observation: {
                outcome: "inconclusive",
                reason: "insufficient-evidence",
                evidence: "pixels",
                screenshotRef: target.ref,
                frames: [control, target],
                note: "Control replaces A with X (XBCD); the IRM target inserts X and shifts the run (XABCD). Whether the shift actually happened requires independent pixel review",
              },
            }
          } finally {
            ctx.write("\x1b[4l\x1b[0m\x1b[2J\x1b[H")
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
    return notTestedResult("encoded mouse events", { mode: pass })
  }),

  // All-motion mouse tracking
  decrpmModeProbe("modes.mouse-all", 1003, (ctx) => {
    ctx.feed("\x1b[?1003h")
    const pass = ctx.getMode("mouseTracking") === true
    ctx.feed("\x1b[?1003l")
    return notTestedResult("mouse movement", { mode: pass })
  }),

  // Application keypad
  probe(
    "modes.application-keypad",
    (ctx) => {
      ctx.feed("\x1b=")
      const on = ctx.getMode("applicationKeypad") === true
      ctx.feed("\x1b>")
      const off = ctx.getMode("applicationKeypad") === false
      return notTestedResult("keypad input", { on, off })
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
    async (ctx) => {
      const refusal = captureRefusal(ctx, 2, 8, "Left/right margin")
      if (refusal) return refusal
      if (ctx.capture) {
        try {
          ctx.write("\x1b[?69l\x1b[?7h\x1b[0m\x1b[2J\x1b[H\x1b[1;1HABCDE")
          const control = await ctx.capture!({
            role: "control",
            label: "Five glyphs ABCDE written from row 1 column 1 with margins reset: all stay on row 1",
          })
          ctx.write("\x1b[2J\x1b[H\x1b[?69h\x1b[3;6s\x1b[1;3HABCDE")
          const target = await ctx.capture!({
            role: "target",
            label: "DECLRMM margins 3-6: ABCDE written from column 3 wraps at column 6 onto row 2",
          })
          const observed = JSON.stringify({
            rows: ctx.rows,
            cols: ctx.cols,
            margins: "3-6",
            control: control.label,
            target: target.label,
          })
          return {
            pass: false,
            response: observed,
            observation: {
              outcome: "inconclusive",
              reason: "insufficient-evidence",
              evidence: "pixels",
              screenshotRef: target.ref,
              frames: [control, target],
              note: "Control keeps ABCDE on row 1; with DECLRMM margins 3-6 the fifth glyph wraps at column 6 onto row 2. Whether the wrap respected the margin requires independent pixel review",
            },
          }
        } finally {
          ctx.write("\x1b[?69l\x1b[0m\x1b[2J\x1b[H")
        }
      }
      return {
        pass: false,
        observation: {
          outcome: "inconclusive",
          reason: "insufficient-evidence",
          evidence: "none",
          note: "Margin mode left unchanged; this probe does not measure left/right margin behavior",
        },
      }
    },
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
    async (ctx) => {
      const refusal = captureRefusal(ctx, 1, 8, "?47 alternate screen")
      if (refusal) return refusal
      if (ctx.capture) {
        try {
          ctx.write("\x1b[?47l\x1b[0m\x1b[2J\x1b[H\x1b[1;1HMAIN47")
          const control = await ctx.capture!({
            role: "control",
            label: "Primary-screen marker MAIN47 before ?47 is set",
          })
          ctx.write("\x1b[?47h\x1b[1;1HALT47")
          const alternate = await ctx.capture!({
            role: "target",
            label: "Alternate-screen marker ALT47 while ?47 is set",
          })
          ctx.write("\x1b[?47l")
          const restored = await ctx.capture!({
            role: "target",
            label: "Primary-screen marker after ?47 is reset: MAIN47 restored and ALT47 absent",
          })
          const observed = JSON.stringify({
            rows: ctx.rows,
            cols: ctx.cols,
            control: control.label,
            alternate: alternate.label,
            restored: restored.label,
          })
          return {
            pass: false,
            response: observed,
            observation: {
              outcome: "inconclusive",
              reason: "insufficient-evidence",
              evidence: "pixels",
              screenshotRef: restored.ref,
              frames: [control, alternate, restored],
              note: "Control shows MAIN47; the alternate frame shows ALT47; the restored frame must show MAIN47 again with ALT47 gone. Whether ?47 actually swapped buffers requires independent pixel review",
            },
          }
        } finally {
          ctx.write("\x1b[?47l\x1b[0m\x1b[2J\x1b[H")
        }
      }
      return {
        pass: false,
        observation: {
          outcome: "inconclusive",
          reason: "insufficient-evidence",
          evidence: "none",
          note: "Alternate buffer left unchanged; this probe does not measure its visible contents",
        },
      }
    },
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
      const refusal = captureRefusal(ctx, 1, 8, "?1047 alternate screen")
      if (refusal) return refusal
      if (ctx.capture) {
        try {
          ctx.write("\x1b[?1047l\x1b[0m\x1b[2J\x1b[H\x1b[1;1HMAIN47")
          const control = await ctx.capture!({
            role: "control",
            label: "Primary-screen marker MAIN47 before ?1047 is set",
          })
          ctx.write("\x1b[?1047h\x1b[1;1HALT1047")
          const alternate = await ctx.capture!({
            role: "target",
            label: "Alternate-screen marker ALT1047 while ?1047 is set (enter clears the alt buffer)",
          })
          ctx.write("\x1b[?1047l")
          const restored = await ctx.capture!({
            role: "target",
            label: "Primary-screen marker after ?1047 is reset: MAIN47 restored and ALT1047 absent",
          })
          const observed = JSON.stringify({
            rows: ctx.rows,
            cols: ctx.cols,
            control: control.label,
            alternate: alternate.label,
            restored: restored.label,
          })
          return {
            pass: false,
            response: observed,
            observation: {
              outcome: "inconclusive",
              reason: "insufficient-evidence",
              evidence: "pixels",
              screenshotRef: restored.ref,
              frames: [control, alternate, restored],
              note: "Control shows MAIN47; the alternate frame shows ALT1047; the restored frame must show MAIN47 again with ALT1047 gone. Whether ?1047 actually swapped and cleared buffers requires independent pixel review",
            },
          }
        } finally {
          ctx.write("\x1b[?1047l\x1b[0m\x1b[2J\x1b[H")
        }
      }
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
      return notTestedResult("encoded UTF-8 mouse events", { response })
    }
    // Fallback: verify sequence didn't break the terminal
    ctx.feed("X")
    const ok = ctx.getCell(0, 0).char === "X"
    return notTestedResult("encoded UTF-8 mouse events", { responsive: ok })
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
  // Sequence consumed without producing output. Verify terminal stays responsive afterward.
  probe(
    "modes.xtpushsgr",
    (ctx) => {
      // Capture any output during the push — should be empty.
      const pushOut = ctx.feedCapture("\x1b[#{")
      if (pushOut.length > 0) {
        return {
          pass: false,
          response: pushOut,
          observation: {
            outcome: "inconclusive",
            reason: "invalid-reply",
            evidence: "query",
            note: "Unexpected output during stack operation",
          },
        }
      }
      // Verify the terminal is still responsive by issuing a DA1 query.
      const probeResponse = ctx.feedCapture("\x1b[c")
      // Pop to leave clean state.
      ctx.feed("\x1b[#}")
      return {
        pass: false,
        response: probeResponse,
        observation: {
          outcome: "inconclusive",
          reason: "insufficient-evidence",
          evidence: "consumed",
          note: "DA1 responsiveness does not measure saved/restored stack state",
        },
      }
    },
    async (ctx) => {
      if (ctx.capture) return xtSgrStackCapture(ctx, "modes.xtpushsgr", "XTPUSHSGR (CSI # {) then XTPOPSGR")
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
        ctx.write("\x1b[#}") // pop to clean up
      }
    },
  ),

  // XTPOPSGR — pop SGR stack (CSI # })
  // Push first so the pop is meaningful, then verify responsiveness.
  probe(
    "modes.xtpopsgr",
    (ctx) => {
      ctx.feed("\x1b[#{")
      const popOut = ctx.feedCapture("\x1b[#}")
      if (popOut.length > 0) {
        return {
          pass: false,
          response: popOut,
          observation: {
            outcome: "inconclusive",
            reason: "invalid-reply",
            evidence: "query",
            note: "Unexpected output during stack operation",
          },
        }
      }
      const probeResponse = ctx.feedCapture("\x1b[c")
      return {
        pass: false,
        response: probeResponse,
        observation: {
          outcome: "inconclusive",
          reason: "insufficient-evidence",
          evidence: "consumed",
          note: "DA1 responsiveness does not measure saved/restored stack state",
        },
      }
    },
    async (ctx) => {
      if (ctx.capture) return xtSgrStackCapture(ctx, "modes.xtpopsgr", "XTPOPSGR (CSI # }) after a push")
      ctx.write("\x1b[#{")
      ctx.write("\x1b[#}")
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
    },
  ),

  // XTSAVE — save DEC private modes (CSI ? Pm s). Use DECAWM (mode 7) — universally supported.
  probe(
    "modes.xtsave",
    (ctx) => {
      const saveOut = ctx.feedCapture("\x1b[?7s")
      if (saveOut.length > 0) {
        return {
          pass: false,
          response: saveOut,
          observation: {
            outcome: "inconclusive",
            reason: "invalid-reply",
            evidence: "query",
            note: "Unexpected output during stack operation",
          },
        }
      }
      const probeResponse = ctx.feedCapture("\x1b[c")
      // Restore to leave clean state.
      ctx.feed("\x1b[?7r")
      return {
        pass: false,
        response: probeResponse,
        observation: {
          outcome: "inconclusive",
          reason: "insufficient-evidence",
          evidence: "consumed",
          note: "DA1 responsiveness does not measure saved/restored stack state",
        },
      }
    },
    async (ctx) => {
      if (ctx.capture) return xtModeSaveCapture(ctx, "modes.xtsave")
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
        ctx.write("\x1b[?7r") // restore to clean up
      }
    },
  ),

  // XTRESTORE — restore DEC private modes (CSI ? Pm r). Pair with a save first.
  probe(
    "modes.xtrestore",
    (ctx) => {
      ctx.feed("\x1b[?7s")
      const restoreOut = ctx.feedCapture("\x1b[?7r")
      if (restoreOut.length > 0) {
        return {
          pass: false,
          response: restoreOut,
          observation: {
            outcome: "inconclusive",
            reason: "invalid-reply",
            evidence: "query",
            note: "Unexpected output during stack operation",
          },
        }
      }
      const probeResponse = ctx.feedCapture("\x1b[c")
      return {
        pass: false,
        response: probeResponse,
        observation: {
          outcome: "inconclusive",
          reason: "insufficient-evidence",
          evidence: "consumed",
          note: "DA1 responsiveness does not measure saved/restored stack state",
        },
      }
    },
    async (ctx) => {
      if (ctx.capture) return xtModeSaveCapture(ctx, "modes.xtrestore")
      ctx.write("\x1b[?7s")
      ctx.write("\x1b[?7r")
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
    },
  ),

  // XTPUSHCOLORS — push color palette (CSI # P)
  probe(
    "modes.xtpushcolors",
    (ctx) => {
      const pushOut = ctx.feedCapture("\x1b[#P")
      if (pushOut.length > 0) {
        return {
          pass: false,
          response: pushOut,
          observation: {
            outcome: "inconclusive",
            reason: "invalid-reply",
            evidence: "query",
            note: "Unexpected output during stack operation",
          },
        }
      }
      const probeResponse = ctx.feedCapture("\x1b[c")
      // Pop to leave clean state.
      ctx.feed("\x1b[#Q")
      return {
        pass: false,
        response: probeResponse,
        observation: {
          outcome: "inconclusive",
          reason: "insufficient-evidence",
          evidence: "consumed",
          note: "DA1 responsiveness does not measure saved/restored stack state",
        },
      }
    },
    async (ctx) => {
      if (ctx.capture) return xtColorStackCapture(ctx, "modes.xtpushcolors")
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
        ctx.write("\x1b[#Q") // pop to clean up
      }
    },
  ),

  // XTPOPCOLORS — pop color palette (CSI # Q). Push first so the pop is meaningful.
  probe(
    "modes.xtpopcolors",
    (ctx) => {
      ctx.feed("\x1b[#P")
      const popOut = ctx.feedCapture("\x1b[#Q")
      if (popOut.length > 0) {
        return {
          pass: false,
          response: popOut,
          observation: {
            outcome: "inconclusive",
            reason: "invalid-reply",
            evidence: "query",
            note: "Unexpected output during stack operation",
          },
        }
      }
      const probeResponse = ctx.feedCapture("\x1b[c")
      return {
        pass: false,
        response: probeResponse,
        observation: {
          outcome: "inconclusive",
          reason: "insufficient-evidence",
          evidence: "consumed",
          note: "DA1 responsiveness does not measure saved/restored stack state",
        },
      }
    },
    async (ctx) => {
      if (ctx.capture) return xtColorStackCapture(ctx, "modes.xtpopcolors")
      ctx.write("\x1b[#P")
      ctx.write("\x1b[#Q")
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
    },
  ),
]
