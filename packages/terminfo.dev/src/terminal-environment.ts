import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"

/**
 * The terminal process's own session-bus state, compared with the recorder's (#33333, @cto a6fddd6e).
 *
 * Three states and nothing else. The address and its digest never leave this module: the digest exists
 * only to compare two environments, and no caller ever receives it, so no run file, log or receipt can
 * carry the bus path (one of @cto's four conditions on this change).
 */
export interface TerminalBusReading {
  readonly state: "same" | "different" | "unknown"
  readonly reason: string
}

/** Read one process's environment. Throws loudly: an unreadable /proc entry is not an absent variable. */
export function readProcessEnvironment(pid: number): Readonly<Record<string, string>> {
  if (!Number.isSafeInteger(pid) || pid <= 1) {
    throw new Error(`Cannot read a process environment for PID ${String(pid)}; expected a live PID above 1`)
  }
  let raw: Buffer
  try {
    raw = readFileSync(`/proc/${pid}/environ`)
  } catch (error) {
    throw new Error(`Cannot read /proc/${pid}/environ: ${(error as Error).message}`)
  }
  const environment: Record<string, string> = {}
  for (const entry of raw.toString("utf8").split("\0")) {
    if (entry === "") continue
    const separator = entry.indexOf("=")
    // A NUL-separated entry without "=" is not an assignment; naming it beats silently skipping it.
    if (separator <= 0) throw new Error(`/proc/${pid}/environ holds an entry that is not NAME=value`)
    environment[entry.slice(0, separator)] = entry.slice(separator + 1)
  }
  return environment
}

function busDigest(environment: Readonly<Record<string, string | undefined>>): string | undefined {
  const address = environment.DBUS_SESSION_BUS_ADDRESS
  if (address === undefined || address === "") return undefined
  return createHash("sha256").update(address).digest("hex")
}

/**
 * Compare the terminal's bus with the recorder's by digest. A missing address on either side is unknown,
 * never "different": the absence of a variable proves nothing about which bus the process would reach.
 */
export function terminalBusState(
  terminal: Readonly<Record<string, string | undefined>>,
  recorder: Readonly<Record<string, string | undefined>>,
): TerminalBusReading {
  const terminalDigest = busDigest(terminal)
  const recorderDigest = busDigest(recorder)
  if (terminalDigest === undefined) {
    return {
      state: "unknown",
      reason: "The terminal process environment read from /proc names no DBUS_SESSION_BUS_ADDRESS",
    }
  }
  if (recorderDigest === undefined) {
    return { state: "unknown", reason: "The recorder's environment names no DBUS_SESSION_BUS_ADDRESS" }
  }
  return terminalDigest === recorderDigest
    ? {
        state: "same",
        reason: "The terminal process environment read from /proc names the recorder's session bus, compared by digest",
      }
    : {
        state: "different",
        reason: "The terminal process environment read from /proc names a different session bus from the recorder's",
      }
}

/**
 * The nearest ancestor of this process whose kernel `comm` is `comm`. Used for the outer terminal of a mux run:
 * the owned Linux mux launch refuses to have any outer but Kitty, so the process that would emit the Notify is
 * the Kitty this collector descends from, not the mux server between them.
 */
export function findAncestorComm(comm: string, from: number = process.pid): number {
  if (comm === "") throw new Error("Ancestor lookup needs a non-empty comm")
  let pid = from
  for (let depth = 0; depth < 64 && pid > 1; depth++) {
    let name: string
    try {
      name = readFileSync(`/proc/${pid}/comm`, "utf8").trim()
    } catch (error) {
      throw new Error(`Cannot read /proc/${pid}/comm while looking for ${comm}: ${(error as Error).message}`)
    }
    if (name === comm) return pid
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8")
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ")
    const parent = Number(fields[1])
    if (!Number.isSafeInteger(parent) || parent < 1 || parent === pid) {
      throw new Error(`Ancestor chain from PID ${from} broke at ${pid} before reaching a ${comm} process`)
    }
    pid = parent
  }
  throw new Error(`No ancestor of PID ${from} runs ${comm}`)
}
