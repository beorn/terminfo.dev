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
    expect(measured.observation, id).toMatchObject({ outcome: "supported", evidence: "query" })
    expect(measured.assertions, id).toMatchObject([{ kind: "positive" }])
    const invalid = await probe.term(app({ measureRenderedWidth: async (sample) => (sample === "AA" ? 1 : 2) }))
    expect(invalid.observation, id).toMatchObject({ outcome: "inconclusive", reason: "insufficient-evidence" })
    expect(invalid.assertions, id).toBeUndefined()
  }
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
  const supported = probe.termless(context)
  expect(supported.observation).toMatchObject({ outcome: "supported", evidence: "parser-state" })
  expect(supported.assertions).toMatchObject([{ kind: "positive" }])
  const missing = probe.termless(headless({ getCell: () => ({ ...blank, char: "🎉", wide: true }) }))
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
    expect(newline.observation, `LF final ${row};${col}`).toMatchObject({ outcome, evidence: "query" })
    expect(newline.assertions).toMatchObject([{ kind: outcome === "supported" ? "positive" : "negative" }])
    expect(JSON.parse(newline.response ?? "")).toMatchObject({ before: { row: 3, col: 5 }, pos: { row, col } })
  }
  const uncalibrated = await byId("text.newline").term(app({ queryCursorPosition: async () => ({ row: 4, col: 5 }) }))
  expect(uncalibrated.observation).toMatchObject({ outcome: "inconclusive", reason: "insufficient-evidence" })
  const basic = await byId("text.basic").term(app({ queryCursorPosition: async () => ({ row: 1, col: 6 }) }))
  expect(basic.observation).toMatchObject({ outcome: "inconclusive", evidence: "query" })
  expect(basic.assertions).toBeUndefined()
})

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

  const sample = "👨‍👩‍👧"
  const blank = headless().getCell(0, 0)
  let phase = "empty"
  const headlessResult = probe.termless(
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
  expect(headlessResult.observation).toMatchObject({ outcome: "supported", evidence: "parser-state" })
  expect(headlessResult.assertions).toMatchObject([{ kind: "positive", observed: headlessResult.response }])
})

test("Unicode width and tab callbacks retain measured state and query evidence", async () => {
  const blank = headless().getCell(0, 0)
  let ambiguousPhase = "empty"
  const ambiguous = byId("unicode.east-asian-ambiguous").termless(
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
  expect(ambiguous.observation).toMatchObject({ outcome: "supported", evidence: "parser-state" })
  expect(JSON.parse(ambiguous.response ?? "")).toMatchObject({ before: ["A", "Q"], after: ["●", "X", "", ""] })

  let tabPhase = "empty"
  const tab = byId("unicode.tab-stops").termless(
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
  expect(tab.observation).toMatchObject({ outcome: "supported", evidence: "parser-state" })
  expect(JSON.parse(tab.response ?? "")).toMatchObject({ before: ["A", "B"], after: { 8: "B" } })

  const appTab = await byId("unicode.tab-stops").term(app({ queryCursorPosition: async () => ({ row: 1, col: 10 }) }))
  expect(appTab.observation).toMatchObject({ outcome: "supported", evidence: "behavior" })
  expect(appTab.response).toBe(JSON.stringify({ row: 1, col: 10 }))

  const appWrap = await byId("unicode.wrap-boundary").term(
    app({ rows: 2, cols: 4, queryCursorPosition: async () => ({ row: 2, col: 2 }) }),
  )
  expect(appWrap.observation).toMatchObject({ outcome: "supported", evidence: "behavior" })
  expect(appWrap.response).toBe(JSON.stringify({ row: 2, col: 2 }))
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

test("remaining text fixtures decline a 1x1 grid before any write or width query", async () => {
  for (const id of [
    "text.basic",
    "text.newline",
    "text.tab",
    "text.wide.emoji",
    "text.wide.cjk",
    "text.overwrite",
    "text.cr",
    "text.backspace",
    "text.index",
    "text.next-line",
    "text.reverse-index-scroll",
    "text.combining",
    "text.wide.emoji-flags",
    "text.wide.emoji-vs16",
    "text.wide.emoji-zwj",
  ]) {
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
    expect(result.observation, id).toMatchObject({
      outcome: "inconclusive",
      reason: "insufficient-evidence",
      evidence: "none",
    })
    expect(writes, id).toEqual([])
  }
})

test("headless wrap uses initialized 61 columns and declines a one-row grid", () => {
  const textWrites: string[] = []
  byId("text.wrap").termless(headless({ cols: 61, feed: (sequence) => textWrites.push(sequence) }))
  expect(textWrites).toEqual(["\x1b[2J\x1b[H", "X".repeat(62)])
  const unicodeWrites: string[] = []
  let phase = "empty"
  const blank = headless().getCell(0, 0)
  const unicodeResult = byId("unicode.wrap-boundary").termless(
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
  expect(unicodeResult.observation).toMatchObject({ outcome: "supported", evidence: "parser-state" })
  expect(unicodeWrites).toContainEqual("A".repeat(61))
  expect(unicodeWrites).toContainEqual("\x1b[1;61H")
  expect(unicodeWrites).toContainEqual("中")
  const tooShort: string[] = []
  const result = byId("text.wrap").termless(
    headless({
      cols: 61,
      getScrollback: () => ({ viewportOffset: 0, totalLines: 1, screenLines: 1 }),
      feed: (s) => tooShort.push(s),
    }),
  )
  expect(result.observation).toMatchObject({ outcome: "inconclusive", reason: "insufficient-evidence" })
  expect(tooShort).toEqual([])
  const unicodeTooShort: string[] = []
  const unicodeShortResult = byId("unicode.wrap-boundary").termless(
    headless({
      cols: 61,
      getScrollback: () => ({ viewportOffset: 0, totalLines: 1, screenLines: 1 }),
      feed: (s) => unicodeTooShort.push(s),
    }),
  )
  expect(unicodeShortResult.observation).toMatchObject({
    outcome: "inconclusive",
    reason: "insufficient-evidence",
    evidence: "none",
  })
  expect(unicodeTooShort).toEqual([])
})

test("tab fixtures and reverse-index region restore after a failed cursor query", async () => {
  for (const id of ["text.tab", "unicode.tab-stops", "text.reverse-index-scroll"]) {
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
    if (id === "text.reverse-index-scroll") expect(writes.at(-1)).toBe("\x1b[r")
    else {
      expect(writes.join("")).toContain("\x1b[3g")
      expect(writes.at(-1)).toContain("\x1b[1;57H\x1bH")
    }
  }
})

test("headless tab and reverse-index fixtures restore after parser inspection throws", () => {
  for (const id of ["text.tab", "unicode.tab-stops", "text.reverse-index-scroll"]) {
    const feeds: string[] = []
    expect(() =>
      byId(id).termless(
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

test("invalid headless geometry never feeds wrap or tab fixtures", () => {
  for (const id of ["text.wrap", "text.tab", "unicode.wrap-boundary", "unicode.tab-stops"]) {
    for (const cols of [Number.NaN, Number.POSITIVE_INFINITY, 61.5]) {
      const feeds: string[] = []
      const result = byId(id).termless(headless({ cols, feed: (sequence) => feeds.push(sequence) }))
      expect(result.observation, `${id} cols=${cols}`).toMatchObject({
        outcome: "inconclusive",
        reason: "insufficient-evidence",
        evidence: "none",
      })
      expect(feeds).toEqual([])
    }
  }
})
