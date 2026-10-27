/**
 * @failure A Character Sets probe stops being derived from its kind row - a hand-written callback returns, or a row's measured cells are edited without the probe moving - so the family's declared table and the frozen suite disagree.
 * @level l2
 * @consumer 28450 slice B: the region-readback kind table (@cto A2), one converted family at a time.
 * @testonly none
 */
import { expect, test } from "vitest"
import { charsetReadbackRows, charsetsProbes } from "./charsets.ts"
import { ALL_PROBES } from "./index.ts"
import { regionReadbackProbe } from "./region-readback-kind.ts"
import { libProbeSource, regradeRow, type ContractRow } from "./testing/group-harness.ts"
import { createSemanticSurface } from "./testing/semantic-surface.ts"

/**
 * The kind table's own rows, one per Character Sets probe, listed BY NAME so a row that loses its
 * definition - or a probe that stops being built from its row - fails here rather than as a silently
 * smaller count in a census taken later.
 */
const KIND_TABLE_ROWS: readonly ContractRow[] = [
  {
    id: "charsets.dec-special",
    expected: "decided",
    claim: "DEC Special Graphics q paints U+2500 between its preserved ASCII q controls",
  },
  {
    id: "charsets.utf8",
    expected: "decided",
    claim: "U+00E9 and U+4E16 land in their target cells with the ASCII A/Z controls intact",
  },
  {
    id: "charsets.g0-g1-switching",
    expected: "decided",
    claim: "SI/SO select G0/G1 so a G1-designated DEC l paints U+250C between ASCII l controls",
  },
  {
    id: "charsets.dec-line-drawing",
    expected: "decided",
    claim: "DEC jklmqx paint the six box glyphs while the trailing ASCII j is unchanged",
  },
]

test("the kind table names every charsets row, and every row reaches the frozen suite", () => {
  const named = KIND_TABLE_ROWS.map((row) => row.id)
  expect(charsetReadbackRows.map((row) => row.id)).toEqual(named)
  expect(charsetsProbes.map((probe) => probe.id)).toEqual(named)
  for (const id of named) {
    expect(
      ALL_PROBES.some((probe) => probe.id === id),
      `${id} is in the suite`,
    ).toBe(true)
  }
})

/**
 * The derivation, measured: the probe the kind builds from a row reads THAT row's seed cells and THAT
 * row's target cells against a surface implementing the claim. A hand-written probe beside the table
 * cannot satisfy this without also carrying the row's own numbers.
 */
test("every kind row decides from its own cells, through the shared kind", async () => {
  for (const row of KIND_TABLE_ROWS) {
    const probe = charsetsProbes.find((entry) => entry.id === row.id)
    const kindRow = charsetReadbackRows.find((entry) => entry.id === row.id)
    expect(probe, `${row.id} has a kind-built probe`).toBeDefined()
    expect(kindRow, `${row.id} has a kind-table row`).toBeDefined()
    if (!probe || !kindRow) continue
    expect(probe.termNeedsGeometry, row.id).toBe(true)
    expect(probe.libAssertionType, row.id).toBe("buffer_state")
    const measured = probe.lib!(libProbeSource(createSemanticSurface()))
    const state = JSON.parse(measured.response ?? "null") as { before: string[][]; after: string[][] }
    // One entry per compared COLUMN, so a wide follower is a cell the array names, not a join that
    // silently drops it; one row per compared ROW, so a multi-row grid can no longer be read as a
    // single line of cells.
    expect(state.before, `${row.id} reads the row's seed cells`).toEqual(kindRow.before.map((cells) => [...cells]))
    expect(state.after, `${row.id} reads the row's target cells`).toEqual(kindRow.after.map((cells) => [...cells]))
    const graded = await regradeRow(probe, row, { headless: libProbeSource(createSemanticSurface()) })
    expect(graded.after, row.id).toBe("supported")
    expect(graded.satisfies, row.id).toBe(true)
  }
})

test("the kind table replays every row deterministically", async () => {
  for (const row of KIND_TABLE_ROWS) {
    const probe = charsetsProbes.find((entry) => entry.id === row.id)
    if (!probe) continue
    const first = await regradeRow(probe, row, { headless: libProbeSource(createSemanticSurface()) })
    const second = await regradeRow(probe, row, { headless: libProbeSource(createSemanticSurface()) })
    expect(second.after, `${row.id} is not deterministic`).toBe(first.after)
    expect(second.satisfies, `${row.id} satisfaction is not deterministic`).toBe(first.satisfies)
  }
})

/**
 * The negative control that makes the table above a measurement rather than a stamp: the same kind
 * row, on a surface whose G0/G1 designation is inert, must read "unsupported" - a table that cannot
 * fail cannot decide anything.
 */
test("an inert designation reads charsets.dec-special unsupported", async () => {
  const row = KIND_TABLE_ROWS.find((entry) => entry.id === "charsets.dec-special")
  const probe = charsetsProbes.find((entry) => entry.id === "charsets.dec-special")
  expect(row, "the kind table names charsets.dec-special").toBeDefined()
  expect(probe, "the kind table names a real charsets.dec-special probe").toBeDefined()
  if (!row || !probe) return
  const graded = await regradeRow(probe, row, {
    headless: libProbeSource(createSemanticSurface({ mutations: ["charset-noop"] })),
  })
  expect(graded.after, "charsets.dec-special detects an inert designation").toBe("unsupported")
})

