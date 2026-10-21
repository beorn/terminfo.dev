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

/** A census row's visibility fields; absent in a row that predates the all-windows census. */
interface DarwinCensusRow {
  window: DarwinWindow
  alpha: number | null
  onscreen: boolean | null
}

const SCREENCAPTURE = "/usr/sbin/screencapture"
const WINDOW_IMAGE_REFUSAL = "could not create image from window"

/**
 * Select the app's one visible window: owned by `appPid`, layer 0, onscreen and not fully transparent.
 * An app that keeps several such windows (cmux keeps two or three, 30390) measures its largest; two
 * sharing the largest area are indistinguishable and refuse.
 */
export function selectDarwinWindow(rows: unknown, appPid: number): DarwinWindow {
  if (!Number.isSafeInteger(appPid) || appPid < 2 || !Array.isArray(rows)) {
    throw new Error("Darwin owned window census requires a measured app PID and window list")
  }
  const census: DarwinCensusRow[] = rows.map((row: unknown) => {
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
      window: {
        id: value.id,
        ownerPid: value.ownerPid,
        layer: value.layer,
        bounds: { x: box.x, y: box.y, width: box.width, height: box.height },
      },
      alpha: typeof value.alpha === "number" ? value.alpha : null,
      onscreen: typeof value.onscreen === "boolean" ? value.onscreen : null,
    }
  })
  const owned = census.filter((row) => row.window.ownerPid === appPid && row.window.layer === 0)
  const visible = owned.filter((row) => row.onscreen !== false && (row.alpha === null || row.alpha > 0))
  const area = (row: DarwinCensusRow) => row.window.bounds.width * row.window.bounds.height
  const ranked = [...visible].sort((a, b) => area(b) - area(a))
  const best = ranked[0]
  const tied = best !== undefined && ranked.some((row) => row !== best && area(row) === area(best))
  if (!best || tied) {
    throw new Error(
      `Darwin capture requires one owned visible window for app PID ${appPid}; found ${visible.length} candidates (owned, layer 0, onscreen, alpha > 0)${tied ? " sharing the largest area" : ""}; owned layer-0 windows with point bounds, alpha and onscreen: ${JSON.stringify(owned)}`,
    )
  }
  const window = best.window
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

/**
 * Every window the server knows (not only the onscreen ones), so a refusal names the windows that
 * were excluded and why: layer, alpha and the onscreen flag beside the identity and point bounds.
 */
export const CENSUS = `ObjC.import('CoreGraphics'); ObjC.import('Foundation');
function value(dict, key) { var ref = dict.objectForKey(key); return ref ? ref.js : null; }
function bounds(dict) {
  var b = dict.objectForKey('kCGWindowBounds');
  if (!b) return null;
  function n(k) { var v = b.objectForKey(k); return v ? Number(v.js) : null; }
  return { x: n('X'), y: n('Y'), width: n('Width'), height: n('Height') };
}
function onscreen(dict) { var v = value(dict, 'kCGWindowIsOnscreen'); return v === true || v === 1; }
var raw = $.CGWindowListCopyWindowInfo($.kCGWindowListOptionAll | $.kCGWindowListExcludeDesktopElements, $.kCGNullWindowID);
if (!raw) throw new Error('CGWindowListCopyWindowInfo returned null');
var rows = [], count = $.CFArrayGetCount(raw);
for (var i = 0; i < count; i++) {
  var w = ObjC.castRefToObject($.CFArrayGetValueAtIndex(raw, i));
  rows.push({ id: value(w, 'kCGWindowNumber'), ownerPid: value(w, 'kCGWindowOwnerPID'), layer: value(w, 'kCGWindowLayer'), bounds: bounds(w), alpha: value(w, 'kCGWindowAlpha'), onscreen: onscreen(w), sharingState: value(w, 'kCGWindowSharingState'), memoryUsage: value(w, 'kCGWindowMemoryUsage') });
}
JSON.stringify(rows);`

interface ScreencaptureAttempt {
  file: string
  args: string[]
  outputPath: string
  stdout: Buffer | undefined
  stderr: Buffer
  cause?: unknown
  bytes?: Buffer
}

