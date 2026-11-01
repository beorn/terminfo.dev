/**
 * @failure A later or mismatched review changes a sealed status or reviews different capture/context bytes.
 * @level l1
 * @consumer Execution finalizer and sealed current-run parser
 * @testonly none
 */
import { describe, expect, it } from "vitest"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import {
  initializeRunDraft,
  sealRunDraft,
  recordExecutedProbe,
  finalizeProbeResult,
  REPLY_PATH_AUDIT_REVIEW,
  SEMANTIC_PROMPT_SOURCE_REVIEW,
  HARNESS_INCOMPLETE_TEST,
  nativeHostRecipeResult,
  type LibProbeSource,
  HEADLESS_OBSERVABLE_REVIEW,
  UNTESTABLE_ONLY_REVIEW_BRANCHES,
  recordCollectorSelection,
  recordCollectorAttempt,
  type RunDraft,
  ALL_PROBES,
  readCollectorAttempt,
  type HostRecipeExpectation,
  type HeadlessRuntimeIdentity,
  type CaptureEvidence,
} from "@terminfo/probe-defs"
import { fakeProbeResult } from "@terminfo/probe-defs/testing/fake-probe-result"
import {
  applyCaptureDecision,
  retainCaptureBinding,
  parseRun,
  decodeCollectorDraft,
  canonicalJson,
  FEATURE_ENTRY_PROSE_DENYLIST,
  boundFeatureEntry,
} from "./index.ts"
import { finalizeHeadlessAttempt, createLibProbeSource } from "../../probes/headless-batch.ts"
import { createVt100Backend } from "@termless/vt100"
import { createVt220Backend } from "@termless/vt220"
import { libProbeSource } from "../../probe-defs/src/testing/group-harness.ts"
import { createSemanticSurface } from "../../probe-defs/src/testing/semantic-surface.ts"

// Empty HTTP transport is a real initialized draft, not a truncated measured capture.
// Sealed-run binding tests never decode the unmeasured collector response boundary.
// Raw selection AC2: preserve both computed empty forms and reject altered row evidence.
it.each(["empty", "legacy-empty", "reason", "status", "scope", "captured"])(
  "decodes collector %s through its typed draft arm",
  (mode) => {
    const manifest = {
      schemaVersion: 4 as const,
      probeHash: "capture-suite",
      adapterVersion: "3",
      catalogIds: ["sgr.bold"],
      probes: { term: ["sgr.bold"], lib: [], mux: [] },
    }
    const draft =
      mode === "captured"
        ? setup().draft
        : initializeRunDraft({
            runId: "empty-selection",
            sourceRevision: "1".repeat(40),
            source: { kind: "live" },
            intendedSubject: { kind: "term", id: "kitty" },
            manifest,
          })
    if (mode === "captured") draft.identity = "unverified"
    else {
      const originalRows = structuredClone(draft.results)
      recordCollectorSelection(draft, [])
      recordCollectorAttempt(draft, { ids: [], result: "empty" })
      if (mode === "legacy-empty") draft.results = originalRows
      else if (mode === "empty") expect(draft.results[0]!.reason).toMatch(/not selected/i)
    }
    if (mode === "reason") draft.results[0]!.reason = "unrecorded selection explanation"
    if (mode === "status") draft.results[0]!.status = "supported"
    if (mode === "scope") draft.results[0]!.attempt = { scope: "probe", startedAt: "2026-10-29T06:00:00Z" }
    const decode = () => decodeCollectorDraft("selection.draft.json", JSON.stringify(draft), manifest, "1".repeat(40))
    const bytes = JSON.stringify(draft)
    if (mode === "status" || mode === "scope" || mode === "reason") {
      expect(decode).toThrow(`results[0].${mode === "scope" ? "attempt.scope" : mode}`)
    } else {
      expect(decode()).toMatchObject({
        kind: mode === "captured" ? "captured" : "empty-selection",
        run: draft,
        raw: bytes,
      })
      expect(JSON.stringify(draft)).toBe(bytes)
    }
  },
)

// H1-H7: explicit collector-input fixture, not an engine execution or qualification proof.
// Existing immutable-binding tests cannot reject an invalid cause before the first binding exists.
const HOST_QUERY = "\x1b]10;?\x07"
function hostCauseCapture(
  mode: string,
  query: string,
  split: boolean,
  finalization?: "completed" | "failed" | "cancelled" | "stale" | "tampered",
) {
  const featureId = "host.fixture",
    runId = "host-custody",
    artifact = "a".repeat(64),
    startedAt = "2026-10-28T19:00:00.000Z"
  const recordRef = `collector.hostRecipes.${featureId}`
  const manifest = {
    schemaVersion: 4 as const,
    probeHash: "host-custody-suite",
    adapterVersion: "4",
    catalogIds: [featureId],
    probes: { term: [], lib: [featureId], mux: [] },
  }
  const draft = initializeRunDraft({
    runId,
    sourceRevision: "1".repeat(40),
    source: { kind: "live" },
    intendedSubject: { kind: "lib", id: "alacritty", version: "0.26.0" },
    manifest,
  })
  draft.subject = {
    kind: "lib",
    id: "alacritty",
    version: "0.26.0",
    os: "linux",
    osVersion: null,
    outerTerminal: null,
    mux: null,
    config: null,
    permissions: null,
  }
  draft.runtimeIdentity = {
    kind: "native",
    engineVersion: "0.26.0",
    adapterVersion: "0.10.2",
    termlessRevision: "2".repeat(40),
    loadedBinary: { path: "fixture.node", sha256: artifact },
    provenance: {
      sha256: artifact,
      sourceCommit: "3".repeat(40),
      buildHash: "b".repeat(64),
      toolchain: "fixture",
      lockSha256: "c".repeat(64),
    },
  }
  draft.identity = "unverified"
  draft.measuredAt = startedAt
  draft.origin = { kind: "collector" }
  draft.results[0] = recordExecutedProbe({
    featureId,
    attempt: { scope: "probe", startedAt: draft.measuredAt },
    assertions: [],
    tests: [{ id: "criterion", status: "test-failure", reason: "Fixture has no initial colour reply" }],
  })
  const emptyRecipes = mode === "no-recipes"
  const finalized = finalization !== undefined
  const input = JSON.stringify({
    ...(finalized && { ids: [featureId], startedAt: draft.measuredAt, result: "started" }),
    hostInputs: { "foreground-rgb": "not-supplied" },
  })
  draft.rawReplies["collector.collectionAttempt"] = input
  const citation = {
    inputRecordRef: "collector.collectionAttempt",
    sha256: createHash("sha256").update(input).digest("hex"),
    input: "foreground-rgb",
    sourceLocation: "fixture-native.rs:1",
  }
  const source = { kind: "source-audited", missing: "foreground-rgb", runId, artifactSha256: artifact, citation }
  const observed = { kind: "observed", missing: "foreground-rgb", runId, eventRef: recordRef }
  const record = {
    runId,
    captures: [{ query, response: "", error: null }],
    causes: [{ recipe: "color-request", cause: source as typeof source | typeof observed }],
  }
  if (mode === "observed" || mode === "foreign-reference" || mode === "foreign-instance") {
    record.causes = [{ recipe: "color-request", cause: observed }]
  }
  if (mode === "missing-cause" || mode === "real-reply" || mode === "undeclared-query") record.causes = []
  if (split) {
    record.captures = [query.slice(0, 3), query.slice(3)].map((part) => ({ query: part, response: "", error: null }))
  }
  if (mode === "missing-capture" || emptyRecipes) record.captures = []
  if (emptyRecipes) record.causes = []
  if (mode === "stale-input") citation.sha256 = "0".repeat(64)
  if (finalization === "stale") citation.sha256 = "0".repeat(64)
  if (mode === "stale-artifact") source.artifactSha256 = "0".repeat(64)
  if (mode === "foreign-reference") observed.eventRef = "collector.hostRecipes.other"
  if (mode === "foreign-run") record.runId = "another-run"
  if (mode === "wrong-missing") source.missing = "background-rgb"
  if (mode === "real-reply") record.captures[0]!.response = "\x1b]10;rgb:aaaa/bbbb/cccc\x07"
  const expectations: HostRecipeExpectation[] =
    mode === "undeclared-query" || emptyRecipes ? [] : [{ recipe: "color-request", query, missing: ["foreground-rgb"] }]
  draft.rawReplies[recordRef] = JSON.stringify(record)
  draft.rawReplies["collector.replyPath"] = JSON.stringify({
    backend: "alacritty",
    declaration: {
      boundary: "feed-and-getCursor",
      adapterSources: [{ path: "fixture.ts", blobOid: "4".repeat(40) }],
      engine: { kind: "native", sha256: artifact },
    },
    runtimeIdentity: draft.runtimeIdentity,
    decisions: {
      [featureId]: {
        member: true,
        reason: "fixture",
        runtimeIdentity:
          mode === "foreign-instance"
            ? { ...draft.runtimeIdentity, adapterVersion: "different-initialized-adapter" }
            : draft.runtimeIdentity,
        hostRecipes: expectations,
      },
    },
  })
  return () => {
    if (finalization) {
      const before = { ...draft.rawReplies }
      const outcome = finalization === "failed" || finalization === "cancelled" ? finalization : "completed"
      try {
        finalizeHeadlessAttempt(
          draft,
          {
            ids: [featureId],
            startedAt,
            hostInputs: { "foreground-rgb": finalization === "tampered" ? "supplied" : "not-supplied" },
            ...(outcome === "completed" ? { result: outcome } : { result: outcome, error: "original fixture error" }),
          },
          [{ id: featureId, ...(emptyRecipes ? {} : { libHostRecipes: expectations }) }],
        )
      } catch (error) {
        expect(draft.rawReplies).toEqual(before)
        throw error
      }
      expect(readCollectorAttempt(draft.rawReplies)?.result).toBe(outcome)
      if (outcome !== "completed") expect(readCollectorAttempt(draft.rawReplies)?.error).toBe("original fixture error")
      if (mode === "observed" || emptyRecipes) expect(draft.rawReplies[recordRef]).toBe(before[recordRef])
    }
    return parseRun(
      "host-custody.json",
      JSON.stringify(draft),
      [featureId],
      new Map([[manifest.probeHash, manifest]]),
      {
        mode: "capture",
      },
    )
  }
}

it.each(["source-audited", "observed", "real-reply"])(
  "native host recipe accepts valid %s custody without changing the criterion",
  (mode) => {
    expect(hostCauseCapture(mode, HOST_QUERY, false)().results?.[0]?.status).toBe("test-failure")
  },
)
// Selected-run outcomes must survive canonical reading after collection ends.
// Existing custody cases bind the started bytes and never finalize the attempt.
it.each([
  ["completed", "source-audited"],
  ["failed", "source-audited"],
  ["cancelled", "source-audited"],
  ["completed", "no-recipes"],
  ["failed", "no-recipes"],
  ["cancelled", "no-recipes"],
] as const)("retains native host custody after %s finalization with %s recipes", (outcome, mode) => {
  // Native producers also persist empty records for known probes with no host recipe declaration.
  // Prior cases always supplied a declaration and missed the real Kitty finalizer refusal.
  expect(hostCauseCapture(mode, HOST_QUERY, false, outcome)().results?.[0]?.status).toBe("test-failure")
})
it.each([
  ["stale", /stale before finalization/],
  ["tampered", /hostInputs|unchanged|changed/],
] as const)("refuses %s finalization atomically", (mode, diagnostic) => {
  expect(hostCauseCapture("source-audited", HOST_QUERY, false, mode)).toThrow(diagnostic)
})
it("preserves observed host-cause bytes through finalization", () => {
  expect(hostCauseCapture("observed", HOST_QUERY, false, "completed")().results?.[0]?.status).toBe("test-failure")
})
it.each([
  "missing-cause",
  "missing-capture",
  "stale-input",
  "stale-artifact",
  "foreign-reference",
  // N3: a valid observed cause cannot authorize another initialized instance.
  // Existing source-audited cases reject mismatched artifact citations, hiding this reader gap.
  "foreign-instance",
  "foreign-run",
  "wrong-missing",
  "undeclared-query",
])("native host recipe rejects %s custody", (mode) => {
  expect(hostCauseCapture(mode, HOST_QUERY, false)).toThrow(/host recipe/i)
})

it.each([
  ["OSC10 ST", "\x1b]10;?\x1b\\", false],
  ["palette", "\x1b]4;0;?\x07", false],
  ["clipboard", "\x1b]52;c;?\x07", false],
  ["pixel geometry", "\x1b[14t", false],
  ["fragmented clipboard", "\x1b]52;c;?\x07", true],
] as const)("native host recipe rejects undeclared %s independently of cause presence", (_name, query, split) => {
  expect(hostCauseCapture("undeclared-query", query, split)).toThrow(/captured undeclared/i)
})

