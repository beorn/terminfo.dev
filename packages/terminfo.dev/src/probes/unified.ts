/**
 * CLI probe adapter — wraps unified probe-defs with TermContext from tty.ts.
 *
 * Imports ALL_PROBES from @terminfo/probe-defs, creates a TermContext using
 * the tty.ts helpers (query, queryCursorPosition, measureRenderedWidth, queryMode),
 * and exports the same `Probe[]` interface the CLI expects.
 */

import {
  ALL_PROBES as PROBE_DEFS,
  type NotTestedCoverage,
  type Observation,
  type ObservationFrame,
  type ProbeAssertion,
  type ProbeDefinition,
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
  withTTYOperation,
  withTTYQueryTrace,
  type TTYQueryTrace,
  type TTYTraceEvent,
} from "../tty.ts"
import type { ClipboardTraceEvent } from "../linux-clipboard.ts"
import { ownedTerminalVerifiedFor, type GeometryMeasurement, type OwnedTerminal } from "../owned-terminal.ts"

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

/** Collect the real callback result, without treating its legacy boolean as an observation. */
export async function runProbeBatch(
  options: {
    ids?: string[]
    capture?: ProbeCapture
    ownedTerminal?: OwnedTerminal
    captureRunId?: string
    out?: NodeJS.WriteStream
    geometryCorroboration?: GeometryCorroboration
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
  for (const probe of selected) {
    const writes: string[] = []
    const queries: TTYQueryTrace[] = []
    const events: TTYTraceEvent[] = []
    const clipboardEvents: ClipboardTraceEvent[] = []
    const captures: Array<{ frame: ObservationFrame; trace: Record<string, unknown> }> = []
    let captureAttempted = false
    if (
      probe.termWrites !== "query" &&
      !ownedTerminalVerifiedFor(options.ownedTerminal, options.captureRunId ?? "", out)
    ) {
      batch.observations.push({
        featureId: probe.id,
        outcome: "inconclusive",
        reason: "policy-refused",
        evidence: "none",
        note: "Collector refused before sending bytes because disposable terminal ownership was not verified",
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
      const geometryOwner = ownedTerminalVerifiedFor(options.ownedTerminal, options.captureRunId ?? "", out)
      const grant = geometryOwner ? options.ownedTerminal?.geometryAtGrant : undefined
      if (grant?.status === "measured") {
        preGeometry = await readGeometry()
        geometryCheck.pre = preGeometry
      }
      const corroboration = options.geometryCorroboration
      const diagnostic = !geometryOwner
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
        const assertions = result.assertions ?? []
        const parts: string[] = []
        if (result.observation) {
          const observedReason = result.observation.reason ? `, reason=${result.observation.reason}` : ""
          parts.push(`observation(outcome=${result.observation.outcome}${observedReason})`)
        }
        if (assertions.length > 0) parts.push(`${assertions.length} assertion(s)`)
        if (result.observation !== undefined || assertions.length > 0) {
          batch.ungradedDiagnostics[probe.id] = {
            kind: "collector-error",
            name: "Error",
            message: `Not-tested coverage for ${probe.id} arrived beside ${parts.join(" and ")}; a probe that claims no semantic observable cannot also carry a measurement, so the coverage claim is refused and its evidence stays a collector error`,
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
        batch.ungradedDiagnostics[probe.id] = {
          kind: "legacy-callback",
          pass: result.pass,
          ...(result.note ? { note: result.note } : {}),
          ...(result.response ? { response: result.response } : {}),
        }
      }
    } catch (error) {
      const name = error instanceof Error ? error.name : "Error"
      const message = error instanceof Error ? error.message : String(error)
      const errorEvidence =
        name === "UndeclaredTerminalGeometry" ? undefined : captureAttempted ? "pixels" : probe.termObservationEvidence
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
        batch.rawReplies[probe.id] = queries.map((item) => item.raw).join("")
        batch.rawReplies[`${probe.id}.trace`] = trace
      } else {
        batch.rawReplies[probe.id] = trace
      }
    }
  }
  if (options.ownedTerminal && ownedTerminalVerifiedFor(options.ownedTerminal, options.captureRunId ?? "", out)) {
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
