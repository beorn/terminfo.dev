import { describeBackends, feed, test, expect } from "./setup.ts"

describeBackends("charsets", (b) => {
  test("charsets.dec-special", () => {
    // ESC ( 0 — switch to DEC Special Graphics character set
    // In this set, 'q' maps to horizontal line (U+2500), 'x' to vertical line (U+2502)
    feed(b, "\x1b(0q\x1b(B")
    const cell = b.getCell(0, 0)
    // Should render as box-drawing character, not literal 'q'
    expect(cell.char).not.toBe("q")
  })

  test("charsets.utf8", () => {
    // UTF-8 multi-byte characters should render correctly
    // U+00E9 = e-acute (2 bytes in UTF-8)
    // U+4E16 = CJK character (3 bytes in UTF-8)
    feed(b, "\u00e9")
    expect(b.getCell(0, 0).char).toBe("\u00e9")
    // Also test a 3-byte character
    feed(b, "\x1b[1G\u4e16")
    expect(b.getCell(0, 0).char).toBe("\u4e16")
  })

  test("charsets.g0-g1-switching", () => {
    // ESC(0 designates G0 as DEC Special Graphics
    // 'l' in DEC Special should render as ┌ (top-left corner), not literal 'l'
    feed(b, "\x1b(0") // switch to DEC Special
    feed(b, "l") // should be ┌
    feed(b, "\x1b(B") // back to ASCII
    expect(b.getCell(0, 0).char).not.toBe("l")
  })

  test("charsets.dec-line-drawing", () => {
    // Full DEC Special Graphics box-drawing character set
    feed(b, "\x1b(0") // DEC Special Graphics
    feed(b, "jklmqx") // ┘┐┌└─│
    feed(b, "\x1b(B") // back to ASCII
    // None should be the literal ASCII character
    expect(b.getCell(0, 0).char).not.toBe("j") // ┘
    expect(b.getCell(0, 1).char).not.toBe("k") // ┐
    expect(b.getCell(0, 2).char).not.toBe("l") // ┌
    expect(b.getCell(0, 3).char).not.toBe("m") // └
    expect(b.getCell(0, 4).char).not.toBe("q") // ─
    expect(b.getCell(0, 5).char).not.toBe("x") // │
  })
})
