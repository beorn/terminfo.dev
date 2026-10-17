/**
 * @failure A checkpoint that names cells the text read does not cover is silently cropped, so the
 *   frame's cell digest is taken over fewer cells than the row asked about and a verdict is graded
 *   from a rectangle nobody requested.
 * @level l1
 * @consumer collectProbeRun's text-snapshot adapter, the one place a text frame is built.
 * @testonly none
 */
import { describe, expect, it } from "vitest"
import { textCellRegion } from "./serve.ts"

const rows = ["abcdef", "ghijkl", "mnopqr"]

describe("textCellRegion — the checkpoint's rectangle, or a refusal by name", () => {
  it("compares the whole visible rect when the checkpoint names no cells", () => {
    expect(textCellRegion(rows, 3, 6)).toEqual({
      cells: { top: 1, left: 1, bottom: 3, right: 6 },
      rows,
    })
  })

  it("copies exactly the cells the checkpoint names", () => {
    expect(textCellRegion(rows, 3, 6, { top: 2, left: 2, bottom: 3, right: 4 })).toEqual({
      cells: { top: 2, left: 2, bottom: 3, right: 4 },
      rows: ["hij", "nop"],
    })
  })

  it("refuses a checkpoint that reaches past the read's rows", () => {
    expect(() => textCellRegion(rows, 3, 6, { top: 1, left: 1, bottom: 4, right: 6 })).toThrow(
      /asks for rows 1-4 and columns 1-6 of a 3x6 text read/u,
    )
  })

  it("refuses a checkpoint that reaches past the read's columns", () => {
    expect(() => textCellRegion(rows, 3, 6, { top: 1, left: 5, bottom: 1, right: 7 })).toThrow(
      /columns 5-7 of a 3x6 text read/u,
    )
  })

  it("refuses a rectangle that starts outside the grid", () => {
    expect(() => textCellRegion(rows, 3, 6, { top: 0, left: 1, bottom: 1, right: 1 })).toThrow(
      /rows 0-1 and columns 1-1/u,
    )
  })
})
