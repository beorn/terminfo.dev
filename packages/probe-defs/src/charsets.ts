import { regionReadbackProbes, type RegionReadbackRow } from "./region-readback-kind.ts"
import type { RegionReadback } from "./region-readback.ts"

/**
 * The Character Sets family, as one region-readback kind table (@cto A2; 28450 slice B).
 *
 * Each row is seed / sequence / expected over one row of cells, and BOTH arms derive from it: the
 * termless arm reads the seed, the steps and the target cells against the parser, and the term arm
 * hands the same seed / sequence / expected writes to the capture-region oracle. Nothing here is a
 * hand-written per-probe function, and a probe that needs more than this adds a KIND, not a callback.
 *
 * The app arm no longer paints its own control/target fixture: the region oracle's verdict already
 * decided every one of these rows, so those fixtures were unreachable writes kept alive by their
 * own maintenance cost (and one of them disagreed with the oracle's own geometry).
 */

type ReadbackSpec = Omit<RegionReadback, "pixelGeometry">

/** DEC Special Graphics sample on row 1; paint witness on row 3, matching 28540's helper. */
const DEC_SPECIAL_READBACK: ReadbackSpec = {
  region: { top: 1, left: 1, bottom: 1, right: 3 },
  sentinel: { row: 3, col: 1 },
  cursorRow: 2,
  seed: "\x1b[0m\x1b[2J\x1b[H\x0f\x1b(B\x1b)B\x1b[1;1Hqqq\x1b[2;1H",
  edit: "\x1b[1;2H\x1b(0q\x1b(B\x1b[2;1H",
  expected: "\x1b[0m\x1b[2J\x1b[H\x0f\x1b(B\x1b)B\x1b[1;1Hq\u2500q\x1b[2;1H",
  timeoutMs: 5000,
  pollMs: 250,
  minRows: 4,
  minCols: 6,
}

/**
 * The measured readback for the remaining charset rows: the same three-frame shape as
 * DEC_SPECIAL_READBACK, with the expected frame written PLAINLY in the same run. The claims match
 * the termless fixtures beside the probes, so the app and parser-state paths grade one effect.
 */
const UTF8_READBACK: ReadbackSpec = {
  region: { top: 1, left: 1, bottom: 1, right: 5 },
  sentinel: { row: 3, col: 1 },
  cursorRow: 2,
  seed: "\x1b[0m\x1b[2J\x1b[H\x0f\x1b(B\x1b)B\x1b[1;1HAxy?Z\x1b[2;1H",
  edit: "\x1b[1;2H\u00e9\x1b[1;3H\u4e16\x1b[2;1H",
  expected: "\x1b[0m\x1b[2J\x1b[H\x0f\x1b(B\x1b)B\x1b[1;1HA\u00e9\u4e16Z\x1b[2;1H",
  timeoutMs: 5000,
  pollMs: 250,
  minRows: 3,
  minCols: 6,
}

const G0_G1_SWITCHING_READBACK: ReadbackSpec = {
  region: { top: 1, left: 1, bottom: 1, right: 5 },
  sentinel: { row: 3, col: 1 },
  cursorRow: 2,
  seed: "\x1b[0m\x1b[2J\x1b[H\x0f\x1b(B\x1b)B\x1b[1;1HAlllZ\x1b[2;1H",
  edit: "\x1b[1;2H\x1b(B\x1b)0l\x0el\x0fl\x0f\x1b(B\x1b)B\x1b[2;1H",
  expected: "\x1b[0m\x1b[2J\x1b[H\x0f\x1b(B\x1b)B\x1b[1;1HAl\u250clZ\x1b[2;1H",
  timeoutMs: 5000,
  pollMs: 250,
  minRows: 3,
  minCols: 6,
}

const DEC_LINE_DRAWING_READBACK: ReadbackSpec = {
  region: { top: 1, left: 1, bottom: 1, right: 7 },
  sentinel: { row: 3, col: 1 },
  cursorRow: 2,
  seed: "\x1b[0m\x1b[2J\x1b[H\x0f\x1b(B\x1b)B\x1b[1;1Hjklmqxj\x1b[2;1H",
  edit: "\x1b[1;1H\x1b(0jklmqx\x1b(B\x1b[2;1H",
  expected: "\x1b[0m\x1b[2J\x1b[H\x0f\x1b(B\x1b)B\x1b[1;1H\u2518\u2510\u250c\u2514\u2500\u2502j\x1b[2;1H",
  timeoutMs: 5000,
  pollMs: 250,
  minRows: 3,
  minCols: 8,
}

