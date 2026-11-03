import { finalizeCollectedDraft } from "../packages/terminfo.dev/src/capture-writer.ts"
/**
 * @failure Historical rows are selected as current, or stored TODO/failure disappear from current scores.
 * @level l2
 * @consumer Current result selector, API v3 and site build
 * @testonly none
 * @reach fs-read vendor/terminfo.dev/test-fixtures/probes-apps/** vendor/terminfo.dev/content/features.json vendor/terminfo.dev/content/suites/**
 */
import { describe, expect, it } from "vitest"
import { parseRun, parseSuiteManifest } from "@terminfo/run-parser"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { publicResults } from "../docs/data/public-results.ts"
import type { ProbeResult, ProbeSuiteManifest, TextQualification } from "@terminfo/probe-defs"
import { ENVIRONMENT_GROUP_IDS, initializeRunDraft } from "@terminfo/probe-defs"
import { projectResults, maskRunnerStorePath, projectedContextKey } from "../docs/data/selected-results.ts"
import { currentCoverageSentence } from "../docs/data/release-scope.ts"
import { candidateFromSelected, pickContextRun } from "../docs/data/run-selection.ts"

const ids = Array.from({ length: 273 }, (_, index) => `capability.${index}`)
const suite: ProbeSuiteManifest & { schemaVersion: 4 } = {
  schemaVersion: 4,
  probeHash: "current-five-status",
  sourceRevision: "1".repeat(40),
  generatedAt: "2026-10-21T05:00:00.000Z",
  adapterVersion: "3.3.2",
  catalogIds: ids,
  probes: { term: [], lib: [], mux: [] },
}
const attempt = { scope: "probe" as const, startedAt: "2026-10-21T05:00:00.000Z" }
const raw = (results: ProbeResult[], manifest = suite) => {
  const draft = initializeRunDraft({
    runId: "current-run",
    sourceRevision: manifest.sourceRevision!,
    manifest,
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
  draft.measuredAt = "2026-10-21T05:00:00.000Z"
  draft.origin = { kind: "collector" }
  draft.rawReplies = { "device.primary-da": "\u001b[?62;52;c", "device.xtversion": "kitty(0.46.2)" }
  draft.results = results
  return finalizeCollectedDraft(draft as Parameters<typeof finalizeCollectedDraft>[0])
}
const parse = (value: object) =>
  parseRun("fixture.json", JSON.stringify(value), ids, new Map([[suite.probeHash, suite]]))
const todos = (): ProbeResult[] =>
  ids.map((featureId) => ({
    featureId,
    status: "test-todo",
    attempt: { scope: "none" },
    tests: [],
    reason: "No implementation",
  }))

function supportedBaseline() {
  const results = todos()
  const assertions = ids.slice(0, 4).map((featureId) => ({
    featureId,
    kind: "positive",
    assertionType: "query_reply",
    rawReplyRef: featureId,
    expected: "ACK",
    observed: "ACK",
  }))
  for (const [index, featureId] of ids.slice(0, 4).entries()) {
    results[index] = {
      featureId,
      status: "supported",
      assertionType: "query_reply",
      rawReplyRef: featureId,
      attempt,
      tests: [{ id: "criterion", status: "supported", attempt, assertionRefs: [index], rawReplyRef: featureId }],
    }
  }
  const value = raw(results)
  return parse({
    ...value,
    runId: "baseline-run",
    assertions,
    rawReplies: { ...value.rawReplies, ...Object.fromEntries(ids.slice(0, 4).map((id) => [id, "ACK"])) },
  })
}
// CTO70df: invalid original evidence time must not silently fall through to key ordering.
it.each([{ sources: [] }, { sources: [{ runId: "bad-run", measuredAt: "not-a-date", suiteId: "suite", suiteRelation: "tree" as const }] }])(
  "rejects a context without a finite original evidence time: %j",
  ({ sources }) => {
    const candidate = { key: "invalid-evidence-context", kind: "term", terminalId: "kitty", os: "linux", permissions: null, sources, states: {} }
    expect(() => pickContextRun([candidate])).toThrow(/invalid-evidence-context/)
  },
)

// Current selection reads the stored five statuses and frozen denominator
// without applying later interpretations.
describe("current execution projection", () => {
  // #31713 AC1/AC2: a public cell must explain explicit nonselection without claiming an attempted test.
  // Existing subset cases protect prior results and scores, but never inspect an untouched cell's explanation.
  // @failure Unselected and selected-but-unstarted cells both lose their scheduling distinction in site/API output.
  // @level l2 @consumer publicResults shared site/API mapping; no new production seam.
  it("explains an unselected row separately from a selected but unstarted row", () => {
    const results = todos().map((result) => ({ ...result, reason: "Required probe test has not started" }))
    const value = raw(results)
    const selectedIds = [ids[0]!, ids[2]!]
    const run = parse({
      ...value,
      rawReplies: {
        ...value.rawReplies,
        "collector.selection": JSON.stringify({ ids: selectedIds }),
        "collector.collectionAttempt": JSON.stringify({
          ids: selectedIds,
          result: "failed",
          error: "Collection failed before any callback started",
        }),
      },
    })
    const retained = JSON.stringify(run.results)
    const projection = projectResults([run], ids, { currentProbeHash: suite.probeHash }, [])
    const published = publicResults(projection, new Map()).projection.contexts["term:kitty"]!
    expect(published.cells[ids[1]!]!.attempt).toEqual({ scope: "none" })
    expect(published.cells[ids[1]!]!.status).toBe("test-todo")
    expect(published.cells[ids[2]!]!.reason ?? "").not.toMatch(/not selected/i)
    expect(JSON.stringify(run.results)).toBe(retained)
    expect(published.cells[ids[1]!]!.reason ?? "").toMatch(/not selected/i)
    expect(published.cells[ids[1]!]!.presentation).toEqual({ state: "not-reviewed" })
    const withoutSelection = parse(value)
    const unselectedProjection = projectResults([withoutSelection], ids, { currentProbeHash: suite.probeHash }, [])
    const unselectedPublic = publicResults(unselectedProjection, new Map()).projection.contexts["term:kitty"]!
    expect(unselectedPublic.cells[ids[1]!]!.reason).toBeUndefined()
  })

  // The reviewed-context replacement orders original evidence, never newer no-output attempts.
  // Existing composition tests miss cross-context ties and a newer non-default profile.
  it("does not let a newer attempt supersede original evidence from another host generation", () => {
    const baseline = supportedBaseline()
    const olderHost = {
      ...baseline,
      runId: "older-host",
      measuredAt: "2026-10-20T00:00:00Z",
      subject: { ...baseline.subject, osVersion: "old" },
    }
    const chosenHost = {
      ...baseline,
      runId: "chosen-host",
      measuredAt: "2026-10-21T00:00:00Z",
      subject: { ...baseline.subject, osVersion: "new" },
    }
    const projection = projectResults([olderHost, chosenHost], ids, { currentProbeHash: suite.probeHash }, [])
    const candidates = Object.values(projection.contexts).map((context) => {
      if (context.contributingRunIds.includes(olderHost.runId)) {
        context.attempts.push({
          runId: "no-output",
          path: "working/no-output.json",
          selection: { ids: [ids[0]!] },
          attempt: { ids: [ids[0]!], result: "completed", startedAt: "2027-01-01T00:00:00Z" },
          noOutputIds: [ids[0]!],
        })
      }
      const candidate = candidateFromSelected(context.contextKey, context, {}, projection)
      if (!candidate) throw new Error("fixture context lost original sources")
      expect(candidate.sources.map((source) => source.runId)).not.toContain("no-output")
      return candidate
    })
    const chosen = candidates.find((candidate) =>
      candidate.sources.some((source) => source.runId === chosenHost.runId),
    )!
    expect(pickContextRun(candidates)).toMatchObject({
      run: { key: chosen.key },
      selection: "latest original evidence",
    })
    const older = candidates.find((candidate) => candidate !== chosen)!
    const rewritten = projectResults(
      [{ ...olderHost, runId: "rewritten-old-host", sha256: "f".repeat(64) }, chosenHost],
      ids,
      { currentProbeHash: suite.probeHash },
      [],
    )
    const rewrittenCandidates = Object.values(rewritten.contexts).flatMap((context) => {
      const candidate = candidateFromSelected(context.contextKey, context, {}, rewritten)
      return candidate ? [candidate] : []
    })
    expect(pickContextRun(rewrittenCandidates)).toMatchObject({ run: { key: chosen.key } })
    const composed = {
      ...older,
      sources: [
        ...older.sources,
        {
          ...chosen.sources[0]!,
          measuredAt: "2026-10-22T00:00:00Z",
        },
      ],
    }
    expect(pickContextRun([chosen, composed])).toMatchObject({ run: { key: older.key } })
    const tied = {
      ...older,
      sources: older.sources.map((source) => ({ ...source, measuredAt: chosenHost.measuredAt })),
    }
    for (const order of [
      [tied, chosen],
      [chosen, tied],
    ]) {
      expect(pickContextRun(order)).toMatchObject({ run: { key: chosen.key }, selection: "latest original evidence" })
    }
    const upperKey = { ...tied, key: projectedContextKey({ ...baseline.subject, config: "Z" }, 2) }
    const lowerKey = { ...tied, key: projectedContextKey({ ...baseline.subject, config: "a" }, 2) }
    for (const order of [
      [upperKey, lowerKey],
      [lowerKey, upperKey],
    ]) {
      expect(pickContextRun(order)).toMatchObject({ run: { key: upperKey.key } })
    }
    const nondefault = {
      ...chosen,
      permissions: "clipboard",
      sources: chosen.sources.map((source) => ({
        ...source,
        measuredAt: "2028-01-01T00:00:00Z",
      })),
    }
    expect(pickContextRun([older, nondefault])).toMatchObject({ run: { key: older.key }, selection: "default profile" })
    expect(pickContextRun([older, tied, nondefault])).toMatchObject({ run: { key: nondefault.key } })
    expect(pickContextRun([{ ...older, permissions: "clipboard" }, nondefault])).toMatchObject({
      run: { key: nondefault.key },
      selection: "latest original evidence",
    })
  })

  // A context with both old and current cells remains eligible. Whole-run filtering misses this.
  it("keeps a mixed-source context current and refuses an invalid zero-source candidate", () => {
    const baseline = supportedBaseline()
    const projection = projectResults([baseline], ids, { currentProbeHash: suite.probeHash }, [])
    const context = Object.values(projection.contexts)[0]!
    const candidate = candidateFromSelected(context.contextKey, context, {}, projection)!
    const mixed = {
      ...candidate,
      sources: [{ ...candidate.sources[0]!, suiteRelation: "older" as const }, ...candidate.sources],
    }
    const empty = { ...candidate, key: "attempt-only", sources: [] }
    // An all-stale sibling makes some→every change the pick instead of reaching the one-item fallback.
    const stale = {
      ...candidate,
      key: projectedContextKey({ ...baseline.subject, config: "older-only-fixture" }, 2),
      sources: candidate.sources.map((source) => ({ ...source, suiteRelation: "older" as const })),
    }
    expect(pickContextRun([stale, mixed])).toEqual({ run: mixed, selection: "only current" })
    expect(() => pickContextRun([empty, stale, mixed])).toThrow(/attempt-only/)
    expect(
      candidateFromSelected(context.contextKey, { ...context, contributingRunIds: [] }, {}, projection),
    ).toBeUndefined()
    expect(pickContextRun([candidate])).toEqual({ run: candidate, selection: "only current" })
  })
  // CTO R1: a working-only context must not rename an admitted context's public key.
  it("keeps public context keys stable beside a working-only context", () => {
    const current = supportedBaseline()
    const value = raw(todos())
    const working = parse({ ...value, runId: "working-linux", subject: { ...value.subject, os: "linux" } })
    const projection = projectResults(
      [current],
      ids,
      { currentProbeHash: suite.probeHash, workingRuns: [working] },
      [],
    )
    expect(Object.keys(projection.versions)).toEqual(["term:kitty"])
    expect(Object.keys(projection.contexts)).toContain("term:kitty")
    const shared = projection.contexts["term:kitty"]!
    expect(shared.contributingRunIds).toEqual([current.runId])
    expect(Object.values(shared.cells).every((cell) => cell.origin.runId === current.runId)).toBe(true)
    const workingKey = projectedContextKey(working.subject, 2)
    expect(projection.contexts[workingKey]?.contributingRunIds).toEqual([working.runId])
    expect(projection.versions).not.toHaveProperty(workingKey)
    expect(projection).not.toHaveProperty("current")
  })

  // CTO R2: the canonical owner must resolve a retained attempt, even without the report's matcher.
  it("resolves a pre-start attempt to its intended working context in the canonical projection", () => {
    const current = supportedBaseline()
    const value = raw(todos())
    const working = parse({
      ...value,
      runId: "working-config",
      subject: { ...value.subject, config: "isolated" },
    })
    const selection = { ids: [ids[0]!] }
    const outcome = { ...selection, result: "failed", error: "Original pre-start failure" }
    const input = {
      context: { context: "kitty/macos", kind: "term" as const, terminalId: "kitty", os: "macos" },
      intendedSubject: { kind: "term", id: "kitty", os: "macos", config: "isolated" },
      runId: "intended-draft",
      path: "intended.draft.json",
      rawReplies: {
        "collector.selection": JSON.stringify(selection),
        "collector.collectionAttempt": JSON.stringify(outcome),
      },
    }
    const projection = projectResults(
      [current],
      ids,
      { currentProbeHash: suite.probeHash, workingRuns: [working], workingAttempts: [input] },
      [],
    )
    expect(projection.contexts[projectedContextKey(working.subject, 2)]?.attempts).toMatchObject([
      { runId: input.runId, path: input.path, attempt: outcome, noOutputIds: selection.ids },
    ])
    expect(projection.contexts).not.toHaveProperty("kitty/macos")
    expect(projection.contexts["term:kitty"]?.attempts).toEqual([])
  })

  // #31594 AC1/AC2: whole-run fixtures cannot expose a partial run erasing untouched evidence.
  // The existing parser/projection seam must retain cells, not select the best-looking result.
  it.each(["test-failure", "test-todo"] as const)(
    "composes selected %s with original unselected and unreached results from two runs",
    (status) => {
      const prior = supportedBaseline()
      const nextResults = todos()
      const emittedAttempt = { scope: "probe" as const, startedAt: "2026-10-21T06:00:00.000Z" }
      nextResults[0] = {
        featureId: ids[0]!,
        status,
        attempt: emittedAttempt,
        tests: [
          {
            id: "criterion",
            status,
            attempt: status === "test-todo" ? { scope: "none" } : emittedAttempt,
            reason: "Selected callback retained this outcome",
          },
        ],
        reason: "Selected callback retained this outcome",
      }
      nextResults[3] = {
        featureId: ids[3]!,
        status: "test-todo",
        attempt: emittedAttempt,
        tests: [{ id: "criterion", status: "test-todo", attempt: { scope: "none" }, reason: "Observable unavailable" }],
        reason: "Observable unavailable",
      }
      const selectedIds = [ids[0]!, ids[2]!, ids[3]!]
      const next = raw(nextResults)
      const latest = parse({
        ...next,
        runId: "selected-run",
        measuredAt: "2026-10-21T06:00:00.000Z",
        rawReplies: {
          ...next.rawReplies,
          "collector.selection": JSON.stringify({ ids: selectedIds }),
          "collector.collectionAttempt": JSON.stringify({
            ids: selectedIds,
            startedAt: "2026-10-21T06:00:00.000Z",
            result: "failed",
            error: "Worker stopped before the third selected callback",
          }),
        },
      })
      const projection = projectResults([prior, latest], ids, { currentProbeHash: suite.probeHash }, [])
      expect(projection).toMatchObject({
        contexts: {
          "term:kitty": {
            contributingRunIds: [prior.runId, latest.runId],
            cells: {
              [ids[0]!]: { origin: { runId: latest.runId, resultId: ids[0] }, result: { status } },
              [ids[1]!]: { origin: { runId: prior.runId, resultId: ids[1] } },
              [ids[2]!]: { origin: { runId: prior.runId, resultId: ids[2] } },
              [ids[3]!]: { origin: { runId: latest.runId, resultId: ids[3] } },
            },
          },
        },
      })
      const current = projection.contexts["term:kitty"]!
      expect(current.cells[ids[1]!]!.result).toBe(prior.results?.[1])
      expect(current.cells[ids[2]!]!.result).toBe(prior.results?.[2])
      expect(current.cells[ids[3]!]!.result).toBe(latest.results?.[3])
      expect(current.cells[ids[1]!]!.run).toBe(prior)
      expect(current.cells[ids[1]!]!.run.rawReplies[ids[1]!]).toBe("ACK")
      expect(current.cells[ids[1]!]!.run.assertions[1]?.featureId).toBe(ids[1])
      expect(current.cells[ids[2]!]!.run.measuredAt).toBe(prior.measuredAt)
      expect(current.attempts).toMatchObject([
        {
          runId: latest.runId,
          selection: { ids: selectedIds },
          attempt: { result: "failed", error: "Worker stopped before the third selected callback" },
          noOutputIds: [ids[2]],
        },
      ])
      expect(current).not.toHaveProperty("sha256")
      expect(current).not.toHaveProperty("sealedAt")
      // #31610 AC1/AC4: the private fold above passed while the public mapper lost these cells.
      // RED at5044b105 used the old public seam and received TODO for both retained cells.
      const published = publicResults(projection, new Map()).projection.contexts["term:kitty"]!
      expect(published.cells[ids[1]!]!.status).toBe("supported")
      expect(published.cells[ids[2]!]!.status).toBe("supported")
      expect(published.contributingRunIds).toEqual([prior.runId, latest.runId])
      expect(published.counts).toEqual(current.counts)
      expect(published.cells[ids[0]!]!.origin).toEqual({ runId: latest.runId, resultId: ids[0] })
      expect(published.cells[ids[2]!]!.origin).toEqual({ runId: prior.runId, resultId: ids[2] })
      expect(published.cells[ids[2]!]!.measuredAt).toBe(prior.measuredAt)
      expect(published.attempts).toEqual([
        {
          runId: latest.runId,
          startedAt: "2026-10-21T06:00:00.000Z",
          noOutputIds: [ids[2]],
        },
      ])
      expect(published.sources[prior.runId]!.sha256).toBe(prior.sha256)
      expect(published).not.toHaveProperty("runId")
      expect(published).not.toHaveProperty("sha256")
      expect(published).not.toHaveProperty("sealedAt")
      // Original immutable runs keep their full cells apart from the composed context.
      expect(projection.history["term:kitty"]?.find((run) => run.runId === latest.runId)).toMatchObject({
        runId: latest.runId,
        sha256: latest.sha256,
        results: latest.results,
      })
    },
  )

  // No-output has its own retained outcome; an old result must never imply the requested run finished.
  it.each(["failed", "cancelled", "empty"] as const)(
    "shows a selected %s attempt without refreshing old cells",
    (result) => {
      const prior = supportedBaseline()
      const selection = { ids: result === "empty" ? [] : [ids[0]!] }
      const value = raw(todos())
      const outcome = result === "empty" ? { result } : { result, error: "Original worker error\nsecond line" }
      const latest = parse({
        ...value,
        runId: "no-output-run",
        measuredAt: "2026-10-21T07:00:00.000Z",
        rawReplies: {
          ...value.rawReplies,
          "collector.selection": JSON.stringify(selection),
          "collector.collectionAttempt": JSON.stringify({ ...selection, ...outcome }),
        },
      })
      const projection = projectResults([prior, latest], ids, { currentProbeHash: suite.probeHash }, [])
      const context = projection.contexts["term:kitty"]!
      expect(context.contributingRunIds).toEqual([prior.runId])
      expect(context.cells[ids[0]!]!.result).toBe(prior.results?.[0])
      expect(context.cells[ids[0]!]!.run.measuredAt).toBe(prior.measuredAt)
      expect(context.attempts).toMatchObject([
        { runId: latest.runId, selection, attempt: outcome, noOutputIds: selection.ids },
      ])
      expect(context.attempts[0]!.attempt).not.toHaveProperty("startedAt")
      expect(projection.history["term:kitty"]?.find((run) => run.runId === latest.runId)?.results).toEqual(
        latest.results,
      )
    },
  )

  it("reports a pre-start refusal with no prior evidence without inventing a run or result", () => {
    const selection = { ids: [ids[0]!] }
    const outcome = { ...selection, result: "failed", error: "Prerequisite missing" }
    const projection = projectResults(
      [],
      ids,
      {
        currentProbeHash: suite.probeHash,
        workingAttempts: [
          {
            context: { context: "term:kitty", kind: "term", terminalId: "kitty", os: "macos" },
            intendedSubject: { kind: "term", id: "kitty", os: "macos" },
            runId: "original-draft",
            path: "original.draft.json",
            rawReplies: {
              "collector.selection": JSON.stringify(selection),
              "collector.collectionAttempt": JSON.stringify(outcome),
            },
          },
        ],
      },
      [],
    )
    const context = projection.contexts["term:kitty"]!
    expect(context.cells).toEqual({})
    expect(context.missingIds).toEqual(ids)
    expect(context.counts["test-todo"]).toBe(ids.length)
    expect(context.contributingRunIds).toEqual([])
    expect(context.complete).toBe(false)
    expect(context.attempts).toMatchObject([{ runId: "original-draft", path: "original.draft.json", attempt: outcome }])
    expect(projection.versions).toEqual({})
  })

  it.each([
    ["recorded collection start", "07", "06", "A"],
    ["run ID only for a start tie", "06", "06", "Z"],
  ])(
    "orders selected emissions by %s, not measured time, per-probe time or input order",
    (_label, aHour, zHour, winner) => {
      const prior = supportedBaseline()
      const selected = (runId: string, hour: string, status: "test-failure" | "test-todo", measuredHour: string) => {
        const results = todos()
        const probeAttempt = { scope: "probe" as const, startedAt: `2026-10-21T${measuredHour}:00:00.000Z` }
        results[0] = {
          featureId: ids[0]!,
          status,
          attempt: probeAttempt,
          tests: [{ id: "criterion", status, attempt: probeAttempt, reason: "Emitted" }],
          reason: "Emitted",
        }
        const value = raw(results)
        return parse({
          ...value,
          runId,
          measuredAt: probeAttempt.startedAt,
          rawReplies: {
            ...value.rawReplies,
            "collector.selection": JSON.stringify({ ids: [ids[0]] }),
            "collector.collectionAttempt": JSON.stringify({
              ids: [ids[0]],
              startedAt: `2026-10-21T${hour}:00:00.000Z`,
              result: "completed",
            }),
          },
        })
      }
      const a = selected("A", aHour!, "test-failure", "05")
      const z = selected("Z", zHour!, "test-todo", "09")
      const projection = projectResults([prior, z, a], ids, { currentProbeHash: suite.probeHash }, [])
      const context = projection.contexts["term:kitty"]!
      expect(context.cells[ids[0]!]!.origin.runId).toBe(winner)
      expect(context.cells[ids[0]!]!.result).toBe((winner === "A" ? a : z).results?.[0])
    },
  )

  it("keeps every TODO visible over all 273 and admits current identity using the existing measured rule", () => {
    const run = parse(raw(todos()))
    const projection = projectResults(
      [run],
      ["different-live-catalogue"],
      { currentProbeHash: suite.probeHash },
      [],
    )
    const selected = projection.contexts["term:kitty"]
    expect(Object.values(selected!.cells).map((cell) => cell.result)).toEqual(run.results)
    expect(selected?.score).toEqual({ supported: 0, all: 273 })
    expect(selected?.counts["test-todo"]).toBe(273)
    expect(selected?.complete).toBe(false)
    expect(projection.table[run.runId]).toEqual(Object.fromEntries(ids.map((id) => [id, "test-todo"])))
    expect(projection).toMatchObject({ contexts: { "term:kitty": { contributingRunIds: [run.runId] } } })
    const context = projection.contexts["term:kitty"]!
    expect(Object.values(context.cells).map((cell) => cell.origin)).toEqual(
      ids.map((resultId) => ({ runId: run.runId, resultId })),
    )
  })
  it("retains an actual failed check alongside TODO without a decisive assertion hiding either", () => {
    const results = todos()
    results[0] = {
      featureId: ids[0]!,
      status: "test-failure",
      attempt,
      tests: [{ id: "collection", status: "test-failure", attempt, reason: "callback threw" }],
      reason: "callback threw",
    }
    const projection = projectResults([parse(raw(results))], ids, { currentProbeHash: suite.probeHash }, [])
    expect(projection.contexts["term:kitty"]?.counts).toEqual({
      supported: 0,
      unsupported: 0,
      untestable: 0,
      "test-todo": 272,
      "test-failure": 1,
    })
    expect(projection.contexts["term:kitty"]?.complete).toBe(false)
  })
  it("can finish all unsupported at zero supported out of 273, without excluding capabilities", () => {
    const value = raw(
      ids.map((featureId, index) => ({
        featureId,
        status: "unsupported",
        assertionType: "query_reply",
        rawReplyRef: featureId,
        attempt,
        tests: [{ id: "criterion", status: "unsupported", attempt, assertionRefs: [index], rawReplyRef: featureId }],
      })),
    )
    for (const featureId of ids) value.rawReplies[featureId as keyof typeof value.rawReplies] = "NO"
    const assertions = ids.map((featureId) => ({
      featureId,
      kind: "negative",
      assertionType: "query_reply",
      rawReplyRef: featureId,
      expected: "ACK",
      observed: "NO",
    }))
    const projection = projectResults(
      [parse({ ...value, assertions })],
      ids,
      { currentProbeHash: suite.probeHash },
      [],
    )
    expect(projection.contexts["term:kitty"]?.score).toEqual({ supported: 0, all: 273 })
    expect(projection.contexts["term:kitty"]?.counts.unsupported).toBe(273)
    expect(projection.contexts["term:kitty"]?.complete).toBe(true)
  })
  it("grades a 273-row run over its 264 graded ids and never counts an environment group", () => {
    const supportedGroup = ENVIRONMENT_GROUP_IDS[0]
    const splitIds = [...ENVIRONMENT_GROUP_IDS, ...Array.from({ length: 264 }, (_, index) => `capability.${index}`)]
    const results: ProbeResult[] = splitIds.map((featureId) =>
      featureId === supportedGroup
        ? {
            featureId,
            status: "supported",
            assertionType: "query_reply",
            rawReplyRef: featureId,
            attempt,
            tests: [{ id: "criterion", status: "supported", attempt, assertionRefs: [0], rawReplyRef: featureId }],
          }
        : { featureId, status: "test-todo", attempt: { scope: "none" }, tests: [], reason: "No implementation" },
    )
    const splitSuite: ProbeSuiteManifest & { schemaVersion: 4 } = { ...suite, catalogIds: splitIds }
    const base = raw(results, splitSuite)
    const value = {
      ...base,
      rawReplies: { ...base.rawReplies, [supportedGroup]: "OK" },
      assertions: [
        {
          featureId: supportedGroup,
          kind: "positive",
          assertionType: "query_reply",
          rawReplyRef: supportedGroup,
          expected: "OK",
          observed: "OK",
        },
      ],
    }
    const run = parseRun("fixture.json", JSON.stringify(value), splitIds, new Map([[splitSuite.probeHash, splitSuite]]))
    const projection = projectResults([run], splitIds, { currentProbeHash: suite.probeHash }, [])
    const selected = projection.contexts["term:kitty"]
    // The supported-looking environment row stays recorded, and never graded: numerator and
    // denominator both cover the same 264 ids (CTO condition, verdict 427f2da3).
    expect(selected?.cells[supportedGroup]?.result.status).toBe("supported")
    expect(currentCoverageSentence(selected!, selected!.catalogIds)).not.toContain("NOT MEASURED")
    expect(selected?.score).toEqual({ supported: 0, all: 264 })
    expect(selected?.counts).toEqual({
      supported: 0,
      unsupported: 0,
      untestable: 0,
      "test-todo": 264,
      "test-failure": 0,
    })
    expect(selected?.complete).toBe(false)
  })
})

// An unchanged reviewed default key must still identify its canonical subject after the rename.
it("normalizes historical reviewed context keys without rewriting arbitrary configuration text", () => {
  expect(maskRunnerStorePath('app:kitty@["app","kitty","macos",null,null,null,null,null]')).toBe(
    'term:kitty@["term","kitty","macos",null,null,null,null,null]',
  )
  expect(maskRunnerStorePath('headless:xtermjs@["headless","xtermjs","linux",null,null,null,null,null]')).toBe(
    'lib:xtermjs@["lib","xtermjs","linux",null,null,null,null,null]',
  )
  expect(maskRunnerStorePath("app:keep-this-config")).toBe("app:keep-this-config")
})

it("retains the recorded live source on selected current metadata", () => {
  const loaded = parse(raw(todos()))
  const selected = projectResults([loaded], ids, { currentProbeHash: suite.probeHash }, []).history[
    "term:kitty"
  ]?.[0]
  expect(selected?.schemaVersion).toBe(4)
  expect(selected?.source).toEqual({ kind: "live" })
})
