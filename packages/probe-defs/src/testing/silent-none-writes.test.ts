/**
 * @failure A silent callback fabricates a typed deciding observation from writes or an unanswered query.
 * @level l0
 * @consumer App probe observations admitted by run-parser
 * @testonly none
 */
import { expect, test } from "vitest"
import { ALL_PROBES, type TermProbeSource } from "../index.ts"

const GEOMETRIES = [
  { rows: 1, cols: 1 },
  { rows: 24, cols: 80 },
] as const

function silentTerm(rows: number, cols: number): { ctx: TermProbeSource; writes: string[] } {
  const writes: string[] = []
  const timeout = async () => ({ match: null, reason: "timeout" as const, raw: "", rawBase64: "" })
  const ctx: TermProbeSource = {
    kind: "live",
    write(text) {
      writes.push(text)
    },
    queryCursorPosition: async () => null,
    measureRenderedWidth: async () => ({ kind: "no-reply", step: "sample" }) as const,
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

// Execution-only TODO can follow real writes. The per-row geometry tests retain the zero-byte
// refusal checks; this census proves unanswered I/O is never promoted to a deciding observation.
test("ALL_PROBES silent no-capture callbacks retain execution tests without inventing observations", async () => {
  const appProbes = ALL_PROBES.filter((probe) => probe.term !== null)
  expect(appProbes.length).toBeGreaterThan(0)

  for (const geometry of GEOMETRIES) {
    for (const probe of appProbes) {
      const { ctx, writes } = silentTerm(geometry.rows, geometry.cols)
      const result = await probe.term!(ctx)
      const label = `${probe.id} at ${geometry.rows}x${geometry.cols}`

      expect.soft(result.observation, `${label}; writes=${JSON.stringify(writes)}`).toBeUndefined()
      if (result.observation) continue
      expect(result.assertions, label).toBeUndefined()
      if (result.notTested) continue
      expect(result.tests?.length, label).toBeGreaterThan(0)
      for (const execution of result.tests ?? []) {
        expect(["test-todo", "test-failure"], label).toContain(execution.status)
        expect(execution.reason?.trim().length, label).toBeGreaterThan(0)
      }
    }
  }
})
