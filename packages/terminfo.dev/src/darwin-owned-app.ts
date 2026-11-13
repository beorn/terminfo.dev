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

/**
 * The layer-0, onscreen windows in one census read. Offscreen windows are skipped: a launch builds its
 * window in stages and the window server lists the placeholders too, so counting them would read one
 * launch as two windows (@cto cbc34e67 conditions apply to what is graded, not to what is built).
 */
export function launchCensusWindows(rows: unknown): LaunchCensusWindow[] {
  if (!Array.isArray(rows)) throw new Error("the owned-Mac app launch census must be a window list")
  const out: LaunchCensusWindow[] = []
  for (const row of rows) {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      throw new Error("the owned-Mac app launch census contains a non-object row")
    }
    const value = row as Record<string, unknown>
    if (typeof value.id !== "number" || typeof value.ownerPid !== "number" || value.layer !== 0) continue
    if (value.onscreen === false) continue
    out.push({
      id: value.id,
      ownerPid: value.ownerPid,
      name: value.namePresent === true && typeof value.name === "string" ? value.name : null,
    })
  }
  return out
}

/**
 * The windows this launch created: not present before it, and owned by a process that was not there
 * either. A window the app already had is never claimed, however well its title matches the marker.
 */
export function newWindowsForLaunch(before: readonly unknown[], after: readonly unknown[]): LaunchCensusWindow[] {
  const beforeRows = launchCensusWindows(before)
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
    for (let attempt = 0; attempt < attempts; attempt++) {
      const seen = options.readTitle()
      if (seen !== null) {
        if (!seen.includes(title)) {
          throw new Error(
            `the claimed window ${String(options.windowId)} shows a title that is not this run's echo ` +
              `(${JSON.stringify(seen)}); the tty is not drawing in the claimed window`,
          )
        }
        return `tty=title-echo window=${String(options.windowId)} nonce=${options.nonce}`
      }
      options.wait?.()
    }
    throw new Error(
      `the claimed window ${String(options.windowId)} reported no title through the census in ${String(attempts)} ` +
        "attempts, so the title-echo proof cannot show this tty is drawn there",
    )
  } finally {
    options.restoreTitle()
  }
}
