/**
 * @failure Capture command bytes or failure/cleanup semantics change, retained artifacts are duplicated or overwritten, or the one converter owner changes its process count, retained bytes, deadline or malformed-output refusal.
 * @level l2
 * @consumer Capture apparatus command lifecycle, the shared converter owner, and AC4 immutable content-addressed retention.
 * @testonly none
 * @reach fs-walk <fixture-only: /tmp/terminfo-retain-witness>
 */
import { createHash } from "node:crypto"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { gunzipSync, zstdDecompressSync } from "node:zlib"
import { afterEach, expect, test } from "vitest"
import { originFromSentinel, sentinelBlockRefusal, sentinelCellsInFrame } from "@terminfo/probe-defs"
import {
  cellRectangle,
  command,
  compareLayoutGuard,
  convertCapture,
  converterIdentity,
  finishCapture,
  locateChangedColour,
  locateColour,
  retain,
  type CapturedFrame,
  type ConvertCaptureInput,
  type OriginResolver,
} from "./capture-core.ts"

const directories: string[] = []
const originalPath = process.env.PATH
const STUB_KEYS = ["STUB_CALLS", "STUB_HANG", "STUB_EXTENT", "STUB_FAIL", "STUB_RGBA_BYTES", "STUB_PNG_FILE"]
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true })
  if (originalPath === undefined) delete process.env.PATH
  else process.env.PATH = originalPath
  for (const key of STUB_KEYS) delete process.env[key]
})

function directory(): string {
  const path = mkdtempSync(join(tmpdir(), "terminfo-retain-witness-"))
  directories.push(path)
  return path
}

const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex")

// The predecoded frame is already the pixel authority. These cases catch a second decoder
// dependency and wrong stride/extent; command/retention tests do not exercise finalization.
const PNG_STUB = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0])
const FRAME_RGBA = Uint8Array.from({ length: 48 }, (_, index) => index)

test.each(["png", "xwd"] as const)(
  "capture finalizer crops the decoded %s frame and keeps its recipe",
  async (format) => {
    const input = {
      directory: directory(),
      onRetained: () => {},
      source: {
        bytes: format === "png" ? PNG_STUB : Buffer.from("retained XWD"),
        format,
        width: 4,
        height: 3,
        capturedAt: 1,
      },
      png: PNG_STUB,
      decoded: { width: 4, height: 3, rgba: FRAME_RGBA },
      origin: { origin: { x: 0, y: 0 }, basis: "measured fixture" },
      trace: {},
      checkpoint: {
        featureId: "crop-fixture",
        role: "target" as const,
        label: "two rows",
        cells: { top: 2, left: 2, bottom: 3, right: 3 },
        pixelGeometry: { cellWidth: 1, cellHeight: 1, textWidth: 4, textHeight: 3 },
      },
    }
    const result = await finishCapture(input)
    const expected = Buffer.from([20, 21, 22, 23, 24, 25, 26, 27, 36, 37, 38, 39, 40, 41, 42, 43])
    expect(result.frame.regionDigest).toBe(`sha256:${digest(expected)}`)
    expect(result.frame.regionRectangle).toEqual({ x: 1, y: 1, width: 2, height: 2 })
    expect(result.trace.cropCommand).toEqual([
      "magick",
      `${format}:-`,
      "-crop",
      "2x2+1+1",
      "+repage",
      "-depth",
      "8",
      "rgba:-",
    ])
    expect(result.trace.reproduceRegion).toContain("-crop 2x2+1+1 +repage -depth 8 rgba:- | sha256sum")
    const moved = await finishCapture({
      ...input,
      checkpoint: { ...input.checkpoint, cells: { top: 2, left: 3, bottom: 3, right: 4 } },
    })
    expect(moved.frame.regionDigest).not.toBe(result.frame.regionDigest)
  },
)

test("the finalizer records its own finish buckets and omits a decode it did not run (34261)", async () => {
  // The acquisition trace ends when acquire returns; these buckets name the rest of the call, so a
  // capture slower than its own legs can say which finish term owns the difference. A predecoded
  // fixture pins the skipped-decode contract: decodeMs is ABSENT, never a fabricated zero, while the
  // three buckets that did run are finite and non-negative. The buckets deliberately do not sum to
  // the served context.capture path, so no arithmetic between them is asserted.
  const result = await finishCapture({
    directory: directory(),
    onRetained: () => {},
    source: { bytes: PNG_STUB, format: "png", width: 4, height: 3, capturedAt: 1 },
    png: PNG_STUB,
    decoded: { width: 4, height: 3, rgba: FRAME_RGBA },
    origin: { origin: { x: 0, y: 0 }, basis: "measured fixture" },
    trace: {},
    checkpoint: {
      featureId: "finish-bucket-fixture",
      role: "target" as const,
      label: "one row",
      cells: { top: 1, left: 1, bottom: 1, right: 2 },
      pixelGeometry: { cellWidth: 1, cellHeight: 1, textWidth: 4, textHeight: 3 },
    },
  })
  const finish = result.trace.finish as Record<string, unknown> | undefined
  expect(finish).toBeDefined()
  expect(Object.hasOwn(finish ?? {}, "decodeMs")).toBe(false)
  for (const key of ["retainMs", "postDecodeMs", "totalMs"]) {
    const value = (finish ?? {})[key]
    expect(typeof value).toBe("number")
    expect(value as number).toBeGreaterThanOrEqual(0)
  }
})

