import { describe, expect, test } from "vitest"
import { deviceProbes } from "./device.ts"
import { recordExecutedProbe } from "./helpers.ts"
import type { TermProbeSource, LibProbeSource, TerminalQueryOutcome } from "./types.ts"

const replies = [
  { id: "device.primary-da", query: "\x1b[c", valid: "\x1b[?62;52;c", partial: "\x1b[?62;52;" },
  { id: "device.status-report", query: "\x1b[5n", valid: "\x1b[0n", partial: "\x1b[4n" },
  { id: "device.secondary-da", query: "\x1b[>c", valid: "\x1b[>0;49;1c", partial: "\x1b[>0;;1c" },
  { id: "device.tertiary-da", query: "\x1b[=c", valid: "\x1bP!|1234ABCD\x1b\\", partial: "\x1bP!|1234ABCD" },
  { id: "device.decrqss", query: "\x1bP$qm\x1b\\", valid: "\x1bP1$r0m\x1b\\", partial: "\x1bP1$r" },
  {
    id: "device.xtgettcap",
    query: "\x1bP+q544e\x1b\\",
    valid: "\x1bP1+r544e=787465726d\x1b\\",
    partial: "\x1bP1+r544e=787",
  },
  { id: "device.decrpm", query: "\x1b[?7$p", valid: "\x1b[?7;1$y", partial: "\x1b[?1;1$y" },
  { id: "device.xtversion", query: "\x1b[>0q", valid: "\x1bP>|kitty(0.49.1)\x1b\\", partial: "\x1bP>|kitty(0.49.1)" },
] as const

function headless(raw: string): LibProbeSource {
  // Device query callbacks use only feedCapture; missing operations fail loudly if newly used.
  return { feedCapture: () => raw } as unknown as LibProbeSource
}

function terminal(
  raw: string,
  reason: TerminalQueryOutcome["reason"] = "reply",
  sentinel?: { atMs: number; graceMs: number },
): TermProbeSource {
  const reply = (sequence: string, pattern: RegExp): Promise<TerminalQueryOutcome> => {
    const item = replies.find((candidate) => candidate.query === sequence)
    if (!item) throw new Error(`unexpected query ${JSON.stringify(sequence)}`)
    // A reply the collector matched is a reply; the reason alone decides the rest. `sentinel` is the
    // measured ordering the live collector records when DA1 answered before this query's reply.
    const match = reason === "reply" ? pattern.exec(raw) : null
    return Promise.resolve({
      match,
      reason,
      raw,
      rawBase64: Buffer.from(raw).toString("base64"),
      ...(sentinel && { sentinel }),
    })
  }
  return {
    queryOutcome: reply,
    queryWithSentinelOutcome: reply,
  } as unknown as TermProbeSource
}

function callback(id: string) {
  const definition = deviceProbes.find((item) => item.id === id)
  if (!definition?.lib || !definition.term) throw new Error(`missing device callback ${id}`)
  return { headless: definition.lib, terminal: definition.term }
}

/**
 * @failure A title-stack checkpoint leaks into later probes after the app callback returns or its query rejects.
 * @level l1
 * @consumer Application device observations sharing one owned terminal.
 * @testonly none
 */
test.each([false, true])("title push restores its checkpoint when CPR rejects=%s", async (rejectQuery) => {
  const writes: string[] = []
  const context = {
    write: (bytes: string) => writes.push(bytes),
    queryCursorPosition: async () => {
      if (rejectQuery) throw new Error("injected title CPR failure")
      return { row: 1, col: 1 }
    },
  } as unknown as TermProbeSource

  const result = callback("device.xtwinops-22").terminal(context)
  if (rejectQuery) {
    await expect(result).rejects.toThrow("injected title CPR failure")
  } else {
    const callbackResult = await result
    expect(callbackResult.observation).toBeUndefined()
    expect(callbackResult.tests).toMatchObject([
      expect.objectContaining({ status: "test-todo", reason: expect.any(String) }),
    ])
  }
  expect(writes.filter((bytes) => bytes === "\x1b[22;0t")).toHaveLength(1)
  expect(writes.filter((bytes) => bytes === "\x1b[23;0t")).toHaveLength(1)
  expect(writes.at(-1)).toBe("\x1b[23;0t")
})

const DECRQSS_SGR_QUERY = "\x1bP$qm\x1b\\"
const DECRQSS_DECSTBM_QUERY = "\x1bP$qr\x1b\\"
const DECRQSS_DECSCL_QUERY = '\x1bP$q"p\x1b\\'
const DECRQSS_SGR_VALID = "\x1bP1$r0m\x1b\\"
const DECRQSS_REFUSAL = "\x1bP0$r\x1b\\"
const DECRQSS_DECSTBM_VALID = "\x1bP1$r1;24r\x1b\\"
const DECRQSS_DECSCL_VALID = '\x1bP1$r62;1"p\x1b\\'
const DA1 = "\x1b[?62;52;c"

function terminalScript(
  replies: Record<
    string,
    { raw: string; reason: TerminalQueryOutcome["reason"]; sentinel?: { atMs: number; graceMs: number } }
  >,
): { ctx: TermProbeSource; lib: LibProbeSource; queries: string[] } {
  const queries: string[] = []
  const read = (sequence: string, pattern: RegExp): TerminalQueryOutcome => {
    queries.push(sequence)
    const item = replies[sequence]
    if (!item) throw new Error(`unexpected query ${JSON.stringify(sequence)}`)
    const match = item.reason === "reply" ? pattern.exec(item.raw) : null
    return {
      match,
      reason: item.reason,
      raw: item.raw,
      rawBase64: Buffer.from(item.raw).toString("base64"),
      ...(item.sentinel && { sentinel: item.sentinel }),
    }
  }
  const ctx = {
    queryWithSentinelOutcome: async (sequence: string, pattern: RegExp) => read(sequence, pattern),
  } as unknown as TermProbeSource
  const lib = { queryWithSentinelOutcome: read } as unknown as LibProbeSource
  return { ctx, lib, queries }
}

/**
 * @failure Arbitrary output, partial frames, and sentinel replies were promoted to supported device protocols.
 * @level l0
 * @consumer Unified headless and application device-query observations.
 * @testonly none
 */