// #31373 (@cto 15cf18e4): an unreproduced-callback record and its failed harness row are one claim. The
// collector writes both together; the reader refuses either one alone, which no existing fixture carries.
function harnessCapture(
  mode: "both" | "record-only" | "reordered-record" | "spaced-record" | "row-only" | "todo-row",
  host?: "cause" | "no-cause" | "two-targets" | "replied-cause",
) {
  const featureId = "clipboard.read"
  const manifest = {
    schemaVersion: 4 as const,
    probeHash: "harness-suite",
    adapterVersion: "4",
    catalogIds: [featureId],
    probes: { term: [], lib: [featureId], mux: [] },
  }
  const draft = initializeRunDraft({
    runId: "harness-gap",
    sourceRevision: "1".repeat(40),
    source: { kind: "live" },
    intendedSubject: { kind: "lib", id: "kitty", version: "0.49.2" },
    manifest,
  })
  draft.subject = {
    kind: "lib",
    id: "kitty",
    version: "0.49.2",
    os: "linux",
    osVersion: null,
    outerTerminal: null,
    mux: null,
    config: null,
    permissions: null,
  }
  draft.runtimeIdentity = {
    kind: "native",
    engineVersion: "0.49.2",
    adapterVersion: "0.10.2",
    termlessRevision: "2".repeat(40),
    loadedBinary: { path: "kitty", sha256: "a".repeat(64) },
    provenance: {
      sha256: "a".repeat(64),
      sourceCommit: "3".repeat(40),
      buildHash: "b".repeat(64),
      toolchain: "fixture",
      lockSha256: "c".repeat(64),
    },
  }
  draft.identity = "unverified"
  draft.measuredAt = "2026-10-28T23:00:00.000Z"
  draft.origin = { kind: "collector" }
  const query = "\x1b]52;c;?\x07"
  const unreproduced = { backend: "kitty", captures: [{ query, callbacks: ["clipboard_control"] }] }
  // @cto ff549ce2: the reader finds the record by its key, so neither key order nor JSON whitespace hides it.
  draft.rawReplies[featureId] =
    mode === "row-only"
      ? ""
      : mode === "reordered-record"
        ? JSON.stringify({ measuredResponse: "", unreproduced })
        : `${mode === "spaced-record" ? "\n " : ""}${JSON.stringify({ unreproduced, measuredResponse: "" })}`
  const reason = "Harness incomplete: kitty did not reproduce clipboard_control; silence is not evidence"
  draft.results[0] = recordExecutedProbe({
    featureId,
    attempt: { scope: "probe", startedAt: draft.measuredAt },
    assertions: [],
    tests: [
      mode === "record-only" || mode === "reordered-record" || mode === "spaced-record"
        ? { id: "criterion", status: "test-failure", reason: "no-response" }
        : { id: HARNESS_INCOMPLETE_TEST, status: mode === "todo-row" ? "test-todo" : "test-failure", reason },
    ],
    rawReplyRef: featureId,
  })
  if (host) {
    // A-prime (@cto 4ac8b275): on the native host route the silent capture itself carries the harness cause.
    const colour = { recipe: "color-request", query: "\x1b]10;?\x07", missing: ["foreground-rgb"] }
    const hostRecipes = [
      { recipe: "clipboard-load", query, missing: ["clipboard-read-permission"] },
      ...(host === "two-targets" ? [colour] : []),
    ]
    const cause = { kind: "harness-unreproduced", callbacks: ["clipboard_control"] }
    draft.rawReplies[`collector.hostRecipes.${featureId}`] = JSON.stringify({
      runId: draft.runId,
      captures: [
        {
          query,
          response: host === "replied-cause" ? "\x1b]52;c;Zm9v\x07" : "",
          error: null,
          ...(host !== "no-cause" && { cause }),
        },
        ...(host === "two-targets" ? [{ query: colour.query, response: "", error: null }] : []),
      ],
      causes: [],
    })
    draft.rawReplies["collector.replyPath"] = JSON.stringify({
      backend: "kitty",
      declaration: {
        boundary: "feed-and-getCursor",
        adapterSources: [{ path: "fixture.ts", blobOid: "4".repeat(40) }],
        engine: { kind: "native", sha256: "a".repeat(64) },
      },
      runtimeIdentity: draft.runtimeIdentity,
      decisions: {
        [featureId]: { member: true, reason: "fixture", runtimeIdentity: draft.runtimeIdentity, hostRecipes },
      },
    })
  }
  return () =>
    parseRun("harness-gap.json", JSON.stringify(draft), [featureId], new Map([[manifest.probeHash, manifest]]), {
      mode: "capture",
    })
}

// The refused WezTerm capture (run 4cd4be36, addon sha256 84da518e) trimmed to its three clipboard-load probes. Its
// declared OSC 52 read returned zero bytes with no cause, so the parser refused the whole run file.
const WEZTERM_OSC52 = readFileSync(new URL("./fixtures/wezterm-osc52-refused.capture.json", import.meta.url), "utf8")
function weztermCapture(
  mode: "captured" | "audited" | "foreign-artifact" | "declared-input" | "no-source" | "finalized",
) {
  const run = JSON.parse(WEZTERM_OSC52) as RunDraft & { results: { featureId: string }[]; probeHash: string }
  const ids = run.results.map((result) => result.featureId)
  const manifest = {
    schemaVersion: 4 as const,
    probeHash: run.probeHash,
    adapterVersion: "4",
    catalogIds: ids,
    probes: { term: [], lib: ids, mux: [] },
  }
  for (const id of ids) {
    const recordRef = `collector.hostRecipes.${id}`
    const record = JSON.parse(run.rawReplies[recordRef]!) as { runId: string; causes: unknown[] }
    if (mode !== "captured") {
      // The cause the audit entry gives this artifact, retained as the collector writes it.
      const ctx = { runtimeIdentity: run.runtimeIdentity } as LibProbeSource
      const claim = nativeHostRecipeResult(
        ctx,
        fakeProbeResult(),
        "clipboard-load",
        "clipboard-read-permission",
        "\x1b]52;c;?\x07",
        true,
      ).hostRecipeCauses?.[0]
      if (claim?.cause.kind !== "unimplemented") {
        throw new Error(`no unimplemented audit cause: ${JSON.stringify(claim)}`)
      }
      const cause: Record<string, unknown> = {
        kind: "unimplemented",
        missing: claim.cause.missing,
        runId: record.runId,
        artifactSha256: claim.cause.artifactSha256,
        citation: { sourceLocation: claim.cause.sourceCitation },
      }
      if (mode === "foreign-artifact") cause.artifactSha256 = "0".repeat(64)
      if (mode === "declared-input") {
        cause.citation = { ...(cause.citation as object), inputRecordRef: "collector.collectionAttempt" }
      }
      if (mode === "no-source") cause.citation = { sourceLocation: "" }
      record.causes = [{ recipe: claim.recipe, cause }]
    }
    run.rawReplies[recordRef] = JSON.stringify(record)
  }
  if (mode === "finalized") {
    const attempt = readCollectorAttempt(run.rawReplies)
    if (!attempt?.startedAt) throw new Error("Expected retained WezTerm collection start")
    const hostRecords = Object.fromEntries(
      ids.map((id) => [`collector.hostRecipes.${id}`, run.rawReplies[`collector.hostRecipes.${id}`]]),
    )
    finalizeHeadlessAttempt(
      run,
      {
        ids: attempt.ids,
        startedAt: attempt.startedAt,
        ...(attempt.hostInputs && { hostInputs: attempt.hostInputs }),
        result: "completed",
      },
      ALL_PROBES,
    )
    for (const [key, bytes] of Object.entries(hostRecords)) expect(run.rawReplies[key]).toBe(bytes)
  }
  return () =>
    parseRun("wezterm-osc52.json", JSON.stringify(run), ids, new Map([[manifest.probeHash, manifest]]), {
      mode: "capture",
    })
}

it("parses a silent native host capture that carries its harness-unreproduced cause", () => {
  expect(harnessCapture("both", "cause")().results?.[0]?.status).toBe("test-failure")
})
it.each(["no-cause", "two-targets"] as const)("refuses a silent native host target without a cause (%s)", (host) => {
  expect(harnessCapture("both", host)).toThrow(/missing cause for captured empty target response/)
})
it("refuses a harness-unreproduced cause on a capture that replied", () => {
  expect(harnessCapture("both", "replied-cause")).toThrow(/invalid harness-unreproduced capture cause/)
})
it("reads an unreproduced-callback record beside its failed harness row", () => {
  expect(harnessCapture("both")().results?.[0]?.status).toBe("test-failure")
})
it.each(["record-only", "reordered-record", "spaced-record", "row-only", "todo-row"] as const)(
  "refuses an unreproduced-callback claim with %s",
  (mode) => {
    expect(harnessCapture(mode)).toThrow(/unreproduced-callback record/)
  },
)
it("the WezTerm OSC 52 read audit makes its refused capture parse without changing a result", () => {
  expect(weztermCapture("captured")).toThrow(/missing cause for captured empty target response/)
  const statuses = (JSON.parse(WEZTERM_OSC52) as { results: { status: string }[] }).results.map((r) => r.status)
  expect(weztermCapture("audited")().results?.map((result) => result.status)).toEqual(statuses)
  expect(weztermCapture("finalized")().results?.map((result) => result.status)).toEqual(statuses)
})
it.each(["foreign-artifact", "declared-input", "no-source"] as const)(
  "the WezTerm unimplemented cause refuses %s custody",
  (mode) => {
    expect(weztermCapture(mode)).toThrow(/host recipe/i)
  },
)

// The Kitty capture at the reply-delivery declaration's head (run f9d82f78, launcher sha256 bb65c2d5, termless 80c97ba)
// trimmed to its three OSC 52 probes (@cto ff19ee09: a native declaration lands with a parse test on a real capture). Each
// silent clipboard read reached clipboard_control, which the bridge does not reproduce, so its capture carries the cause.
const KITTY_OSC52 = readFileSync(new URL("./fixtures/kitty-osc52-harness.capture.json", import.meta.url), "utf8")
function kittyCapture(mode: "captured" | "no-cause") {
  const run = JSON.parse(KITTY_OSC52) as RunDraft & { results: { featureId: string }[]; probeHash: string }
  const ids = run.results.map((result) => result.featureId)
  const manifest = {
    schemaVersion: 4 as const,
    probeHash: run.probeHash,
    adapterVersion: "4",
    catalogIds: ids,
    probes: { term: [], lib: ids, mux: [] },
  }
  if (mode === "no-cause") {
    for (const id of ids) {
      const recordRef = `collector.hostRecipes.${id}`
      const record = JSON.parse(run.rawReplies[recordRef]!) as { captures: { cause?: unknown }[] }
      for (const capture of record.captures) delete capture.cause
      run.rawReplies[recordRef] = JSON.stringify(record)
    }
  }
  return () =>
    parseRun("kitty-osc52.json", JSON.stringify(run), ids, new Map([[manifest.probeHash, manifest]]), {
      mode: "capture",
    })
}
it("the real Kitty capture parses its silent OSC 52 reads by their harness cause, and refuses them without it", () => {
  const results = kittyCapture("captured")().results ?? []
  expect(results.map((result) => [result.featureId, result.status, result.tests[0]?.id])).toEqual([
    ["extensions.osc52-clipboard", "test-failure", HARNESS_INCOMPLETE_TEST],
    ["extensions.osc52-read", "test-failure", HARNESS_INCOMPLETE_TEST],
    ["extensions.osc52-write", "test-failure", HARNESS_INCOMPLETE_TEST],
  ])
  expect(kittyCapture("no-cause")).toThrow(/missing cause for captured empty target response/)
})

// The Kitty capture after #32091 (@cto 38d14547 option A; launcher sha256 bb65c2d5, Termless 785d8a9), trimmed to its three
// OSC 52 probes: the headless window reports clipboard_control read-clipboard, the collector declares the read
// permission supplied from it, and every OSC 52 cell measures with no host-recipe cause.
const KITTY_OSC52_SUPPLIED = readFileSync(
  new URL("./fixtures/kitty-osc52-supplied.capture.json", import.meta.url),
  "utf8",
)
it("the Kitty capture with its supplied clipboard read permission parses every OSC 52 cell as measured", () => {
  const run = JSON.parse(KITTY_OSC52_SUPPLIED) as RunDraft & { results: { featureId: string }[]; probeHash: string }
  const ids = run.results.map((result) => result.featureId)
  const manifest = {
    schemaVersion: 4 as const,
    probeHash: run.probeHash,
    adapterVersion: "4",
    catalogIds: ids,
    probes: { term: [], lib: ids, mux: [] },
  }
  const attempt = JSON.parse(run.rawReplies["collector.collectionAttempt"]!) as { hostInputs: Record<string, string> }
  expect(attempt.hostInputs["clipboard-read-permission"]).toBe(
    "clipboard_control write-clipboard write-primary read-clipboard read-primary",
  )
  for (const id of ids) {
    const record = JSON.parse(run.rawReplies[`collector.hostRecipes.${id}`]!) as { causes: unknown[] }
    expect(record.causes, id).toEqual([])
  }
  const parsed = parseRun(
    "kitty-osc52-supplied.json",
    JSON.stringify(run),
    ids,
    new Map([[manifest.probeHash, manifest]]),
    {
      mode: "capture",
    },
  )
  expect((parsed.results ?? []).map((result) => [result.featureId, result.status])).toEqual([
    ["extensions.osc52-clipboard", "supported"],
    ["extensions.osc52-read", "supported"],
    ["extensions.osc52-write", "supported"],
  ])
})

