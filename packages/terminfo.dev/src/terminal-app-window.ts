/** Exact owned terminal window tests and live GUI process identity. No process runs at module load. */
import { spawnSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { realpathSync } from "node:fs"
import { basename } from "node:path"
import { hostname } from "node:os"
import { OwnedCwdReadError, untilAppSemanticRead } from "./app-semantic-state.ts"
import { CENSUS, censusDarwinWindows } from "./darwin-capture.ts"
import { parseLstart } from "./disposable-receipt.ts"
import { ownedAppProofSpec, type OwnedAppProofSpec } from "./darwin-owned-app.ts"
import type { OwnedAppOwnerAssertion } from "./owned-terminal.ts"
import {
  argvCarriesMarker,
  assertOwnedProcess,
  markerText,
  processCommand,
  processExecutable,
  requireOwnWorker,
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
      ownerBirth: AccountProcess & {
        rawLstart: string
        observedAt: string
        observedByUid: number
        observedOnHost: string
      }
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
      /** The session TTY the run script recorded, verified against ps TTY and daemon ancestry. */
      tty: string
      /** The one iTerm2 process of this account after a preflight that found none. */
      ownerPid: number
      executablePath: string
      /** The owner's `ps -o lstart=` start (UTC epoch seconds), strictly later than the preflight read. */
      startedAtEpochSeconds: number
      /** The run-scoped `-suite dev.terminfo.iterm2.<runId>` argv marker; live owner must still carry it (#34080). */
      marker: ProcessMarker
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
      ? `-- Wait up to 5s for the owned tab's process to exit after SIGTERM/stop before issuing close,
  -- so Terminal.app never opens a "terminate running processes?" confirmation sheet (#34080).
  set busyWaited to 0
  repeat while (busy of tab 1 of w) is true and busyWaited < 50
    delay 0.1
    set busyWaited to busyWaited + 1
  end repeat
  close w
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

/** The existing single-PID C-locale/UTC birth reader, shared with Ghostty outer-launch measurement. */
export function readProcessBirth(pid: number): CliProcessWindow["ownerBirth"] {
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error("Process birth requires a positive PID")
  const observedByUid = process.getuid?.()
  const observedOnHost = hostname()
  if (observedByUid === undefined || !observedOnHost.trim()) {
    throw new Error("Process birth observation context unavailable")
  }
  const result = spawnSync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], {
    encoding: "utf8",
    timeout: 5_000,
    env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
  })
  if (result.error || result.signal || result.status !== 0) {
    throw new Error(
      `Process birth read failed for pid ${pid}: ${result.error?.message ?? result.stderr ?? result.status}`,
      { cause: result.error },
    )
  }
  const rawLstart = String(result.stdout ?? "")
  return {
    pid,
    rawLstart,
    startedAtEpochSeconds: parseLstart(rawLstart),
    observedAt: new Date().toISOString(),
    observedByUid,
    observedOnHost,
  }
}

function processAlive(pid: number, requireKnownState = false): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (requireKnownState && (error as NodeJS.ErrnoException).code !== "ESRCH") throw error
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

/** iTerm2's arm combines the shared marker proof (`-suite dev.terminfo.iterm2.<runId>`) with sole-instance + CG window checks (#34080, @cto d43c34cc). */
export const iterm2OwnedProcess = (window: Iterm2Window): OwnedProcess => ({
  ownerPid: window.ownerPid,
  executablePath: window.executablePath,
  basis: { kind: "marker", marker: window.marker },
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

/** The live readers the owned-app claim is re-proved against; production passes the real ones. */
export interface OwnedAppProbes {
  /** `ownedAppProofSpec` in production: the app's required proofs, or a refusal that names the app. */
  readonly proofSpec: (appId: unknown) => OwnedAppProofSpec
  readonly findOwnerPids: (executablePath: string, marker: ProcessMarker) => readonly number[]
  readonly readWindowRows: () => unknown
  /** The bundle identifier of the .app enclosing the record's executable, read live from its Info.plist. */
  readonly readBundleId: (executablePath: string) => string
  /** This worker's own controlling TTY, read live from the process table. */
  readonly workerTty: () => string
}

/**
 * The worker's own re-proof of an owned-Mac app launch (#34012, @cto 9f889378). The admin's record names
 * an expectation and nothing here is trusted from it: the app must have a required-proof entry, the claim
 * must be this worker's run, the executable's live bundle identifier must be the one that entry names, the
 * recorded tty must be this worker's own controlling tty, exactly ONE live pid may run that executable
 * with that marker and it must be the recorded one, and the census must show the recorded window owned by
 * that pid.
 *
 * `assertOwnedProcess` is deliberately NOT used: it requires the owner to descend from the daemon, and an
 * app the launcher spawned is a child of launchd, so that check would refuse a correct launch.
 */
export function assertOwnedAppOwner(
  owner: OwnedAppOwnerAssertion,
  expectedLaunchRunId: string,
  probes: OwnedAppProbes,
): void {
  const spec = probes.proofSpec(owner.appId)
  requireOwnWorker(owner, expectedLaunchRunId, "owned-app")
  // The record names the app and the executable as two separate claims, so they must be tied together:
  // otherwise a run launched as app X could be graded under app Y's proof entry.
  const bundleId = probes.readBundleId(owner.executablePath)
  if (bundleId !== spec.bundleId) {
    throw new Error(
      `owned-app owner assertion: ${owner.executablePath} is bundle ${JSON.stringify(bundleId)}, not the ` +
        `${JSON.stringify(spec.bundleId)} its ${owner.appId} proof entry requires`,
    )
  }
  // The tty the record carries is the window's, and this worker is the one drawing in it: they must agree.
  // The entry's ttyProof still runs separately before any keyboard row is graded (@cto 9f889378 3a/3b).
  const workerTty = probes.workerTty()
  if (workerTty !== owner.tty) {
    throw new Error(
      `owned-app owner assertion: the record names TTY ${owner.tty} but this worker's controlling TTY is ` +
        `${workerTty}, so it is not the worker drawing there`,
    )
  }
  const pids = probes.findOwnerPids(owner.executablePath, owner.marker)
  if (pids.length === 0) {
    throw new Error(
      `owned-app owner assertion: no live process runs ${owner.executablePath} carrying the launched ` +
        `marker ${markerText(owner.marker)}, so pid ${owner.ownerPid} is gone or was replaced`,
    )
  }
  if (pids.length > 1) {
    throw new Error(
      `owned-app owner assertion: ${String(pids.length)} live processes carry the launched marker ` +
        `${markerText(owner.marker)} (${pids.join(", ")}); one run owns one process, so none is used`,
    )
  }
  const only = pids[0]
  if (only !== owner.ownerPid) {
    throw new Error(
      `owned-app owner assertion: the launched marker ${markerText(owner.marker)} belongs to pid ${String(only)}, ` +
        `not the recorded ${owner.ownerPid}`,
    )
  }
  censusDarwinWindows(probes.readWindowRows(), owner.ownerPid, owner.windowId)
}