describe("device query observations", () => {
  for (const item of replies) {
    test(`${item.id}: complete frame supports; unrelated and partial replies do not`, async () => {
      const probe = callback(item.id)
      for (const result of [probe.headless(headless(item.valid)), await probe.terminal(terminal(item.valid))]) {
        expect(result.observation).toMatchObject({ outcome: "supported", assertionType: "query_reply" })
        expect(result.response).toBe(item.valid)
        expect(result.assertions).toMatchObject([{ kind: "positive", observed: item.valid }])
      }
      const unrelated = "\x1b[12;20R"
      for (const result of [
        probe.headless(headless(unrelated)),
        await probe.terminal(terminal(unrelated, "sentinel")),
      ]) {
        expect(result.observation).toMatchObject({ outcome: "inconclusive", reason: "no-response" })
        expect(result.assertions).toBeUndefined()
      }
      for (const result of [
        probe.headless(headless(item.partial)),
        await probe.terminal(terminal(item.partial, "sentinel")),
      ]) {
        expect(result.observation).toMatchObject({ outcome: "inconclusive", reason: "invalid-reply" })
        expect(result.assertions).toBeUndefined()
      }
    })
  }

  test("a reply after the DA1 sentinel grades by the reply and is marked late", async () => {
    const da1 = "\x1b[?62;52;c"
    const measured = { atMs: 12, graceMs: 250 }
    for (const item of replies.filter((candidate) => candidate.id !== "device.primary-da")) {
      const lateRaw = da1 + item.valid
      const late = await callback(item.id).terminal(terminal(lateRaw, "reply", measured))
      expect(late.response, item.id).toBe(lateRaw)
      expect(late.observation, item.id).toMatchObject({
        outcome: "supported",
        assertionType: "query_reply",
        note: "reply after sentinel",
      })
      expect(late.assertions, item.id).toMatchObject([{ kind: "positive", observed: item.valid }])

      const earlyRaw = item.valid + da1
      const early = await callback(item.id).terminal(terminal(earlyRaw))
      expect(early.response, item.id).toBe(earlyRaw)
      expect(early.observation, item.id).toMatchObject({ outcome: "supported", assertionType: "query_reply" })
      expect(early.observation?.note, item.id).toBeUndefined()
      expect(early.assertions, item.id).toMatchObject([{ kind: "positive", observed: item.valid }])
    }
  })

  test("DA1 answered alone through the window is a measured negative, not an unknown", async () => {
    const da1 = "\x1b[?62;52;c"
    for (const item of replies.filter((candidate) => candidate.id !== "device.primary-da")) {
      const result = await callback(item.id).terminal(terminal(da1, "sentinel", { atMs: 9, graceMs: 250 }))
      expect(result.response, item.id).toBe(da1)
      expect(result.observation, item.id).toMatchObject({
        outcome: "unsupported",
        assertionType: "query_reply",
        note: "negative by sentinel",
      })
      expect(result.assertions, item.id).toMatchObject([
        { kind: "negative", observed: "DA1 answered at +9ms; no reply through the 250 ms window" },
      ])
      // The negative names the feature's own reply contract, not a generic silence.
      expect(result.assertions?.[0]?.expected, item.id).toBeTruthy()
    }
  })

  test("without the measured ordering a frame after DA1 stays unreadable and silence stays unknown", async () => {
    const da1 = "\x1b[?62;52;c"
    for (const item of replies.filter((candidate) => candidate.id !== "device.primary-da")) {
      const lateRaw = da1 + item.valid
      const late = await callback(item.id).terminal(terminal(lateRaw, "sentinel"))
      expect(late.observation, item.id).toMatchObject({ outcome: "inconclusive", reason: "no-response" })
      expect(late.assertions, item.id).toBeUndefined()

      const silent = await callback(item.id).terminal(terminal(da1, "sentinel"))
      expect(silent.observation, item.id).toMatchObject({ outcome: "inconclusive", reason: "no-response" })
      expect(silent.assertions, item.id).toBeUndefined()
    }
  })

  // #30559 (@cto 86260f80 rules 1 and 3): the sentinel's answer is the LAST DA1-shaped answer, and every byte before
  // it is the query's reply. Terminal.app answers DA3 with a DA1-shaped reply, which is bytes, never silence.
  test("a DA1-shaped reply ahead of the DA1 answer is no measured negative", async () => {
    const da1 = "\x1b[?62;52;c"
    for (const item of replies.filter((candidate) => candidate.id !== "device.primary-da")) {
      const result = await callback(item.id).terminal(terminal(da1 + da1, "sentinel", { atMs: 9, graceMs: 250 }))
      expect(result.observation, item.id).toStrictEqual({
        outcome: "inconclusive",
        reason: "no-response",
        assertionType: "query_reply",
      })
      expect(result.assertions, item.id).toBeUndefined()
    }
  })

  test("a frame between a DA1-shaped reply and the DA1 answer arrived on time and grades by the frame", async () => {
    const da1 = "\x1b[?62;52;c"
    for (const item of replies.filter((candidate) => candidate.id !== "device.primary-da")) {
      const raw = da1 + item.valid + da1
      const result = await callback(item.id).terminal(terminal(raw))
      expect(result.response, item.id).toBe(raw)
      expect(result.observation, item.id).toMatchObject({ outcome: "supported", assertionType: "query_reply" })
      expect(result.observation?.note, item.id).toBeUndefined()
      expect(result.assertions, item.id).toMatchObject([{ kind: "positive", observed: item.valid }])
    }
  })

  test("DA1 sentinel and one refused setting cannot establish facility support, late or early", async () => {
    const sentinel = "\x1b[?62;52;c"
    const measured = { atMs: 12, graceMs: 250 }
    for (const [id, refusal] of [
      ["device.xtgettcap", "\x1bP0+r\x1b\\"],
      ["device.decrpm", "\x1b[?7;0$y"],
    ] as const) {
      const lateRaw = sentinel + refusal
      const late = await callback(id).terminal(terminal(lateRaw, "reply", measured))
      expect(late.response, id).toBe(lateRaw)
      expect(late.observation, id).toMatchObject({
        outcome: "inconclusive",
        reason: "insufficient-evidence",
        assertionType: "query_reply",
        note: "Requested setting or name refused; other settings or names unmeasured; reply after sentinel",
      })
      expect(late.assertions, id).toBeUndefined()

      const unmeasuredLate = await callback(id).terminal(terminal(lateRaw, "sentinel"))
      expect(unmeasuredLate.observation, id).toMatchObject({ outcome: "inconclusive", reason: "no-response" })

      const earlyRaw = refusal + sentinel
      const early = await callback(id).terminal(terminal(earlyRaw))
      expect(early.response, id).toBe(earlyRaw)
      expect(early.observation, id).toMatchObject({
        outcome: "inconclusive",
        reason: "insufficient-evidence",
        assertionType: "query_reply",
      })
      expect(early.assertions, id).toBeUndefined()
    }
  })

  test("the first combined refusal or valid frame determines the DECRPM result", async () => {
    const refusal = "\x1b[?7;0$y"
    const valid = "\x1b[?7;1$y"
    const probe = callback("device.decrpm")
    for (const result of [probe.headless(headless(refusal + valid)), await probe.terminal(terminal(refusal + valid))]) {
      expect(result.response).toBe(refusal + valid)
      expect(result.observation).toMatchObject({
        outcome: "inconclusive",
        reason: "insufficient-evidence",
        assertionType: "query_reply",
      })
      expect(result.assertions).toBeUndefined()
    }
    for (const result of [probe.headless(headless(valid + refusal)), await probe.terminal(terminal(valid + refusal))]) {
      expect(result.response).toBe(valid + refusal)
      expect(result.observation).toMatchObject({ outcome: "supported", assertionType: "query_reply" })
      expect(result.assertions).toMatchObject([{ kind: "positive", observed: valid }])
    }
  })

  test("silence is inconclusive and a TTY deadline remains a timeout", async () => {
    for (const item of replies) {
      const probe = callback(item.id)
      const missing = probe.headless(headless(""))
      expect(missing.observation).toBeUndefined()
      expect(missing.tests).toMatchObject([
        expect.objectContaining({ status: "test-failure", reason: expect.any(String) }),
      ])
      const timedOut = await probe.terminal(terminal("", "timeout"))
      expect(timedOut.observation).toBeUndefined()
      expect(timedOut.tests).toMatchObject([
        expect.objectContaining({ status: "test-failure", reason: expect.any(String) }),
      ])
    }
  })

  test("DA1 uses a direct query and a valid frame stays bound to raw output containing unrelated bytes", async () => {
    const primary = callback("device.primary-da")
    const raw = "\x1b[12;20R\x1b[?1;2c"
    const result = await primary.terminal({
      queryOutcome: (_sequence: string, pattern: RegExp) =>
        Promise.resolve({
          match: pattern.exec(raw),
          reason: "reply",
          raw,
          rawBase64: Buffer.from(raw).toString("base64"),
        }),
      queryWithSentinelOutcome: () => {
        throw new Error("DA1 must not use a DA1 sentinel")
      },
    } as unknown as TermProbeSource)
    expect(result.observation).toMatchObject({ outcome: "supported", assertionType: "query_reply" })
    expect(result.response).toBe(raw)
    expect(result.assertions).toMatchObject([{ kind: "positive", observed: "\x1b[?1;2c" }])
  })

  test("complete single-setting refusals are inconclusive; malfunction is still a DSR report", async () => {
    const sgrRefusal = "\x1bP0$r\x1b\\"
    expect(callback("device.decrqss").headless(headless(sgrRefusal)).observation).toMatchObject({
      outcome: "inconclusive",
      reason: "insufficient-evidence",
      assertionType: "query_reply",
      note: "Requested setting or name refused; other settings or names unmeasured",
    })
    for (const [id, frame] of [
      ["device.xtgettcap", "\x1bP0+r\x1b\\"],
      ["device.decrpm", "\x1b[?7;0$y"],
    ] as const) {
      const probe = callback(id)
      for (const result of [probe.headless(headless(frame)), await probe.terminal(terminal(frame))]) {
        expect(result.observation).toMatchObject({
          outcome: "inconclusive",
          reason: "insufficient-evidence",
          assertionType: "query_reply",
          note: "Requested setting or name refused; other settings or names unmeasured",
        })
        expect(result.assertions).toBeUndefined()
        expect(result.response).toBe(frame)
      }
    }
    const status = callback("device.status-report")
    const malfunction = status.headless(headless("\x1b[3n"))
    expect(malfunction.observation).toMatchObject({ outcome: "supported", note: "Terminal reports malfunction" })
    expect(malfunction.assertions).toMatchObject([{ kind: "positive", observed: "\x1b[3n" }])
  })

  test("SGR status-0 then a complete DECSTBM Pt;Pb r frame supports the DECRQSS facility", async () => {
    const script = terminalScript({
      [DECRQSS_SGR_QUERY]: { raw: DECRQSS_REFUSAL, reason: "reply" },
      [DECRQSS_DECSTBM_QUERY]: { raw: DECRQSS_DECSTBM_VALID, reason: "reply" },
    })
    const result = await callback("device.decrqss").terminal(script.ctx)
    expect(script.queries).toEqual([DECRQSS_SGR_QUERY, DECRQSS_DECSTBM_QUERY])
    expect(result.observation).toMatchObject({ outcome: "supported", assertionType: "query_reply" })
    expect(result.assertions).toMatchObject([{ kind: "positive", observed: DECRQSS_DECSTBM_VALID }])
  })

  // Two selector refusals establish a speaking facility, not a facility-wide negative. The old
  // two-selector case never exercised Vterm's real DECSCL reply or silence after both refusals.
  test.each(
    [
      { name: "valid DECSCL", raw: DECRQSS_DECSCL_VALID, reason: "reply" as const, supported: true },
      { name: "DECSCL refusal", raw: DECRQSS_REFUSAL, reason: "reply" as const, supported: false },
      { name: "DECSCL silence", raw: DA1, reason: "sentinel" as const, supported: false },
    ].flatMap((third) => (["headless", "terminal"] as const).map((route) => ({ ...third, route }))),
  )("$route: SGR and DECSTBM refusals then $name retains facility evidence", async (third) => {
    const route = third.route
    const script = terminalScript({
      [DECRQSS_SGR_QUERY]: { raw: DECRQSS_REFUSAL, reason: "reply" },
      [DECRQSS_DECSTBM_QUERY]: { raw: DECRQSS_REFUSAL, reason: "reply" },
      [DECRQSS_DECSCL_QUERY]: {
        raw: third.raw,
        reason: third.reason,
        ...(third.reason === "sentinel" && { sentinel: { atMs: 9, graceMs: 250 } }),
      },
    })
    const probe = callback("device.decrqss")
    const result = route === "headless" ? probe.headless(script.lib) : await probe.terminal(script.ctx)
    expect(result.observation).toMatchObject({
      outcome: third.supported ? "supported" : "inconclusive",
      assertionType: "query_reply",
    })
    expect(result.observation?.note).toMatch(/SGR refused/)
    expect(result.observation?.note).toMatch(/DECSTBM refused/)
    if (third.supported) {
      expect(result.assertions).toMatchObject([{ kind: "positive", observed: DECRQSS_DECSCL_VALID }])
      expect(result.response?.split(DECRQSS_REFUSAL).length).toBe(3)
      expect(result.response).toContain(DECRQSS_DECSCL_VALID)
    } else {
      expect(result.observation?.note).toMatch(/DECSCL/)
      expect(result.assertions).toBeUndefined()
    }
    expect(script.queries).toEqual([DECRQSS_SGR_QUERY, DECRQSS_DECSTBM_QUERY, DECRQSS_DECSCL_QUERY])
  })

  test("SGR status-0 then DECSTBM unanswered (DA1 only) stays inconclusive, not F1 negative", async () => {
    const script = terminalScript({
      [DECRQSS_SGR_QUERY]: { raw: DECRQSS_REFUSAL, reason: "reply" },
      [DECRQSS_DECSTBM_QUERY]: {
        raw: DA1,
        reason: "sentinel",
        sentinel: { atMs: 9, graceMs: 250 },
      },
    })
    const result = await callback("device.decrqss").terminal(script.ctx)
    expect(script.queries).toEqual([DECRQSS_SGR_QUERY, DECRQSS_DECSTBM_QUERY])
    expect(result.observation).toMatchObject({
      outcome: "inconclusive",
      reason: "insufficient-evidence",
      assertionType: "query_reply",
    })
    expect(result.observation?.note).not.toBe("negative by sentinel")
    expect(result.assertions).toBeUndefined()

    // Unlike DA1-only, the empty second read retains no reply. The library collector keeps only
    // this callback response, so the first SGR refusal cannot become a synthetic deciding reply.
    const emptyScript = terminalScript({
      [DECRQSS_SGR_QUERY]: { raw: DECRQSS_REFUSAL, reason: "reply" },
      [DECRQSS_DECSTBM_QUERY]: { raw: "", reason: "timeout" },
    })
    const libraryQueries: string[] = []
    const library = {
      queryWithSentinelOutcome(sequence: string, pattern: RegExp): TerminalQueryOutcome {
        libraryQueries.push(sequence)
        const raw = sequence === DECRQSS_SGR_QUERY ? DECRQSS_REFUSAL : ""
        return { match: pattern.exec(raw), reason: raw ? "reply" : "timeout", raw, rawBase64: btoa(raw) }
      },
    } as unknown as LibProbeSource
    for (const empty of [
      await callback("device.decrqss").terminal(emptyScript.ctx),
      callback("device.decrqss").headless(library),
    ]) {
      expect(empty.response).toBe("")
      expect(empty.observation).toBeUndefined()
      expect(empty.assertions).toBeUndefined()
      const recorded = recordExecutedProbe({
        featureId: "device.decrqss",
        attempt: { scope: "probe", startedAt: "2026-10-21T05:00:00.000Z" },
        rawReplyRef: "device.decrqss",
        assertions: [],
        tests: empty.tests,
      })
      expect(recorded.status).toBe("test-failure")
      expect(recorded.assertionType).toBeUndefined()
      expect(recorded.reason).toBe("SGR refused; DECSTBM unanswered; DECRQSS facility still speaks")
    }
    expect(emptyScript.queries).toEqual([DECRQSS_SGR_QUERY, DECRQSS_DECSTBM_QUERY])
    expect(libraryQueries).toEqual([DECRQSS_SGR_QUERY, DECRQSS_DECSTBM_QUERY])
  })

  test("SGR status 1 keeps today's grade and never asks DECSTBM", async () => {
    const script = terminalScript({
      [DECRQSS_SGR_QUERY]: { raw: DECRQSS_SGR_VALID, reason: "reply" },
    })
    const result = await callback("device.decrqss").terminal(script.ctx)
    expect(script.queries).toEqual([DECRQSS_SGR_QUERY])
    expect(result.observation).toMatchObject({ outcome: "supported", assertionType: "query_reply" })
    expect(result.assertions).toMatchObject([{ kind: "positive", observed: DECRQSS_SGR_VALID }])
  })

  test("no SGR reply keeps today's F1 negative and never asks DECSTBM", async () => {
    const script = terminalScript({
      [DECRQSS_SGR_QUERY]: {
        raw: DA1,
        reason: "sentinel",
        sentinel: { atMs: 9, graceMs: 250 },
      },
    })
    const result = await callback("device.decrqss").terminal(script.ctx)
    expect(script.queries).toEqual([DECRQSS_SGR_QUERY])
    expect(result.observation).toMatchObject({
      outcome: "unsupported",
      assertionType: "query_reply",
      note: "negative by sentinel",
    })
  })

  test("the exact requested mode/name and a complete ST matter", () => {
    for (const [id, frame] of [
      ["device.decrpm", "\x1b[?1;1$y"],
      ["device.xtgettcap", "\x1bP1+r5267=78\x1b\\"],
      ["device.decrqss", '\x1bP1$r61;1"p\x1b\\'],
      ["device.xtversion", "\x1bP>|kitty(0.49.1)"],
      ["device.decrqss", '\x1bP0$r61;1"p\x1b\\'],
      ["device.xtgettcap", "\x1bP0+r544e\x1b\\"],
    ] as const) {
      expect(callback(id).headless(headless(frame)).observation).toMatchObject({
        outcome: "inconclusive",
        reason: "invalid-reply",
      })
    }
  })

  test("hexadecimal TN echo is case insensitive in both collectors", async () => {
    const frame = "\x1bP1+r544E=787465726D\x1b\\"
    const probe = callback("device.xtgettcap")
    expect(probe.headless(headless(frame)).observation).toMatchObject({ outcome: "supported" })
    expect((await probe.terminal(terminal(frame))).observation).toMatchObject({ outcome: "supported" })
  })

  test("an inherited TERM_FEATURES value is an unverified hint and is never copied into raw evidence", async () => {
    const prior = process.env.TERM_FEATURES
    try {
      process.env.TERM_FEATURES = "sensitive-arbitrary-environment-value"
      const definition = deviceProbes.find((item) => item.id === "device.term-features")
      if (!definition?.term) throw new Error("missing TERM_FEATURES callback")
      const result = await definition.term(terminal(""))
      expect(result.observation).toBeUndefined()
      expect(
        recordExecutedProbe({
          featureId: definition.id,
          attempt: { scope: "probe", startedAt: "2026-10-21T05:00:00.000Z" },
          assertions: [],
          tests: result.tests,
        }).status,
      ).toBe("test-failure")
      expect(JSON.stringify(result)).not.toContain(process.env.TERM_FEATURES)
      expect(result.assertions).toBeUndefined()
    } finally {
      if (prior === undefined) delete process.env.TERM_FEATURES
      else process.env.TERM_FEATURES = prior
    }
  })
})

