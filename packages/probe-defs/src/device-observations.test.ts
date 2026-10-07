import { describe, expect, test } from "vitest"
import { deviceProbes } from "./device.ts"
import type { TermContext, TermlessContext, TerminalQueryOutcome } from "./types.ts"

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

function headless(raw: string): TermlessContext {
  // Device query callbacks use only feedCapture; missing operations fail loudly if newly used.
  return { feedCapture: () => raw } as unknown as TermlessContext
}

function terminal(
  raw: string,
  reason: TerminalQueryOutcome["reason"] = "reply",
  sentinel?: { atMs: number; graceMs: number },
): TermContext {
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
  } as unknown as TermContext
}

function callback(id: string) {
  const definition = deviceProbes.find((item) => item.id === id)
  if (!definition?.termless || !definition.term) throw new Error(`missing device callback ${id}`)
  return { headless: definition.termless, terminal: definition.term }
}

const DECRQSS_SGR_QUERY = "\x1bP$qm\x1b\\"
const DECRQSS_DECSTBM_QUERY = "\x1bP$qr\x1b\\"
const DECRQSS_SGR_VALID = "\x1bP1$r0m\x1b\\"
const DECRQSS_REFUSAL = "\x1bP0$r\x1b\\"
const DECRQSS_DECSTBM_VALID = "\x1bP1$r1;24r\x1b\\"
const DA1 = "\x1b[?62;52;c"

