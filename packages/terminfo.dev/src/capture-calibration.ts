import type { CapturePixelGeometry, TermContext } from "@terminfo/probe-defs"
import type { CapturedFrame, CaptureRectangle, NamedTextOrigin } from "./capture-core.ts"

const BLANK = [17, 23, 31] as const
const WITNESS = [41, 73, 109] as const
const CALIBRATION = [127, 151, 173] as const
const WITNESS_CELL = { row: 2, col: 2 }
const CALIBRATION_CELL = { row: 2, col: 3 }
const background = (rgb: readonly number[]) => `\x1b[48;2;${rgb.join(";")}m`
const paint = (cell: { row: number; col: number }, rgb: readonly number[]) =>
  `\x1b[${cell.row};${cell.col}H${background(rgb)} `

function validateFrame(frame: CapturedFrame): void {
  if (
    !Number.isSafeInteger(frame.width) ||
    !Number.isSafeInteger(frame.height) ||
    frame.width < 1 ||
    frame.height < 1 ||
    frame.rgba.length !== frame.width * frame.height * 4
  ) {
    throw new Error("Capture calibration received invalid decoded frame dimensions")
  }
}

function equal(left: CapturedFrame, right: CapturedFrame): boolean {
  validateFrame(left)
  validateFrame(right)
  if (left.width !== right.width || left.height !== right.height) {
    throw new Error("Capture calibration window dimensions changed")
  }
  return left.rgba.every((byte, index) => byte === right.rgba[index])
}

/** Count every selected pixel: a bounding box with a hole or separate patches is never a cell. */
function rectangle(frame: CapturedFrame, selected: (offset: number) => boolean, label: string): CaptureRectangle {
  let left = frame.width,
    top = frame.height,
    right = -1,
    bottom = -1,
    count = 0
  for (let y = 0; y < frame.height; y++) {
    for (let x = 0; x < frame.width; x++) {
      if (!selected((y * frame.width + x) * 4)) continue
      count++
      left = Math.min(left, x)
      right = Math.max(right, x)
      top = Math.min(top, y)
      bottom = Math.max(bottom, y)
    }
  }
  if (count === 0) throw new Error(`Capture calibration ${label}: no changed pixels`)
  const width = right - left + 1,
    height = bottom - top + 1
  if (count !== width * height) {
    throw new Error(
      `Capture calibration ${label}: non-solid difference (${count} pixels in ${width}x${height}); multiple rectangles or holes cannot supply an origin`,
    )
  }
  return { x: left, y: top, width, height }
}

function rgbAt(frame: CapturedFrame, offset: number, rgb: readonly number[]): boolean {
  return frame.rgba[offset] === rgb[0] && frame.rgba[offset + 1] === rgb[1] && frame.rgba[offset + 2] === rgb[2]
}

function ownCell(rect: CaptureRectangle, geometry: CapturePixelGeometry, label: string): void {
  if (rect.width !== geometry.cellWidth || rect.height !== geometry.cellHeight) {
    throw new Error(
      `Capture calibration ${label}: rectangle ${rect.width}x${rect.height} differs from terminal own cell ${geometry.cellWidth}x${geometry.cellHeight}`,
    )
  }
}

/**
 * Runs before a probe fixture. The known blank cell is established by collector writes; the
 * baseline's explicit paint proves currency, and only the subsequent exact difference supplies
 * origin. No capture equality alone proves currency, and no colour statistic sizes or places cells.
 */
