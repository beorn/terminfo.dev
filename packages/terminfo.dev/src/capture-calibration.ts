import type { CapturePixelGeometry, TermContext } from "@terminfo/probe-defs"
import type { CapturedFrame, CaptureRectangle, NamedTextOrigin } from "./capture-core.ts"

const BLANK = [0, 0, 0] as const
const WITNESS = [255, 0, 255] as const
const CALIBRATION = [255, 0, 0] as const
const background = (rgb: readonly number[]) => `\x1b[48;2;${rgb.join(";")}m`

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

/** Count every selected pixel; a bounding box with a hole or separate patches is not a grid. */
function rectangle(frame: CapturedFrame, selected: (offset: number) => boolean): CaptureRectangle {
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
  if (count === 0) throw new Error("Capture calibration solid grid: no changed pixels")
  const width = right - left + 1,
    height = bottom - top + 1
  if (count !== width * height) {
    throw new Error(
      `Capture calibration non-solid grid: ${count} pixels in ${width}x${height}; holes or separate patches cannot supply geometry`,
    )
  }
  return { x: left, y: top, width, height }
}

function rgbAt(frame: CapturedFrame, offset: number, rgb: readonly number[]): boolean {
  return frame.rgba[offset] === rgb[0] && frame.rgba[offset + 1] === rgb[1] && frame.rgba[offset + 2] === rgb[2]
}

/** Every scanline must have the same exact alternating cell edges, not just a sampled row. */
function stripeSize(
  frame: CapturedFrame,
  baseline: CapturedFrame,
  grid: CaptureRectangle,
  axis: "columns" | "rows",
  count: number,
): number {
  validateFrame(frame)
  validateFrame(baseline)
  if (frame.width !== baseline.width || frame.height !== baseline.height) {
    throw new Error("Capture calibration window dimensions changed")
  }
  const horizontal = axis === "columns"
  const length = horizontal ? grid.width : grid.height
  const across = horizontal ? grid.height : grid.width
  let measured: number | undefined
  for (let line = 0; line < across; line++) {
    const edges = [0]
    let previous: boolean | undefined
    for (let position = 0; position < length; position++) {
      const x = grid.x + (horizontal ? position : line)
      const y = grid.y + (horizontal ? line : position)
      const offset = (y * frame.width + x) * 4
      const red = rgbAt(frame, offset, CALIBRATION)
      if (!red && !rgbAt(frame, offset, BLANK)) {
        throw new Error(`Capture calibration ${axis}: ambiguous or non-solid cell paint at ${x},${y}`)
      }
      if (position === 0 && !red) {
        throw new Error(`Capture calibration ${axis}: first edge does not display the requested paint`)
      }
      if (previous !== undefined && red !== previous) edges.push(position)
      previous = red
    }
    edges.push(length)
    if (edges.length !== count + 1) {
      throw new Error(
        `Capture calibration ${axis}: measured ${edges.length - 1} cells, expected ${count}; missing or extra grid edge`,
      )
    }
    for (let index = 1; index < edges.length; index++) {
      const left = edges[index - 1],
        right = edges[index]
      if (left === undefined || right === undefined) throw new Error("Capture calibration lost a measured stripe edge")
      const size = right - left
      measured ??= size
      if (size !== measured || size < 1) {
        throw new Error(
          `Capture calibration nonuniform ${axis}: edge ${index} on scanline ${line} has ${size} pixels, expected ${measured}`,
        )
      }
    }
  }
  if (measured === undefined || measured * count !== length) {
    throw new Error(`Capture calibration ${axis}: grid boundary disagrees with the complete cell count`)
  }
  return measured
}

