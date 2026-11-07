import type {
  CaptureCells,
  ObservationFrame,
  ProbeDefinition,
  ProbeCallbackResult,
  TermProbeSource,
  LibProbeSource,
  ProbeResult,
  ProbeSubject,
} from "./types.ts"
import { frameDigests } from "./types.ts"
import {
  parserStateResult,
  replyFailure,
  reviewResult,
  HEADLESS_OBSERVABLE_REVIEW,
  notTestedResult,
  sameRgb,
  sgrProbe,
  sgrCaptureFrames,
  sgrCaptureTooSmall,
  sgrPlainFixtureTooSmall,
  sgrReadbackDecision,
  type SgrCaptureFixture,
  type SgrReadback,
  probe,
  finalizeProbeResult,
  declaredUntestableResult,
  withUnhandledSgrReport,
} from "./helpers.ts"
import { kittyWait } from "./kitty-capture.ts"
import { captureRegionCallbackResult, cropPositionRefusal } from "./region-readback.ts"
import { RESET_FAMILY_CAPTURE } from "./reset-family-capture.ts"
import { COLOUR_CAPTURE, colourCaptureCallbackResult } from "./sgr-colour-capture.ts"

const requestedUnderlineColor = { r: 255, g: 0, b: 128 }

/**
 * Blink is temporal: retain nine requested offsets and actual capturedAt values. The 3000 ms window
 * covers more than twice the longest measured cycle; acquisition latency can lengthen it.
 * Earlier-return remains the first positive route. Focus-qualified fade also decides support.
 */
const BLINK_SAMPLE_OFFSETS_MS = [0, 375, 750, 1125, 1500, 1875, 2250, 2625, 3000] as const

/** Whether some styled value comes back after a different one (A,B,A in order): a settle only ever goes one way. */
function returnsToEarlierValue(values: readonly string[]): boolean {
  return values.some((value, index) =>
    values
      .slice(index + 1)
      .some((later, offset) => later !== value && values.slice(index + offset + 2).includes(value)),
  )
}

/**
 * Plain row 1 stays fixed beside styled row 3. A return or qualified fade proves blink.
 * Flat pixels need same-row focus, fresh literal input, measured duration and a changed handled
 * repaint on row 2; the subject-aware finalizer keeps mux negatives pending.
 */
