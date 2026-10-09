/**
 * @failure An Editing capability is graded without a bound contract row, or a re-grade of a decided
 *   observation moves it - so the Editing group reinvents its own fixture and silently drifts.
 * @level l2
 * @consumer 28018 candidate-2 Editing group (child 28022); the 28453 harness's fourth adopter.
 * @reach fs-walk vendor/terminfo.dev/packages/probe-defs/src/editing-contract.test.ts vendor/terminfo.dev/packages/probe-defs/src/editing-observations.test.ts vendor/terminfo.dev/packages/probe-defs/src/editing-batch2-captures.test.ts vendor/terminfo.dev/packages/probe-defs/src/editing-geometry.test.ts vendor/terminfo.dev/packages/probe-defs/src/testing/group-harness.ts vendor/terminfo.dev/packages/probe-defs/src/testing/semantic-surface.ts
 * @testonly none
 */
import { expect, test } from "vitest"
import { join } from "node:path"
import { editingProbes } from "./editing.ts"
import {
  contractGaps,
  headlessContext,
  missingContractTests,
  regradeCommand,
  regradeRow,
  satisfiesContract,
  type GroupContract,
  type GroupContractSpec,
} from "./testing/group-harness.ts"
import { createSemanticSurface } from "./testing/semantic-surface.ts"

/**
 * The 17 Editing capabilities of 28018's Editing row; ids drawn from editing.ts, claims are the
 * contract. `editing.decsace` is by design inconclusive - its own probe records that sequence
 * consumption cannot measure attribute-change extent - so its expected outcome is named, not decided.
 */
const EDITING_CONTRACT: GroupContract = [
  { id: "editing.insert-chars", expected: "decided", claim: "ICH inserts a blank at column 3, shifting text right" },
  { id: "editing.delete-chars", expected: "decided", claim: "DCH deletes column 3, shifting text left" },
  { id: "editing.insert-lines", expected: "decided", claim: "IL inserts a blank row 2, shifting rows down" },
  { id: "editing.delete-lines", expected: "decided", claim: "DL removes row 2, shifting rows up" },
  { id: "editing.repeat-char", expected: "decided", claim: "REP repeats the preceding X into three cells" },
  { id: "editing.decfra", expected: "decided", claim: "DECFRA fills the 3x5 measured area with X" },
  { id: "editing.decera", expected: "decided", claim: "DECERA blanks the measured 3x5 cells" },
  { id: "editing.decsera", expected: "decided", claim: "DECSERA clears ABCD but spares the protected P" },
  { id: "editing.deccra", expected: "decided", claim: "DECCRA copies the 2x5 source to row 5 column 10" },
  { id: "editing.deccara", expected: "decided", claim: "DECCARA sets inverse on the measured 3x5 cells" },
  { id: "editing.decrara", expected: "decided", claim: "DECRARA clears inverse on the measured 3x5 cells" },
  {
    id: "editing.decsace",
    expected: "inconclusive",
    claim: "DECSACE attribute-change extent is not observable from sequence consumption",
  },
  { id: "editing.decrqcra", expected: "decided", claim: "DECRQCRA frames a four-digit checksum reply for request 1" },
  { id: "editing.sl", expected: "decided", claim: "SL shifts the measured cells of two rows left by two columns" },
  { id: "editing.sr", expected: "decided", claim: "SR shifts the measured cells of two rows right by two columns" },
  { id: "editing.decic", expected: "decided", claim: "DECIC inserts two blank columns at column 3" },
  { id: "editing.decdc", expected: "decided", claim: "DECDC deletes two columns at column 3" },
]

/** The named set 28454 reviews: Editing's rows plus the focused test files that bind them (no glob). */
const EDITING_CONTRACT_SPEC: GroupContractSpec = {
  group: "editing",
  rows: EDITING_CONTRACT,
  tests: [
    "packages/probe-defs/src/editing-contract.test.ts",
    "packages/probe-defs/src/editing-observations.test.ts",
    "packages/probe-defs/src/editing-batch2-captures.test.ts",
    "packages/probe-defs/src/editing-geometry.test.ts",
  ],
}

