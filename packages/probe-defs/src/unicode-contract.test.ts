/**
 * @failure A Unicode capability is graded without a bound contract row, or a re-grade of a decided
 *   observation moves it - so the Unicode group reinvents its own fixture and silently drifts.
 * @level l2
 * @consumer 28018 candidate-2 Unicode group (child 28026); adopts the 28453 harness.
 * @reach fs-walk vendor/terminfo.dev/packages/probe-defs/src/unicode-contract.test.ts vendor/terminfo.dev/packages/probe-defs/src/text-unicode-observations.test.ts vendor/terminfo.dev/packages/probe-defs/src/testing/semantic-surface.ts
 * @testonly none
 */
import { expect, test } from "vitest"
import { join } from "node:path"
import { unicodeProbes } from "./unicode.ts"
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

/** The 4 Unicode capabilities of 28018's Unicode row; ids from unicode.ts, claims are the contract. */
const UNICODE_CONTRACT: GroupContract = [
  {
    id: "unicode.east-asian-ambiguous",
    expected: "decided",
    claim: "An ambiguous-width symbol advances one or two cells while the ASCII seed and control are preserved",
  },
  {
    id: "unicode.grapheme-cursor",
    expected: "decided",
    claim: "The ZWJ family sample occupies exactly two measured cells at the cursor",
  },
  {
    id: "unicode.wrap-boundary",
    expected: "decided",
    claim: "A wide character at the final column wraps to the next row with the ASCII control intact",
  },
  {
    id: "unicode.tab-stops",
    expected: "decided",
    claim: "A tab advances the cursor to the configured stop at column 9",
  },
]

/**
 * The named set 28454 reviews: Unicode's rows plus the focused test files that bind them (no glob).
 * `text-unicode-observations.test.ts` is shared with the Text group on purpose (#28021): a named test may
 * bind rows from two groups, and @dev/11 and @dev/5 agreed the list does not diverge.
 */
const UNICODE_CONTRACT_SPEC: GroupContractSpec = {
  group: "unicode",
  rows: UNICODE_CONTRACT,
  tests: [
    "packages/probe-defs/src/unicode-contract.test.ts",
    "packages/probe-defs/src/text-unicode-observations.test.ts",
  ],
}

test("the Unicode contract covers every unicode capability and names none unknown", () => {
  const gaps = contractGaps(unicodeProbes, UNICODE_CONTRACT)
  expect(gaps.uncovered).toEqual([])
  expect(gaps.unknown).toEqual([])
  expect(gaps.misdeclared).toEqual([])
  expect(unicodeProbes).toHaveLength(4)
  expect(UNICODE_CONTRACT).toHaveLength(4)
})

test("the Unicode contract names its focused tests, and every named file exists", () => {
  const root = join(import.meta.dirname, "../../..")
  expect(missingContractTests(UNICODE_CONTRACT_SPEC, root)).toEqual([])
  const command = regradeCommand(UNICODE_CONTRACT_SPEC)
  expect(command).toContain("bunx --bun vitest run")
  expect(command).not.toContain("bun test")
  expect(command).not.toMatch(/[*?]/u)
  for (const path of UNICODE_CONTRACT_SPEC.tests) expect(command).toContain(path)
})

// Determinism only: the surface is fed the same fixture twice, so this proves the harness replays
// without movement, NOT that a decided row is satisfied. The satisfaction binding is the table below.
test("the harness replays every unicode capability deterministically", async () => {
  for (const row of UNICODE_CONTRACT) {
    const probe = unicodeProbes.find((entry) => entry.id === row.id)
    expect(probe, `missing unicode probe ${row.id}`).toBeDefined()
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
// implements the width, grapheme, wrap and tab behaviour its claim names. A probe whose own
// expectation disagrees with the terminal cannot pass this test.
test("every unicode contract row reads supported against a surface that implements its claim", async () => {
  for (const row of UNICODE_CONTRACT) {
    const probe = unicodeProbes.find((entry) => entry.id === row.id)
    expect(probe, `missing unicode probe ${row.id}`).toBeDefined()
    if (!probe) continue
    const graded = await regradeRow(probe, row, { headless: headlessContext(createSemanticSurface()) })
    expect(graded.after, `${row.id} reads supported from a surface implementing its claim`).toBe("supported")
    expect(graded.satisfies, `${row.id} satisfies its contract row`).toBe(true)
  }
})

// One negative control: the surface stops advancing on HT, so the tab row must read "unsupported".
// A decided row cannot show this through satisfies (it accepts either pass or fail), so the
// observation itself is asserted. This is what makes the table above a measurement, not a stamp.
test("a surface whose HT is inert reads unicode.tab-stops unsupported", async () => {
  const row = UNICODE_CONTRACT.find((entry) => entry.id === "unicode.tab-stops")
  const probe = unicodeProbes.find((entry) => entry.id === "unicode.tab-stops")
  expect(row, "the Unicode contract names unicode.tab-stops").toBeDefined()
  expect(probe, "the Unicode contract names a real unicode.tab-stops probe").toBeDefined()
  if (!row || !probe) return
  const graded = await regradeRow(probe, row, {
    headless: headlessContext(createSemanticSurface({ mutations: ["ht-noop"] })),
  })
  expect(graded.after, "unicode.tab-stops detects an inert HT").toBe("unsupported")
})
