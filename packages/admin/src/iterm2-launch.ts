/**
 * The owned iTerm2 launch (#33845, @cto 11983ea0 amended by e1efdd39; #34080, @cto d43c34cc).
 *
 * Ownership combines:
 * - sole-instance preflight (no iTerm2 of this account runs before launch, exactly one started strictly
 *   after the preflight runs after registration, and exactly one new visible layer-0 CG window belongs to it),
 * - exact run-scoped `-suite dev.terminfo.iterm2.<runId>` argv marker verified at resolve, assert, and close,
 * - per-run isolation proof: `com.googlecode.iterm2.plist` sha256 identical before and after, and the private
 *   suite domain present while the run is live,
 * - exact-token teardown with absence proofs (defaults domain, run-created iTermServer, two exact dirs;
 *   anything pre-existing or not created by this run is refused by name and left untouched).
 * No process runs at module load.
 */
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, lstatSync, readFileSync, rmSync } from "node:fs"
import { homedir } from "node:os"
import { basename, isAbsolute, join } from "node:path"
import {
  argvCarriesMarker,
  markerText,
  processCommand,
  processExecutable,
  tty,
  type ProcessMarker,
} from "../../terminfo.dev/src/owned-process.ts"
import { parseLstart } from "../../terminfo.dev/src/disposable-receipt.ts"
import {
  accountProcessesRunning,
  readDarwinWindowRows,
  type Iterm2Window,
} from "../../terminfo.dev/src/terminal-app-window.ts"
import { censusDarwinWindows } from "../../terminfo.dev/src/darwin-capture.ts"
import { redactHostHomePaths } from "./terminal-app-plist.ts"

const SUITE_DOMAIN_PATTERN = /^dev\.terminfo\.iterm2\.[A-Za-z0-9._-]+$/
const ITERM_SERVER_BASENAME = /^iTermServer(?:-[0-9A-Za-z._-]+)?$/
const ACCOUNT_PROCESS_ROW =
  /^\s*([0-9]+)\s+((?:Sun|Mon|Tue|Wed|Thu|Fri|Sat) [A-Z][a-z]{2} [ 1-3]?[0-9] [0-9]{2}:[0-9]{2}:[0-9]{2} [0-9]{4})\s+(\S.*)$/

export type Iterm2PrefsSnapshot =
  | { readonly path: string; readonly present: true; readonly sha256: string }
  | { readonly path: string; readonly present: false }

export interface Iterm2IsolationTargets {
  readonly suiteDomain: string
  readonly operatorPrefsPath: string
  readonly suitePrefsPath: string
  readonly appSupportDir: string
  readonly dotSuiteDir: string
}

/** What the preflight measured before the shared CLI launch; resolved once the daemon registers. */
export interface Iterm2Launch {
  executablePath: string
  /** Exact run-scoped `-suite dev.terminfo.iterm2.<runId>` argv marker. */
  marker: ProcessMarker
  /** Exact isolation and teardown targets derived from the validated suite domain. */
  targets: Iterm2IsolationTargets
  /** Snapshot of `com.googlecode.iterm2.plist` taken before launch. */
  operatorPrefsBefore: Iterm2PrefsSnapshot
  /** Whole UTC seconds, read immediately before the preflight process census. */
  preflightAtEpochSeconds: number
  /** Every CG window id before the launch. */
  beforeWindowIds: number[]
}

export interface Iterm2IsolationReceipt {
  readonly suiteDomain: string
  readonly suiteDomainPresentWhileLive: true
  readonly suiteDomainLiveReadBytes: number
  readonly operatorPrefsBefore: Iterm2PrefsSnapshot
  readonly operatorPrefsAfter: Iterm2PrefsSnapshot
}

export interface Iterm2TeardownReceipt {
  readonly suiteDomain: string
  readonly defaultsDeleted: true
  readonly defaultsAbsentVerified: true
  readonly stoppedServers: ReadonlyArray<{
    readonly pid: number
    readonly startedAtEpochSeconds: number
    readonly command: string
  }>
  readonly remainingServers: 0
  readonly removedDirs: ReadonlyArray<{
    readonly path: string
    readonly existedBeforeRemoval: boolean
    readonly absentVerified: true
  }>
}

