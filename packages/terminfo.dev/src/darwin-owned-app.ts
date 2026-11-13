import { createHash } from "node:crypto"
import { isAbsolute } from "node:path"
import type { OwnedAppOwnerAssertion } from "./owned-terminal.ts"

/**
 * The owned-Mac app arm's REQUIRED proofs, one app at a time (#34012, @cto 47b187f6 + 9f889378).
 *
 * This module deliberately does NOT own an app's identity. `OwnedTerminalWindow` (terminal-app-window.ts)
 * already carries the pid, tty, executable and run marker for the `cli-process` arm, and the CG window id,
 * tty and start time for `iterm2`; `findOwnerPids` already refuses zero and several owners. What no arm
 * carries is which proofs a given app MUST satisfy before its rows may be graded, and the two proof kinds
 * that answer it: the CSS-free title echo, and the launcher-side census diff.
 *
 * So this file holds exactly three things:
 *
 * 1. The per-app table. An app with no entry is refused BY NAME: there is no default proof, nothing in an
 *    entry is optional, and no proof falls back to another at run time (@cto 9f889378 2/3a/3b).
 * 2. The title-echo tty proof: write a fresh nonce into the RUN'S OWN tty as a title, see the claimed
 *    window's title carry it in the census, restore the title. That proves "this tty is drawn in that
 *    window" by observation, with no object model and no per-app AppleScript.
 * 3. The census diff the LAUNCHER uses to decide which window this launch created. Pure, no I/O: the
 *    launcher reads the census before and after the spawn and passes both lists here.
 */

/**
 * How a window is proved to be the one this launch created.
 * - `census-diff`: it did not exist before the launch, and its owner pid was not there either.
 * - `marker-title`: the same diff, and the window's title carries this run's marker.
 */
export type OwnedAppWindowProof = "census-diff" | "marker-title"

/**
 * How the run's OWN tty is proved to be the tty drawn in that window. `unavailable` is a value and not a
 * gap: it keeps the app gradable for pixel and mouse rows while naming why its keyboard rows cannot be.
 */
export type OwnedAppTtyProof =
  | { readonly kind: "object-model"; readonly reader: string }
  | { readonly kind: "title-echo" }
  | { readonly kind: "unavailable"; readonly reason: string }

/** One app's required proofs. Nothing optional, nothing defaulted. */
export interface OwnedAppProofSpec {
  /** The bundle identity the launcher opened; a window whose owner runs another app is not this run. */
  readonly bundleId: string
  readonly windowProof: OwnedAppWindowProof
  readonly ttyProof: OwnedAppTtyProof
}

/**
 * app id -> its required proofs. EMPTY at step 1 on @cto's ruling: every app is refused by name until its
 * own proof is measured, and each entry lands alone with the evidence that proves it. No sketched entries.
 */
export const OWNED_APP_PROOF_TABLE: Readonly<Record<string, OwnedAppProofSpec>> = Object.freeze({})

/** The app's required proofs, or a refusal that names the app and says why it cannot be graded. */
export function ownedAppProofSpec(appId: unknown): OwnedAppProofSpec {
  if (typeof appId !== "string" || appId.trim() === "") {
    throw new Error(
      "the owned-Mac app arm needs the app it must launch; this run named none, so no window could be proved",
    )
  }
  const spec = OWNED_APP_PROOF_TABLE[appId]
  if (!spec) {
    throw new Error(
      `no required-proof entry for the owned-Mac app "${appId}": launching it would produce rows whose ` +
        "surface no run has proved, so it is refused by name rather than graded on an assumed proof " +
        "(@cto 47b187f6)",
    )
  }
  return spec
}

/** One layer-0 window the window server listed, in the shape darwin-capture.ts CENSUS emits. */
export interface LaunchCensusWindow {
  readonly id: number
  readonly ownerPid: number
  readonly name: string | null
}

/** Every row the census emitted, before the layer/onscreen filter that selects gradable windows. */
interface CensusRow extends LaunchCensusWindow {
  readonly layer: number
  readonly onscreen: boolean
}

/**
 * A window title or a census row must never reach a published record, so a refusal names it by digest and
 * length instead of embedding it (@cto 7f227fa9 carry a). The grader still gets something to compare.
 */
function digestOf(text: string): string {
  const digest = createHash("sha256").update(text).digest("hex").slice(0, 16)
  return `sha256:${digest} (${String(text.length)} chars)`
}

/**
 * Every row of one census read, WITH its layer and onscreen flag. Rows keep their identity here even when
 * they are not gradable candidates: whether a process or a window existed before the launch is a question
 * about all rows, not only about the layer-0 onscreen ones.
 */
