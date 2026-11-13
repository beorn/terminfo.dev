/**
 * The owned iTerm2 launch (33845, @cto 11983ea0). iTerm2 takes no argv marker, so ownership rests on a
 * preflight: no iTerm2 of this account runs before the launch, exactly one started after it runs once
 * the daemon registers, and exactly one new layer-0 CG window belongs to that pid. The launch is the ONE
 * Apple event iTerm2 receives; assert and close read processes and the window server only.
 * No process runs at module load.
 */
import { isAbsolute } from "node:path"
import { run, tty } from "../../terminfo.dev/src/owned-process.ts"
import {
  accountProcessesRunning,
  layerZeroWindowIds,
  readDarwinWindowRows,
  type Iterm2Window,
} from "../../terminfo.dev/src/terminal-app-window.ts"
import { censusDarwinWindows } from "../../terminfo.dev/src/darwin-capture.ts"

/** A cold iTerm2 start answers its first Apple event late; the preflight guarantees a cold start. */
export const ITERM2_LAUNCH_TIMEOUT_MS = 90_000

/** What the launch measured before and during its one Apple event; resolved once the daemon registers. */
export interface Iterm2Launch {
  executablePath: string
  /** Whole UTC seconds, read immediately before the preflight process census. */
  preflightAtEpochSeconds: number
  /** Every CG window id before the launch. */
  beforeWindowIds: number[]
  /** iTerm's own AppleScript window id: retained as evidence only, never a CG id or a close target. */
  appleScriptWindowId: number
  /** `tty of current session` of the created window, from the same Apple event. */
  tty: string
}

/** The one Apple event's reply: iTerm's window id, then the new window's session TTY. */
export function parseIterm2LaunchReply(output: string): { appleScriptWindowId: number; tty: string } {
  const lines = output.trim().split(/\r?\n/)
  const [rawId, rawTty] = lines
  if (lines.length !== 2 || rawId === undefined || rawTty === undefined) {
    throw new Error(
      `iTerm2 launch returned ${lines.length} lines, expected its window id and session TTY: ${JSON.stringify(output)}`,
    )
  }
  const appleScriptWindowId = Number(rawId.trim())
  if (!/^[1-9][0-9]*$/.test(rawId.trim()) || !Number.isSafeInteger(appleScriptWindowId)) {
    throw new Error(`iTerm2 launch returned no window id: ${JSON.stringify(rawId)}`)
  }
  return { appleScriptWindowId, tty: tty(rawTty) }
}

/** Refuse an iTerm2 that already runs, then create the window in the ONE allowed Apple event. */
export function launchIterm2Window(scriptPath: string, executablePath: string): Iterm2Launch {
  if (!isAbsolute(scriptPath)) {
    throw new Error(
      `iTerm2 launch requires the absolute path of the command script, but received ${JSON.stringify(scriptPath)}`,
    )
  }
  const preflightAtEpochSeconds = Math.floor(Date.now() / 1000)
  const running = accountProcessesRunning(executablePath, "iterm2")
  if (running.length > 0) {
    throw new Error(
      `iTerm2 is already running for this account (pids ${running.map((row) => row.pid).join(", ")}); an owned iTerm2 run needs it absent so the one instance after launch is provably this run's. Quit iTerm2 and rerun`,
    )
  }
  const beforeWindowIds = readDarwinWindowRows().flatMap((row) => {
    const id = (row as { id?: unknown } | null)?.id
    if (typeof id !== "number") throw new Error(`Darwin window census row lacks an id: ${JSON.stringify(row)}`)
    return [id]
  })
  const script = `tell application "iTerm"
  set w to (create window with default profile command ${JSON.stringify(scriptPath)})
  return ((id of w) as string) & linefeed & ((tty of current session of w) as string)
end tell`
  const reply = parseIterm2LaunchReply(run("osascript", ["-e", script], { timeoutMs: ITERM2_LAUNCH_TIMEOUT_MS }).stdout)
  return { executablePath, preflightAtEpochSeconds, beforeWindowIds, ...reply }
}

/**
 * After the daemon registers: the Apple event's TTY must be the TTY the run script recorded; exactly one
 * iTerm2 of this account runs and it started no earlier than the preflight read (lstart has whole-second
 * resolution); and exactly one layer-0 CG window owned by it is new. Every other shape refuses by name;
 * nothing picks one of several (@cto 11983ea0, condition 2).
 */
export function resolveIterm2Window(launch: Iterm2Launch, recordedTty: string): Iterm2Window {
  const recorded = tty(recordedTty)
  if (recorded !== launch.tty) {
    throw new Error(
      `iTerm2 launch: the Apple event's session TTY ${launch.tty} differs from the TTY ${recorded} the run script recorded`,
    )
  }
  const processes = accountProcessesRunning(launch.executablePath, "iterm2")
  const [owner] = processes
  if (owner === undefined || processes.length !== 1) {
    throw new Error(
      `iTerm2 launch: expected exactly one ${launch.executablePath} process for this account after launch; found ${processes.length} (pids ${processes.map((row) => row.pid).join(", ") || "none"})`,
    )
  }
  if (owner.startedAtEpochSeconds < launch.preflightAtEpochSeconds) {
    throw new Error(
      `iTerm2 launch: pid ${owner.pid} started at ${owner.startedAtEpochSeconds}, before the preflight read at ${launch.preflightAtEpochSeconds}; it is not this run's instance`,
    )
  }
  const rows = readDarwinWindowRows()
  const before = new Set(launch.beforeWindowIds)
  const fresh = layerZeroWindowIds(rows, owner.pid).filter((id) => !before.has(id))
  const [windowId] = fresh
  if (windowId === undefined || fresh.length !== 1) {
    throw new Error(
      `iTerm2 launch: expected exactly one new layer-0 window owned by pid ${owner.pid}; found ${fresh.length} (${JSON.stringify(fresh)}). Several means restored sessions or a second window, and none is picked`,
    )
  }
  // The existing census checks the one new window is on screen and not transparent.
  censusDarwinWindows(rows, owner.pid, windowId)
  return {
    provider: "iterm2",
    windowId,
    tty: launch.tty,
    ownerPid: owner.pid,
    executablePath: launch.executablePath,
    startedAtEpochSeconds: owner.startedAtEpochSeconds,
  }
}
