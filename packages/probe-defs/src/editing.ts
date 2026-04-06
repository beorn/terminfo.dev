import type { ProbeDefinition } from "./types.ts"
import { probe, isBlank } from "./helpers.ts"

export const editingProbes: ProbeDefinition[] = [
  probe(
    "editing.insert-chars",
    (ctx) => {
      ctx.feed("ABCDE\x1b[1G\x1b[2@")
      return {
        pass:
          isBlank(ctx.getCell(0, 0).char) &&
          isBlank(ctx.getCell(0, 1).char) &&
          ctx.getCell(0, 2).char === "A" &&
          ctx.getCell(0, 3).char === "B",
      }
    },
    async (ctx) => {
      ctx.write("\x1b[1;1H\x1b[2K") // Clear line
      ctx.write("ABCD")
      ctx.write("\x1b[1;2H") // Move to col 2
      ctx.write("\x1b[1@") // ICH 1
      const pos = await ctx.queryCursorPosition()
      if (!pos) return { pass: false, note: "No cursor response" }
      return {
        pass: pos.col === 2,
        note: pos.col === 2 ? undefined : `cursor at col ${pos.col}, expected 2`,
      }
    },
  ),

  probe(
    "editing.delete-chars",
    (ctx) => {
      ctx.feed("ABCDE\x1b[1G\x1b[2P")
      return {
        pass: ctx.getCell(0, 0).char === "C" && ctx.getCell(0, 1).char === "D" && ctx.getCell(0, 2).char === "E",
      }
    },
    async (ctx) => {
      ctx.write("\x1b[1;1H\x1b[2K") // Clear line
      ctx.write("ABCD")
      ctx.write("\x1b[1;2H") // Move to col 2
      ctx.write("\x1b[1P") // DCH 1
      const pos = await ctx.queryCursorPosition()
      if (!pos) return { pass: false, note: "No cursor response" }
      return {
        pass: pos.col === 2,
        note: pos.col === 2 ? undefined : `cursor at col ${pos.col}, expected 2`,
      }
    },
  ),

  probe(
    "editing.insert-lines",
    (ctx) => {
      ctx.feed("LINE1\r\nLINE2\r\nLINE3\x1b[2;1H\x1b[1L")
      const r1 = ctx.getCell(1, 0).char
      return { pass: isBlank(r1) && ctx.getCell(2, 0).char === "L" }
    },
    async (ctx) => {
      ctx.write("\x1b[3;5H") // Move to row 3, col 5
      ctx.write("\x1b[1L") // IL 1
      const pos = await ctx.queryCursorPosition()
      if (!pos) return { pass: false, note: "No cursor response" }
      return {
        pass: pos.row === 3,
        note: pos.row === 3 ? undefined : `cursor at row ${pos.row}, expected 3`,
      }
    },
  ),

  probe(
    "editing.delete-lines",
    (ctx) => {
      ctx.feed("LINE1\r\nLINE2\r\nLINE3\x1b[2;1H\x1b[1M")
      return { pass: ctx.getCell(1, 0).char === "L" && ctx.getCell(1, 4).char === "3" }
    },
    async (ctx) => {
      ctx.write("\x1b[3;5H") // Move to row 3, col 5
      ctx.write("\x1b[1M") // DL 1
      const pos = await ctx.queryCursorPosition()
      if (!pos) return { pass: false, note: "No cursor response" }
      return {
        pass: pos.row === 3,
        note: pos.row === 3 ? undefined : `cursor at row ${pos.row}, expected 3`,
      }
    },
  ),

  probe(
    "editing.repeat-char",
    (ctx) => {
      ctx.feed("X\x1b[4b")
      return {
        pass: ctx.getCell(0, 0).char === "X" && ctx.getCell(0, 1).char === "X" && ctx.getCell(0, 4).char === "X",
      }
    },
    async (ctx) => {
      ctx.write("\x1b[1;1H\x1b[2K") // clear line
      ctx.write("X") // write X (cursor at col 2)
      ctx.write("\x1b[4b") // REP 4
      const pos = await ctx.queryCursorPosition()
      if (!pos) return { pass: false, note: "No cursor response" }
      return {
        pass: pos.col === 6,
        note: pos.col === 6 ? undefined : `cursor at col ${pos.col}, expected 6`,
      }
    },
  ),

  // ── VT420 Rectangular Area Operations (1990) ──

  probe(
    "editing.decfra",
    (ctx) => {
      // DECFRA: fill rows 1-3, cols 1-5 with 'X' (88 = ASCII 'X')
      ctx.feed("\x1b[88;1;1;3;5$x")
      // Verify every cell in the 3×5 rectangle contains 'X'
      for (let row = 0; row < 3; row++) {
        for (let col = 0; col < 5; col++) {
          if (ctx.getCell(row, col).char !== "X") {
            return { pass: false, note: `cell(${row},${col})="${ctx.getCell(row, col).char}", expected "X"` }
          }
        }
      }
      return { pass: true }
    },
    async (ctx) => {
      ctx.write("\x1b[1;1H")
      ctx.write("\x1b[88;1;1;3;5$x") // DECFRA fill 'X'
      const pos = await ctx.queryCursorPosition()
      return {
        pass: pos !== null,
        note: pos ? "sequence consumed" : "no cursor response",
      }
    },
  ),

  probe(
    "editing.decera",
    (ctx) => {
      // Write text first, then erase a rectangle
      ctx.feed("AAAAA\r\nBBBBB\r\nCCCCC\x1b[1;1H")
      ctx.feed("\x1b[1;1;3;5$z") // DECERA rows 1-3 cols 1-5
      // Verify every cell in the 3×5 rectangle is blank
      for (let row = 0; row < 3; row++) {
        for (let col = 0; col < 5; col++) {
          if (!isBlank(ctx.getCell(row, col).char)) {
            return { pass: false, note: `cell(${row},${col})="${ctx.getCell(row, col).char}", expected blank` }
          }
        }
      }
      return { pass: true }
    },
    async (ctx) => {
      ctx.write("\x1b[1;1H")
      ctx.write("\x1b[1;1;3;5$z") // DECERA
      const pos = await ctx.queryCursorPosition()
      return {
        pass: pos !== null,
        note: pos ? "sequence consumed" : "no cursor response",
      }
    },
  ),

  probe(
    "editing.decsera",
    (ctx) => {
      // DECSERA selectively erases unprotected characters in a rectangle.
      // Write text, then selective-erase — without DECSCA protection, all chars
      // should be erased (same as DECERA for unprotected content).
      ctx.feed("AAAAA\r\nBBBBB\r\nCCCCC\x1b[1;1H")
      ctx.feed("\x1b[1;1;3;5${") // DECSERA rows 1-3 cols 1-5
      // Verify all cells erased (none are protected)
      for (let row = 0; row < 3; row++) {
        for (let col = 0; col < 5; col++) {
          if (!isBlank(ctx.getCell(row, col).char)) {
            return { pass: false, note: `cell(${row},${col})="${ctx.getCell(row, col).char}", expected blank` }
          }
        }
      }
      return { pass: true }
    },
    async (ctx) => {
      ctx.write("\x1b[1;1H")
      ctx.write("\x1b[1;1;3;5${") // DECSERA
      const pos = await ctx.queryCursorPosition()
      return {
        pass: pos !== null,
        note: pos ? "sequence consumed" : "no cursor response",
      }
    },
  ),

  probe(
    "editing.deccra",
    (ctx) => {
      // Write "HELLO" at row 1, then copy row 1 cols 1-5 to row 3 col 1
      // DECCRA params: Pts;Pls;Pbs;Prs;Pps;Ptd;Pld;Ppd $v
      //   source: top=1, left=1, bottom=1, right=5, page=1
      //   dest:   top=3, left=1, page=1
      ctx.feed("HELLO\x1b[1;1H")
      ctx.feed("\x1b[1;1;1;5;1;3;1;1$v") // DECCRA: copy row1 cols1-5 → row3 col1
      // Verify source row (row 0) still has "HELLO"
      const srcOk =
        ctx.getCell(0, 0).char === "H" &&
        ctx.getCell(0, 1).char === "E" &&
        ctx.getCell(0, 2).char === "L" &&
        ctx.getCell(0, 3).char === "L" &&
        ctx.getCell(0, 4).char === "O"
      // Verify destination row (row 2) has "HELLO"
      const dstOk =
        ctx.getCell(2, 0).char === "H" &&
        ctx.getCell(2, 1).char === "E" &&
        ctx.getCell(2, 2).char === "L" &&
        ctx.getCell(2, 3).char === "L" &&
        ctx.getCell(2, 4).char === "O"
      if (!srcOk) return { pass: false, note: "source row corrupted after copy" }
      if (!dstOk) {
        const got = [0, 1, 2, 3, 4].map((c) => ctx.getCell(2, c).char).join("")
        return { pass: false, note: `dest row="${got}", expected "HELLO"` }
      }
      return { pass: true }
    },
    async (ctx) => {
      ctx.write("\x1b[1;1H")
      ctx.write("\x1b[1;1;2;5;1;5;10$v") // DECCRA
      const pos = await ctx.queryCursorPosition()
      return {
        pass: pos !== null,
        note: pos ? "sequence consumed" : "no cursor response",
      }
    },
  ),

  probe(
    "editing.deccara",
    (ctx) => {
      // Write text, then apply inverse (SGR 7) to a rectangle via DECCARA
      ctx.feed("AAAAA\r\nBBBBB\r\nCCCCC\x1b[1;1H")
      ctx.feed("\x1b[1;1;3;5;7$r") // DECCARA: apply inverse to rows 1-3 cols 1-5
      // Verify cells in the rectangle have inverse set
      for (let row = 0; row < 3; row++) {
        for (let col = 0; col < 5; col++) {
          if (!ctx.getCell(row, col).inverse) {
            return { pass: false, note: `cell(${row},${col}).inverse=false, expected true` }
          }
        }
      }
      return { pass: true }
    },
    async (ctx) => {
      ctx.write("\x1b[1;1H")
      ctx.write("\x1b[1;1;3;5;7$r") // DECCARA
      const pos = await ctx.queryCursorPosition()
      return {
        pass: pos !== null,
        note: pos ? "sequence consumed" : "no cursor response",
      }
    },
  ),

  probe(
    "editing.decrara",
    (ctx) => {
      // Write text with inverse attr, then toggle inverse via DECRARA
      // First: write text with inverse on
      ctx.feed("\x1b[7mAAAAA\x1b[0m\r\n\x1b[7mBBBBB\x1b[0m\r\n\x1b[7mCCCCC\x1b[0m\x1b[1;1H")
      // Verify inverse is set before toggle
      if (!ctx.getCell(0, 0).inverse) {
        return { pass: false, note: "pre-condition: inverse not set on cell(0,0)" }
      }
      ctx.feed("\x1b[1;1;3;5;7$t") // DECRARA: toggle inverse on rows 1-3 cols 1-5
      // After toggling, inverse should now be off
      for (let row = 0; row < 3; row++) {
        for (let col = 0; col < 5; col++) {
          if (ctx.getCell(row, col).inverse) {
            return { pass: false, note: `cell(${row},${col}).inverse=true after toggle, expected false` }
          }
        }
      }
      return { pass: true }
    },
    async (ctx) => {
      ctx.write("\x1b[1;1H")
      ctx.write("\x1b[1;1;3;5;7$t") // DECRARA
      const pos = await ctx.queryCursorPosition()
      return {
        pass: pos !== null,
        note: pos ? "sequence consumed" : "no cursor response",
      }
    },
  ),

  // DECSACE sets the attribute-change extent mode (rectangle vs stream) for
  // DECCARA/DECRARA. It's a pure mode-set with no query mechanism — there's no
  // DECRPM equivalent, no response, and no observable cell-state change. The only
  // way to verify it would be to run a DECCARA after setting each mode and compare
  // results, but that tests DECCARA+DECSACE jointly, not DECSACE alone. Keeping
  // this probe partial: we verify the sequence is consumed without literal leak.
  probe(
    "editing.decsace",
    (ctx) => {
      ctx.feed("\x1b[1;1H\x1b[2*x") // DECSACE select rectangle extent
      const text = ctx.getText()
      const noLeak = !text.includes("*x")
      return {
        pass: noLeak,
        note: noLeak ? "sequence consumed" : "literal leak detected",
      }
    },
    async (ctx) => {
      ctx.write("\x1b[1;1H")
      ctx.write("\x1b[2*x") // DECSACE
      const pos = await ctx.queryCursorPosition()
      return {
        pass: pos !== null,
        note: pos ? "sequence consumed" : "no cursor response",
      }
    },
  ),

  probe(
    "editing.decrqcra",
    (ctx) => {
      // DECRQCRA sends a checksum request; the terminal should respond with
      // DCS Pid ! ~ D...D ST where D...D is the hex checksum.
      // Write known content so the checksum is non-trivial.
      ctx.feed("ABCDE\x1b[1;1H")
      const response = ctx.feedCapture("\x1b[1;1;1;1;5*y") // Pid=1, page=1, row 1 cols 1-5
      // Response format: DCS Pid ! ~ xxxx ST  (xxxx = hex digits)
      const match = /\x1bP(\d+)!~([0-9A-Fa-f]+)\x1b\\/.test(response)
      return {
        pass: match,
        note: match ? undefined : `response: ${JSON.stringify(response)}`,
        response,
      }
    },
    async (ctx) => {
      // Query checksum of cell 1,1
      const result = await ctx.query("\x1b[1;1;1;1;1;1*y", /\x1bP(\d+)!~([0-9A-Fa-f]+)\x1b\\/, 2000)
      return {
        pass: result !== null,
        note: result ? "checksum response received" : "no DECRQCRA response",
        response: result ? result[0] : undefined,
      }
    },
  ),

  // ── Column Editing Operations ──
  // SL/SR (ECMA-48) and DECIC/DECDC (VT420) horizontally shift or insert/delete
  // columns within the scrolling region.

  // SL — Shift Left (CSI Ps SP @). Shifts all columns left by Ps positions.
  // Content at the left edge is lost; blank columns appear at the right edge.
  probe(
    "editing.sl",
    (ctx) => {
      // Write "1234567" at row 1, then SL 2 — shifts all columns left by 2.
      // Result: col 0 should have '3', col 1 '4', col 2 '5', etc.
      // Cols at the right edge should be blank.
      ctx.feed("\x1b[1;1H\x1b[2K1234567")
      ctx.feed("\x1b[2 @") // SL 2 — note literal space before @
      const c0 = ctx.getCell(0, 0).char
      const c1 = ctx.getCell(0, 1).char
      const c2 = ctx.getCell(0, 2).char
      const c3 = ctx.getCell(0, 3).char
      const c4 = ctx.getCell(0, 4).char
      // After shifting left by 2: "1234567" → "34567  " (blanks at cols 5-6)
      const shifted = c0 === "3" && c1 === "4" && c2 === "5" && c3 === "6" && c4 === "7"
      if (!shifted) {
        const got = [c0, c1, c2, c3, c4].join("")
        return { pass: false, note: `got "${got}", expected "34567"` }
      }
      // Right edge should be blank
      if (!isBlank(ctx.getCell(0, 5).char) || !isBlank(ctx.getCell(0, 6).char)) {
        return { pass: false, note: "right edge not blank after shift left" }
      }
      return { pass: true }
    },
    async (ctx) => {
      ctx.write("\x1b[1;1H\x1b[2K")
      ctx.write("1234567")
      ctx.write("\x1b[2 @") // SL 2
      const pos = await ctx.queryCursorPosition()
      return {
        pass: pos !== null,
        note: pos ? "sequence consumed" : "no cursor response",
      }
    },
  ),

  // SR — Shift Right (CSI Ps SP A). Shifts all columns right by Ps positions.
  // Content at the right edge is lost; blank columns appear at the left edge.
  probe(
    "editing.sr",
    (ctx) => {
      ctx.feed("\x1b[1;1H\x1b[2K1234567")
      ctx.feed("\x1b[2 A") // SR 2 — note literal space before A
      // After shifting right by 2: "1234567" → "  1234567" (first 2 cols blank)
      // but the terminal width truncates at the right edge.
      const c0 = ctx.getCell(0, 0).char
      const c1 = ctx.getCell(0, 1).char
      const c2 = ctx.getCell(0, 2).char
      const c3 = ctx.getCell(0, 3).char
      // First 2 cols should be blank, then "12345..."
      const blanks = isBlank(c0) && isBlank(c1)
      const shifted = c2 === "1" && c3 === "2"
      if (!blanks) return { pass: false, note: `cols 0-1 not blank: "${c0}${c1}"` }
      if (!shifted) return { pass: false, note: `cols 2-3 expected "12", got "${c2}${c3}"` }
      return { pass: true }
    },
    async (ctx) => {
      ctx.write("\x1b[1;1H\x1b[2K")
      ctx.write("1234567")
      ctx.write("\x1b[2 A") // SR 2
      const pos = await ctx.queryCursorPosition()
      return {
        pass: pos !== null,
        note: pos ? "sequence consumed" : "no cursor response",
      }
    },
  ),

  // DECIC — DEC Insert Column (CSI Ps ' }). Inserts Ps blank columns at the
  // cursor's column position, shifting existing columns right.
  probe(
    "editing.decic",
    (ctx) => {
      // Write "ABCDE" on rows 1-2, position cursor at row 1 col 3, insert 2 cols.
      // Row 1: "ABCDE" → after DECIC 2 at col 3: "AB  CDE" (C,D,E shifted right)
      ctx.feed("ABCDE\r\nABCDE\x1b[1;3H")
      ctx.feed("\x1b[2'}") // DECIC 2 at col 3
      // Row 0: cols 0-1 = "AB", cols 2-3 = blank (inserted), cols 4-5 = "CD"
      const r0c0 = ctx.getCell(0, 0).char
      const r0c1 = ctx.getCell(0, 1).char
      const r0c2 = ctx.getCell(0, 2).char
      const r0c3 = ctx.getCell(0, 3).char
      const r0c4 = ctx.getCell(0, 4).char
      if (r0c0 !== "A" || r0c1 !== "B") {
        return { pass: false, note: `cols 0-1 expected "AB", got "${r0c0}${r0c1}"` }
      }
      if (!isBlank(r0c2) || !isBlank(r0c3)) {
        return { pass: false, note: `inserted cols 2-3 not blank: "${r0c2}${r0c3}"` }
      }
      if (r0c4 !== "C") {
        return { pass: false, note: `col 4 expected "C", got "${r0c4}"` }
      }
      // DECIC is a column operation — it affects ALL rows, so verify row 2 as well
      const r1c2 = ctx.getCell(1, 2).char
      const r1c4 = ctx.getCell(1, 4).char
      if (!isBlank(r1c2)) {
        return { pass: false, note: `row 1 col 2 not blank: "${r1c2}"` }
      }
      if (r1c4 !== "C") {
        return { pass: false, note: `row 1 col 4 expected "C", got "${r1c4}"` }
      }
      return { pass: true }
    },
    async (ctx) => {
      ctx.write("\x1b[3;3H")
      ctx.write("\x1b[2'}") // DECIC 2
      const pos = await ctx.queryCursorPosition()
      return {
        pass: pos !== null,
        note: pos ? "sequence consumed" : "no cursor response",
      }
    },
  ),

  // DECDC — DEC Delete Column (CSI Ps ' ~). Deletes Ps columns at the cursor's
  // column position, shifting remaining columns left. Blank columns fill the right.
  probe(
    "editing.decdc",
    (ctx) => {
      // Write "ABCDE" on rows 1-2, position cursor at row 1 col 2, delete 2 cols.
      // Row 1: "ABCDE" → after DECDC 2 at col 2: "ADE  " (B,C deleted, D,E shift left)
      ctx.feed("ABCDE\r\nABCDE\x1b[1;2H")
      ctx.feed("\x1b[2'~") // DECDC 2 at col 2
      // Row 0: col 0 = "A", col 1 = "D", col 2 = "E", cols 3-4 = blank
      const r0c0 = ctx.getCell(0, 0).char
      const r0c1 = ctx.getCell(0, 1).char
      const r0c2 = ctx.getCell(0, 2).char
      if (r0c0 !== "A") return { pass: false, note: `col 0 expected "A", got "${r0c0}"` }
      if (r0c1 !== "D") return { pass: false, note: `col 1 expected "D", got "${r0c1}"` }
      if (r0c2 !== "E") return { pass: false, note: `col 2 expected "E", got "${r0c2}"` }
      if (!isBlank(ctx.getCell(0, 3).char) || !isBlank(ctx.getCell(0, 4).char)) {
        return { pass: false, note: "right edge not blank after column delete" }
      }
      // DECDC is a column operation — verify row 2 as well
      const r1c1 = ctx.getCell(1, 1).char
      if (r1c1 !== "D") {
        return { pass: false, note: `row 1 col 1 expected "D", got "${r1c1}"` }
      }
      return { pass: true }
    },
    async (ctx) => {
      ctx.write("\x1b[3;3H")
      ctx.write("\x1b[2'~") // DECDC 2
      const pos = await ctx.queryCursorPosition()
      return {
        pass: pos !== null,
        note: pos ? "sequence consumed" : "no cursor response",
      }
    },
  ),
]
