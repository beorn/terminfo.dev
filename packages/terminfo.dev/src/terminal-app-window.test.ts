/**
 * @failure A kitty run is reported as owned when the recorded pid is stale, reused, another binary, or
 * not an ancestor of the daemon; or an unknown window provider silently falls through an assertion.
 * @level l1
 * @consumer The one owned-window authority the admin asserts before every app probe.
 * @testonly none
 */
import { describe, expect, test } from "vitest"
import {
  assertOwnedTerminalWindow,
  descendToOwner,
  parseKittyIdentity,
  type OwnedTerminalWindow,
} from "./terminal-app-window.ts"

describe("kitty owner identity", () => {
  test("parses the four fields the serve script records", () => {
    expect(parseKittyIdentity("1\n87024\n/dev/ttys004\nxterm-kitty\n")).toEqual({
      windowId: 1,
      kittyPid: 87024,
      tty: "/dev/ttys004",
      term: "xterm-kitty",
    })
  })

  test.each([
    ["missing fields", "1\n87024\n"],
    ["empty window id", "\n87024\n/dev/ttys004\nxterm-kitty"],
    ["zero window id", "0\n87024\n/dev/ttys004\nxterm-kitty"],
    ["non-numeric pid", "1\nnot-a-pid\n/dev/ttys004\nxterm-kitty"],
    ["tty is not a device", "1\n87024\nnot-a-tty\nxterm-kitty"],
    ["another terminal", "1\n87024\n/dev/ttys004\nxterm-256color"],
  ])("refuses %s", (_name, text) => {
    expect(() => parseKittyIdentity(text)).toThrow()
  })
})

describe("descendant walk", () => {
  const parents = new Map([
    [300, 200],
    [200, 100],
    [100, 1],
  ])

  test("accepts a daemon that descends from the recorded kitty pid", () => {
    expect(() => descendToOwner(300, 100, (pid) => parents.get(pid) ?? null)).not.toThrow()
  })

  test("refuses a chain that ends at pid 1 and names the chain it walked", () => {
    expect(() => descendToOwner(300, 999, (pid) => parents.get(pid) ?? null)).toThrow(/300 -> 200 -> 100 -> 1/)
  })

  test("refuses a missing chain instead of passing it", () => {
    expect(() => descendToOwner(300, 100, () => null)).toThrow(/not a descendant/)
  })

  test("refuses a cycle after the hop ceiling", () => {
    expect(() => descendToOwner(300, 100, (pid) => (pid === 200 ? 300 : 200))).toThrow(/not a descendant/)
  })

  test("refuses the owner pid itself as the daemon", () => {
    expect(() => descendToOwner(100, 100, () => 1)).toThrow(/same pid/)
  })
})

describe("provider dispatch", () => {
  test("refuses a kitty window whose recorded pid is the daemon itself", () => {
    const window: OwnedTerminalWindow = {
      provider: "kitty",
      windowId: 1,
      tty: "/dev/ttys004",
      kittyPid: 4321,
      executablePath: "/Applications/kitty.app/Contents/MacOS/kitty",
      instanceGroup: "terminfo-run",
    }
    expect(() => assertOwnedTerminalWindow(window, 4321)).toThrow(/same pid/)
  })

  test("an unknown provider fails loudly instead of falling through", () => {
    const unknown = { provider: "ghostty", windowId: 1, tty: "/dev/ttys004" } as unknown as OwnedTerminalWindow
    expect(() => assertOwnedTerminalWindow(unknown, 99)).toThrow(/no provider arm/)
  })
})
