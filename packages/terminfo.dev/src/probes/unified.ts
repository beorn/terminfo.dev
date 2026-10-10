/**
 * CLI probe adapter — wraps unified probe-defs with TermContext from tty.ts.
 *
 * Imports ALL_PROBES from @terminfo/probe-defs, creates a TermContext using
 * the tty.ts helpers (query, queryCursorPosition, measureRenderedWidth, queryMode),
 * and exports the same `Probe[]` interface the CLI expects.
 */

import {
  ALL_PROBES as PROBE_DEFS,
  type InputFixture,
  type NotTestedCoverage,
  type Observation,
  type ObservationFrame,
  type ProbeAssertion,
  type ProbeDefinition,
  type ProbeResult,
  type TermContext,
  type UngradedDiagnostic,
} from "@terminfo/probe-defs"
import {
  query,
  queryOutcome,
  queryWithSentinel,
  queryWithSentinelOutcome,
  queryCursorPosition,
  measureRenderedWidth,
  queryMode,
  readResponse,
  withTTYOperation,
  withTTYQueryTrace,
  type TTYQueryTrace,
  type TTYTraceEvent,
} from "../tty.ts"
import type { ClipboardTraceEvent } from "../linux-clipboard.ts"
import { ownedTerminalVerifiedFor, type GeometryMeasurement, type OwnedTerminal } from "../owned-terminal.ts"
import {
  bindReceiptToRun,
  readDisposableReceipt,
  type DisposableReceipt,
  type ReceiptTarget,
} from "../disposable-receipt.ts"

/**
 * Resolve the disposable-ownership receipt once per batch (27832 amendment 1). No receipt is
 * normal and means the untouched default path; a receipt that was declared but cannot be verified
 * is loud, before any byte is written, because a silent fall back to "shared" would look like a
 * gate while grading nothing.
 */
function resolveDisposableReceipt(): DisposableReceipt | undefined {
  const path = process.env.TERMINFO_DISPOSABLE_RECEIPT
  return path ? readDisposableReceipt(path) : undefined
}

export interface Probe {
  id: string
  name: string
}

/** Build a TermContext from the tty.ts helpers */
function createTermContext({
  out,
  writes,
  events,
  probe,
  geometry,
}: {
  out: NodeJS.WriteStream
  writes?: string[]
  events?: TTYTraceEvent[]
  probe: ProbeDefinition
  geometry?: Extract<GeometryMeasurement, { status: "measured" }>
}): TermContext {
  const size = () => {
    if (probe.termNeedsGeometry !== true || !geometry) {
      const error = new Error(`App callback ${probe.id} accessed undeclared or unavailable terminal geometry`)
      error.name = "UndeclaredTerminalGeometry"
      throw error
    }
    return geometry
  }
  return {
    write(text: string) {
      writes?.push(text)
      events?.push({ kind: "write", sequence: text })
      out.write(text)
    },
    async queryCursorPosition() {
      const result = await queryCursorPosition()
      if (!result) return null
      return { row: result[0], col: result[1] }
    },
    async measureRenderedWidth(text) {
      const setup = "\x1b7\x1b[1G" + text
      writes?.push(setup)
      events?.push({ kind: "write", sequence: setup })
      try {
        return await measureRenderedWidth(text)
      } finally {
        writes?.push("\x1b8")
        events?.push({ kind: "write", sequence: "\x1b8" })
      }
    },
    query,
    queryOutcome,
    queryWithSentinel,
    queryWithSentinelOutcome,
    queryMode,
    readInput: (pattern, timeoutMs = 1000, inject) => readResponse(pattern, timeoutMs, inject),
    get cols() {
      return size().cols
    },
    get rows() {
      return size().rows
    },
  }
}

/** Preserve the applicable CLI inventory; execution goes through runProbeBatch. */
export const ALL_PROBES: Probe[] = PROBE_DEFS.filter((p) => p.term !== null).map((p) => ({
  id: p.id,
  name: p.id,
}))

export interface ProbeBatch {
  rawReplies: Record<string, string>
  observations: Observation[]
  assertions: ProbeAssertion[]
  notTested: NotTestedCoverage[]
  ungradedDiagnostics: Record<string, UngradedDiagnostic>
  suiteComplete: boolean
  screenshotRefs: string[]
  /** The apparatus-measured launch receipt, parsed by the ONE parser; the caller copies this block
   * into origin.appLaunch of the run document, adding and editing nothing (28216). */
  appLaunch?: DisposableReceipt["appLaunch"]
}

export type ProbeCapture = (checkpoint: {
  featureId: string
  role: ObservationFrame["role"]
  label: string
}) => Promise<{ frame: ObservationFrame; trace: Record<string, unknown> }>

