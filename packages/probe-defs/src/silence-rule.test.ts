/**
 * @failure A fenced silence (DA1 answered, nothing before it) is graded by each callback on its own instead of once by
 *   the row's declared rule, so a row's text and its grade drift apart; or the default rule stops producing today's
 *   Unsupported result; or a multiplexer silence that may have stopped at the hop is turned into Unsupported.
 * @level l1
 * @consumer recordExecutedProbe, the one recorder both collectors call, fed sentinelNegativeResult's marked silence
 *   and the row's `silence` declaration from content/features.json (#33165, @cto be3fb080).
 * @testonly none
 */
import { describe, expect, test } from "vitest"
import { isFencedSilence, recordExecutedProbe, sentinelNegativeResult } from "./helpers.ts"
import { ALL_PROBES } from "./index.ts"
import type { Observation, ProbeAssertion, ProbeCallbackResult, SilenceDeclaration, TermProbeSource } from "./types.ts"

const featureId = "extensions.osc702-version"
const attempt = { scope: "probe", startedAt: "2026-11-10T22:00:00.000Z" } as const
const DA1 = "\x1b[?62;22c"
const NOTE = "DA1 answered at +3ms; no reply through the 250 ms window"

function fenced(): ProbeCallbackResult {
  const result = sentinelNegativeResult(DA1, { atMs: 3, graceMs: 250 }, "Complete OSC 702 version reply")
  if (!result) throw new Error("sentinelNegativeResult did not mark a DA1-only read as a fenced silence")
  return result
}

/** What a collector hands the recorder for a callback result. */
function record(result: ProbeCallbackResult, silence?: SilenceDeclaration) {
  if (!result.observation) throw new Error("callback result has no observation")
  const observation: Observation = { featureId, ...result.observation, rawReplyRef: featureId }
  const assertions: ProbeAssertion[] = (result.assertions ?? []).map((assertion) => ({
    featureId,
    ...assertion,
    rawReplyRef: featureId,
  }))
  return recordExecutedProbe({ featureId, attempt, observation, assertions, rawReplyRef: featureId, silence })
}

describe("a fenced silence is marked by the helper and graded once, by the row's rule", () => {
  test("the helper marks the silence and decides nothing", () => {
    const result = fenced()
    expect(result.observation).toEqual({
      outcome: "inconclusive",
      reason: "fenced-silence",
      assertionType: "query_reply",
      note: NOTE,
    })
    expect(isFencedSilence(result.observation)).toBe(true)
    expect(result.assertions).toEqual([
      { assertionType: "query_reply", kind: "negative", expected: "Complete OSC 702 version reply", observed: NOTE },
    ])
  })

  test("default (no silence field): Unsupported, byte-identical to the result the helper used to decide", () => {
    const marked = record(fenced())
    // Before #33165 the helper returned this observation itself; the recorded row must not change by one byte.
    const helper = fenced()
    const before = record({
      pass: false,
      response: helper.response,
      observation: { outcome: "unsupported", assertionType: "query_reply", note: NOTE },
      assertions: helper.assertions,
    })
    expect(marked).toStrictEqual(before)
    expect(marked).toMatchObject({
      status: "unsupported",
      reason: NOTE,
      assertionType: "query_reply",
      tests: [{ id: "criterion", status: "unsupported", assertionRefs: [0], reason: NOTE }],
    })
  })

  test("switchable: PROBE INVALID, with a reason naming what enables it", () => {
    const reason = "silence is open until a run with the allowWindowOps resource on"
    const recorded = record(fenced(), { rule: "switchable", reason })
    expect(recorded.status).toBe("probe-invalid")
    expect(recorded.reason).toBe(`${reason}; ${NOTE}`)
    expect(recorded.tests).toMatchObject([{ id: "criterion", status: "probe-invalid", reason: `${reason}; ${NOTE}` }])
  })

  test("the retired untestable silence rule reaches the existing invalid-declaration boundary", () => {
    // #33389: no catalog row uses this dormant producer; an old declaration must fail, never silently regrade.
    const retired = { rule: "untestable", reason: "silence cannot decide" } as unknown as SilenceDeclaration
    expect(() => record(fenced(), retired)).toThrow(/invalid silence rule/)
  })

  test("a reply still decides: the rule applies only to a marked fenced silence", () => {
    const reply: ProbeCallbackResult = {
      pass: true,
      response: "\x1b]702;1.0\x07",
      observation: { outcome: "supported", assertionType: "query_reply" },
      assertions: [{ assertionType: "query_reply", kind: "positive", expected: "reply", observed: "\x1b]702;1.0\x07" }],
    }
    const switchable = { rule: "switchable", reason: "silence is open until the resource is enabled" } as const
    expect(record(reply, switchable).status).toBe("supported")
    const timeout: ProbeCallbackResult = {
      pass: false,
      response: "x",
      observation: { outcome: "inconclusive", reason: "no-response", assertionType: "query_reply", note: "timeout" },
    }
    expect(record(timeout, { rule: "switchable", reason: "r" })).toStrictEqual(record(timeout))
  })

  test("an invalid declaration reaching the recorder is refused, never applied", () => {
    expect(() => record(fenced(), { rule: "switchable", reason: " " })).toThrow(/invalid silence rule/)
    expect(() => record(fenced(), { rule: "consumes", reason: "r" } as unknown as SilenceDeclaration)).toThrow(
      /invalid silence rule/,
    )
  })
})

