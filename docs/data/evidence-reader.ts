import type { CapabilityStatus } from "../../packages/probe-defs/src/types.ts"
import type { CellEvidence, HistoricalCellEvidence } from "./public-results.ts"

export type LoadedCellEvidence =
  | (CellEvidence & { version: 4; runId: string; runSha256: string })
  | (HistoricalCellEvidence & { version: 2; runId: string; runSha256: string })

export interface CellEvidenceExpectation {
  schemaVersion: number
  runId: string
  runSha256: string
  featureId: string
  reviewId: string
  status?: CapabilityStatus
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

/**
 * Validate a parsed per-run evidence document (`version: 2` for historical runs, `version: 4` for
 * schema-3 runs) and extract the cell record for `expectation.featureId`.
 */
export function readCellEvidence(parsed: unknown, expectation: CellEvidenceExpectation): LoadedCellEvidence {
  const expectedDocumentVersion = expectation.schemaVersion === 3 ? 4 : 2
  if (
    !isRecord(parsed) ||
    parsed.version !== expectedDocumentVersion ||
    parsed.runId !== expectation.runId ||
    parsed.runSha256 !== expectation.runSha256 ||
    !isRecord(parsed.cells)
  ) {
    throw new Error("Evidence document identity or structure does not match this result")
  }
  const cellEntry = parsed.cells[expectation.featureId]
  if (cellEntry === undefined) {
    throw new Error("no evidence stored for this cell")
  }
  const payload = isRecord(cellEntry)
    ? expectation.schemaVersion === 3
      ? cellEntry.result
      : cellEntry.observation
    : undefined
  if (
    !isRecord(cellEntry) ||
    cellEntry.featureId !== expectation.featureId ||
    !isRecord(payload) ||
    payload.featureId !== expectation.featureId ||
    (expectation.status !== undefined && payload.status !== expectation.status) ||
    !isRecord(cellEntry.record) ||
    !Array.isArray(cellEntry.record.assertions) ||
    !isRecord(cellEntry.review) ||
    cellEntry.review.id !== expectation.reviewId
  ) {
    throw new Error("Evidence document identity or structure does not match this result")
  }
  return {
    version: expectedDocumentVersion,
    runId: expectation.runId,
    runSha256: expectation.runSha256,
    ...(cellEntry as unknown as CellEvidence | HistoricalCellEvidence),
  } as LoadedCellEvidence
}
