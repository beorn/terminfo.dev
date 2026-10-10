/**
 * @failure A silent CSI 18 t reply invents 24 rows and scrollback measures the wrong grid.
 * @level l1
 * @consumer App scrollback callback on a measured owned terminal.
 * @testonly none
 */
import { expect, test } from "vitest"
import { scrollbackProbes } from "./scrollback.ts"
import type { ObservationFrame, TermContext, TermlessContext } from "./types.ts"

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

/**
 * @failure RI/SD is reported supported when a blank top row comes from losing the seeded rows.
 * @level l0
 * @consumer Headless Scrollback observations used by the support tables.
 * @testonly none
 */
test.each([
  ["scrollback.reverse-index", ["A", "B", "C"], "\x1b[H\x1bM"],
  ["scrollback.scroll-down", ["LINE1", "LINE2", "LINE3"], "\x1b[T"],
] as const)("%s requires preserved markers after inserting a blank row", (id, markers, target) => {
  const probe = scrollbackProbes.find((item) => item.id === id)
  if (!probe?.termless) throw new Error(`Missing ${id} headless callback`)
  for (const [effect, outcome] of [
    ["shift", "supported"],
    ["noop", "unsupported"],
    ["clear-screen", "inconclusive"],
    ["lost-marker", "inconclusive"],
    ["missing-seed", "inconclusive"],
  ] as const) {
    let cells: string[] = [" ", " ", " ", " "]
    const result = probe.termless(
      headless({
        cols: 5,
        getScrollback: () => ({ viewportOffset: 0, totalLines: 4, screenLines: 4 }),
        feed: (sequence) => {
          if (sequence === markers.join("\r\n")) {
            cells = [...markers, " "]
            if (effect === "missing-seed") cells[1] = "?"
          }
          if (sequence === target) {
            if (effect === "shift" || effect === "lost-marker") cells = [" ", ...markers]
            if (effect === "lost-marker") cells[3] = "?"
            if (effect === "clear-screen") cells = [" ", " ", " ", " "]
          }
        },
        getCell: (row, col) => ({ char: cells[row]?.[col] ?? " " }) as ReturnType<TermlessContext["getCell"]>,
      }),
    )
    expect(result.observation, effect).toMatchObject({ outcome, evidence: "parser-state" })
    if (outcome === "inconclusive") expect(result.assertions, effect).toBeUndefined()
    else expect(result.assertions, effect).toMatchObject([{ kind: outcome === "supported" ? "positive" : "negative" }])
  }
})

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

