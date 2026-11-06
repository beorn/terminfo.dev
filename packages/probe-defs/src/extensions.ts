import { randomUUID } from "node:crypto"
import type {
  ProbeDefinition,
  ProbeCallbackResult,
  LibProbeSource,
  TermProbeSource,
  TerminalQueryOutcome,
  CallbackHostRecipeCause,
  HostInputName,
  HostRecipeName,
  ObservationFrame,
  UnhandledSequence,
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
  NO_SAME_PATH_CONTROL,
  colorReadbackReviewResult,
  parserStateResult,
  probe,
  readHyperlinkMetadata,
  readSentinelReply,
  sentinelAnswer,
  replyFrame,
  replyFailure,
  cancelReplyFailure,
  reviewResult,
  declaredUntestableResult,
  isDeclaredUntestable,
  productViewportAbsenceResult,
  auditedAdapterSources,
  sameRgb as sameRgbCells,
  sentinelNegativeResult,
  sentinelSilenceResult,
  sgrCaptureFrames,
  sgrCaptureTooSmall,
  unmeasuredCellResult,
  stackStateResult,
  decideStackOperation,
  reportsDecidedOutcome,
  unhandledSequenceVerdict,
  UNHANDLED_OSC_CONTROL_TITLE,
  type StackReading,
} from "./helpers.ts"
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
import { evidenceRuntimeIdentity } from "./runtime-identity.ts"

// The OSC 7/9 public-interface census qualifies these exact sources, not every
// version carrying the same backend name. Real readers take precedence at each caller.
export function hasAuditedOscInterfaceAbsence(
  ctx: LibProbeSource,
  cohort:
    | "osc-absence"
    | "vt100-rust-d2"
    | "vterm-d2"
    | "osc-tap"
    | "ghostty-native-d2"
    | "host-effect-h4"
    | "wezterm-d2"
    | "ghostty-web-d2" = "osc-absence",
): boolean {
  const identity = ctx.runtimeIdentity
  if (cohort === "osc-tap") {
    // Operator Nov 5 / CTO 4ab79b2f: these are engine identities. Adapter-only
    // releases do not change the library's generic pass-through behavior.
    if (ctx.backendName === "vterm") return hasAuditedOscInterfaceAbsence(ctx, "vterm-d2")
    if (ctx.backendName === "xterm") {
      return (
        identity?.kind === "js" &&
        identity.runtimeFormat === "js" &&
        identity.engineVersion === "6.0.0" &&
        identity.integrity.kind === "registry" &&
        identity.integrity.lockIntegrity ===
          "sha512-5Yj1QINYCyzrZtf8OFIHi47iQtI+0qYFPHmouEfG8dHNxbZ9Tb9YGSuLcsEwj9Z+OL75GJqPyJbyoFer80a2Hw=="
      )
    }
    return false
  }
  if (cohort === "ghostty-web-d2") {
    // CTO 8be19f1f: the web build is a different engine from Ghostty native, so it carries its own
    // gate. WASM binary and vendored tree together, because either alone admits another build.
    // Values measured 2026-11-06 from the natural run under root 656126a2117 and from the
    // collector read. The previous pair appears in no live run, so the gate could not fire (#32443).
    return (
      ctx.backendName === "ghostty" &&
      identity?.kind === "js" &&
      identity.runtimeFormat === "wasm" &&
      identity.engineVersion === "0.4.0" &&
      identity.loadedBinary.sha256 === "aaf8ce18ad92e98b1233d85b5f71043aceccf3abbc75dea07e1c704cd3ae690a" &&
      identity.integrity.kind === "source" &&
      identity.integrity.repository === "git@github.com:beorn/termless.git" &&
      identity.integrity.treeOid === "5b2708cb4ee7b99b0a80c8970ec13c7ac673cbe4" &&
      identity.integrity.cleanTree
    )
  }
  if (cohort === "ghostty-native-d2") {
    return (
      ctx.backendName === "ghostty-native" &&
      identity?.kind === "native" &&
      identity.engineVersion === "1.3.1" &&
      identity.provenance.sourceCommit === "332b2aefc6e72d363aa93ab6ecfc86eeeeb5ed28" &&
      identity.provenance.lockSha256 === "3ec775507556db01d08055836b26183f629a9cbb0b5802a1566661e95988d74a"
    )
  }
  if (cohort === "host-effect-h4") {
    if (identity?.kind !== "native") return false
    if (ctx.backendName === "ghostty-native") {
      return (
        identity.engineVersion === "1.3.1" &&
        identity.loadedBinary.sha256 === "263e32f284d2399fda5e99df5bea125ed6248979516d309b15f3fd7dbbe836dd" &&
        identity.provenance.sourceCommit === "332b2aefc6e72d363aa93ab6ecfc86eeeeb5ed28" &&
        identity.provenance.lockSha256 === "3ec775507556db01d08055836b26183f629a9cbb0b5802a1566661e95988d74a" &&
        auditedAdapterSources(identity, "ghosttyNativeH4")
      )
    }
    return (
      ctx.backendName === "kitty" &&
      identity.engineVersion === "0.49.2" &&
      identity.loadedBinary.sha256 === "bb65c2d57e56eecca8143d73771432cf7dd386bccd36ae658950e5923a661886" &&
      identity.provenance.sourceCommit === "b2cb871254fbdac19a085188813c8dfb258b95cd" &&
      auditedAdapterSources(identity, "kittyH4")
    )
  }
  if (cohort === "wezterm-d2") {
    return (
      ctx.backendName === "wezterm" &&
      identity?.kind === "native" &&
      identity.engineVersion === "0.1.0-fork.5" &&
      identity.provenance.lockSha256 === "69f92e2bb6cf16b891ba30b213958c34e17c84ee57fa96b42e02e7e477218d58" &&
      ((identity.loadedBinary.sha256 === "4753e20984ab7e15ea7ef8d4ddf9bd11237f79146087939e9c37771aaadbf186" &&
        identity.provenance.sourceCommit === "f8f48853438f5fb6c43abbbb081162506d14f167" &&
        (auditedAdapterSources(identity, "wezterm") || auditedAdapterSources(identity, "wezterm0110"))) ||
        (identity.loadedBinary.sha256 === "74adefb8d3579e58480130efa7672b6c3d2d9006aa2f897bde52791ccf7c1eeb" &&
          identity.provenance.sourceCommit === "e4d7316cd1f187be48f3c44087e60dad0f785159" &&
          auditedAdapterSources(identity, "weztermSemanticCells")))
    )
  }
  if (cohort === "vt100-rust-d2") {
    return (
      ctx.backendName === "vt100-rust" &&
      identity?.kind === "native" &&
      identity.engineVersion === "0.16.2" &&
      identity.loadedBinary.sha256 === "72855b1d5462ac4c168d6c2f4a6252ab0bbfbd8682bcd68c732521ed1f4e661c" &&
      identity.provenance.sourceCommit === "3a0bcc0f615cc22d64ea6b756026521d697f0c61" &&
      identity.provenance.lockSha256 === "4cf037e4efa648ca41d08b30ef5c4ce7ada29ad61fcad45a7d1aa97bf55391c6" &&
      auditedAdapterSources(identity, "vt100RustDdabecd4")
    )
  }
  if (cohort === "vterm-d2") {
    return (
      ctx.backendName === "vterm" &&
      identity?.kind === "js" &&
      identity.runtimeFormat === "js" &&
      identity.engineVersion === "0.13.1" &&
      identity.integrity.kind === "source" &&
      identity.integrity.cleanTree &&
      identity.integrity.repository === "git@github.com:beorn/vterm.git" &&
      identity.integrity.treeOid === "3d58d29a8265aafd928e0736dde6723e2bac2007"
    )
  }
  if (identity?.kind === "native") {
    return (
      identity.engineVersion === "0.26.0" &&
      identity.provenance.lockSha256 === "1f89f2579b7d786a116d8fefb8267c4af076bd3a3893adcf14b00c4466740497" &&
      identity.provenance.sourceCommit === "6e497eb0310dd6747dfce240fc241e12c07d0615" &&
      (auditedAdapterSources(identity, "alacritty23b6874c") || auditedAdapterSources(identity, "alacritty0110"))
    )
  }
  if (
    !identity ||
    identity.kind !== "js" ||
    identity.runtimeFormat !== "js" ||
    identity.integrity.kind !== "source" ||
    !identity.integrity.cleanTree ||
    identity.integrity.repository !== "git@github.com:beorn/vterm.git"
  ) {
    return false
  }
  const tree = identity.integrity.treeOid
  return (
    (identity.engineVersion === "0.10.1" &&
      (tree === "8e082c695f238ec87dd22a496b836e5b1ef56458" ||
        tree === "c7c4dd7c37882a37ae336490eb42ef784c0b7045" ||
        tree === "4c946bbce73a95093ed16bab183b17032c622e21")) ||
    (identity.engineVersion === "0.11.0" &&
      (tree === "72b03cdc69980e98fe83eb9ecd51a5b01bbc4ccb" || tree === "6b22dcb3365f8ee2045c5cdb5fc0b4f41990ee1d")) ||
    (identity.engineVersion === "0.12.0" &&
      (tree === "5486c34f7fc6bbd10284ea68a504eec2c38a061f" || tree === "dee664e0e0554a5465a0c78cf760f437a360b0f2")) ||
    (identity.engineVersion === "0.13.0" &&
      (tree === "2a2536134a2a45982cfd27f892fe71e5078a8730" || tree === "96b1a890bf64164af924b48e7d84d3d5f6e91617")) ||
    (identity.engineVersion === "0.13.1" &&
      (tree === "d0e3d3fe4e893b70bd3f7d95725b4e10c1f6d99d" || tree === "5162719d063ab59d2905d588df3e127d38b110d1"))
  )
}

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
    if (raw === "") return replyFailure(note)
    return { pass: false, note, tests: [{ id: "criterion", status: "probe-invalid", reason: note }] }
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
    tests: [{ id: "criterion", status: "probe-invalid", reason: note }],
  }
}

