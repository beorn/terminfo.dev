/**
 * @failure Erasure is credited without preserved controls, a failed cursor setup is blamed on a
 *   compliant erase, or app ED3 scrollback is graded from CPR or without a same-run history-observable control.
 * @level l1
 * @consumer Headless and app erase observations projected into terminal support cells.
 * @testonly none
 */
import { expect, test } from "vitest"
import { createHash } from "node:crypto"
import { decodeCollectorDraft, parseRun } from "@terminfo/run-parser"
import { eraseProbes, eraseReadbackRows } from "./erase.ts"
import { initializeRunDraft, recordExecutedProbe } from "./helpers.ts"
import { ALL_PROBES } from "./index.ts"
import { regionReadbackProbe, type RegionReadbackCell, type RegionReadbackRow } from "./region-readback-kind.ts"
import { libProbeSource, regradeRow } from "./testing/group-harness.ts"
import { createSemanticSurface } from "./testing/semantic-surface.ts"
import type { ProbeCallbackResult, ProbeSuiteManifest, TermProbeSource, LibProbeSource } from "./types.ts"

/**
 * The kind table's own rows, one per CONVERTED Erase probe, listed BY NAME so a row that loses its
 * definition - or a probe that stops being built from its row - fails here rather than as a silently
 * smaller count in a census taken later.
 *
 * `erase.screen.scrollback` is deliberately absent: it is a history claim, and the region kind compares
 * a CELL WINDOW (its one-line coverage record lives in erase.ts). `erase-contract.test.ts` binds all
 * eleven rows beside these ten.
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

/** A minimal LibProbeSource the declared screens below override. */
function headless(overrides: Partial<LibProbeSource> = {}): LibProbeSource {
  return {
    backendName: "scripted-model",
    kind: "live",
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
      overline: false,
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
 * The same TermProbeSource shape the kept hand-written rows use, plus an event log and measured geometry,
 * so a converted row is driven at the exact size on which it must refuse.
 */
function appWithEvents(rows: number, cols: number, events: string[]): TermProbeSource {
  const unexpected = (name: string): never => {
    throw new Error(`Unexpected ${name} in erase geometry fixture`)
  }
  return {
    kind: "live",
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
function declaredCell(cell: RegionReadbackCell | undefined): ReturnType<LibProbeSource["getCell"]> {
  if (cell === undefined || typeof cell === "string") {
    // A plain cell is a cell the row claims NO attributes for, not a cell whose backend reports no
    // field: a real `getCell` always says what the background is (null = none). Leaving `bg`
    // undefined here would model an unread backend, which the kind now refuses by name.
    return {
      char: cell ?? " ",
      bold: false,
      inverse: false,
      fg: null,
      bg: null,
    } as ReturnType<LibProbeSource["getCell"]>
  }
  const attributes = cell.attributes
  return {
    char: cell.char,
    bold: false,
    inverse: attributes.inverse === true,
    fg: null,
    bg: attributes.bg ?? null,
  } as ReturnType<LibProbeSource["getCell"]>
}

function declaredScreen(
  screens: Record<string, readonly (readonly RegionReadbackCell[])[]>,
  cols: number,
  cursor: { x: number; y: number } = { x: 0, y: 0 },
  baseline?: { seed: string; cells: readonly (readonly RegionReadbackCell[])[] },
): LibProbeSource {
  let cells: readonly (readonly RegionReadbackCell[])[] = []
  return headless({
    cols,
    feed: (sequence) => {
      if (baseline !== undefined && sequence === baseline.seed) {
        cells = baseline.cells
        return
      }
      const next = screens[sequence]
      if (next !== undefined) cells = next
    },
    getCell: (row, col) => declaredCell(cells[row]?.[col]),
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
const toSpaces = (grid: readonly (readonly (string | RegionReadbackCell)[])[]) =>
  grid.map((cells) =>
    cells.map((cell) => {
      if (typeof cell === "string") return cell === "" ? " " : cell
      return cell.char === "" ? " " : cell.char
    }),
  )

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
    expect(probe.libAssertionType, row.id).toBe("buffer_state")
    const measured = probe.lib!(libProbeSource(createSemanticSurface()))
    const state = JSON.parse(measured.response ?? "null") as { before: string[][]; after: string[][] }
    expect(toSpaces(state.before), `${row.id} reads the row's seed cells`).toEqual(toSpaces(row.before))
    expect(toSpaces(state.after), `${row.id} reads the row's target cells`).toEqual(toSpaces(row.after))
    expect(measured.observation, row.id).toMatchObject({ outcome: "supported", assertionType: "buffer_state" })
    expect(measured.assertions?.[0], row.id).toMatchObject({ kind: "positive" })
    const contract = KIND_TABLE_ROWS.find((entry) => entry.id === row.id)
    expect(contract, `${row.id} is named in the table`).toBeDefined()
    if (!contract) continue
    const graded = await regradeRow(probe, contract, { headless: libProbeSource(createSemanticSurface()) })
    expect(graded.after, row.id).toBe("supported")
    expect(graded.satisfies, row.id).toBe(true)
  }
})

test("the kind table replays every row deterministically", async () => {
  for (const row of KIND_TABLE_ROWS) {
    const probe = eraseProbes.find((entry) => entry.id === row.id)
    if (!probe) continue
    const first = await regradeRow(probe, row, { headless: libProbeSource(createSemanticSurface()) })
    const second = await regradeRow(probe, row, { headless: libProbeSource(createSemanticSurface()) })
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
    if (!probe?.lib) throw new Error(`Missing headless ${row.id}`)
    const cols = 24
    const step = firstStep(row.id)
    const cursor = stepCursor(row.id)
    const right = (row.region?.left ?? 1) + (row.before[0]?.length ?? 0) - 1

    const supported = probe.lib(
      declaredScreen({ [row.seed]: row.before, [step]: row.after }, cols, cursor, row.baseline),
    )
    expect(supported.observation, row.id).toMatchObject({ outcome: "supported", assertionType: "buffer_state" })
    expect(supported.assertions?.[0], row.id).toMatchObject({ kind: "positive" })

    const ignored = probe.lib(declaredScreen({ [row.seed]: row.before }, cols, cursor, row.baseline))
    expect(ignored.observation, row.id).toMatchObject({ outcome: "unsupported", assertionType: "buffer_state" })
    expect(ignored.assertions?.[0], row.id).toMatchObject({ kind: "negative" })

    const badSeed = row.before.map((cells) => cells.map(() => "?"))
    expect(probe.lib(declaredScreen({ [row.seed]: badSeed }, cols)).observation, row.id).toMatchObject({
      outcome: "inconclusive",
      reason: "insufficient-evidence",
    })

    // A grid narrower than the row's own right edge refuses before a single byte is fed.
    const narrow = declaredScreen({ [row.seed]: row.before, [step]: row.after }, right - 1, cursor)
    const fed: string[] = []
    const watched = { ...narrow, feed: (sequence: string) => fed.push(sequence) }
    expect(probe.lib(watched).observation, `${row.id} at ${right - 1} columns`).toMatchObject({
      outcome: "inconclusive",
      reason: "insufficient-evidence",
    })
    expect(fed, `${row.id} fed bytes on a screen narrower than its region`).toEqual([])
  })
}

/**
 * The base's named erase failure tests, ported to the kind table (28450 must-fix 2). A terminal
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
  if (!probe?.lib) throw new Error(`Missing headless ${id}`)
  const after = lines.map((line) => line.split(""))
  const result = probe.lib(declaredScreen({ [row.seed]: row.before, [firstStep(id)]: after }, 24, stepCursor(id)))
  expect(result.observation, `${id}: ${label}`).toMatchObject({ outcome: "unsupported", assertionType: "buffer_state" })
  expect(result.assertions?.[0], id).toMatchObject({ kind: "negative" })
})

/**
 * The setup's own witness, at kind-table scale: every erase row's single step declares the CUP cursor
 * it must reach, and a terminal whose CUP never moved the cursor reads inconclusive — the base's
 * "does not blame erasure when CHA setup is ignored", now the kind's step check (28450 must-fix 2).
 * erase.selective's CUP reaches column 1 already, so its cursor is not a deviation and is skipped.
 */
test.each(eraseReadbackRows.map((row) => row.id))("%s reads an ignored CUP inconclusive, not a bad erase", (id) => {
  const row = rowById(id)
  const probe = eraseProbes.find((entry) => entry.id === id)
  if (!probe?.lib) throw new Error(`Missing headless ${id}`)
  const cursor = stepCursor(id)
  if (cursor.x === 0 && cursor.y === 0) return
  const result = probe.lib(declaredScreen({ [row.seed]: row.before, [firstStep(id)]: row.after }, 24, { x: 0, y: 0 }))
  expect(result.observation, id).toMatchObject({ outcome: "inconclusive", reason: "insufficient-evidence" })
  expect(result.assertions, id).toBeUndefined()
})

/**
 * erase.el-with-attrs parks on row 2 and CUPs back to row 1 to erase, so an ignored CUP would erase
 * the WRONG row. Its declared cursor is (0,0), which the generic loop above skips because a static
 * double cannot express "the parked row was never left" — this test states that case explicitly, with
 * the surface still sitting on the park (0,1).
 */
test("erase.el-with-attrs reads an ignored CUP inconclusive before grading cells", () => {
  const row = rowById("erase.el-with-attrs")
  const probe = eraseProbes.find((entry) => entry.id === "erase.el-with-attrs")
  if (!probe?.lib) throw new Error("Missing headless erase.el-with-attrs")
  const result = probe.lib(
    declaredScreen({ [row.seed]: row.before, [firstStep(row.id)]: row.after }, 24, { x: 0, y: 1 }, row.baseline),
  )
  expect(result.observation).toMatchObject({ outcome: "inconclusive", reason: "insufficient-evidence" })
  expect(String(result.observation?.note)).toContain("CUP to the seeded row was ignored")
  expect(result.assertions).toBeUndefined()
})

/**
 * The nine converted rows are decided by the region verdict, so a run with no owned capture can only
 * answer "inconclusive". A fixture that can only answer that is deleted rather than kept (28450 A2), so
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
      expect(result.observation, `${row.id} at ${rows}x${cols}`).toBeUndefined()
      expect(result, `${row.id} at ${rows}x${cols}`).toMatchObject({
        tests: [
          expect.objectContaining({
            status: "probe-todo",
            reason: `${row.id}: no owned capture adapter is installed in this run, so the region fixture cannot be read back`,
          }),
        ],
      })
      expect(String(result.tests?.[0]?.reason), `${row.id} at ${rows}x${cols}`).toContain("no owned capture adapter")
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
    expect(result.observation, row.id).toBeUndefined()
    expect(result.tests, row.id).toMatchObject([
      { id: "criterion", status: "probe-invalid", reason: expect.stringContaining("cell size in pixels") },
    ])
    expect(String(result.tests?.[0]?.reason), row.id).toContain("CSI 16 t")
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
 * NO SILENT ERRORS, at load (must-fix 2): the minimum geometry DERIVES from the row.
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
  if (!probe?.lib || !probe.term) throw new Error(`missing erase callbacks for ${id}`)
  return { ...probe, term: probe.term, lib: probe.lib }
}

function eraseCellsHeadless(
  after: string,
  adjacentAfter = "KEEP!",
  missingCell?: number,
  ignoreCursorSetup = false,
): LibProbeSource {
  let erased = false
  let cursorX = 5
  const before = ["ABCDE", "KEEP!"]
  const afterRows = [after, adjacentAfter]
  return {
    backendName: "scripted-model",
    kind: "live",
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
        overline: false,
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

function app(position: { row: number; col: number } | null): TermProbeSource {
  return {
    kind: "live",
    write() {},
    queryCursorPosition: async () => position,
    measureRenderedWidth: async () => ({ kind: "no-reply", step: "sample" }) as const,
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
    const result = byId("erase.screen.scrollback").lib({
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
    expect(result.observation).toMatchObject({ outcome: expected, assertionType: "buffer_state" })
  }
})

const BOTTOM_REF = `sha256:${"b".repeat(64)}`
const HISTORY_REF = `sha256:${"c".repeat(64)}`
const ERASED_REF = `sha256:${"e".repeat(64)}`
const OTHER_REF = `sha256:${"d".repeat(64)}`
const BOTTOM_PIX = "sha256:pixels-bottom"
const HISTORY_PIX = "sha256:pixels-history"
const ERASED_PIX = "sha256:pixels-erased"
const OTHER_PIX = "sha256:pixels-other"

function scrollbackApp(script: {
  delivery?: string | null
  wheelMoves?: boolean
  clears?: boolean
  restore?: boolean
  afterRef?: string
  encodingOnly?: boolean
  divergentPixels?: boolean
  cursorOneCell?: boolean
}): {
  ctx: TermProbeSource
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
  let cursorHidden = false
  let ed3 = false
  let captureCount = 0
  let sawHistory = false
  const ctx: TermProbeSource = {
    ...app({ row: 5, col: 5 }),
    write(text) {
      writes.push(text)
      if (text.includes("\x1b[?25l")) cursorHidden = true
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
      let ref: string
      let pixelsDigest: string
      if (script.afterRef && captureCount >= 5) {
        ref = script.afterRef
        pixelsDigest = OTHER_PIX
      } else if (viewport === "history" && historyExists) {
        ref = HISTORY_REF
        pixelsDigest = HISTORY_PIX
      } else if (ed3) {
        ref = ERASED_REF
        pixelsDigest = ERASED_PIX
      } else {
        if (script.cursorOneCell && !cursorHidden && captureCount > 1) {
          // The visible cursor occupies a cell the first frame did not carry: one cell of drift.
          ref = OTHER_REF
          pixelsDigest = OTHER_PIX
        } else if (script.divergentPixels) {
          ref = OTHER_REF
          pixelsDigest = OTHER_PIX
        } else if (script.encodingOnly && sawHistory) {
          ref = OTHER_REF
          pixelsDigest = BOTTOM_PIX
        } else {
          ref = BOTTOM_REF
          pixelsDigest = BOTTOM_PIX
        }
      }
      if (viewport === "history" && historyExists) sawHistory = true
      return { role, label, capturedAt: Date.now(), ref, pixelsDigest }
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
    // Only a run with NO observable at all keeps this verdict: an owned history reader decides the
    // row instead of the wheel, so the reader is removed here and exercised below.
    getScrollback: undefined,
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

/** A run whose only observable is the owned history reader: each read takes the next scripted count
 * of lines above the screen, and the base ctx has no capture, input or readInput at all. */
function ownedHistoryApp(script: ReadonlyArray<number | Error>) {
  const writes: string[] = []
  let index = 0
  const ctx = {
    ...app({ row: 3, col: 6 }),
    rows: 20,
    cols: 40,
    write: (text: string) => writes.push(text),
    getScrollback: async () => {
      const next = script[Math.min(index, script.length - 1)] ?? new Error("the script ran out of readings")
      index += 1
      if (next instanceof Error) throw next
      return { viewportOffset: 0, totalLines: 20 + next, screenLines: 20 }
    },
  }
  return { ctx, writes }
}

test("erase.screen.scrollback is decided by an owned history reader, without XTEST or capture", async () => {
  const { ctx, writes } = ownedHistoryApp([30, 0, 5])
  const result = await byId("erase.screen.scrollback").term(ctx)
  expect(writes.join("")).toContain("\x1b[3J")
  expect(result.observation).toMatchObject({ outcome: "supported", assertionType: "buffer_state" })
  const recorded = JSON.parse(result.response ?? "{}") as {
    rows: number
    seeded: number
    before: number
    after: number
    alive: number
    fences: unknown[]
  }
  expect([recorded.rows, recorded.seeded, recorded.before, recorded.after, recorded.alive]).toEqual([20, 50, 30, 0, 5])
  expect(recorded.fences).toHaveLength(3)
  expect(result.note).toMatch(/owned history 30 -> 0 lines above a 20-line screen, and 5 after 25 more/)
})

test("erase.screen.scrollback refuses to grade a seed below the criterion's own 30 lines", async () => {
  const { ctx, writes } = ownedHistoryApp([0])
  const result = await byId("erase.screen.scrollback").term(ctx)
  expect(writes.join("")).not.toContain("\x1b[3J")
  expect(result.observation).toMatchObject({ outcome: "inconclusive", reason: "insufficient-evidence" })
  expect(result.observation?.note).toMatch(/fewer than the 30 written past it/)
})

test("erase.screen.scrollback will not read an erase from a reader that stopped answering", async () => {
  const { ctx } = ownedHistoryApp([30, 0, 0])
  const result = await byId("erase.screen.scrollback").term(ctx)
  expect(result.pass).toBe(false)
  expect(result.observation).toMatchObject({ outcome: "inconclusive", reason: "insufficient-evidence" })
  expect(result.observation?.note).toMatch(/not answering/)
})

test("erase.screen.scrollback fails when ED3 leaves the owned history in place", async () => {
  const { ctx } = ownedHistoryApp([30, 12])
  const result = await byId("erase.screen.scrollback").term(ctx)
  expect(result.pass).toBe(false)
  expect(result.note).toMatch(/ED3 left the history in place/)
})

test("erase.screen.scrollback names a failing history reader rather than grading it", async () => {
  const { ctx, writes } = ownedHistoryApp([new Error("cmux-read-empty: cmux read-screen returned no lines")])
  const result = await byId("erase.screen.scrollback").term(ctx)
  expect(writes.join("")).not.toContain("\x1b[3J")
  expect(result.observation).toMatchObject({ outcome: "inconclusive", reason: "collector-error" })
  expect(result.observation?.note).toMatch(/cmux-read-empty/)
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

test("erase.screen.scrollback is inconclusive, naming the cause, when wheel-down does not restore the bottom", async () => {
  const { ctx, clicks } = scrollbackApp({ restore: false })
  const result = await byId("erase.screen.scrollback").term(ctx)
  expect(clicks).toEqual([4, 5, 5])
  expect(result.notTested).toBeUndefined()
  expect(result.observation).toMatchObject({
    outcome: "inconclusive",
    reason: "insufficient-evidence",
    assertionType: "screenshot",
    screenshotRef: HISTORY_REF,
  })
  expect(result.observation?.note).toMatch(/captured pixels differ/i)
})

test("erase.screen.scrollback grades when the refs differ but the pixels agree", async () => {
  // A ref names the encoded container; two identical screens can carry different refs. Before 30080
  // this read not tested on every Linux context, because the restore check compared refs alone.
  const { ctx } = scrollbackApp({ clears: true, encodingOnly: true })
  const result = (await byId("erase.screen.scrollback").term(ctx)) as ProbeCallbackResult
  expect(result.notTested).toBeUndefined()
  expect(result.observation).toMatchObject({ outcome: "supported", assertionType: "screenshot" })
})

test("erase.screen.scrollback names moving pixels as inconclusive when the return never settles", async () => {
  const { ctx } = scrollbackApp({ restore: false, divergentPixels: true })
  const result = await byId("erase.screen.scrollback").term(ctx)
  expect(result.notTested).toBeUndefined()
  expect(result.observation).toMatchObject({ outcome: "inconclusive", assertionType: "screenshot" })
  expect(result.observation?.note).toMatch(/captured pixels differ/i)
})

test("erase.screen.scrollback records unsupported when history remains after ED3", async () => {
  const { ctx, keys, clicks, writes } = scrollbackApp({ clears: false })
  const result = (await byId("erase.screen.scrollback").term(ctx)) as ProbeCallbackResult
  expect(keys).toEqual(["a"])
  expect(clicks).toEqual([4, 5, 4, 5])
  expect(writes.join("")).toContain("\x1b[3J")
  expect(writes.join("")).not.toMatch(/\x1b\[\?100[027]h/)
  expect(result.observation).toMatchObject({ outcome: "unsupported", assertionType: "screenshot" })
  expect(result.assertions?.[0]).toMatchObject({ kind: "negative", action: "erase.screen.scrollback:ed3" })
  const observed = JSON.parse(result.assertions?.[0]?.observed ?? "null") as Record<string, unknown>
  expect(observed).toMatchObject({ history: HISTORY_REF, after: HISTORY_REF })
})

test("erase.screen.scrollback records supported when wheel-up after ED3 stays on the post-ED3 frame", async () => {
  const { ctx, keys, clicks, writes } = scrollbackApp({ clears: true })
  const result = (await byId("erase.screen.scrollback").term(ctx)) as ProbeCallbackResult
  expect(keys).toEqual(["a"])
  expect(clicks).toEqual([4, 5, 4, 5])
  expect(writes.join("")).toContain("\x1b[3J")
  expect(writes.join("")).not.toMatch(/\x1b\[\?100[027]h/)
  expect(result.observation).toMatchObject({ outcome: "supported", assertionType: "screenshot" })
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
    assertionType: "screenshot",
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

test("erase.screen.scrollback keeps its XTEST verdict when a history reader is also present (@cto 8511f7e3 condition e)", async () => {
  const { ctx, keys, clicks } = scrollbackApp({ clears: true })
  let readerCalls = 0
  const withReader: TermProbeSource = {
    ...ctx,
    getScrollback: async () => {
      readerCalls += 1
      throw new Error("the owned history reader must not decide a run that has capture, input and readInput")
    },
  }
  const result = (await byId("erase.screen.scrollback").term(withReader)) as ProbeCallbackResult
  expect(readerCalls).toBe(0)
  expect(keys).toEqual(["a"])
  expect(clicks).toEqual([4, 5, 4, 5])
  expect(result.observation).toMatchObject({ outcome: "supported", assertionType: "screenshot" })
})

test("erase.screen.scrollback hands the decision to the reader when ANY of capture, input and readInput is absent", async () => {
  const { ctx, clicks } = scrollbackApp({ clears: true })
  let readerCalls = 0
  const readings = [ctx.rows + 37, ctx.rows, ctx.rows + 5]
  const withReader: TermProbeSource = {
    ...ctx,
    // Capture and XTEST input stay present: only the injected-input listener is gone, which is enough
    // for the history reader to own the verdict (@cto 8511f7e3 condition e reads "any", not "all").
    readInput: undefined,
    getScrollback: async () => {
      const totalLines = readings[Math.min(readerCalls, readings.length - 1)] ?? ctx.rows
      readerCalls += 1
      return { viewportOffset: 0, totalLines, screenLines: ctx.rows }
    },
  }
  const result = await byId("erase.screen.scrollback").term(withReader)
  expect(readerCalls).toBe(3)
  expect(clicks).toEqual([])
  expect(result.observation).toMatchObject({ outcome: "supported", assertionType: "buffer_state" })
  expect(result.note).toContain(
    `owned history 37 -> 0 lines above a ${ctx.rows}-line screen, and 5 after ${ctx.rows + 5} more`,
  )
})

/**
 * @failure The erase arm reads a count through an owned reader and drops the reader's own pane identity, so
 *   the artifact can only show which program ran, not which pane was read (@cto 238ed303).
 * @level l1
 * @consumer erase.screen.scrollback owned-reader arm through the public asynchronous source.
 * @testonly none
 */
test("erase.screen.scrollback carries the reader's pane receipt into its own evidence", async () => {
  const { ctx } = scrollbackApp({ clears: true })
  let readerCalls = 0
  const readings = [ctx.rows + 37, ctx.rows, ctx.rows + 5]
  const withReader: TermProbeSource = {
    ...ctx,
    readInput: undefined,
    getScrollback: async () => {
      const totalLines = readings[Math.min(readerCalls, readings.length - 1)] ?? ctx.rows
      readerCalls += 1
      return {
        viewportOffset: 0,
        totalLines,
        screenLines: ctx.rows,
        receipt: JSON.stringify({ pane: readerCalls, tty: "/dev/ttys000" }),
      }
    },
  }
  const result = (await byId("erase.screen.scrollback").term(withReader)) as ProbeCallbackResult
  expect(result.observation).toMatchObject({ outcome: "supported" })
  const observed = JSON.parse(String(result.assertions?.[0]?.observed ?? "{}")) as {
    receipts?: Record<string, string>
  }
  const receipts = observed.receipts ?? {}
  expect(Object.keys(receipts)).toEqual(["seed", "ED3", "alive"])
  expect(receipts.seed).toContain('"pane":1')
  expect(receipts.ED3).toContain('"pane":2')
  expect(receipts.alive).toContain('"pane":3')
})

test("multiplexer erase.screen.scrollback decides from tmux and screen history counts before and after ED3 (#32774, #32784, @cto e078c568, addfd7b2)", async () => {
  const featureId = "erase.screen.scrollback"
  const sourceRevision = "a".repeat(40)
  const measuredAt = "2026-11-09T09:00:00.000Z"
  const manifest: ProbeSuiteManifest & { schemaVersion: 4 } = {
    schemaVersion: 4,
    probeHash: "abcdef123456",
    sourceRevision,
    generatedAt: measuredAt,
    adapterVersion: "test",
    catalogIds: [featureId],
    probes: { term: [], lib: [], mux: [featureId] },
  }
  const runMux = async (
    mux: "tmux" | "screen",
    readings: Array<{ totalLines: number; screenLines: number } | Error>,
  ) => {
    const base = scrollbackApp({ wheelMoves: false, clears: true })
    const reads = [...readings]
    const ctx: TermProbeSource = {
      ...base.ctx,
      mux,
      getScrollback: async () => {
        const next = reads.shift()
        if (next === undefined) throw new Error("unexpected extra history read")
        if (next instanceof Error) throw next
        return next
      },
    }
    const callbackResult = await byId(featureId).term(ctx)
    const assertions = (callbackResult.assertions ?? []).map((entry) => ({
      featureId,
      rawReplyRef: featureId,
      ...entry,
    }))
    const observation = callbackResult.observation
      ? { featureId, rawReplyRef: featureId, ...callbackResult.observation }
      : undefined
    const recorded = recordExecutedProbe({
      featureId,
      attempt: { scope: "probe", startedAt: measuredAt },
      rawReplyRef: featureId,
      observation,
      assertions,
    })
    const rawReplies: Record<string, string> = {
      [featureId]: JSON.stringify({
        writes: base.writes,
        queries: [],
        events: [],
        captures: [],
      }),
      ...(callbackResult.response !== undefined ? { [`${featureId}.callbackResponse`]: callbackResult.response } : {}),
    }
    const screenshotRefs = [BOTTOM_REF, HISTORY_REF, ERASED_REF, OTHER_REF]
    const initialized = initializeRunDraft({
      source: { kind: "live" },
      runId: "1234567890abcdef1234567890abcdef",
      sourceRevision,
      manifest,
      intendedSubject: { kind: "mux", id: mux, version: "3.5a" },
    })
    const draft = {
      ...initialized,
      subject: {
        kind: "mux" as const,
        id: mux,
        version: "3.5a",
        os: "linux" as const,
        osVersion: null,
        outerTerminal: "kitty",
        mux: null,
        config: null,
        permissions: null,
      },
      identity: "unverified" as const,
      measuredAt,
      origin: { kind: "collector" as const },
      rawReplies,
      assertions,
      results: initialized.results.map((entry) => (entry.featureId === featureId ? recorded : entry)),
      screenshotRefs,
    }
    const decoded = decodeCollectorDraft(`${mux}-ed3.json`, JSON.stringify(draft), manifest, sourceRevision)
    const parsed = parseRun(
      `${mux}-ed3.json`,
      JSON.stringify({ ...draft, sealedAt: "2026-11-09T09:01:00.000Z" }),
      [featureId],
      new Map([[manifest.probeHash, manifest]]),
    )
    expect(callbackResult.observation).not.toHaveProperty("frames")
    expect(decoded.run.results?.[0]?.status).toBe(recorded.status)
    expect(parsed.results?.[0]?.status).toBe(recorded.status)
    expect(parsed.results?.[0]).not.toHaveProperty("frames")
    const state = JSON.parse(callbackResult.response ?? "null") as {
      frames?: Array<Record<string, unknown>>
      muxHistory?: { mux: string }
    }
    expect(state.frames).toHaveLength(5)
    for (const entry of state.frames ?? []) {
      expect(Object.keys(entry).sort()).toEqual(["label", "ref"])
    }
    expect(state.muxHistory?.mux).toBe(mux)
    return { callbackResult, recorded, parsed, draft, reads }
  }
  const history = (lines: number, screenLines = 24) => ({ totalLines: lines + screenLines, screenLines })

  const tmuxErased = await runMux("tmux", [history(709), history(0)])
  expect(tmuxErased.recorded.status).toBe("supported")
  expect(tmuxErased.recorded.reason).toMatch(/tmux history_size 709 -> 0/)
  expect(JSON.parse(tmuxErased.parsed.assertions?.[0]?.observed ?? "null")).toMatchObject({
    muxHistory: { mux: "tmux", before: 709, after: 0 },
  })
  expect(tmuxErased.reads, "one read before ED3 and one after").toEqual([])

  const tmuxKept = await runMux("tmux", [history(709), history(709)])
  expect(tmuxKept.callbackResult).toMatchObject({ pass: false, observation: { outcome: "unsupported" } })
  expect(tmuxKept.recorded.reason).toMatch(/tmux history_size 709 -> 709/)
  expect(JSON.parse(tmuxKept.parsed.assertions?.[0]?.observed ?? "null")).toMatchObject({
    muxHistory: { mux: "tmux", before: 709, after: 709 },
  })

  const tmuxUnseeded = await runMux("tmux", [history(0), history(0)])
  expect(tmuxUnseeded.recorded.status).toBe("probe-invalid")
  expect(tmuxUnseeded.recorded.reason).toMatch(/seeding never reached tmux history/)

  const tmuxFailed = await runMux("tmux", [new Error('Owned tmux scrollback reading malformed: "garbage"'), history(0)])
  expect(tmuxFailed.recorded.status).toBe("probe-invalid")
  expect(tmuxFailed.recorded.reason).toMatch(
    /display-message -p "#\{history_size\}.* failed: Owned tmux scrollback reading malformed: "garbage"/,
  )

  const screenErased = await runMux("screen", [history(22, 20), history(0, 20)])
  expect(screenErased.recorded.status).toBe("supported")
  expect(screenErased.recorded.reason).toMatch(/screen history 22 -> 0/)
  expect(JSON.parse(screenErased.parsed.assertions?.[0]?.observed ?? "null")).toMatchObject({
    muxHistory: { mux: "screen", before: 22, after: 0 },
  })
  expect(screenErased.reads, "one read before ED3 and one after").toEqual([])

  const screenKept = await runMux("screen", [history(22, 20), history(22, 20)])
  expect(screenKept.callbackResult).toMatchObject({ pass: false, observation: { outcome: "unsupported" } })
  expect(screenKept.recorded.status).toBe("unsupported")
  expect(screenKept.recorded.reason).toMatch(/screen history 22 -> 22.*ED3 left the history in place/)
  expect(JSON.parse(screenKept.parsed.assertions?.[0]?.observed ?? "null")).toMatchObject({
    muxHistory: { mux: "screen", before: 22, after: 22 },
  })

  // #32786 / @cto 57c9ba53: mux socket history reads (`tmux display-message` and `screen -X hardcopy -h`)
  // run out-of-band from the inner PTY, so each read requires a DSR 6 cursor-position reply fence after
  // the PTY write (`seed` and `\x1b[3J`) before `getScrollback()` inspects the multiplexer.
  for (const mux of ["tmux", "screen"] as const) {
    const base = scrollbackApp({ wheelMoves: false, clears: true })
    const events: string[] = []
    let stagedHistory = 0
    let committedHistory = 0
    const fencedCtx: TermProbeSource = {
      ...base.ctx,
      mux,
      write(text) {
        base.ctx.write(text)
        if (text.includes("\r\n")) {
          events.push("write:seed")
          stagedHistory = 22
        } else if (text.includes("\x1b[3J")) {
          events.push("write:ed3")
          stagedHistory = 0
        }
      },
      queryCursorPosition: async () => {
        events.push("fence:dsr6")
        committedHistory = stagedHistory
        return { row: 20, col: 1 }
      },
      getScrollback: async () => {
        events.push(`read:${committedHistory}`)
        return history(committedHistory, 20)
      },
    }
    const fencedResult = await byId(featureId).term(fencedCtx)
    expect(fencedResult).toMatchObject({ pass: true, observation: { outcome: "supported" } })
    expect(events).toEqual(["write:seed", "fence:dsr6", "read:22", "write:ed3", "fence:dsr6", "read:0"])

    let cursorQueries = 0
    let scrollbackReads = 0
    const unfencedCtx: TermProbeSource = {
      ...base.ctx,
      mux,
      queryCursorPosition: async () => {
        cursorQueries += 1
        return cursorQueries === 1 ? { row: 20, col: 1 } : null
      },
      getScrollback: async () => {
        scrollbackReads += 1
        return history(22, 20)
      },
    }
    const unfencedResult = await byId(featureId).term(unfencedCtx)
    expect(scrollbackReads, `${mux} after-read must not run when the post-ED3 DSR 6 fence fails`).toBe(1)
    expect(unfencedResult.observation).toMatchObject({
      outcome: "inconclusive",
      reason: "no-response",
      assertionType: "buffer_state",
    })
    expect(unfencedResult.observation?.note).toMatch(/cursor-position reply.*ED3/i)
  }
})

/**
 * The attribute claim is RELATIVE, and this table measures exactly that: the seed must report SOME
 * background, the erased cells must keep the one the seed painted at that position, and a terminal
 * that drops to the default (or keeps the characters) is a measured negative. An unread background is
 * not expressible here — `getCell` reports `null` for "no colour", never "unknown" — so every row of
 * the table is a decided or refused reading, never an unmeasured one graded by accident.
 */
test("background erase measures a blank target that carries the seeded background", () => {
  const row = rowById("erase.el-with-attrs")
  const step = firstStep("erase.el-with-attrs")
  const probe = eraseProbes.find((entry) => entry.id === "erase.el-with-attrs")
  if (!probe?.lib) throw new Error("Missing headless erase.el-with-attrs")
  const background = { r: 130, g: 20, b: 70 }
  const other = { r: 1, g: 2, b: 3 }
  const baselineSeed = row.baseline?.seed
  if (baselineSeed === undefined) throw new Error("erase.el-with-attrs has no default-background fixture")
  const run = (
    seedBg: { r: number; g: number; b: number } | null,
    afterBg: { r: number; g: number; b: number } | null,
    char = " ",
    seedChar = "X",
  ) => {
    // Three measured phases: the terminal's own default, the seed the row paints, then the erase.
    let phase: "default" | "seed" | "after" = "default"
    return probe.lib!(
      headless({
        feed: (sequence) => {
          if (sequence === baselineSeed) phase = "default"
          else if (sequence === step) phase = "after"
          else if (sequence === row.seed) phase = "seed"
        },
        getCell: (_cellRow, col) => ({
          char: phase === "after" ? char : phase === "seed" ? seedChar : "X",
          bold: false,
          dim: false,
          italic: false,
          underline: false,
          strikethrough: false,
          inverse: false,
          hidden: false,
          blink: false,
          overline: false,
          fg: null,
          bg: (phase === "after" ? afterBg : phase === "seed" ? seedBg : null) ?? null,
          wide: false,
        }),
      }),
    )
  }
  // The claim, measured: a blank cell keeping the seed's own background is the ONLY supported frame.
  expect(run(background, background).observation).toMatchObject({ outcome: "supported", assertionType: "buffer_state" })
  expect(run(background, background).assertions?.[0]).toMatchObject({ kind: "positive" })
  // The measured negative: the erased cells fall back to the default background, or keep the
  // character that EL should have removed.
  expect(run(background, null).observation).toMatchObject({ outcome: "unsupported", assertionType: "buffer_state" })
  expect(run(background, background, "X").observation).toMatchObject({ outcome: "unsupported" })
  // A different colour is not the seeded one: the relative claim is exact on this adapter.
  expect(run(background, other).observation).toMatchObject({ outcome: "unsupported" })
  // #31940: an unpainted seed is an execution precondition failure, never a negative erase claim.
  const unseeded = run(null, background)
  expect(unseeded.notTested).toBeUndefined()
  expect(unseeded.criterionBranch).toBeUndefined()
  expect(unseeded.tests).toEqual([
    {
      id: "criterion",
      status: "probe-invalid",
      reason: expect.stringContaining(
        "Test broken: the background colour we painted before the test did not show (expected it on 5 screen cells, read none).",
      ),
    },
  ])
  expect(unseeded.observation).toBeUndefined()
  expect(unseeded.assertions).toBeUndefined()
  // A seed whose measured character is not the row's own means the fixture never landed, so nothing
  // may be graded from it.
  const wrongSeed = run(background, background, " ", "?")
  expect(wrongSeed.observation).toMatchObject({ outcome: "inconclusive", reason: "insufficient-evidence" })
  expect(String(wrongSeed.observation?.note)).toBe(row.seedNote)
  expect(wrongSeed.assertions).toBeUndefined()
})

/**
 * An unread (undefined) baseline colour is not "different" from the painted seed.
 * `unpaintedColor` used to skip its refusal on an undefined channel, which let the seed be qualified
 * by a measurement that never happened — the same vacuous-pass class P2 1 closed. Refuse by name.
 */
test("an unread default-background colour cannot qualify the painted seed", () => {
  const row = rowById("erase.el-with-attrs")
  const step = firstStep("erase.el-with-attrs")
  const probe = eraseProbes.find((entry) => entry.id === "erase.el-with-attrs")
  if (!probe?.lib) throw new Error("Missing headless erase.el-with-attrs")
  const baselineSeed = row.baseline?.seed
  if (baselineSeed === undefined) throw new Error("erase.el-with-attrs has no default-background fixture")
  let phase: "default" | "seed" | "after" = "default"
  const result = probe.lib(
    headless({
      feed: (sequence) => {
        if (sequence === baselineSeed) phase = "default"
        else if (sequence === step) phase = "after"
        else if (sequence === row.seed) phase = "seed"
      },
      getCell: () =>
        ({
          char: phase === "after" ? " " : "X",
          bold: false,
          dim: false,
          italic: false,
          underline: false,
          strikethrough: false,
          inverse: false,
          hidden: false,
          blink: false,
          overline: false,
          fg: null,
          // The default-background seed never reports its colour; the painted seed does.
          bg: phase === "default" ? undefined : { r: 130, g: 20, b: 70 },
          wide: false,
        }) as ReturnType<LibProbeSource["getCell"]>,
    }),
  )
  expect(result.observation).toMatchObject({ outcome: "inconclusive", reason: "insufficient-evidence" })
  expect(String(result.observation?.note)).toContain("does not report bg")
  expect(result.assertions).toBeUndefined()
})

/**
 * The row's SGR 42 is still set when a step throws, so the arm's `finally` must feed the row's own
 * reset — otherwise the next probe on this terminal inherits a background nobody measured.
 */
test("a step that throws still feeds the row's reset", () => {
  const row = rowById("erase.el-with-attrs")
  const step = firstStep("erase.el-with-attrs")
  const probe = eraseProbes.find((entry) => entry.id === "erase.el-with-attrs")
  if (!probe?.lib) throw new Error("Missing headless erase.el-with-attrs")
  const writes: string[] = []
  const baselineSeed = row.baseline?.seed
  if (baselineSeed === undefined) throw new Error("erase.el-with-attrs has no default-background fixture")
  let phase: "default" | "seed" = "default"
  expect(() =>
    probe.lib!(
      headless({
        feed: (sequence) => {
          writes.push(sequence)
          if (sequence === baselineSeed) phase = "default"
          else if (sequence === row.seed) phase = "seed"
          if (sequence === step) throw new Error("step write failed")
        },
        getCell: () =>
          ({
            char: "X",
            bold: false,
            dim: false,
            italic: false,
            underline: false,
            strikethrough: false,
            inverse: false,
            hidden: false,
            blink: false,
            overline: false,
            fg: null,
            bg: phase === "seed" ? { r: 130, g: 20, b: 70 } : null,
            wide: false,
          }) as ReturnType<LibProbeSource["getCell"]>,
      }),
    ),
  ).toThrow(/step write failed/)
  expect(writes.includes(step)).toBe(true)
  expect(writes.at(-1)).toBe(row.reset)
})

/**
 * A backend that reports ONE concrete RGB as its default and
 * ignores SGR 42 satisfies both `present` on the seed and `same-as-before` on the erased cells, so
 * the colour fixture was never established. The default-versus-painted qualification must catch it
 * and refuse BY NAME — never grade the erase supported.
 */
test("a constant default background cannot establish the painted seed", () => {
  const step = firstStep("erase.el-with-attrs")
  const constant = { r: 0, g: 0, b: 0 }
  let erased = false
  const probe = eraseProbes.find((entry) => entry.id === "erase.el-with-attrs")
  if (!probe?.lib) throw new Error("Missing headless erase.el-with-attrs")
  const result = probe.lib(
    headless({
      feed: (sequence) => {
        if (sequence === step) erased = true
      },
      getCell: () => ({
        char: erased ? " " : "X",
        bold: false,
        dim: false,
        italic: false,
        underline: false,
        strikethrough: false,
        inverse: false,
        hidden: false,
        blink: false,
        overline: false,
        fg: null,
        bg: constant,
        wide: false,
      }),
    }),
  )
  expect(result.observation).toMatchObject({ outcome: "inconclusive", reason: "insufficient-evidence" })
  expect(String(result.observation?.note)).toContain("default")
  expect(result.assertions).toBeUndefined()
})

/**
 * An attribute cell whose colour the backend does not report at all is UNREAD, never equal: the row
 * must refuse by name instead of grading a negative (or throwing) on metadata the adapter lacked.
 */
test("an unread background on the erased cells is named inconclusive", () => {
  const row = rowById("erase.el-with-attrs")
  const step = firstStep("erase.el-with-attrs")
  const probe = eraseProbes.find((entry) => entry.id === "erase.el-with-attrs")
  if (!probe?.lib) throw new Error("Missing headless erase.el-with-attrs")
  const baselineSeed = row.baseline?.seed
  if (baselineSeed === undefined) throw new Error("erase.el-with-attrs has no default-background fixture")
  let phase: "default" | "seed" | "after" = "default"
  const result = probe.lib(
    headless({
      feed: (sequence) => {
        if (sequence === baselineSeed) phase = "default"
        else if (sequence === step) phase = "after"
        else if (sequence === row.seed) phase = "seed"
      },
      getCell: () =>
        ({
          char: phase === "after" ? " " : "X",
          bold: false,
          dim: false,
          italic: false,
          underline: false,
          strikethrough: false,
          inverse: false,
          hidden: false,
          blink: false,
          overline: false,
          fg: null,
          bg: phase === "after" ? undefined : phase === "seed" ? { r: 1, g: 2, b: 3 } : null,
          wide: false,
        }) as ReturnType<LibProbeSource["getCell"]>,
    }),
  )
  expect(result.observation).toMatchObject({ outcome: "inconclusive", reason: "insufficient-evidence" })
  expect(String(result.observation?.note)).toContain("does not report")
  expect(result.assertions).toBeUndefined()
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
  const context: TermProbeSource = {
    kind: "live",
    rows,
    cols,
    write: (bytes) => {
      writes.push(bytes)
      surface.feed(bytes)
    },
    queryCursorPosition: async () => null,
    measureRenderedWidth: async () => ({ kind: "no-reply", step: "sample" }) as const,
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
  expect(conforming.observation).toMatchObject({ outcome: "supported", assertionType: "screenshot" })

  const inert = await byId("erase.el-with-attrs").term(regionReadbackApp(6, 10, ["el-noop"]).context)
  expect(inert.observation).toMatchObject({ outcome: "unsupported", assertionType: "screenshot" })

  const noBackground = await byId("erase.el-with-attrs").term(regionReadbackApp(6, 10, ["el-default-bg"]).context)
  expect(noBackground.observation).toMatchObject({ outcome: "unsupported", assertionType: "screenshot" })
})

/**
 * Both load-time refusals that protect the relative claim are pinned here. A row that
 * claims a background it never paints, or paints one it never calibrates against a baseline, is a
 * fixture bug and must fail at LOAD rather than ship a claim no adapter can decide.
 */
test("a relative background claim refuses to load without its paint bytes", () => {
  const row = rowById("erase.el-with-attrs")
  // The ROW ID makes the assertion name this row's load refusal rather than any later failure:
  // paintBytes only strips the SGR wrapper, so no row-less fallback can satisfy this pattern.
  expect(() => regionReadbackProbe({ ...row, paint: undefined })).toThrow(
    new RegExp(`${row.id}: cell \\d+,\\d+ asserts a relative bg with no paint bytes`),
  )
})

test("a relative background claim in the ignored frame refuses to load by row id", () => {
  const row = rowById("erase.el-with-attrs")
  const ignored = row.after.map((cells) =>
    cells.map((cell) =>
      typeof cell === "string" ? cell : { char: cell.char, attributes: { bg: cell.attributes.bg } },
    ),
  )
  const claimed = ignored.flat().some((cell) => typeof cell !== "string" && cell.attributes.bg !== undefined)
  expect(claimed, "the fixture needs at least one relative bg claim").toBe(true)
  // The after frame keeps the same geometry as PLAIN characters, so the ignored frame is the only
  // place a relative bg claim survives; a fixture whose after frame carried the claims too would
  // stay green with the ignored scan deleted.
  const after = row.after.map((cells) => cells.map((cell) => (typeof cell === "string" ? cell : cell.char)))
  expect(() => regionReadbackProbe({ ...row, after, ignored, paint: undefined })).toThrow(
    new RegExp(`${row.id}: cell \\d+,\\d+ asserts a relative bg with no paint bytes`),
  )
})

test("an empty paint string refuses at load by row id, not in the painter", () => {
  const row = rowById("erase.el-with-attrs")
  // Falsy, not only undefined: an empty string paints nothing, so it must not slip past the load
  // check and reach the frame builder as a claim no adapter can decide.
  expect(() => regionReadbackProbe({ ...row, paint: { bg: "" } })).toThrow(
    new RegExp(`${row.id}: cell \\d+,\\d+ asserts a relative bg with no paint bytes`),
  )
})

test("a relative background claim refuses to load without a baseline fixture", () => {
  const row = rowById("erase.el-with-attrs")
  expect(() => regionReadbackProbe({ ...row, baseline: undefined })).toThrow(/needs a baseline fixture/)
})

test("erase.screen.scrollback hides the cursor so a one-cell cursor is not graded as a failed restore", async () => {
  // Requirement (32774): every capture in this arm observes the same cursor state, so the bottom
  // frame and the wheel-down restore compare equal when the cursor cell is the only difference.
  // Gap this closes: no existing test drove frames that differ by ONE cell purely because DECTCEM
  // was never turned off. The harness below reports exactly that unless "\x1b[?25l" was written.
  const { ctx } = scrollbackApp({ clears: true, cursorOneCell: true })
  const result = (await byId("erase.screen.scrollback").term(ctx)) as ProbeCallbackResult
  expect(result.observation).toMatchObject({ outcome: "supported", assertionType: "screenshot" })
})
