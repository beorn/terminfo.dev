import { spawn } from "node:child_process"
import { createHash, randomBytes } from "node:crypto"
import {
  closeSync,
  type Stats,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path"
import { constants as zlibConstants, gunzipSync, zstdCompressSync, zstdDecompressSync } from "node:zlib"
import type {
  CaptureLayoutGuard,
  CaptureLocated,
  CaptureRectangle,
  CaptureRenderingAxes,
  PixelCellCrop,
} from "@terminfo/probe-defs"
import type { ProbeCapture } from "./probes/unified.ts"

/**
 * What a capture step is, named into the failure when this collector's own deadline kills it (#34892).
 * A bare SIGKILL cannot tell a wedged app from our own too-small budget; the step and its budget can.
 */
export interface CaptureCommandStep {
  readonly step: string
  /** The budget the caller gave the step in ms. The enforced timeout may be shorter than this. */
  readonly budgetMs?: number
}

/**
 * Name of the error a capture command raises when this collector's own deadline ends it: refused before
 * spawning because the deadline had already passed, or killed when it arrived (#35058). A caller whose
 * stage deadline it was can read it as that stage running out of time.
 */
export const CAPTURE_COMMAND_DEADLINE = "CaptureCommandDeadline"

function commandDeadlineError(message: string): Error {
  const error = new Error(message)
  error.name = CAPTURE_COMMAND_DEADLINE
  return error
}

export function command(
  file: string,
  args: string[],
  input?: Buffer,
  deadline?: number,
  onStderr?: (stderr: Buffer) => void,
  environment?: Readonly<Record<string, string>>,
  step?: CaptureCommandStep,
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
        reject(commandDeadlineError(`Capture command ${file} deadline expired before invocation`))
        return
      }
      timeout = Math.min(timeout, Math.ceil(remaining))
    }
    let stdinError: Error | undefined
    let failure: Error | undefined
    let killed = false
    // Which of the two killers ended it: our own timer, or the stdio overflow below. Only the timer
    // means the budget was too small for the step, and only that message may name a deadline (#34892).
    let killedByDeadline = false
    const maxBuffer = 32 * 1024 * 1024
    const chunks: Record<"stdout" | "stderr", Buffer[]> = { stdout: [], stderr: [] }
    const sizes = { stdout: 0, stderr: 0 }
    const killSignal = deadline === undefined ? "SIGTERM" : "SIGKILL"
    const child = spawn(file, args, {
      detached: process.platform !== "win32",
      stdio: "pipe",
      // An explicit environment is the caller's whole environment, never merged with ours: a control run
      // as another process must not inherit the collector's variables (#33333).
      ...(environment === undefined ? {} : { env: { ...environment } }),
    })
    const terminate = (byDeadline: boolean) => {
      if (killed || child.pid === undefined) return
      try {
        if (process.platform === "win32") child.kill(killSignal)
        else process.kill(-child.pid, killSignal)
        killed = true
        killedByDeadline = byDeadline
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") failure ??= error as Error
      }
    }
    const timer = setTimeout(() => terminate(true), timeout)
    const collect = (stream: "stdout" | "stderr", chunk: Buffer) => {
      if (failure !== undefined) return
      const remaining = maxBuffer - sizes[stream]
      const retained = chunk.subarray(0, remaining)
      chunks[stream].push(retained)
      sizes[stream] += retained.length
      if (chunk.length > remaining) {
        failure = Object.assign(new RangeError(`Capture command ${stream} exceeded ${maxBuffer} bytes`), {
          code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
        })
        child.stdout.destroy()
        child.stderr.destroy()
        terminate(false)
      }
    }
    child.stdout.on("data", (chunk: Buffer) => collect("stdout", chunk))
    child.stderr.on("data", (chunk: Buffer) => collect("stderr", chunk))
    child.on("error", (error) => {
      failure ??= error
    })
    child.on("close", (code, signal) => {
      clearTimeout(timer)
      const stdout = Buffer.concat(chunks.stdout)
      const stderr = Buffer.concat(chunks.stderr)
      try {
        onStderr?.(stderr)
      } catch (observerError) {
        reject(observerError)
        return
      }
      if (failure !== undefined || code !== 0 || signal !== null || killed) {
        const missingExecutable = isMissingExecutableError(failure)
        const searchedPath = (environment ?? process.env).PATH ?? ""
        const failureCode = missingExecutable ? "ENOENT" : failure && "code" in failure ? failure.code : code
        const primaryError = missingExecutable
          ? missingExecutableFailure(file, searchedPath, step, failure)
          : (failure ??
            (killedByDeadline ? commandDeadlineError : (message: string) => new Error(message))(
              captureCommandFailure(file, signal, code, killedByDeadline, timeout, step, stderr),
            ))
        reject(
          Object.assign(primaryError, {
            code: failureCode,
            signal,
            killed,
            captureCommand: {
              file,
              args: [...args],
              ...(missingExecutable && { searchedPath, nothingMeasured: true }),
              stdoutBase64: stdout.toString("base64"),
              stderrBase64: stderr.toString("base64"),
              code: failureCode,
              signal,
              killed,
            },
          }),
        )
      } else if (stdinError) reject(stdinError)
      else resolve(stdout)
    })
    child.stdin.on("error", (error: Error) => {
      stdinError = error
    })
    child.stdin.end(input)
  })
}

function isMissingExecutableError(error: Error | undefined): boolean {
  if (error === undefined) return false
  return (error as NodeJS.ErrnoException).code === "ENOENT" || /^Executable not found in \$PATH:/i.test(error.message)
}

function missingExecutableFailure(
  file: string,
  searchedPath: string,
  step: CaptureCommandStep | undefined,
  cause: Error | undefined,
): Error {
  const named = step === undefined ? "" : ` (${step.step})`
  const error = new Error(
    `Capture preflight missing executable ${JSON.stringify(file)}${named} in PATH ${JSON.stringify(searchedPath)}; nothing measured`,
    cause === undefined ? undefined : { cause },
  )
  error.name = "CapturePreflightMissingExecutable"
  return error
}

/**
 * The message a capture command failure carries. A kill by our own timer names the step and the budget
 * it passed, because a bare signal reads as the app failing when the sender was this collector (#34892).
 */
function captureCommandFailure(
  file: string,
  signal: NodeJS.Signals | null,
  code: number | null,
  killedByDeadline: boolean,
  timeout: number,
  step: CaptureCommandStep | undefined,
  stderr: Buffer,
): string {
  const named = step === undefined ? "" : ` (${step.step})`
  if (killedByDeadline) {
    const budget = step?.budgetMs === undefined ? "" : ` of its ${step.budgetMs} ms budget`
    return `Capture command ${file}${named} was killed at this collector's own deadline: ${timeout} ms${budget} elapsed without the process exiting; the sender is this collector, not the measured app`
  }
  return `Capture command ${file}${named} failed: ${signal ?? `exit ${code}`}\n${stderr.toString()}`
}

function digest(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex")
}

/** Retain content-addressed bytes and return their `sha256:` ref. An identical repeat is the same
 * artifact, not an error; different bytes behind the same digest is named rather than overwritten. */
export function retain(
  directory: string,
  bytes: Buffer,
  extension: string,
  onRetained: (artifact: { path: string; sha256: string }) => void,
): string {
  if (typeof onRetained !== "function") throw new Error("Capture retention requires its artifact observer")
  const hash = digest(bytes)
  const path = join(directory, `${hash}.${extension}`)
  try {
    writeFileSync(path, bytes, { flag: "wx", mode: 0o600 })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
    if (!readFileSync(path).equals(bytes)) throw new Error(`Capture artifact digest collision at ${path}`)
  }
  onRetained({ path, sha256: hash })
  return `sha256:${hash}`
}

/**
 * How a capture's source is kept on disk (34127). An X window dump is 99.9% of an app run and
 * compresses about 2,000x, so its retained copy is zstd level 3 under `.xwd.zst`; a PNG source is
 * already compressed and is kept as it is. The stored bytes are what `retain` names, so the file
 * name, `sourceRef`, the run's blob manifest and every stored-byte check agree, and the raw dump
 * is recovered exactly by decompressing. Only the retained copy changes: decoding and the PNG
 * conversion keep reading the raw in-memory dump. An encoding failure throws; nothing falls back
 * to writing the raw dump.
 */
export function retainedSource(source: Pick<CaptureSource, "bytes" | "format">): { bytes: Buffer; extension: string } {
  if (source.format === "png") return { bytes: source.bytes, extension: "png" }
  return {
    bytes: zstdCompressSync(source.bytes, { params: { [zlibConstants.ZSTD_c_compressionLevel]: 3 } }),
    extension: "xwd.zst",
  }
}

/**
 * Encode one captured frame as PNG for an archive the run keeps beside a refusal (#37667). The same
 * determinism args the capture conversion uses, so two runs that judged identical pixels archive the
 * same digest. There is no second encoder here: the frame itself carries pixels only, and the
 * converter that already produced every retained PNG produces this one, under the caller's deadline.
 */
export async function encodeFramePng(frame: CapturedFrame, deadline: number): Promise<Buffer> {
  const bytes = await command(
    "magick",
    [
      ...CONVERSION_THREAD_ARGS,
      "-size",
      `${frame.width}x${frame.height}`,
      "-depth",
      "8",
      "rgba:-",
      "-define",
      "png:exclude-chunks=date,time",
      "-set",
      "comment",
      "",
      "png:-",
    ],
    Buffer.from(frame.rgba),
    deadline,
  )
  if (!bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error(`Frame archive encoding returned ${bytes.length} bytes that are not a PNG`)
  }
  return bytes
}

