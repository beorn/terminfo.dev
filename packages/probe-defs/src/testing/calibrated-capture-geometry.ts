/**
 * Enforces the same calibrated pixel-geometry invariant on probe-test capture fakes that
 * `packages/terminfo.dev/src/serve.ts` (`installCapture`) enforces on live Linux/Darwin runs:
 * a cropped or geometry-carrying capture requires a witnessed `captureGeometry.geometry` and
 * refuses any `pixelGeometry` that differs from the calibrated full text area.
 *
 * @fakes @terminfo/probe-defs
 */
import type { CaptureRequest, TermProbeSource } from "../types.ts"

export function assertCalibratedCaptureGeometry(
  context: Pick<TermProbeSource, "captureGeometry">,
  request: Pick<CaptureRequest, "cells" | "pixelGeometry">,
  platform: "Linux" | "Darwin" = "Linux",
): void {
  if (!request.cells && !request.pixelGeometry) return
  const geometry = context.captureGeometry?.geometry
  if (!geometry) {
    const error = new Error(`${platform} capture calibration refused: no witnessed text-area origin is available`)
    error.name = "UndeclaredTerminalGeometry"
    throw error
  }
  if (
    request.pixelGeometry &&
    (request.pixelGeometry.cellWidth !== geometry.cellWidth ||
      request.pixelGeometry.cellHeight !== geometry.cellHeight ||
      request.pixelGeometry.textWidth !== geometry.textWidth ||
      request.pixelGeometry.textHeight !== geometry.textHeight)
  ) {
    const error = new Error(
      `${platform} capture calibration refused: terminal pixel geometry changed after origin calibration`,
    )
    error.name = "UndeclaredTerminalGeometry"
    throw error
  }
}