interface LiveItermServer {
  readonly pid: number
  readonly startedAtEpochSeconds: number
  readonly comm: string
  readonly command: string
}

function validateSuiteMarker(marker: ProcessMarker): string {
  if (marker.flag !== "-suite" || !SUITE_DOMAIN_PATTERN.test(marker.value) || marker.value.includes("..")) {
    throw new Error(
      `iTerm2 launch requires an exact -suite dev.terminfo.iterm2.<runId> marker, received ${JSON.stringify(marker)}`,
    )
  }
  return marker.value
}

function isolationTargets(suiteDomain: string, homeDir: string): Iterm2IsolationTargets {
  if (!isAbsolute(homeDir)) {
    throw new Error(`iTerm2 isolation targets require an absolute home directory, received ${JSON.stringify(homeDir)}`)
  }
  return {
    suiteDomain,
    operatorPrefsPath: join(homeDir, "Library", "Preferences", "com.googlecode.iterm2.plist"),
    suitePrefsPath: join(homeDir, "Library", "Preferences", `${suiteDomain}.plist`),
    appSupportDir: join(homeDir, "Library", "Application Support", suiteDomain),
    dotSuiteDir: join(homeDir, `.${suiteDomain}`),
  }
}

function readIterm2PrefsSnapshot(path: string): Iterm2PrefsSnapshot {
  try {
    const bytes = readFileSync(path)
    return { path, present: true, sha256: createHash("sha256").update(bytes).digest("hex") }
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return { path, present: false }
    }
    throw new Error(
      `iTerm2 isolation check could not read ${path}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    )
  }
}

function readDefaultsDomain(domain: string): { present: true; bytes: number } | { present: false } {
  const result = spawnSync("/usr/bin/defaults", ["read", domain], { encoding: "utf8", timeout: 5_000 })
  const stdout = String(result.stdout ?? "")
  const stderr = String(result.stderr ?? "")
  if (!result.error && !result.signal && result.status === 0 && stdout.trim().length > 0) {
    return { present: true, bytes: Buffer.byteLength(stdout, "utf8") }
  }
  if (!result.error && !result.signal && result.status === 1 && /does not exist/i.test(stderr)) {
    return { present: false }
  }
  throw new Error(
    `iTerm2 defaults read ${domain} failed: ${result.error?.message ?? (stderr.trim() || `exit ${String(result.status)}`)}`,
  )
}

function commandTargetsSuite(comm: string, command: string, targets: Iterm2IsolationTargets): boolean {
  const appPrefix = `${targets.appSupportDir}/`
  const dotPrefix = `${targets.dotSuiteDir}/`
  if (comm.startsWith(appPrefix)) return true
  if (command.includes(appPrefix) || command.includes(dotPrefix)) return true
  return command.split(/\s+/).includes(targets.suiteDomain)
}

function liveIterm2ServersForSuite(targets: Iterm2IsolationTargets): LiveItermServer[] {
  const uid = process.getuid?.()
  if (uid === undefined) throw new Error("iTerm2 server census needs this account's uid, and this platform has none")
  const args = ["-ww", "-U", String(uid), "-o", "pid=,lstart=,comm="]
  const result = spawnSync("/bin/ps", args, {
    encoding: "utf8",
    timeout: 5_000,
    env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
  })
  if (result.error || result.status !== 0) {
    const detail = result.error?.message ?? (String(result.stderr ?? "").trim() || `exit ${String(result.status)}`)
    throw new Error(`iTerm2 server census: /bin/ps ${args.join(" ")} failed: ${detail}`)
  }
  const found: LiveItermServer[] = []
  for (const line of String(result.stdout ?? "").split(/\r?\n/)) {
    if (line.trim() === "") continue
    const [, rawPid, lstart, rawComm] = ACCOUNT_PROCESS_ROW.exec(line) ?? []
    if (rawPid === undefined || lstart === undefined || rawComm === undefined) {
      throw new Error(`iTerm2 server census: unparseable ps row ${JSON.stringify(line)}`)
    }
    const comm = rawComm.trim()
    if (!ITERM_SERVER_BASENAME.test(basename(comm))) continue
    const pid = Number(rawPid)
    const command = processCommand(pid) ?? comm
    if (!commandTargetsSuite(comm, command, targets)) continue
    found.push({ pid, startedAtEpochSeconds: parseLstart(lstart), comm, command })
  }
  return found
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false
    throw error
  }
}

function stopRunItermServer(server: LiveItermServer, targets: Iterm2IsolationTargets): void {
  const recheck = (stage: "signaling it" | "escalating to SIGKILL"): boolean => {
    const liveExec = processExecutable(server.pid, "iterm2-server", true)
    if (liveExec === null) return false
    const liveCmd = processCommand(server.pid) ?? liveExec
    if (!ITERM_SERVER_BASENAME.test(basename(liveExec)) || !commandTargetsSuite(liveExec, liveCmd, targets)) {
      throw new Error(
        `iTerm2 teardown: pid ${server.pid} no longer matches run suite ${targets.suiteDomain}; not ${stage}`,
      )
    }
    return true
  }
  if (!recheck("signaling it")) return
  process.kill(server.pid, "SIGTERM")
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (!processAlive(server.pid)) return
    spawnSync("sleep", ["0.1"])
  }
  if (!recheck("escalating to SIGKILL")) return
  process.kill(server.pid, "SIGKILL")
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (!processAlive(server.pid)) return
    spawnSync("sleep", ["0.1"])
  }
  throw new Error(`iTerm2 teardown: iTermServer pid ${server.pid} survived SIGTERM (5000ms) and SIGKILL (5000ms)`)
}

/** Refuse an existing instance or pre-existing suite targets, snapshot operator prefs, and capture window census. */
export function prepareIterm2Launch(
  scriptPath: string,
  executablePath: string,
  marker: ProcessMarker,
  homeDir = homedir(),
): Iterm2Launch {
  if (!isAbsolute(scriptPath)) {
    throw new Error(
      `iTerm2 launch requires the absolute path of the command script, but received ${JSON.stringify(scriptPath)}`,
    )
  }
  const suiteDomain = validateSuiteMarker(marker)
  const targets = isolationTargets(suiteDomain, homeDir)
  const preflightAtEpochSeconds = Math.floor(Date.now() / 1000)
  const running = accountProcessesRunning(executablePath, "iterm2")
  if (running.length > 0) {
    throw new Error(
      `iTerm2 is already running for this account (pids ${running.map((row) => row.pid).join(", ")}); an owned iTerm2 run needs it absent so the one instance after launch is provably this run's. Quit iTerm2 and rerun`,
    )
  }
  const priorServers = liveIterm2ServersForSuite(targets)
  if (priorServers.length > 0) {
    throw new Error(
      `iTerm2 preflight: iTermServer for suite ${suiteDomain} is already running before launch (pids ${priorServers.map((s) => s.pid).join(", ")}); refusing and leaving it untouched`,
    )
  }
  if (readDefaultsDomain(suiteDomain).present || existsSync(targets.suitePrefsPath)) {
    throw new Error(
      `iTerm2 preflight: suite domain ${suiteDomain} already exists before launch; refusing and leaving it untouched`,
    )
  }
  for (const dir of [targets.appSupportDir, targets.dotSuiteDir]) {
    if (existsSync(dir)) {
      throw new Error(`iTerm2 preflight: ${dir} already exists before launch; refusing and leaving it untouched`)
    }
  }
  const operatorPrefsBefore = readIterm2PrefsSnapshot(targets.operatorPrefsPath)
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
  return {
    executablePath,
    marker: { flag: marker.flag, value: suiteDomain },
    targets,
    operatorPrefsBefore,
    preflightAtEpochSeconds,
    beforeWindowIds,
  }
}

