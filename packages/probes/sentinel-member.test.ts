/**
 * @failure A headless engine that is alive but silent on a query stays inconclusive forever, or an unproven engine, a changed executing declaration, bytes ahead of the DA1 answer or a late reply becomes a measured negative, or a read where DA1 answered is labelled a timeout, or a refused late reply loses what was read.
 * @level l1
 * @consumer The headless collector's sentinel member, its G1 listener and executing adapter reply-delivery declarations (#30554, @cto verdicts 452bc032 and 67840412).
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
import { fakeProbeResult } from "@terminfo/probe-defs/testing/fake-probe-result"
import { ALL_PROBES, type ProbeDefinition, type TermProbeSource, type TerminalQueryOutcome } from "@terminfo/probe-defs"
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest"
import { collectBatch, createLibProbeSource, feedCapture, type ProvenReplyPath } from "./headless-batch.ts"
import type { HeadlessProbeRuntime } from "./headless-identity.ts"
import * as runtimeIdentityOwner from "./headless-identity.ts"
import { spawnSync } from "node:child_process"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { fileURLToPath, pathToFileURL } from "node:url"

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

// A source-backed SCRIPTED unit adapter, not a proof of Termless delivery. The real comparer
// binds its imported entry bytes and independently reads the engine binding from the owning lock.
async function scriptedRuntimeFixture() {
  const root = mkdtempSync(join(tmpdir(), "terminfo-scripted-replies-"))
  const entry = join(root, "index.mjs")
  const source = `
    import { createXtermBackend } from ${JSON.stringify(import.meta.resolve("@termless/xtermjs"))};
    export function create(script, declaration) {
      const backend = createXtermBackend();
      backend.capabilities.extensions.add("reply-delivery");
      Object.defineProperty(backend, "replyDelivery", { configurable: true, value: declaration });
      if (script) backend.feed = bytes => {
        const reply = script(new TextDecoder().decode(bytes));
        if (reply) backend.onResponse?.(new TextEncoder().encode(reply));
      };
      return backend;
    }
  `
  writeFileSync(entry, source)
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "@terminfo/scripted-reply-fixture" }))
  const git = (...args: string[]) => {
    const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" })
    if (result.status !== 0) throw new Error(`Scripted fixture Git failed: ${result.stderr}`)
    return result.stdout.trim()
  }
  git("init", "-q")
  git("add", "package.json", "index.mjs")
  git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "scripted reply fixture")
  const lock = spawnSync(
    "bun",
    [
      "-e",
      `process.stdout.write(JSON.stringify(Bun.JSONC.parse(await Bun.file(${JSON.stringify(fileURLToPath(new URL("../../bun.lock", import.meta.url)))}).text()).packages["@xterm/headless"]))`,
    ],
    { encoding: "utf8" },
  )
  if (lock.status !== 0) throw new Error(`Engine lock fixture failed: ${lock.stderr}`)
  const [engine, , , lockIntegrity] = JSON.parse(lock.stdout) as [string, unknown, unknown, string]
  if (!lockIntegrity.startsWith("sha512-")) throw new Error("Owning lock has no xterm registry integrity")
  const declaration = {
    boundary: "feed-and-getCursor" as const,
    adapterSources: [{ path: "index.mjs", blobOid: git("hash-object", entry) }],
    engine: { kind: "registry" as const, lockIntegrity },
  }
  const runtime: HeadlessProbeRuntime = {
    adapterPath: entry,
    adapterPackage: "@terminfo/scripted-reply-fixture",
    adapterType: "js",
    identity: {
      kind: "js",
      runtimeFormat: "js",
      adapterVersion: "unit-fixture",
      engineVersion: engine.slice(engine.lastIndexOf("@") + 1),
      termlessRevision: git("rev-parse", "HEAD"),
      resolvedPath: "node_modules/@xterm/headless",
      integrity: { kind: "registry", lockIntegrity },
    },
  }
  const loaded = (await import(/* @vite-ignore */ pathToFileURL(entry).href)) as {
    create: (script: ((text: string) => string) | undefined, declaration: unknown) => TerminalBackend
  }
  return {
    runtime,
    declaration,
    create: (script?: (text: string) => string) => loaded.create(script, declaration),
    destroy: () => rmSync(root, { recursive: true, force: true }),
  }
}

