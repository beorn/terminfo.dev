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
import type { TermProbeSource, TerminalQueryOutcome } from "./types.ts"

function termProbe(id: string): (ctx: TermProbeSource) => Promise<import("./types.ts").ProbeCallbackResult> {
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
function kittySource(answer: boolean, resets = true, permanent = false): TermProbeSource {
  let sgr: number[] = []
  let visible = true
  let irm = false
  return {
    kind: "live",
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
        if (params.length === 0 || params.includes(0)) {
          if (resets) sgr = []
        } else {
          sgr = [...new Set([...sgr, ...params])]
        }
      }
      if (bytes.includes("\x1b[?25h")) visible = true
      if (bytes.includes("\x1b[?25l")) visible = false
      if (bytes.includes("\x1b[4h")) irm = true
      if (bytes.includes("\x1b[4l")) irm = false
    },
    queryCursorPosition: async () => ({ row: 1, col: 2 }),
    measureRenderedWidth: async () => null,
    query: async () => null,
    // DECRQM answers with the Ps: DECTCEM (private 25) and IRM (ANSI 4) from live state, or Ps 4 for a terminal
    // that knows both modes and cannot set them (#30557 r2).
    queryWithSentinel: async (sequence, pattern) => {
      if (!answer) return null
      const ps = (on: boolean) => (permanent ? "4" : on ? "1" : "2")
      if (sequence === "\x1b[?25$p") return pattern.exec(`\x1b[?25;${ps(visible)}$y`)
      if (sequence === "\x1b[4$p") return pattern.exec(`\x1b[4;${ps(irm)}$y`)
      return null
    },
    queryOutcome: async () => timeout(),
    async queryWithSentinelOutcome(sequence) {
      if (!answer) return timeout()
      if (sequence.startsWith("\x1bP$qm")) {
        const payload = sgr.length === 0 ? "" : sgr.join(";")
        return { match: [`\x1bP1$r${payload}m\x1b\\`, payload], reason: "reply", raw: "", rawBase64: "" }
      }
      return timeout()
    },
    queryMode: async () => {
      throw new Error(
        "the DECTCEM and IRM toggles read the Ps through queryWithSentinel, never the folded word (#30557)",
      )
    },
  }
}

test.each([
  ["sgr.bold", "1"],
  ["cursor.hide", "set (Ps 1) -> reset (Ps 2)"],
  ["modes.insert-replace", "set (Ps 1) -> reset (Ps 2)"],
] as const)("%s is decided supported by its readback query on a responding terminal", async (id, observed) => {
  const result = await termProbe(id)(kittySource(true))
  expect(result.pass).toBe(true)
  expect(result.observation).toMatchObject({ outcome: "supported", assertionType: "query_reply" })
  expect(result.assertions?.[0]).toMatchObject({ kind: "positive" })
  if (id === "sgr.bold") expect(result.response).toContain(observed)
  else expect(result.assertions?.[0]?.observed).toBe(observed)
})

// #30557 r2: the toggle cells store the Ps, so a permanently reset mode (Ps 4) grades unsupported and reads as such.
test.each(["cursor.hide", "modes.insert-replace"] as const)(
  "%s grades a permanently reset mode unsupported and stores the Ps",
  async (id) => {
    const result = await termProbe(id)(kittySource(true, true, true))
    expect(result.pass).toBe(false)
    expect(result.observation).toMatchObject({ outcome: "unsupported", assertionType: "query_reply" })
    expect(result.assertions?.[0]).toMatchObject({
      kind: "negative",
      observed: "permanently reset (Ps 4) -> permanently reset (Ps 4)",
    })
    expect(result.response).toContain("permanently reset (Ps 4)")
  },
)

test.each(["sgr.bold", "cursor.hide", "modes.insert-replace"] as const)(
  "%s stays inconclusive and never negative when the readback reply is missing",
  async (id) => {
    const result = await termProbe(id)(kittySource(false))
    expect(result.pass).toBe(false)
    expect(result.observation?.outcome).toBe("inconclusive")
    expect(result.observation?.outcome).not.toBe("unsupported")
  },
)

test("an incorrect SGR readback is a negative, not a pass", async () => {
  const ctx = kittySource(true)
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
  expect(result.observation).toMatchObject({ outcome: "unsupported", assertionType: "query_reply" })
})

