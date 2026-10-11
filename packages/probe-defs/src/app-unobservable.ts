/**
 * The ONE declaration of rows that are DECIDABLE but not app-observable (#28018, @chief option B,
 * 2026-10-11 15:51 PDT). A row belongs here when the suite HAS a probe for it and the probe DOES
 * decide — but only on the parser surface, never in an app run. `reset.method` needs
 * `TermlessContext.reset()`, which `TermContext` has not got at all, and `scrollback.accumulate` /
 * `scrollback.total-lines` read the retained-history count, a buffer fact that is never a screen
 * cell. Such a row is not `no-semantic-observable` (which means the suite has no probe), so it needs
 * its own reason and its own list. Every reader that scores app runs takes its denominator from
 * `splitAppObservable`, so the row is named and counted rather than silently read as terminal
 * undecidability, and the share is never raised without those names beside it.
 */

export interface AppUnobservableRow {
  readonly id: string
  /** The surface that does decide the row. Every row here decides on the termless path. */
  readonly surface: "termless"
  /** Why no app run can decide it, in one clause. */
  readonly appLimit: string
}

export const APP_UNOBSERVABLE_ROWS: readonly AppUnobservableRow[] = [
  {
    id: "reset.method",
    surface: "termless",
    appLimit: "the app context has no reset method, and RIS is the separate reset.ris claim",
  },
  {
    id: "scrollback.accumulate",
    surface: "termless",
    appLimit: "retained-history existence is a buffer fact, never a screen cell",
  },
  {
    id: "scrollback.total-lines",
    surface: "termless",
    appLimit: "the retained-history length is a buffer fact, never a screen cell",
  },
]

/** The declared ids, in declaration order. */
export function appUnobservableIds(): readonly string[] {
  return APP_UNOBSERVABLE_ROWS.map((row) => row.id)
}

export interface AppObservableSplit {
  /** The rows an app run can decide, in the caller's order. */
  readonly scoredIds: readonly string[]
  /** The app-unobservable rows present in the caller's list, in the caller's order. */
  readonly libraryOnlyIds: readonly string[]
}

/**
 * Partition a declaration's ids by app observability. Both outputs keep the caller's order, so the
 * scored denominator reads in declaration order and the named list reads in the same order it was
 * declared. Pure and total: an id the caller does not list is simply not mentioned.
 */
export function splitAppObservable(ids: readonly string[]): AppObservableSplit {
  const libraryOnly = new Set(appUnobservableIds())
  const scoredIds: string[] = []
  const libraryOnlyIds: string[] = []
  for (const id of ids) (libraryOnly.has(id) ? libraryOnlyIds : scoredIds).push(id)
  return { scoredIds, libraryOnlyIds }
}
