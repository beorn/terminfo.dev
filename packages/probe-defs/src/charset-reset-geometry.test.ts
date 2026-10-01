/**
 * @failure A fixed-position charset or reset probe writes or queries an undersized/invalid terminal and reports its legacy callback result as a valid fixture.
 * @level l1
 * @consumer App probe observations collected for terminal support cells.
 * @testonly none
 */
import { expect, test } from "vitest"
import { charsetsProbes } from "./charsets.ts"
import { resetProbes } from "./reset.ts"
import type { TermContext } from "./types.ts"

const fixtures = [
  ["charsets.dec-special", 1, 2],
  ["charsets.utf8", 1, 2],
  ["charsets.g0-g1-switching", 1, 2],
  ["charsets.dec-line-drawing", 1, 7],
  ["reset.sgr", 1, 2],
  ["reset.ris", 5, 5],
  ["reset.soft", 5, 5],
] as const

function app(
  rows: number,
  cols: number,
  events: string[],
  cursorResponses: ReadonlyArray<{ row: number; col: number } | null> = [{ row: 1, col: 2 }],
): TermContext {
  let cursorIndex = 0
  const unexpected = (name: string): never => {
    throw new Error(`Unexpected ${name} in charset/reset geometry fixture`)
  }
  return {
    rows,
    cols,
    write(bytes): void {
      events.push(bytes)
    },
    queryCursorPosition: async () => {
      events.push("CPR")
      return cursorResponses[cursorIndex++] ?? null
    },
    measureRenderedWidth: async () => unexpected("measureRenderedWidth"),
    query: async () => unexpected("query"),
    queryWithSentinel: async () => unexpected("queryWithSentinel"),
    queryOutcome: async () => unexpected("queryOutcome"),
    queryWithSentinelOutcome: async () => unexpected("queryWithSentinelOutcome"),
    queryMode: async () => {
      events.push("mode")
      return null
    },
  }
}

test("fixed charset and reset fixtures require valid measured room before any bytes or CPR", async () => {
  for (const [id, minRows, minCols] of fixtures) {
    const definition = [...charsetsProbes, ...resetProbes].find((probe) => probe.id === id)
    if (!definition?.term) throw new Error(`missing app callback for ${id}`)
    const invalidDimensions: ReadonlyArray<readonly [number, number]> = [
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
    if (id.startsWith("charsets.")) {
      const events: string[] = []
      const valid = await definition.term(app(minRows, minCols, events))
      expect(events.length, id).toBeGreaterThan(1)
      expect(events.at(-1), id).toBe("CPR")
      expect(valid.pass, id).toBe(false)
      expect(valid.response, id).toBe(JSON.stringify({ row: 1, col: 2 }))
      expect(valid.observation, id).toMatchObject({
        outcome: "inconclusive",
        reason: "insufficient-evidence",
        evidence: "consumed",
        note: expect.stringContaining("Cursor movement does not verify charset glyph rendering"),
      })
    } else if (id === "reset.ris") {
      const events: string[] = []
      const valid = await definition.term(
        app(minRows, minCols, events, [
          { row: 5, col: 5 },
          { row: 1, col: 1 },
        ]),
      )
      expect(valid.observation, id).toMatchObject({ outcome: "supported", evidence: "query" })
      expect(valid.response, id).toBe(JSON.stringify({ before: { row: 5, col: 5 }, after: { row: 1, col: 1 } }))
      expect(events).toEqual(["\x1b[5;5H", "CPR", "\x1bc", "CPR"])
    } else {
      const events: string[] = []
      const valid = await definition.term(app(minRows, minCols, events, []))
      expect(valid.observation, id).toMatchObject({
        outcome: "inconclusive",
        reason: "no-response",
        evidence: "query",
      })
      expect(events.at(-1), id).toBe(id === "reset.soft" ? "mode" : "CPR")
    }
  }
})

function decaln() {
  const definition = resetProbes.find((probe) => probe.id === "reset.decaln")
  if (!definition?.term) throw new Error("missing app DECALN callback")
  return definition
}

test("DECALN captures a known non-E grid spanning measured rows and columns without grading pixels", async () => {
  const events: string[] = []
  const context = app(3, 6, events)
  const checkpoints: string[] = []
  context.capture = async ({ role, label }) => {
    checkpoints.push(events.join(""))
    return { role, label, capturedAt: checkpoints.length, ref: `frame-${role}` }
  }
  const result = await decaln().term!(context)
  for (const row of [1, 2, 3]) expect(checkpoints[0]).toContain(`\x1b[${row};1HABABAB`)
  expect(checkpoints[0]).not.toContain("\x1b#8")
  expect(checkpoints[1]).toContain("\x1b#8")
  expect(result.observation).toMatchObject({ outcome: "inconclusive", evidence: "pixels" })
  expect(JSON.parse(result.response ?? "")).toMatchObject({ rows: 3, cols: 6, seed: "ABABAB" })
  expect(result.assertions).toMatchObject([{ kind: "positive", note: expect.stringContaining("capture-only") }])
  expect(events.at(-1)).toContain("\x1b[2J")
})

test.each([1, 2])("DECALN cleans its disposable fixture when capture %i fails", async (failedCapture) => {
  const events: string[] = []
  const context = app(3, 6, events)
  let calls = 0
  const failure = new Error("owned alignment capture failed")
  context.capture = async ({ role, label }) => {
    if (++calls === failedCapture) throw failure
    return { role, label, capturedAt: calls, ref: "control" }
  }
  await expect(decaln().term!(context)).rejects.toBe(failure)
  expect(events.at(-1)).toContain("\x1b[2J")
})

test("DECALN refuses invalid geometry and absent capture without writes", async () => {
  for (const [rows, cols] of [
    [1, 6],
    [3, 1],
    [NaN, 6],
    [3, Infinity],
  ]) {
    const events: string[] = []
    const context = app(rows!, cols!, events)
    context.capture = async () => {
      throw new Error("invalid fixture must not capture")
    }
    expect((await decaln().term!(context)).observation).toMatchObject({ outcome: "inconclusive", evidence: "none" })
    expect(events).toEqual([])
  }
  expect(decaln().termNeedsGeometry).toBe(true)
  const events: string[] = []
  expect((await decaln().term!(app(3, 6, events))).observation?.evidence).toBe("none")
  expect(events).toEqual([])
})
