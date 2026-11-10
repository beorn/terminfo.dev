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
import { decodeCollectorDraft, parseRun } from "@terminfo/run-parser"
import { initializeRunDraft, recordExecutedProbe } from "./helpers.ts"
import { scrollbackProbes } from "./scrollback.ts"
import type { ProbeSuiteManifest } from "./types.ts"
import {
  contractGaps,
  replayTermProbeSource,
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
 * uses its owned wheel/pixel controls only when its job supplies a justified movement bound.
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

test("viewport hold declares its measured library and disposable app pixel routes", () => {
  const viewport = scrollbackProbes.find((entry) => entry.id === "scrollback.viewport-hold-output")
  expect(viewport?.term).toBeTypeOf("function")
  expect(viewport?.lib).toBeTypeOf("function")
  expect(viewport?.termAssertionType).toBe("screenshot")
  expect(viewport?.termNeedsGeometry).toBe(true)
  expect(viewport?.termNeedsDisposable).toBe(true)
  expect(viewport?.wallMs).toBe(180_000)
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

// @failure App count-only readers are ignored, invented fields become required, or failed controls grade support.
// Library-only controls cannot execute the App callback; reuse the same semantic engine at that boundary.
// @level l1
// @consumer Owned App history results (31744).
test.each(["count", "count+screen", "tmux"] as const)(
  "App history accepts %s and refuses inert counts",
  async (shape) => {
    for (const id of ["scrollback.accumulate", "scrollback.total-lines"]) {
      for (const mutations of [[], ["total-lines-noop"]]) {
        const surface = createSemanticSurface({ rows: 12, cols: 80, mutations })
        const library = libProbeSource(surface)
        const ctx = replayTermProbeSource(new Map(), {
          rows: 12,
          cols: 80,
          write: (bytes) => surface.feed(bytes),
          queryCursorPosition: async () => ({ row: 1, col: 1 }),
          getScrollback: async () => {
            const reading = library.getScrollback()
            return {
              totalLines: reading.totalLines,
              ...(shape !== "count" && { screenLines: reading.screenLines }),
              ...(shape === "tmux" && { viewportOffset: reading.viewportOffset }),
            }
          },
        })
        const definition = scrollbackProbes.find((probe) => probe.id === id)!
        const result = await definition.term!(ctx)
        if (mutations.length === 0) {
          expect(result.observation?.outcome).toBe("supported")
          expect(result.assertions?.[0]?.kind).toBe("positive")
          expect(result.response).toContain("rows from run geometry")
        } else {
          expect(result.pass).toBe(false)
          expect(result.notTested?.noObservable).toContain("retained history count did not change")
          expect(result.assertions).toBeUndefined()
        }
        const failure = new Error("same-session history command refused")
        ctx.getScrollback = async () => {
          throw failure
        }
        await expect(definition.term!(ctx)).rejects.toBe(failure)
      }
    }
  },
)

// @failure A mismatched real screen or a reader counting painted content passes the no-overflow control.
// @level l1
// @consumer Count-only App history qualification (CTO 3c344547).
test.each(["smaller-screen", "visible-content"] as const)("App history refuses %s counts", async (fault) => {
  const surface = createSemanticSurface({ rows: fault === "smaller-screen" ? 6 : 12, cols: 80 })
  const library = libProbeSource(surface)
  let writtenLines = 0
  const ctx = replayTermProbeSource(new Map(), {
    rows: 12,
    cols: 80,
    write: (bytes) => {
      surface.feed(bytes)
      writtenLines += bytes.split("\n").length - 1
    },
    queryCursorPosition: async () => ({ row: 1, col: 1 }),
    getScrollback: async () => ({
      totalLines: fault === "visible-content" ? writtenLines : library.getScrollback().totalLines,
    }),
  })
  for (const id of ["scrollback.accumulate", "scrollback.total-lines"]) {
    const result = await scrollbackProbes.find((probe) => probe.id === id)!.term!(ctx)
    expect(result.pass).toBe(false)
    expect(result.notTested?.noObservable).toContain("no-overflow output changed")
    expect(result.assertions).toBeUndefined()
  }
})

// @failure A full fixed-capacity scrollback buffer (e.g. Screen at capacity before total-lines runs)
//   fails the overflow growth check as a generic 'no same-path control' instead of naming the capacity
//   precondition, or an unknown-capacity reader changes behavior (#32787, CTO 266c9b62).
// @level l1
// @consumer App history capacity precondition in appHistory (32787).
test("App history enforces capacity precondition for full, room, and unknown capacity (#32787)", async () => {
  const rows = 20
  const capacity = 100
  const runProbe = async (
    id: "scrollback.accumulate" | "scrollback.total-lines",
    baselineHistory: number,
    reportedCapacity: number | undefined,
  ) => {
    let stage = 0
    const writes: string[] = []
    const ctx = replayTermProbeSource(new Map(), {
      rows,
      cols: 80,
      write: (bytes) => {
        writes.push(bytes)
      },
      queryCursorPosition: async () => ({ row: 1, col: 1 }),
      getScrollback: async () => {
        stage += 1
        const requiredGrowth = id === "scrollback.total-lines" ? 10 : 1
        const grownHistory =
          reportedCapacity !== undefined
            ? Math.min(reportedCapacity, baselineHistory + requiredGrowth)
            : baselineHistory + requiredGrowth
        const history = stage < 3 ? baselineHistory : grownHistory
        return {
          totalLines: history + rows,
          screenLines: rows,
          ...(reportedCapacity !== undefined && { capacity: reportedCapacity }),
        }
      },
    })
    const definition = scrollbackProbes.find((probe) => probe.id === id)!
    const result = await definition.term!(ctx)
    return { result, stage, writes }
  }

  // (1) full: baseline history + required growth > capacity -> named not-tested before control/overflow writes.
  for (const [id, baselineHistory, required] of [
    ["scrollback.total-lines", 100, 10],
    ["scrollback.total-lines", 91, 10],
    ["scrollback.accumulate", 100, 1],
  ] as const) {
    const { result, stage, writes } = await runProbe(id, baselineHistory, capacity)
    expect(result.pass, `${id} history=${baselineHistory}`).toBe(false)
    expect(result.observation, `${id} history=${baselineHistory}`).toBeUndefined()
    expect(result.notTested, `${id} history=${baselineHistory}`).toEqual({
      reason: "no-semantic-observable",
      noObservable: `history at ${baselineHistory} of capacity ${capacity} before the test; growth of ${required} cannot be observed`,
    })
    expect(stage, `${id} stops after baseline read`).toBe(1)
    expect(writes, `${id} writes only baseline clear`).toEqual(["\x1b[0m\x1b[2J\x1b[H"])
  }

  // (2) room: baseline history + required growth <= capacity -> proceeds and decides supported.
  for (const [id, baselineHistory] of [
    ["scrollback.total-lines", 90],
    ["scrollback.accumulate", 99],
  ] as const) {
    const { result, stage } = await runProbe(id, baselineHistory, capacity)
    expect(result.pass, `${id} history=${baselineHistory}`).toBe(true)
    expect(result.observation?.outcome, `${id} history=${baselineHistory}`).toBe("supported")
    expect(stage, `${id} reads baseline, control, and overflow`).toBe(3)
  }

  // (3) unknown capacity: behavior unchanged even when baseline history is 100.
  for (const id of ["scrollback.total-lines", "scrollback.accumulate"] as const) {
    const { result, stage } = await runProbe(id, 100, undefined)
    expect(result.pass, `${id} unknown capacity`).toBe(true)
    expect(result.observation?.outcome, `${id} unknown capacity`).toBe("supported")
    expect(stage, `${id} unknown capacity reads all 3 stages`).toBe(3)
  }
})

// @failure App history resets before the clear+CPR fence (so ED2 re-populates history), fabricates a
//   verdict when resetScrollback leaves history full, changes behavior when resetScrollback is absent,
//   or produces evidence that parseRun rejects (#32801, CTO 85113817 / c901817a).
// @level l1
// @consumer Screen mux owned-window history reset in appHistory (32801).
test("App history resets owned history after clear+CPR fence before baseline read, preserves full-history refusal, and round-trips through parseRun (#32801)", async () => {
  const rows = 24
  const capacity = 1000
  const featureIds = ["scrollback.accumulate", "scrollback.total-lines"] as const

  const runScenario = async (
    id: (typeof featureIds)[number],
    mode: "empties" | "absent" | "noop-partial" | "still-full" | "cpr-timeout",
  ) => {
    let history = mode === "noop-partial" ? 7 : 1000
    let cprCount = 0
    let readStage = 0
    const order: string[] = []
    const writes: string[] = []
    const ctx = replayTermProbeSource(new Map(), {
      rows,
      cols: 80,
      mux: "screen",
      write: (bytes) => {
        writes.push(bytes)
        order.push(`write:${JSON.stringify(bytes)}`)
      },
      queryCursorPosition: async () => {
        cprCount += 1
        order.push(`queryCursorPosition:${cprCount}`)
        if (mode === "cpr-timeout" && cprCount === 1) return null
        return { row: 1, col: 1 }
      },
      ...(mode !== "absent" && {
        resetScrollback: async () => {
          order.push("resetScrollback")
          if (mode === "empties") history = 0
          return { status: "reset" as const, capacity }
        },
      }),
      getScrollback: async () => {
        readStage += 1
        order.push(`getScrollback:${readStage}`)
        const current = readStage < 3 ? history : Math.min(capacity, history + 11)
        return {
          totalLines: current + rows,
          screenLines: rows,
          capacity,
        }
      },
    })
    const definition = scrollbackProbes.find((probe) => probe.id === id)!
    const result = await definition.term!(ctx)
    return { result, readStage, order, writes }
  }

  const sourceRevision = "b".repeat(40)
  const measuredAt = "2026-11-09T19:20:00.000Z"

  for (const id of featureIds) {
    const required = id === "scrollback.total-lines" ? 10 : 1

    // (a) Hook present & emptying -> decided supported, exact call order clear -> fence -> reset -> baseline, and parseRun round-trip.
    const decided = await runScenario(id, "empties")
    expect(decided.result.pass, `${id} empties`).toBe(true)
    expect(decided.result.observation?.outcome, `${id} empties`).toBe("supported")
    expect(decided.readStage, `${id} empties reads 3 stages`).toBe(3)
    expect(decided.order.slice(0, 4), `${id} call order before baseline`).toEqual([
      'write:"\\u001b[0m\\u001b[2J\\u001b[H"',
      "queryCursorPosition:1",
      "resetScrollback",
      "getScrollback:1",
    ])
    expect(
      decided.order.filter((step) => step === "resetScrollback"),
      `${id} resets once per probe`,
    ).toHaveLength(1)

    const manifest: ProbeSuiteManifest & { schemaVersion: 4 } = {
      schemaVersion: 4,
      probeHash: "32801abcdef0",
      sourceRevision,
      generatedAt: measuredAt,
      adapterVersion: "test",
      catalogIds: [id],
      probes: { term: [], lib: [], mux: [id] },
    }
    const assertions = (decided.result.assertions ?? []).map((entry) => ({
      featureId: id,
      rawReplyRef: id,
      ...entry,
    }))
    const observation = decided.result.observation
      ? { featureId: id, rawReplyRef: id, ...decided.result.observation }
      : undefined
    const recorded = recordExecutedProbe({
      featureId: id,
      attempt: { scope: "probe", startedAt: measuredAt },
      rawReplyRef: id,
      observation,
      assertions,
    })
    const initialized = initializeRunDraft({
      source: { kind: "live" },
      runId: "fedcba0987654321fedcba0987654321",
      sourceRevision,
      manifest,
      intendedSubject: { kind: "mux", id: "screen", version: "5.0.2" },
    })
    const draft = {
      ...initialized,
      subject: {
        kind: "mux" as const,
        id: "screen",
        version: "5.0.2",
        os: "linux" as const,
        osVersion: null,
        outerTerminal: "kitty",
        mux: null,
        config: null,
        permissions: null,
      },
      identity: "unverified" as const,
      measuredAt,
      origin: { kind: "collector" as const },
      rawReplies: {
        [id]: JSON.stringify({ writes: decided.writes, queries: [], events: [] }),
        ...(decided.result.response !== undefined ? { [`${id}.callbackResponse`]: decided.result.response } : {}),
      },
      assertions,
      results: initialized.results.map((entry) => (entry.featureId === id ? recorded : entry)),
      screenshotRefs: [],
    }
    const decoded = decodeCollectorDraft(`${id}-reset.json`, JSON.stringify(draft), manifest, sourceRevision)
    const parsed = parseRun(
      `${id}-reset.json`,
      JSON.stringify({ ...draft, sealedAt: "2026-11-09T19:21:00.000Z" }),
      [id],
      new Map([[manifest.probeHash, manifest]]),
    )
    expect(decoded.run.results?.[0]?.status, `${id} decodeCollectorDraft`).toBe("supported")
    expect(parsed.results?.[0]?.status, `${id} parseRun`).toBe("supported")
    expect(JSON.parse(parsed.assertions?.[0]?.observed ?? "null"), `${id} parsed evidence`).toMatchObject({
      historyReset: { status: "reset", capacity: 1000 },
      baseline: { totalLines: 24, screenLines: 24, capacity: 1000 },
      control: { totalLines: 24, screenLines: 24, capacity: 1000 },
      scroll: { totalLines: 35, screenLines: 24, capacity: 1000 },
      rows: 24,
      geometrySource: "rows from run geometry",
    })

    // (b) Hook absent with full history -> exact existing refusal.
    const absent = await runScenario(id, "absent")
    expect(absent.result.pass, `${id} absent`).toBe(false)
    expect(absent.result.observation, `${id} absent`).toBeUndefined()
    expect(absent.result.notTested, `${id} absent`).toEqual({
      reason: "no-semantic-observable",
      noObservable: `history at 1000 of capacity 1000 before the test; growth of ${required} cannot be observed`,
    })
    expect(absent.readStage, `${id} absent stops after baseline`).toBe(1)

    // (c) Hook present but reset is a no-op (partial 7 lines or full 1000 lines) -> fails loudly with "owned history reset left N lines" and records historyReset.
    for (const [noopMode, leftover] of [
      ["noop-partial", 7],
      ["still-full", 1000],
    ] as const) {
      const noop = await runScenario(id, noopMode)
      expect(noop.result.pass, `${id} ${noopMode}`).toBe(false)
      expect(noop.result.observation, `${id} ${noopMode}`).toBeUndefined()
      expect(noop.result.notTested, `${id} ${noopMode}`).toEqual({
        reason: "no-semantic-observable",
        noObservable: `owned history reset left ${leftover} lines`,
      })
      expect(JSON.parse(noop.result.response ?? "null"), `${id} ${noopMode} evidence`).toMatchObject({
        historyReset: { status: "reset", capacity: 1000 },
        baseline: { totalLines: 24 + leftover, screenLines: 24, capacity: 1000 },
        history: leftover,
        rows: 24,
      })
      expect(noop.readStage, `${id} ${noopMode} stops after baseline`).toBe(1)
      expect(noop.order, `${id} ${noopMode} order`).toEqual([
        'write:"\\u001b[0m\\u001b[2J\\u001b[H"',
        "queryCursorPosition:1",
        "resetScrollback",
        "getScrollback:1",
      ])
    }

    // (d) Baseline CPR fence failure stops before resetScrollback and before baseline read.
    const cprTimeout = await runScenario(id, "cpr-timeout")
    expect(cprTimeout.result.pass, `${id} cpr-timeout`).toBe(false)
    expect(cprTimeout.order, `${id} cpr-timeout order`).toEqual([
      'write:"\\u001b[0m\\u001b[2J\\u001b[H"',
      "queryCursorPosition:1",
    ])
  }
})
