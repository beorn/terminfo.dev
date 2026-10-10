/**
 * @failure Tier-2 readback queries are treated as decisions even when the terminal never answers, or a missing reply is graded as a negative.
 * @level l1
 * @consumer App-mode readback decisions for SGR, DECTCEM and IRM support cells.
 * @testonly none
 */
import { expect, test } from "vitest"
import { cursorProbes } from "./cursor.ts"
import { modesProbes } from "./modes.ts"
import { resetProbes } from "./reset.ts"
import { sgrProbes } from "./sgr.ts"
import type { TermContext, TerminalQueryOutcome } from "./types.ts"

function termProbe(id: string): (ctx: TermContext) => Promise<import("./types.ts").ProbeResult> {
  const probe = [...sgrProbes, ...cursorProbes, ...modesProbes, ...resetProbes].find((value) => value.id === id)
  if (!probe?.term) throw new Error(`missing term callback for ${id}`)
  return probe.term
}

function timeout(): TerminalQueryOutcome {
  return { match: null, reason: "timeout", raw: "", rawBase64: "" }
}

/**
 * A Kitty-shaped terminal: it maintains real SGR, DECTCEM and IRM state and answers DECRQSS
 * and DECRQM from that state. `answer: false` models a terminal that never replies.
 */
function kittyContext(answer: boolean): TermContext {
  let sgr: number[] = []
  let visible = true
  let irm = false
  return {
    rows: 24,
    cols: 80,
    capture: async ({ role, label }) => ({ role, label, capturedAt: 1, ref: `frame-${role}` }),
    write(bytes) {
      for (const match of bytes.matchAll(/\x1b\[([0-9;]*)m/g)) {
        const params = (match[1] ?? "")
          .split(";")
          .filter((part) => part !== "")
          .map(Number)
        // A real SGR state: 0 (or a bare CSI m) clears, any other parameter accumulates.
        sgr = params.length === 0 || params.includes(0) ? [] : [...new Set([...sgr, ...params])]
      }
      if (bytes.includes("\x1b[?25h")) visible = true
      if (bytes.includes("\x1b[?25l")) visible = false
      if (bytes.includes("\x1b[4h")) irm = true
      if (bytes.includes("\x1b[4l")) irm = false
    },
    queryCursorPosition: async () => ({ row: 1, col: 2 }),
    measureRenderedWidth: async () => null,
    query: async () => null,
    queryWithSentinel: async () => null,
    queryOutcome: async () => timeout(),
    async queryWithSentinelOutcome(sequence) {
      if (!answer) return timeout()
      if (sequence.startsWith("\x1bP$qm")) {
        const payload = sgr.length === 0 ? "" : sgr.join(";")
        return { match: [`\x1bP1$r${payload}m\x1b\\`, payload], reason: "reply", raw: "", rawBase64: "" }
      }
      if (sequence === "\x1b[4$p") {
        const status = irm ? "1" : "2"
        return { match: [`\x1b[4;${status}$y`, status], reason: "reply", raw: "", rawBase64: "" }
      }
      return timeout()
    },
    queryMode: async (modeNum) => {
      if (!answer) return null
      if (modeNum === 25) return visible ? "set" : "reset"
      return null
    },
  }
}

test.each([
  ["sgr.bold", "1"],
  ["cursor.hide", "set -> reset"],
  ["modes.insert-replace", "set -> reset"],
] as const)("%s is decided supported by its readback query on a responding terminal", async (id, observed) => {
  const result = await termProbe(id)(kittyContext(true))
  expect(result.pass).toBe(true)
  expect(result.observation).toMatchObject({ outcome: "supported", evidence: "query" })
  expect(result.assertions?.[0]).toMatchObject({ kind: "positive" })
  if (id === "sgr.bold") expect(result.response).toContain(observed)
  else expect(result.response).toContain("set")
})

test.each(["sgr.bold", "cursor.hide", "modes.insert-replace"] as const)(
  "%s stays inconclusive and never negative when the readback reply is missing",
  async (id) => {
    const result = await termProbe(id)(kittyContext(false))
    expect(result.pass).toBe(false)
    expect(result.observation?.outcome).toBe("inconclusive")
    expect(result.observation?.outcome).not.toBe("unsupported")
  },
)

test("an incorrect SGR readback is a negative, not a pass", async () => {
  const ctx = kittyContext(true)
  const original = ctx.queryWithSentinelOutcome
  ctx.queryWithSentinelOutcome = async (sequence, pattern, timeoutMs) => {
    const outcome = await original.call(ctx, sequence, pattern, timeoutMs)
    if (sequence.startsWith("\x1bP$qm")) {
      return { match: ["\x1bP1$r0m\x1b\\", "0"], reason: "reply", raw: "", rawBase64: "" }
    }
    return outcome
  }
  const result = await termProbe("sgr.bold")(ctx)
  expect(result.pass).toBe(false)
  expect(result.observation).toMatchObject({ outcome: "unsupported", evidence: "query" })
})

// Kitty 0.49.2 answers DECRQSS with the full normalized SGR list, not just the set codes:
// after CSI 0 m CSI 1 m it reported "0;22;1" (reset, normal intensity, bold).
test("the exact Kitty 0.49.2 DECRQSS reply still decides sgr.bold", async () => {
  const ctx = kittyContext(true)
  ctx.queryWithSentinelOutcome = async (sequence) => {
    if (sequence.startsWith("\x1bP$qm")) {
      return { match: ["\x1bP1$r0;22;1m\x1b\\", "0;22;1"], reason: "reply", raw: "", rawBase64: "" }
    }
    return timeout()
  }
  const result = await termProbe("sgr.bold")(ctx)
  expect(result.pass).toBe(true)
  expect(result.observation).toMatchObject({ outcome: "supported", evidence: "query" })
  expect(result.response).toContain("0;22;1")
})

/**
 * reset.sgr is an SGR-state claim, so the terminal's own DECRQSS report decides it (the shared
 * sgrReadbackDecision shape sgr.reset binds from sgr.ts) and no pixel review is needed: after
 * the setup and the reset the terminal reports no style code.
 */
test("reset.sgr is decided supported when the terminal reports no styles after the reset", async () => {
  const ctx = kittyContext(true)
  const result = await termProbe("reset.sgr")(ctx)
  expect(result.pass).toBe(true)
  expect(result.observation).toMatchObject({ outcome: "supported", evidence: "query" })
  expect(result.assertions?.[0]).toMatchObject({ kind: "positive" })
})

test("the normalized Kitty DECRQSS list still decides reset.sgr", async () => {
  const ctx = kittyContext(true)
  // What Kitty's normalized list reports after the reset: explicit negation codes, no 1/3/7.
  const payload = "0;22;23;24;27"
  ctx.queryWithSentinelOutcome = async (sequence) => {
    if (!sequence.startsWith("\x1bP$qm")) return timeout()
    return { match: [`\x1bP1$r${payload}m\x1b\\`, payload], reason: "reply", raw: "", rawBase64: "" }
  }
  const result = await termProbe("reset.sgr")(ctx)
  expect(result.pass).toBe(true)
  expect(result.observation).toMatchObject({ outcome: "supported", evidence: "query" })
  expect(result.response).toContain(payload)
})

test("reset.sgr is a negative when the terminal keeps reporting the styles after the reset", async () => {
  const ctx = kittyContext(true)
  ctx.queryWithSentinelOutcome = async (sequence) => {
    if (!sequence.startsWith("\x1bP$qm")) return timeout()
    return { match: ["\x1bP1$r1;3;7m\x1b\\", "1;3;7"], reason: "reply", raw: "", rawBase64: "" }
  }
  const result = await termProbe("reset.sgr")(ctx)
  expect(result.pass).toBe(false)
  expect(result.observation).toMatchObject({ outcome: "unsupported", evidence: "query" })
  expect(result.assertions?.[0]).toMatchObject({ kind: "negative" })
})

test("reset.sgr stays inconclusive and never negative when the terminal never answers DECRQSS", async () => {
  const result = await termProbe("reset.sgr")(kittyContext(false))
  expect(result.pass).toBe(false)
  expect(result.observation?.outcome).toBe("inconclusive")
  expect(result.observation?.outcome).not.toBe("unsupported")
  // The capture path is retained for a terminal that answers nothing, so the silent case keeps
  // today's reviewable pixel frames instead of losing them.
  expect(result.observation).toMatchObject({ evidence: "pixels" })
})
