/**
 * The hosted Windows input mechanism (#30723): SendInput aimed at the run's own Windows Terminal
 * control, behind the shared `InputMechanism` port so button numbering, wheel 4/5 and the drag are
 * still written once in input-fixture.ts.
 *
 * What a post must prove first (@cto 30723 round-2 corrections 1 and 4, /hh/var/@cto/do-20261114T1623/30723-hosted-input-r2-go.md):
 *
 * - The target is bound once, at creation, from UI Automation: exactly one `TermControl` under the
 *   run's proven WindowsTerminal.exe pid, the top-level window its own ancestry reaches, and that
 *   window's HWND. A TermControl is a XAML island element and may report no native handle; then the
 *   binding is by UIA ancestry alone and says so. With a handle, its root must be that same window.
 * - Before every post: the TermControl still holds keyboard focus (a tab, the search box or any other
 *   control of the same process would otherwise take the input), the foreground window is the bound
 *   one and belongs to the run's pid, GetGUIThreadInfo's hwndFocus belongs to the run's pid, the
 *   control lies inside the window's client area, and for a pointer post the pointer lies inside the
 *   control. A mismatch refuses by name before SendInput.
 * - SendInput's return is insertion into the input stream, never delivery: a short or zero insert is
 *   `WindowsInputNotInserted`, harness evidence that the unified runner records as an ungraded
 *   collector-error, never a terminal negative. Delivery is proven only by a byte on the run's TTY.
 * - Every key press is released in the same SendInput call, and a press whose release was not
 *   inserted is released again before the refusal (also when SendInput itself throws).
 * - Integrity: a terminal above the collector's integrity level would take insertion and drop
 *   delivery (UIPI, which SendInput does not report), so creation refuses it by name.
 *
 * Coordinates: the OS layer declares per-monitor-v2 DPI awareness before any read, so every rect here
 * is in physical pixels. The UIA child process keeps its own awareness, so its window rect is compared
 * with GetWindowRect's: a different size means UIA coordinates are scaled, and pointer posts refuse.
 *
 * Out of scope here (plan section 4): no first-existing-process fallback, no SendInput after a failed
 * focus, no second focus ladder, no app-level IPC substitute, no ad-hoc download.
 */
import { createInjectedInput, type InputButton, type InputMechanism, type OwnedFrame } from "./input-fixture.ts"
import type { InputFixture } from "@terminfo/probe-defs"
import { classifyPowerShellReply, runPowerShell, type PowerShellReply } from "./windows-terminal-text.ts"

export type Win32InputEvent =
  | {
      readonly kind: "mouse"
      readonly dx: number
      readonly dy: number
      readonly mouseData: number
      readonly flags: number
    }
  | { readonly kind: "key"; readonly vk: number; readonly scan: number; readonly flags: number }

/** The OS reads and the one write the mechanism makes; production is windows-user32.ts, tests a fake. */
export interface Win32InputOs {
  currentThreadId(): number
  lastError(): number
  /** The input desktop's name and the collector thread's desktop name; null where unreadable. */
  desktops(): { input: string | null; thread: string | null }
  integrityLevel(pid: number): number | null
  foreground(): { hwnd: bigint; pid: number; tid: number }
  focusedWindow(tid: number): { hwnd: bigint; pid: number } | null
  rootOf(hwnd: bigint): bigint
  setForeground(hwnd: bigint): boolean
  attachThreadInput(from: number, to: number, attach: boolean): boolean
  windowFrame(hwnd: bigint): OwnedFrame | null
  clientFrame(hwnd: bigint): OwnedFrame | null
  cursor(): { x: number; y: number } | null
  virtualScreen(): OwnedFrame
  keyScan(char: string): { vk: number; shiftState: number } | null
  scanCode(vk: number): number
  sendInput(events: readonly Win32InputEvent[]): number
}

