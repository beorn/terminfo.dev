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
    rows: 24,
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

// vterm.js stays at the current column when no stops exist. The model keeps
// that behavior so this test catches a probe that mistakes the no-stop HT
// destination for evidence that TBC cleared its old stops.
function tabTerminal(ignoreClear = false, ignoreNewStop = false) {
  let col = 1
  const stops = new Set(Array.from({ length: 10 }, (_, index) => 9 + index * 8))
  const writes: string[] = []
  return {
    writes,
    get col() {
      return col
    },
    write(sequence: string) {
      writes.push(sequence)
      for (const match of sequence.matchAll(/\x1b\[(\d+);(\d+)H|\x1b\[(\d+)g|\x1bH|\t/g)) {
        if (match[1] && match[2]) col = Number(match[2])
        else if (match[3] === "3") {
          if (!ignoreClear) stops.clear()
        } else if (match[0] === "\x1bH") {
          if (!ignoreNewStop || col !== 33) stops.add(col)
        } else if (match[0] === "\t") col = [...stops].filter((stop) => stop > col).sort((a, b) => a - b)[0] ?? col
      }
    },
  }
}

test("TBC measures old stops removed and a new later stop, including vterm's stationary no-stop HT", async () => {
  const probe = byId("text.tbc")
  for (const ignoredClear of [false, true]) {
    const terminal = tabTerminal(ignoredClear)
    const appResult = await probe.term(
      app({
        cols: 80,
        write: terminal.write,
        queryCursorPosition: async () => ({ row: 1, col: terminal.col }),
      }),
    )
    expect(appResult.observation).toMatchObject({
      outcome: ignoredClear ? "unsupported" : "supported",
      evidence: "behavior",
    })
    expect(JSON.parse(appResult.response ?? "")).toMatchObject({
      oldFirst: { col: 9 },
      oldSecond: { col: 17 },
      oldThird: { col: 25 },
      after: { col: ignoredClear ? 9 : 33 },
    })
    expect(appResult.assertions).toMatchObject([{ kind: ignoredClear ? "negative" : "positive" }])
    expect(terminal.writes.join("")).toContain("\x1b[3g\x1b[1;33H\x1bH\x1b[1;1H\t")
    expect(terminal.writes.at(-1)).toContain("\x1b[1;73H\x1bH")

    const parser = tabTerminal(ignoredClear)
    const headlessResult = probe.termless(
      headless({
        cols: 80,
        feed: parser.write,
        getCursor: () => ({ x: parser.col - 1, y: 0, visible: true, style: null }),
      }),
    )
    expect(headlessResult.observation).toMatchObject({
      outcome: ignoredClear ? "unsupported" : "supported",
      evidence: "parser-state",
    })
    expect(JSON.parse(headlessResult.response ?? "")).toMatchObject({
      oldFirst: { col: 9 },
      oldSecond: { col: 17 },
      oldThird: { col: 25 },
      after: { col: ignoredClear ? 9 : 33 },
    })
    expect(parser.writes.at(-1)).toContain("\x1b[1;73H\x1bH")
  }

  const noNewStop = tabTerminal(false, true)
  const noStopResult = probe.termless(
    headless({
      feed: noNewStop.write,
      getCursor: () => ({ x: noNewStop.col - 1, y: 0, visible: true, style: null }),
    }),
  )
  expect(noStopResult.observation).toMatchObject({ outcome: "inconclusive", reason: "insufficient-evidence" })
  expect(JSON.parse(noStopResult.response ?? "")).toMatchObject({ after: { col: 1 } })
  expect(noStopResult.assertions).toBeUndefined()
})

test("TBC leaves failed setup, narrow geometry and absent or malformed cursor evidence inconclusive", async () => {
  const probe = byId("text.tbc")
  expect(probe.termless(headless({ cols: 30 })).observation).toMatchObject({
    outcome: "inconclusive",
    reason: "insufficient-evidence",
  })
  const malformed = tabTerminal()
  const result = probe.termless(
    headless({ feed: malformed.write, getCursor: () => ({ x: 0, y: 1, visible: true, style: null }) }),
  )
  expect(result.observation).toMatchObject({ outcome: "inconclusive", reason: "insufficient-evidence" })
  expect(result.assertions).toBeUndefined()
  expect(malformed.writes.at(-1)).toContain("\x1b[1;73H\x1bH")

  const missing = tabTerminal()
  let queries = 0
  const appResult = await probe.term(
    app({
      write: missing.write,
      queryCursorPosition: async () => (++queries === 4 ? null : { row: 1, col: missing.col }),
    }),
  )
  expect(appResult.observation).toMatchObject({ outcome: "inconclusive", reason: "no-response" })
  expect(missing.writes.at(-1)).toContain("\x1b[1;73H\x1bH")
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

test("direct text and Unicode size readers declare geometry, including tab finally", () => {
  for (const id of ["text.wrap", "text.hts", "text.tbc", "text.cht", "text.cbt"]) {
    expect(textProbes.find((entry) => entry.id === id)?.termNeedsGeometry, id).toBe(true)
  }
  for (const probe of unicodeProbes) expect(probe.termNeedsGeometry, probe.id).toBe(true)
})

test("text.wrap writes the measured 61 columns and declines one row before writing", async () => {
  const writes: string[] = []
  await byId("text.wrap").term(
    app({ cols: 61, rows: 24, write: (s) => writes.push(s), queryCursorPosition: async () => ({ row: 2, col: 2 }) }),
  )
  expect(writes).toEqual(["\x1b[1;1H\x1b[2K", "W".repeat(61) + "X"])
  const narrowWrites: string[] = []
  const result = await byId("text.wrap").term(app({ cols: 61, rows: 1, write: (s) => narrowWrites.push(s) }))
  expect(result.observation).toMatchObject({
    outcome: "inconclusive",
    reason: "insufficient-evidence",
    evidence: "none",
  })
  expect(narrowWrites).toEqual([])
})

test("HTS restores stops only inside the measured 61-column fixture", async () => {
  const writes: string[] = []
  await byId("text.hts").term(
    app({ cols: 61, write: (s) => writes.push(s), queryCursorPosition: async () => ({ row: 1, col: 6 }) }),
  )
  expect(writes.at(-1)).toContain("\x1b[1;57H\x1bH")
  expect(writes.at(-1)).not.toContain("\x1b[1;65H\x1bH")
  const small: string[] = []
  const result = await byId("text.hts").term(app({ cols: 5, write: (s) => small.push(s) }))
  expect(result.observation).toMatchObject({
    outcome: "inconclusive",
    reason: "insufficient-evidence",
    evidence: "none",
  })
  expect(small).toEqual([])
})

test("tab and Unicode size refusals record no feature measurement or writes", async () => {
  for (const id of [
    "text.tbc",
    "text.cht",
    "text.cbt",
    "unicode.tab-stops",
    "unicode.wrap-boundary",
    "unicode.east-asian-ambiguous",
    "unicode.grapheme-cursor",
  ]) {
    const writes: string[] = []
    const result = await byId(id).term(app({ cols: 1, rows: 1, write: (sequence) => writes.push(sequence) }))
    expect(result.observation, id).toMatchObject({
      outcome: "inconclusive",
      reason: "insufficient-evidence",
      evidence: "none",
    })
    expect(writes, id).toEqual([])
  }
})