async function blinkCapture(ctx: TermProbeSource, fixture: SgrCaptureFixture): Promise<ProbeCallbackResult> {
  const capture = ctx.capture
  if (!capture) throw new Error("sgr.blink: SGR pixel capture requires a capture callback")
  const { sequence, sample, row, col } = fixture
  const styledCells = { top: row, left: col, bottom: row, right: col + sample.length - 1 }
  const plainCells = { top: 1, left: col, bottom: 1, right: col + sample.length - 1 }
  const geometry = ctx.captureGeometry?.geometry
  const shoot = (role: "control" | "target", label: string, cells: CaptureCells) =>
    capture(geometry ? { role, label, cells, pixelGeometry: geometry } : { role, label })
  const screen = (styled: string) =>
    `\x1b[0m\x1b[2J\x1b[1;${String(col)}H${sample}\x1b[${String(row)};${String(col)}H${styled}\x1b[0m\x1b[2;1H`
  ctx.write(screen(sample))
  const control = await shoot("control", "Unstyled text sample", styledCells)
  const controlPlain = geometry ? await shoot("control", "Plain line, control", plainCells) : undefined
  type Focus = Awaited<ReturnType<NonNullable<NonNullable<TermProbeSource["input"]>["focusRoundTrip"]>>>
  let focusBefore: Focus | undefined
  let focusAfter: Focus | undefined
  let focusError: string | undefined
  let inputError: string | undefined
  let keyAt: number | undefined
  let keyRead: string | undefined
  if (ctx.input?.focusRoundTrip) {
    try {
      focusBefore = await ctx.input.focusRoundTrip()
    } catch (error) {
      focusError = String(error)
    }
  }
  const input = ctx.input
  if (input && ctx.readInput) {
    try {
      keyRead = (
        await ctx.readInput(/^a$/, 1000, async () => {
          await input.injectKey("a")
          keyAt = Date.now()
        })
      )?.[0]
    } catch (error) {
      inputError = String(error)
    }
  }
  ctx.write(screen(sequence + sample))
  const paintCells = { top: 2, left: col, bottom: 2, right: col + sample.length - 1 }
  const paintBefore =
    geometry && focusBefore ? await shoot("control", "Third-region repaint baseline", paintCells) : undefined
  const samples: Array<{
    offsetMs: number
    invokedMs: number
    styled: ObservationFrame
    plain?: ObservationFrame
  }> = []
  const start = Date.now()
  for (const offsetMs of BLINK_SAMPLE_OFFSETS_MS) {
    const wait = start + offsetMs - Date.now()
    if (wait > 0) await kittyWait(wait)
    const invokedMs = Date.now() - start
    const styled = await shoot(
      "target",
      `sgr.blink styled text, sample requested at +${String(offsetMs)} ms`,
      styledCells,
    )
    const plain = geometry
      ? await shoot("control", `Plain line, sample requested at +${String(offsetMs)} ms`, plainCells)
      : undefined
    samples.push({ offsetMs, invokedMs, styled, ...(plain ? { plain } : {}) })
  }
  if (ctx.input?.focusRoundTrip) {
    try {
      focusAfter = await ctx.input.focusRoundTrip()
    } catch (error) {
      focusError = String(error)
    }
  }
  const focusQualified =
    !!focusBefore &&
    !!focusAfter &&
    focusBefore.ownedWindowId.length > 0 &&
    focusBefore.rootWindowId.length > 0 &&
    focusBefore.ownedWindowId === focusAfter.ownedWindowId &&
    focusBefore.rootWindowId === focusAfter.rootWindowId &&
    [focusBefore, focusAfter].every(
      (reading) =>
        reading.focusedWindowIds[0] === reading.ownedWindowId &&
        reading.focusedWindowIds[1] === reading.rootWindowId &&
        reading.focusedWindowIds[2] === reading.ownedWindowId,
    )
  const styledFrames = samples.map((entry) => entry.styled)
  const plainFrames = [
    ...(controlPlain ? [controlPlain] : []),
    ...samples.flatMap((entry) => (entry.plain ? [entry.plain] : [])),
  ]
  const frames = [control, ...styledFrames, ...plainFrames, ...(paintBefore ? [paintBefore] : [])]
  const timing = samples.map(({ offsetMs, invokedMs, styled, plain }) => ({
    requestedOffsetMs: offsetMs,
    invokedMs,
    styledCapturedAt: styled.capturedAt,
    ...(plain ? { plainCapturedAt: plain.capturedAt } : {}),
  }))
  // An undecided digest comparison leaves the retained frames for review, under the same named rows the
  // pair path uses; a result with no rows is recorded as a test failure (#31812 first-line review).
  const inconclusive = (note: string, observed: string): ProbeCallbackResult => ({
    pass: false,
    response: observed,
    criterionBranch: "visual-review",
    tests: [
      { id: "capture", status: "supported", assertionRefs: [0] },
      { id: "review", status: "probe-todo", reason: note },
    ],
    observation: {
      outcome: "inconclusive",
      reason: "insufficient-evidence",
      assertionType: "screenshot",
      screenshotRef: styledFrames[0]?.ref,
      frames,
      note,
    },
    assertions: [{ assertionType: "screenshot" as const, kind: "positive", expected: note, observed }],
  })
  if (!geometry) {
    const observed = JSON.stringify({
      sample,
      startRow: row,
      startCol: col,
      timing,
      frames: frames.map((f) => f.label),
    })
    return {
      pass: false,
      response: observed,
      criterionBranch: "visual-review",
      tests: [
        { id: "capture", status: "supported", assertionRefs: [0] },
        {
          id: "review",
          status: "probe-todo",
          reason: "Valid control and nine blink samples; no same-run pixel check decides it",
        },
      ],
      assertions: [
        {
          assertionType: "screenshot" as const,
          kind: "positive",
          expected:
            "The styled text changes and then comes back to an earlier look across the nine samples, while the plain line holds still in the control and every sample",
          observed: JSON.stringify({ control, samples }),
        },
      ],
      observation: {
        outcome: "inconclusive",
        reason: "insufficient-evidence",
        assertionType: "screenshot",
        screenshotRef: styledFrames[0]?.ref,
        frames,
        note: "No measured raster, so the samples cannot be compared by region digest; no same-run pixel check decides the blink",
      },
    }
  }
  const controlDigest = frameDigests(control).cells
  const styled = styledFrames.map((frame) => frameDigests(frame).cells)
  const plain = plainFrames.map((frame) => frameDigests(frame).cells)
  const observed = JSON.stringify({
    sample,
    startRow: row,
    startCol: col,
    timing,
    control: controlDigest,
    styled,
    plain,
    focus: { before: focusBefore, after: focusAfter, error: focusError },
    input: { keyRead, keyAt, error: inputError },
  })
  if (
    [controlDigest, ...styled, ...plain].some((digest) => digest === undefined) ||
    plain.length !== styled.length + 1
  ) {
    return inconclusive(
      "Blink needs one cell-aligned digest of the text and of the plain line in the control and in every sample",
      observed,
    )
  }
  for (const set of [[control, ...styledFrames], plainFrames]) {
    const refusal = cropPositionRefusal({
      id: "sgr.blink",
      compared: set.map((frame) => ({
        role: frame.label,
        rectangle: frame.kind === "text-cells" ? undefined : frame.regionRectangle,
      })),
      response: observed,
      frames,
      screenshotRef: styledFrames[0]?.ref,
    })
    if (refusal) return refusal
  }
  if (new Set(plain).size > 1) {
    return inconclusive(
      "The plain line moved across the control and the samples, so a styled-text change could be redraw, scroll or cursor motion rather than blink",
      observed,
    )
  }
  const styledDigests = styled.filter((digest): digest is string => digest !== undefined)
  const earlierReturn = returnsToEarlierValue(styledDigests)
  const fade = new Set(styledDigests).size >= 3 && styledDigests.at(-1) !== styledDigests.at(-2)
  if (earlierReturn || (fade && focusQualified)) {
    return {
      pass: true,
      response: observed,
      observation: {
        outcome: "supported",
        assertionType: "screenshot",
        screenshotRef: styledFrames[0]?.ref,
        frames,
        note: earlierReturn
          ? "With no write between samples, the styled text's region digest changed and then came back to an earlier value, while the plain line held still in the control and every sample"
          : "With focus read before and after, the styled region has at least three distinct values and its last two samples differ, while every plain digest holds still",
      },
      assertions: [
        {
          assertionType: "screenshot" as const,
          kind: "positive",
          expected: earlierReturn
            ? "Nine SGR 5 samples requested every 375 ms from +0 to +3000 ms with no write between: a styled digest comes back after a different one, with every plain digest identical"
            : "With focus read before and after, at least three distinct styled values with a differing final pair and every plain digest identical",
          observed,
        },
      ],
    }
  }
  if (fade && !focusQualified) {
    return inconclusive(
      "Fade needs qualified focus read before and after sampling" + (focusError ? `: ${focusError}` : ""),
      observed,
    )
  }
  if (new Set(styledDigests).size > 1) {
    return inconclusive(
      "The styled text changed one way and then held still; a first sample caught before the fixture finished painting looks the same, so a one-way change is not blink evidence",
      observed,
    )
  }
  const firstCapturedAt = timing[0]?.styledCapturedAt
  const lastCapturedAt = timing.at(-1)?.styledCapturedAt
  if (firstCapturedAt === undefined || lastCapturedAt === undefined) {
    return inconclusive("Missing styled capture timestamp", observed)
  }
  const spanMs = lastCapturedAt - firstCapturedAt
  const keyAgeMs = keyAt === undefined ? undefined : lastCapturedAt - keyAt
  const missing = [
    !focusQualified ? `focus read before and after sampling${focusError ? `: ${focusError}` : ""}` : undefined,
    keyRead !== "a" || keyAt === undefined
      ? `row-local literal a injection and readback${inputError ? `: ${inputError}` : ""}`
      : undefined,
    keyAgeMs === undefined || !Number.isFinite(keyAgeMs) || keyAgeMs < 0 || keyAgeMs >= 15000
      ? `input age under 15000 ms at last styled capture (measured ${String(keyAgeMs)} ms)`
      : undefined,
    !Number.isFinite(spanMs) || spanMs < 3000
      ? `actual styled capturedAt span at least 3000 ms (measured ${String(spanMs)} ms)`
      : undefined,
  ].find((reason) => reason !== undefined)
  if (missing) return inconclusive(`Nine equal samples do not establish a blink period; missing ${missing}`, observed)
  ctx.write(`\x1b[0m\x1b[2;${String(col)}H${sample}\x1b[2;1H`)
  const paintAfter = await shoot("target", "Third-region handled repaint after blink samples", paintCells)
  frames.push(paintAfter)
  const paintObserved = JSON.stringify({
    samples: JSON.parse(observed),
    spanMs,
    keyAgeMs,
    repaint: { before: paintBefore, after: paintAfter },
  })
  const paintRefusal = cropPositionRefusal({
    id: "sgr.blink",
    compared: [paintBefore, paintAfter].map((frame) => ({
      role: frame?.label ?? "missing repaint baseline",
      rectangle: frame?.kind === "text-cells" ? undefined : frame?.regionRectangle,
    })),
    response: paintObserved,
    frames,
    screenshotRef: styledFrames[0]?.ref,
  })
  if (paintRefusal) return paintRefusal
  const beforeDigest = paintBefore && frameDigests(paintBefore).cells
  const afterDigest = frameDigests(paintAfter).cells
  if (
    beforeDigest === undefined ||
    afterDigest === undefined ||
    beforeDigest === afterDigest ||
    paintAfter.capturedAt < lastCapturedAt
  ) {
    return inconclusive(
      "Capture blind: post-sampling third-region write did not produce a qualified repaint",
      paintObserved,
    )
  }
  const note = `Nine equal styled samples across measured ${String(spanMs)} ms with focus, row-local input age ${String(keyAgeMs)} ms and a post-sampling handled repaint; no blink in this window. A period slower than 3000 ms remains outside this bound.`
  return {
    pass: false,
    response: paintObserved,
    criterionBranch: "sgr-blink-flat",
    tests: [
      { id: "capture", status: "supported", assertionRefs: [0] },
      { id: "blink", status: "unsupported", reason: note, assertionRefs: [1] },
    ],
    observation: {
      outcome: "unsupported",
      assertionType: "screenshot",
      screenshotRef: styledFrames[0]?.ref,
      frames,
      note,
    },
    assertions: [
      {
        assertionType: "screenshot",
        kind: "positive",
        expected: "Same-row focus, literal a readback, capturedAt window and changed third-region repaint",
        observed: paintObserved,
      },
      { assertionType: "screenshot", kind: "negative", expected: note, observed: paintObserved },
    ],
  }
}

/**
 * An adapter that does not populate `underlineColor` reports null on every cell, so a cell fed an
 * explicit SGR 58 color that reads back none has no observable for the claim (a coverage record,
 * PROBE TODO), never a negative (#30701, @cto ruling C: PROBE TODO only where the cell field is missing).
 */
const UNDERLINE_COLOR_UNEXPOSED =
  "Open: we set an underline colour (SGR 58), but the screen cell shows none, so we cannot tell whether the library ignored it or does not report it."

const UNDERLINE_COLOR_UNKNOWN_REASON =
  "SGR 58 behaved exactly like an unknown number: the numbers after it ran as their own commands"

