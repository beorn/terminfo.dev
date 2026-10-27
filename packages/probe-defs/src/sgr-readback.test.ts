/**
 * @failure SGR probes on a real terminal fall to pixel capture that nothing grades, so sgr.* stays inconclusive despite the terminal answering DECRQSS.
 * @level l1
 * @consumer Linux hosted app-mode decisions for the sgr.* group.
 * @testonly none
 */
import { expect, test } from "vitest"
import { recordExecutedCapability } from "./helpers.ts"
import { resetProbes } from "./reset.ts"
import { sgrProbes } from "./sgr.ts"
import type { ProbeCallbackResult, TermContext, TerminalQueryOutcome } from "./types.ts"

function timeout(): TerminalQueryOutcome {
  return { match: null, reason: "timeout", raw: "", rawBase64: "" }
}

/**
 * A terminal that answers DECRQSS `$ q m` with `reply` (the SGR parameter list it reports active),
 * or stays silent when `reply` is null. Capture is installed, so a probe that did not query would
 * land on the ungraded pixel path and could not decide.
 */
function sgrReadbackContext(reply: string | null | readonly (string | null)[]) {
  const queries: string[] = []
  const writes: string[] = []
  const writesAtQuery: string[] = []
  const ctx = {
    rows: 24,
    cols: 80,
    capture: async ({ role, label }: { role: string; label: string }) => ({
      role,
      label,
      capturedAt: 1,
      ref: `frame-${role}`,
    }),
    write: (bytes: string) => writes.push(bytes),
    queryCursorPosition: async () => ({ row: 1, col: 2 }),
    measureRenderedWidth: async () => null,
    query: async () => null,
    queryWithSentinel: async () => null,
    queryOutcome: async () => timeout(),
    async queryWithSentinelOutcome(sequence: string) {
      if (sequence !== "\x1bP$qm\x1b\\") return timeout()
      queries.push(sequence)
      writesAtQuery.push(writes.join(""))
      const payload = typeof reply === "string" || reply === null ? reply : reply[queries.length - 1]
      if (payload === undefined) throw new Error("Unexpected extra SGR readback")
      if (payload === null) return timeout()
      const raw = `\x1bP1$r${payload}m\x1b\\`
      return { match: [raw, payload], reason: "reply", raw, rawBase64: Buffer.from(raw).toString("base64") }
    },
    queryMode: async () => null,
  } as unknown as TermContext
  return { ctx, queries, writes, writesAtQuery }
}

const RESET_SETUP: Readonly<Record<string, string>> = {
  "sgr.reset": "1;3;4",
  "sgr.selective-reset.bold": "1;2;3",
  "sgr.selective-reset.underline": "1;4",
  "sgr.selective-reset.italic": "1;3",
  "sgr.selective-reset.inverse": "1;7",
  "sgr.fg.default": "31",
  "sgr.bg.default": "42",
  "sgr.underline-color-reset": "4;58;2;255;0;128",
  "reset.sgr": "1;3;7",
}

/** Existing final-state cases now supply independently qualified baseline and setup responses. */
function qualifiedSgrReadbackContext(id: string, reply: string | null) {
  const setup = RESET_SETUP[id]
  return sgrReadbackContext(setup !== undefined && reply !== null ? ["0", setup, reply] : reply)
}

function sgrTerm(id: string): (ctx: TermContext) => Promise<ProbeCallbackResult> {
  const probe = [...sgrProbes, ...resetProbes].find((value) => value.id === id)
  if (!probe?.term) throw new Error(`missing term callback for ${id}`)
  return probe.term
}

/** Each sgr probe's DECRQSS reply, and the decision the probe must reach from it. */
const DECIDED: ReadonlyArray<readonly [id: string, reply: string]> = [
  ["sgr.bold", "0;22;1"],
  ["sgr.faint", "0;2"],
  ["sgr.italic", "0;3"],
  ["sgr.underline.single", "0;4"],
  ["sgr.underline.double", "0;21"],
  ["sgr.underline.curly", "0;4:3"],
  ["sgr.underline.dotted", "0;4:4"],
  ["sgr.underline.dashed", "0;4:5"],
  ["sgr.blink", "0;5"],
  ["sgr.inverse", "0;7"],
  ["sgr.hidden", "0;8"],
  ["sgr.strikethrough", "0;9"],
  ["sgr.overline", "0;53"],
  ["sgr.underline.color", "0;4;58;2;255;0;128"],
  ["sgr.underline-color-rgb", "0;4;58;2;255;0;128"],
  ["sgr.underline-color-indexed", "0;4;58;5;5"],
  ["sgr.underline-color-reset", "0;4"],
  ["sgr.fg.standard", "0;31"],
  ["sgr.bg.standard", "0;41"],
  ["sgr.fg.bright", "0;91"],
  ["sgr.bg.bright", "0;101"],
  ["sgr.fg.default", "0;39"],
  ["sgr.bg.default", "0;49"],
  ["sgr.fg.256", "0;38;5;67"],
  ["sgr.bg.256", "0;48;5;67"],
  ["sgr.fg.truecolor", "0;38;2;255;128;0"],
  ["sgr.bg.truecolor", "0;48;2;0;255;128"],
  ["sgr.selective-reset.bold", "0;22;3"],
  ["sgr.selective-reset.underline", "0;1"],
  ["sgr.selective-reset.italic", "0;1"],
  ["sgr.selective-reset.inverse", "0;1"],
  ["sgr.reset", ""],
]

