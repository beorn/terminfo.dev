/**
 * @failure A colour row's capture arm compares a control frame and a target frame from two paint
 *   contexts and grades "the frames differ" as support: any repaint, including one the terminal
 *   produced for an unrelated reason, then reads as a colour feature. The eleven sgr.* colour
 *   rows therefore declare one capture-region fixture each, painted in the same run, and the
 *   decision rests on the catalogue's own discriminator: the styled sample must differ from the
 *   neutral sample AND from a named sibling that a terminal LACKING exactly the claimed feature
 *   would paint identically. The expected frame is the sequence under test painted a second time,
 *   never an independent reference, so "the target equals the expected frame" proves only that the
 *   paint is stable — never that the colour is correct.
 *
 *   Each sibling rules out the missing feature rather than merely being another colour:
 *   - basic colour: another index in the same family (31 against 32), so a terminal that ignores
 *     the sequence is separated from one that paints a colour;
 *   - bright: its normal counterpart (91 against 31), so a terminal that paints bright as normal
 *     cannot separate the two and refuses by name;
 *   - 256-colour: the 16-colour entry its index quantises to (index 67 against SGR 90), so a
 *     terminal that quantises 256 colours to 16 cannot separate them;
 *   - truecolour: the RGB that the tested RGB quantises to in the xterm-256 palette (255;128;0
 *     against 255;135;0), so a terminal that quantises truecolour to 256 cannot separate them;
 *   - underline colour: the same underline in another colour, painted on a seed that already
 *     carries the underline, so the only possible difference is the colour.
 *
 *   THIS PATH NEVER DECIDES UNSUPPORTED. The oracle's measured negatives ("the sequence left the
 *   screen untouched", "the sequence matched the sibling") cannot separate a terminal that ignores
 *   the colour from one that paints it identically to the reference it was compared against, so
 *   both read inconclusive BY NAME. Deciding colour unsupported is a separate ruling.
 */
import { SENTINEL, type RegionReadback } from "./region-readback.ts"
import type { ProbeCallbackResult } from "./types.ts"

const SAMPLE = "AaBb"
const REGION = { top: 3, left: 3, bottom: 3, right: 3 + SAMPLE.length - 1 } as const
const CURSOR_ROW = 5

interface ColourRow {
  /** The sequence under test, painted on the sample in the target and expected frames. */
  sequence: string
  /** The colour a terminal lacking exactly this feature would paint identically. */
  sibling: string
  /** The sibling in words, so the observation note says what was compared. */
  siblingLabel: string
  /** A setup painted before the sample in every frame — the underline the colour rows qualify. */
  seed?: string
}

const COLOUR_ROWS: Record<string, ColourRow> = {
  "sgr.fg.standard": { sequence: "\x1b[31m", sibling: "\x1b[32m", siblingLabel: "SGR 32" },
  "sgr.bg.standard": { sequence: "\x1b[41m", sibling: "\x1b[42m", siblingLabel: "SGR 42" },
  "sgr.fg.bright": {
    sequence: "\x1b[91m",
    sibling: "\x1b[31m",
    siblingLabel: "SGR 31, the normal counterpart of SGR 91",
  },
  "sgr.bg.bright": {
    sequence: "\x1b[101m",
    sibling: "\x1b[41m",
    siblingLabel: "SGR 41, the normal counterpart of SGR 101",
  },
  "sgr.fg.256": {
    sequence: "\x1b[38;5;67m",
    sibling: "\x1b[90m",
    siblingLabel: "SGR 90, the 16-colour entry index 67 quantises to",
  },
  "sgr.bg.256": {
    sequence: "\x1b[48;5;67m",
    sibling: "\x1b[100m",
    siblingLabel: "SGR 100, the 16-colour entry index 67 quantises to",
  },
  "sgr.fg.truecolor": {
    sequence: "\x1b[38;2;255;128;0m",
    sibling: "\x1b[38;2;255;135;0m",
    siblingLabel: "the RGB 255;135;0, the nearest xterm-256 entry to 255;128;0",
  },
  "sgr.bg.truecolor": {
    sequence: "\x1b[48;2;0;255;128m",
    sibling: "\x1b[48;2;0;255;135m",
    siblingLabel: "the RGB 0;255;135, the nearest xterm-256 entry to 0;255;128",
  },
  "sgr.underline.color": {
    sequence: "\x1b[58;2;255;0;128m",
    sibling: "\x1b[58;5;5m",
    siblingLabel: "SGR 58;5;5, another underline colour",
    seed: "\x1b[4m",
  },
  "sgr.underline-color-rgb": {
    sequence: "\x1b[58;2;255;0;128m",
    sibling: "\x1b[58;2;255;0;135m",
    siblingLabel: "the RGB 255;0;135, the nearest xterm-256 entry to 255;0;128",
    seed: "\x1b[4m",
  },
  "sgr.underline-color-indexed": {
    sequence: "\x1b[58;5;5m",
    sibling: "\x1b[58;5;164m",
    siblingLabel: "index 164, whose nearest 16-colour entry is the same as the one for index 5",
    seed: "\x1b[4m",
  },
}

