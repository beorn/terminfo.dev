/**
 * Periodic progress and per-phase timing for `scripts/generate-analysis.ts` (#38708).
 *
 * Analysis runs synchronous corpus loads, artifact checks, projection, HTML generation,
 * and retained working-history folds inside one Bun process, so a timer cannot interrupt
 * a long loop. Callers invoke `phase()` at phase boundaries and `tick()` inside loops;
 * a line is emitted whenever `intervalMs` (default 15 s, well under the 30 s budget) has
 * elapsed since the last emission, and `formatSummary()` reports every phase's duration.
 */

export const DEFAULT_ANALYSIS_PROGRESS_INTERVAL_MS = 15_000

export interface AnalysisPhaseDuration {
  readonly phase: string
  readonly ms: number
  readonly count: number
  readonly total?: number
}

export interface AnalysisProgressReporter {
  phase(name: string, total?: number): void
  tick(count?: number, total?: number): void
  finish(): { readonly totalMs: number; readonly phases: readonly AnalysisPhaseDuration[] }
  formatSummary(): string
}

export interface CreateAnalysisProgressOptions {
  readonly intervalMs?: number
  readonly now?: () => number
  readonly emit?: (line: string) => void
  readonly prefix?: string
}

function formatSeconds(ms: number): string {
  return (ms / 1000).toFixed(1)
}

function formatCount(count: number, total: number | undefined): string {
  return total === undefined ? String(count) : `${count}/${total}`
}

export function createAnalysisProgress(options: CreateAnalysisProgressOptions = {}): AnalysisProgressReporter {
  const intervalMs = options.intervalMs ?? DEFAULT_ANALYSIS_PROGRESS_INTERVAL_MS
  const now = options.now ?? (() => performance.now())
  const emit = options.emit ?? ((line: string) => console.error(line))
  const prefix = options.prefix ?? "generate-analysis"

  const startedAt = now()
  let lastEmitAt = startedAt
  let current: { name: string; startedAt: number; count: number; total?: number } | null = null
  const completed: AnalysisPhaseDuration[] = []
  let finishedAt: number | null = null

  const emitProgress = (at: number): void => {
    if (current === null) return
    const phaseMs = Math.max(0, at - current.startedAt)
    const totalMs = Math.max(0, at - startedAt)
    emit(
      `${prefix}: phase ${current.name} ${formatCount(current.count, current.total)} ` +
        `(${formatSeconds(phaseMs)}s in phase, ${formatSeconds(totalMs)}s total)`,
    )
    lastEmitAt = at
  }

  const closeCurrent = (at: number): void => {
    if (current === null) return
    if (at - lastEmitAt >= intervalMs) emitProgress(at)
    completed.push({
      phase: current.name,
      ms: Math.max(0, at - current.startedAt),
      count: current.count,
      ...(current.total === undefined ? {} : { total: current.total }),
    })
    current = null
  }

  return {
    phase(name: string, total?: number): void {
      const at = now()
      closeCurrent(at)
      current = { name, startedAt: at, count: 0, ...(total === undefined ? {} : { total }) }
    },
    tick(count?: number, total?: number): void {
      if (current === null) return
      current.count = count ?? current.count + 1
      if (total !== undefined) current.total = total
      const at = now()
      if (at - lastEmitAt >= intervalMs) emitProgress(at)
    },
    finish(): { readonly totalMs: number; readonly phases: readonly AnalysisPhaseDuration[] } {
      const at = now()
      closeCurrent(at)
      finishedAt = at
      return {
        totalMs: Math.max(0, finishedAt - startedAt),
        phases: [...completed],
      }
    },
    formatSummary(): string {
      const end = finishedAt ?? now()
      const phases =
        current === null
          ? completed
          : [
              ...completed,
              {
                phase: current.name,
                ms: Math.max(0, end - current.startedAt),
                count: current.count,
                ...(current.total === undefined ? {} : { total: current.total }),
              },
            ]
      const totalMs = Math.max(0, end - startedAt)
      const parts = phases.map(
        (entry) =>
          `${entry.phase} ${formatSeconds(entry.ms)}s (${
            entry.total !== undefined && entry.total !== entry.count ? `${entry.count}/${entry.total}` : entry.count
          })`,
      )
      return `${prefix}: phase durations — ${parts.join("; ")} (total ${formatSeconds(totalMs)}s)`
    },
  }
}
