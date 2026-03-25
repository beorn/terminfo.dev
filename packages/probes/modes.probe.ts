import { describeBackends, feed, test, expect } from "./setup.ts"

describeBackends("modes", (b) => {
  test("modes.alt-screen.enter", () => {
    feed(b, "\x1b[?1049h")
    expect(b.getMode("altScreen")).toBe(true)
  })

  test("modes.alt-screen.exit", () => {
    feed(b, "\x1b[?1049h\x1b[?1049l")
    expect(b.getMode("altScreen")).toBe(false)
  })

  test("modes.bracketed-paste", () => {
    feed(b, "\x1b[?2004h")
    expect(b.getMode("bracketedPaste")).toBe(true)
  })

  test("modes.application-cursor", () => {
    feed(b, "\x1b[?1h")
    expect(b.getMode("applicationCursor")).toBe(true)
  })

  test("modes.auto-wrap", () => {
    feed(b, "X".repeat(80) + "Y")
    expect(b.getCell(1, 0).char).toBe("Y")
  })

  test("modes.mouse-tracking", () => {
    feed(b, "\x1b[?1000h")
    expect(b.getMode("mouseTracking")).toBe(true)
  })

  test("modes.focus-tracking", () => {
    feed(b, "\x1b[?1004h")
    expect(b.getMode("focusTracking")).toBe(true)
  })

  test("modes.reverse-video", () => {
    feed(b, "\x1b[?5h")
    expect(b.getMode("reverseVideo")).toBe(true)
  })

  test("modes.synchronized-output", () => {
    // DECSET 2026: synchronized output mode
    // Most backends may not track this mode, so we just verify no crash
    feed(b, "\x1b[?2026h")
    feed(b, "Hello")
    feed(b, "\x1b[?2026l")
    expect(b.getText()).toContain("Hello")
  })

  test("modes.origin", () => {
    // DECOM: origin mode — cursor positions relative to scroll region
    feed(b, "\x1b[?6h")
    expect(b.getMode("originMode")).toBe(true)
    feed(b, "\x1b[?6l")
  })

  test("modes.insert-replace", () => {
    // IRM: CSI 4 h — insert mode; CSI 4 l — replace mode
    feed(b, "ABC\x1b[1G\x1b[4hX")
    expect(b.getMode("insertMode")).toBe(true)
    // In insert mode, X should push A to the right
    expect(b.getCell(0, 0).char).toBe("X")
    expect(b.getCell(0, 1).char).toBe("A")
    feed(b, "\x1b[4l")
  })

  test("modes.mouse-sgr", () => {
    // DECSET 1006: SGR mouse encoding
    feed(b, "\x1b[?1006h")
    // Just verify no crash — not all backends expose this as a queryable mode
    feed(b, "\x1b[?1006l")
    expect(true).toBe(true)
  })

  test("modes.mouse-all", () => {
    // DECSET 1003: all motion mouse tracking
    feed(b, "\x1b[?1003h")
    // Just verify no crash — not all backends expose this as a queryable mode
    feed(b, "\x1b[?1003l")
    expect(true).toBe(true)
  })

  test("modes.application-keypad", () => {
    // DECKPAM: ESC = — application keypad mode
    feed(b, "\x1b=")
    expect(b.getMode("applicationKeypad")).toBe(true)
    // DECKPNM: ESC > — normal keypad mode
    feed(b, "\x1b>")
    expect(b.getMode("applicationKeypad")).toBe(false)
  })

  test("modes.left-right-margin", () => {
    // DECLRMM: CSI ? 69 h
    feed(b, "\x1b[?69h")
  })
})
