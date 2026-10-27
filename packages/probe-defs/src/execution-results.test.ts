/**
 * @failure A broken framed comparison is hidden as pending review, or an explicitly required unstarted review becomes FAILURE/support.
 * @level l1
 * @consumer Native/headless execution recording and pre-seal finalizer
 * @testonly none
 */
import { expect, it } from "vitest"
import {
  sgrCaptureFrames,
  recordExecutedProbe,
  recordCollectionFailure,
  initializeRunDraft,
  sealRunDraft,
  utf8DecodingRefusal,
} from "./helpers.ts"
import { extensionsProbes } from "./extensions.ts"
import { cropPositionRefusal } from "./region-readback.ts"
import type { ObservationFrame, ProbeCallbackResult, TermProbeSource } from "./types.ts"
const attempt = { scope: "probe" as const, startedAt: "2026-10-21T05:00:00.000Z" }
// Full-catalog drafts previously let a failed subset dispatch mark unscheduled capabilities failed.
it("records collection failure only for delegated unfinished IDs", () => {
  const draft = initializeRunDraft({
    runId: "subset",
    sourceRevision: "1".repeat(40),
    source: { kind: "live" },
    intendedSubject: { kind: "term", id: "kitty" },
    manifest: {
      schemaVersion: 4,
      probeHash: "subset-suite",
      adapterVersion: "3",
      catalogIds: ["selected", "unscheduled", "unimplemented", "decided"],
      probes: { term: ["selected", "unscheduled", "decided"], lib: [], mux: [] },
    },
  })
  const decided = {
    ...draft.results[3]!,
    status: "supported" as const,
    attempt,
    tests: [{ id: "criterion", status: "supported" as const, attempt }],
  }
  draft.results[3] = decided
  recordCollectionFailure(draft, attempt.startedAt, "transport broke", ["selected", "decided"])
  expect(draft.results.map((result) => result.status)).toEqual(["test-failure", "test-todo", "test-todo", "supported"])
  expect(draft.results[0]?.attempt).toEqual({
    scope: "collection",
    startedAt: attempt.startedAt,
    diagnosticRef: "collector.failure",
  })
  expect(draft.results[1]?.attempt).toEqual({ scope: "none" })
  expect(draft.results[2]?.attempt).toEqual({ scope: "none" })
  expect(draft.results[3]).toBe(decided)
})
const frames: ObservationFrame[] = [
  {
    role: "control",
    label: "normal glyph",
    ref: `sha256:${"a".repeat(64)}`,
    capturedAt: 1,
    regionRectangle: { x: 0, y: 0, width: 10, height: 20 },
  },
  {
    role: "target",
    label: "bold glyph",
    ref: `sha256:${"b".repeat(64)}`,
    capturedAt: 2,
    regionRectangle: { x: 0, y: 26, width: 10, height: 20 },
  },
]
const record = (callback: ProbeCallbackResult) =>
  recordExecutedProbe({
    featureId: "sgr.bold",
    attempt,
    rawReplyRef: "sgr.bold",
    ...(callback.observation && {
      observation: { ...callback.observation, featureId: "sgr.bold", rawReplyRef: "sgr.bold" },
    }),
    tests: callback.tests,
    criterionBranch: callback.criterionBranch,
    assertions: (callback.assertions ?? []).map((assertion) => ({
      ...assertion,
      featureId: "sgr.bold",
      rawReplyRef: "sgr.bold",
    })),
  })
