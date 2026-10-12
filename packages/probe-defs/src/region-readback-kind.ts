import type { ProbeDefinition } from "./types.ts"
import { captureRegionVerdict, type RegionReadback } from "./region-readback.ts"
import { parserStateResult } from "./helpers.ts"
/**
 * The region-readback OBSERVATION KIND (@cto A2, 2026-10-12): one factory, one row per probe, both
 * arms derived from that row. A family repairs its hand-written probes by declaring rows; a probe
 * that needs something this kind cannot express adds a KIND — once, reviewed — never another
 * hand-written callback of its own.
 *
 * The two arms grade ONE effect: the termless arm reads the cells the row's sequence must leave and
 * the capture-region oracle decides the same seed / sequence / expected writes from pixels. That is
 * why the row carries both the parser-state steps and the capture spec, and why the compared cell
 * count is the seed's own length rather than a second number that could drift from it.
 */

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
  /** The cells the seed frame must show at row 1, columns 1..n. Their count is the row's min columns. */
  before: string
  /** The writes between the seed and the final read, in order. */
  steps: readonly RegionReadbackStep[]
  /** The cells the sequence under test must show, as one char per compared column. */
  after: string
  /** Cells whose position the sequence must preserve. Only when every one holds is `after` the claim. */
  controls: readonly RegionReadbackControl[]
  /** The note when the seed frame was not measured. */
  seedNote: string
  /** The note when a control cell moved, so the claim cannot be read. */
  controlNote: string
  /** The normalizing write the termless arm makes whether or not it decided. */
  reset: string
  /** The capture-region readback the collector decides from; its bounds are this row's min geometry. */
  readback: Omit<RegionReadback, "pixelGeometry">
  /** The writes the term arm makes when no owned capture is installed: consumption only, never a verdict. */
  fallbackWrites: readonly string[]
  /** Room the fallback's own fixture needs before it writes a byte. */
  fallbackMinCols: number
}

/**
 * Build the one probe a row describes. The termless arm measures the parser's cells; the term arm
 * hands the same seed / sequence / expected writes to the capture-region oracle, and falls back to a
 * named consumption record only when the run has no owned capture at all.
 */
export function regionReadbackProbe(row: RegionReadbackRow): ProbeDefinition {
  const cells = row.before.length
  return {
    id: row.id,
    termNeedsGeometry: true,
    termlessObservationEvidence: "parser-state",
    termless(ctx) {
      if (!Number.isSafeInteger(ctx.cols) || ctx.cols < cells) {
        return parserStateResult(
          null,
          row.expected,
          { cols: ctx.cols },
          `Need at least ${cells} measured columns for this charset fixture`,
        )
      }
      try {
        ctx.feed(row.seed)
        const before = Array.from({ length: cells }, (_, col) => ctx.getCell(0, col).char)
        if (before.join("") !== row.before) {
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
        const after = Array.from({ length: cells }, (_, col) => ctx.getCell(0, col).char)
        const controlsValid = row.controls.every((control) => after[control.col] === control.char)
        return parserStateResult(
          controlsValid ? after.join("") === row.after : null,
          row.expected,
          { before, setup, after },
          controlsValid ? undefined : row.controlNote,
        )
      } finally {
        ctx.feed(row.reset)
      }
    },
    async term(ctx) {
      const decided = await captureRegionVerdict(ctx, row.id, row.readback)
      if (decided) return decided
      const cols = ctx.cols
      if (
        !Number.isSafeInteger(ctx.rows) ||
        !Number.isSafeInteger(cols) ||
        ctx.rows < 1 ||
        cols < row.fallbackMinCols
      ) {
        return {
          pass: false,
          observation: {
            outcome: "inconclusive",
            reason: "insufficient-evidence",
            evidence: "none",
            note: `Charset fixture needs at least 1x${row.fallbackMinCols}, measured ${ctx.rows}x${cols}`,
          },
        }
      }
      for (const write of row.fallbackWrites) ctx.write(write)
      const pos = await ctx.queryCursorPosition()
      if (!pos) {
        return {
          pass: false,
          note: "No cursor response",
          observation: { outcome: "inconclusive", reason: "no-response", evidence: "query" },
        }
      }
      return {
        pass: false,
        response: JSON.stringify(pos),
        note: "Cursor movement does not verify charset glyph rendering or mapping",
        observation: {
          outcome: "inconclusive",
          reason: "insufficient-evidence",
          evidence: "consumed",
          note: "Cursor movement does not verify charset glyph rendering or mapping",
        },
      }
    },
  }
}

/** A kind table: one probe per row, in row order. */
export function regionReadbackProbes(rows: readonly RegionReadbackRow[]): ProbeDefinition[] {
  return rows.map(regionReadbackProbe)
}
