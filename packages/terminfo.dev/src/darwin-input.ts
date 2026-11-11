import { existsSync } from "node:fs"

import type { InputFixture } from "@terminfo/probe-defs"
import { command } from "./capture-core.ts"
import { createInjectedInput, type InputButton, type InputMechanism, type OwnedFrame } from "./input-fixture.ts"

/** The compiled helper the macOS job builds from native/darwin-input/main.swift; never a committed binary. */
export const DARWIN_INPUT_HELPER_ENV = "TERMINFO_DARWIN_INPUT_HELPER"

/** The keysym the install self-test posts before any probe may use the adapter (#33574 C3). */
export const DARWIN_INPUT_SELF_TEST_KEYSYM = "z"

/**
 * The second route, for the diagnostic run: a virtual keycode with NO unicode payload. The plain
 * keysym sends virtual keycode 0 WITH a unicode payload, so a null first probe and an echoing second
 * one name the defect as the unicode payload rather than delivery.
 *
 * It posts a DIFFERENT key on purpose. The reader arms before each injection and a late echo of the
 * first probe can arrive inside the second probe's window; with the same key that echo would be read
 * as proof the keycode route delivers. kVK_ANSI_X is code 7, so the second probe waits for "x" and a
 * "z" arriving late can never be counted as its echo.
 */
export const DARWIN_INPUT_SELF_TEST_KEYCODE_KEYSYM = "code:7"

/** What the second probe's key echoes; distinct from the first probe's, so the routes stay separable. */
export const DARWIN_INPUT_SELF_TEST_KEYCODE_ECHO = "x"

export interface DarwinWindowFrame extends OwnedFrame {
  readonly id: number
}

/** The window a run launched, from its own launch receipt: the window to target and the tty inside it. */
export interface DarwinLaunchTarget {
  readonly windowId: number
  readonly windowTty?: string
}

export interface DarwinInputOptions {
  /** The measured app PID: every event is posted to this process. */
  readonly appPid: number
  /** The app's name, for a refusal a reader can act on. */
  readonly appName: string
  /** The helper the job compiled; absent names the missing binary rather than guessing a path. */
  readonly helperPath: string | undefined
  /**
   * The window the run's own launch receipt recorded, and the tty inside it. When present the
   * adapter targets THAT window and refuses when it is not the app's front window, instead of
   * guessing the app's largest window (#33574; run 43106790420 named window 33 on /dev/ttys001
   * while another Terminal window was open).
   */
  readonly windowId?: number
  readonly windowTty?: string | undefined
  /**
   * Post one key through the fresh adapter and return what the app's own TTY echoed, or null when
   * nothing came back. The install refuses BY NAME when this is null, so no probe reads a row that
   * the runner never delivered (#33574 C3).
   */
  readonly selfTest: (inject: () => Promise<void>) => Promise<string | null>
  /** Records the route and self-test outcome on the run; never silent. */
  readonly report?: (fact: string) => void
  /** Test seam: the platform operations, in place of the built helper. */
  readonly mechanism?: InputMechanism
}

function requireAppPid(appPid: number): void {
  if (!Number.isSafeInteger(appPid) || appPid < 2) {
    throw new Error(`macOS input requires the measured app PID; got ${String(appPid)}`)
  }
}

/**
 * The window the events must land in: the run's own launched window when the receipt named one,
 * otherwise the largest layer-0 on-screen window the app owns.
 */
export function selectDarwinInputWindow(rows: unknown, appPid: number, expectedWindowId?: number): DarwinWindowFrame {
  if (!Array.isArray(rows)) throw new Error("macOS input window census is not an array")
  const owned = rows
    .map((row: unknown) => {
      if (!row || typeof row !== "object" || Array.isArray(row)) {
        throw new Error("macOS input window census contains a non-object row")
      }
      const value = row as Record<string, unknown>
      const { id, x, y, width, height } = value
      for (const [name, field] of Object.entries({ id, x, y, width, height })) {
        if (typeof field !== "number" || !Number.isFinite(field)) {
          throw new Error(`macOS input window census row has no finite ${name}`)
        }
      }
      return { id: id as number, x: x as number, y: y as number, width: width as number, height: height as number }
    })
    .filter((frame) => frame.width >= 1 && frame.height >= 1)
    .sort((left, right) => right.width * right.height - left.width * left.height)
  if (expectedWindowId !== undefined) {
    const expected = owned.find((frame) => frame.id === expectedWindowId)
    if (!expected) {
      throw new Error(
        `macOS input targets the run's own window ${expectedWindowId}, which is not among the ` +
          `${owned.length} usable window(s) the app owns of the ${rows.length} listed for pid ${appPid}`,
      )
    }
    return expected
  }
  const selected = owned[0]
  if (!selected) {
    throw new Error(
      `macOS input has no on-screen window to target for pid ${appPid}; ` +
        `the app owns ${owned.length} usable window(s) of the ${rows.length} listed`,
    )
  }
  return selected
}

