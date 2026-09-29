/**
 * @failure Direct mode fixtures write into undersized terminals or leave their own mode/cursor state set after a write failure.
 * @level l1
 * @consumer App mode observations collected for terminal support cells.
 * @testonly none
 */
import { expect, test } from "vitest"
import { modesProbes } from "./modes.ts"
import type { TermContext } from "./types.ts"

const fixtures = [
  { id: "modes.alt-screen.exit", rows: 3, cols: 3, failedWrite: 2, restore: "\x1b[?1049l" },
  { id: "modes.insert-replace", rows: 1, cols: 5, failedWrite: 5, restore: "\x1b[4l" },
  { id: "modes.altscreen-1048", rows: 15, cols: 20, failedWrite: 3, restore: "\x1b[?1048l" },
] as const

function app(rows: number, cols: number, events: string[], failWrite?: number): TermContext {
  const unexpected = (name: string): never => {
    throw new Error(`Unexpected ${name} in mode fixture`)
  }
  let writes = 0
  return {
    rows,
    cols,
    write(bytes): void {
      events.push(bytes)
      if (++writes === failWrite) throw new Error("injected write failure")
    },
    queryCursorPosition: async () => {
      events.push("CPR")
      return { row: 5, col: 10 }
    },
    measureRenderedWidth: async () => unexpected("measureRenderedWidth"),
    query: async () => unexpected("query"),
    queryWithSentinel: async () => unexpected("queryWithSentinel"),
    queryOutcome: async () => unexpected("queryOutcome"),
    queryWithSentinelOutcome: async () => unexpected("queryWithSentinelOutcome"),
    queryMode: async () => unexpected("queryMode"),
  }
}

test("direct mode fixtures decline invalid or undersized geometry before bytes or queries", async () => {
  for (const { id, rows, cols } of fixtures) {
    const definition = modesProbes.find((probe) => probe.id === id)
    if (!definition?.term) throw new Error(`Missing app callback for ${id}`)
    for (const [measuredRows, measuredCols] of [
      [rows - 1, cols],
      [rows, cols - 1],
      [NaN, cols],
      [rows, Infinity],
      [rows + 0.5, cols],
      [rows, Number.MAX_SAFE_INTEGER + 1],
    ] as const) {
      const events: string[] = []
      const result = await definition.term(app(measuredRows, measuredCols, events))
      expect(events, `${id} at ${measuredRows}x${measuredCols}`).toEqual([])
      expect(result.observation, id).toMatchObject({
        outcome: "inconclusive",
        reason: "insufficient-evidence",
        evidence: "none",
      })
    }
    expect(definition.termNeedsGeometry, id).toBe(true)
    const events: string[] = []
    const result = await definition.term(app(rows, cols, events))
    expect(events.length, id).toBeGreaterThan(1)
    expect(events.at(-1), id).toBe("CPR")
    expect(result.observation, id).toBeUndefined()
  }
})

test("direct mode fixtures attempt only their entered-state cleanup after a later write fails", async () => {
  for (const { id, rows, cols, failedWrite, restore } of fixtures) {
    const definition = modesProbes.find((probe) => probe.id === id)
    if (!definition?.term) throw new Error(`Missing app callback for ${id}`)
    const events: string[] = []
    await expect(definition.term(app(rows, cols, events, failedWrite)), id).rejects.toThrow("injected write failure")
    expect(events.at(-1), id).toBe(restore)
    expect(events, id).not.toContain("CPR")
  }
})
