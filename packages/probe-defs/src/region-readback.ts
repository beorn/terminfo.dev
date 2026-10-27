/**
 * The capture-region readback oracle: the ONE expected/seed/after decision, sourced from
 * cell-aligned crops of an owned window capture instead of the terminal's own report.
 *
 * Why a paint WITNESS and never a delay. A cursor-position round trip proves the parser consumed
 * the bytes, never that the window was repainted: kitty 0.49.2 under Xvfb answers the cursor report
 * after ESC # 8 and still shows the pre-DECALN frame, so "after equals seed" read from a bare
 * capture would be a false negative. A terminal paints damage in stream ORDER, so a sentinel glyph
 * landing in a cell outside every compared region witnesses that every byte written before it — the
 * edit included — is on screen.
 *
 * The decision is digest EQUALITY and nothing else: after equals expected is supported; after equals
 * seed (the sequence left the screen untouched) or equals the row's `ignored` frame (the sequence ran
 * while dropping the one attribute the row claims) is unsupported behind a proven paint; anything
 * else is inconclusive BY NAME. No tolerance, no similarity, no glyph reading. A missing paint
 * witness, a capture that is not byte-stable, or a paint seen outside the sentinel region is never a
 * negative.
 *
 * The verdict compares three or four captures of ONE run — seed, post-sequence, the expected frame,
 * and, when the row names one, the ignored-attribute frame, all painted plainly in the same run —
 * each behind its own witness, with the cursor hidden (DECTCEM)
 * across all of them. Geometry comes from the terminal's own report or a complete witnessed raster
 * measurement in this run. The collector must prove registration: an offset crop can compare only
 * part of a glyph and still pass a witness, so symmetry alone does not establish the right pixels.
 */
import type {
  CaptureCells,
  AssertionType,
  CapturePixelGeometry,
  CaptureRectangle,
  ObservationFrame,
  ProbeCallbackResult,
  TermProbeSource,
  TerminalQueryOutcome,
} from "./types.ts"
import { frameDigests } from "./types.ts"
import { utf8DecodingRefusal } from "./helpers.ts"

export type CellRegion = CaptureCells
export type PixelGeometry = CapturePixelGeometry

/** One capture checkpoint's cell-aligned read, from a run whose capture adapter is installed. */
export interface RegionCapture {
  /** Raw-pixel digest of the requested region. */
  regionDigest: string
  /** Raw-pixel digest of the whole captured window. */
  pixelsDigest: string
  /**
   * The screen rectangle the region digest was cropped from, when the capture adapter recorded one.
   * Two frames' region digests are comparable only when these are equal: the capture arm places the
   * text area per frame, so a frame cropped 26 px away is not the same cells (29580).
   */
  regionRectangle?: CaptureRectangle
  frame: ObservationFrame
}

export type RegionRead = (request: {
  role: ObservationFrame["role"]
  label: string
  region: CellRegion
  /** Absent on a text arm: it reads cells, so there is no cell-to-pixel mapping to report. */
  pixelGeometry?: PixelGeometry
}) => Promise<RegionCapture>

/**
 * The collector-backed reader for a run whose capture adapter is installed, or null when this run
 * has no owned capture at all. A frame that came back without a digest is a collector bug, not a
 * measurement, so it raises instead of quietly degrading the verdict.
 */
export function collectorRegionRead(ctx: TermProbeSource): RegionRead | null {
  // A text arm hands the region readback its own cells adapter; every other arm reads pixels.
  const capture = ctx.cells ?? ctx.capture
  if (!capture) return null
  return async ({ role, label, region, pixelGeometry }) => {
    const frame = await capture({ role, label, cells: region, pixelGeometry })
    // ONE accessor for both kinds: a pixel frame hands over its raw-pixel digests, a
    // text frame its cell digests. The comparison below never names a field, so it is one path.
    const digests = frameDigests(frame)
    if (digests.cells === undefined || digests.whole === undefined) {
      throw new Error(
        `${label}: the capture adapter returned a ${frame.kind ?? "pixels"} frame with no digest for the requested cells (cells ${String(digests.cells)}, whole ${String(digests.whole)})`,
      )
    }
    return {
      regionDigest: digests.cells,
      pixelsDigest: digests.whole,
      ...(frame.regionRectangle ? { regionRectangle: frame.regionRectangle } : {}),
      frame,
    }
  }
}

