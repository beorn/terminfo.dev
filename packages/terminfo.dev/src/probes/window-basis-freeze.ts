/**
 * Which retained run decides each window cell's frozen trace (#39207, @cto 313ea37a).
 *
 * The re-freeze used to keep every committed run's trace, and old runs are never retired, so a write
 * the probes have since stopped making (ESC 7/ESC 8 from an old sentinel paint) refused its cell
 * forever. The latest measurement wins instead, as everywhere else in the grading: per (subject, cell),
 * the newest run whose result for that cell completed, with writes for it. A run whose result for the
 * cell is missing or carries a harness outcome (collector error, probe exceeded, ...) never displaces
 * an older complete one; it decides only when no complete run exists. Old runs stay on disk: this is
 * selection, not deletion.
 *
 * The subject is the app on its platform and launch: kind, id, os, outer terminal, mux, config and
 * permissions. The app version and OS version are left out on purpose, so a newer build or OS
 * supersedes an older one rather than keeping its trace beside it.
 */
import { isHarnessOutcome } from "@terminfo/probe-defs"

/** One committed run file, as the freeze read it. */
export interface FreezeRun {
  readonly path: string
  readonly subject: unknown
  readonly measuredAt: unknown
  readonly results: unknown
  /** The window-cell entries this run holds with readable writes, by entry key, grouped by cell. */
  readonly cells: ReadonlyMap<string, readonly string[]>
}

/** The selected run per (subject, cell), and the entries kept per file. */
export interface FreezeSelection {
  /** Entry keys kept per file path. A file with none is not a frozen source. */
  readonly keep: ReadonlyMap<string, ReadonlySet<string>>
}

function subjectKey(subject: unknown): string {
  const s = (subject ?? {}) as Record<string, unknown>
  return JSON.stringify([
    s.kind,
    s.id,
    s.os,
    s.outerTerminal ?? null,
    s.mux ?? null,
    s.config ?? null,
    s.permissions ?? null,
  ])
}

/** Whether the run's result for this cell completed: present, and no harness outcome. */
function completed(results: unknown, cell: string): boolean {
  if (!Array.isArray(results)) return false
  const result = results.find(
    (entry): entry is { featureId: string; harnessOutcome?: unknown } =>
      typeof entry === "object" && entry !== null && (entry as { featureId?: unknown }).featureId === cell,
  )
  return result !== undefined && !isHarnessOutcome(result.harnessOutcome)
}

function measuredMs(run: FreezeRun): number {
  const ms = typeof run.measuredAt === "string" ? Date.parse(run.measuredAt) : Number.NaN
  if (Number.isNaN(ms)) {
    throw new Error(
      `${run.path}: measuredAt ${JSON.stringify(run.measuredAt)} is not a time, so its run cannot be ordered`,
    )
  }
  return ms
}

export function selectWindowTraces(runs: readonly FreezeRun[]): FreezeSelection {
  const best = new Map<string, { run: FreezeRun; complete: boolean; ms: number }>()
  for (const run of runs) {
    for (const cell of run.cells.keys()) {
      const key = `${subjectKey(run.subject)}\u0000${cell}`
      const candidate = { run, complete: completed(run.results, cell), ms: measuredMs(run) }
      const held = best.get(key)
      const better =
        held === undefined ||
        (candidate.complete && !held.complete) ||
        (candidate.complete === held.complete &&
          (candidate.ms > held.ms || (candidate.ms === held.ms && candidate.run.path > held.run.path)))
      if (better) best.set(key, candidate)
    }
  }
  const keep = new Map<string, Set<string>>()
  for (const [key, { run }] of best) {
    const cell = key.slice(key.indexOf("\u0000") + 1)
    const kept = keep.get(run.path) ?? new Set<string>()
    for (const entry of run.cells.get(cell) ?? []) kept.add(entry)
    keep.set(run.path, kept)
  }
  return { keep }
}
