/**
 * @failure Consumed SGR or an absent reply is reported as support, and measured parser/TTY state lacks a bound assertion.
 * @level l0
 * @consumer Shared app and headless probe definitions.
 * @testonly none
 */
import { expect, test } from "vitest"
import { behavioralModeProbe, cursorProbe, sgrProbe } from "./helpers.ts"
import { sgrProbes } from "./sgr.ts"
import type { TermContext, TermlessContext } from "./types.ts"

const baseCell = {
  char: "X",
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

function headless(overrides: Partial<TermlessContext> = {}): TermlessContext {
  return {
    feed() {},
    feedCapture() {
      return ""
    },
    getCell() {
      return baseCell
    },
    getCursor() {
      return { x: 0, y: 0, visible: true, style: null }
    },
    getMode() {
      return false
    },
    getText() {
      return ""
    },
    getScrollback() {
      return { viewportOffset: 0, totalLines: 24, screenLines: 24 }
    },
    getTitle() {
      return ""
    },
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

function terminal(overrides: Partial<TermContext> = {}): TermContext {
  return {
    write() {},
    queryCursorPosition: async () => null,
    measureRenderedWidth: async () => null,
    query: async () => null,
    queryWithSentinel: async () => null,
    queryOutcome: async () => ({ match: null, reason: "timeout", raw: "", rawBase64: "" }),
    queryWithSentinelOutcome: async () => ({ match: null, reason: "timeout", raw: "", rawBase64: "" }),
    queryMode: async () => null,
    cols: 80,
    ...overrides,
  }
}

test("SGR consumption stays inconclusive while headless cell state supports an assertion", async () => {
  const probe = sgrProbe("sgr.bold", "\x1b[1m", (cell) => cell.bold)
  if (!probe.term || !probe.termless) throw new Error("SGR needs both callbacks")

  const consumed = await probe.term(terminal({ queryCursorPosition: async () => ({ row: 1, col: 2 }) }))
  expect(consumed.pass).toBe(true)
  expect(consumed.observation).toMatchObject({ outcome: "inconclusive", evidence: "consumed" })
  expect(consumed.assertions).toBeUndefined()

  const silent = await probe.term(terminal())
  expect(silent.observation).toMatchObject({ outcome: "inconclusive", reason: "no-response" })

  const supported = probe.termless(headless({ getCell: () => ({ ...baseCell, bold: true }) }))
  expect(supported.observation).toMatchObject({ outcome: "supported", evidence: "parser-state" })
  expect(JSON.parse(supported.response ?? "")).toMatchObject({ char: "X", bold: true })
  expect(supported.assertions).toMatchObject([{ kind: "positive", observed: supported.response }])

  const unsupported = probe.termless(headless())
  expect(unsupported.observation).toMatchObject({ outcome: "unsupported", evidence: "parser-state" })
  expect(unsupported.assertions).toMatchObject([{ kind: "negative", observed: unsupported.response }])
})

test("unexposed overline stays inconclusive and cannot inherit the old true boolean", () => {
  const probe = sgrProbes.find((item) => item.id === "sgr.overline")
  if (!probe?.termless) throw new Error("missing headless overline probe")
  const result = probe.termless(headless())
  expect(result.pass).toBe(false)
  expect(result.observation).toMatchObject({ outcome: "inconclusive", evidence: "parser-state" })
  expect(JSON.parse(result.response ?? "")).toMatchObject({ char: "X" })
})

test("cursor movement binds measured positions and parser state, never a missing reply", async () => {
  const cursor = cursorProbe("cursor.move.absolute", "", "\x1b[5;10H", { row: 4, col: 9 })
  if (!cursor.term || !cursor.termless) throw new Error("missing cursor callback")

  const terminalCursor = await cursor.term(terminal({ queryCursorPosition: async () => ({ row: 5, col: 10 }) }))
  expect(terminalCursor.observation).toMatchObject({ outcome: "supported", evidence: "query" })
  expect(terminalCursor.assertions).toMatchObject([
    { kind: "positive", expected: expect.any(String), observed: expect.any(String) },
  ])
  expect((await cursor.term(terminal())).observation).toMatchObject({ outcome: "inconclusive", reason: "no-response" })

  const parserCursor = cursor.termless(headless({ getCursor: () => ({ x: 9, y: 4, visible: true, style: null }) }))
  expect(parserCursor.observation).toMatchObject({ outcome: "supported", evidence: "parser-state" })
  expect(JSON.parse(parserCursor.response ?? "")).toMatchObject({ x: 9, y: 4 })
  expect(parserCursor.assertions).toMatchObject([{ kind: "positive", observed: parserCursor.response }])
})

test("DECRPM recognizes explicit set/reset/unknown without changing an existing mode", async () => {
  const written: string[] = []
  const makeContext = (state: "set" | "reset" | "unknown" | null) =>
    terminal({
      write(text) {
        written.push(text)
      },
      queryMode: async () => state,
    })
  const behavioral = behavioralModeProbe("modes.test", "\x1b[?42h", "\x1b[?42l", 42, null)
  if (!behavioral.term) throw new Error("missing mode callback")
  for (const state of ["set", "reset"] as const) {
    const result = await behavioral.term(makeContext(state))
    expect(result.observation).toMatchObject({ outcome: "supported", evidence: "query" })
    expect(result.assertions).toMatchObject([{ kind: "positive", observed: state }])
  }
  const unknown = await behavioral.term(makeContext("unknown"))
  expect(unknown.observation).toMatchObject({ outcome: "unsupported", evidence: "query" })
  expect(unknown.assertions).toMatchObject([{ kind: "negative", observed: "unknown" }])
  expect((await behavioral.term(makeContext(null))).observation).toMatchObject({
    outcome: "inconclusive",
    reason: "no-response",
  })
  expect(written).toEqual([])
})