export interface RegionReadback {
  /** The cells the verdict compares. The witness cell and the cursor row lie outside it. */
  region: CellRegion
  /** The reserved one-cell paint witness, outside every compared region. */
  sentinel: { row: number; col: number }
  /** The row the fixture parks the cursor on before each witness; excluded from every region. */
  cursorRow: number
  /** Writes that paint the seed frame. */
  seed: string
  /** The sequence under test, applied on top of the seed frame. */
  edit: string
  /** Writes that paint the expected frame plainly, in this same run. */
  expected: string
  /**
   * Writes that paint the frame the sequence would leave if it IGNORED the one attribute its row
   * claims — a DECSCA-protected cell erased, an EL that drops the current background. An after-frame
   * equal to it is a measured NEGATIVE like `seed`, not an unnamed `inconclusive`: the row's own
   * discriminator is the whole point. Absent when the row's sequence has no attribute to ignore.
   */
  ignored?: string
  /**
   * Set when the expected frame cannot be produced without the sequence under test: a row whose
   * reset clears TWO OR MORE of its setup attributes (reset.sgr, sgr.reset, sgr.selective-reset.bold)
   * can leave the reset under test and the reference both missing the same part of that cleared set,
   * so the surviving attribute is painted into the expected frame and the row reads supported while
   * it survived. Such a row is INCONCLUSIVE BY NAME on either capture path, before a byte, rather
   * than graded against a reference that shares the tested sequence's failure.
   */
  noIndependentReference?: string
  /** The terminal's own pixel report, carried into every capture request. Absent on a text arm,
   * which reads cells and never maps them onto pixels. */
  pixelGeometry?: PixelGeometry
  /**
   * WHERE that report came from, in words, so a reader can tell a geometry problem from a slow paint
   * (28763 fix 1): a terminal that answers CSI 16 t is `reported by CSI 16 t`, and one
   * that answers only 14 t and 18 t is `derived from CSI 14 t / CSI 18 t`. Every number then names its
   * basis instead of leaving a derived cell size looking like a reported one.
   */
  geometrySource?: PixelGeometrySource
  /**
   * A write the run needs AFTER its frames — a mode or a scroll region the last frame leaves set,
   * which a later probe sharing this terminal must not inherit. Issued from the run's own `finally`,
   * so it lands exactly when this oracle wrote bytes: a refusal that wrote none leaves a zero-byte
   * trace, which run-parser's zero-byte rule requires of every `none` observation. Named for the JOB:
   * `afterVerdict` named the moment it runs, and this is the write that clears the mode the last
   * frame left set.
   */
  cleanup?: string
  /**
   * This row's expected frame is written PLAINLY, so deciding it assumes the run decodes plain
   * UTF-8. The measured context fact is read before the first capture: a run measured 8-bit is
   * inconclusive BY NAME instead of being compared against glyphs its terminal cannot paint
   * (#28752).
   */
  requiresUtf8?: true
  /** Bound on one paint witness, in ms. A timeout is inconclusive by name, never unsupported. */
  timeoutMs: number
  /** Floor between witness reads. The collector's own capture settle dominates it. */
  pollMs?: number
  minRows?: number
  minCols?: number
}

/**
 * A stand-in geometry for the bounds-only check that runs before the terminal is queried: the
 * pixel report is validated separately, and this value never reaches a capture request.
 */
const PENDING_GEOMETRY: PixelGeometry = { cellWidth: 1, cellHeight: 1, textWidth: 1, textHeight: 1 }
export const DEFAULT_TIMEOUT_MS = 5000
const DEFAULT_POLL_MS = 250

/**
 * A distinct glyph per witnessed step. A repeated glyph would leave an unpainted cell byte-identical
 * to the previous step's, so a stale window could not be told from a fresh paint.
 */
const WITNESS_GLYPHS = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"] as const

function witnessGlyph(step: number): string {
  return WITNESS_GLYPHS[step % WITNESS_GLYPHS.length] ?? "0"
}

/**
 * An inconclusive result plus, when the branch took captures, the citation that names them. The
 * raw-run contract refuses evidence "pixels" unless the observation carries a screenshotRef, so a
 * branch that captured and cites nothing is unwritable: the citation is part of the measurement.
 */
function inconclusive(
  id: string,
  note: string,
  reason: "timeout" | "insufficient-evidence",
  assertionType: AssertionType = "screenshot",
  citation?: { screenshotRef?: string; frames?: ObservationFrame[] },
): ProbeCallbackResult {
  return {
    pass: false,
    observation: {
      outcome: "inconclusive",
      reason,
      assertionType,
      note,
      ...(citation?.screenshotRef === undefined ? {} : { screenshotRef: citation.screenshotRef }),
      ...(citation?.frames === undefined ? {} : { frames: citation.frames }),
    },
  }
}

/**
 * A refusal taken before any byte: the collector declined to measure, so it is not pixel evidence.
 * Evidence "none" must carry a zero-byte trace, so a branch that has already queried is never this
 * shape — it reports evidence "query" instead (see captureRegionVerdict).
 */
function refused(id: string, note: string): ProbeCallbackResult {
  return { pass: false, tests: [{ id: "criterion", status: "test-todo", reason: note }] }
}

/**
 * A caller that had already written and queried before asking (the DECRQSS SGR readback) cannot
 * carry evidence "none": run-parser requires a zero-byte trace for it. Rewrite any "none" refusal
 * into the same observation with truthful query evidence and say why in the note. Pixel verdicts and
 * every non-"none" refusal pass through untouched.
 */
function afterCallerBytes(result: ProbeCallbackResult, callerHasQuery: boolean): ProbeCallbackResult
function afterCallerBytes(result: ProbeCallbackResult | null, callerHasQuery: boolean): ProbeCallbackResult | null
function afterCallerBytes(result: ProbeCallbackResult | null, callerHasQuery: boolean): ProbeCallbackResult | null {
  if (!callerHasQuery || !result || result.observation || result.notTested) return result
  return {
    ...result,
    tests: [
      {
        id: "criterion",
        status: "test-failure",
        reason: `${result.tests[0].reason} — the caller wrote before this refusal, so this is not a zero-byte trace`,
      },
    ],
  }
}

function positive(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0
}

/** Refuse before any byte when the grid, the region, the witness or the pixel report cannot decide. */
type RegionGeometrySpec = Pick<RegionReadback, "region" | "minRows" | "minCols" | "pixelGeometry"> &
  Partial<Pick<RegionReadback, "sentinel" | "cursorRow">>

