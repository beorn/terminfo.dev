import type { ProbeDefinition } from "./types.ts"
import { parserStateResult, probe } from "./helpers.ts"

function validSize(value: number, minimum: number): boolean {
  return Number.isSafeInteger(value) && value >= minimum
}

export const unicodeProbes: ProbeDefinition[] = [
  {
    ...probe(
      "unicode.east-asian-ambiguous",
      (ctx) => {
        const expected = "ASCII seed/control is preserved; ambiguous symbol advances one or two cells before X"
        if (!validSize(ctx.cols, 4)) {
          return {
            pass: false,
            observation: {
              outcome: "inconclusive",
              reason: "insufficient-evidence",
              evidence: "none",
              note: "Need at least four columns for width controls",
            },
          }
        }
        ctx.feed("\x1b[1;1H\x1b[2KAQ")
        const before = Array.from({ length: 2 }, (_, col) => ctx.getCell(0, col).char)
        if (before.join("") !== "AQ") {
          return parserStateResult(null, expected, { before }, "ASCII seed was not measured before ambiguous sample")
        }
        ctx.feed("\x1b[1;1H")
        const cursor = ctx.getCursor()
        const setup = [{ x: cursor.x, y: cursor.y }]
        if (cursor.x !== 0 || cursor.y !== 0) {
          return parserStateResult(null, expected, { before, setup }, "Target CUP did not reach sample start")
        }
        ctx.feed("●X")
        const after = Array.from({ length: 4 }, (_, col) => ctx.getCell(0, col).char)
        const pass = after[1] === "X" || after[2] === "X"
        return parserStateResult(pass, expected, { before, setup, after })
      },
      async (ctx) => {
        if (!validSize(ctx.cols, 3)) {
          return {
            pass: false,
            observation: {
              outcome: "inconclusive",
              reason: "insufficient-evidence",
              evidence: "none",
              note: "Fixture needs at least 3 columns",
            },
          }
        }
        const width = await ctx.measureRenderedWidth("●")
        if (width === null) {
          return {
            pass: false,
            note: "Cannot measure width",
            observation: { outcome: "inconclusive", reason: "no-response", evidence: "behavior" },
          }
        }
        const pass = width === 1 || width === 2
        return {
          pass,
          note: `width=${width} (ambiguous chars vary by terminal/locale)`,
          response: String(width),
          observation: { outcome: pass ? "supported" : "unsupported", evidence: "behavior" },
          assertions: [{ kind: pass ? "positive" : "negative", expected: "width 1 or 2", observed: String(width) }],
        }
      },
    ),
    termNeedsGeometry: true,

    termlessObservationEvidence: "parser-state",
  },

  {
    ...probe(
      "unicode.grapheme-cursor",
      (ctx) => {
        if (!validSize(ctx.cols, 3)) {
          return {
            pass: false,
            observation: {
              outcome: "inconclusive",
              reason: "insufficient-evidence",
              evidence: "none",
              note: "Need at least three measured columns",
            },
          }
        }
        const sample = "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}"
        ctx.feed("\x1b[1;1H\x1b[2KAB")
        const before = Array.from({ length: 2 }, (_, col) => ctx.getCell(0, col).char)
        if (before.join("") !== "AB") {
          return parserStateResult(null, "ZWJ sample occupies two cells", { before }, "ASCII seed was not measured")
        }
        ctx.feed("\x1b[1;1H")
        const setupCursor = ctx.getCursor()
        const setup = [{ x: setupCursor.x, y: setupCursor.y }]
        if (setupCursor.x !== 0 || setupCursor.y !== 0) {
          return parserStateResult(
            null,
            "ZWJ sample occupies two cells",
            { before, setup },
            "Target CUP did not reach sample start",
          )
        }
        ctx.feed(sample)
        const cursor = ctx.getCursor()
        const cell = ctx.getCell(0, 0)
        const pass = cursor.y === 0 && cursor.x === 2 && cell.wide && cell.char.length > 0
        return parserStateResult(pass, "ZWJ sample occupies two cells", { before, setup, cursor, cell })
      },
      async (ctx) => {
        if (!validSize(ctx.cols, 3)) {
          return {
            pass: false,
            observation: {
              outcome: "inconclusive",
              reason: "insufficient-evidence",
              evidence: "none",
              note: "Fixture needs at least 3 columns",
            },
          }
        }
        const width = await ctx.measureRenderedWidth("\u{1F468}\u200D\u{1F469}\u200D\u{1F467}")
        if (width === null) {
          return {
            pass: false,
            note: "Cannot measure width",
            observation: { outcome: "inconclusive", reason: "no-response", evidence: "behavior" },
          }
        }
        return {
          pass: width === 2,
          note: width === 2 ? undefined : `width=${width}, expected 2`,
          response: String(width),
          observation: { outcome: width === 2 ? "supported" : "unsupported", evidence: "behavior" },
          assertions: [{ kind: width === 2 ? "positive" : "negative", expected: "2", observed: String(width) }],
        }
      },
      "behavior",
    ),
    termNeedsGeometry: true,

    termlessObservationEvidence: "parser-state",
  },

  {
    ...probe(
      "unicode.wrap-boundary",
      (ctx) => {
        if (!validSize(ctx.cols, 2) || !validSize(ctx.getScrollback().screenLines, 2)) {
          return {
            pass: false,
            observation: {
              outcome: "inconclusive",
              reason: "insufficient-evidence",
              evidence: "none",
              note: "Need at least two columns and two screen rows",
            },
          }
        }
        const expected = "Wide CJK character wraps from final column to row 2 while ASCII control is preserved"
        ctx.feed("\x1b[1;1H\x1b[2J")
        ctx.feed("A".repeat(ctx.cols))
        const before = Array.from({ length: ctx.cols }, (_, col) => ctx.getCell(0, col).char)
        if (before.some((char) => char !== "A")) {
          return parserStateResult(null, expected, { before }, "ASCII row seed was not measured")
        }
        ctx.feed(`\x1b[1;${ctx.cols}H`)
        const cursor = ctx.getCursor()
        const setup = [{ x: cursor.x, y: cursor.y }]
        if (cursor.x !== ctx.cols - 1 || cursor.y !== 0) {
          return parserStateResult(null, expected, { before, setup }, "Target CUP did not reach final column")
        }
        ctx.feed("\u4e2d")
        const after = [ctx.getCell(0, ctx.cols - 1).char, ctx.getCell(1, 0).char]
        const control = ctx.getCell(0, 0).char
        const pass = control === "A" && after[1] === "\u4e2d"
        return parserStateResult(pass, expected, { before, setup, control, after })
      },
      async (ctx) => {
        const cols = ctx.cols
        if (!validSize(ctx.rows, 2) || !validSize(cols, 2)) {
          return {
            pass: false,
            observation: {
              outcome: "inconclusive",
              reason: "insufficient-evidence",
              evidence: "none",
              note: `Wide-wrap fixture needs at least 2x2, measured ${ctx.rows}x${cols}`,
            },
          }
        }
        ctx.write("\x1b[1;1H\x1b[2J")
        ctx.write("A".repeat(cols - 1))
        ctx.write("\u4e2d") // CJK char (2 cols wide)
        const pos = await ctx.queryCursorPosition()
        if (!pos) {
          return {
            pass: false,
            note: "No cursor response",
            observation: { outcome: "inconclusive", reason: "no-response", evidence: "query" },
          }
        }
        const pass = pos.row === 2
        return {
          pass,
          response: JSON.stringify(pos),
          note: pass ? undefined : `cursor at row ${pos.row}, expected 2 (wide char should wrap)`,
          observation: { outcome: pass ? "supported" : "unsupported", evidence: "behavior" },
          assertions: [
            {
              kind: pass ? "positive" : "negative",
              expected: "cursor row 2 after wide wrap",
              observed: JSON.stringify(pos),
            },
          ],
        }
      },
    ),
    termNeedsGeometry: true,

    termlessObservationEvidence: "parser-state",
  },

  {
    ...probe(
      "unicode.tab-stops",
      (ctx) => {
        if (!validSize(ctx.cols, 10)) {
          return {
            pass: false,
            observation: {
              outcome: "inconclusive",
              reason: "insufficient-evidence",
              evidence: "none",
              note: "Need at least ten measured columns",
            },
          }
        }
        try {
          ctx.feed("\x1b[3g\x1b[1;9H\x1bH\x1b[1;1H\x1b[2K")
          ctx.feed("AB")
          const before = Array.from({ length: 2 }, (_, col) => ctx.getCell(0, col).char)
          if (before.join("") !== "AB") {
            return parserStateResult(
              null,
              "A at column 1; B after tab at configured column 9",
              { before },
              "ASCII seed was not measured",
            )
          }
          ctx.feed("\x1b[1;1H")
          const cursor = ctx.getCursor()
          const setup = [{ x: cursor.x, y: cursor.y }]
          if (cursor.x !== 0 || cursor.y !== 0) {
            return parserStateResult(
              null,
              "A at column 1; B after tab at configured column 9",
              { before, setup },
              "Target CUP did not reach tab sample start",
            )
          }
          ctx.feed("A\tB")
          const after = Array.from({ length: 10 }, (_, col) => ctx.getCell(0, col).char)
          return parserStateResult(after[8] === "B", "A at column 1; B after tab at configured column 9", {
            before,
            setup,
            after,
          })
        } finally {
          let restore = "\x1b[3g"
          for (let col = 9; col <= ctx.cols; col += 8) restore += `\x1b[1;${col}H\x1bH`
          ctx.feed(restore + "\x1b[1;1H")
        }
      },
      async (ctx) => {
        if (!validSize(ctx.cols, 10)) {
          return {
            pass: false,
            observation: {
              outcome: "inconclusive",
              reason: "insufficient-evidence",
              evidence: "none",
              note: "Fixture needs at least 10 columns",
            },
          }
        }
        try {
          ctx.write("\x1b[3g\x1b[1;9H\x1bH\x1b[1;1H\x1b[2K")
          ctx.write("A\tB")
          const pos = await ctx.queryCursorPosition()
          if (!pos) {
            return {
              pass: false,
              note: "No cursor response",
              observation: { outcome: "inconclusive", reason: "no-response", evidence: "query" },
            }
          }
          const pass = pos.col === 10
          return {
            pass,
            response: JSON.stringify(pos),
            note: pass ? undefined : `cursor at col ${pos.col}, expected 10 (A + tab to 9 + B)`,
            observation: { outcome: pass ? "supported" : "unsupported", evidence: "behavior" },
            assertions: [
              {
                kind: pass ? "positive" : "negative",
                expected: "cursor column 10 after tab",
                observed: JSON.stringify(pos),
              },
            ],
          }
        } finally {
          let restore = "\x1b[3g"
          for (let col = 9; col <= ctx.cols; col += 8) restore += `\x1b[1;${col}H\x1bH`
          ctx.write(restore + "\x1b[1;1H")
        }
      },
    ),
    termNeedsGeometry: true,

    termlessObservationEvidence: "parser-state",
  },
]
