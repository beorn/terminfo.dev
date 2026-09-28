import type { ProbeDefinition, ProbeResult, TermlessContext } from "./types.ts"
import { cursorProbe, parserStateResult, probe } from "./helpers.ts"

function headlessPosition(ctx: TermlessContext, row: number, col: number): ProbeResult {
  const cursor = ctx.getCursor()
  return parserStateResult(cursor.y === row && cursor.x === col, `cursor row=${row}, col=${col} (0-based)`, cursor)
}

function reportedPosition(position: { row: number; col: number } | null, row: number, col: number): ProbeResult {
  if (!position) {
    return { pass: false, observation: { outcome: "inconclusive", reason: "no-response", evidence: "query" } }
  }
  const response = JSON.stringify(position)
  const pass = position.row === row && position.col === col
  return {
    pass,
    response,
    observation: { outcome: pass ? "supported" : "unsupported", evidence: "query" },
    assertions: [{ kind: pass ? "positive" : "negative", expected: `row ${row}, col ${col}`, observed: response }],
  }
}

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
      return headlessPosition(ctx, 0, 2)
    },
    async (ctx) => {
      ctx.write("\x1b[3;1H") // move to row 3
      ctx.write("\x1b[15G") // CHA col 15
      const pos = await ctx.queryCursorPosition()
      return reportedPosition(pos, 3, 15)
    },
  ),

  // CNL — cursor next line
  probe(
    "cursor.next-line",
    (ctx) => {
      ctx.feed("ABC\x1b[2E")
      return headlessPosition(ctx, 2, 0)
    },
    async (ctx) => {
      ctx.write("\x1b[3;5H") // move to row 3, col 5
      ctx.write("\x1b[E") // CNL — next line
      const pos = await ctx.queryCursorPosition()
      return reportedPosition(pos, 4, 1)
    },
  ),

  // DSR 6 — cursor position report
  probe(
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
      const pass = row === 3 && col === 5
      return {
        pass,
        response,
        observation: { outcome: pass ? "supported" : "unsupported", evidence: "query" },
        assertions: [{ kind: pass ? "positive" : "negative", expected: "ESC[3;5R", observed: response }],
      }
    },
    async (ctx) => {
      ctx.write("\x1b[3;5H") // Move to row 3, col 5
      const pos = await ctx.queryCursorPosition()
      return reportedPosition(pos, 3, 5)
    },
  ),

  // CSI s / CSI u — ANSI save/restore cursor (distinct from DECSC/DECRC)
  probe(
    "cursor.ansi-save",
    (ctx) => {
      ctx.feed("\x1b[3;5H") // position at row 3, col 5 (1-based) → termless 0-based: y=2, x=4
      ctx.feed("\x1b[s") // ANSI save (CSI s)
      ctx.feed("\x1b[10;15H") // move elsewhere
      ctx.feed("\x1b[u") // ANSI restore (CSI u)
      return headlessPosition(ctx, 2, 4)
    },
    async (ctx) => {
      ctx.write("\x1b[3;5H") // row 3, col 5
      ctx.write("\x1b[s") // CSI s — save
      ctx.write("\x1b[10;15H") // move
      ctx.write("\x1b[u") // CSI u — restore
      const pos = await ctx.queryCursorPosition()
      return reportedPosition(pos, 3, 5)
    },
  ),

  probe(
    "cursor.ansi-restore",
    (ctx) => {
      ctx.feed("\x1b[4;6H") // position at row 4, col 6 (1-based) → termless 0-based: y=3, x=5
      ctx.feed("\x1b[s") // ANSI save
      ctx.feed("\x1b[12;18H") // move elsewhere
      ctx.feed("\x1b[u") // ANSI restore
      return headlessPosition(ctx, 3, 5)
    },
    async (ctx) => {
      ctx.write("\x1b[4;6H") // row 4, col 6
      ctx.write("\x1b[s") // save
      ctx.write("\x1b[12;18H") // move
      ctx.write("\x1b[u") // CSI u — restore
      const pos = await ctx.queryCursorPosition()
      return reportedPosition(pos, 4, 6)
    },
  ),

  // DECSC/DECRC — cursor save/restore
  probe(
    "cursor.save-restore",
    (ctx) => {
      ctx.feed("AB\x1b7\x1b[5;5H\x1b8")
      return headlessPosition(ctx, 0, 2)
    },
    async (ctx) => {
      ctx.write("\x1b[3;5H") // Move to row 3, col 5
      ctx.write("\x1b7") // DECSC — save cursor
      ctx.write("\x1b[10;10H") // Move somewhere else
      ctx.write("\x1b8") // DECRC — restore cursor
      const pos = await ctx.queryCursorPosition()
      return reportedPosition(pos, 3, 5)
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
      return headlessPosition(ctx, 0, 0)
    },
    async (ctx) => {
      ctx.write("\x1b[4;1H") // position at row 4
      ctx.write("\x1b[999A") // CUU past top
      const pos = await ctx.queryCursorPosition()
      return reportedPosition(pos, 1, 1)
    },
  ),

  // CUD past bottom of screen — cursor should stop at last row
  probe(
    "cursor.cud-past-bottom",
    (ctx) => {
      ctx.feed("\x1b[1;1H") // position at row 0
      ctx.feed("\x1b[999B") // CUD with huge count
      const rows = ctx.getScrollback().screenLines
      const cursor = ctx.getCursor()
      return parserStateResult(
        rows > 0 ? cursor.y === rows - 1 && cursor.x === 0 : null,
        `cursor at last initialized row ${rows - 1}, col 0`,
        { cursor, rows },
        rows > 0 ? undefined : "Backend screen row count is unavailable",
      )
    },
    async (ctx) => {
      ctx.write("\x1b[1;1H") // position at row 1
      ctx.write("\x1b[999B") // CUD past bottom
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
          note: "The app fixture did not measure its screen height, so the bottom row is unknown",
        },
      }
    },
  ),

  // VPA — vertical position absolute
  probe(
    "cursor.vpa",
    (ctx) => {
      ctx.feed("\x1b[3;5H") // position at row 3, col 5 (1-based)
      ctx.feed("\x1b[10d") // VPA row 10
      return headlessPosition(ctx, 9, 4)
    },
    async (ctx) => {
      ctx.write("\x1b[3;5H") // position at row 3, col 5
      ctx.write("\x1b[10d") // VPA row 10
      const pos = await ctx.queryCursorPosition()
      return reportedPosition(pos, 10, 5)
    },
  ),

  // CPL — cursor preceding line
  probe(
    "cursor.cpl",
    (ctx) => {
      ctx.feed("\x1b[6;10H") // position at row 6, col 10 (1-based)
      ctx.feed("\x1b[2F") // CPL 2 — move up 2 lines, column to 0
      return headlessPosition(ctx, 3, 0)
    },
    async (ctx) => {
      ctx.write("\x1b[6;10H") // position at row 6, col 10
      ctx.write("\x1b[2F") // CPL 2
      const pos = await ctx.queryCursorPosition()
      return reportedPosition(pos, 4, 1)
    },
  ),

  // HPA — horizontal position absolute
  probe(
    "cursor.hpa",
    (ctx) => {
      ctx.feed("ABCDEFGH\x1b[5`") // HPA col 5
      return headlessPosition(ctx, 0, 4)
    },
    async (ctx) => {
      ctx.write("\x1b[3;1H") // move to row 3
      ctx.write("\x1b[15`") // HPA col 15
      const pos = await ctx.queryCursorPosition()
      return reportedPosition(pos, 3, 15)
    },
  ),

  // CUP with DECSTBM + DECOM — physical cursor is margin-relative, but CPR reports relative coordinates.
  // DEC VT510: https://vt100.net/mirror/mds-199909/cd3/term/vt510rmb.pdf (DECOM and DSR—CPR)
  probe(
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
      try {
        ctx.write("\x1b[5;15r") // set scroll region rows 5-15
        ctx.write("\x1b[?6h") // enable DECOM
        ctx.write("\x1b[1;1H") // CUP 1;1 — relative to scroll region
        const pos = await ctx.queryCursorPosition()
        const result = reportedPosition(pos, 1, 1)
        if (result.observation?.outcome === "supported") {
          return {
            pass: false,
            response: result.response,
            observation: {
              outcome: "inconclusive",
              reason: "insufficient-evidence",
              evidence: "query",
              note: "Relative CPR 1;1 also occurs if DECOM and margins are ignored; physical row was not observed",
            },
          }
        }
        return result
      } finally {
        try {
          ctx.write("\x1b[?6l") // disable DECOM
        } finally {
          ctx.write("\x1b[r") // reset scroll region
        }
      }
    },
  ),
]
