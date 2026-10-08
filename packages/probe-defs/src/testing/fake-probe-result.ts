/**
 * A probe result for tests whose subject is not the graded outcome: an inconclusive, insufficient-evidence
 * observation, so no caller mistakes it for a measurement.
 *
 * @fakes @terminfo/probe-defs
 */
import type { ObservationEvidence, ProbeResult } from "../types.ts"

export function fakeProbeResult(evidence: ObservationEvidence = "parser-state"): ProbeResult {
  return { pass: false, observation: { outcome: "inconclusive", reason: "insufficient-evidence", evidence } }
}
