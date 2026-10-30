/**
 * @failure Four DEC mode app probes mutate terminal state or treat CPR responsiveness as mode recognition.
 * @level l1
 * @consumer Owned app mode observations and reviewed support cells.
 * @testonly none
 */
import { expect, test, vi } from "vitest"
import { modesProbes } from "./modes.ts"
import type {
  CaptureRectangle,
  CaptureRequest,
  ObservationFrame,
  ProbeCallbackResult,
  TermProbeSource,
  LibProbeSource,
} from "./types.ts"

function captureSource(
  rows: number,
  cols: number,
  writes: string[],
  frames: ObservationFrame[],
  fresh = true,
  kind: "pixels" | "text-cells" = "pixels",
  restoresPrimary = true,
): TermProbeSource {
  const source: TermProbeSource = {
    kind: "live",
    rows,
    cols,
    write: (bytes: string) => writes.push(bytes),
    queryCursorPosition: async () => ({ row: 1, col: 1 }),
    measureRenderedWidth: async () => ({ kind: "no-reply", step: "sample" }) as const,
    query: async () => null,
    queryWithSentinel: async () => null,
    queryOutcome: async () => ({ match: null, reason: "timeout", raw: "", rawBase64: "" }),
    queryWithSentinelOutcome: async () => ({ match: null, reason: "timeout", raw: "", rawBase64: "" }),
    queryMode: async () => null,
    captureGeometry: {
      geometry: { cellWidth: 10, cellHeight: 20, textWidth: cols * 10, textHeight: rows * 20 },
      source: "measured by complete raster calibration",
    },
    capture: async ({ role, label, cells, pixelGeometry }) => {
      // Constructed pixel-equivalence planes exercise callback wiring, not font or terminal support.
      // Witness values come from the glyph actually written outside each deciding crop.
      const witness = fresh ? (writes.filter((entry) => /^\x1b\[\d+;\d+H.$/.test(entry)).at(-1) ?? "blank") : "stale"
      const palette = label.includes("colors")
      const sgr = /xt(push|pop)sgr/.test(label)
      const restoration = /alt-screen\.exit|altscreen-47|altscreen-1047/.test(label)
      let plane = "stable"
      if (/paint witness|— baseline/.test(label)) plane = witness
      else if (label.includes("post-sequence target") || label.endsWith("expected frame")) {
        plane =
          restoration && !restoresPrimary && label.includes("post-sequence target")
            ? "seed"
            : palette
              ? "blue"
              : "expected"
      } else if (label.endsWith("setup reference frame")) plane = "blue"
      else if (label.endsWith("ignored-attribute frame")) plane = palette ? "green" : sgr ? "italic" : "seed"
      else if (label.endsWith("pre-edit seed")) {
        plane = palette
          ? "blue"
          : restoration && label.includes("altscreen-47")
            ? "expected"
            : sgr && writes.some((entry) => entry.includes("\x1b[1;3m"))
              ? "bold-italic"
              : "seed"
      }
      const frame = {
        role,
        label,
        capturedAt: frames.length + 1,
        ref: `sha256:${(frames.length + 1).toString(16).padStart(64, "0")}`,
        ...(cells &&
          pixelGeometry && {
            kind: "pixels" as const,
            regionDigest: plane,
            pixelsDigest: `whole:${plane}`,
            regionRectangle: {
              x: (cells.left - 1) * pixelGeometry.cellWidth,
              y: (cells.top - 1) * pixelGeometry.cellHeight,
              width: (cells.right - cells.left + 1) * pixelGeometry.cellWidth,
              height: (cells.bottom - cells.top + 1) * pixelGeometry.cellHeight,
            },
          }),
      }
      frames.push(frame)
      return frame
    },
  }
  if (kind === "text-cells") {
    const capture = source.capture!
    source.cells = async (request) => {
      const frame = await capture({
        ...request,
        pixelGeometry: { cellWidth: 10, cellHeight: 20, textWidth: cols * 10, textHeight: rows * 20 },
      })
      if (!request.cells || !frame.regionDigest || !frame.pixelsDigest) throw new Error("Missing fixture cell read")
      return {
        kind: "text-cells",
        role: frame.role,
        label: frame.label,
        capturedAt: frame.capturedAt,
        ref: frame.ref,
        cellDigest: frame.regionDigest,
        frameDigest: frame.pixelsDigest,
        cellRectangle: request.cells,
      }
    }
    source.capture = undefined
    source.captureGeometry = undefined
    source.captureKind = "text-cells"
  }
  return source
}

const modes = [
  { id: "modes.utf8-mouse-1005", number: 1005 },
  { id: "modes.deccolm", number: 3 },
  { id: "modes.decsclm", number: 4 },
] as const

function headlessDeccolm(): (ctx: LibProbeSource) => ProbeCallbackResult {
  const definition = modesProbes.find((entry) => entry.id === "modes.deccolm")
  if (!definition?.lib) throw new Error("Missing headless DECCOLM callback")
  return definition.lib
}

/**
 * A four-state cell model. Width moves only when ?40 is open, unless `honoursModeWithoutGate`
 * says the engine ignores the gate; `ignoresMode` is an engine that accepts the mode and does not
 * move; `replyWidth` makes a silent `18 t` answer with a width of its own, and `replies` scripts each
 * `18 t` answer in call order. `stickyGate` ignores ?40l once ?40 was opened; `wideWidth` is the
 * width ?3h sets.
 */
function cellWidthContext(options: {
  width: 80 | 132
  wrap?: boolean
  ignoresMode?: boolean
  honoursModeWithoutGate?: boolean
  decrpm?: string
  replyWidth?: number
  answers18t?: boolean
  replies?: Array<number | null>
  stickyGate?: boolean
  wideWidth?: number
}) {
  const state = { width: options.width as number, gate: false, cursor: { x: 0, y: 0 }, writes: [] as string[] }
  let replyCall = 0
  const context = {
    cols: options.width,
    getCursor: () => ({ ...state.cursor, visible: true, style: null }),
    feed(text: string) {
      state.writes.push(text)
      for (const match of text.matchAll(/\x1b\[\?(\d+)([hl])/g)) {
        const on = match[2] === "h"
        if (match[1] === "40") state.gate = on || (options.stickyGate === true && state.gate)
        if (match[1] === "3" && !options.ignoresMode && (state.gate || options.honoursModeWithoutGate)) {
          state.width = on ? (options.wideWidth ?? 132) : 80
        }
      }
      if (text.includes("\x1b[2J")) state.cursor = { x: 0, y: 0 }
      for (const _char of text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")) {
        if (state.cursor.x >= state.width - 1) {
          if (options.wrap ?? true) state.cursor = { x: 0, y: state.cursor.y + 1 }
          else state.cursor.x = state.width - 1
        } else {
          state.cursor.x += 1
        }
      }
    },
    feedCapture(sequence: string) {
      state.writes.push(sequence)
      if (sequence !== "\x1b[18t") return options.decrpm ?? ""
      if (options.replies) {
        const width = options.replies[replyCall++]
        return width === null || width === undefined ? "" : `\x1b[8;24;${width}t`
      }
      if (options.answers18t) return `\x1b[8;24;${state.width}t`
      return options.replyWidth === undefined ? "" : `\x1b[8;24;${options.replyWidth}t`
    },
  } as unknown as LibProbeSource
  return { context, state }
}

test("DECCOLM cell width moves 80 -> 132 -> 80 with ?40 honoured", () => {
  const { context, state } = cellWidthContext({ width: 80 })
  const result = headlessDeccolm()(context)
  expect(result.observation).toMatchObject({ outcome: "supported", assertionType: "buffer_state" })
  expect(result.assertions).toEqual(
    expect.arrayContaining([expect.objectContaining({ assertionType: "buffer_state", kind: "positive" })]),
  )
  const wire = state.writes.join("")
  // The enabling change follows ?40h; the first ?3h is gate control A, sent with ?40 closed.
  expect(wire).toContain("\x1b[?40h\x1b[?3h")
  expect(state.width).toBe(80)
})

// Successful cleanup cannot catch a throw after a mode set, especially the final closed-gate sweep.
test.each([
  { width: 80, failure: "gateAfter" },
  { width: 132, failure: "gateAfter" },
  { width: 80, failure: "enabled18t" },
  { width: 132, failure: "enabled18t" },
] as const)("DECCOLM restores initial $width after $failure throws", ({ width, failure }) => {
  const { context, state } = cellWidthContext({ width })
  let reads = 0
  const cursor = context.getCursor.bind(context)
  const capture = context.feedCapture.bind(context)
  context.getCursor = () => {
    if (failure === "gateAfter" && ++reads === 5) throw new Error("width readback failed")
    return cursor()
  }
  context.feedCapture = (query) => {
    if (failure === "enabled18t" && query === "\x1b[18t" && ++reads === 2) throw new Error("width readback failed")
    return capture(query)
  }
  expect(() => headlessDeccolm()(context)).toThrow("width readback failed")
  expect(state.width).toBe(width)
  expect(state.gate).toBe(true)
  expect(state.writes.at(-1)).toBe(`${width === 132 ? "\x1b[?3h" : "\x1b[?3l"}\x1b[?40h`)
})

// cee6d003: re-seed before every sweep, and only the 133rd X proves W=132.
test("DECCOLM re-seeds before each of its five 133-X sweeps and runs gate control A before ?40 opens", () => {
  const { context, state } = cellWidthContext({ width: 80 })
  const result = headlessDeccolm()(context)
  expect(result.observation).toMatchObject({ outcome: "supported" })
  const sweeps = state.writes.flatMap((write, index) => (/^X+$/.test(write) ? [index] : []))
  expect(sweeps).toHaveLength(5)
  for (const index of sweeps) {
    expect(state.writes[index]).toBe("X".repeat(133))
    expect(state.writes[index - 1]).toContain("\x1b[2J\x1b[H")
  }
  const wire = state.writes.join("")
  const closed = wire.indexOf("\x1b[?40l")
  const firstChange = wire.indexOf("\x1b[?3h")
  const opened = wire.indexOf("\x1b[?40h")
  expect(closed).toBeLessThan(firstChange)
  expect(firstChange).toBeLessThan(opened)
  expect(wire.slice(firstChange, opened)).toContain("X".repeat(133))
  expect(result.assertions).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        kind: "positive",
        expected: expect.stringContaining("before and after the transition"),
        observed: result.response,
      }),
    ]),
  )
})

