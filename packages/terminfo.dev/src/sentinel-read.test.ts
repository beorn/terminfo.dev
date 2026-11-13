/**
 * @failure A pixel read crops at calibration's stale origin instead of the sentinel pair it paints,
 * finds that sentinel by its colour alone so a probe painting the same colour is refused or mistaken
 * for it, or leaves either painted cell behind, or refuses without naming the read (33000, 33981).
 * @level l2
 * @consumer Serve's per-read origin derivation for windows that move after calibration.
 * @testonly none
 * @reach none
 */
import { sentinelCellsInFrame } from "@terminfo/probe-defs"
import { expect, test } from "vitest"
import type { CapturedFrame } from "./capture-core.ts"
import { readThroughSentinel } from "./sentinel-read.ts"

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
  return { width, height, rgba }
}

function source() {
  const writes: string[] = []
  return {
    writes,
    source: { rows: grid.rows, cols: grid.cols, write: (text: string) => writes.push(text) },
  }
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
  const frame: CapturedFrame = { width: 72, height: 48, rgba: new Uint8Array(72 * 48 * 4).fill(255) }
  const pre: CapturedFrame = { width: 72, height: 48, rgba: new Uint8Array(72 * 48 * 4).fill(255) }
  // Two 10x10 blocks one blended line in from a 12x12 pitch, in cells 1,3 and 2,4 of an all-blank
  // frame: 12 px apart on each axis, which is exactly the pitch the two chosen cells imply.
  for (const [x, y] of [
    [25, 1],
    [37, 13],
  ] as const) {
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
    cell: { width: 12, height: 12 },
    deadline: Date.now() + 1_000,
  })
  // The chooser picks cells 1,3 and 2,4 of this all-blank frame, so the block at (25,1) implies an
  // origin two pitches left of it: (25,1) - (2*12, 0).
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
  ).rejects.toThrow(new RegExp(`no cell changed to the sentinel colour at ${WHERE}`))
  expect(captures).toBe(1)
  expect(painted.writes).toEqual([PAINT, CLEAR])
})
