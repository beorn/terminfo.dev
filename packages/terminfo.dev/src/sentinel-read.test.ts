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
import { SentinelPaintWiderThanCell, readThroughSentinel } from "./sentinel-read.ts"

const sentinel = { form: "basic" as const, rgb: [255, 136, 255] as const }
const pixelGeometry = { cellWidth: 2, cellHeight: 2, textWidth: 12, textHeight: 8 }
const cells = { top: 1, left: 1, bottom: 2, right: 2 }
const grid = { rows: 4, cols: 6 }
const at = (cell: { row: number; col: number }) => `\x1b[${cell.row};${cell.col}H`
/** The glyph the read paints, in the probe's current attributes: no SGR (@cto 2db35bf8). */
const GLYPH = "\u2588"
type Pair = { a: { row: number; col: number }; b: { row: number; col: number } }
type Cursor = { row: number; col: number }
/** What CSI 6n answers in these tests: the cursor the paint must put back. */
const CURSOR = { row: 1, col: 1 }
const cursorAt = async () => CURSOR
const paintOf = (pair: Pair, cursor: Cursor) => `${at(pair.a)}${GLYPH}${at(pair.b)}${GLYPH}${at(cursor)}`
const clearOf = (pair: Pair, cursor: Cursor) => `${at(pair.a)} ${at(pair.b)} ${at(cursor)}`

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
const PAINT = paintOf(chosenPair, CURSOR)
const CLEAR = clearOf(chosenPair, CURSOR)
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
    return last !== undefined && last.includes(GLYPH)
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
      regions: [cells],
      reading: drawnAt,
      cell: { width: 2, height: 2 },
      cursorPosition: cursorAt,
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
    regions: [cells],
    reading: { x: 2, y: 2 },
    cell: { width: 2, height: 2 },
    cursorPosition: cursorAt,
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
      regions: [cells],
      reading: { x: 2, y: 2 },
      cell: { width: 2, height: 2 },
      cursorPosition: cursorAt,
      deadline: Date.now(),
    }),
  ).rejects.toThrow(
    new RegExp(
      `^cells 1,1-2,2: other change during this read at ${WHERE}: one disconnected region changed between the frames it compared — 4 px in a 2x2 box at 10,6 — where the two painted cells need exactly two; it did not settle before this read's deadline$`,
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
      regions: [cells],
      reading: { x: 0, y: 0 },
      cell: { width: 2, height: 2 },
      cursorPosition: cursorAt,
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
    regions: [cells],
    reading: { x: 0, y: 0 },
    cell: { width: 12, height: 12 },
    cursorPosition: cursorAt,
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
      regions: [cells],
      reading: { x: 2, y: 2 },
      cell: { width: 2, height: 2 },
      cursorPosition: cursorAt,
      deadline: Date.now(),
    }),
  ).rejects.toThrow(
    /other change during this read at cells .*: 3 disconnected regions changed between the frames it compared — .*where the two painted cells need exactly two/,
  )
})

