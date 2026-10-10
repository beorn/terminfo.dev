import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { ProbeCapture } from "./probes/unified.ts"

export interface LiveExecutable {
  path: string
  sha256: string
}

/** Bind a launched process to the same actual ELF bytes recorded by the launcher. */
export function assertLiveExecutable(pid: number, expected: LiveExecutable): void {
  if (
    !Number.isSafeInteger(pid) ||
    pid < 2 ||
    !expected.path.startsWith("/") ||
    !/^[0-9a-f]{64}$/.test(expected.sha256)
  ) {
    throw new Error("Invalid measured executable identity")
  }
  const path = realpathSync(`/proc/${pid}/exe`)
  if (path !== expected.path) throw new Error(`Live executable path mismatch for PID ${pid}: ${path}`)
  if (digest(readFileSync(`/proc/${pid}/exe`)) !== expected.sha256) {
    throw new Error(`Live executable digest mismatch for PID ${pid}`)
  }
}

export function command(file: string, args: string[], input?: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let stdinError: Error | undefined
    const child = execFile(
      file,
      args,
      { encoding: "buffer", timeout: 10_000, maxBuffer: 32 * 1024 * 1024 },
      (error, stdout) => {
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

function retain(directory: string, bytes: Buffer, extension: string): string {
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

/** One cell-aligned rectangle in the captured window's own pixels. */
export interface CaptureRectangle {
  x: number
  y: number
  width: number
  height: number
}

/**
 * Map a cell-aligned region to an absolute rectangle from the terminal's OWN pixel report plus the
 * window's measured geometry, and from nothing else: a window width divided by a column count is a
 * guess, and this rectangle decides pixels. A rectangle that leaves the window is a loud error, not
 * a clipped crop, because a clipped crop would silently compare the wrong cells.
 */
export function cellRectangle(input: {
  cells: { top: number; left: number; bottom: number; right: number }
  pixelGeometry: { cellWidth: number; cellHeight: number; textWidth: number; textHeight: number }
  windowWidth: number
  windowHeight: number
}): CaptureRectangle {
  const { cells, pixelGeometry: geometry, windowWidth, windowHeight } = input
  const numbers = [
    cells.top,
    cells.left,
    cells.bottom,
    cells.right,
    geometry.cellWidth,
    geometry.cellHeight,
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
  // The text area sits inside the window; its offsets are whatever the window has left over.
  const textLeft = Math.round((windowWidth - geometry.textWidth) / 2)
  const textTop = Math.round((windowHeight - geometry.textHeight) / 2)
  const rectangle: CaptureRectangle = {
    x: textLeft + (cells.left - 1) * geometry.cellWidth,
    y: textTop + (cells.top - 1) * geometry.cellHeight,
    width: (cells.right - cells.left + 1) * geometry.cellWidth,
    height: (cells.bottom - cells.top + 1) * geometry.cellHeight,
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

/** The window's own pixel size, parsed from xdotool getwindowgeometry --shell. */
export function windowPixels(geometry: string): { width: number; height: number } {
  const width = /^WIDTH=(\d+)$/m.exec(geometry)?.[1]
  const height = /^HEIGHT=(\d+)$/m.exec(geometry)?.[1]
  const parsed = { width: Number(width), height: Number(height) }
  if (
    !Number.isSafeInteger(parsed.width) ||
    !Number.isSafeInteger(parsed.height) ||
    parsed.width < 1 ||
    parsed.height < 1
  ) {
    throw new Error(`Cannot read the captured window's pixel size out of ${JSON.stringify(geometry)}`)
  }
  return parsed
}

/** Resolve the actual terminal ancestor, never a class label or newest window. */
export function kittyAncestor(executable: LiveExecutable): number {
  let pid = process.pid
  for (let depth = 0; depth < 64 && pid > 1; depth++) {
    const path = realpathSync(`/proc/${pid}/exe`)
    if (path === executable.path) {
      assertLiveExecutable(pid, executable)
      return pid
    }
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8")
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ")
    const parent = Number(fields[1])
    if (!Number.isSafeInteger(parent) || parent < 1 || parent === pid) {
      throw new Error(`Cannot resolve terminal parent of collector PID ${pid}`)
    }
    pid = parent
  }
  throw new Error(`Collector PID ${process.pid} has no ancestor running ${executable.path}`)
}

/** Optional Linux adapter. Once configured, every ownership/capture failure is loud. */
export async function createLinuxCapture(directory: string, executable: LiveExecutable): Promise<ProbeCapture> {
  if (process.platform !== "linux" || !process.env.DISPLAY) {
    throw new Error("Linux capture requires Linux and the owned DISPLAY")
  }
  const kittyPid = kittyAncestor(executable)
  const windows = (await command("xdotool", ["search", "--onlyvisible", "--pid", String(kittyPid)]))
    .toString()
    .trim()
    .split(/\s+/)
    .filter(Boolean)
  const windowId = windows[0]
  if (windows.length !== 1 || !windowId || !/^\d+$/.test(windowId)) {
    throw new Error(`Collector's Kitty PID ${kittyPid} owns ${windows.length} visible windows; expected one`)
  }
  const ownedWindowId = windowId
  const display = (await command("xdpyinfo", [])).toString()
  const rootLines = display.split("\n").filter((line) => /root window id:/.test(line))
  const roots = rootLines.map((line) => {
    const match = /^\s*root window id:\s*0x([0-9a-fA-F]+)\s*$/.exec(line)
    const rootId = match?.[1]
    return rootId === undefined ? NaN : Number.parseInt(rootId, 16)
  })
  if (roots.length === 0 || roots.some((root) => !Number.isSafeInteger(root))) {
    throw new Error("Cannot identify DISPLAY root windows for capture")
  }
  async function assertOwned() {
    if (kittyAncestor(executable) !== kittyPid) throw new Error("Collector terminal process changed during capture")
    const owner = (await command("xdotool", ["getwindowpid", ownedWindowId])).toString().trim()
    if (owner !== String(kittyPid)) throw new Error(`Capture window ${windowId} no longer belongs to Kitty ${kittyPid}`)
    const visible = (await command("xdotool", ["search", "--onlyvisible", "--maxdepth", "1", "--name", ".*"]))
      .toString()
      .trim()
      .split(/\s+/)
    if (visible.some((id) => !/^\d+$/.test(id) || !Number.isSafeInteger(Number(id)))) {
      throw new Error("Invalid visible top-level window census for capture")
    }
    const topLevel = visible.filter((id) => !roots.includes(Number(id)))
    if (topLevel.length !== 1 || topLevel[0] !== ownedWindowId) {
      throw new Error(`Capture requires only its owned visible top-level window; found ${topLevel.join(", ")}`)
    }
  }
  await assertOwned()
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const converter = (await command("magick", ["-version"])).toString().trim()
  const geometry = (await command("xdotool", ["getwindowgeometry", "--shell", windowId])).toString()
  const rawCommand = ["xwd:-", "-depth", "8", "rgba:-"]
  return async ({ featureId, role, label, cells, pixelGeometry }) => {
    // Static-frame settling is recorded; callbacks own any temporal schedule.
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 150)
    })
    await assertOwned()
    const before = (await command("xdotool", ["getwindowgeometry", "--shell", windowId])).toString()
    if (before !== geometry) throw new Error(`Capture window ${windowId} geometry changed during ${featureId}`)
    const original = await command("xwd", ["-id", windowId, "-silent"])
    const capturedAt = Date.now()
    const png = await command("magick", ["xwd:-", "png:-"], original)
    if (!png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
      throw new Error(`Capture conversion did not produce PNG bytes for ${featureId}`)
    }
    await assertOwned()
    const after = (await command("xdotool", ["getwindowgeometry", "--shell", windowId])).toString()
    if (after !== geometry) throw new Error(`Capture window ${windowId} geometry changed during ${featureId}`)
    const sourceRef = retain(directory, original, "xwd")
    const ref = retain(directory, png, "png")
    // The retained file names are the bare digests; a ref carries the "sha256:" scheme prefix.
    const xwdStem = sourceRef.replace(/^sha256:/, "")
    const pngStem = ref.replace(/^sha256:/, "")
    // Raw pixels at one depth and colorspace, never the encoded container: the png encoder writes a
    // date text chunk, so two identical frames differ as bytes. Taken only when cells are asked
    // for, so a request without cells is byte for byte the previous path.
    let pixelsDigest: string | undefined
    let regionDigest: string | undefined
    let regionTrace: Record<string, unknown> = {}
    if (cells !== undefined || pixelGeometry !== undefined) {
      if (cells === undefined || pixelGeometry === undefined) {
        throw new Error(
          `Capture ${featureId} was asked for a cell-aligned digest without both cells and the terminal's pixel report`,
        )
      }
      const window = windowPixels(geometry)
      const rectangle = cellRectangle({ cells, pixelGeometry, windowWidth: window.width, windowHeight: window.height })
      const rgba = await command("magick", rawCommand, original)
      const expected = window.width * window.height * 4
      if (rgba.length !== expected) {
        throw new Error(
          `Raw capture for ${featureId} is ${rgba.length} bytes; ${window.width}x${window.height} at depth 8 rgba is ${expected}`,
        )
      }
      pixelsDigest = `sha256:${digest(rgba)}`
      const cropCommand = [
        "xwd:-",
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
      regionTrace = {
        cells,
        pixelGeometry,
        rectangle,
        rawCommand: ["magick", ...rawCommand],
        cropCommand: ["magick", ...cropCommand],
        // Retained artifacts by their real names: the capture directory writes <sha256>.<ext>.
        // Both digests are over DECODED pixels, so either retained file reproduces them, and the
        // png is lossless: its date text chunk changes the container's bytes, never the pixels.
        retained: { png: `${pngStem}.png`, xwd: `${xwdStem}.xwd` },
        reproduceWhole: `magick ${pngStem}.png -depth 8 rgba:- | sha256sum`,
        reproduceRegion: `magick ${pngStem}.png -crop ${rectangle.width}x${rectangle.height}+${rectangle.x}+${rectangle.y} +repage -depth 8 rgba:- | sha256sum`,
      }
    }
    return {
      frame: {
        role,
        label,
        capturedAt,
        ref,
        sourceRef,
        ...(regionDigest !== undefined && pixelsDigest !== undefined ? { regionDigest, pixelsDigest } : {}),
      },
      trace: {
        featureId,
        collectorPid: process.pid,
        kittyPid,
        executable,
        windowId,
        geometry,
        converter,
        settleMs: 150,
        ...regionTrace,
      },
    }
  }
}