function regionRefusal(
  id: string,
  spec: RegionGeometrySpec,
  rows: number,
  cols: number,
  textMode = false,
): ProbeCallbackResult | undefined {
  const minRows = spec.minRows ?? 1
  const minCols = spec.minCols ?? 1
  if (!Number.isSafeInteger(rows) || !Number.isSafeInteger(cols) || rows < minRows || cols < minCols) {
    return refused(
      id,
      `${id}: capture-region readback needs a measured grid of at least ${minRows}x${minCols}; measured ${rows}x${cols}`,
    )
  }
  // A text arm reads cells directly: there is no pixel report to demand, and demanding one would
  // refuse exactly the terminals the pixel path cannot calibrate.
  if (!textMode) {
    const geometry = spec.pixelGeometry
    if (
      geometry === undefined ||
      !positive(geometry.cellWidth) ||
      !positive(geometry.cellHeight) ||
      !positive(geometry.textWidth) ||
      !positive(geometry.textHeight)
    ) {
      return refused(
        id,
        `${id}: capture-region readback needs the terminal's own positive pixel report (cell size and text area); got ${JSON.stringify(geometry)}`,
      )
    }
  }
  const { region, sentinel, cursorRow } = spec
  const edges = [region.top, region.left, region.bottom, region.right]
  if (
    edges.some((value) => !Number.isSafeInteger(value)) ||
    (cursorRow !== undefined && !Number.isSafeInteger(cursorRow))
  ) {
    return refused(id, `${id}: capture-region readback needs integer cell edges`)
  }
  if (region.top < 1 || region.left < 1 || region.bottom < region.top || region.right < region.left) {
    return refused(id, `${id}: compared region ${JSON.stringify(region)} is not a non-empty rectangle inside the grid`)
  }
  if (region.bottom > rows || region.right > cols) {
    return refused(id, `${id}: compared region ${JSON.stringify(region)} leaves the measured ${rows}x${cols} grid`)
  }
  // Differential captures have no paint-witness or parked-cursor fixture to validate.
  if (sentinel === undefined || cursorRow === undefined) return undefined
  if (!Number.isSafeInteger(sentinel.row) || !Number.isSafeInteger(sentinel.col)) {
    return refused(id, `${id}: paint witness needs integer cell coordinates`)
  }
  if (sentinel.row < 1 || sentinel.col < 1 || sentinel.row > rows || sentinel.col > cols) {
    return refused(
      id,
      `${id}: paint witness cell ${sentinel.row},${sentinel.col} leaves the measured ${rows}x${cols} grid`,
    )
  }
  const sentinelInside =
    sentinel.row >= region.top &&
    sentinel.row <= region.bottom &&
    sentinel.col >= region.left &&
    sentinel.col <= region.right
  if (sentinelInside) {
    return refused(
      id,
      `${id}: paint witness cell ${sentinel.row},${sentinel.col} lies inside compared region ${JSON.stringify(region)}`,
    )
  }
  if (cursorRow < 1 || cursorRow > rows) {
    return refused(id, `${id}: cursor row ${cursorRow} leaves the measured ${rows}x${cols} grid`)
  }
  if (region.top <= cursorRow && cursorRow <= region.bottom) {
    return refused(id, `${id}: compared region ${JSON.stringify(region)} includes the cursor row ${cursorRow}`)
  }
  if (sentinel.row === cursorRow) {
    return refused(id, `${id}: paint witness cell shares the cursor row ${cursorRow}`)
  }
  return undefined
}

/**
 * Read the witness cell until it differs from the baseline. The two failure shapes are named apart:
 * the frame moving while the witness cell stands still means the paint landed outside the sentinel
 * region (the geometry is wrong), and nothing moving at all means no paint witness within the bound.
 * BOTH shapes name the basis the rectangle was measured with, so a timeout never leaves a reader
 * unable to tell a reported geometry from a derived one (28763: the ordinary branch
 * returned before the payload carrying the source was built).
 */
async function awaitPaintWitness(options: {
  read: RegionRead
  id: string
  label: string
  witnessCell: CellRegion
  pixelGeometry?: PixelGeometry
  geometrySource?: PixelGeometrySource
  baseline: RegionCapture
  timeoutMs: number
  pollMs: number
  /** How this run sees its frames: the timeout branch names it rather than claiming pixels. */
  assertionType?: "screenshot" | "buffer_state"
}): Promise<{ witness: RegionCapture } | ProbeCallbackResult> {
  const { read, id, label, witnessCell, pixelGeometry, geometrySource, baseline, timeoutMs, pollMs } = options
  const assertionType = options.assertionType ?? "screenshot"
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const painted = await read({
      role: "control",
      label: `${label} — paint witness`,
      region: witnessCell,
      pixelGeometry,
    })
    if (painted.regionDigest !== baseline.regionDigest) return { witness: painted }
    const frameMoved = painted.pixelsDigest !== baseline.pixelsDigest
    if (Date.now() >= deadline) {
      return inconclusive(
        id,
        frameMoved
          ? `${id}: paint witnessed outside the sentinel region after ${label} within ${timeoutMs} ms; the frame moved while witness cell ${witnessCell.top},${witnessCell.left} stood still, so the cells-to-pixels geometry is wrong for this context (cell geometry ${geometrySource ?? "unknown"})`
          : `${id}: no paint witness within ${timeoutMs} ms after ${label}; the terminal left the witness cell unpainted, so this run cannot separate a painted frame from a stale one (cell geometry ${geometrySource ?? "unknown"})`,
        "timeout",
        assertionType,
        // A text timeout cites no frame: a lone frame is not the pair a verdict needs, and the row
        // is inconclusive about the paint, not about a snapshot it could point a reader at.
        assertionType === "screenshot" ? { screenshotRef: painted.frame.ref } : {},
      )
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, pollMs)
    })
  }
}

function witnessed(result: { witness: RegionCapture } | ProbeCallbackResult): result is { witness: RegionCapture } {
  return "witness" in result
}

/** Two crop rectangles cover the same cells only when all four integers match. */
function sameRectangle(left: CaptureRectangle, right: CaptureRectangle): boolean {
  return left.x === right.x && left.y === right.y && left.width === right.width && left.height === right.height
}

/** A rectangle as the refusal names it: `x,y wxh`, the same spelling the capture trace records. */
function rectangleSpelling(rectangle: CaptureRectangle): string {
  return `${rectangle.x},${rectangle.y} ${rectangle.width}x${rectangle.height}`
}