export async function calibrateCaptureOrigin({
  ctx,
  pixelGeometry,
  timeoutMs,
  captureRaw,
}: {
  ctx: TermContext
  pixelGeometry: CapturePixelGeometry
  timeoutMs: number
  captureRaw: (label: string, deadline: number) => Promise<CapturedFrame>
}): Promise<NamedTextOrigin> {
  if (
    ![pixelGeometry.cellWidth, pixelGeometry.cellHeight, pixelGeometry.textWidth, pixelGeometry.textHeight].every(
      (value) => Number.isSafeInteger(value) && value > 0,
    )
  ) {
    throw new Error("Capture calibration requires terminal own positive integer pixel geometry")
  }
  if (ctx.rows < 3 || ctx.cols < 4) {
    throw new Error("Capture calibration requires a measured grid with two interior cells (at least 3x4)")
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("Capture calibration requires the oracle's positive timeoutMs")
  }
  const visibility = await ctx.queryMode(25)
  if (visibility !== "set" && visibility !== "reset") {
    throw new Error("Capture calibration cannot restore an unmeasured cursor visibility mode")
  }
  const capture = async (label: string, deadline: number) => {
    if (Date.now() >= deadline) {
      throw new Error(`Capture calibration ${label}: paint witness timeout within ${timeoutMs} ms before capture`)
    }
    const frame = await captureRaw(`collector origin calibration: ${label}`, deadline)
    if (Date.now() >= deadline) {
      throw new Error(`Capture calibration ${label}: paint witness timeout within ${timeoutMs} ms after capture`)
    }
    validateFrame(frame)
    return frame
  }
  const changedAndConfirmed = async (
    baseline: CapturedFrame,
    label: string,
    accepts: (frame: CapturedFrame) => boolean,
  ) => {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const current = await capture(label, deadline)
      if (Date.now() >= deadline) {
        throw new Error(
          `Capture calibration ${label}: paint witness timeout within ${timeoutMs} ms; no confirmed current frame`,
        )
      }
      if (!equal(current, baseline) && accepts(current)) {
        const confirmation = await capture(`${label} confirmation`, deadline)
        if (equal(current, confirmation) && Date.now() <= deadline) return confirmation
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `Capture calibration ${label}: paint witness timeout within ${timeoutMs} ms; no confirmed current frame`,
        )
      }
    }
  }
  ctx.write(`\x1b7\x1b[?25l\x1b[0m${background(BLANK)}\x1b[2J\x1b[H`)
  try {
    const beforeWitness = await capture("before baseline witness", Date.now() + timeoutMs)
    for (let offset = 0; offset < beforeWitness.rgba.length; offset += 4) {
      if (rgbAt(beforeWitness, offset, WITNESS)) {
        throw new Error("Capture calibration baseline witness colour was already visible before the requested paint")
      }
    }
    ctx.write(paint(WITNESS_CELL, WITNESS))
    const baseline = await changedAndConfirmed(beforeWitness, "baseline paint witness", (frame) => {
      // This identifies the explicitly requested witness only; it NEVER supplies the origin.
      for (let offset = 0; offset < frame.rgba.length; offset += 4) if (rgbAt(frame, offset, WITNESS)) return true
      return false
    })
    ownCell(
      rectangle(baseline, (offset) => rgbAt(baseline, offset, WITNESS), "baseline paint witness"),
      pixelGeometry,
      "baseline paint witness",
    )
    for (let offset = 0; offset < baseline.rgba.length; offset += 4) {
      if (rgbAt(baseline, offset, CALIBRATION)) {
        throw new Error(
          "Capture calibration requested calibration colour was already visible in its witnessed baseline",
        )
      }
    }
    ctx.write(paint(CALIBRATION_CELL, CALIBRATION))
    const painted = await changedAndConfirmed(baseline, "calibration paint", (frame) => {
      for (let offset = 0; offset < frame.rgba.length; offset += 4) {
        if (rgbAt(frame, offset, CALIBRATION)) return true
      }
      return false
    })
    const changed = (offset: number) =>
      [0, 1, 2, 3].some((channel) => painted.rgba[offset + channel] !== baseline.rgba[offset + channel])
    const rect = rectangle(painted, changed, "calibration paint")
    ownCell(rect, pixelGeometry, "calibration paint")
    for (let y = rect.y; y < rect.y + rect.height; y++) {
      for (let x = rect.x; x < rect.x + rect.width; x++) {
        if (!rgbAt(painted, (y * painted.width + x) * 4, CALIBRATION)) {
          throw new Error("Capture calibration difference did not display the requested truecolor background")
        }
      }
    }
    ctx.write(paint(CALIBRATION_CELL, BLANK))
    const restored = await changedAndConfirmed(painted, "restore paint", (frame) => equal(frame, baseline))
    if (!equal(restored, baseline)) {
      throw new Error("Capture calibration restored cell differs from its witnessed baseline")
    }
    const origin = {
      x: rect.x - (CALIBRATION_CELL.col - 1) * pixelGeometry.cellWidth,
      y: rect.y - (CALIBRATION_CELL.row - 1) * pixelGeometry.cellHeight,
    }
    if (
      origin.x < 0 ||
      origin.y < 0 ||
      origin.x + pixelGeometry.textWidth > painted.width ||
      origin.y + pixelGeometry.textHeight > painted.height
    ) {
      throw new Error(
        `Capture calibration origin ${JSON.stringify(origin)} places terminal text outside its captured window`,
      )
    }
    return {
      origin,
      basis: `collector truecolor calibration: exact solid ${rect.width}x${rect.height} difference at ${rect.x},${rect.y}, own terminal cell ${pixelGeometry.cellWidth}x${pixelGeometry.cellHeight}, cell ${CALIBRATION_CELL.row},${CALIBRATION_CELL.col}; baseline, paint and restore witnessed then confirmed`,
    }
  } finally {
    ctx.write(`\x1b[0m\x1b[2J\x1b8\x1b[?25${visibility === "set" ? "h" : "l"}`)
  }
}
