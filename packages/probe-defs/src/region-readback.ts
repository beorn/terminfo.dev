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
 * Declared visual rows additionally require a same-cell space/glyph/space/glyph digest roundtrip:
 * an intermediate clear of the preceding glyph must not masquerade as the requested paint. This
 * assumes faithful current captures and ordered paint; it is not a general compositor fence.
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
  ColourNoAttributeWitness,
  ObservationFrame,
  ProbeCallbackResult,
  MeasuredProbeCallbackResult,
  TermProbeSource,
  TerminalQueryOutcome,
} from "./types.ts"
import { frameDigests } from "./types.ts"
import { replyFailure, utf8DecodingRefusal } from "./helpers.ts"
import { CALIBRATION_SOLID_PAINT } from "./calibrated-capture-geometry.ts"

export type CellRegion = CaptureCells
export type PixelGeometry = CapturePixelGeometry

/** The shared top-left paint-witness cell used by capture-region families whose target cells sit below row 1. */
export const SENTINEL = { row: 1, col: 1 } as const

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
  /** One visual signal and whether its qualified expected frame changes the seed. Omit for legacy decisions. */
  discriminator?: { signal: string; expected: "change" | "no-change" }
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
   * discriminator is the whole point. For a reset's preserve claim, this is the frame with the
   * preserved attribute also cleared. Absent when the row has no attribute to ignore.
   */
  ignored?: string
  /** Independently authored full setup; the observed seed must match before any reset verdict. */
  setupReference?: string
  /**
   * The frame that paints NO attribute at all — not the seed, which may carry the attribute the row
   * qualifies. A colour claim may never read support from it. A terminal that does not implement the
   * row's sequence but walks the SGR parameter list code by code reaches the literal `0` inside
   * `58;2;255;0;128` and resets the rendition, so its styled sample equals plain text while still
   * differing from an attributed seed: without this frame that difference reads as support. Screen
   * 5.0.2 published exactly that false positive for `sgr.underline.color` (@dev/luna6, 2026-11-10;
   * xterm 411 carries the same digest signature, bytes not replayed). Absent when the seed already
   * paints nothing, where the `seed === expected` check below is this same test.
   */
  noAttribute?: string
  /**
   * Declare that an expected frame equal to `noAttribute` is a MEASURED NEGATIVE, not an
   * unseparable fixture: the terminal ran the sequence and its result is indistinguishable from
   * painting nothing, while `seed` shows the attribute it should have decorated was painting a
   * moment earlier in the same run. Only a row that qualifies an attribute the seed carries can
   * declare this; where the seed paints nothing the `seed === expected` check decides first.
   * The frames are already freshness-checked (`awaitPaintWitness`) before this comparison, so a
   * stale expected frame refuses earlier and never reaches here (@cto 4ed6bddf).
   */
  noAttributeNegative?: { sequence: string }
  /**
   * The frame a terminal LACKING the row's sequence paints when it walks the sequence's SGR
   * parameters code by code: the seed plus the static attribute the walk lands on, set on purpose.
   * The row's sequence is chosen so that walk ends on an attribute a crop can see and holds still
   * (xterm takes `58;5;9;25` as blink on, crossed-out, blink off: @cto b6db70c8, #33181). An
   * expected frame equal to this one, with the post-sequence frame agreeing, is a MEASURED
   * NEGATIVE in pixels. A frame equal to the seed cannot see the attribute and decides nothing.
   */
  walkedAttribute?: { frame: string; sequence: string; attribute: string }
  /**
   * Qualify an immutable initial rendition with DECSC/DECRC before testing a reset. `expected`
   * paints the sample without setters, `seed` sets the full rendition and `edit` applies the reset.
   * Every subset must differ from the initial sample and every restore must return it exactly.
   * One subset may declare `expected: true`: its crop replaces initial N as the target's expected
   * state, and must differ from N and every other subset before the target is sent. With no flag,
   * the initial-N verdict is unchanged. Multiple expected subsets are a declaration error.
   * The made-up control must preserve the repeated seed. Uses this oracle's capture lifecycle.
   */
  savedRendition?: {
    subsets: readonly { label: string; sequence: string; expected?: true }[]
    control: { label: string; sequence: string }
    signal: string
    branch: string
  }
  /**
   * Two row groups of `region`, read on the seed, target and expected frames right after each
   * frame's region read: the rows `above` the cursor and the rows `atOrBelow` it. Consulted only when
   * the region reads a third frame: the target's rows above equal the seed's, the expected frame's
   * rows above differ from the seed's, and the target's rows at and below equal the expected
   * frame's — all three by exact digest over matching rectangles — is the measured negative,
   * `unsupportedNote`. Anything else keeps the third-frame verdict. erase.screen.above alone
   * declares it (#32581, @cto 52b0229c and a290eaa2); a second row needing it goes back to @cto.
   */
  cursorRowGroups?: { above: CellRegion; atOrBelow: CellRegion; unsupportedNote: string }
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
): MeasuredProbeCallbackResult {
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
 * shape — it reports evidence "query" instead (see captureRegionCallbackResult).
 */
function refused(id: string, note: string): ProbeCallbackResult {
  return { pass: false, tests: [{ id: "criterion", status: "probe-todo", reason: note }] }
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
        status: "probe-invalid",
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
 * the frame moving while the witness cell stands still does not name a cause, and nothing moving
 * at all means no paint witness within the bound.
 * BOTH shapes name the basis the rectangle was measured with, so a timeout never leaves a reader
 * unable to tell a reported geometry from a derived one (28763: the ordinary branch
 * returned before the payload carrying the source was built).
 */
export async function awaitPaintWitness(options: {
  read: RegionRead
  id: string
  label: string
  witnessCell: CellRegion
  pixelGeometry?: PixelGeometry
  geometrySource?: PixelGeometrySource
  baseline: RegionCapture
  timeoutMs: number
  pollMs: number
  /** Declared pixel decisions cannot treat a crop shift as a paint witness. */
  requireSameCrop?: boolean
  /** A declared roundtrip must return to this measured digest, not merely change again. */
  expectedDigest?: string
  priorFrames?: ObservationFrame[]
  /** How this run sees its frames: the timeout branch names it rather than claiming pixels. */
  assertionType?: "screenshot" | "buffer_state"
  /**
   * The layout check for the "witness still while the frame moved" timeout: its clause replaces
   * "cause not determined" only when it has one. Run after the probe's own reads, never before.
   */
  layout?: () => Promise<string | undefined>
}): Promise<{ witness: RegionCapture } | ProbeCallbackResult> {
  const { read, id, label, witnessCell, pixelGeometry, geometrySource, baseline, timeoutMs, pollMs, requireSameCrop } =
    options
  const assertionType = options.assertionType ?? "screenshot"
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const painted = await read({
      role: "control",
      label: `${label} — paint witness`,
      region: witnessCell,
      pixelGeometry,
    })
    if (
      requireSameCrop &&
      (!baseline.regionRectangle ||
        !painted.regionRectangle ||
        !sameRectangle(baseline.regionRectangle, painted.regionRectangle))
    ) {
      const baselineCrop = baseline.regionRectangle ? rectangleSpelling(baseline.regionRectangle) : "missing"
      const paintedCrop = painted.regionRectangle ? rectangleSpelling(painted.regionRectangle) : "missing"
      return inconclusive(
        id,
        `${id}: paint witness crop moved between its baseline (${baselineCrop}) and witness capture (${paintedCrop}); the changed crop cannot establish freshness`,
        "insufficient-evidence",
        assertionType,
        {
          screenshotRef: painted.frame.ref,
          frames: [...(options.priorFrames ?? [baseline.frame]), painted.frame],
        },
      )
    }
    if (
      options.expectedDigest === undefined
        ? painted.regionDigest !== baseline.regionDigest
        : painted.regionDigest === options.expectedDigest
    ) {
      return { witness: painted }
    }
    const frameMoved = painted.pixelsDigest !== baseline.pixelsDigest
    if (Date.now() >= deadline) {
      const layoutClause =
        options.expectedDigest === undefined && frameMoved && assertionType === "screenshot"
          ? await options.layout?.()
          : undefined
      return inconclusive(
        id,
        options.expectedDigest !== undefined
          ? `${id}: no paint witness return to the measured sentinel digest within ${timeoutMs} ms after ${label}; the requested space/glyph roundtrip did not complete`
          : frameMoved
            ? `${id}: witness cell ${witnessCell.top},${witnessCell.left} unchanged for ${timeoutMs} ms after ${label} while the frame changed; ${layoutClause ?? "cause not determined"}`
            : `${id}: no paint witness within ${timeoutMs} ms after ${label}; the terminal left the witness cell unpainted, so this run cannot separate a painted frame from a stale one (cell geometry ${geometrySource ?? "unknown"})`,
        "timeout",
        assertionType,
        // A text timeout cites no frame: a lone frame is not the pair a verdict needs, and the row
        // is inconclusive about the paint, not about a snapshot it could point a reader at.
        assertionType === "screenshot"
          ? {
              screenshotRef: painted.frame.ref,
              ...(requireSameCrop ? { frames: [...(options.priorFrames ?? [baseline.frame]), painted.frame] } : {}),
            }
          : {},
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

/** Calibration's own cell tolerance: one blended pixel line may sit at each edge of a painted cell. */
const CELL_EDGE_TOLERANCE_PX = 1

/**
 * Where calibration's sentinel paint lands now at `cell`, asked only after a probe's own reads ended
 * undecided (33000). Warp's normal screen is a command block whose header can cover the rows
 * calibration measured, so a crop at the calibrated cell reads the header instead of the probe.
 * Returns the clause the open reason gains, or undefined when no check can run on this run (no
 * pixel capture, or a calibration that recorded no sentinel) or when the sentinel sits inside the
 * calibrated crop, so an unmoved window keeps today's sentence. It changes reason text only: it
 * can never decide a cell. It repaints one cell and restores it to a blank default cell, with the
 * cursor and rendition saved and restored around both writes; the probe's own teardown follows.
 */
export async function layoutSinceCalibration(check: {
  ctx: Pick<TermProbeSource, "write" | "capture" | "captureKind" | "captureGeometry">
  label: string
  cell: { row: number; col: number }
  /** The pixels the calibrated geometry gives `cell` on this run. */
  calibratedCrop: CaptureRectangle
  timeoutMs: number
  pollMs: number
}): Promise<string | undefined> {
  const { ctx, label, cell, calibratedCrop: crop, timeoutMs, pollMs } = check
  const sentinel = ctx.captureGeometry?.sentinel
  if (!ctx.capture || ctx.captureKind === "text-cells" || !sentinel) return undefined
  const at = `\x1b[${cell.row};${cell.col}H`
  const where = `cell ${cell.row},${cell.col}`
  let located: ObservationFrame["located"]
  ctx.write(`\x1b7${at}\x1b[0m${CALIBRATION_SOLID_PAINT[sentinel.form]} \x1b[0m\x1b8`)
  try {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const frame = await ctx.capture({
        role: "control",
        label: `${label} — layout check`,
        locate: { rgb: sentinel.rgb },
      })
      located = frame.located
      if (located !== null || Date.now() >= deadline) break
      await new Promise<void>((resolve) => {
        setTimeout(resolve, pollMs)
      })
    }
  } finally {
    ctx.write(`\x1b7${at}\x1b[0m \x1b8`)
  }
  if (located === undefined) {
    return `layout check unanswered: the capture arm returned no located field for calibration's sentinel at ${where}`
  }
  if (located === null) {
    return `probe text not in view: calibration's sentinel painted at ${where} is nowhere in the window within ${timeoutMs} ms`
  }
  const { box, pixels } = located
  const fits = (size: number, cellSize: number) => size <= cellSize && size >= cellSize - 2 * CELL_EDGE_TOLERANCE_PX
  if (pixels !== box.width * box.height || !fits(box.width, crop.width) || !fits(box.height, crop.height)) {
    return `sentinel found but not as one cell block: ${pixels} px in a ${box.width}x${box.height} box at ${box.x},${box.y}, against a ${crop.width}x${crop.height} cell painted at ${where}`
  }
  if (
    box.x >= crop.x &&
    box.y >= crop.y &&
    box.x + box.width <= crop.x + crop.width &&
    box.y + box.height <= crop.y + crop.height
  ) {
    return undefined
  }
  return `window layout moved since calibration: calibration's sentinel painted at ${where} landed at ${box.x},${box.y}, ${box.x - crop.x},${box.y - crop.y} px from its calibrated crop at ${crop.x},${crop.y}`
}

/** The layout check for one witness cell, when its baseline crop says where calibration put it. */
function layoutCheckFor(
  ctx: TermProbeSource,
  label: string,
  witnessCell: CellRegion,
  baseline: RegionCapture | undefined,
  timeoutMs: number,
  pollMs: number,
): (() => Promise<string | undefined>) | undefined {
  const calibratedCrop = baseline?.regionRectangle
  if (!calibratedCrop) return undefined
  return () =>
    layoutSinceCalibration({
      ctx,
      label,
      cell: { row: witnessCell.top, col: witnessCell.left },
      calibratedCrop,
      timeoutMs,
      pollMs,
    })
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
        status: "probe-invalid",
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

/** One row-group read of one compared frame: its region digest and the rectangle it was cropped at. */
interface RowGroupRead {
  digest: string
  rectangle: CaptureRectangle | undefined
}

/**
 * One frame's declared row groups, read right after its region read. Nothing is written between the
 * reads, so they see the same screen; each keeps its own frame and digest, and a repaint between them
 * fails an equality in rowGroupsNegative instead of producing a negative.
 */
async function readRowGroups(
  read: RegionRead,
  step: { role: ObservationFrame["role"]; label: string },
  groups: NonNullable<RegionReadback["cursorRowGroups"]>,
  pixelGeometry: RegionReadback["pixelGeometry"],
  frames: ObservationFrame[],
): Promise<RowGroupRead[]> {
  const reads: RowGroupRead[] = []
  for (const [name, region] of [
    ["rows above the cursor", groups.above],
    ["rows at and below the cursor", groups.atOrBelow],
  ] as const) {
    const group = await read({ role: step.role, label: `${step.label} — ${name}`, region, pixelGeometry })
    reads.push({ digest: group.regionDigest, rectangle: group.regionRectangle })
    frames.push(group.frame)
  }
  return reads
}

/** The declared row groups' Unsupported, citing every frame the region verdict would have cited. */
function rowGroupsUnsupported(
  id: string,
  edit: string,
  groups: NonNullable<RegionReadback["cursorRowGroups"]>,
  reads: RowGroupRead[][],
  response: string,
  evidence: { assertionType: "buffer_state" | "screenshot"; screenshotRef?: string; frames: ObservationFrame[] },
): ProbeCallbackResult {
  return {
    pass: false,
    response,
    observation: { outcome: "unsupported", ...evidence, note: groups.unsupportedNote },
    assertions: [
      {
        assertionType: evidence.assertionType,
        kind: "negative",
        expected: `${id}: the rows above the cursor ${JSON.stringify(groups.above)} change from the seed to the same-run expected frame, and the rows at and below it ${JSON.stringify(groups.atOrBelow)} match that frame after ${JSON.stringify(edit)}`,
        observed: JSON.stringify({
          above: reads.map(([above]) => above?.digest),
          atOrBelow: reads.map(([, atOrBelow]) => atOrBelow?.digest),
        }),
      },
    ],
  }
}

/**
 * The declared row groups' measured negative (#32581, @cto a290eaa2), over the seed, target and
 * expected frames' [above, at-or-below] reads. All three must hold by exact digest: the target's rows
 * above the cursor equal the seed's; the expected frame's rows above differ from the seed's, without
 * which an unchanged row shows nothing; and the target's rows at and below equal the expected
 * frame's. A group cropped at different rectangles was never read over the same cells, so it decides
 * nothing, and neither does a missing read.
 */
function rowGroupsNegative(reads: RowGroupRead[][]): boolean {
  const frames = reads.map(([above, atOrBelow]) => (above && atOrBelow ? { above, atOrBelow } : undefined))
  const [seed, target, expected] = frames
  if (frames.length !== 3 || !seed || !target || !expected) return false
  const sameCrop = (left: CaptureRectangle | undefined, right: CaptureRectangle | undefined) =>
    left === undefined ? right === undefined : right !== undefined && sameRectangle(left, right)
  const sameCells = (group: "above" | "atOrBelow") =>
    [target, expected].every((frame) => sameCrop(frame[group].rectangle, seed[group].rectangle))
  return (
    sameCells("above") &&
    sameCells("atOrBelow") &&
    target.above.digest === seed.above.digest &&
    expected.above.digest !== seed.above.digest &&
    target.atOrBelow.digest === expected.atOrBelow.digest
  )
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
 * `captureRegionCallbackResult` grades a missing report the same way whichever it is, because a row that
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
  let missingRequiredReply = false
  const reported =
    ctx.captureGeometry ??
    (await queryPixelGeometry({
      async queryWithSentinelOutcome(...args) {
        const outcome = await ctx.queryWithSentinelOutcome(...args)
        retainedReply ||= outcome.raw.length > 0
        missingRequiredReply ||=
          (args[0] === "\x1b[14t" || args[0] === "\x1b[18t") && outcome.reason === "timeout" && outcome.raw === ""
        return outcome
      },
    }))
  if ("missing" in reported) {
    const note = `${id}: ${reported.missing}, so this run cannot map cells onto the captured window`
    if (!retainedReply) {
      if (missingRequiredReply) return replyFailure(note)
      return { pass: false, tests: [{ id: "criterion", status: "probe-invalid", reason: note }] }
    }
    return {
      ...inconclusive(id, note, "insufficient-evidence", "query_reply"),
      tests: [{ id: "criterion", status: "probe-invalid", reason: note }],
      ...(missingRequiredReply ? { replyFailureTestIds: ["criterion"] } : {}),
    }
  }
  return reported
}

/**
 * The whole region decision for one row, or null when this run has no owned capture. Bounds are
 * refused before any byte; then the terminal's own pixel report is queried here, once. A terminal
 * that answers those queries with something unusable is inconclusive BY NAME. Retained replies
 * carry query_reply observations; an unanswered query remains an execution failure, and a missing
 * report is never a feature verdict.
 *
 * `callerHasQuery` records that the caller already attempted its own query before asking. That
 * attempt preserves failure on a subsequent refusal; a genuinely unattempted fixture stays TODO.
 */
export async function captureRegionCallbackResult(
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
  if (spec.noIndependentReference && (!spec.savedRendition || ctx.captureKind === "text-cells")) {
    return afterCallerBytes(refused(id, `${id}: ${spec.noIndependentReference}`), callerHasQuery)
  }
  const reported = await captureRegionGeometry(ctx, id, spec, callerHasQuery)
  if ("pass" in reported) return reported
  const decided = await captureRegionReadbackDecision(
    ctx,
    id,
    { ...spec, pixelGeometry: reported.geometry, geometrySource: reported.source },
    read,
  )
  // A completed declared visual review is a deliberate TODO, including after caller query bytes.
  // Geometry and bounds refusals took earlier paths and keep their existing failure disposition.
  if (spec.savedRendition || (spec.discriminator && decided?.criterionBranch === "visual-review")) return decided
  return afterCallerBytes(decided, callerHasQuery)
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

/** Close the shared lifecycle; an independently saved rendition can replace the default SGR0. */
export function endCaptureLifecycle(ctx: TermProbeSource, cleanup?: string, rendition = "\x1b[0m"): void {
  if (cleanup !== undefined) ctx.write(cleanup)
  ctx.write("\x1b[?25h")
  ctx.write(`${rendition}\x1b[2J\x1b[H`)
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

/** The approved same-run SGR attribute kind. Other SGR capture callers and text arms stay on
 * their existing paths. Equality is read only over the measured sample, never the cursor. */
export async function sgrAttributeCaptureResult(
  ctx: TermProbeSource,
  id: string,
  sequence: string,
): Promise<ProbeCallbackResult | null> {
  if (!ctx.capture || ctx.captureKind === "text-cells" || id === "sgr.blink") return null
  const read = collectorRegionRead(ctx)
  if (!read) return null
  const sample = "AaBb 0123456789 - terminal text"
  const region = { top: 3, left: 3, bottom: 3, right: 2 + sample.length }
  const spec = { region, sentinel: SENTINEL, cursorRow: 2, minRows: 3, minCols: 34 }
  const reported = await captureRegionGeometry(ctx, id, spec, true)
  if ("pass" in reported) return reported
  const pixelGeometry = reported.geometry
  const witnessCell = { top: 1, left: 1, bottom: 1, right: 1 }
  const phases = [
    { name: "plain", sequence: "", sample },
    { name: "target", sequence, sample },
    { name: "made-up", sequence: "\x1b[99m", sample },
    { name: "handled", sequence: id === "sgr.inverse" ? "\x1b[4m" : "\x1b[7m", sample },
    ...(id !== "sgr.inverse" ? [{ name: "inverse", sequence: "\x1b[7m", sample }] : []),
    ...((id.startsWith("sgr.underline.") && id !== "sgr.underline.single") ||
    id === "sgr.overline" ||
    id === "sgr.strikethrough"
      ? [{ name: "single underline", sequence: "\x1b[4m", sample }]
      : []),
    ...(id === "sgr.hidden" ? [{ name: "blank", sequence: "", sample: " ".repeat(sample.length) }] : []),
  ]
  const frames: ObservationFrame[] = []
  const measured: Array<{ name: string; capture: RegionCapture }> = []
  let stability: unknown
  const finish = (
    status: "supported" | "unsupported" | "probe-todo" | "probe-invalid",
    note: string,
  ): ProbeCallbackResult => {
    const target = measured.find(({ name }) => name === "target")?.capture.frame
    const decided = status === "supported" || status === "unsupported"
    const response = JSON.stringify({
      region,
      pixelGeometry,
      geometrySource: reported.source,
      stability,
      samples: Object.fromEntries(measured.map(({ name, capture }) => [name, capture.regionDigest])),
    })
    return {
      pass: status === "supported",
      note,
      response,
      criterionBranch: "sgr-attribute-same-run",
      tests: [{ id: "attribute", status, ...(decided ? { assertionRefs: [0] } : { reason: note }) }],
      observation: {
        outcome: decided ? status : "inconclusive",
        assertionType: "screenshot",
        ...(decided ? {} : { reason: "insufficient-evidence" as const }),
        screenshotRef: target?.ref ?? frames.at(-1)?.ref,
        frames,
        note,
      },
      ...(decided
        ? {
            assertions: [
              {
                assertionType: "screenshot" as const,
                kind: status === "supported" ? ("positive" as const) : ("negative" as const),
                expected: `${id}: same-run plain, made-up and handled controls qualify the attribute`,
                observed: response,
              },
            ],
          }
        : {}),
    }
  }
  try {
    beginCaptureLifecycle(ctx)
    ctx.write("\x1b[2J\x1b[H")
    const stableRead = async (label: string) => {
      const capture = await read({ role: "control", label, region, pixelGeometry })
      frames.push(capture.frame)
      return capture
    }
    const pair = await captureStabilityPair(
      id,
      "screenshot",
      () => stableRead(`${id}: capture stability 1`),
      () => stableRead(`${id}: capture stability 2`),
    )
    stability = pair.stability
    if (pair.refusal) return finish("probe-todo", pair.refusal.observation?.note ?? `${id}: capture is not stable`)
    // Bind the existing witness to these retained captures. Replaying those
    // captures derives the same nonce; another callback cannot borrow buffered output.
    const nonceBytes = await globalThis.crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(JSON.stringify([id, ...frames.map(({ ref, capturedAt }) => [ref, capturedAt])])),
    )
    const witnessNonce = Array.from(new Uint8Array(nonceBytes), (byte) => byte.toString(16).padStart(2, "0"))
      .join("")
      .slice(0, 24)
    for (const [index, phase] of phases.entries()) {
      const label = `${id}: ${phase.name}`
      ctx.write(`\x1b[0m\x1b[2J\x1b[3;3H${phase.sequence}${phase.sample}\x1b[0m\x1b[2;1H\x1b[1;1H `)
      const baseline = await read({ role: "control", label: `${label} — baseline`, region: witnessCell, pixelGeometry })
      const options = {
        read,
        id,
        label,
        witnessCell,
        pixelGeometry,
        geometrySource: reported.source,
        baseline,
        timeoutMs: DEFAULT_TIMEOUT_MS,
        pollMs: DEFAULT_POLL_MS,
        requireSameCrop: true,
        layout: layoutCheckFor(ctx, label, witnessCell, baseline, DEFAULT_TIMEOUT_MS, DEFAULT_POLL_MS),
      }
      const glyph = `${witnessGlyph(index)}-${witnessNonce}`
      ctx.write(`\x1b[1;1H${glyph}`)
      const painted = await awaitPaintWitness(options)
      if (!witnessed(painted)) return finish("probe-todo", painted.observation?.note ?? `${id}: no paint witness`)
      frames.push(baseline.frame, painted.witness.frame)
      // Reuse the existing witness roundtrip: a transient clear cannot impersonate the requested paint.
      for (const [write, expectedDigest] of [
        [" ", baseline.regionDigest],
        [glyph, painted.witness.regionDigest],
      ] as const) {
        ctx.write(`\x1b[1;1H${write}`)
        const returned = await awaitPaintWitness({ ...options, expectedDigest })
        if (!witnessed(returned)) {
          return finish("probe-todo", returned.observation?.note ?? `${id}: no paint witness return`)
        }
        frames.push(returned.witness.frame)
      }
      const capture = await read({ role: phase.name === "target" ? "target" : "control", label, region, pixelGeometry })
      if (!capture.regionRectangle) throw new Error(`${label}: pixel capture omitted the measured sample rectangle`)
      frames.push(capture.frame)
      measured.push({ name: phase.name, capture })
    }
    const moved = cropPositionRefusal({
      id,
      compared: measured.map(({ name, capture }) => ({ role: name, rectangle: capture.regionRectangle })),
      response: JSON.stringify({ stability }),
      frames,
      screenshotRef: measured.find(({ name }) => name === "target")?.capture.frame.ref,
    })
    if (moved) return moved
    const digest = (name: string) => {
      const value = measured.find((entry) => entry.name === name)?.capture.regionDigest
      if (value === undefined) throw new Error(`${id}: missing same-run ${name} sample`)
      return value
    }
    const plain = digest("plain")
    const target = digest("target")
    // This order is the ruling: bad controls never become a terminal negative.
    if (digest("made-up") !== plain) {
      return finish("probe-invalid", `${id}: made-up SGR 99 changed the sample; Test broken`)
    }
    if (digest("handled") === plain) {
      return finish("probe-todo", `${id}: handled control drew nothing; capture is blind`)
    }
    if (target === plain) return finish("unsupported", `${id}: drew nothing for this SGR`)
    if (phases.some(({ name }) => name === "single underline") && target === digest("single underline")) {
      // A multiplexer negative stays on this branch so the collector's outer command read can
      // decide it (@cto 429f006d c); finalizeVisualResult keeps it open when that read is absent.
      return finish("unsupported", `${id}: drawn as single underline`)
    }
    if (id !== "sgr.inverse" && target === digest("inverse")) return finish("unsupported", `${id}: drawn as inverse`)
    if (id === "sgr.hidden") {
      return target === digest("blank")
        ? finish("supported", `${id}: target equals the same-cell blank reference`)
        : finish("probe-invalid", `${id}: hidden changed the sample without matching blank; Test broken`)
    }
    return finish("supported", `${id}: target differs from plain, made-up does not`)
  } finally {
    endCaptureLifecycle(ctx)
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
  const discriminator = spec.discriminator
  const savedRendition = spec.savedRendition
  if ((savedRendition?.subsets.filter((subset) => subset.expected).length ?? 0) > 1) {
    throw new Error(`${id}: more than one expected saved-rendition subset`)
  }
  const expectedSubset = savedRendition?.subsets.findIndex((subset) => subset.expected) ?? -1
  const witnessedPixels = discriminator !== undefined || savedRendition !== undefined
  const resetReference: {
    qualified: boolean
    checks: Array<{ phase: string; label: string; digest: string }>
    failedAt?: string
  } = { qualified: false, checks: [] }
  let initialRenditionSaved = false
  // Declared visual rows must tell the writer exactly why review remains open. Legacy callers
  // retain their existing observation-only result, including its historical timeout semantics.
  const review = (result: ProbeCallbackResult, reason?: string): ProbeCallbackResult => {
    if (savedRendition) {
      const note = reason ?? result.observation?.note ?? `${id}: saved rendition could not be qualified`
      resetReference.failedAt ??= note
      const response = JSON.stringify({
        resetReference,
        ...(result.response === undefined ? {} : { capture: result.response }),
        ...(result.observation?.frames === undefined ? {} : { frames: result.observation.frames }),
      })
      return {
        pass: false,
        response,
        criterionBranch: resetReference.qualified ? savedRendition.branch : "saved-rendition-unqualified",
        tests: [{ id: savedRendition.signal, status: "probe-invalid", reason: note }],
      }
    }
    if (!discriminator) return result
    const reviewReason = reason ?? result.observation?.note ?? `${id}: insufficient visual evidence`
    const targetFrameExists = result.observation?.frames?.some((frame) => frame.role === "target") ?? false
    if (result.observation && !targetFrameExists) {
      const { observation, assertions, ...execution } = result
      void assertions
      return {
        ...execution,
        criterionBranch: "visual-review",
        tests: [{ id: "review", status: "probe-todo", reason: reviewReason }],
        response: JSON.stringify({
          ...(result.response === undefined ? {} : { originalResponse: result.response }),
          review: {
            note: observation.note,
            ...(observation.screenshotRef === undefined ? {} : { screenshotRef: observation.screenshotRef }),
            ...(observation.frames === undefined ? {} : { frames: observation.frames }),
          },
        }),
      }
    }
    return {
      ...result,
      criterionBranch: "visual-review",
      tests: [{ id: "review", status: "probe-todo", reason: reviewReason }],
    }
  }
  if (!read) return witnessedPixels ? review(refused(id, "no freshness witness"), "no freshness witness") : null
  if (witnessedPixels && ctx.captureKind === "text-cells") {
    return refused(id, `${id}: declared visual signal requires pixel capture`)
  }
  if (witnessedPixels) {
    const capture = read
    read = async (request) => {
      const measured = await capture(request)
      const frame = measured.frame
      const rectangle = measured.regionRectangle
      const geometry = request.pixelGeometry
      if (
        frame.kind === "text-cells" ||
        !frame.regionDigest ||
        !frame.pixelsDigest ||
        frame.regionDigest !== measured.regionDigest ||
        frame.pixelsDigest !== measured.pixelsDigest ||
        !rectangle ||
        !frame.regionRectangle ||
        !sameRectangle(rectangle, frame.regionRectangle) ||
        !geometry ||
        ![rectangle.x, rectangle.y, rectangle.width, rectangle.height].every(Number.isInteger) ||
        rectangle.x < 0 ||
        rectangle.y < 0 ||
        rectangle.width <= 0 ||
        rectangle.height <= 0 ||
        rectangle.width !== (request.region.right - request.region.left + 1) * geometry.cellWidth ||
        rectangle.height !== (request.region.bottom - request.region.top + 1) * geometry.cellHeight
      ) {
        throw new Error(
          `${id}: declared visual capture requires actual pixel region/whole digests and matching cell-sized crop metadata (${request.label})`,
        )
      }
      return measured
    }
  }
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
  /** The last witness baseline: where calibration put the witness cell, for the layout check. */
  let witnessBaseline: RegionCapture | undefined
  const steps: Array<{
    role: ObservationFrame["role"]
    label: string
    writes: string
    phase?: "baseline" | "before" | "styled" | "restored" | "setup" | "control" | "target"
  }> = savedRendition
    ? [
        { role: "control", label: `${id}: initial N`, writes: spec.expected, phase: "baseline" },
        ...savedRendition.subsets.flatMap((subset) => [
          {
            role: "control" as const,
            label: `${id}: N before ${subset.label}`,
            writes: `\x1b8${spec.expected}`,
            phase: "before" as const,
          },
          {
            role: "control" as const,
            label: `${id}: subset ${subset.label}`,
            writes: `${subset.sequence}${spec.expected}`,
            phase: "styled" as const,
          },
          {
            role: "control" as const,
            label: `${id}: N restored after ${subset.label}`,
            writes: `\x1b8${spec.expected}`,
            phase: "restored" as const,
          },
        ]),
        { role: "control", label: `${id}: N before full setup`, writes: `\x1b8${spec.expected}`, phase: "before" },
        { role: "control", label: `${id}: repeated full setup`, writes: spec.seed, phase: "setup" },
        {
          role: "control",
          label: `${id}: ${savedRendition.control.label}`,
          writes: `${savedRendition.control.sequence}${spec.expected}`,
          phase: "control",
        },
        { role: "target", label: `${id}: reset target`, writes: spec.edit, phase: "target" },
      ]
    : [
        { role: "control" as const, label: `${id}: pre-edit seed`, writes: spec.seed },
        { role: "target" as const, label: `${id}: post-sequence target`, writes: `${spec.seed}${spec.edit}` },
        { role: "control" as const, label: `${id}: expected frame`, writes: spec.expected },
        ...(spec.ignored === undefined
          ? []
          : [{ role: "control" as const, label: `${id}: ignored-attribute frame`, writes: spec.ignored }]),
        ...(spec.setupReference === undefined
          ? []
          : [{ role: "control" as const, label: `${id}: setup reference frame`, writes: spec.setupReference }]),
        ...(spec.noAttribute === undefined
          ? []
          : [{ role: "control" as const, label: `${id}: no-attribute frame`, writes: spec.noAttribute }]),
        ...(spec.walkedAttribute === undefined
          ? []
          : [{ role: "control" as const, label: `${id}: walked-attribute frame`, writes: spec.walkedAttribute.frame }]),
      ]
  const frames: ObservationFrame[] = []
  let targetScreenshotRef: string | undefined
  const digests: string[] = []
  // Each digest's own crop rectangle, pushed in lockstep with it: two digests mean the same cells
  // only when their rectangles match (29580).
  const cropRectangles: Array<CaptureRectangle | undefined> = []
  // The declared row groups' [above, at-or-below] reads of the seed, target and expected frames.
  const rowGroups = spec.cursorRowGroups
  const groupReads: RowGroupRead[][] = []
  try {
    if (savedRendition) ctx.write("\x1b[?25l")
    else beginCaptureLifecycle(ctx)
    // Stability belongs to this run's cleared canvas, not the preceding probe's glyphs.
    // Each declared frame still gets its own seed writes and paint witness below.
    ctx.write("\x1b[2J\x1b[H")
    if (savedRendition) ctx.write(spec.expected)
    // Two reads of one static frame, before the first verdict: an unstable capture cannot decide.
    // The rule itself lives in captureStabilityPair, the one home both pixel arms call.
    const {
      refusal: instability,
      stability,
      second: stableBaseline,
    } = await captureStabilityPair(
      id,
      assertionType,
      async () => {
        const measured = await read({
          role: "control",
          label: `${id}: capture stability 1`,
          region: spec.region,
          pixelGeometry: spec.pixelGeometry,
        })
        frames.push(measured.frame)
        return measured
      },
      async () => {
        const measured = await read({
          role: "control",
          label: `${id}: capture stability 2`,
          region: spec.region,
          pixelGeometry: spec.pixelGeometry,
        })
        frames.push(measured.frame)
        return measured
      },
    )
    if (instability) return review(instability)
    for (const [index, step] of steps.entries()) {
      ctx.write(step.writes)
      ctx.write(park)
      // Writes can still be waiting for paint when this baseline is captured. Declared rows
      // challenge a space/glyph pair in both directions before trusting the requested paint.
      const sentinelWrite = `\x1b[${spec.sentinel.row};${spec.sentinel.col}H`
      if (witnessedPixels) ctx.write(`${sentinelWrite} `)
      const baseline = await read({
        role: "control",
        label: `${step.label} — baseline`,
        region: witnessCell,
        pixelGeometry: spec.pixelGeometry,
      })
      ctx.write(`${sentinelWrite}${witnessGlyph(index)}`)
      const witnessOptions = {
        read,
        id,
        label: step.label,
        witnessCell,
        pixelGeometry: spec.pixelGeometry,
        geometrySource: spec.geometrySource,
        baseline,
        timeoutMs,
        pollMs,
        requireSameCrop: witnessedPixels,
        assertionType,
        layout: layoutCheckFor(ctx, step.label, witnessCell, baseline, timeoutMs, pollMs),
      }
      witnessBaseline = baseline
      const result = await awaitPaintWitness(witnessOptions)
      if (!witnessed(result)) {
        return review(result, result.observation?.reason === "timeout" ? "no freshness witness" : undefined)
      }
      if (witnessedPixels) {
        const roundtripFrames = [baseline.frame, result.witness.frame]
        for (const [write, expectedDigest, label] of [
          [" ", baseline.regionDigest, "space return"],
          [witnessGlyph(index), result.witness.regionDigest, "glyph return"],
        ] as const) {
          ctx.write(`${sentinelWrite}${write}`)
          const returned = await awaitPaintWitness({
            ...witnessOptions,
            label: `${step.label} — ${label}`,
            expectedDigest,
            priorFrames: roundtripFrames,
          })
          if (!witnessed(returned)) {
            return review(returned, returned.observation?.reason === "timeout" ? "no freshness witness" : undefined)
          }
          roundtripFrames.push(returned.witness.frame)
        }
        frames.push(...roundtripFrames)
      } else {
        frames.push(result.witness.frame)
      }
      const measured = await read({
        role: step.role,
        label: step.label,
        region: spec.region,
        pixelGeometry: spec.pixelGeometry,
      })
      digests.push(measured.regionDigest)
      cropRectangles.push(measured.regionRectangle)
      frames.push(measured.frame)
      if (step.role === "target") targetScreenshotRef = measured.frame.ref
      if (savedRendition && step.phase) {
        resetReference.checks.push({ phase: step.phase, label: step.label, digest: measured.regionDigest })
        const response = () =>
          JSON.stringify({
            resetReference,
            stability,
            region: spec.region,
            pixelGeometry: spec.pixelGeometry,
            geometrySource: spec.geometrySource,
          })
        const invalid = (note: string) =>
          review({
            ...inconclusive(id, note, "insufficient-evidence", assertionType, cite(frames.at(-1)?.ref, frames)),
            response: response(),
          })
        const moved = cropPositionRefusal({
          id,
          compared: [
            { role: "initial stability", rectangle: stableBaseline.regionRectangle },
            { role: "initial N", rectangle: cropRectangles[0] },
            { role: step.label, rectangle: measured.regionRectangle },
          ],
          response: response(),
          frames,
        })
        if (moved) return invalid(`${step.label}: capture moved away from initial N`)
        const initial = digests[0]
        let failed = false
        if (step.phase === "baseline") {
          failed = measured.regionDigest !== stableBaseline.regionDigest
          // Save exactly once. Restores never redefine the reference to match a faulty reset.
          if (!failed) {
            ctx.write(`${park}\x1b7`)
            initialRenditionSaved = true
          }
        } else if (step.phase === "before" || step.phase === "restored") {
          failed = measured.regionDigest !== initial
        } else if (step.phase === "styled") {
          failed = measured.regionDigest === initial
        } else if (step.phase === "setup") {
          if (expectedSubset >= 0) {
            const styled = resetReference.checks.filter((check) => check.phase === "styled")
            const expected = styled[expectedSubset]?.digest
            if (
              expected === undefined ||
              expected === initial ||
              styled.some((check, index) => index !== expectedSubset && check.digest === expected)
            ) {
              return invalid(`${id}: expected subset is not separated from every wrong-state crop`)
            }
          }
          const full = resetReference.checks.findLast((check) => check.phase === "styled")
          failed = measured.regionDigest !== full?.digest
          resetReference.qualified = !failed
        } else if (step.phase === "control") {
          failed = measured.regionDigest !== digests[index - 1]
        } else if (step.phase === "target") {
          const expected =
            expectedSubset < 0
              ? initial
              : resetReference.checks.filter((check) => check.phase === "styled")[expectedSubset]?.digest
          const supported = measured.regionDigest === expected
          const subset = resetReference.checks.find(
            (check) => check.phase === "styled" && check.digest === measured.regionDigest,
          )
          if (!supported && measured.regionDigest !== initial && !subset) {
            return invalid(`${step.label}: target matches no retained baseline or styled subset`)
          }
          return {
            pass: supported,
            criterionBranch: savedRendition.branch,
            tests: [{ id: savedRendition.signal, status: supported ? "supported" : "unsupported", assertionRefs: [0] }],
            response: response(),
            observation: {
              outcome: supported ? "supported" : "unsupported",
              assertionType,
              ...cite(targetScreenshotRef, frames),
              ...(subset && !supported && { note: `${id}: target retains ${subset.label}` }),
            },
            assertions: [
              {
                assertionType,
                kind: supported ? "positive" : "negative",
                expected:
                  expectedSubset < 0
                    ? `${id}: reset returns the crop to immutable initial rendition ${initial}, after qualified subsets, restores and ${savedRendition.control.label}`
                    : `${id}: reset returns the crop to the independently separated expected subset ${expected}, after qualified subsets, restores and ${savedRendition.control.label}`,
                observed: measured.regionDigest,
              },
            ],
          }
        }
        if (failed) return invalid(`${step.label}: saved rendition qualification failed; target was not sent`)
      }
      if (rowGroups && index < 3) {
        groupReads.push(await readRowGroups(read, step, rowGroups, spec.pixelGeometry, frames))
      }
    }
    const seed = digests[0]
    const after = digests[1]
    const expected = digests[2]
    const ignored = spec.ignored === undefined ? undefined : digests[3]
    const referenceIndex = spec.ignored === undefined ? 3 : 4
    const setupReference = spec.setupReference === undefined ? undefined : digests[referenceIndex]
    const noAttribute =
      spec.noAttribute === undefined ? undefined : digests[referenceIndex + (spec.setupReference === undefined ? 0 : 1)]
    const walkedIndex =
      referenceIndex + (spec.setupReference === undefined ? 0 : 1) + (spec.noAttribute === undefined ? 0 : 1)
    const walked = spec.walkedAttribute === undefined ? undefined : digests[walkedIndex]
    if (
      seed === undefined ||
      after === undefined ||
      expected === undefined ||
      (spec.ignored !== undefined && ignored === undefined) ||
      (spec.setupReference !== undefined && setupReference === undefined) ||
      (spec.noAttribute !== undefined && noAttribute === undefined) ||
      (spec.walkedAttribute !== undefined && walked === undefined)
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
      ...(setupReference !== undefined && { setupReference }),
      ...(noAttribute !== undefined && { noAttribute }),
      ...(walked !== undefined && { walked }),
      ...(discriminator && { discriminator }),
    })
    const cropRefusal = cropPositionRefusal({
      id,
      compared: [
        { role: "the seed frame", rectangle: cropRectangles[0] },
        { role: "the post-sequence frame", rectangle: cropRectangles[1] },
        { role: "the expected frame", rectangle: cropRectangles[2] },
        ...(spec.ignored === undefined ? [] : [{ role: "the ignored-attribute frame", rectangle: cropRectangles[3] }]),
        ...(spec.setupReference === undefined
          ? []
          : [{ role: "the independent setup reference", rectangle: cropRectangles[referenceIndex] }]),
        ...(spec.noAttribute === undefined
          ? []
          : [
              {
                role: "the no-attribute frame",
                rectangle: cropRectangles[referenceIndex + (spec.setupReference === undefined ? 0 : 1)],
              },
            ]),
        ...(spec.walkedAttribute === undefined
          ? []
          : [{ role: "the walked-attribute frame", rectangle: cropRectangles[walkedIndex] }]),
      ],
      response: observed,
      frames,
      ...(assertionType === "screenshot" ? { screenshotRef: targetScreenshotRef } : {}),
    })
    if (cropRefusal) return cropRefusal
    if (setupReference !== undefined && seed !== setupReference) {
      const note = `${id}: the seed frame does not match the independent setup reference; required setup was not established (seed ${seed}, reference ${setupReference})`
      return review({
        ...inconclusive(id, note, "insufficient-evidence", assertionType, cite(frames.at(-1)?.ref, frames)),
        response: observed,
      })
    }
    if (discriminator?.expected === "no-change" && (seed !== expected || ignored === undefined)) {
      return review({
        ...inconclusive(
          id,
          `${id}: no-change requires a matching independent expected frame and a distinct ignored contrast`,
          "insufficient-evidence",
          assertionType,
          cite(targetScreenshotRef, frames),
        ),
        response: observed,
      })
    }
    if (seed === expected && discriminator?.expected !== "no-change") {
      const layoutClause =
        assertionType === "screenshot"
          ? await layoutCheckFor(ctx, `${id}: same cells`, witnessCell, witnessBaseline, timeoutMs, pollMs)?.()
          : undefined
      return review(
        inconclusive(
          id,
          `${id}: the seed frame and the expected frame read the same cells, so this run cannot separate them${layoutClause ? `; ${layoutClause}` : ""}`,
          "insufficient-evidence",
          assertionType,
          cite(targetScreenshotRef, frames),
        ),
      )
    }
    // A walked frame equal to the seed would mean the crop cannot see the walked attribute, so it is
    // excluded here in code (a no-change row passes the seed === expected refusal above).
    if (
      spec.walkedAttribute !== undefined &&
      walked !== undefined &&
      walked !== seed &&
      expected === walked &&
      after === expected
    ) {
      const { sequence, attribute } = spec.walkedAttribute
      const reason = `${id}: painted ${attribute} for SGR ${sequence}, the same cells as the frame that sets ${attribute} on purpose: the terminal walked the parameters code by code instead of running the sequence`
      return {
        pass: false,
        criterionBranch: "colour-walked-parameters",
        tests: [{ id: "criterion", status: "unsupported", assertionRefs: [0] }],
        response: observed,
        observation: {
          outcome: "unsupported",
          assertionType,
          ...cite(targetScreenshotRef, frames),
          note: reason,
        },
        assertions: [
          {
            assertionType,
            kind: "negative",
            expected: `${id}: the terminal paints SGR ${sequence} as something other than ${attribute} on the seed`,
            observed: expected,
          },
        ],
      }
    }
    if (noAttribute !== undefined && expected === noAttribute) {
      // A declared negative: the seed demonstrated the attribute, and the sequence left a frame that
      // paints nothing. That is a witnessed negative, not an unseparable fixture.
      if (spec.noAttributeNegative !== undefined && seed !== noAttribute) {
        const reason = `${id}: painted nothing for SGR ${spec.noAttributeNegative.sequence}: the frame equals plain text, and the underline was visible in the seed frame of this run`
        const rectangle = cropRectangles[2]
        if (rectangle === undefined) {
          throw new Error(`${id}: the expected frame reached the witness negative with no rectangle`)
        }
        const witness: ColourNoAttributeWitness = {
          kind: "colour-no-attribute-witness",
          rowId: id,
          encoding: spec.noAttributeNegative.sequence,
          rectangle: { x: rectangle.x, y: rectangle.y, width: rectangle.width, height: rectangle.height },
          frames: { seed, expected, noAttribute },
        }
        return {
          pass: false,
          criterionBranch: "colour-no-attribute-witness",
          tests: [{ id: "criterion", status: "unsupported", assertionRefs: [0] }],
          response: observed,
          observation: {
            outcome: "unsupported",
            assertionType,
            ...cite(targetScreenshotRef, frames),
            note: reason,
          },
          assertions: [
            {
              assertionType,
              kind: "negative",
              expected: `${id}: the terminal paints SGR ${spec.noAttributeNegative.sequence} as something other than plain text`,
              observed: expected,
              note: reason,
              witness,
            },
          ],
        }
      }
      // A frame with no attributes at all cannot witness a colour. This is not the `seed === expected`
      // case above: the seed carries the attribute the row qualifies (an underline), so the terminal's
      // reset of it still differs from the seed. The row asked for a colour; it showed none.
      return review(
        inconclusive(
          id,
          `${id}: the expected frame is the no-attribute frame, so this run cannot separate a colour from no colour: the terminal painted nothing for the sequence under test`,
          "insufficient-evidence",
          assertionType,
          cite(targetScreenshotRef, frames),
        ),
      )
    }
    if (ignored !== undefined && ignored === expected) {
      return review(
        inconclusive(
          id,
          `${id}: the ignored-attribute frame and the expected frame read the same cells, so this run cannot separate them`,
          "insufficient-evidence",
          assertionType,
          cite(targetScreenshotRef, frames),
        ),
      )
    }
    const supported = after === expected
    // The decision table below is tested branch by branch:
    //   seed == expected             -> inconclusive, except declared no-change with a distinct ignored control
    //   expected == ignored          -> inconclusive, named (the run cannot separate them)
    //   after == expected            -> supported
    //   after == seed                -> unsupported (the sequence left the screen untouched)
    //   after == ignored             -> unsupported (the measured negative)
    //   otherwise                    -> inconclusive, naming the observation
    // The order is part of the contract: a match on the EXPECTED frame is decided before any
    // negative branch, so a frame cannot be called a negative while it is also the expected one.
    // A frame equal to `seed` is the sequence leaving the screen untouched; a frame equal to
    // `ignored` is the sequence running while dropping the attribute the row claims. Both are
    // measured negatives of a change claim. A declared no-change instead requires seed == expected;
    // only its distinct ignored control can establish the measured negative.
    const untouched = discriminator?.expected !== "no-change" && after === seed
    const matchedIgnored = ignored !== undefined && after === ignored
    const unsupported = untouched || matchedIgnored
    if (!supported && !unsupported && rowGroups && rowGroupsNegative(groupReads)) {
      return rowGroupsUnsupported(id, spec.edit, rowGroups, groupReads, observed, {
        assertionType,
        ...cite(targetScreenshotRef, frames),
      })
    }
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
      return review({
        pass: false,
        response: observed,
        observation: {
          outcome: "inconclusive",
          reason: "insufficient-evidence",
          assertionType,
          ...cite(targetScreenshotRef, frames),
          note,
        },
      })
    }
    return {
      pass: supported,
      ...(discriminator && {
        criterionBranch: discriminator.signal,
        tests: [
          {
            id: discriminator.signal,
            status: supported ? ("supported" as const) : ("unsupported" as const),
            assertionRefs: [0],
          },
        ],
      }),
      response: observed,
      observation: {
        outcome: supported ? "supported" : "unsupported",
        assertionType,
        ...cite(targetScreenshotRef, frames),
        ...(supported
          ? {}
          : {
              note: untouched
                ? `${id}: the sequence left the screen untouched; the frame equals the seed and differs from the expected frame`
                : spec.setupReference !== undefined && after === ignored
                  ? `${id}: the reset also cleared the preserved attribute`
                  : `${id}: the frame equals the ignored-attribute frame, not the expected frame`,
            }),
      },
      assertions: [
        {
          assertionType: assertionType,
          kind: supported ? "positive" : "negative",
          expected: `${id}${discriminator ? ` (${discriminator.signal}, expected ${discriminator.expected})` : ""}: cell-aligned region ${JSON.stringify(spec.region)} equals the same-run expected frame after ${JSON.stringify(spec.edit)}, behind a paint witness in cell ${spec.sentinel.row},${spec.sentinel.col}`,
          observed: after,
        },
      ],
    }
  } finally {
    // A failed reference must reach DECRQSS without sending the reset under test as cleanup.
    // Before our save exists, leave rendition alone rather than borrowing another saved slot.
    endCaptureLifecycle(ctx, spec.cleanup, savedRendition ? (initialRenditionSaved ? "\x1b8" : "") : undefined)
  }
}