// The WezTerm capture of the addon rebuilt with the declared pixel geometry (run 777ffa79, addon sha256 78c05a71, termless
// 71cac2c3; 31551) trimmed to its four pixel probes and its OSC 52 read (@cto ff19ee09). The engine answered every pixel
// query from the declared 800x480 text area; its OSC 52 read stayed silent and carries the artifact's audit cause.
const WEZTERM_GEOMETRY = readFileSync(
  new URL("./fixtures/wezterm-pixel-geometry.capture.json", import.meta.url),
  "utf8",
)
function weztermGeometryCapture(mode: "captured" | "no-cause") {
  const run = JSON.parse(WEZTERM_GEOMETRY) as RunDraft & { results: { featureId: string }[]; probeHash: string }
  const ids = run.results.map((result) => result.featureId)
  const manifest = {
    schemaVersion: 4 as const,
    probeHash: run.probeHash,
    adapterVersion: "4",
    catalogIds: ids,
    probes: { term: [], lib: ids, mux: [] },
  }
  if (mode === "no-cause") {
    const recordRef = "collector.hostRecipes.extensions.osc52-read"
    const record = JSON.parse(run.rawReplies[recordRef]!) as { causes: unknown[] }
    record.causes = []
    run.rawReplies[recordRef] = JSON.stringify(record)
  }
  return () =>
    parseRun("wezterm-pixel-geometry.json", JSON.stringify(run), ids, new Map([[manifest.probeHash, manifest]]), {
      mode: "capture",
    })
}
it("the rebuilt WezTerm capture grades its pixel cells from the engine's bytes and its OSC 52 read by the audit", () => {
  const results = weztermGeometryCapture("captured")().results ?? []
  expect(results.map((result) => [result.featureId, result.status])).toEqual([
    ["device.xtwinops-14", "supported"],
    ["device.xtwinops-16", "supported"],
    ["extensions.osc1337-cellsize", "supported"],
    ["extensions.osc52-read", "unsupported"],
    ["extensions.sixel-geometry-report", "supported"],
  ])
  expect(weztermGeometryCapture("no-cause")).toThrow(/missing cause for captured empty target response/)
})

// The Kitty capture after its bridge handed Screen the declared cell size (run fda748aa, launcher sha256 bb65c2d5,
// termless 3d3a814; 31627) trimmed to its two pixel probes (@cto ff19ee09). Kitty answered both from the declared
// 800x480 text area through the re-keyed reply delivery; before, its 0x0 cell answered 4;0;0t and 6;0;0t.
const KITTY_GEOMETRY = readFileSync(new URL("./fixtures/kitty-pixel-geometry.capture.json", import.meta.url), "utf8")
it("the Kitty capture with the declared cell size grades its pixel cells from Kitty's bytes through its reply delivery", () => {
  const run = JSON.parse(KITTY_GEOMETRY) as RunDraft & { results: { featureId: string }[]; probeHash: string }
  const ids = run.results.map((result) => result.featureId)
  const manifest = {
    schemaVersion: 4 as const,
    probeHash: run.probeHash,
    adapterVersion: "4",
    catalogIds: ids,
    probes: { term: [], lib: ids, mux: [] },
  }
  const parsed = parseRun("kitty-pixel-geometry.json", KITTY_GEOMETRY, ids, new Map([[manifest.probeHash, manifest]]), {
    mode: "capture",
  })
  expect((parsed.results ?? []).map((result) => [result.featureId, result.status])).toEqual([
    ["device.xtwinops-14", "supported"],
    ["device.xtwinops-16", "supported"],
  ])
  const replyPath = JSON.parse(run.rawReplies["collector.replyPath"]!) as {
    decisions: Record<string, { member: boolean }>
  }
  expect(ids.map((id) => replyPath.decisions[id]?.member)).toEqual([true, true])
})

// The Alacritty capture of the addon rebuilt to answer CSI 14 t from the declared cell size (run d03bd884, addon sha256
// 5d818656, termless 22476678; 31628) trimmed to that probe and its OSC 52 read (@cto ff19ee09). The engine's own
// formatter answered from the declared 800x480 text area; its OSC 52 read stayed silent and carries the artifact's audit.
const ALACRITTY_GEOMETRY = readFileSync(
  new URL("./fixtures/alacritty-pixel-geometry.capture.json", import.meta.url),
  "utf8",
)
function alacrittyGeometryCapture(mode: "captured" | "no-cause") {
  const run = JSON.parse(ALACRITTY_GEOMETRY) as RunDraft & { results: { featureId: string }[]; probeHash: string }
  const ids = run.results.map((result) => result.featureId)
  const manifest = {
    schemaVersion: 4 as const,
    probeHash: run.probeHash,
    adapterVersion: "4",
    catalogIds: ids,
    probes: { term: [], lib: ids, mux: [] },
  }
  if (mode === "no-cause") {
    const recordRef = "collector.hostRecipes.extensions.osc52-read"
    const record = JSON.parse(run.rawReplies[recordRef]!) as { causes: unknown[] }
    record.causes = []
    run.rawReplies[recordRef] = JSON.stringify(record)
  }
  return () =>
    parseRun("alacritty-pixel-geometry.json", JSON.stringify(run), ids, new Map([[manifest.probeHash, manifest]]), {
      mode: "capture",
    })
}
it("the rebuilt Alacritty capture grades CSI 14 t from the engine's bytes and its OSC 52 read by the audit", () => {
  const results = alacrittyGeometryCapture("captured")().results ?? []
  expect(results.map((result) => [result.featureId, result.status])).toEqual([
    ["device.xtwinops-14", "supported"],
    ["extensions.osc52-read", "unsupported"],
  ])
  expect(alacrittyGeometryCapture("no-cause")).toThrow(/missing cause for captured empty target response/)
})

const setup = (
  observed?: string,
  sourceNegative?: { runId: string; startedAt: string },
  beforeBinding?: (draft: RunDraft) => void,
  featureOverride?: string,
) => {
  const featureId = featureOverride ?? (sourceNegative ? "sgr.faint" : "sgr.bold")
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
        kind: sourceNegative ? "negative" : "positive",
        assertionType: sourceNegative ? "buffer_state" : "query_reply",
        expected: sourceNegative ? "changed faint=true; restored faint=false" : "ACK",
        observed,
        rawReplyRef: featureId,
      },
    ]
    if (!sourceNegative) {
      draft.results[0]!.tests.unshift({
        id: "capture",
        status: "supported",
        attempt: { scope: "probe", startedAt: "2026-10-21T05:00:00.000Z" },
        assertionRefs: [0],
      })
    }
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
      adapterSources: [{ path: "packages/vt100/src/index.ts", blobOid: "b".repeat(40) }],
      resolvedPath: "/fixtures/vt100/index.ts",
      integrity: {
        kind: "source",
        repository: "vterm",
        revision: "3".repeat(40),
        treeOid: "4".repeat(40),
        cleanTree: true,
      },
    }
    draft.rawReplies["collector.replyPath"] = JSON.stringify({
      declaration: {
        boundary: "feed-and-getCursor",
        adapterSources: [{ path: "packages/vt100/src/index.ts", blobOid: "b".repeat(40) }],
        engine: { kind: "source", repository: "vterm", treeOid: "4".repeat(40) },
      },
      decisions: {},
    })
    draft.results[0] = recordExecutedProbe({
      featureId,
      attempt: { scope: "probe", startedAt: sourceNegative.startedAt },
      observation: {
        featureId,
        outcome: "inconclusive",
        reason: "insufficient-evidence",
        assertionType: "buffer_state",
        rawReplyRef: featureId,
      },
      assertions: draft.assertions,
      tests: [{ id: "review", status: "test-failure", reason: "Required source-negative review pending" }],
      criterionBranch: "source-negative-review",
    })
  }
  beforeBinding?.(draft)
  const capturedFeature = draft.results[0]!.featureId
  const artifact = retainCaptureBinding(draft, capturedFeature)
  const decision = {
    id: "review-bold",
    runId: draft.runId,
    featureId: capturedFeature,
    captureSha256: artifact.sha256,
    decision: "untestable",
    reviewed: true,
    reviewer: "reviewer",
    reason: "This context has no pixel plane; the configured plain stream cannot display glyphs",
    scope: {
      subject: { kind: draft.subject.kind, id: draft.subject.id },
      versions: [draft.subject.version, draft.subject.version],
      suites: [draft.probeHash, draft.probeHash],
    },
    sources: [artifact.rawReplyRef],
    supersedes: [],
  }
  return { draft, artifact, decision }
}

// #32014: the three grading decisions cannot represent a buildable, unbuilt readback.
// Exercise the owner boundary through sealing and canonical reread, including both binding rules.
describe("named tool-gap capture decisions", () => {
  it.each([
    { sourceNegative: false, evidence: false },
    { sourceNegative: true, evidence: false },
    { sourceNegative: false, evidence: true },
    { sourceNegative: true, evidence: true },
  ])("seals and rereads a named TODO without deriving assertions: %j", ({ sourceNegative, evidence }) => {
    const { draft, decision } = setup(
      sourceNegative ? JSON.stringify({ faint: false }) : "NO",
      sourceNegative ? { runId: "tool-gap-source", startedAt: "2026-10-21T05:00:00.000Z" } : undefined,
    )
    const featureId = decision.featureId
    const entryHash = "a".repeat(64)
    const bound = evidence ? retainCaptureBinding(draft, featureId, entryHash).evidence : undefined
    const review = {
      ...decision,
      ...(bound && { evidence: bound }),
      decision: "tool-gap",
      reason: "Presentation readback is unbuilt; owner @si/terminfo/30211-terminfo-273/32014-tool-gap-decision-value",
    }
    const source = JSON.stringify(review)
    const original = structuredClone(draft)
    expect(() => sealRunDraft(draft)).toThrow(/review pending/)
    applyCaptureDecision(draft, source, "2026-10-21T05:01:00.000Z", undefined, evidence ? entryHash : undefined)
    expect(draft.assertions).toEqual(original.assertions)
    for (const [key, bytes] of Object.entries(original.rawReplies)) expect(draft.rawReplies[key]).toBe(bytes)
    expect(draft.results[0]!.tests.filter((test) => test.id === "review")).toEqual([])
    expect(draft.results[0]!.tests.find((test) => test.id === "criterion")).toMatchObject({
      status: "test-todo",
      reason: review.reason,
      reviewRef: "collector.review.review-bold",
      assertionRefs: [],
    })
    const sealed = sealRunDraft(draft)
    const manifest = {
      schemaVersion: 4 as const,
      probeHash: draft.probeHash,
      adapterVersion: "3",
      catalogIds: [featureId],
      probes: { term: sourceNegative ? [] : [featureId], lib: sourceNegative ? [featureId] : [], mux: [] },
      ...(evidence && { catalogEntrySha256: { [featureId]: entryHash } }),
    }
    const read = (value: unknown) =>
      parseRun("tool-gap.json", JSON.stringify(value), [featureId], new Map([[draft.probeHash, manifest]]))
    const parsed = read(sealed)
    expect(parsed.results?.[0]).toMatchObject({ status: "test-todo", reason: review.reason })
    expect(parsed.rawReplies["collector.review.review-bold"]).toBe(source)
    expect(parsed.assertions).toEqual(original.assertions)
    const changed = structuredClone(sealed)
    changed.rawReplies[featureId] = sourceNegative ? JSON.stringify({ faint: true }) : "changed capture bytes"
    if (sourceNegative) changed.assertions[0]!.observed = changed.rawReplies[featureId]!
    expect(() => read(changed)).toThrow(/binding changed|retained evidence differs/)
  })

  it("requires a reason and preserves an unrelated required failure", () => {
    const { draft, decision } = setup(undefined, undefined, (draft) => {
      draft.results[0]!.tests.push({
        id: "transport",
        status: "test-failure",
        reason: "Transport capture failed independently of the missing readback",
        attempt: { scope: "none" },
      })
    })
    const review = { ...decision, decision: "tool-gap", reason: "" }
    expect(() => applyCaptureDecision(draft, JSON.stringify(review), "2026-10-21T05:01:00.000Z")).toThrow(
      /requires reason/,
    )
    review.reason = "Readback unbuilt; owner @si/terminfo/30211-terminfo-273/32014-tool-gap-decision-value"
    applyCaptureDecision(draft, JSON.stringify(review), "2026-10-21T05:01:00.000Z")
    expect(draft.results[0]!.status).toBe("test-failure")
    expect(draft.results[0]!.tests.find((test) => test.id === "transport")).toEqual({
      id: "transport",
      status: "test-failure",
      reason: "Transport capture failed independently of the missing readback",
      attempt: { scope: "none" },
    })
    expect(sealRunDraft(draft).results[0]!.status).toBe("test-failure")
  })
})

