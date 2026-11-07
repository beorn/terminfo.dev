/**
 * @failure The sixel fixture drifts from the ruled shape: a tile smaller than the block, a
 *   same-bytes or absent expected frame, a compared region that includes the tile's edges, a
 *   payload whose raster aspect is the VT340 2:1 default, or a spec that refuses by name instead
 *   of letting the run's existing table decide.
 * @level l1
 * @consumer extensions.sixel's pixel arm.
 * @testonly none
 */
import { expect, test } from "vitest"
import { SIXEL_CURSOR_ROW, SIXEL_REGION, sixelPayload, sixelReadback, sixelTileSize } from "./sixel-capture.ts"
import { extensionsProbes } from "./extensions.ts"
import type { ObservationFrame, TermProbeSource } from "./types.ts"

const GEOMETRY = { cellWidth: 8, cellHeight: 17, textWidth: 8 * 80, textHeight: 17 * 24 }

test("the tile is sized from this run's report and rounded UP to whole six-pixel bands", () => {
  // 3 rows of 17px = 51px, which is 8.5 bands; a cut-off tile would be 48.
  expect(sixelTileSize(GEOMETRY)).toEqual({ width: 24, height: 54 })
  expect(sixelTileSize({ ...GEOMETRY, cellHeight: 18 })).toEqual({ width: 24, height: 54 })
  expect(sixelTileSize({ ...GEOMETRY, cellWidth: 10, cellHeight: 12 })).toEqual({ width: 30, height: 36 })
})

test("a geometry that is not a positive whole-pixel report is refused by name, never guessed", () => {
  expect(() => sixelTileSize({ ...GEOMETRY, cellWidth: 0 })).toThrow(/positive whole pixels per cell/)
  expect(() => sixelTileSize({ ...GEOMETRY, cellHeight: 8.5 })).toThrow(/positive whole pixels per cell/)
  expect(() => sixelPayload({ width: 24, height: 53 })).toThrow(/not a whole number of 6-pixel bands/)
})

