/**
 * @failure A Scrollback feature is graded without a bound contract row, a decided re-grade drifts,
 *   or the viewport coverage feature is silently dropped from the group contract.
 * @level l2
 * @consumer 28018 candidate-2 Scrollback group (child 28459); the 28453 harness adopter.
 * @reach fs-walk vendor/terminfo.dev/packages/probe-defs/src/scrollback-contract.test.ts vendor/terminfo.dev/packages/probe-defs/src/scrollback-observations.test.ts vendor/terminfo.dev/packages/probe-defs/src/testing/group-harness.ts vendor/terminfo.dev/packages/probe-defs/src/testing/semantic-surface.ts
 * @testonly none
 */
import { expect, test } from "vitest"
import { join } from "node:path"
import { scrollbackProbes } from "./scrollback.ts"
import {
  contractGaps,
  libProbeSource,
  missingContractTests,
  regradeCommand,
  regradeRow,
  satisfiesContract,
  type GroupContract,
  type GroupContractSpec,
} from "./testing/group-harness.ts"
import { createSemanticSurface } from "./testing/semantic-surface.ts"

/**
 * All ten Scrollback features have definitions. Nine decide from measured state; viewport hold
 * executes a coverage callback naming our missing source actuator/readback and stays TEST TODO.
 */
const SCROLLBACK_CONTRACT: GroupContract = [
  {
    id: "scrollback.accumulate",
    expected: "decided",
    claim: "Writing beyond one screen grows measured scrollback history",
  },
  { id: "scrollback.total-lines", expected: "decided", claim: "Measured total lines exceed one screen after overflow" },
  {
    id: "scrollback.scroll-up",
    expected: "decided",
    claim: "Interior-region SU shifts the measured middle and bottom rows up, clearing the region bottom",
  },
  { id: "scrollback.reverse-index", expected: "decided", claim: "RI inserts a blank row above the measured marker" },
  { id: "scrollback.scroll-down", expected: "decided", claim: "SD inserts a blank row above the measured marker" },
  {
    id: "scrollback.set-region",
    expected: "decided",
    claim: "DECSTBM sets the region: a marker on the requested top row scrolls out while the row above it stays",
  },
  {
    id: "scrollback.alt-screen",
    expected: "decided",
    claim: "ESC[?1049h swaps to a separate alt grid and ESC[?1049l restores the measured main grid",
  },
  {
    id: "scrollback.decstbm",
    expected: "decided",
    claim: "DECSTBM scrolls the inner marker while preserving the fixed top row outside the region",
  },
  {
    id: "scrollback.decstbm-reset",
    expected: "decided",
    claim: "After ESC[r the full screen scrolls into history where an active region's bottom row does not",
  },
  { id: "scrollback.viewport-hold-output", expected: "not-tested", claim: "The viewport holds on output" },
]

/** The named set 28454 reviews: Scrollback's rows plus the focused test files that bind them (no glob). */
const SCROLLBACK_CONTRACT_SPEC: GroupContractSpec = {
  group: "scrollback",
  rows: SCROLLBACK_CONTRACT,
  tests: [
    "packages/probe-defs/src/scrollback-contract.test.ts",
    "packages/probe-defs/src/scrollback-observations.test.ts",
  ],
}

test("the Scrollback contract covers every probe including viewport coverage", () => {
  const gaps = contractGaps(scrollbackProbes, SCROLLBACK_CONTRACT)
  expect(gaps.uncovered).toEqual([])
  expect(gaps.unknown).toEqual([])
  expect(gaps.misdeclared).toEqual([])
  expect(scrollbackProbes).toHaveLength(10)
  expect(SCROLLBACK_CONTRACT).toHaveLength(10)
  expect(scrollbackProbes.map((entry) => entry.id)).toContain("scrollback.viewport-hold-output")
  expect(SCROLLBACK_CONTRACT.map((entry) => entry.id)).toContain("scrollback.viewport-hold-output")
})

test("the Scrollback contract names its focused tests, and every named file exists", () => {
  const root = join(import.meta.dirname, "../../..")
  expect(missingContractTests(SCROLLBACK_CONTRACT_SPEC, root)).toEqual([])
  const command = regradeCommand(SCROLLBACK_CONTRACT_SPEC)
  expect(command).toContain("bunx --bun vitest run")
  expect(command).not.toContain("bun test")
  expect(command).not.toMatch(/[*?]/u)
  for (const path of SCROLLBACK_CONTRACT_SPEC.tests) expect(command).toContain(path)
})