/**
 * Where the colour field is missing, read SGR 58 against the made-up SGR 77 with the same operands in the same
 * run (@cto routes-32 section 1, 23:02 PST Nov 5 2026; replaces #30701 ruling C for this case). A library that
 * does not know 58 runs its operands as their own commands, exactly as it does for 77. Equal cells with at least
 * one attribute set read Unsupported; anything else returns undefined and the caller keeps today's Open.
 */
function underlineColorUnknownArm(
  ctx: LibProbeSource,
  operands: string,
  expected: string,
  state: object,
): ProbeCallbackResult | undefined {
  ctx.feed(`\x1b[0m\x1b[3;1H\x1b[58;${operands}mX\x1b[0m\x1b[77;${operands}mY\x1b[0m`)
  const target = ctx.getCell(2, 0)
  const control = ctx.getCell(2, 1)
  if (target.char !== "X" || control.char !== "Y") return undefined
  const attrs = (cell: typeof target) => ({
    bold: cell.bold === true,
    dim: cell.dim === true,
    italic: cell.italic === true,
    underline: cell.underline === true,
    blink: cell.blink === true,
    underlineColor: cell.underlineColor ?? null,
  })
  const t = attrs(target)
  const c = attrs(control)
  const equal = JSON.stringify(t) === JSON.stringify(c)
  const anySet = t.bold || t.dim || t.italic || t.underline || t.blink
  if (!equal || !anySet) return undefined
  return parserStateResult(
    false,
    expected,
    { ...state, unknownControl: { target: `58;${operands}`, control: `77;${operands}`, equal, attrs: t } },
    UNDERLINE_COLOR_UNKNOWN_REASON,
  )
}

const LIBVTERM_RESET_NO_SETUP =
  "Untestable (no setup): SGR 58 does not work on this library, so this command has nothing to act on."

/**
 * Keep DECRQSS for state-only claims. Registered colour/reset visual claims use their owned pixel
 * oracle when available, retaining the valid state report in the note. Silence keeps the fallback.
 */
export function sgrTermReadback(
  id: string,
  sequence: string,
  readback: SgrReadback,
  fallback: (ctx: TermProbeSource) => ProbeCallbackResult | Promise<ProbeCallbackResult>,
  setup?: Parameters<typeof sgrReadbackDecision>[4],
): (ctx: TermProbeSource) => Promise<ProbeCallbackResult> {
  return async (ctx) => {
    // The capture fixture guard refuses before any bytes on a measured small terminal, so the
    // readback must not emit its own sequences ahead of it.
    if (ctx.capture) {
      const refusal = sgrCaptureTooSmall(ctx, "SGR fixture")
      if (refusal) return refusal
    }
    const region = RESET_FAMILY_CAPTURE[id]
    const colour = COLOUR_CAPTURE[id]
    const referenceFirst =
      ctx.capture &&
      ctx.captureKind !== "text-cells" &&
      (region?.savedRendition?.branch === "sgr-reset-saved-rendition" ||
        region?.savedRendition?.branch === "sgr-selective-reset-saved-rendition")
    let referenceFailure: ProbeCallbackResult | undefined
    if (referenceFirst && region) {
      const captured = await captureRegionCallbackResult(ctx, id, region)
      if (captured && captured.criterionBranch !== "saved-rendition-unqualified") return captured
      referenceFailure = captured ?? undefined
    }
    const retainReference = (result: ProbeCallbackResult): ProbeCallbackResult => {
      if (!referenceFailure) return result
      const note = referenceFailure.tests?.[0]?.reason
      const response = JSON.stringify({ reference: referenceFailure.response, decrqss: result.response })
      if (result.observation) {
        return {
          ...result,
          response,
          observation: { ...result.observation, note: [note, result.observation.note].filter(Boolean).join("; ") },
        }
      }
      if (result.notTested) {
        return {
          ...result,
          response,
          tests: result.tests?.map((test) => ({ ...test, reason: [note, test.reason].filter(Boolean).join("; ") })),
        }
      }
      const [first, ...rest] = result.tests
      return {
        ...result,
        response,
        tests: [
          { ...first, reason: [note, first.reason].filter(Boolean).join("; ") },
          ...rest.map((test) => ({ ...test, reason: [note, test.reason].filter(Boolean).join("; ") })),
        ],
      }
    }
    const captureResult = async () => {
      // DECRQSS already wrote/queried, so any refusal retains that attempted evidence path.
      if (region) {
        const { savedRendition: _savedRendition, ...queryFallback } = region
        const verdict = await captureRegionCallbackResult(ctx, id, referenceFirst ? queryFallback : region, true)
        if (verdict) return retainReference(verdict)
      }
      if (colour) {
        const verdict = await captureRegionCallbackResult(ctx, id, colour, true)
        if (verdict) return colourCaptureCallbackResult(id, verdict)
      }
      return fallback(ctx)
    }
    // The setup branch keeps its existing independent-reference eligibility.
    const independentCapture =
      ctx.capture && (region || colour) && (!setup || (region && !region.noIndependentReference))
        ? captureResult
        : undefined
    const decided = await sgrReadbackDecision(ctx, id, sequence, readback, setup, independentCapture)
    if (decided) return retainReference(decided)
    return captureResult()
  }
}

/** A cursor reply proves consumption of the SGR sequence, never the visual attribute. */
async function consumedSgr(
  ctx: TermProbeSource,
  id: string,
  sequence: string,
  controlLabel = `${id} control`,
): Promise<ProbeCallbackResult> {
  if (ctx.capture) {
    const refusal = sgrCaptureTooSmall(ctx, id)
    if (refusal) return refusal
    const sample = "AaBb 0123456789 - terminal text"
    try {
      return await sgrCaptureFrames(
        ctx,
        "\x1b[0m\x1b[2J\x1b[3;3H" + sample,
        "\x1b[0m\x1b[2J\x1b[3;3H" + sequence + sample,
        id,
        { sample, startRow: 3, startCol: 3, sampleCells: sample.length },
        undefined,
        controlLabel,
      )
    } finally {
      ctx.write("\x1b[0m")
    }
  }
  try {
    ctx.write("\x1b[1;1H\x1b[2K")
    ctx.write(sequence + "X")
    const pos = await ctx.queryCursorPosition()
    if (!pos) {
      return replyFailure(
        "no parsable cursor position reply; the public projection returned null and retained no bytes",
      )
    }
    return {
      pass: false,
      note: "Cursor advance does not verify SGR styling",
      response: `${pos.row};${pos.col}`,
      tests: [
        {
          id: "criterion",
          status: pos.row === 1 && pos.col === 2 ? "probe-todo" : "probe-invalid",
          reason: `Cursor advance does not verify SGR styling${pos.row === 1 && pos.col === 2 && ctx.captureGeometryRefusal ? `; Pixel capture unavailable: ${ctx.captureGeometryRefusal}` : ""}`,
        },
      ],
    }
  } finally {
    ctx.write("\x1b[0m")
  }
}

/**
 * Capture check for a reset sequence (SGR 39/49/59). The control renders the same XXYY run under
 * `controlPrefix` (empty for a plain default-color comparison, SGR 4 for an underlined default);
 * the target renders the setup value on XX and the reset on YY, so an ignored reset cannot look
 * identical to a supported one. Consumption alone never proves the visual reset.
 */
