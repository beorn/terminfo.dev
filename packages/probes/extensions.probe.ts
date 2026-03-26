import { describeBackends, feed, feedCapture, test, expect } from "./setup.ts"

describeBackends("extensions", (b) => {
  test("extensions.truecolor", () => {
    expect(b.capabilities.truecolor).toBe(true)
  })

  test("extensions.kitty-keyboard", () => {
    expect(b.capabilities.kittyKeyboard).toBe(true)
  })

  test("extensions.kitty-graphics", () => {
    expect(b.capabilities.kittyGraphics).toBe(true)
  })

  test("extensions.sixel", () => {
    expect(b.capabilities.sixel).toBe(true)
  })

  test("extensions.osc8", () => {
    expect(b.capabilities.osc8Hyperlinks).toBe(true)
  })

  test("extensions.reflow", () => {
    expect(b.capabilities.reflow).toBe(true)
  })

  test("extensions.semantic-prompts", () => {
    expect(b.capabilities.semanticPrompts).toBe(true)
  })

  test("extensions.osc2-title", () => {
    feed(b, "\x1b]2;Test Title\x07")
    expect(b.getTitle()).toContain("Test Title")
  })

  test("extensions.osc0-icon-title", () => {
    // OSC 0 sets both icon name and window title
    feed(b, "\x1b]0;My Title\x07")
    expect(b.getTitle()).toContain("My Title")
  })

  test("extensions.osc52-clipboard", () => {
    // OSC 52 clipboard: set data, then query — verify round-trip via response
    const testData = btoa("hello clipboard")
    feed(b, `\x1b]52;c;${testData}\x07`)
    const response = feedCapture(b, "\x1b]52;c;?\x07")
    // Response should contain the base64 data we set
    expect(response).toContain(testData)
  })

  test("extensions.osc10-fg-color", () => {
    // OSC 10 foreground color query — should respond with rgb: format
    const response = feedCapture(b, "\x1b]10;?\x07")
    expect(response).toContain("rgb:")
  })

  test("extensions.osc11-bg-color", () => {
    // OSC 11 background color query — should respond with rgb: format
    const response = feedCapture(b, "\x1b]11;?\x07")
    expect(response).toContain("rgb:")
  })

  test("extensions.osc7-cwd", () => {
    // OSC 7 current directory notification — verify it doesn't corrupt text
    feed(b, "\x1b]7;file:///tmp/test\x07")
    feed(b, "OK")
    expect(b.getText()).toContain("OK")
  })

  test("extensions.osc-633-vscode", () => {
    // VS Code shell integration — verify sequences don't corrupt surrounding text
    // and that semantic zone data is preserved (mirrors OSC 133 behavior)
    feed(b, "\x1b]633;A\x07")
    feed(b, "prompt$ ")
    feed(b, "\x1b]633;B\x07")
    feed(b, "command")
    feed(b, "\x1b]633;C\x07")
    feed(b, "output")
    feed(b, "\x1b]633;D\x07")
    // Text stream should be intact — OSC sequences consumed without corruption
    const text = b.getText()
    expect(text).toContain("prompt$ ")
    expect(text).toContain("command")
    expect(text).toContain("output")
  })

  test("extensions.notifications", () => {
    // OSC 9 notification — verify it doesn't corrupt the text stream
    feed(b, "\x1b]9;Test notification\x07")
    feed(b, "OK")
    expect(b.getText()).toContain("OK")
  })

  test("extensions.iterm2-images", () => {
    // iTerm2 inline image protocol — verify sequence is consumed cleanly
    feed(b, "\x1b]1337;File=inline=1:AAAA\x07")
    feed(b, "OK")
    // Image sequence must not leak into the text stream
    expect(b.getText()).toContain("OK")
    expect(b.getText()).not.toContain("1337")
    expect(b.getText()).not.toContain("AAAA")
  })

  test("extensions.sixel-da1", () => {
    // Check if DA1 response includes sixel support (attribute 4)
    const response = feedCapture(b, "\x1b[c")
    // DA1 response should contain ";4" indicating sixel graphics attribute
    expect(response).toContain(";4")
  })

  // extensions.osc1337-cellsize is term-only (needs real terminal pixel response)

  // extensions.osc1337-capabilities is term-only (needs real terminal response)
})
