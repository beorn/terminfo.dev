/**
 * @failure A fixed-position charset or reset probe writes or queries an undersized/invalid terminal and reports its legacy callback result as a valid fixture.
 * @level l1
 * @consumer App probe observations collected for terminal support cells.
 * @testonly none
 */
import { afterEach, expect, test, vi } from "vitest"
import { charsetsProbes } from "./charsets.ts"
import { resetProbes } from "./reset.ts"
import type { ObservationFrame, TermContext } from "./types.ts"

afterEach(() => vi.useRealTimers())

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

test("DEC special pixels retain independent glyph controls, exact designation order and ungraded frame bindings", async () => {
  const definition = charsetsProbes.find((probe) => probe.id === "charsets.dec-special")
  if (!definition?.term) throw new Error("missing app DEC special callback")
  const events: string[] = []
  const context = app(4, 6, events)
  const snapshots: string[][] = []
  const frames: ObservationFrame[] = []
  context.capture = async ({ role, label }) => {
    snapshots.push([...events])
    const frame = { role, label, capturedAt: frames.length + 1, ref: `sha256:${String(frames.length + 1).repeat(64)}` }
    frames.push(frame)
    return frame
  }
  const result = await definition.term(context)
  const controlWrites = [
    "\x0f\x1b(B\x1b)B\x1b[0m",
    "\x1b[1;1H     \x1b[1;1Hqqq",
    "\x1b[2;1H     \x1b[2;1Hq─q",
    "\x1b[3;1H     \x1b[3;1Hqqq",
    "\x1b[4;1H     \x1b[4;1Hqqq",
    "\x1b[4;6H",
  ]
  expect(snapshots).toEqual([
    controlWrites,
    [...controlWrites, "\x1b[3;2H\x1b(0q\x1b(Bq", "\x0f\x1b(B\x1b)B\x1b[4;1Hqqq\x1b[4;6H"],
  ])
  expect(frames.map(({ role }) => role)).toEqual(["control", "target"])
  expect(frames[0]?.label).toContain("row 2")
  expect(frames[0]?.label).toContain("Unicode")
  expect(frames[1]?.label).toContain("row 3, column 2")
  expect(result.pass).toBe(false)
  expect(result.observation).toMatchObject({
    outcome: "inconclusive",
    reason: "insufficient-evidence",
    evidence: "pixels",
    frames,
    screenshotRef: frames[1]?.ref,
    note: expect.stringContaining("horizontal-line appearance"),
  })
  expect(result.observation?.note).toContain("independent review")
  expect(result.assertions ?? []).toEqual([])
  expect(events.at(-1)).toBe("\x1b[0m\x0f\x1b(B\x1b)B")
})

test("DEC special capture requires safe measured 4x6 before writes or captures", async () => {
  const definition = charsetsProbes.find((probe) => probe.id === "charsets.dec-special")
  if (!definition?.term) throw new Error("missing app DEC special callback")
  for (const [rows, cols] of [
    [3, 6],
    [4, 5],
    [NaN, 6],
    [4, Infinity],
    [4.5, 6],
    [4, 6.5],
    [Number.MAX_SAFE_INTEGER + 1, 6],
  ]) {
    const events: string[] = []
    const context = app(rows!, cols!, events)
    const capture = vi.fn(async ({ role, label }: { role: ObservationFrame["role"]; label: string }) => ({
      role,
      label,
      capturedAt: 1,
      ref: "never",
    }))
    context.capture = capture
    const result = await definition.term(context)
    expect(events, `${rows}x${cols}`).toEqual([])
    expect(capture, `${rows}x${cols}`).not.toHaveBeenCalled()
    expect(result.observation).toMatchObject({
      outcome: "inconclusive",
      reason: "insufficient-evidence",
      evidence: "none",
    })
    expect(result.observation?.note).toContain(`4x6, measured ${rows}x${cols}`)
  }
})

test.each([1, 2])(
  "DEC special normalizes SGR and both ASCII designations when capture %i rejects",
  async (failedCapture) => {
    const definition = charsetsProbes.find((probe) => probe.id === "charsets.dec-special")
    if (!definition?.term) throw new Error("missing app DEC special callback")
    const events: string[] = []
    const context = app(4, 6, events)
    const failure = new Error("owned charset capture failed")
    let calls = 0
    context.capture = async ({ role, label }) => {
      if (++calls === failedCapture) throw failure
      return { role, label, capturedAt: calls, ref: "control" }
    }
    await expect(definition.term(context)).rejects.toBe(failure)
    expect(calls).toBe(failedCapture)
    expect(events.at(-1)).toBe("\x1b[0m\x0f\x1b(B\x1b)B")
  },
)

