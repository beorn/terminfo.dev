/**
 * @failure Sampled cells, stale frames or failed restoration manufacture a raster geometry.
 * @level l1
 * @consumer Collector once-per-run calibration before any probe fixture
 * @testonly none
 */
import { expect, test, vi } from "vitest"
import { calibrateCaptureOrigin } from "./capture-calibration.ts"
import type { CapturedFrame } from "./capture-core.ts"
import type { TermContext, TerminalQueryOutcome } from "@terminfo/probe-defs"

const geometry = { cellWidth: 2, cellHeight: 2, textWidth: 8, textHeight: 8 }

function modeOutcome(status: string): TerminalQueryOutcome {
  const raw = `\x1b[?25;${status}$y`
  return { reason: "reply", match: [raw, status], raw, rawBase64: Buffer.from(raw).toString("base64") }
}

test.each(["timeout", "query I/O", "diagnostic I/O"] as const)("cursor-mode %s stays fatal before mutation", async (fault) => {
  const failure = new Error("Cursor mode input/output failed")
  const write = vi.fn()
  const captureRaw = vi.fn()
  const ctx = {
    rows: 4,
    cols: 4,
    write,
    queryWithSentinelOutcome: async () => {
      if (fault === "query I/O") throw failure
      if (fault === "diagnostic I/O") return { reason: "sentinel", match: null, raw: "\x1b[?62c", rawBase64: "G1s/NjJj" }
      return { reason: "timeout", match: null, raw: "", rawBase64: "" }
    },
    queryOutcome: async () => { throw failure },
  } as unknown as TermContext
  const result = calibrateCaptureOrigin({ ctx, timeoutMs: 100, captureRaw })
  if (fault !== "timeout") await expect(result).rejects.toBe(failure)
  else await expect(result).rejects.toThrow(/cursor visibility query timed out/)
  expect(write).not.toHaveBeenCalled()
  expect(captureRaw).not.toHaveBeenCalled()
})

// A terminal can answer DA1 while declining DECRQM. That is an intrinsic missing
// observable, unlike a dead exchange; neither case permits calibration mutations.
test.each([
  ["unknown", "reply", "0"],
  ["permanently visible", "reply", "3"],
  ["permanently hidden", "reply", "4"],
  ["sentinel only", "sentinel", undefined],
] as const)("calibration names a gap before mutation for %s cursor mode", async (_label, reason, status) => {
  const raw = status === undefined ? "\x1b[?1;2c" : `\x1b[?25;${status}$y`
  const outcome: TerminalQueryOutcome = {
    reason,
    match: status === undefined ? null : [raw, status],
    raw,
    rawBase64: Buffer.from(raw).toString("base64"),
  }
  const write = vi.fn()
  const captureRaw = vi.fn()
  const ctx = {
    rows: 4,
    cols: 4,
    write,
    queryMode: async () => "unknown",
    queryWithSentinelOutcome: async () => outcome,
    queryOutcome: async () => ({ reason: "timeout", match: null, raw: "", rawBase64: "" }),
  } as unknown as TermContext
  await expect(
    calibrateCaptureOrigin({ ctx, pixelGeometry: geometry, timeoutMs: 100, captureRaw }),
  ).rejects.toMatchObject({
    name: "CaptureCalibrationRefused",
    message: expect.stringMatching(/cursor visibility/),
  })
  expect(write).not.toHaveBeenCalled()
  expect(captureRaw).not.toHaveBeenCalled()
})
function frame(size = 12): CapturedFrame {
  const rgba = new Uint8Array(size * size * 4)
  for (let offset = 0; offset < rgba.length; offset += 4) rgba.set([0, 0, 0, 255], offset)
  return { width: size, height: size, rgba }
}
const blank = frame()

// The late 3px/1px pair has the same outer width and evades a two-cell sample.
function rasterFrame(stage: "solid" | "columns" | "rows", uneven = false): CapturedFrame {
  const result = frame()
  const edges = uneven ? [2, 4, 6, 9, 10] : [2, 4, 6, 8, 10]
  for (let row = 0; row < 4; row++) {
    for (let col = 0; col < 4; col++) {
      const rgb =
        stage === "solid" ? [255, 0, 255] : (stage === "columns" ? col : row) % 2 === 0 ? [255, 0, 0] : [0, 0, 0]
      for (let y = 2 + row * 2; y < 4 + row * 2; y++) {
        for (let x = edges[col]!; x < edges[col + 1]!; x++) result.rgba.set([...rgb, 255], (y * 12 + x) * 4)
      }
    }
  }
  return result
}

