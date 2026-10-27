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
import {
  ALL_PROBES,
  type CaptureRequest,
  type ObservationFrame,
  type ProbeCallbackResult,
  type TermProbeSource,
} from "../index.ts"

const FEATURE = "editing.delete-chars"
const SUITE = "452ac343b55d"
const digest = (seed: string) => `sha256:${createHash("sha256").update(seed).digest("hex")}`
const manifest: ProbeSuiteManifest = {
  probeHash: SUITE,
  adapterVersion: "3.3.1",
  generatedAt: "2026-10-10T22:00:00.000Z",
  probes: { term: [FEATURE], lib: [], mux: [] },
}
/** The three capture behaviours the collector must survive, plus the geometry refusal and a run
 *  whose target equals the row's ignored-attribute frame. */
type Mode = "deciding" | "stable" | "unstable" | "sentinel" | "ignored-attribute"

interface Harness {
  ctx: TermProbeSource
  /** Exactly the adapter's trace shape: the bytes this run wrote, asked and saw. */
  trace: { writes: string[]; queries: unknown[]; events: unknown[] }
  /**
   * Every frame the capture adapter handed back, in order. The collector registers a run screenshot
   * ref for each of these (probes/unified.ts:377), whether or not the observation later cites them
   * as frames, so a run document assembled here must list them the same way.
   */
  frames: ObservationFrame[]
}

