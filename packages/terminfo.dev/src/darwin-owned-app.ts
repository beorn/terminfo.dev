/**
 * The owned-Mac app arm (#34012, @cto 47b187f6).
 *
 * Both input families (keyboard, mouse) need an app launched into a window this run owns, on an owned
 * Mac, with its pid, window id and tty measured AT LAUNCH. Nothing in this tree does that today: the
 * Terminal.app arm receives its owner assertion from the client, the iTerm2 arm proves a window by a
 * process census, and the hosted arms read a GitHub-runner receipt. This module is the one place where a
 * launched app's identity is decided, so the payload every later proof reads is the same payload.
 *
 * Two rules are the reason it exists rather than a flag on an existing arm:
 *
 * 1. An app with NO table entry is refused BY NAME. There is no default proof, no "keys are probably
 *    fine" arm, and no entry whose required proofs may be skipped: the table says what proves a posting
 *    reached the app's own surface, and an app we have not measured that for cannot be graded at all.
 * 2. The table is empty until an app's proof is measured. An entry is evidence, not configuration: it
 *    lands with the run or record that proved it, and until then the refusal names the app.
 */
import { censusDarwinWindows, type DarwinWindow, type DarwinWindowCensus } from "./darwin-capture.ts"

/**
 * What the run marks its own window with, so the census can pick it out from a stranger's window that
 * happens to belong to the same app. Every value here is a fact the app itself reports back to us.
 */
export type OwnedAppWindowMarker = "launch-argument" | "window-title" | "app-tab-tty"

/**
 * What proves a posting reached THIS app's own surface, beyond "the pid owns the window". One of these
 * is required per app; which one is a measured fact about that app, never a choice made here.
 */
export type OwnedAppSurfaceProof = "tty-echo" | "socket-pane" | "marker-file"

/** One app's required proofs. Nothing in here is optional, and nothing here has a default. */
export interface OwnedAppLaunchSpec {
  /** The bundle identity the launched process must have; a window owned by any other app is refused. */
  readonly bundleId: string
  readonly windowMarker: OwnedAppWindowMarker
  readonly surfaceProof: OwnedAppSurfaceProof
}

/**
 * app id -> its required proofs. EMPTY on purpose at step 1: every app is refused by name until its
 * own proof is measured and recorded, which is what keeps an unmeasured app from gradable rows.
 */
export const OWNED_APP_LAUNCH_TABLE: Readonly<Record<string, OwnedAppLaunchSpec>> = Object.freeze({})

/** The app's required proofs, or a refusal that names the app and says why it cannot be graded. */
export function ownedAppLaunchSpec(appId: unknown): OwnedAppLaunchSpec {
  if (typeof appId !== "string" || appId.trim() === "") {
    throw new Error(
      "the owned-Mac app arm needs the app it must launch; this run named none, so no window could be proved",
    )
  }
  const spec = OWNED_APP_LAUNCH_TABLE[appId]
  if (!spec) {
    throw new Error(
      `no required-proof entry for the owned-Mac app "${appId}": launching it would produce rows whose ` +
        "surface no run has proved, so it is refused by name rather than graded on an assumed proof " +
        "(@cto 47b187f6)",
    )
  }
  return spec
}

/**
 * What the launcher measured about the window it opened. `windowTty` is required whenever the entry's
 * surface proof is a tty echo, because a posting the app ignores must be caught at install, not read as
 * the app's behaviour later.
 */
export interface OwnedAppLaunchRecord {
  readonly appId: string
  readonly appPid: number
  readonly windowId: number
  readonly windowTty: string | null
  readonly launchRunId: string
}

function positiveInteger(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`an owned-Mac app launch record needs ${what}; got ${JSON.stringify(value)}`)
  }
  return value
}

/**
 * Read a launch record strictly. A record that does not describe exactly one app, one process and one
 * window is refused: a partially-read identity is how a posting lands in a window nobody proved.
 */
