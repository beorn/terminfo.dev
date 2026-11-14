/**
 * @failure A pixel read refuses to anchor because the cell its sentinel pair needs is further away
 *   than the picker's fixed list looked, so a gradeable row reads probe-invalid (#34040): on run
 *   43414740482 that was erase.screen.above and reset.decaln on both arms — a free cell sits at 4,2
 *   while every candidate in the list was off-grid or on a digested region row. The other half is a
 *   refusal that does not say why: a screen whose compared region leaves one clear row cannot hold a
 *   pair at all, and the reader has to be told that in words rather than infer it from a list.
 * @level l1
 * @consumer the sentinel pair every pixel read anchors on, on both capture arms
 * @testonly none
 */
import { describe, expect, it } from "vitest"
import { sentinelCellsInFrame, type CellRegion } from "./region-readback.ts"

const CELL = { width: 8, height: 16 }
const BACKGROUND = [12, 12, 12] as const
const INK = [220, 220, 220] as const

/**
 * The frame the chooser actually reads: every pixel background, and the compared region and the
 * probe's own output painted as ink. The recorded runs were frames of that shape — the chooser is
 * told which rectangles the read digests and treats everything else as screen it must not paint over.
 */
const pairOn = (
  grid: { rows: number; cols: number },
  regions: readonly CellRegion[],
  avoid: readonly CellRegion[] = [],
  /** Ink that is neither a digested region nor an avoid footprint: a screen that is simply drawn on. */
  ink: readonly CellRegion[] = [],
) => {
  const width = grid.cols * CELL.width
  const height = grid.rows * CELL.height
  const rgba = new Uint8Array(width * height * 4)
  for (let index = 0; index < width * height; index += 1) {
    rgba[index * 4] = BACKGROUND[0]
    rgba[index * 4 + 1] = BACKGROUND[1]
    rgba[index * 4 + 2] = BACKGROUND[2]
    rgba[index * 4 + 3] = 255
  }
  // A REGION IS DRAWN SPARSELY, the way a terminal draws one: a glyph's ink occupies part of a cell,
  // not all of it, so the frame's modal colour stays the background. Painting a region solid makes
  // the ink modal on a region that covers most of the screen, and then no cell reads as blank — which
  // is the frame lying to the chooser, not the chooser failing (it took half an hour to see that).
  const paint = (region: CellRegion) => {
    for (let row = region.top; row <= region.bottom; row += 1) {
      for (let col = region.left; col <= region.right; col += 1) {
        const y = (row - 1) * CELL.height + Math.floor(CELL.height / 2)
        for (let x = (col - 1) * CELL.width + 1; x < col * CELL.width - 1; x += 1) {
          const index = (y * width + x) * 4
          rgba[index] = INK[0]
          rgba[index + 1] = INK[1]
          rgba[index + 2] = INK[2]
        }
      }
    }
  }
  for (const region of regions) paint(region)
  for (const region of avoid) paint(region)
  for (const region of ink) paint(region)
  return sentinelCellsInFrame({
    rgba,
    width,
    height,
    reading: { x: 0, y: 0 },
    cell: CELL,
    grid,
    regions,
    avoid,
  })
}

