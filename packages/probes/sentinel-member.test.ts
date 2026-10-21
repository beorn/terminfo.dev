/**
 * @failure A headless engine that is alive but silent on a query stays inconclusive forever, or an unproven engine, a drifted version, bytes ahead of the DA1 answer or a late reply becomes a measured negative, or a refused late reply loses what was read.
 * @level l1
 * @consumer The headless collector's sentinel member, its G1 listener and the proven reply-path table (#30554, @cto verdicts 452bc032 and 67840412).
 * @reach Builds the production context and batch from headless-batch.ts over real Termless backends and runs real probe arms from @terminfo/probe-defs through it, beside each arm's live twin fed the same outcomes; where a case needs a reply no engine gives on demand, the engine's replies are scripted behind the real backend.
 * @testonly none
 */
/* oxlint-disable typescript/no-deprecated -- Exercise the production TerminalBackend adapter boundary. */
import type { TerminalBackend } from "@termless/core"
import { resolve as resolveLibvterm } from "@termless/libvterm"
import { createVt100Backend } from "@termless/vt100"
import { createVt220Backend } from "@termless/vt220"
import { createVtermBackend } from "@termless/vterm"
import { createXtermBackend } from "@termless/xtermjs"
import { ALL_PROBES, type ProbeDefinition, type TermContext, type TerminalQueryOutcome } from "@terminfo/probe-defs"
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
  { name: "a DA1-shaped reply to the query itself", query: DA1, answer: DA1, reason: "timeout", match: null },
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

