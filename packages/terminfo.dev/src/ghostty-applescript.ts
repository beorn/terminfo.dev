/**
 * Ghostty 1.4.0's AppleScript terminal properties, read from inside the measured app (34601).
 *
 * Source read at tag v1.4.0: macos/Ghostty.sdef:89-100 makes `terminal` an element of the application with the
 * read-only properties `name` (the title), `working directory` and `tty`; ScriptTerminal.swift returns
 * `surfaceView.pwd`, which src/termio/stream_handler.zig reportPwd fills with OSC 7's decoded local path. The
 * gate `macos-applescript` defaults to true (src/config/Config.zig:3592). The same osascript route already runs on
 * every hosted iTerm2 macOS run (iterm2-protocol.ts).
 *
 * Producer-controlled text (a title, a cwd) is only compared, never placed in script source: the script is a
 * constant per property and the owned TTY travels as an argv item.
 */
import { spawnSync } from "node:child_process"
import type { InputFixture, ViewportStep } from "@terminfo/probe-defs"
import { untilAppSemanticRead } from "./app-semantic-state.ts"

const GHOSTTY_BUNDLE_ID = "com.mitchellh.ghostty"

export type GhosttyTerminalProperty = "name" | "working directory"

const script = (property: GhosttyTerminalProperty) => `on run argv
  set ttyPath to item 1 of argv
  if not (application id "${GHOSTTY_BUNDLE_ID}" is running) then error "Ghostty is not running"
  tell application id "${GHOSTTY_BUNDLE_ID}"
    set matches to every terminal whose tty is ttyPath
    if (count of matches) is not 1 then error "owned TTY " & ttyPath & " matches " & (count of matches) & " Ghostty terminals"
    return ${property} of item 1 of matches
  end tell
end run`

/** One property of the Ghostty terminal whose TTY is the owned tab's; any osascript failure throws. */
export function readGhosttyTerminal(tty: string, property: GhosttyTerminalProperty): string {
  if (!/^\/dev\/tty[a-zA-Z0-9._-]+$/.test(tty)) {
    throw new Error(`${JSON.stringify(tty)} is not an owned TTY device path`)
  }
  const result = spawnSync("/usr/bin/osascript", ["-e", script(property), tty], {
    encoding: "utf8",
    timeout: 10_000,
    killSignal: "SIGKILL",
  })
  if (result.error || result.status !== 0 || result.signal) {
    const why = result.stderr?.trim() || result.error?.message || `status ${result.status}, signal ${result.signal}`
    throw new Error(`Ghostty AppleScript ${property} read failed: ${why}`)
  }
  // osascript ends its reply with exactly one newline; anything before it is the property's value.
  if (!result.stdout.endsWith("\n")) {
    throw new Error(`Ghostty AppleScript ${property} did not end its reply with a newline`)
  }
  return result.stdout.slice(0, -1)
}

/**
 * Ghostty 1.4.0's own viewport actions, one per held-viewport step (#37249, @cto f584ccea). Source, not a delivery
 * proof: src/input/Binding.zig:442-458 at v1.4.0 defines scroll_to_top, scroll_to_bottom, scroll_page_up and
 * scroll_page_down, and the held rows observe every step's effect before they trust it (34313).
 */
export const GHOSTTY_1_4_VIEWPORT_ACTIONS: Readonly<Record<ViewportStep, string>> = Object.freeze({
  pageUp: "scroll_page_up",
  pageDown: "scroll_page_down",
  top: "scroll_to_top",
  bottom: "scroll_to_bottom",
})

const VIEWPORT_ACTIONS: ReadonlySet<string> = new Set(Object.values(GHOSTTY_1_4_VIEWPORT_ACTIONS))

// macos/Ghostty.sdef:162-166 at v1.4.0: `perform action <text> on <terminal>` returns true when performed
// (ScriptTerminal.swift:90-94 returns false when AppleScript is disabled or the surface is gone).
const PERFORM_SCRIPT = `on run argv
  set ttyPath to item 1 of argv
  set actionName to item 2 of argv
  if not (application id "${GHOSTTY_BUNDLE_ID}" is running) then error "Ghostty is not running"
  tell application id "${GHOSTTY_BUNDLE_ID}"
    set matches to every terminal whose tty is ttyPath
    if (count of matches) is not 1 then error "owned TTY " & ttyPath & " matches " & (count of matches) & " Ghostty terminals"
    return perform action actionName on item 1 of matches
  end tell
end run`

/**
 * Perform one of Ghostty's viewport actions on the terminal whose TTY is the owned tab's. The script is constant;
 * the TTY and the action travel as argv. Anything but a performed action (a refusal, a 0 or 2+ TTY match, a
 * `false` from Ghostty, an unknown action) throws by name.
 */
export function performGhosttyViewportAction(tty: string, action: string): void {
  if (!/^\/dev\/tty[a-zA-Z0-9._-]+$/.test(tty)) {
    throw new Error(`${JSON.stringify(tty)} is not an owned TTY device path`)
  }
  if (!VIEWPORT_ACTIONS.has(action)) throw new Error(`${JSON.stringify(action)} is not a Ghostty viewport action`)
  const result = spawnSync("/usr/bin/osascript", ["-e", PERFORM_SCRIPT, tty, action], {
    encoding: "utf8",
    timeout: 10_000,
    killSignal: "SIGKILL",
  })
  if (result.error || result.status !== 0 || result.signal) {
    const why = result.stderr?.trim() || result.error?.message || `status ${result.status}, signal ${result.signal}`
    throw new Error(`Ghostty AppleScript perform action ${action} failed: ${why}`)
  }
  if (result.stdout !== "true\n") {
    throw new Error(`Ghostty AppleScript perform action ${action} was not performed: ${JSON.stringify(result.stdout)}`)
  }
}

/**
 * The viewport route's input for hosted Ghostty 1.4.0 on macOS: each step is the app's own action through
 * AppleScript, no key press (#37249). `check` re-proves the owned terminal before every Apple Event.
 */
export function ghosttyViewportInput(options: {
  readonly tty: string
  readonly check: () => void
}): Pick<InputFixture, "injectKey"> {
  return {
    injectKey(action) {
      try {
        options.check()
        performGhosttyViewportAction(options.tty, action)
        return Promise.resolve()
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)))
      }
    },
  }
}

/**
 * The owned cwd port for readAppSemanticState. A checkpoint read first writes an OSC 2 title equal to the phase's
 * marker and waits until `name` returns it: the core sends title and pwd changes through one surface mailbox in
 * order (stream_handler.zig), and the Mac app applies a title 75 ms after `pwd` (SurfaceView_AppKit.swift setTitle),
 * so a title equal to the marker means every OSC 7 written before it has reached `working directory`.
 */
export function ghosttyOwnedCwd(options: {
  readonly tty: string
  readonly write: (text: string) => void
  /** Re-proves the owned terminal before every Apple Event. */
  readonly check: () => void
}) {
  return async (checkpoint?: { row: number; marker: string }) => {
    const reads: Array<{ property: GhosttyTerminalProperty; value: string }> = []
    const read = (property: GhosttyTerminalProperty) => {
      options.check()
      const value = readGhosttyTerminal(options.tty, property)
      reads.push({ property, value })
      return value
    }
    if (checkpoint !== undefined) {
      options.write(`\x1b]2;${checkpoint.marker}\x07`)
      await untilAppSemanticRead(
        () => read("name"),
        (title) => title === checkpoint.marker,
        "Ghostty title fence",
        [],
      )
    }
    const path = read("working directory")
    return { path, detail: { tty: options.tty, reads } }
  }
}
