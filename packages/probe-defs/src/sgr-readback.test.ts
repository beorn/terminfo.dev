/**
 * @failure SGR probes on a real terminal fall to pixel capture that nothing grades, so sgr.* stays inconclusive despite the terminal answering DECRQSS.
 * @level l1
 * @consumer Linux hosted app-mode decisions for the sgr.* group.
 * @testonly none
 */
import { expect, test, vi } from "vitest"
import { NO_SAME_PATH_CONTROL, recordExecutedProbe, sgrReadbackDecision } from "./helpers.ts"
import { COLOUR_CAPTURE } from "./sgr-colour-capture.ts"
import { RESET_FAMILY_CAPTURE } from "./reset-family-capture.ts"
import { resetProbes } from "./reset.ts"
import { extensionsProbes } from "./extensions.ts"
import { finalizeVisualResult, sgrProbes } from "./sgr.ts"
import { inertLibProbeSource } from "./testing/group-harness.ts"
import type { ObservationFrame, ProbeCallbackResult, TermProbeSource, TerminalQueryOutcome } from "./types.ts"

function timeout(): TerminalQueryOutcome {
  return { match: null, reason: "timeout", raw: "", rawBase64: "" }
}

/**
 * A terminal that answers DECRQSS `$ q m` with `reply` (the SGR parameter list it reports active),
 * or stays silent when `reply` is null. Query-only cases have no capture; capture routing is
 * checked separately against the same callback and the owning pixel fixtures.
 */