test("every sgr probe decides from the terminal's own DECRQSS report", async () => {
  for (const [id, reply] of DECIDED) {
    const { ctx, queries } = qualifiedSgrReadbackContext(id, reply)
    const result = await sgrTerm(id)(ctx)
    expect(queries, `${id} must query DECRQSS`).toContain("\x1bP$qm\x1b\\")
    expect(result.observation, `${id} with reply ${JSON.stringify(reply)}`).toMatchObject({
      outcome: "supported",
      evidence: "query",
    })
  }
})

// Reset support requires a measured transition. The existing final-state cases above accepted a
// constant responder that ignored setup entirely; exercise every reset binding through its callback
// and the production recorder, where those false positives became stored Supported results.
test.each([
  ["sgr.reset", "0"],
  ["sgr.selective-reset.bold", "0;3"],
  ["sgr.selective-reset.underline", "0;1"],
  ["sgr.selective-reset.italic", "0;1"],
  ["sgr.selective-reset.inverse", "0;1"],
  ["sgr.fg.default", "0"],
  ["sgr.bg.default", "0"],
  ["sgr.underline-color-reset", "0;4"],
  ["reset.sgr", "0"],
] as const)("%s cannot qualify a reset from constant final-state reply %s", async (id, reply) => {
  const { ctx } = sgrReadbackContext(reply)
  const result = await sgrTerm(id)(ctx)
  expect(result.observation).toMatchObject({ outcome: "inconclusive", evidence: "query" })
  expect(result.pass).toBe(false)
  expect(result.assertions ?? []).toHaveLength(0)
  expect(result.response).toContain(reply)
  const recorded = recordExecutedCapability({
    featureId: id,
    attempt: { scope: "probe", startedAt: "2026-10-21T11:15:00.000Z" },
    observation: { ...result.observation!, featureId: id, rawReplyRef: id },
    assertions: [],
    checks: result.checks,
    criterionBranch: result.criterionBranch,
  })
  expect(recorded.status).toBe("test-failure")
  expect(recorded.checks).toContainEqual(expect.objectContaining({ status: "test-failure", rawReplyRef: id }))
})

test.each([
  ["sgr.faint", "0"],
  ["sgr.underline.curly", "0;4"],
  ["sgr.fg.truecolor", "0"],
  ["sgr.reset", "0;1;3;4"],
  ["sgr.selective-reset.bold", "0"],
  ["sgr.underline-color-reset", "0"],
] as const)("%s is unsupported when DECRQSS reports %s", async (id, reply) => {
  const { ctx } = qualifiedSgrReadbackContext(id, reply)
  const result = await sgrTerm(id)(ctx)
  expect(result.observation).toMatchObject({ outcome: "unsupported", evidence: "query" })
})

// The reset/default probes are falsified by the SETUP code still being active, which is a positive
// report rather than an omission: SGR 39/49 clear the color rather than setting a code of their own.
test.each([
  ["sgr.fg.default", "0;31"],
  ["sgr.bg.default", "0;42"],
  ["sgr.selective-reset.bold", "0;1;2;3"],
  ["sgr.selective-reset.underline", "0;1;4"],
  ["sgr.underline-color-reset", "0;4;58;2;255;0;128"],
] as const)("%s is unsupported when DECRQSS still reports the setup it should have cleared (%s)", async (id, reply) => {
  const { ctx } = qualifiedSgrReadbackContext(id, reply)
  const result = await sgrTerm(id)(ctx)
  expect(result.observation).toMatchObject({ outcome: "unsupported", evidence: "query" })
})

// Measured in-tree replies that a per-code match would misgrade.
test.each([
  ["sgr.underline.double", "0;4:2"],
  ["sgr.fg.default", "0"],
  ["sgr.bg.default", "0"],
] as const)("%s is supported on the measured %s reply", async (id, reply) => {
  const { ctx } = qualifiedSgrReadbackContext(id, reply)
  const result = await sgrTerm(id)(ctx)
  expect(result.observation).toMatchObject({ outcome: "supported", evidence: "query" })
})

