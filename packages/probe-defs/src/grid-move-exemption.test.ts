/**
 * @failure A row whose frames were cropped from two screen positions after a whole-row grid move
 *   (Warp repaints its text area 35 rows lower after a probe sends RIS) stays an unnamed
 *   probe-invalid, and seven sgr rows never get decided (#33982); or the exemption widens to accept
 *   a resize, a sideways shift, a half-row shift, a frame cropped outside the pixels it captured, or
 *   a frame whose own witness pair proves no pitch — any of which would compare cells that were
 *   never the same cells.
 * @level l1
 * @consumer the same-crop comparison every pixel probe row runs before it grades a cell
 * @testonly none
 */
import { describe, expect, it } from "vitest"
import { cropPositionRefusal, gridMoveExemption, type ComparedCrop } from "./region-readback.ts"
import type { PixelCellCrop } from "./types.ts"

/**
 * 33982: Warp repaints its whole text area 35 rows lower when a probe sends RIS, so every frame of
 * that row crops the SAME cells from two positions. The exemption accepts exactly that move and
 * nothing else; these are the cases @cto pinned (9af65976), one test each.
 *
 * The fixture derives its origin from witness cell a. The pair (a at row 1 col 2, b at row 2 col 1)
 * must sit one cell pitch apart on both axes in every frame that is exempt — the independent
 * measurement the origin alone cannot supply, because the origin came from a's box.
 */
const cell = { width: 16, height: 16 }
const image = { width: 1200, height: 800 }
const firstOrigin = { x: 49, y: 46 }
const movedRows = 35
const movedOrigin = { x: firstOrigin.x, y: firstOrigin.y + movedRows * cell.height }

function cropAt(
  origin: { x: number; y: number },
  overrides: Partial<PixelCellCrop> = {},
  boxOverrides: { a?: { x: number; y: number }; b?: { x: number; y: number } } = {},
): PixelCellCrop {
  return {
    origin,
    basis: "sentinel pair located by frame difference",
    basisDetail: "sentinel re-located by frame difference at cells 1,2 and 2,1 (33000, 33981)",
    cell,
    grid: { columns: 80, rows: 40 },
    image,
    witness: {
      a: { cell: { row: 1, col: 2 }, box: boxOverrides.a ?? { x: origin.x + 16, y: origin.y } },
      b: { cell: { row: 2, col: 1 }, box: boxOverrides.b ?? { x: origin.x, y: origin.y + cell.height } },
    },
    ...overrides,
  }
}

/** The rectangle the capture maps from that origin for the cells this read names. */
const rectangleFor = (origin: { x: number; y: number }) => ({
  x: origin.x,
  y: origin.y + 2 * cell.height,
  width: 3 * cell.width,
  height: cell.height,
})

const frame = (
  role: string,
  origin: { x: number; y: number },
  crop: Partial<PixelCellCrop> = {},
  boxOverrides: { a?: { x: number; y: number }; b?: { x: number; y: number } } = {},
): ComparedCrop => ({
  role,
  rectangle: rectangleFor(origin),
  crop: cropAt(origin, crop, boxOverrides),
})

const refusal = (compared: ComparedCrop[]) =>
  cropPositionRefusal({ id: "sgr.bg.default", compared, response: "measured frames", frames: [] })