function sgrReadbackSource(reply: string | null | readonly (string | null)[], capture = false) {
  const queries: string[] = []
  const writes: string[] = []
  const writesAtQuery: string[] = []
  const ctx = {
    rows: 24,
    cols: 80,
    capture: capture
      ? async ({ role, label }: { role: string; label: string }) => ({
          role,
          label,
          capturedAt: 1,
          ref: `frame-${role}`,
        })
      : undefined,
    write: (bytes: string) => writes.push(bytes),
    queryCursorPosition: async () => ({ row: 1, col: 2 }),
    measureRenderedWidth: async () => ({ kind: "no-reply", step: "sample" }) as const,
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
  } as unknown as TermProbeSource
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
function qualifiedSgrReadbackSource(id: string, reply: string | null) {
  const setup = RESET_SETUP[id]
  return sgrReadbackSource(setup !== undefined && reply !== null ? ["0", setup, reply] : reply)
}

function sgrTerm(id: string): (ctx: TermProbeSource) => Promise<ProbeCallbackResult> {
  const probe = [...sgrProbes, ...resetProbes, ...extensionsProbes].find((value) => value.id === id)
  if (!probe?.term) throw new Error(`missing term callback for ${id}`)
  return probe.term
}

// #33157: checking only normalized DECRQSS replies missed that the sent bytes still used semicolons.
// Every existing underline row must send colon-form colour, including its library and capture setup.
test.each([
  ["sgr.underline.color", "58:2::255:0:128", "colon"],
  ["sgr.underline-color-rgb", "58:2::255:0:128", "colon"],
  ["sgr.underline-color-indexed", "58:5:1", "colon"],
  ["sgr.underline-color-reset", "58:2::255:0:128", "colon"],
  ["sgr.fg.256", "38;5;67", "semicolon"],
  ["sgr.bg.256", "48;5;67", "semicolon"],
  ["sgr.fg.truecolor", "38;2;255;128;0", "semicolon"],
  ["sgr.bg.truecolor", "48;2;0;255;128", "semicolon"],
  ["extensions.truecolor", "38;2;255;128;0", "semicolon"],
])("%s sends and names the selected colour form in every arm", async (id, parameters, form) => {
  const definition = [...sgrProbes, ...extensionsProbes].find((entry) => entry.id === id)
  if (!definition?.lib) throw new Error(`${id}: missing library arm`)
  const fed: string[] = []
  const result = definition.lib({ ...inertLibProbeSource(), feed: (bytes) => fed.push(bytes) })
  const notes = [
    result.note,
    result.observation?.note,
    result.notTested?.noObservable,
    ...(result.tests ?? []).map((test) => test.reason),
  ].filter((note): note is string => note !== undefined)
  expect(notes.length, "library must explain its result").toBeGreaterThan(0)
  for (const note of notes) {
    expect(note).toContain(parameters)
    expect(note).toContain(`(${form} form)`)
  }
  expect(fed.join(""), "library target").toContain(`\x1b[${parameters}m`)
  expect(fed.join(""), "library must not send another colour encoding").not.toContain("\x1b[58;")
  const libraryRecorded = finalizeVisualResult(
    recordExecutedProbe({
      featureId: id,
      attempt: paintAttempt,
      observation: result.observation && { ...result.observation, featureId: id, rawReplyRef: id },
      coverage: result.notTested && { ...result.notTested, featureId: id, rawReplyRef: id },
      assertions: (result.assertions ?? []).map((assertion) => ({ featureId: id, ...assertion })),
      tests: result.tests,
      criterionBranch: result.criterionBranch,
      rawReplyRef: id,
    }),
    { kind: "lib" },
    [],
  )
  // The callback already names the bytes it fed. A differently joined encoding sentence must
  // not turn that retained observation into the recorder-failure disclaimer.
  expect(libraryRecorded.reason).not.toContain("declared, not confirmed sent")
  const { ctx, writes } = sgrReadbackSource(id === "sgr.underline-color-reset" ? ["0", "4;58:2::255:0:128", "4"] : null)
  const terminal = await sgrTerm(id)(ctx)
  expect(writes.join(""), "terminal target or reset setup").toContain(`\x1b[${parameters}m`)
  expect(writes.join(""), "terminal must not send another colour encoding").not.toContain("\x1b[58;")
  if (id === "sgr.underline-color-reset") {
    expect(RESET_FAMILY_CAPTURE[id]?.seed, "capture setup").toContain(`\x1b[${parameters}m`)
    expect(RESET_FAMILY_CAPTURE[id]?.edit, "reset stays SGR 59").toContain("\x1b[59m")
  } else if (id !== "sgr.underline-color-indexed") {
    expect(COLOUR_CAPTURE[id]?.edit, "capture target").toContain(`\x1b[${parameters}m`)
  }
  const terminalNotes = [
    terminal.note,
    terminal.observation?.note,
    terminal.notTested?.noObservable,
    ...(terminal.tests ?? []).map((test) => test.reason),
  ].filter((note): note is string => note !== undefined)
  expect(terminalNotes.length, "terminal must explain its result").toBeGreaterThan(0)
  for (const note of terminalNotes) {
    expect(note).toContain(parameters)
    expect(note).toContain(`(${form} form)`)
  }
  const recorded = recordTerm(id, terminal)
  expect(recorded.reason, "finalizer must retain the attempted encoding").toContain(parameters)
  expect(recorded.reason).toContain(`(${form} form)`)
  for (const [rows, cols, capture] of [
    [1, 2, true],
    ...(id === "sgr.underline.color" || id === "sgr.underline-color-rgb" ? [[0, 1, false] as const] : []),
  ] as const) {
    const small = sgrReadbackSource(null, capture)
    small.ctx.rows = rows
    small.ctx.cols = cols
    const refused = await sgrTerm(id)(small.ctx)
    expect(small.writes, "preflight refuses before feature/query bytes").toEqual([])
    expect(refused.tests?.[0]?.status).toBe("probe-todo")
    expect(refused.tests?.[0]?.reason).toContain(parameters)
    expect(refused.tests?.[0]?.reason).toContain(`(${form} form)`)
    expect(refused.tests?.[0]?.reason).toContain("not sent")
  }
  const expectedCol = id === "sgr.underline-color-reset" ? 3 : 2
  for (const col of [null, expectedCol, expectedCol + 1]) {
    const fallback = sgrReadbackSource(null)
    fallback.ctx.queryCursorPosition = async () => (col === null ? null : { row: 1, col })
    const result = await sgrTerm(id)(fallback.ctx)
    expect(result.observation).toBeUndefined()
    for (const text of [result.note, ...(result.tests ?? []).map((test) => test.reason)]) {
      expect(text).toContain(parameters)
      expect(text).toContain(`(${form} form)`)
    }
    expect(result.tests?.[0]?.status).toBe(
      id === "extensions.truecolor" || col === expectedCol ? "probe-todo" : "probe-invalid",
    )
  }
})

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
    const { ctx, queries } = qualifiedSgrReadbackSource(id, reply)
    const result = await sgrTerm(id)(ctx)
    expect(queries, `${id} must query DECRQSS`).toContain("\x1bP$qm\x1b\\")
    expect(result.observation, `${id} with reply ${JSON.stringify(reply)}`).toMatchObject({
      outcome: "supported",
      assertionType: "query_reply",
    })
  }
})

