/**
 * The ONE status rule an evidence cell applies to a stored result.
 *
 * #37341 Q1 (@cpo/term f16a5a52): a result we haven't decided is left blank. The three undecided statuses and a
 * missing result wear one status: an em dash with no badge, whose hover reads "No result yet". An environment
 * position is no exception. Any decided status shows as stored.
 *
 * Extracted from ResultEvidenceCell.vue so the rule has a reader a test can call; the SFC is outside
 * the TS-only unit population (same arrangement as `context-label.ts`).
 */
import type { FeatureResultStatus } from "../../../packages/probe-defs/src/types.ts"
import { DIFFERS_BY_CONTEXT } from "../../data/app-cells.ts"
import { categoryMark } from "../../data/result-categories.ts"

export type EvidenceTone = "yes" | "no" | "ungraded" | "unknown" | "error" | "differs"

export interface EvidenceStatus {
  readonly text: string
  readonly icon: string
  readonly tone: EvidenceTone
  /** The hover words of a cell that has no badge text. */
  readonly title?: string
}

/** What an undecided or missing result wears: a blank cell, never an invented verdict and never an internal label. */
export const NO_RESULT_STATUS: EvidenceStatus = { text: "", icon: "—", tone: "unknown", title: "No result yet" }

const STORED_STATUS: Readonly<Record<FeatureResultStatus, EvidenceStatus>> = {
  supported: { text: "Supported", icon: "✓", tone: "yes" },
  unsupported: { text: "Unsupported", icon: "✗", tone: "no" },
  // #37761: the same mark the bar's popover and every result list use (result-categories.ts is its one home).
  untestable: { text: "Untestable", icon: categoryMark("untestable"), tone: "ungraded" },
  "probe-todo": NO_RESULT_STATUS,
  "probe-invalid": NO_RESULT_STATUS,
  "probe-conflict": NO_RESULT_STATUS,
}

/**
 * What a cell wears when the contexts that measured the same release disagree (@cto d321729a rule 3):
 * decided, in its own bucket, never Supported or Unsupported. The cell itself names each context.
 */
export const DIFFERS_BY_CONTEXT_STATUS: EvidenceStatus = { text: "Differs by context", icon: "≠", tone: "differs" }

/** What a cell derived from a refused parent wears (#33019): never the bare words of a direct measurement. */
export const DERIVED_UNSUPPORTED_STATUS: EvidenceStatus = { text: "Unsupported, derived", icon: "✗", tone: "no" }

export function evidenceStatus(
  _featureId: string,
  status: FeatureResultStatus | typeof DIFFERS_BY_CONTEXT | undefined,
  derived = false,
): EvidenceStatus {
  if (status === undefined) return NO_RESULT_STATUS
  if (status === DIFFERS_BY_CONTEXT) return DIFFERS_BY_CONTEXT_STATUS
  if (status === "unsupported" && derived) return DERIVED_UNSUPPORTED_STATUS
  const shown = STORED_STATUS[status]
  if (shown === undefined) throw new Error(`evidenceStatus: unknown stored status ${JSON.stringify(status)}`)
  return shown
}

/** The words a table cell prints for a status: the badge text, or the hover words of a blank. */
export function evidenceStatusWords(status: EvidenceStatus): string {
  return status.text || (status.title ?? "")
}