/** One UIA reading of the run's TermControl. */
export type TermControlReading =
  | {
      readonly status: "read"
      /** The top-level window the control's own ancestry reaches. */
      readonly topLevel: bigint
      /** The control's NativeWindowHandle; 0n when the element has none. */
      readonly control: bigint
      readonly frame: OwnedFrame
      /** The top-level window's UIA rect, compared with GetWindowRect for scaling. */
      readonly window: OwnedFrame
      readonly focused: boolean
    }
  | { readonly status: "refused"; readonly reason: string }

/** A refusal before anything was inserted: the target, focus, geometry or binding is not proved. */
export class WindowsInputRefused extends Error {
  override name = "WindowsInputRefused"
}

/** SendInput inserted fewer events than requested. Harness evidence, never a terminal negative. */
export class WindowsInputNotInserted extends Error {
  override name = "WindowsInputNotInserted"
}

const MOUSEEVENTF_MOVE = 0x0001
const MOUSEEVENTF_LEFTDOWN = 0x0002
const MOUSEEVENTF_LEFTUP = 0x0004
const MOUSEEVENTF_WHEEL = 0x0800
const MOUSEEVENTF_VIRTUALDESK = 0x4000
const MOUSEEVENTF_ABSOLUTE = 0x8000
const WHEEL_DELTA = 120
const KEYEVENTF_EXTENDEDKEY = 0x0001
const KEYEVENTF_KEYUP = 0x0002

const VK_SHIFT = 0x10
const VK_CONTROL = 0x11
const VK_MENU = 0x12
const VK_LWIN = 0x5b

/** Integrity RIDs, for the refusal text. */
const INTEGRITY_NAMES: Readonly<Record<number, string>> = {
  0x1000: "low",
  0x2000: "medium",
  0x2100: "medium-plus",
  0x3000: "high",
  0x4000: "system",
}

/** X keysym names the probes send, as Windows virtual keys; `extended` sets KEYEVENTF_EXTENDEDKEY. */
const NAMED_KEYS: Readonly<Record<string, { vk: number; extended: boolean }>> = {
  Return: { vk: 0x0d, extended: false },
  Tab: { vk: 0x09, extended: false },
  space: { vk: 0x20, extended: false },
  Space: { vk: 0x20, extended: false },
  Escape: { vk: 0x1b, extended: false },
  BackSpace: { vk: 0x08, extended: false },
  Delete: { vk: 0x2e, extended: true },
  Insert: { vk: 0x2d, extended: true },
  Up: { vk: 0x26, extended: true },
  Down: { vk: 0x28, extended: true },
  Left: { vk: 0x25, extended: true },
  Right: { vk: 0x27, extended: true },
  Home: { vk: 0x24, extended: true },
  End: { vk: 0x23, extended: true },
  Prior: { vk: 0x21, extended: true },
  Page_Up: { vk: 0x21, extended: true },
  Next: { vk: 0x22, extended: true },
  Page_Down: { vk: 0x22, extended: true },
  KP_Add: { vk: 0x6b, extended: false },
  KP_Subtract: { vk: 0x6d, extended: false },
  KP_Multiply: { vk: 0x6a, extended: false },
  KP_Divide: { vk: 0x6f, extended: true },
  KP_Enter: { vk: 0x0d, extended: true },
}

/** X keysym names for printable characters; the character then goes through the layout's VkKeyScan. */
const NAMED_CHARACTERS: Readonly<Record<string, string>> = {
  bracketleft: "[",
  bracketright: "]",
  braceleft: "{",
  braceright: "}",
  minus: "-",
  equal: "=",
  plus: "+",
  comma: ",",
  period: ".",
  slash: "/",
  backslash: "\\",
  semicolon: ";",
  apostrophe: "'",
  grave: "`",
}

const MODIFIERS: Readonly<Record<string, { vk: number; extended: boolean; shiftBit: number }>> = {
  shift: { vk: VK_SHIFT, extended: false, shiftBit: 1 },
  ctrl: { vk: VK_CONTROL, extended: false, shiftBit: 2 },
  control: { vk: VK_CONTROL, extended: false, shiftBit: 2 },
  alt: { vk: VK_MENU, extended: false, shiftBit: 4 },
  meta: { vk: VK_MENU, extended: false, shiftBit: 4 },
  super: { vk: VK_LWIN, extended: true, shiftBit: 0 },
  cmd: { vk: VK_LWIN, extended: true, shiftBit: 0 },
}