test("DECCOLM names a no-wrap reading after the change as the 133rd X not wrapping, never 132", () => {
  const { context } = cellWidthContext({ width: 80, wideWidth: 140 })
  const result = headlessDeccolm()(context)
  expect(result.observation).toMatchObject({ outcome: "inconclusive", note: "133rd X did not wrap" })
  expect(result.tests).toMatchObject([
    expect.objectContaining({ status: "test-failure", reason: expect.stringContaining('"x":133,"y":0') }),
  ])
})

test("DECCOLM cell width moves 132 -> 80 -> 132 with ?40 honoured", () => {
  const { context, state } = cellWidthContext({ width: 132 })
  const result = headlessDeccolm()(context)
  expect(result.observation).toMatchObject({ outcome: "supported", assertionType: "buffer_state" })
  expect(state.width).toBe(132)
})

test("DECCOLM grades a no-change by an engine that accepted the mode as unsupported", () => {
  const { context } = cellWidthContext({ width: 80, ignoresMode: true, decrpm: "\x1b[?3;2$y" })
  const result = headlessDeccolm()(context)
  expect(result.observation).toMatchObject({ outcome: "unsupported", assertionType: "buffer_state" })
  expect(result.tests).toBeUndefined()
})

test.each([0, 4] as const)("DECCOLM grades unchanged measured width unsupported at DECRPM Ps %i", (ps) => {
  const { context } = cellWidthContext({ width: 80, ignoresMode: true, decrpm: `\x1b[?3;${ps}$y` })
  const result = headlessDeccolm()(context)
  expect(result.observation).toMatchObject({
    outcome: "unsupported",
    assertionType: "buffer_state",
    note: expect.stringContaining(
      `DECRPM mode 3 reads ${ps === 0 ? "not recognized" : "permanently reset"} (Ps ${ps})`,
    ),
  })
  expect(result.tests).toBeUndefined()
  expect(result.assertions).toMatchObject([
    expect.objectContaining({
      kind: "negative",
      expected: expect.stringContaining("with ?40 honoured"),
      observed: result.response,
    }),
  ])
})

test("DECCOLM grades a measured move supported and names a refusing DECRPM reading beside it", () => {
  const { context } = cellWidthContext({ width: 80, decrpm: "\x1b[?3;0$y" })
  const result = headlessDeccolm()(context)
  expect(result.observation).toMatchObject({
    outcome: "supported",
    note: expect.stringContaining("DECRPM mode 3 reads not recognized (Ps 0) while the sweep measured 80 -> 132 -> 80"),
  })
})

test("DECCOLM names autowrap off rather than claiming a width", () => {
  const { context } = cellWidthContext({ width: 80, wrap: false })
  const result = headlessDeccolm()(context)
  expect(result.observation).toMatchObject({ outcome: "inconclusive", note: "autowrap off" })
  expect(result.tests).toMatchObject([
    expect.objectContaining({ status: "test-failure", reason: expect.stringContaining("autowrap off") }),
  ])
})

test("DECCOLM refuses an initial width outside 80/132 instead of rounding it", () => {
  const { context } = cellWidthContext({ width: 100 as 80, ignoresMode: true })
  const result = headlessDeccolm()(context)
  expect(result.observation).toMatchObject({ outcome: "inconclusive", note: "initial width outside 80/132" })
  expect(result.tests).toMatchObject([
    expect.objectContaining({
      status: "test-failure",
      reason: expect.stringContaining('initial width outside 80/132: {"kind":"unmeasured"'),
    }),
  ])
})

test.each([
  ["before the transition", { honoursModeWithoutGate: true }, "gateBefore"],
  ["after the transition", { stickyGate: true }, "gateAfter"],
] as const)(
  "DECCOLM records a mode that moves the width with ?40 closed %s as the gate not holding",
  (_when, gate, phase) => {
    const { context } = cellWidthContext({ width: 80, ...gate })
    const result = headlessDeccolm()(context)
    expect(result.observation).toMatchObject({ outcome: "inconclusive", note: "gate not honoured" })
    expect(result.assertions).toEqual([
      expect.objectContaining({ assertionType: "buffer_state", kind: "negative", observed: result.response }),
    ])
    expect(JSON.parse(result.response!)[phase]).toMatchObject({ width: 132 })
    expect(result.tests).toMatchObject([
      expect.objectContaining({ status: "test-failure", reason: expect.stringContaining(`"${phase}"`) }),
    ])
  },
)

test("DECCOLM treats an answering 18t that disagrees with the sweep as a failure", () => {
  const { context } = cellWidthContext({ width: 80, ignoresMode: true, replyWidth: 100 })
  const result = headlessDeccolm()(context)
  expect(result.observation).toBeUndefined()
  expect(result.tests).toMatchObject([
    expect.objectContaining({ status: "test-failure", reason: "18t/sweep disagreement W=80 vs 100 (initial)" }),
  ])
})

test("DECCOLM compares the restored 18t with the restored sweep too", () => {
  const { context } = cellWidthContext({ width: 80, replies: [80, 132, 132] })
  const result = headlessDeccolm()(context)
  expect(result.observation).toBeUndefined()
  expect(result.tests).toMatchObject([
    expect.objectContaining({ status: "test-failure", reason: "18t/sweep disagreement W=80 vs 132 (restored)" }),
  ])
})

test("DECCOLM lets an answering 18t that agrees corroborate the sweep", () => {
  const { context } = cellWidthContext({ width: 80, answers18t: true })
  const result = headlessDeccolm()(context)
  expect(result.observation).toMatchObject({ outcome: "supported" })
})

test("DECCOLM keeps an adapter with no cell-width readback as a test todo", () => {
  const context = { cols: 80, feed() {}, feedCapture: () => "" } as unknown as LibProbeSource
  const result = headlessDeccolm()(context)
  expect(result.notTested).toMatchObject({ noObservable: "no cell-width readback" })
  expect(result.tests).toMatchObject([
    expect.objectContaining({ status: "test-todo", reason: expect.stringContaining("no cell-width readback") }),
  ])
})

test.each(["bad-start", "ignored-move", "ignored-restore", "restored"] as const)(
  "1048 qualifies cursor setup before grading %s",
  (scenario) => {
    const definition = modesProbes.find((item) => item.id === "modes.altscreen-1048")
    if (!definition?.lib) throw new Error("Missing headless cursor-save callback")
    const writes: string[] = []
    let cursor = { x: 0, y: 0 }
    const context = {
      cols: 20,
      getScrollback: () => ({ viewportOffset: 0, totalLines: 15, screenLines: 15 }),
      feed(sequence: string) {
        writes.push(sequence)
        if (sequence === "\x1b[5;10H" && scenario !== "bad-start") cursor = { x: 9, y: 4 }
        if (sequence === "\x1b[15;20H" && scenario !== "ignored-move") cursor = { x: 19, y: 14 }
        if (sequence === "\x1b[?1048l" && scenario === "restored") cursor = { x: 9, y: 4 }
      },
      getCursor: () => ({ ...cursor, visible: true, style: null }),
    } as unknown as LibProbeSource
    const result = definition.lib(context)
    const outcome =
      scenario === "restored" ? "supported" : scenario === "ignored-restore" ? "unsupported" : "inconclusive"
    expect(result.observation, scenario).toMatchObject({ outcome, assertionType: "buffer_state" })
    if (outcome === "inconclusive") expect(result.assertions, scenario).toBeUndefined()
    else {
      expect(result.assertions, scenario).toMatchObject([{ kind: outcome === "supported" ? "positive" : "negative" }])
      expect(JSON.parse(result.response!), scenario).toMatchObject({
        before: { x: 9, y: 4 },
        displaced: { x: 19, y: 14 },
      })
    }
    if (scenario === "bad-start") expect(writes).toEqual(["\x1b[5;10H"])
    else expect(writes.at(-1)).toBe("\x1b[?1048l")
  },
)

test("1048 refuses undersized geometry and restores after failed displacement readback", () => {
  const definition = modesProbes.find((item) => item.id === "modes.altscreen-1048")
  if (!definition?.lib) throw new Error("Missing headless cursor-save callback")
  const writes: string[] = []
  let rows = 14
  const context = {
    cols: 20,
    getScrollback: () => ({ viewportOffset: 0, totalLines: rows, screenLines: rows }),
    feed: (sequence: string) => writes.push(sequence),
    getCursor: () => {
      if (writes.includes("\x1b[15;20H")) throw new Error("readback failed")
      return { x: 9, y: 4, visible: true, style: null }
    },
  } as unknown as LibProbeSource
  expect(definition.lib(context).observation).toMatchObject({ outcome: "inconclusive" })
  expect(writes).toEqual([])
  rows = 15
  expect(() => definition.lib!(context)).toThrow("readback failed")
  expect(writes.at(-1)).toBe("\x1b[?1048l")
})

test("IRM grades measured insertion despite false mode metadata and distinguishes replacement from bad setup", () => {
  const definition = modesProbes.find((item) => item.id === "modes.insert-replace")
  if (!definition?.lib) throw new Error("Missing headless IRM callback")
  for (const [target, outcome] of [
    ["XABC", "supported"],
    ["XBC ", "unsupported"],
    ["XAB ", "inconclusive"],
  ] as const) {
    const feeds: string[] = []
    let phase = "empty"
    const context = {
      cols: 4,
      getScrollback: () => ({ viewportOffset: 0, totalLines: 1, screenLines: 1 }),
      getMode: () => false,
      getCursor: () => ({ x: phase === "seed" ? 3 : 0, y: 0, visible: true, style: null }),
      feed: (sequence: string) => {
        feeds.push(sequence)
        if (sequence.includes("ABC")) phase = "seed"
        else if (sequence === "\x1b[1;1H") phase = "origin"
        else if (sequence === "X") phase = "target"
      },
      getCell: (_row: number, col: number) => ({ char: (phase === "target" ? target : "ABC ")[col] ?? "" }),
    } as unknown as LibProbeSource
    const result = definition.lib(context)
    expect(result.observation, target).toMatchObject({ outcome, assertionType: "buffer_state" })
    expect(feeds.at(-1), target).toBe("\x1b[4l")
    if (outcome === "inconclusive") expect(result.assertions, target).toBeUndefined()
    else expect(result.assertions, target).toMatchObject([{ kind: outcome === "supported" ? "positive" : "negative" }])
  }
})

