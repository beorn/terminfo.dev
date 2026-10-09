/**
 * @failure A group capability is graded without a bound contract row, or a re-grade of a decided
 *   observation moves it - so a group step reinvents its own fixture and silently drifts.
 * @level l2
 * @consumer 28018 candidate-2 SGR group (child 28019); the first adopter of the 28453 harness.
 * @reach fs-walk vendor/terminfo.dev/packages/probe-defs/src/sgr-contract.test.ts vendor/terminfo.dev/packages/probe-defs/src/helper-observations.test.ts vendor/terminfo.dev/packages/probe-defs/src/readback.test.ts
 * @testonly none
 */
import { expect, test } from "vitest"
import { join } from "node:path"
import { sgrProbes } from "./sgr.ts"
import {
  contractGaps,
  headlessContext,
  missingContractTests,
  regradeCommand,
  regradeRow,
  satisfiesContract,
  type GroupContract,
  type GroupContractSpec,
  type HeadlessModel,
} from "./testing/group-harness.ts"

/** The 32 SGR capabilities of 28018's SGR row; ids drawn from sgr.ts, claims are the contract. */
const SGR_CONTRACT: GroupContract = [
  { id: "sgr.bold", expected: "decided", claim: "SGR 1 selects the bold attribute" },
  { id: "sgr.faint", expected: "decided", claim: "SGR 2 selects the faint attribute" },
  { id: "sgr.italic", expected: "decided", claim: "SGR 3 selects the italic attribute" },
  { id: "sgr.underline.single", expected: "decided", claim: "SGR 4 selects a single underline" },
  { id: "sgr.blink", expected: "decided", claim: "SGR 5 selects the blink attribute" },
  { id: "sgr.inverse", expected: "decided", claim: "SGR 7 selects inverse video" },
  { id: "sgr.hidden", expected: "decided", claim: "SGR 8 selects the hidden attribute" },
  { id: "sgr.strikethrough", expected: "decided", claim: "SGR 9 selects strikethrough" },
  { id: "sgr.overline", expected: "decided", claim: "SGR 53 selects overline" },
  { id: "sgr.reset", expected: "decided", claim: "SGR 0 clears every attribute" },
  { id: "sgr.fg.standard", expected: "decided", claim: "SGR 30-37 selects a standard foreground" },
  { id: "sgr.fg.bright", expected: "decided", claim: "SGR 90-97 selects a bright foreground" },
  { id: "sgr.fg.256", expected: "decided", claim: "SGR 38;5 selects a 256-colour foreground" },
  { id: "sgr.fg.truecolor", expected: "decided", claim: "SGR 38;2 selects a truecolor foreground" },
  { id: "sgr.fg.default", expected: "decided", claim: "SGR 39 restores the default foreground" },
  { id: "sgr.bg.standard", expected: "decided", claim: "SGR 40-47 selects a standard background" },
  { id: "sgr.bg.bright", expected: "decided", claim: "SGR 100-107 selects a bright background" },
  { id: "sgr.bg.256", expected: "decided", claim: "SGR 48;5 selects a 256-colour background" },
  { id: "sgr.bg.truecolor", expected: "decided", claim: "SGR 48;2 selects a truecolor background" },
  { id: "sgr.bg.default", expected: "decided", claim: "SGR 49 restores the default background" },
  { id: "sgr.underline.double", expected: "decided", claim: "SGR 21 selects a double underline" },
  { id: "sgr.underline.curly", expected: "decided", claim: "SGR 4:3 selects a curly underline" },
  { id: "sgr.underline.dotted", expected: "decided", claim: "SGR 4:4 selects a dotted underline" },
  { id: "sgr.underline.dashed", expected: "decided", claim: "SGR 4:5 selects a dashed underline" },
  { id: "sgr.underline.color", expected: "decided", claim: "SGR 58 selects an underline colour" },
  { id: "sgr.underline-color-indexed", expected: "decided", claim: "SGR 58;5 selects an indexed underline colour" },
  { id: "sgr.underline-color-rgb", expected: "decided", claim: "SGR 58;2 selects an RGB underline colour" },
  { id: "sgr.underline-color-reset", expected: "decided", claim: "SGR 59 resets the underline colour" },
  { id: "sgr.selective-reset.bold", expected: "decided", claim: "SGR 22 clears bold and faint only" },
  { id: "sgr.selective-reset.italic", expected: "decided", claim: "SGR 23 clears italic only" },
  { id: "sgr.selective-reset.underline", expected: "decided", claim: "SGR 24 clears underline only" },
  { id: "sgr.selective-reset.inverse", expected: "decided", claim: "SGR 27 clears inverse only" },
]

