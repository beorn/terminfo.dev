/**
 * @failure A hosted Windows SendInput lands somewhere other than the run's own terminal, or a failed
 *   one is graded as the terminal's answer: a wrong foreground window or pid, hwndFocus in another
 *   process, a tab or search box holding keyboard focus, an unbound or mis-rooted TermControl, a
 *   higher-integrity terminal (UIPI), a scaled UIA rect, an out-of-control pointer, a short insert
 *   that is not recorded as harness evidence, a key or button left down, or a wrong absolute
 *   coordinate across monitors (#30723, @cto round-2 corrections 1 and 4).
 * @level l1
 * @consumer createWindowsInputMechanism, the hosted Windows input route behind input-fixture.ts.
 * @testonly none
 */
import { describe, expect, it } from "vitest"
import { describeInputContract } from "./testing/input-contract.ts"
import {
  createWindowsInput,
  createWindowsInputMechanism,
  installWindowsInput,
  WINDOWS_INPUT_SELF_TEST_KEYSYM,
  keyEvents,
  owedReleases,
  readTermControl,
  termControlScript,
  toAbsolute,
  WindowsInputNotInserted,
  WindowsInputRefused,
  type TermControlReading,
  type Win32InputEvent,
  type Win32InputOs,
  type WindowsSelfTestRead,
} from "./windows-input.ts"
import {
  encodeInputs,
  GUITHREADINFO_FOCUS_OFFSET,
  GUITHREADINFO_SIZE,
  INPUT_SIZE,
  integrityFromLabel,
  user32Declaration,
} from "./windows-user32.ts"

const WT_PID = 4242
const COLLECTOR_PID = 777
const TOP = 0x10_0a2cn
const CONTROL_FRAME = { x: 108, y: 140, width: 1200, height: 700 }
const WINDOW_FRAME = { x: 100, y: 100, width: 1216, height: 748 }

/** Keyboard layout facts for the US layout the hosted runner uses. */
const US: Record<string, { vk: number; shiftState: number }> = {
  a: { vk: 0x41, shiftState: 0 },
  b: { vk: 0x42, shiftState: 0 },
  i: { vk: 0x49, shiftState: 0 },
  v: { vk: 0x56, shiftState: 0 },
  z: { vk: 0x5a, shiftState: 0 },
  "[": { vk: 0xdb, shiftState: 0 },
  "{": { vk: 0xdb, shiftState: 1 },
  "+": { vk: 0xbb, shiftState: 1 },
}

function fakeOs(overrides: Partial<Win32InputOs> = {}) {
  const sent: Win32InputEvent[][] = []
  const calls: string[] = []
  let cursor = { x: CONTROL_FRAME.x + 400, y: CONTROL_FRAME.y + 300 }
  const os: Win32InputOs = {
    currentThreadId: () => 11,
    lastError: () => 0,
    desktops: () => ({ input: "Default", thread: "Default" }),
    integrityLevel: (pid) => (pid === WT_PID ? 0x2000 : 0x3000),
    foreground: () => ({ hwnd: TOP, pid: WT_PID, tid: 22 }),
    focusedWindow: () => ({ hwnd: 0x10_0b00n, pid: WT_PID }),
    rootOf: () => TOP,
    setForeground: (hwnd) => {
      calls.push(`setForeground ${hwnd.toString(16)}`)
      return true
    },
    attachThreadInput: (from, to, attach) => {
      calls.push(`attach ${from}->${to} ${String(attach)}`)
      return true
    },
    windowFrame: () => WINDOW_FRAME,
    clientFrame: () => ({ x: 108, y: 131, width: 1200, height: 709 }),
    cursor: () => cursor,
    virtualScreen: () => ({ x: 0, y: 0, width: 1920, height: 1080 }),
    keyScan: (char) => US[char] ?? null,
    scanCode: (vk) => vk + 0x100,
    sendInput(events) {
      sent.push([...events])
      const move = events.find((event) => event.kind === "mouse" && (event.flags & 0x8000) !== 0)
      if (move?.kind === "mouse") {
        cursor = { x: Math.round((move.dx * 1919) / 65535), y: Math.round((move.dy * 1079) / 65535) }
      }
      return events.length
    },
    ...overrides,
  }
  return { os, sent, calls }
}

