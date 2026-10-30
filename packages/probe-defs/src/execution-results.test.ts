/**
 * @failure A broken framed comparison is hidden as pending review, or an explicitly required unstarted review becomes FAILURE/support.
 * @level l1
 * @consumer Native/headless execution recording and pre-seal finalizer
 * @testonly none
 */
import { expect, it } from "vitest"
import { ALL_PROBES, resolveProbeIds } from "./index.ts"
import {
  sgrCaptureFrames,
  recordExecutedProbe,
  finalizeProbeResult,
  replyFailure,
  withReplyFailureEvidence,
  recordCollectionFailure,
  initializeRunDraft,
  sealRunDraft,
  utf8DecodingRefusal,
  sgrProbe,
  readCollectorSelection,
  readCollectorAttempt,
  recordCollectorSelection,
  recordCollectorAttempt,
} from "./helpers.ts"
import { extensionsProbes } from "./extensions.ts"
import { deviceProbes } from "./device.ts"
import { modesProbes } from "./modes.ts"
import { resetProbes } from "./reset.ts"
import { sgrProbes } from "./sgr.ts"
import { unicodeProbes } from "./unicode.ts"
import { editingProbes } from "./editing.ts"
import { textProbes } from "./text.ts"
import { cropPositionRefusal } from "./region-readback.ts"
import type {
  CollectorAttempt,
  LibProbeSource,
  ObservationFrame,
  ProbeCallbackResult,
  TermProbeSource,
} from "./types.ts"
const attempt = { scope: "probe" as const, startedAt: "2026-10-21T05:00:00.000Z" }

// Callback-only reply markers must never become stored evidence fields. Existing tests
// did not pass callback metadata through the public finalizer's structural boundary.
it("strips callback-only reply metadata from stored result and draft serialization", () => {
  const callback = withReplyFailureEvidence("sgr.bold", replyFailure("No cursor reply"), {
    producer: "TTY",
    attempts: [{ sequence: "\x1b[6n", received: "", timeoutMs: 37 }],
  })
  const result = finalizeProbeResult({
    featureId: "sgr.bold",
    attempt,
    tests: callback.tests!.map((test) => ({ ...test, attempt })),
    ...{ replyFailureTestIds: ["criterion"] },
  })
  const draft = initializeRunDraft({
    runId: "reply-metadata",
    sourceRevision: "1".repeat(40),
    source: { kind: "live" },
    intendedSubject: { kind: "term", id: "kitty" },
    manifest: {
      schemaVersion: 4,
      probeHash: "reply-suite",
      adapterVersion: "3",
      catalogIds: ["sgr.bold"],
      probes: { term: ["sgr.bold"], lib: [], mux: [] },
    },
  })
  draft.results[0] = result
  expect(result.reason).toContain('sent "\\u001b[6n"; received ""; timeout 37 ms')
  expect(result).not.toHaveProperty("replyFailureTestIds")
  expect(JSON.stringify(draft)).not.toContain("replyFailureTestIds")
})

// One formatter owns the evidence template; unrelated failure reasons and grades stay untouched.
it.each([
  {
    producer: "TTY" as const,
    attempts: [{ sequence: "\x1b[6n", received: "", timeoutMs: 37 }],
    expected: 'sent "\\u001b[6n"; received ""; timeout 37 ms',
  },
  {
    producer: "headless" as const,
    attempts: [{ sequence: "\x1b[6n", received: "\x1b?", timeoutMs: null }],
    expected: 'sent "\\u001b[6n"; received "\\u001b?"; synchronous feed and getCursor boundary',
  },
  { producer: "TTY" as const, attempts: [], expected: "no completed TTY trace for this query" },
  { producer: "headless" as const, attempts: [], expected: "no headless capture recorded" },
])("retains only explicitly marked $producer failure evidence", ({ producer, attempts, expected }) => {
  const callback = replyFailure("No cursor reply")
  const unrelated = { id: "setup", status: "test-failure" as const, reason: "Fixture not established" }
  callback.tests.push(unrelated)
  const result = withReplyFailureEvidence("cursor.position-report", callback, { producer, attempts })
  expect(result.tests?.[0]).toMatchObject({ id: "criterion", status: "test-failure" })
  expect(result.tests?.[0]?.reason).toBe(`No cursor reply; ${expected}`)
  expect(result.tests?.[1]).toBe(unrelated)
  const unmarked: ProbeCallbackResult = { pass: false, tests: [unrelated] }
  expect(withReplyFailureEvidence("cursor.position-report", unmarked, { producer, attempts })).toBe(unmarked)
  expect(callback.tests[0].reason).toBe("No cursor reply")
})

