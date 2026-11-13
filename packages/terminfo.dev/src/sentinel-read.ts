import {
  CALIBRATION_SOLID_PAINT,
  originFromSentinel,
  SENTINEL_BOX_SLACK_PX,
  sentinelBlockRefusal,
  sentinelBoxDeficit,
  witnessCellsFor,
  type CalibrationSentinel,
  type CaptureCells,
} from "@terminfo/probe-defs"
import { locateChangedColour, type CapturedFrame, type OriginResolver } from "./capture-core.ts"

/** A frame this read cannot anchor yet: the paint may still be one capture behind (33000). Never fatal. */
class SentinelNotOnFrame extends Error {}

/**
 * The one pixel read that anchors its crop on the sentinel it paints (33000), located by FRAME
 * DIFFERENCE (33981, @cto).
 *
 * A crop taken at calibration's origin reads the wrong cells the moment the window moves, and Warp's
 * command header does exactly that. So the read paints calibration's sentinel one cell clear of
 * everything it digests, locates it in a frame it then digests, and derives the origin from where it
 * actually landed. A frame without the painted cell is captured again until the read's deadline — a
 * capture can land one write behind the paint — and a read that never sees it refuses by name instead
 * of cropping from the stale origin. Every painted cell is restored in every outcome.
 *
 * TWO cells are painted, in one write, differing in BOTH row and column (@cto 2026-11-13, after
 * @dev/10's finding). One cell could be satisfied by a probe's own late drawing in the sentinel's
 * colour when this read's paint had not rendered yet, and that anchors the crop in the wrong place
 * with no error at all. A pair cannot: the difference must show exactly two cell-sized regions, the
 * same size, whose offset is an exact multiple of that size on each axis — the offset the two painted
 * cells imply. Anything else retries and then refuses by name with every box.
 *
 * The sentinel is found by what changed between the frame BEFORE the paint and the frame after it,
 * never by the colour alone: a probe whose own pixels carry the same colour (sgr.underline.dashed,
 * 2207 px) is a fact the difference keeps out of the answer, instead of a case the colour anchor had
 * to be talked out of. The cost is one extra capture per read, which is the budget @cto accepted.
 *
 * A capture is a SAMPLE of a terminal that may still be drawing, and on Darwin it is a bare
 * screenshot with no settle of its own (@dev/10). If the pre-paint frame lagged the probe's own
 * drawing, or the previous read's restore had not rendered, the difference sees the wrong regions —
 * and re-taking only the read frame would compare against that same stale frame forever. So a retry
 * RESTARTS the read: it clears this read's own paint, takes a fresh pre-paint frame (the clear is now
 * in the past), paints again and captures. Re-taking the pre-paint frame without clearing first
 * would hand the difference a frame that already shows the sentinel, and no retry could ever see it
 * change (@dev/10) — so the clear is not an optimisation, it is what makes the retake a pre-paint.
 * This costs one extra capture per retry, and nothing on the first attempt.
 *
 * Deliberately NOT calibration's two-frame confirmation: calibration pays a capture-until-stable loop
 * because it is measuring geometry once, while this runs for every pixel row.
 *
 * Three residuals, none reachable today by a pixel-row probe, stated rather than implied:
 * - `ESC 7` is one save slot: a probe holding its own DECSC across a read loses that saved state.
 * - Under DECOM the margins move the CUP origin, so the paint lands off the cells and the derived
 *   origin is shifted by the margin: a wrong crop, not a refusal.
 * - The restore writes a default-colour blank, so whatever the witness cells held (probe text, or a
 *   background set by BCE) is gone. Both cells are chosen clear of every digested region so that
 *   nothing this read measures loses its evidence to them.
 */