/**
 * Refuse a comparison whose frames were cropped from different screen positions: their region
 * digests were never taken over the same cells, so neither equality nor inequality between them
 * means anything (the ghostty specimen was 26 px, about one row, out). The refusal names every
 * compared frame's rectangle. Nothing is checked when a compared frame carries no rectangle: the
 * one capture producer sets the digest and the rectangle in a single branch, so a frame without one
 * is a hand-built read, never an owned capture. This adds a named refusal and moves no digest.
 */
export function cropPositionRefusal(input: {
  id: string
  compared: Array<{ role: string; rectangle: CaptureRectangle | undefined }>
  response: string
  frames: ObservationFrame[]
  screenshotRef?: string
}): ProbeCallbackResult | null {
  const { id, compared, response, frames, screenshotRef } = input
  const cropped = compared.filter(
    (entry): entry is { role: string; rectangle: CaptureRectangle } => entry.rectangle !== undefined,
  )
  if (cropped.length !== compared.length) return null
  const [seed, ...rest] = cropped
  if (seed === undefined) return null
  if (rest.every(({ rectangle }) => sameRectangle(rectangle, seed.rectangle))) return null
  const named = cropped.map(({ role, rectangle }) => `${role} cropped at ${rectangleSpelling(rectangle)}`).join(", ")
  return {
    pass: false,
    response,
    criterionBranch: "same-crop-comparison",
    tests: [
      {
        id: "comparison",
        status: "test-failure",
        reason: `Compared frames were cropped from different positions: ${named}`,
      },
    ],
    observation: {
      outcome: "inconclusive",
      reason: "insufficient-evidence",
      assertionType: frames.some((frame) => frame.kind === "text-cells") ? "buffer_state" : "screenshot",
      screenshotRef,
      ...(frames.length > 0 ? { frames } : {}),
      note: `${id}: the compared frames were cropped from different screen positions, so their region digests were not taken over the same cells: ${named}`,
    },
  }
}

/**
 * The terminal's own pixel report: CSI 16 t (cell size in pixels) and CSI 14 t (text area in
 * pixels). A context that answers neither cannot map cells onto the captured window at all, and
 * says so BY NAME instead of falling back to a window width divided by a column count.
 *
 * A terminal that answers no 16 t — alacritty, on Linux and macOS — is not a terminal without a
 * report: it answers the SAME text area twice, in pixels (14 t) and in characters (18 t), so its
 * cell size is the whole-number division of the two (28763).
 */
/** The two bases a pixel geometry can rest on, named once so a reader sees one spelling. */
const GEOMETRY_REPORTED = "reported by CSI 16 t"
const GEOMETRY_DERIVED = "derived from CSI 14 t / CSI 18 t"

/**
 * The two bases named above, as a literal union: the
 * bare `string` this field carried let a THIRD spelling reach the payload without a type error, so a
 * reader could no longer tell a reported geometry from a derived one. Nothing else changes — the
 * constants are the only values ever assigned, so this is a type-only tightening.
 *
 * Named PixelGeometrySource and not GeometrySource (28785 must 4): `GeometrySource` in
 * owned-terminal.ts names where the workflow's own CELL geometry came from — a different concept
 * answering a different question — and one name must not carry two.
 */
export type PixelGeometrySource =
  | typeof GEOMETRY_REPORTED
  | typeof GEOMETRY_DERIVED
  | "measured by complete raster calibration"
  /**
   * A text arm: the compared cells came from a text source — the console host's buffer on Windows,
   * the app's own text on macOS — never from a raster. The older wording named "the terminal's own
   * text", which is false on Windows (30033 ruling f1f3c64b).
   */
  | "cells read from a text source, not from pixels"

/**
 * Why a cell-to-pixel geometry could not be measured, and whether the cause is the terminal or this
 * run (28785 rounds 1 and 2). A `timeout` — nothing answered at all, DA1 included — is
 * TRANSIENT: the same terminal may answer on the next run, so a collector that owns the terminal
 * must fail that run loudly and have it repeated, never publish the terminal as one that cannot be
 * mapped. Everything else is INTRINSIC and is the only refusal a run may complete under — the
 * terminal answered its own numbers and they do not fit a cell, AND equally a `sentinel`, which
 * tty.ts measures as DA1 answered and then silence through the grace window: the terminal answered
 * and does not support the query, so that negative is a fact about the terminal, not about this run.
 *
 * `transient` is read by the pre-flight, which is the only caller that acts on it; the per-row
 * `captureRegionVerdict` grades a missing report the same way whichever it is, because a row that
 * asks its own question is not aborting a batch.
 */
export interface PixelGeometryRefusal {
  missing: string
  transient: boolean
}

/**
 * Everything the pixel-geometry queries below touch of a terminal source: ONE method, and nothing
 * else. Naming it lets a collector that owns the terminal ask the SAME implementation before it
 * starts a batch (there is no second geometry implementation to drift from), without inventing a
 * whole fake TermProbeSource for a question that sends at most three QUERIES — CSI 16 t, then CSI 14 t
 * always, then CSI 18 t only when 16 t went unanswered — and reads at most TWO replies (a terminal
 * that answers 16 t is still asked 14 t for the text area).
 */
export type PixelGeometryQuerySource = Pick<TermProbeSource, "queryWithSentinelOutcome">

