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

test("cursor shape without style readback and reverse-wrap CPR remain ungraded", async () => {
  const shape = byId("cursor.shape").termless!(headless(0, 0))
  expect(shape.observation).toMatchObject({
    outcome: "inconclusive",
    reason: "insufficient-evidence",
    evidence: "parser-state",
  })
  expect(shape.assertions).toBeUndefined()

  const appShape = await byId("cursor.shape").term!(app({ row: 1, col: 1 }))
  expect(appShape.observation).toMatchObject({ outcome: "inconclusive", evidence: "none" })
  expect(appShape.assertions).toBeUndefined()

  const reverse = await byId("cursor.reverse-wrap").term!(app({ row: 1, col: 80 }))
  expect(reverse.observation).toMatchObject({ outcome: "inconclusive", evidence: "query" })
  expect(reverse.assertions).toBeUndefined()
})

test("reverse-wrap needs two rows and a measured wrap before backspace", () => {
  const probe = byId("cursor.reverse-wrap")
  const writes: string[] = []
  const context = { ...headless(3, 0, 1), cols: 4 }
  context.feed = (sequence) => {
    writes.push(sequence)
  }
  expect(probe.termless!(context).observation).toMatchObject({ outcome: "inconclusive" })
  expect(writes).toEqual([])

  const twoRows = { ...headless(3, 0, 2), cols: 4 }
  twoRows.getCursor = () => ({ x: 3, y: 0, visible: true, style: null })
  expect(probe.termless!(twoRows).observation).toMatchObject({ outcome: "inconclusive", evidence: "parser-state" })
})

test("reverse-wrap retains support after a measured second-row displacement", () => {
  const probe = byId("cursor.reverse-wrap")
  const context = { ...headless(0, 0, 2), cols: 4 }
  let position = { x: 0, y: 0 }
  context.feed = (sequence) => {
    if (sequence === "\x1b[H") position = { x: 0, y: 0 }
    if (sequence === "AAAAB") position = { x: 1, y: 1 }
    if (sequence === "\x08\x08") position = { x: 3, y: 0 }
  }
  context.getCursor = () => ({ ...position, visible: true, style: null })
  const result = probe.termless!(context)
  expect(result.observation).toMatchObject({ outcome: "supported", evidence: "parser-state" })
  expect(result.assertions).toMatchObject([{ kind: "positive", observed: result.response }])
})

test.each([
  { initial: true, fault: "none", outcome: "supported" },
  { initial: false, fault: "none", outcome: "supported" },
  { initial: true, fault: "ignore-hide", outcome: "unsupported" },
  { initial: false, fault: "ignore-show", outcome: "inconclusive" },
  { initial: true, fault: "ignore-restore", outcome: "inconclusive" },
  { initial: true, fault: "missing-target", outcome: "inconclusive" },
  { initial: null, fault: "none", outcome: "inconclusive" },
])("cursor visibility qualifies its control and restores $initial after $fault", ({ initial, fault, outcome }) => {
  const context = headless(0, 0)
  let visible: boolean | null = initial
  const writes: string[] = []
  context.feed = (sequence) => {
    writes.push(sequence)
    if (sequence === "\x1b[?25h" && fault !== "ignore-show" && !(fault === "ignore-restore" && writes.length > 1)) {
      visible = true
    }
    if (sequence === "\x1b[?25l" && fault !== "ignore-hide") visible = fault === "missing-target" ? null : false
  }
  context.getCursor = () => ({ x: 0, y: 0, visible, style: null })
  const result = byId("cursor.hide").termless!(context)
  expect(result.observation).toMatchObject({ outcome, evidence: "parser-state" })
  if (outcome === "inconclusive") {
    expect(result.observation?.reason).toBe("insufficient-evidence")
    expect(result.assertions).toBeUndefined()
  } else {
    expect(result.assertions).toMatchObject([
      { kind: outcome === "supported" ? "positive" : "negative", observed: result.response },
    ])
    expect(JSON.parse(result.response ?? "")).toMatchObject({
      before: initial,
      shown: true,
      hidden: outcome !== "supported",
    })
  }
  if (initial === null) expect(writes).toEqual([])
  else expect(writes.at(-1)).toBe(initial ? "\x1b[?25h" : "\x1b[?25l")
  expect(visible).toBe(fault === "ignore-restore" ? false : initial)
})

