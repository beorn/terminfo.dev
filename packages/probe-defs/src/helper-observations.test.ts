/**
 * @failure Consumed SGR or an absent reply is reported as support, and measured parser/TTY state lacks a bound assertion.
 * @level l0
 * @consumer Shared app and headless probe definitions.
 * @testonly none
 */
import { expect, test } from "vitest"
import { decrpmModeProbe, cursorProbe, sgrProbe } from "./helpers.ts"
import { sgrProbes } from "./sgr.ts"
import { resetProbes } from "./reset.ts"
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
    rows: 24,
    ...overrides,
  }
}

test("app reset observations require a measured effect and leave unmeasurable reset paths inconclusive", async () => {
  const find = (id: string) => {
    const definition = resetProbes.find((entry) => entry.id === id)
    if (!definition?.term) throw new Error(`Missing ${id} app callback`)
    return definition.term
  }
  const sgr = await find("reset.sgr")(
    terminal({ rows: 24, cols: 80, queryCursorPosition: async () => ({ row: 1, col: 2 }) }),
  )
  expect(sgr.observation).toMatchObject({ outcome: "inconclusive", evidence: "consumed" })
  expect(sgr.assertions ?? []).toEqual([])

  const risPositions = [
    { row: 5, col: 5 },
    { row: 1, col: 1 },
  ]
  const ris = await find("reset.ris")(
    terminal({ rows: 24, cols: 80, queryCursorPosition: async () => risPositions.shift() ?? null }),
  )
  expect(ris.observation).toMatchObject({ outcome: "supported", evidence: "query" })
  expect(ris.assertions).toMatchObject([{ kind: "positive", expected: "RIS homes cursor from 5;5" }])

  const writes: string[] = []
  const modeReplies = ["reset", "set", "reset"] as const
  let modeReplyIndex = 0
  const soft = await find("reset.soft")(
    terminal({
      rows: 24,
      cols: 80,
      write: (sequence) => writes.push(sequence),
      queryMode: async () => modeReplies[modeReplyIndex++] ?? null,
    }),
  )
  expect(soft.observation).toMatchObject({ outcome: "supported", evidence: "query" })
  expect(soft.assertions).toMatchObject([{ kind: "positive" }])
  expect(writes.at(-1)).toBe("\x1b[?1l")

  const methodWrites: string[] = []
  const method = await find("reset.method")(terminal({ write: (sequence) => methodWrites.push(sequence) }))
  expect(method.observation).toMatchObject({ outcome: "inconclusive", evidence: "none" })
  expect(methodWrites).toEqual([])
})

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

  const unmeasured = probe.termless(headless())
  expect(unmeasured.observation).toMatchObject({ outcome: "inconclusive", evidence: "parser-state" })
  expect(JSON.parse(unmeasured.response ?? "")).toMatchObject({ char: "X", bold: false })
  expect(unmeasured.assertions).toBeUndefined()
})

