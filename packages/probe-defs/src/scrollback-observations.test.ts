/**
 * @failure A silent CSI 18 t reply invents 24 rows and scrollback measures the wrong grid.
 * @level l1
 * @consumer App scrollback callback on a measured owned terminal.
 * @testonly none
 */
import { expect, test } from "vitest"
import { scrollbackProbes } from "./scrollback.ts"
import type { TermContext, TermlessContext } from "./types.ts"

function headless(overrides: Partial<TermlessContext> = {}): TermlessContext {
  return {
    cols: 61,
    feed() {},
    feedCapture: () => "",
    getCell: () => ({
      char: " ",
      bold: false,
      dim: false,
      italic: false,
      underline: false,
      strikethrough: false,
      inverse: false,
      hidden: false,
      blink: false,
      fg: null,
      bg: null,
      wide: false,
    }),
    getCursor: () => ({ x: 0, y: 0, visible: true, style: null }),
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
    ...overrides,
  }
}

test("accumulate uses measured rows and does not infer 24 after CSI silence", async () => {
  const probe = scrollbackProbes.find((entry) => entry.id === "scrollback.accumulate")
  if (!probe?.term) throw new Error("missing scrollback.accumulate app callback")
  expect(probe.termNeedsGeometry).toBe(true)
  const writes: string[] = []
  const queries: string[] = []
  const context: TermContext = {
    rows: 37,
    cols: 61,
    write: (s) => writes.push(s),
    queryCursorPosition: async () => ({ row: 37, col: 1 }),
    measureRenderedWidth: async () => null,
    query: async () => null,
    queryWithSentinel: async (s) => {
      queries.push(s)
      return null
    },
    queryOutcome: async () => ({ match: null, reason: "timeout", raw: "", rawBase64: "" }),
    queryWithSentinelOutcome: async () => ({ match: null, reason: "timeout", raw: "", rawBase64: "" }),
    queryMode: async () => null,
  }
  await probe.term(context)
  expect(queries).toEqual([])
  expect(writes.filter((s) => s.startsWith("line-"))).toHaveLength(47)
})

test("DECSTBM reset uses measured row count beyond 999 and declines a short grid before writes", async () => {
  const probe = scrollbackProbes.find((entry) => entry.id === "scrollback.decstbm-reset")
  if (!probe?.term) throw new Error("missing scrollback.decstbm-reset app callback")
  const writes: string[] = []
  const context: TermContext = {
    rows: 1200,
    cols: 61,
    write: (s) => writes.push(s),
    queryCursorPosition: async () => ({ row: 1200, col: 1 }),
    measureRenderedWidth: async () => null,
    query: async () => null,
    queryWithSentinel: async () => null,
    queryOutcome: async () => ({ match: null, reason: "timeout", raw: "", rawBase64: "" }),
    queryWithSentinelOutcome: async () => ({ match: null, reason: "timeout", raw: "", rawBase64: "" }),
    queryMode: async () => null,
  }
  await probe.term(context)
  expect(writes).toContain("\x1b[1200B")
  writes.length = 0
  const result = await probe.term({ ...context, rows: 9 })
  expect(result.observation).toMatchObject({
    outcome: "inconclusive",
    reason: "insufficient-evidence",
    evidence: "none",
  })
  expect(writes).toEqual([])
})

test("remaining scrollback fixtures decline too-small geometry before writing", async () => {
  for (const id of [
    "scrollback.total-lines",
    "scrollback.scroll-up",
    "scrollback.reverse-index",
    "scrollback.scroll-down",
    "scrollback.set-region",
    "scrollback.alt-screen",
    "scrollback.decstbm",
  ]) {
    const probe = scrollbackProbes.find((item) => item.id === id)
    if (!probe?.term) throw new Error(`Missing ${id} app callback`)
    const writes: string[] = []
    const context: TermContext = {
      rows: 1,
      cols: 1,
      write: (sequence) => writes.push(sequence),
      queryCursorPosition: async () => {
        throw new Error(`${id} queried before size guard`)
      },
      measureRenderedWidth: async () => null,
      query: async () => null,
      queryWithSentinel: async () => null,
      queryOutcome: async () => ({ match: null, reason: "timeout", raw: "", rawBase64: "" }),
      queryWithSentinelOutcome: async () => ({ match: null, reason: "timeout", raw: "", rawBase64: "" }),
      queryMode: async () => null,
    }
    expect(probe.termNeedsGeometry, id).toBe(true)
    const result = await probe.term(context)
    expect(result.observation, id).toMatchObject({
      outcome: "inconclusive",
      reason: "insufficient-evidence",
      evidence: "none",
    })
    expect(writes, id).toEqual([])
  }
})

test("headless scrollback uses initialized screenLines rather than a 24-row assumption", () => {
  const screenLines = 37
  for (const [id, expectedFeeds] of [
    ["scrollback.accumulate", screenLines + 10],
    ["scrollback.total-lines", screenLines + 10],
  ] as const) {
    const probe = scrollbackProbes.find((item) => item.id === id)
    if (!probe?.termless) throw new Error(`Missing ${id} headless callback`)
    const feeds: string[] = []
    probe.termless(
      headless({
        feed: (sequence) => feeds.push(sequence),
        getScrollback: () => ({ viewportOffset: 0, totalLines: 47, screenLines }),
      }),
    )
    expect(
      feeds.filter((s) => s.startsWith("line ") || s.startsWith("total-")),
      id,
    ).toHaveLength(expectedFeeds)
  }
  const reset = scrollbackProbes.find((item) => item.id === "scrollback.decstbm-reset")
  if (!reset?.termless) throw new Error("Missing decstbm-reset headless callback")
  const result = reset.termless(
    headless({
      feed() {},
      getScrollback: () => ({ viewportOffset: 0, totalLines: 30, screenLines }),
    }),
  )
  expect(result.pass).toBe(false)
})

