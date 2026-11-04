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
  inertLibProbeSource,
  libProbeSource,
  missingContractTests,
  regradeCommand,
  regradeRow,
  satisfiesContract,
  type GroupContract,
  type GroupContractSpec,
} from "./testing/group-harness.ts"
import { createSemanticSurface } from "./testing/semantic-surface.ts"

const SCROLLBACK_SEMANTIC_SURFACE_CONTROLS: readonly {
  readonly id: string
  readonly mutation: string
  readonly inertOutcome: "inconclusive" | "unsupported" | undefined
  readonly mutatedOutcome: "unsupported" | undefined
}[] = [
  { id: "scrollback.accumulate", mutation: "lf-noop", inertOutcome: undefined, mutatedOutcome: undefined },
  { id: "scrollback.total-lines", mutation: "total-lines-noop", inertOutcome: undefined, mutatedOutcome: undefined },
  { id: "scrollback.scroll-up", mutation: "su-noop", inertOutcome: "inconclusive", mutatedOutcome: "unsupported" },
  { id: "scrollback.reverse-index", mutation: "ri-noop", inertOutcome: "inconclusive", mutatedOutcome: "unsupported" },
  { id: "scrollback.scroll-down", mutation: "sd-noop", inertOutcome: "inconclusive", mutatedOutcome: "unsupported" },
  {
    id: "scrollback.set-region",
    mutation: "scrollregion-noop",
    inertOutcome: "inconclusive",
    mutatedOutcome: "unsupported",
  },
  {
    id: "scrollback.alt-screen",
    mutation: "altscreen-noop",
    inertOutcome: "inconclusive",
    mutatedOutcome: "unsupported",
  },
  { id: "scrollback.decstbm", mutation: "decstbm-noop", inertOutcome: "inconclusive", mutatedOutcome: "unsupported" },
  {
    id: "scrollback.decstbm-reset",
    mutation: "decstbm-reset-noop",
    inertOutcome: "inconclusive",
    mutatedOutcome: "unsupported",
  },
  {
    id: "scrollback.viewport-hold-output",
    mutation: "viewport-hold-noop",
    inertOutcome: undefined,
    mutatedOutcome: "unsupported",
  },
]

/**
 * All ten library Scrollback features decide from measured state. The app viewport arm
 * remains coverage because the terminal UI has no live scroll actuator.
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
  {
    id: "scrollback.viewport-hold-output",
    expected: "decided",
    claim: "The viewport holds on ordinary and synchronized output",
  },
]

/** The named set 28454 reviews: Scrollback's rows plus the focused test files that bind them (no glob). */
const SCROLLBACK_CONTRACT_SPEC: GroupContractSpec = {
  group: "scrollback",
  rows: SCROLLBACK_CONTRACT,
  tests: [
    "packages/probe-defs/src/scrollback-contract.test.ts",
    "packages/probe-defs/src/scrollback-observations.test.ts",
    "packages/probes/headless-batch.test.ts",
  ],
}

// Real viewport replay and satisfaction live beside the production batch tests in probes.
// Name fixture rows explicitly so future backend-dependent rows cannot enter this loop.
const FIXTURE_SCROLLBACK_IDS = new Set([
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
  expect(command).toContain("packages/probes/headless-batch.test.ts")
  for (const path of SCROLLBACK_CONTRACT_SPEC.tests) expect(command).toContain(path)
})

// Determinism only: the surface is fed the same fixture twice, so this proves the harness replays
// without movement, NOT that a decided row is satisfied. The satisfaction binding is the test below.
test("the harness replays the fixture-backed Scrollback features deterministically", async () => {
  for (const row of SCROLLBACK_CONTRACT.filter(({ id }) => FIXTURE_SCROLLBACK_IDS.has(id))) {
    const probe = scrollbackProbes.find((entry) => entry.id === row.id)
    if (!probe) throw new Error(`Missing Scrollback probe ${row.id}`)
    expect(probe.lib !== null || probe.term !== null, `${row.id} has no callback`).toBe(true)
    const source = () => libProbeSource(createSemanticSurface())
    const first = await regradeRow(probe, row, { headless: source() })
    const second = await regradeRow(probe, row, { headless: source() })
    expect(second.after, `${row.id} is not deterministic`).toBe(first.after)
    expect(second.satisfies, `${row.id} satisfaction is not deterministic`).toBe(first.satisfies)
    expect(first.satisfies, `${row.id} must route through satisfiesContract`).toBe(satisfiesContract(row, first.after))
  }
})

