/**
 * @failure A sparse or uncalibrated cell readback reports a line edit as support even when a kind row's seed, its target cells or an unchanged control is wrong - so the Editing family's declared table and the frozen suite disagree.
 * @level l0
 * @consumer Headless editing observations in the selected terminal results.
 * @testonly none
 */
import { expect, test } from "vitest"
import { editingProbes, editingReadbackRows } from "./editing.ts"
import { ALL_PROBES } from "./index.ts"
import { regionReadbackProbe, type RegionReadbackCell } from "./region-readback-kind.ts"
import { headlessContext, regradeRow } from "./testing/group-harness.ts"
import { createSemanticSurface } from "./testing/semantic-surface.ts"
import type { LibProbeSource } from "./types.ts"

/**
 * The kind table's own rows, one per CONVERTED Editing probe, listed BY NAME so a row that loses its
 * definition - or a probe that stops being built from its row - fails here rather than as a silently
 * smaller count in a census taken later.
 *
 * `editing.decsace` and `editing.decrqcra` are deliberately absent: one measures whole-window extent
 * frames and the other a DCS checksum reply, neither a cell window. `editing-contract.test.ts` binds
 * both hand-written rows beside these fifteen.
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

/** A minimal LibProbeSource the declared screens below override. */
function headless(overrides: Partial<LibProbeSource> = {}): LibProbeSource {
  return {
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
function declaredCell(cell: RegionReadbackCell | undefined): ReturnType<LibProbeSource["getCell"]> {
  if (cell === undefined || typeof cell === "string") {
    // A plain cell is a cell the row claims NO attributes for, not one whose backend reports no
    // field: a real `getCell` always says what the background is (null = none).
    return { char: cell ?? " ", bold: false, inverse: false, fg: null, bg: null } as ReturnType<
      LibProbeSource["getCell"]
    >
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
): LibProbeSource {
  let cells: readonly (readonly RegionReadbackCell[])[] = []
  return headless({
    cols,
    feed: (sequence) => {
      const next = screens[sequence]
      if (next !== undefined) cells = next
    },
    getCell: (row, col) => declaredCell(cells[row]?.[col]),
  })
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
  // Fifteen converted rows plus the two hand-written ones (decsace, decrqcra).
  expect(editingProbes).toHaveLength(17)
})

/**
 * DECCARA/DECRARA claim a 3x5 rectangle whose RIGHT FLANK must
 * stay plain. A stream-extent implementation inverts the flank as well. With the flank declared as a
 * plain string the character still matches, so this used to read supported; the flank is a cell of the
 * claim and its attribute must be compared.
 */
test("a stream-extent DECCARA that inverts the right flank reads unsupported", () => {
  const row = editingReadbackRows.find((entry) => entry.id === "editing.deccara")
  if (!row) throw new Error("missing editing.deccara")
  const probe = editingProbes.find((entry) => entry.id === row.id)
  if (!probe?.lib) throw new Error("missing headless editing.deccara")
  const step = row.steps[0]?.write
  if (step === undefined) throw new Error("missing editing.deccara step")
  const marked = new Set(["a", "b", "c"])
  const streamExtent = row.after.map((cells) =>
    cells.map((cell) => {
      const char = typeof cell === "string" ? cell : cell.char
      return marked.has(char) ? cell : { char, attributes: { inverse: true } }
    }),
  )
  const result = probe.lib(declaredScreen({ [row.seed]: row.before, [step]: streamExtent }, 24))
  expect(result.observation).toMatchObject({ outcome: "unsupported", assertionType: "buffer_state" })
  expect(result.assertions?.[0]).toMatchObject({ kind: "negative" })
})

/**
 * The other half of the same control: a seed whose OUT-OF-RECTANGLE flank is already inverse has not
 * established the fixture either, so the row refuses by name instead of deciding on a surface whose
 * flank was never plain.
 */
test("a DECCARA seed whose right flank is already inverse reads inconclusive", () => {
  const row = editingReadbackRows.find((entry) => entry.id === "editing.deccara")
  if (!row) throw new Error("missing editing.deccara")
  const probe = editingProbes.find((entry) => entry.id === row.id)
  if (!probe?.lib) throw new Error("missing headless editing.deccara")
  const flanksInversed = row.before.map((cells) =>
    cells.map((cell) => {
      const char = typeof cell === "string" ? cell : cell.char
      return char === "Z" || char === "Y" || char === "X" ? { char, attributes: { inverse: true } } : cell
    }),
  )
  const result = probe.lib(declaredScreen({ [row.seed]: flanksInversed }, 24))
  expect(result.observation).toMatchObject({ outcome: "inconclusive", reason: "insufficient-evidence" })
  expect(result.assertions).toBeUndefined()
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
    expect(probe.libAssertionType, row.id).toBe("buffer_state")
    const measured = probe.lib!(headlessContext(createSemanticSurface()))
    const state = JSON.parse(measured.response ?? "null") as { before: string[][]; after: string[][] }
    expect(toSpaces(state.before), `${row.id} reads the row's seed cells`).toEqual(toSpaces(row.before))
    expect(toSpaces(state.after), `${row.id} reads the row's target cells`).toEqual(toSpaces(row.after))
    expect(measured.observation, row.id).toMatchObject({ outcome: "supported", assertionType: "buffer_state" })
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
    if (!probe?.lib) throw new Error(`Missing headless ${row.id}`)
    const cols = 24
    const step = firstStep(row.id)
    const right = (row.region?.left ?? 1) + (row.before[0]?.length ?? 0) - 1

    const supported = probe.lib(declaredScreen({ [row.seed]: row.before, [step]: row.after }, cols))
    expect(supported.observation, row.id).toMatchObject({ outcome: "supported", assertionType: "buffer_state" })
    expect(supported.assertions?.[0], row.id).toMatchObject({ kind: "positive" })

    const ignored = probe.lib(declaredScreen({ [row.seed]: row.before }, cols))
    expect(ignored.observation, row.id).toMatchObject({ outcome: "unsupported", assertionType: "buffer_state" })
    expect(ignored.assertions?.[0], row.id).toMatchObject({ kind: "negative" })

    const badSeed = row.before.map((cells) => cells.map(() => "?"))
    expect(probe.lib(declaredScreen({ [row.seed]: badSeed }, cols)).observation, row.id).toMatchObject({
      outcome: "inconclusive",
      reason: "insufficient-evidence",
    })

    const control = row.controls[0]
    if (control !== undefined) {
      const moved = row.after.map((cells) => [...cells])
      moved[control.row]![control.col] = "?"
      expect(
        probe.lib(declaredScreen({ [row.seed]: row.before, [step]: moved }, cols)).observation,
        `${row.id} moved control ${control.row},${control.col}`,
      ).toMatchObject({ outcome: "inconclusive", reason: "insufficient-evidence" })
    }

    // A grid narrower than the row's own right edge refuses before a single byte is fed.
    const narrow = declaredScreen({ [row.seed]: row.before, [step]: row.after }, right - 1)
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
 * The parser arm sets the same DECSACE extent mode the app arm does — `2*x` is part of the row's
 * step and 2J does not reset it — so its finally must run the row's own cleanup before the SGR reset
 * on every exit: decided, refused, or thrown by the reader. A leftover extent mode is not cleared by
 * 2J and would change what the next probe's DECCARA and DECRARA reach.
 */
for (const id of ["editing.deccara", "editing.decrara"]) {
  test(`${id} clears its extent mode on the parser arm on every exit`, () => {
    const row = editingReadbackRows.find((entry) => entry.id === id)
    if (!row) throw new Error(`missing ${id}`)
    const probe = editingProbes.find((entry) => entry.id === id)
    if (!probe?.lib) throw new Error(`missing headless ${id}`)
    const lib = probe.lib
    const step = firstStep(id)

    const watch = (ctx: LibProbeSource) => {
      const fed: string[] = []
      const watched = {
        ...ctx,
        feed: (sequence: string) => {
          fed.push(sequence)
          ctx.feed(sequence)
        },
      }
      return { fed, run: () => lib(watched) }
    }

    const supported = watch(declaredScreen({ [row.seed]: row.before, [step]: row.after }, 24))
    expect(supported.run().observation, id).toMatchObject({ outcome: "supported", assertionType: "buffer_state" })
    expect(supported.fed.slice(-2), `${id} cleanup on success`).toEqual(["\x1b[0*x", "\x1b[0m"])

    const ignored = watch(declaredScreen({ [row.seed]: row.before }, 24))
    expect(ignored.run().observation, id).toMatchObject({ outcome: "unsupported", assertionType: "buffer_state" })
    expect(ignored.fed.slice(-2), `${id} cleanup on refusal`).toEqual(["\x1b[0*x", "\x1b[0m"])

    const throwing = watch({
      ...declaredScreen({ [row.seed]: row.before, [step]: row.after }, 24),
      getCell: () => {
        throw new Error("reader exploded")
      },
    })
    expect(() => throwing.run(), `${id} reader throw`).toThrow("reader exploded")
    expect(throwing.fed.slice(-2), `${id} cleanup on throw`).toEqual(["\x1b[0*x", "\x1b[0m"])
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
 * NO SILENT ERRORS, at load (must-fix 2): the minimum geometry DERIVES from the row.
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

test("decrqcra tests the one-cell character delta of the seeded rectangle", () => {
  const probe = ALL_PROBES.find((entry) => entry.id === "editing.decrqcra")
  if (!probe?.lib) throw new Error("decrqcra termless callback missing")
  expect(probe.termAssertionType).toBe("query_reply")
  expect(probe.libAssertionType).toBe("query_reply")
  const run = (values: readonly string[]) => {
    let index = 0
    return probe.lib!(headless({ feedCapture: () => values[index++] ?? "" }))
  }
  expect(run(["\x1bP1!~014F\x1b\\", "\x1bP1!~0150\x1b\\"])).toMatchObject({
    pass: true,
    observation: { outcome: "supported", assertionType: "query_reply" },
  })
  // DEC-compatible default: the negated sum moves E->F by 65535 (modular -1).
  expect(run(["\x1bP1!~014F\x1b\\", "\x1bP1!~014E\x1b\\"])).toMatchObject({
    pass: true,
    observation: { outcome: "supported", assertionType: "query_reply" },
  })
  expect(run(["\x1bP1!~014F\x1b\\", "\x1bP1!~014F\x1b\\"])).toMatchObject({
    pass: false,
    observation: { outcome: "unsupported", assertionType: "query_reply" },
  })
  const missing = run(["", ""])
  expect(missing.observation).toBeUndefined()
  expect(missing).toMatchObject({
    pass: false,
    response: JSON.stringify({ first: "", second: "" }),
    tests: [{ id: "criterion", status: "test-failure", reason: "no-response" }],
  })
})