// An adapter that answers a query only after its engine has run the whole feed puts that answer after the
// engine's DA1 answer when both share one feed, as libvterm's 14t did until #30549. The member's separate DA1
// capture keeps the order a terminal gives, so such a reply is never read as "after the sentinel".
test("a reply an adapter makes after the whole feed stays a reply because DA1 has a capture of its own", () => {
  const winops = "\x1b[4;408;640t"
  const backend = scripted((text) => {
    if (text === DA1_QUERY) return DA1
    if (text === "\x1b[14t") return winops
    return text === `\x1b[14t${DA1_QUERY}` ? `${DA1}${winops}` : ""
  })
  const ctx = contextOf(backend, proven())
  const together = feedCapture(backend, `\x1b[14t${DA1_QUERY}`)
  expect(together.indexOf(winops)).toBeGreaterThan(together.indexOf(DA1))
  const outcome = ctx.queryWithSentinelOutcome?.("\x1b[14t", /\x1b\[4;(\d+);(\d+)t/)
  expect(outcome).toMatchObject({ reason: "reply", raw: `${winops}${DA1}` })
  expect(outcome?.sentinel).toBeUndefined()
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

function definitionOf(id: string): ProbeDefinition {
  const definition = ALL_PROBES.find((candidate) => candidate.id === id)
  if (!definition) throw new Error(`no probe definition ${id}`)
  return definition
}

function armsOf(id: string) {
  const { termless, term } = definitionOf(id)
  if (!termless || !term) throw new Error(`${id} has no headless and live arm pair`)
  return { termless, term }
}

/** A proven context that keeps every outcome its sentinel member gave, in order. */
function recordingContext(script: (text: string) => string) {
  const ctx = contextOf(scripted(script), proven())
  const member = ctx.queryWithSentinelOutcome?.bind(ctx)
  if (!member) throw new Error("a proven context has the sentinel member")
  const outcomes: TerminalQueryOutcome[] = []
  ctx.queryWithSentinelOutcome = (sequence, pattern) => {
    const outcome = member(sequence, pattern)
    outcomes.push(outcome)
    return outcome
  }
  return { ctx, outcomes }
}

/** A live context whose sentinel queries answer, in order, with the outcomes a headless arm was given. */
function replayingLive(outcomes: readonly TerminalQueryOutcome[]): TermContext {
  const queue = [...outcomes]
  const refused = (what: string) => async (): Promise<never> => {
    throw new Error(`the live arm asked for ${what}`)
  }
  return {
    cols: 80,
    rows: 24,
    write: () => {},
    queryCursorPosition: refused("a cursor report"),
    measureRenderedWidth: refused("a width"),
    query: refused("a raw query"),
    queryWithSentinel: refused("a sentinel match"),
    queryOutcome: refused("a direct query"),
    queryWithSentinelOutcome: async () => {
      const next = queue.shift()
      if (!next) throw new Error("the live arm asked for more sentinel queries than the headless arm made")
      return next
    },
    queryMode: refused("a mode"),
  }
}

interface ArmCase {
  id: string
  when: string
  /** The engine's reply to each query; anything unnamed is silent. DA1 always answers. */
  replies: Readonly<Record<string, string>>
  outcome: "unsupported" | "inconclusive"
}

// One real arm per grader family, both two-step arms, and DECRQSS's second step after an SGR refusal.
const ARM_CASES: ArmCase[] = [
  { id: "device.xtversion", when: "silent", replies: {}, outcome: "unsupported" },
  { id: "device.xtwinops-20", when: "silent", replies: {}, outcome: "unsupported" },
  { id: "device.decrqss", when: "silent", replies: {}, outcome: "unsupported" },
  {
    id: "device.decrqss",
    when: "after an SGR refusal",
    replies: { "\x1bP$qm\x1b\\": "\x1bP0$r\x1b\\" },
    outcome: "inconclusive",
  },
  { id: "extensions.osc10-fg-color", when: "silent", replies: {}, outcome: "unsupported" },
  { id: "extensions.osc1337-cellsize", when: "silent", replies: {}, outcome: "unsupported" },
  { id: "extensions.sixel-geometry-report", when: "silent", replies: {}, outcome: "unsupported" },
  { id: "extensions.osc21-kitty-color", when: "silent", replies: {}, outcome: "unsupported" },
  { id: "extensions.osc5522-clipboard", when: "silent", replies: {}, outcome: "unsupported" },
  { id: "extensions.kitty-graphics", when: "silent", replies: {}, outcome: "unsupported" },
  { id: "extensions.kitty-graphics.transmit", when: "silent", replies: {}, outcome: "unsupported" },
]

test.each(ARM_CASES)(
  "$id, $when: the proven headless arm grades exactly as live grades the same outcomes",
  async ({ id, replies, outcome }) => {
    const { termless, term } = armsOf(id)
    const { ctx, outcomes } = recordingContext((text) => (text === DA1_QUERY ? DA1 : (replies[text] ?? "")))
    const headless = termless(ctx)
    expect(outcomes.length, id).toBeGreaterThan(0)
    expect(headless.observation?.outcome, id).toBe(outcome)
    if (outcome === "unsupported") expect(headless.observation?.note, id).toBe("negative by sentinel")
    expect(headless).toStrictEqual(await term(replayingLive(outcomes)))
    // Without the member the arm keeps today's capture-only reading, where silence never grades.
    const plain = termless(contextOf(scripted((text) => replies[text] ?? "")))
    expect(plain.observation?.outcome, id).toBe("inconclusive")
  },
)

test("extensions.kitty-keyboard: once detection answers, a silent flags query grades as live grades it", async () => {
  const { termless, term } = armsOf("extensions.kitty-keyboard")
  const detection = `\x1b[?0u${DA1}`
  const fed: string[] = []
  const { ctx, outcomes } = recordingContext((text) => {
    fed.push(text)
    if (text === "\x1b[?u\x1b[c") return detection
    return text === DA1_QUERY ? DA1 : ""
  })
  const headless = termless(ctx)
  // Detection stays the DA1-graded capture both collectors already share; the flags query takes the member.
  expect(fed).toEqual(["\x1b[?u\x1b[c", "\x1b[>1u", "\x1b[?u", DA1_QUERY, "\x1b[<u"])
  expect(headless.observation).toMatchObject({ outcome: "unsupported", note: "negative by sentinel" })
  const answered: TerminalQueryOutcome = {
    match: ["\x1b[?0u", "0"],
    reason: "reply",
    raw: detection,
    rawBase64: base64(detection),
  }
  expect(headless).toStrictEqual(await term(replayingLive([answered, ...outcomes])))
})

const IMAGE_ID = "7"
const KITTY_DETECTION = `\x1b[?0u${DA1}`

/** One case per string-grader site: the engine answers, and DA1 answers after it. */
const ANSWERED_CASES: { id: string; reply: (text: string) => string; liveFirst?: TerminalQueryOutcome[] }[] = [
  {
    id: "extensions.kitty-keyboard",
    reply: (text) => (text === "\x1b[?u\x1b[c" ? KITTY_DETECTION : text === "\x1b[?u" ? "\x1b[?1u" : ""),
    // The headless arm detects by capture; live detects through its sentinel query, so live sees one outcome more.
    liveFirst: [
      { match: ["\x1b[?0u", "0"], reason: "reply", raw: KITTY_DETECTION, rawBase64: base64(KITTY_DETECTION) },
    ],
  },
  {
    id: "extensions.kitty-graphics",
    reply: (text) => (text.startsWith("\x1b_Gi=31,") ? "\x1b_Gi=31;OK\x1b\\" : ""),
  },
  {
    id: "extensions.kitty-graphics.transmit",
    reply: (text) => {
      const number = /^\x1b_Ga=t,.*,I=(\d+);/.exec(text)?.[1]
      return number ? `\x1b_Gi=${IMAGE_ID},I=${number};OK\x1b\\` : ""
    },
  },
  {
    id: "extensions.kitty-graphics.display",
    reply: (text) => {
      const number = /^\x1b_Ga=t,.*,I=(\d+);/.exec(text)?.[1]
      if (number) return `\x1b_Gi=${IMAGE_ID},I=${number};OK\x1b\\`
      return text.startsWith(`\x1b_Ga=p,i=${IMAGE_ID},`) ? `\x1b_Gi=${IMAGE_ID};OK\x1b\\` : ""
    },
  },
  {
    id: "extensions.osc21-kitty-color",
    reply: (text) => (text === "\x1b]21;foreground=?\x1b\\" ? "\x1b]21;foreground=rgb:ffff/ffff/ffff\x1b\\" : ""),
  },
  { id: "extensions.osc5522-clipboard", reply: (text) => (text === "\x1b[?5522$p" ? "\x1b[?5522;1$y" : "") },
]

test.each(ANSWERED_CASES)(
  "$id: an answered string-graded query keeps the whole read window, DA1 answer included, as live does",
  async ({ id, reply, liveFirst = [] }) => {
    // Both arms draw the same image number, so the live twin can take the headless arm's allocation outcome.
    vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue("0000002a-0000-4000-8000-000000000000")
    const { termless, term } = armsOf(id)
    const { ctx, outcomes } = recordingContext((text) => (text === DA1_QUERY ? DA1 : reply(text)))
    const headless = termless(ctx)
    const graded = outcomes.at(-1)
    const frame = graded?.match?.[0]
    if (!graded || !frame) throw new Error(`${id}: the member gave no answered outcome`)
    // The grader reads only the frame; the result records everything the read window held.
    expect(headless.observation?.outcome, id).toBe("supported")
    expect(graded.raw, id).toBe(`${frame}${DA1}`)
    expect(headless.response, id).toBe(graded.raw)
    expect(headless).toStrictEqual(await term(replayingLive([...liveFirst, ...outcomes])))
  },
)

test("G1: a silent proven engine publishes the sentinel negative once the grace window stays quiet", async () => {
  vi.stubEnv("TERMINFO_SENTINEL_GRACE_MS", "40")
  // collectBatch names each probe on stderr, and the root test setup refuses a test's output.
  vi.spyOn(process.stderr, "write").mockImplementation(() => true)
  const batch = await collectBatch(
    async () => scripted((text) => (text === DA1_QUERY ? DA1 : "")),
    "xtermjs",
    [definitionOf("device.xtversion")],
    undefined,
    undefined,
    proofOf("xtermjs"),
  )
  expect(batch.observations).toStrictEqual([
    {
      featureId: "device.xtversion",
      outcome: "unsupported",
      evidence: "query",
      note: "negative by sentinel",
      rawReplyRef: "device.xtversion",
    },
  ])
  expect(batch.assertions).toMatchObject([
    {
      kind: "negative",
      expected: "complete XTVERSION DCS >| printable name/version ST",
      observed: expect.stringMatching(/^DA1 answered at \+\d+ms; no reply through the 40 ms window$/),
    },
  ])
})

test("G1: a byte the engine sends after the callback voids the negative as a collector error and keeps both reads", async () => {
  vi.stubEnv("TERMINFO_SENTINEL_GRACE_MS", "40")
  // collectBatch names each probe on stderr, and the root test setup refuses a test's output.
  vi.spyOn(process.stderr, "write").mockImplementation(() => true)
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
    [definitionOf("device.xtversion")],
    undefined,
    undefined,
    proofOf("xtermjs"),
  )
  expect(batch.observations).toMatchObject([
    {
      featureId: "device.xtversion",
      outcome: "error",
      reason: "collector-error",
      evidence: "query",
      note: expect.stringMatching(
        /^headless xtermjs probe device\.xtversion: late reply after sentinel: 10 bytes "\\u001bP>\|late\\u001b\\\\" at \+\d+ms$/,
      ),
    },
  ])
  expect(batch.assertions).toStrictEqual([])
  // The refusal keeps what was observed: the on-time read window, and the late bytes beside it.
  expect(batch.rawReplies).toStrictEqual({
    "device.xtversion": DA1,
    "device.xtversion.late": "\x1bP>|late\x1b\\",
  })
})