// #33146 (@cto d2f24294, b3d7680f): pixels decide the indexed underline colour; DECRQSS decides nothing
// here, so no report, matching or not, in either encoding, becomes a verdict or is even asked.
test.each(["0;4;58;5;5", "0;4;58:5:5", "0;4;58;5;6", "0;4"])(
  "sgr.underline-color-indexed never decides from DECRQSS %s",
  async (reply) => {
    const { ctx, queries } = sgrReadbackSource(reply)
    const result = await sgrTerm("sgr.underline-color-indexed")(ctx)
    expect(queries).toHaveLength(0)
    expect(result.observation).toBeUndefined()
    expect(result.pass).toBe(false)
    expect(result.tests).toMatchObject([
      {
        id: "criterion",
        status: "probe-todo",
        reason: "SGR 58:5:1 (colon form); Cursor advance does not verify SGR styling",
      },
    ])
  },
)

// With no capture adapter, attribute rows retain their existing DECRQSS decisions.
const PLAIN_STYLE_REPLIES = DECIDED.filter(
  ([id]) => id !== "sgr.blink" && !(id in COLOUR_CAPTURE) && !(id in RESET_FAMILY_CAPTURE),
)

test.each([
  ...PLAIN_STYLE_REPLIES.map(([id, reply]) => [id, reply, "supported"] as const),
  ["sgr.bold", "0", "probe-todo"] as const,
])("%s retains DECRQSS %s without an owned pixel oracle (%s)", async (id, reply, status) => {
  const { ctx, queries } = sgrReadbackSource(reply)
  const result = await sgrTerm(id)(ctx)
  if (status === "supported") {
    expect(result.observation).toMatchObject({ assertionType: "query_reply", outcome: "supported" })
  } else {
    expect(result.notTested).toEqual({ reason: "no-semantic-observable", noObservable: NO_SAME_PATH_CONTROL })
    expect(result.observation).toBeUndefined()
  }
  expect(result.response).toBe(JSON.stringify({ sgr: reply }))
  expect(queries).toHaveLength(1)
})

// Reset support requires a measured transition. The existing final-state cases above accepted a
// constant responder that ignored setup entirely; exercise every reset binding through its callback
// and the production recorder, where those false positives became stored Supported results.
test.each([
  ["sgr.reset", "0", "probe-todo"],
  ["sgr.selective-reset.bold", "0;3", "probe-invalid"],
  ["sgr.selective-reset.underline", "0;1", "probe-invalid"],
  ["sgr.selective-reset.italic", "0;1", "probe-invalid"],
  ["sgr.selective-reset.inverse", "0;1", "probe-invalid"],
  ["sgr.fg.default", "0", "probe-todo"],
  ["sgr.bg.default", "0", "probe-todo"],
  ["sgr.underline-color-reset", "0;4", "probe-invalid"],
  ["reset.sgr", "0", "probe-todo"],
] as const)("%s cannot qualify a reset from constant final-state reply %s (%s)", async (id, reply, status) => {
  const { ctx } = sgrReadbackSource(reply)
  // This contract is query-only. Qualified capture has its own independently witnessed controls.
  ctx.capture = undefined
  const result = await sgrTerm(id)(ctx)
  if (status === "probe-todo") {
    expect(result.notTested?.reason).toBe("no-semantic-observable")
    expect(result.observation).toBeUndefined()
  } else {
    expect(result.observation).toMatchObject({ outcome: "inconclusive", assertionType: "query_reply" })
  }
  expect(result.pass).toBe(false)
  expect(result.assertions ?? []).toHaveLength(0)
  expect(result.response).toContain(reply)
  const recorded = recordExecutedProbe({
    featureId: id,
    attempt: { scope: "probe", startedAt: "2026-10-21T11:15:00.000Z" },
    observation: result.observation && { ...result.observation, featureId: id, rawReplyRef: id },
    coverage: result.notTested && { ...result.notTested, featureId: id, rawReplyRef: id },
    assertions: [],
    tests: result.tests,
    criterionBranch: result.criterionBranch,
  })
  expect(recorded.status).toBe(status)
  expect(recorded.tests).toContainEqual(expect.objectContaining({ status, rawReplyRef: id }))
})