export function parseOwnedAppLaunchRecord(value: unknown): OwnedAppLaunchRecord {
  // Shape first, then the entry rule: a malformed record is a malformed record whatever app it names, and an
  // external record is only readable for an app this run is allowed to grade at all.
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("an owned-Mac app launch record must be an object")
  }
  return validateLaunchShape(value, ownedAppLaunchSpec((value as Record<string, unknown>).appId))
}

/**
 * The shape rules of a launch record, given the app's entry. Split from the table lookup so the launch
 * mechanism can be driven by a spec that is not in the table, and no other path can skip the lookup.
 */
export function validateLaunchShape(value: unknown, spec: OwnedAppLaunchSpec): OwnedAppLaunchRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("an owned-Mac app launch record must be an object")
  }
  const record = value as Record<string, unknown>
  const appId = record.appId as string
  const appPid = positiveInteger(record.appPid, "the launched app's pid")
  if (appPid < 2) throw new Error(`an owned-Mac app launch record needs the app's own pid; got ${String(appPid)}`)
  const windowId = positiveInteger(record.windowId, "the launched window's id")
  const launchRunId = record.launchRunId
  if (typeof launchRunId !== "string" || launchRunId.trim() === "") {
    throw new Error("an owned-Mac app launch record needs the run id that launched the window")
  }
  const tty = record.windowTty
  if (spec.surfaceProof === "tty-echo") {
    if (typeof tty !== "string" || !tty.startsWith("/dev/ttys")) {
      throw new Error(
        `the owned-Mac app "${appId}" proves its surface by a tty echo, so the record must name the ` +
          `app's own tty; got ${JSON.stringify(tty)}`,
      )
    }
    return { appId, appPid, windowId, windowTty: tty, launchRunId }
  }
  if (tty !== null && (typeof tty !== "string" || !tty.startsWith("/dev/ttys"))) {
    throw new Error(`an owned-Mac app launch record's tty must be a pty path or null; got ${JSON.stringify(tty)}`)
  }
  return { appId, appPid, windowId, windowTty: tty as string | null, launchRunId }
}

/** The census rows are the window server's answer, in the shape darwin-capture.ts CENSUS emits. */
export interface OwnedAppWindowProof {
  readonly window: DarwinWindow
  readonly census: DarwinWindowCensus
  readonly proof: string
}

/**
 * Prove the launched window is still the app's own, using the ONE census implementation the capture arm
 * already trusts (`censusDarwinWindows`) rather than a second reader. `markerMatched` is the app's own
 * confirmation that the selected window is the one this run opened; a false there is a refusal, never a
 * smaller window or "the largest one".
 */
export function proveOwnedAppWindow(
  rows: unknown,
  record: OwnedAppLaunchRecord,
  markerMatched: boolean,
): OwnedAppWindowProof {
  if (!markerMatched) {
    throw new Error(
      `the owned-Mac app "${record.appId}" did not report window ${String(record.windowId)} as the one this ` +
        "run opened, so the census could be looking at another of its windows; refusing to grade it",
    )
  }
  // The census is the ONLY reader here. Given the launched id it already refuses a window that is absent,
  // other-owned, layered, offscreen or transparent by name, and returns that exact window otherwise — so a
  // second "did it pick mine" check here would be a guard nothing can reach.
  const census = censusDarwinWindows(rows, record.appPid, record.windowId)
  const window = census.selected.window
  return {
    window,
    census,
    proof:
      `owned=true app=${record.appId} pid=${String(record.appPid)} window=${String(window.id)} ` +
      `launch=${record.launchRunId} marker=matched`,
  }
}

/** One layer-0 window as the window server listed it, before any app claim. */
function layerZeroWindows(rows: unknown): Array<{ id: number; ownerPid: number; name: string | null }> {
  if (!Array.isArray(rows)) throw new Error("the owned-Mac app launch census must be a window list")
  const out: Array<{ id: number; ownerPid: number; name: string | null }> = []
  for (const row of rows) {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      throw new Error("the owned-Mac app launch census contains a non-object row")
    }
    const value = row as Record<string, unknown>
    if (typeof value.id !== "number" || typeof value.ownerPid !== "number" || value.layer !== 0) continue
    // A launch builds windows in stages, and the window server lists the offscreen ones too. They are not
    // windows this run can own or grade — the capture census refuses them by name for the same reason — so
    // counting them here would read one launch as two windows and refuse a launch that is fine.
    if (value.onscreen === false) continue
    out.push({
      id: value.id,
      ownerPid: value.ownerPid,
      name: value.namePresent === true && typeof value.name === "string" ? value.name : null,
    })
  }
  return out
}