// Generic source-review fixtures cannot catch an unqualified real producer or its lost source citation.
it.each([
  {
    engine: "vt100",
    createBackend: createVt100Backend,
    treeOid: "1eaac257cf9ff8d8ece752c8e6edc04b9ddaa6cf",
    sourceCitation: "screen.ts:504-520 handleOSC switch, cases 0/1/2 only",
  },
  {
    engine: "vt220",
    createBackend: createVt220Backend,
    treeOid: "d504616ae458b8b0fa9fa365034c30bd35f55ee8",
    sourceCitation: "screen.ts:703-718 handleOSC: no-semicolon return; cases 0/1/2 only",
  },
])(
  "$engine OSC9 source review reaches the canonical decision consumer without vterm's notification citation",
  ({ engine, createBackend, treeOid, sourceCitation }) => {
    const featureId = "extensions.osc9-progress"
    const definition = ALL_PROBES.find((entry) => entry.id === featureId)
    const backend = createBackend()
    backend.init({ cols: 80, rows: 24 })
    try {
      const { draft, artifact, decision } = setup(
        undefined,
        { runId: `${engine}-osc9-review`, startedAt: "2026-10-30T16:00:00.000Z" },
        (draft) => {
          if (!definition?.lib) throw new Error("Missing OSC9 library callback")
          draft.intendedSubject = { kind: "lib", id: engine, version: "0.10.1" }
          draft.subject!.id = engine
          draft.subject!.version = "0.10.1"
          // Exact collector-input identity; this fixture does not attest a loaded production engine.
          draft.runtimeIdentity = {
            kind: "js",
            runtimeFormat: "js",
            engineVersion: "0.10.1",
            adapterVersion: "0.10.2",
            termlessRevision: "8b8664540f365fa0ba1d9b6400d3c4d1a160582c",
            // Collector identity fixture rekeyed to the 0.10.1 parser audit; not a historical load attestation.
            adapterSources:
              engine === "vt100"
                ? [
                    { path: "packages/vt100/src/index.ts", blobOid: "99833d737402f9d1d8e3e257e3a255d8aa1facc3" },
                    { path: "packages/vt100/src/backend.ts", blobOid: "cdb8be8c5ebbba68a5920cfa4df27c9deb31745a" },
                  ]
                : [
                    { path: "packages/vt220/src/index.ts", blobOid: "601dd26eb7e753a5396ebdf72f1ef8ee2cc4355f" },
                    { path: "packages/vt220/src/backend.ts", blobOid: "7369e3710e36aa649372fd09011ecfdd6ba47c73" },
                  ],
            resolvedPath: `vendor/vterm/packages/${engine}/src/index.ts`,
            integrity: {
              kind: "source",
              repository: "git@github.com:beorn/vterm.git",
              revision: "bd3d32aea2f1994376a71adfc55b92705eedbd8c",
              treeOid,
              cleanTree: true,
            },
          }
          const result = definition.lib(createLibProbeSource(backend, undefined, draft.runtimeIdentity, undefined))
          expect(result.criterionBranch).toBe("source-negative-review")
          expect(result.tests?.[0]?.reason).toContain(sourceCitation)
          expect(result.tests?.[0]?.reason).not.toContain("notification sink")
          expect(JSON.parse(result.response!)).toMatchObject({ sentinel: { char: "X" } })
          draft.rawReplies[featureId] = result.response!
          draft.rawReplies["collector.collectionAttempt"] = JSON.stringify({
            ids: [featureId],
            startedAt: "2026-10-30T16:00:00.000Z",
          })
          draft.assertions = result.assertions!.map((assertion) => ({
            ...assertion,
            featureId,
            rawReplyRef: featureId,
          }))
          draft.results = [
            recordExecutedProbe({
              featureId,
              attempt: { scope: "probe", startedAt: "2026-10-30T16:00:00.000Z" },
              observation: result.observation && { ...result.observation, featureId, rawReplyRef: featureId },
              assertions: draft.assertions,
              tests: result.tests,
              criterionBranch: result.criterionBranch,
            }),
          ]
        },
      )
      expect(draft.results[0]!.status).toBe("test-failure")
      const originals = { assertions: structuredClone(draft.assertions), rawReplies: structuredClone(draft.rawReplies) }
      decision.decision = "unsupported"
      decision.reason = `Independent source review: ${engine}'s exact OSC9 progress criterion has no handler or target writer at the pinned source.`
      applyCaptureDecision(draft, JSON.stringify(decision), "2026-10-30T16:01:00.000Z")
      const manifest = {
        probeHash: draft.probeHash,
        adapterVersion: "3",
        catalogIds: [featureId],
        probes: { term: [], lib: [featureId], mux: [] },
      }
      const parsed = parseRun(
        `${engine}-osc9.json`,
        JSON.stringify(sealRunDraft(draft)),
        [featureId],
        new Map([[draft.probeHash, manifest]]),
      )
      expect(parsed.results?.[0]?.status).toBe("unsupported")
      expect(parsed.results?.[0]?.reviewRef).toBe(`collector.review.${decision.id}`)
      expect(parsed.rawReplies[artifact.rawReplyRef]).toBe(artifact.source)
      for (const [key, value] of Object.entries(originals.rawReplies)) expect(parsed.rawReplies[key]).toBe(value)
      expect(parsed.assertions.slice(0, originals.assertions.length)).toEqual(originals.assertions)
      expect(parsed.assertions).toHaveLength(originals.assertions.length + 1)
    } finally {
      backend.destroy()
    }
  },
)

// The generic branch fixtures cannot catch a real definition left null: no review or binding is then produced.
it.each(["device.term-features", "erase.screen.scrollback"])(
  "%s library coverage reaches an immutable Untestable review without I/O or assertions",
  (featureId) => {
    const history = featureId === "erase.screen.scrollback"
    const citation = history ? "getScrollback" : "createVtermBackend"
    const definition = ALL_PROBES.find((entry) => entry.id === featureId)
    const { draft, artifact, decision } = setup(
      undefined,
      {
        runId: `${featureId}-library-review`,
        startedAt: "2026-10-29T23:00:00.000Z",
      },
      (draft) => {
        if (!definition?.lib) throw new Error(`${featureId} has no library review arm`)
        // Collector-input fixture at the audited engine/API pin; this does not attest a loaded engine.
        const engine = history ? "libvterm" : "vterm"
        const version = history ? "0.3.3" : "0.10.1"
        draft.intendedSubject = { kind: "lib", id: engine, version }
        draft.subject!.id = engine
        draft.subject!.version = version
        draft.runtimeIdentity = history
          ? {
              kind: "js",
              runtimeFormat: "wasm",
              engineVersion: version,
              adapterVersion: "0.10.2",
              termlessRevision: "f8d2aeb7a7a30f0215fd628bbbb1f1e5cd0a91be",
              adapterSources: [
                { path: "packages/libvterm/src/index.ts", blobOid: "2b4708b1081e701b99893ca055ded781dc46cf25" },
                { path: "packages/libvterm/src/backend.ts", blobOid: "eb513ccd443e30c7a869a8ba41f8126e1c0ddf00" },
                { path: "packages/libvterm/src/wasm-bindings.ts", blobOid: "2bbd4d5cf59b8d53db8f5c0329d2ed7853c43e45" },
                { path: "packages/libvterm/wasm/libvterm.js", blobOid: "1e784be87614ab924b96844009919b7c21ce150e" },
              ],
              resolvedPath: "vendor/termless/packages/libvterm/src/index.ts",
              integrity: {
                kind: "source",
                repository: "git@github.com:beorn/termless.git",
                revision: "f8d2aeb7a7a30f0215fd628bbbb1f1e5cd0a91be",
                treeOid: "ae0b11bb808b8c402c168869d7caa5a5f62566c2",
                cleanTree: true,
              },
              loadedBinary: {
                path: "vendor/termless/packages/libvterm/wasm/libvterm.wasm",
                sha256: "3d67045bb43c5e4081c70dc58088af8f735416c20df2d7843d765e5aad8ef62a",
              },
            }
          : {
              kind: "js",
              runtimeFormat: "js",
              engineVersion: "0.10.1",
              adapterVersion: "0.10.2",
              termlessRevision: "8b8664540f365fa0ba1d9b6400d3c4d1a160582c",
              adapterSources: [
                { path: "packages/vterm/src/index.ts", blobOid: "cb5719799dcdd5ae24e6fcf0dcad9965035ce54c" },
                { path: "packages/vterm/src/backend.ts", blobOid: "308a934578c044ae95feaa29299531d9aa9eb4f7" },
              ],
              resolvedPath: "vendor/vterm/packages/vterm/src/index.ts",
              integrity: {
                kind: "source",
                repository: "git@github.com:beorn/vterm.git",
                revision: "bd3d32aea2f1994376a71adfc55b92705eedbd8c",
                treeOid: "f10a184811894462b9ca7b65d6aab8ffd2fdd0bd",
                cleanTree: true,
              },
            }
        const result = definition.lib({
          runtimeIdentity: draft.runtimeIdentity,
          feed: () => {
            throw new Error("Source/API review must not feed")
          },
          feedCapture: () => {
            throw new Error("Source/API review must not query")
          },
          getScrollback: () => {
            throw new Error("Source/API review must not read unobservable history")
          },
        } as unknown as LibProbeSource)
        expect(result.criterionBranch).toBe(HEADLESS_OBSERVABLE_REVIEW)
        expect(result.observation).toBeUndefined()
        expect(result.assertions).toBeUndefined()
        const retained = JSON.parse(result.response!)
        const audit = {
          sourceCitation: expect.stringContaining(citation),
        }
        expect(retained).toMatchObject(history ? audit : { audit })
        if (!history) {
          expect(retained).toMatchObject({
            audit: {
              engine: "vterm",
              blobOid: "308a934578c044ae95feaa29299531d9aa9eb4f7",
              sourceCitation: expect.stringContaining("createVtermBackend"),
            },
          })
        }
        expect(result.response).not.toContain("runtimeIdentity")
        expect(result.notTested?.noObservable).toContain(
          history ? "retained scrollback history count" : "child-environment export",
        )
        draft.rawReplies[featureId] = result.response!
        draft.results = [
          recordExecutedProbe({
            featureId,
            attempt: { scope: "probe", startedAt: draft.measuredAt! },
            coverage: result.notTested && { ...result.notTested, featureId, rawReplyRef: featureId },
            assertions: [],
            tests: result.tests,
            criterionBranch: result.criterionBranch,
          }),
        ]
      },
    )
    expect(draft.results[0]!.status).toBe("test-todo")
    decision.reason = draft.results[0]!.tests[0]!.reason!
    applyCaptureDecision(draft, JSON.stringify(decision), "2026-10-29T23:01:00.000Z")
    const manifest = {
      probeHash: draft.probeHash,
      adapterVersion: "3",
      catalogIds: [featureId],
      probes: { term: [], lib: [featureId], mux: [] },
    }
    const parsed = parseRun(
      "term-features.json",
      JSON.stringify(sealRunDraft(draft)),
      [featureId],
      new Map([[draft.probeHash, manifest]]),
    )
    expect(parsed.results?.[0]?.status).toBe("untestable")
    expect(parsed.rawReplies[artifact.rawReplyRef]).toBe(artifact.source)
    expect(parsed.assertions).toEqual([])
    const retained = JSON.parse(parsed.rawReplies[featureId]!)
    const audit = {
      sourceCitation: expect.stringContaining(citation),
    }
    expect(retained).toMatchObject(history ? audit : { audit })
    expect(parsed.rawReplies[featureId]).toBe(draft.rawReplies[featureId])
  },
)
// Source-only prompt review is approved evidence, not a measured assertion. These explicit
// collector-input fixtures exercise the canonical seam; they do not attest an engine build.
function semanticPromptCapture(status: "supported" | "unsupported" = "supported") {
  const featureId = "extensions.osc133-a"
  const result = setup(undefined, { runId: "prompt-review", startedAt: "2026-10-29T10:00:00Z" }, (draft) => {
    delete draft.rawReplies["sgr.faint"]
    draft.rawReplies[featureId] = JSON.stringify({ home: { x: 0, y: 0 }, target: { x: 1, y: 0 }, cell: "X" })
    draft.rawReplies["collector.collectionAttempt"] = JSON.stringify({
      startedAt: "2026-10-29T10:00:00Z",
      ids: [featureId],
    })
    draft.results[0] = recordExecutedProbe({
      featureId,
      attempt: { scope: "probe", startedAt: "2026-10-29T10:00:00Z" },
      assertions: [],
      tests: [{ id: "review", status: "test-todo", reason: "Independent source review pending" }],
      criterionBranch: SEMANTIC_PROMPT_SOURCE_REVIEW,
    })
    draft.runtimeIdentity = {
      kind: "js",
      runtimeFormat: "wasm",
      engineVersion: "0.8.0",
      adapterVersion: "0.10.2",
      termlessRevision: "2".repeat(40),
      resolvedPath: "/fixtures/engine.js",
      integrity: {
        kind: "source",
        repository: "fixture",
        revision: "3".repeat(40),
        treeOid: "4".repeat(40),
        cleanTree: true,
      },
      loadedBinary: { path: "/fixtures/engine.wasm", sha256: "a".repeat(64) },
    }
  })
  result.decision.decision = status
  result.decision.reason = "Source row names the prompt parser arm and the mark state it writes or rejects"
  result.decision.sources = ["terminfo.dev@" + result.draft.sourceRevision, "fixture-source-review-row"]
  return result
}