test.each(DECIDED.map(([id]) => id))("%s stays inconclusive, never negative, when DECRQSS is silent", async (id) => {
  const { ctx } = sgrReadbackContext(null)
  const result = await sgrTerm(id)(ctx)
  expect(result.pass).toBe(false)
  expect(result.observation?.outcome).not.toBe("unsupported")
})

// A reported selector alone cannot establish the requested color mode or value. Color operands
// also belong to that parameter: an RGB component of 1 is not an independent bold attribute.
test.each([
  ["sgr.fg.256", "0;38;5;68", "unsupported"],
  ["sgr.bg.256", "0;48;5;68", "unsupported"],
  ["sgr.fg.truecolor", "0;38;2;255;128;1", "unsupported"],
  ["sgr.bg.truecolor", "0;48;2;0;255;129", "unsupported"],
  ["sgr.underline.color", "0;4;58;2;255;0;129", "unsupported"],
  ["sgr.underline-color-rgb", "0;4;58;2;255;0;129", "unsupported"],
  ["sgr.underline-color-indexed", "0;4;58;5;6", "unsupported"],
  ["sgr.fg.truecolor", "0;38", "inconclusive"],
  ["sgr.bg.truecolor", "0;48;2;0;255", "inconclusive"],
  ["sgr.underline-color-rgb", "0;4;58:2::255:0", "inconclusive"],
  ["sgr.fg.truecolor", "0;38;5;67", "inconclusive"],
  ["sgr.fg.256", "0;38;2;95;135;175", "inconclusive"],
  ["sgr.fg.truecolor", "0;38:2::255:128:0", "supported"],
  ["sgr.bg.truecolor", "0;48:2:0:0:255:128", "supported"],
  ["sgr.underline.color", "0;4;58:2:255:0:128", "supported"],
  ["sgr.underline-color-indexed", "0;4;58:5:5", "supported"],
  ["sgr.bold", "0;38;2;255;1;5", "unsupported"],
  ["sgr.selective-reset.bold", "0;3;38;2;255;1;5", "supported"],
  ["sgr.fg.default", "0;38;5;31", "unsupported"],
  ["sgr.bg.default", "0;48;5;42", "unsupported"],
  ["sgr.fg.default", "0;34", "unsupported"],
  ["sgr.bg.default", "0;104", "unsupported"],
  ["sgr.fg.default", "0;48;5;31", "supported"],
  ["sgr.bg.default", "0;38;2;255;42;0", "supported"],
  ["sgr.underline.curly", "0;4:3:999", "inconclusive"],
  ["sgr.underline.curly", "0;4:0:3", "inconclusive"],
  ["sgr.underline.curly", "0;4:6", "inconclusive"],
  ["sgr.underline.single", "0;4:3:999", "inconclusive"],
  ["sgr.underline.single", "0;4:0:3", "inconclusive"],
  ["sgr.underline.single", "0;4:6", "inconclusive"],
  ["sgr.underline.single", "0;4:0", "unsupported"],
  ["sgr.selective-reset.underline", "0;1;4:0", "supported"],
  ["sgr.selective-reset.underline", "0;1;4:6", "inconclusive"],
] as const)("%s with DECRQSS %s is %s", async (id, reply, outcome) => {
  const { ctx } = qualifiedSgrReadbackContext(id, reply)
  const result = await sgrTerm(id)(ctx)
  expect(result.observation).toMatchObject({ outcome, evidence: "query" })
  expect(result.pass).toBe(outcome === "supported")
  expect(result.response).toBe(
    JSON.stringify({ sgr: reply, ...(RESET_SETUP[id] && { baseline: "0", setup: RESET_SETUP[id] }) }),
  )
  if (outcome === "inconclusive") {
    expect(result.observation?.note).toBeTruthy()
    expect(result.assertions ?? []).toHaveLength(0)
    // An attempted malformed reply must remain unsuccessful at the stored-result boundary too.
    const recorded = recordExecutedCapability({
      featureId: id,
      attempt: { scope: "probe", startedAt: "2026-10-21T10:50:00.000Z" },
      observation: { ...result.observation!, featureId: id, rawReplyRef: id },
      assertions: [],
      checks: result.checks,
      criterionBranch: result.criterionBranch,
    })
    expect(recorded.status).toBe("test-failure")
    expect(recorded.checks).toContainEqual(expect.objectContaining({ status: "test-failure", rawReplyRef: id }))
  }
})

