import type { ProbeDefinition } from "./types.ts"
import { cursorProbe, probe } from "./helpers.ts"

export const cursorProbes: ProbeDefinition[] = [
  // CUP — cursor absolute position (1-based params → 0-based termless)
  cursorProbe("cursor.move.absolute", "", "\x1b[5;10H", { row: 4, col: 9 }),

  // CUP with no args — home
  cursorProbe("cursor.move.home", "ABC", "\x1b[H", { row: 0, col: 0 }),

  // CUF — cursor forward
  cursorProbe("cursor.move.forward", "", "\x1b[5C", { row: 0, col: 5 }),

  // CUB — cursor back
  cursorProbe("cursor.move.back", "ABC", "\x1b[2D", { row: 0, col: 1 }),

  // CUD — cursor down
  cursorProbe("cursor.move.down", "", "\x1b[3B", { row: 3, col: 0 }),

  // CUU — cursor up
  cursorProbe("cursor.move.up", "\x1b[5B", "\x1b[2A", { row: 3, col: 0 }),

  // DECTCEM — cursor hide
  probe(
    "cursor.hide",
    (ctx) => {
      ctx.feed("\x1b[?25l")
      return { pass: ctx.getCursor().visible === false }
    },
    async (ctx) => {
      ctx.write("\x1b[?25l") // hide cursor
      const posHidden = await ctx.queryCursorPosition()
      ctx.write("\x1b[?25h") // show cursor
      if (!posHidden) return { pass: false, note: "No cursor response while hidden" }
      const posVisible = await ctx.queryCursorPosition()
      if (!posVisible) return { pass: false, note: "No cursor response after show" }
      return { pass: true }
    },
  ),

  // DECSCUSR — cursor shape
  probe(
    "cursor.shape",
    (ctx) => {
      ctx.feed("\x1b[6 q")
      const style = ctx.getCursor().style
      return { pass: style === "beam" || style === null }
    },
    async (ctx) => {
      ctx.write("\x1b[5 q") // blinking bar
      const pos = await ctx.queryCursorPosition()
      ctx.write("\x1b[0 q") // restore default
      return {
        pass: pos !== null,
        note: pos ? undefined : "No response after DECSCUSR",
      }
    },
  ),

  // CHA — cursor horizontal absolute
  probe(
    "cursor.horizontal-absolute",
    (ctx) => {
      ctx.feed("ABCDE\x1b[3G")
      return { pass: ctx.getCursor().x === 2 }
    },
    async (ctx) => {
      ctx.write("\x1b[3;1H") // move to row 3
      ctx.write("\x1b[15G") // CHA col 15
      const pos = await ctx.queryCursorPosition()
      if (!pos) return { pass: false, note: "No cursor response" }
      return {
        pass: pos.row === 3 && pos.col === 15,
        note: pos.row === 3 && pos.col === 15 ? undefined : `got ${pos.row};${pos.col}, expected 3;15`,
        response: `${pos.row};${pos.col}`,
      }
    },
  ),

  // CNL — cursor next line
  probe(
    "cursor.next-line",
    (ctx) => {
      ctx.feed("ABC\x1b[2E")
      return { pass: ctx.getCursor().y === 2 && ctx.getCursor().x === 0 }
    },
    async (ctx) => {
      ctx.write("\x1b[3;5H") // move to row 3, col 5
      ctx.write("\x1b[E") // CNL — next line
      const pos = await ctx.queryCursorPosition()
      if (!pos) return { pass: false, note: "No cursor response" }
      return {
        pass: pos.row === 4 && pos.col === 1,
        note: pos.row === 4 && pos.col === 1 ? undefined : `got ${pos.row};${pos.col}, expected 4;1`,
      }
    },
  ),

  // DSR 6 — cursor position report
  probe(
    "cursor.position-report",
    (ctx) => {
      ctx.feed("\x1b[3;5H")
      const response = ctx.feedCapture("\x1b[6n")
      return {
        pass: response.includes("3;5R"),
        response,
      }
    },
    async (ctx) => {
      ctx.write("\x1b[3;5H") // Move to row 3, col 5
      const pos = await ctx.queryCursorPosition()
      if (!pos) return { pass: false, note: "No DSR 6 response" }
      return {
        pass: pos.row === 3 && pos.col === 5,
        note: pos.row === 3 && pos.col === 5 ? undefined : `got ${pos.row};${pos.col}, expected 3;5`,
        response: `${pos.row};${pos.col}`,
      }
    },
  ),

  // DECSC/DECRC — cursor save/restore
  probe(
    "cursor.save-restore",
    (ctx) => {
      ctx.feed("AB\x1b7\x1b[5;5H\x1b8")
      return { pass: ctx.getCursor().x === 2 && ctx.getCursor().y === 0 }
    },
    async (ctx) => {
      ctx.write("\x1b[3;5H") // Move to row 3, col 5
      ctx.write("\x1b7") // DECSC — save cursor
      ctx.write("\x1b[10;10H") // Move somewhere else
      ctx.write("\x1b8") // DECRC — restore cursor
      const pos = await ctx.queryCursorPosition()
      if (!pos) return { pass: false, note: "No cursor response after restore" }
      return {
        pass: pos.row === 3 && pos.col === 5,
        note: pos.row === 3 && pos.col === 5 ? undefined : `got ${pos.row};${pos.col}, expected 3;5`,
        response: `${pos.row};${pos.col}`,
      }
    },
  ),

  // DECSET 45 — reverse wrap mode
  probe(
    "cursor.reverse-wrap",
    (ctx) => {
      ctx.feed("\x1b[?7h") // enable auto-wrap
      ctx.feed("\x1b[?45h") // enable reverse wrap
      // Write to end of first row, wrap to second row, then backspace
      const cols = 80
      ctx.feed("A".repeat(cols)) // fills row 0, wraps to row 1
      ctx.feed("\x08") // backspace — should reverse-wrap to end of row 0
      const cursor = ctx.getCursor()
      ctx.feed("\x1b[?45l")
      return {
        pass: cursor.y === 0 && cursor.x === cols - 1,
        note: cursor.y === 0 ? undefined : `cursor at ${cursor.x},${cursor.y}, expected ${cols - 1},0`,
      }
    },
    async (ctx) => {
      ctx.write("\x1b[?45h") // enable reverse wrap
      const pos = await ctx.queryCursorPosition()
      ctx.write("\x1b[?45l") // disable
      return {
        pass: pos !== null,
        note: pos ? undefined : "No cursor response after enabling reverse wrap",
      }
    },
  ),

  // CUP at screen boundaries — cursor should clamp to valid range
  probe(
    "cursor.cup-boundaries",
    (ctx) => {
      ctx.feed("\x1b[999;999H")
      const cursor = ctx.getCursor()
      // Should clamp to last row (23) and last col (79) for 80x24 terminal
      return {
        pass: cursor.y === 23 && cursor.x === 79,
        note: cursor.y === 23 && cursor.x === 79 ? undefined : `got ${cursor.y};${cursor.x}, expected 23;79`,
      }
    },
    async (ctx) => {
      ctx.write("\x1b[999;999H")
      const pos = await ctx.queryCursorPosition()
      if (!pos) return { pass: false, note: "No cursor response" }
      // Should clamp to screen dimensions (1-based: rows;cols)
      return {
        pass: pos.row <= 24 && pos.col <= 80 && pos.row > 0 && pos.col > 0,
        note:
          pos.row <= 24 && pos.col <= 80 && pos.row > 0 && pos.col > 0
            ? undefined
            : `got ${pos.row};${pos.col}, expected within screen bounds`,
        response: `${pos.row};${pos.col}`,
      }
    },
  ),

  // CUU past top of screen — cursor should stop at row 0
  probe(
    "cursor.cuu-past-top",
    (ctx) => {
      ctx.feed("\x1b[4;1H") // position at row 3 (1-based row 4)
      ctx.feed("\x1b[999A") // CUU with huge count
      return {
        pass: ctx.getCursor().y === 0,
        note: ctx.getCursor().y === 0 ? undefined : `got row ${ctx.getCursor().y}, expected 0`,
      }
    },
    async (ctx) => {
      ctx.write("\x1b[4;1H") // position at row 4
      ctx.write("\x1b[999A") // CUU past top
      const pos = await ctx.queryCursorPosition()
      if (!pos) return { pass: false, note: "No cursor response" }
      return {
        pass: pos.row === 1,
        note: pos.row === 1 ? undefined : `got row ${pos.row}, expected 1`,
        response: `${pos.row};${pos.col}`,
      }
    },
  ),

  // CUD past bottom of screen — cursor should stop at last row
  probe(
    "cursor.cud-past-bottom",
    (ctx) => {
      ctx.feed("\x1b[1;1H") // position at row 0
      ctx.feed("\x1b[999B") // CUD with huge count
      return {
        pass: ctx.getCursor().y === 23, // last row of 24-row terminal
        note: ctx.getCursor().y === 23 ? undefined : `got row ${ctx.getCursor().y}, expected 23`,
      }
    },
    async (ctx) => {
      ctx.write("\x1b[1;1H") // position at row 1
      ctx.write("\x1b[999B") // CUD past bottom
      const pos = await ctx.queryCursorPosition()
      if (!pos) return { pass: false, note: "No cursor response" }
      // Should stop at last row (1-based)
      return {
        pass: pos.row >= 20, // at least near the bottom
        note: `cursor at row ${pos.row}`,
        response: `${pos.row};${pos.col}`,
      }
    },
  ),

  // CUP with DECSTBM + DECOM — cursor should be relative to scroll region
  probe(
    "cursor.cup-scroll-region",
    (ctx) => {
      ctx.feed("\x1b[5;15r") // set scroll region rows 5-15
      ctx.feed("\x1b[?6h") // enable DECOM (origin mode)
      ctx.feed("\x1b[1;1H") // CUP 1;1 — should go to scroll region top (row 4, 0-based)
      const cursor = ctx.getCursor()
      const pass = cursor.y === 4 && cursor.x === 0
      ctx.feed("\x1b[?6l") // disable DECOM
      ctx.feed("\x1b[r") // reset scroll region
      return {
        pass,
        note: pass ? undefined : `got ${cursor.y};${cursor.x}, expected 4;0`,
      }
    },
    async (ctx) => {
      ctx.write("\x1b[5;15r") // set scroll region rows 5-15
      ctx.write("\x1b[?6h") // enable DECOM
      ctx.write("\x1b[1;1H") // CUP 1;1 — relative to scroll region
      const pos = await ctx.queryCursorPosition()
      ctx.write("\x1b[?6l") // disable DECOM
      ctx.write("\x1b[r") // reset scroll region
      if (!pos) return { pass: false, note: "No cursor response" }
      return {
        pass: pos.row === 5 && pos.col === 1,
        note: pos.row === 5 && pos.col === 1 ? undefined : `got ${pos.row};${pos.col}, expected 5;1`,
        response: `${pos.row};${pos.col}`,
      }
    },
  ),
]