test("IRM does not grade output when the seed was not measured", () => {
  const definition = modesProbes.find((item) => item.id === "modes.insert-replace")
  if (!definition?.lib) throw new Error("Missing headless IRM callback")
  const feeds: string[] = []
  const context = {
    cols: 4,
    getScrollback: () => ({ viewportOffset: 0, totalLines: 1, screenLines: 1 }),
    getCursor: () => ({ x: 0, y: 0, visible: true, style: null }),
    feed: (sequence: string) => feeds.push(sequence),
    getCell: () => ({ char: " " }),
  } as unknown as LibProbeSource
  const result = definition.lib(context)
  expect(result.observation).toMatchObject({ outcome: "inconclusive", reason: "insufficient-evidence" })
  expect(result.assertions).toBeUndefined()
  expect(feeds).not.toContain("\x1b[4h")
  expect(feeds).not.toContain("X")
})

test("unmeasured app modes leave prior state untouched instead of toggling it for CPR", async () => {
  for (const id of ["modes.left-right-margin", "modes.altscreen-47", "modes.altscreen-1047"]) {
    const definition = modesProbes.find((item) => item.id === id)
    if (!definition?.term) throw new Error(`Missing ${id} app callback`)
    if (id === "modes.altscreen-1047") expect(definition.termAssertionType).toBe("query_reply")
    for (const ps of [null, 0, 1, 2, 3, 4] as const) {
      const queried: string[] = []
      const unexpected = (): never => {
        throw new Error(`${id}: no state write or CPR is a feature measurement`)
      }
      const context = {
        write: unexpected,
        queryCursorPosition: unexpected,
        queryMode: unexpected,
        queryWithSentinel: async (sequence: string, pattern: RegExp) => {
          queried.push(sequence)
          return ps === null ? null : pattern.exec(`\x1b[?1047;${ps}$y`)
        },
      } as unknown as TermProbeSource
      const result = await definition.term(context)
      // The app arms without a behavior oracle are execution-only TODOs. The 1047 DECRPM
      // fallback still grades its retained protocol reply.
      const permanent = id === "modes.altscreen-1047" && ps === 4
      if (id !== "modes.altscreen-1047") {
        expect(result.observation, `${id}:${ps}`).toBeUndefined()
        expect(result.assertions, `${id}:${ps}`).toBeUndefined()
        expect(result.tests, `${id}:${ps}`).toMatchObject([
          expect.objectContaining({ status: "test-todo", reason: expect.any(String) }),
        ])
      } else if (ps === null) {
        expect(result.observation, `${id}:${ps}`).toBeUndefined()
        expect(result.tests, `${id}:${ps}`).toMatchObject([
          expect.objectContaining({ status: "test-failure", reason: expect.stringContaining("DECRPM") }),
        ])
      } else if (ps === 0) {
        expect(result.observation, `${id}:${ps}`).toMatchObject({
          outcome: "inconclusive",
          reason: "insufficient-evidence",
          assertionType: "query_reply",
        })
        expect(result.assertions ?? [], `${id}:${ps}`).toEqual([])
      } else if (permanent) {
        expect(result.observation).toMatchObject({ outcome: "unsupported", assertionType: "query_reply" })
        expect(result.response).toBe("permanently reset (Ps 4)")
        expect(result.assertions, id).toMatchObject([{ kind: "negative", observed: "permanently reset (Ps 4)" }])
      } else {
        expect(result.assertions ?? [], id).toEqual([])
      }
      expect(queried, id).toEqual(id === "modes.altscreen-1047" ? ["\x1b[?1047$p"] : [])
    }
  }
})

