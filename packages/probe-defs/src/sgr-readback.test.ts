/**
 * @failure SGR probes on a real terminal fall to pixel capture that nothing grades, so sgr.* stays inconclusive despite the terminal answering DECRQSS.
 * @level l1
 * @consumer Linux hosted app-mode decisions for the sgr.* group.
 * @testonly none
 */
import { expect, test } from "vitest"
import { sgrProbes } from "./sgr.ts"
import type { ProbeResult, TermContext, TerminalQueryOutcome } from "./types.ts"

function timeout(): TerminalQueryOutcome {
  return { match: null, reason: "timeout", raw: "", rawBase64: "" }
}

/**
 * A terminal that answers DECRQSS `$ q m` with `reply` (the SGR parameter list it reports active),
 * or stays silent when `reply` is null. Capture is installed, so a probe that did not query would
 * land on the ungraded pixel path and could not decide.
 */
function sgrReadbackContext(reply: string | null): { ctx: TermContext; queries: string[] } {
  const queries: string[] = []
  const ctx = {
    rows: 24,
    cols: 80,
    capture: async ({ role, label }: { role: string; label: string }) => ({
      role,
      label,
      capturedAt: 1,
      ref: `frame-${role}`,
    }),
    write: () => {},
    queryCursorPosition: async () => ({ row: 1, col: 2 }),
    measureRenderedWidth: async () => null,
    query: async () => null,
    queryWithSentinel: async () => null,
    queryOutcome: async () => timeout(),
    async queryWithSentinelOutcome(sequence: string) {
      queries.push(sequence)
      if (reply === null) return timeout()
      return { match: [`\x1bP1$r${reply}m\x1b\\`, reply], reason: "reply", raw: "", rawBase64: "" }
    },
    queryMode: async () => null,
  } as unknown as TermContext
  return { ctx, queries }
}

function sgrTerm(id: string): (ctx: TermContext) => Promise<ProbeResult> {
  const probe = sgrProbes.find((value) => value.id === id)
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
  ["sgr.underline.color", "0;4;58"],
  ["sgr.underline-color-rgb", "0;4;58"],
  ["sgr.underline-color-indexed", "0;4;58"],
  ["sgr.underline-color-reset", "0;4"],
  ["sgr.fg.standard", "0;31"],
  ["sgr.bg.standard", "0;41"],
  ["sgr.fg.bright", "0;91"],
  ["sgr.bg.bright", "0;101"],
  ["sgr.fg.default", "0;39"],
  ["sgr.bg.default", "0;49"],
  ["sgr.fg.256", "0;38"],
  ["sgr.bg.256", "0;48"],
  ["sgr.fg.truecolor", "0;38"],
  ["sgr.bg.truecolor", "0;48"],
  ["sgr.selective-reset.bold", "0;22;3"],
  ["sgr.selective-reset.underline", "0;1"],
  ["sgr.selective-reset.italic", "0;1"],
  ["sgr.selective-reset.inverse", "0;1"],
  ["sgr.reset", ""],
]

test("every sgr probe decides from the terminal's own DECRQSS report", async () => {
  for (const [id, reply] of DECIDED) {
    const { ctx, queries } = sgrReadbackContext(reply)
    const result = await sgrTerm(id)(ctx)
    expect(queries, `${id} must query DECRQSS`).toContain("\x1bP$qm\x1b\\")
    expect(result.observation, `${id} with reply ${JSON.stringify(reply)}`).toMatchObject({
      outcome: "supported",
      evidence: "query",
    })
  }
})

test.each([
  ["sgr.faint", "0"],
  ["sgr.underline.curly", "0;4"],
  ["sgr.fg.truecolor", "0"],
  ["sgr.reset", "0;1;3;4"],
] as const)("%s is unsupported when DECRQSS reports %s", async (id, reply) => {
  const { ctx } = sgrReadbackContext(reply)
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
  ["sgr.underline-color-reset", "0;4;58"],
] as const)("%s is unsupported when DECRQSS still reports the setup it should have cleared (%s)", async (id, reply) => {
  const { ctx } = sgrReadbackContext(reply)
  const result = await sgrTerm(id)(ctx)
  expect(result.observation).toMatchObject({ outcome: "unsupported", evidence: "query" })
})

// Measured in-tree replies that a per-code match would misgrade.
test.each([
  ["sgr.underline.double", "0;4:2"],
  ["sgr.fg.default", "0"],
  ["sgr.bg.default", "0"],
] as const)("%s is supported on the measured %s reply", async (id, reply) => {
  const { ctx } = sgrReadbackContext(reply)
  const result = await sgrTerm(id)(ctx)
  expect(result.observation).toMatchObject({ outcome: "supported", evidence: "query" })
})

test.each(DECIDED.map(([id]) => id))("%s stays inconclusive, never negative, when DECRQSS is silent", async (id) => {
  const { ctx } = sgrReadbackContext(null)
  const result = await sgrTerm(id)(ctx)
  expect(result.pass).toBe(false)
  expect(result.observation?.outcome).not.toBe("unsupported")
})
