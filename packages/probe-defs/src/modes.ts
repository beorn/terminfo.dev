import type { ProbeDefinition, TermContext } from "./types.ts"
import { probe, modeProbe, behavioralModeProbe } from "./helpers.ts"

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
]