async function consumedSgrReset(
  ctx: TermProbeSource,
  id: string,
  setup: string,
  reset: string,
  controlPrefix = "",
): Promise<ProbeCallbackResult> {
  if (ctx.capture) {
    const refusal = sgrCaptureTooSmall(ctx, id)
    if (refusal) return refusal
    // A reset-family row never reaches this fallback: the DECRQSS readback path in
    // sgrTermReadback asks the same-run region oracle first and returns its verdict.
    try {
      return await sgrCaptureFrames(
        ctx,
        `\x1b[0m\x1b[2J\x1b[3;3H${controlPrefix}XXYY`,
        `\x1b[0m\x1b[2J\x1b[3;3H${setup}XX${reset}YY`,
        id,
        { startRow: 3, startCol: 3, setupCells: 2, resetCells: 2, controlPrefix },
        "XX carries the setup value and YY carries the reset; compare each against the control run before grading the reset",
      )
    } finally {
      ctx.write("\x1b[0m")
    }
  }
  try {
    ctx.write("\x1b[1;1H\x1b[2K")
    ctx.write(setup + "X" + reset + "Y")
    const pos = await ctx.queryCursorPosition()
    if (!pos) {
      return replyFailure(
        "no parsable cursor position reply; the public projection returned null and retained no bytes",
      )
    }
    return {
      pass: false,
      note: "Cursor advance does not verify the reset rendered",
      response: `${pos.row};${pos.col}`,
      tests: [
        {
          id: "criterion",
          status: pos.row === 1 && pos.col === 3 ? "probe-todo" : "probe-invalid",
          reason: `Cursor advance does not verify the reset rendered${pos.row === 1 && pos.col === 3 && ctx.captureGeometryRefusal ? `; Pixel capture unavailable: ${ctx.captureGeometryRefusal}` : ""}`,
        },
      ],
    }
  } finally {
    ctx.write("\x1b[0m")
  }
}

function rgbUnderlineProbe(id: string): ProbeDefinition {
  const sequence = "\x1b[4m\x1b[58;2;255;0;128m"
  // DECRQSS must report the requested RGB, not merely SGR 58; the termless path independently
  // calibrates the exact color against default-color controls.
  const readback: SgrReadback = { require: [4, 58], requireTokens: ["58:2:255:0:128"] }
  const armed = sgrTermReadback(id, sequence, readback, (ctx) => consumedSgr(ctx, id, sequence, "Unstyled text sample"))
  return {
    ...probe(
      id,
      (ctx) => {
        // Two default-color controls distinguish an exposed, foreground-following
        // underline from a backend that simply ignores SGR 58.
        ctx.feed("\x1b[4m\x1b[59m\x1b[38;2;0;0;255mA\x1b[38;2;0;255;0mB\x1b[58;2;255;0;128mX")
        const blueControl = ctx.getCell(0, 0)
        const greenControl = ctx.getCell(0, 1)
        const target = ctx.getCell(0, 2)
        const state = { blueControl, greenControl, target }
        const expected = `${id}: X has explicit rgb(255,0,128) underline distinct from the reset/default B cell`
        const framed = blueControl.char === "A" && greenControl.char === "B" && target.char === "X"
        if (framed && target.underlineColor == null) {
          return (
            underlineColorUnknownArm(ctx, "2;1;2;3", expected, state) ??
            notTestedResult(UNDERLINE_COLOR_UNEXPOSED, state)
          )
        }
        if (
          blueControl.char !== "A" ||
          greenControl.char !== "B" ||
          target.char !== "X" ||
          !blueControl.underline ||
          !greenControl.underline ||
          !target.underline ||
          target.underlineColor == null
        ) {
          return parserStateResult(null, expected, state, "Underlined control, target, or target color was not exposed")
        }
        if (greenControl.underlineColor && sameRgb(greenControl.underlineColor, requestedUnderlineColor)) {
          return parserStateResult(null, expected, state, "Default underline already matches the requested color")
        }
        if (sameRgb(target.underlineColor, requestedUnderlineColor)) return parserStateResult(true, expected, state)
        if (
          blueControl.fg &&
          greenControl.fg &&
          !sameRgb(blueControl.fg, greenControl.fg) &&
          blueControl.underlineColor &&
          greenControl.underlineColor &&
          !sameRgb(blueControl.underlineColor, greenControl.underlineColor)
        ) {
          return parserStateResult(false, expected, state)
        }
        return parserStateResult(null, expected, state, "Underline color readback was not calibrated for a negative")
      },
      async (ctx) => {
        // The readback writes the sequence before it answers, so the fixture's own geometry refusal
        // has to run ahead of it — a 1x2 terminal must refuse with a zero-byte trace.
        const refusal = sgrPlainFixtureTooSmall(ctx)
        return refusal ?? (await armed(ctx))
      },
      // Unchanged from the sgrProbe this replaced: an exception in this arm is recorded as query
      // evidence, because the arm asks DECRQSS before any capture falls back.
      "query_reply",
    ),
    termNeedsGeometry: true,
    libAssertionType: "buffer_state",
  }
}

type ResetAttribute = "bold" | "dim" | "italic" | "underline" | "inverse"
type ResetCell = ReturnType<LibProbeSource["getCell"]>

/** DECRQSS parameter code reported while each resettable attribute is active. */
const RESET_ATTRIBUTE_CODE: Record<ResetAttribute, number> = { bold: 1, dim: 2, italic: 3, underline: 4, inverse: 7 }

function measuredAttribute(cell: ResetCell, attribute: ResetAttribute): boolean | null {
  const value: unknown = cell[attribute]
  if (value === undefined) return null
  if (attribute === "underline") return value !== false && value !== null && value !== "none"
  return typeof value === "boolean" ? value : null
}

function measuredReset(
  ctx: LibProbeSource,
  id: string,
  setup: string,
  reset: string,
  set: readonly ResetAttribute[],
  preserve: readonly ResetAttribute[],
  // "any": one shown preserved attribute is enough witness. The bold cell uses it because SGR 22
  // keeps underline on an engine that exposes neither dim nor italic (criterion C16, routes-48).
  preserveMode: "all" | "any" = "all",
): ProbeCallbackResult {
  ctx.feed(`C${setup}X${reset}Y`)
  const baseline = ctx.getCell(0, 0)
  const before = ctx.getCell(0, 1)
  const after = ctx.getCell(0, 2)
  const state = { baseline, before, after }
  const expected = `${id}: measured setup attributes clear on Y and unrelated attributes remain set`
  if (baseline.char !== "C" || before.char !== "X" || after.char !== "Y") {
    return parserStateResult(null, expected, state, "Baseline, styled, or reset cell was not exposed")
  }
  const attributes = [...new Set([...set, ...preserve])]
  // The claim is over the MEASURED setup attributes (#30701, @cto ruling C): an attribute the styled
  // setup does not show (a field the adapter never populates, or an intensity the backend keeps
  // exclusive) is left out of the grade. A measured miss is a negative; with no shown set attribute or
  // an unshown preserved one, the claim has no observable (a coverage record, PROBE TODO).
  const shown = (attribute: ResetAttribute) => measuredAttribute(before, attribute) === true
  const graded = attributes.filter(shown)
  if (
    graded.some((attribute) => measuredAttribute(baseline, attribute) !== false) ||
    graded.some((attribute) => measuredAttribute(after, attribute) === null)
  ) {
    return parserStateResult(null, expected, state, "Neutral baseline or reset readback was not measured")
  }
  const unshown = attributes.filter((attribute) => !shown(attribute))
  const cleared = set.filter(shown).every((attribute) => measuredAttribute(after, attribute) === false)
  const shownPreserve = preserve.filter(shown)
  const retained = shownPreserve.every((attribute) => measuredAttribute(after, attribute) === true)
  const preserveObserved = preserveMode === "any" ? shownPreserve.length > 0 : preserve.every(shown)
  if (cleared && retained && (!set.some(shown) || !preserveObserved)) {
    return notTestedResult(
      `Open: ${unshown.join(" and ")} did not show during setup, so our test cannot check the combined reset.`,
      state,
    )
  }
  return parserStateResult(
    cleared && retained,
    expected,
    state,
    unshown.length > 0
      ? `Graded on the measured setup; ${unshown.join(" and ")} not shown by the styled setup`
      : undefined,
  )
}

