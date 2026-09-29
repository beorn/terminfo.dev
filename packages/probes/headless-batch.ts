/** Internal production adapter and result collection for one initialized Termless backend. */
/* oxlint-disable typescript/no-deprecated -- Current Termless resolve() adapters expose TerminalBackend lifecycle; Emulator does not yet replace that loader. */

import type { TerminalBackend } from "@termless/core"
import type {
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
  return {
    cols,
    feed(text) {
      backend.feed(encoder.encode(text))
    },
    feedCapture(text) {
      return feedCapture(backend, text)
    },
    getCell(row, col) {
      const cell = backend.getCell(row, col)
      if (backend.capabilities.osc8Hyperlinks) {
        if (cell.hyperlink === undefined) {
          throw new Error(`${backend.name} declares OSC 8 link metadata but omitted it at ${row},${col}`)
        }
        return cell as ReturnType<TermlessContext["getCell"]>
      }
      const { hyperlink: _unreported, ...withoutLink } = cell
      return withoutLink as ReturnType<TermlessContext["getCell"]>
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
  ungradedDiagnostics: Record<string, UngradedDiagnostic>
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** A callback conclusion without its raw state cannot become a support claim. */
function recordResult(batch: Batch, probe: ProbeDefinition, result: ProbeResult): void {
  const id = probe.id
  const explicit = result.observation
  if (!explicit) {
    batch.ungradedDiagnostics[id] = {
      kind: "legacy-callback",
      pass: result.pass,
      ...(result.note && { note: result.note }),
      ...(result.response !== undefined && { response: result.response }),
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

export function collectBatch(
  backend: TerminalBackend,
  backendName: string,
  definitions: readonly ProbeDefinition[],
): Batch {
  const batch: Batch = { rawReplies: {}, observations: [], assertions: [], ungradedDiagnostics: {} }
  const ctx = createTermlessContext(backend)
  for (const probe of definitions) {
    if (!probe.termless) continue
    process.stderr.write(`headless ${backendName} probe ${probe.id}\n`)
    try {
      backend.reset()
      recordResult(batch, probe, probe.termless(ctx))
    } catch (error) {
      const message = errorMessage(error)
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
    }
  }
  return batch
}
