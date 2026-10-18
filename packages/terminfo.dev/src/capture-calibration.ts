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
  for (let key = queue.pop(); key !== undefined; key = queue.pop()) {
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

type Edge = "top" | "bottom" | "left" | "right"
const EDGES: readonly Edge[] = ["top", "bottom", "left", "right"]

interface EdgeBlend {
  edge: Edge
  /** Row for top/bottom, column for left/right. */
  coordinate: number
  /** The one fraction of the paint colour every pixel on the line carries. */
  alpha: number
  /** Line pixels keyed by `y * frame.width + x` in the painted frame. */
  pixels: Set<number>
}

/**
 * A window's cell boundary can fall inside a device pixel, so the paint covers part of the one line
 * directly outside the grid. Every pixel on that line is then the paint colour of the cell beside it
 * at ONE alpha over its own pre-paint value. A second line, a partial span, a second alpha or any
 * other colour is not this effect and stays unexplained. Only a leading-edge line (top for rows, left
 * for columns) is the grid's own first pixel line and counts in cell 1; a trailing-edge line stays
 * outside coverage.
 */
function edgeBlend(edge: Edge, grid: CaptureRectangle, before: CapturedFrame, after: CapturedFrame): EdgeBlend | null {
  const horizontal = edge === "top" || edge === "bottom"
  const length = horizontal ? grid.width : grid.height
  const coordinate =
    edge === "top"
      ? grid.y - 1
      : edge === "bottom"
        ? grid.y + grid.height
        : edge === "left"
          ? grid.x - 1
          : grid.x + grid.width
  if (coordinate < 0 || (horizontal ? coordinate >= after.height : coordinate >= after.width)) return null
  const positions = (position: number): { line: number; paint: number } => {
    const x = horizontal ? grid.x + position : coordinate
    const y = horizontal ? coordinate : grid.y + position
    const paintX = horizontal ? x : edge === "left" ? grid.x : grid.x + grid.width - 1
    const paintY = horizontal ? (edge === "top" ? grid.y : grid.y + grid.height - 1) : y
    return { line: (y * after.width + x) * 4, paint: (paintY * after.width + paintX) * 4 }
  }
  let alpha: number | undefined
  const pixels = new Set<number>()
  for (let position = 0; position < length; position++) {
    const { line, paint } = positions(position)
    for (let channel = 0; channel < 3; channel++) {
      const from = before.rgba[line + channel]
      const to = after.rgba[line + channel]
      const paintChannel = after.rgba[paint + channel]
      if (from === undefined || to === undefined || paintChannel === undefined) {
        throw new Error(`Capture calibration frame is missing byte ${line + channel}`)
      }
      if (paintChannel === from) {
        if (to !== from) return null
        continue
      }
      const candidate = (to - from) / (paintChannel - from)
      if (!(candidate > 0 && candidate < 1)) return null
      if (alpha === undefined) alpha = candidate
      else if (Math.abs(candidate - alpha) > 0.01) return null
      if (Math.abs(to - (from + alpha * (paintChannel - from))) > 1) return null
    }
    pixels.add((line / 4) | 0)
  }
  if (alpha === undefined) return null
  return { edge, coordinate, alpha, pixels }
}

function edgeBlends(grid: CaptureRectangle, before: CapturedFrame, after: CapturedFrame): EdgeBlend[] {
  const blends: EdgeBlend[] = []
  for (const edge of EDGES) {
    const blend = edgeBlend(edge, grid, before, after)
    if (blend) blends.push(blend)
  }
  return blends
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

interface AxisScan {
  horizontal: boolean
  length: number
  across: number
}

function axisScan(grid: CaptureRectangle, axis: "columns" | "rows"): AxisScan {
  const horizontal = axis === "columns"
  return {
    horizontal,
    length: horizontal ? grid.width : grid.height,
    across: horizontal ? grid.height : grid.width,
  }
}

function scanlineHasMask(
  grid: CaptureRectangle,
  scan: AxisScan,
  line: number,
  mask: ReadonlySet<number>,
  width: number,
): boolean {
  for (let position = 0; position < scan.length; position++) {
    const x = grid.x + (scan.horizontal ? position : line)
    const y = grid.y + (scan.horizontal ? line : position)
    if (mask.has(y * width + x)) return true
  }
  return false
}

/** One scanline's alternating cell edges, as stripe sizes; refuses anything but calibration or blank. */
function scanlineSizes(
  frame: CapturedFrame,
  grid: CaptureRectangle,
  scan: AxisScan,
  axis: "columns" | "rows",
  line: number,
  count: number,
): number[] {
  const edges = [0]
  let previous: boolean | undefined
  for (let position = 0; position < scan.length; position++) {
    const x = grid.x + (scan.horizontal ? position : line)
    const y = grid.y + (scan.horizontal ? line : position)
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
  edges.push(scan.length)
  if (edges.length !== count + 1) {
    throw refusal(
      `Capture calibration ${axis}: measured ${edges.length - 1} cells, expected ${count}; missing or extra grid edge`,
    )
  }
  const sizes: number[] = []
  for (let index = 1; index < edges.length; index++) {
    const left = edges[index - 1]
    const right = edges[index]
    if (left === undefined || right === undefined) throw new Error("Capture calibration lost a measured stripe edge")
    sizes.push(right - left)
  }
  return sizes
}

/** One integer pitch, with at most the last stripe shorter; any other variation is a fractional pitch. */
function acceptPitch(sizes: readonly number[], axis: "columns" | "rows"): { pitch: number; clip: number } {
  const pitch = sizes[0]
  if (pitch === undefined) throw new Error("Capture calibration measured no stripes")
  let clip = 0
  for (let index = 1; index < sizes.length; index++) {
    const size = sizes[index]
    if (size === undefined) throw new Error("Capture calibration lost a measured stripe size")
    if (index === sizes.length - 1) {
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

// The measured pitch must explain the whole grid, so every unmasked pixel on every scanline is
// checked, masked or not; only the fillet pixels themselves are exempt.
function validatePaint(
  frame: CapturedFrame,
  grid: CaptureRectangle,
  scan: AxisScan,
  axis: "columns" | "rows",
  count: number,
  pitch: number,
  mask: ReadonlySet<number>,
  lead: 0 | 1,
): void {
  for (let line = 0; line < scan.across; line++) {
    for (let position = 0; position < scan.length; position++) {
      const x = grid.x + (scan.horizontal ? position : line)
      const y = grid.y + (scan.horizontal ? line : position)
      const key = y * frame.width + x
      if (mask.has(key)) continue
      const offset = key * 4
      // A leading-edge line is outside the scanned interior but counts in cell 1, so every cell
      // boundary is offset by its one pixel.
      const cell = Math.min(count - 1, Math.floor((position + lead) / pitch))
      const expectsCalibration = cell % 2 === 0
      const calibration = rgbAt(frame, offset, CALIBRATION)
      const blank = rgbAt(frame, offset, BLANK)
      if (calibration === expectsCalibration && (calibration || blank)) continue
      const painted = calibration ? "calibration paint" : blank ? "blank paint" : "neither calibration nor blank"
      throw refusal(
        `Capture calibration ${axis}: ${painted} at ${x},${y} on cell ${cell + 1}; the measured ${pitch} px pitch expects ${expectsCalibration ? "calibration" : "blank"} paint`,
      )
    }
  }
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
  lead: 0 | 1,
): { pitch: number; clip: number } {
  validateFrame(frame)
  validateFrame(baseline)
  if (frame.width !== baseline.width || frame.height !== baseline.height) {
    throw new Error("Capture calibration window dimensions changed")
  }
  const scan = axisScan(grid, axis)
  let reference: number[] | undefined
  for (let line = 0; line < scan.across; line++) {
    if (scanlineHasMask(grid, scan, line, filletMask, frame.width)) continue
    const sizes = scanlineSizes(frame, grid, scan, axis, line, count)
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
  // The interior scan is unchanged; the admitted leading line is added to the first stripe only, so
  // a line beside an already-full first stripe still refuses as a fractional pitch.
  const sizes = reference.map((size, index) => (index === 0 ? size + lead : size))
  const { pitch, clip } = acceptPitch(sizes, axis)
  validatePaint(frame, grid, scan, axis, count, pitch, filletMask, lead)
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
    const outsideUnchanged = (frame: CapturedFrame): EdgeBlend[] => {
      validateFrame(frame)
      if (frame.width !== before.width || frame.height !== before.height) {
        throw new Error("Capture calibration window dimensions changed")
      }
      const blends = edgeBlends(grid, before, frame)
      const explained = new Set<number>()
      for (const blend of blends) for (const key of blend.pixels) explained.add(key)
      for (let y = 0; y < frame.height; y++) {
        for (let x = 0; x < frame.width; x++) {
          if (x >= grid.x && x < grid.x + grid.width && y >= grid.y && y < grid.y + grid.height) continue
          const offset = (y * frame.width + x) * 4
          // The blend model covers colour only: it says nothing about the alpha byte, which stays
          // exactly as the baseline frame had it even on an explained pixel.
          for (let channel = explained.has(y * frame.width + x) ? 3 : 0; channel < 4; channel++) {
            if (frame.rgba[offset + channel] !== before.rgba[offset + channel]) {
              throw new Error("Capture calibration paint changed pixels outside the witnessed grid")
            }
          }
        }
      }
      return blends
    }
    const solidBlends = outsideUnchanged(solid)
    // One axis-generic rule: an axis's leading edge is the grid's own first pixel line only when that
    // line was admitted on the solid frame and on the axis's own frame. Lead is 1 or 0, never a width.
    const leadingLine = (axis: "columns" | "rows", own: readonly EdgeBlend[]): EdgeBlend | null => {
      const edge: Edge = axis === "columns" ? "left" : "top"
      const admitted = solidBlends.some((blend) => blend.edge === edge) && own.some((blend) => blend.edge === edge)
      return admitted ? (own.find((blend) => blend.edge === edge) ?? null) : null
    }
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
    const columnBlends = outsideUnchanged(columns)
    const columnLine = leadingLine("columns", columnBlends)
    const columnLead: 0 | 1 = columnLine === null ? 0 : 1
    const { pitch: cellWidth, clip: columnClip } = stripeSize(
      columns,
      baseline,
      grid,
      "columns",
      ctx.cols,
      filletMask,
      columnLead,
    )
    paintGrid("rows")
    const rows = await confirmedFrame("row edge paint", showsCalibrationPaint, columns)
    const rowBlends = outsideUnchanged(rows)
    const rowLine = leadingLine("rows", rowBlends)
    const rowLead: 0 | 1 = rowLine === null ? 0 : 1
    const { pitch: cellHeight, clip: rowClip } = stripeSize(rows, baseline, grid, "rows", ctx.rows, filletMask, rowLead)
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
    // The authored extent is the interior extended by the admitted leading line, so crops, the text
    // origin and the reported-geometry comparison all use the grid the terminal actually painted.
    const authored = {
      x: grid.x - columnLead,
      y: grid.y - rowLead,
      width: grid.width + columnLead,
      height: grid.height + rowLead,
    }
    const leadTrace = [columnLine, rowLine]
      .filter((line): line is EdgeBlend => line !== null)
      .map(
        (line) =>
          `; leading line counted in cell 1: ${line.edge} ${line.edge === "left" ? "x" : "y"}=${line.coordinate} alpha ${line.alpha.toFixed(3)}`,
      )
      .join("")
    const admittedBlends = [
      ...solidBlends.map((blend) => ({ stage: "solid", blend })),
      ...columnBlends.map((blend) => ({ stage: "columns", blend })),
      ...rowBlends.map((blend) => ({ stage: "rows", blend })),
    ]
    const blendTrace =
      admittedBlends.length === 0
        ? ""
        : `; edge blend ${admittedBlends
            .map(
              ({ stage, blend: { edge, coordinate, alpha, pixels } }) =>
                `${stage} ${edge} ${edge === "top" || edge === "bottom" ? "y" : "x"}=${coordinate} alpha ${alpha.toFixed(3)} (${pixels.size} px)`,
            )
            .join(", ")}`
    return {
      origin: { x: authored.x, y: authored.y },
      pixelGeometry: measured,
      ...(columnClip > 0 || rowClip > 0 ? { visible: { width: authored.width, height: authored.height } } : {}),
      basis: `collector complete witnessed raster: ${ctx.cols} columns x ${ctx.rows} rows, every unmasked scanline measures ${cellWidth}x${cellHeight}, visible ${authored.width}x${authored.height} grid at ${authored.x},${authored.y}${filletTrace}${blendTrace}${leadTrace}${clipTrace}; current paints and identical restore confirmed`,
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
