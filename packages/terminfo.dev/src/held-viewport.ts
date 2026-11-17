import { createHash } from "node:crypto"
import type {
  CaptureRectangle,
  HeldViewportBracket,
  HeldViewportCandidate,
  HeldViewportFrame,
  HeldViewportReading,
  HeldViewportUnavailable,
  ObservationFrame,
  ReadHeldViewport,
  ReadViewportReference,
  ViewportScroll,
} from "@terminfo/probe-defs"
import type { CapturedFrame } from "./capture-core.ts"
import type { TTYTraceMark } from "./tty.ts"

/** The settled grid one row's reads crop at: calibration's origin and cell, and the owned window. */
export interface HeldViewportGeometry {
  readonly origin: { readonly x: number; readonly y: number }
  readonly cell: { readonly width: number; readonly height: number }
  readonly cols: number
  readonly rows: number
  readonly window: string
}

/** One raw capture through the existing record route: the recorded result's identity and its decoded bytes. */
export interface RecordedRawFrame {
  readonly recorded: ObservationFrame
  readonly decoded: CapturedFrame
}

export interface HeldViewportReaderOptions {
  readonly featureId: string
  /** Read at each call: the probe source installs its leased route per row. */
  readonly route: () => ViewportScroll | undefined
  /** Undefined until calibration settles an origin for this row. */
  readonly geometry: () => HeldViewportGeometry | undefined
  /** Takes and records one raw frame; the adapter asserts window ownership before and after it. */
  readonly captureRaw: (label: string, deadline: number, role: ObservationFrame["role"]) => Promise<RecordedRawFrame>
  /** The live TTY trace mark of the row this read runs in (tty.ts currentTTYTraceMark). */
  readonly mark: () => TTYTraceMark | undefined
  readonly timeoutMs: number
  readonly now?: () => number
}

interface Cropped {
  readonly frame: HeldViewportFrame
  /** One digest per text row of the crop, top first. */
  readonly rows: readonly string[]
  readonly geometry: string
}

class Stop extends Error {
  constructor(
    readonly reason: HeldViewportUnavailable,
    detail: string,
  ) {
    super(detail)
  }
}

const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex")

/** Crop the settled grid out of a decoded frame and digest it row by row, from those bytes alone. */
export function cropRows(
  decoded: CapturedFrame,
  geometry: HeldViewportGeometry,
): {
  rectangle: CaptureRectangle
  rows: string[]
  digest: string
} {
  const rectangle = {
    x: geometry.origin.x,
    y: geometry.origin.y,
    width: geometry.cols * geometry.cell.width,
    height: geometry.rows * geometry.cell.height,
  }
  if (
    rectangle.x < 0 ||
    rectangle.y < 0 ||
    rectangle.width < 1 ||
    rectangle.height < 1 ||
    rectangle.x + rectangle.width > decoded.width ||
    rectangle.y + rectangle.height > decoded.height
  ) {
    throw new Stop(
      "geometry-changed",
      `grid ${JSON.stringify(rectangle)} does not fit the ${decoded.width}x${decoded.height} frame`,
    )
  }
  const rows: string[] = []
  const stride = decoded.width * 4
  for (let row = 0; row < geometry.rows; row++) {
    const hash = createHash("sha256")
    let uniform = true
    const first = (rectangle.y + row * geometry.cell.height) * stride + rectangle.x * 4
    for (let line = 0; line < geometry.cell.height; line++) {
      const top = (rectangle.y + row * geometry.cell.height + line) * stride + rectangle.x * 4
      const band = decoded.rgba.subarray(top, top + rectangle.width * 4)
      for (let at = 0; uniform && at < band.length; at++) uniform = band[at] === decoded.rgba[first + (at % 4)]
      hash.update(band)
    }
    // A band of one colour carries no line of the control: it is named blank, never digested as content.
    rows.push(uniform ? BLANK_ROW : hash.digest("hex"))
  }
  return { rectangle, rows, digest: `sha256:${sha256(rows.join("\n"))}` }
}

/** The row digest `cropRows` gives a band of one colour. */
export const BLANK_ROW = "blank"

/**
 * The one shift s > 0 at which every held row r >= s shows bottom row r - s. It needs the full-height control:
 * every bottom row and every held row nonblank and distinct, so the rows the hold reveals are history, never a
 * blank band from a grid that moved down. Only a rigid whole-row move up the history then yields a shift;
 * anything else (sideways, sub-cell, a changed origin, no move at all) yields a reason instead.
 */
export function uniqueRowShift(bottom: readonly string[], held: readonly string[]): number | string {
  if (bottom.length !== held.length) return `bottom has ${bottom.length} rows, held has ${held.length}`
  if (bottom.includes(BLANK_ROW)) return `bottom reference row ${bottom.indexOf(BLANK_ROW)} is blank`
  if (held.includes(BLANK_ROW)) return `held row ${held.indexOf(BLANK_ROW)} is blank`
  if (new Set(bottom).size !== bottom.length) return "the bottom reference rows are not all distinct"
  if (new Set(held).size !== held.length) return "the held rows are not all distinct"
  const shifts: number[] = []
  for (let shift = 1; shift < bottom.length; shift++) {
    let every = true
    for (let row = shift; row < held.length && every; row++) every = held[row] === bottom[row - shift]
    if (every) shifts.push(shift)
  }
  if (held.every((row, index) => row === bottom[index])) return "the held crop equals the bottom reference"
  const [only, ...more] = shifts
  if (only === undefined || more.length > 0) return `${shifts.length} whole-row shifts match the bottom reference`
  return only
}