it("names a callback defect instead of ignoring an invalid reply marker", () => {
  const callback = replyFailure("No cursor reply")
  callback.tests[0].status = "test-todo"
  expect(() => withReplyFailureEvidence("cursor.position-report", callback, { producer: "TTY", attempts: [] })).toThrow(
    /cursor\.position-report.*criterion.*test-failure/,
  )
})

// CTO consolidation contract: the registry owns unknown/duplicate IDs and catalogue ordering.
// Existing collector tests prove dispatch; they cannot pin this shared typed boundary.
it("resolves explicit probe IDs once in catalogue order with typed invalid and empty outcomes", () => {
  const first = ALL_PROBES[0]!
  const second = ALL_PROBES[1]!
  expect(resolveProbeIds([second.id, first.id])).toEqual({ result: "resolved", probes: [first, second] })
  expect(resolveProbeIds([])).toEqual({ result: "empty", probes: [] })
  expect(resolveProbeIds([first.id, "unknown", first.id, "unknown"])).toEqual({
    result: "invalid",
    unknownIds: ["unknown"],
    duplicateIds: [first.id, "unknown"],
  })
})

// AC3: callbacks alone cannot preserve an empty/pre-start attempt or distinguish it from legacy absence.
it.each([
  { ids: [], result: "empty" },
  { ids: ["selected"], result: "failed", error: "original\ntransport error" },
  { ids: ["selected"], result: "cancelled", error: "SIGINT", startedAt: attempt.startedAt },
  { ids: ["selected"], result: "completed", startedAt: attempt.startedAt, hostInputs: { clipboard: "not-supplied" } },
] satisfies CollectorAttempt[])("retains selected intent and $result without inventing output", (collection) => {
  const draft = initializeRunDraft({
    runId: "selected-attempt",
    sourceRevision: "1".repeat(40),
    source: { kind: "live" },
    intendedSubject: { kind: "term", id: "kitty" },
    manifest: {
      schemaVersion: 4,
      probeHash: "subset-suite",
      adapterVersion: "3",
      catalogIds: ["selected", "untouched"],
      probes: { term: ["selected", "untouched"], lib: [], mux: [] },
    },
  })
  recordCollectorSelection(draft, collection.ids)
  recordCollectorAttempt(draft, collection)
  expect(readCollectorSelection(draft.rawReplies)?.ids).toEqual(collection.ids)
  expect(readCollectorAttempt(draft.rawReplies)).toEqual(collection)
  expect(draft.results.map((result) => result.attempt)).toEqual([{ scope: "none" }, { scope: "none" }])
  // Raw-row acceptance: run-level selection alone cannot explain an untouched row.
  for (const result of draft.results) {
    expect(result.reason).toMatch(
      collection.ids.some((id) => id === result.featureId) ? /has not started/i : /not selected/i,
    )
  }
  expect(draft.runId).toBe("selected-attempt")
  // The accepted raw contract must be stable when native dispatch records the same schedule again.
  const retained = JSON.stringify(draft)
  recordCollectorSelection(draft, collection.ids)
  expect(JSON.stringify(draft)).toBe(retained)
})

it("keeps legacy absence distinct from malformed or newly completed collection evidence", () => {
  expect(readCollectorSelection({})).toBeUndefined()
  expect(readCollectorAttempt({})).toBeUndefined()
  const legacy = { ids: ["selected"], startedAt: attempt.startedAt }
  expect(readCollectorAttempt({ "collector.collectionAttempt": JSON.stringify(legacy) })).toEqual(legacy)
  expect(() => readCollectorSelection({ "collector.selection": "broken JSON" })).toThrow("collector.selection")
  expect(() =>
    readCollectorAttempt({ "collector.collectionAttempt": JSON.stringify({ ids: [], result: "completed" }) }),
  ).toThrow("recorded start")
})
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
  // Raw selection must preserve attempted results while a still-unstarted native schedule changes.
  const failed = structuredClone(draft.results[0])
  recordCollectorSelection(draft, ["unscheduled"])
  expect(draft.results[0]).toEqual(failed)
  expect(draft.results[3]).toBe(decided)
  expect(draft.results[1]!.reason).toMatch(/has not started/i)
  expect(draft.results[2]!.reason).toMatch(/not selected/i)
  recordCollectorSelection(draft, ["unimplemented"])
  expect(draft.results[1]!.reason).toMatch(/not selected/i)
  expect(draft.results[2]!.reason).toMatch(/has not started/i)
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

