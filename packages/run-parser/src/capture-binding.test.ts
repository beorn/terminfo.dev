/**
 * @failure A later or mismatched review changes a sealed status or reviews different capture/context bytes.
 * @level l1
 * @consumer Execution finalizer and sealed current-run parser
 * @testonly none
 */
import { describe, expect, it } from "vitest"
import { initializeRunDraft, sealRunDraft, recordExecutedProbe, finalizeProbeResult } from "@terminfo/probe-defs"
import { applyCaptureDecision, retainCaptureBinding, parseRun } from "./index.ts"
const setup = (observed?: string, sourceNegative?: { runId: string; startedAt: string }) => {
  const featureId = sourceNegative ? "sgr.faint" : "sgr.bold"
  const subject = sourceNegative
    ? { kind: "lib" as const, id: "vt100", version: "0.8.0", permissions: null }
    : { kind: "term" as const, id: "kitty", version: "0.46.2", permissions: "pixels" }
  const draft = initializeRunDraft({
    runId: sourceNegative?.runId ?? "review-capture",
    sourceRevision: "1".repeat(40),
    source: { kind: "live" },
    manifest: {
      schemaVersion: 4,
      probeHash: "capture-suite",
      adapterVersion: "3",
      catalogIds: [featureId],
      probes: { term: sourceNegative ? [] : [featureId], lib: sourceNegative ? [featureId] : [], mux: [] },
    },
    intendedSubject: subject,
  })
  draft.subject = {
    kind: subject.kind,
    id: subject.id,
    version: subject.version,
    os: sourceNegative ? "linux" : "macos",
    osVersion: null,
    outerTerminal: null,
    mux: null,
    config: null,
    permissions: subject.permissions,
  }
  draft.identity = "verified"
  draft.measuredAt = "2026-10-21T05:00:00.000Z"
  draft.origin = { kind: "collector" }
  draft.rawReplies[featureId] = "captured trace"
  draft.results[0]!.rawReplyRef = featureId
  draft.results[0]!.tests = [
    {
      id: "review",
      status: sourceNegative ? "test-failure" : "test-todo",
      attempt: { scope: "none" },
      reason: sourceNegative
        ? "Required source-negative review pending"
        : "Required context-impossibility review pending",
    },
  ]
  if (observed !== undefined) {
    draft.rawReplies[featureId] = observed
    draft.results[0]!.assertionType = sourceNegative ? "buffer_state" : "query_reply"
    draft.assertions = [
      {
        featureId,
        kind: "positive",
        assertionType: sourceNegative ? "buffer_state" : "query_reply",
        expected: sourceNegative ? "changed faint=true; restored faint=false" : "ACK",
        observed,
        rawReplyRef: featureId,
      },
    ]
    draft.results[0]!.tests.unshift({
      id: "capture",
      status: "supported",
      attempt: { scope: "probe", startedAt: "2026-10-21T05:00:00.000Z" },
      assertionRefs: [0],
    })
  }
  if (sourceNegative) {
    draft.results[0]!.criterionBranch = "source-negative-review"
    draft.rawReplies["collector.collectionAttempt"] = JSON.stringify({
      startedAt: sourceNegative.startedAt,
      ids: [featureId],
    })
    // These are explicit collector-input fixtures, not an engine execution or identity proof.
    draft.runtimeIdentity = {
      kind: "js",
      runtimeFormat: "js",
      engineVersion: "0.8.0",
      adapterVersion: "0.10.2",
      termlessRevision: "2".repeat(40),
      resolvedPath: "/fixtures/vt100/index.ts",
      integrity: {
        kind: "source",
        repository: "vterm",
        revision: "3".repeat(40),
        treeOid: "4".repeat(40),
        cleanTree: true,
      },
    }
    draft.results[0] = finalizeProbeResult(draft.results[0]!)
  }
  const artifact = retainCaptureBinding(draft, featureId)
  const decision = {
    id: "review-bold",
    runId: draft.runId,
    featureId,
    captureSha256: artifact.sha256,
    decision: "untestable",
    reviewed: true,
    reviewer: "reviewer",
    reason: "This context has no pixel plane; the configured plain stream cannot display glyphs",
    scope: {
      subject: { kind: subject.kind, id: subject.id },
      versions: [subject.version, subject.version],
      suites: ["capture-suite", "capture-suite"],
    },
    sources: [artifact.rawReplyRef],
    supersedes: [],
  }
  return { draft, artifact, decision }
}
// Existing final-run SHA review tests cannot catch a circular pre-seal binding or status changes
// authorized by a different capture. This exercises the actual execution helper and exact bytes.
describe("immutable pre-seal capture binding", () => {
  // FINAL B1/B2/B4: existing cases intentionally reject a different run and never attempt to
  // reuse a source-negative decision. Exercise the real applier with retained state, not a new seam.
  it("reuses a source-negative review across cohorts without changing its origin run or capture evidence", () => {
    const observed = JSON.stringify({
      original: { faint: false },
      changed: { faint: false },
      restored: { faint: false },
    })
    const origin = setup(observed, { runId: "source-origin", startedAt: "2026-10-27T11:00:00.000Z" })
    const current = setup(observed, { runId: "source-current", startedAt: "2026-10-27T11:01:00.000Z" })
    origin.decision.decision = "unsupported"
    origin.decision.reason = "Reviewed source and retained state establish the negative"
    origin.decision.sources = ["vterm@d7f69fe916ed44d1e01d24b9a079f6b96ba86cb5:packages/vt100/src/screen.ts:444-498"]
    const decisionBytes = JSON.stringify(origin.decision)
    const originalCapture = origin.artifact.source
    expect(current.draft.results[0]!.status).toBe("test-failure")
    applyCaptureDecision(current.draft, decisionBytes, "2026-10-27T11:02:00.000Z")
    expect(current.draft.results[0]!.status).toBe("unsupported")
    expect(current.draft.rawReplies["collector.review.review-bold"]).toBe(decisionBytes)
    expect(current.draft.assertions.at(-1)).toMatchObject({
      kind: "negative",
      assertionType: "buffer_state",
      expected: "changed faint=true; restored faint=false",
      observed,
    })
    expect(origin.decision.runId).toBe("source-origin")
    expect(origin.artifact.source).toBe(originalCapture)
    expect(JSON.stringify(origin.decision)).toBe(decisionBytes)
  })
  // FINAL B4: only the review's failure may be decided; a separate failed condition still wins.
  // Existing TODO reviews and finalizer-only tests do not cross this failed-review application boundary.
  it.each([false, true])(
    "decides only the source-negative review failure; unrelated failure=%s",
    (unrelatedFailure) => {
      const { draft, decision } = setup(JSON.stringify({ faint: false }), {
        runId: "same-source-cohort",
        startedAt: "2026-10-27T11:00:00.000Z",
      })
      decision.decision = "unsupported"
      if (unrelatedFailure) {
        draft.results[0]!.tests.push({
          id: "cleanup",
          status: "test-failure",
          attempt: { scope: "probe", startedAt: "2026-10-27T11:00:00.000Z" },
          reason: "Restoration could not be verified",
        })
      }
      expect(draft.results[0]!.status).toBe("test-failure")
      applyCaptureDecision(draft, JSON.stringify(decision), "2026-10-27T11:02:00.000Z")
      expect(draft.results[0]!.tests.find((test) => test.id === "review")?.status).toBe("unsupported")
      expect(draft.results[0]!.status).toBe(unrelatedFailure ? "test-failure" : "unsupported")
      if (unrelatedFailure)
        expect(draft.results[0]!.tests.find((test) => test.id === "cleanup")?.status).toBe("test-failure")
    },
  )
  // FINAL B4 negative control: granting this criterion never admits an arbitrary failed review.
  it("keeps the existing TODO-only eligibility for a different criterion", () => {
    const { draft, decision } = setup("NO")
    draft.results[0]!.tests.find((test) => test.id === "review")!.status = "test-failure"
    draft.results[0] = finalizeProbeResult(draft.results[0]!)
    decision.decision = "unsupported"
    expect(() => applyCaptureDecision(draft, JSON.stringify(decision), "2026-10-27T11:02:00.000Z")).toThrow(
      /pending required review/,
    )
    expect(draft.results[0]!.status).toBe("test-failure")
  })
  it("keeps valid pending review unsealed, records the exact typed decision, then seals the same run", () => {
    const { draft, artifact, decision } = setup()
    expect(() => sealRunDraft(draft)).toThrow(/review pending/)
    applyCaptureDecision(draft, JSON.stringify(decision), "2026-10-21T05:01:00.000Z")
    const sealed = sealRunDraft(draft)
    expect(sealed.runId).toBe("review-capture")
    expect(sealed.results[0]!.status).toBe("untestable")
    expect(sealed.results[0]!.reason).toBe(decision.reason)
    expect(sealed.rawReplies["collector.review.review-bold"]).toBe(JSON.stringify(decision))
    expect(sealed.rawReplies[artifact.rawReplyRef]).toBe(artifact.source)
  })
  // A reviewed negative must retain TESTED/EXPECTED and the original capture hash; the old
  // Untestable-only review fixture cannot catch status-only mutation or a circular assertion hash.
  it.each(["supported", "unsupported"] as const)(
    "seals a typed %s review with its actual expected/observed assertion",
    (status) => {
      const { draft, artifact, decision } = setup(status === "supported" ? "ACK" : "NO")
      decision.decision = status
      decision.reason = "Reviewed retained ACK criterion and captured response"
      applyCaptureDecision(draft, JSON.stringify(decision), "2026-10-21T05:01:00.000Z")
      const sealed = sealRunDraft(draft)
      expect(sealed.results[0]!.status).toBe(status)
      expect(sealed.rawReplies[artifact.rawReplyRef]).toBe(artifact.source)
      const review = sealed.results[0]!.tests.find((check) => check.id === "review")!
      expect(review.assertionRefs?.length).toBe(1)
      const assertion = sealed.assertions[review.assertionRefs![0]!]!
      expect(assertion).toMatchObject({
        kind: status === "supported" ? "positive" : "negative",
        expected: "ACK",
        observed: status === "supported" ? "ACK" : "NO",
      })
      const manifest = {
        probeHash: draft.probeHash,
        adapterVersion: "3",
        catalogIds: ["sgr.bold"],
        probes: { term: ["sgr.bold"], lib: [], mux: [] },
      }
      const parsed = parseRun(
        "reviewed-current.json",
        JSON.stringify(sealed),
        ["sgr.bold"],
        new Map([[draft.probeHash, manifest]]),
      )
      expect(parsed.results?.[0]?.status).toBe(status)
      expect(() =>
        parseRun(
          "tampered-current.json",
          JSON.stringify({ ...sealed, rawReplies: { ...sealed.rawReplies, "sgr.bold": "changed capture" } }),
          ["sgr.bold"],
          new Map([[draft.probeHash, manifest]]),
        ),
      ).toThrow(/capture|raw|bound/)
    },
  )

  it.each(["raw", "context", "source", "suite", "feature", "run"])(
    "rejects review after %s binding changes",
    (change) => {
      const { draft, decision } = setup()
      if (change === "raw") draft.rawReplies["sgr.bold"] = "different trace"
      if (change === "context") draft.subject!.permissions = "changed"
      if (change === "source") draft.sourceRevision = "2".repeat(40)
      if (change === "suite") draft.probeHash = "different-suite"
      if (change === "feature") decision.featureId = "different-feature"
      if (change === "run") draft.runId = "different-run"
      expect(() => applyCaptureDecision(draft, JSON.stringify(decision), "2026-10-21T05:01:00.000Z")).toThrow(
        /capture|scope|catalogue|runId/,
      )
      expect(draft.results[0]!.status).toBe("test-todo")
    },
  )
  it("cannot apply or replace a review to an already sealed TODO run", () => {
    const { draft, decision } = setup()
    draft.results[0]!.tests = []
    const sealed = sealRunDraft(draft)
    expect(() => applyCaptureDecision(sealed as never, JSON.stringify(decision), "2026-10-21T05:01:00.000Z")).toThrow(
      /sealed/,
    )
  })
})

