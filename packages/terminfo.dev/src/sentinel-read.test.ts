/**
 * @failure A pixel read crops at calibration's stale origin instead of the sentinel pair it paints,
 * finds that sentinel by its colour alone so a probe painting the same colour is refused or mistaken
 * for it, or leaves either painted cell behind, or refuses without naming the read (33000, 33981).
 * @level l2
 * @consumer Serve's per-read origin derivation for windows that move after calibration.
 * @testonly none
 * @reach none
 */
import { witnessCellsFor } from "@terminfo/probe-defs"
import { expect, test } from "vitest"
import type { CapturedFrame } from "./capture-core.ts"
import { readThroughSentinel } from "./sentinel-read.ts"

const sentinel = { form: "basic" as const, rgb: [255, 136, 255] as const }
const pixelGeometry = { cellWidth: 2, cellHeight: 2, textWidth: 12, textHeight: 8 }
const cells = { top: 1, left: 1, bottom: 2, right: 2 }
const grid = { rows: 4, cols: 6 }
/** What the picker chooses for this region and grid: different in both row and column (33981). */
const pair = { a: { row: 3, col: 1 }, b: { row: 4, col: 2 } }
const PAINT = "\x1b7\x1b[3;1H\x1b[0m\x1b[45m \x1b[4;2H\x1b[45m \x1b[0m\x1b8"
const CLEAR = "\x1b7\x1b[3;1H\x1b[0m \x1b[4;2H \x1b[0m\x1b8"

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
    for (const cell of [pair.a, pair.b]) {
      for (let dy = 0; dy < 2; dy += 1) {
        for (let dx = 0; dx < 2; dx += 1) {
          paintAt(origin.x + (cell.col - 1) * 2 + dx, origin.y + (cell.row - 1) * 2 + dy, [...sentinel.rgb, 255])
        }
      }
    }
  }
  return { width, height, rgba }
}

function source(dims: { rows: number; cols: number } = grid) {
  const writes: string[] = []
  return {
    writes,
    source: { rows: dims.rows, cols: dims.cols, write: (text: string) => writes.push(text) },
  }
}

/** The pre-paint frame: one frame of the window as the route saw it, taken before the paint. */
function before(drawnAt: { x: number; y: number }): CapturedFrame {
  return windowAt(drawnAt, { painted: false })
}

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

test("the picker chooses two cells that differ in both row and column, and refuses a grid with no second cell (33981)", () => {
  expect(witnessCellsFor([cells], grid)).toEqual({ ...pair, tier: "region-free" })
  expect(() => witnessCellsFor([cells], { rows: 4, cols: 1 })).toThrow(
    /No second cell clear of the digested region 1,1-2,2 on a row it does not use, in the 4x1 grid, differs from cell 3,1 in both row and column/,
  )
})

