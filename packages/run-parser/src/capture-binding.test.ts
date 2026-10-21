/**
 * @failure A later or mismatched review changes a sealed status or reviews different capture/context bytes.
 * @level l1
 * @consumer Execution finalizer and sealed current-run parser
 * @testonly none
 */
import { describe, expect, it } from "vitest"
import { initializeRunDraft, sealRunDraft } from "@terminfo/probe-defs"
import { applyCaptureDecision, retainCaptureBinding } from "./index.ts"
const setup = () => {
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