test("scroll-region and alternate-screen callbacks restore state when the cursor query throws", async () => {
  for (const [id, restore] of [
    ["scrollback.set-region", "\x1b[r"],
    ["scrollback.decstbm", "\x1b[r"],
    ["scrollback.alt-screen", "\x1b[?1049l"],
  ] as const) {
    const probe = scrollbackProbes.find((item) => item.id === id)
    if (!probe?.term) throw new Error(`Missing ${id} app callback`)
    const writes: string[] = []
    let cursorQueries = 0
    const context: TermContext = {
      rows: 12,
      cols: 61,
      write: (sequence) => {
        writes.push(sequence)
        if (id === "scrollback.alt-screen" && sequence === "ALT_SCREEN") throw new Error("screen write failed")
      },
      queryCursorPosition: async () => {
        cursorQueries++
        if (id === "scrollback.alt-screen" && cursorQueries === 1) return { row: 1, col: 19 }
        throw new Error("cursor transport failed")
      },
      measureRenderedWidth: async () => null,
      query: async () => null,
      queryWithSentinel: async () => null,
      queryOutcome: async () => ({ match: null, reason: "timeout", raw: "", rawBase64: "" }),
      queryWithSentinelOutcome: async () => ({ match: null, reason: "timeout", raw: "", rawBase64: "" }),
      queryMode: async () => null,
    }
    await expect(probe.term(context)).rejects.toThrow(
      id === "scrollback.alt-screen" ? "screen write failed" : "cursor transport failed",
    )
    expect(writes.at(-1), id).toBe(restore)
  }
})

test("invalid headless rows and narrow DECSTBM geometry refuse before writes", async () => {
  for (const id of [
    "scrollback.accumulate",
    "scrollback.total-lines",
    "scrollback.scroll-up",
    "scrollback.decstbm-reset",
  ]) {
    const probe = scrollbackProbes.find((item) => item.id === id)
    if (!probe?.termless) throw new Error(`Missing ${id} headless callback`)
    for (const screenLines of [Number.NaN, Number.POSITIVE_INFINITY, 37.5]) {
      const feeds: string[] = []
      const result = probe.termless(
        headless({
          feed: (sequence) => feeds.push(sequence),
          getScrollback: () => ({ viewportOffset: 0, totalLines: 0, screenLines }),
        }),
      )
      expect(result.observation, `${id} rows=${screenLines}`).toMatchObject({
        outcome: "inconclusive",
        reason: "insufficient-evidence",
        evidence: "none",
      })
      expect(feeds).toEqual([])
    }
  }
  const decstbm = scrollbackProbes.find((item) => item.id === "scrollback.decstbm")
  if (!decstbm?.term) throw new Error("Missing scrollback.decstbm app callback")
  const writes: string[] = []
  const result = await decstbm.term({
    rows: 12,
    cols: 1,
    write: (sequence) => writes.push(sequence),
    queryCursorPosition: async () => null,
    measureRenderedWidth: async () => null,
    query: async () => null,
    queryWithSentinel: async () => null,
    queryOutcome: async () => ({ match: null, reason: "timeout", raw: "", rawBase64: "" }),
    queryWithSentinelOutcome: async () => ({ match: null, reason: "timeout", raw: "", rawBase64: "" }),
    queryMode: async () => null,
  })
  expect(result.observation).toMatchObject({ outcome: "inconclusive", evidence: "none" })
  expect(writes).toEqual([])
})

test("alternate-screen entry write failure still sends the exit sequence", async () => {
  const probe = scrollbackProbes.find((item) => item.id === "scrollback.alt-screen")
  if (!probe?.term) throw new Error("Missing scrollback.alt-screen app callback")
  const writes: string[] = []
  const context: TermContext = {
    rows: 12,
    cols: 61,
    write: (sequence) => {
      writes.push(sequence)
      if (sequence === "\x1b[?1049h") throw new Error("entry write failed")
    },
    queryCursorPosition: async () => ({ row: 1, col: 19 }),
    measureRenderedWidth: async () => null,
    query: async () => null,
    queryWithSentinel: async () => null,
    queryOutcome: async () => ({ match: null, reason: "timeout", raw: "", rawBase64: "" }),
    queryWithSentinelOutcome: async () => ({ match: null, reason: "timeout", raw: "", rawBase64: "" }),
    queryMode: async () => null,
  }
  await expect(probe.term(context)).rejects.toThrow("entry write failed")
  expect(writes.at(-1)).toBe("\x1b[?1049l")
})

test("DECSTBM reset retries cleanup after a partial reset write failure", async () => {
  const probe = scrollbackProbes.find((item) => item.id === "scrollback.decstbm-reset")
  if (!probe?.term) throw new Error("Missing scrollback.decstbm-reset app callback")
  const writes: string[] = []
  let resetWrites = 0
  const context: TermContext = {
    rows: 12,
    cols: 61,
    write: (sequence) => {
      writes.push(sequence)
      if (sequence === "\x1b[r" && ++resetWrites === 1) throw new Error("partial reset failed")
    },
    queryCursorPosition: async () => ({ row: 12, col: 1 }),
    measureRenderedWidth: async () => null,
    query: async () => null,
    queryWithSentinel: async () => null,
    queryOutcome: async () => ({ match: null, reason: "timeout", raw: "", rawBase64: "" }),
    queryWithSentinelOutcome: async () => ({ match: null, reason: "timeout", raw: "", rawBase64: "" }),
    queryMode: async () => null,
  }
  await expect(probe.term(context)).rejects.toThrow("partial reset failed")
  expect(writes.at(-1)).toBe("\x1b[r")
  expect(resetWrites).toBe(2)
})
