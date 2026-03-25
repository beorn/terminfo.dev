import { describeBackends, feed, test, expect } from "./setup.ts"

describeBackends("input", (b) => {
  test("input.modify-other-keys", () => {
    // modifyOtherKeys mode: CSI > 4 ; Ps m
    feed(b, "\x1b[>4;1m")
    feed(b, "\x1b[>4;2m")
  })

  test("input.csi-u", () => {
    // CSI u keyboard encoding (legacy, pre-kitty)
    feed(b, "\x1b[97u") // 'a' in CSI u encoding
  })

  test("input.pixel-mouse", () => {
    // Mode 1016: pixel coordinate mouse
    feed(b, "\x1b[?1016h")
  })

  test("input.urxvt-mouse", () => {
    // Mode 1015: urxvt mouse encoding
    feed(b, "\x1b[?1015h")
  })

  test("input.x10-mouse", () => {
    // Mode 9: X10 mouse tracking
    feed(b, "\x1b[?9h")
  })

  test("input.button-event-mouse", () => {
    // Mode 1002: button event tracking
    feed(b, "\x1b[?1002h")
  })
})
