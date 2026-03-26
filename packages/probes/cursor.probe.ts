import { describeBackends, feed, feedCapture, test, expect } from "./setup.ts"

describeBackends("cursor", (b) => {
  test("cursor.move.absolute", () => {
    feed(b, "\x1b[5;10H")
    expect(b.getCursor().x).toBe(9)
    expect(b.getCursor().y).toBe(4)
  })

  test("cursor.move.home", () => {
    feed(b, "ABC\x1b[H")
    expect(b.getCursor().x).toBe(0)
    expect(b.getCursor().y).toBe(0)
  })

  test("cursor.move.forward", () => {
    feed(b, "\x1b[5C")
    expect(b.getCursor().x).toBe(5)
  })

  test("cursor.move.back", () => {
    feed(b, "ABC\x1b[2D")
    expect(b.getCursor().x).toBe(1)
  })

  test("cursor.move.down", () => {
    feed(b, "\x1b[3B")
    expect(b.getCursor().y).toBe(3)
  })

  test("cursor.move.up", () => {
    feed(b, "\x1b[5B\x1b[2A")
    expect(b.getCursor().y).toBe(3)
  })

  test("cursor.hide", () => {
    feed(b, "\x1b[?25l")
    expect(b.getCursor().visible).toBe(false)
  })

  test("cursor.shape", () => {
    // DECSCUSR: 0=default, 1=blinking block, 2=steady block, 3=blinking underline, 4=steady underline, 5=blinking beam, 6=steady beam
    feed(b, "\x1b[6 q")
    const style = b.getCursor().style
    expect(style === "beam" || style === null).toBe(true)
  })

  test("cursor.horizontal-absolute", () => {
    // CHA: CSI Pn G — move cursor to column Pn (1-based)
    feed(b, "ABCDE\x1b[3G")
    expect(b.getCursor().x).toBe(2)
  })

  test("cursor.next-line", () => {
    // CNL: CSI Pn E — move cursor to beginning of Pn-th next line
    feed(b, "ABC\x1b[2E")
    expect(b.getCursor().y).toBe(2)
    expect(b.getCursor().x).toBe(0)
  })

  test("cursor.position-report", () => {
    // DSR 6: CSI 6 n — request cursor position report
    feed(b, "\x1b[3;5H")
    const response = feedCapture(b, "\x1b[6n")
    // Response should be CSI 3;5 R (1-based)
    expect(response).toContain("3;5R")
  })

  test("cursor.save-restore", () => {
    feed(b, "AB\x1b7\x1b[5;5H\x1b8")
    expect(b.getCursor().x).toBe(2)
    expect(b.getCursor().y).toBe(0)
  })

  test("cursor.reverse-wrap", () => {
    // Reverse wrap mode: CSI ? 45 h — verify sequence is consumed without corruption
    feed(b, "\x1b[?45h")
    feed(b, "OK")
    expect(b.getText()).toContain("OK")
    feed(b, "\x1b[?45l")
  })

  test("cursor.cup-boundaries", () => {
    // CUP with huge row/col — should clamp to screen edges
    feed(b, "\x1b[999;999H")
    expect(b.getCursor().y).toBe(23) // last row (0-based, 24-row terminal)
    expect(b.getCursor().x).toBe(79) // last col (0-based, 80-col terminal)
  })

  test("cursor.cuu-past-top", () => {
    // CUU with huge count from row 3 — should stop at row 0
    feed(b, "\x1b[4;1H") // position at row 3 (1-based row 4)
    feed(b, "\x1b[999A") // CUU past top
    expect(b.getCursor().y).toBe(0)
  })

  test("cursor.cud-past-bottom", () => {
    // CUD with huge count from row 0 — should stop at last row
    feed(b, "\x1b[1;1H") // position at row 0
    feed(b, "\x1b[999B") // CUD past bottom
    expect(b.getCursor().y).toBe(23)
  })

  test("cursor.cup-scroll-region", () => {
    // CUP with DECSTBM + DECOM — cursor relative to scroll region
    feed(b, "\x1b[5;15r") // scroll region rows 5-15
    feed(b, "\x1b[?6h") // enable DECOM (origin mode)
    feed(b, "\x1b[1;1H") // CUP 1;1 — should map to scroll region top
    expect(b.getCursor().y).toBe(4) // row 4 (0-based) = scroll region top
    expect(b.getCursor().x).toBe(0)
    feed(b, "\x1b[?6l") // disable DECOM
    feed(b, "\x1b[r") // reset scroll region
  })
})
