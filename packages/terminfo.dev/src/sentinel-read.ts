import {
  sentinelCellsInFrame,
  originFromSentinel,
  CELL_EDGE_TOLERANCE_PX,
  sentinelBlockRefusal,
  type CaptureCells,
  type Utf8DecodingReading,
} from "@terminfo/probe-defs"
import { locateChanged, type CapturedFrame, type OriginResolver } from "./capture-core.ts"

/** A frame this read cannot anchor yet: the paint may still be one capture behind (33000). Never fatal. */
class SentinelNotOnFrame extends Error {}

/**
 * A paint that covered more than one cell: U+2588 on a terminal that treats the character as two
 * columns wide. The cell is left half erased and no read after it can be trusted, so the caller stops
 * anchoring this run's reads on the sentinel instead of carrying on over the damage (@cto 2db35bf8).
 */
export class SentinelPaintWiderThanCell extends Error {}

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
 * Nothing here emits SGR (@cto 2db35bf8). The paint draws U+2588 FULL BLOCK in whatever attributes
 * the probe left current, and the restore writes a space in those same attributes: rendition is not
 * queryable portably, so an SGR save or a reset would be a guess that rewrites what the rows measure.
 * Position is saved and restored with CPR plus an absolute CUP, never `ESC 7`/`ESC 8`: one save slot
 * is what this read must stop touching.
 *
 * Limits, named rather than implied:
 * - This reader is UTF-8 only. The glyph is U+2588, whose UTF-8 bytes contain 0x88, which an 8-bit
 *   terminal reads as a C1 control that sets a tab stop. A terminal that measured 8-bit decoding is
 *   refused by name BEFORE any paint; that terminal is not handled.
 * - The restore writes a space under the probe's current attributes, so a cell returns to the current
 *   background. That is the modal background the cell was chosen for only when the screen was drawn
 *   with those attributes. A row that shows otherwise comes back to @cto; no extra capture is paid
 *   to paper it over.
 * - CUP clears the pending-wrap flag. A read taken while the probe's cursor sat in the last column
 *   with a wrap pending loses that flag (the column itself is put back). Census of the rows that can
 *   reach such a read: /hh/var/@dev11/33981/WRAP-CENSUS.md.
 * - Under DECOM the margins move the CUP origin, so the paint lands off the chosen cells and the
 *   derived origin is shifted by the margin: a wrong crop, not a refusal.
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
  /**
   * The cursor's position, asked of the probe's own reply route (CSI 6n) and bounded by this read's
   * deadline. `null` — no reply, or none parsable — refuses the read by name: there is no ESC 7
   * fallback, because one save slot is the thing this read must stop touching.
   */
  cursorPosition: () => Promise<{ row: number; col: number } | null>
  /**
   * This run's measured plain-UTF-8 decoding, when the collector measured one. A terminal that
   * measured 8-bit decoding is refused before any paint; absent means this context has no
   * measurement, which is every adapter that installs this reader today.
   */
  utf8Decoding?: () => Promise<Utf8DecodingReading>
  regions: readonly CaptureCells[]
  /** Cells the probe's own output may cover (an inline image); the pair is never painted there (33985). */
  avoid?: CaptureCells
  /**
   * Where cell 1,1 sits in the frames this read compares, in pixels — the witnessed text origin the
   * capture adapter measures against, never a window width divided by a column count.
   */
  reading: { x: number; y: number }
  /** The cell this run was calibrated to, which the chosen cells must be measured in. */
  cell: { width: number; height: number }
  /** Absolute deadline for re-capturing a frame that does not show the paint yet. */
  deadline: number
}): Promise<T> {
  const grid = { rows: input.source.rows, cols: input.source.cols }
  /**
   * The two cells to paint, chosen from the frame taken just before this attempt's paint: only cells
   * that were already background, so the blank this read writes back restores them and the probe's
   * own drawing is never covered (@dev/15's 19-row diagnosis, 33981).
   */
  const choose = (frame: CapturedFrame) =>
    sentinelCellsInFrame({
      rgba: frame.rgba,
      width: frame.width,
      height: frame.height,
      reading: input.reading,
      cell: input.cell,
      grid,
      regions: input.regions,
      ...(input.avoid ? { avoid: [input.avoid] } : {}),
    })
  let chosen: ReturnType<typeof choose> | undefined
  const pair = () => {
    if (chosen === undefined) {
      throw new Error(`${input.label}: the sentinel cells were chosen after the capture that needed them`)
    }
    return chosen
  }
  const where = () => {
    const { a, b } = pair()
    return `cells ${a.row},${a.col} and ${b.row},${b.col}`
  }
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
  /**
   * Where a cell sits in these frames, from the witnessed text origin this read was handed. The wide
   * refusal and the clear's proof both need it before any geometry has been resolved from the picture.
   */
  const cellRect = (cell: { row: number; col: number }) => ({
    x: input.reading.x + (cell.col - 1) * input.cell.width,
    y: input.reading.y + (cell.row - 1) * input.cell.height,
    width: input.cell.width,
    height: input.cell.height,
  })
  const overlaps = (
    one: { x: number; y: number; width: number; height: number },
    two: { x: number; y: number; width: number; height: number },
  ) =>
    one.x < two.x + two.width && two.x < one.x + one.width && one.y < two.y + two.height && two.y < one.y + one.height
  let before = await input.prePaint()
  chosen = choose(before)
  /** The pair the previous attempt painted, so a retry can prove that its clear took. */
  let painted: { a: { row: number; col: number }; b: { row: number; col: number } } | undefined
  const resolve: OriginResolver = ({ frame, pixelGeometry }) => {
    const { a, b } = pair()
    const { regions } = locateChanged(before, frame)
    if (regions.length === 0) {
      throw new SentinelNotOnFrame(
        `${input.label}: the sentinel paint is not visible under the probe's current attributes — no pixel changed between the frames this read compared, so its crop cannot be anchored`,
      )
    }
    const size = { width: pixelGeometry.cellWidth, height: pixelGeometry.cellHeight }
    const slack = 2 * CELL_EDGE_TOLERANCE_PX
    const wrong = (reason: string) =>
      new SentinelNotOnFrame(`${input.label}: the changed sentinel at ${where()} is not one painted pair: ${reason}`)
    /**
     * A terminal that draws U+2588 double-width widens BOTH painted cells, and a diagonal pair then
     * touches: the lower block's first pixel sits directly under the upper block's last, so the flood
     * fill answers ONE region. Counting first would read that as "other change" and spin to the
     * deadline, never reaching the wide refusal and never retiring the sentinel for the run
     * (@dev/15 peer read of a887dda73). Every changed region wider than a cell is the evidence that
     * the glyph is drawn wide, and that is testable before the count means anything.
     */
    const isWide = (region: { box: { width: number; height: number } }) =>
      region.box.width > size.width + CELL_EDGE_TOLERANCE_PX || region.box.height > size.height + CELL_EDGE_TOLERANCE_PX
    /**
     * The wide verdict retires the sentinel for the whole run, so it may only be drawn from a region
     * that reaches one of the cells this read painted: an unrelated wide change in the window is a
     * reason to retry, not a reason to give up anchoring (@dev/15 peer read of 52da0fd43).
     */
    const atPaintedCell = (region: { box: { x: number; y: number; width: number; height: number } }) =>
      overlaps(region.box, cellRect(a)) || overlaps(region.box, cellRect(b))
    if (regions.length <= 2 && regions.every(isWide) && regions.every(atPaintedCell)) {
      const widest = regions.reduce((grown, region) =>
        region.box.width * region.box.height > grown.box.width * grown.box.height ? region : grown,
      )
      throw new SentinelPaintWiderThanCell(
        `${input.label}: every region that changed is wider than one cell — ${
          regions.length === 1
            ? `one changed region, ${widest.pixels} px in a ${widest.box.width}x${widest.box.height} box at ${widest.box.x},${widest.box.y}`
            : `both changed regions, the larger ${widest.pixels} px in a ${widest.box.width}x${widest.box.height} box at ${widest.box.x},${widest.box.y}`
        } against a ${size.width}x${size.height} cell. Either the terminal drew U+2588 across two columns, or this frame changed over a wide area rather than at the pair; both make the pair unusable as an anchor, so this run stops anchoring its reads on the sentinel`,
      )
    }
    if (regions.length !== 2) {
      throw new SentinelNotOnFrame(
        `${input.label}: other change during this read at ${where()}: ${
          regions.length === 0
            ? "no region changed"
            : regions.length === 1
              ? "one disconnected region changed"
              : `${regions.length} disconnected regions changed`
        } between the frames it compared — ${named(regions)} — where the two painted cells need exactly two`,
      )
    }
    const [first, second] = regions as [
      { box: { x: number; y: number; width: number; height: number }; pixels: number },
      { box: { x: number; y: number; width: number; height: number }; pixels: number },
    ]
    const wide = [first, second].find((region) => isWide(region) && atPaintedCell(region))
    if (wide) {
      throw new SentinelPaintWiderThanCell(
        `${input.label}: the sentinel paint is wider than one cell — ${wide.pixels} px in a ${wide.box.width}x${wide.box.height} box at ${wide.box.x},${wide.box.y} against a ${size.width}x${size.height} cell — so this run stops anchoring its reads on the sentinel`,
      )
    }
    const firstRefusal = sentinelBlockRefusal(first, size)
    if (firstRefusal) throw wrong(`one box is ${firstRefusal} at ${first.box.x},${first.box.y}`)
    const secondRefusal = sentinelBlockRefusal(second, size)
    if (secondRefusal) throw wrong(`one box is ${secondRefusal} at ${second.box.x},${second.box.y}`)
    // One blended edge line at each box can leave the box up to CELL_EDGE_TOLERANCE_PX short on each
    // axis and move its origin by the same, so "the same size" and "the offset the cells imply" are
    // both read with that tolerance — never with the box size in place of the cell PITCH, which a
    // blended edge would break on every read (@dev/10 peer read).
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
    const basis = `sentinel re-located by frame difference at ${where()} (33000, 33981)`
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
      return { origin: originFromSentinel(aBox, a, size), basis }
    }
    throw wrong(
      `their offset is ${offset.x},${offset.y}, which is a pitch of ${impliedPitch.x.toFixed(2)}x${impliedPitch.y.toFixed(2)} across the ${gap.x} columns and ${gap.y} rows between the painted cells, not the ${size.width}x${size.height} cell`,
    )
  }
  // U+2588 FULL BLOCK fills the cell whatever attributes are current, and it is the character the
  // shape test above can recognise without a colour (33981, @cto 2db35bf8).
  const glyph = "\u2588"
  const at = (cell: { row: number; col: number }) => `\x1b[${cell.row};${cell.col}H`
  const paintCells = (cursor: { row: number; col: number }) =>
    input.source.write(`${at(pair().a)}${glyph}${at(pair().b)}${glyph}${at(cursor)}`)
  const clearCells = (cursor: { row: number; col: number }) =>
    input.source.write(`${at(pair().a)} ${at(pair().b)} ${at(cursor)}`)
  if (input.utf8Decoding) {
    const decoding = await input.utf8Decoding()
    if (decoding === "8-bit") {
      throw new Error(
        `${input.label}: this read paints U+2588, whose UTF-8 bytes contain 0x88, and this terminal measured ISO-8859-1 decoding, so the sentinel cannot be painted without setting a tab stop`,
      )
    }
  }
  const cursor = await input.cursorPosition()
  if (cursor === null) {
    throw new Error(
      `${input.label}: the cursor position this read must put back was not reported — no reply, or no parsable reply, to CSI 6n within the read deadline — so its crop cannot be anchored without moving the probe's cursor`,
    )
  }
  /**
   * A retry's clear can FAIL to restore the cells it painted: a space written in current attributes
   * is visible under reverse video on a screen that was not drawn reversed, so the retry would paint
   * a second visible pair beside the first and scatter them across the probe's screen. The evidence
   * is the difference at the pair the previous attempt painted, between the frame before that paint
   * and the frame after its clear (@dev/15 peer read of a887dda73).
   */
  const residueAfterClear = (stale: CapturedFrame, cleared: CapturedFrame) => {
    if (painted === undefined) return undefined
    const { regions } = locateChanged(stale, cleared)
    const rects = [cellRect(painted.a), cellRect(painted.b)]
    return regions.find((region) => rects.some((rect) => overlaps(region.box, rect)))
  }
  paintCells(cursor)
  painted = pair()
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
        clearCells(cursor)
        let cleared = await input.prePaint()
        for (;;) {
          const residue = residueAfterClear(before, cleared)
          if (residue === undefined) break
          // One post-clear frame is not proof: on the 33000 path a frame can render one capture late,
          // exactly as the paint before it did, so the clear is re-taken until the deadline and only a
          // residue that PERSISTS refuses the read (@dev/15 peer read of 52da0fd43).
          if (Date.now() >= input.deadline) {
            throw new SentinelNotOnFrame(
              `${input.label}: the clear of this read's paint did not take — ${residue.pixels} px in a ${residue.box.width}x${residue.box.height} box at ${residue.box.x},${residue.box.y} still differ at ${where()} between the frame before that paint and every frame after its clear until this read's deadline, so retrying would scatter a second visible pair across the probe's screen`,
            )
          }
          cleared = await input.prePaint()
        }
        before = cleared
        chosen = choose(before)
        paintCells(cursor)
        painted = pair()
      }
    }
  } finally {
    clearCells(cursor)
  }
}
