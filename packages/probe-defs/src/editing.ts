import type { ProbeDefinition, ProbeResult } from "./types.ts"
import { parserStateResult, probe, isBlank, unmeasuredCellResult, selectiveEraseResult } from "./helpers.ts"

// DECRQCRA is a reply capability probe, not a checksum-correctness oracle.
function checksumResult(response: string): ProbeResult {
  const supported = /\x1bP1!~[0-9A-Fa-f]{4}\x1b\\/.test(response)
  const assertions: NonNullable<ProbeResult["assertions"]> | undefined = supported
    ? [{ kind: "positive", expected: "Complete four-digit checksum reply for request 1", observed: response }]
    : undefined
  return {
    pass: supported,
    response,
    note: "Checks framed reply and request id; checksum arithmetic is not verified",
    observation: {
      outcome: supported ? "supported" : "inconclusive",
      evidence: "query",
      ...(!supported && { reason: response ? ("invalid-reply" as const) : ("no-response" as const) }),
    },
    ...(assertions && { assertions }),
  }
}

export const editingProbes: ProbeDefinition[] = [
  {
    ...probe(
      "editing.insert-chars",
      (ctx) => {
        const expected = "ICH inserts a blank cell at column 3 and shifts measured text right; prefix stays intact"
        if (!Number.isSafeInteger(ctx.cols) || ctx.cols < 8) {
          return parserStateResult(
            null,
            expected,
            { cols: ctx.cols },
            "Need eight measured columns for the ICH fixture",
          )
        }
        ctx.feed("\x1b[1;1H\x1b[2KABCDEZQH")
        const before = Array.from({ length: 8 }, (_, col) => ctx.getCell(0, col).char)
        if (before.join("") !== "ABCDEZQH") {
          return parserStateResult(null, expected, { before }, "ICH seed was not measured before the edit")
        }
        ctx.feed("\x1b[1;3H")
        const setup = ctx.getCursor()
        if (setup.x !== 2 || setup.y !== 0) {
          return parserStateResult(null, expected, { before, setup }, "ICH cursor setup did not reach column 3")
        }
        ctx.feed("\x1b[1@")
        const after = Array.from({ length: 8 }, (_, col) => ctx.getCell(0, col).char)
        const controlsValid = after[0] === "A" && after[1] === "B"
        return parserStateResult(
          controlsValid ? isBlank(after[2] ?? "") && after.slice(3).join("") === "CDEZQ" : null,
          expected,
          { before, setup, after },
          controlsValid ? undefined : "ICH prefix control changed during the edit",
        )
      },
      async (ctx) => {
        if (!Number.isSafeInteger(ctx.rows) || !Number.isSafeInteger(ctx.cols) || ctx.rows < 1 || ctx.cols < 5) {
          return {
            pass: false,
            observation: {
              outcome: "inconclusive",
              reason: "insufficient-evidence",
              evidence: "none",
              note: `Editing fixture needs at least 1x5, measured ${ctx.rows}x${ctx.cols}`,
            },
          }
        }
        ctx.write("\x1b[1;1H\x1b[2K") // Clear line
        ctx.write("ABCD")
        ctx.write("\x1b[1;2H") // Move to col 2
        ctx.write("\x1b[1@") // ICH 1
        const pos = await ctx.queryCursorPosition()
        return unmeasuredCellResult(pos, "edited cells or attributes")
      },
    ),
    termNeedsGeometry: true,

    termlessObservationEvidence: "parser-state",
  },

  {
    ...probe(
      "editing.delete-chars",
      (ctx) => {
        const expected = "DCH deletes the cell at column 3 and shifts measured text left; prefix stays intact"
        if (!Number.isSafeInteger(ctx.cols) || ctx.cols < 8) {
          return parserStateResult(
            null,
            expected,
            { cols: ctx.cols },
            "Need eight measured columns for the DCH fixture",
          )
        }
        ctx.feed("\x1b[1;1H\x1b[2KABCDEZQH")
        const before = Array.from({ length: 8 }, (_, col) => ctx.getCell(0, col).char)
        if (before.join("") !== "ABCDEZQH") {
          return parserStateResult(null, expected, { before }, "DCH seed was not measured before the edit")
        }
        ctx.feed("\x1b[1;3H")
        const setup = ctx.getCursor()
        if (setup.x !== 2 || setup.y !== 0) {
          return parserStateResult(null, expected, { before, setup }, "DCH cursor setup did not reach column 3")
        }
        ctx.feed("\x1b[1P")
        // The next unmeasured cell can shift into column 8; assert only the known source span.
        const after = Array.from({ length: 7 }, (_, col) => ctx.getCell(0, col).char)
        const controlsValid = after[0] === "A" && after[1] === "B"
        return parserStateResult(
          controlsValid ? after.slice(2).join("") === "DEZQH" : null,
          expected,
          { before, setup, after },
          controlsValid ? undefined : "DCH prefix control changed during the edit",
        )
      },
      async (ctx) => {
        if (!Number.isSafeInteger(ctx.rows) || !Number.isSafeInteger(ctx.cols) || ctx.rows < 1 || ctx.cols < 5) {
          return {
            pass: false,
            observation: {
              outcome: "inconclusive",
              reason: "insufficient-evidence",
              evidence: "none",
              note: `Editing fixture needs at least 1x5, measured ${ctx.rows}x${ctx.cols}`,
            },
          }
        }
        ctx.write("\x1b[1;1H\x1b[2K") // Clear line
        ctx.write("ABCD")
        ctx.write("\x1b[1;2H") // Move to col 2
        ctx.write("\x1b[1P") // DCH 1
        const pos = await ctx.queryCursorPosition()
        return unmeasuredCellResult(pos, "edited cells or attributes")
      },
    ),
    termNeedsGeometry: true,

    termlessObservationEvidence: "parser-state",
  },

  {
    ...probe(
      "editing.insert-lines",
      (ctx) => {
        const expected = "IL inserts a blank row 2 and shifts measured rows down while row 1 stays intact"
        const screenLines = ctx.getScrollback().screenLines
        if (!Number.isSafeInteger(ctx.cols) || ctx.cols < 6 || !Number.isSafeInteger(screenLines) || screenLines < 4) {
          return parserStateResult(
            null,
            expected,
            { cols: ctx.cols, screenLines },
            "Need six measured columns and four measured screen lines for IL",
          )
        }
        const seed = ["AAAAA", "BBBBB", "CCCCC", "DDDDD"]
        for (const [row, text] of seed.entries()) ctx.feed(`\x1b[${row + 1};1H\x1b[2K${text}`)
        const before = seed.map((_, row) => Array.from({ length: 5 }, (_, col) => ctx.getCell(row, col).char))
        if (before.some((cells, row) => cells.join("") !== seed[row])) {
          return parserStateResult(null, expected, { before }, "IL source rows were not measured before the edit")
        }
        ctx.feed("\x1b[2;1H")
        const setup = ctx.getCursor()
        if (setup.x !== 0 || setup.y !== 1) {
          return parserStateResult(null, expected, { before, setup }, "IL cursor setup did not reach row 2 column 1")
        }
        ctx.feed("\x1b[1L")
        const after = seed.map((_, row) => Array.from({ length: 5 }, (_, col) => ctx.getCell(row, col).char))
        const controlsValid = after[0]?.join("") === "AAAAA"
        return parserStateResult(
          controlsValid
            ? after[1]?.every(isBlank) === true && after[2]?.join("") === "BBBBB" && after[3]?.join("") === "CCCCC"
            : null,
          expected,
          { before, setup, after },
          controlsValid ? undefined : "IL first-row control changed during the edit",
        )
      },
      async (ctx) => {
        if (!Number.isSafeInteger(ctx.rows) || !Number.isSafeInteger(ctx.cols) || ctx.rows < 3 || ctx.cols < 5) {
          return {
            pass: false,
            observation: {
              outcome: "inconclusive",
              reason: "insufficient-evidence",
              evidence: "none",
              note: `Editing fixture needs at least 3x5, measured ${ctx.rows}x${ctx.cols}`,
            },
          }
        }
        ctx.write("\x1b[3;5H") // Move to row 3, col 5
        ctx.write("\x1b[1L") // IL 1
        const pos = await ctx.queryCursorPosition()
        return unmeasuredCellResult(pos, "edited cells or attributes")
      },
    ),
    termNeedsGeometry: true,

    termlessObservationEvidence: "parser-state",
  },

  {
    ...probe(
      "editing.delete-lines",
      (ctx) => {
        const expected = "DL removes row 2 and shifts measured rows up while row 1 stays intact"
        const screenLines = ctx.getScrollback().screenLines
        if (!Number.isSafeInteger(ctx.cols) || ctx.cols < 6 || !Number.isSafeInteger(screenLines) || screenLines < 4) {
          return parserStateResult(
            null,
            expected,
            { cols: ctx.cols, screenLines },
            "Need six measured columns and four measured screen lines for DL",
          )
        }
        const seed = ["AAAAA", "BBBBB", "CCCCC", "DDDDD"]
        for (const [row, text] of seed.entries()) ctx.feed(`\x1b[${row + 1};1H\x1b[2K${text}`)
        const before = seed.map((_, row) => Array.from({ length: 5 }, (_, col) => ctx.getCell(row, col).char))
        if (before.some((cells, row) => cells.join("") !== seed[row])) {
          return parserStateResult(null, expected, { before }, "DL source rows were not measured before the edit")
        }
        ctx.feed("\x1b[2;1H")
        const setup = ctx.getCursor()
        if (setup.x !== 0 || setup.y !== 1) {
          return parserStateResult(null, expected, { before, setup }, "DL cursor setup did not reach row 2 column 1")
        }
        ctx.feed("\x1b[1M")
        // Row 4's incoming source is unmeasured when the screen is taller than four rows.
        const after = Array.from({ length: 3 }, (_, row) =>
          Array.from({ length: 5 }, (_, col) => ctx.getCell(row, col).char),
        )
        const controlsValid = after[0]?.join("") === "AAAAA"
        return parserStateResult(
          controlsValid ? after[1]?.join("") === "CCCCC" && after[2]?.join("") === "DDDDD" : null,
          expected,
          { before, setup, after },
          controlsValid ? undefined : "DL first-row control changed during the edit",
        )
      },
      async (ctx) => {
        if (!Number.isSafeInteger(ctx.rows) || !Number.isSafeInteger(ctx.cols) || ctx.rows < 3 || ctx.cols < 5) {
          return {
            pass: false,
            observation: {
              outcome: "inconclusive",
              reason: "insufficient-evidence",
              evidence: "none",
              note: `Editing fixture needs at least 3x5, measured ${ctx.rows}x${ctx.cols}`,
            },
          }
        }
        ctx.write("\x1b[3;5H") // Move to row 3, col 5
        ctx.write("\x1b[1M") // DL 1
        const pos = await ctx.queryCursorPosition()
        return unmeasuredCellResult(pos, "edited cells or attributes")
      },
    ),
    termNeedsGeometry: true,

    termlessObservationEvidence: "parser-state",
  },

  {
    ...probe(
      "editing.repeat-char",
      (ctx) => {
        const expected =
          "REP repeats the immediately preceding X into three target cells without changing flank controls"
        if (!Number.isSafeInteger(ctx.cols) || ctx.cols < 6) {
          return parserStateResult(null, expected, { cols: ctx.cols }, "Need six measured columns for the REP fixture")
        }
        ctx.feed("\x1b[1;1H\x1b[2KAX   Z")
        const seed = Array.from({ length: 6 }, (_, col) => ctx.getCell(0, col).char)
        if (seed.join("") !== "AX   Z") {
          return parserStateResult(null, expected, { seed }, "REP flank and blank seed was not measured")
        }
        ctx.feed("\x1b[1;2H")
        const targetPosition = ctx.getCursor()
        if (targetPosition.x !== 1 || targetPosition.y !== 0) {
          return parserStateResult(null, expected, { seed, targetPosition }, "REP cursor setup did not reach column 2")
        }
        ctx.feed("X")
        const before = Array.from({ length: 6 }, (_, col) => ctx.getCell(0, col).char)
        const setup = ctx.getCursor()
        if (before.join("") !== "AX   Z" || setup.x !== 2 || setup.y !== 0) {
          return parserStateResult(
            null,
            expected,
            { seed, targetPosition, before, setup },
            "REP X setup was not measured",
          )
        }
        ctx.feed("\x1b[3b")
        const after = Array.from({ length: 6 }, (_, col) => ctx.getCell(0, col).char)
        const controlsValid = after[0] === "A" && after[5] === "Z"
        return parserStateResult(
          controlsValid ? after.slice(1, 5).join("") === "XXXX" : null,
          expected,
          { seed, targetPosition, before, setup, after },
          controlsValid ? undefined : "REP flank control changed during the edit",
        )
      },
      async (ctx) => {
        if (!Number.isSafeInteger(ctx.rows) || !Number.isSafeInteger(ctx.cols) || ctx.rows < 1 || ctx.cols < 6) {
          return {
            pass: false,
            observation: {
              outcome: "inconclusive",
              reason: "insufficient-evidence",
              evidence: "none",
              note: `Editing fixture needs at least 1x6, measured ${ctx.rows}x${ctx.cols}`,
            },
          }
        }
        ctx.write("\x1b[1;1H\x1b[2K") // clear line
        ctx.write("X") // write X (cursor at col 2)
        ctx.write("\x1b[4b") // REP 4
        const pos = await ctx.queryCursorPosition()
        return unmeasuredCellResult(pos, "edited cells or attributes")
      },
    ),
    termNeedsGeometry: true,

    termlessObservationEvidence: "parser-state",
  },

  // ── VT420 Rectangular Area Operations (1990) ──

  {
    ...probe(
      "editing.decfra",
      (ctx) => {
        const expected = "DECFRA fills the measured 3x5 area and preserves its measured right flank"
        if (
          !Number.isSafeInteger(ctx.cols) ||
          ctx.cols < 6 ||
          !Number.isSafeInteger(ctx.getScrollback().screenLines) ||
          ctx.getScrollback().screenLines < 3
        ) {
          return parserStateResult(
            null,
            expected,
            { cols: ctx.cols, rows: ctx.getScrollback().screenLines },
            "Need a measured 3x6 fixture",
          )
        }
        ctx.feed("\x1b[1;1HaaaaaZ\x1b[2;1HbbbbbY\x1b[3;1HcccccW")
        const before = Array.from({ length: 3 }, (_, row) =>
          Array.from({ length: 6 }, (_, col) => ctx.getCell(row, col).char).join(""),
        )
        if (before.join("|") !== "aaaaaZ|bbbbbY|cccccW") {
          return parserStateResult(null, expected, { before }, "DECFRA seed was not measured")
        }
        ctx.feed("\x1b[1;1H")
        const setup = ctx.getCursor()
        if (setup.x !== 0 || setup.y !== 0) {
          return parserStateResult(null, expected, { before, setup }, "DECFRA cursor setup failed")
        }
        ctx.feed("\x1b[88;1;1;3;5$x")
        const after = Array.from({ length: 3 }, (_, row) =>
          Array.from({ length: 6 }, (_, col) => ctx.getCell(row, col).char).join(""),
        )
        const controlsValid = after.every((line, row) => line[5] === before[row]?.[5])
        return parserStateResult(
          controlsValid ? after.every((line) => line.slice(0, 5) === "XXXXX") : null,
          expected,
          { before, setup, after },
          controlsValid ? undefined : "DECFRA outside control changed",
        )
      },
      async (ctx) => {
        if (!Number.isSafeInteger(ctx.rows) || !Number.isSafeInteger(ctx.cols) || ctx.rows < 3 || ctx.cols < 5) {
          return {
            pass: false,
            observation: {
              outcome: "inconclusive",
              reason: "insufficient-evidence",
              evidence: "none",
              note: `Editing fixture needs at least 3x5, measured ${ctx.rows}x${ctx.cols}`,
            },
          }
        }
        ctx.write("\x1b[1;1H")
        ctx.write("\x1b[88;1;1;3;5$x") // DECFRA fill 'X'
        const pos = await ctx.queryCursorPosition()
        return unmeasuredCellResult(pos, "edited cells or attributes")
      },
    ),
    termNeedsGeometry: true,

    termlessObservationEvidence: "parser-state",
  },

  {
    ...probe(
      "editing.decera",
      (ctx) => {
        const expected = "DECERA blanks measured 3x5 cells and preserves their measured right flank"
        const rows = ctx.getScrollback().screenLines
        if (!Number.isSafeInteger(ctx.cols) || ctx.cols < 6 || !Number.isSafeInteger(rows) || rows < 3) {
          return parserStateResult(null, expected, { cols: ctx.cols, rows }, "Need a measured 3x6 fixture")
        }
        const seeds = ["aaaaaZ", "bbbbbY", "cccccX"]
        ctx.feed("\x1b[1;1HaaaaaZ\x1b[2;1HbbbbbY\x1b[3;1HcccccX")
        const before = Array.from({ length: 3 }, (_, row) =>
          Array.from({ length: 6 }, (_, col) => ctx.getCell(row, col).char),
        )
        if (!before.every((line, row) => line.every((char, col) => char === seeds[row]?.[col]))) {
          return parserStateResult(null, expected, { before }, "DECERA seed was not measured")
        }
        ctx.feed("\x1b[1;1H")
        const setup = ctx.getCursor()
        if (setup.x !== 0 || setup.y !== 0) {
          return parserStateResult(null, expected, { before, setup }, "DECERA cursor setup failed")
        }
        ctx.feed("\x1b[1;1;3;5$z")
        const after = Array.from({ length: 3 }, (_, row) =>
          Array.from({ length: 6 }, (_, col) => ctx.getCell(row, col).char),
        )
        const controlsValid = after.every((line, row) => line[5] === before[row]?.[5])
        return parserStateResult(
          controlsValid ? after.every((line) => line.slice(0, 5).every(isBlank)) : null,
          expected,
          { before, setup, after },
          controlsValid ? undefined : "DECERA outside control changed",
        )
      },
      async (ctx) => {
        if (!Number.isSafeInteger(ctx.rows) || !Number.isSafeInteger(ctx.cols) || ctx.rows < 3 || ctx.cols < 5) {
          return {
            pass: false,
            observation: {
              outcome: "inconclusive",
              reason: "insufficient-evidence",
              evidence: "none",
              note: `Editing fixture needs at least 3x5, measured ${ctx.rows}x${ctx.cols}`,
            },
          }
        }
        ctx.write("\x1b[1;1H")
        ctx.write("\x1b[1;1;3;5$z") // DECERA
        const pos = await ctx.queryCursorPosition()
        return unmeasuredCellResult(pos, "edited cells or attributes")
      },
    ),
    termNeedsGeometry: true,

    termlessObservationEvidence: "parser-state",
  },

  {
    ...probe(
      "editing.decsera",
      (ctx) => selectiveEraseResult(ctx, "\x1b[1;1;1;5${", true),
      async (ctx) => {
        if (!Number.isSafeInteger(ctx.rows) || !Number.isSafeInteger(ctx.cols) || ctx.rows < 3 || ctx.cols < 5) {
          return {
            pass: false,
            observation: {
              outcome: "inconclusive",
              reason: "insufficient-evidence",
              evidence: "none",
              note: `Editing fixture needs at least 3x5, measured ${ctx.rows}x${ctx.cols}`,
            },
          }
        }
        ctx.write("\x1b[1;1H")
        ctx.write("\x1b[1;1;3;5${") // DECSERA
        const pos = await ctx.queryCursorPosition()
        return unmeasuredCellResult(pos, "edited cells or attributes")
      },
    ),
    termNeedsGeometry: true,
  },

  {
    ...probe(
      "editing.deccra",
      (ctx) => {
        const expected = "DECCRA copies measured 2x5 source cells to row 5 column 10 without changing the source"
        const rows = ctx.getScrollback().screenLines
        if (!Number.isSafeInteger(ctx.cols) || ctx.cols < 14 || !Number.isSafeInteger(rows) || rows < 6) {
          return parserStateResult(null, expected, { cols: ctx.cols, rows }, "Need a measured 6x14 fixture")
        }
        ctx.feed(
          "\x1b[1;1HABCDE.........\x1b[2;1HFGHIJ.........\x1b[3;1H..............\x1b[4;1H..............\x1b[5;1H.........12345\x1b[6;1H.........67890",
        )
        const before = Array.from({ length: 6 }, (_, row) =>
          Array.from({ length: 14 }, (_, col) => ctx.getCell(row, col).char).join(""),
        )
        if (
          before.join("|") !==
          "ABCDE.........|FGHIJ.........|..............|..............|.........12345|.........67890"
        ) {
          return parserStateResult(null, expected, { before }, "DECCRA source and destination were not measured")
        }
        ctx.feed("\x1b[1;1H")
        const setup = ctx.getCursor()
        if (setup.x !== 0 || setup.y !== 0) {
          return parserStateResult(null, expected, { before, setup }, "DECCRA cursor setup failed")
        }
        ctx.feed("\x1b[1;1;2;5;1;5;10$v")
        const after = Array.from({ length: 6 }, (_, row) =>
          Array.from({ length: 14 }, (_, col) => ctx.getCell(row, col).char).join(""),
        )
        const controlsValid =
          after.slice(0, 4).every((line, row) => line === before[row]) &&
          after[4]?.slice(0, 9) === before[4]?.slice(0, 9) &&
          after[5]?.slice(0, 9) === before[5]?.slice(0, 9)
        return parserStateResult(
          controlsValid ? after[4]?.slice(9) === "ABCDE" && after[5]?.slice(9) === "FGHIJ" : null,
          expected,
          { before, setup, after },
          controlsValid ? undefined : "DECCRA source or outside control changed",
        )
      },
      async (ctx) => {
        if (!Number.isSafeInteger(ctx.rows) || !Number.isSafeInteger(ctx.cols) || ctx.rows < 6 || ctx.cols < 14) {
          return {
            pass: false,
            observation: {
              outcome: "inconclusive",
              reason: "insufficient-evidence",
              evidence: "none",
              note: `Editing fixture needs at least 6x14, measured ${ctx.rows}x${ctx.cols}`,
            },
          }
        }
        ctx.write("\x1b[1;1H")
        ctx.write("\x1b[1;1;2;5;1;5;10$v") // DECCRA
        const pos = await ctx.queryCursorPosition()
        return unmeasuredCellResult(pos, "edited cells or attributes")
      },
    ),
    termNeedsGeometry: true,

    termlessObservationEvidence: "parser-state",
  },

  {
    ...probe(
      "editing.deccara",
      (ctx) => {
        const expected = "DECCARA sets inverse on measured 3x5 cells, preserving text and right flank"
        const rows = ctx.getScrollback().screenLines
        if (!Number.isSafeInteger(ctx.cols) || ctx.cols < 6 || !Number.isSafeInteger(rows) || rows < 3) {
          return parserStateResult(null, expected, { cols: ctx.cols, rows }, "Need a measured 3x6 fixture")
        }
        ctx.feed("\x1b[1;1HaaaaaZ\x1b[2;1HbbbbbY\x1b[3;1HcccccX")
        const before = Array.from({ length: 3 }, (_, row) =>
          Array.from({ length: 6 }, (_, col) => ctx.getCell(row, col)),
        )
        if (
          before.map((line) => line.map((cell) => cell.char).join("")).join("|") !== "aaaaaZ|bbbbbY|cccccX" ||
          before.some((line) => line.some((cell) => cell.inverse))
        ) {
          return parserStateResult(null, expected, { before }, "DECCARA character and attribute seed was not measured")
        }
        ctx.feed("\x1b[1;1H")
        const setup = ctx.getCursor()
        if (setup.x !== 0 || setup.y !== 0) {
          return parserStateResult(null, expected, { before, setup }, "DECCARA cursor setup failed")
        }
        ctx.feed("\x1b[1;1;3;5;7$r")
        const after = Array.from({ length: 3 }, (_, row) =>
          Array.from({ length: 6 }, (_, col) => ctx.getCell(row, col)),
        )
        const controlsValid = after.every(
          (line, row) => line.every((cell, col) => cell.char === before[row]?.[col]?.char) && !line[5]?.inverse,
        )
        return parserStateResult(
          controlsValid ? after.every((line) => line.slice(0, 5).every((cell) => cell.inverse)) : null,
          expected,
          { before, setup, after },
          controlsValid ? undefined : "DECCARA character or outside attribute control changed",
        )
      },
      async (ctx) => {
        if (!Number.isSafeInteger(ctx.rows) || !Number.isSafeInteger(ctx.cols) || ctx.rows < 3 || ctx.cols < 5) {
          return {
            pass: false,
            observation: {
              outcome: "inconclusive",
              reason: "insufficient-evidence",
              evidence: "none",
              note: `Editing fixture needs at least 3x5, measured ${ctx.rows}x${ctx.cols}`,
            },
          }
        }
        ctx.write("\x1b[1;1H")
        ctx.write("\x1b[1;1;3;5;7$r") // DECCARA
        const pos = await ctx.queryCursorPosition()
        return unmeasuredCellResult(pos, "edited cells or attributes")
      },
    ),
    termNeedsGeometry: true,

    termlessObservationEvidence: "parser-state",
  },

  {
    ...probe(
      "editing.decrara",
      (ctx) => {
        const expected = "DECRARA clears inverse on measured 3x5 inverse cells, preserving text and right flank"
        const rows = ctx.getScrollback().screenLines
        if (!Number.isSafeInteger(ctx.cols) || ctx.cols < 6 || !Number.isSafeInteger(rows) || rows < 3) {
          return parserStateResult(null, expected, { cols: ctx.cols, rows }, "Need a measured 3x6 fixture")
        }
        ctx.feed("\x1b[1;1H\x1b[7maaaaa\x1b[0mZ\x1b[2;1H\x1b[7mbbbbb\x1b[0mY\x1b[3;1H\x1b[7mccccc\x1b[0mX")
        const before = Array.from({ length: 3 }, (_, row) =>
          Array.from({ length: 6 }, (_, col) => ctx.getCell(row, col)),
        )
        if (
          before.map((line) => line.map((cell) => cell.char).join("")).join("|") !== "aaaaaZ|bbbbbY|cccccX" ||
          before.some((line) => !line.slice(0, 5).every((cell) => cell.inverse) || line[5]?.inverse)
        ) {
          return parserStateResult(null, expected, { before }, "DECRARA inverse seed was not measured")
        }
        ctx.feed("\x1b[1;1H")
        const setup = ctx.getCursor()
        if (setup.x !== 0 || setup.y !== 0) {
          return parserStateResult(null, expected, { before, setup }, "DECRARA cursor setup failed")
        }
        ctx.feed("\x1b[1;1;3;5;7$t")
        const after = Array.from({ length: 3 }, (_, row) =>
          Array.from({ length: 6 }, (_, col) => ctx.getCell(row, col)),
        )
        const controlsValid = after.every(
          (line, row) => line.every((cell, col) => cell.char === before[row]?.[col]?.char) && !line[5]?.inverse,
        )
        return parserStateResult(
          controlsValid ? after.every((line) => line.slice(0, 5).every((cell) => !cell.inverse)) : null,
          expected,
          { before, setup, after },
          controlsValid ? undefined : "DECRARA character or outside attribute control changed",
        )
      },
      async (ctx) => {
        if (!Number.isSafeInteger(ctx.rows) || !Number.isSafeInteger(ctx.cols) || ctx.rows < 3 || ctx.cols < 5) {
          return {
            pass: false,
            observation: {
              outcome: "inconclusive",
              reason: "insufficient-evidence",
              evidence: "none",
              note: `Editing fixture needs at least 3x5, measured ${ctx.rows}x${ctx.cols}`,
            },
          }
        }
        ctx.write("\x1b[1;1H")
        ctx.write("\x1b[1;1;3;5;7$t") // DECRARA
        const pos = await ctx.queryCursorPosition()
        return unmeasuredCellResult(pos, "edited cells or attributes")
      },
    ),
    termNeedsGeometry: true,

    termlessObservationEvidence: "parser-state",
  },

  // Consumption alone cannot establish attribute-change extent. A future
  // fixture can compare DECCARA effects or query DECSACE through DECRQSS.
  probe(
    "editing.decsace",
    (ctx) => {
      ctx.feed("\x1b[1;1H\x1b[2*x") // DECSACE select rectangle extent
      const text = ctx.getText()
      return {
        pass: false,
        response: JSON.stringify({ text }),
        note: "Sequence consumption does not measure attribute-change extent",
        observation: { outcome: "inconclusive", evidence: "consumed", reason: "insufficient-evidence" },
      }
    },
    () => {
      const note = "DECSACE was not attempted; this probe does not measure attribute-change extent"
      return Promise.resolve<ProbeResult>({
        pass: false,
        note,
        observation: { outcome: "inconclusive", reason: "insufficient-evidence", evidence: "none", note },
      })
    },
  ),

  probe(
    "editing.decrqcra",
    (ctx) => {
      // DECRQCRA sends a checksum request; the terminal should respond with
      // DCS Pid ! ~ D...D ST where D...D is the hex checksum.
      // Write known content so the checksum is non-trivial.
      ctx.feed("ABCDE\x1b[1;1H")
      return checksumResult(ctx.feedCapture("\x1b[1;1;1;1;1;5*y")) // id, page, top, left, bottom, right
    },
    async (ctx) => {
      // The DA1 follow-up ends the read on a channel the terminal has already
      // answered, so a terminal that never answers is disproved instead of
      // being waited out on a bare timeout. id, page, top, left, bottom, right.
      const reply = await ctx.queryWithSentinelOutcome("\x1b[1;1;1;1;1;1*y", /\x1bP1!~[0-9A-Fa-f]{4}\x1b\\/)
      if (reply.match) return checksumResult(reply.match[0] ?? "")
      return {
        pass: false,
        response: reply.raw,
        note: "No complete checksum reply before the DA1 sentinel",
        observation: {
          outcome: "inconclusive",
          evidence: "query",
          reason: reply.reason === "timeout" ? "timeout" : "no-response",
        },
      }
    },
  ),

  // ── Column Editing Operations ──
  // SL/SR (ECMA-48) and DECIC/DECDC (VT420) horizontally shift or insert/delete
  // columns within the scrolling region.

  // SL — Shift Left (CSI Ps SP @). Shifts all columns left by Ps positions.
  // Content at the left edge is lost; blank columns appear at the right edge.
  {
    ...probe(
      "editing.sl",
      (ctx) => {
        const expected = "SL shifts the first nine observed cells of two rows left by two columns"
        const rows = ctx.getScrollback().screenLines
        if (!Number.isSafeInteger(ctx.cols) || ctx.cols < 9 || !Number.isSafeInteger(rows) || rows < 2) {
          return parserStateResult(null, expected, { cols: ctx.cols, rows }, "Need a measured 2x9 fixture")
        }
        const measuredWidth = Math.min(ctx.cols, 11)
        const seeds = ["ABCDEFGHIJK".slice(0, measuredWidth), "JKLMNOPQRST".slice(0, measuredWidth)]
        ctx.feed(`\x1b[1;1H${seeds[0]}\x1b[2;1H${seeds[1]}`)
        const before = Array.from({ length: 2 }, (_, row) =>
          Array.from({ length: measuredWidth }, (_, col) => ctx.getCell(row, col).char),
        )
        if (!before.every((line, row) => line.every((char, col) => char === seeds[row]?.[col]))) {
          return parserStateResult(null, expected, { before }, "SL seed and incoming sources were not measured")
        }
        ctx.feed("\x1b[1;1H")
        const setup = ctx.getCursor()
        if (setup.x !== 0 || setup.y !== 0) {
          return parserStateResult(null, expected, { before, setup }, "SL cursor setup failed")
        }
        ctx.feed("\x1b[2 @")
        const after = Array.from({ length: 2 }, (_, row) =>
          Array.from({ length: 9 }, (_, col) => ctx.getCell(row, col).char),
        )
        return parserStateResult(
          after.every((line, row) =>
            line.every((char, col) => (col + 2 < ctx.cols ? char === before[row]?.[col + 2] : isBlank(char))),
          ),
          expected,
          { before, setup, after },
        )
      },
      async (ctx) => {
        if (!Number.isSafeInteger(ctx.rows) || !Number.isSafeInteger(ctx.cols) || ctx.rows < 1 || ctx.cols < 8) {
          return {
            pass: false,
            observation: {
              outcome: "inconclusive",
              reason: "insufficient-evidence",
              evidence: "none",
              note: `Editing fixture needs at least 1x8, measured ${ctx.rows}x${ctx.cols}`,
            },
          }
        }
        ctx.write("\x1b[1;1H\x1b[2K")
        ctx.write("1234567")
        ctx.write("\x1b[2 @") // SL 2
        const pos = await ctx.queryCursorPosition()
        return unmeasuredCellResult(pos, "edited cells or attributes")
      },
    ),
    termNeedsGeometry: true,

    termlessObservationEvidence: "parser-state",
  },

  // SR — Shift Right (CSI Ps SP A). Shifts all columns right by Ps positions.
  // Content at the right edge is lost; blank columns appear at the left edge.
  {
    ...probe(
      "editing.sr",
      (ctx) => {
        const expected = "SR shifts the first nine measured cells of two rows right by two columns"
        const rows = ctx.getScrollback().screenLines
        if (!Number.isSafeInteger(ctx.cols) || ctx.cols < 9 || !Number.isSafeInteger(rows) || rows < 2) {
          return parserStateResult(null, expected, { cols: ctx.cols, rows }, "Need a measured 2x9 fixture")
        }
        const seeds = ["ABCDEFGHI", "JKLMNOPQR"]
        ctx.feed("\x1b[1;1HABCDEFGHI\x1b[2;1HJKLMNOPQR")
        const before = Array.from({ length: 2 }, (_, row) =>
          Array.from({ length: 9 }, (_, col) => ctx.getCell(row, col).char),
        )
        if (!before.every((line, row) => line.every((char, col) => char === seeds[row]?.[col]))) {
          return parserStateResult(null, expected, { before }, "SR seed was not measured")
        }
        ctx.feed("\x1b[1;1H")
        const setup = ctx.getCursor()
        if (setup.x !== 0 || setup.y !== 0) {
          return parserStateResult(null, expected, { before, setup }, "SR cursor setup failed")
        }
        ctx.feed("\x1b[2 A")
        const after = Array.from({ length: 2 }, (_, row) =>
          Array.from({ length: 9 }, (_, col) => ctx.getCell(row, col).char),
        )
        return parserStateResult(
          after.every((line, row) =>
            line.every((char, col) => (col < 2 ? isBlank(char) : char === before[row]?.[col - 2])),
          ),
          expected,
          { before, setup, after },
        )
      },
      async (ctx) => {
        if (!Number.isSafeInteger(ctx.rows) || !Number.isSafeInteger(ctx.cols) || ctx.rows < 1 || ctx.cols < 9) {
          return {
            pass: false,
            observation: {
              outcome: "inconclusive",
              reason: "insufficient-evidence",
              evidence: "none",
              note: `Editing fixture needs at least 1x9, measured ${ctx.rows}x${ctx.cols}`,
            },
          }
        }
        ctx.write("\x1b[1;1H\x1b[2K")
        ctx.write("1234567")
        ctx.write("\x1b[2 A") // SR 2
        const pos = await ctx.queryCursorPosition()
        return unmeasuredCellResult(pos, "edited cells or attributes")
      },
    ),
    termNeedsGeometry: true,

    termlessObservationEvidence: "parser-state",
  },

  // DECIC — DEC Insert Column (CSI Ps ' }). Inserts Ps blank columns at the
  // cursor's column position, shifting existing columns right.
  {
    ...probe(
      "editing.decic",
      (ctx) => {
        const expected = "DECIC inserts two blank columns at column 3 on three measured rows"
        const rows = ctx.getScrollback().screenLines
        if (!Number.isSafeInteger(ctx.cols) || ctx.cols < 8 || !Number.isSafeInteger(rows) || rows < 3) {
          return parserStateResult(null, expected, { cols: ctx.cols, rows }, "Need a measured 3x8 fixture")
        }
        const seeds = ["ABCDEFGH", "IJKLMNOP", "QRSTUVWX"]
        ctx.feed("\x1b[1;1HABCDEFGH\x1b[2;1HIJKLMNOP\x1b[3;1HQRSTUVWX")
        const before = Array.from({ length: 3 }, (_, row) =>
          Array.from({ length: 8 }, (_, col) => ctx.getCell(row, col).char),
        )
        if (!before.every((line, row) => line.every((char, col) => char === seeds[row]?.[col]))) {
          return parserStateResult(null, expected, { before }, "DECIC seed was not measured")
        }
        ctx.feed("\x1b[2;3H")
        const setup = ctx.getCursor()
        if (setup.x !== 2 || setup.y !== 1) {
          return parserStateResult(null, expected, { before, setup }, "DECIC cursor setup failed")
        }
        ctx.feed("\x1b[2'}")
        const after = Array.from({ length: 3 }, (_, row) =>
          Array.from({ length: 8 }, (_, col) => ctx.getCell(row, col).char),
        )
        const controlsValid = after.every((line, row) =>
          line.slice(0, 2).every((char, col) => char === before[row]?.[col]),
        )
        return parserStateResult(
          controlsValid
            ? after.every((line, row) =>
                line.every((char, col) => (col < 2 ? true : col < 4 ? isBlank(char) : char === before[row]?.[col - 2])),
              )
            : null,
          expected,
          { before, setup, after },
          controlsValid ? undefined : "DECIC unchanged-prefix control changed",
        )
      },
      async (ctx) => {
        if (!Number.isSafeInteger(ctx.rows) || !Number.isSafeInteger(ctx.cols) || ctx.rows < 3 || ctx.cols < 4) {
          return {
            pass: false,
            observation: {
              outcome: "inconclusive",
              reason: "insufficient-evidence",
              evidence: "none",
              note: `Editing fixture needs at least 3x4, measured ${ctx.rows}x${ctx.cols}`,
            },
          }
        }
        ctx.write("\x1b[3;3H")
        ctx.write("\x1b[2'}") // DECIC 2
        const pos = await ctx.queryCursorPosition()
        return unmeasuredCellResult(pos, "edited cells or attributes")
      },
    ),
    termNeedsGeometry: true,

    termlessObservationEvidence: "parser-state",
  },

  // DECDC — DEC Delete Column (CSI Ps ' ~). Deletes Ps columns at the cursor's
  // column position, shifting remaining columns left. Blank columns fill the right.
  {
    ...probe(
      "editing.decdc",
      (ctx) => {
        const expected = "DECDC deletes two columns at column 3 on three measured rows"
        const rows = ctx.getScrollback().screenLines
        if (!Number.isSafeInteger(ctx.cols) || ctx.cols < 8 || !Number.isSafeInteger(rows) || rows < 3) {
          return parserStateResult(null, expected, { cols: ctx.cols, rows }, "Need a measured 3x8 fixture")
        }
        const measuredWidth = Math.min(ctx.cols, 10)
        const seeds = ["ABCDEFGHIJ", "IJKLMNOPQR", "QRSTUVWXab"].map((line) => line.slice(0, measuredWidth))
        ctx.feed(`\x1b[1;1H${seeds[0]}\x1b[2;1H${seeds[1]}\x1b[3;1H${seeds[2]}`)
        const before = Array.from({ length: 3 }, (_, row) =>
          Array.from({ length: measuredWidth }, (_, col) => ctx.getCell(row, col).char),
        )
        if (!before.every((line, row) => line.every((char, col) => char === seeds[row]?.[col]))) {
          return parserStateResult(null, expected, { before }, "DECDC seed and incoming sources were not measured")
        }
        ctx.feed("\x1b[2;3H")
        const setup = ctx.getCursor()
        if (setup.x !== 2 || setup.y !== 1) {
          return parserStateResult(null, expected, { before, setup }, "DECDC cursor setup failed")
        }
        ctx.feed("\x1b[2'~")
        const after = Array.from({ length: 3 }, (_, row) =>
          Array.from({ length: 8 }, (_, col) => ctx.getCell(row, col).char),
        )
        const controlsValid = after.every((line, row) =>
          line.slice(0, 2).every((char, col) => char === before[row]?.[col]),
        )
        return parserStateResult(
          controlsValid
            ? after.every((line, row) =>
                line.every((char, col) =>
                  col < 2 ? true : col + 2 < ctx.cols ? char === before[row]?.[col + 2] : isBlank(char),
                ),
              )
            : null,
          expected,
          { before, setup, after },
          controlsValid ? undefined : "DECDC unchanged-prefix control changed",
        )
      },
      async (ctx) => {
        if (!Number.isSafeInteger(ctx.rows) || !Number.isSafeInteger(ctx.cols) || ctx.rows < 3 || ctx.cols < 4) {
          return {
            pass: false,
            observation: {
              outcome: "inconclusive",
              reason: "insufficient-evidence",
              evidence: "none",
              note: `Editing fixture needs at least 3x4, measured ${ctx.rows}x${ctx.cols}`,
            },
          }
        }
        ctx.write("\x1b[3;3H")
        ctx.write("\x1b[2'~") // DECDC 2
        const pos = await ctx.queryCursorPosition()
        return unmeasuredCellResult(pos, "edited cells or attributes")
      },
    ),
    termNeedsGeometry: true,

    termlessObservationEvidence: "parser-state",
  },
]