test("capture finalizer writes the grid measurement beside the rectangle it mapped (#33982)", async () => {
  const witness = {
    a: { cell: { row: 1, col: 2 }, box: { x: 1, y: 0 } },
    b: { cell: { row: 2, col: 1 }, box: { x: 0, y: 1 } },
  }
  const input = {
    directory: directory(),
    onRetained: () => {},
    source: { bytes: PNG_STUB, format: "png" as const, width: 4, height: 3, capturedAt: 1 },
    png: PNG_STUB,
    decoded: { width: 4, height: 3, rgba: FRAME_RGBA },
    origin: {
      origin: { x: 0, y: 0 },
      basis: "measured fixture",
      basisKind: "sentinel pair located by frame difference",
      witness,
    },
    trace: {},
    checkpoint: {
      featureId: "crop-fixture",
      role: "target" as const,
      label: "two rows",
      cells: { top: 2, left: 2, bottom: 3, right: 3 },
      pixelGeometry: { cellWidth: 1, cellHeight: 1, textWidth: 4, textHeight: 3 },
    },
  }
  const result = await finishCapture(input)
  // Every field a later comparison needs to recognise one whole-row grid move, and nothing else: the
  // rectangle alone cannot say whether two frames cropped the same cells (33982).
  expect(result.frame.cellCrop).toEqual({
    origin: { x: 0, y: 0 },
    basis: "sentinel pair located by frame difference",
    basisDetail: "measured fixture",
    cell: { width: 1, height: 1 },
    grid: { columns: 4, rows: 3 },
    image: { width: 4, height: 3 },
    witness,
  })
  const unmeasured = await finishCapture({
    ...input,
    origin: { origin: { x: 0, y: 0 }, basis: "measured fixture" },
  })
  // A placement that names no measurement keeps its origin on the frame but cannot be exempted:
  // `basis` is absent, so `gridMoveExemption` refuses rather than guessing the two were one reading.
  expect(unmeasured.frame.cellCrop).toMatchObject({ origin: { x: 0, y: 0 }, basisDetail: "measured fixture" })
  expect(unmeasured.frame.cellCrop?.basis).toBeUndefined()
})

test("the crop record carries the changed-pixel count, and stays silent when there was none (33982)", async () => {
  // The type declared this field from the start, but nothing filled it, so every retained frame
  // dropped the one number the row-move measurement reads (@cto's step 1).
  const withCount = await finishCapture({
    directory: directory(),
    onRetained: () => {},
    source: { bytes: PNG_STUB, format: "png", width: 4, height: 3, capturedAt: 1 },
    png: PNG_STUB,
    decoded: { width: 4, height: 3, rgba: FRAME_RGBA },
    origin: {
      origin: { x: 0, y: 0 },
      basis: "measured fixture",
      basisKind: "sentinel pair located by frame difference",
      changedOutside: 797,
    },
    trace: {},
    checkpoint: {
      featureId: "crop-fixture",
      role: "target" as const,
      label: "two rows",
      cells: { top: 2, left: 2, bottom: 3, right: 3 },
      pixelGeometry: { cellWidth: 1, cellHeight: 1, textWidth: 4, textHeight: 3 },
    },
  })
  expect(withCount.frame.cellCrop?.changedOutside).toBe(797)
  // Absence is named by absence: a read that measured nothing must not publish a 0 a later bound
  // would happily accept as a quiet frame.
  const without = await finishCapture({
    directory: directory(),
    onRetained: () => {},
    source: { bytes: PNG_STUB, format: "png", width: 4, height: 3, capturedAt: 1 },
    png: PNG_STUB,
    decoded: { width: 4, height: 3, rgba: FRAME_RGBA },
    origin: {
      origin: { x: 0, y: 0 },
      basis: "measured fixture",
      basisKind: "sentinel pair located by frame difference",
    },
    trace: {},
    checkpoint: {
      featureId: "crop-fixture",
      role: "target" as const,
      label: "two rows",
      cells: { top: 2, left: 2, bottom: 3, right: 3 },
      pixelGeometry: { cellWidth: 1, cellHeight: 1, textWidth: 4, textHeight: 3 },
    },
  })
  expect(without.frame.cellCrop && "changedOutside" in without.frame.cellCrop).toBe(false)
})

test("capture finalizer crops the same-shot control region from the same decoded frame (#33117)", async () => {
  const result = await finishCapture({
    directory: directory(),
    onRetained: () => {},
    source: { bytes: PNG_STUB, format: "png", width: 4, height: 3, capturedAt: 1 },
    png: PNG_STUB,
    decoded: { width: 4, height: 3, rgba: FRAME_RGBA },
    origin: { origin: { x: 0, y: 0 }, basis: "measured fixture" },
    trace: {},
    checkpoint: {
      featureId: "crop-fixture",
      role: "target" as const,
      label: "styled row beside plain row",
      cells: { top: 2, left: 2, bottom: 3, right: 3 },
      controlCells: { top: 1, left: 2, bottom: 1, right: 3 },
      pixelGeometry: { cellWidth: 1, cellHeight: 1, textWidth: 4, textHeight: 3 },
    },
  })
  const expectedControl = Buffer.from([4, 5, 6, 7, 8, 9, 10, 11])
  expect(result.frame.controlRegionDigest).toBe(`sha256:${digest(expectedControl)}`)
  expect(result.frame.controlRegionRectangle).toEqual({ x: 1, y: 0, width: 2, height: 1 })
  expect(result.trace.reproduceControlRegion).toContain("-crop 2x1+1+0 +repage -depth 8 rgba:- | sha256sum")
  const expectedRegion = Buffer.from([20, 21, 22, 23, 24, 25, 26, 27, 36, 37, 38, 39, 40, 41, 42, 43])
  expect(result.frame.regionDigest).toBe(`sha256:${digest(expectedRegion)}`)
})

/** A 6x4 black frame with the given pixels painted one colour. */
function paintedFrame(painted: Array<[number, number]>, rgb: [number, number, number] = [255, 136, 255]) {
  const rgba = new Uint8Array(6 * 4 * 4)
  for (let offset = 3; offset < rgba.length; offset += 4) rgba[offset] = 255
  for (const [x, y] of painted) rgba.set([...rgb, 255], (y * 6 + x) * 4)
  return { width: 6, height: 4, rgba }
}

test("locate answers the bounding box and count of one exact colour, or null when it is absent (33000)", () => {
  const block = paintedFrame([
    [2, 1],
    [3, 1],
    [2, 2],
    [3, 2],
  ])
  expect(locateColour(block, [255, 136, 255])).toEqual({ box: { x: 2, y: 1, width: 2, height: 2 }, pixels: 4 })
  // Two separate pixels: the box spans both and the count says the box is not solid.
  expect(
    locateColour(
      paintedFrame([
        [0, 0],
        [5, 3],
      ]),
      [255, 136, 255],
    ),
  ).toEqual({
    box: { x: 0, y: 0, width: 6, height: 4 },
    pixels: 2,
  })
  // One channel off is a different colour.
  expect(locateColour(block, [255, 136, 254])).toBeNull()
  expect(() => locateColour(block, [256, 0, 0])).toThrow(/integer RGB colour/)
})

