/**
 * @failure A later or mismatched review changes a sealed status or reviews different capture/context bytes.
 * @level l1
 * @consumer Execution finalizer and sealed current-run parser
 * @testonly none
 */
import { describe, expect, it } from "vitest"
import { initializeRunDraft, sealRunDraft, recordExecutedCapability } from "@terminfo/probe-defs"
import { applyCaptureDecision, retainCaptureBinding, parseRun } from "./index.ts"
const setup = (observed?: string) => {
  const draft = initializeRunDraft({
    runId: "review-capture",
    sourceRevision: "1".repeat(40),
    manifest: {
      probeHash: "capture-suite",
      adapterVersion: "3",
      catalogIds: ["sgr.bold"],
      probes: { app: ["sgr.bold"], headless: [], mux: [] },
    },
    intendedContext: { kind: "app", id: "kitty", version: "0.46.2", permissions: "pixels" },
  })
  draft.target = {
    kind: "app",
    id: "kitty",
    version: "0.46.2",
    os: "macos",
    osVersion: null,
    outerTerminal: null,
    mux: null,
    config: null,
    permissions: "pixels",
  }
  draft.identity = "verified"
  draft.measuredAt = "2026-10-21T05:00:00.000Z"
  draft.origin = { kind: "collector" }
  draft.rawReplies["sgr.bold"] = "captured trace"
  draft.results[0]!.rawReplyRef = "sgr.bold"
  draft.results[0]!.checks = [
    {
      id: "review",
      status: "test-todo",
      attempt: { scope: "none" },
      reason: "Required context-impossibility review pending",
    },
  ]
  if (observed !== undefined) {
    draft.rawReplies["sgr.bold"] = observed
    draft.results[0]!.evidence = "query"
    draft.assertions = [{ featureId: "sgr.bold", kind: "positive", expected: "ACK", observed, rawReplyRef: "sgr.bold" }]
    draft.results[0]!.checks.unshift({
      id: "capture",
      status: "supported",
      attempt: { scope: "probe", startedAt: "2026-10-21T05:00:00.000Z" },
      assertionRefs: [0],
    })
  }
  const artifact = retainCaptureBinding(draft, "sgr.bold")
  const decision = {
    id: "review-bold",
    runId: draft.runId,
    featureId: "sgr.bold",
    captureSha256: artifact.sha256,
    decision: "untestable",
    reviewed: true,
    reviewer: "reviewer",
    reason: "This context has no pixel plane; the configured plain stream cannot display glyphs",
    scope: {
      target: { kind: "app", id: "kitty" },
      versions: ["0.46.2", "0.46.2"],
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
      const review = sealed.results[0]!.checks.find((check) => check.id === "review")!
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
        probes: { app: ["sgr.bold"], headless: [], mux: [] },
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
      if (change === "context") draft.target!.permissions = "changed"
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
    draft.results[0]!.checks = []
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
    probes: { app: ["sgr.bold"], headless: [], mux: [] },
  }
  const parse = (run: unknown) =>
    parseRun("pending.json", JSON.stringify(run), ["sgr.bold"], new Map([[draft.probeHash, manifest]]))
  expect(() => parse({ ...draft, sealedAt: "2026-10-21T05:01:00.000Z" })).toThrow(/review pending/)
  draft.results[0]!.checks = []
  expect(parse(sealRunDraft(draft)).results?.[0]?.status).toBe("test-todo")
})
// Existing parser-only pixel fixtures did not cross the production result recorder.
it("preserves the pixel screenshot reference through recorder, seal and canonical parse", () => {
  const { draft } = setup()
  const ref = `sha256:${"a".repeat(64)}`
  draft.rawReplies["sgr.bold"] = JSON.stringify({ writes: ["x"], queries: [], events: [] })
  draft.screenshotRefs = [ref]
  draft.assertions = [
    { featureId: "sgr.bold", kind: "positive", expected: "bold glyph", observed: ref, rawReplyRef: "sgr.bold" },
  ]
  draft.results = [
    recordExecutedCapability({
      featureId: "sgr.bold",
      attempt: { scope: "probe", startedAt: "2026-10-21T05:00:00.000Z" },
      observation: {
        featureId: "sgr.bold",
        outcome: "supported",
        evidence: "pixels",
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
    probes: { app: ["sgr.bold"], headless: [], mux: [] },
  }
  expect(
    parseRun("pixels.json", JSON.stringify(sealRunDraft(draft)), ["sgr.bold"], new Map([[draft.probeHash, manifest]]))
      .results?.[0]?.status,
  ).toBe("supported")
  draft.results[0]!.checks[0]!.attempt = { scope: "none" }
  expect(() =>
    parseRun(
      "unattempted-pixels.json",
      JSON.stringify(sealRunDraft(draft)),
      ["sgr.bold"],
      new Map([[draft.probeHash, manifest]]),
    ),
  ).toThrow(/decided check.*no attempt/)
})