/** The named set 28454 reviews: SGR's rows plus the focused test files that bind them (no glob). */
const SGR_CONTRACT_SPEC: GroupContractSpec = {
  group: "sgr",
  rows: SGR_CONTRACT,
  tests: [
    "packages/probe-defs/src/sgr-contract.test.ts",
    "packages/probe-defs/src/helper-observations.test.ts",
    "packages/probe-defs/src/readback.test.ts",
  ],
}

type InertCell = ReturnType<HeadlessModel["getCell"]>

/** A neutral cell: no attribute, no colour. `underlineColor` is explicit so a reset comparison is measured. */
const INERT_CELL: InertCell = {
  char: " ",
  bold: false,
  dim: false,
  italic: false,
  underline: null,
  underlineColor: null,
  strikethrough: false,
  inverse: false,
  hidden: false,
  blink: false,
  fg: null,
  bg: null,
  wide: false,
}

function inertModel(cols = 40, cell: Partial<InertCell> = {}): HeadlessModel {
  return {
    cols,
    feed: () => {},
    getCell: () => ({ ...INERT_CELL, ...cell }),
    getCursor: () => ({ x: 0, y: 0, visible: true, style: null }),
  }
}

type TableCell = Partial<InertCell> & { char: string }

/** A fixture X cell carrying only the attribute/colour the row's claim requires. */
const X = (cell: Partial<InertCell> = {}): TableCell => ({ char: "X", ...cell })

/**
 * One required headless cell state per SGR row: the state the row's claim says the sequence produces.
 * This is the satisfaction binding (the contract predicate and probe agree), not a claim that a real
 * terminal emits it - that is the term/capture path. Column n is the n-th cell the probe reads.
 * 2026-10-09 @adhoc/1 bounce + @dev/10 review: the old bold-only test plus a blanket "whole 32 rows"
 * reference to helper-observations.test.ts was false (that file pins several rows, not all).
 */
