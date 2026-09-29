/**
 * @failure Erasure is credited without preserved controls, or a failed cursor setup is blamed on a compliant erase.
 * @level l1
 * @consumer Headless and app erase observations projected into terminal support cells.
 * @testonly none
 */
import { expect, test } from "vitest"
import { eraseProbes } from "./erase.ts"
import { editingProbes } from "./editing.ts"
import type { TermContext, TermlessContext } from "./types.ts"

const ids = ["erase.line.right", "erase.line.left", "erase.line.all", "erase.character"] as const
const screenIds = ["erase.screen.below", "erase.screen.above", "erase.screen.all"] as const

function byId(id: string) {
  const probe = eraseProbes.find((item) => item.id === id)
  if (!probe?.termless || !probe.term) throw new Error(`missing erase callbacks for ${id}`)
  return { ...probe, term: probe.term, termless: probe.termless }
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
    rows: 24,
  }
}

// Existing cell assertions exercise full-size fixtures; they cannot catch app
// writes that wrap or clamp before an undersized fixture has been declined.
test.each([
  ["erase.line.right", 1, 6],
  ["erase.line.left", 1, 6],
  ["erase.line.all", 1, 6],
  ["erase.screen.below", 5, 5],
  ["erase.screen.above", 5, 5],
  ["erase.screen.all", 5, 5],
  ["erase.screen.scrollback", 5, 5],
  ["erase.character", 1, 6],
  ["erase.selective", 1, 6],
  ["erase.el-with-attrs", 1, 6],
  ["erase.ed-scroll-region", 10, 10],
] as const)("%s declines undersized app fixtures before any terminal I/O", async (id, rows, cols) => {
  const probe = byId(id)
  for (const [measuredRows, measuredCols] of [
    [rows - 1, cols],
    [rows, cols - 1],
    [NaN, cols],
    [rows, Infinity],
  ]) {
    const io: string[] = []
    const result = await probe.term({
      ...app({ row: 1, col: 1 }),
      rows: measuredRows!,
      cols: measuredCols!,
      write: (sequence) => io.push(sequence),
      queryCursorPosition: async () => {
        io.push("CPR")
        return { row: 1, col: 1 }
      },
    })
    expect(result.observation).toMatchObject({
      outcome: "inconclusive",
      reason: "insufficient-evidence",
      evidence: "none",
    })
    expect(io).toEqual([])
  }
  expect(probe.termNeedsGeometry).toBe(true)
  const writes: string[] = []
  const result = await probe.term({
    ...app({ row: 1, col: 1 }),
    rows,
    cols,
    write: (sequence) => writes.push(sequence),
  })
  expect(writes.length).toBeGreaterThan(0)
  expect(result.observation?.evidence).not.toBe("none")
  expect(result.observation?.outcome).not.toBe("supported")
})

test.each([
  ["erase.el-with-attrs", "\x1b[42m", "\x1b[0m"],
  ["erase.ed-scroll-region", "\x1b[3;10r", "\x1b[r"],
] as const)("%s restores its changed fixture after a write error", async (id, change, restore) => {
  const writes: string[] = []
  let changed = false
  let failed = false
  const failure = new Error("fixture write failed")
  await expect(
    byId(id).term({
      ...app({ row: 1, col: 1 }),
      write(sequence) {
        writes.push(sequence)
        if (changed && !failed) {
          failed = true
          throw failure
        }
        if (sequence === change) changed = true
      },
    }),
  ).rejects.toBe(failure)
  expect(writes.at(-1)).toBe(restore)
})

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

// A responsive terminal can ignore erasure entirely. CPR alone cannot establish
// changed cells, background preservation, or cleared scrollback.
test("every app erase keeps cursor-only evidence inconclusive", async () => {
  for (const definition of eraseProbes) {
    const probe = byId(definition.id)
    for (const position of [{ row: 5, col: 5 }, null]) {
      const result = await probe.term(app(position))
      expect(result.pass, definition.id).toBe(false)
      expect(result.observation, definition.id).toMatchObject({
        outcome: "inconclusive",
        evidence: "query",
        reason: position ? "insufficient-evidence" : "no-response",
      })
      if (position) expect(result.response, definition.id).toBe("5;5")
    }
  }
})

