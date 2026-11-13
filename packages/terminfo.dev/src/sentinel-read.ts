import {
  CALIBRATION_SOLID_PAINT,
  originFromSentinel,
  sentinelBlockRefusal,
  witnessCellFor,
  type CalibrationSentinel,
  type CaptureCells,
} from "@terminfo/probe-defs"
import { locateColour, type OriginResolver } from "./capture-core.ts"

/**
 * The one pixel read that anchors its crop on the sentinel it paints (33000). A crop taken at
 * calibration's origin reads the wrong cells the moment the window moves, and Warp's command header
 * does exactly that. So the read paints calibration's sentinel one cell clear of everything it
 * digests, locates it in the SAME frame it digests, and derives the origin from where it actually
 * landed. A frame whose sentinel is missing or is not one cell block refuses by name: it never falls
 * back to the stale origin. The painted cell is restored in every outcome, including a refusal.
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
}): Promise<T> {
  const cell = witnessCellFor(input.regions, { rows: input.source.rows, cols: input.source.cols })
  const at = `\x1b[${cell.row};${cell.col}H`
  const where = `cell ${cell.row},${cell.col}`
  input.source.write(`\x1b7${at}\x1b[0m${CALIBRATION_SOLID_PAINT[input.sentinel.form]} \x1b[0m\x1b8`)
  try {
    return await input.capture(({ frame, pixelGeometry }) => {
      const located = locateColour(frame, input.sentinel.rgb)
      if (located === null) {
        throw new Error(
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
    })
  } finally {
    input.source.write(`\x1b7${at}\x1b[0m \x1b8`)
  }
}