test.each([
  ["sgr.reset", "0;1;3;4"],
  ["sgr.selective-reset.bold", "0"],
  ["sgr.underline-color-reset", "0"],
] as const)("%s is unsupported when DECRQSS reports %s", async (id, reply) => {
  const { ctx } = qualifiedSgrReadbackSource(id, reply)
  const result = await sgrTerm(id)(ctx)
  expect(result.observation).toMatchObject({ outcome: "unsupported", assertionType: "query_reply" })
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
  const { ctx } = qualifiedSgrReadbackSource(id, reply)
  const result = await sgrTerm(id)(ctx)
  expect(result.observation).toMatchObject({ outcome: "unsupported", assertionType: "query_reply" })
})

// Measured in-tree replies that a per-code match would misgrade.
test.each([
  ["sgr.underline.double", "0;4:2"],
  ["sgr.fg.default", "0"],
  ["sgr.bg.default", "0"],
] as const)("%s is supported on the measured %s reply", async (id, reply) => {
  const { ctx } = qualifiedSgrReadbackSource(id, reply)
  const result = await sgrTerm(id)(ctx)
  expect(result.observation).toMatchObject({ outcome: "supported", assertionType: "query_reply" })
})

test.each(DECIDED.map(([id]) => id))("%s stays inconclusive, never negative, when DECRQSS is silent", async (id) => {
  const { ctx } = sgrReadbackSource(null, true)
  // sgr.blink falls to its temporal capture schedule; fake timers keep its requested span out of
  // this test's wall clock, exactly as the blink frame suite does.
  if (id === "sgr.blink") vi.useFakeTimers({ toFake: ["setTimeout", "Date"] })
  try {
    const pending = sgrTerm(id)(ctx)
    if (id === "sgr.blink") await vi.runAllTimersAsync()
    const result = await pending
    expect(result.pass).toBe(false)
    expect(result.observation?.outcome).not.toBe("unsupported")
  } finally {
    if (id === "sgr.blink") vi.useRealTimers()
  }
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
  ["sgr.fg.truecolor", "0;38", "inconclusive"],
  ["sgr.bg.truecolor", "0;48;2;0;255", "inconclusive"],
  ["sgr.underline-color-rgb", "0;4;58:2::255:0", "inconclusive"],
  ["sgr.fg.truecolor", "0;38;5;67", "inconclusive"],
  ["sgr.fg.256", "0;38;2;95;135;175", "inconclusive"],
  ["sgr.fg.truecolor", "0;38:2::255:128:0", "supported"],
  ["sgr.bg.truecolor", "0;48:2:0:0:255:128", "supported"],
  ["sgr.underline.color", "0;4;58:2:255:0:128", "supported"],
  ["sgr.selective-reset.bold", "0;3;38;2;255;1;5", "supported"],
  ["sgr.fg.default", "0;38;5;31", "unsupported"],
  ["sgr.bg.default", "0;48;5;42", "unsupported"],
  ["sgr.fg.default", "0;34", "unsupported"],
  ["sgr.bg.default", "0;104", "unsupported"],
  ["sgr.fg.default", "0;48;5;31", "supported"],
  ["sgr.bg.default", "0;38;2;255;42;0", "supported"],
  ["sgr.underline.single", "0;4:3:999", "inconclusive"],
  ["sgr.underline.single", "0;4:0:3", "inconclusive"],
  ["sgr.underline.single", "0;4:6", "inconclusive"],
  ["sgr.underline.curly", "0;4:3:999", "inconclusive"],
  ["sgr.underline.curly", "0;4:0:3", "inconclusive"],
  ["sgr.underline.curly", "0;4:6", "inconclusive"],
  ["sgr.underline.dotted", "0;4:9", "inconclusive"],
  ["sgr.underline.dashed", "0;4:9", "inconclusive"],
  ["sgr.underline.dotted", "0;4:3:1", "inconclusive"],
  ["sgr.underline.dashed", "0;4:3:1", "inconclusive"],
  ["sgr.underline.single", "0;4:0", "unsupported"],
  ["sgr.selective-reset.underline", "0;1;4:0", "supported"],
  ["sgr.selective-reset.underline", "0;1;4:6", "inconclusive"],
] as const)("%s with DECRQSS %s is %s", async (id, reply, outcome) => {
  const { ctx } = qualifiedSgrReadbackSource(id, reply)
  let captures = 0
  if (outcome === "inconclusive") {
    ctx.capture = async () => {
      captures++
      throw new Error("A malformed SGR reply must not enter capture")
    }
  }
  const result = await sgrTerm(id)(ctx)
  expect(result.observation).toMatchObject({ outcome, assertionType: "query_reply" })
  expect(result.pass).toBe(outcome === "supported")
  expect(result.response).toBe(
    JSON.stringify({ sgr: reply, ...(RESET_SETUP[id] && { baseline: "0", setup: RESET_SETUP[id] }) }),
  )
  if (outcome === "inconclusive") {
    expect(captures).toBe(0)
    expect(result.observation?.note).toBeTruthy()
    expect(result.assertions ?? []).toHaveLength(0)
    // An attempted malformed reply must remain unsuccessful at the stored-result boundary too.
    const recorded = recordExecutedProbe({
      featureId: id,
      attempt: { scope: "probe", startedAt: "2026-10-21T10:50:00.000Z" },
      observation: { ...result.observation!, featureId: id, rawReplyRef: id },
      assertions: [],
      tests: result.tests,
      criterionBranch: result.criterionBranch,
    })
    expect(recorded.status).toBe("probe-invalid")
    expect(recorded.tests).toContainEqual(expect.objectContaining({ status: "probe-invalid", rawReplyRef: id }))
  }
})

