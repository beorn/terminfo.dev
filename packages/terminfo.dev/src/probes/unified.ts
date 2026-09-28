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
  type ProbeAssertion,
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
}

/** Collect the real callback result, without treating its legacy boolean as an observation. */
export async function runProbeBatch(options: { ids?: string[] } = {}): Promise<ProbeBatch> {
  const expected = PROBE_DEFS.filter((probe) => probe.term !== null)
  const selected = options.ids
    ? options.ids.map((id) => {
        const probe = expected.find((item) => item.id === id)
        if (!probe) throw new Error(`Unknown or inapplicable app probe ${id}`)
        return probe
      })
    : expected
  if (new Set(selected.map((probe) => probe.id)).size !== selected.length) {
    throw new Error("Duplicate probe ID in app batch")
  }
  const batch: ProbeBatch = {
    rawReplies: {},
    observations: [],
    assertions: [],
    ungradedDiagnostics: {},
    suiteComplete: false,
  }
  for (const probe of selected) {
    const writes: string[] = []
    const queries: TTYQueryTrace[] = []
    const events: TTYTraceEvent[] = []
    const context = createTermContext(writes, events)
    try {
      if (!probe.term) throw new Error(`No app callback for ${probe.id}`)
      const callback = probe.term
      const result = await withTTYOperation(() => withTTYQueryTrace(queries, events, () => callback(context)))
      if (result.observation) {
        const rawReplyRef = queries.length ? probe.id : undefined
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
      if (probe.termObservationEvidence) {
        batch.observations.push({
          featureId: probe.id,
          outcome: "error",
          reason: "collector-error",
          evidence: probe.termObservationEvidence,
          note: message,
          ...(queries.length ? { rawReplyRef: probe.id } : {}),
        })
      } else {
        batch.ungradedDiagnostics[probe.id] = { kind: "collector-error", name, message }
      }
    } finally {
      const trace = JSON.stringify({ writes, queries, events })
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
