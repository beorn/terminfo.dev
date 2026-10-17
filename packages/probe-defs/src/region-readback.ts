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
  CapturePixelGeometry,
  CaptureRectangle,
  ObservationFrame,
  ProbeResult,
  TermContext,
  TerminalQueryOutcome,
} from "./types.ts"
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
  pixelGeometry: PixelGeometry
}) => Promise<RegionCapture>

/**
 * The collector-backed reader for a run whose capture adapter is installed, or null when this run
 * has no owned capture at all. A frame that came back without a digest is a collector bug, not a
 * measurement, so it raises instead of quietly degrading the verdict.
 */
export function collectorRegionRead(ctx: TermContext): RegionRead | null {
  const capture = ctx.capture
  if (!capture) return null
  return async ({ role, label, region, pixelGeometry }) => {
    const frame = await capture({ role, label, cells: region, pixelGeometry })
    if (frame.regionDigest === undefined || frame.pixelsDigest === undefined) {
      throw new Error(
        `${label}: the capture adapter returned no raw-pixel digest for the requested cells (regionDigest ${String(frame.regionDigest)}, pixelsDigest ${String(frame.pixelsDigest)})`,
      )
    }
    return {
      regionDigest: frame.regionDigest,
      pixelsDigest: frame.pixelsDigest,
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
   * it survived. Such a row
   * is INCONCLUSIVE BY NAME on the pixel path, before a byte, rather than graded against a reference
   * that shares the tested sequence's failure.
   */
  noIndependentReference?: string
  /** The terminal's own pixel report, carried into every capture request. */
  pixelGeometry: PixelGeometry
  /**
   * WHERE that report came from, in words, so a reader can tell a geometry problem from a slow paint
   * (@cto 2026-10-12, 28763 fix 1): a terminal that answers CSI 16 t is `reported by CSI 16 t`, and one
   * that answers only 14 t and 18 t is `derived from CSI 14 t / CSI 18 t`. Every number then names its
   * basis instead of leaving a derived cell size looking like a reported one.
   */
  geometrySource?: PixelGeometrySource
  /**
   * A write the run needs AFTER its frames — a mode or a scroll region the last frame leaves set,
   * which a later probe sharing this terminal must not inherit. Issued from the run's own `finally`,
   * so it lands exactly when this oracle wrote bytes: a refusal that wrote none leaves a zero-byte
   * trace, which run-parser's zero-byte rule requires of every `none` observation. Named for the JOB
   * (@cto 2026-10-12): `afterVerdict` named the moment it runs, and this is the write that clears the
   * mode the last frame left set.
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
  evidence: "pixels" | "none" | "query" = "pixels",
  citation?: { screenshotRef?: string; frames?: ObservationFrame[] },
): ProbeResult {
  return {
    pass: false,
    observation: {
      outcome: "inconclusive",
      reason,
      evidence,
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
function refused(id: string, note: string): ProbeResult {
  return inconclusive(id, note, "insufficient-evidence", "none")
}

/**
 * A caller that had already written and queried before asking (the DECRQSS SGR readback) cannot
 * carry evidence "none": run-parser requires a zero-byte trace for it. Rewrite any "none" refusal
 * into the same observation with truthful query evidence and say why in the note. Pixel verdicts and
 * every non-"none" refusal pass through untouched.
 */
function afterCallerBytes(result: ProbeResult | null, callerEvidence: "none" | "query"): ProbeResult | null {
  const observation = result?.observation
  if (callerEvidence === "none" || !observation || observation.evidence !== "none") return result
  return {
    ...result,
    observation: {
      ...observation,
      evidence: "query",
      note: `${observation.note ?? "refused"} — the caller wrote before this refusal, so this is not a zero-byte trace`,
    },
  }
}

function positive(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0
}

/** Refuse before any byte when the grid, the region, the witness or the pixel report cannot decide. */
function regionRefusal(id: string, spec: RegionReadback, rows: number, cols: number): ProbeResult | undefined {
  const minRows = spec.minRows ?? 1
  const minCols = spec.minCols ?? 1
  if (!Number.isSafeInteger(rows) || !Number.isSafeInteger(cols) || rows < minRows || cols < minCols) {
    return refused(
      id,
      `${id}: capture-region readback needs a measured grid of at least ${minRows}x${minCols}; measured ${rows}x${cols}`,
    )
  }
  const geometry = spec.pixelGeometry
  if (
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
  const { region, sentinel, cursorRow } = spec
  const edges = [region.top, region.left, region.bottom, region.right]
  if (edges.some((value) => !Number.isSafeInteger(value)) || !Number.isSafeInteger(cursorRow)) {
    return refused(id, `${id}: capture-region readback needs integer cell edges`)
  }
  if (region.top < 1 || region.left < 1 || region.bottom < region.top || region.right < region.left) {
    return refused(id, `${id}: compared region ${JSON.stringify(region)} is not a non-empty rectangle inside the grid`)
  }
  if (region.bottom > rows || region.right > cols) {
    return refused(id, `${id}: compared region ${JSON.stringify(region)} leaves the measured ${rows}x${cols} grid`)
  }
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
 * unable to tell a reported geometry from a derived one (@dev/review2 on 28763: the ordinary branch
 * returned before the payload carrying the source was built).
 */
async function awaitPaintWitness(options: {
  read: RegionRead
  id: string
  label: string
  witnessCell: CellRegion
  pixelGeometry: PixelGeometry
  geometrySource?: PixelGeometrySource
  baseline: RegionCapture
  timeoutMs: number
  pollMs: number
}): Promise<{ witness: RegionCapture } | ProbeResult> {
  const { read, id, label, witnessCell, pixelGeometry, geometrySource, baseline, timeoutMs, pollMs } = options
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
        "pixels",
        { screenshotRef: painted.frame.ref },
      )
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, pollMs)
    })
  }
}

