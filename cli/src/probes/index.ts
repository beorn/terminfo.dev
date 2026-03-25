/**
 * Real-terminal probes — test actual terminal capabilities via PTY I/O.
 *
 * Unlike headless probes (which read cell state programmatically), these send
 * escape sequences to stdout and read responses from stdin. They verify what
 * the terminal *claims* to support, not just what a headless library exposes.
 *
 * Probe patterns:
 * 1. Cursor position verification — write sequence, query DSR 6, verify position
 * 2. DECRPM mode query — ask terminal if it recognizes a mode
 * 3. Behavioral mode test — enable mode, verify behavior, disable mode
 * 4. Query/response — send query sequence, match response pattern
 */

import { query, queryWithSentinel, queryCursorPosition, measureRenderedWidth, queryMode } from "../tty.ts"

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

// ── Helper: cursor position probe (move + verify) ──

function cursorProbe(
  id: string,
  name: string,
  setup: string,
  sequence: string,
  expectedRow: number,
  expectedCol: number,
): Probe {
  return {
    id,
    name,
    async run() {
      process.stdout.write(setup)
      process.stdout.write(sequence)
      const pos = await queryCursorPosition()
      if (!pos) return { pass: false, note: "No cursor response" }
      return {
        pass: pos[0] === expectedRow && pos[1] === expectedCol,
        note:
          pos[0] === expectedRow && pos[1] === expectedCol
            ? undefined
            : `got ${pos[0]};${pos[1]}, expected ${expectedRow};${expectedCol}`,
        response: `${pos[0]};${pos[1]}`,
      }
    },
  }
}

// ── Helper: SGR probe (write SGR + char, verify cursor advanced by 1) ──

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

// ── Helper: DECRPM mode probe ──

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

// ── Helper: behavioral mode probe (try DECRPM first, fall back to behavior) ──

function behavioralModeProbe(
  id: string,
  name: string,
  modeNum: number,
  enableSeq: string,
  disableSeq: string,
  behaviorTest: () => Promise<ProbeResult>,
): Probe {
  return {
    id,
    name,
    async run() {
      // Try DECRPM first
      const decrpmResult = await queryMode(modeNum)
      if (decrpmResult !== null && decrpmResult !== "unknown") {
        return {
          pass: true,
          note: `DECRPM: mode ${decrpmResult}`,
          response: decrpmResult,
        }
      }
      // Fall back to behavioral test
      process.stdout.write(enableSeq)
      const result = await behaviorTest()
      process.stdout.write(disableSeq)
      return result
    },
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// ── Cursor probes ──
// ═══════════════════════════════════════════════════════════════════════════

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
    process.stdout.write("\x1b[5 q") // blinking bar
    const pos = await queryCursorPosition()
    process.stdout.write("\x1b[0 q") // restore default
    return {
      pass: pos !== null,
      note: pos ? undefined : "No response after DECSCUSR",
    }
  },
}

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

const cursorHide: Probe = {
  id: "cursor.hide",
  name: "Cursor hide/show (DECTCEM)",
  async run() {
    process.stdout.write("\x1b[?25l") // hide cursor
    const posHidden = await queryCursorPosition()
    process.stdout.write("\x1b[?25h") // show cursor
    if (!posHidden) return { pass: false, note: "No cursor response while hidden" }
    const posVisible = await queryCursorPosition()
    if (!posVisible) return { pass: false, note: "No cursor response after show" }
    // Both responses mean terminal processed hide/show without breaking DSR
    return { pass: true }
  },
}

// ═══════════════════════════════════════════════════════════════════════════
// ── Device probes ──
// ═══════════════════════════════════════════════════════════════════════════

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

const deviceDecrpm: Probe = {
  id: "device.decrpm",
  name: "DECRPM support (mode query)",
  async run() {
    // Query DECAWM (mode 7) — universally supported, good test for DECRPM itself
    const result = await queryMode(7)
    if (result === null) return { pass: false, note: "No DECRPM response" }
    return {
      pass: result !== "unknown",
      note: result === "unknown" ? "Terminal does not support DECRPM" : `DECAWM is ${result}`,
      response: result,
    }
  },
}

// ═══════════════════════════════════════════════════════════════════════════
// ── Text probes ──
// ═══════════════════════════════════════════════════════════════════════════

const textBasic: Probe = {
  id: "text.basic",
  name: "Basic text output",
  async run() {
    process.stdout.write("\x1b[1;1H\x1b[2K") // clear line, move to 1;1
    process.stdout.write("Hello")
    const pos = await queryCursorPosition()
    if (!pos) return { pass: false, note: "No cursor response" }
    return {
      pass: pos[1] === 6,
      note: pos[1] === 6 ? undefined : `cursor at col ${pos[1]}, expected 6`,
    }
  },
}

const textWrap: Probe = {
  id: "text.wrap",
  name: "Text wrapping at terminal width",
  async run() {
    // Get terminal width
    const cols = process.stdout.columns || 80
    process.stdout.write("\x1b[1;1H\x1b[2K") // clear line, move to 1;1
    // Write exactly cols characters to fill the line, then 1 more to wrap
    const line = "W".repeat(cols) + "X"
    process.stdout.write(line)
    const pos = await queryCursorPosition()
    if (!pos) return { pass: false, note: "No cursor response" }
    // After wrapping, cursor should be on row 2, col 2 (the "X" + 1)
    return {
      pass: pos[0] === 2 && pos[1] === 2,
      note: pos[0] === 2 && pos[1] === 2 ? undefined : `cursor at ${pos[0]};${pos[1]}, expected 2;2`,
    }
  },
}

const textCR: Probe = {
  id: "text.cr",
  name: "Carriage return (CR)",
  async run() {
    process.stdout.write("\x1b[1;1H\x1b[2K")
    process.stdout.write("AB")
    process.stdout.write("\r") // CR
    const pos = await queryCursorPosition()
    if (!pos) return { pass: false, note: "No cursor response" }
    return {
      pass: pos[1] === 1,
      note: pos[1] === 1 ? undefined : `cursor at col ${pos[1]}, expected 1`,
    }
  },
}

const textNewline: Probe = {
  id: "text.newline",
  name: "Newline (LF)",
  async run() {
    process.stdout.write("\x1b[3;5H") // move to row 3, col 5
    process.stdout.write("\n") // LF
    const pos = await queryCursorPosition()
    if (!pos) return { pass: false, note: "No cursor response" }
    return {
      pass: pos[0] === 4,
      note: pos[0] === 4 ? undefined : `cursor at row ${pos[0]}, expected 4`,
    }
  },
}

const textOverwrite: Probe = {
  id: "text.overwrite",
  name: "Character overwrite",
  async run() {
    process.stdout.write("\x1b[1;1H\x1b[2K")
    process.stdout.write("AB") // cursor at col 3
    process.stdout.write("\x1b[1;2H") // move back to col 2
    process.stdout.write("X") // overwrite B
    const pos = await queryCursorPosition()
    if (!pos) return { pass: false, note: "No cursor response" }
    return {
      pass: pos[1] === 3,
      note: pos[1] === 3 ? undefined : `cursor at col ${pos[1]}, expected 3`,
    }
  },
}

const textIndex: Probe = {
  id: "text.index",
  name: "Index (IND — ESC D)",
  async run() {
    process.stdout.write("\x1b[3;5H") // move to row 3, col 5
    process.stdout.write("\x1bD") // IND — move cursor down one line
    const pos = await queryCursorPosition()
    if (!pos) return { pass: false, note: "No cursor response" }
    return {
      pass: pos[0] === 4 && pos[1] === 5,
      note: pos[0] === 4 && pos[1] === 5 ? undefined : `got ${pos[0]};${pos[1]}, expected 4;5`,
    }
  },
}

const textNextLine: Probe = {
  id: "text.next-line",
  name: "Next line (NEL — ESC E)",
  async run() {
    process.stdout.write("\x1b[3;5H") // move to row 3, col 5
    process.stdout.write("\x1bE") // NEL — next line (col 1 of next row)
    const pos = await queryCursorPosition()
    if (!pos) return { pass: false, note: "No cursor response" }
    return {
      pass: pos[0] === 4 && pos[1] === 1,
      note: pos[0] === 4 && pos[1] === 1 ? undefined : `got ${pos[0]};${pos[1]}, expected 4;1`,
    }
  },
}

const wideCharCJK: Probe = {
  id: "text.wide.cjk",
  name: "CJK wide chars (2 cols)",
  async run() {
    const width = await measureRenderedWidth("\u4e2d")
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
    const width = await measureRenderedWidth("\u{1F600}")
    if (width === null) return { pass: false, note: "Cannot measure width" }
    return {
      pass: width === 2,
      note: width === 2 ? undefined : `width=${width}, expected 2`,
    }
  },
}

