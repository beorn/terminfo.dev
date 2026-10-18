/**
 * @failure A sparse or uncalibrated cell readback reports a line edit as support even when a kind row's seed, its target cells or an unchanged control is wrong - so the Editing family's declared table and the frozen suite disagree.
 * @level l0
 * @consumer Headless editing observations in the selected terminal results.
 * @testonly none
 */
import { expect, test } from "vitest"
import { editingProbes, editingReadbackRows } from "./editing.ts"
import { ALL_PROBES } from "./index.ts"
import { regionReadbackProbe } from "./region-readback-kind.ts"
import { headlessContext, regradeRow } from "./testing/group-harness.ts"
import { createSemanticSurface } from "./testing/semantic-surface.ts"
import type { TermlessContext } from "./types.ts"

/**
 * The kind table's own rows, one per CONVERTED Editing probe, listed BY NAME so a row that loses its
 * definition - or a probe that stops being built from its row - fails here rather than as a silently
 * smaller count in a census taken later.
 *
 * `editing.deccara` and `editing.decrara` are deliberately absent: they are attribute rectangles, and
 * the region kind compares characters (their one-line coverage record lives on `EDITING_CAPTURE_SPECS`
 * in editing.ts). `editing-contract.test.ts` binds all four hand-written rows -
 * deccara/decrara/decsace/decrqcra - beside these thirteen.
 */
const KIND_TABLE_ROWS = editingReadbackRows.map((row) => ({
  id: row.id,
  expected: "decided" as const,
  claim: row.expected,
}))

/**
 * Tests dropped by the 28450 slice C conversion, each named with its replacement (this file used to
 * drive the thirteen hand-written termless callbacks directly):
 *  - "binds a measured edit to cells and calibrated controls" / "classifies measured cells only after
 *    calibrated setup" -> "every kind row decides from its own cells, through the shared kind" plus
 *    "<row> binds its claim to its own cells and calibrated controls".
 *  - their per-case "bad cursor" branch -> dropped: a kind row HAS no cursor step of its own. The CUP
 *    is part of the row's one `steps` write and its effect lands in the compared grid, so a terminal
 *    that mis-places the cursor reads unsupported or inconclusive through the cells, not the cursor.
 *  - "DECFRA third-row overfill invalidates its measured flank" -> the row's own `controls`: a moved
 *    flank reads inconclusive through "<row> binds its claim to its own cells and calibrated controls".
 *  - "accepts empty cells as positional blanks" / "SL refuses a misplaced empty cell that collapses
 *    to the expected joined text" -> the kind's cell-by-cell `sameCell` (region-readback-kind.ts): a
 *    blank is accepted as reserved-empty or as a space, and a misplaced cell can never match because
 *    cells are compared one per column, never as a joined line.
 *  - "SL accounts for measured incoming columns 10 and 11 on a wider screen" -> dropped: the row owns
 *    the nine columns it compares, so a wider screen can no longer move what the row reads.
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
 * A headless surface whose screen is exactly the grid a test declares for each sequence the row feeds:
 * a sequence the test does not name leaves the grid unchanged, which is how a test says "this terminal
 * ignored that operation". The declared grid is the terminal's own behaviour, so a row reads supported
 * only when its frame agrees with a terminal the test drove independently.
 */
function declaredScreen(screens: Record<string, readonly (readonly string[])[]>, cols: number): TermlessContext {
  let cells: readonly (readonly string[])[] = []
  return headless({
    cols,
    feed: (sequence) => {
      const next = screens[sequence]
      if (next !== undefined) cells = next
    },
    getCell: (row, col) => ({ char: cells[row]?.[col] ?? " " }) as ReturnType<TermlessContext["getCell"]>,
  })
}

/** The kind reads a blank as `""` or `" "` alike, so a compare normalizes BOTH grids to spaces. */
const toSpaces = (grid: readonly (readonly string[])[]) =>
  grid.map((cells) => cells.map((cell) => (cell === "" ? " " : cell)))

const firstStep = (id: string): string => {
  const row = editingReadbackRows.find((entry) => entry.id === id)
  const write = row?.steps[0]?.write
  if (write === undefined) throw new Error(`missing single step for ${id}`)
  return write
}

test("the kind table names every converted editing row, and every row reaches the frozen suite", () => {
  expect(editingReadbackRows.map((row) => row.id)).toEqual(KIND_TABLE_ROWS.map((row) => row.id))
  for (const row of editingReadbackRows) {
    expect(
      editingProbes.filter((probe) => probe.id === row.id),
      `${row.id} has exactly one probe`,
    ).toHaveLength(1)
    expect(
      ALL_PROBES.some((probe) => probe.id === row.id),
      `${row.id} is in the suite`,
    ).toBe(true)
  }
  // Thirteen converted rows plus the four hand-written ones (deccara, decrara, decsace, decrqcra).
  expect(editingProbes).toHaveLength(17)
})

/**
 * The derivation, measured: the probe the kind builds from a row reads THAT row's seed cells and THAT
 * row's target cells against a surface implementing the claim. A hand-written probe beside the table
 * cannot satisfy this without also carrying the row's own numbers.
 */
