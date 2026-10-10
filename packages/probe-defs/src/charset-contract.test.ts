/**
 * @failure A Character Sets capability is graded without a bound contract row, or a re-grade of a
 *   decided observation moves it - so the Character Sets group reinvents its own fixture and silently drifts.
 * @level l2
 * @consumer 28018 candidate-2 Character Sets group (child 28025); adopts the 28453 harness.
 * @reach fs-walk vendor/terminfo.dev/packages/probe-defs/src/charset-contract.test.ts vendor/terminfo.dev/packages/probe-defs/src/charset-reset-geometry.test.ts vendor/terminfo.dev/packages/probe-defs/src/testing/semantic-surface.ts
 * @testonly none
 */
import { expect, test } from "vitest"
import { join } from "node:path"
import { charsetsProbes } from "./charsets.ts"
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

/** The 4 Character Sets capabilities of 28018's Character Sets row; ids from charsets.ts, claims are the contract. */
const CHARSET_CONTRACT: GroupContract = [
  {
    id: "charsets.dec-special",
    expected: "decided",
    claim: "DEC Special Graphics maps q to U+2500 while the ASCII q flanks are preserved",
  },
  {
    id: "charsets.utf8",
    expected: "decided",
    claim: "UTF-8 input places e-acute and U+4E16 in their target cells with the ASCII controls intact",
  },
  {
    id: "charsets.g0-g1-switching",
    expected: "decided",
    claim: "SI/SO select G0/G1 so a G1-designated DEC l renders U+250C between ASCII l controls",
  },
  {
    id: "charsets.dec-line-drawing",
    expected: "decided",
    claim: "DEC jklmqx map to the six box glyphs while a trailing ASCII j is unchanged",
  },
]

/**
 * The named set 28454 reviews: Character Sets' rows plus the focused test files that bind them (no glob).
 * `charset-reset-geometry.test.ts` is shared with the Reset group on purpose (#28024): a named test may
 * bind rows from two groups, and @dev/11 and @dev/5 agreed the list does not diverge.
 */
const CHARSET_CONTRACT_SPEC: GroupContractSpec = {
  group: "charsets",
  rows: CHARSET_CONTRACT,
  tests: ["packages/probe-defs/src/charset-contract.test.ts", "packages/probe-defs/src/charset-reset-geometry.test.ts"],
}

test("the Character Sets contract covers every charsets capability and names none unknown", () => {
  const gaps = contractGaps(charsetsProbes, CHARSET_CONTRACT)
  expect(gaps.uncovered).toEqual([])
  expect(gaps.unknown).toEqual([])
  expect(gaps.misdeclared).toEqual([])
  expect(charsetsProbes).toHaveLength(4)
  expect(CHARSET_CONTRACT).toHaveLength(4)
})

test("the Character Sets contract names its focused tests, and every named file exists", () => {
  const root = join(import.meta.dirname, "../../..")
  expect(missingContractTests(CHARSET_CONTRACT_SPEC, root)).toEqual([])
  const command = regradeCommand(CHARSET_CONTRACT_SPEC)
  expect(command).toContain("bunx --bun vitest run")
  expect(command).not.toContain("bun test")
  expect(command).not.toMatch(/[*?]/u)
  for (const path of CHARSET_CONTRACT_SPEC.tests) expect(command).toContain(path)
})

// Determinism only: the surface is fed the same fixture twice, so this proves the harness replays
// without movement, NOT that a decided row is satisfied. The satisfaction binding is the table below.
test("the harness replays every charsets capability deterministically", async () => {
  for (const row of CHARSET_CONTRACT) {
    const probe = charsetsProbes.find((entry) => entry.id === row.id)
    expect(probe, `missing charsets probe ${row.id}`).toBeDefined()
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
// implements the designation and mapping its claim names - SI/SO, ESC ( / ESC ) and the DEC Special
// Graphics table. A probe whose own expectation disagrees with the terminal cannot pass this test.
test("every charsets contract row reads supported against a surface that implements its claim", async () => {
  for (const row of CHARSET_CONTRACT) {
    const probe = charsetsProbes.find((entry) => entry.id === row.id)
    expect(probe, `missing charsets probe ${row.id}`).toBeDefined()
    if (!probe) continue
    const graded = await regradeRow(probe, row, { headless: headlessContext(createSemanticSurface()) })
    expect(graded.after, `${row.id} reads supported from a surface implementing its claim`).toBe("supported")
    expect(graded.satisfies, `${row.id} satisfies its contract row`).toBe(true)
  }
})

// One negative control: the surface leaves a G0/G1 designation unmapped, so the row must read
// "unsupported". A decided row cannot show this through satisfies (it accepts either pass or fail),
// so the observation itself is asserted. This is what makes the table above a measurement, not a stamp.
test("a surface whose designation is inert reads charsets.dec-special unsupported", async () => {
  const row = CHARSET_CONTRACT.find((entry) => entry.id === "charsets.dec-special")
  const probe = charsetsProbes.find((entry) => entry.id === "charsets.dec-special")
  expect(row, "the Character Sets contract names charsets.dec-special").toBeDefined()
  expect(probe, "the Character Sets contract names a real charsets.dec-special probe").toBeDefined()
  if (!row || !probe) return
  const graded = await regradeRow(probe, row, {
    headless: headlessContext(createSemanticSurface({ mutations: ["charset-noop"] })),
  })
  expect(graded.after, "charsets.dec-special detects an inert designation").toBe("unsupported")
})
