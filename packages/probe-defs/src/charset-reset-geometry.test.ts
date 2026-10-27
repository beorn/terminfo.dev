/**
 * @failure A fixed-position charset or reset probe writes or queries an undersized/invalid terminal and reports its legacy callback result as a valid fixture.
 * @level l1
 * @consumer App probe observations collected for terminal support cells.
 * @testonly none
 */
import { afterEach, expect, test, vi } from "vitest"
import { charsetsProbes } from "./charsets.ts"
import { resetProbes } from "./reset.ts"
import type { ObservationFrame, TermProbeSource } from "./types.ts"

afterEach(() => vi.useRealTimers())

const fixtures = [
  ["reset.sgr", 1, 2],
  ["reset.ris", 5, 5],
  ["reset.soft", 5, 5],
] as const

function app(
  rows: number,
  cols: number,
  events: string[],
  cursorResponses: ReadonlyArray<{ row: number; col: number } | null> = [{ row: 1, col: 2 }],
  decrqss: "unexpected" | "silent" = "unexpected",
): TermProbeSource {
  let cursorIndex = 0
  const unexpected = (name: string): never => {
    throw new Error(`Unexpected ${name} in charset/reset geometry fixture`)
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
      return cursorResponses[cursorIndex++] ?? null
    },
    measureRenderedWidth: async () => unexpected("measureRenderedWidth"),
    query: async () => unexpected("query"),
    // reset.soft reads DECCKM through DECRQM (#30557 r2); this fixture models a terminal that never answers it.
    queryWithSentinel: async (sequence) => {
      if (/^\x1b\[\?\d+\$p$/.test(sequence)) {
        events.push("mode")
        return null
      }
      return unexpected("queryWithSentinel")
    },
    queryOutcome: async () => unexpected("queryOutcome"),
    queryWithSentinelOutcome: async () => {
      // "silent" models a terminal that never answers DECRQSS: reset.sgr then leaves the fixture
      // untouched and keeps its capture path, which is what this file's pixel tests assert.
      if (decrqss === "silent") return { match: null, reason: "timeout", raw: "", rawBase64: "" }
      return unexpected("queryWithSentinelOutcome")
    },
    queryMode: async () => unexpected("queryMode"),
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
      expect(result, `${id} at ${rows}x${cols}`).toMatchObject({
        observation: undefined,
        tests: [expect.objectContaining({ status: "test-todo", reason: expect.any(String) })],
      })
    }
    expect(definition.termNeedsGeometry, id).toBe(true)
    if (id === "reset.ris") {
      const events: string[] = []
      const valid = await definition.term(
        app(minRows, minCols, events, [
          { row: 5, col: 5 },
          { row: 1, col: 1 },
        ]),
      )
      expect(valid.observation, id).toMatchObject({ outcome: "supported", assertionType: "query_reply" })
      expect(valid.response, id).toBe(JSON.stringify({ before: { row: 5, col: 5 }, after: { row: 1, col: 1 } }))
      expect(events).toEqual(["\x1b[5;5H", "CPR", "\x1bc", "CPR"])
    } else {
      const events: string[] = []
      // reset.sgr asks the terminal's own DECRQSS for its SGR state first; this fixture models a
      // terminal that never answers it, so the probe keeps its CPR path unchanged.
      const valid = await definition.term(app(minRows, minCols, events, [], "silent"))
      expect(valid.observation, id).toMatchObject({
        outcome: "inconclusive",
        reason: "no-response",
        assertionType: "query_reply",
      })
      expect(events.at(-1), id).toBe(id === "reset.soft" ? "mode" : "CPR")
    }
  }
})

/**
 * 28450 slice B (@cto 2026-10-12): a charset row whose run installs no owned capture adapter cannot
 * read a window back at all, and its old fallback wrote bytes whose control/target frames the region
 * oracle had already made unreachable. It now refuses BY NAME and writes nothing, so a run that
 * cannot decide stays writable instead of carrying evidence no reader ever read.
 */
