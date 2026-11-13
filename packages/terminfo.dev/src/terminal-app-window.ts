/** Exact owned terminal window tests and live GUI process identity. No process runs at module load. */
import { spawnSync } from "node:child_process"
import { realpathSync } from "node:fs"
import { basename } from "node:path"
import { CENSUS, censusDarwinWindows } from "./darwin-capture.ts"
import { parseLstart } from "./disposable-receipt.ts"
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
  | {
      provider: "iterm2"
      /** The window server (CG) id of the one new layer-0 window the owner pid made; never iTerm's AppleScript id. */
      windowId: number
      /** The session TTY the launch's one Apple event returned, equal to the TTY the run script recorded. */
      tty: string
      /** The one iTerm2 process of this account after a preflight that found none. */
      ownerPid: number
      executablePath: string
      /** The owner's `ps -o lstart=` start (UTC epoch seconds), no earlier than the preflight read. */
      startedAtEpochSeconds: number
    }

export type TerminalAppWindow = Extract<OwnedTerminalWindow, { provider: "terminal-app" }>
export type KittyWindow = Extract<OwnedTerminalWindow, { provider: "kitty" }>
export type CliProcessWindow = Extract<OwnedTerminalWindow, { provider: "cli-process" }>
export type Iterm2Window = Extract<OwnedTerminalWindow, { provider: "iterm2" }>

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
  ${
    close
      ? `close w
  set remaining to count of (every window whose id is ${window.windowId})
  -- A close is a request: run 42560226484 answered 1, still present, and the login shell was alive
  -- afterwards. Re-read for up to 5s before refusing, and keep the zero-match absence requirement.
  set waited to 0
  repeat while remaining is not 0 and waited < 50
    delay 0.1
    set remaining to count of (every window whose id is ${window.windowId})
    set waited to waited + 1
  end repeat
  return remaining`
      : "return true"
  }
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

const kittyMarker = (window: KittyWindow): ProcessMarker => ({ flag: "--instance-group", value: window.instanceGroup })

/** kitty's arm is the shared proof with its run-scoped instance group as the marker. */
export function kittyOwnedProcess(window: KittyWindow): OwnedProcess {
  return {
    ownerPid: window.kittyPid,
    executablePath: window.executablePath,
    basis: { kind: "marker", marker: kittyMarker(window) },
    tty: window.tty,
  }
}

const cliOwnedProcess = (window: CliProcessWindow): OwnedProcess => ({
  ownerPid: window.ownerPid,
  executablePath: window.executablePath,
  basis: { kind: "marker", marker: window.marker },
  tty: window.tty,
})

/** iTerm2's arm is the shared proof with the launch preflight as its basis: it takes no argv marker. */
export const iterm2OwnedProcess = (window: Iterm2Window): OwnedProcess => ({
  ownerPid: window.ownerPid,
  executablePath: window.executablePath,
  basis: { kind: "sole-instance", preflightAbsent: true },
  tty: window.tty,
})

/** One live process of THIS account that runs the named executable, with its start time. */
export interface AccountProcess {
  pid: number
  startedAtEpochSeconds: number
}

const ACCOUNT_PROCESS_ROW =
  /^\s*([0-9]+)\s+((?:Sun|Mon|Tue|Wed|Thu|Fri|Sat) [A-Z][a-z]{2} [ 1-3]?[0-9] [0-9]{2}:[0-9]{2}:[0-9]{2} [0-9]{4})\s+(\S.*)$/

/**
 * Every process of the current account (uid) whose executable realpath is `executablePath`. The listing
 * is restricted to this uid, so another account's process is never read (@cto 11983ea0, condition 4).
 * An unreadable listing or an unparseable row refuses by name; nothing is skipped silently.
 */
export function accountProcessesRunning(executablePath: string, who: string): AccountProcess[] {
  const uid = process.getuid?.()
  if (uid === undefined) throw new Error(`${who} process census needs this account's uid, and this platform has none`)
  const expected = realpathSync(executablePath)
  const args = ["-ww", "-U", String(uid), "-o", "pid=,lstart=,comm="]
  const result = spawnSync("/bin/ps", args, {
    encoding: "utf8",
    timeout: 5_000,
    env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
  })
  if (result.error || result.status !== 0) {
    const detail = result.error?.message ?? (String(result.stderr ?? "").trim() || `exit ${String(result.status)}`)
    throw new Error(`${who} process census: /bin/ps ${args.join(" ")} failed: ${detail}`)
  }
  const found: AccountProcess[] = []
  for (const line of String(result.stdout ?? "").split(/\r?\n/)) {
    if (line.trim() === "") continue
    const [, rawPid, lstart, comm] = ACCOUNT_PROCESS_ROW.exec(line) ?? []
    if (rawPid === undefined || lstart === undefined || comm === undefined) {
      throw new Error(`${who} process census: unparseable ps row ${JSON.stringify(line)}`)
    }
    const command = comm.trim()
    // Only a row naming the same executable file is resolved; every other row is another program.
    if (basename(command) !== basename(expected) || realpathSync(command) !== expected) continue
    found.push({ pid: Number(rawPid), startedAtEpochSeconds: parseLstart(lstart) })
  }
  return found
}

