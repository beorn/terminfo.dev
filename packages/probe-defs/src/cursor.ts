import type { ProbeDefinition, ProbeResult, TermContext, TermlessContext } from "./types.ts"
import { cursorProbe, parserStateResult, probe } from "./helpers.ts"

function headlessPosition(ctx: TermlessContext, row: number, col: number): ProbeResult {
  const cursor = ctx.getCursor()
  return parserStateResult(cursor.y === row && cursor.x === col, `cursor row=${row}, col=${col} (0-based)`, cursor)
}

function headlessSavedCursor(
  ctx: TermlessContext,
  initial: { row: number; col: number },
  displaced: { row: number; col: number },
  save: string,
  restore: string,
): ProbeResult {
  ctx.feed(`\x1b[${initial.row};${initial.col}H`)
  const setup = ctx.getCursor()
  if (setup.y !== initial.row - 1 || setup.x !== initial.col - 1) {
    return {
      pass: false,
      response: JSON.stringify({ setup }),
      observation: {
        outcome: "inconclusive",
        reason: "insufficient-evidence",
        evidence: "parser-state",
        note: "Save fixture initial CUP was not measured at its target",
      },
    }
  }
  ctx.feed(save)
  ctx.feed(`\x1b[${displaced.row};${displaced.col}H`)
  const displacedPosition = ctx.getCursor()
  if (displacedPosition.y !== displaced.row - 1 || displacedPosition.x !== displaced.col - 1) {
    ctx.feed(restore)
    return {
      pass: false,
      response: JSON.stringify({ setup, displaced: displacedPosition }),
      observation: {
        outcome: "inconclusive",
        reason: "insufficient-evidence",
        evidence: "parser-state",
        note: "Save fixture displacement was not measured at its target",
      },
    }
  }
  ctx.feed(restore)
  const final = ctx.getCursor()
  return parserStateResult(
    final.y === initial.row - 1 && final.x === initial.col - 1,
    `saved cursor returns to row ${initial.row - 1}, col ${initial.col - 1}`,
    { setup, displaced: displacedPosition, final },
  )
}

async function appSavedCursor(
  ctx: TermContext,
  initial: { row: number; col: number },
  displaced: { row: number; col: number },
  save: string,
  restore: string,
): Promise<ProbeResult> {
  ctx.write(`\x1b[${initial.row};${initial.col}H`)
  const setup = await ctx.queryCursorPosition()
  if (!setup || setup.row !== initial.row || setup.col !== initial.col) {
    return {
      pass: false,
      response: JSON.stringify({ setup }),
      observation: {
        outcome: "inconclusive",
        reason: setup ? "insufficient-evidence" : "no-response",
        evidence: "query",
        note: "Save fixture initial CUP was not measured at its target",
      },
    }
  }
  ctx.write(save)
  let restored = false
  try {
    ctx.write(`\x1b[${displaced.row};${displaced.col}H`)
    const displacedPosition = await ctx.queryCursorPosition()
    if (!displacedPosition || displacedPosition.row !== displaced.row || displacedPosition.col !== displaced.col) {
      return {
        pass: false,
        response: JSON.stringify({ setup, displaced: displacedPosition }),
        observation: {
          outcome: "inconclusive",
          reason: displacedPosition ? "insufficient-evidence" : "no-response",
          evidence: "query",
          note: "Save fixture displacement was not measured at its target",
        },
      }
    }
    ctx.write(restore)
    restored = true
    const final = await ctx.queryCursorPosition()
    const response = JSON.stringify({ setup, displaced: displacedPosition, final })
    if (!final) {
      return {
        pass: false,
        response,
        observation: { outcome: "inconclusive", reason: "no-response", evidence: "query" },
      }
    }
    const pass = final.row === initial.row && final.col === initial.col
    return {
      pass,
      response,
      observation: { outcome: pass ? "supported" : "unsupported", evidence: "query" },
      assertions: [
        {
          kind: pass ? "positive" : "negative",
          expected: `saved cursor returns to ${initial.row};${initial.col} after measured displacement`,
          observed: response,
        },
      ],
    }
  } finally {
    if (!restored) ctx.write(restore)
  }
}

