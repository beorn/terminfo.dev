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

  // #38084 (Ghostty runs 45269053904 and 45287200654): when finally's restoreGrid also fails after
  // paint-outside-grid, capture-calibration wraps [failure, cause] in AggregateError(name="CaptureRestoreFailed").
  // That wrapper must never mask code="paint-outside-grid" or drop detail/frames from the bounded retry.
  it("unwraps CaptureRestoreFailed wrapping paint-outside-grid and still runs the bounded recapture (#38084)", async () => {
    const primary = paintOutsideGrid()
    const secondary = Object.assign(
      new Error("Capture calibration restore grid paint confirmation: paint witness timeout"),
      {
        name: "CapturePaintTimeout",
      },
    )
    const wrapped = Object.assign(
      new AggregateError(
        [primary, secondary],
        `${primary.name}: ${primary.message}; secondary capture restoration failure: ${secondary.message}`,
        {
          cause: primary,
        },
      ),
      { name: "CaptureRestoreFailed" },
    )
    let calls = 0
    const archived: Array<{ stage: string }> = []
    const out = await calibrateWithOneRecapture({
      calibrate: async () => {
        calls++
        if (calls === 1) throw wrapped
        return "installed-after-retry"
      },
      archiveFrames: async (frames) => {
        archived.push({ stage: frames.stage })
        return { stage: frames.stage, before: "/c/before.png", after: "/c/after.png" }
      },
    })
    expect(calls).toBe(2)
    expect(out.attempts).toBe(2)
    expect(out.result).toBe("installed-after-retry")
    expect(archived).toEqual([{ stage: "grid settle" }])
    expect(out.firstRefusal).toEqual({
      message: primary.message,
      detail: primary.detail,
      frames: { stage: "grid settle", before: "/c/before.png", after: "/c/after.png" },
    })
  })

  it("does not recapture CaptureRestoreFailed wrapping a non-paint-outside-grid error (#38084)", async () => {
    const primary = Object.assign(new Error("Capture calibration fixture: other refusal"), {
      name: "CaptureCalibrationRefused",
    })
    const secondary = new Error("restore failed")
    const wrapped = Object.assign(
      new AggregateError([primary, secondary], "other refusal; secondary capture restoration failure: restore failed", {
        cause: primary,
      }),
      { name: "CaptureRestoreFailed" },
    )
    let calls = 0
    await expect(
      calibrateWithOneRecapture({
        calibrate: async () => {
          calls++
          throw wrapped
        },
        archiveFrames: async () => {
          throw new Error("must not archive non-paint-outside-grid failure")
        },
      }),
    ).rejects.toBe(wrapped)
    expect(calls).toBe(1)
  })
})
