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
 * The decision is digest EQUALITY and nothing else: after equals expected and differs from seed is
 * supported, after equals seed behind a proven paint is unsupported, anything else is inconclusive
 * BY NAME. No tolerance, no similarity, no glyph reading. A missing paint witness, a capture that
 * is not byte-stable, or a paint seen outside the sentinel region is never a negative.
 *
 * The verdict compares three captures of ONE run — seed, post-sequence, and the expected frame
 * painted plainly in the same run — each behind its own witness, with the cursor hidden (DECTCEM)
 * across all of them. Cell coordinates arrive from the terminal's own pixel report and are turned
 * into an absolute rectangle by the collector, so digests are comparable only within one run, which
 * is the whole claim.
 */
import type { ObservationFrame, ProbeResult, TermContext } from "./types.ts"

/** A cell-aligned region in the run's measured grid: 1-based and inclusive on all four edges. */
export interface CellRegion {
  top: number
  left: number
  bottom: number
  right: number
}

/**
 * The terminal's OWN pixel report, as numbers: CSI 16 t (cell size) and CSI 14 t (text area).
 * Cell-to-pixel arithmetic uses these, never a window width divided by a column count.
 */
export interface PixelGeometry {
  cellWidth: number
  cellHeight: number
  textWidth: number
  textHeight: number
}

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
  /** The terminal's own pixel report, carried into every capture request. */
  pixelGeometry: PixelGeometry
  /** Bound on one paint witness, in ms. A timeout is inconclusive by name, never unsupported. */
  timeoutMs: number
  /** Floor between witness reads. The collector's own capture settle dominates it. */
  pollMs?: number
  minRows?: number
  minCols?: number
}

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

function inconclusive(id: string, note: string, reason: "timeout" | "insufficient-evidence"): ProbeResult {
  return { pass: false, observation: { outcome: "inconclusive", reason, evidence: "pixels", note } }
}

function positive(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0
}

/** Refuse before any byte when the grid, the region, the witness or the pixel report cannot decide. */
function regionRefusal(id: string, spec: RegionReadback, rows: number, cols: number): ProbeResult | undefined {
  const minRows = spec.minRows ?? 1
  const minCols = spec.minCols ?? 1
  if (!Number.isSafeInteger(rows) || !Number.isSafeInteger(cols) || rows < minRows || cols < minCols) {
    return inconclusive(
      id,
      `${id}: capture-region readback needs a measured grid of at least ${minRows}x${minCols}; measured ${rows}x${cols}`,
      "insufficient-evidence",
    )
  }
  const geometry = spec.pixelGeometry
  if (
    !positive(geometry.cellWidth) ||
    !positive(geometry.cellHeight) ||
    !positive(geometry.textWidth) ||
    !positive(geometry.textHeight)
  ) {
    return inconclusive(
      id,
      `${id}: capture-region readback needs the terminal's own positive pixel report (cell size and text area); got ${JSON.stringify(geometry)}`,
      "insufficient-evidence",
    )
  }
  const { region, sentinel, cursorRow } = spec
  const edges = [region.top, region.left, region.bottom, region.right]
  if (edges.some((value) => !Number.isSafeInteger(value)) || !Number.isSafeInteger(cursorRow)) {
    return inconclusive(id, `${id}: capture-region readback needs integer cell edges`, "insufficient-evidence")
  }
  if (region.top < 1 || region.left < 1 || region.bottom < region.top || region.right < region.left) {
    return inconclusive(
      id,
      `${id}: compared region ${JSON.stringify(region)} is not a non-empty rectangle inside the grid`,
      "insufficient-evidence",
    )
  }
  if (region.bottom > rows || region.right > cols) {
    return inconclusive(
      id,
      `${id}: compared region ${JSON.stringify(region)} leaves the measured ${rows}x${cols} grid`,
      "insufficient-evidence",
    )
  }
  if (!Number.isSafeInteger(sentinel.row) || !Number.isSafeInteger(sentinel.col)) {
    return inconclusive(id, `${id}: paint witness needs integer cell coordinates`, "insufficient-evidence")
  }
  if (sentinel.row < 1 || sentinel.col < 1 || sentinel.row > rows || sentinel.col > cols) {
    return inconclusive(
      id,
      `${id}: paint witness cell ${sentinel.row},${sentinel.col} leaves the measured ${rows}x${cols} grid`,
      "insufficient-evidence",
    )
  }
  const sentinelInside =
    sentinel.row >= region.top &&
    sentinel.row <= region.bottom &&
    sentinel.col >= region.left &&
    sentinel.col <= region.right
  if (sentinelInside) {
    return inconclusive(
      id,
      `${id}: paint witness cell ${sentinel.row},${sentinel.col} lies inside compared region ${JSON.stringify(region)}`,
      "insufficient-evidence",
    )
  }
  if (cursorRow < 1 || cursorRow > rows) {
    return inconclusive(
      id,
      `${id}: cursor row ${cursorRow} leaves the measured ${rows}x${cols} grid`,
      "insufficient-evidence",
    )
  }
  if (region.top <= cursorRow && cursorRow <= region.bottom) {
    return inconclusive(
      id,
      `${id}: compared region ${JSON.stringify(region)} includes the cursor row ${cursorRow}`,
      "insufficient-evidence",
    )
  }
  if (sentinel.row === cursorRow) {
    return inconclusive(id, `${id}: paint witness cell shares the cursor row ${cursorRow}`, "insufficient-evidence")
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
      )
    }
    for (let index = 0; index < steps.length; index++) {
      const step = steps[index]!
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
    const [seed, after, expected] = digests
    const observed = JSON.stringify({
      region: spec.region,
      sentinel: spec.sentinel,
      cursorRow: spec.cursorRow,
      pixelGeometry: spec.pixelGeometry,
      seed,
      after,
      expected,
    })
    if (seed === expected) {
      return inconclusive(
        id,
        `${id}: the seed frame and the expected frame read the same cells, so this run cannot separate them`,
        "insufficient-evidence",
      )
    }
    const supported = after === expected
    const unsupported = after === seed
    if (!supported && !unsupported) {
      return {
        pass: false,
        response: observed,
        observation: {
          outcome: "inconclusive",
          reason: "insufficient-evidence",
          evidence: "pixels",
          screenshotRef: frames[3]?.ref,
          frames,
          note: `${id}: the post-sequence region matched neither the seed frame nor the expected frame`,
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