export interface GeometryCorroboration {
  status: "agree" | "conflict" | "uncorroborated" | "silent" | "malformed"
  query: {
    sequence: "\x1b[18t"
    outbound: "\x1b[18t\x1b[c"
    reason: "reply" | "sentinel" | "timeout"
    raw: string
    rawBase64: string
  }
  rows?: number
  cols?: number
}

function selectAppProbes(ids?: string[]): { expected: ProbeDefinition[]; selected: ProbeDefinition[] } {
  const expected = PROBE_DEFS.filter((probe) => probe.term !== null)
  const requested = ids
    ? ids.map((id) => {
        const probe = expected.find((item) => item.id === id)
        if (!probe) throw new Error(`Unknown or inapplicable app probe ${id}`)
        return probe
      })
    : expected
  if (new Set(requested.map((probe) => probe.id)).size !== requested.length) {
    throw new Error("Duplicate probe ID in app batch")
  }
  return {
    expected,
    selected: [
      ...requested.filter((probe) => !probe.id.startsWith("extensions.osc52-")),
      ...requested.filter((probe) => probe.id.startsWith("extensions.osc52-")),
    ],
  }
}

/**
 * Runtime totality guard. `ProbeResult` is a union that makes a measurement or a coverage
 * record mandatory, so a typed callback cannot reach here without one; an untyped caller
 * can, and that is reported rather than silently ungraded.
 */