// Retained Ghostty/Kitty/iTerm2 replies omit overline, hidden or underline color. Without a
// same-run control, an omitted attribute cannot establish a negative. Style claims likewise need
// their own valid token; malformed replies belong to the failure table above, not coverage.
test.each([
  ["sgr.faint", "0"],
  ["sgr.fg.truecolor", "0"],
  ["sgr.bold", "0;38;2;255;1;5"],
  ["sgr.overline", "0"],
  ["sgr.overline", ""],
  ["sgr.hidden", "0"],
  ["sgr.underline.color", "0;4"],
  ["sgr.underline-color-rgb", "0;4"],
  ["sgr.underline.curly", "0;4"],
  ["sgr.underline.dotted", "0;4"],
  ["sgr.underline.dotted", "0;4:1"],
  ["sgr.underline.dotted", "0;4:2"],
  ["sgr.underline.dotted", "0;4:0"],
  ["sgr.underline.dotted", "0"],
  ["sgr.underline.dotted", "0;4:"],
  ["sgr.underline.dashed", "0;4:"],
  ["sgr.underline.dashed", "0;4"],
  ["sgr.underline.double", "0;4"],
  ["sgr.underline.double", "0"],
] as const)("%s with DECRQSS %s is a PROBE TODO, never a negative", async (id, reply) => {
  const { ctx } = qualifiedSgrReadbackSource(id, reply)
  const result = await sgrTerm(id)(ctx)
  expect(result.notTested?.reason).toBe("no-semantic-observable")
  expect(result.observation).toBeUndefined()
  expect(result.pass).toBe(false)
  expect(result.assertions ?? []).toHaveLength(0)
  expect(result.response).toBe(
    JSON.stringify({ sgr: reply || "0", ...(RESET_SETUP[id] && { baseline: "0", setup: RESET_SETUP[id] }) }),
  )
  const recorded = recordExecutedProbe({
    featureId: id,
    attempt: { scope: "probe", startedAt: "2026-11-03T19:35:00.000Z" },
    coverage: { ...result.notTested!, featureId: id, rawReplyRef: id },
    assertions: [],
    tests: result.tests,
  })
  expect(recorded.status).toBe("probe-todo")
})