function witnessed(result: { witness: RegionCapture } | ProbeResult): result is { witness: RegionCapture } {
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
function cropPositionRefusal(input: {
  id: string
  compared: Array<{ role: string; rectangle: CaptureRectangle | undefined }>
  response: string
  frames: ObservationFrame[]
  screenshotRef?: string
}): ProbeResult | null {
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
    observation: {
      outcome: "inconclusive",
      reason: "insufficient-evidence",
      evidence: "pixels",
      screenshotRef,
      frames,
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
 * The two bases named above, as a literal union (@dev/3's review note, @cto's call 2026-10-12): the
 * bare `string` this field carried let a THIRD spelling reach the payload without a type error, so a
 * reader could no longer tell a reported geometry from a derived one. Nothing else changes — the
 * constants are the only values ever assigned, so this is a type-only tightening.
 *
 * Named PixelGeometrySource and not GeometrySource (@cto, 28785 REVISE must 4): `GeometrySource` in
 * owned-terminal.ts names where the workflow's own CELL geometry came from — a different concept
 * answering a different question — and one name must not carry two.
 */
export type PixelGeometrySource =
  | typeof GEOMETRY_REPORTED
  | typeof GEOMETRY_DERIVED
  | "measured by complete raster calibration"

/**
 * Why a cell-to-pixel geometry could not be measured, and whether the cause is the terminal or this
 * run (@cto, 28785 REVISE rounds 1 and 2). A `timeout` — nothing answered at all, DA1 included — is
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
 * Everything the pixel-geometry queries below touch of a terminal context: ONE method, and nothing
 * else. Naming it lets a collector that owns the terminal ask the SAME implementation before it
 * starts a batch (there is no second geometry implementation to drift from), without inventing a
 * whole fake TermContext for a question that sends at most three QUERIES — CSI 16 t, then CSI 14 t
 * always, then CSI 18 t only when 16 t went unanswered — and reads at most TWO replies (a terminal
 * that answers 16 t is still asked 14 t for the text area).
 */
export type PixelGeometryContext = Pick<TermContext, "queryWithSentinelOutcome">

export async function queryPixelGeometry(
  ctx: PixelGeometryContext,
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
  ctx: PixelGeometryContext,
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

/**
 * The whole region decision for one row, or null when this run has no owned capture. Bounds are
 * refused before any byte; then the terminal's own pixel report is queried here, once. A terminal
 * that answers those queries with something unusable is inconclusive BY NAME with evidence "query"
 * — the query bytes are already written, so it is not the zero-byte "none" shape, and a missing
 * report is never a capability verdict.
 *
 * `refusalEvidence` is the caller's account of bytes it already wrote on this row before asking:
 * every "none" refusal below defaults to "none" only for a genuinely untouched run, and a caller
 * whose own readback (the DECRQSS SGR report) wrote and queried first passes "query", which is
 * applied to whichever refusal this oracle takes.
 */
export async function captureRegionVerdict(
  ctx: TermContext,
  id: string,
  spec: Omit<RegionReadback, "pixelGeometry">,
  refusalEvidence: "none" | "query" = "none",
): Promise<ProbeResult | null> {
  const read = collectorRegionRead(ctx)
  if (!read) return null
  // A row whose reset clears two or more setup attributes has no reference independent of that
  // reset, so this oracle declines it BY NAME before a byte: a reference that misses the same part of
  // the cleared set would reproduce the fault and grade it supported.
  // A caller that already wrote and queried says so: evidence "none" promises run-parser a
  // zero-byte trace, and that promise is false after a silent DECRQSS attempt.
  if (spec.noIndependentReference) {
    return afterCallerBytes(refused(id, `${id}: ${spec.noIndependentReference}`), refusalEvidence)
  }
  // Geometry first: an undersized terminal is refused before a single query byte.
  const bounds = regionRefusal(id, { ...spec, pixelGeometry: PENDING_GEOMETRY }, ctx.rows, ctx.cols)
  if (bounds) return afterCallerBytes(bounds, refusalEvidence)
  const calibrated = ctx.captureGeometry?.geometry
  if (
    calibrated &&
    (calibrated.textWidth !== calibrated.cellWidth * ctx.cols ||
      calibrated.textHeight !== calibrated.cellHeight * ctx.rows)
  ) {
    return afterCallerBytes(
      inconclusive(
        id,
        `${id}: calibrated pixel footprint ${calibrated.textWidth}x${calibrated.textHeight} no longer matches current grid ${ctx.rows}x${ctx.cols} at ${calibrated.cellWidth}x${calibrated.cellHeight} pixels per cell`,
        "insufficient-evidence",
        "none",
      ),
      refusalEvidence,
    )
  }
  const reported = ctx.captureGeometry ?? (await queryPixelGeometry(ctx))
  if ("missing" in reported) {
    return inconclusive(
      id,
      `${id}: ${reported.missing}, so this run cannot map cells onto the captured window`,
      "insufficient-evidence",
      "query",
    )
  }
  return afterCallerBytes(
    await captureRegionReadbackDecision(
      ctx,
      id,
      { ...spec, pixelGeometry: reported.geometry, geometrySource: reported.source },
      read,
    ),
    refusalEvidence,
  )
}

/**
 * Decide `id` from three cell-aligned captures of one run, each taken behind its own paint witness.
 * `read` is null when this run has no owned capture, in which case the caller's existing
 * capture-inconclusive path stays in force — a missing readback is never a negative.
 */
export async function captureRegionReadbackDecision(
  ctx: TermContext,
  id: string,
  spec: RegionReadback,
  read: RegionRead | null,
): Promise<ProbeResult | null> {
  if (!read) return null
  const refusal = regionRefusal(id, spec, ctx.rows, ctx.cols)
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
    ctx.write("\x1b[0m")
    // DECTCEM off before the first read, so every capture shares one cursor state.
    ctx.write("\x1b[?25l")
    // Two reads of one static frame, before the first verdict: an unstable capture cannot decide.
    const stableA = await read({
      role: "control",
      label: `${id}: capture stability 1`,
      region: witnessCell,
      pixelGeometry: spec.pixelGeometry,
    })
    const stableB = await read({
      role: "control",
      label: `${id}: capture stability 2`,
      region: witnessCell,
      pixelGeometry: spec.pixelGeometry,
    })
    if (stableA.regionDigest !== stableB.regionDigest || stableA.pixelsDigest !== stableB.pixelsDigest) {
      return inconclusive(
        id,
        `${id}: two captures of one static frame were not byte-stable (${stableA.regionDigest}/${stableA.pixelsDigest} then ${stableB.regionDigest}/${stableB.pixelsDigest})`,
        "insufficient-evidence",
        // No step has run yet, so no target frame exists: the citation is the stability read's ref.
        "pixels",
        { screenshotRef: stableB.frame.ref },
      )
    }
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
      screenshotRef: frames[3]?.ref,
    })
    if (cropRefusal) return cropRefusal
    if (seed === expected) {
      return inconclusive(
        id,
        `${id}: the seed frame and the expected frame read the same cells, so this run cannot separate them`,
        "insufficient-evidence",
        "pixels",
        { screenshotRef: frames[3]?.ref, frames },
      )
    }
    if (ignored !== undefined && ignored === expected) {
      return inconclusive(
        id,
        `${id}: the ignored-attribute frame and the expected frame read the same cells, so this run cannot separate them`,
        "insufficient-evidence",
        "pixels",
        { screenshotRef: frames[3]?.ref, frames },
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
      const note = `${id}: a third distinct frame: the sequence changed the screen (after != seed) but not into the expected frame; this exact-digest oracle cannot tell an incorrect effect from a rendering difference (compared frames: ${ignored === undefined ? "seed" : "seed, ignored-attribute"}, expected)`
      return {
        pass: false,
        response: observed,
        observation: {
          outcome: "inconclusive",
          reason: "insufficient-evidence",
          evidence: "pixels",
          screenshotRef: frames[3]?.ref,
          frames,
          note,
        },
      }
    }
    return {
      pass: supported,
      response: observed,
      observation: {
        outcome: supported ? "supported" : "unsupported",
        evidence: "pixels",
        screenshotRef: frames[3]?.ref,
        frames,
      },
      assertions: [
        {
          kind: supported ? "positive" : "negative",
          expected: `${id}: cell-aligned region ${JSON.stringify(spec.region)} equals the same-run expected frame after ${JSON.stringify(spec.edit)}, behind a paint witness in cell ${spec.sentinel.row},${spec.sentinel.col}`,
          observed: after,
        },
      ],
    }
  } finally {
    // The row's own cleanup first — it clears the mode the last frame left set, which the prelude
    // below cannot reach — then DECTCEM restored and the screen reset, so a refused or thrown run
    // leaves no hidden cursor and no inherited mode.
    if (spec.cleanup !== undefined) ctx.write(spec.cleanup)
    ctx.write("\x1b[?25h")
    ctx.write("\x1b[0m\x1b[2J\x1b[H")
  }
}