/** One frame of the fixture: a clean screen, the row's seed, then the paint and the sample. */
function frame(row: ColourRow, paint: string): string {
  return `\x1b[0m\x1b[2J\x1b[3;3H${row.seed ?? ""}${paint}${SAMPLE}\x1b[${CURSOR_ROW};1H`
}

/**
 * The eleven colour rows, keyed by the probe id that owns each claim. The target and the expected
 * frames paint the sequence under test; the ignored frame paints the sibling. The two degenerate
 * tests the oracle performs on those frames — expected differs from seed, expected differs from
 * ignored — are the whole claim: the colour value itself is never interpreted.
 */
export const COLOUR_CAPTURE: Record<string, Omit<RegionReadback, "pixelGeometry">> = Object.fromEntries(
  Object.entries(COLOUR_ROWS).map(([id, row]) => [
    id,
    {
      region: { ...REGION },
      sentinel: { ...SENTINEL },
      cursorRow: CURSOR_ROW,
      seed: frame(row, ""),
      edit: frame(row, row.sequence),
      expected: frame(row, row.sequence),
      ignored: frame(row, row.sibling),
      timeoutMs: 5000,
      pollMs: 250,
      minRows: CURSOR_ROW,
      minCols: REGION.right,
    },
  ]),
)

/** What this decision compared, and what it did not. */
export function colourCaptureNote(id: string): string | undefined {
  const row = COLOUR_ROWS[id]
  if (!row) return undefined
  return `${id}: the styled sample differs from the neutral sample and from sibling ${row.siblingLabel}, and two paints of the same sequence agree; the rendered colour value is not interpreted`
}

/**
 * Report the colour decision in the row's own terms. The oracle's `unsupported` branches are
 * measured negatives of "the screen did not move into the expected frame", which for a colour row
 * cannot separate an ignored sequence from one painted identically to the sibling, so they read
 * inconclusive BY NAME here. A supported observation carries the note that says what was compared.
 */
export function colourCaptureVerdict(id: string, verdict: ProbeCallbackResult): ProbeCallbackResult {
  const note = colourCaptureNote(id)
  const observation = verdict.observation
  if (note === undefined || observation === undefined) return verdict
  if (observation.outcome === "unsupported") {
    // A downgraded result keeps nothing from the verdict it replaced: the oracle's negative
    // assertion names an outcome this path does not publish, and the batch reader records every
    // assertion it is handed.
    const { assertions: _assertions, ...rest } = verdict
    return {
      ...rest,
      pass: false,
      observation: {
        ...observation,
        outcome: "inconclusive",
        reason: "insufficient-evidence",
        note: `${id}: the sequence left the sample in the neutral or the sibling frame; this colour path does not decide unsupported, because that cannot separate a terminal that ignores the colour from one that paints it identically to the reference it was compared against`,
      },
    }
  }
  if (observation.outcome === "supported") {
    return { ...verdict, observation: { ...observation, note } }
  }
  return verdict
}