// A scripted response alone would miss sending reset before reading setup. Check the bytes that
// actually precede each protocol query, while allowing the writer to batch bytes differently.
test("a reset reads baseline and setup before sending the reset, and retains every phase", async () => {
  const { ctx, writes, writesAtQuery } = qualifiedSgrReadbackSource("sgr.selective-reset.bold", "0;3")
  const result = await sgrTerm("sgr.selective-reset.bold")(ctx)
  expect(result.observation?.outcome).toBe("supported")
  expect(writesAtQuery).toEqual(["\x1b[0m", "\x1b[0m\x1b[1;2;3m", "\x1b[0m\x1b[1;2;3m\x1b[22m"])
  expect(JSON.parse(result.response!)).toEqual({ baseline: "0", setup: "1;2;3", sgr: "0;3" })
  expect(writes.at(-1)).toBe("\x1b[0m")
})

test("an explicit no-underline report qualifies a neutral baseline and a cleared reset", async () => {
  const { ctx } = sgrReadbackSource(["0;4:0", "1;4", "1;4:0"])
  const result = await sgrTerm("sgr.selective-reset.underline")(ctx)
  expect(result.observation).toMatchObject({ outcome: "supported", assertionType: "query_reply" })
  expect(JSON.parse(result.response!)).toEqual({ baseline: "0;4:0", setup: "1;4", sgr: "1;4:0" })
})

test.each([
  ["sgr.selective-reset.underline", ["0;4:6"], "baseline"],
  ["sgr.selective-reset.underline", ["0", "1;4:6"], "setup"],
  ["sgr.reset", ["0", "1;3;4:0", "0"], "setup"],
  ["sgr.underline-color-reset", ["0", "4;58;2;255;0"], "setup"],
] as const)("%s retains an unqualified %s response without a reset verdict (%s)", async (id, replies, phase) => {
  const { ctx, queries, writes } = sgrReadbackSource(replies)
  let captures = 0
  ctx.capture = async () => {
    captures++
    throw new Error("An observed invalid prerequisite must not enter capture fallback")
  }
  // The new saved-rendition row may legitimately capture before any SGR query. This case owns
  // malformed query prerequisites without an independent pixel reference; its capture route is
  // exercised separately by the stateful saved-reference tests.
  if (id === "sgr.reset") delete ctx.capture
  const result = await sgrTerm(id)(ctx)
  expect(result.observation).toMatchObject({ outcome: "inconclusive", assertionType: "query_reply" })
  expect(result.assertions ?? []).toHaveLength(0)
  expect(result.observation?.note).toContain(`${phase} prerequisite`)
  if (id === "sgr.underline-color-reset") {
    expect(result.observation?.note).toContain("58:2::255:0:128 (colon form)")
    expect(result.observation?.note).toContain("SGR 59 not sent")
    expect(writes).not.toContain("\x1b[59m")
  }
  const phaseIndex = phase === "baseline" ? 0 : 1
  expect(JSON.parse(result.response!)).toMatchObject({ phase, [phase]: replies[phaseIndex] })
  expect(queries).toHaveLength(phaseIndex + 1)
  expect(captures).toBe(0)
  expect(writes.at(-1)).toBe("\x1b[0m")
})

