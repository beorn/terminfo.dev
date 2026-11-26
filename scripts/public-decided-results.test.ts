/**
 * @failure The public projection (site and API, one mapping) publishes a result we haven't decided: a PROBE TODO,
 *   PROBE INVALID or PROBE CONFLICT cell, test, trace entry or count key, or the reason an undecided test recorded
 *   (#37341 Q4, D5, D6; @cto 760e9219: no public card reads a probe-todo or probe-invalid test reason).
 * @level l2
 * @consumer docs/data/probes.data.ts (the site) and scripts/generate-api.ts (api/v3 data.json, runs/*.json,
 *   traces/*.json), which both read `publicResults`
 * @testonly none
 */
import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import { parseRun } from "@terminfo/run-parser"
import type { ProbeResult, ProbeSuiteManifest } from "@terminfo/probe-defs"
import { initializeRunDraft } from "@terminfo/probe-defs"
import { finalizeCollectedDraft } from "../packages/terminfo.dev/src/capture-writer.ts"
import { UNANSWERED_QUERY } from "./stored-exchange.fixture.ts"
import { publicResults } from "../docs/data/public-results.ts"
import { projectResults } from "../docs/data/selected-results.ts"
import type { DeclaredUntestableCell } from "../docs/data/declared-untestable.ts"
import { aggregateCurrentResults, currentCoverageSentence, rollupInputs } from "../docs/data/release-scope.ts"

const ids = Array.from({ length: 12 }, (_, index) => `capability.${index}`)
const suite: ProbeSuiteManifest & { schemaVersion: 4 } = {
  schemaVersion: 4,
  probeHash: "public-decided",
  sourceRevision: "1".repeat(40),
  generatedAt: "2026-11-20T05:00:00.000Z",
  adapterVersion: "3.3.2",
  catalogIds: ids,
  probes: { term: [], lib: [], mux: [] },
}
const UNDECIDED = /"probe-(?:todo|invalid|conflict)"/
/** The structured fields withReplyFailureEvidence stores on an open or invalid test: never on a public card (@cto 760e9219, #37342). */
const REPLY_FAILURE_REASON = "no parsable cursor position reply"
const REPLY_FAILURE_FIELDS = {
  producer: "TTY" as const,
  attempts: [{ sent: "\x1b[c", received: "\x1b[?62;41c", timeoutMs: 37, matchState: "no-match" as const }],
}
const TODO_REASON = "Required probe test has not started for this fixture"

type Row = {
  id: string
  status: ProbeResult["status"]
  method?: "query_reply" | "input_bytes"
}

/** A run of kitty on macOS; `selected` names the ids a later collection measured, so the others keep their cells. */
function run(name: string, hour: number, rows: Row[], selected?: string[]) {
  const startedAt = `2026-11-20T${String(hour).padStart(2, "0")}:00:00.000Z`
  const attempt = { scope: "probe" as const, startedAt }
  const results: ProbeResult[] = ids.map((featureId) => ({
    featureId,
    status: "probe-todo",
    attempt: { scope: "none" },
    tests: [],
    reason: TODO_REASON,
  }))
  const assertions: object[] = []
  const replies: Record<string, string> = {}
  for (const row of rows) {
    const index = ids.indexOf(row.id)
    if (row.method) {
      const ref = assertions.length
      const reply =
        row.method === "input_bytes" ? JSON.stringify({ report: "ACK" }) : row.status === "supported" ? "ACK" : "NO"
      assertions.push({
        featureId: row.id,
        kind: row.status === "supported" ? "positive" : "negative",
        assertionType: row.method,
        rawReplyRef: row.id,
        expected: "ACK",
        observed: reply,
        ...(row.method === "input_bytes" && { action: "press test key" }),
      })
      // A decided result stores the exchange its evidence sentence is worded from (#37341 evidence module); this test is
      // about which statuses publish, not about evidence, so every decided row stores the shared unanswered query.
      replies[row.id] = UNANSWERED_QUERY
      results[index] = {
        featureId: row.id,
        status: row.status,
        attempt,
        assertionType: row.method,
        rawReplyRef: row.id,
        tests: [{ id: "criterion", status: row.status, attempt, assertionRefs: [ref] }],
      }
    } else {
      results[index] = {
        featureId: row.id,
        status: row.status,
        attempt,
        reason: REPLY_FAILURE_REASON,
        tests: [
          {
            id: "criterion",
            status: row.status,
            attempt,
            reason: REPLY_FAILURE_REASON,
            replyFailure: REPLY_FAILURE_FIELDS,
          },
        ],
      }
    }
  }
  const draft = initializeRunDraft({
    runId: name,
    sourceRevision: suite.sourceRevision!,
    manifest: suite,
    source: { kind: "live" },
    intendedSubject: { kind: "term", id: "kitty" },
  })
  draft.subject = {
    kind: "term",
    id: "kitty",
    version: "0.46.2",
    os: "macos",
    osVersion: null,
    outerTerminal: null,
    mux: null,
    config: null,
    permissions: null,
  }
  draft.identity = "verified"
  draft.measuredAt = startedAt
  draft.origin = { kind: "collector" }
  draft.rawReplies = { "device.primary-da": "\u001b[?62;52;c", "device.xtversion": "kitty(0.46.2)" }
  draft.results = results
  const value = finalizeCollectedDraft(draft as Parameters<typeof finalizeCollectedDraft>[0])
  return parseRun(
    "fixture.json",
    JSON.stringify({
      ...value,
      runId: name,
      measuredAt: startedAt,
      assertions,
      rawReplies: {
        ...value.rawReplies,
        ...replies,
        ...(selected && {
          "collector.selection": JSON.stringify({ ids: selected }),
          "collector.collectionAttempt": JSON.stringify({ ids: selected, startedAt, result: "completed" }),
        }),
      },
    }),
    ids,
    new Map([[suite.probeHash, suite]]),
  )
}