// Prior tests only inspected the retained frames/inconclusive observation. These exercise both real
// callback branches through the production result recorder and seal boundary, where the bug lived.
it("records the actual unequal-crop comparison as TEST FAILURE despite two retained frames", () => {
  const callback = cropPositionRefusal({
    id: "sgr.bold",
    compared: frames.map((frame) => ({ role: frame.role, rectangle: frame.regionRectangle })),
    response: "measured unequal crop positions",
    frames,
    screenshotRef: frames[1]!.ref,
  })
  if (!callback) throw new Error("Expected actual crop-position refusal")
  const result = record(callback)
  expect(result.status).toBe("test-failure")
  expect(result.frames).toEqual(frames)
  expect(result.tests).toContainEqual(expect.objectContaining({ id: "comparison", status: "test-failure", attempt }))
})
it("keeps an explicit unattempted visual review TODO and the capture unsealed", async () => {
  let next = 0
  const callback = await sgrCaptureFrames(
    { write() {}, capture: async () => frames[next++]! } as unknown as TermProbeSource,
    "control",
    "target",
    "bold target",
    {},
    undefined,
    "normal control",
  )
  expect(callback.tests).toContainEqual(expect.objectContaining({ id: "review", status: "test-todo" }))
  const result = record(callback)
  expect(result.status).toBe("test-todo")
  expect(result.tests.find((check) => check.id === "review")?.attempt).toEqual({ scope: "none" })
  expect(callback.assertions?.[0]?.expected).toContain("bold target")
  expect(callback.assertions?.[0]?.observed).toContain(frames[1]!.ref)
  const draft = initializeRunDraft({
    runId: "pending-review",
    sourceRevision: "1".repeat(40),
    manifest: {
      schemaVersion: 4,
      probeHash: "explicit-check-suite",
      adapterVersion: "3",
      catalogIds: ["sgr.bold"],
      probes: { term: ["sgr.bold"], lib: [], mux: [] },
    },
    source: { kind: "live" },
    intendedSubject: { kind: "term", id: "kitty" },
  })
  draft.subject = {
    kind: "term",
    id: "kitty",
    version: "1",
    os: "macos",
    osVersion: null,
    outerTerminal: null,
    mux: null,
    config: null,
    permissions: null,
  }
  draft.identity = "unverified"
  draft.measuredAt = attempt.startedAt
  draft.origin = { kind: "collector" }
  draft.results = [result]
  expect(() => sealRunDraft(draft)).toThrow(/review pending/)
})

// The existing visual-review fixture does not exercise the measured, repairable locale prerequisite.
it("keeps measured 8-bit decoding as unmet UTF-8 prerequisite TODO without inventing a review", async () => {
  const callback = await utf8DecodingRefusal(
    { utf8Decoding: async () => "8-bit" } as unknown as TermProbeSource,
    "sgr.bold",
  )
  if (!callback) throw new Error("Expected measured 8-bit prerequisite")
  const result = record(callback)
  expect(result.status).toBe("test-todo")
  expect(result.criterionBranch).toBe("utf8-prerequisite")
  expect(result.tests).toEqual([
    expect.objectContaining({ id: "utf8-context", status: "test-todo", attempt: { scope: "none" } }),
  ])
  expect(result.tests.some((check) => check.id === "review")).toBe(false)
})

