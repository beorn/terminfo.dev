/**
 * @failure A plausible cursor reply or a near-bottom row is credited as the named cursor behavior without a matching position observation.
 * @level l1
 * @consumer Headless and app cursor results projected into terminal support cells
 * @testonly none
 */
import { expect, test } from "vitest"
import { cursorProbes } from "./cursor.ts"
import { cursorProbe } from "./helpers.ts"
import type { TermContext, TermlessContext } from "./types.ts"

function byId(id: string) {
  const probe = cursorProbes.find((value) => value.id === id)
  if (!probe?.termless || !probe.term) throw new Error(`missing cursor callbacks for ${id}`)
  return probe
}

function app(position: { row: number; col: number } | null): TermContext {
  return {
    write() {},
    queryCursorPosition: async () => position,
    measureRenderedWidth: async () => null,
    query: async () => null,
    queryWithSentinel: async () => null,
    queryOutcome: async () => ({ match: null, reason: "timeout", raw: "", rawBase64: "" }),
    queryWithSentinelOutcome: async () => ({ match: null, reason: "timeout", raw: "", rawBase64: "" }),
    queryMode: async () => null,
    cols: 80,
    rows: 24,
  }
}

function headless(x: number, y: number, rows = 24, reply = ""): TermlessContext {
  return {
    cols: 80,
    feed() {},
    feedCapture: () => reply,
    getCell: () => ({
      char: "",
      bold: false,
      dim: false,
      italic: false,
      underline: false,
      underlineColor: null,
      strikethrough: false,
      inverse: false,
      hidden: false,
      blink: false,
      fg: null,
      bg: null,
      wide: false,
    }),
    getCursor: () => ({ x, y, visible: true, style: null }),
    getMode: () => false,
    getText: () => "",
    getScrollback: () => ({ viewportOffset: 0, totalLines: rows, screenLines: rows }),
    getTitle: () => "",
    reset() {},
    capabilities: {
      truecolor: false,
      kittyKeyboard: false,
      kittyGraphics: false,
      sixel: false,
      osc8Hyperlinks: false,
      semanticPrompts: false,
      reflow: false,
      unicode: "unknown",
      extensions: new Set(),
    },
  }
}

test("cursor save/restore records the mismatched position and a missing app reply stays inconclusive", async () => {
  const probe = byId("cursor.ansi-save")
  const headlessResult = probe.termless!(headless(4, 2))
  expect(headlessResult.observation).toMatchObject({ outcome: "supported", evidence: "parser-state" })
  expect(headlessResult.assertions).toMatchObject([{ kind: "positive", observed: headlessResult.response }])

  const wrong = await probe.term!(app({ row: 2, col: 4 }))
  expect(wrong.observation).toMatchObject({ outcome: "unsupported", evidence: "query" })
  expect(wrong.assertions).toMatchObject([{ kind: "negative", observed: wrong.response }])
  expect((await probe.term!(app(null))).observation).toMatchObject({ outcome: "inconclusive", reason: "no-response" })
})

test("bottom-row cursor result uses measured headless height and does not guess an app height", async () => {
  const probe = byId("cursor.cud-past-bottom")
  const supported = probe.termless!(headless(0, 29, 30))
  expect(supported.observation).toMatchObject({ outcome: "supported", evidence: "parser-state" })
  const wrong = probe.termless!(headless(0, 23, 30))
  expect(wrong.observation).toMatchObject({ outcome: "unsupported", evidence: "parser-state" })
  expect(wrong.assertions).toMatchObject([{ kind: "negative", observed: wrong.response }])
  expect((await probe.term!(app({ row: 20, col: 1 }))).observation).toMatchObject({
    outcome: "inconclusive",
    reason: "insufficient-evidence",
  })
})