let fixture: Awaited<ReturnType<typeof scriptedRuntimeFixture>>
beforeAll(async () => {
  fixture = await scriptedRuntimeFixture()
})
// This suite scripts engine replies and identity input. Real identity production owns its own suite;
// lifecycle assertions below independently prove WHEN and HOW OFTEN this owner is consulted.
beforeEach(() => {
  vi.spyOn(runtimeIdentityOwner, "headlessRuntimeIdentity").mockResolvedValue(fixture.runtime.identity)
})
afterAll(() => fixture?.destroy())

// Unit setup for capture/classifier cases; actual engine delivery is checked separately below.
function proven(onSentinel: () => void = () => {}): ProvenReplyPath {
  return { graceMs: 250, onSentinel }
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

function sourceOf(backend: TerminalBackend, path?: ProvenReplyPath) {
  backend.init({ cols: 80, rows: 24 })
  return createLibProbeSource(backend, path)
}

const base64 = (raw: string) => Buffer.from(raw).toString("base64")

test("an unproven context has no sentinel member", () => {
  expect(sourceOf(scripted(() => "")).queryWithSentinelOutcome).toBeUndefined()
})

test("a proven engine that answers DA1 and nothing else gives live's sentinel outcome and facts", () => {
  const onSentinel = vi.fn()
  const ctx = sourceOf(
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
  // Only a DA1 answer in a capture of its own ends the query (@cto 86260f80 rule 4): a DA1-shaped reply in the
  // query's capture is that query's reply, so without DA1's own answer nothing answered the sentinel.
  { name: "a DA1-shaped reply while DA1 never answers", query: DA1, answer: "", reason: "timeout", match: null },
  {
    name: "a DA1-shaped reply and a reply while DA1 never answers",
    query: `${DA1}\x1b[3;7R`,
    answer: "",
    reason: "reply",
    match: ["\x1b[3;7R", "3", "7"],
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
  const ctx = sourceOf(
    scripted((text) => (text === DA1_QUERY ? answer : query)),
    proven(onSentinel),
  )
  const raw = query + answer
  expect(ctx.queryWithSentinelOutcome?.("\x1b[6n", CPR)).toStrictEqual({ match, reason, raw, rawBase64: base64(raw) })
  expect(onSentinel).not.toHaveBeenCalled()
})

// #30559 (@cto 86260f80 rules 1 and 2): DA1 answered in its own capture after bytes that match nothing. The
// outcome is live's, `sentinel` with its facts, which arms G1; the grader refuses a negative over those bytes.
test.each([
  { name: "unmatched bytes, then DA1", query: "\x1b]11;rgb:0000/0000/0000\x1b\\", answer: DA1 },
  { name: "a DA1-shaped reply to the query itself, then DA1", query: DA1, answer: DA1 },
  { name: "unmatched bytes ahead of the answer in DA1's own capture", query: "", answer: `x${DA1}` },
])("$name gives live's sentinel outcome and facts", ({ query, answer }) => {
  const onSentinel = vi.fn()
  const ctx = sourceOf(
    scripted((text) => (text === DA1_QUERY ? answer : query)),
    proven(onSentinel),
  )
  const raw = query + answer
  expect(ctx.queryWithSentinelOutcome?.("\x1b[6n", CPR)).toStrictEqual({
    match: null,
    reason: "sentinel",
    raw,
    rawBase64: base64(raw),
    sentinel: { atMs: expect.any(Number), graceMs: 250 },
  })
  expect(onSentinel).toHaveBeenCalledOnce()
})

test.each([
  { name: "a reply after the DA1 answer", query: "" },
  { name: "a reply after unmatched bytes and the DA1 answer", query: "\x1b]11;rgb:0000/0000/0000\x1b\\" },
])("$name grades by the reply and carries the sentinel facts", ({ query }) => {
  const onSentinel = vi.fn()
  const answer = `${DA1}\x1b[3;7R`
  const ctx = sourceOf(
    scripted((text) => (text === DA1_QUERY ? answer : query)),
    proven(onSentinel),
  )
  expect(ctx.queryWithSentinelOutcome?.("\x1b[6n", CPR)).toStrictEqual({
    match: ["\x1b[3;7R", "3", "7"],
    reason: "reply",
    raw: query + answer,
    rawBase64: base64(query + answer),
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
  const ctx = sourceOf(backend, proven())
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

// Independent positive controls: these are real engine replies, including libvterm, whose
// single DA1 answer does not establish complete delivery for arbitrary output.
test.each([
  ["xtermjs", "\x1b[?1;2c"],
  ["vt100", "\x1b[?1;2c"],
  ["vt220", "\x1b[?62;1;2;6;7;8;9c"],
  ["vterm", "\x1b[?62;4c"],
  ["libvterm", "\x1b[?1;2c"],
])("%s answers DA1 through feedCapture", async (name, answer) => {
  const create = engines[name]
  if (!create) throw new Error(`no engine factory for ${name}`)
  const backend = await create()
  backend.init({ cols: 80, rows: 24 })
  try {
    expect(feedCapture(backend, DA1_QUERY)).toBe(answer)
  } finally {
    backend.destroy()
  }
})

function definitionOf(id: string): ProbeDefinition {
  const definition = ALL_PROBES.find((candidate) => candidate.id === id)
  if (!definition) throw new Error(`no probe definition ${id}`)
  return definition
}

function armsOf(id: string) {
  const { lib, term } = definitionOf(id)
  if (!lib || !term) throw new Error(`${id} has no headless and live arm pair`)
  return { lib, term }
}

/** A proven context that keeps every outcome its sentinel member gave, in order. */
function recordingSource(script: (text: string) => string) {
  const ctx = sourceOf(scripted(script), proven())
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
function replayingLive(outcomes: readonly TerminalQueryOutcome[]): TermProbeSource {
  const queue = [...outcomes]
  const refused = (what: string) => async (): Promise<never> => {
    throw new Error(`the live arm asked for ${what}`)
  }
  return {
    kind: "live",
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
  { id: "extensions.kitty-graphics", when: "silent", replies: {}, outcome: "unsupported" },
  { id: "extensions.kitty-graphics.transmit", when: "silent", replies: {}, outcome: "unsupported" },
]

test.each(ARM_CASES)(
  "$id, $when: the proven headless arm grades exactly as live grades the same outcomes",
  async ({ id, replies, outcome }) => {
    const { lib, term } = armsOf(id)
    const { ctx, outcomes } = recordingSource((text) => (text === DA1_QUERY ? DA1 : (replies[text] ?? "")))
    const headless = lib(ctx)
    expect(outcomes.length, id).toBeGreaterThan(0)
    expect(headless.observation?.outcome, id).toBe(outcome)
    if (outcome === "unsupported") expect(headless.observation?.note, id).toBe("negative by sentinel")
    expect(headless).toStrictEqual(await term(replayingLive(outcomes)))
    // Without the member the arm keeps today's capture-only reading, where silence never grades.
    const plain = lib(sourceOf(scripted((text) => replies[text] ?? "")))
    if (Object.keys(replies).length === 0) {
      expect(plain.observation, id).toBeUndefined()
      expect(plain.tests, id).toContainEqual(
        expect.objectContaining({ status: "test-failure", reason: expect.any(String) }),
      )
    } else expect(plain.observation?.outcome, id).toBe("inconclusive")
  },
)

// #30559 (@cto 86260f80): DA1 answers after bytes that match nothing, here an OSC reply and Terminal.app's DA1-shaped
// answer to DA3. Both collectors give the sentinel outcome over those bytes and the grader refuses a negative over
// them, so the headless arm publishes live's "no-response", never "timeout" where DA1 answered.
test.each([
  { id: "device.xtversion", query: "\x1b[>0q", reply: "\x1b]11;rgb:0000/0000/0000\x1b\\" },
  { id: "device.tertiary-da", query: "\x1b[=c", reply: DA1 },
])("$id: bytes ahead of the DA1 answer grade no-response, as live grades them", async ({ id, query, reply }) => {
  const { lib, term } = armsOf(id)
  const { ctx, outcomes } = recordingSource((text) => (text === DA1_QUERY ? DA1 : text === query ? reply : ""))
  const headless = lib(ctx)
  expect(
    outcomes.map((outcome) => outcome.reason),
    id,
  ).toStrictEqual(["sentinel"])
  expect(headless.observation, id).toStrictEqual({
    outcome: "inconclusive",
    reason: "no-response",
    assertionType: "query_reply",
  })
  expect(headless).toStrictEqual(await term(replayingLive(outcomes)))
})

test("extensions.kitty-keyboard: once detection answers, a silent flags query grades as live grades it", async () => {
  const { lib, term } = armsOf("extensions.kitty-keyboard")
  const detection = `\x1b[?0u${DA1}`
  const fed: string[] = []
  const { ctx, outcomes } = recordingSource((text) => {
    fed.push(text)
    if (text === "\x1b[?u\x1b[c") return detection
    return text === DA1_QUERY ? DA1 : ""
  })
  const headless = lib(ctx)
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
]

test.each(ANSWERED_CASES)(
  "$id: an answered string-graded query keeps the whole read window, DA1 answer included, as live does",
  async ({ id, reply, liveFirst = [] }) => {
    // Both arms draw the same image number, so the live twin can take the headless arm's allocation outcome.
    vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue("0000002a-0000-4000-8000-000000000000")
    const { lib, term } = armsOf(id)
    const { ctx, outcomes } = recordingSource((text) => (text === DA1_QUERY ? DA1 : reply(text)))
    const headless = lib(ctx)
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
    async () => fixture.create((text) => (text === DA1_QUERY ? DA1 : "")),
    "xtermjs",
    [definitionOf("device.xtversion")],
    undefined,
    undefined,
    fixture.runtime,
  )
  expect(batch.observations).toStrictEqual([
    {
      featureId: "device.xtversion",
      outcome: "unsupported",
      assertionType: "query_reply",
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
      const backend = fixture.create((text) => {
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
    fixture.runtime,
  )
  expect(batch.observations).toEqual([])
  expect(batch.ungradedDiagnostics["device.xtversion"]).toMatchObject({
    kind: "collector-error",
    message: expect.stringMatching(
      /^headless xtermjs probe device\.xtversion: late reply after sentinel: 10 bytes "\\u001bP>\|late\\u001b\\\\" at \+\d+ms; refused observation\(outcome=unsupported, assertionType=query_reply, .*\) and assertion\(kind=negative, .*\)$/,
    ),
  })
  expect(batch.results.find((result) => result.featureId === "device.xtversion")).toMatchObject({
    status: "test-failure",
    rawReplyRef: "device.xtversion",
    reason: expect.stringContaining("late reply after sentinel"),
  })
  expect(batch.assertions).toStrictEqual([])
  // The refusal keeps what was observed: the on-time read window, and the late bytes beside it.
  expect(batch.rawReplies).toStrictEqual({
    "collector.replyPath": expect.any(String),
    "device.xtversion": DA1,
    "device.xtversion.late": "\x1bP>|late\x1b\\",
  })
})

// #30576: comparer tests cannot catch a collector that reuses preflight qualification for a
// different initialized callback instance, or forwards capabilities.version as measured identity.
// CTO a73afe52: retain shared declaration/identity once and emit each withholding reason once per batch.
test("qualifies each initialized callback instance and forwards the measured runtime identity", async () => {
  const progress = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
  const runtime = fixture.runtime
  const members: boolean[] = []
  const identities: unknown[] = []
  let instance = 0
  const lifecycle: string[] = []
  vi.mocked(runtimeIdentityOwner.headlessRuntimeIdentity).mockImplementation(async () => {
    lifecycle.push("measure")
    return structuredClone(runtime.identity)
  })
  const batch = await collectBatch(
    async () => {
      const value = fixture.create()
      const index = instance++
      const init = value.init.bind(value)
      vi.spyOn(value, "init").mockImplementation((options) => {
        init(options)
        lifecycle.push("init")
        if (index === 2) value.capabilities.extensions.delete("reply-delivery")
        if (index === 3) Object.defineProperty(value, "replyDelivery", { value: undefined })
      })
      return value
    },
    "xtermjs",
    ["declared", "declared-again", "absent", "changed"].map<ProbeDefinition>((id) => ({
      id,
      term: null,
      lib: (ctx) => {
        members.push(typeof ctx.queryWithSentinelOutcome === "function")
        identities.push(ctx.runtimeIdentity)
        return fakeProbeResult()
      },
    })),
    undefined,
    undefined,
    runtime,
  )
  expect(instance).toBe(4)
  expect(lifecycle).toEqual(["init", "measure", "init", "measure", "init", "measure", "init", "measure"])
  expect(runtimeIdentityOwner.headlessRuntimeIdentity).toHaveBeenCalledTimes(4)
  expect(runtimeIdentityOwner.headlessRuntimeIdentity).toHaveBeenCalledWith("xtermjs", runtime.adapterPackage, "js")
  expect(members).toEqual([true, true, false, false])
  expect(identities).toEqual([runtime.identity, runtime.identity, runtime.identity, runtime.identity])
  expect(JSON.parse(batch.rawReplies["collector.replyPath"]!)).toStrictEqual({
    backend: "xtermjs",
    declaration: fixture.declaration,
    runtimeIdentity: runtime.identity,
    decisions: {
      declared: { member: true, reason: expect.any(String), runtimeIdentity: runtime.identity },
      "declared-again": { member: true, reason: expect.any(String), runtimeIdentity: runtime.identity },
      absent: { member: false, reason: "xtermjs declares no reply delivery", runtimeIdentity: runtime.identity },
      changed: { member: false, reason: "xtermjs declares no reply delivery", runtimeIdentity: runtime.identity },
    },
  })
  expect(progress.mock.calls.map(([chunk]) => String(chunk))).toEqual([
    "headless xtermjs probe declared\n",
    "headless xtermjs probe declared-again\n",
    "headless xtermjs probe absent\n",
    "headless xtermjs declares no reply delivery\n",
    "headless xtermjs probe changed\n",
  ])
})

// N3: preflight custody cannot authorize changed or unreadable executing-instance custody.
test.each(["changed", "unavailable"] as const)(
  "refuses a %s initialized instance identity before the callback",
  async (mode) => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    const measured = { ...fixture.runtime.identity, engineVersion: "different-instance" }
    const measure = vi.mocked(runtimeIdentityOwner.headlessRuntimeIdentity)
    if (mode === "changed") measure.mockResolvedValue(measured)
    else measure.mockRejectedValue(new Error("instance identity unavailable"))
    const value = fixture.create()
    const destroy = vi.spyOn(value, "destroy")
    const callback = vi.fn(() => fakeProbeResult())
    const batch = await collectBatch(
      async () => value,
      "xtermjs",
      [{ id: "instance", term: null, lib: callback }],
      undefined,
      undefined,
      fixture.runtime,
    )
    expect(measure).toHaveBeenCalledOnce()
    expect(callback).not.toHaveBeenCalled()
    expect(destroy).toHaveBeenCalledOnce()
    expect(batch.results[0]).toMatchObject({
      status: "test-failure",
      reason: expect.stringContaining(
        mode === "changed" ? "instance identity differs" : "instance identity unavailable",
      ),
    })
    if (mode === "changed")
      expect(JSON.parse(batch.rawReplies["collector.replyPath"]!).decisions.instance).toMatchObject({
        member: false,
        runtimeIdentity: measured,
      })
  },
)

// Same adapter/version/capabilities without the independent measurement cannot qualify.
test("a declaration without measured runtime identity withholds the member and names lost coverage", async () => {
  vi.spyOn(process.stderr, "write").mockImplementation(() => true)
  const seen: unknown[] = []
  const batch = await collectBatch(async () => fixture.create(), "xtermjs", [
    {
      id: "unmeasured",
      term: null,
      lib: (ctx) => {
        seen.push(ctx.queryWithSentinelOutcome, ctx.runtimeIdentity)
        return fakeProbeResult()
      },
    },
  ])
  expect(seen).toEqual([undefined, undefined])
  expect(JSON.parse(batch.rawReplies["collector.replyPath"]!)).toMatchObject({
    backend: "xtermjs",
    declaration: fixture.declaration,
    decisions: {
      unmeasured: { member: false, reason: "xtermjs has no measured runtime identity for reply delivery" },
    },
  })
})
