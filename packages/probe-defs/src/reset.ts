import type { ProbeDefinition } from "./types.ts"
import { captureRegionVerdict, type RegionReadback } from "./region-readback.ts"
import { RESET_FAMILY_CAPTURE } from "./reset-family-capture.ts"
import {
  decrpmReading,
  notTestedResult,
  parserStateResult,
  probe,
  queryDecrpm,
  sgrCaptureFrames,
  sgrCaptureTooSmall,
  sgrReadbackDecision,
  type DecrpmPs,
} from "./helpers.ts"

/**
 * The cell-aligned readback for DECALN. The compared region is rows 2-3 and never row 1: DECALN
 * homes the cursor there itself, and a cursor row is excluded from every compared region. Both
 * frames park the cursor on the last row and the witness cell sits on row 4. The expected frame is a
 * full grid of E written PLAINLY in the same run, which is exactly what ESC # 8 should leave behind.
 */
function decalnReadback(rows: number, cols: number): Omit<RegionReadback, "pixelGeometry"> | null {
  if (!Number.isSafeInteger(rows) || !Number.isSafeInteger(cols) || rows < 5 || cols < 9) return null
  const park = `\x1b[${rows};1H`
  const screen = (line: string): string => {
    let writes = "\x1b[0m\x1b[2J\x1b[H"
    for (let row = 1; row <= rows; row++) writes += `\x1b[${row};1H${line}`
    return `${writes}${park}`
  }
  return {
    region: { top: 2, left: 1, bottom: 3, right: 8 },
    sentinel: { row: 4, col: 1 },
    cursorRow: rows,
    seed: screen("AB".repeat(Math.ceil(cols / 2)).slice(0, cols)),
    edit: `\x1b#8${park}`,
    expected: screen("E".repeat(cols)),
    timeoutMs: 5000,
    pollMs: 250,
    minRows: 5,
    minCols: 9,
  }
}