// Fixture satisfaction proof; real viewport satisfaction lives beside the production batch test.
// Every row is driven by the probe's own fixture, so a probe whose expectation disagrees with the
// terminal cannot pass this test.
test("every fixture-backed Scrollback row reads the outcome its contract requires", async () => {
  for (const row of SCROLLBACK_CONTRACT.filter(({ id }) => FIXTURE_SCROLLBACK_IDS.has(id))) {
    const probe = scrollbackProbes.find((entry) => entry.id === row.id)
    if (!probe) throw new Error(`Missing Scrollback probe ${row.id}`)
    const required = row.expected === "decided" ? "supported" : row.expected
    const graded = await regradeRow(probe, row, { headless: libProbeSource(createSemanticSurface()) })
    expect(graded.after, `${row.id} reads ${required} from a surface implementing its claim`).toBe(required)
    expect(graded.satisfies, `${row.id} satisfies its contract row`).toBe(true)
  }
  // All ten library rows decide from measured grid, history or qualified viewport state.
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
    "scrollback.viewport-hold-output",
  ])
  expect(SCROLLBACK_CONTRACT.filter((row) => row.expected !== "decided")).toEqual([])
})

test("viewport hold has a measured library arm and keeps its app coverage callback", () => {
  const viewport = scrollbackProbes.find((entry) => entry.id === "scrollback.viewport-hold-output")
  expect(viewport?.term).toBeTypeOf("function")
  expect(viewport?.lib).toBeTypeOf("function")
  expect(contractGaps(scrollbackProbes, SCROLLBACK_CONTRACT).unknown).toEqual([])
})

test("the Scrollback two-sided control table covers every scrollback contract row", () => {
  expect(SCROLLBACK_SEMANTIC_SURFACE_CONTROLS.map((entry) => entry.id)).toEqual(
    SCROLLBACK_CONTRACT.map((entry) => entry.id),
  )
})

test.each(SCROLLBACK_SEMANTIC_SURFACE_CONTROLS)(
  "scrollback two-sided control for $id: inert reads $inertOutcome, semantic surface reads supported, and $mutation reads $mutatedOutcome",
  async ({ id, mutation, inertOutcome, mutatedOutcome }) => {
    const row = SCROLLBACK_CONTRACT.find((entry) => entry.id === id)
    const probe = scrollbackProbes.find((entry) => entry.id === id)
    expect(row, `missing Scrollback contract row ${id}`).toBeDefined()
    expect(probe, `missing Scrollback probe ${id}`).toBeDefined()
    if (!row || !probe) return

    const inert = await regradeRow(probe, row, { headless: inertLibProbeSource() })
    expect(inert.after, `${id} must not read supported against inertLibProbeSource()`).toBe(inertOutcome)

    const positive = await regradeRow(probe, row, { headless: libProbeSource(createSemanticSurface()) })
    expect(positive.after, `${id} must read supported against createSemanticSurface()`).toBe("supported")
    expect(positive.satisfies, `${id} must satisfy its contract row on createSemanticSurface()`).toBe(true)

    const mutated = await regradeRow(probe, row, {
      headless: libProbeSource(createSemanticSurface({ mutations: [mutation] })),
    })
    expect(mutated.after, `${id} records its controlled outcome when ${mutation} is active`).toBe(mutatedOutcome)
    expect(mutated.satisfies, `${id} is decided only with an observed outcome under ${mutation}`).toBe(
      mutatedOutcome !== undefined,
    )
  },
)
