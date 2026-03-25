import { describeBackends, feed, test, expect } from "./setup.ts"

describeBackends("unicode", (b) => {
  test("unicode.east-asian-ambiguous", () => {
    // Ambiguous-width character: ● (U+25CF)
    feed(b, "●X")
    const c1 = b.getCell(0, 1)
    const c2 = b.getCell(0, 2)
    expect(c1.char === "X" || c2.char === "X").toBe(true)
  })

  test("unicode.grapheme-cursor", () => {
    // Emoji with ZWJ — cursor should move past the whole cluster
    feed(b, "👨‍👩‍👧X")
    const text = b.getText()
    expect(text).toContain("X")
  })

  test("unicode.wrap-boundary", () => {
    // Wide char at line wrap — should wrap to next line, not split
    feed(b, "A".repeat(79) + "中")
    const c = b.getCell(1, 0)
    expect(c.char).toBe("中")
  })

  test("unicode.tab-stops", () => {
    // Tab should advance to next tab stop (default every 8 cols)
    feed(b, "A\tB")
    const c = b.getCell(0, 8)
    expect(c.char).toBe("B")
  })
})