// Determinism only: the surface is fed the same fixture twice, so this proves the harness replays
// without movement, NOT that a decided row is satisfied. The satisfaction binding is the test below.
test("the harness replays every probe-backed Scrollback feature deterministically", async () => {
  for (const row of SCROLLBACK_CONTRACT) {
    const probe = scrollbackProbes.find((entry) => entry.id === row.id)
    if (!probe) throw new Error(`Missing Scrollback probe ${row.id}`)
    if (!probe.lib) continue // viewport coverage uses the term callback, checked separately below
    expect(probe.lib !== null || probe.term !== null, `${row.id} has no callback`).toBe(true)
    const first = await regradeRow(probe, row, { headless: libProbeSource(createSemanticSurface()) })
    const second = await regradeRow(probe, row, { headless: libProbeSource(createSemanticSurface()) })
    expect(second.after, `${row.id} is not deterministic`).toBe(first.after)
    expect(second.satisfies, `${row.id} satisfaction is not deterministic`).toBe(first.satisfies)
    expect(first.satisfies, `${row.id} must route through satisfiesContract`).toBe(satisfiesContract(row, first.after))
  }
})

// The bound satisfaction proof: each decided row reads "supported" against a surface that really
// implements the operation its claim names, and each by-design inconclusive row reads exactly that.
// Every row is driven by the probe's own fixture, so a probe whose expectation disagrees with the
// terminal cannot pass this test.
test("every decided Scrollback row reads the outcome its contract requires", async () => {
  for (const row of SCROLLBACK_CONTRACT.filter((row) => row.expected === "decided")) {
    const probe = scrollbackProbes.find((entry) => entry.id === row.id)
    if (!probe) throw new Error(`Missing Scrollback probe ${row.id}`)
    const required = row.expected === "decided" ? "supported" : row.expected
    const graded = await regradeRow(probe, row, { headless: libProbeSource(createSemanticSurface()) })
    expect(graded.after, `${row.id} reads ${required} from a surface implementing its claim`).toBe(required)
    expect(graded.satisfies, `${row.id} satisfies its contract row`).toBe(true)
  }
  // Every probe-backed row is decided as of the 2026-10-10 denominator correction (#28459): the three
  // rows that once read inconclusive now decide from the measured grid or the measured history count.
  const decided = SCROLLBACK_CONTRACT.filter((row) => row.expected === "decided").map((row) => row.id)
  expect(decided).toEqual([
    "scrollback.accumulate",
    "scrollback.total-lines",
    "scrollback.scroll-up",
    "scrollback.reverse-index",
    "scrollback.scroll-down",
    "scrollback.set-region",
    "scrollback.alt-screen",
    "scrollback.decstbm",
    "scrollback.decstbm-reset",
  ])
  // Viewport hold remains explicitly unmeasured; registration grants no support outcome.
  expect(SCROLLBACK_CONTRACT.filter((row) => row.expected !== "decided").map((row) => row.id)).toEqual([
    "scrollback.viewport-hold-output",
  ])
})

test("viewport coverage is backed by a real term callback and keeps its null library arm", () => {
  const viewport = scrollbackProbes.find((entry) => entry.id === "scrollback.viewport-hold-output")
  expect(viewport?.term).toBeTypeOf("function")
  expect(viewport?.lib).toBeNull()
  expect(contractGaps(scrollbackProbes, SCROLLBACK_CONTRACT).unknown).toEqual([])
})

// One negative control: a surface whose line feed never advances cannot grow history, so the
// accumulate row must read "unsupported". A decided row accepts either pass or fail through
// `satisfies`, so the observation itself is asserted - this is what makes the table above a
// measurement, not a stamp.
test("an inert line feed reads unsupported for scrollback accumulation", async () => {
  const row = SCROLLBACK_CONTRACT.find((entry) => entry.id === "scrollback.accumulate")
  const probe = scrollbackProbes.find((entry) => entry.id === "scrollback.accumulate")
  expect(row, "the Scrollback contract names scrollback.accumulate").toBeDefined()
  expect(probe, "the Scrollback contract names a real scrollback.accumulate probe").toBeDefined()
  if (!row || !probe) return
  const graded = await regradeRow(probe, row, {
    headless: libProbeSource(createSemanticSurface({ mutations: ["lf-noop"] })),
  })
  expect(graded.after, "an inert line feed is detected").toBe("unsupported")
})