test("app cursor replies and mode recognition do not prove alternate-buffer behavior", async () => {
  for (const id of ["modes.alt-screen.exit", "modes.insert-replace", "modes.altscreen-1047"]) {
    const definition = modesProbes.find((entry) => entry.id === id)
    if (!definition?.term) throw new Error(`Missing ${id} app callback`)
    const context: TermProbeSource = {
      kind: "live",
      cols: 80,
      rows: 24,
      write() {},
      queryCursorPosition: async () => ({ row: 3, col: 3 }),
      measureRenderedWidth: async () => ({ kind: "no-reply", step: "sample" }) as const,
      query: async () => null,
      // Private DECRQM answers "set" (Ps 1); the ANSI IRM query stays unanswered, so IRM keeps its cell fixture.
      queryWithSentinel: async (sequence, pattern) => {
        const mode = /^\x1b\[\?(\d+)\$p$/.exec(sequence)?.[1]
        return mode === undefined ? null : pattern.exec(`\x1b[?${mode};1$y`)
      },
      queryOutcome: async () => ({ match: null, reason: "timeout", raw: "", rawBase64: "" }),
      queryWithSentinelOutcome: async () => ({ match: null, reason: "timeout", raw: "", rawBase64: "" }),
      queryMode: async () => "set",
    }
    const result = await definition.term(context)
    expect(result.observation, id).toMatchObject({
      outcome: "inconclusive",
      reason: "insufficient-evidence",
      assertionType: "query_reply",
    })
    expect(result.assertions ?? [], id).toEqual([])
  }
})

test.each(modes)("$id uses one DECRPM query without changing the terminal", async ({ id, number }) => {
  const definition = modesProbes.find((probe) => probe.id === id)
  if (!definition?.term) throw new Error(`Missing app callback for ${id}`)

  // The app arm reads the DECRPM reply itself (queryWithSentinel plus the shared parser), never the folded
  // queryMode word, so Ps 4 cannot hide behind "reset" (#30557).
  for (const ps of [0, null, 1, 2, 3, 4] as const) {
    const queried: string[] = []
    const unexpected = (operation: string): never => {
      throw new Error(`${id}: unexpected ${operation} for Ps ${ps}`)
    }
    const context: TermProbeSource = {
      kind: "live",
      cols: 80,
      rows: 24,
      write: () => unexpected("write"),
      queryCursorPosition: async () => unexpected("CPR"),
      measureRenderedWidth: async () => unexpected("width query"),
      query: async () => unexpected("raw query"),
      queryWithSentinel: async (sequence, pattern) => {
        queried.push(sequence)
        return ps === null ? null : pattern.exec(`\x1b[?${number};${ps}$y`)
      },
      queryOutcome: async () => unexpected("query outcome"),
      queryWithSentinelOutcome: async () => unexpected("sentinel outcome"),
      queryMode: async () => unexpected("folded mode query"),
    }

    const result = await definition.term(context)
    expect(queried, `${id}: Ps ${ps}`).toEqual([`\x1b[?${number}$p`])
    if (ps === null) {
      expect(result.pass).toBe(false)
      expect(result.observation).toBeUndefined()
      expect(result.assertions).toBeUndefined()
      expect(result.tests).toMatchObject([
        expect.objectContaining({ status: "test-failure", reason: expect.stringContaining("DECRPM") }),
      ])
    } else if (ps === 0) {
      expect(result.pass).toBe(false)
      expect(result.response).toBe("not recognized (Ps 0)")
      expect(result.observation).toMatchObject({
        outcome: "inconclusive",
        reason: "insufficient-evidence",
        assertionType: "query_reply",
      })
      expect(result.observation?.note, `${id}: note must survive projection`).toMatch(/not recognized/)
      expect(result.assertions ?? []).toEqual([])
    } else if (ps === 4) {
      expect(result.pass).toBe(false)
      expect(result.response).toBe("permanently reset (Ps 4)")
      expect(result.observation).toMatchObject({ outcome: "unsupported", assertionType: "query_reply" })
      expect(result.observation?.note, `${id}: note must survive projection`).toMatch(/permanently reset \(Ps 4\)/)
      expect(result.assertions).toMatchObject([
        { kind: "negative", expected: `DECRPM mode ${number} can be set`, observed: "permanently reset (Ps 4)" },
      ])
    } else {
      const reading = ps === 1 ? "set (Ps 1)" : ps === 2 ? "reset (Ps 2)" : "permanently set (Ps 3)"
      expect(result.pass).toBe(true)
      expect(result.response).toBe(reading)
      expect(result.observation).toMatchObject({ outcome: "supported", assertionType: "query_reply" })
      expect(result.assertions).toMatchObject([{ kind: "positive", observed: reading }])
    }
  }
  expect(definition.termWrites).toBe("query")
  expect(definition.termAssertionType).toBe("query_reply")
})

test("DECAWM with null metadata rejects an ignored wrap", () => {
  const probe = modesProbes.find((item) => item.id === "modes.auto-wrap")
  if (!probe?.lib) throw new Error("missing auto-wrap callback")
  const writes: string[] = []
  const context = {
    cols: 4,
    getScrollback: () => ({ viewportOffset: 0, totalLines: 2, screenLines: 2 }),
    feed: (sequence: string) => writes.push(sequence),
    getMode: () => null,
    getCell: (row: number, col: number) => ({ char: row === 1 && col === 0 ? " " : "X" }),
  } as unknown as LibProbeSource
  const result = probe.lib(context)
  expect(result.observation).toMatchObject({
    outcome: "unsupported",
    assertionType: "buffer_state",
  })
  expect(writes).toContain("XXXXY")
  expect(writes).not.toContain("\x1b[?7l")
})

test("DECAWM refuses one-row geometry before a second-row read and enables its own fixture", () => {
  const probe = modesProbes.find((item) => item.id === "modes.auto-wrap")
  if (!probe?.lib) throw new Error("missing auto-wrap callback")
  const writes: string[] = []
  let rows = 1
  let enabled = false
  const context = {
    cols: 4,
    getScrollback: () => ({ viewportOffset: 0, totalLines: rows, screenLines: rows }),
    feed: (sequence: string) => {
      writes.push(sequence)
      if (sequence === "\x1b[?7h") enabled = true
      if (sequence === "\x1b[?7l") enabled = false
    },
    getMode: () => enabled,
    getCell: (row: number) => {
      throw new Error(`out-of-grid read ${row}`)
    },
  } as unknown as LibProbeSource
  const small = probe.lib(context)
  expect(small.observation).toMatchObject({ outcome: "inconclusive", assertionType: "buffer_state" })
  expect(writes).toEqual([])

  rows = 2
  context.getCell = (row: number, col: number) =>
    ({ char: row === 1 && col === 0 ? "Y" : "X" }) as ReturnType<LibProbeSource["getCell"]>
  const measured = probe.lib(context)
  expect(measured.observation).toMatchObject({ outcome: "supported", assertionType: "buffer_state" })
  expect(writes).toContain("\x1b[?7h")
  expect(writes.at(-1)).toBe("\x1b[?7l")
})

type Alt1049Scenario =
  | "roundtrip"
  | "ignored-entry"
  | "uncleared-entry"
  | "uncleared-exit"
  | "stale-exit"
  | "erasure-mimic"
  | "marker-leak"
  | "broken-exit"
  | "broken-cursor"
  | "readback-failure"
  | "cleanup-failure"
  | "constant-cursor"

/**
 * Minimal primary/alternate model: only the two seeded spans, the ALT marker and the cursor. `mode`
 * selects the private mode whose CSI ? h/l the model answers (1049 by default; ?47 and ?1047 share
 * the roundtrip, #30702). The model restores the parked cursor on every exit, so a ?47/?1047 grade
 * that changes under "broken-cursor" or "constant-cursor" would be grading a cursor it never saved.
 */
function alt1049Source(scenario: Alt1049Scenario, cols = 20, rows = 5, mode: 47 | 1047 | 1049 = 1049) {
  const enter = `\x1b[?${mode}h`
  const leave = `\x1b[?${mode}l`
  const writes: string[] = []
  const pad = (text: string) => (text + " ".repeat(cols)).slice(0, cols)
  const blank = " ".repeat(cols)
  const saved = { x: 6, y: 4 }
  let primaryA = blank
  let primaryB = blank
  let altA = blank
  let altB = blank
  let onAlt = false
  let entries = 0
  let cursor = { x: 0, y: 0 }
  const line = (row: number) =>
    onAlt ? (row === 0 ? altA : row === 2 ? altB : blank) : row === 0 ? primaryA : row === 2 ? primaryB : blank
  const context = {
    cols,
    getScrollback: () => ({ viewportOffset: 0, totalLines: rows, screenLines: rows }),
    feed(sequence: string) {
      writes.push(sequence)
      if (sequence === "\x1b[2J\x1b[1;1HPRIMARY-A") primaryA = pad("PRIMARY-A")
      else if (sequence === "\x1b[3;1HPRIMARY-B") primaryB = pad("PRIMARY-B")
      else if (sequence === "\x1b[5;7H") cursor = { ...saved }
      else if (sequence === enter) {
        if (scenario !== "ignored-entry") {
          onAlt = true
          cursor = { x: 0, y: 0 }
          entries += 1
          // An alternate buffer that keeps earlier content at the first entry: neither blank nor the
          // primary seed (a ?1047 exit clear leaves the second entry blank). An exit that did not clear
          // leaves the marker in place for the second entry to find; a partial clear leaves other content.
          if (scenario === "stale-exit" && entries > 1) {
            altA = pad("STALE-ALT")
            altB = pad("STALE-ALT")
          } else if (scenario !== "uncleared-exit" || entries === 1) {
            const stale = scenario === "uncleared-entry" && entries === 1
            altA = stale ? pad("STALE-ALT") : blank
            altB = stale ? pad("STALE-ALT") : blank
          }
        }
      } else if (sequence === "\x1b[1;1HALT-MARK") altA = pad("ALT-MARK")
      else if (sequence === leave) {
        if (scenario !== "broken-exit") {
          onAlt = false
          if (scenario === "erasure-mimic") {
            primaryA = blank
            primaryB = blank
          }
          if (scenario === "marker-leak") primaryA = pad("ALT-MARK")
          if (scenario !== "broken-cursor") cursor = { ...saved }
        }
      } else if (sequence === leave + "\x1b[0m") {
        if (scenario === "cleanup-failure") throw new Error("cleanup failed")
        onAlt = false
      }
    },
    getCell(row: number, col: number) {
      if (scenario === "readback-failure" && writes.length > 3) throw new Error("readback failed")
      const text = line(row)
      return { char: col < text.length ? text[col] : " " } as ReturnType<LibProbeSource["getCell"]>
    },
    getCursor: () =>
      scenario === "constant-cursor"
        ? { x: 0, y: 0, visible: true, style: null }
        : { ...cursor, visible: true, style: null },
  }
  return { context: context as unknown as LibProbeSource, writes }
}

function alt1049Probe(id: "enter" | "exit") {
  const definition = modesProbes.find((item) => item.id === `modes.alt-screen.${id}`)
  if (!definition?.lib) throw new Error(`Missing 1049 ${id} headless callback`)
  return definition
}

test("1049 enter grades only on the full roundtrip, with enter-specific defect controls", () => {
  const definition = alt1049Probe("enter")
  const ok = alt1049Source("roundtrip")
  expect(definition.lib!(ok.context).observation).toMatchObject({ outcome: "supported", assertionType: "buffer_state" })
  const ignored = alt1049Source("ignored-entry")
  const ignoredResult = definition.lib!(ignored.context)
  expect(ignoredResult.observation).toMatchObject({ outcome: "unsupported", assertionType: "buffer_state" })
  expect(ignoredResult.assertions).toMatchObject([{ kind: "negative" }])
  for (const scenario of ["erasure-mimic", "broken-exit", "marker-leak", "broken-cursor"] as const) {
    const { context } = alt1049Source(scenario)
    const result = definition.lib!(context)
    expect(result.observation, scenario).toMatchObject({ outcome: "inconclusive", reason: "insufficient-evidence" })
    expect(result.assertions, scenario).toBeUndefined()
  }
  const clipped = alt1049Source("roundtrip", 6)
  const clippedResult = definition.lib!(clipped.context)
  expect(clippedResult.observation).toMatchObject({ outcome: "inconclusive", reason: "insufficient-evidence" })
  expect(clipped.writes).toEqual([])
  expect(clippedResult.assertions).toBeUndefined()
  // Four rows cover the two seeds but not the row-4 saved pre-cursor; must refuse before feeding.
  const clippedRows = alt1049Source("roundtrip", 20, 4)
  const clippedRowsResult = definition.lib!(clippedRows.context)
  expect(clippedRowsResult.observation).toMatchObject({ outcome: "inconclusive", reason: "insufficient-evidence" })
  expect(clippedRows.writes).toEqual([])
  expect(clippedRowsResult.assertions).toBeUndefined()
})

test("1049 exit concludes only the full roundtrip and keeps restoration defects inconclusive", () => {
  const definition = alt1049Probe("exit")
  const ok = alt1049Source("roundtrip")
  expect(definition.lib!(ok.context).observation).toMatchObject({ outcome: "supported", assertionType: "buffer_state" })
  expect(ok.writes.at(-1)).toBe("\x1b[?1049l\x1b[0m")
  for (const scenario of ["erasure-mimic", "marker-leak", "broken-exit", "broken-cursor"] as const) {
    const { context } = alt1049Source(scenario)
    const result = definition.lib!(context)
    expect(result.observation, scenario).toMatchObject({ outcome: "inconclusive", reason: "insufficient-evidence" })
    expect(result.assertions, scenario).toBeUndefined()
  }
})

test("1049 exit keeps an unattributed entry failure inconclusive", () => {
  const definition = alt1049Probe("exit")
  const { context } = alt1049Source("ignored-entry")
  const result = definition.lib!(context)
  expect(result.observation).toMatchObject({ outcome: "inconclusive", reason: "insufficient-evidence" })
  expect(result.assertions).toBeUndefined()
})

// #31388: an engine whose source implements no alternate screen cannot enter one, so its ?1049 exit is not an
// "unattributed" result — it is an absence decided by source, the same shape as the audited title stack
// (device.ts TITLE_STACK_UNIMPLEMENTED_AUDITS, @cto 863bef67). The audit must key on the loaded source
// identity (integrity.repository + revision + treeOid + cleanTree), never on an adapter or engine name, so a
// moved or locally modified source falls back to the existing inconclusive answer instead of inheriting a
// negative. Recorded identity is the vt100 row of run 2026-10-30T01-34-04Z.
const VT100_SOURCE_IDENTITY = {
  kind: "js",
  adapterVersion: "0.10.2",
  termlessRevision: "d5e6248bfb080c3065f81b78c45bdfe1b37c06d6",
  resolvedPath: "vendor/vterm/packages/vt100/src/index.ts",
  integrity: {
    kind: "source",
    repository: "git@github.com:beorn/vterm.git",
    revision: "53a9eb9291b7880f4dc6a39a6802301049997a72",
    treeOid: "5ffc7ad9ae120d0bf93c64b0fdc712eb40892896",
    cleanTree: true,
  },
  runtimeFormat: "js",
  engineVersion: "0.9.0",
} as const

const withRuntimeIdentity = (context: LibProbeSource, runtimeIdentity: unknown): LibProbeSource =>
  Object.assign(context, { runtimeIdentity }) as LibProbeSource

test("1049 exit grades Unsupported by source citation when the loaded source has no alternate screen", () => {
  const definition = alt1049Probe("exit")
  const audited = alt1049Source("ignored-entry")
  const result = definition.lib!(withRuntimeIdentity(audited.context, VT100_SOURCE_IDENTITY))
  expect(result.observation).toMatchObject({
    outcome: "unsupported",
    assertionType: "buffer_state",
    note: "negative by source citation",
  })
  expect(result.assertions).toMatchObject([{ kind: "negative", assertionType: "buffer_state" }])
  expect(JSON.parse(result.response!)).toMatchObject({
    sourceCitation: expect.stringContaining("packages/vt100/src/screen.ts:99"),
  })
})

test("the same entry failure stays inconclusive on a moved, dirty or different source", () => {
  const definition = alt1049Probe("exit")
  const unauditedIdentities = [
    { ...VT100_SOURCE_IDENTITY.integrity, revision: "0".repeat(40) },
    { ...VT100_SOURCE_IDENTITY.integrity, treeOid: "0".repeat(40) },
    { ...VT100_SOURCE_IDENTITY.integrity, cleanTree: false },
  ]
  for (const integrity of unauditedIdentities) {
    const { context } = alt1049Source("ignored-entry")
    const result = definition.lib!(withRuntimeIdentity(context, { ...VT100_SOURCE_IDENTITY, integrity }))
    expect(result.observation, JSON.stringify(integrity)).toMatchObject({
      outcome: "inconclusive",
      reason: "insufficient-evidence",
    })
    expect(result.assertions, JSON.stringify(integrity)).toBeUndefined()
  }
})

test("1049 constant-cursor context cannot pass as a saved-cursor restoration", () => {
  for (const id of ["enter", "exit"] as const) {
    const definition = alt1049Probe(id)
    const { context, writes } = alt1049Source("constant-cursor")
    const result = definition.lib!(context)
    expect(result.observation, id).toMatchObject({ outcome: "inconclusive", reason: "insufficient-evidence" })
    expect(result.assertions, id).toBeUndefined()
    expect(writes, id).not.toContain("\x1b[?1049h")
  }
})

test("1049 readback failure is inconclusive while a cleanup failure stays loud", () => {
  const definition = alt1049Probe("exit")
  const { context, writes } = alt1049Source("readback-failure")
  const result = definition.lib!(context)
  expect(result.observation).toMatchObject({ outcome: "inconclusive", reason: "insufficient-evidence" })
  expect(result.assertions).toBeUndefined()
  expect(writes.at(-1)).toBe("\x1b[?1049l\x1b[0m")
  const cleanup = alt1049Source("cleanup-failure")
  expect(() => definition.lib!(cleanup.context)).toThrow("cleanup failed")
})

const ALT_SWAP = [
  ["modes.altscreen-47", 47],
  ["modes.altscreen-1047", 1047],
] as const

function altSwapHeadless(id: (typeof ALT_SWAP)[number][0]) {
  const definition = modesProbes.find((item) => item.id === id)
  if (!definition?.lib) throw new Error(`Missing ${id} headless callback`)
  return definition.lib
}

test.each(ALT_SWAP)("%s grades the full seeded roundtrip supported from cells and saves no cursor", (id, mode) => {
  for (const scenario of ["roundtrip", "broken-cursor", "constant-cursor"] as const) {
    const { context, writes } = alt1049Source(scenario, 20, 5, mode)
    const result = altSwapHeadless(id)(context)
    expect(result.observation, scenario).toMatchObject({ outcome: "supported", assertionType: "buffer_state" })
    expect(result.assertions, scenario).toMatchObject([{ kind: "positive" }])
    expect(writes, scenario).toContain(`\x1b[?${mode}h`)
    expect(writes, scenario).not.toContain("\x1b[?1049h")
    expect(writes.at(-1), scenario).toBe(`\x1b[?${mode}l\x1b[0m`)
  }
  // Without a saved-cursor claim the fixture needs only the two seeded rows.
  const threeRows = alt1049Source("roundtrip", 20, 3, mode)
  expect(altSwapHeadless(id)(threeRows.context).observation).toMatchObject({ outcome: "supported" })
})

test.each(ALT_SWAP)(
  "%s grades an ignored entry, an erasure, a leaked marker and a lost exit unsupported",
  (id, mode) => {
    for (const scenario of ["ignored-entry", "erasure-mimic", "marker-leak", "broken-exit"] as const) {
      const { context, writes } = alt1049Source(scenario, 20, 5, mode)
      const result = altSwapHeadless(id)(context)
      expect(result.observation, scenario).toMatchObject({ outcome: "unsupported", assertionType: "buffer_state" })
      expect(result.assertions, scenario).toMatchObject([{ kind: "negative" }])
      expect(writes.at(-1), scenario).toBe(`\x1b[?${mode}l\x1b[0m`)
    }
  },
)

test.each(ALT_SWAP)(
  "%s leaves alternate clearing on entry implementation-defined (xterm clears ?1047 on exit, #30702)",
  (id, mode) => {
    const stale = altSwapHeadless(id)(alt1049Source("uncleared-entry", 20, 5, mode).context)
    expect(stale.observation).toMatchObject({ outcome: "supported", assertionType: "buffer_state" })
    expect(stale.assertions).toMatchObject([{ kind: "positive" }])
  },
)

test("?1049 must clear the alternate buffer on entry: a stale alternate buffer fails it", () => {
  const result = alt1049Probe("enter").lib!(alt1049Source("uncleared-entry").context)
  expect(result.observation).toMatchObject({
    outcome: "unsupported",
    assertionType: "buffer_state",
    note: "CSI ? 1049 h did not clear the seeded primary spans",
  })
  expect(result.assertions).toMatchObject([{ kind: "negative" }])
})

test("?1047 must clear the alternate buffer on exit: a marker that survives re-entry fails it (DECRST 1047)", () => {
  const { context, writes } = alt1049Source("uncleared-exit", 20, 5, 1047)
  const result = altSwapHeadless("modes.altscreen-1047")(context)
  expect(result.observation).toMatchObject({ outcome: "unsupported", assertionType: "buffer_state" })
  expect(String(result.observation?.note)).toContain("did not clear the alternate buffer on exit")
  expect(result.assertions).toMatchObject([{ kind: "negative" }])
  expect(JSON.parse(result.response ?? "{}")).toMatchObject({ reentered: "ALT-MARK" })
  expect(writes.filter((write) => write === "\x1b[?1047h")).toHaveLength(2)
  expect(writes.at(-1)).toBe("\x1b[?1047l\x1b[0m")
  // A clean roundtrip re-enters once and reads the marker gone.
  const clean = alt1049Source("roundtrip", 20, 5, 1047)
  const graded = altSwapHeadless("modes.altscreen-1047")(clean.context)
  expect(graded.observation).toMatchObject({ outcome: "supported" })
  expect(JSON.parse(graded.response ?? "{}")).toMatchObject({ reentered: " ".repeat("ALT-MARK".length) })
  expect(clean.writes.filter((write) => write === "\x1b[?1047h")).toHaveLength(2)
  // ?47 promises no exit clear: the same surviving marker passes, and it enters only once.
  const legacy = alt1049Source("uncleared-exit", 20, 5, 47)
  expect(altSwapHeadless("modes.altscreen-47")(legacy.context).observation).toMatchObject({ outcome: "supported" })
  expect(legacy.writes.filter((write) => write === "\x1b[?47h")).toHaveLength(1)
})

test("?1047 re-entry that shows other content, neither blank nor ALT-MARK, is inconclusive by name", () => {
  const { context, writes } = alt1049Source("stale-exit", 20, 5, 1047)
  const result = altSwapHeadless("modes.altscreen-1047")(context)
  expect(result.observation).toMatchObject({ outcome: "inconclusive", reason: "insufficient-evidence" })
  expect(String(result.observation?.note)).toContain("neither blank nor ALT-MARK")
  expect(result.assertions).toBeUndefined()
  expect(JSON.parse(result.response ?? "{}")).toMatchObject({ reentered: "STALE-AL" })
  expect(writes.at(-1)).toBe("\x1b[?1047l\x1b[0m")
})

test.each(ALT_SWAP)("%s stays inconclusive on an undersized grid or an unavailable readback", (id, mode) => {
  for (const [cols, rows] of [
    [6, 5],
    [20, 2],
  ] as const) {
    const { context, writes } = alt1049Source("roundtrip", cols, rows, mode)
    const result = altSwapHeadless(id)(context)
    expect(result.observation, `${cols}x${rows}`).toMatchObject({
      outcome: "inconclusive",
      reason: "insufficient-evidence",
    })
    expect(result.assertions, `${cols}x${rows}`).toBeUndefined()
    expect(writes, `${cols}x${rows}`).toEqual([])
  }
  const { context, writes } = alt1049Source("readback-failure", 20, 5, mode)
  const failed = altSwapHeadless(id)(context)
  expect(failed.observation).toMatchObject({ outcome: "inconclusive", reason: "insufficient-evidence" })
  expect(failed.assertions).toBeUndefined()
  expect(writes.at(-1)).toBe(`\x1b[?${mode}l\x1b[0m`)
})

// A painted alternate marker distinguishes frames, but it does not qualify buffer entry.
// Existing positive roundtrips cannot catch attribution of an unqualified entry failure to exit.
test.each([
  ["modes.alt-screen.exit", "pixels"],
  ["modes.alt-screen.exit", "text-cells"],
  ["modes.altscreen-1047", "pixels"],
  ["modes.altscreen-1047", "text-cells"],
] as const)("%s keeps an exit-negative pending when entry is not qualified on %s", async (id, kind) => {
  const definition = modesProbes.find((entry) => entry.id === id)
  if (!definition?.term) throw new Error(`Missing app callback for ${id}`)
  const result = await definition.term(captureSource(24, 80, [], [], true, kind, false))
  expect(result.observation?.outcome).not.toBe("unsupported")
  expect(result.tests?.some((row) => row.status === "unsupported")).not.toBe(true)
  expect(result.tests).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ status: "test-todo", reason: expect.stringContaining("entry not qualified") }),
    ]),
  )
})

