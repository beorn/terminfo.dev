/**
 * @failure A Reset capability is graded without a bound contract row, or a re-grade of a decided
 *   observation moves it - so the Reset group reinvents its own fixture and silently drifts.
 * @level l2
 * @consumer 28018 candidate-2 Reset group (child 28024); adopts the 28453 harness.
 * @reach fs-walk vendor/terminfo.dev/packages/probe-defs/src/reset-contract.test.ts vendor/terminfo.dev/packages/probe-defs/src/charset-reset-geometry.test.ts vendor/terminfo.dev/packages/probe-defs/src/helper-observations.test.ts vendor/terminfo.dev/packages/probe-defs/src/testing/semantic-surface.ts
 * @testonly none
 */
import { expect, test } from "vitest"
import { join } from "node:path"
import { resetProbes } from "./reset.ts"
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

/** The 5 Reset capabilities of 28018's Reset row; ids drawn from reset.ts, claims are the contract. */
const RESET_CONTRACT: GroupContract = [
  { id: "reset.sgr", expected: "decided", claim: "SGR 0 clears measured bold, italic and inverse styling" },
  { id: "reset.ris", expected: "decided", claim: "RIS returns the cursor home and clears measured text" },
  { id: "reset.soft", expected: "decided", claim: "DECSTR clears an enabled application-cursor mode" },
  { id: "reset.decaln", expected: "decided", claim: "DECALN fills the measured cell with E" },
  {
    id: "reset.method",
    expected: "decided",
    claim: "The reset method returns the cursor home and clears measured text",
  },
]

/**
 * The named set 28454 reviews: Reset's rows plus the focused test files that bind them (no glob).
 * `charset-reset-geometry.test.ts` is shared with the Character Sets group on purpose (#28025): a named
 * test may bind rows from two groups, and @dev/11 and @dev/5 agreed the list does not diverge. Reset has
 * no reset-named file of its own.
 */
const RESET_CONTRACT_SPEC: GroupContractSpec = {
  group: "reset",
  rows: RESET_CONTRACT,
  tests: [
    "packages/probe-defs/src/reset-contract.test.ts",
    "packages/probe-defs/src/charset-reset-geometry.test.ts",
    "packages/probe-defs/src/helper-observations.test.ts",
  ],
}

test("the Reset contract covers every reset capability and names none unknown", () => {
  const gaps = contractGaps(resetProbes, RESET_CONTRACT)
  expect(gaps.uncovered).toEqual([])
  expect(gaps.unknown).toEqual([])
  expect(gaps.misdeclared).toEqual([])
  expect(resetProbes).toHaveLength(5)
  expect(RESET_CONTRACT).toHaveLength(5)
})

test("the Reset contract names its focused tests, and every named file exists", () => {
  const root = join(import.meta.dirname, "../../..")
  expect(missingContractTests(RESET_CONTRACT_SPEC, root)).toEqual([])
  const command = regradeCommand(RESET_CONTRACT_SPEC)
  expect(command).toContain("bunx --bun vitest run")
  expect(command).not.toContain("bun test")
  expect(command).not.toMatch(/[*?]/u)
  for (const path of RESET_CONTRACT_SPEC.tests) expect(command).toContain(path)
})

// Determinism only: the surface is fed the same fixture twice, so this proves the harness replays
// without movement, NOT that a decided row is satisfied. The satisfaction binding is the table below.
test("the harness replays every reset capability deterministically", async () => {
  for (const row of RESET_CONTRACT) {
    const probe = resetProbes.find((entry) => entry.id === row.id)
    expect(probe, `missing reset probe ${row.id}`).toBeDefined()
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
// implements the reset its claim names - SGR attributes and their reset, RIS, DECSTR over a real
// application-cursor mode, DECALN's alignment fill, and the reset method. A probe whose own
// expectation disagrees with the terminal cannot pass this test.
test("every reset contract row reads supported against a surface that implements its claim", async () => {
  for (const row of RESET_CONTRACT) {
    const probe = resetProbes.find((entry) => entry.id === row.id)
    expect(probe, `missing reset probe ${row.id}`).toBeDefined()
    if (!probe) continue
    const graded = await regradeRow(probe, row, { headless: headlessContext(createSemanticSurface()) })
    expect(graded.after, `${row.id} reads supported from a surface implementing its claim`).toBe("supported")
    expect(graded.satisfies, `${row.id} satisfies its contract row`).toBe(true)
  }
})

// One negative control: the surface stops clearing on RIS, so the row must read "unsupported". A
// decided row cannot show this through `satisfies` (it accepts either pass or fail), so the
// observation itself is asserted. This is what makes the table above a measurement, not a stamp.
test("a RIS that does not reset reads unsupported", async () => {
  const row = RESET_CONTRACT.find((entry) => entry.id === "reset.ris")
  const probe = resetProbes.find((entry) => entry.id === "reset.ris")
  expect(row, "the Reset contract names reset.ris").toBeDefined()
  expect(probe, "the Reset contract names a real reset.ris probe").toBeDefined()
  if (!row || !probe) return
  const graded = await regradeRow(probe, row, {
    headless: headlessContext(createSemanticSurface({ mutations: ["ris-noop"] })),
  })
  expect(graded.after, "reset.ris detects an inert RIS").toBe("unsupported")
})
