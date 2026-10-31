/**
 * @failure OSC 0 is graded from a title change alone, or a missing icon/title reply is promoted to
 *   support or to a negative.
 * @level l1
 * @consumer extensions.osc0-icon-title on both the termless parser arm and the sentinel app arm.
 * @testonly none
 */
import { expect, test } from "vitest"
import { extensionsProbes } from "./extensions.ts"
import type { TermProbeSource, LibProbeSource } from "./types.ts"

const PAYLOAD = "osc0-icon-title"
const ICON_QUERY = "\x1b[20t"
const TITLE_QUERY = "\x1b[21t"

function find() {
  const definition = extensionsProbes.find((probe) => probe.id === "extensions.osc0-icon-title")
  if (!definition) throw new Error("missing extensions.osc0-icon-title")
  return definition
}

function termCallback() {
  const callback = find().term
  if (!callback) throw new Error("extensions.osc0-icon-title has no app callback")
  return callback
}

function termlessCallback() {
  const callback = find().lib
  if (!callback) throw new Error("extensions.osc0-icon-title has no headless callback")
  return callback
}

function lib(replies: Record<string, string>): LibProbeSource {
  return {
    cols: 80,
    rows: 24,
    capabilities: {},
    feed: () => {},
    feedCapture: (text: string) => replies[text] ?? "",
    getMode: () => false,
    getText: () => "",
    getTitle: () => "",
    getCell: () => ({ char: " " }),
    getCursor: () => ({ x: 0, y: 0, visible: true, style: null }),
    reset: () => {},
  } as unknown as LibProbeSource
}

function terminal(replies: Record<string, string>): TermProbeSource {
  const outcome = (sequence: string, pattern: RegExp) => {
    const raw = replies[sequence] ?? ""
    if (raw === "") return { match: null, reason: "timeout" as const, raw: "", rawBase64: "" }
    return { match: pattern.exec(raw), reason: "reply" as const, raw, rawBase64: Buffer.from(raw).toString("base64") }
  }
  return {
    cols: 80,
    rows: 24,
    write: () => {},
    queryCursorPosition: async () => null,
    measureRenderedWidth: async () => ({ kind: "no-reply", step: "sample" }) as const,
    query: async (sequence: string, pattern: RegExp) => outcome(sequence, pattern).match,
    queryWithSentinel: async (sequence: string, pattern: RegExp) => outcome(sequence, pattern).match,
    queryOutcome: async (sequence: string, pattern: RegExp) => outcome(sequence, pattern),
    queryWithSentinelOutcome: async (sequence: string, pattern: RegExp) => outcome(sequence, pattern),
    queryMode: async () => null,
  } as unknown as TermProbeSource
}

const exactReplies = {
  [ICON_QUERY]: `\x1b]L${PAYLOAD}\x07`,
  [TITLE_QUERY]: `\x1b]l${PAYLOAD}\x07`,
}

test("both arms declare measuring query evidence, so the catalog can derive automated", () => {
  const definition = find()
  expect(definition.termAssertionType).toBe("query_reply")
  expect(definition.libAssertionType).toBe("query_reply")
})

test("the termless arm supports OSC 0 only when both replies return the exact payload", () => {
  const result = termlessCallback()(lib(exactReplies))
  expect(result.observation).toMatchObject({ outcome: "supported", assertionType: "query_reply" })
  expect(result.assertions?.map(({ kind }) => kind)).toEqual(["positive", "positive"])
})

test("the termless arm reads a complete wrong icon payload as unsupported", () => {
  const result = termlessCallback()(lib({ ...exactReplies, [ICON_QUERY]: "\x1b]Lother-icon\x07" }))
  expect(result.observation).toMatchObject({ outcome: "unsupported", assertionType: "query_reply" })
  expect(result.assertions?.map(({ kind }) => kind)).toEqual(["negative", "positive"])
})

