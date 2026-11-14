/**
 * @failure A region crop that lands on window chrome after calibration (Warp's command header over
 *   rows 1-3, 33000) is reported as "cause not determined" or as two unrelated reasons, instead of
 *   naming that the window layout moved since calibration; or the layout check changes a verdict,
 *   leaves its sentinel painted, or rewrites the sentence on a window that did not move.
 * @level l1
 * @consumer Region readback reasons on app runs (terminfo.dev results for Warp and every pixel app).
 * @testonly none
 */
import { expect, test } from "vitest"
import { editingProbes } from "./editing.ts"
import {
  awaitPaintWitness,
  layoutSinceCalibration,
  originFromSentinel,
  witnessCellFor,
  type RegionCapture,
} from "./region-readback.ts"
import type { CaptureLocated, CaptureRequest, ObservationFrame, TermProbeSource } from "./types.ts"

const CELL = { width: 8, height: 16 }
const ORIGIN = { x: 17, y: 46 }
const SENTINEL_RGB = [255, 136, 255] as const
/** Warp's measured shift: the command header pushes the probe's rows 80 px (5 rows) down. */
const WARP_SHIFT = 80

type Located = CaptureLocated | null | "omitted"

function crop(region: { top: number; left: number; bottom: number; right: number }) {
  return {
    x: ORIGIN.x + (region.left - 1) * CELL.width,
    y: ORIGIN.y + (region.top - 1) * CELL.height,
    width: (region.right - region.left + 1) * CELL.width,
    height: (region.bottom - region.top + 1) * CELL.height,
  }
}

/** The witness cell 3,1's calibrated crop shifted by `dy`, as one solid cell block. */
function blockAt(dy: number): CaptureLocated {
  const at = crop({ top: 3, left: 1, bottom: 3, right: 1 })
  return { box: { ...at, y: at.y + dy }, pixels: CELL.width * CELL.height }
}

/**
 * A calibrated pixel window whose compared cells never move and whose witness cell shows the last
 * glyph written, so editing.delete-chars reaches the same-cells reason; a locate request (no cells)
 * answers `located`.
 */