/** A square frame whose grid is defined by absolute column and row edges, for stripe-shape rows. */
function gridFrame(
  size: number,
  columnEdges: readonly number[],
  rowEdges: readonly number[],
  stage: "solid" | "columns" | "rows",
  leading?: "top" | "left",
): CapturedFrame {
  const rgba = new Uint8Array(size * size * 4)
  for (let offset = 0; offset < rgba.length; offset += 4) rgba.set([0, 0, 0, 255], offset)
  for (let row = 0; row < rowEdges.length - 1; row++) {
    for (let column = 0; column < columnEdges.length - 1; column++) {
      const rgb =
        stage === "solid" ? [255, 0, 255] : (stage === "columns" ? column : row) % 2 === 0 ? [255, 0, 0] : [0, 0, 0]
      for (let y = rowEdges[row]!; y < rowEdges[row + 1]!; y++) {
        for (let x = columnEdges[column]!; x < columnEdges[column + 1]!; x++) {
          rgba.set([...rgb, 255], (y * size + x) * 4)
        }
      }
    }
  }
  // The leading line is the grid's own first pixel line: the adjacent cell's paint at 217/255 over
  // black, exactly the line retained macOS frame measured at y=28.
  if (leading === "top") {
    for (let x = columnEdges[0]!; x < columnEdges[columnEdges.length - 1]!; x++) {
      const paint = (rowEdges[0]! * size + x) * 4
      for (let channel = 0; channel < 3; channel++) {
        rgba[paint + channel] = Math.round((217 / 255) * rgba[paint + channel]!)
      }
    }
  } else if (leading === "left") {
    for (let y = rowEdges[0]!; y < rowEdges[rowEdges.length - 1]!; y++) {
      const paint = (y * size + columnEdges[0]!) * 4
      for (let channel = 0; channel < 3; channel++) {
        rgba[paint + channel] = Math.round((217 / 255) * rgba[paint + channel]!)
      }
    }
  }
  return { width: size, height: size, rgba }
}

type Stage = "before grid paint" | "solid grid paint" | "column edge paint" | "row edge paint" | "restore grid paint"
function calibration(
  options: {
    geometry?: typeof geometry
    rows?: number
    cols?: number
    frames?: Partial<Record<Stage, CapturedFrame[]>>
    beforeCapture?: (label: string, writes: readonly string[]) => void
    restoredVisibility?: "set" | "reset"
    visibility?: "set" | "reset"
  } = {},
) {
  const defaults: Record<Stage, CapturedFrame> = {
    "before grid paint": blank,
    "solid grid paint": rasterFrame("solid"),
    "column edge paint": rasterFrame("columns"),
    "row edge paint": rasterFrame("rows"),
    "restore grid paint": blank,
  }
  const reads = new Map<Stage, number>()
  const writes: string[] = []
  const budgets: Array<{ label: string; deadline: number }> = []
  let now = 0
  const clock = vi.spyOn(Date, "now").mockImplementation(() => now)
  const promise = calibrateCaptureOrigin({
    ctx: {
      rows: options.rows ?? 4,
      cols: options.cols ?? 4,
      write: (text: string) => writes.push(text),
      queryMode: async () => options.restoredVisibility ?? options.visibility ?? "reset",
      queryWithSentinelOutcome: async () => modeOutcome(options.visibility === "set" ? "1" : "2"),
    } as unknown as TermContext,
    pixelGeometry: options.geometry,
    timeoutMs: 100,
    captureRaw: async (label, deadline) => {
      options.beforeCapture?.(label, writes)
      budgets.push({ label, deadline })
      const stage = (Object.keys(defaults) as Stage[]).find((key) => label.includes(key))
      if (!stage) throw new Error(`Unexpected calibration checkpoint ${label}`)
      const count = reads.get(stage) ?? 0
      reads.set(stage, count + 1)
      const scripted = options.frames?.[stage]
      now += scripted && count >= scripted.length ? 100 : 1
      return scripted ? scripted[Math.min(count, scripted.length - 1)]! : defaults[stage]
    },
  }).finally(() => clock.mockRestore())
  return { promise, writes, reads, budgets }
}

test("complete witnessed raster establishes every edge without dividing padded window replies", async () => {
  const run = calibration({
    frames: { "solid grid paint": [blank, blank, rasterFrame("solid"), rasterFrame("solid")] },
  })
  await expect(run.promise).resolves.toMatchObject({ origin: { x: 2, y: 2 }, pixelGeometry: geometry })
  expect(run.reads.get("solid grid paint")).toBe(4)
  for (const stage of ["column edge paint", "row edge paint", "restore grid paint"] as Stage[]) {
    expect(run.reads.get(stage)).toBe(2)
  }
  expect(run.writes.join("")).toContain("\x1b[4;1H")
  expect(run.writes.at(-1)).toContain("?25l")
  expect(run.writes.at(-2)).toContain("\x1b[0m\x1b[2J\x1b[H")
  expect(run.writes.at(-1)).not.toContain("48;2")
  expect(run.reads.get("before grid paint")).toBe(2)
  for (const stage of ["solid grid paint", "column edge paint", "row edge paint", "restore grid paint"] as Stage[]) {
    expect(new Set(run.budgets.filter(({ label }) => label.includes(stage)).map(({ deadline }) => deadline)).size).toBe(
      1,
    )
  }
})

