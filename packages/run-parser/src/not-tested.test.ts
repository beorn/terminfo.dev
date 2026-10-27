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

// The approved runtime contract requires explicit TODO initialization and required-check
// precedence. Historical coverage tests above cannot catch a reader inventing these statuses.
describe("execution-owned five statuses", () => {
  it("initializes every frozen catalogue member without inventing measured identity or a criterion", async () => {
    const { initializeRunDraft } = await import("@terminfo/probe-defs")
    const ids = Array.from({ length: 273 }, (_, index) => `capability.${index}`)
    const draft = initializeRunDraft({
      runId: "runtime-initialization",
      sourceRevision: "2".repeat(40),
      manifest: { ...suite, catalogIds: ids },
      intendedContext: { kind: "headless", id: "xtermjs" },
    })
    expect(draft.schemaVersion).toBe(3)
    expect(draft.results.map((result) => result.featureId)).toEqual(ids)
    expect(draft.results.every((result) => result.status === "test-todo")).toBe(true)
    expect(draft.results.every((result) => result.attempt.scope === "none" && result.checks.length === 0)).toBe(true)
    expect(draft).not.toHaveProperty("target")
    expect(draft).not.toHaveProperty("provenance")
    expect(draft).not.toHaveProperty("sealedAt")
  })

  it.each([
    ["supported", "test-todo", "test-todo"],
    ["supported", "test-failure", "test-failure"],
    ["test-failure", "test-todo", "test-failure"],
    ["supported", "unsupported", "unsupported"],
    ["supported", "supported", "supported"],
  ] as const)("retains required-check precedence for %s plus %s", async (first, second, expected) => {
    const { finalizeProbeResult } = await import("@terminfo/probe-defs")
    const checks = [first, second].map((status, index) => ({
      id: `check-${index}`,
      status,
      attempt:
        status === "test-todo"
          ? { scope: "none" as const }
          : { scope: "probe" as const, startedAt: "2026-10-21T05:00:00.000Z" },
      ...(status === "test-todo" || status === "test-failure" ? { reason: "required check incomplete" } : {}),
    }))
    const result = finalizeProbeResult({
      featureId: "sgr.bold",
      attempt: { scope: "probe", startedAt: "2026-10-21T05:00:00.000Z" },
      checks,
    })
    expect(result.status).toBe(expected)
    expect(result.checks).toEqual(checks)
  })
})

// Current v3 totality is over immutable catalogue membership, not only callable arms.
// Historical v2 completeness above cannot detect omission of a catalogue-only capability.
describe("sealed current runs", () => {
  const currentSuite = { ...suite, catalogIds: catalog }
  const current = () => {
    const { observations: _old, notTested: _coverage, suiteComplete: _membership, ...metadata } = baseRun()
    return {
      ...metadata,
      schemaVersion: 3,
      intendedContext: { kind: "app", id: "kitty" },
      sealedAt: "2026-10-21T05:00:01.000Z",
      results: catalog.map((featureId) => ({
        featureId,
        status: "test-todo",
        attempt: { scope: "none" },
        checks: [],
        reason: "Missing implementation",
      })),
    }
  }
  // v1-v3 fixtures cannot detect a current reader/writer retaining the displaced wire names.
  // This pending-only run claims no successful measurement or native qualification.
  it("reads schema 4 live source, subject and tests without restoring displaced wire names", () => {
    const { target, intendedContext, results, ...metadata } = current()
    const raw = {
      ...metadata,
      schemaVersion: 4,
      source: { kind: "live" },
      subject: { ...target, kind: "term" },
      intendedSubject: { ...intendedContext, kind: "term" },
      results: results.map(({ checks, ...result }) => ({ ...result, tests: checks })),
    }
    const loaded = parseRun(
      "current-v4.json",
      JSON.stringify(raw),
      catalog,
      new Map([[suite.probeHash, currentSuite]]),
    )
    expect(loaded).toMatchObject({
      schemaVersion: 4,
      source: { kind: "live" },
      subject: raw.subject,
      intendedSubject: raw.intendedSubject,
      results: raw.results,
    })
    expect(loaded).not.toHaveProperty("target")
    expect(loaded).not.toHaveProperty("intendedContext")
    for (const result of loaded.results!) expect(result).not.toHaveProperty("checks")
  })
  it("reads recorded TODO without deriving status from today's catalogue or callback schedule", () => {
    const raw = current()
    const loaded = parseRun(
      "current.json",
      JSON.stringify(raw),
      ["new-live-id"],
      new Map([[suite.probeHash, currentSuite]]),
    )
    expect(loaded.schemaVersion).toBe(3)
    expect(loaded.results).toEqual(raw.results)
    expect(loaded.catalogIds).toEqual(catalog)
  })
  it("rejects missing/duplicate frozen results and an unsealed draft", () => {
    const parseCurrent = (value: object) =>
      parseRun("current.json", JSON.stringify(value), catalog, new Map([[suite.probeHash, currentSuite]]))
    const raw = current()
    expect(() => parseCurrent({ ...raw, results: raw.results.slice(1) })).toThrow(/catalogue membership/)
    expect(() =>
      parseCurrent({ ...raw, results: [raw.results[0], ...raw.results.slice(1, 2), raw.results[0]] }),
    ).toThrow(/duplicate/)
    expect(() => parseCurrent({ ...raw, sealedAt: undefined })).toThrow(/sealedAt/)
  })
  // Current support must retain the same raw-state binding as historical measurements;
  // enum/totality validation alone would permit an assertion with no captured bytes.
  it("does not accept a current support assertion without its bound raw evidence", () => {
    const raw = current()
    const first = raw.results[0]!
    const supported = {
      ...first,
      status: "supported",
      evidence: "parser-state",
      attempt: { scope: "probe", startedAt: "2026-10-21T05:00:00.000Z" },
      checks: [
        {
          id: "criterion",
          status: "supported",
          attempt: { scope: "probe", startedAt: "2026-10-21T05:00:00.000Z" },
          assertionRefs: [0],
        },
      ],
    }
    expect(() =>
      parseRun(
        "unbound-current.json",
        JSON.stringify({
          ...raw,
          results: [supported, ...raw.results.slice(1)],
          assertions: [{ featureId: "alpha", kind: "positive", expected: "bold=true", observed: "bold=true" }],
          rawReplies: {},
        }),
        catalog,
        new Map([[suite.probeHash, currentSuite]]),
      ),
    ).toThrow(/raw|bound/)
  })
})