test.each([{ row: 1, col: 2 }, null])(
  "DEC special without capture preserves exact legacy writes and CPR labels for %j",
  async (cursor) => {
    const definition = charsetsProbes.find((probe) => probe.id === "charsets.dec-special")
    if (!definition?.term) throw new Error("missing app DEC special callback")
    const events: string[] = []
    const result = await definition.term(app(1, 2, events, [cursor]))
    expect(events).toEqual(["\x1b[1;1H\x1b[2K", "\x1b(0", "q", "\x1b(B", "CPR"])
    expect(result).toEqual(
      cursor
        ? {
            pass: false,
            response: JSON.stringify(cursor),
            note: "Cursor movement does not verify charset glyph rendering or mapping",
            observation: {
              outcome: "inconclusive",
              reason: "insufficient-evidence",
              evidence: "consumed",
              note: "Cursor movement does not verify charset glyph rendering or mapping",
            },
          }
        : {
            pass: false,
            note: "No cursor response",
            observation: { outcome: "inconclusive", reason: "no-response", evidence: "query" },
          },
    )
  },
)

function decaln() {
  const definition = resetProbes.find((probe) => probe.id === "reset.decaln")
  if (!definition?.term) throw new Error("missing app DECALN callback")
  return definition
}

test.each([{ row: 1, col: 1 }, null])(
  "DECALN retains CPR %j and separates five-second, cursor-only and ordinary-glyph checkpoints without grading pixels",
  async (cursor) => {
    vi.useFakeTimers()
    const events: string[] = []
    const context = app(3, 6, events, [cursor])
    const checkpoints: string[] = []
    const checkpointTimes: number[] = []
    context.capture = async ({ role, label }) => {
      checkpoints.push(events.join(""))
      checkpointTimes.push(Date.now())
      return { role, label, capturedAt: checkpoints.length, ref: `frame-${role}-${checkpoints.length}` }
    }
    const pending = decaln().term!(context)
    await vi.advanceTimersByTimeAsync(4999)
    expect(checkpoints).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(1)
    const result = await pending
    for (const row of [1, 2, 3]) expect(checkpoints[0]).toContain(`\x1b[${row};1HABABAB`)
    expect(checkpoints[0]).not.toContain("\x1b#8")
    expect(checkpoints[0]).not.toContain("CPR")
    expect(checkpoints[1]).toContain("\x1b#8")
    expect(checkpoints[1]).toMatch(/\x1b#8CPR$/)
    expect(checkpoints).toHaveLength(5)
    expect(checkpoints[1]).not.toContain("\x1b[HX")
    expect(checkpoints[2]).toBe(checkpoints[1])
    expect(checkpointTimes[2]! - checkpointTimes[1]!).toBe(5000)
    expect(checkpoints[3]).toBe(`${checkpoints[2]}\x1b[H`)
    expect(checkpoints[4]).toBe(`${checkpoints[3]}X`)
    expect(result.observation).toMatchObject({ outcome: "inconclusive", evidence: "pixels" })
    if (cursor === null) expect(result.observation?.note).toContain("processing barrier unconfirmed")
    expect(result.observation?.frames?.map(({ role }) => role)).toEqual([
      "control",
      "target",
      "target",
      "control",
      "control",
    ])
    expect(result.observation?.frames?.[2]?.label).toBe("DECALN alignment grid after delayed checkpoint")
    expect(result.observation?.frames?.[3]?.label).toBe("Cursor-only control after CUP home")
    expect(result.observation?.frames?.[4]?.label).toBe("Redraw control after one ordinary glyph")
    expect(result.observation?.screenshotRef).toBe("frame-target-2")
    expect(JSON.parse(result.response ?? "")).toMatchObject({
      rows: 3,
      cols: 6,
      seed: "ABABAB",
      postAlignmentCursor: cursor,
      target: { ref: "frame-target-2" },
      delayedCaptureMs: 5000,
      delayedTarget: { ref: "frame-target-3" },
      cursorOnlyControl: { ref: "frame-control-4" },
      redrawControl: { ref: "frame-control-5" },
    })
    expect(result.assertions).toMatchObject([{ kind: "positive", note: expect.stringContaining("capture-only") }])
    expect(result.assertions?.[0]?.expected).toContain("DECALN target shows repeated E across that same measured grid")
    expect(events.at(-1)).toContain("\x1b[2J")
  },
)

test.each([1, 2, 3, 4, 5])("DECALN cleans its disposable fixture when capture %i fails", async (failedCapture) => {
  vi.useFakeTimers()
  const events: string[] = []
  const context = app(3, 6, events)
  let calls = 0
  const failure = new Error("owned alignment capture failed")
  context.capture = async ({ role, label }) => {
    if (++calls === failedCapture) throw failure
    return { role, label, capturedAt: calls, ref: "control" }
  }
  await Promise.all([expect(decaln().term!(context)).rejects.toBe(failure), vi.runAllTimersAsync()])
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