test.each([
  "late uneven column",
  "hole",
  "extra patch",
  "reply disagreement",
  "missing column edge",
  "changed outside grid",
  "one column scanline",
  "one row scanline",
  "uneven rows",
] as const)("complete raster refuses %s and still confirms restoration", async (fault) => {
  const solid = rasterFrame("solid")
  const columns = rasterFrame("columns", fault === "late uneven column")
  const rows = rasterFrame("rows")
  if (fault === "one column scanline") columns.rgba.set([255, 0, 0, 255], (9 * 12 + 8) * 4)
  if (fault === "one row scanline") rows.rgba.set([255, 0, 0, 255], (8 * 12 + 9) * 4)
  if (fault === "uneven rows") {
    for (let x = 2; x < 10; x++) rows.rgba.set([255, 0, 0, 255], (8 * 12 + x) * 4)
  }
  if (fault === "hole") solid.rgba.set([0, 0, 0, 255], (5 * 12 + 5) * 4)
  if (fault === "extra patch") solid.rgba.set([255, 0, 255, 255], 0)
  if (fault === "changed outside grid") columns.rgba.set([255, 0, 0, 255], 0)
  if (fault === "missing column edge") {
    for (let y = 2; y < 10; y++) for (let x = 8; x < 10; x++) columns.rgba.set([255, 0, 0, 255], (y * 12 + x) * 4)
  }
  const run = calibration({
    frames: {
      "solid grid paint": [solid, solid],
      "column edge paint": [columns, columns],
      "row edge paint": [rows, rows],
    },
    ...(fault === "reply disagreement" ? { geometry: { ...geometry, cellWidth: 3 } } : {}),
  })
  await expect(run.promise).rejects.toThrow(
    fault === "late uneven column" || fault === "uneven rows"
      ? /fractional pitch/
      : fault.includes("scanline")
        ? /nonuniform/
        : fault === "reply disagreement"
          ? /disagree/
          : fault === "missing column edge"
            ? /missing or extra grid edge/
            : fault === "changed outside grid"
              ? /outside/
              : /non-solid/,
  )
  expect(run.reads.get("restore grid paint")).toBe(2)
})

test.each(["stale column frame", "unconfirmed column frame", "one-channel paint mismatch"] as const)(
  "calibration never derives geometry from %s",
  async (fault) => {
    const wrong = rasterFrame("columns")
    if (fault === "one-channel paint mismatch") {
      for (let offset = 0; offset < wrong.rgba.length; offset += 4) {
        if (wrong.rgba[offset] === 255) wrong.rgba[offset] = 254
      }
    }
    const frames =
      fault === "stale column frame"
        ? [rasterFrame("solid")]
        : fault === "unconfirmed column frame"
          ? [rasterFrame("columns"), rasterFrame("solid")]
          : [wrong]
    const run = calibration({ frames: { "column edge paint": frames } })
    await expect(run.promise).rejects.toThrow(/column edge paint.*timeout/)
    expect(run.reads.get("restore grid paint")).toBe(2)
  },
)

test("a restore mismatch is a run failure even after the complete grid was measured", async () => {
  const run = calibration({ frames: { "restore grid paint": [rasterFrame("rows")] } })
  await expect(run.promise).rejects.toMatchObject({
    name: "CaptureRestoreFailed",
    message: expect.stringMatching(/restore/),
  })
})

test("a pre-existing witness cannot be used as the requested paint", async () => {
  const witness = rasterFrame("solid")
  await expect(
    calibration({ frames: { "before grid paint": [witness, witness], "restore grid paint": [witness, witness] } })
      .promise,
  ).rejects.toThrow(/already visible/)
})

test("the normalized blank is confirmed twice before the first calibration paint", async () => {
  const run = calibration({
    beforeCapture: (label, writes) => {
      if (label.includes("before grid paint")) expect(writes).toEqual(["\x1b[?25l\x1b[0m\x1b[2J\x1b[H"])
    },
  })
  await expect(run.promise).resolves.toMatchObject({ pixelGeometry: geometry })
  expect(run.reads.get("restore grid paint")).toBe(2)
})

test("capture failure stays primary when starting-blank restoration cannot be proven", async () => {
  const writes: string[] = []
  // The retained hosted Cursor/VS Code failure occurs on the first baseline acquisition.
  const failure = Object.assign(new Error("Darwin window server refused image of the selected window"), {
    name: "DarwinCaptureCommandFailed",
  })
  const caught = await calibrateCaptureOrigin({
    ctx: {
      rows: 4,
      cols: 4,
      write: (text: string) => writes.push(text),
      queryMode: async () => "reset",
      queryWithSentinelOutcome: async () => modeOutcome("2"),
    } as unknown as TermContext,
    timeoutMs: 100,
    captureRaw: async () => {
      throw failure
    },
  }).catch((error: unknown) => error)
  expect(caught).toBeInstanceOf(AggregateError)
  const error = caught as AggregateError
  expect(error).toMatchObject({ name: "CaptureRestoreFailed", cause: failure })
  expect(error.message).toMatch(/^DarwinCaptureCommandFailed: Darwin window server refused/)
  expect(error.errors).toHaveLength(2)
  expect(error.errors[0]).toBe(failure)
  // Bun prints these members separately, so the outer message alone cannot fix attribution.
  expect(error.errors[1].message).toMatch(/^Secondary restoration unverified after DarwinCaptureCommandFailed/)
  expect(error.errors[1].message).not.toContain("Starting blank was never confirmed")
  expect(writes.at(-2)).toContain("\x1b[0m\x1b[2J\x1b[H")
  expect(writes.at(-1)).toBe("\x1b[?25l")
})

test("an initial partial write with unprovable restoration is a fatal run failure", async () => {
  const writes: string[] = []
  await expect(
    calibrateCaptureOrigin({
      ctx: {
        rows: 4,
        cols: 4,
        write: (text: string) => {
          writes.push(text)
          if (writes.length === 1) throw new Error("Initial calibration output partially written")
        },
        queryMode: async () => "reset",
        queryWithSentinelOutcome: async () => modeOutcome("2"),
      } as unknown as TermContext,
      timeoutMs: 100,
      captureRaw: async () => {
        if (writes.length > 0) throw new Error("Restored surface capture unavailable")
        return blank
      },
    }),
  ).rejects.toMatchObject({ name: "CaptureRestoreFailed" })
})