/**
 * Live's reading of one OSC query outcome. A library probe source on a proven reply path offers the same
 * outcome through `queryWithSentinelOutcome` (#30554), so both arms read through here.
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
        status: "probe-todo",
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
    tests: [{ id: "criterion", status: "probe-todo", reason: note }],
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
      tests: [{ id: "criterion", status: "probe-invalid", reason: note }],
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

/** Live's reading of one Sixel geometry outcome, shared by both arms (#30554). */
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
  // parameter read that documented failure as a malformed geometry.
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
      tests: [{ id: "criterion", status: "probe-invalid", reason: note }],
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
              : observedHostCause(ctx, result, "color-request", hostInput, querySeq, raw === "")
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
            if (ctx.backendName === "alacritty" && hasAuditedOscInterfaceAbsence(ctx)) {
              return answer(
                declaredUntestableResult(
                  "Untestable: Alacritty keeps no starting colour. Its public colour table holds nothing until a colour is set. Setting one works, so this limit is only about the starting value.",
                  state,
                ),
              )
            }
            return answer(
              colorReadbackReviewResult(
                `Open: the colour query (OSC ${slot}) got no answer before setting a colour or after resetting it. The set-colour control did work, but it cannot show the original default`,
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

function noColorSetupResult(
  ctx: LibProbeSource,
  sequence: string,
  setCode: number,
  query: TerminalQueryOutcome | undefined,
  result: ProbeCallbackResult,
): ProbeCallbackResult {
  const code = /^\x1b\](\d+)/.exec(sequence)?.[1]
  const reported =
    code && UNHANDLED_REPORT_COLOUR_RESETS.includes(code) ? unhandledOscReportResult(ctx, sequence, result) : result
  if (reportsDecidedOutcome(reported) || !query || !sentinelSilenceResult(query, `OSC ${setCode} colour setup`)) {
    return reported
  }
  // A duplicate or otherwise unqualified report is still a report, not absent setup.
  if (ctx.getUnhandledSequences) {
    ctx.feed(sequence)
    if (ctx.getUnhandledSequences().some((entry) => entry.kind === "osc" && entry.code === code)) return reported
  }
  return declaredUntestableResult(
    `Untestable (no setup): OSC ${setCode} colour setup does not work on this library, so this command has nothing to act on.`,
    { query, body: reported.response },
  )
}

/**
 * A highlight-colour RESET decides only against the colour the run started from — "the default" is
 * not a known constant. So: query the initial value, set a known colour and confirm the terminal
 * reports it, write the reset, query again, and compare that reading with the initial one. The
 * initial value is restored from a finally, so the run leaves the slot as it found it. A silent
 * initial read is inconclusive: without it a reset has nothing to be compared against. The set colour
 * is chosen to differ from the observed initial one, so a terminal that starts on the usual test
 * value still gets an observable change to check the reset against.
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
    const r = match[1]
    const g = match[2]
    const b = match[3]
    if (r === undefined || g === undefined || b === undefined) return { reply, colour: null }
    return { reply, colour: { raw: match[0] ?? "", rgb: `${r}/${g}/${b}` } }
  }
  const inconclusive = (note: string, reply?: TerminalQueryOutcome): ProbeCallbackResult => ({
    ...(reply?.raw === "" ? replyFailure(note) : {}),
    pass: false,
    note: undefined,
    tests: [{ id: "criterion", status: "probe-invalid", reason: note }] as [
      { id: string; status: "probe-invalid"; reason: string },
    ],
  })
  const body = async (ctx: TermProbeSource): Promise<ProbeCallbackResult> => {
    const initialRead = await read(ctx)
    const initial = initialRead.colour
    if (!initial) {
      if (initialRead.reply.reason === "sentinel") {
        return {
          pass: false,
          response: JSON.stringify({ query: querySeq, initialSentinel: initialRead.reply }),
          tests: [
            {
              id: "criterion",
              status: "probe-todo",
              reason: `Open: the highlight-colour query (OSC ${setCode}) got no reply, though the control did. A silent highlight query says nothing about whether the reset works.`,
            },
          ],
        }
      }
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
  }
  return {
    ...probe(id, colorResetProbe(id, setCode, resetCode), body, "query_reply"),
    // The callback mutates the highlight slot, so the collector must hold a disposable receipt:
    // the same classification the OSC 10-14 reset probes carry.
    termNeedsDisposable: true,
    // For OSC 17/19 the lib arm is query-reply only: its parser-state branch serves OSC 13/14 alone.
    // The declaration stays undeclared under #28801 (@cto batch8 item 6: comment, not a new API).
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
            // #32246: a zero geometry reply has no same-path control in this run, so it stays PROBE TODO.
            if (zeroGeometry && result.observation?.outcome === "inconclusive") {
              return notTestedResult(NO_SAME_PATH_CONTROL, { query: query, raw })
            }
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
  const body = (ctx: LibProbeSource): ProbeCallbackResult => {
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
      const review = (reason: string) => colorReadbackReviewResult(`OSC ${resetCode}: ${reason}`, state)
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
      if (silence && !hostColorSlot && !highlightColorSlot) {
        return noColorSetupResult(
          ctx,
          `\x1b]${resetCode}\x07`,
          setCode,
          initialSentinel,
          colorReadbackReviewResult(
            `Open: the colour query (OSC ${setCode}) got no answer, though the reply control came back. The query is silent and the reset itself stays unseen`,
            { query, initialSentinel },
          ),
        )
      }
    }
    const originalRaw = silence ? "" : ctx.feedCapture(query)
    const original = replyPattern.exec(originalRaw)?.[1]
    if (!original) {
      if (highlightColorSlot) {
        if (originalRaw === "" && !silence) {
          return notTestedResult(NO_SAME_PATH_CONTROL, { query, originalRaw, initialSentinel })
        }
        // An unanswered initial colour query is a missing prerequisite reading: PROBE TODO. Bytes that arrived but do
        // not parse are data the probe cannot trust: PROBE INVALID (@cto 0db5ad54 refined rule 4, #32246).
        const note = `OSC ${setCode} initial highlight colour was not read back, so OSC ${resetCode} cannot be compared with it`
        if (originalRaw === "" && initialSentinel?.reason === "sentinel") {
          return noColorSetupResult(ctx, `\x1b]${resetCode}\x07`, setCode, initialSentinel, {
            pass: false,
            response: JSON.stringify({ query, originalRaw, initialSentinel }),
            tests: [
              {
                id: "criterion",
                status: "probe-todo",
                reason: `Open: the highlight-colour query (OSC ${setCode}) got no reply, though the control did. A silent highlight query says nothing about whether the reset works.`,
              },
            ],
          })
        }
        return {
          pass: false,
          note: undefined,
          response: JSON.stringify({ query, originalRaw, initialSentinel }),
          tests: [
            {
              id: "criterion",
              status: originalRaw === "" ? "probe-todo" : "probe-invalid",
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
            return notTestedResult(
              `Open: our test cannot read the mouse pointer colour (OSC ${setCode}). On this library it can only read text, background and cursor colours.`,
              { query, originalRaw, defaultColors: ctx.getDefaultColors() },
            )
          }
          return colorReadbackReviewResult(
            `OSC ${setCode} colour query before OSC ${resetCode} answered nothing, so the reset effect cannot be read back`,
            { query, originalRaw },
          )
        }
        const answer = (result: ProbeCallbackResult) =>
          observedHostCause(ctx, result, "color-request", hostInput, query, true)
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
        const state = { query, originalRaw, controls, ...(indexed && { cells }), ...(silence && { initialSentinel }) }
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
            colorReadbackReviewResult("OSC 104 post-reset indexed readings are missing or contradictory", state),
          )
        }
        if (control.verified && resetRaw === "" && restoredRaw === "") {
          return answer(
            colorReadbackReviewResult(
              `Open: setting a colour worked, but our adapter cannot read back the default after the reset (OSC ${resetCode}), leaving the reset itself unseen`,
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
                `OSC ${resetCode}: reset produced neither the baseline nor the verified seed`,
                state,
              ),
            )
          }
          return answer(
            index === undefined
              ? noColorSetupResult(
                  ctx,
                  reset,
                  setCode,
                  initialSentinel,
                  colorReadbackReviewResult(
                    `Open: the colour query (OSC ${setCode}) did not confirm the colour we set, leaving the reset (OSC ${resetCode}) with no verified setup`,
                    state,
                  ),
                )
              : colorReadbackReviewResult(
                  `Open: the colour query (OSC ${setCode}) did not confirm the colour we set, leaving the reset (OSC ${resetCode}) with no verified setup`,
                  state,
                ),
          )
        }
        if (control.setterRaw === "" && control.seededRaw === "" && resetRaw === "" && restoredRaw === "") {
          return answer(
            colorReadbackReviewResult(
              `Open: the colour query (OSC ${setCode}) got no answer before or after we set a colour, and no reply control worked in this test. The reset stays unseen`,
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
  return (ctx) => {
    const result = body(ctx)
    // Case 1 names the ledger's eight colour-reset cells (2a adds 104, 110, 111, 112); every other reset keeps its own body.
    if (isDeclaredUntestable(result) || !UNHANDLED_REPORT_COLOUR_RESETS.includes(String(resetCode))) return result
    const reset = `\x1b]${resetCode}${index === undefined ? "" : `;${index}`}\x07`
    return unhandledOscReportResult(ctx, reset, result)
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
 * mutation is confined to that disposable machine or process; a failed restore is recorded, never retried into a pass.
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
    if (before.outcome.reason === "sentinel") {
      return notTestedResult(
        `Open: the colour query (OSC ${spec.setCode}) got no answer, though the reply control came back. The query is silent and the reset itself stays unseen`,
        { query, initialReadback: before.outcome },
      )
    }
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
 * Per-operation colour-stack decision (#31904, @cto 6e4f7300). The POP fixture (set A, push, set B,
 * pop) and the PUSH fixture (set A, set B, push, set C, pop) both run; none of A, B or C is the
 * foreground the run started with. A set the reply does not show leaves the stack unobservable: a
 * coverage record (PROBE TODO, null review), never a negative, as the palette arm treats a failed
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
  const stackDecision = decideStackOperation(operation, pop, push)
  return stackStateResult(stackDecision, expected, { ...state, pop, push }, "query_reply")
}

/**
 * A former source-negative site (#32246, @cto 9fad23d7): feed the sequence and an X sentinel at home and keep both, but
 * no control in this run shows the same path can report the effect, so the cell stays PROBE TODO.
 */
function noSamePathControl(sequence: string) {
  return (ctx: LibProbeSource): ProbeCallbackResult => {
    const fed = "\x1b[1;1H\x1b[2K" + sequence + "X"
    ctx.feed(fed)
    return notTestedResult(NO_SAME_PATH_CONTROL, { fed, sentinel: ctx.getCell(0, 0) })
  }
}

type ParsedToast = { title: string | null; body: string }
type ToastStep = { write: string; before: number; added: ParsedToast[] | null }

/**
 * Check one OSC toast family through the engine's parsed-toast store (@cto 3cc4a3ae, #32272). The store does not say
 * which OSC made a toast, so each step feeds one sequence and reads only what it added: the current family's no-toast
 * control must add nothing, the other family's toast (the cross control) must add exactly itself, and the current feed
 * must add exactly one verbatim toast. Unsupported needs the cross control; without it the cell stays PROBE TODO.
 */
function parsedToastResult(
  ctx: LibProbeSource,
  readToasts: NonNullable<LibProbeSource["getToasts"]>,
  family: {
    label: string
    noToast: string
    cross: { write: string; matches(toast: ParsedToast): boolean }
    graded: { write: string; matches(toast: ParsedToast): boolean }
    expected: string
  },
): ProbeCallbackResult {
  const read = () => readToasts.call(ctx).map((toast) => ({ title: toast.title, body: toast.body }))
  const step = (write: string): ToastStep => {
    const before = read()
    ctx.feed(write)
    const after = read()
    // Entries already stored must stay as they were; a rewritten list adds nothing attributable to this feed.
    const kept = JSON.stringify(after.slice(0, before.length)) === JSON.stringify(before)
    return { write, before: before.length, added: kept ? after.slice(before.length) : null }
  }
  const addsOnly = (result: ToastStep, matches: (toast: ParsedToast) => boolean) => {
    const [toast, ...rest] = result.added ?? []
    return toast !== undefined && rest.length === 0 && matches(toast)
  }
  const noToast = step(family.noToast)
  if (noToast.added?.length !== 0) {
    return notTestedResult(
      `${NO_SAME_PATH_CONTROL}: ${family.label} no-toast control changed the toast store; this reader is not shown to add only toasts`,
      { noToast },
    )
  }
  const cross = step(family.cross.write)
  const toastStep = step(family.graded.write)
  const pass = addsOnly(toastStep, family.graded.matches)
  const state = { noToast, cross, graded: toastStep }
  if (!pass && !addsOnly(cross, family.cross.matches)) {
    return notTestedResult(
      `${NO_SAME_PATH_CONTROL}: ${family.label} cross control did not add exactly its own toast; this reader is not shown to observe toasts`,
      state,
    )
  }
  return parserStateResult(
    pass,
    family.expected,
    state,
    "Measures the engine's parsed-toast store, not OS notification delivery",
  )
}

/** A source exposing both icon-label and title readers takes the controlled buffer-state read. */
function readsIconTitleState(
  source: Pick<LibProbeSource, "runtimeIdentity" | "getTitle" | "getIconLabel">,
): source is Pick<LibProbeSource, "runtimeIdentity" | "getTitle" | "getIconLabel"> & { getIconLabel(): string } {
  return typeof source.getTitle === "function" && typeof source.getIconLabel === "function"
}

/**
 * Record the measured cause of an empty reply to a host-owned query on a native artifact: this run captured the
 * empty target response while the collector supplied no such host input. It is an observation, never a source
 * citation, and it does not change the callback result (#32246).
 */
function observedHostCause(
  ctx: LibProbeSource,
  result: ProbeCallbackResult,
  recipe: HostRecipeName,
  missing: HostInputName,
  query: string,
  empty: boolean,
): ProbeCallbackResult {
  if (!empty || ctx.runtimeIdentity?.kind !== "native") return result
  const claim: CallbackHostRecipeCause = { recipe, cause: { kind: "observed", missing, query } }
  return { ...result, hostRecipeCauses: [...(result.hostRecipeCauses ?? []), claim] }
}

/**
 * A former native host-audit site (#32246): an empty clipboard reply on a native artifact has no same-path control in
 * this run, so it stays PROBE TODO with its capture and its observed cause, never a source-cited cause.
 */
function emptyNativeHostReply(
  ctx: LibProbeSource,
  result: ProbeCallbackResult,
  query: string,
  empty: boolean,
): ProbeCallbackResult {
  if (!empty || ctx.runtimeIdentity?.kind !== "native") return result
  // A pass observed independently of the silent read (the engine's retained OSC 52 write) keeps its observed outcome.
  return observedHostCause(
    ctx,
    result.pass || result.notTested
      ? result
      : notTestedResult(NO_SAME_PATH_CONTROL, { query, response: result.response ?? "" }),
    "clipboard-load",
    "clipboard-read-permission",
    query,
    true,
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
    tests: [{ id: "criterion", status: consumed === null ? "probe-invalid" : "probe-todo", reason: note }],
  }
}

/** CTO54bf1c9c — Cwd-only metadata, qualified by two same-run OSC7 readbacks. */
function promptCwdPropertyResult(ctx: LibProbeSource): ProbeCallbackResult {
  if (!ctx.getCwd) {
    const reason =
      "Open: our adapter for this library cannot read back the shell properties a shell sends (OSC 633 P, used by VS Code) yet."
    return {
      ...parserStateResult(null, "OSC633 P Cwd property readback", {}, reason),
      tests: [{ id: "criterion", status: "probe-todo", reason }],
    }
  }
  const read = ctx.getCwd.bind(ctx)
  const path = (value: string | null) =>
    value?.startsWith("file:") ? decodeURIComponent(new URL(value).pathname) : value
  const before = read()
  let current = path(before)
  const state = {
    before,
    controls: [] as { sent: string; raw: string | null; value: string | null }[],
    targets: [] as { sent: string; before: string | null; raw: string | null; value: string | null }[],
    restored: before,
  }
  let qualified = false
  try {
    for (const sent of ["/terminfo-osc7-control-A", "/terminfo-osc7-control-B"]) {
      ctx.feed(`\x1b]7;file://localhost${sent}\x07`)
      const raw = read()
      current = path(raw)
      state.controls.push({ sent, raw, value: current })
    }
    qualified = state.controls.every(({ sent, value }) => sent === value)
    if (qualified) {
      for (const sent of ["/terminfo-633-cwd-A", "/terminfo-633-cwd-B"]) {
        const prior = current
        ctx.feed(`\x1b]633;P;Cwd=${sent}\x07`)
        const raw = read()
        current = path(raw)
        state.targets.push({ sent, before: prior, raw, value: current })
      }
    }
  } finally {
    ctx.feed(`\x1b]7;${before ?? ""}\x07`)
  }
  state.restored = read()
  const restored = path(state.restored) === path(before)
  const supported = qualified && state.targets.every(({ sent, value }) => sent === value)
  const unsupported = qualified && state.targets.every(({ before: prior, value }) => prior === value)
  const inert = !qualified && state.controls.every(({ value }) => value === path(before))
  const failed = !restored || (!inert && !supported && !unsupported)
  const expected = "Two distinct OSC633 P Cwd paths match the qualified reader, or both leave it unchanged"
  const result = parserStateResult(
    failed || inert ? null : supported,
    expected,
    state,
    inert ? "Cwd reader is inert to two distinct OSC7 controls" : undefined,
  )
  if (inert) {
    result.tests = [
      { id: "criterion", status: "probe-todo", reason: "Cwd reader is inert to two distinct OSC7 controls" },
    ]
  }
  if (failed) {
    result.observation = {
      outcome: "error",
      reason: "invalid-reply",
      assertionType: "buffer_state",
      note: "Cwd control, target or restored readback did not match its expected path",
    }
  }
  return result
}

function semanticCellResult(ctx: LibProbeSource, target: "A" | "B" | "C" | "P"): ProbeCallbackResult {
  const read = ctx.getCellSemanticType?.bind(ctx)
  if (!read) throw new Error(`${ctx.backendName} declares semantic-cells without getCellSemanticType`)
  if (ctx.cols < 8) return notTestedResult("semantic-cell readback requires eight columns", { cols: ctx.cols })
  ctx.reset()
  ctx.feed("\x1b[1;1H0")
  const seed = { char: ctx.getCell(0, 0).char, type: read(0, 0) }
  type CellType = ReturnType<typeof read>
  const steps: { letter: string; before: CellType; after: CellType; char: string; cursor: { x: number; y: number } }[] =
    []
  let before = seed.type
  for (const [index, letter] of (["A", "Z", "B", "Z", "C", "P"] as const).entries()) {
    // A may start a fresh line. Place the witness explicitly after the mark;
    // cursor movement must not be mistaken for a missing semantic cell.
    ctx.feed(`\x1b]133;${letter}\x07\x1b[1;${index + 2}HX`)
    const after = read(0, index + 1)
    const cursor = ctx.getCursor()
    steps.push({ letter, before, after, char: ctx.getCell(0, index + 1).char, cursor: { x: cursor.x, y: cursor.y } })
    before = after
  }
  const retained = [read(0, 0), ...steps.map((_, index) => read(0, index + 1))]
  const state = { target, seed, steps, retained }
  const consumed =
    seed.char === "0" &&
    steps.every((step, index) => step.char === "X" && step.cursor.x === index + 2 && step.cursor.y === 0)
  const stable = retained[0] === seed.type && steps.every((step, index) => retained[index + 1] === step.after)
  const unknownsInert = steps.filter((step) => step.letter === "Z").every((step) => step.after === step.before)
  if (!consumed || seed.type !== "output" || !stable || !unknownsInert) {
    return notTestedResult("semantic-cell text, stored-type or unknown-letter controls did not qualify", state)
  }
  const expected = { A: "prompt", B: "input", C: "output", P: "prompt" } as const
  const selected = steps.find((step) => step.letter === target)
  if (!selected) throw new Error(`Missing semantic-cell target ${target}`)
  if (selected.before !== expected[target] && selected.after === expected[target]) {
    return parserStateResult(true, `OSC133 ${target} changes the stored cell type; unknown Z keeps it`, state)
  }
  const anotherMoves = steps.some(
    (step) =>
      step.letter !== target &&
      step.letter !== "Z" &&
      step.after !== step.before &&
      step.after === expected[step.letter as keyof typeof expected],
  )
  if (selected.before !== expected[target] && selected.after === selected.before && anotherMoves) {
    return parserStateResult(
      false,
      `OSC133 ${target} changes the stored cell type; other handled letters move it`,
      state,
    )
  }
  return notTestedResult(`OSC133 ${target} cell-type transition lacks a deciding same-run control`, state)
}

/**
 * C154 — a consumed semantic prompt mark proves consumption, not that the mark registered.
 * Read the measured home / target / control sequence from the real cursor and cell state so a
 * provider that answers a constant cursor position cannot satisfy all three positions; only a
 * qualified sequence can witness new start markers through an exposed reader. Without one it
 * retains the applicable named review. A consumed-but-unqualified read, and a missing cell, stay
 * a real consumption observation — never not-tested.
 */
function promptMarkBody(
  ctx: LibProbeSource,
  sequence: string,
  noObservable: string,
  sourceReview?: { probeId: string; selector: number | "133;D"; markType?: "prompt" | "command" | "output" },
): ProbeCallbackResult {
  if (ctx.capabilities.extensions.has("semantic-cells")) {
    switch (sourceReview?.probeId) {
      case "extensions.osc133-a":
        return semanticCellResult(ctx, "A")
      case "extensions.osc133-b":
        return semanticCellResult(ctx, "B")
      case "extensions.osc133-c":
        return semanticCellResult(ctx, "C")
      case "extensions.osc133-p":
        return semanticCellResult(ctx, "P")
    }
  }
  ctx.feed("\x1b[1;1H")
  if (ctx.backendName === "kitty" && sourceReview?.probeId === "extensions.semantic-prompts") {
    const declared =
      ctx.capabilities.extensions.has("semantic-marks") && ctx.capabilities.extensions.has("semantic-command-end")
    const readMarks = declared ? ctx.getSemanticMarks?.bind(ctx) : undefined
    if (!readMarks) {
      return notTestedResult("OSC 133 lifecycle requires the declared prompt/output and command-end reader", {
        declared,
      })
    }
    const before = readMarks()
    const feeds = ["\x1b]133;A\x07", "\x1b[2;3H\x1b]133;C\x07", "\x1b]133;D;17\x07", "\x1b]133;Z\x07"] as const
    ctx.feed(feeds[0])
    const prompt = readMarks()
    ctx.feed(feeds[1])
    const output = readMarks()
    ctx.feed(feeds[2])
    const end = readMarks()
    ctx.feed(feeds[3])
    const unknown = readMarks()
    const promptMark = prompt[before.length]
    const outputMark = output[prompt.length]
    const endMark = end[output.length]
    const supported =
      prompt.length === before.length + 1 &&
      promptMark?.type === "prompt" &&
      promptMark.startRow === 0 &&
      promptMark.startCol === 0 &&
      output.length === prompt.length + 1 &&
      outputMark?.type === "output" &&
      outputMark.startRow === 1 &&
      outputMark.startCol === 2 &&
      end.length === output.length + 1 &&
      endMark?.type === "command-end" &&
      endMark.rawStatus === "17" &&
      before.every((mark, index) => JSON.stringify(mark) === JSON.stringify(prompt[index])) &&
      prompt.every((mark, index) => JSON.stringify(mark) === JSON.stringify(output[index])) &&
      output.every((mark, index) => JSON.stringify(mark) === JSON.stringify(end[index])) &&
      JSON.stringify(end) === JSON.stringify(unknown)
    const state = { feeds, before, prompt, output, end, unknown }
    ctx.feed("\x1b[1;1H")
    return supported
      ? parserStateResult(
          true,
          "OSC 133 appends prompt, output and command-end marks; an unknown letter adds nothing",
          state,
        )
      : notTestedResult(
          "OSC 133 lifecycle did not retain fresh prompt/output/end marks and an inert unknown letter",
          state,
        )
  }
  const osc633End = sourceReview?.probeId === "extensions.osc633-d"
  const home = ctx.getCursor()
  const markType = sourceReview?.markType
  const commandEnd = sourceReview?.selector === "133;D" || osc633End
  const readerKey = markType ? "semantic-marks" : commandEnd ? "semantic-command-end" : undefined
  const declared = readerKey !== undefined && ctx.capabilities.extensions.has(readerKey)
  const readMarks = declared ? ctx.getSemanticMarks?.bind(ctx) : undefined
  const kittyInput = ctx.backendName === "kitty" && sourceReview?.probeId === "extensions.osc133-b"
  const controlMarkType = kittyInput ? "prompt" : markType
  if (osc633End && !readMarks) {
    const reason = 'Open: our adapter for this library cannot read the shell\'s "command finished" mark.'
    return {
      ...parserStateResult(null, "OSC633 D command-end status readback", {}, reason),
      tests: [{ id: "criterion", status: "probe-todo", reason }],
    }
  }
  const endControl =
    readMarks && (osc633End || commandEnd || markType)
      ? (() => {
          const before = readMarks()
          const namespace = kittyInput
            ? 133
            : osc633End || sourceReview?.selector === 633 || sourceReview?.probeId === "extensions.osc133-p"
              ? 133
              : 633
          const selector = commandEnd
            ? "D"
            : controlMarkType === "prompt"
              ? "A"
              : controlMarkType === "command"
                ? "B"
                : "C"
          ctx.feed(`\x1b]${namespace};${selector}${commandEnd ? ";0" : ""}\x07`)
          const first = readMarks()
          if (kittyInput) ctx.feed("\x1b[2;3H")
          ctx.feed(`\x1b]${namespace};${selector}${commandEnd ? ";17" : ""}\x07`)
          const second = readMarks()
          if (kittyInput) ctx.feed("\x1b[1;1H")
          return { before, first, second, ...(kittyInput && { feeds: ["\x1b]133;A\x07", "\x1b[2;3H\x1b]133;A\x07"] }) }
        })()
      : undefined
  let readerQualified = false
  if (endControl) {
    const { before, first, second } = endControl
    const firstControl = first[before.length]
    const secondControl = second[first.length]
    const qualified =
      first.length === before.length + 1 &&
      second.length === first.length + 1 &&
      firstControl?.type === (commandEnd ? "command-end" : controlMarkType) &&
      secondControl?.type === (commandEnd ? "command-end" : controlMarkType) &&
      (!kittyInput ||
        (firstControl?.type === "prompt" &&
          firstControl.startRow === 0 &&
          firstControl.startCol === 0 &&
          secondControl?.type === "prompt" &&
          secondControl.startRow === 1 &&
          secondControl.startCol === 2)) &&
      (!commandEnd ||
        (firstControl?.type === "command-end" &&
          firstControl.rawStatus === "0" &&
          secondControl?.type === "command-end" &&
          secondControl.rawStatus === "17")) &&
      before.every((mark, index) => JSON.stringify(mark) === JSON.stringify(first[index])) &&
      first.every((mark, index) => JSON.stringify(mark) === JSON.stringify(second[index]))
    readerQualified = qualified
    if (!qualified && osc633End) {
      const inert = JSON.stringify(before) === JSON.stringify(first) && JSON.stringify(first) === JSON.stringify(second)
      const result = parserStateResult(
        null,
        "OSC133 D 0 and 17 qualify the same command-end reader",
        endControl,
        "Command-end reader did not report the two OSC133 controls",
      )
      if (inert) {
        result.tests = [
          {
            id: "criterion",
            status: "probe-todo",
            reason: "Command-end reader did not report the two OSC133 controls",
          },
        ]
      }
      if (!inert) {
        result.observation = {
          outcome: "error",
          reason: "invalid-reply",
          assertionType: "buffer_state",
          note: "Command-end reader changed to an unexpected control status or altered earlier history",
        }
      }
      return result
    }
  }
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
    const secondSequence = `\x1b]${osc633End ? 633 : 133};D;17\x07`
    ctx.feed(secondSequence + "X")
    const second = readMarks()
    const secondCell = ctx.getCell(1, 2)
    const secondCursor = ctx.getCursor()
    ctx.feed("\x1b[1;1H")
    const firstMark = first[before.length]
    const secondMark = second[secondBefore.length]
    const supported =
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
      secondCursor.y === 1
    const state = {
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
      ...(endControl && { endControl }),
    }
    const result = parserStateResult(
      supported,
      "Each target feed appends exactly one command-end with its exact raw status and preserves earlier history",
      state,
    )
    if (!supported && !readerQualified) return notTestedResult(NO_SAME_PATH_CONTROL, { ...state, endControl })
    if (osc633End) {
      const unchanged =
        JSON.stringify(before) === JSON.stringify(first) &&
        JSON.stringify(first) === JSON.stringify(secondBefore) &&
        JSON.stringify(secondBefore) === JSON.stringify(second)
      const consumed = secondCell.char === "X" && secondCursor.x === 3 && secondCursor.y === 1
      if (!consumed) {
        const reason = "Second command-end target consumption was not qualified"
        return {
          ...parserStateResult(null, "Both OSC633 D target feeds have qualified screen consumption", state, reason),
          tests: [{ id: "criterion", status: "probe-todo", reason }],
        }
      }
      if (!supported && !unchanged) {
        result.observation = {
          outcome: "error",
          reason: "invalid-reply",
          assertionType: "buffer_state",
          note: "OSC633 D reader changed to the wrong status or altered earlier history",
        }
      }
    }
    return result
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
    const result = parserStateResult(
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
        endControl,
      },
    )
    if (!result.pass && !readerQualified) {
      return notTestedResult(NO_SAME_PATH_CONTROL, { endControl, observed: result.response })
    }
    if (
      kittyInput &&
      !result.pass &&
      (JSON.stringify(before) !== JSON.stringify(first) ||
        JSON.stringify(first) !== JSON.stringify(secondBefore) ||
        JSON.stringify(secondBefore) !== JSON.stringify(second))
    ) {
      return notTestedResult("OSC 133 B changed the semantic reader without the requested input mark", {
        endControl,
        observed: result.response,
      })
    }
    return result
  }
  if (declared) {
    const note = `${noObservable}: ${readerKey} getSemanticMarks readback is unavailable`
    return reviewResult(HEADLESS_OBSERVABLE_REVIEW, `${note}, so this run cannot decide it`, note, {
      home,
      target,
      control,
      cell: cell.char,
      declared: true,
    })
  }
  return reviewResult(
    SEMANTIC_PROMPT_SOURCE_REVIEW,
    readerKey === undefined
      ? "Open: the library did not print the shell property and command-line marks (OSC 133 P, 633 E) as text, but our test cannot read them back."
      : "Open: the shell's prompt mark (OSC 133 / 633) did not show up on screen as stray text, but our test has no way to read marks back, so we cannot tell whether the library kept it.",
    readerKey === undefined ? noObservable : NO_SAME_PATH_CONTROL,
    { home, target, control, cell: cell.char },
  )
}

