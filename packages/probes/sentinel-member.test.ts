/**
 * @failure A headless engine that is alive but silent on a query stays inconclusive forever, or an unproven engine, a drifted version, bytes ahead of the DA1 answer or a late reply becomes a measured negative.
 * @level l1
 * @consumer The headless collector's sentinel member, its G1 listener and the proven reply-path table (#30554, @cto verdicts 452bc032 and 67840412).
 * @reach Builds the production context and batch from headless-batch.ts over real Termless backends; where a case needs a reply no engine gives on demand, the engine's replies are scripted behind the real backend.
 * @testonly none
 */
/* oxlint-disable typescript/no-deprecated -- Exercise the production TerminalBackend adapter boundary. */
import type { TerminalBackend } from "@termless/core"
import { resolve as resolveLibvterm } from "@termless/libvterm"
import { createVt100Backend } from "@termless/vt100"
import { createVt220Backend } from "@termless/vt220"
import { createVtermBackend } from "@termless/vterm"
import { createXtermBackend } from "@termless/xtermjs"
import type { ProbeDefinition } from "@terminfo/probe-defs"
import { afterEach, expect, test, vi } from "vitest"
import { collectBatch, createTermlessContext, feedCapture, type ProvenReplyPath } from "./headless-batch.ts"
import { PROVEN_REPLY_PATHS, replyPathDecision, type ReplyPathProof } from "./proven-reply-paths.ts"

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const DA1_QUERY = "\x1b[c"
const DA1 = "\x1b[?1;2c"
const CPR = /\x1b\[(\d+);(\d+)R/
const XTVERSION = /\x1bP>\|([^\x1b]*)\x1b\\/

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

function proofOf(name: string): ReplyPathProof {
  const proof = PROVEN_REPLY_PATHS[name]
  if (!proof) throw new Error(`no proof row for ${name}`)
  return proof
}

function proven(onSentinel: () => void = () => {}): ProvenReplyPath {
  return { proof: proofOf("xtermjs"), graceMs: 250, onSentinel }
}

/**
 * A real xterm.js backend whose engine replies come from a script: each feed answers synchronously with
 * the bytes the script returns for it, so a case can stage a reply no engine gives on demand.
 */
function scripted(script: (text: string) => string): TerminalBackend {
  const backend = createXtermBackend()
  vi.spyOn(backend, "feed").mockImplementation((bytes: Uint8Array) => {
    const reply = script(decoder.decode(bytes))
    if (reply) backend.onResponse?.(encoder.encode(reply))
  })
  return backend
}

function contextOf(backend: TerminalBackend, path?: ProvenReplyPath) {
  backend.init({ cols: 80, rows: 24 })
  return createTermlessContext(backend, path)
}

const base64 = (raw: string) => Buffer.from(raw).toString("base64")

test("an unproven context has no sentinel member", () => {
  expect(contextOf(scripted(() => "")).queryWithSentinelOutcome).toBeUndefined()
})

test("a proven engine that answers DA1 and nothing else gives live's sentinel outcome and facts", () => {
  const onSentinel = vi.fn()
  const ctx = contextOf(
    scripted((text) => (text === DA1_QUERY ? DA1 : "")),
    proven(onSentinel),
  )
  expect(ctx.queryWithSentinelOutcome?.("\x1b[>q", XTVERSION)).toStrictEqual({
    match: null,
    reason: "sentinel",
    raw: DA1,
    rawBase64: base64(DA1),
    sentinel: { atMs: expect.any(Number), graceMs: 250 },
  })
  expect(onSentinel).toHaveBeenCalledOnce()
})

test.each([
  {
    name: "a reply ahead of the DA1 answer",
    query: "\x1b[3;7R",
    answer: DA1,
    reason: "reply",
    match: ["\x1b[3;7R", "3", "7"],
  },
  {
    name: "a reply the engine defers to the next feed",
    query: "",
    answer: `\x1b[3;7R${DA1}`,
    reason: "reply",
    match: ["\x1b[3;7R", "3", "7"],
  },
  {
    name: "a reply split across the two captures",
    query: "\x1b[3;",
    answer: `7R${DA1}`,
    reason: "reply",
    match: ["\x1b[3;7R", "3", "7"],
  },
  {
    name: "unmatched bytes, then DA1 → not sentinel",
    query: "\x1b]11;rgb:0000/0000/0000\x1b\\",
    answer: DA1,
    reason: "timeout",
    match: null,
  },
  {
    name: "a DA2 answer is not taken for DA1",
    query: "",
    answer: "\x1b[>1;10;0c",
    reason: "timeout",
    match: null,
  },
  { name: "no DA1 answer at all", query: "", answer: "", reason: "timeout", match: null },
])("$name gives no sentinel outcome and no facts", ({ query, answer, reason, match }) => {
  const onSentinel = vi.fn()
  const ctx = contextOf(
    scripted((text) => (text === DA1_QUERY ? answer : query)),
    proven(onSentinel),
  )
  const raw = query + answer
  expect(ctx.queryWithSentinelOutcome?.("\x1b[6n", CPR)).toStrictEqual({ match, reason, raw, rawBase64: base64(raw) })
  expect(onSentinel).not.toHaveBeenCalled()
})

test("a reply after the DA1 answer grades by the reply and carries the sentinel facts", () => {
  const onSentinel = vi.fn()
  const ctx = contextOf(
    scripted((text) => (text === DA1_QUERY ? `${DA1}\x1b[3;7R` : "")),
    proven(onSentinel),
  )
  expect(ctx.queryWithSentinelOutcome?.("\x1b[6n", CPR)).toStrictEqual({
    match: ["\x1b[3;7R", "3", "7"],
    reason: "reply",
    raw: `${DA1}\x1b[3;7R`,
    rawBase64: base64(`${DA1}\x1b[3;7R`),
    sentinel: { atMs: expect.any(Number), graceMs: 250 },
  })
  expect(onSentinel).not.toHaveBeenCalled()
})

// In one feed, libvterm's adapter appends its own 14t answer after the engine's DA1 answer; the
// member's separate DA1 capture keeps the order a terminal gives, so the reply is never "late".
test("libvterm's adapter-made 14t reply stays a reply because DA1 has a capture of its own", async () => {
  const backend = await resolveLibvterm()
  backend.init({ cols: 80, rows: 24 })
  try {
    const together = feedCapture(backend, `\x1b[14t${DA1_QUERY}`)
    expect(together.indexOf("\x1b[4;")).toBeGreaterThan(together.indexOf(proofOf("libvterm").da1Answer))
    const ctx = createTermlessContext(backend, { proof: proofOf("libvterm"), graceMs: 250, onSentinel: () => {} })
    const outcome = ctx.queryWithSentinelOutcome?.("\x1b[14t", /\x1b\[4;(\d+);(\d+)t/)
    expect(outcome?.reason).toBe("reply")
    expect(outcome?.sentinel).toBeUndefined()
  } finally {
    backend.destroy()
  }
})

const engines: Record<string, () => Promise<TerminalBackend>> = {
  xtermjs: async () => createXtermBackend(),
  vt100: async () => createVt100Backend(),
  vt220: async () => createVt220Backend(),
  vterm: async () => createVtermBackend(),
  libvterm: resolveLibvterm,
}

test("the proof table names exactly the engines this test can run", () => {
  expect(Object.keys(PROVEN_REPLY_PATHS).sort()).toEqual(Object.keys(engines).sort())
})

test.each(Object.keys(engines))("%s answers DA1 through feedCapture as its proof row records", async (name) => {
  const create = engines[name]
  if (!create) throw new Error(`no engine factory for ${name}`)
  const backend = await create()
  backend.init({ cols: 80, rows: 24 })
  try {
    expect(feedCapture(backend, DA1_QUERY)).toBe(proofOf(name).da1Answer)
  } finally {
    backend.destroy()
  }
})

test("a proven backend at the versions its row names gets the member, silently", () => {
  const warn = vi.fn()
  expect(replyPathDecision("vt100", { adapterVersion: "0.10.2", engineVersion: "0.7.1" }, warn)).toStrictEqual({
    member: true,
    backend: "vt100",
    proof: proofOf("vt100"),
  })
  expect(warn).not.toHaveBeenCalled()
})

test("a proven backend at a version its row does not name gets no member and says so", () => {
  const warn = vi.fn()
  const decision = replyPathDecision("vt100", { adapterVersion: "0.10.2", engineVersion: "0.7.2" }, warn)
  expect(decision).toMatchObject({ member: false, backend: "vt100", adapterVersion: "0.10.2", engineVersion: "0.7.2" })
  expect(warn).toHaveBeenCalledOnce()
  expect(warn.mock.calls[0]?.[0]).toMatch(
    /^headless version drift: vt100 runs adapter 0\.10\.2 with engine 0\.7\.2, but its reply-path proof names adapter 0\.10\.2 with engine 0\.7\.1/,
  )
})

test.each(["ghostty", "alacritty", "wezterm", "vt100-rust", "ghostty-native", "kitty"])(
  "%s has no proven reply path and no member",
  (name) => {
    const warn = vi.fn()
    expect(replyPathDecision(name, { adapterVersion: "0.10.2", engineVersion: "1.0.0" }, warn)).toStrictEqual({
      member: false,
      backend: name,
      adapterVersion: "0.10.2",
      engineVersion: "1.0.0",
      reason: `${name} has no proven reply path`,
    })
    expect(warn).not.toHaveBeenCalled()
  },
)

/** A query probe that publishes the sentinel negative its silent engine earns, in the graders' words. */
const silentQuery: ProbeDefinition = {
  id: "sentinel.fixture",
  term: null,
  termlessObservationEvidence: "query",
  termless: (ctx) => {
    const outcome = ctx.queryWithSentinelOutcome?.("\x1b[>q", XTVERSION)
    if (outcome?.reason !== "sentinel" || !outcome.sentinel) throw new Error(`no sentinel outcome: ${JSON.stringify(outcome)}`)
    const { atMs, graceMs } = outcome.sentinel
    return {
      pass: false,
      response: outcome.raw,
      observation: { outcome: "unsupported", evidence: "query", note: "negative by sentinel" },
      assertions: [
        {
          kind: "negative",
          expected: "XTVERSION reply",
          observed: `DA1 answered at +${String(atMs)}ms; no reply through the ${String(graceMs)} ms window`,
        },
      ],
    }
  },
}

test("G1: a silent proven engine publishes the sentinel negative once the grace window stays quiet", async () => {
  vi.stubEnv("TERMINFO_SENTINEL_GRACE_MS", "40")
  const batch = await collectBatch(
    async () => scripted((text) => (text === DA1_QUERY ? DA1 : "")),
    "xtermjs",
    [silentQuery],
    undefined,
    undefined,
    proofOf("xtermjs"),
  )
  expect(batch.observations).toStrictEqual([
    {
      featureId: "sentinel.fixture",
      outcome: "unsupported",
      evidence: "query",
      note: "negative by sentinel",
      rawReplyRef: "sentinel.fixture",
    },
  ])
  expect(batch.assertions).toMatchObject([
    { kind: "negative", expected: "XTVERSION reply", observed: "DA1 answered at +0ms; no reply through the 40 ms window" },
  ])
})

test("G1: a byte the engine sends after the callback voids the negative as a collector error", async () => {
  vi.stubEnv("TERMINFO_SENTINEL_GRACE_MS", "40")
  const batch = await collectBatch(
    async () => {
      const backend = scripted((text) => {
        if (text !== DA1_QUERY) return ""
        setTimeout(() => backend.onResponse?.(encoder.encode("\x1bP>|late\x1b\\")), 5)
        return DA1
      })
      return backend
    },
    "xtermjs",
    [silentQuery],
    undefined,
    undefined,
    proofOf("xtermjs"),
  )
  expect(batch.observations).toMatchObject([
    {
      featureId: "sentinel.fixture",
      outcome: "error",
      reason: "collector-error",
      evidence: "query",
      note: expect.stringMatching(
        /^headless xtermjs probe sentinel\.fixture: late reply after sentinel: 10 bytes "\\u001bP>\|late\\u001b\\\\" at \+\d+ms$/,
      ),
    },
  ])
  expect(batch.assertions).toStrictEqual([])
  expect(batch.rawReplies).toStrictEqual({})
})
