/**
 * @failure A colour row's capture arm compares a control frame and a target frame from two paint
 *   contexts and grades "the frames differ" as support: any repaint, including one the terminal
 *   produced for an unrelated reason, then reads as a colour feature. The ten sgr.* colour
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
 *   A ROW'S OWN FRAMES NEVER DECIDE UNSUPPORTED. The oracle's measured negatives ("the sequence left
 *   the screen untouched", "the sequence matched the sibling") cannot separate a terminal that
 *   ignores the colour from one that paints it identically to the reference it was compared
 *   against, so both read inconclusive BY NAME. Unsupported is decided only by a named branch with
 *   its own witness: colour-no-attribute-witness (region-readback) and colour-sibling-separation
 *   (colourSiblingSeparation below, run at the batch tail because it reads a second row).
 */
import { HEADLESS_OBSERVABLE_REVIEW } from "./helpers.ts"
import {
  SENTINEL,
  captureSameRunPhases,
  type RegionReadback,
  type SameRunCapture,
  type SameRunPhase,
} from "./region-readback.ts"
import type {
  ColourSiblingSeparationWitness,
  Observation,
  ObservationFrame,
  ProbeAssertion,
  ProbeCallbackResult,
  ProbeTestInput,
  TermProbeSource,
} from "./types.ts"

const SAMPLE = "AaBb"
const REGION = { top: 3, left: 3, bottom: 3, right: 3 + SAMPLE.length - 1 } as const
const CURSOR_ROW = 5

/** The same-run branch of the indexed underline-colour witness; sgr.ts maps it for the mux finalizer. */
export const UNDERLINE_INDEXED_BRANCH = "underline-colour-indexed-same-run"

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
}

/**
 * #33146 (@cto 075685d5, d2f24294, b3d7680f): indexed underline colour, decided digest-exact from one
 * same-run capture. The sample is spaces, so the cells hold only the underline. Per palette index N:
 * A no underline, B the plain underline, C the underline plus 58:5:N, D' the underline plus foreground
 * 38:5:N and no 58 — the underline takes its colour from the foreground, so D' paints palette entry N by
 * a route that is not 58. Colon form only; DECRQSS decides nothing here. Equality only, no tolerance.
 */
const UNDERLINE_INDEXED_ID = "sgr.underline-color-indexed"
const UNDERLINE_INDICES = [1, 4] as const
const UNDERLINE_SAMPLE = " ".repeat(8)

const UNDERLINE_PHASE = {
  blank: "A no underline",
  underline: "B plain underline",
  colour: (index: number) => `C underline 58:5:${index}`,
  route: (index: number) => `D' underline 38:5:${index}`,
} as const

export const UNDERLINE_INDEXED_PHASES: readonly SameRunPhase[] = [
  { name: UNDERLINE_PHASE.blank, sequence: "", sample: UNDERLINE_SAMPLE },
  { name: UNDERLINE_PHASE.underline, sequence: "\x1b[4m", sample: UNDERLINE_SAMPLE },
  ...UNDERLINE_INDICES.flatMap((index): SameRunPhase[] => [
    {
      name: UNDERLINE_PHASE.colour(index),
      sequence: `\x1b[4m\x1b[58:5:${index}m`,
      sample: UNDERLINE_SAMPLE,
      role: index === UNDERLINE_INDICES[0] ? "target" : "control",
    },
    { name: UNDERLINE_PHASE.route(index), sequence: `\x1b[4m\x1b[38:5:${index}m`, sample: UNDERLINE_SAMPLE },
  ]),
]

export interface UnderlineIndexedDecision {
  status: "supported" | "unsupported" | "probe-todo"
  note: string
  /** All four digests per index (@cto b3d7680f 1), keyed by index. */
  evidence: Record<string, { A: string; B: string; C: string; "D'": string }>
}