/**
 * The SendInput records for one keysym: modifier presses, the key press and release, then the
 * modifier releases in reverse, so every press has its release in the same call. A character goes
 * through the layout's own VkKeyScan, and any shift state the layout needs joins the named modifiers.
 */
export function keyEvents(keys: string, os: Pick<Win32InputOs, "keyScan" | "scanCode">): Win32InputEvent[] {
  // "+" alone, or last after a modifier ("ctrl++"), is the plus character itself.
  const plus = keys === "+" || keys.endsWith("++")
  const parts = plus ? (keys === "+" ? [] : keys.slice(0, -2).split("+")) : keys.split("+")
  const name = plus ? "+" : (parts.pop() ?? "")
  if (name.length === 0) throw new WindowsInputRefused(`Windows key ${JSON.stringify(keys)}: no key named`)
  const modifiers: { vk: number; extended: boolean }[] = []
  const add = (modifier: { vk: number; extended: boolean }) => {
    if (!modifiers.some((held) => held.vk === modifier.vk)) modifiers.push(modifier)
  }
  for (const part of parts) {
    const modifier = MODIFIERS[part.toLowerCase()]
    if (!modifier) throw new WindowsInputRefused(`Windows key ${JSON.stringify(keys)}: unknown modifier ${part}`)
    add(modifier)
  }
  let key: { vk: number; extended: boolean }
  const named = NAMED_KEYS[name]
  if (named) {
    key = named
  } else if (name.startsWith("code:")) {
    throw new WindowsInputRefused(
      `Windows key ${JSON.stringify(keys)}: code: names a macOS virtual keycode, which has no Windows meaning`,
    )
  } else {
    const character = NAMED_CHARACTERS[name] ?? name
    if ([...character].length !== 1) {
      throw new WindowsInputRefused(
        `Windows key ${JSON.stringify(keys)}: expected one printable character, a named key, or modifier+ prefixes`,
      )
    }
    const scan = os.keyScan(character)
    if (!scan) {
      throw new WindowsInputRefused(
        `Windows key ${JSON.stringify(keys)}: no key on this keyboard layout types ${character}`,
      )
    }
    for (const modifier of Object.values(MODIFIERS)) {
      if (modifier.shiftBit !== 0 && (scan.shiftState & modifier.shiftBit) !== 0) add(modifier)
    }
    key = { vk: scan.vk, extended: false }
  }
  const record = (entry: { vk: number; extended: boolean }, up: boolean): Win32InputEvent => ({
    kind: "key",
    vk: entry.vk,
    scan: os.scanCode(entry.vk),
    flags: (entry.extended ? KEYEVENTF_EXTENDEDKEY : 0) | (up ? KEYEVENTF_KEYUP : 0),
  })
  return [
    ...modifiers.map((modifier) => record(modifier, false)),
    record(key, false),
    record(key, true),
    ...[...modifiers].reverse().map((modifier) => record(modifier, true)),
  ]
}

/**
 * The releases still owed after `inserted` of `events` went in: each press inserted whose release was
 * not. `inserted` null means SendInput threw and the count is unknown, so every press is released.
 */
export function owedReleases(events: readonly Win32InputEvent[], inserted: number | null): Win32InputEvent[] {
  const limit = inserted ?? events.length
  const owed: Win32InputEvent[] = []
  events.forEach((event, index) => {
    if (event.kind !== "key" || (event.flags & KEYEVENTF_KEYUP) !== 0 || (inserted !== null && index >= limit)) return
    const releasedAt = events.findIndex(
      (later, at) =>
        at > index && later.kind === "key" && later.vk === event.vk && (later.flags & KEYEVENTF_KEYUP) !== 0,
    )
    if (inserted === null || releasedAt === -1 || releasedAt >= limit) {
      owed.unshift({ ...event, flags: event.flags | KEYEVENTF_KEYUP })
    }
  })
  return owed
}

