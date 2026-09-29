/**
 * @failure Erasure is credited without preserved controls, or a failed cursor setup is blamed on a compliant erase.
 * @level l1
 * @consumer Headless and app erase observations projected into terminal support cells.
 * @testonly none
 */
import { expect, test } from "vitest"
import { eraseProbes } from "./erase.ts"
import type { TermContext, TermlessContext } from "./types.ts"

const ids = ["erase.line.right", "erase.line.left", "erase.line.all", "erase.character"] as const
const screenIds = ["erase.screen.below", "erase.screen.above", "erase.screen.all"] as const

function byId(id: (typeof ids)[number] | (typeof screenIds)[number]) {
  const probe = eraseProbes.find((item) => item.id === id)
  if (!probe?.termless || !probe.term) throw new Error(`missing erase callbacks for ${id}`)
  return probe
}

type ScreenRows = readonly [string, string, string]

function screenHeadless(
  after: ScreenRows,
  options: {
    before?: ScreenRows
    cursorBefore?: { x: number; y: number }
    cursorAfter?: { x: number; y: number }
    missing?: { row: number; col: number }
    historyBefore?: number
    historyAfter?: number
  } = {},
): TermlessContext {
  const base = headless("ABCDE")
  const before = options.before ?? (["AAAAA", "BBBBB", "CCCCC"] as const)
  let erased = false
  return {
    ...base,
    feed(sequence) {
      if (/^\x1b\[[012]J$/.test(sequence)) erased = true
    },
    getCell(row, col) {
      const char =
        erased && options.missing?.row === row && options.missing.col === col
          ? undefined
          : ((erased ? after : before)[row]?.[col] ?? "")
      return { ...base.getCell(0, 0), char: char as string }
    },
    getCursor: () => {
      const cursor = erased ? (options.cursorAfter ?? options.cursorBefore) : options.cursorBefore
      return { x: cursor?.x ?? 2, y: cursor?.y ?? 1, visible: true, style: null }
    },
    getScrollback: () => ({
      viewportOffset: 0,
      screenLines: 3,
      totalLines: erased ? (options.historyAfter ?? options.historyBefore ?? 4) : (options.historyBefore ?? 4),
    }),
  }
}

function headless(
  after: string,
  adjacentAfter = "KEEP!",
  missingCell?: number,
  ignoreCursorSetup = false,
): TermlessContext {
  let erased = false
  let cursorX = 5
  const before = ["ABCDE", "KEEP!"]
  const afterRows = [after, adjacentAfter]
  return {
    cols: 80,
    feed(sequence) {
      if (!ignoreCursorSetup) {
        if (sequence.includes("\x1b[3G") || sequence.includes("\x1b[1;3H")) cursorX = 2
        else if (sequence.includes("\x1b[1G")) cursorX = 0
      }
      if (/\x1b\[(?:K|0K|1K|2K|3X)/.test(sequence)) erased = true
    },
    feedCapture: () => "",
    getCell(row, col) {
      const text = (erased ? afterRows : before)[row] ?? ""
      // A backend that cannot report one cell cannot prove erasure.
      const char = erased && row === 0 && col === missingCell ? undefined : (text[col] ?? "")
      return {
        char: char as string,
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
      }
    },
    getCursor: () => ({ x: cursorX, y: 0, visible: true, style: null }),
    getMode: () => false,
    getText: () => "",
    getScrollback: () => ({ viewportOffset: 0, totalLines: 24, screenLines: 24 }),
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
  }
}

test.each([
  ["erase.line.right", "AB   ", "A    ", "  CDE"],
  ["erase.line.left", "   DE", "    E", "AB   "],
  ["erase.line.all", "     ", "   DE", "AB   "],
  ["erase.character", "   DE", "    E", "AB   "],
] as const)("%s binds exact erased and preserved cells to its observation", (id, expected, overErase, wrongSide) => {
  const probe = byId(id)
  const supported = probe.termless!(headless(expected))
  expect(supported.observation).toMatchObject({ outcome: "supported", evidence: "parser-state" })
  expect(supported.response).toBeTruthy()
  expect(supported.assertions).toMatchObject([{ kind: "positive", observed: supported.response }])
  const raw: unknown = JSON.parse(supported.response ?? "")
  expect(raw).toMatchObject({ before: "ABCDE".split(""), after: expected.split("") })
  if (id !== "erase.line.all") {
    expect(raw).toMatchObject({ cursorBefore: { x: id === "erase.character" ? 0 : 2, y: 0 } })
  }

  for (const actual of ["ABCDE", overErase, wrongSide]) {
    if (actual === expected) continue
    const unsupported = probe.termless!(headless(actual))
    expect(unsupported.observation).toMatchObject({ outcome: "unsupported", evidence: "parser-state" })
    expect(unsupported.assertions).toMatchObject([{ kind: "negative", observed: unsupported.response }])
  }

  const missing = probe.termless!(headless(expected, "KEEP!", 2))
  expect(missing.observation).toMatchObject({
    outcome: "inconclusive",
    reason: "insufficient-evidence",
  })
  expect(missing.assertions).toBeUndefined()
})

test.each([
  ["erase.line.right", "ABCDE"],
  ["erase.line.left", "     "],
  ["erase.character", "ABCDE"],
] as const)("%s does not blame erasure when CHA setup is ignored", (id, actual) => {
  const result = byId(id).termless!(headless(actual, "KEEP!", undefined, true))
  expect(result.observation).toMatchObject({ outcome: "inconclusive", reason: "insufficient-evidence" })
  expect(result.assertions).toBeUndefined()
  const raw: unknown = JSON.parse(result.response ?? "")
  expect(raw).toMatchObject({ cursorBefore: { x: 5, y: 0 } })
})

test("EL 2 preserves a neighboring row, while app CPR only reports responsiveness", async () => {
  const el2 = byId("erase.line.all")
  expect(el2.termless!(headless("     ", "GONE!")).observation).toMatchObject({
    outcome: "unsupported",
    evidence: "parser-state",
  })
  for (const id of ids) {
    expect((await byId(id).term!(app({ row: 1, col: 3 }))).observation).toMatchObject({
      outcome: "inconclusive",
      reason: "insufficient-evidence",
    })
    expect((await byId(id).term!(app(null))).observation).toMatchObject({
      outcome: "inconclusive",
      reason: "no-response",
    })
  }
})

// ED0/1/2 act on screen cells, which the earlier EL/ECH row fixtures never inspect.
test.each([
  ["erase.screen.below", ["AAAAA", "BB   ", "     "], ["     ", "BBBBB", "CCCCC"], ["AAAAA", "   BB", "CCCCC"]],
  ["erase.screen.above", ["     ", "   BB", "CCCCC"], ["AAAAA", "BBBBB", "     "], ["AAAAA", "BB   ", "CCCCC"]],
  ["erase.screen.all", ["     ", "     ", "     "], ["AAAAA", "BBBBB", "CCCCC"], ["AAAAA", "     ", "CCCCC"]],
] as const)("%s requires exact erased cells and preserved controls", (id, expected, ignored, wrongSide) => {
  const probe = byId(id)
  const supported = probe.termless!(screenHeadless(expected))
  expect(supported.observation).toMatchObject({ outcome: "supported", evidence: "parser-state" })
  expect(supported.assertions).toMatchObject([{ kind: "positive", observed: supported.response }])
  const raw: unknown = JSON.parse(supported.response ?? "")
  expect(raw).toMatchObject({
    before: ["AAAAA", "BBBBB", "CCCCC"].map((row) => row.split("")),
    after: expected.map((row) => row.split("")),
    cursorBefore: { x: 2, y: 1 },
    cursorAfter: { x: 2, y: 1 },
  })
  for (const actual of [ignored, wrongSide, ["     ", "     ", "     "] as const]) {
    if (actual.join("") === expected.join("")) continue
    const result = probe.termless!(screenHeadless(actual))
    expect(result.observation).toMatchObject({ outcome: "unsupported", evidence: "parser-state" })
    expect(result.assertions).toMatchObject([{ kind: "negative", observed: result.response }])
  }
})

test.each(screenIds)("%s refuses incomplete fixture or cell readback", (id) => {
  const expected: ScreenRows =
    id === "erase.screen.below"
      ? ["AAAAA", "BB   ", "     "]
      : id === "erase.screen.above"
        ? ["     ", "   BB", "CCCCC"]
        : ["     ", "     ", "     "]
  const probe = byId(id)
  for (const context of [
    screenHeadless(expected, { before: ["AAAAA", "XXXXX", "CCCCC"] }),
    screenHeadless(expected, { cursorBefore: { x: 0, y: 1 } }),
    screenHeadless(expected, { missing: { row: 1, col: 2 } }),
  ]) {
    const result = probe.termless!(context)
    expect(result.observation).toMatchObject({ outcome: "inconclusive", reason: "insufficient-evidence" })
    expect(result.assertions).toBeUndefined()
  }
})

test("ED2 retains scrollback changes as raw context, and app CPR never proves erased pixels", async () => {
  const all = byId("erase.screen.all")
  const historyChanged = all.termless!(screenHeadless(["     ", "     ", "     "], { historyAfter: 3 }))
  expect(historyChanged.observation).toMatchObject({ outcome: "supported", evidence: "parser-state" })
  expect(JSON.parse(historyChanged.response ?? "") as unknown).toMatchObject({
    scrollbackBefore: { totalLines: 4 },
    scrollbackAfter: { totalLines: 3 },
  })
  for (const id of screenIds) {
    expect((await byId(id).term!(app({ row: 2, col: 3 }))).observation).toMatchObject({
      outcome: "inconclusive",
      reason: "insufficient-evidence",
    })
    expect((await byId(id).term!(app(null))).observation).toMatchObject({
      outcome: "inconclusive",
      reason: "no-response",
    })
  }
})

// Alacritty 0.26's retained raw result blanked these rows while history grew 24 to 48.
// The earlier fixed-history fixtures could not catch that false unsupported conclusion.
test("ED2 accepts erased cells and preserved cursor with growing history", () => {
  const result = byId("erase.screen.all").termless!(
    screenHeadless(["     ", "     ", "     "], { historyBefore: 24, historyAfter: 48 }),
  )
  const state = JSON.parse(result.response ?? "") as {
    before: string[][]
    after: string[][]
    cursorBefore: { x: number; y: number }
    cursorAfter: { x: number; y: number }
    scrollbackBefore: { totalLines: number }
    scrollbackAfter: { totalLines: number }
  }
  expect(state.before).toEqual(["AAAAA", "BBBBB", "CCCCC"].map((row) => row.split("")))
  expect(state.after).toEqual(["     ", "     ", "     "].map((row) => row.split("")))
  expect(state.cursorAfter).toEqual(state.cursorBefore)
  expect(state.scrollbackBefore.totalLines).toBe(24)
  expect(state.scrollbackAfter.totalLines).toBe(48)
  expect(result.observation).toMatchObject({ outcome: "supported", evidence: "parser-state" })
  expect(result.assertions).toMatchObject([{ kind: "positive", observed: result.response }])
})

// ED0/1 specify which displayed cells are erased. A backend's numeric history
// growth is retained as context, but cannot turn correct erasure into a failure.
test.each([
  ["erase.screen.below", ["AAAAA", "BB   ", "     "]],
  ["erase.screen.above", ["     ", "   BB", "CCCCC"]],
] as const)("%s grades cells and cursor even when numeric history grows", (id, expected) => {
  const correct = byId(id).termless!(screenHeadless(expected, { historyBefore: 24, historyAfter: 48 }))
  expect(correct.observation).toMatchObject({ outcome: "supported", evidence: "parser-state" })
  expect(correct.assertions).toMatchObject([{ kind: "positive", observed: correct.response }])
  expect(JSON.parse(correct.response ?? "") as unknown).toMatchObject({
    before: ["AAAAA", "BBBBB", "CCCCC"].map((row) => row.split("")),
    after: expected.map((row) => row.split("")),
    cursorBefore: { x: 2, y: 1 },
    cursorAfter: { x: 2, y: 1 },
    scrollbackBefore: { totalLines: 24 },
    scrollbackAfter: { totalLines: 48 },
  })

  const ignored = byId(id).termless!(
    screenHeadless(["AAAAA", "BBBBB", "CCCCC"], { historyBefore: 24, historyAfter: 48 }),
  )
  expect(ignored.observation).toMatchObject({ outcome: "unsupported", evidence: "parser-state" })
  expect(ignored.assertions).toMatchObject([{ kind: "negative", observed: ignored.response }])
})
