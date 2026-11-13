/**
 * Negatives that publish only beside a positive (#33034, @cto edab7573).
 *
 * A pixel negative such as the Kitty frame-two-only animation reading is decided from the probe's own bytes. If no
 * subject measured under the same suite reads Supported with those bytes, the bytes themselves are unproven, so the
 * negative is held: the cell reads probe-invalid with a reason in words, and the stored result stays the witnessed
 * original.
 */
import type { LoadedRun } from "@terminfo/run-parser"
import type { SelectedContextCell } from "./selected-results.ts"

/** One negative branch whose publication needs a Supported reading of the same feature under the same suite. */
export interface HeldNegative {
  readonly featureId: string
  readonly criterionBranch: string
  /** What the Supported reading proves, in a reader's words. */
  readonly needs: string
}

export const HELD_NEGATIVES: readonly HeldNegative[] = [
  {
    featureId: "extensions.kitty-graphics.animation",
    criterionBranch: "kitty-frame-two-only",
    needs: "a terminal that plays these exact frames shows the probe's bytes can animate",
  },
]

/** The cell's marker: the negative it held and why, so the move is visible and reversible. */
export interface HeldMarker {
  readonly criterionBranch: string
  readonly suiteId: string
  readonly needs: string
}

/**
 * Suites in which at least one run reads each held feature Supported by screenshot: a Supported result whose run holds
 * a positive screenshot assertion for it. A Supported from a path that never painted the probe's frames proves nothing
 * about its bytes (@cto 413dbac4).
 */
export function supportedSuites(
  runs: readonly (Pick<LoadedRun, "results" | "suiteId"> & {
    assertions: readonly { featureId: string; kind: string; assertionType?: string }[]
  })[],
  held: readonly HeldNegative[],
): Map<string, Set<string>> {
  const suites = new Map<string, Set<string>>(held.map((row) => [row.featureId, new Set<string>()]))
  for (const run of runs) {
    // A run with no results array recorded no reading at all, so it witnesses nothing.
    for (const result of run.results ?? []) {
      if (result.status !== "supported" || result.assertionType !== "screenshot") continue
      const painted = run.assertions.some(
        (assertion) =>
          assertion.featureId === result.featureId &&
          assertion.kind === "positive" &&
          assertion.assertionType === "screenshot",
      )
      if (painted) suites.get(result.featureId)?.add(run.suiteId)
    }
  }
  return suites
}

/** Hold each unwitnessed negative in one context's cells; returns the held feature ids. */
export function applyHeld(
  cells: Record<string, SelectedContextCell>,
  held: readonly HeldNegative[],
  witnessed: ReadonlyMap<string, ReadonlySet<string>>,
): string[] {
  const ids: string[] = []
  for (const row of held) {
    const cell = cells[row.featureId]
    const featureResult = cell?.featureResult
    if (!cell || !featureResult || featureResult.status !== "unsupported") continue
    if (cell.result.criterionBranch !== row.criterionBranch || cell.reopened) continue
    if (witnessed.get(row.featureId)?.has(cell.run.suiteId)) continue
    cells[row.featureId] = {
      ...cell,
      featureResult: { ...featureResult, status: "probe-invalid", strength: null },
      held: { criterionBranch: row.criterionBranch, suiteId: cell.run.suiteId, needs: row.needs },
    }
    ids.push(row.featureId)
  }
  return ids
}

export function publicHeldReason(marker: HeldMarker): string {
  return `Unsupported not published: no subject measured under suite ${marker.suiteId} reads Supported with the same bytes, and ${marker.needs}.`
}
