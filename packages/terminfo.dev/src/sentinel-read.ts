import {
  CALIBRATION_SOLID_PAINT,
  originFromSentinel,
  SENTINEL_BOX_SLACK_PX,
  sentinelBlockRefusal,
  sentinelFillClause,
  witnessCellsFor,
  type CalibrationSentinel,
  type CaptureCells,
  type CapturePixelGeometry,
  type CaptureRequest,
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
  /**
   * The settled calibrated origin this route measured before the read, when the route has one
   * (34163). With it the pair is a WITNESS of where the paint landed, never a second origin source:
   * one origin per read, and the settled one wins.
   */
  settled?: NamedTextOrigin & { pixelGeometry: CapturePixelGeometry }
  /**
   * The viewport hold this read is taken under, as the probe that created it declared it (34163). A
   * hold renders the pair N rows off the settled grid; declared, that is measured and recorded;
   * undeclared, it is refused by name.
   */
  scroll?: CaptureRequest["scroll"]
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
    // 34040: a tier-2 pair sits on ONE row, so its row gap is zero and no row pitch can be divided
    // out of it. It still anchors — on the column pitch and on the two boxes sharing a row within
    // the blend slack — and says so, so no reader takes it for a pair that measured both pitches.
    // The vertical move is refused elsewhere (`gridMoveExemption`), never granted from this pair.
    const oneAxis = gap.y === 0
    const impliedPitch = {
      x: Math.abs(offset.x) / Math.abs(gap.x),
      y: oneAxis ? 0 : Math.abs(offset.y) / Math.abs(gap.y),
    }
    const basis = `sentinel re-located by frame difference at ${where} (33000, 33981)`
    const basisKind = "sentinel pair located by frame difference"
    const columnDirection = Math.sign(offset.x) * Math.sign(gap.x)
    const direction = oneAxis
      ? columnDirection
      : columnDirection === Math.sign(offset.y) * Math.sign(gap.y)
        ? columnDirection
        : 0
    // "One row" is not a free pass on the row: the two boxes' vertical origins may differ by the
    // blend slack at most, and by less than half a cell — a whole-cell row apart is not one row.
    const rowsAgree = oneAxis
      ? Math.abs(offset.y) <= slack && Math.abs(offset.y) < size.height / 2
      : Math.abs(impliedPitch.y - size.height) <= slack
    if (direction !== 0 && Math.abs(impliedPitch.x - size.width) <= slack && rowsAgree) {
      const aBox = direction > 0 ? first : second
      const bBox = direction > 0 ? second : first
      // 34015: a box the size of the cell that is one or two pixels short is ACCEPTED, and says so
      // here — the basis travels on the frame, so a reader can count how many reads leaned on the
      // slack instead of inferring it from a silence.
      const derived = originFromSentinel(aBox, a, size)
      const witness = {
        a: { cell: { row: a.row, col: a.col }, box: { x: aBox.box.x, y: aBox.box.y } },
        b: { cell: { row: b.row, col: b.col }, box: { x: bBox.box.x, y: bBox.box.y } },
      }
      const basisText = `${basis}${oneAxis ? " (one-axis pair: both cells on one row, so it measures the column pitch only)" : ""}${noise}${sentinelFillClause([aBox, bBox])}`
      if (input.settled !== undefined) {
        return onSettledOrigin({
          label: input.label,
          settled: input.settled,
          pixelGeometry,
          derived,
          witness,
          size,
          basis: basisText,
          changedOutside: ignoredPixels,
          ...(input.scroll !== undefined ? { scroll: input.scroll } : {}),
          refuse: wrong,
        })
      }
      return {
        origin: derived,
        basis: basisText,
        basisKind,
        // The origin came from `aBox` alone; the pair travels so a later comparison can prove the
        // pitch on its own rather than restating the one box it already reduced to an origin (33982).
        witness,
        // The pre-paint difference, counted: a held viewport moved by whole rows leaves this small,
        // a re-anchored one leaves it large, and a refusal can then name which (34163).
        changedOutside: ignoredPixels,
      }
    }
    throw wrong(
      !oneAxis
        ? `their offset is ${offset.x},${offset.y}, which is a pitch of ${impliedPitch.x.toFixed(2)}x${impliedPitch.y.toFixed(2)} across the ${gap.x} columns and ${gap.y} rows between the painted cells, not the ${size.width}x${size.height} cell`
        : !rowsAgree
          ? `their offset is ${offset.x},${offset.y}: this pair is on one row, so it can only measure the column pitch, and these two boxes do not share a row — they sit ${Math.abs(offset.y)} px apart vertically, more than the ${slack} px blend slack or half the ${size.height} px cell`
          : `their offset is ${offset.x},${offset.y} across the ${gap.x} columns of one shared row, which is a column pitch of ${impliedPitch.x.toFixed(2)} px, not the ${size.width} px cell`,
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

/**
 * One origin per read (34163, @cto 2026-11-13): when the route already settled a calibrated origin,
 * the pair's job is to prove the paint landed and to say where. It never yields the crop origin.
 *
 * A declared viewport hold moves the pair off the settled grid by whole ROWS — measured live at one
 * wheel notch for both kitty (10 + 5x29) and ghostty (2 + 3x28) — so the read crops at the settled
 * origin and records the delta as an OBSERVATION. No grade or published cell may read `scrolledRows`
 * until the XTest wheel event's effective displacement is measured: "one notch" is not a row count.
 *
 * Undeclared reads keep 33000's re-anchor when the frame's own extent moved (Warp's command header
 * does exactly that, and those reads must still crop correctly). An undeclared pair that moved by
 * whole rows while the extent is unchanged is the hold signature, and it refuses by name: a probe
 * holding its viewport must say so, or the read silently crops from a grid the terminal left.
 */
function onSettledOrigin(input: {
  label: string
  settled: NamedTextOrigin & { pixelGeometry: CapturePixelGeometry }
  pixelGeometry: CapturePixelGeometry
  derived: { x: number; y: number }
  witness: NonNullable<NamedTextOrigin["witness"]>
  size: { width: number; height: number }
  basis: string
  changedOutside: number
  scroll?: CaptureRequest["scroll"]
  refuse: (reason: string) => Error
}): NamedTextOrigin {
  const { settled, derived, size, scroll } = input
  const settledGeometry = settled.pixelGeometry
  const extentMoved =
    input.pixelGeometry.cellWidth !== settledGeometry.cellWidth ||
    input.pixelGeometry.cellHeight !== settledGeometry.cellHeight ||
    input.pixelGeometry.textWidth !== settledGeometry.textWidth ||
    input.pixelGeometry.textHeight !== settledGeometry.textHeight
  const dx = derived.x - settled.origin.x
  const dy = derived.y - settled.origin.y
  const slack = SENTINEL_BOX_SLACK_PX
  const rows = Math.round(dy / size.height)
  const wholeRows = Math.abs(dy - rows * size.height) <= slack
  const movedBy = `the pair landed ${dy} px (${wholeRows ? `${rows} rows` : "not a whole number of rows"}) off the settled origin at ${settled.origin.x},${settled.origin.y}, which puts its box at ${derived.x},${derived.y} against an expected ${settled.origin.x},${settled.origin.y} for a ${size.width}x${size.height} cell`
  const reanchored: NamedTextOrigin = {
    ...settled,
    origin: derived,
    basis: `${input.basis}; re-anchored from the pair because the frame's own pixel geometry moved after calibration (33000)`,
    basisKind: settled.basisKind,
    witness: input.witness,
    changedOutside: input.changedOutside,
  }
  if (scroll === undefined) {
    if (extentMoved || !wholeRows || Math.abs(dx) > slack || rows === 0) return reanchored
    throw input.refuse(
      `${input.label}: ${movedBy}, and this read did not declare a viewport hold. A probe whose viewport is held above the bottom must declare it on the capture request (34163); an undeclared move is not re-anchored, because re-anchoring it is exactly how a held read crops the wrong cells in silence`,
    )
  }
  if (extentMoved) {
    throw input.refuse(
      `${input.label}: this read declared a viewport hold of ${scroll.notches} notch(es) but ${movedBy}, and the frame's pixel geometry differs from the settled one after calibration — a hold plus a geometry change is not one read's story`,
    )
  }
  if (Math.abs(dx) > slack) {
    throw input.refuse(
      `${input.label}: this read declared a viewport hold of ${scroll.notches} notch(es) up, which moves the pair in ROWS; ${movedBy} and the horizontal offset is ${dx} px, so this is not a hold`,
    )
  }
  if (!wholeRows) {
    throw input.refuse(
      `${input.label}: this read declared a viewport hold of ${scroll.notches} notch(es) but ${movedBy}: a hold moves the pair by whole rows of the ${size.width}x${size.height} cell`,
    )
  }
  if (rows === 0) {
    throw input.refuse(
      `${input.label}: this read declared a viewport hold of ${scroll.notches} notch(es) and the pair landed exactly on the settled origin, so the declaration was not in effect when this frame was taken — a held read that reports no delta is a contradiction, not a quiet zero`,
    )
  }
  const expectedSign = scroll.direction === "up" ? 1 : -1
  if (Math.sign(rows) !== expectedSign) {
    throw input.refuse(
      `${input.label}: this read declared the viewport held ${scroll.direction} and the pair landed ${rows} rows off the settled origin, whose sign is the other way — a hold in that direction cannot move the pair there`,
    )
  }
  if (Math.abs(rows) > scroll.maxRows) {
    throw input.refuse(
      `${input.label}: this read declared a viewport hold of ${scroll.notches} notch(es) that can have scrolled at most ${scroll.maxRows} rows on this screen, and the pair landed ${Math.abs(rows)} rows off the settled origin`,
    )
  }
  return {
    ...settled,
    origin: settled.origin,
    basis: `${input.basis}; cropped at the settled calibrated origin, and the pair landed ${Math.abs(rows)} rows ${rows > 0 ? "below" : "above"} it under a declared hold of ${scroll.notches} notch(es) (observation only — no grade reads it until the XTest wheel unit is measured, 34163)`,
    basisKind: settled.basisKind,
    witness: input.witness,
    changedOutside: input.changedOutside,
    scrolledRows: { rows, direction: scroll.direction, notches: scroll.notches },
  }
}