/** The five outcomes, in the ruled order. Only exact digest equality between phases is read. */
export function underlineColourIndexedDecision(digest: (name: string) => string): UnderlineIndexedDecision {
  const id = UNDERLINE_INDEXED_ID
  const blank = digest(UNDERLINE_PHASE.blank)
  const plain = digest(UNDERLINE_PHASE.underline)
  const rows = UNDERLINE_INDICES.map((index) => ({
    index,
    colour: digest(UNDERLINE_PHASE.colour(index)),
    route: digest(UNDERLINE_PHASE.route(index)),
  }))
  const evidence = Object.fromEntries(
    rows.map(({ index, colour, route }) => [String(index), { A: blank, B: plain, C: colour, "D'": route }]),
  )
  const decide = (status: UnderlineIndexedDecision["status"], note: string): UnderlineIndexedDecision => ({
    status,
    note,
    evidence,
  })
  // The order is the ruling (@cto b3d7680f 1): controls first, so a blind control never becomes a verdict on 58.
  if (plain === blank) {
    return decide(
      "probe-todo",
      `${id}: the plain underline drew nothing on these cells, so this row is not applicable here; the underline itself is decided by sgr.underline.single`,
    )
  }
  for (const { index, route } of rows) {
    if (route === plain) {
      return decide(
        "probe-todo",
        `${id}: the underline under foreground 38:5:${index} painted like the default underline, so palette entry ${index} cannot be told apart on the foreground route; a terminal whose underline does not follow the foreground stays undecided by this probe, and this says nothing about 58`,
      )
    }
  }
  const [first, second] = rows
  if (first && second && first.route === second.route) {
    return decide(
      "probe-todo",
      `${id}: the two palette entries render alike here: the foreground-route underlines for indices ${first.index} and ${second.index} are identical`,
    )
  }
  const outcomes = rows.map((row) => ({
    ...row,
    outcome: row.colour === plain ? "ignored" : row.colour === row.route ? "matched" : "neither",
  }))
  const neither = outcomes.find(({ outcome }) => outcome === "neither")
  if (neither) {
    return decide(
      "probe-todo",
      `${id}: 58:5:${neither.index} changed the underline but matched neither the default underline nor the foreground-route underline (58:5:${neither.index} sample ${neither.colour}, 38:5:${neither.index} sample ${neither.route})`,
    )
  }
  if (outcomes.every(({ outcome }) => outcome === "matched")) {
    return decide(
      "supported",
      `${id}: 58:5:N paints the underline as palette entry N, matched exactly against an underline coloured by the foreground route (N = ${UNDERLINE_INDICES.join(" and ")})`,
    )
  }
  if (outcomes.every(({ outcome }) => outcome === "ignored")) {
    return decide(
      "unsupported",
      `${id}: 58:5:N left the underline in its default colour while the same underline took palette entry N by the foreground route (N = ${UNDERLINE_INDICES.join(" and ")}): colour ignored, decoration kept`,
    )
  }
  return decide(
    "probe-todo",
    `${id}: the indices disagree: ${outcomes.map(({ index, outcome }) => `index ${index} ${outcome === "matched" ? "matched the foreground route" : "kept the default colour"}`).join(", ")}`,
  )
}

/** The callback result for a decision, on the same-run branch the mux finalizer knows. */
export function underlineColourIndexedResult(
  run: SameRunCapture,
  decision: UnderlineIndexedDecision,
): ProbeCallbackResult {
  const { status, note } = decision
  const decided = status !== "probe-todo"
  const target = run.measured.find(({ name }) => name === UNDERLINE_PHASE.colour(UNDERLINE_INDICES[0]))?.capture.frame
  const response = JSON.stringify({
    region: run.region,
    pixelGeometry: run.pixelGeometry,
    geometrySource: run.geometrySource,
    stability: run.stability,
    samples: Object.fromEntries(run.measured.map(({ name, capture }) => [name, capture.regionDigest])),
    evidence: decision.evidence,
  })
  return {
    pass: status === "supported",
    note,
    response,
    criterionBranch: UNDERLINE_INDEXED_BRANCH,
    tests: [{ id: "attribute", status, ...(decided ? { assertionRefs: [0] } : { reason: note }) }],
    observation: {
      outcome: decided ? status : "inconclusive",
      assertionType: "screenshot",
      ...(decided ? {} : { reason: "insufficient-evidence" as const }),
      screenshotRef: target?.ref ?? run.frames.at(-1)?.ref,
      frames: run.frames,
      note,
    },
    ...(decided
      ? {
          assertions: [
            {
              assertionType: "screenshot" as const,
              kind: status === "supported" ? ("positive" as const) : ("negative" as const),
              expected: `${UNDERLINE_INDEXED_ID}: 58:5:N matches the foreground-route underline exactly at every index`,
              observed: response,
            },
          ],
        }
      : {}),
  }
}

/** The capture arm: null when this run has no owned pixel capture. */
export async function underlineColourIndexedCaptureResult(ctx: TermProbeSource): Promise<ProbeCallbackResult | null> {
  return captureSameRunPhases(
    ctx,
    UNDERLINE_INDEXED_ID,
    UNDERLINE_SAMPLE.length,
    UNDERLINE_INDEXED_PHASES,
    (run, note) => underlineColourIndexedResult(run, { status: "probe-todo", note, evidence: {} }),
    (run, digest) => underlineColourIndexedResult(run, underlineColourIndexedDecision(digest)),
  )
}

