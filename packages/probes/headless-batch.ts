/** Internal production adapter and isolated result collection for one Termless engine. */
/* oxlint-disable typescript/no-deprecated -- Current Termless resolve() adapters expose TerminalBackend lifecycle; Emulator does not yet replace that loader. */

import {
  hasExtension,
  type HyperlinkExtension,
  type DefaultColorsExtension,
  type MouseEncodingExtension,
  type PasteEncodingExtension,
  type KeyEncodingExtension,
  type OscMetadataExtension,
  type SemanticMarkExtension,
  type SixelStorageExtension,
  type TerminalBackend,
  type WarningExtension,
} from "@termless/core"
import {
  HARNESS_INCOMPLETE_TEST,
  readHyperlinkMetadata,
  readSentinelReply,
  recordExecutedProbe,
  finalizeSgrResult,
  ASSERTION_TYPES,
  sentinelAnswer,
  sentinelGraceMs,
  collectorAttemptDigest,
  readCollectorAttempt,
  recordCollectorAttempt,
  withReplyFailureEvidence,
  finalizeProbeResult,
} from "@terminfo/probe-defs"
import type {
  AssertionType,
  ProbeResult,
  RunDraft,
  NotTestedCoverage,
  Observation,
  ProbeAssertion,
  ProbeDefinition,
  ProbeCallbackResult,
  TerminalQueryOutcome,
  LibProbeSource,
  UngradedDiagnostic,
  HeadlessRuntimeIdentity,
  RetainedHostRecipeCause,
  CollectorAttempt,
} from "@terminfo/probe-defs"
import { validateHostRecipeCauses } from "@terminfo/run-parser"
import { headlessRuntimeIdentity, readAdapterSources, type HeadlessProbeRuntime } from "./headless-identity.ts"
import { isDeepStrictEqual } from "node:util"
import { HEADLESS_TERMINAL } from "./headless-terminal.ts"
import { notTestedResult, NO_SAME_PATH_CONTROL } from "../probe-defs/src/helpers.ts"

