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
import type { ObservationFrame, ProbeSuiteManifest } from "@terminfo/probe-defs"
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
): ObservationFrame => ({
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

describe("in-run pixels verdicts", () => {
  it("admits a digest-equality verdict whose assertion cites a frame's regionDigest", () => {
    const loaded = parse(kittyRun())
    const observation = loaded.observations[0]!
    expect(observation.outcome).toBe("supported")
    expect(observation.frames).toHaveLength(6)
    // The digests survive the parse, which is what keeps the verdict recomputable.
    expect(observation.frames?.[3]?.regionDigest).toBe(digest("after-region"))
    expect(observation.frames?.[3]?.pixelsDigest).toBe(digest("after-px"))
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
    expect(() => parse(run)).toThrow(/is not the ref or regionDigest of a frame/)
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
