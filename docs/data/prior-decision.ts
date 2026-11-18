/**
 * 34691: the words a row shows for an older decision that a newer suite's harness refusal replaced. Client-safe: the
 * evidence cell imports it, so it imports types only.
 */
import type { FeatureResultStatus } from "../../packages/probe-defs/src/types.ts"
import type { PublicPriorDecision, PublicRefusalSummary } from "./public-results.ts"

const PRIOR_STATUS_WORDS: Partial<Record<FeatureResultStatus, string>> = {
  supported: "Supported",
  unsupported: "Unsupported",
  untestable: "Untestable",
}

/**
 * The one line under a row's current refusal: labelled "Not current", dated and attributed to its suite. A withdrawn
 * grade says so first, so it never reads as a valid decision.
 */
export function priorDecisionSentence(prior: PublicPriorDecision): string {
  const grade = PRIOR_STATUS_WORDS[prior.status] ?? prior.status
  const when = prior.measuredAt.slice(0, 10)
  const reason = prior.reason ? ` (${prior.reason})` : ""
  const read = `suite ${prior.suiteId} read ${grade} on ${when} for version ${prior.version}${reason}`
  return prior.reopened
    ? `Not current, and that grade was withdrawn on ${prior.reopened.reopenedOn} (${prior.reopened.reason}): ${read}.`
    : `Not current: ${read}. The newer suite has not measured it yet.`
}

/**
 * The page summary for one suite's refused current cells: the suite, the open count N and its reasons, and apart from
 * N the subset M whose rows show an older decision as history.
 */
export function refusalSummarySentence(summary: PublicRefusalSummary): string {
  const cells = (count: number) => `${count} ${count === 1 ? "cell" : "cells"}`
  const reasons = summary.reasons.map((row) => `${row.reason}: ${row.cells}`).join("; ")
  const prior =
    summary.withPriorDecision === 0
      ? ""
      : ` ${summary.withPriorDecision} of them had an earlier decision under another suite, shown on its row as not current.`
  return `Suite ${summary.suiteId}: ${cells(summary.open)} open because the harness refused the attempt (${reasons}).${prior}`
}
