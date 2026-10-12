/**
 * THE one run-selection rule (28792 item 1). Given the candidate runs the site currently selects for
 * one context, it chooses the run a bar row — or a compatibility key — stands on, or refuses.
 *
 * The site and this reader must not hold two copies of this: `compatibilityTargets` resolves a
 * multi-context tie with the reviewed `default-contexts.json` row, and `decisive-share` printed the
 * choice of a private fallback chain beside it. One rule, two callers.
 */
import { isStaleRelation, type SuiteRelation } from "./release-scope.ts"
import type { SelectedVersion } from "./selected-results.ts"

/**
 * Minimal cell view `barOverMeasured` consumes; `SelectedCell` satisfies it structurally. `reason`
 * and `note` are carried so a consumer can print the RUN'S OWN words for an inconclusive row (the
 * named cause, such as a terminal that never answers `CSI 16 t`) instead of paraphrasing one of its
 * own.
 */
export type ShareCells = Record<string, { outcome: string; conclusive?: boolean; reason?: string; note?: string }>

/** One candidate context the site currently selects, reduced to what the readers consume. */
export interface ContextCandidate {
  key: string
  kind: string
  terminalId: string
  os: string
  permissions: string | null
  runId: string
  version: string
  measuredAt: string
  suiteId: string
  suiteFreshness: string
  suiteRelation: SuiteRelation
  cells: ShareCells
}

/** The candidate for one context key, from the projection's own selected version. */
export function candidateFromSelected(key: string, selected: SelectedVersion): ContextCandidate {
  return {
    key,
    kind: selected.target.kind,
    terminalId: selected.target.id,
    os: selected.target.os ?? "",
    permissions: selected.target.permissions ?? null,
    runId: selected.runId,
    version: selected.target.version ?? "",
    measuredAt: selected.measuredAt,
    suiteId: selected.suiteId,
    suiteFreshness: selected.suiteFreshness,
    suiteRelation: selected.suiteRelation,
    cells: selected.cells,
  }
}

/** How the one run for a context was chosen, printed with the row so the choice is auditable. */
export type RunSelection = "only current" | "reviewed default-context row" | "default profile"

export type PickedContextRun = { run: ContextCandidate; selection: RunSelection } | { ambiguous: string[] }

/**
 * Choose the one run the site selects for a (terminal id, os) context. The site's own selection keys by
 * terminal id, not by id+os, so a context can carry several current entries: kitty/linux has the
 * default and two clipboard-override profiles, and xterm/linux carries one entry per frozen-runner
 * store path. The site resolves such a tie by the reviewed `default-contexts.json` row
 * (`compatibilityTargets`), and so does this reader.
 *
 * The bar keys rows by terminal id + os while the review is keyed by terminal id alone, so a review
 * is a tie-break ONLY for the group whose context it names — `app:kitty` names the macOS context, and
 * kitty/linux must still resolve on its own. A review that names no candidate of this group is
 * therefore not this group's tie-break and the fallbacks below apply; the single permissions-free
 * entry is the row, and anything still ambiguous is reported with its contexts, never guessed.
 *
 * The fallbacks consider only CURRENT-suite candidates whenever any are present: the bar reports a
 * run's decisive share on the current suite, so an older-suite entry can never be the measured row,
 * and letting it tie up the choice reports a false ambiguity (kitty/linux: one stale permissions-free
 * entry beside the current one and a current clipboard override, which read "ambiguous" until this
 * rule). With no current-suite candidate the fallbacks are unchanged, and a review still names any
 * candidate it likes — this rule is the tie-break of last resort, not a filter on the review.
 */
export function pickContextRun(
  candidates: readonly ContextCandidate[],
  reviewed?: { contextKey: string },
): PickedContextRun | undefined {
  if (candidates.length === 0) return undefined
  if (reviewed !== undefined) {
    const chosen = candidates.find((candidate) => candidate.key === reviewed.contextKey)
    if (chosen) return { run: chosen, selection: "reviewed default-context row" }
  }
  const current = candidates.filter((candidate) => !isStaleRelation(candidate.suiteRelation))
  const considered = current.length > 0 ? current : candidates
  const [only] = considered
  if (considered.length === 1 && only) return { run: only, selection: "only current" }
  const defaults = considered.filter((candidate) => candidate.permissions === null)
  const [onlyDefault] = defaults
  if (defaults.length === 1 && onlyDefault) return { run: onlyDefault, selection: "default profile" }
  return { ambiguous: considered.map((candidate) => candidate.key) }
}
