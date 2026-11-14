import {
  CALIBRATION_SOLID_PAINT,
  sentinelCellsInFrame,
  originFromSentinel,
  SENTINEL_BOX_SLACK_PX,
  sentinelBlockRefusal,
  sentinelFillClause,
  type CalibrationSentinel,
  type CaptureCells,
  type CapturePixelGeometry,
  type DeclaredViewportHold,
} from "@terminfo/probe-defs"
import { locateChangedColour, type CapturedFrame, type NamedTextOrigin, type OriginResolver } from "./capture-core.ts"

/** A frame this read cannot anchor yet: the paint may still be one capture behind (33000). Never fatal. */
class SentinelNotOnFrame extends Error {}

/**
 * A read that cannot prove where its crop goes. Never a fallback (34163, @cto 2b): a declared hold
 * whose frames carry no measured displacement, an ambiguous displacement, or one that differs from
 * the declaration has no origin this code may use, so it names the two frames it could not relate.
 */
export class CaptureHoldUnresolved extends Error {
  override name = "CaptureHoldUnresolved"
}

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
   * Where cell 1,1 sits in the frames this read compares, in pixels — the witnessed text origin the
   * capture adapter measures against, never a window width divided by a column count. This is also
   * the origin the witness cells are CHOSEN against (33981): the frame that decides which cells are
   * blank is the frame this run actually shows, so a window that moved since calibration still gets
   * a pair painted on cells that are background where it now is.
   */
  reading: { x: number; y: number }
  /** The cell this run was calibrated to, which the chosen cells must be measured in. */
  cell: { width: number; height: number }
  /**
   * The settled calibrated origin this route measured before the read, when the route has one
   * (34163). With it the pair is a WITNESS of where the paint landed, never a second origin source:
   * one origin per read, and the settled one wins.
   */
  settled?: NamedTextOrigin & { pixelGeometry: CapturePixelGeometry }
  /**
   * The viewport hold this read is taken under, as the probe that created it declared it (34163). A
   * hold renders the pair N rows off the settled grid, and every declared hold ends as a named
   * CaptureHoldUnresolved with no origin claimed: two frames carry net displacement only, and the
   * caller declares notches rather than rows.
   */
  scroll?: DeclaredViewportHold
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
  let before = await input.prePaint()
  chosen = choose(before)
  const resolve: OriginResolver = ({ frame, pixelGeometry }) => {
    const { a, b } = pair()
    const { regions, ignoredPixels } = locateChangedColour(before, frame, input.sentinel.rgb)
    const noise = ignoredPixels === 0 ? "" : ` (${ignoredPixels} other changed px carry no sentinel colour)`
    if (regions.length === 0) {
      throw new SentinelNotOnFrame(
        `${input.label}: no cell changed to the sentinel colour at ${where()} between the frames this read compared${noise}, so its crop cannot be anchored`,
      )
    }
    const size = { width: pixelGeometry.cellWidth, height: pixelGeometry.cellHeight }
    const wrong = (reason: string) =>
      new SentinelNotOnFrame(
        `${input.label}: the changed sentinel at ${where()} is not one painted pair: ${reason}${noise}`,
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
    const basis = `sentinel re-located by frame difference at ${where()} (33000, 33981)`
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
      // 33981 x 34163, @cto's condition on the composition: the cells were chosen against a frame at
      // `input.reading`, so a frame that moved since then put those cells somewhere else, and this
      // read cannot show they were blank in the frame it painted — the paint may have landed on ink
      // it never saw. A re-anchor computed from such a pair would carry the 33981 defect in through
      // the other door, and RE-CHOOSING cannot rescue it either: the origin it would have to re-choose
      // against is only knowable from the pair it just mistrusts, and a raw pre-paint capture cannot
      // map cells before a named origin at all (linux-capture's captureRaw says so outright). So the
      // read refuses by name instead of anchoring on a crop it cannot vouch for. This is a plain
      // Error, not a SentinelNotOnFrame: retrying repaints cells that may already have been damaged.
      //
      // A read that DECLARED a hold never reaches an origin at all (34163's cut: every declared hold
      // is CaptureHoldUnresolved), so the guard stands aside and lets that named refusal speak rather
      // than replacing it with this one. Everything else is covered, with no exception.
      const holdIsUnresolved = input.scroll !== undefined
      if (
        !holdIsUnresolved &&
        (Math.abs(derived.x - input.reading.x) > slack || Math.abs(derived.y - input.reading.y) > slack)
      ) {
        const dx = derived.x - input.reading.x
        const dy = derived.y - input.reading.y
        throw new Error(
          `${input.label}: the frame moved after ${where()} were chosen at ${input.reading.x},${input.reading.y} — the pair landed ${dx},${dy} px from it — so this read cannot show those cells were blank in the frame it painted, and it will not re-anchor from a pair that may have covered ink`,
        )
      }
      if (input.settled !== undefined) {
        return onSettledOrigin({
          label: input.label,
          settled: input.settled,
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
        // The pre-paint difference, counted so a refusal can say how much changed outside the chosen
        // pair. It does not separate a hold from a text-area move, and is never read as one (34163).
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
  const atA = () => {
    const { a } = pair()
    return `\x1b[${a.row};${a.col}H`
  }
  const atB = () => {
    const { b } = pair()
    return `\x1b[${b.row};${b.col}H`
  }
  const paintCells = () => input.source.write(`\x1b7${atA()}\x1b[0m${paint} ${atB()}${paint} \x1b[0m\x1b8`)
  const clearCells = () => input.source.write(`\x1b7${atA()}\x1b[0m ${atB()} \x1b[0m\x1b8`)
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
        chosen = choose(before)
        paintCells()
      }
    }
  } finally {
    clearCells()
  }
}

/**
 * One origin per read (34163, @cto 2026-11-13): when the route already settled a calibrated origin,
 * the pair proves the paint landed and says where. It never yields the crop origin.
 *
 * A pair still on the settled grid is an ordinary read. Any further move is refused BEFORE this
 * function, by the read's own guard, and never becomes an origin here: the cells were chosen against
 * a frame at `reading`, so a moved frame may have put them on ink this read never saw (33981), and a
 * crop computed from that pair is one nobody can vouch for. Warp's command header is the case 34163
 * first re-anchored; it refuses by name instead of cropping from a grid the terminal left.
 *
 * A declared viewport hold never becomes an origin either. Both frames carry the NET displacement of
 * the text area, so a hold of N rows with an opposite move of M rows looks exactly like one that
 * moved N - M, and the caller declares notches rather than rows: every declared hold throws
 * CaptureHoldUnresolved, ungraded, and the probe records a named todo. Measuring the row a notch
 * moves needs a non-pixel read (@i/terminfo/34222-wheel-notch-row-unit).
 */
function onSettledOrigin(input: {
  label: string
  settled: NamedTextOrigin & { pixelGeometry: CapturePixelGeometry }
  derived: { x: number; y: number }
  witness: NonNullable<NamedTextOrigin["witness"]>
  size: { width: number; height: number }
  basis: string
  changedOutside: number
  scroll?: DeclaredViewportHold
  refuse: (reason: string) => Error
}): NamedTextOrigin {
  const { settled, derived, size, scroll } = input
  // A declared hold never becomes an origin (@cto's smaller ruling, 34163): two frames carry the NET
  // displacement of the text area, so a hold of N rows plus an opposite move of M rows is
  // indistinguishable from one that moved N - M. The wheel caller has no row count to declare
  // anyway, so the honest answer is a named gap that grades nothing.
  if (scroll !== undefined) {
    throw new CaptureHoldUnresolved(
      `${input.label}: this read declared a viewport hold of ${scroll.notches} notch(es); a declared hold is not read until the rows it moves are established independently, so no origin is claimed (34163)`,
    )
  }
  // The pair landed on the origin its cells were chosen at — the guard in the resolver has already
  // refused every other displacement — so this is the ordinary case and not a re-anchor.
  const slack = SENTINEL_BOX_SLACK_PX
  if (Math.abs(derived.x - settled.origin.x) > slack || Math.abs(derived.y - settled.origin.y) > slack) {
    throw input.refuse(
      `the pair landed ${derived.x - settled.origin.x},${derived.y - settled.origin.y} px off the settled origin at ${settled.origin.x},${settled.origin.y}, which the guard in this read should already have refused`,
    )
  }
  return {
    ...settled,
    origin: settled.origin,
    basis: `${input.basis}; the pair landed on the settled calibrated origin, which is where this read crops (34163)`,
    basisKind: settled.basisKind,
    witness: input.witness,
    changedOutside: input.changedOutside,
  }
}