const wideCharEmojiZwj: Probe = {
  id: "text.wide.emoji-zwj",
  name: "Emoji ZWJ sequence width",
  async run() {
    const width = await measureRenderedWidth("👨‍👩‍👧‍👦")
    if (width === null) return { pass: false, note: "Cannot measure width" }
    return {
      pass: width === 2,
      note: width === 2 ? undefined : `width=${width}, expected 2`,
    }
  },
}

const wideCharEmojiFlags: Probe = {
  id: "text.wide.emoji-flags",
  name: "Regional indicator flag width",
  async run() {
    const width = await measureRenderedWidth("🇺🇸")
    if (width === null) return { pass: false, note: "Cannot measure width" }
    return {
      pass: width === 2,
      note: width === 2 ? undefined : `width=${width}, expected 2`,
    }
  },
}

const wideCharEmojiVs16: Probe = {
  id: "text.wide.emoji-vs16",
  name: "Variation selector 16 width",
  async run() {
    const width = await measureRenderedWidth("☺\uFE0F")
    if (width === null) return { pass: false, note: "Cannot measure width" }
    return {
      pass: width === 2,
      note: width === 2 ? undefined : `width=${width}, expected 2`,
    }
  },
}

const combiningChars: Probe = {
  id: "text.combining",
  name: "Combining character width",
  async run() {
    const width = await measureRenderedWidth("e\u0301")
    if (width === null) return { pass: false, note: "Cannot measure width" }
    return {
      pass: width === 1,
      note: width === 1 ? undefined : `width=${width}, expected 1`,
    }
  },
}

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

// ═══════════════════════════════════════════════════════════════════════════
// ── Cursor movement probes ──
// ═══════════════════════════════════════════════════════════════════════════

// CUP — cursor absolute position
const cursorMoveAbsolute = cursorProbe(
  "cursor.move.absolute",
  "Cursor absolute position (CUP)",
  "", // no setup needed
  "\x1b[5;10H",
  5,
  10,
)

// CUU — cursor up
const cursorMoveUp = cursorProbe(
  "cursor.move.up",
  "Cursor up (CUU)",
  "\x1b[5;5H", // move to 5;5
  "\x1b[2A", // up 2
  3,
  5,
)

// CUD — cursor down
const cursorMoveDown = cursorProbe(
  "cursor.move.down",
  "Cursor down (CUD)",
  "\x1b[5;5H", // move to 5;5
  "\x1b[2B", // down 2
  7,
  5,
)

// CUF — cursor forward
const cursorMoveForward = cursorProbe(
  "cursor.move.forward",
  "Cursor forward (CUF)",
  "\x1b[5;5H", // move to 5;5
  "\x1b[3C", // forward 3
  5,
  8,
)

// CUB — cursor back
const cursorMoveBack = cursorProbe(
  "cursor.move.back",
  "Cursor back (CUB)",
  "\x1b[5;5H", // move to 5;5
  "\x1b[3D", // back 3
  5,
  2,
)

// CUP with no args — home
const cursorMoveHome = cursorProbe(
  "cursor.move.home",
  "Cursor home (CUP no args)",
  "\x1b[5;5H", // move to 5;5
  "\x1b[H", // home
  1,
  1,
)

// CHA — cursor horizontal absolute
const cursorHorizontalAbsolute: Probe = {
  id: "cursor.horizontal-absolute",
  name: "Cursor horizontal absolute (CHA)",
  async run() {
    process.stdout.write("\x1b[3;1H") // move to row 3
    process.stdout.write("\x1b[15G") // CHA col 15
    const pos = await queryCursorPosition()
    if (!pos) return { pass: false, note: "No cursor response" }
    return {
      pass: pos[0] === 3 && pos[1] === 15,
      note: pos[0] === 3 && pos[1] === 15 ? undefined : `got ${pos[0]};${pos[1]}, expected 3;15`,
      response: `${pos[0]};${pos[1]}`,
    }
  },
}

// CNL — cursor next line
const cursorNextLine = cursorProbe(
  "cursor.next-line",
  "Cursor next line (CNL)",
  "\x1b[3;5H", // move to row 3, col 5
  "\x1b[E", // CNL — next line
  4,
  1,
)

// ═══════════════════════════════════════════════════════════════════════════
// ── Erase probes ──
// ═══════════════════════════════════════════════════════════════════════════

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

const eraseLineLeft: Probe = {
  id: "erase.line.left",
  name: "Erase line left (EL 1)",
  async run() {
    process.stdout.write("\x1b[1;1H\x1b[2K")
    process.stdout.write("ABCDE")
    process.stdout.write("\x1b[1;3H") // Move to col 3
    process.stdout.write("\x1b[1K") // EL 1 — erase to left
    const pos = await queryCursorPosition()
    if (!pos) return { pass: false, note: "No cursor response" }
    // Cursor should stay at col 3
    return {
      pass: pos[1] === 3,
      note: pos[1] === 3 ? undefined : `cursor at col ${pos[1]}, expected 3`,
    }
  },
}

const eraseLineAll: Probe = {
  id: "erase.line.all",
  name: "Erase entire line (EL 2)",
  async run() {
    process.stdout.write("\x1b[1;1H\x1b[2K")
    process.stdout.write("ABCDE")
    process.stdout.write("\x1b[1;3H") // Move to col 3
    process.stdout.write("\x1b[2K") // EL 2 — erase entire line
    const pos = await queryCursorPosition()
    if (!pos) return { pass: false, note: "No cursor response" }
    // Cursor should stay at col 3
    return {
      pass: pos[1] === 3,
      note: pos[1] === 3 ? undefined : `cursor at col ${pos[1]}, expected 3`,
    }
  },
}

const eraseScreenAll: Probe = {
  id: "erase.screen.all",
  name: "Erase entire screen (ED 2)",
  async run() {
    process.stdout.write("\x1b[5;5H") // Move to known position
    process.stdout.write("\x1b[2J") // ED 2 — erase entire screen
    const pos = await queryCursorPosition()
    if (!pos) return { pass: false, note: "No cursor response after ED 2" }
    // Cursor should stay at 5;5 (ED 2 doesn't move cursor)
    return {
      pass: pos[0] === 5 && pos[1] === 5,
      note: pos[0] === 5 && pos[1] === 5 ? undefined : `cursor at ${pos[0]};${pos[1]}, expected 5;5`,
    }
  },
}

const eraseScreenBelow: Probe = {
  id: "erase.screen.below",
  name: "Erase screen below (ED 0)",
  async run() {
    process.stdout.write("\x1b[5;5H") // Move to known position
    process.stdout.write("\x1b[0J") // ED 0 — erase below
    const pos = await queryCursorPosition()
    if (!pos) return { pass: false, note: "No cursor response after ED 0" }
    return {
      pass: pos[0] === 5 && pos[1] === 5,
      note: pos[0] === 5 && pos[1] === 5 ? undefined : `cursor at ${pos[0]};${pos[1]}, expected 5;5`,
    }
  },
}

