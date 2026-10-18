/**
 * The owned-window assertion for kitty on macOS (15323 Mac lane).
 *
 * kitty exports `KITTY_WINDOW_ID` and `KITTY_PID` into the program it launches, so the serve script can record
 * which window and which kitty instance it actually runs inside. This module reads that record and requires the
 * probed daemon to be a descendant of the recorded kitty process: a launch that attached to someone else's
 * instance, or a stale identity file, fails by name instead of being reported as an owned measurement.
 */

export interface KittyIdentity {
  windowId: number
  kittyPid: number
  tty: string
  term: string
}

const positiveInteger = (value: string, name: string): number => {
  const parsed = Number(value)
  if (!/^[0-9]+$/.test(value) || !Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`kitty owner identity: ${name} is not a positive integer: ${JSON.stringify(value)}`)
  }
  return parsed
}

/** Parse the four fields the serve script writes, in order: window id, kitty pid, tty, TERM. */
export function parseKittyIdentity(text: string): KittyIdentity {
  const lines = text.split(/\r?\n/).filter((line) => line.length > 0)
  if (lines.length !== 4) {
    throw new Error(`kitty owner identity has ${lines.length} non-empty fields, expected 4: ${JSON.stringify(text)}`)
  }
  const [windowId, kittyPid, tty, term] = lines as [string, string, string, string]
  if (!/^\/dev\/[A-Za-z0-9._-]+$/.test(tty)) {
    throw new Error(`kitty owner identity: tty is not a device path: ${JSON.stringify(tty)}`)
  }
  if (!term.startsWith("xterm-kitty")) {
    throw new Error(`kitty owner identity: TERM is not a kitty terminal: ${JSON.stringify(term)}`)
  }
  return {
    windowId: positiveInteger(windowId, "window id"),
    kittyPid: positiveInteger(kittyPid, "kitty pid"),
    tty,
    term,
  }
}

/**
 * Require the daemon to descend from the recorded kitty process. `parentOf` returns a pid's parent or null when
 * the process is gone or unreadable; a missing chain is a refusal, never a pass.
 */
export function assertKittyOwner(
  identity: KittyIdentity,
  daemonPid: number,
  parentOf: (pid: number) => number | null,
  maxHops = 10,
): void {
  if (!Number.isSafeInteger(daemonPid) || daemonPid < 1) {
    throw new Error(`kitty owner assertion: daemon pid is not a positive integer: ${JSON.stringify(daemonPid)}`)
  }
  if (daemonPid === identity.kittyPid) {
    throw new Error("kitty owner assertion: the daemon and the kitty process are the same pid")
  }
  let pid = daemonPid
  for (let hop = 0; hop < maxHops; hop += 1) {
    const parent = parentOf(pid)
    if (parent === null || parent < 1) break
    if (parent === identity.kittyPid) return
    pid = parent
  }
  throw new Error(
    `kitty owner assertion: daemon pid ${daemonPid} is not a descendant of kitty pid ${identity.kittyPid}`,
  )
}