test("an unseen solid paint is a named refusal after the blank restore is freshly confirmed", async () => {
  const run = calibration({ frames: { "solid grid paint": [blank] } })
  await expect(run.promise).rejects.toMatchObject({
    name: "CaptureCalibrationRefused",
    message: expect.stringMatching(/calibration paint not observed/),
    cause: expect.objectContaining({ message: expect.stringMatching(/solid grid paint.*timeout/) }),
  })
  expect(run.reads.get("restore grid paint")).toBe(2)
})

test("a cursor mode left changed makes restoration fail", async () => {
  await expect(calibration({ restoredVisibility: "set" }).promise).rejects.toMatchObject({
    name: "CaptureRestoreFailed",
    message: expect.stringMatching(/cursor visibility/),
  })
})

test("a visible cursor is hidden through both blank witnesses and restored last", async () => {
  const run = calibration({
    visibility: "set",
    beforeCapture: (_label, writes) => {
      expect(writes.join("")).toContain("\x1b[?25l")
      expect(writes.join("")).not.toContain("\x1b[?25h")
    },
  })
  await expect(run.promise).resolves.toMatchObject({ pixelGeometry: geometry })
  expect(run.writes.at(-1)).toBe("\x1b[?25h")
})

test.each(["adapter I/O", "dimensions changed", "invalid decoded frame"])(
  "solid-paint %s stays a fatal apparatus error",
  async (message) => {
    const failure = new Error(message)
    const run = calibration({
      beforeCapture: (label) => {
        if (label.includes("solid grid paint")) throw failure
      },
    })
    await expect(run.promise).rejects.toBe(failure)
    expect(failure.name).not.toBe("CaptureCalibrationRefused")
    expect(run.reads.get("restore grid paint")).toBe(2)
  },
)

test("a failed restore retains the original grid error and the restoration error", async () => {
  const run = calibration({
    frames: {
      "column edge paint": [rasterFrame("columns", true), rasterFrame("columns", true)],
      "restore grid paint": [rasterFrame("rows")],
    },
  })
  await expect(run.promise).rejects.toMatchObject({
    name: "CaptureRestoreFailed",
    cause: expect.objectContaining({ message: expect.stringMatching(/fractional pitch/) }),
    errors: expect.arrayContaining([
      expect.objectContaining({ message: expect.stringMatching(/restore grid paint.*timeout/) }),
    ]),
  })
})

// The compositor paints a window's rounded corners black in EVERY stage, independent of what the
// probe drew. The retained macOS specimen refused with `non-solid grid: 476392 pixels in
// 798x597`, whose 14 holes were exactly that mask (11 bottom-left, 3 bottom-right). A window-shaped
// grid must therefore calibrate, while an interior hole must still refuse.
function filletCorners(
  source: CapturedFrame,
  corners: ReadonlyArray<readonly [number, number]> = [
    [2, 2],
    [9, 2],
    [2, 9],
    [9, 9],
  ],
): CapturedFrame {
  const result = { width: source.width, height: source.height, rgba: new Uint8Array(source.rgba) }
  for (const [x, y] of corners) result.rgba.set([0, 0, 0, 255], (y * result.width + x) * 4)
  return result
}

// A cell boundary can fall inside a device pixel, so the paint covers part of the ONE line directly
// outside the grid: every pixel there is the adjacent cell's paint colour at one alpha over its own
// pre-paint value. The retained macOS frame measured exactly that on y=28, 217/255 of magenta over
// black. This fixture reproduces the measured line over the 8 px wide raster grid at 2,2.
function blendTop(source: CapturedFrame, alpha = 217 / 255): CapturedFrame {
  const result = { width: source.width, height: source.height, rgba: new Uint8Array(source.rgba) }
  for (let x = 2; x < 10; x++) {
    const line = (1 * result.width + x) * 4
    const paint = (2 * result.width + x) * 4
    const blended = [0, 1, 2].map((channel) => {
      const value = source.rgba[paint + channel]
      if (value === undefined) throw new Error(`fixture is missing byte ${paint + channel}`)
      return Math.round(alpha * value)
    })
    result.rgba.set([...blended, 255], line)
  }
  return result
}

/** The same measured blend outside any other edge of that grid, for the edges blendTop does not reach. */
function blendEdge(source: CapturedFrame, edge: "bottom" | "left" | "right", alpha = 217 / 255): CapturedFrame {
  const result = { width: source.width, height: source.height, rgba: new Uint8Array(source.rgba) }
  for (let position = 2; position < 10; position++) {
    const [x, y, paintX, paintY] =
      edge === "bottom"
        ? [position, 10, position, 9]
        : edge === "left"
          ? [1, position, 2, position]
          : [10, position, 9, position]
    const paint = (paintY * result.width + paintX) * 4
    const blended = [0, 1, 2].map((channel) => {
      const value = source.rgba[paint + channel]
      if (value === undefined) throw new Error(`fixture is missing byte ${paint + channel}`)
      return Math.round(alpha * value)
    })
    result.rgba.set([...blended, 255], (y * result.width + x) * 4)
  }
  return result
}