/**
 * @failure Window operations accepted incomplete replies and later DA1 responsiveness as feature support.
 * @level l0
 * @consumer App and headless window-operation observations.
 * @testonly none
 */
describe("window-operation qualification", () => {
  test("XTWINOPS 14 queries text-area pixels and binds a complete size frame in both collectors", async () => {
    const probe = callback("device.xtwinops-14")
    const frame = "\x1b[4;720;1280t"
    const app = {
      queryWithSentinelOutcome: async (query: string, pattern: RegExp) => {
        expect(query).toBe("\x1b[14t")
        return {
          match: pattern.exec(frame),
          reason: "reply",
          raw: frame,
          rawBase64: Buffer.from(frame).toString("base64"),
        }
      },
    } as unknown as TermProbeSource
    const lib = {
      feedCapture: (query: string) => {
        expect(query).toBe("\x1b[14t")
        return frame
      },
    } as unknown as LibProbeSource
    for (const result of [probe.headless(lib), await probe.terminal(app)]) {
      expect(result.observation).toMatchObject({ outcome: "supported", assertionType: "query_reply" })
      expect(result.assertions).toMatchObject([{ kind: "positive", observed: frame }])
      expect(result.response).toBe(frame)
    }
    expect(probe.headless(headless("\x1b[4;720;1280")).observation).toMatchObject({
      outcome: "inconclusive",
      reason: "invalid-reply",
    })
  })

  test("device.xtwinops-20: a complete OSC L answer with the wrong payload is a measured negative", async () => {
    const icon = callback("device.xtwinops-20")
    const headlessIcon = (frame: string): LibProbeSource =>
      ({ feed: () => undefined, feedCapture: () => frame }) as unknown as LibProbeSource
    const app = (frame: string, reason: TerminalQueryOutcome["reason"] = "reply"): TermProbeSource =>
      ({
        write: () => undefined,
        queryWithSentinelOutcome: (sequence: string, pattern: RegExp) =>
          Promise.resolve({
            match: reason === "reply" ? pattern.exec(frame) : null,
            reason,
            raw: frame,
            rawBase64: Buffer.from(frame).toString("base64"),
          }),
      }) as unknown as TermProbeSource
    for (const frame of ["\x1b]L\x1b\\", "\x1b]Lother-icon\x07", "\x1b]Ltest-icon-plus\x1b\\"]) {
      const head = icon.headless(headlessIcon(frame))
      expect(head.observation).toMatchObject({ outcome: "unsupported", assertionType: "query_reply" })
      expect(head.assertions).toMatchObject([{ kind: "negative", observed: frame }])
      const live = await icon.terminal(app(frame))
      expect(live.observation).toMatchObject({ outcome: "unsupported", assertionType: "query_reply" })
      expect(live.assertions).toMatchObject([{ kind: "negative", observed: frame }])
    }
    // A frame with no terminator is still not a complete answer.
    expect(icon.headless(headlessIcon("\x1b]L")).observation).toMatchObject({
      outcome: "inconclusive",
      reason: "invalid-reply",
    })
    // The exact label stays a positive.
    expect(icon.headless(headlessIcon("\x1b]Ltest-icon\x1b\\")).observation).toMatchObject({
      outcome: "supported",
      assertionType: "query_reply",
    })
    // A complete OSC L frame after the DA1 sentinel is late output, not an answer.
    const late = "\x1b[?62;52;c\x1b]Lwrong\x1b\\"
    expect(icon.headless(headlessIcon(late)).observation).toMatchObject({
      outcome: "inconclusive",
      reason: "no-response",
    })
    expect((await icon.terminal(app(late, "sentinel"))).observation).toMatchObject({
      outcome: "inconclusive",
      reason: "no-response",
    })
    // Unrelated OSC answers (colour, clipboard) never satisfy the icon-label query.
    for (const frame of ["\x1b]4;1;rgb:00/00/00\x07", "\x1b]52;c;Zm9v\x07"]) {
      expect(icon.headless(headlessIcon(frame)).observation).toMatchObject({
        outcome: "inconclusive",
        reason: "no-response",
      })
      expect((await icon.terminal(app(frame))).observation).toMatchObject({
        outcome: "inconclusive",
        reason: "no-response",
      })
    }
  })

  test("a different icon label and DA1 fallback cannot prove XTWINOPS", () => {
    const icon = callback("device.xtwinops-20")
    const headlessIcon = {
      feed: () => undefined,
      feedCapture: () => "\x1b]Lother-icon\x07",
    } as unknown as LibProbeSource
    expect(icon.headless(headlessIcon).observation?.outcome).not.toBe("supported")
  })

  // AC3: a failed push/pop pair cannot identify which individual operation failed.
  // The prior case only covered failed setup; final WezTerm raw has valid setup and failed restoration.
  test.each(["device.xtwinops-22", "device.xtwinops-23"])("%s qualifies the complete title round trip", (id) => {
    for (const [titles, outcome] of [
      [["pushed-title", "new-title", "pushed-title"], "supported"],
      [["pushed-title", "new-title", "new-title"], "inconclusive"],
      [["test-icon", "test-icon", "test-icon"], "inconclusive"],
    ] as const) {
      let index = 0
      const context = {
        feed: () => undefined,
        getTitle: () => {
          const title = titles[index++]
          if (title === undefined) throw new Error("Unexpected title read")
          return title
        },
      } as unknown as LibProbeSource
      const result = callback(id).headless(context)
      expect(result.observation).toMatchObject({ outcome, assertionType: "buffer_state" })
      expect(result.response).toBe(JSON.stringify({ original: titles[0], changed: titles[1], restored: titles[2] }))
      if (outcome === "inconclusive") {
        expect(result.observation?.reason).toBe("insufficient-evidence")
        expect(result.assertions).toBeUndefined()
      } else {
        expect(result.assertions).toMatchObject([{ kind: "positive", observed: result.response }])
      }
    }
  })

  // #31735, #31387, @cto 863bef67: when both CSI 22;0t and CSI 23;0t are source-audited as unimplemented in the loaded
  // binary artifact (ghostty 0.4.0 stream_handler.zig:343-346; libvterm 0.3.3 state.c:978; vt100-rust 0.16.2
  // perform.rs:132-156; wezterm 0.1.0-fork.5 terminalstate/mod.rs:2090-2095), an observed setup + un-restored title
  // grades Unsupported by source citation; failed setup or unaudited artifacts stay inconclusive.
  test.each([
    ["d80a8110258a124fb6ff52a6fe149b8e39b5180d986907cc9fb7dc9143c3f3d9", "stream_handler.zig:343-346"],
    ["5937bd79139ee5856bcf1bd619cc44fcd2d750d3def3066a74956678cdaaaeb2", "src/state.c:978"],
    ["0919421290792a0c8be173dd50ec7a39c0ef68b1e0633fd979da13f22478c1d3", "src/perform.rs:132-156"],
    ["0f56a805793d7d829daa617f1323aacff0d73fe868747b0d077c6af315e2aab8", "src/terminalstate/mod.rs:2090-2095"],
  ] as const)(
    "audited title-stack artifact %s grades Unsupported by source only after observed setup",
    (sha256, cite) => {
      for (const id of ["device.xtwinops-22", "device.xtwinops-23"] as const) {
        const makeCtx = (titles: readonly [string, string, string], binarySha: string = sha256) => {
          let index = 0
          return {
            feed: () => undefined,
            runtimeIdentity: {
              kind: "js",
              runtimeFormat: "wasm",
              engineVersion: "0.4.0",
              adapterVersion: "0.4.0",
              termlessRevision: "0".repeat(40),
              resolvedPath: "fixture.js",
              integrity: { kind: "registry", lockIntegrity: "sha512-fixture" },
              loadedBinary: { path: "fixture.wasm", sha256: binarySha },
            },
            getTitle: () => titles[index++]!,
          } as unknown as LibProbeSource
        }
        const negative = callback(id).headless(makeCtx(["pushed-title", "new-title", "new-title"]))
        expect(negative.observation).toMatchObject({
          outcome: "unsupported",
          assertionType: "buffer_state",
          note: "negative by source citation",
        })
        expect(negative.assertions).toMatchObject([
          { kind: "negative", assertionType: "buffer_state", observed: negative.response },
        ])
        expect(JSON.parse(negative.response!)).toMatchObject({
          original: "pushed-title",
          changed: "new-title",
          restored: "new-title",
          artifactSha256: sha256,
          sourceCitation: expect.stringContaining(cite),
        })

        // Real restoration still wins over the audit table.
        const positive = callback(id).headless(makeCtx(["pushed-title", "new-title", "pushed-title"]))
        expect(positive.observation).toMatchObject({ outcome: "supported", assertionType: "buffer_state" })

        // Unobservable setup stays inconclusive even on an audited artifact.
        const unobservable = callback(id).headless(makeCtx(["", "", ""]))
        expect(unobservable.observation).toMatchObject({
          outcome: "inconclusive",
          reason: "insufficient-evidence",
          note: "Title setup was not observable",
        })

        // Unaudited digest stays inconclusive.
        const unaudited = callback(id).headless(makeCtx(["pushed-title", "new-title", "new-title"], "f".repeat(64)))
        expect(unaudited.observation).toMatchObject({ outcome: "inconclusive", reason: "insufficient-evidence" })
      }
    },
  )

  test.each([
    [
      "vendor/vterm/packages/vt100/src/index.ts",
      "5ffc7ad9ae120d0bf93c64b0fdc712eb40892896",
      "packages/vt100/src/screen.ts:251-358",
    ],
    [
      "vendor/vterm/packages/vt220/src/index.ts",
      "69366752918a6086c639123799cc3ac68d8083a0",
      "packages/vt220/src/screen.ts:305-428",
    ],
  ] as const)(
    "audited title-stack JS source tree %s (%s) grades Unsupported by source only after observed setup",
    (resolvedPath, treeOid, cite) => {
      for (const id of ["device.xtwinops-22", "device.xtwinops-23"] as const) {
        const baseIdentity = {
          kind: "js" as const,
          runtimeFormat: "js" as const,
          engineVersion: "0.9.0",
          adapterVersion: "0.10.2",
          termlessRevision: "d5e6248bfb080c3065f81b78c45bdfe1b37c06d6",
          resolvedPath,
          integrity: {
            kind: "source" as const,
            repository: "git@github.com:beorn/vterm.git",
            revision: "53a9eb9291b7880f4dc6a39a6802301049997a72",
            treeOid,
            cleanTree: true,
          },
        }
        const makeCtx = (
          titles: readonly [string, string, string],
          runtimeIdentity: unknown = baseIdentity,
        ): LibProbeSource => {
          let index = 0
          return {
            feed: () => undefined,
            runtimeIdentity,
            getTitle: () => titles[index++]!,
          } as unknown as LibProbeSource
        }

        const negative = callback(id).headless(makeCtx(["pushed-title", "new-title", "new-title"]))
        expect(negative.observation).toMatchObject({
          outcome: "unsupported",
          assertionType: "buffer_state",
          note: "negative by source citation",
        })
        expect(negative.assertions).toMatchObject([
          { kind: "negative", assertionType: "buffer_state", observed: negative.response },
        ])
        expect(JSON.parse(negative.response!)).toMatchObject({
          original: "pushed-title",
          changed: "new-title",
          restored: "new-title",
          revision: "53a9eb9291b7880f4dc6a39a6802301049997a72",
          treeOid,
          sourceCitation: expect.stringContaining(cite),
        })

        // Real restoration still wins over the audit table.
        const positive = callback(id).headless(makeCtx(["pushed-title", "new-title", "pushed-title"]))
        expect(positive.observation).toMatchObject({ outcome: "supported", assertionType: "buffer_state" })

        // Unobservable setup stays inconclusive even on an audited source tree.
        const unobservable = callback(id).headless(makeCtx(["", "", ""]))
        expect(unobservable.observation).toMatchObject({
          outcome: "inconclusive",
          reason: "insufficient-evidence",
          note: "Title setup was not observable",
        })

        // Any dirty or mutated source identity stays inconclusive.
        for (const mutated of [
          { ...baseIdentity, integrity: { ...baseIdentity.integrity, cleanTree: false } },
          { ...baseIdentity, integrity: { ...baseIdentity.integrity, revision: "f".repeat(40) } },
          { ...baseIdentity, integrity: { ...baseIdentity.integrity, treeOid: "f".repeat(40) } },
          { ...baseIdentity, integrity: { ...baseIdentity.integrity, repository: "git@github.com:other/vterm.git" } },
          { ...baseIdentity, resolvedPath: "vendor/vterm/packages/other/src/index.ts" },
        ]) {
          const res = callback(id).headless(makeCtx(["pushed-title", "new-title", "new-title"], mutated))
          expect(res.observation).toMatchObject({ outcome: "inconclusive", reason: "insufficient-evidence" })
        }
      }
    },
  )
})