/**
 * One row's held-viewport reader (34645, @cto e1cfff79). Order, inside the row's live trace: bottom reference
 * (a raw crop; for "already-held" a reference this reader took earlier), opening mark, the hold step recorded
 * as owed BEFORE dispatch, two held raw crops, closing mark, `bottom`, the bottom reference again. Raw crops
 * write nothing to the TTY. Restoration runs at most once: the in-line `bottom` discharges it, and otherwise
 * the `finally` returns to the bottom through the route, unless the row was abandoned, when the wall owns it.
 */
export function createHeldViewportReader(options: HeldViewportReaderOptions): {
  read: ReadHeldViewport
  reference: ReadViewportReference
} {
  const now = options.now ?? Date.now
  const references = new Map<string, Cropped>()
  let reads = 0
  /** One raw frame through the recorded route, cropped and digested from its own bytes. */
  const takeCrop = async (
    label: string,
    geometry: HeldViewportGeometry,
    role: ObservationFrame["role"],
    deadline: number,
  ): Promise<Cropped> => {
    let raw: RecordedRawFrame
    try {
      raw = await options.captureRaw(label, deadline, role)
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      throw new Stop(/identity or bounds changed/.test(message) ? "geometry-changed" : "capture-failed", message)
    }
    const cut = cropRows(raw.decoded, geometry)
    const frame: HeldViewportFrame = {
      ref: raw.recorded.ref,
      capturedAt: raw.recorded.capturedAt,
      regionDigest: cut.digest,
      regionRectangle: cut.rectangle,
      recorded: raw.recorded,
    }
    return { frame, rows: cut.rows, geometry: JSON.stringify(geometry) }
  }
  /**
   * The grid as it stands, with no key and no TTY write, recorded as a reference this row's reads can bind to:
   * the bottom before an already-held trigger (@cto e1cfff79 item 1), or an observed reference painted after the
   * row's last bracket (@cto 1154: observed post-bracket references). It claims nothing about where the view is.
   */
  const reference: ReadViewportReference = async (label) => {
    const opening = options.mark()
    if (!opening) {
      return { status: "unavailable", reason: "no-trace-scope", detail: "the read ran outside a live row's TTY trace" }
    }
    if (opening.mode === "replay") {
      return { status: "unavailable", reason: "replay", detail: "a replayed row has no live viewport to read" }
    }
    if (opening.abandoned) {
      return {
        status: "unavailable",
        reason: "trace-abandoned",
        detail: "the row was abandoned at its wall before the read",
      }
    }
    const geometry = options.geometry()
    if (!geometry) {
      return { status: "unavailable", reason: "capture-failed", detail: "no calibrated origin is settled for this row" }
    }
    try {
      const cropped = await takeCrop(`${label}: reference`, geometry, "control", now() + options.timeoutMs)
      references.set(cropped.frame.ref, cropped)
      return { status: "reference", frame: cropped.frame }
    } catch (error) {
      if (!(error instanceof Stop)) throw error
      return { status: "unavailable", reason: error.reason, detail: error.message }
    }
  }
  const read: ReadHeldViewport = async (hold, label, bottom) => {
    const frames: HeldViewportFrame[] = []
    let restored: "not-held" | "bottom-pressed" | "restore-failed" | "left-to-wall" = "not-held"
    let owesBottom = false
    const deadline = now() + options.timeoutMs
    const route = options.route()
    const unavailable = (reason: HeldViewportUnavailable, detail: string): HeldViewportReading => ({
      status: "unavailable",
      reason,
      detail,
      frames: [...frames],
      restored,
    })
    const inTime = (step: string) => {
      if (now() > deadline) throw new Stop("deadline", `the ${options.timeoutMs}ms read deadline passed before ${step}`)
    }
    const crop = async (
      step: string,
      geometry: HeldViewportGeometry,
      role: ObservationFrame["role"] = "control",
    ): Promise<Cropped> => {
      inTime(step)
      const cropped = await takeCrop(`${label}: ${step}`, geometry, role, deadline)
      frames.push(cropped.frame)
      return cropped
    }
    const opening = options.mark()
    if (!opening) return unavailable("no-trace-scope", "the read ran outside a live row's TTY trace")
    if (opening.mode === "replay") return unavailable("replay", "a replayed row has no live viewport to read")
    if (opening.abandoned) return unavailable("trace-abandoned", "the row was abandoned at its wall before the read")
    if (!route) return unavailable("route-missing", "this source has no viewport route")
    // The caller's trigger already held the view, outside this route's keys: restoration is owed from here, on
    // every exit below, and the route learns of the hold so its own return and the row wall see it too (@cto
    // e1cfff79 item 3; 34680, @cto 1359). Nothing awaits between the opening mark and this adoption.
    const adopted = hold === "already-held" && route.adoptHold !== undefined
    if (hold === "already-held") {
      route.adoptHold?.()
      owesBottom = true
    }
    try {
      const geometry = options.geometry()
      if (!geometry) throw new Stop("capture-failed", "no calibrated origin is settled for this row")
      let b0: Cropped
      if (hold === "already-held") {
        const known = bottom ? references.get(bottom.ref) : undefined
        if (!known || known.frame.regionDigest !== bottom?.regionDigest) {
          throw new Stop(
            "no-bound-reference",
            bottom
              ? `bottom reference ${bottom.ref} was not recorded by this row's reader`
              : "an already-held read needs the bottom reference this row recorded before its trigger",
          )
        }
        if (known.geometry !== JSON.stringify(geometry)) {
          throw new Stop("geometry-changed", "the settled grid changed since the bottom reference was taken")
        }
        b0 = known
        frames.push(b0.frame)
      } else {
        b0 = await crop("bottom reference before the hold", geometry)
        references.set(b0.frame.ref, b0)
      }
      const m0 = options.mark()
      if (!m0 || m0.abandoned) throw new Stop("trace-abandoned", "the row was abandoned at its wall")
      if (m0.unsettled > 0) {
        throw new Stop("trace-unsettled", `${m0.unsettled} TTY operation(s) pending at the opening mark`)
      }
      const openedAt = now()
      if (hold !== "already-held") {
        inTime(`the ${hold} step`)
        // Owed before dispatch: a post can land and its helper still reject (@cto e1cfff79 item 2).
        owesBottom = true
        try {
          await route.press(hold)
        } catch (cause) {
          throw new Stop("route-rejected", cause instanceof Error ? cause.message : String(cause))
        }
      }
      const first = await crop("held crop 1", geometry, "target")
      const second = await crop("held crop 2", geometry, "target")
      const m1 = options.mark()
      if (!m1 || m1.abandoned) throw new Stop("trace-abandoned", "the row was abandoned at its wall")
      if (m1.unsettled > 0) {
        throw new Stop("trace-unsettled", `${m1.unsettled} TTY operation(s) pending at the closing mark`)
      }
      if (m1.started !== m0.started) {
        throw new Stop("trace-moved", `${m1.started - m0.started} TTY operation(s) started inside the bracket`)
      }
      const bracket: HeldViewportBracket = {
        id: `${options.featureId}:${label}:${++reads}`,
        started: m0.started,
        openedAt,
        closedAt: now(),
      }
      if (first.frame.regionDigest !== second.frame.regionDigest) {
        throw new Stop("no-unique-shift", "the two held crops differ: the view was still moving")
      }
      const shift = uniqueRowShift(b0.rows, first.rows)
      // Back to the bottom before judging the shift, so every path below has restored exactly once.
      owesBottom = false
      try {
        await route.press("bottom")
        restored = "bottom-pressed"
      } catch (cause) {
        restored = "restore-failed"
        throw new Stop("route-rejected", cause instanceof Error ? cause.message : String(cause))
      }
      if (typeof shift === "string") throw new Stop("no-unique-shift", shift)
      const b1 = await crop("bottom reference after the hold", geometry)
      references.set(b1.frame.ref, b1)
      if (b1.frame.regionDigest !== b0.frame.regionDigest) {
        throw new Stop("reference-mismatch", "the bottom did not come back to the reference taken before the hold")
      }
      const candidate: HeldViewportCandidate = {
        kind: "held-viewport-candidate",
        featureId: options.featureId,
        label,
        route: route.route,
        hold,
        geometry,
        bracket,
        b0: b0.frame,
        held: [first.frame, second.frame],
        b1: b1.frame,
        shift,
        qualified: false,
      }
      return { status: "candidate", candidate }
    } catch (error) {
      // Every exit that still owes the bottom returns it here, once, unless the wall owns it.
      let restoreError: unknown
      if (owesBottom) {
        owesBottom = false
        if (options.mark()?.abandoned) restored = "left-to-wall"
        else {
          try {
            // The route's return knows every key hold and an adopted one; a route that could not adopt this
            // already-held view would answer not-held, so the bottom is pressed directly instead.
            restored =
              route.returnToBottom && (hold !== "already-held" || adopted)
                ? await route.returnToBottom()
                : await pressBottom(route)
          } catch (cause) {
            restored = "restore-failed"
            restoreError = cause
          }
        }
      }
      if (error instanceof Stop) {
        const also =
          restoreError === undefined ? "" : `; returning to the bottom also failed: ${messageOf(restoreError)}`
        return unavailable(error.reason, `${error.message}${also}`)
      }
      // Not a named stop (a projection bug): the run sees it, with any failed return named beside it.
      if (restoreError === undefined) throw error
      throw new Error(`${messageOf(error)}; returning to the bottom also failed: ${messageOf(restoreError)}`, {
        cause: error,
      })
    }
  }
  return { read, reference }
}

const messageOf = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause))

async function pressBottom(route: ViewportScroll): Promise<"bottom-pressed"> {
  await route.press("bottom")
  return "bottom-pressed"
}