/**
 * The bundle identifier of the .app enclosing `executablePath`, read live from that bundle's Info.plist.
 * An executable outside a .app, or one whose plist cannot be read, refuses by name: there is nothing to
 * compare the proof entry's bundleId against.
 */
export function readBundleIdForExecutable(executablePath: string): string {
  // The pid match runs on the realpath (findOwnerPids), so the bundle read must too: a symlinked or
  // relative claim path would otherwise describe a different file than the one whose pid was proved.
  const real = realpathSync(executablePath)
  const at = real.indexOf(".app/")
  if (at < 0) {
    throw new Error(`owned-app owner assertion: ${real} is not inside a .app bundle`)
  }
  const plist = `${real.slice(0, at + ".app".length)}/Contents/Info.plist`
  const result = spawnSync("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleIdentifier", plist], { encoding: "utf8" })
  const bundleId = (result.stdout ?? "").trim()
  if (result.status !== 0 || bundleId === "") {
    throw new Error(
      `owned-app owner assertion: ${plist} did not yield a CFBundleIdentifier ` +
        `(exit ${String(result.status)}); refusing a launch whose app identity cannot be read`,
    )
  }
  return bundleId
}

/** The controlling TTY of this worker process, in the same shape the claim and census use. */
export function workerControllingTty(): string {
  return tty(run("/bin/ps", ["-p", String(process.pid), "-o", "tty="]).stdout)
}