export interface OwnedAppLaunchOptions {
  readonly appId: string
  /** The bundle to open, as the launch names it; the record's window must belong to a process it started. */
  readonly bundlePath: string
  /** Unique to this run, and the only reason a window can be claimed as OURS rather than merely the app's. */
  readonly runMarker: string
  /** Injected so the launch is testable without a Mac: it opens the app, and provides nothing else. */
  spawn: (program: string, args: readonly string[]) => void
  /** Injected: the window server's list, read fresh each attempt (the same reader the capture arm uses). */
  census: () => Promise<unknown> | unknown
  /** Injected: the app's own tty for the launched pid, or null when the app has no such reader. */
  ttyOf: (appPid: number) => Promise<string | null> | string | null
  /** Injected sleep, so a test does not wait. */
  wait?: (ms: number) => Promise<void> | void
  readonly attempts?: number
}

/**
 * Launch the app and measure the ONE window this run opened.
 *
 * The claim is never "a window the app owns": that window may be a stranger's, left open before this run.
 * It is the difference between the census taken BEFORE the launch and the one taken after — a window that
 * did not exist, owned by a process that was not there, whose title carries this run's marker when the app
 * reports titles. Both halves are required, and a launch that adds no single such window is refused by name.
 */
export async function launchOwnedApp(options: OwnedAppLaunchOptions): Promise<OwnedAppLaunchRecord> {
  // The table is the gate: an app with no measured entry never reaches the mechanism.
  return proveOwnedAppLaunch(ownedAppLaunchSpec(options.appId), options)
}

/**
 * The mechanism, without the table: exported so refusal tests can drive it with a spec that is not in the
 * table. Nothing else may call it — the entry rule is what keeps an unmeasured app out of a run.
 */
export async function proveOwnedAppLaunch(
  spec: OwnedAppLaunchSpec,
  options: OwnedAppLaunchOptions,
): Promise<OwnedAppLaunchRecord> {
  if (typeof options.runMarker !== "string" || options.runMarker.trim() === "") {
    throw new Error("an owned-Mac app launch needs a run marker; without one no window can be claimed as this run's")
  }
  const before = layerZeroWindows(await options.census())
  const beforeIds = new Set(before.map((row) => row.id))
  const beforePids = new Set(before.map((row) => row.ownerPid))
  options.spawn("open", ["-na", options.bundlePath, "--args", `--hh-run=${options.runMarker}`])
  const wait = options.wait ?? ((ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms))
  const attempts = options.attempts ?? 40
  for (let attempt = 0; attempt < attempts; attempt++) {
    const fresh = layerZeroWindows(await options.census()).filter(
      (row) => !beforeIds.has(row.id) && !beforePids.has(row.ownerPid),
    )
    const named =
      spec.windowMarker === "window-title" ? fresh.filter((row) => row.name?.includes(options.runMarker)) : fresh
    if (named.length > 0) {
      if (named.length > 1) {
        throw new Error(
          `the owned-Mac app "${options.appId}" opened ${String(named.length)} windows for one launch ` +
            `(${named.map((row) => String(row.id)).join(", ")}); one run owns one window, so none is graded`,
        )
      }
      const window = named[0]!
      const appPid = window.ownerPid
      const windowTty = await options.ttyOf(appPid)
      return validateLaunchShape(
        {
          appId: options.appId,
          appPid,
          windowId: window.id,
          windowTty,
          launchRunId: options.runMarker,
        },
        spec,
      )
    }
    await wait(250)
  }
  throw new Error(
    `the owned-Mac app "${options.appId}" opened no new window for launch marker ${options.runMarker} in ` +
      `${String(attempts)} attempts; refusing to grade a window this run cannot claim`,
  )
}
