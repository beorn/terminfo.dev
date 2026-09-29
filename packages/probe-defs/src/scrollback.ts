import type { ProbeDefinition, ProbeResult, TermContext } from "./types.ts"
import { probe, isBlank } from "./helpers.ts"

function tooSmall(ctx: TermContext, rows: number, cols: number): ProbeResult | undefined {
  if (validSize(ctx.rows, rows) && validSize(ctx.cols, cols)) return undefined
  return {
    pass: false,
    observation: {
      outcome: "inconclusive",
      reason: "insufficient-evidence",
      evidence: "none",
      note: `Scrollback fixture needs at least ${rows}x${cols}; measured ${ctx.rows}x${ctx.cols}`,
    },
  }
}

function validSize(value: number, minimum: number): boolean {
  return Number.isSafeInteger(value) && value >= minimum
}

export const scrollbackProbes: ProbeDefinition[] = [
  {
    ...probe(
      "scrollback.accumulate",
      (ctx) => {
        const rows = ctx.getScrollback().screenLines
        if (!validSize(rows, 1) || !validSize(ctx.cols, `line ${rows + 9}`.length)) {
          return {
            pass: false,
            observation: { outcome: "inconclusive", reason: "insufficient-evidence", evidence: "none" },
          }
        }
        for (let i = 0; i < rows + 10; i++) ctx.feed(`line ${i}\r\n`)
        const scroll = ctx.getScrollback()
        return { pass: scroll.totalLines > scroll.screenLines }
      },
      async (ctx) => {
        const refusal = tooSmall(ctx, 1, `line-${ctx.rows + 9}`.length)
        if (refusal) return refusal
        const rows = ctx.rows
        ctx.write("\x1b[2J\x1b[H") // clear + home
        const lineCount = rows + 10
        for (let i = 0; i < lineCount; i++) {
          ctx.write(`line-${i}\n`)
        }
        const pos = await ctx.queryCursorPosition()
        if (!pos) return { pass: false, note: "No cursor response" }
        return {
          pass: pos.row <= rows,
          note: pos.row <= rows ? undefined : `cursor at row ${pos.row}, expected <= ${rows}`,
        }
      },
    ),
    termNeedsGeometry: true,
  },

  {
    ...probe(
      "scrollback.total-lines",
      (ctx) => {
        const rows = ctx.getScrollback().screenLines
        if (!validSize(rows, 1) || !validSize(ctx.cols, `line ${rows + 9}`.length)) {
          return {
            pass: false,
            observation: { outcome: "inconclusive", reason: "insufficient-evidence", evidence: "none" },
          }
        }
        const lineCount = rows + 10
        for (let i = 0; i < lineCount; i++) ctx.feed(`line ${i}\r\n`)
        return { pass: ctx.getScrollback().totalLines >= lineCount }
      },
      async (ctx) => {
        const refusal = tooSmall(ctx, 5, `total-${ctx.rows + 9}`.length)
        if (refusal) return refusal
        ctx.write("\x1b[2J\x1b[H") // clear
        for (let i = 0; i < ctx.rows + 10; i++) ctx.write(`total-${i}\n`)
        ctx.write("\x1b[5;1H") // move to row 5
        const pos = await ctx.queryCursorPosition()
        if (!pos) return { pass: false, note: "No cursor response" }
        return { pass: true, note: "Content written to scrollback" }
      },
    ),
    termNeedsGeometry: true,
  },

  {
    ...probe(
      "scrollback.scroll-up",
      (ctx) => {
        const rows = ctx.getScrollback().screenLines
        if (!validSize(rows, 1) || !validSize(ctx.cols, 4)) {
          return {
            pass: false,
            observation: { outcome: "inconclusive", reason: "insufficient-evidence", evidence: "none" },
          }
        }
        ctx.feed("TOP\r\n")
        for (let i = 0; i < rows - 1; i++) ctx.feed("line\r\n")
        ctx.feed("\x1b[S")
        return { pass: ctx.getCell(0, 0).char !== "T" }
      },
      async (ctx) => {
        const refusal = tooSmall(ctx, 5, 5)
        if (refusal) return refusal
        ctx.write("\x1b[5;5H") // Move to row 5, col 5
        ctx.write("\x1b[1S") // SU 1
        const pos = await ctx.queryCursorPosition()
        if (!pos) return { pass: false, note: "No cursor response after SU" }
        return {
          pass: pos.row === 5 && pos.col === 5,
          note: pos.row === 5 && pos.col === 5 ? undefined : `cursor at ${pos.row};${pos.col}, expected 5;5`,
        }
      },
    ),
    termNeedsGeometry: true,
  },

  {
    ...probe(
      "scrollback.reverse-index",
      (ctx) => {
        ctx.feed("A\r\nB\r\nC")
        ctx.feed("\x1b[H\x1bM")
        return { pass: isBlank(ctx.getCell(0, 0).char) }
      },
      async (ctx) => {
        const refusal = tooSmall(ctx, 1, 5)
        if (refusal) return refusal
        ctx.write("\x1b[1;5H") // row 1, col 5
        ctx.write("\x1bM") // RI — reverse index
        const pos = await ctx.queryCursorPosition()
        if (!pos) return { pass: false, note: "No cursor response after RI" }
        return {
          pass: pos.row === 1 && pos.col === 5,
          note: pos.row === 1 && pos.col === 5 ? undefined : `got ${pos.row};${pos.col}, expected 1;5`,
        }
      },
    ),
    termNeedsGeometry: true,
  },

  {
    ...probe(
      "scrollback.scroll-down",
      (ctx) => {
        ctx.feed("LINE1\r\nLINE2\r\nLINE3")
        ctx.feed("\x1b[T")
        return { pass: isBlank(ctx.getCell(0, 0).char) }
      },
      async (ctx) => {
        const refusal = tooSmall(ctx, 5, 5)
        if (refusal) return refusal
        ctx.write("\x1b[5;5H") // Move to row 5, col 5
        ctx.write("\x1b[1T") // SD 1
        const pos = await ctx.queryCursorPosition()
        if (!pos) return { pass: false, note: "No cursor response after SD" }
        return {
          pass: pos.row === 5 && pos.col === 5,
          note: pos.row === 5 && pos.col === 5 ? undefined : `cursor at ${pos.row};${pos.col}, expected 5;5`,
        }
      },
    ),
    termNeedsGeometry: true,
  },

  {
    ...probe(
      "scrollback.set-region",
      (ctx) => {
        ctx.feed("\x1b[5;10r")
        const cursor = ctx.getCursor()
        ctx.feed("\x1b[r") // reset
        return { pass: cursor.x === 0 && cursor.y === 0 }
      },
      async (ctx) => {
        const refusal = tooSmall(ctx, 10, 1)
        if (refusal) return refusal
        try {
          ctx.write("\x1b[5;10r") // Set scroll region rows 5-10
          const pos = await ctx.queryCursorPosition()
          if (!pos) return { pass: false, note: "No cursor response after DECSTBM" }
          return { pass: true }
        } finally {
          ctx.write("\x1b[r") // Reset scroll region
        }
      },
    ),
    termNeedsGeometry: true,
  },

  {
    ...probe(
      "scrollback.alt-screen",
      (ctx) => {
        ctx.feed("NORMAL")
        ctx.feed("\x1b[?1049h")
        return { pass: ctx.getMode("altScreen") === true }
      },
      async (ctx) => {
        const refusal = tooSmall(ctx, 1, 19)
        if (refusal) return refusal
        ctx.write("\x1b[2J\x1b[H")
        ctx.write("MAIN_SCREEN_MARKER")
        const pos1 = await ctx.queryCursorPosition()
        if (!pos1) return { pass: false, note: "No cursor response" }
        // Enter alt screen
        try {
          ctx.write("\x1b[?1049h")
          ctx.write("\x1b[2J\x1b[H")
          ctx.write("ALT_SCREEN")
        } finally {
          ctx.write("\x1b[?1049l")
        }
        const pos2 = await ctx.queryCursorPosition()
        if (!pos2) return { pass: false, note: "No cursor response after alt screen exit" }
        return {
          pass: pos2.row === pos1.row && pos2.col === pos1.col,
          note:
            pos2.row === pos1.row && pos2.col === pos1.col
              ? undefined
              : `cursor at ${pos2.row};${pos2.col}, expected ${pos1.row};${pos1.col}`,
        }
      },
    ),
    termNeedsGeometry: true,
  },

  // DECSTBM constrains scrolling — text above the region should not scroll
  {
    ...probe(
      "scrollback.decstbm",
      (ctx) => {
        // Write marker on row 0
        ctx.feed("FIXED_TOP\r\n")
        // Set scroll region to rows 3-10 (1-based)
        ctx.feed("\x1b[3;10r")
        // Move inside scroll region and write enough to scroll
        ctx.feed("\x1b[3;1H")
        for (let i = 0; i < 20; i++) ctx.feed(`scroll-${i}\r\n`)
        // Row 0 should still have FIXED_TOP (not scrolled away)
        const cell = ctx.getCell(0, 0)
        const pass = cell.char === "F"
        ctx.feed("\x1b[r") // reset
        return {
          pass,
          note: pass ? undefined : `row 0 char='${cell.char}', expected 'F'`,
        }
      },
      async (ctx) => {
        const refusal = tooSmall(ctx, 10, 10)
        if (refusal) return refusal
        ctx.write("\x1b[2J\x1b[H") // clear
        ctx.write("FIXED_TOP\r\n")
        try {
          ctx.write("\x1b[3;10r") // scroll region rows 3-10
          ctx.write("\x1b[3;1H") // move into region
          for (let i = 0; i < 20; i++) ctx.write(`scroll-${i}\r\n`)
          const pos = await ctx.queryCursorPosition()
          if (!pos) return { pass: false, note: "No cursor response" }
          return { pass: true }
        } finally {
          ctx.write("\x1b[r") // reset
        }
      },
    ),
    termNeedsGeometry: true,
  },

  // DECSTBM reset — ESC [ r with no params resets to full screen
  {
    ...probe(
      "scrollback.decstbm-reset",
      (ctx) => {
        const rows = ctx.getScrollback().screenLines
        if (!validSize(rows, 10) || !validSize(ctx.cols, `line-${rows + 9}`.length)) {
          return {
            pass: false,
            observation: { outcome: "inconclusive", reason: "insufficient-evidence", evidence: "none" },
          }
        }
        // Set a scroll region
        ctx.feed("\x1b[5;10r")
        // Reset it
        ctx.feed("\x1b[r")
        // Write enough lines to fill the screen + overflow
        ctx.feed("\x1b[H")
        for (let i = 0; i < rows + 10; i++) ctx.feed(`line-${i}\r\n`)
        // If region was properly reset, scrollback should accumulate
        const scroll = ctx.getScrollback()
        return {
          pass: scroll.totalLines > rows,
          note:
            scroll.totalLines > rows
              ? undefined
              : `totalLines=${scroll.totalLines}, expected >${rows} (full-screen scrolling)`,
        }
      },
      async (ctx) => {
        if (!validSize(ctx.rows, 10) || !validSize(ctx.cols, 1)) {
          return {
            pass: false,
            observation: {
              outcome: "inconclusive",
              reason: "insufficient-evidence",
              evidence: "none",
              note: "DECSTBM fixture needs at least 10 rows",
            },
          }
        }
        try {
          ctx.write("\x1b[5;10r") // set region
          ctx.write("\x1b[r") // reset to full screen
          ctx.write("\x1b[H")
          // Verify cursor can reach the bottom of the screen
          ctx.write(`\x1b[${ctx.rows}B`) // CUD past the measured bottom
          const pos = await ctx.queryCursorPosition()
          if (!pos) return { pass: false, note: "No cursor response" }
          return {
            pass: pos.row === ctx.rows, // CUD past bottom reaches the measured final row
            note: `cursor at row ${pos.row} (expected near bottom after DECSTBM reset)`,
            response: `${pos.row};${pos.col}`,
          }
        } finally {
          ctx.write("\x1b[r") // restore full-screen region even after an interrupted reset
        }
      },
    ),
    termNeedsGeometry: true,
  },
]
