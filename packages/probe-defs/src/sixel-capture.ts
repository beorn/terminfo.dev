/**
 * @failure A sixel row graded against a reference painted by the bytes under test shares that
 *   payload's failure: an ignoring terminal paints nothing, both frames agree, and the row reads
 *   supported. The reference here is an INDEPENDENT route to the same pixels — the same cell block
 *   painted as an SGR truecolor background by direct CUP writes — so the run's existing table
 *   decides: after == expected is supported, after == seed is unsupported behind the paint witness,
 *   any third frame is inconclusive by name. No oracle flag, no second decision table.
 *
 *   The tile is sized from THIS run's pixel report rather than a guessed block, rounded up to whole
 *   sixel bands, and declares a 1:1 raster aspect so the VT340 2:1 default cannot apply. Only the
 *   block's interior cell is compared, so edge scaling, band rounding and small geometry error fall
 *   outside the compared pixels; the sentinel sits outside the tile's worst-case extent.
 */
import type { RegionReadback } from "./region-readback.ts"
import type { PixelGeometry } from "./region-readback.ts"

/** The tile spans this many cells from its CUP origin. */
const BLOCK_ROWS = 3
const BLOCK_COLS = 3
const BLOCK_TOP = 3
const BLOCK_LEFT = 3
/** A sixel band is six pixels tall; a tile height that is not a whole number of bands is cut off. */
const BAND_PIXELS = 6
/** Colour 0 at 100% red, 0% green, 0% blue — exact in both encodings as 255,0,0. */
const SIXEL_RED = "#0;2;100;0;0"
const SGR_RED = "\x1b[48;2;255;0;0m"
const CLEAR = "\x1b[0m\x1b[2J\x1b[H"
/** The cursor parks below the block, outside every compared region. */
export const SIXEL_CURSOR_ROW = BLOCK_TOP + BLOCK_ROWS + 1

/** The block's interior cell: the only cells compared, so every edge effect stays outside them. */
export const SIXEL_REGION = {
  top: BLOCK_TOP + 1,
  left: BLOCK_LEFT + 1,
  bottom: BLOCK_TOP + 1,
  right: BLOCK_LEFT + 1,
} as const

/**
 * The grid this readback needs, stated once: the cursor parks below the block and the widest write
 * is the block itself. The geometry query and the readback both read this, so they cannot drift.
 */
export const SIXEL_BOUNDS = { minRows: SIXEL_CURSOR_ROW, minCols: BLOCK_LEFT + BLOCK_COLS } as const

const SENTINEL = { row: 1, col: 1 } as const

export interface SixelTileSize {
  readonly width: number
  readonly height: number
}

/** The tile's pixel size from this run's report, rounded UP to whole sixel bands. */
export function sixelTileSize(geometry: PixelGeometry): SixelTileSize {
  const { cellWidth, cellHeight } = geometry
  if (!Number.isSafeInteger(cellWidth) || !Number.isSafeInteger(cellHeight) || cellWidth <= 0 || cellHeight <= 0) {
    throw new Error(
      `sixel tile size needs positive whole pixels per cell; this run reported ${String(cellWidth)}x${String(cellHeight)}`,
    )
  }
  const width = BLOCK_COLS * cellWidth
  const bands = Math.ceil((BLOCK_ROWS * cellHeight) / BAND_PIXELS)
  return { width, height: bands * BAND_PIXELS }
}

/**
 * The ONE sixel payload this row paints: a solid colour-0 tile of the given size, `1;1` aspect,
 * every pixel of every band set. The payload names its own size so a reader can check the raster
 * attributes against the geometry it came from.
 */
export function sixelPayload(size: SixelTileSize): string {
  if (!Number.isSafeInteger(size.width) || !Number.isSafeInteger(size.height) || size.width <= 0) {
    throw new Error(`sixel payload needs a positive whole tile size; got ${String(size.width)}x${String(size.height)}`)
  }
  if (size.height % BAND_PIXELS !== 0) {
    throw new Error(`sixel payload height ${size.height} is not a whole number of ${BAND_PIXELS}-pixel bands`)
  }
  // 30052 RED-matrix mutant (experiment branch, never shipped): paint half the block in both axes
  // so the compared interior cell is partly covered. A correctly placed full tile is the baseline.
  const mutantWidth = Math.max(1, Math.floor(size.width / 2))
  const mutantBands = Math.max(1, Math.floor(size.height / BAND_PIXELS / 2))
  const bands = Array.from({ length: mutantBands }, () => `#0${"~".repeat(mutantWidth)}`)
  return `\x1bP0;1;0q"1;1;${mutantWidth};${mutantBands * BAND_PIXELS}${SIXEL_RED}${bands.join("-")}\x1b\\`
}

/** The same block painted plainly: three rows of spaces on the exact truecolor background. */
function sgrBlock(): string {
  const row = " ".repeat(BLOCK_COLS)
  return Array.from(
    { length: BLOCK_ROWS },
    (_, index) => `\x1b[${BLOCK_TOP + index};${BLOCK_LEFT}H${SGR_RED}${row}\x1b[0m`,
  ).join("")
}

function park(): string {
  return `\x1b[${SIXEL_CURSOR_ROW};1H`
}

/** The row's readback: blank seed, sixel edit, SGR-background expected frame, interior-cell region. */
export function sixelReadback(geometry: PixelGeometry): Omit<RegionReadback, "pixelGeometry"> {
  const payload = sixelPayload(sixelTileSize(geometry))
  return {
    region: { ...SIXEL_REGION },
    sentinel: { ...SENTINEL },
    cursorRow: SIXEL_CURSOR_ROW,
    seed: `${CLEAR}${park()}`,
    edit: `${CLEAR}\x1b[${BLOCK_TOP};${BLOCK_LEFT}H${payload}${park()}`,
    expected: `${CLEAR}${sgrBlock()}${park()}`,
    timeoutMs: 8000,
    pollMs: 250,
    minRows: SIXEL_BOUNDS.minRows,
    minCols: SIXEL_BOUNDS.minCols,
  }
}
