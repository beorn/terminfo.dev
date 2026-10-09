/**
 * @failure A Text capability is graded without a bound contract row, or a re-grade of a decided
 *   observation moves it - so the Text group reinvents its own fixture and silently drifts.
 * @level l2
 * @consumer 28018 candidate-2 Text group (child 28021); the 28453 harness's third adopter.
 * @reach fs-walk vendor/terminfo.dev/packages/probe-defs/src/text-contract.test.ts vendor/terminfo.dev/packages/probe-defs/src/text-unicode-observations.test.ts vendor/terminfo.dev/packages/probe-defs/src/text-overwrite-capture-observations.test.ts vendor/terminfo.dev/packages/probe-defs/src/testing/group-harness.ts vendor/terminfo.dev/packages/probe-defs/src/testing/semantic-surface.ts
 * @testonly none
 */
import { expect, test } from "vitest"
import { join } from "node:path"
import { textProbes } from "./text.ts"
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

/** The 20 Text capabilities of 28018's Text row; ids drawn from text.ts, claims are the contract. */
const TEXT_CONTRACT: GroupContract = [
  { id: "text.basic", expected: "decided", claim: "Hello appears after a measured empty control" },
  { id: "text.newline", expected: "decided", claim: "CRLF places B below A" },
  { id: "text.wrap", expected: "decided", claim: "the next X wraps to the measured second row" },
  { id: "text.tab", expected: "decided", claim: "HT moves X to the owned stop at column 9" },
  { id: "text.wide.emoji", expected: "decided", claim: "the declared emoji sample claims two parser columns" },
  { id: "text.wide.cjk", expected: "decided", claim: "the CJK sample occupies a wide parser cell" },
  { id: "text.overwrite", expected: "decided", claim: "C overwrites A while B remains" },
  { id: "text.cr", expected: "decided", claim: "CR returns C to the first column while B remains" },
  { id: "text.backspace", expected: "decided", claim: "BS lets C overwrite B while A remains" },
  { id: "text.index", expected: "decided", claim: "IND advances the parser cursor one row" },
  { id: "text.next-line", expected: "decided", claim: "NEL advances the parser cursor to row 2 column 1" },
  {
    id: "text.reverse-index-scroll",
    expected: "decided",
    claim: "RI moves the measured MARKER to the second row",
  },
  { id: "text.combining", expected: "decided", claim: "a combining accent keeps X in the next parser cell" },
  { id: "text.hts", expected: "decided", claim: "HTS makes the tab advance to column 6" },
  { id: "text.tbc", expected: "decided", claim: "clearing the tab stops makes HT reach the right margin" },
  { id: "text.cht", expected: "decided", claim: "CHT advances two owned stops to column 17" },
  { id: "text.cbt", expected: "decided", claim: "CBT moves back one owned stop to column 17" },
  { id: "text.wide.emoji-flags", expected: "decided", claim: "the flag sample claims two parser columns" },
  { id: "text.wide.emoji-vs16", expected: "decided", claim: "the VS16 sample claims two parser columns" },
  { id: "text.wide.emoji-zwj", expected: "decided", claim: "the ZWJ sequence claims two parser columns" },
]

/**
 * The named set 28454 reviews: Text's rows plus the focused test files that bind them (no glob).
 * `text-unicode-observations.test.ts` is shared with the Unicode group (#28026, @dev/11) on purpose:
 * a named test may bind rows from two groups, and the list is settled jointly with @dev/11.
 */
const TEXT_CONTRACT_SPEC: GroupContractSpec = {
  group: "text",
  rows: TEXT_CONTRACT,
  tests: [
    "packages/probe-defs/src/text-contract.test.ts",
    "packages/probe-defs/src/text-unicode-observations.test.ts",
    "packages/probe-defs/src/text-overwrite-capture-observations.test.ts",
  ],
}

test("the Text contract covers every text capability and names none unknown", () => {
  const gaps = contractGaps(textProbes, TEXT_CONTRACT)
  expect(gaps.uncovered).toEqual([])
  expect(gaps.unknown).toEqual([])
  expect(gaps.misdeclared).toEqual([])
  expect(textProbes).toHaveLength(20)
  expect(TEXT_CONTRACT).toHaveLength(20)
})

test("the Text contract names its focused tests, and every named file exists", () => {
  const root = join(import.meta.dirname, "../../..")
  expect(missingContractTests(TEXT_CONTRACT_SPEC, root)).toEqual([])
  const command = regradeCommand(TEXT_CONTRACT_SPEC)
  expect(command).toContain("bunx --bun vitest run")
  expect(command).not.toContain("bun test")
  expect(command).not.toMatch(/[*?]/u)
  for (const path of TEXT_CONTRACT_SPEC.tests) expect(command).toContain(path)
})

// Determinism only: the surface is fed the same fixture twice, so this proves the harness replays
// without movement, NOT that a decided row is satisfied. The satisfaction binding is the table below.
test("the harness replays every text capability deterministically", async () => {
  for (const row of TEXT_CONTRACT) {
    const probe = textProbes.find((entry) => entry.id === row.id)
    expect(probe, `missing text probe ${row.id}`).toBeDefined()
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
// implements the text its claim names - a plain write, CR/LF/CRLF, right-margin wrap, the tab family
// (HT/HTS/TBC/CHT/CBT), overwrite, BS, IND, NEL, RI with a real scroll region, a combining accent,
// and grapheme-aware width for CJK, emoji, VS16, ZWJ and flag samples. A probe whose own expectation
// disagrees with the terminal cannot pass this test.
test("every text contract row reads supported against a surface that implements its claim", async () => {
  for (const row of TEXT_CONTRACT) {
    const probe = textProbes.find((entry) => entry.id === row.id)
    expect(probe, `missing text probe ${row.id}`).toBeDefined()
    if (!probe) continue
    const graded = await regradeRow(probe, row, { headless: headlessContext(createSemanticSurface()) })
    expect(graded.after, `${row.id} reads supported from a surface implementing its claim`).toBe("supported")
    expect(graded.satisfies, `${row.id} satisfies its contract row`).toBe(true)
  }
})

// One negative control: the surface stops honouring BS, so the row must read "unsupported". A decided
// row cannot show this through `satisfies` (it accepts either pass or fail), so the observation itself
// is asserted. This is what makes the table above a measurement, not a stamp.
test("a backspace that does not move reads unsupported", async () => {
  const row = TEXT_CONTRACT.find((entry) => entry.id === "text.backspace")
  const probe = textProbes.find((entry) => entry.id === "text.backspace")
  expect(row, "the Text contract names text.backspace").toBeDefined()
  expect(probe, "the Text contract names a real text.backspace probe").toBeDefined()
  if (!row || !probe) return
  const graded = await regradeRow(probe, row, {
    headless: headlessContext(createSemanticSurface({ mutations: ["bs-noop"] })),
  })
  expect(graded.after, "text.backspace detects an inert BS").toBe("unsupported")
})
