import { randomUUID } from "node:crypto"
import type {
  ProbeDefinition,
  ProbeCallbackResult,
  LibProbeSource,
  TermProbeSource,
  TerminalQueryOutcome,
  HostInputName,
  ObservationFrame,
} from "./types.ts"
import {
  REPLY_AFTER_SENTINEL_NOTE,
  HEADLESS_OBSERVABLE_REVIEW,
  SEMANTIC_PROMPT_SOURCE_REVIEW,
  decrpmPs,
  decrpmReplyPattern,
  decrpmReading,
  decrpmResult,
  notTestedResult,
  osInputReviewResult,
  colorReadbackReviewResult,
  parserStateResult,
  probe,
  readHyperlinkMetadata,
  readSentinelReply,
  replyFrame,
  replyFailure,
  cancelReplyFailure,
  reviewResult,
  vtermGeometryReview,
  SOURCE_TREE_AUDITS,
  sameRgb as sameRgbCells,
  sentinelNegativeResult,
  sentinelSilenceResult,
  sgrCaptureFrames,
  sgrCaptureTooSmall,
  unmeasuredCellResult,
  auditedAdapterSources,
  stackStateResult,
  stackVerdict,
  type StackReading,
} from "./helpers.ts"
import { evidenceRuntimeIdentity } from "./runtime-identity.ts"
import { replyPathAuditFor } from "./reply-path-audit.ts"
import { nativeHostRecipeResult } from "./native-host-audit.ts"
import { measureAlternateReflow } from "./modes.ts"
import { sgrTermReadback } from "./sgr.ts"
import {
  beginCaptureLifecycle,
  captureRegionGeometry,
  captureRegionReadbackDecision,
  collectorRegionRead,
  endCaptureLifecycle,
} from "./region-readback.ts"
import {
  KITTY_BOUNDS,
  KITTY_CLEAR,
  KITTY_FRAME_BLUE,
  KITTY_FRAME_RED,
  KITTY_GAP_MS,
  KITTY_GUARD_REGION,
  KITTY_GUARD_TEXT,
  KITTY_LOOP_FOREVER,
  KITTY_PLACEHOLDER_BOUNDS,
  KITTY_REGION,
  KITTY_RETRY_FACTOR,
  KITTY_WAIT_FACTOR,
  decideKittyAnimation,
  decideKittyPlaceholders,
  kittyBlockOrigin,
  kittyBlockPixels,
  kittyDeleteImage,
  kittyFrameTransfer,
  kittyImageNumber,
  kittyPark,
  kittyPlace,
  kittyPlaceholderNumber,
  kittyPlaceholderText,
  kittyRootGap,
  kittySelectFrame,
  kittyStartPlayback,
  kittyStopPlayback,
  kittyVirtualPlacement,
  kittyWait,
  type KittyDigestPair,
} from "./kitty-capture.ts"
import { SIXEL_BOUNDS, SIXEL_REGION, sixelReadback } from "./sixel-capture.ts"

/** A minimal solid-red 8x8 PNG; the OSC 1337 inline image target renders it as reviewable pixels. */
const ITERM2_RED_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR42mP4z8CAFTEMLQkAKP8/wc53yE8AAAAASUVORK5CYII="
/** The OSC 1337 inline-image request both arms feed: an 8x8 red PNG, BEL-terminated. */
const ITERM2_INLINE_IMAGE = "\x1b]1337;File=inline=1;width=8px;height=8px:" + ITERM2_RED_PNG + "\x07"

/**
 * Font-ligature sample: ONE line so the pair fits the minimum admitted capture geometry, and the
 * control keeps each operator pair apart so no shaping rule can join it.
 */
const FONT_LIGATURE_CONTROL = "! = - > = > < = = ="
const FONT_LIGATURE_TARGET = "!= -> => <= =="

function queryOnly(definition: ProbeDefinition): ProbeDefinition {
  return { ...definition, termWrites: "query" }
}

/** Q16: this ID detects OSC5522 protocol recognition; it does not test clipboard effects. */
function osc5522DetectionResult(raw: string, replyMatched: boolean, afterSentinel = false): ProbeCallbackResult {
  const window = readSentinelReply(raw, decrpmReplyPattern(5522))
  const ps = replyMatched ? decrpmPs(window.match?.[1]) : null
  const unorderedLate = !afterSentinel && (window.kind === "answered" || window.kind === "unmatched")
  if (ps === null || unorderedLate) {
    const note = "OSC5522 detection has no complete matching reply in the deciding window"
    if (raw === "") return replyFailure(note)
    return { pass: false, note, tests: [{ id: "criterion", status: "test-failure", reason: note }] }
  }
  // Only an on-time detector reply makes Ps0 negative; measured-late replies use the shared criterion.
  if (ps !== 0 || afterSentinel) {
    const result = decrpmResult(ps, 5522)
    return afterSentinel && result.observation
      ? { ...result, observation: { ...result.observation, note: REPLY_AFTER_SENTINEL_NOTE } }
      : result
  }
  const reading = decrpmReading(ps)
  return {
    pass: false,
    response: reading,
    note: "OSC5522 protocol detection: mode 5522 is not recognized",
    observation: { outcome: "unsupported", assertionType: "query_reply" },
    assertions: [
      {
        assertionType: "query_reply",
        kind: "negative",
        expected: "OSC5522 protocol detection is recognized",
        observed: reading,
      },
    ],
  }
}

/**
 * Bind a complete reply from this query; a prefix or unrelated output is not a result. When the
 * collector measured a DA1 sentinel before the reply, the ordering rides along as a note.
 */
function oscReplyResult(
  raw: string,
  frame: string | null,
  expected: string,
  sentinel?: { atMs: number; graceMs: number },
): ProbeCallbackResult {
  if (frame) {
    return {
      pass: true,
      response: raw,
      observation: {
        outcome: "supported",
        assertionType: "query_reply",
        ...(sentinel && { note: REPLY_AFTER_SENTINEL_NOTE }),
      },
      assertions: [{ assertionType: "query_reply" as const, kind: "positive", expected, observed: frame }],
    }
  }
  const silent = sentinelNegativeResult(raw, sentinel, expected)
  if (silent) return silent
  if (raw.length === 0) {
    return { ...replyFailure("no-response"), response: raw }
  }
  const note = `Malformed OSC reply: ${JSON.stringify(raw)}`
  return {
    pass: false,
    response: raw,
    observation: {
      outcome: "inconclusive",
      reason: "invalid-reply",
      assertionType: "query_reply",
      note,
    },
    tests: [{ id: "criterion", status: "test-failure", reason: note }],
  }
}

/**
 * Live's grading of one OSC query outcome. A library probe source on a proven reply path offers the same
 * outcome through `queryWithSentinelOutcome` (#30554), so both arms grade through here.
 */
function oscOutcomeResult(reply: TerminalQueryOutcome, expected: string): ProbeCallbackResult {
  return oscReplyResult(reply.raw, replyFrame(reply), expected, reply.sentinel)
}

function unverifiedEffect(ctx: TermProbeSource, note: string, response?: string): ProbeCallbackResult {
  return {
    pass: false,
    ...(response !== undefined && { response }),
    note,
    tests: [
      {
        id: "criterion",
        status: "test-todo",
        reason: `${note}${ctx.captureGeometryRefusal ? `; Pixel capture unavailable: ${ctx.captureGeometryRefusal}` : ""}`,
      },
    ],
  }
}

function unmeasuredStateEffect(feature: string): ProbeCallbackResult {
  const note = `${feature} was not attempted; this probe has no effect readback or prior-state restoration`
  return {
    pass: false,
    note,
    tests: [{ id: "criterion", status: "test-todo", reason: note }],
  }
}