// capability.0 Supported, capability.1 Unsupported, capability.2 PROBE INVALID (its test recorded a reply failure),
// capability.3 PROBE CONFLICT (output says Supported, a later interaction run says Unsupported), capability.4 Untestable
// by review (declared over its PROBE TODO), capability.5 an attempted PROBE TODO whose test recorded the same reply
// failure, every other capability an untouched PROBE TODO.
const output = run("output-run", 5, [
  { id: "capability.0", status: "supported", method: "query_reply" },
  { id: "capability.1", status: "unsupported", method: "query_reply" },
  { id: "capability.2", status: "probe-invalid" },
  { id: "capability.3", status: "supported", method: "query_reply" },
  { id: "capability.5", status: "probe-todo" },
])
const interaction = run(
  "interaction-run",
  6,
  [{ id: "capability.3", status: "unsupported", method: "input_bytes" }],
  ["capability.3"],
)
const declared: DeclaredUntestableCell[] = [
  {
    kind: "term",
    id: "kitty",
    os: "macos",
    featureId: "capability.4",
    reason: "the fixture has no observer for it",
    testableIf: "a probe reads it back",
    declaredBy: "@dev/2",
    declaredOn: "2026-11-20",
    reviewedBy: "@cpo/term",
    reviewedOn: "2026-11-20",
    ruling: "fixture",
  },
]
const projection = projectResults([output, interaction], ids, { currentProbeHash: suite.probeHash, declared }, [])
const stored = projection.contexts["term:kitty"]!
const subjects = new Map([["kitty", { routeKey: "kitty", os: "macos", contextKey: "term:kitty", selected: stored }]])
const published = publicResults(projection, subjects)
const context = published.projection.contexts["term:kitty"]!

describe("publicResults publishes decided results only (Q4)", () => {
  it("the fixture holds all three undecided states before publication", () => {
    const statuses = Object.values(stored.cells).map((cell) => cell.featureResult?.status ?? cell.result.status)
    expect(new Set(statuses)).toEqual(
      new Set(["supported", "unsupported", "untestable", "probe-invalid", "probe-conflict", "probe-todo"]),
    )
  })

  it("leaves every undecided cell, result, test, state and count key out of the site and API projection", () => {
    expect(Object.keys(context.featureResults).sort()).toEqual(["capability.0", "capability.1", "capability.4"])
    const runs = [
      ...Object.values(published.projection.versions),
      ...Object.values(published.projection.history),
    ].flat()
    expect([...new Set(runs.map((version) => version.runId))].sort()).toEqual(["interaction-run", "output-run"])
    for (const version of runs) {
      for (const result of version.results) {
        expect(["supported", "unsupported", "untestable"]).toContain(result.status)
        for (const test of result.tests) expect(["supported", "unsupported", "untestable"]).toContain(test.status)
      }
      // D6: a run's counts keep the decided buckets (and the join's zero differs bucket) and lose the undecided keys.
      expect(Object.keys(version.counts).sort()).toEqual([
        "differs-by-context",
        "supported",
        "unsupported",
        "untestable",
      ])
    }
    // A declared cell cites its review, which its reason states.
    expect(context.featureResults["capability.4"]!.reason).toMatch(/^untestable by review 2026-11-20: /)
    expect(Object.keys(context.counts).sort()).toEqual(["differs-by-context", "supported", "unsupported", "untestable"])
    expect(published.selectedByBackend.kitty!.states).toEqual({
      "capability.0": "supported",
      "capability.1": "unsupported",
      "capability.4": "untestable",
    })
    expect(context).not.toHaveProperty("refusals")
    expect(JSON.stringify(published.projection)).not.toMatch(UNDECIDED)
    expect(JSON.stringify(published.selectedByBackend)).not.toMatch(UNDECIDED)
  })

  it("never publishes an undecided test's reason, replyFailure fields, or an undecided result's reason (@cto 760e9219, #37342)", () => {
    const everything = [
      JSON.stringify(published.projection),
      JSON.stringify(published.selectedByBackend),
      ...[...published.documents.values()].map((document) => document.bytes),
    ].join("\n")
    expect(everything).not.toContain(REPLY_FAILURE_REASON)
    expect(everything).not.toContain("replyFailure")
    expect(everything).not.toContain("no-match")
    expect(everything).not.toContain(TODO_REASON)
  })

  it("keeps counts folded over the whole catalogue, so a page reads the same numbers from published cells", () => {
    expect(context.score).toEqual({ supported: 1, all: 12 })
    const bar = aggregateCurrentResults(rollupInputs("kitty", context), context.catalogIds)
    expect(currentCoverageSentence(bar, context.catalogIds)).toBe("3 of 12 tested")
    expect(bar.counts).toMatchObject({ supported: 1, unsupported: 1, untestable: 1 })
  })

  it("hashes the public trace after leaving the undecided entries out (D5)", () => {
    const traces = [...published.documents.entries()].filter(([url]) => url.includes("/traces/"))
    expect(traces.length).toBeGreaterThan(0)
    for (const [url, document] of traces) {
      expect(document.bytes).not.toMatch(UNDECIDED)
      const featureResults = (document.document as { featureResults: Record<string, { status: string }> })
        .featureResults
      for (const entry of Object.values(featureResults)) {
        expect(["supported", "unsupported", "untestable"]).toContain(entry.status)
      }
      const receipt = Object.values(context.sources).find((source) => source.trace?.url === url)?.trace
      expect(receipt?.sha256).toBe(createHash("sha256").update(document.bytes).digest("hex"))
    }
  })
})
