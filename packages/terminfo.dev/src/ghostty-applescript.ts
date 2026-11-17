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