/**
 * After the daemon registers: exactly one iTerm2 of this account runs, its start second is strictly later
 * than the preflight read's second, its live argv carries the exact `-suite dev.terminfo.iterm2.<runId>`
 * marker, and exactly one new visible layer-0 CG window belongs to it.
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
  const argv = processCommand(owner.pid)?.split(/\s+/) ?? []
  if (!argvCarriesMarker(argv, launch.marker)) {
    throw new Error(`iTerm2 launch: pid ${owner.pid} does not carry the launched marker ${markerText(launch.marker)}`)
  }
  const rows = readDarwinWindowRows()
  const before = new Set(launch.beforeWindowIds)
  const fresh = rows.filter((row) => {
    const id = (row as { id?: unknown } | null)?.id
    return typeof id !== "number" || !before.has(id)
  })
  const { selected } = censusDarwinWindows(fresh, owner.pid, undefined, "unique")
  return {
    provider: "iterm2",
    windowId: selected.window.id,
    // The existing live process assertion checks this against ps TTY and daemon ancestry before use.
    tty: recorded,
    ownerPid: owner.pid,
    executablePath: launch.executablePath,
    startedAtEpochSeconds: owner.startedAtEpochSeconds,
    marker: launch.marker,
  }
}

/** Prove while the run is live that iTerm2's private suite domain exists (@cto d43c34cc condition (a)). */
export function assertIterm2SuiteLive(launch: Iterm2Launch): number {
  const domain = readDefaultsDomain(launch.targets.suiteDomain)
  if (!domain.present) {
    throw new Error(
      `iTerm2 isolation check: suite domain ${launch.targets.suiteDomain} is not present while live; refusing unisolated run`,
    )
  }
  return domain.bytes
}