// Writer refusal alone missed forged sealedAt at the canonical decoder boundary.
it("refuses a supplied seal on pending review while accepting ordinary sealed implementation TODO", () => {
  const { draft } = setup()
  const manifest = {
    probeHash: draft.probeHash,
    adapterVersion: "3",
    catalogIds: ["sgr.bold"],
    probes: { term: ["sgr.bold"], lib: [], mux: [] },
  }
  const parse = (run: unknown) =>
    parseRun("pending.json", JSON.stringify(run), ["sgr.bold"], new Map([[draft.probeHash, manifest]]))
  expect(() => parse({ ...draft, sealedAt: "2026-10-21T05:01:00.000Z" })).toThrow(/review pending/)
  draft.results[0]!.tests = []
  expect(parse(sealRunDraft(draft)).results?.[0]?.status).toBe("test-todo")
})
// Existing parser-only pixel fixtures did not cross the production result recorder.
it("preserves the pixel screenshot reference through recorder, seal and canonical parse", () => {
  const { draft } = setup()
  const ref = `sha256:${"a".repeat(64)}`
  draft.rawReplies["sgr.bold"] = JSON.stringify({ writes: ["x"], queries: [], events: [] })
  draft.screenshotRefs = [ref]
  draft.assertions = [
    {
      featureId: "sgr.bold",
      kind: "positive",
      assertionType: "screenshot",
      expected: "bold glyph",
      observed: ref,
      rawReplyRef: "sgr.bold",
    },
  ]
  draft.results = [
    recordExecutedProbe({
      featureId: "sgr.bold",
      attempt: { scope: "probe", startedAt: "2026-10-21T05:00:00.000Z" },
      observation: {
        featureId: "sgr.bold",
        outcome: "supported",
        assertionType: "screenshot",
        screenshotRef: ref,
        rawReplyRef: "sgr.bold",
        frames: [
          { role: "control", label: "normal glyph", ref, capturedAt: 0 },
          { role: "target", label: "bold glyph", ref, capturedAt: 1 },
        ],
      },
      assertions: draft.assertions,
    }),
  ]
  expect(draft.results[0]!.screenshotRef).toBe(ref)
  const manifest = {
    probeHash: draft.probeHash,
    adapterVersion: "3",
    catalogIds: ["sgr.bold"],
    probes: { term: ["sgr.bold"], lib: [], mux: [] },
  }
  expect(
    parseRun("pixels.json", JSON.stringify(sealRunDraft(draft)), ["sgr.bold"], new Map([[draft.probeHash, manifest]]))
      .results?.[0]?.status,
  ).toBe("supported")
  draft.results[0]!.tests[0]!.attempt = { scope: "none" }
  expect(() =>
    parseRun(
      "unattempted-pixels.json",
      JSON.stringify(sealRunDraft(draft)),
      ["sgr.bold"],
      new Map([[draft.probeHash, manifest]]),
    ),
  ).toThrow(/decided test.*no attempt/)
})

