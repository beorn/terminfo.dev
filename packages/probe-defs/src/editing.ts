import type { ProbeDefinition, ProbeResult, TermContext, TermlessContext } from "./types.ts"
import { captureRegionVerdict, type RegionReadback } from "./region-readback.ts"
import { regionReadbackProbes, type RegionReadbackRow } from "./region-readback-kind.ts"
import {
  parserStateResult,
  probe,
  REPLY_AFTER_SENTINEL_NOTE,
  sentinelNegativeResult,
  unmeasuredCellResult,
} from "./helpers.ts"

// DECRQCRA's checksum must be arithmetic over the requested cells. An absolute sum is not portable
// (an implementation may hash attributes too), so the probe proves the DELTA: change one cell from
// E to F and the same rectangle's 16-bit checksum must move by exactly 1 under the positive-checksum
// extension, or by 65535 (modular -1) when the DEC-compatible default negates the sum.
const DECRQCRA_SEED = "ABCDE"
const DECRQCRA_EDIT = "\x1b[1;5HF"
const DECRQCRA_REQUEST = "\x1b[1;1;1;1;1;5*y"
const DECRQCRA_EXPECTED =
  "the same 1x5 rectangle's 16-bit checksum changes by 1 in the convention the terminal reports: +1 with the positive-checksum extension, or 65535 when the DEC-compatible default negates the sum"

function checksumValue(response: string): number | undefined {
  const framed = /\x1bP1!~([0-9A-Fa-f]{4})\x1b\\/.exec(response)
  return framed?.[1] === undefined ? undefined : Number.parseInt(framed[1], 16)
}

function checksumResult(first: string, second: string, lateNote?: string): ProbeResult {
  const before = checksumValue(first)
  const after = checksumValue(second)
  const both = before !== undefined && after !== undefined
  const delta = both ? (after - before + 0x10000) % 0x10000 : undefined
  // DEC-compatible terminals negate the checksum unless the positive-checksum extension is enabled
  // (xterm screen.c: the sum is negated unless csPOSITIVE). E to F is +1 of character sum, so the
  // reported 16-bit value moves by +1 under the extension and by 65535 (modular -1) by default.
  const matches = delta === 1 || delta === 65535
  // F1 (27832): a reply that lands after the DA1 sentinel is graded by its own bytes and recorded
  // as a late reply, exactly as device.ts:25-30 does for a device query.
  const late = lateNote ? ` ${lateNote}` : ""
  const note = matches
    ? `Checks both framed replies, request id and the one-cell character delta under the DEC-compatible or positive-checksum convention.${late}`
    : both
      ? `The same rectangle changed by ${delta}, which is neither +1 nor the DEC-compatible 65535.${late}`
      : `A complete checksum reply is missing for one of the two requests; expected ${DECRQCRA_EXPECTED}.${late}`
  const assertions: NonNullable<ProbeResult["assertions"]> | undefined = both
    ? [
        {
          kind: matches ? "positive" : "negative",
          expected: `Request 1 returns ${DECRQCRA_EXPECTED}`,
          observed: JSON.stringify({ first, second, delta }),
        },
      ]
    : undefined
  const outcome = matches ? ("supported" as const) : both ? ("unsupported" as const) : ("inconclusive" as const)
  return {
    pass: matches,
    response: JSON.stringify({ first, second }),
    note,
    observation: {
      outcome,
      evidence: "query",
      ...(lateNote && { note }),
      ...(outcome === "inconclusive" && {
        reason: first || second ? ("invalid-reply" as const) : ("no-response" as const),
      }),
    },
    ...(assertions && { assertions }),
  }
}

/**
 * Editing capture fixtures, kept ONLY for the two attribute-rectangle rows the region kind cannot
 * carry. An editing probe's application callback proves the sequence was consumed (cursor advance);
 * that collector has no cell readback, so the capture path records a pre-edit control and a
 * post-edit target for a reviewer to judge the claimed effect on pixels.
 */
interface EditingCaptureSpec {
  /** Rows the seed draws on. */
  minRows: number
  /** Widest seed line. Capture adds a one-row/two-column margin so the seed cannot wrap or scroll. */
  minCols: number
  seed: string
  edit: string
  region: { row: number; col: number; rows: number; cols: number }
  note: string
}

/**
 * DECCARA and DECRARA stay HAND-WRITTEN. This is their one-line coverage record (@cto 218ec7fe,
 * 2026-10-12): "not a region-readback row: the kind compares characters, and this claim is an
 * attribute rectangle; it converts when the kind's cell carries attributes". Both arms CAN observe
 * attributes; the kind just does not carry them, so a row of it would read the characters unchanged
 * and grade an ignoring surface supported on the termless arm, while its pixel arm would wrongly
 * read a correct terminal unsupported. The trigger to convert is a third attribute-rectangle probe,
 * or folding the SGR family's attribute readback (sgr.ts, sgrReadbackDecision) into the region kind,
 * whichever comes first - then both arms get an attribute-carrying cell once, reviewed, and these two
 * convert with it.
 *
 * Both rows select their DECSACE extent explicitly (29817): DECSACE 2 is the rectangle they measure,
 * and the surface starts at the spec's power-on default of stream, so neither row relies on a
 * default it does not state.
 */
