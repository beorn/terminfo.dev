/**
 * Rebuild physical rows from a terminal's LOGICAL lines, or refuse by name.
 *
 * macOS Terminal.app's `contents` returns logical lines: a wrapped line comes back once, as one
 * string longer than the grid, so a screen of N rows can report fewer than N lines. This is the one
 * place that turns them back into rows. The screen read and the app's history read both call it, so
 * there is never a second splitter with its own rules (30729 AC3b, @cto 771759ac).
 *
 * It fires only where the app pads rows to full width: every line a positive exact multiple of the
 * column count, the pieces summing to exactly the measured row count. Anything else refuses BY NAME
 * and the caller keeps its existing refusal and its payload — padding or trimming to make a fit
 * would be inventing cells. A screen whose trailing blanks the app trims therefore refuses here,
 * which is correct: those rows were never shown to be full.
 *
 * Width is counted in CELLS, never in JavaScript string length. A line that needs splitting must be
 * entirely single-cell characters; anything else (wide, combining, zero-width, non-BMP — a surrogate
 * pair is not reliably two cells) refuses by name rather than guessing a boundary. A line that is
 * exactly the column count passes through unchanged, whatever it contains.
 */
import { hex, isSingleCellCodePoint } from "./single-cell.ts"

/** Rows rebuilt from logical lines, with how many lines had to be split. */
export interface SplitLogicalRows {
  readonly rows: readonly string[]
  readonly splitLineCount: number
}

export type LogicalRowsReading = SplitLogicalRows | { readonly reason: string }

/**
 * One logical line as the physical rows it wrapped into, or a refusal. The pieces are the only
 * reconstruction this module ever makes: it never pads a short piece, and it never guesses a
 * boundary inside a character whose width the read cannot name.
 */
export function splitLogicalLine(
  line: string,
  cols: number,
  lineNumber: number,
): readonly string[] | { readonly reason: string } {
  const points = [...line]
  if (points.length === cols) return [line]
  if (points.length === 0) {
    return { reason: `line ${String(lineNumber)} is empty, so its blank row is not shown to be full` }
  }
  for (const [position, character] of points.entries()) {
    const codePoint = character.codePointAt(0) ?? 0
    if (isSingleCellCodePoint(codePoint)) continue
    return {
      reason: `line ${String(lineNumber)} character ${String(position + 1)} is ${hex(codePoint)}, which is not one cell, so where row ${String(Math.floor(position / cols) + 1)} wraps cannot be measured`,
    }
  }
  if (points.length % cols !== 0) {
    return {
      reason: `line ${String(lineNumber)} is ${String(points.length)} cells over ${String(cols)} columns, which is not a whole number of rows, so its row boundary is unknown`,
    }
  }
  const pieces: string[] = []
  for (let start = 0; start < points.length; start += cols) {
    pieces.push(points.slice(start, start + cols).join(""))
  }
  return pieces
}

export function splitLogicalRows(lines: readonly string[], cols: number, rows: number): LogicalRowsReading {
  if (!Number.isSafeInteger(cols) || !Number.isSafeInteger(rows) || cols < 1 || rows < 1) {
    return { reason: `the measured geometry is not a size: ${String(cols)}x${String(rows)}` }
  }
  const rebuilt: string[] = []
  let splitLineCount = 0
  for (const [index, line] of lines.entries()) {
    const pieces = splitLogicalLine(line, cols, index + 1)
    if ("reason" in pieces) return pieces
    if (pieces.length > 1) splitLineCount += 1
    rebuilt.push(...pieces)
  }
  if (rebuilt.length !== rows) {
    return {
      reason: `its ${String(lines.length)} logical lines are ${String(rebuilt.length)} rows where the measured screen has ${String(rows)}`,
    }
  }
  return { rows: rebuilt, splitLineCount }
}
