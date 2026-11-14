/**
 * @failure A pixel read paints its sentinel pair on cells the probe has already drawn and its blank
 * restore erases that evidence, or anchors on a pair one stray patch could satisfy, or refuses an
 * unanchorable frame without naming what it looked for.
 * @level l2
 * @consumer The one sentinel-cell chooser every pixel read paints through (33981, @dev/15's 19 rows).
 * @testonly none
 * @reach none
 */
import { expect, test } from "vitest"
import { sentinelCellsInFrame } from "./region-readback.ts"

/** A frame of `grid` cells at `cell` pixels, background everywhere, ink on the listed cells. */
function frame(input: {
  grid: { rows: number; cols: number }
  cell: { width: number; height: number }
  ink: readonly { row: number; col: number; half?: boolean; leftHalf?: boolean }[]
}) {
  const { grid, cell } = input
  const background = 0x050505
  const inkColour = 0xc1e3fe
  const width = grid.cols * cell.width
  const height = grid.rows * cell.height
  const rgba = new Uint8Array(width * height * 4)
  const put = (x: number, y: number, packed: number) => {
    const offset = (y * width + x) * 4
    rgba[offset] = (packed >> 16) & 0xff
    rgba[offset + 1] = (packed >> 8) & 0xff
    rgba[offset + 2] = packed & 0xff
    rgba[offset + 3] = 0xff
  }
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) put(x, y, background)
  for (const cellAt of input.ink) {
    const left = (cellAt.col - 1) * cell.width
    const top = (cellAt.row - 1) * cell.height
    const rows = cellAt.half ? Math.floor(cell.height / 2) : cell.height
    const cols = cellAt.leftHalf ? Math.floor(cell.width / 2) : cell.width
    for (let y = top; y < top + rows; y++) for (let x = left; x < left + cols; x++) put(x, y, inkColour)
  }
  return { rgba, width, height }
}

const grid = { rows: 24, cols: 8 }
const cell = { width: 7, height: 15 }
const selection = (
  ink: readonly { row: number; col: number; half?: boolean; leftHalf?: boolean }[],
  extra: Record<string, unknown> = {},
) =>
  sentinelCellsInFrame({
    ...frame({ grid, cell, ink }),
    reading: { x: 0, y: 0 },
    cell,
    grid,
    regions: [],
    ...extra,
  })

test("never chooses a cell the probe has already painted", () => {
  const inked = [
    { row: 1, col: 1 },
    { row: 1, col: 2 },
    { row: 2, col: 1 },
  ]
  const { a, b } = selection(inked)
  for (const chosen of [a, b]) expect(inked).not.toContainEqual(chosen)
})

test("finds cells below a block of probe output, where eight neighbours would have refused", () => {
  const inked = Array.from({ length: 4 }, (_, row) =>
    Array.from({ length: 8 }, (_, col) => ({ row: row + 1, col: col + 1 })),
  ).flat()
  const { a, b } = selection(inked)
  expect(a.row).toBeGreaterThan(4)
  expect(b.row).toBeGreaterThan(4)
  expect(a.row !== b.row && a.col !== b.col).toBe(true)
})

test("refuses by name when no cell is blank, because every cell carries a glyph", () => {
  const inked = Array.from({ length: 24 }, (_, row) =>
    Array.from({ length: 8 }, (_, col) => ({ row: row + 1, col: col + 1, half: true })),
  ).flat()
  expect(() => selection(inked)).toThrow(/no blank cell exists/)
})

test("keeps the pair outside the digested regions and the probe's avoid footprint", () => {
  const regions = [{ top: 1, left: 1, bottom: 3, right: 8 }]
  const avoid = [{ top: 4, left: 1, bottom: 4, right: 8 }]
  const { a, b } = selection([], { regions, avoid: [avoid[0]] })
  for (const chosen of [a, b]) expect(chosen.row).toBeGreaterThan(4)
})

test("anchors on a lone blank row, a whole cell apart, and says it measured one axis (34040)", () => {
  // Row 24 is the only blank row: the pre-34040 picker refused this frame because it demanded a pair
  // that differed on both axes, and the read lost a gradeable row to a rule it did not need. The
  // same-row tier exists for exactly this shape and the gap keeps the two cells from merging into
  // one wide box under a single sentinel-coloured run; the tier is what tells the reader it measured
  // the column pitch alone.
  const inked = Array.from({ length: 23 }, (_, row) =>
    Array.from({ length: 8 }, (_, col) => ({ row: row + 1, col: col + 1, half: true })),
  ).flat()
  const { a, b, tier } = selection(inked)
  expect(tier).toBe("same-row")
  expect(a.row).toBe(24)
  expect(b.row).toBe(24)
  expect(Math.abs(b.col - a.col)).toBeGreaterThanOrEqual(2)
})

// @dev/15's finding on the A+B head: a double-width glyph draws its ink in one half and can leave
// the other half the background colour, so "every pixel is background" alone would choose the blank
// half and the restore would erase the glyph whole — @dev/10's rule. The cell a wide glyph could
// straddle into is never eligible, however blank it looks.
//
// The fixture must actually reach that cell: rows 1-2 AND rows 6-8 are inked edge to edge, so the
// preferred cells above and below the region (2,1, 2,12, 6,1) are all ink and the search has to
// answer inside the region's own band, on the only free cells it leaves: columns 12 onward of row 3.
// Every cell left of the region's right edge at 3,11 is excluded by the region, so the first
// eligible cell is 3,12 on a rule-less chooser (red on 9b4df8d9) and 3,13 with the neighbour rule.
test("never uses the blank half of a wide glyph as a sentinel cell", () => {
  const wide = { grid: { rows: 8, cols: 24 }, cell: { width: 4, height: 6 } }
  const regions = [{ top: 3, left: 1, bottom: 5, right: 11 }]
  // The blocker rows carry a GLYPH's worth of ink, not a solid fill: a solid five-row band makes ink
  // the frame's modal colour, and then every inked cell reads as "blank" and the fixture would be
  // testing the opposite of what it says (the same trap that hid a bug in witness-search's helper).
  // Every row but the region's own middle row, so the search cannot tie between a cell beside the
  // glyph and one a row further out: row 3's columns 12 onward are the frame's only free cells and
  // the neighbour rule is the only thing that can move the answer off 3,12.
  const filledRows = [1, 2, 4, 5, 6, 7, 8].flatMap((row) =>
    Array.from({ length: wide.grid.cols }, (_, col) => ({ row, col: col + 1, half: true })),
  )
  const glyph = [{ row: 3, col: 11, leftHalf: true }]
  const { a } = sentinelCellsInFrame({
    ...frame({ ...wide, ink: [...filledRows, ...glyph] }),
    reading: { x: 0, y: 0 },
    ...wide,
    regions,
  })
  expect(a, "the cell beside inked text can be a wide glyph's blank half").not.toEqual({ row: 3, col: 12 })
  expect(a).toEqual({ row: 3, col: 13 })
})