function terminalScript(
  replies: Record<
    string,
    { raw: string; reason: TerminalQueryOutcome["reason"]; sentinel?: { atMs: number; graceMs: number } }
  >,
): { ctx: TermContext; queries: string[] } {
  const queries: string[] = []
  const ctx = {
    queryWithSentinelOutcome: (sequence: string, pattern: RegExp) => {
      queries.push(sequence)
      const item = replies[sequence]
      if (!item) throw new Error(`unexpected query ${JSON.stringify(sequence)}`)
      const match = item.reason === "reply" ? pattern.exec(item.raw) : null
      return Promise.resolve({
        match,
        reason: item.reason,
        raw: item.raw,
        rawBase64: Buffer.from(item.raw).toString("base64"),
        ...(item.sentinel && { sentinel: item.sentinel }),
      })
    },
  } as unknown as TermContext
  return { ctx, queries }
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
        expect(result.observation).toMatchObject({ outcome: "supported", evidence: "query" })
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
        evidence: "query",
        note: "reply after sentinel",
      })
      expect(late.assertions, item.id).toMatchObject([{ kind: "positive", observed: item.valid }])

      const earlyRaw = item.valid + da1
      const early = await callback(item.id).terminal(terminal(earlyRaw))
      expect(early.response, item.id).toBe(earlyRaw)
      expect(early.observation, item.id).toMatchObject({ outcome: "supported", evidence: "query" })
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
        evidence: "query",
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
        evidence: "query",
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
        evidence: "query",
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
        evidence: "query",
      })
      expect(result.assertions).toBeUndefined()
    }
    for (const result of [probe.headless(headless(valid + refusal)), await probe.terminal(terminal(valid + refusal))]) {
      expect(result.response).toBe(valid + refusal)
      expect(result.observation).toMatchObject({ outcome: "supported", evidence: "query" })
      expect(result.assertions).toMatchObject([{ kind: "positive", observed: valid }])
    }
  })

  test("silence is inconclusive and a TTY deadline remains a timeout", async () => {
    for (const item of replies) {
      const probe = callback(item.id)
      expect(probe.headless(headless("")).observation).toMatchObject({ outcome: "inconclusive", reason: "no-response" })
      expect((await probe.terminal(terminal("", "timeout"))).observation).toMatchObject({
        outcome: "inconclusive",
        reason: "timeout",
      })
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
    } as unknown as TermContext)
    expect(result.observation).toMatchObject({ outcome: "supported", evidence: "query" })
    expect(result.response).toBe(raw)
    expect(result.assertions).toMatchObject([{ kind: "positive", observed: "\x1b[?1;2c" }])
  })

  test("complete single-setting refusals are inconclusive; malfunction is still a DSR report", async () => {
    const sgrRefusal = "\x1bP0$r\x1b\\"
    expect(callback("device.decrqss").headless(headless(sgrRefusal)).observation).toMatchObject({
      outcome: "inconclusive",
      reason: "insufficient-evidence",
      evidence: "query",
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
          evidence: "query",
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
    expect(result.observation).toMatchObject({ outcome: "supported", evidence: "query" })
    expect(result.assertions).toMatchObject([{ kind: "positive", observed: DECRQSS_DECSTBM_VALID }])
  })

  test("SGR status-0 then DECSTBM status-0 is inconclusive and names both refusals", async () => {
    const script = terminalScript({
      [DECRQSS_SGR_QUERY]: { raw: DECRQSS_REFUSAL, reason: "reply" },
      [DECRQSS_DECSTBM_QUERY]: { raw: DECRQSS_REFUSAL, reason: "reply" },
    })
    const result = await callback("device.decrqss").terminal(script.ctx)
    expect(script.queries).toEqual([DECRQSS_SGR_QUERY, DECRQSS_DECSTBM_QUERY])
    expect(result.observation).toMatchObject({
      outcome: "inconclusive",
      reason: "insufficient-evidence",
      evidence: "query",
    })
    expect(result.observation?.note).toMatch(/SGR/)
    expect(result.observation?.note).toMatch(/DECSTBM/)
    expect(result.assertions).toBeUndefined()
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
      evidence: "query",
    })
    expect(result.observation?.note).not.toBe("negative by sentinel")
    expect(result.assertions).toBeUndefined()
  })

  test("SGR status 1 keeps today's grade and never asks DECSTBM", async () => {
    const script = terminalScript({
      [DECRQSS_SGR_QUERY]: { raw: DECRQSS_SGR_VALID, reason: "reply" },
    })
    const result = await callback("device.decrqss").terminal(script.ctx)
    expect(script.queries).toEqual([DECRQSS_SGR_QUERY])
    expect(result.observation).toMatchObject({ outcome: "supported", evidence: "query" })
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
      evidence: "query",
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
      expect(result.observation).toMatchObject({ outcome: "inconclusive", reason: "insufficient-evidence" })
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
  test("XTWINOPS 14 binds a complete pixel-size frame in both collectors", async () => {
    const probe = callback("device.xtwinops-14")
    const frame = "\x1b[4;720;1280t"
    const app = {
      queryWithSentinelOutcome: async (_query: string, pattern: RegExp) => ({
        match: pattern.exec(frame),
        reason: "reply",
        raw: frame,
        rawBase64: Buffer.from(frame).toString("base64"),
      }),
    } as unknown as TermContext
    for (const result of [probe.headless(headless(frame)), await probe.terminal(app)]) {
      expect(result.observation).toMatchObject({ outcome: "supported", evidence: "query" })
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
    const headlessIcon = (frame: string): TermlessContext =>
      ({ feed: () => undefined, feedCapture: () => frame }) as unknown as TermlessContext
    const app = (frame: string, reason: TerminalQueryOutcome["reason"] = "reply"): TermContext =>
      ({
        write: () => undefined,
        queryWithSentinelOutcome: (sequence: string, pattern: RegExp) =>
          Promise.resolve({
            match: reason === "reply" ? pattern.exec(frame) : null,
            reason,
            raw: frame,
            rawBase64: Buffer.from(frame).toString("base64"),
          }),
      }) as unknown as TermContext
    for (const frame of ["\x1b]L\x1b\\", "\x1b]Lother-icon\x07", "\x1b]Ltest-icon-plus\x1b\\"]) {
      const head = icon.headless(headlessIcon(frame))
      expect(head.observation).toMatchObject({ outcome: "unsupported", evidence: "query" })
      expect(head.assertions).toMatchObject([{ kind: "negative", observed: frame }])
      const live = await icon.terminal(app(frame))
      expect(live.observation).toMatchObject({ outcome: "unsupported", evidence: "query" })
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
      evidence: "query",
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
    } as unknown as TermlessContext
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
      } as unknown as TermlessContext
      const result = callback(id).headless(context)
      expect(result.observation).toMatchObject({ outcome, evidence: "parser-state" })
      expect(result.response).toBe(JSON.stringify({ original: titles[0], changed: titles[1], restored: titles[2] }))
      if (outcome === "inconclusive") {
        expect(result.observation?.reason).toBe("insufficient-evidence")
        expect(result.assertions).toBeUndefined()
      } else {
        expect(result.assertions).toMatchObject([{ kind: "positive", observed: result.response }])
      }
    }
  })
})

/**
 * @failure XTWINOPS 16/21, XTREPORTCOLORS and XTGETXRES had no test binding their own frame, so a wrong or absent reply could have been read as support.
 * @level l0
 * @consumer App and headless device-query observations for the reply-decided feature set.
 * @testonly none
 */
