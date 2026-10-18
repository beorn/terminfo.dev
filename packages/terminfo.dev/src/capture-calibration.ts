import type { CapturePixelGeometry, CaptureRectangle, TermContext } from "@terminfo/probe-defs"
import type { CapturedFrame, NamedTextOrigin } from "./capture-core.ts"

const BLANK = [0, 0, 0] as const
const WITNESS = [255, 0, 255] as const
const CALIBRATION = [255, 0, 0] as const
const background = (rgb: readonly number[]) => `\x1b[48;2;${rgb.join(";")}m`

function refusal(message: string, cause?: unknown): Error {
  const error = new Error(message, { cause })
  error.name = "CaptureCalibrationRefused"
  return error
}

function paintTimeout(message: string): Error {
  const error = new Error(message)
  error.name = "CapturePaintTimeout"
  return error
}

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

/**
 * A macOS window's rounded corner cuts a monotone staircase out of the grid instead of painting it.
 * The observed macOS staircase spans 5 rows by 4 px, so this bound leaves room for a slightly larger
 * radius while still refusing any occlusion that reaches further into the grid.
 */
const CORNER_FILLET_BOUND = 8

type Corner = "top-left" | "top-right" | "bottom-left" | "bottom-right"
const CORNERS: readonly Corner[] = ["top-left", "top-right", "bottom-left", "bottom-right"]

interface CornerFillet {
  corner: Corner
  /** Hole pixels keyed by `y * frame.width + x`, in the solid frame. */
  holes: Set<number>
}

interface GridRaster {
  grid: CaptureRectangle
  fillets: CornerFillet[]
}

function cornerPoint(corner: Corner, grid: CaptureRectangle): { x: number; y: number } {
  return {
    x: corner.endsWith("left") ? grid.x : grid.x + grid.width - 1,
    y: corner.startsWith("top") ? grid.y : grid.y + grid.height - 1,
  }
}

/** The 4-connected hole component that reaches this corner; empty when the corner pixel is painted. */
function filletComponent(
  corner: Corner,
  grid: CaptureRectangle,
  holes: ReadonlySet<number>,
  width: number,
): Set<number> {
  const start = cornerPoint(corner, grid)
  const origin = start.y * width + start.x
  const group = new Set<number>()
  if (!holes.has(origin)) return group
  const queue = [origin]
  group.add(origin)
  while (queue.length > 0) {
    const key = queue.pop()!
    const x = key % width
    const y = (key - x) / width
    for (const [nextX, nextY] of [
      [x - 1, y],
      [x + 1, y],
      [x, y - 1],
      [x, y + 1],
    ] as const) {
      if (nextX < grid.x || nextX >= grid.x + grid.width || nextY < grid.y || nextY >= grid.y + grid.height) {
        continue
      }
      const next = nextY * width + nextX
      if (!holes.has(next) || group.has(next)) continue
      group.add(next)
      queue.push(next)
    }
  }
  return group
}

/** A corner cut is a monotone staircase: contiguous from the corner pixel, one growing run per row. */
function assertCornerStaircase(
  corner: Corner,
  grid: CaptureRectangle,
  group: ReadonlySet<number>,
  width: number,
): void {
  const rows = new Map<number, number[]>()
  for (const key of group) {
    const x = key % width
    const y = (key - x) / width
    const row = corner.startsWith("top") ? y - grid.y : grid.y + grid.height - 1 - y
    const column = corner.endsWith("left") ? x - grid.x : grid.x + grid.width - 1 - x
    if (row < 0 || column < 0 || row >= CORNER_FILLET_BOUND || column >= CORNER_FILLET_BOUND) {
      throw refusal(
        `Capture calibration non-solid grid: the ${corner} fillet reaches ${row + 1} rows x ${column + 1} px in, beyond the ${CORNER_FILLET_BOUND} px corner bound`,
      )
    }
    const columns = rows.get(row) ?? []
    columns.push(column)
    rows.set(row, columns)
  }
  let previous = Number.POSITIVE_INFINITY
  for (let row = 0; row < rows.size; row++) {
    const columns = rows.get(row)
    if (!columns) {
      throw refusal(`Capture calibration non-solid grid: the ${corner} fillet skips a row; a corner cut is connected`)
    }
    columns.sort((left, right) => left - right)
    for (const [index, column] of columns.entries()) {
      if (column !== index) {
        throw refusal(`Capture calibration non-solid grid: the ${corner} fillet is not a monotone staircase`)
      }
    }
    if (columns.length > previous) {
      throw refusal(`Capture calibration non-solid grid: the ${corner} fillet is not a monotone staircase`)
    }
    previous = columns.length
  }
}

