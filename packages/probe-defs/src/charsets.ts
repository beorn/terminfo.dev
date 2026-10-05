import type { ProbeDefinition } from "./types.ts"
import { parserStateResult, probe } from "./helpers.ts"

export const charsetsProbes: ProbeDefinition[] = [
  {
    ...probe(
      "charsets.dec-special",
      (ctx) => {
        const expected = "ASCII q controls flank DEC Special Graphics q mapped to U+2500"
        if (!Number.isSafeInteger(ctx.cols) || ctx.cols < 3) {
          return parserStateResult(
            null,
            expected,
            { cols: ctx.cols },
            "Need at least three measured columns for charset controls",
          )
        }
        try {
          ctx.feed("\x0f\x1b(B\x1b)B\x1b[1;1H\x1b[2Kqqq")
          const before = Array.from({ length: 3 }, (_, col) => ctx.getCell(0, col).char)
          if (before.join("") !== "qqq") {
            return parserStateResult(null, expected, { before }, "ASCII seed was not measured before DEC designation")
          }
          ctx.feed("\x1b[1;2H")
          const cursor = ctx.getCursor()
          const setup = [{ x: cursor.x, y: cursor.y }]
          if (cursor.x !== 1 || cursor.y !== 0) {
            return parserStateResult(null, expected, { before, setup }, "Target CUP did not reach DEC graphics cell")
          }
          ctx.feed("\x1b(0q\x1b(Bq")
          const after = Array.from({ length: 3 }, (_, col) => ctx.getCell(0, col).char)
          const controlsValid = after[0] === "q" && after[2] === "q"
          return parserStateResult(
            controlsValid ? after[1] === "─" : null,
            expected,
            { before, setup, after },
            controlsValid ? undefined : "ASCII flank control changed after DEC designation",
          )
        } finally {
          ctx.feed("\x0f\x1b(B\x1b)B")
        }
      },
      async (ctx) => {
        const capture = ctx.capture
        if (capture) {
          const rows = ctx.rows
          const cols = ctx.cols
          if (!Number.isSafeInteger(rows) || !Number.isSafeInteger(cols) || rows < 4 || cols < 6) {
            return {
              pass: false,
              observation: {
                outcome: "inconclusive",
                reason: "insufficient-evidence",
                evidence: "none",
                note: `Charset capture fixture needs at least 4x6, measured ${rows}x${cols}`,
              },
            }
          }
          try {
            ctx.write("\x0f\x1b(B\x1b)B\x1b[0m")
            ctx.write("\x1b[1;1H     \x1b[1;1Hqqq")
            ctx.write("\x1b[2;1H     \x1b[2;1Hq─q")
            ctx.write("\x1b[3;1H     \x1b[3;1Hqqq")
            ctx.write("\x1b[4;1H     \x1b[4;1Hqqq")
            ctx.write("\x1b[4;6H")
            const control = await capture({
              role: "control",
              label: "ASCII q controls on rows 1, 3 and 4; direct Unicode q─q on row 2",
            })
            ctx.write("\x1b[3;2H\x1b(0q\x1b(Bq")
            ctx.write("\x0f\x1b(B\x1b)B\x1b[4;1Hqqq\x1b[4;6H")
            const target = await capture({
              role: "target",
              label: "DEC Special Graphics sample at row 3, column 2; restored ASCII qqq on row 4",
            })
            return {
              pass: false,
              response: JSON.stringify({
                rows,
                cols,
                sampleCell: { row: 3, col: 2 },
                control: control.label,
                target: target.label,
              }),
              observation: {
                outcome: "inconclusive",
                reason: "insufficient-evidence",
                evidence: "pixels",
                screenshotRef: target.ref,
                frames: [control, target],
                note: "Sampled row 3, column 2 horizontal-line appearance relative to row 2 Unicode and ASCII q controls requires independent review; pixels do not measure a numeric codepoint or the whole charset",
              },
            }
          } finally {
            // Normalize the owned disposable fixture, not arbitrary prior terminal state.
            ctx.write("\x1b[0m\x0f\x1b(B\x1b)B")
          }
        }
        if (!Number.isSafeInteger(ctx.rows) || !Number.isSafeInteger(ctx.cols) || ctx.rows < 1 || ctx.cols < 2) {
          return {
            pass: false,
            observation: {
              outcome: "inconclusive",
              reason: "insufficient-evidence",
              evidence: "none",
              note: `Charset fixture needs at least 1x2, measured ${ctx.rows}x${ctx.cols}`,
            },
          }
        }
        ctx.write("\x1b[1;1H\x1b[2K")
        ctx.write("\x1b(0") // Switch to DEC special graphics
        ctx.write("q") // should render as horizontal line
        ctx.write("\x1b(B") // Switch back to ASCII
        const pos = await ctx.queryCursorPosition()
        if (!pos) {
          return {
            pass: false,
            note: "No cursor response",
            observation: { outcome: "inconclusive", reason: "no-response", evidence: "query" },
          }
        }
        return {
          pass: false,
          response: JSON.stringify(pos),
          note: "Cursor movement does not verify charset glyph rendering or mapping",
          observation: {
            outcome: "inconclusive",
            reason: "insufficient-evidence",
            evidence: "consumed",
            note: "Cursor movement does not verify charset glyph rendering or mapping",
          },
        }
      },
    ),
    termNeedsGeometry: true,

    termlessObservationEvidence: "parser-state",
  },

  {
    ...probe(
      "charsets.utf8",
      (ctx) => {
        const expected = "Sampled Unicode characters é and 世 occupy their target cells with ASCII controls intact"
        if (!Number.isSafeInteger(ctx.cols) || ctx.cols < 5) {
          return parserStateResult(
            null,
            expected,
            { cols: ctx.cols },
            "Need at least five measured columns for Unicode controls",
          )
        }
        ctx.feed("\x1b[1;1H\x1b[2KAxy?Z")
        const before = Array.from({ length: 5 }, (_, col) => ctx.getCell(0, col).char)
        if (before.join("") !== "Axy?Z") {
          return parserStateResult(null, expected, { before }, "ASCII seed was not measured before Unicode samples")
        }
        ctx.feed("\x1b[1;2H")
        const first = ctx.getCursor()
        const setup = [{ x: first.x, y: first.y }]
        if (first.x !== 1 || first.y !== 0) {
          return parserStateResult(
            null,
            expected,
            { before, setup },
            "First target CUP did not reach Unicode sample cell",
          )
        }
        ctx.feed("\u00e9")
        ctx.feed("\x1b[1;3H")
        const second = ctx.getCursor()
        setup.push({ x: second.x, y: second.y })
        if (second.x !== 2 || second.y !== 0) {
          return parserStateResult(
            null,
            expected,
            { before, setup },
            "Second target CUP did not reach Unicode sample cell",
          )
        }
        ctx.feed("\u4e16")
        const after = Array.from({ length: 5 }, (_, col) => ctx.getCell(0, col).char)
        const controlsValid = after[0] === "A" && after[4] === "Z"
        return parserStateResult(
          controlsValid ? after[1] === "é" && after[2] === "世" : null,
          expected,
          { before, setup, after },
          controlsValid ? undefined : "ASCII control changed after Unicode samples",
        )
      },
      async (ctx) => {
        const capture = ctx.capture
        if (capture) {
          const rows = ctx.rows
          const cols = ctx.cols
          if (!Number.isSafeInteger(rows) || !Number.isSafeInteger(cols) || rows < 4 || cols < 6) {
            return {
              pass: false,
              observation: {
                outcome: "inconclusive",
                reason: "insufficient-evidence",
                evidence: "none",
                note: `Charset capture fixture needs at least 4x6, measured ${rows}x${cols}`,
              },
            }
          }
          try {
            ctx.write("\x0f\x1b(B\x1b)B\x1b[0m")
            ctx.write("\x1b[1;1H     \x1b[1;1HA?Z")
            ctx.write("\x1b[2;1H     \x1b[2;1HA?Z")
            ctx.write("\x1b[3;1H     \x1b[3;1HA?Z")
            ctx.write("\x1b[4;1H     \x1b[4;1HA?Z")
            ctx.write("\x1b[4;4H")
            const control = await capture({
              role: "control",
              label:
                "ASCII placeholder controls on rows 1 and 2 beside the Unicode sample cells; rows 3 and 4 are reference rows",
            })
            ctx.write("\x1b[1;2H\u00e9\x1b[2;2H\u4e16\x1b[4;4H")
            const target = await capture({
              role: "target",
              label: "UTF-8 samples: U+00E9 at row 1 col 2 and U+4E16 at row 2 col 2, ASCII A/Z flanks intact",
            })
            return {
              pass: false,
              response: JSON.stringify({
                rows,
                cols,
                sampleCells: [
                  { row: 1, col: 2 },
                  { row: 2, col: 2 },
                ],
                control: control.label,
                target: target.label,
              }),
              observation: {
                outcome: "inconclusive",
                reason: "insufficient-evidence",
                evidence: "pixels",
                screenshotRef: target.ref,
                frames: [control, target],
                note: "Sampled U+00E9 and U+4E16 glyphs relative to the ASCII A/Z flanks require independent pixel review; pixels do not measure a codepoint or the whole charset",
              },
            }
          } finally {
            // Normalize the owned disposable fixture, not arbitrary prior terminal state.
            ctx.write("\x1b[0m\x0f\x1b(B\x1b)B")
          }
        }
        if (!Number.isSafeInteger(ctx.rows) || !Number.isSafeInteger(ctx.cols) || ctx.rows < 1 || ctx.cols < 2) {
          return {
            pass: false,
            observation: {
              outcome: "inconclusive",
              reason: "insufficient-evidence",
              evidence: "none",
              note: `Charset fixture needs at least 1x2, measured ${ctx.rows}x${ctx.cols}`,
            },
          }
        }
        ctx.write("\x1b[1;1H\x1b[2K")
        ctx.write("\u00e9") // e-acute (2-byte UTF-8, 1 column)
        const pos = await ctx.queryCursorPosition()
        if (!pos) {
          return {
            pass: false,
            note: "No cursor response",
            observation: { outcome: "inconclusive", reason: "no-response", evidence: "query" },
          }
        }
        return {
          pass: false,
          response: JSON.stringify(pos),
          note: "Cursor movement does not verify charset glyph rendering or mapping",
          observation: {
            outcome: "inconclusive",
            reason: "insufficient-evidence",
            evidence: "consumed",
            note: "Cursor movement does not verify charset glyph rendering or mapping",
          },
        }
      },
    ),
    termNeedsGeometry: true,

    termlessObservationEvidence: "parser-state",
  },

  // G0/G1 switching via SI/SO with independent ASCII flank controls.
  {
    ...probe(
      "charsets.g0-g1-switching",
      (ctx) => {
        const expected = "G0 ASCII l, SO-selected G1 DEC l→U+250C, then SI-selected G0 ASCII l, within A/Z controls"
        if (!Number.isSafeInteger(ctx.cols) || ctx.cols < 5) {
          return parserStateResult(
            null,
            expected,
            { cols: ctx.cols },
            "Need at least five measured columns for G0/G1 controls",
          )
        }
        try {
          ctx.feed("\x0f\x1b(B\x1b)B\x1b[1;1H\x1b[2KAlllZ")
          const before = Array.from({ length: 5 }, (_, col) => ctx.getCell(0, col).char)
          if (before.join("") !== "AlllZ") {
            return parserStateResult(null, expected, { before }, "ASCII seed was not measured before G0/G1 switching")
          }
          ctx.feed("\x1b[1;2H")
          const cursor = ctx.getCursor()
          const setup = [{ x: cursor.x, y: cursor.y }]
          if (cursor.x !== 1 || cursor.y !== 0) {
            return parserStateResult(
              null,
              expected,
              { before, setup },
              "Target CUP did not reach G0/G1 switching cells",
            )
          }
          ctx.feed("\x1b(B\x1b)0l\x0el\x0fl")
          const after = Array.from({ length: 5 }, (_, col) => ctx.getCell(0, col).char)
          const controlsValid = after[0] === "A" && after[4] === "Z"
          return parserStateResult(
            controlsValid ? after[1] === "l" && after[2] === "┌" && after[3] === "l" : null,
            expected,
            { before, setup, after },
            controlsValid ? undefined : "ASCII A/Z control changed after G0/G1 switching",
          )
        } finally {
          ctx.feed("\x0f\x1b(B\x1b)B")
        }
      },
      async (ctx) => {
        const capture = ctx.capture
        if (capture) {
          const rows = ctx.rows
          const cols = ctx.cols
          if (!Number.isSafeInteger(rows) || !Number.isSafeInteger(cols) || rows < 4 || cols < 6) {
            return {
              pass: false,
              observation: {
                outcome: "inconclusive",
                reason: "insufficient-evidence",
                evidence: "none",
                note: `Charset capture fixture needs at least 4x6, measured ${rows}x${cols}`,
              },
            }
          }
          try {
            ctx.write("\x0f\x1b(B\x1b)B\x1b[0m")
            ctx.write("\x1b[1;1H     \x1b[1;1HAlllZ")
            ctx.write("\x1b[2;1H     \x1b[2;1HAlllZ")
            ctx.write("\x1b[3;1H     \x1b[3;1HAlllZ")
            ctx.write("\x1b[4;1H     \x1b[4;1HAlllZ")
            ctx.write("\x1b[4;6H")
            const control = await capture({
              role: "control",
              label: "ASCII lll controls on rows 1 through 3; row 4 is the restored-ASCII reference row",
            })
            ctx.write("\x1b[1;2H\x1b(B\x1b)0l\x0el\x0fl")
            ctx.write("\x0f\x1b(B\x1b)B\x1b[4;1HAlllZ\x1b[4;6H")
            const target = await capture({
              role: "target",
              label:
                "G1 DEC Special Graphics l maps to U+250C on row 1 col 3 after SO, restored by SI; row 4 shows restored ASCII lll",
            })
            return {
              pass: false,
              response: JSON.stringify({
                rows,
                cols,
                sampleCell: { row: 1, col: 3 },
                control: control.label,
                target: target.label,
              }),
              observation: {
                outcome: "inconclusive",
                reason: "insufficient-evidence",
                evidence: "pixels",
                screenshotRef: target.ref,
                frames: [control, target],
                note: "Sampled G1 DEC Special Graphics U+250C relative to ASCII l controls requires independent pixel review; pixels do not measure a codepoint or the whole charset",
              },
            }
          } finally {
            // Normalize the owned disposable fixture, not arbitrary prior terminal state.
            ctx.write("\x1b[0m\x0f\x1b(B\x1b)B")
          }
        }
        if (!Number.isSafeInteger(ctx.rows) || !Number.isSafeInteger(ctx.cols) || ctx.rows < 1 || ctx.cols < 2) {
          return {
            pass: false,
            observation: {
              outcome: "inconclusive",
              reason: "insufficient-evidence",
              evidence: "none",
              note: `Charset fixture needs at least 1x2, measured ${ctx.rows}x${ctx.cols}`,
            },
          }
        }
        ctx.write("\x1b[1;1H\x1b[2K")
        ctx.write("\x1b(0") // DEC Special Graphics
        ctx.write("l") // ┌
        ctx.write("\x1b(B") // back to ASCII
        const pos = await ctx.queryCursorPosition()
        if (!pos) {
          return {
            pass: false,
            note: "No cursor response",
            observation: { outcome: "inconclusive", reason: "no-response", evidence: "query" },
          }
        }
        return {
          pass: false,
          response: JSON.stringify(pos),
          note: "Cursor movement does not verify charset glyph rendering or mapping",
          observation: {
            outcome: "inconclusive",
            reason: "insufficient-evidence",
            evidence: "consumed",
            note: "Cursor movement does not verify charset glyph rendering or mapping",
          },
        }
      },
    ),
    termNeedsGeometry: true,

    termlessObservationEvidence: "parser-state",
  },

  // DEC line drawing — six box-drawing samples.
  {
    ...probe(
      "charsets.dec-line-drawing",
      (ctx) => {
        const expected = "DEC jklmqx map exactly to ┘┐┌└─│ while trailing ASCII j remains unchanged"
        if (!Number.isSafeInteger(ctx.cols) || ctx.cols < 7) {
          return parserStateResult(
            null,
            expected,
            { cols: ctx.cols },
            "Need at least seven measured columns for line-drawing controls",
          )
        }
        try {
          ctx.feed("\x0f\x1b(B\x1b)B\x1b[1;1H\x1b[2Kjklmqxj")
          const before = Array.from({ length: 7 }, (_, col) => ctx.getCell(0, col).char)
          if (before.join("") !== "jklmqxj") {
            return parserStateResult(null, expected, { before }, "ASCII seed was not measured before line drawing")
          }
          ctx.feed("\x1b[1;1H")
          const cursor = ctx.getCursor()
          const setup = [{ x: cursor.x, y: cursor.y }]
          if (cursor.x !== 0 || cursor.y !== 0) {
            return parserStateResult(
              null,
              expected,
              { before, setup },
              "Target CUP did not reach line-drawing start cell",
            )
          }
          ctx.feed("\x1b(0jklmqx\x1b(B")
          const after = Array.from({ length: 7 }, (_, col) => ctx.getCell(0, col).char)
          const controlsValid = after[6] === "j"
          return parserStateResult(
            controlsValid ? after.slice(0, 6).join("") === "┘┐┌└─│" : null,
            expected,
            { before, setup, after },
            controlsValid ? undefined : "Trailing ASCII j control changed after DEC line drawing",
          )
        } finally {
          ctx.feed("\x0f\x1b(B\x1b)B")
        }
      },
      async (ctx) => {
        const capture = ctx.capture
        if (capture) {
          const rows = ctx.rows
          const cols = ctx.cols
          if (!Number.isSafeInteger(rows) || !Number.isSafeInteger(cols) || rows < 4 || cols < 7) {
            return {
              pass: false,
              observation: {
                outcome: "inconclusive",
                reason: "insufficient-evidence",
                evidence: "none",
                note: `Charset capture fixture needs at least 4x7, measured ${rows}x${cols}`,
              },
            }
          }
          try {
            ctx.write("\x0f\x1b(B\x1b)B\x1b[0m")
            ctx.write("\x1b[1;1H       \x1b[1;1Hjklmqxj")
            ctx.write("\x1b[2;1H       \x1b[2;1Hjklmqxj")
            ctx.write("\x1b[3;1H       \x1b[3;1Hjklmqxj")
            ctx.write("\x1b[4;1H       \x1b[4;1Hjklmqxj")
            ctx.write("\x1b[4;8H")
            const control = await capture({
              role: "control",
              label: "ASCII jklmqxj controls on rows 1 through 3; row 4 is the restored-ASCII reference row",
            })
            ctx.write("\x1b[1;1H\x1b(0jklmqx\x1b(B")
            ctx.write("\x0f\x1b(B\x1b)B\x1b[4;1Hjklmqxj\x1b[4;8H")
            const target = await capture({
              role: "target",
              label: "DEC Special Graphics jklmqx on row 1 mapping to ┘┐┌└─│; row 4 shows restored ASCII jklmqxj",
            })
            return {
              pass: false,
              response: JSON.stringify({
                rows,
                cols,
                sampleCells: [
                  { row: 1, col: 1 },
                  { row: 1, col: 2 },
                  { row: 1, col: 3 },
                  { row: 1, col: 4 },
                  { row: 1, col: 5 },
                  { row: 1, col: 6 },
                ],
                control: control.label,
                target: target.label,
              }),
              observation: {
                outcome: "inconclusive",
                reason: "insufficient-evidence",
                evidence: "pixels",
                screenshotRef: target.ref,
                frames: [control, target],
                note: "Sampled six DEC Special Graphics box-drawing cells relative to ASCII jklmqxj controls requires independent pixel review; pixels do not measure codepoints or the whole charset",
              },
            }
          } finally {
            // Normalize the owned disposable fixture, not arbitrary prior terminal state.
            ctx.write("\x1b[0m\x0f\x1b(B\x1b)B")
          }
        }
        if (!Number.isSafeInteger(ctx.rows) || !Number.isSafeInteger(ctx.cols) || ctx.rows < 1 || ctx.cols < 7) {
          return {
            pass: false,
            observation: {
              outcome: "inconclusive",
              reason: "insufficient-evidence",
              evidence: "none",
              note: `Charset fixture needs at least 1x7, measured ${ctx.rows}x${ctx.cols}`,
            },
          }
        }
        ctx.write("\x1b[1;1H\x1b[2K")
        ctx.write("\x1b(0") // DEC Special Graphics
        ctx.write("jklmqx") // box-drawing chars
        ctx.write("\x1b(B") // back to ASCII
        const pos = await ctx.queryCursorPosition()
        if (!pos) {
          return {
            pass: false,
            note: "No cursor response",
            observation: { outcome: "inconclusive", reason: "no-response", evidence: "query" },
          }
        }
        return {
          pass: false,
          response: JSON.stringify(pos),
          note: "Cursor movement does not verify charset glyph rendering or mapping",
          observation: {
            outcome: "inconclusive",
            reason: "insufficient-evidence",
            evidence: "consumed",
            note: "Cursor movement does not verify charset glyph rendering or mapping",
          },
        }
      },
    ),
    termNeedsGeometry: true,

    termlessObservationEvidence: "parser-state",
  },
]