/** Same owned run, complete raster edges, exact integer geometry, witnessed identical restore. */
export async function calibrateCaptureOrigin({
  ctx,
  pixelGeometry,
  timeoutMs,
  captureRaw,
}: {
  ctx: TermContext
  pixelGeometry?: CapturePixelGeometry
  timeoutMs: number
  captureRaw: (label: string, deadline: number) => Promise<CapturedFrame>
}): Promise<NamedTextOrigin & { pixelGeometry: CapturePixelGeometry }> {
  if (![ctx.rows, ctx.cols].every((value) => Number.isSafeInteger(value) && value >= 2)) {
    throw new Error("Capture calibration requires a verified grid of at least 2x2 cells")
  }
  if (pixelGeometry && !Object.values(pixelGeometry).every((value) => Number.isSafeInteger(value) && value > 0)) {
    throw new Error("Capture calibration requires positive integer reported pixel geometry")
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("Capture calibration requires the oracle's positive timeoutMs")
  }
  const visibility = await ctx.queryMode(25)
  if (visibility !== "set" && visibility !== "reset") {
    throw new Error("Capture calibration cannot restore an unmeasured cursor visibility mode")
  }
  const capture = async (label: string, deadline: number) => {
    if (Date.now() >= deadline) throw new Error(`Capture calibration ${label}: paint witness timeout before capture`)
    const frame = await captureRaw(`collector raster calibration: ${label}`, deadline)
    if (Date.now() >= deadline) throw new Error(`Capture calibration ${label}: paint witness timeout after capture`)
    validateFrame(frame)
    return frame
  }
  const confirmedFrame = async (
    label: string,
    accepts: (frame: CapturedFrame) => boolean,
    changedFrom?: CapturedFrame,
  ) => {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const current = await capture(label, deadline)
      if ((!changedFrom || !equal(current, changedFrom)) && accepts(current)) {
        const confirmation = await capture(`${label} confirmation`, deadline)
        if (equal(current, confirmation)) return confirmation
      }
      if (Date.now() >= deadline) {
        throw new Error(`Capture calibration ${label}: paint witness timeout; no confirmed current frame`)
      }
    }
  }
  const paintGrid = (stage: "solid" | "columns" | "rows") => {
    let text = ""
    for (let row = 0; row < ctx.rows; row++) {
      text += `\x1b[${row + 1};1H`
      for (let col = 0; col < ctx.cols; col++) {
        const rgb = stage === "solid" ? WITNESS : (stage === "columns" ? col : row) % 2 === 0 ? CALIBRATION : BLANK
        text += `${background(rgb)} `
      }
    }
    ctx.write(text)
  }
  let baseline: CapturedFrame | undefined
  let observedPaint: CapturedFrame | undefined
  let failure: unknown
  try {
    // Normalization and every later mutation are inside the same restoration transaction.
    ctx.write("\x1b[0m\x1b[2J\x1b[H")
    baseline = await confirmedFrame("before grid paint", () => true)
    const before = baseline
    for (let offset = 0; offset < baseline.rgba.length; offset += 4) {
      if (rgbAt(baseline, offset, WITNESS)) {
        throw new Error("Capture calibration grid witness colour was already visible before the requested paint")
      }
    }
    ctx.write("\x1b[?25l")
    paintGrid("solid")
    let solid: CapturedFrame
    try {
      solid = await confirmedFrame(
        "solid grid paint",
        (frame) => {
          for (let offset = 0; offset < frame.rgba.length; offset += 4) {
            if (rgbAt(frame, offset, WITNESS)) {
              observedPaint = frame
              return true
            }
          }
          return false
        },
        baseline,
      )
    } catch (cause) {
      throw new Error(
        `Capture calibration paint ${observedPaint ? "not confirmed" : "not observed"}: ${cause instanceof Error ? cause.message : String(cause)}`,
        { cause },
      )
    }
    const grid = rectangle(solid, (offset) => rgbAt(solid, offset, WITNESS))
    const outsideUnchanged = (frame: CapturedFrame) => {
      validateFrame(frame)
      if (frame.width !== before.width || frame.height !== before.height) {
        throw new Error("Capture calibration window dimensions changed")
      }
      for (let y = 0; y < frame.height; y++) {
        for (let x = 0; x < frame.width; x++) {
          if (x >= grid.x && x < grid.x + grid.width && y >= grid.y && y < grid.y + grid.height) continue
          const offset = (y * frame.width + x) * 4
          for (let channel = 0; channel < 4; channel++) {
            if (frame.rgba[offset + channel] !== before.rgba[offset + channel]) {
              throw new Error("Capture calibration paint changed pixels outside the witnessed grid")
            }
          }
        }
      }
    }
    outsideUnchanged(solid)
    paintGrid("columns")
    const columns = await confirmedFrame(
      "column edge paint",
      (frame) => rgbAt(frame, (grid.y * frame.width + grid.x) * 4, CALIBRATION),
      solid,
    )
    outsideUnchanged(columns)
    const cellWidth = stripeSize(columns, baseline, grid, "columns", ctx.cols)
    paintGrid("rows")
    const rows = await confirmedFrame(
      "row edge paint",
      (frame) => rgbAt(frame, (grid.y * frame.width + grid.x) * 4, CALIBRATION),
      columns,
    )
    outsideUnchanged(rows)
    const cellHeight = stripeSize(rows, baseline, grid, "rows", ctx.rows)
    const measured = { cellWidth, cellHeight, textWidth: grid.width, textHeight: grid.height }
    if (
      pixelGeometry &&
      (Object.keys(measured) as Array<keyof CapturePixelGeometry>).some((key) => pixelGeometry[key] !== measured[key])
    ) {
      throw new Error(
        `Capture calibration reported geometry ${JSON.stringify(pixelGeometry)} disagrees with witnessed grid ${JSON.stringify(measured)}`,
      )
    }
    return {
      origin: { x: grid.x, y: grid.y },
      pixelGeometry: measured,
      basis: `collector complete witnessed raster: ${ctx.cols} columns x ${ctx.rows} rows, every scanline and edge uniform ${cellWidth}x${cellHeight}, exact ${grid.width}x${grid.height} grid at ${grid.x},${grid.y}; current paints and identical restore confirmed`,
    }
  } catch (cause) {
    failure = cause
    throw cause
  } finally {
    try {
      ctx.write(`\x1b[0m\x1b[2J\x1b[H\x1b[?25${visibility === "set" ? "h" : "l"}`)
      if (!baseline) throw new Error("Starting blank was never confirmed; restoration cannot be proven")
      if ((await ctx.queryMode(25)) !== visibility) {
        throw new Error("Restored cursor visibility differs from its prior mode")
      }
      const before = baseline
      await confirmedFrame("restore grid paint", (frame) => equal(frame, before), observedPaint)
    } catch (cause) {
      const original = failure instanceof Error ? failure.message : String(failure)
      const error = new AggregateError(
        failure === undefined ? [cause] : [failure, cause],
        `Capture calibration restore failed: ${cause instanceof Error ? cause.message : String(cause)}${failure === undefined ? "" : `; original calibration error: ${original}`}`,
        { cause: failure ?? cause },
      )
      error.name = "CaptureRestoreFailed"
      throw error
    }
  }
}
