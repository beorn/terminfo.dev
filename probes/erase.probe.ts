import { describeBackends, feed, test, expect } from "./setup.ts"

describeBackends("erase", (b) => {
  test("erase.line.right", () => {
    feed(b, "XXXXX\x1b[1G\x1b[K")
    const c = b.getCell(0, 0).char
    expect(c === "" || c === " ").toBe(true)
  })

  test("erase.line.left", () => {
    feed(b, "XXXXX\x1b[3G\x1b[1K")
    const c = b.getCell(0, 0).char
    expect(c === "" || c === " ").toBe(true)
  })

  test("erase.line.all", () => {
    feed(b, "XXXXX\x1b[2K")
    const c = b.getCell(0, 0).char
    expect(c === "" || c === " ").toBe(true)
  })

  test("erase.screen.below", () => {
    feed(b, "AAA\r\nBBB\r\nCCC\x1b[H\x1b[J")
    expect(b.getText()).not.toContain("BBB")
  })

  test("erase.screen.above", () => {
    feed(b, "AAA\r\nBBB\r\nCCC\x1b[3;2H\x1b[1J")
    // ED 1 erases from cursor to beginning of screen
    const c = b.getCell(0, 0).char
    expect(c === "" || c === " ").toBe(true)
  })

  test("erase.screen.all", () => {
    feed(b, "AAA\r\nBBB\r\nCCC\x1b[2J")
    expect(b.getText().trim()).toBe("")
  })

  test("erase.screen.scrollback", () => {
    // ED 3 erases the scrollback buffer
    for (let i = 0; i < 30; i++) feed(b, `line ${i}\r\n`)
    feed(b, "\x1b[3J")
    const scroll = b.getScrollback()
    expect(scroll.totalLines).toBeLessThanOrEqual(scroll.screenLines)
  })

  test("erase.character", () => {
    // ECH: CSI Pn X — erase Pn characters at cursor, don't move cursor
    feed(b, "ABCDE\x1b[1G\x1b[3X")
    const c0 = b.getCell(0, 0).char
    const c1 = b.getCell(0, 1).char
    const c2 = b.getCell(0, 2).char
    const c3 = b.getCell(0, 3).char
    expect(c0 === "" || c0 === " ").toBe(true)
    expect(c1 === "" || c1 === " ").toBe(true)
    expect(c2 === "" || c2 === " ").toBe(true)
    expect(c3).toBe("D")
  })
})
