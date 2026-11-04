/**
 * @failure Named coverage records silently change suite completeness, overlap a measured outcome, or hide a failed probe.
 * @level l1
 * @consumer run-parser admission, selected-results partition, collector boundary
 * @reach parses current frozen results, initialization and source identity
 * @testonly none
 */
import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { createHash } from "node:crypto"
import {
  initializeRunDraft,
  recordCollectorSelection,
  recordCollectorAttempt,
  type CapturedRunDraft,
  type ProbeSuiteManifest,
} from "@terminfo/probe-defs"
import {
  parseProbeResults,
  decodeCollectorDraft,
  parseRun,
  parseSuiteManifest,
  SOURCE_ANSWER_RETIRED_REASON,
  STORED_VISUAL_REVIEW_RETIRED_REASON,
} from "./index.ts"

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
  // Gate 2: stored wire words must decode at both row levels; live writer tests cannot catch this seam.
  it.each([
    ["test-todo", "probe-todo", "none"],
    ["probe-todo", "probe-todo", "none"],
    ["test-failure", "probe-invalid", "probe"],
    ["probe-invalid", "probe-invalid", "probe"],
  ])("decodes stored %s to %s in result and test rows without mutating input", (stored, canonical, scope) => {
    const attempt = scope === "none" ? { scope } : { scope, startedAt: "2026-10-21T05:00:00.000Z" }
    const row = {
      featureId: "alpha",
      status: stored,
      reason: "retained cause",
      attempt,
      tests: [{ id: "criterion", status: stored, reason: "retained cause", attempt }],
    }
    const original = JSON.stringify(row)
    const [result] = parseProbeResults([row], "stored.json", new Set(["alpha"]), {}, [])
    expect(result?.status).toBe(canonical)
    expect(result?.tests[0]?.status).toBe(canonical)
    expect(JSON.stringify(row)).toBe(original)
  })

  it.each(["result", "test"])("rejects unknown stored status in a %s row", (where) => {
    const attempt = { scope: "probe", startedAt: "2026-10-21T05:00:00.000Z" }
    const row = {
      featureId: "alpha",
      status: where === "result" ? "unknown-status" : "probe-invalid",
      reason: "retained cause",
      attempt,
      tests: [{ id: "criterion", status: where === "test" ? "unknown-status" : "probe-invalid", attempt }],
    }
    expect(() => parseProbeResults([row], "stored.json", new Set(["alpha"]), {}, [])).toThrow(
      where === "result" ? "invalid probe status for alpha" : "invalid test status for alpha/criterion",
    )
  })

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
    expect(draft.results.every((result) => result.status === "probe-todo")).toBe(true)
    expect(draft.results.every((result) => result.attempt.scope === "none" && result.tests.length === 0)).toBe(true)
    expect(draft).not.toHaveProperty("subject")
    expect(draft).not.toHaveProperty("provenance")
    expect(draft).not.toHaveProperty("sealedAt")
  })

  it.each([
    ["supported", "probe-todo", "probe-todo"],
    ["supported", "probe-invalid", "probe-invalid"],
    ["probe-invalid", "probe-todo", "probe-invalid"],
    ["supported", "unsupported", "unsupported"],
    ["supported", "supported", "supported"],
  ] as const)("retains required-check precedence for %s plus %s", async (first, second, expected) => {
    const { finalizeProbeResult } = await import("@terminfo/probe-defs")
    const checks = [first, second].map((status, index) => ({
      id: `check-${index}`,
      status,
      attempt:
        status === "probe-todo"
          ? { scope: "none" as const }
          : { scope: "probe" as const, startedAt: "2026-10-21T05:00:00.000Z" },
      ...(status === "probe-todo" || status === "probe-invalid" ? { reason: "required check incomplete" } : {}),
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
  it.each(["captured", "empty-selection"])(
    "decodes stored statuses while retaining the exact %s document and its digest",
    (kind) => {
      const currentRun =
        kind === "captured"
          ? current()
          : initializeRunDraft({
              runId: "empty-run",
              sourceRevision: "2".repeat(40),
              source: { kind: "live" },
              manifest: currentSuite,
              intendedSubject: { kind: "term", id: "kitty" },
            })
      if (kind === "empty-selection") {
        recordCollectorSelection(currentRun, [])
        recordCollectorAttempt(currentRun, { ids: [], result: "empty" })
      }
      const raw = { ...currentRun, results: currentRun.results.map((result) => ({ ...result, status: "test-todo" })) }
      const source = JSON.stringify(raw, null, 2) + "\n"
      const digest = createHash("sha256").update(source).digest("hex")
      if (kind === "captured") {
        const loaded = parseRun("stored.json", source, catalog, new Map([[suite.probeHash, currentSuite]]))
        expect(loaded.results?.map((result) => result.status)).toEqual(catalog.map(() => "probe-todo"))
        expect(loaded.sha256).toBe(digest)
      }
      const decoded = decodeCollectorDraft("stored.json", source, currentSuite, raw.sourceRevision)
      expect(decoded.kind).toBe(kind)
      expect(decoded.run.results.map((result) => result.status)).toEqual(catalog.map(() => "probe-todo"))
      expect(decoded.raw).toBe(source)
      expect(decoded.sha256).toBe(digest)
      expect(JSON.parse(decoded.raw)).toMatchObject({
        results: catalog.map((featureId) => ({ featureId, status: "test-todo" })),
      })
    },
  )
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

// Requirement: no result is graded from source (operator 2026-11-03, #32246). A source-only conclusion or
// Untestable result with no stored source-answer marker is refused as lacking an observation; normal catalogue and
// raw-evidence tests do not cover conclusions with no deciding observation.
it.each([
  ["semantic-prompt-source-review", "supported"],
  ["semantic-prompt-source-review", "unsupported"],
  ["os-input-review", "untestable"],
] as const)("refuses %s %s without a probe observation", (criterionBranch, status) => {
  const attempt = { scope: "probe", startedAt: "2026-10-21T05:00:00.000Z" }
  const row = { featureId: "alpha", status, criterionBranch, reason: "fixture", attempt, tests: [] }
  expect(() => parseProbeResults([row], "fixture.json", new Set(["alpha"]), {}, [])).toThrow(
    `alpha ${status} requires a probe observation; a source answer no longer counts`,
  )
})

// Requirement: a stored source-negative or reply-path cell is recognised by its branch marker and reads Probe to-do,
// never Unsupported (operator 2026-11-03, #32246).
it.each(["source-negative-review", "reply-path-audit-review"] as const)(
  "reads a stored %s unsupported cell as Probe to-do",
  (criterionBranch) => {
    const attempt = { scope: "probe", startedAt: "2026-10-21T05:00:00.000Z" }
    const row = { featureId: "alpha", status: "unsupported", criterionBranch, reason: "fixture", attempt, tests: [] }
    expect(parseProbeResults([row], "fixture.json", new Set(["alpha"]), {}, [])[0]).toMatchObject({
      status: "probe-todo",
      reason: SOURCE_ANSWER_RETIRED_REASON,
    })
  },
)

// Requirement (@cto batch7 A-F2): a stored app/mux screenshot review is retired too, but its reason names what it
// was: a judgment record, not a same-run pixel check (#30590). Source-answer cells keep their own reason.
// Both stored screenshot-review branches are covered: 54 retained cells use visual-review and Screen 5.0.2
// cursor.hide uses cursor-visibility-visual-review (peer af27-peer-1519).
it.each(["visual-review", "cursor-visibility-visual-review"])(
  "reads a stored %s screenshot review as Probe to-do with the visual-review reason",
  (criterionBranch) => {
    const attempt = { scope: "probe", startedAt: "2026-10-21T05:00:00.000Z" }
    const reviewRef = JSON.stringify(["term", "alacritty", "0.16.1", "linux", "alpha"])
    const row = {
      featureId: "alpha",
      status: "supported",
      criterionBranch,
      assertionType: "screenshot",
      reviewRef,
      attempt,
      tests: [{ id: "review", status: "supported", attempt, reviewRef }],
    }
    const [read] = parseProbeResults([row], "fixture.json", new Set(["alpha"]), {}, [])
    const reason = "stored visual review not re-admitted: needs a same-run pixel check"
    expect(read).toMatchObject({ status: "probe-todo", reason })
    expect(read?.tests[0]).toMatchObject({ status: "probe-todo", reason })
    expect(STORED_VISUAL_REVIEW_RETIRED_REASON).toBe(reason)
  },
)

// Requirement: a reference must resolve to its own retained answer; current fixtures only use valid tuples.
it.each([
  ["result", "unknown-review"],
  ["test", "unknown-review"],
  ["result", null],
  ["test", 42],
] as const)("rejects unresolved %s review reference %s", (where, ref) => {
  const attempt = { scope: "probe", startedAt: "2026-10-21T05:00:00.000Z" }
  const row = {
    featureId: "alpha",
    status: "probe-todo",
    reason: "fixture",
    attempt,
    ...(where === "result" ? { reviewRef: ref } : {}),
    tests: [{ id: "review", status: "probe-todo", attempt, ...(where === "test" ? { reviewRef: ref } : {}) }],
  }
  expect(() => parseProbeResults([row], "fixture.json", new Set(["alpha"]), {}, [])).toThrow(/review.*reference/i)
})

// Requirement: the reader preserves native host custody and pairs an unreproduced callback
// with its failed harness test. Existing source-answer and generic result tests never decode
// these retained native captures or remove one side of those facts.
const nativeCapture = (name: string) => {
  const run = JSON.parse(
    readFileSync(new URL(`./fixtures/${name}.capture.json`, import.meta.url), "utf8"),
  ) as CapturedRunDraft
  const ids: string[] = run.results.map((result: { featureId: string }) => result.featureId)
  const manifest: ProbeSuiteManifest = {
    schemaVersion: 4,
    probeHash: run.probeHash,
    adapterVersion: "4",
    catalogIds: ids,
    probes: { term: [], lib: ids, mux: [] },
  }
  const read = (value: unknown = run) =>
    parseRun(name, JSON.stringify(value), ids, new Map([[manifest.probeHash, manifest]]))
  return { run, read }
}

it.each([
  "kitty-osc52-harness",
  "kitty-osc52-supplied",
  "kitty-pixel-geometry",
  "wezterm-pixel-geometry",
  "alacritty-pixel-geometry",
])("reads retained native custody in %s", (name) => {
  const { run, read } = nativeCapture(name)
  expect(read().results?.map((result) => result.status)).toEqual(
    run.results.map((result: { status: string }) =>
      result.status === "test-failure" ? "probe-invalid" : result.status,
    ),
  )
})

it("rejects the retained WezTerm capture whose silent host query has no cause", () => {
  expect(() => nativeCapture("wezterm-osc52-refused").read()).toThrow(
    /missing cause for captured empty target response/,
  )
})

it.each([
  ["missing-cause", /host recipe/i],
  ["foreign-run", /host recipe/i],
  ["undeclared-query", /captured undeclared/],
  ["replied-cause", /invalid harness-unreproduced capture cause/],
] as const)("rejects altered native host custody: %s", (mode, refusal) => {
  const { run, read } = nativeCapture("kitty-osc52-harness")
  const result = run.results[0]
  if (!result) throw new Error("Kitty harness fixture requires a result")
  const key = `collector.hostRecipes.${result.featureId}`
  const rawRecord = run.rawReplies[key]
  if (!rawRecord) throw new Error(`Kitty harness fixture requires ${key}`)
  const record = JSON.parse(rawRecord) as {
    runId: string
    captures: Array<{ cause?: unknown; response: string; query: string; error: string | null }>
  }
  const capture = record.captures[0]
  if (!capture) throw new Error("Kitty harness fixture requires a host capture")
  if (mode === "missing-cause") delete capture.cause
  if (mode === "foreign-run") record.runId = "another-run"
  if (mode === "replied-cause") capture.response = "response"
  if (mode === "undeclared-query") {
    record.captures.push({ query: "\u001b[14t", response: "", error: null })
  }
  run.rawReplies[key] = JSON.stringify(record)
  expect(() => read(run)).toThrow(refusal)
})

it.each(["record-only", "row-only", "todo-row"] as const)("rejects unmatched harness evidence: %s", (mode) => {
  const { run, read } = nativeCapture("kitty-osc52-harness")
  const result = run.results[0]
  const test = result?.tests[0]
  if (!result || !test) throw new Error("Kitty harness fixture requires a result and harness test")
  if (mode === "record-only") test.id = "criterion"
  if (mode === "row-only") {
    if (!result.rawReplyRef) throw new Error("Fixture requires a raw reply reference")
    run.rawReplies[result.rawReplyRef] = ""
  }
  if (mode === "todo-row") test.status = "probe-todo"
  expect(() => read(run)).toThrow(/unreproduced-callback record/)
})

// Requirement: a decided test has an attempt, and support has an observed attempt. Existing
// retained-capture positives do not mutate those fields independently.
it("rejects a decided test with no attempt", () => {
  const { run, read } = nativeCapture("kitty-osc52-supplied")
  const test = run.results[0]?.tests[0]
  if (!test) throw new Error("Kitty supplied fixture requires a decided test")
  test.attempt = { scope: "none" }
  expect(() => read(run)).toThrow(/decided test.*no attempt/)
})

it("rejects support without measured evidence", () => {
  const { run, read } = nativeCapture("kitty-osc52-supplied")
  const result = run.results[0]
  if (!result) throw new Error("Kitty supplied fixture requires a result")
  result.attempt = { scope: "none" }
  expect(() => read(run)).toThrow(/support result requires measured evidence/)
})

// Requirement: source-audited host causes cite the measured artifact and original input bytes.
// The retained positives and missing-cause cases alone cannot detect a substituted citation.
it.each(["artifact", "input-digest", "input-name", "source-location"] as const)(
  "rejects a source-audited host cause with altered %s",
  (mode) => {
    const { run, read } = nativeCapture("alacritty-pixel-geometry")
    const key = "collector.hostRecipes.extensions.osc52-read"
    const rawRecord = run.rawReplies[key]
    if (!rawRecord) throw new Error(`Alacritty fixture requires ${key}`)
    const record = JSON.parse(rawRecord) as {
      causes: Array<{
        cause: { artifactSha256: string; citation: { sha256: string; input: string; sourceLocation: string } }
      }>
    }
    const cause = record.causes[0]?.cause
    if (!cause) throw new Error("Alacritty fixture requires a source-audited cause")
    if (mode === "artifact") cause.artifactSha256 = "0".repeat(64)
    if (mode === "input-digest") cause.citation.sha256 = "0".repeat(64)
    if (mode === "input-name") cause.citation.input = "foreground-rgb"
    if (mode === "source-location") cause.citation.sourceLocation = ""
    run.rawReplies[key] = JSON.stringify(record)
    expect(() => read(run)).toThrow(/host recipe/i)
  },
)
