/**
 * @failure Fixed editing fixtures emit feature bytes or query CPR when the measured terminal cannot fit the complete edit extent - or, once a family converts to the region kind, keep a cursor-only fallback that a run with no owned capture can only answer "inconclusive".
 * @level l1
 * @consumer App editing observations collected for terminal support cells.
 * @testonly none
 */
import { expect, test } from "vitest"
import { editingProbes, editingReadbackRows } from "./editing.ts"
import type { TermProbeSource } from "./types.ts"

function app(rows: number, cols: number, events: string[]): TermProbeSource {
  const unexpected = (name: string): never => {
    throw new Error(`Unexpected ${name} in editing geometry fixture`)
  }
  return {
    kind: "live",
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
 * capture has no deciding observable. The callback records a named execution-only TODO rather than
 * retaining a typed observation, so every one of them writes nothing - on the smallest grid, on a
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
      expect(result.observation, `${row.id} at ${rows}x${cols}`).toBeUndefined()
      expect(result.tests, `${row.id} at ${rows}x${cols}`).toMatchObject([
        expect.objectContaining({
          status: "test-todo",
          reason: expect.stringContaining("no owned capture adapter"),
        }),
      ])
      expect(events, `${row.id} at ${rows}x${cols}`).toEqual([])
    }
  }
})

/**
 * Restored from the deleted HAND_WRITTEN test (@cto round-2 B5): the converted attribute rows still
 * refuse a grid smaller than the extent they address, BEFORE any feature byte and before any query.
 * The old test's other half — "reaches CPR at its floor" — has no counterpart by design: these rows
 * now take the capture-region path. The floor itself is 5x8 (the sentinel row and the compared
 * region's right edge plus the family margin); 24x80 is only the roomy grid the readback tests use,
 * and the boundary pair below pins both sides of the real floor (@cto round-3c B7).
 */
test("a converted attribute row refuses an undersized grid before any byte or query", async () => {
  for (const id of ["editing.deccara", "editing.decrara"]) {
    const row = editingReadbackRows.find((entry) => entry.id === id)
    const definition = editingProbes.find((probe) => probe.id === id)
    if (!row?.sentinel || !definition?.term) throw new Error(`missing app callback for ${id}`)
    for (const [rows, cols] of [
      [row.sentinel.row - 1, 8],
      [row.sentinel.row, 7],
      [row.sentinel.row, 4],
      [Number.NaN, 80],
      [24, Number.POSITIVE_INFINITY],
    ] as const) {
      const events: string[] = []
      const context: TermProbeSource = {
        ...app(rows, cols, events),
        capture: async () => {
          throw new Error(`${id} reached capture on an undersized grid`)
        },
      }
      const result = await definition.term(context)
      expect(events, `${id} at ${rows}x${cols}`).toEqual([])
      expect(result.observation, `${id} at ${rows}x${cols}`).toBeUndefined()
      expect(result.tests, `${id} at ${rows}x${cols}`).toMatchObject([
        expect.objectContaining({ status: "test-todo", reason: expect.stringContaining("at least") }),
      ])
    }
    // The other side of the boundary: 5x8 is the floor, so the arm must reach its own work instead
    // of refusing. A capture that throws is the cheapest proof it got past the geometry gate.
    const floor: TermProbeSource = {
      ...app(row.sentinel.row, 8, []),
      // A calibrated geometry keeps the arm from needing an unanswerable pixel query, so the only
      // thing that can stop it before the capture is the geometry gate this test measures.
      captureGeometry: {
        geometry: { cellWidth: 8, cellHeight: 16, textWidth: 8 * 8, textHeight: 16 * row.sentinel.row },
        source: "measured by complete raster calibration",
      },
      capture: async () => {
        throw new Error(`${id} reached capture at its 5x8 floor`)
      },
    }
    await expect(definition.term(floor), `${id} at 5x8`).rejects.toThrow(/reached capture at its 5x8 floor/)
  }
})