// The current-writer tests cannot detect re-hashing an old capture with renamed keys. This fixture
// retains the schema-3 binding representation and hashes its original assertion before projection.
it("validates historical review bindings against original keys and assertion bytes", async () => {
  const { createHash } = await import("node:crypto")
  const hash = (value: string) => createHash("sha256").update(value).digest("hex")
  const featureId = "sgr.bold"
  const target = {
    kind: "app",
    id: "kitty",
    version: "0.46.2",
    os: "macos",
    osVersion: null,
    outerTerminal: null,
    mux: null,
    config: null,
    permissions: null,
  }
  const intendedContext = { kind: "app", id: "kitty", version: "0.46.2" }
  const assertion = { featureId, kind: "positive", rawReplyRef: featureId, expected: "ACK", observed: "ACK" }
  const binding = JSON.stringify({
    runId: "historical-reviewed",
    probeHash: "old-capture-suite",
    sourceRevision: "1".repeat(40),
    intendedContext,
    target,
    featureId,
    rawReplyRefs: [{ key: featureId, sha256: hash("ACK") }],
    assertionRefs: [{ index: 0, sha256: hash(JSON.stringify(assertion)) }],
    frames: [],
    evidence: "query",
  })
  const review = {
    id: "old-review",
    runId: "historical-reviewed",
    featureId,
    captureSha256: hash(binding),
    decision: "supported",
    reviewed: true,
    reviewer: "reviewer",
    reason: "Retained ACK establishes the criterion",
    scope: {
      target: { kind: "app", id: "kitty" },
      versions: [target.version, target.version],
      suites: ["old-capture-suite", "old-capture-suite"],
    },
    sources: ["collector.capture.sgr.bold"],
    supersedes: [],
  }
  const attempt = { scope: "probe", startedAt: "2026-10-21T05:00:00.000Z" }
  const raw = {
    schemaVersion: 3,
    runId: review.runId,
    target,
    intendedContext,
    identity: "verified",
    suiteId: "old-capture-suite",
    probeHash: "old-capture-suite",
    sourceRevision: "1".repeat(40),
    measuredAt: attempt.startedAt,
    sealedAt: "2026-10-21T05:01:00.000Z",
    origin: { kind: "collector" },
    rawReplies: {
      [featureId]: "ACK",
      "collector.capture.sgr.bold": binding,
      "collector.review.old-review": JSON.stringify(review),
    },
    assertions: [assertion, { ...assertion, note: "Reviewed" }],
    screenshotRefs: [],
    results: [
      {
        featureId,
        status: "supported",
        attempt,
        rawReplyRef: featureId,
        evidence: "query",
        reviewRef: "collector.review.old-review",
        reason: review.reason,
        checks: [
          { id: "capture", status: "supported", attempt, assertionRefs: [0] },
          {
            id: "review",
            status: "supported",
            attempt,
            assertionRefs: [1],
            reviewRef: "collector.review.old-review",
            reason: review.reason,
          },
        ],
      },
    ],
  }
  const source = JSON.stringify(raw, null, 2)
  const manifest = {
    probeHash: "old-capture-suite",
    adapterVersion: "3",
    catalogIds: [featureId],
    probes: { term: [featureId], lib: [], mux: [] },
  }
  const parsed = parseRun("old-reviewed.json", source, [featureId], new Map([[manifest.probeHash, manifest]]))
  expect(parsed.schemaVersion).toBe(3)
  expect(parsed.sha256).toBe(hash(source))
  expect(parsed).not.toHaveProperty("source")
  expect(parsed.rawReplies["collector.capture.sgr.bold"]).toBe(binding)
  expect(parsed.results?.[0]?.status).toBe("supported")
  expect(parsed.results?.[0]).not.toHaveProperty("checks")
  expect(parsed.assertions[0]?.assertionType).toBe("query_reply")
  const changed = { ...raw, rawReplies: { ...raw.rawReplies, [featureId]: "NO" } }
  expect(() =>
    parseRun("changed.json", JSON.stringify(changed), [featureId], new Map([[manifest.probeHash, manifest]])),
  ).toThrow(/binding changed/)
})