export const resetProbes: ProbeDefinition[] = [
  {
    ...probe(
      "reset.sgr",
      (ctx) => {
        ctx.feed("\x1b[1;3;7mX\x1b[0mY")
        const before = ctx.getCell(0, 0)
        const after = ctx.getCell(0, 1)
        const state = { before, after }
        const expected = "SGR 0 clears measured bold, italic, and inverse styling on Y"
        if (before.char !== "X" || after.char !== "Y") {
          return parserStateResult(null, expected, state, "Styled control or reset cell was not measured")
        }
        // #30701, @cto ruling C: graded on the styles the control measurably shows. A style field the
        // adapter never populates is left out, and a control that shows none has no observable.
        const styles = (["bold", "italic", "inverse"] as const).filter((style) => before[style] === true)
        if (styles.length === 0) {
          return notTestedResult("bold, italic and inverse on the styled control cell in the headless readback", state)
        }
        const unshown = (["bold", "italic", "inverse"] as const).filter((style) => before[style] !== true)
        return parserStateResult(
          styles.every((style) => !after[style]),
          expected,
          state,
          unshown.length > 0
            ? `Graded on ${styles.join(" and ")}; ${unshown.join(" and ")} not shown by the styled control`
            : undefined,
        )
      },
      async (ctx) => {
        // The shared DECRQSS readback decides this SGR-state claim structurally wherever the
        // terminal answers — sgr.reset binds the same shape from sgr.ts — and a terminal that
        // stays silent keeps the capture/cursor evidence below, so a missing readback is never a
        // negative. Both guards run first: an invalid or undersized terminal is never written to
        // or queried.
        const captureRefusal = ctx.capture ? sgrCaptureTooSmall(ctx, "reset.sgr") : undefined
        if (captureRefusal) return captureRefusal
        const measuredRoom =
          Number.isSafeInteger(ctx.rows) && Number.isSafeInteger(ctx.cols) && ctx.rows >= 1 && ctx.cols >= 2
        // A silent DECRQSS attempt still wrote its sequence and query, so the named refusal from
        // the region oracle must report QUERY evidence, not the zero-byte "none" shape.
        let readbackAttempted = false
        if (measuredRoom) {
          readbackAttempted = true
          const readback = await sgrReadbackDecision(
            ctx,
            "reset.sgr",
            "\x1b[0m",
            { require: [], forbid: [1, 3, 7] },
            {
              sequence: "\x1b[1;3;7m",
              baseline: { require: [], forbid: [1, 3, 7] },
              readback: { require: [1, 3, 7] },
            },
          )
          if (readback) return readback
        }
        if (ctx.capture) {
          // The same-run region oracle owns this row wherever the run can map cells onto its own
          // window: a reset with no independent reference is declined by name, and every other row
          // is graded against expected and ignored frames painted in this same run.
          const regionReadback = RESET_FAMILY_CAPTURE["reset.sgr"]
          if (regionReadback) {
            const verdict = await captureRegionVerdict(
              ctx,
              "reset.sgr",
              regionReadback,
              readbackAttempted ? "query" : "none",
            )
            if (verdict) return verdict
          }
          try {
            return await sgrCaptureFrames(
              ctx,
              "\x1b[0m\x1b[2J\x1b[3;3H\x1b[1;3;7mX",
              "\x1b[0m\x1b[2J\x1b[3;3H\x1b[1;3;7mX\x1b[0mY",
              "reset.sgr",
              { setup: "\x1b[1;3;7m", reset: "\x1b[0m" },
              "The control shows a bold+italic+inverse X; the target adds reset Y, so review can check Y is unstyled",
            )
          } finally {
            ctx.write("\x1b[0m")
          }
        }
        if (!measuredRoom) {
          return {
            pass: false,
            observation: {
              outcome: "inconclusive",
              reason: "insufficient-evidence",
              evidence: "none",
              note: `Reset fixture needs at least 1x2, measured ${ctx.rows}x${ctx.cols}`,
            },
          }
        }
        ctx.write("\x1b[1;1H\x1b[2K")
        ctx.write("\x1b[1m") // bold
        ctx.write("\x1b[0m") // reset
        ctx.write("X")
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
            note: "Cursor advance does not measure SGR styling after reset",
          },
        }
      },
    ),
    termNeedsGeometry: true,
  },

  {
    ...probe(
      "reset.ris",
      (ctx) => {
        ctx.feed("Hello World")
        const before = { ...ctx.getCursor(), text: ctx.getText() }
        ctx.feed("\x1bc")
        const after = { ...ctx.getCursor(), text: ctx.getText() }
        const expected = "RIS returns the cursor home and clears measured text"
        if (!before.text.includes("Hello World") || before.x === 0) {
          return parserStateResult(null, expected, { before, after }, "RIS control state was not measured")
        }
        return parserStateResult(after.x === 0 && after.y === 0 && !after.text.includes("Hello World"), expected, {
          before,
          after,
        })
      },
      async (ctx) => {
        if (!Number.isSafeInteger(ctx.rows) || !Number.isSafeInteger(ctx.cols) || ctx.rows < 5 || ctx.cols < 5) {
          return {
            pass: false,
            observation: {
              outcome: "inconclusive",
              reason: "insufficient-evidence",
              evidence: "none",
              note: `Reset fixture needs at least 5x5, measured ${ctx.rows}x${ctx.cols}`,
            },
          }
        }
        ctx.write("\x1b[5;5H") // Move somewhere away from 1;1
        const before = await ctx.queryCursorPosition()
        if (!before) {
          return { pass: false, observation: { outcome: "inconclusive", reason: "no-response", evidence: "query" } }
        }
        ctx.write("\x1bc") // RIS — full reset
        const pos = await ctx.queryCursorPosition()
        if (!pos) {
          return { pass: false, observation: { outcome: "inconclusive", reason: "no-response", evidence: "query" } }
        }
        const measured = { before, after: pos }
        const setup = before.row === 5 && before.col === 5
        const home = pos.row === 1 && pos.col === 1
        return {
          pass: setup && home,
          response: JSON.stringify(measured),
          observation: {
            outcome: setup ? (home ? "supported" : "unsupported") : "inconclusive",
            ...(setup ? {} : { reason: "insufficient-evidence" as const }),
            evidence: "query",
            note: "Measured RIS cursor reset; other reset effects were not inspected",
          },
          ...(setup && {
            assertions: [
              {
                kind: home ? ("positive" as const) : ("negative" as const),
                expected: "RIS homes cursor from 5;5",
                observed: JSON.stringify(measured),
              },
            ],
          }),
        }
      },
    ),
    termNeedsGeometry: true,
  },

  {
    ...probe(
      "reset.soft",
      (ctx) => {
        ctx.feed("\x1b[?1h") // enable application cursor
        const before = ctx.getMode("applicationCursor")
        ctx.feed("Hello")
        ctx.feed("\x1b[!p")
        const after = ctx.getMode("applicationCursor")
        // #30701, @cto ruling C: a getMode that reports no applicationCursor state is a field the backend
        // does not expose (TEST TODO); an exposed mode that stayed off is still unmeasured.
        if (typeof before !== "boolean") {
          return notTestedResult("the application-cursor mode (DECCKM) state in the headless getMode readback", {
            before,
            after,
          })
        }
        return parserStateResult(
          before ? !after : null,
          "DECSTR clears an enabled application-cursor mode",
          { before, after },
          before ? undefined : "Application-cursor mode was not enabled before DECSTR",
        )
      },
      async (ctx) => {
        if (!Number.isSafeInteger(ctx.rows) || !Number.isSafeInteger(ctx.cols) || ctx.rows < 5 || ctx.cols < 5) {
          return {
            pass: false,
            observation: {
              outcome: "inconclusive",
              reason: "insufficient-evidence",
              evidence: "none",
              note: `Reset fixture needs at least 5x5, measured ${ctx.rows}x${ctx.cols}`,
            },
          }
        }
        const before = await queryDecrpm(ctx, 1)
        if (before === null || before === 0) {
          return {
            pass: false,
            observation: {
              outcome: "inconclusive",
              reason: "no-response",
              evidence: "query",
              note: "Cannot restore prior application-cursor mode without its readback",
            },
          }
        }
        ctx.write("\x1b[?1h")
        try {
          const enabled = await queryDecrpm(ctx, 1)
          ctx.write("\x1b[!p") // DECSTR — soft reset
          const after = await queryDecrpm(ctx, 1)
          // The stored readings keep the Ps (#30557 r2).
          const reading = (ps: DecrpmPs | null) => (ps === null ? null : decrpmReading(ps))
          const measured = { before: reading(before), enabled: reading(enabled), after: reading(after) }
          if (!(enabled === 1 || enabled === 3) || after === null || after === 0) {
            return {
              pass: false,
              response: JSON.stringify(measured),
              observation: {
                outcome: "inconclusive",
                reason: "insufficient-evidence",
                evidence: "query",
                note:
                  enabled === 4
                    ? "DECCKM is permanently reset (Ps 4); the terminal cannot enable it, so DECSTR's reset of it is unmeasured"
                    : "Application-cursor mode setup or reset readback was unavailable",
              },
            }
          }
          const pass = after === 2 || after === 4
          return {
            pass,
            response: JSON.stringify(measured),
            observation: { outcome: pass ? "supported" : "unsupported", evidence: "query" },
            assertions: [
              {
                kind: pass ? "positive" : "negative",
                expected: "DECSTR resets previously enabled DECCKM mode 1",
                observed: JSON.stringify(measured),
              },
            ],
          }
        } finally {
          if (before === 1 || before === 3) ctx.write("\x1b[?1h")
          else ctx.write("\x1b[?1l")
        }
      },
    ),
    termNeedsGeometry: true,
  },

  // DECALN — screen alignment test (fill screen with 'E')
  {
    ...probe(
      "reset.decaln",
      (ctx) => {
        ctx.feed("\x1b#8") // DECALN — fill screen with 'E'
        const cell = ctx.getCell(0, 0)
        return parserStateResult(cell.char === "E", "DECALN fills the measured cell (0,0) with E", { cell })
      },
      async (ctx) => {
        const rows = ctx.rows
        const cols = ctx.cols
        const capture = ctx.capture
        const readback = decalnReadback(rows, cols)
        if (readback) {
          // The verdict path owns this row wherever the run can map cells onto its own window.
          const verdict = await captureRegionVerdict(ctx, "reset.decaln", readback)
          if (verdict) return verdict
        }
        if (!capture || !Number.isSafeInteger(rows) || !Number.isSafeInteger(cols) || rows < 2 || cols < 2) {
          const note = `DECALN pixel fixture needs capture and measured 2x2 geometry; measured ${rows}x${cols}`
          return {
            pass: false,
            note,
            observation: { outcome: "inconclusive", reason: "insufficient-evidence", evidence: "none", note },
          }
        }
        const seed = "AB".repeat(Math.ceil(cols / 2)).slice(0, cols)
        // The collector owns a disposable screen; cleanup does not claim restoration of arbitrary prior content.
        try {
          ctx.write("\x1b[0m\x1b[2J\x1b[H")
          for (let row = 1; row <= rows; row++) ctx.write(`\x1b[${row};1H${seed}`)
          ctx.write("\x1b[H")
          const control = await capture({ role: "control", label: "Known non-E AB grid before DECALN" })
          ctx.write("\x1b#8")
          const postAlignmentCursor = await ctx.queryCursorPosition()
          const target = await capture({ role: "target", label: "DECALN alignment grid after ESC # 8" })
          const delayedCaptureMs = 5000
          await new Promise<void>((resolve) => {
            setTimeout(resolve, delayedCaptureMs)
          })
          const delayedTarget = await capture({
            role: "target",
            label: "DECALN alignment grid after delayed checkpoint",
          })
          ctx.write("\x1b[H")
          const cursorOnlyControl = await capture({ role: "control", label: "Cursor-only control after CUP home" })
          ctx.write("X")
          const redrawControl = await capture({ role: "control", label: "Redraw control after one ordinary glyph" })
          const observed = JSON.stringify({
            rows,
            cols,
            seed,
            postAlignmentCursor,
            control,
            target,
            delayedCaptureMs,
            delayedTarget,
            cursorOnlyControl,
            redrawControl,
          })
          return {
            pass: false,
            response: observed,
            observation: {
              outcome: "inconclusive",
              reason: "insufficient-evidence",
              evidence: "pixels",
              screenshotRef: target.ref,
              frames: [control, target, delayedTarget, cursorOnlyControl, redrawControl],
              note: `${postAlignmentCursor === null ? "No post-DECALN CPR response; processing barrier unconfirmed. " : ""}Known non-E grid, initial and delayed DECALN targets, cursor-only control and ordinary-glyph redraw control captured; repeated E glyphs across measured rows and columns require independent review. CPR at the already-homed cursor records responsiveness, not DECALN recognition or render completion`,
            },
            assertions: [
              {
                kind: "positive",
                expected: `Control shows alternating A/B across ${rows} rows and ${cols} columns; DECALN target shows repeated E across that same measured grid`,
                observed,
                note: "capture-only assertion; glyphs and full-grid coverage must be independently reviewed",
              },
            ],
          }
        } finally {
          ctx.write("\x1b[0m\x1b[2J\x1b[H")
        }
      },
    ),
    termNeedsGeometry: true,
    cellReadback: true,
    textClaim: "characters",
  },

  {
    ...probe(
      "reset.method",
      (ctx) => {
        ctx.feed("Hello World")
        const before = { ...ctx.getCursor(), text: ctx.getText() }
        ctx.reset()
        const after = { ...ctx.getCursor(), text: ctx.getText() }
        const expected = "Reset method returns the cursor home and clears measured text"
        if (!before.text.includes("Hello World") || before.x === 0) {
          return parserStateResult(null, expected, { before, after }, "Reset-method control state was not measured")
        }
        return parserStateResult(after.x === 0 && after.y === 0 && !after.text.includes("Hello World"), expected, {
          before,
          after,
        })
      },
      () => {
        const note = "The app context has no reset() method or equivalent state readback"
        return Promise.resolve({
          pass: false,
          note,
          observation: {
            outcome: "inconclusive" as const,
            reason: "insufficient-evidence" as const,
            evidence: "none" as const,
            note,
          },
        })
      },
    ),
  },
]