/**
 * A physical screen point as SendInput's absolute coordinate over the whole virtual desktop:
 * 0..65535 across SM_X/YVIRTUALSCREEN and SM_CX/CYVIRTUALSCREEN, so the left and top edges are 0 and
 * the last pixel is 65535; rounded to the nearest unit. A point outside the virtual desktop refuses.
 */
export function toAbsolute(point: { x: number; y: number }, screen: OwnedFrame): { dx: number; dy: number } {
  if (screen.width < 2 || screen.height < 2) {
    throw new WindowsInputRefused(`the virtual screen ${screen.width}x${screen.height} is too small to address`)
  }
  const across = (value: number, origin: number, size: number, axis: string): number => {
    if (value < origin || value >= origin + size) {
      throw new WindowsInputRefused(
        `pointer ${axis}=${value} is outside the virtual screen ${origin}..${origin + size - 1}`,
      )
    }
    return Math.round(((value - origin) * 65535) / (size - 1))
  }
  return { dx: across(point.x, screen.x, screen.width, "x"), dy: across(point.y, screen.y, screen.height, "y") }
}

/** Runs a synchronous verb as the port's promise, so a refusal rejects instead of throwing at the call. */
const later = <T>(action: () => T): Promise<T> => Promise.resolve().then(action)

/** HWNDs are significant in their low 32 bits on 64-bit Windows; UIA hands them back as 32-bit ints. */
const hwnd32 = (hwnd: bigint): bigint => hwnd & 0xffffffffn
const hex = (hwnd: bigint): string => `0x${hwnd32(hwnd).toString(16)}`

const contains = (outer: OwnedFrame, inner: OwnedFrame): boolean =>
  inner.x >= outer.x &&
  inner.y >= outer.y &&
  inner.x + inner.width <= outer.x + outer.width &&
  inner.y + inner.height <= outer.y + outer.height

const inside = (frame: OwnedFrame, point: { x: number; y: number }): boolean =>
  point.x >= frame.x && point.y >= frame.y && point.x < frame.x + frame.width && point.y < frame.y + frame.height

export interface WindowsInputBinding {
  readonly pid: number
  readonly topLevel: bigint
  readonly control: bigint
  /** How the control was tied to the top-level window, for the run's evidence. */
  readonly evidence: string
}

export interface WindowsInputOptions {
  /** The run's proven WindowsTerminal.exe pid (owned-terminal.ts's hosted ancestor). */
  readonly pid: number
  readonly os: Win32InputOs
  /** One UIA reading of the run's TermControl; production is `readTermControl`. */
  readonly readControl: () => TermControlReading
  /** The collector's own pid, for the integrity comparison. */
  readonly collectorPid?: number
}

