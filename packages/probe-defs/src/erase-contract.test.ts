/**
 * @failure An Erase feature is graded without a bound contract row, or a re-grade of a decided
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

/** The 11 Erase features of 28018's Erase row; ids drawn from erase.ts, claims are the contract. */
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

test("the Erase contract covers every erase feature and names none unknown", () => {
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
test("the harness replays every erase feature deterministically", async () => {
  for (const row of ERASE_CONTRACT) {
    const probe = eraseProbes.find((entry) => entry.id === row.id)
    expect(probe, `missing erase probe ${row.id}`).toBeDefined()
    if (!probe) continue
    expect(probe.lib !== null || probe.term !== null, `${row.id} has no callback`).toBe(true)
    const first = await regradeRow(probe, row, { headless: libProbeSource(createSemanticSurface()) })
    const second = await regradeRow(probe, row, { headless: libProbeSource(createSemanticSurface()) })
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
    const graded = await regradeRow(probe, row, { headless: libProbeSource(createSemanticSurface()) })
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
      headless: libProbeSource(createSemanticSurface({ mutations: ["el-noop"] })),
    })
    expect(graded.after, `${id} detects an inert EL`).toBe("unsupported")
  }
})

/**
 * Per-probe two-sided controls across all 11 Erase rows (#32176):
 * each row has a distinct named mutation on `createSemanticSurface()` that suppresses its target
 * erase behavior while preserving its setup/cursor witness, proving the probe grades `supported` on
 * `createSemanticSurface()`, `unsupported` when its mutation is active, and never `supported` on
 * `inertLibProbeSource()`.
 */
const ERASE_SEMANTIC_SURFACE_CONTROLS: ReadonlyArray<readonly [id: string, mutation: string]> = [
  ["erase.line.right", "el0-noop"],
  ["erase.line.left", "el1-noop"],
  ["erase.line.all", "el2-noop"],
  ["erase.screen.below", "ed0-noop"],
  ["erase.screen.above", "ed1-noop"],
  ["erase.screen.all", "ed2-noop"],
  ["erase.screen.scrollback", "ed3-noop"],
  ["erase.character", "ech-noop"],
  ["erase.selective", "decsca-noop"],
  ["erase.el-with-attrs", "el-default-bg"],
  ["erase.ed-scroll-region", "ed-scroll-region-noop"],
]

test("ERASE_SEMANTIC_SURFACE_CONTROLS covers all 11 Erase contract rows with distinct mutations", () => {
  expect(ERASE_SEMANTIC_SURFACE_CONTROLS).toHaveLength(11)
  expect(ERASE_SEMANTIC_SURFACE_CONTROLS.map(([id]) => id).sort()).toEqual(ERASE_CONTRACT.map((row) => row.id).sort())
  expect(new Set(ERASE_SEMANTIC_SURFACE_CONTROLS.map(([, mutation]) => mutation)).size).toBe(11)
})

test.each(ERASE_SEMANTIC_SURFACE_CONTROLS)(
  "%s never reads supported on inertLibProbeSource, reads supported on createSemanticSurface, and reads unsupported when %s is active",
  async (id, mutation) => {
    const row = ERASE_CONTRACT.find((entry) => entry.id === id)
    const probe = eraseProbes.find((entry) => entry.id === id)
    expect(row, `the Erase contract names ${id}`).toBeDefined()
    expect(probe, `the Erase contract names a real ${id} probe`).toBeDefined()
    if (!row || !probe || !probe.lib) return

    const inertResult = probe.lib(inertLibProbeSource())
    expect(inertResult.pass).toBe(false)
    expect(inertResult.observation?.outcome).not.toBe("supported")
    const inertGraded = await regradeRow(probe, row, { headless: inertLibProbeSource() })
    expect(inertGraded.after).not.toBe("supported")

    const positiveResult = probe.lib(libProbeSource(createSemanticSurface()))
    expect(positiveResult.pass).toBe(true)
    expect(positiveResult.observation?.outcome).toBe("supported")
    expect(positiveResult.assertions ?? []).toContainEqual(expect.objectContaining({ kind: "positive" }))
    const positiveGraded = await regradeRow(probe, row, { headless: libProbeSource(createSemanticSurface()) })
    expect(positiveGraded.after).toBe("supported")
    expect(positiveGraded.satisfies).toBe(true)

    const negativeResult = probe.lib(libProbeSource(createSemanticSurface({ mutations: [mutation] })))
    expect(negativeResult.pass).toBe(false)
    expect(negativeResult.observation?.outcome).toBe("unsupported")
    expect(negativeResult.assertions ?? []).toContainEqual(expect.objectContaining({ kind: "negative" }))
    const negativeGraded = await regradeRow(probe, row, {
      headless: libProbeSource(createSemanticSurface({ mutations: [mutation] })),
    })
    expect(negativeGraded.after).toBe("unsupported")
    expect(negativeGraded.satisfies).toBe(true)
  },
)
