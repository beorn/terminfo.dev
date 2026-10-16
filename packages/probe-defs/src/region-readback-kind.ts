/**
 * The region-readback OBSERVATION KIND (@cto A2, 2026-10-12): one factory, one row per probe, BOTH
 * arms derived from that row. A family repairs its hand-written probes by declaring rows; a probe
 * that needs something this kind cannot express adds a KIND — once, reviewed — never another
 * hand-written callback of its own.
 *
 * The row holds the claim ONCE. The capture-region oracle's seed, edit and expected frames are
 * derived from the row's own seed, steps and cells here, so the parser-state arm and the pixel arm
 * cannot drift into grading two different fixtures (which is how the first revision of this kind
 * shipped an edit that rewrote its own control).
 *
 * The compared cells are a GRID — one `string[]` per screen ROW (@cto b29d9b69: "the cells become a
 * grid (one string[] per row). Extend the kind once, with that family"). One row of cells is the
 * one-row grid, so a family that needs a scroll region, a multi-line erase or an insert/delete line
 * declares it instead of adding a second factory.
 */
import type { ProbeDefinition, TermlessContext } from "./types.ts"
import { captureRegionVerdict, type RegionReadback } from "./region-readback.ts"
import { isBlank, parserStateResult } from "./helpers.ts"

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

export interface RegionReadbackRow {
  id: string
  /** The claim in words: the termless arm's `expected`, and the kind table test's row label. */
  expected: string
  /** The seed frame's writes. */
  seed: string
  /**
   * The cells the seed frame must show: one `string[]` per compared ROW, one entry per compared
   * COLUMN, in screen order. A wide follower is `""`.
   */
  before: readonly (readonly string[])[]
  /** The writes between the seed and the final read, in order. */
  steps: readonly RegionReadbackStep[]
  /**
   * The cells the sequence under test must show, in the same grid shape. A blank cell — never
   * written, erased, vacated, or a wide glyph's follower — is compared by blank equality: `""` and
   * `" "` on either side are the same blank (see `sameCell`), so a correct terminal is never graded
   * unsupported for choosing the backend's own spelling.
   */
  after: readonly (readonly string[])[]
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
  ignored?: readonly (readonly string[])[]
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
   * for the JOB, not the moment it runs (@cto 2026-10-12): `afterVerdict` named a time, and this is the
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
 * sequence must never grade unsupported for choosing the other spelling (@cto 28450 must-fix 1,
 * 2026-10-12).
 */
function sameCell(measured: string, expected: string): boolean {
  return isBlank(expected) ? isBlank(measured) : measured === expected
}

/** A wide follower paints nothing of its own: its lead glyph already claimed the column. */
function paintRow(cells: readonly string[]): string {
  return cells.filter((cell) => cell !== "").join("")
}

/**
 * Column-by-column equality for one grid row. A column the row does not name can never match, so a
 * shape that slipped past the load check fails CLOSED here rather than being read against a blank and
 * accepted.
 */
function cellsMatch(measured: readonly string[], expected: readonly string[]): boolean {
  if (measured.length !== expected.length) return false
  return measured.every((cell, col) => {
    const want = expected[col]
    return want !== undefined && sameCell(cell, want)
  })
}

/** Row-by-row equality: a grid with the wrong number of rows can never match. */
function gridMatch(measured: readonly (readonly string[])[], expected: readonly (readonly string[])[]): boolean {
  if (measured.length !== expected.length) return false
  return measured.every((cells, row) => {
    const want = expected[row]
    return want !== undefined && cellsMatch(cells, want)
  })
}

/** The compared region's cells, read from the parser at their own screen positions. */
function readGrid(ctx: TermlessContext, geometry: RegionReadbackGeometry): string[][] {
  return Array.from({ length: geometry.rows }, (_, row) =>
    Array.from(
      { length: geometry.columns },
      (_, col) => ctx.getCell(geometry.top - 1 + row, geometry.left - 1 + col).char,
    ),
  )
}

function cup(row: number, col: number): string {
  return `\x1b[${row};${col}H`
}

/** The frame a grid paints: each compared row at its own screen row and left column. */
function paintFrame(grid: readonly (readonly string[])[], geometry: RegionReadbackGeometry): string {
  return grid.map((cells, row) => cup(geometry.top + row, geometry.left) + paintRow(cells)).join("")
}

/**
 * A row whose own shape disagrees with itself cannot be right, so it refuses at LOAD instead of
 * comparing a short array's missing cell against a blank that `sameCell` would happily accept — a
 * typo must never read as a passing terminal (@cto 2026-10-12, NO SILENT ERRORS). Every index the
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
  // The geometry this row really addresses (@cto 2026-10-12, must-fix 2). The parked cursor AND the
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
    seed: prelude + row.seed + geometry.park,
    edit: row.steps.map((step) => step.write).join("") + geometry.park,
    expected: prelude + paintFrame(row.after, geometry) + geometry.park,
    ...(row.ignored === undefined ? {} : { ignored: prelude + paintFrame(row.ignored, geometry) + geometry.park }),
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
    termlessObservationEvidence: "parser-state",
    termless(ctx) {
      // The termless context reports its width and nothing else: the parser arms address cells by
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
        ctx.feed(row.seed)
        const before = readGrid(ctx, geometry)
        if (!gridMatch(before, row.before)) {
          return parserStateResult(null, row.expected, { before }, row.seedNote)
        }
        const setup: { x: number; y: number }[] = []
        for (const step of row.steps) {
          ctx.feed(step.write)
          if (!step.cursor) continue
          const cursor = ctx.getCursor()
          setup.push({ x: cursor.x, y: cursor.y })
          if (cursor.x !== step.cursor.x || cursor.y !== step.cursor.y) {
            return parserStateResult(null, row.expected, { before, setup }, step.cursor.note)
          }
        }
        const after = readGrid(ctx, geometry)
        const controlsValid = row.controls.every((control) => {
          const cell = after[control.row]?.[control.col]
          return cell !== undefined && sameCell(cell, control.char)
        })
        return parserStateResult(
          controlsValid ? gridMatch(after, row.after) : null,
          row.expected,
          { before, setup, after },
          controlsValid ? undefined : row.controlNote,
        )
      } finally {
        ctx.feed(row.reset)
      }
    },
    async term(ctx) {
      const decided = await captureRegionVerdict(ctx, row.id, readback)
      if (decided) return decided
      // No adapter and a REFUSED calibration both leave `ctx.capture` absent, so the row tells them
      // apart by the one fact the collector recorded: the refusal is named here, in the note that
      // already exists, so a refused run says why instead of only that no adapter is installed
      // (28785, @cto REVISE must 1).
      return {
        pass: false,
        observation: {
          outcome: "inconclusive",
          reason: "insufficient-evidence",
          evidence: "none",
          note:
            ctx.captureGeometryRefusal === undefined
              ? `${row.id}: no owned capture adapter is installed in this run, so the region fixture cannot be read back`
              : `${row.id}: this run installs no capture adapter because the terminal's own cell-to-pixel geometry was refused — ${ctx.captureGeometryRefusal}`,
        },
      }
    },
  }
}

/** A kind table: one probe per row, in row order. */
export function regionReadbackProbes(rows: readonly RegionReadbackRow[]): ProbeDefinition[] {
  return rows.map(regionReadbackProbe)
}
