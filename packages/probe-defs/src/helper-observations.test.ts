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
    cols: 80,
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
  expect(consumed.observation).toMatchObject({
    outcome: "inconclusive",
    reason: "insufficient-evidence",
    evidence: "consumed",
  })
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
  expect(result.observation).toMatchObject({
    outcome: "inconclusive",
    reason: "insufficient-evidence",
    evidence: "parser-state",
  })
  expect(JSON.parse(result.response ?? "")).toMatchObject({ char: "X" })
})

test("underline color needs an observed color, not only an underline or a consumed sequence", async () => {
  for (const id of ["sgr.underline.color", "sgr.underline-color-rgb"]) {
    const probe = sgrProbes.find((item) => item.id === id)
    if (!probe?.termless || !probe.term) throw new Error(`missing ${id} callback`)

    const unexposed = probe.termless(
      headless({
        getCell: (_row, col) => ({
          ...baseCell,
          char: ["A", "B", "X"][col] ?? "",
          underline: true,
          underlineColor: undefined,
        }),
      }),
    )
    expect(unexposed.observation, id).toMatchObject({
      outcome: "inconclusive",
      reason: "insufficient-evidence",
      evidence: "parser-state",
    })
    expect(unexposed.assertions, id).toBeUndefined()

    const colored = probe.termless(
      headless({
        getCell: (_row, col) => ({
          ...baseCell,
          char: ["A", "B", "X"][col] ?? "",
          underline: true,
          fg:
            [
              { r: 0, g: 0, b: 255 },
              { r: 0, g: 255, b: 0 },
              { r: 0, g: 255, b: 0 },
            ][col] ?? null,
          underlineColor: col === 2 ? { r: 255, g: 0, b: 128 } : null,
        }),
      }),
    )
    expect(colored.observation, id).toMatchObject({ outcome: "supported", evidence: "parser-state" })
    expect(colored.assertions, id).toMatchObject([{ kind: "positive", observed: colored.response }])

    const consumed = await probe.term(terminal({ queryCursorPosition: async () => ({ row: 1, col: 2 }) }))
    expect(consumed.observation, id).toMatchObject({
      outcome: "inconclusive",
      reason: "insufficient-evidence",
      evidence: "consumed",
    })
    expect(consumed.assertions, id).toBeUndefined()
  }
})

test("indexed underline color follows two distinct measured palette controls", async () => {
  const probe = sgrProbes.find((item) => item.id === "sgr.underline-color-indexed")
  if (!probe?.termless || !probe.term) throw new Error("missing indexed underline color callback")
  const measure = probe.termless
  const index4 = { r: 10, g: 20, b: 30 }
  const index5 = { r: 40, g: 50, b: 60 }
  const run = (
    colorOnFive: typeof index4 | null | undefined,
    colorOnFour: typeof index5 | null | undefined,
    secondFg = index5,
    default4: typeof index4 | null | undefined = null,
    default5: typeof index5 | null | undefined = null,
  ) =>
    measure(
      headless({
        getCell: (_row, col) => ({
          ...baseCell,
          char: ["A", "X", "B", "Y"][col] ?? "",
          underline: true,
          fg: col < 2 ? index4 : secondFg,
          underlineColor: [default4, colorOnFive, default5, colorOnFour][col],
        }),
      }),
    )

  const unexposed = run(undefined, undefined)
  expect(unexposed.observation).toMatchObject({ outcome: "inconclusive", reason: "insufficient-evidence" })
  expect(unexposed.assertions).toBeUndefined()

  const matched = run(index5, index4)
  expect(matched.observation).toMatchObject({ outcome: "supported", evidence: "parser-state" })
  expect(matched.assertions).toMatchObject([{ kind: "positive", observed: matched.response }])
  expect(JSON.parse(matched.response ?? "")).toMatchObject({
    default4: { fg: index4, underlineColor: null },
    target5: { fg: index4, underlineColor: index5 },
    default5: { fg: index5, underlineColor: null },
    target4: { fg: index5, underlineColor: index4 },
  })

  const ignoredColor = { r: 0, g: 0, b: 0 }
  const ignored = run(ignoredColor, ignoredColor, index5, index4, index5)
  expect(ignored.observation).toMatchObject({ outcome: "unsupported", evidence: "parser-state" })
  expect(ignored.assertions).toMatchObject([{ kind: "negative", observed: ignored.response }])

  const indistinguishable = run(index4, index4, index4)
  expect(indistinguishable.observation).toMatchObject({ outcome: "inconclusive", reason: "insufficient-evidence" })

  const consumed = await probe.term(terminal({ queryCursorPosition: async () => ({ row: 1, col: 2 }) }))
  expect(consumed.observation).toMatchObject({
    outcome: "inconclusive",
    reason: "insufficient-evidence",
    evidence: "consumed",
  })
})

