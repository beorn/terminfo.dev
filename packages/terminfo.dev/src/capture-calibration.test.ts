/**
 * @failure Sampled cells, stale frames or failed restoration manufacture a raster geometry.
 * @level l1
 * @consumer Collector once-per-run calibration before any probe fixture
 * @testonly none
 */
import { expect, test, vi } from "vitest"
import { calibrateCaptureOrigin } from "./capture-calibration.ts"
import type { CapturedFrame } from "./capture-core.ts"
import type { TermContext } from "@terminfo/probe-defs"

const geometry = { cellWidth: 2, cellHeight: 2, textWidth: 8, textHeight: 8 }
function frame(): CapturedFrame {
  const rgba = new Uint8Array(12 * 12 * 4)
  for (let offset = 0; offset < rgba.length; offset += 4) rgba.set([0, 0, 0, 255], offset)
  return { width: 12, height: 12, rgba }
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

type Stage = "before grid paint" | "solid grid paint" | "column edge paint" | "row edge paint" | "restore grid paint"
function calibration(
  options: {
    geometry?: typeof geometry
    frames?: Partial<Record<Stage, CapturedFrame[]>>
    beforeCapture?: (label: string, writes: readonly string[]) => void
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
      rows: 4,
      cols: 4,
      write: (text: string) => writes.push(text),
      queryMode: async () => "reset",
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
] as const)("complete raster refuses %s and still confirms restoration", async (fault) => {
  const solid = rasterFrame("solid")
  const columns = rasterFrame("columns", fault === "late uneven column")
  if (fault === "hole") solid.rgba.set([0, 0, 0, 255], (5 * 12 + 5) * 4)
  if (fault === "extra patch") solid.rgba.set([255, 0, 255, 255], 0)
  if (fault === "changed outside grid") columns.rgba.set([255, 0, 0, 255], 0)
  if (fault === "missing column edge") {
    for (let y = 2; y < 10; y++) for (let x = 8; x < 10; x++) columns.rgba.set([255, 0, 0, 255], (y * 12 + x) * 4)
  }
  const run = calibration({
    frames: { "solid grid paint": [solid, solid], "column edge paint": [columns, columns] },
    ...(fault === "reply disagreement" ? { geometry: { ...geometry, cellWidth: 3 } } : {}),
  })
  await expect(run.promise).rejects.toThrow(
    fault === "late uneven column"
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
  await expect(calibration({ frames: { "before grid paint": [rasterFrame("solid")] } }).promise).rejects.toThrow(
    /already visible/,
  )
})

test("the original surface is captured before any calibration paint or clear", async () => {
  const original = frame()
  original.rgba.set([255, 255, 0, 255], (4 * original.width + 4) * 4)
  const run = calibration({
    frames: { "before grid paint": [original], "restore grid paint": [original, original] },
    beforeCapture: (label, writes) => {
      if (label.includes("before grid paint")) expect(writes).toEqual([])
    },
  })
  await expect(run.promise).resolves.toMatchObject({ pixelGeometry: geometry })
  expect(run.reads.get("restore grid paint")).toBe(2)
})

test("failure to capture the original surface leaves it untouched", async () => {
  const writes: string[] = []
  const failure = new Error("Original owned window capture failed")
  await expect(
    calibrateCaptureOrigin({
      ctx: {
        rows: 4,
        cols: 4,
        write: (text: string) => writes.push(text),
        queryMode: async () => "reset",
      } as unknown as TermContext,
      timeoutMs: 100,
      captureRaw: async () => {
        throw failure
      },
    }),
  ).rejects.toBe(failure)
  expect(writes).toEqual([])
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
      } as unknown as TermContext,
      timeoutMs: 100,
      captureRaw: async () => {
        if (writes.length > 0) throw new Error("Restored surface capture unavailable")
        return blank
      },
    }),
  ).rejects.toMatchObject({ name: "CaptureRestoreFailed" })
})
