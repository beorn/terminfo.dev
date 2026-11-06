/**
 * @failure OSC 0 is supported from a title change alone, or an unobserved clause is treated as negative.
 *   A controlled title failure must disprove the conjunction without depending on a query reply.
 * @level l1
 * @consumer extensions.osc0-icon-title on both the termless parser arm and the sentinel app arm.
 * @testonly none
 */
import { expect, test } from "vitest"
import { extensionsProbes } from "./extensions.ts"
import { ADAPTER_SOURCE_AUDITS } from "./helpers.ts"
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

// #32323: this is the title-reader-only contract; the icon clause remains unobserved.
test.each([
  { controlWorks: true, titleWorks: false, iconReply: false, outcome: "unsupported" },
  { controlWorks: true, titleWorks: true, iconReply: false, outcome: undefined },
  { controlWorks: false, titleWorks: false, iconReply: false, outcome: undefined },
  // Exact positive reply evidence can complete the observed title clause without a title-query reply.
  { controlWorks: true, titleWorks: true, iconReply: true, outcome: "supported" },
] as const)(
  "OSC 0 title-only control=$controlWorks effect=$titleWorks icon-reply=$iconReply",
  ({ controlWorks, titleWorks, iconReply, outcome }) => {
    let title = "incoming-title"
    const ctx = Object.assign(lib(iconReply ? { [ICON_QUERY]: `\x1b]L${PAYLOAD}\x07` } : {}), {
      getTitle: () => title,
      feed: (sequence: string) => {
        const osc2 = /^\x1b\]2;([^\x07]*)\x07$/.exec(sequence)
        const osc0 = /^\x1b\]0;([^\x07]*)\x07$/.exec(sequence)
        if (osc2 && controlWorks) title = osc2[1]!
        if (osc0 && titleWorks) title = osc0[1]!
      },
    })
    const result = termlessCallback()(ctx)
    expect(result.observation?.outcome).toBe(outcome)
    if (outcome) {
      if (outcome === "unsupported") {
        expect(result.observation?.assertionType).toBe("buffer_state")
        expect(result.assertions).toContainEqual(expect.objectContaining({ kind: "negative" }))
      } else {
        expect(result.assertions?.map((assertion) => assertion.assertionType)).toEqual(["query_reply", "buffer_state"])
        expect(result.assertions?.map((assertion) => assertion.kind)).toEqual(["positive", "positive"])
      }
    } else {
      expect(result.notTested?.reason).toBe("no-semantic-observable")
    }
    expect(title).toBe("incoming-title")
  },
)

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

test("OSC 0 declares qualified library state evidence and application query evidence", () => {
  const definition = find()
  expect(definition.termAssertionType).toBe("query_reply")
  expect(definition.libAssertionType).toMatchObject({
    when: expect.any(Function),
    then: ["buffer_state"],
    otherwise: ["buffer_state", "query_reply"],
  })
})

const auditedXtermFixtureIdentity = {
  kind: "js",
  runtimeFormat: "js",
  engineVersion: "6.0.0",
  adapterVersion: "0.10.2",
  termlessRevision: "84003d2c91610fe2743142675234a0fb3ec9cf1d",
  adapterSources: Object.entries(ADAPTER_SOURCE_AUDITS.xtermjs).map(([path, blobOid]) => ({ path, blobOid })),
  resolvedPath: "/fixture/@xterm/headless/lib-headless/xterm-headless.js",
  integrity: {
    kind: "registry",
    lockIntegrity: "sha512-5Yj1QINYCyzrZtf8OFIHi47iQtI+0qYFPHmouEfG8dHNxbZ9Tb9YGSuLcsEwj9Z+OL75GJqPyJbyoFer80a2Hw==",
  },
} as const

