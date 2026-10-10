/**
 * The ONE decidable-basis predicate. A cohort's ids are split by the required app schedule into the
 * ids the schedule HAS a probe for (decidable) and the ids it does NOT cover (unavailable). The
 * decisive-share reader and the probe-defs group harness both call this, so an id absent from the
 * required suite can never be counted as a failed capability by one reader and excluded by another:
 * an absent id is not decidable, and it must not penalize a context (the 28018 one-basis ruling,
 * @dev/3 2026-10-10, @cto PROCEED 2026-10-10T15:49Z).
 *
 * The schedule is the SOURCE of availability; a `namedUnavailable` annotation is a checked note
 * (reason + noObservable), never the predicate. Pure and total: no I/O and no manifest reading
 * inside, so the caller passes the schedule (the suite manifest's `probes.app`, or a group's own
 * exported probe ids in a contract test).
 */
export interface DecidableBasis {
  /** The cohort ids the schedule covers, in cohort order. */
  readonly decidableIds: readonly string[]
  /** The cohort ids the schedule does not cover, in cohort order. */
  readonly unavailableIds: readonly string[]
}

/**
 * Split `cohortIds` by `scheduledIds`. Both outputs keep cohort order, so a caller's own ordering
 * (catalog order, remainder order) is preserved and the split is deterministic. `cohortIds` is read
 * as given; `scheduledIds` is used only as a membership set, so its order and duplicates do not matter.
 */
export function splitDecidableBasis(cohortIds: readonly string[], scheduledIds: readonly string[]): DecidableBasis {
  const scheduled = new Set(scheduledIds)
  const decidableIds: string[] = []
  const unavailableIds: string[] = []
  for (const id of cohortIds) {
    if (scheduled.has(id)) decidableIds.push(id)
    else unavailableIds.push(id)
  }
  return { decidableIds, unavailableIds }
}