test("cursor replies do not qualify app scrollback contents or region behavior", async () => {
  for (const id of [
    "scrollback.accumulate",
    "scrollback.total-lines",
    "scrollback.scroll-up",
    "scrollback.reverse-index",
    "scrollback.scroll-down",
    "scrollback.set-region",
    "scrollback.alt-screen",
    "scrollback.decstbm",
    "scrollback.decstbm-reset",
  ]) {
    const definition = scrollbackProbes.find((item) => item.id === id)
    if (!definition?.term) throw new Error(`Missing ${id} app callback`)
    const context: TermContext = {
      rows: 12,
      cols: 61,
      write() {},
      queryCursorPosition: async () => ({ row: 5, col: 5 }),
      measureRenderedWidth: async () => null,
      query: async () => null,
      queryWithSentinel: async () => null,
      queryOutcome: async () => ({ match: null, reason: "timeout", raw: "", rawBase64: "" }),
      queryWithSentinelOutcome: async () => ({ match: null, reason: "timeout", raw: "", rawBase64: "" }),
      queryMode: async () => null,
    }
    const result = await definition.term(context)
    expect(result.observation, id).toMatchObject({
      outcome: "inconclusive",
      reason: "insufficient-evidence",
      evidence: "query",
    })
    expect(result.assertions ?? [], id).toEqual([])
    expect(result.response, id).toBeTruthy()
  }
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

test("interior-region SU grades measured movement, a no-op, and invalid controls", () => {
  const probe = scrollbackProbes.find((item) => item.id === "scrollback.scroll-up")
  if (!probe?.termless) throw new Error("missing scroll-up callback")
  for (const [effect, outcome] of [
    ["shift", "supported"],
    ["noop", "unsupported"],
    ["unexpected", "inconclusive"],
    ["outer", "inconclusive"],
    ["history", "inconclusive"],
    ["missing-seed", "inconclusive"],
  ] as const) {
    const cells = [" ", " ", " ", " ", " "]
    const feeds: string[] = []
    let history = 0
    const result = probe.termless(
      headless({
        cols: 4,
        getScrollback: () => ({ viewportOffset: 0, totalLines: 5 + history, screenLines: 5 }),
        feed: (sequence) => {
          feeds.push(sequence)
          const write = /^\x1b\[(\d+);1H([A-Z])$/.exec(sequence)
          if (write) {
            const row = Number(write[1]) - 1
            if (effect !== "missing-seed" || row !== 2) cells[row] = write[2]!
          }
          if (sequence === "\x1b[S") {
            if (effect === "shift" || effect === "outer" || effect === "history") {
              cells[1] = cells[2]!
              cells[2] = cells[3]!
              cells[3] = " "
            }
            if (effect === "unexpected") cells[2] = "?"
            if (effect === "outer") cells[0] = "?"
            if (effect === "history") history++
          }
        },
        getCell: (row) => ({ char: cells[row] ?? " " }) as ReturnType<TermlessContext["getCell"]>,
      }),
    )
    expect(result.observation, effect).toMatchObject({ outcome, evidence: "parser-state" })
    expect(
      feeds.some((sequence) => sequence.includes("\n")),
      effect,
    ).toBe(false)
    expect(feeds.at(-1), effect).toBe("\x1b[r")
    if (outcome === "inconclusive") expect(result.assertions, effect).toBeUndefined()
    else expect(result.assertions, effect).toMatchObject([{ kind: outcome === "supported" ? "positive" : "negative" }])
  }
})

test("interior-region SU declines preexisting history before writing", () => {
  const probe = scrollbackProbes.find((item) => item.id === "scrollback.scroll-up")
  if (!probe?.termless) throw new Error("missing scroll-up callback")
  const feeds: string[] = []
  const result = probe.termless(
    headless({
      getScrollback: () => ({ viewportOffset: 1, totalLines: 6, screenLines: 5 }),
      feed: (sequence) => feeds.push(sequence),
    }),
  )
  expect(result.observation).toMatchObject({ outcome: "inconclusive", reason: "insufficient-evidence" })
  expect(feeds).toEqual([])
})

test("DECSTBM needs an inner-row movement control, not just a surviving top row", () => {
  const probe = scrollbackProbes.find((item) => item.id === "scrollback.decstbm")
  if (!probe?.termless) throw new Error("missing decstbm callback")
  const result = probe.termless(
    headless({
      getCell: (row) => ({ char: row === 0 ? "F" : "I" }) as ReturnType<TermlessContext["getCell"]>,
    }),
  )
  expect(result.observation).toMatchObject({ outcome: "inconclusive", evidence: "parser-state" })
  expect(result.assertions).toBeUndefined()
})

test("DECSTBM retains support when only the inner marker scrolls", () => {
  const probe = scrollbackProbes.find((item) => item.id === "scrollback.decstbm")
  if (!probe?.termless) throw new Error("missing decstbm callback")
  let scrolled = false
  const result = probe.termless(
    headless({
      feed: (sequence) => {
        if (sequence.includes("\x1b[10;1HZ")) scrolled = true
      },
      getCell: (row) => ({ char: row === 0 ? "F" : scrolled ? " " : "I" }) as ReturnType<TermlessContext["getCell"]>,
    }),
  )
  expect(result.observation).toMatchObject({ outcome: "supported", evidence: "parser-state" })
  expect(result.assertions).toMatchObject([{ kind: "positive", observed: result.response }])
})

test("DECSTBM reset does not qualify when earlier region confinement was not established", () => {
  const probe = scrollbackProbes.find((item) => item.id === "scrollback.decstbm-reset")
  if (!probe?.termless) throw new Error("missing decstbm-reset callback")
  let reads = 0
  const result = probe.termless(
    headless({
      getScrollback: () => ({ viewportOffset: 0, screenLines: 12, totalLines: reads++ === 0 ? 12 : 40 }),
    }),
  )
  expect(result.observation).toMatchObject({ outcome: "inconclusive", evidence: "parser-state" })
  expect(result.assertions).toBeUndefined()
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

function captureApp(rows: number, cols: number) {
  const writes: string[] = []
  const frames: ObservationFrame[] = []
  const context: TermContext = {
    rows,
    cols,
    write: (bytes) => writes.push(bytes),
    queryCursorPosition: async () => null,
    measureRenderedWidth: async () => null,
    query: async () => null,
    queryWithSentinel: async () => null,
    queryOutcome: async () => ({ match: null, reason: "timeout", raw: "", rawBase64: "" }),
    queryWithSentinelOutcome: async () => ({ match: null, reason: "timeout", raw: "", rawBase64: "" }),
    queryMode: async () => null,
    capture: async ({ role, label }) => {
      const frame = {
        role,
        label,
        capturedAt: frames.length + 1,
        ref: `sha256:${String(frames.length + 1).repeat(64)}`,
      }
      frames.push(frame)
      return frame
    },
  }
  return { context, writes, frames }
}

const findScrollback = (id: string) => {
  const definition = scrollbackProbes.find((probe) => probe.id === id)
  if (!definition?.term) throw new Error(`missing app scrollback callback for ${id}`)
  return definition
}

test("scrollback capture fixtures record control and target frames with honest, bounded claims", async () => {
  const accumulate = findScrollback("scrollback.accumulate")
  const small = captureApp(2, 61)
  expect((await accumulate.term!(small.context)).observation).toMatchObject({
    outcome: "inconclusive",
    reason: "insufficient-evidence",
    evidence: "none",
  })
  expect(small.writes).toEqual([])
  const accumulated = captureApp(3, 61)
  const accumulateResult = await accumulate.term!(accumulated.context)
  expect(accumulated.frames.map(({ role }) => role)).toEqual(["control", "target"])
  expect(accumulated.writes.some((write) => write === "\x1b[2;1H")).toBe(true)
  expect(accumulated.writes.includes("\x1b[H")).toBe(false)
  expect(JSON.stringify(accumulateResult.observation?.note)).not.toContain("entered scrollback")

  const total = findScrollback("scrollback.total-lines")
  const totals = captureApp(5, 61)
  const totalResult = await total.term!(totals.context)
  expect(totals.frames).toHaveLength(2)
  expect(String(totalResult.observation?.note)).not.toContain("grew")

  const alt = findScrollback("scrollback.alt-screen")
  const alts = captureApp(4, 61)
  const altResult = await alt.term!(alts.context)
  expect(alts.frames.map(({ role }) => role)).toEqual(["control", "control", "target"])
  expect(alts.writes).toContain("\x1b[?1049h")
  expect(altResult.observation?.frames).toHaveLength(3)

  const reset = findScrollback("scrollback.decstbm-reset")
  const narrow = captureApp(12, 8)
  expect((await reset.term!(narrow.context)).observation).toMatchObject({ evidence: "none" })
  expect(narrow.writes).toEqual([])
  const resets = captureApp(12, 61)
  const resetResult = await reset.term!(resets.context)
  expect(resets.frames).toHaveLength(3)
  expect(resets.writes).toContain("\x1b[5;10r")
  expect(String(resetResult.observation?.note)).toContain("confinement")

  const setRegion = findScrollback("scrollback.set-region")
  const setSmall = captureApp(12, 5)
  expect((await setRegion.term!(setSmall.context)).observation).toMatchObject({ evidence: "none" })
  expect(setSmall.writes).toEqual([])
})
