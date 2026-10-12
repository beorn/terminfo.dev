/**
 * @failure A screenshot is attributed to another app or maps point bounds into scaled pixels.
 * @level l0
 * @consumer createDarwinCapture window identity and scale admission
 * @testonly none
 */
import { expect, test } from "vitest"
import { selectDarwinWindow, requireDarwinScale } from "./darwin-capture.ts"

test("Darwin capture admits exactly one measured app window and scale one", () => {
  const own = { id: 7, ownerPid: 41, layer: 0, bounds: { x: 0, y: 0, width: 80, height: 63 } }
  expect(selectDarwinWindow([own, { ...own, id: 8, ownerPid: 99 }], 41)).toEqual(own)
  expect(() => requireDarwinScale(own, { width: 80, height: 63 })).not.toThrow()
  for (const rows of [[], [{ ...own, ownerPid: 99 }], [own, { ...own, id: 8 }]]) {
    expect(() => selectDarwinWindow(rows, 41)).toThrow(/owned.*window/i)
  }
  expect(() => requireDarwinScale(own, { width: 160, height: 126 })).toThrow(/scale 1/)
})