// @cto 2db35bf8: filtering non-sentinel change by colour was the lucky part. With a colour-free
// difference there is no such filter, so a probe drawing during the read REFUSES the read instead of
// being counted as noise and read past.
test("anything else that changes during the read refuses it, rather than being filtered away (33981)", async () => {
  const frame = windowAt({ x: 2, y: 2 })
  frame.rgba.set([1, 2, 3, 255], 0)
  frame.rgba.set([4, 5, 6, 255], 4)
  await expect(
    readThroughSentinel({
      source: source().source,
      prePaint: async () => before({ x: 2, y: 2 }),
      capture: async (resolve) => resolve({ frame, pixelGeometry }),
      label: "cells 1,1-2,2",
      regions: [cells],
      reading: { x: 2, y: 2 },
      cell: { width: 2, height: 2 },
      cursorPosition: cursorAt,
      deadline: Date.now(),
    }),
  ).rejects.toThrow(/other change during this read .*: 3 disconnected regions/)
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
    regions: [cells],
    reading: { x: 2, y: 2 },
    cell: { width: 2, height: 2 },
    cursorPosition: cursorAt,
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
    regions: [cells],
    reading: { x: 2, y: 2 },
    cell: { width: 2, height: 2 },
    cursorPosition: cursorAt,
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
      regions: [cells],
      reading: { x: 2, y: 2 },
      cell: { width: 2, height: 2 },
      cursorPosition: cursorAt,
      deadline: Date.now() + 50,
    }),
  ).rejects.toThrow(
    `cells 1,1-2,2: the sentinel paint is not visible under the probe's current attributes — no pixel changed between the frames this read compared, so its crop cannot be anchored`,
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
      regions: [{ top: 2, left: 2, bottom: 2, right: 2 }],
      avoid: { top: 1, left: 1, bottom: 3, right: 3 },
      reading: { x: 0, y: 0 },
      cell: { width: 2, height: 2 },
      cursorPosition: cursorAt,
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
  expect(writes).toEqual([paintOf(picked, CURSOR), clearOf(picked, CURSOR)])
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
      regions: [cells],
      reading: { x: 0, y: 0 },
      cell: { width: 2, height: 2 },
      cursorPosition: cursorAt,
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
      regions: [cells],
      reading: { x: 0, y: 0 },
      cell: { width: 2, height: 2 },
      cursorPosition: cursorAt,
      deadline: Date.now() - 1,
    }),
  ).rejects.toThrow(/the sentinel paint is not visible under the probe's current attributes/)
  expect(captures).toBe(1)
  expect(painted.writes).toEqual([paintOf(picked, CURSOR), clearOf(picked, CURSOR)])
})

// @cto 2db35bf8 condition 3: the cursor position is asked, bounded, and consumed by this read. No
// reply or a malformed one refuses by name, and there is no ESC 7 fallback — nothing is painted.
test("a cursor position that was never reported refuses the read before anything is painted (33981)", async () => {
  const painted = source()
  await expect(
    readThroughSentinel({
      source: painted.source,
      prePaint: async () => before({ x: 0, y: 0 }),
      capture: async (resolve) => resolve({ frame: windowAt({ x: 0, y: 0 }), pixelGeometry }),
      label: "cells 1,1-2,2",
      regions: [cells],
      reading: { x: 0, y: 0 },
      cell: { width: 2, height: 2 },
      cursorPosition: async () => null,
      deadline: Date.now() + 1_000,
    }),
  ).rejects.toThrow(/the cursor position this read must put back was not reported/)
  expect(painted.writes).toEqual([])
})

// @cto 2db35bf8 condition 2: U+2588's UTF-8 bytes contain 0x88, a C1 control on an 8-bit terminal.
// A run that measured 8-bit decoding is refused before the paint, never carried.
test("a terminal that measured 8-bit decoding is refused before the sentinel is painted (33981)", async () => {
  const painted = source()
  await expect(
    readThroughSentinel({
      source: painted.source,
      prePaint: async () => before({ x: 0, y: 0 }),
      capture: async (resolve) => resolve({ frame: windowAt({ x: 0, y: 0 }), pixelGeometry }),
      label: "cells 1,1-2,2",
      regions: [cells],
      reading: { x: 0, y: 0 },
      cell: { width: 2, height: 2 },
      cursorPosition: cursorAt,
      utf8Decoding: async () => "8-bit",
      deadline: Date.now() + 1_000,
    }),
  ).rejects.toThrow(/measured ISO-8859-1 decoding/)
  expect(painted.writes).toEqual([])
})