/** Finalize the existing attempt without breaking its source-audited host-input citations. */
export function finalizeHeadlessAttempt(
  draft: Pick<RunDraft, "rawReplies" | "runId" | "runtimeIdentity">,
  attempt: CollectorAttempt,
  definitions: readonly Pick<ProbeDefinition, "id" | "libHostRecipes">[],
): void {
  const hostKeys = Object.keys(draft.rawReplies).filter((key) => key.startsWith("collector.hostRecipes."))
  if (hostKeys.length === 0) {
    recordCollectorAttempt(draft, attempt)
    return
  }
  const staged = { rawReplies: { ...draft.rawReplies } }
  recordCollectorAttempt(staged, attempt)
  const oldRaw = draft.rawReplies["collector.collectionAttempt"]
  const newRaw = staged.rawReplies["collector.collectionAttempt"]
  if (oldRaw === newRaw) return
  const previous = readCollectorAttempt(draft.rawReplies)
  const next = readCollectorAttempt(staged.rawReplies)
  if (!oldRaw || !newRaw || !previous?.startedAt || !next) {
    throw new Error("Headless attempt finalization requires the original recorded start")
  }
  if (
    !isDeepStrictEqual(
      { ...previous, result: undefined, error: undefined },
      { ...next, result: undefined, error: undefined },
    )
  ) {
    throw new Error("Headless attempt finalization changed ids, start or retained host inputs")
  }
  if (previous.result === "completed" || previous.result === "failed" || previous.result === "cancelled") {
    if (previous.result === next.result) return
    throw new Error("Headless attempt finalization cannot change a terminal outcome")
  }
  if (previous.result !== undefined && previous.result !== "started") {
    throw new Error("Headless attempt finalization requires a started or legacy attempt")
  }
  if (next.result !== "completed" && next.result !== "failed" && next.result !== "cancelled") {
    throw new Error("Headless attempt finalization requires a terminal outcome")
  }
  if (!draft.runtimeIdentity) throw new Error("Headless attempt finalization lacks measured runtime identity")
  const oldDigest = collectorAttemptDigest(oldRaw)
  const newDigest = collectorAttemptDigest(newRaw)
  const records = hostKeys.map((key) => {
    const featureId = key.slice("collector.hostRecipes.".length)
    const definition = definitions.find((candidate) => candidate.id === featureId)
    if (!definition) {
      throw new Error(`Headless attempt finalization lacks host expectations for ${featureId}`)
    }
    const expectations = definition.libHostRecipes ?? []
    try {
      const record = validateHostRecipeCauses(
        "headless attempt finalization",
        draft.runId,
        featureId,
        expectations,
        draft.rawReplies,
        draft.runtimeIdentity,
      )
      return { key, featureId, expectations, record }
    } catch (error) {
      if (error instanceof Error && error.message.endsWith("host recipe: stale declared-input digest")) {
        throw new Error(`Headless host citation stale before finalization: ${featureId}`, { cause: error })
      }
      throw error
    }
  })
  for (const { key, featureId, record } of records) {
    let changed = false
    const causes = record.causes.map((entry) => {
      const cause = entry.cause
      if (cause.kind !== "source-audited" || cause.citation.inputRecordRef !== "collector.collectionAttempt") {
        return entry
      }
      if (cause.citation.sha256 !== oldDigest) {
        throw new Error(`Headless host citation stale before finalization: ${featureId}`)
      }
      changed = true
      return { ...entry, cause: { ...cause, citation: { ...cause.citation, sha256: newDigest } } }
    })
    if (changed) staged.rawReplies[key] = JSON.stringify({ ...record, causes })
  }
  for (const { featureId, expectations } of records) {
    validateHostRecipeCauses(
      "headless attempt finalization",
      draft.runId,
      featureId,
      expectations,
      staged.rawReplies,
      draft.runtimeIdentity,
    )
  }
  draft.rawReplies = staged.rawReplies
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/** The DA1 query the sentinel member sends in its own capture, as the live collector appends it. */
const DA1_QUERY = "\x1b[c"
const CPR_SPOTS = [
  [3, 7],
  [5, 11],
  [7, 13],
  [9, 17],
  [11, 19],
] as const
type QueryFact = { sequence: string; matched: boolean; empty: boolean; controlError?: string }
type QueryPass = {
  control: boolean
  wait: boolean
  brackets?: readonly [readonly [number, number], readonly [number, number]]
}

function cprCapture(backend: TerminalBackend, spot: readonly [number, number], captures: HostQueryCapture[]): boolean {
  const [row, col] = spot
  return feedCapture(backend, `\x1b[${row};${col}H\x1b[6n`, captures) === `\x1b[${row};${col}R`
}

function bracketOutcome(
  backend: TerminalBackend,
  sequence: string,
  pattern: RegExp,
  spots: readonly [readonly [number, number], readonly [number, number]],
  captures: HostQueryCapture[],
  proven: ProvenReplyPath,
): { outcome: TerminalQueryOutcome; fact: QueryFact } {
  const at = Date.now()
  const reply = feedCapture(backend, sequence, captures)
  const match = reply.match(pattern)
  const first = cprCapture(backend, spots[0], captures)
  const tail = cprCapture(backend, spots[1], captures)
  const raw = captures
    .slice(-3)
    .map((capture) => capture.response)
    .join("")
  const captured = { raw, rawBase64: Buffer.from(raw).toString("base64") }
  const fact = {
    sequence,
    matched: match !== null,
    empty: reply === "",
    ...(!first || !tail
      ? { controlError: "CPR bracket or tail missing, wrong coordinate, or containing late bytes" }
      : {}),
  }
  if (match) return { outcome: { match: [...match], reason: "reply", ...captured }, fact }
  if (!first || !tail) return { outcome: { match: null, reason: "timeout", ...captured }, fact }
  proven.onSentinel()
  return {
    outcome: {
      match: null,
      reason: "sentinel",
      sentinel: { atMs: Date.now() - at, graceMs: proven.graceMs },
      ...captured,
    },
    fact,
  }
}

/** A proven reply path, as the collector hands it to one probe's context (#30554). */
export interface ProvenReplyPath {
  /** The grace window this pass reads, recorded in every sentinel outcome and waited out by G1. */
  readonly graceMs: number
  /** Called each time the member returns a `sentinel` outcome, so the collector listens before destroy. */
  readonly onSentinel: () => void
}

interface HostQueryCapture {
  query: string
  response: string
  error: string | null
  /** A-prime (@cto 4ac8b275): zero bytes beside a callback this harness did not reproduce. */
  cause?: { kind: "harness-unreproduced"; callbacks: string[] }
}

/** The warning code an adapter reports for an engine callback it does not reproduce (termless kitty). */
const UNREPRODUCED_CALLBACK = "UNREPRODUCED_CALLBACK"

/** Per probe: each capture that reached an unreproduced callback, and whether any of them returned zero bytes. */
interface UnreproducedRecord {
  captures: { query: string; callbacks: string[] }[]
  silent: boolean
}

/** Drain the adapter's warnings, keeping only the unreproduced callbacks, classified by code. */
function drainUnreproduced(backend: TerminalBackend): string[] {
  if (!hasExtension<WarningExtension>(backend, "warnings")) return []
  const callbacks = backend
    .getWarnings()
    .filter((warning) => warning.code === UNREPRODUCED_CALLBACK)
    .map((warning) => warning.message)
  backend.clearWarnings()
  return callbacks
}

/** Capture one query, including adapters that parse pending input on state reads. */
export function feedCapture(
  backend: TerminalBackend,
  text: string,
  captures: HostQueryCapture[] | undefined,
  unreproduced?: UnreproducedRecord,
): string {
  let response = ""
  let error: string | null = null
  let callbacks: string[] = []
  const previous = backend.onResponse
  try {
    // Pending input belongs to the previous listener, not this query.
    backend.getCursor()
    backend.onResponse = (bytes) => {
      response += decoder.decode(bytes)
    }
    backend.feed(encoder.encode(text))
    backend.getCursor()
    if (unreproduced) {
      callbacks = drainUnreproduced(backend)
      if (callbacks.length) {
        unreproduced.captures.push({ query: text, callbacks })
        if (!response) unreproduced.silent = true
      }
    }
  } catch (cause) {
    error = errorMessage(cause)
    throw cause
  } finally {
    backend.onResponse = previous
    const silent = callbacks.length > 0 && response === "" && error === null
    captures?.push({
      query: text,
      response,
      error,
      ...(silent && { cause: { kind: "harness-unreproduced" as const, callbacks } }),
    })
  }
  return response
}

/**
 * F1 (27832) on a proven headless engine (#30554): the query in one capture, then DA1 in a capture of
 * its own, read with the live collector's rule. Two captures keep the order a real terminal produces,
 * the query's replies before the DA1 answer, even where an adapter answers only after its engine has
 * run the whole feed (libvterm, vt100 and vt220 did for 14t and 18t until #30549). The capture is
 * synchronous, so the read is decided once. A DA1 capture with no DA1 answer has ended the way live's
 * timeout does: no sentinel facts, and never the `sentinel` outcome. Once DA1 answered, bytes ahead of
 * its answer that match nothing end as live's do, in the `sentinel` outcome over those bytes, which
 * the probe never treats as silence (#30559, @cto 86260f80).
 */
function sentinelOutcome(
  backend: TerminalBackend,
  sequence: string,
  pattern: RegExp,
  proven: ProvenReplyPath,
  captures: HostQueryCapture[] | undefined,
  unreproduced: UnreproducedRecord | undefined,
): TerminalQueryOutcome {
  const writeAt = Date.now()
  const reply = feedCapture(backend, sequence, captures, unreproduced)
  const answer = feedCapture(backend, DA1_QUERY, captures, unreproduced)
  const raw = reply + answer
  const captured = { raw, rawBase64: Buffer.from(raw).toString("base64") }
  const read = readSentinelReply(raw, pattern)
  if (read.kind === "reply") return { match: read.match, reason: "reply", ...captured }
  // Only a DA1 answer in a capture of its own ends the query: a DA1-shaped answer in the query's capture
  // is the engine's reply to it (@dev/8 9ab12dbe S4, @cto 86260f80 rule 4).
  const terminator = sentinelAnswer(answer)
  if (!terminator) {
    return { match: read.match, reason: read.match ? "reply" : "timeout", ...captured }
  }
  const sentinel = { atMs: Date.now() - writeAt, graceMs: proven.graceMs }
  const after = answer.slice(terminator.end).match(pattern)
  if (after) return { match: [...after], reason: "reply", ...captured, sentinel }
  proven.onSentinel()
  return { match: null, reason: "sentinel", ...captured, sentinel }
}

/**
 * G1 (#30554, @cto 452bc032): a proven path delivers every reply inside its capture, so any byte the
 * engine sends after the callback returned contradicts the proof. Listen through the grace window and
 * drain adapters that read pending input on state reads. Late bytes come back to the caller, which
 * refuses the callback's probe result as a collector error, never the negative it built on the silence.
 */
async function listenForLateReply(
  backend: TerminalBackend,
  graceMs: number,
): Promise<{ bytes: string; firstAtMs: number } | undefined> {
  const listenedAt = Date.now()
  let late: { bytes: string; firstAtMs: number } | undefined
  const previous = backend.onResponse
  backend.onResponse = (bytes) => {
    late ??= { bytes: "", firstAtMs: Date.now() - listenedAt }
    late.bytes += decoder.decode(bytes)
  }
  try {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, graceMs)
    })
    backend.getCursor()
  } finally {
    backend.onResponse = previous
  }
  return late?.bytes ? late : undefined
}