test("the Editing contract covers every editing capability and names none unknown", () => {
  const gaps = contractGaps(editingProbes, EDITING_CONTRACT)
  expect(gaps.uncovered).toEqual([])
  expect(gaps.unknown).toEqual([])
  expect(gaps.misdeclared).toEqual([])
  expect(editingProbes).toHaveLength(17)
  expect(EDITING_CONTRACT).toHaveLength(17)
})

test("the Editing contract names its focused tests, and every named file exists", () => {
  const root = join(import.meta.dirname, "../../..")
  expect(missingContractTests(EDITING_CONTRACT_SPEC, root)).toEqual([])
  const command = regradeCommand(EDITING_CONTRACT_SPEC)
  expect(command).toContain("bunx --bun vitest run")
  expect(command).not.toContain("bun test")
  expect(command).not.toMatch(/[*?]/u)
  for (const path of EDITING_CONTRACT_SPEC.tests) expect(command).toContain(path)
})

// Determinism only: the surface is fed the same fixture twice, so this proves the harness replays
// without movement, NOT that a decided row is satisfied. The satisfaction binding is the table below.
test("the harness replays every editing capability deterministically", async () => {
  for (const row of EDITING_CONTRACT) {
    const probe = editingProbes.find((entry) => entry.id === row.id)
    expect(probe, `missing editing probe ${row.id}`).toBeDefined()
    if (!probe) continue
    expect(probe.termless !== null || probe.term !== null, `${row.id} has no callback`).toBe(true)
    const first = await regradeRow(probe, row, { headless: headlessContext(createSemanticSurface()) })
    const second = await regradeRow(probe, row, { headless: headlessContext(createSemanticSurface()) })
    expect(second.after, `${row.id} is not deterministic`).toBe(first.after)
    expect(second.satisfies, `${row.id} satisfaction is not deterministic`).toBe(first.satisfies)
    expect(first.satisfies, `${row.id} must route through satisfiesContract`).toBe(satisfiesContract(row, first.after))
  }
})

// The bound satisfaction proof: each decided row reads "supported" against a surface that really
// performs its edit - ICH/DCH, IL/DL, REP, the VT420 rectangle ops (DECFRA/DECERA/DECSERA/DECCRA/
// DECCARA/DECRARA), a framed DECRQCRA reply, the screen-wide SL/SR shift and the column DECIC/DECDC -
// and the one by-design row reads exactly its named inconclusive outcome. A probe whose own
// expectation disagrees with the terminal cannot pass this test.
test("every editing contract row reads its declared outcome against a surface that implements its claim", async () => {
  for (const row of EDITING_CONTRACT) {
    const probe = editingProbes.find((entry) => entry.id === row.id)
    expect(probe, `missing editing probe ${row.id}`).toBeDefined()
    if (!probe) continue
    const graded = await regradeRow(probe, row, { headless: headlessContext(createSemanticSurface()) })
    const expected = row.expected === "decided" ? "supported" : row.expected
    expect(graded.after, `${row.id} reads ${expected} from a surface implementing its claim`).toBe(expected)
    expect(graded.satisfies, `${row.id} satisfies its contract row`).toBe(true)
  }
})

// One negative control: the surface stops inserting characters, so the row must read "unsupported". A
// decided row cannot show this through `satisfies` (it accepts either pass or fail), so the observation
// itself is asserted. This is what makes the table above a measurement, not a stamp.
test("an ICH that does not insert reads unsupported", async () => {
  const row = EDITING_CONTRACT.find((entry) => entry.id === "editing.insert-chars")
  const probe = editingProbes.find((entry) => entry.id === "editing.insert-chars")
  expect(row, "the Editing contract names editing.insert-chars").toBeDefined()
  expect(probe, "the Editing contract names a real editing.insert-chars probe").toBeDefined()
  if (!row || !probe) return
  const graded = await regradeRow(probe, row, {
    headless: headlessContext(createSemanticSurface({ mutations: ["ich-noop"] })),
  })
  expect(graded.after, "editing.insert-chars detects an inert ICH").toBe("unsupported")
})