test("a charset row with no owned capture refuses by name and writes nothing", async () => {
  const ids = ["charsets.dec-special", "charsets.utf8", "charsets.g0-g1-switching", "charsets.dec-line-drawing"]
  for (const id of ids) {
    const definition = charsetsProbes.find((probe) => probe.id === id)
    if (!definition?.term) throw new Error(`missing app callback for ${id}`)
    for (const [rows, cols] of [
      [1, 2],
      [24, 80],
    ] as const) {
      const events: string[] = []
      const result = await definition.term(app(rows, cols, events))
      expect(events, `${id} at ${rows}x${cols}`).toEqual([])
      expect(result.pass, id).toBe(false)
      expect(result, `${id} at ${rows}x${cols}`).toMatchObject({
        observation: undefined,
        tests: [
          expect.objectContaining({ status: "test-todo", reason: expect.stringContaining("no owned capture adapter") }),
        ],
      })
    }
  }
})

function pixelGeometry(sequence: string) {
  if (sequence === "\x1b[16t") {
    return { match: ["\x1b[6;16;8t", "16", "8"] as string[], reason: "reply" as const, raw: "", rawBase64: "" }
  }
  if (sequence === "\x1b[14t") {
    return { match: ["\x1b[4;384;640t", "384", "640"] as string[], reason: "reply" as const, raw: "", rawBase64: "" }
  }
  return { match: null, reason: "timeout" as const, raw: "", rawBase64: "" }
}

