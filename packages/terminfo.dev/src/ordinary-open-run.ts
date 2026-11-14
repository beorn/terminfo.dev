/**
 * The collector half of an ordinary-open run (@cto 2026-11-13, PLAN GO d82ef4d0).
 *
 * A person opened the app themselves; a host-side launcher wrote a receipt naming the live process chain that
 * reached it. This module turns that receipt into the one thing the probe batch accepts — `ordinaryOpen` — and
 * refuses to start when the receipt cannot bind this run. It never grades a row itself: the gate in
 * probes/unified.ts admits only the three OSC 52 rows, and only after its own live walk.
 */
import { basename } from "node:path"
import { appBundleId } from "./app-bundles.ts"
import { createDarwinClipboardAdapter, type DarwinCommand } from "./darwin-clipboard.ts"
import type { LinuxClipboardAdapter } from "./linux-clipboard.ts"
import {
  checkOrdinaryOpenLiveAncestry,
  readOrdinaryOpenReceipt,
  type LiveAncestryReader,
  type OrdinaryOpenReceipt,
} from "./ordinary-open-receipt.ts"

/** The variable a launcher sets to hand a collector the receipt for a window the person opened. */
export const ORDINARY_OPEN_RECEIPT_ENV = "TERMINFO_ORDINARY_OPEN_RECEIPT"
/** The other, unrelated proof: a disposable runner's own receipt. A run is one or the other, never both. */
export const DISPOSABLE_RECEIPT_ENV = "TERMINFO_DISPOSABLE_RECEIPT"

/** What an ordinary-open run is, once its receipt has been bound to this run's subject. */
export interface OrdinaryOpenRun {
  readonly receipt: OrdinaryOpenReceipt
  /** The registry's bundle id for this subject: the receipt must name exactly this bundle. */
  readonly expectedBundleId: string
  /** Built here, from the receipt's own subject; the gate only admits it, and never ORs it into ownership. */
  readonly clipboard: LinuxClipboardAdapter
}

export interface OrdinaryOpenSubject {
  readonly id: string
  readonly os: string
  /** The row's measured version. An ordinary-open run cannot bind one without it. */
  readonly version: string | undefined
}

/** The receipt path this run was given, or undefined for every other kind of run. */
export function ordinaryOpenReceiptPath(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const path = env[ORDINARY_OPEN_RECEIPT_ENV]
  if (path === undefined) return undefined
  if (path.trim() === "") {
    throw new Error(`${ORDINARY_OPEN_RECEIPT_ENV} is set but empty: unset it, or name the receipt this run trusts`)
  }
  const disposable = env[DISPOSABLE_RECEIPT_ENV]
  if (disposable !== undefined && disposable.trim() !== "") {
    throw new Error(
      `Both ${ORDINARY_OPEN_RECEIPT_ENV} and ${DISPOSABLE_RECEIPT_ENV} are set: an ordinary-open run and a ` +
        "disposable run are different machines and different proofs; set exactly one",
    )
  }
  return path
}

/**
 * Bind a receipt to this run, or refuse at START with one named line and no rows produced (@cto 2026-11-13).
 * The per-row gate stays as the second lock; this is the loud first one.
 */
