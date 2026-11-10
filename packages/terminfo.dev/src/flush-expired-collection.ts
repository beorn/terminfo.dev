import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { loadFeatures } from "@terminfo/catalog"

/** Time left after the poll so the job can stop the collector and write run.json before timeout-minutes ends. */
export const COLLECTOR_FLUSH_MARGIN_S = 180

export type ExpiredHarness = "killed-mid-probe" | "never-started"

export interface ExpiredCollectionRow {
  featureId: string
  status: "probe-todo"
  reason: string
  harnessOutcome: ExpiredHarness
  attempt: { scope: "none" }
  tests: [{ id: "criterion"; status: "probe-todo"; reason: string; attempt: { scope: "none" } }]
}

/**
 * Poll length from the job limit, the flush margin, and the seconds already spent before the poll.
 * The margin is not a second copy of the poll: changing timeout-minutes changes this length.
 */
export function collectorPollSeconds(jobLimitS: number, elapsedS: number, marginS = COLLECTOR_FLUSH_MARGIN_S): number {
  return Math.max(1, jobLimitS - marginS - elapsedS)
}

/** The last listed id that appears in the collector log is the one the poll interrupted. */
export function startedIdFromLog(log: string, ids: readonly string[]): string | undefined {
  let started: string | undefined
  let at = -1
  for (const id of ids) {
    const index = log.lastIndexOf(id)
    if (index > at) {
      at = index
      started = id
    }
  }
  return started
}

function unfinishedRow(featureId: string, harnessOutcome: ExpiredHarness): ExpiredCollectionRow {
  const reason = harnessOutcome === "killed-mid-probe" ? "killed mid-probe" : "never started"
  return {
    featureId,
    status: "probe-todo",
    reason,
    harnessOutcome,
    attempt: { scope: "none" },
    tests: [{ id: "criterion", status: "probe-todo", reason, attempt: { scope: "none" } }],
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Keep results the collector already wrote. Add each unfinished id as its own harness outcome. */
export function expiredCollectionRun(args: {
  ids: readonly string[]
  existing?: unknown
  startedId?: string
  collectorDurationMs: number
}): { suiteComplete: false; collectorDurationMs: number; results: unknown[] } {
  const existing = isRecord(args.existing) ? args.existing : {}
  const prior = Array.isArray(existing.results) ? existing.results : []
  const finished = new Set(
    prior.flatMap((row) => (isRecord(row) && typeof row.featureId === "string" ? [row.featureId] : [])),
  )
  const added = args.ids
    .filter((featureId) => !finished.has(featureId))
    .map((featureId) => unfinishedRow(featureId, featureId === args.startedId ? "killed-mid-probe" : "never-started"))
  return {
    ...existing,
    suiteComplete: false,
    collectorDurationMs: args.collectorDurationMs,
    results: [...prior, ...added],
  }
}

export function writeExpiredCollection(path: string, args: Parameters<typeof expiredCollectionRun>[0]): void {
  writeFileSync(path, `${JSON.stringify(expiredCollectionRun(args), null, 2)}\n`)
}

/** A full-suite launch passes the string `null`. The catalogue is the list, not that argument. */
export function collectionIds(raw: string, contentDir: string): string[] {
  if (raw !== "null" && raw !== "") {
    const ids = JSON.parse(raw) as unknown
    if (!Array.isArray(ids) || !ids.every((id) => typeof id === "string")) {
      throw new Error("probe ids must be a JSON array of strings")
    }
    return ids
  }
  return Object.keys(loadFeatures(contentDir)).sort()
}

/** Finished rows have tests. The in-progress row has an attempt and no tests. */
export function rowsFromDraft(draft: unknown): { finished: unknown[]; startedId?: string } {
  if (!isRecord(draft) || !Array.isArray(draft.results)) return { finished: [] }
  const finished: unknown[] = []
  let startedId: string | undefined
  for (const row of draft.results) {
    if (!isRecord(row) || typeof row.featureId !== "string") continue
    const tests = Array.isArray(row.tests) ? row.tests : []
    if (tests.length > 0) finished.push(row)
    else if (row.attempt !== undefined) startedId = row.featureId
  }
  return { finished, startedId }
}

export function readExistingRun(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"))
  } catch {
    return undefined
  }
}

if (import.meta.main) {
  const [path, rawIds, duration, draftPath, logPath] = process.argv.slice(2)
  if (path === undefined || rawIds === undefined || duration === undefined) {
    throw new Error(
      "usage: flush-expired-collection.ts <run.json> <probe-ids-json|null> <duration-ms> [draft.json] [collector.log]",
    )
  }
  const ids = collectionIds(rawIds, join(process.cwd(), "content"))
  const draft = draftPath === undefined || draftPath === "" ? undefined : readExistingRun(draftPath)
  const fromDraft = rowsFromDraft(draft)
  const log = logPath === undefined || logPath === "" ? "" : readFileSync(logPath, "utf8")
  const run = expiredCollectionRun({
    ids,
    existing: { ...(isRecord(readExistingRun(path)) ? readExistingRun(path) : {}), results: fromDraft.finished },
    startedId: fromDraft.startedId ?? startedIdFromLog(log, ids),
    collectorDurationMs: Number(duration),
  })
  writeFileSync(path, `${JSON.stringify(run, null, 2)}\n`)
}
