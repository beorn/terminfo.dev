/**
 * THE one run-selection rule (28792 item 1). Given the candidate runs the site currently selects for
 * one context, it chooses the run a bar row — or a compatibility key — stands on, or refuses.
 *
 * The site and this reader must not hold two copies of this: `compatibilitySubjects` resolves a
 * multi-context tie with the reviewed `default-contexts.json` row, and `decisive-share` printed the
 * choice of a private fallback chain beside it. One rule, two callers.
 */
import type { ProbeStatus, ProbeResult } from "@terminfo/probe-defs"
import { isStaleRelation, type CellState, type SuiteRelation } from "./release-scope.ts"
import {
  parseProjectedContextKey,
  recognizeProjectedContextKey,
  originalRunFor,
  type ProjectedContextKeyParts,
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
  states: Readonly<Record<string, CellState | ProbeStatus>>
}

export interface HistoricalContextCandidate extends ContextCandidate {
  cells: ShareCells
  results?: never
  states: Readonly<Record<string, CellState>>
}

export interface CurrentContextCandidate extends ContextCandidate {
  results: ProbeResult[]
  cells?: never
  states: Readonly<Record<string, ProbeStatus>>
}

/** The candidate for one context key, from the projection's own selected version. */
export function candidateFromSelected(
  key: string,
  selected: SelectedContextSummary,
  states: Readonly<Record<string, ProbeStatus>>,
  projection: SelectedProjection,
): CurrentContextCandidate | undefined
export function candidateFromSelected(
  key: string,
  selected: SelectedVersion,
  states: Readonly<Record<string, CellState>>,
): HistoricalContextCandidate
export function candidateFromSelected(
  key: string,
  selected: CurrentSelectedVersion,
  states: Readonly<Record<string, ProbeStatus>>,
): CurrentContextCandidate
export function candidateFromSelected(
  key: string,
  selected: SelectedVersion | CurrentSelectedVersion,
  states: Readonly<Record<string, CellState | ProbeStatus>>,
): ContextCandidate
export function candidateFromSelected(
  key: string,
  selected: SelectedVersion | CurrentSelectedVersion | SelectedContextSummary,
  states: Readonly<Record<string, CellState | ProbeStatus>>,
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

/** How the one run for a context was chosen, printed with the row so the choice is auditable. */
export type RunSelection = "only current" | "reviewed default-context row" | "default profile"

export type PickedContextRun<T extends ContextCandidate = ContextCandidate> =
  | { run: T; selection: RunSelection }
  | { ambiguous: string[] }
  /** A reviewed row this group cannot stand on any more; `stale` is the one sentence every caller prints. */
  | { stale: string }

/**
 * `os` (2) selects the group; `osVersion` (3) is the ONE field deliberately ignored here, so two
 * generations of the same context are equal on every other field and no version is ever parsed.
 */
function sameContextOtherGeneration(left: ProjectedContextKeyParts, right: ProjectedContextKeyParts): boolean {
  return (
    left[0] === right[0] &&
    left[1] === right[1] &&
    left[2] === right[2] &&
    left[4] === right[4] &&
    left[5] === right[5] &&
    left[6] === right[6] &&
    left[7] === right[7]
  )
}

/** The current keys the reviewed context was superseded by: the NEWEST generation, ties named sorted. */
function successors(
  candidates: readonly ContextCandidate[],
  chosen: ContextCandidate,
  context: ProjectedContextKeyParts,
): ContextCandidate[] {
  // Only original contributing evidence dates compare host generations. Attempts never refresh it.
  const evidenceDate = (candidate: ContextCandidate): number =>
    Math.max(...candidate.sources.map((source) => Date.parse(source.measuredAt)))
  const newer = candidates.filter((candidate) => {
    if (candidate.key === chosen.key) return false
    const other = parseProjectedContextKey(candidate.key)
    return (
      other !== undefined &&
      sameContextOtherGeneration(other, context) &&
      evidenceDate(candidate) > evidenceDate(chosen)
    )
  })
  if (newer.length === 0) return []
  const newest = Math.max(...newer.map(evidenceDate))
  return newer
    .filter((candidate) => evidenceDate(candidate) === newest)
    .sort((left, right) => left.key.localeCompare(right.key))
}

/** The one refusal sentence every caller prints: the stale key, its cause, the current keys, the cure. */
function refusedReview(reviewed: string, cause: string, candidates: readonly ContextCandidate[]): { stale: string } {
  return {
    stale:
      `reviewed default-context key ${reviewed} is stale: ${cause}; ` +
      `current contexts: ${candidates.map((candidate) => candidate.key).join(", ")}; ` +
      "re-record that row in content/default-contexts.json",
  }
}

/** A candidate key our own builder wrote and cannot be read back: a defect to name, never to skip past. */
function unreadableCandidate(candidate: ContextCandidate): { stale: string } {
  return {
    stale: `current context key ${candidate.key} is unreadable; projectedContextKey wrote it, so no reviewed row can be applied until that key is fixed`,
  }
}

/** A context remains current when any of its original evidence sources is current. */
export function hasCurrentSource(
  sources: readonly Pick<ContextCandidate["sources"][number], "suiteRelation">[],
): boolean {
  return sources.some((source) => !isStaleRelation(source.suiteRelation))
}

/**
 * Choose the one run the site selects for a (terminal id, os) context. The site's own selection keys by
 * terminal id, not by id+os, so a context can carry several current entries: kitty/linux has the
 * default and two clipboard-override profiles, and xterm/linux carries one entry per frozen-runner
 * store path. The site resolves such a tie by the reviewed `default-contexts.json` row
 * (`compatibilitySubjects`), and so does this reader.
 *
 * The bar keys rows by terminal id + os while the review is keyed by terminal id alone, so a review
 * is a tie-break ONLY for the group whose context it names — `app:kitty` names the macOS context, and
 * a review naming ANOTHER os's context falls back exactly as it always has. A review naming THIS
 * group's os must be current: a key no candidate carries, a bare `<kind>:<id>` whose group now has
 * several contexts, a key that cannot be read, and a context superseded by the same context on a
 * newer host generation (a newer measurement with only the osVersion changed) are all REFUSED with
 * the stale key, its successors, every current key and the cure — re-record the row — never silently
 * replaced by a fallback (30112). Among current candidates the review still names any it likes; this
 * rule is the tie-break of last resort, not a filter on the review.
 *
 * The fallbacks consider only CURRENT-suite candidates whenever any are present: the bar reports a
 * run's decisive share on the current suite, so an older-suite entry can never be the measured row,
 * and letting it tie up the choice reports a false ambiguity (kitty/linux: one stale permissions-free
 * entry beside the current one and a current clipboard override, which read "ambiguous" until this
 * rule). With no current-suite candidate the fallbacks are unchanged.
 */
export function pickContextRun<T extends ContextCandidate>(
  candidates: readonly T[],
  reviewed?: { contextKey: string },
): PickedContextRun<T> | undefined {
  candidates = candidates.filter((candidate) => candidate.sources.length > 0)
  if (candidates.length === 0) return undefined
  if (reviewed !== undefined) {
    const reviewedKey = reviewed.contextKey
    const reviewedShape = recognizeProjectedContextKey(reviewedKey)
    const context = reviewedShape.shape === "full" ? reviewedShape.parts : undefined
    const chosen = candidates.find((candidate) => candidate.key === reviewedKey)
    // Every candidate key came from our own builder, which writes a full key or the bare stem of a
    // ONE-context group. One that is neither is a defect to name; dropping it would silently pick a
    // successor from an incomplete set.
    for (const candidate of candidates) {
      if (candidate.key === reviewedKey) continue
      if (recognizeProjectedContextKey(candidate.key).shape === "unreadable") return unreadableCandidate(candidate)
    }
    if (chosen !== undefined) {
      if (context !== undefined) {
        const superseding = successors(candidates, chosen, context)
        if (superseding.length > 0) {
          const names = superseding.map((candidate) => candidate.key).join(", ")
          return refusedReview(reviewedKey, `superseded by ${names}`, candidates)
        }
      }
      return { run: chosen, selection: "reviewed default-context row" }
    }
    // A bare `<kind>:<id>` is the key a ONE-context group carries; with several it names nothing, and a
    // key that cannot be read at all is a row to re-record, never a silent fallback.
    if (context === undefined) {
      const cause =
        reviewedShape.shape === "bare-stem" ? "no current candidate names it" : "the reviewed key is unreadable"
      return refusedReview(reviewedKey, cause, candidates)
    }
    // Another os's context is not this group's tie-break: the fallbacks below apply exactly as before.
    if (candidates.some((candidate) => candidate.os === context[2])) {
      return refusedReview(reviewedKey, "no current candidate names it", candidates)
    }
  }
  const current = candidates.filter((candidate) => hasCurrentSource(candidate.sources))
  const considered = current.length > 0 ? current : candidates
  const [only] = considered
  if (considered.length === 1 && only) return { run: only, selection: "only current" }
  const defaults = considered.filter((candidate) => candidate.permissions === null)
  const [onlyDefault] = defaults
  if (defaults.length === 1 && onlyDefault) return { run: onlyDefault, selection: "default profile" }
  return { ambiguous: considered.map((candidate) => candidate.key) }
}