/**
 * @failure XTWINOPS 16/21, XTREPORTCOLORS and XTGETXRES had no test binding their own frame, so a wrong or absent reply could have been read as support.
 * @level l0
 * @consumer App and headless device-query observations for the reply-decided feature set.
 * @testonly none
 */
describe("device contracts without prior coverage", () => {
  const app = (raw: string, reason: TerminalQueryOutcome["reason"] = "reply"): TermProbeSource =>
    ({
      write: () => undefined,
      queryWithSentinelOutcome: async (_sequence: string, pattern: RegExp) =>
        Promise.resolve({
          match: reason === "reply" ? pattern.exec(raw) : null,
          reason,
          raw,
          rawBase64: Buffer.from(raw).toString("base64"),
        }),
    }) as unknown as TermProbeSource

  test("XTWINOPS 16 binds a complete cell-pixel frame in both collectors", async () => {
    const probe = callback("device.xtwinops-16")
    const frame = "\x1b[6;16;8t"
    for (const result of [probe.headless(headless(frame)), await probe.terminal(app(frame))]) {
      expect(result.observation).toMatchObject({ outcome: "supported", assertionType: "query_reply" })
      expect(result.assertions).toMatchObject([{ kind: "positive", observed: frame }])
      expect(result.response).toBe(frame)
    }
    // A truncated frame is malformed, an unrelated window-op answer is no answer at all.
    expect(probe.headless(headless("\x1b[6;16;8")).observation).toMatchObject({
      outcome: "inconclusive",
      reason: "invalid-reply",
    })
    expect(probe.headless(headless("\x1b[4;720;1280t")).observation).toMatchObject({
      outcome: "inconclusive",
      reason: "no-response",
    })
  })

  test("XTREPORTCOLORS binds a complete palette-stack entry and count frame", async () => {
    const probe = callback("device.xtreportcolors")
    const frame = "\x1b[0;1#Q"
    for (const result of [probe.headless(headless(frame)), await probe.terminal(app(frame))]) {
      expect(result.observation).toMatchObject({ outcome: "supported", assertionType: "query_reply" })
      expect(result.assertions).toMatchObject([{ kind: "positive", observed: frame }])
    }
    expect(probe.headless(headless("\x1b[0;1#")).observation).toMatchObject({
      outcome: "inconclusive",
      reason: "invalid-reply",
    })
    expect(probe.headless(headless("\x1b[?62;52;c")).observation).toMatchObject({
      outcome: "inconclusive",
      reason: "no-response",
    })
  })

  test.each(["", "0", ";1", "0;", "0;1;2", "0;x"])(
    "XTREPORTCOLORS keeps malformed palette-stack fields %j inconclusive in both collectors",
    async (fields) => {
      const probe = callback("device.xtreportcolors")
      const raw = `\x1b[${fields}#Q`
      for (const result of [probe.headless(headless(raw)), await probe.terminal(app(raw))]) {
        expect(result.observation).toMatchObject({ outcome: "inconclusive", reason: "invalid-reply" })
        expect(result.assertions).toBeUndefined()
        expect(result.response).toBe(raw)
      }
    },
  )

  test("XTGETXRES binds a status-1 termName value and reads status 0 as a refusal", async () => {
    const probe = callback("device.xtgetxres")
    const frame = "\x1bP1+r7465726d4e616d65=787465726d\x1b\\"
    for (const result of [probe.headless(headless(frame)), await probe.terminal(app(frame))]) {
      expect(result.observation).toMatchObject({ outcome: "supported", assertionType: "query_reply" })
      expect(result.assertions).toMatchObject([{ kind: "positive", observed: frame }])
    }
    // The contract asks exactly one name, so a status-0 refusal is this probe's measured negative
    // (27914) — unlike the shared refusal branch, which stays inconclusive for multi-subject probes.
    const refusal = "\x1bP0+r7465726d4e616d65\x1b\\"
    for (const result of [probe.headless(headless(refusal)), await probe.terminal(app(refusal))]) {
      expect(result.observation).toMatchObject({ outcome: "unsupported", assertionType: "query_reply" })
      expect(result.assertions).toMatchObject([{ kind: "negative", observed: refusal }])
    }
    // XTGETXRES encodes two hex digits per character: missing ST, empty and odd-length values are malformed.
    for (const raw of [
      "\x1bP1+r7465726d4e616d65",
      "\x1bP1+r7465726d4e616d65=\x1b\\",
      "\x1bP1+R7465726d4e616d65=7\x1b\\",
      "\x1bP1+r7465726d4e616d65=787\x1b\\",
    ]) {
      for (const result of [probe.headless(headless(raw)), await probe.terminal(app(raw))]) {
        expect(result.observation).toMatchObject({ outcome: "inconclusive", reason: "invalid-reply" })
        expect(result.assertions).toBeUndefined()
      }
    }
  })

  test("XTWINOPS 21 sets its own title and binds the reported title to that exact frame", async () => {
    const probe = callback("device.xtwinops-21")
    const frame = "\x1b]ltest-title\x07"
    const writes: string[] = []
    const context = {
      write: (sequence: string) => {
        writes.push(sequence)
      },
      queryWithSentinelOutcome: async (sequence: string, pattern: RegExp) => {
        writes.push(sequence)
        return {
          match: pattern.exec(frame),
          reason: "reply" as const,
          raw: frame,
          rawBase64: Buffer.from(frame).toString("base64"),
        }
      },
    } as unknown as TermProbeSource
    const result = await probe.terminal(context)
    // The probe owns its setup: it sets the title it then requires.
    expect(writes).toEqual(["\x1b]2;test-title\x07", "\x1b[21t"])
    expect(result.observation).toMatchObject({ outcome: "supported", assertionType: "query_reply" })
    expect(result.assertions).toMatchObject([{ kind: "positive", observed: frame }])
    const feeds: string[] = []
    const headlessResult = probe.headless({
      feed: (sequence: string) => {
        feeds.push(sequence)
      },
      feedCapture: () => frame,
    } as unknown as LibProbeSource)
    expect(feeds).toEqual(["\x1b]2;test-title\x07"])
    expect(headlessResult.observation).toMatchObject({ outcome: "supported", assertionType: "query_reply" })
    // A different title is malformed for this query rather than a measured negative:
    // XTWINOPS 21 has no contradiction rule, unlike XTWINOPS 20.
    const other = probe.headless({
      feed: () => undefined,
      feedCapture: () => "\x1b]lother-title\x07",
    } as unknown as LibProbeSource)
    expect(other.observation).toMatchObject({ outcome: "inconclusive", reason: "invalid-reply" })
  })

  // 27914: xterm's XTREPORTCOLORS reply carries a DEC-private `?` the documented
  // CSI Pm # Q form does not show (measured: CSI ? 0 ; 1 # Q on xterm 411, while
  // kitty answers CSI 0 ; 0 # Q). The reference implementation's frame is support.
  test("XTREPORTCOLORS accepts the reference implementation's DEC-private reply", async () => {
    const probe = callback("device.xtreportcolors")
    const app = (frame: string) =>
      probe.terminal({
        queryOutcome: async (_sequence: string, pattern: RegExp) =>
          Promise.resolve({
            match: pattern.exec(frame),
            reason: "reply",
            raw: frame,
            rawBase64: Buffer.from(frame).toString("base64"),
          }),
        queryWithSentinelOutcome: async (_sequence: string, pattern: RegExp) =>
          Promise.resolve({
            match: pattern.exec(frame),
            reason: "reply",
            raw: frame,
            rawBase64: Buffer.from(frame).toString("base64"),
          }),
      } as unknown as TermProbeSource)
    for (const frame of ["\x1b[?0;1#Q", "\x1b[0;0#Q"]) {
      for (const result of [probe.headless(headless(frame)), await app(frame)]) {
        expect(result.response, frame).toBe(frame)
        expect(result.observation, frame).toMatchObject({ outcome: "supported", assertionType: "query_reply" })
        expect(result.assertions, frame).toMatchObject([{ kind: "positive", observed: frame }])
      }
    }
    const truncated = probe.headless(headless("\x1b[?0;1#"))
    expect(truncated.observation).toMatchObject({ outcome: "inconclusive", reason: "invalid-reply" })
    expect(truncated.assertions).toBeUndefined()
  })
})