/** One frame of the fixture: a clean screen, the row's seed, then the paint and the sample. */
function frame(row: ColourRow, paint: string): string {
  return `\x1b[0m\x1b[2J\x1b[3;3H${row.seed ?? ""}${paint}${SAMPLE}\x1b[${CURSOR_ROW};1H`
}

/**
 * The frame that paints no attribute at all. A colour claim may never read support from it: a
 * terminal that does not implement the row's sequence but walks the SGR parameter list code by code
 * reaches the literal `0` inside `58;2;255;0;128` (or `38;2;255;128;0`) and resets the rendition,
 * so the styled sample renders as plain text while still differing from a seed that carries an
 * attribute. Screen 5.0.2 does exactly that (@dev/luna6, 2026-11-10): it emits `\x1b[4m\x1b[24m`
 * for the underline-colour row's sequence and switches the underline off.
 */
const NO_ATTRIBUTE_FRAME = frame({ sequence: "", sibling: "", siblingLabel: "" }, "")

/** The SGR parameters of a row's sequence, as a reason names them: `\x1b[58;2;255;0;128m` -> `58;2;255;0;128`. */
function sgrParameters(sequence: string): string {
  return sequence.replace(/^\x1b\[/, "").replace(/m$/, "")
}

/**
 * The ten colour rows (sgr.underline-color-indexed has its own witness, #33146), keyed by the probe id that owns each claim. The target and the expected
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
      // Only the rows whose seed paints an attribute need this frame declared: for every other row
      // the seed IS the no-attribute frame, so the oracle's existing `seed === expected` check
      // already refuses a terminal that painted nothing.
      ...(row.seed === undefined
        ? {}
        : {
            noAttribute: NO_ATTRIBUTE_FRAME,
            // The seed carries the underline, so an expected frame equal to plain text is a MEASURED
            // NEGATIVE: the terminal ran the sequence and painted nothing, while the seed shows the
            // attribute it should have decorated was painting. @cto 4ed6bddf.
            noAttributeNegative: { sequence: sgrParameters(row.sequence) },
          }),
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
export function colourCaptureCallbackResult(
  id: string,
  verdict: ProbeCallbackResult,
  options?: { mux?: "tmux" | "screen" },
): ProbeCallbackResult {
  const note = colourCaptureNote(id)
  const observation = verdict.observation
  if (note === undefined || observation === undefined) return verdict
  // The witness negative is this arm's own decision and carries its own reason: the seed frame is a
  // positive witness that the attributed sample was painting, and the expected frame equals plain
  // text. It is not one of the oracle's untouched negatives, so the downgrade below does not apply.
  if (verdict.criterionBranch === "colour-no-attribute-witness") {
    // A multiplexer has no outer control in this arm, so the same frames cannot single out whether
    // the mux or its outer terminal dropped the sequence (@cto 4ed6bddf). Keep it undecided until an
    // outer control exists rather than blaming the mux on evidence that does not name it.
    if (options?.mux === undefined) return verdict
    // The collector grades from tests, not from observation. Spreading the witness verdict
    // would keep `tests: [{ status: "unsupported" }]` and publish a negative whose reason
    // says the frames cannot separate the mux from its outer terminal. This is the same
    // shape as review(inconclusive(...)): probe-todo, and the observation stays inconclusive.
    const note = `${observation.note}; this capture through multiplexer ${options.mux} cannot separate it from its outer terminal, and this run has no outer control for the sequence`
    return {
      pass: false,
      criterionBranch: "visual-review",
      tests: [{ id: "review", status: "probe-todo", reason: note }],
      observation: {
        ...observation,
        outcome: "inconclusive",
        reason: "insufficient-evidence",
        note,
      },
      ...(verdict.response === undefined ? {} : { response: verdict.response }),
    }
  }
  if (observation.outcome === "unsupported") {
    // A downgraded result keeps nothing from the verdict it replaced: the oracle's negative
    // assertion names an outcome this path does not publish, and the batch reader records every
    // assertion it is handed.
    const { assertions: _assertions, ...rest } = verdict
    return {
      ...rest,
      pass: false,
      criterionBranch: HEADLESS_OBSERVABLE_REVIEW,
      tests: [
        {
          id: "review",
          status: "probe-todo",
          reason: "colour oracle cannot distinguish ignored from identical paint against the current reference",
        },
      ],
      observation: {
        ...observation,
        outcome: "inconclusive",
        reason: "insufficient-evidence",
        note: `${id}: the sequence left the sample in the neutral or the sibling frame; these frames alone do not decide unsupported, because they cannot separate a terminal that ignores the colour from one that paints it identically to the reference it was compared against`,
      },
    }
  }
  if (observation.outcome === "supported") {
    return { ...verdict, observation: { ...observation, note } }
  }
  return verdict
}

/**
 * The two Screen truecolour rows and their same-channel sibling (#33041, @cto acd2e579 amended 16:05Z).
 * The requested colour and the declared default-colour assumption live beside each other here, so a
 * harness profile whose default equals the requested colour is read against the same line.
 */
const SIBLING_SEPARATION: Readonly<
  Record<string, { channel: "fg" | "bg"; siblingRowId: string; colour: string; assumption: string }>
> = {
  "sgr.fg.truecolor": {
    channel: "fg",
    siblingRowId: "sgr.fg.256",
    colour: "#ff8000",
    assumption: "the run's default foreground is not (255,128,0)",
  },
  "sgr.bg.truecolor": {
    channel: "bg",
    siblingRowId: "sgr.bg.256",
    colour: "#00ff80",
    assumption: "the run's default background is not (0,255,128)",
  },
}

/** The four region frames of a colour row, by the step label region-readback records verbatim. */
const COLOUR_FRAME_STEPS = {
  seed: "pre-edit seed",
  target: "post-sequence target",
  expected: "expected frame",
  ignored: "ignored-attribute frame",
} as const

/** The placed outer-terminal record the launcher matched for this run, reduced to what the witness cites. */
export interface OuterColourRecord {
  id: string
  version: string
  os: string
  /** Repository-relative, e.g. content/probes-apps/kitty-0.49.2-linux-<runId>.json. */
  recordPath: string
  recordRunId: string
  /** featureId -> status in that record, for the rows this branch decides. */
  statuses: Readonly<Record<string, string>>
}

/** What the batch tail knows about the outer control: the matched record, or why there is none. */
export type OuterColourControl =
  | { record: OuterColourRecord; outerApp: { id: string; version: string; os: string | null } }
  | { missing: string }

export type ColourSiblingDecision =
  | {
      kind: "decided"
      criterionBranch: "colour-sibling-separation"
      observation: Omit<Observation, "featureId">
      assertion: Omit<ProbeAssertion, "featureId">
      test: ProbeTestInput
    }
  | { kind: "open"; reason: string }

type RegionFrame = ObservationFrame & {
  regionDigest: string
  regionRectangle: { x: number; y: number; width: number; height: number }
}

function regionFrame(observation: Observation | undefined, id: string, step: string): RegionFrame | undefined {
  const frame = observation?.frames?.find((candidate) => candidate.label === `${id}: ${step}`)
  return frame && "regionDigest" in frame && typeof frame.regionDigest === "string" && frame.regionRectangle
    ? (frame as RegionFrame)
    : undefined
}

function sameRectangle(a: RegionFrame["regionRectangle"], b: RegionFrame["regionRectangle"]): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
}

