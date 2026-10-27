/**
 * The region-readback OBSERVATION KIND (28450 A2): one factory, one row per probe, BOTH
 * arms derived from that row. A family repairs its hand-written probes by declaring rows; a probe
 * that needs something this kind cannot express adds a KIND — once, reviewed — never another
 * hand-written callback of its own.
 *
 * The row holds the claim ONCE. The capture-region oracle's seed, edit and expected frames are
 * derived from the row's own seed, steps and cells here, so the parser-state arm and the pixel arm
 * cannot drift into grading two different fixtures (which is how the first revision of this kind
 * shipped an edit that rewrote its own control).
 *
 * The compared cells are a GRID — one row per screen ROW: "the cells become a
 * grid (one string[] per row). Extend the kind once, with that family". One row of cells is the
 * one-row grid, so a family that needs a scroll region, a multi-line erase or an insert/delete line
 * declares it instead of adding a second factory.
 *
 * A cell is a character, or a character carrying the attributes its row ASSERTS (the DECSACE
 * ruling): the third attribute-rectangle probe converted the kind once, so DECCARA, DECRARA and the
 * EL background row grade attribute changes on both arms instead of being hand-written beside it.
 */
import type { ProbeDefinition, LibProbeSource } from "./types.ts"
import { captureRegionVerdict, type RegionReadback } from "./region-readback.ts"
import { isBlank, notTestedResult, parserStateResult } from "./helpers.ts"

/** One write between the seed frame and the final read, and the cursor report it must reach. */
export interface RegionReadbackStep {
  /** Bytes written after the seed frame. */
  write: string
  /** The 0-based cursor report this step must reach, and the note when it did not. */
  cursor?: { x: number; y: number; note: string }
}

/** One cell the row's sequence must leave untouched, so the claim can be read from the rest. */
export interface RegionReadbackControl {
  /** 0-based row inside the compared grid. */
  row: number
  /** 0-based column inside the compared columns. */
  col: number
  char: string
}

/** The top-left corner of the compared region, 1-based screen rows and columns. */
export interface RegionReadbackRegion {
  top: number
  left: number
}

/**
 * A color the row can assert WITHOUT pinning a backend's palette: `"present"` asserts the cell has
 * a background at all, and `"same-as-before"` asserts the cell kept the one the seed painted at the
 * same grid position. A named SGR resolves through each terminal's own palette, so an absolute RGB
 * here would be a backend's value, not the claim.
 */
export type RegionReadbackColor = "present" | "same-as-before"

/**
 * The attributes a compared cell asserts. A cell declares ONLY what its row claims, so a terminal
 * that sets anything else is never graded on it. Only the forms a row actually uses live here: an
 * unused spelling is a claim nothing measures.
 */
export interface RegionReadbackAttributes {
  /** True asserts the attribute is set; false asserts the sequence CLEARED it. */
  inverse?: boolean
  bg?: RegionReadbackColor
}

/** The SGR bytes the expected frame paints for a relative background claim. Required with one. */
export interface RegionReadbackPaint {
  bg?: string
}

/**
 * The terminal's OWN default-background fixture, measured before the row paints anything. A relative
 * colour claim (`present`, `same-as-before`) is only established when the painted seed DIFFERS from
 * this measurement at the same cell: a backend that reports one concrete RGB as its default and
 * ignores the row's SGR would otherwise satisfy both sides of the claim.
 */
export interface RegionReadbackBaseline {
  /** The write that paints the default-background fixture, before the row's own seed. */
  seed: string
  /** The cells that write must show. Read char-only: only their MEASURED colours qualify the seed. */
  cells: readonly (readonly RegionReadbackCell[])[]
}

/**
 * One compared cell: a plain character, or a character carrying the attributes its row asserts.
 * Character-only rows keep the string spelling, so their grids, test doubles and verdicts are
 * unchanged.
 */
export type RegionReadbackCell = string | { char: string; attributes: RegionReadbackAttributes }