test("window corner fillets do not defeat calibration of an exact raster", async () => {
  const run = calibration({
    frames: {
      "solid grid paint": [filletCorners(rasterFrame("solid")), filletCorners(rasterFrame("solid"))],
      "column edge paint": [filletCorners(rasterFrame("columns")), filletCorners(rasterFrame("columns"))],
      "row edge paint": [filletCorners(rasterFrame("rows")), filletCorners(rasterFrame("rows"))],
    },
  })
  const measured = await run.promise
  expect(measured).toMatchObject({ origin: { x: 2, y: 2 }, pixelGeometry: geometry })
  expect(measured.basis).toMatch(/corner fillets 4 px/)
})

test("an interior hole is still refused once corner fillets are tolerated", async () => {
  const solid = filletCorners(rasterFrame("solid"))
  solid.rgba.set([0, 0, 0, 255], (5 * 12 + 5) * 4)
  const run = calibration({ frames: { "solid grid paint": [solid, solid] } })
  await expect(run.promise).rejects.toThrow(/non-solid grid/)
})

test("a hole on an edge but away from a corner still refuses", async () => {
  const solid = filletCorners(rasterFrame("solid"))
  solid.rgba.set([0, 0, 0, 255], (2 * 12 + 5) * 4)
  const run = calibration({ frames: { "solid grid paint": [solid, solid] } })
  await expect(run.promise).rejects.toThrow(/non-solid grid/)
})

test("a leading line beside an already-full first stripe refuses as a fractional pitch", async () => {
  // The line counts in cell 1, so a full first stripe beside it would be one pixel too long.
  const run = calibration({
    frames: {
      "solid grid paint": [blendTop(rasterFrame("solid")), blendTop(rasterFrame("solid"))],
      "column edge paint": [blendTop(rasterFrame("columns")), blendTop(rasterFrame("columns"))],
      "row edge paint": [blendTop(rasterFrame("rows")), blendTop(rasterFrame("rows"))],
    },
  })
  await expect(run.promise).rejects.toThrow(/fractional pitch: stripes of 3 and 2 px on the rows axis/)
})

test("a leading line is the grid's own first pixel line", async () => {
  // 46 rows of 13 px whose first pixel row is the 85% line: the authored text area is 598 px, not 597.
  const size = 640
  const rowEdges = Array.from({ length: 47 }, (_, index) => 28 + index * 13)
  const columnEdges = [10, 20, 30]
  const frames = (stage: "solid" | "columns" | "rows") => [
    gridFrame(size, columnEdges, rowEdges, stage, "top"),
    gridFrame(size, columnEdges, rowEdges, stage, "top"),
  ]
  const run = calibration({
    rows: 46,
    cols: 2,
    frames: {
      "before grid paint": [frame(size), frame(size)],
      "solid grid paint": frames("solid"),
      "column edge paint": frames("columns"),
      "row edge paint": frames("rows"),
      "restore grid paint": [frame(size), frame(size)],
    },
  })
  const measured = await run.promise
  expect(measured.origin).toEqual({ x: 10, y: 28 })
  expect(measured.pixelGeometry).toMatchObject({ cellWidth: 10, cellHeight: 13, textHeight: 598 })
  expect(measured.basis).toMatch(/leading line counted in cell 1: top y=28 alpha 0\.851/)
  expect(measured.basis).toMatch(/edge blend solid top y=28 alpha 0\.851 \(20 px\)/)
})

test("the reported text height is the authored extent, so 597 refuses where 598 passes", async () => {
  const size = 640
  const rowEdges = Array.from({ length: 47 }, (_, index) => 28 + index * 13)
  const columnEdges = [10, 20, 30]
  const frames = (stage: "solid" | "columns" | "rows") => [
    gridFrame(size, columnEdges, rowEdges, stage, "top"),
    gridFrame(size, columnEdges, rowEdges, stage, "top"),
  ]
  const stages = {
    "before grid paint": [frame(size), frame(size)],
    "solid grid paint": frames("solid"),
    "column edge paint": frames("columns"),
    "row edge paint": frames("rows"),
    "restore grid paint": [frame(size), frame(size)],
  }
  const authored = { cellWidth: 10, cellHeight: 13, textWidth: 20, textHeight: 598 }
  const passing = await calibration({ rows: 46, cols: 2, geometry: authored, frames: stages }).promise
  expect(passing.pixelGeometry).toMatchObject({ textHeight: 598 })
  const refusing = calibration({
    rows: 46,
    cols: 2,
    geometry: { ...authored, textHeight: 597 },
    frames: stages,
  })
  await expect(refusing.promise).rejects.toThrow(/reported geometry .* disagrees with witnessed grid/)
})

test("a leading column line is the grid's own first pixel column", async () => {
  const size = 20
  const columnEdges = [2, 4, 6, 8, 10]
  const rowEdges = [2, 5, 8, 11]
  const frames = (stage: "solid" | "columns" | "rows") => [
    gridFrame(size, columnEdges, rowEdges, stage, "left"),
    gridFrame(size, columnEdges, rowEdges, stage, "left"),
  ]
  const run = calibration({
    rows: 3,
    cols: 4,
    frames: {
      "before grid paint": [frame(size), frame(size)],
      "solid grid paint": frames("solid"),
      "column edge paint": frames("columns"),
      "row edge paint": frames("rows"),
      "restore grid paint": [frame(size), frame(size)],
    },
  })
  const measured = await run.promise
  expect(measured.origin).toEqual({ x: 2, y: 2 })
  expect(measured.pixelGeometry).toMatchObject({ cellWidth: 2, cellHeight: 3 })
  expect(measured.basis).toMatch(/leading line counted in cell 1: left x=2 alpha 0\.851/)
})

