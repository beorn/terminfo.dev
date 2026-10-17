/**
 * @failure Erasure is credited without preserved controls, a failed cursor setup is blamed on a
 *   compliant erase, or app ED3 scrollback is graded from CPR or without a same-run history-observable control.
 * @level l1
 * @consumer Headless and app erase observations projected into terminal support cells.
 * @testonly none
 */
import { expect, test } from "vitest"
import { createHash } from "node:crypto"
import { eraseProbes, eraseReadbackRows } from "./erase.ts"
import { ALL_PROBES } from "./index.ts"
import { regionReadbackProbe, type RegionReadbackRow } from "./region-readback-kind.ts"
import { headlessContext, regradeRow } from "./testing/group-harness.ts"
import { createSemanticSurface } from "./testing/semantic-surface.ts"
import type { ProbeResult, TermContext, TermlessContext } from "./types.ts"

/**
 * The kind table's own rows, one per CONVERTED Erase probe, listed BY NAME so a row that loses its
 * definition - or a probe that stops being built from its row - fails here rather than as a silently
 * smaller count in a census taken later.
 *
 * `erase.el-with-attrs` and `erase.screen.scrollback` are deliberately absent: the first is an
 * attribute claim and the second a history claim, and the region kind compares CHARACTERS on a CELL
 * WINDOW (their one-line coverage records live in erase.ts). `erase-contract.test.ts` binds all eleven
 * rows beside these nine.
 */
const KIND_TABLE_ROWS = eraseReadbackRows.map((row) => ({
  id: row.id,
  expected: "decided" as const,
  claim: row.expected,
}))

/**
 * Tests dropped by the 28450 Erase conversion, each named with its replacement (this file used to drive
 * the nine hand-written termless callbacks through a local `headless`/`screenHeadless` fake):
 *  - "<id> binds exact erased and preserved cells", "<id> requires exact erased cells and preserved
 *    controls", "<id> grades cells and cursor even when numeric history grows", "<id> does not blame
 *    erasure when CHA setup is ignored", "EL 2 preserves a neighboring row" -> "every kind row decides
 *    from its own cells, through the shared kind" plus "<row> binds its claim to its own cells and
 *    calibrated controls".
 *  - "<id> refuses incomplete fixture or cell readback" and "headless erase fixtures require measured
 *    rows and columns before writes" -> the kind's own geometry and load refusals, asserted below.
 *  - "ED2 retains scrollback changes as raw context" / "ED2 accepts erased cells and preserved cursor
 *    with growing history" -> dropped: a kind row reads CELLS, not history. The history-context arms
 *    belonged to the deleted hand-written callback; no erase capability claim depends on them.
 *  - "selective erasure observes protected cells and the unprotected target" -> the row's own `ignored`
 *    measured negative plus the per-row loop; the pixel arm's proof of the same shape is
 *    testing/region-readback-contract.test.ts.
 *  - "region erase requires changed cells and a preserved preceding row" -> the row's own `controls`.
 */