function calibratedSource(located: Located | ((paintedCell: string) => Located)) {
  const writes: string[] = []
  const locates: CaptureRequest[] = []
  let reads = 0
  const context: TermProbeSource = {
    kind: "live",
    rows: 24,
    cols: 80,
    write: (sequence) => writes.push(sequence),
    queryCursorPosition: async () => ({ row: 2, col: 1 }),
    measureRenderedWidth: async () => ({ kind: "no-reply", step: "sample" }) as const,
    query: async () => null,
    queryWithSentinel: async () => null,
    queryOutcome: async () => ({ match: null, reason: "timeout", raw: "", rawBase64: "" }),
    async queryWithSentinelOutcome(sequence) {
      if (sequence === "\x1b[16t") {
        return { match: ["\x1b[6;16;8t", "16", "8"], reason: "reply", raw: "", rawBase64: "" }
      }
      if (sequence === "\x1b[14t") {
        return { match: ["\x1b[4;384;640t", "384", "640"], reason: "reply", raw: "", rawBase64: "" }
      }
      return { match: null, reason: "timeout", raw: "", rawBase64: "" }
    },
    queryMode: async () => null,
    captureGeometry: {
      geometry: { cellWidth: 8, cellHeight: 16, textWidth: 640, textHeight: 384 },
      source: "measured by complete raster calibration",
      sentinel: { form: "basic", rgb: SENTINEL_RGB },
    },
  }
  context.capture = async (request) => {
    reads += 1
    const frame: ObservationFrame = {
      role: request.role,
      label: request.label,
      capturedAt: reads,
      ref: `sha256:${String(reads % 10).repeat(64)}`,
    }
    if (request.locate) {
      locates.push(request)
      // The cell the layout check painted, from its last DECSC-wrapped paint write.
      const painted = writes.filter((entry) => entry.startsWith("\x1b7\x1b[") && entry.includes("\x1b[45m")).at(-1)
      const cell =
        painted
          ?.match(/^\x1b7\x1b\[(\d+);(\d+)H/)
          ?.slice(1)
          .join(",") ?? ""
      const answer = typeof located === "function" ? located(cell) : located
      return { ...frame, pixelsDigest: `sha256:layout-${reads}`, ...(answer === "omitted" ? {} : { located: answer }) }
    }
    const region = request.cells!
    const key = `${region.top},${region.left},${region.bottom},${region.right}`
    const witnessWrite = writes.filter((entry) => /^\x1b\[\d+;\d+H.$/.test(entry)).at(-1)
    const content = key === "3,1,3,1" ? (witnessWrite?.slice(-1) ?? "") : "unmoving"
    return {
      ...frame,
      regionDigest: `sha256:${key}|${content}`,
      pixelsDigest: `sha256:frame|${content}`,
      regionRectangle: crop(region),
    }
  }
  return { context, writes, locates }
}

async function sameCellsNote(located: Located | ((paintedCell: string) => Located)) {
  const source = calibratedSource(located)
  const probe = editingProbes.find((entry) => entry.id === "editing.delete-chars")!
  const result = await probe.term!(source.context)
  return { result, note: String(result.observation?.note), ...source }
}

test("a sentinel located on this frame gives the exact origin its crop must use (33000)", () => {
  // The window sits five rows (80 px) lower than calibration: the sentinel painted at 3,1 is found there,
  // so the origin the crop needs is the found box minus the two rows above it, not calibration's origin.
  const located = blockAt(WARP_SHIFT)
  expect(originFromSentinel(located, { row: 3, col: 1 }, CELL)).toEqual({ x: ORIGIN.x, y: ORIGIN.y + WARP_SHIFT })
  // An unmoved window reproduces calibration's own origin, which is what keeps a no-change verdict honest.
  expect(originFromSentinel(blockAt(0), { row: 3, col: 1 }, CELL)).toEqual(ORIGIN)
  // A cell other than the first proves the grid term: painting at 3,2 implies the same origin.
  const atThreeTwo = { box: crop({ top: 3, left: 2, bottom: 3, right: 2 }), pixels: CELL.width * CELL.height }
  expect(originFromSentinel(atThreeTwo, { row: 3, col: 2 }, CELL)).toEqual(ORIGIN)
  // Exact arithmetic: one pixel of movement stays one pixel. No rounding, no fitted correction.
  const nudged = { box: { ...located.box, x: located.box.x + 1 }, pixels: located.pixels }
  expect(originFromSentinel(nudged, { row: 3, col: 1 }, CELL)).toEqual({ x: ORIGIN.x + 1, y: ORIGIN.y + WARP_SHIFT })
})

test("the sentinel cell is one clear of every digested region, and a crowded grid refuses by name (33000)", () => {
  const grid = { rows: 24, cols: 80 }
  // The usual case: the cell directly above the compared region's first cell.
  expect(witnessCellFor([{ top: 3, left: 1, bottom: 5, right: 10 }], grid)).toEqual({ row: 2, col: 1 })
  // A region against the top row cannot use the cell above it, so the cell below wins instead.
  expect(witnessCellFor([{ top: 1, left: 1, bottom: 4, right: 10 }], grid)).toEqual({ row: 5, col: 1 })
  // The control region is digested from the same frame, so it is not a candidate either.
  expect(
    witnessCellFor(
      [
        { top: 3, left: 1, bottom: 5, right: 10 },
        { top: 2, left: 1, bottom: 2, right: 80 },
      ],
      grid,
    ),
  ).toEqual({ row: 6, col: 1 })
  // Every candidate taken: the read refuses rather than cropping from an unanchored frame.
  expect(() => witnessCellFor([{ top: 1, left: 1, bottom: 24, right: 80 }], grid)).toThrow(
    /No cell outside the digested region 1,1-24,80 in the 24x80 grid can carry calibration's sentinel/,
  )
  // No same-row candidate is offered (@dev/10 peer read): a neighbouring cell on the region's own
  // row can split a wide glyph straddling its edge and change the frame being digested.
  // 34040: the last row of the screen is clear, so it IS a candidate — the old fixed list of three
  // cells refused a frame whose only free row sat three rows below the region, which is the read
  // this row then could never anchor. The search finds it, and the row is not a region row.
  expect(
    witnessCellFor(
      [
        { top: 1, left: 1, bottom: 22, right: 10 },
        { top: 23, left: 1, bottom: 23, right: 10 },
      ],
      grid,
    ),
  ).toEqual({ row: 24, col: 1 })
  // A footprint that really does use every row still refuses, and now says why in plain words.
  expect(() => witnessCellFor([{ top: 1, left: 1, bottom: 22, right: 10 }], { rows: 22, cols: 80 })).toThrow(
    /every row of this 22x80 screen is inside a digested region/,
  )
})

test("a same-cells read on a window whose layout moved after calibration names the move (33000)", async () => {
  const { result, note, writes, locates } = await sameCellsNote(blockAt(WARP_SHIFT))
  expect(result.observation?.outcome).toBe("inconclusive")
  expect(note).toContain("seed frame and the expected frame read the same cells, so this run cannot separate them; ")
  expect(note).toContain(
    "window layout moved since calibration: calibration's sentinel painted at cell 3,1 landed at 17,158, 0,80 px from its calibrated crop at 17,78",
  )
  expect(locates.map((request) => request.locate)).toEqual([{ rgb: SENTINEL_RGB }])
  // Calibration's own paint at the witness cell, then that cell restored, each inside DECSC/DECRC.
  const paint = writes.indexOf("\x1b7\x1b[3;1H\x1b[0m\x1b[45m \x1b[0m\x1b8")
  expect(paint).toBeGreaterThan(-1)
  expect(writes[paint + 1]).toBe("\x1b7\x1b[3;1H\x1b[0m \x1b8")
})

test("on a window that did not move, the same-cells sentence is today's, unchanged (33000 control)", async () => {
  // Each painted cell is found in its own calibrated crop: the witness 3,1 and, since 33644, the compared region's 1,1.
  const inPlace = (cell: string): Located =>
    cell === "3,1"
      ? blockAt(0)
      : { box: crop({ top: 1, left: 1, bottom: 1, right: 1 }), pixels: CELL.width * CELL.height }
  const { note, locates } = await sameCellsNote(inPlace)
  expect(locates).toHaveLength(2)
  expect(note).toBe(
    "editing.delete-chars: the seed frame and the expected frame read the same cells, so this run cannot separate them",
  )
})

test("a same-cells read whose witness is in view but whose compared region is covered names the region (33644)", async () => {
  // Warp run 43089755106: the header covers rows 1-3; the witness (row 3 here) is found in place, the
  // region's first cell 1,1 is nowhere in the window.
  const { result, note, locates, writes } = await sameCellsNote((cell) => (cell === "3,1" ? blockAt(0) : null))
  expect(result.observation?.outcome).toBe("inconclusive")
  expect(note).toContain(
    "read the same cells, so this run cannot separate them; probe text not in view: calibration's sentinel painted at cell 1,1 is nowhere in the window",
  )
  // One locate for the witness, then the region check polls until its timeout before saying "not in view".
  expect(locates.length).toBeGreaterThan(1)
  // The region cell is painted and restored the same way the witness cell is.
  const paint = writes.indexOf("\x1b7\x1b[1;1H\x1b[0m\x1b[45m \x1b[0m\x1b8")
  expect(paint).toBeGreaterThan(-1)
  expect(writes[paint + 1]).toBe("\x1b7\x1b[1;1H\x1b[0m \x1b8")
}, 20_000)

test.each<[string, Located, string]>([
  [
    "the sentinel is nowhere in the window",
    null,
    "probe text not in view: calibration's sentinel painted at cell 3,1 is nowhere in the window",
  ],
  [
    "the colour is scattered, not one cell block",
    { box: { x: 17, y: 78, width: 8, height: 96 }, pixels: 128 },
    "sentinel found but not as one cell block: 128 px in a 8x96 box at 17,78, against a 8x16 cell painted at cell 3,1",
  ],
  [
    "the block is the wrong size",
    { box: { x: 17, y: 158, width: 16, height: 16 }, pixels: 256 },
    "sentinel found but not as one cell block: 256 px in a 16x16 box at 17,158",
  ],
  [
    "the arm returned no located field",
    "omitted",
    "layout check unanswered: the capture arm returned no located field",
  ],
])(
  "%s: its own reason, never an offset guess",
  async (_name, located, clause) => {
    const { result, note } = await sameCellsNote(located)
    expect(result.observation?.outcome).toBe("inconclusive")
    expect(note).toContain(clause)
    expect(note).not.toContain("window layout moved")
    // An absent sentinel waits out the probe's own paint timeout before it says so.
  },
  20_000,
)

test("a run whose calibration recorded no sentinel runs no check and writes nothing for it", async () => {
  const writes: string[] = []
  const clause = await layoutSinceCalibration({
    ctx: {
      write: (text) => writes.push(text),
      capture: async () => {
        throw new Error("no capture expected")
      },
      captureGeometry: {
        geometry: { cellWidth: 8, cellHeight: 16, textWidth: 640, textHeight: 384 },
        source: "measured by complete raster calibration",
      },
    },
    label: "fixture",
    cell: { row: 3, col: 1 },
    calibratedCrop: crop({ top: 3, left: 1, bottom: 3, right: 1 }),
    timeoutMs: 10,
    pollMs: 1,
  })
  expect(clause).toBeUndefined()
  expect(writes).toEqual([])
})

/** A witness that never changes while the whole frame does: Warp's ticking header timer. */
function stillWitness(frameMoves: boolean) {
  let reads = 0
  const rectangle = crop({ top: 3, left: 1, bottom: 3, right: 1 })
  const capture = (): RegionCapture => {
    reads += 1
    return {
      regionDigest: "sha256:slash-of-bin-bash",
      pixelsDigest: frameMoves ? `sha256:timer-${reads}` : "sha256:frame",
      regionRectangle: rectangle,
      frame: { role: "control", label: "witness", capturedAt: reads, ref: `sha256:${"a".repeat(64)}` },
    }
  }
  return { baseline: capture(), read: async () => capture() }
}

test("a witness timeout while the frame moved takes the layout clause in place of 'cause not determined'", async () => {
  const { baseline, read } = stillWitness(true)
  const options = {
    read,
    id: "charsets.dec-line-drawing",
    label: "charsets.dec-line-drawing: pre-edit seed",
    witnessCell: { top: 3, left: 1, bottom: 3, right: 1 },
    baseline,
    timeoutMs: 20,
    pollMs: 1,
  }
  const moved = await awaitPaintWitness({
    ...options,
    layout: async () => "window layout moved since calibration: fixture",
  })
  expect("witness" in moved).toBe(false)
  expect(String((moved as { observation?: { note?: string } }).observation?.note)).toMatch(
    /witness cell 3,1 unchanged for 20 ms after .* while the frame changed; window layout moved since calibration: fixture$/,
  )
  const unchecked = await awaitPaintWitness(options)
  expect(String((unchecked as { observation?: { note?: string } }).observation?.note)).toMatch(
    /; cause not determined$/,
  )
})

test("the layout check never runs when the frame stood still or on a roundtrip return", async () => {
  let calls = 0
  const layout = async () => {
    calls += 1
    return "should not appear"
  }
  const still = stillWitness(false)
  await awaitPaintWitness({
    read: still.read,
    id: "fixture",
    label: "fixture",
    witnessCell: { top: 3, left: 1, bottom: 3, right: 1 },
    baseline: still.baseline,
    timeoutMs: 10,
    pollMs: 1,
    layout,
  })
  const moving = stillWitness(true)
  await awaitPaintWitness({
    read: moving.read,
    id: "fixture",
    label: "fixture",
    witnessCell: { top: 3, left: 1, bottom: 3, right: 1 },
    baseline: moving.baseline,
    timeoutMs: 10,
    pollMs: 1,
    expectedDigest: "sha256:never",
    layout,
  })
  expect(calls).toBe(0)
})
