/** Internal production adapter and isolated result collection for one Termless engine. */
/* oxlint-disable typescript/no-deprecated -- Current Termless resolve() adapters expose TerminalBackend lifecycle; Emulator does not yet replace that loader. */

import {
  hasExtension,
  type HyperlinkExtension,
  type ReplyDeliveryExtension,
  type TerminalBackend,
} from "@termless/core"
import {
  readHyperlinkMetadata,
  readSentinelReply,
  recordExecutedProbe,
  ASSERTION_TYPES,
  sentinelGraceMs,
} from "@terminfo/probe-defs"
import type {
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
} from "@terminfo/probe-defs"
import {
  headlessRuntimeIdentity,
  replyDeliveryDecision,
  type HeadlessProbeRuntime,
  type ReplyPathDecision,
} from "./headless-identity.ts"
import { isDeepStrictEqual } from "node:util"

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/** The DA1 query the sentinel member sends in its own capture, as the live collector appends it. */
const DA1_QUERY = "\x1b[c"

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
}

/** Capture one query, including adapters that parse pending input on state reads. */
export function feedCapture(backend: TerminalBackend, text: string, captures: HostQueryCapture[] | undefined): string {
  let response = ""
  let error: string | null = null
  const previous = backend.onResponse
  try {
    // Pending input belongs to the previous listener, not this query.
    backend.getCursor()
    backend.onResponse = (bytes) => {
      response += decoder.decode(bytes)
    }
    backend.feed(encoder.encode(text))
    backend.getCursor()
  } catch (cause) {
    error = errorMessage(cause)
    throw cause
  } finally {
    backend.onResponse = previous
    captures?.push({ query: text, response, error })
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
 * the grader never calls silence (#30559, @cto 86260f80).
 */
function sentinelOutcome(
  backend: TerminalBackend,
  sequence: string,
  pattern: RegExp,
  proven: ProvenReplyPath,
  captures: HostQueryCapture[] | undefined,
): TerminalQueryOutcome {
  const writeAt = Date.now()
  const reply = feedCapture(backend, sequence, captures)
  const answer = feedCapture(backend, DA1_QUERY, captures)
  const raw = reply + answer
  const captured = { raw, rawBase64: Buffer.from(raw).toString("base64") }
  const read = readSentinelReply(raw, pattern)
  if (read.kind === "reply") return { match: read.match, reason: "reply", ...captured }
  // Only a DA1 answer in a capture of its own ends the query: a DA1-shaped answer in the query's capture
  // is the engine's reply to it (@dev/8 9ab12dbe S4, @cto 86260f80 rule 4).
  if (readSentinelReply(answer, pattern).kind === "pending") {
    return { match: read.match, reason: read.match ? "reply" : "timeout", ...captured }
  }
  const sentinel = { atMs: Date.now() - writeAt, graceMs: proven.graceMs }
  if (read.match) return { match: read.match, reason: "reply", ...captured, sentinel }
  proven.onSentinel()
  return { match: null, reason: "sentinel", ...captured, sentinel }
}

/**
 * G1 (#30554, @cto 452bc032): a proven path delivers every reply inside its capture, so any byte the
 * engine sends after the callback returned contradicts the proof. Listen through the grace window and
 * drain adapters that read pending input on state reads. Late bytes come back to the caller, which
 * refuses the callback's grade as a collector error, never the negative it built on the silence.
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
  return {
    kind: "live",
    ...(runtimeIdentity && { runtimeIdentity }),
    cols,
    getHyperlinkAt: readLink,
    feed(text) {
      backend.feed(encoder.encode(text))
    },
    feedCapture(text) {
      return feedCapture(backend, text, captures)
    },
    ...(proven && {
      queryWithSentinelOutcome(sequence: string, pattern: RegExp) {
        return sentinelOutcome(backend, sequence, pattern, proven, captures)
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
    getMode(mode) {
      return backend.getMode(mode as Parameters<TerminalBackend["getMode"]>[0])
    },
    getText() {
      return backend.getText()
    },
    getScrollback() {
      return backend.getScrollback()
    },
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

/** A refusal's text names the claim it refused, so the run file keeps what the grader concluded. */
function withRefusedClaim(message: string, result: ProbeCallbackResult): string {
  const refused = refusedClaimEvidence(result)
  return refused ? `${message}; refused ${refused}` : message
}

/** A callback conclusion without its raw state cannot become a support claim. */
function recordResult(batch: Batch, probe: ProbeDefinition, result: ProbeCallbackResult): void {
  const id = probe.id
  if (result.notTested) {
    recordNotTested(batch, probe, result)
    return
  }
  retainCallbackResponse(batch, id, result)
  // The union makes one of the two records mandatory, so a typed callback always lands here
  // with a measurement. An untyped caller that returns neither gets a loud collector error
  // instead of the old ungraded legacy-callback record.
  const widened: { observation?: ProbeCallbackResult["observation"] } = result
  const explicit = widened.observation
  if (
    !explicit &&
    result.tests?.length &&
    result.tests.every(
      (test) =>
        (test.status === "test-todo" || test.status === "test-failure") &&
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
        `Callback for ${id} returned neither an observation nor a not-tested coverage record; its conclusion cannot be graded`,
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
  const declared = probe.libAssertionType
  if (declared !== undefined && declared !== explicit.assertionType) {
    batch.observations.push({
      featureId: id,
      outcome: "error",
      reason: "collector-error",
      assertionType: explicit.assertionType,
      note: withRefusedClaim(
        `Lib callback ${id} declares ${String(declared)} but returned ${explicit.assertionType}`,
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

export async function collectBatch(
  createBackend: () => Promise<TerminalBackend>,
  backendName: string,
  definitions: readonly ProbeDefinition[],
  draft?: Pick<RunDraft, "results">,
  onCheckpoint?: (batch: Batch) => void,
  runtime?: HeadlessProbeRuntime,
): Promise<Batch> {
  // One read of the grace window per pass: every sentinel outcome records it and G1 waits it out.
  let graceMs: number | undefined
  const replyPath: {
    backend: string
    declaration?: ReplyDeliveryExtension["replyDelivery"]
    runtimeIdentity?: HeadlessRuntimeIdentity
    decisions: Record<string, Pick<ReplyPathDecision, "member" | "reason" | "runtimeIdentity">>
  } = { backend: backendName, ...(runtime && { runtimeIdentity: runtime.identity }), decisions: {} }
  const warned = new Set<string>()
  const warn = (line: string) => {
    if (warned.has(line)) return
    warned.add(line)
    process.stderr.write(`${line}\n`)
  }
  const batch: Batch = {
    results:
      draft?.results ??
      definitions.map((probe) => ({
        featureId: probe.id,
        status: "test-todo",
        attempt: { scope: "none" },
        tests: [],
        reason: "Required callback has not started",
      })),
    rawReplies: {},
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
    try {
      backend = await createBackend()
      backend.init({ cols: 80, rows: 24 })
      const initializedRuntime = runtime
        ? {
            ...runtime,
            identity: await headlessRuntimeIdentity(backendName, runtime.adapterPackage, runtime.adapterType),
          }
        : undefined
      const declaration = hasExtension<ReplyDeliveryExtension>(backend, "reply-delivery")
        ? backend.replyDelivery
        : undefined
      const decision = replyDeliveryDecision(backendName, declaration, initializedRuntime, warn)
      const identityChanged =
        runtime !== undefined &&
        initializedRuntime !== undefined &&
        !isDeepStrictEqual(runtime.identity, initializedRuntime.identity)
      const reason = identityChanged
        ? `${backendName} initialized instance identity differs from the recorded run identity`
        : decision.reason
      if (declaration) replyPath.declaration ??= declaration
      replyPath.decisions[probe.id] = {
        member: decision.member && !identityChanged,
        reason,
        ...(initializedRuntime && { runtimeIdentity: initializedRuntime.identity }),
      }
      batch.rawReplies["collector.replyPath"] = JSON.stringify(replyPath)
      if (identityChanged) throw new Error(reason)
      const sentinel = { fired: false }
      const proven = decision.member
        ? {
            graceMs: (graceMs ??= sentinelGraceMs()),
            onSentinel: () => {
              sentinel.fired = true
            },
          }
        : undefined
      const ctx = createLibProbeSource(backend, proven, initializedRuntime?.identity, undefined)
      const callback = probe.lib(ctx)
      // G1 runs before the callback's grade is kept: a late byte refuses that grade as a collector error,
      // while the run file keeps what was observed, the on-time capture and the late bytes beside it.
      const late = sentinel.fired && proven ? await listenForLateReply(backend, proven.graceMs) : undefined
      if (late) {
        retainCallbackResponse(batch, probe.id, callback)
        batch.rawReplies[`${probe.id}.late`] = late.bytes
        throw new Error(
          withRefusedClaim(
            `late reply after sentinel: ${String(late.bytes.length)} bytes ${JSON.stringify(late.bytes)} at +${String(late.firstAtMs)}ms`,
            callback,
          ),
        )
      }
      callbackTests = callback.tests
      criterionBranch = callback.criterionBranch
      recordResult(batch, probe, callback)
    } catch (error) {
      const message = `headless ${backendName} probe ${probe.id}: ${errorMessage(error)}`

      batch.ungradedDiagnostics[probe.id] = {
        kind: "collector-error",
        name: error instanceof Error ? error.name : "Error",
        message,
      }
    } finally {
      const observation = batch.observations.find((entry) => entry.featureId === probe.id)
      const diagnostic = batch.ungradedDiagnostics[probe.id]
      const coverage = batch.notTested.find((entry) => entry.featureId === probe.id)
      const result = recordExecutedProbe({
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
          status: "test-failure",
          reason,
          tests: [...result.tests, { id: "cleanup", status: "test-failure", attempt, reason }],
        }
        onCheckpoint?.(batch)
        throw new Error(reason, { cause })
      }
      onCheckpoint?.(batch)
    }
  }
  return batch
}
