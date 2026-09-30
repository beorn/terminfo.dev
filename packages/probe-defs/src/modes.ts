import type { ProbeDefinition } from "./types.ts"
import { probe, decrpmModeProbe, parserStateResult, isBlank } from "./helpers.ts"

export const modesProbes: ProbeDefinition[] = [
  // Alt screen enter
  decrpmModeProbe("modes.alt-screen.enter", 1049, (ctx) => {
    ctx.feed("\x1b[?1049h")
    return parserStateResult(
      null,
      "Alt-screen entry changes the visible buffer",
      { mode: ctx.getMode("altScreen") },
      "Mode metadata does not measure the alternate buffer",
    )
  }),

  // Alt screen exit
  {
    ...probe(
      "modes.alt-screen.exit",
      (ctx) => {
        ctx.feed("\x1b[?1049h\x1b[?1049l")
        return parserStateResult(
          null,
          "Alt-screen exit restores the visible buffer",
          { mode: ctx.getMode("altScreen") },
          "Mode metadata does not measure buffer restoration",
        )
      },
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
