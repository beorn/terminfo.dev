/**
 * @failure Fixed editing fixtures emit feature bytes or query CPR when the measured terminal cannot fit the complete edit extent.
 * @level l1
 * @consumer App editing observations collected for terminal support cells.
 * @testonly none
 */
import { expect, test } from "vitest"
import { editingProbes } from "./editing.ts"
import type { TermContext } from "./types.ts"

const fixtures = [
  ["editing.insert-chars", 1, 5],
  ["editing.delete-chars", 1, 5],
  ["editing.insert-lines", 3, 5],
  ["editing.delete-lines", 3, 5],
  ["editing.repeat-char", 1, 6],
  ["editing.decfra", 3, 5],
  ["editing.decera", 3, 5],
  ["editing.decsera", 3, 5],
  ["editing.deccra", 6, 14],
  ["editing.deccara", 3, 5],
  ["editing.decrara", 3, 5],
  ["editing.sl", 1, 8],
  ["editing.sr", 1, 9],
  ["editing.decic", 3, 4],
  ["editing.decdc", 3, 4],
] as const

function app(rows: number, cols: number, events: string[]): TermContext {
  const unexpected = (name: string): never => {
    throw new Error(`Unexpected ${name} in editing geometry fixture`)
  }
  return {
    rows,
    cols,
    write(bytes): void {
      events.push(bytes)
    },
    queryCursorPosition: async () => {
      events.push("CPR")
      return { row: 3, col: 6 }
    },
    measureRenderedWidth: async () => unexpected("measureRenderedWidth"),
    query: async () => unexpected("query"),
    queryWithSentinel: async () => unexpected("queryWithSentinel"),
    queryOutcome: async () => unexpected("queryOutcome"),
    queryWithSentinelOutcome: async () => unexpected("queryWithSentinelOutcome"),
    queryMode: async () => unexpected("queryMode"),
  }
}

test("editing fixtures decline incomplete extents before feature bytes or CPR", async () => {
  for (const [id, minRows, minCols] of fixtures) {
    const definition = editingProbes.find((probe) => probe.id === id)
    if (!definition?.term) throw new Error(`missing app callback for ${id}`)
    const invalidDimensions: Array<readonly [number, number]> = [
      [minRows - 1, minCols],
      [minRows, minCols - 1],
      [NaN, minCols],
      [minRows, Infinity],
    ]
    if (id === "editing.deccra") invalidDimensions.push([5, 10])
    for (const [rows, cols] of invalidDimensions) {
      const events: string[] = []
      const result = await definition.term(app(rows, cols, events))
      expect(events, `${id} at ${rows}x${cols}`).toEqual([])
      expect(result.observation, `${id} at ${rows}x${cols}`).toMatchObject({
        outcome: "inconclusive",
        reason: "insufficient-evidence",
        evidence: "none",
      })
    }
    expect(definition.termNeedsGeometry, id).toBe(true)
    const events: string[] = []
    const valid = await definition.term(app(minRows, minCols, events))
    expect(events.length, id).toBeGreaterThan(1)
    expect(events.at(-1), id).toBe("CPR")
    expect(valid.observation, id).toMatchObject({
      outcome: "inconclusive",
      evidence: "query",
      reason: "insufficient-evidence",
    })
    expect(valid.pass, id).toBe(false)
    expect(valid.response, id).toBe("3;6")
  }
})
