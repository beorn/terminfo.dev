/**
 * @failure A drifting calibration paint is retried more than once, retried for the wrong refusal, or a
 *   passing retry hides the refusal and frame pair that caused it — the run then reports a clean
 *   installation with no evidence of the stray paint (#37667, @cto 6254e549 a).
 * @level l1
 * @consumer Ghostty CI calibration runs reading attempts/firstRefusal from the captureCalibration fact
 * @testonly none
 */
import { describe, expect, it } from "vitest"
import type { CaptureCalibrationRefusal } from "./capture-calibration.ts"
import type { CapturedFrame } from "./capture-core.ts"
import { calibrateWithOneRecapture } from "./serve.ts"

const frame = (shade: number): CapturedFrame => ({
  width: 1,
  height: 1,
  rgba: new Uint8Array([shade, shade, shade, 255]),
})

function paintOutsideGrid(): Error & CaptureCalibrationRefusal {
  return Object.assign(new Error("Capture calibration paint changed pixels outside the witnessed grid"), {
    name: "CaptureCalibrationRefused",
    code: "paint-outside-grid" as const,
    detail: "stage 'grid settle': 2 pixel(s) outside the grid; first: (3,4) #000000 -> #ffffff",
    frames: { stage: "grid settle", before: frame(0), after: frame(255) },
  })
}

describe("calibrateWithOneRecapture", () => {
  it("recaptures exactly once and returns the second attempt's own reading", async () => {
    const reading = { origin: { x: 13, y: 57 }, basis: "fixture", pixelGeometry: {} }
    let calls = 0
    const out = await calibrateWithOneRecapture({
      calibrate: async () => {
        calls++
        if (calls === 1) throw paintOutsideGrid()
        return reading
      },
      archiveFrames: async (frames) => ({ stage: frames.stage, before: "/c/a.png", after: "/c/b.png" }),
    })
    expect(calls).toBe(2)
    expect(out.attempts).toBe(2)
    // Byte-identical: the retry installs the frame it judged, never a re-derived copy.
    expect(out.result).toBe(reading)
    expect(out.firstRefusal).toEqual({
      message: "Capture calibration paint changed pixels outside the witnessed grid",
      detail: "stage 'grid settle': 2 pixel(s) outside the grid; first: (3,4) #000000 -> #ffffff",
      frames: { stage: "grid settle", before: "/c/a.png", after: "/c/b.png" },
    })
  })

  it("archives the first refusal's pair even though the retry passes", async () => {
    const archived: Array<{ stage: string }> = []
    await calibrateWithOneRecapture({
      calibrate: (() => {
        let calls = 0
        return async () => {
          calls++
          if (calls === 1) throw paintOutsideGrid()
          return "installed"
        }
      })(),
      archiveFrames: async (frames) => {
        archived.push(frames)
        return { stage: frames.stage }
      },
    })
    expect(archived).toEqual([{ stage: "grid settle", before: frame(0), after: frame(255) }])
  })

  it("a second refusal fails exactly as one attempt's did", async () => {
    let calls = 0
    await expect(
      calibrateWithOneRecapture({
        calibrate: async () => {
          calls++
          throw paintOutsideGrid()
        },
        archiveFrames: async (frames) => ({ stage: frames.stage }),
      }),
    ).rejects.toMatchObject({ name: "CaptureCalibrationRefused", code: "paint-outside-grid" })
    expect(calls).toBe(2)
  })

  it("does not recapture a refusal of any other kind", async () => {
    let calls = 0
    const other = Object.assign(new Error("Capture calibration fixture: refused"), {
      name: "CaptureCalibrationRefused",
    })
    await expect(
      calibrateWithOneRecapture({
        calibrate: async () => {
          calls++
          throw other
        },
        archiveFrames: async () => {
          throw new Error("a refusal of another kind archives nothing")
        },
      }),
    ).rejects.toBe(other)
    expect(calls).toBe(1)
  })

  it("a first attempt that passes makes one call and records no refusal or retry", async () => {
    let calls = 0
    const out = await calibrateWithOneRecapture({
      calibrate: async () => {
        calls++
        return "installed"
      },
      archiveFrames: async () => {
        throw new Error("must not archive")
      },
    })
    expect(calls).toBe(1)
    expect(out).toEqual({ result: "installed", attempts: 1 })
  })
})