const reading = (overrides: Partial<Extract<TermControlReading, { status: "read" }>> = {}): TermControlReading => ({
  status: "read",
  topLevel: TOP,
  control: 0n,
  frame: CONTROL_FRAME,
  window: WINDOW_FRAME,
  focused: true,
  ...overrides,
})

function build(os: Win32InputOs, readControl: () => TermControlReading = () => reading()) {
  return createWindowsInputMechanism({ pid: WT_PID, os, readControl, collectorPid: COLLECTOR_PID })
}

describe("Windows input binding (#30723 correction 1)", () => {
  it("binds the only TermControl by UIA ancestry when it has no native handle, and says so", () => {
    const { binding } = build(fakeOs().os)
    expect(binding.topLevel).toBe(TOP)
    expect(binding.evidence).toContain("has no native handle; bound to 0x100a2c by UIA ancestry")
  })

  it("requires a control handle's root to be UIA's top-level window", () => {
    const { os } = fakeOs({ rootOf: (hwnd) => (hwnd === 0x55n ? 0x99n : TOP) })
    expect(() => build(os, () => reading({ control: 0x55n }))).toThrow(
      "the TermControl's handle 0x55 has root 0x99, not UIA's top-level 0x100a2c",
    )
  })

  it("refuses a top-level window with no handle, or one that is not a root window", () => {
    expect(() => build(fakeOs().os, () => reading({ topLevel: 0n }))).toThrow(
      "the TermControl's top-level window reports no native handle",
    )
    expect(() => build(fakeOs({ rootOf: () => 0x99n }).os)).toThrow(
      "UIA's top-level window 0x100a2c is not a root window",
    )
  })

  it("refuses a key when the TermControl is outside the client area", async () => {
    const { os, sent } = fakeOs({ clientFrame: () => ({ x: 0, y: 0, width: 300, height: 200 }) })
    await expect(build(os).mechanism.key("a")).rejects.toThrow("is not inside the window's client area")
    expect(sent).toEqual([])
  })

  it("reports a release that throws beside the short insert instead of hiding it", async () => {
    let calls = 0
    const { os } = fakeOs({
      sendInput: () => {
        calls++
        if (calls === 1) return 1
        throw new Error("release fault")
      },
    })
    await expect(build(os).mechanism.key("ctrl+b")).rejects.toThrow(
      /SendInput inserted 1 of 4 events for key "ctrl\+b".*released none \(the release threw: release fault\) of 1 owed key presses/,
    )
  })

  it("names the missing TermControl evidence before anything is posted", () => {
    const { os, sent } = fakeOs()
    expect(() =>
      build(os, () => ({ status: "refused", reason: "Windows Terminal (pid 4242) exposes 2 TermControl elements" })),
    ).toThrow("the run's TermControl is not bound: Windows Terminal (pid 4242) exposes 2 TermControl elements")
    expect(sent).toEqual([])
  })

  it("refuses a terminal above the collector's integrity level (UIPI) and an unshared input desktop", () => {
    expect(() => build(fakeOs({ integrityLevel: (pid) => (pid === WT_PID ? 0x3000 : 0x2000) }).os)).toThrow(
      "UIPI: WindowsTerminal (pid 4242) runs at high integrity, above the collector's medium",
    )
    expect(() => build(fakeOs({ desktops: () => ({ input: null, thread: "Default" }) }).os)).toThrow(
      "no interactive input desktop shared with the collector: input desktop unreadable",
    )
  })
})

