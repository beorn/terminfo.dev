/**
 * @failure A Device feature is graded without a bound contract row, or a re-grade of a decided
 *   observation moves it - so a group step reinvents its own fixture and silently drifts.
 * @level l2
 * @consumer 28450 slice B Device group (19 definitions); 28453 harness. Outside Candidate-2 denominator 125.
 * @reach fs-walk vendor/terminfo.dev/packages/probe-defs/src/device-contract.test.ts vendor/terminfo.dev/packages/probe-defs/src/device-observations.test.ts vendor/terminfo.dev/packages/probe-defs/src/testing/semantic-surface.ts
 * @testonly none
 */
import { expect, test } from "vitest"
import { join } from "node:path"
import { deviceProbes } from "./device.ts"
import {
  contractGaps,
  inertLibProbeSource,
  libProbeSource,
  missingContractTests,
  regradeCommand,
  regradeRow,
  replayTermProbeSource,
  satisfiesContract,
  type GroupContract,
  type GroupContractSpec,
  type HeadlessModel,
} from "./testing/group-harness.ts"
import { createSemanticSurface } from "./testing/semantic-surface.ts"

/** The 19 Device features of 28450 slice B; ids drawn from device.ts, claims are the contract. */
const DEVICE_CONTRACT: GroupContract = [
  { id: "device.primary-da", expected: "decided", claim: "DA1 CSI c returns complete CSI ? numeric attributes c" },
  { id: "device.status-report", expected: "decided", claim: "DSR 5 returns status 0 (ready) or 3 (malfunction)" },
  { id: "device.secondary-da", expected: "decided", claim: "DA2 CSI >c returns three numeric fields c" },
  {
    id: "device.tertiary-da",
    expected: "decided",
    claim: "DECRPTUI DCS !| returns four hexadecimal pairs and ST",
  },
  { id: "device.decrqss", expected: "decided", claim: "DECRQSS SGR returns status 1 parameters ending m and ST" },
  {
    id: "device.xtgettcap",
    expected: "decided",
    claim: "XTGETTCAP status 1 for TN returns an even-length hex value and ST",
  },
  { id: "device.decrpm", expected: "decided", claim: "DECRPM for DECAWM mode 7 returns recognized state 1–4" },
  { id: "device.xtversion", expected: "decided", claim: "XTVERSION DCS >| returns a printable name/version and ST" },
  {
    id: "device.term-features",
    expected: "inconclusive",
    claim: "TERM_FEATURES is inherited process environment and does not authenticate the current terminal",
  },
  {
    id: "device.dsr-996-color-scheme",
    expected: "decided",
    claim: "DSR ?996 yields complete DSR ?997;1n or ?997;2n",
  },
  {
    id: "device.xtwinops-14",
    expected: "decided",
    claim: "CSI 14 t reports text-area pixels as CSI 4;positive-height;positive-width t",
  },
  {
    id: "device.xtwinops-16",
    expected: "decided",
    claim: "CSI 16 t returns a complete CSI 6;positive-height;positive-width t frame",
  },
  {
    id: "device.xtwinops-18",
    expected: "decided",
    claim: "CSI 18 t returns a complete CSI 8;positive-rows;positive-columns t frame",
  },
  {
    id: "device.xtwinops-20",
    expected: "decided",
    claim: "OSC 1 + CSI 20 t round trip returns the exact icon label",
  },
  {
    id: "device.xtwinops-21",
    expected: "decided",
    claim: "CSI 21 t returns the exact window title set by OSC 2",
  },
  {
    id: "device.xtwinops-22",
    expected: "decided",
    claim: "XTWINOPS 22 preserves the old title on its stack after a different title is set",
  },
  {
    id: "device.xtwinops-23",
    expected: "decided",
    claim: "XTWINOPS 23 restores the title saved before a different title was set",
  },
  {
    id: "device.xtreportcolors",
    expected: "decided",
    claim: "CSI # R reports palette-stack entry and stored count as CSI [optional ?] entry;count # Q",
  },
  {
    id: "device.xtgetxres",
    expected: "decided",
    claim: "XTGETXRES returns a complete status-1 termName resource value",
  },
]

const DEVICE_CONTRACT_SPEC: GroupContractSpec = {
  group: "device",
  rows: DEVICE_CONTRACT,
  tests: ["packages/probe-defs/src/device-contract.test.ts", "packages/probe-defs/src/device-observations.test.ts"],
}

function deviceSources(model: HeadlessModel = createSemanticSurface()) {
  return { headless: libProbeSource(model), term: replayTermProbeSource(new Map()) }
}

