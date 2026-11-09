/**
 * @failure `serve.ts` (`installCapture`) and probe-test capture fakes drift on when a capture
 *   requires calibrated pixel geometry or which `pixelGeometry` fields must match calibration,
 *   letting probes pass fake capture checks and fail live collection with `UndeclaredTerminalGeometry`.
 * @level l1
 * @consumer `terminfo.dev` `installCapture` and `@terminfo/probe-defs` capture-observation fakes.
 * @testonly none
 */
import { expect, test } from "vitest"
import { assertCalibratedCaptureGeometry, type CapturePixelGeometry } from "./index.ts"

const CALIBRATED: CapturePixelGeometry = {
  cellWidth: 9,
  cellHeight: 22,
  textWidth: 720,
  textHeight: 528,
}

test("assertCalibratedCaptureGeometry bypasses uncropped raw captures even before calibration", () => {
  expect(assertCalibratedCaptureGeometry(undefined, {})).toBeNull()
  expect(
    assertCalibratedCaptureGeometry(
      { pixelGeometry: CALIBRATED, basis: "fixture" },
      { cells: undefined, pixelGeometry: undefined },
      "Darwin",
    ),
  ).toBeNull()
})

test("assertCalibratedCaptureGeometry refuses cropped or geometry-carrying captures without calibration", () => {
  for (const [platform, request] of [
    ["Linux", { cells: { top: 1, left: 1, bottom: 2, right: 4 } }],
    ["Darwin", { pixelGeometry: CALIBRATED }],
  ] as const) {
    expect(() => assertCalibratedCaptureGeometry(undefined, request, platform)).toThrowError(
      expect.objectContaining({
        name: "UndeclaredTerminalGeometry",
        message: `${platform} capture calibration refused: no witnessed text-area origin is available`,
      }),
    )
  }
})

test("assertCalibratedCaptureGeometry returns the calibrated carrier for both serve.ts and TermProbeSource shapes", () => {
  const origin = { origin: { x: 13, y: 57 }, pixelGeometry: CALIBRATED, basis: "fixture complete raster" }
  const probeGeometry = { geometry: CALIBRATED, source: "measured by complete raster calibration" as const }

  expect(
    assertCalibratedCaptureGeometry(origin, {
      cells: { top: 1, left: 1, bottom: 4, right: 10 },
      pixelGeometry: { ...CALIBRATED },
    }),
  ).toBe(origin)
  expect(
    assertCalibratedCaptureGeometry(probeGeometry, {
      cells: { top: 2, left: 3, bottom: 5, right: 12 },
    }),
  ).toBe(probeGeometry)
})

test.each([
  ["cellWidth", "Linux", { ...CALIBRATED, cellWidth: CALIBRATED.cellWidth + 1 }],
  ["cellHeight", "Darwin", { ...CALIBRATED, cellHeight: CALIBRATED.cellHeight - 1 }],
  ["textWidth", "Linux", { ...CALIBRATED, textWidth: CALIBRATED.textWidth - CALIBRATED.cellWidth }],
  ["textHeight", "Darwin", { ...CALIBRATED, textHeight: CALIBRATED.textHeight - CALIBRATED.cellHeight }],
] as const)(
  "assertCalibratedCaptureGeometry refuses %s changes after calibration on %s",
  (_field, platform, changed) => {
    expect(() =>
      assertCalibratedCaptureGeometry(
        { geometry: CALIBRATED },
        { cells: { top: 1, left: 1, bottom: 2, right: 4 }, pixelGeometry: changed },
        platform,
      ),
    ).toThrowError(
      expect.objectContaining({
        name: "UndeclaredTerminalGeometry",
        message: `${platform} capture calibration refused: terminal pixel geometry changed after origin calibration`,
      }),
    )
  },
)
