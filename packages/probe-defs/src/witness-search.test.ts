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
      expect(witnessCellsFor([region], grid)).toEqual({
        a: { row: 1, col: 1 },
        b: { row: 4, col: 2 },
        tier: "region-free",
      })
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
      expect(witnessCellsFor([region], grid)).toEqual({
        a: { row, col: 1 },
        b: { row, col: 3 },
        tier: "same-row",
      })
    })
  }

  it("never places the two cells next to each other", () => {
    // Adjacent cells read as ONE wide box when a run of sentinel colour is painted across them, so
    // the pair must keep a whole cell between it (@cto, 34040 tier 2).
    const pair = witnessCellsFor([{ top: 1, left: 1, bottom: 4, right: 10 }], { rows: 5, cols: 10 })
    expect(pair.tier).toBe("same-row")
    expect(Math.abs(pair.b.col - pair.a.col)).toBeGreaterThanOrEqual(2)
  })

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

describe("34040 tier 3: no clear row at all still anchors, on columns clear of every edge", () => {
  it("viewport-hold: the region uses every row, both cells move past its column span", () => {
    // kitty run 2026-11-13T23-06-01Z: "every row of this 20x61 screen is inside a digested region".
    const pair = witnessCellsFor([{ top: 1, left: 1, bottom: 20, right: 10 }], { rows: 20, cols: 61 })
    expect(pair.tier).toBe("no-clear-row")
    expect(pair.a.col).toBeGreaterThanOrEqual(12)
    expect(pair.b.col).toBeGreaterThanOrEqual(12)
    expect(pair.b.row).not.toBe(pair.a.row)
    expect(pair.b.col).not.toBe(pair.a.col)
  })

  it("keeps a whole cell between the pair and the region's edge (the wide-glyph column)", () => {
    // Right edge at column 10: column 11 is the straddle column, so 12 is the first usable one.
    const pair = witnessCellsFor([{ top: 1, left: 1, bottom: 6, right: 10 }], { rows: 6, cols: 20 })
    expect(pair.tier).toBe("no-clear-row")
    expect([pair.a.col, pair.b.col]).not.toContain(11)
  })

  it("names the tier it actually used when the first cell came from the column fallback (@dev/10, 34040)", () => {
    // Regions leave no free row and the probe's own band covers the row below, so the first cell is
    // chosen by the column fallback. The pair it finds is a tier-3 pair, not a region-free one, and
    // both cells keep the edge clearance the fallback used.
    const regions = [{ top: 1, left: 1, bottom: 2, right: 2 }]
    const avoid = [{ top: 3, left: 1, bottom: 3, right: 2 }]
    const pair = witnessCellsFor(regions, { rows: 3, cols: 10 }, avoid)
    expect(pair.tier).toBe("no-clear-row")
    for (const cell of [pair.a, pair.b]) {
      for (const region of [...regions, ...avoid]) {
        expect(cell.col <= region.left - 2 || cell.col >= region.right + 2).toBe(true)
      }
    }
    expect(pair.b.row).not.toBe(pair.a.row)
    expect(pair.b.col).not.toBe(pair.a.col)
  })

  it("still refuses when no column is clear of the region", () => {
    // Every row is a region row and no column is two cells clear of the region, so no tier can place
    // a cell; the read refuses with the first cell's own limit.
    expect(() => witnessCellsFor([{ top: 1, left: 1, bottom: 4, right: 9 }], { rows: 4, cols: 10 })).toThrow(
      /cannot be anchored/,
    )
  })
})

describe("34040 the pair's refusal does not blame the probe's own output", () => {
  it("names no limit it cannot act on when an avoid band, not the region, blocks the rows", () => {
    // Row 3 is the probe's own output, not a compared region. The second cell avoids the compared
    // region's rows only, so the honest sentence is the generic one — saying "every row is inside a
    // digested region" would blame the compared region for rows it does not use (@dev/15 peer read).
    expect(
      witnessCellsFor([{ top: 2, left: 1, bottom: 2, right: 5 }], { rows: 3, cols: 10 }, [
        { top: 3, left: 1, bottom: 3, right: 10 },
      ]),
    ).toEqual({ a: { row: 1, col: 1 }, b: { row: 1, col: 3 }, tier: "same-row" })
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