// @dev/10 peer read: a cell on a digested region's own row is excluded even when its column is clear,
// because the restore erases a wide character at the region's edge whole and would change the frame
// this read digests. Both shapes that used to slip through now refuse by name.
test("the picker keeps the second cell off a compared region's own row, or anchors a whole cell away on it (33981, 34040)", () => {
  // One clear row and six columns: the pair stays on that row a whole cell apart, and the record
  // names the tier so no reader takes it for a two-axis pair (34040, @cto tier 2).
  expect(witnessCellsFor([cells], { rows: 3, cols: 6 })).toEqual({
    a: { row: 3, col: 1 },
    b: { row: 3, col: 3 },
    tier: "same-row",
  })
  // Two columns cannot hold that gap, so the same screen refuses and names the limit.
  expect(() => witnessCellsFor([cells], { rows: 3, cols: 2 })).toThrow(
    /on a row it does not use, in the 3x2 grid.*the compared region leaves one clear row, 3,/,
  )
  // 34040: cell 4,2 is three rows below the first cell and clear of the region. It was outside the
  // old fixed candidate list, which refused this grid; the search takes the nearest usable cell.
  expect(witnessCellsFor([{ top: 2, left: 1, bottom: 3, right: 2 }], { rows: 5, cols: 6 })).toEqual({
    a: { row: 1, col: 1 },
    b: { row: 4, col: 2 },
    tier: "region-free",
  })
})

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
      deadline: Date.now() + 1_000,
    })
    return { origin, writes: painted.writes }
  }
  expect((await read({ x: 0, y: 0 })).origin.origin).toEqual({ x: 0, y: 0 })
  expect((await read({ x: 2, y: 2 })).origin.origin).toEqual({ x: 2, y: 2 })
  const nudged = await read({ x: 1, y: 3 })
  expect(nudged.origin.origin).toEqual({ x: 1, y: 3 })
  expect(nudged.origin.basis).toBe("sentinel re-located by frame difference at cells 3,1 and 4,2 (33000, 33981)")
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
    for (let dx = 0; dx < 2; dx += 1) witness.rgba.set([...sentinel.rgb, 255], ((4 + dy) * 16 + (8 + dx)) * 4)
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
      deadline: Date.now(),
    }),
  ).rejects.toThrow(
    /^cells 1,1-2,2: the changed sentinel at cells 3,1 and 4,2 is not one painted pair: 1 connected regions changed into the sentinel colour — 4 px in a 2x2 box at 8,4 — where the two painted cells need exactly two; it did not settle before this read's deadline$/,
  )
  // Both cells are still restored.
  expect(painted.writes.at(-1)).toBe(CLEAR)
})

// @cto 34040 condition 1, carried to the read: the tier-2 pair sits on ONE row a whole cell apart, so
// a run of sentinel colour along that row — a full-line repaint, a wide glyph erased with its
// neighbour — arrives as one connected region. It must refuse by name, never pass as two cells.
test("a sentinel-coloured run along a same-row pair reads as one wide box and refuses by name (34040)", async () => {
  const sameRowGrid = { rows: 3, cols: 6 }
  const anchored = witnessCellsFor([cells], sameRowGrid)
  expect(anchored.tier).toBe("same-row")
  const frame = windowAt({ x: 0, y: 0 }, { painted: false })
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
      prePaint: async () => windowAt({ x: 0, y: 0 }, { painted: false }),
      capture: async (resolve) => resolve({ frame, pixelGeometry }),
      label: "cells 1,1-2,2",
      sentinel,
      regions: [cells],
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
  const frame = windowAt({ x: 0, y: 0 }, { painted: false })
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
    prePaint: async () => windowAt({ x: 0, y: 0 }, { painted: false }),
    capture: async (resolve) => resolve({ frame, pixelGeometry }),
    label: "cells 1,1-2,2",
    sentinel,
    regions: [cells],
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
  const frame = windowAt({ x: 0, y: 0 }, { painted: false })
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
      prePaint: async () => windowAt({ x: 0, y: 0 }, { painted: false }),
      capture: async (resolve) => resolve({ frame, pixelGeometry }),
      label: "cells 1,1-2,2",
      sentinel,
      regions: [cells],
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
      deadline: Date.now(),
    }),
  ).rejects.toThrow(
    /their offset is 6,2, which is a pitch of 6.00x2.00 across the 1 columns and 1 rows between the painted cells, not the 2x2 cell/,
  )
})