test.each([
  { fault: "none", outcome: "supported" },
  { fault: "ignore-icon", outcome: "unsupported" },
  { fault: "ignore-title", outcome: "unsupported" },
  { fault: "icon-control", outcome: null },
  { fault: "title-control", outcome: null },
  { fault: "icon-readback", outcome: null },
  { fault: "title-readback", outcome: null },
] as const)("audited xterm OSC 0 checks BOTH setters and restores BOTH labels: $fault", ({ fault, outcome }) => {
  const original = {
    icon: fault === "ignore-icon" ? PAYLOAD : "saved-icon",
    title: fault === "ignore-title" ? PAYLOAD : "saved-title",
  }
  const labels = { ...original }
  const controls = { icon: false, title: false }
  const verified = { icon: false, title: false }
  let effectFed = false
  const readbackError = new Error(`${fault} unavailable`)
  const ctx = Object.assign(lib(exactReplies), {
    runtimeIdentity: auditedXtermFixtureIdentity,
    getIconLabel: () => {
      if (effectFed && fault === "icon-readback") throw readbackError
      if (controls.icon) verified.icon = true
      return labels.icon
    },
    getTitle: () => {
      if (effectFed && fault === "title-readback") throw readbackError
      if (controls.title) verified.title = true
      return labels.title
    },
    feed: (text: string) => {
      for (const match of text.matchAll(/\x1b\]([012]);([^\x07\x1b]*)(?:\x07|\x1b\\)/g)) {
        const [, code, value] = match
        if (code === "0") {
          effectFed = true
          expect.soft(verified).toEqual({ icon: true, title: true })
          expect.soft(labels.icon).not.toBe(labels.title)
          expect.soft(labels.icon).not.toBe(PAYLOAD)
          expect.soft(labels.title).not.toBe(PAYLOAD)
          if (fault !== "ignore-icon") labels.icon = value!
          if (fault !== "ignore-title") labels.title = value!
        } else {
          const member = code === "1" ? "icon" : "title"
          if (value !== original[member]) {
            controls[member] = true
            verified[member] = false
            if (fault === `${member}-control`) continue
          }
          labels[member] = value!
        }
      }
    },
  })
  let result: ReturnType<ReturnType<typeof termlessCallback>> | undefined
  let thrown: unknown
  try {
    result = termlessCallback()(ctx)
  } catch (error) {
    thrown = error
  } finally {
    expect.soft(labels).toEqual(original)
  }
  if (fault.endsWith("-readback") && thrown !== undefined) {
    expect(thrown).toBe(readbackError)
  } else {
    expect(thrown).toBeUndefined()
    expect(result).toBeDefined()
    if (outcome === null) {
      expect(result!.observation?.outcome).not.toBe("unsupported")
      expect(result!.observation?.outcome).not.toBe("supported")
      expect(result!.assertions?.some(({ kind }) => kind === "negative")).not.toBe(true)
      expect(result!.tests).toMatchObject([{ status: "probe-invalid", reason: expect.any(String) }])
    } else {
      expect(result!.observation).toMatchObject({ outcome, assertionType: "buffer_state" })
      expect(result!.assertions?.map(({ kind }) => kind)).toContain(outcome === "supported" ? "positive" : "negative")
    }
  }
  if (fault.endsWith("-control")) expect(effectFed).toBe(false)
  else expect(effectFed).toBe(true)
})

// #32246: the route follows the readers the source exposes, never an engine audit table, so a missing icon getter keeps
// the query route whatever the identity.
test.each(["audited-identity", "foreign-identity"])(
  "OSC 0 keeps query evidence without an icon getter for %s",
  (route) => {
    const ctx = Object.assign(lib(exactReplies), {
      runtimeIdentity: {
        ...auditedXtermFixtureIdentity,
        ...(route === "foreign-identity" ? { engineVersion: "not-xterm" } : {}),
      },
      getTitle: () => "", // The unavailable state control does not erase complete positive reply evidence.
    })
    const result = termlessCallback()(ctx)
    expect(result.observation).toMatchObject({ outcome: "supported", assertionType: "query_reply" })
    expect(result.assertions?.map(({ kind }) => kind)).toEqual(["positive", "positive"])
  },
)

test("the termless arm supports OSC 0 only when both replies return the exact payload", () => {
  const result = termlessCallback()(lib(exactReplies))
  expect(result.observation).toMatchObject({ outcome: "supported", assertionType: "query_reply" })
  expect(result.assertions?.map(({ kind }) => kind)).toEqual(["positive", "positive"])
})

test("an uncontrolled wrong icon reply cannot supply the missing negative control", () => {
  const result = termlessCallback()(lib({ ...exactReplies, [ICON_QUERY]: "\x1b]Lother-icon\x07" }))
  expect(result.notTested?.reason).toBe("no-semantic-observable")
  expect(result.observation).toBeUndefined()
})

test("the termless arm leaves a missing title observation to-test", () => {
  const result = termlessCallback()(lib({ [ICON_QUERY]: `\x1b]L${PAYLOAD}\x07` }))
  expect(result.notTested?.reason).toBe("no-semantic-observable")
  expect(result.observation).toBeUndefined()
})

// The existing lib cases cover an absent member. These cases pin the newly joined qualified route:
// DA1 evidence must survive, but only the member's matched reports can decide the OSC0 effect.
test.each([
  { when: "exact reports", replies: exactReplies, outcome: "supported" },
  { when: "wrong icon", replies: { ...exactReplies, [ICON_QUERY]: "\x1b]Lother-icon\x07" }, outcome: "probe-todo" },
  { when: "missing title", replies: { [ICON_QUERY]: exactReplies[ICON_QUERY] }, outcome: "probe-todo" },
  { when: "sentinel silence", replies: {}, outcome: "probe-todo" },
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
  if (outcome === "probe-todo") expect(result.notTested?.reason).toBe("no-semantic-observable")
  else expect(result.observation?.outcome).toBe(outcome)
  expect(queries).toEqual([ICON_QUERY, TITLE_QUERY])
  expect(writes).toContain(`\x1b]0;${PAYLOAD}\x07`)
  expect(writes.at(-1)).toBe("\x1b]2;\x07")
  expect(JSON.parse(result.response!)).toMatchObject({
    icon: ((replies as Record<string, string>)[ICON_QUERY] ?? "") + "\x1b[?1;2c",
    title: ((replies as Record<string, string>)[TITLE_QUERY] ?? "") + "\x1b[?1;2c",
  })
  if (outcome === "probe-todo") {
    expect(result.notTested?.noObservable).toContain("our test cannot tell whether OSC 0 set both names")
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
    { status: "probe-invalid", reason: expect.stringContaining("icon label (CSI 20 t): timeout") },
  ])
  expect(result.replyFailureTestIds).toEqual(["criterion"])
  expect(result.observation).toBeUndefined()
})