export interface RegionReadbackRow extends Pick<ProbeDefinition, "textClaim"> {
  id: string
  /** The claim in words: the termless arm's `expected`, and the kind table test's row label. */
  expected: string
  /** The seed frame's writes. */
  seed: string
  /**
   * The cells the seed frame must show: one `string[]` per compared ROW, one entry per compared
   * COLUMN, in screen order. A wide follower is `""`.
   */
  before: readonly (readonly RegionReadbackCell[])[]
  /** The writes between the seed and the final read, in order. */
  steps: readonly RegionReadbackStep[]
  /**
   * The cells the sequence under test must show, in the same grid shape. A blank cell — never
   * written, erased, vacated, or a wide glyph's follower — is compared by blank equality: `""` and
   * `" "` on either side are the same blank (see `sameCell`), so a correct terminal is never graded
   * unsupported for choosing the backend's own spelling.
   */
  after: readonly (readonly RegionReadbackCell[])[]
  /**
   * Cells whose position the sequence must preserve. A control is a real control only when the
   * sequence does not write it. Only when every one holds is `after` a verdict; a moved control means
   * the fixture, not the capability, is what failed, so the row reads inconclusive instead.
   */
  controls: readonly RegionReadbackControl[]
  /** The note when the seed frame was not measured. */
  seedNote: string
  /** The note when a control cell moved, so the claim cannot be read. */
  controlNote: string
  /** The normalizing write the termless arm makes whether or not it decided, and the pixel prelude. */
  reset: string
  /** The grid the sequence would leave if it IGNORED the one attribute it claims. */
  ignored?: readonly (readonly RegionReadbackCell[])[]
  /**
   * The terminal's own default-background fixture, measured first. REQUIRED when any compared cell
   * makes a relative colour claim, because the claim is "the seed painted something the default does
   * not show" and only a baseline measurement can establish that.
   */
  baseline?: RegionReadbackBaseline
  /** The note when the baseline fixture itself was not measured. */
  baselineNote?: string
  /**
   * The SGR the expected frame paints for a cell whose fg/bg assertion is `"present"` or
   * `"same-as-before"`. Loading refuses a row that declares one without its bytes: an unpainted
   * expected frame would read equal to the seed and go inconclusive on every adapter.
   */
  paint?: RegionReadbackPaint
  /**
   * The compared region's top-left corner. Its bottom and right DERIVE from the grid's own shape, so
   * a region can no longer disagree with the cells it compares. Default `{ top: 1, left: 1 }`.
   */
  region?: RegionReadbackRegion
  /**
   * The screen row the fixture parks its cursor on, and the witness row the capture oracle needs.
   * Both default BELOW the region (bottom + 1 and bottom + 2) and both must stay there: a parked
   * cursor inside the compared region would have its own park write overwrite a compared cell.
   */
  cursorRow?: number
  sentinel?: { row: number; col?: number }
  /**
   * A write the capture oracle needs AFTER its frames — a mode or a scroll region the last frame
   * leaves set, which a later probe sharing this terminal must not inherit. The oracle issues it from
   * its own `finally`, so it lands exactly when the oracle wrote bytes and never on a pre-write
   * refusal: a `none` observation has to leave a zero-byte trace (run-parser's zero-byte rule). Named
   * for the JOB, not the moment it runs: `afterVerdict` named a time, and this is the
   * write that clears the mode the last frame left set.
   */
  cleanup?: string
  /**
   * This row's expected frame is written PLAINLY, so the kind carries the row's own decode-context
   * precondition into the derived spec: a run measured 8-bit is inconclusive BY NAME before the
   * first capture, never compared against glyphs its terminal cannot paint (#28752). The row
   * declares it here rather than growing a callback of its own, which is what the kind exists for.
   */
  requiresUtf8?: true
  /**
   * An explicit minimum terminal geometry. Absent, it DERIVES from the row (max(cursor row, sentinel
   * row) rows; max(region right, sentinel column) columns plus the family's two-column margin). An
   * explicit value below that need can only make an arm run on a grid smaller than it addresses, so it
   * refuses at LOAD; a larger value is kept only with a one-line reason on the row.
   */
  minRows?: number
  minCols?: number
}

