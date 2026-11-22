/**
 * #37341 D12: the split of a context's undecided cells that an admin line prints beside the one readout
 * (`currentSupportedShare` · `currentCoverageSentence`), read from the fold's own counts. Admin output only: the public
 * site never prints these words, so this lives here rather than in a module the site bundles.
 */
import { testedOfGraded, type ReadableCounts } from "../../docs/data/release-scope.ts"

export function undecidedSplit(counts: ReadableCounts): string {
  const { tested, graded } = testedOfGraded(counts)
  if (graded === tested) return "every graded feature decided"
  return `${counts["probe-todo"]} PROBE TODO · ${counts["probe-invalid"]} PROBE INVALID · ${counts["probe-conflict"] ?? 0} PROBE CONFLICT`
}