test("every kind row decides from its own cells, through the shared kind", async () => {
  for (const row of editingReadbackRows) {
    const probe = editingProbes.find((entry) => entry.id === row.id)
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
    const probe = editingProbes.find((entry) => entry.id === row.id)
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
for (const row of editingReadbackRows) {
  test(`${row.id} binds its claim to its own cells and calibrated controls`, () => {
    const probe = editingProbes.find((entry) => entry.id === row.id)
    if (!probe?.termless) throw new Error(`Missing headless ${row.id}`)
    const cols = 24
    const step = firstStep(row.id)
    const right = (row.region?.left ?? 1) + (row.before[0]?.length ?? 0) - 1

    const supported = probe.termless(declaredScreen({ [row.seed]: row.before, [step]: row.after }, cols))
    expect(supported.observation, row.id).toMatchObject({ outcome: "supported", evidence: "parser-state" })
    expect(supported.assertions?.[0], row.id).toMatchObject({ kind: "positive" })

    const ignored = probe.termless(declaredScreen({ [row.seed]: row.before }, cols))
    expect(ignored.observation, row.id).toMatchObject({ outcome: "unsupported", evidence: "parser-state" })
    expect(ignored.assertions?.[0], row.id).toMatchObject({ kind: "negative" })

    const badSeed = row.before.map((cells) => cells.map(() => "?"))
    expect(probe.termless(declaredScreen({ [row.seed]: badSeed }, cols)).observation, row.id).toMatchObject({
      outcome: "inconclusive",
      reason: "insufficient-evidence",
    })

    const control = row.controls[0]
    if (control !== undefined) {
      const moved = row.after.map((cells) => [...cells])
      moved[control.row]![control.col] = "?"
      expect(
        probe.termless(declaredScreen({ [row.seed]: row.before, [step]: moved }, cols)).observation,
        `${row.id} moved control ${control.row},${control.col}`,
      ).toMatchObject({ outcome: "inconclusive", reason: "insufficient-evidence" })
    }

    // A grid narrower than the row's own right edge refuses before a single byte is fed.
    const narrow = declaredScreen({ [row.seed]: row.before, [step]: row.after }, right - 1)
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
 * Controls are what stops a fixture failure being read as a capability verdict, so each must be a REAL
 * control: a column the row's own sequence never writes. This is the shape that let a first revision of
 * the kind ship a step that rewrote its own control with every test passing, because nothing measured
 * the control's survival. Here each control cell is covered with a marker AFTER the seed, the row's own
 * steps run on the reference parser, and the markers must still stand.
 */
test("every row's controls survive the row's own steps on the reference parser", () => {
  for (const row of editingReadbackRows) {
    // SL and SR shift every compared column, so neither declares a control.
    if (row.controls.length === 0) continue
    const ctx = headlessContext(createSemanticSurface())
    ctx.feed(row.seed)
    for (const control of row.controls) ctx.feed(`\x1b[${control.row + 1};${control.col + 1}H\u00b5`)
    for (const step of row.steps) ctx.feed(step.write)
    expect(
      row.controls.map((control) => ctx.getCell(control.row, control.col).char),
      `${row.id} rewrites its own control`,
    ).toEqual(row.controls.map(() => "\u00b5"))
  }
})

/**
 * NO SILENT ERRORS, at load: a row whose own shape disagrees with itself must never reach a compare
 * where a missing column is read against a blank and accepted. Each mismatch names the row.
 */
test("a row whose shape disagrees with itself refuses at load", () => {
  const row = editingReadbackRows[0]
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
 * row to justify in a line.
 */
test("an explicit minimum geometry below what a row uses refuses at load", () => {
  const row = editingReadbackRows.find((entry) => entry.id === "editing.insert-chars")
  expect(row, "the kind table names editing.insert-chars").toBeDefined()
  if (!row) return
  // insert-chars compares one nine-column row with its cursor on row 2 and its witness on row 3, so
  // its need is 3 rows by 9 + the family's two-column margin = 11 columns.
  expect(() => regionReadbackProbe({ ...row, minRows: 2 })).toThrow(/explicit minRows 2 is below the 3 rows/)
  expect(() => regionReadbackProbe({ ...row, minCols: 10 })).toThrow(/explicit minCols 10 is below the 11 columns/)
  expect(() => regionReadbackProbe({ ...row, minRows: 3, minCols: 11 })).not.toThrow()
  expect(() => regionReadbackProbe({ ...row, minRows: 8, minCols: 20 })).not.toThrow()
  // The need is the LARGER of the cursor row and the sentinel row, so a row whose cursor outruns its
  // sentinel needs the cursor's row.
  expect(() => regionReadbackProbe({ ...row, cursorRow: 6, sentinel: { row: 5, col: 1 } })).not.toThrow()
  expect(() => regionReadbackProbe({ ...row, cursorRow: 6, sentinel: { row: 5, col: 1 }, minRows: 5 })).toThrow(
    /explicit minRows 5 is below the 6 rows this row uses \(cursor row 6, sentinel row 5\)/,
  )
})

test("decrqcra checks the seeded rectangle's 16-bit character sum", () => {
  const probe = ALL_PROBES.find((entry) => entry.id === "editing.decrqcra")
  if (!probe?.termless) throw new Error("decrqcra termless callback missing")
  expect(probe.termObservationEvidence).toBe("query")
  expect(probe.termlessObservationEvidence).toBe("query")
  const right = headless({ feedCapture: () => "\x1bP1!~014F\x1b\\" })
  expect(probe.termless(right)).toMatchObject({ pass: true, observation: { outcome: "supported", evidence: "query" } })
  const wrong = headless({ feedCapture: () => "\x1bP1!~014E\x1b\\" })
  expect(probe.termless(wrong)).toMatchObject({ pass: false, observation: { outcome: "unsupported", evidence: "query" } })
  const none = headless({ feedCapture: () => "" })
  expect(probe.termless(none)).toMatchObject({ pass: false, observation: { outcome: "inconclusive" } })
})
