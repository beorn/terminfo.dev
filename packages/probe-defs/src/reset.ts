import type { ProbeDefinition } from "./types.ts"
import { parserStateResult, probe } from "./helpers.ts"

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
        if (before.char !== "X" || after.char !== "Y" || !before.bold || !before.italic || !before.inverse) {
          return parserStateResult(null, expected, state, "Styled control or reset cell was not measured")
        }
        return parserStateResult(!after.bold && !after.italic && !after.inverse, expected, state)
      },
      async (ctx) => {
        if (!Number.isSafeInteger(ctx.rows) || !Number.isSafeInteger(ctx.cols) || ctx.rows < 1 || ctx.cols < 2) {
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
        const before = await ctx.queryMode(1)
        if (before === null || before === "unknown") {
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
          const enabled = await ctx.queryMode(1)
          ctx.write("\x1b[!p") // DECSTR — soft reset
          const after = await ctx.queryMode(1)
          const measured = { before, enabled, after }
          if (enabled !== "set" || after === null || after === "unknown") {
            return {
              pass: false,
              response: JSON.stringify(measured),
              observation: {
                outcome: "inconclusive",
                reason: "insufficient-evidence",
                evidence: "query",
                note: "Application-cursor mode setup or reset readback was unavailable",
              },
            }
          }
          const pass = after === "reset"
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
          if (before === "set") ctx.write("\x1b[?1h")
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
          const delayedCaptureMs = 1000
          await new Promise<void>((resolve) => {
            setTimeout(resolve, delayedCaptureMs)
          })
          const delayedTarget = await capture({
            role: "target",
            label: "DECALN alignment grid after delayed checkpoint",
          })
          ctx.write("\x1b[HX")
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
              frames: [control, target, delayedTarget, redrawControl],
              note: `${postAlignmentCursor === null ? "No post-DECALN CPR response; processing barrier unconfirmed. " : ""}Known non-E grid, initial and delayed DECALN targets and diagnostic redraw control after one ordinary glyph captured; repeated E glyphs across measured rows and columns require independent review`,
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