export const cursorProbes: ProbeDefinition[] = [
  // CUP — cursor absolute position (1-based params → 0-based termless)
  cursorProbe("cursor.move.absolute", "", "\x1b[5;10H", { row: 4, col: 9 }, { row: 0, col: 0 }),

  // CUP with no args — home
  cursorProbe("cursor.move.home", "ABC", "\x1b[H", { row: 0, col: 0 }, { row: 0, col: 3 }),

  // CUF — cursor forward
  cursorProbe("cursor.move.forward", "", "\x1b[5C", { row: 0, col: 5 }, { row: 0, col: 0 }),

  // CUB — cursor back
  cursorProbe("cursor.move.back", "ABC", "\x1b[2D", { row: 0, col: 1 }, { row: 0, col: 3 }),

  // CUD — cursor down
  cursorProbe("cursor.move.down", "", "\x1b[3B", { row: 3, col: 0 }, { row: 0, col: 0 }),

  // CUU — cursor up
  cursorProbe("cursor.move.up", "\x1b[5B", "\x1b[2A", { row: 3, col: 0 }, { row: 5, col: 0 }),

  // DECTCEM — cursor hide
  {
    ...probe(
      "cursor.hide",
      (ctx) => {
        const before = ctx.getCursor().visible
        const expected = "Cursor parser visibility changes from shown to hidden and its initial state is restored"
        if (before === null) {
          return parserStateResult(null, expected, { before }, "Initial cursor visibility readback is unavailable")
        }
        let shown: boolean | null = null
        let hidden: boolean | null = null
        try {
          ctx.feed("\x1b[?25h")
          shown = ctx.getCursor().visible
          if (shown === true) {
            ctx.feed("\x1b[?25l")
            hidden = ctx.getCursor().visible
          }
        } finally {
          ctx.feed(before ? "\x1b[?25h" : "\x1b[?25l")
        }
        const restored = ctx.getCursor().visible
        const qualified = shown === true && hidden !== null && restored === before
        return parserStateResult(
          qualified ? hidden === false : null,
          expected,
          { before, shown, hidden, restored },
          qualified
            ? "Parser visibility state only; display pixels were not captured"
            : "Shown control, hidden readback or initial-state restoration was not established",
        )
      },
      async (ctx) => {
        if (!ctx.capture) {
          const note = "No cursor pixel readback for visibility"
          return {
            pass: false,
            note,
            observation: { outcome: "inconclusive", reason: "insufficient-evidence", evidence: "none", note },
          }
        }
        const control = await ctx.capture({ role: "control", label: "Visible cursor" })
        try {
          ctx.write("\x1b[?25l")
          const target = await ctx.capture({ role: "target", label: "Hidden cursor" })
          return {
            pass: false,
            observation: {
              outcome: "inconclusive",
              reason: "insufficient-evidence",
              evidence: "pixels",
              screenshotRef: target.ref,
              frames: [control, target],
              note: "Cursor pixels captured; visibility difference requires review",
            },
          }
        } finally {
          ctx.write("\x1b[?25h")
        }
      },
    ),
    termlessObservationEvidence: "parser-state",
  },

  // DECSCUSR — cursor shape
  probe(
    "cursor.shape",
    (ctx) => {
      ctx.feed("\x1b[6 q")
      const style = ctx.getCursor().style
      return parserStateResult(
        style === null ? null : style === "beam",
        "DECSCUSR reports a beam cursor after CSI 6 SP q",
        { style },
        style === null ? "Cursor style readback is unavailable" : undefined,
      )
    },
    async (ctx) => {
      if (!ctx.capture) {
        const note = "No cursor pixel readback for shape"
        return {
          pass: false,
          note,
          observation: { outcome: "inconclusive", reason: "insufficient-evidence", evidence: "none", note },
        }
      }
      const control = await ctx.capture({ role: "control", label: "Default cursor shape" })
      try {
        ctx.write("\x1b[5 q") // blinking bar
        const target = await ctx.capture({ role: "target", label: "Bar cursor shape" })
        return {
          pass: false,
          observation: {
            outcome: "inconclusive",
            reason: "insufficient-evidence",
            evidence: "pixels",
            screenshotRef: target.ref,
            frames: [control, target],
            note: "Cursor pixels captured; shape difference requires review",
          },
        }
      } finally {
        ctx.write("\x1b[0 q")
      }
    },
  ),

  // CHA — cursor horizontal absolute
  cursorProbe("cursor.horizontal-absolute", "\x1b[3;1H", "\x1b[15G", { row: 2, col: 14 }, { row: 2, col: 0 }),

  // CNL — cursor next line
  cursorProbe("cursor.next-line", "\x1b[3;5H", "\x1b[E", { row: 3, col: 0 }, { row: 2, col: 4 }),

  // DSR 6 — cursor position report
  {
    ...probe(
      "cursor.position-report",
      (ctx) => {
        ctx.feed("\x1b[3;5H")
        const response = ctx.feedCapture("\x1b[6n")
        if (!response) {
          return { pass: false, observation: { outcome: "inconclusive", reason: "no-response", evidence: "query" } }
        }
        const match = response.startsWith("\x1b[") ? /^([1-9]\d*);([1-9]\d*)R$/.exec(response.slice(2)) : null
        const row = Number(match?.[1])
        const col = Number(match?.[2])
        if (!match || !Number.isSafeInteger(row) || !Number.isSafeInteger(col)) {
          return {
            pass: false,
            response,
            observation: { outcome: "inconclusive", reason: "invalid-reply", evidence: "query" },
          }
        }
        const setup = ctx.getCursor()
        const measured = JSON.stringify({ setup, report: response })
        if (setup.y !== 2 || setup.x !== 4) {
          return {
            pass: false,
            response: measured,
            observation: {
              outcome: "inconclusive",
              reason: "insufficient-evidence",
              evidence: "query",
              note: "DSR setup CUP was not independently measured at 3;5",
            },
          }
        }
        const pass = row === 3 && col === 5
        return {
          pass,
          response: measured,
          observation: { outcome: pass ? "supported" : "unsupported", evidence: "query" },
          assertions: [
            {
              kind: pass ? "positive" : "negative",
              expected: "ESC[3;5R after independently measured CUP 3;5",
              observed: measured,
            },
          ],
        }
      },
      async (ctx) => {
        if (!Number.isSafeInteger(ctx.rows) || !Number.isSafeInteger(ctx.cols) || ctx.rows < 3 || ctx.cols < 5) {
          return {
            pass: false,
            observation: {
              outcome: "inconclusive",
              reason: "insufficient-evidence",
              evidence: "none",
              note: "cursor.position-report fixture needs at least 3x5 measured cells",
            },
          }
        }
        ctx.write("\x1b[3;5H") // Move to row 3, col 5
        const pos = await ctx.queryCursorPosition()
        if (!pos) {
          return { pass: false, observation: { outcome: "inconclusive", reason: "no-response", evidence: "query" } }
        }
        return {
          pass: false,
          response: JSON.stringify({ report: pos }),
          observation: {
            outcome: "inconclusive",
            reason: "insufficient-evidence",
            evidence: "query",
            note: "CPR alone cannot independently qualify its own CUP setup",
          },
        }
      },
    ),
    termNeedsGeometry: true,

    termlessObservationEvidence: "query",
  },

  // CSI s / CSI u — ANSI save/restore cursor (distinct from DECSC/DECRC)
  {
    ...probe(
      "cursor.ansi-save",
      (ctx) => headlessSavedCursor(ctx, { row: 3, col: 5 }, { row: 10, col: 15 }, "\x1b[s", "\x1b[u"),
      async (ctx) => {
        if (!Number.isSafeInteger(ctx.rows) || !Number.isSafeInteger(ctx.cols) || ctx.rows < 10 || ctx.cols < 15) {
          return {
            pass: false,
            observation: {
              outcome: "inconclusive",
              reason: "insufficient-evidence",
              evidence: "none",
              note: "cursor.ansi-save fixture needs at least 10x15 measured cells",
            },
          }
        }
        return appSavedCursor(ctx, { row: 3, col: 5 }, { row: 10, col: 15 }, "\x1b[s", "\x1b[u")
      },
    ),
    termNeedsGeometry: true,

    termlessObservationEvidence: "parser-state",
  },

  {
    ...probe(
      "cursor.ansi-restore",
      (ctx) => headlessSavedCursor(ctx, { row: 4, col: 6 }, { row: 12, col: 18 }, "\x1b[s", "\x1b[u"),
      async (ctx) => {
        if (!Number.isSafeInteger(ctx.rows) || !Number.isSafeInteger(ctx.cols) || ctx.rows < 12 || ctx.cols < 18) {
          return {
            pass: false,
            observation: {
              outcome: "inconclusive",
              reason: "insufficient-evidence",
              evidence: "none",
              note: "cursor.ansi-restore fixture needs at least 12x18 measured cells",
            },
          }
        }
        return appSavedCursor(ctx, { row: 4, col: 6 }, { row: 12, col: 18 }, "\x1b[s", "\x1b[u")
      },
    ),
    termNeedsGeometry: true,

    termlessObservationEvidence: "parser-state",
  },

  // DECSC/DECRC — cursor save/restore
  {
    ...probe(
      "cursor.save-restore",
      (ctx) => headlessSavedCursor(ctx, { row: 3, col: 5 }, { row: 10, col: 10 }, "\x1b7", "\x1b8"),
      async (ctx) => {
        if (!Number.isSafeInteger(ctx.rows) || !Number.isSafeInteger(ctx.cols) || ctx.rows < 10 || ctx.cols < 10) {
          return {
            pass: false,
            observation: {
              outcome: "inconclusive",
              reason: "insufficient-evidence",
              evidence: "none",
              note: "cursor.save-restore fixture needs at least 10x10 measured cells",
            },
          }
        }
        return appSavedCursor(ctx, { row: 3, col: 5 }, { row: 10, col: 10 }, "\x1b7", "\x1b8")
      },
    ),
    termNeedsGeometry: true,

    termlessObservationEvidence: "parser-state",
  },

  // DECSET 45 — reverse wrap mode
  probe(
    "cursor.reverse-wrap",
    (ctx) => {
      const cols = ctx.cols
      const rows = ctx.getScrollback().screenLines
      const expected = "Backspace reverses a wrap across the measured row width"
      if (!Number.isSafeInteger(cols) || cols < 2 || !Number.isSafeInteger(rows) || rows < 2) {
        return parserStateResult(
          null,
          expected,
          { rows, cols },
          "Measured grid needs two rows and at least two columns",
        )
      }
      const originallyAutoWrap = ctx.getMode("autoWrap")
      try {
        ctx.feed("\x1b[?7h") // enable auto-wrap
        ctx.feed("\x1b[?45h") // enable reverse wrap
        ctx.feed("\x1b[H")
        const start = ctx.getCursor()
        if (start.y !== 0 || start.x !== 0) {
          return parserStateResult(null, expected, { cols, start }, "Home-position control was not measured")
        }
        ctx.feed("A".repeat(cols) + "B") // B forces a deferred wrap into row 1
        const wrapped = ctx.getCursor()
        if (wrapped.y !== 1 || wrapped.x !== 1) {
          return parserStateResult(null, expected, { cols, start, wrapped }, "Second-row displacement was not measured")
        }
        ctx.feed("\x08\x08") // first reaches col 0; second must reverse-wrap
        const cursor = ctx.getCursor()
        return parserStateResult(cursor.y === 0 && cursor.x === cols - 1, expected, { cols, start, wrapped, cursor })
      } finally {
        ctx.feed("\x1b[?45l")
        ctx.feed(originallyAutoWrap ? "\x1b[?7h" : "\x1b[?7l")
      }
    },
    async (ctx) => {
      ctx.write("\x1b[?45h") // enable reverse wrap
      try {
        const pos = await ctx.queryCursorPosition()
        return {
          pass: false,
          ...(pos && { response: JSON.stringify(pos) }),
          observation: {
            outcome: "inconclusive",
            reason: pos ? "insufficient-evidence" : "no-response",
            evidence: "query",
            note: "Cursor reply after enabling reverse wrap does not measure backward-wrap movement",
          },
        }
      } finally {
        ctx.write("\x1b[?45l") // disable reverse wrap after the query, including errors
      }
    },
  ),

  // CUP at screen boundaries — cursor should clamp to valid range
  {
    ...probe(
      "cursor.cup-boundaries",
      (ctx) => {
        const rows = ctx.getScrollback().screenLines
        const cols = ctx.cols
        if (!Number.isSafeInteger(rows) || !Number.isSafeInteger(cols) || rows < 2 || cols < 2) {
          return {
            pass: false,
            observation: {
              outcome: "inconclusive",
              reason: "insufficient-evidence",
              evidence: "none",
              note: `CUP edge fixture needs an initialized grid of at least 2x2, measured ${rows}x${cols}`,
            },
          }
        }
        ctx.feed("\x1b[1;1H")
        const origin = ctx.getCursor()
        const originResponse = JSON.stringify({ rows, cols, origin })
        if (origin.y !== 0 || origin.x !== 0) {
          return {
            pass: false,
            response: originResponse,
            observation: {
              outcome: "inconclusive",
              reason: "insufficient-evidence",
              evidence: "parser-state",
              note: "CUP home control did not reach 0;0",
            },
          }
        }
        ctx.feed(`\x1b[${rows};${cols}H`)
        const edge = ctx.getCursor()
        const edgeResponse = JSON.stringify({ rows, cols, origin, edge })
        if (edge.y !== rows - 1 || edge.x !== cols - 1) {
          return {
            pass: false,
            response: edgeResponse,
            observation: {
              outcome: "inconclusive",
              reason: "insufficient-evidence",
              evidence: "parser-state",
              note: `CUP edge control did not reach ${rows - 1};${cols - 1}`,
            },
          }
        }
        ctx.feed("\x1b[1;1H")
        const beforeTarget = ctx.getCursor()
        const beforeResponse = JSON.stringify({ rows, cols, origin, edge, beforeTarget })
        if (beforeTarget.y !== 0 || beforeTarget.x !== 0) {
          return {
            pass: false,
            response: beforeResponse,
            observation: {
              outcome: "inconclusive",
              reason: "insufficient-evidence",
              evidence: "parser-state",
              note: "CUP reset control did not reach 0;0",
            },
          }
        }
        const targetRow = Math.max(999, rows + 1)
        const targetCol = Math.max(999, cols + 1)
        ctx.feed(`\x1b[${targetRow};${targetCol}H`)
        const final = ctx.getCursor()
        const response = JSON.stringify({ rows, cols, origin, edge, beforeTarget, final })
        if (!Number.isSafeInteger(final.y) || !Number.isSafeInteger(final.x)) {
          return {
            pass: false,
            response,
            observation: {
              outcome: "inconclusive",
              reason: "insufficient-evidence",
              evidence: "parser-state",
              note: "CUP target cursor readback is invalid",
            },
          }
        }
        const pass = final.y === rows - 1 && final.x === cols - 1
        return {
          pass,
          response,
          observation: { outcome: pass ? "supported" : "unsupported", evidence: "parser-state" },
          assertions: [
            {
              kind: pass ? "positive" : "negative",
              expected: `CUP ${targetRow};${targetCol} clamps to measured ${rows - 1};${cols - 1} after qualified edge`,
              observed: response,
            },
          ],
        }
      },
      async (ctx) => {
        const { rows, cols } = ctx
        if (!Number.isSafeInteger(rows) || !Number.isSafeInteger(cols) || rows < 2 || cols < 2) {
          return {
            pass: false,
            observation: {
              outcome: "inconclusive",
              reason: "insufficient-evidence",
              evidence: "none",
              note: `CUP edge fixture needs at least 2x2, measured ${rows}x${cols}`,
            },
          }
        }
        ctx.write("\x1b[1;1H")
        const origin = await ctx.queryCursorPosition()
        if (!origin) {
          return { pass: false, observation: { outcome: "inconclusive", reason: "no-response", evidence: "query" } }
        }
        if (origin.row !== 1 || origin.col !== 1) {
          return {
            pass: false,
            response: JSON.stringify({ origin }),
            observation: {
              outcome: "inconclusive",
              reason: "insufficient-evidence",
              evidence: "query",
              note: "CUP home control did not reach 1;1",
            },
          }
        }
        ctx.write(`\x1b[${rows};${cols}H`)
        const edge = await ctx.queryCursorPosition()
        if (!edge) {
          return {
            pass: false,
            response: JSON.stringify({ origin, edge }),
            observation: { outcome: "inconclusive", reason: "no-response", evidence: "query" },
          }
        }
        if (edge.row !== rows || edge.col !== cols) {
          return {
            pass: false,
            response: JSON.stringify({ origin, edge }),
            observation: {
              outcome: "inconclusive",
              reason: "insufficient-evidence",
              evidence: "query",
              note: `CUP edge control did not reach ${rows};${cols}`,
            },
          }
        }
        ctx.write("\x1b[1;1H")
        const beforeTarget = await ctx.queryCursorPosition()
        if (!beforeTarget) {
          return {
            pass: false,
            response: JSON.stringify({ origin, edge, beforeTarget }),
            observation: { outcome: "inconclusive", reason: "no-response", evidence: "query" },
          }
        }
        if (beforeTarget.row !== 1 || beforeTarget.col !== 1) {
          return {
            pass: false,
            response: JSON.stringify({ origin, edge, beforeTarget }),
            observation: {
              outcome: "inconclusive",
              reason: "insufficient-evidence",
              evidence: "query",
              note: "CUP reset control did not reach 1;1",
            },
          }
        }
        const targetRow = Math.max(999, rows + 1)
        const targetCol = Math.max(999, cols + 1)
        ctx.write(`\x1b[${targetRow};${targetCol}H`)
        const final = await ctx.queryCursorPosition()
        const response = JSON.stringify({ rows, cols, origin, edge, beforeTarget, final })
        if (!final) {
          return {
            pass: false,
            response,
            observation: { outcome: "inconclusive", reason: "no-response", evidence: "query" },
          }
        }
        const pass = final.row === rows && final.col === cols
        return {
          pass,
          response,
          observation: { outcome: pass ? "supported" : "unsupported", evidence: "query" },
          assertions: [
            {
              kind: pass ? "positive" : "negative",
              expected: `CUP ${targetRow};${targetCol} clamps to measured ${rows};${cols} after qualified edge`,
              observed: response,
            },
          ],
        }
      },
    ),
    termNeedsGeometry: true,

    termlessObservationEvidence: "parser-state",
  },

  // CUU past top of screen — cursor should stop at row 0
  cursorProbe("cursor.cuu-past-top", "\x1b[4;1H", "\x1b[999A", { row: 0, col: 0 }, { row: 3, col: 0 }),

  // CUD past bottom of screen — cursor should stop at last row
  {
    ...probe(
      "cursor.cud-past-bottom",
      (ctx) => {
        const rows = ctx.getScrollback().screenLines
        if (!Number.isSafeInteger(rows) || rows < 1) {
          return {
            pass: false,
            observation: {
              outcome: "inconclusive",
              reason: "insufficient-evidence",
              evidence: "none",
              note: "Initialized screen row count is unavailable",
            },
          }
        }
        ctx.feed("\x1b[1;1H") // position at row 0
        const origin = ctx.getCursor()
        if (origin.y !== 0 || origin.x !== 0) {
          return {
            pass: false,
            response: JSON.stringify({ rows, origin }),
            observation: {
              outcome: "inconclusive",
              reason: "insufficient-evidence",
              evidence: "parser-state",
              note: "CUD home control did not reach 0;0",
            },
          }
        }
        const target = Math.max(999, rows + 1)
        ctx.feed(`\x1b[${target}B`)
        const final = ctx.getCursor()
        const validFinal = Number.isSafeInteger(final.y) && Number.isSafeInteger(final.x)
        return parserStateResult(
          validFinal ? final.y === rows - 1 && final.x === 0 : null,
          `CUD ${target} clamps to last initialized row ${rows - 1}, col 0 after qualified home`,
          { rows, origin, final },
          validFinal ? undefined : "CUD target cursor readback is invalid",
        )
      },
      async (ctx) => {
        if (!Number.isSafeInteger(ctx.rows) || !Number.isSafeInteger(ctx.cols) || ctx.rows < 2 || ctx.cols < 1) {
          return {
            pass: false,
            observation: {
              outcome: "inconclusive",
              reason: "insufficient-evidence",
              evidence: "none",
              note: "cursor.cud-past-bottom fixture needs at least 2x1 measured cells",
            },
          }
        }
        ctx.write("\x1b[1;1H") // position at row 1
        const origin = await ctx.queryCursorPosition()
        if (!origin) {
          return { pass: false, observation: { outcome: "inconclusive", reason: "no-response", evidence: "query" } }
        }
        if (origin.row !== 1 || origin.col !== 1) {
          return {
            pass: false,
            response: JSON.stringify({ origin }),
            observation: {
              outcome: "inconclusive",
              reason: "insufficient-evidence",
              evidence: "query",
              note: "CUD home control did not reach 1;1",
            },
          }
        }
        const target = Math.max(999, ctx.rows + 1)
        ctx.write(`\x1b[${target}B`) // move past the measured bottom
        const final = await ctx.queryCursorPosition()
        if (!final) {
          return { pass: false, observation: { outcome: "inconclusive", reason: "no-response", evidence: "query" } }
        }
        return {
          pass: false,
          response: JSON.stringify({ rows: ctx.rows, origin, final, target }),
          observation: {
            outcome: "inconclusive",
            reason: "insufficient-evidence",
            evidence: "query",
            note: "CUD home and final CPR were recorded; this callback does not independently qualify bottom behavior",
          },
        }
      },
    ),
    termNeedsGeometry: true,

    termlessObservationEvidence: "parser-state",
  },

  // VPA — vertical position absolute
  cursorProbe("cursor.vpa", "\x1b[3;5H", "\x1b[10d", { row: 9, col: 4 }, { row: 2, col: 4 }),

  // CPL — cursor preceding line
  cursorProbe("cursor.cpl", "\x1b[6;10H", "\x1b[2F", { row: 3, col: 0 }, { row: 5, col: 9 }),

  // HPA — horizontal position absolute
  cursorProbe("cursor.hpa", "\x1b[3;1H", "\x1b[15`", { row: 2, col: 14 }, { row: 2, col: 0 }),

  // CUP with DECSTBM + DECOM — physical cursor is margin-relative, but CPR reports relative coordinates.
  // DEC VT510: https://vt100.net/mirror/mds-199909/cd3/term/vt510rmb.pdf (DECOM and DSR—CPR)
  {
    ...probe(
      "cursor.cup-scroll-region",
      (ctx) => {
        try {
          ctx.feed("\x1b[5;15r") // set scroll region rows 5-15
          ctx.feed("\x1b[?6h") // enable DECOM (origin mode)
          ctx.feed("\x1b[1;1H") // CUP 1;1 — should go to scroll region top (row 4, 0-based)
          return headlessPosition(ctx, 4, 0)
        } finally {
          try {
            ctx.feed("\x1b[?6l") // disable DECOM
          } finally {
            ctx.feed("\x1b[r") // reset scroll region
          }
        }
      },
      async (ctx) => {
        if (!Number.isSafeInteger(ctx.rows) || !Number.isSafeInteger(ctx.cols) || ctx.rows < 15 || ctx.cols < 1) {
          return {
            pass: false,
            observation: {
              outcome: "inconclusive",
              reason: "insufficient-evidence",
              evidence: "none",
              note: "cursor.cup-scroll-region fixture needs at least 15x1 measured cells",
            },
          }
        }
        try {
          ctx.write("\x1b[5;15r") // set scroll region rows 5-15
          ctx.write("\x1b[?6h") // enable DECOM
          ctx.write("\x1b[1;1H") // CUP 1;1 — relative to scroll region
          const pos = await ctx.queryCursorPosition()
          if (!pos) {
            return { pass: false, observation: { outcome: "inconclusive", reason: "no-response", evidence: "query" } }
          }
          return {
            pass: false,
            response: JSON.stringify({ report: pos }),
            observation: {
              outcome: "inconclusive",
              reason: "insufficient-evidence",
              evidence: "query",
              note: "Relative CPR does not prove the physical row or independently qualify DECOM and margins",
            },
          }
        } finally {
          try {
            ctx.write("\x1b[?6l") // disable DECOM
          } finally {
            ctx.write("\x1b[r") // reset scroll region
          }
        }
      },
    ),
    termNeedsGeometry: true,

    termlessObservationEvidence: "parser-state",
  },
]