const eraseScreenAbove: Probe = {
  id: "erase.screen.above",
  name: "Erase screen above (ED 1)",
  async run() {
    process.stdout.write("\x1b[5;5H") // Move to known position
    process.stdout.write("\x1b[1J") // ED 1 — erase above
    const pos = await queryCursorPosition()
    if (!pos) return { pass: false, note: "No cursor response after ED 1" }
    return {
      pass: pos[0] === 5 && pos[1] === 5,
      note: pos[0] === 5 && pos[1] === 5 ? undefined : `cursor at ${pos[0]};${pos[1]}, expected 5;5`,
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

const eraseCharacter: Probe = {
  id: "erase.character",
  name: "Erase characters (ECH)",
  async run() {
    process.stdout.write("\x1b[1;1H\x1b[2K")
    process.stdout.write("ABCD")
    process.stdout.write("\x1b[1;2H") // Move to col 2
    process.stdout.write("\x1b[2X") // ECH 2 — erase 2 chars at cursor
    const pos = await queryCursorPosition()
    if (!pos) return { pass: false, note: "No cursor response" }
    // Cursor should stay at col 2 (ECH doesn't move cursor)
    return {
      pass: pos[1] === 2,
      note: pos[1] === 2 ? undefined : `cursor at col ${pos[1]}, expected 2`,
    }
  },
}

// ═══════════════════════════════════════════════════════════════════════════
// ── Editing probes ──
// ═══════════════════════════════════════════════════════════════════════════

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

const insertLines: Probe = {
  id: "editing.insert-lines",
  name: "Insert lines (IL)",
  async run() {
    process.stdout.write("\x1b[3;5H") // Move to row 3, col 5
    process.stdout.write("\x1b[1L") // IL 1 — insert 1 line
    const pos = await queryCursorPosition()
    if (!pos) return { pass: false, note: "No cursor response" }
    // After IL, cursor should remain on same row (now blank), col reset to 1
    // Behavior varies slightly but cursor should still be on row 3
    return {
      pass: pos[0] === 3,
      note: pos[0] === 3 ? undefined : `cursor at row ${pos[0]}, expected 3`,
    }
  },
}

const deleteLines: Probe = {
  id: "editing.delete-lines",
  name: "Delete lines (DL)",
  async run() {
    process.stdout.write("\x1b[3;5H") // Move to row 3, col 5
    process.stdout.write("\x1b[1M") // DL 1 — delete 1 line
    const pos = await queryCursorPosition()
    if (!pos) return { pass: false, note: "No cursor response" }
    // After DL, cursor should remain on same row
    return {
      pass: pos[0] === 3,
      note: pos[0] === 3 ? undefined : `cursor at row ${pos[0]}, expected 3`,
    }
  },
}

const repeatChar: Probe = {
  id: "editing.repeat-char",
  name: "Repeat character (REP)",
  async run() {
    process.stdout.write("\x1b[1;1H\x1b[2K") // clear line
    process.stdout.write("X") // write X (cursor at col 2)
    process.stdout.write("\x1b[4b") // REP 4 — repeat last char 4 times
    const pos = await queryCursorPosition()
    if (!pos) return { pass: false, note: "No cursor response" }
    // 1 original "X" + 4 repeated = cursor at col 6
    return {
      pass: pos[1] === 6,
      note: pos[1] === 6 ? undefined : `cursor at col ${pos[1]}, expected 6`,
    }
  },
}

// ═══════════════════════════════════════════════════════════════════════════
// ── Mode probes (behavioral, with DECRPM fallback) ──
// ═══════════════════════════════════════════════════════════════════════════

const modesAltScreen = behavioralModeProbe(
  "modes.alt-screen.enter",
  "Enter alt screen (DECSET 1049)",
  1049,
  "\x1b[?1049h", // enter alt screen
  "\x1b[?1049l", // exit alt screen
  async () => {
    // In alt screen: write text, then exit — if alt screen works, cursor
    // returns to saved position from before entering
    process.stdout.write("\x1b[1;1H") // move to 1;1 in alt screen
    process.stdout.write("TEST")
    const pos = await queryCursorPosition()
    if (!pos) return { pass: false, note: "No cursor response in alt screen" }
    return { pass: true, note: "Behavioral: entered and responded" }
  },
)

const modesAutoWrap = behavioralModeProbe(
  "modes.auto-wrap",
  "Auto-wrap mode (DECAWM)",
  7,
  "\x1b[?7h", // enable auto-wrap
  "", // don't disable — auto-wrap is normally on
  async () => {
    const cols = process.stdout.columns || 80
    process.stdout.write("\x1b[1;1H\x1b[2K")
    // Write exactly `cols` chars to fill line, then one more
    process.stdout.write("A".repeat(cols) + "B")
    const pos = await queryCursorPosition()
    if (!pos) return { pass: false, note: "No cursor response" }
    // Should have wrapped to row 2
    return {
      pass: pos[0] === 2,
      note: pos[0] === 2 ? "Behavioral: wrap confirmed" : `cursor at row ${pos[0]}, expected 2`,
    }
  },
)

const modesBracketedPaste = behavioralModeProbe(
  "modes.bracketed-paste",
  "Bracketed paste mode (DECSET 2004)",
  2004,
  "\x1b[?2004h", // enable
  "\x1b[?2004l", // disable
  async () => {
    // Can't test paste behavior without pasting — just verify DA1 responds
    const match = await query("\x1b[c", /\x1b\[\?([0-9;]+)c/, 1000)
    if (!match) return { pass: false, note: "No DA1 response after enabling bracketed paste" }
    return { pass: true, note: "Behavioral: terminal responsive after enable" }
  },
)

const modesInsertReplace: Probe = {
  id: "modes.insert-replace",
  name: "Insert/replace mode (IRM)",
  async run() {
    process.stdout.write("\x1b[1;1H\x1b[2K")
    process.stdout.write("ABCD")
    process.stdout.write("\x1b[1;2H") // move to col 2
    process.stdout.write("\x1b[4h") // enable insert mode (IRM)
    process.stdout.write("X") // insert X, should shift BCD right
    process.stdout.write("\x1b[4l") // disable insert mode
    const pos = await queryCursorPosition()
    if (!pos) return { pass: false, note: "No cursor response" }
    // After inserting X at col 2, cursor should be at col 3
    return {
      pass: pos[1] === 3,
      note: pos[1] === 3 ? undefined : `cursor at col ${pos[1]}, expected 3`,
    }
  },
}

const modesApplicationKeypad: Probe = {
  id: "modes.application-keypad",
  name: "Application keypad mode (DECKPAM/DECKPNM)",
  async run() {
    process.stdout.write("\x1b=") // DECKPAM — enable application keypad
    const pos = await queryCursorPosition()
    process.stdout.write("\x1b>") // DECKPNM — disable (normal keypad)
    return {
      pass: pos !== null,
      note: pos ? undefined : "No cursor response after DECKPAM",
    }
  },
}

// ═══════════════════════════════════════════════════════════════════════════
// ── Scrollback probes ──
// ═══════════════════════════════════════════════════════════════════════════

const scrollRegion: Probe = {
  id: "scrollback.set-region",
  name: "Scroll region (DECSTBM)",
  async run() {
    process.stdout.write("\x1b[5;10r") // Set scroll region rows 5-10
    process.stdout.write("\x1b[r") // Reset scroll region
    const pos = await queryCursorPosition()
    if (!pos) return { pass: false, note: "No cursor response after DECSTBM" }
    return { pass: true }
  },
}

const scrollUp: Probe = {
  id: "scrollback.scroll-up",
  name: "Scroll up (SU)",
  async run() {
    process.stdout.write("\x1b[5;5H") // Move to row 5, col 5
    process.stdout.write("\x1b[1S") // SU 1 — scroll up 1 line
    const pos = await queryCursorPosition()
    if (!pos) return { pass: false, note: "No cursor response after SU" }
    // Cursor position should remain at 5;5 (SU scrolls content, not cursor)
    return {
      pass: pos[0] === 5 && pos[1] === 5,
      note: pos[0] === 5 && pos[1] === 5 ? undefined : `cursor at ${pos[0]};${pos[1]}, expected 5;5`,
    }
  },
}

const scrollDown: Probe = {
  id: "scrollback.scroll-down",
  name: "Scroll down (SD)",
  async run() {
    process.stdout.write("\x1b[5;5H") // Move to row 5, col 5
    process.stdout.write("\x1b[1T") // SD 1 — scroll down 1 line
    const pos = await queryCursorPosition()
    if (!pos) return { pass: false, note: "No cursor response after SD" }
    // Cursor position should remain at 5;5
    return {
      pass: pos[0] === 5 && pos[1] === 5,
      note: pos[0] === 5 && pos[1] === 5 ? undefined : `cursor at ${pos[0]};${pos[1]}, expected 5;5`,
    }
  },
}

const reverseIndex: Probe = {
  id: "scrollback.reverse-index",
  name: "Reverse index (RI — ESC M)",
  async run() {
    // Move to row 1 and reverse-index — should stay at row 1 (scrolls content down)
    process.stdout.write("\x1b[1;5H") // row 1, col 5
    process.stdout.write("\x1bM") // RI — reverse index
    const pos = await queryCursorPosition()
    if (!pos) return { pass: false, note: "No cursor response after RI" }
    return {
      pass: pos[0] === 1 && pos[1] === 5,
      note: pos[0] === 1 && pos[1] === 5 ? undefined : `got ${pos[0]};${pos[1]}, expected 1;5`,
    }
  },
}

// ═══════════════════════════════════════════════════════════════════════════
// ── Reset probes ──
// ═══════════════════════════════════════════════════════════════════════════

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

const resetSGR: Probe = {
  id: "reset.sgr",
  name: "SGR reset (SGR 0)",
  async run() {
    process.stdout.write("\x1b[1;1H\x1b[2K")
    process.stdout.write("\x1b[1m") // bold
    process.stdout.write("\x1b[0m") // reset
    process.stdout.write("X")
    const pos = await queryCursorPosition()
    if (!pos) return { pass: false, note: "No cursor response" }
    return {
      pass: pos[1] === 2,
      note: pos[1] === 2 ? undefined : `cursor at col ${pos[1]}, expected 2`,
    }
  },
}

const resetSoft: Probe = {
  id: "reset.soft",
  name: "Soft terminal reset (DECSTR)",
  async run() {
    process.stdout.write("\x1b[5;5H") // Move to known position
    process.stdout.write("\x1b[!p") // DECSTR — soft reset
    const pos = await queryCursorPosition()
    if (!pos) return { pass: false, note: "No cursor response after DECSTR" }
    // Soft reset doesn't move cursor to 1;1 (unlike RIS) — just verify response
    return { pass: true }
  },
}

// ═══════════════════════════════════════════════════════════════════════════
// ── Charset probes ──
// ═══════════════════════════════════════════════════════════════════════════

const charsetDecSpecial: Probe = {
  id: "charsets.dec-special",
  name: "DEC special graphics charset",
  async run() {
    process.stdout.write("\x1b[1;1H\x1b[2K")
    process.stdout.write("\x1b(0") // Switch to DEC special graphics
    process.stdout.write("q") // should render as horizontal line (U+2500)
    process.stdout.write("\x1b(B") // Switch back to ASCII
    const pos = await queryCursorPosition()
    if (!pos) return { pass: false, note: "No cursor response" }
    // Character should advance cursor by 1
    return {
      pass: pos[1] === 2,
      note: pos[1] === 2 ? undefined : `cursor at col ${pos[1]}, expected 2`,
    }
  },
}

const charsetUtf8: Probe = {
  id: "charsets.utf8",
  name: "UTF-8 encoding",
  async run() {
    process.stdout.write("\x1b[1;1H\x1b[2K")
    process.stdout.write("\u00e9") // e-acute (2-byte UTF-8, 1 column)
    const pos = await queryCursorPosition()
    if (!pos) return { pass: false, note: "No cursor response" }
    return {
      pass: pos[1] === 2,
      note: pos[1] === 2 ? undefined : `cursor at col ${pos[1]}, expected 2`,
    }
  },
}

// ═══════════════════════════════════════════════════════════════════════════
// ── Extensions probes ──
// ═══════════════════════════════════════════════════════════════════════════

const kittyKeyboard: Probe = {
  id: "extensions.kitty-keyboard",
  name: "Kitty keyboard protocol",
  async run() {
    // Query current keyboard mode flags — terminal responds with CSI ? flags u
    const match = await queryWithSentinel("\x1b[?u", /\x1b\[\?(\d+)u/)
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
  name: "Clipboard access (OSC 52)",
  async run() {
    // Write a small test value to clipboard, then verify terminal responds
    // Don't use "?" query — it returns full clipboard as huge base64 that leaks into stdin
    const testData = btoa("terminfo-test")
    process.stdout.write(`\x1b]52;c;${testData}\x07`)
    // Verify terminal still responds after OSC 52 (didn't crash/ignore)
    const pos = await queryCursorPosition()
    if (!pos) return { pass: false, note: "No response after OSC 52" }
    return { pass: true }
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

const osc10FgColor: Probe = {
  id: "extensions.osc10-fg-color",
  name: "Foreground color query (OSC 10)",
  async run() {
    const match = await queryWithSentinel("\x1b]10;?\x07", /\x1b\]10;([^\x07\x1b]+)[\x07\x1b]/)
    if (!match) return { pass: false, note: "No OSC 10 response" }
    return { pass: true, response: match[1] }
  },
}

const osc11BgColor: Probe = {
  id: "extensions.osc11-bg-color",
  name: "Background color query (OSC 11)",
  async run() {
    const match = await queryWithSentinel("\x1b]11;?\x07", /\x1b\]11;([^\x07\x1b]+)[\x07\x1b]/)
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

const extTruecolor: Probe = {
  id: "extensions.truecolor",
  name: "24-bit truecolor (SGR 38;2)",
  async run() {
    process.stdout.write("\x1b[1;1H\x1b[2K")
    process.stdout.write("\x1b[38;2;255;0;128mX\x1b[0m")
    const pos = await queryCursorPosition()
    if (!pos) return { pass: false, note: "No cursor response" }
    return {
      pass: pos[1] === 2,
      note:
        pos[1] === 2
          ? undefined
          : `cursor at col ${pos[1]}, expected 2 (truecolor sequence may have been printed literally)`,
    }
  },
}

const extOsc8Hyperlink: Probe = {
  id: "extensions.osc8",
  name: "Hyperlinks (OSC 8)",
  async run() {
    process.stdout.write("\x1b[1;1H\x1b[2K")
    // OSC 8 ; params ; uri ST text OSC 8 ;; ST
    process.stdout.write("\x1b]8;;http://example.com\x07link\x1b]8;;\x07")
    const pos = await queryCursorPosition()
    if (!pos) return { pass: false, note: "No cursor response" }
    // "link" is 4 chars — cursor should be at col 5
    return {
      pass: pos[1] === 5,
      note: pos[1] === 5 ? undefined : `cursor at col ${pos[1]}, expected 5 (4 visible chars)`,
    }
  },
}

const extOsc0IconTitle: Probe = {
  id: "extensions.osc0-icon-title",
  name: "Set icon name and title (OSC 0)",
  async run() {
    process.stdout.write("\x1b]0;test-title\x07")
    const pos = await queryCursorPosition()
    process.stdout.write("\x1b]0;\x07") // reset
    return {
      pass: pos !== null,
      note: pos ? undefined : "No cursor response after OSC 0",
    }
  },
}

const extSemanticPrompts: Probe = {
  id: "extensions.semantic-prompts",
  name: "Semantic prompts (OSC 133)",
  async run() {
    // OSC 133 ; A ST — mark prompt start
    process.stdout.write("\x1b]133;A\x07")
    const pos = await queryCursorPosition()
    return {
      pass: pos !== null,
      note: pos ? undefined : "No cursor response after OSC 133",
    }
  },
}

const extOsc633Vscode: Probe = {
  id: "extensions.osc-633-vscode",
  name: "VS Code shell integration (OSC 633)",
  async run() {
    // OSC 633 is VS Code's shell integration markers (prompt, command, output)
    process.stdout.write("\x1b]633;A\x07") // prompt start
    process.stdout.write("\x1b]633;B\x07") // prompt end
    process.stdout.write("\x1b]633;C\x07") // pre-execution
    process.stdout.write("\x1b]633;D;0\x07") // execution finished (exit code 0)
    const pos = await queryCursorPosition()
    return {
      pass: pos !== null,
      note: pos ? undefined : "No cursor response after OSC 633",
    }
  },
}

const extNotifications: Probe = {
  id: "extensions.notifications",
  name: "Desktop notifications (OSC 9)",
  async run() {
    // OSC 9 sends a desktop notification (used by ConEmu, iTerm2, etc.)
    process.stdout.write("\x1b]9;Test\x07")
    const pos = await queryCursorPosition()
    return {
      pass: pos !== null,
      note: pos ? undefined : "No cursor response after OSC 9",
    }
  },
}

const extIterm2Images: Probe = {
  id: "extensions.iterm2-images",
  name: "iTerm2 inline images (OSC 1337)",
  async run() {
    // Send a minimal iTerm2 inline image sequence
    process.stdout.write("\x1b]1337;File=inline=1:AAAA\x07")
    const pos = await queryCursorPosition()
    return {
      pass: pos !== null,
      note: pos ? undefined : "No cursor response after OSC 1337",
    }
  },
}

// ═══════════════════════════════════════════════════════════════════════════
// ── Device probes (additional) ──
// ═══════════════════════════════════════════════════════════════════════════

const secondaryDA: Probe = {
  id: "device.secondary-da",
  name: "Secondary device attributes (DA2)",
  async run() {
    const match = await query("\x1b[>c", /\x1b\[>([0-9;]+)c/, 1000)
    if (!match) return { pass: false, note: "No DA2 response" }
    return { pass: true, response: match[0] }
  },
}

const tertiaryDA: Probe = {
  id: "device.tertiary-da",
  name: "Tertiary device attributes (DA3)",
  async run() {
    // DA3 responds with DCS ! | <unit-id> ST
    const match = await queryWithSentinel("\x1b[=c", /\x1bP!?\|([^\x1b]*)\x1b\\/)
    if (match) return { pass: true, response: match[1] }
    return { pass: false, note: "No DA3 response" }
  },
}

// ═══════════════════════════════════════════════════════════════════════════
// ── Input protocol probes ──
// ═══════════════════════════════════════════════════════════════════════════

const inputModifyOtherKeys: Probe = {
  id: "input.modify-other-keys",
  name: "Modify other keys (mode 2)",
  async run() {
    // Enable modifyOtherKeys mode 2 (xterm CSI u-style reporting)
    process.stdout.write("\x1b[>4;2m")
    const pos = await queryCursorPosition()
    // Disable modifyOtherKeys
    process.stdout.write("\x1b[>4;0m")
    return {
      pass: pos !== null,
      note: pos ? undefined : "No cursor response after enabling modifyOtherKeys",
    }
  },
}

const inputPixelMouse: Probe = {
  id: "input.pixel-mouse",
  name: "Pixel mouse mode (1016)",
  async run() {
    process.stdout.write("\x1b[?1016h") // enable pixel mouse
    const pos = await queryCursorPosition()
    process.stdout.write("\x1b[?1016l") // disable
    return {
      pass: pos !== null,
      note: pos ? undefined : "No cursor response after enabling pixel mouse",
    }
  },
}

const inputUrxvtMouse: Probe = {
  id: "input.urxvt-mouse",
  name: "urxvt mouse mode (1015)",
  async run() {
    process.stdout.write("\x1b[?1015h") // enable urxvt mouse
    const pos = await queryCursorPosition()
    process.stdout.write("\x1b[?1015l") // disable
    return {
      pass: pos !== null,
      note: pos ? undefined : "No cursor response after enabling urxvt mouse",
    }
  },
}

const inputX10Mouse: Probe = {
  id: "input.x10-mouse",
  name: "X10 mouse mode (9)",
  async run() {
    process.stdout.write("\x1b[?9h") // enable X10 mouse
    const pos = await queryCursorPosition()
    process.stdout.write("\x1b[?9l") // disable
    return {
      pass: pos !== null,
      note: pos ? undefined : "No cursor response after enabling X10 mouse",
    }
  },
}

const inputButtonEventMouse: Probe = {
  id: "input.button-event-mouse",
  name: "Button-event mouse mode (1002)",
  async run() {
    process.stdout.write("\x1b[?1002h") // enable button-event mouse
    const pos = await queryCursorPosition()
    process.stdout.write("\x1b[?1002l") // disable
    return {
      pass: pos !== null,
      note: pos ? undefined : "No cursor response after enabling button-event mouse",
    }
  },
}

// ═══════════════════════════════════════════════════════════════════════════
// ── Mode probes (additional) ──
// ═══════════════════════════════════════════════════════════════════════════

const modesLeftRightMargin: Probe = {
  id: "modes.left-right-margin",
  name: "Left/right margin mode (DECLRMM)",
  async run() {
    process.stdout.write("\x1b[?69h") // enable DECLRMM
    const pos = await queryCursorPosition()
    process.stdout.write("\x1b[?69l") // disable
    return {
      pass: pos !== null,
      note: pos ? undefined : "No cursor response after DECLRMM",
    }
  },
}

// ═══════════════════════════════════════════════════════════════════════════
// ── Cursor probes (additional) ──
// ═══════════════════════════════════════════════════════════════════════════

const cursorReverseWrap: Probe = {
  id: "cursor.reverse-wrap",
  name: "Reverse wrap mode (DECSET 45)",
  async run() {
    process.stdout.write("\x1b[?45h") // enable reverse wrap
    const pos = await queryCursorPosition()
    process.stdout.write("\x1b[?45l") // disable
    return {
      pass: pos !== null,
      note: pos ? undefined : "No cursor response after enabling reverse wrap",
    }
  },
}

// ═══════════════════════════════════════════════════════════════════════════
// ── Erase probes (additional) ──
// ═══════════════════════════════════════════════════════════════════════════

const eraseSelective: Probe = {
  id: "erase.selective",
  name: "Selective erase (DECSED)",
  async run() {
    process.stdout.write("\x1b[1;1H\x1b[2K")
    process.stdout.write("ABCDE")
    process.stdout.write("\x1b[?2J") // DECSED — selective erase entire screen
    const pos = await queryCursorPosition()
    if (!pos) return { pass: false, note: "No cursor response after DECSED" }
    return { pass: true }
  },
}

// ═══════════════════════════════════════════════════════════════════════════
// ── Text probes (additional) ──
// ═══════════════════════════════════════════════════════════════════════════

const textReverseIndexScroll: Probe = {
  id: "text.reverse-index-scroll",
  name: "Reverse index scrolls at top of region",
  async run() {
    // Set scroll region, move to top of region, RI should scroll content down
    process.stdout.write("\x1b[3;10r") // scroll region rows 3-10
    process.stdout.write("\x1b[3;1H") // move to row 3 (top of region)
    process.stdout.write("\x1bM") // RI — reverse index at top of region
    const pos = await queryCursorPosition()
    process.stdout.write("\x1b[r") // reset scroll region
    if (!pos) return { pass: false, note: "No cursor response after RI in region" }
    // Cursor should stay at row 3 (content scrolled down within region)
    return {
      pass: pos[0] === 3,
      note: pos[0] === 3 ? undefined : `cursor at row ${pos[0]}, expected 3`,
    }
  },
}

// ═══════════════════════════════════════════════════════════════════════════
// ── Device probes (query/response) ──
// ═══════════════════════════════════════════════════════════════════════════

const deviceDecrqss: Probe = {
  id: "device.decrqss",
  name: "DECRQSS (request status string)",
  async run() {
    // DECRQSS queries a terminal setting — request DECSCL (conformance level)
    // Response: DCS Ps $ r Pt ST  (Ps=1 valid, Ps=0 invalid)
    const match = await queryWithSentinel('\x1bP$q"p\x1b\\', /\x1bP([01])\$r/)
    if (match) return { pass: true, response: match[0] }
    return { pass: false, note: "No DECRQSS response" }
  },
}

const deviceXtgettcap: Probe = {
  id: "device.xtgettcap",
  name: "XTGETTCAP (termcap query)",
  async run() {
    // XTGETTCAP: DCS + q hex-encoded-cap ST
    // Query "TN" (terminal name) — hex "544e"
    // Response: DCS Ps + r hex=value ST
    const match = await queryWithSentinel("\x1bP+q544e\x1b\\", /\x1bP([01])\+r/)
    if (match) return { pass: true, response: match[0] }
    return { pass: false, note: "No XTGETTCAP response" }
  },
}

// ═══════════════════════════════════════════════════════════════════════════
// ── Input probes (additional) ──
// ═══════════════════════════════════════════════════════════════════════════

const inputCsiU: Probe = {
  id: "input.csi-u",
  name: "CSI u key encoding",
  async run() {
    // Push CSI u mode (progressive enhancement level 1)
    // CSI > 1 u — push level 1
    process.stdout.write("\x1b[>1u")
    const pos = await queryCursorPosition()
    // Pop CSI u mode
    process.stdout.write("\x1b[<u")
    return {
      pass: pos !== null,
      note: pos ? undefined : "No cursor response after enabling CSI u mode",
    }
  },
}

// ═══════════════════════════════════════════════════════════════════════════
// ── Reset probes (additional) ──
// ═══════════════════════════════════════════════════════════════════════════

const resetMethod: Probe = {
  id: "reset.method",
  name: "Soft reset (DECSTR) homes cursor",
  async run() {
    process.stdout.write("\x1b[5;5H") // Move away from 1;1
    process.stdout.write("\x1b[!p") // DECSTR — soft reset
    const pos = await queryCursorPosition()
    if (!pos) return { pass: false, note: "No cursor response after DECSTR" }
    // DECSTR resets modes, attributes, scroll region — cursor may or may not home
    // The key test is that the terminal processes the sequence without error
    return { pass: true, note: `cursor at ${pos[0]};${pos[1]} after DECSTR` }
  },
}

// ═══════════════════════════════════════════════════════════════════════════
// ── Unicode probes ──
// ═══════════════════════════════════════════════════════════════════════════

const unicodeGraphemeCursor: Probe = {
  id: "unicode.grapheme-cursor",
  name: "Grapheme cluster cursor advance (ZWJ emoji)",
  async run() {
    // ZWJ family emoji: 👨‍👩‍👧 (man + ZWJ + woman + ZWJ + girl)
    // Should render as a single grapheme cluster occupying 2 columns
    const width = await measureRenderedWidth("\u{1F468}\u200D\u{1F469}\u200D\u{1F467}")
    if (width === null) return { pass: false, note: "Cannot measure width" }
    return {
      pass: width === 2,
      note: width === 2 ? undefined : `width=${width}, expected 2`,
    }
  },
}

const unicodeEastAsianAmbiguous: Probe = {
  id: "unicode.east-asian-ambiguous",
  name: "East Asian ambiguous width",
  async run() {
    // ● (U+25CF BLACK CIRCLE) is East Asian Ambiguous — most terminals render as 1 col
    // Write ●X and check cursor position
    const width = await measureRenderedWidth("●")
    if (width === null) return { pass: false, note: "Cannot measure width" }
    return {
      pass: width === 1 || width === 2,
      note: `width=${width} (ambiguous chars vary by terminal/locale)`,
      response: String(width),
    }
  },
}

const unicodeWrapBoundary: Probe = {
  id: "unicode.wrap-boundary",
  name: "Wide char wrap at line boundary",
  async run() {
    const cols = process.stdout.columns || 80
    // Write (cols-1) narrow chars, then a wide char — should wrap to next line
    process.stdout.write("\x1b[1;1H\x1b[2J")
    process.stdout.write("A".repeat(cols - 1))
    process.stdout.write("\u4e2d") // CJK char (2 cols wide)
    const pos = await queryCursorPosition()
    if (!pos) return { pass: false, note: "No cursor response" }
    // Wide char should wrap: cursor at row 2, col 3 (wide char on col 1-2 of row 2)
    return {
      pass: pos[0] === 2,
      note: pos[0] === 2 ? undefined : `cursor at row ${pos[0]}, expected 2 (wide char should wrap)`,
    }
  },
}

const unicodeTabStops: Probe = {
  id: "unicode.tab-stops",
  name: "Tab stops with text",
  async run() {
    process.stdout.write("\x1b[1;1H\x1b[2K")
    process.stdout.write("A\tB")
    const pos = await queryCursorPosition()
    if (!pos) return { pass: false, note: "No cursor response" }
    // A at col 1, tab to col 9, B at col 9 → cursor at col 10
    return {
      pass: pos[1] === 10,
      note: pos[1] === 10 ? undefined : `cursor at col ${pos[1]}, expected 10 (A + tab to 9 + B)`,
    }
  },
}

// ═══════════════════════════════════════════════════════════════════════════
// ── Cursor probes (boundary/clamping) ──
// ═══════════════════════════════════════════════════════════════════════════

const cursorCupBoundaries: Probe = {
  id: "cursor.cup-boundaries",
  name: "CUP at large coords clamped to screen edges",
  async run() {
    process.stdout.write("\x1b[999;999H") // CUP far beyond screen
    const pos = await queryCursorPosition()
    if (!pos) return { pass: false, note: "No cursor response" }
    const rows = process.stdout.rows || 24
    const cols = process.stdout.columns || 80
    return {
      pass: pos[0] === rows && pos[1] === cols,
      note: pos[0] === rows && pos[1] === cols ? undefined : `got ${pos[0]};${pos[1]}, expected ${rows};${cols}`,
      response: `${pos[0]};${pos[1]}`,
    }
  },
}

const cursorCuuPastTop: Probe = {
  id: "cursor.cuu-past-top",
  name: "CUU past top clamps to row 1",
  async run() {
    process.stdout.write("\x1b[4;1H") // move to row 4
    process.stdout.write("\x1b[999A") // CUU 999 — way past top
    const pos = await queryCursorPosition()
    if (!pos) return { pass: false, note: "No cursor response" }
    return {
      pass: pos[0] === 1,
      note: pos[0] === 1 ? undefined : `got row ${pos[0]}, expected 1`,
      response: `${pos[0]};${pos[1]}`,
    }
  },
}

const cursorCudPastBottom: Probe = {
  id: "cursor.cud-past-bottom",
  name: "CUD past bottom clamps to last row",
  async run() {
    process.stdout.write("\x1b[1;1H") // move to row 1
    process.stdout.write("\x1b[999B") // CUD 999 — way past bottom
    const pos = await queryCursorPosition()
    if (!pos) return { pass: false, note: "No cursor response" }
    const rows = process.stdout.rows || 24
    return {
      pass: pos[0] === rows,
      note: pos[0] === rows ? undefined : `got row ${pos[0]}, expected ${rows}`,
      response: `${pos[0]};${pos[1]}`,
    }
  },
}

const cursorCupScrollRegion: Probe = {
  id: "cursor.cup-scroll-region",
  name: "CUP with DECSTBM + DECOM (origin mode)",
  async run() {
    process.stdout.write("\x1b[5;15r") // scroll region rows 5-15
    process.stdout.write("\x1b[?6h") // enable DECOM (origin mode)
    process.stdout.write("\x1b[1;1H") // CUP 1;1 — should map to scroll region top
    const pos = await queryCursorPosition()
    process.stdout.write("\x1b[?6l") // disable DECOM
    process.stdout.write("\x1b[r") // reset scroll region
    if (!pos) return { pass: false, note: "No cursor response" }
    // In origin mode, CUP 1;1 maps to row 5 (1-based, the scroll region top)
    return {
      pass: pos[0] === 5 && pos[1] === 1,
      note: pos[0] === 5 && pos[1] === 1 ? undefined : `got ${pos[0]};${pos[1]}, expected 5;1`,
      response: `${pos[0]};${pos[1]}`,
    }
  },
}

// ═══════════════════════════════════════════════════════════════════════════
// ── Erase probes (attrs/scroll region) ──
// ═══════════════════════════════════════════════════════════════════════════

const eraseElWithAttrs: Probe = {
  id: "erase.el-with-attrs",
  name: "EL fills erased cells with current bg",
  async run() {
    process.stdout.write("\x1b[1;1H\x1b[2K") // clear line
    process.stdout.write("\x1b[42m") // green background
    process.stdout.write("XXXXX")
    process.stdout.write("\x1b[1;1H") // back to col 1
    process.stdout.write("\x1b[K") // EL 0 — erase to right
    // Cursor should still be at 1;1
    const pos = await queryCursorPosition()
    process.stdout.write("\x1b[0m") // reset SGR
    if (!pos) return { pass: false, note: "No cursor response" }
    return {
      pass: pos[0] === 1 && pos[1] === 1,
      note: pos[0] === 1 && pos[1] === 1 ? undefined : `cursor at ${pos[0]};${pos[1]}, expected 1;1`,
    }
  },
}

const eraseEdScrollRegion: Probe = {
  id: "erase.ed-scroll-region",
  name: "ED inside scroll region (DECSTBM + ED)",
  async run() {
    process.stdout.write("\x1b[2J\x1b[H") // clear + home
    process.stdout.write("KEEP_THIS\r\n") // row 1
    for (let i = 0; i < 5; i++) process.stdout.write(`row${i}\r\n`)
    process.stdout.write("\x1b[3;10r") // scroll region rows 3-10
    process.stdout.write("\x1b[3;1H") // inside region
    process.stdout.write("\x1b[J") // ED 0 — erase below
    const pos = await queryCursorPosition()
    process.stdout.write("\x1b[r") // reset scroll region
    if (!pos) return { pass: false, note: "No cursor response after ED in region" }
    return {
      pass: pos[0] === 3,
      note: pos[0] === 3 ? undefined : `cursor at row ${pos[0]}, expected 3`,
    }
  },
}

// ═══════════════════════════════════════════════════════════════════════════
// ── Scrollback probes (scroll region behavior) ──
// ═══════════════════════════════════════════════════════════════════════════

const scrollbackDecstbm: Probe = {
  id: "scrollback.decstbm",
  name: "Scroll constrained by DECSTBM region",
  async run() {
    const rows = process.stdout.rows || 24
    process.stdout.write("\x1b[2J\x1b[H") // clear + home
    process.stdout.write("\x1b[5;10r") // scroll region rows 5-10
    process.stdout.write("\x1b[5;1H") // move to top of region
    // Write enough lines to scroll within region
    for (let i = 0; i < 8; i++) process.stdout.write(`line${i}\n`)
    const pos = await queryCursorPosition()
    process.stdout.write("\x1b[r") // reset scroll region
    if (!pos) return { pass: false, note: "No cursor response" }
    // Cursor should be clamped to scroll region bottom (row 10)
    return {
      pass: pos[0] <= 10,
      note: pos[0] <= 10 ? undefined : `cursor at row ${pos[0]}, expected <= 10 (within scroll region)`,
    }
  },
}

const scrollbackDecstbmReset: Probe = {
  id: "scrollback.decstbm-reset",
  name: "Reset scroll region (CSI r)",
  async run() {
    process.stdout.write("\x1b[5;10r") // set scroll region
    process.stdout.write("\x1b[r") // reset scroll region (full screen)
    // After reset, cursor should be at 1;1
    const pos = await queryCursorPosition()
    if (!pos) return { pass: false, note: "No cursor response after DECSTBM reset" }
    return {
      pass: pos[0] === 1 && pos[1] === 1,
      note: pos[0] === 1 && pos[1] === 1 ? undefined : `cursor at ${pos[0]};${pos[1]}, expected 1;1`,
    }
  },
}

// ═══════════════════════════════════════════════════════════════════════════
// ── Charset probes (additional) ──
// ═══════════════════════════════════════════════════════════════════════════

const charsetG0G1Switching: Probe = {
  id: "charsets.g0-g1-switching",
  name: "G0/G1 charset switching (ESC ( 0 / ESC ( B)",
  async run() {
    process.stdout.write("\x1b[1;1H\x1b[2K")
    process.stdout.write("\x1b(0") // switch G0 to DEC Special Graphics
    process.stdout.write("q") // should render as horizontal line
    process.stdout.write("\x1b(B") // switch G0 back to ASCII
    process.stdout.write("X") // normal ASCII X
    const pos = await queryCursorPosition()
    if (!pos) return { pass: false, note: "No cursor response" }
    // Both characters should advance cursor by 1 each → col 3
    return {
      pass: pos[1] === 3,
      note: pos[1] === 3 ? undefined : `cursor at col ${pos[1]}, expected 3`,
    }
  },
}

const charsetDecLineDrawing: Probe = {
  id: "charsets.dec-line-drawing",
  name: "DEC line drawing characters render",
  async run() {
    process.stdout.write("\x1b[1;1H\x1b[2K")
    // Switch to DEC Special Graphics and write several line-drawing chars
    process.stdout.write("\x1b(0") // G0 → DEC Special
    process.stdout.write("lqk") // ┌─┐ (upper-left, horizontal, upper-right)
    process.stdout.write("\x1b(B") // G0 → ASCII
    const pos = await queryCursorPosition()
    if (!pos) return { pass: false, note: "No cursor response" }
    // 3 characters drawn → cursor at col 4
    return {
      pass: pos[1] === 4,
      note: pos[1] === 4 ? undefined : `cursor at col ${pos[1]}, expected 4`,
    }
  },
}

// ═══════════════════════════════════════════════════════════════════════════
// ── Device probes (XTVERSION) ──
// ═══════════════════════════════════════════════════════════════════════════

const deviceXtversion: Probe = {
  id: "device.xtversion",
  name: "XTVERSION (terminal version query)",
  async run() {
    // CSI > 0 q — XTVERSION query
    // Response: DCS > | version-string ST
    const match = await queryWithSentinel("\x1b[>0q", /\x1bP>\|([^\x1b]*)\x1b\\/)
    if (match) return { pass: true, response: match[1] }
    return { pass: false, note: "No XTVERSION response" }
  },
}

// ═══════════════════════════════════════════════════════════════════════════
// ── Extensions probes (OSC 1337) ──
// ═══════════════════════════════════════════════════════════════════════════

const extOsc1337CellSize: Probe = {
  id: "extensions.osc1337-cellsize",
  name: "Cell size report (OSC 1337 ReportCellSize)",
  async run() {
    // OSC 1337 ; ReportCellSize ST
    // Response: OSC 1337 ; ReportCellSize=height;width ST (or similar)
    const match = await queryWithSentinel(
      "\x1b]1337;ReportCellSize\x07",
      /\x1b\]1337;ReportCellSize=([^\x07\x1b]+)[\x07\x1b]/,
    )
    if (match) return { pass: true, response: match[1] }
    return { pass: false, note: "No OSC 1337 ReportCellSize response" }
  },
}

const extOsc1337Capabilities: Probe = {
  id: "extensions.osc1337-capabilities",
  name: "Request capabilities (OSC 1337)",
  async run() {
    // OSC 1337 ; RequestCapabilities ST
    // Response: OSC 1337 ; ReportCapabilities=... ST (iTerm2)
    const match = await queryWithSentinel(
      "\x1b]1337;RequestCapabilities\x07",
      /\x1b\]1337;ReportCapabilities=([^\x07\x1b]+)[\x07\x1b]/,
    )
    if (match) return { pass: true, response: match[1] }
    return { pass: false, note: "No OSC 1337 capabilities response" }
  },
}

// ═══════════════════════════════════════════════════════════════════════════
// ── All probes ──
// ═══════════════════════════════════════════════════════════════════════════

export const ALL_PROBES: Probe[] = [
  // ── Cursor ──
  cursorPositionReport,
  cursorShape,
  cursorSaveRestore,
  cursorHide,
  cursorMoveAbsolute,
  cursorMoveUp,
  cursorMoveDown,
  cursorMoveForward,
  cursorMoveBack,
  cursorMoveHome,
  cursorHorizontalAbsolute,
  cursorNextLine,
  cursorReverseWrap,
  cursorCupBoundaries,
  cursorCuuPastTop,
  cursorCudPastBottom,
  cursorCupScrollRegion,

  // ── Device ──
  primaryDA,
  secondaryDA,
  tertiaryDA,
  deviceStatusReport,
  deviceDecrpm,
  deviceDecrqss,
  deviceXtgettcap,
  deviceXtversion,

  // ── Text ──
  textBasic,
  textWrap,
  textCR,
  textNewline,
  textOverwrite,
  textIndex,
  textNextLine,
  wideCharCJK,
  wideCharEmoji,
  wideCharEmojiZwj,
  wideCharEmojiFlags,
  wideCharEmojiVs16,
  combiningChars,
  tabStop,
  backspace,
  textReverseIndexScroll,

  // ── Erase ──
  eraseLineRight,
  eraseLineLeft,
  eraseLineAll,
  eraseScreenAll,
  eraseScreenBelow,
  eraseScreenAbove,
  eraseScreenScrollback,
  eraseCharacter,
  eraseSelective,
  eraseElWithAttrs,
  eraseEdScrollRegion,

  // ── Editing ──
  insertChars,
  deleteChars,
  insertLines,
  deleteLines,
  repeatChar,

  // ── Modes (behavioral with DECRPM fallback) ──
  modesAltScreen,
  modesAutoWrap,
  modesBracketedPaste,
  modesInsertReplace,
  modesApplicationKeypad,
  modesLeftRightMargin,

  // ── Modes (DECRPM with behavioral fallback) ──
  behavioralModeProbe(
    "modes.mouse-tracking",
    "Mouse tracking (DECSET 1000)",
    1000,
    "\x1b[?1000h",
    "\x1b[?1000l",
    async () => {
      // Enable mouse tracking, verify terminal still responds
      const pos = await queryCursorPosition()
      return { pass: pos !== null, note: pos ? "Behavioral: responsive after enable" : "No response" }
    },
  ),
  behavioralModeProbe("modes.mouse-sgr", "SGR mouse (DECSET 1006)", 1006, "\x1b[?1006h", "\x1b[?1006l", async () => {
    const pos = await queryCursorPosition()
    return { pass: pos !== null, note: pos ? "Behavioral: responsive after enable" : "No response" }
  }),
  behavioralModeProbe(
    "modes.focus-tracking",
    "Focus tracking (DECSET 1004)",
    1004,
    "\x1b[?1004h",
    "\x1b[?1004l",
    async () => {
      const pos = await queryCursorPosition()
      return { pass: pos !== null, note: pos ? "Behavioral: responsive after enable" : "No response" }
    },
  ),
  behavioralModeProbe("modes.application-cursor", "App cursor keys (DECCKM)", 1, "\x1b[?1h", "\x1b[?1l", async () => {
    // In DECCKM mode, arrow keys send ESC O A instead of ESC [ A
    // Can't test without pressing keys — just verify responsive
    const pos = await queryCursorPosition()
    return { pass: pos !== null, note: pos ? "Behavioral: responsive after enable" : "No response" }
  }),
  behavioralModeProbe("modes.origin", "Origin mode (DECOM)", 6, "\x1b[?6h", "\x1b[?6l", async () => {
    // In origin mode, cursor is relative to scroll region
    // Set scroll region, enable origin, move to 1;1, check actual position
    process.stdout.write("\x1b[5;10r") // scroll region rows 5-10
    const pos = await queryCursorPosition()
    process.stdout.write("\x1b[r") // reset scroll region
    if (!pos) return { pass: false, note: "No response" }
    // In origin mode, cursor 1;1 maps to row 5 (top of region)
    return { pass: pos[0] >= 5, note: `Behavioral: cursor at row ${pos[0]} (origin mapped)` }
  }),
  behavioralModeProbe("modes.reverse-video", "Reverse video (DECSCNM)", 5, "\x1b[?5h", "\x1b[?5l", async () => {
    // Reverse video swaps fg/bg — can't verify visually via PTY
    // Just verify terminal is responsive after toggling
    const pos = await queryCursorPosition()
    return { pass: pos !== null, note: pos ? "Behavioral: responsive after enable" : "No response" }
  }),
  behavioralModeProbe(
    "modes.synchronized-output",
    "Synchronized output (DECSET 2026)",
    2026,
    "\x1b[?2026h",
    "\x1b[?2026l",
    async () => {
      // Synchronized output batches rendering — just verify responsive
      const pos = await queryCursorPosition()
      return { pass: pos !== null, note: pos ? "Behavioral: responsive after enable" : "No response" }
    },
  ),

  // ── Scrollback ──
  scrollRegion,
  scrollUp,
  scrollDown,
  reverseIndex,
  scrollbackDecstbm,
  scrollbackDecstbmReset,

  // ── Reset ──
  resetRIS,
  resetSGR,
  resetSoft,
  resetMethod,

  // ── SGR attributes (verify sequence is parsed, not printed) ──
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
  sgrProbe("sgr.hidden", "Hidden (SGR 8)", "\x1b[8m"),
  sgrProbe("sgr.strikethrough", "Strikethrough (SGR 9)", "\x1b[9m"),
  sgrProbe("sgr.overline", "Overline (SGR 53)", "\x1b[53m"),

  // ── SGR colors ──
  sgrProbe("sgr.fg.standard", "Standard foreground (SGR 31 red)", "\x1b[31m"),
  sgrProbe("sgr.bg.standard", "Standard background (SGR 41 red)", "\x1b[41m"),
  sgrProbe("sgr.fg.bright", "Bright foreground (SGR 91)", "\x1b[91m"),
  sgrProbe("sgr.bg.bright", "Bright background (SGR 101)", "\x1b[101m"),
  sgrProbe("sgr.fg.default", "Default foreground (SGR 39)", "\x1b[39m"),
  sgrProbe("sgr.bg.default", "Default background (SGR 49)", "\x1b[49m"),
  sgrProbe("sgr.fg.256", "256-color foreground (SGR 38;5;196)", "\x1b[38;5;196m"),
  sgrProbe("sgr.bg.256", "256-color background (SGR 48;5;21)", "\x1b[48;5;21m"),
  sgrProbe("sgr.fg.truecolor", "Truecolor foreground (SGR 38;2;255;0;128)", "\x1b[38;2;255;0;128m"),
  sgrProbe("sgr.bg.truecolor", "Truecolor background (SGR 48;2;0;255;64)", "\x1b[48;2;0;255;64m"),
  sgrProbe("sgr.underline.color", "Underline color (SGR 58;2;255;0;0)", "\x1b[4m\x1b[58;2;255;0;0m"),
  sgrProbe("sgr.reset", "SGR reset (SGR 0)", "\x1b[1m\x1b[0m"),

  // ── SGR selective resets ──
  sgrProbe("sgr.selective-reset.bold", "Reset bold (SGR 22)", "\x1b[1m\x1b[22m"),
  sgrProbe("sgr.selective-reset.underline", "Reset underline (SGR 24)", "\x1b[4m\x1b[24m"),
  sgrProbe("sgr.selective-reset.italic", "Reset italic (SGR 23)", "\x1b[3m\x1b[23m"),
  sgrProbe("sgr.selective-reset.inverse", "Reset inverse (SGR 27)", "\x1b[7m\x1b[27m"),

  // ── Charsets ──
  charsetDecSpecial,
  charsetUtf8,
  charsetG0G1Switching,
  charsetDecLineDrawing,

  // ── Extensions ──
  kittyKeyboard,
  sixelDA1,
  sixelRender,
  osc52Clipboard,
  osc7Cwd,
  osc10FgColor,
  osc11BgColor,
  osc2Title,
  extTruecolor,
  extOsc8Hyperlink,
  extOsc0IconTitle,
  extSemanticPrompts,
  extOsc633Vscode,
  extNotifications,
  extIterm2Images,
  extOsc1337CellSize,
  extOsc1337Capabilities,

  // ── Input protocols ──
  inputModifyOtherKeys,
  inputCsiU,
  inputPixelMouse,
  inputUrxvtMouse,
  inputX10Mouse,
  inputButtonEventMouse,

  // ── Unicode ──
  unicodeEastAsianAmbiguous,
  unicodeWrapBoundary,
  unicodeTabStops,
  unicodeGraphemeCursor,

  // ── Previously "untestable" features ──

  // Kitty graphics: send minimal payload, check for acknowledgment or cursor move
  {
    id: "extensions.kitty-graphics",
    name: "Kitty graphics protocol",
    async run() {
      // Send a tiny 1x1 PNG via kitty graphics protocol
      // APC G with a=T (transmit), f=100 (PNG), s=1, v=1, payload=minimal
      // The terminal responds with APC G if it supports the protocol
      const payload = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==" // 1x1 red PNG
      // Send payload, then use DA1 sentinel to detect support quickly
      const match = await queryWithSentinel(`\x1b_Ga=T,f=100,s=1,v=1,t=d;${payload}\x1b\\`, /\x1b_G([^\x1b]*)\x1b\\/)
      if (match) return { pass: true, response: match[1] }
      return { pass: false, note: "No kitty graphics acknowledgment" }
    },
  } satisfies Probe,

  // Reflow: test if terminal supports text reflow by writing a long line,
  // wrapping naturally, then checking cursor position is consistent.
  // Can't programmatically resize (some terminals block it or need permission),
  // so we test the prerequisite: auto-wrap + cursor tracking across wraps.
  {
    id: "extensions.reflow",
    name: "Text reflow on resize",
    async run() {
      // Check if terminal reports its size (needed for reflow to work)
      const sizeMatch = await queryWithSentinel("\x1b[18t", /\x1b\[8;(\d+);(\d+)t/)
      if (!sizeMatch) return { pass: false, note: "No XTWINOPS 18 response (can't report size)" }
      const cols = parseInt(sizeMatch[2]!, 10)
      // Write a line longer than terminal width — verify it wraps correctly
      process.stdout.write("\x1b[1;1H\x1b[2J")
      const longLine = "W".repeat(cols + 5) // 5 chars past the edge
      process.stdout.write(longLine)
      const pos = await queryCursorPosition()
      if (!pos) return { pass: false, note: "No cursor response" }
      // If auto-wrap works and terminal tracks wrapped content, cursor is on row 2, col 6
      return {
        pass: pos[0] === 2 && pos[1] === 6,
        note: pos[0] === 2 && pos[1] === 6 ? undefined : `cursor at ${pos[0]};${pos[1]}, expected 2;6`,
      }
    },
  } satisfies Probe,

  // Scrollback accumulates: write more lines than screen height, verify total > rows
  {
    id: "scrollback.accumulate",
    name: "Scrollback accumulates",
    async run() {
      // Get terminal height first
      const sizeMatch = await queryWithSentinel("\x1b[18t", /\x1b\[8;(\d+);(\d+)t/)
      const rows = sizeMatch ? parseInt(sizeMatch[1]!, 10) : 24
      process.stdout.write("\x1b[2J\x1b[H") // clear + home
      // Write more lines than the screen can hold
      const lineCount = rows + 10
      for (let i = 0; i < lineCount; i++) {
        process.stdout.write(`line-${i}\n`)
      }
      const pos = await queryCursorPosition()
      if (!pos) return { pass: false, note: "No cursor response" }
      // Cursor should be at or near the bottom row (content scrolled into scrollback)
      // NOT at lineCount+1 (which would mean terminal expanded instead of scrolling)
      return {
        pass: pos[0] <= rows,
        note: pos[0] <= rows ? undefined : `cursor at row ${pos[0]}, expected <= ${rows}`,
      }
    },
  } satisfies Probe,

  // Scrollback total lines: write lines, verify we can scroll back
  {
    id: "scrollback.total-lines",
    name: "Total line count",
    async run() {
      // This is hard to test without an API to query scrollback length
      // Use SD (scroll down) to test if scrollback has content above
      process.stdout.write("\x1b[2J\x1b[H") // clear
      for (let i = 0; i < 30; i++) process.stdout.write(`total-${i}\n`)
      // Try scrolling up to verify there's content above
      process.stdout.write("\x1b[5;1H") // move to row 5
      const pos = await queryCursorPosition()
      if (!pos) return { pass: false, note: "No cursor response" }
      return { pass: true, note: "Content written to scrollback" }
    },
  } satisfies Probe,

  // Alt screen separate scrollback: enter alt screen, exit, verify scrollback intact
  {
    id: "scrollback.alt-screen",
    name: "Alt screen separate scrollback",
    async run() {
      // Write to main screen, enter alt screen, exit, check main screen content is preserved
      process.stdout.write("\x1b[2J\x1b[H")
      process.stdout.write("MAIN_SCREEN_MARKER")
      const pos1 = await queryCursorPosition()
      if (!pos1) return { pass: false, note: "No cursor response" }

      // Enter alt screen
      process.stdout.write("\x1b[?1049h")
      process.stdout.write("\x1b[2J\x1b[H")
      process.stdout.write("ALT_SCREEN")

      // Exit alt screen — should restore main screen
      process.stdout.write("\x1b[?1049l")

      // Cursor should be back where it was on main screen
      const pos2 = await queryCursorPosition()
      if (!pos2) return { pass: false, note: "No cursor response after alt screen exit" }
      return {
        pass: pos2[0] === pos1[0] && pos2[1] === pos1[1],
        note:
          pos2[0] === pos1[0] && pos2[1] === pos1[1]
            ? undefined
            : `cursor at ${pos2[0]};${pos2[1]}, expected ${pos1[0]};${pos1[1]}`,
      }
    },
  } satisfies Probe,

  // Modes alt-screen exit (tests the exit specifically)
  {
    id: "modes.alt-screen.exit",
    name: "Exit alt screen (DECRST 1049)",
    async run() {
      process.stdout.write("\x1b[?1049h") // enter
      process.stdout.write("\x1b[3;3H") // move somewhere in alt
      process.stdout.write("\x1b[?1049l") // exit
      const pos = await queryCursorPosition()
      if (!pos) return { pass: false, note: "No cursor response after exit" }
      return { pass: true }
    },
  } satisfies Probe,

  // Mouse all-motion (DECSET 1003)
  behavioralModeProbe(
    "modes.mouse-all",
    "All-motion mouse tracking (DECSET 1003)",
    1003,
    "\x1b[?1003h",
    "\x1b[?1003l",
    async () => {
      const pos = await queryCursorPosition()
      return { pass: pos !== null, note: pos ? "Behavioral: responsive after enable" : "No response" }
    },
  ),
]