/** Bind the run's TermControl and return the mechanism that posts to it, refusing by name what it cannot prove. */
export function createWindowsInputMechanism(options: WindowsInputOptions): {
  mechanism: InputMechanism
  binding: WindowsInputBinding
} {
  const { pid, os } = options
  const desktops = os.desktops()
  if (desktops.input === null || desktops.input !== desktops.thread) {
    throw new WindowsInputRefused(
      `no interactive input desktop shared with the collector: input desktop ${desktops.input ?? "unreadable"}, ` +
        `collector thread desktop ${desktops.thread ?? "unreadable"}`,
    )
  }
  const collectorPid = options.collectorPid ?? process.pid
  const terminalLevel = os.integrityLevel(pid)
  const collectorLevel = os.integrityLevel(collectorPid)
  if (terminalLevel === null || collectorLevel === null) {
    throw new WindowsInputRefused(
      `integrity levels unreadable (WindowsTerminal pid ${pid}: ${terminalLevel ?? "unreadable"}, collector pid ` +
        `${collectorPid}: ${collectorLevel ?? "unreadable"}); UIPI cannot be ruled out`,
    )
  }
  if (terminalLevel > collectorLevel) {
    const name = (level: number) => INTEGRITY_NAMES[level] ?? `0x${level.toString(16)}`
    throw new WindowsInputRefused(
      `UIPI: WindowsTerminal (pid ${pid}) runs at ${name(terminalLevel)} integrity, above the collector's ` +
        `${name(collectorLevel)}; SendInput would insert and the terminal would not receive`,
    )
  }
  const bound = options.readControl()
  if (bound.status === "refused") throw new WindowsInputRefused(`the run's TermControl is not bound: ${bound.reason}`)
  if (bound.topLevel === 0n) {
    throw new WindowsInputRefused("the TermControl's top-level window reports no native handle")
  }
  if (hwnd32(os.rootOf(bound.topLevel)) !== hwnd32(bound.topLevel)) {
    throw new WindowsInputRefused(`UIA's top-level window ${hex(bound.topLevel)} is not a root window`)
  }
  let evidence: string
  if (bound.control === 0n) {
    evidence = `the only TermControl under pid ${pid} has no native handle; bound to ${hex(bound.topLevel)} by UIA ancestry`
  } else {
    const root = os.rootOf(bound.control)
    if (hwnd32(root) !== hwnd32(bound.topLevel)) {
      throw new WindowsInputRefused(
        `the TermControl's handle ${hex(bound.control)} has root ${hex(root)}, not UIA's top-level ${hex(bound.topLevel)}`,
      )
    }
    evidence = `the only TermControl under pid ${pid}, handle ${hex(bound.control)}, has root ${hex(bound.topLevel)}`
  }
  const binding: WindowsInputBinding = { pid, topLevel: bound.topLevel, control: bound.control, evidence }

  let buttonHeld = false

  /** Every check a post needs, read fresh; returns the control's frame in physical screen pixels. */
  function target(pointer: boolean): OwnedFrame {
    const reading = options.readControl()
    if (reading.status === "refused") {
      throw new WindowsInputRefused(`the run's TermControl cannot be read: ${reading.reason}`)
    }
    if (hwnd32(reading.topLevel) !== hwnd32(binding.topLevel)) {
      throw new WindowsInputRefused(
        `the TermControl is now under ${hex(reading.topLevel)}, not the bound window ${hex(binding.topLevel)}`,
      )
    }
    if (!reading.focused) {
      throw new WindowsInputRefused(
        "keyboard focus is not on the run's TermControl (UIA HasKeyboardFocus is false); another control of " +
          "Windows Terminal, such as a tab or the search box, would receive the input",
      )
    }
    const foreground = os.foreground()
    if (hwnd32(foreground.hwnd) !== hwnd32(binding.topLevel) || foreground.pid !== pid) {
      throw new WindowsInputRefused(
        `the foreground window is ${hex(foreground.hwnd)} of pid ${foreground.pid}, not the bound ` +
          `${hex(binding.topLevel)} of pid ${pid}`,
      )
    }
    const focus = os.focusedWindow(foreground.tid)
    if (!focus || focus.pid !== pid) {
      throw new WindowsInputRefused(
        focus
          ? `hwndFocus ${hex(focus.hwnd)} belongs to pid ${focus.pid}, not WindowsTerminal pid ${pid}`
          : `GetGUIThreadInfo names no focus window for thread ${foreground.tid}`,
      )
    }
    const client = os.clientFrame(binding.topLevel)
    if (!client) throw new WindowsInputRefused(`the client area of ${hex(binding.topLevel)} cannot be read`)
    if (!contains(client, reading.frame)) {
      throw new WindowsInputRefused(
        `the TermControl ${JSON.stringify(reading.frame)} is not inside the window's client area ${JSON.stringify(client)}`,
      )
    }
    if (pointer) {
      const window = os.windowFrame(binding.topLevel)
      if (!window || window.width !== reading.window.width || window.height !== reading.window.height) {
        throw new WindowsInputRefused(
          `UIA reports the window as ${reading.window.width}x${reading.window.height} and GetWindowRect as ` +
            `${window ? `${window.width}x${window.height}` : "unreadable"}: UIA coordinates are scaled, so no pointer is placed`,
        )
      }
    }
    return reading.frame
  }

  function insert(events: readonly Win32InputEvent[], what: string): void {
    let inserted: number | null = null
    try {
      inserted = os.sendInput(events)
    } finally {
      const owed = owedReleases(events, inserted)
      // The release has its own try: a fault here is reported beside the original outcome, never in place of it.
      let released = "0"
      try {
        released = String(owed.length > 0 ? os.sendInput(owed) : 0)
      } catch (releaseError) {
        released = `none (the release threw: ${releaseError instanceof Error ? releaseError.message : String(releaseError)})`
      }
      if (inserted !== null && inserted !== events.length) {
        throw new WindowsInputNotInserted(
          `SendInput inserted ${inserted} of ${events.length} events for ${what} (GetLastError ${os.lastError()})` +
            (owed.length > 0 ? `; released ${released} of ${owed.length} owed key presses` : "") +
            "; insertion is not delivery, and a short insert is harness evidence, never the terminal's answer",
        )
      }
    }
  }

  function pointerInside(frame: OwnedFrame, verb: string): void {
    const cursor = os.cursor()
    if (!cursor || !inside(frame, cursor)) {
      throw new WindowsInputRefused(
        `${verb} refused: the pointer is at ${cursor ? `${cursor.x},${cursor.y}` : "an unreadable position"}, ` +
          `outside the TermControl ${JSON.stringify(frame)}`,
      )
    }
  }

  /** A held primary button is let go before a refusal, so a failed drag leaves no button down. */
  function releasingHeld<T>(action: () => T): T {
    try {
      return action()
    } catch (error) {
      if (buttonHeld) {
        buttonHeld = false
        os.sendInput([{ kind: "mouse", dx: 0, dy: 0, mouseData: 0, flags: MOUSEEVENTF_LEFTUP }])
      }
      throw error
    }
  }

  const mechanism: InputMechanism = {
    focus: () =>
      later(() => {
        let foreground = os.foreground()
        if (hwnd32(foreground.hwnd) === hwnd32(binding.topLevel)) return
        os.setForeground(binding.topLevel)
        foreground = os.foreground()
        if (hwnd32(foreground.hwnd) === hwnd32(binding.topLevel)) return
        // One bounded attach, on the desktop proven at creation, to the current foreground thread.
        const self = os.currentThreadId()
        if (!os.attachThreadInput(self, foreground.tid, true)) {
          throw new WindowsInputRefused(
            `SetForegroundWindow(${hex(binding.topLevel)}) did not take and AttachThreadInput to thread ` +
              `${foreground.tid} failed (GetLastError ${os.lastError()})`,
          )
        }
        try {
          os.setForeground(binding.topLevel)
        } finally {
          os.attachThreadInput(self, foreground.tid, false)
        }
        const after = os.foreground()
        if (hwnd32(after.hwnd) !== hwnd32(binding.topLevel)) {
          throw new WindowsInputRefused(
            `the foreground window is still ${hex(after.hwnd)} of pid ${after.pid} after one attached ` +
              `SetForegroundWindow(${hex(binding.topLevel)})`,
          )
        }
      }),
    geometry: () =>
      later(() => {
        const frame = target(true)
        return { x: 0, y: 0, width: frame.width, height: frame.height }
      }),
    moveTo: (x, y, moveOptions) =>
      later(() =>
        releasingHeld(() => {
          const frame = target(true)
          if (x < 0 || y < 0 || x >= frame.width || y >= frame.height) {
            throw new WindowsInputRefused(
              `pointer ${x},${y} is outside the TermControl ${frame.width}x${frame.height}; nothing was sent`,
            )
          }
          const point = { x: frame.x + x, y: frame.y + y }
          const { dx, dy } = toAbsolute(point, os.virtualScreen())
          insert(
            [
              {
                kind: "mouse",
                dx,
                dy,
                mouseData: 0,
                flags: MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK,
              },
            ],
            moveOptions.dragged ? "a dragged pointer move" : "a pointer move",
          )
          if (moveOptions.verifyPointer) {
            const cursor = os.cursor()
            if (!cursor || Math.abs(cursor.x - point.x) > 1 || Math.abs(cursor.y - point.y) > 1) {
              throw new WindowsInputRefused(
                `the pointer read back at ${cursor ? `${cursor.x},${cursor.y}` : "an unreadable position"}, not ${point.x},${point.y}`,
              )
            }
          }
        }),
      ),
    click: (button: InputButton) =>
      later(() =>
        releasingHeld(() => {
          pointerInside(target(true), "a click")
          const events: Win32InputEvent[] =
            button === 1
              ? [
                  { kind: "mouse", dx: 0, dy: 0, mouseData: 0, flags: MOUSEEVENTF_LEFTDOWN },
                  { kind: "mouse", dx: 0, dy: 0, mouseData: 0, flags: MOUSEEVENTF_LEFTUP },
                ]
              : [
                  {
                    kind: "mouse",
                    dx: 0,
                    dy: 0,
                    mouseData: button === 4 ? WHEEL_DELTA : -WHEEL_DELTA,
                    flags: MOUSEEVENTF_WHEEL,
                  },
                ]
          insert(events, button === 1 ? "a primary click" : `one wheel notch (button ${button})`)
        }),
      ),
    press: (button: InputButton) =>
      later(() => {
        if (button !== 1) throw new WindowsInputRefused(`button ${button} has no press: it is a wheel notch`)
        pointerInside(target(true), "a button press")
        insert([{ kind: "mouse", dx: 0, dy: 0, mouseData: 0, flags: MOUSEEVENTF_LEFTDOWN }], "a primary press")
        buttonHeld = true
      }),
    release: (button: InputButton) =>
      later(() => {
        if (button !== 1) throw new WindowsInputRefused(`button ${button} has no release: it is a wheel notch`)
        releasingHeld(() => {
          pointerInside(target(true), "a button release")
          buttonHeld = false
          insert([{ kind: "mouse", dx: 0, dy: 0, mouseData: 0, flags: MOUSEEVENTF_LEFTUP }], "a primary release")
        })
      }),
    key: (keys: string) =>
      later(() => {
        const events = keyEvents(keys, os)
        target(false)
        insert(events, `key ${JSON.stringify(keys)}`)
      }),
  }
  return { mechanism, binding }
}

