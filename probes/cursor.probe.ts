import { describeBackends, feed, test, expect } from "./setup.ts"

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
    // Backend should generate a response: CSI row ; col R
    let response = ""
    const prevHandler = b.onResponse
    b.onResponse = (data) => {
      response += new TextDecoder().decode(data)
    }
    feed(b, "\x1b[3;5H")
    feed(b, "\x1b[6n")
    b.onResponse = prevHandler
    // Response should be CSI 3;5 R (1-based)
    expect(response).toContain("3;5R")
  })

  test("cursor.save-restore", () => {
    feed(b, "AB\x1b7\x1b[5;5H\x1b8")
    expect(b.getCursor().x).toBe(2)
    expect(b.getCursor().y).toBe(0)
  })
})