describe("Windows input checks before each post", () => {
  it("refuses a different foreground window or pid with nothing sent", async () => {
    const { os, sent } = fakeOs({ foreground: () => ({ hwnd: 0x77n, pid: 9, tid: 3 }) })
    const { mechanism } = build(os)
    await expect(mechanism.key("a")).rejects.toThrow(
      "the foreground window is 0x77 of pid 9, not the bound 0x100a2c of pid 4242",
    )
    expect(sent).toEqual([])
  })

  it("refuses when hwndFocus belongs to another process", async () => {
    const { os, sent } = fakeOs({ focusedWindow: () => ({ hwnd: 0x88n, pid: 31 }) })
    await expect(build(os).mechanism.key("a")).rejects.toThrow(
      "hwndFocus 0x88 belongs to pid 31, not WindowsTerminal pid 4242",
    )
    expect(sent).toEqual([])
  })

  it("refuses when another control of Windows Terminal holds keyboard focus", async () => {
    const { os, sent } = fakeOs()
    let first = true
    const { mechanism } = build(os, () => {
      if (first) {
        first = false
        return reading()
      }
      return reading({ focused: false })
    })
    await expect(mechanism.key("a")).rejects.toThrow("keyboard focus is not on the run's TermControl")
    expect(sent).toEqual([])
  })

  it("tries one attached SetForegroundWindow, always detaches, and refuses without sending", async () => {
    const { os, sent, calls } = fakeOs({ foreground: () => ({ hwnd: 0x66n, pid: 5, tid: 44 }) })
    await expect(build(os).mechanism.focus()).rejects.toThrow(
      "the foreground window is still 0x66 of pid 5 after one attached SetForegroundWindow(0x100a2c)",
    )
    expect(calls).toEqual(["setForeground 100a2c", "attach 11->44 true", "setForeground 100a2c", "attach 11->44 false"])
    expect(sent).toEqual([])
  })

  it("refuses pointer placement when UIA's window size differs from GetWindowRect's, but still posts keys", async () => {
    const { os, sent } = fakeOs({ windowFrame: () => ({ x: 150, y: 150, width: 1824, height: 1122 }) })
    const { mechanism } = build(os)
    await expect(mechanism.geometry()).rejects.toThrow("UIA coordinates are scaled, so no pointer is placed")
    await mechanism.key("a")
    expect(sent).toHaveLength(1)
  })
})

describe("Windows input insertion", () => {
  it("records a short insert as harness evidence and releases every press it left down", async () => {
    const { os, sent } = fakeOs({ sendInput: (events) => (events.length === 4 ? 2 : events.length) })
    const tracking = {
      ...os,
      sendInput: (events: readonly Win32InputEvent[]) => (sent.push([...events]), os.sendInput(events)),
    }
    const error = await build(tracking)
      .mechanism.key("ctrl+b")
      .catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(WindowsInputNotInserted)
    expect(error).not.toBeInstanceOf(WindowsInputRefused)
    expect(String(error)).toContain('SendInput inserted 2 of 4 events for key "ctrl+b"')
    expect(String(error)).toContain("released 2 of 2 owed key presses")
    // ctrl down and b down went in; b and then ctrl are released.
    expect(sent[1]?.map((event) => (event.kind === "key" ? [event.vk, event.flags] : []))).toEqual([
      [0x42, 2],
      [0x11, 2],
    ])
  })

  it("releases every press when SendInput throws, and keeps SendInput's own error", async () => {
    const released: Win32InputEvent[][] = []
    let calls = 0
    const { os } = fakeOs({
      sendInput: (events) => {
        calls++
        if (calls === 1) throw new Error("ffi fault")
        released.push([...events])
        return events.length
      },
    })
    await expect(build(os).mechanism.key("ctrl+shift+v")).rejects.toThrow("ffi fault")
    expect(released[0]?.map((event) => (event.kind === "key" ? event.vk : 0))).toEqual([0x56, 0x10, 0x11])
  })

  it("owes nothing after a complete insert", () => {
    const events = keyEvents("ctrl+i", fakeOs().os)
    expect(owedReleases(events, events.length)).toEqual([])
  })
})