/** The 4 Character Sets capabilities, one row each: seed, the sequence under test, and its cells. */
export const charsetReadbackRows: readonly RegionReadbackRow[] = [
  {
    id: "charsets.dec-special",
    expected: "ASCII q controls flank DEC Special Graphics q mapped to U+2500",
    seed: "\x0f\x1b(B\x1b)B\x1b[1;1H\x1b[2Kqqq",
    before: "qqq",
    steps: [
      { write: "\x1b[1;2H", cursor: { x: 1, y: 0, note: "Target CUP did not reach DEC graphics cell" } },
      // DEC Special Graphics q paints U+2500 into the middle cell; the flanking qs are the controls.
      { write: "\x1b(0q\x1b(Bq" },
    ],
    after: "q\u2500q",
    controls: [
      { col: 0, char: "q" },
      { col: 2, char: "q" },
    ],
    seedNote: "ASCII seed was not measured before DEC designation",
    controlNote: "ASCII flank control changed after DEC designation",
    reset: "\x0f\x1b(B\x1b)B",
    readback: DEC_SPECIAL_READBACK,
    fallbackWrites: ["\x1b[1;1H\x1b[2K", "\x1b(0", "q", "\x1b(B"],
    fallbackMinCols: 2,
  },
  {
    id: "charsets.utf8",
    expected: "Sampled Unicode characters \u00e9 and \u4e16 occupy their target cells with ASCII controls intact",
    seed: "\x1b[1;1H\x1b[2KAxy?Z",
    before: "Axy?Z",
    steps: [
      { write: "\x1b[1;2H", cursor: { x: 1, y: 0, note: "First target CUP did not reach Unicode sample cell" } },
      { write: "\u00e9" },
      { write: "\x1b[1;3H", cursor: { x: 2, y: 0, note: "Second target CUP did not reach Unicode sample cell" } },
      { write: "\u4e16" },
    ],
    // U+4E16 is one wide cell: it claims columns 3-4, and the wide follower reads as an empty cell.
    after: "A\u00e9\u4e16Z",
    controls: [
      { col: 0, char: "A" },
      { col: 4, char: "Z" },
    ],
    seedNote: "ASCII seed was not measured before Unicode samples",
    controlNote: "ASCII control changed after Unicode samples",
    reset: "\x0f\x1b(B\x1b)B",
    readback: UTF8_READBACK,
    fallbackWrites: ["\x1b[1;1H\x1b[2K", "\u00e9"],
    fallbackMinCols: 2,
  },
  {
    // G0/G1 switching via SI/SO with independent ASCII flank controls.
    id: "charsets.g0-g1-switching",
    expected: "G0 ASCII l, SO-selected G1 DEC l\u2192U+250C, then SI-selected G0 ASCII l, within A/Z controls",
    seed: "\x0f\x1b(B\x1b)B\x1b[1;1H\x1b[2KAlllZ",
    before: "AlllZ",
    steps: [
      { write: "\x1b[1;2H", cursor: { x: 1, y: 0, note: "Target CUP did not reach G0/G1 switching cells" } },
      // G0 l, SO-selected G1 DEC l -> U+250C, then SI-selected G0 ASCII l.
      { write: "\x1b(B\x1b)0l\x0el\x0fl" },
    ],
    after: "Al\u250clZ",
    controls: [
      { col: 0, char: "A" },
      { col: 4, char: "Z" },
    ],
    seedNote: "ASCII seed was not measured before G0/G1 switching",
    controlNote: "ASCII A/Z control changed after G0/G1 switching",
    reset: "\x0f\x1b(B\x1b)B",
    readback: G0_G1_SWITCHING_READBACK,
    fallbackWrites: ["\x1b[1;1H\x1b[2K", "\x0f\x1b(B\x1b)0", "l\x0el\x0fl", "\x1b)B"],
    fallbackMinCols: 3,
  },
  {
    // DEC line drawing — six box-drawing samples.
    id: "charsets.dec-line-drawing",
    expected: "DEC jklmqx map exactly to \u2518\u2510\u250c\u2514\u2500\u2502 while trailing ASCII j remains unchanged",
    seed: "\x0f\x1b(B\x1b)B\x1b[1;1H\x1b[2Kjklmqxj",
    before: "jklmqxj",
    steps: [
      { write: "\x1b[1;1H", cursor: { x: 0, y: 0, note: "Target CUP did not reach line-drawing start cell" } },
      { write: "\x1b(0jklmqx\x1b(B" },
    ],
    after: "\u2518\u2510\u250c\u2514\u2500\u2502j",
    controls: [{ col: 6, char: "j" }],
    seedNote: "ASCII seed was not measured before line drawing",
    controlNote: "Trailing ASCII j control changed after DEC line drawing",
    reset: "\x0f\x1b(B\x1b)B",
    readback: DEC_LINE_DRAWING_READBACK,
    fallbackWrites: ["\x1b[1;1H\x1b[2K", "\x1b(0", "jklmqx", "\x1b(B"],
    fallbackMinCols: 7,
  },
]

export const charsetsProbes = regionReadbackProbes(charsetReadbackRows)
