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
} from "@terminfo/probe-defs"
import { fakeProbeResult } from "@terminfo/probe-defs/testing/fake-probe-result"
import { applyCaptureDecision, retainCaptureBinding, parseRun, decodeCollectorDraft } from "./index.ts"
import { finalizeHeadlessAttempt } from "../../probes/headless-batch.ts"
import { libProbeSource } from "../../probe-defs/src/testing/group-harness.ts"
import { createSemanticSurface } from "../../probe-defs/src/testing/semantic-surface.ts"

// Empty HTTP transport is a real initialized draft, not a truncated measured capture.
// Sealed-run binding tests never decode the unmeasured collector response boundary.
it.each(["empty", "status", "scope", "captured"])("decodes collector %s through its typed draft arm", (mode) => {
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
    recordCollectorSelection(draft, [])
    recordCollectorAttempt(draft, { ids: [], result: "empty" })
  }
  if (mode === "status") draft.results[0]!.status = "supported"
  if (mode === "scope") draft.results[0]!.attempt = { scope: "probe", startedAt: "2026-10-29T06:00:00Z" }
  const decode = () => decodeCollectorDraft("selection.draft.json", JSON.stringify(draft), manifest, "1".repeat(40))
  if (mode === "status" || mode === "scope") {
    expect(decode).toThrow(`results[0].${mode === "status" ? "status" : "attempt.scope"}`)
  } else expect(decode()).toMatchObject({ kind: mode === "captured" ? "captured" : "empty-selection", run: draft })
})

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
) => {
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
      resolvedPath: "/fixtures/vt100/index.ts",
      integrity: {
        kind: "source",
        repository: "vterm",
        revision: "3".repeat(40),
        treeOid: "4".repeat(40),
        cleanTree: true,
      },
    }
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
// Existing final-run SHA review tests cannot catch a circular pre-seal binding or status changes
// authorized by a different capture. This exercises the actual execution helper and exact bytes.
describe("immutable pre-seal capture binding", () => {
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