describe("Windows pointer", () => {
  it("refuses a point outside the TermControl before sending, including a raw injectMove", async () => {
    const { os, sent } = fakeOs()
    const input = createWindowsInput(build(os).mechanism)
    const { injectMove } = input
    if (!injectMove) throw new Error("the shared adapter always provides injectMove")
    await expect(injectMove(1200, 10)).rejects.toThrow(
      "pointer 1200,10 is outside the TermControl 1200x700; nothing was sent",
    )
    await expect(input.injectClick(1, { x: 1300, y: 120 })).rejects.toThrow("outside the owned window 1200x700")
    expect(sent).toEqual([])
  })

  it("places the pointer at the control's own pixel and reads it back", async () => {
    const { os, sent } = fakeOs()
    await createWindowsInput(build(os).mechanism).injectClick(4)
    expect(sent[0]).toEqual([
      {
        kind: "mouse",
        dx: toAbsolute({ x: 508, y: 440 }, os.virtualScreen()).dx,
        dy: toAbsolute({ x: 508, y: 440 }, os.virtualScreen()).dy,
        mouseData: 0,
        flags: 0xc001,
      },
    ])
    expect(sent[1]).toEqual([{ kind: "mouse", dx: 0, dy: 0, mouseData: 120, flags: 0x0800 }])
  })

  it("lets a held button go when a drag's move refuses", async () => {
    const { os, sent } = fakeOs()
    const { mechanism } = build(os)
    await mechanism.press(1)
    await expect(mechanism.moveTo(5000, 10, { verifyPointer: false, dragged: true })).rejects.toThrow(
      "outside the TermControl",
    )
    expect(sent.at(-1)).toEqual([{ kind: "mouse", dx: 0, dy: 0, mouseData: 0, flags: 0x0004 }])
  })
})

describe("toAbsolute (per-monitor-v2 physical pixels)", () => {
  it.each([
    ["origin of a single 100% monitor", { x: 0, y: 0 }, { x: 0, y: 0, width: 1920, height: 1080 }, { dx: 0, dy: 0 }],
    [
      "last pixel of a single monitor",
      { x: 1919, y: 1079 },
      { x: 0, y: 0, width: 1920, height: 1080 },
      { dx: 65535, dy: 65535 },
    ],
    [
      "centre of a 150% 4K monitor",
      { x: 1920, y: 1080 },
      { x: 0, y: 0, width: 3840, height: 2160 },
      { dx: 32776, dy: 32783 },
    ],
    [
      "left monitor at a negative origin",
      { x: -1920, y: 0 },
      { x: -1920, y: 0, width: 4800, height: 1620 },
      { dx: 0, dy: 0 },
    ],
    [
      "primary origin beside a negative-origin monitor",
      { x: 0, y: 810 },
      { x: -1920, y: 0, width: 4800, height: 1620 },
      { dx: 26219, dy: 32788 },
    ],
  ])("%s", (_name, point, screen, expected) => {
    expect(toAbsolute(point, screen)).toEqual(expected)
  })

  it("refuses a point off the virtual desktop", () => {
    expect(() => toAbsolute({ x: 1920, y: 5 }, { x: 0, y: 0, width: 1920, height: 1080 })).toThrow(
      "pointer x=1920 is outside the virtual screen 0..1919",
    )
  })
})