/**
 * One mechanism over the built Swift helper. Every posting goes through the HID event tap, so the
 * event stream is the one a real keyboard produces; the helper refuses at build time when the
 * Accessibility grant is missing, and this module never writes TCC (@cto 2026-11-11, 33574 C1).
 */
function helperMechanism(
  helperPath: string,
  appPid: number,
  target: { windowId?: number; windowTty?: string },
): InputMechanism {
  const run = async (...args: string[]): Promise<string> => (await command(helperPath, args)).toString().trim()
  let frame: DarwinWindowFrame | undefined
  const ownedFrame = async (): Promise<DarwinWindowFrame> => {
    frame ??= selectDarwinInputWindow(JSON.parse(await run("windows", String(appPid))), appPid, target.windowId)
    return frame
  }
  const globalPoint = async (x: number, y: number): Promise<{ x: number; y: number }> => {
    const window = await ownedFrame()
    return { x: window.x + x, y: window.y + y }
  }
  return {
    async focus() {
      // The helper refuses by name when the target window is not the app's front window, because a
      // posting then lands in another window and its silence would be read as terminal behaviour.
      await run("front", String(appPid), ...(target.windowId === undefined ? [] : [String(target.windowId)]))
    },
    async geometry() {
      return ownedFrame()
    },
    async moveTo(x: number, y: number, options: { verifyPointer: boolean; dragged: boolean }) {
      const point = await globalPoint(x, y)
      await run("mouse", "move", options.dragged ? "dragged" : "plain", String(point.x), String(point.y))
    },
    /** The shared body has already placed the pointer; clip/wheel act where it landed. */
    async click(button: InputButton) {
      await run("mouse", "click", String(button))
    },
    async press(button: InputButton) {
      await run("mouse", "press", String(button))
    },
    async release(button: InputButton) {
      await run("mouse", "release", String(button))
    },
    async key(keys: string) {
      await run("key", String(appPid), keys)
    },
  }
}

/**
 * Bind OS-level key/click/wheel/drag injection to the owned macOS app window. The adapter refuses by
 * name when the helper is absent or when one injected key does not come back through the app's TTY,
 * because a posting the app ignores would otherwise be read as a terminal behaviour.
 */
export async function createDarwinInput(options: DarwinInputOptions): Promise<InputFixture> {
  requireAppPid(options.appPid)
  let mechanism = options.mechanism
  if (!mechanism) {
    if (!options.helperPath) {
      throw new Error(
        `macOS input requires the built helper: ${DARWIN_INPUT_HELPER_ENV} is unset and no helper path was given`,
      )
    }
    if (!existsSync(options.helperPath)) {
      throw new Error(
        `macOS input requires the built helper: ${options.helperPath} is absent; ` +
          `the job compiles native/darwin-input/main.swift and a build failure refuses by name`,
      )
    }
    mechanism = helperMechanism(options.helperPath, options.appPid, {
      ...(options.windowId === undefined ? {} : { windowId: options.windowId }),
      windowTty: options.windowTty,
    })
  }
  const input = createInjectedInput(mechanism, "CGEvent")
  const delivered = (echoed: string | null): boolean =>
    echoed !== null && echoed.includes(DARWIN_INPUT_SELF_TEST_KEYSYM)
  const echoOf = (echoed: string | null): string => (echoed === null ? "nothing" : JSON.stringify(echoed))
  const unicodeEcho = await options.selfTest(() => input.injectKey(DARWIN_INPUT_SELF_TEST_KEYSYM))
  if (!delivered(unicodeEcho)) {
    // Second, independent probe: same key by virtual keycode with no unicode payload. Its echo moves
    // the refusal from "the runner delivers nothing" to "this app drops unicode-only postings" - a
    // different defect with a different cure - and it is stated either way, never silently dropped.
    const keycodeEcho = await options.selfTest(() => input.injectKey(DARWIN_INPUT_SELF_TEST_KEYCODE_KEYSYM))
    const keycodeDelivered = keycodeEcho !== null && keycodeEcho.includes(DARWIN_INPUT_SELF_TEST_KEYCODE_ECHO)
    const keycodeRoute = keycodeDelivered
      ? `the virtual-keycode route ("${DARWIN_INPUT_SELF_TEST_KEYCODE_KEYSYM}", which delivered ${echoOf(keycodeEcho)})`
      : `the virtual-keycode route ("${DARWIN_INPUT_SELF_TEST_KEYCODE_KEYSYM}", which echoed ${echoOf(keycodeEcho)}) also delivered nothing`
    throw new Error(
      `input not delivered to ${options.appName}: the CGEvent helper posted keysym ` +
        `"${DARWIN_INPUT_SELF_TEST_KEYSYM}" (virtual keycode 0 with a unicode payload) to pid ${options.appPid} ` +
        `and the app's TTY echoed ${echoOf(unicodeEcho)}; ${keycodeRoute}; ` +
        `refusing to measure input rows through it`,
    )
  }
  options.report?.(
    `darwin input installed: pid ${options.appPid}, window ${options.windowId ?? "largest"}, ` +
      `tty ${options.windowTty ?? "unrecorded"}, self-test echoed ${JSON.stringify(unicodeEcho)}`,
  )
  return input
}
