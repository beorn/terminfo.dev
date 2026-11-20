import { setTimeout as delay } from "node:timers/promises"
import type { ProbeAttempt, ProbeResult, RunDraft } from "@terminfo/probe-defs"

/**
 * A wait a hosted app declares in its app table: the collector holds it once, after launch and before the
 * first probe, so no row is judged on a frame the app is still drawing (37225; ruling C on 33774, @chief
 * b83b016c and 2411997). It moves only when rows are taken; the per-read sentinel check stays the only
 * refusal, so a frame that has still not settled is refused exactly as before. Absent: no wait.
 */
export type LaunchSettle = { readonly seconds: number; readonly reason: string }

/** The run's record of the wait, beside the collector's other records in rawReplies. */
export const LAUNCH_SETTLE_KEY = "collector.launchSettle"

export type LaunchSettleRecord = {
  readonly declaredSeconds: number
  readonly effectiveSeconds: number
  /** Where the effective value came from. The app table is the only source; no dispatch input sets it. */
  readonly source: "hosted app table"
  readonly reason: string
  readonly startedAt: string
  readonly endedAt: string
  readonly waitedMs: number
}

/** Hold the declared wait, record it in the draft, and return the epoch ms the frame was released at. */
export async function holdLaunchSettle(
  draft: Pick<RunDraft, "rawReplies">,
  settle: LaunchSettle,
  signal?: AbortSignal,
  wait: (ms: number, signal?: AbortSignal) => Promise<unknown> = (ms, abort) =>
    delay(ms, undefined, abort === undefined ? undefined : { signal: abort }),
): Promise<number> {
  if (!Number.isSafeInteger(settle.seconds) || settle.seconds < 1 || settle.reason.trim() === "") {
    throw new Error(`Launch settle must be whole seconds >= 1 with a reason: ${JSON.stringify(settle)}`)
  }
  const started = Date.now()
  await wait(settle.seconds * 1000, signal)
  const ended = Date.now()
  const record: LaunchSettleRecord = {
    declaredSeconds: settle.seconds,
    effectiveSeconds: settle.seconds,
    source: "hosted app table",
    reason: settle.reason,
    startedAt: new Date(started).toISOString(),
    endedAt: new Date(ended).toISOString(),
    waitedMs: ended - started,
  }
  draft.rawReplies[LAUNCH_SETTLE_KEY] = JSON.stringify(record)
  return ended
}

function stamp(attempt: ProbeAttempt, settledAt: number): ProbeAttempt {
  if (attempt.scope === "none") return attempt
  const after = Date.parse(attempt.startedAt) - settledAt
  if (!Number.isSafeInteger(after) || after < 0) {
    throw new Error(
      `Attempt started ${attempt.startedAt}, before the launch settle ended at ${new Date(settledAt).toISOString()}`,
    )
  }
  return { ...attempt, msAfterLaunchSettle: after }
}

/** Each row's settle witness: how long after the wait ended its attempt started. Rows never attempted stay as they are. */
export function stampMsAfterLaunchSettle(results: ProbeResult[], settledAt: number): void {
  for (const result of results) {
    result.attempt = stamp(result.attempt, settledAt)
    for (const test of result.tests) test.attempt = stamp(test.attempt, settledAt)
  }
}
