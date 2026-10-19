/** The one process ownership proof both process-backed arms share, with the run-scoped marker and
 * the live ps readers it needs. No process runs at module load. */
import { spawnSync } from "node:child_process"
import { realpathSync } from "node:fs"

/** How a run-scoped marker appears in a live process's argv: adjacent "--flag value", or one "--flag=value".
 * It is always an exact token, never a substring, and its value carries the run id. */
export interface ProcessMarker {
  flag: string
  value: string
}

/** The one process proof both process-backed arms share. kitty is this with its instance group as the marker. */
export interface OwnedProcess {
  ownerPid: number
  executablePath: string
  marker: ProcessMarker
  tty: string
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
  const where = `${input.appName} owned-process marker`
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

/** The recorded parent of one pid, or null when the process is gone or unreadable. */
export function parentOf(pid: number): number | null {
  const result = spawnSync("/bin/ps", ["-p", String(pid), "-o", "ppid="], { encoding: "utf8", timeout: 5_000 })
  if (result.error || result.status !== 0) return null
  const raw = String(result.stdout ?? "").trim()
  if (!/^[0-9]+$/.test(raw)) return null
  const parent = Number(raw)
  return Number.isSafeInteger(parent) && parent > 0 ? parent : null
}

export function processExecutable(pid: number, who: string): string | null {
  const result = spawnSync("/bin/ps", ["-p", String(pid), "-o", "comm="], { encoding: "utf8", timeout: 5_000 })
  if (result.error || result.status !== 0) return null
  const raw = String(result.stdout ?? "").trim()
  if (!raw) return null
  try {
    return realpathSync(raw)
  } catch (error) {
    throw new Error(`${who} owner executable lookup failed for pid ${pid} at ${JSON.stringify(raw)}`, {
      cause: error,
    })
  }
}

export function processCommand(pid: number): string | null {
  const result = spawnSync("/bin/ps", ["-ww", "-p", String(pid), "-o", "command="], {
    encoding: "utf8",
    timeout: 5_000,
  })
  if (result.error || result.status !== 0) return null
  const raw = String(result.stdout ?? "").trim()
  return raw.length > 0 ? raw : null
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

export function markerText(marker: ProcessMarker): string {
  return `${marker.flag} ${marker.value}`
}

/**
 * The one process proof both process-backed arms share. The pid must still run the launched binary,
 * still carry the run-scoped marker as an exact argv token, own the daemon's controlling TTY, and be an
 * ancestor of the daemon. Every check reads the live process table; the launch record supplies only the
 * expectation. A pid that is gone, reused, or a different binary is a refusal, never a pass.
 */
export function assertOwnedProcess(owned: OwnedProcess, daemonPid: number, who: string): void {
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
  const liveExecutable = processExecutable(owned.ownerPid, who)
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