test("the payload declares a 1:1 raster aspect at the measured size, and paints every band solid", () => {
  const payload = sixelPayload({ width: 24, height: 54 })
  expect(payload).toContain('"1;1;24;54')
  expect(payload).toContain("#0;2;100;0;0")
  const bands = payload.split("-")
  expect(bands).toHaveLength(9)
  for (const band of bands) expect(band.replace(/^.*#0/, "").replace(/\x1b\\$/, "")).toMatch(/^~{24}$/)
})

test("the expected frame is an independent SGR route to the same pixels, not the bytes under test", () => {
  const spec = sixelReadback(GEOMETRY)
  expect(spec.seed).not.toBe(spec.expected)
  expect(spec.edit).not.toBe(spec.expected)
  // The reference is a background-painted block; it carries no sixel introducer at all.
  expect(spec.expected).not.toContain("\x1bP")
  expect(spec.expected).toContain("\x1b[48;2;255;0;0m")
  expect(spec.edit).toContain("\x1bP0;1;0q")
  // The ignored frame must preserve the target's exact body, dropping only DCS framing.
  expect(spec.noIndependentReference).toBeUndefined()
  expect(spec.ignored).toContain(sixelPayload(sixelTileSize(GEOMETRY)).slice(2, -2))
  expect(spec.ignored).not.toContain("\x1bP")
  expect(spec.ignored).not.toContain("\x1b\\")
})

test("only the block's interior cell is compared, with the sentinel and cursor outside the tile", () => {
  const spec = sixelReadback(GEOMETRY)
  expect(spec.region).toEqual({ top: 4, left: 4, bottom: 4, right: 4 })
  // The compared region lies strictly inside the 3x3 block placed at rows/cols 3..5.
  expect(spec.region.top).toBeGreaterThan(3)
  expect(spec.region.left).toBeGreaterThan(3)
  expect(spec.region.bottom).toBeLessThan(5)
  expect(spec.region.right).toBeLessThan(5)
  // Sentinel and cursor park are outside the block's extent entirely.
  expect(spec.sentinel.row).toBeLessThan(3)
  expect(spec.cursorRow).toBeGreaterThan(5)
  expect(spec.sentinel.row).not.toBe(spec.cursorRow)
  expect(SIXEL_CURSOR_ROW).toBe(spec.cursorRow)
  expect(SIXEL_REGION).toEqual(spec.region)
})

test("a pixel arm that reports no geometry refuses by name before painting anything", async () => {
  const writes: string[] = []
  const context = {
    rows: 24,
    cols: 80,
    write: (bytes: string) => writes.push(bytes),
    capture: async () => ({ role: "target" as const, label: "unused", capturedAt: 1, ref: "sha256:unused" }),
    query: async () => null,
    queryWithSentinel: async () => null,
    queryOutcome: async () => ({ match: null, reason: "timeout" as const, raw: "", rawBase64: "" }),
    queryWithSentinelOutcome: async (sequence: string) => {
      writes.push(sequence)
      return { match: null, reason: "timeout" as const, raw: "", rawBase64: "" }
    },
    queryCursorPosition: async () => null,
    queryMode: async () => null,
    measureRenderedWidth: async () => ({ kind: "no-reply", step: "sample" }) as const,
  } as unknown as TermProbeSource
  const definition = extensionsProbes.find((probe) => probe.id === "extensions.sixel")
  if (!definition?.term) throw new Error("missing app extension callback for extensions.sixel")
  const result = await definition.term(context)
  expect(result.observation).toBeUndefined()
  expect(result.tests).toMatchObject([expect.objectContaining({ status: "probe-invalid", reason: expect.any(String) })])
  expect(writes.some((write) => write.includes("\x1bP0;1;0q"))).toBe(false)
})

/** A pixel arm that reports complete same-run geometry, and a capture whose reads are byte-stable. */
function calibratedPixelArm(geometry = GEOMETRY, captureKind: "pixels" | "text-cells" = "pixels") {
  const writes: string[] = []
  let reads = 0
  const context = {
    rows: 24,
    cols: 80,
    captureKind,
    captureGeometry: { geometry, source: "measured by complete raster calibration" as const },
    write: (bytes: string) => writes.push(bytes),
    capture: async () => {
      // The two stability reads of one static frame agree; every later frame differs, so a paint
      // witness is observed instead of polled to its timeout.
      const index = reads < 2 ? 0 : reads
      reads += 1
      return {
        role: "target" as const,
        label: "unused",
        capturedAt: 1,
        ref: "sha256:unused",
        regionDigest: `sha256:region${String(index)}`,
        pixelsDigest: `sha256:whole${String(index)}`,
      }
    },
    query: async () => null,
    queryWithSentinel: async () => null,
    queryOutcome: async () => ({ match: null, reason: "timeout" as const, raw: "", rawBase64: "" }),
    queryWithSentinelOutcome: async (sequence: string) => {
      writes.push(sequence)
      return { match: null, reason: "timeout" as const, raw: "", rawBase64: "" }
    },
    queryCursorPosition: async () => null,
    queryMode: async () => null,
    measureRenderedWidth: async () => ({ kind: "no-reply", step: "sample" }) as const,
  } as unknown as TermProbeSource
  return { context, writes }
}

/** Screen's retained failure: truecolor paints nothing, indexed red works, DCS prints its body. */
function printedSixelArm(
  options: { truecolor?: boolean; indexed?: boolean; target?: "printed" | "third"; movedCrop?: boolean } = {},
) {
  const { context, writes } = calibratedPixelArm()
  let plane = "blank"
  let glyph = ""
  let reads = 0
  context.write = (bytes) => {
    writes.push(bytes)
    if (bytes.includes("\x1b[2J")) plane = "blank"
    if (bytes.includes("\x1bP0;1;0q")) plane = options.target ?? "printed"
    else if (bytes.includes('0;1;0q"1;1;24;54')) plane = "printed"
    if (bytes.includes("\x1b[48;2;255;0;0m") && options.truecolor) plane = "red"
    if (bytes.includes("\x1b[48;5;196m") && options.indexed !== false) plane = "red"
    if (/^\x1b\[1;1H.$/.test(bytes)) glyph = bytes.slice(-1)
  }
  context.capture = async ({ role, label, cells }) => {
    const frame: ObservationFrame = {
      role,
      label,
      capturedAt: ++reads,
      ref: `sha256:frame${reads}`,
      regionDigest: cells?.top === 1 && cells.left === 1 ? `witness:${glyph}` : `plane:${plane}`,
      pixelsDigest: `window:${plane}:${glyph}`,
      ...(options.movedCrop
        ? { regionRectangle: { x: label === "extensions.sixel: expected frame" ? 1 : 0, y: 0, width: 8, height: 17 } }
        : {}),
    }
    return frame
  }
  return { context, writes }
}

// The whole callback, not the generic oracle, owns the sixel bytes and retry boundary.
test.each([
  { name: "printed body with indexed fallback", options: {}, outcome: "unsupported", indexed: true },
  { name: "printed body with working truecolor", options: { truecolor: true }, outcome: "unsupported", indexed: false },
  {
    name: "nonmatching target after fallback",
    options: { target: "third" as const },
    outcome: "inconclusive",
    indexed: true,
  },
  {
    name: "nonmatching target with valid truecolor",
    options: { truecolor: true, target: "third" as const },
    outcome: "inconclusive",
    indexed: false,
  },
  { name: "collapsed indexed reference", options: { indexed: false }, outcome: "inconclusive", indexed: true },
  {
    name: "invalid crop with equal control digests",
    options: { movedCrop: true },
    outcome: "inconclusive",
    indexed: false,
  },
])("sixel controls: $name", async ({ options, outcome, indexed }) => {
  const { context, writes } = printedSixelArm(options)
  const definition = extensionsProbes.find((probe) => probe.id === "extensions.sixel")
  if (!definition?.term) throw new Error("missing sixel callback")
  const result = await definition.term(context)
  expect(result.observation?.outcome).toBe(outcome)
  expect(writes.some((bytes) => bytes.includes("\x1b[48;5;196m"))).toBe(indexed)
  if (outcome === "unsupported") {
    expect(result.observation?.note).toBe(
      "the post-sequence frame equals the sixel's own bytes written as plain text, so this terminal drew no image and passed none on",
    )
  } else if ("target" in options && options.target === "third") {
    expect(result.observation?.note).toContain("third distinct frame")
  } else if ("movedCrop" in options && options.movedCrop) {
    expect(result.tests).toContainEqual(expect.objectContaining({ status: "probe-invalid" }))
  } else {
    expect(result.observation?.note).toContain("seed frame and the expected frame read the same cells")
  }
})

test("the row sizes its tile from THIS run's reported geometry, not from a fixed value", async () => {
  // 3 cells of 8x17 is 24px wide and 51px tall, which rounds up to 54 — the payload names both.
  const { context, writes } = calibratedPixelArm()
  const definition = extensionsProbes.find((probe) => probe.id === "extensions.sixel")
  if (!definition?.term) throw new Error("missing app extension callback for extensions.sixel")
  await definition.term(context)
  expect(writes.some((write) => write.includes('"1;1;24;54'))).toBe(true)
  expect(writes.some((write) => write.includes('"1;1;30;36'))).toBe(false)
})

test("a text-cells arm is the named instrument limit before a byte, not a query that never ran", async () => {
  const { context, writes } = calibratedPixelArm(GEOMETRY, "text-cells")
  const definition = extensionsProbes.find((probe) => probe.id === "extensions.sixel")
  if (!definition?.term) throw new Error("missing app extension callback for extensions.sixel")
  const result = await definition.term(context)
  expect(result.observation).toBeUndefined()
  expect(result.tests).toMatchObject([expect.objectContaining({ status: "probe-todo", reason: expect.any(String) })])
  expect(writes).toHaveLength(0)
})