async function consumedResetSgr(
  ctx: TermProbeSource,
  id: string,
  setup: string,
  reset: string,
): Promise<ProbeCallbackResult> {
  if (ctx.capture) {
    const refusal = sgrCaptureTooSmall(ctx, id)
    if (refusal) return refusal
    // A reset-family row never reaches this fallback: the DECRQSS readback path in
    // sgrTermReadback asks the same-run region oracle first and returns its verdict.
    try {
      return await sgrCaptureFrames(
        ctx,
        "\x1b[0m\x1b[2J\x1b[3;3H" + setup + "X",
        "\x1b[0m\x1b[2J\x1b[3;3H" + setup + "X" + reset + "Y",
        id,
        { setup, reset },
        "The control shows the styled X without the reset; the target adds the reset Y; the capture alone does not decide the reset effect",
      )
    } finally {
      ctx.write("\x1b[0m")
    }
  }
  try {
    ctx.write("\x1b[1;1H\x1b[2K")
    ctx.write(`${setup}X${reset}Y`)
    const pos = await ctx.queryCursorPosition()
    if (!pos) {
      return replyFailure(
        "no parsable cursor position reply; the public projection returned null and retained no bytes",
      )
    }
    const advanced = pos.row === 1 && pos.col === 3
    return {
      pass: false,
      response: `${pos.row};${pos.col}`,
      tests: [
        {
          id: "criterion",
          status: advanced ? "probe-todo" : "probe-invalid",
          reason: advanced
            ? `Cursor advance does not verify SGR reset${ctx.captureGeometryRefusal ? `; Pixel capture unavailable: ${ctx.captureGeometryRefusal}` : ""}`
            : "Cursor did not reach the expected position",
        },
      ],
    }
  } finally {
    ctx.write("\x1b[0m")
  }
}

function resetProbe(
  id: string,
  setup: string,
  reset: string,
  set: readonly ResetAttribute[],
  preserve: readonly ResetAttribute[] = [],
  // A library-only shape: the app readback keeps the shared setup, because its DECRQSS criterion
  // names those exact parameters.
  libArm?: {
    readonly setup: string
    readonly preserve: readonly ResetAttribute[]
    readonly preserveMode?: "all" | "any"
  },
): ProbeDefinition {
  return {
    ...probe(
      id,
      (ctx) =>
        libArm
          ? measuredReset(ctx, id, libArm.setup, reset, set, libArm.preserve, libArm.preserveMode ?? "all")
          : measuredReset(ctx, id, setup, reset, set, preserve),
      sgrTermReadback(
        id,
        reset,
        {
          require: preserve.map((attribute) => RESET_ATTRIBUTE_CODE[attribute]),
          forbid: set.map((attribute) => RESET_ATTRIBUTE_CODE[attribute]),
        },
        (ctx) => consumedResetSgr(ctx, id, setup, reset),
        {
          sequence: setup,
          baseline: { require: [], forbid: [...set, ...preserve].map((attribute) => RESET_ATTRIBUTE_CODE[attribute]) },
          readback: { require: [...set, ...preserve].map((attribute) => RESET_ATTRIBUTE_CODE[attribute]) },
        },
      ),
      null,
    ),
    termNeedsGeometry: true,
    libAssertionType: "buffer_state",
  }
}

type ColorChannel = "fg" | "bg"
type Color = NonNullable<ResetCell["fg"]>

function sameCellColor(a: Color | null | undefined, b: Color | null | undefined): boolean {
  if (a === undefined || b === undefined) return false
  if (a === null || b === null) return a === b
  return sameRgb(a, b)
}

function namedColorProbe(id: string, channel: ColorChannel, firstCode: number, secondCode: number): ProbeDefinition {
  const first = `\x1b[${firstCode}m`
  const second = `\x1b[${secondCode}m`
  return {
    ...probe(
      id,
      (ctx) => {
        const targetInput = `C${first}X${second}Y`
        ctx.feed(targetInput)
        const baseline = ctx.getCell(0, 0)
        const firstCell = ctx.getCell(0, 1)
        const secondCell = ctx.getCell(0, 2)
        const bright = id.endsWith(".bright")
        const controlInput = `\x1b[0m\x1b[${channel === "fg" ? 31 : 41}mR\x1b[0m`
        if (bright) ctx.feed(controlInput)
        const control = bright ? ctx.getCell(0, 3) : undefined
        const state = {
          baseline,
          first: firstCell,
          second: secondCell,
          ...(control ? { control, input: { target: targetInput, control: controlInput } } : {}),
        }
        const expected = `${id}: the two named colors select distinct exposed ${channel} RGB values`
        if (baseline.char !== "C" || firstCell.char !== "X" || secondCell.char !== "Y") {
          return parserStateResult(null, expected, state, "Neutral control or named-color cells were not exposed")
        }
        const neutral = baseline[channel]
        const a = firstCell[channel]
        const b = secondCell[channel]
        // An undefined neutral is the default reported as absent, which already differs from an
        // exposed RGB value (#30701, @cto ruling C).
        if (a && b && !sameCellColor(neutral, a) && !sameRgb(a, b)) {
          return parserStateResult(true, expected, state)
        }
        // Both named colors left the cell at an exposed default: the backend ignored them. A neutral
        // and two targets that all read no color show nothing about the color field, so that is a
        // coverage record, as in the truecolor and default-color arms (#30701, @cto cd391424).
        if (neutral && sameCellColor(neutral, a) && sameCellColor(neutral, b)) {
          return parserStateResult(false, expected, state)
        }
        if (
          control?.char === "R" &&
          control[channel] &&
          !sameCellColor(neutral, control[channel]) &&
          sameCellColor(neutral, a) &&
          sameCellColor(neutral, b)
        ) {
          return parserStateResult(false, expected, state)
        }
        if (!neutral && !a && !b) {
          return parserStateResult(
            null,
            expected,
            state,
            undefined,
            `the ${channel} color field in the headless readback (neutral, SGR ${firstCode} and SGR ${secondCode} cells all read no color)`,
          )
        }
        return parserStateResult(
          null,
          expected,
          state,
          "Baseline, theme colors, or color readback were indistinguishable",
        )
      },
      sgrTermReadback(id, first, { require: [firstCode] }, (ctx) => consumedSgr(ctx, id, first)),
      null,
    ),
    termNeedsGeometry: true,
    libAssertionType: "buffer_state",
  }
}

function indexedColorProbe(id: string, channel: ColorChannel): ProbeDefinition {
  const sgr = channel === "fg" ? 38 : 48
  const first: Color = { r: 95, g: 135, b: 175 }
  const second: Color = { r: 215, g: 135, b: 95 }
  return {
    ...probe(
      id,
      (ctx) => {
        const targetInput = `C\x1b[${sgr};2;95;135;175mA\x1b[${sgr};2;215;135;95mB\x1b[0m\x1b[${sgr};5;67mX\x1b[${sgr};5;173mY`
        ctx.feed(targetInput)
        const baseline = ctx.getCell(0, 0)
        const directFirst = ctx.getCell(0, 1)
        const directSecond = ctx.getCell(0, 2)
        const indexedFirst = ctx.getCell(0, 3)
        const indexedSecond = ctx.getCell(0, 4)
        const controlInput = `\x1b[0m\x1b[${channel === "fg" ? 31 : 41}mR\x1b[0m`
        ctx.feed(controlInput)
        const control = ctx.getCell(0, 5)
        const state = {
          baseline,
          directFirst,
          directSecond,
          indexedFirst,
          indexedSecond,
          control,
          input: { target: targetInput, control: controlInput },
        }
        const expected = `${id}: indices 67 and 173 match two independently observed canonical RGB cube references`
        if (
          baseline.char !== "C" ||
          directFirst.char !== "A" ||
          directSecond.char !== "B" ||
          indexedFirst.char !== "X" ||
          indexedSecond.char !== "Y"
        ) {
          return parserStateResult(null, expected, state, "Indexed or direct-RGB control cells were not exposed")
        }
        const a = directFirst[channel]
        const b = directSecond[channel]
        const x = indexedFirst[channel]
        const y = indexedSecond[channel]
        if (
          control.char === "R" &&
          control[channel] &&
          !sameCellColor(baseline[channel], control[channel]) &&
          sameCellColor(baseline[channel], x) &&
          sameCellColor(baseline[channel], y)
        ) {
          return parserStateResult(false, expected, state)
        }
        // #30701, @cto ruling C: direct RGB that does not read back its fed value is a reference that
        // cannot be calibrated (PROBE TODO). A calibrated reference the indices miss is a custom indexed
        // palette OR an adapter that does not resolve indices to RGB (wezterm reports an index as
        // {r: index, g: 0, b: 0}; #30703), so it stays inconclusive until an in-probe control shows the
        // adapter resolves indices (@cto cd391424).
        if (!a || !b || !sameRgb(a, first) || !sameRgb(b, second)) {
          return parserStateResult(
            null,
            expected,
            state,
            undefined,
            `direct RGB ${channel} readback matching the fed value (SGR ${sgr};2 reference cells A and B)`,
          )
        }
        if (x && y && sameRgb(x, a) && sameRgb(y, b)) return parserStateResult(true, expected, state)
        return parserStateResult(
          null,
          expected,
          state,
          "Direct RGB references matched; indices 67 and 173 did not resolve to them: a custom indexed palette, or an adapter that does not resolve indices",
        )
      },
      sgrTermReadback(id, `\x1b[${sgr};5;67m`, { require: [sgr], requireTokens: [`${sgr}:5:67`] }, (ctx) =>
        consumedSgr(ctx, id, `\x1b[${sgr};5;67m`),
      ),
      null,
    ),
    termNeedsGeometry: true,
    libAssertionType: "buffer_state",
  }
}