const DEVICE_SEMANTIC_SURFACE_CONTROLS: readonly (readonly [
  id: string,
  mutation: string,
  negativeOutcome: "unsupported" | "inconclusive" | "not-tested",
])[] = [
  ["device.primary-da", "primary-da-noop", "inconclusive"],
  ["device.status-report", "status-report-noop", "unsupported"],
  ["device.secondary-da", "secondary-da-noop", "unsupported"],
  ["device.tertiary-da", "tertiary-da-noop", "unsupported"],
  ["device.decrqss", "decrqss-noop", "unsupported"],
  ["device.xtgettcap", "xtgettcap-noop", "unsupported"],
  ["device.decrpm", "decrpm-noop", "unsupported"],
  ["device.xtversion", "xtversion-noop", "unsupported"],
  ["device.dsr-996-color-scheme", "dsr-996-noop", "unsupported"],
  ["device.xtwinops-14", "xtwinops-14-noop", "unsupported"],
  ["device.xtwinops-16", "xtwinops-16-noop", "unsupported"],
  ["device.xtwinops-18", "xtwinops-18-noop", "unsupported"],
  ["device.xtwinops-20", "xtwinops-20-noop", "unsupported"],
  ["device.xtwinops-21", "xtwinops-21-noop", "unsupported"],
  // #32323: controlled round-trip non-restoration is negative for both IDs, without identifying the missing primitive.
  ["device.xtwinops-22", "xtwinops-22-noop", "unsupported"],
  ["device.xtwinops-23", "xtwinops-23-noop", "unsupported"],
  ["device.xtreportcolors", "xtreportcolors-noop", "unsupported"],
  ["device.xtgetxres", "xtgetxres-noop", "unsupported"],
]

test("the Device contract covers every Device feature and names none unknown", () => {
  const gaps = contractGaps(deviceProbes, DEVICE_CONTRACT)
  expect(gaps.uncovered).toEqual([])
  expect(gaps.unknown).toEqual([])
  expect(gaps.misdeclared).toEqual([])
  expect(deviceProbes).toHaveLength(19)
  expect(DEVICE_CONTRACT).toHaveLength(19)
})

test("the Device contract names its focused tests, and every named file exists", () => {
  const root = join(import.meta.dirname, "../../..")
  expect(missingContractTests(DEVICE_CONTRACT_SPEC, root)).toEqual([])
  const command = regradeCommand(DEVICE_CONTRACT_SPEC)
  expect(command).toContain("bunx --bun vitest run")
  expect(command).not.toContain("bun test")
  expect(command).not.toMatch(/[*?]/u)
  for (const path of DEVICE_CONTRACT_SPEC.tests) expect(command).toContain(path)
})

test("the harness replays every Device feature deterministically through the semantic surface", async () => {
  for (const row of DEVICE_CONTRACT) {
    const probe = deviceProbes.find((entry) => entry.id === row.id)
    expect(probe, `missing Device probe ${row.id}`).toBeDefined()
    if (!probe) continue
    expect(probe.lib !== null || probe.term !== null, `${row.id} has no callback`).toBe(true)
    const first = await regradeRow(probe, row, deviceSources())
    const second = await regradeRow(probe, row, deviceSources())
    expect(second.after, `${row.id} is not deterministic`).toBe(first.after)
    expect(second.satisfies, `${row.id} satisfaction is not deterministic`).toBe(first.satisfies)
    expect(first.satisfies, `${row.id} must route through satisfiesContract`).toBe(satisfiesContract(row, first.after))
  }
})

test("every measurable Device contract row is satisfied by the semantic surface its claim requires", async () => {
  for (const row of DEVICE_CONTRACT) {
    const probe = deviceProbes.find((entry) => entry.id === row.id)
    expect(probe, `missing Device probe ${row.id}`).toBeDefined()
    if (!probe) continue
    if (row.id === "device.term-features") continue
    const graded = await regradeRow(probe, row, deviceSources())
    expect(graded.after, `${row.id} reads supported from the semantic surface`).toBe("supported")
    expect(graded.satisfies, `${row.id} satisfies its contract row (after=${graded.after})`).toBe(true)
  }
})

test("DEVICE_SEMANTIC_SURFACE_CONTROLS covers all 18 measurable Device contract rows with distinct mutations", () => {
  expect(DEVICE_SEMANTIC_SURFACE_CONTROLS).toHaveLength(18)
  expect(DEVICE_SEMANTIC_SURFACE_CONTROLS.map(([id]) => id).sort()).toEqual(
    DEVICE_CONTRACT.filter((row) => row.id !== "device.term-features")
      .map((row) => row.id)
      .sort(),
  )
  expect(new Set(DEVICE_SEMANTIC_SURFACE_CONTROLS.map(([, mutation]) => mutation)).size).toBe(18)
})