export async function resolveOrdinaryOpenRun(input: {
  readonly receiptPath: string
  readonly runId: string
  readonly subject: OrdinaryOpenSubject
  /** Overridable only so a test can drive the pasteboard without a Mac. */
  readonly run?: DarwinCommand
  /** The pid whose ancestry is walked; the collector's own by default. */
  readonly probePid?: number
  /**
   * Overridable only so a test can drive the walk, exactly like the batch's own `readAncestry` seam. Production
   * never passes it: the walk reads the real parent chain on every pasteboard read and write.
   */
  readonly readAncestry?: LiveAncestryReader
}): Promise<OrdinaryOpenRun> {
  const { receiptPath, runId, subject } = input
  if (runId === "") {
    throw new Error(
      "an ordinary-open receipt names the run it belongs to, and this collector was given no run id " +
        "(TERMINFO_RUN_ID): a receipt that cannot be tied to a run proves nothing",
    )
  }
  const receipt = readOrdinaryOpenReceipt(receiptPath)
  if (receipt.runId !== runId) {
    throw new Error(
      `ordinary-open receipt belongs to run ${receipt.runId}, this run is ${runId}: a receipt from another run ` +
        "proves nothing about this one",
    )
  }
  if (subject.os !== "macos") {
    throw new Error(`an ordinary-open receipt grades a macOS app, and this run measures ${subject.os}`)
  }
  if (receipt.subject.id !== subject.id) {
    throw new Error(`ordinary-open receipt names ${receipt.subject.id}, and this run measures ${subject.id}`)
  }
  const expectedBundleId = appBundleId(subject.id)
  if (expectedBundleId === undefined) {
    throw new Error(
      `no bundle id is named for ${subject.id} in the app registry, so an ordinary-open receipt cannot bind this app`,
    )
  }
  if (receipt.subject.bundleId !== expectedBundleId) {
    throw new Error(
      `ordinary-open receipt bundle id ${receipt.subject.bundleId} is not the bundle ${subject.id} names ` +
        `(${expectedBundleId})`,
    )
  }
  if (subject.version === undefined) {
    throw new Error(
      `this run has no measured version, so the ordinary-open receipt's app version ${receipt.subject.version} ` +
        "cannot be bound: a run that cannot bind a version has nothing to grade here",
    )
  }
  if (receipt.subject.version !== subject.version) {
    throw new Error(`ancestry app is version ${receipt.subject.version}, row measures ${subject.version}`)
  }
  // @dev/16 12:22 nit: a receipt for an app that is already gone binds nothing, so the walk runs at START too.
  // The same check runs again on every read and write; this one only decides whether the run may begin.
  const startVerdict = checkOrdinaryOpenLiveAncestry({
    receipt,
    expectedBundleId,
    probePid: input.probePid ?? process.pid,
    ...(input.readAncestry && { reader: input.readAncestry }),
  })
  if (!startVerdict.ok) throw new Error(startVerdict.probeTodo)
  const clipboard = await createDarwinClipboardAdapter({
    appId: receipt.subject.id,
    appComm: basename(receipt.subject.executableInBundle),
    titleRead: "none",
    titleUnavailable:
      "an ordinary-open run has no owned window: the receipt names the app's process, it does not own its window",
    ownedHost: false,
    // The person's own pasteboard: neither its digest nor its length may be published (@cto 2026-11-13).
    personClipboard: { foreignReadDigest: "absent" },
    // Re-walked on every pasteboard read and write; no cached pass (@cto 2026-11-13). The walk is synchronous, so
    // the promise is spelled out rather than implied by `async`: what the adapter gets is a rejected promise naming
    // the row's refusal, and nothing here waits on anything.
    assertOwned: () => {
      const verdict = checkOrdinaryOpenLiveAncestry({
        receipt,
        expectedBundleId,
        probePid: input.probePid ?? process.pid,
        ...(input.readAncestry && { reader: input.readAncestry }),
      })
      return verdict.ok ? Promise.resolve() : Promise.reject(new Error(verdict.probeTodo))
    },
    ...(input.run === undefined ? {} : { run: input.run }),
  })
  return { receipt, expectedBundleId, clipboard }
}

/**
 * What the run publishes about the receipt it trusted. No path anywhere: not the receipt's, not the executable's
 * — the app is named by its basename and its bundle id, the chain by its length (@cto 2026-11-13).
 */
export function ordinaryOpenRecord(run: OrdinaryOpenRun, probePid: number = process.pid): string {
  // Asked now, not remembered: the record must say what was true when the rows finished, and a walk that fails
  // answers "not alive" rather than claiming the app was there.
  const live = checkOrdinaryOpenLiveAncestry({
    receipt: run.receipt,
    expectedBundleId: run.expectedBundleId,
    probePid,
  })
  return JSON.stringify({
    sha256: run.receipt.sha256,
    subject: {
      id: run.receipt.subject.id,
      bundleId: run.receipt.subject.bundleId,
      version: run.receipt.subject.version,
      executable: basename(run.receipt.subject.executableInBundle),
    },
    bundleId: run.expectedBundleId,
    chainLength: run.receipt.ancestry.chain.length,
    appPidAlive: live.ok,
  })
}

/**
 * One proof per run (@cto 2026-11-13, F3). An owned terminal and an ordinary-open receipt answer the same question
 * — whose window is this — by different machines, and a run that claims both would OR two proofs into one artifact.
 * Kept here, not inline in serve.ts, so the refusal has a test in an environment where serve.test.ts does not run.
 */
export function assertOneProofPerRun(receiptSet: boolean, ownedTerminalKind: string | undefined): void {
  if (!receiptSet || ownedTerminalKind === undefined) return
  throw new Error(
    `${ORDINARY_OPEN_RECEIPT_ENV} is set on a run that owns its terminal (${ownedTerminalKind}): an owned run and ` +
      "an ordinary-open receipt are different proofs; set exactly one",
  )
}

/**
 * The rows must publish the version the receipt bound (@dev/16 12:22 R1). START binds what the run knows before its
 * first probe; the subject publishes what the probes measured, and the two are not always the same string — so a run
 * whose rows would disagree with its receipt refuses instead of publishing rows about another build.
 */
export function assertOrdinaryOpenVersionBound(run: OrdinaryOpenRun, publishedVersion: string | undefined): void {
  if (publishedVersion === run.receipt.subject.version) return
  throw new Error(
    `this run publishes app version ${publishedVersion ?? "(none)"}, and the ordinary-open receipt bound ` +
      `${run.receipt.subject.version}: rows about another build are not this receipt's rows`,
  )
}
