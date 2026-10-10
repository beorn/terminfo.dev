/**
 * @failure A capture adapter, driven through a probe that uses region readback, emits an observation the raw-run contract refuses — and the pin that was supposed to catch it never installed a capture adapter at all.
 * @level l0
 * @consumer App probe observations admitted by run-parser.
 * @testonly none
 */
import { createHash } from "node:crypto"
import { expect, test } from "vitest"
import type { ProbeSuiteManifest } from "@terminfo/probe-defs"
import { parseRun } from "@terminfo/run-parser"
import { ALL_PROBES, type CaptureRequest, type ObservationFrame, type ProbeResult, type TermContext } from "../index.ts"

const FEATURE = "editing.delete-chars"
const SUITE = "452ac343b55d"
const digest = (seed: string) => `sha256:${createHash("sha256").update(seed).digest("hex")}`
const manifest: ProbeSuiteManifest = {
  probeHash: SUITE,
  adapterVersion: "3.3.1",
  generatedAt: "2026-10-10T22:00:00.000Z",
  probes: { app: [FEATURE], headless: [], mux: [] },
}
const suites = new Map([[SUITE, manifest]])

/** The three capture behaviours the collector must survive, plus the geometry refusal. */
type Mode = "deciding" | "stable" | "unstable" | "sentinel"

interface Harness {
  ctx: TermContext
  /** Exactly the adapter's trace shape: the bytes this run wrote, asked and saw. */
  trace: { writes: string[]; queries: unknown[]; events: unknown[] }
}

function sentinelOutcome(sequence: string, mode: Mode): unknown {
  if (mode === "sentinel" && sequence === "\u001b[16t") {
    return { match: null, reason: "sentinel", raw: "\u001b[?6c", rawBase64: "G1s/NmM=" }
  }
  const reply = sequence === "\u001b[16t" ? ["6;18;36", "18", "36"] : ["4;480;640", "480", "640"]
  return { match: reply, reason: "reply", raw: sequence, rawBase64: "" }
}

/**
 * A context that records everything it emits and installs a capture adapter, which is the thing the
 * pin test never did. The terminal it models answers the pixel geometry, repaints the witness cell
 * after each witness glyph, and reads back the seed, the target and the plain expected frame — so a
 * verdict is decidable when the capture says the target equals the expected frame, and a capture
 * that cannot hold still (unstable) proves the collector's own refusal path runs at all.
 */