/** One screenshot per request. Paint currency belongs to the collector's witness, not this adapter. */
export async function createDarwinCapture(directory: string, { appPid }: { appPid: number }) {
  const census = async (deadline?: number) => {
    const rows: unknown = JSON.parse(
      (await command("/usr/bin/osascript", ["-l", "JavaScript", "-e", CENSUS], undefined, deadline)).toString(),
    )
    const window = selectDarwinWindow(rows, appPid)
    // Selection above validates the census rows before their diagnostic fields are retained.
    const observed = (rows as Record<string, unknown>[]).find(
      (row) => row.id === window.id && row.ownerPid === appPid && row.layer === 0,
    )
    return {
      window,
      // Observations may change without changing window identity; null means the census did not return a value.
      observations: {
        sharingState: observed?.sharingState ?? null,
        memoryUsage: observed?.memoryUsage ?? null,
        alpha: observed?.alpha ?? null,
        onscreen: observed?.onscreen ?? null,
      },
    }
  }
  const selected = await census()
  const { window } = selected
  await command("magick", ["-version"])
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const assertOwned = async (deadline?: number) => {
    const current = await census(deadline)
    if (JSON.stringify(current.window) !== JSON.stringify(window)) {
      throw new Error(`Darwin owned window ${window.id} identity or bounds changed during capture`)
    }
    return current
  }
  const windowArgs = ["-l", String(window.id), "-o", "-x", "-t", "png"]
  const { x, y, width, height } = window.bounds
  const regionArgs = ["-x", "-R", `${x},${y},${width},${height}`, "-t", "png"]
  const describe = (attempt: ScreencaptureAttempt) => {
    const cause = attempt.cause
    return {
      file: attempt.file,
      args: attempt.args,
      outputPath: attempt.outputPath,
      stdout: attempt.stdout?.toString() ?? null,
      stdoutBase64: attempt.stdout?.toString("base64") ?? null,
      stderr: attempt.stderr.toString(),
      stderrBase64: attempt.stderr.toString("base64"),
      cause: cause instanceof Error ? { name: cause.name, message: cause.message } : { message: String(cause) },
    }
  }
  const acquire = async (deadline?: number) => {
    const preCapture = await assertOwned(deadline)
    const run = async (args: string[]): Promise<ScreencaptureAttempt> => {
      const outputPath = join(directory, `capture-${randomBytes(16).toString("hex")}.png`)
      const attempt: ScreencaptureAttempt = {
        file: SCREENCAPTURE,
        args: [...args, outputPath],
        outputPath,
        stdout: undefined,
        stderr: Buffer.alloc(0),
      }
      try {
        attempt.stdout = await command(attempt.file, attempt.args, undefined, deadline, (output) => {
          attempt.stderr = output
        })
        attempt.bytes = readFileSync(outputPath)
      } catch (cause) {
        attempt.cause = cause
      } finally {
        try {
          unlinkSync(outputPath)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
        }
      }
      return attempt
    }
    const fail = (summary: string, attempt: ScreencaptureAttempt, refused?: ScreencaptureAttempt): never => {
      const captureContext = {
        measuredAppPid: appPid,
        selectedWindow: { ...window, ...selected.observations },
        preCaptureWindow: { ...preCapture.window, ...preCapture.observations },
      }
      const cause = attempt.cause
      const error = new Error(
        `${summary}: ${JSON.stringify({ captureContext, ...describe(attempt), ...(refused ? { refusedWindowCapture: describe(refused) } : {}) })}`,
        { cause },
      )
      error.name = attempt.stdout === undefined ? "DarwinCaptureCommandFailed" : "DarwinCaptureOutputMissing"
      if (cause instanceof Error && "captureCommand" in cause) {
        Object.assign(error, { captureCommand: cause.captureCommand })
      }
      throw error
    }
    const first = await run(windowArgs)
    // The window server refuses an image of a window it holds no backing store for (an Electron window
    // under the macOS 26 VM compositor, 30390); its point bounds are still on screen, so capture those.
    const refused =
      first.bytes === undefined && first.stdout === undefined && first.stderr.toString().includes(WINDOW_IMAGE_REFUSAL)
        ? first
        : undefined
    const producing = refused ? await run(regionArgs) : first
    const bytes =
      producing.bytes ??
      fail(
        refused
          ? "Darwin window server refused image of the selected window and the region capture of its bounds failed"
          : "Darwin screenshot capture failed",
        producing,
        refused,
      )
    const capturedAt = Date.now()
    await assertOwned(deadline)
    const pixels = capturePixels(
      (await command("magick", ["png:-", "-format", "%wx%h", "info:"], bytes, deadline)).toString(),
    )
    requireDarwinScale(window, pixels)
    const trace = {
      platform: "darwin",
      window,
      measuredAppPid: appPid,
      scale: 1,
      captureCommand: [producing.file, ...producing.args.slice(0, -1)],
      ...(refused
        ? {
            refusedWindowCapture: {
              captureCommand: [refused.file, ...refused.args.slice(0, -1)],
              stderr: refused.stderr.toString(),
            },
          }
        : {}),
    }
    return { source: { bytes, format: "png" as const, ...pixels, capturedAt }, trace }
  }
  const capture = async (checkpoint: Parameters<ProbeCapture>[0], origin: NamedTextOrigin) => {
    const { source, trace } = await acquire()
    return finishCapture({ directory, checkpoint, source, png: source.bytes, origin, trace })
  }
  const captureRaw = async (checkpoint: Parameters<ProbeCapture>[0], deadline?: number) => {
    const { source, trace } = await acquire(deadline)
    const decoded = await decodeCapture({ source, featureId: checkpoint.featureId, deadline })
    const result = await finishCapture({
      directory,
      checkpoint: { ...checkpoint, cells: undefined, pixelGeometry: undefined },
      source,
      png: source.bytes,
      decoded,
      ...(deadline === undefined ? {} : { deadline }),
      origin: () => {
        throw new Error("Darwin calibration raw capture cannot map cells before a named origin")
      },
      trace,
    })
    return { decoded, result }
  }
  return { capture, captureRaw }
}