test("alt-screen exit capture frames the primary, alternate and restored buffers", async () => {
  const definition = modesProbes.find((item) => item.id === "modes.alt-screen.exit")
  if (!definition?.term) throw new Error("Missing app alt-screen exit callback")
  const writes: string[] = []
  const frames: ObservationFrame[] = []
  const result = await definition.term(captureSource(24, 80, writes, frames))
  expect(writes.some((entry) => entry.includes("\x1b[?1049h"))).toBe(true)
  expect(writes).toContain("\x1b[?1049l")
  expect(result.tests).toMatchObject([
    { id: "primary-marker-restored", status: "supported", assertionRefs: [0] },
    { id: "alternate-marker-control", status: "supported", assertionRefs: [1] },
    { id: "remaining-facets", status: "test-todo", reason: expect.stringMatching(/saved cursor.*scrollback/) },
  ])
  expect(result.assertions).toHaveLength(2)
  expect(result.observation?.frames?.filter((frame) => frame.role === "target")).toHaveLength(1)
})

test.each(["modes.altscreen-47", "modes.altscreen-1047"] as const)(
  "%s capture frames the swapped and restored buffers without grading",
  async (id) => {
    const definition = modesProbes.find((item) => item.id === id)
    if (!definition?.term) throw new Error(`Missing app callback for ${id}`)
    const writes: string[] = []
    const frames: ObservationFrame[] = []
    const result = await definition.term(captureSource(24, 80, writes, frames))
    expect(result.tests).toMatchObject([
      { id: "primary-marker-restored", status: "supported" },
      { id: "alternate-marker-control", status: "supported" },
      {
        id: "remaining-facets",
        status: "test-todo",
        reason: expect.stringMatching(id === "modes.altscreen-1047" ? /clear.*exit/i : /next entry/),
      },
    ])
    expect(result.assertions).toHaveLength(2)
    expect(result.observation?.frames?.filter((frame) => frame.role === "target")).toHaveLength(1)
  },
)