function truecolorProbe(id: string, channel: ColorChannel): ProbeDefinition {
  const sgr = channel === "fg" ? 38 : 48
  const ordinary = channel === "fg" ? [31, 34] : [41, 44]
  const first: Color = channel === "fg" ? { r: 255, g: 128, b: 0 } : { r: 0, g: 255, b: 128 }
  const second: Color = { r: 17, g: 97, b: 201 }
  return {
    ...probe(
      id,
      (ctx) => {
        ctx.feed(
          `C\x1b[${ordinary[0]}mA\x1b[${ordinary[1]}mB\x1b[${sgr};2;${first.r};${first.g};${first.b}mX\x1b[${sgr};2;17;97;201mY`,
        )
        const baseline = ctx.getCell(0, 0)
        const controlFirst = ctx.getCell(0, 1)
        const controlSecond = ctx.getCell(0, 2)
        const targetFirst = ctx.getCell(0, 3)
        const targetSecond = ctx.getCell(0, 4)
        const state = { baseline, controlFirst, controlSecond, targetFirst, targetSecond }
        const expected = `${id}: two distinct direct-RGB samples are exposed at their exact requested values`
        if (
          baseline.char !== "C" ||
          controlFirst.char !== "A" ||
          controlSecond.char !== "B" ||
          targetFirst.char !== "X" ||
          targetSecond.char !== "Y"
        ) {
          return parserStateResult(
            null,
            expected,
            state,
            "RGB target or independent color-control cells were not exposed",
          )
        }
        const x = targetFirst[channel]
        const y = targetSecond[channel]
        const a = controlFirst[channel]
        const b = controlSecond[channel]
        const calibrated = !!a && !!b && !sameRgb(a, b)
        if (!x || !y) {
          // #30701, @cto ruling C: a target that reads no color is a measured ignore while the
          // independent controls show two distinct colors; without them the channel is not shown.
          if (calibrated) return parserStateResult(false, expected, state)
          return parserStateResult(
            null,
            expected,
            state,
            undefined,
            `independent ${channel} color controls (SGR ${ordinary[0]} and ${ordinary[1]}) distinguishable in the headless readback`,
          )
        }
        const preceding = controlSecond[channel]
        if (!preceding || sameRgb(preceding, first)) {
          return parserStateResult(null, expected, state, "The preceding color can mimic an ignored first RGB request")
        }
        if (sameRgb(x, first) && sameRgb(y, second)) return parserStateResult(true, expected, state)
        if (calibrated) return parserStateResult(false, expected, state)
        return parserStateResult(null, expected, state, "Independent color-channel calibration was absent")
      },
      sgrTermReadback(
        id,
        `\x1b[${sgr};2;${first.r};${first.g};${first.b}m`,
        { require: [sgr], requireTokens: [`${sgr}:2:${first.r}:${first.g}:${first.b}`] },
        (ctx) => consumedSgr(ctx, id, `\x1b[${sgr};2;${first.r};${first.g};${first.b}m`),
      ),
      null,
    ),
    termNeedsGeometry: true,
    libAssertionType: "buffer_state",
  }
}

function defaultColorProbe(id: string, channel: ColorChannel): ProbeDefinition {
  const setup = channel === "fg" ? 31 : 42
  const reset = channel === "fg" ? 39 : 49
  // Default means no explicit color in this channel, not just absence of the setup sample.
  const firstColor = channel === "fg" ? 30 : 40
  const nondefaultColors = [
    ...Array.from({ length: 8 }, (_, index) => firstColor + index),
    ...Array.from({ length: 8 }, (_, index) => firstColor + 60 + index),
    firstColor + 8,
  ]
  return {
    ...probe(
      id,
      (ctx) => {
        ctx.feed(`C\x1b[${setup}mX\x1b[${reset}mR`)
        const baseline = ctx.getCell(0, 0)
        const before = ctx.getCell(0, 1)
        const after = ctx.getCell(0, 2)
        const state = { baseline, before, after }
        const expected = `${id}: reset R restores the measured C ${channel} after a distinct colored X`
        if (baseline.char !== "C" || before.char !== "X" || after.char !== "R") {
          return parserStateResult(null, expected, state, "Baseline, colored, or reset cell was not exposed")
        }
        const baseColor = baseline[channel]
        const changed = before[channel]
        const resetColor = after[channel]
        if (!changed || sameCellColor(baseColor, changed)) {
          // #30701, @cto ruling C: the colored X is the reference the reset is read against; a setup
          // that reads back as the default leaves the reset with no observable.
          const reason = changed
            ? `Open: the ${channel === "bg" ? "background" : "text"} colour we set first (SGR ${setup}) read the same as the default, so we cannot tell whether the reset to default worked.`
            : `Open: our test could not read the ${channel === "bg" ? "background" : "text"} colour we set first (SGR ${setup}), so we cannot tell whether the reset to default worked.`
          return reviewResult(HEADLESS_OBSERVABLE_REVIEW, reason, reason, state)
        }
        if (resetColor === undefined) {
          return notTestedResult(
            `reset cell exposes no ${channel === "fg" ? "foreground" : "background"} colour after a distinct seed; an unexposed value cannot show the reset`,
            state,
          )
        }
        return parserStateResult(sameCellColor(baseColor, resetColor), expected, state)
      },
      sgrTermReadback(
        id,
        `\x1b[${reset}m`,
        { require: [], forbid: nondefaultColors },
        (ctx) => consumedSgrReset(ctx, id, `\x1b[${setup}m`, `\x1b[${reset}m`),
        {
          sequence: `\x1b[${setup}m`,
          baseline: { require: [], forbid: nondefaultColors },
          readback: { require: [setup] },
        },
      ),
      null,
    ),
    termNeedsGeometry: true,
    libAssertionType: "buffer_state",
  }
}

