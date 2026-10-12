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
 */
import type { ProbeDefinition, TermlessContext } from "./types.ts"
import { captureRegionVerdict, type RegionReadback } from "./region-readback.ts"
import { parserStateResult } from "./helpers.ts"

/** One write between the seed frame and the final read, and the cursor report it must reach. */
export interface RegionReadbackStep {
  /** Bytes written after the seed frame. */
  write: string
  /** The 0-based cursor report this step must reach, and the note when it did not. */
  cursor?: { x: number; y: number; note: string }
}

/** One cell the row's sequence must leave untouched, so the claim can be read from the rest. */
export interface RegionReadbackControl {
  /** 0-based column inside the compared cells. */
  col: number
  char: string
}

export interface RegionReadbackRow {
  id: string
  /** The claim in words: the termless arm's `expected`, and the kind table test's row label. */
  expected: string
  /** The seed frame's writes. */
  seed: string
  /** The cells the seed frame must show: one entry per compared COLUMN. A wide follower is `""`. */
  before: readonly string[]
  /** The writes between the seed and the final read, in order. */
  steps: readonly RegionReadbackStep[]
  /**
   * The cells the sequence under test must show, one entry per compared column. A column a wide
   * glyph's follower claims is `""` — the backend may report it as reserved-empty or as a space, and
   * the kind accepts both rather than failing a correct terminal for choosing one spelling.
   */
  after: readonly string[]
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
  /** The frame the sequence would leave if it IGNORED the one attribute it claims, one entry per column. */
  ignored?: readonly string[]
}

/** The one-row fixture's paint witness, cursor row and capture timing: kind constants, not rows. */
const SENTINEL = { row: 3, col: 1 } as const
const CURSOR_ROW = 2
const TIMEOUT_MS = 5000
const POLL_MS = 250
/** Clear, home, and the row's own designation reset, so every derived frame starts from one state. */
const PRELUDE = "\x1b[0m\x1b[2J\x1b[H"

/** A wide follower may be reported reserved-empty or as a space; both are the same cell. */
function sameCell(measured: string, expected: string): boolean {
  return expected === "" ? measured === "" || measured === " " : measured === expected
}

/** A wide follower paints nothing of its own: its lead glyph already claimed the column. */
function paint(cells: readonly string[]): string {
  return cells.filter((cell) => cell !== "").join("")
}

/**
 * Column-by-column equality. A column the row does not name can never match, so a shape that slipped
 * past the load check fails CLOSED here rather than being read against a blank and accepted.
 */
function cellsMatch(measured: readonly string[], expected: readonly string[]): boolean {
  if (measured.length !== expected.length) return false
  return measured.every((cell, col) => {
    const want = expected[col]
    return want !== undefined && sameCell(cell, want)
  })
}

function readRow(ctx: TermlessContext, columns: number): string[] {
  return Array.from({ length: columns }, (_, col) => ctx.getCell(0, col).char)
}

/** The capture-region spec the row implies, so the two arms grade one fixture. */
function regionReadbackSpec(row: RegionReadbackRow): Omit<RegionReadback, "pixelGeometry"> {
  const columns = row.before.length
  const park = `\x1b[${CURSOR_ROW};1H`
  const prelude = PRELUDE + row.reset
  return {
    region: { top: 1, left: 1, bottom: 1, right: columns },
    sentinel: SENTINEL,
    cursorRow: CURSOR_ROW,
    seed: prelude + row.seed + park,
    edit: row.steps.map((step) => step.write).join("") + park,
    expected: prelude + "\x1b[1;1H" + paint(row.after) + park,
    ...(row.ignored === undefined ? {} : { ignored: prelude + "\x1b[1;1H" + paint(row.ignored) + park }),
    timeoutMs: TIMEOUT_MS,
    pollMs: POLL_MS,
    minRows: SENTINEL.row,
    minCols: columns + 2,
  }
}

/**
 * A row whose own shape disagrees with itself cannot be right, so it refuses at LOAD instead of
 * comparing a short array's missing columns against a blank that `sameCell` would happily accept —
 * a typo must never read as a passing terminal (@cto 2026-10-12, NO SILENT ERRORS). Every index the
 * arms use below is proven in range here, which is why nothing below needs a fallback.
 */
function assertRegionReadbackShape(row: RegionReadbackRow): void {
  const columns = row.before.length
  if (columns === 0) {
    throw new Error(`${row.id}: a region-readback row needs at least one compared column`)
  }
  if (row.after.length !== columns) {
    throw new Error(`${row.id}: after names ${row.after.length} cells for ${columns} compared columns`)
  }
  if (row.ignored !== undefined && row.ignored.length !== columns) {
    throw new Error(`${row.id}: ignored names ${row.ignored.length} cells for ${columns} compared columns`)
  }
  for (const control of row.controls) {
    if (!Number.isSafeInteger(control.col) || control.col < 0 || control.col >= columns) {
      throw new Error(`${row.id}: control column ${control.col} is outside the compared 0..${columns - 1}`)
    }
  }
}

/**
 * Build the one probe a row describes. The termless arm measures the parser's cells; the term arm
 * hands the derived seed / edit / expected frames to the capture-region oracle. A run with no owned
 * capture cannot read a window back at all, so that arm refuses by NAME and writes nothing: a
 * fixture that can only answer "inconclusive" is not evidence, and is deleted rather than kept.
 */
export function regionReadbackProbe(row: RegionReadbackRow): ProbeDefinition {
  assertRegionReadbackShape(row)
  const columns = row.before.length
  const readback = regionReadbackSpec(row)
  return {
    id: row.id,
    termNeedsGeometry: true,
    termlessObservationEvidence: "parser-state",
    termless(ctx) {
      if (!Number.isSafeInteger(ctx.cols) || ctx.cols < columns) {
        return parserStateResult(
          null,
          row.expected,
          { cols: ctx.cols },
          `Need at least ${columns} measured columns for this region fixture`,
        )
      }
      try {
        ctx.feed(row.seed)
        const before = readRow(ctx, columns)
        if (!cellsMatch(before, row.before)) {
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
        const after = readRow(ctx, columns)
        const controlsValid = row.controls.every((control) => {
          const cell = after[control.col]
          return cell !== undefined && sameCell(cell, control.char)
        })
        return parserStateResult(
          controlsValid ? cellsMatch(after, row.after) : null,
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
      return {
        pass: false,
        observation: {
          outcome: "inconclusive",
          reason: "insufficient-evidence",
          evidence: "none",
          note: `${row.id}: no owned capture adapter is installed in this run, so the region fixture cannot be read back`,
        },
      }
    },
  }
}

/** A kind table: one probe per row, in row order. */
export function regionReadbackProbes(rows: readonly RegionReadbackRow[]): ProbeDefinition[] {
  return rows.map(regionReadbackProbe)
}
