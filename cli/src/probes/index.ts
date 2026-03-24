/**
 * Real-terminal probes — test actual terminal capabilities via PTY I/O.
 *
 * Unlike headless probes (which read cell state programmatically), these send
 * escape sequences to stdout and read responses from stdin. They verify what
 * the terminal *claims* to support, not just what a headless library exposes.
 */

import { query, queryCursorPosition, measureRenderedWidth, queryMode } from "../tty.ts"

export interface ProbeResult {
  pass: boolean
  note?: string
  response?: string
}

export interface Probe {
  id: string
  name: string
  run: () => Promise<ProbeResult>
}

// ── Cursor probes ──

const cursorPositionReport: Probe = {
  id: "cursor.position-report",
  name: "Cursor position report (DSR 6)",
  async run() {
    process.stdout.write("\x1b[3;5H") // Move to row 3, col 5
    const pos = await queryCursorPosition()
    if (!pos) return { pass: false, note: "No DSR 6 response" }
    return {
      pass: pos[0] === 3 && pos[1] === 5,
      note: pos[0] === 3 && pos[1] === 5 ? undefined : `got ${pos[0]};${pos[1]}, expected 3;5`,
      response: `${pos[0]};${pos[1]}`,
    }
  },
}

const cursorShape: Probe = {
  id: "cursor.shape",
  name: "Cursor shape (DECSCUSR)",
  async run() {
    // Set cursor to bar shape, then query via DECRPM-like
    // Most terminals accept DECSCUSR but we can't read shape back via PTY
    // Instead, verify the sequence doesn't crash and cursor still responds
    process.stdout.write("\x1b[5 q") // blinking bar
    const pos = await queryCursorPosition()
    process.stdout.write("\x1b[0 q") // restore default
    return {
      pass: pos !== null,
      note: pos ? undefined : "No response after DECSCUSR",
    }
  },
}

// ── Device probes ──