const EDITING_CAPTURE_SPECS: Record<string, EditingCaptureSpec> = {
  "editing.deccara": {
    minRows: 1,
    minCols: 6,
    seed: "\x1b[1;1HaaaaaZ",
    edit: "\x1b[1;1H\x1b[2*x\x1b[1;1;1;5;7$r",
    region: { row: 1, col: 1, rows: 1, cols: 5 },
    note: "DECCARA (stream and rectangle extent agree on one row) should set inverse on the five measured cells and leave the sixth-column flank plain",
  },
  "editing.decrara": {
    minRows: 1,
    minCols: 6,
    seed: "\x1b[1;1H\x1b[7maaaaa\x1b[0mZ",
    edit: "\x1b[1;1H\x1b[2*x\x1b[1;1;1;5;7$t",
    region: { row: 1, col: 1, rows: 1, cols: 5 },
    note: "DECRARA (one row) should clear inverse on the five measured cells and leave the sixth-column flank already-plain",
  },
}

/** The attribute-rectangle readbacks: the two rows the character-grid kind cannot express. */
const DECCARA_READBACK: Omit<RegionReadback, "pixelGeometry"> = {
  region: { top: 1, left: 1, bottom: 1, right: 5 },
  sentinel: { row: 3, col: 1 },
  cursorRow: 2,
  seed: "\x1b[0m\x1b[2J\x1b[H\x1b[1;1HaaaaaZ\x1b[2;1H",
  edit: "\x1b[1;1H\x1b[1;1;1;5;7$r\x1b[2;1H",
  expected: "\x1b[0m\x1b[2J\x1b[H\x1b[1;1H\x1b[7maaaaa\x1b[0mZ\x1b[2;1H",
  timeoutMs: 5000,
  pollMs: 250,
  minRows: 3,
  minCols: 7,
}

const DECRARA_READBACK: Omit<RegionReadback, "pixelGeometry"> = {
  region: { top: 1, left: 1, bottom: 1, right: 5 },
  sentinel: { row: 3, col: 1 },
  cursorRow: 2,
  seed: "\x1b[0m\x1b[2J\x1b[H\x1b[1;1H\x1b[7maaaaa\x1b[0mZ\x1b[2;1H",
  edit: "\x1b[1;1H\x1b[1;1;1;5;7$t\x1b[2;1H",
  expected: "\x1b[0m\x1b[2J\x1b[H\x1b[1;1HaaaaaZ\x1b[2;1H",
  timeoutMs: 5000,
  pollMs: 250,
  minRows: 3,
  minCols: 7,
}

/** Rows whose collector path can decide from the owned window's cells, with the same helper. */
const EDITING_READBACK_SPECS: Record<string, Omit<RegionReadback, "pixelGeometry">> = {
  "editing.deccara": DECCARA_READBACK,
  "editing.decrara": DECRARA_READBACK,
}

/**
 * The 13 measured editing rows, as one region-readback kind table (@cto A2; 28450 slice C). Each row
 * holds its claim ONCE: the termless arm reads its seed, its steps and its target cells against the
 * parser, and the kind derives the capture-region oracle's seed / edit / expected frames from the
 * same fields, so the two arms cannot grade two different fixtures.
 *
 * Two notes this table carries to @cto, both named in the diff:
 *  - DECERA's two hand-written copies of the fixture disagreed: the capture spec seeded the third
 *    row's flank "W", while the readback seeded "X" AND expected that flank preserved. One row ends
 *    the disagreement, and the readback's "X" - the flank the termless arm also used - is what it
 *    keeps.
 *  - DECCRA's region covers its SOURCE rows as well as its destination (rows 1..6, columns 1..14),
 *    because the claim is two-sided: "copies ... WITHOUT changing the source". The hand-written
 *    pixel spec compared the destination only, so a destination-only region would have dropped the
 *    source control its own termless arm asserted; one rectangle spanning both keeps the whole claim
 *    on both arms.
 */