/**
 * The Case 1 colour-reset cells (@cto 2026-11-05 07:25 appendix: "up to 8 colour reset (4 each)"), the
 * ledger's `colour reset` group. Every other reset code keeps its own body's outcome.
 */
const UNHANDLED_REPORT_COLOUR_RESETS: readonly string[] = ["104", "110", "111", "112", "113", "114", "117", "119"]

/**
 * Case 1 consumer, OSC arm (@cto 2026-11-05 07:25 appendix, conditions 3 and 5): the library's own
 * unhandled report decides a state cell Unsupported only where the body left the cell undecided, and
 * only when the same run shows a handled OSC 2 adding no report entry while the title reader reports
 * it applied, then the target adding exactly one entry carrying its number. A decided outcome is
 * returned untouched, and a source without the member keeps today's exact path.
 *
 * Case 2 (@cto 09:00 plan ruling R1): an engine that handles no OSC — VT100.js, VT220.js — reports the
 * OSC 2 control as an ignored entry and never sets the title. That same run is the proof that its OSC
 * path reports and handles nothing, so SGR 1 with a bold cell may qualify the control instead, with the
 * fallback reading its own baseline.
 */
export function unhandledOscReportResult(
  ctx: LibProbeSource,
  sequence: string,
  result: ProbeCallbackResult,
): ProbeCallbackResult {
  if (reportsDecidedOutcome(result)) return result
  const code = /^\x1b\](\d+)/.exec(sequence)?.[1]
  if (code === undefined) return result
  return (
    unhandledSequenceVerdict(
      ctx,
      { feed: sequence, code: { kind: "osc", code } },
      {
        feed: `\x1b]2;${UNHANDLED_OSC_CONTROL_TITLE}\x07`,
        applied: () => ctx.getTitle() === UNHANDLED_OSC_CONTROL_TITLE,
      },
      { sequence, ...(result.response !== undefined && { body: result.response }) },
      {
        // The control feed above is OSC 2, so its own ignored entry is this code.
        proves: { kind: "osc", code: "2" },
        arm: () => {
          // Read the cell this control paints only when the fallback is actually reached.
          const cursor = ctx.getCursor()
          return {
            feed: "\x1b[0m\x1b[1mC",
            applied: () => ctx.getCell(cursor.y, cursor.x).bold === true,
            cleanup: "\x1b[0m",
          }
        },
      },
    ) ?? result
  )
}

/** The OSC 133 / 633 shell marks, through the report arm above. */
function promptMarkResult(
  ctx: LibProbeSource,
  sequence: string,
  noObservable: string,
  sourceReview?: { probeId: string; selector: number | "133;D"; markType?: "prompt" | "command" | "output" },
): ProbeCallbackResult {
  return unhandledOscReportResult(ctx, sequence, promptMarkBody(ctx, sequence, noObservable, sourceReview))
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
          status: "probe-todo",
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
  return { pass: false, note, tests: [{ id: "criterion", status: "probe-invalid", reason: note }] }
}