/** A minimal TermlessContext the declared screens below override. */
function headless(overrides: Partial<TermlessContext> = {}): TermlessContext {
  return {
    cols: 24,
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
 * The same TermContext shape the kept hand-written rows use, plus an event log and measured geometry,
 * so a converted row is driven at the exact size on which it must refuse.
 */
function appWithEvents(rows: number, cols: number, events: string[]): TermContext {
  const unexpected = (name: string): never => {
    throw new Error(`Unexpected ${name} in erase geometry fixture`)
  }
  return {
    rows,
    cols,
    write(bytes): void {
      events.push(bytes)
    },
    queryCursorPosition: async () => {
      events.push("CPR")
      return { row: 3, col: 6 }
    },
    measureRenderedWidth: async () => unexpected("measureRenderedWidth"),
    query: async () => unexpected("query"),
    queryWithSentinel: async () => unexpected("queryWithSentinel"),
    queryOutcome: async () => ({ match: null, reason: "timeout", raw: "", rawBase64: "" }),
    queryWithSentinelOutcome: async () => ({ match: null, reason: "timeout", raw: "", rawBase64: "" }),
    queryMode: async () => unexpected("queryMode"),
  }
}

/**
 * A headless surface whose screen is exactly the grid a test declares for each sequence the row feeds:
 * a sequence the test does not name leaves the grid unchanged, which is how a test says "this terminal
 * ignored that operation". The declared grid is the terminal's own behaviour, so a row reads supported
 * only when its frame agrees with a terminal the test drove independently.
 */
function declaredScreen(
  screens: Record<string, readonly (readonly string[])[]>,
  cols: number,
  cursor: { x: number; y: number } = { x: 0, y: 0 },
): TermlessContext {
  let cells: readonly (readonly string[])[] = []
  return headless({
    cols,
    feed: (sequence) => {
      const next = screens[sequence]
      if (next !== undefined) cells = next
    },
    getCell: (row, col) => ({ char: cells[row]?.[col] ?? " " }) as ReturnType<TermlessContext["getCell"]>,
    getCursor: () => ({ x: cursor.x, y: cursor.y, visible: true, style: null }),
  })
}

/** The table row a test names, so a row that lost its definition fails here rather than as a gap. */
function rowById(id: string): RegionReadbackRow {
  const row = eraseReadbackRows.find((entry) => entry.id === id)
  if (row === undefined) throw new Error(`missing erase row ${id}`)
  return row
}

/** The 0-based cursor each row's single step must reach (its CUP) — the setup's own witness. */
function stepCursor(id: string): { x: number; y: number } {
  const cursor = rowById(id).steps[0]?.cursor
  if (cursor === undefined) throw new Error(`missing step cursor for ${id}`)
  return { x: cursor.x, y: cursor.y }
}

/** The kind reads a blank as `""` or `" "` alike, so a compare normalizes BOTH grids to spaces. */
const toSpaces = (grid: readonly (readonly string[])[]) =>
  grid.map((cells) => cells.map((cell) => (cell === "" ? " " : cell)))

const firstStep = (id: string): string => {
  const row = eraseReadbackRows.find((entry) => entry.id === id)
  const write = row?.steps[0]?.write
  if (write === undefined) throw new Error(`missing single step for ${id}`)
  return write
}

test("the kind table names every converted erase row, and every row reaches the frozen suite", () => {
  expect(eraseReadbackRows.map((row) => row.id)).toEqual(KIND_TABLE_ROWS.map((row) => row.id))
  for (const row of eraseReadbackRows) {
    expect(
      eraseProbes.filter((probe) => probe.id === row.id),
      `${row.id} has exactly one probe`,
    ).toHaveLength(1)
    expect(
      ALL_PROBES.some((probe) => probe.id === row.id),
      `${row.id} is in the suite`,
    ).toBe(true)
  }
  // Nine converted rows plus the two hand-written ones (el-with-attrs, screen.scrollback).
  expect(eraseProbes).toHaveLength(11)
})

/**
 * The derivation, measured: the probe the kind builds from a row reads THAT row's seed cells and THAT
 * row's target cells against a surface implementing the claim. A hand-written probe beside the table
 * cannot satisfy this without also carrying the row's own numbers.
 */
test("every kind row decides from its own cells, through the shared kind", async () => {
  for (const row of eraseReadbackRows) {
    const probe = eraseProbes.find((entry) => entry.id === row.id)
    expect(probe, `${row.id} has a kind-built probe`).toBeDefined()
    if (!probe) continue
    expect(probe.termNeedsGeometry, row.id).toBe(true)
    expect(probe.termlessObservationEvidence, row.id).toBe("parser-state")
    const measured = probe.termless!(headlessContext(createSemanticSurface()))
    const state = JSON.parse(measured.response ?? "null") as { before: string[][]; after: string[][] }
    expect(toSpaces(state.before), `${row.id} reads the row's seed cells`).toEqual(toSpaces(row.before))
    expect(toSpaces(state.after), `${row.id} reads the row's target cells`).toEqual(toSpaces(row.after))
    expect(measured.observation, row.id).toMatchObject({ outcome: "supported", evidence: "parser-state" })
    expect(measured.assertions?.[0], row.id).toMatchObject({ kind: "positive" })
    const contract = KIND_TABLE_ROWS.find((entry) => entry.id === row.id)
    expect(contract, `${row.id} is named in the table`).toBeDefined()
    if (!contract) continue
    const graded = await regradeRow(probe, contract, { headless: headlessContext(createSemanticSurface()) })
    expect(graded.after, row.id).toBe("supported")
    expect(graded.satisfies, row.id).toBe(true)
  }
})

test("the kind table replays every row deterministically", async () => {
  for (const row of KIND_TABLE_ROWS) {
    const probe = eraseProbes.find((entry) => entry.id === row.id)
    if (!probe) continue
    const first = await regradeRow(probe, row, { headless: headlessContext(createSemanticSurface()) })
    const second = await regradeRow(probe, row, { headless: headlessContext(createSemanticSurface()) })
    expect(second.after, `${row.id} is not deterministic`).toBe(first.after)
    expect(second.satisfies, `${row.id} satisfaction is not deterministic`).toBe(first.satisfies)
  }
})

/**
 * Each row's claim, read from a screen the test declares: the sequence's own cells read supported, a
 * terminal that ignored the sequence reads unsupported, and a row whose seed frame or whose never-
 * written control cell is wrong reads inconclusive - so the table is a measurement, not a stamp.
 */
for (const row of eraseReadbackRows) {
  test(`${row.id} binds its claim to its own cells`, () => {
    const probe = eraseProbes.find((entry) => entry.id === row.id)
    if (!probe?.termless) throw new Error(`Missing headless ${row.id}`)
    const cols = 24
    const step = firstStep(row.id)
    const cursor = stepCursor(row.id)
    const right = (row.region?.left ?? 1) + (row.before[0]?.length ?? 0) - 1

    const supported = probe.termless(declaredScreen({ [row.seed]: row.before, [step]: row.after }, cols, cursor))
    expect(supported.observation, row.id).toMatchObject({ outcome: "supported", evidence: "parser-state" })
    expect(supported.assertions?.[0], row.id).toMatchObject({ kind: "positive" })

    const ignored = probe.termless(declaredScreen({ [row.seed]: row.before }, cols, cursor))
    expect(ignored.observation, row.id).toMatchObject({ outcome: "unsupported", evidence: "parser-state" })
    expect(ignored.assertions?.[0], row.id).toMatchObject({ kind: "negative" })

    const badSeed = row.before.map((cells) => cells.map(() => "?"))
    expect(probe.termless(declaredScreen({ [row.seed]: badSeed }, cols)).observation, row.id).toMatchObject({
      outcome: "inconclusive",
      reason: "insufficient-evidence",
    })

    // A grid narrower than the row's own right edge refuses before a single byte is fed.
    const narrow = declaredScreen({ [row.seed]: row.before, [step]: row.after }, right - 1, cursor)
    const fed: string[] = []
    const watched = { ...narrow, feed: (sequence: string) => fed.push(sequence) }
    expect(probe.termless(watched).observation, `${row.id} at ${right - 1} columns`).toMatchObject({
      outcome: "inconclusive",
      reason: "insufficient-evidence",
    })
    expect(fed, `${row.id} fed bytes on a screen narrower than its region`).toEqual([])
  })
}

/**
 * The base's named erase failure tests, ported to the kind table (@cto 28450 must-fix 2). A terminal
 * that erases too much — EL2 its neighbour row, ED the wrong side, ED everything — must read
 * UNSUPPORTED, because every preserved erase cell is a claim cell now and a grid mismatch is the
 * capability's, not the fixture's. Before must-fix 2 these read inconclusive behind a moved control.
 */
test.each([
  ["erase.line.all", ["     ", "GONE!"], "EL2 erased the neighbouring row"],
  ["erase.screen.below", ["AAAAA", "   BB", "CCCCC"], "ED0 erased on the wrong side"],
  ["erase.screen.above", ["AAAAA", "BBBBB", "     "], "ED1 erased everything below"],
  ["erase.screen.all", ["AAAAA", "     ", "CCCCC"], "ED2 left a row behind"],
] as const)("%s reads an over-erase or wrong side unsupported (%s)", (id, lines, label) => {
  const row = rowById(id)
  const probe = eraseProbes.find((entry) => entry.id === id)
  if (!probe?.termless) throw new Error(`Missing headless ${id}`)
  const after = lines.map((line) => line.split(""))
  const result = probe.termless(declaredScreen({ [row.seed]: row.before, [firstStep(id)]: after }, 24, stepCursor(id)))
  expect(result.observation, `${id}: ${label}`).toMatchObject({ outcome: "unsupported", evidence: "parser-state" })
  expect(result.assertions?.[0], id).toMatchObject({ kind: "negative" })
})

/**
 * The setup's own witness, at kind-table scale: every erase row's single step declares the CUP cursor
 * it must reach, and a terminal whose CUP never moved the cursor reads inconclusive — the base's
 * "does not blame erasure when CHA setup is ignored", now the kind's step check (@cto 28450 must-fix
 * 2). erase.selective's CUP reaches column 1 already, so its cursor is not a deviation and is skipped.
 */
test.each(eraseReadbackRows.map((row) => row.id))("%s reads an ignored CUP inconclusive, not a bad erase", (id) => {
  const row = rowById(id)
  const probe = eraseProbes.find((entry) => entry.id === id)
  if (!probe?.termless) throw new Error(`Missing headless ${id}`)
  const cursor = stepCursor(id)
  if (cursor.x === 0 && cursor.y === 0) return
  const result = probe.termless(
    declaredScreen({ [row.seed]: row.before, [firstStep(id)]: row.after }, 24, { x: 0, y: 0 }),
  )
  expect(result.observation, id).toMatchObject({ outcome: "inconclusive", reason: "insufficient-evidence" })
  expect(result.assertions, id).toBeUndefined()
})

/**
 * The nine converted rows are decided by the region verdict, so a run with no owned capture can only
 * answer "inconclusive". A fixture that can only answer that is deleted rather than kept (@cto A2), so
 * every one of them refuses BY NAME and writes nothing - on the smallest grid, on a grid at the row's
 * own derived need and on a large one alike. With a capture adapter that answers no CSI 16 t the same
 * rows refuse through the pixel-geometry path instead.
 */
test("every converted row refuses by name and writes nothing without an owned capture", async () => {
  for (const row of eraseReadbackRows) {
    const definition = eraseProbes.find((probe) => probe.id === row.id)
    if (!definition?.term) throw new Error(`missing app callback for ${row.id}`)
    expect(definition.termNeedsGeometry, row.id).toBe(true)
    for (const [rows, cols] of [
      [1, 1],
      [4, 24],
      [24, 80],
    ] as const) {
      const events: string[] = []
      const result = await definition.term(appWithEvents(rows, cols, events))
      expect(result.observation, `${row.id} at ${rows}x${cols}`).toMatchObject({
        outcome: "inconclusive",
        reason: "insufficient-evidence",
        evidence: "none",
      })
      expect(String(result.observation?.note), `${row.id} at ${rows}x${cols}`).toContain("no owned capture adapter")
      expect(events, `${row.id} at ${rows}x${cols}`).toEqual([])
    }
  }
})

test("every converted row refuses by name when the terminal answers no pixel geometry", async () => {
  for (const row of eraseReadbackRows) {
    const definition = eraseProbes.find((probe) => probe.id === row.id)
    if (!definition?.term) throw new Error(`missing app callback for ${row.id}`)
    const events: string[] = []
    const result = await definition.term({
      ...appWithEvents(24, 80, events),
      capture: async ({ role, label }) => ({
        role,
        label,
        capturedAt: 1,
        ref: `sha256:${"1".repeat(64)}`,
      }),
    })
    expect(result.observation, row.id).toMatchObject({
      outcome: "inconclusive",
      reason: "insufficient-evidence",
      evidence: "query",
    })
    expect(String(result.observation?.note), row.id).toContain("CSI 16 t")
    expect(result.observation?.outcome, row.id).not.toBe("supported")
    expect(events, row.id).toEqual([])
  }
})

/**
 * NO SILENT ERRORS, at load: a row whose own shape disagrees with itself must never reach a compare
 * where a missing column is read against a blank and accepted. Each mismatch names the row.
 */
test("a row whose shape disagrees with itself refuses at load", () => {
  const row = eraseReadbackRows[0]
  expect(row, "the kind table has a first row").toBeDefined()
  if (!row) return
  expect(() => regionReadbackProbe({ ...row, before: [] })).toThrow(/at least one compared row/)
  expect(() => regionReadbackProbe({ ...row, before: [[]] })).toThrow(/at least one compared column/)
  expect(() => regionReadbackProbe({ ...row, before: [["A", "B"], ["A"]] })).toThrow(/compared row 1 names 1 cells/)
  expect(() => regionReadbackProbe({ ...row, after: [] })).toThrow(/after names 0 rows/)
  expect(() => regionReadbackProbe({ ...row, after: [["A"]] })).toThrow(/after row 0 names 1 cells/)
  expect(() => regionReadbackProbe({ ...row, ignored: [["A"]] })).toThrow(/ignored row 0 names 1 cells/)
  expect(() => regionReadbackProbe({ ...row, controls: [{ row: 0, col: 9, char: "A" }] })).toThrow(/outside/)
  expect(() => regionReadbackProbe({ ...row, controls: [{ row: 3, col: 0, char: "A" }] })).toThrow(
    /control row 3 is outside/,
  )
})

/**
 * NO SILENT ERRORS, at load (@cto 2026-10-12, must-fix 2): the minimum geometry DERIVES from the row.
 * An explicit minimum below that need refuses at LOAD and names both numbers; a larger one is for the
 * row to justify in a line - erase.ed-scroll-region's ten rows are exactly that, for a scroll region
 * whose bottom is row 10.
 */
test("an explicit minimum geometry below what a row uses refuses at load", () => {
  const row = eraseReadbackRows.find((entry) => entry.id === "erase.ed-scroll-region")
  expect(row, "the kind table names erase.ed-scroll-region").toBeDefined()
  if (!row) return
  // The row compares three five-column rows with its cursor on row 4 and its witness on row 5, so its
  // derived need is 5 rows by 5 + the family's two-column margin = 7 columns; the ten rows it declares
  // are for the scroll region, not the compared grid.
  expect(() => regionReadbackProbe({ ...row, minRows: 4 })).toThrow(/explicit minRows 4 is below the 5 rows/)
  expect(() => regionReadbackProbe({ ...row, minCols: 6 })).toThrow(/explicit minCols 6 is below the 7 columns/)
  expect(() => regionReadbackProbe({ ...row, minRows: 10, minCols: 7 })).not.toThrow()
  expect(() => regionReadbackProbe({ ...row, cursorRow: 6, sentinel: { row: 5, col: 1 } })).not.toThrow()
  expect(() => regionReadbackProbe({ ...row, cursorRow: 6, sentinel: { row: 5, col: 1 }, minRows: 5 })).toThrow(
    /explicit minRows 5 is below the 6 rows this row uses \(cursor row 6, sentinel row 5\)/,
  )
})

function byId(id: string) {
  const probe = eraseProbes.find((item) => item.id === id)
  if (!probe?.termless || !probe.term) throw new Error(`missing erase callbacks for ${id}`)
  return { ...probe, term: probe.term, termless: probe.termless }
}

function eraseCellsHeadless(
  after: string,
  adjacentAfter = "KEEP!",
  missingCell?: number,
  ignoreCursorSetup = false,
): TermlessContext {
  let erased = false
  let cursorX = 5
  const before = ["ABCDE", "KEEP!"]
  const afterRows = [after, adjacentAfter]
  return {
    cols: 80,
    feed(sequence) {
      if (!ignoreCursorSetup) {
        if (sequence.includes("\x1b[3G") || sequence.includes("\x1b[1;3H")) cursorX = 2
        else if (sequence.includes("\x1b[1G")) cursorX = 0
      }
      if (/\x1b\[(?:K|0K|1K|2K|3X)/.test(sequence)) erased = true
    },
    feedCapture: () => "",
    getCell(row, col) {
      const text = (erased ? afterRows : before)[row] ?? ""
      // A backend that cannot report one cell cannot prove erasure.
      const char = erased && row === 0 && col === missingCell ? undefined : (text[col] ?? "")
      return {
        char: char as string,
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
    },
    getCursor: () => ({ x: cursorX, y: 0, visible: true, style: null }),
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
  }
}

function app(position: { row: number; col: number } | null): TermContext {
  return {
    write() {},
    queryCursorPosition: async () => position,
    measureRenderedWidth: async () => null,
    query: async () => null,
    queryWithSentinel: async () => null,
    queryOutcome: async () => ({ match: null, reason: "timeout", raw: "", rawBase64: "" }),
    queryWithSentinelOutcome: async () => ({ match: null, reason: "timeout", raw: "", rawBase64: "" }),
    queryMode: async () => null,
    cols: 80,
    rows: 24,
  }
}

// These old probes could pass on an empty history, an unerased colored X, or
// an unchanged region. Keep each target and its prerequisite independently visible.
test("scrollback erase requires existing history and measured removal", () => {
  for (const [history, clears, expected] of [
    [true, true, "supported"],
    [true, false, "unsupported"],
    [false, true, "inconclusive"],
  ] as const) {
    const base = eraseCellsHeadless("ABCDE")
    let seeded = false
    let erased = false
    const result = byId("erase.screen.scrollback").termless({
      ...base,
      feed(bytes) {
        if (bytes.includes("\r\n")) seeded = true
        if (bytes === "\x1b[3J") erased = true
      },
      getScrollback: () => ({
        viewportOffset: 0,
        screenLines: 24,
        totalLines: seeded && history && !(erased && clears) ? 26 : 24,
      }),
    })
    expect(result.observation).toMatchObject({ outcome: expected, evidence: "parser-state" })
  }
})

const BOTTOM_REF = `sha256:${"b".repeat(64)}`
const HISTORY_REF = `sha256:${"h".repeat(64)}`
const ERASED_REF = `sha256:${"e".repeat(64)}`
const OTHER_REF = `sha256:${"o".repeat(64)}`

function scrollbackApp(script: {
  delivery?: string | null
  wheelMoves?: boolean
  clears?: boolean
  restore?: boolean
  afterRef?: string
}): {
  ctx: TermContext
  keys: string[]
  clicks: number[]
  writes: string[]
} {
  const keys: string[] = []
  const clicks: number[] = []
  const writes: string[] = []
  const delivery = script.delivery === undefined ? "a" : script.delivery
  const wheelMoves = script.wheelMoves !== false
  const clears = script.clears !== false
  const restore = script.restore !== false
  let listening = false
  let viewport: "bottom" | "history" = "bottom"
  let historyExists = true
  let ed3 = false
  let captureCount = 0
  const ctx: TermContext = {
    ...app({ row: 5, col: 5 }),
    write(text) {
      writes.push(text)
      if (text.includes("\x1b[3J")) {
        ed3 = true
        if (clears) historyExists = false
      }
    },
    input: {
      async injectKey(key) {
        if (!listening) throw new Error("XTEST inject before stdin listen")
        keys.push(key)
      },
      async injectClick(button) {
        clicks.push(button)
        if (button === 4 && wheelMoves && historyExists) viewport = "history"
        else if (button === 5 && restore) viewport = "bottom"
      },
    },
    readInput: async (_pattern, _timeoutMs, inject) => {
      listening = true
      try {
        if (!inject) throw new Error("readInput requires the inject callback so stdin is already listening")
        await inject()
        return delivery === null ? null : [delivery]
      } finally {
        listening = false
      }
    },
    capture: async ({ role, label }) => {
      captureCount += 1
      const ref =
        script.afterRef && captureCount >= 5
          ? script.afterRef
          : viewport === "history" && historyExists
            ? HISTORY_REF
            : ed3
              ? ERASED_REF
              : BOTTOM_REF
      return { role, label, capturedAt: Date.now(), ref }
    },
  }
  return { ctx, keys, clicks, writes }
}

test.each([
  ["without capture or XTEST", { capture: false, input: false }],
  ["with capture only", { capture: true, input: false }],
  ["with XTEST only", { capture: false, input: true }],
] as const)("erase.screen.scrollback is not tested %s", async (_name, parts) => {
  const writes: string[] = []
  const result = await byId("erase.screen.scrollback").term({
    ...app({ row: 5, col: 5 }),
    write: (text) => writes.push(text),
    ...(parts.capture
      ? {
          capture: async ({ role, label }) => ({
            role,
            label,
            capturedAt: 1,
            ref: BOTTOM_REF,
          }),
        }
      : {}),
    ...(parts.input
      ? {
          input: {
            injectKey: async () => {},
            injectClick: async () => {},
          },
          readInput: async () => ["a"],
        }
      : {}),
  })
  expect(writes).toEqual([])
  expect(result.notTested).toEqual({
    reason: "no-semantic-observable",
    noObservable: expect.stringMatching(/XTEST|wheel|scrollback|history/i),
  })
  expect(result.observation).toBeUndefined()
})

test("erase.screen.scrollback aborts when plain a does not reach the app", async () => {
  const { ctx, keys, clicks, writes } = scrollbackApp({ delivery: null })
  await expect(byId("erase.screen.scrollback").term(ctx)).rejects.toThrow(/delivery control|plain a/i)
  expect(keys).toEqual(["a"])
  expect(clicks).toEqual([])
  expect(writes.join("")).not.toContain("\x1b[3J")
})

test("erase.screen.scrollback is not tested when wheel-up does not change the capture", async () => {
  const { ctx, keys, clicks, writes } = scrollbackApp({ wheelMoves: false })
  const result = await byId("erase.screen.scrollback").term(ctx)
  expect(keys).toEqual(["a"])
  expect(clicks).toEqual([4, 5])
  expect(writes.join("")).not.toContain("\x1b[3J")
  expect(result.notTested).toEqual({
    reason: "no-semantic-observable",
    noObservable: expect.stringMatching(/wheel-up|history|pixels/i),
  })
  expect(result.observation).toBeUndefined()
})

test("erase.screen.scrollback is not tested when wheel-down does not restore the bottom", async () => {
  const { ctx, clicks } = scrollbackApp({ restore: false })
  const result = await byId("erase.screen.scrollback").term(ctx)
  expect(clicks).toEqual([4, 5, 5])
  expect(result.notTested).toEqual({
    reason: "no-semantic-observable",
    noObservable: expect.stringMatching(/wheel-down|restore|bottom/i),
  })
  expect(result.observation).toBeUndefined()
})

test("erase.screen.scrollback records unsupported when history remains after ED3", async () => {
  const { ctx, keys, clicks, writes } = scrollbackApp({ clears: false })
  const result = (await byId("erase.screen.scrollback").term(ctx)) as ProbeResult
  expect(keys).toEqual(["a"])
  expect(clicks).toEqual([4, 5, 4, 5])
  expect(writes.join("")).toContain("\x1b[3J")
  expect(writes.join("")).not.toMatch(/\x1b\[\?100[027]h/)
  expect(result.observation).toMatchObject({ outcome: "unsupported", evidence: "pixels" })
  expect(result.assertions?.[0]).toMatchObject({ kind: "negative", action: "erase.screen.scrollback:ed3" })
  const observed = JSON.parse(result.assertions?.[0]?.observed ?? "null") as Record<string, unknown>
  expect(observed).toMatchObject({ history: HISTORY_REF, after: HISTORY_REF })
})

test("erase.screen.scrollback records supported when wheel-up after ED3 stays on the post-ED3 frame", async () => {
  const { ctx, keys, clicks, writes } = scrollbackApp({ clears: true })
  const result = (await byId("erase.screen.scrollback").term(ctx)) as ProbeResult
  expect(keys).toEqual(["a"])
  expect(clicks).toEqual([4, 5, 4, 5])
  expect(writes.join("")).toContain("\x1b[3J")
  expect(writes.join("")).not.toMatch(/\x1b\[\?100[027]h/)
  expect(result.observation).toMatchObject({ outcome: "supported", evidence: "pixels" })
  expect(result.assertions?.[0]).toMatchObject({ kind: "positive", action: "erase.screen.scrollback:ed3" })
  const observed = JSON.parse(result.assertions?.[0]?.observed ?? "null") as Record<string, unknown>
  expect(observed).toMatchObject({ history: HISTORY_REF, erased: ERASED_REF, after: ERASED_REF })
  expect(observed.after).not.toBe(HISTORY_REF)
})

test("erase.screen.scrollback stays inconclusive when post-ED3 wheel-up matches neither history nor the erased frame", async () => {
  const { ctx, clicks } = scrollbackApp({ clears: true, afterRef: OTHER_REF })
  const result = await byId("erase.screen.scrollback").term(ctx)
  expect(clicks).toEqual([4, 5, 4, 5])
  expect(result.observation).toMatchObject({
    outcome: "inconclusive",
    reason: "insufficient-evidence",
    evidence: "pixels",
  })
  expect(result.notTested).toBeUndefined()
})

test("erase.screen.scrollback surfaces a finally wheel-down failure", async () => {
  const { ctx, clicks } = scrollbackApp({ clears: true })
  const inject = ctx.input!.injectClick
  ctx.input!.injectClick = async (button) => {
    await inject.call(ctx.input, button)
    if (clicks.length === 4) throw new Error("finally wheel-down failed")
  }
  await expect(byId("erase.screen.scrollback").term(ctx)).rejects.toThrow(/finally wheel-down failed/)
  expect(clicks).toEqual([4, 5, 4, 5])
})

test("background erase measures a blank target with its calibrated background", () => {
  const black = { r: 0, g: 0, b: 0 }
  const color = { r: 130, g: 20, b: 70 }
  // Constant RGB metadata cannot establish that SGR changed the default background. The erased
  // cell's background is judged on its own (@chief 2026-10-11T22:58Z): the current colour is
  // supported, the default (or none) is a measured negative, and only an unread background is
  // unmeasured.
  for (const [baseline, colored, char, afterBg, seed, expected, target] of [
    [black, black, " ", black, "X", "inconclusive", false],
    [null, null, " ", null, "X", "inconclusive", false],
    [undefined, color, " ", color, "X", "inconclusive", false],
    [null, color, " ", color, "?", "inconclusive", false],
    [null, color, " ", color, "X", "supported", true],
    [black, color, " ", color, "X", "supported", true],
    [null, color, "X", color, "X", "unsupported", true],
    [null, color, " ", null, "X", "unsupported", true],
    [null, color, " ", undefined, "X", "inconclusive", true],
  ] as const) {
    const base = eraseCellsHeadless("ABCDE")
    let erased = false
    let coloring = false
    const writes: string[] = []
    const result = byId("erase.el-with-attrs").termless({
      ...base,
      feed(bytes) {
        writes.push(bytes)
        if (bytes.includes("\x1b[42m")) coloring = true
        if (bytes === "\x1b[K") erased = true
      },
      getCell(row, col) {
        return {
          ...base.getCell(row, col),
          char: erased ? char : coloring ? "X" : seed,
          bg: (erased ? afterBg : coloring ? colored : baseline) as ReturnType<TermlessContext["getCell"]>["bg"],
        }
      },
    })
    expect(result.observation).toMatchObject({ outcome: expected, evidence: "parser-state" })
    expect(writes.includes("\x1b[K")).toBe(target)
    if (expected === "inconclusive") expect(result.assertions).toBeUndefined()
    expect(writes.at(-1)).toBe("\x1b[0m")
  }
})

/**
 * An owned app whose capture reads the semantic surface's OWN cells, so the region verdict decides
 * from what the surface really painted. A blank cell and a painted space read the same (the oracle
 * compares pixels), and the digest carries each cell's background so a background row can tell the
 * current colour from the default.
 */
function regionReadbackApp(rows: number, cols: number, mutations: readonly string[] = []) {
  const surface = createSemanticSurface({ rows, cols, mutations })
  const writes: string[] = []
  let reads = 0
  const digest = (cells: { top: number; left: number; bottom: number; right: number }): string => {
    let text = ""
    for (let row = cells.top; row <= cells.bottom; row++) {
      for (let col = cells.left; col <= cells.right; col++) {
        const cell = surface.getCell(row - 1, col - 1)
        const glyph = cell.char === "" || cell.char == null || cell.char === " " ? "_" : cell.char
        text += `${glyph}|${cell.bg ? `${cell.bg.r},${cell.bg.g},${cell.bg.b}` : "default"};`
      }
    }
    return text
  }
  const context: TermContext = {
    rows,
    cols,
    write: (bytes) => {
      writes.push(bytes)
      surface.feed(bytes)
    },
    queryCursorPosition: async () => null,
    measureRenderedWidth: async () => null,
    query: async () => null,
    queryWithSentinel: async () => null,
    queryOutcome: async () => ({ match: null, reason: "timeout", raw: "", rawBase64: "" }),
    async queryWithSentinelOutcome(sequence) {
      if (sequence === "\x1b[16t") {
        return { match: ["\x1b[6;16;8t", "16", "8"], reason: "reply", raw: "", rawBase64: "" }
      }
      if (sequence === "\x1b[14t") {
        return { match: ["\x1b[4;384;640t", "384", "640"], reason: "reply", raw: "", rawBase64: "" }
      }
      return { match: null, reason: "timeout", raw: "", rawBase64: "" }
    },
    queryMode: async () => null,
    capture: async ({ role, label, cells }) => {
      reads += 1
      const regionDigest = digest(cells ?? { top: 1, left: 1, bottom: rows, right: cols })
      return {
        role,
        label,
        capturedAt: reads,
        ref: `sha256:${createHash("sha256")
          .update(`${label}|${String(reads)}|${regionDigest}`)
          .digest("hex")}`,
        regionDigest,
        pixelsDigest: digest({ top: 1, left: 1, bottom: rows, right: cols }),
      }
    },
  }
  return { context, writes }
}

test("the EL-with-attrs row names an erase that drops the current background unsupported", async () => {
  const conforming = await byId("erase.el-with-attrs").term(regionReadbackApp(6, 10).context)
  expect(conforming.observation).toMatchObject({ outcome: "supported", evidence: "pixels" })

  const inert = await byId("erase.el-with-attrs").term(regionReadbackApp(6, 10, ["el-noop"]).context)
  expect(inert.observation).toMatchObject({ outcome: "unsupported", evidence: "pixels" })

  const noBackground = await byId("erase.el-with-attrs").term(regionReadbackApp(6, 10, ["el-default-bg"]).context)
  expect(noBackground.observation).toMatchObject({ outcome: "unsupported", evidence: "pixels" })
})

test("erase.el-with-attrs restores its changed fixture after a write error", async () => {
  const writes: string[] = []
  let changed = false
  let failed = false
  const failure = new Error("fixture write failed")
  await expect(
    byId("erase.el-with-attrs").term({
      ...app({ row: 1, col: 1 }),
      write(sequence) {
        writes.push(sequence)
        if (changed && !failed) {
          failed = true
          throw failure
        }
        if (sequence === "\x1b[42m") changed = true
      },
    }),
  ).rejects.toBe(failure)
  expect(writes.at(-1)).toBe("\x1b[0m")
})