export const editingReadbackRows: readonly RegionReadbackRow[] = [
  {
    id: "editing.insert-chars",
    expected: "ICH inserts a blank cell at column 3 and shifts measured text right; prefix stays intact",
    region: { top: 1, left: 1 },
    seed: "\x1b[1;1HABCDEZQH",
    before: [["A", "B", "C", "D", "E", "Z", "Q", "H", " "]],
    steps: [{ write: "\x1b[1;3H\x1b[1@" }],
    after: [["A", "B", " ", "C", "D", "E", "Z", "Q", "H"]],
    controls: [
      { row: 0, col: 0, char: "A" },
      { row: 0, col: 1, char: "B" },
    ],
    seedNote: "ICH seed was not measured before the edit",
    controlNote: "ICH prefix control changed during the edit",
    reset: "",
  },
  {
    id: "editing.delete-chars",
    expected: "DCH deletes the cell at column 3 and shifts measured text left; prefix stays intact",
    region: { top: 1, left: 1 },
    seed: "\x1b[1;1HABCDEZQH",
    before: [["A", "B", "C", "D", "E", "Z", "Q", "H"]],
    steps: [{ write: "\x1b[1;3H\x1b[1P" }],
    after: [["A", "B", "D", "E", "Z", "Q", "H", " "]],
    controls: [
      { row: 0, col: 0, char: "A" },
      { row: 0, col: 1, char: "B" },
    ],
    seedNote: "DCH seed was not measured before the edit",
    controlNote: "DCH prefix control changed during the edit",
    reset: "",
  },
  {
    id: "editing.insert-lines",
    expected: "IL inserts a blank row 2 and shifts measured rows down while row 1 stays intact",
    region: { top: 1, left: 1 },
    seed: "\x1b[1;1HAAAAA\x1b[2;1HBBBBB\x1b[3;1HCCCCC\x1b[4;1HDDDDD",
    before: [
      ["A", "A", "A", "A", "A"],
      ["B", "B", "B", "B", "B"],
      ["C", "C", "C", "C", "C"],
      ["D", "D", "D", "D", "D"],
    ],
    steps: [{ write: "\x1b[2;1H\x1b[1L" }],
    after: [
      ["A", "A", "A", "A", "A"],
      [" ", " ", " ", " ", " "],
      ["B", "B", "B", "B", "B"],
      ["C", "C", "C", "C", "C"],
    ],
    controls: [
      { row: 0, col: 0, char: "A" },
      { row: 0, col: 1, char: "A" },
      { row: 0, col: 2, char: "A" },
      { row: 0, col: 3, char: "A" },
      { row: 0, col: 4, char: "A" },
    ],
    cursorRow: 5,
    sentinel: { row: 6, col: 1 },
    seedNote: "IL source rows were not measured before the edit",
    controlNote: "IL first-row control changed during the edit",
    reset: "",
  },
  {
    id: "editing.delete-lines",
    expected: "DL removes row 2 and shifts measured rows up while row 1 stays intact",
    region: { top: 1, left: 1 },
    seed: "\x1b[1;1HAAAAA\x1b[2;1HBBBBB\x1b[3;1HCCCCC\x1b[4;1HDDDDD",
    before: [
      ["A", "A", "A", "A", "A"],
      ["B", "B", "B", "B", "B"],
      ["C", "C", "C", "C", "C"],
      ["D", "D", "D", "D", "D"],
    ],
    steps: [{ write: "\x1b[2;1H\x1b[1M" }],
    after: [
      ["A", "A", "A", "A", "A"],
      ["C", "C", "C", "C", "C"],
      ["D", "D", "D", "D", "D"],
      [" ", " ", " ", " ", " "],
    ],
    controls: [
      { row: 0, col: 0, char: "A" },
      { row: 0, col: 1, char: "A" },
      { row: 0, col: 2, char: "A" },
      { row: 0, col: 3, char: "A" },
      { row: 0, col: 4, char: "A" },
    ],
    cursorRow: 5,
    sentinel: { row: 6, col: 1 },
    seedNote: "DL source rows were not measured before the edit",
    controlNote: "DL first-row control changed during the edit",
    reset: "",
  },
  {
    id: "editing.repeat-char",
    expected: "REP repeats the immediately preceding X into three target cells without changing flank controls",
    region: { top: 1, left: 1 },
    seed: "\x1b[1;1HAX   Z",
    before: [["A", "X", " ", " ", " ", "Z"]],
    steps: [{ write: "\x1b[1;2HX\x1b[3b" }],
    after: [["A", "X", "X", "X", "X", "Z"]],
    controls: [
      { row: 0, col: 0, char: "A" },
      { row: 0, col: 5, char: "Z" },
    ],
    cursorRow: 2,
    sentinel: { row: 3, col: 1 },
    seedNote: "REP flank and blank seed was not measured",
    controlNote: "REP flank control changed during the edit",
    reset: "",
  },
  {
    id: "editing.decfra",
    expected: "DECFRA fills the measured 3x5 area and preserves its measured right flank",
    region: { top: 1, left: 1 },
    seed: "\x1b[1;1HaaaaaZ\x1b[2;1HbbbbbY\x1b[3;1HcccccW",
    before: [
      ["a", "a", "a", "a", "a", "Z"],
      ["b", "b", "b", "b", "b", "Y"],
      ["c", "c", "c", "c", "c", "W"],
    ],
    steps: [{ write: "\x1b[1;1H\x1b[88;1;1;3;5$x" }],
    after: [
      ["X", "X", "X", "X", "X", "Z"],
      ["X", "X", "X", "X", "X", "Y"],
      ["X", "X", "X", "X", "X", "W"],
    ],
    controls: [
      { row: 0, col: 5, char: "Z" },
      { row: 1, col: 5, char: "Y" },
      { row: 2, col: 5, char: "W" },
    ],
    cursorRow: 4,
    sentinel: { row: 5, col: 1 },
    seedNote: "DECFRA seed was not measured",
    controlNote: "DECFRA outside control changed",
    reset: "",
  },
  {
    id: "editing.decera",
    expected: "DECERA blanks measured 3x5 cells and preserves their measured right flank",
    region: { top: 1, left: 1 },
    seed: "\x1b[1;1HaaaaaZ\x1b[2;1HbbbbbY\x1b[3;1HcccccX",
    before: [
      ["a", "a", "a", "a", "a", "Z"],
      ["b", "b", "b", "b", "b", "Y"],
      ["c", "c", "c", "c", "c", "X"],
    ],
    steps: [{ write: "\x1b[1;1H\x1b[1;1;3;5$z" }],
    after: [
      [" ", " ", " ", " ", " ", "Z"],
      [" ", " ", " ", " ", " ", "Y"],
      [" ", " ", " ", " ", " ", "X"],
    ],
    controls: [
      { row: 0, col: 5, char: "Z" },
      { row: 1, col: 5, char: "Y" },
      { row: 2, col: 5, char: "X" },
    ],
    cursorRow: 4,
    sentinel: { row: 5, col: 1 },
    seedNote: "DECERA seed was not measured",
    controlNote: "DECERA outside control changed",
    reset: "",
  },
  {
    id: "editing.decsera",
    expected: "DECSCA-protected P survives while selective erase clears ABCD",
    region: { top: 1, left: 1 },
    seed: '\x1b[1;1H\x1b[1"qP\x1b[0"qABCDZ',
    before: [["P", "A", "B", "C", "D", "Z"]],
    // DECSERA names its rectangle in its own parameters, so the sequence is issued where the seed left
    // the cursor - exactly as the hand-written termless helper did. No CUP: it would move the cursor
    // and buy nothing, and erase-observations.test.ts drives this row through a terminal that performs
    // the erase when it receives THESE bytes.
    steps: [{ write: "\x1b[1;1;1;5${" }],
    after: [["P", " ", " ", " ", " ", "Z"]],
    // NO control, deliberately. DECSERA's rectangle is columns 1-5, so Z at column 6 lies OUTSIDE it
    // and survives whatever the sequence does; as a control it could never fire, and a never-firing
    // control is vacuous. Every discriminating cell (the protected P, and the ABCD the sequence
    // clears) sits INSIDE the rectangle, where the sequence DOES write, so none of them may be a
    // control. By @chief's ruling (2026-10-11T22:58Z) an erase that takes the protected P is a measured
    // NEGATIVE, and `ignored` names the frame such a terminal would leave — P gone, Z kept — so taking
    // the protected cell reads unsupported instead of unattributable.
    controls: [],
    ignored: [[" ", " ", " ", " ", " ", "Z"]],
    cursorRow: 2,
    sentinel: { row: 3, col: 1 },
    seedNote: "Selective erase seed was not measured",
    controlNote: "Outside-rectangle control failed; cannot attribute selective erase",
    reset: "",
  },
  {
    id: "editing.deccra",
    expected: "DECCRA copies measured 2x5 source cells to row 5 column 10 without changing the source",
    region: { top: 1, left: 1 },
    seed: "\x1b[1;1HABCDE.........\x1b[2;1HFGHIJ.........\x1b[5;1H.........12345\x1b[6;1H.........67890",
    before: [
      ["A", "B", "C", "D", "E", ".", ".", ".", ".", ".", ".", ".", ".", "."],
      ["F", "G", "H", "I", "J", ".", ".", ".", ".", ".", ".", ".", ".", "."],
      [" ", " ", " ", " ", " ", " ", " ", " ", " ", " ", " ", " ", " ", " "],
      [" ", " ", " ", " ", " ", " ", " ", " ", " ", " ", " ", " ", " ", " "],
      [".", ".", ".", ".", ".", ".", ".", ".", ".", "1", "2", "3", "4", "5"],
      [".", ".", ".", ".", ".", ".", ".", ".", ".", "6", "7", "8", "9", "0"],
    ],
    steps: [{ write: "\x1b[1;1H\x1b[1;1;2;5;1;5;10$v" }],
    after: [
      ["A", "B", "C", "D", "E", ".", ".", ".", ".", ".", ".", ".", ".", "."],
      ["F", "G", "H", "I", "J", ".", ".", ".", ".", ".", ".", ".", ".", "."],
      [" ", " ", " ", " ", " ", " ", " ", " ", " ", " ", " ", " ", " ", " "],
      [" ", " ", " ", " ", " ", " ", " ", " ", " ", " ", " ", " ", " ", " "],
      [".", ".", ".", ".", ".", ".", ".", ".", ".", "A", "B", "C", "D", "E"],
      [".", ".", ".", ".", ".", ".", ".", ".", ".", "F", "G", "H", "I", "J"],
    ],
    controls: [
      { row: 0, col: 0, char: "A" },
      { row: 0, col: 1, char: "B" },
      { row: 0, col: 2, char: "C" },
      { row: 0, col: 3, char: "D" },
      { row: 0, col: 4, char: "E" },
      { row: 1, col: 0, char: "F" },
      { row: 1, col: 1, char: "G" },
      { row: 1, col: 2, char: "H" },
      { row: 1, col: 3, char: "I" },
      { row: 1, col: 4, char: "J" },
    ],
    cursorRow: 7,
    sentinel: { row: 8, col: 1 },
    seedNote: "DECCRA source and destination were not measured",
    controlNote: "DECCRA source or outside control changed",
    reset: "",
  },
  {
    id: "editing.sl",
    expected: "SL shifts the first nine observed cells of two rows left by two columns",
    region: { top: 1, left: 1 },
    seed: "\x1b[1;1HABCDEFGHI\x1b[2;1HJKLMNOPQR",
    before: [
      ["A", "B", "C", "D", "E", "F", "G", "H", "I"],
      ["J", "K", "L", "M", "N", "O", "P", "Q", "R"],
    ],
    steps: [{ write: "\x1b[1;1H\x1b[2 @" }],
    after: [
      ["C", "D", "E", "F", "G", "H", "I", " ", " "],
      ["L", "M", "N", "O", "P", "Q", "R", " ", " "],
    ],
    controls: [],
    cursorRow: 3,
    sentinel: { row: 4, col: 1 },
    seedNote: "SL seed was not measured",
    controlNote: "SL's unchanged columns are not part of this row's claim",
    reset: "",
  },
  {
    id: "editing.sr",
    expected: "SR shifts the first nine measured cells of two rows right by two columns",
    region: { top: 1, left: 1 },
    seed: "\x1b[1;1HABCDEFGHI\x1b[2;1HJKLMNOPQR",
    before: [
      ["A", "B", "C", "D", "E", "F", "G", "H", "I"],
      ["J", "K", "L", "M", "N", "O", "P", "Q", "R"],
    ],
    steps: [{ write: "\x1b[1;1H\x1b[2 A" }],
    after: [
      [" ", " ", "A", "B", "C", "D", "E", "F", "G"],
      [" ", " ", "J", "K", "L", "M", "N", "O", "P"],
    ],
    controls: [],
    cursorRow: 3,
    sentinel: { row: 4, col: 1 },
    seedNote: "SR seed was not measured",
    controlNote: "SR's unchanged columns are not part of this row's claim",
    reset: "",
  },
  {
    id: "editing.decic",
    expected: "DECIC inserts two blank columns at column 3 on three measured rows",
    region: { top: 1, left: 1 },
    seed: "\x1b[1;1HABCDEFGH\x1b[2;1HIJKLMNOP\x1b[3;1HQRSTUVWX",
    before: [
      ["A", "B", "C", "D", "E", "F", "G", "H"],
      ["I", "J", "K", "L", "M", "N", "O", "P"],
      ["Q", "R", "S", "T", "U", "V", "W", "X"],
    ],
    steps: [{ write: "\x1b[2;3H\x1b[2'}" }],
    after: [
      ["A", "B", " ", " ", "C", "D", "E", "F"],
      ["I", "J", " ", " ", "K", "L", "M", "N"],
      ["Q", "R", " ", " ", "S", "T", "U", "V"],
    ],
    controls: [
      { row: 0, col: 0, char: "A" },
      { row: 0, col: 1, char: "B" },
      { row: 1, col: 0, char: "I" },
      { row: 1, col: 1, char: "J" },
      { row: 2, col: 0, char: "Q" },
      { row: 2, col: 1, char: "R" },
    ],
    cursorRow: 4,
    sentinel: { row: 5, col: 1 },
    seedNote: "DECIC seed was not measured",
    controlNote: "DECIC unchanged-prefix control changed",
    reset: "",
  },
  {
    id: "editing.decdc",
    expected: "DECDC deletes two columns at column 3 on three measured rows",
    region: { top: 1, left: 1 },
    seed: "\x1b[1;1HABCDEFGHIJ\x1b[2;1HIJKLMNOPQR\x1b[3;1HQRSTUVWXab",
    // Ten compared columns, not eight: the seed writes ten, and the two incoming columns the delete
    // pulls left into the compared span (row 1 I,J; row 2 Q,R; row 3 a,b) are part of the claim. At
    // eight the ninth and tenth seed cells were stored but never verified, so a seed that wrote blanks
    // there could only fail later with an unattributable note (@cto 28450 should-fix).
    before: [
      ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J"],
      ["I", "J", "K", "L", "M", "N", "O", "P", "Q", "R"],
      ["Q", "R", "S", "T", "U", "V", "W", "X", "a", "b"],
    ],
    steps: [{ write: "\x1b[2;3H\x1b[2'~" }],
    after: [
      ["A", "B", "E", "F", "G", "H", "I", "J", " ", " "],
      ["I", "J", "M", "N", "O", "P", "Q", "R", " ", " "],
      ["Q", "R", "U", "V", "W", "X", "a", "b", " ", " "],
    ],
    controls: [
      { row: 0, col: 0, char: "A" },
      { row: 0, col: 1, char: "B" },
      { row: 1, col: 0, char: "I" },
      { row: 1, col: 1, char: "J" },
      { row: 2, col: 0, char: "Q" },
      { row: 2, col: 1, char: "R" },
    ],
    cursorRow: 4,
    sentinel: { row: 5, col: 1 },
    seedNote: "DECDC seed and incoming sources were not measured",
    controlNote: "DECDC unchanged-prefix control changed",
    reset: "",
  },
]