test("underline color reset needs both an observed colored before cell and default after cell", () => {
  const probe = sgrProbes.find((item) => item.id === "sgr.underline-color-reset")
  if (!probe?.termless) throw new Error("missing underline color reset callback")
  const color = { r: 255, g: 0, b: 128 }
  const baseline = { ...baseCell, char: "C", underline: true }
  const withCells = (before: ReturnType<TermlessContext["getCell"]>, after: ReturnType<TermlessContext["getCell"]>) =>
    headless({ getCell: (_row, col) => [baseline, before, after][col] ?? baseCell })

  const missingBefore = probe.termless(
    withCells({ ...baseCell, underline: true, underlineColor: undefined }, { ...baseCell, char: "Y", underline: true }),
  )
  expect(missingBefore.observation).toMatchObject({ outcome: "inconclusive", reason: "insufficient-evidence" })
  expect(missingBefore.assertions).toBeUndefined()

  const missingAfter = probe.termless(
    withCells(
      { ...baseCell, underline: true, underlineColor: color },
      { ...baseCell, char: "Y", underline: true, underlineColor: undefined },
    ),
  )
  expect(missingAfter.observation).toMatchObject({ outcome: "inconclusive", reason: "insufficient-evidence" })

  const reset = probe.termless(
    withCells({ ...baseCell, underline: true, underlineColor: color }, { ...baseCell, char: "Y", underline: true }),
  )
  expect(reset.observation).toMatchObject({ outcome: "supported", evidence: "parser-state" })
  expect(reset.assertions).toMatchObject([{ kind: "positive", observed: reset.response }])

  const stillColored = probe.termless(
    withCells(
      { ...baseCell, underline: true, underlineColor: color },
      { ...baseCell, char: "Y", underline: true, underlineColor: color },
    ),
  )
  expect(stillColored.observation).toMatchObject({ outcome: "unsupported", evidence: "parser-state" })
  expect(stillColored.assertions).toMatchObject([{ kind: "negative", observed: stillColored.response }])
})

test("a null underline color from an adapter with no color readback is not unsupported", () => {
  for (const id of ["sgr.underline.color", "sgr.underline-color-rgb", "sgr.underline-color-indexed"]) {
    const probe = sgrProbes.find((item) => item.id === id)
    if (!probe?.termless) throw new Error(`missing ${id} callback`)
    const indexed = id === "sgr.underline-color-indexed"
    const chars = indexed ? ["A", "X", "B", "Y"] : ["A", "B", "X"]
    const firstFg = { r: 0, g: 0, b: 128 }
    const secondFg = { r: 128, g: 0, b: 128 }
    const result = probe.termless(
      headless({
        getCell: (_row, col) => ({
          ...baseCell,
          char: chars[col] ?? "",
          underline: true,
          fg: indexed ? (col < 2 ? firstFg : secondFg) : col === 0 ? firstFg : secondFg,
          underlineColor: null,
        }),
      }),
    )
    expect(result.observation, id).toMatchObject({ outcome: "inconclusive", reason: "insufficient-evidence" })
    expect(result.assertions, id).toBeUndefined()
  }
})