function colorStackProbe(ownSequence: typeof colorPush | typeof colorPop): ProbeDefinition["lib"] {
  const body: ProbeDefinition["lib"] = (ctx) => {
    const operation = ownSequence === colorPush ? "push" : "pop"
    let initialReadback: TerminalQueryOutcome | undefined
    if (ctx.queryWithSentinelOutcome) {
      initialReadback = ctx.queryWithSentinelOutcome(foregroundQuery, foregroundReply)
      if (
        sentinelSilenceResult(initialReadback, "Complete OSC 10 foreground color reply") &&
        ctx.runtimeIdentity?.kind !== "native"
      ) {
        return noColorSetupResult(
          ctx,
          ownSequence,
          10,
          initialReadback,
          colorReadbackReviewResult(
            "Open: the text-colour query (OSC 10) got no answer, leaving saving and restoring colours unseen",
            {
              query: foregroundQuery,
              initialReadback,
            },
          ),
        )
      }
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
        tests: [{ id: "criterion", status: "probe-invalid", reason: note }],
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
            result = colorReadbackReviewResult(
              "Open: the text-colour query (OSC 10) got no answer before or after we set a colour, and no reply control worked in this test. Saving and restoring colours stays unseen",
              { query: foregroundQuery, originalRaw, initialReadback, trace },
            )
          } else {
            const note = "Current-colour fixture setter or exact seeded readback was not established"
            result = { pass: false, note, tests: [{ id: "criterion", status: "probe-invalid", reason: note }] }
          }
          readbackUnavailable = true
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
        return { pass: false, note, tests: [{ id: "criterion", status: "probe-invalid", reason: note }] }
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
          : result?.tests?.some((test) => test.status === "probe-invalid")
            ? result.note
            : undefined
        const note = primaryNote ? `${primaryNote}; ${cleanupNote}` : cleanupNote
        if (unexpectedlyFailed || cleanupFailures.some(({ error }) => !(error instanceof Error))) {
          throw new AggregateError(
            [
              ...(unexpectedlyFailed || result?.tests?.some((test) => test.status === "probe-invalid")
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
          result.tests = [{ id: "criterion", status: "probe-invalid", reason: note }]
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
      if (seedAttempted && result) {
        const response = JSON.stringify({
          query: foregroundQuery,
          originalRaw,
          initialReadback,
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
        const observed = observedHostCause(ctx, result, "color-request", "foreground-rgb", foregroundQuery, true)
        if (observed.hostRecipeCauses) result.hostRecipeCauses = observed.hostRecipeCauses
      }
    }
  }
  return (ctx) => unhandledOscReportResult(ctx, ownSequence, body(ctx))
}

async function colorStackTermProbe(
  ctx: Parameters<NonNullable<ProbeDefinition["term"]>>[0],
  operation: "push" | "pop",
): Promise<ProbeCallbackResult> {
  const originalReply = await ctx.queryWithSentinelOutcome(foregroundQuery, foregroundReply)
  const before = foregroundValue(originalReply.match?.[0] ?? "")
  if (!before && originalReply.reason === "sentinel") {
    return notTestedResult(
      "Open: the text-colour query (OSC 10) got no answer, leaving saving and restoring colours unseen",
      {
        query: foregroundQuery,
        initialReadback: originalReply,
      },
    )
  }
  if (!before) return unansweredQuery(originalReply, "No original OSC 10 foreground reply; color stack was not changed")
  let pushed = false
  const colors = colorStackColors(before)
  const read = async (missing: string) => {
    const reply = await ctx.queryWithSentinelOutcome(foregroundQuery, foregroundReply)
    const value = foregroundValue(reply.match?.[0] ?? "")
    if (!value && reply.reason === "sentinel") {
      return notTestedResult(`${missing}; no answered effect readback`, { query: foregroundQuery, readback: reply })
    }
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
      return productViewportAbsenceResult(ctx, declared.reason, state)
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
      const protocolDetection = kittyDetection(detection.raw)
      if (protocolDetection.kind !== "answered") {
        if (protocolDetection.kind === "absent") return kittyProtocolAbsent(detection.raw)
        const reason =
          protocolDetection.reason === "invalid-reply"
            ? "invalid-reply"
            : detection.reason === "timeout"
              ? "timeout"
              : "no-response"
        return kittyInconclusive(protocolDetection, reason, detection.raw)
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
 * Live's reading of one query outcome handled by a result callback: no matched frame is handled by unansweredQuery, a
 * matched frame through the site's result callback. A library probe source on a proven reply path offers the same
 * outcome through `queryWithSentinelOutcome` (#30554), so both arms read it here. The result callback reads only the
 * frame; the result keeps the whole read window, DA1 answer included, as the observed evidence.
 */
function matchedReplyResult(
  reply: TerminalQueryOutcome,
  missingNote: string,
  resultForFrame: (frame: string) => ProbeCallbackResult,
): ProbeCallbackResult {
  if (!reply.match) return unansweredQuery(reply, missingNote)
  return { ...resultForFrame(reply.match[0] ?? ""), response: reply.raw }
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

function kittyGraphicsRefused(response: string, code: string): ProbeCallbackResult {
  const note = `library refused the canonical graphics query: ${code}`
  return {
    pass: false,
    response,
    note,
    observation: { outcome: "unsupported", assertionType: "query_reply", note },
    assertions: [
      {
        assertionType: "query_reply" as const,
        kind: "negative",
        expected: "The canonical Kitty graphics query is acknowledged rather than refused",
        observed: response,
      },
    ],
  }
}

/** A Kitty graphics ERROR frame in this run's reply window: an explicit refusal, not an absence. */
function kittyGraphicsRefusalCode(raw: string): string | null {
  const frame = /\x1b_G[^;\x1b]*;([A-Z][A-Z0-9]{2,})\x1b\\/.exec(raw)
  return frame ? (frame[1] ?? null) : null
}

/**
 * Display cannot be observed when transmit was refused in the same run: the library answered the
 * canonical query with an error, so there is no image for the display cell to place.
 */
function kittyDisplayWithoutTransmit(code: string, imageNumber: number): ProbeCallbackResult {
  return declaredUntestableResult(
    `Untestable (no setup): Kitty graphics transmit is refused by this library (${code}), so the display cell has no image to place`,
    { imageNumber, refusal: code },
  )
}

/**
 * Live's reading of an allocation outcome, shared by both arms (#30554); the result keeps the whole read window.
 *
 * `silent` means the window answered nothing decidable — no matching reply and no refusal frame — not that the
 * collector reported one particular shape of silence. The library arm asks its canonical graphics question when
 * this is set, so keying it on `reason` would make the query count depend on whether the pass met a sentinel or a
 * timeout; fresh-instance passes disagree on that, and headless-batch's repeated-consistency guard then grades a
 * correct pair probe-invalid (32473, ghostty-native, natural run 2026-11-06T08-34).
 */
function allocationOutcomeResult(
  reply: TerminalQueryOutcome,
  imageNumber: number,
): { imageId: number | null; refusal: string | null; silent: boolean; result: ProbeCallbackResult } {
  if (!reply.match) {
    if (reply.reason === "sentinel") {
      // A refusal decides; silence does not. Only a graphics ERROR frame in the same window moves
      // this cell off "not observed", because a library that refuses the query has answered it.
      const refusal = kittyGraphicsRefusalCode(reply.raw)
      if (refusal) {
        return { imageId: null, refusal, silent: false, result: kittyGraphicsRefused(reply.raw, refusal) }
      }
      return {
        imageId: null,
        refusal: null,
        silent: true,
        result: notTestedResult(
          "Open: our test cannot see whether the library stored the image. The device reply (DA) that does come back says nothing about images.",
          {
            imageNumber,
            readback: reply,
          },
        ),
      }
    }
    return {
      imageId: null,
      refusal: null,
      silent: true,
      result: unansweredQuery(
        reply,
        "No matching image allocation reply; no image ownership or transmission conclusion",
      ),
    }
  }
  const uploaded = allocatedImageResult(reply.match[0] ?? "", imageNumber)
  return { ...uploaded, refusal: null, silent: false, result: { ...uploaded.result, response: reply.raw } }
}

function placementRequest(imageId: number): string {
  return `\x1b_Ga=p,i=${imageId},c=2,r=1,C=1\x1b\\`
}

/** Live's reading of a placement outcome, shared by both arms (#30554). */
function placementOutcomeResult(placement: TerminalQueryOutcome, imageId: number): ProbeCallbackResult {
  if (!placement.match && placement.reason === "sentinel") {
    return notTestedResult("No placement readback or image-state observation; DA1 does not observe display", {
      imageId,
      readback: placement,
    })
  }
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
    tests: [{ id: "review", status: "probe-todo", reason: `${id}: ${note}` }],
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
            // The library arm's own transfer request is a=t, and a library that answers only a=q stays
            // silent on it. When that silent read decides nothing, one same-run canonical query asks
            // whether graphics is refused at all: an ERROR frame decides, continued silence does not.
            const uploaded = allocationOutcomeResult(
              ctx.queryWithSentinelOutcome(imageTransferRequest(imageNumber), allocationReply(imageNumber)),
              imageNumber,
            )
            imageId = uploaded.imageId
            if (uploaded.silent) {
              const graphics = ctx.queryWithSentinelOutcome(GRAPHICS_QUERY, GRAPHICS_QUERY_REPLY)
              const refusal = kittyGraphicsRefusalCode(graphics.raw)
              if (refusal) {
                return display
                  ? kittyDisplayWithoutTransmit(refusal, imageNumber)
                  : kittyGraphicsRefused(graphics.raw, refusal)
              }
            }
            if (uploaded.refusal && display) {
              return kittyDisplayWithoutTransmit(uploaded.refusal, imageNumber)
            }
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
          if (uploaded.refusal && display) {
            return kittyDisplayWithoutTransmit(uploaded.refusal, imageNumber)
          }
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

function headlessOsc52Write(ctx: LibProbeSource): ProbeCallbackResult {
  if (typeof ctx.getClipboardState !== "function") return headlessOsc52WriteWithoutWitness(ctx)
  const control = btoa(`terminfo-osc52-control-${randomUUID()}`)
  ctx.feed(`\x1b]52;c;${control}\x07`)
  const controlled = ctx.getClipboardState().writes
  const controlVerified = controlled.some((write) => write.selector === "c" && write.payload === control)
  const priorWrites = new Set(controlled.map((write) => JSON.stringify([write.selector, write.payload])))
  const nonce = `terminfo-osc52-${randomUUID()}`
  const encoded = btoa(nonce)
  ctx.feed(`\x1b]52;c;${encoded}\x07`)
  const retained = ctx.getClipboardState()
  // #32091: the declared clipboard-load recipe query still runs, so a native host route retains its capture. The
  // callback result below reads only the engine's retained write; the query's reply or silence does not decide it, and a
  // silent read carries the audited host-input cause (kitty's default read-clipboard-ask waits on a human).
  const query = "\x1b]52;c;?\x07"
  const outcome = ctx.queryWithSentinelOutcome?.(query, osc52Reply)
  const raw = outcome ? outcome.raw : ctx.feedCapture(query)
  const readEmpty = outcome
    ? sentinelSilenceResult(outcome, "OSC 52 c query returns the exact written nonce") !== null || raw === ""
    : raw === ""
  const explain = (result: ProbeCallbackResult) => emptyNativeHostReply(ctx, result, query, readEmpty)
  const targetWrites = retained.writes.filter(
    (write) => !priorWrites.has(JSON.stringify([write.selector, write.payload])),
  )
  const writes = targetWrites.map((write) => ({ selector: write.selector, payload: write.payload }))
  const match = targetWrites.find((write) => write.selector === "c" && write.payload === encoded)
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
  const state = { writes }
  if (!controlVerified) return explain(notTestedResult(NO_SAME_PATH_CONTROL, { control, controlled, ...state }))
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
  if (writes.length === 0) {
    return explain(
      notTestedResult("control OSC 52 c write recorded but the probe write was not; same-run observations disagree", {
        control,
        controlled,
        ...state,
      }),
    )
  }
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
    "Open: our test cannot see the clipboard. Asking for it back (OSC 52) got no answer, and nothing else in our test watches the clipboard."
  const result: ProbeCallbackResult = writeUnobservable
    ? { pass: false, note: reason, tests: [{ id: "criterion", status: "probe-todo", reason }] }
    : headlessClipboardResult(empty ? "" : raw, nonce)
  return withClipboardControlNote(ctx, emptyNativeHostReply(ctx, { ...result, response: raw }, query, empty))
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
      emptyNativeHostReply(
        ctx,
        silence ?? { ...headlessClipboardResult(outcome.raw, nonce), response: outcome.raw },
        "\x1b]52;c;?\x07",
        silence !== null,
      ),
    )
  }
  const raw = ctx.feedCapture("\x1b]52;c;?\x07")
  return withClipboardControlNote(
    ctx,
    emptyNativeHostReply(ctx, headlessClipboardResult(raw, nonce), "\x1b]52;c;?\x07", raw === ""),
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
    tests: [{ id: "criterion", status: "probe-todo", reason: note }],
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
          note: "No OSC 52 reply; the run does not interact with a possible prompt, so nothing it observes decides whether one appeared",
        },
      }
    }
    return result
  })
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/** Reviewed public library absences; a provided encoder always takes precedence. */
const NO_LIBRARY_PASTE_ENCODER: Readonly<Record<string, string>> = {
  alacritty:
    "alacritty_terminal 0.26.0 exports Term and public TermMode::BRACKETED_PASTE state, but no paste or bracketed-paste encoder; application paste wrapping is outside this library",
  "vt100-rust":
    "vt100 0.16.2 exports Parser and Screen with public Screen::bracketed_paste() state and input-mode serialization, but no paste or bracketed-paste encoder",
  xterm:
    "@xterm/headless 6.0.0 exports Terminal and public modes.bracketedPasteMode state; input() takes already encoded bytes and onData reports output; it has no paste or bracketed-paste encoder",
  ghostty:
    "Untestable: ghostty-web 0.4.0 exports no paste encoder. Its exports are the terminal and render-state calls only.",
}

/** Observe the same library instance's native paste encoder; no OS clipboard or injected framing. */
function headlessClipboardPaste(ctx: LibProbeSource): ProbeCallbackResult {
  const encodePaste = ctx.encodePaste
  if (!encodePaste) {
    const declared = NO_LIBRARY_PASTE_ENCODER[ctx.backendName]
    if (declared && (ctx.backendName !== "ghostty" || hasAuditedOscInterfaceAbsence(ctx, "ghostty-web-d2"))) {
      return declaredUntestableResult(declared, { backend: ctx.backendName, encodePaste: false })
    }
    const reason =
      ctx.backendName === "ghostty" || ctx.backendName === "ghostty-native"
        ? "Open: our Ghostty adapter has no hook for sending pastes, and our test has not tried Ghostty's own paste function."
        : `Open: our ${ctx.backendName} adapter has no hook for sending pastes, and our test has not tried the library's own paste function.`
    return reviewResult("paste-encoding", reason, reason, { backend: ctx.backendName, encodePaste: false })
  }
  const samples: { phase: string; text: string; bytes: number[]; raw: string }[] = []
  const calls: { method: string; input: string }[] = []
  const sample = (phase: string) => {
    const text = `terminfo-paste-${randomUUID()}`
    calls.push({ method: "encodePaste", input: text })
    const bytes = encodePaste(text)
    const raw = new TextDecoder().decode(bytes)
    samples.push({ phase, text, bytes: Array.from(bytes), raw })
    const plain = new TextEncoder().encode(text)
    const framed = new TextEncoder().encode(`\x1b[200~${text}\x1b[201~`)
    const equals = (expected: Uint8Array) =>
      bytes.length === expected.length && bytes.every((byte, index) => byte === expected[index])
    return equals(plain) ? "raw" : equals(framed) ? "bracketed" : "unknown"
  }
  const setMode = (enabled: boolean) => {
    const input = enabled ? "\x1b[?2004h" : "\x1b[?2004l"
    calls.push({ method: "feed", input })
    ctx.feed(input)
  }
  const modeReads: Record<string, unknown>[] = []
  let unavailableModeReason = "Incoming bracketedPaste mode readback is unavailable"
  const readMode = () => {
    calls.push({ method: "getMode", input: "bracketedPaste" })
    const getter = ctx.getMode("bracketedPaste")
    if (getter !== null) {
      modeReads.push({ getter })
      return getter
    }
    const query = "\x1b[?2004$p"
    const pattern = decrpmReplyPattern(2004)
    let raw: string
    let frame: string | null
    let outcome: TerminalQueryOutcome | undefined
    let sequence: string
    if (ctx.queryWithSentinelOutcome) {
      sequence = query
      calls.push({ method: "queryWithSentinelOutcome", input: sequence })
      outcome = ctx.queryWithSentinelOutcome(sequence, pattern)
      raw = outcome.raw
      frame = replyFrame(outcome)
    } else if (typeof ctx.feedCapture === "function") {
      sequence = `${query}\x1b[c`
      calls.push({ method: "feedCapture", input: sequence })
      raw = ctx.feedCapture(sequence)
      frame = pattern.exec(raw)?.[0] ?? null
    } else {
      modeReads.push({ getter, query, reason: "no native mode query observable" })
      return null
    }
    const control = sentinelAnswer(raw)
    const ps = decrpmPs(frame === null ? undefined : pattern.exec(frame)?.[1])
    modeReads.push({
      getter,
      query: sequence,
      raw,
      frame,
      ps,
      control: control ? raw.slice(control.start, control.end) : null,
      ...(outcome && { outcome }),
    })
    if (!control) {
      unavailableModeReason = "Incoming bracketedPaste mode query lacks a successful same-feed DA1 control"
      return null
    }
    if (ps === null || ps === 0) return null
    return ps === 1 || ps === 3
  }
  const expected = "two exact raw native paste controls with 2004 off, then two exact bracketed nonces with 2004 on"
  const incomingMode = readMode()
  const incomingPs = modeReads[0]?.ps
  const state = { mode: "clipboard-paste", backend: ctx.backendName, incomingMode, modeReads, samples, calls }
  if (incomingMode === null) {
    const reason = unavailableModeReason
    return {
      ...parserStateResult(null, expected, state, reason, undefined, "input_bytes"),
      tests: [{ id: "criterion", status: "probe-todo", reason }],
    }
  }
  const initial = sample("initial")
  if (initial === "unknown") {
    return parserStateResult(
      null,
      expected,
      state,
      "Incoming native paste bytes are silent or malformed",
      undefined,
      "input_bytes",
    )
  }
  let pass: boolean | null = null
  let note: string | undefined
  let controlsQualified = false
  const controlFailureReason = "Native paste raw controls did not both qualify; enabled framing cannot be decided"
  let failed = false
  let primary: unknown
  try {
    setMode(false)
    const controls = [sample("off-1"), sample("off-2")]
    controlsQualified = controls.every((value) => value === "raw")
    if (!controlsQualified) {
      note = controlFailureReason
    } else {
      setMode(true)
      const enabled = [sample("on-1"), sample("on-2")]
      if (enabled.every((value) => value === "bracketed")) pass = true
      else if (enabled.every((value) => value === "raw")) pass = false
      else note = "Native paste enabled samples are silent, malformed or inconsistent"
    }
  } catch (error) {
    failed = true
    primary = error
    throw error
  } finally {
    try {
      setMode(incomingMode)
      const restoredEncoding = sample("restore")
      const restoredMode = readMode()
      if (
        restoredMode !== incomingMode ||
        restoredEncoding !== initial ||
        (incomingPs !== undefined && modeReads.at(-1)?.ps !== incomingPs)
      ) {
        throw new Error("Native paste 2004 restoration verification failed")
      }
    } catch (cleanup) {
      if (failed) throw new AggregateError([primary, cleanup], "Native paste measurement and restoration failed")
      throw cleanup
    }
  }
  const result = parserStateResult(pass, expected, state, note, undefined, "input_bytes")
  if (!controlsQualified) {
    result.tests = [{ id: "criterion", status: "probe-todo", reason: controlFailureReason }]
  }
  for (const assertion of result.assertions ?? []) {
    assertion.action = "native paste with 2004 off, on, then restored"
  }
  return result
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

// OSC 0 sets both labels. Library readers prefer controlled effects; exact positive replies also
// supply evidence. One observed false clause disproves the conjunction, while a missing observation
// never proves a negative. The application callback retains its existing two-query route.
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
  const reflowEvidence = {
    declaredReflow: ctx.capabilities.reflow === true,
    ...(ctx.getReflowState && { reflowSetting: ctx.getReflowState() }),
  }
  const resizeSource = ctx.resize
  if (!resizeSource) return notTestedResult(note, reflowEvidence)
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
      response: JSON.stringify({ ...reflowEvidence, initial }),
      note: "Reflow fixture needs a fresh bottom main buffer with at least eight screen rows",
      tests: [
        {
          id: "criterion",
          status: "probe-invalid",
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
    status: "supported" | "unsupported" | "probe-todo" | "probe-invalid"
  }
  type AlternatePhase = NonNullable<ReturnType<typeof measureAlternateReflow>["measurement"]>
  const state = {
    ...reflowEvidence,
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
      // Reset alone need not clear retained history (libvterm preserves it).
      // Issue the existing explicit clear before checking the fresh fixture.
      state.actions.push({ kind: "reset" })
      ctx.reset()
      readBound = height
      resize(from)
      clear()
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
              ? "probe-todo"
              : outcome === "invalid"
                ? "probe-invalid"
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
      clear()
      const fresh = read(`${id}.fresh`, from)
      const phase = (outcome: AlternatePhase["outcome"], reason: string): AlternatePhase => ({
        id,
        from,
        to,
        outcome,
        reason,
        status:
          outcome === "identity-unavailable" || outcome === "not-entered"
            ? "probe-todo"
            : outcome === "invalid"
              ? "probe-invalid"
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
            ? ("probe-invalid" as const)
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
              status: "probe-invalid" as const,
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
  // geometry; a ligature paints as one shaped glyph in the target run. The frames are retained,
  // but no same-run check compares them, so no automatic pass or fail is claimed. The headless
  // parser shapes no glyphs.
  {
    ...probe(
      "extensions.font-ligatures",
      () => {
        // Declared Untestable for every library (operator Nov 4 16:55): no library shapes glyphs.
        const note = "Font ligatures are renderer glyph shaping; the headless parser shapes no glyphs"
        return declaredUntestableResult(note, {
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

  {
    ...probe(
      "extensions.kitty-graphics.animation",
      (ctx) => {
        // Declared Untestable for every library (operator Nov 4 16:55): no library plays timed frames.
        const note = "Declared Kitty graphics capability does not establish timed animation playback"
        return declaredUntestableResult(note, {
          declared: ctx.capabilities.kittyGraphics === true,
        })
      },
      async (ctx) => {
        const id = "extensions.kitty-graphics.animation"
        const capture = ctx.capture
        if (!capture) {
          // No pixel adapter: an instrument limit, named before a byte, never a support conclusion.
          const note =
            "Kitty animation is pixels over time; this arm has no pixel capture, so the missing adapter is pixel capture and playback is not observable here"
          return {
            pass: false,
            note,
            tests: [{ id: "criterion", status: "probe-todo", reason: note }],
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
          const captureDecision = decideKittyAnimation({
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
            playback: captureDecision.outcome,
            placementAck: placement.raw,
            frames: frames.map((frame) => ({ role: frame.role, ref: frame.ref, label: frame.label })),
          })
          return {
            pass: captureDecision.outcome === "supported",
            response: observed,
            observation: {
              outcome: captureDecision.outcome,
              ...(captureDecision.outcome === "inconclusive" ? { reason: "insufficient-evidence" as const } : {}),
              assertionType: "screenshot",
              screenshotRef: playbackSecond.ref,
              frames,
              note: captureDecision.note,
            },
            ...(captureDecision.decidedBy === "a missing region digest"
              ? {
                  criterionBranch: HEADLESS_OBSERVABLE_REVIEW,
                  tests: [{ id: "review" as const, status: "probe-todo" as const, reason: captureDecision.note }],
                }
              : {}),
            ...(captureDecision.outcome === "inconclusive"
              ? {}
              : {
                  assertions: [
                    {
                      assertionType: "screenshot" as const,
                      kind: captureDecision.outcome === "supported" ? ("positive" as const) : ("negative" as const),
                      expected:
                        "Two target frames of one run, no write between them, differ on the animation rectangle while frame selection differs, a one-frame image holds still, the cursor-only capture is equal and a redraw changes the screen outside the rectangle",
                      observed,
                      note: `decided by ${captureDecision.decidedBy}`,
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
    termNeedsGeometry: true,
  },

  {
    ...probe(
      "extensions.kitty-graphics.unicode-placeholders",
      (ctx) => {
        // Declared Untestable for every library (operator Nov 4 16:55): no library renders placeholder images.
        const note = "Declared Kitty graphics capability does not establish Unicode placeholder rendering"
        return declaredUntestableResult(note, {
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
            tests: [{ id: "criterion", status: "probe-todo", reason: note }],
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
          // before any unsupported observation (the same delayed-capture shape reset.decaln uses).
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
          const captureDecision = decideKittyPlaceholders({
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
            pass: captureDecision.outcome === "supported",
            response: observed,
            observation: {
              outcome: captureDecision.outcome,
              ...(captureDecision.outcome === "inconclusive" ? { reason: "insufficient-evidence" as const } : {}),
              assertionType: "screenshot",
              screenshotRef: withImageSecond.ref,
              frames,
              note: captureDecision.note,
            },
            ...(captureDecision.decidedBy === "a missing region digest"
              ? {
                  criterionBranch: HEADLESS_OBSERVABLE_REVIEW,
                  tests: [{ id: "review" as const, status: "probe-todo" as const, reason: captureDecision.note }],
                }
              : {}),
            ...(captureDecision.outcome === "inconclusive"
              ? {}
              : {
                  assertions: [
                    {
                      assertionType: "screenshot" as const,
                      kind: captureDecision.outcome === "supported" ? ("positive" as const) : ("negative" as const),
                      expected:
                        "The placeholder rectangle differs from the same characters with the image deleted, is pixel-identical to an ordinary placement of the same opaque image over the same cells, and the identical layout guard beside it did not move while the ordinary placement painted against the captured blank",
                      observed,
                      note: `decided by ${captureDecision.decidedBy}`,
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
    termNeedsGeometry: true,
  },

  // Sixel — rendering remains unmeasured without pixel readback.
  {
    ...probe(
      "extensions.sixel",
      (ctx) => {
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
            ? "Open: our test cannot check the image, for two reasons. The library stores the image data at the right screen position, but drawing it is the app's job; and our test does not measure the character cell size needed to check the image's size."
            : "Sixel payload/position readback did not show new stored records; no raster; cell geometry unmeasured"
          return reviewResult(HEADLESS_OBSERVABLE_REVIEW, note, note, {
            declared: ctx.capabilities.sixel === true,
            storage: { retained, before, first, secondBefore, second },
          })
        }
        // Declared Untestable for every library without Sixel storage (operator Nov 4 16:55): no library rasterises
        // Sixel. The exception is the storage branch above (vterm), which keeps its observable review.
        const note = "Declared Sixel capability does not establish rendered pixels"
        return declaredUntestableResult(note, {
          declared: ctx.capabilities.sixel === true,
        })
      },
      async (ctx) => {
        // Sixel paints outside the cell grid. On an arm that reads cells there is nothing to
        // compare, and the missing adapter is pixel capture — named before a byte, as an
        // instrument limit in the 3a8bddd5 shape, never a support conclusion.
        if (!ctx.capture || ctx.captureKind === "text-cells") {
          const note =
            "Sixel paints pixels outside the cell grid; this arm has no pixel capture, so the missing adapter is pixel capture and the rendering is not observable here"
          return {
            pass: false,
            note,
            tests: [{ id: "criterion", status: "probe-todo", reason: note }],
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
            ? `Engine ${identity.engineVersion}, adapter ${identity.adapterVersion}`
            : "Adapter (runtime identity unavailable)"
          const note = `Open: our adapter for this library version does not read a link's address back (OSC 8; ${adapter})`
          // @cto 8c79b122: one open only; the verdict needs a report delta of exactly one entry.
          return unhandledOscReportResult(
            ctx,
            `\x1b]8;;${uri}\x07`,
            reviewResult(HEADLESS_OBSERVABLE_REVIEW, `${note}, so this run cannot decide it`, note, {
              chars: cells.map((cell) => cell.char),
              links,
            }),
          )
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
        if (links.every((link) => link.uri === null)) {
          return notTestedResult(NO_SAME_PATH_CONTROL, { chars: cells.map((cell) => cell.char), links })
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
                status: "probe-todo",
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
                status: "probe-todo",
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
              status: "probe-todo",
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
        tests: [{ id: "criterion", status: "probe-todo", reason: note }],
      })
    }),
    libAssertionType: "buffer_state",
  },

  // Semantic prompts (OSC 133)
  {
    ...probe(
      "extensions.semantic-prompts",
      // Kitty reads its approved prompt/output/end lifecycle; other libraries retain the report arm.
      (ctx) =>
        ctx.backendName === "kitty"
          ? promptMarkResult(ctx, "\x1b]133;A\x07", "OSC 133 lifecycle readback", {
              probeId: "extensions.semantic-prompts",
              selector: 133,
            })
          : unhandledOscReportResult(ctx, "\x1b]133;A\x07", {
              pass: false,
              note: "Open: our test saw only some of the shell cycle's steps (prompt start, command start, output start, command end with exit status), so it cannot judge the whole cycle yet.",
              tests: [
                {
                  id: "criterion",
                  status: "probe-todo" as const,
                  reason:
                    "Open: our test saw only some of the shell cycle's steps (prompt start, command start, output start, command end with exit status), so it cannot judge the whole cycle yet.",
                },
              ],
            }),
      () => {
        const note = "No shell prompt integration metadata or behavior readback for OSC 133"
        return Promise.resolve<ProbeCallbackResult>({
          pass: false,
          note,
          tests: [{ id: "criterion", status: "probe-todo", reason: note }],
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
        const beforeIcon = ctx.getIconLabel?.()
        const requested = before === "Test Title" ? "Test Title 2" : "Test Title"
        const control = before === "terminfo-title-control" ? "terminfo-title-control-2" : "terminfo-title-control"
        try {
          ctx.feed(`\x1b]0;${control}\x07`)
          const controlled = ctx.getTitle()
          if (controlled !== control) return notTestedResult(NO_SAME_PATH_CONTROL, { before, control, controlled })
          ctx.feed(`\x1b]2;${requested}\x07`)
          const title = ctx.getTitle()
          return parserStateResult(
            title === requested ? true : title === control ? false : null,
            "OSC 2 sets the exact requested window title",
            {
              before,
              control,
              controlled,
              requested,
              title,
            },
          )
        } finally {
          ctx.feed(`\x1b]0;${before}\x07`)
          if (beforeIcon !== undefined) ctx.feed(`\x1b]1;${beforeIcon}\x07`)
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
        if (readsIconTitleState(ctx)) {
          const before = { icon: ctx.getIconLabel(), title: ctx.getTitle() }
          const controls = {
            icon: before.icon === "osc0-icon-control" ? "osc0-icon-control-2" : "osc0-icon-control",
            title: before.title === "osc0-title-control" ? "osc0-title-control-2" : "osc0-title-control",
            secondTitle: "osc0-title-control-next",
          }
          try {
            ctx.feed(`\x1b]1;${controls.icon}\x07`)
            ctx.feed(`\x1b]2;${controls.title}\x07`)
            const firstTitleControl = ctx.getTitle()
            ctx.feed(`\x1b]2;${controls.secondTitle}\x07`)
            const controlled = { icon: ctx.getIconLabel(), title: ctx.getTitle() }
            if (
              controlled.icon !== controls.icon ||
              firstTitleControl !== controls.title ||
              controlled.title !== controls.secondTitle
            ) {
              return {
                response: JSON.stringify({ before, controls, firstTitleControl, controlled }),
                ...replyFailure("OSC 0 independent icon/title controls were not both read back"),
              }
            }
            ctx.feed(`\x1b]0;${OSC0_PAYLOAD}\x07`)
            const after = { icon: ctx.getIconLabel(), title: ctx.getTitle() }
            return parserStateResult(
              after.icon === OSC0_PAYLOAD && after.title === OSC0_PAYLOAD,
              "OSC 0 changes both independently controlled icon and title labels to its exact payload",
              { before, controls, firstTitleControl, controlled, requested: OSC0_PAYLOAD, after },
            )
          } finally {
            try {
              ctx.feed(`\x1b]1;${before.icon}\x07`)
            } finally {
              ctx.feed(`\x1b]2;${before.title}\x07`)
            }
          }
        }
        const before = ctx.getTitle()
        const controls = [
          before === "osc0-title-control" ? "osc0-title-control-2" : "osc0-title-control",
          "osc0-title-control-next",
        ]
        try {
          ctx.feed(`\x1b]2;${controls[0]}\x07`)
          const firstControl = ctx.getTitle()
          ctx.feed(`\x1b]2;${controls[1]}\x07`)
          const secondControl = ctx.getTitle()
          const controlled = firstControl === controls[0] && secondControl === controls[1]
          ctx.feed(`\x1b]0;${OSC0_PAYLOAD}\x07`)
          const observedTitle = ctx.getTitle()
          const state = { before, controls, firstControl, secondControl, requested: OSC0_PAYLOAD, observedTitle }
          if (controlled && observedTitle !== OSC0_PAYLOAD) {
            return parserStateResult(
              false,
              "OSC 0 sets both icon and window title to its payload",
              state,
              "OSC 0 did not set the window title after two OSC 2 controls passed",
            )
          }
          // A positive exact-payload reply remains evidence; absent/unqualified replies do not prove a negative.
          const iconOutcome = ctx.queryWithSentinelOutcome?.(OSC0_ICON_QUERY, OSC0_ICON_REPLY)
          const titleOutcome = ctx.queryWithSentinelOutcome?.(OSC0_TITLE_QUERY, OSC0_TITLE_REPLY)
          const icon = iconOutcome ? iconOutcome.raw : ctx.feedCapture(OSC0_ICON_QUERY)
          const title = titleOutcome ? titleOutcome.raw : ctx.feedCapture(OSC0_TITLE_QUERY)
          const iconLabel = iconOutcome ? (iconOutcome.match?.[1] ?? null) : (OSC0_ICON_REPLY.exec(icon)?.[1] ?? null)
          const windowTitle = controlled
            ? observedTitle
            : titleOutcome
              ? (titleOutcome.match?.[1] ?? null)
              : (OSC0_TITLE_REPLY.exec(title)?.[1] ?? null)
          const iconReason = iconOutcome ? iconOutcome.reason : "feedCapture boundary"
          const titleReason = titleOutcome ? titleOutcome.reason : "feedCapture boundary"
          if (iconLabel !== OSC0_PAYLOAD || windowTitle !== OSC0_PAYLOAD) {
            const iconControl = iconOutcome && sentinelSilenceResult(iconOutcome, "OSC 0 icon name")
            const titleControl = titleOutcome && sentinelSilenceResult(titleOutcome, "OSC 0 window title")
            const missing = [
              ...(iconLabel !== OSC0_PAYLOAD
                ? [
                    iconControl
                      ? "asking for the icon name (CSI 20 t, a short window name) got no answer, though the reply control did come back"
                      : iconReason === "timeout" && icon === ""
                        ? "asking for the icon name (CSI 20 t, a short window name) got no answer within our wait, and no reply control worked in this test"
                        : "the icon-name query (CSI 20 t) did not return the name we set",
                  ]
                : []),
              ...(windowTitle !== OSC0_PAYLOAD
                ? [
                    titleControl
                      ? "asking for the window title (CSI 21 t) got no answer, though the reply control did come back"
                      : titleReason === "timeout" && title === ""
                        ? "asking for the window title (CSI 21 t) got no answer within our wait, and no reply control worked in this test"
                        : "the window-title query (CSI 21 t) did not return the title we set",
                  ]
                : []),
            ]
            return notTestedResult(
              `Open: ${missing.join("; ")}. With these readings, our test cannot tell whether OSC 0 set both names.`,
              {
                ...state,
                icon,
                title,
                iconLabel,
                windowTitle,
                iconReason,
                titleReason,
              },
            )
          }
          const result = osc0IconTitleResult(
            iconLabel,
            windowTitle,
            { icon, title },
            {
              icon: iconOutcome ? iconOutcome.reason : "feedCapture boundary",
              title: titleOutcome ? titleOutcome.reason : "feedCapture boundary",
            },
          )
          const response = JSON.stringify({ ...state, icon, title, iconLabel, windowTitle, iconReason, titleReason })
          if (controlled && result.observation) {
            return {
              ...result,
              assertions: result.assertions?.map((assertion, index) =>
                index === 1 ? { ...assertion, assertionType: "buffer_state" as const } : assertion,
              ),
              response,
            }
          }
          return { ...result, response }
        } finally {
          ctx.feed(`\x1b]2;${before}\x07`)
        }
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
    libAssertionType: { when: readsIconTitleState, then: ["buffer_state"], otherwise: ["buffer_state", "query_reply"] },
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
    ...probe("extensions.osc52-write", headlessOsc52Write, (ctx) => liveClipboardProbe(ctx, "write"), "query_reply"),
    libAssertionType: "query_reply",
    libHostRecipes: [{ recipe: "clipboard-load", query: "\x1b]52;c;?\x07", missing: ["clipboard-read-permission"] }],
  },

  // OSC 52 read — query clipboard back (fewer terminals support this)
  {
    ...probe("extensions.osc52-read", headlessClipboardRead, (ctx) => liveClipboardProbe(ctx, "read"), "query_reply"),
    libAssertionType: "query_reply",
    libHostRecipes: [{ recipe: "clipboard-load", query: "\x1b]52;c;?\x07", missing: ["clipboard-read-permission"] }],
  },

  probe("extensions.clipboard-paste", headlessClipboardPaste, clipboardPaste, "input_bytes"),

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
          const identity = ctx.runtimeIdentity
          if (identity && hasAuditedOscInterfaceAbsence(ctx)) {
            const note = `${ctx.backendName} ${identity.engineVersion}: the audited library exposes no working-directory state or OSC 7 callback`
            return declaredUntestableResult(note, {
              backend: ctx.backendName,
              runtimeIdentity: evidenceRuntimeIdentity(ctx.runtimeIdentity),
              getCwd: false,
            })
          }
          const note = "Declared OSC 7 capability does not establish working-directory metadata delivery"
          return reviewResult(HEADLESS_OBSERVABLE_REVIEW, `${note}, so this run cannot decide it`, note, {
            declared: ctx.capabilities.extensions.has("osc7"),
          })
        }
        const sameUrl = (observed: string | null, expected: string): boolean =>
          observed !== null &&
          URL.canParse(observed) &&
          URL.canParse(expected) &&
          new URL(observed).href === new URL(expected).href
        const before = ctx.getCwd()
        const controlUri = "file://localhost/terminfo-cwd-control"
        const firstUri = "file://localhost/terminfo-cwd-A"
        const secondUri = "file://localhost/terminfo-cwd-B"
        const writes = [`\x1b]7;${firstUri}\x07`, `\x1b]7;${secondUri}\x07`, `\x1b]7;${before ?? ""}\x07`] as const
        let first: string | null
        let second: string | null
        let controlled: string | null
        try {
          ctx.feed(`\x1b]633;P;Cwd=${controlUri}\x07`)
          controlled = ctx.getCwd()
          ctx.feed(writes[0])
          first = ctx.getCwd()
          ctx.feed(writes[1])
          second = ctx.getCwd()
        } finally {
          ctx.feed(writes[2])
          if (ctx.getCwd() !== before) ctx.feed(`\x1b]633;P;Cwd=${before ?? ""}\x07`)
        }
        const restored = ctx.getCwd()
        const supported = sameUrl(first, firstUri) && sameUrl(second, secondUri)
        if (!supported && !sameUrl(controlled, controlUri) && restored === before) {
          return notTestedResult(NO_SAME_PATH_CONTROL, { before, controlUri, controlled, first, second, restored })
        }
        const result = parserStateResult(
          restored === before ? supported : null,
          `OSC 7 stores successive URI values equal to ${firstUri}, ${secondUri} after WHATWG URL serialization and restores the original URI`,
          { before, controlUri, controlled, first, second, restored, writes },
        )
        if (restored !== before) {
          result.observation = {
            outcome: "error",
            reason: "invalid-reply",
            assertionType: "buffer_state",
            note: "Cwd restored readback did not match the original URI",
          }
        }
        return result
      },
      () => {
        const note = "No working-directory metadata readback for OSC 7"
        return Promise.resolve<ProbeCallbackResult>({
          pass: false,
          note,
          tests: [{ id: "criterion", status: "probe-todo", reason: note }],
        })
      },
    ),
    libAssertionType: "buffer_state",
  },

  // OSC 633 — VS Code shell integration
  {
    ...probe(
      "extensions.osc-633-vscode",
      // Case 1's twelfth shell cell on the 633 side: the umbrella read falls to the library's own report.
      (ctx) =>
        unhandledOscReportResult(ctx, "\x1b]633;A\x07", {
          pass: false,
          note: "Open: our test saw only some of the shell cycle's steps (prompt start, command start, output start, command end with exit status), so it cannot judge the whole cycle yet.",
          tests: [
            {
              id: "criterion",
              status: "probe-todo" as const,
              reason:
                "Open: our test saw only some of the shell cycle's steps (prompt start, command start, output start, command end with exit status), so it cannot judge the whole cycle yet.",
            },
          ],
        }),
      () => {
        const note = "No VS Code shell integration metadata or behavior readback for OSC 633"
        return Promise.resolve<ProbeCallbackResult>({
          pass: false,
          note,
          tests: [{ id: "criterion", status: "probe-todo", reason: note }],
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

  // OSC 133;P — secondary prompt start
  {
    ...probe(
      "extensions.osc133-p",
      (ctx) =>
        promptMarkResult(ctx, "\x1b]133;P\x07", "OSC 133;P secondary prompt start", {
          probeId: "extensions.osc133-p",
          selector: 133,
          markType: "prompt",
        }),
      (ctx) => promptMarkAppResult(ctx, "\x1b]133;P\x07", "OSC 133;P secondary prompt start"),
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
    ...probe("extensions.osc633-p", promptCwdPropertyResult, (ctx) =>
      promptMarkAppResult(ctx, "\x1b]633;P;Cwd=/tmp\x07", "OSC 633;P properties mark registration"),
    ),
    libAssertionType: "buffer_state",
  },

  // OSC 9 — desktop notifications
  {
    ...probe(
      "extensions.notifications",
      (ctx) => {
        // A parsed-toast store keeps no OSC code, so it is checked by single-sequence deltas (@cto 3cc4a3ae).
        if (!ctx.getNotifications && ctx.getToasts) {
          const body = "terminfo-9-toast"
          return parsedToastResult(ctx, ctx.getToasts, {
            label: "OSC 9",
            noToast: "\x1b]9;4;0\x07",
            cross: {
              write: "\x1b]777;notify;terminfo-9-cross-title;terminfo-9-cross-body\x07",
              matches: (toast) => toast.title === "terminfo-9-cross-title" && toast.body === "terminfo-9-cross-body",
            },
            // OSC 9 carries a body only: the title the engine stores is recorded, never checked.
            graded: { write: `\x1b]9;${body}\x07`, matches: (toast) => toast.body === body },
            expected: `OSC 9 adds exactly one parsed toast with body ${body}`,
          })
        }
        if (!ctx.getNotifications) {
          const identity = ctx.runtimeIdentity
          if (identity && hasAuditedOscInterfaceAbsence(ctx)) {
            const reason = `${ctx.backendName} ${identity.engineVersion} exposes no public completed OSC 9 notification callback or ordered event state on its existing parser instance`
            return declaredUntestableResult(reason, {
              backend: ctx.backendName,
              runtimeIdentity: evidenceRuntimeIdentity(identity),
            })
          }
          const note = "Declared OSC 9 capability does not establish desktop notification delivery"
          return reviewResult(HEADLESS_OBSERVABLE_REVIEW, `${note}, so this run cannot decide it`, note, {
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
          tests: [{ id: "criterion", status: "probe-todo", reason: note }],
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
        // Declared Untestable for every library (operator Nov 4 16:55): no library renders image pixels.
        const note = "Declared iTerm2 image capability does not establish rendered image pixels"
        return declaredUntestableResult(note, {
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
          tests: [{ id: "criterion", status: "probe-todo", reason: note }],
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
  {
    ...probe(
      "extensions.osc9-progress",
      (ctx) => {
        // Without a progress reader, feed the ConEmu form only; consumption alone does not measure progress.
        const readProgress = ctx.getProgress
        if (!readProgress) {
          return unhandledOscReportResult(ctx, "\x1b]9;4;1;50\x07", noSamePathControl("\x1b]9;4;1;50\x07")(ctx))
        }
        const read = () => {
          const report = readProgress.call(ctx)
          return report && { state: report.state, value: report.value }
        }
        const before = read()
        // Both controls must change this reader, including when the incoming value is already 37.
        const firstValue = before?.state === 1 && before.value === 37 ? 73 : 37
        const secondValue = firstValue === 37 ? 73 : 37
        const writes: string[] = []
        const feed = (state: number, value: number | null = null) => {
          const sequence = `\x1b]9;4;${state}${value === null ? "" : `;${value}`}\x07`
          writes.push(sequence)
          ctx.feed(sequence)
        }
        let control: ReturnType<typeof read> = null
        let secondControl: ReturnType<typeof read> = null
        let indeterminate: ReturnType<typeof read> = null
        let cleared: ReturnType<typeof read> = null
        let restored: ReturnType<typeof read> = null
        let controlsPassed = false
        let failed = false
        let primaryError: unknown
        try {
          feed(1, firstValue)
          control = read()
          feed(1, secondValue)
          secondControl = read()
          controlsPassed =
            control?.state === 1 &&
            control.value === firstValue &&
            secondControl?.state === 1 &&
            secondControl.value === secondValue
          if (controlsPassed) {
            feed(3)
            indeterminate = read()
            feed(0)
            cleared = read()
          }
        } catch (error) {
          failed = true
          primaryError = error
        } finally {
          try {
            // A protocol cannot restore "never reported" history; that case retains the prior clear cleanup.
            feed(before?.state ?? 0, before?.value ?? null)
            restored = read()
            if (before && (restored?.state !== before.state || restored.value !== before.value)) {
              throw new Error(`OSC 9;4 incoming progress restoration failed: ${JSON.stringify({ before, restored })}`)
            }
          } catch (error) {
            if (failed) throw new AggregateError([primaryError, error], "OSC 9;4 measurement and restoration failed")
            throw error
          }
        }
        if (failed) throw primaryError
        const raw = { before, control, secondControl, indeterminate, cleared, restored, writes }
        if (!controlsPassed) {
          return notTestedResult(
            `${NO_SAME_PATH_CONTROL}: two distinct OSC 9;4 percentage controls did not read back; this reader is not shown to observe the OSC 9;4 path`,
            raw,
          )
        }
        return parserStateResult(
          indeterminate?.state === 3 && cleared?.state === 0,
          "OSC 9;4 stores the last report's state: 3 after 9;4;3, then 0, never no report, after 9;4;0",
          raw,
          "Measures stored OSC 9;4 state, not progress display; states 2/4, 100%, stored values for 0/3 and never-reported history are not graded. Incoming reported state is restored; an unset report is left cleared because OSC cannot restore absent history",
        )
      },
      () => Promise.resolve(unmeasuredStateEffect("OSC 9;4 progress display")),
      null,
    ),
    libAssertionType: "buffer_state",
  },

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
                status: "probe-todo",
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
                const reason =
                  "Open: this test judges OSC 5522 by whether the library replies. Its control is a mode query (DECRPM), which should always get a reply, sent the same way. Some control replies did not come back in this run, so silence on OSC 5522 proves nothing."
                return {
                  pass: false,
                  response,
                  note: reason,
                  tests: [{ id: "criterion", status: "probe-todo", reason }],
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
          return unhandledOscReportResult(
            ctx,
            "\x1b]1;test-icon\x07",
            notTestedResult(NO_SAME_PATH_CONTROL, { before, after }),
          )
        }
        const before = { icon: ctx.getIconLabel(), title: ctx.getTitle() }
        const requested = before.icon === "test-icon" ? "test-icon-2" : "test-icon"
        const iconControl =
          before.icon === "terminfo-icon-control" ? "terminfo-icon-control-2" : "terminfo-icon-control"
        const control =
          before.title === "terminfo-title-control" ? "terminfo-title-control-2" : "terminfo-title-control"
        try {
          ctx.feed(`\x1b]0;${iconControl}\x07`)
          const controlledIcon = ctx.getIconLabel()
          if (controlledIcon !== iconControl) {
            return notTestedResult(NO_SAME_PATH_CONTROL, { before, iconControl, controlledIcon })
          }
          ctx.feed(`\x1b]2;${control}\x07`)
          const title = ctx.getTitle()
          if (title !== control) {
            return notTestedResult(NO_SAME_PATH_CONTROL, { before, iconControl, controlledIcon, control, title })
          }
          ctx.feed(`\x1b]1;${requested}\x07`)
          const after = { icon: ctx.getIconLabel(), title: ctx.getTitle() }
          return parserStateResult(
            after.icon === requested && after.title === control,
            "OSC 1 sets the icon name without changing the independently verified window title",
            { before, iconControl, controlledIcon, requested, control, after },
          )
        } finally {
          ctx.feed(`\x1b]0;${before.icon}\x07`)
          ctx.feed(`\x1b]2;${before.title}\x07`)
        }
      },
      () => {
        const note = "No icon-name readback for OSC 1"
        return Promise.resolve<ProbeCallbackResult>({
          pass: false,
          note,
          tests: [{ id: "criterion", status: "probe-todo", reason: note }],
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
  // Logical pointer state is queryable in the library; visible app appearance remains separate.
  {
    ...probe(
      "extensions.osc22-pointer",
      (ctx) => {
        const undecided = () =>
          unhandledOscReportResult(ctx, "\x1b]22;pointer\x07", noSamePathControl("\x1b]22;pointer\x07")(ctx))
        if (ctx.backendName !== "kitty") return undecided()
        const query = "\x1b]22;?__current__\x07"
        const read = () => {
          const raw = ctx.feedCapture(query)
          return { raw, shape: /^\x1b\]22;([a-z0-9_-]+)(?:\x07|\x1b\\)$/u.exec(raw)?.[1] }
        }
        const initial = read()
        if (initial.shape === undefined) return notTestedResult(NO_SAME_PATH_CONTROL, { query, initial })
        const controlShape = initial.shape === "text" ? "wait" : "text"
        const controlWrite = `\x1b]22;${controlShape}\x07`
        const targetWrite = "\x1b]22;pointer\x07"
        // Kitty reports its unset shape as "0"; an empty assignment restores that native default.
        const restoreWrite = `\x1b]22;${initial.shape === "0" ? "" : initial.shape}\x07`
        const readings: {
          initial: typeof initial
          control?: typeof initial
          target?: typeof initial
          restored?: typeof initial
        } = { initial }
        try {
          ctx.feed(controlWrite)
          readings.control = read()
          if (readings.control.shape === controlShape) {
            ctx.feed(targetWrite)
            readings.target = read()
          }
        } finally {
          ctx.feed(restoreWrite)
          readings.restored = read()
        }
        const evidence = { query, controlWrite, targetWrite, restoreWrite, readings }
        const target = readings.target?.shape
        if (
          readings.control?.shape !== controlShape ||
          target === undefined ||
          readings.restored?.shape !== initial.shape
        ) {
          return notTestedResult(NO_SAME_PATH_CONTROL, evidence)
        }
        return parserStateResult(
          target === "pointer" ? true : target === controlShape ? false : null,
          "OSC 22 pointer query reports pointer after a distinct same-path control and restores the incoming shape",
          evidence,
          undefined,
          undefined,
          "query_reply",
        )
      },
      async (ctx) => {
        ctx.write("\x1b[1;1H\x1b[2K")
        ctx.write("\x1b]22;pointer\x07")
        const pos = await ctx.queryCursorPosition()
        return unmeasuredCellResult(pos, "OSC 22 pointer shape")
      },
      null,
    ),
    libAssertionType: {
      when: (source: Pick<LibProbeSource, "getUnhandledSequences">) =>
        typeof source.getUnhandledSequences === "function",
      then: ["query_reply", "buffer_state"],
      otherwise: ["query_reply"],
    },
  },

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
  {
    ...probe(
      "extensions.osc777-notify",
      (ctx) => {
        // Without a raw OSC 777 reader the grid is the only witness, and it cannot see a notification.
        const readPayloads = ctx.getOsc777Payloads
        // A parsed-toast store keeps no OSC code, so it is checked by single-sequence deltas (@cto 3cc4a3ae).
        if (!readPayloads && ctx.getToasts) {
          const toast = { title: "terminfo-777-toast-title", body: "terminfo-777-toast-body" }
          return parsedToastResult(ctx, ctx.getToasts, {
            label: "OSC 777",
            noToast: "\x1b]777;preexec\x07",
            // OSC 9 carries a body only: the cross control checks the body, whatever title the engine stores.
            cross: {
              write: "\x1b]9;terminfo-777-cross-body\x07",
              matches: (stored) => stored.body === "terminfo-777-cross-body",
            },
            graded: {
              write: `\x1b]777;notify;${toast.title};${toast.body}\x07`,
              matches: (stored) => stored.title === toast.title && stored.body === toast.body,
            },
            expected: `OSC 777 notify adds exactly one parsed toast with title ${toast.title} and body ${toast.body}`,
          })
        }
        if (!readPayloads) {
          const sequence = "\x1b]777;notify;test;body\x07"
          return unhandledOscReportResult(ctx, sequence, noSamePathControl(sequence)(ctx))
        }
        const read = () => [...readPayloads.call(ctx)]
        // Grading rule 2: a non-notify control must read back verbatim on this reader before any Unsupported (@cto cd6b67d9).
        const before = read()
        const controlPayload = "terminfo-777-control"
        const controlWrite = `\x1b]777;${controlPayload}\x07`
        ctx.feed(controlWrite)
        const control = read()
        if (JSON.stringify(control) !== JSON.stringify([...before, controlPayload])) {
          // The cell renders notTested.noObservable, so the specific reason rides there (@cto c3da3964).
          return notTestedResult(
            `${NO_SAME_PATH_CONTROL}: OSC 777 control payload not recorded; this reader is not shown to observe the OSC 777 path`,
            { before, control, writes: [controlWrite] },
          )
        }
        // The reader returns every OSC 777 payload; only the notify subcommand is this criterion (@cto 94631c52).
        const notifies = (payloads: readonly string[]) => payloads.filter((payload) => payload.startsWith("notify;"))
        const firstPayload = "notify;terminfo-777-title-A;terminfo-777-body-A"
        const secondPayload = "notify;terminfo-777-title-B;terminfo-777-body-B"
        const writes = [controlWrite, `\x1b]777;${firstPayload}\x07`, `\x1b]777;${secondPayload}\x07`] as const
        ctx.feed(writes[1])
        const first = read()
        ctx.feed(writes[2])
        const second = read()
        const expectedBefore = notifies(control)
        return parserStateResult(
          JSON.stringify(notifies(first)) === JSON.stringify([...expectedBefore, firstPayload]) &&
            JSON.stringify(notifies(second)) === JSON.stringify([...expectedBefore, firstPayload, secondPayload]),
          "OSC 777 notify appends each exact title and body payload in order and preserves earlier payloads",
          { before, control, first, second, writes },
          "Measures the parser OSC 777 sink, not OS notification delivery",
        )
      },
      async (ctx) => {
        ctx.write("\x1b[1;1H\x1b[2K")
        ctx.write("\x1b]777;notify;test;body\x07")
        const pos = await ctx.queryCursorPosition()
        return unmeasuredCellResult(pos, "OSC 777 notification delivery")
      },
      null,
    ),
    libAssertionType: "buffer_state",
  },

  // OSC 666 — VTE termprop
  probe(
    "extensions.osc666-termprop",
    noSamePathControl("\x1b]666;test-prop=value\x07"),
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
    noSamePathControl("\x1b]3008;type=test\x07"),
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
    noSamePathControl("\x1b]176;terminfo-test\x07"),
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
    noSamePathControl("\x1b]555\x07"),
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
    noSamePathControl("\x1b]440;bell.wav\x07"),
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
  probe("extensions.osc710-font-normal", noSamePathControl("\x1b]710;monospace\x07"), () =>
    Promise.resolve(unmeasuredStateEffect("OSC 710 font selection")),
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

// Operator D2 / CTO Nov 5 11:16: these exact feeds and normalized codes were
// measured on the audited real addon. Delivery effects and OSC52 read are not negatives.
const VT100_RUST_D2_NEGATIVES: Readonly<Record<string, { readonly feed: string; readonly code: UnhandledSequence }>> = {
  "cursor.position-report": { feed: "\u001b[6n", code: { kind: "csi", code: "6n" } },
  "device.decrpm": { feed: "\u001b[?7$p", code: { kind: "csi", code: "?$7p" } },
  "device.dsr-996-color-scheme": { feed: "\u001b[?996n", code: { kind: "csi", code: "?996n" } },
  "device.primary-da": { feed: "\u001b[c", code: { kind: "csi", code: "0c" } },
  "device.secondary-da": { feed: "\u001b[>c", code: { kind: "csi", code: ">0c" } },
  "device.status-report": { feed: "\u001b[5n", code: { kind: "csi", code: "5n" } },
  "device.tertiary-da": { feed: "\u001b[=c", code: { kind: "csi", code: "=0c" } },
  "device.xtreportcolors": { feed: "\u001b[#R", code: { kind: "csi", code: "#0R" } },
  "device.xtversion": { feed: "\u001b[>0q", code: { kind: "csi", code: ">0q" } },
  "device.xtwinops-14": { feed: "\u001b[14t", code: { kind: "csi", code: "14t" } },
  "device.xtwinops-16": { feed: "\u001b[16t", code: { kind: "csi", code: "16t" } },
  "device.xtwinops-18": { feed: "\u001b[18t", code: { kind: "csi", code: "18t" } },
  "device.xtwinops-20": { feed: "\u001b[20t", code: { kind: "csi", code: "20t" } },
  "device.xtwinops-21": { feed: "\u001b[21t", code: { kind: "csi", code: "21t" } },
  "editing.decrqcra": { feed: "\u001b[1;1;1;1;1;5*y", code: { kind: "csi", code: "*1;1;1;1;1;5y" } },
  "extensions.sixel-da1": { feed: "\u001b[c", code: { kind: "csi", code: "0c" } },
  "extensions.sixel-geometry-report": { feed: "\u001b[?2;1;0S", code: { kind: "csi", code: "?2;1;0S" } },
  "modes.decsscls": { feed: "\u001b[9 p", code: { kind: "csi", code: " 9p" } },
  "modes.alt-scroll-1007": { feed: "\u001b[?1007h", code: { kind: "csi", code: "?1007h" } },
  "modes.color-scheme-reporting": { feed: "\u001b[?2031h", code: { kind: "csi", code: "?2031h" } },
  "modes.decsclm": { feed: "\u001b[?4h", code: { kind: "csi", code: "?4h" } },
  "modes.reverse-video": { feed: "\u001b[?5h", code: { kind: "csi", code: "?5h" } },
  "modes.synchronized-output": { feed: "\u001b[?2026h", code: { kind: "csi", code: "?2026h" } },
  "modes.xtpushcolors": { feed: "\u001b[#P", code: { kind: "csi", code: "#0P" } },
  "modes.xtpopcolors": { feed: "\u001b[#Q", code: { kind: "csi", code: "#0Q" } },
  "modes.xtrestore": { feed: "\u001b[?7r", code: { kind: "csi", code: "?7r" } },
  "modes.xtsave": { feed: "\u001b[?7s", code: { kind: "csi", code: "?7s" } },
  "modes.focus-tracking": { feed: "\u001b[?1004h", code: { kind: "csi", code: "?1004h" } },
  "extensions.osc10-fg-color": { feed: "\u001b]10;?\u0007", code: { kind: "osc", code: "10" } },
  "extensions.osc11-bg-color": { feed: "\u001b]11;?\u0007", code: { kind: "osc", code: "11" } },
  "extensions.osc12-cursor-color": { feed: "\u001b]12;?\u0007", code: { kind: "osc", code: "12" } },
  "extensions.osc1337-capabilities": { feed: "\u001b]1337;Capabilities\u0007", code: { kind: "osc", code: "1337" } },
  "extensions.osc1337-cellsize": { feed: "\u001b]1337;ReportCellSize\u0007", code: { kind: "osc", code: "1337" } },
  "extensions.osc17-highlight-bg": { feed: "\u001b]17;?\u0007", code: { kind: "osc", code: "17" } },
  "extensions.osc19-highlight-fg": { feed: "\u001b]19;?\u0007", code: { kind: "osc", code: "19" } },
  "extensions.osc21-kitty-color": { feed: "\u001b]21;foreground=?\u001b\\", code: { kind: "osc", code: "21" } },
  "extensions.osc4-palette": { feed: "\u001b]4;0;?\u0007", code: { kind: "osc", code: "4" } },
  "extensions.osc5-special-color": { feed: "\u001b]5;0;?\u0007", code: { kind: "osc", code: "5" } },
  "extensions.osc701-locale": { feed: "\u001b]701;?\u0007", code: { kind: "osc", code: "701" } },
  "extensions.osc702-version": { feed: "\u001b]702;?\u0007", code: { kind: "osc", code: "702" } },
  "extensions.osc776-cell-size": { feed: "\u001b]776\u0007", code: { kind: "osc", code: "776" } },
  "extensions.osc7770-font-size": { feed: "\u001b]7770;?\u0007", code: { kind: "osc", code: "7770" } },
  "extensions.osc7777-font-window-size": { feed: "\u001b]7777;?\u0007", code: { kind: "osc", code: "7777" } },
  "extensions.osc99-kitty-notify": { feed: "\u001b]99;i=dev4-census:p=?;\u001b\\", code: { kind: "osc", code: "99" } },
  // @cto routes ruling 947dcd40, slice A. Own probe payloads; the SGR 1 control passes where `?7l` cannot.
  "editing.decsace": { feed: "\u001b[2*x", code: { kind: "csi", code: "*2x" } },
  "extensions.osc5522-clipboard": { feed: "\u001b[?5522$p", code: { kind: "csi", code: "?$5522p" } },
  "extensions.kitty-keyboard": { feed: "\u001b[>1u", code: { kind: "csi", code: ">1u" } },
  "extensions.kitty-keyboard.disambiguate": { feed: "\u001b[>1u", code: { kind: "csi", code: ">1u" } },
  "extensions.kitty-keyboard.report-events": { feed: "\u001b[>3u", code: { kind: "csi", code: ">3u" } },
  "extensions.kitty-keyboard.report-alternate": { feed: "\u001b[>5u", code: { kind: "csi", code: ">5u" } },
  "extensions.kitty-keyboard.report-all-keys": { feed: "\u001b[>9u", code: { kind: "csi", code: ">9u" } },
  "extensions.kitty-keyboard.report-text": { feed: "\u001b[>25u", code: { kind: "csi", code: ">25u" } },
  "input.csi-u": { feed: "\u001b[>1u", code: { kind: "csi", code: ">1u" } },
  "input.pixel-mouse": { feed: "\u001b[?1016h", code: { kind: "csi", code: "?1016h" } },
  "input.kitty-click-events": { feed: "\u001b]133;A;click_events=1\u0007", code: { kind: "osc", code: "133" } },
}

// Operator D2, exact alacritty_terminal 0.26.0 / VTE 0.15.0 API read:
// The audited dispatcher and event API expose no criterion-bearing state for these sequences.
const ALACRITTY_D2_ABSENCES: Readonly<Record<string, string>> = {
  "editing.decsace": "CSI Ps * x (DECSACE) attribute-change extent",
  "extensions.osc9-progress": "OSC 9;4 progress state",
  "input.kitty-click-events": "OSC 133 click-events prompt state (mouse encoding is supplied by Termless)",
  "extensions.osc777-notify": "OSC 777 notification payloads",
  "extensions.osc133-a": "OSC 133 prompt starts",
  "extensions.osc133-b": "OSC 133 command starts",
  "extensions.osc133-c": "OSC 133 output starts",
  "extensions.osc133-d": "OSC 133 command completion",
  "extensions.osc133-p": "OSC 133 prompt markers",
  "extensions.semantic-prompts": "semantic prompt lifecycle",
  "extensions.osc633-a": "OSC 633 prompt starts",
  "extensions.osc633-b": "OSC 633 command starts",
  "extensions.osc633-c": "OSC 633 output starts",
  "extensions.osc633-d": "OSC 633 command completion",
  "extensions.osc633-e": "OSC 633 command lines",
  "extensions.osc-633-vscode": "OSC 633 shell integration",
  "extensions.osc113-reset-pointer-fg": "OSC 113 pointer foreground reset",
  "extensions.osc114-reset-pointer-bg": "OSC 114 pointer background reset",
  "extensions.osc117-reset-highlight-bg": "OSC 117 highlight background reset",
  "extensions.osc119-reset-highlight-fg": "OSC 119 highlight foreground reset",
  "extensions.osc176-app-id": "OSC 176 application identity",
  "extensions.osc3008-context": "OSC 3008 context tags",
  "extensions.osc440-audio": "OSC 440 audio effects",
  "extensions.osc555-flash": "OSC 555 flash effects",
  "extensions.osc666-termprop": "OSC 666 terminal properties",
  "extensions.osc710-font-normal": "OSC 710 font selection",
}

// NR-H library-job declarations retain their separately reviewed xterm parser-hook reasons.
const OSC_PASS_THROUGH_REASON =
  "Untestable: the library hands this command to the app, as it does any OSC it does not handle itself, and does nothing with it."
const OSC_PASS_THROUGH_DECLARATIONS: Readonly<
  Record<string, string | { readonly backend: string; readonly reason: string }>
> = {
  // NR-H: xterm.js 6.0.0's logger is not a report; retain the reviewed parser-hook wording.
  "editing.decsace": {
    backend: "xterm",
    reason:
      "Untestable: the library hands this command to the app through registerCsiHandler, as it does any CSI it does not handle itself, and does nothing with it.",
  },
  "extensions.osc9-progress": { backend: "xterm", reason: OSC_PASS_THROUGH_REASON },
  "extensions.osc133-a": { backend: "xterm", reason: OSC_PASS_THROUGH_REASON },
  "extensions.osc133-b": { backend: "xterm", reason: OSC_PASS_THROUGH_REASON },
  "extensions.osc133-c": { backend: "xterm", reason: OSC_PASS_THROUGH_REASON },
  "extensions.osc133-d": { backend: "xterm", reason: OSC_PASS_THROUGH_REASON },
  "extensions.osc133-p": { backend: "xterm", reason: OSC_PASS_THROUGH_REASON },
  "extensions.semantic-prompts": { backend: "xterm", reason: OSC_PASS_THROUGH_REASON },
  "extensions.osc633-a": { backend: "xterm", reason: OSC_PASS_THROUGH_REASON },
  "extensions.osc633-b": { backend: "xterm", reason: OSC_PASS_THROUGH_REASON },
  "extensions.osc633-c": { backend: "xterm", reason: OSC_PASS_THROUGH_REASON },
  "extensions.osc633-d": { backend: "xterm", reason: OSC_PASS_THROUGH_REASON },
  "extensions.osc633-e": { backend: "xterm", reason: OSC_PASS_THROUGH_REASON },
  "extensions.osc-633-vscode": { backend: "xterm", reason: OSC_PASS_THROUGH_REASON },
}

// The default is the library's job. Phase 1 assigns ten commands to the app;
// the OSC 52 follow-on assigns clipboard/write only on the audited xterm route.
const APP_JOB_OSCS: Readonly<Record<string, string>> = {
  "extensions.osc52-clipboard": "52;c;dGVybWluZm8=",
  "extensions.osc52-write": "52;c;dGVybWluZm8=",
  "extensions.notifications": "9;terminfo-notification",
  "extensions.osc777-notify": "777;notify;terminfo-title;terminfo-body",
  "extensions.osc7-cwd": "7;file://localhost/terminfo-cwd",
  "extensions.osc633-p": "633;P;Cwd=/terminfo-cwd",
  "extensions.osc176-app-id": "176;terminfo-test",
  "extensions.osc3008-context": "3008;start=id=terminfo-test",
  "extensions.osc440-audio": "440;bell.wav",
  "extensions.osc555-flash": "555",
  "extensions.osc666-termprop": "666;test-prop=value",
  "extensions.osc710-font-normal": "710;monospace",
}

const LIBRARY_OSC_HOOKS: Readonly<
  Record<
    string,
    {
      readonly kind: "report" | "tap" | "typed" | "none"
      readonly typed?: readonly string[]
      readonly handoff?: string
    }
  >
> = {
  libvterm: { kind: "report" },
  "vt100-rust": { kind: "report" },
  xterm: { kind: "tap" },
  vterm: { kind: "tap", typed: ["extensions.notifications", "extensions.osc7-cwd", "extensions.osc633-p"] },
  ghostty: { kind: "typed" },
  "ghostty-native": { kind: "typed" },
  wezterm: { kind: "typed" },
  kitty: { kind: "typed", handoff: "extensions.osc3008-context" },
  vt100: { kind: "none" },
  vt220: { kind: "none" },
  alacritty: { kind: "none" },
}

/** Only generic handoffs use this rule; typed stores and library-job reports keep their existing paths. */
function appJobHandoff(
  ctx: LibProbeSource,
  featureId: string,
  lib: (ctx: LibProbeSource) => ProbeCallbackResult,
): ProbeCallbackResult | undefined {
  if (
    (featureId === "extensions.osc52-clipboard" || featureId === "extensions.osc52-write") &&
    ctx.backendName !== "xterm"
  ) {
    return undefined
  }
  const target = APP_JOB_OSCS[featureId]
  const hook = LIBRARY_OSC_HOOKS[ctx.backendName]
  if (
    !target ||
    !hook ||
    hook.kind === "none" ||
    (hook.kind === "typed" && hook.handoff !== featureId) ||
    hook.typed?.includes(featureId)
  ) {
    return undefined
  }
  const state = { featureId, backend: ctx.backendName, runtimeIdentity: evidenceRuntimeIdentity(ctx.runtimeIdentity) }
  if (hook.kind === "typed") {
    // H-4's typed OSC 3008 callback hands off text that this exact bridge does not keep.
    return declaredD2InterfaceAbsence(
      ctx,
      lib,
      featureId,
      APP_JOB_OSCS,
      "kitty",
      "host-effect-h4",
      undefined,
      () =>
        "Kitty 0.49.2 hands the OSC 3008 text to the app; our bridge does not keep it and exposes no context effect to read.",
      { genericReportIsObservable: false },
    )
  }
  if (hook.kind === "tap") {
    if (!hasAuditedOscInterfaceAbsence(ctx, "osc-tap")) {
      return notTestedResult("Generic OSC tap: this engine identity has no passed-to-the-app declaration", state)
    }
    return declaredUntestableResult(
      "Untestable (passed to the app): this command is the app's job, and the library hands it to the app through a hook that receives every OSC command.",
      state,
    )
  }
  const control = {
    feed: `\x1b]2;${UNHANDLED_OSC_CONTROL_TITLE}\x07`,
    applied: () => ctx.getTitle() === UNHANDLED_OSC_CONTROL_TITLE,
  }
  // Keep the existing report reader. Both this command and a made-up command must be reported,
  // while the handled title command applies without adding an entry in this same cell's run.
  const reported = unhandledSequenceVerdict(
    ctx,
    { feed: `\x1b]${target}\x07`, code: { kind: "osc", code: target.replace(/;.*/, "") } },
    control,
    state,
  )
  const madeUp =
    reported &&
    unhandledSequenceVerdict(
      ctx,
      { feed: "\x1b]9999;terminfo-handoff-control\x07", code: { kind: "osc", code: "9999" } },
      control,
      state,
    )
  if (!reported || !madeUp) {
    return notTestedResult(
      "Generic OSC report: the command, made-up OSC and handled title controls did not qualify in this run",
      state,
    )
  }
  return declaredUntestableResult(
    "Untestable (passed to the app): this command is the app's job. The library reports that it does not handle it and hands its text to the app.",
    { ...state, report: reported.response, madeUp: madeUp.response },
  )
}

const VT100_RUST_D2_DECLARATIONS: Readonly<Record<string, string>> = {
  "device.decrqss":
    "vt100 0.16.2 exposes Parser, Screen and Callbacks, but no public DCS callback, response writer or device.decrqss result state",
  "device.xtgettcap":
    "vt100 0.16.2 exposes Parser, Screen and Callbacks, but no public DCS callback, response writer or device.xtgettcap result state",
  "device.xtgetxres":
    "vt100 0.16.2 exposes Parser, Screen and Callbacks, but no public DCS callback, response writer or device.xtgetxres result state",
  "extensions.kitty-graphics":
    "vt100 0.16.2 exposes Parser, Screen and Callbacks, but no public APC callback, graphics store or Kitty graphics reply writer",
  "extensions.kitty-graphics.transmit":
    "vt100 0.16.2 exposes Parser, Screen and Callbacks, but no public APC callback, graphics store or Kitty graphics reply writer",
  "extensions.kitty-graphics.display":
    "vt100 0.16.2 exposes Parser, Screen and Callbacks, but no public APC callback, graphics store or Kitty graphics reply writer",
}

const VTERM_D2_DECLARATIONS: Readonly<Record<string, string>> = {
  "modes.decsscls":
    "vterm.js 0.13.1 exposes Screen, Snapshot and TerminalModes, but no public DECSSCLS scroll-speed state, getter or unhandled-sequence report",
  "extensions.osc9-progress":
    "vterm.js 0.13.1 exposes getNotifications() and tapParser(), but no public OSC 9;4 progress state, getter or unhandled-sequence report",
  "extensions.osc22-pointer":
    "vterm.js 0.13.1 exposes pointerFgColor and pointerBgColor on Snapshot, but no public OSC 22 pointer-shape state, query reply or unhandled-sequence report",
  "extensions.osc133-d":
    "vterm.js 0.13.1 exposes prompt, command and output start coordinates in getSemanticZones(), but no public OSC 133;D command-end state or exit status; the payload reaches only the generic parser tap, which cannot observe state application",
  "extensions.osc633-d":
    "vterm.js 0.13.1 exposes prompt, command and output start coordinates in getSemanticZones(), but no public OSC 633;D command-end state or exit status; the payload reaches only the generic parser tap, which cannot observe state application",
  "extensions.osc633-e":
    "vterm.js 0.13.1 exposes prompt, command and output start coordinates in getSemanticZones(), but no public OSC 633;E command-line or nonce state; the payload reaches only the generic parser tap, which cannot observe state application",
  "extensions.semantic-prompts":
    "vterm.js 0.13.1 exposes prompt, command and output start coordinates in getSemanticZones(), but no public OSC 133;D command-end state for the full semantic-prompt lifecycle; the payload reaches only the generic parser tap, which cannot observe state application",
  "extensions.osc-633-vscode":
    "vterm.js 0.13.1 exposes prompt, command and output start coordinates in getSemanticZones(), but no public OSC 633;D/E/P command-end, command-line or property state for the full VS Code shell-integration lifecycle; the payload reaches only the generic parser tap, which cannot observe state application",
  "input.kitty-click-events":
    "vterm.js 0.13.1 drops OSC 133;A click_events parameters in getSemanticZones() and exports no mouse-event encoder; the adapter's encodeMouse is Termless's encodeMouseReport",
}

// CTO 8be19f1f: five libraries expose no public image path, so their Kitty display and transmit
// cells are "no way" at exact identity. Each map names one library's own public surface, because a
// shared string would attribute one library's absence to another. libvterm is absent on purpose: its
// APC hook is public, so it is reader R1, and vterm decides its rows by the refusal reading instead.
const ALACRITTY_IMAGE_D2_DECLARATIONS: Readonly<Record<string, string>> = {
  "extensions.kitty-graphics.display":
    "alacritty_terminal 0.26.0 exposes Grid, Term and vte with the event, grid, term, tty and vi_mode modules, but no public APC callback, graphics store or Kitty graphics reply writer",
  "extensions.kitty-graphics.transmit":
    "alacritty_terminal 0.26.0 exposes Grid, Term and vte with the event, grid, term, tty and vi_mode modules, but no public APC callback, graphics store or Kitty graphics reply writer",
}

const XTERM_IMAGE_D2_DECLARATIONS: Readonly<Record<string, string>> = {
  "extensions.kitty-graphics.display":
    "@xterm/headless 6.0.0 exposes Terminal with the IBuffer and ITerminalOptions typings, but its parser documentation states that APC, PM and SOS are not supported, and it exposes no image store, APC handler or Kitty graphics reply writer",
  "extensions.kitty-graphics.transmit":
    "@xterm/headless 6.0.0 exposes Terminal with the IBuffer and ITerminalOptions typings, but its parser documentation states that APC, PM and SOS are not supported, and it exposes no image store, APC handler or Kitty graphics reply writer",
}

const VT100_IMAGE_D2_DECLARATIONS: Readonly<Record<string, string>> = {
  "extensions.kitty-graphics.display":
    "vt100.js 0.13.1 exposes createVt100Screen, Screen, ScreenOptions, ScreenCell and CellColor, and is a strict DEC VT100 (1978) implementation, but has no public APC or DCS string callback, graphics store or Kitty graphics reply writer",
  "extensions.kitty-graphics.transmit":
    "vt100.js 0.13.1 exposes createVt100Screen, Screen, ScreenOptions, ScreenCell and CellColor, and is a strict DEC VT100 (1978) implementation, but has no public APC or DCS string callback, graphics store or Kitty graphics reply writer",
}

const VT220_IMAGE_D2_DECLARATIONS: Readonly<Record<string, string>> = {
  "extensions.kitty-graphics.display":
    "vt220.js 0.13.1 exposes createVt220Screen, Vt220Screen, ScreenOptions, ScreenSnapshot, Attrs, ScreenCell and CellColor, and declares sixel/Kitty graphics deliberately absent, with no public APC callback, graphics store or Kitty graphics reply writer",
  "extensions.kitty-graphics.transmit":
    "vt220.js 0.13.1 exposes createVt220Screen, Vt220Screen, ScreenOptions, ScreenSnapshot, Attrs, ScreenCell and CellColor, and declares sixel/Kitty graphics deliberately absent, with no public APC callback, graphics store or Kitty graphics reply writer",
}

const GHOSTTY_WEB_IMAGE_D2_DECLARATIONS: Readonly<Record<string, string>> = {
  "extensions.kitty-graphics.display":
    "ghostty-web 0.4.0 exposes Ghostty, GhosttyTerminal and CanvasRenderer, and its only Kitty surface is setKittyFlags with KittyKeyFlags, the keyboard protocol; its WebAssembly export interface carries no image, sixel or graphics entry, so it has no public image store or APC callback",
  "extensions.kitty-graphics.transmit":
    "ghostty-web 0.4.0 exposes Ghostty, GhosttyTerminal and CanvasRenderer, and its only Kitty surface is setKittyFlags with KittyKeyFlags, the keyboard protocol; its WebAssembly export interface carries no image, sixel or graphics entry, so it has no public image store or APC callback",
}

const GHOSTTY_NATIVE_D2_DECLARATIONS: Readonly<Record<string, string>> = {
  "editing.decsace":
    "Untestable (no way): the library offers no reading or input our test could use for this feature: Ghostty 1.3.1 has no DECSACE handler or character-attribute extent state.",
  "extensions.osc633-a":
    "Untestable (no way): the library offers no reading or input our test could use for this feature: Ghostty 1.3.1 has no handler for OSC 633 and keeps no VS Code shell-integration state.",
  "extensions.osc633-b":
    "Untestable (no way): the library offers no reading or input our test could use for this feature: Ghostty 1.3.1 has no handler for OSC 633 and keeps no VS Code shell-integration state.",
  "extensions.osc633-c":
    "Untestable (no way): the library offers no reading or input our test could use for this feature: Ghostty 1.3.1 has no handler for OSC 633 and keeps no VS Code shell-integration state.",
  "extensions.osc633-d":
    "Untestable (no way): the library offers no reading or input our test could use for this feature: Ghostty 1.3.1 has no handler for OSC 633 and keeps no VS Code shell-integration state.",
  "extensions.osc633-e":
    "Untestable (no way): the library offers no reading or input our test could use for this feature: Ghostty 1.3.1 has no handler for OSC 633 and keeps no VS Code shell-integration state.",
  "extensions.osc-633-vscode":
    "Untestable (no way): the library offers no reading or input our test could use for this feature: Ghostty 1.3.1 has no handler for OSC 633 and keeps no VS Code shell-integration state.",
  "extensions.osc1-icon": "Ghostty 1.3.1 parses OSC 1 and ignores it. No icon state or action follows.",
  "extensions.osc113-reset-pointer-fg":
    "Ghostty 1.3.1 parses OSC 113 and does nothing with it. It keeps no pointer colour.",
  "extensions.osc114-reset-pointer-bg":
    "Ghostty 1.3.1 parses OSC 114 and does nothing with it. It keeps no pointer colour.",
  "extensions.osc117-reset-highlight-bg":
    "Ghostty 1.3.1 parses OSC 117 and does nothing with it. It keeps no highlight colour.",
  "extensions.osc119-reset-highlight-fg":
    "Ghostty 1.3.1 parses OSC 119 and does nothing with it. It keeps no highlight colour.",
  "modes.decsscls": "Ghostty 1.3.1 has no handler for this sequence and no scroll-speed state.",
  "input.kitty-click-events":
    "Untestable: Ghostty 1.3.1 core stores click_events, but only Surface acts on a click, and Surface is the app.",
}

function declaredD2InterfaceAbsence(
  ctx: LibProbeSource,
  lib: (ctx: LibProbeSource) => ProbeCallbackResult,
  id: string,
  table: Readonly<Record<string, string | { readonly backend: string; readonly reason: string }>>,
  backend: string,
  cohort:
    | "osc-absence"
    | "vt100-rust-d2"
    | "vterm-d2"
    | "osc-tap"
    | "ghostty-native-d2"
    | "wezterm-d2"
    | "ghostty-web-d2"
    | "host-effect-h4",
  hasReader: (ctx: LibProbeSource, id: string) => boolean = () => false,
  formatReason: (entry: string) => string = (entry) => entry,
  options: { readonly genericReportIsObservable?: boolean } = {},
): ProbeCallbackResult | undefined {
  const declaration = table[id]
  const entry =
    typeof declaration === "string"
      ? declaration
      : declaration !== undefined && declaration.backend === ctx.backendName
        ? declaration.reason
        : undefined
  if (!entry || ctx.backendName !== backend || !hasAuditedOscInterfaceAbsence(ctx, cohort)) return undefined
  const result = lib(ctx)
  if (
    (options.genericReportIsObservable !== false && typeof ctx.getUnhandledSequences === "function") ||
    hasReader(ctx, id) ||
    reportsDecidedOutcome(result)
  ) {
    return result
  }
  const declared = declaredUntestableResult(formatReason(entry), {
    backend: ctx.backendName,
    featureId: id,
    runtimeIdentity: evidenceRuntimeIdentity(ctx.runtimeIdentity),
  })
  return result.hostRecipeCauses ? { ...declared, hostRecipeCauses: result.hostRecipeCauses } : declared
}

// CTO Kitty 16:50: shell3/reset2 already use the generic OSC report consumer.
// These six uncovered routes use their own literal payload and the same canonical controls.
const KITTY_D2_NEGATIVES: Readonly<Record<string, { readonly feed: string; readonly code: UnhandledSequence }>> = {
  "extensions.osc3008-context": { feed: "\x1b]3008;type=test\x07", code: { kind: "osc", code: "3008" } },
  "extensions.osc176-app-id": { feed: "\x1b]176;terminfo-test\x07", code: { kind: "osc", code: "176" } },
  "extensions.osc440-audio": { feed: "\x1b]440;bell.wav\x07", code: { kind: "osc", code: "440" } },
  "extensions.osc555-flash": { feed: "\x1b]555\x07", code: { kind: "osc", code: "555" } },
  "extensions.osc666-termprop": { feed: "\x1b]666;test-prop=value\x07", code: { kind: "osc", code: "666" } },
  "extensions.osc710-font-normal": { feed: "\x1b]710;monospace\x07", code: { kind: "osc", code: "710" } },
  "modes.decsscls": { feed: "\x1b[9 p", code: { kind: "csi", code: " p" } },
}

const WEZTERM_D2_ABSENCES: Readonly<Record<string, string>> = {
  "extensions.osc113-reset-pointer-fg":
    "OSC 113 has a recognized empty handler arm; pointer foreground is absent from the public palette, there is no query reply, and PaletteChanged carries no value",
  "extensions.osc114-reset-pointer-bg":
    "OSC 114 has a recognized empty handler arm; pointer background is absent from the public palette, there is no query reply, and PaletteChanged carries no value",
  "extensions.osc22-pointer":
    "OSC 22 has no handler; its only trace is an opt-in log-facade line, off in this embedding",
  "modes.decsscls": "DECSSCLS has no handler; its only trace is an opt-in log-facade line, off in this embedding",
  "extensions.osc176-app-id":
    "OSC 176 has no host route through the public library API; the opt-in log-facade line is off in this embedding",
  "extensions.osc3008-context":
    "OSC 3008 has no host route through the public library API; the opt-in log-facade line is off in this embedding",
  "extensions.osc440-audio":
    "OSC 440 has no host route through the public library API; the opt-in log-facade line is off in this embedding",
  "extensions.osc555-flash":
    "OSC 555 has no host route through the public library API; the opt-in log-facade line is off in this embedding",
  "extensions.osc666-termprop":
    "OSC 666 has no host route through the public library API; the opt-in log-facade line is off in this embedding",
  "extensions.osc710-font-normal":
    "OSC 710 has no host route through the public library API; the opt-in log-facade line is off in this embedding",
  "editing.decsace": "DECSACE has no handler; its only trace is an opt-in log-facade line, off in this embedding",
  "extensions.osc52-read":
    "OSC 52 QuerySelection has a recognized empty handler arm and emits no clipboard query reply",
  "extensions.osc133-d": "OSC 133 D has a recognized empty handler arm and retains no command-exit status",
  "extensions.semantic-prompts":
    "OSC 133 D retains no command-exit status, so the public semantic marks cannot expose a complete prompt-command cycle",
  "extensions.osc633-a": "OSC 633 has no handler; its only trace is an opt-in log-facade line, off in this embedding",
  "extensions.osc633-b": "OSC 633 has no handler; its only trace is an opt-in log-facade line, off in this embedding",
  "extensions.osc633-c": "OSC 633 has no handler; its only trace is an opt-in log-facade line, off in this embedding",
  "extensions.osc633-d": "OSC 633 has no handler; its only trace is an opt-in log-facade line, off in this embedding",
  "extensions.osc633-e": "OSC 633 has no handler; its only trace is an opt-in log-facade line, off in this embedding",
  "extensions.osc-633-vscode":
    "OSC 633 has no handler; its only trace is an opt-in log-facade line, off in this embedding",
}

// CTO21:07 Slice C: only these DEC cells gain report routes. Lists are the
// reports from each probe's own payload, not a substituted compound control.
const DEC_COLOUR_REPORTS: Readonly<Record<string, Parameters<typeof unhandledSequenceVerdict>[1]>> = {
  "sgr.fg.standard": { feed: "\x1b[31m", code: { kind: "csi", code: "31m" } },
  "sgr.bg.standard": { feed: "\x1b[41m", code: { kind: "csi", code: "41m" } },
  "sgr.fg.bright": { feed: "\x1b[91m", code: { kind: "csi", code: "91m" } },
  "sgr.bg.bright": { feed: "\x1b[101m", code: { kind: "csi", code: "101m" } },
  "sgr.fg.default": { feed: "\x1b[39m", code: { kind: "csi", code: "39m" } },
  "sgr.bg.default": { feed: "\x1b[49m", code: { kind: "csi", code: "49m" } },
  "extensions.osc2-title": { feed: "\x1b]2;Test Title\x07", code: { kind: "osc", code: "2" } },
  "sgr.fg.256": {
    feed: "\x1b[38;5;173m\x1b[0m",
    codes: [
      { kind: "csi", code: "38m" },
      { kind: "csi", code: "173m" },
    ],
  },
  "sgr.bg.256": {
    feed: "\x1b[48;5;173m\x1b[0m",
    codes: [
      { kind: "csi", code: "48m" },
      { kind: "csi", code: "173m" },
    ],
  },
  "sgr.fg.truecolor": {
    feed: "\x1b[38;2;17;97;201m",
    codes: ["38m", "2m", "17m", "97m", "201m"].map((code) => ({ kind: "csi", code })),
  },
  "sgr.bg.truecolor": {
    feed: "\x1b[48;2;17;97;201m",
    codes: ["48m", "2m", "17m", "97m", "201m"].map((code) => ({ kind: "csi", code })),
  },
  "extensions.truecolor": {
    feed: "\x1b[38;2;17;97;201m",
    codes: ["38m", "2m", "17m", "97m", "201m"].map((code) => ({ kind: "csi", code })),
  },
  "extensions.osc633-p": { feed: "\x1b]633;P;Cwd=/terminfo-633-cwd-A\x07", code: { kind: "osc", code: "633" } },
}

// Rejection of the prerequisite makes the dependent claim untestable in THIS
// run. Versions never stand in for this setup report (CTO ruling6).
const DEC_SETUP_REPORTS: Readonly<Record<string, Parameters<typeof unhandledSequenceVerdict>[1]>> = {
  "erase.el-with-attrs": { feed: "\x1b[42m", code: { kind: "csi", code: "42m" } },
  "device.xtwinops-22": { feed: "\x1b]2;pushed-title\x07", code: { kind: "osc", code: "2" } },
  "device.xtwinops-23": { feed: "\x1b]2;pushed-title\x07", code: { kind: "osc", code: "2" } },
  "modes.alt-screen.exit": { feed: "\x1b[?1049h", code: { kind: "csi", code: "?1049h" } },
  "sgr.selective-reset.italic": { feed: "\x1b[3m", code: { kind: "csi", code: "3m" } },
}

/** One registry consumer; other subjects and decided results retain their existing path. */
export function withD2LibraryObservation(definition: ProbeDefinition): ProbeDefinition {
  const lib = definition.lib
  const decClipboard = definition.id === "extensions.osc52-clipboard" || definition.id === "extensions.osc52-write"
  const decTarget = DEC_COLOUR_REPORTS[definition.id]
  const decSetup = DEC_SETUP_REPORTS[definition.id]
  const decsace = definition.id === "editing.decsace"
  const vt100Target = VT100_RUST_D2_NEGATIVES[definition.id]
  const kittyTarget = KITTY_D2_NEGATIVES[definition.id]
  const reason = VT100_RUST_D2_DECLARATIONS[definition.id]
  const absence = ALACRITTY_D2_ABSENCES[definition.id]
  const vtermReason = VTERM_D2_DECLARATIONS[definition.id]
  const passThroughReason = OSC_PASS_THROUGH_DECLARATIONS[definition.id]
  const appJob = APP_JOB_OSCS[definition.id]
  const ghosttyNativeReason = GHOSTTY_NATIVE_D2_DECLARATIONS[definition.id]
  const weztermAbsence = WEZTERM_D2_ABSENCES[definition.id]
  const imageDeclared =
    ALACRITTY_IMAGE_D2_DECLARATIONS[definition.id] ??
    XTERM_IMAGE_D2_DECLARATIONS[definition.id] ??
    VT100_IMAGE_D2_DECLARATIONS[definition.id] ??
    VT220_IMAGE_D2_DECLARATIONS[definition.id] ??
    GHOSTTY_WEB_IMAGE_D2_DECLARATIONS[definition.id]
  if (
    !lib ||
    (!decClipboard &&
      !decTarget &&
      !decSetup &&
      !decsace &&
      !vt100Target &&
      !kittyTarget &&
      !reason &&
      !absence &&
      !vtermReason &&
      !appJob &&
      !passThroughReason &&
      !ghosttyNativeReason &&
      !weztermAbsence &&
      !imageDeclared)
  ) {
    return definition
  }
  return {
    ...definition,
    ...((vt100Target || decClipboard) &&
    (definition.libAssertionType === "query_reply" || definition.libAssertionType === "input_bytes")
      ? {
          // A report verdict records buffer_state; the probe's own arm keeps its type.
          libAssertionType: {
            when: (source: Pick<LibProbeSource, "getUnhandledSequences">) =>
              typeof source.getUnhandledSequences === "function",
            then: [definition.libAssertionType, "buffer_state"] as const,
            otherwise: [definition.libAssertionType] as const,
          },
        }
      : {}),
    lib(ctx) {
      const handoff = appJobHandoff(ctx, definition.id, lib)
      if (handoff) return handoff
      if ((ctx.backendName === "vt100" || ctx.backendName === "vt220") && decClipboard) {
        return unhandledOscReportResult(ctx, "\x1b]52;c;dGVybWluZm8=\x07", lib(ctx))
      }
      if ((ctx.backendName === "vt100" || ctx.backendName === "vt220") && (decTarget || decSetup || decsace)) {
        const result = lib(ctx)
        if (reportsDecidedOutcome(result)) return result
        if (decsace) {
          return ctx.runtimeIdentity?.engineVersion === "0.13.1"
            ? declaredUntestableResult(
                `${ctx.backendName} 0.13.1 exposes no DECSACE extent state or effect reader through its public Screen API.`,
                { backend: ctx.backendName, engineVersion: ctx.runtimeIdentity.engineVersion },
              )
            : result
        }
        const target = decTarget ?? decSetup
        if (!target) return result
        const cursor = ctx.getCursor()
        const reported = unhandledSequenceVerdict(
          ctx,
          target,
          {
            feed: "\x1b[0m\x1b[1mC",
            applied: () => ctx.getCell(cursor.y, cursor.x).bold === true,
            cleanup: "\x1b[0m",
          },
          { featureId: definition.id, ...(result.response !== undefined && { body: result.response }) },
        )
        if (decSetup && reported) {
          return declaredUntestableResult(
            `${definition.id}: the library reported its setup sequence as unhandled; the dependent effect cannot be observed in this run.`,
            { setup: target.feed, report: reported.response },
          )
        }
        if (decSetup) {
          return notTestedResult(
            `${definition.id}: setup rejection with a handled SGR 1 control was not qualified in this run`,
            { setup: target.feed, body: result },
          )
        }
        return reported ?? result
      }
      const passThroughDeclared = declaredD2InterfaceAbsence(
        ctx,
        lib,
        definition.id,
        OSC_PASS_THROUGH_DECLARATIONS,
        ctx.backendName,
        "osc-tap",
        undefined,
        undefined,
        { genericReportIsObservable: false },
      )
      if (passThroughDeclared) return passThroughDeclared
      const ghosttyNativeDeclared = declaredD2InterfaceAbsence(
        ctx,
        lib,
        definition.id,
        GHOSTTY_NATIVE_D2_DECLARATIONS,
        "ghostty-native",
        "ghostty-native-d2",
        (source, id) => id === "extensions.osc1-icon" && typeof source.getIconLabel === "function",
      )
      if (ghosttyNativeDeclared) return ghosttyNativeDeclared
      const alacrittyDeclared = declaredD2InterfaceAbsence(
        ctx,
        lib,
        definition.id,
        ALACRITTY_D2_ABSENCES,
        "alacritty",
        "osc-absence",
        (source, id) =>
          id === "extensions.osc9-progress"
            ? typeof source.getProgress === "function"
            : id === "extensions.osc777-notify"
              ? typeof source.getOsc777Payloads === "function" || typeof source.getToasts === "function"
              : id.startsWith("extensions.osc133") ||
                  id.startsWith("extensions.osc633") ||
                  id === "extensions.osc-633-vscode" ||
                  id === "extensions.semantic-prompts"
                ? typeof source.getSemanticMarks === "function"
                : false,
        (entry) =>
          `Alacritty alacritty_terminal 0.26.0 / VTE 0.15.0 exposes no public state, reply or typed event for ${entry}; this ${definition.id === "editing.decsace" ? "CSI" : "OSC"} has no handler or public rejection report.`,
      )
      if (alacrittyDeclared) return alacrittyDeclared
      // CTO 8be19f1f: the Kitty image pair. No reader is passed because none of these libraries
      // exposes a public image store or callback; if one ever gains it, its gate stops matching.
      const alacrittyImageDeclared = declaredD2InterfaceAbsence(
        ctx,
        lib,
        definition.id,
        ALACRITTY_IMAGE_D2_DECLARATIONS,
        "alacritty",
        "osc-absence",
      )
      if (alacrittyImageDeclared) return alacrittyImageDeclared
      const xtermImageDeclared = declaredD2InterfaceAbsence(
        ctx,
        lib,
        definition.id,
        XTERM_IMAGE_D2_DECLARATIONS,
        "xterm",
        "osc-tap",
      )
      if (xtermImageDeclared) return xtermImageDeclared
      const vt100ImageDeclared = declaredD2InterfaceAbsence(
        ctx,
        lib,
        definition.id,
        VT100_IMAGE_D2_DECLARATIONS,
        "vt100",
        "osc-absence",
        undefined,
        undefined,
        // The generic report lists OSC and CSI only, never APC, so it cannot speak to an image command.
        { genericReportIsObservable: false },
      )
      if (vt100ImageDeclared) return vt100ImageDeclared
      const vt220ImageDeclared = declaredD2InterfaceAbsence(
        ctx,
        lib,
        definition.id,
        VT220_IMAGE_D2_DECLARATIONS,
        "vt220",
        "osc-absence",
        undefined,
        undefined,
        { genericReportIsObservable: false },
      )
      if (vt220ImageDeclared) return vt220ImageDeclared
      const ghosttyWebImageDeclared = declaredD2InterfaceAbsence(
        ctx,
        lib,
        definition.id,
        GHOSTTY_WEB_IMAGE_D2_DECLARATIONS,
        "ghostty",
        "ghostty-web-d2",
        undefined,
        undefined,
        { genericReportIsObservable: false },
      )
      if (ghosttyWebImageDeclared) return ghosttyWebImageDeclared
      const vtermDeclared = declaredD2InterfaceAbsence(
        ctx,
        lib,
        definition.id,
        VTERM_D2_DECLARATIONS,
        "vterm",
        "vterm-d2",
        (source) => source.capabilities.extensions.has("semantic-command-end"),
      )
      if (vtermDeclared) return vtermDeclared
      const weztermDeclared = declaredD2InterfaceAbsence(
        ctx,
        lib,
        definition.id,
        WEZTERM_D2_ABSENCES,
        "wezterm",
        "wezterm-d2",
        undefined,
        (entry) => `WezTerm tattoy-wezterm-term 0.1.0-fork.5: ${entry}.`,
      )
      if (weztermDeclared) return weztermDeclared
      if (appJob && kittyTarget && ctx.backendName === "ghostty-native") {
        const declared = declaredD2InterfaceAbsence(
          ctx,
          lib,
          definition.id,
          APP_JOB_OSCS,
          "ghostty-native",
          "host-effect-h4",
          undefined,
          () =>
            `Ghostty 1.3.1 native bridge exposes no public state, report or payload route for OSC ${kittyTarget.code.code} at this audited engine/bridge identity.`,
        )
        if (declared) return declared
      }
      const identity = ctx.runtimeIdentity
      const vt100Audited = hasAuditedOscInterfaceAbsence(ctx, "vt100-rust-d2")
      if (vt100Audited && reason) {
        return declaredUntestableResult(reason, { backend: ctx.backendName, runtimeIdentity: ctx.runtimeIdentity })
      }
      const hostEffectReport = appJob && ["vt100", "vt220", "ghostty"].includes(ctx.backendName)
      const target = hostEffectReport
        ? kittyTarget
        : vt100Audited
          ? vt100Target
          : ctx.backendName === "kitty" &&
              identity?.kind === "native" &&
              identity.engineVersion === "0.49.2" &&
              identity.loadedBinary.sha256 === "bb65c2d57e56eecca8143d73771432cf7dd386bccd36ae658950e5923a661886"
            ? kittyTarget
            : undefined
      if (!target) return lib(ctx)
      const result = lib(ctx)
      if (reportsDecidedOutcome(result)) return result
      const cursor = ctx.getCursor()
      return (
        unhandledSequenceVerdict(
          ctx,
          target,
          target.code.kind === "osc"
            ? {
                feed: "\x1b]2;" + UNHANDLED_OSC_CONTROL_TITLE + "\x07",
                applied: () => ctx.getTitle() === UNHANDLED_OSC_CONTROL_TITLE,
              }
            : {
                feed: "\x1b[0m\x1b[1mC",
                applied: () => ctx.getCell(cursor.y, cursor.x).bold === true,
                cleanup: "\x1b[0m",
              },
          { featureId: definition.id, ...(result.response !== undefined && { body: result.response }) },
          hostEffectReport
            ? {
                proves: { kind: "osc", code: "2" },
                arm: () => ({
                  feed: "\x1b[0m\x1b[1mC",
                  applied: () => ctx.getCell(cursor.y, cursor.x).bold === true,
                  cleanup: "\x1b[0m",
                }),
              }
            : undefined,
        ) ?? result
      )
    },
  }
}
