import { randomBytes } from "node:crypto"
import { mkdirSync, readFileSync, unlinkSync } from "node:fs"
import { join } from "node:path"
import {
  capturePixels,
  command,
  decodeCapture,
  finishCapture,
  type NamedTextOrigin,
  type OriginResolver,
} from "./capture-core.ts"
import type { ProbeCapture } from "./probes/unified.ts"

export interface DarwinWindow {
  id: number
  ownerPid: number
  layer: number
  bounds: { x: number; y: number; width: number; height: number }
}

/** One layer-0 window the measured app owns, as the census saw it, and why it was or was not the capture target. */
export interface DarwinOwnedWindow {
  window: DarwinWindow
  /** Null in a row that predates the all-windows census or whose window server omitted the key. */
  alpha: number | null
  onscreen: boolean | null
  sharingState: number | null
  memoryUsage: number | null
  /**
   * The window's title as the window server returned it, with the two failure shapes kept apart:
   * `present` false means the key was withheld (no Screen Recording grant for the caller, or the API
   * did not supply it) and is never a title; `present` true with `value` `""` is a real empty title,
   * which only a control can tell from a reader that failed. Names need the Screen Recording grant
   * the hosted workflow already makes; reading one spawns no AppleScript and asks no permission.
   */
  name: { present: boolean; value: string | null }
  /** Exactly one owned window is `selected`; every other names the rule that passed it over. */
  disposition: "selected" | "offscreen" | "transparent" | "smaller" | "rival"
}

/** The selection and the census it was made from: the proof that no other owned window was the terminal (30685). */
export interface DarwinWindowCensus {
  selected: DarwinOwnedWindow
  /** Every layer-0 window the app owns, largest first, the selected one included. */
  ownedWindows: DarwinOwnedWindow[]
}

/** The census the adapter measured when it was installed, before any pre-flight query: the existing
 * census object (the selected window, its observations, and every owned layer-0 window) plus the
 * moment it was taken. It proves the app owned exactly one visible layer-0 window AT INSTALL; it says
 * nothing about a frame's content or about a later window (@cto 2026-10-22, #30392 C1). */
export interface DarwinInstallCensus {
  /** The selected owned window, exactly as the install census measured it. */
  window: DarwinWindow
  observations: {
    sharingState: number | null
    memoryUsage: number | null
    alpha: number | null
    onscreen: boolean | null
  }
  ownedWindows: DarwinOwnedWindow[]
  takenAt: string
}

type DarwinCensusRow = Omit<DarwinOwnedWindow, "disposition">

const SCREENCAPTURE = "/usr/sbin/screencapture"
const WINDOW_IMAGE_REFUSAL = "could not create image from window"

/**
 * Select the app's one visible window: owned by `appPid`, layer 0, onscreen and not fully transparent.
 * An app that keeps several such windows (cmux keeps two or three, 30390) measures its largest; two
 * sharing the largest area are indistinguishable and refuse. The census of every owned layer-0 window
 * is returned beside the selection, so a run shows which windows were passed over and why (30685).
 */
