/**
 * @failure Fixed editing fixtures emit feature bytes or query CPR when the measured terminal cannot fit the complete edit extent - or, once a family converts to the region kind, keep a cursor-only fallback that a run with no owned capture can only answer "inconclusive".
 * @level l1
 * @consumer App editing observations collected for terminal support cells.
 * @testonly none
 */
import { expect, test } from "vitest"
import { editingProbes, editingReadbackRows } from "./editing.ts"
import type { TermContext } from "./types.ts"

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

/**
 * 28450 slice C: the thirteen converted rows are decided by the region verdict, so a run with no owned
 * capture can only answer "inconclusive". A fixture that can only answer that is deleted rather than
 * kept (@cto A2), so every one of them refuses BY NAME and writes nothing - on the smallest grid, on a
 * grid at the row's own derived need and on a large one alike. This replaces the old per-row
 * "declines incomplete extents before feature bytes or CPR" test for these ids, which had no meaning
 * once their cursor-only fallback was deleted.
 */
test("every converted row refuses by name and writes nothing without an owned capture", async () => {
  for (const row of editingReadbackRows) {
    const definition = editingProbes.find((probe) => probe.id === row.id)
    if (!definition?.term) throw new Error(`missing app callback for ${row.id}`)
    expect(definition.termNeedsGeometry, row.id).toBe(true)
    for (const [rows, cols] of [
      [1, 1],
      [4, 24],
      [24, 80],
    ] as const) {
      const events: string[] = []
      const result = await definition.term(app(rows, cols, events))
      expect(result.observation, `${row.id} at ${rows}x${cols}`).toMatchObject({
        outcome: "inconclusive",
        reason: "insufficient-evidence",
        evidence: "none",
      })
      expect(String(result.observation?.note), `${row.id} at ${rows}x${cols}`).toContain("no owned capture adapter")
      expect(events, `${row.id} at ${rows}x${cols}`).toEqual([])
    }
  }
})
