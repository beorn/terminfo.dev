/**
 * @failure A probe writes a query then claims evidence "none", so run-parser's zero-byte rule refuses the run.
 * @level l0
 * @consumer App probe observations admitted by run-parser
 * @testonly none
 */
import { expect, test } from "vitest"
import { validateObservation } from "@terminfo/run-parser"
import { ALL_PROBES, type Observation, type ProbeAssertion, type ProbeResult, type TermContext } from "../index.ts"

const GEOMETRIES = [
  { rows: 1, cols: 1 },
  { rows: 24, cols: 80 },
] as const

function silentTerm(rows: number, cols: number): { ctx: TermContext; writes: string[] } {
  const writes: string[] = []
  const timeout = async () => ({ match: null, reason: "timeout" as const, raw: "", rawBase64: "" })
  const ctx: TermContext = {
    write(text) {
      writes.push(text)
    },
    queryCursorPosition: async () => null,
    measureRenderedWidth: async () => null,
    query: async () => null,
    queryWithSentinel: async () => null,
    queryOutcome: timeout,
    queryWithSentinelOutcome: timeout,
    queryMode: async () => null,
    cols,
    rows,
  }
  return { ctx, writes }
}

function measuredObservation(
  result: ProbeResult,
): result is Extract<ProbeResult, { observation: NonNullable<ProbeResult["observation"]> }> {
  return "observation" in result && result.observation !== undefined
}

test("ALL_PROBES silent no-capture none evidence implies zero writes at 1x1 and 24x80", async () => {
  const appProbes = ALL_PROBES.filter((probe) => probe.term !== null)
  expect(appProbes.length).toBeGreaterThan(0)

  for (const geometry of GEOMETRIES) {
    for (const probe of appProbes) {
      const { ctx, writes } = silentTerm(geometry.rows, geometry.cols)
      const result = await probe.term!(ctx)
      const label = `${probe.id} at ${geometry.rows}x${geometry.cols}`

      if (!measuredObservation(result)) continue

      if (result.observation.evidence === "none") {
        expect(writes, `${label} claimed evidence none after writes`).toEqual([])
      }

      const observation: Observation = {
        featureId: probe.id,
        ...result.observation,
      }
      const rawReplies: Record<string, string> = {}
      const assertions: ProbeAssertion[] = (result.assertions ?? []).map((entry) => ({
        ...entry,
        featureId: probe.id,
        rawReplyRef: probe.id,
      }))
      if (observation.evidence === "none") {
        observation.rawReplyRef = probe.id
        rawReplies[probe.id] = JSON.stringify({ writes, queries: [], events: [] })
      }
      validateObservation(observation, label, rawReplies, assertions)
    }
  }
})