// A scripted response alone would miss sending reset before reading setup. Check the bytes that
// actually precede each protocol query, while allowing the writer to batch bytes differently.
test("a reset reads baseline and setup before sending the reset, and retains every phase", async () => {
  const { ctx, writes, writesAtQuery } = qualifiedSgrReadbackContext("sgr.selective-reset.bold", "0;3")
  const result = await sgrTerm("sgr.selective-reset.bold")(ctx)
  expect(result.observation?.outcome).toBe("supported")
  expect(writesAtQuery).toEqual(["\x1b[0m", "\x1b[0m\x1b[1;2;3m", "\x1b[0m\x1b[1;2;3m\x1b[22m"])
  expect(JSON.parse(result.response!)).toEqual({ baseline: "0", setup: "1;2;3", sgr: "0;3" })
  expect(writes.at(-1)).toBe("\x1b[0m")
})

test("an explicit no-underline report qualifies a neutral baseline and a cleared reset", async () => {
  const { ctx } = sgrReadbackContext(["0;4:0", "1;4", "1;4:0"])
  const result = await sgrTerm("sgr.selective-reset.underline")(ctx)
  expect(result.observation).toMatchObject({ outcome: "supported", evidence: "query" })
  expect(JSON.parse(result.response!)).toEqual({ baseline: "0;4:0", setup: "1;4", sgr: "1;4:0" })
})

test.each([
  ["sgr.selective-reset.bold", ["0", "1;3"], "setup"],
  ["sgr.selective-reset.underline", ["0;4:6"], "baseline"],
  ["sgr.selective-reset.underline", ["0", "1;4:6"], "setup"],
  ["sgr.selective-reset.underline", ["0", "1;4:0", "1"], "setup"],
  ["sgr.reset", ["0", "1;3;4:0", "0"], "setup"],
  ["sgr.underline-color-reset", ["0", "4;58;2;255;0"], "setup"],
  ["sgr.underline-color-reset", ["0", "4;58;2;255;0;129"], "setup"],
] as const)("%s retains an unqualified %s response without a reset verdict (%s)", async (id, replies, phase) => {
  const { ctx, queries, writes } = sgrReadbackContext(replies)
  let captures = 0
  ctx.capture = async () => {
    captures++
    throw new Error("An observed invalid prerequisite must not enter capture fallback")
  }
  const result = await sgrTerm(id)(ctx)
  expect(result.observation).toMatchObject({ outcome: "inconclusive", evidence: "query" })
  expect(result.assertions ?? []).toHaveLength(0)
  expect(result.observation?.note).toContain(`${phase} prerequisite`)
  const phaseIndex = phase === "baseline" ? 0 : 1
  expect(JSON.parse(result.response!)).toMatchObject({ phase, [phase]: replies[phaseIndex] })
  expect(queries).toHaveLength(phaseIndex + 1)
  expect(captures).toBe(0)
  expect(writes.at(-1)).toBe("\x1b[0m")
})

// Missing queries retain the existing independent fallback. A status-zero DECRQSS response is an
// unrecognized query (the sentinel ends it), never evidence that the reset itself is unsupported.
test.each(["baseline", "setup", "final"] as const)(
  "missing or status-zero %s readback remains inconclusive",
  async (phase) => {
    const stage = ["baseline", "setup", "final"].indexOf(phase)
    for (const kind of ["missing", "status-zero"] as const) {
      const { ctx, writes } = sgrReadbackContext(["0", "1;2;3", "0;3"])
      ctx.capture = undefined
      const read = ctx.queryWithSentinelOutcome
      let queries = 0
      ctx.queryWithSentinelOutcome = async (...args) => {
        if (queries++ !== stage) return read(...args)
        if (kind === "missing") return timeout()
        const raw = "\x1bP0$r\x1b\\"
        return { match: null, reason: "sentinel", raw, rawBase64: Buffer.from(raw).toString("base64") }
      }
      const result = await sgrTerm("sgr.selective-reset.bold")(ctx)
      expect(result.pass, kind).toBe(false)
      expect(result.observation?.outcome, kind).toBe("inconclusive")
      expect(result.assertions ?? [], kind).toHaveLength(0)
      expect(queries, kind).toBe(stage + 1)
      expect(writes.at(-1), kind).toBe("\x1b[0m")
    }
  },
)

test.each(["baseline", "setup", "final"] as const)("a throwing %s readback propagates with cleanup", async (phase) => {
  const stage = ["baseline", "setup", "final"].indexOf(phase)
  const { ctx, writes } = sgrReadbackContext(["0", "1;2;3", "0;3"])
  const read = ctx.queryWithSentinelOutcome
  let queries = 0
  ctx.queryWithSentinelOutcome = async (...args) => {
    if (queries++ === stage) throw new Error(`${phase} query failed`)
    return read(...args)
  }
  await expect(sgrTerm("sgr.selective-reset.bold")(ctx)).rejects.toThrow(`${phase} query failed`)
  expect(writes.at(-1)).toBe("\x1b[0m")
})
