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
  gridMoveExemption,
  pairMeasuredNoRowHeight,
  sentinelCellsInFrame,
  witnessProvesPitch,
  type PixelCellCrop,
} from "@terminfo/probe-defs"
import { expect, test } from "vitest"
import type { CapturedFrame, OriginResolver } from "./capture-core.ts"
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
function windowAt(origin: { x: number; y: number }, options: { painted?: boolean } = {}): CapturedFrame {
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
    for (const cell of [chosenPair.a, chosenPair.b]) {
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
  return {
    writes,
    state,
    source: { rows: grid.rows, cols: grid.cols, write: (text: string) => writes.push(text) },
    frameNow() {
      const frame = windowAt(origin, { painted: paintsNow() })
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
      `^cells 1,1-2,2: the changed sentinel at ${WHERE} is not one painted pair: 1 connected regions changed into the sentinel colour — 4 px in a 2x2 box at 10,6 — where the two painted cells need exactly two; it did not settle before this read's deadline$`,
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
    /^cells 1,1-2,2: the changed sentinel at cells 3,1 and 3,3 is not one painted pair: 1 connected regions changed into the sentinel colour — 24 px in a 12x2 box at 0,4 — where the two painted cells need exactly two; it did not settle before this read's deadline$/,
  )
  // Both cells are still restored, in the pair's own order.
  expect(painted.writes.at(-1)).toBe("\x1b7\x1b[3;1H\x1b[0m \x1b[3;3H \x1b[0m\x1b8")
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

test("a read whose first frame is one write behind the paint restarts and still anchors (33000)", async () => {
  const frame = terminal({ x: 2, y: 2 })
  // The first capture lands one write behind: it does not show the paint yet. The retry has to clear
  // the paint before it re-takes the pre-paint frame, or the difference compares two frames that both
  // show the sentinel and can never see it change (@dev/10).
  frame.state.lag = 1
  let prePaints = 0
  const origin = await readThroughSentinel({
    source: frame.source,
    prePaint: async () => {
      prePaints += 1
      return frame.frameNow()
    },
    capture: async (resolve) => {
      const captured = frame.frameNow()
      frame.state.lag = 0
      return resolve({ frame: captured, pixelGeometry })
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
  expect(frame.writes).toEqual([PAINT, CLEAR, PAINT, CLEAR])
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

/** A settled origin the route measured before this read, as `serve.ts` forwards it (34163). */
function settledAt(
  origin: { x: number; y: number },
  geometry = pixelGeometry,
): {
  origin: { x: number; y: number }
  basis: string
  basisKind: string
  pixelGeometry: typeof pixelGeometry
} {
  return {
    origin,
    basis: "measured by complete raster calibration",
    basisKind: "complete raster calibration",
    pixelGeometry: geometry,
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
  // One non-sentinel pixel in the far corner — outside the digested cells and both poses — keeps this
  // a refusal fixture instead, which is what its message and evidence are about.
  moved.rgba.set([0, 0, 255, 255], ((size.height - 1) * size.width + (size.width - 1)) * 4)
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
  moved.rgba.set([0, 0, 255, 255], ((size.height - 1) * size.width + (size.width - 1)) * 4)
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
  // The far corner: outside the digested cells, outside both painted cells at either pose. The
  // pre-paint fixture leaves it black, and this is not the sentinel colour, so it counts as noise.
  moved.rgba.set([0, 0, 255, 255], ((size.height - 1) * size.width + (size.width - 1)) * 4)
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