function censusRows(rows: unknown): CensusRow[] {
  if (!Array.isArray(rows)) throw new Error("the owned-Mac app launch census must be a window list")
  const out: CensusRow[] = []
  for (const row of rows) {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      throw new Error("the owned-Mac app launch census contains a non-object row")
    }
    const value = row as Record<string, unknown>
    // A row that is an object but lacks the identity keys is not one of ours to skip: the census script
    // always emits them, so a missing one means this is not that script's output and nothing here is read.
    if (typeof value.id !== "number" || typeof value.ownerPid !== "number" || typeof value.layer !== "number") {
      throw new Error(
        `the owned-Mac app launch census row lacks id, owner or layer: ${digestOf(JSON.stringify(value))}`,
      )
    }
    out.push({
      id: value.id,
      ownerPid: value.ownerPid,
      layer: value.layer,
      onscreen: value.onscreen !== false,
      name: value.namePresent === true && typeof value.name === "string" ? value.name : null,
    })
  }
  return out
}

/**
 * The layer-0, onscreen windows in one census read. Offscreen windows are skipped: a launch builds its
 * window in stages and the window server lists the placeholders too, so counting them would read one
 * launch as two windows (@cto cbc34e67 conditions apply to what is graded, not to what is built).
 */
export function launchCensusWindows(rows: unknown): LaunchCensusWindow[] {
  return censusRows(rows)
    .filter((row) => row.layer === 0 && row.onscreen)
    .map((row) => ({ id: row.id, ownerPid: row.ownerPid, name: row.name }))
}

/**
 * The windows this launch created: not present before it, and owned by a process that was not there
 * either. A window the app already had is never claimed, however well its title matches the marker.
 */
export function newWindowsForLaunch(before: readonly unknown[], after: readonly unknown[]): LaunchCensusWindow[] {
  // EVERY row of the before census, any layer and onscreen or not. A process already running with only
  // offscreen or non-layer-0 windows existed before the launch, and so did a window id already listed
  // offscreen: filtering the before set would let this launch claim either (@cto 7f227fa9 required 1).
  const beforeRows = censusRows(before)
  const ids = new Set(beforeRows.map((row) => row.id))
  const pids = new Set(beforeRows.map((row) => row.ownerPid))
  return launchCensusWindows(after).filter((row) => !ids.has(row.id) && !pids.has(row.ownerPid))
}

/** The one window a launch created, or a refusal: zero and several are both refusals, never a guess. */
export function oneNewWindowForLaunch(
  before: readonly unknown[],
  after: readonly unknown[],
  marker: { readonly value: string; readonly required: boolean },
): LaunchCensusWindow {
  if (typeof marker.value !== "string" || marker.value.trim() === "") {
    throw new Error("an owned-Mac app launch needs a run marker; without one no window can be claimed as this run's")
  }
  const fresh = newWindowsForLaunch(before, after)
  const matching = marker.required ? fresh.filter((row) => row.name?.includes(marker.value)) : fresh
  const [only] = matching
  if (only === undefined) {
    throw new Error(
      `the owned-Mac app opened no new window for launch marker ${marker.value}; refusing to grade a window ` +
        "this run cannot claim",
    )
  }
  if (matching.length > 1) {
    throw new Error(
      `the owned-Mac app opened ${String(matching.length)} windows for one launch ` +
        `(${matching.map((row) => String(row.id)).join(", ")}); one run owns one window, so none is graded`,
    )
  }
  return only
}

/** Everything the launcher knows once it has spawned the app: the two censuses around the spawn, the
 * window proof its table entry requires, and the facts only the launcher can read (its own pid, the run's
 * tty, the app's realpath executable, the version it intended). */
export interface OwnedAppLaunchRecordInput {
  readonly appId: string
  readonly launchRunId: string
  readonly workerPid: number
  readonly before: readonly unknown[]
  readonly after: readonly unknown[]
  /** The proof the app's table entry requires; the launcher reads it from ownedAppProofSpec first. */
  readonly windowProof: OwnedAppWindowProof
  readonly executablePath: string
  readonly marker: { readonly flag: string; readonly value: string }
  readonly tty: string
  readonly intendedVersion: string
}

const singleToken = (value: unknown): value is string => typeof value === "string" && /^\S+$/.test(value)

/**
 * The record the launcher writes after the spawn, assembled from the ONE window the census diff attributed
 * to this launch. Pure: no I/O, no clock, no process or window-server read — the caller supplies the
 * censuses and the live facts, so every refusal below is decidable from its arguments alone.
 *
 * Refusals are launches that must not produce a record at all: a marker that does not name this run, a
 * tty that is not one token, an executable that is not absolute, a version nobody measured, or a diff that
 * found zero or several windows. The table gate is separate (ownedAppProofSpec) because the launcher
 * applies it BEFORE spawning, so an app with no entry is refused by name before it can open a window.
 */
