import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, realpathSync } from "node:fs"
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

export { command, cellRectangle, capturePixels } from "./capture-core.ts"
export type { CaptureRectangle, CapturedFrame, SurfaceMeasurement, TextAreaPlacement } from "./capture-core.ts"
import {
  command,
  finishCapture,
  textAreaOrigin as placeTextArea,
  type CapturedFrame,
  type SurfaceMeasurement,
  type TextAreaPlacement,
} from "./capture-core.ts"

function digest(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex")
}

/**
 * The terminal's own drawing surface in one captured frame: the region the terminal painted, which
 * is the text area's container and nothing else.
 *
 * Why not the window. A client-side-decorated window (ghostty, wezterm) draws a title bar and a
 * border INTO its client area, so the window and the terminal's surface disagree by a title bar's
 * height. The retained ghostty 1.3.1 frame of run 5f91eb10b6 shows an 800x600 window whose reported
 * text area is 780x528, while the terminal's own pixels only start 56 down: the window-centred
 * text area lands 20 pixels too high and row 1's crop reads the blank band under the title bar
 * (#28756). A window the window manager decorates draws nothing inside its client area, its surface
 * IS the window, and this measurement is then the identity.
 *
 * The measurement needs no colour of its own: a terminal paints its own background across its whole
 * surface, so the frame's most common colour IS that background, and the surface is the run of rows
 * and columns it covers. A frame whose content hides its background — a full-screen fill — has no
 * measurable surface, and says so by name instead of guessing one.
 */
export function drawnSurface(frame: CapturedFrame): SurfaceMeasurement {
  const { width, height, rgba } = frame
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 1 ||
    height < 1 ||
    rgba.length !== width * height * 4
  ) {
    throw new Error(`A ${width}x${height} captured frame is ${width * height * 4} rgba bytes; got ${rgba.length}`)
  }
  // Read through a view, never by bare index: every byte lies inside the frame the length above
  // pins, and a read outside it is a loud RangeError rather than an undefined that would silently
  // count colour 0 as a background nobody painted.
  const pixels = new DataView(rgba.buffer, rgba.byteOffset, rgba.byteLength)
  const colourAt = (at: number) =>
    (pixels.getUint8(at) << 16) | (pixels.getUint8(at + 1) << 8) | pixels.getUint8(at + 2)
  const counts = new Map<number, number>()
  for (let index = 0; index < width * height; index++) {
    const colour = colourAt(index * 4)
    counts.set(colour, (counts.get(colour) ?? 0) + 1)
  }
  let background = -1
  let painted = 0
  for (const [colour, count] of counts) {
    if (count > painted) {
      painted = count
      background = colour
    }
  }
  // Each array is sized to the rows and columns that index it, so the `?? 0` below is the zero a
  // counter starts at, never a swallowed miss.
  const rows = new Uint32Array(height)
  const columns = new Uint32Array(width)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (colourAt((y * width + x) * 4) === background) {
        rows[y] = (rows[y] ?? 0) + 1
        columns[x] = (columns[x] ?? 0) + 1
      }
    }
  }
  let top = -1
  let bottom = -1
  for (let y = 0; y < height; y++) {
    if ((rows[y] ?? 0) * 2 > width) {
      if (top < 0) top = y
      bottom = y
    }
  }
  let left = -1
  let right = -1
  for (let x = 0; x < width; x++) {
    if ((columns[x] ?? 0) * 2 > height) {
      if (left < 0) left = x
      right = x
    }
  }
  if (top < 0 || left < 0) {
    return {
      surface: null,
      basis: `no one colour covers half of any row and column of the ${width}x${height} frame`,
    }
  }
  return {
    surface: { x: left, y: top, width: right - left + 1, height: bottom - top + 1 },
    basis: `the ${width}x${height} frame's most common colour covers rows ${top}..${bottom} and columns ${left}..${right}`,
  }
}

/** Preserve Linux's measured-colour placement; the shared core receives its named basis. */
export function textAreaOrigin(input: {
  frame: CapturedFrame
  pixelGeometry: { textWidth: number; textHeight: number }
}): TextAreaPlacement {
  return placeTextArea({ ...input, measurement: drawnSurface(input.frame) })
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

/** The DISPLAY screen's pixel size, parsed from xdpyinfo. */
export function screenPixels(display: string): { width: number; height: number } {
  const match = /dimensions:\s+(\d+)x(\d+)\s+pixels/.exec(display)
  const parsed = { width: Number(match?.[1]), height: Number(match?.[2]) }
  if (
    !Number.isSafeInteger(parsed.width) ||
    !Number.isSafeInteger(parsed.height) ||
    parsed.width < 1 ||
    parsed.height < 1
  ) {
    throw new Error(`Cannot read the DISPLAY screen's pixel size out of ${JSON.stringify(display)}`)
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
  const window = windowPixels(geometry)
  const screen = screenPixels(display)
  if (window.width > screen.width || window.height > screen.height) {
    throw new Error(`window ${window.width}x${window.height} exceeds the ${screen.width}x${screen.height} screen`)
  }
  return async ({ featureId, role, label, cells, pixelGeometry }) => {
    // Static-frame settling is recorded; callbacks own any temporal schedule.
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 150)
    })
    await assertOwned()
    const before = (await command("xdotool", ["getwindowgeometry", "--shell", windowId])).toString()
    if (before !== geometry) throw new Error(`Capture window ${windowId} geometry changed during ${featureId}`)
    const original = await command("xwd", ["-id", windowId, "-nobdrs", "-silent"])
    const capturedAt = Date.now()
    const png = await command("magick", ["xwd:-", "png:-"], original)
    if (!png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
      throw new Error(`Capture conversion did not produce PNG bytes for ${featureId}`)
    }
    await assertOwned()
    const after = (await command("xdotool", ["getwindowgeometry", "--shell", windowId])).toString()
    if (after !== geometry) throw new Error(`Capture window ${windowId} geometry changed during ${featureId}`)
    return finishCapture({
      directory,
      checkpoint: { featureId, role, label, cells, pixelGeometry },
      source: { bytes: original, format: "xwd", width: window.width, height: window.height, capturedAt },
      png,
      origin: ({ frame, pixelGeometry }) => textAreaOrigin({ frame, pixelGeometry }),
      trace: {
        featureId,
        collectorPid: process.pid,
        kittyPid,
        executable,
        windowId,
        geometry,
        converter,
        settleMs: 150,
      },
    })
  }
}