describe("semantic prompt source review", () => {
  const at = "2026-10-29T10:01:00Z"
  const read = (draft: RunDraft) =>
    parseRun(
      "prompt.json",
      JSON.stringify(sealRunDraft(draft)),
      ["extensions.osc133-a"],
      new Map([
        [
          draft.probeHash,
          {
            schemaVersion: 4,
            probeHash: draft.probeHash,
            adapterVersion: "3",
            catalogIds: ["extensions.osc133-a"],
            probes: { term: [], lib: ["extensions.osc133-a"], mux: [] },
          },
        ],
      ]),
    )

  it.each(["supported", "unsupported"] as const)("roundtrips %s without invented assertions", (status) => {
    const { draft, decision } = semanticPromptCapture(status)
    const raw = { ...draft.rawReplies }
    applyCaptureDecision(draft, JSON.stringify(decision), at)
    expect(draft.assertions).toEqual([])
    expect(draft.results[0]!.tests[0]!.assertionRefs).toEqual([])
    for (const [key, value] of Object.entries(raw)) expect(draft.rawReplies[key]).toBe(value)
    expect(read(draft).results?.[0]).toMatchObject({ status, criterionBranch: SEMANTIC_PROMPT_SOURCE_REVIEW })
  })

  it.each(["binary", "tree", "revision", "source", "subject", "run"])("rejects changed %s binding", (field) => {
    const { draft, decision } = semanticPromptCapture()
    if (field === "binary" && draft.runtimeIdentity?.kind === "js" && draft.runtimeIdentity.runtimeFormat === "wasm") {
      draft.runtimeIdentity.loadedBinary!.sha256 = "b".repeat(64)
    }
    if (field === "tree" && draft.runtimeIdentity?.kind === "js" && draft.runtimeIdentity.integrity.kind === "source") {
      draft.runtimeIdentity.integrity.treeOid = "5".repeat(40)
    }
    if (
      field === "revision" &&
      draft.runtimeIdentity?.kind === "js" &&
      draft.runtimeIdentity.integrity.kind === "source"
    ) {
      draft.runtimeIdentity.integrity.revision = "6".repeat(40)
    }
    if (field === "source") draft.sourceRevision = "7".repeat(40)
    if (field === "subject") draft.subject!.config = "another configuration"
    if (field === "run") draft.runId = "another-run"
    expect(() => applyCaptureDecision(draft, JSON.stringify(decision), at)).toThrow(/binding changed/)
  })

  it("keeps the ordinary review assertion requirement", () => {
    const { draft, decision } = semanticPromptCapture()
    draft.results[0]!.criterionBranch = "ordinary-review"
    delete draft.rawReplies[`collector.capture.${decision.featureId}`]
    decision.captureSha256 = retainCaptureBinding(draft, decision.featureId).sha256
    expect(() => applyCaptureDecision(draft, JSON.stringify(decision), at)).toThrow(/retained TESTED\/EXPECTED/)
  })

  it.each(["runtime", "review-row"])("requires source proof %s", (field) => {
    const { draft, decision } = semanticPromptCapture()
    if (field === "runtime") delete draft.runtimeIdentity
    else decision.sources = ["terminfo.dev@" + draft.sourceRevision, "termless@" + "2".repeat(40)]
    expect(() => applyCaptureDecision(draft, JSON.stringify(decision), at)).toThrow(
      field === "runtime" ? /runtimeIdentity/ : /source|review row/,
    )
  })

  // The reader must not accept a status-only source result or a stripped proof, even after application.
  it.each(["decision", "binding", "status", "reason", "sources", "runtime"])(
    "reader rejects changed %s proof",
    (field) => {
      const { draft, decision } = semanticPromptCapture()
      applyCaptureDecision(draft, JSON.stringify(decision), at)
      const key = `collector.review.${decision.id}`
      if (field === "decision") delete draft.rawReplies[key]
      else if (field === "binding") delete draft.rawReplies[`collector.capture.${decision.featureId}`]
      else if (field === "runtime") {
        const binding = JSON.parse(draft.rawReplies[`collector.capture.${decision.featureId}`]!) as {
          runtimeIdentity?: unknown
        }
        delete binding.runtimeIdentity
        draft.rawReplies[`collector.capture.${decision.featureId}`] = JSON.stringify(binding)
      } else {
        const proof = JSON.parse(draft.rawReplies[key]!) as typeof decision
        if (field === "status") proof.decision = "unsupported"
        if (field === "reason") proof.reason = "another source claim"
        if (field === "sources") proof.sources = ["terminfo.dev@" + draft.sourceRevision]
        draft.rawReplies[key] = JSON.stringify(proof)
      }
      expect(() => read(draft)).toThrow(/source review|capture binding|runtimeIdentity/)
    },
  )
})

