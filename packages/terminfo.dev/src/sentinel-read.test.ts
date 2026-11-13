/**
 * @failure A pixel read crops at calibration's stale origin instead of the sentinel it paints, or
 * leaves the painted cell behind, or refuses without naming the read (33000).
 * @level l2
 * @consumer Serve's per-read origin derivation for windows that move after calibration.
 * @testonly none
 * @reach none
 */
import { expect, test } from "vitest"
import type { CapturedFrame } from "./capture-core.ts"
import { readThroughSentinel } from "./sentinel-read.ts"

const sentinel = { form: "basic" as const, rgb: [255, 136, 255] as const }
const pixelGeometry = { cellWidth: 2, cellHeight: 2, textWidth: 12, textHeight: 8 }
const cells = { top: 1, left: 1, bottom: 2, right: 2 }

/** A 12x8 window whose text area starts at `origin`: the probe's cells carry a pattern that depends
 * only on where a pixel sits inside its cell, and the sentinel sits one solid block on `witness`. */
function windowAt(origin: { x: number; y: number }, witness: { row: number; col: number }): CapturedFrame {
  const width = 12
  const height = 8
  const rgba = new Uint8Array(width * height * 4)
  for (let offset = 3; offset < rgba.length; offset += 4) rgba[offset] = 255
  const paint = (x: number, y: number, colour: readonly number[]) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return
    rgba.set(colour, (y * width + x) * 4)
  }
  for (let row = cells.top; row <= cells.bottom; row += 1) {
    for (let col = cells.left; col <= cells.right; col += 1) {
      for (let dy = 0; dy < 2; dy += 1) {
        for (let dx = 0; dx < 2; dx += 1) {
          paint(origin.x + (col - 1) * 2 + dx, origin.y + (row - 1) * 2 + dy, [
            (row * 40 + dy * 7) % 256,
            (col * 50 + dx * 11) % 256,
            90,
            255,
          ])
        }
      }
    }
  }
  for (let dy = 0; dy < 2; dy += 1) {
    for (let dx = 0; dx < 2; dx += 1) {
      paint(origin.x + (witness.col - 1) * 2 + dx, origin.y + (witness.row - 1) * 2 + dy, [...sentinel.rgb, 255])
    }
  }
  return { width, height, rgba }
}

function source() {
  const writes: string[] = []
  return {
    writes,
    source: { rows: 4, cols: 6, write: (text: string) => writes.push(text) },
  }
}

test("the crop origin comes from where the sentinel landed in this frame, not from calibration (33000)", async () => {
  const witness = { row: 3, col: 1 }
  const read = async (drawnAt: { x: number; y: number }) => {
    const frame = windowAt(drawnAt, witness)
    const painted = source()
    const origin = await readThroughSentinel({
      source: painted.source,
      capture: async (resolve) => resolve({ frame, pixelGeometry }),
      label: "cells 1,1-2,2",
      sentinel,
      regions: [cells],
      deadline: Date.now() + 1_000,
    })
    return { origin, painted: painted.writes }
  }
  // Calibration measured this window with its text area at 0,0.
  const unmoved = await read({ x: 0, y: 0 })
  expect(unmoved.origin.origin).toEqual({ x: 0, y: 0 })
  // The window moved one cell right and down before the read: the same witness cell now sits two
  // pixels further out, and the origin follows it exactly — one pixel of movement is not rounded away.
  const moved = await read({ x: 2, y: 2 })
  expect(moved.origin.origin).toEqual({ x: 2, y: 2 })
  const nudged = await read({ x: 1, y: 3 })
  expect(nudged.origin.origin).toEqual({ x: 1, y: 3 })
  // The basis names the cell the read painted, so the artifact says what anchored it.
  expect(moved.origin.basis).toBe("sentinel re-located on this frame at cell 3,1 (33000)")
  // One paint on the witness cell, then one blank restore of that same cell — nothing else.
  expect(moved.painted).toEqual(["\x1b7\x1b[3;1H\x1b[0m\x1b[45m \x1b[0m\x1b8", "\x1b7\x1b[3;1H\x1b[0m \x1b8"])
})