export function censusDarwinWindows(
  rows: unknown,
  appPid: number,
  /** The window id the launch receipt recorded for THIS run, when the arm has one. */
  expectedWindowId?: number,
  windowSelection: "largest" | "unique" = "largest",
): DarwinWindowCensus {
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
      sharingState: typeof value.sharingState === "number" ? value.sharingState : null,
      memoryUsage: typeof value.memoryUsage === "number" ? value.memoryUsage : null,
      name: {
        present: value.namePresent === true,
        value: typeof value.name === "string" ? value.name : null,
      },
    }
  })
  const area = (row: DarwinCensusRow) => row.window.bounds.width * row.window.bounds.height
  const owned = census
    .filter((row) => row.window.ownerPid === appPid && row.window.layer === 0)
    .sort((a, b) => area(b) - area(a))
  const passedOver = (row: DarwinCensusRow): "offscreen" | "transparent" | null =>
    row.onscreen === false ? "offscreen" : row.alpha !== null && row.alpha <= 0 ? "transparent" : null
  const visible = owned.filter((row) => passedOver(row) === null)
  /**
   * A launch receipt's window id is the strongest identity this census can get, and it is a claim to
   * CHECK, never a shortcut past ownership: a named window that is absent, other-owned, layered,
   * offscreen or fully transparent refuses by name instead of falling back to the largest window.
   */
  const named = (id: number): DarwinCensusRow => {
    if (!Number.isSafeInteger(id) || id < 1) {
      throw new Error(`Darwin capture expected window id is not a positive integer: ${JSON.stringify(id)}`)
    }
    const row = census.find((candidate) => candidate.window.id === id)
    if (!row) {
      throw new Error(
        `Darwin capture expected owned window ${id}, but the window server census names no window with that id for app PID ${appPid}; owned layer-0 windows: ${JSON.stringify(owned)}`,
      )
    }
    const exclusion = passedOver(row)
    const refusal =
      row.window.ownerPid !== appPid
        ? `is owned by PID ${row.window.ownerPid}, not the launched app PID ${appPid}`
        : row.window.layer !== 0
          ? `is layer ${row.window.layer}, not layer 0`
          : exclusion === "offscreen"
            ? "is offscreen"
            : exclusion === "transparent"
              ? "is fully transparent"
              : null
    if (refusal) {
      throw new Error(
        `Darwin capture expected window ${id} ${refusal}; owned layer-0 windows for app PID ${appPid}: ${JSON.stringify(owned)}`,
      )
    }
    return row
  }
  const expected = expectedWindowId === undefined ? undefined : named(expectedWindowId)
  const best = expected ?? visible[0]
  // Two equal windows are indistinguishable only when nothing named one of them.
  const tied =
    expected === undefined && best !== undefined && visible.some((row) => row !== best && area(row) === area(best))
  if (!best || tied || (expected === undefined && windowSelection === "unique" && visible.length !== 1)) {
    // The macOS workflow greps collector.log for this wording (30624; scripts/measurement-workflows.test.ts pins it).
    throw new Error(
      `Darwin capture requires one owned visible window for app PID ${appPid}; found ${visible.length} candidates (owned, layer 0, onscreen, alpha > 0)${tied ? " sharing the largest area" : ""}; owned layer-0 windows with point bounds, alpha, onscreen, sharingState and memoryUsage: ${JSON.stringify(owned)}`,
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
  const selected: DarwinOwnedWindow = { ...best, disposition: "selected" }
  const ownedWindows: DarwinOwnedWindow[] = owned.map((row) =>
    row === best
      ? selected
      : { ...row, disposition: passedOver(row) ?? (expected === undefined ? "smaller" : "rival") },
  )
  return { selected, ownedWindows }
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
  var nameRef = w.objectForKey('kCGWindowName');
  rows.push({ id: value(w, 'kCGWindowNumber'), ownerPid: value(w, 'kCGWindowOwnerPID'), layer: value(w, 'kCGWindowLayer'), bounds: bounds(w), alpha: value(w, 'kCGWindowAlpha'), onscreen: onscreen(w), sharingState: value(w, 'kCGWindowSharingState'), memoryUsage: value(w, 'kCGWindowMemoryUsage'), namePresent: nameRef ? true : false, name: nameRef ? nameRef.js : null });
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
export async function createDarwinCapture(
  directory: string,
  {
    appPid,
    expectedWindowId,
    windowSelection,
    ownedHost,
    onRetained,
  }: {
    appPid: number
    /**
     * An owned Mac (codimac, 33587) whose console shows other people's apps: capture is window-only,
     * so a refused window image never falls back to a region of the screen (@cto 730017b6).
     */
    ownedHost?: boolean
    /** The launch receipt window id this run owns, when the caller already resolved it. */
    expectedWindowId?: number
    /** PID-only routes that cannot prove one launch window require a unique visible owned window. */
    windowSelection?: "largest" | "unique"
    onRetained: Parameters<typeof finishCapture>[0]["onRetained"]
  },
) {
  const targetWindowId = expectedWindowId
  /**
   * `windowId` pins the selection to one identity instead of re-selecting by size: a measurement poll
   * that re-ran the size rule could follow a rival window that grew after install and record ITS name
   * beside this window's install census.
   */
  const census = async (deadline?: number, windowId: number | undefined = targetWindowId) => {
    const rows: unknown = JSON.parse(
      (await command("/usr/bin/osascript", ["-l", "JavaScript", "-e", CENSUS], undefined, deadline)).toString(),
    )
    const { selected, ownedWindows } = censusDarwinWindows(rows, appPid, windowId, windowSelection)
    const { window, alpha, onscreen, sharingState, memoryUsage, name } = selected
    return {
      window,
      name,
      // Observations may change without changing window identity; null means the census did not return a value.
      observations: { sharingState, memoryUsage, alpha, onscreen },
      // Every owned layer-0 window and why only one was the target: the proof the frame shows the terminal (30685).
      ownedWindows,
    }
  }
  const installed = await census()
  const { name: _installedName, ...installedCensus } = installed
  const installCensus: DarwinInstallCensus = {
    ...installedCensus,
    takenAt: new Date().toISOString(),
  }
  const { window } = installed
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
        selectedWindow: { ...window, ...installed.observations },
        preCaptureWindow: { ...preCapture.window, ...preCapture.observations },
        ownedWindows: preCapture.ownedWindows,
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
    if (refused && ownedHost) {
      fail(
        "Darwin window server refused image of the selected window, and an owned host never captures a " +
          "screen region instead: its bounds can include other apps' windows (@cto 730017b6)",
        refused,
      )
    }
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
      // The census the frame was taken under: the other owned windows and why each was passed over (30685).
      ownedWindows: preCapture.ownedWindows,
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
  const capture = async (checkpoint: Parameters<ProbeCapture>[0], origin: NamedTextOrigin | OriginResolver) => {
    const { source, trace } = await acquire()
    return finishCapture({ directory, onRetained, checkpoint, source, png: source.bytes, origin, trace })
  }
  const captureRaw = async (checkpoint: Parameters<ProbeCapture>[0], deadline?: number) => {
    const { source, trace } = await acquire(deadline)
    const decoded = await decodeCapture({ source, featureId: checkpoint.featureId, deadline })
    const result = await finishCapture({
      directory,
      onRetained,
      checkpoint: { ...checkpoint, cells: undefined, controlCells: undefined, pixelGeometry: undefined },
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
  return { capture, captureRaw, installCensus }
}

/**
 * The exact Terminal.app window this run launched, from the launch receipt the workflow writes beside
 * the artifacts directory. Run 42560226484 is why size is not identity: the cold start opens its own
 * startup window at the same place, so a size-based census either ties and refuses or photographs a
 * window this run never created. An absent or foreign record refuses by name rather than falling back.
 */
