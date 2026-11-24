import {
  CALIBRATION_SENTINEL_FORMS,
  CALIBRATION_SOLID_PAINT,
  type AlternateScreenMode,
  type CalibrationSentinelForm,
  beginCaptureLifecycle,
  type CalibrationSentinel,
  type CapturePixelGeometry,
  type CaptureRectangle,
  type CaptureScreenMode,
  type TermProbeSource,
} from "@terminfo/probe-defs"
import { clearLine, cursorHome, cursorTo } from "@silvery/ansi"
import { CAPTURE_COMMAND_DEADLINE, type CapturedFrame, type NamedTextOrigin } from "./capture-core.ts"

function refusal(message: string, cause?: unknown): Error {
  const error = new Error(message, { cause })
  error.name = "CaptureCalibrationRefused"
  return error
}

/**
 * The stable sentence every stored row reason quotes (#37667 review d0efc86e). Detail rides beside it on
 * the error, so a run read later groups by the sentence and the changing pixel facts are recorded once.
 */
export const CAPTURE_PAINT_OUTSIDE_GRID_REFUSAL = "Capture calibration paint changed pixels outside the witnessed grid"

/**
 * The per-refusal detail a caller records once per run, never inside each row's stored reason. It rides on the
 * error rather than its message, so the message stays the sentence every stored row already quotes.
 */
export interface CaptureCalibrationRefusal extends Error {
  detail?: string
  /** The baseline and the refusing stage's frame, carried so the run can archive the pair it judged. */
  frames?: { before: CapturedFrame; after: CapturedFrame; stage: string }
  /**
   * The stable kind of refusal. `paint-outside-grid` is the one case the run retries once (#37667 a);
   * the message stays the stored rows' stable sentence, so the kind never rides on wording.
   */
  code?: "paint-outside-grid"
}

function outsideGridRefusal(detail: string, frames: CaptureCalibrationRefusal["frames"]): Error {
  return Object.assign(refusal(CAPTURE_PAINT_OUTSIDE_GRID_REFUSAL), {
    code: "paint-outside-grid" as const,
    detail,
    frames,
  })
}

/**
 * What a confirmation stage's captures did, carried on its paint timeout so a refusal can say whether the paint
 * never came or a capture outran the deadline (#37678). Only the last frame is kept: frames are megabytes each.
 */
interface StageCaptures {
  captures: Array<{ ms: number; late: boolean; accepted?: boolean }>
  last?: CapturedFrame
}

function paintTimeout(message: string, stage?: StageCaptures): Error {
  const error = new Error(message)
  error.name = "CapturePaintTimeout"
  return stage === undefined ? error : Object.assign(error, { stage })
}

/** Every pixel `after` changed from `before`: the count, bounding box, distinct after-colours and the first few. */
function frameDifference(
  before: CapturedFrame,
  after: CapturedFrame,
  excused?: (x: number, y: number, offset: number) => boolean,
): string {
  if (before.width !== after.width || before.height !== after.height) {
    return `is ${after.width}x${after.height}, the normal sentinel paint ${before.width}x${before.height}`
  }
  let pixels = 0
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = -1
  let maxY = -1
  const colours = new Set<string>()
  const first: string[] = []
  const rgba = (source: CapturedFrame, offset: number) =>
    `${source.rgba[offset]},${source.rgba[offset + 1]},${source.rgba[offset + 2]}@${source.rgba[offset + 3]}`
  for (let y = 0; y < after.height; y++) {
    for (let x = 0; x < after.width; x++) {
      const offset = (y * after.width + x) * 4
      if ([0, 1, 2, 3].every((channel) => after.rgba[offset + channel] === before.rgba[offset + channel])) continue
      if (excused?.(x, y, offset)) continue
      pixels++
      minX = Math.min(minX, x)
      minY = Math.min(minY, y)
      maxX = Math.max(maxX, x)
      maxY = Math.max(maxY, y)
      colours.add(rgba(after, offset))
      if (first.length < FIRST_OFFENDING_PIXELS) {
        first.push(`(${x},${y}) ${rgba(before, offset)}->${rgba(after, offset)}`)
      }
    }
  }
  if (pixels === 0) return "equals the normal sentinel paint"
  return (
    `differs from the normal sentinel paint in ${pixels} pixel(s), bbox (${minX},${minY})-(${maxX},${maxY}), ` +
    `${colours.size} distinct after-colour(s); first: ${first.join("; ")}`
  )
}

/**
 * Whether a reverse witness stage ran out of time (#35058). The stage deadline is also the one each capture's
 * own command steps receive, so it can expire inside a capture as well as between captures; either way the
 * paint was not seen in time.
 */