/** One captured frame's raw pixels, exactly the bytes the collector digests. */
export interface CapturedFrame {
  width: number
  height: number
  rgba: Uint8Array
}

/**
 * Map a cell-aligned region to an absolute rectangle from the terminal's OWN pixel report and the
 * text area's own witnessed origin, and from nothing else: a window width
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
  /**
   * The settled name of the measurement behind `textOrigin` (`NamedTextOrigin.basisKind`). A
   * rectangle that cannot fit the frame refuses by name; without this the reader learns only that a
   * number was too large, never which measurement produced it (34163).
   */
  basis?: string
  /**
   * The sentinel pair the origin was derived from, when there was one. A frame-extent refusal is
   * the only record a failing read leaves, so the pair travels in it: the cells the code believed it
   * painted beside the boxes it located are what prove the pair moved (34163).
   */
  witness?: NamedTextOrigin["witness"]
  /** The pre-paint difference's changed pixels outside the located pair (`NamedTextOrigin.changedOutside`). */
  changedOutside?: number
}): CaptureRectangle {
  const {
    cells,
    pixelGeometry: geometry,
    textOrigin,
    windowWidth,
    windowHeight,
    visible,
    basis,
    witness,
    changedOutside,
  } = input
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
      `Capture rectangle ${JSON.stringify(rectangle)} leaves the measured ${windowWidth}x${windowHeight} window for cells ${JSON.stringify(cells)}: ` +
        `${geometry.cellWidth}x${geometry.cellHeight} cells from text origin ${textOrigin.x},${textOrigin.y} ` +
        `(${basis ? `origin basis: ${basis}` : "origin basis unnamed, so no measurement can be blamed"}) ` +
        `over a ${geometry.textWidth}x${geometry.textHeight} text area` +
        (witness
          ? `; sentinel witness cells ${witness.a.cell.row},${witness.a.cell.col} at ${witness.a.box.x},${witness.a.box.y} and ${witness.b.cell.row},${witness.b.cell.col} at ${witness.b.box.x},${witness.b.box.y}`
          : "") +
        (changedOutside === undefined
          ? ""
          : `; ${changedOutside} px changed outside those boxes between the pre-paint frame and this one`),
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
  /**
   * The settled name of the measurement behind `origin` (33982): `basis` is prose that names this
   * frame's own noise, so two frames of one read can never compare equal on it. Equality of THIS name
   * is what lets a comparison treat two frames as measured one way rather than two.
   */
  basisKind?: string
  surface?: CaptureRectangle
  /** The measured text-area pixels when a window edge clips the last row or column. */
  visible?: { width: number; height: number }
  /**
   * The sentinel pair this read located, cells and boxes. The origin above is derived from one box,
   * so a later comparison of origins is that one measurement restated; the pair is the independent
   * half and must travel with the frame for a grid move to be proved (33982).
   */
  witness?: NonNullable<PixelCellCrop["witness"]>
  /**
   * Pixels that changed between the pre-paint frame and the frame this origin was derived from
   * WITHOUT carrying the sentinel colour. A held viewport moved by whole rows shows as a delta on a
   * quiet frame; a re-anchored viewport shows here as a large number (34163).
   */
  changedOutside?: number
  /**
   * Where a DECLARED viewport hold put the painted pair, in rows off the settled origin (34163).
   * Present only when the probe declared the hold, and an observation only: no grade or published
   * cell may read it until the XTest wheel event's effective displacement is measured.
   */
  scrolledRows?: { rows: number; direction: "up" | "down"; notches: number }
  /**
   * The whole-row displacement this read ACCEPTED, in rows and pixels (33982 condition 3). Present
   * only when a measured bound licensed it, so its presence is the count of accepted moves rather
   * than a zero that cannot be told from "no move seen".
   */
  acceptedRowMove?: { rows: number; px: number }
  /**
   * Prose about this frame that a comparison may never read: `basis` is compared across frames of one
   * row by `gridMoveExemption`, so anything that differs per frame — the accepted shift, for one —
   * belongs here and not there (33982, @cto).
   */
  basisDetail?: string
  /**
   * Witnessed screen mode this origin belongs to (#37701, @cto be5f14e5); absent for primary reads.
   */
  screenMode?: import("@terminfo/probe-defs").CaptureScreenMode
}
type Checkpoint = Parameters<ProbeCapture>[0]
export type OriginResolver = (input: {
  frame: CapturedFrame
  pixelGeometry: NonNullable<Checkpoint["pixelGeometry"]>
}) => NamedTextOrigin | Promise<NamedTextOrigin>

/**
 * The PNG conversion a capture writes (#30764). Two things made identical pixels hash differently:
 * magick stamps `tIME` and `date:*` text into every conversion, and it copies the XWD window name
 * into a `tEXt comment` — 715 of the 2,724 duplicate-image groups on main, measured 2026-10-22,
 * differ only by that name ("Alacritty", "bun", "osc0-icon-title"). Excluding the date and time
 * chunks and clearing the comment gives one evidence hash per screen; `-strip` would do the same but
 * also drops cHRM and bKGD, which describe the pixels.
 */
export const PNG_CONVERSION_ARGS = [
  "xwd:-",
  "-define",
  "png:exclude-chunks=date,time",
  "-set",
  "comment",
  "",
  "png:-",
] as const

/**
 * One thread for the acquisition conversion (#34549, @cto fd4e3b66). The run container has 2 CPUs and
 * several conversions overlap during sgr.blink sampling; ImageMagick's extra worker costs 7-9 ms CPU per
 * conversion and buys no wall time on these 800x600 frames. Output is byte-identical (retained PNG and
 * RGBA), measured on retained alacritty and ghostty frames: /hh/var/@dev/1/34549/convert/report.md.
 */
export const CONVERSION_THREAD_ARGS = ["-limit", "thread", "1"] as const

/**
 * The command budget one capture conversion owns when it is handed a deadline that has already
 * passed (#35129). A conversion only transforms bytes the caller is holding: it never waits on a
 * paint, so a paint budget an earlier stage spent must not be able to refuse it before it starts.
 * Equal to command()'s own default, which is what this conversion would have run under had the
 * caller passed no deadline at all.
 */
export const CONVERSION_FALLBACK_TIMEOUT_MS = 10_000

/** The depth-8 RGBA output every pixel digest and every reproduction recipe hashes. */
const DEPTH8_RGBA_ARGS = ["-depth", "8", "rgba:-"] as const

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

/** The converter identity a run records: one `magick -version` probe for every adapter (#34549). */
export async function converterIdentity(): Promise<string> {
  return (await command("magick", ["-version"])).toString().trim()
}

/**
 * One acquisition's conversion input. The retained-PNG policy is the adapter call site's explicit
 * choice and is never inferred here from the format or the feature (#34549, @cto amendment 1):
 * - `normalized` (Linux XWD and Linux pointer PNG): the source is re-encoded through
 *   PNG_CONVERSION_ARGS into a temporary file under `scratchDirectory`, in the same magick process
 *   that writes the RGBA.
 * - `original` (Darwin): the screencapture PNG is retained exactly as acquired.
 */
export type ConvertCaptureInput = {
  bytes: Buffer
  featureId: string
  /**
   * Absolute deadline passed to every command this conversion runs. A deadline that has already
   * elapsed when the conversion starts is replaced by this conversion's own command budget (#35129):
   * the conversion transforms bytes already in hand and never waits on a paint, so a paint budget an
   * earlier stage spent must not refuse it.
   */
  deadline?: number
  /**
   * The pixel size the caller already measured (Linux: the window's own geometry). Absent, the owner
   * reads the image's own extent with one `info:` query before decoding (Darwin), and the caller
   * applies its own acceptance (requireDarwinScale) to the returned frame.
   */
  extent?: { width: number; height: number }
} & ({ retain: "normalized"; format: "xwd" | "png"; scratchDirectory: string } | { retain: "original"; format: "png" })

/**
 * The one converter for every acquisition path (#34549): the retained PNG plus the depth-8 RGBA
 * frame finalization digests. Processes per route: Linux normalized = 1 (convert + RGBA), Darwin
 * original = 2 (extent query, then decode). Malformed output always throws: a wrong PNG signature,
 * or an RGBA length that is not the extent's; with a caller-measured extent, one `info:` query only
 * words that error and never yields a frame.
 */
