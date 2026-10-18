import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { CaptureRectangle } from "@terminfo/probe-defs"
import type { ProbeCapture } from "./probes/unified.ts"

export function command(
  file: string,
  args: string[],
  input?: Buffer,
  deadline?: number,
  onStderr?: (stderr: Buffer) => void,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let timeout = 10_000
    if (deadline !== undefined) {
      if (!Number.isFinite(deadline)) {
        reject(new Error(`Capture command ${file} requires a finite deadline`))
        return
      }
      const remaining = deadline - Date.now()
      if (remaining <= 0) {
        reject(new Error(`Capture command ${file} deadline expired before invocation`))
        return
      }
      timeout = Math.min(timeout, Math.ceil(remaining))
    }
    let stdinError: Error | undefined
    const child = execFile(
      file,
      args,
      {
        encoding: "buffer",
        timeout,
        maxBuffer: 32 * 1024 * 1024,
        ...(deadline !== undefined ? { killSignal: "SIGKILL" as const } : {}),
      },
      (error, stdout, stderr) => {
        try {
          onStderr?.(Buffer.isBuffer(stderr) ? stderr : Buffer.from(stderr))
        } catch (observerError) {
          reject(observerError)
          return
        }
        if (error) reject(error)
        else if (stdinError) reject(stdinError)
        else resolve(Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout))
      },
    )
    if (!child.stdin) {
      if (input) reject(new Error(`Capture command ${file} has no stdin for ${input.length} input bytes`))
      return
    }
    child.stdin.on("error", (error: Error) => {
      stdinError = error
    })
    child.stdin.end(input)
  })
}

function digest(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex")
}

/** Retain content-addressed bytes and return their `sha256:` ref. An identical repeat is the same
 * artifact, not an error; different bytes behind the same digest is named rather than overwritten. */
export function retain(directory: string, bytes: Buffer, extension: string): string {
  const hash = digest(bytes)
  const path = join(directory, `${hash}.${extension}`)
  try {
    writeFileSync(path, bytes, { flag: "wx", mode: 0o600 })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
    if (!readFileSync(path).equals(bytes)) throw new Error(`Capture artifact digest collision at ${path}`)
  }
  return `sha256:${hash}`
}

/** One captured frame's raw pixels, exactly the bytes the collector digests. */
export interface CapturedFrame {
  width: number
  height: number
  rgba: Uint8Array
}

/** The terminal's own surface in one captured frame, or the named reason it could not be measured. */
export interface SurfaceMeasurement {
  surface: CaptureRectangle | null
  basis: string
}

/** Where the terminal's own text area sits in the captured window, and on what basis. */
export interface TextAreaPlacement {
  /** The text area's top-left corner, in the captured window's own pixels. */
  origin: { x: number; y: number }
  /** The surface the text area was placed inside. */
  surface: CaptureRectangle
  /** What that surface is and why, verbatim, for the capture trace: never a silent placement. */
  basis: string
}

/**
 * Place the terminal's reported text area inside the terminal's OWN surface, centred within it the
 * way the reported size is centred within the window today. The window is the wrong box whenever the
 * client area carries its own title bar, and the measured surface is the right one; a frame with no
 * measurable surface, or one too small to hold the reported text area, falls back to the whole
 * window — the previous behaviour — and names that fallback in `basis`.
 */
export function textAreaOrigin(input: {
  frame: { width: number; height: number }
  measurement: SurfaceMeasurement
  pixelGeometry: { textWidth: number; textHeight: number }
}): TextAreaPlacement {
  const { frame, pixelGeometry, measurement } = input
  if (
    !Number.isSafeInteger(pixelGeometry.textWidth) ||
    !Number.isSafeInteger(pixelGeometry.textHeight) ||
    pixelGeometry.textWidth < 1 ||
    pixelGeometry.textHeight < 1
  ) {
    throw new Error(`A text area of ${pixelGeometry.textWidth}x${pixelGeometry.textHeight} pixels is not a text area`)
  }
  const measured = measurement.surface
  const whole = { x: 0, y: 0, width: frame.width, height: frame.height }
  const holds = (rectangle: CaptureRectangle) =>
    pixelGeometry.textWidth <= rectangle.width && pixelGeometry.textHeight <= rectangle.height
  const surface = measured !== null && holds(measured) ? measured : whole
  const basis =
    measured === null
      ? `${measurement.basis}; placing the text area in the whole ${frame.width}x${frame.height} frame`
      : surface === measured
        ? `${measurement.basis}; centring the reported ${pixelGeometry.textWidth}x${pixelGeometry.textHeight} text area in it`
        : `${measurement.basis}, smaller than the reported ${pixelGeometry.textWidth}x${pixelGeometry.textHeight} text area; placing the text area in the whole ${frame.width}x${frame.height} frame`
  return {
    origin: {
      x: surface.x + Math.round((surface.width - pixelGeometry.textWidth) / 2),
      y: surface.y + Math.round((surface.height - pixelGeometry.textHeight) / 2),
    },
    surface,
    basis,
  }
}