const TIMEOUT_MS = 5000
const POLL_MS = 250
/**
 * Columns of slack past the cells a row addresses. The parked cursor and the sentinel both sit on
 * column 1 of their own rows, so the region's right edge is the true column need; this margin is the
 * one the family has always declared (a hand-written row's `right + 2`), kept so a grid one column
 * narrower than a row's fixture is refused rather than driven.
 */
const COLUMN_MARGIN = 2
/** Clear, home, and the row's own designation reset, so every derived frame starts from one state. */
const PRELUDE = "\x1b[0m\x1b[2J\x1b[H"

/** Everything the row's grid and region imply. Derived once, from a validated row. */
interface RegionReadbackGeometry {
  rows: number
  columns: number
  top: number
  left: number
  bottom: number
  right: number
  cursorRow: number
  sentinelRow: number
  sentinelCol: number
  park: string
  /** The grid this row actually addresses: `minRows` / `minCols` fall back here. */
  minRows: number
  minCols: number
}

/**
 * A blank cell is ONE cell in two spellings: a never-written, erased or vacated cell reads `""` on
 * every real backend (xterm.js, Ghostty WASM, vt100.js and vterm all measured) while the fixture
 * spells it `" "`, and a wide glyph's follower is the reserved-empty `""`. Either spelling, on
 * either side, is the same blank (the shared `isBlank` helper) — a terminal that implements a
 * sequence must never grade unsupported for choosing the other spelling (28450 must-fix 1).
 */
type MeasuredCell = ReturnType<LibProbeSource["getCell"]>

/**
 * One cell compared against its declared expectation. The character keeps the blank rule; an
 * attribute-carrying cell adds ONLY the fields it declares, so absent attributes are unread (never
 * equal, never unequal) and a terminal is not graded on state the row never claimed.
 */
function sameCell(measured: MeasuredCell, expected: RegionReadbackCell, reference?: MeasuredCell): boolean {
  const character = cellChar(expected)
  const characterMatches = isBlank(character) ? isBlank(measured.char) : measured.char === character
  if (!characterMatches) return false
  if (typeof expected === "string") return true
  const attributes = expected.attributes
  if (attributes.inverse !== undefined && measured.inverse !== attributes.inverse) return false
  if (attributes.bg !== undefined && !sameColorClaim(measured.bg, attributes.bg, reference?.bg)) return false
  return true
}

function cellChar(cell: RegionReadbackCell): string {
  return typeof cell === "string" ? cell : cell.char
}

type Rgb = { r: number; g: number; b: number }
type MeasuredColor = Rgb | null

function sameColorClaim(measured: MeasuredColor, claim: RegionReadbackColor, reference: MeasuredColor | undefined) {
  if (measured === null) return false
  if (claim === "present") return true
  if (reference === undefined) {
    throw new Error("a same-as-before color claim reached the comparison without its seed cell")
  }
  return reference !== null && reference.r === measured.r && reference.g === measured.g && reference.b === measured.b
}

/**
 * The first declared attribute the measured cell does not report AT ALL, or null. Sparse test doubles
 * can omit a field the real contract requires; an unread value is never equal and never unequal, so
 * the row refuses by name instead of grading a negative or throwing on absent metadata.
 */
function unreadAttribute(
  measured: readonly (readonly MeasuredCell[])[],
  declared: readonly (readonly RegionReadbackCell[])[],
  row: number,
): string | null {
  for (const [col, want] of (declared[row] ?? []).entries()) {
    if (typeof want === "string") continue
    const cell = measured[row]?.[col]
    if (cell === undefined) return `cell ${row},${col} was not measured`
    for (const field of ["inverse", "bg"] as const) {
      if (want.attributes[field] === undefined) continue
      if (cell[field] === undefined) return `cell ${row},${col} ${field}`
    }
  }
  return null
}

/** Every unread declared attribute in a grid, as the note a refusal names. */
function unreadAttributes(
  measured: readonly (readonly MeasuredCell[])[],
  declared: readonly (readonly RegionReadbackCell[])[],
): string | null {
  for (let row = 0; row < declared.length; row++) {
    const unread = unreadAttribute(measured, declared, row)
    if (unread !== null) return unread
  }
  return null
}