// @cto 767c9bcd ruling 3: Kitty keyboard detection reads a DA1-only capture with its own parser; it marks the silence
// through the helper and the recorder grades it, recording exactly the Unsupported result the probe decided itself.
test("Kitty keyboard detection marks a DA1-only capture, and the default rule records the result it used to decide", async () => {
  const id = "extensions.kitty-keyboard.disambiguate"
  const kitty = ALL_PROBES.find((probe) => probe.id === id)?.term
  if (!kitty) throw new Error(`${id} has no term arm`)
  const result = await kitty({
    kind: "live",
    cols: 80,
    rows: 24,
    write() {},
    queryWithSentinelOutcome: async () => ({
      match: null,
      reason: "sentinel",
      raw: DA1,
      rawBase64: Buffer.from(DA1).toString("base64"),
      sentinel: { atMs: 2, graceMs: 250 },
    }),
  } as unknown as TermProbeSource)
  expect(isFencedSilence(result.observation)).toBe(true)
  const note =
    "DA1 answered without any Kitty keyboard flags reply; the protocol is not supported (necessary-condition negative; key-event conformance was not tested)"
  const assertion = {
    featureId: id,
    assertionType: "query_reply" as const,
    kind: "negative" as const,
    expected: "A complete Kitty keyboard flags reply answers before the DA1 reply",
    observed: DA1,
    rawReplyRef: id,
  }
  const recordAs = (observation: Omit<Observation, "featureId">) =>
    recordExecutedProbe({
      featureId: id,
      attempt,
      observation: { featureId: id, ...observation, rawReplyRef: id },
      assertions: [assertion],
      rawReplyRef: id,
    })
  const recorded = recordAs(result.observation!)
  // Before #33165's ruling 3 the probe returned this observation itself.
  const before = recordAs({ outcome: "unsupported", assertionType: "query_reply", note })
  expect(JSON.stringify(recorded)).toBe(JSON.stringify(before))
  expect(recorded).toMatchObject({ status: "unsupported", reason: note })
})

// Ruling 7 (@cto be3fb080): a multiplexer arm keeps its hop rule. A silence that may have stopped at the hop is never
// marked, so no row rule, the default included, turns it into Unsupported.
test("a multiplexer silence that may have stopped at the hop stays as it is today", async () => {
  const read = ALL_PROBES.find((probe) => probe.id === "extensions.osc52-read")?.term
  if (!read) throw new Error("extensions.osc52-read has no term arm")
  const ctx = {
    kind: "live",
    mux: "tmux",
    cols: 80,
    rows: 24,
    write() {},
    queryCursorPosition: async () => ({ row: 1, col: 1 }),
    measureRenderedWidth: async () => ({ kind: "no-reply", step: "sample" }) as const,
    query: async () => null,
    queryOutcome: async () => ({ match: null, reason: "timeout", raw: "", rawBase64: "" }),
    queryWithSentinel: async () => null,
    // The fenced shape: DA1 alone with its measured window, the shape the helper marks on a direct terminal.
    queryWithSentinelOutcome: async () => ({
      match: null,
      reason: "sentinel",
      raw: DA1,
      rawBase64: Buffer.from(DA1).toString("base64"),
      sentinel: { atMs: 3, graceMs: 250 },
    }),
    queryMode: async () => null,
    withClipboardFixture: async (work) =>
      work({
        baseline: "baseline",
        tmuxSetClipboard: "on",
        readText: async () => "baseline",
        writeText: async () => {},
      }),
  } as TermProbeSource
  const result = await read(ctx)
  expect(isFencedSilence(result.observation)).toBe(false)
  expect(result.observation).toMatchObject({ outcome: "inconclusive", reason: "no-response" })
  const recorded = recordExecutedProbe({
    featureId: "extensions.osc52-read",
    attempt,
    observation: { featureId: "extensions.osc52-read", ...result.observation! },
    assertions: [],
  })
  expect(recorded.status).toBe("probe-invalid")
  expect(recorded.reason).toMatch(/set-clipboard=on; default set-clipboard=external required for negative grade/)
})