export const sgrProbes: ProbeDefinition[] = [
  // ── Attributes ──

  sgrProbe("sgr.bold", "\x1b[1m", (cell) => cell.bold === true, undefined, { require: [1] }),

  sgrProbe(
    "sgr.faint",
    "\x1b[2m",
    (cell) => (cell.dim == null ? null : cell.dim),
    undefined,
    { require: [2] },
    "Cell readback cannot distinguish unsupported faint styling from an unreported or collapsed attribute",
  ),

  sgrProbe(
    "sgr.italic",
    "\x1b[3m",
    (cell) => (cell.italic == null ? null : cell.italic),
    undefined,
    { require: [3] },
    "Cell readback cannot distinguish unsupported italic styling from an unreported attribute",
  ),

  sgrProbe("sgr.underline.single", "\x1b[4m", (cell) => !!cell.underline, undefined, { require: [4] }),

  sgrProbe(
    "sgr.underline.double",
    "\x1b[21m",
    (cell) => cell.underline === "double",
    undefined,
    { require: [21] },
    "Cell readback cannot distinguish unsupported double underline from a collapsed underline style",
  ),

  sgrProbe(
    "sgr.underline.curly",
    "\x1b[4:3m",
    (cell) => cell.underline === "curly",
    undefined,
    {
      require: [4],
      requireTokens: ["4:3"],
    },
    "Cell readback cannot distinguish unsupported curly underline from a collapsed underline style",
  ),

  sgrProbe(
    "sgr.underline.dotted",
    "\x1b[4:4m",
    (cell) => cell.underline === "dotted",
    undefined,
    {
      require: [4],
      requireTokens: ["4:4"],
    },
    "Cell readback cannot distinguish unsupported dotted underline from a collapsed underline style",
  ),

  sgrProbe(
    "sgr.underline.dashed",
    "\x1b[4:5m",
    (cell) => cell.underline === "dashed",
    undefined,
    {
      require: [4],
      requireTokens: ["4:5"],
    },
    "Cell readback cannot distinguish unsupported dashed underline from a collapsed underline style",
  ),

  sgrProbe(
    "sgr.blink",
    "\x1b[5m",
    (cell) => (cell.blink == null ? null : cell.blink),
    undefined,
    { require: [5] },
    "Cell readback cannot distinguish unsupported blink styling from an unreported attribute",
    blinkCapture,
  ),

  sgrProbe("sgr.inverse", "\x1b[7m", (cell) => cell.inverse === true, undefined, { require: [7] }),

  sgrProbe(
    "sgr.hidden",
    "\x1b[8m",
    (cell) => (cell.hidden == null ? null : cell.hidden === true),
    (cell) =>
      cell.hidden == null
        ? "Open: our adapter for this library does not read hidden text from its screen cells yet, so our test cannot see hidden text."
        : null,
    { require: [8] },
    "Cell readback cannot distinguish unsupported conceal from a default or unreported hidden flag",
  ),

  sgrProbe(
    "sgr.strikethrough",
    "\x1b[9m",
    (cell) => (cell.strikethrough == null ? null : cell.strikethrough),
    undefined,
    { require: [9] },
    "Cell readback cannot distinguish unsupported strikethrough from an unreported attribute",
  ),

  sgrProbe(
    "sgr.overline",
    "\x1b[53m",
    (cell) => (cell.overline == null ? null : cell.overline === true),
    (cell) =>
      cell.overline == null
        ? "Open: our adapter for this library does not read overline from its screen cells yet, so our test cannot see overline."
        : null,
    { require: [53] },
  ),

  // ── Underline color ──

  rgbUnderlineProbe("sgr.underline.color"),

  // Index values may be theme-specific. Compare two distinct palette controls
  // to their underline colors; one coincidental/default color cannot prove SGR 58.
  {
    ...probe(
      "sgr.underline-color-indexed",
      (ctx) => {
        ctx.feed("\x1b[4;38;5;4m\x1b[59mA\x1b[58;5;5mX\x1b[38;5;5m\x1b[59mB\x1b[58;5;4mY")
        const default4 = ctx.getCell(0, 0)
        const target5 = ctx.getCell(0, 1)
        const default5 = ctx.getCell(0, 2)
        const target4 = ctx.getCell(0, 3)
        const state = {
          default4,
          target5,
          default5,
          target4,
        }
        const expected =
          "SGR 58 index 5/4 underline colors match the opposite SGR 38 palette controls, not their same-foreground defaults"
        const framed = default4.char === "A" && target5.char === "X" && default5.char === "B" && target4.char === "Y"
        if (framed && target5.underlineColor == null && target4.underlineColor == null) {
          return (
            underlineColorUnknownArm(ctx, "5;1", expected, state) ?? notTestedResult(UNDERLINE_COLOR_UNEXPOSED, state)
          )
        }
        if (
          default4.char !== "A" ||
          target5.char !== "X" ||
          default5.char !== "B" ||
          target4.char !== "Y" ||
          !default4.underline ||
          !target5.underline ||
          !default5.underline ||
          !target4.underline ||
          !default4.fg ||
          !default5.fg ||
          target5.underlineColor == null ||
          target4.underlineColor == null
        ) {
          return parserStateResult(null, expected, state, "Palette control or underline cell state was not exposed")
        }
        if (sameRgb(default4.fg, default5.fg)) {
          return parserStateResult(null, expected, state, "Palette controls resolve to indistinguishable colors")
        }
        const matches =
          sameRgb(default5.fg, target5.underlineColor) &&
          sameRgb(default4.fg, target4.underlineColor) &&
          (!default4.underlineColor || !sameRgb(default4.underlineColor, target5.underlineColor)) &&
          (!default5.underlineColor || !sameRgb(default5.underlineColor, target4.underlineColor))
        if (matches) return parserStateResult(true, expected, state)
        if (
          default4.underlineColor &&
          default5.underlineColor &&
          !sameRgb(default4.underlineColor, default5.underlineColor)
        ) {
          return parserStateResult(false, expected, state)
        }
        return parserStateResult(null, expected, state, "Underline color readback was not calibrated for a negative")
      },
      sgrTermReadback(
        "sgr.underline-color-indexed",
        "\x1b[4m\x1b[58;5;5m",
        { require: [4, 58], requireTokens: ["58:5:5"] },
        (ctx) => consumedSgr(ctx, "sgr.underline-color-indexed", "\x1b[4m\x1b[58;5;5m"),
      ),
      null,
    ),
    termNeedsGeometry: true,
    libAssertionType: "buffer_state",
  },

  rgbUnderlineProbe("sgr.underline-color-rgb"),

  // SGR 59 — compare its actual reset value with an earlier reset-state control.
  {
    ...probe(
      "sgr.underline-color-reset",
      withUnhandledSgrReport("sgr.underline-color-reset", "\x1b[59m", (ctx) => {
        ctx.feed("\x1b[4m\x1b[59mC\x1b[58;2;255;0;128mX\x1b[59mY")
        const baseline = ctx.getCell(0, 0)
        const before = ctx.getCell(0, 1)
        const after = ctx.getCell(0, 2)
        const state = { baseline, before, after }
        const expected =
          "X has explicit underline rgb(255,0,128); SGR 59 restores Y to the measured reset-state C color"
        const framed = baseline.char === "C" && before.char === "X" && after.char === "Y"
        if (framed && before.underlineColor == null) {
          // libvterm 0.3.3 has no SGR 59 report, and the same-run arm shows SGR 58 does not work there, so the
          // reset has nothing to act on (@cto routes-32 section 1). Any other identity keeps today's record.
          const version = ctx.runtimeIdentity?.engineVersion
          if (
            ctx.backendName === "libvterm" &&
            version === "0.3.3" &&
            underlineColorUnknownArm(ctx, "2;1;2;3", expected, state) !== undefined
          ) {
            return declaredUntestableResult(`${LIBVTERM_RESET_NO_SETUP} Library version: ${version}.`, state)
          }
          // A missing prerequisite, not a missing control (@cto batch7 A-F5).
          return notTestedResult(
            "Open: after we set an underline colour (SGR 58), the screen cell showed none, so the setup did not show and the reset cannot be tested.",
            state,
          )
        }
        if (
          baseline.char !== "C" ||
          before.char !== "X" ||
          after.char !== "Y" ||
          !baseline.underline ||
          !before.underline ||
          !after.underline ||
          baseline.underlineColor === undefined ||
          before.underlineColor === undefined ||
          after.underlineColor === undefined
        ) {
          return parserStateResult(null, expected, state, "Reset control or underline cell state was not exposed")
        }
        if (
          !before.underlineColor ||
          !sameRgb(before.underlineColor, requestedUnderlineColor) ||
          (baseline.underlineColor && sameRgb(baseline.underlineColor, requestedUnderlineColor))
        ) {
          const reason =
            "SGR 59 needs the requested rgb(255,0,128) setup distinct from its reset-state baseline; that prerequisite was not observed"
          return reviewResult(HEADLESS_OBSERVABLE_REVIEW, reason, reason, state)
        }
        if (after.underlineColor && sameRgb(after.underlineColor, before.underlineColor)) {
          return parserStateResult(false, expected, state)
        }
        if (baseline.underlineColor === null || after.underlineColor === null) {
          if (baseline.underlineColor === after.underlineColor) return parserStateResult(true, expected, state)
          return parserStateResult(null, expected, state, "Reset-state color readback changed representation")
        }
        return parserStateResult(sameRgb(baseline.underlineColor, after.underlineColor), expected, state)
      }),
      sgrTermReadback(
        "sgr.underline-color-reset",
        "\x1b[59m",
        { require: [4], forbid: [58] },
        (ctx) =>
          consumedSgrReset(ctx, "sgr.underline-color-reset", "\x1b[4m\x1b[58;2;255;0;128m", "\x1b[59m", "\x1b[4m"),
        {
          sequence: "\x1b[4m\x1b[58;2;255;0;128m",
          baseline: { require: [], forbid: [4, 58] },
          readback: { require: [4, 58], requireTokens: ["58:2:255:0:128"] },
        },
      ),
      null,
    ),
    termNeedsGeometry: true,
    libAssertionType: "buffer_state",
  },

  // ── Colors ──

  namedColorProbe("sgr.fg.standard", "fg", 31, 34),
  namedColorProbe("sgr.bg.standard", "bg", 41, 44),
  namedColorProbe("sgr.fg.bright", "fg", 91, 94),
  namedColorProbe("sgr.bg.bright", "bg", 101, 104),
  defaultColorProbe("sgr.fg.default", "fg"),
  defaultColorProbe("sgr.bg.default", "bg"),
  indexedColorProbe("sgr.fg.256", "fg"),
  indexedColorProbe("sgr.bg.256", "bg"),
  truecolorProbe("sgr.fg.truecolor", "fg"),
  truecolorProbe("sgr.bg.truecolor", "bg"),

  // ── Selective resets ──

  resetProbe("sgr.selective-reset.bold", "\x1b[1;2;3m", "\x1b[22m", ["bold", "dim"], ["italic"], {
    setup: "\x1b[1;2;3;4m",
    preserve: ["italic", "underline"],
    preserveMode: "any",
  }),

  resetProbe("sgr.selective-reset.underline", "\x1b[1;4m", "\x1b[24m", ["underline"], ["bold"]),

  resetProbe("sgr.selective-reset.italic", "\x1b[1;3m", "\x1b[23m", ["italic"], ["bold"]),

  resetProbe("sgr.selective-reset.inverse", "\x1b[1;7m", "\x1b[27m", ["inverse"], ["bold"]),

  // ── Full SGR reset ──

  resetProbe("sgr.reset", "\x1b[1;3;4m", "\x1b[0m", ["bold", "italic", "underline"]),
]