describe("keyEvents", () => {
  const os = fakeOs().os
  const shape = (keys: string) =>
    keyEvents(keys, os).map((event) =>
      event.kind === "key"
        ? `${event.vk.toString(16)}${event.flags & 2 ? "u" : "d"}${event.flags & 1 ? "e" : ""}`
        : "mouse",
    )

  it.each([
    ["a", ["41d", "41u"]],
    ["ctrl+i", ["11d", "49d", "49u", "11u"]],
    ["ctrl+shift+v", ["11d", "10d", "56d", "56u", "10u", "11u"]],
    ["KP_Add", ["6bd", "6bu"]],
    ["Prior", ["21de", "21ue"]],
    ["Up", ["26de", "26ue"]],
    ["bracketleft", ["dbd", "dbu"]],
    ["braceleft", ["10d", "dbd", "dbu", "10u"]],
    ["ctrl++", ["11d", "10d", "bbd", "bbu", "10u", "11u"]],
  ])("%s", (keys, expected) => {
    expect(shape(keys)).toEqual(expected)
  })

  it("carries the layout's scan code", () => {
    expect(keyEvents("a", os)[0]).toEqual({ kind: "key", vk: 0x41, scan: 0x141, flags: 0 })
  })

  it("refuses macOS keycodes, unknown modifiers and characters the layout cannot type", () => {
    expect(() => keyEvents("code:7", os)).toThrow("code: names a macOS virtual keycode")
    expect(() => keyEvents("hyper+a", os)).toThrow("unknown modifier hyper")
    expect(() => keyEvents("é", os)).toThrow("no key on this keyboard layout types é")
  })
})

describeInputContract("Windows", (mechanism) => createWindowsInput(mechanism))

describe("readTermControl", () => {
  const reply = (stdout: string) => () => ({ status: 0, stdout, stderr: "", signal: null, timedOut: false })

  it("reads the binding, with handles as BigInt", () => {
    const read = readTermControl({
      pid: WT_PID,
      run: reply(
        '{"status":"read","topLevel":1051180,"control":0,"frame":{"x":108,"y":140,"width":1200,"height":700},"window":{"x":100,"y":100,"width":1216,"height":748},"focused":true}',
      ),
    })
    expect(read).toEqual({
      status: "read",
      topLevel: 1051180n,
      control: 0n,
      frame: CONTROL_FRAME,
      window: WINDOW_FRAME,
      focused: true,
    })
  })

  it("passes the script's refusal through and refuses an unrecognised reading", () => {
    expect(readTermControl({ pid: WT_PID, run: reply('{"status":"refused","reason":"no TermControl"}') })).toEqual({
      status: "refused",
      reason: "no TermControl",
    })
    expect(readTermControl({ pid: WT_PID, run: reply('{"status":"read","topLevel":-1}') })).toEqual({
      status: "refused",
      reason: "Windows Terminal's TermControl returned an unrecognised reading",
    })
  })

  it("asks for exactly one TermControl and checks its own ancestry", () => {
    const script = termControlScript(WT_PID)
    expect(script).toContain("$ownerPid = 4242")
    expect(script).toContain("exactly one is required")
    expect(script).toContain("RawViewWalker")
    expect(script).toContain("HasKeyboardFocus")
  })
})

describe("user32 binding", () => {
  const declaration = user32Declaration({ ptr: "ptr", u16: "u16", i16: "i16", u32: "u32", u64: "u64", i32: "i32" })

  it("declares every HWND, HDESK and DPI context as u64 and VkKeyScanW's SHORT as i16", () => {
    for (const name of [
      "GetForegroundWindow",
      "GetAncestor",
      "GetThreadDpiAwarenessContext",
      "OpenInputDesktop",
      "GetThreadDesktop",
    ]) {
      expect(declaration[name]?.returns).toBe("u64")
    }
    expect(declaration.SetForegroundWindow?.args).toEqual(["u64"])
    expect(declaration.GetWindowThreadProcessId?.args).toEqual(["u64", "ptr"])
    expect(declaration.SendInput).toEqual({ args: ["u32", "ptr", "i32"], returns: "u32" })
    expect(declaration.VkKeyScanW?.returns).toBe("i16")
  })

  it("lays INPUT and GUITHREADINFO out at their x64 sizes and offsets", () => {
    expect(INPUT_SIZE).toBe(40)
    expect(GUITHREADINFO_SIZE).toBe(72)
    expect(GUITHREADINFO_FOCUS_OFFSET).toBe(16)
    const bytes = encodeInputs([
      { kind: "mouse", dx: 100, dy: -5, mouseData: -120, flags: 0x0800 },
      { kind: "key", vk: 0x41, scan: 0x1e, flags: 2 },
    ])
    const view = new DataView(bytes.buffer)
    expect(bytes.length).toBe(80)
    expect([
      view.getUint32(0, true),
      view.getInt32(8, true),
      view.getInt32(12, true),
      view.getInt32(16, true),
      view.getUint32(20, true),
    ]).toEqual([0, 100, -5, -120, 0x0800])
    expect([
      view.getUint32(40, true),
      view.getUint16(48, true),
      view.getUint16(50, true),
      view.getUint32(52, true),
    ]).toEqual([1, 0x41, 0x1e, 2])
  })

  it("reads the mandatory label's last sub-authority from inside the buffer", () => {
    const label = new Uint8Array(64)
    const view = new DataView(label.buffer)
    const address = 0x5000n
    view.setBigUint64(0, address + 16n, true)
    label.set([1, 1, 0, 0, 0, 0, 0, 16], 16)
    view.setUint32(24, 0x2000, true)
    expect(integrityFromLabel(label, address)).toBe(0x2000)
    view.setBigUint64(0, 0x9000n, true)
    expect(integrityFromLabel(label, address)).toBeNull()
  })
})