test("DSR position report distinguishes a valid wrong coordinate from malformed input", () => {
  const probe = byId("cursor.position-report")
  const misleading = probe.termless!(headless(0, 0, 24, "noise3;5R"))
  expect(misleading.observation).toMatchObject({ outcome: "inconclusive", reason: "invalid-reply", evidence: "query" })
  expect(misleading.assertions).toBeUndefined()
  const wrong = probe.termless!(headless(0, 0, 24, "\x1b[3;6R"))
  expect(wrong.observation).toMatchObject({ outcome: "unsupported", evidence: "query" })
  expect(wrong.assertions).toMatchObject([{ kind: "negative", observed: wrong.response }])
  expect(probe.termless!(headless(0, 0, 24, "\x1b[3;5R")).observation).toMatchObject({
    outcome: "supported",
    evidence: "query",
  })
  expect(probe.termless!(headless(0, 0)).observation).toMatchObject({
    outcome: "inconclusive",
    reason: "no-response",
  })
})

test("DECOM reports relative CPR but only absolute headless state proves the physical row", async () => {
  const probe = byId("cursor.cup-scroll-region")
  expect(probe.termless!(headless(0, 4)).observation).toMatchObject({
    outcome: "supported",
    evidence: "parser-state",
  })
  expect(probe.termless!(headless(0, 0)).observation).toMatchObject({
    outcome: "unsupported",
    evidence: "parser-state",
  })

  // DEC VT510 DECOM and CPR: https://vt100.net/mirror/mds-199909/cd3/term/vt510rmb.pdf
  // CPR row 1 is relative to the top margin. Ignoring DECOM can also produce 1;1.
  const writes: string[] = []
  const context = app({ row: 1, col: 1 })
  context.write = (data) => writes.push(data)
  expect((await probe.term!(context)).observation).toMatchObject({
    outcome: "inconclusive",
    reason: "insufficient-evidence",
    evidence: "query",
  })
  expect(writes.slice(-2)).toEqual(["\x1b[?6l", "\x1b[r"])
  expect((await probe.term!(app({ row: 5, col: 1 }))).observation).toMatchObject({
    outcome: "unsupported",
    evidence: "query",
  })

  const failing = app(null)
  const cleanup: string[] = []
  failing.write = (data) => cleanup.push(data)
  failing.queryCursorPosition = async () => {
    throw new Error("query failed")
  }
  await expect(probe.term!(failing)).rejects.toThrow("query failed")
  expect(cleanup.slice(-2)).toEqual(["\x1b[?6l", "\x1b[r"])
})

test("relative cursor probes establish their own origin after earlier moves", async () => {
  let row = 7
  let col = 7
  const writes: string[] = []
  const context = app(null)
  context.write = (sequence) => {
    writes.push(sequence)
    if (sequence === "\x1b[1;1H") {
      row = 1
      col = 1
    } else if (sequence === "ABC") {
      col += 3
    } else if (sequence === "\x1b[5C") {
      col += 5
    } else if (sequence === "\x1b[2D") {
      col = Math.max(1, col - 2)
    } else if (sequence === "\x1b[3B") {
      row += 3
    } else if (sequence === "\x1b[5B") {
      row += 5
    } else if (sequence === "\x1b[2A") {
      row = Math.max(1, row - 2)
    }
  }
  context.queryCursorPosition = async () => ({ row, col })

  for (const id of ["cursor.move.forward", "cursor.move.back", "cursor.move.down", "cursor.move.up"]) {
    const before = writes.length
    const result = await byId(id).term!(context)
    expect(result.observation, id).toMatchObject({ outcome: "supported", evidence: "query" })
    expect(writes.slice(before)[0], id).toBe("\x1b[1;1H")
  }
})