/**
 * Why the painted seed is not qualified by the default-background fixture, or null when it is. Two
 * failures: a colour equal to the default at the same cell (`present` and `same-as-before` both hold
 * vacuously there), and a baseline channel the backend never reported — an unread value is never
 * equal and never unequal, so treating it as "different" would qualify the seed on nothing.
 */
function unpaintedColor(
  painted: readonly (readonly MeasuredCell[])[],
  baseline: readonly (readonly MeasuredCell[])[],
  declared: readonly (readonly RegionReadbackCell[])[],
): string | null {
  for (const [row, cells] of declared.entries()) {
    for (const [col, want] of cells.entries()) {
      if (typeof want === "string") continue
      for (const channel of ["bg"] as const) {
        const claim = want.attributes[channel]
        if (claim === undefined) continue
        const seed = painted[row]?.[col]?.[channel]
        const plain = baseline[row]?.[col]?.[channel]
        if (plain === undefined) {
          return `the default-background seed does not report ${channel} at cell ${row},${col}, so the painted colour cannot be qualified`
        }
        if (seed === undefined || seed === null) {
          // An unread painted seed cannot qualify a relative claim: continuing here would let a
          // cell whose colour nothing measured satisfy the check.
          return `the painted seed reports no ${channel} at cell ${row},${col}, so the colour claim cannot be qualified`
        }
        if (plain !== null && plain.r === seed.r && plain.g === seed.g && plain.b === seed.b) {
          return `the painted seed reports the same colour as the default-background seed at cell ${row},${col} ${channel}, so the colour fixture was not established`
        }
      }
    }
  }
  return null
}

/** The SGR the expected frame paints for a declared attribute cell. */
function attributeSgr(attributes: RegionReadbackAttributes, paint: RegionReadbackPaint | undefined): string {
  const codes: string[] = []
  if (attributes.inverse === true) codes.push("7")
  const bg = attributes.bg
  // assertRelativeClaimsPainted proved at LOAD that every relative bg claim carries its bytes, so
  // this narrowing is that proof and the painter carries no second refusal of its own.
  if (bg !== undefined) codes.push(paintBytes(paint?.bg as string))
  return codes.length === 0 ? "" : `\x1b[${codes.join(";")}m`
}

