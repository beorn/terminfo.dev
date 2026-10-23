/**
 * @failure A Windows console host's own answer, or its silence, is published as the terminal's verdict.
 * @level l2
 * @consumer Current result selector, historical selector, API v3 and site build
 * @testonly none
 */
import { describe, expect, it } from "vitest"
import { parseRun } from "@terminfo/run-parser"
import type { CapabilityResult, ProbeSuiteManifest } from "@terminfo/probe-defs"
import { classifyDevelopmentRun, projectResults } from "../docs/data/selected-results.ts"

// #30720 (@cto rulings fc63f412, 1ee8cf0b, f126327b): no other test reads a Windows run, so none sees the
// reader count conhost's DA1-ordered answers as the terminal's.
const ids = Array.from({ length: 273 }, (_, index) => `capability.${index}`)
const suite: ProbeSuiteManifest = {
  probeHash: "windows-console-host",
  sourceRevision: "1".repeat(40),
  generatedAt: "2026-10-22T05:00:00.000Z",
  adapterVersion: "3.3.2",
  catalogIds: ids,
  probes: { app: ids, headless: [], mux: [] },
}
const attempt = { scope: "probe" as const, startedAt: "2026-10-22T05:00:00.000Z" }
const HOST_DA1 = "\u001b[?61;6;7;14;21;22;23;24;28;32;42c"
const HOST_ANSWERED = "answered by the Windows console host OpenConsole.exe, not measured on the terminal"
const NO_REPLY = "no reply after the console host's DA1; the host may have swallowed the query"
/** Each decided cell: its id, status, evidence, and the stored reply its verdict rests on. */
const decided: Array<[string, "supported" | "unsupported" | "test-failure", "query" | "behavior", string]> = [
  // The host answers DECRQM itself, before its DA1.
  [ids[0]!, "supported", "query", exchange("\u001b[?2026$p\u001b[c", `\u001b[?2026;2$y${HOST_DA1}`)],
  // XTWINOPS 14 passes through: the terminal's reply follows the host's DA1.
  [ids[1]!, "supported", "query", exchange("\u001b[14t\u001b[c", `${HOST_DA1}\u001b[4;595;800t`)],
  // Nothing after the host's DA1: silence under the host proves nothing.
  [ids[2]!, "unsupported", "query", exchange("\u001b]10;?\u0007\u001b[c", HOST_DA1)],
  // The cursor report carries no sentinel; the host answers it.
  [ids[3]!, "supported", "behavior", exchange("\u001b[6n", "\u001b[1;5R")],
  // A plain reply string carries no sentinel: the host's DA, held like any unsentinelled reply.
  [ids[4]!, "supported", "query", HOST_DA1],
  // A failed attempt stays visible as a failure: it is a repair item, not a capability claim.
  [ids[5]!, "test-failure", "query", exchange("\u001b[?u\u001b[c", `\u001b[?0u${HOST_DA1}`)],
]
function exchange(sequence: string, raw: string): string {
  return JSON.stringify({ writes: [], queries: [{ sequence, raw }] })
}
const target = (os: string) => ({
  kind: "app",
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
    kind: status === "unsupported" ? "negative" : "positive",
    rawReplyRef: featureId,
    expected: "reply",
    observed: "reply",
  }))
const common = (os: string) => ({
  runId: `windows-${os}`,
  target: target(os),
  intendedContext: { kind: "app", id: "windows-terminal" },
  identity: "verified",
  suiteId: suite.probeHash,
  probeHash: suite.probeHash,
  sourceRevision: suite.sourceRevision,
  measuredAt: "2026-10-22T05:00:00.000Z",
  origin: { kind: "collector" },
  screenshotRefs: [],
})
const current = (os: string) => {
  const results: CapabilityResult[] = ids.map((featureId) => ({
    featureId,
    status: "test-todo",
    attempt: { scope: "none" },
    checks: [],
    reason: "No implementation",
  }))
  decided.forEach(([featureId, status, evidence], index) => {
    results[ids.indexOf(featureId)] =
      status === "test-failure"
        ? {
            featureId,
            status,
            evidence,
            rawReplyRef: featureId,
            attempt,
            checks: [{ id: "collection", status, attempt, reason: "callback threw" }],
            reason: "callback threw",
          }
        : {
            featureId,
            status,
            evidence,
            rawReplyRef: featureId,
            attempt,
            checks: [{ id: "criterion", status, attempt, assertionRefs: [index], rawReplyRef: featureId }],
          }
  })
  const value = {
    ...common(os),
    schemaVersion: 3,
    sealedAt: "2026-10-22T05:00:01.000Z",
    rawReplies: rawReplies(),
    assertions: assertions(),
    results,
  }
  return parseRun("fixture.json", JSON.stringify(value), ids, new Map([[suite.probeHash, suite]]))
}
const historical = () => {
  const value = {
    ...common("windows"),
    schemaVersion: 2,
    suiteComplete: false,
    rawReplies: rawReplies(),
    assertions: assertions(),
    observations: decided.map(([featureId, status, evidence]) => ({
      featureId,
      outcome: status === "test-failure" ? "error" : status,
      evidence,
      rawReplyRef: featureId,
      ...(status === "test-failure" && { reason: "collector-error" }),
    })),
  }
  return parseRun("fixture.json", JSON.stringify(value), ids, new Map([[suite.probeHash, suite]]))
}
const statusOf = (run: ReturnType<typeof current>) =>
  projectResults([run], [], ids, { currentProbeHash: suite.probeHash }).table[run.runId]!

describe("Windows console-host rule", () => {
  it("holds host-answered and host-silenced current verdicts and counts only passed-through replies", () => {
    const run = current("windows")
    const projection = projectResults([run], [], ids, { currentProbeHash: suite.probeHash })
    // History holds every valid run before admission, which needs a Windows ownership receipt this rule ignores.
    const selected = projection.history["app:windows-terminal"]![0]!
    const byId = new Map(selected.results.map((result) => [result.featureId, result]))
    expect([0, 1, 2, 3, 4, 5].map((index) => byId.get(ids[index]!)?.status)).toEqual([
      "test-todo",
      "supported",
      "test-todo",
      "test-todo",
      "test-todo",
      "test-failure",
    ])
    expect(byId.get(ids[0]!)?.reason).toBe(HOST_ANSWERED)
    expect(byId.get(ids[2]!)?.reason).toBe(NO_REPLY)
    expect(byId.get(ids[3]!)?.reason).toBe(HOST_ANSWERED)
    expect(byId.get(ids[4]!)?.reason).toBe(HOST_ANSWERED)
    expect(selected.counts).toEqual({
      supported: 1,
      unsupported: 0,
      untestable: 0,
      "test-todo": 271,
      "test-failure": 1,
    })
    expect(projection.table[run.runId]?.[ids[0]!]).toBe("test-todo")
    expect(classifyDevelopmentRun(run).states[ids[0]!]).toBe("test-todo")
    // The raw run keeps the collector's sealed verdict; only the reader holds it.
    expect(run.results?.find((result) => result.featureId === ids[0])?.status).toBe("supported")
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