// Existing final-run SHA review tests cannot catch a circular pre-seal binding or status changes
// authorized by a different capture. This exercises the actual execution helper and exact bytes.
describe("immutable pre-seal capture binding", () => {
  // Historical decisions/manifests are immutable; absent new data cannot be mistaken for equal evidence.
  it.each(["manifest", "retained", "old-record", "extra-component"] as const)(
    "keeps missing %s evidence pending",
    (missing) => {
      const origin = setup("state", { runId: "missing-origin", startedAt: "2026-10-27T11:00:00.000Z" })
      const current = setup("state", { runId: "missing-current", startedAt: "2026-10-27T11:00:00.000Z" }, (draft) => {
        draft.probeHash = draft.suiteId = "new-suite"
      })
      const hash = "a".repeat(64),
        binding = retainCaptureBinding(origin.draft, "sgr.faint", hash)
      if (missing !== "retained") retainCaptureBinding(current.draft, "sgr.faint", hash)
      const evidence = structuredClone(binding.evidence!)
      if (missing === "extra-component") {
        Object.assign(evidence.projection, { additionalEvidence: "a new component" })
        evidence.sha256 = createHash("sha256").update(canonicalJson(evidence.projection)).digest("hex")
      }
      const source = JSON.stringify({
        ...origin.decision,
        decision: "unsupported",
        ...(missing !== "old-record" && { evidence }),
      })
      applyCaptureDecision(
        current.draft,
        source,
        "2026-10-27T11:02:00.000Z",
        undefined,
        missing === "manifest" ? undefined : hash,
      )
      expect(current.draft.results[0]!.status).toBe("test-failure")
      expect(current.draft.rawReplies["collector.review.review-bold"]).toBe(source)
      expect(current.draft.results[0]!.reason).toContain(
        missing === "manifest"
          ? "catalogue entry identity unavailable"
          : missing === "retained"
            ? "retained evidence projection unavailable"
            : missing === "extra-component"
              ? "additionalEvidence"
              : "lapsed",
      )
    },
  )

  // Amended key: a Termless merge and checkout move preserve evidence; adapter or native build changes lapse.
  it.each(["revision", "path", "adapter", "binary", "sourceCommit", "buildHash", "toolchain", "lockSha256"] as const)(
    "compares stable native provenance and adapter blobs: %s",
    (field) => {
      const make = (changed: boolean) =>
        setup(
          "state",
          { runId: changed ? "native-current" : "native-origin", startedAt: "2026-10-27T11:00:00.000Z" },
          (draft) => {
            draft.runtimeIdentity = {
              kind: "native",
              engineVersion: "1",
              adapterVersion: "2",
              termlessRevision: changed && field === "revision" ? "f".repeat(40) : "2".repeat(40),
              adapterSources: [
                {
                  path: "packages/vt100/src/index.ts",
                  blobOid: (changed && field === "adapter" ? "f" : "b").repeat(40),
                },
              ],
              loadedBinary: {
                path: changed && field === "path" ? "/moved.node" : "/fixture.node",
                sha256: changed && field === "binary" ? "f".repeat(64) : "a".repeat(64),
              },
              provenance: {
                sha256: "a".repeat(64),
                sourceCommit: changed && field === "sourceCommit" ? "f".repeat(40) : "b".repeat(40),
                buildHash: changed && field === "buildHash" ? "f".repeat(64) : "c".repeat(64),
                toolchain: changed && field === "toolchain" ? "clang-21" : "clang-20",
                lockSha256: changed && field === "lockSha256" ? "f".repeat(64) : "d".repeat(64),
              },
            }
            if (changed && field === "adapter") {
              draft.rawReplies["collector.replyPath"] = JSON.stringify({
                declaration: {
                  adapterSources: [{ path: "packages/vt100/src/index.ts", blobOid: "f".repeat(40) }],
                },
                decisions: {},
              })
            }
          },
        )
      const origin = make(false),
        current = make(true)
      const evidence = retainCaptureBinding(origin.draft, "sgr.faint", "a".repeat(64)).evidence
      retainCaptureBinding(current.draft, "sgr.faint", "a".repeat(64))
      applyCaptureDecision(
        current.draft,
        JSON.stringify({ ...origin.decision, evidence, decision: "unsupported" }),
        "2026-10-27T11:02:00.000Z",
        undefined,
        "a".repeat(64),
      )
      expect(current.draft.results[0]!.status).toBe(
        field === "revision" || field === "path" ? "unsupported" : "test-failure",
      )
      if (field !== "revision" && field !== "path") {
        expect(current.draft.results[0]!.reason).toContain("runtimeIdentity")
      }
    },
  )
  // Each review route must reach the same new-key reader; legacy tests require same-run
  it.each([
    "other-cell",
    "adapter",
    "decision",
    "revision",
    "frame-path",
    "frame-bytes",
    "frame-label",
    "frame-digest",
    "frame-rectangle",
    "missing-adapter",
  ] as const)("keeps reply-path and frame evidence scoped to its cell: %s", (field) => {
    const make = (changed: boolean) =>
      setup(
        "state",
        { runId: changed ? "cell-current" : "cell-origin", startedAt: "2026-10-27T11:00:00.000Z" },
        (draft) => {
          draft.results[0]!.criterionBranch = "headless-observable-review"
          draft.results[0]!.tests[0]!.status = "test-todo"
          draft.results[0] = finalizeProbeResult(draft.results[0]!)
          if (changed && field === "revision" && draft.runtimeIdentity) {
            draft.runtimeIdentity.termlessRevision = "f".repeat(40)
          }
          if (changed && field === "missing-adapter" && draft.runtimeIdentity) {
            delete draft.runtimeIdentity.adapterSources
          }
          const frameKey = changed && field === "frame-path" ? "moved.frame" : "original.frame"
          draft.rawReplies[frameKey] =
            changed && field === "frame-bytes" ? "different frame bytes" : "exact frame bytes"
          draft.results[0]!.frames = [
            {
              kind: "pixels",
              role: "target",
              label: changed && field === "frame-label" ? "changed" : "target",
              ref: changed && field === "frame-path" ? "/moved.png" : "/original.png",
              capturedAt: changed ? 2 : 1,
              sourceRef: frameKey,
              pixelsDigest: (changed && field === "frame-digest" ? "f" : "a").repeat(64),
              regionRectangle: { x: changed && field === "frame-rectangle" ? 2 : 1, y: 1, width: 8, height: 16 },
            },
          ]
          draft.rawReplies["collector.replyPath"] = JSON.stringify({
            declaration: {
              boundary: "feed-and-getCursor",
              adapterSources:
                changed && field === "missing-adapter"
                  ? []
                  : [
                      {
                        path: "packages/vt100/src/index.ts",
                        blobOid: (changed && field === "adapter" ? "f" : "b").repeat(40),
                      },
                    ],
              engine: { kind: "source", repository: "vterm", treeOid: "4".repeat(40) },
            },
            decisions: {
              "sgr.faint": {
                member: !(changed && field === "decision"),
                reason: "Qualification result",
                runtimeIdentity: draft.runtimeIdentity,
              },
              "other.feature": { member: changed && field === "other-cell" },
            },
          })
        },
      )
    const origin = make(false),
      current = make(true),
      hash = "a".repeat(64)
    const evidence = retainCaptureBinding(origin.draft, "sgr.faint", hash).evidence
    retainCaptureBinding(current.draft, "sgr.faint", hash)
    applyCaptureDecision(
      current.draft,
      JSON.stringify({ ...origin.decision, evidence }),
      "2026-10-27T11:02:00.000Z",
      undefined,
      hash,
    )
    const carried = ["other-cell", "revision", "frame-path"].includes(field)
    expect(current.draft.results[0]!.status).toBe(carried ? "untestable" : "test-todo")
    if (!carried) {
      expect(current.draft.results[0]!.reason).toContain(
        field === "missing-adapter"
          ? "adapter source identity unavailable"
          : field === "frame-bytes"
            ? "cell.rawReplies"
            : field.startsWith("frame-")
              ? "cell.frames"
              : "replyPath",
      )
    }
  })

  // Each review route must reach the same new-key reader; legacy tests require same-run
  // bindings and cannot expose a route that still compares the origin capture SHA.
  it.each([
    ["source-negative-review", "sgr.faint", "unsupported"],
    ["os-input-review", "input.xtest-key", "untestable"],
    ["headless-observable-review", "extensions.sixel", "untestable"],
    ["headless-geometry-review", "device.xtwinops-14", "untestable"],
    ["semantic-prompt-source-review", "extensions.osc133-a", "supported"],
  ] as const)("carries %s through application and the sealed reader", (branch, featureId, outcome) => {
    const make = (runId: string, suite: string) =>
      setup(
        '{"retained":"state"}',
        { runId, startedAt: "2026-10-27T11:00:00.000Z" },
        (draft) => {
          draft.probeHash = draft.suiteId = suite
          draft.rawReplies["collector.replyPath"] = JSON.stringify({
            decisions: {
              [featureId]: { member: false, reason: "Fixture has no reply-delivery declaration" },
            },
          })
          if (branch === SEMANTIC_PROMPT_SOURCE_REVIEW) draft.assertions = []
          draft.results[0] = recordExecutedProbe({
            featureId,
            attempt: { scope: "probe", startedAt: "2026-10-27T11:00:00.000Z" },
            ...(branch !== SEMANTIC_PROMPT_SOURCE_REVIEW && {
              observation: {
                featureId,
                outcome: "inconclusive" as const,
                reason: "insufficient-evidence" as const,
                assertionType: "buffer_state" as const,
                rawReplyRef: featureId,
              },
            }),
            assertions: draft.assertions,
            tests: [
              {
                id: "review",
                status: branch === "source-negative-review" ? "test-failure" : "test-todo",
                reason: "Independent source review pending",
              },
            ],
            criterionBranch: branch,
          })
        },
        featureId,
      )
    const origin = make("kind-origin", "old-suite"),
      current = make("kind-current", "new-suite")
    const artifact = retainCaptureBinding(origin.draft, featureId, "a".repeat(64))
    retainCaptureBinding(current.draft, featureId, "a".repeat(64))
    const decision = {
      ...origin.decision,
      decision: outcome,
      evidence: artifact.evidence,
      sources: ["vterm@3333333333333333333333333333333333333333:screen.ts:1"],
    }
    const before = structuredClone(current.draft.assertions),
      bytes = JSON.stringify(decision)
    applyCaptureDecision(current.draft, bytes, "2026-10-27T11:02:00.000Z", undefined, "a".repeat(64))
    expect(current.draft.results[0]!.status).toBe(outcome)
    expect(current.draft.rawReplies["collector.review.review-bold"]).toBe(bytes)
    expect(current.draft.assertions.slice(0, before.length)).toEqual(before)
    expect(retainCaptureBinding(current.draft, featureId, "a".repeat(64)).evidence).toEqual(artifact.evidence)
    const manifest = {
      schemaVersion: 4 as const,
      probeHash: "new-suite",
      adapterVersion: "3",
      catalogIds: [featureId],
      catalogEntrySha256: { [featureId]: "a".repeat(64) },
      probes: { term: [], lib: [featureId], mux: [] },
    }
    expect(
      parseRun(
        "carried.json",
        JSON.stringify(sealRunDraft(current.draft)),
        manifest.catalogIds,
        new Map([[manifest.probeHash, manifest]]),
      ).results?.[0]?.status,
    ).toBe(outcome)
  })

  // Component changes must lapse only the affected review. The old whole-suite tests do
  // not bind original reason text or a single catalogue entry, and cannot prove that rule.
  it.each(["catalogue", "raw bytes", "expected", "reason", "runtime"] as const)(
    "names changed %s in an evidence-bound lapse",
    (part) => {
      const origin = setup('{"faint":false}', { runId: "component-origin", startedAt: "2026-10-27T11:00:00.000Z" })
      const current = setup(
        '{"faint":false}',
        { runId: "component-current", startedAt: "2026-10-27T11:00:00.000Z" },
        (draft) => {
          if (part === "raw bytes") {
            draft.rawReplies["sgr.faint"] = '{"faint":true}'
            draft.assertions[0]!.observed = draft.rawReplies["sgr.faint"]!
          }
          if (part === "expected") draft.assertions[0]!.expected = "a different criterion"
          if (part === "reason") draft.results[0]!.tests[0]!.reason = "a different source-review prerequisite"
          if (part === "runtime" && draft.runtimeIdentity) draft.runtimeIdentity.adapterVersion = "different-adapter"
        },
      )
      const evidence = retainCaptureBinding(origin.draft, "sgr.faint", "a".repeat(64)).evidence
      const currentHash = (part === "catalogue" ? "b" : "a").repeat(64)
      retainCaptureBinding(current.draft, "sgr.faint", currentHash)
      applyCaptureDecision(
        current.draft,
        JSON.stringify({ ...origin.decision, evidence, decision: "unsupported" }),
        "2026-10-27T11:02:00.000Z",
        undefined,
        currentHash,
      )
      expect(current.draft.results[0]!.status).toBe("test-failure")
      expect(current.draft.results[0]!.reason).toContain(
        {
          catalogue: "feature",
          "raw bytes": "cell.rawReplies",
          expected: "cell.assertions",
          reason: "cell.tests",
          runtime: "runtimeIdentity",
        }[part],
      )
    },
  )

  // Output-key acceptance: the existing same-suite source-negative fixture cannot catch
  // a review being needlessly lost when only the run, suite, source or checkout path changes.
  it("carries an explicitly evidence-bound decision across a different run and suite", () => {
    const observed = '{"faint":false}'
    const origin = setup(observed, { runId: "evidence-origin", startedAt: "2026-10-27T11:00:00.000Z" })
    const current = setup(observed, { runId: "evidence-current", startedAt: "2026-10-27T11:01:00.000Z" }, (draft) => {
      draft.probeHash = draft.suiteId = "different-suite"
      draft.sourceRevision = "5".repeat(40)
      if (draft.runtimeIdentity?.kind === "js") draft.runtimeIdentity.resolvedPath = "/new/checkout/vt100/index.ts"
    })
    // Literal reviewed preimage: its independently recorded SHA must keep the original
    // capture digest's old meaning, and the applier must compare actual current evidence.
    const projection = {
      cell: {
        assertionType: "buffer_state",
        assertions: [
          {
            assertionType: "buffer_state",
            expected: "changed faint=true; restored faint=false",
            featureId: "sgr.faint",
            kind: "negative",
            observed,
            rawReplyRef: "sgr.faint",
          },
        ],
        criterionBranch: "source-negative-review",
        frames: [],
        rawReplies: [{ key: "sgr.faint", sha256: "1ec72955c1f0c335d797d8c7a5f02f59208820de4e168ca74e2a5a918c563ac9" }],
        tests: [{ id: "review", reason: "Required source-negative review pending", status: "test-failure" }],
      },
      feature: { catalogEntrySha256: "a".repeat(64), featureId: "sgr.faint" },
      runtimeIdentity: {
        adapterVersion: "0.10.2",
        engineVersion: "0.8.0",
        integrity: {
          cleanTree: true,
          kind: "source",
          repository: "vterm",
          treeOid: "4".repeat(40),
        },
        kind: "js",
        runtimeFormat: "js",
        adapterSources: [{ path: "packages/vt100/src/index.ts", blobOid: "b".repeat(40) }],
      },
      subject: { id: "vt100", kind: "lib", os: "linux", version: "0.8.0" },
    }
    const evidence = {
      algorithm: "evidence-output-v1",
      sha256: "24cf4b61f729a28263a97cf634a4ec157ca1ea2c9c5348c989cc487b1316019a",
      projection,
    }
    const decision = { ...origin.decision, decision: "unsupported", evidence }
    const decisionBytes = JSON.stringify(decision)
    current.draft.rawReplies["collector.evidence.sgr.faint"] = JSON.stringify(evidence)
    applyCaptureDecision(current.draft, decisionBytes, "2026-10-27T11:02:00.000Z", undefined, "a".repeat(64))
    expect(current.draft.results[0]!.status).toBe("unsupported")
    expect(current.draft.rawReplies["collector.review.review-bold"]).toBe(decisionBytes)
    expect(origin.decision.runId).toBe("evidence-origin")
    expect(current.draft.runtimeIdentity).toMatchObject({ resolvedPath: "/new/checkout/vt100/index.ts" })
  })

  // Existing review fixtures supply the pending row; this crosses the actual SGR producer boundary.
  it.each(["unsupported", "untestable"] as const)("decides an actual null SGR readback as %s", (outcome) => {
    const model = createSemanticSurface()
    const source = libProbeSource({
      ...model,
      getCell: (row, col) => ({ ...model.getCell(row, col), dim: null }),
    })
    const callback = ALL_PROBES.find((probe) => probe.id === "sgr.faint")!.lib!(source)
    const startedAt = "2026-10-27T11:00:00.000Z"
    const { draft, decision } = setup(callback.response, { runId: "null-style-review", startedAt }, (draft) => {
      draft.assertions = (callback.assertions ?? []).map((assertion) => ({
        ...assertion,
        featureId: "sgr.faint",
        rawReplyRef: "sgr.faint",
      }))
      draft.results[0] = recordExecutedProbe({
        featureId: "sgr.faint",
        attempt: { scope: "probe", startedAt },
        observation: { ...callback.observation!, featureId: "sgr.faint", rawReplyRef: "sgr.faint" },
        assertions: draft.assertions,
        tests: callback.tests,
        criterionBranch: callback.criterionBranch,
      })
    })
    decision.decision = outcome
    applyCaptureDecision(draft, JSON.stringify(decision), "2026-10-27T11:01:00.000Z")
    expect(draft.results[0]!.status).toBe(outcome)
    expect(JSON.parse(draft.rawReplies["sgr.faint"]!)).toEqual(expect.objectContaining({ dim: null }))
    expect(draft.assertions[0]!.assertionType).toBe("buffer_state")
    expect(JSON.parse(draft.assertions[0]!.observed)).toEqual(expect.objectContaining({ dim: null }))
  })

  // Headless intent omits version; an explicit conflict remains binding even for the same run.
  // Existing fixtures always supplied a matching version, hiding the production collector shape.
  it.each([
    { version: undefined, expected: "unsupported" },
    { version: "0.7.0", expected: "test-failure" },
  ])("checks an optional intended version ($version)", ({ version, expected }) => {
    const { draft, artifact, decision } = setup(
      JSON.stringify({ faint: false }),
      { runId: "headless-intent", startedAt: "2026-10-27T11:00:00.000Z" },
      (draft) => {
        if (version === undefined) delete draft.intendedSubject.version
        else draft.intendedSubject.version = version
      },
    )
    decision.decision = "unsupported"
    applyCaptureDecision(draft, JSON.stringify(decision), "2026-10-27T11:01:00.000Z")
    expect(draft.results[0]!.status).toBe(expected)
    expect(draft.rawReplies[artifact.rawReplyRef]).toBe(artifact.source)
    if (expected === "test-failure") expect(draft.results[0]!.reason).toContain("versions differ")
    const manifest = {
      schemaVersion: 4 as const,
      probeHash: draft.probeHash,
      adapterVersion: "3",
      catalogIds: ["sgr.faint"],
      probes: { term: [], lib: ["sgr.faint"], mux: [] },
    }
    const run = expected === "unsupported" ? sealRunDraft(draft) : draft
    expect(
      parseRun("intent.json", JSON.stringify(run), manifest.catalogIds, new Map([[manifest.probeHash, manifest]]), {
        mode: "capture",
      }).results?.[0]?.status,
    ).toBe(expected)
  })
  // FINAL B1/B2/B4: existing cases intentionally reject a different run and never attempt to
  // reuse a source-negative decision. Exercise the real applier with retained state, not a new seam.
  it.each(["unsupported", "untestable"])(
    "reuses a source-negative %s review and reads the sealed fresh cohort",
    (reviewedStatus) => {
      const observed = JSON.stringify({
        original: { faint: false },
        changed: { faint: false },
        restored: { faint: false },
      })
      const origin = setup(observed, { runId: "source-origin", startedAt: "2026-10-27T11:00:00.000Z" })
      const current = setup(observed, { runId: "source-current", startedAt: "2026-10-27T11:01:00.000Z" })
      origin.decision.decision = reviewedStatus
      origin.decision.reason = "Reviewed source and retained state establish the negative"
      origin.decision.sources = ["vterm@d7f69fe916ed44d1e01d24b9a079f6b96ba86cb5:packages/vt100/src/screen.ts:444-498"]
      const decisionBytes = JSON.stringify(origin.decision)
      const originalCapture = origin.artifact.source
      expect(current.draft.results[0]!.status).toBe("test-failure")
      applyCaptureDecision(current.draft, decisionBytes, "2026-10-27T11:02:00.000Z")
      expect(current.draft.results[0]!.status).toBe(reviewedStatus)
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
      const manifest = {
        schemaVersion: 4 as const,
        probeHash: current.draft.probeHash,
        adapterVersion: "3",
        catalogIds: ["sgr.faint"],
        probes: { term: [], lib: ["sgr.faint"], mux: [] },
      }
      const sealed = sealRunDraft(current.draft)
      expect(
        parseRun("reused.json", JSON.stringify(sealed), manifest.catalogIds, new Map([[manifest.probeHash, manifest]]))
          .results?.[0]?.status,
      ).toBe(reviewedStatus)
    },
  )
  // CTO afedd8b5: a query reply is source-negative only on a cited parser-level rejection, never a missing writer.
  // Every existing source-negative fixture is buffer_state, so none could read a query_reply review without that field.
  it.each([
    { rejection: "parser", accepted: true },
    { rejection: undefined, accepted: false },
  ])(
    "reads a query_reply source-negative review only with a parser rejection ($rejection)",
    ({ rejection, accepted }) => {
      const observed = JSON.stringify({ ...(rejection && { rejection }), replyPathAudit: { query: "\x1b[>1c" } })
      const { draft, decision } = setup(
        observed,
        { runId: "query-reply-review", startedAt: "2026-10-28T22:00:00.000Z" },
        (draft) => {
          draft.results[0]!.assertionType = "query_reply"
          draft.assertions = draft.assertions.map((assertion) => ({ ...assertion, assertionType: "query_reply" }))
        },
      )
      decision.decision = "unsupported"
      decision.sources = ["vt100@0.16.2:src/parser.rs:1"]
      applyCaptureDecision(draft, JSON.stringify(decision), "2026-10-28T22:01:00.000Z")
      const manifest = {
        schemaVersion: 4 as const,
        probeHash: draft.probeHash,
        adapterVersion: "3",
        catalogIds: ["sgr.faint"],
        probes: { term: [], lib: ["sgr.faint"], mux: [] },
      }
      const read = () =>
        parseRun(
          "query-reply.json",
          JSON.stringify(sealRunDraft(draft)),
          manifest.catalogIds,
          new Map([[manifest.probeHash, manifest]]),
        )
      if (accepted) expect(read().results?.[0]?.status).toBe("unsupported")
      else expect(read).toThrow(/query_reply source-negative review requires a recorded parser-level rejection/)
    },
  )
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
      if (unrelatedFailure) {
        expect(draft.results[0]!.tests.find((test) => test.id === "cleanup")?.status).toBe("test-failure")
      }
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
  // CTO branch-migration hold: CURRENT criterion owns matching; another branch keeps strict legacy binding.
  it("rejects a source-negative decision on a current cell with another criterion", () => {
    const observed = JSON.stringify({ faint: false })
    const origin = setup(observed, { runId: "origin", startedAt: "2026-10-27T11:00:00.000Z" })
    const current = setup(observed, { runId: "current", startedAt: "2026-10-27T11:01:00.000Z" }, (draft) => {
      draft.results[0]!.criterionBranch = "visual-review"
      draft.results[0]!.tests[0]!.status = "test-todo"
      draft.results[0] = finalizeProbeResult(draft.results[0]!)
    })
    origin.decision.decision = "unsupported"
    expect(() =>
      applyCaptureDecision(current.draft, JSON.stringify(origin.decision), "2026-10-27T11:02:00.000Z"),
    ).toThrow(/capture digest mismatch/)
    expect(current.draft.results[0]!.status).toBe("test-todo")
  })
  // FINAL B3/Amendment2: each input is a genuinely fresh cohort, changed BEFORE its first binding.
  // A hash-only mismatch test cannot name these components or preserve a failed attempted review.
  it.each([
    {
      component: "bytes",
      change: (draft: RunDraft) => {
        const observed = JSON.stringify({ faint: true })
        draft.rawReplies["sgr.faint"] = observed
        draft.assertions[0]!.observed = observed
      },
    },
    {
      component: "feature",
      change: (draft: RunDraft) => {
        draft.results[0]!.featureId = "sgr.italic"
        draft.results[0]!.rawReplyRef = "sgr.italic"
        draft.results[0]!.tests[0]!.rawReplyRef = "sgr.italic"
        draft.rawReplies["sgr.italic"] = draft.rawReplies["sgr.faint"]!
        delete draft.rawReplies["sgr.faint"]
        draft.assertions[0]!.featureId = "sgr.italic"
        draft.assertions[0]!.rawReplyRef = "sgr.italic"
      },
    },
    {
      component: "subject",
      change: (draft: RunDraft) => {
        draft.subject!.id = "vt220"
        draft.intendedSubject.id = "vt220"
      },
    },
    {
      component: "versions",
      change: (draft: RunDraft) => {
        draft.subject!.version = "0.9.0"
        draft.intendedSubject.version = "0.9.0"
        draft.runtimeIdentity!.engineVersion = "0.9.0"
      },
    },
    {
      component: "suite",
      change: (draft: RunDraft) => {
        draft.probeHash = "different-suite"
        draft.suiteId = "different-suite"
      },
    },
    {
      component: "source revision",
      change: (draft: RunDraft) => {
        draft.sourceRevision = "5".repeat(40)
      },
    },
  ])("lapses a fresh $component mismatch with the origin binding retained", ({ component, change }) => {
    const observed = JSON.stringify({ faint: false })
    const origin = setup(observed, { runId: "origin", startedAt: "2026-10-27T11:00:00.000Z" })
    const current = setup(observed, { runId: "current", startedAt: "2026-10-27T11:01:00.000Z" }, change)
    origin.decision.decision = "unsupported"
    // A review offered for another frozen cell must lapse against the origin's actual feature.
    if (component === "feature") origin.decision.featureId = current.draft.results[0]!.featureId
    const decisionBytes = JSON.stringify(origin.decision)
    const originKey = `collector.review.${origin.decision.id}.capture`
    current.draft.rawReplies[originKey] = origin.artifact.source
    expect(() => applyCaptureDecision(current.draft, decisionBytes, "2026-10-27T11:02:00.000Z")).not.toThrow()
    expect(current.draft.results[0]!.status).toBe("test-failure")
    expect(current.draft.results[0]!.reason).toContain(`capture decision ${origin.decision.id} lapsed:`)
    expect(current.draft.results[0]!.reason).toContain(component)
    expect(current.draft.rawReplies[`collector.review.${origin.decision.id}`]).toBe(decisionBytes)
    expect(current.draft.rawReplies[originKey]).toBe(origin.artifact.source)
  })
  // B3/Amendment2: the parser must check attempted lapse custody too, without accepting a forged seal.
  it("keeps a lapsed source review unsealed and verifies its origin bytes at the canonical reader", () => {
    const origin = setup(JSON.stringify({ faint: false }), { runId: "origin", startedAt: "2026-10-27T11:00:00.000Z" })
    const current = setup(
      JSON.stringify({ faint: false }),
      { runId: "current", startedAt: "2026-10-27T11:01:00.000Z" },
      (draft) => {
        draft.sourceRevision = "6".repeat(40)
      },
    )
    origin.decision.decision = "unsupported"
    applyCaptureDecision(
      current.draft,
      JSON.stringify(origin.decision),
      "2026-10-27T11:02:00.000Z",
      origin.artifact.source,
    )
    const manifest = {
      schemaVersion: 4 as const,
      probeHash: current.draft.probeHash,
      adapterVersion: "3",
      catalogIds: ["sgr.faint"],
      probes: { term: [], lib: ["sgr.faint"], mux: [] },
    }
    const read = (value: unknown) =>
      parseRun("lapsed.json", JSON.stringify(value), manifest.catalogIds, new Map([[manifest.probeHash, manifest]]), {
        mode: "capture",
      })
    expect(() => sealRunDraft(current.draft)).toThrow(/review pending/)
    expect(read(current.draft).results?.[0]?.status).toBe("test-failure")
    expect(() => read({ ...current.draft, sealedAt: "2026-10-27T11:03:00.000Z" })).toThrow(/review pending/)
    const key = `collector.review.${origin.decision.id}.capture`
    expect(() =>
      read({ ...current.draft, rawReplies: { ...current.draft.rawReplies, [key]: origin.artifact.source + " " } }),
    ).toThrow(/origin.*digest/)
  })
  // B3: no origin store is a named unavailable input, never a fabricated comparison or a throw.
  it("names an unavailable origin binding when different fresh capture bytes cannot be compared", () => {
    const origin = setup(JSON.stringify({ faint: false }), {
      runId: "retired-origin",
      startedAt: "2026-10-27T11:00:00.000Z",
    })
    const current = setup(JSON.stringify({ faint: true }), { runId: "current", startedAt: "2026-10-27T11:01:00.000Z" })
    origin.decision.decision = "unsupported"
    expect(() =>
      applyCaptureDecision(current.draft, JSON.stringify(origin.decision), "2026-10-27T11:02:00.000Z", undefined),
    ).not.toThrow()
    expect(current.draft.results[0]!.status).toBe("test-failure")
    expect(current.draft.results[0]!.reason).toContain(
      "binding differs (origin binding text unavailable: run retired-origin)",
    )
  })
  // B2: a matching digest cannot authorize mislabeled intent or an unqualified library identity.
  it.each(["intent", "identity"])(
    "keeps a source review failed when its %s does not establish the actual subject",
    (change) => {
      const { draft, decision } = setup(
        JSON.stringify({ faint: false }),
        { runId: "current", startedAt: "2026-10-27T11:00:00.000Z" },
        (draft) => {
          if (change === "intent") draft.intendedSubject.id = "different-terminal"
          else delete draft.runtimeIdentity
        },
      )
      decision.decision = "unsupported"
      applyCaptureDecision(draft, JSON.stringify(decision), "2026-10-27T11:01:00.000Z")
      expect(draft.results[0]!.status).toBe("test-failure")
      expect(draft.results[0]!.reason).toContain("subject differ")
    },
  )
  // B1/B2: source identity changes lapse even when version labels and the captured state do not.
  it("binds engine source identity independently of its version label", () => {
    const origin = setup(JSON.stringify({ faint: false }), { runId: "origin", startedAt: "2026-10-27T11:00:00.000Z" })
    const current = setup(
      JSON.stringify({ faint: false }),
      { runId: "current", startedAt: "2026-10-27T11:01:00.000Z" },
      (draft) => {
        if (draft.runtimeIdentity?.kind !== "js" || draft.runtimeIdentity.integrity.kind !== "source") {
          throw Error("fixture source identity missing")
        }
        draft.runtimeIdentity.integrity.revision = "7".repeat(40)
      },
    )
    origin.decision.decision = "unsupported"
    applyCaptureDecision(
      current.draft,
      JSON.stringify(origin.decision),
      "2026-10-27T11:02:00.000Z",
      origin.artifact.source,
    )
    expect(current.draft.results[0]!.status).toBe("test-failure")
    expect(current.draft.results[0]!.reason).toContain("bytes differ")
  })
  // B1/B2 and Amendment1: locators may move; duplicate deciding assertions and binary bytes may not.
  it("reuses reordered assertion multisets and host paths without dropping deciding duplicates or binary identity", () => {
    const prepare = (draft: RunDraft, current: boolean, mismatch?: "duplicate" | "binary") => {
      const assertion = draft.assertions[0]!
      draft.assertions.push({ ...assertion }, { ...assertion, expected: "restored faint=false" })
      if (current) draft.assertions.reverse()
      if (mismatch === "duplicate") draft.assertions.pop()
      if (draft.runtimeIdentity?.kind !== "js") throw Error("fixture JS identity missing")
      draft.runtimeIdentity = {
        ...draft.runtimeIdentity,
        runtimeFormat: "wasm",
        resolvedPath: current ? "/current/adapter.ts" : "/origin/adapter.ts",
        loadedBinary: {
          path: current ? "/current/engine.wasm" : "/origin/engine.wasm",
          sha256: (mismatch === "binary" ? "c" : "d").repeat(64),
        },
      }
    }
    const observed = JSON.stringify({ faint: false })
    const origin = setup(observed, { runId: "origin", startedAt: "2026-10-27T11:00:00.000Z" }, (draft) =>
      prepare(draft, false),
    )
    origin.decision.decision = "unsupported"
    const current = setup(observed, { runId: "current", startedAt: "2026-10-27T11:01:00.000Z" }, (draft) =>
      prepare(draft, true),
    )
    applyCaptureDecision(
      current.draft,
      JSON.stringify(origin.decision),
      "2026-10-27T11:02:00.000Z",
      origin.artifact.source,
    )
    expect(current.draft.results[0]!.status).toBe("unsupported")
    const manifest = {
      schemaVersion: 4 as const,
      probeHash: current.draft.probeHash,
      adapterVersion: "3",
      catalogIds: ["sgr.faint"],
      probes: { term: [], lib: ["sgr.faint"], mux: [] },
    }
    expect(
      parseRun(
        "reordered.json",
        JSON.stringify(sealRunDraft(current.draft)),
        manifest.catalogIds,
        new Map([[manifest.probeHash, manifest]]),
      ).results?.[0]?.status,
    ).toBe("unsupported")
    for (const mismatch of ["duplicate", "binary"] as const) {
      const changed = setup(
        observed,
        { runId: `changed-${mismatch}`, startedAt: "2026-10-27T11:01:00.000Z" },
        (draft) => prepare(draft, true, mismatch),
      )
      applyCaptureDecision(
        changed.draft,
        JSON.stringify(origin.decision),
        "2026-10-27T11:02:00.000Z",
        origin.artifact.source,
      )
      expect(changed.draft.results[0]!.status).toBe("test-failure")
      expect(changed.draft.results[0]!.reason).toContain("bytes differ")
    }
  })
  // Amendment1: text-cell frame clocks are locators; canonical parsing still enforces the text-frame schema.
  // Existing frame round-trip coverage does not cross source-negative cohorts or prove digest binding.
  it("reuses source-negative review across frame times, reads the sealed run, and lapses on changed cell content", () => {
    const cellDigest = `sha256:${"a".repeat(64)}`
    const otherCellDigest = `sha256:${"b".repeat(64)}`
    const frameDigest = `sha256:${"c".repeat(64)}`
    const frameRef = `sha256:${"d".repeat(64)}`
    const observed = JSON.stringify({
      original: { faint: false },
      changed: { faint: false },
      restored: { faint: false },
      cellDigest,
    })
    const prepare = (draft: RunDraft, current: boolean, changedContent = false) => {
      draft.textSnapshotRefs = [frameRef]
      draft.results[0]!.frames = [
        {
          kind: "text-cells",
          role: "control",
          label: "plain faint glyph",
          ref: frameRef,
          capturedAt: current ? 100 : 1,
          cellDigest: otherCellDigest,
          frameDigest,
          cellRectangle: { top: 1, left: 1, bottom: 1, right: 4 },
        },
        {
          kind: "text-cells",
          role: "target",
          label: "faint glyph",
          ref: frameRef,
          capturedAt: current ? 200 : 2,
          cellDigest: changedContent ? otherCellDigest : cellDigest,
          frameDigest,
          cellRectangle: { top: 1, left: 1, bottom: 1, right: 4 },
        },
      ]
      draft.results[0]!.tests.push({
        id: "text-qualification",
        status: "supported",
        attempt: { scope: "probe", startedAt: "2026-10-27T11:00:00.000Z" },
      })
    }
    const origin = setup(observed, { runId: "frame-origin", startedAt: "2026-10-27T11:00:00.000Z" }, (draft) =>
      prepare(draft, false),
    )
    origin.decision.decision = "unsupported"
    const current = setup(observed, { runId: "frame-current", startedAt: "2026-10-27T11:01:00.000Z" }, (draft) =>
      prepare(draft, true),
    )
    applyCaptureDecision(
      current.draft,
      JSON.stringify(origin.decision),
      "2026-10-27T11:02:00.000Z",
      origin.artifact.source,
    )
    expect(current.draft.results[0]!.status).toBe("unsupported")
    const manifest = {
      schemaVersion: 4 as const,
      probeHash: current.draft.probeHash,
      adapterVersion: "3",
      catalogIds: ["sgr.faint"],
      probes: { term: [], lib: ["sgr.faint"], mux: [] },
    }
    const sealed = sealRunDraft(current.draft)
    expect(
      parseRun(
        "frame-reused.json",
        JSON.stringify(sealed),
        manifest.catalogIds,
        new Map([[manifest.probeHash, manifest]]),
      ).results?.[0]?.status,
    ).toBe("unsupported")

    const changed = setup(observed, { runId: "frame-changed", startedAt: "2026-10-27T11:03:00.000Z" }, (draft) =>
      prepare(draft, true, true),
    )
    applyCaptureDecision(
      changed.draft,
      JSON.stringify(origin.decision),
      "2026-10-27T11:04:00.000Z",
      origin.artifact.source,
    )
    expect(changed.draft.results[0]!.status).toBe("test-failure")
    expect(changed.draft.results[0]!.reason).toContain("bytes differ")
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

  // The typed supported/unsupported rows above admit any branch; a missing reply path must never read as a capability.
  it.each(
    [...UNTESTABLE_ONLY_REVIEW_BRANCHES].flatMap((branch) =>
      (
        [
          { decision: "supported", accepted: false },
          { decision: "unsupported", accepted: false },
          { decision: "untestable", accepted: true },
        ] as const
      ).map((entry) => ({ ...entry, branch })),
    ),
  )("decides $branch only as untestable ($decision)", ({ decision: verdict, accepted, branch }) => {
    expect([...UNTESTABLE_ONLY_REVIEW_BRANCHES]).toEqual([REPLY_PATH_AUDIT_REVIEW, HEADLESS_OBSERVABLE_REVIEW])
    const { draft, decision } = setup("NO", undefined, (draft) => {
      draft.results[0]!.criterionBranch = branch
    })
    decision.decision = verdict
    applyCaptureDecision(draft, JSON.stringify(decision), "2026-10-28T22:40:00.000Z")
    const manifest = {
      probeHash: draft.probeHash,
      adapterVersion: "3",
      catalogIds: ["sgr.bold"],
      probes: { term: ["sgr.bold"], lib: [], mux: [] },
    }
    const read = () =>
      parseRun(
        "reply-path-review.json",
        JSON.stringify(sealRunDraft(draft)),
        ["sgr.bold"],
        new Map([[draft.probeHash, manifest]]),
      )
    if (accepted) expect(read().results?.[0]?.status).toBe("untestable")
    else expect(read).toThrow(/review admits only an untestable decision/)
  })

  it.each(["raw", "host-cause", "context", "source", "suite", "feature", "run"])(
    "rejects review after %s binding changes",
    (change) => {
      // H6: a host-cause record is immutable review input, even when protocol bytes stay exact.
      const hostRef = "collector.hostRecipes.sgr.bold"
      const { draft, decision } = setup(undefined, undefined, (draft) => {
        if (change === "host-cause") draft.rawReplies[hostRef] = JSON.stringify({ captures: [], causes: [] })
      })
      if (change === "raw") draft.rawReplies["sgr.bold"] = "different trace"
      if (change === "host-cause") draft.rawReplies[hostRef] = JSON.stringify({ captures: [], causes: ["changed"] })
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

// Universal adapter identity: existing delivery-backed fixtures cannot prove writerless
// reviews carry, nor distinguish source provenance from the bytes of the engine tree.
it.each(["revision", "tree", "dirty", "writerless"] as const)(
  "binds source outputs independently of source commit and reply capability: %s",
  (field) => {
    const origin = setup("state", { runId: "source-origin", startedAt: "2026-10-27T11:00:00.000Z" })
    const current = setup("state", { runId: "source-current", startedAt: "2026-10-27T11:00:00.000Z" }, (draft) => {
      if (draft.runtimeIdentity?.kind !== "js" || draft.runtimeIdentity.integrity.kind !== "source") {
        throw new Error("Expected source fixture")
      }
      if (field === "revision") draft.runtimeIdentity.integrity.revision = "f".repeat(40)
      if (field === "tree") draft.runtimeIdentity.integrity.treeOid = "f".repeat(40)
      if (field === "dirty") draft.runtimeIdentity.integrity.cleanTree = false
      if (field === "writerless") delete draft.rawReplies["collector.replyPath"]
    })
    const evidence = retainCaptureBinding(origin.draft, "sgr.faint", "a".repeat(64)).evidence
    retainCaptureBinding(current.draft, "sgr.faint", "a".repeat(64))
    applyCaptureDecision(
      current.draft,
      JSON.stringify({ ...origin.decision, evidence, decision: "unsupported" }),
      "2026-10-27T11:02:00.000Z",
      undefined,
      "a".repeat(64),
    )
    expect(current.draft.results[0]!.status).toBe(
      field === "revision" || field === "writerless" ? "unsupported" : "test-failure",
    )
    if (field === "dirty") expect(current.draft.results[0]!.reason).toContain("dirty source tree")
  },
)

// The allowlist must exclude unreviewed registry fields; complete typed fixtures miss accidental spreads.
it.each(["js", "wasm"] as const)("enumerates registry integrity fields for %s", (format) => {
  const make = (extra: string) =>
    setup("state", { runId: extra, startedAt: "2026-10-27T11:00:00.000Z" }, (draft) => {
      if (draft.runtimeIdentity?.kind !== "js") throw new Error("Expected JS fixture")
      const integrity = { kind: "registry" as const, lockIntegrity: "sha512-fixed", unreviewedMetadata: extra }
      draft.runtimeIdentity =
        format === "wasm"
          ? {
              ...draft.runtimeIdentity,
              runtimeFormat: "wasm",
              loadedBinary: { path: "/fixture.wasm", sha256: "a".repeat(64) },
              integrity,
            }
          : { ...draft.runtimeIdentity, runtimeFormat: "js", integrity }
    })
  const origin = make("origin"),
    current = make("current"),
    hash = "a".repeat(64)
  const evidence = retainCaptureBinding(origin.draft, "sgr.faint", hash).evidence
  retainCaptureBinding(current.draft, "sgr.faint", hash)
  applyCaptureDecision(
    current.draft,
    JSON.stringify({ ...origin.decision, evidence, decision: "unsupported" }),
    "2026-10-27T11:02:00.000Z",
    undefined,
    hash,
  )
  expect(current.draft.results[0]!.status).toBe("unsupported")
})

// Both captures lacking a required component must not become evidence equality.
it.each(["not-object", "missing-decision", "missing-declaration"] as const)(
  "lapses a missing reply-path component: %s",
  (missing) => {
    const make = (runId: string) =>
      setup("state", { runId, startedAt: "2026-10-27T11:00:00.000Z" }, (draft) => {
        draft.results[0]!.criterionBranch = "headless-observable-review"
        draft.results[0]!.tests[0]!.status = "test-todo"
        draft.results[0] = finalizeProbeResult(draft.results[0]!)
        draft.rawReplies["collector.replyPath"] = JSON.stringify(
          missing === "not-object"
            ? []
            : missing === "missing-decision"
              ? { declaration: {}, decisions: {} }
              : { decisions: { "sgr.faint": { member: true, reason: "Qualified" } } },
        )
      })
    const origin = make("origin"),
      current = make("current"),
      hash = "a".repeat(64)
    const evidence = retainCaptureBinding(origin.draft, "sgr.faint", hash).evidence
    retainCaptureBinding(current.draft, "sgr.faint", hash)
    applyCaptureDecision(
      current.draft,
      JSON.stringify({ ...origin.decision, evidence }),
      "2026-10-27T11:02:00.000Z",
      undefined,
      hash,
    )
    expect(current.draft.results[0]!.status).toBe("test-todo")
    expect(current.draft.results[0]!.reason).toContain("replyPath")
  },
)

// A sealed reader must name a missing original review row, never borrow its applied replacement.
it("names a missing preimage review row in the canonical reader", () => {
  const { draft, decision } = setup('{"retained":"state"}', {
    runId: "missing-preimage",
    startedAt: "2026-10-27T11:00:00.000Z",
  })
  const hash = "a".repeat(64),
    artifact = retainCaptureBinding(draft, "sgr.faint", hash)
  applyCaptureDecision(
    draft,
    JSON.stringify({ ...decision, evidence: artifact.evidence }),
    "2026-10-27T11:02:00.000Z",
    undefined,
    hash,
  )
  const final = structuredClone(sealRunDraft(draft)),
    retained = JSON.parse(final.rawReplies["collector.evidence.sgr.faint"]!) as CaptureEvidence
  retained.projection.cell.tests = []
  retained.sha256 = createHash("sha256").update(canonicalJson(retained.projection)).digest("hex")
  final.rawReplies["collector.evidence.sgr.faint"] = canonicalJson(retained)
  const manifest = {
    schemaVersion: 4 as const,
    probeHash: final.probeHash,
    adapterVersion: "fixture",
    catalogIds: ["sgr.faint"],
    catalogEntrySha256: { "sgr.faint": hash },
    probes: { term: [], lib: ["sgr.faint"], mux: [] },
  }
  expect(() =>
    parseRun("sealed.json", JSON.stringify(final), manifest.catalogIds, new Map([[manifest.probeHash, manifest]])),
  ).toThrow("cell.tests.review preimage unavailable")
})

// #32037 AC1/AC2/AC3 (@cto d45ebed6): existing feature-hash binding tests pass synthetic hex digests, so they miss
// prose-only catalogue edits changing the bound entry hash, refusing in-place re-retain, or lapsing review decisions.
it("carries evidence-bound review decisions unchanged across prose-only catalogue edits and lapses on bound/unknown edits", () => {
  const entryHash = (entry: Record<string, unknown>) =>
    createHash("sha256")
      .update(canonicalJson(boundFeatureEntry(entry)), "utf8")
      .digest("hex")
  const originEntry: Record<string, unknown> = {
    name: "Faint / Dim (SGR 2)",
    slug: "faint",
    body: "Original body prose before the 147-entry editorial merge.",
    probe: "Send ESC[2m",
    baseline: "ecma-48",
    url: "/features/sgr/faint",
    tags: ["sgr"],
    sequence: "CSI 2 m",
    group: "sgr",
    tier1: "included",
  }
  const proseEditedEntry: Record<string, unknown> = {
    ...originEntry,
    body: "Rewritten editorial body prose.",
  }
  expect(FEATURE_ENTRY_PROSE_DENYLIST).toEqual(["body"])
  const originHash = entryHash(originEntry)
  const proseEditedHash = entryHash(proseEditedEntry)
  expect(proseEditedHash).toBe(originHash)

  const origin = setup('{"retained":"state"}', { runId: "prose-origin", startedAt: "2026-10-27T11:00:00.000Z" })
  const originEvidence = retainCaptureBinding(origin.draft, "sgr.faint", originHash).evidence
  const beforeReRetain = structuredClone(origin.draft.rawReplies)
  expect(retainCaptureBinding(origin.draft, "sgr.faint", proseEditedHash).evidence).toEqual(originEvidence)
  expect(origin.draft.rawReplies).toEqual(beforeReRetain)

  const current = setup('{"retained":"state"}', { runId: "prose-current", startedAt: "2026-10-27T11:00:00.000Z" })
  retainCaptureBinding(current.draft, "sgr.faint", proseEditedHash)
  applyCaptureDecision(
    current.draft,
    JSON.stringify({ ...origin.decision, evidence: originEvidence, decision: "supported" }),
    "2026-10-27T11:02:00.000Z",
    undefined,
    proseEditedHash,
  )
  expect(current.draft.results[0]!.status).toBe("supported")
  expect(current.draft.rawReplies[`collector.review.${origin.decision.id}.lapse`]).toBeUndefined()
  const sealed = sealRunDraft(current.draft)
  const manifest = {
    schemaVersion: 4 as const,
    probeHash: sealed.probeHash,
    adapterVersion: "fixture",
    catalogIds: ["sgr.faint"],
    catalogEntrySha256: { "sgr.faint": proseEditedHash },
    probes: { term: [], lib: ["sgr.faint"], mux: [] },
  }
  expect(
    parseRun(
      "prose-sealed.json",
      JSON.stringify(sealed),
      manifest.catalogIds,
      new Map([[manifest.probeHash, manifest]]),
    ).results?.[0]?.status,
  ).toBe("supported")

  for (const [label, mutatedEntry] of [
    ["probe", { ...originEntry, probe: "Send ESC[2;22m" }],
    ["unknown", { ...originEntry, unmodeledCriterionField: true }],
  ] as const) {
    const mutatedHash = entryHash(mutatedEntry)
    expect(mutatedHash, label).not.toBe(originHash)
    expect(() => retainCaptureBinding(origin.draft, "sgr.faint", mutatedHash), label).toThrow(
      "Capture sgr.faint evidence binding is immutable",
    )
    const lapsed = setup('{"retained":"state"}', { runId: `lapsed-${label}`, startedAt: "2026-10-27T11:00:00.000Z" })
    retainCaptureBinding(lapsed.draft, "sgr.faint", mutatedHash)
    applyCaptureDecision(
      lapsed.draft,
      JSON.stringify({ ...origin.decision, evidence: originEvidence }),
      "2026-10-27T11:02:00.000Z",
      undefined,
      mutatedHash,
    )
    expect(lapsed.draft.results[0]!.status, label).toBe("test-failure")
    expect(lapsed.draft.results[0]!.reason, label).toContain("feature")
  }
})
