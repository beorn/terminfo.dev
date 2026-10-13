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
 * across all of them. Cell coordinates arrive from the terminal's own pixel report and are turned
 * into an absolute rectangle by the collector, so digests are comparable only within one run, which
 * is the whole claim. That same symmetry is why the rectangle's alignment needs no separate proof: an
 * offset rectangle reads the same pixels in all three frames, so the worst a wrong one can do is
 * miss the edited cells and leave seed and expected equal — inconclusive BY NAME, never a verdict.
 */
import type { CaptureCells, CapturePixelGeometry, ObservationFrame, ProbeResult, TermContext } from "./types.ts"

export type CellRegion = CaptureCells
export type PixelGeometry = CapturePixelGeometry

/** One capture checkpoint's cell-aligned read, from a run whose capture adapter is installed. */
export interface RegionCapture {
  /** Raw-pixel digest of the requested region. */
  regionDigest: string
  /** Raw-pixel digest of the whole captured window. */
  pixelsDigest: string
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
    return { regionDigest: frame.regionDigest, pixelsDigest: frame.pixelsDigest, frame }
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
  /** The terminal's own pixel report, carried into every capture request. */
  pixelGeometry: PixelGeometry
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
const DEFAULT_TIMEOUT_MS = 5000
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
 */
async function awaitPaintWitness(options: {
  read: RegionRead
  id: string
  label: string
  witnessCell: CellRegion
  pixelGeometry: PixelGeometry
  baseline: RegionCapture
  timeoutMs: number
  pollMs: number
}): Promise<{ witness: RegionCapture } | ProbeResult> {
  const { read, id, label, witnessCell, pixelGeometry, baseline, timeoutMs, pollMs } = options
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
          ? `${id}: paint witnessed outside the sentinel region after ${label} within ${timeoutMs} ms; the frame moved while witness cell ${witnessCell.top},${witnessCell.left} stood still, so the cells-to-pixels geometry is wrong for this context`
          : `${id}: no paint witness within ${timeoutMs} ms after ${label}; the terminal left the witness cell unpainted, so this run cannot separate a painted frame from a stale one`,
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

/**
 * The terminal's own pixel report: CSI 16 t (cell size in pixels) and CSI 14 t (text area in
 * pixels). A context that answers neither cannot map cells onto the captured window at all, and
 * says so BY NAME instead of falling back to a window width divided by a column count.
 */
export async function queryPixelGeometry(ctx: TermContext): Promise<{ geometry: PixelGeometry } | { missing: string }> {
  const cell = await ctx.queryWithSentinelOutcome("\x1b[16t", /\x1b\[6;(\d+);(\d+)t/)
  if (cell.reason !== "reply") {
    return { missing: `the terminal answered CSI 16 t (cell size in pixels) with ${cell.reason}` }
  }
  const text = await ctx.queryWithSentinelOutcome("\x1b[14t", /\x1b\[4;(\d+);(\d+)t/)
  if (text.reason !== "reply") {
    return { missing: `the terminal answered CSI 14 t (text area in pixels) with ${text.reason}` }
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
    return { missing: `the terminal's pixel report did not parse as positive numbers: ${JSON.stringify(geometry)}` }
  }
  return { geometry }
}

/**
 * The whole region decision for one row, or null when this run has no owned capture. Bounds are
 * refused before any byte; then the terminal's own pixel report is queried here, once. A terminal
 * that answers those queries with something unusable is inconclusive BY NAME with evidence "query"
 * — the query bytes are already written, so it is not the zero-byte "none" shape, and a missing
 * report is never a capability verdict.
 */
export async function captureRegionVerdict(
  ctx: TermContext,
  id: string,
  spec: Omit<RegionReadback, "pixelGeometry">,
): Promise<ProbeResult | null> {
  const read = collectorRegionRead(ctx)
  if (!read) return null
  // Geometry first: an undersized terminal is refused before a single query byte.
  const bounds = regionRefusal(id, { ...spec, pixelGeometry: PENDING_GEOMETRY }, ctx.rows, ctx.cols)
  if (bounds) return bounds
  const reported = await queryPixelGeometry(ctx)
  if ("missing" in reported) {
    return inconclusive(
      id,
      `${id}: ${reported.missing}, so this run cannot map cells onto the captured window`,
      "insufficient-evidence",
      "query",
    )
  }
  return captureRegionReadbackDecision(ctx, id, { ...spec, pixelGeometry: reported.geometry }, read)
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
      seed,
      after,
      expected,
      ...(ignored !== undefined && { ignored }),
    })
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
      return {
        pass: false,
        response: observed,
        observation: {
          outcome: "inconclusive",
          reason: "insufficient-evidence",
          evidence: "pixels",
          screenshotRef: frames[3]?.ref,
          frames,
          note: `${id}: a third distinct frame: the sequence changed the screen (after != seed) but not into the expected frame; this exact-digest oracle cannot tell an incorrect effect from a rendering difference (compared frames: ${ignored === undefined ? "seed" : "seed, ignored-attribute"}, expected)`,
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
    // DECTCEM restored and the screen reset, so a refused or thrown run leaves no hidden cursor.
    ctx.write("\x1b[?25h")
    ctx.write("\x1b[0m\x1b[2J\x1b[H")
  }
}
