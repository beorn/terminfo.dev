import { describeBackends, feed, test, expect } from "./setup.ts"

describeBackends("text", (b) => {
  test("text.basic", () => {
    feed(b, "Hello")
    expect(b.getText()).toContain("Hello")
  })

  test("text.newline", () => {
    feed(b, "A\r\nB")
    expect(b.getCell(0, 0).char).toBe("A")
    expect(b.getCell(1, 0).char).toBe("B")
  })

  test("text.wrap", () => {
    feed(b, "X".repeat(85))
    expect(b.getCell(1, 0).char).toBe("X")
  })

  test("text.tab", () => {
    feed(b, "\tX")
    expect(b.getCell(0, 8).char).toBe("X")
  })

  test("text.wide.emoji", () => {
    feed(b, "\u{1f389}")
    expect(b.getCell(0, 0).wide).toBe(true)
  })

  test("text.wide.cjk", () => {
    feed(b, "\u4e2d")
    expect(b.getCell(0, 0).wide).toBe(true)
  })

  test("text.overwrite", () => {
    feed(b, "AB\x1b[1GC")
    expect(b.getCell(0, 0).char).toBe("C")
  })

  test("text.cr", () => {
    feed(b, "AB\rC")
    expect(b.getCell(0, 0).char).toBe("C")
    expect(b.getCell(0, 1).char).toBe("B")
  })

  test("text.backspace", () => {
    feed(b, "AB\x08C")
    // Backspace moves cursor back one column, then C overwrites B
    expect(b.getCell(0, 0).char).toBe("A")
    expect(b.getCell(0, 1).char).toBe("C")
  })

  test("text.index", () => {
    // IND: ESC D — moves cursor down one line, scrolling if at bottom
    feed(b, "A\x1bD")
    expect(b.getCursor().y).toBe(1)
  })

  test("text.next-line", () => {
    // NEL: ESC E — moves cursor to beginning of next line
    feed(b, "ABC\x1bE")
    expect(b.getCursor().y).toBe(1)
    expect(b.getCursor().x).toBe(0)
  })

  test("text.reverse-index-scroll", () => {
    // RI at top of scroll region should scroll down
    feed(b, "\x1b[1;5r") // Set scroll region to lines 1-5
    feed(b, "\x1b[H") // Move to top
    feed(b, "\x1bM") // Reverse index
  })

  test("text.combining", () => {
    // Combining character: e + combining acute accent
    feed(b, "e\u0301X")
    // The combining char shouldn't take its own cell
    const c = b.getCell(0, 1)
    expect(c.char).toBe("X")
  })

  test("text.wide.emoji-flags", () => {
    // Regional indicator pair: US flag
    feed(b, "\u{1F1FA}\u{1F1F8}X")
    // Flag should be 2 cells wide
    expect(b.getCell(0, 0).wide).toBe(true)
  })

  test("text.wide.emoji-vs16", () => {
    // Variation selector 16 forces emoji presentation (2 cells)
    feed(b, "\u263A\uFE0FX")
    expect(b.getCell(0, 0).wide).toBe(true)
  })

  test("text.wide.emoji-zwj", () => {
    // ZWJ sequence: family emoji
    feed(b, "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}X")
    const text = b.getText()
    expect(text).toContain("X")
  })
})