test("insert-replace capture contrasts replacement with IRM insertion", async () => {
  const definition = modesProbes.find((item) => item.id === "modes.insert-replace")
  if (!definition?.term) throw new Error("Missing app IRM callback")
  const writes: string[] = []
  const frames: ObservationFrame[] = []
  const result = await definition.term(captureSource(24, 80, writes, frames))
  expect(writes.some((entry) => entry.includes("\x1b[4h"))).toBe(true)
  expect(result.tests).toEqual([{ id: "inserted-cells", status: "supported", assertionRefs: [0] }])
  expect(result.observation).toMatchObject({ outcome: "supported", assertionType: "screenshot" })
  expect(result.observation?.frames?.filter((frame) => frame.role === "target")).toHaveLength(1)
  expect(frames.find((frame) => frame.label.endsWith("expected frame"))?.regionRectangle).toEqual({
    x: 0,
    y: 0,
    width: 50,
    height: 20,
  })
})

// Permanent-state replies are well formed but cannot prove the claimed set/reset toggle.
test.each([
  [1, 2, "supported"],
  [3, 2, "unsupported"],
  [1, 4, "unsupported"],
  [3, 4, "unsupported"],
] as const)("insert-replace measures toggle states %i then %i", async (on, off, outcome) => {
  const definition = modesProbes.find((item) => item.id === "modes.insert-replace")
  if (!definition?.term) throw new Error("Missing app IRM callback")
  const writes: string[] = []
  const ctx = captureSource(24, 80, writes, [])
  const states = [on, off]
  ctx.queryWithSentinel = async (_sequence, pattern) => pattern.exec(`\x1b[4;${states.shift()}$y`)
  const result = await definition.term(ctx)
  expect(result.observation).toMatchObject({ outcome, assertionType: "query_reply" })
  expect(result.assertions?.[0]?.kind).toBe(outcome === "supported" ? "positive" : "negative")
  expect(result.response).toContain(`Ps ${on}`)
  expect(result.response).toContain(`Ps ${off}`)
  expect(writes.at(-1)).toBe("\x1b[4l")
})

test("left/right margin capture contrasts an unconstrained write with a margin-confined wrap", async () => {
  const definition = modesProbes.find((item) => item.id === "modes.left-right-margin")
  if (!definition?.term) throw new Error("Missing app margin callback")
  const writes: string[] = []
  const frames: ObservationFrame[] = []
  const result = await definition.term(captureSource(24, 80, writes, frames))
  expect(writes.some((entry) => entry.includes("\x1b[?69h"))).toBe(true)
  expect(writes.some((entry) => entry.includes("\x1b[3;6s"))).toBe(true)
  expect(result.tests).toEqual([{ id: "margin-wrap", status: "supported", assertionRefs: [0] }])
  expect(result.observation).toMatchObject({ outcome: "supported", assertionType: "screenshot" })
  expect(frames.find((frame) => frame.label.endsWith("expected frame"))?.regionRectangle).toEqual({
    x: 20,
    y: 20,
    width: 10,
    height: 20,
  })
})

test("modes capture refuses undersized geometry before any bytes or frames", async () => {
  for (const [id, rows, cols, need] of [
    ["modes.left-right-margin", 1, 7, "2x8"],
    ["modes.alt-screen.exit", 3, 5, "3x8"],
    ["modes.insert-replace", 1, 5, "1x6"],
  ] as const) {
    const definition = modesProbes.find((item) => item.id === id)
    if (!definition?.term) throw new Error(`Missing app callback for ${id}`)
    const writes: string[] = []
    const frames: ObservationFrame[] = []
    const result = await definition.term(captureSource(rows, cols, writes, frames))
    expect(writes, id).toEqual([])
    expect(frames, id).toEqual([])
    expect(result.observation, id).toBeUndefined()
    expect(result.assertions, id).toBeUndefined()
    expect(result.tests, id).toMatchObject([
      expect.objectContaining({ status: "test-todo", reason: expect.stringContaining(need) }),
    ])
  }
})

test.each([
  ["modes.xtpushsgr", "\x1b[#{"],
  ["modes.xtpopsgr", "\x1b[#}"],
  ["modes.xtsave", "\x1b[?7s"],
  ["modes.xtrestore", "\x1b[?7r"],
  ["modes.xtpushcolors", "\x1b[#P"],
  ["modes.xtpopcolors", "\x1b[#Q"],
] as const)("%s capture records control and target pixels for its stack sequence", async (id, marker) => {
  const definition = modesProbes.find((item) => item.id === id)
  if (!definition?.term) throw new Error(`Missing app callback for ${id}`)
  const writes: string[] = []
  const frames: ObservationFrame[] = []
  const result = await definition.term(captureSource(24, 80, writes, frames))
  expect(
    writes.some((entry) => entry.includes(marker)),
    id,
  ).toBe(true)
  expect(result.observation, id).toMatchObject({ outcome: "supported", assertionType: "screenshot" })
  expect(result.assertions, id).toHaveLength(id.includes("sgr") ? 2 : 1)
  expect(
    result.tests?.every((row) => row.status === "supported"),
    id,
  ).toBe(true)
  expect(
    result.assertions?.every((assertion) => assertion.kind === "positive"),
    id,
  ).toBe(true)
  if (id.includes("sgr")) {
    expect(result.tests).toEqual([
      { id: "bold-restored", status: "supported", assertionRefs: [0] },
      { id: "italic-cleared", status: "supported", assertionRefs: [1] },
    ])
  }
  if (id === "modes.xtsave" || id === "modes.xtrestore") {
    expect(writes.some((entry) => entry.includes("X".repeat(80) + "!"))).toBe(true)
    expect(writes).toContain("\x1b[?7h")
  }
  if (id.includes("sgr")) {
    // Early review has no target frame; both axes' unqualified capture citations must survive composition.
    vi.useFakeTimers()
    try {
      const pending = definition.term(captureSource(24, 80, [], [], false))
      const [stale] = await Promise.all([pending, vi.runAllTimersAsync()])
      expect(stale.observation).toBeUndefined()
      expect(stale.assertions).toBeUndefined()
      expect(stale.tests).toMatchObject([
        { id: "review", status: "test-todo", reason: expect.stringContaining("no freshness witness") },
      ])
      const retained = JSON.parse(stale.response ?? "{}") as { axes: string[] }
      expect(retained.axes).toHaveLength(2)
      for (const axis of retained.axes) {
        const response = JSON.parse(axis) as { review: { screenshotRef: string } }
        expect(response.review.screenshotRef).toMatch(/^sha256:/)
      }
    } finally {
      vi.useRealTimers()
    }
  }
})

test.each(["modes.xtpushcolors", "modes.xtpopcolors"] as const)(
  "%s grades the color-stack roundtrip on Y and permits X to recolor (turn362)",
  async (id) => {
    const definition = modesProbes.find((item) => item.id === id)
    if (!definition?.term) throw new Error(`Missing app callback for ${id}`)
    const writes: string[] = []
    const frames: ObservationFrame[] = []
    const result = await definition.term(captureSource(24, 80, writes, frames))
    expect(result.tests, id).toEqual([{ id: "palette-y-restored", status: "supported", assertionRefs: [0] }])
    const compared = frames.filter((frame) =>
      /(?:pre-edit seed|post-sequence target|expected frame|ignored-attribute frame|setup reference frame)$/.test(
        frame.label,
      ),
    )
    expect(compared, id).toHaveLength(5)
    expect(
      compared.every(
        (frame) => JSON.stringify(frame.regionRectangle) === JSON.stringify({ x: 10, y: 0, width: 10, height: 20 }),
      ),
      id,
    ).toBe(true)
    expect(
      writes.some((entry) => entry.includes("\x1b[38;2;0;0;255mY")),
      id,
    ).toBe(true)
    expect(
      writes.some((entry) => entry.includes("rgb:00/ff/00")),
      id,
    ).toBe(true)
  },
)