export async function convertCapture(input: ConvertCaptureInput): Promise<{ png: Buffer; frame: CapturedFrame }> {
  const { bytes, format, featureId, deadline } = input
  // Renew only a finite deadline the earlier capture already spent (#35129). Omitted deadlines
  // keep command()'s per-process default; nonfinite values keep its existing validation error.
  const convertDeadline =
    deadline !== undefined && Number.isFinite(deadline) && deadline <= Date.now()
      ? Date.now() + CONVERSION_FALLBACK_TIMEOUT_MS
      : deadline
  const readExtent = async () =>
    capturePixels(
      (await command("magick", [`${format}:-`, "-format", "%wx%h", "info:"], bytes, convertDeadline)).toString(),
    )
  const { width, height } = input.extent ?? (await readExtent())
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) {
    throw new Error(`Invalid captured frame extent ${width}x${height}`)
  }
  let png: Buffer
  let rgba: Buffer
  if (input.retain === "normalized") {
    const converted = await mkdtemp(join(input.scratchDirectory, ".converted-"))
    try {
      const output = join(converted, "frame.png")
      rgba = await command(
        "magick",
        [
          ...CONVERSION_THREAD_ARGS,
          `${format}:-`,
          ...PNG_CONVERSION_ARGS.slice(1, -1),
          "-write",
          `png:${output}`,
          ...DEPTH8_RGBA_ARGS,
        ],
        bytes,
        convertDeadline,
      )
      png = await readFile(output)
    } finally {
      await rm(converted, { recursive: true, force: true })
    }
  } else {
    rgba = await command("magick", [`${format}:-`, ...DEPTH8_RGBA_ARGS], bytes, convertDeadline)
    png = bytes
  }
  if (!png.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error(`Capture conversion did not produce PNG bytes for ${featureId}`)
  }
  const expected = width * height * 4
  if (rgba.length !== expected) {
    if (input.extent !== undefined) {
      const captured = await readExtent()
      if (captured.width !== width || captured.height !== height) {
        throw new Error(
          `capture ${captured.width}x${captured.height} differs from window ${width}x${height} (border included?)`,
        )
      }
    }
    throw new Error(
      `Capture conversion for ${featureId} returned ${rgba.length} RGBA bytes; ${width}x${height} at depth 8 rgba is ${expected}`,
    )
  }
  return { png, frame: { width, height, rgba } }
}

/**
 * Where one exact RGB colour sits in a decoded frame: the bounding box of every matching pixel and
 * how many matched, or null when no pixel has that colour. Alpha is not compared, as calibration
 * compares only RGB when it learns the colour.
 */
export function locateColour(frame: CapturedFrame, rgb: readonly [number, number, number]): CaptureLocated | null {
  if (!rgb.every((channel) => Number.isSafeInteger(channel) && channel >= 0 && channel <= 255)) {
    throw new Error(`Capture locate needs an integer RGB colour 0..255; got ${JSON.stringify(rgb)}`)
  }
  let left = Infinity
  let top = Infinity
  let right = -1
  let bottom = -1
  let pixels = 0
  for (let y = 0; y < frame.height; y++) {
    for (let x = 0; x < frame.width; x++) {
      const offset = (y * frame.width + x) * 4
      if (frame.rgba[offset] !== rgb[0] || frame.rgba[offset + 1] !== rgb[1] || frame.rgba[offset + 2] !== rgb[2]) {
        continue
      }
      pixels++
      if (x < left) left = x
      if (x > right) right = x
      if (y < top) top = y
      if (y > bottom) bottom = y
    }
  }
  if (pixels === 0) return null
  return { box: { x: left, y: top, width: right - left + 1, height: bottom - top + 1 }, pixels }
}

/**
 * The frame's own view of the axes: what the run record carries, with the coverage array attached
 * non-enumerably so it is readable in this process and invisible to JSON serialization.
 */
export function renderedAxes(axes: CaptureRenderingAxes): CaptureRenderingAxes {
  const rendering: CaptureRenderingAxes = {
    background: axes.background,
    inkColour: axes.inkColour,
    inkCount: axes.inkCount,
    contrast: axes.contrast,
  }
  if (axes.coverage) Object.defineProperty(rendering, "coverage", { value: axes.coverage, enumerable: false })
  if (axes.rgb) Object.defineProperty(rendering, "rgb", { value: axes.rgb, enumerable: false })
  return rendering
}

/**
 * The rendering axes of one already-cropped RGBA frame, measured from the same bytes its
 * `regionDigest` hashed, plus the per-pixel coverage they came from. Ties are broken on the lowest
 * packed colour so two identical crops never disagree about which colour is modal.
 */
export function renderingAxes(cropped: Buffer): CaptureRenderingAxes {
  const pixels = cropped.byteLength / 4
  const counts = new Map<number, number>()
  for (let index = 0; index < pixels; index++) {
    const offset = index * 4
    const packed = ((cropped[offset] ?? 0) << 16) | ((cropped[offset + 1] ?? 0) << 8) | (cropped[offset + 2] ?? 0)
    counts.set(packed, (counts.get(packed) ?? 0) + 1)
  }
  let background = 0
  let backgroundCount = -1
  for (const [packed, count] of counts) {
    if (count > backgroundCount || (count === backgroundCount && packed < background)) {
      background = packed
      backgroundCount = count
    }
  }
  // The MODAL ink colour, and the count of every pixel that is not the background: the floor the
  // reader applies is about how much ink the crop carries, not how much of it is the modal colour.
  let ink = background
  let inkMode = 0
  let inkCount = 0
  for (const [packed, count] of counts) {
    if (packed === background) continue
    inkCount += count
    if (count > inkMode || (count === inkMode && packed < ink)) {
      ink = packed
      inkMode = count
    }
  }
  const channel = (packed: number, shift: number) => (packed >> shift) & 0xff
  const distance = (packed: number) =>
    Math.max(
      Math.abs(channel(packed, 16) - channel(background, 16)),
      Math.abs(channel(packed, 8) - channel(background, 8)),
      Math.abs(channel(packed, 0) - channel(background, 0)),
    )
  const contrast = distance(ink)
  const coverage = new Uint8Array(pixels)
  const rgb = new Uint8Array(pixels * 3)
  for (let index = 0; index < pixels; index++) {
    rgb[index * 3] = cropped[index * 4] ?? 0
    rgb[index * 3 + 1] = cropped[index * 4 + 1] ?? 0
    rgb[index * 3 + 2] = cropped[index * 4 + 2] ?? 0
  }
  if (contrast > 0) {
    for (let index = 0; index < pixels; index++) {
      const offset = index * 4
      const packed = ((cropped[offset] ?? 0) << 16) | ((cropped[offset + 1] ?? 0) << 8) | (cropped[offset + 2] ?? 0)
      coverage[index] = Math.min(255, Math.round((255 * distance(packed)) / contrast))
    }
  }
  const hex = (packed: number) => `#${packed.toString(16).padStart(6, "0")}`
  return {
    background: hex(background),
    inkColour: hex(ink),
    inkCount,
    contrast,
    coverage,
    rgb,
  }
}

type LayoutGuardVerdict = Omit<CaptureLayoutGuard, "against">

/**
 * The bounded layout-guard comparison (#34932, @cto 34932-five-criteria-ruling-2216 item 5): exact
 * dimensions and coordinate correspondence, exact alpha, every RGB channel within 1, and an identical
 * background/ink mask under the run's witnessed background members. A pixel is background exactly when
 * its packed RGB is one of those members. No neighbourhood matching, resampling, averaging or allowance.
 */
export function compareLayoutGuard(
  earlier: { readonly width: number; readonly height: number; readonly rgba: Uint8Array },
  later: { readonly width: number; readonly height: number; readonly rgba: Uint8Array },
  background: ReadonlySet<number> | undefined,
): LayoutGuardVerdict {
  const members = background?.size ?? 0
  const base = { width: later.width, height: later.height, backgroundMembers: members }
  if (earlier.width !== later.width || earlier.height !== later.height) {
    return {
      ...base,
      holds: false,
      reason: `the crops are ${earlier.width}x${earlier.height} and ${later.width}x${later.height}`,
      changedPixels: 0,
      maxChannelDelta: 0,
      alphaExact: false,
      maskChangedPixels: 0,
    }
  }
  let changedPixels = 0
  let maxChannelDelta = 0
  let alphaExact = true
  let maskChangedPixels = 0
  for (let offset = 0; offset < later.rgba.length; offset += 4) {
    const a = earlier.rgba
    const b = later.rgba
    let changed = false
    for (let channel = 0; channel < 3; channel++) {
      const delta = Math.abs((a[offset + channel] ?? 0) - (b[offset + channel] ?? 0))
      if (delta > 0) changed = true
      if (delta > maxChannelDelta) maxChannelDelta = delta
    }
    if (a[offset + 3] !== b[offset + 3]) {
      alphaExact = false
      changed = true
    }
    if (changed) changedPixels++
    if (background) {
      const packedA = ((a[offset] ?? 0) << 16) | ((a[offset + 1] ?? 0) << 8) | (a[offset + 2] ?? 0)
      const packedB = ((b[offset] ?? 0) << 16) | ((b[offset + 1] ?? 0) << 8) | (b[offset + 2] ?? 0)
      if (background.has(packedA) !== background.has(packedB)) maskChangedPixels++
    }
  }
  const measured = { ...base, changedPixels, maxChannelDelta, alphaExact, maskChangedPixels }
  // Identical crops hold whatever the background set: there is no mask to compare (@dev/6 peer note on 34932).
  const reason =
    changedPixels === 0
      ? undefined
      : members === 0
        ? "no witnessed background members were supplied, so the background/ink mask cannot be compared"
        : !alphaExact
          ? "alpha differs"
          : maxChannelDelta > 1
            ? `an RGB channel differs by ${maxChannelDelta}`
            : maskChangedPixels > 0
              ? `${maskChangedPixels} coordinate(s) changed between background and ink`
              : undefined
  return reason === undefined ? { ...measured, holds: true } : { ...measured, holds: false, reason }
}

/**
 * Crops kept for one later layout-guard comparison, by frame ref. A comparison consumes its entry; the
 * oldest is dropped past a small bound, so an abandoned guard cannot grow this, and a comparison against
 * a dropped or unknown ref answers that by name.
 */
const layoutGuardCrops = new Map<string, { cells: string; width: number; height: number; rgba: Uint8Array }>()
const LAYOUT_GUARD_KEPT = 8

