/**
 * @failure OSC 0 is graded from a title change alone, or a missing icon/title reply is promoted to
 *   support or to a negative.
 * @level l1
 * @consumer extensions.osc0-icon-title on both the termless parser arm and the sentinel app arm.
 * @testonly none
 */
import { expect, test } from "vitest"
import { extensionsProbes } from "./extensions.ts"
import type { TermContext, TermlessContext } from "./types.ts"

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
  const callback = find().termless
  if (!callback) throw new Error("extensions.osc0-icon-title has no headless callback")
  return callback
}

function termless(replies: Record<string, string>): TermlessContext {
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
  } as unknown as TermlessContext
}

function terminal(replies: Record<string, string>): TermContext {
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
    measureRenderedWidth: async () => null,
    query: async (sequence: string, pattern: RegExp) => outcome(sequence, pattern).match,
    queryWithSentinel: async (sequence: string, pattern: RegExp) => outcome(sequence, pattern).match,
    queryOutcome: async (sequence: string, pattern: RegExp) => outcome(sequence, pattern),
    queryWithSentinelOutcome: async (sequence: string, pattern: RegExp) => outcome(sequence, pattern),
    queryMode: async () => null,
  } as unknown as TermContext
}

const exactReplies = {
  [ICON_QUERY]: `\x1b]L${PAYLOAD}\x07`,
  [TITLE_QUERY]: `\x1b]l${PAYLOAD}\x07`,
}

test("both arms declare measuring query evidence, so the catalog can derive automated", () => {
  const definition = find()
  expect(definition.termObservationEvidence).toBe("query")
  expect(definition.termlessObservationEvidence).toBe("query")
})

test("the termless arm supports OSC 0 only when both replies return the exact payload", () => {
  const result = termlessCallback()(termless(exactReplies))
  expect(result.observation).toMatchObject({ outcome: "supported", evidence: "query" })
  expect(result.assertions?.map(({ kind }) => kind)).toEqual(["positive", "positive"])
})

test("the termless arm reads a complete wrong icon payload as unsupported", () => {
  const result = termlessCallback()(termless({ ...exactReplies, [ICON_QUERY]: "\x1b]Lother-icon\x07" }))
  expect(result.observation).toMatchObject({ outcome: "unsupported", evidence: "query" })
  expect(result.assertions?.map(({ kind }) => kind)).toEqual(["negative", "positive"])
})

test("the termless arm names a missing title reply as inconclusive, never unsupported", () => {
  const result = termlessCallback()(termless({ [ICON_QUERY]: `\x1b]L${PAYLOAD}\x07` }))
  expect(result.observation).toMatchObject({
    outcome: "inconclusive",
    reason: "insufficient-evidence",
    evidence: "query",
  })
  expect(result.observation?.note).toContain("window title (CSI 21 t)")
})

test("the sentinel app arm supports OSC 0 when both replies return the exact payload", async () => {
  const result = await termCallback()(terminal(exactReplies))
  expect(result.observation).toMatchObject({ outcome: "supported", evidence: "query" })
})

test("the sentinel app arm reads a complete wrong title payload as unsupported", async () => {
  const result = await termCallback()(terminal({ ...exactReplies, [TITLE_QUERY]: "\x1b]lother-title\x07" }))
  expect(result.observation).toMatchObject({ outcome: "unsupported", evidence: "query" })
  expect(result.assertions?.map(({ kind }) => kind)).toEqual(["positive", "negative"])
})

test("the sentinel app arm names a missing icon reply as inconclusive", async () => {
  const result = await termCallback()(terminal({ [TITLE_QUERY]: `\x1b]l${PAYLOAD}\x07` }))
  expect(result.observation).toMatchObject({
    outcome: "inconclusive",
    reason: "insufficient-evidence",
    evidence: "query",
  })
  expect(result.observation?.note).toContain("icon label (CSI 20 t)")
})