/** The window server's rows, read by the one existing reader (darwin-capture.ts CENSUS); no Apple event. */
export function readDarwinWindowRows(): unknown[] {
  const rows: unknown = JSON.parse(run("/usr/bin/osascript", ["-l", "JavaScript", "-e", CENSUS]).stdout)
  if (!Array.isArray(rows)) throw new Error("Darwin window census returned no window list")
  return rows
}

/** The ids of every layer-0 window `pid` owns in one census read. */
export function layerZeroWindowIds(rows: readonly unknown[], pid: number): number[] {
  return rows.flatMap((row) => {
    if (!row || typeof row !== "object") throw new Error("Darwin window census contains a non-object row")
    const { id, ownerPid, layer } = row as Record<string, unknown>
    if (typeof id !== "number" || typeof ownerPid !== "number" || typeof layer !== "number") {
      throw new Error(`Darwin window census row lacks id, owner or layer: ${JSON.stringify(row)}`)
    }
    return ownerPid === pid && layer === 0 ? [id] : []
  })
}

/** The recorded owner as the uid-scoped census sees it now: undefined when it no longer runs that binary. */
function liveIterm2Owner(window: Iterm2Window): AccountProcess | undefined {
  return accountProcessesRunning(window.executablePath, "iterm2").find((row) => row.pid === window.ownerPid)
}

/**
 * The shared process proof (pid, binary, daemon TTY, ancestry), the same start time the launch recorded,
 * and the CG window still owned by that pid. Nothing here sends iTerm2 an Apple event.
 */
function assertIterm2Window(window: Iterm2Window, daemonPid: number): void {
  assertOwnedProcess(iterm2OwnedProcess(window), daemonPid, "iterm2")
  const live = liveIterm2Owner(window)
  if (live === undefined) {
    throw new Error(
      `iterm2 owner assertion: recorded pid ${window.ownerPid} no longer runs ${window.executablePath} under this account`,
    )
  }
  if (live.startedAtEpochSeconds !== window.startedAtEpochSeconds) {
    throw new Error(
      `iterm2 owner assertion: pid ${window.ownerPid} started at ${live.startedAtEpochSeconds}, not the launched owner's ${window.startedAtEpochSeconds}`,
    )
  }
  censusDarwinWindows(readDarwinWindowRows(), window.ownerPid, window.windowId)
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

/** Re-read the recorded owner right before a signal: false when it is gone, a throw when the pid is
 * no longer the launched owner, true when it may be signaled. `stage` ends a refusal's message. */
type OwnerRecheck = (stage: "signaling it" | "escalating to SIGKILL") => boolean

/** The marker arms' recheck: the pid still runs the launched binary and still carries the marker. */
function markerRecheck(
  owned: { ownerPid: number; executablePath: string },
  marker: ProcessMarker,
  who: string,
): OwnerRecheck {
  return (stage) => {
    const liveExecutable = processExecutable(owned.ownerPid, who)
    if (liveExecutable === null) return false
    if (liveExecutable !== realpathSync(owned.executablePath)) {
      throw new Error(
        `${who} owner close: pid ${owned.ownerPid} runs ${liveExecutable}, not the launched ${owned.executablePath}; not ${stage}`,
      )
    }
    const argv = processCommand(owned.ownerPid)?.split(/\s+/) ?? []
    if (!argvCarriesMarker(argv, marker)) {
      throw new Error(
        `${who} owner close: pid ${owned.ownerPid} does not carry the launched marker ${markerText(marker)}; not ${stage}`,
      )
    }
    return true
  }
}

/** iTerm2's recheck (@cto 11983ea0, condition 3): the same pid, binary and start time, read from this
 * account's processes only. A pid this account no longer runs as iTerm2 is never signaled. */
function iterm2Recheck(window: Iterm2Window): OwnerRecheck {
  return (stage) => {
    const live = liveIterm2Owner(window)
    if (live === undefined) return false
    if (live.startedAtEpochSeconds !== window.startedAtEpochSeconds) {
      throw new Error(
        `iterm2 owner close: pid ${window.ownerPid} started at ${live.startedAtEpochSeconds}, not the launched owner's ${window.startedAtEpochSeconds}; not ${stage}`,
      )
    }
    return true
  }
}

/**
 * Recheck the recorded owner and signal only it. The pid is never re-resolved: close signals the one
 * process the launch recorded, and refuses when the recheck says it is no longer that owner, so a pid
 * reused by another instance of the same app is never signalled. No process group is involved.
 */
function closeOwnedProcess(ownerPid: number, who: string, recheck: OwnerRecheck): void {
  if (!recheck("signaling it")) return
  process.kill(ownerPid, "SIGTERM")
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (!processAlive(ownerPid)) return
    spawnSync("sleep", ["0.1"])
  }
  // SIGTERM is a request, not a guarantee: kitty was measured surviving it for the whole window and
  // exiting only on SIGKILL (run a9710c8a3f4e6abcfd53da1e147d9b4b, 2026-10-19). The pid was verified
  // before SIGTERM, but it may have exited and been REUSED during those 5s, so it is rechecked before
  // escalating. A reused pid is never killed.
  if (!recheck("escalating to SIGKILL")) return
  process.kill(ownerPid, "SIGKILL")
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (!processAlive(ownerPid)) return
    spawnSync("sleep", ["0.1"])
  }
  throw new Error(`${who} owner close: pid ${ownerPid} survived SIGTERM (5000ms) and SIGKILL (5000ms)`)
}

