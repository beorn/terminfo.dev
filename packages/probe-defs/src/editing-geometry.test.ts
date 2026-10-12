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

/**
 * The two attribute-rectangle rows stay hand-written (@cto 218ec7fe), so their own CPR callback is
 * still the no-capture path: it declines an incomplete extent before any feature byte or query, and
 * reaches CPR at its floor. Their coverage record lives on `EDITING_CAPTURE_SPECS` in editing.ts.
 */
const HAND_WRITTEN = [
  ["editing.deccara", 3, 5],
  ["editing.decrara", 3, 5],
] as const

test("the hand-written attribute rows decline incomplete extents before feature bytes or CPR", async () => {
  for (const [id, minRows, minCols] of HAND_WRITTEN) {
    const definition = editingProbes.find((probe) => probe.id === id)
    if (!definition?.term) throw new Error(`missing app callback for ${id}`)
    const invalidDimensions: Array<readonly [number, number]> = [
      [minRows - 1, minCols],
      [minRows, minCols - 1],
      [NaN, minCols],
      [minRows, Infinity],
    ]
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