test("xt stack capture refuses undersized geometry before any bytes or frames", async () => {
  for (const [id, rows, cols, need] of [
    ["modes.xtpushsgr", 2, 80, "5x6"],
    // XT-save/restore derives its wrap boundary from the measured width, so an undersized
    // fixture is under two rows or two columns, not an absolute column count.
    ["modes.xtsave", 1, 80, "4x2"],
    ["modes.xtpushcolors", 2, 80, "4x8"],
  ] as const) {
    const definition = modesProbes.find((item) => item.id === id)
    if (!definition?.term) throw new Error(`Missing app callback for ${id}`)
    const writes: string[] = []
    const frames: ObservationFrame[] = []
    const result = await definition.term(captureSource(rows, cols, writes, frames))
    expect(writes, id).toEqual([])
    expect(frames, id).toEqual([])
    expect(result.observation, id).toBeUndefined()
    expect(result.assertions, id).toBeUndefined()
    expect(result.tests, id).toMatchObject([
      expect.objectContaining({ status: "test-todo", reason: expect.stringContaining(need) }),
    ])
  }
})

const DECSSCLS_GEOMETRY = { cellWidth: 10, cellHeight: 20, textWidth: 800, textHeight: 480 } as const
const DECSSCLS_RECTANGLE = { x: 0, y: 0, width: 800, height: 440 } as const
const DECSSCLS_WITNESS = { top: 1, left: 1, bottom: 23, right: 80 } as const
const DECSSCLS_MARKER_REF = "marker-ref"
const DECSSCLS_BAND_RECTANGLE = { x: 0, y: 0, width: 800, height: 20 } as const

interface DecssclsFixture {
  /** Raw region digest per capture, in capture order; defaults to the frame ref. */
  cells?: readonly (string | undefined)[]
  /** Marker-band presence per band capture AFTER the clean-screen reference, in capture order. */
  band?: readonly ("present" | "absent")[]
  /** The screen rectangle each capture was cropped from; defaults to one shared rectangle. */
  rectangles?: readonly CaptureRectangle[]
  /** Capture index that answers with a text-cells frame, as a text arm does. */
  textCellsAt?: number
  /** Capture index that answers with no digests at all, as a broken collector does. */
  missingDigestAt?: number
  /** The requests the probe handed the capture adapter, in capture order. */
  requests?: CaptureRequest[]
  /** What DECRQM 4 answers before the probe: the DECSCLM state it must put back. */
  decsclm?: "set" | "reset" | "unknown" | null
}

function decssclsSource(
  refs: readonly string[],
  writes: string[],
  frames: ObservationFrame[],
  rows = 24,
  fixture: DecssclsFixture = {},
): TermProbeSource {
  const context = captureSource(rows, 80, writes, frames)
  context.captureGeometry = {
    geometry: { ...DECSSCLS_GEOMETRY },
    source: "measured by complete raster calibration",
  }
  context.queryMode = async () => fixture.decsclm ?? null
  let index = 0
  let bandIndex = 0
  context.capture = async (request) => {
    fixture.requests?.push(request)
    // A one-row request is the marker band; the whole-witness request keeps the old path. The
    // clean-screen reference is the first band capture and always shows the band.
    if (request.cells !== undefined && request.cells.top === request.cells.bottom) {
      const present = bandIndex === 0 || (fixture.band?.[bandIndex - 1] ?? "present") === "present"
      bandIndex += 1
      const ref = present ? DECSSCLS_MARKER_REF : "no-band"
      const bandFrame: ObservationFrame = {
        role: request.role,
        label: request.label,
        capturedAt: frames.length + 1,
        ref,
        regionDigest: ref,
        pixelsDigest: `whole:${ref}`,
        regionRectangle: DECSSCLS_BAND_RECTANGLE,
      }
      frames.push(bandFrame)
      return bandFrame
    }
    const position = index
    index += 1
    const ref = refs[position] ?? "sha256:missing"
    const base = { role: request.role, label: request.label, capturedAt: frames.length + 1, ref }
    const frame: ObservationFrame =
      position === fixture.textCellsAt
        ? {
            ...base,
            kind: "text-cells",
            cellDigest: ref,
            frameDigest: ref,
            cellRectangle: { top: 1, left: 1, bottom: Math.max(1, rows - 2), right: 80 },
          }
        : position === fixture.missingDigestAt
          ? base
          : {
              ...base,
              regionDigest: fixture.cells?.[position] ?? ref,
              pixelsDigest: `whole:${ref}`,
              regionRectangle: fixture.rectangles?.[position] ?? DECSSCLS_RECTANGLE,
            }
    frames.push(frame)
    return frame
  }
  return context
}

function decsscls() {
  const definition = modesProbes.find((entry) => entry.id === "modes.decsscls")
  if (!definition?.term) throw new Error("Missing modes.decsscls term callback")
  return definition
}

/** Answer the six `performance.now()` reads of the two phases, so each capture's timing is exact. */
async function withDecssclsClock(
  controlFirstMs: number,
  targetFirstMs: number,
  work: () => Promise<void>,
  targetBandMs = targetFirstMs,
): Promise<void> {
  const now = vi.spyOn(performance, "now")
  const ticks = [0, controlFirstMs, controlFirstMs, 100_000, 100_000 + targetFirstMs, 100_000 + targetBandMs]
  now.mockImplementation(() => ticks.shift() ?? 0)
  try {
    await work()
  } finally {
    now.mockRestore()
  }
}

test("modes.decsscls grades text moving through the witness region inside the window as supported", async () => {
  const writes: string[] = []
  const frames: ObservationFrame[] = []
  const requests: CaptureRequest[] = []
  const result = await decsscls().term!(
    decssclsSource(["jump-t0", "jump-t1", "slow-t0", "slow-t1"], writes, frames, 24, {
      cells: ["jump", "jump", "slow-t0", "slow-t1"],
      band: ["present", "present", "absent", "present"],
      requests,
    }),
  )
  expect(result.observation).toMatchObject({
    outcome: "supported",
    assertionType: "screenshot",
    screenshotRef: "slow-t1",
  })
  expect(result.observation?.note).toContain("marker band reached its settled row")
  // The decided verdict cites the four region digests, so the run parser can recompute it.
  expect(result.response).toContain(JSON.stringify({ control: ["jump", "jump"], target: ["slow-t0", "slow-t1"] }))
  expect(result.assertions).toMatchObject([{ kind: "positive" }])
  expect(frames).toHaveLength(9)
  // Every capture names the measured geometry: pixels only, never ctx.cells. The first is the
  // clean-screen marker reference; then each frame is a witness capture plus a 1-row band capture.
  for (const request of requests) expect(request.pixelGeometry).toEqual(DECSSCLS_GEOMETRY)
  expect(requests[0]?.cells).toEqual({ top: 16, left: 1, bottom: 16, right: 80 })
  expect(requests.slice(1).filter((request) => request.cells?.top === request.cells?.bottom)).toHaveLength(4)
  expect(requests.slice(1).filter((request) => request.cells?.top !== request.cells?.bottom)).toHaveLength(4)
  expect(writes.some((write) => write.includes("\x1b[?4h"))).toBe(true)
  // DECSCLM is restored to what DECRQM 4 reported; this fixture answers nothing, so it restores reset.
  const exit = writes.find((write) => write.includes("\x1b[?1049l"))
  expect(exit).toContain("\x1b[0 p")
  expect(exit).toContain("\x1b[?4l")
  expect(result.response).toContain("prior DECSCLM unknown, restored reset")
  expect(writes.some((write) => write.includes("\x1b[9 p"))).toBe(true)
  expect(writes.some((write) => write.includes("\x1b[0 p"))).toBe(true)
  expect(writes.some((write) => write.includes("line 40"))).toBe(true)
  expect(writes.some((write) => write.includes("\x1b[?1049l"))).toBe(true)
})

test("modes.decsscls places the authored marker band on the row its reference sample reads", async () => {
  const writes: string[] = []
  const frames: ObservationFrame[] = []
  const requests: CaptureRequest[] = []
  const rows = 24
  const result = await decsscls().term!(
    decssclsSource(["jump-t0", "jump-t1", "slow-t0", "slow-t1"], writes, frames, rows, {
      cells: ["jump", "jump", "slow-t0", "slow-t1"],
      band: ["present", "present", "absent", "present"],
      requests,
    }),
  )
  expect(result.observation).toMatchObject({ outcome: "supported" })

  const targetBurst = writes.find((write) => write.includes("\x1b[?1049h\x1b[2J\x1b[H\x1b[9 p"))
  expect(targetBurst).toBeDefined()
  const setting = "\x1b[9 p"
  const authored = targetBurst!.slice(targetBurst!.indexOf(setting) + setting.length).split("\r\n")
  expect(authored[authored.length - 1]).toBe("")
  const lines = authored.slice(0, -1)
  const markerIndex = lines.findIndex((line) => line.includes("\x1b[48;5;196m"))
  expect(markerIndex).toBeGreaterThanOrEqual(0)
  const markerLine = markerIndex + 1
  const settledRow = markerLine - (lines.length - rows + 1)
  // The ruled placement: authored seven lines before the burst's end, settled eight rows up.
  expect(settledRow).toBe(rows - 8)

  const reference = writes.find(
    (write) => write.includes("\x1b[?1049h\x1b[2J\x1b[H\r\n") && write.includes("\x1b[48;5;196m"),
  )
  expect(reference).toBeDefined()
  const beforeBand = reference!.slice(0, reference!.indexOf("\x1b[48;5;196m"))
  const referenceRow = (beforeBand.match(/\r\n/g) ?? []).length + 1
  expect(referenceRow).toBe(settledRow)

  const bandRequest = requests.find(
    (request) => request.cells !== undefined && request.cells.top === request.cells.bottom,
  )
  expect(bandRequest?.cells?.top).toBe(settledRow)
})

test("modes.decsscls grades an instant repaint with the marker band in place as unsupported", async () => {
  const writes: string[] = []
  const frames: ObservationFrame[] = []
  const result = await decsscls().term!(
    decssclsSource(["jump", "jump", "slow-before", "slow-after"], writes, frames, 24, {
      cells: ["jump", "jump", "slow-before", "slow-after"],
      band: ["present", "present", "present", "present"],
    }),
  )
  expect(result.observation).toMatchObject({ outcome: "unsupported", assertionType: "screenshot" })
  expect(result.observation?.note).toContain("marker band")
})