const SGR_SATISFACTION_CELLS: Record<string, readonly TableCell[]> = {
  // attributes
  "sgr.bold": [X({ bold: true })],
  "sgr.faint": [X({ dim: true })],
  "sgr.italic": [X({ italic: true })],
  "sgr.underline.single": [X({ underline: "single" })],
  "sgr.underline.double": [X({ underline: "double" })],
  "sgr.underline.curly": [X({ underline: "curly" })],
  "sgr.underline.dotted": [X({ underline: "dotted" })],
  "sgr.underline.dashed": [X({ underline: "dashed" })],
  "sgr.blink": [X({ blink: true })],
  "sgr.inverse": [X({ inverse: true })],
  "sgr.hidden": [X({ hidden: true })],
  "sgr.strikethrough": [X({ strikethrough: true })],
  // overline reads an OPTIONAL cell field: binding it needs the field PRESENT (omitted = notTested, below)
  "sgr.overline": [X({ overline: true })],
  // full + selective resets; measuredReset reads the C (baseline), X (styled), Y (reset) cells
  "sgr.reset": [{ char: "C" }, X({ bold: true, italic: true, underline: "single" }), { char: "Y" }],
  "sgr.selective-reset.bold": [{ char: "C" }, X({ bold: true, dim: true, italic: true }), { char: "Y", italic: true }],
  "sgr.selective-reset.italic": [{ char: "C" }, X({ bold: true, italic: true }), { char: "Y", bold: true }],
  "sgr.selective-reset.underline": [{ char: "C" }, X({ bold: true, underline: "single" }), { char: "Y", bold: true }],
  "sgr.selective-reset.inverse": [{ char: "C" }, X({ bold: true, inverse: true }), { char: "Y", bold: true }],
  // named + default colours
  "sgr.fg.standard": [{ char: "C" }, X({ fg: { r: 170, g: 0, b: 0 } }), { char: "Y", fg: { r: 0, g: 0, b: 170 } }],
  "sgr.fg.bright": [{ char: "C" }, X({ fg: { r: 170, g: 0, b: 0 } }), { char: "Y", fg: { r: 0, g: 0, b: 170 } }],
  "sgr.bg.standard": [{ char: "C" }, X({ bg: { r: 170, g: 0, b: 0 } }), { char: "Y", bg: { r: 0, g: 0, b: 170 } }],
  "sgr.bg.bright": [{ char: "C" }, X({ bg: { r: 170, g: 0, b: 0 } }), { char: "Y", bg: { r: 0, g: 0, b: 170 } }],
  "sgr.fg.default": [{ char: "C" }, X({ fg: { r: 170, g: 0, b: 0 } }), { char: "R" }],
  "sgr.bg.default": [{ char: "C" }, X({ bg: { r: 0, g: 170, b: 0 } }), { char: "R" }],
  // indexed + truecolor: C/A/B controls, X/Y targets
  "sgr.fg.256": [
    { char: "C" },
    { char: "A", fg: { r: 95, g: 135, b: 175 } },
    { char: "B", fg: { r: 215, g: 135, b: 95 } },
    X({ fg: { r: 95, g: 135, b: 175 } }),
    { char: "Y", fg: { r: 215, g: 135, b: 95 } },
  ],
  "sgr.bg.256": [
    { char: "C" },
    { char: "A", bg: { r: 95, g: 135, b: 175 } },
    { char: "B", bg: { r: 215, g: 135, b: 95 } },
    X({ bg: { r: 95, g: 135, b: 175 } }),
    { char: "Y", bg: { r: 215, g: 135, b: 95 } },
  ],
  "sgr.fg.truecolor": [
    { char: "C" },
    { char: "A", fg: { r: 0, g: 0, b: 255 } },
    { char: "B", fg: { r: 0, g: 255, b: 0 } },
    X({ fg: { r: 255, g: 128, b: 0 } }),
    { char: "Y", fg: { r: 17, g: 97, b: 201 } },
  ],
  "sgr.bg.truecolor": [
    { char: "C" },
    { char: "A", bg: { r: 0, g: 0, b: 255 } },
    { char: "B", bg: { r: 0, g: 255, b: 0 } },
    X({ bg: { r: 0, g: 255, b: 128 } }),
    { char: "Y", bg: { r: 17, g: 97, b: 201 } },
  ],
  // underline colours: A/B controls, X/Y targets
  "sgr.underline.color": [
    { char: "A", underline: "single", fg: { r: 0, g: 0, b: 255 } },
    { char: "B", underline: "single", fg: { r: 0, g: 255, b: 0 } },
    X({ underline: "single", underlineColor: { r: 255, g: 0, b: 128 } }),
  ],
  "sgr.underline-color-rgb": [
    { char: "A", underline: "single", fg: { r: 0, g: 0, b: 255 } },
    { char: "B", underline: "single", fg: { r: 0, g: 255, b: 0 } },
    X({ underline: "single", underlineColor: { r: 255, g: 0, b: 128 } }),
  ],
  "sgr.underline-color-indexed": [
    { char: "A", underline: "single", fg: { r: 0, g: 0, b: 255 } },
    X({ underline: "single", underlineColor: { r: 0, g: 255, b: 0 } }),
    { char: "B", underline: "single", fg: { r: 0, g: 255, b: 0 } },
    { char: "Y", underline: "single", underlineColor: { r: 0, g: 0, b: 255 } },
  ],
  "sgr.underline-color-reset": [
    { char: "C", underline: "single" },
    X({ underline: "single", underlineColor: { r: 255, g: 0, b: 128 } }),
    { char: "Y", underline: "single" },
  ],
}

/** A headless model whose column cells are fixed: the probe reads the cells its fed fixture names. */
function cellsModel(cells: readonly TableCell[]): HeadlessModel {
  return {
    cols: Math.max(40, cells.length),
    feed: () => {},
    getCell: (_row, col) => ({ ...INERT_CELL, ...cells[col] }),
    getCursor: () => ({ x: 0, y: 0, visible: true, style: null }),
  }
}

test("the SGR contract covers every SGR capability and names none unknown", () => {
  const gaps = contractGaps(sgrProbes, SGR_CONTRACT)
  expect(gaps.uncovered).toEqual([])
  expect(gaps.unknown).toEqual([])
  expect(sgrProbes).toHaveLength(32)
  expect(SGR_CONTRACT).toHaveLength(32)
})

test("the SGR contract names its focused tests, and every named file exists", () => {
  const root = join(import.meta.dirname, "../../..")
  expect(missingContractTests(SGR_CONTRACT_SPEC, root)).toEqual([])
  // The re-grade command names the runners and the files, and never a glob (2026-10-09 @dev/3 correction).
  const command = regradeCommand(SGR_CONTRACT_SPEC)
  expect(command).toContain("bunx --bun vitest run")
  expect(command).not.toContain("bun test")
  expect(command).not.toMatch(/[*?]/u)
  for (const path of SGR_CONTRACT_SPEC.tests) expect(command).toContain(path)
})