test.each([["sgr.underline-color-reset", ["0", "4;58;2;255;0;129"]]] as const)(
  "%s keeps its original setup failure when the independent oracle has no owned capture",
  async (id, replies) => {
    const { ctx, queries, writes } = sgrReadbackSource(replies)
    ctx.capture = undefined
    const result = await sgrTerm(id)(ctx)
    expect(result.observation).toMatchObject({ outcome: "inconclusive", assertionType: "query_reply" })
    expect(result.observation?.note).toContain("setup prerequisite")
    expect(JSON.parse(result.response!)).toMatchObject({ phase: "setup", baseline: "0", setup: replies[1] })
    expect(queries).toHaveLength(2)
    expect(writes.at(-1)).toBe("\x1b[0m")
  },
)

// Missing setup attributes carry the same named coverage as missing final attributes. The old
// prerequisite wrapper discarded that coverage and the recorder classified the result as failure.
test.each([
  ["sgr.selective-reset.bold", "1;3"],
  ["sgr.selective-reset.underline", "0"],
] as const)("%s retains setup omission %s as a to-do without a capture oracle", async (id, setup) => {
  const { ctx, queries, writes } = sgrReadbackSource(["0", setup])
  ctx.capture = undefined
  const result = await sgrTerm(id)(ctx)
  expect(result.notTested?.reason).toBe("no-semantic-observable")
  expect(result.observation).toBeUndefined()
  expect(result.assertions ?? []).toHaveLength(0)
  expect(JSON.parse(result.response!)).toEqual({ phase: "setup", baseline: "0", setup })
  expect(queries).toHaveLength(2)
  expect(writes.at(-1)).toBe("\x1b[0m")
  const recorded = recordExecutedProbe({
    featureId: id,
    attempt: { scope: "probe", startedAt: "2026-11-03T23:30:00.000Z" },
    coverage: { ...result.notTested!, featureId: id, rawReplyRef: id },
    assertions: [],
    tests: result.tests,
  })
  expect(recorded.status).toBe("probe-todo")
  expect(recorded.reason).toContain("setup prerequisite was not established")
  expect(result.notTested?.noObservable).toBe(result.note)
  expect(recorded.reason).toContain(result.note!)
})

test.each([
  [["1"], "inconclusive", 1],
  [["0", "1;4:6"], "inconclusive", 2],
  [["0", "1;4", "1;4:6"], "inconclusive", 3],
] as const)("invalid reset query boundaries keep capture closed for %s", async (replies, outcome, queryCount) => {
  const { ctx, queries, writes } = sgrReadbackSource(replies)
  let captures = 0
  ctx.capture = async () => {
    captures++
    throw new Error("A deciding query must not capture")
  }
  const result = await sgrTerm("sgr.selective-reset.underline")(ctx)
  expect(result.observation).toMatchObject({ outcome, assertionType: "query_reply" })
  expect(queries).toHaveLength(queryCount)
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
      const { ctx, writes } = sgrReadbackSource(["0", "1;2;3", "0;3"])
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
      expect(result.observation, kind).toBeUndefined()
      expect(result.tests, kind).toEqual([
        { id: "criterion", status: "probe-invalid", reason: "Cursor did not reach the expected position" },
      ])
      expect(result.response, kind).toBe("1;2")
      expect(result.assertions ?? [], kind).toHaveLength(0)
      expect(queries, kind).toBe(stage + 1)
      expect(writes.at(-1), kind).toBe("\x1b[0m")
    }
  },
)

test.each(["baseline", "setup", "final"] as const)("a throwing %s readback propagates with cleanup", async (phase) => {
  const stage = ["baseline", "setup", "final"].indexOf(phase)
  const { ctx, writes } = sgrReadbackSource(["0", "1;2;3", "0;3"])
  const read = ctx.queryWithSentinelOutcome
  let queries = 0
  ctx.queryWithSentinelOutcome = async (...args) => {
    if (queries++ === stage) throw new Error(`${phase} query failed`)
    return read(...args)
  }
  await expect(sgrTerm("sgr.selective-reset.bold")(ctx)).rejects.toThrow(`${phase} query failed`)
  expect(writes.at(-1)).toBe("\x1b[0m")
})

