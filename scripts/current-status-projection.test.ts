/**
 * @failure Historical rows are selected as current, or stored TODO/failure disappear from current scores.
 * @level l2
 * @consumer Current result selector, API v3 and site build
 * @testonly none
 */
import { describe, expect, it } from "vitest"
import { parseRun } from "@terminfo/run-parser"
import type { ProbeResult, ProbeSuiteManifest } from "@terminfo/probe-defs"
import { ENVIRONMENT_GROUP_IDS } from "@terminfo/probe-defs"
import { projectResults, maskRunnerStorePath } from "../docs/data/selected-results.ts"
import { currentCoverageSentence } from "../docs/data/release-scope.ts"

// Explicit schema-3 wire fixture; current public results use tests and assertionType.
type Schema3Result = Omit<ProbeResult, "tests" | "assertionType"> & { checks: ProbeResult["tests"]; evidence?: string }
const ids = Array.from({ length: 273 }, (_, index) => `capability.${index}`)
const suite: ProbeSuiteManifest = {
  probeHash: "current-five-status",
  sourceRevision: "1".repeat(40),
  generatedAt: "2026-10-21T05:00:00.000Z",
  adapterVersion: "3.3.2",
  catalogIds: ids,
  probes: { term: [], lib: [], mux: [] },
}
const attempt = { scope: "probe" as const, startedAt: "2026-10-21T05:00:00.000Z" }
const raw = (results: Schema3Result[]) => ({
  schemaVersion: 3,
  runId: "current-run",
  target: {
    kind: "app",
    id: "kitty",
    version: "0.46.2",
    os: "macos",
    osVersion: null,
    outerTerminal: null,
    mux: null,
    config: null,
    permissions: null,
  },
  intendedContext: { kind: "app", id: "kitty" },
  identity: "verified",
  suiteId: suite.probeHash,
  probeHash: suite.probeHash,
  sourceRevision: suite.sourceRevision,
  measuredAt: "2026-10-21T05:00:00.000Z",
  sealedAt: "2026-10-21T05:00:01.000Z",
  origin: { kind: "collector" },
  rawReplies: { "device.primary-da": "\u001b[?62;52;c", "device.xtversion": "kitty(0.46.2)" },
  assertions: [],
  screenshotRefs: [],
  results,
})
const parse = (value: object) =>
  parseRun("fixture.json", JSON.stringify(value), ids, new Map([[suite.probeHash, suite]]))
const todos = (): Schema3Result[] =>
  ids.map((featureId) => ({
    featureId,
    status: "test-todo",
    attempt: { scope: "none" },
    checks: [],
    reason: "No implementation",
  }))