/** Prove after close that `com.googlecode.iterm2.plist` sha256 did not change during the run (@cto d43c34cc condition (a)). */
export function verifyIterm2IsolationAfterClose(
  launch: Iterm2Launch,
  suiteDomainLiveReadBytes: number,
): Iterm2IsolationReceipt {
  if (!Number.isSafeInteger(suiteDomainLiveReadBytes) || suiteDomainLiveReadBytes < 1) {
    throw new Error(
      `iTerm2 isolation check: suite domain ${launch.targets.suiteDomain} was not verified present while live`,
    )
  }
  const operatorPrefsAfter = readIterm2PrefsSnapshot(launch.targets.operatorPrefsPath)
  const before = launch.operatorPrefsBefore
  const unchanged =
    before.present === operatorPrefsAfter.present &&
    (!before.present || (operatorPrefsAfter.present && before.sha256 === operatorPrefsAfter.sha256))
  if (!unchanged) {
    throw new Error(
      `iTerm2 isolation check: ${launch.targets.operatorPrefsPath} changed during run (before=${JSON.stringify(before)}, after=${JSON.stringify(operatorPrefsAfter)})`,
    )
  }
  return {
    suiteDomain: launch.targets.suiteDomain,
    suiteDomainPresentWhileLive: true,
    suiteDomainLiveReadBytes,
    operatorPrefsBefore: { ...before, path: redactHostHomePaths(before.path) },
    operatorPrefsAfter: { ...operatorPrefsAfter, path: redactHostHomePaths(operatorPrefsAfter.path) },
  }
}

/**
 * Exact-token teardown with absence proofs (@cto d43c34cc condition (c)):
 * 1. Stop only run-created `iTermServer` processes carrying this run's exact suite paths/token (refuse any pre-preflight match).
 * 2. Delete the exact defaults domain `dev.terminfo.iterm2.<runId>` and prove absence.
 * 3. Remove only the two exact run-scoped directories (refuse symlinks) and prove both absent.
 */