test.each(DEVICE_SEMANTIC_SURFACE_CONTROLS)(
  "%s never reads supported on inertLibProbeSource, reads supported on createSemanticSurface, and when %s is active reads %s",
  async (id, mutation, negativeOutcome) => {
    const row = DEVICE_CONTRACT.find((entry) => entry.id === id)
    const probe = deviceProbes.find((entry) => entry.id === id)
    expect(row, `the Device contract names ${id}`).toBeDefined()
    expect(probe, `the Device contract names a real ${id} probe`).toBeDefined()
    if (!row || !probe || !probe.lib) return

    const inertResult = probe.lib(inertLibProbeSource())
    expect(inertResult.pass).toBe(false)
    expect(inertResult.observation?.outcome).not.toBe("supported")
    const inertGraded = await regradeRow(probe, row, { headless: inertLibProbeSource() })
    expect(inertGraded.satisfies).toBe(false)

    const positiveResult = probe.lib(libProbeSource(createSemanticSurface()))
    expect(positiveResult.pass).toBe(true)
    expect(positiveResult.observation?.outcome).toBe("supported")
    expect(positiveResult.assertions ?? []).toContainEqual(expect.objectContaining({ kind: "positive" }))
    const positiveGraded = await regradeRow(probe, row, { headless: libProbeSource(createSemanticSurface()) })
    expect(positiveGraded.after).toBe("supported")
    expect(positiveGraded.satisfies).toBe(true)

    const negativeResult = probe.lib(libProbeSource(createSemanticSurface({ mutations: [mutation] })))
    expect(negativeResult.pass).toBe(false)
    if (negativeOutcome === "not-tested") {
      expect(negativeResult.observation).toBeUndefined()
      expect(negativeResult.notTested).toEqual({
        reason: "no-semantic-observable",
        noObservable: "Open: our test has no control for this feature in this run, so the observations do not decide the result.",
      })
      expect(negativeResult.criterionBranch).toBeUndefined()
    } else expect(negativeResult.observation?.outcome).toBe(negativeOutcome)
    if (negativeOutcome === "unsupported") {
      expect(negativeResult.assertions ?? []).toContainEqual(expect.objectContaining({ kind: "negative" }))
    }
    const negativeGraded = await regradeRow(probe, row, {
      headless: libProbeSource(createSemanticSurface({ mutations: [mutation] })),
    })
    expect(negativeGraded.after).toBe(negativeOutcome === "not-tested" ? undefined : negativeOutcome)
    expect(negativeGraded.satisfies).toBe(negativeOutcome === "unsupported")
  },
)

test("TERM_FEATURES stays not-tested for both parent environment values", async () => {
  const probe = deviceProbes.find((entry) => entry.id === "device.term-features")
  expect(probe?.lib, "the TERM_FEATURES library callback exists").toBeDefined()
  expect(probe?.term, "the TERM_FEATURES application callback exists").toBeDefined()
  if (!probe?.lib || !probe?.term) return
  for (const source of [libProbeSource(createSemanticSurface()), inertLibProbeSource()]) {
    const libResult = probe.lib(source)
    expect(libResult.pass).toBe(false)
    expect(libResult.observation).toBeUndefined()
    expect(libResult.notTested?.reason).toBe("no-semantic-observable")
  }
  const prior = process.env.TERM_FEATURES
  const secret = "sensitive-arbitrary-environment-value"
  try {
    const results = []
    for (const value of [undefined, secret] as const) {
      if (value === undefined) delete process.env.TERM_FEATURES
      else process.env.TERM_FEATURES = value
      const result = await probe.term(deviceSources().term)
      results.push(result)
      expect(result.notTested).toEqual({
        reason: "no-semantic-observable",
        noObservable: "terminal child environment",
      })
      expect(result.observation).toBeUndefined()
      expect(result.tests).toBeUndefined()
      expect(JSON.stringify(result)).not.toContain(secret)
    }
    expect(results[0]).toEqual(results[1])
  } finally {
    if (prior === undefined) delete process.env.TERM_FEATURES
    else process.env.TERM_FEATURES = prior
  }
})

test("a decided Device row is unsatisfied when the query reply is silent or malformed", async () => {
  const row = DEVICE_CONTRACT.find((entry) => entry.id === "device.primary-da")
  const probe = deviceProbes.find((entry) => entry.id === "device.primary-da")
  expect(row, "the Device contract names device.primary-da").toBeDefined()
  expect(probe, "the Device contract names a real device.primary-da probe").toBeDefined()
  if (!row || !probe) return
  const silent = await regradeRow(probe, row, { headless: inertLibProbeSource() })
  expect(silent.after).toBeUndefined()
  expect(silent.satisfies).toBe(false)
  const malformed = await regradeRow(probe, row, {
    headless: libProbeSource(createSemanticSurface({ mutations: ["primary-da-noop"] })),
  })
  expect(malformed.after).toBe("inconclusive")
  expect(malformed.satisfies).toBe(false)
})
