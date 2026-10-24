/**
 * The ONE status rule an evidence cell applies to a stored result.
 *
 * D132 B (#30917): an environment position (`device.env-*`) is ungraded, and its stored TEST TODO is
 * the catalogue's way of saying no automatable probe exists — not work outstanding. Only in that one
 * case does the cell wear the manual-by-design words. Any other stored status is a recorded result and
 * shows as stored: a supported environment row reads Supported, never "NOT MEASURED" over something
 * that was measured (@cto 98cd142b D1, the same rule as packages/admin/report.tsx).
 *
 * Extracted from ResultEvidenceCell.vue so the rule has a reader a test can call; the SFC is outside
 * the TS-only unit population (same arrangement as `ungraded-explanation.ts`).
 */
import type { CapabilityStatus } from "../../../packages/probe-defs/src/types.ts"
import { isEnvironmentGroup } from "../../../packages/probe-defs/src/environment-groups.ts"

export type EvidenceTone = "yes" | "no" | "ungraded" | "unknown" | "error"

export interface EvidenceStatus {
  readonly text: string
  readonly icon: string
  readonly tone: EvidenceTone
}

/** What an ungraded environment position wears when its stored status is TEST TODO. */
export const MANUAL_BY_DESIGN_STATUS: EvidenceStatus = {
  text: "Manual by design (catalogue), NOT MEASURED",
  icon: "–",
  tone: "ungraded",
}

/** What a row with no stored result wears: a blank cell, never an invented verdict. */
export const MISSING_STATUS: EvidenceStatus = { text: "", icon: "–", tone: "unknown" }

const STORED_STATUS: Readonly<Record<CapabilityStatus, EvidenceStatus>> = {
  supported: { text: "Supported", icon: "✓", tone: "yes" },
  unsupported: { text: "Unsupported", icon: "✗", tone: "no" },
  untestable: { text: "Untestable", icon: "–", tone: "ungraded" },
  "test-todo": { text: "TEST TODO", icon: "–", tone: "unknown" },
  "test-failure": { text: "TEST FAILURE", icon: "!", tone: "error" },
}

export function evidenceStatus(featureId: string, status: CapabilityStatus | undefined): EvidenceStatus {
  if (status === undefined) return MISSING_STATUS
  if (status === "test-todo" && isEnvironmentGroup(featureId)) return MANUAL_BY_DESIGN_STATUS
  return STORED_STATUS[status]
}