const visualSgrIds = new Set(sgrProbes.map(({ id }) => id))
const muxVisualTests = new Map<string, { featureId: string | null; testId: string }>([
  ["sgr-blink-flat", { featureId: "sgr.blink", testId: "blink" }],
  ["sgr-attribute-same-run", { featureId: null, testId: "attribute" }],
  ["cursor-shape-same-run", { featureId: "cursor.shape", testId: "review" }],
  ["reset-saved-rendition", { featureId: "reset.sgr", testId: "reset" }],
  ["sgr-reset-saved-rendition", { featureId: "sgr.reset", testId: "criterion" }],
  ["sgr-selective-reset-saved-rendition", { featureId: "sgr.selective-reset.bold", testId: "criterion" }],
  ["iterm2-images-no-change", { featureId: "extensions.iterm2-images", testId: "criterion" }],
  ["sixel-advertised-unchanged", { featureId: "extensions.sixel", testId: "criterion" }],
])

function finalizeMuxVisualNegative(
  recorded: ProbeResult,
  target: Pick<ProbeSubject, "kind"> & Partial<Pick<ProbeSubject, "outerTerminal">>,
): ProbeResult {
  const selected = recorded.criterionBranch === undefined ? undefined : muxVisualTests.get(recorded.criterionBranch)
  if (target.kind !== "mux" || recorded.status !== "unsupported" || selected === undefined) return recorded
  const reason = target.outerTerminal
    ? `${recorded.reason ? `${recorded.reason}; ` : ""}this capture through outer terminal ${target.outerTerminal} cannot separate the multiplexer from its outer terminal`
    : `Missing outer terminal identity: this capture cannot separate the multiplexer from its outer terminal${recorded.reason ? `; ${recorded.reason}` : ""}`
  return finalizeProbeResult({
    ...recorded,
    reason,
    tests: recorded.tests.map((entry) =>
      entry.id === selected.testId ? { ...entry, status: "probe-todo", assertionRefs: [], reason } : entry,
    ),
  })
}

/** Require app/mux rendered evidence while preserving library cell criteria after execution. */
export function finalizeVisualResult(
  recorded: ProbeResult,
  target: Pick<ProbeSubject, "kind"> & Partial<Pick<ProbeSubject, "outerTerminal">>,
  captures: readonly ObservationFrame[],
): ProbeResult {
  // CTO Ask2b: owning callbacks qualify no-change; this finalizer only adds actual subject identity.
  const mux = "id" in target && typeof target.id === "string" ? target.id : undefined
  const noChangeIds = ["extensions.osc112-reset-cursor", "extensions.osc9-progress", "extensions.osc555-flash"]
  if (mux === "screen") {
    noChangeIds.push(
      "extensions.osc104-reset-palette",
      "extensions.osc110-reset-fg",
      "extensions.osc30001-color-stack-push",
      "extensions.osc30101-color-stack-pop",
    )
  }
  if (
    target.kind === "mux" &&
    (mux === "screen" || mux === "tmux") &&
    recorded.status === "untestable" &&
    noChangeIds.includes(recorded.featureId)
  ) {
    const reason = `${recorded.reason}; unchanged effect could have stopped at ${mux} or its outer terminal ${target.outerTerminal ?? "(identity unavailable)"}`
    return finalizeProbeResult({
      ...recorded,
      reason,
      tests: recorded.tests.map((test) => (test.id === "declared-untestable" ? { ...test, reason } : test)),
    })
  }
  const hasScreenshot =
    recorded.screenshotRef !== undefined &&
    captures.some((frame) => frame.kind !== "text-cells" && frame.ref === recorded.screenshotRef)
  if (
    recorded.featureId === "modes.reverse-video" &&
    target.kind === "mux" &&
    recorded.status === "unsupported" &&
    hasScreenshot
  ) {
    const reason =
      "Open: reverse-video pixels did not change through the mux and its outer terminal. Needed: the outer terminal command trace (the named Kitty --dump-commands reader)."
    return finalizeProbeResult({
      ...recorded,
      reason,
      tests: [
        ...recorded.tests,
        {
          id: "outer-command-reader",
          status: "probe-todo",
          attempt: { scope: "none" },
          assertionRefs: [],
          reason,
        },
      ],
    })
  }
  const selected = recorded.criterionBranch === undefined ? undefined : muxVisualTests.get(recorded.criterionBranch)
  const pixelBranch = selected?.featureId === recorded.featureId && recorded.assertionType === "screenshot"
  if (
    (!visualSgrIds.has(recorded.featureId) && !pixelBranch) ||
    (recorded.status !== "supported" && recorded.status !== "unsupported")
  ) {
    return recorded
  }
  if (target.kind === "lib") return recorded
  if (hasScreenshot) return finalizeMuxVisualNegative(recorded, target)
  const reason = "visual effect not observed in this run"
  return finalizeProbeResult({
    ...recorded,
    reason,
    tests: [
      ...recorded.tests,
      { id: "visual", status: "probe-todo", attempt: { scope: "none" }, assertionRefs: [], reason },
    ],
  })
}