export function createLibProbeSource(
  backend: TerminalBackend,
  proven: ProvenReplyPath | undefined,
  runtimeIdentity: HeadlessRuntimeIdentity | undefined,
  captures: HostQueryCapture[] | undefined,
  unreproduced?: UnreproducedRecord,
): LibProbeSource {
  let cols: number
  try {
    cols = backend.getRow(0).length
  } catch (cause) {
    throw new Error(`${backend.name} has no initialized row 0 grid for headless probes`, { cause })
  }
  if (!Number.isSafeInteger(cols) || cols < 1) {
    throw new Error(`${backend.name} returned invalid initialized grid width ${cols}`)
  }
  if (cols !== 80) throw new Error(`${backend.name} initialized ${cols} columns; requested 80`)
  const readLink =
    hasExtension<HyperlinkExtension>(backend, "hyperlinks") && typeof backend.getHyperlinkAt === "function"
      ? backend.getHyperlinkAt.bind(backend)
      : undefined
  const readDefaultColors =
    hasExtension<DefaultColorsExtension>(backend, "default-colors") && typeof backend.getDefaultColors === "function"
      ? backend.getDefaultColors.bind(backend)
      : undefined
  const readIconLabel = typeof backend.getIconLabel === "function" ? backend.getIconLabel.bind(backend) : undefined
  const metadata = hasExtension<OscMetadataExtension>(backend, "osc-metadata") ? backend : undefined
  const readCwd = typeof metadata?.getCwd === "function" ? metadata.getCwd.bind(metadata) : undefined
  const readNotifications =
    typeof metadata?.getNotifications === "function" ? metadata.getNotifications.bind(metadata) : undefined
  const readOsc777Payloads =
    typeof metadata?.getOsc777Payloads === "function" ? metadata.getOsc777Payloads.bind(metadata) : undefined
  const readProgress = typeof metadata?.getProgress === "function" ? metadata.getProgress.bind(metadata) : undefined
  const readToasts = typeof metadata?.getToasts === "function" ? metadata.getToasts.bind(metadata) : undefined
  const readUnhandledSequences =
    typeof metadata?.getUnhandledSequences === "function" ? metadata.getUnhandledSequences.bind(metadata) : undefined
  const readSemanticMarks =
    (hasExtension<SemanticMarkExtension>(backend, "semantic-marks") ||
      hasExtension<SemanticMarkExtension>(backend, "semantic-command-end")) &&
    typeof backend.getSemanticMarks === "function"
      ? backend.getSemanticMarks.bind(backend)
      : undefined
  const readSixelImages =
    hasExtension<SixelStorageExtension>(backend, "sixel-storage") && typeof backend.getSixelImages === "function"
      ? backend.getSixelImages.bind(backend)
      : undefined
  const readClipboardState =
    typeof backend.getClipboardState === "function" ? backend.getClipboardState.bind(backend) : undefined
  const declaresMouseEncoding = backend.capabilities.extensions.has("mouse-encoding")
  const candidateEncodeMouse = (backend as Partial<MouseEncodingExtension>).encodeMouse
  if (declaresMouseEncoding && typeof candidateEncodeMouse !== "function") {
    throw new Error(`${backend.name} declares capability extension "mouse-encoding" without an encodeMouse function`)
  }
  const encodeMouse =
    declaresMouseEncoding && typeof candidateEncodeMouse === "function" ? candidateEncodeMouse.bind(backend) : undefined
  const declaresPasteEncoding = backend.capabilities.extensions.has("paste-encoding")
  const candidateEncodePaste = (backend as Partial<PasteEncodingExtension>).encodePaste
  if (declaresPasteEncoding && typeof candidateEncodePaste !== "function") {
    throw new Error(`${backend.name} declares capability extension "paste-encoding" without an encodePaste function`)
  }
  const encodePaste =
    declaresPasteEncoding && typeof candidateEncodePaste === "function" ? candidateEncodePaste.bind(backend) : undefined
  const declaresKeyEncoding = backend.capabilities.extensions.has("key-encoding")
  const candidateEncodeKey = (backend as Partial<KeyEncodingExtension>).encodeKey
  if (declaresKeyEncoding && typeof candidateEncodeKey !== "function") {
    throw new Error(`${backend.name} declares capability extension "key-encoding" without an encodeKey function`)
  }
  const encodeKey =
    declaresKeyEncoding && typeof candidateEncodeKey === "function" ? candidateEncodeKey.bind(backend) : undefined
  return {
    backendName: backend.name,
    kind: "live",
    ...(runtimeIdentity && { runtimeIdentity }),
    cols,
    resize(cols, rows) {
      backend.resize(cols, rows)
    },
    getHyperlinkAt: readLink,
    getDefaultColors: readDefaultColors,
    getIconLabel: readIconLabel,
    getReflowState: typeof backend.getReflowState === "function" ? backend.getReflowState.bind(backend) : undefined,
    getCwd: readCwd,
    getNotifications: readNotifications,
    getOsc777Payloads: readOsc777Payloads,
    getProgress: readProgress,
    getToasts: readToasts,
    getUnhandledSequences: readUnhandledSequences,
    getSemanticMarks: readSemanticMarks,
    getSixelImages: readSixelImages,
    getClipboardState: readClipboardState,
    feed(text) {
      backend.feed(encoder.encode(text))
    },
    feedCapture(text) {
      return feedCapture(backend, text, captures, unreproduced)
    },
    ...(proven && {
      queryWithSentinelOutcome(sequence: string, pattern: RegExp) {
        return sentinelOutcome(backend, sequence, pattern, proven, captures, unreproduced)
      },
    }),
    getCell(row, col) {
      const cell = backend.getCell(row, col)
      const hyperlink = readHyperlinkMetadata(
        backend.capabilities.extensions.has("hyperlinks"),
        readLink,
        row,
        col,
        backend.name,
      )
      const { hyperlink: _unreported, ...withoutLink } = cell
      return { ...withoutLink, ...(hyperlink !== undefined && { hyperlink }) } as ReturnType<LibProbeSource["getCell"]>
    },
    getCursor() {
      return backend.getCursor()
    },
    getMode(mode): ReturnType<LibProbeSource["getMode"]> {
      return backend.getMode(mode as Parameters<TerminalBackend["getMode"]>[0])
    },
    getText() {
      return backend.getText()
    },
    getScrollback() {
      return backend.getScrollback()
    },
    ...(backend.capabilities.productViewport?.available !== false && {
      scrollViewport(delta: number) {
        backend.scrollViewport(delta)
      },
    }),
    ...(encodeMouse && { encodeMouse }),
    ...(encodePaste && { encodePaste }),
    ...(encodeKey && { encodeKey }),
    getTitle() {
      return backend.getTitle()
    },
    reset() {
      backend.reset()
    },
    get capabilities() {
      return backend.capabilities as LibProbeSource["capabilities"]
    },
  }
}