/** The one production probe set; serve.ts passes this so there is no second place to wire. */
export const ownedAppProbes: OwnedAppProbes = {
  proofSpec: ownedAppProofSpec,
  findOwnerPids,
  readWindowRows: readDarwinWindowRows,
  readBundleId: readBundleIdForExecutable,
  workerTty: workerControllingTty,
}

/**
 * Every live pid that runs `executablePath` and carries the marker as an exact argv token. The `ps` call
 * is `-A`, so it lists every user's processes, not only this account's: matching is by realpath and by an
 * exact argv token, and the fleet Mac runs no other user's marker-carrying processes, so a foreign match
 * would have to reproduce this run's marker value exactly (@cto 50d402239 carry).
 */
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
    ownerBirth: readProcessBirth(onlyOwner),
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
  owned: { ownerPid: number; executablePath: string; ownerBirth?: CliProcessWindow["ownerBirth"] },
  marker: ProcessMarker,
  who: string,
): OwnerRecheck {
  return (stage) => {
    if (who === "cli-process") {
      const birth = owned.ownerBirth
      if (
        !birth ||
        birth.pid !== owned.ownerPid ||
        !Number.isSafeInteger(birth.startedAtEpochSeconds) ||
        !Number.isSafeInteger(birth.observedByUid) ||
        birth.observedByUid < 0 ||
        typeof birth.observedOnHost !== "string" ||
        !birth.observedOnHost.trim() ||
        typeof birth.observedAt !== "string" ||
        !Number.isFinite(Date.parse(birth.observedAt))
      ) {
        throw new Error(`cli-process owner birth evidence invalid for pid ${owned.ownerPid}; not ${stage}`)
      }
      let parsed: number
      try {
        parsed = parseLstart(birth.rawLstart)
      } catch (cause) {
        throw new Error(`cli-process owner birth evidence malformed; not ${stage}`, { cause })
      }
      if (parsed !== birth.startedAtEpochSeconds) {
        throw new Error(`cli-process owner birth raw/epoch disagree; not ${stage}`)
      }
    }
    const liveExecutable = processExecutable(owned.ownerPid, who, who === "cli-process")
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
    if (who === "cli-process") {
      const liveBirth = readProcessBirth(owned.ownerPid)
      if (liveBirth.startedAtEpochSeconds !== owned.ownerBirth?.startedAtEpochSeconds) {
        throw new Error(`cli-process owner birth changed for pid ${owned.ownerPid}; not ${stage}`)
      }
    }
    return true
  }
}

/** iTerm2's recheck (@cto 11983ea0 condition 3 + @cto d43c34cc): the same pid, binary, start time, AND
 * exact run-scoped `-suite` argv marker, read from this account's processes only. */
function iterm2Recheck(window: Iterm2Window): OwnerRecheck {
  return (stage) => {
    const live = liveIterm2Owner(window)
    if (live === undefined) return false
    if (live.startedAtEpochSeconds !== window.startedAtEpochSeconds) {
      throw new Error(
        `iterm2 owner close: pid ${window.ownerPid} started at ${live.startedAtEpochSeconds}, not the launched owner's ${window.startedAtEpochSeconds}; not ${stage}`,
      )
    }
    const argv = processCommand(window.ownerPid)?.split(/\s+/) ?? []
    if (!argvCarriesMarker(argv, window.marker)) {
      throw new Error(
        `iterm2 owner close: pid ${window.ownerPid} does not carry the launched marker ${markerText(window.marker)}; not ${stage}`,
      )
    }
    return true
  }
}

