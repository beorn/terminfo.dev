/**
 * @failure Historical rows are selected as current, or stored TODO/failure disappear from current scores.
 * @level l2
 * @consumer Current result selector, API v3 and site build
 * @testonly none
 */
import { describe, expect, it } from "vitest"
import { parseRun } from "@terminfo/run-parser"
import type { CapabilityResult, ProbeSuiteManifest } from "@terminfo/probe-defs"
import { projectResults } from "../docs/data/selected-results.ts"

const ids = Array.from({ length: 273 }, (_, index) => `capability.${index}`)
const suite: ProbeSuiteManifest = {
  probeHash: "current-five-status",
  sourceRevision: "1".repeat(40),
  generatedAt: "2026-10-21T05:00:00.000Z",
  adapterVersion: "3.3.2",
  catalogIds: ids,
  probes: { app: [], headless: [], mux: [] },
}
const attempt = { scope: "probe" as const, startedAt: "2026-10-21T05:00:00.000Z" }
const raw = (results: CapabilityResult[]) => ({
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
const todos = (): CapabilityResult[] =>
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
    const projection = projectResults([run], [], ["different-live-catalogue"], { currentProbeHash: suite.probeHash })
    const selected = projection.current["app:kitty"]
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
    const projection = projectResults([parse(raw(results))], [], ids, { currentProbeHash: suite.probeHash })
    expect(projection.current["app:kitty"]?.counts).toEqual({
      supported: 0,
      unsupported: 0,
      untestable: 0,
      "test-todo": 272,
      "test-failure": 1,
    })
    expect(projection.current["app:kitty"]?.complete).toBe(false)
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
    const projection = projectResults([parse({ ...value, assertions })], [], ids, { currentProbeHash: suite.probeHash })
    expect(projection.current["app:kitty"]?.score).toEqual({ supported: 0, all: 273 })
    expect(projection.current["app:kitty"]?.counts.unsupported).toBe(273)
    expect(projection.current["app:kitty"]?.complete).toBe(true)
  })
  it("keeps an all-history build usable with no current row or invented current score", () => {
    const { results: _results, sealedAt: _sealedAt, ...metadata } = raw([])
    const legacy = parse({ ...metadata, schemaVersion: 2, observations: [], suiteComplete: true })
    const projection = projectResults([legacy], [], ids, { currentProbeHash: suite.probeHash })
    expect(projection.current).toEqual({})
    expect(projection.versions).toEqual({})
    expect(projection.history).toEqual({})
    expect(projection.historical.history["app:kitty"]?.[0]?.runId).toBe(legacy.runId)
  })
})