test("a capture request with locate answers located; one without it is the previous frame and trace exactly (33000)", async () => {
  const decoded = paintedFrame([
    [4, 2],
    [5, 2],
  ])
  const input = {
    directory: directory(),
    onRetained: () => {},
    source: { bytes: PNG_STUB, format: "png" as const, width: 6, height: 4, capturedAt: 1 },
    png: PNG_STUB,
    decoded,
    origin: { origin: { x: 0, y: 0 }, basis: "measured fixture" },
    trace: { arm: "fixture" },
  }
  const checkpoint = { featureId: "locate-fixture", role: "control" as const, label: "layout check" }
  const plain = await finishCapture({ ...input, checkpoint })
  expect(plain.frame).not.toHaveProperty("located")
  // The caller's trace object is preserved field for field; the only addition is the finalizer's
  // own diagnostic block from 34261, which this case now names rather than forbidding wholesale.
  const { finish: plainFinish, ...plainRest } = plain.trace as Record<string, unknown>
  expect(plainRest).toEqual({ arm: "fixture" })
  expect(plainFinish).toMatchObject({
    retainMs: expect.any(Number),
    postDecodeMs: expect.any(Number),
    totalMs: expect.any(Number),
  })
  const located = await finishCapture({ ...input, checkpoint: { ...checkpoint, locate: { rgb: [255, 136, 255] } } })
  expect(located.frame.located).toEqual({ box: { x: 4, y: 2, width: 2, height: 1 }, pixels: 2 })
  expect(located.trace.locate).toEqual({ rgb: [255, 136, 255], located: located.frame.located })
  const { located: _answer, ...rest } = located.frame
  expect(rest).toEqual(plain.frame)
  const absent = await finishCapture({ ...input, checkpoint: { ...checkpoint, locate: { rgb: [1, 2, 3] } } })
  expect(absent.frame.located).toBeNull()
})

/**
 * The same 12x8 window drawn with its text area at `origin`: the probe's cells carry a pattern that
 * depends only on where a pixel sits inside its cell, and calibration's sentinel is one solid block
 * on `witness`. Nothing else is painted, so the only difference between two frames is where the
 * window put the same drawing.
 */
function drawnWindow(
  origin: { x: number; y: number },
  witness: { row: number; col: number },
  cells: { top: number; left: number; bottom: number; right: number },
  sentinel: readonly [number, number, number],
): CapturedFrame {
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
      paint(origin.x + (witness.col - 1) * 2 + dx, origin.y + (witness.row - 1) * 2 + dy, [...sentinel, 255])
    }
  }
  return { width, height, rgba }
}

test("a moved window digests the same cells, because the crop follows the sentinel the read paints (33000)", async () => {
  const sentinel = [255, 136, 255] as const
  const pixelGeometry = { cellWidth: 2, cellHeight: 2, textWidth: 12, textHeight: 8 }
  const cells = { top: 1, left: 1, bottom: 2, right: 2 }
  // The cell the frame-based chooser picks for this window: the first all-background cell outside the
  // region whose neighbours are background too — the cell next to the region's ink could be the blank
  // half of a wide glyph (@dev/10's rule).
  const witness = sentinelCellsInFrame({
    ...drawnWindow({ x: 0, y: 0 }, { row: 0, col: 0 }, cells, sentinel),
    reading: { x: 0, y: 0 },
    cell: { width: pixelGeometry.cellWidth, height: pixelGeometry.cellHeight },
    grid: { rows: 4, cols: 6 },
    regions: [cells],
  }).a
  // The chooser's order is above the region, then below it, then nearest first (34040 condition 1),
  // so the pair's first cell is the one under the region — not 1,4, which is what the row-major scan
  // these tests were written against used to return. The identity is the chooser's to decide; what
  // this test proves is that the crop and the digest both follow whatever cell it painted.
  expect(witness).toEqual({ row: 3, col: 1 })
  const calibrated = { origin: { x: 0, y: 0 }, basis: "complete raster calibration" }
  // The fix under test: the crop is taken from where the sentinel actually landed in THIS frame,
  // with the same one-cell block test the post-hoc layout check uses.
  const anchoredOnSentinel: OriginResolver = ({ frame, pixelGeometry: measured }) => {
    const located = locateColour(frame, sentinel)
    if (located === null) throw new Error("calibration's sentinel is nowhere in the frame this read digests")
    const size = { width: measured.cellWidth, height: measured.cellHeight }
    const refusal = sentinelBlockRefusal(located, size)
    if (refusal) throw new Error(`calibration's sentinel is not one cell block: ${refusal}`)
    return { origin: originFromSentinel(located, witness, size), basis: "sentinel re-located on this frame (33000)" }
  }
  const read = (drawnAt: { x: number; y: number }, origin: typeof calibrated | OriginResolver) =>
    finishCapture({
      directory: directory(),
      onRetained: () => {},
      source: { bytes: PNG_STUB, format: "png", width: 12, height: 8, capturedAt: 1 },
      png: PNG_STUB,
      decoded: drawnWindow(drawnAt, witness, cells, sentinel),
      origin,
      trace: {},
      checkpoint: { featureId: "moved-window", role: "target" as const, label: "cells 1,1-2,2", cells, pixelGeometry },
    })

  const settled = await read({ x: 0, y: 0 }, calibrated)
  const unmoved = await read({ x: 0, y: 0 }, anchoredOnSentinel)
  // The window moved one cell right and down between calibration and this read — Warp's command
  // header does exactly this to the rows calibration measured.
  const moved = { x: 2, y: 2 }
  const relocated = await read(moved, anchoredOnSentinel)
  const staleAfterMove = await read(moved, calibrated)

  // Before the fix, the same probe cells digest different bytes once the window moved.
  expect(staleAfterMove.frame.regionRectangle).toEqual({ x: 0, y: 0, width: 4, height: 4 })
  expect(staleAfterMove.frame.regionDigest).not.toBe(settled.frame.regionDigest)
  // After it, the rectangle follows the window and the bytes behind it are the same bytes.
  expect(relocated.frame.regionRectangle).toEqual({ x: 2, y: 2, width: 4, height: 4 })
  expect(relocated.frame.regionDigest).toBe(settled.frame.regionDigest)
  // A genuine no-change still reads as no change: the held-out check this must not break.
  expect(unmoved.frame.regionRectangle).toEqual(settled.frame.regionRectangle)
  expect(unmoved.frame.regionDigest).toBe(settled.frame.regionDigest)
})

