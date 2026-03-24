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
  "modes.alt-screen",
  "Alternate screen buffer (DECSET 1049)",
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
      note: pos[1] === 2 ? undefined : `cursor at col ${pos[1]}, expected 2 (truecolor sequence may have been printed literally)`,
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

  // ── Device ──
  primaryDA,
  deviceStatusReport,
  deviceDecrpm,

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
  tabStop,
  backspace,

  // ── Erase ──
  eraseLineRight,
  eraseLineLeft,
  eraseLineAll,
  eraseScreenAll,
  eraseScreenBelow,
  eraseScreenAbove,
  eraseScreenScrollback,
  eraseCharacter,

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

  // ── Modes (DECRPM only) ──
  modeProbe("modes.mouse-tracking", "Mouse tracking (DECSET 1000)", 1000),
  modeProbe("modes.mouse-sgr", "SGR mouse (DECSET 1006)", 1006),
  modeProbe("modes.focus-tracking", "Focus tracking (DECSET 1004)", 1004),
  modeProbe("modes.application-cursor", "App cursor keys (DECCKM)", 1),
  modeProbe("modes.origin", "Origin mode (DECOM)", 6),
  modeProbe("modes.reverse-video", "Reverse video (DECSCNM)", 5),
  modeProbe("modes.synchronized-output", "Synchronized output (DECSET 2026)", 2026),

  // ── Scrollback ──
  scrollRegion,
  scrollUp,
  scrollDown,
  reverseIndex,

  // ── Reset ──
  resetRIS,
  resetSGR,
  resetSoft,

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
  sgrProbe("sgr.selective-reset.inverse", "Reset inverse (SGR 27)", "\x1b[7m\x1b[27m"),

  // ── Charsets ──
  charsetDecSpecial,
  charsetUtf8,

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
]
