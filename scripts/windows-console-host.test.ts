import { finalizeCollectedDraft } from "../packages/terminfo.dev/src/capture-writer.ts"
/**
 * @failure A Windows console host's own answer, or its silence, is published as the terminal's verdict.
 * @level l2
 * @consumer Current result selector, historical selector, API v3 and site build
 * @testonly none
 */
import { describe, expect, it } from "vitest"
import { parseRun } from "@terminfo/run-parser"
import { initializeRunDraft, type ProbeResult, type ProbeSuiteManifest } from "@terminfo/probe-defs"
import { classifyDevelopmentRun, projectResults } from "../docs/data/selected-results.ts"

// #30720 (@cto rulings fc63f412, 1ee8cf0b, f126327b): no other test reads a Windows run, so none sees the
// reader count conhost's DA1-ordered answers as the terminal's.
const ids = Array.from({ length: 273 }, (_, index) => `capability.${index}`)
const suite: ProbeSuiteManifest & { schemaVersion: 4 } = {
  schemaVersion: 4,
  probeHash: "windows-console-host",
  sourceRevision: "1".repeat(40),
  generatedAt: "2026-10-22T05:00:00.000Z",
  adapterVersion: "3.3.2",
  catalogIds: ids,
  probes: { term: ids, lib: [], mux: [] },
}
const attempt = { scope: "probe" as const, startedAt: "2026-10-22T05:00:00.000Z" }
const HOST_DA1 = "\u001b[?61;6;7;14;21;22;23;24;28;32;42c"
const HOST_ANSWERED = "answered by the Windows console host OpenConsole.exe, not measured on the terminal"
const NO_REPLY = "no reply after the console host's DA1; the host may have swallowed the query"
/** Each decided cell retains its query assertion type and the raw reply its verdict rests on. */
const decided: Array<[string, "supported" | "unsupported" | "probe-invalid", "query_reply", string]> = [
  // The host answers DECRQM itself, before its DA1.
  [ids[0]!, "supported", "query_reply", exchange("\u001b[?2026$p\u001b[c", `\u001b[?2026;2$y${HOST_DA1}`)],
  // XTWINOPS 14 passes through: the terminal's reply follows the host's DA1.
  [ids[1]!, "supported", "query_reply", exchange("\u001b[14t\u001b[c", `${HOST_DA1}\u001b[4;595;800t`)],
  // Nothing after the host's DA1: silence under the host proves nothing.
  [ids[2]!, "unsupported", "query_reply", exchange("\u001b]10;?\u0007\u001b[c", HOST_DA1)],
  // The cursor report carries no sentinel; the host answers it.
  [ids[3]!, "supported", "query_reply", exchange("\u001b[6n", "\u001b[1;5R")],
  // A plain reply string carries no sentinel: the host's DA, held like any unsentinelled reply.
  [ids[4]!, "supported", "query_reply", HOST_DA1],
  // A failed attempt stays visible as a failure: it is a repair item, not a capability claim.
  [ids[5]!, "probe-invalid", "query_reply", exchange("\u001b[?u\u001b[c", `\u001b[?0u${HOST_DA1}`)],
]
function exchange(sequence: string, raw: string): string {
  return JSON.stringify({ writes: [], queries: [{ sequence, raw }] })
}
const subject = (os: string) => ({
  kind: "term" as const,
  id: "windows-terminal",
  version: "1.21.240823001",
  os,
  osVersion: null,
  outerTerminal: null,
  mux: null,
  config: null,
  permissions: null,
})
const rawReplies = (): Record<string, string> => ({
  "device.primary-da": HOST_DA1,
  "device.xtversion": "",
  "collector.terminalOwnership": JSON.stringify({ windowsHosted: { consoleHost: { image: "OpenConsole.exe" } } }),
  ...Object.fromEntries(decided.map(([id, , , reply]) => [id, reply])),
})
const assertions = () =>
  decided.map(([featureId, status]) => ({
    featureId,
    kind: (status === "unsupported" ? "negative" : "positive") as "negative" | "positive",
    assertionType: "query_reply" as const,
    rawReplyRef: featureId,
    expected: "reply",
    observed: "reply",
  }))
