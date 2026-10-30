/**
 * @failure Named coverage records silently change suite completeness, overlap a measured outcome, or hide a failed probe.
 * @level l1
 * @consumer run-parser admission, selected-results partition, collector boundary
 * @reach parses raw v2 runs carrying the additive ProbeRun.notTested coverage record
 * @testonly none
 */
import { describe, expect, it } from "vitest"
import { initializeRunDraft, sealRunDraft, type ProbeSuiteManifest } from "@terminfo/probe-defs"
import { parseRun, parseSuiteManifest } from "./index.ts"

const catalog = ["alpha", "beta", "gamma"]
const suite: ProbeSuiteManifest = {
  probeHash: "nt-suite",
  sourceRevision: "2".repeat(40),
  generatedAt: "2026-10-05T00:00:00.000Z",
  adapterVersion: "3.3.2",
  probes: { term: catalog, lib: catalog, mux: catalog },
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
      manifest: { ...suite, schemaVersion: 4, catalogIds: ids },
      source: { kind: "live" },
      intendedSubject: { kind: "lib", id: "xtermjs" },
    })
    expect(draft.schemaVersion).toBe(4)
    expect(draft.results.map((result) => result.featureId)).toEqual(ids)
    expect(draft.results.every((result) => result.status === "test-todo")).toBe(true)
    expect(draft.results.every((result) => result.attempt.scope === "none" && result.tests.length === 0)).toBe(true)
    expect(draft).not.toHaveProperty("subject")
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
      tests: checks,
    })
    expect(result.status).toBe(expected)
    expect(result.tests).toEqual(checks)
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
  // Phase0: historical/live-only fixtures cannot detect lost capture identity in a replay result.
  it.each([
    { kind: "live" as const },
    {
      kind: "trace" as const,
      trace: { path: "traces/capture.json", sha256: "ab".repeat(32) },
      captureRunId: "original-capture",
      captureSuiteId: suite.probeHash,
      captureSourceRevision: "2".repeat(40),
    },
  ])("preserves schema 4 $kind source through initialization, sealing and reading", (source) => {
    const { target, intendedContext, results, ...metadata } = current()
    const raw = {
      ...metadata,
      schemaVersion: 4,
      source,
      subject: { ...target, kind: "term" as const },
      intendedSubject: { ...intendedContext, kind: "term" as const },
      results: results.map(({ checks, ...result }) => ({ ...result, tests: checks })),
    }
    const draft = initializeRunDraft({
      runId: raw.runId,
      sourceRevision: raw.sourceRevision,
      source,
      intendedSubject: raw.intendedSubject,
      manifest: { ...currentSuite, schemaVersion: 4 },
    })
    expect(draft.source).toEqual(source)
    const sealed = sealRunDraft(
      {
        ...draft,
        subject: raw.subject,
        identity: "unverified",
        measuredAt: raw.measuredAt,
        origin: { kind: "collector" },
      },
      raw.sealedAt,
    )
    expect(sealed.source).toEqual(source)
    const loaded = parseRun(
      "current-v4.json",
      JSON.stringify(sealed),
      catalog,
      new Map([[suite.probeHash, { ...currentSuite, schemaVersion: 4 }]]),
    )
    expect(loaded).toMatchObject({
      schemaVersion: 4,
      source,
      subject: raw.subject,
      intendedSubject: raw.intendedSubject,
      results: draft.results,
    })
    expect(loaded).not.toHaveProperty("target")
    expect(loaded).not.toHaveProperty("intendedContext")
    for (const result of loaded.results!) expect(result).not.toHaveProperty("checks")
  })
  // The old reader accepted arbitrary extra keys; the new wire must have one spelling per fact.
  it("requires a bound source and refuses displaced or unknown schema-4 keys by name", () => {
    const { target, intendedContext, results, ...metadata } = current()
    const raw = {
      ...metadata,
      schemaVersion: 4,
      source: { kind: "live" },
      subject: { ...target, kind: "term" as const },
      intendedSubject: { ...intendedContext, kind: "term" as const },
      results: results.map(({ checks, ...result }) => ({ ...result, tests: checks })),
    }
    const parseV4 = (value: unknown) =>
      parseRun(
        "v4.json",
        JSON.stringify(value),
        catalog,
        new Map([[suite.probeHash, { ...currentSuite, schemaVersion: 4 }]]),
      )
    expect(() => parseV4({ ...raw, source: undefined })).toThrow(/source/)
    // These are wire-key diagnostics: v4 has subject, while retained schema3 still has target.
    for (const field of ["id", "version", "os", "osVersion", "outerTerminal", "mux", "config", "permissions"]) {
      expect(() => parseV4({ ...raw, subject: { ...raw.subject, [field]: undefined } })).toThrow(`subject.${field}`)
      expect(() =>
        parseRun(
          "historical-v3.json",
          JSON.stringify({ ...current(), target: { ...target, [field]: undefined } }),
          catalog,
          new Map([[suite.probeHash, currentSuite]]),
        ),
      ).toThrow(`target.${field}`)
    }
    expect(() => parseV4({ ...raw, runtimeIdentity: {} })).toThrow("runtimeIdentity is only valid for lib subjects")
    expect(() => parseV4({ ...raw, subject: { ...raw.subject, kind: "lib" } })).toThrow("missing lib runtimeIdentity")
    expect(() =>
      parseV4({
        ...raw,
        subject: { ...raw.subject, kind: "lib" },
        runtimeIdentity: { kind: "js", engineVersion: "different-version" },
      }),
    ).toThrow(`conflicts with subject.version ${target.version}`)
    expect(() => parseV4({ ...raw, source: { kind: "trace" } })).toThrow(/trace source/)
    const traceSource = {
      kind: "trace",
      trace: { path: "traces/capture.json", sha256: "ab".repeat(32) },
      captureRunId: "original-capture",
      captureSuiteId: suite.probeHash,
      captureSourceRevision: "2".repeat(40),
    }
    // Phase0's immutable artifact pointer cannot escape its store or lose its capture identity.
    // Old live-only controls do not exercise a structurally complete, but invalid, trace.
    const invalidSources = [
      { ...traceSource, captureRunId: raw.runId },
      { kind: "live", trace: traceSource.trace },
      { ...traceSource, version: 1 },
      ...[
        "",
        "  ",
        "/capture.json",
        "\\capture.json",
        "C:\\capture.json",
        "../capture.json",
        "traces/../capture.json",
        "traces\\..\\capture.json",
      ].map((path) => ({ ...traceSource, trace: { ...traceSource.trace, path } })),
      ...["", "not-a-sha", "ab".repeat(31)].map((sha256) => ({
        ...traceSource,
        trace: { ...traceSource.trace, sha256 },
      })),
      { ...traceSource, trace: { ...traceSource.trace, format: "viprobe.call-log" } },
      ...["captureRunId", "captureSuiteId", "captureSourceRevision"].map((key) => ({ ...traceSource, [key]: "" })),
      { ...traceSource, captureSourceRevision: "not-a-revision" },
      {
        kind: "trace",
        trace: traceSource.trace,
        capturedRunId: "wrong-prefix",
        captureSuiteId: suite.probeHash,
        captureSourceRevision: "2".repeat(40),
      },
    ]
    for (const source of invalidSources) {
      expect(() => parseV4({ ...raw, source }), JSON.stringify(source)).toThrow(/source/)
      expect(
        () =>
          initializeRunDraft({
            runId: raw.runId,
            sourceRevision: raw.sourceRevision,
            source: source as never,
            intendedSubject: raw.intendedSubject,
            manifest: { ...currentSuite, schemaVersion: 4 },
          }),
        JSON.stringify(source),
      ).toThrow(/source/)
      expect(() => sealRunDraft({ ...raw, source } as never), JSON.stringify(source)).toThrow(/source/)
    }
    expect(() => parseV4({ ...raw, target })).toThrow(/target/)
    expect(() => parseV4({ ...raw, mystery: true })).toThrow(/mystery/)
    expect(() => parseV4({ ...raw, results: raw.results.map((result) => ({ ...result, checks: [] })) })).toThrow(
      /checks/,
    )
    expect(() => parseV4({ ...raw, results: raw.results.map((result) => ({ ...result, mystery: true })) })).toThrow(
      /mystery/,
    )
  })

  it("validates each current assertion's retained payload independently of the primary result type", () => {
    const { target, intendedContext, results, ...metadata } = current()
    const attempt = { scope: "probe", startedAt: "2026-10-21T05:00:00.000Z" }
    const raw = {
      ...metadata,
      schemaVersion: 4,
      source: { kind: "live" },
      subject: { ...target, kind: "term" },
      intendedSubject: { ...intendedContext, kind: "term" },
      rawReplies: { alpha: "ACK" },
      assertions: [
        {
          featureId: "alpha",
          kind: "positive",
          assertionType: "input_bytes",
          rawReplyRef: "alpha",
          expected: "ACK",
          observed: JSON.stringify({ control: "before", report: "ACK" }),
        },
      ],
      results: results.map(({ checks, ...result }, index) =>
        index === 0
          ? {
              ...result,
              status: "supported",
              reason: undefined,
              assertionType: "query_reply",
              rawReplyRef: "alpha",
              attempt,
              tests: [{ id: "criterion", status: "supported", attempt, assertionRefs: [0] }],
            }
          : { ...result, tests: checks },
      ),
    }
    const parseV4 = (value: unknown) =>
      parseRun(
        "assertions-v4.json",
        JSON.stringify(value),
        catalog,
        new Map([[suite.probeHash, { ...currentSuite, schemaVersion: 4 }]]),
      )
    expect(() => parseV4(raw)).toThrow(/performed action/)
    const query = { ...raw, assertions: [{ ...raw.assertions[0], assertionType: "query_reply", observed: "ACK" }] }
    expect(parseV4(query).results?.[0]?.status).toBe("supported")
    expect(() =>
      parseV4({ ...query, rawReplies: { alpha: JSON.stringify({ events: [], queries: [], writes: ["query"] }) } }),
    ).toThrow(/returned query bytes/)
  })

  it("decodes suite wire versions without rewriting historical marker absence", () => {
    const { probes: _normalized, ...metadata } = suite
    const oldWire = { ...metadata, probes: { app: catalog, headless: catalog, mux: catalog } }
    const normalized = parseSuiteManifest("old-suite.json", JSON.stringify(oldWire))
    expect(normalized.probes).toEqual({ term: catalog, lib: catalog, mux: catalog })
    expect(normalized).not.toHaveProperty("schemaVersion")
    expect(
      parseSuiteManifest("new-suite.json", JSON.stringify({ ...normalized, schemaVersion: 4 })).schemaVersion,
    ).toBe(4)
    expect(() => parseSuiteManifest("mixed-suite.json", JSON.stringify({ ...oldWire, schemaVersion: 4 }))).toThrow(
      /probe kinds/,
    )
    expect(() => parseSuiteManifest("unknown-suite.json", JSON.stringify({ ...oldWire, schemaVersion: 5 }))).toThrow(
      /schemaVersion 5/,
    )
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
    expect(loaded.results).toEqual(raw.results.map(({ checks, ...result }) => ({ ...result, tests: checks })))
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