/**
 * Recheck the recorded owner and signal only it. The pid is never re-resolved: close signals the one
 * process the launch recorded, and refuses when the recheck says it is no longer that owner, so a pid
 * with an observed birth mismatch is refused. Native lstart has whole-second resolution, and a
 * check-to-signal interval remains; this is not an atomic process handle. No process group is involved.
 */
function closeOwnedProcess(ownerPid: number, who: string, recheck: OwnerRecheck, requireKnownState = false): void {
  if (!recheck("signaling it")) return
  process.kill(ownerPid, "SIGTERM")
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (!processAlive(ownerPid, requireKnownState)) return
    spawnSync("sleep", ["0.1"])
  }
  // SIGTERM is a request, not a guarantee: kitty was measured surviving it for the whole window and
  // exiting only on SIGKILL (run a9710c8a3f4e6abcfd53da1e147d9b4b, 2026-10-19). The pid was verified
  // before SIGTERM, but it may have exited and been REUSED during those 5s, so it is rechecked before
  // escalating. Refuse an observed mismatch before sending that signal.
  if (!recheck("escalating to SIGKILL")) return
  process.kill(ownerPid, "SIGKILL")
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (!processAlive(ownerPid, requireKnownState)) return
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
      closeOwnedProcess(window.ownerPid, "cli-process", markerRecheck(window, window.marker, "cli-process"), true)
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

/**
 * 34870 (@cto 34870-terminalapp-cwd-r1): Terminal.app 2.15's working directory as its window's AXDocument, the read
 * 34841's owned run qualified (/hh/var/@dev3/34841/ax-0..6.json: OSC 7 moved it, 633 P left it). One constant JXA
 * script, the TTY and the fence passed as argv, never placed in source. It goes through the Accessibility API
 * itself (ApplicationServices), NOT System Events: a hosted `tell application "System Events"` raises an Automation
 * dialog nobody answers (33821). An untrusted caller gets an AXError number back, never a dialog.
 *
 * The owned tab is the one whose TTY is the run's, alone in its window; the AX window is the single one of
 * Terminal's whose title carries the fence. A window without the fence yet answers fence-pending.
 */