export async function queryPixelGeometry(
  ctx: PixelGeometryQuerySource,
): Promise<{ geometry: PixelGeometry; source: PixelGeometrySource } | PixelGeometryRefusal> {
  const cell = await ctx.queryWithSentinelOutcome("\x1b[16t", /\x1b\[6;(\d+);(\d+)t/)
  if (cell.reason !== "reply") return deriveCellSizeFromTextArea(ctx, cell.reason)
  const text = await ctx.queryWithSentinelOutcome("\x1b[14t", /\x1b\[4;(\d+);(\d+)t/)
  if (text.reason !== "reply") {
    return {
      missing: `the terminal answered CSI 14 t (text area in pixels) with ${text.reason}`,
      transient: text.reason === "timeout",
    }
  }
  const geometry: PixelGeometry = {
    cellHeight: Number(cell.match?.[1]),
    cellWidth: Number(cell.match?.[2]),
    textHeight: Number(text.match?.[1]),
    textWidth: Number(text.match?.[2]),
  }
  if (
    !positive(geometry.cellWidth) ||
    !positive(geometry.cellHeight) ||
    !positive(geometry.textWidth) ||
    !positive(geometry.textHeight)
  ) {
    return {
      missing: `the terminal's pixel report did not parse as positive numbers: ${JSON.stringify(geometry)}`,
      transient: false,
    }
  }
  return { geometry, source: GEOMETRY_REPORTED }
}

/**
 * The cell size of a terminal that answers no 16 t, from the two replies it does answer: the text
 * area in pixels (14 t) and that same area in rows and columns (18 t). The division IS the
 * measurement, so it has to be exact — 640 pixels over 80 columns and 384 over 24 rows is an 8x16
 * cell, and 641 over 80 is not a cell size at all, but two replies that disagree about the text
 * area. A rounded cell would put the compared rectangle on the wrong pixels, which this oracle,
 * which has no tolerance, must never do. Every way it can fail is named, so the refusal says which
 * reply was asked for and what came back.
 */
async function deriveCellSizeFromTextArea(
  ctx: PixelGeometryQuerySource,
  cellReason: TerminalQueryOutcome["reason"],
): Promise<{ geometry: PixelGeometry; source: PixelGeometrySource } | PixelGeometryRefusal> {
  const text = await ctx.queryWithSentinelOutcome("\x1b[14t", /\x1b\[4;(\d+);(\d+)t/)
  if (text.reason !== "reply") {
    return {
      missing: `the terminal answered CSI 16 t (cell size in pixels) with ${cellReason} and CSI 14 t (text area in pixels) with ${text.reason}, so no cell size can be mapped`,
      transient: text.reason === "timeout",
    }
  }
  const area = await ctx.queryWithSentinelOutcome("\x1b[18t", /\x1b\[8;(\d+);(\d+)t/)
  if (area.reason !== "reply") {
    return {
      missing: `the terminal answered CSI 16 t (cell size in pixels) with ${cellReason} and CSI 18 t (text area in characters) with ${area.reason}, so no cell size can be mapped`,
      transient: area.reason === "timeout",
    }
  }
  const textHeight = Number(text.match?.[1])
  const textWidth = Number(text.match?.[2])
  const rows = Number(area.match?.[1])
  const columns = Number(area.match?.[2])
  if (!positive(textHeight) || !positive(textWidth) || !positive(rows) || !positive(columns)) {
    return {
      missing: `the terminal reported a text area that did not parse as positive numbers: ${textWidth}x${textHeight} pixels over ${columns}x${rows} characters`,
      transient: false,
    }
  }
  if (textHeight % rows !== 0 || textWidth % columns !== 0) {
    return {
      missing: `the terminal reported a ${textWidth}x${textHeight} pixel text area over ${columns}x${rows} characters, which does not divide into a whole-pixel cell size`,
      transient: false,
    }
  }
  return {
    geometry: { cellHeight: textHeight / rows, cellWidth: textWidth / columns, textHeight, textWidth },
    source: GEOMETRY_DERIVED,
  }
}

/** Shared grid, calibrated-footprint and terminal-report eligibility, in that order. */
export async function captureRegionGeometry(
  ctx: TermProbeSource,
  id: string,
  spec: RegionGeometrySpec,
  callerHasQuery = false,
): Promise<{ geometry: PixelGeometry | undefined; source: PixelGeometrySource } | ProbeCallbackResult> {
  // Geometry first: an undersized terminal is refused before a single query byte.
  const textMode = ctx.captureKind === "text-cells"
  const bounds = regionRefusal(id, { ...spec, pixelGeometry: PENDING_GEOMETRY }, ctx.rows, ctx.cols, textMode)
  if (bounds) return afterCallerBytes(bounds, callerHasQuery)
  // True on both text arms: Windows reads the console host's buffer and macOS reads the app's
  // own snapshot, so a label claiming "the terminal's own text" is false on Windows. The host
  // itself has one home, the per-read bufferOwner in the frame trace (30033 ruling f1f3c64b).
  if (textMode) return { geometry: undefined, source: "cells read from a text source, not from pixels" }
  const calibrated = ctx.captureGeometry?.geometry
  if (
    calibrated &&
    (calibrated.textWidth !== calibrated.cellWidth * ctx.cols ||
      calibrated.textHeight !== calibrated.cellHeight * ctx.rows)
  ) {
    return afterCallerBytes(
      refused(
        id,
        `${id}: calibrated pixel footprint ${calibrated.textWidth}x${calibrated.textHeight} no longer matches current grid ${ctx.rows}x${ctx.cols} at ${calibrated.cellWidth}x${calibrated.cellHeight} pixels per cell`,
      ),
      callerHasQuery,
    )
  }
  // Keep the existing query sequence and answers. Only a retained answer can justify query_reply;
  // having sent geometry queries is not itself an observable.
  let retainedReply = false
  const reported =
    ctx.captureGeometry ??
    (await queryPixelGeometry({
      async queryWithSentinelOutcome(...args) {
        const outcome = await ctx.queryWithSentinelOutcome(...args)
        retainedReply ||= outcome.raw.length > 0
        return outcome
      },
    }))
  if ("missing" in reported) {
    const note = `${id}: ${reported.missing}, so this run cannot map cells onto the captured window`
    if (!retainedReply) {
      return { pass: false, tests: [{ id: "criterion", status: "test-failure", reason: note }] }
    }
    return inconclusive(id, note, "insufficient-evidence", "query_reply")
  }
  return reported
}

/**
 * The whole region decision for one row, or null when this run has no owned capture. Bounds are
 * refused before any byte; then the terminal's own pixel report is queried here, once. A terminal
 * that answers those queries with something unusable is inconclusive BY NAME. Retained replies
 * carry query_reply observations; an unanswered query remains an execution failure, and a missing
 * report is never a capability verdict.
 *
 * `callerHasQuery` records that the caller already attempted its own query before asking. That
 * attempt preserves failure on a subsequent refusal; a genuinely unattempted fixture stays TODO.
 */
export async function captureRegionVerdict(
  ctx: TermProbeSource,
  id: string,
  spec: Omit<RegionReadback, "pixelGeometry">,
  callerHasQuery = false,
): Promise<ProbeCallbackResult | null> {
  const read = collectorRegionRead(ctx)
  if (!read) return null
  // A row whose reset clears two or more setup attributes has no reference independent of that
  // reset, so this oracle declines it BY NAME before a byte: a reference that misses the same part of
  // the cleared set would reproduce the fault and grade it supported.
  // A caller that already queried keeps that attempted failure when this oracle cannot proceed.
  if (spec.noIndependentReference) {
    return afterCallerBytes(refused(id, `${id}: ${spec.noIndependentReference}`), callerHasQuery)
  }
  const reported = await captureRegionGeometry(ctx, id, spec, callerHasQuery)
  if ("pass" in reported) return reported
  return afterCallerBytes(
    await captureRegionReadbackDecision(
      ctx,
      id,
      { ...spec, pixelGeometry: reported.geometry, geometrySource: reported.source },
      read,
    ),
    callerHasQuery,
  )
}

/**
 * The ONE capture lifecycle both pixel arms share, so no arm reimplements it and none forgets a half
 * Opening: SGR reset and DECTCEM off, so every capture of
 * the run sees the same cursor state. Closing, on every exit — decided, refused or thrown: the row's
 * own cleanup first (it clears the mode the last frame left set, which the prelude cannot reach),
 * then DECTCEM restored and the screen reset, so a run never leaves a hidden cursor or an inherited
 * mode behind for the next probe.
 */
export function beginCaptureLifecycle(ctx: TermProbeSource): void {
  ctx.write("\x1b[0m")
  ctx.write("\x1b[?25l")
}

/** Close the shared capture lifecycle, running the arm's mode cleanup before DECTCEM is restored. */
export function endCaptureLifecycle(ctx: TermProbeSource, cleanup?: string): void {
  if (cleanup !== undefined) ctx.write(cleanup)
  ctx.write("\x1b[?25h")
  ctx.write("\x1b[0m\x1b[2J\x1b[H")
}

/** What a capture must report to enter the stability control: its digests and its frame. */
export interface StabilityCapture {
  readonly regionDigest?: string | undefined
  readonly pixelsDigest?: string | undefined
  readonly frame: ObservationFrame
}

/**
 * The ONE stability control both capture arms use. Two reads of the compared cells must agree before either
 * arm compares extents or steps: the region oracle takes its pair on its prepared canvas before
 * the first verdict frame, and the DECSACE arm takes its pair on the painted seed, so a frame that only
 * looks stable after the measurement cannot pass. Pixel crops must occupy the same screen rectangle;
 * if either rectangle is absent, the existing both-digest proxy remains. With known matching crops,
 * or on a text arm, outside-cell whole-window motion is named rather than vetoed (30031, CTO cf70f234).
 * Both digest pairs and the whole-window-changed fact travel to the normal response as well as refusals.
 * The refusal is inconclusive, carries no target frames, and cites the second stability capture; no target frame is
 * fabricated. A pair whose reads both report no digest is not refused here: two absent digests
 * agree without showing anything about stability, so the arm that owns the frames names the missing
 * measurement when it compares them.
 *
 * It returns the pair's SECOND read, which is the frame both reads just agreed on. An arm that
 * measures against a stable seed takes it from here rather than keeping its own mutable copy, so one
 * read is both the stability witness and the seed and no unreachable absent-seed branch is needed.
 */
export async function captureStabilityPair<T extends StabilityCapture>(
  id: string,
  assertionType: "screenshot" | "buffer_state",
  first: () => Promise<T>,
  second: () => Promise<T>,
): Promise<{
  refusal: ProbeCallbackResult | null
  second: T
  stability: {
    regionDigest: Array<string | undefined>
    pixelsDigest: Array<string | undefined>
    frameDigest: Array<string | undefined>
    wholeWindowChanged: boolean | null
  }
}> {
  const stableA = await first()
  const stableB = await second()
  // DECSACE intentionally projects only its cell digest. Its original frame still owns whole-window
  // identity, so use that identity for narration without changing its existing comparison proxy.
  const wholeA = stableA.pixelsDigest ?? frameDigests(stableA.frame).whole
  const wholeB = stableB.pixelsDigest ?? frameDigests(stableB.frame).whole
  const stability = {
    regionDigest: [stableA.regionDigest, stableB.regionDigest],
    pixelsDigest: [stableA.pixelsDigest, stableB.pixelsDigest],
    frameDigest: [wholeA, wholeB],
    wholeWindowChanged: wholeA === undefined || wholeB === undefined ? null : wholeA !== wholeB,
  }
  const response = JSON.stringify({ stability })
  const knownCrops = stableA.frame.regionRectangle !== undefined && stableB.frame.regionRectangle !== undefined
  if (assertionType === "screenshot") {
    const movedCrop = cropPositionRefusal({
      id,
      compared: [
        { role: "the first stability capture", rectangle: stableA.frame.regionRectangle },
        { role: "the second stability capture", rectangle: stableB.frame.regionRectangle },
      ],
      response,
      frames: [],
      screenshotRef: stableB.frame.ref,
    })
    if (movedCrop) return { refusal: movedCrop, second: stableB, stability }
  }
  if (
    stableA.regionDigest === stableB.regionDigest &&
    (assertionType === "buffer_state" || knownCrops || stableA.pixelsDigest === stableB.pixelsDigest)
  ) {
    return { refusal: null, second: stableB, stability }
  }
  const refusal = inconclusive(
    id,
    `${id}: two captures of one static frame were not byte-stable (${stableA.regionDigest}/${stableA.pixelsDigest} then ${stableB.regionDigest}/${stableB.pixelsDigest})`,
    "insufficient-evidence",
    assertionType,
    // No target frame exists on this path and none is fabricated: the citation is the stability
    // capture actually taken. On a text arm there is no image to cite.
    assertionType === "screenshot" ? { screenshotRef: stableB.frame.ref } : {},
  )
  // The decisive evidence is the PAIR of reads, so both digests travel in the response even though
  // the observation carries no frames.
  return {
    refusal: {
      ...refusal,
      response,
    },
    second: stableB,
    stability,
  }
}

/**
 * Decide `id` from three cell-aligned captures of one run, each taken behind its own paint witness.
 * `read` is null when this run has no owned capture, in which case the caller's existing
 * capture-inconclusive path stays in force — a missing readback is never a negative.
 */
export async function captureRegionReadbackDecision(
  ctx: TermProbeSource,
  id: string,
  spec: RegionReadback,
  read: RegionRead | null,
): Promise<ProbeCallbackResult | null> {
  // How this decision was seen: the terminal's own cells on a text arm, pixels everywhere else.
  // Every branch below names it, so a published claim never says pixels it did not see.
  const assertionType = ctx.captureKind === "text-cells" ? ("buffer_state" as const) : ("screenshot" as const)
  /** A pixel verdict cites the frame the reader should look at; a text one has no image to point at. */
  const cite = (ref: string | undefined, frames: ObservationFrame[]) => ({
    ...(assertionType === "screenshot" && ref !== undefined ? { screenshotRef: ref } : {}),
    frames,
  })
  if (!read) return null
  const refusal = regionRefusal(id, spec, ctx.rows, ctx.cols, ctx.captureKind === "text-cells")
  if (refusal) return refusal
  if (spec.requiresUtf8 === true) {
    const decodingRefusal = await utf8DecodingRefusal(ctx, id)
    if (decodingRefusal) return decodingRefusal
  }
  const witnessCell: CellRegion = {
    top: spec.sentinel.row,
    left: spec.sentinel.col,
    bottom: spec.sentinel.row,
    right: spec.sentinel.col,
  }
  const park = `\x1b[${spec.cursorRow};1H`
  const timeoutMs = spec.timeoutMs > 0 ? spec.timeoutMs : DEFAULT_TIMEOUT_MS
  const pollMs = spec.pollMs ?? DEFAULT_POLL_MS
  const steps = [
    { role: "control" as const, label: `${id}: pre-edit seed`, writes: spec.seed },
    { role: "target" as const, label: `${id}: post-sequence target`, writes: `${spec.seed}${spec.edit}` },
    { role: "control" as const, label: `${id}: expected frame`, writes: spec.expected },
    ...(spec.ignored === undefined
      ? []
      : [{ role: "control" as const, label: `${id}: ignored-attribute frame`, writes: spec.ignored }]),
  ]
  const frames: ObservationFrame[] = []
  const digests: string[] = []
  // Each digest's own crop rectangle, pushed in lockstep with it: two digests mean the same cells
  // only when their rectangles match (29580).
  const cropRectangles: Array<CaptureRectangle | undefined> = []
  try {
    beginCaptureLifecycle(ctx)
    // Stability belongs to this run's cleared canvas, not the preceding probe's glyphs.
    // Each declared frame still gets its own seed writes and paint witness below.
    ctx.write("\x1b[2J\x1b[H")
    // Two reads of one static frame, before the first verdict: an unstable capture cannot decide.
    // The rule itself lives in captureStabilityPair, the one home both pixel arms call.
    const { refusal: instability, stability } = await captureStabilityPair(
      id,
      assertionType,
      () =>
        read({
          role: "control",
          label: `${id}: capture stability 1`,
          region: spec.region,
          pixelGeometry: spec.pixelGeometry,
        }),
      () =>
        read({
          role: "control",
          label: `${id}: capture stability 2`,
          region: spec.region,
          pixelGeometry: spec.pixelGeometry,
        }),
    )
    if (instability) return instability
    for (const [index, step] of steps.entries()) {
      ctx.write(step.writes)
      ctx.write(park)
      // The baseline is read after this step's frame paints, before its witness glyph is written.
      const baseline = await read({
        role: "control",
        label: `${step.label} — baseline`,
        region: witnessCell,
        pixelGeometry: spec.pixelGeometry,
      })
      ctx.write(`\x1b[${spec.sentinel.row};${spec.sentinel.col}H${witnessGlyph(index)}`)
      const result = await awaitPaintWitness({
        read,
        id,
        label: step.label,
        witnessCell,
        pixelGeometry: spec.pixelGeometry,
        geometrySource: spec.geometrySource,
        baseline,
        timeoutMs,
        pollMs,
        assertionType,
      })
      if (!witnessed(result)) return result
      frames.push(result.witness.frame)
      const measured = await read({
        role: step.role,
        label: step.label,
        region: spec.region,
        pixelGeometry: spec.pixelGeometry,
      })
      digests.push(measured.regionDigest)
      cropRectangles.push(measured.regionRectangle)
      frames.push(measured.frame)
    }
    const seed = digests[0]
    const after = digests[1]
    const expected = digests[2]
    const ignored = spec.ignored === undefined ? undefined : digests[3]
    if (
      seed === undefined ||
      after === undefined ||
      expected === undefined ||
      (spec.ignored !== undefined && ignored === undefined)
    ) {
      throw new Error(
        `${id}: the capture-region decision reached the verdict with ${digests.length} of ${steps.length} digests`,
      )
    }
    const observed = JSON.stringify({
      stability,
      region: spec.region,
      sentinel: spec.sentinel,
      cursorRow: spec.cursorRow,
      pixelGeometry: spec.pixelGeometry,
      geometrySource: spec.geometrySource,
      seed,
      after,
      expected,
      ...(ignored !== undefined && { ignored }),
    })
    const cropRefusal = cropPositionRefusal({
      id,
      compared: [
        { role: "the seed frame", rectangle: cropRectangles[0] },
        { role: "the post-sequence frame", rectangle: cropRectangles[1] },
        { role: "the expected frame", rectangle: cropRectangles[2] },
        ...(spec.ignored === undefined ? [] : [{ role: "the ignored-attribute frame", rectangle: cropRectangles[3] }]),
      ],
      response: observed,
      frames,
      ...(assertionType === "screenshot" ? { screenshotRef: frames[3]?.ref } : {}),
    })
    if (cropRefusal) return cropRefusal
    if (seed === expected) {
      return inconclusive(
        id,
        `${id}: the seed frame and the expected frame read the same cells, so this run cannot separate them`,
        "insufficient-evidence",
        assertionType,
        cite(frames[3]?.ref, frames),
      )
    }
    if (ignored !== undefined && ignored === expected) {
      return inconclusive(
        id,
        `${id}: the ignored-attribute frame and the expected frame read the same cells, so this run cannot separate them`,
        "insufficient-evidence",
        assertionType,
        cite(frames[3]?.ref, frames),
      )
    }
    const supported = after === expected
    // The decision table below is tested branch by branch:
    //   seed == expected             -> inconclusive, named (the run cannot separate them)
    //   expected == ignored          -> inconclusive, named (the run cannot separate them)
    //   after == expected            -> supported
    //   after == seed                -> unsupported (the sequence left the screen untouched)
    //   after == ignored             -> unsupported (the measured negative)
    //   otherwise                    -> inconclusive, naming the observation
    // The order is part of the contract: a match on the EXPECTED frame is decided before any
    // negative branch, so a frame cannot be called a negative while it is also the expected one.
    // A frame equal to `seed` is the sequence leaving the screen untouched; a frame equal to
    // `ignored` is the sequence running while dropping the attribute the row claims. Both are
    // measured negatives of the same claim, so both read `unsupported`, never `inconclusive`.
    const unsupported = after === seed || (ignored !== undefined && after === ignored)
    if (!supported && !unsupported) {
      // The three compared planes are pairwise distinct: the seed and the expected frame already
      // differ (the earlier `seed === expected` branch would have fired otherwise), and `after`
      // equals neither. State that OBSERVATION and nothing more: "matched none" told the reader
      // nothing, but naming a cause would be wrong, because a third distinct frame is also exactly
      // what a WRONG effect looks like (a DECDC that deleted the wrong column also yields
      // after != seed and after != expected). This oracle cannot tell an incorrect effect from a
      // rendering difference; one measured specimen of the latter is #28829 on xterm/linux (a
      // single anti-aliased edge pixel, 255,255,255 vs 239,239,239), but it is an example, never
      // the definition of the branch. Exact-digest equality stays: no tolerance, no similarity.
      // The axis space is named from THIS run's assertion type: a pixel digest moves under any of
      // three rendering axes, a text digest moves under characters or under the attributes the arm
      // reports, and an attribute the arm does not report leaves no trace in the digest at all.
      // Naming the axes is not naming a cause — which axis differed is exactly what this oracle
      // cannot decide — so the verdict and its reason stay as they are.
      const axes =
        assertionType === "screenshot"
          ? "this exact pixel-region digest cannot say which rendering axis differed — glyph edges, background attributes, and layout all change it — so it cannot tell an incorrect effect from a rendering difference"
          : "this exact cell digest covers the characters and, only where this arm reports them, the attributes — so it cannot say which of the two differed, and an attribute-only difference this arm does not report is invisible to it"
      const note = `${id}: a third distinct frame: the sequence changed the screen (after != seed) but not into the expected frame; ${axes} (compared frames: ${ignored === undefined ? "seed" : "seed, ignored-attribute"}, expected)`
      return {
        pass: false,
        response: observed,
        observation: {
          outcome: "inconclusive",
          reason: "insufficient-evidence",
          assertionType,
          ...cite(frames[3]?.ref, frames),
          note,
        },
      }
    }
    return {
      pass: supported,
      response: observed,
      observation: {
        outcome: supported ? "supported" : "unsupported",
        assertionType,
        ...cite(frames[3]?.ref, frames),
      },
      assertions: [
        {
          assertionType: assertionType,
          kind: supported ? "positive" : "negative",
          expected: `${id}: cell-aligned region ${JSON.stringify(spec.region)} equals the same-run expected frame after ${JSON.stringify(spec.edit)}, behind a paint witness in cell ${spec.sentinel.row},${spec.sentinel.col}`,
          observed: after,
        },
      ],
    }
  } finally {
    endCaptureLifecycle(ctx, spec.cleanup)
  }
}