describe("33982 whole-row grid move", () => {
  it("accepts a whole-row move whose own witness pair proves the pitch", () => {
    const compared = [frame("seed", firstOrigin), frame("expected", movedOrigin)]
    expect(gridMoveExemption(compared)).toEqual([{ rows: movedRows, at: "expected" }])
    expect(refusal(compared)).toBeNull()
  })

  it("refuses the same move when the later frame's witness pair does not sit one pitch apart", () => {
    // The boxes are half a cell apart on y: this frame's pair proves no pitch, so its derived
    // origin is one measurement with nothing independent behind it.
    const compared = [
      frame("seed", firstOrigin),
      frame("expected", movedOrigin, {}, { b: { x: movedOrigin.x, y: movedOrigin.y + cell.height / 2 } }),
    ]
    expect(gridMoveExemption(compared)).toEqual([])
    expect(refusal(compared)?.tests?.[0]?.reason).toMatch(/were cropped from different positions/)
  })

  it("refuses a move that also shifts one cell sideways", () => {
    const shifted = { x: movedOrigin.x + cell.width, y: movedOrigin.y }
    const compared = [frame("seed", firstOrigin), frame("expected", shifted)]
    expect(gridMoveExemption(compared)).toEqual([])
    expect(refusal(compared)).not.toBeNull()
  })

  it("refuses a move of half a row", () => {
    const half = { x: movedOrigin.x, y: movedOrigin.y + cell.height / 2 }
    const compared = [frame("seed", firstOrigin), frame("expected", half)]
    expect(gridMoveExemption(compared)).toEqual([])
    expect(refusal(compared)).not.toBeNull()
  })

  it("refuses a whole-row move that comes with a changed column count", () => {
    const compared = [frame("seed", firstOrigin), frame("expected", movedOrigin, { grid: { columns: 81, rows: 40 } })]
    expect(gridMoveExemption(compared)).toEqual([])
    expect(refusal(compared)).not.toBeNull()
  })

  it("refuses a whole-row move that comes with a changed row count or cell pitch", () => {
    for (const crop of [
      { grid: { columns: 80, rows: 41 } },
      { cell: { width: cell.width, height: cell.height + 1 } },
    ] satisfies Array<Partial<PixelCellCrop>>) {
      const compared = [frame("seed", firstOrigin), frame("expected", movedOrigin, crop)]
      expect(gridMoveExemption(compared)).toEqual([])
      expect(refusal(compared)).not.toBeNull()
    }
  })

  it("refuses a whole-row move measured a different way or on a different surface", () => {
    for (const crop of [
      { basis: "calibration witnessed raster" },
      { surface: { x: 0, y: 0, width: 800, height: 600 } },
    ] satisfies Array<Partial<PixelCellCrop>>) {
      const compared = [frame("seed", firstOrigin), frame("expected", movedOrigin, crop)]
      expect(gridMoveExemption(compared)).toEqual([])
      expect(refusal(compared)).not.toBeNull()
    }
  })

  it("refuses a move whose rectangle would fall outside the pixels that frame captured", () => {
    const compared = [
      frame("seed", firstOrigin),
      frame("expected", movedOrigin, { image: { width: 1200, height: 600 } }),
    ]
    expect(gridMoveExemption(compared)).toEqual([])
    expect(refusal(compared)).not.toBeNull()
  })

  it("refuses as today when any compared frame carries no measurement at all", () => {
    const compared: ComparedCrop[] = [
      frame("seed", firstOrigin),
      { role: "expected", rectangle: rectangleFor(movedOrigin) },
    ]
    expect(gridMoveExemption(compared)).toEqual([])
    expect(refusal(compared)?.tests?.[0]?.reason).toMatch(/were cropped from different positions/)
  })

  it("judges every later frame against the first compared frame, and names each move", () => {
    const third = { x: firstOrigin.x, y: firstOrigin.y + 32 * cell.height }
    const compared = [frame("seed", firstOrigin), frame("expected", movedOrigin), frame("ignored", third)]
    expect(gridMoveExemption(compared)).toEqual([
      { rows: movedRows, at: "expected" },
      { rows: 32, at: "ignored" },
    ])
    expect(refusal(compared)).toBeNull()
  })
})

describe("33982 witness pair, both sides", () => {
  it("refuses when the FIRST compared frame's own pair proves no pitch", () => {
    // The seed's origin comes from box a; if its pair does not sit one pitch apart, the seed itself
    // is unanchored and no later frame can be judged against it.
    const compared = [
      frame("seed", firstOrigin, {}, { b: { x: firstOrigin.x, y: firstOrigin.y + 4 } }),
      frame("expected", movedOrigin),
    ]
    expect(gridMoveExemption(compared)).toEqual([])
    expect(refusal(compared)).not.toBeNull()
  })

  it("refuses a pair recorded the other way round (b above a where its cells say below)", () => {
    const compared = [
      frame("seed", firstOrigin),
      frame(
        "expected",
        movedOrigin,
        {},
        { a: { x: movedOrigin.x + 16, y: movedOrigin.y + cell.height }, b: { x: movedOrigin.x, y: movedOrigin.y } },
      ),
    ]
    expect(gridMoveExemption(compared)).toEqual([])
    expect(refusal(compared)).not.toBeNull()
  })

  it("accepts a pair one blended edge line short, as the read's own derivation does", () => {
    const compared = [
      frame("seed", firstOrigin),
      frame("expected", movedOrigin, {}, { b: { x: movedOrigin.x, y: movedOrigin.y + cell.height - 2 } }),
    ]
    expect(gridMoveExemption(compared)).toEqual([{ rows: movedRows, at: "expected" }])
    expect(refusal(compared)).toBeNull()
  })
})

describe("33982 origin follows its own box", () => {
  it("refuses an origin that moved while its own witness boxes did not", () => {
    // The origin is derived from box a; a frame claiming a 35-row move while its boxes sit unmoved
    // is two measurements disagreeing, not a moved grid (@dev/10 note b).
    const compared = [
      frame("seed", firstOrigin),
      frame("expected", movedOrigin, {}, {
        a: { x: firstOrigin.x + 16, y: firstOrigin.y },
        b: { x: firstOrigin.x, y: firstOrigin.y + cell.height },
      }),
    ]
    expect(gridMoveExemption(compared)).toEqual([])
    expect(refusal(compared)).not.toBeNull()
  })
})