/** The fixture over the Windows mechanism: the one adapter body, labelled SendInput in refusals. */
export function createWindowsInput(mechanism: InputMechanism): InputFixture {
  return createInjectedInput(mechanism, "SendInput")
}

/**
 * The Windows PowerShell 5.1 script that reads the run's TermControl: exactly one under `pid`, the
 * top-level window its own raw-view ancestry reaches (which must be the window it was found under),
 * that window's handle and rect, the control's handle (0 when it has none), rect and keyboard focus.
 */
export function termControlScript(pid: number): string {
  if (!Number.isSafeInteger(pid) || pid < 1) {
    throw new Error(`Windows TermControl read: pid is not a count: ${String(pid)}`)
  }
  return `$ErrorActionPreference = 'Stop'
$ownerPid = ${String(pid)}
$stdout = New-Object System.IO.StreamWriter([Console]::OpenStandardOutput(), (New-Object System.Text.UTF8Encoding($false)))
function Send([string]$json) { $stdout.Write($json); $stdout.Flush() }
function Refuse([string]$reason) { Send ('{"status":"refused","reason":' + (ConvertTo-Json -InputObject $reason -Compress) + '}') }
function Rect($r) { return '{"x":' + [int][Math]::Round($r.X) + ',"y":' + [int][Math]::Round($r.Y) + ',"width":' + [int][Math]::Round($r.Width) + ',"height":' + [int][Math]::Round($r.Height) + '}' }
try {
  Add-Type -AssemblyName UIAutomationClient
  Add-Type -AssemblyName UIAutomationTypes
  $element = [System.Windows.Automation.AutomationElement]
  $scope = [System.Windows.Automation.TreeScope]
  $byPid = New-Object System.Windows.Automation.PropertyCondition($element::ProcessIdProperty, $ownerPid)
  $byClass = New-Object System.Windows.Automation.PropertyCondition($element::ClassNameProperty, 'TermControl')
  $windows = New-Object System.Collections.Generic.List[System.Windows.Automation.AutomationElement]
  $controls = New-Object System.Collections.Generic.List[System.Windows.Automation.AutomationElement]
  foreach ($window in $element::RootElement.FindAll($scope::Children, $byPid)) {
    foreach ($control in $window.FindAll($scope::Descendants, $byClass)) { $windows.Add($window); $controls.Add($control) }
  }
  if ($controls.Count -ne 1) {
    Refuse ('Windows Terminal (pid ' + $ownerPid + ') exposes ' + $controls.Count + ' TermControl elements; exactly one is required')
    exit 0
  }
  $window = $windows[0]
  $control = $controls[0]
  $walker = [System.Windows.Automation.TreeWalker]::RawViewWalker
  $node = $control
  $top = $null
  for ($depth = 0; $depth -lt 64; $depth++) {
    $parent = $walker.GetParent($node)
    if ($parent -eq $null) { break }
    if ([System.Windows.Automation.Automation]::Compare($parent, $element::RootElement)) { $top = $node; break }
    $node = $parent
  }
  if ($top -eq $null -or -not [System.Windows.Automation.Automation]::Compare($top, $window)) {
    Refuse ('the TermControl''s own ancestry does not reach the window it was found under (pid ' + $ownerPid + ')')
    exit 0
  }
  $current = $control.Current
  if ($current.BoundingRectangle.IsEmpty) { Refuse 'the TermControl reports an empty bounding rectangle'; exit 0 }
  $focused = if ($current.HasKeyboardFocus) { 'true' } else { 'false' }
  Send ('{"status":"read","topLevel":' + [uint32]$window.Current.NativeWindowHandle + ',"control":' + [uint32]$current.NativeWindowHandle + ',"frame":' + (Rect $current.BoundingRectangle) + ',"window":' + (Rect $window.Current.BoundingRectangle) + ',"focused":' + $focused + '}')
} catch {
  Refuse ('UI Automation read failed: ' + $_.Exception.Message)
}
`
}