function harness(mode: Mode): Harness {
  const trace: Harness["trace"] = { writes: [], queries: [], events: [] }
  let captures = 0
  let measured = 0
  let witnessVersion = 0
  const witnessCell = { top: 3, left: 1, bottom: 3, right: 1 }
  const isWitness = (request: CaptureRequest) =>
    request.cells?.top === witnessCell.top &&
    request.cells?.left === witnessCell.left &&
    request.cells?.bottom === witnessCell.bottom &&
    request.cells?.right === witnessCell.right

  const capture = async (request: CaptureRequest): Promise<ObservationFrame> => {
    captures += 1
    let regionDigest: string
    let pixelsDigest: string
    if (isWitness(request)) {
      regionDigest =
        request.label.includes("capture stability") && mode === "unstable"
          ? digest(`stability:${request.label}`)
          : digest(`witness:${witnessVersion}`)
      pixelsDigest = digest(`window:${witnessVersion}`)
    } else {
      const step = measured
      measured += 1
      regionDigest =
        step === 2
          ? digest("region:expected")
          : step === 0
            ? digest("region:seed")
            : digest(mode === "deciding" ? "region:expected" : "region:unrelated")
      pixelsDigest = digest(`window:step-${step}`)
    }
    return {
      role: request.role,
      label: request.label,
      capturedAt: captures,
      ref: digest(`${request.label}#${captures}`),
      regionDigest,
      pixelsDigest,
    }
  }

  const timed = async (sequence: string) => {
    const outcome = sentinelOutcome(sequence, mode)
    trace.queries.push({ sequence, ...(outcome as object) })
    trace.events.push({ kind: "query", sequence, ...(outcome as object) })
    return outcome
  }

  const ctx: TermContext = {
    cols: 80,
    rows: 24,
    write(text) {
      trace.writes.push(text)
      // The witness glyph is the only write that repaints the terminal in this model.
      if (/^\u001b\[3;1H[0-9]$/.test(text)) witnessVersion += 1
    },
    queryCursorPosition: async () => null,
    measureRenderedWidth: async () => null,
    query: async () => null,
    queryWithSentinel: async () => null,
    queryOutcome: async () => ({ match: null, reason: "timeout", raw: "", rawBase64: "" }),
    queryWithSentinelOutcome: async (sequence) =>
      (await timed(sequence)) as unknown as Awaited<ReturnType<TermContext["queryWithSentinelOutcome"]>>,
    queryMode: async () => null,
    capture,
  }
  return { ctx, trace }
}

/**
 * Assemble the run document the collector's own emission would seal, including the two things the
 * adapter adds at collection time and the probe cannot know: every observation and assertion
 * carries its own rawReplyRef, and the run lists every frame ref it captured.
 */
function assemble(result: ProbeResult, trace: Harness["trace"]) {
  const observation = {
    featureId: FEATURE,
    ...result.observation,
    rawReplyRef: FEATURE,
  }
  const frames = (observation as { frames?: ObservationFrame[] }).frames ?? []
  return {
    schemaVersion: 2,
    runId: `region-readback-contract-${FEATURE}`,
    target: {
      kind: "app",
      id: "kitty",
      version: "0.49.2",
      os: "linux",
      osVersion: null,
      outerTerminal: null,
      mux: null,
      config: null,
      permissions: null,
    },
    identity: "unverified",
    suiteId: SUITE,
    probeHash: SUITE,
    suiteComplete: true,
    sourceRevision: "4".repeat(40),
    measuredAt: "2026-10-10T22:10:00.000Z",
    origin: { kind: "collector" },
    rawReplies: { [FEATURE]: JSON.stringify(trace) },
    assertions: (result.assertions ?? []).map((entry) => ({
      ...entry,
      featureId: FEATURE,
      rawReplyRef: FEATURE,
    })),
    screenshotRefs: [...new Set(frames.map((frame) => frame.ref))],
    observations: [observation],
  }
}

const drive = async (mode: Mode) => {
  const { ctx, trace } = harness(mode)
  const probe = ALL_PROBES.find((candidate) => candidate.id === FEATURE)
  expect(probe, "the probe under test exists in ALL_PROBES").toBeDefined()
  const result = await probe!.term!(ctx)
  return { result, trace, run: assemble(result, trace) }
}

const parse = (run: unknown) =>
  parseRun(`${FEATURE}.json`, JSON.stringify(run), [FEATURE], suites as ReadonlyMap<string, ProbeSuiteManifest>)

test("a deciding capture readback seals a pixels verdict the raw-run contract admits", async () => {
  const { result, run } = await drive("deciding")
  expect(result.observation?.outcome).toBe("supported")
  expect(result.observation?.evidence).toBe("pixels")
  expect(result.observation?.frames?.length).toBeGreaterThanOrEqual(2)
  expect(() => parse(run)).not.toThrow()
  const loaded = parse(run)
  expect(loaded.observations[0]?.frames?.some((frame) => frame.regionDigest !== undefined)).toBe(true)
})

test("a byte-stable capture that decides nothing still seals an observation the contract admits", async () => {
  const { result, run } = await drive("stable")
  expect(result.observation?.outcome).toBe("inconclusive")
  expect(result.observation?.evidence).toBe("pixels")
  expect(result.observation?.screenshotRef).toBeDefined()
  expect(() => parse(run)).not.toThrow()
})

/**
 * The collector's own refusal path: the two stability captures disagree, so region-readback returns
 * pixels with no screenshotRef and no frames. That is shape C of @cto b12b71b2 and it is 28584.
 * This test asserts the post-fix contract, so it must stay red until 28584 lands — the marker comes
 * off with that fix, not before.
 */
test.fails("28584 shape C: a byte-unstable capture's pixels refusal still carries what it captured", async () => {
  const { result, run } = await drive("unstable")
  expect(result.observation?.evidence).toBe("pixels")
  expect(result.observation?.screenshotRef).toBeDefined()
  expect(() => parse(run)).not.toThrow()
})

/**
 * The sentinel reply to CSI 16 t: the geometry query writes bytes and then reports evidence "none",
 * which the zero-byte rule refuses. That is shape B of @cto b12b71b2 and it is 28584, same marker.
 */
test.fails("28584 shape B: a sentinel geometry refusal reports query, not none", async () => {
  const { result, run, trace } = await drive("sentinel")
  expect(result.observation?.evidence).toBe("query")
  expect(trace.queries.length).toBeGreaterThan(0)
  expect(() => parse(run)).not.toThrow()
})
