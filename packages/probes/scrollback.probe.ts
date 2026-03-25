import { describeBackends, feed, test, expect } from "./setup.ts"

describeBackends("scrollback", (b) => {
  test("scrollback.accumulate", () => {
    for (let i = 0; i < 30; i++) feed(b, `line ${i}\r\n`)
    expect(b.getScrollback().totalLines).toBeGreaterThan(24)
  })

  test("scrollback.total-lines", () => {
    for (let i = 0; i < 30; i++) feed(b, `line ${i}\r\n`)
    expect(b.getScrollback().totalLines).toBeGreaterThanOrEqual(30)
  })

  test("scrollback.scroll-up", () => {
    feed(b, "TOP\r\n")
    for (let i = 0; i < 23; i++) feed(b, `line\r\n`)
    feed(b, "\x1b[S")
    expect(b.getCell(0, 0).char).not.toBe("T")
  })

  test("scrollback.reverse-index", () => {
    feed(b, "A\r\nB\r\nC")
    feed(b, "\x1b[H\x1bM")
    const c = b.getCell(0, 0).char
    expect(c === "" || c === " ").toBe(true)
  })

  test("scrollback.scroll-down", () => {
    // SD: CSI Pn T — scroll down (insert blank lines at top)
    feed(b, "LINE1\r\nLINE2\r\nLINE3")
    feed(b, "\x1b[T")
    // After scroll down, LINE1 should have moved down
    const c = b.getCell(0, 0).char
    expect(c === "" || c === " ").toBe(true)
  })

  test("scrollback.set-region", () => {
    // DECSTBM: CSI top ; bottom r — set scrolling region
    feed(b, "\x1b[5;10r")
    // After setting scroll region, cursor should be at home
    expect(b.getCursor().x).toBe(0)
    expect(b.getCursor().y).toBe(0)
    // Reset scroll region
    feed(b, "\x1b[r")
  })

  test("scrollback.alt-screen", () => {
    feed(b, "NORMAL")
    feed(b, "\x1b[?1049h")
    expect(b.getMode("altScreen")).toBe(true)
  })

  test("scrollback.decstbm", () => {
    // DECSTBM constrains scrolling — text above scroll region should not move
    feed(b, "FIXED_TOP\r\n")
    feed(b, "\x1b[3;10r") // scroll region rows 3-10
    feed(b, "\x1b[3;1H") // move inside region
    for (let i = 0; i < 20; i++) feed(b, `scroll-${i}\r\n`)
    // Row 0 should still have FIXED_TOP
    expect(b.getCell(0, 0).char).toBe("F")
    feed(b, "\x1b[r") // reset
  })

  test("scrollback.decstbm-reset", () => {
    // DECSTBM with no params resets to full screen scrolling
    feed(b, "\x1b[5;10r") // set scroll region
    feed(b, "\x1b[r") // reset to full screen
    feed(b, "\x1b[H") // home
    for (let i = 0; i < 30; i++) feed(b, `line-${i}\r\n`)
    // Full-screen scrolling should work — totalLines > screen
    expect(b.getScrollback().totalLines).toBeGreaterThan(24)
  })
})