const integer = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value)

const frameOf = (value: unknown): OwnedFrame | undefined => {
  if (typeof value !== "object" || value === null) return undefined
  const { x, y, width, height } = value as Record<string, unknown>
  return integer(x) && integer(y) && integer(width) && integer(height) && width > 0 && height > 0
    ? { x, y, width, height }
    : undefined
}

const handleOf = (value: unknown): bigint | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 0xffffffff
    ? BigInt(value)
    : undefined

/** One UIA reading of the TermControl under `pid`; `run` is the test seam, production runs powershell.exe. */
export function readTermControl(options: {
  readonly pid: number
  readonly timeoutMs?: number
  readonly run?: (script: string) => PowerShellReply
}): TermControlReading {
  const run = options.run ?? ((script: string) => runPowerShell(script, options.timeoutMs ?? 15_000))
  const classified = classifyPowerShellReply(run(termControlScript(options.pid)), {
    subject: "Windows Terminal's TermControl",
    read: "the UI Automation focus read",
    noun: "reading",
  })
  if (classified.status === "refused") return classified
  const parsed = classified.value as Record<string, unknown>
  const topLevel = handleOf(parsed.topLevel)
  const control = handleOf(parsed.control)
  const frame = frameOf(parsed.frame)
  const window = frameOf(parsed.window)
  if (
    parsed.status !== "read" ||
    topLevel === undefined ||
    control === undefined ||
    !frame ||
    !window ||
    typeof parsed.focused !== "boolean"
  ) {
    return { status: "refused", reason: "Windows Terminal's TermControl returned an unrecognised reading" }
  }
  return { status: "read", topLevel, control, frame, window, focused: parsed.focused }
}