// Actual run388fa7b54f74bfe5d9bfbecef7e4d924, vterm source53a9eb9/tree617ae60: no font/window geometry.
// Q8 requires independent review of this context limit, never automatic Untestable.
const geometryRuntime = {
  kind: "js",
  adapterVersion: "0.10.2",
  termlessRevision: "8b8664540f365fa0ba1d9b6400d3c4d1a160582c",
  resolvedPath: "vendor/vterm/packages/vterm/src/index.ts",
  integrity: {
    kind: "source",
    repository: "git@github.com:beorn/vterm.git",
    revision: "53a9eb9291b7880f4dc6a39a6802301049997a72",
    treeOid: "617ae6002c7befea7b3e43d11bf23e6b433e3d65",
    cleanTree: true,
  },
  runtimeFormat: "js",
  engineVersion: "0.9.0",
} as const
const geometryReplies = [
  {
    id: "device.xtwinops-14",
    raw: "\u001b[4;0;0t\u001b[?62;4c",
    positive: "\u001b[4;384;640t",
  },
  {
    id: "device.xtwinops-16",
    raw: "\u001b[6;0;0t\u001b[?62;4c",
    positive: "\u001b[6;16;8t",
  },
] as const

test.each(geometryReplies)("$id retains audited geometry limits for required review", ({ id, raw }) => {
  for (const sentinel of [false, true]) {
    const ctx = {
      feedCapture: () => raw,
      runtimeIdentity: geometryRuntime,
      ...(sentinel && {
        queryWithSentinelOutcome: () => ({
          raw,
          rawBase64: Buffer.from(raw).toString("base64"),
          reason: "sentinel",
          match: null,
        }),
      }),
    } as unknown as LibProbeSource
    const result = callback(id).headless(ctx)
    expect(result.notTested?.reason).toBe("no-semantic-observable")
    expect(result.tests).toMatchObject([{ id: "review", status: "test-todo" }])
    expect(result.observation).toBeUndefined()
    const state = JSON.parse(result.response!)
    expect(state).toMatchObject({ raw, runtimeIdentity: geometryRuntime })
  }
})