// Existing callback tests checked statuses, but did not pass these native fallbacks through the
// recorder. Removing their consumed observations must preserve the old persisted reason exactly.
it("preserves producer-specific native geometry refusal reasons without appending to query failures", async () => {
  const rows = [
    sgrProbe("fixture.sgr", "\x1b[1m", () => true),
    ...sgrProbes,
    ...extensionsProbes,
    ...deviceProbes,
    ...modesProbes,
    ...resetProbes,
  ]
  const cases = [
    ["fixture.sgr", "Cursor advance does not verify SGR styling", 2],
    ["sgr.underline-color-indexed", "Cursor advance does not verify SGR styling", 2],
    ["sgr.underline-color-reset", "Cursor advance does not verify the reset rendered", 3],
    ["sgr.selective-reset.bold", "Cursor advance does not verify SGR reset", 3],
    ["extensions.truecolor", "SGR was consumed; RGB cell color was not measured", 2],
    ["extensions.osc720-scroll-up", "Cursor answered; scrollback viewport was not measured", 2],
    ["extensions.osc8", "Cursor movement cannot verify OSC 8 link metadata or click behavior", 2],
    ...["xtpushsgr", "xtpopsgr", "xtsave", "xtrestore", "xtpushcolors", "xtpopcolors"].map(
      (name) => [`modes.${name}`, "Cursor responsiveness does not measure saved/restored state", 2] as const,
    ),
    ["reset.sgr", "Cursor advance does not measure SGR styling after reset", 2],
  ] as const
  for (const [id, priorNote, col] of cases) {
    const term = rows.find((row) => row.id === id)?.term
    if (!term) throw new Error(`Missing native callback ${id}`)
    for (const refusal of [undefined, "", "calibration G"]) {
      const callback = await term({
        rows: 24,
        cols: 80,
        write() {},
        captureGeometryRefusal: refusal,
        queryCursorPosition: async () => ({ row: 1, col }),
        queryWithSentinelOutcome: async () => ({ reason: "timeout", raw: "", match: null }),
      } as unknown as TermProbeSource)
      expect(record(callback).reason, `${id}: ${String(refusal)}`).toBe(
        `${priorNote}${refusal ? `; Pixel capture unavailable: ${refusal}` : ""}`,
      )
      expect(record(callback).status, id).toBe("test-todo")
      expect(callback.observation, id).toBeUndefined()
    }
  }
  const term = sgrProbes.find((row) => row.id === "sgr.underline-color-indexed")!.term!
  const wrong = await term({
    rows: 24,
    cols: 80,
    write() {},
    captureGeometryRefusal: "calibration G",
    queryCursorPosition: async () => ({ row: 1, col: 9 }),
    queryWithSentinelOutcome: async () => ({ reason: "timeout", raw: "", match: null }),
  } as unknown as TermProbeSource)
  expect(record(wrong)).toMatchObject({ status: "test-failure", reason: "Cursor advance does not verify SGR styling" })
  for (const [id, col, reason] of [
    ["sgr.underline-color-reset", 9, "Cursor advance does not verify the reset rendered"],
    ["sgr.selective-reset.bold", 9, "Cursor did not reach the expected position"],
    ["fixture.sgr", null, "No cursor response"],
    ["sgr.underline-color-indexed", null, "No cursor response"],
    ["sgr.underline-color-reset", null, "No cursor response"],
    ["sgr.selective-reset.bold", null, "no-response"],
    ["modes.xtpushsgr", null, "no-response"],
    ["reset.sgr", null, "no-response"],
  ] as const) {
    const callback = await rows.find((row) => row.id === id)!.term!({
      rows: 24,
      cols: 80,
      write() {},
      captureGeometryRefusal: "calibration G",
      queryCursorPosition: async () => (col === null ? null : { row: 1, col }),
      queryWithSentinelOutcome: async () => ({ reason: "timeout", raw: "", match: null }),
    } as unknown as TermProbeSource)
    expect(record(callback), id).toMatchObject({ status: "test-failure", reason })
  }
  const helperWrong = await rows[0]!.term!({
    rows: 24,
    cols: 80,
    write() {},
    captureGeometryRefusal: "calibration G",
    queryCursorPosition: async () => ({ row: 1, col: 9 }),
  } as unknown as TermProbeSource)
  expect(helperWrong.pass).toBe(false)
  expect(record(helperWrong)).toMatchObject({
    status: "test-todo",
    reason: "Cursor advance does not verify SGR styling; Pixel capture unavailable: calibration G",
  })
})