function claimsMeasurement(result: ProbeResult): boolean {
  const widened: { observation?: unknown; assertions?: readonly unknown[] } = result
  return widened.observation !== undefined || (widened.assertions?.length ?? 0) > 0
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

/** Collect the real callback result, without treating its legacy boolean as an observation. */
export async function runProbeBatch(
  options: {
    ids?: string[]
    capture?: ProbeCapture
    input?: InputFixture
    ownedTerminal?: OwnedTerminal
    captureRunId?: string
    out?: NodeJS.WriteStream
    geometryCorroboration?: GeometryCorroboration
    /** The target this run is measuring, from the measured side (the launched app), never read out
     * of the receipt. A receipt naming another target is refused before the first write (27874). */
    target?: ReceiptTarget
  } = {},
): Promise<ProbeBatch> {
  const out = options.out ?? process.stdout
  const { expected, selected } = selectAppProbes(options.ids)
  const batch: ProbeBatch = {
    rawReplies: {},
    observations: [],
    assertions: [],
    notTested: [],
    ungradedDiagnostics: {},
    suiteComplete: false,
    screenshotRefs: [],
  }
  const geometryChecks: Array<{
    featureId: string
    pre?: GeometryMeasurement
    post?: GeometryMeasurement
    diagnostic?: string
  }> = []
  const unavailable = (error: unknown): GeometryMeasurement => ({
    status: "unavailable",
    at: new Date().toISOString(),
    source: options.ownedTerminal?.geometrySource ?? "unavailable: no verified output device",
    diagnostic: error instanceof Error ? error.message : String(error),
    stdout: "",
    stderr: "",
  })
  const readGeometry = async (): Promise<GeometryMeasurement> => {
    try {
      if (!options.ownedTerminal) throw new Error("No owned geometry reader")
      return await options.ownedTerminal.readGeometry()
    } catch (error) {
      return unavailable(error)
    }
  }
  // Ownership is checked ONCE, before the first write, never per probe (27832 amendment 1). A
  // mutation-and-readback probe additionally needs a verified disposable-ownership receipt; an
  // absent or unparsable receipt is loud, and no env flag or caller option stands in for it.
  const ownsTerminal = ownedTerminalVerifiedFor(options.ownedTerminal, options.captureRunId ?? "", out)
  const disposable = resolveDisposableReceipt()
  // Bind BEFORE the first write: a receipt for another target must not authorize this terminal, and
  // checking it afterwards would mean the wrong terminal was already written to. (27874)
  if (disposable) bindReceiptToRun(disposable, options.target, "collector.disposableOwnership")
  const authorizedToWrite = ownsTerminal || Boolean(disposable)
  if (disposable?.appLaunch) batch.appLaunch = disposable.appLaunch
  batch.rawReplies["collector.disposableOwnership"] = JSON.stringify(
    disposable
      ? {
          kind: disposable.kind,
          runId: disposable.runId,
          collectedAt: disposable.collectedAt,
          receiptSha256: disposable.sha256,
          ...(disposable.declaredTarget ? { declaredTarget: disposable.declaredTarget } : {}),
          ...(disposable.identity ? { identity: disposable.identity } : {}),
        }
      : { kind: "shared" },
  )
  for (const probe of selected) {
    const writes: string[] = []
    const queries: TTYQueryTrace[] = []
    const events: TTYTraceEvent[] = []
    const clipboardEvents: ClipboardTraceEvent[] = []
    const captures: Array<{ frame: ObservationFrame; trace: Record<string, unknown> }> = []
    let captureAttempted = false
    const needsOwnership = probe.termWrites !== "query" || probe.termNeedsDisposable === true
    const refusedBecause = !needsOwnership
      ? undefined
      : !authorizedToWrite
        ? "neither a verified owned terminal nor a verified disposable-ownership receipt was presented"
        : probe.termNeedsDisposable === true && !disposable
          ? "no verified disposable-ownership receipt was presented"
          : undefined
    if (refusedBecause) {
      batch.observations.push({
        featureId: probe.id,
        outcome: "inconclusive",
        reason: "policy-refused",
        evidence: "none",
        note: `Collector refused before sending bytes because ${refusedBecause}`,
        rawReplyRef: probe.id,
      })
      batch.rawReplies[probe.id] = JSON.stringify({ writes, queries, events })
      continue
    }
    let preGeometry: GeometryMeasurement | undefined
    let geometryCheck: (typeof geometryChecks)[number] | undefined
    if (probe.termNeedsGeometry) {
      geometryCheck = { featureId: probe.id }
      geometryChecks.push(geometryCheck)
      const grant = ownsTerminal ? options.ownedTerminal?.geometryAtGrant : undefined
      if (grant?.status === "measured") {
        preGeometry = await readGeometry()
        geometryCheck.pre = preGeometry
      }
      const corroboration = options.geometryCorroboration
      const diagnostic = !ownsTerminal
        ? "No verified owned terminal for geometry read"
        : grant?.status !== "measured"
          ? `Grant geometry unavailable: ${grant?.status === "unavailable" ? grant.diagnostic : "no owned measurement"}`
          : preGeometry?.status !== "measured"
            ? `Pre-callback geometry unavailable: ${preGeometry?.status === "unavailable" ? preGeometry.diagnostic : "no measurement"}`
            : corroboration?.status === "conflict"
              ? `CSI 18t geometry ${corroboration.rows}x${corroboration.cols} conflicts with stty ${preGeometry.rows}x${preGeometry.cols}`
              : corroboration?.status === "agree" &&
                  (corroboration.rows !== preGeometry.rows || corroboration.cols !== preGeometry.cols)
                ? `Pre-callback stty geometry ${preGeometry.rows}x${preGeometry.cols} differs from CSI 18t ${corroboration.rows}x${corroboration.cols}`
                : undefined
      if (diagnostic) {
        geometryCheck.diagnostic = diagnostic
        batch.observations.push({
          featureId: probe.id,
          outcome: "inconclusive",
          reason: "insufficient-evidence",
          evidence: "none",
          note: diagnostic,
          rawReplyRef: probe.id,
        })
        batch.rawReplies[probe.id] = JSON.stringify({ writes, queries, events })
        continue
      }
    }
    const context = createTermContext({
      out,
      writes,
      events,
      probe,
      geometry: preGeometry?.status === "measured" ? preGeometry : undefined,
    })
    if (options.ownedTerminal?.clipboard && options.ownedTerminal.clipboard.profile !== "default") {
      const clipboard = options.ownedTerminal.clipboard
      context.withClipboardFixture = (work) =>
        clipboard.withClipboardFixture(work, (event) => clipboardEvents.push(event))
    }
    if (options.input) context.input = options.input
    const capture = options.capture
    if (capture) {
      context.capture = async (checkpoint) => {
        captureAttempted = true
        const result = await capture({ featureId: probe.id, ...checkpoint })
        if (result.frame.role !== checkpoint.role || !/^sha256:[a-f0-9]{64}$/.test(result.frame.ref)) {
          throw new Error(`Capture adapter returned an invalid frame for ${probe.id} ${checkpoint.role}`)
        }
        captures.push(result)
        if (!batch.screenshotRefs.includes(result.frame.ref)) batch.screenshotRefs.push(result.frame.ref)
        return result.frame
      }
    }
    try {
      if (!probe.term) throw new Error(`No app callback for ${probe.id}`)
      const callback = probe.term
      let result
      try {
        result = await withTTYOperation(() => withTTYQueryTrace(queries, events, () => callback(context)), out)
      } finally {
        if (geometryCheck) geometryCheck.post = await readGeometry()
      }
      if (result.notTested) {
        const reason = result.notTested.reason
        const noObservable = result.notTested.noObservable
        if (result.response !== undefined) {
          batch.rawReplies[`${probe.id}.callbackResponse`] = result.response
        }
        if (claimsMeasurement(result)) {
          batch.ungradedDiagnostics[probe.id] = {
            kind: "collector-error",
            name: "Error",
            message: `Not-tested coverage for ${probe.id} arrived beside ${refusedClaimEvidence(result)}; a probe that claims no semantic observable cannot also carry a measurement, so the coverage claim is refused and its evidence stays a collector error`,
          }
        } else if (reason !== "no-semantic-observable" || noObservable.trim().length === 0) {
          batch.ungradedDiagnostics[probe.id] = {
            kind: "collector-error",
            name: "Error",
            message: "Not-tested coverage for " + probe.id + " requires a closed reason and a specific noObservable",
          }
        } else {
          batch.notTested.push({ featureId: probe.id, reason, noObservable, rawReplyRef: probe.id })
        }
      } else if (result.observation) {
        if (result.response !== undefined) {
          batch.rawReplies[`${probe.id}.callbackResponse`] = result.response
        }
        const rawReplyRef =
          queries.length || captureAttempted || clipboardEvents.length || result.observation.evidence === "none"
            ? probe.id
            : undefined
        const post = geometryCheck?.post
        const resized =
          preGeometry?.status === "measured" &&
          (post?.status !== "measured" || post.rows !== preGeometry.rows || post.cols !== preGeometry.cols)
        batch.observations.push({
          featureId: probe.id,
          ...result.observation,
          ...(result.note && !result.observation.note ? { note: result.note } : {}),
          ...(resized
            ? {
                outcome: "inconclusive" as const,
                reason: "insufficient-evidence" as const,
                note: `Measured geometry changed or became unavailable after ${probe.id}`,
              }
            : {}),
          ...(rawReplyRef ? { rawReplyRef } : {}),
        })
        for (const assertion of resized ? [] : (result.assertions ?? [])) {
          batch.assertions.push({ featureId: probe.id, ...assertion, ...(rawReplyRef ? { rawReplyRef } : {}) })
        }
      } else {
        // The callback returned neither a measurement nor a coverage record. The type makes
        // that impossible for a typed callback; an untyped caller still gets a loud error.
        batch.ungradedDiagnostics[probe.id] = {
          kind: "collector-error",
          name: "Error",
          message: `Callback for ${probe.id} returned neither an observation nor a not-tested coverage record; its conclusion cannot be graded`,
        }
      }
    } catch (error) {
      const name = error instanceof Error ? error.name : "Error"
      const message = error instanceof Error ? error.message : String(error)
      // FrameUnavailable joins UndeclaredTerminalGeometry: the probe could not run at all, so the
      // error is named in its own result and nothing about pixels is claimed (27875).
      const errorEvidence =
        name === "UndeclaredTerminalGeometry" || name === "FrameUnavailable"
          ? undefined
          : captureAttempted
            ? "pixels"
            : probe.termObservationEvidence
      if (errorEvidence) {
        batch.observations.push({
          featureId: probe.id,
          outcome: "error",
          reason: "collector-error",
          evidence: errorEvidence,
          note: message,
          ...(queries.length || captureAttempted || clipboardEvents.length ? { rawReplyRef: probe.id } : {}),
        })
      } else {
        batch.ungradedDiagnostics[probe.id] = { kind: "collector-error", name, message }
      }
    } finally {
      const trace = JSON.stringify({
        writes,
        queries,
        events,
        ...(clipboardEvents.length ? { clipboard: clipboardEvents } : {}),
        ...(captureAttempted ? { captures } : {}),
      })
      if (probe.id === "device.primary-da" || probe.id === "device.secondary-da" || probe.id === "device.xtversion") {
        const queriedRaw = queries.map((item) => item.raw).join("")
        const emittedNotTested = batch.notTested.some((entry) => entry.featureId === probe.id)
        batch.rawReplies[probe.id] = emittedNotTested && queriedRaw.length === 0 ? trace : queriedRaw
        batch.rawReplies[`${probe.id}.trace`] = trace
      } else {
        batch.rawReplies[probe.id] = trace
      }
    }
  }
  if (ownsTerminal && options.ownedTerminal) {
    batch.rawReplies["collector.geometry"] = JSON.stringify({
      source: options.ownedTerminal?.geometrySource ?? "unavailable: no verified output device",
      bindingReceiptRef: "collector.terminalOwnership",
      grant: options.ownedTerminal.geometryAtGrant ?? null,
      corroboration: options.geometryCorroboration ?? null,
      checks: geometryChecks,
    })
  }
  const observed = new Set(batch.observations.map((item) => item.featureId))
  const namedNotTested = new Set(batch.notTested.map((item) => item.featureId))
  batch.suiteComplete =
    expected.every((probe) => observed.has(probe.id) || namedNotTested.has(probe.id)) &&
    Object.keys(batch.ungradedDiagnostics).length === 0
  return batch
}
