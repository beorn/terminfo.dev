/**
 * CLI probe adapter — wraps unified probe-defs with TermContext from tty.ts.
 *
 * Imports ALL_PROBES from @terminfo/probe-defs, creates a TermContext using
 * the tty.ts helpers (query, queryCursorPosition, measureRenderedWidth, queryMode),
 * and exports the same `Probe[]` interface the CLI expects.
 */

import {
  ALL_PROBES as PROBE_DEFS,
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
import type { ClipboardTraceEvent, LinuxClipboardAdapter } from "../linux-clipboard.ts"

export interface Probe {
  id: string
  name: string
}

/** Build a TermContext from the tty.ts helpers */
function createTermContext(writes?: string[], events?: TTYTraceEvent[]): TermContext {
  return {
    write(text: string) {
      writes?.push(text)
      events?.push({ kind: "write", sequence: text })
      process.stdout.write(text)
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
      return process.stdout.columns || 80
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
  ungradedDiagnostics: Record<string, UngradedDiagnostic>
  suiteComplete: boolean
  screenshotRefs: string[]
}

export type ProbeCapture = (checkpoint: {
  featureId: string
  role: ObservationFrame["role"]
  label: string
}) => Promise<{ frame: ObservationFrame; trace: Record<string, unknown> }>

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
  options: { ids?: string[]; capture?: ProbeCapture; clipboard?: LinuxClipboardAdapter } = {},
): Promise<ProbeBatch> {
  const { expected, selected } = selectAppProbes(options.ids)
  const batch: ProbeBatch = {
    rawReplies: {},
    observations: [],
    assertions: [],
    ungradedDiagnostics: {},
    suiteComplete: false,
    screenshotRefs: [],
  }
  for (const probe of selected) {
    const writes: string[] = []
    const queries: TTYQueryTrace[] = []
    const events: TTYTraceEvent[] = []
    const clipboardEvents: ClipboardTraceEvent[] = []
    const captures: Array<{ frame: ObservationFrame; trace: Record<string, unknown> }> = []
    let captureAttempted = false
    const context = createTermContext(writes, events)
    if (options.clipboard) {
      const clipboard = options.clipboard
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
      const result = await withTTYOperation(() => withTTYQueryTrace(queries, events, () => callback(context)))
      if (result.observation) {
        const rawReplyRef = queries.length || captureAttempted || clipboardEvents.length ? probe.id : undefined
        batch.observations.push({ featureId: probe.id, ...result.observation, ...(rawReplyRef ? { rawReplyRef } : {}) })
        for (const assertion of result.assertions ?? []) {
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
      const errorEvidence = captureAttempted ? "pixels" : probe.termObservationEvidence
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
      if (probe.id === "device.primary-da" || probe.id === "device.xtversion") {
        batch.rawReplies[probe.id] = queries.map((item) => item.raw).join("")
        batch.rawReplies[`${probe.id}.trace`] = trace
      } else {
        batch.rawReplies[probe.id] = trace
      }
    }
  }
  const observed = new Set(batch.observations.map((item) => item.featureId))
  batch.suiteComplete =
    expected.every((probe) => observed.has(probe.id)) && Object.keys(batch.ungradedDiagnostics).length === 0
  return batch
}
