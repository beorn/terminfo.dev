/**
 * @failure Cleared tab stops were reported as a failure and contaminated later tab probes; grapheme cursor was credited without measuring its named behavior.
 * @level l0
 * @consumer App and headless tab/Unicode probe callbacks.
 * @testonly none
 */
import { expect, test } from "vitest"
import { textProbes, textReadbackRows } from "./text.ts"
import { unicodeProbes } from "./unicode.ts"
import { regionReadbackProbe } from "./region-readback-kind.ts"
import { libProbeSource } from "./testing/group-harness.ts"
import { createSemanticSurface } from "./testing/semantic-surface.ts"
import { recordExecutedProbe } from "./helpers.ts"
import type { TermProbeSource, LibProbeSource } from "./types.ts"

function app(overrides: Partial<TermProbeSource> = {}): TermProbeSource {
  return {
    kind: "live",
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

function headless(overrides: Partial<LibProbeSource> = {}): LibProbeSource {
  return {
    kind: "live",
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
  if (!probe?.term || !probe.lib) throw new Error(`missing ${id} callbacks`)
  return { term: probe.term, lib: probe.lib }
}

/** Sequential CPR fixture: each call returns the next scripted reply, null once exhausted. */
function cursorQueue(...positions: Array<{ row: number; col: number } | null>) {
  let index = 0
  return async () => (index < positions.length ? positions[index++] : null) ?? null
}

test("text width claims require an ASCII control and the named sample", async () => {
  for (const id of [
    "text.wide.emoji",
    "text.wide.cjk",
    "text.wide.emoji-flags",
    "text.wide.emoji-vs16",
    "text.wide.emoji-zwj",
  ]) {
    const probe = byId(id)
    const samples: string[] = []
    const measured = await probe.term(
      app({
        measureRenderedWidth: async (sample) => {
          samples.push(sample)
          return 2
        },
      }),
    )
    expect(samples[0], id).toBe("AA")
    expect(samples[1], id).not.toBe("AA")
    expect(measured.observation, id).toMatchObject({ outcome: "supported", assertionType: "query_reply" })
    expect(measured.assertions, id).toMatchObject([{ kind: "positive" }])
    const invalid = await probe.term(app({ measureRenderedWidth: async (sample) => (sample === "AA" ? 1 : 2) }))
    expect(invalid.observation, id).toMatchObject({ outcome: "inconclusive", reason: "insufficient-evidence" })
    expect(invalid.assertions, id).toBeUndefined()
  }
})

// 28752: a wide-sample row compares plainly written glyphs, so it assumes the run decodes plain
// UTF-8. A run measured 8-bit paints a different string from the one the row claims: the row is
// inconclusive and NAMES the cause instead of reading a context defect as a width negative.
test("a measured 8-bit decoding context names the cause instead of grading a plain-written glyph", async () => {
  for (const id of [
    "text.wide.emoji",
    "text.wide.cjk",
    "text.wide.emoji-flags",
    "text.wide.emoji-vs16",
    "text.wide.emoji-zwj",
    "text.combining",
    "unicode.grapheme-cursor",
    "unicode.east-asian-ambiguous",
  ]) {
    const probe = byId(id)
    let widthCalls = 0
    const result = await probe.term(
      app({
        utf8Decoding: async () => "8-bit",
        measureRenderedWidth: async () => {
          widthCalls += 1
          return 2
        },
      }),
    )
    expect(result.observation, id).toMatchObject({
      outcome: "inconclusive",
      reason: "insufficient-evidence",
      assertionType: "query_reply",
    })
    expect(String(result.observation?.note), id).toContain("decodes plain-written UTF-8 as ISO-8859-1")
    expect(widthCalls, id).toBe(0)
    expect(result.assertions, id).toBeUndefined()
    expect(result.pass, id).toBe(false)
  }
})

// 28828 census: this row grades the CURSOR ADVANCE of a plainly written CJK glyph, so an 8-bit
// context is named before it writes anything, not graded as a wrap negative.
test("a measured 8-bit decoding context names the cause for the wide-wrap cursor row before it writes", async () => {
  const probe = byId("unicode.wrap-boundary")
  const writes: string[] = []
  let cursorQueries = 0
  const result = await probe.term(
    app({
      utf8Decoding: async () => "8-bit",
      write: (text) => writes.push(text),
      queryCursorPosition: async () => {
        cursorQueries += 1
        return null
      },
    }),
  )
  expect(result.observation).toMatchObject({
    outcome: "inconclusive",
    reason: "insufficient-evidence",
    assertionType: "query_reply",
  })
  expect(String(result.observation?.note)).toContain("decodes plain-written UTF-8 as ISO-8859-1")
  expect(cursorQueries).toBe(0)
  expect(writes).toEqual([])
  expect(result.assertions).toBeUndefined()
})

test("a measured utf8 decoding context leaves the wide rows to their own width oracle", async () => {
  const probe = byId("text.wide.emoji")
  const result = await probe.term(app({ utf8Decoding: async () => "utf8", measureRenderedWidth: async () => 2 }))
  expect(result.observation).toMatchObject({ outcome: "supported", assertionType: "query_reply" })
})

test("headless wide sample needs ASCII cell control before a support assertion", () => {
  const probe = byId("text.wide.emoji")
  const blank = headless().getCell(0, 0)
  let phase = "empty"
  const context = headless({
    feed(sequence) {
      if (sequence === "AA") phase = "ascii"
      else if (sequence === "\x1b[1;1H\x1b[2K") phase = "clear"
      else if (sequence === "🎉") phase = "sample"
    },
    getCell: (_row, col) => ({
      ...blank,
      char: phase === "ascii" ? (col < 2 ? "A" : "") : phase === "sample" && col === 0 ? "🎉" : "",
      wide: phase === "sample" && col === 0,
    }),
  })
  const supported = probe.lib(context)
  expect(supported.observation).toMatchObject({ outcome: "supported", assertionType: "buffer_state" })
  expect(supported.assertions).toMatchObject([{ kind: "positive" }])
  const missing = probe.lib(headless({ getCell: () => ({ ...blank, char: "🎉", wide: true }) }))
  expect(missing.observation).toMatchObject({ outcome: "inconclusive", reason: "insufficient-evidence" })
  expect(missing.assertions).toBeUndefined()
})

test("app cursor motion needs a measured start while cell-only text stays ungraded", async () => {
  for (const [row, col, outcome] of [
    [4, 1, "supported"],
    [4, 5, "supported"],
    [3, 5, "unsupported"],
  ] as const) {
    const replies = [
      { row: 3, col: 5 },
      { row, col },
    ]
    const newline = await byId("text.newline").term(app({ queryCursorPosition: async () => replies.shift() ?? null }))
    expect(newline.observation, `LF final ${row};${col}`).toMatchObject({ outcome, assertionType: "query_reply" })
    expect(newline.assertions).toMatchObject([{ kind: outcome === "supported" ? "positive" : "negative" }])
    expect(JSON.parse(newline.response ?? "")).toMatchObject({ before: { row: 3, col: 5 }, pos: { row, col } })
  }
  const uncalibrated = await byId("text.newline").term(app({ queryCursorPosition: async () => ({ row: 4, col: 5 }) }))
  expect(uncalibrated.observation).toMatchObject({ outcome: "inconclusive", reason: "insufficient-evidence" })
  const basic = await byId("text.basic").term(app({ queryCursorPosition: async () => ({ row: 1, col: 6 }) }))
  expect(basic.observation).toMatchObject({ outcome: "inconclusive", assertionType: "query_reply" })
  expect(basic.assertions).toBeUndefined()
})

// Model the DEC right-margin fallback and a broken stationary fallback independently
// of the probe, while preserving old-stop calibration and cleanup evidence.
function tabTerminal(ignoreClear = false, stationaryFallback = false, ignoreTarget = false) {
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
      for (const match of sequence.matchAll(/\x1b\[(\d+);(\d+)H|\x1b\[(\d+)g|\x1bH|\t|\x1b\[(\d*)[IZ]/g)) {
        if (match[1] && match[2]) col = Number(match[2])
        else if (match[3] === "3") {
          if (!ignoreClear) stops.clear()
        } else if (match[0] === "\x1bH") {
          stops.add(col)
        } else if (match[0] === "\t") {
          col = [...stops].filter((stop) => stop > col).sort((a, b) => a - b)[0] ?? (stationaryFallback ? col : 80)
        } else if (!ignoreTarget) {
          for (let count = Number(match[4] || 1); count > 0; count -= 1) {
            const backward = match[0].endsWith("Z")
            col = backward
              ? ([...stops].filter((stop) => stop < col).sort((a, b) => b - a)[0] ?? 1)
              : ([...stops].filter((stop) => stop > col).sort((a, b) => a - b)[0] ?? 80)
          }
        }
      }
    },
  }
}

/** @failure TBC misgrades conforming right-margin HT or accepts a stationary fallback.
 * @level l1
 * @consumer text.tbc app and headless observations
 */
test("TBC measures old stops removed and HT reaching the right margin", async () => {
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
      assertionType: "query_reply",
    })
    expect(JSON.parse(appResult.response ?? "")).toMatchObject({
      oldFirst: { col: 9 },
      oldSecond: { col: 17 },
      oldThird: { col: 25 },
      after: { col: ignoredClear ? 9 : 80 },
    })
    expect(appResult.assertions).toMatchObject([{ kind: ignoredClear ? "negative" : "positive" }])
    expect(terminal.writes.join("")).toContain("\x1b[3g\x1b[1;1H\t")
    expect(terminal.writes.at(-1)).toContain("\x1b[1;73H\x1bH")

    const parser = tabTerminal(ignoredClear)
    const headlessResult = probe.lib(
      headless({
        cols: 80,
        feed: parser.write,
        getCursor: () => ({ x: parser.col - 1, y: 0, visible: true, style: null }),
      }),
    )
    expect(headlessResult.observation).toMatchObject({
      outcome: ignoredClear ? "unsupported" : "supported",
      assertionType: "buffer_state",
    })
    expect(JSON.parse(headlessResult.response ?? "")).toMatchObject({
      oldFirst: { col: 9 },
      oldSecond: { col: 17 },
      oldThird: { col: 25 },
      after: { col: ignoredClear ? 9 : 80 },
    })
    expect(parser.writes.at(-1)).toContain("\x1b[1;73H\x1bH")
  }

  const stationary = tabTerminal(false, true)
  const noStopResult = probe.lib(
    headless({
      feed: stationary.write,
      getCursor: () => ({ x: stationary.col - 1, y: 0, visible: true, style: null }),
    }),
  )
  expect(noStopResult.observation).toMatchObject({ outcome: "unsupported", assertionType: "buffer_state" })
  expect(JSON.parse(noStopResult.response ?? "")).toMatchObject({ after: { col: 1 } })
  expect(noStopResult.assertions).toMatchObject([{ kind: "negative" }])
})

test("TBC leaves failed setup, narrow geometry and absent or malformed cursor evidence inconclusive", async () => {
  const probe = byId("text.tbc")
  // The undersized library branches retained no state read. Their previous parser-state label
  // defaulted to FAILURE; canonicalization must neither fabricate buffer_state nor change it to TODO.
  for (const [id, cols] of [
    ["text.tbc", 30],
    ["text.cht", 20],
    ["text.cbt", 20],
  ] as const) {
    const writes: string[] = []
    const declined = byId(id).lib(
      headless({
        cols,
        feed: (bytes) => writes.push(bytes),
        getCursor: () => {
          throw new Error("Undersized tab fixture must not read cursor state")
        },
      }),
    )
    expect(declined.pass).toBe(false)
    expect(declined.response).toBeUndefined()
    expect(declined.observation).toBeUndefined()
    expect(writes).toEqual([])
    const recorded = recordExecutedProbe({
      featureId: id,
      attempt: { scope: "probe", startedAt: "2026-10-21T05:00:00.000Z" },
      assertions: [],
      tests: declined.tests,
    })
    expect(recorded.status).toBe("test-failure")
    expect(recorded.assertionType).toBeUndefined()
    expect(recorded.reason).toBe(`Tab fixture needs at least ${id === "text.tbc" ? 34 : 21} columns`)
  }
  const malformed = tabTerminal()
  const result = probe.lib(
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
  expect(appResult.observation).toBeUndefined()
  expect(appResult.tests).toMatchObject([{ id: "criterion", status: "test-failure", reason: "no-response" }])
  expect(missing.writes.at(-1)).toContain("\x1b[1;73H\x1bH")
})

test.each([
  ["text.cht", "app"],
  ["text.cht", "headless"],
  ["text.cbt", "app"],
  ["text.cbt", "headless"],
])("%s %s qualifies setup before grading its owned tab target", async (id, mode) => {
  const probe = byId(id)
  const target = id === "text.cht" ? "\x1b[2I" : "\x1b[Z"
  const run = (terminal: ReturnType<typeof tabTerminal>, constant?: number) =>
    mode === "app"
      ? probe.term(
          app({ write: terminal.write, queryCursorPosition: async () => ({ row: 1, col: constant ?? terminal.col }) }),
        )
      : probe.lib(
          headless({
            feed: terminal.write,
            getCursor: () => ({ x: (constant ?? terminal.col) - 1, y: 0, visible: true, style: null }),
          }),
        )

  // A constant target reply used to pass despite never establishing the distinct starting position.
  for (const constant of [17, 4]) {
    const terminal = tabTerminal()
    const unqualified = await run(terminal, constant)
    expect(unqualified.observation).toMatchObject({ outcome: "inconclusive", reason: "insufficient-evidence" })
    expect(unqualified.assertions).toBeUndefined()
    expect(terminal.writes.join("")).not.toContain(target)
    expect(terminal.writes.at(-1)).toContain("\x1bH")
  }
  for (const ignored of [false, true]) {
    const terminal = tabTerminal(false, false, ignored)
    const result = await run(terminal)
    expect(result.observation).toMatchObject({
      outcome: ignored ? "unsupported" : "supported",
      assertionType: mode === "app" ? "query_reply" : "buffer_state",
    })
    expect(result.assertions).toMatchObject([{ kind: ignored ? "negative" : "positive" }])
    expect(terminal.writes.join("")).toContain(target)
    expect(terminal.writes.at(-1)).toContain("\x1bH")
  }
  if (mode === "app") {
    const terminal = tabTerminal()
    const missing = await probe.term(app({ write: terminal.write }))
    expect(missing.observation).toBeUndefined()
    expect(missing.tests).toEqual([
      {
        id: "criterion",
        status: "test-failure",
        reason:
          id === "text.cht"
            ? "CHT starting position was not measured at row 1, column 1"
            : "CBT starting position was not measured at row 1, column 21",
      },
    ])
    expect(missing.assertions).toBeUndefined()
    expect(terminal.writes.join("")).not.toContain(target)
    expect(terminal.writes.at(-1)).toContain("\x1bH")
    const undersized = await probe.term(app({ cols: 12 }))
    expect(undersized.observation).toBeUndefined()
    expect(undersized.tests).toEqual([
      { id: "criterion", status: "test-todo", reason: "Tab fixture needs at least 21 columns" },
    ])
  }
})

test("headless HTS restores tab stops within the initialized grid width", () => {
  const feeds: string[] = []
  let cursorX = 5
  const result = byId("text.hts").lib(
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
  expect(result.observation).toMatchObject({ outcome: "supported", assertionType: "query_reply" })
  expect(result.assertions).toMatchObject([{ kind: "positive", expected: "2", observed: "2" }])
  const missing = await probe.term(app())
  expect(missing.observation).toBeUndefined()
  expect(missing.tests).toEqual([{ id: "criterion", status: "test-failure", reason: "Cannot measure width" }])

  const sample = "👨‍👩‍👧"
  const blank = headless().getCell(0, 0)
  let phase = "empty"
  const headlessResult = probe.lib(
    headless({
      feed(sequence) {
        if (sequence.endsWith("AB")) phase = "seed"
        else if (sequence === "\x1b[1;1H") phase = "setup"
        else if (sequence === sample) phase = "sample"
      },
      getCell: (_row, col) =>
        phase === "seed"
          ? { ...blank, char: col === 0 ? "A" : col === 1 ? "B" : "", wide: false }
          : phase === "sample" && col === 0
            ? { ...blank, char: sample, wide: true }
            : { ...blank, char: "", wide: false },
      getCursor: () => ({ x: phase === "sample" ? 2 : 0, y: 0, visible: true, style: null }),
    }),
  )
  expect(headlessResult.observation).toMatchObject({ outcome: "supported", assertionType: "buffer_state" })
  expect(headlessResult.assertions).toMatchObject([{ kind: "positive", observed: headlessResult.response }])
})

test("Unicode width and tab callbacks retain measured state and query evidence", async () => {
  const blank = headless().getCell(0, 0)
  let ambiguousPhase = "empty"
  const ambiguous = byId("unicode.east-asian-ambiguous").lib(
    headless({
      cols: 4,
      feed(sequence) {
        if (sequence.endsWith("AQ")) ambiguousPhase = "seed"
        else if (sequence === "\x1b[1;1H") ambiguousPhase = "setup"
        else if (sequence === "●X") ambiguousPhase = "sample"
      },
      getCell: (_row, col) => {
        if (ambiguousPhase === "seed") return { ...blank, char: col === 0 ? "A" : col === 1 ? "Q" : "", wide: false }
        if (ambiguousPhase === "sample") {
          return { ...blank, char: col === 0 ? "●" : col === 1 ? "X" : "", wide: col === 0 }
        }
        return { ...blank, char: "", wide: false }
      },
      getCursor: () => ({ x: 0, y: 0, visible: true, style: null }),
    }),
  )
  expect(ambiguous.observation).toMatchObject({ outcome: "supported", assertionType: "buffer_state" })
  expect(JSON.parse(ambiguous.response ?? "")).toMatchObject({ before: ["A", "Q"], after: ["●", "X", "", ""] })

  let tabPhase = "empty"
  const tab = byId("unicode.tab-stops").lib(
    headless({
      cols: 10,
      feed(sequence) {
        if (sequence === "AB") tabPhase = "seed"
        else if (sequence === "\x1b[1;1H") tabPhase = "setup"
        else if (sequence === "A\tB") tabPhase = "sample"
      },
      getCell: (_row, col) => {
        if (tabPhase === "seed") return { ...blank, char: col === 0 ? "A" : col === 1 ? "B" : "", wide: false }
        if (tabPhase === "sample") return { ...blank, char: col === 0 ? "A" : col === 8 ? "B" : "", wide: false }
        return { ...blank, char: "", wide: false }
      },
      getCursor: () => ({ x: 0, y: 0, visible: true, style: null }),
    }),
  )
  expect(tab.observation).toMatchObject({ outcome: "supported", assertionType: "buffer_state" })
  expect(JSON.parse(tab.response ?? "")).toMatchObject({ before: ["A", "B"], after: { 8: "B" } })

  const appTab = await byId("unicode.tab-stops").term(app({ queryCursorPosition: async () => ({ row: 1, col: 10 }) }))
  expect(appTab.observation).toMatchObject({ outcome: "supported", assertionType: "query_reply" })
  expect(appTab.response).toBe(JSON.stringify({ row: 1, col: 10 }))

  const appWrap = await byId("unicode.wrap-boundary").term(
    app({ rows: 2, cols: 4, queryCursorPosition: async () => ({ row: 2, col: 2 }) }),
  )
  expect(appWrap.observation).toMatchObject({ outcome: "supported", assertionType: "query_reply" })
  expect(appWrap.response).toBe(JSON.stringify({ row: 2, col: 2 }))
})

test("direct text and Unicode size readers declare geometry, including tab finally", () => {
  for (const id of ["text.wrap", "text.hts", "text.tbc", "text.cht", "text.cbt"]) {
    expect(textProbes.find((entry) => entry.id === id)?.termNeedsGeometry, id).toBe(true)
  }
  for (const probe of unicodeProbes) expect(probe.termNeedsGeometry, probe.id).toBe(true)
})

test("text.wrap qualifies DECAWM then writes control then target before grading", async () => {
  const writes: string[] = []
  const supported = await byId("text.wrap").term(
    app({
      cols: 61,
      rows: 24,
      write: (s) => writes.push(s),
      queryMode: async () => "set",
      queryCursorPosition: cursorQueue({ row: 1, col: 1 }, { row: 1, col: 61 }, { row: 2, col: 2 }),
    }),
  )
  expect(supported.observation).toMatchObject({ outcome: "supported", assertionType: "query_reply" })
  expect(supported.assertions).toMatchObject([{ kind: "positive" }])
  expect(writes).toEqual(["\x1b[1;1H", "\x1b[1;1H\x1b[2K", "W".repeat(60), "\x1b[1;1H\x1b[2K", "W".repeat(61) + "X"])
  const narrowWrites: string[] = []
  const result = await byId("text.wrap").term(app({ cols: 61, rows: 1, write: (s) => narrowWrites.push(s) }))
  expect(result.observation).toBeUndefined()
  expect(result).toMatchObject({
    tests: [expect.objectContaining({ status: "test-todo", reason: "Wrap fixture needs at least 2x2, measured 1x61" })],
  })
  expect(narrowWrites).toEqual([])
})

test("text.wrap negative controls: unqualified control, spoofing, wrong target, missing replies, DECAWM", async () => {
  const cases = [
    cursorQueue({ row: 1, col: 60 }, { row: 2, col: 2 }),
    cursorQueue({ row: 1, col: 1 }, { row: 1, col: 60 }, { row: 2, col: 2 }),
    async () => ({ row: 2, col: 2 }),
    // A constant right-margin provider must not qualify as a measured wrap negative.
    async () => ({ row: 1, col: 61 }),
  ]
  for (const queryCursorPosition of cases) {
    const result = await byId("text.wrap").term(app({ cols: 61, queryMode: async () => "set", queryCursorPosition }))
    expect(result.observation).toMatchObject({
      outcome: "inconclusive",
      reason: "insufficient-evidence",
      assertionType: "query_reply",
    })
    expect(result.assertions).toBeUndefined()
  }

  const wrongTarget = await byId("text.wrap").term(
    app({
      cols: 61,
      queryMode: async () => "set",
      queryCursorPosition: cursorQueue({ row: 1, col: 1 }, { row: 1, col: 61 }, { row: 1, col: 61 }),
    }),
  )
  expect(wrongTarget.observation).toMatchObject({ outcome: "unsupported", assertionType: "query_reply" })
  expect(wrongTarget.assertions).toMatchObject([{ kind: "negative" }])

  const missingHome = await byId("text.wrap").term(
    app({ cols: 61, queryMode: async () => "set", queryCursorPosition: cursorQueue(null) }),
  )
  expect(missingHome.observation).toBeUndefined()
  expect(missingHome.tests).toEqual([{ id: "criterion", status: "test-failure", reason: "no-response" }])

  const missingControl = await byId("text.wrap").term(
    app({ cols: 61, queryMode: async () => "set", queryCursorPosition: cursorQueue({ row: 1, col: 1 }, null) }),
  )
  expect(missingControl.observation).toBeUndefined()
  expect(missingControl.tests).toEqual([{ id: "criterion", status: "test-failure", reason: "no-response" }])

  const missingTarget = await byId("text.wrap").term(
    app({
      cols: 61,
      queryMode: async () => "set",
      queryCursorPosition: cursorQueue({ row: 1, col: 1 }, { row: 1, col: 61 }),
    }),
  )
  expect(missingTarget.observation).toBeUndefined()
  expect(missingTarget.tests).toEqual([{ id: "criterion", status: "test-failure", reason: "no-response" }])

  for (const [mode, reason] of [
    ["reset", "insufficient-evidence"],
    ["unknown", "insufficient-evidence"],
    [null, "no-response"],
  ] as const) {
    const writes: string[] = []
    const result = await byId("text.wrap").term(
      app({
        cols: 61,
        write: (s) => writes.push(s),
        queryMode: async () => mode,
        queryCursorPosition: async () => {
          throw new Error("queried before DECAWM setup was qualified")
        },
      }),
    )
    if (mode === null) {
      expect(result.observation).toBeUndefined()
      expect(result.tests).toEqual([{ id: "criterion", status: "test-failure", reason: "DECAWM setup did not reply" }])
    } else {
      expect(result.observation, String(mode)).toMatchObject({
        outcome: "inconclusive",
        reason,
        assertionType: "query_reply",
      })
    }
    expect(writes, String(mode)).toEqual([])
  }
})

test("text.tab and text.hts grade the combined HT/HTS fixture from qualified sequential CPRs", async () => {
  for (const id of ["text.tab", "text.hts"]) {
    const writes: string[] = []
    const supported = await byId(id).term(
      app({
        cols: 80,
        rows: 24,
        write: (s) => writes.push(s),
        queryCursorPosition: cursorQueue({ row: 1, col: 1 }, { row: 1, col: 9 }, { row: 1, col: 6 }),
      }),
    )
    expect(supported.observation, id).toMatchObject({ outcome: "supported", assertionType: "query_reply" })
    expect(supported.assertions?.[0], id).toMatchObject({ kind: "positive" })
    expect(supported.assertions?.[0]?.expected, id).toContain("combined HT/HTS fixture")
    expect(writes[0], id).toBe("\x1b[3g\x1b[1;1H")
    expect(writes[1], id).toBe("\x1b[1;9H\x1bH\x1b[1;1H")
    expect(writes[2], id).toBe("\t")
    expect(writes[3], id).toBe("\x1b[1;6H\x1bH\x1b[1;1H")
    expect(writes[4], id).toBe("\t")
    expect(writes.at(-1), id).toContain("\x1b[1;73H\x1bH")

    // A constant column-9 provider is indistinguishable from an unmeasured baseline.
    const spoofed = await byId(id).term(app({ cols: 80, queryCursorPosition: async () => ({ row: 1, col: 9 }) }))
    expect(spoofed.observation, id).toMatchObject({
      outcome: "inconclusive",
      reason: "insufficient-evidence",
      assertionType: "query_reply",
    })
    expect(spoofed.assertions, id).toBeUndefined()

    // A genuine ignored owned stop remains a negative once home and comparison are both qualified.
    const ignored = await byId(id).term(
      app({ cols: 80, queryCursorPosition: cursorQueue({ row: 1, col: 1 }, { row: 1, col: 9 }, { row: 1, col: 9 }) }),
    )
    expect(ignored.observation, id).toMatchObject({ outcome: "unsupported", assertionType: "query_reply" })
    expect(ignored.assertions, id).toMatchObject([{ kind: "negative" }])

    const unqualified = await byId(id).term(app({ cols: 80, queryCursorPosition: async () => ({ row: 1, col: 6 }) }))
    expect(unqualified.observation, id).toMatchObject({
      outcome: "inconclusive",
      reason: "insufficient-evidence",
      assertionType: "query_reply",
    })

    const missing = await byId(id).term(app({ cols: 80, queryCursorPosition: cursorQueue(null) }))
    expect(missing.observation, id).toBeUndefined()
    expect(missing.tests, id).toEqual([{ id: "criterion", status: "test-failure", reason: "no-response" }])
  }
})

test("tab combined fixture declines too-small geometry before any write or query", async () => {
  for (const id of ["text.tab", "text.hts"]) {
    for (const cols of [5, 8]) {
      const writes: string[] = []
      const result = await byId(id).term(
        app({
          rows: 24,
          cols,
          write: (s) => writes.push(s),
          queryCursorPosition: async () => {
            throw new Error(`${id} queried before the size guard`)
          },
        }),
      )
      expect(result.observation, `${id} cols=${cols}`).toBeUndefined()
      expect(result, `${id} cols=${cols}`).toMatchObject({
        tests: [
          expect.objectContaining({
            status: "test-todo",
            reason: `Text fixture needs at least 1x9; measured 24x${cols}`,
          }),
        ],
      })
      expect(writes, `${id} cols=${cols}`).toEqual([])
    }
  }
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
  expect(result.observation).toBeUndefined()
  expect(result).toMatchObject({
    tests: [expect.objectContaining({ status: "test-todo", reason: "Text fixture needs at least 1x9; measured 24x5" })],
  })
  expect(small).toEqual([])
})

test("tab and Unicode size refusals record no feature measurement or writes", async () => {
  for (const [id, reason] of [
    ["text.tbc", "Tab fixture needs at least 34 columns"],
    ["text.cht", "Tab fixture needs at least 21 columns"],
    ["text.cbt", "Tab fixture needs at least 21 columns"],
    ["unicode.tab-stops", "Fixture needs at least 10 columns"],
    ["unicode.wrap-boundary", "Wide-wrap fixture needs at least 2x2, measured 1x1"],
    ["unicode.east-asian-ambiguous", "Fixture needs at least 3 columns"],
    ["unicode.grapheme-cursor", "Fixture needs at least 3 columns"],
  ] as const) {
    const writes: string[] = []
    const result = await byId(id).term(app({ cols: 1, rows: 1, write: (sequence) => writes.push(sequence) }))
    expect(result.observation, id).toBeUndefined()
    expect(result, id).toMatchObject({
      tests: [expect.objectContaining({ status: "test-todo", reason })],
    })
    expect(writes, id).toEqual([])
  }
})

test("remaining text fixtures decline a 1x1 grid before any write or width query", async () => {
  for (const [id, reason] of [
    ["text.basic", "Text fixture needs at least 1x6; measured 1x1"],
    ["text.newline", "Text fixture needs at least 4x5; measured 1x1"],
    ["text.tab", "Text fixture needs at least 1x9; measured 1x1"],
    ["text.wide.emoji", "Text fixture needs at least 1x3; measured 1x1"],
    ["text.wide.cjk", "Text fixture needs at least 1x3; measured 1x1"],
    [
      "text.overwrite",
      "text.overwrite: no owned capture adapter is installed in this run, so the region fixture cannot be read back",
    ],
    ["text.cr", "Text fixture needs at least 1x3; measured 1x1"],
    ["text.backspace", "Text fixture needs at least 1x5; measured 1x1"],
    ["text.index", "Text fixture needs at least 4x5; measured 1x1"],
    ["text.next-line", "Text fixture needs at least 4x5; measured 1x1"],
    [
      "text.reverse-index-scroll",
      "text.reverse-index-scroll: no owned capture adapter is installed in this run, so the region fixture cannot be read back",
    ],
    ["text.combining", "Text fixture needs at least 1x3; measured 1x1"],
    ["text.wide.emoji-flags", "Text fixture needs at least 1x4; measured 1x1"],
    ["text.wide.emoji-vs16", "Text fixture needs at least 1x3; measured 1x1"],
    ["text.wide.emoji-zwj", "Text fixture needs at least 1x4; measured 1x1"],
  ] as const) {
    const definition = textProbes.find((probe) => probe.id === id)
    if (!definition?.term) throw new Error(`Missing app callback ${id}`)
    const writes: string[] = []
    expect(definition.termNeedsGeometry, id).toBe(true)
    const result = await definition.term(
      app({
        rows: 1,
        cols: 1,
        write: (sequence) => writes.push(sequence),
        measureRenderedWidth: async () => {
          throw new Error(`${id} measured width before size guard`)
        },
        queryCursorPosition: async () => {
          throw new Error(`${id} queried before size guard`)
        },
      }),
    )
    expect(result.observation, id).toBeUndefined()
    expect(result, id).toMatchObject({
      tests: [expect.objectContaining({ status: "test-todo", reason })],
    })
    expect(writes, id).toEqual([])
  }
})

test("headless wrap uses initialized 61 columns and declines a one-row grid", () => {
  const textWrites: string[] = []
  byId("text.wrap").lib(headless({ cols: 61, feed: (sequence) => textWrites.push(sequence) }))
  expect(textWrites).toEqual(["\x1b[2J\x1b[H", "X".repeat(62)])
  const unicodeWrites: string[] = []
  let phase = "empty"
  const blank = headless().getCell(0, 0)
  const unicodeResult = byId("unicode.wrap-boundary").lib(
    headless({
      cols: 61,
      feed(sequence) {
        unicodeWrites.push(sequence)
        if (sequence.includes("A".repeat(61))) phase = "seed"
        else if (sequence === "\x1b[1;61H") phase = "setup"
        else if (sequence === "中") phase = "sample"
      },
      getCell: (row, col) => {
        if (phase === "seed") return { ...blank, char: "A", wide: false }
        if (phase === "sample" && row === 0 && col === 0) return { ...blank, char: "A", wide: false }
        if (phase === "sample" && row === 1 && col === 0) return { ...blank, char: "中", wide: true }
        if (phase === "sample" && row === 0 && col === 60) return { ...blank, char: "中", wide: true }
        return { ...blank, char: "", wide: false }
      },
      getCursor: () => ({ x: phase === "setup" ? 60 : 0, y: 0, visible: true, style: null }),
    }),
  )
  expect(unicodeResult.observation).toMatchObject({ outcome: "supported", assertionType: "buffer_state" })
  expect(unicodeWrites).toContainEqual("A".repeat(61))
  expect(unicodeWrites).toContainEqual("\x1b[1;61H")
  expect(unicodeWrites).toContainEqual("中")
  const tooShort: string[] = []
  const result = byId("text.wrap").lib(
    headless({
      cols: 61,
      getScrollback: () => ({ viewportOffset: 0, totalLines: 1, screenLines: 1 }),
      feed: (s) => tooShort.push(s),
    }),
  )
  expect(result.observation).toBeUndefined()
  expect(result.tests).toEqual([{ id: "criterion", status: "test-todo", reason: "insufficient-evidence" }])
  expect(tooShort).toEqual([])
  const unicodeTooShort: string[] = []
  const unicodeShortResult = byId("unicode.wrap-boundary").lib(
    headless({
      cols: 61,
      getScrollback: () => ({ viewportOffset: 0, totalLines: 1, screenLines: 1 }),
      feed: (s) => unicodeTooShort.push(s),
    }),
  )
  expect(unicodeShortResult.observation).toBeUndefined()
  expect(unicodeShortResult.tests).toEqual([
    { id: "criterion", status: "test-todo", reason: "Need at least two columns and two screen rows" },
  ])
  expect(unicodeTooShort).toEqual([])
})

test("tab fixtures restore after a failed cursor query", async () => {
  // text.reverse-index-scroll is no longer here: it is a region-readback kind row now, so its app arm
  // asks the terminal's pixel report rather than the cursor, and a cursor-transport failure never
  // reaches it (@cto Q2(b), 2026-10-12).
  for (const id of ["text.tab", "text.hts", "unicode.tab-stops"]) {
    const writes: string[] = []
    await expect(
      byId(id).term(
        app({
          rows: 12,
          cols: 61,
          write: (sequence) => writes.push(sequence),
          queryCursorPosition: async () => {
            throw new Error("cursor transport failed")
          },
        }),
      ),
    ).rejects.toThrow("cursor transport failed")
    expect(writes.join("")).toContain("\x1b[3g")
    expect(writes.at(-1)).toContain("\x1b[1;57H\x1bH")
  }
})

test("tab combined fixture propagates a cleanup failure instead of swallowing it", async () => {
  for (const id of ["text.tab", "text.hts"]) {
    await expect(
      byId(id).term(
        app({
          rows: 24,
          cols: 61,
          write: (sequence) => {
            if (sequence.includes("\x1b[1;57H\x1bH")) throw new Error("restore failed")
          },
          queryCursorPosition: cursorQueue({ row: 1, col: 9 }, { row: 1, col: 6 }),
        }),
      ),
    ).rejects.toThrow("restore failed")
  }
})

test("headless tab and reverse-index fixtures restore after parser inspection throws", () => {
  for (const id of ["text.tab", "unicode.tab-stops", "text.reverse-index-scroll"]) {
    const feeds: string[] = []
    expect(() =>
      byId(id).lib(
        headless({
          cols: 61,
          feed: (sequence) => feeds.push(sequence),
          getCell: () => {
            throw new Error("parser inspection failed")
          },
        }),
      ),
    ).toThrow("parser inspection failed")
    if (id === "text.reverse-index-scroll") expect(feeds.at(-1)).toBe("\x1b[r")
    else expect(feeds.at(-1)).toContain("\x1b[1;57H\x1bH")
  }
})

/**
 * @cto Q2(b), 2026-10-12: the row's reset restores the FULL-SCREEN region, and it must not be "" or
 * every later probe sharing this terminal inherits margins 3-10. Measured on the reference surface
 * rather than asserted as a string: once the row's own termless arm has run, a reverse index at the
 * SCREEN top must scroll the whole screen - which it can only do while the margins are the default
 * 1..rows again.
 */
test("text.reverse-index-scroll leaves default margins so a later probe does not inherit 3-10", () => {
  const row = textReadbackRows.find((entry) => entry.id === "text.reverse-index-scroll")
  expect(row, "the kind table names text.reverse-index-scroll").toBeDefined()
  if (!row) return
  expect(row.reset, "the row restores the full-screen region").toBe("\x1b[r")
  const ctx = libProbeSource(createSemanticSurface({ rows: 24, cols: 80 }))
  expect(regionReadbackProbe(row).lib!(ctx).observation?.outcome).toBe("supported")
  // The row left "KEEPS!" on screen row 1. With default margins a screen-top RI scrolls it away; while
  // margins 3-10 stand, row 1 sits ABOVE the region and cannot move.
  expect(ctx.getCell(0, 0).char, "the control row is exposed to a screen scroll").toBe("K")
  ctx.feed("\x1b[H\x1bM")
  expect(ctx.getCell(0, 0).char, "a screen-top RI scrolled the whole screen").toBe(" ")
})

/**
 * @cto Q2(b): minRows comes from the region bottom (10) plus the kind's own cursor and sentinel rows,
 * declared explicitly exactly as erase.ed-scroll-region does - and the kind ENFORCES it at LOAD, so a
 * terminal smaller than the fixture addresses is refused rather than driven.
 */
test("text.reverse-index-scroll declares the ten rows its 3-10 scroll region needs", () => {
  const row = textReadbackRows.find((entry) => entry.id === "text.reverse-index-scroll")
  expect(row, "the kind table names text.reverse-index-scroll").toBeDefined()
  if (!row) return
  // It compares four six-column rows with its cursor parked on row 5 and its witness on row 6, so the
  // derived need is 6 rows by 6 + the family's two-column margin = 8 columns; the ten rows it declares
  // are for the scroll region, not the compared grid.
  expect(() => regionReadbackProbe({ ...row, minRows: 5 })).toThrow(/explicit minRows 5 is below the 6 rows/)
  expect(() => regionReadbackProbe({ ...row, minCols: 7 })).toThrow(/explicit minCols 7 is below the 8 columns/)
  expect(() => regionReadbackProbe({ ...row, minRows: 10, minCols: 8 })).not.toThrow()
})

test("invalid headless geometry never feeds wrap or tab fixtures", () => {
  for (const id of ["text.wrap", "text.tab", "unicode.wrap-boundary", "unicode.tab-stops"]) {
    for (const cols of [Number.NaN, Number.POSITIVE_INFINITY, 61.5]) {
      const feeds: string[] = []
      const result = byId(id).lib(headless({ cols, feed: (sequence) => feeds.push(sequence) }))
      expect(result.observation, `${id} cols=${cols}`).toBeUndefined()
      expect(result, `${id} cols=${cols}`).toMatchObject({
        tests: [
          expect.objectContaining({
            status: "test-todo",
            reason:
              id === "unicode.wrap-boundary"
                ? "Need at least two columns and two screen rows"
                : id === "unicode.tab-stops"
                  ? "Need at least ten measured columns"
                  : "insufficient-evidence",
          }),
        ],
      })
      expect(feeds).toEqual([])
    }
  }
})

// --- Emoji width: headless fixture that models the actual differentiated writes -----------------
const EMOJI_WIDTH_SAMPLES = {
  "text.wide.emoji-flags": "\u{1F1FA}\u{1F1F8}",
  "text.wide.emoji-vs16": "\u263A\uFE0F",
  "text.wide.emoji-zwj": "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}",
} as const
type EmojiWidthId = keyof typeof EMOJI_WIDTH_SAMPLES
const EMOJI_HOME = "\x1b[1;1H\x1b[2K"
const EMOJI_SUPPLEMENTARY = "\u{1F30D}"

/**
 * Minimal grid emulator: cursor moves, line erase and literal writes are applied to cells with
 * declared glyph widths, so the control cases exercise observed writes rather than returning an
 * oracle value for the expected target position.
 */
function emojiTerminal(
  id: EmojiWidthId,
  targetWidth: number,
  opts: {
    cols?: number
    controlSurrogate?: boolean
    targetSurrogate?: boolean
    markerMode?: "normal" | "drop" | "double"
    ignoreErase?: boolean
    staleCells?: boolean
    staleCursor?: { x: number; y: number }
    cursorSkew?: number
    feeds?: string[]
  } = {},
): LibProbeSource {
  const cols = opts.cols ?? 80
  const sample: string = EMOJI_WIDTH_SAMPLES[id]
  const blank = { ...headless().getCell(0, 0), char: "", wide: false }
  const cells = new Map<string, ReturnType<LibProbeSource["getCell"]>>()
  let cursor = { x: 0, y: 0 }
  const put = (row: number, col: number, over: Partial<ReturnType<LibProbeSource["getCell"]>>) =>
    cells.set(`${row},${col}`, { ...blank, ...over })
  const glyph = (cluster: string, width: number) => {
    put(cursor.y, cursor.x, { char: cluster, wide: width === 2 })
    for (let i = 1; i < width; i += 1) put(cursor.y, cursor.x + i, { char: "", wide: false })
    cursor = { x: cursor.x + width, y: cursor.y }
  }
  const literal = (text: string) => {
    const isTarget = text.startsWith(sample)
    const scalars = Array.from(text)
    let index = 0
    while (index < scalars.length) {
      const rest = scalars.slice(index).join("")
      if (rest.startsWith(EMOJI_SUPPLEMENTARY)) {
        glyph(opts.controlSurrogate ? "\ud83c" : EMOJI_SUPPLEMENTARY, opts.controlSurrogate ? 1 : 2)
        index += Array.from(EMOJI_SUPPLEMENTARY).length
        continue
      }
      if (rest.startsWith(sample)) {
        glyph(opts.targetSurrogate ? "\ud83d" : sample, opts.targetSurrogate ? 1 : targetWidth)
        index += Array.from(sample).length
        continue
      }
      const scalar = scalars[index]
      if (scalar === undefined) throw new Error(`fake terminal: no scalar at ${index} of ${scalars.length}`)
      const isSentinel = scalar === "X" && index === scalars.length - 1 && isTarget
      if (isSentinel && opts.markerMode === "drop") {
        index += 1
        continue
      }
      glyph(scalar, scalar === "\u200D" ? 0 : 1)
      if (isSentinel && opts.markerMode === "double") glyph("X", 1)
      index += 1
    }
  }
  const feed = (sequence: string) => {
    opts.feeds?.push(sequence)
    for (const token of sequence.split(/(\x1b\[[0-9;]*[A-Za-z])/)) {
      if (!token) continue
      const move = /^\x1b\[(\d+);(\d+)H$/.exec(token)
      if (move) {
        cursor = { x: Number(move[2]) - 1, y: Number(move[1]) - 1 }
        continue
      }
      if (token === "\x1b[2K") {
        if (!opts.ignoreErase) for (let col = 0; col < cols; col += 1) cells.delete(`${cursor.y},${col}`)
        continue
      }
      if (token.startsWith("\x1b")) continue
      literal(token)
    }
  }
  return headless({
    cols,
    feed,
    getCell: opts.staleCells ? () => blank : (row, col) => cells.get(`${row},${col}`) ?? blank,
    getCursor: opts.staleCursor
      ? () => ({ ...opts.staleCursor!, visible: true, style: null })
      : () => ({ x: cursor.x + (opts.cursorSkew ?? 0), y: cursor.y, visible: true, style: null }),
  })
}

test("headless emoji width measures the declared sample at two columns from real writes", () => {
  for (const id of Object.keys(EMOJI_WIDTH_SAMPLES) as EmojiWidthId[]) {
    const result = byId(id).lib(emojiTerminal(id, 2))
    expect(result.observation, id).toMatchObject({ outcome: "supported", assertionType: "buffer_state" })
    expect(result.assertions, id).toMatchObject([{ kind: "positive" }])
    expect(JSON.parse(result.response ?? ""), id).toMatchObject({ width: 2, markerColumns: [2] })
  }
})

test("headless emoji width concludes unsupported for a genuinely different measured width", () => {
  for (const width of [1, 4]) {
    const result = byId("text.wide.emoji-flags").lib(emojiTerminal("text.wide.emoji-flags", width))
    expect(result.observation, `flags width ${width}`).toMatchObject({
      outcome: "unsupported",
      assertionType: "buffer_state",
    })
    expect(result.assertions, `flags width ${width}`).toMatchObject([{ kind: "negative" }])
    expect(JSON.parse(result.response ?? ""), `flags width ${width}`).toMatchObject({ width })
  }
  const six = byId("text.wide.emoji-zwj").lib(emojiTerminal("text.wide.emoji-zwj", 6))
  expect(six.observation).toMatchObject({ outcome: "unsupported", assertionType: "buffer_state" })
  expect(JSON.parse(six.response ?? "")).toMatchObject({ width: 6, markerColumns: [6] })
})

test("headless emoji width keeps unqualified or ambiguous readbacks inconclusive", () => {
  const id: EmojiWidthId = "text.wide.emoji-flags"
  const inconclusive = (ctx: LibProbeSource, why: string) => {
    const result = byId(id).lib(ctx)
    expect(result.observation, why).toMatchObject({ outcome: "inconclusive", reason: "insufficient-evidence" })
    expect(result.assertions, why).toBeUndefined()
    return result
  }

  inconclusive(emojiTerminal(id, 2, { staleCells: true }), "stale or missing cells")
  inconclusive(emojiTerminal(id, 2, { staleCursor: { x: 2, y: 0 } }), "stale cursor")
  inconclusive(emojiTerminal(id, 2, { ignoreErase: true }), "ignored erase")
  inconclusive(emojiTerminal(id, 2, { cursorSkew: 1 }), "cursor/marker disagreement")
  expect(inconclusive(emojiTerminal(id, 2, { markerMode: "drop" }), "missing marker").note).toMatch(/not exposed/)
  expect(inconclusive(emojiTerminal(id, 2, { markerMode: "double" }), "duplicate marker").note).toMatch(/duplicated/)
  expect(inconclusive(emojiTerminal(id, 2, { controlSurrogate: true }), "supplementary surrogate").note).toMatch(
    /surrogate/i,
  )
  expect(inconclusive(emojiTerminal(id, 2, { targetSurrogate: true }), "target surrogate").note).toMatch(/surrogate/i)
})

test("headless emoji width refuses narrow geometry before any write", () => {
  for (const [id, cols] of [
    ["text.wide.emoji-flags", 5],
    ["text.wide.emoji-vs16", 3],
    ["text.wide.emoji-zwj", 7],
  ] as const) {
    const feeds: string[] = []
    const result = byId(id).lib(headless({ cols, feed: (sequence) => feeds.push(sequence) }))
    expect(result.observation, id).toBeUndefined()
    expect(result, id).toMatchObject({
      tests: [
        expect.objectContaining({
          status: "test-todo",
          reason: `Emoji width fixture needs at least ${cols + 1} columns to place the sample and sentinel without wrapping; measured ${cols}`,
        }),
      ],
    })
    expect(feeds, id).toEqual([])
  }
})

test("headless emoji width restores the owned row and propagates unexpected failures", () => {
  const feeds: string[] = []
  byId("text.wide.emoji-flags").lib(emojiTerminal("text.wide.emoji-flags", 2, { feeds }))
  expect(feeds.at(-1)).toBe(EMOJI_HOME)
  expect(feeds.length).toBeGreaterThan(1)

  expect(() =>
    byId("text.wide.emoji-flags").lib(
      headless({
        cols: 80,
        getCell: () => {
          throw new Error("grid read failed")
        },
      }),
    ),
  ).toThrow("grid read failed")
})
