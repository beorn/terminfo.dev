/**
 * @failure Direct mode fixtures write into undersized terminals or leave their own mode/cursor state set after a write or query failure.
 * @level l1
 * @consumer App mode observations collected for terminal support cells.
 * @testonly none
 */
import { expect, test } from "vitest"
import { modesProbes } from "./modes.ts"
import type { TermContext } from "./types.ts"

const fixtures = [
  { id: "modes.alt-screen.exit", rows: 3, cols: 3, failedWrite: 2, restore: "\x1b[?1049l" },
  { id: "modes.insert-replace", rows: 1, cols: 5, failedWrite: 7, restore: "\x1b[4l" },
  { id: "modes.altscreen-1048", rows: 15, cols: 20, failedWrite: 3, restore: "\x1b[?1048l" },
] as const

const stateFixtures = [
  { id: "modes.xtpushsgr", enter: "\x1b[#{", restore: "\x1b[#}" },
  { id: "modes.xtsave", enter: "\x1b[?7s", restore: "\x1b[?7r" },
  { id: "modes.xtpushcolors", enter: "\x1b[#P", restore: "\x1b[#Q" },
] as const

function app(
  rows: number,
  cols: number,
  events: string[],
  failWrite?: number,
  failQuery = false,
  cursorReplies: Array<{ row: number; col: number }> = [{ row: 5, col: 10 }],
): TermContext {
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
      if (failQuery) throw new Error("injected CPR failure")
      return cursorReplies.shift() ?? { row: 5, col: 10 }
    },
    measureRenderedWidth: async () => unexpected("measureRenderedWidth"),
    query: async () => unexpected("query"),
    // The IRM toggle reads ANSI mode 4 through DECRQM (#30557 r2); this fixture models a terminal that never answers.
    queryWithSentinel: async (sequence) =>
      /^\x1b\[\??\d+\$p$/.test(sequence) ? null : unexpected("queryWithSentinel"),
    queryOutcome: async () => unexpected("queryOutcome"),
    queryWithSentinelOutcome: async () => ({ match: null, reason: "timeout", raw: "", rawBase64: "" }),
    queryMode: async () => unexpected("queryMode"),
  }
}

test("direct mode fixtures decline invalid geometry and classify only measured valid observations", async () => {
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
    const cursorReplies =
      id === "modes.altscreen-1048"
        ? [
            { row: 5, col: 10 },
            { row: 15, col: 20 },
            { row: 5, col: 10 },
          ]
        : undefined
    const result = await definition.term(app(rows, cols, events, undefined, false, cursorReplies))
    expect(events.length, id).toBeGreaterThan(1)
    expect(events.at(-1), id).toBe("CPR")
    if (id === "modes.altscreen-1048") {
      expect(events, id).toEqual(["\x1b[5;10H", "CPR", "\x1b[?1048h", "\x1b[15;20H", "CPR", "\x1b[?1048l", "CPR"])
      expect(result.pass, id).toBe(true)
      expect(result.observation, id).toMatchObject({ outcome: "supported", evidence: "query" })
    } else {
      expect(result.pass, id).toBe(false)
      expect(result.observation, id).toMatchObject({
        outcome: "inconclusive",
        reason: "insufficient-evidence",
        evidence: "query",
      })
    }
  }
})

test("direct mode fixtures attempt only their entered-state cleanup after a later write fails", async () => {
  for (const { id, rows, cols, failedWrite, restore } of fixtures) {
    const definition = modesProbes.find((probe) => probe.id === id)
    if (!definition?.term) throw new Error(`Missing app callback for ${id}`)
    const events: string[] = []
    await expect(
      definition.term(app(rows, cols, events, failedWrite, false, [{ row: 5, col: 10 }])),
      id,
    ).rejects.toThrow("injected write failure")
    expect(events.at(-1), id).toBe(restore)
    if (id === "modes.altscreen-1048") {
      expect(events, id).toEqual(["\x1b[5;10H", "CPR", "\x1b[?1048h", "\x1b[15;20H", restore])
    } else {
      expect(events, id).not.toContain("CPR")
    }
  }
})

test("insert mode is disabled when its initial ANSI mode query rejects", async () => {
  const definition = modesProbes.find((probe) => probe.id === "modes.insert-replace")
  if (!definition?.term) throw new Error("Missing insert-replace app callback")
  const events: string[] = []
  const context = app(1, 6, events)
  context.queryWithSentinel = async () => {
    events.push("ANSI mode query")
    throw new Error("injected ANSI mode query failure")
  }

  await expect(definition.term(context)).rejects.toThrow("injected ANSI mode query failure")
  expect(events).toEqual(["\x1b[4h", "ANSI mode query", "\x1b[4l"])
})

test.each(stateFixtures)(
  "$id restores its own checkpoint after CPR rejects and keeps the valid path inconclusive",
  async ({ id, enter, restore }) => {
    const definition = modesProbes.find((probe) => probe.id === id)
    if (!definition?.term) throw new Error(`Missing app callback for ${id}`)
    const failedEvents: string[] = []
    await expect(definition.term(app(1, 1, failedEvents, undefined, true))).rejects.toThrow("injected CPR failure")
    expect(failedEvents).toEqual([enter, "CPR", restore])

    const validEvents: string[] = []
    const result = await definition.term(app(1, 1, validEvents))
    expect(validEvents).toEqual([enter, "CPR", restore])
    expect(result.pass).toBe(false)
    expect(result.observation).toMatchObject({
      outcome: "inconclusive",
      reason: "insufficient-evidence",
      evidence: "consumed",
    })
    expect(result.assertions).toBeUndefined()
  },
)
