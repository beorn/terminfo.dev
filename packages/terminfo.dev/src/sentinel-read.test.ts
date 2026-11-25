/**
 * @failure A pixel read crops at calibration's stale origin instead of the sentinel pair it paints,
 * finds that sentinel by its colour alone so a probe painting the same colour is refused or mistaken
 * for it, or leaves either painted cell behind, or refuses without naming the read (33000, 33981).
 * @level l2
 * @consumer Serve's per-read origin derivation for windows that move after calibration.
 * @testonly none
 * @reach none
 */
import {
  cropPositionRefusal,
  gridMoveExemption,
  pairMeasuredNoRowHeight,
  sentinelCellsInFrame,
  witnessProvesPitch,
  type PixelCellCrop,
  type TermProbeSource,
} from "@terminfo/probe-defs"
import { expect, test } from "vitest"
import type { CapturedFrame, NamedTextOrigin, OriginResolver } from "./capture-core.ts"
import { chooserRegions } from "./serve.ts"
import { SentinelFrameMoved, pairClearBeforePaint, readThroughSentinel } from "./sentinel-read.ts"

const sentinel = { form: "basic" as const, rgb: [255, 136, 255] as const }
const pixelGeometry = { cellWidth: 2, cellHeight: 2, textWidth: 12, textHeight: 8 }
const cells = { top: 1, left: 1, bottom: 2, right: 2 }
const grid = { rows: 4, cols: 6 }
const at = (cell: { row: number; col: number }) => `\x1b[${cell.row};${cell.col}H`
const paintOf = (pair: { a: { row: number; col: number }; b: { row: number; col: number } }) =>
  `\x1b7${at(pair.a)}\x1b[0m\x1b[45m ${at(pair.b)}\x1b[45m \x1b[0m\x1b8`
const clearOf = (pair: { a: { row: number; col: number }; b: { row: number; col: number } }) =>
  `\x1b7${at(pair.a)}\x1b[0m ${at(pair.b)} \x1b[0m\x1b8`

/**
 * The text origin each fixture frame was built at. A read's `reading` is the PRE-PAINT frame's own
 * origin (33981: the witness cells are chosen against the frame this run actually showed), so the
 * fixture carries its origin instead of every call restating it and drifting from the frame it built.
 */
const textOriginOf = new WeakMap<CapturedFrame, { x: number; y: number }>()

/**
 * A 16x12 window whose text area starts at `origin`: the probe's cells carry a pattern that depends
 * only on where a pixel sits inside its cell, and BOTH witness cells sit solid in the sentinel's
 * colour when `painted`. The same window with `painted: false` is one frame as the route saw it before
 * a paint, which is what the difference is taken against (33981).
 */
function windowAt(
  origin: { x: number; y: number },
  options: { painted?: boolean; pair?: { a: { row: number; col: number }; b: { row: number; col: number } } } = {},
): CapturedFrame {
  const width = 16
  const height = 12
  const rgba = new Uint8Array(width * height * 4)
  for (let offset = 3; offset < rgba.length; offset += 4) rgba[offset] = 255
  const paintAt = (x: number, y: number, colour: readonly number[]) => {
    if (x < 0 || y < 0 || x >= width || y >= height) {
      return
    }
    rgba.set(colour, (y * width + x) * 4)
  }
  for (let row = cells.top; row <= cells.bottom; row += 1) {
    for (let col = cells.left; col <= cells.right; col += 1) {
      for (let dy = 0; dy < 2; dy += 1) {
        for (let dx = 0; dx < 2; dx += 1) {
          paintAt(origin.x + (col - 1) * 2 + dx, origin.y + (row - 1) * 2 + dy, [
            (row * 40 + dy * 7) % 256,
            (col * 50 + dx * 11) % 256,
            90,
            255,
          ])
        }
      }
    }
  }
  if (options.painted ?? true) {
    const painted = options.pair ?? chosenPair
    for (const cell of [painted.a, painted.b]) {
      for (let dy = 0; dy < 2; dy += 1) {
        for (let dx = 0; dx < 2; dx += 1) {
          paintAt(origin.x + (cell.col - 1) * 2 + dx, origin.y + (cell.row - 1) * 2 + dy, [...sentinel.rgb, 255])
        }
      }
    }
  }
  const frame = { width, height, rgba }
  textOriginOf.set(frame, origin)
  return frame
}

function source(dims: { rows: number; cols: number } = grid) {
  const writes: string[] = []
  return {
    writes,
    source: { rows: dims.rows, cols: dims.cols, write: (text: string) => writes.push(text) },
  }
}

/** A frame of exactly `grid` cells at `cell` pixels, every pixel one colour: nothing drawn yet. */
function blankFrame(
  dims: { rows: number; cols: number },
  cell = { width: pixelGeometry.cellWidth, height: pixelGeometry.cellHeight },
): CapturedFrame {
  const width = dims.cols * cell.width
  const height = dims.rows * cell.height
  const frame = { width, height, rgba: new Uint8Array(width * height * 4).fill(255) }
  textOriginOf.set(frame, { x: 0, y: 0 })
  return frame
}

/**
 * The pair the read's chooser picks on a frame with nothing drawn on it, for a grid and a set of
 * digested regions. The same call the read makes, so a test's painted cells cannot drift from the
 * cells the read chooses (33981, 34040).
 */
function pairOnBlankFrame(
  dims: { rows: number; cols: number },
  regions: readonly { top: number; left: number; bottom: number; right: number }[],
  cell = { width: pixelGeometry.cellWidth, height: pixelGeometry.cellHeight },
) {
  const frame = blankFrame(dims, cell)
  return sentinelCellsInFrame({
    ...frame,
    reading: { x: 0, y: 0 },
    cell,
    grid: dims,
    regions,
  })
}

/** The pre-paint frame: one frame of the window as the route saw it, taken before the paint. */
function before(drawnAt: { x: number; y: number }): CapturedFrame {
  return windowAt(drawnAt, { painted: false })
}

/**
 * The pair the read's chooser picks for this window: the first blank cell outside the digested
 * region in row-major order, then the first blank cell sharing neither its row nor its column
 * (33981). Derived here rather than spelled out, so these tests and the read cannot drift apart.
 */
const chosenPair = sentinelCellsInFrame({
  ...before({ x: 0, y: 0 }),
  reading: { x: 0, y: 0 },
  cell: { width: pixelGeometry.cellWidth, height: pixelGeometry.cellHeight },
  grid,
  regions: [cells],
})
const PAINT = paintOf(chosenPair)
const CLEAR = clearOf(chosenPair)
const WHERE = `cells ${chosenPair.a.row},${chosenPair.a.col} and ${chosenPair.b.row},${chosenPair.b.col}`

/**
 * A fake terminal that reports what it was TOLD to draw: the frame is the screen after the writes it
 * has actually drawn. `lag` is how many of the most recent writes have not been drawn yet — what a
 * capture one write behind the paint looks like (33000), and what a stale pre-paint frame is (33981).
 * `underline` is the probe's own sentinel-coloured drawing, which can land after a frame was taken.
 */