describe("34040 the pair search reaches a free cell outside the old fixed list", () => {
  // The recorded geometries: run 43414740482 both arms, and @cpo/term's Kitty and Ghostty runs
  // (2026-11-13T11-06-02-845Z, 2026-11-13T10-36-01-928Z), each taken from the refusal's own sentence.
  const recorded = [
    { arm: "warp", grid: { rows: 39, cols: 123 }, region: { top: 2, left: 1, bottom: 3, right: 5 } },
    { arm: "warp reset.decaln", grid: { rows: 39, cols: 123 }, region: { top: 2, left: 1, bottom: 3, right: 8 } },
    { arm: "terminal-app", grid: { rows: 30, cols: 120 }, region: { top: 2, left: 1, bottom: 3, right: 5 } },
    { arm: "kitty", grid: { rows: 20, cols: 61 }, region: { top: 2, left: 1, bottom: 3, right: 5 } },
    { arm: "ghostty", grid: { rows: 21, cols: 61 }, region: { top: 2, left: 1, bottom: 3, right: 5 } },
  ]
  for (const { arm, grid, region } of recorded) {
    it(`${arm}: the pair lands on 1,1 and 4,2`, () => {
      expect(pairOn(grid, [region])).toEqual({
        a: { row: 1, col: 1 },
        b: { row: 4, col: 2 },
        tier: "region-free",
      })
    })
  }

  it("is deterministic: the same frame and regions yield the same pair on every call", () => {
    const grid = { rows: 39, cols: 123 }
    const first = pairOn(grid, [{ top: 2, left: 1, bottom: 3, right: 8 }])
    for (let run = 0; run < 5; run += 1) {
      expect(pairOn(grid, [{ top: 2, left: 1, bottom: 3, right: 8 }])).toEqual(first)
    }
  })

  it("takes the nearest usable cell, not the first one that merely differs in both axes", () => {
    // A 40x123 screen, region on rows 1-3: the first cell takes the row below the region and the
    // second the next row's neighbouring column, not some far cell that also differs in both axes.
    expect(pairOn({ rows: 40, cols: 123 }, [{ top: 1, left: 1, bottom: 3, right: 5 }])).toEqual({
      a: { row: 4, col: 1 },
      b: { row: 5, col: 2 },
      tier: "region-free",
    })
  })
})

describe("34040 tier 2: one clear row still anchors, on a pair a cell apart", () => {
  // The live grids behind the two rows that still refused with both 34040 commits present.
  const recorded = [
    {
      arm: "kitty modes.decsscls",
      grid: { rows: 20, cols: 61 },
      region: { top: 1, left: 1, bottom: 19, right: 61 },
      row: 20,
    },
    {
      arm: "ghostty modes.decsscls",
      grid: { rows: 21, cols: 61 },
      region: { top: 1, left: 1, bottom: 20, right: 61 },
      row: 21,
    },
    {
      arm: "warp modes.decsscls",
      grid: { rows: 39, cols: 123 },
      region: { top: 1, left: 1, bottom: 38, right: 123 },
      row: 39,
    },
  ]
  for (const { arm, grid, region, row } of recorded) {
    it(`${arm}: both cells on row ${row}, one whole cell apart`, () => {
      expect(pairOn(grid, [region])).toEqual({
        a: { row, col: 1 },
        b: { row, col: 3 },
        tier: "same-row",
      })
    })
  }

  it("never places the two cells next to each other", () => {
    // Adjacent cells read as ONE wide box when a run of sentinel colour is painted across them, so
    // the pair must keep a whole cell between it (@cto, 34040 tier 2).
    const pair = pairOn({ rows: 5, cols: 10 }, [{ top: 1, left: 1, bottom: 4, right: 10 }])
    expect(pair.tier).toBe("same-row")
    expect(Math.abs(pair.b.col - pair.a.col)).toBeGreaterThanOrEqual(2)
  })

  it("a one-row screen has nowhere to put a pair at all", () => {
    expect(() => pairOn({ rows: 1, cols: 10 }, [{ top: 1, left: 1, bottom: 1, right: 10 }])).toThrow(
      /every row of this 1x10 screen is inside a digested region/,
    )
  })

  it("a one-column screen cannot hold a second cell that differs in column", () => {
    expect(() => pairOn({ rows: 4, cols: 1 }, [{ top: 1, left: 1, bottom: 2, right: 2 }])).toThrow(
      /the compared region leaves one clear column, 1, on this 4x1 screen/,
    )
  })
})

