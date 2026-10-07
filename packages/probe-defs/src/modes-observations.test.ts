/**
 * @failure Four DEC mode app probes mutate terminal state or treat CPR responsiveness as mode recognition.
 * @level l1
 * @consumer Owned app mode observations and reviewed support cells.
 * @testonly none
 */
import { expect, test } from "vitest"
import { modesProbes } from "./modes.ts"
import type { ObservationFrame, TermContext, TermlessContext } from "./types.ts"

function captureContext(rows: number, cols: number, writes: string[], frames: ObservationFrame[]): TermContext {
  return {
    rows,
    cols,
    write: (bytes: string) => writes.push(bytes),
    queryCursorPosition: async () => ({ row: 1, col: 1 }),
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
}

const modes = [
  { id: "modes.alt-scroll-1007", number: 1007 },
  { id: "modes.utf8-mouse-1005", number: 1005 },
  { id: "modes.deccolm", number: 3 },
  { id: "modes.decsclm", number: 4 },
] as const

test.each(["bad-start", "ignored-move", "ignored-restore", "restored"] as const)(
  "1048 qualifies cursor setup before grading %s",
  (scenario) => {
    const definition = modesProbes.find((item) => item.id === "modes.altscreen-1048")
    if (!definition?.termless) throw new Error("Missing headless cursor-save callback")
    const writes: string[] = []
    let cursor = { x: 0, y: 0 }
    const context = {
      cols: 20,
      getScrollback: () => ({ viewportOffset: 0, totalLines: 15, screenLines: 15 }),
      feed(sequence: string) {
        writes.push(sequence)
        if (sequence === "\x1b[5;10H" && scenario !== "bad-start") cursor = { x: 9, y: 4 }
        if (sequence === "\x1b[15;20H" && scenario !== "ignored-move") cursor = { x: 19, y: 14 }
        if (sequence === "\x1b[?1048l" && scenario === "restored") cursor = { x: 9, y: 4 }
      },
      getCursor: () => ({ ...cursor, visible: true, style: null }),
    } as unknown as TermlessContext
    const result = definition.termless(context)
    const outcome =
      scenario === "restored" ? "supported" : scenario === "ignored-restore" ? "unsupported" : "inconclusive"
    expect(result.observation, scenario).toMatchObject({ outcome, evidence: "parser-state" })
    if (outcome === "inconclusive") expect(result.assertions, scenario).toBeUndefined()
    else {
      expect(result.assertions, scenario).toMatchObject([{ kind: outcome === "supported" ? "positive" : "negative" }])
      expect(JSON.parse(result.response!), scenario).toMatchObject({
        before: { x: 9, y: 4 },
        displaced: { x: 19, y: 14 },
      })
    }
    if (scenario === "bad-start") expect(writes).toEqual(["\x1b[5;10H"])
    else expect(writes.at(-1)).toBe("\x1b[?1048l")
  },
)

test("1048 refuses undersized geometry and restores after failed displacement readback", () => {
  const definition = modesProbes.find((item) => item.id === "modes.altscreen-1048")
  if (!definition?.termless) throw new Error("Missing headless cursor-save callback")
  const writes: string[] = []
  let rows = 14
  const context = {
    cols: 20,
    getScrollback: () => ({ viewportOffset: 0, totalLines: rows, screenLines: rows }),
    feed: (sequence: string) => writes.push(sequence),
    getCursor: () => {
      if (writes.includes("\x1b[15;20H")) throw new Error("readback failed")
      return { x: 9, y: 4, visible: true, style: null }
    },
  } as unknown as TermlessContext
  expect(definition.termless(context).observation).toMatchObject({ outcome: "inconclusive" })
  expect(writes).toEqual([])
  rows = 15
  expect(() => definition.termless!(context)).toThrow("readback failed")
  expect(writes.at(-1)).toBe("\x1b[?1048l")
})

test("IRM grades measured insertion despite false mode metadata and distinguishes replacement from bad setup", () => {
  const definition = modesProbes.find((item) => item.id === "modes.insert-replace")
  if (!definition?.termless) throw new Error("Missing headless IRM callback")
  for (const [target, outcome] of [
    ["XABC", "supported"],
    ["XBC ", "unsupported"],
    ["XAB ", "inconclusive"],
  ] as const) {
    const feeds: string[] = []
    let phase = "empty"
    const context = {
      cols: 4,
      getScrollback: () => ({ viewportOffset: 0, totalLines: 1, screenLines: 1 }),
      getMode: () => false,
      getCursor: () => ({ x: phase === "seed" ? 3 : 0, y: 0, visible: true, style: null }),
      feed: (sequence: string) => {
        feeds.push(sequence)
        if (sequence.includes("ABC")) phase = "seed"
        else if (sequence === "\x1b[1;1H") phase = "origin"
        else if (sequence === "X") phase = "target"
      },
      getCell: (_row: number, col: number) => ({ char: (phase === "target" ? target : "ABC ")[col] ?? "" }),
    } as unknown as TermlessContext
    const result = definition.termless(context)
    expect(result.observation, target).toMatchObject({ outcome, evidence: "parser-state" })
    expect(feeds.at(-1), target).toBe("\x1b[4l")
    if (outcome === "inconclusive") expect(result.assertions, target).toBeUndefined()
    else expect(result.assertions, target).toMatchObject([{ kind: outcome === "supported" ? "positive" : "negative" }])
  }
})

test("IRM does not grade output when the seed was not measured", () => {
  const definition = modesProbes.find((item) => item.id === "modes.insert-replace")
  if (!definition?.termless) throw new Error("Missing headless IRM callback")
  const feeds: string[] = []
  const context = {
    cols: 4,
    getScrollback: () => ({ viewportOffset: 0, totalLines: 1, screenLines: 1 }),
    getCursor: () => ({ x: 0, y: 0, visible: true, style: null }),
    feed: (sequence: string) => feeds.push(sequence),
    getCell: () => ({ char: " " }),
  } as unknown as TermlessContext
  const result = definition.termless(context)
  expect(result.observation).toMatchObject({ outcome: "inconclusive", reason: "insufficient-evidence" })
  expect(result.assertions).toBeUndefined()
  expect(feeds).not.toContain("\x1b[4h")
  expect(feeds).not.toContain("X")
})

test("unmeasured app modes leave prior state untouched instead of toggling it for CPR", async () => {
  for (const id of [
    "modes.application-keypad",
    "modes.left-right-margin",
    "modes.altscreen-47",
    "modes.altscreen-1047",
  ]) {
    const definition = modesProbes.find((item) => item.id === id)
    if (!definition?.term) throw new Error(`Missing ${id} app callback`)
    if (id === "modes.altscreen-1047") expect(definition.termObservationEvidence).toBe("query")
    for (const state of [null, "unknown", "set", "reset"] as const) {
      const queried: number[] = []
      const unexpected = (): never => {
        throw new Error(`${id}: no state write or CPR is a feature measurement`)
      }
      const context = {
        write: unexpected,
        queryCursorPosition: unexpected,
        queryMode: async (mode: number) => {
          queried.push(mode)
          return state
        },
      } as unknown as TermContext
      const result = await definition.term(context)
      expect(result.observation, `${id}:${state}`).toMatchObject({
        outcome: "inconclusive",
        evidence: id === "modes.altscreen-1047" ? "query" : "none",
      })
      expect(result.assertions ?? [], id).toEqual([])
      expect(queried, id).toEqual(id === "modes.altscreen-1047" ? [1047] : [])
    }
  }
})

test("app cursor replies and mode recognition do not prove alternate-buffer behavior", async () => {
  for (const id of ["modes.alt-screen.exit", "modes.insert-replace", "modes.altscreen-1047"]) {
    const definition = modesProbes.find((entry) => entry.id === id)
    if (!definition?.term) throw new Error(`Missing ${id} app callback`)
    const context: TermContext = {
      cols: 80,
      rows: 24,
      write() {},
      queryCursorPosition: async () => ({ row: 3, col: 3 }),
      measureRenderedWidth: async () => null,
      query: async () => null,
      queryWithSentinel: async () => null,
      queryOutcome: async () => ({ match: null, reason: "timeout", raw: "", rawBase64: "" }),
      queryWithSentinelOutcome: async () => ({ match: null, reason: "timeout", raw: "", rawBase64: "" }),
      queryMode: async () => "set",
    }
    const result = await definition.term(context)
    expect(result.observation, id).toMatchObject({
      outcome: "inconclusive",
      reason: "insufficient-evidence",
      evidence: "query",
    })
    expect(result.assertions ?? [], id).toEqual([])
  }
})

test.each(modes)("$id uses one DECRPM query without changing the terminal", async ({ id, number }) => {
  const definition = modesProbes.find((probe) => probe.id === id)
  if (!definition?.term) throw new Error(`Missing app callback for ${id}`)

  for (const state of ["unknown", null, "set", "reset"] as const) {
    const queried: number[] = []
    const unexpected = (operation: string): never => {
      throw new Error(`${id}: unexpected ${operation} for ${state}`)
    }
    const context: TermContext = {
      cols: 80,
      rows: 24,
      write: () => unexpected("write"),
      queryCursorPosition: async () => unexpected("CPR"),
      measureRenderedWidth: async () => unexpected("width query"),
      query: async () => unexpected("raw query"),
      queryWithSentinel: async () => unexpected("sentinel query"),
      queryOutcome: async () => unexpected("query outcome"),
      queryWithSentinelOutcome: async () => unexpected("sentinel outcome"),
      queryMode: async (mode) => {
        queried.push(mode)
        return state
      },
    }

    const result = await definition.term(context)
    expect(queried, `${id}: ${state}`).toEqual([number])
    if (state === null) {
      expect(result.pass).toBe(false)
      expect(result.observation).toMatchObject({ outcome: "inconclusive", reason: "no-response", evidence: "query" })
      expect(result.observation?.note, `${id}: note must survive projection`).toBe("No DECRPM response")
      expect(result.assertions ?? []).toEqual([])
    } else if (state === "unknown") {
      expect(result.pass).toBe(false)
      expect(result.response).toBe("unknown")
      expect(result.observation).toMatchObject({
        outcome: "inconclusive",
        reason: "insufficient-evidence",
        evidence: "query",
      })
      expect(result.observation?.note, `${id}: note must survive projection`).toMatch(/not recognized/)
      expect(result.assertions ?? []).toEqual([])
    } else {
      expect(result.pass).toBe(true)
      expect(result.observation).toMatchObject({ outcome: "supported", evidence: "query" })
      expect(result.assertions).toMatchObject([{ kind: "positive", observed: state }])
    }
  }
  expect(definition.termWrites).toBe("query")
  expect(definition.termObservationEvidence).toBe("query")
})

test("DECAWM refuses one-row geometry before a second-row read and enables its own fixture", () => {
  const probe = modesProbes.find((item) => item.id === "modes.auto-wrap")
  if (!probe?.termless) throw new Error("missing auto-wrap callback")
  const writes: string[] = []
  let rows = 1
  let enabled = false
  const context = {
    cols: 4,
    getScrollback: () => ({ viewportOffset: 0, totalLines: rows, screenLines: rows }),
    feed: (sequence: string) => {
      writes.push(sequence)
      if (sequence === "\x1b[?7h") enabled = true
      if (sequence === "\x1b[?7l") enabled = false
    },
    getMode: () => enabled,
    getCell: (row: number) => {
      throw new Error(`out-of-grid read ${row}`)
    },
  } as unknown as TermlessContext
  const small = probe.termless(context)
  expect(small.observation).toMatchObject({ outcome: "inconclusive", evidence: "parser-state" })
  expect(writes).toEqual([])

  rows = 2
  context.getCell = (row: number, col: number) =>
    ({ char: row === 1 && col === 0 ? "Y" : "X" }) as ReturnType<TermlessContext["getCell"]>
  const measured = probe.termless(context)
  expect(measured.observation).toMatchObject({ outcome: "supported", evidence: "parser-state" })
  expect(writes).toContain("\x1b[?7h")
  expect(writes.at(-1)).toBe("\x1b[?7l")
})

type Alt1049Scenario =
  | "roundtrip"
  | "ignored-entry"
  | "erasure-mimic"
  | "marker-leak"
  | "broken-exit"
  | "broken-cursor"
  | "readback-failure"
  | "cleanup-failure"
  | "constant-cursor"

/** Minimal primary/alternate model: only the two seeded spans, the ALT marker and the cursor. */
function alt1049Context(scenario: Alt1049Scenario, cols = 20, rows = 5) {
  const writes: string[] = []
  const pad = (text: string) => (text + " ".repeat(cols)).slice(0, cols)
  const blank = " ".repeat(cols)
  const saved = { x: 6, y: 4 }
  let primaryA = blank
  let primaryB = blank
  let altA = blank
  let altB = blank
  let onAlt = false
  let cursor = { x: 0, y: 0 }
  const line = (row: number) =>
    onAlt ? (row === 0 ? altA : row === 2 ? altB : blank) : row === 0 ? primaryA : row === 2 ? primaryB : blank
  const context = {
    cols,
    getScrollback: () => ({ viewportOffset: 0, totalLines: rows, screenLines: rows }),
    feed(sequence: string) {
      writes.push(sequence)
      if (sequence === "\x1b[2J\x1b[1;1HPRIMARY-A") primaryA = pad("PRIMARY-A")
      else if (sequence === "\x1b[3;1HPRIMARY-B") primaryB = pad("PRIMARY-B")
      else if (sequence === "\x1b[5;7H") cursor = { ...saved }
      else if (sequence === "\x1b[?1049h") {
        if (scenario !== "ignored-entry") {
          onAlt = true
          cursor = { x: 0, y: 0 }
          altA = blank
          altB = blank
        }
      } else if (sequence === "\x1b[1;1HALT-MARK") altA = pad("ALT-MARK")
      else if (sequence === "\x1b[?1049l") {
        if (scenario !== "broken-exit") {
          onAlt = false
          if (scenario === "erasure-mimic") {
            primaryA = blank
            primaryB = blank
          }
          if (scenario === "marker-leak") primaryA = pad("ALT-MARK")
          if (scenario !== "broken-cursor") cursor = { ...saved }
        }
      } else if (sequence === "\x1b[?1049l\x1b[0m") {
        if (scenario === "cleanup-failure") throw new Error("cleanup failed")
        onAlt = false
      }
    },
    getCell(row: number, col: number) {
      if (scenario === "readback-failure" && writes.length > 3) throw new Error("readback failed")
      const text = line(row)
      return { char: col < text.length ? text[col] : " " } as ReturnType<TermlessContext["getCell"]>
    },
    getCursor: () =>
      scenario === "constant-cursor"
        ? { x: 0, y: 0, visible: true, style: null }
        : { ...cursor, visible: true, style: null },
  }
  return { context: context as unknown as TermlessContext, writes }
}

function alt1049Probe(id: "enter" | "exit") {
  const definition = modesProbes.find((item) => item.id === `modes.alt-screen.${id}`)
  if (!definition?.termless) throw new Error(`Missing 1049 ${id} headless callback`)
  return definition
}

test("1049 enter grades only on the full roundtrip, with enter-specific defect controls", () => {
  const definition = alt1049Probe("enter")
  const ok = alt1049Context("roundtrip")
  expect(definition.termless!(ok.context).observation).toMatchObject({ outcome: "supported", evidence: "parser-state" })
  const ignored = alt1049Context("ignored-entry")
  const ignoredResult = definition.termless!(ignored.context)
  expect(ignoredResult.observation).toMatchObject({ outcome: "unsupported", evidence: "parser-state" })
  expect(ignoredResult.assertions).toMatchObject([{ kind: "negative" }])
  for (const scenario of ["erasure-mimic", "broken-exit", "marker-leak", "broken-cursor"] as const) {
    const { context } = alt1049Context(scenario)
    const result = definition.termless!(context)
    expect(result.observation, scenario).toMatchObject({ outcome: "inconclusive", reason: "insufficient-evidence" })
    expect(result.assertions, scenario).toBeUndefined()
  }
  const clipped = alt1049Context("roundtrip", 6)
  const clippedResult = definition.termless!(clipped.context)
  expect(clippedResult.observation).toMatchObject({ outcome: "inconclusive", reason: "insufficient-evidence" })
  expect(clipped.writes).toEqual([])
  expect(clippedResult.assertions).toBeUndefined()
  // Four rows cover the two seeds but not the row-4 saved pre-cursor; must refuse before feeding.
  const clippedRows = alt1049Context("roundtrip", 20, 4)
  const clippedRowsResult = definition.termless!(clippedRows.context)
  expect(clippedRowsResult.observation).toMatchObject({ outcome: "inconclusive", reason: "insufficient-evidence" })
  expect(clippedRows.writes).toEqual([])
  expect(clippedRowsResult.assertions).toBeUndefined()
})

test("1049 exit concludes only the full roundtrip and keeps restoration defects inconclusive", () => {
  const definition = alt1049Probe("exit")
  const ok = alt1049Context("roundtrip")
  expect(definition.termless!(ok.context).observation).toMatchObject({ outcome: "supported", evidence: "parser-state" })
  expect(ok.writes.at(-1)).toBe("\x1b[?1049l\x1b[0m")
  for (const scenario of ["erasure-mimic", "marker-leak", "broken-exit", "broken-cursor"] as const) {
    const { context } = alt1049Context(scenario)
    const result = definition.termless!(context)
    expect(result.observation, scenario).toMatchObject({ outcome: "inconclusive", reason: "insufficient-evidence" })
    expect(result.assertions, scenario).toBeUndefined()
  }
})

test("1049 exit keeps an unattributed entry failure inconclusive", () => {
  const definition = alt1049Probe("exit")
  const { context } = alt1049Context("ignored-entry")
  const result = definition.termless!(context)
  expect(result.observation).toMatchObject({ outcome: "inconclusive", reason: "insufficient-evidence" })
  expect(result.assertions).toBeUndefined()
})

test("1049 constant-cursor context cannot pass as a saved-cursor restoration", () => {
  for (const id of ["enter", "exit"] as const) {
    const definition = alt1049Probe(id)
    const { context, writes } = alt1049Context("constant-cursor")
    const result = definition.termless!(context)
    expect(result.observation, id).toMatchObject({ outcome: "inconclusive", reason: "insufficient-evidence" })
    expect(result.assertions, id).toBeUndefined()
    expect(writes, id).not.toContain("\x1b[?1049h")
  }
})

test("1049 readback failure is inconclusive while a cleanup failure stays loud", () => {
  const definition = alt1049Probe("exit")
  const { context, writes } = alt1049Context("readback-failure")
  const result = definition.termless!(context)
  expect(result.observation).toMatchObject({ outcome: "inconclusive", reason: "insufficient-evidence" })
  expect(result.assertions).toBeUndefined()
  expect(writes.at(-1)).toBe("\x1b[?1049l\x1b[0m")
  const cleanup = alt1049Context("cleanup-failure")
  expect(() => definition.termless!(cleanup.context)).toThrow("cleanup failed")
})

test("alt-screen exit capture frames the primary, alternate and restored buffers", async () => {
  const definition = modesProbes.find((item) => item.id === "modes.alt-screen.exit")
  if (!definition?.term) throw new Error("Missing app alt-screen exit callback")
  const writes: string[] = []
  const frames: ObservationFrame[] = []
  const result = await definition.term(captureContext(24, 80, writes, frames))
  expect(writes).toContain("\x1b[?1049h")
  expect(writes).toContain("\x1b[?1049l")
  expect(frames.map(({ role }) => role)).toEqual(["control", "target", "target"])
  expect(result.pass).toBe(false)
  expect(result.observation).toMatchObject({
    outcome: "inconclusive",
    reason: "insufficient-evidence",
    evidence: "pixels",
    frames,
    screenshotRef: frames[2]?.ref,
    note: expect.stringContaining("independent pixel review"),
  })
  expect(result.assertions).toBeUndefined()
})

test.each(["modes.altscreen-47", "modes.altscreen-1047"] as const)(
  "%s capture frames the swapped and restored buffers without grading",
  async (id) => {
    const definition = modesProbes.find((item) => item.id === id)
    if (!definition?.term) throw new Error(`Missing app callback for ${id}`)
    const writes: string[] = []
    const frames: ObservationFrame[] = []
    const result = await definition.term(captureContext(24, 80, writes, frames))
    expect(
      frames.map(({ role }) => role),
      id,
    ).toEqual(["control", "target", "target"])
    expect(result.pass, id).toBe(false)
    expect(result.observation, id).toMatchObject({
      outcome: "inconclusive",
      reason: "insufficient-evidence",
      evidence: "pixels",
      note: expect.stringContaining("independent pixel review"),
    })
    expect(result.observation?.frames, id).toHaveLength(3)
    expect(result.assertions, id).toBeUndefined()
  },
)

test("insert-replace capture contrasts replacement with IRM insertion", async () => {
  const definition = modesProbes.find((item) => item.id === "modes.insert-replace")
  if (!definition?.term) throw new Error("Missing app IRM callback")
  const writes: string[] = []
  const frames: ObservationFrame[] = []
  const result = await definition.term(captureContext(24, 80, writes, frames))
  expect(writes.some((entry) => entry.includes("\x1b[4h"))).toBe(true)
  expect(frames.map(({ role }) => role)).toEqual(["control", "target"])
  expect(result.pass).toBe(false)
  expect(result.observation).toMatchObject({
    outcome: "inconclusive",
    reason: "insufficient-evidence",
    evidence: "pixels",
    frames,
    note: expect.stringContaining("independent pixel review"),
  })
  expect(result.assertions).toBeUndefined()
})

test("left/right margin capture contrasts an unconstrained write with a margin-confined wrap", async () => {
  const definition = modesProbes.find((item) => item.id === "modes.left-right-margin")
  if (!definition?.term) throw new Error("Missing app margin callback")
  const writes: string[] = []
  const frames: ObservationFrame[] = []
  const result = await definition.term(captureContext(24, 80, writes, frames))
  expect(writes.some((entry) => entry.includes("\x1b[?69h"))).toBe(true)
  expect(writes.some((entry) => entry.includes("\x1b[3;6s"))).toBe(true)
  expect(frames.map(({ role }) => role)).toEqual(["control", "target"])
  expect(result.pass).toBe(false)
  expect(result.observation).toMatchObject({
    outcome: "inconclusive",
    reason: "insufficient-evidence",
    evidence: "pixels",
    frames,
  })
  expect(result.assertions).toBeUndefined()
})

test("modes capture refuses undersized geometry before any bytes or frames", async () => {
  for (const [id, rows, cols, need] of [
    ["modes.left-right-margin", 1, 7, "2x8"],
    ["modes.alt-screen.exit", 3, 5, "3x8"],
    ["modes.insert-replace", 1, 5, "1x6"],
  ] as const) {
    const definition = modesProbes.find((item) => item.id === id)
    if (!definition?.term) throw new Error(`Missing app callback for ${id}`)
    const writes: string[] = []
    const frames: ObservationFrame[] = []
    const result = await definition.term(captureContext(rows, cols, writes, frames))
    expect(writes, id).toEqual([])
    expect(frames, id).toEqual([])
    expect(result.observation, id).toMatchObject({
      outcome: "inconclusive",
      reason: "insufficient-evidence",
      evidence: "none",
    })
    expect(result.observation?.note, id).toContain(need)
  }
})

test.each([
  ["modes.xtpushsgr", "\x1b[#{"],
  ["modes.xtpopsgr", "\x1b[#}"],
  ["modes.xtsave", "\x1b[?7s"],
  ["modes.xtrestore", "\x1b[?7r"],
  ["modes.xtpushcolors", "\x1b[#P"],
  ["modes.xtpopcolors", "\x1b[#Q"],
] as const)("%s capture records control and target pixels for its stack sequence", async (id, marker) => {
  const definition = modesProbes.find((item) => item.id === id)
  if (!definition?.term) throw new Error(`Missing app callback for ${id}`)
  const writes: string[] = []
  const frames: ObservationFrame[] = []
  const result = await definition.term(captureContext(24, 80, writes, frames))
  expect(
    writes.some((entry) => entry.includes(marker)),
    id,
  ).toBe(true)
  expect(
    frames.map(({ role }) => role),
    id,
  ).toEqual(["control", "target"])
  expect(result.pass, id).toBe(false)
  expect(result.observation, id).toMatchObject({
    outcome: "inconclusive",
    reason: "insufficient-evidence",
    evidence: "pixels",
    frames,
    note: expect.stringContaining("independent pixel review"),
  })
  expect(result.assertions, id).toBeUndefined()
})

test.each(["modes.xtpushcolors", "modes.xtpopcolors"] as const)(
  "%s grades the color-stack roundtrip on Y and permits X to recolor (turn362)",
  async (id) => {
    const definition = modesProbes.find((item) => item.id === id)
    if (!definition?.term) throw new Error(`Missing app callback for ${id}`)
    const writes: string[] = []
    const frames: ObservationFrame[] = []
    const result = await definition.term(captureContext(24, 80, writes, frames))
    const note = result.observation?.note ?? ""
    expect(note, id).toMatch(/Grade the roundtrip by Y alone/)
    expect(note, id).toMatch(/a green Y means the pop did not restore/)
    expect(note, id).toMatch(/Do not grade on X/)
    expect(note, id).toMatch(/may recolor it blue/)
    expect(note, id).toMatch(/palette-setup failure .* stays inconclusive/)
    expect(note, id).not.toContain("blue X with blue Y")
    expect(note, id).not.toContain("ignored push/pop")
  },
)

test("xt stack capture refuses undersized geometry before any bytes or frames", async () => {
  for (const [id, rows, cols, need] of [
    ["modes.xtpushsgr", 2, 80, "3x6"],
    // XT-save/restore derives its wrap boundary from the measured width, so an undersized
    // fixture is under two rows or two columns, not an absolute column count.
    ["modes.xtsave", 1, 80, "2x2"],
    ["modes.xtpushcolors", 2, 80, "3x8"],
  ] as const) {
    const definition = modesProbes.find((item) => item.id === id)
    if (!definition?.term) throw new Error(`Missing app callback for ${id}`)
    const writes: string[] = []
    const frames: ObservationFrame[] = []
    const result = await definition.term(captureContext(rows, cols, writes, frames))
    expect(writes, id).toEqual([])
    expect(frames, id).toEqual([])
    expect(result.observation, id).toMatchObject({
      outcome: "inconclusive",
      reason: "insufficient-evidence",
      evidence: "none",
    })
    expect(result.observation?.note, id).toContain(need)
  }
})
