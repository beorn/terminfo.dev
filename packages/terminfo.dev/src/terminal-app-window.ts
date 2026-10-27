/** Exact owned terminal window tests and live GUI process identity. No process runs at module load. */
import { spawnSync } from "node:child_process"
import { realpathSync } from "node:fs"
import {
  argvCarriesMarker,
  assertOwnedProcess,
  markerText,
  processCommand,
  processExecutable,
  run,
  tty,
  type OwnedProcess,
  type ProcessMarker,
} from "./owned-process.ts"

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
  | {
      provider: "cli-process"
      /** The live pid the launch resolved and recorded. Assert and close read this pid and no other. */
      ownerPid: number
      tty: string
      /** The GUI owner's realpath, never the CLI shim's. */
      executablePath: string
      /** The run-scoped argv marker the launch passed; the live pid must still carry it. */
      marker: ProcessMarker
    }

export type TerminalAppWindow = Extract<OwnedTerminalWindow, { provider: "terminal-app" }>
export type KittyWindow = Extract<OwnedTerminalWindow, { provider: "kitty" }>
export type CliProcessWindow = Extract<OwnedTerminalWindow, { provider: "cli-process" }>

/** The four fields the kitty serve script records, in order. */
export interface KittyIdentity {
  windowId: number
  kittyPid: number
  tty: string
  term: string
}

/** The TTY a launched window recorded for itself, normalized and refused by name when it is unusable.
 * A non-pty shell prints the literal "not a tty"; turning that into "/dev/not a tty" would record a TTY
 * no live window can own. */
export function recordedOwnerTty(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length === 0) {
    throw new Error("cli-process launch recorded no TTY in its launched window; refusing to guess the owner's TTY")
  }
  if (trimmed === "not a tty") {
    throw new Error(
      'cli-process launch recorded "not a tty": the serve script did not run in a pty, so the window has no controlling TTY; refusing to fabricate one',
    )
  }
  return tty(trimmed)
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

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** kitty's arm is the shared proof with its run-scoped instance group as the marker. */
export function kittyOwnedProcess(window: KittyWindow): OwnedProcess {
  return {
    ownerPid: window.kittyPid,
    executablePath: window.executablePath,
    marker: { flag: "--instance-group", value: window.instanceGroup },
    tty: window.tty,
  }
}

/** Every live pid that runs `executablePath` and carries the marker as an exact argv token. */
export function findOwnerPids(executablePath: string, marker: ProcessMarker): number[] {
  const expected = realpathSync(executablePath)
  const owners: number[] = []
  for (const line of run("/bin/ps", ["-ww", "-A", "-o", "pid=,command="]).stdout.split(/\r?\n/)) {
    const match = /^\s*([0-9]+)\s+(\S.*)$/.exec(line)
    if (match === null) continue
    const rawPid = match[1]
    const command = match[2]
    if (rawPid === undefined || command === undefined) continue
    if (!argvCarriesMarker(command.split(/\s+/), marker)) continue
    const pid = Number(rawPid)
    if (processExecutable(pid, "cli-process") === expected) owners.push(pid)
  }
  return owners
}

/**
 * Resolve the one owner a launch record names, once, right after the daemon registers. Zero live
 * matches means the marker vanished with the shim that carried it; several means the record cannot say
 * which process this run owns. Both are refusals: a guess here would let assert and close act on a
 * process the launch never created.
 */
export function resolveOwnedProcessByMarker(input: {
  executablePath: string
  marker: ProcessMarker
  tty: string
}): CliProcessWindow {
  const owners = findOwnerPids(input.executablePath, input.marker)
  const [onlyOwner] = owners
  if (onlyOwner === undefined) {
    throw new Error(
      `cli-process owner resolution: no live process runs ${input.executablePath} carrying the run-scoped marker ${markerText(input.marker)}`,
    )
  }
  if (owners.length > 1) {
    throw new Error(
      `cli-process owner resolution: ${owners.length} live processes run ${input.executablePath} carrying the run-scoped marker ${markerText(input.marker)}; the owner is ambiguous`,
    )
  }
  return {
    provider: "cli-process",
    ownerPid: onlyOwner,
    executablePath: input.executablePath,
    marker: input.marker,
    tty: input.tty,
  }
}

/**
 * Recheck the recorded owner and signal only it. The pid is never re-resolved: close signals the one
 * process the launch recorded, and refuses when it no longer runs that binary or carries that marker,
 * so a pid reused by another instance of the same app is never signalled. No process group is involved.
 */
function closeOwnedProcess(owned: OwnedProcess, who: string): void {
  const liveExecutable = processExecutable(owned.ownerPid, who)
  if (liveExecutable === null) return
  if (liveExecutable !== realpathSync(owned.executablePath)) {
    throw new Error(
      `${who} owner close: pid ${owned.ownerPid} runs ${liveExecutable}, not the launched ${owned.executablePath}; not signaling it`,
    )
  }
  const argv = processCommand(owned.ownerPid)?.split(/\s+/) ?? []
  if (!argvCarriesMarker(argv, owned.marker)) {
    throw new Error(
      `${who} owner close: pid ${owned.ownerPid} does not carry the launched marker ${markerText(owned.marker)}; not signaling it`,
    )
  }
  process.kill(owned.ownerPid, "SIGTERM")
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (!processAlive(owned.ownerPid)) return
    spawnSync("sleep", ["0.1"])
  }
  // SIGTERM is a request, not a guarantee: kitty was measured surviving it for the whole window and
  // exiting only on SIGKILL (run a9710c8a3f4e6abcfd53da1e147d9b4b, 2026-10-19). The pid was verified
  // before SIGTERM, but it may have exited and been REUSED during those 5s, so both facts are checked
  // again before escalating. A reused pid is never killed.
  const escalatedExecutable = processExecutable(owned.ownerPid, who)
  if (escalatedExecutable === null) return
  if (escalatedExecutable !== realpathSync(owned.executablePath)) {
    throw new Error(
      `${who} owner close: pid ${owned.ownerPid} runs ${escalatedExecutable}, not the launched ${owned.executablePath}; not escalating to SIGKILL`,
    )
  }
  const escalatedArgv = processCommand(owned.ownerPid)?.split(/\s+/) ?? []
  if (!argvCarriesMarker(escalatedArgv, owned.marker)) {
    throw new Error(
      `${who} owner close: pid ${owned.ownerPid} does not carry the launched marker ${markerText(owned.marker)}; not escalating to SIGKILL`,
    )
  }
  process.kill(owned.ownerPid, "SIGKILL")
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (!processAlive(owned.ownerPid)) return
    spawnSync("sleep", ["0.1"])
  }
  throw new Error(`${who} owner close: pid ${owned.ownerPid} survived SIGTERM (5000ms) and SIGKILL (5000ms)`)
}

/** Refresh the owner's window assertion before handing the worker a claim. */
export function assertOwnedTerminalWindow(window: OwnedTerminalWindow, daemonPid: number): void {
  switch (window.provider) {
    case "terminal-app":
      if (!Number.isSafeInteger(daemonPid) || daemonPid < 1) throw new Error("Invalid owned daemon PID")
      run("osascript", ["-e", ownedWindowScript(window, false)])
      return
    case "kitty":
      assertOwnedProcess(kittyOwnedProcess(window), daemonPid, "kitty")
      return
    case "cli-process":
      assertOwnedProcess(window, daemonPid, "cli-process")
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
      closeOwnedProcess(kittyOwnedProcess(window), "kitty")
      return
    }
    case "cli-process": {
      closeOwnedProcess(window, "cli-process")
      return
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
