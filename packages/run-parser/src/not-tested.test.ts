/**
 * @failure Named coverage records silently change suite completeness, overlap a measured outcome, or hide a failed probe.
 * @level l1
 * @consumer run-parser admission, selected-results partition, collector boundary
 * @reach parses raw v2 runs carrying the additive ProbeRun.notTested coverage record
 * @testonly none
 */
import { describe, expect, it } from "vitest"
import type { ProbeSuiteManifest } from "@terminfo/probe-defs"
import { parseRun } from "./index.ts"

const catalog = ["alpha", "beta", "gamma"]
const suite: ProbeSuiteManifest = {
  probeHash: "nt-suite",
  sourceRevision: "2".repeat(40),
  generatedAt: "2026-10-05T00:00:00.000Z",
  adapterVersion: "3.3.2",
  probes: { app: catalog, headless: catalog, mux: catalog },
}
const suites = new Map([[suite.probeHash, suite]])

const measured = (featureId: string) => ({
  featureId,
  outcome: "inconclusive" as const,
  evidence: "query" as const,
  reason: "timeout" as const,
})
const coverage = (featureId: string, overrides: Record<string, unknown> = {}) => ({
  featureId,
  reason: "no-semantic-observable",
  noObservable: "input events",
  rawReplyRef: featureId,
  ...overrides,
})
const baseRun = (overrides: Record<string, unknown> = {}) => ({
  schemaVersion: 2,
  runId: "nt-run",
  target: {
    kind: "app",
    id: "kitty",
    version: "0.49.2",
    os: null,
    osVersion: null,
    outerTerminal: null,
    mux: null,
    config: null,
    permissions: null,
  },
  identity: "verified",
  suiteId: "nt-suite",
  probeHash: "nt-suite",
  suiteComplete: true,
  sourceRevision: "2".repeat(40),
  measuredAt: "2026-10-05T00:00:00.000Z",
  origin: { kind: "collector" },
  rawReplies: { alpha: "A", beta: "B", gamma: "C" },
  assertions: [],
  screenshotRefs: [],
  observations: [measured("alpha"), measured("beta")],
  notTested: [coverage("gamma")],
  ...overrides,
})
const parse = (overrides: Record<string, unknown> = {}) =>
  parseRun("nt.json", JSON.stringify(baseRun(overrides)), catalog, suites)

describe("named not-tested coverage", () => {
  it("treats measured plus named not-tested as a disjoint complete suite", () => {
    const run = parse()
    expect(run.suiteComplete).toBe(true)
    expect(run.notTested).toEqual([
      { featureId: "gamma", reason: "no-semantic-observable", noObservable: "input events", rawReplyRef: "gamma" },
    ])
    expect(run.observations.map((item) => item.featureId)).toEqual(["alpha", "beta"])
  })

  it("refuses a scheduled probe missing from both measured and named coverage", () => {
    expect(() => parse({ notTested: [] })).toThrow(/suiteComplete.*2.*3/)
  })

  it("refuses an unclosed reason, an empty noObservable, and a trace that does not bind", () => {
    expect(() => parse({ notTested: [coverage("gamma", { reason: "because" })] })).toThrow(
      /invalid notTested reason for gamma/,
    )
    expect(() => parse({ notTested: [coverage("gamma", { noObservable: "   " })] })).toThrow(
      /requires a specific noObservable/,
    )
    expect(() => parse({ notTested: [coverage("gamma", { rawReplyRef: "alpha" })] })).toThrow(
      /requires its own rawReplyRef/,
    )
    expect(() => parse({ rawReplies: { alpha: "A", beta: "B" } })).toThrow(/requires a retained nonempty raw trace/)
    expect(() => parse({ rawReplies: { alpha: "A", beta: "B", gamma: "" } })).toThrow(
      /requires a retained nonempty raw trace/,
    )
  })

  it("refuses duplicate named IDs and any overlap with observations or assertions", () => {
    expect(() => parse({ notTested: [coverage("gamma"), coverage("gamma")] })).toThrow(
      /duplicate notTested feature gamma/,
    )
    expect(() => parse({ notTested: [coverage("gamma"), coverage("beta")] })).toThrow(
      /notTested beta also occurs in observations/,
    )
    expect(() =>
      parse({
        assertions: [{ featureId: "gamma", kind: "positive", expected: "ACK", observed: "ACK" }],
      }),
    ).toThrow(/notTested gamma also occurs in assertions/)
  })

  it("keeps a run without the optional key unchanged and complete from observations alone", () => {
    const { notTested: _omitted, ...withoutKey } = baseRun({ observations: catalog.map(measured) })
    const run = parseRun("legacy.json", JSON.stringify(withoutKey), catalog, suites)
    expect(run.suiteComplete).toBe(true)
    expect(run.notTested).toEqual([])
    expect(run.observations.map((item) => item.featureId)).toEqual(catalog)
  })
})
