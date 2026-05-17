import type { ProbeDefinition, TermContext } from "./types.ts"
import { probe, behavioralModeProbe } from "./helpers.ts"

async function responsiveAfterEnable(ctx: TermContext): Promise<import("./types.ts").ProbeResult> {
  const pos = await ctx.queryCursorPosition()
  return { pass: pos !== null, note: pos ? "Behavioral: responsive after enable" : "No response" }
}

export const modesProbes: ProbeDefinition[] = [
  // Alt screen enter
  behavioralModeProbe(
    "modes.alt-screen.enter",
    "\x1b[?1049h",
    "\x1b[?1049l",
    1049,
    (ctx) => {
      ctx.feed("\x1b[?1049h")
      return { pass: ctx.getMode("altScreen") === true }
    },
    async (ctx) => {
      ctx.write("\x1b[1;1H") // move to 1;1 in alt screen
      ctx.write("TEST")
      const pos = await ctx.queryCursorPosition()
      if (!pos) return { pass: false, note: "No cursor response in alt screen" }
      return { pass: true, note: "Behavioral: entered and responded" }
    },
  ),

  // Alt screen exit
  probe(
    "modes.alt-screen.exit",
    (ctx) => {
      ctx.feed("\x1b[?1049h\x1b[?1049l")
      return { pass: ctx.getMode("altScreen") === false }
    },
    async (ctx) => {
      ctx.write("\x1b[?1049h") // enter
      ctx.write("\x1b[3;3H") // move somewhere in alt
      ctx.write("\x1b[?1049l") // exit
      const pos = await ctx.queryCursorPosition()
      if (!pos) return { pass: false, note: "No cursor response after exit" }
      return { pass: true }
    },
  ),

  // Bracketed paste
  behavioralModeProbe(
    "modes.bracketed-paste",
    "\x1b[?2004h",
    "\x1b[?2004l",
    2004,
    (ctx) => {
      ctx.feed("\x1b[?2004h")
      return { pass: ctx.getMode("bracketedPaste") === true }
    },
    async (ctx) => {
      const match = await ctx.query("\x1b[c", /\x1b\[\?([0-9;]+)c/, 1000)
      if (!match) return { pass: false, note: "No DA1 response after enabling bracketed paste" }
      return { pass: true, note: "Behavioral: terminal responsive after enable" }
    },
  ),

  // Application cursor keys
  behavioralModeProbe(
    "modes.application-cursor",
    "\x1b[?1h",
    "\x1b[?1l",
    1,
    (ctx) => {
      ctx.feed("\x1b[?1h")
      return { pass: ctx.getMode("applicationCursor") === true }
    },
    responsiveAfterEnable,
  ),

  // Auto wrap
  behavioralModeProbe(
    "modes.auto-wrap",
    "\x1b[?7h",
    "", // don't disable — auto-wrap is normally on
    7,
    (ctx) => {
      ctx.feed("X".repeat(80) + "Y")
      return { pass: ctx.getCell(1, 0).char === "Y" }
    },
    async (ctx) => {
      const cols = ctx.cols
      ctx.write("\x1b[1;1H\x1b[2K")
      ctx.write("A".repeat(cols) + "B")
      const pos = await ctx.queryCursorPosition()
      if (!pos) return { pass: false, note: "No cursor response" }
      return {
        pass: pos.row === 2,
        note: pos.row === 2 ? "Behavioral: wrap confirmed" : `cursor at row ${pos.row}, expected 2`,
      }
    },
  ),

  // Mouse tracking
  behavioralModeProbe(
    "modes.mouse-tracking",
    "\x1b[?1000h",
    "\x1b[?1000l",
    1000,
    (ctx) => {
      ctx.feed("\x1b[?1000h")
      return { pass: ctx.getMode("mouseTracking") === true }
    },
    responsiveAfterEnable,
  ),

  // Focus tracking
  behavioralModeProbe(
    "modes.focus-tracking",
    "\x1b[?1004h",
    "\x1b[?1004l",
    1004,
    (ctx) => {
      ctx.feed("\x1b[?1004h")
      return { pass: ctx.getMode("focusTracking") === true }
    },
    responsiveAfterEnable,
  ),

  // Reverse video
  behavioralModeProbe(
    "modes.reverse-video",
    "\x1b[?5h",
    "\x1b[?5l",
    5,
    (ctx) => {
      ctx.feed("\x1b[?5h")
      return { pass: ctx.getMode("reverseVideo") === true }
    },
    responsiveAfterEnable,
  ),

  // Synchronized output
  behavioralModeProbe(
    "modes.synchronized-output",
    "\x1b[?2026h",
    "\x1b[?2026l",
    2026,
    (ctx) => {
      ctx.feed("\x1b[?2026h")
      ctx.feed("Hello")
      ctx.feed("\x1b[?2026l")
      return { pass: ctx.getText().includes("Hello") }
    },
    responsiveAfterEnable,
  ),

  // Origin mode
  behavioralModeProbe(
    "modes.origin",
    "\x1b[?6h",
    "\x1b[?6l",
    6,
    (ctx) => {
      ctx.feed("\x1b[?6h")
      const result = ctx.getMode("originMode") === true
      ctx.feed("\x1b[?6l")
      return { pass: result }
    },
    async (ctx) => {
      ctx.write("\x1b[5;10r") // scroll region rows 5-10
      const pos = await ctx.queryCursorPosition()
      ctx.write("\x1b[r") // reset scroll region
      if (!pos) return { pass: false, note: "No response" }
      return { pass: pos.row >= 5, note: `Behavioral: cursor at row ${pos.row} (origin mapped)` }
    },
  ),

  // Insert/replace mode (IRM)
  probe(
    "modes.insert-replace",
    (ctx) => {
      ctx.feed("ABC\x1b[1G\x1b[4hX")
      const result = ctx.getMode("insertMode") === true
      const cell0 = ctx.getCell(0, 0).char === "X"
      const cell1 = ctx.getCell(0, 1).char === "A"
      ctx.feed("\x1b[4l")
      return { pass: result && cell0 && cell1 }
    },
    async (ctx) => {
      ctx.write("\x1b[1;1H\x1b[2K")
      ctx.write("ABCD")
      ctx.write("\x1b[1;2H") // move to col 2
      ctx.write("\x1b[4h") // enable insert mode
      ctx.write("X")
      ctx.write("\x1b[4l") // disable insert mode
      const pos = await ctx.queryCursorPosition()
      if (!pos) return { pass: false, note: "No cursor response" }
      return {
        pass: pos.col === 3,
        note: pos.col === 3 ? undefined : `cursor at col ${pos.col}, expected 3`,
      }
    },
  ),

  // SGR mouse encoding
  behavioralModeProbe(
    "modes.mouse-sgr",
    "\x1b[?1006h",
    "\x1b[?1006l",
    1006,
    (ctx) => {
      ctx.feed("\x1b[?1006h")
      const pass = ctx.getMode("sgrMouse") === true
      ctx.feed("\x1b[?1006l")
      return { pass }
    },
    responsiveAfterEnable,
  ),

  // All-motion mouse tracking
  behavioralModeProbe(
    "modes.mouse-all",
    "\x1b[?1003h",
    "\x1b[?1003l",
    1003,
    (ctx) => {
      ctx.feed("\x1b[?1003h")
      const pass = ctx.getMode("mouseTracking") === true
      ctx.feed("\x1b[?1003l")
      return { pass }
    },
    responsiveAfterEnable,
  ),

  // Application keypad
  probe(
    "modes.application-keypad",
    (ctx) => {
      ctx.feed("\x1b=")
      const on = ctx.getMode("applicationKeypad") === true
      ctx.feed("\x1b>")
      const off = ctx.getMode("applicationKeypad") === false
      return { pass: on && off }
    },
    async (ctx) => {
      ctx.write("\x1b=") // DECKPAM
      const pos = await ctx.queryCursorPosition()
      ctx.write("\x1b>") // DECKPNM
      return {
        pass: pos !== null,
        note: pos ? undefined : "No cursor response after DECKPAM",
      }
    },
  ),

  // Left/right margin mode
  probe(
    "modes.left-right-margin",
    (ctx) => {
      ctx.feed("\x1b[?69h")
      const pass = ctx.getMode("leftRightMargin") === true
      ctx.feed("\x1b[?69l")
      return { pass }
    },
    async (ctx) => {
      ctx.write("\x1b[?69h") // enable DECLRMM
      const pos = await ctx.queryCursorPosition()
      ctx.write("\x1b[?69l") // disable
      return {
        pass: pos !== null,
        note: pos ? undefined : "No cursor response after DECLRMM",
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
      return {
        pass: entered && exited,
        note: !entered ? "altScreen not set" : !exited ? "altScreen not cleared" : undefined,
      }
    },
    async (ctx) => {
      ctx.write("\x1b[?47h") // enter legacy alt screen
      const inAlt = await ctx.queryCursorPosition()
      ctx.write("\x1b[?47l") // exit
      const out = await ctx.queryCursorPosition()
      if (!inAlt || !out) return { pass: false, note: "No cursor response around ?47" }
      return { pass: true, note: "Behavioral: ?47 enter/exit accepted" }
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
      return {
        pass: entered && exited,
        note: !entered ? "altScreen not set" : !exited ? "altScreen not cleared" : undefined,
      }
    },
    async (ctx) => {
      const decrpmResult = await ctx.queryMode(1047)
      if (decrpmResult !== null && decrpmResult !== "unknown") {
        return { pass: true, note: `DECRPM: mode ${decrpmResult}`, response: decrpmResult }
      }
      ctx.write("\x1b[?1047h")
      const inAlt = await ctx.queryCursorPosition()
      ctx.write("\x1b[?1047l")
      if (!inAlt) return { pass: false, note: "No cursor response after enable" }
      return { pass: true, note: "Behavioral: ?1047 accepted" }
    },
  ),

  // ?1048 — save/restore cursor only (no alt screen)
  probe(
    "modes.altscreen-1048",
    (ctx) => {
      // Position cursor, save with 1048, move, restore, check we're back
      ctx.feed("\x1b[5;10H") // row 5, col 10 (1-based) — termless 0-based: y=4, x=9
      ctx.feed("\x1b[?1048h") // save
      ctx.feed("\x1b[15;20H") // move to row 15, col 20
      ctx.feed("\x1b[?1048l") // restore
      const cursor = ctx.getCursor()
      const pass = cursor.y === 4 && cursor.x === 9
      return {
        pass,
        note: pass ? undefined : `cursor at ${cursor.y};${cursor.x}, expected 4;9 after restore`,
      }
    },
    async (ctx) => {
      ctx.write("\x1b[5;10H") // row 5, col 10
      ctx.write("\x1b[?1048h") // save
      ctx.write("\x1b[15;20H") // move
      ctx.write("\x1b[?1048l") // restore
      const pos = await ctx.queryCursorPosition()
      if (!pos) return { pass: false, note: "No cursor response after restore" }
      return {
        pass: pos.row === 5 && pos.col === 10,
        note: pos.row === 5 && pos.col === 10 ? undefined : `got ${pos.row};${pos.col}, expected 5;10`,
        response: `${pos.row};${pos.col}`,
      }
    },
  ),

  // ?1007 — alt-scroll mouse wheel
  probe(
    "modes.alt-scroll-1007",
    (ctx) => {
      ctx.feed("\x1b[?1007h")
      // Verify via DECRPM query — response CSI ? 1007 ; Ps $ y where Ps=1 means set
      const response = ctx.feedCapture("\x1b[?1007$p")
      ctx.feed("\x1b[?1007l")
      if (response.includes("$y")) {
        const set = response.includes("1007;1$y")
        return {
          pass: set,
          note: set ? "DECRPM: mode set" : `DECRPM: mode not set (${JSON.stringify(response)})`,
          response,
        }
      }
      // Fallback: verify sequence didn't break the terminal
      ctx.feed("X")
      const ok = ctx.getCell(0, 0).char === "X"
      return { pass: ok, note: ok ? "Sequence parsed (DECRPM not supported)" : "Parser broke" }
    },
    async (ctx) => {
      const decrpmResult = await ctx.queryMode(1007)
      if (decrpmResult !== null && decrpmResult !== "unknown") {
        return { pass: true, note: `DECRPM: mode ${decrpmResult}`, response: decrpmResult }
      }
      ctx.write("\x1b[?1007h")
      const pos = await ctx.queryCursorPosition()
      ctx.write("\x1b[?1007l")
      return {
        pass: pos !== null,
        note: pos ? "Behavioral: ?1007 accepted" : "No cursor response after enable",
      }
    },
  ),

  // ?1005 — UTF-8 mouse encoding (legacy)
  probe(
    "modes.utf8-mouse-1005",
    (ctx) => {
      ctx.feed("\x1b[?1005h")
      // Verify via DECRPM query — response CSI ? 1005 ; Ps $ y where Ps=1 means set
      const response = ctx.feedCapture("\x1b[?1005$p")
      ctx.feed("\x1b[?1005l")
      if (response.includes("$y")) {
        const set = response.includes("1005;1$y")
        return {
          pass: set,
          note: set ? "DECRPM: mode set" : `DECRPM: mode not set (${JSON.stringify(response)})`,
          response,
        }
      }
      // Fallback: verify sequence didn't break the terminal
      ctx.feed("X")
      const ok = ctx.getCell(0, 0).char === "X"
      return { pass: ok, note: ok ? "Sequence parsed (DECRPM not supported)" : "Parser broke" }
    },
    async (ctx) => {
      const decrpmResult = await ctx.queryMode(1005)
      if (decrpmResult !== null && decrpmResult !== "unknown") {
        return { pass: true, note: `DECRPM: mode ${decrpmResult}`, response: decrpmResult }
      }
      ctx.write("\x1b[?1005h")
      const pos = await ctx.queryCursorPosition()
      ctx.write("\x1b[?1005l")
      return {
        pass: pos !== null,
        note: pos ? "Behavioral: ?1005 accepted" : "No cursor response after enable",
      }
    },
  ),

  // ?3 — DECCOLM 80/132 column switch
  probe(
    "modes.deccolm",
    (ctx) => {
      ctx.feed("\x1b[?3h")
      // Verify via DECRPM query — response CSI ? 3 ; Ps $ y where Ps=1 means set
      const response = ctx.feedCapture("\x1b[?3$p")
      ctx.feed("\x1b[?3l")
      if (response.includes("$y")) {
        const set = response.includes("3;1$y")
        return {
          pass: set,
          note: set ? "DECRPM: mode set" : `DECRPM: mode not set (${JSON.stringify(response)})`,
          response,
        }
      }
      // Fallback: verify sequence didn't break the terminal
      ctx.feed("X")
      const ok = ctx.getText().includes("X")
      return { pass: ok, note: ok ? "Sequence parsed (DECRPM not supported)" : "Parser broke" }
    },
    async (ctx) => {
      const decrpmResult = await ctx.queryMode(3)
      if (decrpmResult !== null && decrpmResult !== "unknown") {
        return { pass: true, note: `DECRPM: mode ${decrpmResult}`, response: decrpmResult }
      }
      ctx.write("\x1b[?3h")
      const pos = await ctx.queryCursorPosition()
      ctx.write("\x1b[?3l")
      return {
        pass: pos !== null,
        note: pos ? "Behavioral: ?3 accepted" : "No cursor response after enable",
      }
    },
  ),

  // ?4 — DECSCLM smooth scroll mode. This is observable through DECRPM even
  // though modern emulators often render both smooth and jump scrolling instantly.
  probe(
    "modes.decsclm",
    (ctx) => {
      ctx.feed("\x1b[?4h")
      const response = ctx.feedCapture("\x1b[?4$p")
      ctx.feed("\x1b[?4l")
      const set = response.includes("?4;1$y")
      return {
        pass: set,
        note: set ? "DECRPM: mode set" : `DECRPM: mode not set (${JSON.stringify(response)})`,
        response,
      }
    },
    async (ctx) => {
      ctx.write("\x1b[?4h")
      const result = await ctx.queryMode(4)
      ctx.write("\x1b[?4l")
      return {
        pass: result === "set",
        note: result === "set" ? "DECRPM: mode set" : `DECRPM: mode ${result ?? "no response"}`,
        response: result ?? undefined,
      }
    },
  ),

  // Mode 2031 — color scheme reporting (dark/light mode notifications)
  // Adopted by: iTerm2, tmux 3.6, Contour, foot, kitty
  probe(
    "modes.color-scheme-reporting",
    (ctx) => {
      // Enable mode 2031, check via getMode
      ctx.feed("\x1b[?2031h")
      const enabled = ctx.getMode("colorSchemeReporting")
      ctx.feed("\x1b[?2031l")
      return { pass: enabled === true }
    },
    async (ctx) => {
      // Try DECRPM first
      const result = await ctx.queryMode(2031)
      if (result !== null && result !== "unknown") {
        return { pass: true, note: `DECRPM: mode ${result}`, response: result }
      }
      // Fallback: try DECDSR 997 (synchronous color scheme query)
      const match = await ctx.queryWithSentinel("\x1b[?997n", /\x1b\[\?997;(\d+)n/)
      if (match) {
        const scheme = match[1] === "1" ? "dark" : match[1] === "2" ? "light" : `unknown(${match[1]})`
        return { pass: true, note: scheme, response: match[1] }
      }
      return { pass: false, note: "No DECRPM or DECDSR 997 response" }
    },
  ),

  // XTPUSHSGR — push SGR stack (CSI # {)
  // Sequence consumed without producing output. Verify terminal stays responsive afterward.
  probe(
    "modes.xtpushsgr",
    (ctx) => {
      // Capture any output during the push — should be empty.
      const pushOut = ctx.feedCapture("\x1b[#{")
      if (pushOut.length > 0) return { pass: false, note: `Unexpected output: ${JSON.stringify(pushOut)}` }
      // Verify the terminal is still responsive by issuing a DA1 query.
      const probeResponse = ctx.feedCapture("\x1b[c")
      const ok = /\x1b\[\?[0-9;]+c/.test(probeResponse)
      // Pop to leave clean state.
      ctx.feed("\x1b[#}")
      return {
        pass: ok,
        note: ok ? "Sequence consumed; terminal responsive" : "Terminal unresponsive after push",
      }
    },
    async (ctx) => {
      ctx.write("\x1b[#{")
      const pos = await ctx.queryCursorPosition()
      ctx.write("\x1b[#}") // pop to clean up
      if (!pos) return { pass: false, note: "No DSR response after XTPUSHSGR" }
      return { pass: true, note: "Sequence consumed; terminal responsive" }
    },
  ),

  // XTPOPSGR — pop SGR stack (CSI # })
  // Push first so the pop is meaningful, then verify responsiveness.
  probe(
    "modes.xtpopsgr",
    (ctx) => {
      ctx.feed("\x1b[#{")
      const popOut = ctx.feedCapture("\x1b[#}")
      if (popOut.length > 0) return { pass: false, note: `Unexpected output: ${JSON.stringify(popOut)}` }
      const probeResponse = ctx.feedCapture("\x1b[c")
      const ok = /\x1b\[\?[0-9;]+c/.test(probeResponse)
      return {
        pass: ok,
        note: ok ? "Sequence consumed; terminal responsive" : "Terminal unresponsive after pop",
      }
    },
    async (ctx) => {
      ctx.write("\x1b[#{")
      ctx.write("\x1b[#}")
      const pos = await ctx.queryCursorPosition()
      if (!pos) return { pass: false, note: "No DSR response after XTPOPSGR" }
      return { pass: true, note: "Sequence consumed; terminal responsive" }
    },
  ),

  // XTSAVE — save DEC private modes (CSI ? Pm s). Use DECAWM (mode 7) — universally supported.
  probe(
    "modes.xtsave",
    (ctx) => {
      const saveOut = ctx.feedCapture("\x1b[?7s")
      if (saveOut.length > 0) return { pass: false, note: `Unexpected output: ${JSON.stringify(saveOut)}` }
      const probeResponse = ctx.feedCapture("\x1b[c")
      const ok = /\x1b\[\?[0-9;]+c/.test(probeResponse)
      // Restore to leave clean state.
      ctx.feed("\x1b[?7r")
      return {
        pass: ok,
        note: ok ? "Sequence consumed; terminal responsive" : "Terminal unresponsive after XTSAVE",
      }
    },
    async (ctx) => {
      ctx.write("\x1b[?7s")
      const pos = await ctx.queryCursorPosition()
      ctx.write("\x1b[?7r") // restore to clean up
      if (!pos) return { pass: false, note: "No DSR response after XTSAVE" }
      return { pass: true, note: "Sequence consumed; terminal responsive" }
    },
  ),

  // XTRESTORE — restore DEC private modes (CSI ? Pm r). Pair with a save first.
  probe(
    "modes.xtrestore",
    (ctx) => {
      ctx.feed("\x1b[?7s")
      const restoreOut = ctx.feedCapture("\x1b[?7r")
      if (restoreOut.length > 0) return { pass: false, note: `Unexpected output: ${JSON.stringify(restoreOut)}` }
      const probeResponse = ctx.feedCapture("\x1b[c")
      const ok = /\x1b\[\?[0-9;]+c/.test(probeResponse)
      return {
        pass: ok,
        note: ok ? "Sequence consumed; terminal responsive" : "Terminal unresponsive after XTRESTORE",
      }
    },
    async (ctx) => {
      ctx.write("\x1b[?7s")
      ctx.write("\x1b[?7r")
      const pos = await ctx.queryCursorPosition()
      if (!pos) return { pass: false, note: "No DSR response after XTRESTORE" }
      return { pass: true, note: "Sequence consumed; terminal responsive" }
    },
  ),

  // XTPUSHCOLORS — push color palette (CSI # P)
  probe(
    "modes.xtpushcolors",
    (ctx) => {
      const pushOut = ctx.feedCapture("\x1b[#P")
      if (pushOut.length > 0) return { pass: false, note: `Unexpected output: ${JSON.stringify(pushOut)}` }
      const probeResponse = ctx.feedCapture("\x1b[c")
      const ok = /\x1b\[\?[0-9;]+c/.test(probeResponse)
      // Pop to leave clean state.
      ctx.feed("\x1b[#Q")
      return {
        pass: ok,
        note: ok ? "Sequence consumed; terminal responsive" : "Terminal unresponsive after push",
      }
    },
    async (ctx) => {
      ctx.write("\x1b[#P")
      const pos = await ctx.queryCursorPosition()
      ctx.write("\x1b[#Q") // pop to clean up
      if (!pos) return { pass: false, note: "No DSR response after XTPUSHCOLORS" }
      return { pass: true, note: "Sequence consumed; terminal responsive" }
    },
  ),

  // XTPOPCOLORS — pop color palette (CSI # Q). Push first so the pop is meaningful.
  probe(
    "modes.xtpopcolors",
    (ctx) => {
      ctx.feed("\x1b[#P")
      const popOut = ctx.feedCapture("\x1b[#Q")
      if (popOut.length > 0) return { pass: false, note: `Unexpected output: ${JSON.stringify(popOut)}` }
      const probeResponse = ctx.feedCapture("\x1b[c")
      const ok = /\x1b\[\?[0-9;]+c/.test(probeResponse)
      return {
        pass: ok,
        note: ok ? "Sequence consumed; terminal responsive" : "Terminal unresponsive after pop",
      }
    },
    async (ctx) => {
      ctx.write("\x1b[#P")
      ctx.write("\x1b[#Q")
      const pos = await ctx.queryCursorPosition()
      if (!pos) return { pass: false, note: "No DSR response after XTPOPCOLORS" }
      return { pass: true, note: "Sequence consumed; terminal responsive" }
    },
  ),
]
