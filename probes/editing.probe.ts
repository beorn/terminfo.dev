import { describeBackends, feed, test, expect } from "./setup.ts"

describeBackends("editing", (b) => {
  test("editing.insert-chars", () => {
    // ICH: CSI Pn @ — insert Pn blank characters at cursor
    feed(b, "ABCDE\x1b[1G\x1b[2@")
    // Two blanks inserted at column 0, pushing ABCDE right
    const c0 = b.getCell(0, 0).char
    const c1 = b.getCell(0, 1).char
    expect(c0 === "" || c0 === " ").toBe(true)
    expect(c1 === "" || c1 === " ").toBe(true)
    expect(b.getCell(0, 2).char).toBe("A")
    expect(b.getCell(0, 3).char).toBe("B")
  })

  test("editing.delete-chars", () => {
    // DCH: CSI Pn P — delete Pn characters at cursor
    feed(b, "ABCDE\x1b[1G\x1b[2P")
    // Two chars deleted at column 0, CDE shifts left
    expect(b.getCell(0, 0).char).toBe("C")
    expect(b.getCell(0, 1).char).toBe("D")
    expect(b.getCell(0, 2).char).toBe("E")
  })

  test("editing.insert-lines", () => {
    // IL: CSI Pn L — insert Pn blank lines at cursor row
    feed(b, "LINE1\r\nLINE2\r\nLINE3\x1b[2;1H\x1b[1L")
    // Blank line inserted at row 1, LINE2 pushed to row 2
    const r1 = b.getCell(1, 0).char
    expect(r1 === "" || r1 === " ").toBe(true)
    expect(b.getCell(2, 0).char).toBe("L")
  })

  test("editing.delete-lines", () => {
    // DL: CSI Pn M — delete Pn lines at cursor row
    feed(b, "LINE1\r\nLINE2\r\nLINE3\x1b[2;1H\x1b[1M")
    // LINE2 deleted, LINE3 moves up to row 1
    expect(b.getCell(1, 0).char).toBe("L")
    // Verify it's LINE3 not LINE2
    expect(b.getCell(1, 4).char).toBe("3")
  })

  test("editing.repeat-char", () => {
    // REP: CSI Pn b — repeat the preceding character Pn times
    feed(b, "X\x1b[4b")
    // Should produce XXXXX (1 original + 4 repeats)
    expect(b.getCell(0, 0).char).toBe("X")
    expect(b.getCell(0, 1).char).toBe("X")
    expect(b.getCell(0, 4).char).toBe("X")
  })
})