/**
 * Round 2 (@cto 2026-10-12): a control is a real control only when the sequence does not write it.
 * Round 1 shipped a step that rewrote its own control with the same character and every test passed,
 * because nothing measured the control's survival. Here each control column is covered with a marker
 * AFTER the seed, the row's own steps run on the reference parser, and the markers must still stand.
 */
test("every row's controls survive the row's own steps on the reference parser", () => {
  for (const row of charsetReadbackRows) {
    expect(row.controls.length, `${row.id} names at least one control`).toBeGreaterThan(0)
    const ctx = libProbeSource(createSemanticSurface())
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
 * sameCell is new behaviour: one backend reports a wide glyph's follower as reserved-empty, another
 * as a space. Neither is a failing terminal, so the row has to read supported under both spellings.
 */
test("a backend that reports the wide follower as a space still reads charsets.utf8 supported", () => {
  const probe = charsetsProbes.find((entry) => entry.id === "charsets.utf8")
  expect(probe, "charsets.utf8 has a kind-built probe").toBeDefined()
  if (!probe) return
  const ctx = libProbeSource(createSemanticSurface())
  const spaced = {
    ...ctx,
    getCell: (row: number, col: number) => {
      const cell = ctx.getCell(row, col)
      return cell.char === "" ? { ...cell, char: " " } : cell
    },
  }
  const result = probe.lib!(spaced)
  expect(result.observation?.outcome).toBe("supported")
  expect(result.pass).toBe(true)
})

/**
 * NO SILENT ERRORS, at load: a row whose own shape disagrees with itself must never reach a compare
 * where a missing column is read against a blank and accepted. Each mismatch names the row.
 */
test("a row whose shape disagrees with itself refuses at load", () => {
  const row = charsetReadbackRows[0]
  expect(row, "the kind table has a first row").toBeDefined()
  if (!row) return
  expect(() => regionReadbackProbe({ ...row, before: [] })).toThrow(/at least one compared row/)
  expect(() => regionReadbackProbe({ ...row, before: [[]] })).toThrow(/at least one compared column/)
  expect(() => regionReadbackProbe({ ...row, before: [["q", "q"], ["q"]] })).toThrow(/compared row 1 names 1 cells/)
  expect(() => regionReadbackProbe({ ...row, after: [] })).toThrow(/after names 0 rows/)
  expect(() => regionReadbackProbe({ ...row, after: [["q"]] })).toThrow(/after row 0 names 1 cells/)
  expect(() => regionReadbackProbe({ ...row, ignored: [["q"]] })).toThrow(/ignored row 0 names 1 cells/)
  expect(() => regionReadbackProbe({ ...row, controls: [{ row: 0, col: 9, char: "q" }] })).toThrow(/outside/)
  expect(() => regionReadbackProbe({ ...row, controls: [{ row: 3, col: 0, char: "q" }] })).toThrow(
    /control row 3 is outside/,
  )
})

/**
 * NO SILENT ERRORS, at load (@cto 2026-10-12, must-fix 2): the minimum geometry DERIVES from the row
 * (the larger of cursor row and sentinel row; the region's right edge with the sentinel column folded
 * in and the family margin added). An explicit minimum below that need can only make an arm run on a
 * grid smaller than the fixture addresses, so it refuses at LOAD and names both numbers; a larger one
 * is for the row to justify in a line.
 */
test("an explicit minimum geometry below what a row uses refuses at load", () => {
  const row = charsetReadbackRows[0]
  expect(row, "the kind table has a first row").toBeDefined()
  if (!row) return
  // charsets.dec-special addresses one 3-column row, so its need is 3 rows (sentinel row 3) by 5
  // columns (region right 3 plus the family's two-column margin).
  expect(() => regionReadbackProbe({ ...row, minRows: 2 })).toThrow(/explicit minRows 2 is below the 3 rows/)
  expect(() => regionReadbackProbe({ ...row, minCols: 4 })).toThrow(/explicit minCols 4 is below the 5 columns/)
  // The need is the LARGER of the cursor row and the sentinel row, so a row whose cursor outruns its
  // sentinel needs the cursor's row — the shape that used a hand-picked minimum to park its own cursor
  // off-screen (reverse-index: cursor row 6, sentinel row 5, so a sentinel-only rule derived 5).
  expect(() => regionReadbackProbe({ ...row, cursorRow: 6, sentinel: { row: 5, col: 1 } })).not.toThrow()
  expect(() => regionReadbackProbe({ ...row, cursorRow: 6, sentinel: { row: 5, col: 1 }, minRows: 5 })).toThrow(
    /explicit minRows 5 is below the 6 rows this row uses \(cursor row 6, sentinel row 5\)/,
  )
  // At the derived need the row loads; a larger explicit value is kept for the row to justify.
  expect(() => regionReadbackProbe({ ...row, minRows: 3, minCols: 5 })).not.toThrow()
  expect(() => regionReadbackProbe({ ...row, minRows: 8, minCols: 9 })).not.toThrow()
})