/** After the owner exits, the window server must list no window for its pid. Re-read for up to 5s:
 * the server drops a dead process's windows asynchronously. */
function requireNoIterm2Windows(window: Iterm2Window): void {
  let remaining = layerZeroWindowIds(readDarwinWindowRows(), window.ownerPid)
  for (let attempt = 0; remaining.length > 0 && attempt < 50; attempt += 1) {
    spawnSync("sleep", ["0.1"])
    remaining = layerZeroWindowIds(readDarwinWindowRows(), window.ownerPid)
  }
  if (remaining.length > 0) {
    throw new Error(
      `iterm2 owner close: the window server still lists layer-0 windows ${JSON.stringify(remaining)} for pid ${window.ownerPid} after its exit`,
    )
  }
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
      assertOwnedProcess(cliOwnedProcess(window), daemonPid, "cli-process")
      return
    case "iterm2":
      assertIterm2Window(window, daemonPid)
      return
    default: {
      const unreachable: never = window
      throw new Error(`Owned-window assertion has no provider arm: ${JSON.stringify(unreachable)}`)
    }
  }
}

/** Recheck and close atomically in the same operation: AppleScript closes Terminal; kitty, cli-process and
 * iTerm2 signal their recorded pid, and iTerm2 then proves the window server lists none of its windows. */
export function closeOwnedTerminalWindow(window: OwnedTerminalWindow): string | void {
  switch (window.provider) {
    case "terminal-app": {
      const argv = ["-e", ownedWindowScript(window, true)]
      const result = spawnSync("osascript", argv, { encoding: "utf8", timeout: 15_000 })
      const trace = {
        windowId: window.windowId,
        tty: window.tty,
        command: "osascript",
        argv,
        status: result.status,
        stdout: String(result.stdout ?? ""),
        stderr: String(result.stderr ?? ""),
        ...(result.error && { error: result.error.message }),
      }
      if (result.error || result.status !== 0 || trace.stdout.trim() !== "0") {
        throw Object.assign(new Error("Owned Terminal window close and zero-match absence could not be proved"), {
          name: "CaptureRestoreFailed",
          captureCommand: trace,
        })
      }
      return JSON.stringify({ ...trace, remaining: 0 })
    }
    case "kitty": {
      closeOwnedProcess(
        window.kittyPid,
        "kitty",
        markerRecheck(kittyOwnedProcess(window), kittyMarker(window), "kitty"),
      )
      return
    }
    case "cli-process": {
      closeOwnedProcess(window.ownerPid, "cli-process", markerRecheck(window, window.marker, "cli-process"))
      return
    }
    case "iterm2": {
      closeOwnedProcess(window.ownerPid, "iterm2", iterm2Recheck(window))
      requireNoIterm2Windows(window)
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