test("modes.decsscls overruns whatever height the context measured", async () => {
  const writes: string[] = []
  const frames: ObservationFrame[] = []
  const result = await decsscls().term!(
    decssclsSource(["jump-t0", "jump-t1", "slow-t0", "slow-t1"], writes, frames, 50, {
      cells: ["jump", "jump", "slow-t0", "slow-t1"],
      band: ["present", "present", "absent", "present"],
    }),
  )
  expect(result.observation).toMatchObject({ outcome: "supported", assertionType: "screenshot" })
  expect(writes.some((write) => write.includes("line 66"))).toBe(true)
})

test("modes.decsscls refuses a one-row screen, where its witness would be the cursor row", async () => {
  const writes: string[] = []
  const frames: ObservationFrame[] = []
  const result = await decsscls().term!(decssclsSource(["a", "b", "c", "d"], writes, frames, 1))
  expect(result.notTested).toMatchObject({ reason: "no-semantic-observable" })
  expect(result.note).toContain("no row above it")
  expect(writes).toEqual([])
  expect(frames).toEqual([])
})

test("modes.decsscls puts back the DECSCLM state it read before the probe", async () => {
  for (const [prior, expected] of [
    ["set", "\x1b[?4h"],
    ["reset", "\x1b[?4l"],
  ] as const) {
    const writes: string[] = []
    const frames: ObservationFrame[] = []
    const result = await decsscls().term!(
      decssclsSource(["jump-t0", "jump-t1", "slow-t0", "slow-t1"], writes, frames, 24, {
        cells: ["jump", "jump", "slow-t0", "slow-t1"],
        band: ["present", "present", "absent", "present"],
        decsclm: prior,
      }),
    )
    expect(result.observation?.outcome, prior).toBe("supported")
    const exit = writes.find((write) => write.includes("\x1b[?1049l"))
    expect(exit, prior).toContain(expected)
    expect(result.response, prior).toContain(`"prior":"${prior}"`)
  }
}, 20_000)

test("modes.decsscls names a refused capture geometry instead of claiming the run had none", async () => {
  const writes: string[] = []
  const frames: ObservationFrame[] = []
  const context = captureSource(24, 80, writes, frames)
  context.captureGeometryRefusal = "cell-to-pixel calibration answered no DA1 reply"
  context.captureGeometry = undefined
  const result = await decsscls().term!(context)
  expect(result.notTested).toMatchObject({ reason: "no-semantic-observable" })
  expect(result.note).toContain("this run refused capture geometry: cell-to-pixel calibration answered no DA1 reply")
  expect(writes).toEqual([])
})

test("modes.decsscls does not grade unsupported when an honoring first frame lands at 1.5 s", async () => {
  const writes: string[] = []
  const frames: ObservationFrame[] = []
  await withDecssclsClock(40, 1500, async () => {
    const result = await decsscls().term!(
      decssclsSource(["jump-t0", "jump-t1", "slow-t0", "slow-t1"], writes, frames, 24, {
        cells: ["jump", "jump", "slow-t0", "slow-t1"],
        band: ["present", "present", "absent", "present"],
      }),
    )
    expect(result.observation).toMatchObject({ outcome: "supported", assertionType: "screenshot" })
    // 24 rows leave 17 scrolled lines: ceil(17 / 9 * 1000) = 1889 ms, so 1.5 s is inside it.
    expect(result.response).toContain('"timingBoundMs":1739')
  })
})

test("modes.decsscls stays inconclusive when only the target band capture lands outside the throttled window", async () => {
  const writes: string[] = []
  const frames: ObservationFrame[] = []
  await withDecssclsClock(
    40,
    40,
    async () => {
      const result = await decsscls().term!(
        decssclsSource(["jump-t0", "jump-t1", "slow-t0", "slow-t1"], writes, frames, 24, {
          cells: ["jump", "jump", "slow-t0", "slow-t1"],
          band: ["present", "present", "present", "present"],
        }),
      )
      expect(result.observation).toMatchObject({
        outcome: "inconclusive",
        reason: "insufficient-evidence",
        assertionType: "screenshot",
      })
      expect(result.observation?.note).toContain("outside the 1889 ms throttled window")
      // The witness frame landed early; only the band capture is late, so a band present there
      // cannot be placed inside the window and must not grade unsupported on the earlier time.
      expect(result.response).toContain('"targetFirstElapsedMs":40')
      expect(result.response).toContain('"targetFirstBandElapsedMs":2400')
      expect(result.assertions).toBeUndefined()
    },
    2400,
  )
})

test("modes.decsscls grades an identical target pair inside the window as unsupported", async () => {
  const writes: string[] = []
  const frames: ObservationFrame[] = []
  const result = await decsscls().term!(
    decssclsSource(["jump-t0", "jump-t1", "slow", "slow"], writes, frames, 24, {
      cells: ["jump", "jump", "slow", "slow"],
      band: ["present", "present", "present", "present"],
    }),
  )
  expect(result.observation).toMatchObject({ outcome: "unsupported", assertionType: "screenshot" })
  expect(result.observation?.note).toContain("already at its settled row in the target's first band capture")
  expect(result.assertions).toMatchObject([{ kind: "negative" }])
})

test("modes.decsscls stays inconclusive when the marker band never arrives", async () => {
  const writes: string[] = []
  const frames: ObservationFrame[] = []
  const result = await decsscls().term!(
    decssclsSource(["jump", "jump", "slow-before", "slow-after"], writes, frames, 24, {
      cells: ["jump", "jump", "slow-before", "slow-after"],
      band: ["present", "present", "absent", "absent"],
    }),
  )
  expect(result.observation).toMatchObject({
    outcome: "inconclusive",
    reason: "insufficient-evidence",
    assertionType: "screenshot",
  })
  expect(result.observation?.note).toContain("had not reached its settled row")
  expect(result.assertions).toBeUndefined()
})

test("modes.decsscls refuses a screen too short to place the marker band", async () => {
  const writes: string[] = []
  const frames: ObservationFrame[] = []
  const result = await decsscls().term!(decssclsSource(["a", "b", "c", "d"], writes, frames, 8))
  expect(result.notTested).toMatchObject({ reason: "no-semantic-observable" })
  expect(result.note).toContain("at least 10 rows")
  expect(writes).toEqual([])
  expect(frames).toEqual([])
})

test("modes.decsscls stays inconclusive when the jump control is still painting", async () => {
  const writes: string[] = []
  const frames: ObservationFrame[] = []
  const result = await decsscls().term!(
    decssclsSource(["jump-t0", "jump-t1", "slow-t0", "slow-t1"], writes, frames, 24, {
      cells: ["jump-t0", "jump-t1", "slow-t0", "slow-t1"],
    }),
  )
  expect(result.observation).toMatchObject({
    outcome: "inconclusive",
    reason: "insufficient-evidence",
    assertionType: "screenshot",
  })
  expect(result.observation?.note).toContain("jump control moved between two frames")
  expect(result.assertions).toBeUndefined()
})

test("modes.decsscls stays inconclusive when the pair was cropped from different rectangles", async () => {
  const writes: string[] = []
  const frames: ObservationFrame[] = []
  const shifted = { ...DECSSCLS_RECTANGLE, y: DECSSCLS_RECTANGLE.y + 26 }
  const result = await decsscls().term!(
    decssclsSource(["jump-t0", "jump-t1", "slow-t0", "slow-t1"], writes, frames, 24, {
      cells: ["jump", "jump", "slow-t0", "slow-t1"],
      rectangles: [DECSSCLS_RECTANGLE, DECSSCLS_RECTANGLE, DECSSCLS_RECTANGLE, shifted],
    }),
  )
  expect(result.observation).toMatchObject({
    outcome: "inconclusive",
    reason: "insufficient-evidence",
    assertionType: "screenshot",
  })
  expect(result.observation?.note).toContain("cropped from different rectangles")
  expect(result.assertions).toBeUndefined()
})

test("modes.decsscls refuses a text-cells frame instead of grading a buffer", async () => {
  const writes: string[] = []
  const frames: ObservationFrame[] = []
  await expect(
    decsscls().term!(
      decssclsSource(["jump-t0", "jump-t1", "slow-t0", "slow-t1"], writes, frames, 24, { textCellsAt: 2 }),
    ),
  ).rejects.toThrow(/returned a text-cells frame/)
  expect(writes.some((write) => write.includes("\x1b[?1049l"))).toBe(true)
})

test("modes.decsscls raises on a pixel frame with no digest for the requested cells", async () => {
  const writes: string[] = []
  const frames: ObservationFrame[] = []
  await expect(
    decsscls().term!(
      decssclsSource(["jump-t0", "jump-t1", "slow-t0", "slow-t1"], writes, frames, 24, { missingDigestAt: 0 }),
    ),
  ).rejects.toThrow(/no digest for the requested cells/)
})

test("modes.decsscls names the missing pixel capture on a text-only context", async () => {
  const writes: string[] = []
  const frames: ObservationFrame[] = []
  const context = captureSource(24, 80, writes, frames)
  // A text arm installs the cells adapter and no pixel capture at all.
  context.capture = undefined
  context.cells = async ({ role, label }) => {
    const frame: ObservationFrame = {
      kind: "text-cells",
      role,
      label,
      capturedAt: 1,
      ref: "sha256:text",
      cellDigest: "cells",
      frameDigest: "frame",
      cellRectangle: { top: 1, left: 1, bottom: 22, right: 80 },
    }
    frames.push(frame)
    return frame
  }
  const result = await decsscls().term!(context)
  expect(result.notTested).toMatchObject({ reason: "no-semantic-observable" })
  expect(result.note).toContain("no pixel capture callback")
  expect(frames).toEqual([])
})

test("modes.decsscls names the missing capture instead of claiming presentation timing", async () => {
  const writes: string[] = []
  const frames: ObservationFrame[] = []
  const context = captureSource(24, 80, writes, frames)
  context.capture = undefined
  const result = await decsscls().term!(context)
  expect(result.notTested).toMatchObject({ reason: "no-semantic-observable" })
  expect(result.observation).toBeUndefined()
})
