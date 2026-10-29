import { randomUUID } from "node:crypto"
import type {
  ProbeDefinition,
  ProbeCallbackResult,
  LibProbeSource,
  TermProbeSource,
  TerminalQueryOutcome,
  HostInputName,
} from "./types.ts"
import {
  REPLY_AFTER_SENTINEL_NOTE,
  HEADLESS_OBSERVABLE_REVIEW,
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
  reviewResult,
  sameRgb as sameRgbCells,
  sentinelNegativeResult,
  sentinelSilenceResult,
  sgrCaptureFrames,
  sgrCaptureTooSmall,
  unmeasuredCellResult,
} from "./helpers.ts"
import { nativeHostRecipeResult } from "./native-host-audit.ts"
import { sgrTermReadback } from "./sgr.ts"
import { captureRegionGeometry, captureRegionReadbackDecision, collectorRegionRead } from "./region-readback.ts"
import { SIXEL_BOUNDS, SIXEL_REGION, sixelReadback } from "./sixel-capture.ts"

/** A minimal solid-red 8x8 PNG; the OSC 1337 inline image target renders it as reviewable pixels. */
const ITERM2_RED_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR42mP4z8CAFTEMLQkAKP8/wc53yE8AAAAASUVORK5CYII="

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
  prefix: RegExp,
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
    return { pass: false, response: raw, tests: [{ id: "criterion", status: "test-failure", reason: "no-response" }] }
  }
  return {
    pass: false,
    response: raw,
    observation: {
      outcome: "inconclusive",
      reason: prefix.test(raw) ? "invalid-reply" : "no-response",
      assertionType: "query_reply",
    },
  }
}

/**
 * Live's grading of one OSC query outcome. A library probe source on a proven reply path offers the same
 * outcome through `queryWithSentinelOutcome` (#30554), so both arms grade through here.
 */
function oscOutcomeResult(reply: TerminalQueryOutcome, expected: string, prefix: RegExp): ProbeCallbackResult {
  return oscReplyResult(reply.raw, replyFrame(reply), expected, prefix, reply.sentinel)
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
      return { pass: false, response: raw, tests: [{ id: "criterion", status: "test-failure", reason: "no-response" }] }
    }
    return {
      pass: false,
      response: raw,
      observation: {
        outcome: "inconclusive",
        reason: raw.includes("\x1b[?") ? "invalid-reply" : "no-response",
        assertionType: "query_reply",
      },
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
  return sixelGeometryResult(
    reply.raw,
    replyFrame(reply),
    reply.reason === "timeout" ? "timeout" : "no-response",
    reply.sentinel,
  )
}