export const TERMINAL_APP_DOCUMENT_SCRIPT = `ObjC.import("AppKit"); ObjC.import("ApplicationServices");
function run(argv) {
  var ttyPath = argv[0], fence = argv[1];
  function reply(value) { return JSON.stringify(value) }
  function attribute(element, name) {
    var ref = Ref();
    var error = Number($.AXUIElementCopyAttributeValue(element, $(name), ref));
    return { error: error, value: error === 0 ? ref[0] : undefined };
  }
  function text(value) {
    var object = ObjC.castRefToObject(value);
    if (object.isKindOfClass($.NSURL)) return ObjC.unwrap(object.absoluteString);
    if (object.isKindOfClass($.NSString)) return ObjC.unwrap(object);
    return null;
  }
  function owned(app) {
    var hits = [];
    for (var w = 0; w < app.windows.length; w++) {
      var tabs = app.windows[w].tabs;
      for (var t = 0; t < tabs.length; t++) if (String(tabs[t].tty()) === ttyPath) hits.push(app.windows[w]);
    }
    return hits;
  }
  try {
    var app = Application("Terminal");
    if (!app.running()) return reply({ status: "refused", phase: "owner", reason: "Terminal is not running" });
    var windows = owned(app);
    if (windows.length !== 1) return reply({ status: "refused", phase: "owner", reason: "the owned TTY is in " + windows.length + " Terminal windows" });
    var win = windows[0], windowId = Number(win.id());
    if (win.tabs.length !== 1) return reply({ status: "refused", phase: "owner", reason: "the owned Terminal window has " + win.tabs.length + " tabs" });
    if (String(win.name()).indexOf(fence) < 0) return reply({ status: "fence-pending", windowId: windowId });
    var running = $.NSRunningApplication.runningApplicationsWithBundleIdentifier("com.apple.Terminal");
    if (Number(running.count) !== 1) return reply({ status: "refused", phase: "owner", reason: Number(running.count) + " running Terminal processes" });
    var trusted = Boolean($.AXIsProcessTrusted());
    var list = attribute($.AXUIElementCreateApplication(Number(running.objectAtIndex(0).processIdentifier)), "AXWindows");
    if (list.error !== 0) return reply({ status: "ax-error", phase: "AXWindows", axError: list.error, trusted: trusted });
    var axWindows = ObjC.castRefToObject(list.value), matches = [];
    for (var i = 0; i < Number(axWindows.count); i++) {
      var title = attribute(axWindows.objectAtIndex(i), "AXTitle");
      if (title.error === 0 && String(text(title.value)).indexOf(fence) >= 0) matches.push(axWindows.objectAtIndex(i));
    }
    if (matches.length !== 1) return reply({ status: "refused", phase: "ax-match", reason: matches.length + " accessibility windows carry the fence", trusted: trusted });
    var document = attribute(matches[0], "AXDocument");
    if (document.error !== 0) return reply({ status: "ax-error", phase: "AXDocument", axError: document.error, trusted: trusted });
    var uri = text(document.value);
    if (uri === null) return reply({ status: "refused", phase: "AXDocument", reason: "AXDocument is neither a URL nor a string", trusted: trusted });
    var after = owned(app);
    if (after.length !== 1 || Number(after[0].id()) !== windowId || after[0].tabs.length !== 1) {
      return reply({ status: "refused", phase: "owner", reason: "the owned Terminal window changed during the read" });
    }
    return reply({ status: "read", document: uri, windowId: windowId, trusted: trusted });
  } catch (error) {
    return reply({ status: "refused", phase: "script", reason: "the read raised", errorNumber: error && typeof error.errorNumber === "number" ? error.errorNumber : null, message: String(error && error.message ? error.message : error) });
  }
}`

export type TerminalAppDocumentReply =
  | { status: "read"; document: string; windowId: number; trusted: boolean }
  | { status: "fence-pending"; windowId: number }
  | {
      status: "refused"
      phase: string
      reason: string
      trusted?: boolean
      errorNumber?: number | null
      message?: string
    }
  | { status: "ax-error"; phase: string; axError: number; trusted: boolean }

/** One osascript run of the document script; the default spawns /usr/bin/osascript with a 10 s kill. */
export type TerminalAppDocumentRun = (argv: readonly [tty: string, fence: string]) => {
  stdout: string
  stderr: string
  status: number | null
  signal: NodeJS.Signals | null
  error?: Error
}

const defaultDocumentRun: TerminalAppDocumentRun = ([ttyPath, fence]) => {
  const result = spawnSync(
    "/usr/bin/osascript",
    ["-l", "JavaScript", "-e", TERMINAL_APP_DOCUMENT_SCRIPT, ttyPath, fence],
    {
      encoding: "utf8",
      timeout: 10_000,
      killSignal: "SIGKILL",
    },
  )
  return {
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? ""),
    status: result.status,
    signal: result.signal,
    ...(result.error !== undefined && { error: result.error }),
  }
}