test.each(geometryReplies)("$id requires audited source and complete zero geometry", ({ id, raw, positive }) => {
  const identities = [
    undefined,
    { ...geometryRuntime, resolvedPath: "foreign/index.ts" },
    { ...geometryRuntime, runtimeFormat: "wasm" },
    ...[{ cleanTree: false }, { revision: "foreign" }, { treeOid: "foreign" }, { repository: "foreign" }].map(
      (change) => ({ ...geometryRuntime, integrity: { ...geometryRuntime.integrity, ...change } }),
    ),
  ]
  for (const runtimeIdentity of identities) {
    const ctx = { feedCapture: () => raw, runtimeIdentity } as unknown as LibProbeSource
    expect(callback(id).headless(ctx).notTested).toBeUndefined()
  }
  for (const reply of ["", raw.slice(0, 4), "foreign", raw + "foreign", "foreign" + raw]) {
    const ctx = { feedCapture: () => reply, runtimeIdentity: geometryRuntime } as unknown as LibProbeSource
    expect(callback(id).headless(ctx).notTested).toBeUndefined()
  }
  const ctx = { feedCapture: () => positive, runtimeIdentity: geometryRuntime } as unknown as LibProbeSource
  expect(callback(id).headless(ctx).observation?.outcome).toBe("supported")
})