async function editCapture(ctx: TermContext, id: string): Promise<ProbeResult> {
  const spec = EDITING_CAPTURE_SPECS[id]
  if (!spec) throw new Error(`no editing capture spec for ${id}`)
  const needRows = spec.minRows + 1
  const needCols = spec.minCols + 2
  const { rows, cols } = ctx
  if (!Number.isSafeInteger(rows) || !Number.isSafeInteger(cols) || rows < needRows || cols < needCols) {
    return {
      pass: false,
      observation: {
        outcome: "inconclusive",
        reason: "insufficient-evidence",
        evidence: "none",
        note: `Editing capture needs at least ${needRows}x${needCols}, measured ${rows}x${cols}`,
      },
    }
  }
  const readback = EDITING_READBACK_SPECS[id]
  if (readback) {
    // The verdict path owns this row wherever the run can map cells onto its own window; a context
    // that cannot report its geometry gets a named refusal, not the ungraded pixel path.
    const verdict = await captureRegionVerdict(ctx, id, readback)
    if (verdict) return verdict
  }
  ctx.write("\x1b[0m\x1b[2J")
  try {
    ctx.write(spec.seed)
    const control = await ctx.capture!({ role: "control", label: `${id}: pre-edit seed` })
    ctx.write(spec.edit)
    const target = await ctx.capture!({ role: "target", label: id })
    return {
      pass: false,
      response: JSON.stringify({ region: spec.region, control: control.label, target: target.label }),
      observation: {
        outcome: "inconclusive",
        reason: "insufficient-evidence",
        evidence: "pixels",
        screenshotRef: target.ref,
        frames: [control, target],
        note: spec.note,
      },
    }
  } finally {
    // A capture failure can leave the seed or the edit behind; always reset SGR, clear and home.
    ctx.write("\x1b[0m\x1b[2J\x1b[H")
  }
}

