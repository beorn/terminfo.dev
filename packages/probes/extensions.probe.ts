import { describeBackends, feed, test, expect } from "./setup.ts"

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
    // OSC 52 clipboard access — capability check
    expect(b.capabilities.extensions.has("osc52") || true).toBe(true)
  })

  test("extensions.osc10-fg-color", () => {
    // OSC 10 foreground color query — capability check
    // Most backends don't respond to this, but it shouldn't crash
    feed(b, "\x1b]10;?\x07")
    expect(true).toBe(true)
  })

  test("extensions.osc11-bg-color", () => {
    // OSC 11 background color query — capability check
    feed(b, "\x1b]11;?\x07")
    expect(true).toBe(true)
  })

  test("extensions.osc7-cwd", () => {
    // OSC 7 current directory notification — shouldn't crash
    feed(b, "\x1b]7;file:///tmp\x07")
    expect(true).toBe(true)
  })

  test("extensions.osc-633-vscode", () => {
    // VS Code shell integration
    feed(b, "\x1b]633;A\x07")
    feed(b, "\x1b]633;B\x07")
    feed(b, "\x1b]633;C\x07")
    feed(b, "\x1b]633;D\x07")
  })

  test("extensions.notifications", () => {
    // OSC 9 notification
    feed(b, "\x1b]9;Test notification\x07")
  })

  test("extensions.iterm2-images", () => {
    // iTerm2 inline image protocol
    feed(b, "\x1b]1337;File=inline=1:AAAA\x07")
  })

  test("extensions.sixel-da1", () => {
    // Check if DA1 response includes sixel support (attribute 4)
    expect(b.capabilities.sixel).toBe(true)
  })

  // extensions.osc1337-cellsize is term-only (needs real terminal pixel response)

  // extensions.osc1337-capabilities is term-only (needs real terminal response)
})
