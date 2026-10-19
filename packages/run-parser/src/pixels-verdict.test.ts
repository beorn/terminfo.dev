/**
 * @failure A collector run is admitted carrying a pixels verdict that cannot be recomputed from its own frames, or a tampered frame set passes the same rules.
 * @level l2
 * @consumer Every consumer of parseRun: the site matrix, generated analysis, status, admission and the reviewed census.
 * @reach fs-walk vendor/terminfo.dev/content/suites/*.json
 * @reach fs-walk vendor/terminfo.dev/content/probes-apps/*.json vendor/terminfo.dev/content/probes-libs/*.json
 * @reach fs-walk vendor/terminfo.dev/content/probes-mux/*.json
 * @testonly none
 */
import { createHash } from "node:crypto"
import { readFileSync, readdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import {
  cursorProbes,
  editingProbes,
  modesProbes,
  type ObservationFrame,
  type ProbeSuiteManifest,
  type ProbeResult,
  type TermContext,
} from "@terminfo/probe-defs"
import { parseRun } from "./index.ts"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..")
const digest = (seed: string) => `sha256:${createHash("sha256").update(seed).digest("hex")}`
const FEATURE = "editing.delete-chars"
const SUITE = "452ac343b55d"
const TARGET = {
  kind: "app",
  id: "kitty",
  version: "0.49.2",
  os: "linux",
  osVersion: null,
  outerTerminal: null,
  mux: null,
  config: null,
  permissions: null,
} as const
const manifest: ProbeSuiteManifest = {
  probeHash: SUITE,
  adapterVersion: "3.3.1",
  generatedAt: "2026-10-10T22:00:00.000Z",
  probes: { app: [FEATURE], headless: [], mux: [] },
}
const suites = new Map([[SUITE, manifest]])
const catalog = [FEATURE]

const frame = (
  role: ObservationFrame["role"],
  label: string,
  capturedAt: number,
  ref: string,
  regionDigest?: string,
  pixelsDigest?: string,
): Extract<ObservationFrame, { kind?: "pixels" }> => ({
  role,
  label,
  capturedAt,
  ref,
  ...(regionDigest && { regionDigest }),
  ...(pixelsDigest && { pixelsDigest }),
})

const SEED_REGION = digest("kitty:seed-region")

/**
 * The shape kitty linux emitted in the S+1 freeze (collector 452ac343b55d): six frames behind a
 * paint witness, where the target's cell-aligned regionDigest equals the expected frame's — the
 * real run cites sha256:88a04fcc… for both, which is exactly what the assertion binds.
 */
const kittyFrames = (): ObservationFrame[] => [
  frame("control", `${FEATURE}: pre-edit seed — paint witness`, 1, digest("c0"), SEED_REGION, digest("seed-px")),
  frame("control", `${FEATURE}: pre-edit seed`, 2, digest("c0"), digest("seed-measured"), digest("seed-px")),
  frame(
    "control",
    `${FEATURE}: post-sequence target — paint witness`,
    3,
    digest("t"),
    digest("after-witness"),
    digest("after-px"),
  ),
  frame("target", `${FEATURE}: post-sequence target`, 4, digest("t"), digest("after-region"), digest("after-px")),
  frame(
    "control",
    `${FEATURE}: expected frame — paint witness`,
    5,
    digest("e1"),
    digest("expected-witness"),
    digest("expected-px"),
  ),
  frame("control", `${FEATURE}: expected frame`, 6, digest("e2"), digest("after-region"), digest("expected-px")),
]

/**
 * The shape wezterm linux emitted for erase.screen.scrollback: five frames with no region digest
 * at all, and an assertion whose observed JSON cites four of the frames by ref — the equality of
 * capture refs is the entire verdict.
 */
const scrollbackFrames = (): ObservationFrame[] => [
  frame("control", "Bottom of seeded buffer", 1, digest("bottom")),
  frame("control", "After wheel-up before ED3", 2, digest("history")),
  frame("control", "After wheel-down before ED3", 3, digest("bottom")),
  frame("control", "After ED3 at bottom", 4, digest("erased")),
  frame("target", "After ED3 then wheel-up", 5, digest("erased")),
]

const kittyRun = (overrides: Record<string, unknown> = {}) => {
  const frames = kittyFrames()
  return {
    schemaVersion: 2,
    runId: "shape-a-kitty",
    target: TARGET,
    identity: "unverified",
    suiteId: SUITE,
    probeHash: SUITE,
    suiteComplete: true,
    sourceRevision: "4".repeat(40),
    measuredAt: "2026-10-10T22:10:00.000Z",
    origin: { kind: "collector" },
    rawReplies: { [FEATURE]: JSON.stringify({ writes: ["\u001b[1;3H"], queries: [], events: [] }) },
    assertions: [
      {
        featureId: FEATURE,
        kind: "positive",
        rawReplyRef: FEATURE,
        expected: `${FEATURE}: the cell-aligned region equals the same-run expected frame`,
        observed: digest("after-region"),
      },
    ],
    screenshotRefs: [digest("c0"), digest("t"), digest("e1"), digest("e2")],
    observations: [
      {
        featureId: FEATURE,
        outcome: "supported",
        evidence: "pixels",
        screenshotRef: digest("t"),
        rawReplyRef: FEATURE,
        frames,
      },
    ],
    ...overrides,
  }
}

const scrollbackRun = () => ({
  ...kittyRun(),
  runId: "shape-a-wezterm",
  rawReplies: { [FEATURE]: JSON.stringify({ writes: [], queries: [], events: [] }) },
  assertions: [
    {
      featureId: FEATURE,
      kind: "positive",
      rawReplyRef: FEATURE,
      expected: "the erased buffer is no longer reachable by wheel-up",
      observed: JSON.stringify({
        control: digest("bottom"),
        history: digest("history"),
        restored: digest("bottom"),
        erased: digest("erased"),
      }),
    },
  ],
  screenshotRefs: [digest("bottom"), digest("history"), digest("erased")],
  observations: [
    {
      featureId: FEATURE,
      outcome: "supported",
      evidence: "pixels",
      screenshotRef: digest("erased"),
      rawReplyRef: FEATURE,
      frames: scrollbackFrames(),
    },
  ],
})

const parse = (run: Record<string, unknown>) => parseRun("pixels-verdict.json", JSON.stringify(run), catalog, suites)

function callbackFixture(id: string) {
  const writes: string[] = []
  const queries: string[] = []
  const requests: Array<Parameters<NonNullable<TermContext["capture"]>>[0]> = []
  let captureIndex = 0
  const context: TermContext = {
    rows: 24,
    cols: 80,
    write(sequence) {
      writes.push(sequence)
    },
    queryCursorPosition: async () => null,
    measureRenderedWidth: async () => null,
    query: async () => null,
    queryWithSentinel: async () => null,
    queryOutcome: async () => ({ match: null, reason: "timeout", raw: "", rawBase64: "" }),
    queryWithSentinelOutcome: async (sequence) => {
      queries.push(sequence)
      return { match: null, reason: "timeout", raw: "", rawBase64: "" }
    },
    queryMode: async () => null,
    captureGeometry: {
      geometry: { cellWidth: 8, cellHeight: 16, textWidth: 640, textHeight: 384 },
      source: "measured by complete raster calibration",
    },
    capture: async (request) => {
      requests.push(request)
      const { role, label } = request
      captureIndex++
      if (id === "modes.decsscls") {
        // Reference/control bands match; the target band arrives between its two captures.
        const band = request.cells !== undefined && request.cells.top === request.cells.bottom
        const region = band
          ? role === "target" && label.endsWith("t0 band")
            ? "absent-band"
            : "marker-band"
          : role === "control"
            ? "control-witness"
            : `target-witness-${captureIndex}`
        return {
          ...frame(
            role,
            label,
            captureIndex,
            digest(`png-${captureIndex}`),
            digest(region),
            digest(`whole-${captureIndex}`),
          ),
          regionRectangle: { x: 16, y: 16, width: 640, height: band ? 16 : 368 },
        }
      }
      return {
        ...frame(
          role,
          label,
          captureIndex,
          digest(`png-${captureIndex}`),
          digest(
            id === "cursor.hide"
              ? captureIndex === 2
                ? "hidden-cell"
                : "shown-cell"
              : captureIndex <= 2
                ? "seed-cell"
                : `extent-cell-${captureIndex}`,
          ),
          digest(id === "editing.decsace" && captureIndex <= 2 ? "seed-whole" : `whole-${captureIndex}`),
        ),
        regionRectangle: {
          x: 16,
          y: 16,
          width: id === "editing.decsace" ? 64 : 8,
          height: id === "editing.decsace" ? 32 : 16,
        },
      }
    },
  }
  return { context, writes, queries, requests }
}

function parseCallback(id: string, result: ProbeResult, fixture: ReturnType<typeof callbackFixture>) {
  const frames = result.observation?.frames ?? []
  const run = kittyRun({
    rawReplies: { [id]: JSON.stringify({ writes: fixture.writes, queries: fixture.queries, events: [] }) },
    assertions: (result.assertions ?? []).map((entry) => ({ ...entry, featureId: id, rawReplyRef: id })),
    observations: [{ ...result.observation, featureId: id, rawReplyRef: id }],
    screenshotRefs: [
      ...frames.filter((frame) => frame.kind !== "text-cells").map((frame) => frame.ref),
      ...(result.observation?.screenshotRef ? [result.observation.screenshotRef] : []),
    ],
    textSnapshotRefs: frames.filter((frame) => frame.kind === "text-cells").map((frame) => frame.ref),
  })
  const callbackManifest: ProbeSuiteManifest = { ...manifest, probes: { app: [id], headless: [], mux: [] } }
  return parseRun(`${id}.json`, JSON.stringify(run), [id], new Map([[SUITE, callbackManifest]]))
}

describe("in-run pixels verdicts", () => {
  it("parses a decided DECSSCLS verdict whose assertion cites the region digests it compared", async () => {
    const id = "modes.decsscls"
    const probe = modesProbes.find((entry) => entry.id === id)
    if (!probe?.term) throw new Error(`Missing ${id} terminal callback`)
    const fixture = callbackFixture(id)
    const result = await probe.term(fixture.context)
    expect(result.observation?.outcome).toBe("supported")
    // Every digest the assertion cites must be a frame's ref or its cell-aligned region digest.
    const loaded = parseCallback(id, result, fixture)
    expect(loaded.observations[0]?.outcome).toBe("supported")
    expect(loaded.assertions[0]?.kind).toBe("positive")
  })

  it("refuses that same DECSSCLS verdict when its assertion cites no region digest", async () => {
    const id = "modes.decsscls"
    const probe = modesProbes.find((entry) => entry.id === id)
    if (!probe?.term) throw new Error(`Missing ${id} terminal callback`)
    const fixture = callbackFixture(id)
    const result = await probe.term(fixture.context)
    const assertion = result.assertions?.[0]
    if (!assertion) throw new Error("Missing DECSSCLS assertion")
    assertion.observed = "the target pair moved between two frames of the same rectangle"
    expect(() => parseCallback(id, result, fixture)).toThrow(/must cite the frame digest it decided on/)
  })

  it.each(["cursor.hide", "editing.decsace"])(
    "parses the real %s verdict when PNG, whole-frame and cell digests differ",
    async (id) => {
      const probe = [...cursorProbes, ...editingProbes].find((entry) => entry.id === id)
      if (!probe?.term) throw new Error(`Missing ${id} terminal callback`)
      const fixture = callbackFixture(id)
      const { context } = fixture
      // Native captures carry real SHA256s for all three representations. Placeholder whole-1
      // values never reached the parser's citation scan and hid the Ghostty collector refusal.
      const result = await probe.term(context)
      expect(result.observation?.outcome).toBe("supported")
      const frames = result.observation?.frames ?? []
      const loaded = parseCallback(id, result, fixture)
      expect(loaded.observations[0]?.outcome).toBe("supported")
      expect(loaded.observations[0]?.frames).toHaveLength(3)
      if (id === "editing.decsace") {
        expect(fixture.requests).toHaveLength(4)
        for (const request of fixture.requests) {
          expect(request.cells).toEqual({ top: 1, left: 1, bottom: 2, right: 8 })
          expect(request.pixelGeometry).toEqual(context.captureGeometry?.geometry)
        }
      }
      const assertion = result.assertions?.[0]
      const pixel = frames.find((frame) => frame.kind !== "text-cells")
      if (!assertion || !pixel || !pixel.pixelsDigest) {
        throw new Error("Missing real callback citation control")
      }
      assertion.observed = pixel.pixelsDigest
      expect(() => parseCallback(id, result, fixture)).toThrow("which is not the ref or a digest of a frame")
    },
  )

  it.each([
    ["missing report", "query", "CSI 16 t"],
    ["short grid", "none", "at least 2x8"],
    ["narrow grid", "none", "at least 2x8"],
    ["text adapter", "none", "text-cells captures"],
    ["text frame", "text", "text-cells"],
    ["missing cells digest", "pixels", "required pixel cells digest"],
    ["missing first digest", "pixels", "required pixel cells digest"],
    ...[1, 2, 3, 4].map((capture) => [`crop ${capture}`, "pixels", "different screen positions"]),
  ])("keeps DECSACE %s inconclusive and parser-valid", async (scenario, evidence, note) => {
    const id = "editing.decsace"
    const probe = editingProbes.find((entry) => entry.id === id)
    if (!probe?.term) throw new Error("Missing DECSACE callback")
    const fixture = callbackFixture(id)
    const { context } = fixture
    if (scenario === "missing report") delete context.captureGeometry
    if (scenario === "short grid") context.rows = 1
    if (scenario === "narrow grid") context.cols = 7
    if (scenario === "text adapter") context.captureKind = "text-cells"
    const capture = context.capture
    if (!capture) throw new Error("Missing fixture capture")
    let index = 0
    context.capture = async (request) => {
      const frame = await capture(request)
      index++
      if (frame.kind === "text-cells") throw new Error("Fixture must start with pixels")
      if (scenario === "text frame") {
        if (!frame.regionDigest || !frame.pixelsDigest) throw new Error("Missing fixture digests")
        return {
          kind: "text-cells",
          role: frame.role,
          label: frame.label,
          capturedAt: frame.capturedAt,
          ref: digest(`text-${index}`),
          cellDigest: frame.regionDigest,
          frameDigest: frame.pixelsDigest,
          cellRectangle: { top: 1, left: 1, bottom: 2, right: 8 },
        }
      }
      if (scenario === "missing cells digest" || (scenario === "missing first digest" && index === 1)) {
        const { regionDigest: _unused, ...withoutCells } = frame
        return withoutCells
      }
      if (scenario === `crop ${index}` && frame.regionRectangle) {
        return { ...frame, regionRectangle: { ...frame.regionRectangle, x: frame.regionRectangle.x + 1 } }
      }
      return frame
    }
    const result = await probe.term(context)
    expect(result.observation).toMatchObject({ outcome: "inconclusive", reason: "insufficient-evidence", evidence })
    expect(result.observation?.note).toContain(note)
    expect(result.assertions).toBeUndefined()
    if (scenario === "short grid" || scenario === "narrow grid" || scenario === "text adapter") {
      expect(fixture.writes).toEqual([])
      expect(fixture.queries).toEqual([])
      expect(fixture.requests).toEqual([])
    }
    expect(parseCallback(id, result, fixture).observations[0]?.outcome).toBe("inconclusive")
  })

  it("admits a digest-equality verdict whose assertion cites a frame's regionDigest", () => {
    const loaded = parse(kittyRun())
    const observation = loaded.observations[0]!
    expect(observation.outcome).toBe("supported")
    expect(observation.frames).toHaveLength(6)
    // The digests survive the parse, which is what keeps the verdict recomputable.
    expect(observation.frames?.[3]?.regionDigest).toBe(digest("after-region"))
    expect(observation.frames?.[3]?.pixelsDigest).toBe(digest("after-px"))
  })

  it("carries a frame's crop rectangle through the parse, and refuses one that is not a rectangle", () => {
    const run = kittyRun()
    const observations = run.observations as Array<Record<string, unknown>>
    const frames = observations[0]!.frames as Array<Record<string, unknown>>
    frames[3]!.regionRectangle = { x: 10, y: 36, width: 104, height: 24 }
    const loaded = parse(run)
    // The rectangle `regionDigest` was taken over survives with it, so a verdict recomputed from
    // this parsed frame can still tell two screen positions apart (29580).
    expect(loaded.observations[0]?.frames?.[3]?.regionRectangle).toEqual({ x: 10, y: 36, width: 104, height: 24 })

    const broken = kittyRun()
    const brokenObservations = broken.observations as Array<Record<string, unknown>>
    const brokenFrames = brokenObservations[0]!.frames as Array<Record<string, unknown>>
    brokenFrames[3]!.regionRectangle = { x: 10, y: 36, width: 0, height: 24 }
    expect(() => parse(broken)).toThrow(/invalid frame regionRectangle/)
  })

  it("admits a verdict whose assertion cites the frame refs it compared", () => {
    const loaded = parse(scrollbackRun())
    expect(loaded.observations[0]?.outcome).toBe("supported")
    expect(loaded.observations[0]?.frames).toHaveLength(5)
  })

  it("refuses a flipped outcome with no matching assertion", () => {
    const run = kittyRun()
    const observations = run.observations as Array<Record<string, unknown>>
    observations[0]!.outcome = "unsupported"
    expect(() => parse(run)).toThrow(/lacks bound negative assertion/)
  })

  it("refuses a verdict that cites a digest no frame carries", () => {
    const run = kittyRun()
    const assertions = run.assertions as Array<Record<string, unknown>>
    assertions[0]!.observed = digest("not-in-any-frame")
    // The same check now serves text verdicts, whose digests are cell-sized.
    expect(() => parse(run)).toThrow(/is not the ref or a digest of a frame/)
  })

  it("refuses a verdict whose observed cites no digest at all", () => {
    const run = kittyRun()
    const assertions = run.assertions as Array<Record<string, unknown>>
    assertions[0]!.observed = "the two frames looked the same"
    expect(() => parse(run)).toThrow(/must cite the frame digest it decided on/)
  })

  it("refuses a lone screenshotRef with no frame pair", () => {
    const run = kittyRun()
    const observations = run.observations as Array<Record<string, unknown>>
    delete observations[0]!.frames
    expect(() => parse(run)).toThrow(/requires control and target frames; a lone screenshotRef stays inconclusive/)
  })

  it("refuses a frame regionDigest that is not a sha256", () => {
    const frames = kittyFrames()
    ;(frames[3] as { regionDigest?: string }).regionDigest = "88a04fcc"
    const run = kittyRun()
    const observations = run.observations as Array<Record<string, unknown>>
    observations[0]!.frames = frames
    expect(() => parse(run)).toThrow(/invalid frame regionDigest 3/)
  })

  it("still parses every committed run", () => {
    const manifests = readdirSync(join(ROOT, "content", "suites"))
      .filter((f) => f.endsWith(".json"))
      .map((f) => JSON.parse(readFileSync(join(ROOT, "content", "suites", f), "utf8")) as ProbeSuiteManifest)
    const trusted = new Map<string, ProbeSuiteManifest>(manifests.map((m) => [m.probeHash, m]))
    const ids = [...new Set(manifests.flatMap((m) => Object.values(m.probes).flat()))]
    let parsed = 0
    const refused: string[] = []
    for (const dir of ["probes-apps", "probes-libs", "probes-mux"]) {
      for (const name of readdirSync(join(ROOT, "content", dir)).filter((f) => f.endsWith(".json"))) {
        try {
          parseRun(`${dir}/${name}`, readFileSync(join(ROOT, "content", dir, name), "utf8"), ids, trusted)
          parsed++
        } catch (cause) {
          refused.push(`${dir}/${name}: ${(cause as Error).message}`)
        }
      }
    }
    expect(refused).toEqual([])
    expect(parsed).toBeGreaterThan(200)
  })
})