const DECSACE_EXPECTED =
  "DECSACE rectangle extent confines DECCARA to the 2x2 block; stream extent reaches the rest of the reading-order span"
const DECSACE_PAINT = "\x1b[0m\x1b[2J\x1b[H\x1b[1;1Habcdefgh\x1b[2;1Hijklmnop"
const DECSACE_DEC_CARA = "\x1b[1;2;2;3;7$r" // top 1, left 2, bottom 2, right 3; reverse video
const decsaceFrame = (ctx: TermlessContext) =>
  Array.from({ length: 2 }, (_, row) => Array.from({ length: 8 }, (_, col) => ctx.getCell(row, col)))
const DECSACE_RECTANGLE_PATTERN = ".##.....|.##....."
const DECSACE_STREAM_PATTERN = ".#######|###....."
const decsaceExtentPattern = (frame: ReturnType<typeof decsaceFrame>): string =>
  frame.map((line) => line.map((cell) => (cell.inverse ? "#" : ".")).join("")).join("|")

const editingProbeDefinitions: ProbeDefinition[] = [
  ...regionReadbackProbes(editingReadbackRows),

  {
    ...probe(
      "editing.deccara",
      (ctx) => {
        const expected = "DECCARA sets inverse on measured 3x5 cells, preserving text and right flank"
        const rows = ctx.getScrollback().screenLines
        if (!Number.isSafeInteger(ctx.cols) || ctx.cols < 6 || !Number.isSafeInteger(rows) || rows < 3) {
          return parserStateResult(null, expected, { cols: ctx.cols, rows }, "Need a measured 3x6 fixture")
        }
        ctx.feed("\x1b[1;1HaaaaaZ\x1b[2;1HbbbbbY\x1b[3;1HcccccX")
        const before = Array.from({ length: 3 }, (_, row) =>
          Array.from({ length: 6 }, (_, col) => ctx.getCell(row, col)),
        )
        if (
          before.map((line) => line.map((cell) => cell.char).join("")).join("|") !== "aaaaaZ|bbbbbY|cccccX" ||
          before.some((line) => line.some((cell) => cell.inverse))
        ) {
          return parserStateResult(null, expected, { before }, "DECCARA character and attribute seed was not measured")
        }
        ctx.feed("\x1b[1;1H")
        const setup = ctx.getCursor()
        if (setup.x !== 0 || setup.y !== 0) {
          return parserStateResult(null, expected, { before, setup }, "DECCARA cursor setup failed")
        }
        // DECSACE 2 selects the rectangle extent this row measures; the surface default is stream (29817).
        ctx.feed("\x1b[2*x\x1b[1;1;3;5;7$r")
        const after = Array.from({ length: 3 }, (_, row) =>
          Array.from({ length: 6 }, (_, col) => ctx.getCell(row, col)),
        )
        const controlsValid = after.every(
          (line, row) => line.every((cell, col) => cell.char === before[row]?.[col]?.char) && !line[5]?.inverse,
        )
        return parserStateResult(
          controlsValid ? after.every((line) => line.slice(0, 5).every((cell) => cell.inverse)) : null,
          expected,
          { before, setup, after },
          controlsValid ? undefined : "DECCARA character or outside attribute control changed",
        )
      },
      async (ctx) => {
        if (!Number.isSafeInteger(ctx.rows) || !Number.isSafeInteger(ctx.cols) || ctx.rows < 3 || ctx.cols < 5) {
          return {
            pass: false,
            observation: {
              outcome: "inconclusive",
              reason: "insufficient-evidence",
              evidence: "none",
              note: `Editing fixture needs at least 3x5, measured ${ctx.rows}x${ctx.cols}`,
            },
          }
        }
        ctx.write("\x1b[1;1H")
        ctx.write("\x1b[2*x\x1b[1;1;3;5;7$r") // DECSACE 2 (rectangle), then DECCARA
        const pos = await ctx.queryCursorPosition()
        return unmeasuredCellResult(pos, "edited cells or attributes")
      },
    ),
    termNeedsGeometry: true,

    termlessObservationEvidence: "parser-state",
  },

  {
    ...probe(
      "editing.decrara",
      (ctx) => {
        const expected = "DECRARA clears inverse on measured 3x5 inverse cells, preserving text and right flank"
        const rows = ctx.getScrollback().screenLines
        if (!Number.isSafeInteger(ctx.cols) || ctx.cols < 6 || !Number.isSafeInteger(rows) || rows < 3) {
          return parserStateResult(null, expected, { cols: ctx.cols, rows }, "Need a measured 3x6 fixture")
        }
        ctx.feed("\x1b[1;1H\x1b[7maaaaa\x1b[0mZ\x1b[2;1H\x1b[7mbbbbb\x1b[0mY\x1b[3;1H\x1b[7mccccc\x1b[0mX")
        const before = Array.from({ length: 3 }, (_, row) =>
          Array.from({ length: 6 }, (_, col) => ctx.getCell(row, col)),
        )
        if (
          before.map((line) => line.map((cell) => cell.char).join("")).join("|") !== "aaaaaZ|bbbbbY|cccccX" ||
          before.some((line) => !line.slice(0, 5).every((cell) => cell.inverse) || line[5]?.inverse)
        ) {
          return parserStateResult(null, expected, { before }, "DECRARA inverse seed was not measured")
        }
        ctx.feed("\x1b[1;1H")
        const setup = ctx.getCursor()
        if (setup.x !== 0 || setup.y !== 0) {
          return parserStateResult(null, expected, { before, setup }, "DECRARA cursor setup failed")
        }
        // DECSACE 2 selects the rectangle extent this row measures; the surface default is stream (29817).
        ctx.feed("\x1b[2*x\x1b[1;1;3;5;7$t")
        const after = Array.from({ length: 3 }, (_, row) =>
          Array.from({ length: 6 }, (_, col) => ctx.getCell(row, col)),
        )
        const controlsValid = after.every(
          (line, row) => line.every((cell, col) => cell.char === before[row]?.[col]?.char) && !line[5]?.inverse,
        )
        return parserStateResult(
          controlsValid ? after.every((line) => line.slice(0, 5).every((cell) => !cell.inverse)) : null,
          expected,
          { before, setup, after },
          controlsValid ? undefined : "DECRARA character or outside attribute control changed",
        )
      },
      async (ctx) => {
        if (!Number.isSafeInteger(ctx.rows) || !Number.isSafeInteger(ctx.cols) || ctx.rows < 3 || ctx.cols < 5) {
          return {
            pass: false,
            observation: {
              outcome: "inconclusive",
              reason: "insufficient-evidence",
              evidence: "none",
              note: `Editing fixture needs at least 3x5, measured ${ctx.rows}x${ctx.cols}`,
            },
          }
        }
        ctx.write("\x1b[1;1H")
        ctx.write("\x1b[2*x\x1b[1;1;3;5;7$t") // DECSACE 2 (rectangle), then DECRARA
        const pos = await ctx.queryCursorPosition()
        return unmeasuredCellResult(pos, "edited cells or attributes")
      },
    ),
    termNeedsGeometry: true,

    termlessObservationEvidence: "parser-state",
  },

  // DECSACE selects the extent DECCARA/DECRARA apply over: stream (0 or 1) or rectangle (2). The claim is
  // measurable without pixels because the effect is an ATTRIBUTE on cells the parser already holds:
  // the same DECCARA over the same coordinates must mark exactly the rectangle under DECSACE 2, and
  // the reading-order span from its top-left to its bottom-right under DECSACE 0. The stream frame is
  // the control that proves the setting was honoured rather than ignored; when the two frames agree
  // the extent modes are indistinguishable here and the row is inconclusive BY NAME, never a pass.
  probe(
    "editing.decsace",
    (ctx) => {
      const rows = ctx.getScrollback().screenLines
      if (!Number.isSafeInteger(ctx.cols) || ctx.cols < 8 || !Number.isSafeInteger(rows) || rows < 2) {
        return parserStateResult(null, DECSACE_EXPECTED, { cols: ctx.cols, rows }, "Need a measured 2x8 fixture")
      }
      ctx.feed(DECSACE_PAINT + "\x1b[2*x" + DECSACE_DEC_CARA)
      const rect = decsaceFrame(ctx)
      ctx.feed(DECSACE_PAINT + "\x1b[0*x" + DECSACE_DEC_CARA)
      const stream = decsaceFrame(ctx)
      const charsKept = (frame: typeof rect) =>
        frame.map((line) => line.map((cell) => cell.char).join("")).join("|") === "abcdefgh|ijklmnop"
      const rectPattern = decsaceExtentPattern(rect)
      const streamPattern = decsaceExtentPattern(stream)
      if (!charsKept(rect) || !charsKept(stream)) {
        return parserStateResult(null, DECSACE_EXPECTED, { rect, stream }, "DECSACE frames changed the seed characters")
      }
      if (rectPattern === streamPattern) {
        return parserStateResult(
          null,
          DECSACE_EXPECTED,
          { rect, stream },
          "Both DECSACE extent modes left the same frame; the setting is not measurable on this parser",
        )
      }
      return parserStateResult(
        rectPattern === DECSACE_RECTANGLE_PATTERN && streamPattern === DECSACE_STREAM_PATTERN,
        DECSACE_EXPECTED,
        { rect: rectPattern, stream: streamPattern },
      )
    },
    async (ctx) => {
      // Deliberately no geometry read: when the owned terminal's geometry is unavailable, touching
      // ctx.rows/ctx.cols throws UndeclaredTerminalGeometry and the whole run loses suiteComplete.
      // The setting can still be attempted; without a cell readback the row stays unmeasured by name.
      ctx.write(DECSACE_PAINT + "\x1b[2*x" + DECSACE_DEC_CARA)
      const pos = await ctx.queryCursorPosition()
      return unmeasuredCellResult(pos, "attributes set by DECCARA under a DECSACE extent")
    },
  ),

  {
    ...probe(
      "editing.decrqcra",
      (ctx) => {
        // DECRQCRA sends a checksum request; the terminal should respond with
        // DCS Pid ! ~ D...D ST where D...D is the hex checksum.
        ctx.feed(`${DECRQCRA_SEED}\x1b[1;1H`)
        const first = ctx.feedCapture(DECRQCRA_REQUEST) // id, page, top, left, bottom, right
        ctx.feed(`${DECRQCRA_EDIT}\x1b[1;1H`)
        const second = ctx.feedCapture(DECRQCRA_REQUEST)
        return checksumResult(first, second)
      },
      async (ctx) => {
        // The DA1 follow-up ends each read on a channel the terminal has already answered, so a
        // terminal that never answers is disproved instead of being waited out on a bare timeout.
        ctx.write(`\x1b[0m\x1b[2J\x1b[H${DECRQCRA_SEED}\x1b[1;1H`)
        const reads: { raw: string; frame: string }[] = []
        for (const sequence of [DECRQCRA_SEED, DECRQCRA_EDIT]) {
          if (reads.length === 1) ctx.write(`${sequence}\x1b[1;1H`)
          const reply = await ctx.queryWithSentinelOutcome(DECRQCRA_REQUEST, /\x1bP1!~[0-9A-Fa-f]{4}\x1b\\/)
          if (reply.match) {
            // F1 (27832): a frame that lands after the DA1 answer is a late reply, graded by the
            // frame and recorded with the ordering note. Only a measured sentinel proves that
            // ordering, so a late frame without it keeps its null and falls to the inconclusive grade.
            const frame = reply.match[0] ?? ""
            const da1At = reply.raw.search(/\x1b\[\?[0-9;]*c/)
            const unorderedLateFrame = da1At !== -1 && reply.raw.indexOf(frame) > da1At && !reply.sentinel
            if (!unorderedLateFrame) {
              reads.push({ raw: frame, frame: reply.sentinel ? REPLY_AFTER_SENTINEL_NOTE : "" })
              continue
            }
          }
          // A DA1 answer with nothing else through the grace window is a measured negative, the same
          // rule device.ts and extensions.ts apply. Anything else keeps the inconclusive grade below.
          const silent = sentinelNegativeResult(
            reply.raw,
            reply.sentinel,
            "Complete four-digit checksum reply for request 1",
          )
          if (silent) return silent
          return {
            pass: false,
            response: reply.raw,
            note: "No complete checksum reply before the DA1 sentinel",
            observation: {
              outcome: "inconclusive",
              evidence: "query",
              reason: reply.reason === "timeout" ? "timeout" : "no-response",
            },
          }
        }
        const [firstRead, secondRead] = reads
        if (!firstRead || !secondRead) throw new Error("both checksum reads must exist before grading")
        return checksumResult(firstRead.raw, secondRead.raw, reads.find((read) => read.frame)?.frame)
      },
    ),
    termObservationEvidence: "query",
    termlessObservationEvidence: "query",
  },
]

export const editingProbes: ProbeDefinition[] = editingProbeDefinitions.map((definition) => {
  const original = definition.term
  if (!original || !(definition.id in EDITING_CAPTURE_SPECS)) return definition
  // A row with its own readback spec is decided from the region oracle, which reads the terminal's
  // cells on a text arm; every other editing row reads pixels and needs the pixel adapter.
  const readback = definition.id in EDITING_READBACK_SPECS
  return {
    ...definition,
    ...(readback ? { cellReadback: true as const } : {}),
    term: async (ctx) =>
      ctx.capture !== undefined || (readback && ctx.cells !== undefined)
        ? editCapture(ctx, definition.id)
        : original(ctx),
  }
})
