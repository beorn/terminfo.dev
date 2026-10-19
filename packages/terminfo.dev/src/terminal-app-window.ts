/** Exact owned terminal window checks and live GUI process identity. No process runs at module load. */
import { spawnSync } from "node:child_process"
import { realpathSync } from "node:fs"

/** How a run-scoped marker appears in a live process's argv: adjacent "--flag value", or one "--flag=value".
 * It is always an exact token, never a substring, and its value carries the run id. */
export interface ProcessMarker {
  flag: string
  value: string
}

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

/** The one process proof both process-backed arms share. kitty is this with its instance group as the marker. */
export interface OwnedProcess {
  ownerPid: number
  executablePath: string
  marker: ProcessMarker
  tty: string
}

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

/** The marker a CLI-launched app must carry into its live owner's argv, derived from the run and refused
 * by name BEFORE the launch if it could never be read back. argv is recovered from `ps` by splitting on
 * whitespace, so a value containing a space can never match and would surface later as a misleading "no
 * live process"; a value without the run id could match a process belonging to another run. */
export function runScopedMarker(input: { appName: string; runId: string; flag: string; value: string }): ProcessMarker {
  const where = `${input.appName} cli-process marker`
  if (input.flag.length === 0) {
    throw new Error(`${where} flag is empty; refusing a launch whose owner could not be proven`)
  }
  if (/\s/.test(input.flag)) {
    throw new Error(
      `${where} flag ${JSON.stringify(input.flag)} contains whitespace; argv is recovered by splitting ps output on spaces, so it could never match`,
    )
  }
  if (input.value.length === 0) {
    throw new Error(`${where} value is empty; refusing a launch whose owner could not be proven`)
  }
  if (/\s/.test(input.value)) {
    throw new Error(
      `${where} value ${JSON.stringify(input.value)} contains whitespace; argv is recovered by splitting ps output on spaces, so it could never match`,
    )
  }
  if (!input.value.includes(input.runId)) {
    throw new Error(
      `${where} value ${JSON.stringify(input.value)} does not contain the run id ${input.runId}; a process from another run could match it`,
    )
  }
  return { flag: input.flag, value: input.value }
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
  } catch (error) {
    throw new Error(`kitty owner executable lookup failed for pid ${pid} at ${JSON.stringify(raw)}`, { cause: error })
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
export function descendToOwner(
  daemonPid: number,
  ownerPid: number,
  parentOf: (pid: number) => number | null,
  who = "kitty",
): void {
  if (!Number.isSafeInteger(daemonPid) || daemonPid < 1) {
    throw new Error(`${who} owner assertion: daemon pid is not a positive integer: ${JSON.stringify(daemonPid)}`)
  }
  if (daemonPid === ownerPid) {
    throw new Error(`${who} owner assertion: the daemon and the ${who} process are the same pid`)
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
        `${who} owner assertion: parent chain from daemon pid ${daemonPid} cycles at pid ${parent}; chain ${chain.join(" -> ")}`,
      )
    }
    seen.add(parent)
    pid = parent
  }
  throw new Error(
    `${who} owner assertion: daemon pid ${daemonPid} is not a descendant of ${who} pid ${ownerPid}; chain ${chain.join(" -> ")}`,
  )
}

/**
 * Does the live argv carry the marker as an EXACT token? Either adjacent `--flag value`, or one
 * `--flag=value`. A prefix, suffix or substring hit is not a match: a marker whose value merely begins
 * the recorded value proves nothing about which run this process belongs to.
 */
export function argvCarriesMarker(argv: readonly string[], marker: ProcessMarker): boolean {
  const joined = `${marker.flag}=${marker.value}`
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === joined) return true
    if (argv[index] === marker.flag && argv[index + 1] === marker.value) return true
  }
  return false
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

function markerText(marker: ProcessMarker): string {
  return `${marker.flag} ${marker.value}`
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
    if (processExecutable(pid) === expected) owners.push(pid)
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
 * The one process proof both process-backed arms share. The pid must still run the launched binary,
 * still carry the run-scoped marker as an exact argv token, own the daemon's controlling TTY, and be an
 * ancestor of the daemon. Every check reads the live process table; the launch record supplies only the
 * expectation. A pid that is gone, reused, or a different binary is a refusal, never a pass.
 */
function assertOwnedProcess(owned: OwnedProcess, daemonPid: number, who: string): void {
  if (!Number.isSafeInteger(daemonPid) || daemonPid < 1) {
    throw new Error(`${who} owner assertion: daemon pid is not a positive integer: ${JSON.stringify(daemonPid)}`)
  }
  if (daemonPid === owned.ownerPid) {
    throw new Error(`${who} owner assertion: the daemon and the ${who} process are the same pid`)
  }
  const daemonTty = tty(run("/bin/ps", ["-p", String(daemonPid), "-o", "tty="]).stdout)
  if (daemonTty !== tty(owned.tty)) {
    throw new Error(`${who} owner assertion: daemon TTY ${daemonTty} differs from the launched window TTY ${owned.tty}`)
  }
  const liveExecutable = processExecutable(owned.ownerPid)
  if (liveExecutable === null) {
    throw new Error(`${who} owner assertion: recorded pid ${owned.ownerPid} is not a running process`)
  }
  if (liveExecutable !== realpathSync(owned.executablePath)) {
    throw new Error(
      `${who} owner assertion: pid ${owned.ownerPid} runs ${liveExecutable}, not the launched ${owned.executablePath}`,
    )
  }
  const argv = processCommand(owned.ownerPid)?.split(/\s+/) ?? []
  if (!argvCarriesMarker(argv, owned.marker)) {
    throw new Error(
      `${who} owner assertion: pid ${owned.ownerPid} does not carry the launched marker ${markerText(owned.marker)}`,
    )
  }
  descendToOwner(daemonPid, owned.ownerPid, parentOf, who)
}

/**
 * Recheck the recorded owner and signal only it. The pid is never re-resolved: close signals the one
 * process the launch recorded, and refuses when it no longer runs that binary or carries that marker,
 * so a pid reused by another instance of the same app is never signalled. No process group is involved.
 */
function closeOwnedProcess(owned: OwnedProcess, who: string): void {
  const liveExecutable = processExecutable(owned.ownerPid)
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
  throw new Error(`${who} owner close: pid ${owned.ownerPid} did not exit within 5000ms`)
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