test("a grid with no leading line keeps its origin and pitch", async () => {
  const size = 20
  const columnEdges = [2, 4, 6, 8, 10]
  const rowEdges = [2, 5, 8, 11]
  const frames = (stage: "solid" | "columns" | "rows") => [
    gridFrame(size, columnEdges, rowEdges, stage),
    gridFrame(size, columnEdges, rowEdges, stage),
  ]
  const run = calibration({
    rows: 3,
    cols: 4,
    frames: {
      "before grid paint": [frame(size), frame(size)],
      "solid grid paint": frames("solid"),
      "column edge paint": frames("columns"),
      "row edge paint": frames("rows"),
      "restore grid paint": [frame(size), frame(size)],
    },
  })
  const measured = await run.promise
  expect(measured.origin).toEqual({ x: 2, y: 2 })
  expect(measured.pixelGeometry).toMatchObject({ cellWidth: 2, cellHeight: 3 })
  expect(measured.basis).not.toMatch(/leading line counted/)
})

test("a line outside the grid in another colour refuses", async () => {
  const solid = blendTop(rasterFrame("solid"))
  solid.rgba.set([217, 0, 0, 255], (1 * 12 + 5) * 4)
  const run = calibration({ frames: { "solid grid paint": [solid, solid] } })
  await expect(run.promise).rejects.toThrow(/paint changed pixels outside the witnessed grid/)
})

test("a partial blend line refuses", async () => {
  const solid = blendTop(rasterFrame("solid"))
  solid.rgba.set([0, 0, 0, 255], (1 * 12 + 5) * 4)
  const run = calibration({ frames: { "solid grid paint": [solid, solid] } })
  await expect(run.promise).rejects.toThrow(/paint changed pixels outside the witnessed grid/)
})

test("two alphas on one line refuse", async () => {
  const solid = blendTop(rasterFrame("solid"))
  for (let x = 6; x < 10; x++) solid.rgba.set([128, 0, 128, 255], (1 * 12 + x) * 4)
  const run = calibration({ frames: { "solid grid paint": [solid, solid] } })
  await expect(run.promise).rejects.toThrow(/paint changed pixels outside the witnessed grid/)
})

test("a second line outside the same edge refuses", async () => {
  const solid = blendTop(rasterFrame("solid"))
  solid.rgba.set([217, 0, 217, 255], (0 * 12 + 5) * 4)
  const run = calibration({ frames: { "solid grid paint": [solid, solid] } })
  await expect(run.promise).rejects.toThrow(/paint changed pixels outside the witnessed grid/)
})

test("corner fillets and the blend line together still calibrate", async () => {
  // The trailing edge stays outside coverage, so it cannot shorten the first stripe beside a fillet.
  const run = calibration({
    frames: {
      "solid grid paint": [
        blendEdge(filletCorners(rasterFrame("solid")), "bottom"),
        blendEdge(filletCorners(rasterFrame("solid")), "bottom"),
      ],
      "column edge paint": [
        blendEdge(filletCorners(rasterFrame("columns")), "bottom"),
        blendEdge(filletCorners(rasterFrame("columns")), "bottom"),
      ],
      "row edge paint": [
        blendEdge(filletCorners(rasterFrame("rows")), "bottom"),
        blendEdge(filletCorners(rasterFrame("rows")), "bottom"),
      ],
    },
  })
  const measured = await run.promise
  expect(measured).toMatchObject({ origin: { x: 2, y: 2 }, pixelGeometry: geometry })
  expect(measured.basis).toMatch(/corner fillets 4 px/)
  expect(measured.basis).toMatch(/edge blend solid bottom y=10 alpha 0\.851 \(8 px\)/)
  expect(measured.basis).not.toMatch(/leading line counted/)
})

test("a blend whose alpha byte changes outside the grid refuses", async () => {
  // The model explains a colour, never opacity: the alpha byte stays exactly as the baseline had it.
  const solid = blendTop(rasterFrame("solid"))
  solid.rgba.set([0], (1 * 12 + 5) * 4 + 3)
  const run = calibration({ frames: { "solid grid paint": [solid, solid] } })
  await expect(run.promise).rejects.toThrow(/paint changed pixels outside the witnessed grid/)
})

test("a blend admitted only in the columns stage is recorded", async () => {
  // Every stage that admits a line names it; the solid stage alone is not the record.
  const run = calibration({
    frames: {
      "column edge paint": [blendTop(rasterFrame("columns")), blendTop(rasterFrame("columns"))],
    },
  })
  const measured = await run.promise
  expect(measured).toMatchObject({ origin: { x: 2, y: 2 } })
  expect(measured.basis).toMatch(/edge blend columns top y=1 alpha 0\.851 \(8 px\)/)
  expect(measured.basis).not.toMatch(/edge blend solid/)
})

test("a blend admitted only in the rows stage is recorded", async () => {
  const run = calibration({
    frames: { "row edge paint": [blendTop(rasterFrame("rows")), blendTop(rasterFrame("rows"))] },
  })
  const measured = await run.promise
  expect(measured).toMatchObject({ origin: { x: 2, y: 2 }, pixelGeometry: geometry })
  expect(measured.basis).toMatch(/edge blend rows top y=1 alpha 0\.851 \(8 px\)/)
  expect(measured.basis).not.toMatch(/edge blend (solid|columns)/)
})