test("cursor visibility restores its measured initial state when the hide write throws", () => {
  const context = headless(0, 0)
  const writes: string[] = []
  context.feed = (sequence) => {
    writes.push(sequence)
    if (sequence === "\x1b[?25l") throw new Error("hide write failed")
  }
  expect(() => byId("cursor.hide").termless!(context)).toThrow("hide write failed")
  expect(writes.at(-1)).toBe("\x1b[?25h")
})

test("cursor save/restore records the mismatched position and a missing app reply stays inconclusive", async () => {
  const probe = byId("cursor.ansi-save")
  const headlessContext = headless(0, 0)
  let position = { x: 0, y: 0 }
  let saved = { x: 0, y: 0 }
  headlessContext.feed = (sequence) => {
    if (sequence === "\x1b[3;5H") position = { x: 4, y: 2 }
    if (sequence === "\x1b[10;15H") position = { x: 14, y: 9 }
    if (sequence === "\x1b[s") saved = { ...position }
    if (sequence === "\x1b[u") position = { ...saved }
  }
  headlessContext.getCursor = () => ({ ...position, visible: true, style: null })
  const headlessResult = probe.termless!(headlessContext)
  expect(headlessResult.observation).toMatchObject({ outcome: "supported", evidence: "parser-state" })
  expect(headlessResult.assertions).toMatchObject([{ kind: "positive", observed: headlessResult.response }])

  let appPosition = { row: 1, col: 1 }
  const wrongContext = app(null)
  wrongContext.write = (sequence) => {
    if (sequence === "\x1b[3;5H") appPosition = { row: 3, col: 5 }
    if (sequence === "\x1b[10;15H") appPosition = { row: 10, col: 15 }
  }
  wrongContext.queryCursorPosition = async () => appPosition
  const wrong = await probe.term!(wrongContext)
  expect(wrong.observation).toMatchObject({ outcome: "unsupported", evidence: "query" })
  expect(wrong.assertions).toMatchObject([{ kind: "negative", observed: wrong.response }])
  expect(JSON.parse(wrong.response ?? "")).toMatchObject({
    setup: { row: 3, col: 5 },
    displaced: { row: 10, col: 15 },
    final: { row: 10, col: 15 },
  })
  expect((await probe.term!(app(null))).observation).toMatchObject({ outcome: "inconclusive", reason: "no-response" })
})