test("DEC special pixels take the 28540 region-readback verdict, not ungraded control/target frames", async () => {
  const definition = charsetsProbes.find((probe) => probe.id === "charsets.dec-special")
  if (!definition?.term) throw new Error("missing app DEC special callback")
  const events: string[] = []
  const context = app(4, 6, events)
  const requests: Array<{ region: { top: number; left: number; bottom: number; right: number }; label: string }> = []
  let reads = 0
  context.queryWithSentinelOutcome = async (sequence) => pixelGeometry(sequence)
  context.capture = async (request) => {
    reads += 1
    const region = request.cells!
    requests.push({ region, label: request.label })
    const key = `${region.top},${region.left},${region.bottom},${region.right}`
    const witnessWrite = events.filter((entry) => /^\x1b\[\d+;\d+H.$/.test(entry)).at(-1)
    const content = key === "3,1,3,1" ? (witnessWrite?.slice(-1) ?? "") : "unmoving"
    return {
      role: request.role,
      label: request.label,
      capturedAt: reads,
      ref: `sha256:${String(reads).repeat(64)}`,
      regionDigest: `sha256:${key}|${content}`,
      pixelsDigest: `sha256:frame|${content}`,
    }
  }
  const result = await definition.term(context)
  expect(String(result.observation?.note)).toContain("seed frame and the expected frame read the same cells")
  const compared = requests.filter(({ region }) => region.right !== region.left || region.bottom !== region.top)
  expect(compared.map(({ region }) => region)).toEqual([
    { top: 1, left: 1, bottom: 1, right: 3 },
    { top: 1, left: 1, bottom: 1, right: 3 },
    { top: 1, left: 1, bottom: 1, right: 3 },
    { top: 1, left: 1, bottom: 1, right: 3 },
    { top: 1, left: 1, bottom: 1, right: 3 },
  ])
  expect(compared.map(({ label }) => label)).toEqual([
    "charsets.dec-special: capture stability 1",
    "charsets.dec-special: capture stability 2",
    "charsets.dec-special: pre-edit seed",
    "charsets.dec-special: post-sequence target",
    "charsets.dec-special: expected frame",
  ])
  expect(events.at(-1)).toBe("\x1b[0m\x1b[2J\x1b[H")
})

test("DEC special capture requires safe measured 3x5 before writes or captures", async () => {
  const definition = charsetsProbes.find((probe) => probe.id === "charsets.dec-special")
  if (!definition?.term) throw new Error("missing app DEC special callback")
  for (const [rows, cols] of [
    [2, 5],
    [3, 4],
    [NaN, 5],
    [3, Infinity],
    [2.5, 5],
    [3, 4.5],
    [Number.MAX_SAFE_INTEGER + 1, 5],
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
    expect(result).toMatchObject({
      observation: undefined,
      tests: [expect.objectContaining({ status: "test-todo", reason: expect.any(String) })],
    })
    expect(result.observation?.note).toContain(`3x5`)
    expect(result.observation?.note).toContain(`measured ${rows}x${cols}`)
  }
})

test("DEC special capture names a silent CSI 16 t as query, not ungraded pixels", async () => {
  const definition = charsetsProbes.find((probe) => probe.id === "charsets.dec-special")
  if (!definition?.term) throw new Error("missing app DEC special callback")
  const events: string[] = []
  const context = app(4, 6, events)
  context.queryWithSentinelOutcome = async () => ({ match: null, reason: "timeout", raw: "", rawBase64: "" })
  context.capture = async ({ role, label }) => ({ role, label, capturedAt: 1, ref: `sha256:${"c".repeat(64)}` })
  const result = await definition.term(context)
  expect(result.observation).toMatchObject({
    outcome: "inconclusive",
    reason: "insufficient-evidence",
    assertionType: "query_reply",
  })
  expect(String(result.observation?.note)).toContain("CSI 16 t")
  expect(result.observation?.frames ?? []).toHaveLength(0)
})

test.each([1, 2])("DEC special restores DECTCEM when capture %i rejects", async (failedCapture) => {
  const definition = charsetsProbes.find((probe) => probe.id === "charsets.dec-special")
  if (!definition?.term) throw new Error("missing app DEC special callback")
  const events: string[] = []
  const context = app(4, 6, events)
  context.queryWithSentinelOutcome = async (sequence) => pixelGeometry(sequence)
  const failure = new Error("owned charset capture failed")
  let calls = 0
  context.capture = async ({ role, label }) => {
    if (++calls === failedCapture) throw failure
    return {
      role,
      label,
      capturedAt: calls,
      ref: "control",
      regionDigest: `sha256:${calls}`,
      pixelsDigest: `sha256:frame${calls}`,
    }
  }
  await expect(definition.term(context)).rejects.toBe(failure)
  expect(calls).toBe(failedCapture)
  expect(events.at(-2)).toBe("\x1b[?25h")
  expect(events.at(-1)).toBe("\x1b[0m\x1b[2J\x1b[H")
})

function decaln() {
  const definition = resetProbes.find((probe) => probe.id === "reset.decaln")
  if (!definition?.term) throw new Error("missing app DECALN callback")
  return definition
}

test("reset.sgr capture declines by name after a silent DECRQSS instead of grading pixels", async () => {
  const definition = resetProbes.find((probe) => probe.id === "reset.sgr")
  if (!definition?.term) throw new Error("missing app reset.sgr callback")
  const events: string[] = []
  const context = app(3, 34, events, [{ row: 1, col: 2 }], "silent")
  const capture = vi.fn(async ({ role, label }: { role: ObservationFrame["role"]; label: string }) => ({
    role,
    label,
    capturedAt: 1,
    ref: "never",
  }))
  context.capture = capture
  const result = await definition.term(context)
  // A row whose reset clears two or more attributes has no reference
  // independent of a full reset, so the region oracle declines it before any pixel read. The shared
  // DECRQSS readback ran first and this fixture answered nothing, so the trace is NOT empty and the
  // evidence is truthful "query" — never the zero-byte "none" shape run-parser reserves.
  expect(capture).not.toHaveBeenCalled()
  expect(events).toContain("\x1b[0m")
  expect(events.some((event) => event.includes("\x1b[1;3;7mX"))).toBe(false)
  expect(result.pass).toBe(false)
  expect(result.observation).toMatchObject({
    outcome: "inconclusive",
    reason: "insufficient-evidence",
    assertionType: "query_reply",
    note: expect.stringContaining("no independent reference exists for a multi-attribute reset"),
  })
})

test("reset.sgr capture refuses an undersized terminal before any bytes or frames", async () => {
  const definition = resetProbes.find((probe) => probe.id === "reset.sgr")
  if (!definition?.term) throw new Error("missing app reset.sgr callback")
  for (const [rows, cols] of [
    [2, 33],
    [3, 33],
    [2, 34],
    [NaN, 34],
  ] as const) {
    const events: string[] = []
    const context = app(rows, cols, events)
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
    expect(result, `${rows}x${cols}`).toMatchObject({
      observation: undefined,
      tests: [expect.objectContaining({ status: "test-todo", reason: expect.any(String) })],
    })
    expect(result.observation?.note, `${rows}x${cols}`).toContain("3x34")
  }
})

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
    expect(result.observation).toMatchObject({ outcome: "inconclusive", assertionType: "screenshot" })
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
    expect(await decaln().term!(context)).toMatchObject({
      observation: undefined,
      tests: [expect.objectContaining({ status: "test-todo", reason: expect.any(String) })],
    })
    expect(events).toEqual([])
  }
  expect(decaln().termNeedsGeometry).toBe(true)
  const events: string[] = []
  expect((await decaln().term!(app(3, 6, events))).observation?.assertionType).toBe("none")
  expect(events).toEqual([])
})