const current = (os: string) => {
  const results: ProbeResult[] = ids.map((featureId) => ({
    featureId,
    status: "probe-todo",
    attempt: { scope: "none" },
    tests: [],
    reason: "No implementation",
  }))
  decided.forEach(([featureId, status, assertionType], index) => {
    results[ids.indexOf(featureId)] =
      status === "probe-invalid"
        ? {
            featureId,
            status,
            assertionType,
            rawReplyRef: featureId,
            attempt,
            tests: [{ id: "collection", status, attempt, reason: "callback threw" }],
            reason: "callback threw",
          }
        : {
            featureId,
            status,
            assertionType,
            rawReplyRef: featureId,
            attempt,
            tests: [{ id: "criterion", status, attempt, assertionRefs: [index], rawReplyRef: featureId }],
          }
  })
  const draft = initializeRunDraft({
    runId: "windows-" + os,
    sourceRevision: suite.sourceRevision!,
    manifest: suite,
    source: { kind: "live" },
    intendedSubject: { kind: "term", id: "windows-terminal" },
  })
  draft.subject = subject(os)
  draft.identity = "verified"
  draft.measuredAt = "2026-10-22T05:00:00.000Z"
  draft.origin = { kind: "collector" }
  draft.rawReplies = rawReplies()
  draft.assertions = assertions()
  draft.results = results
  const value = finalizeCollectedDraft({
    ...draft,
    subject: draft.subject,
    identity: draft.identity,
    measuredAt: draft.measuredAt,
    origin: draft.origin,
  })
  return parseRun("fixture.json", JSON.stringify(value), ids, new Map([[suite.probeHash, suite]]))
}
const statusOf = (run: ReturnType<typeof current>) =>
  projectResults([run], ids, { currentProbeHash: suite.probeHash }, []).table[run.runId]!

describe("Windows console-host rule", () => {
  it("holds host-answered and host-silenced current verdicts and counts only passed-through replies", () => {
    const run = current("windows")
    const projection = projectResults([run], ids, { currentProbeHash: suite.probeHash }, [])
    // History holds every valid run before admission, which needs a Windows ownership receipt this rule ignores.
    const selected = projection.history["term:windows-terminal"]![0]!
    const byId = new Map(selected.results.map((result) => [result.featureId, result]))
    expect([0, 1, 2, 3, 4, 5].map((index) => byId.get(ids[index]!)?.status)).toEqual([
      "probe-todo",
      "supported",
      "probe-todo",
      "probe-todo",
      "probe-todo",
      "probe-invalid",
    ])
    expect(byId.get(ids[0]!)?.reason).toBe(HOST_ANSWERED)
    expect(byId.get(ids[2]!)?.reason).toBe(NO_REPLY)
    expect(byId.get(ids[3]!)?.reason).toBe(HOST_ANSWERED)
    expect(byId.get(ids[4]!)?.reason).toBe(HOST_ANSWERED)
    expect(selected.counts).toEqual({
      supported: 1,
      unsupported: 0,
      untestable: 0,
      "probe-todo": 271,
      "probe-invalid": 1,
      "probe-conflict": 0,
    })
    expect(projection.table[run.runId]?.[ids[0]!]).toBe("probe-todo")
    expect(classifyDevelopmentRun(run).states[ids[0]!]).toBe("probe-todo")
    // The writer retains the host prerequisite; readers use that recorded grade.
    expect(run.results?.find((result) => result.featureId === ids[0])?.status).toBe("probe-todo")
  })
  it("never touches a run outside Windows", () => {
    const states = statusOf(current("macos"))
    expect([0, 2, 3, 4].map((index) => states[ids[index]!])).toEqual([
      "supported",
      "unsupported",
      "supported",
      "supported",
    ])
  })
})
