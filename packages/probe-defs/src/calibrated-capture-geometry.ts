/**
 * Enforces the calibrated pixel-geometry invariant shared by `packages/terminfo.dev/src/serve.ts`
 * (`installCapture`) and probe-test capture fakes:
 * - An uncropped request (`!request.cells && !request.pixelGeometry`) is a raw whole-window capture
 *   and returns `null` without requiring calibration.
 * - Any request carrying `cells` or `pixelGeometry` requires a witnessed calibrated source and
 *   refuses any `request.pixelGeometry` that differs from the calibrated full text area, returning
 *   the calibrated source once verified.
 */
import type { CapturePixelGeometry, CaptureRequest } from "./types.ts"

export type CalibratedGeometrySource =
  | { readonly geometry: CapturePixelGeometry; readonly pixelGeometry?: never }
  | { readonly pixelGeometry: CapturePixelGeometry; readonly geometry?: never }

export function assertCalibratedCaptureGeometry<T extends CalibratedGeometrySource>(
  calibrated: T | undefined,
  request: Pick<CaptureRequest, "cells" | "pixelGeometry">,
  platform: "Linux" | "Darwin" = "Linux",
): T | null {
  if (!request.cells && !request.pixelGeometry) return null
  if (!calibrated) {
    const error = new Error(`${platform} capture calibration refused: no witnessed text-area origin is available`)
    error.name = "UndeclaredTerminalGeometry"
    throw error
  }
  const source: CalibratedGeometrySource = calibrated
  const geometry = source.geometry !== undefined ? source.geometry : source.pixelGeometry
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
  return calibrated
}
