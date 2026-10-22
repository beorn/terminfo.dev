import type { ProbeDefinition, ProbeResult, TermlessContext, ObservationFrame } from "./types.ts"
import { frameDigests } from "./types.ts"
import { regionReadbackProbes, type RegionReadbackRow } from "./region-readback-kind.ts"
import {
  beginCaptureLifecycle,
  captureStabilityPair,
  endCaptureLifecycle,
  captureRegionGeometry,
  cropPositionRefusal,
} from "./region-readback.ts"
import {
  notTestedResult,
  parserStateResult,
  probe,
  REPLY_AFTER_SENTINEL_NOTE,
  sentinelAnswer,
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
 * The 15 measured editing rows, as one region-readback kind table (28450 slice C). Each row
 * holds its claim ONCE: the termless arm reads its seed, its steps and its target cells against the
 * parser, and the kind derives the capture-region oracle's seed / edit / expected frames from the
 * same fields, so the two arms cannot grade two different fixtures.
 *
 * Two notes this table carries, both named in the diff:
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
    textClaim: "characters",
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
    textClaim: "characters",
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
    textClaim: "characters",
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
    textClaim: "characters",
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
    textClaim: "characters",
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
    textClaim: "characters",
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
    textClaim: "characters",
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
    textClaim: "characters",
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
    textClaim: "characters",
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
    textClaim: "characters",
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
    textClaim: "characters",
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
    textClaim: "characters",
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
    textClaim: "characters",
    expected: "DECDC deletes two columns at column 3 on three measured rows",
    region: { top: 1, left: 1 },
    seed: "\x1b[1;1HABCDEFGHIJ\x1b[2;1HIJKLMNOPQR\x1b[3;1HQRSTUVWXab",
    // Ten compared columns, not eight: the seed writes ten, and the two incoming columns the delete
    // pulls left into the compared span (row 1 I,J; row 2 Q,R; row 3 a,b) are part of the claim. At
    // eight the ninth and tenth seed cells were stored but never verified, so a seed that wrote blanks
    // there could only fail later with an unattributable note (28450 should-fix).
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
  {
    id: "editing.deccara",
    expected: "DECCARA sets inverse on the measured 3x5 rectangle, preserving text and the right flank",
    region: { top: 1, left: 1 },
    seed: "\x1b[1;1HaaaaaZ\x1b[2;1HbbbbbY\x1b[3;1HcccccX",
    before: [
      [
        { char: "a", attributes: { inverse: false } },
        { char: "a", attributes: { inverse: false } },
        { char: "a", attributes: { inverse: false } },
        { char: "a", attributes: { inverse: false } },
        { char: "a", attributes: { inverse: false } },
        { char: "Z", attributes: { inverse: false } },
      ],
      [
        { char: "b", attributes: { inverse: false } },
        { char: "b", attributes: { inverse: false } },
        { char: "b", attributes: { inverse: false } },
        { char: "b", attributes: { inverse: false } },
        { char: "b", attributes: { inverse: false } },
        { char: "Y", attributes: { inverse: false } },
      ],
      [
        { char: "c", attributes: { inverse: false } },
        { char: "c", attributes: { inverse: false } },
        { char: "c", attributes: { inverse: false } },
        { char: "c", attributes: { inverse: false } },
        { char: "c", attributes: { inverse: false } },
        { char: "X", attributes: { inverse: false } },
      ],
    ],
    // DECSACE 2 selects the rectangle extent this row measures (29817): the surface default is stream.
    steps: [{ write: "\x1b[1;1H\x1b[2*x\x1b[1;1;3;5;7$r" }],
    after: [
      [
        { char: "a", attributes: { inverse: true } },
        { char: "a", attributes: { inverse: true } },
        { char: "a", attributes: { inverse: true } },
        { char: "a", attributes: { inverse: true } },
        { char: "a", attributes: { inverse: true } },
        { char: "Z", attributes: { inverse: false } },
      ],
      [
        { char: "b", attributes: { inverse: true } },
        { char: "b", attributes: { inverse: true } },
        { char: "b", attributes: { inverse: true } },
        { char: "b", attributes: { inverse: true } },
        { char: "b", attributes: { inverse: true } },
        { char: "Y", attributes: { inverse: false } },
      ],
      [
        { char: "c", attributes: { inverse: true } },
        { char: "c", attributes: { inverse: true } },
        { char: "c", attributes: { inverse: true } },
        { char: "c", attributes: { inverse: true } },
        { char: "c", attributes: { inverse: true } },
        { char: "X", attributes: { inverse: false } },
      ],
    ],
    controls: [
      { row: 0, col: 5, char: "Z" },
      { row: 1, col: 5, char: "Y" },
      { row: 2, col: 5, char: "X" },
    ],
    cursorRow: 4,
    sentinel: { row: 5, col: 1 },
    seedNote: "DECCARA character or attribute seed was not measured",
    controlNote: "DECCARA changed the text or the right flank outside its rectangle",
    // DECSACE 2 is a terminal MODE the row sets to measure the rectangle extent; the shared lifecycle
    // clears it on every exit so the next probe reads the power-on stream default.
    cleanup: "\x1b[0*x",
    reset: "\x1b[0m",
  },
  {
    id: "editing.decrara",
    expected: "DECRARA clears inverse on the measured 3x5 rectangle, preserving text and the right flank",
    region: { top: 1, left: 1 },
    seed: "\x1b[0m\x1b[1;1H\x1b[7maaaaa\x1b[0mZ\x1b[2;1H\x1b[7mbbbbb\x1b[0mY\x1b[3;1H\x1b[7mccccc\x1b[0mX",
    before: [
      [
        { char: "a", attributes: { inverse: true } },
        { char: "a", attributes: { inverse: true } },
        { char: "a", attributes: { inverse: true } },
        { char: "a", attributes: { inverse: true } },
        { char: "a", attributes: { inverse: true } },
        { char: "Z", attributes: { inverse: false } },
      ],
      [
        { char: "b", attributes: { inverse: true } },
        { char: "b", attributes: { inverse: true } },
        { char: "b", attributes: { inverse: true } },
        { char: "b", attributes: { inverse: true } },
        { char: "b", attributes: { inverse: true } },
        { char: "Y", attributes: { inverse: false } },
      ],
      [
        { char: "c", attributes: { inverse: true } },
        { char: "c", attributes: { inverse: true } },
        { char: "c", attributes: { inverse: true } },
        { char: "c", attributes: { inverse: true } },
        { char: "c", attributes: { inverse: true } },
        { char: "X", attributes: { inverse: false } },
      ],
    ],
    steps: [{ write: "\x1b[1;1H\x1b[2*x\x1b[1;1;3;5;7$t" }],
    after: [
      [
        { char: "a", attributes: { inverse: false } },
        { char: "a", attributes: { inverse: false } },
        { char: "a", attributes: { inverse: false } },
        { char: "a", attributes: { inverse: false } },
        { char: "a", attributes: { inverse: false } },
        { char: "Z", attributes: { inverse: false } },
      ],
      [
        { char: "b", attributes: { inverse: false } },
        { char: "b", attributes: { inverse: false } },
        { char: "b", attributes: { inverse: false } },
        { char: "b", attributes: { inverse: false } },
        { char: "b", attributes: { inverse: false } },
        { char: "Y", attributes: { inverse: false } },
      ],
      [
        { char: "c", attributes: { inverse: false } },
        { char: "c", attributes: { inverse: false } },
        { char: "c", attributes: { inverse: false } },
        { char: "c", attributes: { inverse: false } },
        { char: "c", attributes: { inverse: false } },
        { char: "X", attributes: { inverse: false } },
      ],
    ],
    controls: [
      { row: 0, col: 5, char: "Z" },
      { row: 1, col: 5, char: "Y" },
      { row: 2, col: 5, char: "X" },
    ],
    cursorRow: 4,
    sentinel: { row: 5, col: 1 },
    seedNote: "DECRARA inverse seed was not measured",
    controlNote: "DECRARA changed the text or the right flank outside its rectangle",
    // DECSACE 2 is a terminal MODE the row sets to measure the rectangle extent; the shared lifecycle
    // clears it on every exit so the next probe reads the power-on stream default.
    cleanup: "\x1b[0*x",
    reset: "\x1b[0m",
  },
]

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

  // DECSACE selects the extent DECCARA/DECRARA apply over: stream (0 or 1) or rectangle (2). The claim is
  // measurable without pixels because the effect is an ATTRIBUTE on cells the parser already holds:
  // the same DECCARA over the same coordinates must mark exactly the rectangle under DECSACE 2, and
  // the reading-order span from its top-left to its bottom-right under DECSACE 0. The stream frame is
  // the control that proves the setting was honoured rather than ignored. When the two frames agree it
  // is never a pass, and the pair says why (#30702): both frames on the stream pattern measure DECSACE
  // 2 ignored, both on the rectangle pattern measure the stream extent ignored, and either is a measured
  // negative, not an inconclusive. No inverse cell in either frame means DECCARA itself was not
  // honoured, so the extent has no observable (TEST TODO); any other agreeing pair is inconclusive by name.
  {
    ...probe(
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
          return parserStateResult(
            null,
            DECSACE_EXPECTED,
            { rect, stream },
            "DECSACE frames changed the seed characters",
          )
        }
        if (rectPattern === streamPattern) {
          const patterns = { rect: rectPattern, stream: streamPattern }
          if (streamPattern === DECSACE_STREAM_PATTERN) {
            return parserStateResult(
              false,
              DECSACE_EXPECTED,
              patterns,
              "DECSACE 2 was ignored: the rectangle frame shows the stream extent",
            )
          }
          if (rectPattern === DECSACE_RECTANGLE_PATTERN) {
            return parserStateResult(
              false,
              DECSACE_EXPECTED,
              patterns,
              "DECSACE 0 was ignored: the stream frame shows the rectangle extent",
            )
          }
          if (!rectPattern.includes("#")) {
            return notTestedResult("DECCARA not honoured, extent unobservable", { rect, stream })
          }
          return parserStateResult(
            null,
            DECSACE_EXPECTED,
            { rect, stream },
            "Both DECSACE extent modes left the same frame, which is neither the rectangle nor the stream extent",
          )
        }
        return parserStateResult(
          rectPattern === DECSACE_RECTANGLE_PATTERN && streamPattern === DECSACE_STREAM_PATTERN,
          DECSACE_EXPECTED,
          { rect: rectPattern, stream: streamPattern },
        )
      },
      async (ctx) => {
        // This arm declares termNeedsGeometry because its evidence compares the painted 2x8 cells.
        // The collector establishes the grid; the shared route maps it to the owned pixel capture.
        const capture = ctx.capture
        if (!capture) {
          // The extent is a terminal MODE, not a cell write: leaving DECSACE 2 set would change what the
          // next probe's DECCARA/DECRARA reach, and no lifecycle runs on this branch to clear it.
          ctx.write(DECSACE_PAINT + "\x1b[2*x" + DECSACE_DEC_CARA + "\x1b[0*x")
          const pos = await ctx.queryCursorPosition()
          return unmeasuredCellResult(pos, "attributes set by DECCARA under a DECSACE extent")
        }
        if (ctx.captureKind === "text-cells") {
          return {
            pass: false,
            observation: {
              outcome: "inconclusive",
              reason: "insufficient-evidence",
              evidence: "none",
              note: "editing.decsace: text-cells captures cannot establish this pixel-cell extent comparison",
            },
          }
        }
        const cells = { top: 1, left: 1, bottom: 2, right: 8 }
        const reported = await captureRegionGeometry(ctx, "editing.decsace", { region: cells, minRows: 2, minCols: 8 })
        if ("pass" in reported) return reported
        const captureEligibilityRefusal = (captures: ObservationFrame[]): ProbeResult | null => {
          const text = captures.find((frame) => frame.kind === "text-cells")
          if (text) {
            return {
              pass: false,
              response: JSON.stringify({ frame: text.ref, kind: text.kind }),
              observation: {
                outcome: "inconclusive",
                reason: "insufficient-evidence",
                evidence: "text",
                note: `editing.decsace: ${text.label} returned text-cells instead of the pixel cells required for this extent comparison`,
              },
            }
          }
          const invalid = captures.find(
            (frame) => frameDigests(frame).cells === undefined || frame.regionRectangle === undefined,
          )
          if (!invalid) return null
          const target = captures.findLast((frame) => frame.role === "target")
          return {
            pass: false,
            observation: {
              outcome: "inconclusive",
              reason: "insufficient-evidence",
              evidence: "pixels",
              screenshotRef: target?.ref ?? invalid.ref,
              ...(target ? { frames: captures.slice(-3) } : {}),
              note: `editing.decsace: ${invalid.label} is pixels without the required pixel cells digest and rectangle`,
            },
          }
        }
        try {
          // The capture-region oracle's OWN controls, called rather than copied: the lifecycle from
          // beginCaptureLifecycle/endCaptureLifecycle and the ONE stability rule from
          // captureStabilityPair (region-readback.ts). The cursor stays hidden for every read and is
          // restored on every exit. The pair reads the SEEDED screen and returns its second read, the
          // seed frame every extent is compared against, so a seed that is still settling is refused
          // rather than measured, and a frame that only looks stable after the measurement cannot
          // qualify it. On a terminal that ignores DECSACE, a blinking cursor alone moves the
          // compared-cell digest.
          beginCaptureLifecycle(ctx)
          ctx.write(DECSACE_PAINT)
          const stabilityFrames: ObservationFrame[] = []
          const stabilityRead = async (label: string) => {
            const frame = await capture({ role: "control", label, cells, pixelGeometry: reported.geometry })
            stabilityFrames.push(frame)
            const digests = frameDigests(frame)
            return { regionDigest: digests.cells, frame }
          }
          const {
            refusal: instability,
            second: seedCapture,
            stability,
          } = await captureStabilityPair(
            "editing.decsace",
            "pixels",
            () => stabilityRead("editing.decsace: seed stability 1"),
            () => stabilityRead("editing.decsace: seed stability 2"),
          )
          const seedRefusal = captureEligibilityRefusal(stabilityFrames)
          if (seedRefusal) return seedRefusal
          if (instability) return instability
          const seed = seedCapture.frame
          ctx.write(DECSACE_PAINT + "\x1b[2*x" + DECSACE_DEC_CARA)
          const rectangle = await capture({
            role: "target",
            label: "editing.decsace: DECSACE 2 rectangle frame",
            cells,
            pixelGeometry: reported.geometry,
          })
          ctx.write(DECSACE_PAINT + "\x1b[0*x" + DECSACE_DEC_CARA)
          // The stream frame is the control: the same DECCARA under the other extent. Equal frames mean
          // this adapter cannot separate the extents, so the row is inconclusive BY NAME, never a pass.
          const stream = await capture({
            role: "target",
            label: "editing.decsace: DECSACE 0 stream frame",
            cells,
            pixelGeometry: reported.geometry,
          })
          const allFrames = [...stabilityFrames, rectangle, stream]
          const frames = [seed, rectangle, stream]
          const kind = "cells"
          const measured = frames.map((frame) => frameDigests(frame).cells)
          const observed = JSON.stringify({
            stability,
            kind,
            seed: seed.ref,
            rectangle: rectangle.ref,
            stream: stream.ref,
            digests: measured,
          })
          const frameRefusal = captureEligibilityRefusal(allFrames)
          if (frameRefusal) return frameRefusal
          const cropRefusal = cropPositionRefusal({
            id: "editing.decsace",
            response: observed,
            frames,
            screenshotRef: stream.ref,
            compared: allFrames.map((frame) => ({
              role: frame.label,
              rectangle: frame.kind === "text-cells" ? undefined : frame.regionRectangle,
            })),
          })
          if (cropRefusal) return cropRefusal
          if (measured[1] === measured[2]) {
            return {
              pass: false,
              response: observed,
              observation: {
                outcome: "inconclusive",
                reason: "insufficient-evidence",
                evidence: "pixels",
                screenshotRef: stream.ref,
                frames,
                note: "Both DECSACE extent modes left the same frame; the setting is not measurable on this adapter",
              },
            }
          }
          // A frame that did not move from the seed has measured no change at all, so an ignored
          // DECCARA and a digest that cannot see attributes are the same evidence.
          if (measured[1] === measured[0] || measured[2] === measured[0]) {
            const still = measured[1] === measured[0] ? "rectangle" : "stream"
            return {
              pass: false,
              response: observed,
              observation: {
                outcome: "inconclusive",
                reason: "insufficient-evidence",
                evidence: "pixels",
                screenshotRef: stream.ref,
                frames,
                note: `The ${still} frame did not differ from the seed, so DECCARA left no measurable change and an ignored DECCARA cannot be separated from a digest that cannot see attributes`,
              },
            }
          }
          // Separable extents are the claim this arm can establish: the same DECCARA produced two
          // different frames under DECSACE 2 and DECSACE 0, each different from the seed. It does NOT
          // grade the exact cells (the parser arm does), and every ambiguous frame stays inconclusive
          // above rather than a negative.
          return {
            pass: true,
            response: observed,
            observation: {
              outcome: "supported",
              evidence: "pixels",
              screenshotRef: stream.ref,
              frames,
              note: "The rectangle and stream frames differ from the seed and from each other; exact extents are graded by the parser arm",
            },
            assertions: [
              {
                kind: "positive",
                expected: DECSACE_EXPECTED,
                observed: JSON.stringify({ kind, seed: measured[0], rectangle: measured[1], stream: measured[2] }),
              },
            ],
          }
        } finally {
          endCaptureLifecycle(ctx, "\x1b[0*x")
        }
      },
    ),
    // Both arms measure the claim: the parser grades the exact attribute cells and the terminal
    // separates the two extents by its frames. probeStatus derives from these two declarations, so
    // leaving them off keeps the row on a reviewed partial however complete the measurement becomes.
    termNeedsGeometry: true,
    termObservationEvidence: "pixels",
    termlessObservationEvidence: "parser-state",
  },

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
            const da1At = sentinelAnswer(reply.raw)?.start ?? -1
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

export const editingProbes: ProbeDefinition[] = editingProbeDefinitions
