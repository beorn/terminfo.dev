import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, realpathSync } from "node:fs"
import { mkdtemp, readFile, rm } from "node:fs/promises"
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

import { command, decodeCapture, finishCapture, type NamedTextOrigin } from "./capture-core.ts"

function digest(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex")
}

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

function withWindowPixels(geometry: string, width: number, height: number): string {
  windowPixels(geometry)
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) {
    throw new Error(`Declared window resize requires positive integer pixels; got ${width}x${height}`)
  }
  return geometry.replace(/^WIDTH=\d+$/m, `WIDTH=${width}`).replace(/^HEIGHT=\d+$/m, `HEIGHT=${height}`)
}

function describeWindowGeometry(geometry: string): string {
  const width = /^WIDTH=(\d+)$/m.exec(geometry)?.[1]
  const height = /^HEIGHT=(\d+)$/m.exec(geometry)?.[1]
  const x = /^X=(-?\d+)$/m.exec(geometry)?.[1]
  const y = /^Y=(-?\d+)$/m.exec(geometry)?.[1]
  if (width !== undefined && height !== undefined && x !== undefined && y !== undefined) {
    return `${width}x${height} at ${x},${y}`
  }
  return JSON.stringify(geometry)
}

function geometryChangedError(windowId: string, featureId: string, declared: string, observed: string): Error {
  const declaredSummary = describeWindowGeometry(declared)
  const observedSummary = describeWindowGeometry(observed)
  const detail =
    declaredSummary === observedSummary
      ? `declared ${JSON.stringify(declared)}, observed ${JSON.stringify(observed)}`
      : `declared ${declaredSummary}, observed ${observedSummary}`
  return new Error(`Capture window ${windowId} geometry changed during ${featureId}: ${detail}`)
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
/**
 * The fixed wait before every Linux capture reads the screen (static-frame settling). Exported so a
 * probe can state what this collector cannot see: an update held for less than this is never read
 * (#33032, @cto e9641d54).
 */
export const LINUX_CAPTURE_SETTLE_MS = 150

export async function createLinuxCapture(
  directory: string,
  executable: LiveExecutable,
  onRetained: Parameters<typeof finishCapture>[0]["onRetained"],
) {
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
  async function assertOwned(deadline?: number) {
    if (kittyAncestor(executable) !== kittyPid) throw new Error("Collector terminal process changed during capture")
    const owner = (await command("xdotool", ["getwindowpid", ownedWindowId], undefined, deadline)).toString().trim()
    if (owner !== String(kittyPid)) throw new Error(`Capture window ${windowId} no longer belongs to Kitty ${kittyPid}`)
    const visible = (
      await command("xdotool", ["search", "--onlyvisible", "--maxdepth", "1", "--name", ".*"], undefined, deadline)
    )
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
  const startupGeometry = (await command("xdotool", ["getwindowgeometry", "--shell", windowId])).toString()
  const startupWindow = windowPixels(startupGeometry)
  const screen = screenPixels(display)
  if (startupWindow.width > screen.width || startupWindow.height > screen.height) {
    throw new Error(
      `window ${startupWindow.width}x${startupWindow.height} exceeds the ${screen.width}x${screen.height} screen`,
    )
  }
  let declaredGeometry = startupGeometry
  let declaredByFeatureId: string | undefined
  const declareWindowSize = (width: number, height: number, featureId: string): void => {
    if (typeof featureId !== "string" || featureId.trim().length === 0) {
      throw new Error("Declared window resize requires the owning featureId")
    }
    if (declaredByFeatureId !== undefined && declaredByFeatureId !== featureId) {
      throw new Error(
        `Capture window ${windowId} left resized by ${declaredByFeatureId} (${describeWindowGeometry(declaredGeometry)}, startup ${describeWindowGeometry(startupGeometry)}) during ${featureId}`,
      )
    }
    const nextGeometry = withWindowPixels(startupGeometry, width, height)
    if (width > screen.width || height > screen.height) {
      throw new Error(`window ${width}x${height} exceeds the ${screen.width}x${screen.height} screen`)
    }
    declaredGeometry = nextGeometry
    declaredByFeatureId = nextGeometry === startupGeometry ? undefined : featureId
  }
  const acquire = async (featureId: string, deadline?: number) => {
    const expectedGeometry = declaredGeometry
    const expectedFeatureId = declaredByFeatureId
    if (expectedGeometry !== startupGeometry && featureId !== expectedFeatureId) {
      throw new Error(
        `Capture window ${windowId} left resized by ${String(expectedFeatureId)} (${describeWindowGeometry(expectedGeometry)}, startup ${describeWindowGeometry(startupGeometry)}) during ${featureId}`,
      )
    }
    // Static-frame settling is recorded; callbacks own any temporal schedule.
    await new Promise<void>((resolve) => {
      setTimeout(resolve, LINUX_CAPTURE_SETTLE_MS)
    })
    await assertOwned(deadline)
    const before = (
      await command("xdotool", ["getwindowgeometry", "--shell", windowId], undefined, deadline)
    ).toString()
    if (before !== expectedGeometry) throw geometryChangedError(windowId, featureId, expectedGeometry, before)
    const observedWindow = windowPixels(before)
    if (observedWindow.width > screen.width || observedWindow.height > screen.height) {
      throw new Error(
        `window ${observedWindow.width}x${observedWindow.height} exceeds the ${screen.width}x${screen.height} screen`,
      )
    }
    const pointerImage = featureId === "extensions.osc22-pointer"
    let original: Buffer
    if (pointerImage) {
      // scrot's "-" output reopens /dev/stdout, which cannot reopen the spawn pipe.
      const temporary = await mkdtemp(join(directory, ".osc22-"))
      try {
        const output = join(temporary, "pointer.png")
        await command(
          "scrot",
          ["--pointer", "--window", windowId, "--silent", "--format", "png", "--file", output],
          undefined,
          deadline,
        )
        original = await readFile(output)
      } finally {
        await rm(temporary, { recursive: true, force: true })
      }
    } else {
      original = await command("xwd", ["-id", windowId, "-nobdrs", "-silent"], undefined, deadline)
    }
    const capturedAt = Date.now()
    const png = await command(
      "magick",
      pointerImage ? ["png:-", ...PNG_CONVERSION_ARGS.slice(1)] : [...PNG_CONVERSION_ARGS],
      original,
      deadline,
    )
    if (!png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
      throw new Error(`Capture conversion did not produce PNG bytes for ${featureId}`)
    }
    await assertOwned(deadline)
    const after = (await command("xdotool", ["getwindowgeometry", "--shell", windowId], undefined, deadline)).toString()
    if (after !== expectedGeometry) throw geometryChangedError(windowId, featureId, expectedGeometry, after)
    if (declaredGeometry !== expectedGeometry) {
      throw geometryChangedError(windowId, featureId, expectedGeometry, declaredGeometry)
    }
    return {
      source: {
        bytes: original,
        format: pointerImage ? ("png" as const) : ("xwd" as const),
        width: observedWindow.width,
        height: observedWindow.height,
        capturedAt,
      },
      png,
      trace: {
        featureId,
        collectorPid: process.pid,
        kittyPid,
        executable,
        windowId,
        geometry: before,
        converter,
        settleMs: 150,
      },
    }
  }
  const capture = async (checkpoint: Parameters<ProbeCapture>[0], origin: NamedTextOrigin) => {
    const acquired = await acquire(checkpoint.featureId)
    return finishCapture({ directory, onRetained, checkpoint, ...acquired, origin })
  }
  const captureRaw = async (checkpoint: Parameters<ProbeCapture>[0], deadline?: number) => {
    const acquired = await acquire(checkpoint.featureId, deadline)
    const decoded = await decodeCapture({ source: acquired.source, featureId: checkpoint.featureId, deadline })
    const result = await finishCapture({
      directory,
      onRetained,
      checkpoint: { ...checkpoint, cells: undefined, controlCells: undefined, pixelGeometry: undefined },
      ...acquired,
      decoded,
      deadline,
      origin: () => {
        throw new Error("Linux calibration raw capture cannot map cells before a named origin")
      },
    })
    return { decoded, result }
  }
  return { capture, captureRaw, declareWindowSize, settleMs: LINUX_CAPTURE_SETTLE_MS }
}