/** Parse one reply; anything that is not one of the four shapes is a failure, never a reading. */
export function readTerminalAppDocument(
  ttyPath: string,
  fence: string,
  run: TerminalAppDocumentRun = defaultDocumentRun,
): TerminalAppDocumentReply {
  if (!/^\/dev\/tty[a-zA-Z0-9._-]+$/.test(ttyPath)) {
    throw new OwnedCwdReadError("owner", "the owned TTY is not a device path", `not a TTY: ${JSON.stringify(ttyPath)}`)
  }
  if (!/^[A-Za-z0-9-]{8,}$/.test(fence)) {
    throw new Error(`Terminal.app fence is not a plain nonce: ${JSON.stringify(fence)}`)
  }
  const result = run([ttyPath, fence])
  if (result.error !== undefined || result.signal !== null || result.status !== 0) {
    const how =
      result.signal !== null
        ? `killed by ${result.signal}`
        : result.error
          ? "could not start"
          : `exit ${String(result.status)}`
    throw new OwnedCwdReadError(
      "osascript",
      `osascript ${how}`,
      `${how}: ${result.stderr.trim() || result.error?.message || ""}`,
    )
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(result.stdout)
  } catch {
    throw new OwnedCwdReadError("osascript", "the reply was not JSON", `unparsed reply: ${result.stdout}`)
  }
  const reply = parsed as Record<string, unknown>
  const ok =
    typeof reply === "object" &&
    reply !== null &&
    ((reply.status === "read" && typeof reply.document === "string" && typeof reply.trusted === "boolean") ||
      (reply.status === "fence-pending" && typeof reply.windowId === "number") ||
      (reply.status === "refused" && typeof reply.phase === "string" && typeof reply.reason === "string") ||
      (reply.status === "ax-error" &&
        typeof reply.phase === "string" &&
        Number.isSafeInteger(reply.axError) &&
        typeof reply.trusted === "boolean"))
  if (!ok) throw new OwnedCwdReadError("osascript", "the reply had no known shape", `unknown reply: ${result.stdout}`)
  return reply as TerminalAppDocumentReply
}

/**
 * The owned cwd port for readAppSemanticState (34870). Every read, the baseline included, writes its own OSC 2 fence
 * (the phase's marker, or a fresh baseline nonce) and polls the bounded reader until the owned window's name carries
 * it; only then is AXDocument read, so each phase's value is fresh. `check` re-proves the live owner around every
 * native read. Only a "read" reply is a value: every other outcome throws an OwnedCwdReadError naming its phase and
 * error number, with the raw reply kept as the private diagnostic.
 */
export function terminalAppOwnedCwd(options: {
  readonly tty: string
  readonly write: (text: string) => void
  readonly check: () => void
  readonly run?: TerminalAppDocumentRun
}) {
  return async (checkpoint?: { row: number; marker: string }) => {
    const fence = checkpoint?.marker ?? `terminfo-baseline-${randomUUID()}`
    const reads: TerminalAppDocumentReply[] = []
    options.check()
    options.write(`\x1b]2;${fence}\x07`)
    try {
      await untilAppSemanticRead(
        () => {
          options.check()
          const reply = readTerminalAppDocument(options.tty, fence, options.run)
          reads.push(reply)
          options.check()
          return reply.status
        },
        (status) => status !== "fence-pending",
        "Terminal.app title fence",
        [],
      )
    } catch (error) {
      if (error instanceof OwnedCwdReadError) throw error
      if (reads.at(-1)?.status === "fence-pending") {
        throw new OwnedCwdReadError("fence", "the window title never carried the fence", JSON.stringify(reads))
      }
      throw error
    }
    const last = reads.at(-1) as TerminalAppDocumentReply
    if (last.status === "read") return { uri: last.document, detail: { tty: options.tty, fence, reads } }
    if (last.status === "ax-error") {
      throw new OwnedCwdReadError(
        last.phase,
        `AXError ${last.axError} (process trusted for Accessibility: ${String(last.trusted)})`,
        JSON.stringify(reads),
      )
    }
    if (last.status === "refused") {
      const number = last.errorNumber === undefined || last.errorNumber === null ? "" : ` (error ${last.errorNumber})`
      throw new OwnedCwdReadError(last.phase, `${last.reason}${number}`, JSON.stringify(reads))
    }
    throw new Error(`Terminal.app document read ended on ${last.status}`)
  }
}