test("bottom-row cursor result uses measured headless height and does not guess an app height", async () => {
  const probe = byId("cursor.cud-past-bottom")
  for (const targetY of [29, 23]) {
    const context = headless(0, 0, 30)
    let position = { x: 7, y: 7 }
    context.feed = (sequence) => {
      if (sequence === "\x1b[1;1H") position = { x: 0, y: 0 }
      if (sequence === "\x1b[999B") position = { x: 0, y: targetY }
    }
    context.getCursor = () => ({ ...position, visible: true, style: null })
    const result = probe.termless!(context)
    expect(result.observation).toMatchObject({
      outcome: targetY === 29 ? "supported" : "unsupported",
      evidence: "parser-state",
    })
    expect(result.observation?.note).toBeUndefined()
    expect(result.assertions).toMatchObject([
      { kind: targetY === 29 ? "positive" : "negative", observed: result.response },
    ])
  }
  const invalid = headless(0, 0, 30)
  let invalidPosition = { x: 0, y: 0 }
  invalid.feed = (sequence) => {
    if (sequence === "\x1b[999B") invalidPosition = { x: 0, y: Number.NaN }
  }
  invalid.getCursor = () => ({ ...invalidPosition, visible: true, style: null })
  const invalidResult = probe.termless!(invalid)
  expect(invalidResult.observation).toMatchObject({
    outcome: "inconclusive",
    reason: "insufficient-evidence",
    evidence: "parser-state",
    note: "CUD target cursor readback is invalid",
  })
  expect(invalidResult.assertions).toBeUndefined()
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
  expect(wrong.observation).toMatchObject({
    outcome: "inconclusive",
    reason: "insufficient-evidence",
    evidence: "query",
  })
  const qualified = headless(4, 2, 24, "\x1b[3;6R")
  expect(probe.termless!(qualified).observation).toMatchObject({ outcome: "unsupported", evidence: "query" })
  qualified.feedCapture = () => "\x1b[3;5R"
  expect(probe.termless!(qualified).observation).toMatchObject({
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
    outcome: "inconclusive",
    reason: "insufficient-evidence",
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

  const reverseWrap = byId("cursor.reverse-wrap")
  const reverseFailing = app(null)
  const reverseCleanup: string[] = []
  reverseFailing.write = (data) => reverseCleanup.push(data)
  reverseFailing.queryCursorPosition = async () => {
    throw new Error("query failed")
  }
  await expect(reverseWrap.term!(reverseFailing)).rejects.toThrow("query failed")
  expect(reverseCleanup).toEqual(["\x1b[?45h", "\x1b[?45l"])
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

test("headless CUP qualifies a nonstandard grid before grading an out-of-bounds target", () => {
  const probe = byId("cursor.cup-boundaries")
  for (const ignoredTarget of [false, true]) {
    let position = { x: 8, y: 6 }
    const feeds: string[] = []
    const context = { ...headless(0, 0, 37), cols: 61 }
    context.feed = (sequence) => {
      feeds.push(sequence)
      if (sequence === "\x1b[1;1H") position = { x: 0, y: 0 }
      if (sequence === "\x1b[37;61H") position = { x: 60, y: 36 }
      if (sequence === "\x1b[999;999H" && !ignoredTarget) position = { x: 60, y: 36 }
    }
    context.getCursor = () => ({ ...position, visible: true, style: null })
    const result = probe.termless!(context)
    expect(feeds).toEqual(["\x1b[1;1H", "\x1b[37;61H", "\x1b[1;1H", "\x1b[999;999H"])
    expect(result.observation).toMatchObject({
      outcome: ignoredTarget ? "unsupported" : "supported",
      evidence: "parser-state",
    })
    expect(JSON.parse(result.response ?? "")).toMatchObject({
      rows: 37,
      cols: 61,
      origin: { x: 0, y: 0 },
      edge: { x: 60, y: 36 },
      beforeTarget: { x: 0, y: 0 },
      final: ignoredTarget ? { x: 0, y: 0 } : { x: 60, y: 36 },
    })
    expect(result.assertions).toMatchObject([
      { kind: ignoredTarget ? "negative" : "positive", observed: result.response },
    ])
  }
})

test("headless CUP does not grade missing geometry or an ignored edge control", () => {
  const probe = byId("cursor.cup-boundaries")
  const missing = headless(0, 0, 0)
  const feeds: string[] = []
  missing.feed = (sequence) => feeds.push(sequence)
  expect(probe.termless!(missing).observation).toMatchObject({
    outcome: "inconclusive",
    reason: "insufficient-evidence",
  })
  expect(feeds).toEqual([])
  const ignored = { ...headless(0, 0, 37), cols: 61 }
  ignored.feed = (sequence) => feeds.push(sequence)
  expect(probe.termless!(ignored).observation).toMatchObject({
    outcome: "inconclusive",
    reason: "insufficient-evidence",
  })
  expect(feeds).toEqual(["\x1b[1;1H", "\x1b[37;61H"])
})

test("remaining app cursor fixtures refuse undersized geometry without writing", async () => {
  const fixtures = [
    ["cursor.horizontal-absolute", 3, 15],
    ["cursor.next-line", 4, 5],
    ["cursor.position-report", 3, 5],
    ["cursor.ansi-save", 10, 15],
    ["cursor.ansi-restore", 12, 18],
    ["cursor.save-restore", 10, 10],
    ["cursor.cuu-past-top", 4, 1],
    ["cursor.cud-past-bottom", 2, 1],
    ["cursor.vpa", 10, 5],
    ["cursor.cpl", 6, 10],
    ["cursor.hpa", 3, 15],
    ["cursor.cup-scroll-region", 15, 1],
  ] as const
  for (const [id, rows, cols] of fixtures) {
    const context = app({ row: 1, col: 1 })
    context.rows = rows > 1 ? rows - 1 : rows
    context.cols = rows > 1 ? cols : cols - 1
    const writes: string[] = []
    context.write = (sequence) => writes.push(sequence)
    const definition = byId(id)
    expect(definition.termNeedsGeometry, id).toBe(true)
    expect((await definition.term!(context)).observation, id).toMatchObject({
      outcome: "inconclusive",
      reason: "insufficient-evidence",
      evidence: "none",
    })
    expect(writes, id).toEqual([])
  }
})

test("direct cursor movement does not grade a target when its setup CUP was ignored", async () => {
  for (const [id, target] of [
    ["cursor.horizontal-absolute", { row: 3, col: 15 }],
    ["cursor.next-line", { row: 4, col: 1 }],
    ["cursor.cuu-past-top", { row: 1, col: 1 }],
    ["cursor.vpa", { row: 10, col: 5 }],
    ["cursor.cpl", { row: 4, col: 1 }],
    ["cursor.hpa", { row: 3, col: 15 }],
  ] as const) {
    const context = app(target)
    const result = await byId(id).term!(context)
    expect(result.observation, id).toMatchObject({ outcome: "inconclusive", reason: "insufficient-evidence" })
    expect(JSON.parse(result.response ?? ""), id).toHaveProperty("setup")
  }
})

test("save and restore require a measured displaced cursor before crediting restore", async () => {
  for (const id of ["cursor.ansi-save", "cursor.ansi-restore", "cursor.save-restore"]) {
    const context = app({ row: id === "cursor.ansi-restore" ? 4 : 3, col: id === "cursor.ansi-restore" ? 6 : 5 })
    const result = await byId(id).term!(context)
    expect(result.observation, id).toMatchObject({ outcome: "inconclusive", reason: "insufficient-evidence" })
    expect(JSON.parse(result.response ?? ""), id).toHaveProperty("displaced")
  }
})

test("position report and relative scroll-region CPR cannot independently prove setup", async () => {
  expect((await byId("cursor.position-report").term!(app({ row: 3, col: 6 }))).observation).toMatchObject({
    outcome: "inconclusive",
    reason: "insufficient-evidence",
  })
  expect((await byId("cursor.cup-scroll-region").term!(app({ row: 5, col: 1 }))).observation).toMatchObject({
    outcome: "inconclusive",
    reason: "insufficient-evidence",
  })
})

test("headless CUD qualifies home and targets beyond an initialized grid over 999 rows", () => {
  const context = headless(0, 0, 1001)
  const feeds: string[] = []
  let position = { x: 7, y: 9 }
  context.feed = (sequence) => {
    feeds.push(sequence)
    if (sequence === "\x1b[1;1H") position = { x: 0, y: 0 }
    if (sequence === "\x1b[1002B") position = { x: 0, y: 1000 }
  }
  context.getCursor = () => ({ ...position, visible: true, style: null })
  const result = byId("cursor.cud-past-bottom").termless!(context)
  expect(feeds).toEqual(["\x1b[1;1H", "\x1b[1002B"])
  expect(result.observation).toMatchObject({ outcome: "supported", evidence: "parser-state" })
  expect(JSON.parse(result.response ?? "")).toMatchObject({ origin: { x: 0, y: 0 }, final: { x: 0, y: 1000 } })
})

// A fixed 999-row move cannot reach the bottom of a taller measured app grid.
test("app CUD verifies home and uses a move beyond the measured row count without grading", async () => {
  const probe = byId("cursor.cud-past-bottom")
  const writes: string[] = []
  const context = app(null)
  context.rows = 1001
  context.write = (sequence) => writes.push(sequence)
  let replies = [
    { row: 1, col: 1 },
    { row: 1001, col: 1 },
  ]
  context.queryCursorPosition = async () => replies.shift() ?? null
  const result = await probe.term!(context)
  expect(writes).toEqual(["\x1b[1;1H", "\x1b[1002B"])
  expect(result.observation).toMatchObject({ outcome: "inconclusive", reason: "insufficient-evidence" })
  expect(JSON.parse(result.response ?? "")).toMatchObject({ origin: { row: 1, col: 1 }, final: { row: 1001, col: 1 } })

  writes.length = 0
  replies = [{ row: 4, col: 1 }]
  const unqualified = await probe.term!(context)
  expect(writes).toEqual(["\x1b[1;1H"])
  expect(unqualified.observation).toMatchObject({ outcome: "inconclusive", reason: "insufficient-evidence" })
})

test("app CUP refuses nonfinite geometry before a feature write", async () => {
  const probe = byId("cursor.cup-boundaries")
  for (const rows of [Number.NaN, Number.POSITIVE_INFINITY]) {
    const writes: string[] = []
    const context = app(null)
    context.rows = rows
    context.write = (sequence) => writes.push(sequence)
    const result = await probe.term!(context)
    expect(result.observation).toMatchObject({
      outcome: "inconclusive",
      reason: "insufficient-evidence",
      evidence: "none",
    })
    expect(writes).toEqual([])
  }
})