test("the termless arm names a missing title reply as a test failure, never unsupported", () => {
  const result = termlessCallback()(lib({ [ICON_QUERY]: `\x1b]L${PAYLOAD}\x07` }))
  expect(result.tests).toMatchObject([
    { status: "test-failure", reason: expect.stringContaining("window title (CSI 21 t): feedCapture boundary") },
  ])
  expect(result.replyFailureTestIds).toEqual(["criterion"])
  expect(result.observation).toBeUndefined()
})

// The existing lib cases cover an absent member. These cases pin the newly joined qualified route:
// DA1 evidence must survive, but only the member's matched reports can decide the OSC0 effect.
test.each([
  { when: "exact reports", replies: exactReplies, outcome: "supported" },
  { when: "wrong icon", replies: { ...exactReplies, [ICON_QUERY]: "\x1b]Lother-icon\x07" }, outcome: "unsupported" },
  { when: "missing title", replies: { [ICON_QUERY]: exactReplies[ICON_QUERY] }, outcome: "test-failure" },
  { when: "sentinel silence", replies: {}, outcome: "test-failure" },
])("the qualified termless arm retains both query traces for $when", ({ replies, outcome }) => {
  const queries: string[] = []
  const writes: string[] = []
  const ctx = lib({})
  ctx.feed = (text) => {
    writes.push(text)
  }
  ctx.feedCapture = () => {
    throw new Error("qualified query fell back to bare capture")
  }
  ctx.queryWithSentinelOutcome = (sequence, pattern) => {
    queries.push(sequence)
    const reply = (replies as Record<string, string>)[sequence] ?? ""
    const raw = reply + "\x1b[?1;2c"
    return {
      match: pattern.exec(reply),
      reason: reply ? "reply" : "sentinel",
      raw,
      rawBase64: Buffer.from(raw).toString("base64"),
      sentinel: { atMs: 0, graceMs: 250 },
    }
  }
  const result = termlessCallback()(ctx)
  if (outcome === "test-failure") expect(result.tests).toMatchObject([{ status: outcome }])
  else expect(result.observation?.outcome).toBe(outcome)
  expect(queries).toEqual([ICON_QUERY, TITLE_QUERY])
  expect(writes).toEqual([`\x1b]0;${PAYLOAD}\x07`])
  expect(JSON.parse(result.response!)).toMatchObject({
    icon: ((replies as Record<string, string>)[ICON_QUERY] ?? "") + "\x1b[?1;2c",
    title: ((replies as Record<string, string>)[TITLE_QUERY] ?? "") + "\x1b[?1;2c",
  })
  if (outcome === "test-failure") {
    expect(result.tests?.[0].reason).toContain("window title (CSI 21 t): sentinel")
    expect(result.replyFailureTestIds).toEqual(["criterion"])
    expect(result.observation).toBeUndefined()
    expect(result.assertions?.some(({ kind }) => kind === "negative")).not.toBe(true)
  }
})

test("the sentinel app arm supports OSC 0 when both replies return the exact payload", async () => {
  const result = await termCallback()(terminal(exactReplies))
  expect(result.observation).toMatchObject({ outcome: "supported", assertionType: "query_reply" })
})

test("the sentinel app arm reads a complete wrong title payload as unsupported", async () => {
  const result = await termCallback()(terminal({ ...exactReplies, [TITLE_QUERY]: "\x1b]lother-title\x07" }))
  expect(result.observation).toMatchObject({ outcome: "unsupported", assertionType: "query_reply" })
  expect(result.assertions?.map(({ kind }) => kind)).toEqual(["positive", "negative"])
})

test("the sentinel app arm names a missing icon reply as a test failure", async () => {
  const result = await termCallback()(terminal({ [TITLE_QUERY]: `\x1b]l${PAYLOAD}\x07` }))
  expect(result.tests).toMatchObject([
    { status: "test-failure", reason: expect.stringContaining("icon label (CSI 20 t): timeout") },
  ])
  expect(result.replyFailureTestIds).toEqual(["criterion"])
  expect(result.observation).toBeUndefined()
})