export const assembleOwnedAppOwnerAssertion = (input: OwnedAppLaunchRecordInput): OwnedAppOwnerAssertion => {
  if (typeof input.launchRunId !== "string" || !/^[0-9a-f]{32}$/.test(input.launchRunId)) {
    throw new Error("an owned-Mac app launch record needs the run id as 32 lowercase hex characters")
  }
  if (typeof input.appId !== "string" || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(input.appId)) {
    throw new Error(
      "an owned-Mac app launch record needs an app id of lowercase letters, digits, dot, dash or underscore",
    )
  }
  if (!Number.isInteger(input.workerPid) || input.workerPid <= 0) {
    throw new Error("an owned-Mac app launch record needs the launcher's own pid; got " + String(input.workerPid))
  }
  if (!singleToken(input.marker.flag) || !singleToken(input.marker.value)) {
    throw new Error("an owned-Mac app launch record needs a marker flag and value that are single tokens")
  }
  if (!input.marker.value.includes(input.launchRunId)) {
    throw new Error(
      "the launch marker " +
        input.marker.value +
        " does not carry this run's id " +
        input.launchRunId +
        ", so no live process could be proved to belong to this launch",
    )
  }
  if (!isAbsolute(input.executablePath)) {
    throw new Error(
      "the owned-Mac app record needs the app's absolute executable path; got " + String(input.executablePath),
    )
  }
  if (typeof input.tty !== "string" || !/^\/dev\/tty[a-zA-Z0-9._-]+$/.test(input.tty)) {
    throw new Error("an owned-Mac app launch record needs the run's own tty, named as /dev/tty<name>")
  }
  if (typeof input.intendedVersion !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9.+_-]{0,79}$/.test(input.intendedVersion)) {
    throw new Error(
      "an owned-Mac app launch record needs the version this run intended to measure as one version token",
    )
  }
  const window = oneNewWindowForLaunch(input.before, input.after, {
    value: input.marker.value,
    required: input.windowProof === "marker-title",
  })
  if (!Number.isInteger(window.ownerPid) || window.ownerPid <= 0) {
    throw new Error(
      "the new window " +
        String(window.id) +
        " reports no usable owner pid (" +
        String(window.ownerPid) +
        "), so the record could not name the process that owns it",
    )
  }
  return {
    asserter: "terminfo-admin",
    launchRunId: input.launchRunId,
    workerPid: input.workerPid,
    appId: input.appId,
    ownerPid: window.ownerPid,
    windowId: window.id,
    executablePath: input.executablePath,
    marker: { flag: input.marker.flag, value: input.marker.value },
    tty: input.tty,
    intendedVersion: input.intendedVersion,
  }
}

export interface TitleEchoOptions {
  /** The claimed window and its app; the census must show THIS window carrying the nonce. */
  readonly windowId: number
  /** Write a title to the run's own tty (an OSC 0 sequence on the tty the collector runs on). */
  writeTitle: (title: string) => void
  /** The claimed window's title as the census reports it, or null when the census withheld it. */
  readTitle: () => string | null
  /** Put the previous title back; called exactly once, including on refusal. */
  restoreTitle: () => void
  /** Fresh per proof, so a title left from an earlier attempt cannot satisfy this one. */
  readonly nonce: string
  readonly attempts?: number
  readonly wait?: () => void
}

/**
 * Prove "the run's own tty is drawn in that window" by observation instead of an object model (@cto
 * 9f889378 3b). The nonce is written into the title of the tty the collector itself runs on; the census
 * must then show the CLAIMED window's title carrying it. An app that does not report titles to the census
 * cannot use this proof, and its entry says so — there is no fallback to another proof at run time.
 */
export function proveTtyByTitleEcho(options: TitleEchoOptions): string {
  if (typeof options.nonce !== "string" || options.nonce.trim().length < 8) {
    throw new Error(
      "the title-echo tty proof needs a fresh nonce of at least 8 characters; a reused one could be matched " +
        "by a title left over from an earlier attempt",
    )
  }
  const title = `hh-tty-echo-${options.nonce}`
  const attempts = options.attempts ?? 20
  try {
    options.writeTitle(title)
    let lastSeen: string | null = null
    for (let attempt = 0; attempt < attempts; attempt++) {
      const seen = options.readTitle()
      if (seen !== null) {
        // A title that does not carry the echo yet is not a refusal: title updates reach the window server
        // asynchronously, so the old title is expected on the first read or two (@cto 7f227fa9 required 2).
        if (seen.includes(title)) {
          return `tty=title-echo window=${String(options.windowId)} nonce=${options.nonce}`
        }
        lastSeen = seen
      }
      options.wait?.()
    }
    throw new Error(
      `the claimed window ${String(options.windowId)} did not carry this run's echo in ${String(attempts)} ` +
        `attempts (last title seen: ${lastSeen === null ? "none, the census withheld it" : digestOf(lastSeen)}), ` +
        "so the title-echo proof cannot show this tty is drawn there",
    )
  } finally {
    options.restoreTitle()
  }
}