/**
 * Decide a Screen truecolour row from a same-channel sibling, after every row of the run exists.
 * Returns undefined when the row is not this branch's case (another subject, another row, or the
 * row's own seed, target and expected frames are not equal), so its own verdict stands untouched.
 * Returns `open` with the missing condition named when the frames are flat but the proof is not
 * complete: the row then stays open with that reason. Decides unsupported only when all hold:
 *   1. this row's seed, target and expected region hashes are equal (its own stability control);
 *   2. the same-channel sibling, same run, same rectangle and capture kind, has seed != target;
 *   3. the default-colour assumption is declared with the harness profile it rests on;
 *   4. the placed outer record matches the run's outer app on exact id, version and platform and
 *      reads supported for this row.
 */
export function colourSiblingSeparation(input: {
  featureId: string
  mux: "tmux" | "screen" | undefined
  runId: string
  observations: readonly Observation[]
  outer: OuterColourControl
  harnessProfile: string
  muxConfig: string
}): ColourSiblingDecision | undefined {
  const { featureId: id } = input
  const declared = SIBLING_SEPARATION[id]
  const row = COLOUR_ROWS[id]
  if (input.mux !== "screen" || declared === undefined || row === undefined) return undefined
  const own = input.observations.find((observation) => observation.featureId === id)
  const seed = regionFrame(own, id, COLOUR_FRAME_STEPS.seed)
  const target = regionFrame(own, id, COLOUR_FRAME_STEPS.target)
  const expected = regionFrame(own, id, COLOUR_FRAME_STEPS.expected)
  const ignored = regionFrame(own, id, COLOUR_FRAME_STEPS.ignored)
  if (!own || !seed || !target || !expected || !ignored) return undefined
  if (seed.regionDigest !== target.regionDigest || seed.regionDigest !== expected.regionDigest) return undefined
  const open = (reason: string): ColourSiblingDecision => ({
    kind: "open",
    reason: `${id}: no colour-sibling-separation decision: ${reason}`,
  })
  const rectangle = seed.regionRectangle
  if (![target, expected, ignored].every((frame) => sameRectangle(frame.regionRectangle, rectangle))) {
    return open("this row's cited frames were cropped from different rectangles")
  }
  const siblingId = declared.siblingRowId
  const siblingObservation = input.observations.find((observation) => observation.featureId === siblingId)
  const siblingSeed = regionFrame(siblingObservation, siblingId, COLOUR_FRAME_STEPS.seed)
  const siblingTarget = regionFrame(siblingObservation, siblingId, COLOUR_FRAME_STEPS.target)
  if (!siblingObservation || !siblingSeed || !siblingTarget) {
    return open(`sibling ${siblingId} has no seed and target region frames in run ${input.runId}`)
  }
  if (
    siblingObservation.assertionType !== own.assertionType ||
    (siblingSeed.kind ?? "pixels") !== (seed.kind ?? "pixels") ||
    (siblingTarget.kind ?? "pixels") !== (seed.kind ?? "pixels")
  ) {
    return open(`sibling ${siblingId} was captured by a different method`)
  }
  if (
    !sameRectangle(siblingSeed.regionRectangle, rectangle) ||
    !sameRectangle(siblingTarget.regionRectangle, rectangle)
  ) {
    return open(`sibling ${siblingId} was cropped from a different rectangle`)
  }
  if (siblingSeed.regionDigest === siblingTarget.regionDigest) {
    return open(
      `sibling ${siblingId}'s seed and target hashes are equal, so this capture showed no colour in the rectangle`,
    )
  }
  if ("missing" in input.outer) return open(`no outer-terminal control: ${input.outer.missing}`)
  const { record, outerApp } = input.outer
  if (record.id !== outerApp.id || record.version !== outerApp.version || record.os !== outerApp.os) {
    return open(
      `the placed outer record ${record.recordPath} names ${record.id} ${record.version} ${record.os}, not this run's outer terminal ${outerApp.id} ${outerApp.version} ${outerApp.os ?? "(no platform)"}`,
    )
  }
  const outerStatus = record.statuses[id]
  if (outerStatus !== "supported") {
    return open(`the outer terminal's placed record ${record.recordPath} reads ${outerStatus ?? "no result"} for ${id}`)
  }
  const requestedEncoding = sgrParameters(row.sequence)
  const siblingRow = COLOUR_ROWS[siblingId]
  if (siblingRow === undefined) throw new Error(`colour sibling ${siblingId} for ${id} is not a colour row`)
  const witness: ColourSiblingSeparationWitness = {
    kind: "colour-sibling-separation",
    requestedRowId: id,
    requestedEncoding,
    siblingRowId: siblingId,
    siblingEncoding: sgrParameters(siblingRow.sequence),
    channel: declared.channel,
    runId: input.runId,
    rectangle: { ...rectangle },
    requested: {
      seed: seed.regionDigest,
      target: target.regionDigest,
      expected: expected.regionDigest,
      ignored: ignored.regionDigest,
    },
    sibling: { seed: siblingSeed.regionDigest, target: siblingTarget.regionDigest },
    colour: {
      requested: declared.colour,
      assumption: declared.assumption,
      harnessProfile: input.harnessProfile,
      muxConfig: input.muxConfig,
    },
    outerTerminal: {
      id: record.id,
      version: record.version,
      rowId: id,
      status: "supported",
      recordPath: record.recordPath,
      recordRunId: record.recordRunId,
    },
  }
  const reason = `${id}: painted SGR ${requestedEncoding} as the default colour: this row's seed, target and expected frames are equal while sibling ${siblingId} separated in the same rectangle of run ${input.runId}, and the outer terminal ${record.id} ${record.version} reads supported in ${record.recordPath}`
  const { reason: _reason, ...settled } = own
  const { featureId: _featureId, ...observation } = settled
  return {
    kind: "decided",
    criterionBranch: "colour-sibling-separation",
    observation: { ...observation, outcome: "unsupported", note: reason },
    assertion: {
      kind: "negative",
      assertionType: own.assertionType,
      expected: `${id}: the terminal paints SGR ${requestedEncoding} as something other than the default colour`,
      observed: expected.regionDigest,
      note: reason,
      witness,
    },
    test: { id: "criterion", status: "unsupported", reason, assertionRefs: [0] },
  }
}
