import { describe, expect, test } from "vitest"
import { assertKittyOwner, parseKittyIdentity } from "./kitty-owner.ts"

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

describe("kitty owner assertion", () => {
  const identity = { windowId: 1, kittyPid: 100, tty: "/dev/ttys004", term: "xterm-kitty" }

  test("accepts a daemon that descends from the kitty process", () => {
    const parents = new Map([
      [300, 200],
      [200, 100],
      [100, 1],
    ])
    expect(() => assertKittyOwner(identity, 300, (pid) => parents.get(pid) ?? null)).not.toThrow()
  })

  test("refuses a daemon outside the kitty process", () => {
    const parents = new Map([
      [300, 200],
      [200, 1],
    ])
    expect(() => assertKittyOwner(identity, 300, (pid) => parents.get(pid) ?? null)).toThrow(/not a descendant/)
  })

  test("refuses a missing chain instead of passing it", () => {
    expect(() => assertKittyOwner(identity, 300, () => null)).toThrow(/not a descendant/)
  })

  test("refuses the kitty pid itself as the daemon", () => {
    expect(() => assertKittyOwner(identity, 100, () => 1)).toThrow(/same pid/)
  })
})
