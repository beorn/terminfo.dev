/**
 * @failure Named coverage records silently change suite completeness, overlap a measured outcome, or hide a failed probe.
 * @level l1
 * @consumer run-parser admission, selected-results partition, collector boundary
 * @reach parses current frozen results, initialization and source identity
 * @testonly none
 */
import { describe, expect, it } from "vitest"
import { initializeRunDraft, type ProbeSuiteManifest } from "@terminfo/probe-defs"
import { parseRun, parseSuiteManifest } from "./index.ts"

const catalog = ["alpha", "beta", "gamma"]
const suite: ProbeSuiteManifest & { schemaVersion: 4 } = {
  schemaVersion: 4,
  catalogIds: catalog,
  probeHash: "nt-suite",
  sourceRevision: "2".repeat(40),
  generatedAt: "2026-10-05T00:00:00.000Z",
  adapterVersion: "3.3.2",
  probes: { term: catalog, lib: catalog, mux: catalog },
}
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

// Current totality is over immutable catalogue membership, not only callable arms.
describe("collected current runs", () => {
  const currentSuite = suite
  const current = () => {
    const draft = initializeRunDraft({
      runId: "nt-run",
      sourceRevision: "2".repeat(40),
      source: { kind: "live" },
      manifest: currentSuite,
      intendedSubject: { kind: "term", id: "kitty" },
    })
    const subject = {
      kind: "term" as const,
      id: "kitty",
      version: "0.49.2",
      os: null,
      osVersion: null,
      outerTerminal: null,
      mux: null,
      config: null,
      permissions: null,
    }
    draft.subject = subject
    draft.identity = "unverified"
    draft.measuredAt = "2026-10-05T00:00:00.000Z"
    draft.origin = { kind: "collector" }
    return { ...draft, subject }
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
  ])("preserves schema 4 $kind source through initialization and reading", (source) => {
    const raw = { ...current(), source }
    const draft = initializeRunDraft({
      runId: raw.runId,
      sourceRevision: raw.sourceRevision,
      source,
      intendedSubject: raw.intendedSubject,
      manifest: { ...currentSuite, schemaVersion: 4 },
    })
    expect(draft.source).toEqual(source)
    const sealed = {
      ...draft,
      subject: raw.subject,
      identity: "unverified",
      measuredAt: raw.measuredAt,
      origin: { kind: "collector" },
    }
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
    const raw = current()
    const parseV4 = (value: unknown) =>
      parseRun(
        "v4.json",
        JSON.stringify(value),
        catalog,
        new Map([[suite.probeHash, { ...currentSuite, schemaVersion: 4 }]]),
      )
    expect(() => parseV4({ ...raw, source: undefined })).toThrow(/source/)
    // Required current subject fields are named in wire-key diagnostics.
    for (const field of ["id", "version", "os", "osVersion", "outerTerminal", "mux", "config", "permissions"]) {
      expect(() => parseV4({ ...raw, subject: { ...raw.subject, [field]: undefined } })).toThrow(`subject.${field}`)
    }
    expect(() => parseV4({ ...raw, runtimeIdentity: {} })).toThrow("runtimeIdentity is only valid for lib subjects")
    expect(() => parseV4({ ...raw, subject: { ...raw.subject, kind: "lib" } })).toThrow("missing lib runtimeIdentity")
    expect(() =>
      parseV4({
        ...raw,
        subject: { ...raw.subject, kind: "lib" },
        runtimeIdentity: { kind: "js", engineVersion: "different-version" },
      }),
    ).toThrow(`conflicts with subject.version ${raw.subject.version}`)
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
    }
    expect(() => parseV4({ ...raw, target: raw.subject })).toThrow(/target/)
    expect(() => parseV4({ ...raw, mystery: true })).toThrow(/mystery/)
    expect(() => parseV4({ ...raw, results: raw.results.map((result) => ({ ...result, checks: [] })) })).toThrow(
      /checks/,
    )
    expect(() => parseV4({ ...raw, results: raw.results.map((result) => ({ ...result, mystery: true })) })).toThrow(
      /mystery/,
    )
  })

  it("validates each current assertion's retained payload independently of the primary result type", () => {
    const currentRun = current()
    const attempt = { scope: "probe", startedAt: "2026-10-21T05:00:00.000Z" }
    const raw = {
      ...currentRun,
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
      results: currentRun.results.map((result, index) =>
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
          : result,
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
    const { probes: _normalized, schemaVersion: _schemaVersion, ...metadata } = suite
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
    expect(loaded.schemaVersion).toBe(4)
    expect(loaded.results).toEqual(raw.results)
    expect(loaded.catalogIds).toEqual(catalog)
  })
  it("requires complete catalogue results and accepts a collected run without a seal", () => {
    const parseCurrent = (value: object) =>
      parseRun("current.json", JSON.stringify(value), catalog, new Map([[suite.probeHash, currentSuite]]))
    const raw = current()
    expect(() => parseCurrent({ ...raw, results: raw.results.slice(1) })).toThrow(/catalogue membership/)
    expect(() =>
      parseCurrent({ ...raw, results: [raw.results[0], ...raw.results.slice(1, 2), raw.results[0]] }),
    ).toThrow(/duplicate/)
    expect(parseCurrent({ ...raw, sealedAt: undefined }).results).toEqual(raw.results)
    // The retired schema-2 specimen was the last decoder consumer; current-run tests alone
    // would not detect a retained legacy arm.
    expect(() => parseCurrent({ ...raw, schemaVersion: 2 })).toThrow(/unsupported schemaVersion 2/)
  })
  // Current support must retain the same raw-state binding as historical measurements;
  // enum/totality validation alone would permit an assertion with no captured bytes.
  it("does not accept a current support assertion without its bound raw evidence", () => {
    const raw = current()
    const first = raw.results[0]!
    const supported = {
      ...first,
      status: "supported",
      assertionType: "buffer_state",
      attempt: { scope: "probe", startedAt: "2026-10-21T05:00:00.000Z" },
      tests: [
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
          assertions: [
            {
              featureId: "alpha",
              kind: "positive",
              assertionType: "buffer_state",
              expected: "bold=true",
              observed: "bold=true",
            },
          ],
          rawReplies: {},
        }),
        catalog,
        new Map([[suite.probeHash, currentSuite]]),
      ),
    ).toThrow(/raw|bound/)
  })
})