// A consumed SGR and two screenshots are not comparable when the fixed text
// fixture wraps or lands outside the measured grid.
test("SGR app fixtures refuse undersized grids before writes and retain valid branch evidence", async () => {
  const definition = sgrProbe("sgr.bold", "\x1b[1m", (cell) => cell.bold)
  if (!definition.term) throw new Error("Missing SGR app callback")

  for (const geometry of [
    { rows: 1, cols: 1, capture: false },
    { rows: 2, cols: 34, capture: true },
    { rows: 3, cols: 33, capture: true },
    { rows: Number.NaN, cols: 80, capture: false },
  ]) {
    const writes: string[] = []
    let queries = 0
    let captures = 0
    const result = await definition.term(
      terminal({
        rows: geometry.rows,
        cols: geometry.cols,
        write: (bytes) => writes.push(bytes),
        queryCursorPosition: async () => {
          queries++
          return { row: 1, col: 2 }
        },
        ...(geometry.capture && {
          capture: async ({ role, label }: { role: "control" | "target"; label: string }) => {
            captures++
            return { role, label, capturedAt: 1, ref: `sha256:${"a".repeat(64)}` }
          },
        }),
      }),
    )
    expect(result.observation, `${geometry.rows}x${geometry.cols}`).toMatchObject({
      outcome: "inconclusive",
      reason: "insufficient-evidence",
      evidence: "none",
    })
    expect(result.response).toBeUndefined()
    expect(result.assertions).toBeUndefined()
    expect(writes).toEqual([])
    expect(queries).toBe(0)
    expect(captures).toBe(0)
  }
  expect(definition.termNeedsGeometry).toBe(true)

  const plainWrites: string[] = []
  const plain = await definition.term(
    terminal({
      rows: 1,
      cols: 2,
      write: (bytes) => plainWrites.push(bytes),
      queryCursorPosition: async () => ({ row: 1, col: 2 }),
    }),
  )
  expect(plain.observation).toMatchObject({ outcome: "inconclusive", evidence: "consumed" })
  expect(plainWrites.length).toBeGreaterThan(0)

  const captureWrites: string[] = []
  const roles: string[] = []
  const captured = await definition.term(
    terminal({
      rows: 3,
      cols: 34,
      write: (bytes) => captureWrites.push(bytes),
      capture: async ({ role, label }) => {
        roles.push(role)
        return { role, label, capturedAt: 1, ref: `sha256:${"a".repeat(64)}` }
      },
    }),
  )
  expect(captured.observation).toMatchObject({ outcome: "inconclusive", evidence: "pixels" })
  expect(JSON.parse(captured.response ?? "")).toMatchObject({
    sample: "AaBb 0123456789 - terminal text",
    startRow: 3,
    startCol: 3,
    sampleCells: 31,
    control: "Unstyled text sample",
    target: "sgr.bold",
  })
  expect(captured.observation?.frames).toHaveLength(2)
  expect(captured.assertions).toBeUndefined()
  expect(roles).toEqual(["control", "target"])
  expect(captureWrites.length).toBeGreaterThan(0)
})

// Every SGR capture fixture shares one guard, so a measured small terminal refuses before
// writes; the underlined SGR 59 control must itself carry an underline, not just SGR 0.
test("SGR reset capture fixtures share the 3x34 guard and render an underlined default reference", async () => {
  const ids = [
    "sgr.fg.default",
    "sgr.bg.default",
    "sgr.underline-color-reset",
    "sgr.selective-reset.bold",
    "sgr.selective-reset.underline",
    "sgr.selective-reset.italic",
    "sgr.selective-reset.inverse",
    "sgr.reset",
  ]
  for (const id of ids) {
    const definition = sgrProbes.find((probe) => probe.id === id)
    if (!definition?.term) throw new Error(`missing app callback for ${id}`)

    const smallWrites: string[] = []
    let smallCaptures = 0
    const small = await definition.term(
      terminal({
        rows: 2,
        cols: 33,
        write: (bytes) => smallWrites.push(bytes),
        capture: async ({ role, label }) => {
          smallCaptures++
          return { role, label, capturedAt: 1, ref: "never" }
        },
      }),
    )
    expect(small.observation, id).toMatchObject({
      outcome: "inconclusive",
      reason: "insufficient-evidence",
      evidence: "none",
    })
    expect(smallWrites, id).toEqual([])
    expect(smallCaptures, id).toBe(0)

    const writes: string[] = []
    const roles: string[] = []
    const ok = await definition.term(
      terminal({
        rows: 3,
        cols: 34,
        write: (bytes) => writes.push(bytes),
        capture: async ({ role, label }) => {
          roles.push(role)
          return { role, label, capturedAt: roles.length, ref: `sha256:${"d".repeat(64)}` }
        },
      }),
    )
    expect(ok.observation, id).toMatchObject({ outcome: "inconclusive", evidence: "pixels" })
    expect(ok.assertions, id).toBeUndefined()
    expect(roles, id).toEqual(["control", "target"])
    expect(ok.observation?.frames, id).toHaveLength(2)
    expect(writes.length, id).toBeGreaterThanOrEqual(2)
    if (id === "sgr.underline-color-reset") {
      // The DECRQSS readback writes its probe sequences first on a silent terminal; the capture
      // fixture follows. Locate the fixture runs rather than pinning their indices.
      const control = writes.find((write) => write.endsWith("\x1b[4mXXYY"))
      const target = writes.find((write) => write.includes("\x1b[58;2;255;0;128m"))
      expect(control, id).toBe("\x1b[0m\x1b[2J\x1b[3;3H\x1b[4mXXYY")
      expect(target, id).toContain("\x1b[58;2;255;0;128m")
    }
  }
})

