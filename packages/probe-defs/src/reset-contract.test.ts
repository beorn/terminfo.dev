/**
 * @failure A Reset feature is graded without a bound contract row, or a re-grade of a decided
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
  inertLibProbeSource,
  libProbeSource,
  missingContractTests,
  regradeCommand,
  regradeRow,
  replayTermProbeSource,
  satisfiesContract,
  type StoredQuery,
  type GroupContract,
  type GroupContractSpec,
} from "./testing/group-harness.ts"
import { createSemanticSurface } from "./testing/semantic-surface.ts"
import { recordExecutedProbe } from "./helpers.ts"
import { parseProbeResults } from "@terminfo/run-parser"

// Ask 3: absent/Ps0 mode replies cannot block DECSTR's same-run input effect.
// The real semantic parser changes DECCKM; only its Up encoder is supplied by the owned input fixture.
test.each([null, 0] as const)("App soft reset reads its controlled input effect after DECRPM %s", async (ps) => {
  const definition = resetProbes.find((entry) => entry.id === "reset.soft")
  if (!definition?.term) throw new Error("Missing App soft-reset callback")
  const stored = new Map<string, StoredQuery>()
  if (ps === 0) {
    stored.set("\x1b[?1$p", { sequence: "\x1b[?1$p", match: null, reason: "reply", raw: "\x1b[?1;0$y" })
  }
  for (const mutation of [undefined, "decstr-noop", "decckm-noop", "missing-up"] as const) {
    const surface = createSemanticSurface({ mutations: mutation && mutation !== "missing-up" ? [mutation] : [] })
    let bytes = ""
    const source = replayTermProbeSource(stored, {
      write: (text) => surface.feed(text),
      input: {
        injectClick: async () => {
          throw new Error("Soft reset fixture received a click")
        },
        injectKey: async (key) => {
          if (key === "a") bytes += "a"
          else if (key === "Up") {
            if (mutation !== "missing-up") bytes += surface.getMode("applicationCursor") === true ? "\x1bOA" : "\x1b[A"
          } else throw new Error(`Soft-reset fixture received ${key}`)
        },
      },
      readInput: async (pattern, _timeout, inject) => {
        bytes = ""
        await inject?.()
        return pattern.exec(bytes)
      },
    })
    const result = await definition.term(source)
    const feature = definition.id
    const assertions = (result.assertions ?? []).map((assertion) => ({
      featureId: feature,
      ...assertion,
      rawReplyRef: feature,
    }))
    const recorded = recordExecutedProbe({
      featureId: feature,
      attempt: { scope: "probe", startedAt: new Date().toISOString() },
      rawReplyRef: feature,
      tests: result.tests,
      observation: result.observation ? { featureId: feature, ...result.observation, rawReplyRef: feature } : undefined,
      assertions,
    })
    expect(recorded.status, mutation ?? "working DECSTR").toBe(
      mutation === "decstr-noop" ? "unsupported" : mutation ? "probe-invalid" : "supported",
    )
    // Callback outcomes alone missed input assertions that the native run reader refuses.
    // Keep the producer's performed actions; this fixture must not supply missing evidence.
    if (!mutation || mutation === "decstr-noop") {
      expect(
        parseProbeResults(
          [recorded],
          "soft-reset-effect.json",
          new Set([feature]),
          { [feature]: result.response! },
          assertions,
        )[0]?.status,
      ).toBe(recorded.status)
    }
    if (ps === 0 && !mutation) expect(result.note).toContain("Ps 0")
    expect(surface.getMode("applicationCursor")).toBe(false)
  }
  const missing = await definition.term(replayTermProbeSource(stored))
  expect(missing.tests).toEqual(expect.arrayContaining([expect.objectContaining({ status: "probe-invalid" })]))
  expect(definition.termNeedsDisposable).toBe(true)
})

const RESET_SEMANTIC_SURFACE_CONTROLS: readonly {
  readonly id: string
  readonly mutation: string
  readonly inertOutcome: "inconclusive" | "unsupported"
}[] = [
  { id: "reset.sgr", mutation: "sgr0-noop", inertOutcome: "inconclusive" },
  { id: "reset.ris", mutation: "ris-noop", inertOutcome: "inconclusive" },
  { id: "reset.soft", mutation: "decstr-noop", inertOutcome: "inconclusive" },
  { id: "reset.decaln", mutation: "decaln-noop", inertOutcome: "unsupported" },
  { id: "reset.method", mutation: "reset-method-noop", inertOutcome: "inconclusive" },
]

/** The 5 Reset features of 28018's Reset row; ids drawn from reset.ts, claims are the contract. */
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

test("the Reset contract covers every reset feature and names none unknown", () => {
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
test("the harness replays every reset feature deterministically", async () => {
  for (const row of RESET_CONTRACT) {
    const probe = resetProbes.find((entry) => entry.id === row.id)
    expect(probe, `missing reset probe ${row.id}`).toBeDefined()
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
// implements the reset its claim names - SGR attributes and their reset, RIS, DECSTR over a real
// application-cursor mode, DECALN's alignment fill, and the reset method. A probe whose own
// expectation disagrees with the terminal cannot pass this test.
test("every reset contract row reads supported against a surface that implements its claim", async () => {
  for (const row of RESET_CONTRACT) {
    const probe = resetProbes.find((entry) => entry.id === row.id)
    expect(probe, `missing reset probe ${row.id}`).toBeDefined()
    if (!probe) continue
    const graded = await regradeRow(probe, row, { headless: libProbeSource(createSemanticSurface()) })
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
    headless: libProbeSource(createSemanticSurface({ mutations: ["ris-noop"] })),
  })
  expect(graded.after, "reset.ris detects an inert RIS").toBe("unsupported")
})

test("the Reset two-sided control table covers every reset contract row", () => {
  expect(RESET_SEMANTIC_SURFACE_CONTROLS.map((entry) => entry.id)).toEqual(RESET_CONTRACT.map((entry) => entry.id))
})

test.each(RESET_SEMANTIC_SURFACE_CONTROLS)(
  "reset two-sided control for $id: inert reads $inertOutcome, semantic surface reads supported, and $mutation reads unsupported",
  async ({ id, mutation, inertOutcome }) => {
    const row = RESET_CONTRACT.find((entry) => entry.id === id)
    const probe = resetProbes.find((entry) => entry.id === id)
    expect(row, `missing Reset contract row ${id}`).toBeDefined()
    expect(probe, `missing Reset probe ${id}`).toBeDefined()
    if (!row || !probe) return

    const inert = await regradeRow(probe, row, { headless: inertLibProbeSource() })
    expect(inert.after, `${id} must not read supported against inertLibProbeSource()`).toBe(inertOutcome)

    const positive = await regradeRow(probe, row, { headless: libProbeSource(createSemanticSurface()) })
    expect(positive.after, `${id} must read supported against createSemanticSurface()`).toBe("supported")
    expect(positive.satisfies, `${id} must satisfy its contract row on createSemanticSurface()`).toBe(true)

    const mutated = await regradeRow(probe, row, {
      headless: libProbeSource(createSemanticSurface({ mutations: [mutation] })),
    })
    expect(mutated.after, `${id} must read unsupported when ${mutation} is active`).toBe("unsupported")
    expect(mutated.satisfies, `${id} remains decided under ${mutation}`).toBe(true)
  },
)