it("records adapted C154 semantic-mark callback outcomes as TODO or FAILURE with rawReplyRef and no unreviewed Untestable", async () => {
  const osc133a = extensionsProbes.find((entry) => entry.id === "extensions.osc133-a")
  if (!osc133a?.term) throw new Error("Expected extensions.osc133-a app callback")
  const recordC154 = (callback: ProbeCallbackResult) =>
    recordExecutedProbe({
      featureId: osc133a.id,
      attempt,
      rawReplyRef: osc133a.id,
      ...(callback.observation && {
        observation: { ...callback.observation, featureId: osc133a.id, rawReplyRef: osc133a.id },
      }),
      ...(callback.notTested && {
        coverage: { featureId: osc133a.id, ...callback.notTested, rawReplyRef: osc133a.id },
      }),
      tests: callback.tests,
      criterionBranch: callback.criterionBranch,
      assertions: [],
    })

  // 1. Consumed-but-unqualified (home 1;1 -> target 1;2 -> control 1;2) stays TEST TODO, never Unsupported or Untestable.
  const unqualifiedReads = [
    { row: 1, col: 1 },
    { row: 1, col: 2 },
    { row: 1, col: 2 },
  ]
  let unqualifiedIndex = 0
  const unqualifiedCallback = await osc133a.term({
    write() {},
    queryCursorPosition: async () => unqualifiedReads[unqualifiedIndex++] ?? null,
  } as unknown as TermProbeSource)
  const unqualifiedRecorded = recordC154(unqualifiedCallback)
  expect(unqualifiedRecorded.status).toBe("test-todo")
  expect(unqualifiedRecorded.assertionType).toBeUndefined()
  expect(unqualifiedRecorded.rawReplyRef).toBe("extensions.osc133-a")
  expect(unqualifiedRecorded.tests).toEqual([
    expect.objectContaining({
      id: "criterion",
      status: "test-todo",
      attempt: { scope: "none" },
      rawReplyRef: "extensions.osc133-a",
    }),
  ])

  // 2. Null CPR reply records TEST FAILURE with query evidence and rawReplyRef, never Unsupported or Untestable.
  const nullCallback = await osc133a.term({
    write() {},
    queryCursorPosition: async () => null,
  } as unknown as TermProbeSource)
  const nullRecorded = recordC154(nullCallback)
  expect(nullRecorded.status).toBe("test-failure")
  expect(nullRecorded.assertionType).toBeUndefined()
  expect(nullRecorded.rawReplyRef).toBe("extensions.osc133-a")
  expect(nullRecorded.reason).toBe("No cursor reply after semantic prompt marker")
  expect(nullRecorded.tests).toEqual([
    expect.objectContaining({
      id: "criterion",
      status: "test-failure",
      attempt,
      rawReplyRef: "extensions.osc133-a",
      reason: "No cursor reply after semantic prompt marker",
    }),
  ])

  // 3. Qualified home/target/control sequence emits no-semantic-observable coverage, which records as TEST TODO
  // (never automatic Untestable without a downstream resolved reviewRef).
  const qualifiedReads = [
    { row: 1, col: 1 },
    { row: 1, col: 2 },
    { row: 1, col: 1 },
  ]
  let qualifiedIndex = 0
  const qualifiedCallback = await osc133a.term({
    write() {},
    queryCursorPosition: async () => qualifiedReads[qualifiedIndex++] ?? null,
  } as unknown as TermProbeSource)
  expect(qualifiedCallback.notTested).toEqual({
    reason: "no-semantic-observable",
    noObservable: "OSC 133;A prompt-start mark registration",
  })
  const qualifiedRecorded = recordC154(qualifiedCallback)
  expect(qualifiedRecorded.status).toBe("test-todo")
  expect(qualifiedRecorded.rawReplyRef).toBe("extensions.osc133-a")
  expect(qualifiedRecorded.reason).toBe("OSC 133;A prompt-start mark registration")
  expect(qualifiedRecorded.tests).toEqual([
    expect.objectContaining({
      id: "criterion",
      status: "test-todo",
      attempt: { scope: "none" },
      rawReplyRef: "extensions.osc133-a",
      reason: "OSC 133;A prompt-start mark registration",
    }),
  ])
})

// Existing tests all supplied an observation or coverage. Execution-only callbacks must preserve
// their criterion facts without manufacturing either, and diagnostic pass never grades those facts.
it("records execution-only TODO and FAILURE tests, ignoring legacy pass even when true", () => {
  for (const status of ["test-todo", "test-failure"] as const) {
    const callback = {
      pass: true,
      response: "retained callback state",
      tests: [{ id: "criterion", status, reason: "No deciding observable was retained" }],
    } satisfies ProbeCallbackResult
    const result = recordExecutedProbe({
      featureId: "sgr.bold",
      attempt,
      rawReplyRef: "sgr.bold",
      assertions: [],
      tests: callback.tests,
    })
    expect(result.status).toBe(status)
    expect(result.tests).toEqual([
      {
        id: "criterion",
        status,
        reason: "No deciding observable was retained",
        attempt: status === "test-todo" ? { scope: "none" } : attempt,
        assertionRefs: [],
        rawReplyRef: "sgr.bold",
      },
    ])
    expect(result).not.toHaveProperty("assertionType")
  }
})

// Source identity was previously absent. The writer must name it rather than infer live or
// accept trace before the recorder/replay implementation owned by #30932 exists.
it("starts schema 4 drafts with explicit live source and rejects unimplemented trace", () => {
  const input = {
    runId: "source-boundary",
    sourceRevision: "1".repeat(40),
    source: { kind: "live" as const },
    intendedSubject: { kind: "term" as const, id: "kitty" },
    manifest: {
      schemaVersion: 4 as const,
      probeHash: "source-suite",
      adapterVersion: "4",
      catalogIds: ["sgr.bold"],
      probes: { term: ["sgr.bold"], lib: [], mux: [] },
    },
  }
  expect(initializeRunDraft(input)).toMatchObject({
    schemaVersion: 4,
    source: { kind: "live" },
    intendedSubject: { kind: "term", id: "kitty" },
  })
  expect(() => initializeRunDraft({ ...input, source: { kind: "trace" } } as never)).toThrow(
    /trace.*no implementation/i,
  )
})