export async function readThroughSentinel<T>(input: {
  /** Where this read paints, and the grid its sentinel cells must fit in. */
  source: { write(text: string): void; rows: number; cols: number }
  /**
   * One frame of the same window through the same capture route, taken before this read paints and
   * after the previous read's restore has been written.
   */
  prePaint: () => Promise<CapturedFrame>
  /** One capture of `label`, handed the resolver its frame's crop must use. */
  capture: (resolve: OriginResolver) => Promise<T>
  /** The checkpoint's own label, so a refusal names the read that made it. */
  label: string
  sentinel: CalibrationSentinel
  regions: readonly CaptureCells[]
  /** Cells the probe's own output may cover (an inline image); the pair is never painted there (33985). */
  avoid?: CaptureCells
  /** Absolute deadline for re-capturing a frame that does not show the paint yet. */
  deadline: number
}): Promise<T> {
  const { a, b } = witnessCellsFor(
    input.regions,
    { rows: input.source.rows, cols: input.source.cols },
    input.avoid ? [input.avoid] : [],
  )
  const atA = `\x1b[${a.row};${a.col}H`
  const atB = `\x1b[${b.row};${b.col}H`
  const where = `cells ${a.row},${a.col} and ${b.row},${b.col}`
  const named = (
    regions: readonly { box: { x: number; y: number; width: number; height: number }; pixels: number }[],
  ) => {
    const spelled = regions
      .slice(0, 8)
      .map(
        (region) =>
          `${region.pixels} px in a ${region.box.width}x${region.box.height} box at ${region.box.x},${region.box.y}`,
      )
      .join("; ")
    return regions.length > 8 ? `${spelled}; and ${regions.length - 8} more` : spelled
  }
  let before = await input.prePaint()
  const resolve: OriginResolver = ({ frame, pixelGeometry }) => {
    const { regions, ignoredPixels } = locateChangedColour(before, frame, input.sentinel.rgb)
    const noise = ignoredPixels === 0 ? "" : ` (${ignoredPixels} other changed px carry no sentinel colour)`
    if (regions.length === 0) {
      throw new SentinelNotOnFrame(
        `${input.label}: no cell changed to the sentinel colour at ${where} between the frames this read compared${noise}, so its crop cannot be anchored`,
      )
    }
    const size = { width: pixelGeometry.cellWidth, height: pixelGeometry.cellHeight }
    const wrong = (reason: string) =>
      new SentinelNotOnFrame(
        `${input.label}: the changed sentinel at ${where} is not one painted pair: ${reason}${noise}`,
      )
    if (regions.length !== 2) {
      throw wrong(
        `${regions.length} connected regions changed into the sentinel colour — ${named(regions)} — where the two painted cells need exactly two`,
      )
    }
    const [first, second] = regions as [
      { box: { x: number; y: number; width: number; height: number }; pixels: number },
      { box: { x: number; y: number; width: number; height: number }; pixels: number },
    ]
    const firstRefusal = sentinelBlockRefusal(first, size)
    if (firstRefusal) throw wrong(`one box is ${firstRefusal} at ${first.box.x},${first.box.y}`)
    const secondRefusal = sentinelBlockRefusal(second, size)
    if (secondRefusal) throw wrong(`one box is ${secondRefusal} at ${second.box.x},${second.box.y}`)
    // One blended edge line at each box can leave the box up to CELL_EDGE_TOLERANCE_PX short on each
    // axis and move its origin by the same, so "the same size" and "the offset the cells imply" are
    // both read with that tolerance — never with the box size in place of the cell PITCH, which a
    // blended edge would break on every read (@dev/10 peer read).
    const slack = SENTINEL_BOX_SLACK_PX
    if (
      Math.abs(first.box.width - second.box.width) > slack ||
      Math.abs(first.box.height - second.box.height) > slack
    ) {
      throw wrong(
        `the boxes are ${first.box.width}x${first.box.height} at ${first.box.x},${first.box.y} and ${second.box.width}x${second.box.height} at ${second.box.x},${second.box.y}, which are not the same size`,
      )
    }
    const offset = { x: second.box.x - first.box.x, y: second.box.y - first.box.y }
    const gap = { x: b.col - a.col, y: b.row - a.row }
    const impliedPitch = { x: Math.abs(offset.x) / Math.abs(gap.x), y: Math.abs(offset.y) / Math.abs(gap.y) }
    const basis = `sentinel re-located by frame difference at ${where} (33000, 33981)`
    const direction =
      Math.sign(offset.x) * Math.sign(gap.x) === Math.sign(offset.y) * Math.sign(gap.y)
        ? Math.sign(offset.x) * Math.sign(gap.x)
        : 0
    if (
      direction !== 0 &&
      Math.abs(impliedPitch.x - size.width) <= slack &&
      Math.abs(impliedPitch.y - size.height) <= slack
    ) {
      const aBox = direction > 0 ? first : second
      return { origin: originFromSentinel(aBox, a, size), basis: `${basis}${noise}` }
    }
    throw wrong(
      `their offset is ${offset.x},${offset.y}, which is a pitch of ${impliedPitch.x.toFixed(2)}x${impliedPitch.y.toFixed(2)} across the ${gap.x} columns and ${gap.y} rows between the painted cells, not the ${size.width}x${size.height} cell`,
    )
  }
  const paint = CALIBRATION_SOLID_PAINT[input.sentinel.form]
  const paintCells = () => input.source.write(`\x1b7${atA}\x1b[0m${paint} ${atB}${paint} \x1b[0m\x1b8`)
  const clearCells = () => input.source.write(`\x1b7${atA}\x1b[0m ${atB} \x1b[0m\x1b8`)
  paintCells()
  try {
    for (;;) {
      try {
        return await input.capture(resolve)
      } catch (error) {
        if (!(error instanceof SentinelNotOnFrame)) throw error
        if (Date.now() >= input.deadline) {
          throw new Error(`${error.message}; it did not settle before this read's deadline`)
        }
        // Restart the read (33981, @dev/10): clear this read's paint, so the fresh frame below is
        // truly a frame BEFORE the paint, then repaint and capture again.
        clearCells()
        before = await input.prePaint()
        paintCells()
      }
    }
  } finally {
    clearCells()
  }
}
