/**
 * The owned iTerm2 launch (33845, @cto 11983ea0 amended by e1efdd39). Ownership rests on a
 * preflight: no iTerm2 of this account runs before the launch, exactly one started after it runs once
 * the daemon registers, and exactly one new layer-0 CG window belongs to that pid. The shared CLI launcher
 * isolates startup with a private suite and command; no iTerm Apple event is sent.
 * No process runs at module load.
 */
import { isAbsolute } from "node:path"
import { tty } from "../../terminfo.dev/src/owned-process.ts"
import {
  accountProcessesRunning,
  layerZeroWindowIds,
  readDarwinWindowRows,
  type Iterm2Window,
} from "../../terminfo.dev/src/terminal-app-window.ts"
import { censusDarwinWindows } from "../../terminfo.dev/src/darwin-capture.ts"

/** What the preflight measured before the shared CLI launch; resolved once the daemon registers. */
export interface Iterm2Launch {
  executablePath: string
  /** Whole UTC seconds, read immediately before the preflight process census. */
  preflightAtEpochSeconds: number
  /** Every CG window id before the launch. */
  beforeWindowIds: number[]
}

/** Refuse an existing instance and snapshot the host before the shared CLI launcher starts iTerm2. */
export function prepareIterm2Launch(scriptPath: string, executablePath: string): Iterm2Launch {
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
  // lstart has whole-second resolution. Launch only once the clock is past the preflight's second, so
  // a process this launch starts has a start second strictly greater than it (@cto 11983ea0, condition 2).
  const launchNotBeforeMs = (preflightAtEpochSeconds + 1) * 1000
  const waitMs = launchNotBeforeMs - Date.now()
  if (waitMs > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, waitMs)
  return { executablePath, preflightAtEpochSeconds, beforeWindowIds }
}

/**
 * After the daemon registers: exactly one
 * iTerm2 of this account runs and its start second is strictly later than the preflight read's second (lstart has whole-second
 * resolution); and exactly one layer-0 CG window owned by it is new. Every other shape refuses by name;
 * nothing picks one of several (@cto 11983ea0, condition 2).
 */
export function resolveIterm2Window(launch: Iterm2Launch, recordedTty: string): Iterm2Window {
  const recorded = tty(recordedTty)
  const processes = accountProcessesRunning(launch.executablePath, "iterm2")
  const [owner] = processes
  if (owner === undefined || processes.length !== 1) {
    throw new Error(
      `iTerm2 launch: expected exactly one ${launch.executablePath} process for this account after launch; found ${processes.length} (pids ${processes.map((row) => row.pid).join(", ") || "none"})`,
    )
  }
  if (owner.startedAtEpochSeconds <= launch.preflightAtEpochSeconds) {
    throw new Error(
      `iTerm2 launch: pid ${owner.pid} started at second ${owner.startedAtEpochSeconds}, not after the preflight read's second ${launch.preflightAtEpochSeconds}; whole-second start times cannot order it after the preflight, so it is not proven this run's instance`,
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
    // The existing live process assertion checks this against ps TTY and daemon ancestry before use.
    tty: recorded,
    ownerPid: owner.pid,
    executablePath: launch.executablePath,
    startedAtEpochSeconds: owner.startedAtEpochSeconds,
  }
}
