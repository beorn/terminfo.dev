/**
 * @failure An Erase capability is graded without a bound contract row, or a re-grade of a decided
 *   observation moves it - so the Erase group reinvents its own fixture and silently drifts.
 * @level l2
 * @consumer 28018 candidate-2 Erase group (child 28023); the 28453 harness's second adopter.
 * @reach fs-walk vendor/terminfo.dev/packages/probe-defs/src/erase-contract.test.ts vendor/terminfo.dev/packages/probe-defs/src/erase-observations.test.ts vendor/terminfo.dev/packages/probe-defs/src/testing/group-harness.ts vendor/terminfo.dev/packages/probe-defs/src/testing/semantic-surface.ts
 * @testonly none
 */
import { expect, test } from "vitest"
import { join } from "node:path"
import { eraseProbes } from "./erase.ts"
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
import { createSemanticSurface } from "./testing/semantic-surface.ts"

/** The 11 Erase capabilities of 28018's Erase row; ids drawn from erase.ts, claims are the contract. */
const ERASE_CONTRACT: GroupContract = [
  { id: "erase.line.right", expected: "decided", claim: "EL0 erases from the cursor to the end of the line" },
  { id: "erase.line.left", expected: "decided", claim: "EL1 erases from the line start through the cursor" },
  { id: "erase.line.all", expected: "decided", claim: "EL2 erases the whole line and preserves the adjacent row" },
  { id: "erase.screen.below", expected: "decided", claim: "ED0 erases from the cursor to the end of the screen" },
  { id: "erase.screen.above", expected: "decided", claim: "ED1 erases from the screen start through the cursor" },
  { id: "erase.screen.all", expected: "decided", claim: "ED2 erases the whole screen" },
  {
    id: "erase.screen.scrollback",
    expected: "decided",
    claim: "ED3 removes measured scrollback and keeps screen geometry",
  },
  { id: "erase.character", expected: "decided", claim: "ECH erases the requested cells from the cursor" },
  {
    id: "erase.selective",
    expected: "decided",
    claim: "Selective erase clears unprotected cells and keeps the DECSCA-protected cell",
  },
  {
    id: "erase.el-with-attrs",
    expected: "decided",
    claim: "EL keeps the erased cells' measured non-default background",
  },
  {
    id: "erase.ed-scroll-region",
    expected: "decided",
    claim: "ED0 erases below the cursor and preserves the preceding row, inside a scroll region",
  },
]

/** The named set 28454 reviews: Erase's rows plus the focused test files that bind them (no glob). */
const ERASE_CONTRACT_SPEC: GroupContractSpec = {
  group: "erase",
  rows: ERASE_CONTRACT,
  tests: ["packages/probe-defs/src/erase-contract.test.ts", "packages/probe-defs/src/erase-observations.test.ts"],
}

test("the Erase contract covers every erase capability and names none unknown", () => {
  const gaps = contractGaps(eraseProbes, ERASE_CONTRACT)
  expect(gaps.uncovered).toEqual([])
  expect(gaps.unknown).toEqual([])
  expect(gaps.misdeclared).toEqual([])
  expect(eraseProbes).toHaveLength(11)
  expect(ERASE_CONTRACT).toHaveLength(11)
})

test("the Erase contract names its focused tests, and every named file exists", () => {
  const root = join(import.meta.dirname, "../../..")
  expect(missingContractTests(ERASE_CONTRACT_SPEC, root)).toEqual([])
  const command = regradeCommand(ERASE_CONTRACT_SPEC)
  expect(command).toContain("bunx --bun vitest run")
  expect(command).not.toContain("bun test")
  expect(command).not.toMatch(/[*?]/u)
  for (const path of ERASE_CONTRACT_SPEC.tests) expect(command).toContain(path)
})

// Determinism only: the surface is fed the same fixture twice, so this proves the harness replays
// without movement, NOT that a decided row is satisfied. The satisfaction binding is the table below.
test("the harness replays every erase capability deterministically", async () => {
  for (const row of ERASE_CONTRACT) {
    const probe = eraseProbes.find((entry) => entry.id === row.id)
    expect(probe, `missing erase probe ${row.id}`).toBeDefined()
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
// implements the operation its claim names. Every row is driven by the probe's own fixture, so a probe
// whose expectation table disagrees with the terminal cannot pass this test.
test("every erase contract row reads supported against a surface that implements its claim", async () => {
  for (const row of ERASE_CONTRACT) {
    const probe = eraseProbes.find((entry) => entry.id === row.id)
    expect(probe, `missing erase probe ${row.id}`).toBeDefined()
    if (!probe) continue
    const graded = await regradeRow(probe, row, { headless: headlessContext(createSemanticSurface()) })
    expect(graded.after, `${row.id} reads supported from a surface implementing its claim`).toBe("supported")
    expect(graded.satisfies, `${row.id} satisfies its contract row`).toBe(true)
  }
})

// One negative control: the surface stops erasing the line, so the EL rows must read "unsupported".
// A decided row cannot show this through `satisfies` (a decided row accepts either pass or fail), so
// the observation itself is asserted. This is what makes the table above a measurement, not a stamp.
test("an EL that does not erase reads unsupported", async () => {
  const elRows = ["erase.line.right", "erase.line.left", "erase.line.all", "erase.el-with-attrs"]
  for (const id of elRows) {
    const row = ERASE_CONTRACT.find((entry) => entry.id === id)
    const probe = eraseProbes.find((entry) => entry.id === id)
    expect(row, `the Erase contract names ${id}`).toBeDefined()
    expect(probe, `the Erase contract names a real ${id} probe`).toBeDefined()
    if (!row || !probe) continue
    const graded = await regradeRow(probe, row, {
      headless: headlessContext(createSemanticSurface({ mutations: ["el-noop"] })),
    })
    expect(graded.after, `${id} detects an inert EL`).toBe("unsupported")
  }
})