// Kitty 0.49.2 answers DECRQSS with the full normalized SGR list, not just the set codes:
// after CSI 0 m CSI 1 m it reported "0;22;1" (reset, normal intensity, bold).
test("the exact Kitty 0.49.2 DECRQSS reply still decides sgr.bold", async () => {
  const ctx = kittySource(true)
  ctx.queryWithSentinelOutcome = async (sequence) => {
    if (sequence.startsWith("\x1bP$qm")) {
      return { match: ["\x1bP1$r0;22;1m\x1b\\", "0;22;1"], reason: "reply", raw: "", rawBase64: "" }
    }
    return timeout()
  }
  const result = await termProbe("sgr.bold")(ctx)
  expect(result.pass).toBe(true)
  expect(result.observation).toMatchObject({ outcome: "supported", assertionType: "query_reply" })
  expect(result.response).toContain("0;22;1")
})

/**
 * @failure reset.sgr is graded from something other than the terminal's own DECRQSS report: a
 *   missing reply is turned into a negative, or a terminal that keeps reporting 1/3/7 after the
 *   reset is still graded supported.
 * @level l1
 * @consumer reset.sgr app-arm decision (Reset group 28024), through the shared sgrReadbackDecision
 *   shape that sgr.reset binds from sgr.ts.
 * @testonly none
 *
 * reset.sgr is an SGR-state claim, so the terminal's own DECRQSS report decides it (the shared
 * sgrReadbackDecision shape sgr.reset binds from sgr.ts) and no pixel review is needed: after
 * a qualified setup and the reset the terminal reports no style code. Covers the four cases below: the
 * plain supported report, Kitty's normalized negation-list report, a retained 1/3/7 report
 * (negative), and a silent terminal (inconclusive, never negative).
 */
test("reset.sgr is decided supported when the terminal reports no styles after the reset", async () => {
  const ctx = kittySource(true)
  const result = await termProbe("reset.sgr")(ctx)
  expect(result.pass).toBe(true)
  expect(result.observation).toMatchObject({ outcome: "supported", assertionType: "query_reply" })
  expect(result.assertions?.[0]).toMatchObject({ kind: "positive" })
})

test("the normalized Kitty DECRQSS list still decides reset.sgr", async () => {
  const ctx = kittySource(true)
  // What Kitty's normalized list reports after the reset: explicit negation codes, no 1/3/7.
  const payload = "0;22;23;24;27"
  const readState = ctx.queryWithSentinelOutcome
  ctx.queryWithSentinelOutcome = async (sequence, pattern, timeoutMs) => {
    const outcome = await readState(sequence, pattern, timeoutMs)
    if (sequence.startsWith("\x1bP$qm") && outcome.match?.[1] === "") {
      return { ...outcome, match: [`\x1bP1$r${payload}m\x1b\\`, payload] }
    }
    return outcome
  }
  const result = await termProbe("reset.sgr")(ctx)
  expect(result.pass).toBe(true)
  expect(result.observation).toMatchObject({ outcome: "supported", assertionType: "query_reply" })
  expect(result.response).toContain(payload)
})

/**
 * @failure a forbid-only SGR claim stores an empty expected token, so the stored evidence cannot say
 *   which codes the terminal was required NOT to report.
 * @level l1
 * @consumer the stored assertion text of reset.sgr, sgr.reset, sgr.fg.default and sgr.bg.default.
 * @testonly none
 *
 * reset.sgr requires nothing and forbids bold, italic and inverse, so its expected text names those
 * codes instead of being empty. sgr.selective-reset.italic still requires bold, so its expected text
 * is the required code alone and is unchanged.
 */
test("a forbid-only SGR claim names the forbidden codes in its expected text", async () => {
  const ctx = kittySource(true)
  const result = await termProbe("reset.sgr")(ctx)
  expect(result.assertions?.[0]?.expected).toContain("reset.sgr: DECRQSS reports none of 1;3;7 after")
})

test("an SGR claim that requires a code keeps the required code as its expected text", async () => {
  const ctx = kittySource(true)
  const result = await termProbe("sgr.selective-reset.italic")(ctx)
  expect(result.assertions?.[0]?.expected).toContain("DECRQSS reports 1 after")
})

test("reset.sgr is a negative when the terminal keeps reporting the styles after the reset", async () => {
  const ctx = kittySource(true, false)
  const result = await termProbe("reset.sgr")(ctx)
  expect(result.pass).toBe(false)
  expect(result.observation).toMatchObject({ outcome: "unsupported", assertionType: "query_reply" })
  expect(result.assertions?.[0]).toMatchObject({ kind: "negative" })
})

test("reset.sgr records FAILURE and no observation when the terminal never answers DECRQSS", async () => {
  const result = await termProbe("reset.sgr")(kittySource(false))
  expect(result.pass).toBe(false)
  expect(result.observation).toBeUndefined()
  expect(result.tests).toMatchObject([expect.objectContaining({ status: "test-failure", reason: expect.any(String) })])
})
