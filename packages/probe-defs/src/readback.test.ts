/**
 * @failure Tier-2 readback queries are treated as decisions even when the terminal never answers, or a missing reply is graded as a negative.
 * @level l1
 * @consumer App-mode readback decisions for SGR, DECTCEM and IRM support cells.
 * @testonly none
 */
import { expect, test } from "vitest"
import { cursorProbes } from "./cursor.ts"
import { modesProbes } from "./modes.ts"
import { sgrProbes } from "./sgr.ts"
import type { TermContext, TerminalQueryOutcome } from "./types.ts"

function termProbe(id: string): (ctx: TermContext) => Promise<import("./types.ts").ProbeResult> {
  const probe = [...sgrProbes, ...cursorProbes, ...modesProbes].find((value) => value.id === id)
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
      if (bytes.includes("\x1b[0m")) sgr = []
      if (bytes.includes("\x1b[1m")) sgr = [1]
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