const sixelDa1Reply = /\x1b\[\?([0-9]+(?:;[0-9]+)*);?c/

function sixelDa1Result(raw: string, frame: string | null): ProbeCallbackResult {
  const match = frame ? sixelDa1Reply.exec(frame) : null
  if (!match) {
    if (raw.length === 0) {
      return { ...replyFailure("no-response"), response: raw }
    }
    const note = `Malformed DA1 reply: ${JSON.stringify(raw)}`
    return {
      pass: false,
      response: raw,
      observation: {
        outcome: "inconclusive",
        reason: "invalid-reply",
        assertionType: "query_reply",
        note,
      },
      tests: [{ id: "criterion", status: "test-failure", reason: note }],
    }
  }
  const advertised = (match[1]?.split(";") ?? []).includes("4")
  return {
    pass: advertised,
    response: raw,
    observation: { outcome: advertised ? "supported" : "unsupported", assertionType: "query_reply" },
    assertions: [
      {
        assertionType: "query_reply" as const,
        kind: advertised ? "positive" : "negative",
        expected: "Complete DA1 advertises Sixel attribute 4",
        observed: match[0],
      },
    ],
  }
}

/** XTSMGRAPHICS item 2, read: the current Sixel geometry in pixels. */
const SIXEL_GEOMETRY_QUERY = "\x1b[?2;1;0S"
const SIXEL_GEOMETRY_REPLY = /\x1b\[\?2;[0-9;]*S/

/** Live's grading of one Sixel geometry outcome, shared by both arms (#30554). */
function sixelGeometryOutcomeResult(reply: TerminalQueryOutcome): ProbeCallbackResult {
  return sixelGeometryResult(reply.raw, replyFrame(reply), reply.sentinel)
}

/** A read of current Sixel geometry; protocol failure and silence never establish a negative. */
function sixelGeometryResult(
  raw: string,
  frame: string | null,
  sentinel?: { atMs: number; graceMs: number },
): ProbeCallbackResult {
  // xterm replies with CSI ? Pi ; Ps ; Pv S, but omits the value on failure, so the
  // measured failure frame is two parameters (CSI ? 2 ; 3 S). Requiring a third
  // parameter graded that documented failure as a malformed geometry.
  const reply = frame ? /\x1b\[\?2;([0-9]+)(?:;([0-9;]*))?S/.exec(frame) : null
  if (!reply) {
    const malformed = frame !== null
    const note =
      raw.length > 0
        ? `Malformed Sixel geometry reply: ${JSON.stringify(raw)}`
        : "No Sixel geometry response for item 2"
    if (!malformed) {
      const silent = sentinelNegativeResult(raw, sentinel, "Complete Sixel geometry response for item 2")
      if (silent) return silent
    }
    if (raw.length === 0) {
      return { ...replyFailure(note), response: raw }
    }
    return {
      pass: false,
      response: raw,
      note,
      observation: {
        outcome: "inconclusive",
        assertionType: "query_reply",
        reason: "invalid-reply",
        note,
      },
      tests: [{ id: "criterion", status: "test-failure", reason: note }],
    }
  }
  const status = Number(reply[1])
  if (status !== 0) {
    const validFailure = status === 1 || status === 2 || status === 3
    const note = validFailure
      ? status === 3
        ? "Sixel geometry query reported protocol status 3 (failure; no graphics geometry is configured)"
        : `Sixel geometry query reported protocol status ${status}`
      : `Unknown Sixel geometry protocol status ${reply[1]}`
    return {
      pass: false,
      response: raw,
      note,
      observation: {
        outcome: "inconclusive",
        assertionType: "query_reply",
        reason: validFailure ? "insufficient-evidence" : "invalid-reply",
        note,
      },
    }
  }
  const dimensions = reply[2]?.split(";") ?? []
  const width = Number(dimensions[0])
  const height = Number(dimensions[1])
  if (
    dimensions.length !== 2 ||
    dimensions.some((value) => !/^[0-9]+$/.test(value)) ||
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height)
  ) {
    const note = "Successful Sixel geometry response lacked two numeric pixel dimensions"
    return {
      pass: false,
      response: raw,
      note,
      observation: { outcome: "inconclusive", assertionType: "query_reply", reason: "invalid-reply", note },
    }
  }
  if (width === 0 || height === 0) {
    const note = `Sixel geometry reported ${width}×${height} pixels; usable dimensions were not established`
    return {
      pass: false,
      response: raw,
      note,
      observation: { outcome: "inconclusive", assertionType: "query_reply", reason: "insufficient-evidence", note },
    }
  }
  const note = `Current Sixel geometry reported as ${width}×${height} pixels`
  return {
    pass: true,
    response: raw,
    note,
    observation: { outcome: "supported", assertionType: "query_reply", note },
    assertions: [
      {
        assertionType: "query_reply" as const,
        kind: "positive",
        expected: "XTSMGRAPHICS item 2 read returns status 0 and two positive pixel dimensions",
        observed: reply[0],
      },
    ],
  }
}

// One non-ANSI current-colour control shared by initial-query and stack criteria.
const seededCurrentColor = "rgb:aa/bb/cc"

function seedColorReadback(capture: (write: string) => string, slot: string, pattern: RegExp) {
  const setterRaw = capture(`\x1b]${slot};${seededCurrentColor}\x07`)
  const seededRaw = capture(`\x1b]${slot};?\x07`)
  const frame = pattern.exec(seededRaw)?.[0]
  const color = frame?.slice(`\x1b]${slot};`.length).replace(/(?:\x07|\x1b\\)$/, "") ?? null
  return {
    setterRaw,
    seededRaw,
    color,
    verified: setterRaw === "" && frame === seededRaw && color !== null && sameRgbText(color, seededCurrentColor),
  }
}

/** A disposable seed owns its reset even when setting or reading it throws. */
function seedColorReadbackAndReset(capture: (write: string) => string, slot: string, pattern: RegExp, reset: string) {
  let control: ReturnType<typeof seedColorReadback>
  let resetRaw: string
  let primary: { error: unknown } | undefined
  try {
    control = seedColorReadback(capture, slot, pattern)
  } catch (error) {
    primary = { error }
    throw error
  } finally {
    try {
      resetRaw = capture(reset)
    } catch (cleanup) {
      if (primary) {
        const message = primary.error instanceof Error ? primary.error.message : String(primary.error)
        throw new AggregateError([primary.error, cleanup], `${message}; colour reset cleanup failed`, {
          cause: primary.error,
        })
      }
      throw cleanup
    }
  }
  return { control, resetRaw }
}

/** OSC color query probe — feedCapture + regex (termless), sentinel query (term). */
function oscColorQueryProbe(id: string, oscCode: number, index?: number): ProbeDefinition {
  const slot = `${oscCode}${index === undefined ? "" : `;${index}`}`
  const querySeq = `\x1b]${slot};?\x07`
  const pattern = new RegExp(`\\x1b\\]${slot};rgb:[0-9a-f]{1,4}/[0-9a-f]{1,4}/[0-9a-f]{1,4}(?:\\x07|\\x1b\\\\)`, "i")
  const expected = `Complete OSC ${oscCode}${index === undefined ? "" : ` index-${index}`} color reply`
  const reviewInitialValue = oscCode === 10 || oscCode === 11 || oscCode === 12 || (oscCode === 4 && index === 0)
  const hostInput: HostInputName | undefined =
    oscCode === 10
      ? "foreground-rgb"
      : oscCode === 11
        ? "background-rgb"
        : oscCode === 12
          ? "cursor-rgb"
          : oscCode === 4 && index === 0
            ? "palette-entry-rgb"
            : undefined
  return {
    ...queryOnly(
      probe(
        id,
        (ctx) => {
          let silence: ProbeCallbackResult | null = null
          if (ctx.queryWithSentinelOutcome) {
            const outcome = ctx.queryWithSentinelOutcome(querySeq, pattern)
            silence = sentinelSilenceResult(outcome, expected)
            if (!reviewInitialValue || !silence) return oscOutcomeResult(outcome, expected)
          }
          const raw = silence ? "" : ctx.feedCapture(querySeq)
          const answer = (result: ProbeCallbackResult) =>
            hostInput === undefined
              ? result
              : nativeHostRecipeResult(ctx, result, "color-request", hostInput, querySeq, raw === "")
          if (raw !== "" || !reviewInitialValue) {
            return answer(oscReplyResult(raw, pattern.exec(raw)?.[0] ?? null, expected))
          }

          const reset = `\x1b]${oscCode + 100}${index === undefined ? "" : `;${index}`}\x07`
          const controls: { write: string; response: string }[] = []
          const capture = (write: string) => {
            const response = ctx.feedCapture(write)
            controls.push({ write, response })
            return response
          }
          const { control, resetRaw } = seedColorReadbackAndReset(capture, slot, pattern, reset)
          const restoredRaw = capture(querySeq)
          const state = { query: querySeq, initialRaw: raw, controls }
          if (control.verified && resetRaw === "" && restoredRaw === "") {
            return answer(
              colorReadbackReviewResult(
                `OSC ${slot} initial/current colour is embedder-owned: initial query and reset query answered nothing; seeded query control cannot establish the initial value`,
                state,
              ),
            )
          }
          if (silence) return answer(silence)
          return answer({
            ...oscReplyResult(raw, null, expected),
            response: JSON.stringify(state),
          })
        },
        async (ctx) => oscOutcomeResult(await ctx.queryWithSentinelOutcome(querySeq, pattern), expected),
        "query_reply",
      ),
    ),
    libAssertionType: "query_reply",
    ...(hostInput === undefined
      ? {}
      : { libHostRecipes: [{ recipe: "color-request" as const, query: querySeq, missing: [hostInput] }] }),
  }
}

/**
 * Candidate test colours for the highlight-reset probes, tried in order. They differ from each other,
 * so at most one can equal the colour a run starts on and a distinct change is always available.
 */
const HIGHLIGHT_TEST_COLOURS = ["3030/6060/9090", "9090/3030/6060", "6060/9090/3030"] as const

/**
 * A highlight-colour RESET decides only against the colour the run started from — "the default" is
 * not a known constant. So: query the initial value, set a known colour and confirm the terminal
 * reports it, write the reset, query again, and compare that reading with the initial one. The
 * initial value is restored from a finally, so the run leaves the slot as it found it. A silent
 * initial read is inconclusive: without it a reset has nothing to be compared against. The set colour
 * is chosen to differ from the observed initial one, so a terminal that starts on the usual test
 * value still gets an observable change to grade the reset against.
 */
function highlightResetProbe(id: string, setCode: number, resetCode: number): ProbeDefinition {
  const querySeq = `\x1b]${setCode};?\x07`
  const pattern = new RegExp(
    `\\x1b\\]${setCode};rgb:([0-9a-f]{1,4})/([0-9a-f]{1,4})/([0-9a-f]{1,4})(?:\\x07|\\x1b\\\\)`,
    "i",
  )
  const read = async (ctx: TermProbeSource) => {
    const reply = await ctx.queryWithSentinelOutcome(querySeq, pattern)
    const match = reply.match
    if (reply.reason !== "reply" || !match) return { reply, colour: null }
    const [, r, g, b] = match
    if (r === undefined || g === undefined || b === undefined) return { reply, colour: null }
    return { reply, colour: { raw: match[0] ?? "", rgb: `${r}/${g}/${b}` } }
  }
  const inconclusive = (note: string, reply?: TerminalQueryOutcome): ProbeCallbackResult => ({
    ...(reply?.raw === "" ? replyFailure(note) : {}),
    pass: false,
    note: undefined,
    tests: [{ id: "criterion", status: "test-failure", reason: note }] as [
      { id: string; status: "test-failure"; reason: string },
    ],
  })
  return {
    ...probe(
      id,
      colorResetProbe(id, setCode, resetCode),
      async (ctx): Promise<ProbeCallbackResult> => {
        const initialRead = await read(ctx)
        const initial = initialRead.colour
        if (!initial) {
          return inconclusive(
            `${id}: OSC ${setCode} did not report a colour, so the initial highlight colour is unknown and a reset cannot be compared with it`,
            initialRead.reply,
          )
        }
        // A set that the terminal reports back as the initial colour would let both readings agree
        // while the reset is ignored, so the changed state has to be distinct from the initial one.
        const known = HIGHLIGHT_TEST_COLOURS.find((candidate) => candidate !== initial.rgb)
        if (!known) {
          return inconclusive(
            `${id}: every candidate test colour equals the initial ${initial.rgb}, so no observable change is available to grade a reset against`,
          )
        }
        try {
          ctx.write(`\x1b]${setCode};rgb:${known}\x07`)
          const appliedRead = await read(ctx)
          const applied = appliedRead.colour
          if (!applied) {
            return inconclusive(
              `${id}: the known colour was not read back after OSC ${setCode}; a reset cannot be graded against a set that did not apply`,
              appliedRead.reply,
            )
          }
          if (applied.rgb !== known) {
            return inconclusive(
              `${id}: OSC ${setCode} reported ${applied.rgb} after setting ${known}, so the set did not take and a reset means nothing`,
            )
          }
          ctx.write(`\x1b]${resetCode}\x07`)
          const resetRead = await read(ctx)
          const afterReset = resetRead.colour
          if (!afterReset) {
            return inconclusive(`${id}: OSC ${setCode} did not answer after OSC ${resetCode}`, resetRead.reply)
          }
          const ok = afterReset.rgb === initial.rgb
          return {
            pass: ok,
            response: JSON.stringify({ initial: initial.raw, set: applied.raw, afterReset: afterReset.raw }),
            observation: { outcome: ok ? "supported" : "unsupported", assertionType: "query_reply" },
            assertions: [
              {
                assertionType: "query_reply" as const,
                kind: (ok ? "positive" : "negative") as "positive" | "negative",
                expected: `${id}: OSC ${setCode} reports the initial ${initial.rgb} after OSC ${resetCode}`,
                observed: afterReset.raw,
              },
            ],
          }
        } finally {
          // Restore what the run found; a probe never leaves a known test colour behind.
          ctx.write(`\x1b]${setCode};rgb:${initial.rgb}\x07`)
        }
      },
      "query_reply",
    ),
    // The callback mutates the highlight slot, so the collector must hold a disposable receipt:
    // the same classification the OSC 10-14 reset probes carry.
    termNeedsDisposable: true,
    // The lib arm mixes measured query_reply and source-review buffer_state routes;
    // one declaration cannot state both, so it stays temporarily undeclared under #28801.
  }
}

function oscSimpleQueryProbe(id: string, query: string, pattern: RegExp, expected: string): ProbeDefinition {
  return {
    ...queryOnly(
      probe(
        id,
        (ctx) => {
          const outcome = ctx.queryWithSentinelOutcome?.(query, pattern)
          const raw = outcome ? outcome.raw : ctx.feedCapture(query)
          const result = outcome
            ? oscOutcomeResult(outcome, expected)
            : oscReplyResult(raw, pattern.exec(raw)?.[0] ?? null, expected)
          const zeroGeometry =
            (id === "extensions.osc1337-cellsize" &&
              /^\x1b\]1337;ReportCellSize=0;0\x1b\\(?:\x1b\[\?[0-9]+(?:;[0-9]+)*c)?$/.test(raw)) ||
            (id === "extensions.osc776-cell-size" &&
              /^\x1b\]776;0;0;0\x1b\\(?:\x1b\[\?[0-9]+(?:;[0-9]+)*c)?$/.test(raw))
          if (id === "extensions.osc1337-cellsize" || id === "extensions.osc776-cell-size") {
            const review = vtermGeometryReview(
              ctx,
              zeroGeometry && result.observation?.outcome === "inconclusive",
              {
                query,
                raw,
                noObservable: "Audited vterm headless subject has no physical font cell dimensions",
                sourceCitation:
                  ctx.runtimeIdentity?.kind === "js" &&
                  ctx.runtimeIdentity.runtimeFormat === "js" &&
                  ctx.runtimeIdentity.integrity.kind === "source" &&
                  ctx.runtimeIdentity.integrity.revision === "9e99e4d23cdc606fca258b1863aa2be7ae79eed3"
                    ? "vterm 9e99e4d23cdc606fca258b1863aa2be7ae79eed3 packages/vterm/src/screen.ts:89-109 ScreenOptions has no physical font metrics; OSC1337 ReportCellSize at :4056-4058 and OSC776 at :4000-4003 deliberately report unknown zero dimensions (#30575)"
                    : "vterm 67dd3960746766ed47e2bb4b2ced6503a78549cc packages/vterm/src/screen.ts:89-109 ScreenOptions has no physical font metrics; OSC1337 ReportCellSize at :4056-4058 and OSC776 at :4000-4003 deliberately report unknown zero dimensions (#30575)",
              },
              result,
            )
            if (review) return review
          }
          return result
        },
        async (ctx) => oscOutcomeResult(await ctx.queryWithSentinelOutcome(query, pattern), expected),
        "query_reply",
      ),
    ),
    libAssertionType: "query_reply",
  }
}

function colorResetProbe(id: string, setCode: number, resetCode: number, index?: number): ProbeDefinition["lib"] {
  const hostColorSlot = [4, 10, 11, 12].includes(setCode)
  const highlightColorSlot = setCode === 17 || setCode === 19
  const indexPart = index === undefined ? "" : `${index};`
  const query = `\x1b]${setCode};${indexPart}?\x07`
  const hostInput: HostInputName =
    setCode === 10
      ? "foreground-rgb"
      : setCode === 11
        ? "background-rgb"
        : setCode === 12
          ? "cursor-rgb"
          : "palette-entry-rgb"
  const replyPattern = new RegExp(
    `\\x1b\\]${setCode};${indexPart}(rgb:[0-9a-f]{1,4}/[0-9a-f]{1,4}/[0-9a-f]{1,4})(?:\\x07|\\x1b\\\\)`,
    "i",
  )
  return (ctx) => {
    if (index === undefined && [10, 11, 12].includes(setCode) && resetCode === setCode + 100 && ctx.getDefaultColors) {
      type Colors = ReturnType<NonNullable<LibProbeSource["getDefaultColors"]>>
      const slots = ["fg", "bg", "cursor"] as const
      const slot = setCode === 10 ? "fg" : setCode === 11 ? "bg" : "cursor"
      const state: {
        slot: typeof slot
        baseline?: Colors
        seeded?: Colors
        restored?: Colors
        seed?: NonNullable<Colors["fg"]>
        writes: string[]
        errors: string[]
      } = { slot, writes: [], errors: [] }
      const readColors = ctx.getDefaultColors.bind(ctx)
      const read = (): { colors: Colors } | { error: string } => {
        try {
          const colors = readColors()
          if (typeof colors !== "object" || colors === null) {
            throw new Error("default colors must report all three slots")
          }
          for (const key of slots) {
            const color = colors[key]
            if (
              color !== null &&
              (typeof color !== "object" ||
                !color ||
                ![color.r, color.g, color.b].every(
                  (channel) => Number.isInteger(channel) && channel >= 0 && channel <= 255,
                ))
            ) {
              throw new Error(`default colors ${key} must be RGB or null`)
            }
          }
          return { colors: globalThis.structuredClone(colors) }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          state.errors.push(message)
          return { error: message }
        }
      }
      const review = (reason: string) =>
        colorReadbackReviewResult(`OSC ${resetCode}: ${reason}; independent review required`, state)
      const baselineRead = read()
      if ("error" in baselineRead) return review("default-color baseline could not be read")
      const baseline = (state.baseline = baselineRead.colors)
      const equal = (a: Colors["fg"], b: Colors["fg"]) => (a === null || b === null ? a === b : sameRgbCells(a, b))
      const first = { r: 170, g: 187, b: 204 }
      state.seed = equal(baseline[slot], first) ? { r: 18, g: 52, b: 86 } : first
      const write = (bytes: string) => {
        state.writes.push(bytes)
        ctx.feed(bytes)
      }
      const seedRgb = [state.seed.r, state.seed.g, state.seed.b]
        .map((channel) => channel.toString(16).padStart(2, "0"))
        .join("/")
      write(`\x1b]${setCode};rgb:${seedRgb}\x07`)
      const seededRead = read()
      if ("colors" in seededRead) state.seeded = seededRead.colors
      write(`\x1b]${resetCode}\x07`)
      const restoredRead = read()
      if ("colors" in restoredRead) state.restored = restoredRead.colors
      const { seeded, restored } = state
      if (!seeded || !restored) return review("seeded or restored default colors could not be read")
      if (!equal(seeded[slot], state.seed)) return review("distinct seed was not verified")
      if (
        slots.some(
          (key) => key !== slot && (!equal(seeded[key], baseline[key]) || !equal(restored[key], baseline[key])),
        )
      ) {
        return review("a non-target default-color slot moved")
      }
      const expected = `OSC ${resetCode} restores the measured ${slot} default after a verified distinct seed`
      if (equal(restored[slot], baseline[slot])) return parserStateResult(true, expected, state)
      if (equal(restored[slot], state.seed)) return parserStateResult(false, expected, state)
      return review("reset produced neither the baseline nor the verified seed")
    }
    let silence: ProbeCallbackResult | null = null
    let initialSentinel: TerminalQueryOutcome | undefined
    if (ctx.queryWithSentinelOutcome) {
      initialSentinel = ctx.queryWithSentinelOutcome(query, replyPattern)
      silence = sentinelSilenceResult(initialSentinel, `Complete OSC ${setCode} color reply`)
      if (silence && !hostColorSlot && !highlightColorSlot) return silence
    }
    const originalRaw = silence ? "" : ctx.feedCapture(query)
    const original = replyPattern.exec(originalRaw)?.[1]
    if (!original) {
      if (highlightColorSlot) {
        const audit = absentOscAudit(ctx.runtimeIdentity, setCode)
        if (originalRaw === "" && audit && audit === absentOscAudit(ctx.runtimeIdentity, resetCode)) {
          const fed = `\x1b[1;1H\x1b[2K\x1b]${setCode};rgb:${HIGHLIGHT_TEST_COLOURS[0]}\x07` + `\x1b]${resetCode}\x07X`
          ctx.feed(fed)
          const sentinel = ctx.getCell(0, 0)
          return parserStateResult(
            null,
            `${id}: the engine handles OSC ${setCode}/${resetCode} (highlight set and reset handlers exist at the pinned source)`,
            {
              query,
              originalRaw,
              initialSentinel,
              fed,
              sentinel,
              engineState: null,
              engineStateReason: "No highlight colour set or reset target state is exposed at this pin",
            },
            sentinel.char === "X" ? undefined : "No rendered X cell to evaluate",
            sentinel.char === "X"
              ? `${audit.sourceCitation}: no case ${setCode}/${resetCode} handler or highlight colour writer; independent source review required`
              : undefined,
          )
        }
        const note = `OSC ${setCode} initial highlight colour was not read back, so OSC ${resetCode} cannot be compared with it`
        return {
          ...(originalRaw === "" && !silence ? replyFailure(note) : {}),
          pass: false,
          note: undefined,
          response: JSON.stringify({ query, originalRaw, initialSentinel }),
          tests: [
            {
              id: "criterion",
              status: "test-failure",
              reason: note,
            },
          ],
        }
      }
      if (originalRaw === "") {
        if (!hostColorSlot) {
          if (
            index === undefined &&
            (setCode === 13 || setCode === 14) &&
            resetCode === setCode + 100 &&
            ctx.getDefaultColors
          ) {
            return parserStateResult(
              null,
              `OSC ${resetCode} restores the prior OSC ${setCode} color after a verified change`,
              { query, originalRaw, defaultColors: ctx.getDefaultColors() },
              undefined,
              `OSC ${setCode} initial colour readback is missing and OSC ${resetCode} reset was not observed; default-color readback reports only fg, bg, and cursor, so pointer-colour support requires source review`,
            )
          }
          return colorReadbackReviewResult(
            `OSC ${setCode} colour query before OSC ${resetCode} answered nothing, so the reset effect cannot be read back`,
            { query, originalRaw },
          )
        }
        const answer = (result: ProbeCallbackResult) =>
          nativeHostRecipeResult(ctx, result, "color-request", hostInput, query, true)
        const controls: { write: string; response: string }[] = []
        // Capture-only sources cannot provide the additional cell witness; keep their existing query criterion.
        const indexed = setCode === 4 && resetCode === 104 && index === 0 && typeof ctx.getCell === "function"
        type Cell = ReturnType<LibProbeSource["getCell"]>
        const cells = {
          writes: [] as string[],
          before: null as Cell | null,
          seeded: null as Cell | null,
          same: null as Cell | null,
          fresh: null as Cell | null,
        }
        const paint = (col: number, char: string) => {
          const write = `\x1b[1;${col + 1}H\x1b[38;5;0m${char}\x1b[0m`
          cells.writes.push(write)
          ctx.feed(write)
          return globalThis.structuredClone(ctx.getCell(0, col))
        }
        if (indexed) cells.before = paint(0, "D")
        const reset = `\x1b]${resetCode}${index === undefined ? "" : `;${index}`}\x07`
        const capture = (write: string) => {
          const response = ctx.feedCapture(write)
          controls.push({ write, response })
          if (indexed && write === `\x1b]4;0;${seededCurrentColor}\x07`) cells.seeded = paint(1, "S")
          if (indexed && write === reset) {
            cells.same = globalThis.structuredClone(ctx.getCell(0, 1))
            cells.fresh = paint(2, "F")
          }
          return response
        }
        const { control, resetRaw } = seedColorReadbackAndReset(
          capture,
          `${setCode}${index === undefined ? "" : `;${index}`}`,
          replyPattern,
          reset,
        )
        const restoredRaw = capture(query)
        const state = { query, originalRaw, controls, ...(indexed && { cells, ...(silence && { initialSentinel }) }) }
        const response = JSON.stringify(state)
        const rgb = (cell: Cell | null, char: string) =>
          cell?.char === char &&
          cell.fg &&
          [cell.fg.r, cell.fg.g, cell.fg.b].every((n) => Number.isInteger(n) && n >= 0 && n <= 255)
            ? cell.fg
            : null
        const before = rgb(cells.before, "D"),
          seeded = rgb(cells.seeded, "S")
        const same = rgb(cells.same, "S"),
          fresh = rgb(cells.fresh, "F")
        const seed = { r: 170, g: 187, b: 204 }
        const restored = replyPattern.exec(restoredRaw)?.[1]
        // On @xterm/headless, the per-instance palette array mirrors _core._inputHandler.onColor
        // events, so OSC 4 grades the engine-delivered (index, rgb) event and OSC 104 grades the
        // typed restore event rather than the restored default value, which is ours (#31735, @cto 863bef67).
        if (indexed && before && seeded && !sameRgbCells(before, seed) && sameRgbCells(seeded, seed)) {
          if (
            same &&
            fresh &&
            sameRgbCells(fresh, before) &&
            !(restored && sameRgbText(restored, seededCurrentColor))
          ) {
            return answer(
              parserStateResult(
                true,
                "OSC 104 restores palette index 0 for a fresh indexed cell",
                state,
                sameRgbCells(same, before)
                  ? "Indexed colour resolved at read"
                  : sameRgbCells(same, seed)
                    ? "Cell RGB resolved at paint; fresh cell proves reset"
                    : "Stored cell RGB differs from default and seed; fresh cell proves reset",
              ),
            )
          }
          if (same && fresh && sameRgbCells(fresh, seed) && sameRgbCells(same, seed)) {
            return answer(
              parserStateResult(
                false,
                "OSC 104 restores palette index 0 for a fresh indexed cell",
                state,
                "Verified seed remains in the fresh cell after reset",
              ),
            )
          }
          return answer(
            colorReadbackReviewResult(
              "OSC 104 post-reset indexed readings are missing or contradictory; independent review required",
              state,
            ),
          )
        }
        if (control.verified && resetRaw === "" && restoredRaw === "") {
          return answer(
            colorReadbackReviewResult(
              `OSC ${setCode} seeded colour was verified but OSC ${resetCode} restored an unreadable embedder-owned default`,
              state,
            ),
          )
        }
        if (control.verified && restored && sameRgbText(restored, seededCurrentColor)) {
          return answer({
            pass: false,
            response,
            observation: { outcome: "unsupported", assertionType: "query_reply" },
            assertions: [
              {
                assertionType: "query_reply",
                kind: "negative",
                expected: `OSC ${resetCode} changes the verified seeded colour back to its default`,
                observed: response,
              },
            ],
          })
        }
        if (silence) {
          // A verified control established a live path, so the initial silence no longer decides (@cto 758ee3b5).
          if (control.verified) {
            return answer(
              colorReadbackReviewResult(
                `OSC ${resetCode}: reset produced neither the baseline nor the verified seed; independent review required`,
                state,
              ),
            )
          }
          // Keep the deciding DA1 bytes intact; every host slot's control evidence accompanies its assertion.
          return answer(
            silence.observation
              ? { ...silence, assertions: silence.assertions?.map((assertion) => ({ ...assertion, note: response })) }
              : silence,
          )
        }
        if (control.setterRaw === "" && control.seededRaw === "" && resetRaw === "" && restoredRaw === "") {
          return answer(
            colorReadbackReviewResult(
              `OSC ${setCode} initial and seeded queries answered nothing, so OSC ${resetCode} reset readback needs independent review`,
              state,
            ),
          )
        }
        return answer({
          ...oscReplyResult(originalRaw, null, `OSC ${setCode} color before reset`),
          response,
        })
      }
      return oscReplyResult(originalRaw, null, `OSC ${setCode} color before reset`)
    }
    const requested = probeForeground(original)
    let mustReset = false
    let primary: { error: unknown } | undefined
    try {
      mustReset = true
      ctx.feed(`\x1b]${setCode};${indexPart}${requested}\x07`)
      const changedRaw = ctx.feedCapture(query)
      const changed = replyPattern.exec(changedRaw)?.[1]
      ctx.feed(`\x1b]${resetCode}${index === undefined ? "" : `;${index}`}\x07`)
      mustReset = false
      const restoredRaw = ctx.feedCapture(query)
      const restored = replyPattern.exec(restoredRaw)?.[1]
      const response = JSON.stringify({ originalRaw, changedRaw, restoredRaw })
      if (!changed || !restored) {
        return {
          pass: false,
          response,
          observation: {
            outcome: "inconclusive",
            reason: "insufficient-evidence",
            assertionType: "query_reply",
            note: "Color mutation or readback control was not established",
          },
        }
      }
      if (!sameRgbText(changed, requested)) {
        if (highlightColorSlot) {
          return {
            pass: false,
            response,
            observation: {
              outcome: "inconclusive",
              reason: "insufficient-evidence",
              assertionType: "query_reply",
              note: `OSC ${setCode} highlight seed was not verified, so OSC ${resetCode} was not qualified`,
            },
          }
        }
        return colorSetIgnoredResult(response, setCode)
      }
      const pass = sameRgbText(restored, original)
      return {
        pass,
        response,
        observation: { outcome: pass ? "supported" : "unsupported", assertionType: "query_reply" },
        assertions: [
          {
            assertionType: "query_reply" as const,
            kind: pass ? "positive" : "negative",
            expected: `OSC ${resetCode} restores the prior OSC ${setCode} color after a verified change`,
            observed: response,
          },
        ],
      }
    } catch (error) {
      primary = { error }
      throw error
    } finally {
      if (mustReset || highlightColorSlot) {
        try {
          ctx.feed(
            highlightColorSlot
              ? `\x1b]${setCode};${original}\x07`
              : `\x1b]${resetCode}${index === undefined ? "" : `;${index}`}\x07`,
          )
        } catch (cleanup) {
          if (primary) {
            const message = primary.error instanceof Error ? primary.error.message : String(primary.error)
            throw new AggregateError([primary.error, cleanup], `${message}; colour reset cleanup failed`, {
              cause: primary.error,
            })
          }
          throw cleanup
        }
      }
    }
  }
}

const foregroundQuery = "\x1b]10;?\x07"
const foregroundReply = /\x1b\]10;(rgb:[a-f\d]{1,4}\/[a-f\d]{1,4}\/[a-f\d]{1,4})(?:\x07|\x1b\\)/i
const colorPush = "\x1b]30001\x1b\\"
const colorPop = "\x1b]30101\x1b\\"

function foregroundValue(response: string): string | null {
  return foregroundReply.exec(response)?.[1] ?? null
}

function colorSetIgnoredResult(response: string, setCode: number): ProbeCallbackResult {
  return {
    pass: false,
    response,
    observation: {
      outcome: "unsupported",
      assertionType: "query_reply",
      note: "OSC set did not change the queried color",
    },
    assertions: [
      {
        assertionType: "query_reply" as const,
        kind: "negative",
        expected: `OSC ${setCode} changes the queried color`,
        observed: response,
      },
    ],
  }
}

function sameRgbText(left: string, right: string): boolean {
  const channels = (color: string) =>
    color
      .slice(4)
      .split("/")
      .map((channel) => Math.round((parseInt(channel, 16) / (16 ** channel.length - 1)) * 65535))
  const actual = channels(left)
  const expected = channels(right)
  return actual.every((channel, index) => channel === expected[index])
}

function probeForeground(before: string): string {
  return sameRgbText(before, "rgb:aa/bb/cc") ? "rgb:12/34/56" : "rgb:aa/bb/cc"
}

/**
 * App-side reset exchange (27832): read the colour, set it, read the change back, reset it, read
 * the restoration back — the termless restore discipline against a real terminal. The collector
 * runs this only with a verified disposable receipt or a verified run-scoped process owner, so
 * mutation is confined to that disposable machine or process; a failed restore is graded, never retried into a pass.
 */
async function colorResetAppProbe(
  ctx: TermProbeSource,
  spec: { setCode: number; resetCode: number; index?: number },
): Promise<ProbeCallbackResult> {
  const indexPart = spec.index === undefined ? "" : `${spec.index};`
  const query = `\x1b]${spec.setCode};${indexPart}?\x07`
  const reply = new RegExp(
    `\\x1b\\]${spec.setCode};${indexPart}(rgb:[0-9a-f]{1,4}/[0-9a-f]{1,4}/[0-9a-f]{1,4})(?:\\x07|\\x1b\\\\)`,
    "i",
  )
  const read = async () => {
    const outcome = await ctx.queryWithSentinelOutcome(query, reply)
    return { outcome, rgb: outcome.match?.[1] ?? null }
  }
  const before = await read()
  if (!before.rgb) {
    return oscReplyResult(before.outcome.raw, null, `Complete OSC ${spec.setCode} color reply`, before.outcome.sentinel)
  }
  const requested = probeForeground(before.rgb)
  const reset = `\x1b]${spec.resetCode}${spec.index === undefined ? "" : `;${spec.index}`}\x07`
  ctx.write(`\x1b]${spec.setCode};${indexPart}${requested}\x07`)
  const changed = await read()
  ctx.write(reset)
  const restored = await read()
  const response = JSON.stringify({
    originalRaw: before.outcome.raw,
    changedRaw: changed.outcome.raw,
    restoredRaw: restored.outcome.raw,
  })
  if (!changed.rgb || !restored.rgb) {
    return {
      pass: false,
      response,
      observation: {
        outcome: "inconclusive",
        reason: "insufficient-evidence",
        assertionType: "query_reply",
        note: "Color mutation or readback control was not established",
      },
    }
  }
  if (!sameRgbText(changed.rgb, requested)) {
    return colorSetIgnoredResult(response, spec.setCode)
  }
  const pass = sameRgbText(restored.rgb, before.rgb)
  return {
    pass,
    response,
    observation: { outcome: pass ? "supported" : "unsupported", assertionType: "query_reply" },
    assertions: [
      {
        assertionType: "query_reply" as const,
        kind: pass ? "positive" : "negative",
        expected: `OSC ${spec.resetCode} restores the prior OSC ${spec.setCode} color after a verified change`,
        observed: response,
      },
    ],
  }
}

/** The reset features mutate and read back, so they require verified disposable authority. */
function resetProbe(id: string, setCode: number, resetCode: number, index?: number): ProbeDefinition {
  return {
    ...probe(
      id,
      colorResetProbe(id, setCode, resetCode, index),
      (ctx) => colorResetAppProbe(ctx, { setCode, resetCode, index }),
      "query_reply",
    ),
    termNeedsDisposable: true,
    ...([4, 10, 11, 12].includes(setCode)
      ? {
          libHostRecipes: [
            {
              recipe: "color-request" as const,
              query: `\x1b]${setCode};${index === undefined ? "" : `${index};`}?\x07`,
              missing: [
                setCode === 10
                  ? ("foreground-rgb" as const)
                  : setCode === 11
                    ? ("background-rgb" as const)
                    : setCode === 12
                      ? ("cursor-rgb" as const)
                      : ("palette-entry-rgb" as const),
              ],
            },
          ],
        }
      : {}),
  }
}

/** Three distinct foregrounds, none equal to the current one, so every pass value is non-default (#31904). */
function colorStackColors(before: string): { a: string; b: string; c: string } {
  const [a = "", b = "", c = ""] = ["rgb:12/34/56", "rgb:aa/bb/cc", "rgb:65/43/21", "rgb:de/ad/be"].filter(
    (color) => !sameRgbText(color, before),
  )
  // Four candidates and one excluded current colour always leave three.
  return { a, b, c }
}

/**
 * Per-operation colour-stack grade (#31904, @cto 6e4f7300). The POP fixture (set A, push, set B,
 * pop) and the PUSH fixture (set A, set B, push, set C, pop) both run; none of A, B or C is the
 * foreground the run started with. A set the reply does not show leaves the stack unobservable: a
 * coverage record (TEST TODO, null review), never a negative, as the palette arm treats a failed
 * OSC 4 calibration (#32242, @cto 4115d1bf).
 */
function colorStackResult(
  operation: "push" | "pop",
  before: string,
  colors: { a: string; b: string; c: string },
  popFixture: { changed: string; restored: string },
  pushFixture: { changed: string; restored: string },
): ProbeCallbackResult {
  const id = operation === "push" ? "extensions.osc30001-color-stack-push" : "extensions.osc30101-color-stack-pop"
  const expected =
    operation === "push"
      ? `OSC 30001 color-stack push saves the foreground current at push time: after set ${colors.a}, set ${colors.b}, push, set ${colors.c}, pop, ${colors.b} is restored`
      : `OSC 30101 color-stack pop restores the pushed foreground: after set ${colors.a}, push, set ${colors.b}, pop, ${colors.a} is restored`
  const state = { id, before, colors, popFixture, pushFixture }
  if (!sameRgbText(popFixture.changed, colors.b) || !sameRgbText(pushFixture.changed, colors.c)) {
    return notTestedResult("an OSC 10 foreground set reflected in the queried color", state)
  }
  const pop: StackReading = sameRgbText(popFixture.restored, colors.a)
    ? "restored"
    : sameRgbText(popFixture.restored, colors.b)
      ? "persisted"
      : "other"
  const push: StackReading = sameRgbText(pushFixture.restored, colors.b)
    ? "restored"
    : sameRgbText(pushFixture.restored, colors.a)
      ? "earlier"
      : sameRgbText(pushFixture.restored, colors.c)
        ? "persisted"
        : "other"
  const verdict = stackVerdict(operation, pop, push)
  return stackStateResult(verdict, expected, { ...state, pop, push }, "query_reply")
}

/** Source identities qualify a required review, never the target effect itself. */
const ABSENT_OSC_ENGINES = {
  vt100: {
    kind: "source",
    runtimeFormat: "js",
    engineVersion: "0.10.1",
    repository: "git@github.com:beorn/vterm.git",
    treeOid: "b941dae48b25ae8825c394750bda5245c9d93dfa",
    codes: [1, 8, 9, 17, 19, 22, 52, 117, 119, 133, 176, 440, 555, 633, 666, 710, 777, 1337, 3008],
    subcodes: ["133;D"],
    reviewReasons: [{ code: 1, reason: "screen.ts:505-520 case 1 is ignored; no icon-name state is stored" }],
    sourceCitation:
      "vt100 9e99e4d23cdc606fca258b1863aa2be7ae79eed3 packages/vt100/src/screen.ts:505-520 handleOSC switch, cases 0/1/2 only",
    absentSixel: true,
    sixelSourceCitation:
      "vt100 9e99e4d23cdc606fca258b1863aa2be7ae79eed3 packages/vt100/src/screen.ts:570-571 ESC P enters the dcs state and :681-686 discards every byte until ESC, so a DCS q Sixel payload is dropped with no image store",
  },
  vt220: {
    kind: "source",
    runtimeFormat: "js",
    engineVersion: "0.10.1",
    repository: "git@github.com:beorn/vterm.git",
    treeOid: "4205f8936ad1848d1029729f3ada888cd61759a8",
    codes: [1, 8, 9, 17, 19, 22, 52, 117, 119, 133, 176, 440, 555, 633, 666, 710, 777, 1337, 3008],
    subcodes: ["133;D"],
    reviewReasons: [{ code: 1, reason: "screen.ts:701-716 case 1 is ignored; no icon-name state is stored" }],
    sourceCitation:
      "vt220 9e99e4d23cdc606fca258b1863aa2be7ae79eed3 packages/vt220/src/screen.ts:701-716 handleOSC: no-semicolon return; cases 0/1/2 only",
    absentSixel: true,
    sixelSourceCitation:
      "vt220 9e99e4d23cdc606fca258b1863aa2be7ae79eed3 packages/vt220/src/screen.ts:766-767 ESC P enters the dcs state and :897-902 discards every byte until ESC, so a DCS q Sixel payload is dropped with no image store",
  },
  vterm: {
    kind: "source",
    runtimeFormat: "js",
    engineVersion: "0.10.1",
    repository: "git@github.com:beorn/vterm.git",
    treeOid: SOURCE_TREE_AUDITS.vterm.treeOid,
    osc9ProgressOnly: true,
    codes: [9, 22, 176, 440, 555, 666, 710, 777, 3008],
    reviewReasons: [
      {
        code: 9,
        reason:
          "screen.ts:3933-3935 notification sink stores every OSC 9 value, with no progress subcode or state interpretation",
      },
    ],
    sourceCitation:
      "vterm 67dd3960746766ed47e2bb4b2ced6503a78549cc packages/vterm/src/screen.ts:3608-4067 handleOSC switch",
  },
  xtermjs: {
    kind: "registry",
    engineVersion: "6.0.0",
    adapterVersion: "0.10.2",
    lockIntegrity: "sha512-5Yj1QINYCyzrZtf8OFIHi47iQtI+0qYFPHmouEfG8dHNxbZ9Tb9YGSuLcsEwj9Z+OL75GJqPyJbyoFer80a2Hw==",
    codes: [7, 9, 17, 19, 22, 52, 117, 119, 176, 440, 555, 666, 710, 777, 1337, 3008],
    absentSixel: true,
    sixelSourceCitation:
      "@xterm/headless 6.0.0 bundle SHA256 17a90b650cf6b77cce2b98c4063884d43545e4ce177a54b76ccfc906f1aacaed, map SHA256 780e782badc8189491a469c9277b783e01911882ea84417b31e71294ea927d98: InputHandler.ts:381 registers only DCS $q DECRQSS and :204-209 logs every other DCS through the fallback (DcsParser.ts:67-93); termless packages/xtermjs/src/backend.ts (blob 72dc827b2026af7736de722f7ff986a04f3fe883) loads only the Unicode11 addon (:249), no image addon, and reports sixel: false (:808), so a DCS q Sixel payload is dropped with no image store",
    sourceCitation:
      "@xterm/headless 6.0.0 bundle SHA256 17a90b650cf6b77cce2b98c4063884d43545e4ce177a54b76ccfc906f1aacaed, map SHA256 780e782badc8189491a469c9277b783e01911882ea84417b31e71294ea927d98: InputHandler.ts:292-338 OSC registrations (17/19/117/119 are comments only) and :201-203 logging-only fallback, OscParser.ts:145-146 fallback dispatch, CoreTerminal.ts:236-237 embedder hook; termless 9f0d4a5cbbeb2b7d9263ef7e07699df16a1cafc7 packages/xtermjs/src/backend.ts (blob 72dc827b2026af7736de722f7ff986a04f3fe883) registers no OSC handler",
  },
  libvterm: {
    kind: "source",
    runtimeFormat: "wasm",
    engineVersion: "0.3.3",
    adapterVersion: "0.10.2",
    binarySha256: "3d67045bb43c5e4081c70dc58088af8f735416c20df2d7843d765e5aad8ef62a",
    codes: [8, 9, 17, 19, 22, 117, 119, 176, 440, 555, 666, 710, 777, 3008],
    sourceCitation:
      "libvterm 9d6d2112335080312ef8c36667fa717ded4f7daf/v0.3.3 src/state.c:1777-1808 handles OSC 0/1/2/52 only; Termless f8d2aeb7a7a30f0215fd628bbbb1f1e5cd0a91be packages/libvterm/build/flat-api.c installs output and OSC52 selection callbacks only; src/backend.ts forwards native input and installs no OSC fallback",
  },
  ghostty: {
    kind: "source",
    runtimeFormat: "wasm",
    engineVersion: "0.4.0",
    adapterVersion: "0.10.2",
    binarySha256: "3c2398d5c537d9c10e86b0af69311977927fcdbe4738618df194cedbdd22574d",
    codes: [1, 176, 440, 555, 666, 710, 3008],
    reviewReasons: [
      {
        code: 1,
        reason: "core5714ed07 src/terminal/stream.zig:2017-2021 logs and ignores OSC 1; no icon-name state is stored",
      },
    ],
    sourceCitation:
      "Ghostty WASM core5714ed07a1012573261b7b7e3ed2add9c1504496 src/terminal/osc.zig:551-566,779-800,891-1002,1047-1075 parser states reject OSC176/3008/440/555/666/710; :1708-1715 returns null before ResponseHandler. Artifact3c2398d5c537d9c10e86b0af69311977927fcdbe4738618df194cedbdd22574d adds DECRPM, DA1/DA2, XTVERSION, DECRQSS and XTGETTCAP reply actions and no OSC handler; OSC9/777 binding losses and OSC22 mouse_shape are excluded",
  },
  libvterm712298af: {
    kind: "source",
    runtimeFormat: "wasm",
    engineVersion: "0.3.3",
    adapterVersion: "0.10.2",
    binarySha256: "712298aff45c7c53a22dc028b13cb58dae1e984199b520bbbc0475ae64d83159",
    codes: [8, 9, 17, 19, 22, 117, 119, 176, 440, 555, 666, 710, 777, 1337, 3008],
    absentSixel: true,
    sixelSourceCitation:
      "libvterm 9d6d2112335080312ef8c36667fa717ded4f7daf/v0.3.3 src/state.c:1897-1911 on_dcs handles only $q DECRQSS and passes every other DCS to state fallbacks; Termless 2f73fc28027b7d483e504e08edc64d1837935816 packages/libvterm/build/flat-api.c installs no fallbacks, so a DCS q Sixel payload is dropped with no image store",
    sourceCitation:
      "libvterm 9d6d2112335080312ef8c36667fa717ded4f7daf/v0.3.3 src/state.c:1777-1808 handles OSC0/1/2/52 only; vterm.c:13-18 zeroes the default allocator and screen.c:855-889 installs no unrecognised fallback. Termless 2f73fc28027b7d483e504e08edc64d1837935816 packages/libvterm/build/flat-api.c:96-104 installs output/OSC52 callbacks only, src/backend.ts:263-295 forwards native bytes and replies; receipt binds WASM712298af and flat API SHA2561e65f7e53d482b47fc08c5e324e26529079b5f9aa2ba0894d77608e12290c48e",
  },
  ghostty42e84af1: {
    kind: "source",
    runtimeFormat: "wasm",
    engineVersion: "0.4.0",
    adapterVersion: "0.10.2",
    binarySha256: "42e84af1b38be94571974a23fa4667c4735ee7a272dcff39afd5cba40dcf48de",
    codes: [1, 17, 19, 117, 119, 176, 440, 555, 666, 710, 3008],
    absentSixel: true,
    sixelSourceCitation:
      "Ghostty core5714ed07a1012573261b7b7e3ed2add9c1504496 src/terminal/dcs.zig:50-77 tryHook accepts only p (tmux control mode) without intermediates, so DCS q returns null and :36-39 ignores the hook with no image store; Termless 2f73fc28027b7d483e504e08edc64d1837935816 vendor/ghostty-web/RECEIPT.json binds WASM42e84af1 to that core",
    reviewReasons: [
      {
        code: 1,
        reason: "core5714ed07 src/terminal/stream.zig:2017-2021 logs and ignores OSC 1; no icon-name state is stored",
      },
      {
        code: 17,
        reason:
          "core5714ed07 osc.zig:779-790 rejects OSC17 without an allocator; shipped WASM42e84af1 uses ResponseStream.init, not initAlloc",
      },
      {
        code: 19,
        reason:
          "core5714ed07 osc.zig:813-825 rejects OSC19 without an allocator; shipped WASM42e84af1 uses ResponseStream.init, not initAlloc",
      },
      {
        code: 117,
        reason:
          "core5714ed07 osc.zig:657-676 rejects OSC117 without an allocator; shipped WASM42e84af1 uses ResponseStream.init, not initAlloc",
      },
      {
        code: 119,
        reason:
          "core5714ed07 osc.zig:657-676 rejects OSC119 without an allocator; shipped WASM42e84af1 uses ResponseStream.init, not initAlloc",
      },
    ],
    sourceCitation:
      "Ghostty core5714ed07a1012573261b7b7e3ed2add9c1504496 src/terminal/osc.zig:556-566,779-794,903-939,979-989 rejects OSC176/3008/440/555/666/710; :1708-1715 returns null, Parser.zig:270-273 emits no dispatch; stream.zig:2017-2021 ignores OSC1. OSC17/19/117/119 require an allocator at osc.zig:657-676,779-825; Parser.zig:230 starts null and stream.zig:497-509 assigns it only through initAlloc. Termless 25089207e11420cf7a588987c1dc2683a45e8372 vendor/ghostty-web/RECEIPT.json binds shipped ghostty-web0.4.0 WASM42e84af1, core archive55cee285 and inner patch2a42e7e9, whose ghostty-wasm-api.patch:1025 calls ResponseStream.init without an allocator; packages/ghostty/src/backend.ts:376-395 forwards input without another parser. This is the shipped library artifact, not the Ghostty app; OSC9/777 binding losses and OSC22 mouse_shape remain excluded",
  },
  kitty: {
    kind: "native",
    engineVersion: "0.49.2",
    adapterVersion: "0.10.2",
    binarySha256: "bb65c2d57e56eecca8143d73771432cf7dd386bccd36ae658950e5923a661886",
    sourceCommit: "b2cb871254fbdac19a085188813c8dfb258b95cd",
    buildHash: "88e840e1b8e7f09edf3464ee33df8753fd5107838de15bccb6ea59e0dd6cc9c3",
    lockSha256: "282d1098337a5705a7c1d13188a74d2fe34565766619e8d6b21a48d5b67451be",
    codes: [176, 440, 555, 666, 710, 3008],
    reviewReasons: [
      { code: 440, reason: "kitty/vt-parser.c:653 explicitly ignores OSC440 audio" },
      { code: 666, reason: "kitty/vt-parser.c:655 explicitly ignores OSC666 term properties" },
      {
        code: 3008,
        reason:
          "kitty/vt-parser.c:658-661 dispatches osc_context; kitty/window.py:1582-1583 is empty and Termless packages/kitty/build/bridge.py:243 maps it to no_reply",
      },
    ],
    sourceCitation:
      "kitty0.49.2 sourceb2cb871254fbdac19a085188813c8dfb258b95cd kitty/vt-parser.c:546-670 has no cases176/555/710, explicitly ignores440/666, and dispatches3008 to the empty Window.osc_context; official-binary archive SHA256d573618b911e9c461bd421b96c13c74c7f1cb2f1ac9c327818d4ff84366cf5c6; Termless 785d8a9e026ed173a45a6e62642dc70ed7c162f6 packages/kitty/build/bridge.py:239-257. OSC9/777 binding losses and OSC22 pointer handler are excluded",
  },
  ghosttyNative: {
    kind: "native",
    engineVersion: "1.3.1",
    adapterVersion: "0.10.2",
    binarySha256: "53f9a867cce594b4d50fb9508db9ce5d2d79fb4244a418548b7cb31fa50780d1",
    sourceCommit: "332b2aefc6e72d363aa93ab6ecfc86eeeeb5ed28",
    buildHash: "2d5e53cf4f0846e47cda8a45c513f44da5c699657edffe93886e6eba99f36bfd",
    lockSha256: "3ec775507556db01d08055836b26183f629a9cbb0b5802a1566661e95988d74a",
    codes: [1, 176, 440, 555, 666, 710, 3008],
    reviewReasons: [
      {
        code: 1,
        reason: "core332b2aef src/terminal/stream.zig:1982-1986 logs and ignores OSC 1; no icon-name state is stored",
      },
      {
        code: 3008,
        reason: "parsed by osc.zig:747 context_signal, dropped unimplemented at stream.zig:2056-2059",
      },
    ],
    sourceCitation:
      "Ghostty 332b2aefc6e72d363aa93ab6ecfc86eeeeb5ed28 src/terminal/osc.zig:535-641 rejects OSC176/440/555/666/710; :747 parses OSC3008 context_signal, dropped at src/terminal/stream.zig:2050-2059 (SHA256 3ddc5e27d6a6f48ea99399bb886b52e7bebb68c94397a3ba008a7c3eb6c01a9b); Termless 8bd0516ad101cc088133beb20fa9e92f86250da8 packages/ghostty-native/native/src/main.zig:38-39 wraps ReadonlyHandler, :76 forwards unhandled actions to readonly.vt, :85 creates ResponseStream and :141 initializes Terminal.vtHandler",
  },
  ghosttyNative0effe403: {
    kind: "native",
    engineVersion: "1.3.1",
    adapterVersion: "0.10.2",
    binarySha256: "53f9a867cce594b4d50fb9508db9ce5d2d79fb4244a418548b7cb31fa50780d1",
    sourceCommit: "332b2aefc6e72d363aa93ab6ecfc86eeeeb5ed28",
    buildHash: "0effe4038bf65ba00048b016bc70477d80b6c16302e56e769ef773d46b790768",
    lockSha256: "3ec775507556db01d08055836b26183f629a9cbb0b5802a1566661e95988d74a",
    codes: [17, 19, 117, 119],
    reviewReasons: [
      {
        code: 17,
        reason:
          "core332b2aef Terminal.zig:132-145 has no highlight background state; stream_readonly.zig:290-361 ignores its set and query",
      },
      {
        code: 19,
        reason:
          "core332b2aef Terminal.zig:132-145 has no highlight foreground state; stream_readonly.zig:290-361 ignores its set and query",
      },
      {
        code: 117,
        reason:
          "core332b2aef Terminal.zig:132-145 has no highlight background state; stream_readonly.zig:290-361 ignores its reset",
      },
      {
        code: 119,
        reason:
          "core332b2aef Terminal.zig:132-145 has no highlight foreground state; stream_readonly.zig:290-361 ignores its reset",
      },
    ],
    sourceCitation:
      "libghostty-vt332b2aefc6e72d363aa93ab6ecfc86eeeeb5ed28 Terminal.zig:69,132-145 owns background, foreground, cursor and palette only, no highlight colour state. lib_vt.zig:60-63 exports generic Stream plus only the stock Readonly handler; Terminal.zig:260-270 returns ReadonlyStream; stream_readonly.zig:290-361 ignores highlight set/reset/query. include/ghostty/vt.h:29-36,75-82 exposes no terminal handler/state C API. Termless25089207e11420cf7a588987c1dc2683a45e8372 packages/ghostty-native/native/src/main.zig:31-78 delegates colour operations to that handler and :141 uses initAlloc; backend.ts:257-270 forwards actual replies. The loaded native53f9a867 receipt binds buildHash0effe403 and lock3ec77550; this describes the shipped headless library, not the Ghostty app",
  },
  ghosttyNative2d5e53cf: {
    kind: "native",
    engineVersion: "1.3.1",
    adapterVersion: "0.10.2",
    binarySha256: "53f9a867cce594b4d50fb9508db9ce5d2d79fb4244a418548b7cb31fa50780d1",
    sourceCommit: "332b2aefc6e72d363aa93ab6ecfc86eeeeb5ed28",
    buildHash: "2d5e53cf4f0846e47cda8a45c513f44da5c699657edffe93886e6eba99f36bfd",
    lockSha256: "3ec775507556db01d08055836b26183f629a9cbb0b5802a1566661e95988d74a",
    codes: [17, 19, 117, 119, 176],
    reviewReasons: [
      {
        code: 176,
        reason:
          "core332b2aef osc.zig:580-596 rejects the 6 in OSC176 at state17; :484-492 drops the invalid payload with no command",
      },
    ],
    sourceCitation:
      "libghostty-vt332b2aefc6e72d363aa93ab6ecfc86eeeeb5ed28 Terminal.zig:132-145 stores foreground/background/cursor/palette only; stream_readonly.zig:290-361 ignores highlight set/reset/query. Termless25089207e11420cf7a588987c1dc2683a45e8372 packages/ghostty-native/native/src/main.zig:31-78 delegates color operations to ReadonlyHandler and :141 uses initAlloc; backend.ts:257-270 forwards actual replies. The loaded native53f9a867 receipt binds buildHash2d5e53cf, lock3ec77550 and nativeTree77721d68; captured current adapter blobs are index35c9e35a/backendf403717f. This is the shipped headless library, not the Ghostty app. Ghostty332b2aefc6e72d363aa93ab6ecfc86eeeeb5ed28 src/terminal/osc.zig:507,544,580-596 (Git blob 0086e48bca4c329906b49c2fa95e08161fe63530, SHA256 5ebb4e72390408382c64d76f72bac68726a23a6043cd9afcea04876574283fb4) routes 1 then7 to state17, whose only accepted next byte is semicolon; the6 in176 enters invalid and :484-492 drops the payload. No OSC176 command reaches the bound readonly handler. Independent source review @dev/8 2026-11-03, 6196c3b3-f320-495b-861a-4312753ff1bf; the existing identity owner verifies loaded53f9a867/build2d5e53cf with current index35c9e35a/backendf403717f",
  },
  alacritty: {
    kind: "native",
    engineVersion: "0.26.0",
    adapterVersion: "0.10.2",
    binarySha256: "9839e138d9e6f13e84adc3022f67964f0451e2e6416294952e22286412994f61",
    absentMouseEncodings: [1015, 1016],
    mouseEncodingSourceCitation:
      "alacritty_terminal 0.26.0 src/term/mod.rs:55-87 TermMode stores SGR/UTF8 only; :1935-1941 ignores unknown private modes and :1958-1980 sets only SGR/UTF8 mouse encoding; vte 0.15.0 src/ansi.rs:896-933 PrivateMode mapping has no 1015/1016, so the previous encoding is retained",
    sourceCommit: "2f73fc28027b7d483e504e08edc64d1837935816",
    buildHash: "343c00e0db2bed851505ada4645b7b667ab78a0485a4ca71f9eaa4e5d8dead39",
    lockSha256: "1f89f2579b7d786a116d8fefb8267c4af076bd3a3893adcf14b00c4466740497",
    codes: [1, 9, 17, 19, 22, 117, 119, 176, 440, 555, 666, 710, 777, 1337, 3008],
    absentSixel: true,
    sixelSourceCitation:
      "vte 0.15.0 src/ansi.rs:1311-1326 Performer hook/put/unhook only log the unhandled DCS and never reach the alacritty_terminal 0.26.0 Handler (src/term/mod.rs:1059-2272), so a DCS q Sixel payload is dropped with no image store",
    reviewReasons: [
      {
        code: 1,
        reason:
          "vte 0.15.0 src/ansi.rs:1349-1361 dispatches OSC 0/2 title only, with no case 1; unmatched OSC logs at :1523 and no icon-name state is stored",
      },
      {
        code: 22,
        reason:
          "parsed by vte 0.15.0 src/ansi.rs:1455-1461 into set_mouse_cursor_icon; Handler default src/ansi.rs:703-704 is empty and alacritty_terminal 0.26.0 src/term/mod.rs:1059-2272 supplies no override",
      },
    ],
    sourceCitation:
      "alacritty_terminal 0.26.0 with vte 0.15.0 src/ansi.rs:1329-1523 OSC dispatch (22 parsed, other audited codes unhandled); src/term/mod.rs:1059-2272 Term Handler; Termless 2f73fc28027b7d483e504e08edc64d1837935816 packages/alacritty/native/src/lib.rs:286-339 owns Term<EventProxy> and advances the same vte processor into it; Cell.hidden readback changes leave Config, OSC dispatch and reply handling unchanged",
  },
  wezterm: {
    kind: "native",
    engineVersion: "0.1.0-fork.5",
    adapterVersion: "0.10.2",
    binarySha256: "6722b331de7489c14cb599d939e5d2314f054220728f83c5c29f454e70273e47",
    sourceCommit: "83b22ab3f99ff3c2f3e43bcfce346c1374f540e1",
    buildHash: "94a2d6025d3dc9e62debb7cbe388b3ad5113394d0ab6746d6baa58475fbe9c56",
    lockSha256: "8eaeab733cced8d47feb223d773d5ae158b2e6af8c994f993d4071d9ba3231d4",
    codes: [22, 176, 440, 555, 633, 666, 710, 720, 3008],
    subcodes: ["133;D"],
    reviewReasons: [
      {
        code: "133;D",
        reason: "parsed by osc.rs:793-806 into CommandStatus, dropped by the empty performer.rs:900-902 arm",
      },
      {
        code: 720,
        reason:
          "no case 720; wezterm-term src/screen.rs:15-45,335,493,522-527 stores screen/history, not a product viewport; Termless packages/wezterm/native/src/lib.rs:442-455 returns viewport_offset 0 and scroll_viewport is a no-op",
      },
    ],
    sourceCitation:
      "tattoy-wezterm-escape-parser 0.1.0-1 src/osc.rs:457-505 osc_entries (SHA256 fd26b6d6254c46ef880fbcc03ba418d67e9049c875e71cca6f18f4df76a0924f), parse errors become Unspecified at :155-167; tattoy-wezterm-term 0.1.0-fork.5 src/terminalstate/performer.rs:772-781 logs Unspecified; Termless 83b22ab3f99ff3c2f3e43bcfce346c1374f540e1 packages/wezterm/native/src/lib.rs:237-245 advances the same pinned Terminal; absolute-row reader changes leave parsing, config and reply delivery unchanged",
  },
  vt100Rust: {
    kind: "native",
    engineVersion: "0.16.2",
    adapterVersion: "0.10.2",
    binarySha256: "84a5b6a3a40a7c16c6bae8b64534b730403df911498bb34bded68c3a17e2d408",
    absentMouseEncodings: [1015, 1016],
    mouseEncodingSourceCitation:
      "vt100 0.16.2 src/screen.rs:39-52 MouseProtocolEncoding stores Default/Utf8/Sgr only; :1139-1213 DECSET/DECRST handles only 1005/1006 encoding and sends unhandled 1015/1016 to the callback without changing the previous encoding",
    sourceCommit: "286fddf6632e43ccd62f9050be41ec7b2908e43e",
    buildHash: "30b232d295488042b0d6164e881e319dea8d7fae06ac766b3b568fd4832bf074",
    lockSha256: "4cf037e4efa648ca41d08b30ef5c4ce7ada29ad61fcad45a7d1aa97bf55391c6",
    codes: [8, 9, 17, 19, 22, 117, 119, 176, 440, 555, 666, 710, 777, 1337, 3008],
    absentSixel: true,
    sixelSourceCitation:
      "vt100 0.16.2 src/perform.rs:33-263 vte::Perform impl defines print/execute/esc/csi/osc dispatch only; vte 0.15.0 src/lib.rs:779-789 default hook/put/unhook are no-ops, so a DCS q Sixel payload is consumed with no image store",
    sourceCitation:
      "vt100 0.16.2 src/perform.rs:198-238 dispatches unmatched OSCs to unhandled_osc; src/callbacks.rs:66 is a no-op; Termless packages/vt100-rust/native/src/lib.rs:21-54 at 286fddf6632e43ccd62f9050be41ec7b2908e43e installs title, icon and clipboard callbacks with no unhandled_osc override",
  },
  kittyCa46f3c2: {
    kind: "native",
    engineVersion: "0.49.2",
    adapterVersion: "0.10.2",
    binarySha256: "bb65c2d57e56eecca8143d73771432cf7dd386bccd36ae658950e5923a661886",
    sourceCommit: "b2cb871254fbdac19a085188813c8dfb258b95cd",
    buildHash: "88e840e1b8e7f09edf3464ee33df8753fd5107838de15bccb6ea59e0dd6cc9c3",
    lockSha256: "282d1098337a5705a7c1d13188a74d2fe34565766619e8d6b21a48d5b67451be",
    codes: [176],
    sourceCitation:
      "kitty0.49.2 source b2cb871254fbdac19a085188813c8dfb258b95cd kitty/vt-parser.c:546-670 (Git blob 50dc1e6d698be9ee9fb6bc687f4da65823c5cde1, SHA256 08dd5f733e466b72ec2ee6c5d5e2ea59e1e0fa898bd9f6a6f56a2c4c17629390) has no OSC176 arm and defaults to reporting an unknown code; current Termless25089207 packages/kitty/build/bridge.py blob ca46f3c2 forwards input to that parser without an app-id handler. Independent source review @dev/8 2026-11-03, 6196c3b3-f320-495b-861a-4312753ff1bf; the existing identity owner verifies loaded native bb65c2d5 and its receipt/build/lock against these adapter blobs",
  },
  weztermB4155bfd: {
    kind: "native",
    engineVersion: "0.1.0-fork.5",
    adapterVersion: "0.10.2",
    binarySha256: "b4155bfdef040ae8b3b723a4366fa8ec7f278463dbef577ec4730ad152b8bf07",
    sourceCommit: "80dd254111ab82279125555f9ca1e68b112cd7e3",
    buildHash: "dc7cc8afd1cdedfef0f972a00aca10fad92fafc4c0e9f019a2f67473e40a054b",
    lockSha256: "8eaeab733cced8d47feb223d773d5ae158b2e6af8c994f993d4071d9ba3231d4",
    codes: [176],
    sourceCitation:
      "tattoy-wezterm-escape-parser0.1.0-1 archive SHA256 7ca89ed38092d6718a03e97b0c1101fcf2203c2e6f2757a91c465f393d11d98b, src/osc.rs:457-505 SHA256 fd26b6d6254c46ef880fbcc03ba418d67e9049c875e71cca6f18f4df76a0924f has no176 mapping; :155-167 produces Unspecified. tattoy-wezterm-term0.1.0-fork.5 archive SHA256 7f3678674adc87f210ec01e2134e1972d6b0bd194bf82242f7e7beee3ae9dbd8, src/terminalstate/performer.rs:772-782 SHA256 6f53e3345e0911b7756815f8afdf015d7c6bf5d7ebe8ff450db2f3225ff1749d only optionally logs Unspecified, with no state or reply. Current Termless25089207 native/src/lib.rs advances that pinned Terminal without an alternate OSC handler. Independent source review @dev/8 2026-11-03, 6196c3b3-f320-495b-861a-4312753ff1bf and dispatcher f4cb516b-7485-4055-ace1-02ac435a1f73; the existing identity owner verifies loaded b4155bfd with source80dd2541/builddc7cc8af/lock8eaeab73",
  },
} as const

export function auditedOscEngine(identity: LibProbeSource["runtimeIdentity"], code?: number | "133;D") {
  const measured = evidenceRuntimeIdentity(identity)
  if (!measured) return undefined
  return Object.entries(ABSENT_OSC_ENGINES).find(([engine, expected]) => {
    const member =
      code === undefined ||
      (typeof code === "number"
        ? expected.codes.some((value) => value === code)
        : "subcodes" in expected && expected.subcodes.some((value) => value === code))
    if (
      measured.engineVersion !== expected.engineVersion ||
      !member ||
      !auditedAdapterSources(identity, engine as keyof typeof ABSENT_OSC_ENGINES)
    ) {
      return false
    }
    if (expected.kind === "native") {
      return (
        measured.kind === "native" &&
        measured.adapterVersion === expected.adapterVersion &&
        measured.loadedBinary.sha256 === expected.binarySha256 &&
        measured.provenance.sha256 === expected.binarySha256 &&
        measured.provenance.sourceCommit === expected.sourceCommit &&
        measured.provenance.buildHash === expected.buildHash &&
        measured.provenance.lockSha256 === expected.lockSha256
      )
    }
    if (measured.kind !== "js") return false
    if (expected.kind === "registry") {
      return (
        measured.runtimeFormat === "js" &&
        measured.integrity.kind === "registry" &&
        measured.adapterVersion === expected.adapterVersion &&
        measured.integrity.lockIntegrity === expected.lockIntegrity
      )
    }
    if (expected.runtimeFormat === "wasm") {
      return (
        measured.runtimeFormat === "wasm" &&
        measured.adapterVersion === expected.adapterVersion &&
        measured.loadedBinary.sha256 === expected.binarySha256
      )
    }
    return (
      measured.runtimeFormat === "js" &&
      measured.integrity.kind === "source" &&
      measured.integrity.cleanTree &&
      measured.integrity.repository === expected.repository &&
      measured.integrity.treeOid === expected.treeOid
    )
  })
}

function absentOscAudit(identity: LibProbeSource["runtimeIdentity"], code: number | "133;D") {
  return auditedOscEngine(identity, code)?.[1]
}

function auditedXtermState(
  source: Pick<LibProbeSource, "runtimeIdentity" | "getTitle" | "getIconLabel">,
): source is Pick<LibProbeSource, "runtimeIdentity" | "getTitle" | "getIconLabel"> & { getIconLabel(): string } {
  return (
    typeof source.getTitle === "function" &&
    typeof source.getIconLabel === "function" &&
    auditedOscEngine(source.runtimeIdentity)?.[0] === "xtermjs"
  )
}

function sourceAbsentOsc(id: string, code: number | "133;D", sequence: string, effect: string) {
  return (ctx: LibProbeSource): ProbeCallbackResult => {
    const identity = ctx.runtimeIdentity
    const audit = absentOscAudit(identity, code)
    if (!audit) {
      return notTestedResult(`OSC ${code} ${effect}: no audited library target readback at this runtime`, {})
    }
    const reviewReason =
      "reviewReasons" in audit ? audit.reviewReasons.find((entry) => entry.code === code)?.reason : undefined
    return sourceAbsentSentinel(
      ctx,
      `${id}: the engine handles OSC ${code} (a ${effect} handler exists at the pinned source)`,
      sequence,
      effect,
      reviewReason
        ? `${audit.sourceCitation}; ${reviewReason}`
        : `${audit.sourceCitation}: no case ${code} or ${effect} target writer`,
    )
  }
}

/**
 * The shared source-negative read: feed the sequence followed by an X sentinel at home. Only a rendered X, which
 * shows the parser left the sequence and resumed printing, lets the audited source citation carry the review.
 */
function sourceAbsentSentinel(
  ctx: LibProbeSource,
  expected: string,
  sequence: string,
  effect: string,
  citation: string,
): ProbeCallbackResult {
  const fed = "\x1b[1;1H\x1b[2K" + sequence + "X"
  ctx.feed(fed)
  const sentinel = ctx.getCell(0, 0)
  return parserStateResult(
    null,
    expected,
    {
      fed,
      sentinel,
      engineState: null,
      engineStateReason: `No ${effect} target state is exposed at this pin`,
    },
    sentinel.char === "X" ? undefined : "No rendered X cell to evaluate",
    sentinel.char === "X" ? `${citation}; independent source review required` : undefined,
  )
}

function promptConsumptionResult(consumed: boolean | null): ProbeCallbackResult {
  const note =
    consumed === null
      ? "No cursor reply after semantic prompt marker"
      : consumed
        ? "Marker was consumed; shell prompt integration was not observed"
        : "Marker consumption was not confirmed; shell prompt integration was not observed"
  return {
    pass: false,
    note,
    tests: [{ id: "criterion", status: consumed === null ? "test-failure" : "test-todo", reason: note }],
  }
}

/**
 * C154 — a consumed semantic prompt mark proves consumption, not that the mark registered.
 * Read the measured home / target / control sequence from the real cursor and cell state so a
 * provider that answers a constant cursor position cannot satisfy all three positions; only a
 * qualified sequence can witness new start markers through an exposed reader. Without one it
 * retains the applicable named review. A consumed-but-unqualified read, and a missing cell, stay
 * a real consumption observation — never not-tested.
 */
function promptMarkResult(
  ctx: LibProbeSource,
  sequence: string,
  noObservable: string,
  sourceReview?: { probeId: string; selector: number | "133;D"; markType?: "prompt" | "command" | "output" },
): ProbeCallbackResult {
  if (sourceReview && absentOscAudit(ctx.runtimeIdentity, sourceReview.selector)) {
    return sourceAbsentOsc(sourceReview.probeId, sourceReview.selector, sequence, noObservable)(ctx)
  }
  ctx.feed("\x1b[1;1H")
  const home = ctx.getCursor()
  const markType = sourceReview?.markType
  const commandEnd = sourceReview?.selector === "133;D"
  const readerKey = markType ? "semantic-marks" : commandEnd ? "semantic-command-end" : undefined
  const declared = readerKey !== undefined && ctx.capabilities.extensions.has(readerKey)
  const readMarks = declared ? ctx.getSemanticMarks?.bind(ctx) : undefined
  const before = readMarks ? readMarks() : undefined
  ctx.feed(sequence + "X")
  const first = readMarks ? readMarks() : undefined
  const cell = ctx.getCell(0, 0)
  const target = ctx.getCursor()
  ctx.feed("\x1b[1;1H")
  const control = ctx.getCursor()
  const consumed = cell.char === "X"
  const qualified =
    consumed && home.x === 0 && home.y === 0 && target.x === 1 && target.y === 0 && control.x === 0 && control.y === 0
  if (!qualified) return promptConsumptionResult(consumed)
  if (commandEnd && readMarks && before && first) {
    ctx.feed("\x1b[2;3H")
    const secondBefore = readMarks()
    const secondSequence = "\x1b]133;D;17\x07"
    ctx.feed(secondSequence + "X")
    const second = readMarks()
    const secondCell = ctx.getCell(1, 2)
    const secondCursor = ctx.getCursor()
    ctx.feed("\x1b[1;1H")
    const firstMark = first[before.length]
    const secondMark = second[secondBefore.length]
    return parserStateResult(
      first.length === before.length + 1 &&
        firstMark?.type === "command-end" &&
        firstMark.rawStatus === "0" &&
        second.length === secondBefore.length + 1 &&
        secondMark?.type === "command-end" &&
        secondMark.rawStatus === "17" &&
        before.every((mark, index) => JSON.stringify(mark) === JSON.stringify(first[index])) &&
        first.length === secondBefore.length &&
        first.every((mark, index) => JSON.stringify(mark) === JSON.stringify(secondBefore[index])) &&
        secondBefore.every((mark, index) => JSON.stringify(mark) === JSON.stringify(second[index])) &&
        secondCell.char === "X" &&
        secondCursor.x === 3 &&
        secondCursor.y === 1,
      "Each target feed appends exactly one command-end with its exact raw status and preserves earlier history",
      {
        sequence,
        secondSequence,
        home,
        target,
        control,
        cell: cell.char,
        before,
        first,
        secondBefore,
        second,
        secondCell: secondCell.char,
        secondCursor,
      },
    )
  }
  if (markType && readMarks && before && first) {
    ctx.feed("\x1b[2;3H")
    const secondBefore = readMarks()
    ctx.feed(sequence + "X")
    const second = readMarks()
    const secondCell = ctx.getCell(1, 2)
    const secondCursor = ctx.getCursor()
    ctx.feed("\x1b[1;1H")
    const firstMark = first[before.length]
    const secondMark = second[secondBefore.length]
    return parserStateResult(
      first.length === before.length + 1 &&
        firstMark?.type === markType &&
        firstMark.startRow === 0 &&
        firstMark.startCol === 0 &&
        before.every((mark, index) => JSON.stringify(mark) === JSON.stringify(first[index])) &&
        first.length === secondBefore.length &&
        first.every((mark, index) => JSON.stringify(mark) === JSON.stringify(secondBefore[index])) &&
        second.length === secondBefore.length + 1 &&
        secondMark?.type === markType &&
        secondMark.startRow === 1 &&
        secondMark.startCol === 2 &&
        secondBefore.every((mark, index) => JSON.stringify(mark) === JSON.stringify(second[index])) &&
        secondCell.char === "X" &&
        secondCursor.x === 3 &&
        secondCursor.y === 1,
      `Each target feed appends exactly one ${markType} start at its observed screen position`,
      {
        sequence,
        home,
        target,
        control,
        cell: cell.char,
        before,
        first,
        secondBefore,
        second,
        secondCell: secondCell.char,
        secondCursor,
      },
    )
  }
  if (declared) {
    const note = `${noObservable}: ${readerKey} getSemanticMarks readback is unavailable`
    return reviewResult(HEADLESS_OBSERVABLE_REVIEW, `Headless observable review required: ${note}`, note, {
      home,
      target,
      control,
      cell: cell.char,
      declared: true,
    })
  }
  return reviewResult(
    SEMANTIC_PROMPT_SOURCE_REVIEW,
    "Independent review must determine whether the pinned engine source parses this OSC 133 / 633 mark and exposes mark or zone state; citation per cell required for supported, unsupported or Untestable",
    noObservable,
    { home, target, control, cell: cell.char },
  )
}

/**
 * C154 app arm (§3.1/§3.2) — the callback's CPR JSON is recorded only when a measured home / target /
 * control sequence read from the real terminal qualifies it; a provider answering one constant position
 * cannot satisfy all three. `notTestedResult` carries the CPR JSON as the callback response, which the
 * collector keeps in `<probe>.callbackResponse`, apart from the serialized transport trace it binds
 * `rawReplyRef` to — no not-tested coverage is claimed from CPR alone. A null read, or a mark that never
 * advanced, stays a real consumption observation, never not-tested.
 */
async function promptMarkAppResult(
  ctx: TermProbeSource,
  sequence: string,
  noObservable: string,
): Promise<ProbeCallbackResult> {
  ctx.write("\x1b[1;1H\x1b[2K")
  const home = await ctx.queryCursorPosition()
  ctx.write(sequence + "X")
  const target = await ctx.queryCursorPosition()
  ctx.write("\x1b[1;1H")
  const control = await ctx.queryCursorPosition()
  if (home === null || target === null || control === null) return promptConsumptionResult(null)
  const consumed = target.row === home.row && target.col === home.col + 1
  const qualified =
    consumed &&
    home.row === 1 &&
    home.col === 1 &&
    target.row === 1 &&
    target.col === 2 &&
    control.row === 1 &&
    control.col === 1
  if (!qualified) {
    const result = promptConsumptionResult(consumed)
    // Only this native nonnull fallback previously carried the consumed observation. Its lib
    // sibling and missing-CPR failure never acquired the native capture diagnostic.
    return {
      ...result,
      tests: [
        {
          id: "criterion",
          status: "test-todo",
          reason: `${result.note}${ctx.captureGeometryRefusal ? `; Pixel capture unavailable: ${ctx.captureGeometryRefusal}` : ""}`,
        },
      ],
    }
  }
  return notTestedResult(noObservable, { home, target, control })
}

function colorStackError(actionKind: "query" | "behavior", action: string, error: unknown): ProbeCallbackResult {
  if (!(error instanceof Error)) throw error
  const note = `${action} (${actionKind}) failed: ${error.name}: ${error.message}`
  return { pass: false, note, tests: [{ id: "criterion", status: "test-failure", reason: note }] }
}

function colorStackProbe(ownSequence: typeof colorPush | typeof colorPop): ProbeDefinition["lib"] {
  return (ctx) => {
    const operation = ownSequence === colorPush ? "push" : "pop"
    let silence: ProbeCallbackResult | null = null
    if (ctx.queryWithSentinelOutcome) {
      silence = sentinelSilenceResult(
        ctx.queryWithSentinelOutcome(foregroundQuery, foregroundReply),
        "Complete OSC 10 foreground color reply",
      )
      if (silence && ctx.runtimeIdentity?.kind !== "native") return silence
    }
    let result: ProbeCallbackResult | undefined
    let primaryError: unknown
    let originalRaw: string | undefined
    let foregroundRaw = ""
    let seedAttempted = false
    let fixtureVerified = false
    let readbackUnavailable = false
    let comparison: object | undefined
    const trace: Array<{ write: string; response?: string; error?: string }> = []
    const capture = (write: string, entry: (typeof trace)[number] = { write }) => {
      trace.push(entry)
      try {
        const response = ctx.feedCapture(write)
        entry.response = response
        return response
      } catch (error) {
        entry.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
        throw error
      }
    }
    const queryForeground = (action: string): string | ProbeCallbackResult | null => {
      let response: string
      try {
        response = seedAttempted ? capture(foregroundQuery) : ctx.feedCapture(foregroundQuery)
      } catch (error) {
        primaryError = error
        return colorStackError("query", action, error)
      }
      originalRaw ??= response
      foregroundRaw = response
      return foregroundValue(response)
    }
    const feed = (sequence: string, action: string): ProbeCallbackResult | undefined => {
      try {
        if (seedAttempted) capture(sequence)
        else ctx.feed(sequence)
        return undefined
      } catch (error) {
        primaryError = error
        return colorStackError("behavior", action, error)
      }
    }
    let before = queryForeground("Original foreground query")
    if (before !== null && typeof before !== "string") return before
    if (!before && originalRaw !== "") {
      const note = `Malformed OSC 10 reply: ${JSON.stringify(originalRaw)}`
      return {
        pass: false,
        response: JSON.stringify({ query: foregroundQuery, originalRaw }),
        note,
        tests: [{ id: "criterion", status: "test-failure", reason: note }],
      }
    }
    let pushed = false
    let unexpectedlyFailed = false
    try {
      if (!before) {
        trace.push({ write: foregroundQuery, response: originalRaw })
        // The setter can mutate and then throw: cleanup ownership precedes the attempt.
        seedAttempted = true
        let setupKind: "query" | "behavior" = "behavior"
        let setupAction = "Fixture foreground setter"
        let control: ReturnType<typeof seedColorReadback>
        try {
          control = seedColorReadback(
            (write) => {
              setupKind = write === foregroundQuery ? "query" : "behavior"
              setupAction = write === foregroundQuery ? "Fixture foreground query" : "Fixture foreground setter"
              return capture(write)
            },
            "10",
            foregroundReply,
          )
        } catch (error) {
          primaryError = error
          result = colorStackError(setupKind, setupAction, error)
          return result
        }
        if (!control.verified || control.color === null) {
          if (control.setterRaw === "" && control.seededRaw === "") {
            result =
              silence ??
              colorReadbackReviewResult(
                "OSC 10 initial and seeded foreground queries answered nothing, so the colour-stack effect has no readback",
                { query: foregroundQuery, originalRaw },
              )
          } else {
            const note = "Current-colour fixture setter or exact seeded readback was not established"
            result = { pass: false, note, tests: [{ id: "criterion", status: "test-failure", reason: note }] }
          }
          readbackUnavailable = result !== silence
          return result
        }
        before = control.color
        fixtureVerified = true
      }
      const colors = colorStackColors(before)
      // One fixture: optional earlier sets, push, a mutation, pop; each read after the mutation and
      // after the pop (#31904). The POP fixture sets A; the PUSH fixture sets A then B.
      const fixture = (
        label: string,
        sets: readonly string[],
        mutation: string,
      ): { changed: string; restored: string } | ProbeCallbackResult => {
        for (const color of sets) {
          const failed = feed(`\x1b]10;${color}\x07`, `${label} foreground set`)
          if (failed !== undefined) return failed
        }
        const pushFailed = feed(colorPush, `${label} color-stack push`)
        if (pushFailed !== undefined) return pushFailed
        pushed = true
        const mutationFailed = feed(`\x1b]10;${mutation}\x07`, `${label} foreground mutation`)
        if (mutationFailed !== undefined) return mutationFailed
        const changed = queryForeground(`${label} foreground query after mutation`)
        const changedRaw = foregroundRaw
        if (changed !== null && typeof changed !== "string") return changed
        const popFailed = feed(colorPop, `${label} color-stack pop`)
        if (popFailed !== undefined) return popFailed
        pushed = false
        const restored = queryForeground(`${label} foreground query after pop`)
        const restoredRaw = foregroundRaw
        if (restored !== null && typeof restored !== "string") return restored
        if (changed && restored) return { changed, restored }
        const malformed =
          !changed && changedRaw !== "" ? changedRaw : !restored && restoredRaw !== "" ? restoredRaw : null
        if (malformed === null) return replyFailure("No OSC 10 reply after changing or popping color")
        const note = `Malformed OSC 10 reply: ${JSON.stringify(malformed)}`
        return { pass: false, note, tests: [{ id: "criterion", status: "test-failure", reason: note }] }
      }
      const popFixture = fixture("POP fixture", [colors.a], colors.b)
      if ("pass" in popFixture) {
        result = popFixture
        return result
      }
      const pushFixture = fixture("PUSH fixture", [colors.a, colors.b], colors.c)
      if ("pass" in pushFixture) {
        result = pushFixture
        return result
      }
      comparison = { before, colors, popFixture, pushFixture }
      result = colorStackResult(operation, before, colors, popFixture, pushFixture)
      return result
    } catch (error) {
      unexpectedlyFailed = true
      primaryError = error
      throw error
    } finally {
      const cleanupFailures: Array<{ action: string; error: unknown }> = []
      try {
        if (pushed) {
          if (seedAttempted) capture(colorPop)
          else ctx.feed(colorPop)
        }
      } catch (error) {
        cleanupFailures.push({ action: "Color-stack cleanup pop", error })
      } finally {
        if (seedAttempted) {
          try {
            capture("\x1b]110\x07")
          } catch (error) {
            cleanupFailures.push({ action: "Foreground cleanup reset", error })
          } finally {
            try {
              capture(foregroundQuery)
            } catch (error) {
              cleanupFailures.push({ action: "Foreground cleanup query", error })
            }
          }
        } else {
          try {
            ctx.feed(`\x1b]10;${before}\x07`)
          } catch (error) {
            cleanupFailures.push({ action: "Foreground cleanup restore", error })
          }
        }
      }
      if (cleanupFailures.length > 0) {
        const cleanupNote = cleanupFailures
          .map(({ action, error }) =>
            error instanceof Error
              ? `${action} (behavior) failed: ${error.name}: ${error.message}`
              : `${action} (behavior) threw unexpectedly: ${String(error)}`,
          )
          .join("; ")
        const primaryNote = unexpectedlyFailed
          ? `Color-stack callback threw unexpectedly: ${primaryError instanceof Error ? `${primaryError.name}: ${primaryError.message}` : String(primaryError)}`
          : result?.tests?.some((test) => test.status === "test-failure")
            ? result.note
            : undefined
        const note = primaryNote ? `${primaryNote}; ${cleanupNote}` : cleanupNote
        if (unexpectedlyFailed || cleanupFailures.some(({ error }) => !(error instanceof Error))) {
          throw new AggregateError(
            [
              ...(unexpectedlyFailed || result?.tests?.some((test) => test.status === "test-failure")
                ? [primaryError]
                : []),
              ...cleanupFailures.map(({ error }) => error),
            ],
            note,
            { cause: primaryError },
          )
        }
        if (result) {
          // Cleanup failure supersedes reply absence; do not attach reply evidence to that failure.
          cancelReplyFailure(result)
          result.pass = false
          result.note = note
          result.tests = [{ id: "criterion", status: "test-failure", reason: note }]
          delete result.observation
          delete result.response
          delete result.assertions
        }
      }
      if (readbackUnavailable && cleanupFailures.length === 0) {
        // Keep the early measurement, but retain this probe's own attempt after its foreground cleanup.
        // capture records response bytes or the error; a failed attempt cannot establish a parser negative.
        const attempt: (typeof trace)[number] = { write: ownSequence }
        try {
          capture(ownSequence, attempt)
        } catch (error) {
          // Retain the failed attempt without replacing the readback result.
          attempt.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
        }
      }
      if (seedAttempted && result && result !== silence) {
        const response = JSON.stringify({
          query: foregroundQuery,
          originalRaw,
          ...comparison,
          ...(fixtureVerified && { fixture: { name: "verified seeded current", color: seededCurrentColor } }),
          trace,
        })
        result.response = response
        if (fixtureVerified) {
          result.note = `${result.note ?? "Stack fixture"}; measured on verified seeded current ${seededCurrentColor}`
          if (result.observation) result.observation.note = result.note
        }
        for (const assertion of result.assertions ?? []) assertion.observed = response
      }
      if (result && originalRaw === "") {
        const explained = nativeHostRecipeResult(ctx, result, "color-request", "foreground-rgb", foregroundQuery, true)
        if (explained.hostRecipeCauses) result.hostRecipeCauses = explained.hostRecipeCauses
      }
    }
  }
}

async function colorStackTermProbe(
  ctx: Parameters<NonNullable<ProbeDefinition["term"]>>[0],
  operation: "push" | "pop",
): Promise<ProbeCallbackResult> {
  const originalReply = await ctx.queryWithSentinelOutcome(foregroundQuery, foregroundReply)
  const before = foregroundValue(originalReply.match?.[0] ?? "")
  if (!before) return unansweredQuery(originalReply, "No original OSC 10 foreground reply; color stack was not changed")
  let pushed = false
  const colors = colorStackColors(before)
  const read = async (missing: string) => {
    const reply = await ctx.queryWithSentinelOutcome(foregroundQuery, foregroundReply)
    const value = foregroundValue(reply.match?.[0] ?? "")
    return value ? value : unansweredQuery(reply, missing)
  }
  // The same two fixtures as the headless arm (#31904): POP sets A, PUSH sets A then B.
  const fixture = async (sets: readonly string[], mutation: string) => {
    for (const color of sets) ctx.write(`\x1b]10;${color}\x07`)
    ctx.write(colorPush)
    pushed = true
    ctx.write(`\x1b]10;${mutation}\x07`)
    const changed = await read("No OSC 10 reply after changing foreground")
    if (typeof changed !== "string") return changed
    ctx.write(colorPop)
    pushed = false
    const restored = await read("No OSC 10 reply after color-stack pop")
    if (typeof restored !== "string") return restored
    return { changed, restored }
  }
  try {
    const popFixture = await fixture([colors.a], colors.b)
    if ("pass" in popFixture) return popFixture
    const pushFixture = await fixture([colors.a, colors.b], colors.c)
    if ("pass" in pushFixture) return pushFixture
    return colorStackResult(operation, before, colors, popFixture, pushFixture)
  } finally {
    try {
      if (pushed) ctx.write(colorPop)
    } finally {
      ctx.write(`\x1b]10;${before}\x07`)
    }
  }
}

const OSC720_CLAIM = "OSC 720 moves the scrollback viewport up"
const OSC720_HISTORY_LINES = 30

type ScrollbackReading = ReturnType<LibProbeSource["getScrollback"]>

function sameViewport(reading: ScrollbackReading, other: ScrollbackReading): boolean {
  return (
    reading.viewportOffset === other.viewportOffset &&
    reading.totalLines === other.totalLines &&
    reading.screenLines === other.screenLines
  )
}

function sameGeometry(reading: ScrollbackReading, other: ScrollbackReading): boolean {
  return reading.totalLines === other.totalLines && reading.screenLines === other.screenLines
}

function feedScrollbackHistory(ctx: LibProbeSource): void {
  for (let i = 0; i < OSC720_HISTORY_LINES; i++) ctx.feed(`scroll-${i}\r\n`)
}

function osc720ScrollProbe(): ProbeDefinition["lib"] {
  return (ctx) => {
    const declared = ctx.capabilities.productViewport
    if (declared?.available === false) {
      const state = { productViewport: declared }
      if (ctx.scrollViewport) {
        return parserStateResult(
          null,
          OSC720_CLAIM,
          state,
          "Product viewport declared absent but scroll control is present",
        )
      }
      if (absentOscAudit(ctx.runtimeIdentity, 720)) {
        return sourceAbsentOsc("extensions.osc720-scroll-up", 720, "\x1b]720\x07", "scrollback viewport")(ctx)
      }
      return reviewResult(HEADLESS_OBSERVABLE_REVIEW, declared.reason, "scrollback viewport scroll control", state)
    }
    feedScrollbackHistory(ctx)
    const before = ctx.getScrollback()
    if (before.totalLines <= before.screenLines || before.viewportOffset <= 0) {
      return parserStateResult(null, OSC720_CLAIM, { before }, "No scrollback viewport available")
    }
    // A reading only qualifies the measurement below when the backend's viewport channel can move at
    // all: a row derived as totalLines - screenLines reads the live bottom forever, so an unchanged
    // row there is absence of an observer, never evidence that the engine ignored OSC 720. Both
    // deltas are tried because the sign that scrolls up differs per backend, and the reading is
    // restored (and the restoration checked) before the measured sequence runs.
    if (!ctx.scrollViewport) {
      return notTestedResult("scrollback viewport scroll control", { before })
    }
    ctx.scrollViewport(-1)
    const afterMinus = ctx.getScrollback()
    ctx.scrollViewport(1)
    const afterPlus = ctx.getScrollback()
    // Only the position may qualify the observer, and only while the history count and screen height
    // hold: a control that changes totalLines or screenLines has said nothing about whether the
    // viewport position can move, so it must stay unqualified however the counts changed.
    const controlGeometryFixed = sameGeometry(afterMinus, before) && sameGeometry(afterPlus, before)
    const controlPositionMoved =
      afterMinus.viewportOffset !== before.viewportOffset || afterPlus.viewportOffset !== afterMinus.viewportOffset
    ctx.reset()
    feedScrollbackHistory(ctx)
    const control = {
      afterMinus,
      afterPlus,
      geometryFixed: controlGeometryFixed,
      positionMoved: controlPositionMoved,
      restored: ctx.getScrollback(),
    }
    if (!sameViewport(control.restored, before)) {
      return parserStateResult(
        null,
        OSC720_CLAIM,
        { before, control },
        "Viewport control did not restore the measured baseline",
      )
    }
    // A control that moved something other than the position is an irregular instrument, not an
    // absence of one: the readings are kept and the result stays inconclusive rather than becoming a
    // coverage record (CTO ruling on 31752). Only a control that moved nothing at fixed extents is
    // evidence that this backend has no viewport scroll state.
    if (!controlGeometryFixed) {
      return parserStateResult(null, OSC720_CLAIM, { before, control }, "Viewport control changed the buffer geometry")
    }
    if (!controlPositionMoved) {
      return notTestedResult("scrollback viewport state", { before, control })
    }
    ctx.feed("\x1b]720\x07")
    const after = ctx.getScrollback()
    if (!sameGeometry(after, before)) {
      return parserStateResult(
        null,
        OSC720_CLAIM,
        { before, after, control },
        "The measured sequence changed the buffer geometry",
      )
    }
    const pass = after.viewportOffset < before.viewportOffset
    return parserStateResult(pass, OSC720_CLAIM, { before, after, control })
  }
}

/** A complete DA1 reply (CSI ? <params> c); a truncated `\x1b[?62;` is not a reply. */
const DA1_COMPLETE = /\x1b\[\?[0-9;]+c/
/** The Kitty keyboard flags reply (CSI ? <flags> u). */
const KITTY_FLAGS = /\x1b\[\?(\d+)u/
/** Any flags-shaped reply (CSI ? <params> u), including malformed and empty params. */
const KITTY_FLAGS_SHAPED = /\x1b\[\?[0-9;]*u/
/** A `CSI ?` sequence that never reaches a final byte before the next escape or the end of the capture. */
const KITTY_FLAGS_TRUNCATED = /\x1b\[\?[0-9;]*(?=\x1b|$)/
const KITTY_FLAGS_MISSING = "No Kitty keyboard reply; key events were not tested"

type KittyDetection =
  | { readonly kind: "answered" }
  | { readonly kind: "absent" }
  | { readonly kind: "inconclusive"; readonly reason: "no-response" | "invalid-reply" }

/**
 * Kitty protocol-support detection (spec "Detection of support for this protocol"): the unmutating flags query
 * (CSI ? u) is followed by DA1 (CSI c). A complete flags reply answers for the protocol. Absence is proven only by a
 * complete DA1 reply that is the ENTIRE retained capture; any other byte around it (a malformed, truncated or
 * colon-parameter flags reply, a duplicate DA1, noise, or a DA1 that precedes the flags reply) means a reply came
 * back that cannot be read, so absence is unproven and the observation is inconclusive — as is neither reply at all.
 * For a per-enhancement id this negative proves only the necessary condition (the protocol is absent), never that key
 * events work.
 */
function kittyDetection(raw: string): KittyDetection {
  const flags = KITTY_FLAGS.exec(raw)
  const da1 = DA1_COMPLETE.exec(raw)
  if (flags !== null && da1 !== null && da1.index < flags.index) {
    return { kind: "inconclusive", reason: "invalid-reply" }
  }
  if (flags !== null) return { kind: "answered" }
  // A flags-shaped reply that is not the complete digits-only form, or a `CSI ?` that never terminates, is a
  // malformed observation: the protocol's own answer was attempted but cannot be read, so absence is unproven.
  if (KITTY_FLAGS_SHAPED.test(raw) || KITTY_FLAGS_TRUNCATED.test(raw)) {
    return { kind: "inconclusive", reason: "invalid-reply" }
  }
  if (da1 !== null) {
    // The documented DA1-only negative holds only when the DA1 reply is the whole capture. A leading or trailing byte
    // (colon-parameter flags the digits-only shape misses, a duplicate DA1, noise) is unread output, not absence.
    return da1.index === 0 && da1[0].length === raw.length
      ? { kind: "absent" }
      : { kind: "inconclusive", reason: "invalid-reply" }
  }
  return { kind: "inconclusive", reason: "no-response" }
}

function kittyProtocolAbsent(response: string): ProbeCallbackResult {
  const note =
    "DA1 answered without any Kitty keyboard flags reply; the protocol is not supported (necessary-condition negative; key-event conformance was not tested)"
  return {
    pass: false,
    response,
    note,
    observation: { outcome: "unsupported", assertionType: "query_reply", note },
    assertions: [
      {
        assertionType: "query_reply" as const,
        kind: "negative",
        expected: "A complete Kitty keyboard flags reply answers before the DA1 reply",
        observed: response,
      },
    ],
  }
}

function kittyInconclusive(
  detection: Extract<KittyDetection, { kind: "inconclusive" }>,
  reason: "no-response" | "invalid-reply" | "timeout",
  response: string,
): ProbeCallbackResult {
  const note =
    detection.reason === "invalid-reply"
      ? "Unreadable or out-of-order Kitty keyboard flags / DA1 reply (malformed, truncated, duplicate or residual bytes); no support conclusion"
      : "No answer to the Kitty keyboard flags query or the DA1 follow-up; no support conclusion"
  return {
    pass: false,
    response,
    note,
    ...(response.length === 0
      ? replyFailure(note)
      : { observation: { outcome: "inconclusive", assertionType: "query_reply", reason, note } }),
  }
}

/**
 * Kitty keyboard flag probe — detect protocol support with an unmutating CSI ? u + DA1 capture, then push the
 * requested flags, query, and check one bit. The detection step never pushes, so a pre-detection return pops nothing.
 */
export function kittyKeyboardFlagProbe(id: string, pushValue: number, flagBit: number): ProbeDefinition {
  const definition = probe(
    id,
    (ctx) => {
      const detectionRaw = ctx.feedCapture(`\x1b[?u\x1b[c`)
      const detection = kittyDetection(detectionRaw)
      if (detection.kind !== "answered") {
        return detection.kind === "absent"
          ? kittyProtocolAbsent(detectionRaw)
          : kittyInconclusive(detection, detection.reason, detectionRaw)
      }
      ctx.feed(`\x1b[>${pushValue}u`) // explicit push; a throw here pops nothing
      try {
        if (ctx.queryWithSentinelOutcome) {
          return matchedReplyResult(
            ctx.queryWithSentinelOutcome(`\x1b[?u`, KITTY_FLAGS),
            KITTY_FLAGS_MISSING,
            (frame) => keyboardFlagsResult(frame, flagBit),
          )
        }
        return keyboardFlagsResult(ctx.feedCapture(`\x1b[?u`), flagBit)
      } finally {
        ctx.feed("\x1b[<u") // pop the mode pushed for this probe, even if the query fails
      }
    },
    async (ctx) => {
      // queryWithSentinelOutcome appends the DA1 follow-up, so this write is exactly CSI ? u + CSI c, unmutating.
      const detection = await ctx.queryWithSentinelOutcome(`\x1b[?u`, KITTY_FLAGS)
      const verdict = kittyDetection(detection.raw)
      if (verdict.kind !== "answered") {
        if (verdict.kind === "absent") return kittyProtocolAbsent(detection.raw)
        const reason =
          verdict.reason === "invalid-reply"
            ? "invalid-reply"
            : detection.reason === "timeout"
              ? "timeout"
              : "no-response"
        return kittyInconclusive(verdict, reason, detection.raw)
      }
      ctx.write(`\x1b[>${pushValue}u`) // explicit push; a throw here pops nothing
      try {
        return matchedReplyResult(
          await ctx.queryWithSentinelOutcome(`\x1b[?u`, KITTY_FLAGS),
          KITTY_FLAGS_MISSING,
          (frame) => keyboardFlagsResult(frame, flagBit),
        )
      } finally {
        ctx.write("\x1b[<u") // pop the mode pushed for this probe, even if the query fails
      }
    },
  )
  return { ...definition, termAssertionType: "query_reply", libAssertionType: "query_reply" }
}

/** Wrap captured library text without inventing measured DA1 timing or changing its matched frame. */
function rawQueryOutcome(raw: string, match: string[] | null): TerminalQueryOutcome {
  return { match, reason: "sentinel", raw, rawBase64: Buffer.from(raw).toString("base64") }
}

function unansweredQuery(reply: TerminalQueryOutcome, note: string): ProbeCallbackResult {
  // A measured sentinel with nothing beside it is a decisive negative, not an unknown; a timeout
  // never answered DA1 at all, so it stays inconclusive.
  const silent = sentinelNegativeResult(reply.raw, reply.sentinel, note)
  if (silent) return silent
  if (reply.raw.length === 0) {
    return {
      ...replyFailure(note),
      response: reply.raw,
    }
  }
  return {
    pass: false,
    response: reply.raw,
    note,
    observation: {
      outcome: "inconclusive",
      assertionType: "query_reply",
      reason: reply.reason === "timeout" ? "timeout" : "no-response",
      note,
    },
  }
}

/** OSC99 capability detection only; neither arm displays a desktop notification. */
function notificationQueryResult(reply: TerminalQueryOutcome, id: string, fallback = false): ProbeCallbackResult {
  if (!reply.match) {
    const note = "No matching notification query reply; OS display was not tested"
    if (!fallback) return unansweredQuery(reply, note)
    return {
      pass: false,
      response: reply.raw,
      note,
      observation: { outcome: "inconclusive", assertionType: "query_reply", reason: "no-response", note },
    }
  }
  const payloadFields = reply.match[1]?.split(":").filter((field) => field.startsWith("p=")) ?? []
  const pass = payloadFields.length === 1 && payloadFields[0]?.slice(2).split(",").includes("title") === true
  const note = pass
    ? "Notification capabilities acknowledge title payloads; OS display, activation and close events were not tested"
    : "Notification reply does not advertise the required title payload; no support conclusion"
  return {
    pass,
    response: reply.match[0],
    note,
    observation: {
      outcome: pass ? "supported" : "inconclusive",
      assertionType: "query_reply",
      ...(!pass && { reason: "invalid-reply" as const }),
      note,
    },
    ...(pass && {
      assertions: [
        {
          assertionType: "query_reply" as const,
          kind: "positive" as const,
          expected: `OSC 99 echoes i=${id}, p=? and advertises p=title`,
          observed: reply.match[0] ?? "",
        },
      ],
    }),
  }
}

/**
 * Live's reading of one string-graded query outcome: no matched frame grades through unansweredQuery, a
 * matched frame through the site's grader. A library probe source on a proven reply path offers the same
 * outcome through `queryWithSentinelOutcome` (#30554), so both arms read it here. The grader reads only the
 * frame; the result keeps the whole read window, DA1 answer included, as the observed evidence.
 */
function matchedReplyResult(
  reply: TerminalQueryOutcome,
  missingNote: string,
  grade: (frame: string) => ProbeCallbackResult,
): ProbeCallbackResult {
  if (!reply.match) return unansweredQuery(reply, missingNote)
  return { ...grade(reply.match[0] ?? ""), response: reply.raw }
}

function keyboardFlagsResult(response: string, flagBits: number): ProbeCallbackResult {
  const match = /\x1b\[\?(\d+)u/.exec(response)
  if (!match?.[1]) {
    return unansweredQuery(rawQueryOutcome(response, null), KITTY_FLAGS_MISSING)
  }
  const flags = Number(match[1])
  const pass = (flags & flagBits) === flagBits
  const note = `Queried enhancement flags=${flags}; actual key press, repeat and release events were not tested`
  return {
    pass,
    response,
    note,
    observation: { outcome: pass ? "supported" : "unsupported", assertionType: "query_reply", note },
    assertions: [
      {
        assertionType: "query_reply" as const,
        kind: pass ? "positive" : "negative",
        expected: `Acknowledged flags include mask ${flagBits}`,
        observed: `flags=${flags}`,
      },
    ],
  }
}

function graphicsQueryResult(
  response: string,
  imageId: number,
  acceptedNote = "Graphics query accepted RGB pixel data; visible rendering was not tested",
): ProbeCallbackResult {
  const match = kittyReplyFrame({ i: String(imageId) }).exec(response)
  if (!match) {
    return unansweredQuery(
      rawQueryOutcome(response, null),
      "No matching graphics query reply; image rendering was not tested",
    )
  }
  const pass = match[2] === "OK"
  const note = pass ? acceptedNote : `Graphics query returned ${match[2]}; no support conclusion`
  return {
    pass,
    response,
    note,
    observation: {
      outcome: pass ? "supported" : "inconclusive",
      assertionType: "query_reply",
      ...(!pass && { reason: "invalid-reply" as const }),
      note,
    },
    ...(pass && {
      assertions: [
        {
          assertionType: "query_reply" as const,
          kind: "positive" as const,
          expected: `Graphics reply i=${imageId};OK`,
          observed: match[0],
        },
      ],
    }),
  }
}

/**
 * A kitty graphics reply frame, APC G <control data> ; <message> ST, whose control data carries every key in `keys`
 * at the given value pattern, in any order. The protocol defines control data as a comma-separated list of key=value
 * pairs; WezTerm answers an allocation with `I=<number>,i=<id>` where kitty writes `i=<id>,I=<number>` (27915).
 * Group 1 is the control data and group 2 the message.
 */
function kittyReplyFrame(keys: Readonly<Record<string, string>>): RegExp {
  const lookaheads = Object.entries(keys)
    .map(([key, value]) => `(?=(?:[^;\\x1b]*,)?${key}=${value}[,;])`)
    .join("")
  return new RegExp(`\\x1b_G${lookaheads}([^;\\x1b]*);([^\\x1b]+)\\x1b\\\\`)
}

/** The value of `key` in a kitty reply's control data. */
function kittyControlValue(control: string, key: string): string | undefined {
  return control
    .split(",")
    .map((pair) => pair.split("="))
    .find(([name]) => name === key)?.[1]
}

/** The allocation reply to an `I=<imageNumber>` transfer: a fresh numeric `i` with the echoed `I`, in any order. */
function allocationReply(imageNumber: number): RegExp {
  return kittyReplyFrame({ I: String(imageNumber), i: "\\d+" })
}

function imageTransferRequest(imageNumber: number): string {
  // I requests a new image; a fixed i would overwrite somebody else's image.
  return `\x1b_Ga=t,f=24,s=1,v=1,t=d,I=${imageNumber};/wAA\x1b\\`
}

function allocatedImageResult(
  response: string,
  imageNumber: number,
): { imageId: number | null; result: ProbeCallbackResult } {
  const match = allocationReply(imageNumber).exec(response)
  const imageId = match ? Number(kittyControlValue(match[1] ?? "", "i")) : 0
  if (!match || imageId < 1 || imageId > 0xffffffff) {
    return {
      imageId: null,
      result: unansweredQuery(
        rawQueryOutcome(response, null),
        "No matching image allocation reply; no image ownership or transmission conclusion",
      ),
    }
  }
  const pass = match[2] === "OK"
  const note = pass
    ? "RGB image transmission acknowledged; display was not tested"
    : `Image transmission returned ${match[2]}; no support conclusion`
  return {
    imageId: pass ? imageId : null,
    result: {
      pass,
      response,
      note,
      observation: {
        outcome: pass ? "supported" : "inconclusive",
        assertionType: "query_reply",
        ...(!pass && { reason: "invalid-reply" as const }),
        note,
      },
      ...(pass && {
        assertions: [
          {
            assertionType: "query_reply" as const,
            kind: "positive" as const,
            expected: `A fresh image ID and I=${imageNumber};OK acknowledge the transmitted RGB pixel`,
            observed: match[0],
          },
        ],
      }),
    },
  }
}

/** The specified query action: it replies before the DA1 sentinel and stores no image. */
const GRAPHICS_QUERY = "\x1b_Gi=31,s=1,v=1,a=q,t=d,f=24;AAAA\x1b\\"
const GRAPHICS_QUERY_REPLY = /\x1b_Gi=31;([^\x1b]+)\x1b\\/

/** Live's reading of the graphics query outcome, shared by both arms (#30554). */
function graphicsQueryOutcomeResult(reply: TerminalQueryOutcome): ProbeCallbackResult {
  return matchedReplyResult(reply, "No matching graphics query reply; image rendering was not tested", (frame) => {
    const match = kittyReplyFrame({ i: "31" }).exec(frame)
    const message = match?.[2]
    // Only the canonical a=q direct RGB request has this criterion; placement keeps its own OK-only grader.
    if (!match || !message || !/^[\x20-\x7e]+$/.test(message)) return graphicsQueryResult(frame, 31)
    const pass = message === "OK"
    const note = pass
      ? "Canonical direct RGB graphics query accepted; visible rendering was not tested"
      : `Canonical direct RGB graphics query refused: ${message}; protocol recognized, visible rendering was not tested`
    return {
      pass,
      note,
      observation: { outcome: pass ? "supported" : "unsupported", assertionType: "query_reply", note },
      assertions: [
        {
          assertionType: "query_reply",
          kind: pass ? "positive" : "negative",
          expected: "Canonical direct RGB graphics query i=31 acknowledged with OK",
          observed: match[0],
          note: JSON.stringify({ protocolRecognized: true, message }),
        },
      ],
    }
  })
}

/** Live's reading of an allocation outcome, shared by both arms (#30554); the result keeps the whole read window. */
function allocationOutcomeResult(
  reply: TerminalQueryOutcome,
  imageNumber: number,
): { imageId: number | null; result: ProbeCallbackResult } {
  if (!reply.match) {
    return {
      imageId: null,
      result: unansweredQuery(
        reply,
        "No matching image allocation reply; no image ownership or transmission conclusion",
      ),
    }
  }
  const uploaded = allocatedImageResult(reply.match[0] ?? "", imageNumber)
  return { ...uploaded, result: { ...uploaded.result, response: reply.raw } }
}

function placementRequest(imageId: number): string {
  return `\x1b_Ga=p,i=${imageId},c=2,r=1,C=1\x1b\\`
}

/** Live's reading of a placement outcome, shared by both arms (#30554). */
function placementOutcomeResult(placement: TerminalQueryOutcome, imageId: number): ProbeCallbackResult {
  // The probe grades the acknowledgement, never rendering: WezTerm places silently (27915).
  return matchedReplyResult(placement, "No placement acknowledgement; visible pixels were not tested", (frame) =>
    graphicsQueryResult(frame, imageId, "Image placement acknowledged; visible pixels were not tested"),
  )
}

/**
 * A named inconclusive for a run that cannot see pixels at all. No image is cited because none was
 * taken, and the note says which measurement is missing rather than implying a negative.
 */
function kittyUnobservableResult(id: string, note: string): ProbeCallbackResult {
  return {
    pass: false,
    criterionBranch: HEADLESS_OBSERVABLE_REVIEW,
    tests: [{ id: "review", status: "test-todo", reason: `${id}: ${note}` }],
    response: JSON.stringify({ id, note }),
    observation: {
      outcome: "inconclusive",
      reason: "insufficient-evidence",
      assertionType: "query_reply",
      note: `${id}: ${note}`,
    },
  }
}

function kittyImageTransferProbe(id: string, display: boolean): ProbeDefinition {
  const newNumber = () => (Number.parseInt(globalThis.crypto.randomUUID().slice(0, 8), 16) % 0xfffffffe) + 1
  return {
    ...probe(
      id,
      (ctx) => {
        const imageNumber = newNumber()
        let imageId: number | null = null
        try {
          if (ctx.queryWithSentinelOutcome) {
            const uploaded = allocationOutcomeResult(
              ctx.queryWithSentinelOutcome(imageTransferRequest(imageNumber), allocationReply(imageNumber)),
              imageNumber,
            )
            imageId = uploaded.imageId
            if (!imageId || !display) return uploaded.result
            const placement = ctx.queryWithSentinelOutcome(
              placementRequest(imageId),
              kittyReplyFrame({ i: String(imageId) }),
            )
            return placementOutcomeResult(placement, imageId)
          }
          const uploaded = allocatedImageResult(ctx.feedCapture(imageTransferRequest(imageNumber)), imageNumber)
          imageId = uploaded.imageId
          if (!imageId || !display) return uploaded.result
          const response = ctx.feedCapture(placementRequest(imageId))
          return graphicsQueryResult(response, imageId, "Image placement acknowledged; visible pixels were not tested")
        } finally {
          if (imageId) ctx.feed(`\x1b_Ga=d,d=I,i=${imageId},q=2\x1b\\`)
        }
      },
      async (ctx) => {
        const imageNumber = newNumber()
        let imageId: number | null = null
        try {
          const uploaded = allocationOutcomeResult(
            await ctx.queryWithSentinelOutcome(imageTransferRequest(imageNumber), allocationReply(imageNumber)),
            imageNumber,
          )
          imageId = uploaded.imageId
          if (!imageId || !display) return uploaded.result
          const placement = await ctx.queryWithSentinelOutcome(
            placementRequest(imageId),
            kittyReplyFrame({ i: String(imageId) }),
          )
          return placementOutcomeResult(placement, imageId)
        } finally {
          // Free only the image the terminal explicitly allocated for this probe.
          if (imageId) ctx.write(`\x1b_Ga=d,d=I,i=${imageId},q=2\x1b\\`)
        }
      },
      "query_reply",
    ),
    libAssertionType: "query_reply",
  }
}

const OSC21_FOREGROUND_QUERY = "\x1b]21;foreground=?\x1b\\"
const OSC21_REPLY = /\x1b\]21;([^\x07\x1b]*)(?:\x07|\x1b\\)/

/** Live's reading of the OSC 21 outcome, shared by both arms (#30554). */
function kittyForegroundOutcomeResult(reply: TerminalQueryOutcome): ProbeCallbackResult {
  return matchedReplyResult(reply, "No OSC 21 reply; color rendering was not tested", kittyForegroundResult)
}

/** A query establishes recognition; this does not test changed colors or pixels. */
function kittyForegroundResult(response: string): ProbeCallbackResult {
  const match = OSC21_REPLY.exec(response)
  if (!match) {
    return unansweredQuery(rawQueryOutcome(response, null), "No OSC 21 reply; color rendering was not tested")
  }
  const values = match[1]?.split(";").filter((field) => field.startsWith("foreground=")) ?? []
  const value = values.length === 1 ? values[0]?.slice("foreground=".length) : undefined
  // Kitty replies with RGB. An empty value explicitly means a dynamic/undefined color.
  // Other encodings are left inconclusive rather than labelled unsupported.
  const pass = value === "" || (value !== undefined && /^rgb:[a-f\d]{1,4}\/[a-f\d]{1,4}\/[a-f\d]{1,4}$/i.test(value))
  const note = pass
    ? "Foreground query recognized; setting colors and visible rendering were not tested"
    : "OSC 21 replied without one verifiable foreground value; no support conclusion"
  return {
    pass,
    response,
    note,
    observation: { outcome: pass ? "supported" : "inconclusive", assertionType: "query_reply", note },
    ...(pass && {
      assertions: [
        {
          assertionType: "query_reply" as const,
          kind: "positive" as const,
          expected: "OSC 21 foreground query returns RGB or an explicitly undefined value",
          observed: match[0],
        },
      ],
    }),
  }
}

function textSizingResult(
  before: { row: number; col: number },
  width: { row: number; col: number },
  scale: { row: number; col: number },
  assertionType: "query_reply" | "buffer_state",
): ProbeCallbackResult {
  const widthWorks = width.row === before.row && width.col === before.col + 2
  const scaleWorks = scale.row === width.row && scale.col === width.col + 2
  const pass = widthWorks && scaleWorks
  const note = `Cursor advance: width ${widthWorks ? "verified" : "not verified"}; scale ${scaleWorks ? "verified" : "not verified"}. Glyph appearance needs a visual check.`
  const response = JSON.stringify({ before, width, scale })
  return {
    pass,
    note,
    response,
    observation: { outcome: pass ? "supported" : "unsupported", assertionType, note },
    assertions: [
      {
        assertionType: assertionType,
        kind: pass ? "positive" : "negative",
        expected: "Each OSC 66 width/scale sequence advances two columns without changing row",
        observed: response,
      },
    ],
  }
}

/**
 * Only an isolated headless backend may receive this disposable OSC 52 nonce.
 * A loaded artifact that answers the write query with no bytes, and has no host-recipe cause,
 * has no engine-callback witness for the clipboard. That silence stays not-tested.
 * A pass, a host-recipe cause, an observation, a nonempty reply, or a callback with no loaded
 * binary keeps the measured roundtrip. A listed reply-path audit still replaces an empty capture.
 */
const ENGINE_CLIPBOARD_NOTE = "engine copy_to_clipboard callback read via getClipboardState, no reply bytes"
const OSC52_SOURCE_CONTROL = `\x1b]52;c;${btoa("terminfo-osc52-source-control")}\x07`

function auditedClipboardWriteSource(
  source: Pick<LibProbeSource, "runtimeIdentity" | "getTitle" | "getIconLabel">,
): boolean {
  const engine = auditedOscEngine(source.runtimeIdentity, 52)?.[0]
  return auditedXtermState(source) || engine === "vt100" || engine === "vt220"
}

function headlessOsc52Write(ctx: LibProbeSource): ProbeCallbackResult {
  if (typeof ctx.getClipboardState !== "function") return headlessOsc52WriteWithoutWitness(ctx)
  const nonce = `terminfo-osc52-${randomUUID()}`
  const encoded = btoa(nonce)
  ctx.feed(`\x1b]52;c;${encoded}\x07`)
  const retained = ctx.getClipboardState()
  // #32091: the declared clipboard-load recipe query still runs, so a native host route retains its capture. The
  // verdict below reads only the engine's retained write; the query's reply or silence does not grade it, and a
  // silent read carries the audited host-input cause (kitty's default read-clipboard-ask waits on a human).
  const query = "\x1b]52;c;?\x07"
  const outcome = ctx.queryWithSentinelOutcome?.(query, osc52Reply)
  const raw = outcome ? outcome.raw : ctx.feedCapture(query)
  const readEmpty = outcome
    ? sentinelSilenceResult(outcome, "OSC 52 c query returns the exact written nonce") !== null || raw === ""
    : raw === ""
  const explain = (result: ProbeCallbackResult) =>
    nativeHostRecipeResult(ctx, result, "clipboard-load", "clipboard-read-permission", query, readEmpty)
  const writes = retained.writes.map((write) => ({ selector: write.selector, payload: write.payload }))
  const match = retained.writes.find((write) => write.selector === "c" && write.payload === encoded)
  const note = [
    ENGINE_CLIPBOARD_NOTE,
    match?.text !== undefined ? `text ${match.text}` : undefined,
    match?.decodeError !== undefined ? `decodeError ${match.decodeError}` : undefined,
    retained.pasteSelector !== undefined ? `paste ${retained.pasteSelector}` : undefined,
    match === undefined && writes.length > 0
      ? `retained selectors ${writes.map((write) => write.selector).join(",")} did not match`
      : undefined,
  ]
    .filter((part) => part !== undefined)
    .join("; ")
  const expected = JSON.stringify({ selector: "c", payload: encoded })
  if (match) {
    return explain(
      parserStateResult(
        true,
        expected,
        { selector: match.selector, payload: match.payload },
        note,
        undefined,
        "query_reply",
      ),
    )
  }
  const state = { writes }
  if (writes.length === 0) return explain(parserStateResult(false, expected, state, note, undefined, "query_reply"))
  return explain(parserStateResult(null, expected, state, note, undefined, "query_reply"))
}

function headlessOsc52WriteWithoutWitness(ctx: LibProbeSource): ProbeCallbackResult {
  const measured = headlessClipboardRoundtrip(ctx)
  const identity = ctx.runtimeIdentity
  const unauditedSilence =
    !measured.pass &&
    (measured.hostRecipeCauses?.length ?? 0) === 0 &&
    measured.observation === undefined &&
    (measured.response ?? "") === "" &&
    identity !== undefined &&
    "loadedBinary" in identity
  if (!unauditedSilence) return measured
  return notTestedResult("clipboard write state", { response: "" })
}

/**
 * #32091: an engine that reports its clipboard permission option (Termless kitty) ran the read under it. Name it on the
 * result, since kitty's own default (read-clipboard-ask) would hold the read for a human instead of answering.
 */
function withClipboardControlNote(ctx: LibProbeSource, result: ProbeCallbackResult): ProbeCallbackResult {
  const control = typeof ctx.getClipboardState === "function" ? ctx.getClipboardState().control : undefined
  // Only a measured observation carries the note; a not-tested result keeps its own reason.
  const observation = result.observation
  if (control === undefined || observation === undefined) return result
  const note = `read under harness-supplied clipboard_control ${control.join(" ")}; kitty's default read-clipboard-ask asks a human before answering a read`
  const join = (prior: string | undefined) => (prior ? `${prior}; ${note}` : note)
  return { ...result, note: join(result.note), observation: { ...observation, note: join(observation.note) } }
}

function headlessClipboardRoundtrip(ctx: LibProbeSource): ProbeCallbackResult {
  const nonce = `terminfo-osc52-${randomUUID()}`
  const encoded = btoa(nonce)
  ctx.feed(`\x1b]52;c;${encoded}\x07`)
  const query = "\x1b]52;c;?\x07"
  const outcome = ctx.queryWithSentinelOutcome?.(query, osc52Reply)
  const raw = outcome ? outcome.raw : ctx.feedCapture(query)
  // CTO d5f41664: unmatched/partial bytes lose the old per-capture empty attribution deliberately.
  // A qualified read negative leaves the write unobservable unless a clipboard-state witness is wired.
  const readNegative = outcome
    ? sentinelSilenceResult(outcome, "OSC 52 c query returns the exact written nonce") !== null
    : false
  const empty = readNegative || raw === ""
  const writeUnobservable = readNegative && typeof ctx.getClipboardState !== "function"
  const reason =
    "clipboard write unobservable: OSC 52 read is a sentinel negative on this engine and no clipboard-state witness is wired."
  if (writeUnobservable && auditedClipboardWriteSource(ctx)) {
    return sourceAbsentOsc("OSC 52 clipboard write", 52, OSC52_SOURCE_CONTROL, "clipboard write")(ctx)
  }
  const result: ProbeCallbackResult = writeUnobservable
    ? { pass: false, note: reason, tests: [{ id: "criterion", status: "test-todo", reason }] }
    : headlessClipboardResult(empty ? "" : raw, nonce)
  return withClipboardControlNote(
    ctx,
    nativeHostRecipeResult(
      ctx,
      { ...result, response: raw },
      "clipboard-load",
      "clipboard-read-permission",
      query,
      empty,
    ),
  )
}

/** Read silence is conclusive only on a collector-qualified, ordered reply path. */
function headlessClipboardRead(ctx: LibProbeSource): ProbeCallbackResult {
  const nonce = `terminfo-osc52-${randomUUID()}`
  ctx.feed(`\x1b]52;c;${btoa(nonce)}\x07`)
  if (ctx.queryWithSentinelOutcome) {
    const outcome = ctx.queryWithSentinelOutcome("\x1b]52;c;?\x07", osc52Reply)
    const silence = sentinelSilenceResult(outcome, "OSC 52 c query returns the exact written nonce")
    return withClipboardControlNote(
      ctx,
      nativeHostRecipeResult(
        ctx,
        silence ?? headlessClipboardResult(outcome.raw, nonce),
        "clipboard-load",
        "clipboard-read-permission",
        "\x1b]52;c;?\x07",
        silence !== null,
      ),
    )
  }
  const raw = ctx.feedCapture("\x1b]52;c;?\x07")
  return withClipboardControlNote(
    ctx,
    nativeHostRecipeResult(
      ctx,
      headlessClipboardResult(raw, nonce),
      "clipboard-load",
      "clipboard-read-permission",
      "\x1b]52;c;?\x07",
      raw === "",
    ),
  )
}

function headlessClipboardResult(response: string, nonce: string): ProbeCallbackResult {
  const frames = response.matchAll(/\x1b\]52;c;([^\x07\x1b]*)(?:\x07|\x1b\\)/g)
  let sawCompleteFrame = false
  let sawInvalidFrame = false
  for (const frame of frames) {
    sawCompleteFrame = true
    const data = frame[1] ?? ""
    try {
      if (btoa(atob(data)) !== data) {
        sawInvalidFrame = true
        continue
      }
      if (atob(data) === nonce) {
        const note = "Isolated backend returned the exact OSC 52 clipboard nonce"
        return {
          pass: true,
          response,
          note,
          observation: { outcome: "supported", assertionType: "query_reply", note },
          assertions: [
            {
              assertionType: "query_reply" as const,
              kind: "positive",
              expected: "OSC 52 c query returns the exact written nonce",
              observed: frame[0],
            },
          ],
        }
      }
    } catch {
      sawInvalidFrame = true
    }
  }
  const reason =
    sawInvalidFrame || (response.length > 0 && !sawCompleteFrame)
      ? "invalid-reply"
      : sawCompleteFrame
        ? "insufficient-evidence"
        : "no-response"
  const note =
    reason === "invalid-reply"
      ? "No complete, canonical OSC 52 c reply was received from the isolated backend"
      : reason === "insufficient-evidence"
        ? "OSC 52 c replied with data other than the written nonce"
        : "No OSC 52 c query response from the isolated backend"
  if (response.length === 0) {
    return { ...replyFailure(note), response, note }
  }
  return {
    pass: false,
    response,
    note,
    observation: { outcome: "inconclusive", reason, assertionType: "query_reply", note },
  }
}

function liveClipboardNotTested(): ProbeCallbackResult {
  const note = "Collector policy: no owned disposable clipboard with verified restoration; OSC 52 was not sent"
  return {
    pass: false,
    note,
    tests: [{ id: "criterion", status: "test-todo", reason: note }],
  }
}

const osc52Reply = /\x1b\]52;c;([A-Za-z0-9+/=]*)(?:\x07|\x1b\\)/

function clipboardQueryResult(outcome: TerminalQueryOutcome, expected: string): ProbeCallbackResult {
  const frame = osc52Reply.exec(outcome.raw)
  if (!frame || outcome.reason !== "reply" || !outcome.match) {
    const reason = outcome.raw ? "invalid-reply" : "no-response"
    if (outcome.raw.length === 0) {
      return replyFailure("No complete OSC 52 c reply")
    }
    return {
      pass: false,
      observation: {
        outcome: "inconclusive",
        reason,
        assertionType: "query_reply",
        note: "No complete OSC 52 c reply",
      },
    }
  }
  const encoded = frame[1] ?? ""
  let decoded: string
  try {
    decoded = atob(encoded)
    if (btoa(decoded) !== encoded) throw new Error("Noncanonical base64")
  } catch {
    return {
      pass: false,
      observation: { outcome: "inconclusive", reason: "invalid-reply", assertionType: "query_reply" },
    }
  }
  const pass = decoded === expected
  return {
    pass,
    response: frame[0],
    observation: {
      outcome: pass ? "supported" : "inconclusive",
      ...(!pass && { reason: "insufficient-evidence" as const }),
      assertionType: "query_reply",
    },
    ...(pass && {
      assertions: [
        {
          assertionType: "query_reply" as const,
          kind: "positive" as const,
          expected: "OSC 52 c returns the independently written nonce",
          observed: frame[0],
        },
      ],
    }),
  }
}

async function liveClipboardProbe(
  ctx: TermProbeSource,
  kind: "write" | "read" | "roundtrip",
): Promise<ProbeCallbackResult> {
  if (!ctx.withClipboardFixture) return liveClipboardNotTested()
  return ctx.withClipboardFixture(async (fixture) => {
    if (kind !== "read") {
      const nonce = `terminfo-osc52-${randomUUID()}`
      ctx.write(`\x1b]52;c;${btoa(nonce)}\x07`)
      // A reply on the same TTY confirms the terminal processed the preceding write.
      // The independent clipboard read below is still the evidence of its effect.
      const cursor = await ctx.queryCursorPosition()
      if (!cursor) {
        return replyFailure(
          "no parsable cursor position reply; the public projection returned null and retained no bytes",
        )
      }
      const measured = await fixture.readText()
      if (measured !== nonce) {
        return {
          pass: false,
          observation: {
            outcome: "inconclusive",
            reason: "insufficient-evidence",
            assertionType: "clipboard",
            note: "Independent clipboard read did not equal the OSC 52 write nonce",
          },
        }
      }
      if (kind === "write") {
        return {
          pass: true,
          observation: { outcome: "supported", assertionType: "clipboard" },
          assertions: [
            {
              assertionType: "clipboard" as const,
              kind: "positive",
              expected: "Independent clipboard text equals OSC 52 write nonce",
              observed: measured,
            },
          ],
        }
      }
    }
    const nonce = `terminfo-osc52-${randomUUID()}`
    await fixture.writeText(nonce)
    const outcome = await ctx.queryOutcome("\x1b]52;c;?\x07", osc52Reply)
    const result = clipboardQueryResult(outcome, nonce)
    if (!outcome.raw && ctx.capture) {
      const frame = await ctx.capture({ role: "target", label: "Clipboard query after no response" })
      return {
        pass: result.pass,
        tests: result.tests,
        observation: {
          outcome: "inconclusive",
          reason: "no-response",
          assertionType: "screenshot",
          screenshotRef: frame.ref,
          frames: [frame],
          note: "No OSC 52 reply; retained the visible window for prompt/no-prompt review without automatic interaction",
        },
      }
    }
    return result
  })
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/** OS clipboard → app via ctrl+shift+v. Distinct from OSC 52 (app → clipboard) and DECRPM 2004. */
async function clipboardPaste(ctx: TermProbeSource): Promise<ProbeCallbackResult> {
  const input = ctx.input
  const readInput = ctx.readInput
  if (!input || !readInput) return notTestedResult("real-surface input injection (XTEST/CGEvent)", { input: false })
  if (!ctx.withClipboardFixture) return notTestedResult("owned disposable clipboard paste", { clipboard: false })
  return ctx.withClipboardFixture(async (fixture) => {
    const control = (await readInput(/^a/, 1000, () => input.injectKey("a")))?.[0]
    if (!control) throw new Error("XTEST delivery control failed: plain a did not reach the app")
    const nonce = `terminfo-paste-${randomUUID()}`
    await fixture.writeText(nonce)
    ctx.write("\x1b[?2004h")
    try {
      const arrival = new RegExp(`\\x1b\\[200~[\\s\\S]*?\\x1b\\[201~|${escapeRegex(nonce)}`)
      // The owned fixture seeds CLIPBOARD; Shift+Insert reads X11 PRIMARY instead.
      const report = (await readInput(arrival, 1000, () => input.injectKey("ctrl+shift+v")))?.[0]
      if (!report) {
        throw new Error("XTEST clipboard paste ctrl+shift+v did not reach the app after a successful delivery control")
      }
      const observed = { mode: "clipboard-paste", control, report }
      const expected =
        "OS XTEST ctrl+shift+v paste of clipboard nonce as CSI 200~nonce201~ after plain-a delivery control"
      const encoding = new RegExp(`\\x1b\\[200~${escapeRegex(nonce)}\\x1b\\[201~`)
      if (encoding.test(report)) {
        return {
          pass: true,
          response: JSON.stringify(observed),
          observation: { outcome: "supported" as const, assertionType: "input_bytes" as const },
          assertions: [
            {
              assertionType: "input_bytes" as const,
              kind: "positive" as const,
              expected,
              observed: JSON.stringify(observed),
              action: "clipboard-paste:ctrl+shift+v",
            },
          ],
        }
      }
      return {
        pass: false,
        response: JSON.stringify(observed),
        observation: { outcome: "unsupported" as const, assertionType: "input_bytes" as const },
        assertions: [
          {
            assertionType: "input_bytes" as const,
            kind: "negative" as const,
            expected,
            observed: JSON.stringify(observed),
            action: "clipboard-paste:ctrl+shift+v",
          },
        ],
      }
    } finally {
      ctx.write("\x1b[?2004l")
    }
  })
}

// OSC 0 sets the icon name and the window title together. Set ONE known payload, then ask the
// terminal for both values: CSI 20 t answers with the icon label as OSC L, CSI 21 t with the title
// as OSC l. Support requires BOTH replies to return the exact payload. A missing reply is
// inconclusive, never a negative: a terminal that does not answer these queries has not shown that
// the set was ignored, and an unqualified title change cannot stand in for the icon label.
const OSC0_PAYLOAD = "osc0-icon-title"
const OSC0_ICON_QUERY = "\x1b[20t"
const OSC0_TITLE_QUERY = "\x1b[21t"
const OSC0_ICON_REPLY = /\x1b\]L([^\x07\x1b]*)(?:\x07|\x1b\\)/
const OSC0_TITLE_REPLY = /\x1b\]l([^\x07\x1b]*)(?:\x07|\x1b\\)/

function osc0IconTitleResult(
  iconLabel: string | null,
  windowTitle: string | null,
  raw: { icon: string; title: string },
  reasons: Record<"icon" | "title", TerminalQueryOutcome["reason"] | "feedCapture boundary">,
): ProbeCallbackResult {
  const response = JSON.stringify({ ...raw, iconLabel, windowTitle })
  if (iconLabel === null || windowTitle === null) {
    const missing = [
      ...(iconLabel === null ? [`icon label (CSI 20 t): ${reasons.icon}`] : []),
      ...(windowTitle === null ? [`window title (CSI 21 t): ${reasons.title}`] : []),
    ]
    const note = `no complete OSC 0 target reply: ${missing.join("; ")}`
    return {
      response,
      note,
      ...replyFailure(note),
    }
  }
  const iconMatches = iconLabel === OSC0_PAYLOAD
  const titleMatches = windowTitle === OSC0_PAYLOAD
  const pass = iconMatches && titleMatches
  const note = pass ? undefined : `both replies must return the OSC 0 payload ${OSC0_PAYLOAD}`
  return {
    pass,
    response,
    ...(note && { note }),
    observation: { outcome: pass ? "supported" : "unsupported", assertionType: "query_reply", ...(note && { note }) },
    assertions: [
      {
        assertionType: "query_reply" as const,
        kind: iconMatches ? "positive" : "negative",
        expected: `CSI 20 t returns ${OSC0_PAYLOAD}`,
        observed: iconLabel,
      },
      {
        assertionType: "query_reply" as const,
        kind: titleMatches ? "positive" : "negative",
        expected: `CSI 21 t returns ${OSC0_PAYLOAD}`,
        observed: windowTitle,
      },
    ],
  }
}

function mainScreenReflow(ctx: LibProbeSource): ProbeCallbackResult {
  const note = "No controlled resize and cell-content readback to measure reflow"
  const resizeSource = ctx.resize
  if (!resizeSource) return notTestedResult(note, { declaredReflow: ctx.capabilities.reflow === true })
  const initial = { cols: ctx.cols, scrollback: ctx.getScrollback() }
  const height = initial.scrollback.screenLines
  if (
    !Number.isSafeInteger(height) ||
    height < 8 ||
    initial.scrollback.totalLines !== height ||
    initial.scrollback.viewportOffset !== 0
  ) {
    return {
      pass: false,
      response: JSON.stringify(initial),
      note: "Reflow fixture needs a fresh bottom main buffer with at least eight screen rows",
      tests: [
        {
          id: "criterion",
          status: "test-failure",
          reason: "Reflow fixture has invalid geometry or pre-existing history",
        },
      ],
    }
  }
  type Frame = {
    sampleColumns: number
    cells: string[][]
    cursor: ReturnType<LibProbeSource["getCursor"]>
    scrollback: ReturnType<LibProbeSource["getScrollback"]>
    invalid?: string
  }
  type Phase = {
    id: string
    from: number
    to: number
    outcome: "reflow" | "preserved-wraps" | "truncated" | "invalid"
    reason: string
  }
  type HistoryPhase = Omit<Phase, "outcome"> & {
    outcome: Phase["outcome"] | "not-retained"
    status: "supported" | "unsupported" | "test-todo" | "test-failure"
  }
  type AlternatePhase = NonNullable<ReturnType<typeof measureAlternateReflow>["measurement"]>
  const state = {
    declaredReflow: ctx.capabilities.reflow === true,
    initial,
    fixture: { soft: "ABCDEFGHIJKLMNOPQR", hard: ["HARD-a", "HARD-b"] },
    actions: [] as Array<
      | { kind: "feed"; text: string }
      | { kind: "resize"; cols: number; rows: number }
      | { kind: "read"; name: string }
      | { kind: "reset" }
    >,
    reads: {} as Record<string, Frame>,
    phases: [] as Phase[],
    historyPhases: [] as HistoryPhase[],
    alternatePhases: [] as AlternatePhase[],
    alternateRoundtrips: {} as Record<
      string,
      {
        roundtrip: ProbeCallbackResult
        measurement?: AlternatePhase
        measurementError?: string
        identity: Record<string, boolean | null>
      }
    >,
  }
  const feed = (text: string) => {
    state.actions.push({ kind: "feed", text })
    ctx.feed(text)
  }
  const resize = (cols: number) => {
    state.actions.push({ kind: "resize", cols, rows: height })
    resizeSource.call(ctx, cols, height)
  }
  let readBound = height
  const read = (name: string, sampleColumns: number): Frame => {
    const scrollback = ctx.getScrollback()
    const invalid =
      !Number.isSafeInteger(scrollback.totalLines) ||
      scrollback.screenLines !== height ||
      scrollback.totalLines < height ||
      scrollback.totalLines > readBound
        ? `Invalid buffer counts: totalLines=${scrollback.totalLines}, screenLines=${scrollback.screenLines}, expected screenLines=${height}, maximum totalLines=${readBound}`
        : undefined
    const frame = {
      sampleColumns,
      scrollback,
      cursor: ctx.getCursor(),
      ...(invalid && { invalid }),
      cells: invalid
        ? []
        : Array.from({ length: scrollback.totalLines }, (_, row) =>
            Array.from({ length: sampleColumns }, (_, col) => ctx.getCell(row, col).char),
          ),
    }
    state.reads[name] = frame
    state.actions.push({ kind: "read", name })
    return frame
  }
  const matchesCells = (frame: Frame, lines: string[], start = 0, count = frame.cells.length) =>
    !frame.invalid &&
    frame.cells.length >= start + count &&
    lines.length <= count &&
    lines.every((line) => line.length <= frame.sampleColumns) &&
    frame.cells.slice(start, start + count).every((row, index) => {
      const expected = lines[index] ?? ""
      return row.every((char, col) => (col < expected.length ? char === expected[col] : char === "" || char === " "))
    })
  const matches = (frame: Frame, lines: string[]) =>
    frame.scrollback.totalLines === height && frame.scrollback.viewportOffset === 0 && matchesCells(frame, lines)
  const clear = (alternate = false, history = false) =>
    feed(`${alternate ? "" : "\x1b[?1049l"}\x1b[?7h\x1b[2J${alternate || history ? "" : "\x1b[3J"}\x1b[H`)
  const widthControl = (name: string, columns: number, history = false, alternate = false) => {
    clear(alternate, history)
    feed("W".repeat(columns) + "Z")
    const frame = read(name, columns)
    const lines = ["W".repeat(columns), "Z"]
    return history
      ? matchesCells(frame, lines, frame.scrollback.totalLines - frame.scrollback.screenLines, height)
      : matches(frame, lines)
  }
  const layout = (columns: number) =>
    columns === 12 ? ["ABCDEFGHIJKL", "MNOPQR", ...state.fixture.hard] : [state.fixture.soft, ...state.fixture.hard]
  let primary: { error: unknown } | undefined
  const measurementFailures: unknown[] = []
  try {
    for (const [id, from, to] of [
      ["main-grow", 12, 20],
      ["main-shrink", 20, 12],
    ] as const) {
      resize(from)
      if (!widthControl(`${id}.control-before`, from)) {
        state.phases.push({
          id,
          from,
          to,
          outcome: "invalid",
          reason: "Initial width control did not wrap at the requested column",
        })
        continue
      }
      clear()
      feed(`${state.fixture.soft}\r\n${state.fixture.hard.join("\r\n")}\r\n`)
      feed(`\x1b[${height - 2};1H`)
      const before = read(`${id}.before`, from)
      const parked =
        before.cursor.x === 0 &&
        Number.isSafeInteger(before.cursor.y) &&
        before.cursor.y >= layout(from).length &&
        before.cursor.y < height
      if (!matches(before, layout(from)) || !parked) {
        state.phases.push({
          id,
          from,
          to,
          outcome: "invalid",
          reason: "Soft-wrap and explicit-newline seed cells or cursor exclusion did not qualify",
        })
        continue
      }
      const reflowGrowth = Math.max(0, layout(to).length - layout(from).length)
      readBound = height + reflowGrowth
      resize(to)
      const after = read(`${id}.after`, to)
      readBound = height
      const control = widthControl(`${id}.control-after`, to)
      const matchesReflowed =
        matches(after, layout(to)) ||
        (reflowGrowth > 0 &&
          after.scrollback.totalLines === height + reflowGrowth &&
          (after.scrollback.viewportOffset === 0 ||
            after.scrollback.viewportOffset === after.scrollback.totalLines - after.scrollback.screenLines) &&
          matchesCells(after, layout(to)))
      const outcome = !control
        ? "invalid"
        : matchesReflowed
          ? "reflow"
          : matches(
                after,
                layout(from).map((line) => line.slice(0, to)),
              )
            ? to < from
              ? "truncated"
              : "preserved-wraps"
            : "invalid"
      const reason = !control
        ? "Post-resize width control did not wrap at the requested column"
        : outcome === "invalid"
          ? "Resize produced neither the reflowed layout nor the expected physical rows clipped to the new width"
          : outcome === "reflow"
            ? id === "main-grow"
              ? "Pre-existing soft wraps joined; explicit newlines and all target characters were preserved"
              : "The pre-existing long line wrapped at the narrower width; explicit newlines and all target characters were preserved"
            : outcome === "truncated"
              ? "Each pre-existing physical row was clipped to the narrower width without reflow; explicit newline rows stayed in place"
              : "Pre-existing physical wrap boundaries remained with all target characters preserved"
      state.phases.push({ id, from, to, outcome, reason })
    }
    for (const [id, from, to] of [
      ["history-grow", 12, 20],
      ["history-shrink", 20, 12],
    ] as const) {
      // Reset is essential here: ED2 clears the active screen, not the retained buffer.
      state.actions.push({ kind: "reset" })
      ctx.reset()
      readBound = height
      resize(from)
      const fresh = read(`${id}.fresh`, from)
      const record = (outcome: HistoryPhase["outcome"], reason: string) => {
        state.historyPhases.push({
          id,
          from,
          to,
          outcome,
          reason,
          status:
            outcome === "not-retained"
              ? "test-todo"
              : outcome === "invalid"
                ? "test-failure"
                : outcome === "reflow"
                  ? "supported"
                  : "unsupported",
        })
      }
      if (!matches(fresh, []) || !widthControl(`${id}.control-before`, from)) {
        record("invalid", fresh.invalid ?? "Fresh history fixture or initial width control did not qualify")
        continue
      }
      const witnesses = Array.from({ length: 2 * height }, (_, index) => `R${String(index).padStart(3, "0")}`)
      const beforeLines = [...layout(from), ...witnesses]
      // Include the screen extent (and any post-resize reflow growth before the ED2 width control) in the
      // feed-derived bound, but never allocate from unchecked counts.
      readBound = Math.max(beforeLines.length, layout(to).length + witnesses.length) + height
      clear()
      feed([state.fixture.soft, ...state.fixture.hard, ...witnesses].join("\r\n"))
      const before = read(`${id}.before`, from)
      const retained = before.scrollback.totalLines - before.scrollback.screenLines
      if (before.invalid) {
        record("invalid", before.invalid)
        continue
      }
      // Starting at a fresh buffer, every scroll must still be retained to keep the first target row.
      // H >= target height alone is insufficient: bounded engines can already have evicted the target.
      const requiredHistory = beforeLines.length - height
      if (retained < requiredHistory) {
        if (!matchesCells(before, beforeLines.slice(-before.scrollback.totalLines))) {
          record("invalid", "Retained buffer does not match the fed tail; target retention is unresolved")
        } else {
          record(
            "not-retained",
            retained === 0
              ? "engine retained no history"
              : `target not fully retained (H=${retained}, need ${requiredHistory})`,
          )
        }
        continue
      }
      if (before.scrollback.totalLines !== beforeLines.length || !matchesCells(before, beforeLines)) {
        record("invalid", "Complete retained seed, hard witnesses or blank tails did not qualify")
        continue
      }
      resize(to)
      // Preserve the target before the destructive control; control uses this same resized state.
      const after = read(`${id}.after`, to)
      const control = widthControl(`${id}.control-after`, to, true)
      const invalidControl = state.reads[`${id}.control-after`]?.invalid
      const reflowed = [...layout(to), ...witnesses]
      const preserved = beforeLines.map((line) => line.slice(0, to))
      const outcome =
        !control || after.invalid
          ? "invalid"
          : after.scrollback.totalLines === reflowed.length && matchesCells(after, reflowed)
            ? "reflow"
            : after.scrollback.totalLines === preserved.length && matchesCells(after, preserved)
              ? to < from
                ? "truncated"
                : "preserved-wraps"
              : "invalid"
      record(
        outcome,
        after.invalid ??
          invalidControl ??
          (!control
            ? "Post-resize width control did not wrap at the requested column"
            : outcome === "invalid"
              ? "Resize matched neither complete retained layout; loss or eviction is unresolved"
              : outcome === "reflow"
                ? "Retained soft line reflowed; all explicit boundaries, hard witnesses and blank tails were conserved"
                : "Retained physical rows were preserved or clipped; all hard witnesses and blank tails were conserved"),
      )
    }
    for (const [id, from, to] of [
      ["alternate-grow", 12, 20],
      ["alternate-shrink", 20, 12],
    ] as const) {
      state.actions.push({ kind: "reset" })
      ctx.reset()
      readBound = height
      resize(from)
      const fresh = read(`${id}.fresh`, from)
      const phase = (outcome: AlternatePhase["outcome"], reason: string): AlternatePhase => ({
        id,
        from,
        to,
        outcome,
        reason,
        status:
          outcome === "identity-unavailable" || outcome === "not-entered"
            ? "test-todo"
            : outcome === "invalid"
              ? "test-failure"
              : outcome === "reflow"
                ? "supported"
                : "unsupported",
      })
      if (!matches(fresh, [])) {
        state.alternatePhases.push(phase("invalid", fresh.invalid ?? "Fresh alternate fixture did not qualify"))
        continue
      }
      const identity: Record<string, boolean | null> = { before: ctx.getMode("altScreen") }
      // Log the shared roundtrip's feeds as well as the fixture's. Read actual mode state immediately
      // after its measured enter/leave; the declaration bit is never a buffer-identity witness.
      const roundtripSource = Object.create(ctx) as LibProbeSource
      roundtripSource.feed = (text) => {
        feed(text)
        if (text === "\x1b[?1049h") identity.entered = ctx.getMode("altScreen")
        if (text === "\x1b[?1049l") identity.restored = ctx.getMode("altScreen")
      }
      let slotFailure: { error: unknown } | undefined
      const evidence = measureAlternateReflow(roundtripSource, () => {
        try {
          if (identity.before === true || identity.entered === false) {
            return phase("invalid", "Alternate identity contradicts the measured primary isolation")
          }
          if (identity.before !== false || identity.entered !== true) {
            return phase("identity-unavailable", "alternate buffer identity unavailable")
          }
          if (!widthControl(`${id}.control-before`, from, false, true)) {
            return phase("invalid", "Initial alternate width control did not wrap at the requested column")
          }
          clear(true)
          feed(`${state.fixture.soft}\r\n${state.fixture.hard.join("\r\n")}\r\n`)
          feed(`\x1b[${height - 2};1H`)
          const before = read(`${id}.before`, from)
          const parked =
            before.cursor.x === 0 &&
            Number.isSafeInteger(before.cursor.y) &&
            before.cursor.y >= layout(from).length &&
            before.cursor.y < height
          identity.seed = ctx.getMode("altScreen")
          if (!matches(before, layout(from)) || !parked || identity.seed === false) {
            return phase("invalid", "Alternate seed cells, blank tails, geometry, cursor or identity did not qualify")
          }
          if (identity.seed !== true) return phase("identity-unavailable", "alternate buffer identity unavailable")
          resize(to)
          const after = read(`${id}.after`, to)
          identity.target = ctx.getMode("altScreen")
          // Destructive control stays on this same resized alternate state, after target readback.
          const control = widthControl(`${id}.control-after`, to, false, true)
          identity.control = ctx.getMode("altScreen")
          const layoutOutcome = matches(after, layout(to))
            ? "reflow"
            : matches(
                  after,
                  layout(from).map((line) => line.slice(0, to)),
                )
              ? to < from
                ? "truncated"
                : "preserved-wraps"
              : "invalid"
          const outcome =
            !control || layoutOutcome === "invalid" || identity.target === false || identity.control === false
              ? "invalid"
              : identity.target !== true || identity.control !== true
                ? "identity-unavailable"
                : layoutOutcome
          return phase(
            outcome,
            !control
              ? "Post-resize alternate width control did not wrap at the requested column"
              : identity.target === false || identity.control === false
                ? "Alternate buffer identity changed during target or width-control readback"
                : outcome === "identity-unavailable"
                  ? "alternate buffer identity unavailable"
                  : outcome === "invalid"
                    ? "Alternate resize matched neither complete layout, including hard rows and blank tails"
                    : outcome === "reflow"
                      ? "Alternate soft line reflowed; explicit boundaries and complete blank tails were conserved"
                      : "Alternate physical rows were preserved or clipped; all hard rows and blank tails were conserved",
          )
        } catch (error) {
          slotFailure = { error }
          throw error
        }
      })
      // Keep original causes outside the JSON evidence. A later cleanup failure must not hide a
      // slot error merely because the shared leaves succeeded and returned its invalid phase.
      if (slotFailure) measurementFailures.push(slotFailure.error)
      identity.after = ctx.getMode("altScreen")
      state.alternateRoundtrips[id] = { ...evidence, identity }
      let result: AlternatePhase
      if (evidence.measurementError !== undefined) {
        result = phase("invalid", `Alternate measurement failed: ${evidence.measurementError}`)
      } else if (evidence.measurement) {
        result = evidence.measurement
        if (!evidence.roundtrip.pass || identity.restored === true || identity.after === true) {
          result = phase(
            "invalid",
            `Primary restoration after alternate measurement did not qualify: ${evidence.roundtrip.note ?? evidence.roundtrip.response}`,
          )
        } else if (result.outcome !== "invalid" && (identity.restored !== false || identity.after !== false)) {
          result = phase("identity-unavailable", "alternate buffer identity unavailable")
        }
      } else if (
        evidence.roundtrip.observation?.outcome === "unsupported" &&
        identity.before === false &&
        identity.entered === false
      ) {
        result = phase("not-entered", "alternate buffer not entered")
      } else if (
        evidence.roundtrip.observation?.outcome === "unsupported" &&
        identity.entered !== undefined &&
        (identity.before === null || identity.entered === null)
      ) {
        result = phase("identity-unavailable", "alternate buffer identity unavailable")
      } else {
        result = phase(
          "invalid",
          `Alternate isolation did not qualify: ${evidence.roundtrip.note ?? evidence.roundtrip.response}`,
        )
      }
      state.alternatePhases.push(result)
    }
  } catch (error) {
    primary = { error }
    throw error
  } finally {
    const failures: unknown[] = [...measurementFailures, ...(primary ? [primary.error] : [])]
    const beforeCleanup = failures.length
    for (const cleanup of [
      () => feed("\x1b[?1049l"),
      () => resize(initial.cols),
      () => {
        state.actions.push({ kind: "reset" })
        ctx.reset()
      },
    ]) {
      try {
        cleanup()
      } catch (error) {
        failures.push(error)
      }
    }
    if (failures.length > beforeCleanup || (primary && measurementFailures.length > 0)) {
      const messages = failures.map((error) => (error instanceof Error ? error.message : String(error))).join("; ")
      throw new AggregateError(failures, `Reflow cleanup failed: ${messages}`, { cause: failures[0] })
    }
  }
  const gradedPhases = [...state.phases, ...state.historyPhases]
  const resultNote = [
    gradedPhases.every((phase) => phase.outcome === "reflow")
      ? "ASCII reflow measured on main screen and retained history; wide characters, cursor on a wrapped line and terminal-app resize unmeasured"
      : "Main-screen and retained-history ASCII reflow attempted; wide characters, cursor on a wrapped line and terminal-app resize unmeasured",
    ...gradedPhases.map((phase) => `${phase.id}: ${phase.reason}`),
    `Alternate screen (reported, not graded): ${state.alternatePhases.map((phase) => `${phase.id}: ${phase.reason}`).join("; ")}`,
  ].join("; ")
  const response = JSON.stringify(state)
  const assertedPhases = [...state.phases, ...state.historyPhases, ...state.alternatePhases].filter(
    (phase) => phase.outcome === "reflow" || phase.outcome === "preserved-wraps" || phase.outcome === "truncated",
  )
  const assertions = assertedPhases.map((phase) => ({
    assertionType: "buffer_state" as const,
    kind: phase.outcome === "reflow" ? ("positive" as const) : ("negative" as const),
    expected: `${phase.id}: reflow at the new width with conserved content and explicit newline boundaries`,
    observed: response,
  }))
  return {
    pass: false,
    response,
    note: resultNote,
    observation: {
      outcome: "inconclusive",
      reason: "insufficient-evidence",
      assertionType: "buffer_state",
      note: resultNote,
    },
    ...(assertions.length > 0 && { assertions }),
    tests: [
      ...state.phases.map((phase) => ({
        id: phase.id,
        status:
          phase.outcome === "invalid"
            ? ("test-failure" as const)
            : phase.outcome === "reflow"
              ? ("supported" as const)
              : ("unsupported" as const),
        reason: phase.reason,
        assertionRefs: assertedPhases.flatMap((asserted, index) => (asserted.id === phase.id ? [index] : [])),
      })),
      ...(state.phases.every((phase) => phase.outcome !== "invalid") &&
      new Set(state.phases.map((phase) => phase.outcome === "reflow")).size > 1
        ? [
            {
              id: "criterion",
              status: "test-failure" as const,
              reason:
                "Growth and shrink have different reflow outcomes; the combined main-screen criterion is unresolved",
              assertionRefs: assertedPhases.flatMap((phase, index) =>
                phase.id === "main-grow" || phase.id === "main-shrink" ? [index] : [],
              ),
            },
          ]
        : []),
      ...state.historyPhases.map((phase) => ({
        id: phase.id,
        status: phase.status,
        reason: phase.reason,
        assertionRefs: assertedPhases.flatMap((asserted, index) => (asserted.id === phase.id ? [index] : [])),
      })),
    ],
  }
}

export const extensionsProbes: ProbeDefinition[] = [
  // Truecolor — capability flag (termless) or SGR parse check (term)
  {
    ...probe(
      "extensions.truecolor",
      (ctx) => {
        // Use the same independent controls and two RGB samples as sgr.fg.truecolor.
        const first = { r: 255, g: 128, b: 0 }
        const second = { r: 17, g: 97, b: 201 }
        ctx.feed("C\x1b[31mA\x1b[34mB\x1b[38;2;255;128;0mX\x1b[38;2;17;97;201mY")
        const baseline = ctx.getCell(0, 0)
        const controlFirst = ctx.getCell(0, 1)
        const controlSecond = ctx.getCell(0, 2)
        const targetFirst = ctx.getCell(0, 3)
        const targetSecond = ctx.getCell(0, 4)
        const state = { baseline, controlFirst, controlSecond, targetFirst, targetSecond }
        const expected = "Two distinct direct-RGB foreground samples match their requested values"
        const same = (a: typeof first | null, b: typeof first) =>
          a !== null && a !== undefined && a.r === b.r && a.g === b.g && a.b === b.b
        const framed =
          baseline.char === "C" &&
          controlFirst.char === "A" &&
          controlSecond.char === "B" &&
          targetFirst.char === "X" &&
          targetSecond.char === "Y"
        if (framed && (!targetFirst.fg || !targetSecond.fg)) {
          // #30701, @cto ruling C: an RGB target that reads no color is a measured ignore while the
          // independent controls show two distinct colors; without them the channel is not shown.
          if (controlFirst.fg && controlSecond.fg && !sameRgbCells(controlFirst.fg, controlSecond.fg)) {
            return parserStateResult(false, expected, state)
          }
          return parserStateResult(
            null,
            expected,
            state,
            undefined,
            "independent foreground color controls (SGR 31 and 34) distinguishable in the headless readback",
          )
        }
        if (
          baseline.char !== "C" ||
          controlFirst.char !== "A" ||
          controlSecond.char !== "B" ||
          targetFirst.char !== "X" ||
          targetSecond.char !== "Y" ||
          !targetFirst.fg ||
          !targetSecond.fg
        ) {
          return parserStateResult(null, expected, state, "RGB targets or controls were not exposed")
        }
        if (!controlSecond.fg || same(controlSecond.fg, first)) {
          return parserStateResult(null, expected, state, "The preceding color can mimic an ignored RGB request")
        }
        if (same(targetFirst.fg, first) && same(targetSecond.fg, second)) {
          return parserStateResult(true, expected, state)
        }
        if (controlFirst.fg && !sameRgbCells(controlFirst.fg, controlSecond.fg)) {
          return parserStateResult(false, expected, state)
        }
        return parserStateResult(null, expected, state, "Independent color-channel calibration was absent")
      },
      // The row's claim is the one sgr.fg.truecolor states: the cell stores the exact RGB values.
      // DECRQSS SGR is therefore its oracle, not a pixel comparison of rendered glyphs.
      sgrTermReadback(
        "extensions.truecolor",
        "\x1b[38;2;255;128;0m",
        { require: [38], requireTokens: ["38:2:255:128:0"] },
        async (ctx) => {
          ctx.write("\x1b[1;1H\x1b[2K")
          ctx.write("\x1b[38;2;255;0;128mX\x1b[0m")
          const pos = await ctx.queryCursorPosition()
          if (!pos) return unverifiedEffect(ctx, "No cursor response; RGB color was not measured")
          return unverifiedEffect(
            ctx,
            pos.col === 2
              ? "SGR was consumed; RGB cell color was not measured"
              : `Cursor at col ${pos.col}; RGB color was not measured`,
          )
        },
      ),
      null,
    ),
    termNeedsGeometry: true,
    libAssertionType: "buffer_state",
  },

  // Font ligatures — a renderer glyph-shaping decision with no protocol query. The app callback
  // captures a spaced-operator control and a contiguous-operator target from the same font and
  // geometry; a ligature paints as one shaped glyph in the target run. The frames are retained
  // for review, so no automatic pass or fail is claimed. The headless parser shapes no glyphs.
  {
    ...probe(
      "extensions.font-ligatures",
      () => {
        const note = "Font ligatures are renderer glyph shaping; the headless parser shapes no glyphs"
        return reviewResult(HEADLESS_OBSERVABLE_REVIEW, `Headless observable review required: ${note}`, note, {
          ligatureSample: FONT_LIGATURE_TARGET,
        })
      },
      async (ctx) => {
        if (!ctx.capture) {
          return notTestedResult("Font ligatures need rendered pixels; this context exposes no capture callback", {
            ligatureSample: FONT_LIGATURE_TARGET,
          })
        }
        const refusal = sgrCaptureTooSmall(ctx, "extensions.font-ligatures")
        if (refusal) return refusal
        try {
          return await sgrCaptureFrames(
            ctx,
            "\x1b[0m\x1b[2J\x1b[3;3H" + FONT_LIGATURE_CONTROL,
            "\x1b[0m\x1b[2J\x1b[3;3H" + FONT_LIGATURE_TARGET,
            "extensions.font-ligatures",
            { control: FONT_LIGATURE_CONTROL, target: FONT_LIGATURE_TARGET, startRow: 3, startCol: 3 },
            "Spaced operators (control) and contiguous operators (target) in the same font and geometry; a ligature paints as one shaped glyph in the target. Record the active font before grading",
          )
        } finally {
          // Disposable owned run: clear the surface so no sample text is left behind.
          ctx.write("\x1b[0m\x1b[2J\x1b[H")
        }
      },
      "screenshot",
    ),
    termNeedsGeometry: true,
    libAssertionType: null,
  },

  // Kitty keyboard protocol
  kittyKeyboardFlagProbe("extensions.kitty-keyboard", 1, 1),

  // Kitty keyboard: individual progressive enhancement flags
  // Each probe pushes+queries in a single write to avoid race conditions,
  // then pops after response is received.
  kittyKeyboardFlagProbe("extensions.kitty-keyboard.disambiguate", 1, 1), // Flag 1: DISAMBIGUATE
  kittyKeyboardFlagProbe("extensions.kitty-keyboard.report-events", 3, 2), // Flag 2: REPORT_EVENTS
  kittyKeyboardFlagProbe("extensions.kitty-keyboard.report-alternate", 5, 4), // Flag 4: REPORT_ALTERNATE
  kittyKeyboardFlagProbe("extensions.kitty-keyboard.report-all-keys", 9, 8), // Flag 8: REPORT_ALL_KEYS
  kittyKeyboardFlagProbe("extensions.kitty-keyboard.report-text", 25, 24), // REPORT_TEXT requires REPORT_ALL_KEYS.

  // The specified query action replies before the DA1 sentinel and stores no image.
  // A cursor movement is never evidence that pixels were rendered.
  {
    ...queryOnly(
      probe(
        "extensions.kitty-graphics",
        (ctx) => {
          if (ctx.queryWithSentinelOutcome) {
            return graphicsQueryOutcomeResult(ctx.queryWithSentinelOutcome(GRAPHICS_QUERY, GRAPHICS_QUERY_REPLY))
          }
          const raw = ctx.feedCapture(GRAPHICS_QUERY)
          return graphicsQueryOutcomeResult(rawQueryOutcome(raw, GRAPHICS_QUERY_REPLY.exec(raw)))
        },
        async (ctx) =>
          graphicsQueryOutcomeResult(await ctx.queryWithSentinelOutcome(GRAPHICS_QUERY, GRAPHICS_QUERY_REPLY)),
        "query_reply",
      ),
    ),
    libAssertionType: "query_reply",
  },

  // Transmission and placement acknowledgements are separate from rendered pixels.
  kittyImageTransferProbe("extensions.kitty-graphics.transmit", false),
  kittyImageTransferProbe("extensions.kitty-graphics.display", true),

  probe(
    "extensions.kitty-graphics.animation",
    (ctx) => {
      if (replyPathAuditFor(ctx, "extensions.kitty-graphics.animation")) ctx.feedCapture(GRAPHICS_QUERY)
      const note = "Declared Kitty graphics capability does not establish timed animation playback"
      return reviewResult(HEADLESS_OBSERVABLE_REVIEW, `Headless observable review required: ${note}`, note, {
        declared: ctx.capabilities.kittyGraphics === true,
      })
    },
    async (ctx) => {
      const id = "extensions.kitty-graphics.animation"
      const capture = ctx.capture
      if (!capture) {
        // No pixel adapter: an instrument limit, named before a byte, never a feature verdict.
        const note =
          "Kitty animation is pixels over time; this arm has no pixel capture, so the missing adapter is pixel capture and playback is not observable here"
        return {
          pass: false,
          note,
          tests: [{ id: "criterion", status: "test-todo", reason: note }],
        }
      }
      if (ctx.captureKind === "text-cells") {
        return kittyUnobservableResult(id, "a text snapshot has no pixels, so timed playback cannot be seen")
      }
      const refusal = sgrCaptureTooSmall(ctx, id)
      if (refusal) return refusal
      const reported = await captureRegionGeometry(ctx, id, { region: { ...KITTY_REGION }, ...KITTY_BOUNDS })
      if ("pass" in reported) return reported
      const geometry = reported.geometry
      if (!geometry) {
        return kittyUnobservableResult(
          id,
          "this pixel arm reported no cell-to-pixel geometry, so the compared rectangle cannot be aligned to cells",
        )
      }
      const size = kittyBlockPixels(geometry)
      const frames: ObservationFrame[] = []
      const ids: number[] = []
      const shoot = async (role: "control" | "target", label: string) => {
        const frame = await capture({ role, label, cells: { ...KITTY_REGION }, pixelGeometry: geometry })
        frames.push(frame)
        return frame
      }
      const whole = async (role: "control" | "target", label: string) => {
        const frame = await capture({ role, label, pixelGeometry: geometry })
        frames.push(frame)
        return frame
      }
      beginCaptureLifecycle(ctx)
      try {
        ctx.write(KITTY_CLEAR)
        ctx.write(kittyPark())
        const playbackId = kittyImageNumber()
        ids.push(playbackId)
        ctx.write(kittyFrameTransfer(playbackId, { ...size, rgb: KITTY_FRAME_RED }, { root: true }))
        ctx.write(kittyFrameTransfer(playbackId, { ...size, rgb: KITTY_FRAME_BLUE }))
        // The root frame carries no gap at transfer time; its gap is set by the control code.
        ctx.write(kittyRootGap(playbackId))
        ctx.write(kittyBlockOrigin())
        const placement = await ctx.queryWithSentinelOutcome(
          kittyPlace(playbackId),
          kittyReplyFrame({ i: String(playbackId) }),
        )
        ctx.write(kittyPark())
        ctx.write(kittyStartPlayback(playbackId))
        const playbackFirst = await shoot(
          "target",
          `Terminal-driven playback, first frame of a ${String(KITTY_GAP_MS)} ms gap, loop v=${String(KITTY_LOOP_FOREVER)}`,
        )
        // The interval is measured from this capture's completion, and the elapsed value travels in
        // the response, so a reader never has to infer the wait from the gap it asked for.
        const intervalStart = Date.now()
        await kittyWait(KITTY_GAP_MS * KITTY_WAIT_FACTOR)
        const playbackSecond = await shoot(
          "target",
          "Terminal-driven playback, second frame after 1.5x the gap with no write between the pair",
        )
        const playbackElapsedMs = Date.now() - intervalStart
        let retry: KittyDigestPair | null = null
        if (playbackFirst.regionDigest === playbackSecond.regionDigest) {
          await kittyWait(KITTY_GAP_MS * KITTY_RETRY_FACTOR)
          const retried = await shoot(
            "target",
            "Terminal-driven playback retried at twice the gap, no write since the equal pair",
          )
          retry = [playbackSecond.regionDigest, retried.regionDigest]
        }
        // Arm 2 — the update control. Selecting a frame by hand must change the rectangle; an equal
        // pair here means the image pipeline is unproven and no negative may be taken from arm 1.
        ctx.write(kittyStopPlayback(playbackId))
        ctx.write(kittySelectFrame(playbackId, 1))
        const clientFirst = await shoot("control", "Client-driven frame selection, frame 1 of a stopped animation")
        ctx.write(kittySelectFrame(playbackId, 2))
        const clientSecond = await shoot(
          "control",
          "Client-driven frame selection, frame 2 of the same stopped animation",
        )
        ctx.write(kittyDeleteImage(playbackId))
        // Arm 3 — a one-frame image over the same intervals must hold still.
        const stillId = kittyImageNumber()
        ids.push(stillId)
        ctx.write(KITTY_CLEAR)
        ctx.write(kittyPark())
        ctx.write(kittyFrameTransfer(stillId, { ...size, rgb: KITTY_FRAME_RED }, { root: true }))
        ctx.write(kittyBlockOrigin())
        await ctx.queryWithSentinelOutcome(kittyPlace(stillId), kittyReplyFrame({ i: String(stillId) }))
        ctx.write(kittyPark())
        const stillFirst = await shoot("control", "One-frame image, first capture over the playback intervals")
        await kittyWait(KITTY_GAP_MS * KITTY_WAIT_FACTOR)
        const stillSecond = await shoot("control", "One-frame image, second capture over the same interval")
        // Arm 4 — the cursor-only control. Both captures keep the cursor OUTSIDE the compared
        // rectangle and differ only by which outside row it parks on, so a change here would mean
        // the cursor is inside the rectangle and the comparison is contaminated.
        const cursorFirst = await shoot("control", "Cursor-only control, cursor parked on the parking row")
        ctx.write("\x1b[1;1H")
        const cursorSecond = await shoot(
          "control",
          "Cursor-only control, cursor moved to row 1, still outside the rectangle",
        )
        // Arm 5 — one ordinary glyph outside the rectangle must change the captured screen.
        const redrawFirst = await whole("control", "Redraw control, whole window before one ordinary glyph")
        ctx.write("\x1b[1;1HQ")
        const redrawSecond = await whole(
          "control",
          "Redraw control, whole window after one ordinary glyph outside the rectangle",
        )
        const verdict = decideKittyAnimation({
          playback: [playbackFirst.regionDigest, playbackSecond.regionDigest],
          retry,
          clientFrame: [clientFirst.regionDigest, clientSecond.regionDigest],
          still: [stillFirst.regionDigest, stillSecond.regionDigest],
          cursorOnly: [cursorFirst.regionDigest, cursorSecond.regionDigest],
          redraw: [redrawFirst.pixelsDigest, redrawSecond.pixelsDigest],
          playbackElapsedMs,
        })
        const observed = JSON.stringify({
          id,
          region: KITTY_REGION,
          gapMs: KITTY_GAP_MS,
          loop: KITTY_LOOP_FOREVER,
          playbackElapsedMs,
          playback: verdict.outcome,
          placementAck: placement.raw,
          frames: frames.map((frame) => ({ role: frame.role, ref: frame.ref, label: frame.label })),
        })
        return {
          pass: verdict.outcome === "supported",
          response: observed,
          observation: {
            outcome: verdict.outcome,
            ...(verdict.outcome === "inconclusive" ? { reason: "insufficient-evidence" as const } : {}),
            assertionType: "screenshot",
            screenshotRef: playbackSecond.ref,
            frames,
            note: verdict.note,
          },
          ...(verdict.decidedBy === "a missing region digest"
            ? {
                criterionBranch: HEADLESS_OBSERVABLE_REVIEW,
                tests: [{ id: "review" as const, status: "test-todo" as const, reason: verdict.note }],
              }
            : {}),
          ...(verdict.outcome === "inconclusive"
            ? {}
            : {
                assertions: [
                  {
                    assertionType: "screenshot" as const,
                    kind: verdict.outcome === "supported" ? ("positive" as const) : ("negative" as const),
                    expected:
                      "Two target frames of one run, no write between them, differ on the animation rectangle while frame selection differs, a one-frame image holds still, the cursor-only capture is equal and a redraw changes the screen outside the rectangle",
                    observed,
                    note: `decided by ${verdict.decidedBy}`,
                  },
                ],
              }),
        }
      } finally {
        for (const imageId of ids) ctx.write(kittyDeleteImage(imageId))
        endCaptureLifecycle(ctx)
      }
    },
    "screenshot",
  ),

  probe(
    "extensions.kitty-graphics.unicode-placeholders",
    (ctx) => {
      if (replyPathAuditFor(ctx, "extensions.kitty-graphics.unicode-placeholders")) ctx.feedCapture(GRAPHICS_QUERY)
      const note = "Declared Kitty graphics capability does not establish Unicode placeholder rendering"
      return reviewResult(HEADLESS_OBSERVABLE_REVIEW, `Headless observable review required: ${note}`, note, {
        declared: ctx.capabilities.kittyGraphics === true,
      })
    },
    async (ctx) => {
      const id = "extensions.kitty-graphics.unicode-placeholders"
      const capture = ctx.capture
      if (!capture) {
        const note =
          "Kitty unicode placeholders are a composited image over cells; this arm has no pixel capture, so the missing adapter is pixel capture and the placeholder rendering is not observable here"
        return {
          pass: false,
          note,
          tests: [{ id: "criterion", status: "test-todo", reason: note }],
        }
      }
      if (ctx.captureKind === "text-cells") {
        return kittyUnobservableResult(
          id,
          "this run reads the terminal's cells and no pixels, so a composited image cannot be seen; the cell readback alone never decides this row",
        )
      }
      const refusal = sgrCaptureTooSmall(ctx, id)
      if (refusal) return refusal
      const reported = await captureRegionGeometry(ctx, id, {
        region: { ...KITTY_REGION },
        ...KITTY_PLACEHOLDER_BOUNDS,
      })
      if ("pass" in reported) return reported
      const geometry = reported.geometry
      if (!geometry) {
        return kittyUnobservableResult(
          id,
          "this pixel arm reported no cell-to-pixel geometry, so the placeholder rectangle cannot be aligned to cells",
        )
      }
      const size = kittyBlockPixels(geometry)
      const frames: ObservationFrame[] = []
      const ids: number[] = []
      const shoot = async (
        role: "control" | "target",
        label: string,
        region: {
          readonly top: number
          readonly left: number
          readonly bottom: number
          readonly right: number
        } = KITTY_REGION,
      ) => {
        const frame = await capture({ role, label, cells: { ...region }, pixelGeometry: geometry })
        frames.push(frame)
        return frame
      }
      // A cell adapter, when the run exposes one, can only VETO: two states that read back different
      // text compared two different screens. A pixel run exposes none, and that absence is recorded.
      const readCells = async (label: string) => {
        if (!ctx.cells) return undefined
        const frame = await ctx.cells({ role: "control", label, cells: { ...KITTY_REGION }, pixelGeometry: geometry })
        frames.push(frame)
        return frame.cellDigest
      }
      beginCaptureLifecycle(ctx)
      try {
        ctx.write(KITTY_CLEAR)
        const placeholderId = kittyPlaceholderNumber()
        ids.push(placeholderId)
        ctx.write(kittyVirtualPlacement(placeholderId, { ...size, rgb: KITTY_FRAME_RED }))
        ctx.write(kittyPlaceholderText(placeholderId))
        const withImageFirst = await shoot(
          "target",
          `Placeholder grid with image ${String(placeholderId)} composited over U+10EEEE cells`,
        )
        // A single equal pair is never a negative: the with-image state is re-read after a delay
        // before any unsupported verdict (the same delayed-capture shape reset.decaln uses).
        await kittyWait(KITTY_GAP_MS * KITTY_WAIT_FACTOR)
        const withImageSecond = await shoot(
          "target",
          "Placeholder grid with the image, re-captured after a delayed interval and no write since",
        )
        // Control 1: the same guard bytes beside the grid and on the row below it, captured in the
        // with-image state. A terminal that reflows when the image arrives moves this text.
        const guardWithImage = await shoot(
          "control",
          `Layout guard "${KITTY_GUARD_TEXT}" beside the placeholder grid and on the row below it, with the image`,
          KITTY_GUARD_REGION,
        )
        const cellsWithImage = await readCells("Placeholder rectangle cells with the image composited")
        ctx.write(kittyDeleteImage(placeholderId))
        ctx.write(KITTY_CLEAR)
        ctx.write(kittyPlaceholderText(placeholderId))
        const withoutImage = await shoot(
          "control",
          "The same placeholder characters and foreground colour with the image deleted",
        )
        const guardWithoutImage = await shoot(
          "control",
          "Layout guard beside the placeholder grid and on the row below it, with the image deleted",
          KITTY_GUARD_REGION,
        )
        const cellsWithoutImage = await readCells("Placeholder rectangle cells with the image deleted")
        // The live control: the same pixels painted by an ordinary placement in the same rectangle,
        // measured against a captured blank rather than assumed from an acknowledgement.
        ctx.write(KITTY_CLEAR)
        ctx.write(kittyPark())
        const ordinaryId = kittyPlaceholderNumber()
        ids.push(ordinaryId)
        const blank = await shoot("control", "Blank rectangle captured before the ordinary placement")
        ctx.write(kittyFrameTransfer(ordinaryId, { ...size, rgb: KITTY_FRAME_RED }, { root: true }))
        ctx.write(kittyBlockOrigin())
        await ctx.queryWithSentinelOutcome(kittyPlace(ordinaryId), kittyReplyFrame({ i: String(ordinaryId) }))
        ctx.write(kittyPark())
        const ordinary = await shoot("control", "Ordinary a=p placement of the same pixels in the same rectangle")
        const verdict = decideKittyPlaceholders({
          withImage: [withImageFirst.regionDigest, withImageSecond.regionDigest],
          withoutImage: withoutImage.regionDigest,
          guard: [guardWithImage.regionDigest, guardWithoutImage.regionDigest],
          blank: blank.regionDigest,
          ordinary: ordinary.regionDigest,
          cellReadback:
            cellsWithImage === undefined || cellsWithoutImage === undefined
              ? null
              : [cellsWithImage, cellsWithoutImage],
        })
        const observed = JSON.stringify({
          id,
          region: KITTY_REGION,
          guardRegion: KITTY_GUARD_REGION,
          placeholderId,
          ordinaryId,
          guard: { withImage: guardWithImage.regionDigest, withoutImage: guardWithoutImage.regionDigest },
          digests: {
            withImage: [withImageFirst.regionDigest, withImageSecond.regionDigest],
            withoutImage: withoutImage.regionDigest,
            blank: blank.regionDigest,
            ordinary: ordinary.regionDigest,
          },
          cellReadback:
            cellsWithImage === undefined ? "unavailable: this pixel arm exposes no cell adapter" : "compared",
          frames: frames.map((frame) => ({ role: frame.role, ref: frame.ref, label: frame.label })),
        })
        return {
          pass: verdict.outcome === "supported",
          response: observed,
          observation: {
            outcome: verdict.outcome,
            ...(verdict.outcome === "inconclusive" ? { reason: "insufficient-evidence" as const } : {}),
            assertionType: "screenshot",
            screenshotRef: withImageSecond.ref,
            frames,
            note: verdict.note,
          },
          ...(verdict.decidedBy === "a missing region digest"
            ? {
                criterionBranch: HEADLESS_OBSERVABLE_REVIEW,
                tests: [{ id: "review" as const, status: "test-todo" as const, reason: verdict.note }],
              }
            : {}),
          ...(verdict.outcome === "inconclusive"
            ? {}
            : {
                assertions: [
                  {
                    assertionType: "screenshot" as const,
                    kind: verdict.outcome === "supported" ? ("positive" as const) : ("negative" as const),
                    expected:
                      "The placeholder rectangle differs from the same characters with the image deleted, is pixel-identical to an ordinary placement of the same opaque image over the same cells, and the identical layout guard beside it did not move while the ordinary placement painted against the captured blank",
                    observed,
                    note: `decided by ${verdict.decidedBy}`,
                  },
                ],
              }),
        }
      } finally {
        for (const imageId of ids) ctx.write(kittyDeleteImage(imageId))
        endCaptureLifecycle(ctx)
      }
    },
    "screenshot",
  ),

  // Sixel — rendering remains unmeasured without pixel readback.
  {
    ...probe(
      "extensions.sixel",
      (ctx) => {
        // An engine whose audited source has no DCS handler takes the source-negative review (#32225).
        const audit = auditedOscEngine(ctx.runtimeIdentity)?.[1]
        if (!ctx.getSixelImages && audit && "absentSixel" in audit && audit.absentSixel) {
          return sourceAbsentSentinel(
            ctx,
            "extensions.sixel: the engine stores DCS q Sixel images (a Sixel handler exists at the pinned source)",
            "\x1bPq#1;2;100;0;0~\x1b\\",
            "Sixel image",
            audit.sixelSourceCitation,
          )
        }
        if (ctx.getSixelImages) {
          ctx.feed("\x1b[1;1H")
          const before = ctx.getSixelImages()
          const firstData = "#1;2;100;0;0~"
          ctx.feed(`\x1bPq${firstData}\x1b\\`)
          const first = ctx.getSixelImages()
          ctx.feed("\x1b[2;3H")
          const secondBefore = ctx.getSixelImages()
          const secondData = "#2;2;0;100;0!2~"
          ctx.feed(`\x1bPq${secondData}\x1b\\`)
          const second = ctx.getSixelImages()
          const firstImage = first[before.length]
          const secondImage = second[secondBefore.length]
          const retained =
            first.length === before.length + 1 &&
            firstImage?.data === firstData &&
            firstImage.row === 0 &&
            firstImage.col === 0 &&
            second.length === secondBefore.length + 1 &&
            secondImage?.data === secondData &&
            secondImage.row === 1 &&
            secondImage.col === 2
          const note = retained
            ? "payload retained at row/col; no raster; cell geometry unmeasured"
            : "Sixel payload/position readback did not show new stored records; no raster; cell geometry unmeasured"
          return reviewResult(HEADLESS_OBSERVABLE_REVIEW, note, note, {
            declared: ctx.capabilities.sixel === true,
            storage: { retained, before, first, secondBefore, second },
          })
        }
        const note = "Declared Sixel capability does not establish rendered pixels"
        return reviewResult(HEADLESS_OBSERVABLE_REVIEW, `Headless observable review required: ${note}`, note, {
          declared: ctx.capabilities.sixel === true,
        })
      },
      async (ctx) => {
        // Sixel paints outside the cell grid. On an arm that reads cells there is nothing to
        // compare, and the missing adapter is pixel capture — named before a byte, as an
        // instrument limit in the 3a8bddd5 shape, never a feature verdict.
        if (!ctx.capture || ctx.captureKind === "text-cells") {
          const note =
            "Sixel paints pixels outside the cell grid; this arm has no pixel capture, so the missing adapter is pixel capture and the rendering is not observable here"
          return {
            pass: false,
            note,
            tests: [{ id: "criterion", status: "test-todo", reason: note }],
          }
        }
        const refusal = sgrCaptureTooSmall(ctx, "extensions.sixel")
        if (refusal) return refusal
        // Geometry first: the tile's size is a function of THIS run's report, so the frame cannot be
        // built before it is known. A missing or unusable report is refused by name, not guessed.
        const reported = await captureRegionGeometry(ctx, "extensions.sixel", {
          region: { ...SIXEL_REGION },
          ...SIXEL_BOUNDS,
        })
        if ("pass" in reported) return reported
        const geometry = reported.geometry
        if (!geometry) {
          const note =
            "extensions.sixel: this pixel arm reported no cell-to-pixel geometry, so the tile cannot be sized"
          return {
            pass: false,
            note,
            observation: {
              outcome: "inconclusive",
              reason: "insufficient-evidence",
              assertionType: "query_reply",
              note,
            },
          }
        }
        const read = collectorRegionRead(ctx)
        if (!read) throw new Error("extensions.sixel: a pixel arm reached the region oracle without an owned capture")
        try {
          const decided = await captureRegionReadbackDecision(
            ctx,
            "extensions.sixel",
            { ...sixelReadback(geometry), pixelGeometry: geometry, geometrySource: reported.source },
            read,
          )
          if (decided) return decided
          const note =
            "extensions.sixel: the region oracle answered nothing for this arm, so the rendering was not compared"
          return {
            pass: false,
            note,
            observation: {
              outcome: "inconclusive",
              reason: "insufficient-evidence",
              assertionType: "query_reply",
              note,
            },
          }
        } finally {
          // SGR 0 alone does not remove a drawn sixel graphic; clear the owned disposable surface.
          ctx.write("\x1b[0m\x1b[2J\x1b[H")
        }
      },
    ),
    termNeedsGeometry: true,
  },

  // OSC 8 — hyperlinks
  {
    ...probe(
      "extensions.osc8",
      (ctx) => {
        const uri = "https://example.com/osc8-proof"
        ctx.feed(`\x1b[1;1H\x1b[2KA\x1b]8;;${uri}\x07LINK\x1b]8;;\x07Z`)
        const cells = Array.from({ length: 6 }, (_, col) => {
          const { hyperlink: _unreported, ...cell } = ctx.getCell(0, col)
          const hyperlink = readHyperlinkMetadata(
            ctx.capabilities.extensions.has("hyperlinks"),
            ctx.getHyperlinkAt,
            0,
            col,
            "OSC 8 context",
          )
          return { ...cell, ...(hyperlink !== undefined && { hyperlink }) }
        })
        const expectedChars = "ALINKZ"
        const links = cells.map((cell) =>
          cell.hyperlink !== undefined ? { reported: true, uri: cell.hyperlink } : { reported: false },
        )
        const response = JSON.stringify({ chars: cells.map((cell) => cell.char), links })
        const expected = JSON.stringify({
          chars: [...expectedChars],
          links: [null, uri, uri, uri, uri, null].map((link) => ({ reported: true, uri: link })),
        })
        const reported = links.every((link) => link.reported)
        const charsMatch = cells.every((cell, index) => cell.char === expectedChars[index])
        if (charsMatch && !reported) {
          const identity = ctx.runtimeIdentity
          const audit = absentOscAudit(identity, 8)
          if (audit) {
            return parserStateResult(
              null,
              "extensions.osc8: the pinned engine handles OSC 8 and associates the exact URI with LINK cells only",
              { chars: cells.map((cell) => cell.char), links },
              undefined,
              `${audit.sourceCitation}; no OSC 8 target writer; independent source review required`,
            )
          }
          const adapter = identity
            ? `Engine ${identity.engineVersion}, adapter ${identity.adapterVersion}`
            : "Adapter (runtime identity unavailable)"
          const note = `${adapter} exposes no OSC 8 URI observer (getHyperlinkAt); link metadata unobservable`
          return reviewResult(HEADLESS_OBSERVABLE_REVIEW, `Headless observable review required: ${note}`, note, {
            chars: cells.map((cell) => cell.char),
            links,
          })
        }
        if (!charsMatch) {
          return {
            pass: false,
            response,
            observation: {
              outcome: "inconclusive",
              reason: "insufficient-evidence",
              assertionType: "buffer_state",
              note: !reported ? "Backend did not report OSC 8 link metadata" : "Linked text was not observable",
            },
          }
        }
        const observed = response
        const pass = observed === expected
        return {
          pass,
          response,
          observation: {
            outcome: pass ? "supported" : "unsupported",
            assertionType: "buffer_state",
            ...(!pass && { note: "OSC 8 cell URI differs from the exact requested link or leaked past close" }),
          },
          assertions: [
            { assertionType: "buffer_state" as const, kind: pass ? "positive" : "negative", expected, observed },
          ],
        }
      },
      async (ctx) => {
        if (!Number.isSafeInteger(ctx.rows) || !Number.isSafeInteger(ctx.cols) || ctx.rows < 1 || ctx.cols < 7) {
          return {
            pass: false,
            tests: [
              {
                id: "criterion",
                status: "test-todo",
                reason: `OSC 8 fixture needs at least 1x7, measured ${ctx.rows}x${ctx.cols}`,
              },
            ],
          }
        }
        ctx.write("\x1b[1;1H\x1b[2K")
        ctx.write("A\x1b]8;;https://example.com/osc8-proof\x07LINK\x1b]8;;\x07Z")
        const pos = await ctx.queryCursorPosition()
        if (!pos) {
          return {
            pass: false,
            note: "No cursor response",
            tests: [
              {
                id: "criterion",
                status: "test-todo",
                reason: ctx.captureGeometryRefusal
                  ? `Pixel capture unavailable: ${ctx.captureGeometryRefusal}`
                  : "No cursor response",
              },
            ],
          }
        }
        return {
          pass: false,
          response: `${pos.row};${pos.col}`,
          tests: [
            {
              id: "criterion",
              status: "test-todo",
              reason: `Cursor movement cannot verify OSC 8 link metadata or click behavior${ctx.captureGeometryRefusal ? `; Pixel capture unavailable: ${ctx.captureGeometryRefusal}` : ""}`,
            },
          ],
        }
      },
      null,
    ),
    termNeedsGeometry: true,

    libAssertionType: "buffer_state",
  },

  {
    ...probe("extensions.reflow", mainScreenReflow, () => {
      const note = "No controlled resize and cell-content readback to measure reflow"
      return Promise.resolve<ProbeCallbackResult>({
        pass: false,
        note,
        tests: [{ id: "criterion", status: "test-todo", reason: note }],
      })
    }),
    libAssertionType: "buffer_state",
  },

  // Semantic prompts (OSC 133)
  {
    ...probe(
      "extensions.semantic-prompts",
      (ctx) => {
        if (absentOscAudit(ctx.runtimeIdentity, 133)) {
          return sourceAbsentOsc("extensions.semantic-prompts", 133, "\x1b]133;A\x07", "shell prompt integration")(ctx)
        }
        if (ctx.capabilities.extensions.has("semantic-marks")) {
          return promptMarkResult(ctx, "\x1b]133;A\x07", "OSC 133 prompt-start mark registration", {
            probeId: "extensions.semantic-prompts",
            selector: 133,
            markType: "prompt",
          })
        }
        const note = "Declared semantic-prompt capability does not establish shell prompt integration"
        return reviewResult(HEADLESS_OBSERVABLE_REVIEW, `Headless observable review required: ${note}`, note, {
          declared: ctx.capabilities.semanticPrompts === true,
        })
      },
      () => {
        const note = "No shell prompt integration metadata or behavior readback for OSC 133"
        return Promise.resolve<ProbeCallbackResult>({
          pass: false,
          note,
          tests: [{ id: "criterion", status: "test-todo", reason: note }],
        })
      },
    ),
    libAssertionType: "buffer_state",
  },

  // OSC 2 — window title
  {
    ...probe(
      "extensions.osc2-title",
      (ctx) => {
        const before = ctx.getTitle()
        const requested = before === "Test Title" ? "Test Title 2" : "Test Title"
        try {
          ctx.feed(`\x1b]2;${requested}\x07`)
          const title = ctx.getTitle()
          return parserStateResult(title === requested, "OSC 2 sets the exact requested window title", {
            before,
            requested,
            title,
          })
        } finally {
          ctx.feed(`\x1b]2;${before}\x07`)
        }
      },
      () => Promise.resolve(unmeasuredStateEffect("OSC 2 window title")),
    ),
    libAssertionType: "buffer_state",
  },

  // OSC 0 — icon name and title
  {
    ...probe(
      "extensions.osc0-icon-title",
      (ctx) => {
        if (auditedXtermState(ctx)) {
          const before = { icon: ctx.getIconLabel(), title: ctx.getTitle() }
          const controls = {
            icon: before.icon === "osc0-icon-control" ? "osc0-icon-control-2" : "osc0-icon-control",
            title: before.title === "osc0-title-control" ? "osc0-title-control-2" : "osc0-title-control",
          }
          try {
            ctx.feed(`\x1b]1;${controls.icon}\x07`)
            ctx.feed(`\x1b]2;${controls.title}\x07`)
            const controlled = { icon: ctx.getIconLabel(), title: ctx.getTitle() }
            if (controlled.icon !== controls.icon || controlled.title !== controls.title) {
              return {
                response: JSON.stringify({ before, controls, controlled }),
                ...replyFailure("OSC 0 independent icon/title controls were not both read back"),
              }
            }
            ctx.feed(`\x1b]0;${OSC0_PAYLOAD}\x07`)
            const after = { icon: ctx.getIconLabel(), title: ctx.getTitle() }
            return parserStateResult(
              after.icon === OSC0_PAYLOAD && after.title === OSC0_PAYLOAD,
              "OSC 0 changes both independently controlled icon and title labels to its exact payload",
              { before, controls, controlled, requested: OSC0_PAYLOAD, after },
            )
          } finally {
            try {
              ctx.feed(`\x1b]1;${before.icon}\x07`)
            } finally {
              ctx.feed(`\x1b]2;${before.title}\x07`)
            }
          }
        }
        ctx.feed(`\x1b]0;${OSC0_PAYLOAD}\x07`)
        const iconOutcome = ctx.queryWithSentinelOutcome?.(OSC0_ICON_QUERY, OSC0_ICON_REPLY)
        const titleOutcome = ctx.queryWithSentinelOutcome?.(OSC0_TITLE_QUERY, OSC0_TITLE_REPLY)
        const icon = iconOutcome ? iconOutcome.raw : ctx.feedCapture(OSC0_ICON_QUERY)
        const title = titleOutcome ? titleOutcome.raw : ctx.feedCapture(OSC0_TITLE_QUERY)
        const iconLabel = iconOutcome ? (iconOutcome.match?.[1] ?? null) : (OSC0_ICON_REPLY.exec(icon)?.[1] ?? null)
        const windowTitle = titleOutcome
          ? (titleOutcome.match?.[1] ?? null)
          : (OSC0_TITLE_REPLY.exec(title)?.[1] ?? null)
        return osc0IconTitleResult(
          iconLabel,
          windowTitle,
          { icon, title },
          {
            icon: iconOutcome ? iconOutcome.reason : "feedCapture boundary",
            title: titleOutcome ? titleOutcome.reason : "feedCapture boundary",
          },
        )
      },
      async (ctx) => {
        ctx.write(`\x1b]0;${OSC0_PAYLOAD}\x07`)
        const icon = await ctx.queryWithSentinelOutcome(OSC0_ICON_QUERY, OSC0_ICON_REPLY)
        const title = await ctx.queryWithSentinelOutcome(OSC0_TITLE_QUERY, OSC0_TITLE_REPLY)
        return osc0IconTitleResult(
          icon.match?.[1] ?? null,
          title.match?.[1] ?? null,
          { icon: icon.raw, title: title.raw },
          { icon: icon.reason, title: title.reason },
        )
      },
      "query_reply",
    ),
    libAssertionType: { when: auditedXtermState, then: ["buffer_state"], otherwise: ["query_reply"] },
  },

  // OSC 52 — clipboard
  {
    ...probe(
      "extensions.osc52-clipboard",
      headlessClipboardRoundtrip,
      (ctx) => liveClipboardProbe(ctx, "roundtrip"),
      "query_reply",
    ),
    libAssertionType: {
      when: auditedClipboardWriteSource,
      then: ["query_reply", "buffer_state"],
      otherwise: ["query_reply"],
    },
    libHostRecipes: [{ recipe: "clipboard-load", query: "\x1b]52;c;?\x07", missing: ["clipboard-read-permission"] }],
  },

  // OSC 52 write — set clipboard (most terminals support this)
  {
    ...probe("extensions.osc52-write", headlessOsc52Write, (ctx) => liveClipboardProbe(ctx, "write"), "query_reply"),
    libAssertionType: {
      when: auditedClipboardWriteSource,
      then: ["query_reply", "buffer_state"],
      otherwise: ["query_reply"],
    },
    libHostRecipes: [{ recipe: "clipboard-load", query: "\x1b]52;c;?\x07", missing: ["clipboard-read-permission"] }],
  },

  // OSC 52 read — query clipboard back (fewer terminals support this)
  {
    ...probe("extensions.osc52-read", headlessClipboardRead, (ctx) => liveClipboardProbe(ctx, "read"), "query_reply"),
    libAssertionType: "query_reply",
    libHostRecipes: [{ recipe: "clipboard-load", query: "\x1b]52;c;?\x07", missing: ["clipboard-read-permission"] }],
  },

  probe(
    "extensions.clipboard-paste",
    () =>
      osInputReviewResult(
        "OS-level XTEST paste injection",
        { input: false },
        "Lib arm: the engine consumes bytes and has no input surface; host input encoding is measured in the terminal arm.",
      ),
    clipboardPaste,
    "input_bytes",
  ),

  // OSC 10 — foreground color query
  oscColorQueryProbe("extensions.osc10-fg-color", 10),

  // OSC 11 — background color query
  oscColorQueryProbe("extensions.osc11-bg-color", 11),

  // OSC 7 — current working directory
  {
    ...probe(
      "extensions.osc7-cwd",
      (ctx) => {
        if (!ctx.getCwd) {
          if (absentOscAudit(ctx.runtimeIdentity, 7)) {
            return sourceAbsentOsc(
              "extensions.osc7-cwd",
              7,
              "\x1b]7;file://localhost/terminfo-cwd-A\x07",
              "working-directory",
            )(ctx)
          }
          const note = "Declared OSC 7 capability does not establish working-directory metadata delivery"
          return reviewResult(HEADLESS_OBSERVABLE_REVIEW, `Headless observable review required: ${note}`, note, {
            declared: ctx.capabilities.extensions.has("osc7"),
          })
        }
        const before = ctx.getCwd()
        const firstUri = "file://localhost/terminfo-cwd-A"
        const secondUri = "file://localhost/terminfo-cwd-B"
        const writes = [`\x1b]7;${firstUri}\x07`, `\x1b]7;${secondUri}\x07`, `\x1b]7;${before ?? ""}\x07`] as const
        let first: string | null
        let second: string | null
        try {
          ctx.feed(writes[0])
          first = ctx.getCwd()
          ctx.feed(writes[1])
          second = ctx.getCwd()
        } finally {
          ctx.feed(writes[2])
        }
        const restored = ctx.getCwd()
        return parserStateResult(
          first === firstUri && second === secondUri && restored === before,
          `OSC 7 stores successive exact URIs ${firstUri}, ${secondUri} and restores the original URI`,
          { before, first, second, restored, writes },
        )
      },
      () => {
        const note = "No working-directory metadata readback for OSC 7"
        return Promise.resolve<ProbeCallbackResult>({
          pass: false,
          note,
          tests: [{ id: "criterion", status: "test-todo", reason: note }],
        })
      },
    ),
    libAssertionType: "buffer_state",
  },

  // OSC 633 — VS Code shell integration
  {
    ...probe(
      "extensions.osc-633-vscode",
      (ctx) => {
        if (absentOscAudit(ctx.runtimeIdentity, 633)) {
          return sourceAbsentOsc("extensions.osc-633-vscode", 633, "\x1b]633;A\x07", "VS Code shell integration")(ctx)
        }
        if (ctx.capabilities.extensions.has("semantic-marks")) {
          return promptMarkResult(ctx, "\x1b]633;A\x07", "OSC 633 prompt-start mark registration", {
            probeId: "extensions.osc-633-vscode",
            selector: 633,
            markType: "prompt",
          })
        }
        const note = "Declared semantic-prompt capability does not establish VS Code OSC 633 shell integration"
        return reviewResult(HEADLESS_OBSERVABLE_REVIEW, `Headless observable review required: ${note}`, note, {
          declared: ctx.capabilities.semanticPrompts === true,
        })
      },
      () => {
        const note = "No VS Code shell integration metadata or behavior readback for OSC 633"
        return Promise.resolve<ProbeCallbackResult>({
          pass: false,
          note,
          tests: [{ id: "criterion", status: "test-todo", reason: note }],
        })
      },
    ),
    libAssertionType: "buffer_state",
  },

  // OSC 133 sub-commands — semantic prompt markers (FinalTerm)
  // Each probe sends the marker followed by "X" and verifies "X" landed at cell (0,0),
  // proving the OSC sequence was silently consumed (not printed literally).

  // OSC 133;A — prompt start (FTCS_PROMPT)
  {
    ...probe(
      "extensions.osc133-a",
      (ctx) =>
        promptMarkResult(ctx, "\x1b]133;A\x07", "OSC 133;A prompt-start mark registration", {
          probeId: "extensions.osc133-a",
          selector: 133,
          markType: "prompt",
        }),
      (ctx) => promptMarkAppResult(ctx, "\x1b]133;A\x07", "OSC 133;A prompt-start mark registration"),
    ),
    libAssertionType: "buffer_state",
  },

  // OSC 133;B — command start (FTCS_COMMAND_START)
  {
    ...probe(
      "extensions.osc133-b",
      (ctx) =>
        promptMarkResult(ctx, "\x1b]133;B\x07", "OSC 133;B command-start mark registration", {
          probeId: "extensions.osc133-b",
          selector: 133,
          markType: "command",
        }),
      (ctx) => promptMarkAppResult(ctx, "\x1b]133;B\x07", "OSC 133;B command-start mark registration"),
    ),
    libAssertionType: "buffer_state",
  },

  // OSC 133;C — command executed (FTCS_COMMAND_EXECUTED)
  {
    ...probe(
      "extensions.osc133-c",
      (ctx) =>
        promptMarkResult(ctx, "\x1b]133;C\x07", "OSC 133;C command-executed mark registration", {
          probeId: "extensions.osc133-c",
          selector: 133,
          markType: "output",
        }),
      (ctx) => promptMarkAppResult(ctx, "\x1b]133;C\x07", "OSC 133;C command-executed mark registration"),
    ),
    libAssertionType: "buffer_state",
  },

  // OSC 133;D — command finished with exit code (FTCS_COMMAND_FINISHED)
  {
    ...probe(
      "extensions.osc133-d",
      (ctx) =>
        promptMarkResult(ctx, "\x1b]133;D;0\x07", "OSC 133;D command-finished mark registration", {
          probeId: "extensions.osc133-d",
          selector: "133;D",
        }),
      (ctx) => promptMarkAppResult(ctx, "\x1b]133;D;0\x07", "OSC 133;D command-finished mark registration"),
    ),
    libAssertionType: "buffer_state",
  },

  // OSC 133;P — properties (Cwd, CmdLine, etc.)
  {
    ...probe(
      "extensions.osc133-p",
      (ctx) =>
        promptMarkResult(ctx, "\x1b]133;P;Cwd=/tmp\x07", "OSC 133;P properties mark registration", {
          probeId: "extensions.osc133-p",
          selector: 133,
        }),
      (ctx) => promptMarkAppResult(ctx, "\x1b]133;P;Cwd=/tmp\x07", "OSC 133;P properties mark registration"),
    ),
    libAssertionType: "buffer_state",
  },

  // OSC 633 sub-commands — VS Code shell integration markers
  // VS Code's parallel namespace to OSC 133, with VS Code-specific extensions (E, P).

  // OSC 633;A — prompt start (mirrors 133;A)
  {
    ...probe(
      "extensions.osc633-a",
      (ctx) =>
        promptMarkResult(ctx, "\x1b]633;A\x07", "OSC 633;A prompt-start mark registration", {
          probeId: "extensions.osc633-a",
          selector: 633,
          markType: "prompt",
        }),
      (ctx) => promptMarkAppResult(ctx, "\x1b]633;A\x07", "OSC 633;A prompt-start mark registration"),
    ),
    libAssertionType: "buffer_state",
  },

  // OSC 633;B — prompt end (mirrors 133;B)
  {
    ...probe(
      "extensions.osc633-b",
      (ctx) =>
        promptMarkResult(ctx, "\x1b]633;B\x07", "OSC 633;B prompt-end mark registration", {
          probeId: "extensions.osc633-b",
          selector: 633,
          markType: "command",
        }),
      (ctx) => promptMarkAppResult(ctx, "\x1b]633;B\x07", "OSC 633;B prompt-end mark registration"),
    ),
    libAssertionType: "buffer_state",
  },

  // OSC 633;C — pre-execution (mirrors 133;C)
  {
    ...probe(
      "extensions.osc633-c",
      (ctx) =>
        promptMarkResult(ctx, "\x1b]633;C\x07", "OSC 633;C pre-execution mark registration", {
          probeId: "extensions.osc633-c",
          selector: 633,
          markType: "output",
        }),
      (ctx) => promptMarkAppResult(ctx, "\x1b]633;C\x07", "OSC 633;C pre-execution mark registration"),
    ),
    libAssertionType: "buffer_state",
  },

  // OSC 633;D — command finished with exit code (mirrors 133;D)
  {
    ...probe(
      "extensions.osc633-d",
      (ctx) =>
        promptMarkResult(ctx, "\x1b]633;D;0\x07", "OSC 633;D command-finished mark registration", {
          probeId: "extensions.osc633-d",
          selector: 633,
        }),
      (ctx) => promptMarkAppResult(ctx, "\x1b]633;D;0\x07", "OSC 633;D command-finished mark registration"),
    ),
    libAssertionType: "buffer_state",
  },

  // OSC 633;E — set commandline with verification nonce (unique to OSC 633)
  {
    ...probe(
      "extensions.osc633-e",
      (ctx) =>
        promptMarkResult(ctx, "\x1b]633;E;ls -la;nonce123\x07", "OSC 633;E commandline-with-nonce mark registration", {
          probeId: "extensions.osc633-e",
          selector: 633,
        }),
      (ctx) =>
        promptMarkAppResult(
          ctx,
          "\x1b]633;E;ls -la;nonce123\x07",
          "OSC 633;E commandline-with-nonce mark registration",
        ),
    ),
    libAssertionType: "buffer_state",
  },

  // OSC 633;P — VS Code-specific properties (Cwd, IsWindows, git status)
  {
    ...probe(
      "extensions.osc633-p",
      (ctx) =>
        promptMarkResult(ctx, "\x1b]633;P;Cwd=/tmp\x07", "OSC 633;P properties mark registration", {
          probeId: "extensions.osc633-p",
          selector: 633,
        }),
      (ctx) => promptMarkAppResult(ctx, "\x1b]633;P;Cwd=/tmp\x07", "OSC 633;P properties mark registration"),
    ),
    libAssertionType: "buffer_state",
  },

  // OSC 9 — desktop notifications
  {
    ...probe(
      "extensions.notifications",
      (ctx) => {
        if (!ctx.getNotifications) {
          const audit = absentOscAudit(ctx.runtimeIdentity, 9)
          // Progress-only OSC 9 evidence cannot decide notification absence, in any cohort.
          if (audit && !("osc9ProgressOnly" in audit && audit.osc9ProgressOnly)) {
            return sourceAbsentOsc(
              "extensions.notifications",
              9,
              "\x1b]9;terminfo-notification-A\x07",
              "notification",
            )(ctx)
          }
          const note = "Declared OSC 9 capability does not establish desktop notification delivery"
          return reviewResult(HEADLESS_OBSERVABLE_REVIEW, `Headless observable review required: ${note}`, note, {
            declared: ctx.capabilities.extensions.has("osc9"),
          })
        }
        const before = [...ctx.getNotifications()]
        const firstMessage = "terminfo-notification-A"
        const secondMessage = "terminfo-notification-B"
        const writes = [`\x1b]9;${firstMessage}\x07`, `\x1b]9;${secondMessage}\x07`] as const
        ctx.feed(writes[0])
        const first = [...ctx.getNotifications()]
        ctx.feed(writes[1])
        const second = [...ctx.getNotifications()]
        return parserStateResult(
          JSON.stringify(first) === JSON.stringify([...before, firstMessage]) &&
            JSON.stringify(second) === JSON.stringify([...before, firstMessage, secondMessage]),
          "OSC 9 appends each exact notification payload in order and preserves earlier payloads",
          { before, first, second, writes },
          "Measures the parser notification sink, not OS notification delivery or OSC 9;4 progress",
        )
      },
      () => {
        const note = "No desktop notification delivery readback for OSC 9"
        return Promise.resolve<ProbeCallbackResult>({
          pass: false,
          note,
          tests: [{ id: "criterion", status: "test-todo", reason: note }],
        })
      },
    ),
    libAssertionType: "buffer_state",
  },

  // OSC 1337 — iTerm2 inline images
  {
    ...probe(
      "extensions.iterm2-images",
      (ctx) => {
        // An engine whose audited source drops OSC 1337 takes the source-negative review, so its cell can be
        // decided Unsupported from source; every other engine keeps the observable review (#32225).
        if (absentOscAudit(ctx.runtimeIdentity, 1337)) {
          return sourceAbsentOsc("extensions.iterm2-images", 1337, ITERM2_INLINE_IMAGE, "inline image")(ctx)
        }
        if (replyPathAuditFor(ctx, "extensions.iterm2-images")) {
          ctx.feedCapture(ITERM2_INLINE_IMAGE)
        }
        const note = "Declared iTerm2 image capability does not establish rendered image pixels"
        return reviewResult(HEADLESS_OBSERVABLE_REVIEW, `Headless observable review required: ${note}`, note, {
          declared: ctx.capabilities.extensions.has("iterm2Images"),
        })
      },
      async (ctx) => {
        if (ctx.capture) {
          const refusal = sgrCaptureTooSmall(ctx, "extensions.iterm2-images")
          if (refusal) return refusal
          try {
            return await sgrCaptureFrames(
              ctx,
              "\x1b[0m\x1b[2J\x1b[H",
              "\x1b[0m\x1b[2J\x1b[3;3H\x1b]1337;File=inline=1;width=8px;height=8px:" + ITERM2_RED_PNG + "\x07\x1b[1;1H",
              "extensions.iterm2-images",
              { startRow: 3, startCol: 3, image: "8x8 solid red PNG" },
              "A red inline image appears only if the OSC 1337 payload was decoded; compare against the blank control",
            )
          } finally {
            // SGR 0 alone does not remove a drawn inline image; clear the owned disposable surface.
            ctx.write("\x1b[0m\x1b[2J\x1b[H")
          }
        }
        const note = "No pixel readback for iTerm2 inline image rendering"
        return {
          pass: false,
          note,
          tests: [{ id: "criterion", status: "test-todo", reason: note }],
        }
      },
    ),
    termNeedsGeometry: true,
  },

  // OSC 1337 ReportCellSize — query cell dimensions in points, plus optional pixels-per-point scale
  oscSimpleQueryProbe(
    "extensions.osc1337-cellsize",
    "\x1b]1337;ReportCellSize\x07",
    // iTerm2 documents both forms: height;width, and the newer height;width;scale (pixels per point). WezTerm sends the
    // newer one (27915: `ReportCellSize=16.5;7.5;1.3`).
    /\x1b\]1337;ReportCellSize=[1-9][0-9]*(?:\.[0-9]+)?;[1-9][0-9]*(?:\.[0-9]+)?(?:;[0-9]+(?:\.[0-9]+)?)?(?:\x07|\x1b\\)/,
    "Complete OSC 1337 ReportCellSize reply with two positive dimensions and an optional scale",
  ),

  // OSC 1337 Capabilities — query terminal capabilities
  oscSimpleQueryProbe(
    "extensions.osc1337-capabilities",
    "\x1b]1337;Capabilities\x07",
    /\x1b\]1337;Capabilities=[^\x07\x1b]*(?:\x07|\x1b\\)/,
    "Complete OSC 1337 Capabilities reply",
  ),

  // OSC 9;4 — progress bar (ConEmu protocol, adopted by Ghostty, iTerm2, Windows Terminal, etc.)
  probe(
    "extensions.osc9-progress",
    // Feed the ConEmu progress form; consumption alone does not measure progress display.
    sourceAbsentOsc("extensions.osc9-progress", 9, "\x1b]9;4;1;50\x07", "progress"),
    () => Promise.resolve(unmeasuredStateEffect("OSC 9;4 progress display")),
    null,
  ),

  // OSC 66 — text sizing protocol (Kitty, sets text scale/cell width)
  {
    ...probe(
      "extensions.osc66-text-sizing",
      (ctx) => {
        ctx.feed("\x1b[1;1H\x1b[2K\r")
        const before = { ...ctx.getCursor() }
        if (before.x !== 0 || before.y !== 0) {
          const note = `OSC 66 baseline cursor did not reach home: ${before.y};${before.x}`
          return {
            pass: false,
            response: JSON.stringify({ row: before.y, col: before.x }),
            note,
            observation: {
              outcome: "inconclusive",
              reason: "insufficient-evidence",
              assertionType: "buffer_state",
              note,
            },
          }
        }
        ctx.feed("\x1b]66;w=2; \x07")
        const width = { ...ctx.getCursor() }
        ctx.feed("\x1b]66;s=2; \x07")
        const scale = { ...ctx.getCursor() }
        return textSizingResult(
          { row: before.y, col: before.x },
          { row: width.y, col: width.x },
          { row: scale.y, col: scale.x },
          "buffer_state",
        )
      },
      async (ctx) => {
        if (!Number.isSafeInteger(ctx.rows) || !Number.isSafeInteger(ctx.cols) || ctx.rows < 1 || ctx.cols < 5) {
          return {
            pass: false,
            tests: [
              {
                id: "criterion",
                status: "test-todo",
                reason: `OSC 66 fixture needs at least 1x5, measured ${ctx.rows}x${ctx.cols}`,
              },
            ],
          }
        }
        // The protocol defines detection by cursor movement, not an OSC query.
        ctx.write("\x1b[1;1H\x1b[2K\r")
        const before = await ctx.queryCursorPosition()
        if (!before) {
          return replyFailure(
            "no parsable cursor position reply; the public projection returned null and retained no bytes",
          )
        }
        if (before.row !== 1 || before.col !== 1) {
          const note = `OSC 66 baseline cursor did not reach home: ${before.row};${before.col}`
          return {
            pass: false,
            response: JSON.stringify(before),
            note,
            observation: {
              outcome: "inconclusive",
              reason: "insufficient-evidence",
              assertionType: "query_reply",
              note,
            },
          }
        }
        ctx.write("\x1b]66;w=2; \x07")
        const width = await ctx.queryCursorPosition()
        ctx.write("\x1b]66;s=2; \x07")
        const scale = await ctx.queryCursorPosition()
        if (!width || !scale) {
          return replyFailure(
            "no parsable cursor position reply; the public projection returned null and retained no bytes",
          )
        }
        return textSizingResult(before, width, scale, "query_reply")
      },
      "query_reply",
    ),
    termNeedsGeometry: true,

    libAssertionType: "buffer_state",
  },

  // OSC 5522 — advanced clipboard (Kitty protocol, MIME-aware paste events)
  {
    ...queryOnly(
      probe(
        "extensions.osc5522-clipboard",
        (ctx) => {
          const pattern = decrpmReplyPattern(5522)
          if (ctx.queryWithSentinelOutcome) {
            const reply = ctx.queryWithSentinelOutcome("\x1b[?5522$p", pattern)
            let response = reply.raw
            if (sentinelSilenceResult(reply, "OSC5522 detection reply") !== null) {
              // Current library DECRQM siblings in device.ts/modes.ts; one silent mode is insufficient.
              const controls = []
              let allSilent = true
              for (const mode of [7, 2004, 1, 1000, 1004, 5, 2026, 1006, 1003, 1007, 1005, 3, 4, 2031]) {
                const control = ctx.queryWithSentinelOutcome(`\x1b[?${mode}$p`, decrpmReplyPattern(mode))
                controls.push({ mode, raw: control.raw })
                if (sentinelSilenceResult(control, "DECRPM prerequisite reply") === null) {
                  allSilent = false
                  break
                }
              }
              response = JSON.stringify({ detection: reply.raw, decrpmSiblings: controls })
              if (allSilent) {
                const engine = auditedOscEngine(ctx.runtimeIdentity)?.[0]
                const identity = ctx.runtimeIdentity
                const da1 = engine === "vt100" ? "\x1b[?1;2c" : "\x1b[?62;1;2;6;7;8;9c"
                if (
                  (engine === "vt100" || engine === "vt220") &&
                  identity?.kind === "js" &&
                  identity.integrity.kind === "source" &&
                  identity.integrity.revision === "9e99e4d23cdc606fca258b1863aa2be7ae79eed3" &&
                  identity.termlessRevision === "25089207e11420cf7a588987c1dc2683a45e8372" &&
                  reply.raw === da1 &&
                  controls.every((control) => control.raw === da1)
                ) {
                  const rejection = engine === "vt100" ? "360-364" : "444-447"
                  const sourceCitation = `vterm9e99e4d23cdc606fca258b1863aa2be7ae79eed3 packages/${engine}/src/screen.ts:${rejection} rejects DECRQM; Termless25089207 packages/${engine}/src/backend.ts forwards engine responses without a mode-report substitute`
                  return parserStateResult(
                    null,
                    "OSC5522 protocol detection is recognized",
                    { detection: reply.raw, decrpmSiblings: controls, rejection: "parser", sourceCitation },
                    undefined,
                    `${sourceCitation}; independent source review required`,
                    "query_reply",
                  )
                }
                const reason =
                  "OSC5522 detection prerequisite unmet: no complete DECRPM reply from same-run sibling queries; protocol recognition cannot be observed."
                return {
                  pass: false,
                  response,
                  note: reason,
                  tests: [{ id: "criterion", status: "test-todo", reason }],
                }
              }
            }
            return {
              ...osc5522DetectionResult(reply.raw, replyFrame(reply) !== null, reply.sentinel !== undefined),
              response,
            }
          }
          const raw = ctx.feedCapture("\x1b[?5522$p")
          return { ...osc5522DetectionResult(raw, true), response: raw }
        },
        async (ctx) => {
          const reply = await ctx.queryWithSentinelOutcome("\x1b[?5522$p", decrpmReplyPattern(5522))
          return osc5522DetectionResult(reply.raw, replyFrame(reply) !== null, reply.sentinel !== undefined)
        },
        "query_reply",
      ),
    ),
    libAssertionType: "query_reply",
  },

  // OSC 1 — icon name
  {
    ...probe(
      "extensions.osc1-icon",
      (ctx) => {
        if (typeof ctx.getIconLabel !== "function") {
          const before = ctx.getTitle()
          ctx.feed("\x1b]1;test-icon\x07")
          const after = ctx.getTitle()
          const audit = absentOscAudit(ctx.runtimeIdentity, 1)
          if (audit) {
            const reason =
              "reviewReasons" in audit ? audit.reviewReasons.find((entry) => entry.code === 1)?.reason : undefined
            return parserStateResult(
              null,
              "OSC 1 sets the icon name independently of the window title",
              { before, after },
              undefined,
              `${audit.sourceCitation}${reason ? `; ${reason}` : ""}; independent source review required`,
            )
          }
          return notTestedResult("icon-name state", { before, after })
        }
        const before = { icon: ctx.getIconLabel(), title: ctx.getTitle() }
        const requested = before.icon === "test-icon" ? "test-icon-2" : "test-icon"
        const control =
          before.title === "terminfo-title-control" ? "terminfo-title-control-2" : "terminfo-title-control"
        try {
          ctx.feed(`\x1b]2;${control}\x07`)
          const title = ctx.getTitle()
          if (title !== control) {
            return {
              pass: false,
              response: JSON.stringify({ before, control, title }),
              tests: [
                {
                  id: "criterion",
                  status: "test-failure",
                  reason: "OSC 2 window-title control was not read back, so OSC 1 title independence cannot be decided",
                },
              ],
            }
          }
          ctx.feed(`\x1b]1;${requested}\x07`)
          const after = { icon: ctx.getIconLabel(), title: ctx.getTitle() }
          return parserStateResult(
            after.icon === requested && after.title === control,
            "OSC 1 sets the icon name without changing the independently verified window title",
            { before, requested, control, after },
          )
        } finally {
          ctx.feed(`\x1b]1;${before.icon}\x07`)
          ctx.feed(`\x1b]2;${before.title}\x07`)
        }
      },
      () => {
        const note = "No icon-name readback for OSC 1"
        return Promise.resolve<ProbeCallbackResult>({
          pass: false,
          note,
          tests: [{ id: "criterion", status: "test-todo", reason: note }],
        })
      },
    ),
    libAssertionType: "buffer_state",
  },

  // OSC 4 — color palette query for index 0.
  oscColorQueryProbe("extensions.osc4-palette", 4, 0),

  // OSC 5 — special color query for index 0.
  oscSimpleQueryProbe(
    "extensions.osc5-special-color",
    "\x1b]5;0;?\x07",
    /\x1b\]5;0;rgb:[0-9a-f]{1,4}\/[0-9a-f]{1,4}\/[0-9a-f]{1,4}(?:\x07|\x1b\\)/i,
    "Complete OSC 5 index-0 color reply",
  ),

  // OSC 12 — cursor color query
  oscColorQueryProbe("extensions.osc12-cursor-color", 12),

  // OSC 104 — reset color palette
  resetProbe("extensions.osc104-reset-palette", 4, 104, 0),

  // OSC 110 — reset foreground color
  resetProbe("extensions.osc110-reset-fg", 10, 110),

  // OSC 111 — reset background color
  resetProbe("extensions.osc111-reset-bg", 11, 111),

  // OSC 112 — reset cursor color
  resetProbe("extensions.osc112-reset-cursor", 12, 112),

  // OSC 117 — reset highlight background
  highlightResetProbe("extensions.osc117-reset-highlight-bg", 17, 117),

  // OSC 119 — reset highlight foreground
  highlightResetProbe("extensions.osc119-reset-highlight-fg", 19, 119),

  // OSC 17 — highlight background color query
  oscColorQueryProbe("extensions.osc17-highlight-bg", 17),

  // OSC 19 — highlight foreground color query
  oscColorQueryProbe("extensions.osc19-highlight-fg", 19),

  // OSC 22 — pointer shape
  // Kitty defines shape/status queries, but this callback only tests CPR.
  // Visible pointer appearance also needs observation outside the cell grid.
  probe(
    "extensions.osc22-pointer",
    sourceAbsentOsc("extensions.osc22-pointer", 22, "\x1b]22;pointer\x07", "pointer"),
    async (ctx) => {
      ctx.write("\x1b[1;1H\x1b[2K")
      ctx.write("\x1b]22;pointer\x07")
      const pos = await ctx.queryCursorPosition()
      return unmeasuredCellResult(pos, "OSC 22 pointer shape")
    },
    null,
  ),

  // Query capabilities without displaying a notification or requiring desktop access.
  {
    ...queryOnly(
      probe(
        "extensions.osc99-kitty-notify",
        (ctx) => {
          const id = globalThis.crypto.randomUUID()
          const sequence = `\x1b]99;i=${id}:p=?;\x1b\\`
          const pattern = new RegExp(`\\x1b\\]99;i=${id}:p=\\?;([^\\x07\\x1b]*)(?:\\x07|\\x1b\\\\)`)
          if (ctx.queryWithSentinelOutcome) {
            return notificationQueryResult(ctx.queryWithSentinelOutcome(sequence, pattern), id)
          }
          const raw = ctx.feedCapture(sequence)
          return notificationQueryResult(rawQueryOutcome(raw, raw.match(pattern)), id, true)
        },
        async (ctx) => {
          const id = globalThis.crypto.randomUUID()
          const reply = await ctx.queryWithSentinelOutcome(
            `\x1b]99;i=${id}:p=?;\x1b\\`,
            new RegExp(`\\x1b\\]99;i=${id}:p=\\?;([^\\x07\\x1b]*)(?:\\x07|\\x1b\\\\)`),
          )
          return notificationQueryResult(reply, id)
        },
        "query_reply",
      ),
    ),
    libAssertionType: "query_reply",
  },

  // OSC 777 — rxvt-unicode notifications
  probe(
    "extensions.osc777-notify",
    sourceAbsentOsc("extensions.osc777-notify", 777, "\x1b]777;notify;test;body\x07", "notification"),
    async (ctx) => {
      ctx.write("\x1b[1;1H\x1b[2K")
      ctx.write("\x1b]777;notify;test;body\x07")
      const pos = await ctx.queryCursorPosition()
      return unmeasuredCellResult(pos, "OSC 777 notification delivery")
    },
    null,
  ),

  // OSC 666 — VTE termprop
  probe(
    "extensions.osc666-termprop",
    sourceAbsentOsc("extensions.osc666-termprop", 666, "\x1b]666;test-prop=value\x07", "terminal property"),
    async (ctx) => {
      ctx.write("\x1b[1;1H\x1b[2K")
      ctx.write("\x1b]666;test-prop=value\x07")
      const pos = await ctx.queryCursorPosition()
      return unmeasuredCellResult(pos, "OSC 666 terminal property")
    },
    null,
  ),

  // OSC 3008 — systemd context
  probe(
    "extensions.osc3008-context",
    sourceAbsentOsc("extensions.osc3008-context", 3008, "\x1b]3008;type=test\x07", "systemd context"),
    async (ctx) => {
      ctx.write("\x1b[1;1H\x1b[2K")
      ctx.write("\x1b]3008;type=test\x07")
      const pos = await ctx.queryCursorPosition()
      return unmeasuredCellResult(pos, "OSC 3008 systemd context")
    },
    null,
  ),

  // OSC 113 — reset pointer fg color
  resetProbe("extensions.osc113-reset-pointer-fg", 13, 113),

  // OSC 114 — reset pointer bg color
  resetProbe("extensions.osc114-reset-pointer-bg", 14, 114),

  // OSC 21 — require the actual foreground reply, never a subsequent CPR.
  {
    ...queryOnly(
      probe(
        "extensions.osc21-kitty-color",
        (ctx) =>
          ctx.queryWithSentinelOutcome
            ? kittyForegroundOutcomeResult(ctx.queryWithSentinelOutcome(OSC21_FOREGROUND_QUERY, OSC21_REPLY))
            : kittyForegroundResult(ctx.feedCapture(OSC21_FOREGROUND_QUERY)),
        async (ctx) =>
          kittyForegroundOutcomeResult(await ctx.queryWithSentinelOutcome(OSC21_FOREGROUND_QUERY, OSC21_REPLY)),
        "query_reply",
      ),
    ),
    libAssertionType: "query_reply",
  },

  // OSC 30001 — Kitty color stack push
  {
    ...probe(
      "extensions.osc30001-color-stack-push",
      colorStackProbe(colorPush),
      (ctx) => colorStackTermProbe(ctx, "push"),
      "query_reply",
    ),
    libHostRecipes: [{ recipe: "color-request", query: foregroundQuery, missing: ["foreground-rgb"] }],
  },

  // OSC 30101 — Kitty color stack pop
  {
    ...probe(
      "extensions.osc30101-color-stack-pop",
      colorStackProbe(colorPop),
      (ctx) => colorStackTermProbe(ctx, "pop"),
      "query_reply",
    ),
    libHostRecipes: [{ recipe: "color-request", query: foregroundQuery, missing: ["foreground-rgb"] }],
  },

  // OSC 176 — foot Wayland app-id
  probe(
    "extensions.osc176-app-id",
    sourceAbsentOsc("extensions.osc176-app-id", 176, "\x1b]176;terminfo-test\x07", "app-id"),
    async (ctx) => {
      ctx.write("\x1b[1;1H\x1b[2K")
      ctx.write("\x1b]176;terminfo-test\x07")
      const pos = await ctx.queryCursorPosition()
      return unmeasuredCellResult(pos, "OSC 176 Wayland app-id")
    },
    null,
  ),

  // OSC 555 — foot screen flash (visual bell)
  probe(
    "extensions.osc555-flash",
    sourceAbsentOsc("extensions.osc555-flash", 555, "\x1b]555\x07", "flash"),
    async (ctx) => {
      ctx.write("\x1b[1;1H\x1b[2K")
      ctx.write("\x1b]555\x07")
      const pos = await ctx.queryCursorPosition()
      return unmeasuredCellResult(pos, "OSC 555 screen flash")
    },
    null,
  ),

  // OSC 440 — mintty audio sound
  probe(
    "extensions.osc440-audio",
    sourceAbsentOsc("extensions.osc440-audio", 440, "\x1b]440;bell.wav\x07", "audio"),
    async (ctx) => {
      ctx.write("\x1b[1;1H\x1b[2K")
      ctx.write("\x1b]440;bell.wav\x07")
      const pos = await ctx.queryCursorPosition()
      return unmeasuredCellResult(pos, "OSC 440 audio playback")
    },
    null,
  ),

  // OSC 7770 — mintty font size query/set
  oscSimpleQueryProbe(
    "extensions.osc7770-font-size",
    "\x1b]7770;?\x07",
    /\x1b\]7770;[0-9]+(?:\x07|\x1b\\)/,
    "Complete OSC 7770 font-size reply",
  ),

  // OSC 7777 — mintty font + window size (zoom)
  oscSimpleQueryProbe(
    "extensions.osc7777-font-window-size",
    "\x1b]7777;?\x07",
    /\x1b\]7777;[0-9]+(?:\x07|\x1b\\)/,
    "Complete OSC 7777 window-size reply",
  ),

  // OSC 701 — rxvt-unicode locale query/set
  oscSimpleQueryProbe(
    "extensions.osc701-locale",
    "\x1b]701;?\x07",
    /\x1b\]701;[A-Za-z0-9_.-]+(?:\x07|\x1b\\)/,
    "Complete OSC 701 locale reply",
  ),

  // OSC 702 — rxvt-unicode version query
  oscSimpleQueryProbe(
    "extensions.osc702-version",
    "\x1b]702;?\x07",
    /\x1b\]702;[A-Za-z0-9_.-]+;[A-Za-z0-9_.-]+;[0-9]+;[0-9]+(?:\x07|\x1b\\)/,
    "Complete OSC 702 version reply",
  ),

  // OSC 710 — rxvt-unicode set normal font
  probe(
    "extensions.osc710-font-normal",
    sourceAbsentOsc("extensions.osc710-font-normal", 710, "\x1b]710;monospace\x07", "font"),
    () => Promise.resolve(unmeasuredStateEffect("OSC 710 font selection")),
  ),

  // OSC 720 — rxvt-unicode scroll view up
  {
    ...probe("extensions.osc720-scroll-up", osc720ScrollProbe(), async (ctx) => {
      ctx.write("\x1b[1;1H\x1b[2K")
      ctx.write("\x1b]720\x07")
      const pos = await ctx.queryCursorPosition()
      return unverifiedEffect(
        ctx,
        pos ? "Cursor answered; scrollback viewport was not measured" : "No cursor response after OSC 720",
      )
    }),
    libAssertionType: "buffer_state",
  },

  // OSC 776 — rxvt-unicode cell size report
  oscSimpleQueryProbe(
    "extensions.osc776-cell-size",
    "\x1b]776\x07",
    /\x1b\]776;[1-9][0-9]*;[1-9][0-9]*;[0-9]+(?:\x07|\x1b\\)/,
    "Complete OSC 776 cell-size reply with positive width and height",
  ),

  // Sixel support advertised in DA1 response (attribute 4)
  {
    ...queryOnly(
      probe(
        "extensions.sixel-da1",
        (ctx) => {
          const raw = ctx.feedCapture("\x1b[c")
          return sixelDa1Result(raw, sixelDa1Reply.exec(raw)?.[0] ?? null)
        },
        async (ctx) => {
          const reply = await ctx.queryOutcome("\x1b[c", sixelDa1Reply)
          return sixelDa1Result(reply.raw, reply.reason === "reply" ? (reply.match?.[0] ?? null) : null)
        },
        "query_reply",
      ),
    ),
    libAssertionType: "query_reply",
  },

  // XTSMGRAPHICS item 2 reads current Sixel geometry in pixels; item 1 is only color registers.
  {
    ...queryOnly(
      probe(
        "extensions.sixel-geometry-report",
        (ctx) => {
          if (ctx.queryWithSentinelOutcome) {
            return sixelGeometryOutcomeResult(ctx.queryWithSentinelOutcome(SIXEL_GEOMETRY_QUERY, SIXEL_GEOMETRY_REPLY))
          }
          const raw = ctx.feedCapture(SIXEL_GEOMETRY_QUERY)
          const frame = SIXEL_GEOMETRY_REPLY.exec(raw)?.[0] ?? null
          return sixelGeometryResult(raw, frame)
        },
        async (ctx) =>
          sixelGeometryOutcomeResult(
            await ctx.queryWithSentinelOutcome(SIXEL_GEOMETRY_QUERY, SIXEL_GEOMETRY_REPLY, 1000),
          ),
        "query_reply",
      ),
    ),
    libAssertionType: "query_reply",
  },
]