/** Finish one acquired frame; currency and capture scheduling belong to the caller. */
export async function finishCapture(input: {
  directory: string
  onRetained: Parameters<typeof retain>[3]
  checkpoint: Checkpoint
  source: CaptureSource
  png: Buffer
  origin: NamedTextOrigin | OriginResolver
  trace: Record<string, unknown>
  /** The pixels convertCapture decoded for this exact capture; finalization never decodes (30092, 34549). */
  decoded: CapturedFrame
}): Promise<Awaited<ReturnType<ProbeCapture>>> {
  const finishEntry = performance.now()
  const { directory, onRetained, checkpoint, source, png, origin, trace, decoded } = input
  const { featureId, role, label, cells, controlCells, pixelGeometry, locate } = checkpoint
  const { width, height, format, capturedAt } = source
  // The whole of both retains: hashing, the exclusive write or the existing-file read/compare, and
  // the onRetained callback. Deliberately not labelled write time and not corrected for its hash.
  const retainStart = performance.now()
  const stored = retainedSource(source)
  const sourceRef = retain(directory, stored.bytes, stored.extension, onRetained)
  const ref = retain(directory, png, "png", onRetained)
  const retainMs = Math.round(performance.now() - retainStart)
  const sourceStem = sourceRef.replace(/^sha256:/, "")
  const pngStem = ref.replace(/^sha256:/, "")
  if ((cells === undefined) !== (pixelGeometry === undefined)) {
    throw new Error(
      `Capture ${featureId} was asked for a cell-aligned digest without both cells and the terminal's pixel report`,
    )
  }
  if (controlCells !== undefined && cells === undefined) {
    throw new Error(`Capture ${featureId} was asked for a same-shot control region without the region it controls`)
  }
  if (decoded.width !== width || decoded.height !== height || decoded.rgba.byteLength !== width * height * 4) {
    throw new Error(
      `Decoded capture for ${featureId} is ${decoded.width}x${decoded.height} with ${decoded.rgba.byteLength} bytes; source is ${width}x${height} with ${width * height * 4} depth-8 RGBA bytes`,
    )
  }
  const postDecodeStart = performance.now()
  const pixelsDigest = `sha256:${digest(Buffer.from(decoded.rgba.buffer, decoded.rgba.byteOffset, decoded.rgba.byteLength))}`
  let regionDigest: string | undefined
  let regionRectangle: CaptureRectangle | undefined
  let frameRendering: CaptureRenderingAxes | undefined
  let controlRegionDigest: string | undefined
  let controlRegionRectangle: CaptureRectangle | undefined
  let regionTrace: Record<string, unknown> = {}
  let cellCrop: PixelCellCrop | undefined
  let layoutGuard: CaptureLayoutGuard | undefined
  const located = locate === undefined ? undefined : locateColour(decoded, locate.rgb)
  if (cells !== undefined && pixelGeometry !== undefined) {
    const placement = typeof origin === "function" ? await origin({ frame: decoded, pixelGeometry }) : origin
    if (!placement || typeof placement.basis !== "string" || placement.basis.trim().length === 0 || !placement.origin) {
      throw new Error(`Capture ${featureId} lacks a named text-area origin`)
    }
    const cropRegion = (regionCells: NonNullable<Checkpoint["cells"]>) => {
      const rectangle = cellRectangle({
        cells: regionCells,
        pixelGeometry,
        textOrigin: placement.origin,
        windowWidth: width,
        windowHeight: height,
        ...(placement.visible ? { visible: placement.visible } : {}),
        ...(placement.basisKind !== undefined ? { basis: placement.basisKind } : {}),
        ...(placement.witness !== undefined ? { witness: placement.witness } : {}),
        ...(placement.changedOutside !== undefined ? { changedOutside: placement.changedOutside } : {}),
      })
      const cropExpected = rectangle.width * rectangle.height * 4
      const cropped = Buffer.alloc(cropExpected)
      const rowBytes = rectangle.width * 4
      for (let row = 0; row < rectangle.height; row++) {
        const start = ((rectangle.y + row) * width + rectangle.x) * 4
        cropped.set(decoded.rgba.subarray(start, start + rowBytes), row * rowBytes)
      }
      if (cropped.length !== cropExpected) {
        throw new Error(
          `Cropped capture for ${featureId} is ${cropped.length} bytes; ${JSON.stringify(rectangle)} at depth 8 rgba is ${cropExpected}`,
        )
      }
      return { rectangle, cropped, digest: `sha256:${digest(cropped)}`, rendering: renderingAxes(cropped) }
    }
    const region = cropRegion(cells)
    const rectangle = region.rectangle
    const control = controlCells !== undefined ? cropRegion(controlCells) : undefined
    // Reproduction recipes, not the acquisition argv (#34549 amendment 6): rawCommand and cropCommand
    // read the retained source on stdin, reproduceWhole/Region read the retained PNG, and all of them
    // hash the same depth-8 RGBA the acquisition digested.
    const rawCommand = [`${format}:-`, ...DEPTH8_RGBA_ARGS]
    const cropCommand = [
      `${format}:-`,
      "-crop",
      `${rectangle.width}x${rectangle.height}+${rectangle.x}+${rectangle.y}`,
      "+repage",
      ...DEPTH8_RGBA_ARGS,
    ]
    regionDigest = region.digest
    frameRendering = renderedAxes(region.rendering)
    if (checkpoint.layoutGuard !== undefined) {
      const crop = {
        cells: JSON.stringify(cells),
        width: rectangle.width,
        height: rectangle.height,
        rgba: new Uint8Array(region.cropped),
      }
      const against = checkpoint.layoutGuard.against
      if (against === undefined) {
        layoutGuardCrops.delete(ref)
        layoutGuardCrops.set(ref, crop)
        while (layoutGuardCrops.size > LAYOUT_GUARD_KEPT) {
          const oldest = layoutGuardCrops.keys().next().value
          if (oldest === undefined) break
          layoutGuardCrops.delete(oldest)
        }
      } else {
        const earlier = layoutGuardCrops.get(against)
        layoutGuardCrops.delete(against)
        layoutGuard =
          earlier === undefined
            ? {
                against,
                holds: false,
                reason: `no guard crop is kept for ${against}`,
                width: crop.width,
                height: crop.height,
                changedPixels: 0,
                maxChannelDelta: 0,
                alphaExact: false,
                maskChangedPixels: 0,
                backgroundMembers: checkpoint.layoutGuardBackground?.size ?? 0,
              }
            : earlier.cells !== crop.cells
              ? {
                  against,
                  holds: false,
                  reason: `the guard crops name different cells (${earlier.cells} and ${crop.cells})`,
                  width: crop.width,
                  height: crop.height,
                  changedPixels: 0,
                  maxChannelDelta: 0,
                  alphaExact: false,
                  maskChangedPixels: 0,
                  backgroundMembers: checkpoint.layoutGuardBackground?.size ?? 0,
                }
              : { against, ...compareLayoutGuard(earlier, crop, checkpoint.layoutGuardBackground) }
      }
    }
    regionRectangle = rectangle
    const columns = pixelGeometry.textWidth / pixelGeometry.cellWidth
    const rows = pixelGeometry.textHeight / pixelGeometry.cellHeight
    cellCrop = {
      origin: placement.origin,
      ...(placement.basisKind !== undefined ? { basis: placement.basisKind } : {}),
      basisDetail: placement.basis,
      ...(placement.surface !== undefined ? { surface: placement.surface } : {}),
      cell: { width: pixelGeometry.cellWidth, height: pixelGeometry.cellHeight },
      ...(Number.isSafeInteger(columns) && Number.isSafeInteger(rows) && columns > 0 && rows > 0
        ? { grid: { columns, rows } }
        : {}),
      image: { width, height },
      ...(placement.witness !== undefined ? { witness: placement.witness } : {}),
      // 33982: the count has to outlive the read that produced it. The type always declared this
      // field, but the crop record never filled it, so every retained frame dropped the one number
      // the row-move measurement needs. Absent, never 0, when the origin carried none.
      ...(placement.changedOutside !== undefined ? { changedOutside: placement.changedOutside } : {}),
      ...(placement.scrolledRows !== undefined ? { scrolledRows: placement.scrolledRows } : {}),
      // 33982: an accepted whole-row move travels with the frame as data, so the record can count
      // accepted moves instead of parsing a sentence, and its prose goes beside `basis` rather than
      // into it (a comparison reads `basis`).
      ...(placement.acceptedRowMove !== undefined ? { acceptedRowMove: placement.acceptedRowMove } : {}),
      ...(placement.basisDetail !== undefined ? { basisDetail: placement.basisDetail } : {}),
      ...(placement.screenMode !== undefined ? { screenMode: placement.screenMode } : {}),
    }
    controlRegionDigest = control?.digest
    controlRegionRectangle = control?.rectangle
    regionTrace = {
      cells,
      ...(controlCells !== undefined ? { controlCells } : {}),
      pixelGeometry,
      textArea: {
        origin: placement.origin,
        ...(placement.surface ? { surface: placement.surface } : {}),
        ...(placement.visible ? { visible: placement.visible } : {}),
        basis: placement.basis,
      },
      rectangle,
      ...(control !== undefined ? { controlRectangle: control.rectangle } : {}),
      rawCommand: ["magick", ...rawCommand],
      cropCommand: ["magick", ...cropCommand],
      retained: { png: `${pngStem}.png`, [format]: `${sourceStem}.${stored.extension}` },
      reproduceWhole: `magick ${pngStem}.png -depth 8 rgba:- | sha256sum`,
      reproduceRegion: `magick ${pngStem}.png -crop ${rectangle.width}x${rectangle.height}+${rectangle.x}+${rectangle.y} +repage -depth 8 rgba:- | sha256sum`,
      ...(control !== undefined
        ? {
            reproduceControlRegion: `magick ${pngStem}.png -crop ${control.rectangle.width}x${control.rectangle.height}+${control.rectangle.x}+${control.rectangle.y} +repage -depth 8 rgba:- | sha256sum`,
          }
        : {}),
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
      pixelsDigest,
      ...(regionDigest !== undefined ? { regionDigest } : {}),
      ...(layoutGuard !== undefined ? { layoutGuardComparison: layoutGuard } : {}),
      ...(frameRendering !== undefined ? { rendering: frameRendering } : {}),
      ...(regionRectangle !== undefined ? { regionRectangle } : {}),
      ...(controlRegionDigest !== undefined ? { controlRegionDigest } : {}),
      ...(controlRegionRectangle !== undefined ? { controlRegionRectangle } : {}),
      ...(located !== undefined ? { located } : {}),
      ...(cellCrop !== undefined ? { cellCrop } : {}),
    },
    trace: {
      ...trace,
      ...regionTrace,
      // 34261 diagnostic buckets for the finish stage, on the acquisition trace's own
      // performance.now basis. They do not cover the whole served context.capture path: the caller's
      // dispatch and small validation and string work sit outside every bucket, so they need not sum
      // to the complete call. postDecodeMs is one aggregate by decision, not a measured split.
      // decodeMs is absent: it only ever named a decode run inside this function, and `decoded` is now
      // required, so none runs here; conversion time belongs to the adapter's own trace (34549).
      finish: {
        retainMs,
        postDecodeMs: Math.round(performance.now() - postDecodeStart),
        totalMs: Math.round(performance.now() - finishEntry),
      },
      ...(locate !== undefined ? { locate: { rgb: locate.rgb, located } } : {}),
    },
  }
}

