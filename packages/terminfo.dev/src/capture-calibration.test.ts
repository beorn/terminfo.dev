/**
 * @failure Stable stale frames or non-solid paint differences manufacture a text origin.
 * @level l1
 * @consumer Collector once-per-run calibration before the first mutation fixture
 * @testonly none
 */
import { expect, test } from "vitest"
import { calibrateCaptureOrigin } from "./capture-calibration.ts"
import type { CapturedFrame } from "./capture-core.ts"
import type { TermContext } from "@terminfo/probe-defs"

const geometry = { cellWidth: 2, cellHeight: 2, textWidth: 8, textHeight: 8 }
function frame(
  rect?: { x: number; y: number; rgb: number[] },
  second?: { x: number; y: number; rgb: number[] },
): CapturedFrame {
  const rgba = new Uint8Array(12 * 12 * 4)
  for (let offset = 0; offset < rgba.length; offset += 4) rgba.set([17, 23, 31, 255], offset)
  for (const paint of [rect, second]) {
    if (paint) {
      for (let y = paint.y; y < paint.y + 2; y++) {
        for (let x = paint.x; x < paint.x + 2; x++) {
          rgba.set([...paint.rgb, 255], (y * 12 + x) * 4)
        }
      }
    }
  }
  return { width: 12, height: 12, rgba }
}
const blank = frame()
const witnessPaint = { x: 4, y: 4, rgb: [41, 73, 109] }
const witness = frame(witnessPaint)
const painted = frame(witnessPaint, { x: 6, y: 4, rgb: [127, 151, 173] })
function calibration(frames: CapturedFrame[], timeoutMs = 100) {
  const writes: string[] = []
  const budgets: Array<{ label: string; deadline: number }> = []
  let reads = 0
  const ctx = {
    rows: 4,
    cols: 4,
    write: (text: string) => writes.push(text),
    queryMode: async () => "reset",
  } as unknown as TermContext
  const promise = calibrateCaptureOrigin({
    ctx,
    pixelGeometry: geometry,
    timeoutMs,
    captureRaw: async (label, deadline) => {
      budgets.push({ label, deadline })
      const result = frames[Math.min(reads++, frames.length - 1)]
      if (!result) throw new Error("Missing scripted calibration frame")
      return result
    },
  })
  return { promise, writes, budgets, reads: () => reads }
}

test("calibration waits through stale equal frames, confirms every paint, and restores the known blank cell", async () => {
  // Window chrome may change and then hold steady before the requested cell paint arrives.
  // That unrelated change cannot witness calibration currency.
  const chrome = frame(witnessPaint, { x: 0, y: 0, rgb: [200, 100, 50] })
  const run = calibration([
    blank,
    blank,
    blank,
    witness,
    witness,
    witness,
    chrome,
    chrome,
    painted,
    painted,
    painted,
    witness,
    witness,
  ])
  expect((await run.promise).origin).toEqual({ x: 2, y: 2 })
  expect(run.reads()).toBe(13)
  expect(run.writes.some((write) => write.includes("48;2;127;151;173"))).toBe(true)
  expect(run.writes.at(-1)).toContain("?25l")
  // The real adapter needs an absolute deadline to terminate a blocked subprocess, rather than
  // let its ordinary 10-second command timeout outlive the oracle budget.
  expect(run.budgets.every(({ deadline }) => Number.isFinite(deadline))).toBe(true)
  for (const stage of ["baseline paint witness", "calibration paint", "restore paint"]) {
    expect(
      new Set(
        run.budgets
          .filter(({ label }) => label.endsWith(stage) || label.endsWith(`${stage} confirmation`))
          .map(({ deadline }) => deadline),
      ).size,
    ).toBe(1)
  }
})

test.each([
  ["no baseline paint", [blank], /baseline paint witness.*timeout/],
  ["already visible baseline witness", [witness], /already visible/],
  ["no calibration paint", [blank, witness, witness], /calibration paint.*timeout/],
  ["no restore paint", [blank, witness, witness, painted, painted], /restore paint.*timeout/],
  ["unconfirmed baseline", [blank, witness, blank], /baseline paint witness.*timeout/],
] as const)("calibration refuses %s without deriving an origin", async (_name, frames, message) => {
  await expect(calibration([...frames], 1).promise).rejects.toThrow(message)
})

test.each(["hole", "separate rectangle", "wrong cell size"])(
  "calibration refuses %s instead of deriving an origin from a bounding box",
  async (fault) => {
    const broken = frame(witnessPaint, { x: 6, y: 4, rgb: [127, 151, 173] })
    if (fault === "hole") broken.rgba.set([17, 23, 31, 255], (4 * 12 + 6) * 4)
    if (fault === "separate rectangle") broken.rgba.set([127, 151, 173, 255], 0)
    if (fault === "wrong cell size") {
      for (let y = 4; y < 6; y++) broken.rgba.set([127, 151, 173, 255], (y * 12 + 8) * 4)
    }
    await expect(calibration([blank, witness, witness, broken, broken]).promise).rejects.toThrow(
      fault === "wrong cell size" ? /differs from terminal own cell/ : /non-solid/,
    )
  },
)