describe("34040 the frame rule leaves two tiers, and both are reachable", () => {
  it("there is no no-clear-row tier, because no frame can reach one", () => {
    // A tier-3 cell would have to be blank (so not the probe's ink) AND inside a digested region (or
    // it is a tier-1 cell) AND two columns clear of that region's own edges. A cell inside region R
    // at column c has R.left <= c <= R.right, so neither c <= R.left-2 nor c >= R.right+2 can hold.
    // This screen is the closest thing to that shape: every row is inside the region and every column
    // outside it carries the probe's own band, so the frame refuses rather than inventing a tier.
    expect(() =>
      pairOn(
        { rows: 20, cols: 61 },
        [{ top: 1, left: 1, bottom: 20, right: 61 }],
        [{ top: 1, left: 1, bottom: 20, right: 61 }],
      ),
    ).toThrow(/cannot be anchored/)
  })

  it("a row that is free on both sides of the region is still a region-free pair", () => {
    // viewport-hold's recorded grid: the region uses every row but only columns 1-10, so columns 12
    // onward are free and the pair never needs a second tier.
    const pair = pairOn({ rows: 20, cols: 61 }, [{ top: 1, left: 1, bottom: 20, right: 10 }])
    expect(pair.tier).toBe("region-free")
    expect(pair.a.col).toBeGreaterThanOrEqual(12)
  })
})

describe("34040 the pair's refusal does not blame the probe's own output", () => {
  it("anchors outside the compared region when an avoid band, not the region, blocks a row", () => {
    // Row 3 is the probe's own output, not a compared region. The frame rule needs no third tier for
    // that: both cells come from outside the region, so nothing the pair says can blame the compared
    // region for rows it does not use (@dev/15 peer read). Row 2 carries the region only in columns
    // 1-5, so column 7 on that row is free screen and the pair stays region-free.
    const pair = pairOn(
      { rows: 3, cols: 10 },
      [{ top: 2, left: 1, bottom: 2, right: 5 }],
      [{ top: 3, left: 1, bottom: 3, right: 10 }],
    )
    expect(pair).toEqual({ a: { row: 1, col: 1 }, b: { row: 2, col: 7 }, tier: "region-free" })
  })
})

describe("34040 the first cell gets the same search, not a second fixed list", () => {
  it("finds the last free row of the screen instead of refusing", () => {
    // The case the old list got wrong: rows 1-23 digested on a 24-row screen, so row 24 is the only
    // place the sentinel can go, three rows below the region.
    const pair = pairOn({ rows: 24, cols: 80 }, [
      { top: 1, left: 1, bottom: 22, right: 10 },
      { top: 23, left: 1, bottom: 23, right: 10 },
    ])
    expect(pair.a).toEqual({ row: 24, col: 1 })
    expect(pair.tier).toBe("region-free")
  })

  it("answers below the region when the row above it carries ink, not the first blank cell row-major meets", () => {
    // A row-major scan of this frame returns 2,6: the first blank cell outside the region that a
    // top-left walk meets. That answer moves whenever an unrelated row above gains or loses ink, and
    // two runs of the same terminal then disagree. The order is fixed instead — the cell above the
    // region's first cell, then above its right edge, then directly below, then nearest first — so
    // row 1 carrying Warp's command header sends the pair under the region, to 4,1.
    const pair = pairOn(
      { rows: 10, cols: 20 },
      [{ top: 2, left: 1, bottom: 3, right: 5 }],
      [],
      [{ top: 1, left: 1, bottom: 1, right: 20 }],
    )
    expect(pair.a).toEqual({ row: 4, col: 1 })
    expect(pair.tier).toBe("region-free")
  })

  it("anchors past a footprint that covers every row but not every column", () => {
    // Ghostty's scrollback footprint (1,1-20,10 on a 20x61 screen) uses every row. The frame rule
    // does not need a third tier for it: columns 12 onward are outside the region and blank, so the
    // pair is region-free — where the pre-34040 picker refused because it also demanded a row the
    // region did not use.
    const pair = pairOn({ rows: 20, cols: 61 }, [{ top: 1, left: 1, bottom: 20, right: 10 }])
    expect(pair.tier).toBe("region-free")
    expect(pair.a.col).toBeGreaterThanOrEqual(12)
  })

  it("keeps 33000's preference: directly above the region, then below it", () => {
    expect(pairOn({ rows: 24, cols: 80 }, [{ top: 3, left: 1, bottom: 5, right: 10 }]).a).toEqual({
      row: 2,
      col: 1,
    })
    expect(pairOn({ rows: 24, cols: 80 }, [{ top: 1, left: 1, bottom: 4, right: 10 }]).a).toEqual({
      row: 5,
      col: 1,
    })
  })
})