/**
 * Where one exact colour sits in the pixels that CHANGED between two frames of the same window (33981).
 *
 * The sentinel this read paints is located by what changed, never by the colour alone: a probe that
 * paints the same colour itself, or a previous read's restore still rendering, is a fact the
 * difference keeps out of the answer instead of a case rule (33981, @cto 41cd2559). `ignoredPixels`
 * counts the changed pixels that do NOT carry the colour — cursor blink, a clock, a late render — so
 * a noisy terminal is visible in the evidence rather than filtered away.
 *
 * Changed pixels carrying the colour come back as SEPARATE regions, one per connected patch, in
 * reading order: two cells painted the sentinel colour are two boxes the caller can name and refuse,
 * never one bounding box spanning the space between them.
 */
export function locateChangedColour(
  before: CapturedFrame,
  after: CapturedFrame,
  rgb: readonly [number, number, number],
  sentinelMembers?: ReadonlySet<number>,
): { regions: CaptureLocated[]; ignoredPixels: number } {
  if (before.width !== after.width || before.height !== after.height) {
    throw new Error(
      `Frame difference needs two frames of one window; got ${before.width}x${before.height} and ${after.width}x${after.height}`,
    )
  }
  if (!rgb.every((channel) => Number.isSafeInteger(channel) && channel >= 0 && channel <= 255)) {
    throw new Error(`Frame difference needs an integer RGB colour 0..255; got ${JSON.stringify(rgb)}`)
  }
  const { width, height } = after
  const carries = new Uint8Array(width * height)
  let ignoredPixels = 0
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4
      const changed =
        before.rgba[offset] !== after.rgba[offset] ||
        before.rgba[offset + 1] !== after.rgba[offset + 1] ||
        before.rgba[offset + 2] !== after.rgba[offset + 2]
      if (!changed) continue
      const r = after.rgba[offset] ?? 0
      const g = after.rgba[offset + 1] ?? 0
      const b = after.rgba[offset + 2] ?? 0
      const matches =
        sentinelMembers !== undefined
          ? sentinelMembers.has((r << 16) | (g << 8) | b)
          : r === rgb[0] && g === rgb[1] && b === rgb[2]
      if (!matches) {
        ignoredPixels++
        continue
      }
      carries[y * width + x] = 1
    }
  }
  const regions: CaptureLocated[] = []
  const stack = new Int32Array(width * height)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const seed = y * width + x
      if (carries[seed] !== 1) continue
      let left = x
      let right = x
      let top = y
      let bottom = y
      let pixels = 0
      let depth = 0
      stack[depth++] = seed
      carries[seed] = 2
      while (depth > 0) {
        depth -= 1
        const at = stack[depth] as number
        const px = at % width
        const py = (at - px) / width
        pixels++
        if (px < left) left = px
        if (px > right) right = px
        if (py < top) top = py
        if (py > bottom) bottom = py
        if (px > 0 && carries[at - 1] === 1) {
          carries[at - 1] = 2
          stack[depth++] = at - 1
        }
        if (px + 1 < width && carries[at + 1] === 1) {
          carries[at + 1] = 2
          stack[depth++] = at + 1
        }
        if (py > 0 && carries[at - width] === 1) {
          carries[at - width] = 2
          stack[depth++] = at - width
        }
        if (py + 1 < height && carries[at + width] === 1) {
          carries[at + width] = 2
          stack[depth++] = at + width
        }
      }
      regions.push({ box: { x: left, y: top, width: right - left + 1, height: bottom - top + 1 }, pixels })
    }
  }
  return { regions, ignoredPixels }
}

// ---------------------------------------------------------------------------------------------------
// Retained-capture storage (#34769, @cto 34769-migration-v2-go-2201). This module is the one owner of
// how a retained `{path, sha256}` reference reaches bytes: the exact present file wins and is hashed as
// stored; only a genuinely absent path resolves through the directory's `retained-encoding.json`
// receipt, which maps the logical file name to an encoded file and its codec. Read, transfer and
// dependency enumeration all go through `resolveRetained`, and `writeRetainedReceipt` is the only
// writer of a receipt. No caller parses a receipt.
//
// Durable order of a migration, each step under the directory's exclusive lock: encoded file + fsync,
// directory fsync; atomic receipt + directory fsync; original unlink + directory fsync. Readers need
// no lock: a mapped original is unlinked only after its receipt row is durable, rollback restores the
// original before withdrawing its row, and encoded objects are never removed here, so every reader
// sees either the exact file or a committed row whose stored file exists.
// ---------------------------------------------------------------------------------------------------

/** The per-directory receipt mapping absent originals to encoded files. */
export const RETAINED_RECEIPT = "retained-encoding.json"
/** The per-directory exclusive mutation lock; a lock that is present is reported, never broken. */
export const RETAINED_LOCK = "retained-encoding.lock"

export type RetainedFailure =
  | "reference" // the reference is not a safe relative path plus SHA256
  | "outside" // the path resolves outside its store
  | "missing" // neither the exact file nor a receipt row serves the reference
  | "integrity" // stored or decoded bytes do not match a declared digest
  | "receipt" // a receipt is malformed or names an invalid row
  | "locked" // the directory's mutation lock is held, absent, or changed
  | "conflict" // an existing file or row differs from what would be written
  | "unclean" // temporary files from another writer are present

/** A typed refusal from retained storage. `path` names the reference or file it concerns. */
export class RetainedStoreError extends Error {
  readonly kind: RetainedFailure
  readonly path: string | undefined
  constructor(kind: RetainedFailure, message: string, path?: string, options?: ErrorOptions) {
    super(message, options)
    this.name = "RetainedStoreError"
    this.kind = kind
    this.path = path
  }
}

export interface RetainedReference {
  path: string
  sha256: string
}

/** One receipt row. `name` and `stored` are file names in the receipt's own directory. */
export interface RetainedRow {
  name: string
  sha256: string
  stored: string
  storedSha256: string
  codec: "zstd" | "gzip"
}

export interface RetainedResolution {
  reference: RetainedReference
  /** The logical bytes: the exact file's bytes, or the decoded stored bytes. */
  bytes: Buffer
  /** The physical file that served the reference, relative to the store, with its verified bytes. */
  stored: { path: string; bytes: Buffer }
  /** The receipt row, when the receipt served the reference. */
  row?: RetainedRow
  /** Physical dependencies under the caller's directory (containment checked on real paths): the exact file, or the stored file and its receipt. */
  files: string[]
}

export interface RetainedLockHolder {
  pid: number
  startedAt: string
  token: string
}

export interface RetainedLock {
  directory: string
  holder: RetainedLockHolder
  release(): void
}

const HEX64 = /^[0-9a-f]{64}$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function errnoCode(error: unknown): string | undefined {
  return isRecord(error) && typeof error.code === "string" ? error.code : undefined
}

function safeRelativePath(path: unknown): path is string {
  return (
    typeof path === "string" &&
    path !== "" &&
    !isAbsolute(path) &&
    !/^[a-z]:/i.test(path) &&
    !path.includes("\\") &&
    !path.includes("\0") &&
    !path.split("/").includes("..")
  )
}

function safeFileName(name: unknown): name is string {
  return (
    typeof name === "string" &&
    name !== "" &&
    name !== "." &&
    name !== ".." &&
    !name.includes("/") &&
    !name.includes("\\") &&
    !name.includes("\0")
  )
}

