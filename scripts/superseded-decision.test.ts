/**
 * @failure A pass graded under a criterion this build has since tightened keeps publishing when the current suite's
 *   attempt on the same cell did not decide it, or a decided cell is knocked out by an attempt whose criterion did not
 *   change, or a newer decided result stops replacing an older verdict.
 * @level l2
 * @consumer projectResults, the one selection every site page, census and script reads (#39007, @cpo/term).
 * @testonly none
 */
import { describe, expect, it } from "vitest"
import { parseRun } from "@terminfo/run-parser"
import { initializeRunDraft, type ProbeResult, type ProbeSuiteManifest } from "@terminfo/probe-defs"
import { finalizeCollectedDraft } from "../packages/terminfo.dev/src/capture-writer.ts"
import { projectResults } from "../docs/data/selected-results.ts"

const FEATURE = "modes.auto-wrap"
const CONTROL = "sgr.bold"
const ids = [FEATURE, CONTROL]
const OLD_SUITE = "old-suite"
const NEW_SUITE = "new-suite"

const manifest = (probeHash: string): ProbeSuiteManifest & { schemaVersion: 4 } => ({
  schemaVersion: 4,
  probeHash,
  sourceRevision: "1".repeat(40),
  generatedAt: "2026-11-20T05:00:00.000Z",
  adapterVersion: "3.3.2",
  catalogIds: ids,
  probes: { term: [], lib: [], mux: [] },
})
const OLD = manifest(OLD_SUITE)
const NEW = manifest(NEW_SUITE)

const ATTEMPT = { scope: "probe" as const, startedAt: "2026-11-20T05:00:00.000Z" }
const supported = (featureId: string, index: number): ProbeResult => ({
  featureId,
  status: "supported",
  attempt: ATTEMPT,
  assertionType: "query_reply",
  rawReplyRef: featureId,
  tests: [{ id: "criterion", status: "supported", attempt: ATTEMPT, assertionRefs: [index], rawReplyRef: featureId }],
})
const notRun = (featureId: string): ProbeResult => ({
  featureId,
  status: "probe-todo",
  attempt: { scope: "none" },
  tests: [],
})
const assertions = ids.map((featureId) => ({
  featureId,
  kind: "positive" as const,
  assertionType: "query_reply" as const,
  rawReplyRef: featureId,
  expected: "ACK",
  observed: "ACK",
}))

const run = (options: {
  runId: string
  suite: ProbeSuiteManifest & { schemaVersion: 4 }
  results: ProbeResult[]
  measuredAt: string
}) => {
  const draft = initializeRunDraft({
    runId: options.runId,
    sourceRevision: options.suite.sourceRevision!,
    manifest: options.suite,
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
  draft.measuredAt = options.measuredAt
  draft.origin = { kind: "collector" }
  draft.rawReplies = {
    "collector.selection": JSON.stringify({ ids }),
    "collector.collectionAttempt": JSON.stringify({ ids, startedAt: options.measuredAt, result: "completed" }),
  }
  draft.results = options.results
  const sealed = finalizeCollectedDraft(draft as Parameters<typeof finalizeCollectedDraft>[0]) as unknown as Record<
    string,
    unknown
  >
  return parseRun(
    `${options.runId}.json`,
    JSON.stringify({
      ...sealed,
      assertions,
      rawReplies: {
        ...(sealed.rawReplies as Record<string, string>),
        ...Object.fromEntries(ids.map((id) => [id, "ACK"])),
      },
    }),
    ids,
    new Map([
      [OLD.probeHash, OLD],
      [NEW.probeHash, NEW],
    ]),
  )
}

/** Old suite decided the row Supported; the new suite's attempt ran the row and recorded no result for it. */
const pair = () => [
  run({
    runId: "old-run",
    suite: OLD,
    results: ids.map((id, index) => supported(id, index)),
    measuredAt: "2026-11-20T05:00:00.000Z",
  }),
  run({ runId: "new-run", suite: NEW, results: ids.map(notRun), measuredAt: "2026-11-26T05:00:00.000Z" }),
]

const entryHashes = (changed: boolean) => (suiteId: string) =>
  Object.fromEntries(ids.map((id) => [id, changed && suiteId === NEW_SUITE && id === FEATURE ? "h2" : "h1"]))

const project = (changed: boolean) =>
  projectResults(pair(), ids, { currentProbeHash: NEW_SUITE, entryHashes: entryHashes(changed) }, [])

const onlyCell = (projection: ReturnType<typeof project>) => Object.values(projection.contexts)[0]!.cells[FEATURE]!

describe("#39007 a tightened criterion stops publishing a superseded pass", () => {
  it("reads To do when the row's entry changed and the newer attempt did not decide it", () => {
    const cell = onlyCell(project(true))
    expect(cell.featureResult?.status).toBe("probe-todo")
    expect(cell.supersededDecision).toMatchObject({ status: "supported", suiteId: OLD_SUITE, runId: "old-run" })
  })

  it("keeps the decided cell when the row's entry did not change", () => {
    const cell = onlyCell(project(false))
    expect(cell.featureResult?.status).toBe("supported")
    expect(cell.supersededDecision).toBeUndefined()
  })

  it("counts the superseded row as To do, not Supported", () => {
    const context = Object.values(project(true).contexts)[0]!
    expect(context.counts["probe-todo"]).toBe(1)
  })
})