const primaryDA: Probe = {
  id: "device.primary-da",
  name: "Primary device attributes (DA1)",
  async run() {
    const match = await query("\x1b[c", /\x1b\[\?([0-9;]+)c/, 1000)
    if (!match) return { pass: false, note: "No DA1 response" }
    return { pass: true, response: match[0] }
  },
}

const deviceStatusReport: Probe = {
  id: "device.status-report",
  name: "Device status report (DSR 5)",
  async run() {
    const match = await query("\x1b[5n", /\x1b\[(\d+)n/, 1000)
    if (!match) return { pass: false, note: "No DSR 5 response" }
    return {
      pass: match[1] === "0",
      note: match[1] === "0" ? undefined : `status ${match[1]}`,
      response: match[0],
    }
  },
}

// ── Mode probes (DECRPM) ──

function modeProbe(id: string, name: string, modeNum: number): Probe {
  return {
    id,
    name,
    async run() {
      const result = await queryMode(modeNum)
      if (result === null) return { pass: false, note: "No DECRPM response" }
      return {
        pass: result !== "unknown",
        note: result === "unknown" ? "Mode not recognized" : `Mode ${result}`,
        response: result,
      }
    },
  }
}

// ── Text width probes ──

const wideCharCJK: Probe = {
  id: "text.wide.cjk",
  name: "CJK wide chars (2 cols)",
  async run() {
    const width = await measureRenderedWidth("中")
    if (width === null) return { pass: false, note: "Cannot measure width" }
    return {
      pass: width === 2,
      note: width === 2 ? undefined : `width=${width}, expected 2`,
    }
  },
}

const wideCharEmoji: Probe = {
  id: "text.wide.emoji",
  name: "Emoji wide chars (2 cols)",
  async run() {
    const width = await measureRenderedWidth("😀")
    if (width === null) return { pass: false, note: "Cannot measure width" }
    return {
      pass: width === 2,
      note: width === 2 ? undefined : `width=${width}, expected 2`,
    }
  },
}

// ── SGR probes (write + cursor position to verify parsing) ──

function sgrProbe(id: string, name: string, sequence: string): Probe {
  return {
    id,
    name,
    async run() {
      // Write SGR sequence + text, verify cursor advances (sequence was parsed, not printed)
      process.stdout.write("\x1b[1;1H\x1b[2K") // clear line
      process.stdout.write(sequence + "X\x1b[0m")
      const pos = await queryCursorPosition()
      if (!pos) return { pass: false, note: "No cursor response" }
      // Cursor should be at col 2 (wrote 1 char "X")
      return {
        pass: pos[1] === 2,
        note: pos[1] === 2 ? undefined : `cursor at col ${pos[1]}, expected 2`,
      }
    },
  }
}

// ── Cursor save/restore ──

const cursorSaveRestore: Probe = {
  id: "cursor.save-restore",
  name: "Cursor save/restore (DECSC/DECRC)",
  async run() {
    process.stdout.write("\x1b[3;5H") // Move to row 3, col 5
    process.stdout.write("\x1b7") // DECSC — save cursor
    process.stdout.write("\x1b[10;10H") // Move somewhere else
    process.stdout.write("\x1b8") // DECRC — restore cursor
    const pos = await queryCursorPosition()
    if (!pos) return { pass: false, note: "No cursor response after restore" }
    return {
      pass: pos[0] === 3 && pos[1] === 5,
      note: pos[0] === 3 && pos[1] === 5 ? undefined : `got ${pos[0]};${pos[1]}, expected 3;5`,
      response: `${pos[0]};${pos[1]}`,
    }
  },
}

// ── Erase probes ──

const eraseLineRight: Probe = {
  id: "erase.line.right",
  name: "Erase line right (EL 0)",
  async run() {
    process.stdout.write("\x1b[1;1H\x1b[2K") // Clear line
    process.stdout.write("ABCDE")
    process.stdout.write("\x1b[1;3H") // Move to col 3
    process.stdout.write("\x1b[0K") // EL 0 — erase to right
    const pos = await queryCursorPosition()
    if (!pos) return { pass: false, note: "No cursor response" }
    return {
      pass: pos[1] === 3,
      note: pos[1] === 3 ? undefined : `cursor at col ${pos[1]}, expected 3`,
    }
  },
}

const eraseScreenScrollback: Probe = {
  id: "erase.screen.scrollback",
  name: "Erase scrollback (ED 3)",
  async run() {
    process.stdout.write("\x1b[5;5H") // Move to known position
    process.stdout.write("\x1b[3J") // ED 3 — erase scrollback
    const pos = await queryCursorPosition()
    if (!pos) return { pass: false, note: "No cursor response after ED 3" }
    return {
      pass: pos[0] === 5 && pos[1] === 5,
      note: pos[0] === 5 && pos[1] === 5 ? undefined : `cursor at ${pos[0]};${pos[1]}, expected 5;5`,
    }
  },
}

// ── Scroll region ──

const scrollRegion: Probe = {
  id: "scrollback.set-region",
  name: "Scroll region (DECSTBM)",
  async run() {
    process.stdout.write("\x1b[5;10r") // Set scroll region rows 5–10
    process.stdout.write("\x1b[r") // Reset scroll region
    const pos = await queryCursorPosition()
    if (!pos) return { pass: false, note: "No cursor response after DECSTBM" }
    // After reset, cursor should still respond — terminal didn't crash
    return { pass: true }
  },
}

// ── Tab and backspace ──

const tabStop: Probe = {
  id: "text.tab",
  name: "Tab stop (default 8-col)",
  async run() {
    process.stdout.write("\x1b[1;1H\x1b[2K") // Clear line, move to col 1
    process.stdout.write("\t") // Tab
    const pos = await queryCursorPosition()
    if (!pos) return { pass: false, note: "No cursor response" }
    return {
      pass: pos[1] === 9,
      note: pos[1] === 9 ? undefined : `cursor at col ${pos[1]}, expected 9`,
    }
  },
}

const backspace: Probe = {
  id: "text.backspace",
  name: "Backspace (BS)",
  async run() {
    process.stdout.write("\x1b[1;5H") // Move to col 5
    process.stdout.write("\b") // BS
    const pos = await queryCursorPosition()
    if (!pos) return { pass: false, note: "No cursor response" }
    return {
      pass: pos[1] === 4,
      note: pos[1] === 4 ? undefined : `cursor at col ${pos[1]}, expected 4`,
    }
  },
}

// ── Insert/delete character probes ──

const insertChars: Probe = {
  id: "editing.insert-chars",
  name: "Insert characters (ICH)",
  async run() {
    process.stdout.write("\x1b[1;1H\x1b[2K") // Clear line
    process.stdout.write("ABCD")
    process.stdout.write("\x1b[1;2H") // Move to col 2
    process.stdout.write("\x1b[1@") // ICH 1 — insert 1 blank char
    const pos = await queryCursorPosition()
    if (!pos) return { pass: false, note: "No cursor response" }
    // Cursor should remain at col 2 after insert
    return {
      pass: pos[1] === 2,
      note: pos[1] === 2 ? undefined : `cursor at col ${pos[1]}, expected 2`,
    }
  },
}

const deleteChars: Probe = {
  id: "editing.delete-chars",
  name: "Delete characters (DCH)",
  async run() {
    process.stdout.write("\x1b[1;1H\x1b[2K") // Clear line
    process.stdout.write("ABCD")
    process.stdout.write("\x1b[1;2H") // Move to col 2
    process.stdout.write("\x1b[1P") // DCH 1 — delete 1 char
    const pos = await queryCursorPosition()
    if (!pos) return { pass: false, note: "No cursor response" }
    // Cursor should remain at col 2 after delete
    return {
      pass: pos[1] === 2,
      note: pos[1] === 2 ? undefined : `cursor at col ${pos[1]}, expected 2`,
    }
  },
}

// ── Reset ──

const resetRIS: Probe = {
  id: "reset.ris",
  name: "Full reset (RIS)",
  async run() {
    process.stdout.write("\x1b[5;5H") // Move somewhere away from 1;1
    process.stdout.write("\x1bc") // RIS — full reset
    const pos = await queryCursorPosition()
    if (!pos) return { pass: false, note: "No cursor response after RIS" }
    return {
      pass: pos[0] === 1 && pos[1] === 1,
      note: pos[0] === 1 && pos[1] === 1 ? undefined : `cursor at ${pos[0]};${pos[1]}, expected 1;1`,
    }
  },
}

// ── Extensions probes ──

const kittyKeyboard: Probe = {
  id: "extensions.kitty-keyboard",
  name: "Kitty keyboard protocol",
  async run() {
    // Query current keyboard mode flags — terminal responds with CSI ? flags u
    const match = await query("\x1b[?u", /\x1b\[\?(\d+)u/, 1000)
    if (!match) return { pass: false, note: "No kitty keyboard response" }
    return { pass: true, response: `flags=${match[1]}` }
  },
}

const sixelDA1: Probe = {
  id: "extensions.sixel-da1",
  name: "Sixel advertised (DA1 bit 4)",
  async run() {
    const match = await query("\x1b[c", /\x1b\[\?([0-9;]+)c/, 1000)
    if (!match) return { pass: false, note: "No DA1 response" }
    const attrs = match[1]!.split(";")
    const hasSixel = attrs.includes("4")
    return {
      pass: hasSixel,
      note: hasSixel ? undefined : "DA1 response missing ;4 (sixel)",
      response: match[1],
    }
  },
}

const sixelRender: Probe = {
  id: "extensions.sixel",
  name: "Sixel graphics (render)",
  async run() {
    // Send a minimal sixel image and check if cursor moved
    process.stdout.write("\x1b[1;1H") // move to 1;1
    process.stdout.write("\x1bPq#0;2;0;0;0~-~\x1b\\") // tiny 1x2 sixel
    const pos = await queryCursorPosition()
    if (!pos) return { pass: false, note: "No cursor response after sixel" }
    // If terminal parsed sixel, cursor should have moved
    const moved = pos[0] > 1 || pos[1] > 1
    return {
      pass: moved,
      note: moved ? undefined : "Sixel image didn't move cursor",
    }
  },
}

const osc52Clipboard: Probe = {
  id: "extensions.osc52-clipboard",
  name: "Clipboard query (OSC 52)",
  async run() {
    const match = await query("\x1b]52;c;?\x07", /\x1b\]52;([^\x07\x1b]+)[\x07\x1b]/, 1000)
    if (!match) return { pass: false, note: "No OSC 52 response" }
    return { pass: true, response: match[1] }
  },
}

const osc7Cwd: Probe = {
  id: "extensions.osc7-cwd",
  name: "Current directory (OSC 7)",
  async run() {
    // OSC 7 sets the working directory — can't read it back, just verify no crash
    process.stdout.write("\x1b]7;file:///tmp\x07")
    const pos = await queryCursorPosition()
    return { pass: pos !== null }
  },
}

// ── OSC probes ──

const osc10FgColor: Probe = {
  id: "extensions.osc10-fg-color",
  name: "Foreground color query (OSC 10)",
  async run() {
    const match = await query("\x1b]10;?\x07", /\x1b\]10;([^\x07\x1b]+)[\x07\x1b]/, 1000)
    if (!match) return { pass: false, note: "No OSC 10 response" }
    return { pass: true, response: match[1] }
  },
}

const osc11BgColor: Probe = {
  id: "extensions.osc11-bg-color",
  name: "Background color query (OSC 11)",
  async run() {
    const match = await query("\x1b]11;?\x07", /\x1b\]11;([^\x07\x1b]+)[\x07\x1b]/, 1000)
    if (!match) return { pass: false, note: "No OSC 11 response" }
    return { pass: true, response: match[1] }
  },
}

const osc2Title: Probe = {
  id: "extensions.osc2-title",
  name: "Window title (OSC 2)",
  async run() {
    // Set title and verify no crash; can't read it back via PTY
    process.stdout.write("\x1b]2;terminfo-test\x07")
    const pos = await queryCursorPosition()
    process.stdout.write("\x1b]2;\x07") // reset title
    return { pass: pos !== null }
  },
}

// ── All probes ──

export const ALL_PROBES: Probe[] = [
  // Cursor
  cursorPositionReport,
  cursorShape,
  cursorSaveRestore,

  // Device
  primaryDA,
  deviceStatusReport,

  // Modes via DECRPM
  modeProbe("modes.alt-screen.enter", "Alt screen (DECSET 1049)", 1049),
  modeProbe("modes.bracketed-paste", "Bracketed paste (DECSET 2004)", 2004),
  modeProbe("modes.mouse-tracking", "Mouse tracking (DECSET 1000)", 1000),
  modeProbe("modes.mouse-sgr", "SGR mouse (DECSET 1006)", 1006),
  modeProbe("modes.focus-tracking", "Focus tracking (DECSET 1004)", 1004),
  modeProbe("modes.auto-wrap", "Auto-wrap (DECAWM)", 7),
  modeProbe("modes.application-cursor", "App cursor keys (DECCKM)", 1),
  modeProbe("modes.origin", "Origin mode (DECOM)", 6),
  modeProbe("modes.reverse-video", "Reverse video (DECSCNM)", 5),
  modeProbe("modes.synchronized-output", "Synchronized output (DECSET 2026)", 2026),

  // Text width
  wideCharCJK,
  wideCharEmoji,

  // Text behavior
  tabStop,
  backspace,

  // Erase
  eraseLineRight,
  eraseScreenScrollback,

  // Editing
  insertChars,
  deleteChars,

  // Scroll region
  scrollRegion,

  // Reset
  resetRIS,

  // SGR (verify sequence is parsed, not printed)
  sgrProbe("sgr.bold", "Bold (SGR 1)", "\x1b[1m"),
  sgrProbe("sgr.faint", "Faint (SGR 2)", "\x1b[2m"),
  sgrProbe("sgr.italic", "Italic (SGR 3)", "\x1b[3m"),
  sgrProbe("sgr.underline.single", "Underline (SGR 4)", "\x1b[4m"),
  sgrProbe("sgr.underline.double", "Double underline (SGR 21)", "\x1b[21m"),
  sgrProbe("sgr.underline.curly", "Curly underline (SGR 4:3)", "\x1b[4:3m"),
  sgrProbe("sgr.underline.dotted", "Dotted underline (SGR 4:4)", "\x1b[4:4m"),
  sgrProbe("sgr.underline.dashed", "Dashed underline (SGR 4:5)", "\x1b[4:5m"),
  sgrProbe("sgr.blink", "Blink (SGR 5)", "\x1b[5m"),
  sgrProbe("sgr.inverse", "Inverse (SGR 7)", "\x1b[7m"),
  sgrProbe("sgr.strikethrough", "Strikethrough (SGR 9)", "\x1b[9m"),
  sgrProbe("sgr.overline", "Overline (SGR 53)", "\x1b[53m"),

  // Extensions
  kittyKeyboard,
  sixelDA1,
  sixelRender,
  osc52Clipboard,
  osc7Cwd,

  // OSC
  osc10FgColor,
  osc11BgColor,
  osc2Title,
]
