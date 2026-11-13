/** One context selection rule shared by compatibility and full-project readers. */
import { type FeatureResultStatus, type ProbeResult } from "@terminfo/probe-defs"
import { hasCurrentSource, type FeatureResultDisplayState, type SuiteRelation } from "./release-scope.ts"
import type { SourceHistory } from "./source-history.ts"
import {
  versionCompare,
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
  sources: Array<{
    runId: string
    measuredAt: string
    suiteId: string
    suiteRelation: SuiteRelation
    /**
     * This run recorded a probe selection, so it never measured the whole suite. Absent means this
     * reader held no raw replies to judge (the historical per-version overload); it never means the
     * run was proven full. Only the composed projection path can see `collector.selection`.
     */
    partial?: boolean
  }>
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
          partial: original.selection !== undefined,
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
export type RunSelection =
  | "only current"
  | "default profile"
  | "latest original evidence"
  /** The only candidate standing was a selected run, so the summary covers its selection, not the suite. */
  | "latest partial selection"
  | "app version, then source ancestry"

/** One run that contributed cells to a candidate context: what the lineage pick orders by. */
export interface LineageRun {
  runId: string
  version: string | null
  sourceRevision: string | null
}

/**
 * The run-order-independent pick (33587, @cto d805d1af): the site's per-(app, OS) primary is the candidate with the
 * highest app version, then the descendant source revision. Wall-clock time and arrival order never choose.
 */
export interface ContextLineage<T extends ContextCandidate = ContextCandidate> {
  /** Every run that contributed cells to `candidate`. */
  runs: (candidate: T) => readonly LineageRun[]
  history: Pick<SourceHistory, "isAncestor">
}

export type PickedContextRun<T extends ContextCandidate = ContextCandidate> = { run: T; selection: RunSelection }

/**
 * Prefer current-suite evidence, then a unique permissions-free profile. Remaining ties use the newest
 * contributing original measurement, then the stable context key. Attempts never refresh evidence.
 * This chooses a summary only; the projection retains every context and its original cells.
 *
 * With `lineage` (the site's per-(app, OS) primary, whose observation a row the join refuses shows), the pick
 * is `pickByLineage` instead: app version, then source-revision ancestry, never newest evidence.
 */
export function pickContextRun<T extends ContextCandidate>(
  candidates: readonly T[],
  lineage?: ContextLineage<T>,
): PickedContextRun<T> | undefined {
  if (lineage) return pickByLineage(candidates, lineage)
  const dated = candidates.map((candidate) => {
    const latest = Math.max(...candidate.sources.map((source) => Date.parse(source.measuredAt)))
    if (!Number.isFinite(latest)) throw new Error(`Context ${candidate.key} has no finite original evidence time`)
    return { candidate, latest }
  })
  if (dated.length === 0) return undefined
  const current = dated.filter(({ candidate }) => hasCurrentSource(candidate.sources))
  const considered = current.length > 0 ? current : dated
  // A run that measured a selection is a real reading of its ids and never a reading of the suite, so a
  // full run outranks it at equal standing — in the current-suite pool and in the fallback alike. Only
  // when no full run stands at all may a selected run be the summary, and then the reason says so.
  const full = considered.filter(({ candidate }) => !carriesPartial(candidate))
  const partialOnly = full.length === 0
  const pool = partialOnly ? considered : full
  const [only] = pool
  if (pool.length === 1 && only) {
    return { run: only.candidate, selection: partialOnly ? "latest partial selection" : "only current" }
  }
  const defaults = pool.filter(({ candidate }) => candidate.permissions === null)
  const [onlyDefault] = defaults
  if (defaults.length === 1 && onlyDefault) {
    return {
      run: onlyDefault.candidate,
      selection: partialOnly ? "latest partial selection" : "default profile",
    }
  }
  const [latest] = [...pool].sort(
    (left, right) =>
      right.latest - left.latest ||
      (left.candidate.key < right.candidate.key ? -1 : left.candidate.key > right.candidate.key ? 1 : 0),
  )
  return (
    latest && {
      run: latest.candidate,
      selection: partialOnly ? "latest partial selection" : "latest original evidence",
    }
  )
}

/** The one revision among `revisions` that descends from (or is) every other, or undefined when none does. */
function descendantOfAll(revisions: readonly string[], history: ContextLineage["history"]): string | undefined {
  return revisions.find((tip) => revisions.every((other) => history.isAncestor(other, tip)))
}

/**
 * A candidate holding a run that measured only a selection is a real reading of its ids and never a reading
 * of the suite. Both picks use this one predicate so neither can present such a run as the whole suite.
 */
function carriesPartial(candidate: ContextCandidate): boolean {
  return candidate.sources.some((source) => source.partial === true)
}

/**
 * Highest app version (`versionCompare`, the projection's own order), then the context whose source revision
 * descends from every other's. A context's revision is the tip of its contributing runs at that version, which must
 * themselves form one line. Unrelated revisions refuse by name; equal tips fall to a unique permissions-free
 * profile, then the stable context key.
 */
function pickByLineage<T extends ContextCandidate>(
  candidates: readonly T[],
  lineage: ContextLineage<T>,
): PickedContextRun<T> | undefined {
  const [single] = candidates
  if (candidates.length === 1 && single) {
    return {
      run: single,
      selection: carriesPartial(single) ? "latest partial selection" : "only current",
    }
  }
  if (candidates.length === 0) return undefined
  const facts = candidates.map((candidate) => {
    const runs = lineage.runs(candidate)
    if (runs.length === 0) throw new Error(`Context ${candidate.key} has no contributing run to pick by`)
    for (const run of runs) {
      if (run.version === null) throw new Error(`Context ${candidate.key} run ${run.runId} records no app version`)
    }
    const version = runs
      .map((run) => run.version as string)
      .sort((left, right) => versionCompare(right, left))[0] as string
    return { candidate, version, runs: runs.filter((run) => run.version === version) }
  })
  const top = facts.map((fact) => fact.version).sort((left, right) => versionCompare(right, left))[0]
  const tips = facts
    .filter((fact) => fact.version === top)
    .map((fact) => {
      const revisions = [
        ...new Set(
          fact.runs.map((run) => {
            if (run.sourceRevision === null) {
              throw new Error(`Context ${fact.candidate.key} run ${run.runId} records no source revision`)
            }
            return run.sourceRevision
          }),
        ),
      ]
      const tip = descendantOfAll(revisions, lineage.history)
      if (tip === undefined) {
        throw new Error(
          `Context ${fact.candidate.key} holds runs of app version ${fact.version} from unrelated source revisions ` +
            `${revisions.join(", ")}; the pick refuses`,
        )
      }
      return { candidate: fact.candidate, tip }
    })
  const winner = descendantOfAll(
    tips.map((entry) => entry.tip),
    lineage.history,
  )
  if (winner === undefined) {
    throw new Error(
      `Contexts ${tips.map((entry) => `${entry.candidate.key} (${entry.tip})`).join(", ")} measured app version ${top} ` +
        `from unrelated source revisions; the pick refuses`,
    )
  }
  const tied = tips.filter((entry) => entry.tip === winner).map((entry) => entry.candidate)
  // Equal standing only: among candidates the version-and-ancestry order cannot separate, a full run wins.
  const fullTied = tied.filter((candidate) => !carriesPartial(candidate))
  const pool = fullTied.length > 0 ? fullTied : tied
  const partialOnly = fullTied.length === 0
  const defaults = pool.filter((candidate) => candidate.permissions === null)
  const [chosen] =
    defaults.length === 1 ? defaults : [...pool].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
  return (
    chosen && {
      run: chosen,
      selection: partialOnly ? "latest partial selection" : "app version, then source ancestry",
    }
  )
}