// Determinism only (2026-10-09 @dev/10 review): the inert model feeds nothing, so this replay can
// prove the harness is deterministic, NOT that a decided row is satisfied. The satisfaction binding is
// proven by SGR_SATISFACTION_CELLS below (one required cell state per row, driven through regradeRow);
// helper-observations.test.ts additionally pins several rows against real parse paths.
test("the harness replays every SGR capability deterministically (satisfaction is bound by the table test below)", async () => {
  for (const row of SGR_CONTRACT) {
    const probe = sgrProbes.find((entry) => entry.id === row.id)
    expect(probe, `missing SGR probe ${row.id}`).toBeDefined()
    if (!probe) continue
    expect(probe.termless !== null || probe.term !== null, `${row.id} has no callback`).toBe(true)
    const first = await regradeRow(probe, row, { headless: headlessContext(inertModel()) })
    const second = await regradeRow(probe, row, { headless: headlessContext(inertModel()) })
    expect(second.after, `${row.id} is not deterministic`).toBe(first.after)
    expect(second.satisfies, `${row.id} satisfaction is not deterministic`).toBe(first.satisfies)
    // The harness APPLIES the contract predicate; a re-grade is never a rubber stamp.
    expect(first.satisfies, `${row.id} must route through satisfiesContract`).toBe(satisfiesContract(row, first.after))
  }
})

// The bound satisfaction proof: every decided row reads "supported" from the cell state its claim
// requires. This is the table proof the determinism replay above cannot show on its own
// (2026-10-09 @adhoc/1 bounce + @dev/10 review).
test("every SGR contract row is satisfied by the headless cell state its claim requires", async () => {
  for (const row of SGR_CONTRACT) {
    const probe = sgrProbes.find((entry) => entry.id === row.id)
    expect(probe, `missing SGR probe ${row.id}`).toBeDefined()
    if (!probe) continue
    const cells = SGR_SATISFACTION_CELLS[row.id]
    expect(cells, `no satisfaction cell state declared for ${row.id}`).toBeDefined()
    if (!cells) continue
    const graded = await regradeRow(probe, row, { headless: headlessContext(cellsModel(cells)) })
    expect(graded.after, `${row.id} reads supported from its claim's cell state`).toBe("supported")
    expect(graded.satisfies, `${row.id} satisfies its contract row`).toBe(true)
  }
  // The table names EVERY decided row, so a newly added SGR row cannot ride the contract unbound.
  const decided = SGR_CONTRACT.filter((row) => row.expected === "decided").map((row) => row.id)
  expect(Object.keys(SGR_SATISFACTION_CELLS).sort()).toEqual(decided.sort())
})

test("a row reading an OPTIONAL cell field is notTested when the field is omitted, bound when present", async () => {
  // sgr.overline is the one row whose claim reads an optional field. Present -> the same synthetic
  // predicate seam the other 31 rows use; omitted -> notTested("no-semantic-observable"), never a
  // false negative (@dev/10 2026-10-09: types.ts permits overline?:boolean, so the earlier "cannot be
  // exposed headlessly" wording was wrong - the field is simply optional).
  const row = SGR_CONTRACT.find((entry) => entry.id === "sgr.overline")
  const probe = sgrProbes.find((entry) => entry.id === "sgr.overline")
  expect(row, "the SGR contract names sgr.overline").toBeDefined()
  expect(probe, "the SGR contract names a real sgr.overline probe").toBeDefined()
  if (!row || !probe) return
  const present = await regradeRow(probe, row, { headless: headlessContext(cellsModel([X({ overline: true })])) })
  expect(present.after).toBe("supported")
  expect(present.satisfies).toBe(true)
  const omittedContext = headlessContext(cellsModel([{ char: "X" }]))
  const omitted = await regradeRow(probe, row, { headless: omittedContext })
  expect(omitted.after).toBeUndefined()
  expect(omitted.satisfies).toBe(false)
  expect(probe.termless?.(omittedContext).notTested).toEqual({
    reason: "no-semantic-observable",
    noObservable: "cell.overline field not exposed",
  })
})

// One negative assertion, on bold: the table above is the positive proof for all 32 rows; this only
// pins that an inert cell is not satisfied. It is deliberately NOT a per-row negative suite, because
// the other rows carry no speculative negative (@dev/10 2026-10-09).
test("a decided SGR row reads unsatisfied from an inert cell", async () => {
  const row = SGR_CONTRACT.find((entry) => entry.id === "sgr.bold")
  const probe = sgrProbes.find((entry) => entry.id === "sgr.bold")
  expect(row, "the SGR contract names sgr.bold").toBeDefined()
  expect(probe, "the SGR contract names a real sgr.bold probe").toBeDefined()
  if (!row || !probe) return
  const inert = await regradeRow(probe, row, { headless: headlessContext(inertModel()) })
  expect(inert.satisfies).toBe(false)
})
