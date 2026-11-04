/** One context selection rule shared by compatibility and full-project readers. */
import type { FeatureResultStatus, ProbeResult } from "@terminfo/probe-defs"
import { hasCurrentSource, type FeatureResultDisplayState, type SuiteRelation } from "./release-scope.ts"
import {
  originalRunFor,
  type SelectedVersion,
  type CurrentSelectedVersion,
  type SelectedContextSummary,
  type SelectedProjection,
} from "./selected-results.ts"

/**
 * Minimal cell view a reader keeps beside the classified `states`; `SelectedCell` satisfies it
 * structurally. `reason` and `note` are carried so a consumer can print the RUN'S OWN words for an
 * inconclusive row (the named cause, such as a terminal that never answers `CSI 16 t`) instead of
 * paraphrasing one of its own. Bars are cut over `states`; this raw view is only the run's own words.
 */
export type ShareCells = Record<
  string,
  { outcome: string; conclusive?: boolean; reason?: string; note?: string; evidence?: string }
>

/** One candidate context the site currently selects, reduced to what the readers consume. */
export interface ContextCandidate {
  key: string
  kind: string
  terminalId: string
  os: string
  permissions: string | null
  sources: Array<{ runId: string; measuredAt: string; suiteId: string; suiteRelation: SuiteRelation }>
  /** The canonical context, when this candidate is a composed view. */
  context?: SelectedContextSummary
  cells?: ShareCells
  results?: ProbeResult[]
  /**
   * The run's states as the projection published them (28792 item 1). A reader cuts its bars over
   * this, never over the raw `cells`.
   */
  states: Readonly<Record<string, FeatureResultDisplayState | FeatureResultStatus>>
}

export interface HistoricalContextCandidate extends ContextCandidate {
  cells: ShareCells
  results?: never
  states: Readonly<Record<string, FeatureResultDisplayState>>
}

export interface CurrentContextCandidate extends ContextCandidate {
  results: ProbeResult[]
  cells?: never
  states: Readonly<Record<string, FeatureResultStatus>>
}

/** The candidate for one context key, from the projection's own selected version. */
export function candidateFromSelected(
  key: string,
  selected: SelectedContextSummary,
  states: Readonly<Record<string, FeatureResultStatus>>,
  projection: SelectedProjection,
): CurrentContextCandidate | undefined
export function candidateFromSelected(
  key: string,
  selected: SelectedVersion,
  states: Readonly<Record<string, FeatureResultDisplayState>>,
): HistoricalContextCandidate
export function candidateFromSelected(
  key: string,
  selected: CurrentSelectedVersion,
  states: Readonly<Record<string, FeatureResultStatus>>,
): CurrentContextCandidate
export function candidateFromSelected(
  key: string,
  selected: SelectedVersion | CurrentSelectedVersion,
  states: Readonly<Record<string, FeatureResultDisplayState | FeatureResultStatus>>,
): ContextCandidate
export function candidateFromSelected(
  key: string,
  selected: SelectedVersion | CurrentSelectedVersion | SelectedContextSummary,
  states: Readonly<Record<string, FeatureResultDisplayState | FeatureResultStatus>>,
  projection?: SelectedProjection,
): ContextCandidate | undefined {
  if ("contributingRunIds" in selected) {
    if (selected.contributingRunIds.length === 0) return undefined
    if (!selected.subject) throw new Error(`Context ${key} has contributing evidence without physical subject facts`)
    if (!projection) throw new Error(`Context ${key} needs its original projection history`)
    return {
      key,
      kind: selected.subject.kind,
      terminalId: selected.subject.id,
      os: selected.subject.os ?? "",
      permissions: selected.subject.permissions,
      sources: selected.contributingRunIds.map((runId) => {
        const original = originalRunFor(projection, key, runId)
        return {
          runId,
          measuredAt: original.measuredAt,
          suiteId: original.suiteId,
          suiteRelation: original.suiteRelation,
        }
      }),
      context: selected,
      results: Object.values(selected.cells).map((cell) => cell.result),
      states,
    }
  }
  return {
    key,
    kind: selected.subject.kind,
    terminalId: selected.subject.id,
    os: selected.subject.os ?? "",
    permissions: selected.subject.permissions ?? null,
    sources: [
      {
        runId: selected.runId,
        measuredAt: selected.measuredAt,
        suiteId: selected.suiteId,
        suiteRelation: selected.suiteRelation,
      },
    ],
    ...("results" in selected ? { results: selected.results } : { cells: selected.cells }),
    states,
  }
}

/** How the summary context was chosen, printed beside the row. */
export type RunSelection = "only current" | "default profile" | "latest original evidence"

export type PickedContextRun<T extends ContextCandidate = ContextCandidate> = { run: T; selection: RunSelection }

/**
 * Prefer current-suite evidence, then a unique permissions-free profile. Remaining ties use the newest
 * contributing original measurement, then the stable context key. Attempts never refresh evidence.
 * This chooses a summary only; the projection retains every context and its original cells.
 */
export function pickContextRun<T extends ContextCandidate>(candidates: readonly T[]): PickedContextRun<T> | undefined {
  const dated = candidates.map((candidate) => {
    const latest = Math.max(...candidate.sources.map((source) => Date.parse(source.measuredAt)))
    if (!Number.isFinite(latest)) throw new Error(`Context ${candidate.key} has no finite original evidence time`)
    return { candidate, latest }
  })
  if (dated.length === 0) return undefined
  const current = dated.filter(({ candidate }) => hasCurrentSource(candidate.sources))
  const considered = current.length > 0 ? current : dated
  const [only] = considered
  if (considered.length === 1 && only) return { run: only.candidate, selection: "only current" }
  const defaults = considered.filter(({ candidate }) => candidate.permissions === null)
  const [onlyDefault] = defaults
  if (defaults.length === 1 && onlyDefault) return { run: onlyDefault.candidate, selection: "default profile" }
  const [latest] = [...considered].sort(
    (left, right) =>
      right.latest - left.latest ||
      (left.candidate.key < right.candidate.key ? -1 : left.candidate.key > right.candidate.key ? 1 : 0),
  )
  return latest && { run: latest.candidate, selection: "latest original evidence" }
}
