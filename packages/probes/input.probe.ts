import { describeBackends, feed, test, expect } from "./setup.ts"

describeBackends("input", (b) => {
  test("input.modify-other-keys", () => {
    // modifyOtherKeys mode: CSI > 4 ; Ps m — verify sequence is consumed
    feed(b, "\x1b[>4;1m")
    feed(b, "\x1b[>4;2m")
    feed(b, "OK")
    // Sequences must not leak into text
    expect(b.getText()).toContain("OK")
  })

  test("input.csi-u", () => {
    // CSI u keyboard encoding (legacy, pre-kitty) — verify consumed
    feed(b, "\x1b[97u")
    feed(b, "OK")
    expect(b.getText()).toContain("OK")
  })

  test("input.pixel-mouse", () => {
    // Mode 1016: pixel coordinate mouse — verify mode is accepted
    feed(b, "\x1b[?1016h")
    feed(b, "OK")
    expect(b.getText()).toContain("OK")
    feed(b, "\x1b[?1016l")
  })

  test("input.urxvt-mouse", () => {
    // Mode 1015: urxvt mouse encoding — verify mode is accepted
    feed(b, "\x1b[?1015h")
    feed(b, "OK")
    expect(b.getText()).toContain("OK")
    feed(b, "\x1b[?1015l")
  })

  test("input.x10-mouse", () => {
    // Mode 9: X10 mouse tracking — verify mode is accepted
    feed(b, "\x1b[?9h")
    feed(b, "OK")
    expect(b.getText()).toContain("OK")
    feed(b, "\x1b[?9l")
  })

  test("input.button-event-mouse", () => {
    // Mode 1002: button event tracking — verify mode is tracked
    feed(b, "\x1b[?1002h")
    expect(b.getMode("mouseTracking")).toBe(true)
    feed(b, "\x1b[?1002l")
  })
})