function terminal(origin: { x: number; y: number }) {
  const writes: string[] = []
  const state = { lag: 0, underline: false }
  const drawn = () => writes.slice(0, Math.max(0, writes.length - state.lag))
  const paintsNow = () => {
    const last = drawn().at(-1)
    return last !== undefined && last.includes("\x1b[45m")
  }
  /**
   * The cells the last drawn write names, so a frame shows the pair THAT write painted rather than
   * one fixture-wide pair. Without this a read that chose other cells could never be shown painting
   * them, and the stale-but-located case below could not exist at all (34129).
   */
  const paintedPair = () => {
    const cells = [...(drawn().at(-1) ?? "").matchAll(/\x1b\[(\d+);(\d+)H/g)].map((hit) => ({
      row: Number(hit[1]),
      col: Number(hit[2]),
    }))
    const [a, b] = cells
    return a !== undefined && b !== undefined ? { a, b } : chosenPair
  }
  return {
    writes,
    state,
    source: { rows: grid.rows, cols: grid.cols, write: (text: string) => writes.push(text) },
    frameNow() {
      const frame = windowAt(origin, { painted: paintsNow(), pair: paintedPair() })
      if (state.underline) {
        for (let x = 0; x < 16; x++) frame.rgba.set([...sentinel.rgb, 255], (11 * 16 + x) * 4)
      }
      return frame
    },
  }
}

test("the crop origin comes from where the sentinel pair landed in this frame, not from calibration (33000)", async () => {
  const read = async (drawnAt: { x: number; y: number }) => {
    const frame = windowAt(drawnAt)
    const painted = source()
    const origin = await readThroughSentinel({
      source: painted.source,
      prePaint: async () => before(drawnAt),
      capture: async (resolve) => resolve({ frame, pixelGeometry }),
      label: "cells 1,1-2,2",
      sentinel,
      regions: [cells],
      reading: drawnAt,
      cell: { width: 2, height: 2 },
      deadline: Date.now() + 1_000,
    })
    return { origin, writes: painted.writes }
  }
  expect((await read({ x: 0, y: 0 })).origin.origin).toEqual({ x: 0, y: 0 })
  expect((await read({ x: 2, y: 2 })).origin.origin).toEqual({ x: 2, y: 2 })
  const nudged = await read({ x: 1, y: 3 })
  expect(nudged.origin.origin).toEqual({ x: 1, y: 3 })
  expect(nudged.origin.basis).toBe(`sentinel re-located by frame difference at ${WHERE} (33000, 33981)`)
  // Both cells are painted in ONE write and both are restored in ONE write.
  expect(nudged.writes).toEqual([PAINT, CLEAR])
})

test("a probe whose own pixels already carry the sentinel colour still anchors on the pair it painted (33981)", async () => {
  const frame = windowAt({ x: 2, y: 2 })
  const pre = before({ x: 2, y: 2 })
  // sgr.underline.dashed painted 2207 px of the sentinel's magenta, steady in both frames.
  for (const pixels of [pre, frame]) {
    for (let x = 0; x < 16; x++) pixels.rgba.set([...sentinel.rgb, 255], (11 * 16 + x) * 4)
  }
  const origin = await readThroughSentinel({
    source: source().source,
    prePaint: async () => pre,
    capture: async (resolve) => resolve({ frame, pixelGeometry }),
    label: "cells 1,1-2,2",
    sentinel,
    regions: [cells],
    reading: { x: 2, y: 2 },
    cell: { width: 2, height: 2 },
    deadline: Date.now() + 1_000,
  })
  expect(origin.origin).toEqual({ x: 2, y: 2 })
})

// @dev/10's (iii) and @cto's amended condition 1: one stray cell-sized patch of the sentinel colour —
// a probe's own late drawing — must never be taken for the paint when this read's paint has not
// rendered yet. With a pair, that frame has one region and refuses by name instead of anchoring.
test("a lone sentinel-coloured patch cannot stand in for the pair, and refuses by name with its box (33981)", async () => {
  const witness = windowAt({ x: 2, y: 2 }, { painted: false })
  // The probe's own late drawing: one cell-sized block of the sentinel's colour, nowhere the paint goes.
  for (let dy = 0; dy < 2; dy += 1) {
    for (let dx = 0; dx < 2; dx += 1) witness.rgba.set([...sentinel.rgb, 255], ((6 + dy) * 16 + (10 + dx)) * 4)
  }
  const painted = source()
  await expect(
    readThroughSentinel({
      source: painted.source,
      prePaint: async () => before({ x: 2, y: 2 }),
      capture: async (resolve) => resolve({ frame: witness, pixelGeometry }),
      label: "cells 1,1-2,2",
      sentinel,
      regions: [cells],
      reading: { x: 2, y: 2 },
      cell: { width: 2, height: 2 },
      deadline: Date.now(),
    }),
  ).rejects.toThrow(
    new RegExp(
      `^cells 1,1-2,2: the changed sentinel at ${WHERE} is not one painted pair: one connected region changed into the sentinel colour — 4 px in a 2x2 box at 10,6 — where the two painted cells need exactly two; it did not settle before this read's deadline$`,
    ),
  )
  // Both cells are still restored.
  expect(painted.writes.at(-1)).toBe(CLEAR)
})

// @cto 34040 condition 1, carried to the read: the tier-2 pair sits on ONE row a whole cell apart, so
// a run of sentinel colour along that row — a full-line repaint, a wide glyph erased with its
// neighbour — arrives as one connected region. It must refuse by name, never pass as two cells.
test("a sentinel-coloured run along a same-row pair reads as one wide box and refuses by name (34040)", async () => {
  const sameRowGrid = { rows: 3, cols: 6 }
  // Rows 1-2 are the digested region, so row 3 is the frame's only free row and tier 2 is the only
  // pair this frame can hold — the case 34040 exists for.
  const digested = { top: 1, left: 1, bottom: 2, right: 6 }
  const anchored = pairOnBlankFrame(sameRowGrid, [digested])
  expect(anchored.tier).toBe("same-row")
  const blank = blankFrame(sameRowGrid)
  const frame: CapturedFrame = { width: blank.width, height: blank.height, rgba: Uint8Array.from(blank.rgba) }
  // One continuous run of the sentinel's colour along the pair's row, spanning every column.
  for (let y = (anchored.a.row - 1) * pixelGeometry.cellHeight; y < anchored.a.row * pixelGeometry.cellHeight; y += 1) {
    for (let x = 0; x < sameRowGrid.cols * pixelGeometry.cellWidth; x += 1) {
      frame.rgba.set([...sentinel.rgb, 255], (y * frame.width + x) * 4)
    }
  }
  const painted = source(sameRowGrid)
  await expect(
    readThroughSentinel({
      source: painted.source,
      prePaint: async () => blank,
      capture: async (resolve) => resolve({ frame, pixelGeometry }),
      label: "cells 1,1-2,2",
      sentinel,
      regions: [digested],
      reading: { x: 0, y: 0 },
      cell: { width: pixelGeometry.cellWidth, height: pixelGeometry.cellHeight },
      deadline: Date.now(),
    }),
  ).rejects.toThrow(
    /^cells 1,1-2,2: the changed sentinel at cells 3,1 and 3,3 is not one painted pair: one connected region changed into the sentinel colour — 24 px in a 12x2 box at 0,4 — where the two painted cells need exactly two; it did not settle before this read's deadline$/,
  )
  // Both cells are still restored, in the pair's own order.
  expect(painted.writes.at(-1)).toBe("\x1b7\x1b[3;1H\x1b[0m \x1b[3;3H \x1b[0m\x1b8")
})

// @dev/15's blocking finding on a887dda73: a terminal that really draws U+2588 wide widens BOTH
// painted cells, so the diagonal pair touches and the difference answers ONE region. Counting first
// called that "other change" and retried to the deadline; the wide verdict must fire instead, on the
// FIRST attempt, and stop this run anchoring its reads (@dev/15 peer read of a887dda73).
test("a diagonal pair drawn wide merges into one region and stops the run anchoring on the first attempt (33981)", async () => {
  // A double-width glyph widens each painted cell by one cell in the column direction, so the two
  // blocks of the diagonal pair touch and the difference answers ONE region that spans more than one
  // column AND more than one row — the merged-pair shape, unlike a run along a single row.
  const pre = before({ x: 0, y: 0 })
  const frame = windowAt({ x: 0, y: 0 }, { painted: false })
  const { cellWidth, cellHeight } = pixelGeometry
  const boxes = [chosenPair.a, chosenPair.b].map((cell) => ({
    x: (cell.col - 1) * cellWidth,
    y: (cell.row - 1) * cellHeight,
    width: 2 * cellWidth,
    height: cellHeight,
  }))
  const left = Math.min(...boxes.map((box) => box.x))
  const top = Math.min(...boxes.map((box) => box.y))
  const right = Math.max(...boxes.map((box) => box.x + box.width))
  const bottom = Math.max(...boxes.map((box) => box.y + box.height))
  for (const box of boxes) {
    for (let y = box.y; y < box.y + box.height; y += 1) {
      for (let x = box.x; x < box.x + box.width; x += 1) {
        frame.rgba.set([...sentinel.rgb, 255], (y * frame.width + x) * 4)
      }
    }
  }
  const painted = source()
  await expect(
    readThroughSentinel({
      source: painted.source,
      prePaint: async () => pre,
      capture: async (resolve) => resolve({ frame, pixelGeometry }),
      label: "cells 1,1-2,2",
      sentinel,
      regions: [cells],
      reading: { x: 0, y: 0 },
      cell: { width: 2, height: 2 },
      deadline: Date.now(),
    }),
  ).rejects.toThrow(
    new RegExp(
      `^cells 1,1-2,2: every region that changed is wider than one cell — one changed region, ${boxes.reduce((sum, box) => sum + box.width * box.height, 0)} px in a ${right - left}x${bottom - top} box at ${left},${top} against a 2x2 cell\\. Either the terminal drew U\\+2588 across two columns, or this frame changed over a wide area rather than at the pair; both make the pair unusable as an anchor, so this run stops anchoring its reads on the sentinel$`,
    ),
  )
  // One paint and one clear: the verdict is reached before any retry repaints the cells.
  expect(painted.writes).toEqual([PAINT, CLEAR])
})

// @dev/10 peer read, 34040: the tier-2 pair is the reason the tiers exist, so the READ has to accept
// one. Two isolated cell-sized boxes on the pair's shared row anchor the crop, and the basis says the
// pair measured one axis; a pair whose boxes sit on different rows is refused in words.
test("a same-row pair anchors on the column pitch and says it measured one axis (34040)", async () => {
  const sameRowGrid = { rows: 3, cols: 6 }
  const digested = { top: 1, left: 1, bottom: 2, right: 6 }
  const blank = blankFrame(sameRowGrid)
  const frame: CapturedFrame = { width: blank.width, height: blank.height, rgba: Uint8Array.from(blank.rgba) }
  for (const [col, row] of [
    [1, 3],
    [3, 3],
  ] as const) {
    for (let dy = 0; dy < 2; dy += 1) {
      for (let dx = 0; dx < 2; dx += 1) {
        const x = (col - 1) * 2 + dx
        const y = (row - 1) * 2 + dy
        frame.rgba.set([...sentinel.rgb, 255], (y * frame.width + x) * 4)
      }
    }
  }
  const painted = source(sameRowGrid)
  const origin = await readThroughSentinel({
    source: painted.source,
    prePaint: async () => blank,
    capture: async (resolve) => resolve({ frame, pixelGeometry }),
    label: "cells 1,1-2,2",
    sentinel,
    regions: [digested],
    reading: { x: 0, y: 0 },
    cell: { width: pixelGeometry.cellWidth, height: pixelGeometry.cellHeight },
    deadline: Date.now() + 1_000,
  })
  expect(origin.origin).toEqual({ x: 0, y: 0 })
  expect(origin.basis).toContain(
    "sentinel re-located by frame difference at cells 3,1 and 3,3 (33000, 33981) (one-axis pair: both cells on one row, so it measures the column pitch only)",
  )
  expect(origin.witness).toEqual({
    a: { cell: { row: 3, col: 1 }, box: { x: 0, y: 4 } },
    b: { cell: { row: 3, col: 3 }, box: { x: 4, y: 4 } },
  })
  // The pair paints and restores the two cells this grid anchored on.
  expect(painted.writes.at(0)).toBe("\x1b7\x1b[3;1H\x1b[0m\x1b[45m \x1b[3;3H\x1b[45m \x1b[0m\x1b8")
  expect(painted.writes.at(-1)).toBe("\x1b7\x1b[3;1H\x1b[0m \x1b[3;3H \x1b[0m\x1b8")
})

test("a same-row pair whose boxes sit on different rows is refused in words (34040)", async () => {
  const sameRowGrid = { rows: 3, cols: 6 }
  const digested = { top: 1, left: 1, bottom: 2, right: 6 }
  const blank = blankFrame(sameRowGrid)
  const frame: CapturedFrame = { width: blank.width, height: blank.height, rgba: Uint8Array.from(blank.rgba) }
  for (const [col, row] of [
    [1, 3],
    [3, 2],
  ] as const) {
    for (let dy = 0; dy < 2; dy += 1) {
      for (let dx = 0; dx < 2; dx += 1) {
        const x = (col - 1) * 2 + dx
        const y = (row - 1) * 2 + dy
        frame.rgba.set([...sentinel.rgb, 255], (y * frame.width + x) * 4)
      }
    }
  }
  const painted = source(sameRowGrid)
  await expect(
    readThroughSentinel({
      source: painted.source,
      prePaint: async () => blank,
      capture: async (resolve) => resolve({ frame, pixelGeometry }),
      label: "cells 1,1-2,2",
      sentinel,
      regions: [digested],
      reading: { x: 0, y: 0 },
      cell: { width: pixelGeometry.cellWidth, height: pixelGeometry.cellHeight },
      deadline: Date.now(),
    }),
  ).rejects.toThrow(
    /^cells 1,1-2,2: the changed sentinel at cells 3,1 and 3,3 is not one painted pair: their offset is -4,2: this pair is on one row, so it can only measure the column pitch, and these two boxes do not share a row — they sit 2 px apart vertically, more than the 2 px blend slack or half the 2 px cell; it did not settle before this read's deadline$/,
  )
})

test("two changed cells at an offset the painted pair does not imply refuse by name (33981)", async () => {
  const frame = windowAt({ x: 0, y: 0 }, { painted: false })
  // Two cell-sized sentinel blocks one cell apart on BOTH axes would be the pair; these sit two cells
  // apart in x and one in y, which no pair of painted cells can produce.
  for (const [x, y] of [
    [0, 0],
    [6, 2],
  ] as const) {
    for (let dy = 0; dy < 2; dy += 1) {
      for (let dx = 0; dx < 2; dx += 1) {
        frame.rgba.set([...sentinel.rgb, 255], ((y + dy) * 16 + (x + dx)) * 4)
      }
    }
  }
  await expect(
    readThroughSentinel({
      source: source().source,
      prePaint: async () => before({ x: 0, y: 0 }),
      capture: async (resolve) => resolve({ frame, pixelGeometry }),
      label: "cells 1,1-2,2",
      sentinel,
      regions: [cells],
      reading: { x: 0, y: 0 },
      cell: { width: 2, height: 2 },
      deadline: Date.now(),
    }),
  ).rejects.toThrow(
    /their offset is 6,2, which is a pitch of 6.00x2.00 across the 1 columns and 1 rows between the painted cells, not the 2x2 cell/,
  )
})

test("a pair whose boxes are a blended edge short on each axis still anchors, because the offset follows the cell pitch (33981)", async () => {
  const pitch = { cellWidth: 12, cellHeight: 12, textWidth: 120, textHeight: 96 }
  const cell = { width: 12, height: 12 }
  const pre = blankFrame(grid, cell)
  const frame: CapturedFrame = { width: pre.width, height: pre.height, rgba: Uint8Array.from(pre.rgba) }
  // Two 10x10 blocks one blended line in from a 12x12 pitch, in the two cells the chooser picks on
  // this all-blank frame: 12 px apart on each axis, exactly the pitch those cells imply. The blocks
  // are placed from the chooser's own answer, so a change of order cannot silently unpin the test.
  const anchored = pairOnBlankFrame(grid, [cells], cell)
  const blockAt = (cellAt: { row: number; col: number }) =>
    [(cellAt.col - 1) * 12 + 1, (cellAt.row - 1) * 12 + 1] as const
  for (const [x, y] of [blockAt(anchored.a), blockAt(anchored.b)]) {
    for (let dy = 0; dy < 10; dy += 1) {
      for (let dx = 0; dx < 10; dx += 1) frame.rgba.set([...sentinel.rgb, 255], ((y + dy) * 72 + (x + dx)) * 4)
    }
  }
  const origin = await readThroughSentinel({
    source: source().source,
    prePaint: async () => pre,
    capture: async (resolve) => resolve({ frame, pixelGeometry: pitch }),
    label: "cells 1,1-2,2",
    sentinel,
    regions: [cells],
    reading: { x: 0, y: 0 },
    cell,
    deadline: Date.now() + 1_000,
  })
  // Each block is one blended line inside its cell, so the first block's own origin is one pitch
  // right and one pitch down from the pair's first cell: origin = block origin - (col-1, row-1)*pitch.
  expect(origin.origin).toEqual({ x: 1, y: 1 })
})

test("a third changed cell carrying the sentinel colour refuses by name with every box (33981)", async () => {
  const frame = windowAt({ x: 2, y: 2 })
  for (let dy = 0; dy < 2; dy += 1) {
    for (let dx = 0; dx < 2; dx += 1) frame.rgba.set([...sentinel.rgb, 255], ((8 + dy) * 16 + (12 + dx)) * 4)
  }
  const pre = before({ x: 2, y: 2 })
  await expect(
    readThroughSentinel({
      source: source().source,
      prePaint: async () => pre,
      capture: async (resolve) => resolve({ frame, pixelGeometry }),
      label: "cells 1,1-2,2",
      sentinel,
      regions: [cells],
      reading: { x: 2, y: 2 },
      cell: { width: 2, height: 2 },
      deadline: Date.now(),
    }),
  ).rejects.toThrow(
    /3 connected regions changed into the sentinel colour — .*where the two painted cells need exactly two/,
  )
})

test("changed pixels that carry no sentinel colour are counted in the evidence, not filtered by guesswork (33981)", async () => {
  const frame = windowAt({ x: 2, y: 2 })
  frame.rgba.set([1, 2, 3, 255], 0)
  frame.rgba.set([4, 5, 6, 255], 4)
  const origin = await readThroughSentinel({
    source: source().source,
    prePaint: async () => before({ x: 2, y: 2 }),
    capture: async (resolve) => resolve({ frame, pixelGeometry }),
    label: "cells 1,1-2,2",
    sentinel,
    regions: [cells],
    reading: { x: 2, y: 2 },
    cell: { width: 2, height: 2 },
    deadline: Date.now() + 1_000,
  })
  expect(origin.origin).toEqual({ x: 2, y: 2 })
  expect(origin.basis).toContain("(2 other changed px carry no sentinel colour)")
})

test.each([undefined, "\x1b8\x1b[1;3;7m\x1b[4;1H"])(
  "a lagged read retries with its original restoration bytes: %j (33000,34276)",
  async (restoreAfterPaint) => {
    const frame = terminal({ x: 2, y: 2 })
    // The first capture lands one write behind: it does not show the paint yet. The retry has to clear
    // the paint before it re-takes the pre-paint frame, or the difference compares two frames that both
    // show the sentinel and can never see it change (@dev/10).
    frame.state.lag = 1
    let prePaints = 0
    const input = {
      source: frame.source,
      restoreAfterPaint,
      prePaint: async () => {
        prePaints += 1
        return frame.frameNow()
      },
      capture: async (resolve: OriginResolver) => {
        const captured = frame.frameNow()
        frame.state.lag = 0
        // An owner advancing its state must not alter restoration bytes already held by this read.
        input.restoreAfterPaint = "\x1b8\x1b[31m"
        return resolve({ frame: captured, pixelGeometry })
      },
      label: "cells 1,1-2,2",
      sentinel,
      regions: [cells],
      reading: { x: 2, y: 2 },
      cell: { width: 2, height: 2 },
      deadline: Date.now() + 1_000,
    }
    const origin = await readThroughSentinel(input)
    expect(origin.origin).toEqual({ x: 2, y: 2 })
    expect(prePaints).toBe(2)
    const expected = (write: string) =>
      restoreAfterPaint === undefined ? write : write.slice(2, -2) + restoreAfterPaint
    expect(frame.writes).toEqual([PAINT, CLEAR, PAINT, CLEAR].map(expected))
  },
)

// #34276: a failure on the very first paint used to escape cleanup; a second cleanup failure must
// retain the deciding capture/paint failure. The ordinary capture-error test below cannot reach it.
test.each(["paint", "capture", "cleanup", "paint+cleanup", "capture+cleanup"])(
  "owner restoration attempts cleanup and retains both failures: %s",
  async (fault) => {
    const writes: string[] = []
    const paintFailure = new Error("paint write failed")
    const captureFailure = new Error("capture failed")
    const cleanupFailure = new Error("cleanup write failed")
    const restoreAfterPaint = "\x1b8\x1b[4;1H"
    const operation = readThroughSentinel({
      source: {
        ...grid,
        write: (text: string) => {
          writes.push(text)
          if (writes.length === 1 && fault.startsWith("paint")) throw paintFailure
          if (writes.length === 2 && fault.includes("cleanup")) throw cleanupFailure
        },
      },
      restoreAfterPaint,
      prePaint: async () => before({ x: 0, y: 0 }),
      capture: async () => {
        if (fault.startsWith("capture")) throw captureFailure
        return "captured"
      },
      label: "owner cleanup",
      sentinel,
      regions: [cells],
      reading: { x: 0, y: 0 },
      cell: { width: 2, height: 2 },
      deadline: Date.now() + 1_000,
    })
    const original = fault.startsWith("paint") ? paintFailure : captureFailure
    if (fault.includes("+")) {
      await expect(operation).rejects.toMatchObject({
        name: "AggregateError",
        cause: original,
        errors: [original, cleanupFailure],
      })
    } else await expect(operation).rejects.toBe(fault === "cleanup" ? cleanupFailure : original)
    expect(writes).toHaveLength(2)
    expect(writes.every((write) => !write.includes("\x1b7") && write.endsWith(restoreAfterPaint))).toBe(true)
  },
)

test("empty owner restoration is refused before reading or painting", async () => {
  const painted = source()
  let reads = 0
  await expect(
    readThroughSentinel({
      source: painted.source,
      restoreAfterPaint: "",
      label: "empty restoration",
      prePaint: async () => {
        reads += 1
        return before({ x: 0, y: 0 })
      },
      capture: async () => "captured",
      sentinel,
      regions: [cells],
      reading: { x: 0, y: 0 },
      cell: { width: 2, height: 2 },
      deadline: Date.now() + 1_000,
    }),
  ).rejects.toThrow(/empty restoration: restoreAfterPaint must be nonempty/)
  expect(painted.writes).toEqual([])
  expect(reads).toBe(0)
})

test("a pre-paint frame that lagged the probe's own drawing is retaken, and the read still anchors on the pair (33981)", async () => {
  const frame = terminal({ x: 2, y: 2 })
  let prePaints = 0
  const origin = await readThroughSentinel({
    source: frame.source,
    prePaint: async () => {
      prePaints += 1
      return frame.frameNow()
    },
    capture: async (resolve) => {
      // The probe's dashed underline, in the sentinel's own colour, draws after the pre-paint frame.
      frame.state.underline = true
      return resolve({ frame: frame.frameNow(), pixelGeometry })
    },
    label: "cells 1,1-2,2",
    sentinel,
    regions: [cells],
    reading: { x: 2, y: 2 },
    cell: { width: 2, height: 2 },
    deadline: Date.now() + 1_000,
  })
  expect(origin.origin).toEqual({ x: 2, y: 2 })
  expect(prePaints).toBe(2)
})

/** One pixel of a frame, by absolute position: what a reader sees at a witness box's own corner. */
function pixelOf(frame: CapturedFrame, at: { x: number; y: number }) {
  const offset = (at.y * frame.width + at.x) * 4
  return Array.from(frame.rgba.slice(offset, offset + 4))
}

/**
 * The freshness observation the settle study rests on, and why locating cannot stand in for it: a
 * pre-paint frame that still carries the PREVIOUS read's cleared pair can be short of blank cells
 * there, pick other ones, and locate its own new pair perfectly. A successful read therefore says
 * nothing about whether the cleanup write reached the screen; only the previous pair's recorded
 * witness boxes do (34129, @cto settle-experiment scope).
 */
test("a pre-paint frame one cleanup write behind still locates, so location is not freshness (34129)", async () => {
  const terminalAt = terminal({ x: 0, y: 0 })
  const read = async (from: CapturedFrame, whenCaptured: () => void) =>
    readThroughSentinel({
      source: terminalAt.source,
      prePaint: async () => from,
      capture: async (resolve) => {
        whenCaptured()
        return resolve({ frame: terminalAt.frameNow(), pixelGeometry })
      },
      label: "cells 1,1-2,2",
      sentinel,
      regions: [cells],
      reading: textOriginOf.get(from) ?? { x: 0, y: 0 },
      cell: { width: 2, height: 2 },
      deadline: Date.now() + 1_000,
    })

  // First read, with every write drawn: it paints the pair and clears it in one write each.
  const first = await read(terminalAt.frameNow(), () => {})
  expect(terminalAt.writes).toEqual([PAINT, CLEAR])
  expect(first.witness).toBeDefined()
  const witnessBox = boxOf(first.witness, "the first read")

  // The clear has not reached the screen when the next read takes its pre-paint frame.
  terminalAt.state.lag = 1
  const stale = terminalAt.frameNow()
  expect(pixelOf(stale, witnessBox)).toEqual([...sentinel.rgb, 255])

  // That frame still locates: the pair it paints sits in other cells, so the read succeeds and would
  // have reported nothing about the frame being one write behind.
  const second = await read(stale, () => {
    terminalAt.state.lag = 0
  })
  expect(second.witness).toBeDefined()
  expect(terminalAt.writes[2]).not.toBe(PAINT)

  // The expected restored state: the same terminal once the clear has been drawn, not a blank fixture
  // frame. Sentinel absence alone is not restoration — a frame whose protected region had been erased
  // or recoloured to any non-sentinel RGB would also carry no sentinel and still be wrong — so every
  // pixel outside this pair's own paint blocks has to match this frame exactly (@dev/7 peer read, 34129).
  const restored = terminalAt.frameNow()
  expect(differingPixels(stale, restored)).toEqual(blockPixels([chosenPair.a, chosenPair.b]))
  expect(pixelOf(restored, witnessBox)).not.toEqual([...sentinel.rgb, 255])
  expect(sentinelPixels(restored)).toBe(0)
})

/** A witness box that must exist: binding it once beats an `?? { x: 0, y: 0 }` that would measure pixel
 * (0,0) and pass for the wrong reason if the guard above ever loosened (@dev/11 peer read, 34129). */
function boxOf(witness: { a: { box: { x: number; y: number } } } | undefined, what: string) {
  if (witness === undefined) throw new Error(`${what} anchored no witness, so there is nothing to read`)
  return witness.a.box
}

/** Where the fixture paints a cell: the same 2x2 arithmetic its window uses, by absolute pixel. */
function cellPixel(cell: { row: number; col: number }, origin = { x: 0, y: 0 }) {
  return { x: origin.x + (cell.col - 1) * 2, y: origin.y + (cell.row - 1) * 2 }
}

/** How many pixels of a whole frame carry the sentinel: what a fully restored frame must not have. */
function sentinelPixels(frame: CapturedFrame) {
  let count = 0
  for (let at = 0; at < frame.rgba.length; at += 4) {
    if (
      frame.rgba[at] === sentinel.rgb[0] &&
      frame.rgba[at + 1] === sentinel.rgb[1] &&
      frame.rgba[at + 2] === sentinel.rgb[2]
    ) {
      count += 1
    }
  }
  return count
}

/** Every pixel two frames disagree on, in frame order: what a protected region must have none of. */
function differingPixels(actual: CapturedFrame, expected: CapturedFrame) {
  const out: { x: number; y: number }[] = []
  for (let index = 0; index < Math.min(actual.rgba.length, expected.rgba.length); index += 4) {
    if (
      actual.rgba[index] !== expected.rgba[index] ||
      actual.rgba[index + 1] !== expected.rgba[index + 1] ||
      actual.rgba[index + 2] !== expected.rgba[index + 2]
    ) {
      const pixel = index / 4
      out.push({ x: pixel % actual.width, y: Math.floor(pixel / actual.width) })
    }
  }
  return out
}

/** The 2x2 pixels a cell's block occupies, in the same frame order differingPixels reports. */
function blockPixels(cells: { row: number; col: number }[], origin = { x: 0, y: 0 }) {
  const out: { x: number; y: number }[] = []
  for (const cell of cells) {
    for (let dy = 0; dy < 2; dy += 1) {
      for (let dx = 0; dx < 2; dx += 1) {
        out.push({ x: origin.x + (cell.col - 1) * 2 + dx, y: origin.y + (cell.row - 1) * 2 + dy })
      }
    }
  }
  return out.sort((a, b) => a.y - b.y || a.x - b.x)
}

/** The cells a paint or clear write names, in the order it names them. */
function cellsNamedBy(write: string) {
  return [...write.matchAll(/\x1b\[(\d+);(\d+)H/g)].map((hit) => ({ row: Number(hit[1]), col: Number(hit[2]) }))
}

/**
 * The retry half of the same boundary (@cto settle-experiment scope, 34129): before it retakes the
 * pre-paint frame a read clears its own paint, so the retry frame is only truly a frame BEFORE the
 * paint if that clear reached the screen. Nothing the read returns can tell the difference: it locates
 * a pair either way. Only the frame does, which is why the study reads retained frames rather than read
 * outcomes, and why a located read is never counted as a fresh one.
 */
test.each([
  { lag: 1, stale: true },
  { lag: 0, stale: false },
])(
  "a retry's pre-paint frame is stale exactly when its own clear has not reached the screen: %o (34129)",
  async ({ lag, stale }) => {
    const terminalAt = terminal({ x: 0, y: 0 })
    let prePaints = 0
    let captures = 0
    let retryFrame: CapturedFrame | undefined
    // The first capture lands a write behind, so it cannot see the paint and the read retries.
    terminalAt.state.lag = 1
    const read = await readThroughSentinel({
      source: terminalAt.source,
      prePaint: async () => {
        prePaints += 1
        if (prePaints === 1) return windowAt({ x: 0, y: 0 }, { painted: false })
        // The retry has just written its clear; how much of that reached the screen is the question.
        terminalAt.state.lag = lag
        retryFrame = terminalAt.frameNow()
        return retryFrame
      },
      capture: async (resolve) => {
        captures += 1
        // The first capture is the one that lags: it cannot see this read's paint and refuses.
        if (captures === 1) return resolve({ frame: terminalAt.frameNow(), pixelGeometry })
        terminalAt.state.lag = 0
        return resolve({ frame: terminalAt.frameNow(), pixelGeometry })
      },
      label: "cells 1,1-2,2",
      sentinel,
      regions: [cells],
      reading: { x: 0, y: 0 },
      cell: { width: 2, height: 2 },
      deadline: Date.now() + 1_000,
    })

    // Location is not the discriminator: the read anchors its pair in both cases.
    expect(read.witness).toBeDefined()
    expect(prePaints).toBe(2)
    // This read's own paint, as the frame would show it if the clear had not landed.
    const painted = cellsNamedBy(terminalAt.writes[0] ?? "")
    expect(painted.length).toBeGreaterThanOrEqual(1)
    const corner = pixelOf(retryFrame as CapturedFrame, cellPixel(painted[0] as { row: number; col: number }))
    // The expected restored state for this same terminal once its own clear has been drawn.
    terminalAt.state.lag = 0
    const expectedRestored = terminalAt.frameNow()
    const underTest = retryFrame as CapturedFrame
    if (stale) {
      expect(corner).toEqual([...sentinel.rgb, 255])
      expect(sentinelPixels(underTest)).toBe(8)
      // Still wrong, and wrong in exactly one place: the two paint blocks. Every protected pixel —
      // everything the paint never touched — matches the restored frame exactly, which is the part a
      // sentinel count could never tell apart from an erased screen (@dev/7 peer read, 34129).
      expect(differingPixels(underTest, expectedRestored)).toEqual(blockPixels(painted))
    } else {
      expect(corner).not.toEqual([...sentinel.rgb, 255])
      expect(sentinelPixels(underTest)).toBe(0)
      // A truly restored full frame: identical to the expected state everywhere, not merely free of ink.
      expect(differingPixels(underTest, expectedRestored)).toEqual([])
    }
  },
)

test("a frame without this read's painted cells refuses by name, and both cells are restored (33000)", async () => {
  const frame = windowAt({ x: 2, y: 2 }, { painted: false })
  const painted = source()
  await expect(
    readThroughSentinel({
      source: painted.source,
      prePaint: async () => frame,
      capture: async (resolve) => resolve({ frame, pixelGeometry }),
      label: "cells 1,1-2,2",
      sentinel,
      regions: [cells],
      reading: { x: 2, y: 2 },
      cell: { width: 2, height: 2 },
      deadline: Date.now() + 50,
    }),
  ).rejects.toThrow(
    `cells 1,1-2,2: no cell changed to the sentinel colour at ${WHERE} between the frames this read compared, so its crop cannot be anchored`,
  )
  // Each attempt paints both cells; each retry clears first, so the frame it re-takes is a pre-paint frame.
  expect(painted.writes[0]).toBe(PAINT)
  expect(painted.writes.at(-1)).toBe(CLEAR)
  expect(painted.writes.filter((write) => write !== PAINT && write !== CLEAR)).toEqual([])
  expect(painted.writes.length % 2).toBe(0)
})

test("the pair is painted clear of the probe's own output when the read names it (33985)", async () => {
  // An image row compares one interior cell of a block it draws; every cell next to that interior lies
  // under the image, which Warp draws over text, so the pair must go outside the whole block.
  const writes: string[] = []
  const failure = new Error("stop after the paint")
  await expect(
    readThroughSentinel({
      source: { rows: 8, cols: 8, write: (text: string) => writes.push(text) },
      prePaint: async () => before({ x: 0, y: 0 }),
      capture: async () => {
        throw failure
      },
      label: "cells 2,2-2,2",
      sentinel,
      regions: [{ top: 2, left: 2, bottom: 2, right: 2 }],
      avoid: { top: 1, left: 1, bottom: 3, right: 3 },
      reading: { x: 0, y: 0 },
      cell: { width: 2, height: 2 },
      deadline: Date.now() + 1_000,
    }),
  ).rejects.toBe(failure)
  // The pair this frame and this avoid footprint imply, spelled by the same helpers the read
  // writes with: nothing of it lands on the image block.
  const picked = sentinelCellsInFrame({
    ...before({ x: 0, y: 0 }),
    reading: { x: 0, y: 0 },
    cell: { width: pixelGeometry.cellWidth, height: pixelGeometry.cellHeight },
    grid: { rows: 8, cols: 8 },
    regions: [{ top: 2, left: 2, bottom: 2, right: 2 }],
    avoid: [{ top: 1, left: 1, bottom: 3, right: 3 }],
  })
  expect(writes).toEqual([paintOf(picked), clearOf(picked)])
})

test("a capture that fails for its own reason still restores both cells, and keeps its own error (33000)", async () => {
  const painted = source()
  const failure = new Error("the window went away")
  await expect(
    readThroughSentinel({
      source: painted.source,
      prePaint: async () => before({ x: 0, y: 0 }),
      capture: async () => {
        throw failure
      },
      label: "cells 1,1-2,2",
      sentinel,
      regions: [cells],
      reading: { x: 0, y: 0 },
      cell: { width: 2, height: 2 },
      deadline: Date.now() + 1_000,
    }),
  ).rejects.toBe(failure)
  expect(painted.writes).toEqual([PAINT, CLEAR])
})

test("a sentinel pair that never appears refuses at the read's deadline and still restores (33000)", async () => {
  const painted = source()
  const blank: CapturedFrame = { width: 16, height: 12, rgba: new Uint8Array(16 * 12 * 4).fill(255) }
  // A frame with no ink anywhere: the chooser's first two all-background cells, which is where this
  // read paints and what its refusal must name (33981).
  const picked = sentinelCellsInFrame({
    ...blank,
    reading: { x: 0, y: 0 },
    cell: { width: pixelGeometry.cellWidth, height: pixelGeometry.cellHeight },
    grid,
    regions: [cells],
  })
  let captures = 0
  await expect(
    readThroughSentinel({
      source: painted.source,
      prePaint: async () => blank,
      capture: async (resolve) => {
        captures += 1
        return resolve({ frame: blank, pixelGeometry })
      },
      label: "cells 1,1-2,2",
      sentinel,
      regions: [cells],
      reading: { x: 0, y: 0 },
      cell: { width: 2, height: 2 },
      deadline: Date.now() - 1,
    }),
  ).rejects.toThrow(
    new RegExp(
      `no cell changed to the sentinel colour at cells ${picked.a.row},${picked.a.col} and ${picked.b.row},${picked.b.col}`,
    ),
  )
  expect(captures).toBe(1)
  expect(painted.writes).toEqual([paintOf(picked), clearOf(picked)])
})

// 34015, @dev/10 residual: the clause has to reach the basis this read RETURNS, not just the pure
// function's return. One pixel knocked out of the second witness box is exactly the case a rendered
// cell produces — an anti-aliased corner or the read's own restored pixel — and it must anchor here
// and say so, rather than refusing or anchoring silently.
test("a witness box one pixel short of its area anchors the read and says so in the basis it returns (34015)", async () => {
  const drawnAt = { x: 2, y: 2 }
  const frame = windowAt(drawnAt)
  // Back to the probe's own pattern in b's bottom-right pixel: 3 of the box's 4 pixels carry the colour.
  const boxX = drawnAt.x + (chosenPair.b.col - 1) * 2
  const boxY = drawnAt.y + (chosenPair.b.row - 1) * 2
  frame.rgba.set([1, 2, 90, 255], ((boxY + 1) * 16 + (boxX + 1)) * 4)
  const origin = await readThroughSentinel({
    source: source().source,
    prePaint: async () => before(drawnAt),
    capture: async (resolve) => resolve({ frame, pixelGeometry }),
    label: "cells 1,1-2,2",
    sentinel,
    regions: [cells],
    reading: drawnAt,
    cell: { width: pixelGeometry.cellWidth, height: pixelGeometry.cellHeight },
    deadline: Date.now() + 1_000,
  })
  expect(origin.origin).toEqual(drawnAt)
  expect(origin.basis).toContain("sentinel box accepted short of its area (3 of 4 px)")
})

/**
 * 34163: a read taken while the probe HOLDS its viewport above the bottom. The pair still lands where
 * the terminal put it — `shift` px off the settled grid — which is exactly what used to become the
 * crop origin and push the rectangle out of the window. `cell` lets a test use a pitch bigger than the
 * blend slack, so a shift that is not a whole number of rows is expressible at all.
 */
/** The same frame with ink on the two selected cells, so they are provably not clear. */
function inkedAtSelectedCells(
  frame: CapturedFrame,
  pair: { a: { row: number; col: number }; b: { row: number; col: number } },
  cell: { width: number; height: number },
  size: { width: number; height: number },
): CapturedFrame {
  const rgba = new Uint8Array(frame.rgba)
  for (const at of [pair.a, pair.b]) {
    for (let dy = 0; dy < cell.height; dy += 1) {
      for (let dx = 0; dx < cell.width; dx += 1) {
        const x = (at.col - 1) * cell.width + dx
        const y = (at.row - 1) * cell.height + dy
        if (x < 0 || y < 0 || x >= size.width || y >= size.height) continue
        rgba.set([250, 250, 250, 255], (y * size.width + x) * 4)
      }
    }
  }
  return { ...frame, rgba }
}

function heldWindow(input: {
  origin: { x: number; y: number }
  shift: { x?: number; y?: number }
  cell?: { width: number; height: number }
  size?: { width: number; height: number }
  /** False for the frame taken BEFORE this read paints (33981). */
  painted?: boolean
  /** The cells the read will paint, when they differ from `chosenPair`'s 2x2-cell answer. */
  pair?: { a: { row: number; col: number }; b: { row: number; col: number } }
}): CapturedFrame {
  const cell = input.cell ?? { width: 2, height: 2 }
  const size = input.size ?? { width: 16, height: 12 }
  const rgba = new Uint8Array(size.width * size.height * 4)
  for (let offset = 3; offset < rgba.length; offset += 4) rgba[offset] = 255
  const paintAt = (x: number, y: number, colour: readonly number[]) => {
    if (x < 0 || y < 0 || x >= size.width || y >= size.height) return
    rgba.set(colour, (y * size.width + x) * 4)
  }
  // The digested cells carry the same pattern as `before`, so the difference sees ONLY the pair.
  for (let row = cells.top; row <= cells.bottom; row += 1) {
    for (let col = cells.left; col <= cells.right; col += 1) {
      for (let dy = 0; dy < cell.height; dy += 1) {
        for (let dx = 0; dx < cell.width; dx += 1) {
          paintAt(input.origin.x + (col - 1) * cell.width + dx, input.origin.y + (row - 1) * cell.height + dy, [
            (row * 40 + dy * 7) % 256,
            (col * 50 + dx * 11) % 256,
            90,
            255,
          ])
        }
      }
    }
  }
  for (const cellRef of input.painted === false ? [] : [(input.pair ?? chosenPair).a, (input.pair ?? chosenPair).b]) {
    for (let dy = 0; dy < cell.height; dy += 1) {
      for (let dx = 0; dx < cell.width; dx += 1) {
        paintAt(
          input.origin.x + (cellRef.col - 1) * cell.width + dx + (input.shift.x ?? 0),
          input.origin.y + (cellRef.row - 1) * cell.height + dy + (input.shift.y ?? 0),
          [...sentinel.rgb, 255],
        )
      }
    }
  }
  const frame = { width: size.width, height: size.height, rgba }
  textOriginOf.set(frame, input.origin)
  return frame
}

/** A settled origin the route measured before this read, as `serve.ts` forwards it (34163, 34480). */
function settledAt(
  origin: { x: number; y: number },
  geometry = pixelGeometry,
): {
  origin: { x: number; y: number }
  basis: string
  basisKind: string
  pixelGeometry: typeof pixelGeometry
  paintClasses: {
    background: { anchor: readonly [number, number, number]; members: ReadonlySet<number> }
    sentinel: { anchor: readonly [number, number, number]; members: ReadonlySet<number> }
  }
} {
  const [sr, sg, sb] = sentinel.rgb
  return {
    origin,
    basis: "measured by complete raster calibration",
    basisKind: "complete raster calibration",
    pixelGeometry: geometry,
    paintClasses: {
      background: { anchor: [0, 0, 0], members: new Set([0]) },
      sentinel: { anchor: [sr, sg, sb], members: new Set([(sr << 16) | (sg << 8) | sb]) },
    },
  }
}

/** One read against a held window with a settle already known; `deadline` past means no retry hides the reason. */
async function heldRead(input: {
  frame: CapturedFrame
  prePaint: CapturedFrame
  settled?: ReturnType<typeof settledAt> | undefined
  scroll?: { direction: "up" | "down"; notches: number; rows?: number; maxRows: number }
  base?: { label: string; origin: { x: number; y: number } }
  witnessShift?: { rows: number; columns: number; unique: boolean }
  geometry?: typeof pixelGeometry
  cell?: { width: number; height: number }
}) {
  // 33981: the cells are chosen against the frame this run actually showed, so the read's `reading`
  // is the PRE-PAINT fixture's origin. A fixture that never recorded one is a broken fixture, not a
  // reason to guess an origin.
  const reading = textOriginOf.get(input.prePaint)
  if (reading === undefined) {
    throw new Error("heldRead: the pre-paint fixture did not record the text origin it was built at")
  }
  const cell = input.cell ?? { width: pixelGeometry.cellWidth, height: pixelGeometry.cellHeight }
  const painted = source()
  return readThroughSentinel({
    source: painted.source,
    prePaint: async () => input.prePaint,
    capture: async (resolve) => resolve({ frame: input.frame, pixelGeometry: input.geometry ?? pixelGeometry }),
    label: "cells 1,1-2,2",
    sentinel,
    regions: [cells],
    reading,
    cell,
    ...(input.settled !== undefined ? { settled: input.settled } : {}),
    ...(input.scroll !== undefined ? { scroll: input.scroll } : {}),
    ...(input.base !== undefined ? { base: input.base } : {}),
    ...(input.witnessShift !== undefined ? { witnessShift: input.witnessShift } : {}),
    deadline: Date.now() - 1,
  })
}

test("every declared hold is unresolved and claims no origin (34163, @cto smaller ruling)", async () => {
  const origin = { x: 2, y: 2 }
  await expect(
    heldRead({
      frame: heldWindow({ origin, shift: { y: 2 } }),
      prePaint: before(origin),
      settled: settledAt(origin),
      scroll: { direction: "up", notches: 1, maxRows: 4 },
    }),
  ).rejects.toMatchObject({ name: "CaptureHoldUnresolved" })
})

test("a declared hold whose pair lands on the settled origin is still unresolved, never an observation (34163, @cto smaller ruling)", async () => {
  const origin = { x: 2, y: 2 }
  await expect(
    heldRead({
      frame: heldWindow({ origin, shift: {} }),
      prePaint: before(origin),
      settled: settledAt(origin),
      scroll: { direction: "up", notches: 1, maxRows: 4 },
    }),
  ).rejects.toThrow(/a declared hold is not read until the rows it moves are established independently/)
})

// @cto, 33981: the hold guard stood aside for a declared hold, and with `settled` absent that meant a
// held read fell through to an ORIGIN derived from the pair, unguarded. A declared hold now refuses
// before the pair is asked anything, so the holes are the same whatever the route settled.
test("a declared hold with no settled origin is unresolved too, never an origin from the pair (33981)", async () => {
  const origin = { x: 2, y: 2 }
  await expect(
    heldRead({
      frame: heldWindow({ origin, shift: { y: 2 } }),
      prePaint: before(origin),
      scroll: { direction: "up", notches: 1, maxRows: 4 },
    }),
  ).rejects.toMatchObject({ name: "CaptureHoldUnresolved" })
})

test("a declared hold that moved the pair sideways is unresolved by the same rule, not graded (34163)", async () => {
  const origin = { x: 2, y: 2 }
  await expect(
    heldRead({
      frame: heldWindow({ origin, shift: { x: 4 } }),
      prePaint: before(origin),
      settled: settledAt(origin),
      scroll: { direction: "up", notches: 1, maxRows: 4 },
    }),
  ).rejects.toMatchObject({ name: "CaptureHoldUnresolved" })
})

// @cto's condition on the 33981 x 34163 composition: the cells were chosen against a frame at
// `reading`, so a frame that moves afterwards puts them somewhere else — a chosen cell can end up on
// ink the read never saw, and the paint then covers it. That harm is INVISIBLE after the fact (the
// sentinel colour sits where the ink was), which is precisely why the pair may not be trusted to
// carry the read's origin: a re-anchor computed from it is a crop nobody can vouch for. So the read
// refuses BY NAME. The displacement here is two whole rows of a 2x6 cell, well past the blend slack,
// so no tolerance can absorb it.
test("refuses by name when the frame moved out from under the cells it chose, and never re-anchors (33981 x 34163)", async () => {
  const cell = { width: 2, height: 6 }
  const size = { width: 16, height: 30 }
  const geometry = { cellWidth: 2, cellHeight: 6, textWidth: 12, textHeight: 24 }
  const painted = pairOnBlankFrame(grid, [cells], cell)
  // One whole row (6 px) of displacement: past the 2 px blend slack, and inside the 30 px frame.
  const moved = heldWindow({ origin: { x: 0, y: 0 }, shift: { y: 6 }, cell, size, pair: painted })
  // The shipped bound is 0 (@cto, d1a8cb1c), so a moved frame with a quiet surface is ACCEPTED now.
  // One non-sentinel pixel in the far corner of the moved grid — outside the digested cells and both
  // poses — keeps this a refusal fixture instead, which is what its message and evidence are about.
  moved.rgba.set([0, 0, 255, 255], ((size.height - 1) * size.width + (geometry.textWidth - 1)) * 4)
  const writes = source()
  const read = () =>
    readThroughSentinel({
      source: writes.source,
      prePaint: async () => heldWindow({ origin: { x: 0, y: 0 }, shift: {}, cell, size, painted: false }),
      capture: async (resolve) => resolve({ frame: moved, pixelGeometry: geometry }),
      label: "cells 1,1-2,2",
      sentinel,
      regions: [cells],
      reading: { x: 0, y: 0 },
      cell,
      settled: settledAt({ x: 0, y: 0 }, geometry),
      // Past the deadline: nothing may retry into a pass, and no retry may repaint those cells.
      deadline: Date.now() - 1,
    })
  await expect(read()).rejects.toMatchObject({ name: "SentinelFrameMoved" })
  await expect(read()).rejects.toThrow(
    /the frame moved after cells .* were chosen at 0,0 .* the pair landed 0,6 px from it/,
  )
  // Not a re-anchor: the refusal says so in words, so no caller can read it as one.
  await expect(read()).rejects.toThrow(/will not re-anchor from a pair that may have covered ink/)
})

// The refusal is the only record a moved read leaves: it throws before any frame is written. So the
// evidence it measured has to travel on the error itself, and a whole-row displacement has to arrive
// as rows rather than as a pixel count a later step would divide again (33982, @cto's step 1).
test("a moved read carries the count it measured and names a whole-row shift in rows (33982)", async () => {
  const cell = { width: 2, height: 6 }
  const size = { width: 16, height: 30 }
  const geometry = { cellWidth: 2, cellHeight: 6, textWidth: 12, textHeight: 24 }
  const painted = pairOnBlankFrame(grid, [cells], cell)
  const moved = heldWindow({ origin: { x: 0, y: 0 }, shift: { y: 6 }, cell, size, pair: painted })
  // Same one-pixel noise as the refusal above: at the shipped bound of 0 this read must still refuse
  // for its evidence to exist at all (33982, @cto's d1a8cb1c).
  moved.rgba.set([0, 0, 255, 255], ((size.height - 1) * size.width + (geometry.textWidth - 1)) * 4)
  const writes = source()
  const error = await readThroughSentinel({
    source: writes.source,
    prePaint: async () => heldWindow({ origin: { x: 0, y: 0 }, shift: {}, cell, size, painted: false }),
    capture: async (resolve) => resolve({ frame: moved, pixelGeometry: geometry }),
    label: "cells 1,1-2,2",
    sentinel,
    regions: [cells],
    reading: { x: 0, y: 0 },
    cell,
    settled: settledAt({ x: 0, y: 0 }, geometry),
    deadline: Date.now() - 1,
  }).catch((failure: unknown) => failure as SentinelFrameMoved)
  expect(error).toBeInstanceOf(SentinelFrameMoved)
  if (!(error instanceof SentinelFrameMoved)) throw new Error("unreachable: the read did not refuse by name")
  expect(typeof error.changedOutside).toBe("number")
  expect(error.rowShift).toEqual({ rows: 1, px: 6 })
})

// Condition 3 is a number nobody has measured yet, so the accept path only fires when one is
// supplied. These two say what it accepts when it has one, and what it still refuses with a
// generous one in hand — the difference is the cells, not the bound.
test("a whole-row move is accepted once a measured bound is supplied and the cells were clear (33982)", async () => {
  const cell = { width: 2, height: 6 }
  const size = { width: 16, height: 30 }
  const geometry = { cellWidth: 2, cellHeight: 6, textWidth: 12, textHeight: 24 }
  const painted = pairOnBlankFrame(grid, [cells], cell)
  const moved = heldWindow({ origin: { x: 0, y: 0 }, shift: { y: 6 }, cell, size, pair: painted })
  const writes = source()
  const result = await readThroughSentinel({
    source: writes.source,
    prePaint: async () => heldWindow({ origin: { x: 0, y: 0 }, shift: {}, cell, size, painted: false }),
    capture: async (resolve) => resolve({ frame: moved, pixelGeometry: geometry }),
    label: "cells 1,1-2,2",
    sentinel,
    regions: [cells],
    reading: { x: 0, y: 0 },
    cell,
    settled: settledAt({ x: 0, y: 0 }, geometry),
    noiseBound: 4096,
    deadline: Date.now() - 1,
  })
  // The origin is where the pair actually landed, and the basis says why that is legitimate.
  expect(result.origin).toEqual({ x: 0, y: 6 })
  // The shift travels as DATA; the prose goes beside `basis`, never into it, because a comparison
  // across a row's frames reads `basis` and a per-frame sentence would stop it (@cto).
  expect(result.acceptedRowMove).toEqual({ rows: 1, px: 6 })
  expect(result.basisDetail).toContain("moved 1 whole rows")
  expect(result.basis).not.toContain("moved 1 whole rows")
  expect(result.changedOutside).toEqual(expect.any(Number))
})

// Zero is the SHIPPED bound (@cto, d1a8cb1c), so the accept path has to fire on the measured case
// with nothing supplied by the caller. A path that only works when a test hands it a number is dead
// code in production, and the six measured zeros would then say nothing about what runs.
test("the shipped bound of 0 admits the measured whole-row move without any caller input (33982)", async () => {
  const cell = { width: 2, height: 6 }
  const size = { width: 16, height: 30 }
  const geometry = { cellWidth: 2, cellHeight: 6, textWidth: 12, textHeight: 24 }
  const painted = pairOnBlankFrame(grid, [cells], cell)
  const moved = heldWindow({ origin: { x: 0, y: 0 }, shift: { y: 6 }, cell, size, pair: painted })
  const writes = source()
  const result = await readThroughSentinel({
    source: writes.source,
    prePaint: async () => heldWindow({ origin: { x: 0, y: 0 }, shift: {}, cell, size, painted: false }),
    capture: async (resolve) => resolve({ frame: moved, pixelGeometry: geometry }),
    label: "cells 1,1-2,2",
    sentinel,
    regions: [cells],
    reading: { x: 0, y: 0 },
    cell,
    settled: settledAt({ x: 0, y: 0 }, geometry),
    deadline: Date.now() - 1,
  })
  expect(result.origin).toEqual({ x: 0, y: 6 })
  expect(result.acceptedRowMove).toEqual({ rows: 1, px: 6 })
  // The measured case: not one pixel outside the painted pair changed.
  expect(result.changedOutside).toBe(0)
})

// The bound is a LIMIT, not a tolerance: one real pixel of noise outside the pair is the smallest
// thing a distribution could ever ask this number to forgive, and at the shipped value it still
// refuses. This is @cto's item 2 — the path may refuse too much, never too much other than that.
test("one changed pixel outside the pair still refuses at the shipped bound of 0 (33982)", async () => {
  const cell = { width: 2, height: 6 }
  const size = { width: 16, height: 30 }
  const geometry = { cellWidth: 2, cellHeight: 6, textWidth: 12, textHeight: 24 }
  const painted = pairOnBlankFrame(grid, [cells], cell)
  const moved = heldWindow({ origin: { x: 0, y: 0 }, shift: { y: 6 }, cell, size, pair: painted })
  // The far corner of the moved grid: outside the digested cells, outside both painted cells at either
  // pose. The pre-paint fixture leaves it black, and this is not the sentinel colour, so it counts as noise.
  moved.rgba.set([0, 0, 255, 255], ((size.height - 1) * size.width + (geometry.textWidth - 1)) * 4)
  const writes = source()
  const error = await readThroughSentinel({
    source: writes.source,
    prePaint: async () => heldWindow({ origin: { x: 0, y: 0 }, shift: {}, cell, size, painted: false }),
    capture: async (resolve) => resolve({ frame: moved, pixelGeometry: geometry }),
    label: "cells 1,1-2,2",
    sentinel,
    regions: [cells],
    reading: { x: 0, y: 0 },
    cell,
    settled: settledAt({ x: 0, y: 0 }, geometry),
    deadline: Date.now() - 1,
  }).catch((failure: unknown) => failure as SentinelFrameMoved)
  expect(error).toBeInstanceOf(SentinelFrameMoved)
  if (!(error instanceof SentinelFrameMoved)) throw new Error("unreachable: the read did not refuse by name")
  expect(error.changedOutside).toBe(1)
  expect(error.rowShift).toEqual({ rows: 1, px: 6 })
})

test("a one-row pair passes the pitch check, so the accept path must refuse it by its own guard (33982)", () => {
  // The chooser never paints both cells on one row, so this can only arrive from a hand-built or
  // fixture-recorded crop. The point of the test is the ORDER of the two questions: witnessProvesPitch
  // against the crop itself passes on the column gap alone, and gridMoveExemption refuses such a pair
  // outright (pairMeasuredNoRowHeight). The accept path must agree with that refusal, which is why it
  // tests the pair's row height before the pitch (@cto item 3).
  const oneRowCrop: PixelCellCrop = {
    origin: { x: 0, y: 0 },
    basis: "fixture",
    cell: { width: 2, height: 6 },
    grid: { columns: 6, rows: 4 },
    image: { width: 16, height: 30 },
    witness: {
      a: { cell: { row: 1, col: 1 }, box: { x: 0, y: 0 } },
      b: { cell: { row: 1, col: 2 }, box: { x: 2, y: 0 } },
    },
  }
  expect(pairMeasuredNoRowHeight(oneRowCrop)).toBe(true)
  // …and the pitch predicate alone would let it through, which is the hole the guard closes.
  expect(witnessProvesPitch(oneRowCrop, oneRowCrop)).toBe(true)
  expect(
    gridMoveExemption([{ role: "seed", crop: oneRowCrop, rectangle: { x: 0, y: 0, width: 16, height: 30 } }]),
  ).toEqual([])
})

test("the clear-before-paint predicate says no when ink was already on the cells (33982)", () => {
  const cell = { width: 2, height: 6 }
  const size = { width: 16, height: 30 }
  const painted = pairOnBlankFrame(grid, [cells], cell)
  const blank = heldWindow({ origin: { x: 0, y: 0 }, shift: {}, cell, size, painted: false })
  const asked = { reading: { x: 0, y: 0 }, cell, columns: grid.cols, cells: [painted.a, painted.b] }
  expect(pairClearBeforePaint({ before: blank, ...asked })).toBe(true)
  // The same frame with ink on those two cells: clear is a fact about the pixels, and this is the
  // fact the accept path may never assume.
  expect(pairClearBeforePaint({ before: inkedAtSelectedCells(blank, painted, cell, size), ...asked })).toBe(false)
})

test("the clear-before-paint predicate asks at the LANDING pose, not the chosen one (33982, @cto)", () => {
  const cell = { width: 2, height: 6 }
  const size = { width: 16, height: 30 }
  const painted = pairOnBlankFrame(grid, [cells], cell)
  const blank = heldWindow({ origin: { x: 0, y: 0 }, shift: {}, cell, size, painted: false })
  // Ink exactly where the pair would land after a two-row move. Two rows, not one, so the landing
  // cells and the chosen cells do not overlap: otherwise the ink would be under the chosen cells too
  // and the test could not tell the two poses apart.
  const landed = inkedAtSelectedCells(
    blank,
    {
      a: { row: painted.a.row + 2, col: painted.a.col },
      b: { row: painted.b.row + 2, col: painted.b.col },
    },
    cell,
    size,
  )
  const asked = { before: landed, cell, columns: grid.cols, cells: [painted.a, painted.b] }
  // At the CHOSEN pose those cells are still blank — which is why asking there can only say yes and
  // proves nothing about the frame the read painted over.
  expect(pairClearBeforePaint({ ...asked, reading: { x: 0, y: 0 } })).toBe(true)
  // At the LANDING pose the ink is under the pair, and that is the question the accept path asks.
  expect(pairClearBeforePaint({ ...asked, reading: { x: 0, y: 2 * cell.height } })).toBe(false)
})

test("a displacement that is not a whole number of rows names no row shift, rather than a fraction (33982)", async () => {
  const cell = { width: 2, height: 6 }
  const size = { width: 16, height: 30 }
  const geometry = { cellWidth: 2, cellHeight: 6, textWidth: 12, textHeight: 24 }
  const painted = pairOnBlankFrame(grid, [cells], cell)
  // Three pixels of a six-pixel cell: past the blend slack, and not a row anyone can align to.
  const moved = heldWindow({ origin: { x: 0, y: 0 }, shift: { y: 3 }, cell, size, pair: painted })
  const writes = source()
  const error = await readThroughSentinel({
    source: writes.source,
    prePaint: async () => heldWindow({ origin: { x: 0, y: 0 }, shift: {}, cell, size, painted: false }),
    capture: async (resolve) => resolve({ frame: moved, pixelGeometry: geometry }),
    label: "cells 1,1-2,2",
    sentinel,
    regions: [cells],
    reading: { x: 0, y: 0 },
    cell,
    settled: settledAt({ x: 0, y: 0 }, geometry),
    deadline: Date.now() - 1,
  }).catch((failure: unknown) => failure as SentinelFrameMoved)
  expect(error).toBeInstanceOf(SentinelFrameMoved)
  if (!(error instanceof SentinelFrameMoved)) throw new Error("unreachable: the read did not refuse by name")
  expect(error.rowShift).toBeUndefined()
})

test("an ordinary read crops at the settled origin and is not called a re-anchor (34163, @cto)", async () => {
  const origin = { x: 2, y: 2 }
  const result = await heldRead({
    frame: heldWindow({ origin, shift: {} }),
    prePaint: heldWindow({ origin, shift: {}, painted: false }),
    settled: settledAt(origin),
  })
  expect(result.origin).toEqual(origin)
  expect(result.scrolledRows).toBeUndefined()
  expect(result.basis).toContain("the pair landed on the settled calibrated origin, which is where this read crops")
  expect(result.basis).not.toContain("re-anchored")
})

test("a read within the sentinel box slack of the settled origin is an ordinary read (34163, @cto)", async () => {
  const origin = { x: 2, y: 2 }
  const result = await heldRead({
    frame: heldWindow({ origin, shift: { x: 1 } }),
    prePaint: heldWindow({ origin, shift: {}, painted: false }),
    settled: settledAt(origin),
  })
  expect(result.origin).toEqual(origin)
  expect(result.basis).toContain("the pair landed on the settled calibrated origin")
})

// The production contract (@cto 2026-11-13, ruling 4): a capture adapter hands the read a
// `{frame, ...}` result and calls the resolver IT was given, so the origin the route uses is the one
// this resolver returns. Both cases below run through that exact shape, which is the boundary the
// direct-resolver tests above cannot see.
test("the adapter boundary keeps the {frame} result shape and refuses a declared hold there (34163, @cto 4)", async () => {
  const origin = { x: 2, y: 2 }
  const painted = source()
  let resolved: { x: number; y: number } | undefined
  const adapter = () => ({
    source: painted.source,
    prePaint: async () => before(origin),
    // The real adapter calls the resolver it is handed, then returns a frame: the origin never
    // rides at the top level of the result.
    capture: async (resolve: OriginResolver) => {
      resolved = (await Promise.resolve(resolve({ frame: heldWindow({ origin, shift: { y: 2 } }), pixelGeometry })))
        .origin
      return {
        frame: { role: "control" as const, label: "cells 1,1-2,2", capturedAt: 1, ref: "sha256:" + "a".repeat(64) },
        trace: {},
      }
    },
    label: "cells 1,1-2,2" as const,
    sentinel,
    regions: [cells],
    // 33981: the cells are chosen against a frame at this origin, so the read needs it and the cell.
    reading: origin,
    cell: { width: pixelGeometry.cellWidth, height: pixelGeometry.cellHeight },
    settled: settledAt(origin),
    deadline: Date.now() - 1,
  })
  const result = await readThroughSentinel(adapter())
  // A 2 px displacement on a 2 px cell is inside the blend slack, so this is the ordinary case: the
  // pair sits on the settled origin and the route crops there. A displacement past the slack is the
  // moved-read refusal, which the test below this one pins by name.
  expect(resolved).toEqual({ x: 2, y: 2 })
  expect(result).toHaveProperty("frame")
  expect(result as Record<string, unknown>).not.toHaveProperty("origin")
  await expect(
    readThroughSentinel({ ...adapter(), scroll: { direction: "up" as const, notches: 1, maxRows: 4 } }),
  ).rejects.toMatchObject({ name: "CaptureHoldUnresolved" })
})

test("serve's chooser regions keep a blank or inked pre-paint frame from writing inside keep-clear rows (34240)", async () => {
  const dims = { rows: 8, cols: 10 }
  const cell = { width: pixelGeometry.cellWidth, height: pixelGeometry.cellHeight }
  const keepClear = [
    { top: 1, left: 1, bottom: 1, right: 8 },
    { top: 3, left: 1, bottom: 3, right: 8 },
  ]
  const regions = chooserRegions({
    cells: { top: 2, left: 2, bottom: 2, right: 5 },
    keepClear,
  })
  expect(regions).toEqual([{ top: 2, left: 2, bottom: 2, right: 5 }, ...keepClear])
  const inked = blankFrame(dims, cell)
  const ink = 0xc1e3fe
  for (const region of keepClear) {
    for (let row = region.top; row <= region.bottom; row += 1) {
      for (let col = region.left; col <= region.right; col += 1) {
        for (let y = 0; y < cell.height; y += 1) {
          for (let x = 0; x < cell.width; x += 1) {
            const offset = (((row - 1) * cell.height + y) * inked.width + (col - 1) * cell.width + x) * 4
            inked.rgba[offset] = (ink >> 16) & 0xff
            inked.rgba[offset + 1] = (ink >> 8) & 0xff
            inked.rgba[offset + 2] = ink & 0xff
            inked.rgba[offset + 3] = 0xff
          }
        }
      }
    }
  }
  for (const frame of [blankFrame(dims, cell), inked]) {
    const painted = source(dims)
    await readThroughSentinel({
      source: painted.source,
      prePaint: async () => frame,
      capture: async (resolve) => resolve({ frame, pixelGeometry }),
      label: "keep-clear",
      sentinel,
      regions,
      reading: { x: 0, y: 0 },
      cell,
      deadline: Date.now(),
    }).catch(() => undefined)
    const addressed = painted.writes.flatMap((write) =>
      [...write.matchAll(/\x1b\[(\d+);(\d+)H/g)].map((match) => ({
        row: Number(match[1]),
        col: Number(match[2]),
      })),
    )
    expect(addressed.length).toBeGreaterThan(0)
    for (const cellAt of addressed) {
      for (const region of keepClear) {
        const inside =
          cellAt.row >= region.top &&
          cellAt.row <= region.bottom &&
          cellAt.col >= region.left &&
          cellAt.col <= region.right
        expect(inside).toBe(false)
      }
    }
  }
})

const packRgbTest = (r: number, g: number, b: number) => (r << 16) | (g << 8) | b

function buildDitheredSentinelFixture() {
  const bgAnchor: readonly [number, number, number] = [32, 35, 45]
  const sentinelAnchor: readonly [number, number, number] = [163, 117, 196]
  const bgTriples: ReadonlyArray<readonly [number, number, number]> = [
    [32, 35, 45],
    [31, 35, 45],
    [33, 35, 45],
    [32, 34, 45],
    [32, 36, 45],
    [32, 35, 44],
    [32, 35, 46],
    [31, 36, 45],
  ]
  const sentinelTriples: ReadonlyArray<readonly [number, number, number]> = [
    [163, 117, 196],
    [162, 117, 196],
    [164, 117, 196],
    [163, 116, 196],
    [163, 118, 196],
    [163, 117, 195],
    [163, 117, 197],
    [162, 118, 196],
  ]
  const paintClasses = {
    background: {
      anchor: bgAnchor,
      members: new Set(bgTriples.map(([r, g, b]) => packRgbTest(r, g, b))),
    },
    sentinel: {
      anchor: sentinelAnchor,
      members: new Set(sentinelTriples.map(([r, g, b]) => packRgbTest(r, g, b))),
    },
  }
  const makeFrame = (
    origin: { x: number; y: number },
    opts: {
      painted?: boolean
      pair?: { a: { row: number; col: number }; b: { row: number; col: number } }
      size?: { width: number; height: number }
      cell?: { width: number; height: number }
    } = {},
  ): CapturedFrame => {
    const size = opts.size ?? { width: 16, height: 12 }
    const cellSize = opts.cell ?? { width: 2, height: 2 }
    const rgba = new Uint8Array(size.width * size.height * 4)
    for (let y = 0; y < size.height; y++) {
      for (let x = 0; x < size.width; x++) {
        const [r, g, b] = bgTriples[(x * 3 + y * 5) % bgTriples.length]!
        rgba.set([r, g, b, 255], (y * size.width + x) * 4)
      }
    }
    const paintAt = (x: number, y: number, colour: readonly number[]) => {
      if (x < 0 || y < 0 || x >= size.width || y >= size.height) return
      rgba.set(colour, (y * size.width + x) * 4)
    }
    for (let row = cells.top; row <= cells.bottom; row++) {
      for (let col = cells.left; col <= cells.right; col++) {
        for (let dy = 0; dy < cellSize.height; dy++) {
          for (let dx = 0; dx < cellSize.width; dx++) {
            paintAt(origin.x + (col - 1) * cellSize.width + dx, origin.y + (row - 1) * cellSize.height + dy, [
              (row * 40 + dy * 7) % 256,
              (col * 50 + dx * 11) % 256,
              90,
              255,
            ])
          }
        }
      }
    }
    if (opts.painted ?? true) {
      const targetPair = opts.pair ?? chosenPair
      for (const atCell of [targetPair.a, targetPair.b]) {
        for (let dy = 0; dy < cellSize.height; dy++) {
          for (let dx = 0; dx < cellSize.width; dx++) {
            const x = origin.x + (atCell.col - 1) * cellSize.width + dx
            const y = origin.y + (atCell.row - 1) * cellSize.height + dy
            const [r, g, b] = sentinelTriples[(x + y * 3) % sentinelTriples.length]!
            paintAt(x, y, [r, g, b, 255])
          }
        }
      }
    }
    return { width: size.width, height: size.height, rgba }
  }
  return { paintClasses, sentinelSpec: { form: "basic" as const, rgb: sentinelAnchor }, makeFrame }
}

test("readThroughSentinel anchors on dithered occupied background and sentinel paintClasses without mutating raw buffers (34480)", async () => {
  const { paintClasses, sentinelSpec, makeFrame } = buildDitheredSentinelFixture()
  const origin = { x: 2, y: 2 }
  const prePaintFrame = makeFrame(origin, { painted: false })
  const prePaintSnapshot = new Uint8Array(prePaintFrame.rgba)
  const paintedFrame = makeFrame(origin, { painted: true })
  const paintedSnapshot = new Uint8Array(paintedFrame.rgba)
  const writes = source()
  const result = await readThroughSentinel({
    source: writes.source,
    prePaint: async () => prePaintFrame,
    capture: async (resolve) => resolve({ frame: paintedFrame, pixelGeometry }),
    label: "dithered-sentinel-ok",
    sentinel: sentinelSpec,
    regions: [cells],
    reading: origin,
    cell: { width: 2, height: 2 },
    settled: {
      ...settledAt(origin),
      paintClasses,
    },
    deadline: Date.now() + 1_000,
  })
  expect(result.origin).toEqual(origin)
  expect(result.changedOutside).toBe(0)
  expect(prePaintFrame.rgba).toEqual(prePaintSnapshot)
  expect(paintedFrame.rgba).toEqual(paintedSnapshot)
  expect(writes.writes).toEqual([paintOf(chosenPair), clearOf(chosenPair)])
})

test("an unobserved RGB inside R=1 in a cell, its horizontal neighbour, or its trailing space cell is treated as ink and never overwritten (34480)", async () => {
  const { paintClasses, sentinelSpec, makeFrame } = buildDitheredSentinelFixture()
  const origin = { x: 2, y: 2 }
  // (31, 34, 44) is at Chebyshev distance 1 from (32, 35, 45) but is NOT in paintClasses.background.members.
  const unobservedR1: readonly [number, number, number, number] = [31, 34, 44, 255]

  for (const contamination of ["candidate cell", "left neighbour cell", "trailing space cell"] as const) {
    const prePaintFrame = makeFrame(origin, { painted: false })
    // chosenPair.b is at row 1, col 4 (so col-1=3 and col+1=5 are both in-grid).
    const targetCol =
      contamination === "candidate cell"
        ? chosenPair.b.col
        : contamination === "left neighbour cell"
          ? chosenPair.b.col - 1
          : chosenPair.b.col + 1
    const px = origin.x + (targetCol - 1) * 2
    const py = origin.y + (chosenPair.b.row - 1) * 2
    prePaintFrame.rgba.set(unobservedR1, (py * prePaintFrame.width + px) * 4)
    const writes = source()
    await readThroughSentinel({
      source: writes.source,
      prePaint: async () => prePaintFrame,
      capture: async (resolve) => resolve({ frame: makeFrame(origin, { painted: true }), pixelGeometry }),
      label: `unobserved-${contamination}`,
      sentinel: sentinelSpec,
      regions: [cells],
      reading: origin,
      cell: { width: 2, height: 2 },
      settled: { ...settledAt(origin), paintClasses },
      deadline: Date.now() - 1,
    }).catch(() => undefined)
    // Because chosenPair.b (or its left neighbour or trailing space cell) held an unobserved R=1 triple, the chooser must NOT select chosenPair.b!
    expect(writes.writes[0]).not.toContain(at(chosenPair.b))
  }
})

test("a frame dominated by an unobserved colour (including an unobserved R=1 triple) refuses by name before writing any witness cell (34480, @cto)", async () => {
  const { paintClasses, sentinelSpec } = buildDitheredSentinelFixture()
  const origin = { x: 2, y: 2 }
  // Fill the entire 16x12 frame with an unobserved R=1 triple (31, 34, 44) not in paintClasses.background.members.
  const dominated: CapturedFrame = { width: 16, height: 12, rgba: new Uint8Array(16 * 12 * 4) }
  for (let offset = 0; offset < dominated.rgba.length; offset += 4) {
    dominated.rgba.set([31, 34, 44, 255], offset)
  }
  const writes = source()
  await expect(
    readThroughSentinel({
      source: writes.source,
      prePaint: async () => dominated,
      capture: async (resolve) => resolve({ frame: dominated, pixelGeometry }),
      label: "dominated-by-unobserved-r1",
      sentinel: sentinelSpec,
      regions: [cells],
      reading: origin,
      cell: { width: 2, height: 2 },
      settled: { ...settledAt(origin), paintClasses },
      deadline: Date.now() + 1_000,
    }),
  ).rejects.toThrow(
    /projected frame modal background \(31,34,44\) differs from calibrated background anchor \(32,35,45\)/,
  )
  // Refused before paintCells() could write anything to the terminal, and finally still clears only if a pair was chosen.
  expect(writes.writes).toEqual([])
})

test("landing-pose pairClearBeforePaint accepts calibrated dithered background and refuses an unobserved R=1 pixel at the landing pose (34480)", () => {
  const { paintClasses, makeFrame } = buildDitheredSentinelFixture()
  const cellSize = { width: 2, height: 6 }
  const size = { width: 16, height: 30 }
  const ditheredBlank = makeFrame({ x: 0, y: 0 }, { painted: false, size, cell: cellSize })
  const pair = { a: { row: 3, col: 1 }, b: { row: 1, col: 4 } }
  // Without backgroundClass, ditheredBlank has 0 exact-uniform cells so pairClearBeforePaint returns false.
  expect(
    pairClearBeforePaint({
      before: ditheredBlank,
      reading: { x: 0, y: 2 * cellSize.height },
      cell: cellSize,
      columns: grid.cols,
      cells: [pair.a, pair.b],
    }),
  ).toBe(false)
  // With calibrated backgroundClass, the landing pose at +2 rows is recognized as clear.
  expect(
    pairClearBeforePaint({
      before: ditheredBlank,
      reading: { x: 0, y: 2 * cellSize.height },
      cell: cellSize,
      columns: grid.cols,
      cells: [pair.a, pair.b],
      backgroundClass: paintClasses.background,
    }),
  ).toBe(true)
  // Put a single unobserved R=1 pixel (31, 34, 44) at the landing pose of pair.a (row 3 + 2 rows shift): must return false.
  const contaminated = { width: size.width, height: size.height, rgba: new Uint8Array(ditheredBlank.rgba) }
  const landingY = (pair.a.row + 2 - 1) * cellSize.height
  const landingX = (pair.a.col - 1) * cellSize.width
  contaminated.rgba.set([31, 34, 44, 255], (landingY * size.width + landingX) * 4)
  expect(
    pairClearBeforePaint({
      before: contaminated,
      reading: { x: 0, y: 2 * cellSize.height },
      cell: cellSize,
      columns: grid.cols,
      cells: [pair.a, pair.b],
      backgroundClass: paintClasses.background,
    }),
  ).toBe(false)
})

test("readThroughSentinel refuses by name before choose when settled origin omits calibrated paintClasses (34505, @dev/8 peer finding)", async () => {
  const { sentinelSpec, makeFrame } = buildDitheredSentinelFixture()
  const origin = { x: 2, y: 2 }
  const prePaintFrame = makeFrame(origin, { painted: false })
  const writes = source()
  const { paintClasses: _omitted, ...settledWithoutPaintClasses } = settledAt(origin)
  await expect(
    readThroughSentinel({
      source: writes.source,
      prePaint: async () => prePaintFrame,
      capture: async (resolve) => resolve({ frame: prePaintFrame, pixelGeometry }),
      label: "settled-without-paint-classes",
      sentinel: sentinelSpec,
      regions: [cells],
      reading: origin,
      cell: { width: 2, height: 2 },
      settled: settledWithoutPaintClasses,
      deadline: Date.now() + 1_000,
    }),
  ).rejects.toThrow(/settled-without-paint-classes: settled origin at 2,2 carries no calibrated paintClasses/)
  expect(writes.writes).toEqual([])
})

test("readThroughSentinel without settled origin qualifies dithered blank-cell failure with missing paintClasses diagnostic (34505)", async () => {
  const { sentinelSpec, makeFrame } = buildDitheredSentinelFixture()
  const origin = { x: 2, y: 2 }
  const prePaintFrame = makeFrame(origin, { painted: false })
  const writes = source()
  await expect(
    readThroughSentinel({
      source: writes.source,
      prePaint: async () => prePaintFrame,
      capture: async (resolve) => resolve({ frame: prePaintFrame, pixelGeometry }),
      label: "uncalibrated-dithered-frame",
      sentinel: sentinelSpec,
      regions: [cells],
      reading: origin,
      cell: { width: 2, height: 2 },
      deadline: Date.now() + 1_000,
    }),
  ).rejects.toThrow(
    /no calibrated paintClasses were supplied to readThroughSentinel, so a dithered background is indistinguishable from ink/,
  )
  expect(writes.writes).toEqual([])
})

test("readThroughSentinel chooseOrigin recovers Warp +0,+560 px paint-witness reads across all 5 RIS SGR rows while still running full resolve() checks (#37701)", async () => {
  // Exact Warp 45269053904 geometry: 8x16 cells, calibrated origin (17,46), post-RIS origin (17,606) = +35 rows (+560 px).
  const cell = { width: 8, height: 16 }
  const cols = 12
  const rows = 4
  const width = 160
  const height = 680
  const calibratedOrigin = { x: 17, y: 46 }
  const movedOrigin = { x: 17, y: 606 }
  const warpGeom = { cellWidth: 8, cellHeight: 16, textWidth: cols * 8, textHeight: rows * 16 }
  const bg: [number, number, number] = [5, 5, 5]
  const fg: [number, number, number] = [230, 230, 230]
  const sentinelRgb: [number, number, number] = [255, 143, 253]
  const pack = ([r, g, b]: readonly [number, number, number]) => (r << 16) | (g << 8) | b
  const paintClasses = {
    background: { anchor: bg, members: new Set([pack(bg)]) },
    sentinel: { anchor: sentinelRgb, members: new Set([pack(sentinelRgb)]) },
  }
  const paintCell = (
    rgba: Uint8Array,
    origin: { x: number; y: number },
    r: number,
    c: number,
    rgb: readonly [number, number, number],
  ) => {
    const x0 = origin.x + (c - 1) * cell.width
    const y0 = origin.y + (r - 1) * cell.height
    for (let y = y0; y < y0 + cell.height; y++) {
      for (let x = x0; x < x0 + cell.width; x++) {
        const offset = (y * width + x) * 4
        rgba[offset] = rgb[0]
        rgba[offset + 1] = rgb[1]
        rgba[offset + 2] = rgb[2]
        rgba[offset + 3] = 255
      }
    }
  }
  const blankFrame = () => {
    const rgba = new Uint8Array(width * height * 4)
    for (let offset = 0; offset < rgba.length; offset += 4) {
      rgba[offset] = bg[0]
      rgba[offset + 1] = bg[1]
      rgba[offset + 2] = bg[2]
      rgba[offset + 3] = 255
    }
    return rgba
  }
  const parsePaintedCells = (write: string) =>
    [...write.matchAll(/\x1b\[(\d+);(\d+)H(?:\x1b\[0m)?\x1b\[45m /g)].map((m) => ({
      row: Number(m[1]),
      col: Number(m[2]),
    }))

  const fiveSgrRows = [
    "sgr.bg.default",
    "sgr.fg.default",
    "sgr.selective-reset.inverse",
    "sgr.selective-reset.italic",
    "sgr.selective-reset.underline",
  ] as const

  for (const rowId of fiveSgrRows) {
    // Witness glyph "2" sits at cell (1,1) of the moved post-RIS origin (17,606); calibrated (17,46) is blank.
    const preRgba = blankFrame()
    paintCell(preRgba, movedOrigin, 1, 1, fg)
    const preFrame = { width, height, rgba: preRgba }

    const runWitnessRead = (chooseOrigin?: { x: number; y: number }) => {
      const writes: string[] = []
      const src = { rows, cols, write: (text: string) => writes.push(text) } as unknown as TermProbeSource
      return readThroughSentinel({
        source: src,
        settled: {
          origin: calibratedOrigin,
          basis: "collector complete witnessed raster",
          basisKind: "calibration witnessed raster",
          pixelGeometry: warpGeom,
          paintClasses,
        },
        prePaint: async () => preFrame,
        capture: async (resolve) => {
          const painted = parsePaintedCells(writes[0] ?? "")
          const afterRgba = new Uint8Array(preRgba)
          for (const pos of painted) paintCell(afterRgba, movedOrigin, pos.row, pos.col, sentinelRgb)
          return resolve({ frame: { width, height, rgba: afterRgba }, pixelGeometry: warpGeom })
        },
        label: `${rowId}: expected frame — paint witness`,
        sentinel: { form: "basic", rgb: sentinelRgb },
        regions: [{ top: 1, left: 1, bottom: 1, right: 1 }],
        reading: calibratedOrigin,
        ...(chooseOrigin !== undefined ? { chooseOrigin } : {}),
        cell,
        deadline: Date.now() + 1_000,
      })
    }

    // Old path (no chooseOrigin): picks (1,2)+(2,1) against blank (17,46) and fails pairClearBeforePaint at (17,606).
    await expect(runWitnessRead(), `${rowId} old path`).rejects.toThrow(
      /the frame moved after cells 1,2 and 2,1 were chosen at 17,46 — the pair landed 0,560 px from it/,
    )

    // New path (carried proved origin as chooseOrigin): avoids (1,1) -> picks (1,3)+(2,1) and proves +35 rows against (17,46).
    const accepted = await runWitnessRead(movedOrigin)
    expect(accepted.origin, rowId).toEqual(movedOrigin)
    expect(accepted.acceptedRowMove, rowId).toEqual({ rows: 35, px: 560 })
    expect(accepted.changedOutside, rowId).toBe(0)
  }

  // Full resolve() checks remain enforced even with chooseOrigin: a 1 px change inside the moved grid still refuses.
  const noisyPre = blankFrame()
  paintCell(noisyPre, movedOrigin, 1, 1, fg)
  const writes: string[] = []
  const src = { rows, cols, write: (text: string) => writes.push(text) } as unknown as TermProbeSource
  await expect(
    readThroughSentinel({
      source: src,
      settled: {
        origin: calibratedOrigin,
        basis: "collector complete witnessed raster",
        basisKind: "calibration witnessed raster",
        pixelGeometry: warpGeom,
        paintClasses,
      },
      prePaint: async () => ({ width, height, rgba: noisyPre }),
      capture: async (resolve) => {
        const painted = parsePaintedCells(writes[0] ?? "")
        const afterRgba = new Uint8Array(noisyPre)
        for (const pos of painted) paintCell(afterRgba, movedOrigin, pos.row, pos.col, sentinelRgb)
        const inGridOffset = ((movedOrigin.y + 3 * cell.height) * width + movedOrigin.x) * 4
        afterRgba[inGridOffset] = 99
        return resolve({ frame: { width, height, rgba: afterRgba }, pixelGeometry: warpGeom })
      },
      label: "sgr.bg.default: expected frame — paint witness",
      sentinel: { form: "basic", rgb: sentinelRgb },
      regions: [{ top: 1, left: 1, bottom: 1, right: 1 }],
      reading: calibratedOrigin,
      chooseOrigin: movedOrigin,
      cell,
      deadline: Date.now() + 1_000,
    }),
  ).rejects.toThrow(SentinelFrameMoved)
})

test("under a proven row move, changedOutside counts only pixels inside the moved grid while changedOutsideGrid records app chrome above the grid across all 5 Warp field reads (#37701, @cto 548edef1)", async () => {
  // Exact Warp stable_05 run 45526885127 (a975f203999d956a66e1cd54eaaf0ecd) geometry:
  // 1280x760 window, 109x39 grid of 8x16 cells (872x624 text area), calibrated origin (17,46),
  // post-RIS moved origin (17,606) = +35 rows (+560 px), block-header 1 Hz clock bbox x=355..362, y=565..575.
  const cell = { width: 8, height: 16 }
  const cols = 109
  const rows = 39
  const width = 420
  const height = 680
  const calibratedOrigin = { x: 17, y: 46 }
  const movedOrigin = { x: 17, y: 606 }
  const warpGeom = { cellWidth: 8, cellHeight: 16, textWidth: cols * 8, textHeight: rows * 16 }
  const bg: [number, number, number] = [5, 5, 5]
  const fg: [number, number, number] = [230, 230, 230]
  const clockRgb: [number, number, number] = [180, 180, 180]
  const sentinelRgb: [number, number, number] = [255, 143, 253]
  const pack = ([r, g, b]: readonly [number, number, number]) => (r << 16) | (g << 8) | b
  const paintClasses = {
    background: { anchor: bg, members: new Set([pack(bg)]) },
    sentinel: { anchor: sentinelRgb, members: new Set([pack(sentinelRgb)]) },
  }
  const paintCell = (
    rgba: Uint8Array,
    origin: { x: number; y: number },
    r: number,
    c: number,
    rgb: readonly [number, number, number],
  ) => {
    const x0 = origin.x + (c - 1) * cell.width
    const y0 = origin.y + (r - 1) * cell.height
    for (let y = y0; y < y0 + cell.height; y++) {
      for (let x = x0; x < x0 + cell.width; x++) {
        const offset = (y * width + x) * 4
        rgba[offset] = rgb[0]
        rgba[offset + 1] = rgb[1]
        rgba[offset + 2] = rgb[2]
        rgba[offset + 3] = 255
      }
    }
  }
  const blankFrame = () => {
    const rgba = new Uint8Array(width * height * 4)
    for (let offset = 0; offset < rgba.length; offset += 4) {
      rgba[offset] = bg[0]
      rgba[offset + 1] = bg[1]
      rgba[offset + 2] = bg[2]
      rgba[offset + 3] = 255
    }
    return rgba
  }
  // Paint `count` changed pixels inside the field-measured Warp block-header clock bbox (x=355..362, y=565..575, 8x11 = 88 px capacity).
  const paintHeaderClockTick = (rgba: Uint8Array, count: number) => {
    let remaining = count
    for (let y = 565; y <= 575 && remaining > 0; y++) {
      for (let x = 355; x <= 362 && remaining > 0; x++) {
        const offset = (y * width + x) * 4
        rgba[offset] = clockRgb[0]
        rgba[offset + 1] = clockRgb[1]
        rgba[offset + 2] = clockRgb[2]
        rgba[offset + 3] = 255
        remaining--
      }
    }
  }
  const parsePaintedCells = (write: string) =>
    [...write.matchAll(/\x1b\[(\d+);(\d+)H(?:\x1b\[0m)?\x1b\[45m /g)].map((m) => ({
      row: Number(m[1]),
      col: Number(m[2]),
    }))

  // The 5 field reads from Warp run 45526885127 (a975f203999d956a66e1cd54eaaf0ecd):
  const fieldReads = [
    {
      label: "sgr.fg.default: expected frame — baseline",
      chooseOrigin: undefined,
      regions: [{ top: 1, left: 1, bottom: 1, right: 1 }],
      headerClockPixels: 74,
      witnessPainted: false,
    },
    {
      label: "sgr.bg.default: expected frame",
      chooseOrigin: movedOrigin,
      regions: [
        { top: 3, left: 5, bottom: 3, right: 6 },
        { top: 1, left: 1, bottom: 2, right: 3 },
      ],
      headerClockPixels: 74,
      witnessPainted: true,
    },
    {
      label: "sgr.selective-reset.underline: expected frame — baseline",
      chooseOrigin: undefined,
      regions: [{ top: 1, left: 1, bottom: 1, right: 1 }],
      headerClockPixels: 69,
      witnessPainted: false,
    },
    {
      label: "sgr.selective-reset.italic: expected frame",
      chooseOrigin: movedOrigin,
      regions: [
        { top: 3, left: 5, bottom: 3, right: 6 },
        { top: 1, left: 1, bottom: 2, right: 3 },
      ],
      headerClockPixels: 73,
      witnessPainted: true,
    },
    {
      label: "sgr.selective-reset.inverse: expected frame",
      chooseOrigin: movedOrigin,
      regions: [
        { top: 3, left: 5, bottom: 3, right: 6 },
        { top: 1, left: 1, bottom: 2, right: 3 },
      ],
      headerClockPixels: 68,
      witnessPainted: true,
    },
  ] as const

  for (const fixture of fieldReads) {
    const preRgba = blankFrame()
    if (fixture.witnessPainted) {
      paintCell(preRgba, movedOrigin, 1, 1, fg)
      paintCell(preRgba, movedOrigin, 3, 3, fg)
      paintCell(preRgba, movedOrigin, 3, 4, fg)
      paintCell(preRgba, movedOrigin, 3, 5, fg)
      paintCell(preRgba, movedOrigin, 3, 6, fg)
    }
    const writes: string[] = []
    const src = { rows, cols, write: (text: string) => writes.push(text) } as unknown as TermProbeSource
    const accepted = await readThroughSentinel({
      source: src,
      settled: {
        origin: calibratedOrigin,
        basis: "collector complete witnessed raster",
        basisKind: "calibration witnessed raster",
        pixelGeometry: warpGeom,
        paintClasses,
      },
      prePaint: async () => ({ width, height, rgba: preRgba }),
      capture: async (resolve) => {
        const painted = parsePaintedCells(writes[0] ?? "")
        const afterRgba = new Uint8Array(preRgba)
        for (const pos of painted) paintCell(afterRgba, movedOrigin, pos.row, pos.col, sentinelRgb)
        paintHeaderClockTick(afterRgba, fixture.headerClockPixels)
        return resolve({ frame: { width, height, rgba: afterRgba }, pixelGeometry: warpGeom })
      },
      label: fixture.label,
      sentinel: { form: "basic", rgb: sentinelRgb },
      regions: fixture.regions,
      reading: calibratedOrigin,
      ...(fixture.chooseOrigin !== undefined ? { chooseOrigin: fixture.chooseOrigin } : {}),
      cell,
      deadline: Date.now() + 1_000,
    })
    expect(accepted.origin, fixture.label).toEqual(movedOrigin)
    expect(accepted.acceptedRowMove, fixture.label).toEqual({ rows: 35, px: 560 })
    expect(accepted.changedOutside, fixture.label).toBe(0)
    expect(accepted.changedOutsideGrid, fixture.label).toBe(fixture.headerClockPixels)
    expect(accepted.basisKind, fixture.label).toBe("calibration witnessed raster")
  }

  // End-to-end composition (#37701, hosted run 45659187483 / b26cbd3f7c71823ec13da78d570e5c70):
  // when an unmoved calibrated read (onSettledOrigin at 17,46) and a moved calibrated read
  // (acceptOrRefuseMovedSentinelOrigin at 17,606) share the same settled calibration (basisKind
  // and surface), both cellCrop records must carry identical basis and surface so gridMoveExemption
  // and cropPositionRefusal accept the +35-row move across all 5 SGR RIS rows.
  {
    const settledSurface = { x: 0, y: 0, width, height }
    const settledCalibration = {
      origin: calibratedOrigin,
      basis: "collector complete witnessed raster",
      basisKind: "calibration witnessed raster",
      surface: settledSurface,
      pixelGeometry: warpGeom,
      paintClasses,
    }
    const sampleRegion = { top: 3, left: 5, bottom: 3, right: 6 }
    const rectangleAt = (origin: { x: number; y: number }) => ({
      x: origin.x + (sampleRegion.left - 1) * cell.width,
      y: origin.y + (sampleRegion.top - 1) * cell.height,
      width: (sampleRegion.right - sampleRegion.left + 1) * cell.width,
      height: (sampleRegion.bottom - sampleRegion.top + 1) * cell.height,
    })
    const toCellCrop = (placement: NamedTextOrigin): PixelCellCrop => ({
      origin: placement.origin,
      ...(placement.basisKind !== undefined ? { basis: placement.basisKind } : {}),
      basisDetail: placement.basisDetail ?? placement.basis,
      ...(placement.surface !== undefined ? { surface: placement.surface } : {}),
      cell,
      grid: { columns: cols, rows },
      image: { width, height },
      ...(placement.witness !== undefined ? { witness: placement.witness } : {}),
      ...(placement.changedOutside !== undefined ? { changedOutside: placement.changedOutside } : {}),
      ...(placement.changedOutsideGrid !== undefined ? { changedOutsideGrid: placement.changedOutsideGrid } : {}),
      ...(placement.acceptedRowMove !== undefined ? { acceptedRowMove: placement.acceptedRowMove } : {}),
    })

    const unmovedPre = blankFrame()
    paintCell(unmovedPre, calibratedOrigin, 1, 1, fg)
    const unmovedWrites: string[] = []
    const unmovedSrc = { rows, cols, write: (text: string) => unmovedWrites.push(text) } as unknown as TermProbeSource
    const unmoved = await readThroughSentinel({
      source: unmovedSrc,
      settled: settledCalibration,
      prePaint: async () => ({ width, height, rgba: unmovedPre }),
      capture: async (resolve) => {
        const painted = parsePaintedCells(unmovedWrites[0] ?? "")
        const afterRgba = new Uint8Array(unmovedPre)
        for (const pos of painted) paintCell(afterRgba, calibratedOrigin, pos.row, pos.col, sentinelRgb)
        return resolve({ frame: { width, height, rgba: afterRgba }, pixelGeometry: warpGeom })
      },
      label: "sgr.bg.default: pre-edit seed",
      sentinel: { form: "basic", rgb: sentinelRgb },
      regions: [sampleRegion],
      reading: calibratedOrigin,
      cell,
      deadline: Date.now() + 1_000,
    })

    const movedPre = blankFrame()
    paintCell(movedPre, movedOrigin, 1, 1, fg)
    const movedWrites: string[] = []
    const movedSrc = { rows, cols, write: (text: string) => movedWrites.push(text) } as unknown as TermProbeSource
    const moved = await readThroughSentinel({
      source: movedSrc,
      settled: settledCalibration,
      prePaint: async () => ({ width, height, rgba: movedPre }),
      capture: async (resolve) => {
        const painted = parsePaintedCells(movedWrites[0] ?? "")
        const afterRgba = new Uint8Array(movedPre)
        for (const pos of painted) paintCell(afterRgba, movedOrigin, pos.row, pos.col, sentinelRgb)
        paintHeaderClockTick(afterRgba, 69)
        return resolve({ frame: { width, height, rgba: afterRgba }, pixelGeometry: warpGeom })
      },
      label: "sgr.bg.default: expected frame",
      sentinel: { form: "basic", rgb: sentinelRgb },
      regions: [sampleRegion],
      reading: calibratedOrigin,
      chooseOrigin: movedOrigin,
      cell,
      deadline: Date.now() + 1_000,
    })

    const compared = [
      { role: "the seed frame", rectangle: rectangleAt(unmoved.origin), crop: toCellCrop(unmoved) },
      { role: "the expected frame", rectangle: rectangleAt(moved.origin), crop: toCellCrop(moved) },
    ]
    expect(gridMoveExemption(compared)).toEqual([{ rows: 35, at: "the expected frame" }])
    expect(
      cropPositionRefusal({
        id: "sgr.bg.default",
        compared,
        response: "{}",
        frames: [],
      }),
    ).toBeNull()
  }

  // Condition 3: a fixture with one changed pixel INSIDE the moved grid still fails with SentinelFrameMoved (changedOutside: 1).
  {
    const preRgba = blankFrame()
    const writes: string[] = []
    const src = { rows, cols, write: (text: string) => writes.push(text) } as unknown as TermProbeSource
    const error = await readThroughSentinel({
      source: src,
      settled: {
        origin: calibratedOrigin,
        basis: "collector complete witnessed raster",
        basisKind: "calibration witnessed raster",
        pixelGeometry: warpGeom,
        paintClasses,
      },
      prePaint: async () => ({ width, height, rgba: preRgba }),
      capture: async (resolve) => {
        const painted = parsePaintedCells(writes[0] ?? "")
        const afterRgba = new Uint8Array(preRgba)
        for (const pos of painted) paintCell(afterRgba, movedOrigin, pos.row, pos.col, sentinelRgb)
        paintHeaderClockTick(afterRgba, 74)
        // One non-sentinel changed pixel inside the moved grid (row 4, col 10 at y = 606 + 3*16 = 654, x = 17 + 9*8 = 89).
        const inGridOffset = ((movedOrigin.y + 3 * cell.height) * width + (movedOrigin.x + 9 * cell.width)) * 4
        afterRgba[inGridOffset] = 123
        return resolve({ frame: { width, height, rgba: afterRgba }, pixelGeometry: warpGeom })
      },
      label: "sgr.fg.default: expected frame — baseline (1 px in-grid change)",
      sentinel: { form: "basic", rgb: sentinelRgb },
      regions: [{ top: 1, left: 1, bottom: 1, right: 1 }],
      reading: calibratedOrigin,
      cell,
      deadline: Date.now() + 1_000,
    }).catch((failure: unknown) => failure as SentinelFrameMoved)
    expect(error).toBeInstanceOf(SentinelFrameMoved)
    if (!(error instanceof SentinelFrameMoved)) throw new Error("unreachable: the read did not refuse by name")
    expect(error.changedOutside).toBe(1)
    expect(error.changedOutsideGrid).toBe(74)
    expect(error.rowShift).toEqual({ rows: 35, px: 560 })
  }

  // Condition 1: when the row move is NOT proven (e.g. landing pose is not clear before paint),
  // changedOutside keeps its whole-frame meaning (74) and changedOutsideGrid is absent.
  {
    const preRgba = blankFrame()
    // Put ink at cell (1,2) of the moved grid so pairClearBeforePaint is false when chosen against blank (17,46).
    paintCell(preRgba, movedOrigin, 1, 2, fg)
    const writes: string[] = []
    const src = { rows, cols, write: (text: string) => writes.push(text) } as unknown as TermProbeSource
    const error = await readThroughSentinel({
      source: src,
      settled: {
        origin: calibratedOrigin,
        basis: "collector complete witnessed raster",
        basisKind: "calibration witnessed raster",
        pixelGeometry: warpGeom,
        paintClasses,
      },
      prePaint: async () => ({ width, height, rgba: preRgba }),
      capture: async (resolve) => {
        const painted = parsePaintedCells(writes[0] ?? "")
        const afterRgba = new Uint8Array(preRgba)
        for (const pos of painted) paintCell(afterRgba, movedOrigin, pos.row, pos.col, sentinelRgb)
        paintHeaderClockTick(afterRgba, 74)
        return resolve({ frame: { width, height, rgba: afterRgba }, pixelGeometry: warpGeom })
      },
      label: "sgr.fg.default: unproven row move keeps whole-frame changedOutside",
      sentinel: { form: "basic", rgb: sentinelRgb },
      regions: [{ top: 1, left: 1, bottom: 1, right: 1 }],
      reading: calibratedOrigin,
      cell,
      deadline: Date.now() + 1_000,
    }).catch((failure: unknown) => failure as SentinelFrameMoved)
    expect(error).toBeInstanceOf(SentinelFrameMoved)
    if (!(error instanceof SentinelFrameMoved)) throw new Error("unreachable: the read did not refuse by name")
    expect(error.changedOutside).toBe(74)
    expect(error.changedOutsideGrid).toBeUndefined()
  }
})