test.each([
  { width: 3, height: 3, rgba: FRAME_RGBA },
  { width: 4, height: 2, rgba: FRAME_RGBA },
  { width: 4, height: 3, rgba: FRAME_RGBA.subarray(0, 47) },
])("capture finalizer rejects decoded extent or byte-length mismatch: $width x $height", async (decoded) => {
  await expect(
    finishCapture({
      directory: directory(),
      onRetained: () => {},
      source: { bytes: PNG_STUB, format: "png", width: 4, height: 3, capturedAt: 1 },
      png: PNG_STUB,
      decoded,
      origin: { origin: { x: 0, y: 0 }, basis: "measured fixture" },
      trace: {},
      checkpoint: { featureId: "mismatch-fixture", role: "target", label: "mismatched decoded frame" },
    }),
  ).rejects.toThrow(/Decoded capture.*source/)
})

test.each<{
  name: string
  source?: string
  input?: Buffer
  deadline?: boolean
  step?: { step: string; budgetMs?: number }
  stdout?: Buffer
  error?: Record<string, unknown>
  stream?: "stdout" | "stderr"
  observerThrows?: boolean
}>([
  {
    name: "binary stdin/stdout/stderr",
    source: "process.stdin.pipe(process.stdout); process.stderr.write(Buffer.from([0,255,10]))",
    input: Buffer.from([0, 17, 255, 10]),
    stdout: Buffer.from([0, 17, 255, 10]),
  },
  {
    name: "native nonzero exit",
    source:
      "process.stdout.write(Buffer.from([17,0,23])); process.stderr.write(Buffer.from([100,0,255,10])); process.exit(17)",
    error: { code: 17, killed: false, signal: null },
  },
  { name: "missing executable", error: { code: "ENOENT" } },
  {
    name: "deadline SIGKILL",
    source: "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)",
    deadline: true,
    step: { step: "window census", budgetMs: 500 },
    error: { killed: true, signal: "SIGKILL" },
  },
  { name: "default SIGTERM", source: "setInterval(()=>{},1000)", error: { killed: true, signal: "SIGTERM" } },
  {
    name: "stdout overflow",
    source: "process.stdout.write(Buffer.alloc(32*1024*1024+1,7)); setInterval(()=>{},1000)",
    stream: "stdout",
    error: { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", killed: true },
  },
  {
    name: "stderr overflow",
    source: "process.stderr.write(Buffer.alloc(32*1024*1024+1,7)); setInterval(()=>{},1000)",
    stream: "stderr",
    error: { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", killed: true },
  },
  {
    name: "stderr observer throws",
    source: "process.stderr.write('observer bytes')",
    observerThrows: true,
    error: { message: "observer refused" },
  },
  {
    name: "stdin error",
    source: "require('node:fs').closeSync(0); setTimeout(()=>{},100)",
    input: Buffer.alloc(1024 * 1024),
    error: { code: "EPIPE" },
  },
])(
  "capture command contract: $name",
  async ({ source, input, deadline, step, stdout, error, stream, observerThrows }) => {
    const observed: Buffer[] = []
    const invocation = command(
      source === undefined ? join(directory(), "absent-command") : process.execPath,
      source === undefined ? [] : ["-e", source],
      input,
      deadline ? Date.now() + 500 : undefined,
      (stderr) => {
        observed.push(stderr)
        if (observerThrows) throw new Error("observer refused")
      },
      undefined,
      step,
    )
    if (error === undefined) {
      expect(await invocation).toEqual(stdout)
      expect(observed).toEqual([Buffer.from([0, 255, 10])])
      return
    }
    const failure = await invocation.then(
      () => {
        throw new Error("Expected capture command to reject")
      },
      (cause: unknown) => cause as Error & { captureCommand?: { stdoutBase64: string; stderrBase64: string } },
    )
    const diagnostic = Object.fromEntries(Object.keys(error).map((key) => [key, Reflect.get(failure, key)]))
    expect(diagnostic).toMatchObject(error)
    if (step !== undefined) {
      // #34892: our own timer killed it, so the message names the step and the budget it passed and
      // never reads as the measured app's bare signal.
      expect(failure.message).toContain(step.step)
      expect(failure.message).toMatch(/this collector's own deadline/)
      expect(failure.message).not.toMatch(/failed: SIGKILL/)
      if (step.budgetMs !== undefined) expect(failure.message).toContain(`${step.budgetMs} ms budget`)
    }
    if (source?.includes("process.exit(17)")) {
      expect(failure.captureCommand).toMatchObject({
        stdoutBase64: Buffer.from([17, 0, 23]).toString("base64"),
        stderrBase64: Buffer.from([100, 0, 255, 10]).toString("base64"),
        code: 17,
        signal: null,
        killed: false,
      })
    }
    if (stream !== undefined) {
      const retained = failure.captureCommand?.[stream === "stdout" ? "stdoutBase64" : "stderrBase64"]
      expect(retained).toBeDefined()
      const retainedBytes = Buffer.from(retained!, "base64")
      expect(retainedBytes.length).toBe(32 * 1024 * 1024)
      expect(retainedBytes.equals(Buffer.alloc(32 * 1024 * 1024, 7))).toBe(true)
    }
  },
  15000,
)

test("a retained X window dump is stored zstd-compressed and named by its stored bytes (34127)", async () => {
  // An app run's disk is 99.9% raw dumps, so the retained copy is compressed. The requirement is that
  // every source byte stays recoverable AND that the run's generic stored-byte bindings still hold:
  // the observer's {path, sha256}, the file name and sourceRef all name the bytes on disk. A test of
  // retain() alone cannot see this; only the finalizer chooses what retain() is given.
  const dir = directory()
  const raw = Buffer.concat(Array.from({ length: 64 }, () => Buffer.from("XWD header and repeated window pixels ")))
  const retained: Array<{ path: string; sha256: string }> = []
  const result = await finishCapture({
    directory: dir,
    onRetained: (artifact) => retained.push(artifact),
    source: { bytes: raw, format: "xwd", width: 4, height: 3, capturedAt: 1 },
    png: PNG_STUB,
    decoded: { width: 4, height: 3, rgba: FRAME_RGBA },
    origin: { origin: { x: 0, y: 0 }, basis: "measured fixture" },
    trace: {},
    checkpoint: {
      featureId: "xwd-retention-fixture",
      role: "target" as const,
      label: "two rows",
      cells: { top: 2, left: 2, bottom: 3, right: 3 },
      pixelGeometry: { cellWidth: 1, cellHeight: 1, textWidth: 4, textHeight: 3 },
    },
  })
  const stored = retained.find(({ path }) => !path.endsWith(".png"))
  if (!stored) throw new Error("the X window dump was not retained")
  const bytes = readFileSync(stored.path)
  expect(stored.path).toBe(join(dir, `${stored.sha256}.xwd.zst`))
  expect(digest(bytes)).toBe(stored.sha256)
  expect(result.frame.sourceRef).toBe(`sha256:${stored.sha256}`)
  expect(bytes.length).toBeLessThan(raw.length)
  expect(zstdDecompressSync(bytes).equals(raw)).toBe(true)
  expect((result.trace.retained as Record<string, string>).xwd).toBe(`${stored.sha256}.xwd.zst`)
  // The PNG, its digest and the reproduction recipe are untouched by the source's encoding.
  expect(result.frame.ref).toBe(`sha256:${digest(PNG_STUB)}`)
  expect(readdirSync(dir).sort()).toEqual([`${digest(PNG_STUB)}.png`, `${stored.sha256}.xwd.zst`].sort())
  expect(result.trace.reproduceWhole).toBe(`magick ${digest(PNG_STUB)}.png -depth 8 rgba:- | sha256sum`)
})

test("an identical repeat is the same artifact: same ref, one file, bytes untouched (#30764 AC4)", () => {
  const dir = directory()
  const bytes = Buffer.from("\u0089PNG\r\n\u001a\n same screen, same bytes")

  const first = retain(dir, bytes, "png", () => {})
  const second = retain(dir, bytes, "png", () => {})

  expect(first).toBe(`sha256:${digest(bytes)}`)
  expect(second).toBe(first)
  expect(readdirSync(dir)).toEqual([`${digest(bytes)}.png`])
  expect(readFileSync(join(dir, `${digest(bytes)}.png`)).equals(bytes)).toBe(true)
})

test("different bytes behind an existing name are named, never overwritten (#30764 AC4)", () => {
  const dir = directory()
  const bytes = Buffer.from("the bytes the digest names")
  const impostor = Buffer.from("different bytes, same name")
  const path = join(dir, `${digest(bytes)}.bin`)
  writeFileSync(path, impostor)

  expect(() => retain(dir, bytes, "bin", () => {})).toThrow(/digest collision/)
  expect(readFileSync(path).equals(impostor)).toBe(true)
})

test("the extension is part of the name: one digest may hold two encodings without collision (#30764 AC4)", () => {
  const dir = directory()
  const bytes = Buffer.from("one capture, two extensions")

  const png = retain(dir, bytes, "png", () => {})
  const xwd = retain(dir, bytes, "xwd", () => {})

  expect(png).toBe(xwd)
  expect(readdirSync(dir).sort()).toEqual([`${digest(bytes)}.png`, `${digest(bytes)}.xwd`])
})

test("a region that leaves the frame refuses by name and never shrinks to fit (34163)", () => {
  // The numbers are the kitty scrollback.viewport-hold-output refusal: 20 rows of 29 px cells from a
  // text origin 155 px down cannot fit a 600 px frame. The refusal has to carry the rectangle, the
  // frame, the cell pitch and the origin's basis, because those four are what settle whether the
  // origin, the pitch or the frame is the wrong number.
  const input = {
    cells: { top: 1, left: 1, bottom: 20, right: 10 },
    pixelGeometry: { cellWidth: 13, cellHeight: 29, textWidth: 1040, textHeight: 580 },
    textOrigin: { x: 3, y: 155 },
    windowWidth: 800,
    windowHeight: 600,
    basis: "sentinel pair located by frame difference",
  }
  expect(() => cellRectangle(input)).toThrow(
    'Capture rectangle {"x":3,"y":155,"width":130,"height":580} leaves the measured 800x600 window for cells {"top":1,"left":1,"bottom":20,"right":10}: 13x29 cells from text origin 3,155 (origin basis: sentinel pair located by frame difference) over a 1040x580 text area',
  )
  // The visible-text-area clip is not a licence to shrink: the same extent still refuses.
  expect(() => cellRectangle({ ...input, visible: { width: 1040, height: 580 } })).toThrow(
    /leaves the measured 800x600 window/,
  )
  // A placement that does fit is accepted, so the refusal is about the extent, not the origin.
  expect(
    cellRectangle({ ...input, textOrigin: { x: 3, y: 5 }, pixelGeometry: { ...input.pixelGeometry, cellHeight: 22 } }),
  ).toEqual({ x: 3, y: 5, width: 130, height: 440 })
  // An origin with no settled name says so, rather than leaving the reader to guess which measurement lied.
  expect(() => cellRectangle({ ...input, basis: undefined })).toThrow(/origin basis unnamed/)
  // A located pair travels with the refusal: the cells the code believed it painted beside the boxes
  // it found are the only record of a pair that slid down the grid.
  expect(() =>
    cellRectangle({
      ...input,
      witness: {
        a: { cell: { row: 2, col: 3 }, box: { x: 29, y: 184 } },
        b: { cell: { row: 1, col: 4 }, box: { x: 42, y: 155 } },
      },
      changedOutside: 7,
    }),
  ).toThrow(/sentinel witness cells 2,3 at 29,184 and 1,4 at 42,155; 7 px changed outside those boxes/)
})

test("locateChangedColour admits only changed pixels in the calibrated sentinel member set, while locateColour stays exact (34480)", () => {
  const pack = (r: number, g: number, b: number) => (r << 16) | (g << 8) | b
  const sentinelMembers = new Set<number>([pack(163, 117, 196), pack(162, 117, 196), pack(164, 116, 197)])
  const before: CapturedFrame = {
    width: 4,
    height: 2,
    rgba: new Uint8Array([
      32, 35, 45, 255, 32, 35, 45, 255, 162, 117, 196, 255, 32, 35, 45, 255, 32, 35, 45, 255, 32, 35, 45, 255, 32, 35,
      45, 255, 32, 35, 45, 255,
    ]),
  }
  const after: CapturedFrame = {
    width: 4,
    height: 2,
    rgba: new Uint8Array([
      // (0,0) and (1,0): changed to two occupied sentinel members -> 2x1 box at 0,0
      163, 117, 196, 255, 162, 117, 196, 255,
      // (2,0): UNCHANGED even though its RGB is in sentinelMembers -> must NOT be counted
      162, 117, 196, 255,
      // (3,0): changed to an UNOBSERVED R=1 neighbour (163,118,196) -> ignoredPixels++
      163, 118, 196, 255, 32, 35, 45, 255, 32, 35, 45, 255, 32, 35, 45, 255, 32, 35, 45, 255,
    ]),
  }
  const withMembers = locateChangedColour(before, after, [163, 117, 196], sentinelMembers)
  expect(withMembers).toEqual({
    regions: [{ box: { x: 0, y: 0, width: 2, height: 1 }, pixels: 2 }],
    ignoredPixels: 1,
  })
  // Without sentinelMembers, only the exact anchor (0,0) matches.
  const exactOnly = locateChangedColour(before, after, [163, 117, 196])
  expect(exactOnly).toEqual({
    regions: [{ box: { x: 0, y: 0, width: 1, height: 1 }, pixels: 1 }],
    ignoredPixels: 2,
  })
  // Generic locateColour stays exact single-RGB and never matches the R=1 dither neighbour at (1,0) or (2,0).
  expect(locateColour(after, [163, 117, 196])).toEqual({
    box: { x: 0, y: 0, width: 1, height: 1 },
    pixels: 1,
  })
})

/**
 * A stub `magick` on PATH that logs each invocation's argv, answers `-version` and `info:`, writes the
 * PNG named by `-write`, and prints STUB_RGBA_BYTES zero bytes of RGBA. STUB_HANG names the one
 * command kind that sleeps instead, so a deadline can be shown to reach that command.
 */
function stubMagick() {
  const root = directory()
  const bin = join(root, "bin")
  const scratch = join(root, "scratch")
  mkdirSync(bin)
  mkdirSync(scratch)
  const pngFile = join(root, "stub.png")
  writeFileSync(pngFile, PNG_STUB)
  const callsPath = join(root, "calls")
  writeFileSync(
    join(bin, "magick"),
    [
      "#!/bin/sh",
      String.raw`printf '%s\037' "$@" >> "$STUB_CALLS"; printf '\n' >> "$STUB_CALLS"`,
      "cat > /dev/null",
      "kind=decode; out=; prev=",
      "for arg; do",
      '  [ "$arg" = info: ] && kind=info',
      '  [ "$arg" = -version ] && kind=version',
      '  [ "$prev" = -write ] && out=${arg#png:}',
      "  prev=$arg",
      "done",
      'if [ "$kind" = "${STUB_HANG:-}" ]; then exec sleep 30; fi',
      'case "$kind" in',
      "  version) echo 'ImageMagick stub' ;;",
      "  info) printf '%s' \"${STUB_EXTENT:-2x1}\" ;;",
      "  decode)",
      '    if [ -n "$out" ]; then cat "$STUB_PNG_FILE" > "$out"; fi',
      "    if [ \"${STUB_FAIL:-}\" = decode ]; then echo 'stub conversion failed' >&2; exit 19; fi",
      '    head -c "${STUB_RGBA_BYTES:-8}" /dev/zero ;;',
      "esac",
    ].join("\n"),
  )
  chmodSync(join(bin, "magick"), 0o700)
  process.env.PATH = `${bin}:${originalPath ?? ""}`
  process.env.STUB_CALLS = callsPath
  process.env.STUB_PNG_FILE = pngFile
  const calls = () =>
    existsSync(callsPath)
      ? readFileSync(callsPath, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((line) => line.split("\x1f").slice(0, -1))
      : []
  const reset = () => writeFileSync(callsPath, "")
  return { scratch, pngFile, calls, reset }
}

const DARWIN_PNG = Buffer.concat([PNG_STUB, Buffer.from("screencapture bytes")])

/** The three routes the adapters name, with Linux's caller-measured 2x1 window. */
function routes(scratch: string): Record<string, ConvertCaptureInput> {
  return {
    "Linux XWD": {
      bytes: Buffer.from("xwd dump"),
      format: "xwd",
      extent: { width: 2, height: 1 },
      retain: "normalized",
      scratchDirectory: scratch,
      featureId: "fixture.xwd",
    },
    "Linux pointer PNG": {
      bytes: PNG_STUB,
      format: "png",
      extent: { width: 2, height: 1 },
      retain: "normalized",
      scratchDirectory: scratch,
      featureId: "extensions.osc22-pointer",
    },
    Darwin: { bytes: DARWIN_PNG, format: "png", retain: "original", featureId: "fixture.darwin" },
  }
}

test("a conversion handed a deadline the capture already spent still converts (35129)", async () => {
  const { scratch, calls, reset } = stubMagick()
  const route = routes(scratch)
  const spent = Date.now() - 1
  // Darwin runs two magick processes (extent query, then decode); both must run despite the spent deadline.
  const darwin = await convertCapture({ ...route.Darwin!, deadline: spent })
  expect(calls()).toEqual([
    ["png:-", "-format", "%wx%h", "info:"],
    ["png:-", "-depth", "8", "rgba:-"],
  ])
  expect(darwin.frame).toEqual({ width: 2, height: 1, rgba: Buffer.alloc(8) })
  // The normalized Linux route is one process and must survive the same input.
  reset()
  const linux = await convertCapture({ ...route["Linux XWD"]!, deadline: spent })
  expect(calls()).toHaveLength(1)
  expect(linux.frame).toEqual({ width: 2, height: 1, rgba: Buffer.alloc(8) })
})

test("the converter owner runs one process per Linux route and two on Darwin; the version probe is its own (34549)", async () => {
  const { scratch, calls, reset } = stubMagick()
  const route = routes(scratch)
  const linuxArgv = (input: string, write: string) => [
    "-limit",
    "thread",
    "1",
    input,
    "-define",
    "png:exclude-chunks=date,time",
    "-set",
    "comment",
    "",
    "-write",
    write,
    "-depth",
    "8",
    "rgba:-",
  ]
  // Linux XWD: one process, the normalized PNG through a temporary file under the scratch directory.
  const xwd = await convertCapture(route["Linux XWD"]!)
  const [xwdCall, ...xwdRest] = calls()
  expect(xwdRest).toEqual([])
  expect(xwdCall![10]).toMatch(new RegExp(`^png:${scratch}/\\.converted-[^/]+/frame\\.png$`))
  expect(xwdCall).toEqual(linuxArgv("xwd:-", xwdCall![10]!))
  expect(xwd.png).toEqual(PNG_STUB)
  expect(xwd.frame).toEqual({ width: 2, height: 1, rgba: Buffer.alloc(8) })
  // Linux pointer PNG: the same single process, normalizing scrot's PNG.
  reset()
  await convertCapture(route["Linux pointer PNG"]!)
  const [pointerCall, ...pointerRest] = calls()
  expect(pointerRest).toEqual([])
  expect(pointerCall).toEqual(linuxArgv("png:-", pointerCall![10]!))
  expect(readdirSync(scratch)).toEqual([])
  // Darwin: the extent query, then the decode; the screencapture bytes are retained unchanged.
  reset()
  const darwin = await convertCapture(route.Darwin!)
  expect(calls()).toEqual([
    ["png:-", "-format", "%wx%h", "info:"],
    ["png:-", "-depth", "8", "rgba:-"],
  ])
  expect(darwin.png).toBe(DARWIN_PNG)
  expect(darwin.frame).toEqual({ width: 2, height: 1, rgba: Buffer.alloc(8) })
  // The converter identity: one separate process, never part of an acquisition.
  reset()
  expect(await converterIdentity()).toBe("ImageMagick stub")
  expect(calls()).toEqual([["-version"]])
})

test("malformed conversion output throws on every route and never yields a frame (34549)", async () => {
  const { scratch, pngFile, calls, reset } = stubMagick()
  const route = routes(scratch)
  // A short RGBA stream with a caller-measured extent: one info: words the error, then it throws.
  process.env.STUB_RGBA_BYTES = "4"
  for (const name of ["Linux XWD", "Linux pointer PNG"]) {
    reset()
    await expect(convertCapture(route[name]!)).rejects.toThrow(/returned 4 RGBA bytes; 2x1 at depth 8 rgba is 8$/)
    expect(calls().map((call) => call.at(-1))).toEqual(["rgba:-", "info:"])
  }
  process.env.STUB_EXTENT = "3x1"
  reset()
  await expect(convertCapture(route["Linux XWD"]!)).rejects.toThrow(
    "capture 3x1 differs from window 2x1 (border included?)",
  )
  expect(calls()).toHaveLength(2)
  // Darwin measured the extent itself, so the mismatch is named without a third process.
  process.env.STUB_EXTENT = "2x1"
  reset()
  await expect(convertCapture(route.Darwin!)).rejects.toThrow(/returned 4 RGBA bytes; 2x1 at depth 8 rgba is 8$/)
  expect(calls()).toHaveLength(2)
  // Bytes that are not a PNG are refused on the normalized and the original route alike.
  delete process.env.STUB_RGBA_BYTES
  writeFileSync(pngFile, "not a png")
  await expect(convertCapture(route["Linux XWD"]!)).rejects.toThrow(
    "Capture conversion did not produce PNG bytes for fixture.xwd",
  )
  await expect(convertCapture({ ...route.Darwin!, bytes: Buffer.from("not a png") })).rejects.toThrow(
    "Capture conversion did not produce PNG bytes for fixture.darwin",
  )
  expect(readdirSync(scratch)).toEqual([])
})

test("a failed normalized conversion removes its temporary directory (34549)", async () => {
  const { scratch } = stubMagick()
  process.env.STUB_FAIL = "decode"
  await expect(convertCapture(routes(scratch)["Linux XWD"]!)).rejects.toThrow("stub conversion failed")
  expect(readdirSync(scratch)).toEqual([])
})

test.each([
  { route: "Linux XWD", hang: "decode", short: false },
  { route: "Linux XWD", hang: "info", short: true },
  { route: "Darwin", hang: "info", short: false },
  { route: "Darwin", hang: "decode", short: false },
])(
  "the caller's deadline reaches the $route route's $hang command (34549)",
  async ({ route, hang, short }) => {
    const { scratch } = stubMagick()
    process.env.STUB_HANG = hang
    if (short) process.env.STUB_RGBA_BYTES = "4"
    const started = Date.now()
    await expect(convertCapture({ ...routes(scratch)[route]!, deadline: started + 800 })).rejects.toMatchObject({
      killed: true,
      signal: "SIGKILL",
    })
    expect(Date.now() - started).toBeLessThan(5_000)
    expect(readdirSync(scratch)).toEqual([])
  },
  10_000,
)

// #34932 (@cto 34932-five-criteria-ruling-2216 item 5): the bounded layout-guard comparison. The retained pair is
// the real kitty Linux guard whose exact digests differed while nothing moved: 18 glyph-edge pixels one step
// apart. Existing guard tests compare digests only, so they cannot tell that pair from a moved layout.
const GUARD_PAIR = JSON.parse(
  readFileSync(join(import.meta.dirname, "fixtures/kitty-placeholder-guard-pair.json"), "utf8"),
) as { width: number; height: number; withImage: string; withoutImage: string }
const guardCrop = (encoded: string) => ({
  width: GUARD_PAIR.width,
  height: GUARD_PAIR.height,
  rgba: new Uint8Array(gunzipSync(Buffer.from(encoded, "base64"))),
})
/** The crop's own background colour, the only member these fixtures witness. */
const BLACK = new Set([0])

/** The same crop moved by whole pixels, the uncovered edge filled with background. */
function shifted(crop: ReturnType<typeof guardCrop>, dx: number, dy: number) {
  const rgba = new Uint8Array(crop.rgba.length)
  for (let offset = 3; offset < rgba.length; offset += 4) rgba[offset] = 255
  for (let y = 0; y < crop.height; y++) {
    for (let x = 0; x < crop.width; x++) {
      const sx = x - dx
      const sy = y - dy
      if (sx < 0 || sy < 0 || sx >= crop.width || sy >= crop.height) continue
      rgba.set(crop.rgba.subarray((sy * crop.width + sx) * 4, (sy * crop.width + sx) * 4 + 4), (y * crop.width + x) * 4)
    }
  }
  return { ...crop, rgba }
}

/** The first pixel of the crop that is ink (not background) when `ink`, else background. */
function firstPixel(crop: ReturnType<typeof guardCrop>, ink: boolean): number {
  for (let offset = 0; offset < crop.rgba.length; offset += 4) {
    const packed = ((crop.rgba[offset] ?? 0) << 16) | ((crop.rgba[offset + 1] ?? 0) << 8) | (crop.rgba[offset + 2] ?? 0)
    if (BLACK.has(packed) !== ink && (crop.rgba[offset] ?? 0) < 250) return offset
  }
  throw new Error("fixture has no such pixel")
}

test("the retained kitty guard pair holds: 18 pixels one step apart, the background/ink mask identical", () => {
  const verdict = compareLayoutGuard(guardCrop(GUARD_PAIR.withImage), guardCrop(GUARD_PAIR.withoutImage), BLACK)
  expect(verdict).toEqual({
    holds: true,
    width: 39,
    height: 87,
    changedPixels: 18,
    maxChannelDelta: 1,
    alphaExact: true,
    maskChangedPixels: 0,
    backgroundMembers: 1,
  })
})

test.each([
  { name: "a glyph moved one pixel right", dx: 1, dy: 0 },
  { name: "a glyph moved one pixel down", dx: 0, dy: 1 },
])("$name fails the guard", ({ dx, dy }) => {
  const still = guardCrop(GUARD_PAIR.withoutImage)
  const verdict = compareLayoutGuard(still, shifted(still, dx, dy), BLACK)
  expect(verdict.holds).toBe(false)
  expect(verdict.maskChangedPixels).toBeGreaterThan(0)
  expect(verdict.reason).toBeDefined()
})

test("new ink, a channel delta of 2, an alpha change and changed dimensions each fail by name", () => {
  const still = guardCrop(GUARD_PAIR.withoutImage)
  const inked = { ...still, rgba: new Uint8Array(still.rgba) }
  inked.rgba.set([200, 200, 200], firstPixel(still, false))
  expect(compareLayoutGuard(still, inked, BLACK)).toMatchObject({ holds: false, maskChangedPixels: 1 })

  const two = { ...still, rgba: new Uint8Array(still.rgba) }
  const ink = firstPixel(still, true)
  two.rgba[ink] = (two.rgba[ink] ?? 0) + 2
  expect(compareLayoutGuard(still, two, BLACK)).toMatchObject({
    holds: false,
    maxChannelDelta: 2,
    maskChangedPixels: 0,
    reason: "an RGB channel differs by 2",
  })

  const alpha = { ...still, rgba: new Uint8Array(still.rgba) }
  alpha.rgba[3] = 254
  expect(compareLayoutGuard(still, alpha, BLACK)).toMatchObject({
    holds: false,
    alphaExact: false,
    reason: "alpha differs",
  })

  const narrower = { width: 38, height: 87, rgba: new Uint8Array(38 * 87 * 4) }
  expect(compareLayoutGuard(still, narrower, BLACK)).toMatchObject({
    holds: false,
    reason: "the crops are 39x87 and 38x87",
  })
})

test("one step across the witnessed background boundary, or no witnessed members, fails the guard", () => {
  const still = guardCrop(GUARD_PAIR.withoutImage)
  // Background (0,0,0) against (1,0,0): within 1, but the class changed, so the mask is not identical.
  const lifted = { ...still, rgba: new Uint8Array(still.rgba) }
  lifted.rgba[firstPixel(still, false)] = 1
  expect(compareLayoutGuard(still, lifted, BLACK)).toMatchObject({
    holds: false,
    maxChannelDelta: 1,
    maskChangedPixels: 1,
  })
  // A changed crop with no witnessed members cannot be masked; identical crops need no mask (see below).
  expect(compareLayoutGuard(still, lifted, undefined)).toMatchObject({
    holds: false,
    backgroundMembers: 0,
    reason: "no witnessed background members were supplied, so the background/ink mask cannot be compared",
  })
})

test("the finalizer keeps a guard crop, compares a later frame against it once, and names an unknown ref", async () => {
  const base = {
    directory: directory(),
    onRetained: () => {},
    source: { bytes: PNG_STUB, format: "png" as const, width: 4, height: 3, capturedAt: 1 },
    png: PNG_STUB,
    origin: { origin: { x: 0, y: 0 }, basis: "measured fixture" },
    trace: {},
  }
  const checkpoint = {
    featureId: "guard-fixture",
    role: "control" as const,
    label: "guard",
    cells: { top: 2, left: 2, bottom: 3, right: 3 },
    pixelGeometry: { cellWidth: 1, cellHeight: 1, textWidth: 4, textHeight: 3 },
    layoutGuardBackground: new Set([0xffffff]),
  }
  const kept = await finishCapture({
    ...base,
    decoded: { width: 4, height: 3, rgba: FRAME_RGBA },
    checkpoint: { ...checkpoint, layoutGuard: {} },
  })
  expect(kept.frame.layoutGuardComparison).toBeUndefined()
  const shaded = new Uint8Array(FRAME_RGBA)
  shaded[20] = (shaded[20] ?? 0) + 1
  const compared = await finishCapture({
    ...base,
    decoded: { width: 4, height: 3, rgba: shaded },
    checkpoint: { ...checkpoint, layoutGuard: { against: kept.frame.ref } },
  })
  expect(compared.frame.layoutGuardComparison).toMatchObject({
    against: kept.frame.ref,
    holds: true,
    changedPixels: 1,
    maxChannelDelta: 1,
  })
  // The comparison consumed the kept crop: a second comparison against it is named, never a pass.
  const again = await finishCapture({
    ...base,
    decoded: { width: 4, height: 3, rgba: shaded },
    checkpoint: { ...checkpoint, layoutGuard: { against: kept.frame.ref } },
  })
  expect(again.frame.layoutGuardComparison).toMatchObject({
    holds: false,
    reason: `no guard crop is kept for ${kept.frame.ref}`,
  })
})

// @dev/6 peer note on #34932 (7d775ef1): identical crops hold with no background members, so the evidence
// beside two equal digests never reads "does not hold".
test("identical layout-guard crops hold without background members", () => {
  const rgba = new Uint8Array([10, 20, 30, 255, 40, 50, 60, 255])
  const verdict = compareLayoutGuard(
    { width: 2, height: 1, rgba },
    { width: 2, height: 1, rgba: rgba.slice() },
    undefined,
  )
  expect(verdict).toMatchObject({ holds: true, changedPixels: 0, backgroundMembers: 0 })
  expect(verdict.reason).toBeUndefined()
  const shaded = rgba.slice()
  shaded[0] = 11
  expect(
    compareLayoutGuard({ width: 2, height: 1, rgba }, { width: 2, height: 1, rgba: shaded }, undefined),
  ).toMatchObject({
    holds: false,
    reason: "no witnessed background members were supplied, so the background/ink mask cannot be compared",
  })
})
