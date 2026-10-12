import { randomBytes } from "node:crypto"
import { mkdirSync, readFileSync, unlinkSync } from "node:fs"
import { join } from "node:path"
import { capturePixels, command, decodeCapture, finishCapture, type NamedTextOrigin } from "./capture-core.ts"
import type { ProbeCapture } from "./probes/unified.ts"

export interface DarwinWindow {
  id: number
  ownerPid: number
  layer: number
  bounds: { x: number; y: number; width: number; height: number }
}

export function selectDarwinWindow(rows: unknown, appPid: number): DarwinWindow {
  if (!Number.isSafeInteger(appPid) || appPid < 2 || !Array.isArray(rows)) {
    throw new Error("Darwin owned window census requires a measured app PID and window list")
  }
  const windows: DarwinWindow[] = rows.map((row: unknown) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      throw new Error("Darwin owned window census contains a non-object row")
    }
    const value = row as Record<string, unknown>
    const bounds = value.bounds
    if (!bounds || typeof bounds !== "object" || Array.isArray(bounds)) {
      throw new Error("Darwin owned window census row lacks point bounds")
    }
    const box = bounds as Record<string, unknown>
    if (
      typeof value.id !== "number" ||
      typeof value.ownerPid !== "number" ||
      typeof value.layer !== "number" ||
      typeof box.x !== "number" ||
      typeof box.y !== "number" ||
      typeof box.width !== "number" ||
      typeof box.height !== "number"
    ) {
      throw new Error("Darwin owned window census contains malformed identity or point bounds")
    }
    return {
      id: value.id,
      ownerPid: value.ownerPid,
      layer: value.layer,
      bounds: { x: box.x, y: box.y, width: box.width, height: box.height },
    }
  })
  const owned = windows.filter((row) => row.ownerPid === appPid && row.layer === 0)
  if (owned.length !== 1) {
    throw new Error(
      `Darwin capture requires exactly one owned visible window for app PID ${appPid}; found ${owned.length}`,
    )
  }
  const window = owned[0]
  if (!window) throw new Error("Darwin owned window census lost its selected window")
  if (
    !Number.isSafeInteger(window.id) ||
    window.id < 1 ||
    !window.bounds ||
    ![window.bounds.x, window.bounds.y, window.bounds.width, window.bounds.height].every(Number.isFinite) ||
    !Number.isSafeInteger(window.bounds.width) ||
    !Number.isSafeInteger(window.bounds.height) ||
    window.bounds.width < 1 ||
    window.bounds.height < 1
  ) {
    throw new Error(`Darwin owned window has invalid point bounds: ${JSON.stringify(window)}`)
  }
  return window
}

export function requireDarwinScale(window: DarwinWindow, pixels: { width: number; height: number }): void {
  if (pixels.width !== window.bounds.width || pixels.height !== window.bounds.height) {
    throw new Error(
      `Darwin capture requires scale 1: capture ${pixels.width}x${pixels.height} differs from window point bounds ${window.bounds.width}x${window.bounds.height}`,
    )
  }
}

const CENSUS = `ObjC.import('CoreGraphics'); ObjC.import('Foundation');
function value(dict, key) { var ref = dict.objectForKey(key); return ref ? ref.js : null; }
function bounds(dict) {
  var b = dict.objectForKey('kCGWindowBounds');
  if (!b) return null;
  function n(k) { var v = b.objectForKey(k); return v ? Number(v.js) : null; }
  return { x: n('X'), y: n('Y'), width: n('Width'), height: n('Height') };
}
var raw = $.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly | $.kCGWindowListExcludeDesktopElements, $.kCGNullWindowID);
if (!raw) throw new Error('CGWindowListCopyWindowInfo returned null');
var rows = [], count = $.CFArrayGetCount(raw);
for (var i = 0; i < count; i++) {
  var w = ObjC.castRefToObject($.CFArrayGetValueAtIndex(raw, i));
  rows.push({ id: value(w, 'kCGWindowNumber'), ownerPid: value(w, 'kCGWindowOwnerPID'), layer: value(w, 'kCGWindowLayer'), bounds: bounds(w) });
}
JSON.stringify(rows);`

/** One screenshot per request. Paint currency belongs to the collector's witness, not this adapter. */
export async function createDarwinCapture(directory: string, { appPid }: { appPid: number }) {
  const census = async (deadline?: number) =>
    selectDarwinWindow(
      JSON.parse(
        (await command("/usr/bin/osascript", ["-l", "JavaScript", "-e", CENSUS], undefined, deadline)).toString(),
      ),
      appPid,
    )
  const window = await census()
  await command("magick", ["-version"])
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const assertOwned = async (deadline?: number) => {
    const current = await census(deadline)
    if (JSON.stringify(current) !== JSON.stringify(window)) {
      throw new Error(`Darwin owned window ${window.id} identity or bounds changed during capture`)
    }
  }
  const acquire = async (deadline?: number) => {
    await assertOwned(deadline)
    const path = join(directory, `.capture-${randomBytes(16).toString("hex")}.png`)
    const file = "/usr/sbin/screencapture"
    const args = ["-l", String(window.id), "-o", "-x", "-t", "png", path]
    let stdout: Buffer | undefined
    let stderr: Buffer = Buffer.alloc(0)
    let bytes: Buffer
    try {
      stdout = await command(file, args, undefined, deadline, (output) => {
        stderr = output
      })
      bytes = readFileSync(path)
    } catch (cause) {
      const underlying =
        cause instanceof Error ? { name: cause.name, message: cause.message } : { message: String(cause) }
      const error = new Error(
        `Darwin screenshot capture failed: ${JSON.stringify({ file, args, outputPath: path, stdout: stdout?.toString() ?? null, stdoutBase64: stdout?.toString("base64") ?? null, stderr: stderr.toString(), stderrBase64: stderr.toString("base64"), cause: underlying })}`,
        { cause },
      )
      error.name = stdout === undefined ? "DarwinCaptureCommandFailed" : "DarwinCaptureOutputMissing"
      throw error
    } finally {
      try {
        unlinkSync(path)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      }
    }
    const capturedAt = Date.now()
    await assertOwned(deadline)
    const pixels = capturePixels(
      (await command("magick", ["png:-", "-format", "%wx%h", "info:"], bytes, deadline)).toString(),
    )
    requireDarwinScale(window, pixels)
    return { bytes, format: "png" as const, ...pixels, capturedAt }
  }
  const trace = {
    platform: "darwin",
    window,
    measuredAppPid: appPid,
    scale: 1,
    captureCommand: ["/usr/sbin/screencapture", "-l", String(window.id), "-o", "-x", "-t", "png"],
  }
  const capture = async (checkpoint: Parameters<ProbeCapture>[0], origin: NamedTextOrigin) => {
    const source = await acquire()
    return finishCapture({ directory, checkpoint, source, png: source.bytes, origin, trace })
  }
  const captureRaw = async (checkpoint: Parameters<ProbeCapture>[0], deadline?: number) => {
    const source = await acquire(deadline)
    const decoded = await decodeCapture({ source, featureId: checkpoint.featureId, deadline })
    const result = await finishCapture({
      directory,
      checkpoint: { ...checkpoint, cells: undefined, pixelGeometry: undefined },
      source,
      png: source.bytes,
      origin: () => {
        throw new Error("Darwin calibration raw capture cannot map cells before a named origin")
      },
      trace,
    })
    return { decoded, result }
  }
  return { capture, captureRaw }
}
