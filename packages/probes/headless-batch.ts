/** Internal production adapter and isolated result collection for one Termless engine. */
/* oxlint-disable typescript/no-deprecated -- Current Termless resolve() adapters expose TerminalBackend lifecycle; Emulator does not yet replace that loader. */

import { hasExtension, type HyperlinkExtension, type TerminalBackend } from "@termless/core"
import { readHyperlinkMetadata } from "@terminfo/probe-defs"
import type {
  NotTestedCoverage,
  Observation,
  ProbeAssertion,
  ProbeDefinition,
  ProbeResult,
  TermlessContext,
  UngradedDiagnostic,
} from "@terminfo/probe-defs"

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/** Capture one query, including adapters that parse pending input on state reads. */
export function feedCapture(backend: TerminalBackend, text: string): string {
  // Pending input belongs to the previous listener, not this query.
  backend.getCursor()
  let response = ""
  const previous = backend.onResponse
  backend.onResponse = (bytes) => {
    response += decoder.decode(bytes)
  }
  try {
    backend.feed(encoder.encode(text))
    backend.getCursor()
  } finally {
    backend.onResponse = previous
  }
  return response
}

export function createTermlessContext(backend: TerminalBackend): TermlessContext {
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
    cols,
    getHyperlinkAt: readLink,
    feed(text) {
      backend.feed(encoder.encode(text))
    },
    feedCapture(text) {
      return feedCapture(backend, text)
    },
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
      return { ...withoutLink, ...(hyperlink !== undefined && { hyperlink }) } as ReturnType<TermlessContext["getCell"]>
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
      return backend.capabilities as TermlessContext["capabilities"]
    },
  }
}

interface Batch {
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
function retainCallbackResponse(batch: Batch, id: string, result: ProbeResult): void {
  if (result.response !== undefined) batch.rawReplies[id] = result.response
}

/** A refused claim keeps its own observation detail and assertion contents in the error text, never as a claim. */
function refusedClaimEvidence(result: ProbeResult): string {
  const parts: string[] = []
  const observation = result.observation
  if (observation) {
    parts.push(
      `observation(${[
        `outcome=${observation.outcome}`,
        ...(observation.reason ? [`reason=${observation.reason}`] : []),
        `evidence=${observation.evidence}`,
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

/** A callback conclusion without its raw state cannot become a support claim. */
function recordResult(batch: Batch, probe: ProbeDefinition, result: ProbeResult): void {
  const id = probe.id
  if (result.notTested) {
    recordNotTested(batch, probe, result)
    return
  }
  // The union makes one of the two records mandatory, so a typed callback always lands here
  // with a measurement. An untyped caller that returns neither gets a loud collector error
  // instead of the old ungraded legacy-callback record.
  const widened: { observation?: ProbeResult["observation"] } = result
  const explicit = widened.observation
  if (!explicit) {
    batch.ungradedDiagnostics[id] = {
      kind: "collector-error",
      name: "Error",
      message: `Callback for ${id} returned neither an observation nor a not-tested coverage record; its conclusion cannot be graded`,
    }
    return
  }
  const declared = probe.termlessObservationEvidence
  const unmeasuredRefusal =
    explicit.outcome === "inconclusive" &&
    Boolean(explicit.reason) &&
    result.response === undefined &&
    !result.assertions?.length
  if (declared && !(explicit.evidence === "none" ? unmeasuredRefusal : explicit.evidence === declared)) {
    batch.observations.push({
      featureId: id,
      outcome: "error",
      reason: "collector-error",
      evidence: explicit.evidence,
      note: `Termless callback ${id} declares ${declared} evidence but returned ${explicit.evidence}${explicit.evidence === "none" ? " without an unmeasured refusal" : ""}`,
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
    (explicit.evidence === "parser-state" &&
      !validAssertions.some((assertion) => assertion.observed === result.response))
  if (
    (conclusive && bindingInvalid) ||
    ((explicit.outcome === "error" || explicit.outcome === "inconclusive") && !explicit.reason)
  ) {
    batch.observations.push({
      featureId: id,
      outcome: "error",
      reason: "collector-error",
      evidence: explicit.evidence,
      note: `Callback result lacks ${conclusive ? "matching raw state and assertion" : "an inconclusive/error reason"}`,
    })
    return
  }
  if (result.response !== undefined) batch.rawReplies[id] = result.response
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
function recordNotTested(batch: Batch, probe: ProbeDefinition, result: ProbeResult): void {
  const id = probe.id
  const notTested = result.notTested
  if (!notTested) return
  retainCallbackResponse(batch, id, result)
  const assertions = result.assertions ?? []
  if (result.observation !== undefined || assertions.length > 0) {
    const mixedMessage = `Not-tested coverage for ${id} arrived beside ${refusedClaimEvidence(result)}; a probe that claims no semantic observable cannot also carry a measurement, so the coverage claim is refused and its evidence stays a collector error`
    if (probe.termlessObservationEvidence) {
      batch.observations.push({
        featureId: id,
        outcome: "error",
        reason: "collector-error",
        evidence: probe.termlessObservationEvidence,
        note: mixedMessage,
        ...(result.response !== undefined ? { rawReplyRef: id } : {}),
      })
    } else {
      batch.ungradedDiagnostics[id] = { kind: "collector-error", name: "Error", message: mixedMessage }
    }
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
    if (probe.termlessObservationEvidence) {
      batch.observations.push({
        featureId: id,
        outcome: "error",
        reason: "collector-error",
        evidence: probe.termlessObservationEvidence,
        note: message,
        ...(result.response !== undefined ? { rawReplyRef: id } : {}),
      })
    } else {
      batch.ungradedDiagnostics[id] = { kind: "collector-error", name: "Error", message }
    }
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
): Promise<Batch> {
  const batch: Batch = {
    rawReplies: {},
    observations: [],
    assertions: [],
    notTested: [],
    ungradedDiagnostics: {},
  }
  for (const probe of definitions) {
    if (!probe.termless) continue
    process.stderr.write(`headless ${backendName} probe ${probe.id}\n`)
    let backend: TerminalBackend | undefined
    try {
      backend = await createBackend()
      backend.init({ cols: 80, rows: 24 })
      const ctx = createTermlessContext(backend)
      recordResult(batch, probe, probe.termless(ctx))
    } catch (error) {
      const message = `headless ${backendName} probe ${probe.id}: ${errorMessage(error)}`
      if (probe.termlessObservationEvidence) {
        batch.observations.push({
          featureId: probe.id,
          outcome: "error",
          reason: "collector-error",
          evidence: probe.termlessObservationEvidence,
          note: message,
        })
      } else {
        batch.ungradedDiagnostics[probe.id] = {
          kind: "collector-error",
          name: error instanceof Error ? error.name : "Error",
          message,
        }
      }
    } finally {
      // Engine reset is a measured behavior, not a guarantee of fixture isolation.
      // A cleanup failure aborts the worker instead of sealing a misleading run.
      try {
        backend?.destroy()
      } catch (cause) {
        throw new Error(`headless ${backendName} probe ${probe.id}: backend cleanup failed`, { cause })
      }
    }
  }
  return batch
}
