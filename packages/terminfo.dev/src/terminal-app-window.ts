/** Exact owned terminal window checks and live GUI process identity. No process runs at module load. */
import { spawnSync } from "node:child_process"
import { realpathSync } from "node:fs"

/** A window this process launched and can still prove it owns. One authority, one assert, one close. */
export type OwnedTerminalWindow =
  | { provider: "terminal-app"; windowId: number; tty: string }
  | {
      provider: "kitty"
      windowId: number
      tty: string
      kittyPid: number
      /** The exact executable the launch invoked; the live pid must still be that binary. */
      executablePath: string
      /** The run-scoped instance group the launch passed; the live pid must still carry it. */
      instanceGroup: string
    }

export type TerminalAppWindow = Extract<OwnedTerminalWindow, { provider: "terminal-app" }>
export type KittyWindow = Extract<OwnedTerminalWindow, { provider: "kitty" }>

/** The four fields the kitty serve script records, in order. */
export interface KittyIdentity {
  windowId: number
  kittyPid: number
  tty: string
  term: string
}

export function run(command: string, args: string[]): { stdout: string; stderr: string } {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 15_000 })
  if (result.error || result.status !== 0) {
    throw new Error(
      `${command} ${args[0] ?? ""} failed: ${result.error?.message ?? result.stderr ?? `exit ${result.status}`}`,
    )
  }
  return { stdout: String(result.stdout ?? ""), stderr: String(result.stderr ?? "") }
}

export function tty(value: string): string {
  const normalized = value.trim().replace(/^\/dev\//, "")
  if (!/^tty[a-zA-Z0-9._-]+$/.test(normalized)) {
    throw new Error(`Invalid Terminal tab or daemon TTY: ${JSON.stringify(value)}`)
  }
  return `/dev/${normalized}`
}

const positiveInteger = (value: string, name: string): number => {
  const parsed = Number(value)
  if (!/^[0-9]+$/.test(value) || !Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`kitty owner identity: ${name} is not a positive integer: ${JSON.stringify(value)}`)
  }
  return parsed
}

/**
 * Parse the record the serve script writes before it execs the daemon: window id, kitty pid, tty, TERM.
 * A stale or foreign record fails here by name; nothing falls back to a guess.
 */
export function parseKittyIdentity(text: string): KittyIdentity {
  const lines = text.split(/\r?\n/).filter((line) => line.length > 0)
  if (lines.length !== 4) {
    throw new Error(`kitty owner identity has ${lines.length} non-empty fields, expected 4: ${JSON.stringify(text)}`)
  }
  const [windowId, kittyPid, ttyValue, term] = lines as [string, string, string, string]
  if (!/^\/dev\/[A-Za-z0-9._-]+$/.test(ttyValue)) {
    throw new Error(`kitty owner identity: tty is not a device path: ${JSON.stringify(ttyValue)}`)
  }
  if (!term.startsWith("xterm-kitty")) {
    throw new Error(`kitty owner identity: TERM is not a kitty terminal: ${JSON.stringify(term)}`)
  }
  return {
    windowId: positiveInteger(windowId, "window id"),
    kittyPid: positiveInteger(kittyPid, "kitty pid"),
    tty: ttyValue,
    term,
  }
}

function ownedWindowScript(window: TerminalAppWindow, close: boolean): string {
  if (!Number.isSafeInteger(window.windowId) || window.windowId < 1) throw new Error("Invalid owned Terminal window ID")
  const tabTty = tty(window.tty)
  return `tell application "Terminal"
  set matchingWindows to every window whose id is ${window.windowId}
  if (count of matchingWindows) is not 1 then error "owned Terminal window no longer exists uniquely"
  set w to item 1 of matchingWindows
  if (count of tabs of w) is not 1 then error "owned Terminal window has other tabs"
  if (tty of tab 1 of w) is not ${JSON.stringify(tabTty)} then error "owned Terminal tab TTY changed"
  ${close ? "close w" : "return true"}
end tell`
}