// Existing selection tests exercise v1/v2 observation grading; they cannot prove that v3 selection
// reads the stored five statuses and frozen denominator without applying later interpretations.
describe("current execution projection", () => {
  it("keeps every TODO visible over all 273 and admits current identity using the existing measured rule", () => {
    const run = parse(raw(todos()))
    const projection = projectResults(
      [run],
      [],
      ["different-live-catalogue"],
      { currentProbeHash: suite.probeHash },
      [],
    )
    const selected = projection.current["term:kitty"]
    expect(selected?.results).toEqual(run.results)
    expect(selected?.score).toEqual({ supported: 0, all: 273 })
    expect(selected?.counts["test-todo"]).toBe(273)
    expect(selected?.complete).toBe(false)
    expect(projection.table[run.runId]).toEqual(Object.fromEntries(ids.map((id) => [id, "test-todo"])))
  })
  it("retains an actual failed check alongside TODO without a decisive assertion hiding either", () => {
    const results = todos()
    results[0] = {
      featureId: ids[0]!,
      status: "test-failure",
      attempt,
      checks: [{ id: "collection", status: "test-failure", attempt, reason: "callback threw" }],
      reason: "callback threw",
    }
    const projection = projectResults([parse(raw(results))], [], ids, { currentProbeHash: suite.probeHash }, [])
    expect(projection.current["term:kitty"]?.counts).toEqual({
      supported: 0,
      unsupported: 0,
      untestable: 0,
      "test-todo": 272,
      "test-failure": 1,
    })
    expect(projection.current["term:kitty"]?.complete).toBe(false)
  })
  it("can finish all unsupported at zero supported out of 273, without excluding capabilities", () => {
    const value = raw(
      ids.map((featureId, index) => ({
        featureId,
        status: "unsupported",
        evidence: "query",
        rawReplyRef: featureId,
        attempt,
        checks: [{ id: "criterion", status: "unsupported", attempt, assertionRefs: [index], rawReplyRef: featureId }],
      })),
    )
    for (const featureId of ids) value.rawReplies[featureId as keyof typeof value.rawReplies] = "NO"
    const assertions = ids.map((featureId) => ({
      featureId,
      kind: "negative",
      rawReplyRef: featureId,
      expected: "ACK",
      observed: "NO",
    }))
    const projection = projectResults(
      [parse({ ...value, assertions })],
      [],
      ids,
      { currentProbeHash: suite.probeHash },
      [],
    )
    expect(projection.current["term:kitty"]?.score).toEqual({ supported: 0, all: 273 })
    expect(projection.current["term:kitty"]?.counts.unsupported).toBe(273)
    expect(projection.current["term:kitty"]?.complete).toBe(true)
  })
  it("leaves a corpus of only legacy runs with no current row and no invented current score", () => {
    const { results: _results, sealedAt: _sealedAt, ...metadata } = raw([])
    const legacy = parse({ ...metadata, schemaVersion: 2, observations: [], suiteComplete: true })
    const projection = projectResults([legacy], [], ids, { currentProbeHash: suite.probeHash }, [])
    expect(projection.current).toEqual({})
    expect(projection.versions).toEqual({})
    expect(projection.history).toEqual({})
    // The legacy run is read only for input identity, never projected into a row of its own.
    expect(projection.table[legacy.runId]).toBeUndefined()
  })

  it("grades a 273-row run over its 264 graded ids and never counts an environment group", () => {
    const supportedGroup = ENVIRONMENT_GROUP_IDS[0]
    const splitIds = [...ENVIRONMENT_GROUP_IDS, ...Array.from({ length: 264 }, (_, index) => `capability.${index}`)]
    const results: Schema3Result[] = splitIds.map((featureId) =>
      featureId === supportedGroup
        ? {
            featureId,
            status: "supported",
            evidence: "query",
            rawReplyRef: featureId,
            attempt,
            checks: [{ id: "criterion", status: "supported", attempt, assertionRefs: [0], rawReplyRef: featureId }],
          }
        : { featureId, status: "test-todo", attempt: { scope: "none" }, checks: [], reason: "No implementation" },
    )
    const splitSuite: ProbeSuiteManifest = { ...suite, catalogIds: splitIds }
    const base = raw(results)
    const value = {
      ...base,
      rawReplies: { ...base.rawReplies, [supportedGroup]: "OK" },
      assertions: [
        { featureId: supportedGroup, kind: "positive", rawReplyRef: supportedGroup, expected: "OK", observed: "OK" },
      ],
    }
    const run = parseRun("fixture.json", JSON.stringify(value), splitIds, new Map([[splitSuite.probeHash, splitSuite]]))
    const projection = projectResults([run], [], splitIds, { currentProbeHash: suite.probeHash }, [])
    const selected = projection.current["term:kitty"]
    // The supported-looking environment row stays recorded, and never graded: numerator and
    // denominator both cover the same 264 ids (CTO condition, verdict 427f2da3).
    expect(selected?.results.find((result) => result.featureId === supportedGroup)?.status).toBe("supported")
    expect(currentCoverageSentence(selected!, selected!.catalogIds)).not.toContain("NOT MEASURED")
    expect(selected?.score).toEqual({ supported: 0, all: 264 })
    expect(selected?.counts).toEqual({
      supported: 0,
      unsupported: 0,
      untestable: 0,
      "test-todo": 264,
      "test-failure": 0,
    })
    expect(selected?.complete).toBe(false)
  })
})

// An unchanged reviewed default key must still identify its canonical subject after the rename.
it("normalizes historical reviewed context keys without rewriting arbitrary configuration text", () => {
  expect(maskRunnerStorePath('app:kitty@["app","kitty","macos",null,null,null,null,null]')).toBe(
    'term:kitty@["term","kitty","macos",null,null,null,null,null]',
  )
  expect(maskRunnerStorePath('headless:xtermjs@["headless","xtermjs","linux",null,null,null,null,null]')).toBe(
    'lib:xtermjs@["lib","xtermjs","linux",null,null,null,null,null]',
  )
  expect(maskRunnerStorePath("app:keep-this-config")).toBe("app:keep-this-config")
})

it("retains the recorded live source only on selected schema-4 metadata", () => {
  const historical = raw(todos())
  const { target, intendedContext, results, ...metadata } = historical
  const current = {
    ...metadata,
    schemaVersion: 4,
    source: { kind: "live" },
    subject: { ...target, kind: "term" },
    intendedSubject: { ...intendedContext, kind: "term" },
    results: results.map(({ checks, ...result }) => ({ ...result, tests: checks })),
  }
  const loaded = parseRun(
    "live.json",
    JSON.stringify(current),
    ids,
    new Map([[suite.probeHash, { ...suite, schemaVersion: 4 }]]),
  )
  const selected = projectResults([loaded], [], ids, { currentProbeHash: suite.probeHash }, []).current["term:kitty"]
  expect(selected?.schemaVersion).toBe(4)
  expect(selected?.source).toEqual({ kind: "live" })
  const oldSelected = projectResults([parse(historical)], [], ids, { currentProbeHash: suite.probeHash }, []).current[
    "term:kitty"
  ]
  expect(oldSelected?.schemaVersion).toBe(3)
  expect(oldSelected).not.toHaveProperty("source")
})
