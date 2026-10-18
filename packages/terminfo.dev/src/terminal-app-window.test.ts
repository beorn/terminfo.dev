/**
 * @failure A kitty run is reported as owned when the recorded pid is stale, reused, another binary, or
 * not an ancestor of the daemon; an unknown provider falls through; or an executable lookup loses its cause.
 * @level l1
 * @consumer The one owned-window authority the admin asserts before every app probe.
 * @testonly none
 */
import { spawnSync } from "node:child_process"
import { realpathSync } from "node:fs"
import { describe, expect, test, vi } from "vitest"
import {
  assertOwnedTerminalWindow,
  closeOwnedTerminalWindow,
  descendToOwner,
  parseKittyIdentity,
  type OwnedTerminalWindow,
} from "./terminal-app-window.ts"

vi.mock("node:child_process", () => ({ spawnSync: vi.fn() }))
vi.mock("node:fs", () => ({ realpathSync: vi.fn() }))

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

  test("accepts a daemon that descends from the recorded kitty pid, including past 64 hops", () => {
    expect(() => descendToOwner(300, 100, (pid) => parents.get(pid) ?? null)).not.toThrow()
    // The removed hop ceiling accepted three hops and refused this one; a valid chain of 71 hops now
    // passes, so a returned cap fails this same accepted case instead of hiding behind a short chain.
    const long = new Map<number, number>()
    for (let pid = 1000; pid < 1070; pid += 1) long.set(pid, pid + 1)
    long.set(1070, 100)
    expect(() => descendToOwner(1000, 100, (pid) => long.get(pid) ?? null)).not.toThrow()
  })

  test("refuses a chain that ends at pid 1 and names the chain it walked", () => {
    expect(() => descendToOwner(300, 999, (pid) => parents.get(pid) ?? null)).toThrow(/300 -> 200 -> 100 -> 1/)
  })

  test("refuses a missing chain instead of passing it", () => {
    expect(() => descendToOwner(300, 100, () => null)).toThrow(/not a descendant/)
  })

  test("refuses a cyclic chain by naming the cycle", () => {
    expect(() => descendToOwner(300, 100, (pid) => (pid === 200 ? 300 : 200))).toThrow(/cycles at pid/)
  })

  test("refuses the owner pid itself as the daemon", () => {
    expect(() => descendToOwner(100, 100, () => 1)).toThrow(/same pid/)
  })
})

describe("provider dispatch", () => {
  const window: OwnedTerminalWindow = {
    provider: "kitty",
    windowId: 1,
    tty: "/dev/ttys004",
    kittyPid: 4321,
    executablePath: "/Applications/kitty.app/Contents/MacOS/kitty",
    instanceGroup: "terminfo-run",
  }

  test("refuses a kitty window whose recorded pid is the daemon itself", () => {
    expect(() => assertOwnedTerminalWindow(window, 4321)).toThrow(/same pid/)
  })

  test.each(["assert", "close"] as const)("%s retains an unreadable executable's identity and cause", (operation) => {
    const cause = new Error("executable lookup denied")
    const result = { status: 0, stdout: `${window.executablePath}\n`, stderr: "" } as ReturnType<typeof spawnSync>
    vi.mocked(spawnSync).mockReturnValue(result)
    if (operation === "assert") vi.mocked(spawnSync).mockReturnValueOnce({ ...result, stdout: "ttys004\n" })
    vi.mocked(realpathSync).mockImplementation(() => {
      throw cause
    })
    const kill = vi.spyOn(process, "kill").mockReturnValue(true)
    try {
      const act = () =>
        operation === "assert" ? assertOwnedTerminalWindow(window, 5432) : closeOwnedTerminalWindow(window)
      let failure: unknown
      try {
        act()
      } catch (error) {
        failure = error
      }
      expect(failure).toMatchObject({
        message: expect.stringContaining(`pid ${window.kittyPid}`),
        cause,
      })
      expect(failure).toHaveProperty("message", expect.stringContaining(window.executablePath))
      expect(kill).not.toHaveBeenCalledWith(window.kittyPid, "SIGTERM")
      if (operation === "close") {
        vi.mocked(spawnSync).mockReturnValue({ ...result, status: 1, stdout: "" })
        kill.mockImplementation(() => {
          throw Object.assign(new Error("gone"), { code: "ESRCH" })
        })
        expect(() => closeOwnedTerminalWindow(window)).not.toThrow()
      }
    } finally {
      kill.mockRestore()
      vi.mocked(spawnSync).mockReset()
      vi.mocked(realpathSync).mockReset()
    }
  })

  test("an unknown provider fails loudly instead of falling through", () => {
    const unknown = { provider: "ghostty", windowId: 1, tty: "/dev/ttys004" } as unknown as OwnedTerminalWindow
    expect(() => assertOwnedTerminalWindow(unknown, 99)).toThrow(/no provider arm/)
  })
})