describe("device contracts without prior coverage", () => {
  const app = (raw: string, reason: TerminalQueryOutcome["reason"] = "reply"): TermContext =>
    ({
      write: () => undefined,
      queryWithSentinelOutcome: async (_sequence: string, pattern: RegExp) =>
        Promise.resolve({
          match: reason === "reply" ? pattern.exec(raw) : null,
          reason,
          raw,
          rawBase64: Buffer.from(raw).toString("base64"),
        }),
    }) as unknown as TermContext

  test("XTWINOPS 16 binds a complete cell-pixel frame in both collectors", async () => {
    const probe = callback("device.xtwinops-16")
    const frame = "\x1b[6;16;8t"
    for (const result of [probe.headless(headless(frame)), await probe.terminal(app(frame))]) {
      expect(result.observation).toMatchObject({ outcome: "supported", evidence: "query" })
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

  test("XTREPORTCOLORS binds a complete CSI Pm # Q frame", async () => {
    const probe = callback("device.xtreportcolors")
    const frame = "\x1b[0;1#Q"
    for (const result of [probe.headless(headless(frame)), await probe.terminal(app(frame))]) {
      expect(result.observation).toMatchObject({ outcome: "supported", evidence: "query" })
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

  test("XTGETXRES binds a status-1 termName value and reads status 0 as a refusal", async () => {
    const probe = callback("device.xtgetxres")
    const frame = "\x1bP1+r7465726d4e616d65=787465726d\x1b\\"
    for (const result of [probe.headless(headless(frame)), await probe.terminal(app(frame))]) {
      expect(result.observation).toMatchObject({ outcome: "supported", evidence: "query" })
      expect(result.assertions).toMatchObject([{ kind: "positive", observed: frame }])
    }
    // Status 0 is a complete answer that refuses the name: inconclusive, never a negative claim.
    for (const result of [
      probe.headless(headless("\x1bP0+r7465726d4e616d65\x1b\\")),
      await probe.terminal(app("\x1bP0+r7465726d4e616d65\x1b\\")),
    ]) {
      expect(result.observation).toMatchObject({ outcome: "inconclusive", evidence: "query" })
      expect(result.assertions).toBeUndefined()
    }
    // A missing ST, or a status-1 frame with no value, is malformed rather than absent.
    for (const raw of ["\x1bP1+r7465726d4e616d65", "\x1bP1+r7465726d4e616d65=\x1b\\"]) {
      expect(probe.headless(headless(raw)).observation).toMatchObject({
        outcome: "inconclusive",
        reason: "invalid-reply",
      })
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
    } as unknown as TermContext
    const result = await probe.terminal(context)
    // The probe owns its setup: it sets the title it then requires.
    expect(writes).toEqual(["\x1b]2;test-title\x07", "\x1b[21t"])
    expect(result.observation).toMatchObject({ outcome: "supported", evidence: "query" })
    expect(result.assertions).toMatchObject([{ kind: "positive", observed: frame }])
    const feeds: string[] = []
    const headlessResult = probe.headless({
      feed: (sequence: string) => {
        feeds.push(sequence)
      },
      feedCapture: () => frame,
    } as unknown as TermlessContext)
    expect(feeds).toEqual(["\x1b]2;test-title\x07"])
    expect(headlessResult.observation).toMatchObject({ outcome: "supported", evidence: "query" })
    // A different title is malformed for this query rather than a measured negative:
    // XTWINOPS 21 has no contradiction rule, unlike XTWINOPS 20.
    const other = probe.headless({
      feed: () => undefined,
      feedCapture: () => "\x1b]lother-title\x07",
    } as unknown as TermlessContext)
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
      } as unknown as TermContext)
    for (const frame of ["\x1b[?0;1#Q", "\x1b[0;0#Q"]) {
      for (const result of [probe.headless(headless(frame)), await app(frame)]) {
        expect(result.response, frame).toBe(frame)
        expect(result.observation, frame).toMatchObject({ outcome: "supported", evidence: "query" })
        expect(result.assertions, frame).toMatchObject([{ kind: "positive", observed: frame }])
      }
    }
    const truncated = probe.headless(headless("\x1b[?0;1#"))
    expect(truncated.observation).toMatchObject({ outcome: "inconclusive", reason: "invalid-reply" })
    expect(truncated.assertions).toBeUndefined()
  })
})