test("cursor movement qualifies setup before grading an ignored target", async () => {
  let row = 7
  let col = 7
  let ignore = "\x1b[1;1H"
  const ctx = app(null)
  ctx.write = (sequence) => {
    if (sequence === ignore) return
    if (sequence === "\x1b[1;1H") [row, col] = [1, 1]
    if (sequence === "ABC") col += 3
    if (sequence === "\x1b[2D") col = Math.max(1, col - 2)
  }
  ctx.queryCursorPosition = async () => ({ row, col })
  const back = byId("cursor.move.back")
  expect((await back.term!(ctx)).observation).toMatchObject({
    outcome: "inconclusive",
    reason: "insufficient-evidence",
  })

  ignore = "ABC"
  expect((await back.term!(ctx)).observation).toMatchObject({
    outcome: "inconclusive",
    reason: "insufficient-evidence",
  })

  ignore = "\x1b[2D"
  const failedMove = await back.term!(ctx)
  expect(failedMove.observation).toMatchObject({ outcome: "unsupported", evidence: "query" })
  expect(JSON.parse(failedMove.response ?? "")).toMatchObject({
    origin: { row: 1, col: 1 },
    setup: { row: 1, col: 4 },
    final: { row: 1, col: 4 },
  })
  expect(failedMove.assertions).toMatchObject([{ kind: "negative", observed: failedMove.response }])
})

test("missing CPR at origin, setup, or final cannot grade movement", async () => {
  for (const missingAt of [1, 2, 3]) {
    let calls = 0
    const ctx = app({ row: 1, col: 1 })
    ctx.queryCursorPosition = async () => (++calls === missingAt ? null : { row: 1, col: calls === 1 ? 1 : 4 })
    const result = await byId("cursor.move.back").term!(ctx)
    expect(result.observation, String(missingAt)).toMatchObject({ outcome: "inconclusive", reason: "no-response" })
    const raw: unknown = JSON.parse(result.response ?? "")
    expect(raw, String(missingAt)).toHaveProperty("origin")
    expect(raw, String(missingAt)).toHaveProperty("setup")
    expect(raw, String(missingAt)).toHaveProperty("final")
    expect(result.assertions).toBeUndefined()
  }
})

test("four-argument empty setup remains qualified, while unqualified setup is inconclusive", async () => {
  let row = 7
  let col = 7
  const ctx = app(null)
  ctx.write = (sequence) => {
    if (sequence === "\x1b[1;1H") [row, col] = [1, 1]
    if (sequence === "ABC") col += 3
    if (sequence === "\x1b[5;10H") [row, col] = [5, 10]
    if (sequence === "\x1b[2D") col = Math.max(1, col - 2)
  }
  ctx.queryCursorPosition = async () => ({ row, col })
  const absolute = cursorProbe("example.absolute", "", "\x1b[5;10H", { row: 4, col: 9 })
  expect((await absolute.term!(ctx)).observation).toMatchObject({ outcome: "supported" })
  const unqualified = cursorProbe("example.back", "ABC", "\x1b[2D", { row: 0, col: 1 })
  expect((await unqualified.term!(ctx)).observation).toMatchObject({
    outcome: "inconclusive",
    reason: "insufficient-evidence",
  })
})

test("headless cursor movement rejects ignored origin and setup, then measures an ignored target", () => {
  let x = 7
  let y = 7
  let ignore = "\x1b[1;1H"
  const ctx = headless(0, 0)
  ctx.feed = (sequence) => {
    if (sequence === ignore) return
    if (sequence === "\x1b[1;1H") [x, y] = [0, 0]
    if (sequence === "ABC") x += 3
    if (sequence === "\x1b[2D") x = Math.max(0, x - 2)
  }
  ctx.getCursor = () => ({ x, y, visible: true, style: null })
  const back = byId("cursor.move.back")
  expect(back.termless!(ctx).observation).toMatchObject({ outcome: "inconclusive", reason: "insufficient-evidence" })
  ignore = "ABC"
  expect(back.termless!(ctx).observation).toMatchObject({ outcome: "inconclusive", reason: "insufficient-evidence" })
  ignore = "\x1b[2D"
  const result = back.termless!(ctx)
  expect(result.observation).toMatchObject({ outcome: "unsupported", evidence: "parser-state" })
  expect(JSON.parse(result.response ?? "")).toMatchObject({
    origin: { x: 0, y: 0 },
    setup: { x: 3, y: 0 },
    final: { x: 3, y: 0 },
  })
  expect(result.assertions).toMatchObject([{ kind: "negative", observed: result.response }])
})

