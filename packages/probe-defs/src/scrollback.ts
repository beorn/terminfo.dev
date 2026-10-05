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
        const capture = ctx.capture
        if (capture) {
          const refusal = tooSmall(ctx, 1, `line-${ctx.rows + 9}`.length)
          if (refusal) return refusal
          try {
            ctx.write("\x1b[0m\x1b[2J\x1b[H")
            ctx.write("TOP\r\nline-0\r\nline-1")
            const control = await capture({
              role: "control",
              label: "Before overflow: TOP marker on row 1 with two written lines",
            })
            ctx.write("\x1b[H")
            const lineCount = ctx.rows + 10
            for (let i = 0; i < lineCount; i++) ctx.write(`line-${i}\r\n`)
            const target = await capture({
              role: "target",
              label: `After writing ${lineCount} lines: TOP has scrolled off the top and row 1 shows an advanced line-N`,
            })
            return {
              pass: false,
              response: JSON.stringify({
                rows: ctx.rows,
                cols: ctx.cols,
                lineCount,
                control: control.label,
                target: target.label,
              }),
              observation: {
                outcome: "inconclusive",
                reason: "insufficient-evidence",
                evidence: "pixels",
                screenshotRef: target.ref,
                frames: [control, target],
                note: "Advanced top-of-screen line numbering relative to the TOP control shows written lines entered scrollback; the exact history count is not readable from the screen and requires independent pixel review",
              },
            }
          } finally {
            ctx.write("\x1b[0m\x1b[2J\x1b[H")
          }
        }
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
        const capture = ctx.capture
        if (capture) {
          const refusal = tooSmall(ctx, 5, `total-${ctx.rows + 9}`.length)
          if (refusal) return refusal
          try {
            ctx.write("\x1b[0m\x1b[2J\x1b[H")
            ctx.write("TOP")
            const control = await capture({
              role: "control",
              label: "Before overflow: TOP marker on row 1 with no history written",
            })
            ctx.write("\x1b[H")
            const lineCount = ctx.rows + 10
            for (let i = 0; i < lineCount; i++) ctx.write(`total-${i}\n`)
            const target = await capture({
              role: "target",
              label: `After writing ${lineCount} lines: TOP has scrolled off, showing total lines exceeded one screen`,
            })
            return {
              pass: false,
              response: JSON.stringify({
                rows: ctx.rows,
                cols: ctx.cols,
                lineCount,
                control: control.label,
                target: target.label,
              }),
              observation: {
                outcome: "inconclusive",
                reason: "insufficient-evidence",
                evidence: "pixels",
                screenshotRef: target.ref,
                frames: [control, target],
                note: "The TOP control leaving the top of the screen after more lines than a screen can hold shows total lines grew beyond the viewport; the exact retained count is not readable from the screen and requires independent pixel review",
              },
            }
          } finally {
            ctx.write("\x1b[0m\x1b[2J\x1b[H")
          }
        }
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
        const initial = ctx.getScrollback()
        const rows = initial.screenLines
        if (!validSize(rows, 5) || !validSize(ctx.cols, 3) || initial.totalLines !== rows) {
          return {
            pass: false,
            observation: { outcome: "inconclusive", reason: "insufficient-evidence", evidence: "none" },
          }
        }
        const expected = "Interior-region SU shifts the measured middle and bottom rows up, clearing the region bottom"
        ctx.feed("\x1b[2J")
        for (const [row, marker] of ["A", "B", "C", "D", "E"].entries()) {
          ctx.feed(`\x1b[${row + 1};1H${marker}`)
        }
        try {
          ctx.feed("\x1b[2;4r")
          const seed = Array.from({ length: 5 }, (_, row) => ctx.getCell(row, 0).char)
          const beforeScroll = ctx.getScrollback()
          if (seed.join("") !== "ABCDE" || beforeScroll.totalLines !== rows) {
            return parserStateResult(
              null,
              expected,
              { seed, beforeScroll },
              "Interior-region SU seed or history was not established",
            )
          }
          ctx.feed("\x1b[S")
          const after = Array.from({ length: 5 }, (_, row) => ctx.getCell(row, 0).char)
          const afterScroll = ctx.getScrollback()
          const controlsValid = after[0] === "A" && after[4] === "E" && afterScroll.totalLines === rows
          const shifted = after[1] === "C" && after[2] === "D" && isBlank(after[3] ?? "\0")
          const unchanged = after.join("") === "ABCDE"
          return parserStateResult(
            controlsValid ? (shifted ? true : unchanged ? false : null) : null,
            expected,
            { seed, beforeScroll, after, afterScroll },
            controlsValid && (shifted || unchanged)
              ? undefined
              : "Interior-region SU controls or output were not measured",
          )
        } finally {
          ctx.feed("\x1b[r")
        }
      },
      async (ctx) => {
        const capture = ctx.capture
        if (capture) {
          const refusal = tooSmall(ctx, 5, 3)
          if (refusal) return refusal
          try {
            ctx.write("\x1b[0m\x1b[2J\x1b[H")
            for (const [row, marker] of ["A", "B", "C", "D", "E"].entries()) {
              ctx.write(`\x1b[${row + 1};1H${marker}`)
            }
            ctx.write("\x1b[2;4r") // scroll region rows 2-4
            ctx.write("\x1b[5;2H")
            const control = await capture({
              role: "control",
              label: "Seed markers A-E on rows 1-5 with scroll region rows 2-4 set",
            })
            ctx.write("\x1b[S") // SU 1 inside the region
            ctx.write("\x1b[5;2H")
            const target = await capture({
              role: "target",
              label: "After SU in region rows 2-4: A and E stay, B-D shift up, and the region bottom row is cleared",
            })
            return {
              pass: false,
              response: JSON.stringify({
                rows: ctx.rows,
                cols: ctx.cols,
                control: control.label,
                target: target.label,
              }),
              observation: {
                outcome: "inconclusive",
                reason: "insufficient-evidence",
                evidence: "pixels",
                screenshotRef: target.ref,
                frames: [control, target],
                note: "Interior-region SU shifting B-D up while A and E stay put requires independent pixel review; the region boundary is not readable from a query",
              },
            }
          } finally {
            ctx.write("\x1b[r\x1b[0m\x1b[2J\x1b[H")
          }
        }
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
        const capture = ctx.capture
        if (capture) {
          const refusal = tooSmall(ctx, 3, 3)
          if (refusal) return refusal
          try {
            ctx.write("\x1b[0m\x1b[2J\x1b[H")
            ctx.write("A\r\nB\r\nC")
            const control = await capture({
              role: "control",
              label: "Before reverse index: A on row 1 with B on row 2 and C on row 3",
            })
            ctx.write("\x1b[H\x1bM") // home then RI
            const target = await capture({
              role: "target",
              label: "After RI at row 1: a blank row is inserted above, pushing A to row 2",
            })
            return {
              pass: false,
              response: JSON.stringify({
                rows: ctx.rows,
                cols: ctx.cols,
                control: control.label,
                target: target.label,
              }),
              observation: {
                outcome: "inconclusive",
                reason: "insufficient-evidence",
                evidence: "pixels",
                screenshotRef: target.ref,
                frames: [control, target],
                note: "A blank row inserted above the A marker after RI requires independent pixel review; cursor position alone does not measure the inserted row",
              },
            }
          } finally {
            ctx.write("\x1b[0m\x1b[2J\x1b[H")
          }
        }
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
        const capture = ctx.capture
        if (capture) {
          const refusal = tooSmall(ctx, 3, 5)
          if (refusal) return refusal
          try {
            ctx.write("\x1b[0m\x1b[2J\x1b[H")
            ctx.write("LINE1\r\nLINE2\r\nLINE3")
            const control = await capture({
              role: "control",
              label: "Before scroll down: LINE1 on row 1 with LINE2 and LINE3 below",
            })
            ctx.write("\x1b[H\x1b[T") // home then SD
            const target = await capture({
              role: "target",
              label: "After SD at row 1: a blank row is inserted above, pushing LINE1 to row 2",
            })
            return {
              pass: false,
              response: JSON.stringify({
                rows: ctx.rows,
                cols: ctx.cols,
                control: control.label,
                target: target.label,
              }),
              observation: {
                outcome: "inconclusive",
                reason: "insufficient-evidence",
                evidence: "pixels",
                screenshotRef: target.ref,
                frames: [control, target],
                note: "A blank row inserted above the LINE1 marker after SD requires independent pixel review; cursor position alone does not measure the inserted row",
              },
            }
          } finally {
            ctx.write("\x1b[0m\x1b[2J\x1b[H")
          }
        }
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
        const capture = ctx.capture
        if (capture) {
          const refusal = tooSmall(ctx, 10, 3)
          if (refusal) return refusal
          try {
            ctx.write("\x1b[0m\x1b[2J\x1b[H")
            ctx.write("\x1b[1;1HFIXED")
            for (let row = 5; row <= 10; row++) ctx.write(`\x1b[${row};1HR${row}`)
            ctx.write("\x1b[10;6H")
            const control = await capture({
              role: "control",
              label: "FIXED on row 1 and R5-R10 markers before a scroll region is set",
            })
            ctx.write("\x1b[5;10r") // set scroll region rows 5-10
            ctx.write("\x1b[10;1H")
            for (let i = 0; i < 6; i++) ctx.write("down\r\n")
            ctx.write("\x1b[10;6H")
            const target = await capture({
              role: "target",
              label: "After scrolling at the region bottom: R5-R10 shift while FIXED on row 1 stays outside the region",
            })
            return {
              pass: false,
              response: JSON.stringify({
                rows: ctx.rows,
                cols: ctx.cols,
                control: control.label,
                target: target.label,
              }),
              observation: {
                outcome: "inconclusive",
                reason: "insufficient-evidence",
                evidence: "pixels",
                screenshotRef: target.ref,
                frames: [control, target],
                note: "DECSTBM constraining scrolling to rows 5-10 while FIXED on row 1 stays put requires independent pixel review; the region boundary is not readable from a query",
              },
            }
          } finally {
            ctx.write("\x1b[r\x1b[0m\x1b[2J\x1b[H")
          }
        }
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
        const capture = ctx.capture
        if (capture) {
          const refusal = tooSmall(ctx, 1, 19)
          if (refusal) return refusal
          try {
            ctx.write("\x1b[0m\x1b[2J\x1b[H")
            ctx.write("MAIN_SCREEN_MARKER")
            const control = await capture({
              role: "control",
              label: "Main screen shows MAIN_SCREEN_MARKER before entering the alt screen",
            })
            ctx.write("\x1b[?1049h\x1b[2J\x1b[H")
            ctx.write("ALT_SCREEN")
            ctx.write("\x1b[?1049l")
            const target = await capture({
              role: "target",
              label: "After leaving the alt screen: MAIN_SCREEN_MARKER is restored on the main screen",
            })
            return {
              pass: false,
              response: JSON.stringify({
                rows: ctx.rows,
                cols: ctx.cols,
                control: control.label,
                target: target.label,
              }),
              observation: {
                outcome: "inconclusive",
                reason: "insufficient-evidence",
                evidence: "pixels",
                screenshotRef: target.ref,
                frames: [control, target],
                note: "MAIN_SCREEN_MARKER restored after leaving the alt screen requires independent pixel review; mode metadata alone does not measure retained contents",
              },
            }
          } finally {
            ctx.write("\x1b[?1049l\x1b[0m\x1b[2J\x1b[H")
          }
        }
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
        const capture = ctx.capture
        if (capture) {
          const refusal = tooSmall(ctx, 10, 10)
          if (refusal) return refusal
          try {
            ctx.write("\x1b[0m\x1b[2J\x1b[H")
            ctx.write("FIXED_TOP\r\n")
            for (let row = 3; row <= 10; row++) ctx.write(`\x1b[${row};1HINNER${row}`)
            ctx.write("\x1b[10;10H")
            const control = await capture({
              role: "control",
              label: "FIXED_TOP on row 1 and INNER3-INNER10 inside the rows 3-10 region",
            })
            ctx.write("\x1b[3;10r") // scroll region rows 3-10
            ctx.write("\x1b[10;1H")
            for (let i = 0; i < 8; i++) ctx.write("scroll\r\n")
            ctx.write("\x1b[10;10H")
            const target = await capture({
              role: "target",
              label: "After scrolling at the region bottom: INNER rows shift while FIXED_TOP on row 1 stays put",
            })
            return {
              pass: false,
              response: JSON.stringify({
                rows: ctx.rows,
                cols: ctx.cols,
                control: control.label,
                target: target.label,
              }),
              observation: {
                outcome: "inconclusive",
                reason: "insufficient-evidence",
                evidence: "pixels",
                screenshotRef: target.ref,
                frames: [control, target],
                note: "DECSTBM scrolling the INNER markers while preserving FIXED_TOP outside the region requires independent pixel review; the region boundary is not readable from a query",
              },
            }
          } finally {
            ctx.write("\x1b[r\x1b[0m\x1b[2J\x1b[H")
          }
        }
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
        const capture = ctx.capture
        if (capture) {
          const refusal = tooSmall(ctx, 10, 8)
          if (refusal) return refusal
          try {
            ctx.write("\x1b[0m\x1b[2J\x1b[H")
            ctx.write("FIXED_TOP\r\n")
            ctx.write("\x1b[5;10r") // set region rows 5-10
            ctx.write("\x1b[r") // reset to full screen
            ctx.write("\x1b[H")
            const control = await capture({
              role: "control",
              label: "FIXED_TOP on row 1 after a rows 5-10 region was set and then reset",
            })
            const lineCount = ctx.rows + 10
            for (let i = 0; i < lineCount; i++) ctx.write(`line-${i}\r\n`)
            const target = await capture({
              role: "target",
              label: `After ${lineCount} lines: FIXED_TOP has scrolled off row 1, showing full-screen scrolling resumed`,
            })
            return {
              pass: false,
              response: JSON.stringify({
                rows: ctx.rows,
                cols: ctx.cols,
                lineCount,
                control: control.label,
                target: target.label,
              }),
              observation: {
                outcome: "inconclusive",
                reason: "insufficient-evidence",
                evidence: "pixels",
                screenshotRef: target.ref,
                frames: [control, target],
                note: "FIXED_TOP leaving row 1 after a region set-then-reset shows full-screen scrolling into history resumed; independent pixel review is required and the exact retained count is not readable from the screen",
              },
            }
          } finally {
            ctx.write("\x1b[r\x1b[0m\x1b[2J\x1b[H")
          }
        }
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
