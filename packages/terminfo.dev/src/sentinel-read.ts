import {
  CALIBRATION_SOLID_PAINT,
  originFromSentinel,
  sentinelBlockRefusal,
  witnessCellFor,
  type CalibrationSentinel,
  type CaptureCells,
} from "@terminfo/probe-defs"
import { locateColour, type OriginResolver } from "./capture-core.ts"

/** A frame this read cannot anchor yet: the paint may still be one capture behind (33000). Never fatal. */
class SentinelNotOnFrame extends Error {}

/**
 * The one pixel read that anchors its crop on the sentinel it paints (33000). A crop taken at
 * calibration's origin reads the wrong cells the moment the window moves, and Warp's command header
 * does exactly that. So the read paints calibration's sentinel one cell clear of everything it
 * digests, locates it in a frame it then digests, and derives the origin from where it actually
 * landed. A frame without the sentinel is captured again until the read's deadline — a capture can
 * land one write behind the paint — and a read that never sees its sentinel refuses by name instead
 * of cropping from the stale origin. The painted cell is restored in every outcome, including a
 * refusal.
 *
 * Deliberately NOT calibration's two-frame confirmation: calibration pays a capture-until-stable
 * loop because it is measuring geometry once, while this runs for every pixel row, and one capture
 * per read is the budget. The sentinel is the last thing painted before the capture, so a frame that
 * shows it is at least as new as the paint.
 *
 * Three residuals, none reachable today by a pixel-row probe, stated rather than implied:
 * - `ESC 7` is one save slot: a probe holding its own DECSC across a read loses that saved state.
 * - Under DECOM the margins move the CUP origin, so the paint lands off `cell` and the derived
 *   origin is shifted by the margin: a wrong crop, not a refusal.
 * - The restore writes a default-colour blank, so whatever the witness cell held (probe text, or a
 *   background set by BCE) is gone. The witness cell is chosen one clear of every digested region so
 *   that nothing this read measures loses its evidence to it.
 */
export async function readThroughSentinel<T>(input: {
  /** Where this read paints, and the grid its sentinel cell must fit in. */
  source: { write(text: string): void; rows: number; cols: number }
  /** One capture of `label`, handed the resolver its frame's crop must use. */
  capture: (resolve: OriginResolver) => Promise<T>
  /** The checkpoint's own label, so a refusal names the read that made it. */
  label: string
  sentinel: CalibrationSentinel
  regions: readonly CaptureCells[]
  /** Absolute deadline for re-capturing a frame that does not show the paint yet. */
  deadline: number
}): Promise<T> {
  const cell = witnessCellFor(input.regions, { rows: input.source.rows, cols: input.source.cols })
  const at = `\x1b[${cell.row};${cell.col}H`
  const where = `cell ${cell.row},${cell.col}`
  const resolve: OriginResolver = ({ frame, pixelGeometry }) => {
    const located = locateColour(frame, input.sentinel.rgb)
    if (located === null) {
      throw new SentinelNotOnFrame(
        `${input.label}: calibration's sentinel painted at ${where} is nowhere in the frame this read digests, so its crop cannot be anchored`,
      )
    }
    const size = { width: pixelGeometry.cellWidth, height: pixelGeometry.cellHeight }
    const blockRefusal = sentinelBlockRefusal(located, size)
    if (blockRefusal) {
      throw new Error(
        `${input.label}: calibration's sentinel painted at ${where} is not one cell block: ${blockRefusal} at ${located.box.x},${located.box.y}`,
      )
    }
    return {
      origin: originFromSentinel(located, cell, size),
      basis: `sentinel re-located on this frame at ${where} (33000)`,
    }
  }
  input.source.write(`\x1b7${at}\x1b[0m${CALIBRATION_SOLID_PAINT[input.sentinel.form]} \x1b[0m\x1b8`)
  try {
    for (;;) {
      try {
        return await input.capture(resolve)
      } catch (error) {
        if (!(error instanceof SentinelNotOnFrame)) throw error
        if (Date.now() >= input.deadline) {
          throw new Error(`${error.message}; it did not settle before this read's deadline`)
        }
      }
    }
  } finally {
    input.source.write(`\x1b7${at}\x1b[0m \x1b8`)
  }
}
