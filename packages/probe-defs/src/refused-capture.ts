import type { TermProbeSource } from "./types.ts"

/**
 * 34675 (@cto go-r2-1341): a branch whose OWN required pixel reading is absent because this run refused its
 * capture calibration raises the existing named `FrameUnavailable` diagnostic, so the collector's catch and
 * `buildProbeResult` record the row as an unfinished harness reading (`capture-refused`) instead of an
 * ordinary open result that reopens an earlier decision.
 *
 * It returns, and the branch keeps its in-band result, whenever the refusal is not the cause:
 * - no refusal was recorded for this row (a run with no adapter at all stays as it is);
 * - the run is a text-cells run, where a pixel branch has no adapter whatever the calibration said.
 *
 * Call it only on the arm whose own reading is missing: never on an arm where an independent control failed
 * (a cursor that did not reach its position), where an alternate observable decided, or on a custody failure.
 * It attributes from typed run facts only; no reason text is read.
 */
export function raiseRefusedCapture(
  ctx: Pick<TermProbeSource, "captureGeometryRefusal" | "runCaptureKind">,
  reason: string,
): void {
  const refusal = ctx.captureGeometryRefusal
  // An empty refusal names nothing, as every existing `captureGeometryRefusal ?` note already treats it.
  if (!refusal || ctx.runCaptureKind === "text-cells") return
  throw refusedCaptureError(reason, refusal)
}

/** The named error itself, for a caller outside a callback (the SGR paint finalizer) that holds the refusal. */
export function refusedCaptureError(reason: string, refusal: string): Error {
  const error = new Error(`${reason}; this run refused capture geometry: ${refusal}`)
  error.name = "FrameUnavailable"
  return error
}