test("SGR 59 accepts the backend's measured non-null reset default", () => {
  const probe = sgrProbes.find((item) => item.id === "sgr.underline-color-reset")
  if (!probe?.termless) throw new Error("missing SGR 59 callback")
  const pink = { r: 255, g: 0, b: 128 }
  const white = { r: 255, g: 255, b: 255 }
  const cells = [
    { ...baseCell, char: "C", underline: true, underlineColor: white },
    { ...baseCell, char: "X", underline: true, underlineColor: pink },
    { ...baseCell, char: "Y", underline: true, underlineColor: white },
  ]
  const result = probe.termless(headless({ getCell: (_row, col) => cells[col] ?? baseCell }))
  expect(result.observation).toMatchObject({ outcome: "supported", evidence: "parser-state" })
  expect(result.assertions).toMatchObject([{ kind: "positive", observed: result.response }])
})

test("indexed SGR 58 rejects a default underline that merely follows the foreground", () => {
  const probe = sgrProbes.find((item) => item.id === "sgr.underline-color-indexed")
  if (!probe?.termless) throw new Error("missing indexed underline callback")
  const blue = { r: 0, g: 0, b: 128 }
  const magenta = { r: 128, g: 0, b: 128 }
  const cells = [
    { ...baseCell, char: "A", underline: true, fg: blue, underlineColor: blue },
    { ...baseCell, char: "X", underline: true, fg: blue, underlineColor: blue },
    { ...baseCell, char: "B", underline: true, fg: magenta, underlineColor: magenta },
    { ...baseCell, char: "Y", underline: true, fg: magenta, underlineColor: magenta },
  ]
  const result = probe.termless(headless({ getCell: (_row, col) => cells[col] ?? baseCell }))
  expect(result.observation).toMatchObject({ outcome: "unsupported", evidence: "parser-state" })
  expect(result.assertions).toMatchObject([{ kind: "negative", observed: result.response }])
})

test("legacy SGR reset diagnostics cannot pass when the setup attribute was never observed", () => {
  for (const id of [
    "sgr.fg.default",
    "sgr.bg.default",
    "sgr.selective-reset.bold",
    "sgr.selective-reset.underline",
    "sgr.selective-reset.italic",
    "sgr.selective-reset.inverse",
    "sgr.reset",
  ]) {
    const probe = sgrProbes.find((item) => item.id === id)
    if (!probe?.termless) throw new Error(`missing ${id} callback`)
    const result = probe.termless(headless({ getCell: (_row, col) => ({ ...baseCell, char: col === 0 ? "X" : "Y" }) }))
    expect(result.pass, id).toBe(false)
    expect(result.observation, id).toBeUndefined() // Still an ungraded legacy callback.
  }
})

test("cursor movement binds measured positions and parser state, never a missing reply", async () => {
  const cursor = cursorProbe("cursor.move.absolute", "", "\x1b[5;10H", { row: 4, col: 9 })
  if (!cursor.term || !cursor.termless) throw new Error("missing cursor callback")

  let terminalPosition = { row: 8, col: 7 }
  const terminalCursor = await cursor.term(
    terminal({
      write(sequence) {
        if (sequence === "\x1b[1;1H") terminalPosition = { row: 1, col: 1 }
        if (sequence === "\x1b[5;10H") terminalPosition = { row: 5, col: 10 }
      },
      queryCursorPosition: async () => terminalPosition,
    }),
  )
  expect(terminalCursor.observation).toMatchObject({ outcome: "supported", evidence: "query" })
  expect(terminalCursor.assertions).toMatchObject([
    { kind: "positive", expected: expect.any(String), observed: expect.any(String) },
  ])
  expect((await cursor.term(terminal())).observation).toMatchObject({ outcome: "inconclusive", reason: "no-response" })

  let headlessPosition = { x: 7, y: 8, visible: true, style: null }
  const parserCursor = cursor.termless(
    headless({
      feed(sequence) {
        if (sequence === "\x1b[1;1H") headlessPosition = { ...headlessPosition, x: 0, y: 0 }
        if (sequence === "\x1b[5;10H") headlessPosition = { ...headlessPosition, x: 9, y: 4 }
      },
      getCursor: () => headlessPosition,
    }),
  )
  expect(parserCursor.observation).toMatchObject({ outcome: "supported", evidence: "parser-state" })
  expect(JSON.parse(parserCursor.response ?? "")).toMatchObject({ final: { x: 9, y: 4 } })
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
