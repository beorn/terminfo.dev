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
import { witnessCellFor, witnessCellsFor } from "./region-readback.ts"

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
      expect(witnessCellsFor([region], grid)).toEqual({ a: { row: 1, col: 1 }, b: { row: 4, col: 2 } })
    })
  }

  it("is deterministic: the same grid and regions yield the same pair on every call", () => {
    const grid = { rows: 39, cols: 123 }
    const first = witnessCellsFor([{ top: 2, left: 1, bottom: 3, right: 8 }], grid)
    for (let run = 0; run < 5; run += 1) {
      expect(witnessCellsFor([{ top: 2, left: 1, bottom: 3, right: 8 }], grid)).toEqual(first)
    }
  })

  it("takes the nearest usable cell, not the first one that merely differs in both axes", () => {
    // A 40x123 screen, region on rows 1-3: the first cell takes the row below the region and the
    // second the next row's neighbouring column, not some far cell that also differs in both axes.
    expect(witnessCellsFor([{ top: 1, left: 1, bottom: 3, right: 5 }], { rows: 40, cols: 123 })).toEqual({
      a: { row: 4, col: 1 },
      b: { row: 5, col: 2 },
    })
  })
})

describe("34040 a pair that cannot exist refuses and names the screen's limit", () => {
  const recorded = [
    {
      arm: "warp modes.decsscls",
      grid: { rows: 39, cols: 123 },
      region: { top: 1, left: 1, bottom: 38, right: 123 },
      keep: 39,
    },
    {
      arm: "kitty modes.decsscls",
      grid: { rows: 20, cols: 61 },
      region: { top: 1, left: 1, bottom: 19, right: 61 },
      keep: 20,
    },
    {
      arm: "ghostty modes.decsscls",
      grid: { rows: 21, cols: 61 },
      region: { top: 1, left: 1, bottom: 20, right: 61 },
      keep: 21,
    },
  ]
  for (const { arm, grid, region, keep } of recorded) {
    it(`${arm}: one clear row, named`, () => {
      expect(() => witnessCellsFor([region], grid)).toThrow(
        new RegExp(`the compared region leaves one clear row, ${keep}, on this ${grid.rows}x${grid.cols} screen`),
      )
    })
  }

  it("a one-row screen has nowhere to put a pair at all", () => {
    expect(() => witnessCellsFor([{ top: 1, left: 1, bottom: 1, right: 5 }], { rows: 1, cols: 10 })).toThrow(
      /every row of this 1x10 screen is inside a digested region/,
    )
  })

  it("a one-column screen cannot hold a second cell that differs in column", () => {
    expect(() => witnessCellsFor([{ top: 1, left: 1, bottom: 2, right: 2 }], { rows: 4, cols: 1 })).toThrow(
      /the compared region leaves one clear column, 1, on this 4x1 screen/,
    )
  })
})

describe("34040 the pair's refusal does not blame the probe's own output", () => {
  it("names no limit it cannot act on when an avoid band, not the region, blocks the rows", () => {
    // Row 3 is the probe's own output, not a compared region. The second cell avoids the compared
    // region's rows only, so the honest sentence is the generic one — saying "every row is inside a
    // digested region" would blame the compared region for rows it does not use (@dev/15 peer read).
    expect(() =>
      witnessCellsFor([{ top: 2, left: 1, bottom: 2, right: 5 }], { rows: 3, cols: 10 }, [
        { top: 3, left: 1, bottom: 3, right: 10 },
      ]),
    ).toThrow(/no a second cell outside the digested regions is left in the 3x10 grid that the pair rule accepts/)
  })
})

describe("34040 the first cell gets the same search, not a second fixed list", () => {
  it("finds the last free row of the screen instead of refusing", () => {
    // The case the old list got wrong: rows 1-23 digested on a 24-row screen, so row 24 is the only
    // place the sentinel can go, three rows below the region.
    expect(
      witnessCellFor(
        [
          { top: 1, left: 1, bottom: 22, right: 10 },
          { top: 23, left: 1, bottom: 23, right: 10 },
        ],
        { rows: 24, cols: 80 },
      ),
    ).toEqual({ row: 24, col: 1 })
  })

  it("searches past a probe's own output that covers the rows just outside the region", () => {
    // Ghostty's scrollback footprint (1,1-20,10 on a 20x61 screen) uses every row: no cell exists,
    // and the refusal says which limit was hit rather than listing what was tried.
    expect(() => witnessCellFor([{ top: 1, left: 1, bottom: 20, right: 10 }], { rows: 20, cols: 61 })).toThrow(
      /every row of this 20x61 screen is inside a digested region, so no row is left for a cell/,
    )
  })

  it("keeps 33000's preference: directly above the region, then below it", () => {
    expect(witnessCellFor([{ top: 3, left: 1, bottom: 5, right: 10 }], { rows: 24, cols: 80 })).toEqual({
      row: 2,
      col: 1,
    })
    expect(witnessCellFor([{ top: 1, left: 1, bottom: 4, right: 10 }], { rows: 24, cols: 80 })).toEqual({
      row: 5,
      col: 1,
    })
  })
})
