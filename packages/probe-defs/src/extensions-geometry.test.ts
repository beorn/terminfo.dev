/**
 * @failure OSC 8 and OSC 66 app fixtures write and query when measured geometry cannot fit their complete samples.
 * @level l1
 * @consumer App extension observations collected for terminal support cells.
 * @testonly none
 */
import { expect, test } from "vitest"
import { extensionsProbes } from "./extensions.ts"
import type { TermContext } from "./types.ts"

const fixtures = [
  { id: "extensions.osc8", rows: 1, cols: 7, columns: [7], outcome: "inconclusive", evidence: "consumed" },
  {
    id: "extensions.osc66-text-sizing",
    rows: 1,
    cols: 5,
    columns: [1, 3, 5],
    outcome: "supported",
    evidence: "behavior",
  },
] as const

function app(rows: number, cols: number, events: string[], columns: readonly number[]): TermContext {
  const unexpected = (name: string): never => {
    throw new Error(`Unexpected ${name} in extension geometry fixture`)
  }
  let query = 0
  return {
    rows,
    cols,
    write(bytes): void {
      events.push(bytes)
    },
    queryCursorPosition: async () => {
      events.push("CPR")
      const col = columns[query++]
      if (col === undefined) return unexpected("extra CPR")
      return { row: 1, col }
    },
    measureRenderedWidth: async () => unexpected("measureRenderedWidth"),
    query: async () => unexpected("query"),
    queryWithSentinel: async () => unexpected("queryWithSentinel"),
    queryOutcome: async () => unexpected("queryOutcome"),
    queryWithSentinelOutcome: async () => unexpected("queryWithSentinelOutcome"),
    queryMode: async () => unexpected("queryMode"),
  }
}

test.each(fixtures)("$id declines invalid or undersized geometry before bytes or queries", async (fixture) => {
  const { id, rows, cols, columns, outcome, evidence } = fixture
  const definition = extensionsProbes.find((probe) => probe.id === id)
  if (!definition?.term) throw new Error(`Missing app callback for ${id}`)
  const invalidDimensions: ReadonlyArray<readonly [number, number]> = [
    [rows - 1, cols],
    [rows, cols - 1],
    [NaN, cols],
    [rows, Infinity],
    [rows + 0.5, cols],
    [rows, Number.MAX_SAFE_INTEGER + 1],
  ]
  for (const [measuredRows, measuredCols] of invalidDimensions) {
    const events: string[] = []
    const result = await definition.term(app(measuredRows, measuredCols, events, columns))
    expect(events, `${id} at ${measuredRows}x${measuredCols}`).toEqual([])
    expect(result.observation, id).toMatchObject({
      outcome: "inconclusive",
      reason: "insufficient-evidence",
      evidence: "none",
    })
  }
  expect(definition.termNeedsGeometry, id).toBe(true)
  const events: string[] = []
  const result = await definition.term(app(rows, cols, events, columns))
  expect(events.at(-1), id).toBe("CPR")
  expect(result.observation, id).toMatchObject({ outcome, evidence })
})