/** Count every selected pixel; holes are accepted only as the window's rounded-corner fillets. */
function rectangle(frame: CapturedFrame, selected: (offset: number) => boolean): GridRaster {
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
  if (count === 0) throw refusal("Capture calibration solid grid: no changed pixels")
  const width = right - left + 1,
    height = bottom - top + 1,
    grid: CaptureRectangle = { x: left, y: top, width, height }
  if (count === width * height) return { grid, fillets: [] }
  const holes = new Set<number>()
  for (let y = top; y <= bottom; y++) {
    for (let x = left; x <= right; x++) {
      if (!selected((y * frame.width + x) * 4)) holes.add(y * frame.width + x)
    }
  }
  const fillets: CornerFillet[] = []
  const claimed = new Set<number>()
  for (const corner of CORNERS) {
    const group = filletComponent(corner, grid, holes, frame.width)
    if (group.size === 0) continue
    for (const key of group) {
      if (claimed.has(key)) {
        throw refusal(
          "Capture calibration non-solid grid: one hole connects two window corners; corner fillets are independent cuts",
        )
      }
      claimed.add(key)
    }
    assertCornerStaircase(corner, grid, group, frame.width)
    fillets.push({ corner, holes: group })
  }
  if (claimed.size !== holes.size) {
    throw refusal(
      `Capture calibration non-solid grid: ${count} pixels in ${width}x${height}; holes or separate patches cannot supply geometry`,
    )
  }
  return { grid, fillets }
}

function rgbAt(frame: CapturedFrame, offset: number, rgb: readonly number[]): boolean {
  return frame.rgba[offset] === rgb[0] && frame.rgba[offset + 1] === rgb[1] && frame.rgba[offset + 2] === rgb[2]
}

/**
 * Every unmasked scanline must have the same exact alternating cell edges, not just a sampled row.
 * The corner-fillet mask is excluded: its pixels are not grid paint, and one clipped last stripe at
 * the far edge is accepted with its clip recorded.
 */