test("a pair whose boxes are a blended edge short on each axis still anchors, because the offset follows the cell pitch (33981)", async () => {
  const pitch = { cellWidth: 12, cellHeight: 12, textWidth: 120, textHeight: 96 }
  const frame: CapturedFrame = { width: 30, height: 30, rgba: new Uint8Array(30 * 30 * 4).fill(255) }
  const pre: CapturedFrame = { width: 30, height: 30, rgba: new Uint8Array(30 * 30 * 4).fill(255) }
  // Two 10x10 blocks one blended line in from a 12x12 pitch, 12 px apart on each axis.
  for (const [x, y] of [
    [1, 1],
    [13, 13],
  ] as const) {
    for (let dy = 0; dy < 10; dy += 1) {
      for (let dx = 0; dx < 10; dx += 1) frame.rgba.set([...sentinel.rgb, 255], ((y + dy) * 30 + (x + dx)) * 4)
    }
  }
  const origin = await readThroughSentinel({
    source: source().source,
    prePaint: async () => pre,
    capture: async (resolve) => resolve({ frame, pixelGeometry: pitch }),
    label: "cells 1,1-2,2",
    sentinel,
    regions: [cells],
    deadline: Date.now() + 1_000,
  })
  // Cell 3,1 is one column and two rows into the grid, so its paint implies an origin one pitch
  // above the box's row and level with its column: (1,1) - (0, 2*12).
  expect(origin.origin).toEqual({ x: 1, y: 1 - 2 * 12 })
})

test("a third changed cell carrying the sentinel colour refuses by name with every box (33981)", async () => {
  const frame = windowAt({ x: 2, y: 2 })
  for (let dy = 0; dy < 2; dy += 1) {
    for (let dx = 0; dx < 2; dx += 1) frame.rgba.set([...sentinel.rgb, 255], ((4 + dy) * 16 + (8 + dx)) * 4)
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
      deadline: Date.now() + 50,
    }),
  ).rejects.toThrow(
    "cells 1,1-2,2: no cell changed to the sentinel colour at cells 3,1 and 4,2 between the frames this read compared, so its crop cannot be anchored",
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
      deadline: Date.now() + 1_000,
    }),
  ).rejects.toBe(failure)
  expect(writes).toEqual([
    "\x1b7\x1b[4;2H\x1b[0m\x1b[45m \x1b[5;3H\x1b[45m \x1b[0m\x1b8",
    "\x1b7\x1b[4;2H\x1b[0m \x1b[5;3H \x1b[0m\x1b8",
  ])
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
      deadline: Date.now() + 1_000,
    }),
  ).rejects.toBe(failure)
  expect(painted.writes).toEqual([PAINT, CLEAR])
})

test("a sentinel pair that never appears refuses at the read's deadline and still restores (33000)", async () => {
  const painted = source()
  const blank: CapturedFrame = { width: 16, height: 12, rgba: new Uint8Array(16 * 12 * 4).fill(255) }
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
      deadline: Date.now() - 1,
    }),
  ).rejects.toThrow(/no cell changed to the sentinel colour at cells 3,1 and 4,2/)
  expect(captures).toBe(1)
  expect(painted.writes).toEqual([PAINT, CLEAR])
})

// 34015, @dev/10 residual: the clause has to reach the basis this read RETURNS, not just the pure
// function's return. One pixel knocked out of the second witness box is exactly the case a rendered
// cell produces — an anti-aliased corner or the read's own restored pixel — and it must anchor here
// and say so, rather than refusing or anchoring silently.
test("a witness box one pixel short of its area anchors the read and says so in the basis it returns (34015)", async () => {
  const drawnAt = { x: 2, y: 2 }
  const frame = windowAt(drawnAt)
  // Back to the probe's own pattern in b's bottom-right pixel: 3 of the box's 4 pixels carry the colour.
  const boxX = drawnAt.x + (pair.b.col - 1) * 2
  const boxY = drawnAt.y + (pair.b.row - 1) * 2
  frame.rgba.set([1, 2, 90, 255], ((boxY + 1) * 16 + (boxX + 1)) * 4)
  const origin = await readThroughSentinel({
    source: source().source,
    prePaint: async () => before(drawnAt),
    capture: async (resolve) => resolve({ frame, pixelGeometry }),
    label: "cells 1,1-2,2",
    sentinel,
    regions: [cells],
    deadline: Date.now() + 1_000,
  })
  expect(origin.origin).toEqual(drawnAt)
  expect(origin.basis).toContain("sentinel box accepted short of its area (3 of 4 px)")
})