test("a frame without this read's sentinel refuses by name, and the painted cell is still restored (33000)", async () => {
  const frame: CapturedFrame = { width: 12, height: 8, rgba: new Uint8Array(12 * 8 * 4).fill(255) }
  const painted = source()
  await expect(
    readThroughSentinel({
      source: painted.source,
      capture: async (resolve) => resolve({ frame, pixelGeometry }),
      label: "cells 1,1-2,2",
      sentinel,
      regions: [cells],
      deadline: Date.now() + 1_000,
    }),
  ).rejects.toThrow(
    "cells 1,1-2,2: calibration's sentinel painted at cell 3,1 is nowhere in the frame this read digests, so its crop cannot be anchored",
  )
  expect(painted.writes).toEqual(["\x1b7\x1b[3;1H\x1b[0m\x1b[45m \x1b[0m\x1b8", "\x1b7\x1b[3;1H\x1b[0m \x1b8"])
})

test("a sentinel colour that is not one solid block refuses by name rather than anchoring a crop (33000)", async () => {
  const frame = windowAt({ x: 0, y: 0 }, { row: 3, col: 1 })
  // A second pixel of the same colour away from the witness block: the box now spans both, so the
  // block test cannot agree with the cell size and the read must not guess.
  frame.rgba.set([...sentinel.rgb, 255], (0 * 12 + 11) * 4)
  const painted = source()
  await expect(
    readThroughSentinel({
      source: painted.source,
      capture: async (resolve) => resolve({ frame, pixelGeometry }),
      label: "cells 1,1-2,2",
      sentinel,
      regions: [cells],
      deadline: Date.now() + 1_000,
    }),
  ).rejects.toThrow(
    "cells 1,1-2,2: calibration's sentinel painted at cell 3,1 is not one cell block: 5 px in a 12x6 box, against a 2x2 cell at 0,0",
  )
  expect(painted.writes.at(-1)).toBe("\x1b7\x1b[3;1H\x1b[0m \x1b8")
})

test("a capture that fails for its own reason still restores the cell, and keeps its own error (33000)", async () => {
  const painted = source()
  const failure = new Error("the window went away")
  await expect(
    readThroughSentinel({
      source: painted.source,
      capture: async () => {
        throw failure
      },
      label: "cells 1,1-2,2",
      sentinel,
      regions: [cells],
      deadline: Date.now() + 1_000,
    }),
  ).rejects.toBe(failure)
  expect(painted.writes).toEqual(["\x1b7\x1b[3;1H\x1b[0m\x1b[45m \x1b[0m\x1b8", "\x1b7\x1b[3;1H\x1b[0m \x1b8"])
})

test("a capture that lands one write behind the paint is captured again, not refused (33000)", async () => {
  const witness = { row: 3, col: 1 }
  const painted = source()
  const blank: CapturedFrame = { width: 12, height: 8, rgba: new Uint8Array(12 * 8 * 4).fill(255) }
  const frames = [blank, windowAt({ x: 2, y: 2 }, witness)]
  let captures = 0
  const origin = await readThroughSentinel({
    source: painted.source,
    capture: async (resolve) => {
      const frame = frames[captures]
      captures += 1
      if (frame === undefined) throw new Error("fixture ran out of frames")
      return resolve({ frame, pixelGeometry })
    },
    label: "cells 1,1-2,2",
    sentinel,
    regions: [cells],
    deadline: Date.now() + 1_000,
  })
  expect(captures).toBe(2)
  expect(origin.origin).toEqual({ x: 2, y: 2 })
  // Still one paint and one restore around the whole read, however many captures it took.
  expect(painted.writes).toEqual(["\x1b7\x1b[3;1H\x1b[0m\x1b[45m \x1b[0m\x1b8", "\x1b7\x1b[3;1H\x1b[0m \x1b8"])
})

test("a sentinel that never appears refuses at the read's deadline and still restores (33000)", async () => {
  const painted = source()
  const blank: CapturedFrame = { width: 12, height: 8, rgba: new Uint8Array(12 * 8 * 4).fill(255) }
  let captures = 0
  await expect(
    readThroughSentinel({
      source: painted.source,
      capture: async (resolve) => {
        captures += 1
        return resolve({ frame: blank, pixelGeometry })
      },
      label: "cells 1,1-2,2",
      sentinel,
      regions: [cells],
      deadline: Date.now() - 1,
    }),
  ).rejects.toThrow(
    "cells 1,1-2,2: calibration's sentinel painted at cell 3,1 is nowhere in the frame this read digests, so its crop cannot be anchored; it did not settle before this read's deadline",
  )
  expect(captures).toBe(1)
  expect(painted.writes).toEqual(["\x1b7\x1b[3;1H\x1b[0m\x1b[45m \x1b[0m\x1b8", "\x1b7\x1b[3;1H\x1b[0m \x1b8"])
})
