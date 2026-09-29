import { describe, expect, test } from "vitest"
import { deviceProbes } from "./device.ts"
import type { TermContext, TermlessContext, TerminalQueryOutcome } from "./types.ts"

const replies = [
  { id: "device.primary-da", query: "\x1b[c", valid: "\x1b[?1;2c", partial: "\x1b[?1;c" },
  { id: "device.status-report", query: "\x1b[5n", valid: "\x1b[0n", partial: "\x1b[4n" },
  { id: "device.secondary-da", query: "\x1b[>c", valid: "\x1b[>0;49;1c", partial: "\x1b[>0;;1c" },
  { id: "device.tertiary-da", query: "\x1b[=c", valid: "\x1bP!|1234ABCD\x1b\\", partial: "\x1bP!|1234ABCD" },
  { id: "device.decrqss", query: '\x1bP$q"p\x1b\\', valid: '\x1bP1$r61;1"p\x1b\\', partial: "\x1bP1$r" },
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

function terminal(raw: string, reason: TerminalQueryOutcome["reason"] = "reply"): TermContext {
  const reply = (sequence: string, pattern: RegExp): Promise<TerminalQueryOutcome> => {
    const item = replies.find((candidate) => candidate.query === sequence)
    if (!item) throw new Error(`unexpected query ${JSON.stringify(sequence)}`)
    return Promise.resolve({ match: pattern.exec(raw), reason, raw, rawBase64: Buffer.from(raw).toString("base64") })
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

  test("complete protocol refusals are scoped negative results; malfunction is still a DSR report", async () => {
    for (const [id, frame] of [
      ["device.decrqss", "\x1bP0$r\x1b\\"],
      ["device.xtgettcap", "\x1bP0+r\x1b\\"],
      ["device.decrpm", "\x1b[?7;0$y"],
    ] as const) {
      const probe = callback(id)
      for (const result of [probe.headless(headless(frame)), await probe.terminal(terminal(frame))]) {
        expect(result.observation).toMatchObject({ outcome: "unsupported", evidence: "query" })
        expect(result.assertions).toMatchObject([{ kind: "negative", observed: frame }])
        expect(result.response).toBe(frame)
      }
    }
    const status = callback("device.status-report")
    const malfunction = status.headless(headless("\x1b[3n"))
    expect(malfunction.observation).toMatchObject({ outcome: "supported", note: "Terminal reports malfunction" })
    expect(malfunction.assertions).toMatchObject([{ kind: "positive", observed: "\x1b[3n" }])
  })

  test("the exact requested mode/name and a complete ST matter", () => {
    for (const [id, frame] of [
      ["device.decrpm", "\x1b[?1;1$y"],
      ["device.xtgettcap", "\x1bP1+r5267=78\x1b\\"],
      ["device.decrqss", "\x1bP1$rm\x1b\\"],
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