// #33165 (@cto f2adcbf3, ruling 4): on a paint row a DECRQSS reply never decides the cell. With a capture, the pixels
// decide and the reply rides along as a note; with none, the recorded cell is not decided and says why, verbatim.
const PAINT_ROW_REASON = "graded from a status reply only; this row is decided by what is painted"
const paintAttempt = { scope: "probe", startedAt: "2026-11-10T22:00:00.000Z" } as const

function recordTerm(id: string, result: ProbeCallbackResult, frames: readonly ObservationFrame[] = []) {
  const assertions = (result.assertions ?? []).map((assertion) => ({ featureId: id, ...assertion, rawReplyRef: id }))
  const recorded = recordExecutedProbe({
    featureId: id,
    attempt: paintAttempt,
    observation: result.observation && { ...result.observation, featureId: id, rawReplyRef: id },
    coverage: result.notTested && { ...result.notTested, featureId: id, rawReplyRef: id },
    assertions,
    tests: result.tests,
    criterionBranch: result.criterionBranch,
    rawReplyRef: id,
  })
  return finalizeVisualResult(recorded, { kind: "term" }, frames)
}

test("a paint row's DECRQSS reply alone records PROBE TODO with the paint-row reason", async () => {
  for (const [id, reply] of PLAIN_STYLE_REPLIES) {
    const { ctx } = sgrReadbackSource(reply)
    const recorded = recordTerm(id, await sgrTerm(id)(ctx))
    expect(recorded.status, id).toBe("probe-todo")
    expect(recorded.reason, id).toBe(PAINT_ROW_REASON)
  }
  // A DECRQSS negative is not a grade either.
  const { ctx } = qualifiedSgrReadbackSource("sgr.fg.256", "0;38;5;68")
  ctx.capture = undefined
  const negative = recordTerm("sgr.fg.256", await sgrTerm("sgr.fg.256")(ctx))
  expect(negative.status).toBe("probe-todo")
  expect(negative.reason).toContain(PAINT_ROW_REASON)
  expect(negative.reason).toContain("38;5;67 (semicolon form)")
})

test("a capture decides a paint row against a contradicting DECRQSS reply, which stays a note", async () => {
  const frame: ObservationFrame = { role: "target", ref: "frame-target", capturedAt: 1, label: "blinking sample" }
  const { ctx } = sgrReadbackSource("0", true)
  // DECRQSS reports no SGR 5 active (a negative reading); the pixel series shows the blink.
  const decided = await sgrReadbackDecision(
    ctx,
    "sgr.blink",
    "\x1b[5m",
    { require: [5], forbid: [] },
    undefined,
    async () => ({
      pass: true,
      response: JSON.stringify({ frames: [frame.ref] }),
      observation: { outcome: "supported", assertionType: "screenshot", screenshotRef: frame.ref, frames: [frame] },
      assertions: [
        { assertionType: "screenshot", kind: "positive", expected: "styled text blinks", observed: frame.ref },
      ],
    }),
  )
  if (!decided) throw new Error("the capture oracle did not decide")
  expect(decided.observation).toMatchObject({ outcome: "supported", assertionType: "screenshot" })
  expect(decided.observation?.note).toMatch(/DECRQSS \{"sgr":"0"\}$/)
  const recorded = recordTerm("sgr.blink", decided, [frame])
  expect(recorded.status).toBe("supported")
  expect(recorded.assertionType).toBe("screenshot")
  expect(recorded.reason).toMatch(/DECRQSS \{"sgr":"0"\}$/)
})

test("every sgr term arm that reads DECRQSS declares the capture as its deciding observable", () => {
  const readbackRows = DECIDED.map(([id]) => id).filter((id) => id !== "sgr.reset")
  for (const id of readbackRows) {
    const probe = [...sgrProbes].find((value) => value.id === id)
    if (!probe) throw new Error(`missing ${id}`)
    expect(probe.termAssertionType, id).not.toBe("query_reply")
  }
})
