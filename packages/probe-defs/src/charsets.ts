import { regionReadbackProbes, type RegionReadbackRow } from "./region-readback-kind.ts"

/**
 * The Character Sets family, as one region-readback kind table (@cto A2; 28450 slice B).
 *
 * Each row is seed / sequence / expected over one row of cells, and BOTH arms derive from it: the
 * termless arm reads the seed, the steps and the target cells against the parser, and the kind builds
 * the capture-region oracle's seed / edit / expected frames from the same fields. The row holds the
 * claim once, and a probe that needs more than this adds a KIND, not a callback.
 *
 * The app arm no longer paints its own control/target fixture: the region oracle's verdict already
 * decided every one of these rows, so those fixtures were unreachable writes kept alive by their own
 * maintenance cost (and one of them disagreed with the oracle's own geometry).
 */

/** The 4 Character Sets capabilities, one row each: seed, the sequence under test, and its cells. */
export const charsetReadbackRows: readonly RegionReadbackRow[] = [
  {
    id: "charsets.dec-special",
    expected: "ASCII q controls flank DEC Special Graphics q mapped to U+2500",
    seed: "\x0f\x1b(B\x1b)B\x1b[1;1H\x1b[2Kqqq",
    before: [["q", "q", "q"]],
    steps: [
      { write: "\x1b[1;2H", cursor: { x: 1, y: 0, note: "Target CUP did not reach DEC graphics cell" } },
      // DEC Special Graphics q paints U+2500 into the middle cell. The flanks are the seed's own
      // ASCII qs and the sequence never writes them, so they are real controls.
      { write: "\x1b(0q\x1b(B" },
    ],
    after: [["q", "\u2500", "q"]],
    controls: [
      { row: 0, col: 0, char: "q" },
      { row: 0, col: 2, char: "q" },
    ],
    seedNote: "ASCII seed was not measured before DEC designation",
    controlNote: "ASCII flank control changed after DEC designation",
    reset: "\x0f\x1b(B\x1b)B",
  },
  {
    id: "charsets.utf8",
    expected: "Sampled Unicode characters \u00e9 and \u4e16 occupy their target cells with ASCII controls intact",
    seed: "\x1b[1;1H\x1b[2KAxy?Z",
    before: [["A", "x", "y", "?", "Z"]],
    steps: [
      { write: "\x1b[1;2H", cursor: { x: 1, y: 0, note: "First target CUP did not reach Unicode sample cell" } },
      { write: "\u00e9" },
      { write: "\x1b[1;3H", cursor: { x: 2, y: 0, note: "Second target CUP did not reach Unicode sample cell" } },
      { write: "\u4e16" },
    ],
    // U+4E16 is one WIDE cell: it claims column 3 and its follower claims column 4, whose cell the
    // wide glyph owns. The `?` the seed painted there is what witnesses the takeover.
    after: [["A", "\u00e9", "\u4e16", "", "Z"]],
    controls: [
      { row: 0, col: 0, char: "A" },
      { row: 0, col: 4, char: "Z" },
    ],
    seedNote: "ASCII seed was not measured before Unicode samples",
    controlNote: "ASCII control changed after Unicode samples",
    reset: "\x0f\x1b(B\x1b)B",
  },
  {
    // G0/G1 switching via SI/SO with independent ASCII flank controls.
    id: "charsets.g0-g1-switching",
    expected: "G0 ASCII l, SO-selected G1 DEC l\u2192U+250C, then SI-selected G0 ASCII l, within A/Z controls",
    seed: "\x0f\x1b(B\x1b)B\x1b[1;1H\x1b[2KAlllZ",
    before: [["A", "l", "l", "l", "Z"]],
    steps: [
      { write: "\x1b[1;2H", cursor: { x: 1, y: 0, note: "Target CUP did not reach G0/G1 switching cells" } },
      // G0 l, SO-selected G1 DEC l -> U+250C, then SI-selected G0 ASCII l.
      { write: "\x1b(B\x1b)0l\x0el\x0fl" },
    ],
    after: [["A", "l", "\u250c", "l", "Z"]],
    controls: [
      { row: 0, col: 0, char: "A" },
      { row: 0, col: 4, char: "Z" },
    ],
    seedNote: "ASCII seed was not measured before G0/G1 switching",
    controlNote: "ASCII A/Z control changed after G0/G1 switching",
    reset: "\x0f\x1b(B\x1b)B",
  },
  {
    // DEC line drawing — six box-drawing samples.
    id: "charsets.dec-line-drawing",
    expected: "DEC jklmqx map exactly to \u2518\u2510\u250c\u2514\u2500\u2502 while trailing ASCII j remains unchanged",
    seed: "\x0f\x1b(B\x1b)B\x1b[1;1H\x1b[2Kjklmqxj",
    before: [["j", "k", "l", "m", "q", "x", "j"]],
    steps: [
      { write: "\x1b[1;1H", cursor: { x: 0, y: 0, note: "Target CUP did not reach line-drawing start cell" } },
      { write: "\x1b(0jklmqx\x1b(B" },
    ],
    after: [["\u2518", "\u2510", "\u250c", "\u2514", "\u2500", "\u2502", "j"]],
    controls: [{ row: 0, col: 6, char: "j" }],
    seedNote: "ASCII seed was not measured before line drawing",
    controlNote: "Trailing ASCII j control changed after DEC line drawing",
    reset: "\x0f\x1b(B\x1b)B",
  },
]

export const charsetsProbes = regionReadbackProbes(charsetReadbackRows)