function stripeSize(
  frame: CapturedFrame,
  baseline: CapturedFrame,
  grid: CaptureRectangle,
  axis: "columns" | "rows",
  count: number,
  filletMask: ReadonlySet<number>,
): { pitch: number; clip: number } {
  validateFrame(frame)
  validateFrame(baseline)
  if (frame.width !== baseline.width || frame.height !== baseline.height) {
    throw new Error("Capture calibration window dimensions changed")
  }
  const horizontal = axis === "columns"
  const length = horizontal ? grid.width : grid.height
  const across = horizontal ? grid.height : grid.width
  let reference: number[] | undefined
  for (let line = 0; line < across; line++) {
    let masked = false
    for (let position = 0; position < length && !masked; position++) {
      const x = grid.x + (horizontal ? position : line)
      const y = grid.y + (horizontal ? line : position)
      if (filletMask.has(y * frame.width + x)) masked = true
    }
    if (masked) continue
    const edges = [0]
    let previous: boolean | undefined
    for (let position = 0; position < length; position++) {
      const x = grid.x + (horizontal ? position : line)
      const y = grid.y + (horizontal ? line : position)
      const offset = (y * frame.width + x) * 4
      const red = rgbAt(frame, offset, CALIBRATION)
      if (!red && !rgbAt(frame, offset, BLANK)) {
        throw refusal(`Capture calibration ${axis}: ambiguous or non-solid cell paint at ${x},${y}`)
      }
      if (position === 0 && !red) {
        throw refusal(`Capture calibration ${axis}: first edge does not display the requested paint`)
      }
      if (previous !== undefined && red !== previous) edges.push(position)
      previous = red
    }
    edges.push(length)
    if (edges.length !== count + 1) {
      throw refusal(
        `Capture calibration ${axis}: measured ${edges.length - 1} cells, expected ${count}; missing or extra grid edge`,
      )
    }
    const sizes: number[] = []
    for (let index = 1; index < edges.length; index++) {
      const left = edges[index - 1],
        right = edges[index]
      if (left === undefined || right === undefined) throw new Error("Capture calibration lost a measured stripe edge")
      sizes.push(right - left)
    }
    if (!reference) {
      reference = sizes
      continue
    }
    for (const [index, size] of sizes.entries()) {
      if (size !== reference[index]) {
        throw refusal(
          `Capture calibration nonuniform ${axis}: edge ${index + 1} on scanline ${line} has ${size} pixels, expected ${reference[index]}`,
        )
      }
    }
  }
  if (!reference) {
    throw refusal(
      `Capture calibration ${axis}: every scanline is touched by a corner fillet; the pitch cannot be measured`,
    )
  }
  const pitch = reference[0]
  if (pitch === undefined) throw new Error("Capture calibration measured no stripes")
  let clip = 0
  for (let index = 1; index < reference.length; index++) {
    const size = reference[index]!
    if (index === reference.length - 1) {
      if (size > pitch) {
        throw refusal(
          `Capture calibration ${axis}: last stripe is ${size} px, longer than the ${pitch} px pitch; a clip can only shorten the far edge`,
        )
      }
      clip = pitch - size
      continue
    }
    if (size !== pitch) {
      throw refusal(
        `Capture calibration fractional pitch: stripes of ${pitch} and ${size} px on the ${axis} axis; only the last stripe at the far edge may be clipped`,
      )
    }
  }
  return { pitch, clip }
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
  const visibilityReport = await ctx.queryWithSentinelOutcome("\x1b[?25$p", /\x1b\[\?25;([0-4])\$y/)
  if (visibilityReport.reason === "timeout") {
    throw new Error(`Capture calibration cursor visibility query timed out: ${JSON.stringify(visibilityReport)}`)
  }
  const status = visibilityReport.match?.[1]
  if (visibilityReport.reason !== "reply" || (status !== "1" && status !== "2")) {
    throw refusal(
      `Capture calibration cannot restore cursor visibility: ${status === "3" || status === "4" ? "permanent mode" : "unreported mode"}; ${JSON.stringify(visibilityReport)}`,
    )
  }
  const visibility = status === "1" ? "set" : "reset"
  const capture = async (label: string, deadline: number) => {
    if (Date.now() >= deadline) throw paintTimeout(`Capture calibration ${label}: paint witness timeout before capture`)
    const frame = await captureRaw(`collector raster calibration: ${label}`, deadline)
    if (Date.now() >= deadline) throw paintTimeout(`Capture calibration ${label}: paint witness timeout after capture`)
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
        throw paintTimeout(`Capture calibration ${label}: paint witness timeout; no confirmed current frame`)
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
    ctx.write("\x1b[?25l\x1b[0m\x1b[2J\x1b[H")
    baseline = await confirmedFrame("before grid paint", () => true)
    const before = baseline
    for (let offset = 0; offset < baseline.rgba.length; offset += 4) {
      if (rgbAt(baseline, offset, WITNESS)) {
        throw new Error("Capture calibration grid witness colour was already visible before the requested paint")
      }
    }
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
      if (!(cause instanceof Error) || cause.name !== "CapturePaintTimeout" || observedPaint) throw cause
      throw refusal(`Capture calibration paint not observed: ${cause.message}`, cause)
    }
    const { grid, fillets } = rectangle(solid, (offset) => rgbAt(solid, offset, WITNESS))
    const filletMask = new Set<number>()
    for (const fillet of fillets) for (const key of fillet.holes) filletMask.add(key)
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
    // The column paint must be present somewhere in the grid, not at its top-left pixel: a rounded
    // window's corner fillets sit exactly there, so that pixel stays black in every stage.
    const showsCalibrationPaint = (frame: CapturedFrame) => {
      for (let y = grid.y; y < grid.y + grid.height; y++) {
        for (let x = grid.x; x < grid.x + grid.width; x++) {
          const key = y * frame.width + x
          if (!filletMask.has(key) && rgbAt(frame, key * 4, CALIBRATION)) return true
        }
      }
      return false
    }
    const columns = await confirmedFrame("column edge paint", showsCalibrationPaint, solid)
    outsideUnchanged(columns)
    const { pitch: cellWidth, clip: columnClip } = stripeSize(columns, baseline, grid, "columns", ctx.cols, filletMask)
    paintGrid("rows")
    const rows = await confirmedFrame("row edge paint", showsCalibrationPaint, columns)
    outsideUnchanged(rows)
    const { pitch: cellHeight, clip: rowClip } = stripeSize(rows, baseline, grid, "rows", ctx.rows, filletMask)
    // The reported text area is the pitch times the count, not the visible length: a clipped last
    // stripe is shorter than a cell on screen but still occupies a whole cell of the text area.
    const measured = { cellWidth, cellHeight, textWidth: cellWidth * ctx.cols, textHeight: cellHeight * ctx.rows }
    if (
      pixelGeometry &&
      (Object.keys(measured) as Array<keyof CapturePixelGeometry>).some((key) => pixelGeometry[key] !== measured[key])
    ) {
      throw refusal(
        `Capture calibration reported geometry ${JSON.stringify(pixelGeometry)} disagrees with witnessed grid ${JSON.stringify(measured)}`,
      )
    }
    const filletTrace =
      fillets.length === 0
        ? ""
        : `; corner fillets ${fillets.reduce((total, fillet) => total + fillet.holes.size, 0)} px (${fillets
            .map(({ corner, holes }) => `${corner} ${holes.size}`)
            .join(", ")})`
    const clipTrace = `${columnClip > 0 ? `; columns clipped ${columnClip} px at the far edge` : ""}${
      rowClip > 0 ? `; rows clipped ${rowClip} px at the far edge` : ""
    }`
    return {
      origin: { x: grid.x, y: grid.y },
      pixelGeometry: measured,
      basis: `collector complete witnessed raster: ${ctx.cols} columns x ${ctx.rows} rows, every unmasked scanline measures ${cellWidth}x${cellHeight}, visible ${grid.width}x${grid.height} grid at ${grid.x},${grid.y}${filletTrace}${clipTrace}; current paints and identical restore confirmed`,
    }
  } catch (cause) {
    failure = cause
    throw cause
  } finally {
    try {
      let surfaceFailure: unknown
      try {
        ctx.write("\x1b[0m\x1b[2J\x1b[H")
        if (!baseline) throw new Error("Starting blank was never confirmed; restoration cannot be proven")
        const before = baseline
        await confirmedFrame("restore grid paint", (frame) => equal(frame, before), observedPaint)
      } catch (cause) {
        surfaceFailure = cause
      }
      try {
        ctx.write(`\x1b[?25${visibility === "set" ? "h" : "l"}`)
        if ((await ctx.queryMode(25)) !== visibility) {
          throw new Error("Restored cursor visibility differs from its prior mode")
        }
      } catch (cause) {
        if (surfaceFailure !== undefined) {
          throw new AggregateError([surfaceFailure, cause], "Surface and cursor restoration failed", {
            cause: surfaceFailure,
          })
        }
        throw cause
      }
      if (surfaceFailure !== undefined) throw surfaceFailure
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