it("keeps native missing-observation note overrides and prompt consumption branches exact", async () => {
  for (const id of ["extensions.osc8", "device.xtwinops-22", "device.xtwinops-23"]) {
    const term = [...extensionsProbes, ...deviceProbes].find((row) => row.id === id)?.term
    if (!term) throw new Error(`Missing native callback ${id}`)
    for (const pos of [null, { row: 1, col: 2 }]) {
      // OSC8 has its own observation note when CPR is present; the title-stack callbacks never did.
      if (id === "extensions.osc8" && pos) continue
      for (const refusal of [undefined, "calibration G"]) {
        const callback = await term({
          rows: 24,
          cols: 80,
          write() {},
          captureGeometryRefusal: refusal,
          queryCursorPosition: async () => pos,
        } as unknown as TermProbeSource)
        expect(record(callback)).toMatchObject({
          status: "test-todo",
          reason: refusal ? `Pixel capture unavailable: ${refusal}` : callback.note,
        })
      }
    }
  }
  const prompt = extensionsProbes.find((row) => row.id === "extensions.osc133-a")!.term!
  for (const pos of [null, { row: 1, col: 1 }]) {
    const callback = await prompt({
      write() {},
      captureGeometryRefusal: "calibration G",
      queryCursorPosition: async () => pos,
    } as unknown as TermProbeSource)
    expect(record(callback)).toMatchObject(
      pos
        ? {
            status: "test-todo",
            reason:
              "Marker consumption was not confirmed; shell prompt integration was not observed; Pixel capture unavailable: calibration G",
          }
        : { status: "test-failure", reason: "No cursor reply after semantic prompt marker" },
    )
  }
  const libPrompt = extensionsProbes.find((row) => row.id === "extensions.osc133-a")!.lib!
  const libCallback = await libPrompt({
    feed() {},
    getCursor: () => ({ x: 0, y: 0 }),
    getCell: () => ({ char: "X" }),
    captureGeometryRefusal: "calibration G",
  } as unknown as LibProbeSource)
  expect(record(libCallback)).toMatchObject({
    status: "test-todo",
    reason: "Marker was consumed; shell prompt integration was not observed",
  })
})

it("preserves native callback note fallback for unmeasured widths and TERM_FEATURES", async () => {
  // These native callbacks retained no deciding cells. Their final failure reason previously
  // came from callback.note; status-only fixtures miss that producer-to-recorder loss.
  for (const id of ["extensions.osc22-pointer", "editing.decsace"]) {
    const term = [...extensionsProbes, ...editingProbes].find((row) => row.id === id)?.term
    if (!term) throw new Error(`Missing native callback ${id}`)
    const missing = await term({
      write() {},
      queryCursorPosition: async () => null,
    } as unknown as TermProbeSource)
    expect(missing.note).toMatch(/^No cursor response after /)
    expect(record(missing)).toMatchObject({ status: "test-failure", reason: missing.note })
  }
  for (const row of unicodeProbes) {
    if (!["unicode.east-asian-ambiguous", "unicode.grapheme-cursor"].includes(row.id)) continue
    if (!row.term) continue
    const callback = await row.term({
      cols: 80,
      measureRenderedWidth: async () => ({ kind: "no-reply", step: "sample" }) as const,
    } as unknown as TermProbeSource)
    expect(record(callback)).toMatchObject({
      status: "test-todo",
      reason: "sample width: no cursor-position readback at sample",
    })
  }
  const callback = await deviceProbes.find((row) => row.id === "device.term-features")!.term!({} as TermProbeSource)
  expect(callback.notTested).toEqual({
    reason: "no-semantic-observable",
    noObservable: "terminal child environment",
  })
  expect(
    recordExecutedProbe({
      featureId: "device.term-features",
      attempt,
      rawReplyRef: "device.term-features",
      assertions: [],
      coverage: {
        featureId: "device.term-features",
        ...callback.notTested!,
        rawReplyRef: "device.term-features",
      },
    }),
  ).toMatchObject({ status: "test-todo", reason: "terminal child environment" })
  for (const id of ["unicode.wrap-boundary", "unicode.tab-stops"]) {
    const term = unicodeProbes.find((row) => row.id === id)?.term
    if (!term) throw new Error(`Missing native callback ${id}`)
    const missing = await term({
      rows: 24,
      cols: 80,
      write() {},
      queryCursorPosition: async () => null,
    } as unknown as TermProbeSource)
    expect(record(missing)).toMatchObject({ status: "test-failure", reason: "No cursor response" })
  }
})