test("unexposed overline and default conceal flags cannot establish negative support", () => {
  for (const id of ["sgr.overline", "sgr.hidden"]) {
    const probe = sgrProbes.find((item) => item.id === id)
    if (!probe?.termless) throw new Error(`missing headless ${id} probe`)
    const result = probe.termless(headless())
    expect(result.pass, id).toBe(false)
    if (id === "sgr.overline") {
      expect(result.observation, id).toBeUndefined()
      expect(result.notTested, id).toEqual({
        reason: "no-semantic-observable",
        noObservable: "cell.overline field not exposed",
      })
    } else {
      expect(result.observation, id).toMatchObject({
        outcome: "inconclusive",
        reason: "insufficient-evidence",
        evidence: "parser-state",
      })
    }
    expect(JSON.parse(result.response ?? ""), id).toMatchObject({ char: "X" })
    expect(result.assertions, id).toBeUndefined()
    const measured = probe.termless(headless({ getCell: () => ({ ...baseCell, hidden: true, overline: true }) }))
    expect(measured.observation, id).toMatchObject({ outcome: "supported", evidence: "parser-state" })
    expect(measured.assertions, id).toMatchObject([{ kind: "positive" }])
  }
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

test("SGR reset results require an observed setup and preserve unrelated attributes", () => {
  const cases = [
    {
      id: "sgr.selective-reset.bold",
      before: { bold: true, dim: true, italic: true },
      after: { bold: false, dim: false, italic: true },
      erasedSentinel: { bold: false, dim: false, italic: false },
    },
    {
      id: "sgr.selective-reset.underline",
      before: { underline: true, bold: true },
      after: { underline: false, bold: true },
      erasedSentinel: { underline: false, bold: false },
    },
    {
      id: "sgr.selective-reset.italic",
      before: { italic: true, bold: true },
      after: { italic: false, bold: true },
      erasedSentinel: { italic: false, bold: false },
    },
    {
      id: "sgr.selective-reset.inverse",
      before: { inverse: true, bold: true },
      after: { inverse: false, bold: true },
      erasedSentinel: { inverse: false, bold: false },
    },
    {
      id: "sgr.reset",
      before: { bold: true, italic: true, underline: true },
      after: { bold: false, italic: false, underline: false },
      erasedSentinel: null,
    },
  ] as const
  for (const { id, before, after, erasedSentinel } of cases) {
    const probe = sgrProbes.find((item) => item.id === id)
    if (!probe?.termless) throw new Error(`missing ${id} callback`)
    const termless = probe.termless
    const read = (style: Partial<typeof baseCell>) =>
      termless(
        headless({
          getCell: (_row, col) => ({ ...baseCell, char: ["C", "X", "Y"][col] ?? "", ...[{}, before, style][col] }),
        }),
      )
    const supported = read(after)
    expect(supported.observation, id).toMatchObject({ outcome: "supported", evidence: "parser-state" })
    expect(supported.assertions, id).toMatchObject([{ kind: "positive", observed: supported.response }])
    expect(JSON.parse(supported.response ?? ""), id).toMatchObject({
      baseline: { char: "C" },
      before: { char: "X" },
      after: { char: "Y" },
    })
    const ignored = read(before)
    expect(ignored.observation, id).toMatchObject({ outcome: "unsupported", evidence: "parser-state" })
    expect(ignored.assertions, id).toMatchObject([{ kind: "negative", observed: ignored.response }])
    const unobservedSetup = probe.termless(
      headless({ getCell: (_row, col) => ({ ...baseCell, char: ["C", "X", "Y"][col] ?? "" }) }),
    )
    expect(unobservedSetup.observation, id).toMatchObject({
      outcome: "inconclusive",
      reason: "insufficient-evidence",
    })
    expect(unobservedSetup.assertions, id).toBeUndefined()
    if (erasedSentinel) {
      const lost = read(erasedSentinel)
      expect(lost.observation, id).toMatchObject({ outcome: "unsupported", evidence: "parser-state" })
    }
  }
})

test("named ANSI color probes require distinct exposed selection, without theme thresholds", () => {
  const lowRed = { r: 3, g: 1, b: 2 }
  const lowBlue = { r: 1, g: 2, b: 4 }
  for (const id of ["sgr.fg.standard", "sgr.bg.standard", "sgr.fg.bright", "sgr.bg.bright"]) {
    const probe = sgrProbes.find((item) => item.id === id)
    if (!probe?.termless) throw new Error(`missing ${id} callback`)
    const channel = id.includes(".fg.") ? "fg" : "bg"
    const fed: string[] = []
    const run = (
      first: typeof lowRed | null,
      second: typeof lowBlue | null,
      chars = ["C", "X", "Y"],
      baseline: typeof lowRed | null = null,
    ) =>
      probe.termless?.(
        headless({
          feed: (sequence) => fed.push(sequence),
          getCell: (_row, col) => ({
            ...baseCell,
            char: chars[col] ?? "",
            [channel]: [baseline, first, second][col] ?? null,
          }),
        }),
      )
    const distinct = run(lowRed, lowBlue)
    const codes: Record<string, readonly number[]> = {
      "sgr.fg.standard": [31, 34],
      "sgr.bg.standard": [41, 44],
      "sgr.fg.bright": [91, 94],
      "sgr.bg.bright": [101, 104],
    }
    for (const code of codes[id] ?? []) expect(fed[0], id).toContain(`\x1b[${code}m`)
    expect(distinct?.observation, id).toMatchObject({ outcome: "supported", evidence: "parser-state" })
    expect(distinct?.assertions, id).toMatchObject([{ kind: "positive", observed: distinct?.response }])
    expect(JSON.parse(distinct?.response ?? ""), id).toMatchObject({
      baseline: { char: "C" },
      first: { char: "X" },
      second: { char: "Y" },
    })
    for (const uncertain of [
      run(lowRed, lowRed),
      run(null, null),
      run(lowRed, lowBlue, ["C", "?", "Y"]),
      run(lowRed, lowBlue, ["C", "X", "Y"], lowRed),
    ]) {
      expect(uncertain?.observation, id).toMatchObject({ outcome: "inconclusive", reason: "insufficient-evidence" })
      expect(uncertain?.assertions, id).toBeUndefined()
    }
  }
})

test("indexed cube colors require two exact direct-RGB reference controls", () => {
  const first = { r: 95, g: 135, b: 175 }
  const second = { r: 215, g: 135, b: 95 }
  for (const id of ["sgr.fg.256", "sgr.bg.256"]) {
    const probe = sgrProbes.find((item) => item.id === id)
    if (!probe?.termless) throw new Error(`missing ${id} callback`)
    const channel = id.includes(".fg.") ? "fg" : "bg"
    const fed: string[] = []
    const run = (indexed: readonly (typeof first | null)[], direct: readonly (typeof first | null)[]) =>
      probe.termless?.(
        headless({
          feed: (sequence) => fed.push(sequence),
          getCell: (_row, col) => ({
            ...baseCell,
            char: ["C", "A", "B", "X", "Y"][col] ?? "",
            [channel]: [null, ...direct, ...indexed][col] ?? null,
          }),
        }),
      )
    const matched = run([first, second], [first, second])
    const selector = channel === "fg" ? 38 : 48
    for (const code of [
      `${selector};5;67`,
      `${selector};5;173`,
      `${selector};2;95;135;175`,
      `${selector};2;215;135;95`,
    ]) {
      expect(fed[0], id).toContain(`\x1b[${code}m`)
    }
    expect(matched?.observation, id).toMatchObject({ outcome: "supported", evidence: "parser-state" })
    expect(matched?.assertions, id).toMatchObject([{ kind: "positive", observed: matched?.response }])
    expect(JSON.parse(matched?.response ?? ""), id).toMatchObject({
      directFirst: { char: "A" },
      indexedSecond: { char: "Y" },
    })
    for (const uncertain of [
      run([first, first], [first, second]),
      run([null, null], [first, second]),
      run([first, second], [null, null]),
    ]) {
      expect(uncertain?.observation, id).toMatchObject({ outcome: "inconclusive", reason: "insufficient-evidence" })
      expect(uncertain?.assertions, id).toBeUndefined()
    }
  }
})

test("truecolor probes distinguish exact sampled RGB from calibrated wrong RGB", () => {
  const firstFg = { r: 255, g: 128, b: 0 }
  const firstBg = { r: 0, g: 255, b: 128 }
  const second = { r: 17, g: 97, b: 201 }
  const red = { r: 7, g: 1, b: 2 }
  const blue = { r: 2, g: 1, b: 7 }
  for (const id of ["sgr.fg.truecolor", "sgr.bg.truecolor"]) {
    const probe = sgrProbes.find((item) => item.id === id)
    if (!probe?.termless) throw new Error(`missing ${id} callback`)
    const channel = id.includes(".fg.") ? "fg" : "bg"
    const first = channel === "fg" ? firstFg : firstBg
    const fed: string[] = []
    const run = (targets: readonly (typeof first | null)[], controls: readonly (typeof red | null)[] = [red, blue]) =>
      probe.termless?.(
        headless({
          feed: (sequence) => fed.push(sequence),
          getCell: (_row, col) => ({
            ...baseCell,
            char: ["C", "A", "B", "X", "Y"][col] ?? "",
            [channel]: [null, ...controls, ...targets][col] ?? null,
          }),
        }),
      )
    const exact = run([first, second])
    const selector = channel === "fg" ? 38 : 48
    expect(fed[0], id).toContain(`\x1b[${selector};2;${first.r};${first.g};${first.b}m`)
    expect(fed[0], id).toContain(`\x1b[${selector};2;17;97;201m`)
    expect(exact?.observation, id).toMatchObject({ outcome: "supported", evidence: "parser-state" })
    expect(exact?.assertions, id).toMatchObject([{ kind: "positive", observed: exact?.response }])
    const wrong = run([red, blue])
    expect(wrong?.observation, id).toMatchObject({ outcome: "unsupported", evidence: "parser-state" })
    expect(wrong?.assertions, id).toMatchObject([{ kind: "negative", observed: wrong?.response }])
    for (const uncertain of [run([red, blue], [red, red]), run([null, null]), run([first, second], [red, first])]) {
      expect(uncertain?.observation, id).toMatchObject({ outcome: "inconclusive", reason: "insufficient-evidence" })
      expect(uncertain?.assertions, id).toBeUndefined()
    }
  }
})

test("SGR 39 and 49 restore the measured default, including concrete RGB defaults", () => {
  const baseline = { r: 4, g: 5, b: 6 }
  const colored = { r: 90, g: 20, b: 10 }
  for (const id of ["sgr.fg.default", "sgr.bg.default"]) {
    const probe = sgrProbes.find((item) => item.id === id)
    if (!probe?.termless) throw new Error(`missing ${id} callback`)
    const channel = id.includes(".fg.") ? "fg" : "bg"
    const fed: string[] = []
    const run = (colors: readonly (typeof baseline | null)[]) =>
      probe.termless?.(
        headless({
          feed: (sequence) => fed.push(sequence),
          getCell: (_row, col) => ({ ...baseCell, char: ["C", "X", "R"][col] ?? "", [channel]: colors[col] ?? null }),
        }),
      )
    const restored = run([baseline, colored, baseline])
    expect(fed[0], id).toContain(channel === "fg" ? "\x1b[31m" : "\x1b[42m")
    expect(fed[0], id).toContain(channel === "fg" ? "\x1b[39m" : "\x1b[49m")
    expect(restored?.observation, id).toMatchObject({ outcome: "supported", evidence: "parser-state" })
    expect(restored?.assertions, id).toMatchObject([{ kind: "positive", observed: restored?.response }])
    const ignored = run([baseline, colored, colored])
    expect(ignored?.observation, id).toMatchObject({ outcome: "unsupported", evidence: "parser-state" })
    expect(ignored?.assertions, id).toMatchObject([{ kind: "negative", observed: ignored?.response }])
    const uncalibrated = run([baseline, baseline, baseline])
    expect(uncalibrated?.observation, id).toMatchObject({ outcome: "inconclusive", reason: "insufficient-evidence" })
    expect(uncalibrated?.assertions, id).toBeUndefined()
  }
})

test("all ten SGR color TTY replies remain inconclusive and restore style", async () => {
  for (const channel of ["fg", "bg"]) {
    for (const family of ["standard", "bright", "256", "truecolor", "default"]) {
      const id = `sgr.${channel}.${family}`
      const probe = sgrProbes.find((item) => item.id === id)
      if (!probe?.term) throw new Error(`missing ${id} TTY callback`)
      const writes: string[] = []
      const answered = await probe.term(
        terminal({ write: (text) => writes.push(text), queryCursorPosition: async () => ({ row: 1, col: 2 }) }),
      )
      expect(answered.observation, id).toMatchObject({ outcome: "inconclusive", reason: "insufficient-evidence" })
      expect(answered.assertions, id).toBeUndefined()
      expect(writes.at(-1), id).toBe("\x1b[0m")
      const silent = await probe.term(terminal())
      expect(silent.observation, id).toMatchObject({ outcome: "inconclusive", reason: "no-response" })
    }
  }
  const color = sgrProbes.find((item) => item.id === "sgr.fg.standard")
  if (!color?.term) throw new Error("missing standard foreground TTY callback")
  const failedWrites: string[] = []
  await expect(
    color.term(
      terminal({
        write: (text) => failedWrites.push(text),
        queryCursorPosition: async () => {
          throw new Error("TTY color query failed")
        },
      }),
    ),
  ).rejects.toThrow("TTY color query failed")
  expect(failedWrites.at(-1)).toBe("\x1b[0m")
})

test("SGR reset cursor replies remain inconclusive and style cleanup runs on query failure", async () => {
  for (const id of [
    "sgr.selective-reset.bold",
    "sgr.selective-reset.underline",
    "sgr.selective-reset.italic",
    "sgr.selective-reset.inverse",
    "sgr.reset",
  ]) {
    const probe = sgrProbes.find((item) => item.id === id)
    if (!probe?.term) throw new Error(`missing ${id} terminal callback`)
    const writes: string[] = []
    const result = await probe.term(
      terminal({
        write: (text) => writes.push(text),
        queryCursorPosition: async () => ({ row: 1, col: 3 }),
      }),
    )
    expect(result.observation, id).toMatchObject({ outcome: "inconclusive", reason: "insufficient-evidence" })
    expect(result.assertions, id).toBeUndefined()
    expect(writes.at(-1), id).toBe("\x1b[0m")
  }
  const probe = sgrProbes.find((item) => item.id === "sgr.reset")
  if (!probe?.term) throw new Error("missing sgr.reset terminal callback")
  const silence = await probe.term(terminal())
  expect(silence.observation).toMatchObject({ outcome: "inconclusive", reason: "no-response" })
  expect(silence.assertions).toBeUndefined()
  const writes: string[] = []
  await expect(
    probe.term(
      terminal({
        write: (text) => writes.push(text),
        queryCursorPosition: async () => {
          throw new Error("TTY read failed")
        },
      }),
    ),
  ).rejects.toThrow("TTY read failed")
  expect(writes.at(-1)).toBe("\x1b[0m")
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
  const decrpm = decrpmModeProbe("modes.test", 42, null)
  if (!decrpm.term) throw new Error("missing mode callback")
  for (const state of ["set", "reset"] as const) {
    const result = await decrpm.term(makeContext(state))
    expect(result.observation).toMatchObject({ outcome: "supported", evidence: "query" })
    expect(result.assertions).toMatchObject([{ kind: "positive", observed: state }])
  }
  const unknown = await decrpm.term(makeContext("unknown"))
  expect(unknown.observation).toMatchObject({
    outcome: "inconclusive",
    reason: "insufficient-evidence",
    evidence: "query",
  })
  expect(unknown.response).toBe("unknown")
  expect(unknown.assertions).toBeUndefined()
  expect((await decrpm.term(makeContext(null))).observation).toMatchObject({
    outcome: "inconclusive",
    reason: "no-response",
  })
  expect(written).toEqual([])
})