function sentinelOutcome(sequence: string, mode: Mode): unknown {
  if (mode === "sentinel" && sequence === "\u001b[16t") {
    return { match: null, reason: "sentinel", raw: "\u001b[?6c", rawBase64: "G1s/NmM=" }
  }
  if (sequence === "\u001b[16t") {
    return { match: ["6;18;36", "18", "36"], reason: "reply", raw: sequence, rawBase64: "" }
  }
  if (sequence === "\u001b[14t") {
    return { match: ["4;480;640", "480", "640"], reason: "reply", raw: sequence, rawBase64: "" }
  }
  // Every other query — CSI 18 t included — gets the DA1 sentinel: this fixture models a terminal
  // that reports its cell size and its text area, and nothing else. Answering it with the 14 t frame
  // would let an 18 t caller read a text area in characters out of a reply that is not one (28763).
  return { match: null, reason: "sentinel", raw: "\u001b[?6c", rawBase64: "G1s/NmM=" }
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
  const frames: ObservationFrame[] = []
  let captures = 0
  let measured = 0
  let witnessVersion = 0
  // Every compared region in this suite spans more than one cell, so a single-cell request is
  // always the reserved paint witness: a baseline or the glyph read itself. Stability reads cover
  // the compared region and must not advance the seed/target/expected-frame counter.
  // Deriving the cell from the request keeps this harness valid for any spec's sentinel, not only
  // the row-3-column-1 sentinel the first two specs happened to use.
  const isWitness = (request: CaptureRequest) =>
    request.cells !== undefined &&
    request.cells.top === request.cells.bottom &&
    request.cells.left === request.cells.right

  const capture = async (request: CaptureRequest): Promise<ObservationFrame> => {
    captures += 1
    let regionDigest: string
    let pixelsDigest: string
    if (request.label.includes("capture stability")) {
      regionDigest = mode === "unstable" ? digest(`stability:${request.label}`) : digest("stability:static")
      pixelsDigest = digest("window:static")
    } else if (isWitness(request)) {
      regionDigest = digest(`witness:${witnessVersion}`)
      pixelsDigest = digest(`window:${witnessVersion}`)
    } else {
      const step = measured
      measured += 1
      regionDigest =
        step === 3
          ? digest("region:ignored")
          : step === 2
            ? digest("region:expected")
            : step === 0
              ? digest("region:seed")
              : digest(
                  mode === "deciding"
                    ? "region:expected"
                    : mode === "ignored-attribute"
                      ? "region:ignored"
                      : "region:unrelated",
                )
      pixelsDigest = digest(`window:step-${step}`)
    }
    const frame: ObservationFrame = {
      role: request.role,
      label: request.label,
      capturedAt: captures,
      ref: digest(`${request.label}#${captures}`),
      regionDigest,
      pixelsDigest,
    }
    frames.push(frame)
    return frame
  }

  const timed = async (sequence: string) => {
    const outcome = sentinelOutcome(sequence, mode)
    trace.queries.push({ sequence, ...(outcome as object) })
    trace.events.push({ kind: "query", sequence, ...(outcome as object) })
    return outcome
  }

  const ctx: TermProbeSource = {
    kind: "live",
    cols: 80,
    rows: 24,
    write(text) {
      trace.writes.push(text)
      // The witness glyph is the only write that repaints the terminal in this model.
      if (/^\u001b\[\d+;\d+H[0-9]$/.test(text)) witnessVersion += 1
    },
    queryCursorPosition: async () => null,
    measureRenderedWidth: async () => null,
    query: async () => null,
    queryWithSentinel: async () => null,
    queryOutcome: async () => ({ match: null, reason: "timeout", raw: "", rawBase64: "" }),
    queryWithSentinelOutcome: async (sequence) =>
      (await timed(sequence)) as unknown as Awaited<ReturnType<TermProbeSource["queryWithSentinelOutcome"]>>,
    queryMode: async () => null,
    capture,
  }
  return { ctx, trace, frames }
}

/**
 * Assemble the run document the collector's own emission would seal, including the two things the
 * adapter adds at collection time and the probe cannot know: every observation and assertion
 * carries its own rawReplyRef, and the run lists every frame ref it captured.
 */
function assemble(result: ProbeCallbackResult, trace: Harness["trace"], frames: ObservationFrame[], feature = FEATURE) {
  const observation = {
    featureId: feature,
    ...result.observation,
    rawReplyRef: feature,
  }
  return {
    schemaVersion: 2,
    runId: `region-readback-contract-${feature}`,
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
    rawReplies: { [feature]: JSON.stringify(trace) },
    assertions: (result.assertions ?? []).map((entry) => ({
      ...entry,
      featureId: feature,
      rawReplyRef: feature,
    })),
    screenshotRefs: [...new Set(frames.map((frame) => frame.ref))],
    observations: [observation],
  }
}

const drive = async (mode: Mode, feature = FEATURE) => {
  const { ctx, trace, frames } = harness(mode)
  const probe = ALL_PROBES.find((candidate) => candidate.id === feature)
  expect(probe, "the probe under test exists in ALL_PROBES").toBeDefined()
  const result = await probe!.term!(ctx)
  return { result, trace, frames, run: assemble(result, trace, frames, feature) }
}

const parse = (run: unknown, feature = FEATURE) => {
  const featureManifest: ProbeSuiteManifest = {
    ...manifest,
    probes: { term: [feature], lib: [], mux: [] },
  }
  return parseRun(
    `${feature}.json`,
    JSON.stringify(run),
    [feature],
    new Map([[SUITE, featureManifest]]) as ReadonlyMap<string, ProbeSuiteManifest>,
  )
}

test("a deciding capture readback seals a pixels verdict the raw-run contract admits", async () => {
  const { result, run } = await drive("deciding")
  expect(result.observation?.outcome).toBe("supported")
  expect(result.observation?.assertionType).toBe("screenshot")
  expect(result.observation?.frames?.length).toBeGreaterThanOrEqual(2)
  expect(() => parse(run)).not.toThrow()
  const loaded = parse(run)
  expect(loaded.observations[0]?.frames?.some((frame) => frame.regionDigest !== undefined)).toBe(true)
})

test("a byte-stable capture that decides nothing still seals an observation the contract admits", async () => {
  const { result, run } = await drive("stable")
  expect(result.observation?.outcome).toBe("inconclusive")
  expect(result.observation?.assertionType).toBe("screenshot")
  expect(result.observation?.screenshotRef).toBeDefined()
  expect(() => parse(run)).not.toThrow()
})

/**
 * The collector's own refusal path: the two stability captures disagree, so region-readback returns
 * inconclusive pixels that cite the capture they took. That is shape C of @cto b12b71b2 and it is
 * 28584, cured by the region-readback fix in 28582 (terminfo 03a9fa6e).
 *
 * Measured 2026-10-10: on that fix alone this test still failed, but not in the product — it failed
 * at `parse(run)` with "screenshotRef … is absent from run". The collector registers a screenshot
 * ref for EVERY capture result (probes/unified.ts:377); `assemble()` here listed only the refs the
 * observation happened to carry as frames, so a refusal that cites without frames looked
 * unwritable. The fixture now lists every captured frame, exactly as the collector does, and no
 * production code changed: with it, 4 passed.
 *
 * The assertions below are @cto's ruling sentence, made executable (0e40f3b1, amended): the
 * unstable branch's run parses, its screenshotRef is the stability capture it took, and it carries
 * no frames — no target frame is fabricated on a path that never reached one.
 */
test("28584 shape C: a byte-unstable capture's pixels refusal still carries what it captured", async () => {
  const { result, run, frames } = await drive("unstable")
  const stabilityFrames = frames.filter((frame) => frame.label.includes("capture stability"))
  const stabilityRefs = stabilityFrames.map((frame) => frame.ref)
  expect(stabilityRefs.length).toBeGreaterThan(0)
  expect(result.observation?.assertionType).toBe("screenshot")
  expect(stabilityRefs).toContain(result.observation?.screenshotRef)
  expect(result.observation?.frames ?? []).toHaveLength(0)
  // The ONE stability shape (@cto round-3c B3): both reads travel in the response, the citation is
  // the second capture taken, and the two digests disagree — that disagreement is the whole point.
  const response = JSON.parse(String(result.response)) as {
    stability: { regionDigest: string[]; pixelsDigest: string[] }
  }
  expect(response.stability.regionDigest).toEqual(stabilityFrames.map((frame) => frame.regionDigest))
  expect(response.stability.pixelsDigest).toEqual(stabilityFrames.map((frame) => frame.pixelsDigest))
  expect(response.stability.regionDigest[0]).not.toBe(response.stability.regionDigest[1])
  expect(result.observation?.screenshotRef).toBe(stabilityFrames[1]?.ref)
  expect(() => parse(run)).not.toThrow()
})

/**
 * The sentinel reply to CSI 16 t: the geometry query writes bytes and then reports evidence "none",
 * which the zero-byte rule refuses. That is shape B of @cto b12b71b2 and it is 28584, cured by the
 * region-readback fix in 28582 (terminfo 03a9fa6e), so the marker came off here: measured at that
 * head, this file is 3 passed | 1 expected fail (shape C) with the marker removed.
 */
test("28584 shape B: a sentinel geometry refusal reports query, not none", async () => {
  const { result, run, trace } = await drive("sentinel")
  expect(result.observation?.assertionType).toBe("query_reply")
  expect(trace.queries.length).toBeGreaterThan(0)
  expect(() => parse(run)).not.toThrow()
})

/**
 * 28638: Erase still captures control/target without a region verdict, so the reader stays at 0/11.
 * The same deciding harness that admits editing.delete-chars must admit erase.character too.
 */
test("erase.character deciding capture readback seals a pixels verdict the raw-run contract admits", async () => {
  const feature = "erase.character"
  const { result, run } = await drive("deciding", feature)
  expect(result.observation?.outcome).toBe("supported")
  expect(result.observation?.assertionType).toBe("screenshot")
  expect(result.observation?.frames?.length).toBeGreaterThanOrEqual(2)
  expect(() => parse(run, feature)).not.toThrow()
  const loaded = parse(run, feature)
  expect(loaded.observations[0]?.frames?.some((frame) => frame.regionDigest !== undefined)).toBe(true)
})

/**
 * 28638: Character Sets still capture control/target without a region verdict, so the reader stays at 0/4.
 */
test("charsets.dec-special deciding capture readback seals a pixels verdict the raw-run contract admits", async () => {
  const feature = "charsets.dec-special"
  const { result, run } = await drive("deciding", feature)
  expect(result.observation?.outcome).toBe("supported")
  expect(result.observation?.assertionType).toBe("screenshot")
  expect(result.observation?.frames?.length).toBeGreaterThanOrEqual(2)
  expect(() => parse(run, feature)).not.toThrow()
  const loaded = parse(run, feature)
  expect(loaded.observations[0]?.frames?.some((frame) => frame.regionDigest !== undefined)).toBe(true)
})

/**
 * @chief 2026-10-11T22:58Z: a selective erase that takes the DECSCA-protected cell, or an EL that
 * drops the current background, is a measured NEGATIVE rather than an unnamed unknown. Both rows
 * now name that frame, so a target equal to it must seal "unsupported" — and still be admissible.
 */
for (const feature of ["erase.selective", "erase.el-with-attrs"] as const) {
  test(`${feature}: a target that drops the row's discriminating attribute seals unsupported`, async () => {
    const { result, run } = await drive("ignored-attribute", feature)
    expect(result.observation?.outcome, feature).toBe("unsupported")
    expect(result.observation?.assertionType, feature).toBe("screenshot")
    expect(result.assertions?.[0]?.kind, feature).toBe("negative")
    expect(() => parse(run, feature), feature).not.toThrow()
  })
}

/**
 * 28450 slice C: every remaining region-readback row must decide the same way through the same
 * harness. A capture adapter that repaints the witness cell and reads the seed, the target and the
 * plain expected frame seals a pixels verdict the raw-run contract admits. Each id is listed BY
 * NAME, so a row that loses its spec or its wiring fails here rather than as a silently smaller
 * count in a census taken later.
 */
const SLICE_C_READBACK_IDS = [
  "editing.insert-chars",
  "editing.insert-lines",
  "editing.delete-lines",
  "editing.repeat-char",
  "editing.decfra",
  "editing.decera",
  "editing.decsera",
  "editing.deccra",
  "editing.deccara",
  "editing.decrara",
  "editing.sl",
  "editing.sr",
  "editing.decic",
  "editing.decdc",
  "erase.line.right",
  "erase.line.left",
  "erase.line.all",
  "erase.screen.below",
  "erase.screen.above",
  "erase.screen.all",
  "erase.selective",
  "erase.el-with-attrs",
  "erase.ed-scroll-region",
  "charsets.utf8",
  "charsets.g0-g1-switching",
  "charsets.dec-line-drawing",
  "text.overwrite",
  "text.reverse-index-scroll",
  "cursor.cup-scroll-region",
  "scrollback.reverse-index",
  "scrollback.scroll-up",
  "scrollback.scroll-down",
  "scrollback.set-region",
]

for (const feature of SLICE_C_READBACK_IDS) {
  test(`${feature}: a deciding capture readback seals a pixels verdict the raw-run contract admits`, async () => {
    const { result, run } = await drive("deciding", feature)
    expect(result.observation?.outcome, feature).toBe("supported")
    expect(result.observation?.assertionType, feature).toBe("screenshot")
    expect(result.observation?.frames?.length ?? 0, feature).toBeGreaterThanOrEqual(2)
    expect(() => parse(run, feature), feature).not.toThrow()
    const loaded = parse(run, feature)
    expect(
      loaded.observations[0]?.frames?.some((frame) => frame.regionDigest !== undefined),
      feature,
    ).toBe(true)
  })
}