function reverseStageTimedOut(cause: unknown): boolean {
  return cause instanceof Error && (cause.name === "CapturePaintTimeout" || cause.name === CAPTURE_COMMAND_DEADLINE)
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

/**
 * A strip of the window, in window pixels, that the terminal's own chrome repaints by itself: Warp's title bar shows an
 * "Update Warp" pill about 3 s after launch (33056, @cto f15dec92), and Cursor's terminal scrollbar fades in and out
 * beside the grid (37222, @cto 4b98fa6f). Without `x` and `width` it spans the full window width; with both it is the
 * rectangle x..x+width-1. Declared per terminal; absent keeps the whole-window rule. Inside it, changes are excused
 * for the outside-grid comparison and the restore match only, and the record states the strip and how many pixels
 * changed in it. It may not touch the grid or the grid's one-pixel edge line.
 */
export type CaptureChromeBand = {
  readonly y: number
  readonly height: number
  readonly x?: number
  readonly width?: number
  readonly reason: string
}

/** A validated band's half-open pixel bounds; a band without columns runs from x 0 past any window's right edge. */
type ChromeBandBounds = { readonly top: number; readonly bottom: number; readonly left: number; readonly right: number }

function chromeBandBounds(band: CaptureChromeBand): ChromeBandBounds {
  const { x, width } = band
  const columns =
    x === undefined && width === undefined
      ? { left: 0, right: Infinity }
      : x !== undefined &&
          width !== undefined &&
          Number.isSafeInteger(x) &&
          Number.isSafeInteger(width) &&
          x >= 0 &&
          width >= 1
        ? { left: x, right: x + width }
        : undefined
  if (
    !columns ||
    !Number.isSafeInteger(band.y) ||
    !Number.isSafeInteger(band.height) ||
    band.y < 0 ||
    band.height < 1 ||
    band.reason.trim() === ""
  ) {
    throw new Error(
      `Capture calibration chrome band must be integer y >= 0, height >= 1, x >= 0 and width >= 1 together or neither, with a reason: ${JSON.stringify(band)}`,
    )
  }
  return { top: band.y, bottom: band.y + band.height, ...columns }
}

/** The band's rows, and its columns unless it spans the full width, as the record and refusals print them. */
function chromeBandExtent(band: CaptureChromeBand): string {
  const rows = `y ${band.y}..${band.y + band.height - 1}`
  return band.x === undefined || band.width === undefined
    ? `${rows} full width`
    : `${rows} x ${band.x}..${band.x + band.width - 1}`
}

/**
 * The refusal when the band reaches the grid or the one-pixel blend line beside it, so no paint the grid owns is
 * excused; undefined when it stays clear. A full-width band keeps its original wording; a rectangle names both axes.
 */
function chromeBandOverlap(
  band: CaptureChromeBand,
  bounds: ChromeBandBounds,
  grid: CaptureRectangle,
): string | undefined {
  const touches =
    bounds.top < grid.y + grid.height + 1 &&
    bounds.bottom > grid.y - 1 &&
    bounds.left < grid.x + grid.width + 1 &&
    bounds.right > grid.x - 1
  if (!touches) return undefined
  const gridRows = `${grid.y}..${grid.y + grid.height - 1}`
  const overlap =
    band.x === undefined
      ? `y ${band.y}..${band.y + band.height - 1} overlaps the witnessed grid rows ${gridRows}`
      : `${chromeBandExtent(band)} overlaps the witnessed grid y ${gridRows} x ${grid.x}..${grid.x + grid.width - 1}`
  return `Capture calibration declared chrome band ${overlap} (with its edge line)`
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
 * Pixel equality restricted to one axis-aligned box (#38084): after a paint-outside-grid refusal
 * (e.g. a macOS overlay scrollbar fading out after baseline was captured), restoreGrid must still
 * prove the witnessed grid itself returned to baseline rather than spinning until timeout waiting
 * for the already-faded outside chrome to reappear.
 */
function equalInside(
  left: CapturedFrame,
  right: CapturedFrame,
  box: { readonly x: number; readonly y: number; readonly width: number; readonly height: number },
): boolean {
  validateFrame(left)
  validateFrame(right)
  if (left.width !== right.width || left.height !== right.height) {
    throw new Error("Capture calibration window dimensions changed")
  }
  const endY = Math.min(left.height, box.y + box.height)
  const endX = Math.min(left.width, box.x + box.width)
  for (let y = Math.max(0, box.y); y < endY; y++) {
    for (let x = Math.max(0, box.x); x < endX; x++) {
      const offset = (y * left.width + x) * 4
      if (
        left.rgba[offset] !== right.rgba[offset] ||
        left.rgba[offset + 1] !== right.rgba[offset + 1] ||
        left.rgba[offset + 2] !== right.rgba[offset + 2] ||
        left.rgba[offset + 3] !== right.rgba[offset + 3]
      ) {
        return false
      }
    }
  }
  return true
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
    // A row may carry ONE more cut pixel than the row above it: the antialiased rim of the window's
    // rounded corner is drawn in blend colours, so a rim pixel that differs from the paint by one
    // step joins the cut run and lengthens it. The retained Terminal.app 2.15 (macOS 26.6.2) corner
    // measures 10, 8, 5, 6, 3 columns per row for exactly that reason. Anything longer is an
    // occlusion growing into the grid, not a rim, and still refuses.
    if (columns.length > previous + 1) {
      throw refusal(`Capture calibration non-solid grid: the ${corner} fillet is not a monotone staircase`)
    }
    previous = columns.length
  }
}

/** The corner cut plus its one-pixel rim, clipped to the grid.
 *
 * A rounded corner's rim is a blend of the paint colour with the cut, so whether a rim pixel is
 * exactly the paint depends on which colour is painted: on the retained Alacritty specimen the same
 * rim is exactly the solid stage's magenta under `45m` and one least-significant bit off the columns
 * stage's red under `41m` (44 rim pixels, rows 620-626, columns 1-6 and 793-798). The mask is
 * measured on the solid stage alone, so it must cover the rim for every later stage; otherwise a
 * window whose grid reaches its rounded corners can never validate. No rim pixel can carry a stripe
 * edge — the arc stays inside CORNER_FILLET_BOUND — and a mask that would blanket a scanline still
 * refuses as "every scanline is touched by a corner fillet". */
function dilateFilletMask(fillets: readonly CornerFillet[], grid: CaptureRectangle, width: number): Set<number> {
  const mask = new Set<number>()
  for (const fillet of fillets) for (const key of fillet.holes) mask.add(key)
  for (const key of Array.from(mask)) {
    const x = key % width
    const y = (key - x) / width
    for (let nextX = x - 1; nextX <= x + 1; nextX++) {
      if (nextX < grid.x || nextX >= grid.x + grid.width) continue
      for (let nextY = y - 1; nextY <= y + 1; nextY++) {
        if (nextY < grid.y || nextY >= grid.y + grid.height) continue
        mask.add(nextY * width + nextX)
      }
    }
  }
  return mask
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
    let informative = false
    let fractional = false
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
      informative = true
      const candidate = (to - from) / (paintChannel - from)
      if (candidate > 0 && candidate < 1) {
        fractional = true
        alpha ??= candidate
      }
    }
    // Rounding may put one component at an endpoint, but each changed pixel
    // must itself witness fractional coverage; another pixel cannot supply it.
    if (informative && !fractional) return null
    pixels.add((line / 4) | 0)
  }
  if (alpha === undefined) return null
  // Infer first so an endpoint in an earlier RGB component is checked against
  // the same actual fractional witness as every later component on the edge.
  for (let position = 0; position < length; position++) {
    const { line, paint } = positions(position)
    for (let channel = 0; channel < 3; channel++) {
      const from = before.rgba[line + channel]
      const to = after.rgba[line + channel]
      const paintChannel = after.rgba[paint + channel]
      if (from === undefined || to === undefined || paintChannel === undefined) {
        throw new Error(`Capture calibration frame is missing byte ${line + channel}`)
      }
      if (paintChannel === from) continue // Exact equality was checked before inference.
      if (Math.abs((to - from) / (paintChannel - from) - alpha) > 0.01) return null
      if (Math.abs(to - (from + alpha * (paintChannel - from))) > 1) return null
    }
  }
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

const CLASS_RADIUS_MAX = 1
const CLASS_SEPARATION_MIN = 16
/** How many stray pixels a refusal quotes before summarising the rest by count. */
const FIRST_OFFENDING_PIXELS = 6

type RgbTriple = readonly [number, number, number]

interface PaintColorClass {
  readonly anchor: RgbTriple
  readonly members: ReadonlySet<number>
  readonly triples: readonly RgbTriple[]
}

export interface CalibratedPaintClass {
  readonly anchor: RgbTriple
  readonly members: ReadonlySet<number>
}

export interface CalibratedPaintClasses {
  readonly background: CalibratedPaintClass
  readonly sentinel: CalibratedPaintClass
}

/**
 * The background and sentinel paint witnessed on calibration's own blank canvas while the reverse screen
 * mode (DECSCNM) was set, or why no usable witness exists (#34932, @cto 34932-reverse-seam-ruling-2325 item 2). Collector-local,
 * like the normal classes: it selects paint for a read and is never a frame or run fact.
 */
export type ReverseScreenWitness =
  | {
      readonly status: "witnessed"
      readonly sentinel: CalibrationSentinel
      readonly paintClasses: CalibratedPaintClasses
    }
  | { readonly status: "unavailable"; readonly reason: string }

/**
 * Live alternate-screen origin, cell geometry and paint classes witnessed within the same capture
 * session (#37701, @cto be5f14e5). Never cached across runs; unavailable carries the refusal reason
 * so alt-screen rows remain probe-todo naming "alternate screen not calibrated: <reason>".
 */
export type AlternateScreenWitness =
  | {
      readonly status: "witnessed"
      readonly origin: { readonly x: number; readonly y: number }
      readonly pixelGeometry: CapturePixelGeometry
      readonly sentinel: CalibrationSentinel
      readonly paintClasses: CalibratedPaintClasses
    }
  | { readonly status: "unavailable"; readonly reason: string }

function packRgb(red: number, green: number, blue: number): number {
  return (red << 16) | (green << 8) | blue
}

function unpackRgb(packed: number): RgbTriple {
  return [(packed >> 16) & 255, (packed >> 8) & 255, packed & 255]
}

function chebyshevRgb(left: RgbTriple, right: RgbTriple): number {
  return Math.max(Math.abs(left[0] - right[0]), Math.abs(left[1] - right[1]), Math.abs(left[2] - right[2]))
}

/**
 * Paint is an opaque pixel whose RGB is a class member. A window's rounded corner can be drawn as alpha rather than
 * as an opaque mask: hosted iTerm2 3.6.11 (run 44161536804) draws its bottom-left rim at alpha 0, 4, 70, 207 while the
 * RGB stays the paint's, so an RGB-only test counted the alpha-4 pixel as paint and split the corner cut (34664).
 * A pixel the window does not cover opaquely is outside its shape, so it joins the fillet instead. Linux frames carry
 * no alpha channel and decode opaque.
 */
function inColorClass(
  frame: CapturedFrame,
  offset: number,
  colorClass: PaintColorClass,
  options?: { readonly premultiplied?: boolean },
): boolean {
  const alpha = frame.rgba[offset + 3]
  const red = frame.rgba[offset]
  const green = frame.rgba[offset + 1]
  const blue = frame.rgba[offset + 2]
  if (alpha === undefined || red === undefined || green === undefined || blue === undefined) return false
  if (alpha === 255) return colorClass.members.has(packRgb(red, green, blue))
  if (!options?.premultiplied || alpha === 0) return false
  // screencapture un-premultiplies CoreGraphics BGRA
  const premulRed = Math.round((red * alpha) / 255)
  const premulGreen = Math.round((green * alpha) / 255)
  const premulBlue = Math.round((blue * alpha) / 255)
  return colorClass.triples.some(
    ([memberRed, memberGreen, memberBlue]) =>
      Math.round((memberRed * alpha) / 255) === premulRed &&
      Math.round((memberGreen * alpha) / 255) === premulGreen &&
      Math.round((memberBlue * alpha) / 255) === premulBlue,
  )
}

/**
 * Occupied-member colour class anchored at `anchor` within Chebyshev radius R=1 (34480, @cto 34480-fresh-owner-contract-go-2141):
 * only RGB triples actually present in `occupiedCounts` within one code per channel of `anchor` are admitted.
 */
function buildPaintColorClass(occupiedCounts: ReadonlyMap<number, number>, anchor: RgbTriple): PaintColorClass {
  const members = new Set<number>([packRgb(anchor[0], anchor[1], anchor[2])])
  for (const packed of occupiedCounts.keys()) {
    if (chebyshevRgb(unpackRgb(packed), anchor) <= CLASS_RADIUS_MAX) members.add(packed)
  }
  return { anchor, members, triples: [...members].map(unpackRgb) }
}

function minClassDistance(left: PaintColorClass, right: PaintColorClass): number {
  let min = Number.POSITIVE_INFINITY
  for (const u of left.triples) {
    for (const v of right.triples) {
      const distance = chebyshevRgb(u, v)
      if (distance < min) min = distance
    }
  }
  return min
}

function localAnchor(occupiedCounts: ReadonlyMap<number, number>, seed: RgbTriple): RgbTriple {
  let best = seed
  let bestCount = -1
  for (const [packed, count] of occupiedCounts.entries()) {
    const rgb = unpackRgb(packed)
    if (chebyshevRgb(rgb, seed) <= CLASS_RADIUS_MAX && count > bestCount) {
      best = rgb
      bestCount = count
    }
  }
  return best
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
  classes: readonly [PaintColorClass, PaintColorClass],
): number[] {
  const edges = [0]
  let previous: boolean | undefined
  for (let position = 0; position < scan.length; position++) {
    const x = grid.x + (scan.horizontal ? position : line)
    const y = grid.y + (scan.horizontal ? line : position)
    const offset = (y * frame.width + x) * 4
    const red = inColorClass(frame, offset, classes[0])
    if (!red && !inColorClass(frame, offset, classes[1])) {
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
  classes: readonly [PaintColorClass, PaintColorClass],
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
      const calibration = inColorClass(frame, offset, classes[0])
      const blank = inColorClass(frame, offset, classes[1])
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
  classes: readonly [PaintColorClass, PaintColorClass],
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
    const sizes = scanlineSizes(frame, grid, scan, axis, line, count, classes)
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
  validatePaint(frame, grid, scan, axis, count, pitch, filletMask, lead, classes)
  return { pitch, clip }
}

const findSolidWitnessClass = (
  before: CapturedFrame,
  solid: CapturedFrame,
): { witness: RgbTriple; witnessClass: PaintColorClass } => {
  // The most frequent changed RGB anchors an R=1 occupied-member paint class (34480); the existing
  // complete rectangle, outside-grid and stripe checks still prove its geometry or refuse it.
  const colorsByCount = new Map<number, number>()
  for (let offset = 0; offset < solid.rgba.length; offset += 4) {
    if (
      solid.rgba[offset] === before.rgba[offset] &&
      solid.rgba[offset + 1] === before.rgba[offset + 1] &&
      solid.rgba[offset + 2] === before.rgba[offset + 2]
    ) {
      continue
    }
    const r = solid.rgba[offset]
    const g = solid.rgba[offset + 1]
    const b = solid.rgba[offset + 2]
    if (r === undefined || g === undefined || b === undefined) {
      throw new Error(`Capture calibration solid frame is missing RGB bytes at ${offset}`)
    }
    const packed = packRgb(r, g, b)
    colorsByCount.set(packed, (colorsByCount.get(packed) ?? 0) + 1)
  }
  const witnessPacked = [...colorsByCount.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
  if (witnessPacked === undefined) throw refusal("Capture calibration solid grid: no changed pixels")
  const witness = unpackRgb(witnessPacked)
  const witnessClass = buildPaintColorClass(colorsByCount, witness)
  for (let offset = 0; offset < before.rgba.length; offset += 4) {
    if (inColorClass(before, offset, witnessClass)) {
      // A named refusal like every other ambiguous witness, so the reverse screen stage names it unavailable (#37278:
      // kitty's SGR 7 form under DECSCNM shows only the black of its unreversed padding).
      throw refusal("Capture calibration grid witness colour was already visible before the requested paint")
    }
  }
  return { witness, witnessClass }
}

const shrinkEdgeBlendPerimeter = (
  solidFrame: CapturedFrame,
  before: CapturedFrame,
  initial: { grid: CaptureRectangle; fillets: CornerFillet[] },
  witness: RgbTriple,
  witnessClass: PaintColorClass,
): { grid: CaptureRectangle; fillets: CornerFillet[] } => {
  let { grid, fillets } = initial
  // A 1-pixel edge-blend line whose alpha rounds within 1 code of the paint (e.g. 240/241 of 241) falls inside R=1
  // yet carries zero pixels of the exact anchor and satisfies `edgeBlend` against the adjacent interior line.
  for (const edge of EDGES) {
    const horizontal = edge === "top" || edge === "bottom"
    if ((horizontal ? grid.height : grid.width) <= 1) continue
    const fixed =
      edge === "top"
        ? grid.y
        : edge === "bottom"
          ? grid.y + grid.height - 1
          : edge === "left"
            ? grid.x
            : grid.x + grid.width - 1
    const length = horizontal ? grid.width : grid.height
    let hasAnchor = false
    for (let pos = 0; pos < length; pos++) {
      const x = horizontal ? grid.x + pos : fixed
      const y = horizontal ? fixed : grid.y + pos
      const off = (y * solidFrame.width + x) * 4
      if (
        solidFrame.rgba[off] === witness[0] &&
        solidFrame.rgba[off + 1] === witness[1] &&
        solidFrame.rgba[off + 2] === witness[2]
      ) {
        hasAnchor = true
        break
      }
    }
    if (hasAnchor) continue
    const shrunk: CaptureRectangle =
      edge === "top"
        ? { x: grid.x, y: grid.y + 1, width: grid.width, height: grid.height - 1 }
        : edge === "bottom"
          ? { x: grid.x, y: grid.y, width: grid.width, height: grid.height - 1 }
          : edge === "left"
            ? { x: grid.x + 1, y: grid.y, width: grid.width - 1, height: grid.height }
            : { x: grid.x, y: grid.y, width: grid.width - 1, height: grid.height }
    if (edgeBlend(edge, shrunk, before, solidFrame) !== null) {
      ;({ grid, fillets } = rectangle(solidFrame, (offset) => {
        const pixel = offset / 4
        const x = pixel % solidFrame.width
        const y = (pixel - x) / solidFrame.width
        if (x < shrunk.x || x >= shrunk.x + shrunk.width || y < shrunk.y || y >= shrunk.y + shrunk.height) {
          return false
        }
        return inColorClass(solidFrame, offset, witnessClass)
      }))
    }
  }
  return { grid, fillets }
}

const unmaskedOccupied = (
  frame: CapturedFrame,
  grid: CaptureRectangle,
  filletMask: Set<number>,
): Map<number, number> => {
  const occupied = new Map<number, number>()
  for (let y = grid.y; y < grid.y + grid.height; y++) {
    for (let x = grid.x; x < grid.x + grid.width; x++) {
      const key = y * frame.width + x
      if (filletMask.has(key)) continue
      const offset = key * 4
      const r = frame.rgba[offset]
      const g = frame.rgba[offset + 1]
      const b = frame.rgba[offset + 2]
      if (r === undefined || g === undefined || b === undefined) {
        throw new Error(`Capture calibration frame is missing RGB bytes at ${offset}`)
      }
      const packed = packRgb(r, g, b)
      occupied.set(packed, (occupied.get(packed) ?? 0) + 1)
    }
  }
  return occupied
}

const findColumnStripeClasses = (
  columns: CapturedFrame,
  grid: CaptureRectangle,
  filletMask: Set<number>,
  columnOccupied: Map<number, number>,
): [PaintColorClass, PaintColorClass] => {
  for (let y = grid.y; y < grid.y + grid.height; y++) {
    if (scanlineHasMask(grid, axisScan(grid, "columns"), y - grid.y, filletMask, columns.width)) continue
    const first = (y * columns.width + grid.x) * 4
    const firstSeed: RgbTriple = [columns.rgba[first] ?? 0, columns.rgba[first + 1] ?? 0, columns.rgba[first + 2] ?? 0]
    const calClass = buildPaintColorClass(columnOccupied, localAnchor(columnOccupied, firstSeed))
    for (let x = grid.x + 1; x < grid.x + grid.width; x++) {
      const offset = (y * columns.width + x) * 4
      if (!inColorClass(columns, offset, calClass)) {
        const secondSeed: RgbTriple = [
          columns.rgba[offset] ?? 0,
          columns.rgba[offset + 1] ?? 0,
          columns.rgba[offset + 2] ?? 0,
        ]
        const blankClass = buildPaintColorClass(columnOccupied, localAnchor(columnOccupied, secondSeed))
        const separation = minClassDistance(calClass, blankClass)
        if (separation < CLASS_SEPARATION_MIN) {
          throw refusal(
            `Capture calibration columns: stripe classes (${calClass.anchor.join(",")}) and (${blankClass.anchor.join(",")}) are separated by ${separation} < ${CLASS_SEPARATION_MIN} codes`,
          )
        }
        return [calClass, blankClass]
      }
    }
  }
  throw refusal("Capture calibration columns: distinct stripe colors not witnessed")
}

const findBackgroundPaintClass = (
  before: CapturedFrame,
  grid: CaptureRectangle,
  filletMask: Set<number>,
  witnessClass: PaintColorClass,
): PaintColorClass => {
  const beforeOccupied = unmaskedOccupied(before, grid, filletMask)
  const backgroundPacked = [...beforeOccupied.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0]
  if (backgroundPacked === undefined) throw refusal("Capture calibration before grid: no unmasked pixels")
  const backgroundClass = buildPaintColorClass(beforeOccupied, unpackRgb(backgroundPacked))
  const separation = minClassDistance(backgroundClass, witnessClass)
  if (separation < CLASS_SEPARATION_MIN) {
    throw refusal(
      `Capture calibration solid: background class (${backgroundClass.anchor.join(",")}) and witness class (${witnessClass.anchor.join(",")}) are separated by ${separation} < ${CLASS_SEPARATION_MIN} codes`,
    )
  }
  return backgroundClass
}

/** Same owned run, complete raster edges, exact integer geometry, witnessed identical restore. */
export async function calibrateCaptureOrigin({
  ctx,
  pixelGeometry,
  timeoutMs,
  captureRaw,
  collectorLaunched = false,
  chromeBand,
  screenMode,
  screenModes,
}: {
  ctx: TermProbeSource
  pixelGeometry?: CapturePixelGeometry
  timeoutMs: number
  captureRaw: (label: string, deadline: number) => Promise<CapturedFrame>
  /** Verified collector-owned disposable session: it clears its own rows, and the cursor is restored set either way. */
  collectorLaunched?: boolean
  /** The terminal's declared self-repainting chrome strip or rectangle; absent keeps the whole-window rule. */
  chromeBand?: CaptureChromeBand
  /** Also witness the paint under this screen mode, on the same canvas and lifetime (@cto 34932-reverse-seam-ruling-2325). */
  screenMode?: "reverse"
  /** All non-primary screen modes declared by selected probes in this session (#37701, @cto be5f14e5). */
  screenModes?: readonly CaptureScreenMode[]
}): Promise<
  NamedTextOrigin & {
    pixelGeometry: CapturePixelGeometry
    sentinel: CalibrationSentinel
    paintClasses?: CalibratedPaintClasses
    reverseScreen?: ReverseScreenWitness
    alternateScreens?: Partial<Record<AlternateScreenMode, AlternateScreenWitness>>
  }
> {
  const bandBounds = chromeBand && chromeBandBounds(chromeBand)
  if (![ctx.rows, ctx.cols].every((value) => Number.isSafeInteger(value) && value >= 2)) {
    throw new Error("Capture calibration requires a verified grid of at least 2x2 cells")
  }
  if (pixelGeometry && !Object.values(pixelGeometry).every((value) => Number.isSafeInteger(value) && value > 0)) {
    throw new Error("Capture calibration requires positive integer reported pixel geometry")
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("Capture calibration requires the oracle's positive timeoutMs")
  }
  const capture = async (label: string, deadline: number, stage: StageCaptures) => {
    if (Date.now() >= deadline) {
      throw paintTimeout(`Capture calibration ${label}: paint witness timeout before capture`, stage)
    }
    const started = Date.now()
    const frame = await captureRaw(`collector raster calibration: ${label}`, deadline)
    const late = Date.now() >= deadline
    const record: StageCaptures["captures"][number] = { ms: Date.now() - started, late }
    stage.captures.push(record)
    if (late) {
      // The late frame is still what the window showed; a refusal archives it.
      stage.last = frame
      throw paintTimeout(`Capture calibration ${label}: paint witness timeout after capture`, stage)
    }
    validateFrame(frame)
    stage.last = frame
    return { frame, record }
  }
  const confirmedFrame = async (
    label: string,
    accepts: (frame: CapturedFrame) => boolean,
    changedFrom?: CapturedFrame,
  ) => {
    const deadline = Date.now() + timeoutMs
    const stage: StageCaptures = { captures: [] }
    let previous: CapturedFrame | undefined
    for (;;) {
      if (Date.now() >= deadline) {
        throw paintTimeout(`Capture calibration ${label}: paint witness timeout; no confirmed current frame`, stage)
      }
      const { frame: current, record } = await capture(previous ? `${label} confirmation` : label, deadline, stage)
      const accepted = (!changedFrom || !equal(current, changedFrom)) && accepts(current)
      record.accepted = accepted
      if (accepted && previous && equal(previous, current)) {
        return current
      }
      // A confirmation is also the next candidate. Discarding it misses stable
      // consecutive pairs while consuming the same fixed paint deadline.
      previous = current
      if (Date.now() >= deadline) {
        throw paintTimeout(`Capture calibration ${label}: paint witness timeout; no confirmed current frame`, stage)
      }
    }
  }
  // Column and row edge cells per form: the solid form's own SGR and glyph, alternated with a dark cell.
  const edgePaint: Record<CalibrationSentinelForm, readonly [on: string, off: string]> = {
    basic: ["\x1b[41m ", "\x1b[40m "],
    reverse: ["\x1b[7m ", "\x1b[27m "],
    block: ["\x1b[31;41m\u2588", "\x1b[30;40m\u2588"],
  }
  const paintGrid = (stage: "solid" | "columns" | "rows", form: CalibrationSentinelForm) => {
    let text = ""
    for (let row = 0; row < ctx.rows; row++) {
      text += `\x1b[${row + 1};1H`
      for (let col = 0; col < ctx.cols; col++) {
        const on = stage === "solid" || (stage === "columns" ? col : row) % 2 === 0
        text += stage === "solid" ? CALIBRATION_SOLID_PAINT[form] : edgePaint[form][on ? 0 : 1]
      }
    }
    ctx.write(text)
  }
  /**
   * Paint the solid grid in each sentinel form in turn until one is confirmed as changed from `reference`.
   * The ONE candidate loop: the normal stage and the reverse screen stage both call it (#37240, @cto
   * 29fc67ff), so a form the mode hides (WezTerm's DECSCNM swaps each cell's colours, so a background-only
   * SGR 45 space shows the default foreground) is answered by the next form, never by a copied loop.
   */
  const solidPaintCandidates = async (
    label: (candidate: CalibrationSentinelForm) => string,
    reference: CapturedFrame,
    timedOut: (cause: unknown) => boolean,
  ): Promise<{
    observed?: { frame: CapturedFrame; form: CalibrationSentinelForm }
    attempts: string[]
    lastTimeout?: Error
  }> => {
    const attempts: string[] = []
    let lastTimeout: Error | undefined
    for (const candidate of CALIBRATION_SENTINEL_FORMS) {
      ctx.write("\x1b[0m")
      paintGrid("solid", candidate)
      try {
        const frame = await confirmedFrame(label(candidate), () => true, reference)
        attempts.push(`${candidate}: observed`)
        return { observed: { frame, form: candidate }, attempts }
      } catch (cause) {
        if (!timedOut(cause)) throw cause
        if (cause instanceof Error) lastTimeout = cause
        attempts.push(`${candidate}: not observed`)
      }
    }
    return { attempts, ...(lastTimeout === undefined ? {} : { lastTimeout }) }
  }
  let baseline: CapturedFrame | undefined
  let observedPaint: CapturedFrame | undefined
  let failure: unknown
  // The band excuses nothing until it is proven clear of the witnessed grid; the restore match stays strict before that.
  let bandClearOfGrid = false
  let witnessedGrid:
    | { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
    | undefined
  // Set once DECSCNM is written, so every exit path resets it before the restore is witnessed.
  let reverseSet = false
  // Set while calibrating an alternate screen so every exit path leaves back to primary (#37701).
  let activeAlternateLeave: string | undefined
  const requestedScreenModes = new Set<CaptureScreenMode>([
    ...(screenModes ?? []),
    ...(screenMode !== undefined ? [screenMode] : []),
  ])
  // #37678 (@cto 5dd7b425 + c6b4ce8c): witnessed post-DECSCNM return frame and the outside-grid pixels it settled.
  let reverseReturnSettledFrame: CapturedFrame | undefined
  let reverseReturnNormalSolid: CapturedFrame | undefined
  const inBand = (x: number, y: number) =>
    bandBounds !== undefined &&
    y >= bandBounds.top &&
    y < bandBounds.bottom &&
    x >= bandBounds.left &&
    x < bandBounds.right
  /** Pixels that differ from `reference` inside the band; any difference outside it makes the frames unequal. */
  const bandDifference = (
    frame: CapturedFrame,
    reference: CapturedFrame,
  ): { equalOutside: boolean; changed: number } => {
    validateFrame(frame)
    validateFrame(reference)
    if (frame.width !== reference.width || frame.height !== reference.height) {
      throw new Error("Capture calibration window dimensions changed")
    }
    let changed = 0
    for (let offset = 0; offset < frame.rgba.length; offset += 4) {
      if ([0, 1, 2, 3].every((channel) => frame.rgba[offset + channel] === reference.rgba[offset + channel])) continue
      const pixel = offset / 4
      if (!inBand(pixel % frame.width, Math.floor(pixel / frame.width))) return { equalOutside: false, changed }
      changed++
    }
    return { equalOutside: true, changed }
  }
  const excused: Array<{ stage: string; changed: number }> = []
  let result:
    | (NamedTextOrigin & {
        pixelGeometry: CapturePixelGeometry
        sentinel: CalibrationSentinel
        paintClasses?: CalibratedPaintClasses
        reverseScreen?: ReverseScreenWitness
        alternateScreens?: Partial<Record<AlternateScreenMode, AlternateScreenWitness>>
      })
    | undefined
  const eraseVisibleGrid = collectorLaunched
    ? Array.from({ length: ctx.rows }, (_unused, row) => cursorTo(row, 0) + clearLine()).join("") + cursorHome()
    : "\x1b[2J\x1b[H"
  try {
    // Normalization and every later mutation are inside the same restoration transaction.
    beginCaptureLifecycle(ctx)
    ctx.write(eraseVisibleGrid)
    baseline = await confirmedFrame("before grid paint", () => true)
    const before = baseline
    const normalPaint = await solidPaintCandidates(
      (candidate) => `solid grid paint ${candidate}`,
      baseline,
      (cause) => cause instanceof Error && cause.name === "CapturePaintTimeout",
    )
    const { attempts } = normalPaint
    if (!normalPaint.observed) {
      throw refusal(`Capture calibration paint not observed: ${attempts.join("; ")}`, normalPaint.lastTimeout)
    }
    const solid = normalPaint.observed.frame
    const form = normalPaint.observed.form
    observedPaint = solid
    const { witness, witnessClass } = findSolidWitnessClass(before, solid)
    const [red, green, blue] = witness
    const solidFrame = solid
    const { grid, fillets } = shrinkEdgeBlendPerimeter(
      solidFrame,
      before,
      rectangle(solidFrame, (offset) => inColorClass(solidFrame, offset, witnessClass)),
      witness,
      witnessClass,
    )
    witnessedGrid = grid
    const filletMask = dilateFilletMask(fillets, grid, solidFrame.width)
    const backgroundClass = findBackgroundPaintClass(before, grid, filletMask, witnessClass)
    // The band may not reach the grid or the one-pixel blend line beside it, so no paint the grid owns is excused.
    const overlap = chromeBand && bandBounds && chromeBandOverlap(chromeBand, bandBounds, grid)
    if (overlap) throw refusal(overlap)
    bandClearOfGrid = chromeBand !== undefined
    const outsideUnchanged = (frame: CapturedFrame, stage: string): EdgeBlend[] => {
      validateFrame(frame)
      if (frame.width !== before.width || frame.height !== before.height) {
        throw new Error("Capture calibration window dimensions changed")
      }
      const blends = edgeBlends(grid, before, frame)
      const explained = new Set<number>()
      for (const blend of blends) for (const key of blend.pixels) explained.add(key)
      let changedInBand = 0
      // A refusal names what it saw: the stage, how many pixels moved, and the first few of them
      // with both colours. Without them an archived frame cannot be tied to the refusal, and an
      // intermittent capture costs a full investigation on every occurrence (#37667).
      let offending = 0
      const firstOffending: string[] = []
      // The bounding box and the distinct after-colours separate a line, a band and scattered noise,
      // which six samples in raster order cannot (#37667 review d0efc86e).
      let minX = Number.POSITIVE_INFINITY
      let minY = Number.POSITIVE_INFINITY
      let maxX = -1
      let maxY = -1
      const afterColours = new Set<string>()
      for (let y = 0; y < frame.height; y++) {
        for (let x = 0; x < frame.width; x++) {
          if (x >= grid.x && x < grid.x + grid.width && y >= grid.y && y < grid.y + grid.height) continue
          const offset = (y * frame.width + x) * 4
          if (inBand(x, y)) {
            if ([0, 1, 2, 3].some((channel) => frame.rgba[offset + channel] !== before.rgba[offset + channel])) {
              changedInBand++
            }
            continue
          }
          // The blend model covers colour only: it says nothing about the alpha byte, which stays
          // exactly as the baseline frame had it even on an explained pixel.
          const blendExplained = explained.has(y * frame.width + x)
          for (let channel = blendExplained ? 3 : 0; channel < 4; channel++) {
            if (frame.rgba[offset + channel] !== before.rgba[offset + channel]) {
              offending++
              if (x < minX) minX = x
              if (y < minY) minY = y
              if (x > maxX) maxX = x
              if (y > maxY) maxY = y
              afterColours.add(
                `${frame.rgba[offset]},${frame.rgba[offset + 1]},${frame.rgba[offset + 2]}@${frame.rgba[offset + 3]}`,
              )
              if (firstOffending.length < FIRST_OFFENDING_PIXELS) {
                const rgba = (source: CapturedFrame) =>
                  `${source.rgba[offset]},${source.rgba[offset + 1]},${source.rgba[offset + 2]}@${source.rgba[offset + 3]}`
                // An explained pixel's colour is the blend's own excuse, so only its alpha is a defect.
                const label = blendExplained ? " alpha (blend-explained)" : channel === 3 ? " alpha" : ""
                firstOffending.push(`(${x},${y}) ${rgba(before)}->${rgba(frame)}${label}`)
              }
              break
            }
          }
        }
      }
      if (offending > 0) {
        throw outsideGridRefusal(
          `stage=${stage}, ${offending} pixel(s) outside grid (${grid.x},${grid.y} ${grid.width}x${grid.height}) ` +
            `of ${frame.width}x${frame.height}, bbox (${minX},${minY})-(${maxX},${maxY}), ` +
            `${afterColours.size} distinct after-colour(s)` +
            (chromeBand ? `, ${changedInBand} band pixel(s) excused` : "") +
            `; first: ${firstOffending.join("; ")}`,
          { before, after: frame, stage },
        )
      }
      if (chromeBand) excused.push({ stage, changed: changedInBand })
      return blends
    }
    const solidBlends = outsideUnchanged(solid, "solid")
    // One axis-generic rule: an axis's leading edge is the grid's own first pixel line only when that
    // line was admitted on the solid frame and on the axis's own frame. Lead is 1 or 0, never a width.
    const leadingLine = (axis: "columns" | "rows", own: readonly EdgeBlend[]): EdgeBlend | null => {
      const edge: Edge = axis === "columns" ? "left" : "top"
      const admitted = solidBlends.some((blend) => blend.edge === edge) && own.some((blend) => blend.edge === edge)
      return admitted ? (own.find((blend) => blend.edge === edge) ?? null) : null
    }
    paintGrid("columns", form)
    // The column paint must be present somewhere in the grid, not at its top-left pixel: a rounded
    // window's corner fillets sit exactly there, so that pixel stays black in every stage.
    const columns = await confirmedFrame("column edge paint", () => true, solid)
    const columnOccupied = unmaskedOccupied(columns, grid, filletMask)
    const columnClasses = findColumnStripeClasses(columns, grid, filletMask, columnOccupied)
    const columnBlends = outsideUnchanged(columns, "columns")
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
      columnClasses,
    )
    paintGrid("rows", form)
    const rows = await confirmedFrame("row edge paint", () => true, columns)
    // Rows inherit the columns' anchors while admitting their own observed dither phases (@cto 34480-fresh-owner-contract-go-2141).
    const rowOccupied = unmaskedOccupied(rows, grid, filletMask)
    const rowClasses: [PaintColorClass, PaintColorClass] = [
      buildPaintColorClass(rowOccupied, columnClasses[0].anchor),
      buildPaintColorClass(rowOccupied, columnClasses[1].anchor),
    ]
    const rowSeparation = minClassDistance(rowClasses[0], rowClasses[1])
    if (rowSeparation < CLASS_SEPARATION_MIN) {
      throw refusal(
        `Capture calibration rows: stripe classes (${rowClasses[0].anchor.join(",")}) and (${rowClasses[1].anchor.join(",")}) are separated by ${rowSeparation} < ${CLASS_SEPARATION_MIN} codes`,
      )
    }
    const rowBlends = outsideUnchanged(rows, "rows")
    const rowLine = leadingLine("rows", rowBlends)
    const rowLead: 0 | 1 = rowLine === null ? 0 : 1
    const { pitch: cellHeight, clip: rowClip } = stripeSize(
      rows,
      baseline,
      grid,
      "rows",
      ctx.rows,
      filletMask,
      rowLead,
      rowClasses,
    )
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
    // #34932 (@cto 34932-reverse-seam-ruling-2325 items 2-3): on this same blank canvas and lifetime, normal -> reverse -> normal.
    // The witness is the paint the sentinel path really uses under the mode, never an inverted RGB, and it is
    // always the witnessed reverse pair (equal to the normal one when the mode leaves that paint unchanged).
    // Paint the mode leaves equal is witnessed too (@cto 34932-equal-paint-amendment-0443, amending item 2): a
    // blank confirmed equal to the normal blank and a freshly painted, confirmed sentinel, both measured under the
    // mode, whose classes match the normal pair. It is never copied, and says nothing about feature support; the
    // probe still decides that. An unconfirmed blank or paint, a sentinel that differs from the normal pair on an
    // equal blank, or an ambiguous witness is a named unavailable outcome; a failed return to the normal paint
    // invalidates the whole calibration.
    let reverseScreen: ReverseScreenWitness | undefined
    let reversePaintEqual = false
    let reverseAttempts: string[] = []
    let reverseTrace = ""
    let reverseSettledTrace = ""
    let lastPaintedFrame: CapturedFrame = rows
    if (requestedScreenModes.has("reverse")) {
      const rowsFrame = lastPaintedFrame
      reverseSet = true
      ctx.write(`\x1b[0m${eraseVisibleGrid}\x1b[?5h`)
      let reverseBlankFrame: CapturedFrame | undefined
      reverseScreen = await (async (): Promise<ReverseScreenWitness> => {
        let reverseBlank: CapturedFrame
        try {
          reverseBlank = await confirmedFrame("reverse screen blank", (frame) => !equal(frame, rowsFrame))
          reverseBlankFrame = reverseBlank
        } catch (cause) {
          if (!reverseStageTimedOut(cause)) throw cause
          return {
            status: "unavailable",
            reason: "reverse screen blank canvas was not confirmed after DECSCNM was set",
          }
        }
        const canvasUnchanged = equal(reverseBlank, before)
        const reversePaint = await solidPaintCandidates(
          (candidate) => `reverse screen solid paint ${candidate}`,
          reverseBlank,
          reverseStageTimedOut,
        )
        reverseAttempts = reversePaint.attempts
        if (!reversePaint.observed) {
          return {
            status: "unavailable",
            reason: `reverse screen sentinel paint (${reversePaint.attempts.join(", ")}) was not observed on the reversed blank canvas`,
          }
        }
        const reverseSolid = reversePaint.observed.frame
        const reverseForm = reversePaint.observed.form
        try {
          const reversed = findSolidWitnessClass(reverseBlank, reverseSolid)
          const painted = reverseSolid
          const shrunk = shrinkEdgeBlendPerimeter(
            painted,
            reverseBlank,
            rectangle(painted, (offset) => inColorClass(painted, offset, reversed.witnessClass)),
            reversed.witness,
            reversed.witnessClass,
          )
          const at = (rectangle: CaptureRectangle) =>
            `${rectangle.width}x${rectangle.height} at ${rectangle.x},${rectangle.y}`
          if (
            shrunk.grid.x !== grid.x ||
            shrunk.grid.y !== grid.y ||
            shrunk.grid.width !== grid.width ||
            shrunk.grid.height !== grid.height
          ) {
            return {
              status: "unavailable",
              reason: `reverse screen sentinel paint covers ${at(shrunk.grid)}, not the normal grid ${at(grid)}`,
            }
          }
          const reverseFillets = dilateFilletMask(shrunk.fillets, shrunk.grid, painted.width)
          // The existing within-pair separation rule; no rule between the normal and the reverse pair.
          const background = findBackgroundPaintClass(reverseBlank, shrunk.grid, reverseFillets, reversed.witnessClass)
          const [r, g, b] = reversed.witness
          if (canvasUnchanged) {
            const sameClass = (left: PaintColorClass, right: PaintColorClass) =>
              packRgb(...left.anchor) === packRgb(...right.anchor) &&
              left.members.size === right.members.size &&
              [...left.members].every((member) => right.members.has(member))
            if (!sameClass(background, backgroundClass) || !sameClass(reversed.witnessClass, witnessClass)) {
              return {
                status: "unavailable",
                reason:
                  "reverse screen blank stayed equal to the normal blank, but its measured sentinel paint classes differ from the normal pair",
              }
            }
            reversePaintEqual = true
          }
          reverseTrace = `; reverse screen sentinel ${reverseForm} (${reverseAttempts.join(", ")}) rgb ${r},${g},${b} on reversed canvas ${background.anchor.join(",")}`
          return {
            status: "witnessed",
            sentinel: { form: reverseForm, rgb: [r, g, b] },
            paintClasses: {
              background: { anchor: background.anchor, members: background.members },
              sentinel: { anchor: reversed.witnessClass.anchor, members: reversed.witnessClass.members },
            },
          }
        } catch (cause) {
          if (!(cause instanceof Error) || cause.name !== "CaptureCalibrationRefused") throw cause
          return { status: "unavailable", reason: `reverse screen witness ambiguous: ${cause.message}` }
        }
      })()
      // Item 3: reset the mode and prove the NORMAL sentinel paint returns before anything installs.
      ctx.write(`\x1b[0m${eraseVisibleGrid}\x1b[?5l`)
      paintGrid("solid", form)
      const normalSolid = solidFrame
      // #37678 (@cto 5dd7b425 + c6b4ce8c): an outside-grid pixel DECSCNM itself painted may settle into
      // backgroundClass (matching premultiplied channels when 0 < alpha < 255 with alpha unchanged); all
      // grid pixels and all non-DECSCNM outside pixels remain byte-exact against normalSolid.
      const isReverseSettledPixel = (
        frame: CapturedFrame,
        reverseBlank: CapturedFrame,
        x: number,
        y: number,
        offset: number,
      ): boolean => {
        if (x >= grid.x && x < grid.x + grid.width && y >= grid.y && y < grid.y + grid.height) return false
        const paintedByReverse = [0, 1, 2, 3].some(
          (channel) => reverseBlank.rgba[offset + channel] !== before.rgba[offset + channel],
        )
        if (!paintedByReverse) return false
        if (frame.rgba[offset + 3] !== normalSolid.rgba[offset + 3]) return false
        return inColorClass(frame, offset, backgroundClass, { premultiplied: true })
      }
      const reverseReturnMatch = (
        frame: CapturedFrame,
        reverseBlank: CapturedFrame,
      ): { accepted: boolean; settled: number; semiTransparent: number } => {
        validateFrame(frame)
        if (frame.width !== normalSolid.width || frame.height !== normalSolid.height) {
          throw new Error("Capture calibration window dimensions changed")
        }
        let settled = 0
        let semiTransparent = 0
        for (let y = 0; y < frame.height; y++) {
          for (let x = 0; x < frame.width; x++) {
            const offset = (y * frame.width + x) * 4
            if ([0, 1, 2, 3].every((channel) => frame.rgba[offset + channel] === normalSolid.rgba[offset + channel])) {
              continue
            }
            if (!isReverseSettledPixel(frame, reverseBlank, x, y, offset)) {
              return { accepted: false, settled, semiTransparent }
            }
            settled++
            if ((frame.rgba[offset + 3] ?? 255) < 255) semiTransparent++
          }
        }
        return { accepted: true, settled, semiTransparent }
      }
      try {
        const reverseBlank = reverseBlankFrame
        const returned = await confirmedFrame("reverse screen return", (frame) =>
          bandClearOfGrid
            ? bandDifference(frame, normalSolid).equalOutside
            : reverseBlank !== undefined
              ? reverseReturnMatch(frame, reverseBlank).accepted
              : equal(frame, normalSolid),
        )
        if (!bandClearOfGrid && reverseBlank !== undefined) {
          const { settled, semiTransparent } = reverseReturnMatch(returned, reverseBlank)
          if (settled > 0) {
            reverseReturnSettledFrame = returned
            reverseReturnNormalSolid = normalSolid
            reverseSettledTrace =
              `; reverse return ${settled} px settled to background class` +
              (semiTransparent > 0 ? ` (${semiTransparent} semi-transparent)` : "")
          }
        }
      } catch (cause) {
        if (!(cause instanceof Error) || cause.name !== "CapturePaintTimeout") throw cause
        // #37678: name what each capture did and archive the last frame against the paint it waited for, so a
        // slow capture and a paint that never came back read differently from the run alone.
        const { captures = [], last } = (cause as Error & { stage?: StageCaptures }).stage ?? {}
        const each = captures
          .map(
            ({ ms, late, accepted }, index) =>
              `#${index + 1} ${ms} ms ${late ? "ended after the deadline" : accepted ? "accepted" : "not accepted"}`,
          )
          .join("; ")
        const reverseBlank = reverseBlankFrame
        const excused =
          !bandClearOfGrid && reverseBlank !== undefined && last
            ? (x: number, y: number, offset: number) => isReverseSettledPixel(last, reverseBlank, x, y, offset)
            : undefined
        throw Object.assign(
          refusal(
            "Capture calibration reverse screen: the normal sentinel paint did not return after DECSCNM was reset, so this calibration is invalid",
            cause,
          ),
          {
            detail:
              `stage=reverse screen return, ${captures.length} capture(s) in ${timeoutMs} ms: ${each}` +
              (last ? `; last frame ${frameDifference(normalSolid, last, excused)}` : "; no frame captured"),
            ...(last && { frames: { before: normalSolid, after: last, stage: "reverse screen return" } }),
          },
        )
      }
      lastPaintedFrame = reverseReturnSettledFrame ?? normalSolid
    }
    // #37701 (@cto be5f14e5): live in-session alternate-screen origin/paint calibration.
    // Never cached across runs; any pitch/grid/witness failure leaves the mode unavailable so the
    // alt-screen rows stay probe-todo naming "alternate screen not calibrated: <reason>".
    const alternateScreens: Partial<Record<AlternateScreenMode, AlternateScreenWitness>> = {}
    let alternateTrace = ""
    for (const altMode of ["alternate-1049", "alternate-47"] as const) {
      if (!requestedScreenModes.has(altMode)) continue
      const enterSeq = altMode === "alternate-1049" ? "\x1b[?1049h" : "\x1b[?47h"
      const leaveSeq = altMode === "alternate-1049" ? "\x1b[?1049l" : "\x1b[?47l"
      const previousFrame = lastPaintedFrame
      activeAlternateLeave = leaveSeq
      ctx.write(`${enterSeq}\x1b[0m${eraseVisibleGrid}`)
      const witness = await (async (): Promise<AlternateScreenWitness> => {
        let altBlank: CapturedFrame
        try {
          altBlank = await confirmedFrame(`${altMode} screen blank`, (frame) => !equal(frame, previousFrame))
        } catch (cause) {
          if (!reverseStageTimedOut(cause)) throw cause
          return {
            status: "unavailable",
            reason: `${altMode} blank canvas was not confirmed after entering alternate screen`,
          }
        }
        const altPaint = await solidPaintCandidates(
          (candidate) => `${altMode} screen solid paint ${candidate}`,
          altBlank,
          reverseStageTimedOut,
        )
        if (!altPaint.observed) {
          return {
            status: "unavailable",
            reason: `${altMode} sentinel paint (${altPaint.attempts.join(", ")}) was not observed on the alternate canvas`,
          }
        }
        const altSolid = altPaint.observed.frame
        const altForm = altPaint.observed.form
        try {
          const altMeasured = findSolidWitnessClass(altBlank, altSolid)
          const altShrunk = shrinkEdgeBlendPerimeter(
            altSolid,
            altBlank,
            rectangle(altSolid, (offset) => inColorClass(altSolid, offset, altMeasured.witnessClass)),
            altMeasured.witness,
            altMeasured.witnessClass,
          )
          const at = (rect: CaptureRectangle) => `${rect.width}x${rect.height} at ${rect.x},${rect.y}`
          if (altShrunk.grid.width !== grid.width || altShrunk.grid.height !== grid.height) {
            return {
              status: "unavailable",
              reason: `${altMode} grid ${at(altShrunk.grid)} differs from primary grid ${at(grid)}`,
            }
          }
          const altOrigin = { x: altShrunk.grid.x - columnLead, y: altShrunk.grid.y - rowLead }
          if (altOrigin.x < 0 || altOrigin.y < 0) {
            return {
              status: "unavailable",
              reason: `${altMode} origin ${altOrigin.x},${altOrigin.y} lies outside the captured image`,
            }
          }
          const altFillets = dilateFilletMask(altShrunk.fillets, altShrunk.grid, altSolid.width)
          const altBackground = findBackgroundPaintClass(
            altBlank,
            altShrunk.grid,
            altFillets,
            altMeasured.witnessClass,
          )
          const [altR, altG, altB] = altMeasured.witness
          alternateTrace += `; ${altMode} origin ${altOrigin.x},${altOrigin.y} sentinel ${altForm} rgb ${altR},${altG},${altB}`
          return {
            status: "witnessed",
            origin: altOrigin,
            pixelGeometry: measured,
            sentinel: { form: altForm, rgb: [altR, altG, altB] },
            paintClasses: {
              background: { anchor: altBackground.anchor, members: altBackground.members },
              sentinel: { anchor: altMeasured.witnessClass.anchor, members: altMeasured.witnessClass.members },
            },
          }
        } catch (cause) {
          if (!(cause instanceof Error) || cause.name !== "CaptureCalibrationRefused") throw cause
          return { status: "unavailable", reason: `${altMode} witness ambiguous: ${cause.message}` }
        }
      })()
      alternateScreens[altMode] = witness
      ctx.write(`\x1b[0m${eraseVisibleGrid}${leaveSeq}`)
      activeAlternateLeave = undefined
      paintGrid("solid", form)
      const normalSolid = reverseReturnSettledFrame ?? solidFrame
      try {
        await confirmedFrame(`${altMode} screen return`, (frame) =>
          bandClearOfGrid ? bandDifference(frame, normalSolid).equalOutside : equal(frame, normalSolid),
        )
      } catch (cause) {
        if (!(cause instanceof Error) || cause.name !== "CapturePaintTimeout") throw cause
        const { captures = [], last } = (cause as Error & { stage?: StageCaptures }).stage ?? {}
        const each = captures
          .map(
            ({ ms, late, accepted }, index) =>
              `#${index + 1} ${ms} ms ${late ? "ended after the deadline" : accepted ? "accepted" : "not accepted"}`,
          )
          .join("; ")
        throw Object.assign(
          refusal(
            `Capture calibration ${altMode}: the normal sentinel paint did not return after leaving alternate screen, so this calibration is invalid`,
            cause,
          ),
          {
            detail:
              `stage=${altMode} screen return, ${captures.length} capture(s) in ${timeoutMs} ms: ${each}` +
              (last ? `; last frame ${frameDifference(normalSolid, last)}` : "; no frame captured"),
            ...(last && { frames: { before: normalSolid, after: last, stage: `${altMode} screen return` } }),
          },
        )
      }
      lastPaintedFrame = normalSolid
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
    const classTrace = `; paint classes R<=${CLASS_RADIUS_MAX} G>=${CLASS_SEPARATION_MIN} (solid ${witnessClass.members.size}, columns ${columnClasses[0].members.size}/${columnClasses[1].members.size}, rows ${rowClasses[0].members.size}/${rowClasses[1].members.size} occupied triples)`
    const restoreTrace = chromeBand ? "restore identical outside the declared chrome band" : "identical restore"
    // Last, so the restore stage's own excused count (added after the restore is confirmed) reads in sequence.
    const bandTrace = chromeBand
      ? `; declared chrome band ${chromeBandExtent(chromeBand)} (${chromeBand.reason}), changed px excused: ${excused.map(({ stage, changed }) => `${stage} ${changed} px`).join(", ")}`
      : ""
    result = {
      origin: { x: authored.x, y: authored.y },
      // 33982: the settled name of this measurement, beside the prose below. A frame whose origin
      // came from calibration and one whose origin came from a located sentinel are different
      // measurements; comparing them as one would count one measurement twice.
      basisKind: "calibration witnessed raster",
      pixelGeometry: measured,
      sentinel: { form, rgb: [red, green, blue] },
      paintClasses: {
        background: { anchor: backgroundClass.anchor, members: backgroundClass.members },
        sentinel: { anchor: witnessClass.anchor, members: witnessClass.members },
      },
      ...(reverseScreen === undefined ? {} : { reverseScreen }),
      ...(Object.keys(alternateScreens).length === 0 ? {} : { alternateScreens }),
      ...(columnClip > 0 || rowClip > 0 ? { visible: { width: authored.width, height: authored.height } } : {}),
      basis: `collector complete witnessed raster: ${ctx.cols} columns x ${ctx.rows} rows, every unmasked scanline measures ${cellWidth}x${cellHeight}, visible ${authored.width}x${authored.height} grid at ${authored.x},${authored.y}${filletTrace}${blendTrace}${leadTrace}${clipTrace}; paint ${form} (${attempts.join(", ")})${classTrace}${reverseTrace}${reverseSettledTrace}${reversePaintEqual ? "; reverse screen paint measured under DECSCNM stayed equal to the normal pair" : ""}${alternateTrace}; current paints and ${restoreTrace} confirmed${collectorLaunched ? "; owned disposable session cursor explicitly set before calibration and restored set" : ""}${bandTrace}`,
    }
    return result
  } catch (cause) {
    failure = cause
    throw cause
  } finally {
    try {
      let surfaceFailure: unknown
      try {
        ctx.write(`\x1b[0m${activeAlternateLeave ?? ""}${reverseSet ? "\x1b[?5l" : ""}${eraseVisibleGrid}`)
        if (!baseline) {
          throw new Error(
            failure === undefined
              ? "Starting blank was never confirmed; restoration cannot be proven"
              : `Secondary restoration unverified after ${failure instanceof Error ? failure.name : String(failure)}: no confirmed baseline image; the original error remains primary`,
          )
        }
        const before = baseline
        const gridBox =
          failure instanceof Error && (failure as Partial<CaptureCalibrationRefusal>).code === "paint-outside-grid"
            ? witnessedGrid
            : undefined
        const settledAfterReverse = (frame: CapturedFrame, returned: CapturedFrame, normal: CapturedFrame): boolean => {
          validateFrame(frame)
          if (frame.width !== before.width || frame.height !== before.height) {
            throw new Error("Capture calibration window dimensions changed")
          }
          for (let offset = 0; offset < frame.rgba.length; offset += 4) {
            const settled = [0, 1, 2, 3].some(
              (channel) => returned.rgba[offset + channel] !== normal.rgba[offset + channel],
            )
            const expected = settled ? returned : before
            if ([0, 1, 2, 3].some((channel) => frame.rgba[offset + channel] !== expected.rgba[offset + channel])) {
              return false
            }
          }
          return true
        }
        const settledReturn = reverseReturnSettledFrame
        const settledNormal = reverseReturnNormalSolid
        const restored = await confirmedFrame(
          "restore grid paint",
          (frame) =>
            gridBox !== undefined
              ? equalInside(frame, before, gridBox)
              : bandClearOfGrid
                ? bandDifference(frame, before).equalOutside
                : settledReturn !== undefined && settledNormal !== undefined
                  ? settledAfterReverse(frame, settledReturn, settledNormal)
                  : equal(frame, before),
          observedPaint,
        )
        if (bandClearOfGrid && result) {
          // The returned record is this object: the restore's own excused count joins it before the caller reads it.
          result.basis += `; restore ${bandDifference(restored, before).changed} px`
        }
      } catch (cause) {
        surfaceFailure = cause
      }
      try {
        // DECTCEM stays the shared lifecycle's promise — set, for every arm — and this is its one write. The
        // shared close (`endCaptureLifecycle`) is not used here because it ends with a screen clear, and this
        // function's contract is that the screen it returns is the one it witnessed restored.
        ctx.write("\x1b[?25h")
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
      const original = failure instanceof Error ? `${failure.name}: ${failure.message}` : String(failure)
      const restoration = cause instanceof Error ? cause.message : String(cause)
      const error = new AggregateError(
        failure === undefined ? [cause] : [failure, cause],
        failure === undefined
          ? `Capture calibration restore failed: ${restoration}`
          : `${original}; secondary capture restoration failure: ${restoration}`,
        { cause: failure ?? cause },
      )
      error.name = "CaptureRestoreFailed"
      throw error
    }
  }
}