// These helpers serve both source kinds. Native used callback.note as the missing observation
// note, while lib did not; changing the shared helper would silently alter headless reasons.
it("preserves native note fallback at shared tab and checksum call sites without changing lib reasons", async () => {
  for (const [id, startCol] of [
    ["text.cht", 1],
    ["text.cbt", 21],
  ] as const) {
    const term = textProbes.find((row) => row.id === id)?.term
    if (!term) throw new Error(`Missing native callback ${id}`)
    let reads = 0
    const callback = await term({
      cols: 80,
      write() {},
      queryCursorPosition: async () => (++reads === 1 ? { row: 1, col: startCol } : null),
    } as unknown as TermProbeSource)
    expect(reads).toBe(2)
    expect(record(callback)).toMatchObject({ status: "test-failure", reason: "No cursor response" })
  }
  const checksum = editingProbes.find((row) => row.id === "editing.decrqcra")!
  const native = await checksum.term!({
    write() {},
    queryWithSentinelOutcome: async () => ({ reason: "timeout", raw: "", match: null }),
  } as unknown as TermProbeSource)
  expect(record(native)).toMatchObject({
    status: "test-failure",
    reason: "No complete checksum reply before the DA1 sentinel",
  })
  const lib = await checksum.lib!({ feed() {}, feedCapture: () => "" } as unknown as LibProbeSource)
  expect(record(lib)).toMatchObject({ status: "test-failure", reason: "no-response" })
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

// #31740: row-emission tests cannot pin whose reason the writer synthesizes when a callback forgets its rows.
it("names the writer default when an inconclusive capture callback omits its test rows", async () => {
  let next = 0
  const aligned = frames.map((frame) => ({ ...frame, regionRectangle: frames[0]!.regionRectangle }))
  const callback = await sgrCaptureFrames(
    { write() {}, capture: async () => aligned[next++]! } as unknown as TermProbeSource,
    "control",
    "target",
    "bold target",
    {},
    undefined,
    "normal control",
  )
  if (!callback.observation) throw new Error("Expected the existing captured visual-review observation")
  expect(callback.observation?.outcome).toBe("inconclusive")
  const { tests: _omitted, ...rowless } = callback
  const result = record(rowless)
  expect(result).toMatchObject({
    status: "test-failure",
    reason: "writer default: inconclusive observation without test rows; callback defect",
    tests: [
      {
        id: "criterion",
        status: "test-failure",
        reason: "writer default: inconclusive observation without test rows; callback defect",
      },
    ],
  })
  expect(result.frames).toEqual(aligned)
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
// their criterion facts without manufacturing either. Forward legacy pass to the real recorder
// so this case catches a future pass-based promotion instead of dropping the contradictory input.
it("records execution-only TODO and FAILURE tests, ignoring legacy pass even when true", () => {
  for (const status of ["test-todo", "test-failure"] as const) {
    const callback = {
      pass: true,
      response: "retained callback state",
      tests: [{ id: "criterion", status, reason: "No deciding observable was retained" }],
    } satisfies ProbeCallbackResult
    const result = recordExecutedProbe({
      ...callback,
      featureId: "sgr.bold",
      attempt,
      rawReplyRef: "sgr.bold",
      assertions: [],
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
// accept a trace with no retained artifact and capture identity.
it("starts schema 4 drafts with explicit live source and rejects an unbound trace", () => {
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
  expect(() => initializeRunDraft({ ...input, source: { kind: "trace" } } as never)).toThrow(/trace/i)
})
