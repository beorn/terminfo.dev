/**
 * @failure Cleared tab stops were reported as a failure and contaminated later tab probes; grapheme cursor was credited without measuring its named behavior.
 * @level l0
 * @consumer App and headless tab/Unicode probe callbacks.
 * @testonly none
 */
import { expect, test } from "vitest"
import { textProbes } from "./text.ts"
import { unicodeProbes } from "./unicode.ts"
import type { TermContext, TermlessContext } from "./types.ts"

function app(overrides: Partial<TermContext> = {}): TermContext {
  return {
    write() {},
    queryCursorPosition: async () => null,
    measureRenderedWidth: async () => null,
    query: async () => null,
    queryWithSentinel: async () => null,
    queryOutcome: async () => ({ match: null, reason: "timeout", raw: "", rawBase64: "" }),
    queryWithSentinelOutcome: async () => ({ match: null, reason: "timeout", raw: "", rawBase64: "" }),
    queryMode: async () => null,
    cols: 150,
    ...overrides,
  }
}

function headless(overrides: Partial<TermlessContext> = {}): TermlessContext {
  return {
    cols: 80,
    feed() {},
    feedCapture: () => "",
    getCell: () => ({
      char: "👨‍👩‍👧",
      wide: true,
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
    }),
    getCursor: () => ({ x: 2, y: 0, visible: true, style: null }),
    getMode: () => false,
    getText: () => "X",
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
    ...overrides,
  }
}

function byId(id: string) {
  const probe = [...textProbes, ...unicodeProbes].find((item) => item.id === id)
  if (!probe?.term || !probe.termless) throw new Error(`missing ${id} callbacks`)
  return { term: probe.term, termless: probe.termless }
}

test("TBC accepts a measured right-margin tab and restores an eight-column fixture", async () => {
  const writes: string[] = []
  let queries = 0
  const probe = byId("text.tbc")
  const result = await probe.term(
    app({
      write(value) {
        writes.push(value)
      },
      queryCursorPosition: async () => ({ row: 1, col: queries++ === 0 ? 9 : 150 }),
    }),
  )
  expect(result.observation).toMatchObject({ outcome: "supported", evidence: "behavior" })
  expect(result.assertions).toMatchObject([{ kind: "positive", observed: expect.stringContaining("150") }])
  expect(writes.join("")).toContain("\x1b[3g")
  expect(writes.at(-1)).toContain("\x1bH")
  const ignored = await probe.term(app({ queryCursorPosition: async () => ({ row: 1, col: 9 }) }))
  expect(ignored.observation).toMatchObject({ outcome: "unsupported", evidence: "behavior" })
  let stationaryQueries = 0
  const stationary = await probe.term(
    app({ queryCursorPosition: async () => ({ row: 1, col: ++stationaryQueries === 1 ? 9 : 1 }) }),
  )
  expect(stationary.observation).toMatchObject({
    outcome: "inconclusive",
    reason: "insufficient-evidence",
    evidence: "behavior",
  })
  expect((await probe.term(app())).observation).toMatchObject({ outcome: "inconclusive", reason: "no-response" })
})

test("TBC retains vterm's no-stop cursor state as inconclusive", () => {
  const feeds: string[] = []
  let read = 0
  const result = byId("text.tbc").termless(
    headless({
      feed(sequence) {
        feeds.push(sequence)
      },
      // Actual vterm.js 0.7.0 observation at 80 columns: first tab x=8,
      // after TBC with no remaining stops x=0. HT's destination is unspecified.
      getCursor: () => ({ x: read++ === 0 ? 8 : 0, y: 0, visible: true, style: null }),
    }),
  )
  expect(result.observation).toMatchObject({
    outcome: "inconclusive",
    reason: "insufficient-evidence",
    evidence: "parser-state",
  })
  expect(JSON.parse(result.response ?? "")).toMatchObject({ cols: 80, before: { x: 8 }, after: { x: 0 } })
  expect(result.assertions).toBeUndefined()
  expect(feeds.at(-1)).toContain("\x1b[1;73H\x1bH")
})

test("CHT and CBT establish tab stops independent of inherited terminal state", async () => {
  for (const [id, expectedCol] of [
    ["text.cht", 17],
    ["text.cbt", 17],
  ] as const) {
    const writes: string[] = []
    const result = await byId(id).term(
      app({
        write(value) {
          writes.push(value)
        },
        queryCursorPosition: async () => ({ row: 1, col: expectedCol }),
      }),
    )
    expect(result.observation).toMatchObject({ outcome: "supported", evidence: "behavior" })
    expect(result.assertions).toMatchObject([{ kind: "positive", observed: expect.stringContaining("17") }])
    expect(writes.join("")).toContain("\x1b[3g")
    expect(writes.join("")).toContain("\x1bH")
    expect(writes.at(-1)).toContain("\x1bH")
    const ignored = await byId(id).term(
      app({ queryCursorPosition: async () => ({ row: 1, col: id === "text.cht" ? 1 : 21 }) }),
    )
    expect(ignored.observation).toMatchObject({ outcome: "unsupported", evidence: "behavior" })
  }
  expect((await byId("text.cht").term(app({ cols: 12 }))).observation).toMatchObject({
    outcome: "inconclusive",
    reason: "insufficient-evidence",
  })
})

test("headless HTS restores tab stops within the initialized grid width", () => {
  const feeds: string[] = []
  let cursorX = 5
  const result = byId("text.hts").termless(
    headless({
      cols: 80,
      feed(sequence) {
        feeds.push(sequence)
        if (sequence.includes("\x1b[9999G")) cursorX = 80
      },
      getCursor: () => ({ x: cursorX, y: 0, visible: true, style: null }),
    }),
  )
  expect(result.pass).toBe(true)
  expect(feeds.join("")).not.toContain("\x1b[9999G")
  expect(feeds.at(-1)).toContain("\x1b[1;73H\x1bH")
  expect(feeds.at(-1)).not.toContain("\x1b[1;81H\x1bH")
})

test("grapheme ID measures the ZWJ sample width, including headless cell state", async () => {
  const probe = byId("unicode.grapheme-cursor")
  const result = await probe.term(app({ measureRenderedWidth: async () => 2 }))
  expect(result.observation).toMatchObject({ outcome: "supported", evidence: "behavior" })
  expect(result.assertions).toMatchObject([{ kind: "positive", expected: "2", observed: "2" }])
  expect((await probe.term(app())).observation).toMatchObject({ outcome: "inconclusive", reason: "no-response" })

  const headlessResult = probe.termless(headless())
  expect(headlessResult.observation).toMatchObject({ outcome: "supported", evidence: "parser-state" })
  expect(headlessResult.assertions).toMatchObject([{ kind: "positive", observed: headlessResult.response }])
})