test("a rows-stage blend whose alpha byte changes outside the grid refuses", async () => {
  const rows = blendTop(rasterFrame("rows"))
  rows.rgba.set([0], (1 * 12 + 5) * 4 + 3)
  const run = calibration({ frames: { "row edge paint": [rows, rows] } })
  await expect(run.promise).rejects.toThrow(/paint changed pixels outside the witnessed grid/)
})

for (const [edge, line] of [
  ["bottom", "bottom y=10"],
  ["left", "left x=1"],
  ["right", "right x=10"],
] as const) {
  test(`one uniform-alpha line outside the ${edge} edge is admitted and recorded`, async () => {
    const solid = blendEdge(rasterFrame("solid"), edge)
    const run = calibration({ frames: { "solid grid paint": [solid, solid] } })
    const measured = await run.promise
    expect(measured).toMatchObject({ origin: { x: 2, y: 2 }, pixelGeometry: geometry })
    expect(measured.basis).toMatch(new RegExp(`edge blend solid ${line} alpha 0\\.851 \\(8 px\\)`))
  })
}

test("a blend pixel 2 levels off the line's alpha refuses", async () => {
  // 219 is alpha 0.859, inside the 0.01 alpha window but 2 levels from the line's 217.
  const solid = blendTop(rasterFrame("solid"))
  solid.rgba.set([219, 0, 217, 255], (1 * 12 + 5) * 4)
  const run = calibration({ frames: { "solid grid paint": [solid, solid] } })
  await expect(run.promise).rejects.toThrow(/paint changed pixels outside the witnessed grid/)
})

test("a line at the full paint colour outside the grid refuses", async () => {
  // Alpha 1 is a whole further cell line, never a cell boundary inside a device pixel.
  const columns = blendTop(rasterFrame("columns"), 1)
  const run = calibration({ frames: { "column edge paint": [columns, columns] } })
  await expect(run.promise).rejects.toThrow(/paint changed pixels outside the witnessed grid/)
})

test("a blend line whose last pixel is another colour refuses", async () => {
  const solid = blendTop(rasterFrame("solid"))
  solid.rgba.set([217, 0, 0, 255], (1 * 12 + 9) * 4)
  const run = calibration({ frames: { "solid grid paint": [solid, solid] } })
  await expect(run.promise).rejects.toThrow(/paint changed pixels outside the witnessed grid/)
})

test("a clipped last stripe calibrates and records its clip", async () => {
  // 4 columns of 2 px and 4 rows of 2,2,2,1: the far edge clips the last row by 1 px, which is a
  // clip rather than a fractional pitch, so the grid still calibrates on a 2 x 2 cell pitch.
  const columns = [2, 4, 6, 8, 10]
  const rows = [2, 4, 6, 8, 9]
  const run = calibration({
    frames: {
      "solid grid paint": [gridFrame(12, columns, rows, "solid"), gridFrame(12, columns, rows, "solid")],
      "column edge paint": [gridFrame(12, columns, rows, "columns"), gridFrame(12, columns, rows, "columns")],
      "row edge paint": [gridFrame(12, columns, rows, "rows"), gridFrame(12, columns, rows, "rows")],
    },
  })
  const measured = await run.promise
  expect(measured).toMatchObject({
    origin: { x: 2, y: 2 },
    pixelGeometry: { cellWidth: 2, cellHeight: 2, textWidth: 8, textHeight: 8 },
    visible: { width: 8, height: 7 },
  })
  expect(measured.basis).toMatch(/rows clipped 1 px at the far edge/)
})

test("a wrong-colour pixel on a scanline the corner mask touches still refuses", async () => {
  // The top row carries two corner fillets so it yields no intact stripe measurement, but its
  // unmasked pixels must still match the pitch measured on the rows below.
  const solid = filletCorners(rasterFrame("solid"))
  const columns = filletCorners(rasterFrame("columns"))
  columns.rgba.set([255, 0, 0, 255], (2 * 12 + 5) * 4)
  const run = calibration({
    frames: {
      "solid grid paint": [solid, solid],
      "column edge paint": [columns, columns],
    },
  })
  await expect(run.promise).rejects.toThrow(/at 5,2 on cell 2/)
})

test("mixed stripe widths refuse as a fractional pitch", async () => {
  // 12 px, 13 px and 1 px columns on a 26 px grid: the middle stripe differs, so this is not a clip.
  const columns = [2, 14, 27, 28]
  const rows = [2, 15, 28]
  const empty = frame(30)
  const run = calibration({
    rows: 2,
    cols: 3,
    frames: {
      "before grid paint": [empty, empty],
      "solid grid paint": [gridFrame(30, columns, rows, "solid"), gridFrame(30, columns, rows, "solid")],
      "column edge paint": [gridFrame(30, columns, rows, "columns"), gridFrame(30, columns, rows, "columns")],
      "restore grid paint": [empty, empty],
    },
  })
  await expect(run.promise).rejects.toThrow(/fractional pitch: stripes of 12 and 13 px/)
})

