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
      ctx.feed("\x1b[?45h")
      return { pass: true }
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
]
