/**
 * The baseline row readout both pages print (#30763, #33441, #37341 D2): the one readout every page prints,
 * "S supported · T of N tested" over the row's graded features. A count never reads as a measured fail the way a
 * "0%" did, so a row that decided nothing prints its zeros like any other row.
 */
import { currentCoverageSentence, currentSupportedShare, type ReadableCounts } from "./release-scope.ts"

/** Counts as a page holds them: every bucket the row's fold counted, undecided ones included. */
export interface RowCounts {
  readonly counts: ReadableCounts
}

export interface RowReadout {
  readonly text: string
  readonly title: string | undefined
}

/** The Home page baseline card and the /baseline/[id] coverage row: `S supported · T of N tested`. */
export function baselineReadout(stats: RowCounts): RowReadout {
  return { text: `${currentSupportedShare(stats)} · ${currentCoverageSentence(stats)}`, title: undefined }
}