test("charsets.utf8 asks the terminal's pixel report before painting its two-cell glyph fixture", async () => {
  const definition = charsetsProbes.find((probe) => probe.id === "charsets.utf8")
  if (!definition?.term) throw new Error("missing app charsets.utf8 callback")
  const events: string[] = []
  // "silent" models a terminal that answers no query: with no CSI 16 t reply the region verdict
  // cannot map cells onto the owned window, so it refuses BY NAME and never paints the A??Z fixture.
  const context = app(4, 7, events, [{ row: 1, col: 2 }], "silent")
  const frames: ObservationFrame[] = []
  context.capture = async ({ role, label }) => {
    const frame = { role, label, capturedAt: frames.length + 1, ref: `sha256:${String(frames.length + 1).repeat(64)}` }
    frames.push(frame)
    return frame
  }
  const result = await definition.term(context)
  expect(result.observation).toMatchObject({
    outcome: "inconclusive",
    reason: "insufficient-evidence",
    assertionType: "query_reply",
  })
  expect(String(result.observation?.note)).toContain("CSI 16 t")
  expect(frames).toEqual([])
  expect(events).toEqual([])
})

// 28752: every charset row whose expected frame is written PLAINLY declares the context it assumes,
// so an 8-bit run is inconclusive BY NAME rather than compared against glyphs the terminal cannot
// paint. This is the wiring proof: each of the four rows reaches the measured fact and reads no
// pixels at all.
test("every plain-written charset row names an 8-bit decoding context before it captures", async () => {
  for (const id of ["charsets.dec-special", "charsets.utf8", "charsets.g0-g1-switching", "charsets.dec-line-drawing"]) {
    const definition = charsetsProbes.find((probe) => probe.id === id)
    if (!definition?.term) throw new Error(`missing app callback for ${id}`)
    const events: string[] = []
    // Twelve columns, not eight: under the region-readback KIND the row's need DERIVES from the
    // grid it addresses (dec-line-drawing compares seven columns, plus the kind's two-column
    // margin), so a fixture narrower than the row addresses is refused by geometry before the
    // decode context is ever read — and this row's subject is the decode context.
    const context = app(4, 12, events)
    context.utf8Decoding = async () => "8-bit"
    context.queryWithSentinelOutcome = async (sequence) =>
      sequence === "\x1b[16t"
        ? { match: ["\x1b[6;16;8t", "16", "8"], reason: "reply" as const, raw: "\x1b[6;16;8t", rawBase64: "" }
        : { match: ["\x1b[4;320;128t", "320", "128"], reason: "reply" as const, raw: "\x1b[4;320;128t", rawBase64: "" }
    let captured = false
    context.capture = async () => {
      captured = true
      throw new Error("an 8-bit decoding context must not capture pixels")
    }
    const result = await definition.term(context)
    expect(result.observation, id).toMatchObject({
      outcome: "inconclusive",
      reason: "insufficient-evidence",
      assertionType: "query_reply",
    })
    expect(String(result.observation?.note), id).toContain("decodes plain-written UTF-8 as ISO-8859-1")
    expect(captured, id).toBe(false)
    expect(events, id).toEqual([])
  }
})