test("a last stripe longer than the pitch refuses by name", async () => {
  // 12, 12 and 14 px columns on a 38 px grid: a clip can only shorten the far edge, so a longer
  // last stripe is a wrong reading, not a clip. Callers report only clip > 0, so accepting it
  // would leave a negative clip silently unreported.
  const columns = [2, 14, 26, 40]
  const rows = [2, 14, 26]
  const blank = frame(40)
  const run = calibration({
    rows: 2,
    cols: 3,
    frames: {
      "before grid paint": [blank, blank],
      "solid grid paint": [gridFrame(40, columns, rows, "solid"), gridFrame(40, columns, rows, "solid")],
      "column edge paint": [gridFrame(40, columns, rows, "columns"), gridFrame(40, columns, rows, "columns")],
      "row edge paint": [gridFrame(40, columns, rows, "rows"), gridFrame(40, columns, rows, "rows")],
      "restore grid paint": [blank, blank],
    },
  })
  await expect(run.promise).rejects.toThrow(/last stripe is 14 px, longer than the 12 px pitch/)
})

// The retained macOS alacritty frame, rebuilt from its recorded numbers rather than transported as a binary:
// 800x628, a 798x597 magenta grid at y=29 for a 133x46 terminal, plus the documented corner
// staircase. FIXTURE MODEL, not measurement: the 6.00 px columns are the frame's own arithmetic,
// while the 13 px rows are a model of the clip reading (46 x 13 = 598, clipped to 597) and NOT a
// measured pitch — the retained frame fixes only the 597 px total. The requirement this pins is
// narrow: the corner mask must stop being the reason calibration refuses. What the geometry then
// measures is a separate question this test does not answer.
function roundedWindowSpecimen(stage: "solid" | "columns" | "rows"): CapturedFrame {
  const width = 800,
    height = 628
  const rgba = new Uint8Array(width * height * 4)
  for (let offset = 0; offset < rgba.length; offset += 4) rgba.set([0, 0, 0, 255], offset)
  for (let y = 29; y < 626; y++) {
    for (let x = 0; x < 798; x++) {
      const column = Math.min(132, Math.floor(x / 6))
      const row = Math.min(45, Math.floor((y - 29) / 13))
      const rgb =
        stage === "solid" ? [255, 0, 255] : (stage === "columns" ? column : row) % 2 === 0 ? [255, 0, 0] : [0, 0, 0]
      rgba.set([...rgb, 255], (y * width + x) * 4)
    }
  }
  const staircase: Array<readonly [number, number]> = [
    [0, 621],
    [0, 622],
    [0, 623],
    [1, 623],
    [0, 624],
    [1, 624],
    [2, 624],
    [797, 624],
    [0, 625],
    [1, 625],
    [2, 625],
    [3, 625],
    [796, 625],
    [797, 625],
  ]
  for (const [x, y] of staircase) rgba.set([0, 0, 0, 255], (y * width + x) * 4)
  return { width, height, rgba }
}

test("the macOS alacritty window specimen no longer refuses for its corner fillets", async () => {
  // Opaque baseline. The retained frame's outside-grid pixels are black WITH alpha 255, so a
  // transparent baseline would make outsideUnchanged() throw "paint changed pixels outside the
  // witnessed grid" and this test would pass on that unrelated refusal.
  const empty = { width: 800, height: 628, rgba: new Uint8Array(800 * 628 * 4) }
  for (let offset = 3; offset < empty.rgba.length; offset += 4) empty.rgba[offset] = 255
  const solid = roundedWindowSpecimen("solid")
  // Fixture invariant for that trap: outside the 798x597 grid the specimen must equal the opaque
  // blank, alpha included. Checked here because outsideUnchanged() cannot reach it until the
  // corner mask stops refusing.
  const outsideMismatch: string[] = []
  for (let y = 0; y < solid.height; y++) {
    for (let x = 0; x < solid.width; x++) {
      if (x < 798 && y >= 29 && y < 626) continue
      const offset = (y * solid.width + x) * 4
      for (let channel = 0; channel < 4; channel++) {
        if (solid.rgba[offset + channel] !== empty.rgba[offset + channel]) {
          outsideMismatch.push(`${x},${y}[${channel}]`)
        }
      }
    }
  }
  expect(outsideMismatch).toEqual([])
  const run = calibration({
    rows: 46,
    cols: 133,
    frames: {
      "before grid paint": [empty, empty],
      "solid grid paint": [solid, solid],
      "column edge paint": [roundedWindowSpecimen("columns"), roundedWindowSpecimen("columns")],
      "row edge paint": [roundedWindowSpecimen("rows"), roundedWindowSpecimen("rows")],
      "restore grid paint": [empty, empty],
    },
  })
  const settled = await run.promise.then(
    () => ({ ok: true as const, message: "" }),
    (error: unknown) => ({ ok: false as const, message: error instanceof Error ? error.message : String(error) }),
  )
  // A cure may resolve this frame, or refuse it at the stripe stage. Both are acceptable here; a
  // refusal at the corner stage, a fractional-pitch reading of a clipped row, or an unrelated
  // failure is not.
  if (!settled.ok) {
    expect(settled.message).toMatch(/nonuniform rows|measured \d+ cells, expected 46|last stripe is \d+ px, longer/)
  }
  // Proven stage: column stripes are only captured after the solid grid is accepted, so this is
  // what distinguishes "past the corners" from "refused somewhere else".
  expect(run.reads.get("column edge paint")).toBeGreaterThan(0)
})
