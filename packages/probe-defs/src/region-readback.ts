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
 * while dropping the one attribute the row claims) is unsupported behind a proven paint; a pair that
 * is the expected frame's own background and glyph coverage in a different ink colour is unsupported
 * as a NAMED colour result (osc104, below); anything else is inconclusive BY NAME. No glyph reading:
 * the colour branch compares per-pixel coverage that each frame normalised by its OWN ink, so the one
 * tolerance it carries is 8-bit rounding (2 of 255), named with its measurement beside the constant. A missing paint
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
  CaptureRenderingAxes,
  PixelObservationFrame,
  ColourNoAttributeWitness,
  ObservationFrame,
  PixelCellCrop,
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
  /**
   * The rendering axes and their per-pixel coverage, when the capture adapter measured them. In
   * memory only: a stored frame carries `CaptureRenderingAxes` without the coverage array.
   */
  rendering?: CaptureRenderingAxes
  frame: ObservationFrame
}

export type RegionRead = (request: {
  role: ObservationFrame["role"]
  label: string
  region: CellRegion
  /** Absent on a text arm: it reads cells, so there is no cell-to-pixel mapping to report. */
  pixelGeometry?: PixelGeometry
  /** Cells the probe's own output may cover; the read's sentinel is never painted there (33985). */
  avoid?: CellRegion
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
  return async ({ role, label, region, pixelGeometry, avoid }) => {
    const frame = await capture({ role, label, cells: region, pixelGeometry, ...(avoid ? { avoid } : {}) })
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
      ...(frame.rendering ? { rendering: frame.rendering } : {}),
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
  /**
   * Cells the sequence under test may cover beyond `region` — an inline image's whole footprint
   * (33985). Every read of this decision carries it, so a read never paints its sentinel there.
   */
  avoid?: CellRegion
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
export const CELL_EDGE_TOLERANCE_PX = 1

/**
 * The tier a sentinel pair came from (34040, @cto 2026-11-13). A read's own record names it, so a
 * reader can tell a pair that avoided every digested row from one that had to share a row.
 * `same-row` pairs measure the COLUMN pitch only, which is why no vertical move may rest on one.
 */
export type WitnessTier = "region-free" | "same-row"

/**
 * How many columns a same-row pair is kept apart (34040, @cto). One whole cell of gap, never
 * adjacent: with the cells touching, a horizontal run of sentinel colour or a full-line repaint is
 * one wide box and would read as two cells; with a cell between them it fails the size test first.
 */
export const SAME_ROW_MIN_COLUMN_GAP = 2

/**
 * How many pixels a correctly sized sentinel box may be SHORT of its area (34015). A rendered cell is
 * not a filled rectangle: an anti-aliased corner or the read's own restored pixel leaves a couple of
 * pixels inside a box that is otherwise exactly the cell. The number is the same slack the edges
 * already get, named ONCE so the size test and the fill test cannot drift apart. It is used as BOTH
 * an edge length (how far a box may sit short on one axis) and a pixel count (how far its fill may
 * sit short of width x height) — the same "one blended line" quantity measured two ways, which is
 * only coherent because the constant is that one line's size.
 */
export const SENTINEL_BOX_SLACK_PX = 2 * CELL_EDGE_TOLERANCE_PX

/**
 * Whether a located sentinel is one solid cell block of the expected size. The ONE spelling of that
 * test: the post-hoc layout check and the per-read origin derivation must agree, or a frame one of
 * them accepts is a frame the other refuses. Returns the clause, or undefined when it fits.
 */
export function sentinelBlockRefusal(
  located: { box: { width: number; height: number }; pixels: number },
  cell: { width: number; height: number },
): string | undefined {
  const fits = (size: number, expected: number) => size <= expected && size >= expected - SENTINEL_BOX_SLACK_PX
  const area = located.box.width * located.box.height
  if (
    located.pixels > area ||
    located.pixels < area - SENTINEL_BOX_SLACK_PX ||
    !fits(located.box.width, cell.width) ||
    !fits(located.box.height, cell.height)
  ) {
    return `${located.pixels} px in a ${located.box.width}x${located.box.height} box, against a ${cell.width}x${cell.height} cell`
  }
  return undefined
}

/**
 * The pixels a correctly sized sentinel box is short of its area, when it is short at all (34015). An
 * accepted box that leaned on the slack says so on the row, so a reader can count how many reads did
 * rather than infer it from a silence; a box that fills its area returns undefined.
 */
export function sentinelBoxDeficit(located: {
  box: { width: number; height: number }
  pixels: number
}): { pixels: number; area: number; short: number } | undefined {
  const area = located.box.width * located.box.height
  const short = area - located.pixels
  return short > 0 ? { pixels: located.pixels, area, short } : undefined
}

/**
 * What a read says when a box it ACCEPTED was short of its area (34015): the pixel count and the area
 * of every such box, in the read's own basis, which travels on the frame — so a reader can count how
 * many reads leaned on the slack instead of inferring it from a silence. Empty when every box fills.
 */
export function sentinelFillClause(
  boxes: ReadonlyArray<{ box: { width: number; height: number }; pixels: number }>,
): string {
  const short = boxes
    .map((entry) => sentinelBoxDeficit(entry))
    .filter((entry): entry is { pixels: number; area: number; short: number } => entry !== undefined)
    .map((entry) => `${entry.pixels} of ${entry.area} px`)
  return short.length === 0 ? "" : `; sentinel box accepted short of its area (${short.join(", ")})`
}

/**
 * The text-area origin a located sentinel implies (33000): the cell the check painted and the cell
 * size give the grid back, so a crop taken from THAT frame lands on the cells the run asked for even
 * when the window moved after calibration. Exact arithmetic only — no fitted correction, no tolerance
 * band; a frame one pixel off yields an origin one pixel off, which is what lets the caller refuse
 * rather than paper over a real move.
 */
export function originFromSentinel(
  located: { box: { x: number; y: number } },
  cell: { row: number; col: number },
  cellSize: { width: number; height: number },
): { x: number; y: number } {
  return {
    x: located.box.x - (cell.col - 1) * cellSize.width,
    y: located.box.y - (cell.row - 1) * cellSize.height,
  }
}

/**
 * The cells a search may use, in the ONE order every caller agrees on (34040). Nearest first by
 * Chebyshev distance (the larger of |dRow| and |dCol|), then by row offset ascending, then by column
 * offset ascending — so the same grid and the same digested regions always yield the same cell on
 * every arm and every re-run. A fixed list of a handful of cells came first (33981) and refused reads
 * whose free cell was three rows away, which is why the search is written down here rather than left
 * as a list at each call site.
 */
function* cellsNearestFirst(
  anchor: { row: number; col: number },
  grid: { rows: number; cols: number },
  accepted: (cell: { row: number; col: number }) => boolean,
): Generator<{ row: number; col: number }> {
  const limit = Math.max(grid.rows, grid.cols)
  for (let radius = 1; radius <= limit; radius += 1) {
    for (let dRow = -radius; dRow <= radius; dRow += 1) {
      for (let dCol = -radius; dCol <= radius; dCol += 1) {
        if (Math.max(Math.abs(dRow), Math.abs(dCol)) !== radius) continue
        const cell = { row: anchor.row + dRow, col: anchor.col + dCol }
        if (accepted(cell)) yield cell
      }
    }
  }
}

/**
 * The rows and the columns a digested footprint actually leaves usable for a sentinel cell — not
 * "columns no rectangle touches", which is a different and much stricter question: a region that
 * spans the screen's width still leaves every column free on the one row below it (34040). A row is
 * usable only when no footprint uses it at all (a cell on a digested region's own row can split a
 * wide character at its edge, @dev/10). A column is usable when at least one usable row has a cell
 * on it outside every rectangle.
 */
function clearExtent(
  footprint: readonly CaptureCells[],
  grid: { rows: number; cols: number },
): { rows: number[]; cols: number[] } {
  const rows: number[] = []
  for (let row = 1; row <= grid.rows; row += 1) {
    if (!footprint.some((region) => row >= region.top && row <= region.bottom)) rows.push(row)
  }
  const covers = (row: number, col: number): boolean =>
    footprint.some((region) => row >= region.top && row <= region.bottom && col >= region.left && col <= region.right)
  const cols: number[] = []
  for (let col = 1; col <= grid.cols; col += 1) {
    if (rows.some((row) => !covers(row, col))) cols.push(col)
  }
  return { rows, cols }
}

const spelledLimit = (
  clear: { rows: number[]; cols: number[] },
  grid: { rows: number; cols: number },
  need: "a cell" | "a second cell",
): string => {
  if (clear.rows.length === 0) {
    return `every row of this ${grid.rows}x${grid.cols} screen is inside a digested region, so no row is left for ${need}`
  }
  if (clear.cols.length === 0) {
    return `every column of this ${grid.rows}x${grid.cols} screen is inside a digested region, so no column is left for ${need}`
  }
  if (clear.rows.length === 1) {
    return `the compared region leaves one clear row, ${clear.rows[0]}, on this ${grid.rows}x${grid.cols} screen, so ${need} cannot sit on another row and the row cannot be graded here`
  }
  if (clear.cols.length === 1) {
    return `the compared region leaves one clear column, ${clear.cols[0]}, on this ${grid.rows}x${grid.cols} screen, so ${need} cannot sit on another column and the row cannot be graded here`
  }
  const noun = need === "a cell" ? "cell" : "second cell"
  return `no ${noun} outside the digested regions is left in the ${grid.rows}x${grid.cols} grid that the pair rule accepts`
}

const spelledRegions = (regions: readonly CaptureCells[]): string =>
  regions.map((region) => `${region.top},${region.left}-${region.bottom},${region.right}`).join(" and ")

const spelledAvoid = (avoid: readonly CaptureCells[]): string =>
  avoid.length === 0 ? "" : ` or the probe's own output ${spelledRegions(avoid)}`

/**
 * The TWO cells one read may paint the sentinel on, chosen from the frame taken immediately BEFORE
 * that paint (33981 second pass, @cto 2026-11-13, @dev/15's 19-row diagnosis), and the TIER that says
 * which rule chose them (34040, @cto's condition 4).
 *
 * The first pass chose cells geometrically: clear of the digested regions, but never looking at what
 * was already on the screen. On a probe whose evidence fills the grid the pair landed on that
 * evidence, and clearing it erased the probe's own drawing (modes.xtsave/xtrestore, sgr.blink), or
 * no legal cell existed at all and the read refused before the target was sent (erase.screen.above,
 * reset.decaln, modes.decsscls, scrollback.viewport-hold).
 *
 * So the choice reads the frame: a cell is eligible only when every pixel in it is the SAME colour as
 * the frame's modal (background) colour, which is the one state this read can restore by writing a
 * blank with the attributes it found — nothing the probe drew is ever covered. Eligible cells must
 * still be outside every digested region and outside the probe's declared avoid footprint.
 *
 * Blank is not enough on its own (@dev/15 peer read, 33981): a double-width glyph draws its ink in
 * one half and can leave the other half the background colour, so a cell whose neighbour carries ink
 * may BE the blank half of a glyph — and the blank restore erases a wide glyph whole, which changes
 * the very frame this read digests (@dev/10's rule, generalised). So a cell is eligible only when its
 * own cell AND the cells either side of it on the same row are all background. Neighbouring ink is
 * the only evidence that says so; blankness alone cannot.
 *
 * ORDER (34040, @cto's condition 1) is not a row-major scan: the cell directly above the compared
 * region's first cell, then above its right edge, then directly below, and otherwise the nearest
 * eligible cell by `cellsNearestFirst` — the same order on every arm and every re-run. A row-major
 * scan picked whichever cell happened to sit top-left, so an unrelated row gaining ink moved the
 * pair and two runs of the same frame disagreed.
 *
 * The tiers are this chooser's, and a tier that cannot be reached is not a tier:
 * - `region-free`: both cells on blank cells outside every digested region, differing in row AND
 *   column, so one stray patch or a full-line repaint can never satisfy the pair.
 * - `same-row`: only when no such diagonal pair exists, the second cell sits on the first cell's own
 *   row at least `SAME_ROW_MIN_COLUMN_GAP` columns away. The pair then measures the COLUMN pitch
 *   alone, and the reader says so rather than implying both pitches were measured.
 * There is no third tier, and the reason is CONSOLIDATION, not unreachability (@dev/10's peer read,
 * 33981): the geometry picker had a `no-clear-row` tier for frames with no free ROW, which moved both
 * cells to columns two clear of every region's edge. Every cell that tier could offer is outside every
 * region's rectangle by construction — c <= R.left-2 or c >= R.right+2 puts c outside R, not inside it
 * — so under the frame rule those same cells are ordinary `region-free` candidates, and the old name
 * described the CONSTRAINT that made them choosable (a clear column, no free row) rather than a third
 * geometry. Two things therefore change when an old tier-3 frame arrives: a cell that was blank is
 * chosen by tiers 1/2 with no further rule, and a cell that carries ink is REFUSED, where the geometry
 * picker would have painted over it. The tier's label is gone; its answers are the frame rule's, and
 * what decides the rest is ink, never row geometry. Keeping a third branch would ship a vocabulary
 * that says a different thing from the rule it applies.
 *
 * `reading` is where cell 1,1 sits in the frame, in pixels. A frame too short to hold the whole grid
 * at that origin cannot be used to choose cells, and says so rather than guessing.
 */
/**
 * The pair in READING order: the upper cell first, and among two cells on one row the left one first.
 *
 * Which cells the pair is comes from the order above and nowhere else; this only fixes which of the
 * two the record calls `a`. A diff of two frames arrives as connected regions in POSITION order, so
 * a pair whose `b` sat above-left of its `a` reached the reader as the same two boxes with the cells
 * swapped, and a reader that divides the boxes' offset by the cells' gap then sees the two axes
 * disagree in sign (@dev/10's 5x10 frame found this through a snapped-to-bottom read, 34163).
 */
function readingOrder(
  one: { row: number; col: number },
  other: { row: number; col: number },
): { a: { row: number; col: number }; b: { row: number; col: number } } {
  const oneFirst = one.row === other.row ? one.col <= other.col : one.row < other.row
  return oneFirst ? { a: one, b: other } : { a: other, b: one }
}

export function sentinelCellsInFrame(input: {
  rgba: Uint8Array
  width: number
  height: number
  reading: { x: number; y: number }
  cell: { width: number; height: number }
  grid: { rows: number; cols: number }
  regions: readonly CaptureCells[]
  avoid?: readonly CaptureCells[]
}): { a: { row: number; col: number }; b: { row: number; col: number }; tier: WitnessTier } {
  const { rgba, width, height, reading, cell, grid } = input
  const avoid = input.avoid ?? []
  const pixels = (x: number, y: number): number => {
    // A coordinate that is not a whole pixel, or lies outside the frame, has no colour to report.
    // Returning black for it is how a cell gets called blank without one pixel having been read
    // (@cto, 33981): cell.width can be textWidth / columns, so every x in a cell can be fractional,
    // and a silent zero then equals the background on the common terminal.
    if (!Number.isInteger(x) || !Number.isInteger(y)) {
      throw new Error(`this frame was asked for pixel ${x},${y}, which is not a whole pixel coordinate`)
    }
    if (x < 0 || y < 0 || x >= width || y >= height) {
      throw new Error(`this frame was asked for pixel ${x},${y}, outside its ${width}x${height} bounds`)
    }
    const offset = (y * width + x) * 4
    const red = rgba[offset]
    const green = rgba[offset + 1]
    const blue = rgba[offset + 2]
    if (red === undefined || green === undefined || blue === undefined) {
      throw new Error(
        `this frame was asked for pixel ${x},${y}, whose bytes run past its ${rgba.length}-byte buffer`,
      )
    }
    return (red << 16) | (green << 8) | blue
  }
  const counts = new Map<number, number>()
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const packed = pixels(x, y)
      counts.set(packed, (counts.get(packed) ?? 0) + 1)
    }
  }
  let background = 0
  let backgroundCount = -1
  for (const [packed, count] of counts) {
    if (count > backgroundCount || (count === backgroundCount && packed < background)) {
      background = packed
      backgroundCount = count
    }
  }
  /**
   * A cell's rectangle in WHOLE pixels: the origin plus the cell pitch, with each edge rounded to the
   * nearest pixel (@cto, 33981). The pitch is not always whole — `cellWidth` is `textWidth / columns`
   * — and a fractional left edge makes every x in the cell fractional, so the rectangle has to be
   * reduced to whole pixels before anything is read. Edges, not widths, are rounded, so adjacent
   * cells tile without a gap or an overlap no matter which way the fraction falls.
   */
  const cellRect = (row: number, col: number) => {
    const left = Math.round(reading.x + (col - 1) * cell.width)
    const right = Math.round(reading.x + col * cell.width)
    const top = Math.round(reading.y + (row - 1) * cell.height)
    const bottom = Math.round(reading.y + row * cell.height)
    if (right <= left || bottom <= top) {
      throw new Error(
        `this frame cannot judge the ink on cell ${row},${col}: at the ${cell.width}x${cell.height} px pitch its rectangle has the edges ${left}..${right} by ${top}..${bottom}, which covers no whole pixel`,
      )
    }
    return { left, right, top, bottom }
  }
  /** Every pixel of this cell is the frame's background. */
  const modal = (row: number, col: number): boolean => {
    const { left, right, top, bottom } = cellRect(row, col)
    // A cell whose whole rectangle lies outside the frame cannot be judged from this frame: it is not
    // blank, and it is not a pixel-read fault either (a grid larger than its frame is the caller's).
    if (left < 0 || top < 0 || right > width || bottom > height) return false
    for (let y = top; y < bottom; y++) {
      for (let x = left; x < right; x++) if (pixels(x, y) !== background) return false
    }
    return true
  }
  /**
   * A cell a blank restore puts back as it was found: background itself, and with no ink either side
   * of it on its row, so it cannot be the blank half of a wide glyph whose other half is drawn next
   * door. A neighbour outside the grid has no glyph and does not exclude the cell.
   */
  const blank = (row: number, col: number): boolean =>
    modal(row, col) && (col === 1 || modal(row, col - 1)) && (col === grid.cols || modal(row, col + 1))
  const footprint = [...input.regions, ...avoid]
  const inGrid = (cellAt: { row: number; col: number }): boolean =>
    cellAt.row >= 1 && cellAt.col >= 1 && cellAt.row <= grid.rows && cellAt.col <= grid.cols
  const digested = (cellAt: { row: number; col: number }): boolean =>
    footprint.some(
      (region) =>
        cellAt.row >= region.top &&
        cellAt.row <= region.bottom &&
        cellAt.col >= region.left &&
        cellAt.col <= region.right,
    )
  /** Tier 1 and 2: blank, and on no digested region. */
  const regionFree = (cellAt: { row: number; col: number }): boolean =>
    inGrid(cellAt) && !digested(cellAt) && blank(cellAt.row, cellAt.col)
  const first = input.regions[0]
  // The band every compared region occupies, plus the avoid band where it overlaps the regions' rows:
  // "above" and "below" are asked of the WHOLE footprint, not of the first region, or a second region
  // sitting directly under the first hides the free row below it and the search walks sideways
  // instead (a recorded 24-row screen whose only free row was 24 landed on 1,12).
  const band = avoid.filter(
    (region) =>
      first !== undefined &&
      [...input.regions].some((compared) => region.bottom >= compared.top && region.top <= compared.bottom),
  )
  const top = Math.min(...input.regions.map((region) => region.top), ...band.map((region) => region.top))
  const bottom = Math.max(...input.regions.map((region) => region.bottom), ...band.map((region) => region.bottom))
  const anchor = first === undefined ? { row: 1, col: 1 } : { row: top, col: first.left }
  const preferred =
    first === undefined
      ? []
      : [
          { row: top - 1, col: first.left },
          { row: top - 1, col: first.right + 1 },
          { row: bottom + 1, col: first.left },
        ]
  const firstAccepted = (accepts: (cellAt: { row: number; col: number }) => boolean) => {
    for (const cellAt of preferred) if (accepts(cellAt)) return cellAt
    for (const cellAt of cellsNearestFirst(anchor, grid, accepts)) return cellAt
    return undefined
  }
  const limit = (need: "a cell" | "a second cell"): string => spelledLimit(clearExtent(input.regions, grid), grid, need)
  const spelledLimitFor = (need: "a cell" | "a second cell", why: string): string =>
    `: ${limit(need)}${why}, so this frame's crop cannot be anchored`
  // Where the search looked, spelled the same way in both refusals: an empty region list must not
  // leave a hole in the sentence (a grid with no compared region still has a probe footprint or none).
  const spelledFootprint =
    input.regions.length === 0
      ? avoid.length === 0
        ? ""
        : ` outside the probe's own output ${spelledRegions(avoid)}`
      : ` outside the digested region ${spelledRegions(input.regions)}${spelledAvoid(avoid)}`
  const a = firstAccepted(regionFree)
  if (a === undefined) {
    // Two different facts, said as two different sentences: a frame with no background cell at all is
    // not the same refusal as a frame whose background cells all sit on a digested region or beside ink
    // (main's message, kept: the read must name what it looked for, not only that it failed).
    let anyBackground = false
    for (let row = 1; row <= grid.rows && !anyBackground; row += 1) {
      for (let col = 1; col <= grid.cols; col += 1) {
        if (modal(row, col)) {
          anyBackground = true
          break
        }
      }
    }
    const head = anyBackground
      ? `No sentinel pair can be anchored in this frame; no blank cell exists${spelledFootprint} in the ${grid.rows}x${grid.cols} grid`
      : `No sentinel pair can be anchored in this frame; no blank cell exists in the ${grid.rows}x${grid.cols} grid, because every cell carries ink`
    throw new Error(`${head}${spelledLimitFor("a cell", "")}`)
  }
  // Tier 1 first: a diagonal pair proves both pitches. Only when the frame has none does the
  // same-row tier exist — a tier offered before tier 1 would let a column-only pair win on a frame
  // that had a full pair available (@cto's condition 4: only when no region-free pair exists).
  //
  // Tier 1 searches PAIRS, not the mates of one fixed cell (@dev/10's 5x10 frame, 33981 peer read):
  // the order's first blank cell had no diagonal mate while two other blank cells formed one, so a
  // mate-only search fell to `same-row` with a full diagonal pair sitting in the same frame. Cell
  // counts per row and column answer "has a diagonal mate" in one subtraction — the cells off this
  // cell's row and off its column — so the pair search costs no more than the scan that builds it.
  // The first cell still comes from the SAME order (the nearest blank cell that can be paired), so a
  // frame whose earlier cell pairs answers exactly as before.
  const blankCellsInRow = new Map<number, number>()
  const blankCellsInColumn = new Map<number, number>()
  let blankCells = 0
  for (let row = 1; row <= grid.rows; row += 1) {
    for (let col = 1; col <= grid.cols; col += 1) {
      if (!regionFree({ row, col })) continue
      blankCells += 1
      blankCellsInRow.set(row, (blankCellsInRow.get(row) ?? 0) + 1)
      blankCellsInColumn.set(col, (blankCellsInColumn.get(col) ?? 0) + 1)
    }
  }
  const hasDiagonalMate = (cellAt: { row: number; col: number }): boolean =>
    blankCells - (blankCellsInRow.get(cellAt.row) ?? 0) - (blankCellsInColumn.get(cellAt.col) ?? 0) + 1 > 0
  const nearestAfter = (
    anchor: { row: number; col: number },
    accepted: (cellAt: { row: number; col: number }) => boolean,
  ) => {
    for (const cellAt of cellsNearestFirst(anchor, grid, accepted)) return cellAt
    return undefined
  }
  const pairFirst = firstAccepted((cellAt) => regionFree(cellAt) && hasDiagonalMate(cellAt))
  const diagonal =
    pairFirst === undefined
      ? undefined
      : nearestAfter(
          pairFirst,
          (cellAt) => regionFree(cellAt) && cellAt.row !== pairFirst.row && cellAt.col !== pairFirst.col,
        )
  if (pairFirst !== undefined && diagonal !== undefined) {
    return { ...readingOrder(pairFirst, diagonal), tier: "region-free" }
  }
  const sameRow = nearestAfter(
    a,
    (cellAt) => regionFree(cellAt) && cellAt.row === a.row && Math.abs(cellAt.col - a.col) >= SAME_ROW_MIN_COLUMN_GAP,
  )
  if (sameRow !== undefined) return { ...readingOrder(a, sameRow), tier: "same-row" }
  throw new Error(
    `No sentinel pair can be anchored in this frame; no diagonal pair exists${spelledFootprint} in the ${grid.rows}x${grid.cols} grid, because no two blank cells differ in both row and column, and no blank cell shares the row of cell ${a.row},${a.col} at least ${SAME_ROW_MIN_COLUMN_GAP} columns away${spelledLimitFor("a second cell", "")}`,
  )
}

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
  // The ONE spelling of the block test (its own comment says so): the post-hoc layout check and the
  // per-read derivation must agree, or a frame one accepts is a frame the other refuses (@dev/10).
  const blockRefusal = sentinelBlockRefusal({ box, pixels }, crop)
  if (blockRefusal !== undefined) {
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

/**
 * 33644: a same-cells read whose witness cell is in view can still compare cells that are not — on
 * Warp the command header covers rows 1-3 while the witness sits lower (run 43089755106, 19 rows). So
 * when the witness check finds nothing, the compared region's own first cell takes the same check,
 * against the calibrated crop of that cell (the region crop's top-left cell).
 */
async function comparedRegionLayout(
  ctx: TermProbeSource,
  id: string,
  region: { top: number; left: number },
  witnessCell: CellRegion,
  regionCrop: CaptureRectangle | undefined,
  timeoutMs: number,
  pollMs: number,
): Promise<string | undefined> {
  const geometry = ctx.captureGeometry?.geometry
  if (!regionCrop || !geometry) return undefined
  if (region.top === witnessCell.top && region.left === witnessCell.left) return undefined
  return layoutSinceCalibration({
    ctx,
    label: `${id}: same cells, compared region`,
    cell: { row: region.top, col: region.left },
    calibratedCrop: { x: regionCrop.x, y: regionCrop.y, width: geometry.cellWidth, height: geometry.cellHeight },
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

/** One proved whole-row grid move: the way a row records that its frames read the same screen twice. */
export interface GridMove {
  /** Rows the grid moved between the first compared frame and this one; positive is down the image. */
  rows: number
  /** The later frame's role, so the record names where the move was seen. */
  at: string
}

/** Every compared entry the exemption reads: the rectangle, and what the arm measured behind it. */
export type ComparedCrop = { role: string; rectangle: CaptureRectangle | undefined; crop?: PixelCellCrop }

const sameSurface = (left: CaptureRectangle | undefined, right: CaptureRectangle | undefined): boolean =>
  left === undefined || right === undefined
    ? left === right
    : left.x === right.x && left.y === right.y && left.width === right.width && left.height === right.height

const insideImage = (rectangle: CaptureRectangle, image: { width: number; height: number }): boolean =>
  rectangle.x >= 0 &&
  rectangle.y >= 0 &&
  rectangle.x + rectangle.width <= image.width &&
  rectangle.y + rectangle.height <= image.height

/**
 * The independent half of a proved move (33982). The origin is derived from ONE located sentinel box,
 * so "two origins differ by N rows" is that one measurement restated — it cannot also prove the crop
 * landed on the cells the read chose. The PAIR is independent of it: its two boxes must sit exactly
 * one cell pitch apart per row and column their painted cells differ by, in THIS frame. A pair that
 * does is a frame whose cell size and grid are intact, which is what makes the derived origin land on
 * the cells the read named.
 */
/**
 * Whether the pair in this crop sat on ONE row, so it measured the column pitch and no row height
 * (34040 tier 2). Its own tier says so; the cell rows are the fact, checked here so a hand-built
 * witness cannot claim otherwise.
 */
export function pairMeasuredNoRowHeight(crop: PixelCellCrop): boolean {
  const pair = crop.witness
  return pair !== undefined && pair.a.cell.row === pair.b.cell.row
}

function witnessProvesPitch(crop: PixelCellCrop, first: PixelCellCrop): boolean {
  const here = crop.witness
  const seed = first.witness
  if (here === undefined || seed === undefined) return false
  if (here.a.cell.row !== seed.a.cell.row || here.a.cell.col !== seed.a.cell.col) return false
  if (here.b.cell.row !== seed.b.cell.row || here.b.cell.col !== seed.b.cell.col) return false
  const rowGap = here.b.cell.row - here.a.cell.row
  const colGap = here.b.cell.col - here.a.cell.col
  if (rowGap === 0 && colGap === 0) return false
  // SIGNED, so a pair recorded the other way round is not accepted as its own mirror; and with the
  // same edge tolerance `sentinelBlockRefusal` and the read's own derivation use, so a pair one
  // blended edge line short is accepted here exactly when it was accepted there.
  const slack = 2 * CELL_EDGE_TOLERANCE_PX
  return (
    Math.abs(here.b.box.y - here.a.box.y - rowGap * crop.cell.height) <= slack &&
    Math.abs(here.b.box.x - here.a.box.x - colGap * crop.cell.width) <= slack
  )
}

/**
 * The origin is DERIVED from one located box (`originFromSentinel`), so a frame whose origin does not
 * follow from its own box `a` is a frame whose two halves disagree — the pair would prove a pitch for
 * a crop nobody mapped from it (@dev/10's non-blocking note b). Exact arithmetic, as in the read.
 */
function originFollowsFromBoxA(crop: PixelCellCrop): boolean {
  const { a } = crop.witness ?? {}
  if (a === undefined) return false
  // 34163: a DECLARED viewport hold crops at the settled origin and records the rows the hold moved
  // the pair, so the box follows from the origin plus that declared delta, proved with the same
  // tolerance the read used — and still a disagreement if the two halves contradict each other.
  const heldRows = (crop.scrolledRows?.rows ?? 0) * crop.cell.height
  const expectedY = a.box.y - (a.cell.row - 1) * crop.cell.height - heldRows
  if (crop.origin.x !== a.box.x - (a.cell.col - 1) * crop.cell.width) return false
  // A declared hold is proved with the SAME tolerance the read accepted it with, not a second,
  // stricter one: a pair that lands 1-2 px off a whole row passes the read, and an exact equality
  // here would then empty the exemption in silence (34163, @cto 2026-11-13).
  return crop.scrolledRows === undefined
    ? crop.origin.y === expectedY
    : Math.abs(crop.origin.y - expectedY) <= SENTINEL_BOX_SLACK_PX
}

/**
 * The ONE exemption to the same-crop rule (33982, @cto 9af65976). A terminal may repaint its whole
 * text area lower after a reset — Warp moves it 35 rows when a probe sends RIS — and then a row's
 * frames are cropped from two positions that hold the SAME cells. The exemption accepts exactly that
 * and nothing else: every compared frame is judged against the FIRST compared frame, and the move is
 * accepted only when the origin's x, the cell pitch, the grid's columns and rows, the surface and the
 * measurement's basis all agree, the y difference is a whole number of cell heights, the rectangle
 * follows that origin exactly, every rectangle lies inside the pixels that frame captured, and the
 * frame's own witness pair proves the pitch (see `witnessProvesPitch`). A resize, a horizontal move,
 * a half-row shift or an unmeasured frame refuses exactly as before this function existed.
 */
export function gridMoveExemption(compared: ReadonlyArray<ComparedCrop>): GridMove[] {
  const [seed, ...rest] = compared
  if (seed === undefined || rest.length === 0) return []
  const first = seed.crop
  if (first === undefined || seed.rectangle === undefined) return []
  if (first.basis === undefined || first.grid === undefined || first.witness === undefined) return []
  // A pair painted on ONE row proved the column pitch and never a row height (34040 tier 2, @cto),
  // so it can never carry a vertical move. Refused here rather than left to the arithmetic, which
  // tolerates a zero row gap on purpose; the crop refusal names it (see `pairMeasuredNoRowHeight`).
  if (pairMeasuredNoRowHeight(first)) return []
  if (!witnessProvesPitch(first, first)) return []
  if (!originFollowsFromBoxA(first)) return []
  const moves: GridMove[] = []
  for (const entry of rest) {
    const crop = entry.crop
    const rectangle = entry.rectangle
    if (crop === undefined || rectangle === undefined) return []
    if (crop.basis !== first.basis) return []
    if (!sameSurface(crop.surface, first.surface)) return []
    if (crop.cell.width !== first.cell.width || crop.cell.height !== first.cell.height) return []
    if (crop.grid === undefined) return []
    if (crop.grid.columns !== first.grid.columns || crop.grid.rows !== first.grid.rows) return []
    if (crop.origin.x !== first.origin.x) return []
    const dy = crop.origin.y - first.origin.y
    if (dy % first.cell.height !== 0) return []
    if (rectangle.x !== seed.rectangle.x) return []
    if (rectangle.width !== seed.rectangle.width || rectangle.height !== seed.rectangle.height) return []
    if (rectangle.y - seed.rectangle.y !== dy) return []
    if (!insideImage(seed.rectangle, first.image) || !insideImage(rectangle, crop.image)) return []
    if (!witnessProvesPitch(crop, first)) return []
    if (!originFollowsFromBoxA(crop)) return []
    const rows = dy / first.cell.height
    // A frame that did not move is the ordinary case, not a contradiction: a row whose seed and
    // post-sequence frames stay put while the expected and ignored frames follow a reset reads
    // exactly that way (@dev/10's real-shape probe). Only the frames that DID move are judged.
    if (rows === 0) continue
    moves.push({ rows, at: entry.role })
  }
  return moves
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
  compared: Array<ComparedCrop>
  response: string
  frames: ObservationFrame[]
  screenshotRef?: string
}): ProbeCallbackResult | null {
  const { id, compared, response, frames, screenshotRef } = input
  const cropped = compared.filter(
    (entry): entry is ComparedCrop & { rectangle: CaptureRectangle } => entry.rectangle !== undefined,
  )
  if (cropped.length !== compared.length) return null
  const [seed, ...rest] = cropped
  if (seed === undefined) return null
  if (rest.every(({ rectangle }) => sameRectangle(rectangle, seed.rectangle))) return null
  // 33982: the one accepted difference. A whole-row grid move is not two crops of different cells;
  // every other difference still refuses below, with the sentence it always used.
  if (gridMoveExemption(cropped).length > 0) return null
  const named = cropped.map(({ role, rectangle }) => `${role} cropped at ${rectangleSpelling(rectangle)}`).join(", ")
  const rowHeight =
    seed.crop !== undefined && pairMeasuredNoRowHeight(seed.crop)
      ? ` — and the sentinel pair measured no row height (both witness cells on row ${seed.crop.witness?.a.cell.row}), so a vertical move cannot be accepted from it`
      : ""
  return {
    pass: false,
    response,
    criterionBranch: "same-crop-comparison",
    tests: [
      {
        id: "comparison",
        status: "probe-invalid",
        reason: `Compared frames were cropped from different positions: ${named}${rowHeight}`,
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

/**
 * Two frames whose per-pixel coverage agrees to within `COLOUR_COVERAGE_TOLERANCE` while their ink
 * colours differ (osc104), or undefined when the comparison decides nothing.
 *
 * Why 2: each frame's coverage divides by its OWN ink distance and lands on 0..255, so the same glyph
 * blend renders within one or two levels of itself in a different ink — measured worst 2 on Warp's
 * retained osc104 pair. That is 8-bit rounding of one blend, not a suggested similarity, and it is
 * not widened to make a row fire: a difference of 3 refuses as before.
 *
 * Why the floors: coverage is a fraction of the ink's own distance from the background, so a
 * near-background ink turns rounding noise into "agreement", and a handful of ink pixels can agree by
 * accident. Both floors come from the retained osc104 frames (32 crops carrying ink): the lowest
 * contrast is 81 of 255 and the lowest ink count is 45 pixels, so the floors sit at 40 and 16.
 *
 * The two observations are named apart, never merged: the target painting the SEED's colour means the
 * sequence changed nothing in this region, and a target painting a third colour means it changed into
 * something that is neither.
 */
const COLOUR_COVERAGE_TOLERANCE = 2
/** Largest channel distance between modal ink and modal background this branch will read. */
const INK_CONTRAST_FLOOR = 40
/** Fewest ink pixels this branch will read. */
const INK_PIXEL_FLOOR = 16

export interface ColourOnlyMismatch {
  note: string
  /** Which observation this pair made: the target repainted the seed's own colour, or a third one. */
  observation: "no-effect" | "third-colour"
  afterInk: string
  expectedInk: string
  seedInk: string
  worstDelta: number
}

export function colourOnlyMismatch(
  id: string,
  seed: CaptureRenderingAxes | undefined,
  after: CaptureRenderingAxes | undefined,
  expected: CaptureRenderingAxes | undefined,
): ColourOnlyMismatch | undefined {
  if (!seed || !after || !expected) return undefined
  if (!(seed.background === after.background && after.background === expected.background)) return undefined
  if (after.inkColour === expected.inkColour) return undefined
  for (const frame of [after, expected]) {
    if (frame.contrast < INK_CONTRAST_FLOOR || frame.inkCount < INK_PIXEL_FLOOR) return undefined
  }
  const afterCoverage = after.coverage
  const expectedCoverage = expected.coverage
  if (!afterCoverage || !expectedCoverage) return undefined
  if (afterCoverage.length !== expectedCoverage.length) return undefined
  let worst = 0
  for (let index = 0; index < afterCoverage.length; index++) {
    const delta = Math.abs((afterCoverage[index] ?? 0) - (expectedCoverage[index] ?? 0))
    if (delta > worst) worst = delta
  }
  if (worst > COLOUR_COVERAGE_TOLERANCE) return undefined
  const noEffect = after.inkColour === seed.inkColour
  const observation = noEffect
    ? "the target paints the seed's own colour, so the sequence changed nothing in this region"
    : "the target paints a third colour, matching neither the seed nor the expected frame"
  return {
    observation: noEffect ? "no-effect" : "third-colour",
    afterInk: after.inkColour,
    expectedInk: expected.inkColour,
    seedInk: seed.inkColour,
    worstDelta: worst,
    note: `${id}: the frames are the same geometry in a different ink colour — the background (${expected.background}) is identical to the expected frame's and the per-pixel coverage agrees within ${worst} of 255, while the ink colour differs: after ${after.inkColour}, expected ${expected.inkColour}, seed ${seed.inkColour}. ${observation}`,
  }
}

/**
 * Attempt agreement for the colour branch (@cto 91917ee1): the grade is only given when EVERY attempt
 * that reaches the comparison fires the branch, because a terminal that supports the reset but paints
 * late would otherwise grade Unsupported from one stale frame — the case the retry exists for.
 *
 * The frames of one probe arrive here in capture order, one attempt per trailing "expected frame"
 * read, and each pixel frame carries the axes of its own crop. Any attempt that matches the expected
 * ink, refuses on a floor or a move, or arrives without axes makes the row a named refusal; the
 * per-attempt after colours and their "no effect" / "third colour" labels are kept so a reader can see
 * that the attempts differed, and neither label is published as the terminal's behaviour.
 */
export function colourOnlyAttempts(
  id: string,
  frames: ObservationFrame[],
): { rounds: number; note: string } | { disagreement: string } | undefined {
  const pixel = frames.filter((frame): frame is PixelObservationFrame => frame.kind !== "text-cells")
  const rounds: PixelObservationFrame[][] = []
  let current: PixelObservationFrame[] = []
  for (const frame of pixel) {
    current.push(frame)
    if (frame.label.endsWith("expected frame")) {
      rounds.push(current)
      current = []
    }
  }
  if (current.length > 0) rounds.push(current)
  if (rounds.length < 2) return undefined
  const observed: { afterInk: string; label: "no-effect" | "third-colour" }[] = []
  for (const [index, round] of rounds.entries()) {
    const pick = (suffix: string) => round.filter((frame) => frame.label.endsWith(suffix))
    const [seed] = pick("pre-edit seed")
    const [after] = pick("post-sequence target")
    const [expected] = pick("expected frame")
    const mismatch =
      seed && after && expected
        ? colourOnlyMismatch(id, seed.rendering, after.rendering, expected.rendering)
        : undefined
    if (!mismatch) {
      return {
        disagreement: `${id}: attempts disagree — attempt ${index + 1} of ${rounds.length} does not read the same colour mismatch as the one that reached this verdict, so no colour result is published for this row`,
      }
    }
    observed.push({ afterInk: mismatch.afterInk, label: mismatch.observation })
  }
  const colours = new Set(observed.map((entry) => entry.afterInk))
  const labels = new Set(observed.map((entry) => entry.label))
  if (colours.size === 1 && labels.size === 1) return undefined
  const detail = observed
    .map((entry, index) => `attempt ${index + 1}: after ${entry.afterInk} (${entry.label})`)
    .join("; ")
  return {
    rounds: observed.length,
    note: `${id}: after colour differed between attempts — ${detail}. The grade stands on every attempt; the observation above is not published as the terminal's behaviour`,
  }
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

/**
 * The terminal's own pixel report: CSI 16 t (cell size in pixels) and CSI 14 t (text area in
 * pixels). A context that answers neither cannot map cells onto the captured window at all, and
 * says so BY NAME instead of falling back to a window width divided by a column count.
 *
 * A terminal that answers no 16 t — alacritty, on Linux and macOS — is not a terminal without a
 * report: it answers the SAME text area twice, in pixels (14 t) and in characters (18 t), so its
 * cell size is the whole-number division of the two (28763).
 */
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
        {
          role: "the first stability capture",
          rectangle: stableA.frame.regionRectangle,
          ...(stableA.frame.kind === "text-cells" || stableA.frame.cellCrop === undefined
            ? {}
            : { crop: stableA.frame.cellCrop }),
        },
        {
          role: "the second stability capture",
          rectangle: stableB.frame.regionRectangle,
          ...(stableB.frame.kind === "text-cells" || stableB.frame.cellCrop === undefined
            ? {}
            : { crop: stableB.frame.cellCrop }),
        },
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

/** One named phase of a same-run capture: the SGR written before the sample, and the sample. */
export interface SameRunPhase {
  name: string
  sequence: string
  sample: string
  /** The capture role; a phase named "target" is the target unless it says otherwise. */
  role?: "target" | "control"
}

/** What a same-run capture took, handed to the caller's refusal or decision. */
export interface SameRunCapture {
  region: CellRegion
  pixelGeometry: PixelGeometry | undefined
  geometrySource: PixelGeometrySource
  stability: unknown
  frames: ObservationFrame[]
  measured: Array<{ name: string; capture: RegionCapture }>
}

/**
 * Capture each phase of one sample in one run, after a stability pair, each behind its own paint
 * witness and witness roundtrip, all cropped from the same rectangle. The caller decides from
 * `regionDigest` equality between phases only: no tolerance, no similarity. Null when this run has
 * no owned pixel capture, so the caller's existing path stays in force.
 */
export async function captureSameRunPhases(
  ctx: TermProbeSource,
  id: string,
  sampleCells: number,
  phases: readonly SameRunPhase[],
  refuse: (run: SameRunCapture, note: string) => ProbeCallbackResult,
  decide: (run: SameRunCapture, digest: (name: string) => string) => ProbeCallbackResult,
): Promise<ProbeCallbackResult | null> {
  if (!ctx.capture || ctx.captureKind === "text-cells") return null
  const read = collectorRegionRead(ctx)
  if (!read) return null
  const region = { top: 3, left: 3, bottom: 3, right: 2 + sampleCells }
  const spec = { region, sentinel: SENTINEL, cursorRow: 2, minRows: 3, minCols: region.right + 1 }
  const reported = await captureRegionGeometry(ctx, id, spec, true)
  if ("pass" in reported) return reported
  const pixelGeometry = reported.geometry
  const witnessCell = { top: 1, left: 1, bottom: 1, right: 1 }
  const run: SameRunCapture = {
    region,
    pixelGeometry,
    geometrySource: reported.source,
    stability: undefined,
    frames: [],
    measured: [],
  }
  const { frames, measured } = run
  const roleOf = (phase: SameRunPhase) => phase.role ?? (phase.name === "target" ? "target" : "control")
  const targetName = phases.find((phase) => roleOf(phase) === "target")?.name
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
    run.stability = pair.stability
    if (pair.refusal) return refuse(run, pair.refusal.observation?.note ?? `${id}: capture is not stable`)
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
      if (!witnessed(painted)) return refuse(run, painted.observation?.note ?? `${id}: no paint witness`)
      frames.push(baseline.frame, painted.witness.frame)
      // Reuse the existing witness roundtrip: a transient clear cannot impersonate the requested paint.
      for (const [write, expectedDigest] of [
        [" ", baseline.regionDigest],
        [glyph, painted.witness.regionDigest],
      ] as const) {
        ctx.write(`\x1b[1;1H${write}`)
        const returned = await awaitPaintWitness({ ...options, expectedDigest })
        if (!witnessed(returned)) {
          return refuse(run, returned.observation?.note ?? `${id}: no paint witness return`)
        }
        frames.push(returned.witness.frame)
      }
      const capture = await read({ role: roleOf(phase), label, region, pixelGeometry })
      if (!capture.regionRectangle) throw new Error(`${label}: pixel capture omitted the measured sample rectangle`)
      frames.push(capture.frame)
      measured.push({ name: phase.name, capture })
    }
    const compared: ComparedCrop[] = measured.map(({ name, capture }) => ({
      role: name,
      rectangle: capture.regionRectangle,
      ...(capture.frame.kind === "text-cells" || capture.frame.cellCrop === undefined
        ? {}
        : { crop: capture.frame.cellCrop }),
    }))
    const moved = cropPositionRefusal({
      id,
      compared,
      response: JSON.stringify({ stability: run.stability }),
      frames,
      screenshotRef: measured.find(({ name }) => name === targetName)?.capture.frame.ref,
    })
    if (moved) return moved
    const digest = (name: string) => {
      const value = measured.find((entry) => entry.name === name)?.capture.regionDigest
      if (value === undefined) throw new Error(`${id}: missing same-run ${name} sample`)
      return value
    }
    // 33982: when the compared frames were accepted as ONE grid move, the row says so. The frames
    // themselves already carry every compared origin, so a reader sees the move without the trace.
    const graded = decide(run, digest)
    const moves = gridMoveExemption(compared)
    if (moves.length === 0 || graded.observation === undefined) return graded
    const spelled = moves
      .map(({ rows, at }) => `grid moved ${rows > 0 ? "" : "-"}${Math.abs(rows)} rows at frame ${at}`)
      .join("; ")
    return {
      ...graded,
      observation: {
        ...graded.observation,
        note: graded.observation.note === undefined ? spelled : `${graded.observation.note}; ${spelled}`,
      },
    }
  } finally {
    endCaptureLifecycle(ctx)
  }
}

/** The approved same-run SGR attribute kind. Other SGR capture callers and text arms stay on
 * their existing paths. Equality is read only over the measured sample, never the cursor. */
export async function sgrAttributeCaptureResult(
  ctx: TermProbeSource,
  id: string,
  sequence: string,
): Promise<ProbeCallbackResult | null> {
  if (id === "sgr.blink") return null
  const sample = "AaBb 0123456789 - terminal text"
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
  const finish = (
    run: SameRunCapture,
    status: "supported" | "unsupported" | "probe-todo" | "probe-invalid",
    note: string,
  ): ProbeCallbackResult => {
    const target = run.measured.find(({ name }) => name === "target")?.capture.frame
    const decided = status === "supported" || status === "unsupported"
    const response = JSON.stringify({
      region: run.region,
      pixelGeometry: run.pixelGeometry,
      geometrySource: run.geometrySource,
      stability: run.stability,
      samples: Object.fromEntries(run.measured.map(({ name, capture }) => [name, capture.regionDigest])),
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
        screenshotRef: target?.ref ?? run.frames.at(-1)?.ref,
        frames: run.frames,
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
  return captureSameRunPhases(
    ctx,
    id,
    sample.length,
    phases,
    (run, note) => finish(run, "probe-todo", note),
    (run, digest) => {
      const plain = digest("plain")
      const target = digest("target")
      // This order is the ruling: bad controls never become a terminal negative.
      if (digest("made-up") !== plain) {
        return finish(run, "probe-invalid", `${id}: made-up SGR 99 changed the sample; Test broken`)
      }
      if (digest("handled") === plain) {
        return finish(run, "probe-todo", `${id}: handled control drew nothing; capture is blind`)
      }
      if (target === plain) return finish(run, "unsupported", `${id}: drew nothing for this SGR`)
      if (phases.some(({ name }) => name === "single underline") && target === digest("single underline")) {
        // A multiplexer negative stays on this branch so the collector's outer command read can
        // decide it (@cto 429f006d c); finalizeVisualResult keeps it open when that read is absent.
        return finish(run, "unsupported", `${id}: drawn as single underline`)
      }
      if (id !== "sgr.inverse" && target === digest("inverse")) {
        return finish(run, "unsupported", `${id}: drawn as inverse`)
      }
      if (id === "sgr.hidden") {
        return target === digest("blank")
          ? finish(run, "supported", `${id}: target equals the same-cell blank reference`)
          : finish(run, "probe-invalid", `${id}: hidden changed the sample without matching blank; Test broken`)
      }
      return finish(run, "supported", `${id}: target differs from plain, made-up does not`)
    },
  )
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
  readRegion: RegionRead | null,
): Promise<ProbeCallbackResult | null> {
  // The probe's own output footprint rides on every read this decision makes, so no read paints its
  // sentinel under it (33985).
  const avoid = spec.avoid
  let read: RegionRead | null = readRegion && avoid ? (request) => readRegion({ ...request, avoid }) : readRegion
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
  // Each digest's own rendering axes (background, ink colour, geometry mask), in lockstep with it:
  // two frames can be graded as a colour result only when all three were measured on the same crop.
  const renderings: Array<CaptureRenderingAxes | undefined> = []
  // Each rectangle's own grid measurement, pushed in the same lockstep: a later frame can only be
  // proved a whole-row move when it says where its origin sat (33982).
  const cropMeasurements: Array<PixelCellCrop | undefined> = []
  const cropMeasurementAt = (index: number): { crop?: PixelCellCrop } => {
    const crop = cropMeasurements[index]
    return crop === undefined ? {} : { crop }
  }
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
      renderings.push(measured.rendering)
      cropMeasurements.push(measured.frame.kind === "text-cells" ? undefined : measured.frame.cellCrop)
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
            {
              role: "initial stability",
              rectangle: stableBaseline.regionRectangle,
              ...(stableBaseline.frame.kind === "text-cells" || stableBaseline.frame.cellCrop === undefined
                ? {}
                : { crop: stableBaseline.frame.cellCrop }),
            },
            { role: "initial N", rectangle: cropRectangles[0], ...cropMeasurementAt(0) },
            {
              role: step.label,
              rectangle: measured.regionRectangle,
              ...(measured.frame.kind === "text-cells" || measured.frame.cellCrop === undefined
                ? {}
                : { crop: measured.frame.cellCrop }),
            },
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
        { role: "the seed frame", rectangle: cropRectangles[0], ...cropMeasurementAt(0) },
        { role: "the post-sequence frame", rectangle: cropRectangles[1], ...cropMeasurementAt(1) },
        { role: "the expected frame", rectangle: cropRectangles[2], ...cropMeasurementAt(2) },
        ...(spec.ignored === undefined
          ? []
          : [{ role: "the ignored-attribute frame", rectangle: cropRectangles[3], ...cropMeasurementAt(3) }]),
        ...(spec.setupReference === undefined
          ? []
          : [
              {
                role: "the independent setup reference",
                rectangle: cropRectangles[referenceIndex],
                ...cropMeasurementAt(referenceIndex),
              },
            ]),
        ...(spec.noAttribute === undefined
          ? []
          : [
              {
                role: "the no-attribute frame",
                rectangle: cropRectangles[referenceIndex + (spec.setupReference === undefined ? 0 : 1)],
                ...cropMeasurementAt(referenceIndex + (spec.setupReference === undefined ? 0 : 1)),
              },
            ]),
        ...(spec.walkedAttribute === undefined
          ? []
          : [
              {
                role: "the walked-attribute frame",
                rectangle: cropRectangles[walkedIndex],
                ...cropMeasurementAt(walkedIndex),
              },
            ]),
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
          ? ((await layoutCheckFor(ctx, `${id}: same cells`, witnessCell, witnessBaseline, timeoutMs, pollMs)?.()) ??
            (await comparedRegionLayout(ctx, id, spec.region, witnessCell, cropRectangles[0], timeoutMs, pollMs)))
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
      // A pair that is the expected frame's own geometry and background in a different ink colour is
      // a measurable colour result (osc104): the sequence did not reach the expected paint, and the
      // only axis that differs is the ink colour the reset should have restored. Graded negative, and
      // named with both raw colours, instead of refused as "some rendering axis differed".
      const colourOnly =
        assertionType === "screenshot" ? colourOnlyMismatch(id, renderings[0], renderings[1], renderings[2]) : undefined
      if (colourOnly !== undefined) {
        return review({
          pass: false,
          criterionBranch: "colour-only-mismatch",
          tests: [{ id: "criterion", status: "unsupported", assertionRefs: [0] }],
          response: observed,
          observation: {
            outcome: "unsupported",
            assertionType,
            ...cite(targetScreenshotRef, frames),
            note: colourOnly.note,
          },
          assertions: [
            {
              assertionType,
              kind: "negative",
              expected: `${id}: cell-aligned region ${JSON.stringify(spec.region)} equals the same-run expected frame's geometry and background after ${JSON.stringify(spec.edit)}, in the frame's own ink colour`,
              observed: `${after} at ink ${renderings[1]?.inkColour ?? "unrecorded"} (expected ink ${renderings[2]?.inkColour ?? "unrecorded"}; ink pixels ${renderings[1]?.inkCount ?? 0} vs ${renderings[2]?.inkCount ?? 0}, contrast ${renderings[1]?.contrast ?? 0} vs ${renderings[2]?.contrast ?? 0} of 255)`,
            },
          ],
        })
      }
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
