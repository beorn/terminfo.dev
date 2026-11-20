/**
 * @failure Two frames of the same glyphs in different ink colours stop reading as one geometry, or the coverage array starts reaching a stored run record.
 * @level l2
 * @consumer The osc104 colour verdict, which grades an ink-colour difference only when each frame's own normalised coverage agrees within 2 of 255.
 * @testonly none
 * @reach fs-read <fixture-only: test-fixtures/osc104>
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { expect, test } from "vitest"
import { renderedAxes, renderingAxes } from "./capture-core.ts"

const fixtures = join(import.meta.dirname, "../../../test-fixtures/osc104")
const frame = (name: "seed" | "after" | "expected") => readFileSync(join(fixtures, `${name}.rgba`))

const worst = (left: Uint8Array, right: Uint8Array) => {
  let worstDelta = 0
  for (let index = 0; index < Math.min(left.length, right.length); index++) {
    worstDelta = Math.max(worstDelta, Math.abs((left[index] ?? 0) - (right[index] ?? 0)))
  }
  return worstDelta
}

// The three crops are ONE retained Warp run (43414740482) of extensions.osc104-reset-palette, second
// attempt, region 25,78 16x16. See test-fixtures/osc104/README.md for the artifact digests.
test("retained frames of the same glyphs in three ink colours agree on geometry and differ on ink", () => {
  const seed = renderingAxes(frame("seed"))
  const after = renderingAxes(frame("after"))
  const expected = renderingAxes(frame("expected"))
  expect([seed.background, after.background, expected.background]).toEqual(["#050505", "#050505", "#050505"])
  expect([seed.inkColour, after.inkColour, expected.inkColour]).toEqual(["#616161", "#123456", "#c1e3fe"])
  // after vs expected is the pair the branch decides; 2 is the rounding the reader accepts.
  expect(worst(after.coverage!, expected.coverage!)).toBeLessThanOrEqual(2)
  // The seed is a different colour SET (pre-reset palette), so its coverage is not the branch's pair.
  expect(seed.inkColour).not.toBe(after.inkColour)
  expect(after.inkCount).toBeGreaterThanOrEqual(16)
  expect(after.contrast).toBeGreaterThanOrEqual(40)
})

test("a one-pixel layout move is far outside the tolerance the reader accepts", () => {
  const original = frame("expected")
  const width = 16
  const shifted = Buffer.alloc(original.byteLength)
  const background = Buffer.from([5, 5, 5, 255])
  for (let offset = 0; offset < shifted.byteLength; offset += 4) shifted.set(background, offset)
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < width - 1; x++) {
      const from = (y * width + x) * 4
      shifted.set(original.subarray(from, from + 4), from + 4)
    }
  }
  const moved = renderingAxes(shifted)
  expect(moved.inkColour).toBe(renderingAxes(original).inkColour)
  expect(worst(moved.coverage!, renderingAxes(original).coverage!)).toBeGreaterThan(2)
})

test("a frame with no ink reports zero ink pixels and zero contrast, so the reader refuses it", () => {
  const flat = Buffer.alloc(16 * 16 * 4)
  for (let index = 0; index < flat.byteLength; index += 4) {
    flat[index] = 7
    flat[index + 3] = 255
  }
  const axes = renderingAxes(flat)
  expect(axes.background).toBe("#070000")
  expect(axes.inkColour).toBe("#070000")
  expect(axes.inkCount).toBe(0)
  expect(axes.contrast).toBe(0)
})

test("the coverage array never reaches a stored frame: the axes serialize without it", () => {
  const axes = renderedAxes(renderingAxes(frame("after")))
  const stored = JSON.stringify({ kind: "pixels", rendering: axes })
  expect(stored).toContain("#123456")
  expect(stored).not.toContain("coverage")
  expect(Object.keys(axes)).toEqual(["background", "inkColour", "inkCount", "contrast"])
  expect(axes.coverage!.length).toBe(256)
})