// @cto 2db35bf8 condition 2: a block two cells wide means the terminal took U+2588 as a wide glyph.
// The cell is half erased, so the read stops the run's sentinel use instead of reading over it — and
// it still restores what it painted.
test("a paint that covered more than one cell stops the read and restores what it wrote (33981)", async () => {
  const blank: CapturedFrame = { width: 16, height: 12, rgba: new Uint8Array(16 * 12 * 4).fill(255) }
  const picked = sentinelCellsInFrame({
    ...blank,
    reading: { x: 0, y: 0 },
    cell: { width: 2, height: 2 },
    grid,
    regions: [cells],
  })
  const { a, b } = picked
  const frame: CapturedFrame = { ...blank, rgba: Uint8Array.from(blank.rgba) }
  // Cell b comes back two cells wide, as a terminal that treats U+2588 as a wide glyph would draw it;
  // cell a is the one-cell block it should have been. (Wide on the LOWER cell: a wide block under the
  // other would merge with it and the test would be reading one region, not a wide pair.)
  for (let dy = 0; dy < 2; dy += 1) {
    for (let dx = 0; dx < 2; dx += 1) {
      frame.rgba.set([...sentinel.rgb, 255], ((a.row - 1) * 2 + dy) * 16 * 4 + ((a.col - 1) * 2 + dx) * 4)
    }
  }
  for (let dy = 0; dy < 2; dy += 1) {
    for (let dx = 0; dx < 4; dx += 1) {
      frame.rgba.set([...sentinel.rgb, 255], ((b.row - 1) * 2 + dy) * 16 * 4 + ((b.col - 1) * 2 + dx) * 4)
    }
  }
  const painted = source()
  await expect(
    readThroughSentinel({
      source: painted.source,
      prePaint: async () => blank,
      capture: async (resolve) => resolve({ frame, pixelGeometry }),
      label: "cells 1,1-2,2",
      regions: [cells],
      reading: { x: 0, y: 0 },
      cell: { width: 2, height: 2 },
      cursorPosition: cursorAt,
      deadline: Date.now() + 1_000,
    }),
  ).rejects.toBeInstanceOf(SentinelPaintWiderThanCell)
  expect(painted.writes).toEqual([paintOf(picked, CURSOR), clearOf(picked, CURSOR)])
})

// @dev/15's peer read of a887dda73: a terminal that really draws U+2588 wide widens BOTH cells, and
// the diagonal pair the chooser prefers then touches — the lower block's first pixel sits directly
// under the upper block's last — so the difference yields ONE region. Judging the region COUNT first
// read that as "other change", retried to the deadline, and never threw the wide refusal, so the
// sentinel was never retired for the run. Every wide region is the evidence, and it is available
// before the count means anything.
test("a real wide U+2588, widening both painted cells, is refused before the count can misname it (33981)", async () => {
  const blank: CapturedFrame = { width: 16, height: 12, rgba: new Uint8Array(16 * 12 * 4).fill(255) }
  const picked = sentinelCellsInFrame({
    ...blank,
    reading: { x: 0, y: 0 },
    cell: { width: 2, height: 2 },
    grid,
    regions: [cells],
  })
  const { a, b } = picked
  const frame: CapturedFrame = { ...blank, rgba: Uint8Array.from(blank.rgba) }
  for (const cell of [a, b]) {
    for (let dy = 0; dy < 2; dy += 1) {
      for (let dx = 0; dx < 4; dx += 1) {
        frame.rgba.set([...sentinel.rgb, 255], ((cell.row - 1) * 2 + dy) * 16 * 4 + ((cell.col - 1) * 2 + dx) * 4)
      }
    }
  }
  const painted = source()
  await expect(
    readThroughSentinel({
      source: painted.source,
      prePaint: async () => blank,
      capture: async (resolve) => resolve({ frame, pixelGeometry }),
      label: "cells 1,1-2,2",
      regions: [cells],
      reading: { x: 0, y: 0 },
      cell: { width: 2, height: 2 },
      cursorPosition: cursorAt,
      deadline: Date.now() + 1_000,
    }),
  ).rejects.toBeInstanceOf(SentinelPaintWiderThanCell)
  // One paint and one clear: the refusal is reached on the first attempt, not after retrying.
  expect(painted.writes).toEqual([paintOf(picked, CURSOR), clearOf(picked, CURSOR)])
})

