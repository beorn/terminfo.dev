import { readFileSync, writeFileSync } from "node:fs"

/** Time left after the poll so the job can stop the collector and write run.json before timeout-minutes ends. */
export const COLLECTOR_FLUSH_MARGIN_S = 180

export type ExpiredHarness = "killed-mid-probe" | "never-started"

export interface ExpiredCollectionRow {
  featureId: string
  harness: ExpiredHarness
}

/**
 * Poll length from the job limit, the flush margin, and the seconds already spent before the poll.
 * The margin is not a second copy of the poll: changing timeout-minutes changes this length.
 */
export function collectorPollSeconds(jobLimitS: number, elapsedS: number, marginS = COLLECTOR_FLUSH_MARGIN_S): number {
  return Math.max(1, jobLimitS - marginS - elapsedS)
}

/** A run the collector did not finish. Finished ids stay out. One started id is killed; the rest never started. */
export function expiredCollectionRun(args: {
  ids: readonly string[]
  finishedIds?: readonly string[]
  startedId?: string
  collectorDurationMs: number
}): { suiteComplete: false; collectorDurationMs: number; results: ExpiredCollectionRow[] } {
  const finished = new Set(args.finishedIds ?? [])
  const results: ExpiredCollectionRow[] = []
  for (const featureId of args.ids) {
    if (finished.has(featureId)) continue
    results.push({
      featureId,
      harness: featureId === args.startedId ? "killed-mid-probe" : "never-started",
    })
  }
  return { suiteComplete: false, collectorDurationMs: args.collectorDurationMs, results }
}

export function writeExpiredCollection(
  path: string,
  args: Parameters<typeof expiredCollectionRun>[0],
): void {
  writeFileSync(path, `${JSON.stringify(expiredCollectionRun(args), null, 2)}\n`)
}

export function readFinishedIds(runPath: string): string[] {
  try {
    const parsed = JSON.parse(readFileSync(runPath, "utf8")) as { results?: { featureId?: string; harness?: string }[] }
    return (parsed.results ?? []).flatMap((row) =>
      typeof row.featureId === "string" && row.harness === undefined ? [row.featureId] : [],
    )
  } catch {
    return []
  }
}

if (import.meta.main) {
  const [path, rawIds, duration] = process.argv.slice(2)
  if (path === undefined || rawIds === undefined || duration === undefined) {
    throw new Error("usage: flush-expired-collection.ts <run.json> <probe-ids-json> <duration-ms>")
  }
  const ids = JSON.parse(rawIds) as unknown
  if (!Array.isArray(ids) || !ids.every((id) => typeof id === "string")) {
    throw new Error("probe ids must be a JSON array of strings")
  }
  writeExpiredCollection(path, {
    ids,
    finishedIds: readFinishedIds(path),
    collectorDurationMs: Number(duration),
  })
}