// The same result must not be selected from a guessed 80-column bound.
test("cursor geometry declarations include the factory and direct CUP", () => {
  for (const id of [
    "cursor.move.absolute",
    "cursor.move.home",
    "cursor.move.forward",
    "cursor.move.back",
    "cursor.move.down",
    "cursor.move.up",
    "cursor.cup-boundaries",
  ]) {
    expect(byId(id).termNeedsGeometry, id).toBe(true)
  }
})

test("CUP qualifies the measured 24x61 edge, then distinguishes clamp from ignored target", async () => {
  const probe = byId("cursor.cup-boundaries")
  for (const ignoreTarget of [false, true]) {
    let position = { row: 7, col: 7 }
    const writes: string[] = []
    const context = app(null)
    context.rows = 24
    context.cols = 61
    context.write = (sequence) => {
      writes.push(sequence)
      if (sequence === "\x1b[1;1H") position = { row: 1, col: 1 }
      if (sequence === "\x1b[24;61H") position = { row: 24, col: 61 }
      if (sequence === "\x1b[999;999H" && !ignoreTarget) position = { row: 24, col: 61 }
    }
    context.queryCursorPosition = async () => position
    const result = await probe.term!(context)
    expect(writes).toEqual(["\x1b[1;1H", "\x1b[24;61H", "\x1b[1;1H", "\x1b[999;999H"])
    expect(result.observation).toMatchObject({ outcome: ignoreTarget ? "unsupported" : "supported", evidence: "query" })
    expect(JSON.parse(result.response ?? "")).toMatchObject({
      origin: { row: 1, col: 1 },
      edge: { row: 24, col: 61 },
      beforeTarget: { row: 1, col: 1 },
      final: ignoreTarget ? { row: 1, col: 1 } : { row: 24, col: 61 },
    })
    expect(result.assertions).toMatchObject([
      { kind: ignoreTarget ? "negative" : "positive", observed: result.response },
    ])
  }
})

test("CUP chooses a target outside a grid larger than 999 cells", async () => {
  let position = { row: 1, col: 1 }
  const context = app(null)
  context.rows = 1000
  context.cols = 1001
  const writes: string[] = []
  context.write = (sequence) => {
    writes.push(sequence)
    if (sequence === "\x1b[1;1H") position = { row: 1, col: 1 }
    if (sequence === "\x1b[1000;1001H" || sequence === "\x1b[1001;1002H") position = { row: 1000, col: 1001 }
  }
  context.queryCursorPosition = async () => position
  const result = await byId("cursor.cup-boundaries").term!(context)
  expect(writes.at(-1)).toBe("\x1b[1001;1002H")
  expect(result.observation).toMatchObject({ outcome: "supported", evidence: "query" })
})

test("CUP declines a too-small grid or an unqualified edge", async () => {
  const probe = byId("cursor.cup-boundaries")
  const writes: string[] = []
  const small = app({ row: 1, col: 1 })
  small.rows = 1
  small.cols = 1
  small.write = (sequence) => writes.push(sequence)
  expect((await probe.term!(small)).observation).toMatchObject({
    outcome: "inconclusive",
    reason: "insufficient-evidence",
    evidence: "none",
  })
  expect(writes).toEqual([])
  const ignoredEdge = app({ row: 1, col: 1 })
  ignoredEdge.cols = 61
  expect((await probe.term!(ignoredEdge)).observation).toMatchObject({
    outcome: "inconclusive",
    reason: "insufficient-evidence",
  })
})

test("cursor factory declines an undersized setup before the origin write", async () => {
  const writes: string[] = []
  const context = app({ row: 1, col: 1 })
  context.rows = 4
  context.cols = 9
  context.write = (sequence) => writes.push(sequence)
  const result = await byId("cursor.move.absolute").term!(context)
  expect(result.observation).toMatchObject({
    outcome: "inconclusive",
    reason: "insufficient-evidence",
    evidence: "none",
  })
  expect(writes).toEqual([])
})
