/**
 * @failure A sentinel box of exactly the cell's size is refused because one or two of its pixels did
 *   not carry the sentinel colour, so every read behind it never anchors: 29 of the 70 control rows
 *   on the hosted terminal-app arm and 2 Warp rows (run 43414740482) read probe-invalid (#34015). The
 *   opposite failure is as bad: a box that is too short, too large, or the wrong size accepted as one
 *   solid cell, which anchors a crop on pixels that are not the paint.
 * @level l1
 * @consumer the sentinel every pixel read anchors its crop on, on both capture arms
 * @testonly none
 */
import { describe, expect, it } from "vitest"
import { SENTINEL_BOX_SLACK_PX, sentinelBlockRefusal, sentinelBoxDeficit } from "./region-readback.ts"

const cell = { width: 8, height: 16 }
const area = cell.width * cell.height
const box = (pixels: number, size = cell) => ({ box: { width: size.width, height: size.height }, pixels })

describe("34015 sentinel box fill", () => {
  it("accepts a cell-sized box that is short by exactly the named slack", () => {
    expect(SENTINEL_BOX_SLACK_PX).toBe(2)
    expect(sentinelBlockRefusal(box(area - SENTINEL_BOX_SLACK_PX), cell)).toBeUndefined()
  })

  it("refuses a box one pixel shorter than the slack allows", () => {
    expect(sentinelBlockRefusal(box(area - SENTINEL_BOX_SLACK_PX - 1), cell)).toMatch(
      /against a 8x16 cell/,
    )
  })

  it("refuses a box carrying more pixels than its own area", () => {
    expect(sentinelBlockRefusal(box(area + 1), cell)).toMatch(/against a 8x16 cell/)
  })

  it("keeps the size tolerance: an edge-blended box one pixel small on each axis still fits", () => {
    expect(sentinelBlockRefusal(box(7 * 15, { width: 7, height: 15 }), cell)).toBeUndefined()
  })

  it("refuses a box more than the slack short on an axis, however full it is", () => {
    expect(sentinelBlockRefusal(box(8 * 13, { width: 8, height: 13 }), cell)).toMatch(/against a 8x16 cell/)
  })

  it("records the deficit of an accepted short box and nothing for a full one", () => {
    expect(sentinelBoxDeficit(box(area - 2))).toEqual({ pixels: area - 2, area, short: 2 })
    expect(sentinelBoxDeficit(box(area))).toBeUndefined()
  })
})