export function teardownIterm2Suite(launch: Iterm2Launch): Iterm2TeardownReceipt {
  const suiteDomain = validateSuiteMarker(launch.marker)
  const { targets } = launch
  const servers = liveIterm2ServersForSuite(targets)
  for (const server of servers) {
    if (server.startedAtEpochSeconds <= launch.preflightAtEpochSeconds) {
      throw new Error(
        `iTerm2 teardown: iTermServer pid ${server.pid} started at ${server.startedAtEpochSeconds}, which predates this run's preflight ${launch.preflightAtEpochSeconds}; refusing and leaving it untouched`,
      )
    }
  }
  const stoppedServers: Array<{ pid: number; startedAtEpochSeconds: number; command: string }> = []
  for (const server of servers) {
    stopRunItermServer(server, targets)
    stoppedServers.push({
      pid: server.pid,
      startedAtEpochSeconds: server.startedAtEpochSeconds,
      command: redactHostHomePaths(server.command),
    })
  }
  const remainingServers = liveIterm2ServersForSuite(targets)
  if (remainingServers.length > 0) {
    throw new Error(
      `iTerm2 teardown: iTermServer processes still running for suite ${suiteDomain} after stop (pids ${remainingServers.map((s) => s.pid).join(", ")})`,
    )
  }

  const del = spawnSync("/usr/bin/defaults", ["delete", suiteDomain], { encoding: "utf8", timeout: 5_000 })
  const delStderr = String(del.stderr ?? "")
  const deleteOk =
    !del.error && !del.signal && (del.status === 0 || (del.status === 1 && /not found|does not exist/i.test(delStderr)))
  if (!deleteOk) {
    throw new Error(
      `iTerm2 teardown: defaults delete ${suiteDomain} failed: ${del.error?.message ?? (delStderr.trim() || `exit ${String(del.status)}`)}`,
    )
  }
  if (readDefaultsDomain(suiteDomain).present) {
    throw new Error(`iTerm2 teardown: suite domain ${suiteDomain} still exists after defaults delete`)
  }
  // On macOS, cfprefsd may leave an empty `{}` binary plist on disk after `defaults delete` removes the domain.
  // Remove that exact non-symlink plist file so both the defaults domain and the file on disk are provably absent.
  if (existsSync(targets.suitePrefsPath)) {
    if (basename(targets.suitePrefsPath) !== `${suiteDomain}.plist`) {
      throw new Error(`iTerm2 teardown: refusing unexpected prefs path ${JSON.stringify(targets.suitePrefsPath)}`)
    }
    if (lstatSync(targets.suitePrefsPath).isSymbolicLink()) {
      throw new Error(`iTerm2 teardown: ${targets.suitePrefsPath} is a symlink; refusing and leaving it untouched`)
    }
    rmSync(targets.suitePrefsPath, { force: false })
  }
  if (readDefaultsDomain(suiteDomain).present || existsSync(targets.suitePrefsPath)) {
    throw new Error(`iTerm2 teardown: suite domain ${suiteDomain} still exists after defaults delete`)
  }

  const removedDirs: Array<{ path: string; existedBeforeRemoval: boolean; absentVerified: true }> = []
  for (const [dir, expectedBase] of [
    [targets.appSupportDir, suiteDomain],
    [targets.dotSuiteDir, `.${suiteDomain}`],
  ] as const) {
    if (basename(dir) !== expectedBase) {
      throw new Error(`iTerm2 teardown: refusing unexpected directory path ${JSON.stringify(dir)}`)
    }
    const existedBeforeRemoval = existsSync(dir)
    if (existedBeforeRemoval) {
      if (lstatSync(dir).isSymbolicLink()) {
        throw new Error(`iTerm2 teardown: ${dir} is a symlink; refusing and leaving it untouched`)
      }
      rmSync(dir, { recursive: true, force: false })
    }
    if (existsSync(dir)) {
      throw new Error(`iTerm2 teardown: ${dir} still exists after removal`)
    }
    removedDirs.push({ path: redactHostHomePaths(dir), existedBeforeRemoval, absentVerified: true })
  }

  return {
    suiteDomain,
    defaultsDeleted: true,
    defaultsAbsentVerified: true,
    stoppedServers,
    remainingServers: 0,
    removedDirs,
  }
}