describe("installWindowsInput (#30723 slice 2)", () => {
  const install = (
    os: Win32InputOs,
    selfTest: (inject: () => Promise<void>, read: WindowsSelfTestRead) => Promise<string | null>,
    report?: (fact: string) => void,
  ) => installWindowsInput({ pid: WT_PID, os, readControl: () => reading(), selfTest, ...(report && { report }) })

  it("refuses the install by name when the self-test key does not come back on the run's TTY", async () => {
    const { os, sent } = fakeOs()
    await expect(
      install(os, async (inject) => {
        await inject()
        return null
      }),
    ).rejects.toThrow(
      /input not delivered to Windows Terminal: SendInput posted keysym "z" to pid 4242 \(.*bound to 0x100a2c by UIA ancestry\) and the run's TTY, read in raw mode, echoed nothing; refusing to measure input rows through it/,
    )
    // The one key that was posted is the self-test key, pressed and released in one call.
    expect(sent).toHaveLength(1)
  })

  it("installs keys only after the echo, and reports the binding and the echo", async () => {
    const { os, sent } = fakeOs()
    const facts: string[] = []
    const input = await install(
      os,
      async (inject) => {
        await inject()
        return WINDOWS_INPUT_SELF_TEST_KEYSYM
      },
      (fact) => facts.push(fact),
    )
    expect(facts).toEqual([
      expect.stringMatching(
        /^windows input installed \(keys only until this context's hosted qualification gives a pointer witness\): pid 4242, .*self-test echoed "z"$/,
      ),
    ])
    await input.injectKey("ctrl+i")
    expect(sent).toHaveLength(2)
    await expect(input.injectClick(1)).rejects.toThrow(
      "Windows pointer placement refused: pointer posts wait for this context's hosted qualification",
    )
    expect(sent).toHaveLength(2)
  })

  // Run 46151931460: every pre-post check passed and the TTY still echoed nothing. A Windows console read outside
  // raw mode is line input (ENABLE_LINE_INPUT), so ReadConsoleW returns no byte until Enter and a lone "z" never
  // reaches the reader; raw mode delivers it at once, as the probe batch's own raw lease does for every input row.
  it("asks for the self-test echo in raw mode, because a Windows console's cooked read waits for Enter", async () => {
    const { os } = fakeOs()
    const reads: WindowsSelfTestRead[] = []
    await install(os, async (inject, read) => {
      reads.push(read)
      await inject()
      return WINDOWS_INPUT_SELF_TEST_KEYSYM
    })
    expect(reads).toEqual(["raw"])
  })

  it("posts no key but the self-test key before delivery is proven", async () => {
    const { os, sent } = fakeOs()
    await expect(
      install(os, async () => {
        await createWindowsInput(build(os).mechanism).injectKey("a")
        return null
      }),
    ).rejects.toThrow("input not delivered")
    // The bare mechanism above is not the gated one; the gated install itself posted nothing.
    expect(sent).toHaveLength(1)
  })
})