/** The SGR parameters inside a row's paint bytes; loading proved they exist for every claim. */
function paintBytes(paint: string): string {
  return paint.replace(/^\x1b\[/u, "").replace(/m$/u, "")
}

/**
 * A wide follower paints nothing of its own: its lead glyph already claimed the column. An
 * attribute cell paints its declared SGR around its character, so the expected frame differs from
 * the seed exactly where an adapter that reads attributes can see the difference.
 */
function paintRow(cells: readonly RegionReadbackCell[], paint: RegionReadbackPaint | undefined): string {
  let painted = ""
  for (const cell of cells) {
    const character = cellChar(cell)
    if (character === "") continue
    if (typeof cell === "string") {
      painted += character
      continue
    }
    painted += `\x1b[0m${attributeSgr(cell.attributes, paint)}${character}\x1b[0m`
  }
  return painted
}

/**
 * Column-by-column equality for one grid row. A column the row does not name can never match, so a
 * shape that slipped past the load check fails CLOSED here rather than being read against a blank and
 * accepted.
 */
function cellsMatch(
  measured: readonly MeasuredCell[],
  expected: readonly RegionReadbackCell[],
  reference: readonly MeasuredCell[] | undefined,
): boolean {
  if (measured.length !== expected.length) return false
  return measured.every((cell, col) => {
    const want = expected[col]
    return want !== undefined && sameCell(cell, want, reference?.[col])
  })
}

/** Row-by-row equality: a grid with the wrong number of rows can never match. */
function gridMatch(
  measured: readonly (readonly MeasuredCell[])[],
  expected: readonly (readonly RegionReadbackCell[])[],
  reference?: readonly (readonly MeasuredCell[])[],
): boolean {
  if (measured.length !== expected.length) return false
  return measured.every((cells, row) => {
    const want = expected[row]
    return want !== undefined && cellsMatch(cells, want, reference?.[row])
  })
}

/** The compared region's cells, read from the parser at their own screen positions. */
function readGrid(ctx: LibProbeSource, geometry: RegionReadbackGeometry): MeasuredCell[][] {
  return Array.from({ length: geometry.rows }, (_, row) =>
    Array.from({ length: geometry.columns }, (_, col) => ctx.getCell(geometry.top - 1 + row, geometry.left - 1 + col)),
  )
}

/**
 * The measured grid as the row's RAW REPLY. A character-only row keeps the character spelling it has
 * always carried, so stored run payloads and the real-parser tests read exactly as before; a cell the
 * row declares with attributes reports the measured cell, so the evidence names the attribute it
 * asserted instead of dropping it.
 */
function responseGrid(
  measured: readonly (readonly MeasuredCell[])[],
  declared: readonly (readonly RegionReadbackCell[])[],
): readonly (readonly (MeasuredCell | string)[])[] {
  return measured.map((cells, row) =>
    cells.map((cell, col) => {
      const want = declared[row]?.[col]
      return want === undefined || typeof want === "string" ? cell.char : cell
    }),
  )
}

function cup(row: number, col: number): string {
  return `\x1b[${row};${col}H`
}

/** The frame a grid paints: each compared row at its own screen row and left column. */
function paintFrame(
  grid: readonly (readonly RegionReadbackCell[])[],
  geometry: RegionReadbackGeometry,
  paint: RegionReadbackPaint | undefined,
): string {
  return grid.map((cells, row) => cup(geometry.top + row, geometry.left) + paintRow(cells, paint)).join("")
}

/**
 * A relative colour claim (`present`, `same-as-before`) is only established against a measured
 * default: without a baseline the claim would hold vacuously on a backend that ignores the row's
 * SGR. Loaded rows cannot make one without the fixture.
 */
function assertRelativeClaimsQualified(row: RegionReadbackRow): void {
  if (row.baseline !== undefined) return
  for (const cells of [...row.before, ...row.after]) {
    for (const cell of cells) {
      if (typeof cell === "string") continue
      if (cell.attributes.bg !== undefined) {
        throw new Error(`${row.id}: a relative bg claim needs a baseline fixture to qualify the seed`)
      }
    }
  }
}

/**
 * A relative colour claim paints the expected frame with the row's own SGR. Without those bytes the
 * expected frame would read equal to the seed on every adapter and the row could only ever be
 * inconclusive, so the row refuses at LOAD instead of shipping a claim nothing can decide, and a
 * load-time test pins exactly that refusal.
 */
function assertRelativeClaimsPainted(row: RegionReadbackRow): void {
  // EVERY frame the row builds, not only `after`: `ignored` is painted by the same paintFrame call,
  // so a relative claim there needs the same bytes. The message names the row, and paintBytes has
  // no refusal of its own, so a test that deletes this check cannot pass on a row-less fallback.
  for (const cells of [row.after, ...(row.ignored === undefined ? [] : [row.ignored])]) {
    for (const [rowIndex, line] of cells.entries()) {
      for (const [col, cell] of line.entries()) {
        if (typeof cell === "string") continue
        if (cell.attributes.bg === undefined) continue
        // Falsy, not only undefined: an empty string would paint no background and ship a claim no
        // adapter can decide, so it refuses here with the row id.
        if (!row.paint?.bg) {
          throw new Error(`${row.id}: cell ${rowIndex},${col} asserts a relative bg with no paint bytes`)
        }
      }
    }
  }
}

/**
 * A row whose own shape disagrees with itself cannot be right, so it refuses at LOAD instead of
 * comparing a short array's missing cell against a blank that `sameCell` would happily accept — a
 * typo must never read as a passing terminal (NO SILENT ERRORS). Every index the
 * arms use below is proven in range here, which is why nothing below needs a fallback.
 */
function assertRegionReadbackShape(row: RegionReadbackRow): RegionReadbackGeometry {
  const rows = row.before.length
  if (rows === 0) throw new Error(`${row.id}: a region-readback row needs at least one compared row`)
  const columns = row.before[0]?.length ?? 0
  if (columns === 0) throw new Error(`${row.id}: a region-readback row needs at least one compared column`)
  row.before.forEach((cells, index) => {
    if (cells.length !== columns) {
      throw new Error(`${row.id}: compared row ${index} names ${cells.length} cells for ${columns} compared columns`)
    }
  })
  if (row.after.length !== rows) {
    throw new Error(`${row.id}: after names ${row.after.length} rows for ${rows} compared rows`)
  }
  row.after.forEach((cells, index) => {
    if (cells.length !== columns) {
      throw new Error(`${row.id}: after row ${index} names ${cells.length} cells for ${columns} compared columns`)
    }
  })
  if (row.ignored !== undefined) {
    if (row.ignored.length !== rows) {
      throw new Error(`${row.id}: ignored names ${row.ignored.length} rows for ${rows} compared rows`)
    }
    row.ignored.forEach((cells, index) => {
      if (cells.length !== columns) {
        throw new Error(`${row.id}: ignored row ${index} names ${cells.length} cells for ${columns} compared columns`)
      }
    })
  }
  const top = row.region?.top ?? 1
  const left = row.region?.left ?? 1
  if (!Number.isSafeInteger(top) || top < 1) throw new Error(`${row.id}: region top ${top} is not a screen row`)
  if (!Number.isSafeInteger(left) || left < 1) throw new Error(`${row.id}: region left ${left} is not a screen column`)
  const bottom = top + rows - 1
  const right = left + columns - 1
  const cursorRow = row.cursorRow ?? bottom + 1
  const sentinelRow = row.sentinel?.row ?? bottom + 2
  const sentinelCol = row.sentinel?.col ?? left
  if (!Number.isSafeInteger(cursorRow) || cursorRow <= bottom) {
    throw new Error(`${row.id}: cursor row ${cursorRow} must be below the compared region rows ${top}..${bottom}`)
  }
  if (!Number.isSafeInteger(sentinelRow) || sentinelRow <= bottom) {
    throw new Error(`${row.id}: sentinel row ${sentinelRow} must be below the compared region rows ${top}..${bottom}`)
  }
  if (!Number.isSafeInteger(sentinelCol) || sentinelCol < left) {
    throw new Error(`${row.id}: sentinel column ${sentinelCol} is left of the compared region column ${left}`)
  }
  for (const control of row.controls) {
    if (!Number.isSafeInteger(control.row) || control.row < 0 || control.row >= rows) {
      throw new Error(`${row.id}: control row ${control.row} is outside the compared 0..${rows - 1}`)
    }
    if (!Number.isSafeInteger(control.col) || control.col < 0 || control.col >= columns) {
      throw new Error(`${row.id}: control column ${control.col} is outside the compared 0..${columns - 1}`)
    }
  }
  assertRelativeClaimsQualified(row)
  assertRelativeClaimsPainted(row)
  // The geometry this row really addresses (must-fix 2). The parked cursor AND the
  // sentinel are screen rows, so the need is the larger of the two: deriving it from the sentinel alone
  // let a row declare a minimum that parked its own cursor off-screen (reverse-index: cursor 6,
  // sentinel 5, so the old rule derived 5 and only an explicit 7 hid it). The column need is the
  // region's own right edge with the sentinel's column folded in and the family margin added, because
  // the region's bottom and right already derive from the grid. An explicit minimum below this need can
  // only make an arm run on a grid smaller than the fixture addresses, so it refuses at LOAD and names
  // both numbers; a larger explicit value is for a row to justify in one line.
  const minRows = Math.max(cursorRow, sentinelRow)
  const minCols = Math.max(right, sentinelCol) + COLUMN_MARGIN
  if (row.minRows !== undefined && row.minRows < minRows) {
    throw new Error(
      `${row.id}: explicit minRows ${row.minRows} is below the ${minRows} rows this row uses (cursor row ${cursorRow}, sentinel row ${sentinelRow})`,
    )
  }
  if (row.minCols !== undefined && row.minCols < minCols) {
    throw new Error(
      `${row.id}: explicit minCols ${row.minCols} is below the ${minCols} columns this row uses (region right ${right}, sentinel column ${sentinelCol}, margin ${COLUMN_MARGIN})`,
    )
  }
  return {
    rows,
    columns,
    top,
    left,
    bottom,
    right,
    cursorRow,
    sentinelRow,
    sentinelCol,
    park: cup(cursorRow, 1),
    minRows,
    minCols,
  }
}

/** The capture-region spec the row implies, so the two arms grade one fixture. */
function regionReadbackSpec(
  row: RegionReadbackRow,
  geometry: RegionReadbackGeometry,
): Omit<RegionReadback, "pixelGeometry"> {
  const prelude = PRELUDE + row.reset
  return {
    region: { top: geometry.top, left: geometry.left, bottom: geometry.bottom, right: geometry.right },
    sentinel: { row: geometry.sentinelRow, col: geometry.sentinelCol },
    cursorRow: geometry.cursorRow,
    seed: prelude + (row.baseline?.seed ?? "") + row.seed + geometry.park,
    edit: row.steps.map((step) => step.write).join("") + geometry.park,
    expected: prelude + paintFrame(row.after, geometry, row.paint) + geometry.park,
    ...(row.ignored === undefined
      ? {}
      : { ignored: prelude + paintFrame(row.ignored, geometry, row.paint) + geometry.park }),
    ...(row.cleanup === undefined ? {} : { cleanup: row.cleanup }),
    ...(row.requiresUtf8 === true ? { requiresUtf8: true as const } : {}),
    timeoutMs: TIMEOUT_MS,
    pollMs: POLL_MS,
    minRows: row.minRows ?? geometry.minRows,
    minCols: row.minCols ?? geometry.minCols,
  }
}

/**
 * Build the one probe a row describes. The termless arm measures the parser's cells; the term arm
 * hands the derived seed / edit / expected frames to the capture-region oracle. A run with no owned
 * capture cannot read a window back at all, so that arm refuses by NAME and writes nothing: a
 * fixture that can only answer "inconclusive" is not evidence, and is deleted rather than kept.
 */
export function regionReadbackProbe(row: RegionReadbackRow): ProbeDefinition {
  const geometry = assertRegionReadbackShape(row)
  const readback = regionReadbackSpec(row, geometry)
  return {
    id: row.id,
    termNeedsGeometry: true,
    cellReadback: true,
    ...(row.textClaim === undefined ? {} : { textClaim: row.textClaim }),
    termAssertionType: "screenshot",
    libAssertionType: "buffer_state",
    lib(ctx) {
      // The library source reports its width and nothing else: the parser arms address cells by
      // row directly, so the only geometry they can be refused on is the compared region's width.
      if (!Number.isSafeInteger(ctx.cols) || ctx.cols < geometry.right) {
        return parserStateResult(
          null,
          row.expected,
          { cols: ctx.cols },
          `Need at least ${geometry.right} measured columns for this region fixture`,
        )
      }
      try {
        const baselineRow = row.baseline
        let baseline: MeasuredCell[][] | undefined
        if (baselineRow !== undefined) {
          ctx.feed(baselineRow.seed)
          baseline = readGrid(ctx, geometry)
          if (!gridMatch(baseline, baselineRow.cells)) {
            return parserStateResult(
              null,
              row.expected,
              { baseline: responseGrid(baseline, baselineRow.cells) },
              row.baselineNote ?? `${row.id}: the default-background fixture was not measured`,
            )
          }
        }
        ctx.feed(row.seed)
        const before = readGrid(ctx, geometry)
        // BEFORE the grid comparison: an unread exact claim inside sameColorClaim throws, and an
        // unread bold or inverse would otherwise be reported as "seed not established" instead of
        // named.
        const unreadSeed = unreadAttributes(before, row.before)
        if (unreadSeed !== null) {
          return parserStateResult(
            null,
            row.expected,
            { before: responseGrid(before, row.before) },
            `${row.id}: the backend does not report ${unreadSeed} on the seed, so the claim cannot be read`,
          )
        }
        if (!gridMatch(before, row.before)) {
          // #30701, @cto ruling C: a seed whose only miss is an attribute the row paints (inverse, a
          // background) leaves the claim's reference uncalibrated (TEST TODO naming it). Any other miss,
          // missing characters or an attribute the seed declares absent, is a fixture that never
          // landed, inconclusive by the row's own note.
          const painted = new Set<string>()
          const unpainted = row.before.map((cells) =>
            cells.map((cell): RegionReadbackCell => {
              if (typeof cell === "string") return cell
              if (cell.attributes.inverse === true) painted.add("inverse")
              if (cell.attributes.bg !== undefined) painted.add("bg")
              return { char: cell.char, attributes: cell.attributes.inverse === false ? { inverse: false } : {} }
            }),
          )
          if (painted.size > 0 && gridMatch(before, unpainted)) {
            return notTestedResult(
              `${row.id}: the seed's painted ${[...painted].join(" and ")} on the region cells in the headless readback (the seed characters arrived without it)`,
              { before: responseGrid(before, row.before) },
            )
          }
          return parserStateResult(null, row.expected, { before: responseGrid(before, row.before) }, row.seedNote)
        }
        if (baseline !== undefined) {
          const unpainted = unpaintedColor(before, baseline, row.before)
          if (unpainted !== null) {
            return parserStateResult(
              null,
              row.expected,
              { before: responseGrid(before, row.before), baseline: responseGrid(baseline, baselineRow?.cells ?? []) },
              `${row.id}: ${unpainted}`,
            )
          }
        }
        const setup: { x: number; y: number }[] = []
        for (const step of row.steps) {
          ctx.feed(step.write)
          if (!step.cursor) continue
          const cursor = ctx.getCursor()
          setup.push({ x: cursor.x, y: cursor.y })
          if (cursor.x !== step.cursor.x || cursor.y !== step.cursor.y) {
            return parserStateResult(
              null,
              row.expected,
              { before: responseGrid(before, row.before), setup },
              step.cursor.note,
            )
          }
        }
        const after = readGrid(ctx, geometry)
        const unreadAfter = unreadAttributes(after, row.after)
        if (unreadAfter !== null) {
          return parserStateResult(
            null,
            row.expected,
            { before: responseGrid(before, row.before), after: responseGrid(after, row.after) },
            `${row.id}: the backend does not report ${unreadAfter} after the sequence, so the claim cannot be read`,
          )
        }
        const controlsValid = row.controls.every((control) => {
          const cell = after[control.row]?.[control.col]
          return cell !== undefined && sameCell(cell, control.char)
        })
        return parserStateResult(
          controlsValid ? gridMatch(after, row.after, before) : null,
          row.expected,
          { before: responseGrid(before, row.before), setup, after: responseGrid(after, row.after) },
          controlsValid ? undefined : row.controlNote,
        )
      } finally {
        // The parser arm sets the same extent mode the app arm does (`2*x` inside the row's step), and
        // 2J does not reset it, so the row's own cleanup lands here too on every exit: decided,
        // refused or thrown.
        if (row.cleanup !== undefined) ctx.feed(row.cleanup)
        ctx.feed(row.reset)
      }
    },
    async term(ctx) {
      const decided = await captureRegionVerdict(ctx, row.id, readback)
      if (decided) return decided
      // No adapter and a REFUSED calibration both leave `ctx.capture` absent, so the row tells them
      // apart by the one fact the collector recorded: the refusal is named here, in the note that
      // already exists, so a refused run says why instead of only that no adapter is installed
      // (28785 must 1).
      return {
        pass: false,
        tests: [
          {
            id: "criterion",
            status: "test-todo",
            reason:
              ctx.captureGeometryRefusal === undefined
                ? `${row.id}: no owned capture adapter is installed in this run, so the region fixture cannot be read back`
                : `${row.id}: this run installs no capture adapter because the run's cell-to-pixel geometry was refused — ${ctx.captureGeometryRefusal}`,
          },
        ],
      }
    },
  }
}

/** A kind table: one probe per row, in row order. */
export function regionReadbackProbes(rows: readonly RegionReadbackRow[]): ProbeDefinition[] {
  return rows.map(regionReadbackProbe)
}
