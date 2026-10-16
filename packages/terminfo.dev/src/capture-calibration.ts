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
  equal(frame, baseline) // validates dimensions even though the requested paint must differ
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
  const changedAndConfirmed = async (
    baseline: CapturedFrame,
    label: string,
    accepts: (frame: CapturedFrame) => boolean,
  ) => {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const current = await capture(label, deadline)
      if (!equal(current, baseline) && accepts(current)) {
        const confirmation = await capture(`${label} confirmation`, deadline)
        if (equal(current, confirmation)) return confirmation
      }
      if (Date.now() >= deadline) {
        throw new Error(`Capture calibration ${label}: paint witness timeout; no confirmed current frame`)
      }
    }
  }
  const paintGrid = (stage: "solid" | "columns" | "rows" | "restore") => {
    let text = ""
    for (let row = 0; row < ctx.rows; row++) {
      text += `\x1b[${row + 1};1H`
      for (let col = 0; col < ctx.cols; col++) {
        const rgb =
          stage === "solid"
            ? WITNESS
            : stage === "restore"
              ? BLANK
              : (stage === "columns" ? col : row) % 2 === 0
                ? CALIBRATION
                : BLANK
        text += `${background(rgb)} `
      }
    }
    ctx.write(text)
  }
  ctx.write(`\x1b7\x1b[?25l\x1b[0m${background(BLANK)}\x1b[2J\x1b[H`)
  let baseline: CapturedFrame | undefined
  let latest: CapturedFrame | undefined
  let paintIssued = false
  try {
    baseline = await capture("before grid paint", Date.now() + timeoutMs)
    const before = baseline
    latest = baseline
    for (let offset = 0; offset < baseline.rgba.length; offset += 4) {
      if (rgbAt(baseline, offset, WITNESS)) {
        throw new Error("Capture calibration grid witness colour was already visible before the requested paint")
      }
    }
    paintIssued = true
    paintGrid("solid")
    const solid = await changedAndConfirmed(baseline, "solid grid paint", (frame) => {
      for (let offset = 0; offset < frame.rgba.length; offset += 4) if (rgbAt(frame, offset, WITNESS)) return true
      return false
    })
    latest = solid
    const grid = rectangle(solid, (offset) => rgbAt(solid, offset, WITNESS))
    const outsideUnchanged = (frame: CapturedFrame) => {
      equal(frame, before)
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
    const columns = await changedAndConfirmed(solid, "column edge paint", (frame) =>
      rgbAt(frame, (grid.y * frame.width + grid.x) * 4, CALIBRATION),
    )
    latest = columns
    outsideUnchanged(columns)
    const cellWidth = stripeSize(columns, baseline, grid, "columns", ctx.cols)
    paintGrid("rows")
    const rows = await changedAndConfirmed(columns, "row edge paint", (frame) =>
      rgbAt(frame, (grid.y * frame.width + grid.x) * 4, CALIBRATION),
    )
    latest = rows
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
  } finally {
    try {
      if (paintIssued && baseline && latest) {
        const before = baseline
        paintGrid("restore")
        const restored = await changedAndConfirmed(latest, "restore grid paint", (frame) => equal(frame, before))
        if (!equal(restored, baseline)) throw new Error("restored grid differs from its pre-paint frame")
      }
    } catch (cause) {
      const error = new Error(
        `Capture calibration restore failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        { cause },
      )
      error.name = "CaptureRestoreFailed"
      throw error
    } finally {
      ctx.write(`\x1b[0m\x1b8\x1b[?25${visibility === "set" ? "h" : "l"}`)
    }
  }
}