function within(root: string, path: string): boolean {
  const rel = relative(root, path)
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

/** The validated two-key reference every reader takes; anything else refuses by kind `reference`. */
export function retainedReference(reference: unknown): RetainedReference {
  if (
    !isRecord(reference) ||
    Object.keys(reference).sort().join(",") !== "path,sha256" ||
    !safeRelativePath(reference.path) ||
    typeof reference.sha256 !== "string" ||
    !HEX64.test(reference.sha256)
  ) {
    throw new RetainedStoreError("reference", "Replay artifact requires a relative path and SHA256")
  }
  return { path: reference.path, sha256: reference.sha256 }
}

/** Real path of `relativePath` under `root`; undefined only for ENOENT. An escape refuses by name. */
function containedRealPath(root: string, relativePath: string): string | undefined {
  let real: string
  try {
    real = realpathSync(join(root, relativePath))
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return undefined
    throw error
  }
  if (!within(root, real)) {
    throw new RetainedStoreError("outside", "Replay artifact resolves outside its store: " + relativePath, relativePath)
  }
  return real
}

function readIfPresent(path: string): Buffer | undefined {
  try {
    return readFileSync(path)
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return undefined
    throw error
  }
}

function lstatIfPresent(path: string): Stats | undefined {
  try {
    return lstatSync(path)
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return undefined
    throw error
  }
}

/** Bytes of a regular file in `directory`, refusing a symlink or other non-file; undefined when absent. */
function readRegular(directory: string, name: string): Buffer | undefined {
  const path = join(directory, name)
  const stat = lstatIfPresent(path)
  if (stat === undefined) return undefined
  if (!stat.isFile()) {
    throw new RetainedStoreError("conflict", `Retained storage entry is not a regular file: ${path}`, path)
  }
  return readFileSync(path)
}

function decodeStored(row: RetainedRow, stored: Buffer, label: string): Buffer {
  try {
    return row.codec === "zstd" ? zstdDecompressSync(stored) : gunzipSync(stored)
  } catch (cause) {
    throw new RetainedStoreError(
      "integrity",
      `Retained stored artifact does not decode as ${row.codec}: ${label}`,
      label,
      {
        cause,
      },
    )
  }
}

function parseReceipt(text: string, label: string): RetainedRow[] {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (cause) {
    throw new RetainedStoreError("receipt", `Retained receipt is not JSON: ${label}`, label, { cause })
  }
  if (
    !isRecord(value) ||
    Object.keys(value).sort().join(",") !== "rows,schema" ||
    value.schema !== 1 ||
    !Array.isArray(value.rows)
  ) {
    throw new RetainedStoreError("receipt", `Retained receipt is not a schema-1 row list: ${label}`, label)
  }
  const names = new Set<string>()
  return value.rows.map((row: unknown) => {
    if (
      !isRecord(row) ||
      Object.keys(row).sort().join(",") !== "codec,name,sha256,stored,storedSha256" ||
      !safeFileName(row.name) ||
      !safeFileName(row.stored) ||
      row.name === row.stored ||
      typeof row.sha256 !== "string" ||
      !HEX64.test(row.sha256) ||
      typeof row.storedSha256 !== "string" ||
      !HEX64.test(row.storedSha256) ||
      (row.codec !== "zstd" && row.codec !== "gzip")
    ) {
      throw new RetainedStoreError("receipt", `Retained receipt has a malformed row: ${label}`, label)
    }
    if (names.has(row.name)) {
      throw new RetainedStoreError("receipt", `Retained receipt maps ${row.name} more than once: ${label}`, label)
    }
    names.add(row.name)
    return { name: row.name, sha256: row.sha256, stored: row.stored, storedSha256: row.storedSha256, codec: row.codec }
  })
}

function serializeReceipt(rows: Iterable<RetainedRow>): string {
  const sorted = [...rows].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  return (
    JSON.stringify(
      {
        schema: 1,
        rows: sorted.map(({ name, sha256, stored, storedSha256, codec }) => ({
          name,
          sha256,
          stored,
          storedSha256,
          codec,
        })),
      },
      null,
      2,
    ) + "\n"
  )
}

function readReceiptRows(directory: string): RetainedRow[] {
  const bytes = readRegular(directory, RETAINED_RECEIPT)
  return bytes === undefined ? [] : parseReceipt(bytes.toString("utf8"), join(directory, RETAINED_RECEIPT))
}

/**
 * Resolve one retained reference to its bytes and physical dependencies. The exact present path is
 * hashed as stored and a mismatch throws; it never falls through to a substitute. Only ENOENT on the
 * exact path consults the receipt beside it, which must hold exactly one row for that file name whose
 * declared digest, stored digest and decoded digest all agree.
 */
export function resolveRetained(directory: string, reference: unknown): RetainedResolution {
  const ref = retainedReference(reference)
  const root = realpathSync(directory)
  const exact = containedRealPath(root, ref.path)
  const exactBytes = exact === undefined ? undefined : readIfPresent(exact)
  if (exact !== undefined && exactBytes !== undefined) {
    if (digest(exactBytes) !== ref.sha256) {
      throw new RetainedStoreError("integrity", "Replay artifact SHA256 differs: " + ref.path, ref.path)
    }
    return {
      reference: ref,
      bytes: exactBytes,
      stored: { path: ref.path, bytes: exactBytes },
      files: [join(directory, ref.path)],
    }
  }
  // Something unreadable at the exact path (a dangling symlink) is not an absence: never serve the receipt for it.
  if (exact === undefined && lstatIfPresent(join(root, ref.path)) !== undefined) {
    throw new RetainedStoreError(
      "conflict",
      `Replay artifact path is not a readable regular file: ${ref.path}`,
      ref.path,
    )
  }
  const parent = dirname(ref.path)
  const receiptRelative = join(parent, RETAINED_RECEIPT)
  const receiptPath = containedRealPath(root, receiptRelative)
  const receiptBytes = receiptPath === undefined ? undefined : readIfPresent(receiptPath)
  if (receiptPath === undefined || receiptBytes === undefined) {
    throw new RetainedStoreError(
      "missing",
      "Replay artifact missing (ENOENT, no retained receipt): " + ref.path,
      ref.path,
    )
  }
  const name = basename(ref.path)
  const row = parseReceipt(receiptBytes.toString("utf8"), receiptRelative).find((candidate) => candidate.name === name)
  if (row === undefined) {
    throw new RetainedStoreError(
      "missing",
      `Replay artifact missing (ENOENT) and unmapped by ${receiptRelative}: ${ref.path}`,
      ref.path,
    )
  }
  if (row.sha256 !== ref.sha256) {
    throw new RetainedStoreError("integrity", `Retained receipt maps ${ref.path} to a different SHA256`, ref.path)
  }
  const storedRelative = join(parent, row.stored)
  const storedPath = containedRealPath(root, storedRelative)
  const stored = storedPath === undefined ? undefined : readIfPresent(storedPath)
  if (storedPath === undefined || stored === undefined) {
    throw new RetainedStoreError("missing", `Retained stored artifact missing: ${storedRelative}`, ref.path)
  }
  if (digest(stored) !== row.storedSha256) {
    throw new RetainedStoreError("integrity", `Retained stored artifact SHA256 differs: ${storedRelative}`, ref.path)
  }
  const bytes = decodeStored(row, stored, storedRelative)
  if (digest(bytes) !== ref.sha256) {
    throw new RetainedStoreError(
      "integrity",
      `Retained stored artifact decodes to different bytes: ${ref.path}`,
      ref.path,
    )
  }
  return {
    reference: ref,
    bytes,
    stored: { path: storedRelative, bytes: stored },
    row,
    files: [join(directory, storedRelative), join(directory, receiptRelative)],
  }
}

function fsyncDirectory(directory: string): void {
  const fd = openSync(directory, "r")
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

/** Create `path` exclusively, write all bytes and fsync it. */
function writeDurableNew(path: string, bytes: Buffer): void {
  const fd = openSync(path, "wx", 0o600)
  try {
    writeFileSync(fd, bytes)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

function tempName(final: string, token: string): string {
  return `.${final}.${token}.tmp`
}

const TEMP_FILE = /^\..+\.([0-9a-f]{16})\.tmp$/

function verifyExisting(path: string, bytes: Buffer): "reused" {
  const stat = lstatSync(path)
  if (!stat.isFile()) {
    throw new RetainedStoreError("conflict", `Retained artifact path is not a regular file: ${path}`, path)
  }
  if (!readFileSync(path).equals(bytes)) {
    throw new RetainedStoreError("conflict", `Retained artifact exists with different bytes: ${path}`, path)
  }
  return "reused"
}

/** Publish `bytes` as `final` in `directory` without replacing anything; an existing file must be byte-equal. */
function publishNoClobber(directory: string, final: string, bytes: Buffer, token: string): "written" | "reused" {
  const target = join(directory, final)
  if (lstatIfPresent(target) !== undefined) return verifyExisting(target, bytes)
  const temp = join(directory, tempName(final, token))
  writeDurableNew(temp, bytes)
  try {
    linkSync(temp, target)
  } catch (error) {
    unlinkSync(temp)
    if (errnoCode(error) !== "EEXIST") throw error
    return verifyExisting(target, bytes)
  }
  unlinkSync(temp)
  return "written"
}

function lockText(holder: RetainedLockHolder): string {
  return JSON.stringify(holder) + "\n"
}

/** Take a directory's exclusive mutation lock. A present lock refuses and names its holder. */
export function lockRetained(directory: string): RetainedLock {
  const root = realpathSync(directory)
  const path = join(root, RETAINED_LOCK)
  const holder: RetainedLockHolder = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    token: randomBytes(8).toString("hex"),
  }
  const text = lockText(holder)
  try {
    writeDurableNew(path, Buffer.from(text))
  } catch (error) {
    if (errnoCode(error) !== "EEXIST") throw error
    const current = readIfPresent(path)?.toString("utf8").trim() ?? "<unreadable>"
    throw new RetainedStoreError(
      "locked",
      `Retained storage ${root} is locked by ${current}. A lock is never broken automatically: ` +
        "if that holder is dead, run recoverRetainedLock with exactly that holder, then rerun.",
      root,
    )
  }
  fsyncDirectory(root)
  let released = false
  return {
    directory: root,
    holder,
    release() {
      if (released) return
      for (const name of readdirSync(root)) {
        if (TEMP_FILE.exec(name)?.[1] === holder.token) unlinkSync(join(root, name))
      }
      if (readIfPresent(path)?.toString("utf8") !== text) {
        throw new RetainedStoreError("locked", `Retained lock ${path} changed under its holder`, root)
      }
      unlinkSync(path)
      fsyncDirectory(root)
      released = true
    },
  }
}

function assertLockHeld(lock: RetainedLock): void {
  if (readIfPresent(join(lock.directory, RETAINED_LOCK))?.toString("utf8") !== lockText(lock.holder)) {
    throw new RetainedStoreError(
      "locked",
      `Retained storage ${lock.directory} is not locked by this writer`,
      lock.directory,
    )
  }
}

function processRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return errnoCode(error) !== "ESRCH"
  }
}

/**
 * The named owner-recovery step for a lock left by a dead writer. The caller names the exact holder it
 * read from the lock; recovery refuses a different holder or a pid that is still running, then removes
 * that holder's own temporary files and the lock. Nothing else is touched: the next run re-verifies
 * every encoded file, row and original before it relies on one.
 */
export function recoverRetainedLock(directory: string, expected: RetainedLockHolder): { removedTemps: string[] } {
  const root = realpathSync(directory)
  const path = join(root, RETAINED_LOCK)
  const text = readIfPresent(path)?.toString("utf8")
  if (text === undefined) throw new RetainedStoreError("locked", `No retained lock to recover in ${root}`, root)
  if (text !== lockText(expected)) {
    throw new RetainedStoreError(
      "locked",
      `Retained lock in ${root} is held by ${text.trim()}, not the holder named for recovery`,
      root,
    )
  }
  if (processRunning(expected.pid)) {
    throw new RetainedStoreError(
      "locked",
      `Retained lock holder pid ${expected.pid} is still running; not recovered`,
      root,
    )
  }
  const removedTemps = readdirSync(root).filter((name) => TEMP_FILE.exec(name)?.[1] === expected.token)
  for (const name of removedTemps) unlinkSync(join(root, name))
  unlinkSync(path)
  fsyncDirectory(root)
  return { removedTemps }
}

function refuseForeignTemps(lock: RetainedLock): void {
  const foreign = readdirSync(lock.directory).filter((name) => {
    const token = TEMP_FILE.exec(name)?.[1]
    return token !== undefined && token !== lock.holder.token
  })
  if (foreign.length) {
    throw new RetainedStoreError(
      "unclean",
      `Retained storage ${lock.directory} holds another writer's temporary files (${foreign.join(", ")}); ` +
        "recover that writer's lock or inspect and remove them first",
      lock.directory,
    )
  }
}

/** Verify a row against the files in its directory: the stored digest, and the decoded digest. */
function verifyRow(directory: string, row: RetainedRow): void {
  const expectedStored = row.codec === "zstd" ? `${row.storedSha256}.xwd.zst` : `${row.sha256}.xwd.gz`
  if (row.stored !== expectedStored || row.name !== `${row.sha256}.xwd`) {
    throw new RetainedStoreError(
      "receipt",
      `Retained row for ${row.name} names ${row.stored}, not ${expectedStored}`,
      row.name,
    )
  }
  const stored = readRegular(directory, row.stored)
  if (stored === undefined) {
    throw new RetainedStoreError(
      "missing",
      `Retained stored artifact missing: ${join(directory, row.stored)}`,
      row.name,
    )
  }
  if (digest(stored) !== row.storedSha256) {
    throw new RetainedStoreError(
      "integrity",
      `Retained stored artifact SHA256 differs: ${join(directory, row.stored)}`,
      row.name,
    )
  }
  if (digest(decodeStored(row, stored, join(directory, row.stored))) !== row.sha256) {
    throw new RetainedStoreError(
      "integrity",
      `Retained stored artifact decodes to different bytes: ${row.name}`,
      row.name,
    )
  }
}

/**
 * The only receipt writer. Under the directory's held lock it re-reads and validates the current
 * receipt, withdraws only the named rows (each original must be present with its declared digest
 * first), adds only verified rows, keeps every unrelated row byte-equal, and accepts an identical
 * existing row as an idempotent retry; a different mapping for the same name refuses. The next receipt
 * is written to an exclusive temporary file, fsynced, renamed over the receipt, the directory fsynced,
 * and read back.
 */
export function writeRetainedReceipt(
  lock: RetainedLock,
  change: { add?: readonly RetainedRow[]; remove?: readonly string[] },
): RetainedRow[] {
  assertLockHeld(lock)
  const directory = lock.directory
  const receipt = join(directory, RETAINED_RECEIPT)
  const currentBytes = readRegular(directory, RETAINED_RECEIPT)
  const rows = new Map(
    (currentBytes === undefined ? [] : parseReceipt(currentBytes.toString("utf8"), receipt)).map((row) => [
      row.name,
      row,
    ]),
  )
  for (const name of change.remove ?? []) {
    const row = rows.get(name)
    if (row === undefined) {
      throw new RetainedStoreError("conflict", `Retained receipt has no row ${name} to withdraw`, name)
    }
    // A gzip row's original is its legacy `.xwd.gz`; every other row's is the restored raw file.
    const original = readRegular(directory, row.codec === "gzip" ? row.stored : name)
    if (original === undefined || digest(original) !== (row.codec === "gzip" ? row.storedSha256 : row.sha256)) {
      throw new RetainedStoreError(
        "integrity",
        `Retained row ${name} is withdrawn only after its original is restored`,
        name,
      )
    }
    rows.delete(name)
  }
  for (const candidate of change.add ?? []) {
    const [row] = parseReceipt(serializeReceipt([candidate]), "added row")
    if (row === undefined) throw new RetainedStoreError("receipt", "Retained receipt addition is empty")
    const prior = rows.get(row.name)
    if (prior !== undefined) {
      if (serializeReceipt([prior]) !== serializeReceipt([row])) {
        throw new RetainedStoreError("conflict", `Retained receipt already maps ${row.name} differently`, row.name)
      }
      continue
    }
    verifyRow(directory, row)
    rows.set(row.name, row)
  }
  const text = serializeReceipt(rows.values())
  if (currentBytes?.toString("utf8") === text) return [...rows.values()]
  const temp = join(directory, tempName(RETAINED_RECEIPT, lock.holder.token))
  writeDurableNew(temp, Buffer.from(text))
  renameSync(temp, receipt)
  fsyncDirectory(directory)
  if (readFileSync(receipt, "utf8") !== text) {
    throw new RetainedStoreError("conflict", `Retained receipt read back differs: ${receipt}`, receipt)
  }
  return [...rows.values()]
}

export interface RetainedMigration {
  directory: string
  /** Originals encoded to a new file this run. */
  encoded: number
  /** Originals whose encoded file already existed and was verified byte-equal. */
  reused: number
  /** Legacy `.xwd.gz` files mapped after a verified decode to a declared digest. */
  gzipRows: number
  /** Originals unlinked after their row was durable and revalidated. */
  unlinked: number
  /** Allocated bytes of the unlinked originals, and of the encoded files that now serve them. */
  originalAllocated: number
  encodedAllocated: number
  /** Legacy files left unmapped, each with its reason. */
  skipped: string[]
}

const RAW_XWD = /^([0-9a-f]{64})\.xwd$/
const LEGACY_GZIP = /^([0-9a-f]{64})\.xwd\.gz$/

/**
 * Migrate one retained artifact directory: encode each `<sha>.xwd` original with the capture encoder,
 * publish its rows in one receipt write, then unlink each original after revalidating its bytes, its
 * stored file and the committed row. A legacy `<sha>.xwd.gz` is mapped only when `declaredGzip` names
 * its digest (a real reference declares it) and it decodes to exactly that digest. A restart after an
 * interruption repeats the same steps: present encoded files are reused only after verification, and a
 * committed row's original is revalidated before it is unlinked.
 */
export function migrateRetained(
  directory: string,
  options: { declaredGzip?: ReadonlySet<string>; keepOriginals?: boolean } = {},
): RetainedMigration {
  const lock = lockRetained(directory)
  try {
    return migrateLocked(lock, options)
  } finally {
    lock.release()
  }
}

function migrateLocked(
  lock: RetainedLock,
  options: { declaredGzip?: ReadonlySet<string>; keepOriginals?: boolean },
): RetainedMigration {
  refuseForeignTemps(lock)
  const directory = lock.directory
  const report: RetainedMigration = {
    directory,
    encoded: 0,
    reused: 0,
    gzipRows: 0,
    unlinked: 0,
    originalAllocated: 0,
    encodedAllocated: 0,
    skipped: [],
  }
  const mapped = new Set(readReceiptRows(directory).map((row) => row.name))
  const entries = readdirSync(directory).sort()
  const present = new Set(entries)
  const additions: RetainedRow[] = []
  for (const name of entries) {
    const raw = RAW_XWD.exec(name)
    if (raw?.[1] !== undefined) {
      if (mapped.has(name)) continue
      const bytes = readRegular(directory, name)
      if (bytes === undefined) {
        throw new RetainedStoreError("missing", `Retained original vanished during migration: ${name}`, name)
      }
      if (digest(bytes) !== raw[1]) {
        throw new RetainedStoreError(
          "integrity",
          `Retained original does not hash to its name: ${join(directory, name)}`,
          name,
        )
      }
      const stored = retainedSource({ bytes, format: "xwd" }).bytes
      const storedSha256 = digest(stored)
      const storedName = `${storedSha256}.xwd.zst`
      const outcome = publishNoClobber(directory, storedName, stored, lock.holder.token)
      if (!zstdDecompressSync(readFileSync(join(directory, storedName))).equals(bytes)) {
        throw new RetainedStoreError("integrity", `Encoded file does not decode to its original: ${storedName}`, name)
      }
      additions.push({ name, sha256: raw[1], stored: storedName, storedSha256, codec: "zstd" })
      report[outcome === "written" ? "encoded" : "reused"]++
      continue
    }
    const legacy = LEGACY_GZIP.exec(name)
    if (legacy?.[1] !== undefined) {
      const rawName = `${legacy[1]}.xwd`
      if (mapped.has(rawName) || present.has(rawName)) continue
      if (!options.declaredGzip?.has(legacy[1])) {
        report.skipped.push(`${name}: no reference declares ${legacy[1]}`)
        continue
      }
      const stored = readRegular(directory, name)
      if (stored === undefined) {
        throw new RetainedStoreError("missing", `Legacy file vanished during migration: ${name}`, name)
      }
      const row: RetainedRow = {
        name: rawName,
        sha256: legacy[1],
        stored: name,
        storedSha256: digest(stored),
        codec: "gzip",
      }
      if (digest(decodeStored(row, stored, name)) !== legacy[1]) {
        throw new RetainedStoreError(
          "integrity",
          `Legacy file does not decode to its declared digest: ${join(directory, name)}`,
          name,
        )
      }
      additions.push(row)
      report.gzipRows++
    }
  }
  if (additions.length) {
    fsyncDirectory(directory)
    writeRetainedReceipt(lock, { add: additions })
  }
  if (options.keepOriginals) return report
  let unlinked = false
  for (const row of readReceiptRows(directory)) {
    if (row.codec !== "zstd") continue
    const originalPath = join(directory, row.name)
    const stat = lstatIfPresent(originalPath)
    if (stat === undefined) continue
    const original = readRegular(directory, row.name)
    if (original === undefined || digest(original) !== row.sha256) {
      throw new RetainedStoreError(
        "integrity",
        `Retained original differs from its committed row: ${originalPath}`,
        row.name,
      )
    }
    const stored = readRegular(directory, row.stored)
    if (
      stored === undefined ||
      digest(stored) !== row.storedSha256 ||
      !decodeStored(row, stored, row.stored).equals(original)
    ) {
      throw new RetainedStoreError(
        "integrity",
        `Committed row for ${row.name} no longer verifies; original kept`,
        row.name,
      )
    }
    report.originalAllocated += stat.blocks * 512
    report.encodedAllocated += lstatSync(join(directory, row.stored)).blocks * 512
    unlinkSync(originalPath)
    report.unlinked++
    unlinked = true
  }
  if (unlinked) fsyncDirectory(directory)
  return report
}

/**
 * Roll back one retained artifact directory: restore and verify each mapped original durably (a legacy gzip
 * row keeps its `.xwd.gz` as the original and only verifies it), then
 * withdraw those rows in one receipt write. Encoded objects stay: a prospective `.xwd.zst` reference or
 * a reused object may still name one directly, and existing retention owns any later removal.
 */
export function rollbackRetained(
  directory: string,
  names?: readonly string[],
): { restored: number; withdrawn: number } {
  const lock = lockRetained(directory)
  try {
    refuseForeignTemps(lock)
    const rows = readReceiptRows(lock.directory)
    const selected =
      names === undefined
        ? rows
        : names.map((name) => {
            const row = rows.find((candidate) => candidate.name === name)
            if (row === undefined) {
              throw new RetainedStoreError("conflict", `Retained receipt has no row ${name} to roll back`, name)
            }
            return row
          })
    let restored = 0
    for (const row of selected) {
      const original = readRegular(lock.directory, row.name)
      if (original !== undefined) {
        if (digest(original) !== row.sha256) {
          throw new RetainedStoreError(
            "integrity",
            `Present original differs from its row: ${join(lock.directory, row.name)}`,
            row.name,
          )
        }
        continue
      }
      const stored = readRegular(lock.directory, row.stored)
      if (stored === undefined || digest(stored) !== row.storedSha256) {
        throw new RetainedStoreError(
          "integrity",
          `Stored artifact for ${row.name} does not verify; nothing restored`,
          row.name,
        )
      }
      // A gzip row maps a legacy `.xwd.gz` that was itself the historical original; no raw file ever existed.
      if (row.codec === "gzip") continue
      const bytes = decodeStored(row, stored, row.stored)
      if (digest(bytes) !== row.sha256) {
        throw new RetainedStoreError(
          "integrity",
          `Stored artifact for ${row.name} decodes to different bytes`,
          row.name,
        )
      }
      publishNoClobber(lock.directory, row.name, bytes, lock.holder.token)
      restored++
    }
    if (restored) fsyncDirectory(lock.directory)
    if (selected.length) writeRetainedReceipt(lock, { remove: selected.map((row) => row.name) })
    return { restored, withdrawn: selected.length }
  } finally {
    lock.release()
  }
}

/**
 * Transfer retained references from `sourceRoot` into `destination`, the one copy path for collected
 * runs. Every reference is resolved before anything is written; each is then resolved again and its
 * verified stored bytes are written only if they match the first pass, so a source changing mid-transfer
 * refuses instead of tearing the copy, and only one file's bytes are held at a time. Physical dependencies are
 * written (no-clobber, byte-equal reuse) inside the destination's real root, then each destination
 * directory gets only the receipt rows its references need, then every reference is re-resolved from
 * the destination alone. A failure names its reference path.
 */
export function transferRetained(sourceRoot: string, destination: string, references: readonly unknown[]): void {
  // Pass 1 proves every reference before anything is written and keeps no bytes: only the reference, the stored
  // path and its digest, and the row (a complete historical run holds ~1.1 GB). Pass 2 resolves one reference at
  // a time again, refuses if its stored bytes changed since pass 1, writes them and drops them.
  const resolved: { reference: RetainedReference; stored: { path: string; sha256: string }; row?: RetainedRow }[] = []
  const paths = new Set<string>()
  for (const reference of references) {
    const label = isRecord(reference) && typeof reference.path === "string" ? reference.path : "<invalid path>"
    try {
      const resolution = resolveRetained(sourceRoot, reference)
      if (paths.has(resolution.reference.path)) throw new Error("Duplicate retained artifact path")
      paths.add(resolution.reference.path)
      resolved.push({
        reference: resolution.reference,
        stored: { path: resolution.stored.path, sha256: digest(resolution.stored.bytes) },
        row: resolution.row,
      })
    } catch (cause) {
      throw Object.assign(new Error(`Retained transfer failed for ${label}`, { cause }), { path: label })
    }
  }
  mkdirSync(destination, { recursive: true })
  const root = realpathSync(destination)
  const rowsByDirectory = new Map<string, Map<string, RetainedRow>>()
  const written = new Map<string, string>()
  const token = randomBytes(8).toString("hex")
  for (const resolution of resolved) {
    const label = resolution.reference.path
    try {
      let parent = root
      for (const part of resolution.stored.path.split("/").slice(0, -1)) {
        parent = join(parent, part)
        try {
          mkdirSync(parent)
        } catch (error) {
          if (errnoCode(error) !== "EEXIST") throw error
        }
        if (!within(root, realpathSync(parent))) throw new Error("Destination parent escapes capture bundle")
      }
      const target = join(root, resolution.stored.path)
      const prior = written.get(target)
      const storedDigest = resolution.stored.sha256
      if (prior === undefined) {
        const again = resolveRetained(sourceRoot, resolution.reference)
        if (again.stored.path !== resolution.stored.path || digest(again.stored.bytes) !== storedDigest) {
          throw new Error(`Source changed during transfer at ${resolution.stored.path}`)
        }
        // Exclusive temporary, then a no-clobber link: a crash never leaves a truncated final file.
        publishNoClobber(parent, basename(target), again.stored.bytes, token)
        written.set(target, storedDigest)
      } else if (prior !== storedDigest) {
        throw new Error(`Two references need different bytes at ${resolution.stored.path}`)
      }
      if (resolution.row !== undefined) {
        const rows = rowsByDirectory.get(realpathSync(parent)) ?? new Map<string, RetainedRow>()
        rows.set(resolution.row.name, resolution.row)
        rowsByDirectory.set(realpathSync(parent), rows)
      }
    } catch (cause) {
      throw Object.assign(new Error(`Retained transfer failed for ${label}`, { cause }), { path: label })
    }
  }
  for (const directory of new Set([...written.keys()].map((path) => dirname(path)))) fsyncDirectory(directory)
  for (const [directory, rows] of rowsByDirectory) {
    const lock = lockRetained(directory)
    try {
      writeRetainedReceipt(lock, { add: [...rows.values()] })
    } finally {
      lock.release()
    }
  }
  for (const resolution of resolved) {
    try {
      resolveRetained(root, resolution.reference)
    } catch (cause) {
      throw Object.assign(new Error(`Retained transfer failed for ${resolution.reference.path}`, { cause }), {
        path: resolution.reference.path,
      })
    }
  }
}