/**
 * Map a cell-aligned region to an absolute rectangle from the terminal's OWN pixel report and the
 * text area's own measured origin (see textAreaOrigin), and from nothing else: a window width
 * divided by a column count is a guess, and this rectangle decides pixels. A rectangle that leaves
 * the window is a loud error, not a clipped crop, because a clipped crop would silently compare the
 * wrong cells. The one exception is a measured text area whose window cuts its last row or column:
 * `visible` carries the pixels that exist, so the region keeps them instead of the padding beyond.
 */
export function cellRectangle(input: {
  cells: { top: number; left: number; bottom: number; right: number }
  pixelGeometry: { cellWidth: number; cellHeight: number; textWidth: number; textHeight: number }
  textOrigin: { x: number; y: number }
  windowWidth: number
  windowHeight: number
  /** The measured pixels of the text area, when a window edge clips its last row or column. */
  visible?: { width: number; height: number }
}): CaptureRectangle {
  const { cells, pixelGeometry: geometry, textOrigin, windowWidth, windowHeight, visible } = input
  const numbers = [
    cells.top,
    cells.left,
    cells.bottom,
    cells.right,
    geometry.cellWidth,
    geometry.cellHeight,
    textOrigin.x,
    textOrigin.y,
    windowWidth,
    windowHeight,
  ]
  if (numbers.some((value) => !Number.isSafeInteger(value))) {
    throw new Error(`Capture cells-to-pixels mapping needs integers; got ${JSON.stringify(numbers)}`)
  }
  if (
    cells.top < 1 ||
    cells.left < 1 ||
    cells.bottom < cells.top ||
    cells.right < cells.left ||
    geometry.cellWidth < 1 ||
    geometry.cellHeight < 1
  ) {
    throw new Error(`Capture cells-to-pixels mapping got an empty or negative region ${JSON.stringify(input)}`)
  }
  const rectangle: CaptureRectangle = {
    x: textOrigin.x + (cells.left - 1) * geometry.cellWidth,
    y: textOrigin.y + (cells.top - 1) * geometry.cellHeight,
    width: (cells.right - cells.left + 1) * geometry.cellWidth,
    height: (cells.bottom - cells.top + 1) * geometry.cellHeight,
  }
  if (visible) {
    if (![visible.width, visible.height].every((value) => Number.isSafeInteger(value) && value >= 1)) {
      throw new Error(`Capture clipping needs integer visible pixels; got ${JSON.stringify(visible)}`)
    }
    const columns = geometry.textWidth / geometry.cellWidth
    const rows = geometry.textHeight / geometry.cellHeight
    if (!Number.isSafeInteger(columns) || !Number.isSafeInteger(rows) || cells.right > columns || cells.bottom > rows) {
      throw new Error(
        `Capture cells ${JSON.stringify(cells)} leave the ${columns}x${rows} text area at a ${geometry.cellWidth}x${geometry.cellHeight} pitch`,
      )
    }
    const right = textOrigin.x + visible.width
    const bottom = textOrigin.y + visible.height
    if (rectangle.x >= right || rectangle.y >= bottom) {
      throw new Error(
        `Capture rectangle ${JSON.stringify(rectangle)} starts beyond the ${visible.width}x${visible.height} visible text area`,
      )
    }
    rectangle.width = Math.min(rectangle.width, right - rectangle.x)
    rectangle.height = Math.min(rectangle.height, bottom - rectangle.y)
  }
  if (
    rectangle.x < 0 ||
    rectangle.y < 0 ||
    rectangle.x + rectangle.width > windowWidth ||
    rectangle.y + rectangle.height > windowHeight
  ) {
    throw new Error(
      `Capture rectangle ${JSON.stringify(rectangle)} leaves the measured ${windowWidth}x${windowHeight} window for cells ${JSON.stringify(cells)}`,
    )
  }
  return rectangle
}

/** The captured image's pixel size, parsed from `magick xwd:- -format '%wx%h' info:`. */
export function capturePixels(identify: string): { width: number; height: number } {
  const match = /^(\d+)x(\d+)\s*$/.exec(identify)
  const parsed = { width: Number(match?.[1]), height: Number(match?.[2]) }
  if (
    !Number.isSafeInteger(parsed.width) ||
    !Number.isSafeInteger(parsed.height) ||
    parsed.width < 1 ||
    parsed.height < 1
  ) {
    throw new Error(`Cannot read the captured image's pixel size out of ${JSON.stringify(identify)}`)
  }
  return parsed
}

export interface CaptureSource {
  bytes: Buffer
  format: "xwd" | "png"
  width: number
  height: number
  capturedAt: number
}
export interface NamedTextOrigin {
  origin: { x: number; y: number }
  basis: string
  surface?: CaptureRectangle
  /** The measured text-area pixels when a window edge clips the last row or column. */
  visible?: { width: number; height: number }
}
type Checkpoint = Parameters<ProbeCapture>[0]
type OriginResolver = (input: {
  frame: CapturedFrame
  pixelGeometry: NonNullable<Checkpoint["pixelGeometry"]>
}) => NamedTextOrigin | Promise<NamedTextOrigin>

