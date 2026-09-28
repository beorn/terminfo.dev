/**
 * @failure Complete XTVERSION frames are rejected or truncated frames are trusted as terminal identity.
 * @level l1
 * @consumer App daemon run identity review
 * @testonly none
 */
import { describe, it, expect } from "vitest"
import { verifyTerminalIdentity } from "./identity-guard.ts"

describe("verifyTerminalIdentity", () => {
  it("accepts complete XTVERSION DCS bytes and refuses a truncated frame", () => {
    const da1 = "\x1b[?62;52;c"
    expect(
      verifyTerminalIdentity("kitty", {
        "device.primary-da": da1,
        "device.xtversion": "\x1bP>|kitty(0.49.1)\x1b\\",
      }).ok,
    ).toBe(true)
    expect(
      verifyTerminalIdentity("kitty", {
        "device.primary-da": da1,
        "device.xtversion": "\x1bP>|kitty(0.49.1)\x1b\\\x1b[?62;4c",
      }).ok,
    ).toBe(true)
    expect(
      verifyTerminalIdentity("kitty", {
        "device.primary-da": da1,
        "device.xtversion": "\x1bP>|kitty(0.49.1)",
      }).ok,
    ).toBe(false)
  })
  it("accepts a valid kitty probe result with XTVERSION and VT220 DA1", () => {
    const responses = {
      "device.primary-da": "\u001b[?62;52;c",
      "device.xtversion": "kitty(0.46.2)",
    }
    const results = {
      "device.xtversion": true,
    }
    const res = verifyTerminalIdentity("kitty", responses, results)
    expect(res.ok).toBe(true)
  })

  it("rejects a fake kitty run that returned VT100 DA1 (?1;2c) and no XTVERSION", () => {
    // This exact pattern was produced by eda4e39
    const responses = {
      "device.primary-da": "\u001b[?1;2c",
      "device.xtversion": "No XTVERSION response",
    }
    const results = {
      "device.xtversion": false,
    }
    const res = verifyTerminalIdentity("kitty", responses, results)
    expect(res.ok).toBe(false)
    expect(res.reason).toContain("requires an XTVERSION response")
  })

  it("rejects a fake kitty run with DA1 ?1;2c even if XTVERSION was somehow set", () => {
    const responses = {
      "device.primary-da": "\u001b[?1;2c",
      "device.xtversion": "kitty(0.46.2)",
    }
    const results = {
      "device.xtversion": true,
    }
    const res = verifyTerminalIdentity("kitty", responses, results)
    expect(res.ok).toBe(false)
    expect(res.reason).toContain("DA1 mismatch")
  })

  it("rejects kitty if XTVERSION matches a different terminal like xterm.js", () => {
    const responses = {
      "device.primary-da": "\u001b[?62;52;c",
      "device.xtversion": "xterm.js(6.1.0)",
    }
    const results = {
      "device.xtversion": true,
    }
    const res = verifyTerminalIdentity("kitty", responses, results)
    expect(res.ok).toBe(false)
    expect(res.reason).toContain("XTVERSION mismatch")
  })

  it("accepts valid ghostty and iterm2 results", () => {
    const ghosttyRes = verifyTerminalIdentity(
      "ghostty",
      { "device.primary-da": "\u001b[?62;22;52c", "device.xtversion": "ghostty 1.3.1" },
      { "device.xtversion": true },
    )
    expect(ghosttyRes.ok).toBe(true)

    const itermRes = verifyTerminalIdentity(
      "iterm2",
      { "device.primary-da": "\u001b[?64;1;2;4;6;17;18;21;22;52c", "device.xtversion": "iTerm2 3.6.9" },
      { "device.xtversion": true },
    )
    expect(itermRes.ok).toBe(true)
  })

  it("rejects iterm2 if DA1 is not VT420 (?64;...)", () => {
    const itermRes = verifyTerminalIdentity(
      "iterm2",
      { "device.primary-da": "\u001b[?62;22;52c", "device.xtversion": "iTerm2 3.6.9" },
      { "device.xtversion": true },
    )
    expect(itermRes.ok).toBe(false)
    expect(itermRes.reason).toContain("DA1 mismatch")
  })

  it("accepts terminal-app without XTVERSION and with VT100 DA1", () => {
    const termRes = verifyTerminalIdentity(
      "terminal-app",
      { "device.primary-da": "\u001b[?1;2c" },
      { "device.xtversion": false },
    )
    expect(termRes.ok).toBe(true)
  })

  it("rejects terminal-app if an XTVERSION response is returned", () => {
    const termRes = verifyTerminalIdentity(
      "terminal-app",
      { "device.primary-da": "\u001b[?1;2c", "device.xtversion": "xterm(370)" },
      { "device.xtversion": true },
    )
    expect(termRes.ok).toBe(false)
    expect(termRes.reason).toContain("does not support XTVERSION")
  })

  it("marks checked: true when an identity rule exists and passes", () => {
    const res = verifyTerminalIdentity(
      "kitty",
      { "device.primary-da": "\u001b[?62;52;c", "device.xtversion": "kitty(0.46.2)" },
      { "device.xtversion": true },
    )
    expect(res.ok).toBe(true)
    expect(res.checked).toBe(true)
  })

  it("marks checked: false when no identity rule is registered", () => {
    const res = verifyTerminalIdentity("unknown-terminal", { "device.primary-da": "\u001b[?1;2c" })
    expect(res.ok).toBe(true)
    expect(res.checked).toBe(false)
  })
})
