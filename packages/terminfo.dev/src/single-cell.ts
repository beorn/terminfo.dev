/** The named glyphs a text snapshot maps to exactly one cell, beside printable ASCII. */
export const NAMED_SINGLE_CELL_GLYPHS = [
  { codePoint: 0x00e9, name: "é, the UTF-8 sample cell" },
  { codePoint: 0x2500, name: "─ horizontal line, DEC Special Graphics q" },
  { codePoint: 0x2502, name: "│ vertical line, DEC Special Graphics x" },
  { codePoint: 0x250c, name: "┌ upper-left corner, DEC Special Graphics l" },
  { codePoint: 0x2510, name: "┐ upper-right corner, DEC Special Graphics k" },
  { codePoint: 0x2514, name: "└ lower-left corner, DEC Special Graphics m" },
  { codePoint: 0x2518, name: "┘ lower-right corner, DEC Special Graphics j" },
] as const

const NAMED_SINGLE_CELL_CODES: ReadonlySet<number> = new Set(NAMED_SINGLE_CELL_GLYPHS.map(({ codePoint }) => codePoint))

/** True for the only code points a text read maps to exactly one cell: printable ASCII and the named
 * glyphs above. Anything else — combining marks, wide characters, East Asian ambiguous characters,
 * control characters, non-BMP — has a cell width a text snapshot cannot name, so the mapping and the
 * logical-line splitter both refuse rather than guess. */
export function isSingleCellCodePoint(codePoint: number): boolean {
  return (codePoint >= 0x20 && codePoint <= 0x7e) || NAMED_SINGLE_CELL_CODES.has(codePoint)
}

export const hex = (codePoint: number): string => `U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}`