/** A read of current Sixel geometry; protocol failure and silence never establish a negative. */
function sixelGeometryResult(
  raw: string,
  frame: string | null,
  missingReason: "no-response" | "timeout",
  sentinel?: { atMs: number; graceMs: number },
): ProbeCallbackResult {
  // xterm replies with CSI ? Pi ; Ps ; Pv S, but omits the value on failure, so the
  // measured failure frame is two parameters (CSI ? 2 ; 3 S). Requiring a third
  // parameter graded that documented failure as a malformed geometry.
  const reply = frame ? /\x1b\[\?2;([0-9]+)(?:;([0-9;]*))?S/.exec(frame) : null
  if (!reply) {
    const malformed = frame !== null
    const note = malformed ? "Malformed Sixel geometry response" : "No Sixel geometry response for item 2"
    if (!malformed) {
      const silent = sentinelNegativeResult(raw, sentinel, "Complete Sixel geometry response for item 2")
      if (silent) return silent
    }
    if (raw.length === 0) {
      return { pass: false, response: raw, note, tests: [{ id: "criterion", status: "test-failure", reason: note }] }
    }
    return {
      pass: false,
      response: raw,
      note,
      observation: {
        outcome: "inconclusive",
        assertionType: "query_reply",
        reason: malformed ? "invalid-reply" : missingReason,
        note,
      },
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
    verified: setterRaw === "" && frame === seededRaw && color !== null && sameRgb(color, seededCurrentColor),
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
  const prefix = new RegExp(`\\x1b\\]${slot};`)
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
            if (!reviewInitialValue || !silence) return oscOutcomeResult(outcome, expected, prefix)
          }
          const raw = silence ? "" : ctx.feedCapture(querySeq)
          const answer = (result: ProbeCallbackResult) =>
            hostInput === undefined
              ? result
              : nativeHostRecipeResult(ctx, result, "color-request", hostInput, querySeq, raw === "")
          if (raw !== "" || !reviewInitialValue) {
            return answer(oscReplyResult(raw, pattern.exec(raw)?.[0] ?? null, expected, prefix))
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
            ...oscReplyResult(raw, null, expected, prefix),
            response: JSON.stringify(state),
          })
        },
        async (ctx) => oscOutcomeResult(await ctx.queryWithSentinelOutcome(querySeq, pattern), expected, prefix),
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
    if (reply.reason !== "reply" || !match) return null
    const [, r, g, b] = match
    if (r === undefined || g === undefined || b === undefined) return null
    return { raw: match[0] ?? "", rgb: `${r}/${g}/${b}` }
  }
  const inconclusive = (note: string): ProbeCallbackResult => ({
    pass: false,
    tests: [{ id: "criterion", status: "test-failure", reason: note }] as [
      { id: string; status: "test-failure"; reason: string },
    ],
  })
  return {
    ...probe(
      id,
      (ctx) => {
        ctx.feed(`\x1b]${resetCode}\x07X`)
        return notTestedResult(`highlight colour reset (OSC ${resetCode})`, { cell: ctx.getCell(0, 0) })
      },
      async (ctx): Promise<ProbeCallbackResult> => {
        const initial = await read(ctx)
        if (!initial) {
          return inconclusive(
            `${id}: OSC ${setCode} did not report a colour, so the initial highlight colour is unknown and a reset cannot be compared with it`,
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
          const applied = await read(ctx)
          if (!applied) {
            return inconclusive(
              `${id}: the known colour was not read back after OSC ${setCode}; a reset cannot be graded against a set that did not apply`,
            )
          }
          if (applied.rgb !== known) {
            return inconclusive(
              `${id}: OSC ${setCode} reported ${applied.rgb} after setting ${known}, so the set did not take and a reset means nothing`,
            )
          }
          ctx.write(`\x1b]${resetCode}\x07`)
          const afterReset = await read(ctx)
          if (!afterReset) return inconclusive(`${id}: OSC ${setCode} did not answer after OSC ${resetCode}`)
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
    libAssertionType: null,
  }
}

function oscSimpleQueryProbe(
  id: string,
  query: string,
  pattern: RegExp,
  prefix: RegExp,
  expected: string,
): ProbeDefinition {
  return {
    ...queryOnly(
      probe(
        id,
        (ctx) => {
          const outcome = ctx.queryWithSentinelOutcome?.(query, pattern)
          const raw = outcome ? outcome.raw : ctx.feedCapture(query)
          const result = outcome
            ? oscOutcomeResult(outcome, expected, prefix)
            : oscReplyResult(raw, pattern.exec(raw)?.[0] ?? null, expected, prefix)
          const identity = ctx.runtimeIdentity
          const zeroGeometry =
            (id === "extensions.osc1337-cellsize" &&
              /^\x1b\]1337;ReportCellSize=0;0\x1b\\(?:\x1b\[\?[0-9]+(?:;[0-9]+)*c)?$/.test(raw)) ||
            (id === "extensions.osc776-cell-size" &&
              /^\x1b\]776;0;0;0\x1b\\(?:\x1b\[\?[0-9]+(?:;[0-9]+)*c)?$/.test(raw))
          if (
            zeroGeometry &&
            result.observation?.outcome === "inconclusive" &&
            identity?.kind === "js" &&
            identity.runtimeFormat === "js" &&
            identity.resolvedPath === "vendor/vterm/packages/vterm/src/index.ts" &&
            identity.integrity.kind === "source" &&
            identity.integrity.cleanTree &&
            identity.integrity.repository === "git@github.com:beorn/vterm.git" &&
            identity.integrity.revision === "1cfc325f3aedd4617e437ee76e6a03fc2cc16438" &&
            identity.integrity.treeOid === "2ee13d2cb894e86ee9575dd6945f42028df44966"
          ) {
            return reviewResult(
              "headless-geometry-review",
              "Required independent review of the audited headless context and retained zero geometry reply pending",
              "Audited vterm headless subject has no physical font cell dimensions",
              {
                query,
                raw,
                runtimeIdentity: identity,
                sourceCitation:
                  "vterm screen.ts at 1cfc325f: ScreenOptions has no physical font metrics; OSC1337 ReportCellSize and OSC776 deliberately report unknown zero dimensions (#30575)",
              },
            )
          }
          return result
        },
        async (ctx) => oscOutcomeResult(await ctx.queryWithSentinelOutcome(query, pattern), expected, prefix),
        "query_reply",
      ),
    ),
    libAssertionType: "query_reply",
  }
}

function colorResetProbe(setCode: number, resetCode: number, index?: number): ProbeDefinition["lib"] {
  const hostColorSlot = [4, 10, 11, 12].includes(setCode)
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
      if (silence && !hostColorSlot) return silence
    }
    const originalRaw = silence ? "" : ctx.feedCapture(query)
    const original = replyPattern.exec(originalRaw)?.[1]
    if (!original) {
      if (originalRaw === "") {
        if (!hostColorSlot) {
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
        if (indexed && before && seeded && !sameRgbCells(before, seed) && sameRgbCells(seeded, seed)) {
          if (same && fresh && sameRgbCells(fresh, before) && !(restored && sameRgb(restored, seededCurrentColor))) {
            return parserStateResult(
              true,
              "OSC 104 restores palette index 0 for a fresh indexed cell",
              state,
              sameRgbCells(same, before)
                ? "Indexed colour resolved at read"
                : sameRgbCells(same, seed)
                  ? "Cell RGB resolved at paint; fresh cell proves reset"
                  : "Stored cell RGB differs from default and seed; fresh cell proves reset",
            )
          }
          if (same && fresh && sameRgbCells(fresh, seed) && sameRgbCells(same, seed)) {
            return parserStateResult(
              false,
              "OSC 104 restores palette index 0 for a fresh indexed cell",
              state,
              "Verified seed remains in the fresh cell after reset",
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
        if (control.verified && restored && sameRgb(restored, seededCurrentColor)) {
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
          // Keep the deciding DA1 bytes intact; optional cell/control evidence accompanies its assertion.
          return answer(
            indexed && silence.observation
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
          ...oscReplyResult(originalRaw, null, `OSC ${setCode} color before reset`, new RegExp(`\\x1b\\]${setCode};`)),
          response,
        })
      }
      return oscReplyResult(originalRaw, null, `OSC ${setCode} color before reset`, new RegExp(`\\x1b\\]${setCode};`))
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
      if (!sameRgb(changed, requested)) {
        return colorSetIgnoredResult(response, setCode)
      }
      const pass = sameRgb(restored, original)
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
      if (mustReset) {
        try {
          ctx.feed(`\x1b]${resetCode}${index === undefined ? "" : `;${index}`}\x07`)
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

function sameRgb(left: string, right: string): boolean {
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
  return sameRgb(before, "rgb:aa/bb/cc") ? "rgb:12/34/56" : "rgb:aa/bb/cc"
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
  const prefix = new RegExp(`\\x1b\\]${spec.setCode};`)
  const read = async () => {
    const outcome = await ctx.queryWithSentinelOutcome(query, reply)
    return { outcome, rgb: outcome.match?.[1] ?? null }
  }
  const before = await read()
  if (!before.rgb) {
    return oscReplyResult(
      before.outcome.raw,
      null,
      `Complete OSC ${spec.setCode} color reply`,
      prefix,
      before.outcome.sentinel,
    )
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
  if (!sameRgb(changed.rgb, requested)) {
    return colorSetIgnoredResult(response, spec.setCode)
  }
  const pass = sameRgb(restored.rgb, before.rgb)
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
      colorResetProbe(setCode, resetCode, index),
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

function colorStackResult(before: string, requested: string, changed: string, restored: string): ProbeCallbackResult {
  const changedAsRequested = sameRgb(changed, requested)
  const restoredOriginal = sameRgb(restored, before)
  const pass = changedAsRequested && restoredOriginal
  const response = JSON.stringify({ before, changed, restored })
  const note = pass
    ? "Foreground changed and color-stack pop restored its original value"
    : "Foreground change or stack restoration was not observed"
  return {
    pass,
    response,
    note,
    observation: { outcome: pass ? "supported" : "unsupported", assertionType: "query_reply", note },
    assertions: [
      {
        assertionType: "query_reply" as const,
        kind: pass ? "positive" : "negative",
        expected: "Changed foreground and restored original after color-stack pop",
        observed: response,
      },
    ],
  }
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
 * qualified sequence records the named no-semantic-observable coverage. A consumed-but-unqualified
 * read, and a missing cell, stay a real consumption observation — never not-tested.
 */
function promptMarkResult(ctx: LibProbeSource, sequence: string, noObservable: string): ProbeCallbackResult {
  ctx.feed("\x1b[1;1H")
  const home = ctx.getCursor()
  ctx.feed(sequence + "X")
  const cell = ctx.getCell(0, 0)
  const target = ctx.getCursor()
  ctx.feed("\x1b[1;1H")
  const control = ctx.getCursor()
  const consumed = cell.char === "X"
  const qualified =
    consumed && home.x === 0 && home.y === 0 && target.x === 1 && target.y === 0 && control.x === 0 && control.y === 0
  if (!qualified) return promptConsumptionResult(consumed)
  return reviewResult(
    "semantic-prompt-source-review",
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
    let seedAttempted = false
    let fixtureVerified = false
    let readbackUnavailable = false
    let comparison: { before: string; changed: string; restored: string } | undefined
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
      return {
        pass: false,
        response: JSON.stringify({ query: foregroundQuery, originalRaw }),
        note: "No original OSC 10 foreground reply",
        tests: [{ id: "criterion", status: "test-failure", reason: "no-response" }],
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
      const requested = probeForeground(before)
      result = feed(colorPush, "Color-stack push")
      if (result !== undefined) return result
      pushed = true
      result = feed(`\x1b]10;${requested}\x07`, "Foreground mutation")
      if (result !== undefined) return result
      const changed = queryForeground("Foreground query after mutation")
      if (changed !== null && typeof changed !== "string") {
        result = changed
        return result
      }
      result = feed(colorPop, "Color-stack pop")
      if (result !== undefined) return result
      pushed = false
      const restored = queryForeground("Foreground query after pop")
      if (restored !== null && typeof restored !== "string") {
        result = restored
        return result
      }
      if (!changed || !restored) {
        result = {
          pass: false,
          note: "No OSC 10 reply after changing or popping color",
          tests: [{ id: "criterion", status: "test-failure", reason: "no-response" }],
        }
      } else {
        comparison = { before, changed, restored }
        result = colorStackResult(before, requested, changed, restored)
      }
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
): Promise<ProbeCallbackResult> {
  const originalReply = await ctx.queryWithSentinelOutcome(foregroundQuery, foregroundReply)
  const before = foregroundValue(originalReply.match?.[0] ?? "")
  if (!before) return unansweredQuery(originalReply, "No original OSC 10 foreground reply; color stack was not changed")
  let pushed = false
  const requested = probeForeground(before)
  try {
    ctx.write(colorPush)
    pushed = true
    ctx.write(`\x1b]10;${requested}\x07`)
    const changedReply = await ctx.queryWithSentinelOutcome(foregroundQuery, foregroundReply)
    const changed = foregroundValue(changedReply.match?.[0] ?? "")
    if (!changed) return unansweredQuery(changedReply, "No OSC 10 reply after changing foreground")
    ctx.write(colorPop)
    pushed = false
    const restoredReply = await ctx.queryWithSentinelOutcome(foregroundQuery, foregroundReply)
    const restored = foregroundValue(restoredReply.match?.[0] ?? "")
    if (!restored) return unansweredQuery(restoredReply, "No OSC 10 reply after color-stack pop")
    return colorStackResult(before, requested, changed, restored)
  } finally {
    try {
      if (pushed) ctx.write(colorPop)
    } finally {
      ctx.write(`\x1b]10;${before}\x07`)
    }
  }
}

function osc720ScrollProbe(): ProbeDefinition["lib"] {
  return (ctx) => {
    for (let i = 0; i < 30; i++) ctx.feed(`scroll-${i}\r\n`)
    const before = ctx.getScrollback()
    if (before.totalLines <= before.screenLines || before.viewportOffset <= 0) {
      return parserStateResult(
        null,
        "OSC 720 moves the scrollback viewport up",
        { before },
        "No scrollback viewport available",
      )
    }
    ctx.feed("\x1b]720\x07")
    const after = ctx.getScrollback()
    const pass = after.viewportOffset < before.viewportOffset
    return parserStateResult(pass, "OSC 720 moves the scrollback viewport up", { before, after })
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
      ? {
          tests: [{ id: "criterion", status: "test-failure", reason: note }] as [
            { id: string; status: "test-failure"; reason: string },
          ],
        }
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
      pass: false,
      response: reply.raw,
      note,
      tests: [{ id: "criterion", status: "test-failure", reason: note }],
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

/** Only an isolated headless backend may receive this disposable OSC 52 nonce. */
function headlessClipboardRoundtrip(ctx: LibProbeSource): ProbeCallbackResult {
  const nonce = `terminfo-osc52-${randomUUID()}`
  const encoded = btoa(nonce)
  ctx.feed(`\x1b]52;c;${encoded}\x07`)
  const query = "\x1b]52;c;?\x07"
  const outcome = ctx.queryWithSentinelOutcome?.(query, osc52Reply)
  const raw = outcome ? outcome.raw : ctx.feedCapture(query)
  // CTO d5f41664: unmatched/partial bytes lose the old per-capture empty attribution deliberately.
  // The existing silence classifier supplies only the host-input fact, never this write's verdict.
  const empty = outcome
    ? sentinelSilenceResult(outcome, "OSC 52 c query returns the exact written nonce") !== null || raw === ""
    : raw === ""
  return nativeHostRecipeResult(
    ctx,
    { ...headlessClipboardResult(empty ? "" : raw, nonce), response: raw },
    "clipboard-load",
    "clipboard-read-permission",
    query,
    empty,
  )
}

/** Read silence is conclusive only on a collector-qualified, ordered reply path. */
function headlessClipboardRead(ctx: LibProbeSource): ProbeCallbackResult {
  const nonce = `terminfo-osc52-${randomUUID()}`
  ctx.feed(`\x1b]52;c;${btoa(nonce)}\x07`)
  if (ctx.queryWithSentinelOutcome) {
    const outcome = ctx.queryWithSentinelOutcome("\x1b]52;c;?\x07", osc52Reply)
    const silence = sentinelSilenceResult(outcome, "OSC 52 c query returns the exact written nonce")
    return nativeHostRecipeResult(
      ctx,
      silence ?? headlessClipboardResult(outcome.raw, nonce),
      "clipboard-load",
      "clipboard-read-permission",
      "\x1b]52;c;?\x07",
      silence !== null,
    )
  }
  const raw = ctx.feedCapture("\x1b]52;c;?\x07")
  return nativeHostRecipeResult(
    ctx,
    headlessClipboardResult(raw, nonce),
    "clipboard-load",
    "clipboard-read-permission",
    "\x1b]52;c;?\x07",
    raw === "",
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
    return { pass: false, response, note, tests: [{ id: "criterion", status: "test-failure", reason: note }] }
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
      return { pass: false, tests: [{ id: "criterion", status: "test-failure", reason: "No complete OSC 52 c reply" }] }
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
        return {
          pass: false,
          tests: [
            {
              id: "criterion",
              status: "test-failure",
              reason: "No cursor reply after OSC 52 write; clipboard contents were not measured",
            },
          ],
        }
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
  if (!input || !readInput) return notTestedResult("OS-level XTEST paste injection", { input: false })
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
): ProbeCallbackResult {
  const response = JSON.stringify({ ...raw, iconLabel, windowTitle })
  if (iconLabel === null || windowTitle === null) {
    const missing = iconLabel === null ? "icon label (CSI 20 t)" : "window title (CSI 21 t)"
    const note = `no complete ${missing} reply`
    return {
      pass: false,
      response,
      note,
      ...(raw.icon.length === 0 && raw.title.length === 0
        ? {
            tests: [{ id: "criterion", status: "test-failure", reason: note }] as [
              { id: string; status: "test-failure"; reason: string },
            ],
          }
        : {
            observation: {
              outcome: "inconclusive",
              reason: "insufficient-evidence",
              assertionType: "query_reply",
              note,
            },
          }),
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
      const note = "Declared Kitty graphics capability does not establish timed animation playback"
      return reviewResult(HEADLESS_OBSERVABLE_REVIEW, `Headless observable review required: ${note}`, note, {
        declared: ctx.capabilities.kittyGraphics === true,
      })
    },
    () => {
      const note = "No timed frame playback or pixel readback for Kitty animation"
      return Promise.resolve<ProbeCallbackResult>({
        pass: false,
        note,
        tests: [{ id: "criterion", status: "test-todo", reason: note }],
      })
    },
  ),

  probe(
    "extensions.kitty-graphics.unicode-placeholders",
    (ctx) => {
      const note = "Declared Kitty graphics capability does not establish Unicode placeholder rendering"
      return reviewResult(HEADLESS_OBSERVABLE_REVIEW, `Headless observable review required: ${note}`, note, {
        declared: ctx.capabilities.kittyGraphics === true,
      })
    },
    () => {
      const note = "No pixel and placeholder-cell readback for Kitty Unicode placeholders"
      return Promise.resolve<ProbeCallbackResult>({
        pass: false,
        note,
        tests: [{ id: "criterion", status: "test-todo", reason: note }],
      })
    },
  ),

  // Sixel — rendering remains unmeasured without pixel readback.
  {
    ...probe(
      "extensions.sixel",
      (ctx) => {
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
          const adapter = identity
            ? `${identity.kind === "js" ? identity.resolvedPath : identity.loadedBinary.path} at Termless ${identity.termlessRevision}`
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

  // Current wrapping and a declared backend capability do not measure reflow after resize.
  probe(
    "extensions.reflow",
    (ctx) => {
      const note = "No controlled resize and cell-content readback to measure reflow"
      return notTestedResult(note, { declaredReflow: ctx.capabilities.reflow === true })
    },
    () => {
      const note = "No controlled resize and cell-content readback to measure reflow"
      return Promise.resolve<ProbeCallbackResult>({
        pass: false,
        note,
        tests: [{ id: "criterion", status: "test-todo", reason: note }],
      })
    },
  ),

  // Semantic prompts (OSC 133)
  probe(
    "extensions.semantic-prompts",
    (ctx) => {
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

  // OSC 2 — window title
  {
    ...probe(
      "extensions.osc2-title",
      (ctx) => {
        ctx.feed("\x1b]2;Test Title\x07")
        const title = ctx.getTitle()
        return parserStateResult(title === "Test Title", "OSC 2 sets the exact requested window title", { title })
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
        ctx.feed(`\x1b]0;${OSC0_PAYLOAD}\x07`)
        const iconOutcome = ctx.queryWithSentinelOutcome?.(OSC0_ICON_QUERY, OSC0_ICON_REPLY)
        const titleOutcome = ctx.queryWithSentinelOutcome?.(OSC0_TITLE_QUERY, OSC0_TITLE_REPLY)
        const icon = iconOutcome ? iconOutcome.raw : ctx.feedCapture(OSC0_ICON_QUERY)
        const title = titleOutcome ? titleOutcome.raw : ctx.feedCapture(OSC0_TITLE_QUERY)
        const iconLabel = iconOutcome ? (iconOutcome.match?.[1] ?? null) : (OSC0_ICON_REPLY.exec(icon)?.[1] ?? null)
        const windowTitle = titleOutcome
          ? (titleOutcome.match?.[1] ?? null)
          : (OSC0_TITLE_REPLY.exec(title)?.[1] ?? null)
        return osc0IconTitleResult(iconLabel, windowTitle, { icon, title })
      },
      async (ctx) => {
        ctx.write(`\x1b]0;${OSC0_PAYLOAD}\x07`)
        const icon = await ctx.queryWithSentinelOutcome(OSC0_ICON_QUERY, OSC0_ICON_REPLY)
        const title = await ctx.queryWithSentinelOutcome(OSC0_TITLE_QUERY, OSC0_TITLE_REPLY)
        return osc0IconTitleResult(icon.match?.[1] ?? null, title.match?.[1] ?? null, {
          icon: icon.raw,
          title: title.raw,
        })
      },
      "query_reply",
    ),
    libAssertionType: "query_reply",
  },

  // OSC 52 — clipboard
  {
    ...probe(
      "extensions.osc52-clipboard",
      headlessClipboardRoundtrip,
      (ctx) => liveClipboardProbe(ctx, "roundtrip"),
      "query_reply",
    ),
    libAssertionType: "query_reply",
    libHostRecipes: [{ recipe: "clipboard-load", query: "\x1b]52;c;?\x07", missing: ["clipboard-read-permission"] }],
  },

  // OSC 52 write — set clipboard (most terminals support this)
  {
    ...probe(
      "extensions.osc52-write",
      headlessClipboardRoundtrip,
      (ctx) => liveClipboardProbe(ctx, "write"),
      "query_reply",
    ),
    libAssertionType: "query_reply",
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
    () => osInputReviewResult("OS-level XTEST paste injection", { input: false }),
    clipboardPaste,
    "input_bytes",
  ),

  // OSC 10 — foreground color query
  oscColorQueryProbe("extensions.osc10-fg-color", 10),

  // OSC 11 — background color query
  oscColorQueryProbe("extensions.osc11-bg-color", 11),

  // OSC 7 — current working directory
  probe(
    "extensions.osc7-cwd",
    (ctx) => {
      const note = "Declared OSC 7 capability does not establish working-directory metadata delivery"
      return reviewResult(HEADLESS_OBSERVABLE_REVIEW, `Headless observable review required: ${note}`, note, {
        declared: ctx.capabilities.extensions.has("osc7"),
      })
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

  // OSC 633 — VS Code shell integration
  probe(
    "extensions.osc-633-vscode",
    (ctx) => {
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

  // OSC 133 sub-commands — semantic prompt markers (FinalTerm)
  // Each probe sends the marker followed by "X" and verifies "X" landed at cell (0,0),
  // proving the OSC sequence was silently consumed (not printed literally).

  // OSC 133;A — prompt start (FTCS_PROMPT)
  {
    ...probe(
      "extensions.osc133-a",
      (ctx) => promptMarkResult(ctx, "\x1b]133;A\x07", "OSC 133;A prompt-start mark registration"),
      (ctx) => promptMarkAppResult(ctx, "\x1b]133;A\x07", "OSC 133;A prompt-start mark registration"),
    ),
    libAssertionType: null,
  },

  // OSC 133;B — command start (FTCS_COMMAND_START)
  {
    ...probe(
      "extensions.osc133-b",
      (ctx) => promptMarkResult(ctx, "\x1b]133;B\x07", "OSC 133;B command-start mark registration"),
      (ctx) => promptMarkAppResult(ctx, "\x1b]133;B\x07", "OSC 133;B command-start mark registration"),
    ),
    libAssertionType: null,
  },

  // OSC 133;C — command executed (FTCS_COMMAND_EXECUTED)
  {
    ...probe(
      "extensions.osc133-c",
      (ctx) => promptMarkResult(ctx, "\x1b]133;C\x07", "OSC 133;C command-executed mark registration"),
      (ctx) => promptMarkAppResult(ctx, "\x1b]133;C\x07", "OSC 133;C command-executed mark registration"),
    ),
    libAssertionType: null,
  },

  // OSC 133;D — command finished with exit code (FTCS_COMMAND_FINISHED)
  {
    ...probe(
      "extensions.osc133-d",
      (ctx) => promptMarkResult(ctx, "\x1b]133;D;0\x07", "OSC 133;D command-finished mark registration"),
      (ctx) => promptMarkAppResult(ctx, "\x1b]133;D;0\x07", "OSC 133;D command-finished mark registration"),
    ),
    libAssertionType: null,
  },

  // OSC 133;P — properties (Cwd, CmdLine, etc.)
  {
    ...probe(
      "extensions.osc133-p",
      (ctx) => promptMarkResult(ctx, "\x1b]133;P;Cwd=/tmp\x07", "OSC 133;P properties mark registration"),
      (ctx) => promptMarkAppResult(ctx, "\x1b]133;P;Cwd=/tmp\x07", "OSC 133;P properties mark registration"),
    ),
    libAssertionType: null,
  },

  // OSC 633 sub-commands — VS Code shell integration markers
  // VS Code's parallel namespace to OSC 133, with VS Code-specific extensions (E, P).

  // OSC 633;A — prompt start (mirrors 133;A)
  {
    ...probe(
      "extensions.osc633-a",
      (ctx) => promptMarkResult(ctx, "\x1b]633;A\x07", "OSC 633;A prompt-start mark registration"),
      (ctx) => promptMarkAppResult(ctx, "\x1b]633;A\x07", "OSC 633;A prompt-start mark registration"),
    ),
    libAssertionType: null,
  },

  // OSC 633;B — prompt end (mirrors 133;B)
  {
    ...probe(
      "extensions.osc633-b",
      (ctx) => promptMarkResult(ctx, "\x1b]633;B\x07", "OSC 633;B prompt-end mark registration"),
      (ctx) => promptMarkAppResult(ctx, "\x1b]633;B\x07", "OSC 633;B prompt-end mark registration"),
    ),
    libAssertionType: null,
  },

  // OSC 633;C — pre-execution (mirrors 133;C)
  {
    ...probe(
      "extensions.osc633-c",
      (ctx) => promptMarkResult(ctx, "\x1b]633;C\x07", "OSC 633;C pre-execution mark registration"),
      (ctx) => promptMarkAppResult(ctx, "\x1b]633;C\x07", "OSC 633;C pre-execution mark registration"),
    ),
    libAssertionType: null,
  },

  // OSC 633;D — command finished with exit code (mirrors 133;D)
  {
    ...probe(
      "extensions.osc633-d",
      (ctx) => promptMarkResult(ctx, "\x1b]633;D;0\x07", "OSC 633;D command-finished mark registration"),
      (ctx) => promptMarkAppResult(ctx, "\x1b]633;D;0\x07", "OSC 633;D command-finished mark registration"),
    ),
    libAssertionType: null,
  },

  // OSC 633;E — set commandline with verification nonce (unique to OSC 633)
  {
    ...probe(
      "extensions.osc633-e",
      (ctx) =>
        promptMarkResult(ctx, "\x1b]633;E;ls -la;nonce123\x07", "OSC 633;E commandline-with-nonce mark registration"),
      (ctx) =>
        promptMarkAppResult(
          ctx,
          "\x1b]633;E;ls -la;nonce123\x07",
          "OSC 633;E commandline-with-nonce mark registration",
        ),
    ),
    libAssertionType: null,
  },

  // OSC 633;P — VS Code-specific properties (Cwd, IsWindows, git status)
  {
    ...probe(
      "extensions.osc633-p",
      (ctx) => promptMarkResult(ctx, "\x1b]633;P;Cwd=/tmp\x07", "OSC 633;P properties mark registration"),
      (ctx) => promptMarkAppResult(ctx, "\x1b]633;P;Cwd=/tmp\x07", "OSC 633;P properties mark registration"),
    ),
    libAssertionType: null,
  },

  // OSC 9 — desktop notifications
  probe(
    "extensions.notifications",
    (ctx) => {
      const note = "Declared OSC 9 capability does not establish desktop notification delivery"
      return reviewResult(HEADLESS_OBSERVABLE_REVIEW, `Headless observable review required: ${note}`, note, {
        declared: ctx.capabilities.extensions.has("osc9"),
      })
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

  // OSC 1337 — iTerm2 inline images
  {
    ...probe(
      "extensions.iterm2-images",
      (ctx) => {
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
              "\x1b[0m\x1b[2J\x1b[3;3H\x1b]1337;File=inline=1;width=8px;height=8px:" + ITERM2_RED_PNG + "\x07",
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
    /\x1b\]1337;ReportCellSize=/,
    "Complete OSC 1337 ReportCellSize reply with two positive dimensions and an optional scale",
  ),

  // OSC 1337 Capabilities — query terminal capabilities
  oscSimpleQueryProbe(
    "extensions.osc1337-capabilities",
    "\x1b]1337;Capabilities\x07",
    /\x1b\]1337;Capabilities=[^\x07\x1b]*(?:\x07|\x1b\\)/,
    /\x1b\]1337;Capabilities=/,
    "Complete OSC 1337 Capabilities reply",
  ),

  // OSC 9;4 — progress bar (ConEmu protocol, adopted by Ghostty, iTerm2, Windows Terminal, etc.)
  probe(
    "extensions.osc9-progress",
    // Headless: no way to detect OSC 9;4 support (all backends silently consume unknown OSC)
    null,
    () => Promise.resolve(unmeasuredStateEffect("OSC 9;4 progress display")),
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
          return {
            pass: false,
            tests: [{ id: "criterion", status: "test-failure", reason: "No baseline cursor response" }],
          }
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
          return {
            pass: false,
            tests: [{ id: "criterion", status: "test-failure", reason: "Missing cursor response for text sizing" }],
          }
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
            return {
              ...osc5522DetectionResult(reply.raw, replyFrame(reply) !== null, reply.sentinel !== undefined),
              response: reply.raw,
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
          return notTestedResult("icon-name state", { before, after })
        }
        const before = ctx.getIconLabel()
        ctx.feed("\x1b]1;test-icon\x07")
        const after = ctx.getIconLabel()
        return parserStateResult(after === "test-icon", "OSC 1 sets the icon name", { before, after })
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
    /\x1b\]5;0;/,
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
    null, // No headless pointer-shape query or desktop observation is implemented here.
    async (ctx) => {
      ctx.write("\x1b[1;1H\x1b[2K")
      ctx.write("\x1b]22;pointer\x07")
      const pos = await ctx.queryCursorPosition()
      return unmeasuredCellResult(pos, "OSC 22 pointer shape")
    },
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
    null, // Headless: no way to detect notification support (silently consumed)
    async (ctx) => {
      ctx.write("\x1b[1;1H\x1b[2K")
      ctx.write("\x1b]777;notify;test;body\x07")
      const pos = await ctx.queryCursorPosition()
      return unmeasuredCellResult(pos, "OSC 777 notification delivery")
    },
  ),

  // OSC 666 — VTE termprop
  probe(
    "extensions.osc666-termprop",
    null, // Headless: no way to detect termprop support (silently consumed)
    async (ctx) => {
      ctx.write("\x1b[1;1H\x1b[2K")
      ctx.write("\x1b]666;test-prop=value\x07")
      const pos = await ctx.queryCursorPosition()
      return unmeasuredCellResult(pos, "OSC 666 terminal property")
    },
  ),

  // OSC 3008 — systemd context
  probe(
    "extensions.osc3008-context",
    null, // Headless: no way to detect context support (silently consumed)
    async (ctx) => {
      ctx.write("\x1b[1;1H\x1b[2K")
      ctx.write("\x1b]3008;type=test\x07")
      const pos = await ctx.queryCursorPosition()
      return unmeasuredCellResult(pos, "OSC 3008 systemd context")
    },
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
    ...probe("extensions.osc30001-color-stack-push", colorStackProbe(colorPush), colorStackTermProbe, "query_reply"),
    libHostRecipes: [{ recipe: "color-request", query: foregroundQuery, missing: ["foreground-rgb"] }],
  },

  // OSC 30101 — Kitty color stack pop
  {
    ...probe("extensions.osc30101-color-stack-pop", colorStackProbe(colorPop), colorStackTermProbe, "query_reply"),
    libHostRecipes: [{ recipe: "color-request", query: foregroundQuery, missing: ["foreground-rgb"] }],
  },

  // OSC 176 — foot Wayland app-id
  probe(
    "extensions.osc176-app-id",
    null, // Headless: app-id is a Wayland window-manager concept, not in the cell grid
    async (ctx) => {
      ctx.write("\x1b[1;1H\x1b[2K")
      ctx.write("\x1b]176;terminfo-test\x07")
      const pos = await ctx.queryCursorPosition()
      return unmeasuredCellResult(pos, "OSC 176 Wayland app-id")
    },
  ),

  // OSC 555 — foot screen flash (visual bell)
  probe(
    "extensions.osc555-flash",
    null, // Headless: visual bell is a UI animation, not in the cell grid
    async (ctx) => {
      ctx.write("\x1b[1;1H\x1b[2K")
      ctx.write("\x1b]555\x07")
      const pos = await ctx.queryCursorPosition()
      return unmeasuredCellResult(pos, "OSC 555 screen flash")
    },
  ),

  // OSC 440 — mintty audio sound
  probe(
    "extensions.osc440-audio",
    null, // Headless: audio playback is not observable from the cell grid
    async (ctx) => {
      ctx.write("\x1b[1;1H\x1b[2K")
      ctx.write("\x1b]440;bell.wav\x07")
      const pos = await ctx.queryCursorPosition()
      return unmeasuredCellResult(pos, "OSC 440 audio playback")
    },
  ),

  // OSC 7770 — mintty font size query/set
  oscSimpleQueryProbe(
    "extensions.osc7770-font-size",
    "\x1b]7770;?\x07",
    /\x1b\]7770;[0-9]+(?:\x07|\x1b\\)/,
    /\x1b\]7770;/,
    "Complete OSC 7770 font-size reply",
  ),

  // OSC 7777 — mintty font + window size (zoom)
  oscSimpleQueryProbe(
    "extensions.osc7777-font-window-size",
    "\x1b]7777;?\x07",
    /\x1b\]7777;[0-9]+(?:\x07|\x1b\\)/,
    /\x1b\]7777;/,
    "Complete OSC 7777 window-size reply",
  ),

  // OSC 701 — rxvt-unicode locale query/set
  oscSimpleQueryProbe(
    "extensions.osc701-locale",
    "\x1b]701;?\x07",
    /\x1b\]701;[A-Za-z0-9_.-]+(?:\x07|\x1b\\)/,
    /\x1b\]701;/,
    "Complete OSC 701 locale reply",
  ),

  // OSC 702 — rxvt-unicode version query
  oscSimpleQueryProbe(
    "extensions.osc702-version",
    "\x1b]702;?\x07",
    /\x1b\]702;[A-Za-z0-9_.-]+;[A-Za-z0-9_.-]+;[0-9]+;[0-9]+(?:\x07|\x1b\\)/,
    /\x1b\]702;/,
    "Complete OSC 702 version reply",
  ),

  // OSC 710 — rxvt-unicode set normal font
  probe(
    "extensions.osc710-font-normal",
    null, // Headless: font selection is not observable in the cell grid
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
    /\x1b\]776;/,
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
          return sixelGeometryResult(raw, frame, "no-response")
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