interface Batch {
  results: ProbeResult[]
  rawReplies: Record<string, string>
  observations: Observation[]
  assertions: ProbeAssertion[]
  notTested: NotTestedCoverage[]
  ungradedDiagnostics: Record<string, UngradedDiagnostic>
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** The exact callback bytes stay evidence on every path, coverage or refusal; nothing is synthesized here. */
function retainCallbackResponse(batch: Batch, id: string, result: ProbeCallbackResult): void {
  if (result.response !== undefined) batch.rawReplies[id] = result.response
}

/** A refused claim keeps its own observation detail and assertion contents in the error text, never as a claim. */
function refusedClaimEvidence(result: ProbeCallbackResult): string {
  const parts: string[] = []
  const observation = result.observation
  if (observation) {
    parts.push(
      `observation(${[
        `outcome=${observation.outcome}`,
        ...(observation.reason ? [`reason=${observation.reason}`] : []),
        `assertionType=${observation.assertionType}`,
        ...(observation.note ? [`note=${JSON.stringify(observation.note)}`] : []),
      ].join(", ")})`,
    )
  }
  for (const assertion of result.assertions ?? []) {
    parts.push(
      `assertion(${[
        `kind=${assertion.kind}`,
        `expected=${JSON.stringify(assertion.expected)}`,
        `observed=${JSON.stringify(assertion.observed)}`,
        ...(assertion.note ? [`note=${JSON.stringify(assertion.note)}`] : []),
      ].join(", ")})`,
    )
  }
  return parts.join(" and ")
}

/** A refusal's text names the claim it refused, so the run file keeps the probe conclusion. */
function withRefusedClaim(message: string, result: ProbeCallbackResult): string {
  const refused = refusedClaimEvidence(result)
  return refused ? `${message}; refused ${refused}` : message
}

/** A silent capture beside an unreproduced callback records a harness probe result, keeping the measured response beside it. */
function harnessIncompleteResult(
  backendName: string,
  record: UnreproducedRecord,
  measured: ProbeCallbackResult,
): ProbeCallbackResult {
  const callbacks = [...new Set(record.captures.flatMap((capture) => capture.callbacks))].join(", ")
  return {
    pass: false,
    response: JSON.stringify({
      unreproduced: { backend: backendName, captures: record.captures },
      measuredResponse: measured.response ?? null,
    }),
    tests: [
      {
        id: HARNESS_INCOMPLETE_TEST,
        status: "probe-invalid",
        reason: `Harness incomplete: ${backendName} did not reproduce ${callbacks}; silence is not evidence`,
      },
    ],
  }
}

/** A callback conclusion without its raw state cannot become a support claim. */
function recordResult(
  batch: Batch,
  probe: ProbeDefinition,
  result: ProbeCallbackResult,
  declared: readonly AssertionType[] | null | undefined,
): void {
  const id = probe.id
  if (result.notTested) {
    recordNotTested(batch, probe, result)
    return
  }
  retainCallbackResponse(batch, id, result)
  // The union makes one of the two records mandatory, so a typed callback always lands here
  // with a measurement. An untyped caller that returns neither gets a loud collector error
  // instead of the old legacy-callback diagnostic.
  const widened: { observation?: ProbeCallbackResult["observation"] } = result
  const explicit = widened.observation
  if (
    !explicit &&
    result.tests?.length &&
    result.tests.every(
      (test) =>
        (test.status === "probe-todo" || test.status === "probe-invalid") &&
        typeof test.reason === "string" &&
        test.reason.trim().length > 0,
    ) &&
    !result.assertions?.length
  ) {
    return
  }
  if (!explicit) {
    batch.ungradedDiagnostics[id] = {
      kind: "collector-error",
      name: "Error",
      message: withRefusedClaim(
        `Callback for ${id} returned neither an observation nor a not-tested coverage record; no probe result can be decided`,
        result,
      ),
    }
    return
  }
  if (!ASSERTION_TYPES.includes(explicit.assertionType)) {
    batch.ungradedDiagnostics[id] = {
      kind: "collector-error",
      name: "Error",
      message: withRefusedClaim(`Callback for ${id} returned no valid assertion type`, result),
    }
    return
  }
  // Undefined is undeclared; null explicitly declares no deciding typed observable.
  // Keep the existing loud mismatch refusal; classification never turns null into an observation.
  if (declared !== undefined && (declared === null || !declared.includes(explicit.assertionType))) {
    batch.observations.push({
      featureId: id,
      outcome: "error",
      reason: "collector-error",
      assertionType: explicit.assertionType,
      note: withRefusedClaim(
        `Lib callback ${id} declares ${declared === null ? "null" : declared.join(", ")} but returned ${explicit.assertionType}`,
        result,
      ),
      ...(result.response !== undefined ? { rawReplyRef: id } : {}),
    })
    return
  }
  const conclusive = explicit.outcome === "supported" || explicit.outcome === "unsupported"
  const bound = result.response !== undefined && result.response.length > 0
  const expectedKind = explicit.outcome === "supported" ? "positive" : "negative"
  const validAssertions = (result.assertions ?? []).filter(
    (assertion) => assertion.kind === expectedKind && assertion.expected.length > 0 && assertion.observed.length > 0,
  )
  const bindingInvalid =
    !bound ||
    validAssertions.length === 0 ||
    (result.assertions ?? []).some((assertion) => assertion.kind !== expectedKind) ||
    (explicit.assertionType === "buffer_state" &&
      !validAssertions.some((assertion) => assertion.observed === result.response))
  if (
    (conclusive && bindingInvalid) ||
    ((explicit.outcome === "error" || explicit.outcome === "inconclusive") && !explicit.reason)
  ) {
    batch.observations.push({
      featureId: id,
      outcome: "error",
      reason: "collector-error",
      assertionType: explicit.assertionType,
      note: withRefusedClaim(
        `Callback result lacks ${conclusive ? "matching raw state and assertion" : "an inconclusive/error reason"}`,
        result,
      ),
      ...(result.response !== undefined ? { rawReplyRef: id } : {}),
    })
    return
  }
  batch.observations.push({ featureId: id, ...explicit, ...(bound && { rawReplyRef: id }) })
  for (const assertion of result.assertions ?? []) {
    batch.assertions.push({ featureId: id, ...assertion, ...(bound && { rawReplyRef: id }) })
  }
}

/**
 * A named coverage record is admitted only after the probe ran and retained raw state. A missing raw
 * capture or an unclosed reason stays a loud collector error, never a not-tested claim, and a result
 * that also carries its own observation or assertions is contradictory and is refused the same way.
 */
function recordNotTested(batch: Batch, probe: ProbeDefinition, result: ProbeCallbackResult): void {
  const id = probe.id
  const notTested = result.notTested
  if (!notTested) return
  retainCallbackResponse(batch, id, result)
  const assertions = result.assertions ?? []
  if (result.observation !== undefined || assertions.length > 0) {
    const mixedMessage = `Not-tested coverage for ${id} arrived beside ${refusedClaimEvidence(result)}; a probe that claims no semantic observable cannot also carry a measurement, so the coverage claim is refused and its evidence stays a collector error`

    batch.ungradedDiagnostics[id] = { kind: "collector-error", name: "Error", message: mixedMessage }

    return
  }
  const response = result.response
  const bound = response !== undefined && response.length > 0
  const message =
    "Not-tested coverage for " + id + " requires a closed reason, a specific noObservable, and its retained raw capture"
  if (
    notTested.reason !== "no-semantic-observable" ||
    notTested.noObservable.trim().length === 0 ||
    response === undefined ||
    !bound
  ) {
    batch.ungradedDiagnostics[id] = { kind: "collector-error", name: "Error", message }

    return
  }
  batch.rawReplies[id] = response
  batch.notTested.push({
    featureId: id,
    reason: notTested.reason,
    noObservable: notTested.noObservable,
    rawReplyRef: id,
  })
}

async function collectPass(
  createBackend: () => Promise<TerminalBackend>,
  backendName: string,
  definitions: readonly ProbeDefinition[],
  draft?: Pick<RunDraft, "results" | "runId" | "rawReplies">,
  onCheckpoint?: (batch: Batch) => void,
  runtime?: HeadlessProbeRuntime,
  pass?: QueryPass,
): Promise<Batch> {
  // One read of the grace window per pass: every sentinel outcome records it and G1 waits it out.
  let graceMs: number | undefined
  const replyPath: {
    backend: string
    runtimeIdentity?: HeadlessRuntimeIdentity
    decisions: Record<string, { member: boolean; reason: string; runtimeIdentity?: HeadlessRuntimeIdentity }>
  } = { backend: backendName, ...(runtime && { runtimeIdentity: runtime.identity }), decisions: {} }
  const batch: Batch = {
    results:
      draft?.results ??
      definitions.map((probe) => ({
        featureId: probe.id,
        status: "probe-todo",
        attempt: { scope: "none" },
        tests: [],
        reason: "Required callback has not started",
      })),
    rawReplies: { ...draft?.rawReplies },
    observations: [],
    assertions: [],
    notTested: [],
    ungradedDiagnostics: {},
  }
  for (const probe of definitions) {
    if (!probe.lib) continue
    process.stderr.write(`headless ${backendName} probe ${probe.id}\n`)
    let backend: TerminalBackend | undefined
    const attempt = { scope: "probe" as const, startedAt: new Date().toISOString() }
    const activeIndex = batch.results.findIndex((result) => result.featureId === probe.id)
    const active = batch.results[activeIndex]
    if (!active) throw new Error(`Headless callback ${probe.id} is outside the initialized catalogue`)
    batch.results[activeIndex] = {
      ...active,
      attempt,
      reason: "Callback attempt started; no result recorded yet",
    }
    onCheckpoint?.(batch)
    let callbackTests: ProbeCallbackResult["tests"]
    let criterionBranch: string | undefined
    let hostRecord: { runId: string; captures: HostQueryCapture[]; causes: RetainedHostRecipeCause[] } | undefined
    const queryFacts: QueryFact[] = []
    let retainedCaptures: HostQueryCapture[] = []
    try {
      backend = await createBackend()
      backend.init(HEADLESS_TERMINAL)
      const initializedRuntime = runtime
        ? {
            ...runtime,
            identity: {
              ...(await headlessRuntimeIdentity(backendName, runtime.adapterPackage, runtime.adapterType)),
              adapterSources: readAdapterSources(backendName, backend),
            },
          }
        : undefined
      const hostRecipes = probe.libHostRecipes ?? []
      const nativeHostRoute = initializedRuntime?.identity.kind === "native"
      const usesHostRoute = hostRecipes.length > 0 && nativeHostRoute
      const decision = {
        member: pass?.control === true && !usesHostRoute,
        reason: usesHostRoute
          ? "probe uses its declared host recipe"
          : pass?.control
            ? "same-run CPR path control answered"
            : "same-run CPR path control did not answer",
      }
      const identityChanged =
        runtime !== undefined &&
        initializedRuntime !== undefined &&
        !isDeepStrictEqual(runtime.identity, initializedRuntime.identity)
      const reason = identityChanged
        ? `${backendName} initialized instance identity differs from the recorded run identity`
        : decision.reason
      replyPath.decisions[probe.id] = {
        member: decision.member && !identityChanged,
        reason,
        ...(initializedRuntime && { runtimeIdentity: initializedRuntime.identity }),
        ...(nativeHostRoute && { hostRecipes }),
      }
      batch.rawReplies["collector.replyPath"] = JSON.stringify(replyPath)
      if (identityChanged) throw new Error(reason)
      if (nativeHostRoute) {
        if (!draft) throw new Error("Native host recipe capture requires the actual run draft")
        hostRecord = { runId: draft.runId, captures: [], causes: [] }
      }
      const sentinel = { fired: false }
      const proven = decision.member
        ? {
            graceMs: pass?.wait === false ? 0 : (graceMs ??= sentinelGraceMs()),
            onSentinel: () => {
              sentinel.fired = true
            },
          }
        : undefined
      const unreproduced: UnreproducedRecord = { captures: [], silent: false }
      drainUnreproduced(backend) // Nothing reported before this probe's first capture belongs to it.
      const replyCaptures = hostRecord?.captures ?? []
      retainedCaptures = replyCaptures
      const ctx = createLibProbeSource(backend, proven, initializedRuntime?.identity, replyCaptures, unreproduced)
      const initializedBackend = backend
      const originalQuery = ctx.queryWithSentinelOutcome
      if (originalQuery && proven) {
        ctx.queryWithSentinelOutcome = (sequence, pattern) => {
          if (pass?.brackets) {
            const read = bracketOutcome(initializedBackend, sequence, pattern, pass.brackets, replyCaptures, proven)
            queryFacts.push(read.fact)
            return read.outcome
          }
          const start = replyCaptures.length
          const outcome = originalQuery(sequence, pattern)
          const target = replyCaptures[start]?.response ?? ""
          const answer = replyCaptures[start + 1]?.response ?? ""
          const sentinel = sentinelAnswer(answer)
          const clean = answer === "" || (sentinel?.start === 0 && answer.slice(sentinel.end) === "")
          queryFacts.push({ sequence, matched: outcome.reason === "reply", empty: target === "" && clean })
          return outcome
        }
      }
      const assertionDeclaration = probe.libAssertionType
      let declaredAssertionTypes: readonly AssertionType[] | null | undefined
      if (assertionDeclaration === null || assertionDeclaration === undefined) {
        declaredAssertionTypes = assertionDeclaration
      } else if (typeof assertionDeclaration === "string") {
        declaredAssertionTypes = [assertionDeclaration]
      } else {
        const selected = assertionDeclaration.when(ctx)
        if (typeof selected !== "boolean") {
          throw new Error(`Lib callback ${probe.id} declaration predicate must return a boolean`)
        }
        declaredAssertionTypes = selected ? assertionDeclaration.then : assertionDeclaration.otherwise
      }
      const callback = withReplyFailureEvidence(probe.id, probe.lib(ctx), {
        producer: "headless",
        attempts: replyCaptures.map((capture) => ({
          sequence: capture.query,
          received: capture.response,
          timeoutMs: null,
        })),
      })
      if (hostRecord) {
        const runId = hostRecord.runId
        const recordRef = `collector.hostRecipes.${probe.id}`
        for (const entry of callback.hostRecipeCauses ?? []) {
          const cause = entry.cause
          if (cause.kind === "observed") {
            if (
              !hostRecord.captures.some(
                (capture) => capture.query === cause.query && capture.response === "" && capture.error === null,
              )
            ) {
              throw new Error("Observed host cause has no matching empty query capture")
            }
            hostRecord.causes.push({
              recipe: entry.recipe,
              cause: { kind: cause.kind, missing: cause.missing, runId, eventRef: recordRef },
            })
          } else if (cause.kind === "unimplemented") {
            hostRecord.causes.push({
              recipe: entry.recipe,
              cause: {
                kind: cause.kind,
                missing: cause.missing,
                runId,
                artifactSha256: cause.artifactSha256,
                citation: { sourceLocation: cause.sourceCitation },
              },
            })
          } else {
            const inputs = batch.rawReplies["collector.collectionAttempt"]
            if (inputs === undefined) throw new Error("Native host cause requires collector.collectionAttempt")
            hostRecord.causes.push({
              recipe: entry.recipe,
              cause: {
                kind: cause.kind,
                missing: cause.missing,
                runId,
                artifactSha256: cause.artifactSha256,
                citation: {
                  inputRecordRef: "collector.collectionAttempt",
                  sha256: collectorAttemptDigest(inputs),
                  input: cause.missing,
                  sourceLocation: cause.sourceCitation,
                },
              },
            })
          }
        }
        batch.rawReplies[recordRef] = JSON.stringify(hostRecord)
      }
      // G1 runs before the callback's probe result is kept: a late byte refuses that result as a collector error,
      // while the run file keeps what was observed, the on-time capture and the late bytes beside it.
      const late =
        sentinel.fired && proven && pass?.wait !== false ? await listenForLateReply(backend, proven.graceMs) : undefined
      if (late) {
        retainCallbackResponse(batch, probe.id, callback)
        batch.rawReplies[`${probe.id}.late`] = late.bytes
        if (pass?.brackets) {
          const pending = notTestedResult("late reply after CPR bracket; no negative established", {
            captures: replyCaptures,
            late,
          })
          callbackTests = pending.tests
          recordResult(batch, probe, pending, declaredAssertionTypes)
          continue
        }
        throw new Error(
          withRefusedClaim(
            `late reply after sentinel: ${String(late.bytes.length)} bytes ${JSON.stringify(late.bytes)} at +${String(late.firstAtMs)}ms`,
            callback,
          ),
        )
      }
      if (hostRecord) {
        validateHostRecipeCauses(
          "headless collector",
          hostRecord.runId,
          probe.id,
          hostRecipes,
          batch.rawReplies,
          initializedRuntime?.identity,
        )
      }
      const graded = unreproduced.silent ? harnessIncompleteResult(backendName, unreproduced, callback) : callback
      callbackTests = graded.tests
      criterionBranch = graded.criterionBranch
      recordResult(batch, probe, graded, declaredAssertionTypes)
    } catch (error) {
      const message = `headless ${backendName} probe ${probe.id}: ${errorMessage(error)}`

      batch.ungradedDiagnostics[probe.id] = {
        kind: "collector-error",
        name: error instanceof Error ? error.name : "Error",
        message,
      }
    } finally {
      batch.rawReplies[`collector.queryCaptures.${probe.id}`] = JSON.stringify({
        queries: queryFacts,
        captures: retainedCaptures,
      })
      if (hostRecord) batch.rawReplies[`collector.hostRecipes.${probe.id}`] = JSON.stringify(hostRecord)
      const observation = batch.observations.find((entry) => entry.featureId === probe.id)
      const diagnostic = batch.ungradedDiagnostics[probe.id]
      const coverage = batch.notTested.find((entry) => entry.featureId === probe.id)
      const recorded = recordExecutedProbe({
        featureId: probe.id,
        attempt,
        observation,
        diagnostic,
        coverage,
        assertions: batch.assertions,
        tests: callbackTests,
        ...(Object.hasOwn(batch.rawReplies, probe.id) ? { rawReplyRef: probe.id } : {}),
        criterionBranch,
      })
      const result = finalizeSgrResult(recorded, { kind: "lib" }, [])
      const index = batch.results.findIndex((entry) => entry.featureId === probe.id)
      if (index < 0) throw new Error(`Headless callback ${probe.id} is outside the initialized catalogue`)
      batch.results[index] = result
      // Engine reset is a measured behavior, not a guarantee of fixture isolation.
      // A cleanup failure aborts the worker instead of sealing a misleading run.
      try {
        backend?.destroy()
      } catch (cause) {
        const reason = `headless ${backendName} probe ${probe.id}: backend cleanup failed`
        batch.results[index] = {
          ...result,
          status: "probe-invalid",
          reason,
          tests: [...result.tests, { id: "cleanup", status: "probe-invalid", attempt, reason }],
        }
        onCheckpoint?.(batch)
        throw new Error(reason, { cause })
      }
      onCheckpoint?.(batch)
    }
  }
  return batch
}

/** The existing per-probe collector is also the only execution path for fresh-instance repeats. */
export async function collectBatch(
  createBackend: () => Promise<TerminalBackend>,
  backendName: string,
  definitions: readonly ProbeDefinition[],
  draft?: Pick<RunDraft, "results" | "runId" | "rawReplies">,
  onCheckpoint?: (batch: Batch) => void,
  runtime?: HeadlessProbeRuntime,
): Promise<Batch> {
  const captures: HostQueryCapture[] = []
  const controlBackend = await createBackend()
  let control: boolean
  try {
    controlBackend.init(HEADLESS_TERMINAL)
    control = cprCapture(controlBackend, CPR_SPOTS[0], captures)
  } finally {
    controlBackend.destroy()
  }
  const first = await collectPass(createBackend, backendName, definitions, draft, onCheckpoint, runtime, {
    control,
    wait: true,
  })
  first.rawReplies["collector.replyControl"] = JSON.stringify({ answered: control, captures })
  const facts = (batch: Batch, id: string): { queries: QueryFact[]; captures: HostQueryCapture[] } => {
    const raw = batch.rawReplies[`collector.queryCaptures.${id}`]
    if (raw === undefined) throw new Error(`Missing retained query captures for ${backendName}:${id}`)
    return JSON.parse(raw) as { queries: QueryFact[]; captures: HostQueryCapture[] }
  }
  const selected = definitions.filter((probe) => {
    if (!probe.lib) return false
    const result = first.results.find((row) => row.featureId === probe.id)
    if (!result) throw new Error(`Missing first-pass result for ${backendName}:${probe.id}`)
    // A callback's own review stays intact. A bare missing-control refusal can still
    // become a negative when fresh CPR passes establish the previously missing control.
    const candidate = result.reason === "negative by sentinel" || result.reason === NO_SAME_PATH_CONTROL
    return candidate && facts(first, probe.id).queries.some((query) => query.empty && !query.matched)
  })
  if (!selected.length) return first
  const repeatDraft = () =>
    draft
      ? {
          runId: draft.runId,
          rawReplies: { ...draft.rawReplies },
          results: selected.map((probe) => ({
            featureId: probe.id,
            status: "probe-todo" as const,
            attempt: { scope: "none" as const },
            tests: [],
          })),
        }
      : undefined
  const second = await collectPass(createBackend, backendName, selected, repeatDraft(), undefined, runtime, {
    control,
    wait: false,
    brackets: [CPR_SPOTS[1], CPR_SPOTS[2]],
  })
  const third = await collectPass(createBackend, backendName, selected, repeatDraft(), undefined, runtime, {
    control,
    wait: true,
    brackets: [CPR_SPOTS[3], CPR_SPOTS[4]],
  })
  first.rawReplies["collector.repeatPasses"] = JSON.stringify({
    second: second.rawReplies,
    third: third.rawReplies,
    secondAssertions: second.assertions,
    thirdAssertions: third.assertions,
  })
  const repeatedAssertionOffset = first.assertions.length
  const repeatRef = (ref: string) => `collector.repeatResponse.${ref}`
  first.assertions.push(
    ...second.assertions.map((assertion) => {
      if (assertion.rawReplyRef === undefined) return assertion
      const response = second.rawReplies[assertion.rawReplyRef]
      if (response === undefined) {
        throw new Error(`Missing repeat assertion response for ${backendName}:${assertion.featureId}`)
      }
      const rawReplyRef = repeatRef(assertion.rawReplyRef)
      first.rawReplies[rawReplyRef] = response
      return { ...assertion, rawReplyRef }
    }),
  )
  for (const probe of selected) {
    const a = facts(first, probe.id),
      b = facts(second, probe.id),
      c = facts(third, probe.id)
    first.rawReplies[`collector.repeats.${probe.id}`] = JSON.stringify({
      first: a,
      second: b,
      third: c,
      secondResults: second.results.filter((row) => row.featureId === probe.id),
      thirdResults: third.results.filter((row) => row.featureId === probe.id),
    })
    const index = first.results.findIndex((row) => row.featureId === probe.id)
    const prior = first.results[index]
    const secondResult = second.results.find((row) => row.featureId === probe.id)
    const thirdResult = third.results.find((row) => row.featureId === probe.id)
    if (!prior || !secondResult || !thirdResult) {
      throw new Error(`Missing fresh-pass result for ${backendName}:${probe.id}`)
    }
    const controls = [...b.queries, ...c.queries].find((query) => query.controlError)
    const late = second.rawReplies[`${probe.id}.late`] ?? third.rawReplies[`${probe.id}.late`]
    const broken = [secondResult, thirdResult].find((row) => row.status === "probe-invalid")
    const signature = (queries: QueryFact[]) =>
      JSON.stringify(queries.map(({ matched, empty }) => ({ matched, empty })))
    if (controls || late) {
      const reason = controls?.controlError ?? "late reply after CPR bracket"
      first.results[index] = finalizeProbeResult({
        ...prior,
        reason,
        tests: [{ id: "reply-control", status: "probe-todo", reason, attempt: prior.attempt }],
      })
    } else if (broken) {
      const reason = broken.reason ?? "fresh-instance repeat failed"
      first.results[index] = finalizeProbeResult({
        ...prior,
        reason,
        tests: [{ id: "repeat-execution", status: "probe-invalid", reason, attempt: prior.attempt }],
      })
    } else if (signature(a.queries) !== signature(b.queries) || signature(a.queries) !== signature(c.queries)) {
      const reason = "query observations disagree across fresh-instance passes"
      process.stderr.write(`${backendName} ${probe.id}: ${reason}\n`)
      first.results[index] = finalizeProbeResult({
        ...prior,
        reason,
        tests: [{ id: "repeat-consistency", status: "probe-invalid", reason, attempt: prior.attempt }],
      })
    } else {
      const next = secondResult
      const last = thirdResult
      if (
        prior.status === "probe-todo" &&
        next.status === "unsupported" &&
        last.status === "unsupported" &&
        next.assertionType === "query_reply"
      ) {
        const offset = repeatedAssertionOffset
        first.observations.push(
          ...second.observations
            .filter((row) => row.featureId === probe.id)
            .map((row) => ({ ...row, ...(row.rawReplyRef && { rawReplyRef: repeatRef(row.rawReplyRef) }) })),
        )
        const response = second.rawReplies[probe.id]
        if (response === undefined) throw new Error(`Missing repeat target response for ${backendName}:${probe.id}`)
        first.rawReplies[repeatRef(probe.id)] = response
        first.results[index] = {
          ...next,
          ...(next.rawReplyRef && { rawReplyRef: repeatRef(next.rawReplyRef) }),
          tests: next.tests.map((test) => ({
            ...test,
            ...(test.rawReplyRef && { rawReplyRef: repeatRef(test.rawReplyRef) }),
            ...(test.assertionRefs && { assertionRefs: test.assertionRefs.map((ref) => ref + offset) }),
          })),
        }
      }
    }
  }
  onCheckpoint?.(first)
  return first
}