/** The one magick depth-8 decode shared by adapters and collector calibration. */
export async function decodeCapture({
  source,
  featureId,
  deadline,
}: {
  source: CaptureSource
  featureId: string
  deadline?: number
}): Promise<CapturedFrame> {
  const { width, height, bytes, format } = source
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) {
    throw new Error(`Invalid captured frame extent ${width}x${height}`)
  }
  const rgba = await command("magick", [`${format}:-`, "-depth", "8", "rgba:-"], bytes, deadline)
  const expected = width * height * 4
  if (rgba.length !== expected) {
    const captured = capturePixels(
      (await command("magick", [`${format}:-`, "-format", "%wx%h", "info:"], bytes, deadline)).toString(),
    )
    if (captured.width !== width || captured.height !== height) {
      throw new Error(
        `capture ${captured.width}x${captured.height} differs from window ${width}x${height} (border included?)`,
      )
    }
    throw new Error(
      `Raw capture for ${featureId} is ${rgba.length} bytes; ${width}x${height} at depth 8 rgba is ${expected}`,
    )
  }
  return { width, height, rgba }
}

/** Finish one acquired frame; currency and capture scheduling belong to the caller. */
export async function finishCapture(input: {
  directory: string
  checkpoint: Checkpoint
  source: CaptureSource
  png: Buffer
  origin: NamedTextOrigin | OriginResolver
  trace: Record<string, unknown>
}): Promise<Awaited<ReturnType<ProbeCapture>>> {
  const { directory, checkpoint, source, png, origin, trace } = input
  const { featureId, role, label, cells, pixelGeometry } = checkpoint
  const { width, height, format, bytes: original, capturedAt } = source
  if (!png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    throw new Error(`Capture conversion did not produce PNG bytes for ${featureId}`)
  }
  const sourceRef = retain(directory, original, format)
  const ref = retain(directory, png, "png")
  const sourceStem = sourceRef.replace(/^sha256:/, "")
  const pngStem = ref.replace(/^sha256:/, "")
  let pixelsDigest: string | undefined
  let regionDigest: string | undefined
  let regionRectangle: CaptureRectangle | undefined
  let regionTrace: Record<string, unknown> = {}
  if (cells !== undefined || pixelGeometry !== undefined) {
    if (cells === undefined || pixelGeometry === undefined) {
      throw new Error(
        `Capture ${featureId} was asked for a cell-aligned digest without both cells and the terminal's pixel report`,
      )
    }
    const frame = await decodeCapture({ source, featureId })
    pixelsDigest = `sha256:${digest(Buffer.from(frame.rgba.buffer, frame.rgba.byteOffset, frame.rgba.byteLength))}`
    const placement = typeof origin === "function" ? await origin({ frame, pixelGeometry }) : origin
    if (!placement || typeof placement.basis !== "string" || placement.basis.trim().length === 0 || !placement.origin) {
      throw new Error(`Capture ${featureId} lacks a named text-area origin`)
    }
    const rectangle = cellRectangle({
      cells,
      pixelGeometry,
      textOrigin: placement.origin,
      windowWidth: width,
      windowHeight: height,
      ...(placement.visible ? { visible: placement.visible } : {}),
    })
    const rawCommand = [`${format}:-`, "-depth", "8", "rgba:-"]
    const cropCommand = [
      `${format}:-`,
      "-crop",
      `${rectangle.width}x${rectangle.height}+${rectangle.x}+${rectangle.y}`,
      "+repage",
      "-depth",
      "8",
      "rgba:-",
    ]
    const cropped = await command("magick", cropCommand, original)
    const cropExpected = rectangle.width * rectangle.height * 4
    if (cropped.length !== cropExpected) {
      throw new Error(
        `Cropped capture for ${featureId} is ${cropped.length} bytes; ${JSON.stringify(rectangle)} at depth 8 rgba is ${cropExpected}`,
      )
    }
    regionDigest = `sha256:${digest(cropped)}`
    regionRectangle = rectangle
    regionTrace = {
      cells,
      pixelGeometry,
      textArea: {
        origin: placement.origin,
        ...(placement.surface ? { surface: placement.surface } : {}),
        ...(placement.visible ? { visible: placement.visible } : {}),
        basis: placement.basis,
      },
      rectangle,
      rawCommand: ["magick", ...rawCommand],
      cropCommand: ["magick", ...cropCommand],
      retained: { png: `${pngStem}.png`, [format]: `${sourceStem}.${format}` },
      reproduceWhole: `magick ${pngStem}.png -depth 8 rgba:- | sha256sum`,
      reproduceRegion: `magick ${pngStem}.png -crop ${rectangle.width}x${rectangle.height}+${rectangle.x}+${rectangle.y} +repage -depth 8 rgba:- | sha256sum`,
    }
  }
  return {
    frame: {
      kind: "pixels",
      role,
      label,
      capturedAt,
      ref,
      sourceRef,
      ...(regionDigest !== undefined && pixelsDigest !== undefined ? { regionDigest, pixelsDigest } : {}),
      ...(regionRectangle !== undefined ? { regionRectangle } : {}),
    },
    trace: { ...trace, ...regionTrace },
  }
}
