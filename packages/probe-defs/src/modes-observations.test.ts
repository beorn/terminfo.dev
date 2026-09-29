/**
 * @failure Four DEC mode app probes mutate terminal state or treat CPR responsiveness as mode recognition.
 * @level l1
 * @consumer Owned app mode observations and reviewed support cells.
 * @testonly none
 */
import { expect, test } from "vitest"
import { modesProbes } from "./modes.ts"
import type { TermContext, TermlessContext } from "./types.ts"

const modes = [
  { id: "modes.alt-scroll-1007", number: 1007 },
  { id: "modes.utf8-mouse-1005", number: 1005 },
  { id: "modes.deccolm", number: 3 },
  { id: "modes.decsclm", number: 4 },
] as const

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

test("app cursor replies and mode recognition do not prove alternate-buffer behavior", async () => {
  for (const id of ["modes.alt-screen.exit", "modes.insert-replace", "modes.altscreen-47", "modes.altscreen-1047"]) {
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
      expect(result.assertions ?? []).toEqual([])
    } else {
      const recognized = state !== "unknown"
      expect(result.pass).toBe(recognized)
      expect(result.observation).toMatchObject({ outcome: recognized ? "supported" : "unsupported", evidence: "query" })
      expect(result.assertions).toMatchObject([{ kind: recognized ? "positive" : "negative", observed: state }])
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