// Selective erase needs both an erased target and a surviving protected cell;
// an unchanged screen or ordinary erase cannot establish selective behavior.
test("selective erasure observes protected cells and the unprotected target", () => {
  for (const [id, sequence, success] of [
    ["erase.selective", "\x1b[?2J", "P     "],
    ["editing.decsera", "\x1b[1;1;1;5${", "P    Z"],
  ]) {
    const definition = [...eraseProbes, ...editingProbes].find((probe) => probe.id === id)
    if (!definition?.termless) throw new Error(`Missing ${id}`)
    for (const [after, expected] of [
      [success, "supported"],
      ["PABCDZ", "unsupported"],
      ["      ", "inconclusive"],
    ]) {
      const base = headless("ABCDE")
      let erased = false
      const result = definition.termless({
        ...base,
        feed(bytes) {
          if (bytes === sequence) erased = true
        },
        getCell(row, col) {
          return { ...base.getCell(row, col), char: ((erased ? after : "PABCDZ") ?? "")[col] ?? "" }
        },
      })
      expect(result.observation, `${id}: ${after}`).toMatchObject({ outcome: expected, evidence: "parser-state" })
      if (expected !== "inconclusive") expect(result.assertions?.[0]?.observed).toBe(result.response)
    }
  }
})

// These old probes could pass on an empty history, an unerased colored X, or
// an unchanged region. Keep each target and its prerequisite independently visible.
test("scrollback erase requires existing history and measured removal", () => {
  for (const [history, clears, expected] of [
    [true, true, "supported"],
    [true, false, "unsupported"],
    [false, true, "inconclusive"],
  ] as const) {
    const base = headless("ABCDE")
    let seeded = false
    let erased = false
    const result = byId("erase.screen.scrollback").termless({
      ...base,
      feed(bytes) {
        if (bytes.includes("\r\n")) seeded = true
        if (bytes === "\x1b[3J") erased = true
      },
      getScrollback: () => ({
        viewportOffset: 0,
        screenLines: 24,
        totalLines: seeded && history && !(erased && clears) ? 26 : 24,
      }),
    })
    expect(result.observation).toMatchObject({ outcome: expected, evidence: "parser-state" })
  }
})

test("background erase measures a blank target with its calibrated background", () => {
  for (const [char, background, expected] of [
    [" ", true, "supported"],
    ["X", true, "unsupported"],
    [" ", false, "inconclusive"],
  ] as const) {
    const base = headless("ABCDE")
    let erased = false
    const result = byId("erase.el-with-attrs").termless({
      ...base,
      feed(bytes) {
        if (bytes === "\x1b[K") erased = true
      },
      getCell(row, col) {
        return { ...base.getCell(row, col), char: erased ? char : "X", bg: background ? { r: 0, g: 180, b: 0 } : null }
      },
    })
    expect(result.observation).toMatchObject({ outcome: expected, evidence: "parser-state" })
  }
})

test("region erase requires changed cells and a preserved preceding row", () => {
  for (const [changed, control, expected] of [
    [true, true, "supported"],
    [false, true, "unsupported"],
    [true, false, "inconclusive"],
  ] as const) {
    const base = headless("ABCDE")
    let erased = false
    const result = byId("erase.ed-scroll-region").termless({
      ...base,
      feed(bytes) {
        if (bytes === "\x1b[J") erased = true
      },
      getCursor: () => ({ x: 0, y: 2, visible: true, style: null }),
      getCell(row, col) {
        return {
          ...base.getCell(row, col),
          char:
            (row === 0 ? (erased && !control ? "?????" : "KEEP!") : erased && changed ? "     " : "ERASE")[col] ?? "",
        }
      },
    })
    expect(result.observation).toMatchObject({ outcome: expected, evidence: "parser-state" })
  }
})

// Geometry is a prerequisite, not an erase failure. Reject before writing a
// row fixture that would wrap or be clamped into a different part of the screen.
test("headless erase fixtures require measured rows and columns before writes", () => {
  for (const id of [...ids, ...screenIds]) {
    const probe = byId(id)
    for (const [cols, rows] of [
      [5, 24],
      [NaN, 24],
      [80, 0],
      [80, Infinity],
    ]) {
      const base = headless("ABCDE")
      const feeds: string[] = []
      const result = probe.termless({
        ...base,
        cols: cols ?? 0,
        feed: (bytes) => feeds.push(bytes),
        getScrollback: () => ({ viewportOffset: 0, totalLines: rows ?? 0, screenLines: rows ?? 0 }),
      })
      expect(feeds, `${id} ${cols}x${rows}`).toEqual([])
      expect(result.observation, id).toMatchObject({ outcome: "inconclusive", reason: "insufficient-evidence" })
    }
  }
})