// @dev/15's second finding on a887dda73, non-blocking then and guarded here: a space written in
// current attributes is visible under reverse video on a screen that was not drawn reversed, so a
// retry's clear can leave its evidence behind. Retrying would then paint a second visible pair
// beside the first. The residue is measurable before the second paint, so the read refuses by name
// instead of scattering pairs across the probe's screen.
test("a retry whose clear did not take refuses instead of painting a second pair (33981)", async () => {
  const painted = source()
  let prepaint = 0
  await expect(
    readThroughSentinel({
      source: painted.source,
      prePaint: async () => {
        prepaint += 1
        // The first frame is the window before any paint; the retry's frame still shows the pair,
        // which is exactly what a clear that did not take looks like.
        return prepaint === 1 ? before({ x: 0, y: 0 }) : windowAt({ x: 0, y: 0 })
      },
      // The first capture shows no paint at all, so the read retries, as it would on a slow terminal.
      capture: async (resolve) => resolve({ frame: before({ x: 0, y: 0 }), pixelGeometry }),
      label: WHERE,
      regions: [cells],
      reading: { x: 0, y: 0 },
      cell: { width: pixelGeometry.cellWidth, height: pixelGeometry.cellHeight },
      cursorPosition: cursorAt,
      deadline: Date.now() + 1_000,
    }),
  ).rejects.toThrow(/clear of this read's paint did not take/)
  // The refusal throws out of the retry, and the read's contract still clears once more on the way
  // out, so the residue is written back before the error reaches the caller.
  expect(painted.writes).toEqual([PAINT, CLEAR, CLEAR])
})

// @dev/15's blocking finding on 52da0fd43: the 33000 path exists because a frame can render one
// capture late, and the paint before the clear does exactly that. A guard that judged the first
// post-clear frame refused a read that anchored fine before it existed. The residue is now waited
// out: only one that persists to the deadline refuses.
test("a clear that renders one capture late is waited out, not refused (33981, 33000)", async () => {
  const painted = source()
  let prepaint = 0
  let capturecalls = 0
  const read = await readThroughSentinel({
    source: painted.source,
    prePaint: async () => {
      prepaint += 1
      // The second pre-paint frame is the late one: it still shows the pair after the clear.
      return prepaint === 2 ? windowAt({ x: 0, y: 0 }) : before({ x: 0, y: 0 })
    },
    capture: async (resolve) => {
      capturecalls += 1
      // The first capture shows no paint at all, so the read retries; the second shows the pair.
      return resolve({
        frame: capturecalls === 1 ? before({ x: 0, y: 0 }) : windowAt({ x: 0, y: 0 }),
        pixelGeometry,
      })
    },
    label: WHERE,
    regions: [cells],
    reading: { x: 0, y: 0 },
    cell: { width: pixelGeometry.cellWidth, height: pixelGeometry.cellHeight },
    cursorPosition: cursorAt,
    deadline: Date.now() + 1_000,
  })
  expect(read.origin).toEqual({ x: 0, y: 0 })
  expect(painted.writes).toEqual([PAINT, CLEAR, PAINT, CLEAR])
})

// @dev/15's third finding: the wide verdict retires the sentinel for the whole run, so it must rest
// on a region that reaches a cell this read painted. A wide change elsewhere in the window is a
// reason to retry — and, at the deadline, a named refusal — never a reason to stop anchoring.
test("a wide change away from the painted cells stays on the retry path (33981)", async () => {
  const blank: CapturedFrame = { width: 16, height: 12, rgba: new Uint8Array(16 * 12 * 4).fill(255) }
  const elsewhere: CapturedFrame = { ...blank, rgba: Uint8Array.from(blank.rgba) }
  for (let dy = 0; dy < 2; dy += 1) {
    for (let dx = 0; dx < 8; dx += 1) {
      elsewhere.rgba.set([...sentinel.rgb, 255], (10 + dy) * 16 * 4 + dx * 4)
    }
  }
  const painted = source()
  await expect(
    readThroughSentinel({
      source: painted.source,
      prePaint: async () => blank,
      capture: async (resolve) => resolve({ frame: elsewhere, pixelGeometry }),
      label: WHERE,
      regions: [cells],
      reading: { x: 0, y: 0 },
      cell: { width: pixelGeometry.cellWidth, height: pixelGeometry.cellHeight },
      cursorPosition: cursorAt,
      deadline: Date.now() + 400,
    }),
  ).rejects.toThrow(/one disconnected region changed/)
  // It retried to the deadline — repainting the pair over and over — and never took the wide exit,
  // which is the whole point: the sentinel stays usable for the rest of the run.
  expect(painted.writes.length).toBeGreaterThan(2)
})