/** The recorded parent of one pid, or null when the process is gone or unreadable. */
function parentOf(pid: number): number | null {
  const result = spawnSync("/bin/ps", ["-p", String(pid), "-o", "ppid="], { encoding: "utf8", timeout: 5_000 })
  if (result.error || result.status !== 0) return null
  const raw = String(result.stdout ?? "").trim()
  if (!/^[0-9]+$/.test(raw)) return null
  const parent = Number(raw)
  return Number.isSafeInteger(parent) && parent > 0 ? parent : null
}

function processExecutable(pid: number): string | null {
  const result = spawnSync("/bin/ps", ["-p", String(pid), "-o", "comm="], { encoding: "utf8", timeout: 5_000 })
  if (result.error || result.status !== 0) return null
  const raw = String(result.stdout ?? "").trim()
  if (!raw) return null
  try {
    return realpathSync(raw)
  } catch {
    return null
  }
}

function processCommand(pid: number): string | null {
  const result = spawnSync("/bin/ps", ["-ww", "-p", String(pid), "-o", "command="], {
    encoding: "utf8",
    timeout: 5_000,
  })
  if (result.error || result.status !== 0) return null
  const raw = String(result.stdout ?? "").trim()
  return raw.length > 0 ? raw : null
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * Walk `daemonPid`'s live parent chain until it reaches `ownerPid`. There is no hop ceiling: a chain
 * that ends at pid 1, at a vanished process, or that repeats a pid (a cycle the OS should not produce)
 * is a refusal that prints the chain it did walk.
 */
export function descendToOwner(daemonPid: number, ownerPid: number, parentOf: (pid: number) => number | null): void {
  if (!Number.isSafeInteger(daemonPid) || daemonPid < 1) {
    throw new Error(`kitty owner assertion: daemon pid is not a positive integer: ${JSON.stringify(daemonPid)}`)
  }
  if (daemonPid === ownerPid) {
    throw new Error("kitty owner assertion: the daemon and the kitty process are the same pid")
  }
  let pid = daemonPid
  const chain: number[] = [daemonPid]
  const seen = new Set<number>([daemonPid])
  for (;;) {
    const parent = parentOf(pid)
    if (parent === null || parent < 1) break
    chain.push(parent)
    if (parent === ownerPid) return
    if (parent === 1) break
    if (seen.has(parent)) {
      throw new Error(
        `kitty owner assertion: parent chain from daemon pid ${daemonPid} cycles at pid ${parent}; chain ${chain.join(" -> ")}`,
      )
    }
    seen.add(parent)
    pid = parent
  }
  throw new Error(
    `kitty owner assertion: daemon pid ${daemonPid} is not a descendant of kitty pid ${ownerPid}; chain ${chain.join(" -> ")}`,
  )
}

/**
 * Require the live kitty pid to still be the launched binary carrying the run's instance group, the
 * daemon's controlling TTY to equal the launched window's TTY, and the daemon to descend from that
 * kitty process. Every check reads the live process table; the identity file supplies only the
 * expectation. A pid that is gone, reused, or a different binary is a refusal, never a pass.
 */
function assertOwnedKittyWindow(window: KittyWindow, daemonPid: number): void {
  if (!Number.isSafeInteger(daemonPid) || daemonPid < 1) {
    throw new Error(`kitty owner assertion: daemon pid is not a positive integer: ${JSON.stringify(daemonPid)}`)
  }
  if (daemonPid === window.kittyPid) {
    throw new Error("kitty owner assertion: the daemon and the kitty process are the same pid")
  }
  const daemonTty = tty(run("/bin/ps", ["-p", String(daemonPid), "-o", "tty="]).stdout)
  if (daemonTty !== tty(window.tty)) {
    throw new Error(`kitty owner assertion: daemon TTY ${daemonTty} differs from the launched window TTY ${window.tty}`)
  }
  const liveExecutable = processExecutable(window.kittyPid)
  if (liveExecutable === null) {
    throw new Error(`kitty owner assertion: recorded kitty pid ${window.kittyPid} is not a running process`)
  }
  if (liveExecutable !== realpathSync(window.executablePath)) {
    throw new Error(
      `kitty owner assertion: pid ${window.kittyPid} runs ${liveExecutable}, not the launched ${window.executablePath}`,
    )
  }
  const command = processCommand(window.kittyPid)
  const argv = command?.split(/\s+/) ?? []
  const groupAt = argv.indexOf("--instance-group")
  if (groupAt < 0 || argv[groupAt + 1] !== window.instanceGroup) {
    throw new Error(
      `kitty owner assertion: pid ${window.kittyPid} does not carry the launched instance group ${window.instanceGroup}`,
    )
  }
  descendToOwner(daemonPid, window.kittyPid, parentOf)
}

/** Refresh the owner's window assertion before handing the worker a claim. */
export function assertOwnedTerminalWindow(window: OwnedTerminalWindow, daemonPid: number): void {
  switch (window.provider) {
    case "terminal-app":
      if (!Number.isSafeInteger(daemonPid) || daemonPid < 1) throw new Error("Invalid owned daemon PID")
      run("osascript", ["-e", ownedWindowScript(window, false)])
      return
    case "kitty":
      assertOwnedKittyWindow(window, daemonPid)
      return
    default: {
      const unreachable: never = window
      throw new Error(`Owned-window assertion has no provider arm: ${JSON.stringify(unreachable)}`)
    }
  }
}

/** Recheck and close atomically in the same operation: AppleScript closes Terminal; kitty gets the pid. */
export function closeOwnedTerminalWindow(window: OwnedTerminalWindow): void {
  switch (window.provider) {
    case "terminal-app":
      run("osascript", ["-e", ownedWindowScript(window, true)])
      return
    case "kitty": {
      const liveExecutable = processExecutable(window.kittyPid)
      if (liveExecutable !== null && liveExecutable !== realpathSync(window.executablePath)) {
        throw new Error(
          `kitty owner close: pid ${window.kittyPid} runs ${liveExecutable}, not the launched ${window.executablePath}; not signaling it`,
        )
      }
      if (liveExecutable !== null) process.kill(window.kittyPid, "SIGTERM")
      for (let attempt = 0; attempt < 50; attempt += 1) {
        if (!processAlive(window.kittyPid)) return
        spawnSync("sleep", ["0.1"])
      }
      throw new Error(`kitty owner close: pid ${window.kittyPid} did not exit within 5000ms`)
    }
    default: {
      const unreachable: never = window
      throw new Error(`Owned-window close has no provider arm: ${JSON.stringify(unreachable)}`)
    }
  }
}

interface RunningTerminal {
  pid: number
  bundlePath: string
  executablePath: string
}

const runningTerminalScript = `ObjC.import("AppKit");
var apps=$.NSRunningApplication.runningApplicationsWithBundleIdentifier("com.apple.Terminal");
var out=[];
for(var i=0;i<apps.count;i++){
  var a=apps.objectAtIndex(i);
  out.push({pid:Number(a.processIdentifier),bundlePath:ObjC.unwrap(a.bundleURL.path),executablePath:ObjC.unwrap(a.executableURL.path)});
}
JSON.stringify(out)`

export function runningTerminal(): { app: RunningTerminal; raw: string } {
  const raw = run("osascript", ["-l", "JavaScript", "-e", runningTerminalScript]).stdout.trim()
  const parsed: unknown = JSON.parse(raw)
  if (!Array.isArray(parsed) || parsed.length !== 1) {
    throw new Error("Expected exactly one running com.apple.Terminal process")
  }
  const app: unknown = parsed[0]
  if (
    typeof app !== "object" ||
    app === null ||
    !("pid" in app) ||
    !Number.isSafeInteger(app.pid) ||
    Number(app.pid) < 1 ||
    !("bundlePath" in app) ||
    typeof app.bundlePath !== "string" ||
    !app.bundlePath.startsWith("/") ||
    !("executablePath" in app) ||
    typeof app.executablePath !== "string" ||
    !app.executablePath.startsWith("/")
  ) {
    throw new Error("Running Terminal process lacks PID, bundle or executable path")
  }
  return { app: app as RunningTerminal, raw }
}
