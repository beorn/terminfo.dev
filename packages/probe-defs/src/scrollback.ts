import type { ProbeDefinition, ProbeResult, TermContext } from "./types.ts"
import { probe, isBlank, parserStateResult } from "./helpers.ts"

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
        const baseline = ctx.getScrollback()
        const rows = baseline.screenLines
        if (!validSize(rows, 1) || !validSize(ctx.cols, `line ${rows + 9}`.length)) {
          return {
            pass: false,
            observation: { outcome: "inconclusive", reason: "insufficient-evidence", evidence: "none" },
          }
        }
        for (let i = 0; i < rows + 10; i++) ctx.feed(`line ${i}\r\n`)
        const scroll = ctx.getScrollback()
        return parserStateResult(
          scroll.totalLines > baseline.totalLines,
          "Written lines increase measured scrollback history",
          { baseline, scroll },
        )
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
            note: "Cursor position does not measure scrollback history",
          },
        }
      },
    ),
    termNeedsGeometry: true,
  },

  {
    ...probe(
      "scrollback.total-lines",
      (ctx) => {
        const baseline = ctx.getScrollback()
        const rows = baseline.screenLines
        if (!validSize(rows, 1) || !validSize(ctx.cols, `line ${rows + 9}`.length)) {
          return {
            pass: false,
            observation: { outcome: "inconclusive", reason: "insufficient-evidence", evidence: "none" },
          }
        }
        const lineCount = rows + 10
        for (let i = 0; i < lineCount; i++) ctx.feed(`line ${i}\r\n`)
        const scroll = ctx.getScrollback()
        return parserStateResult(
          scroll.totalLines > baseline.totalLines,
          "Measured total lines increase after writing beyond the screen",
          { baseline, lineCount, scroll },
        )
      },
      async (ctx) => {
        const refusal = tooSmall(ctx, 5, `total-${ctx.rows + 9}`.length)
        if (refusal) return refusal
        ctx.write("\x1b[2J\x1b[H") // clear
        for (let i = 0; i < ctx.rows + 10; i++) ctx.write(`total-${i}\n`)
        ctx.write("\x1b[5;1H") // move to row 5
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
            note: "Cursor position does not measure total scrollback lines",
          },
        }
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
        const before = ctx.getCell(0, 0)
        for (let i = 0; i < rows - 1; i++) ctx.feed("line\r\n")
        const atCommand = ctx.getCell(0, 0)
        if (before.char !== "T" || atCommand.char !== "T") {
          return parserStateResult(
            null,
            "SU moves the measured TOP marker away from row zero",
            { before, atCommand },
            "TOP marker was not present immediately before SU",
          )
        }
        ctx.feed("\x1b[S")
        const after = ctx.getCell(0, 0)
        return parserStateResult(after.char !== "T", "SU moves the measured TOP marker away from row zero", {
          before,
          atCommand,
          after,
        })
      },
      async (ctx) => {
        const refusal = tooSmall(ctx, 5, 5)
        if (refusal) return refusal
        ctx.write("\x1b[5;5H") // Move to row 5, col 5
        ctx.write("\x1b[1S") // SU 1
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
            note: "Cursor position does not measure scroll-up contents",
          },
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
        const before = ctx.getCell(0, 0)
        ctx.feed("\x1b[H\x1bM")
        const after = ctx.getCell(0, 0)
        return parserStateResult(
          before.char === "A" ? isBlank(after.char) : null,
          "RI inserts a blank row above the measured A marker",
          { before, after },
          before.char === "A" ? undefined : "A marker was not measured before reverse index",
        )
      },
      async (ctx) => {
        const refusal = tooSmall(ctx, 1, 5)
        if (refusal) return refusal
        ctx.write("\x1b[1;5H") // row 1, col 5
        ctx.write("\x1bM") // RI — reverse index
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
            note: "Cursor position does not measure reverse-index contents",
          },
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
        const before = ctx.getCell(0, 0)
        ctx.feed("\x1b[T")
        const after = ctx.getCell(0, 0)
        return parserStateResult(
          before.char === "L" ? isBlank(after.char) : null,
          "SD inserts a blank row above the measured LINE marker",
          { before, after },
          before.char === "L" ? undefined : "LINE marker was not measured before scroll down",
        )
      },
      async (ctx) => {
        const refusal = tooSmall(ctx, 5, 5)
        if (refusal) return refusal
        ctx.write("\x1b[5;5H") // Move to row 5, col 5
        ctx.write("\x1b[1T") // SD 1
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
            note: "Cursor position does not measure scroll-down contents",
          },
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
        return parserStateResult(
          null,
          "DECSTBM constrains scrolling to the requested region",
          { cursor },
          "Cursor position alone does not measure the scrolling region",
        )
      },
      async (ctx) => {
        const refusal = tooSmall(ctx, 10, 1)
        if (refusal) return refusal
        try {
          ctx.write("\x1b[5;10r") // Set scroll region rows 5-10
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
              note: "Cursor position does not measure the scrolling region",
            },
          }
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
        return parserStateResult(
          null,
          "Alt screen preserves normal scrollback",
          { mode: ctx.getMode("altScreen") },
          "Mode metadata does not measure preserved scrollback",
        )
      },
      async (ctx) => {
        const refusal = tooSmall(ctx, 1, 19)
        if (refusal) return refusal
        ctx.write("\x1b[2J\x1b[H")
        ctx.write("MAIN_SCREEN_MARKER")
        const pos1 = await ctx.queryCursorPosition()
        if (!pos1) {
          return { pass: false, observation: { outcome: "inconclusive", reason: "no-response", evidence: "query" } }
        }
        // Enter alt screen
        try {
          ctx.write("\x1b[?1049h")
          ctx.write("\x1b[2J\x1b[H")
          ctx.write("ALT_SCREEN")
        } finally {
          ctx.write("\x1b[?1049l")
        }
        const pos2 = await ctx.queryCursorPosition()
        if (!pos2) {
          return { pass: false, observation: { outcome: "inconclusive", reason: "no-response", evidence: "query" } }
        }
        return {
          pass: false,
          response: JSON.stringify({ pos1, pos2 }),
          observation: {
            outcome: "inconclusive",
            reason: "insufficient-evidence",
            evidence: "query",
            note: "Cursor positions do not measure retained main-screen contents",
          },
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
        const rows = ctx.getScrollback().screenLines
        if (!validSize(rows, 10) || !validSize(ctx.cols, 9)) {
          return {
            pass: false,
            observation: { outcome: "inconclusive", reason: "insufficient-evidence", evidence: "none" },
          }
        }
        ctx.feed("FIXED_TOP\r\n")
        const before = ctx.getCell(0, 0)
        ctx.feed("\x1b[3;10r")
        try {
          ctx.feed("\x1b[3;1HINNER")
          const innerBefore = ctx.getCell(2, 0)
          ctx.feed("\x1b[10;1HZ\r\n") // only an active region scrolls row 3 at row 10
          const innerAfter = ctx.getCell(2, 0)
          const topAfter = ctx.getCell(0, 0)
          const state = { before, innerBefore, innerAfter, topAfter }
          const expected = "DECSTBM scrolls the inner marker while preserving FIXED_TOP outside the region"
          if (before.char !== "F" || innerBefore.char !== "I" || innerAfter.char === "I") {
            return parserStateResult(null, expected, state, "Top marker or inner scrolling control was not established")
          }
          return parserStateResult(topAfter.char === "F", expected, state)
        } finally {
          ctx.feed("\x1b[r") // reset
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
              note: "Cursor position does not measure whether FIXED_TOP survived scrolling",
            },
          }
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
        const baseline = ctx.getScrollback()
        const rows = baseline.screenLines
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
        return parserStateResult(
          null,
          "Reset DECSTBM permits full-screen scrolling into history",
          { baseline, scroll },
          "Scrollback growth does not prove the earlier region was active before reset",
        )
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
          if (!pos) {
            return { pass: false, observation: { outcome: "inconclusive", reason: "no-response", evidence: "query" } }
          }
          return {
            pass: false,
            response: `${pos.row};${pos.col}`,
            observation: {
              outcome: "inconclusive",
              reason: "insufficient-evidence",
              evidence: "query",
              note: "CUD and cursor position do not measure scrollback after DECSTBM reset",
            },
          }
        } finally {
          ctx.write("\x1b[r") // restore full-screen region even after an interrupted reset
        }
      },
    ),
    termNeedsGeometry: true,
  },
]
