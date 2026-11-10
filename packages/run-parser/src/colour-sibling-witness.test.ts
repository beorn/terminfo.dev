import { createHash } from "node:crypto"
import { expect, it } from "vitest"
import { initializeRunDraft, type ProbeSuiteManifest } from "@terminfo/probe-defs"
import { parseRun } from "./index.ts"

const digest = (seed: string) => `sha256:${createHash("sha256").update(seed).digest("hex")}`
const ROW = "sgr.fg.truecolor"
const SIBLING = "sgr.fg.256"
const SUITE = "452ac343b55d"
const suites = new Map<string, ProbeSuiteManifest>([
  [
    SUITE,
    {
      schemaVersion: 4,
      catalogIds: [ROW, SIBLING],
      probeHash: SUITE,
      adapterVersion: "3.3.1",
      sourceRevision: "4".repeat(40),
      generatedAt: "2026-10-10T22:00:00.000Z",
      probes: { term: [ROW, SIBLING], lib: [], mux: [] },
    },
  ],
])

const rectangle = { x: 29, y: 68, width: 52, height: 29 }
const frame = (region: string) => ({
  role: "target" as const,
  ref: digest(`ref-${region}`),
  capturedAt: 1,
  label: region,
  kind: "pixels" as const,
  regionDigest: region,
  pixelsDigest: digest(`whole-${region}`),
  regionRectangle: rectangle,
})

const witness = () => ({
  kind: "colour-sibling-separation",
  requestedRowId: ROW,
  requestedEncoding: "38;2;255;128;0",
  siblingRowId: SIBLING,
  siblingEncoding: "38;5;67",
  channel: "fg",
  runId: "screen-run",
  rectangle: { x: 29, y: 68, width: 52, height: 29 },
  requested: { seed: digest("flat"), target: digest("flat"), expected: digest("flat"), ignored: digest("flat") },
  sibling: { seed: digest("seed"), target: digest("target") },
  colour: {
    requested: "#ff8000",
    assumption: "the run's default foreground is not (255,128,0)",
    harnessProfile: "--config NONE",
    muxConfig: "/out/mux-empty.conf",
  },
  outerTerminal: {
    id: "kitty",
    version: "0.49.2",
    rowId: ROW,
    status: "supported",
    recordPath: "content/probes-apps/kitty.json",
    recordRunId: "kitty-run",
  },
})

const run = (overrides: Record<string, unknown> = {}) => {
  const manifest = suites.get(SUITE)!
  const draft = initializeRunDraft({
    runId: "screen-run",
    sourceRevision: "4".repeat(40),
    manifest: { ...manifest, schemaVersion: 4 },
    source: { kind: "live" },
    intendedSubject: { kind: "mux", id: "screen" },
  })
  const attempt = { scope: "probe" as const, startedAt: "2026-11-10T15:32:47.000Z" }
  return {
    ...draft,
    subject: {
      kind: "mux",
      id: "screen",
      version: "5.0.2",
      os: "linux",
      osVersion: null,
      outerTerminal: "kitty",
      mux: null,
      config: "/out/mux-empty.conf",
      permissions: null,
    },
    identity: "unverified",
    measuredAt: "2026-11-10T15:32:47.000Z",
    origin: { kind: "collector" },
    rawReplies: { [ROW]: "row", [SIBLING]: "sibling" },
    assertions: [
      {
        featureId: ROW,
        kind: "negative",
        assertionType: "query_reply",
        rawReplyRef: ROW,
        expected: "the terminal paints the requested colour as the default foreground",
        observed: "ACK",
        witness: witness(),
      },
    ],
    screenshotRefs: [],
    results: [
      {
        featureId: ROW,
        status: "probe-todo",
        attempt,
        criterionBranch: "colour-sibling-separation",
        rawReplyRef: ROW,
        reason: "open",
        frames: [frame(digest("flat"))],
        tests: [{ id: "criterion", status: "probe-todo", attempt, reason: "open" }],
      },
      {
        featureId: SIBLING,
        status: "probe-todo",
        attempt,
        rawReplyRef: SIBLING,
        reason: "open",
        frames: [frame(digest("seed")), frame(digest("target"))],
        tests: [{ id: "criterion", status: "probe-todo", attempt, reason: "open" }],
      },
    ],
    ...overrides,
  }
}

const parse = (value: Record<string, unknown>) =>
  parseRun("screen.json", JSON.stringify(value), [ROW, SIBLING], suites)

it("a complete witness round-trips and an unknown assertion field still fails", () => {
  const loaded = parse(run())
  expect(loaded.assertions[0]?.witness).toMatchObject({ kind: "colour-sibling-separation", siblingRowId: SIBLING })
  const extra = run()
  ;(extra.assertions[0] as { unexpected?: string }).unexpected = "no"
  expect(() => parse(extra)).toThrow(/unknown assertion field unexpected/)
})

it("refuses an unknown witness kind and a witness missing a field", () => {
  const badKind = run()
  ;(badKind.assertions[0] as { witness: { kind: string } }).witness.kind = "other"
  expect(() => parse(badKind)).toThrow(/unknown witness kind other/)
  const missing = run()
  delete (missing.assertions[0] as { witness: { outerTerminal?: unknown } }).witness.outerTerminal
  expect(() => parse(missing)).toThrow(/witness missing outerTerminal/)
})

it("refuses a witness on a positive assertion and a witness whose kind disagrees with the branch", () => {
  const positive = run()
  ;(positive.assertions[0] as { kind: string }).kind = "positive"
  expect(() => parse(positive)).toThrow(/negative assertion/)
  const branch = run()
  ;(branch.results[0] as { criterionBranch?: string }).criterionBranch = "other-branch"
  expect(() => parse(branch)).toThrow(/disagrees with criterionBranch/)
})

it("refuses a witness digest that is not a frame of its row, and a proof that is not flat against separated", () => {
  const own = run()
  ;(own.assertions[0] as { witness: { requested: { seed: string } } }).witness.requested.seed = digest("missing")
  expect(() => parse(own)).toThrow(/requested.seed is not a frame digest/)
  const sibling = run()
  ;(sibling.assertions[0] as { witness: { sibling: { target: string } } }).witness.sibling.target = digest("missing")
  expect(() => parse(sibling)).toThrow(/sibling.target is not a frame digest/)
  const uneven = run()
  ;(uneven.assertions[0] as { witness: { requested: { target: string } } }).witness.requested.target = digest("flat")
  ;(uneven.results[0] as { frames: { regionDigest: string }[] }).frames.push(frame(digest("other")))
  ;(uneven.assertions[0] as { witness: { requested: { target: string } } }).witness.requested.target = digest("other")
  expect(() => parse(uneven)).toThrow(/requested frames are not equal/)
  const flatSibling = run()
  const same = digest("same")
  ;(flatSibling.assertions[0] as { witness: { sibling: { seed: string; target: string } } }).witness.sibling = {
    seed: same,
    target: same,
  }
  ;(flatSibling.results[1] as { frames: unknown[] }).frames = [frame(same)]
  expect(() => parse(flatSibling)).toThrow(/sibling frames do not differ/)
})

it("refuses a requested row id that is not this row", () => {
  const bad = run()
  ;(bad.assertions[0] as { witness: { requestedRowId: string } }).witness.requestedRowId = SIBLING
  expect(() => parse(bad)).toThrow(/requestedRowId/)
})

it("refuses a sibling row that is not in the same run", () => {
  const absent = run()
  ;(absent.assertions[0] as { witness: { siblingRowId: string } }).witness.siblingRowId = "sgr.fg.absent"
  expect(() => parse(absent)).toThrow(/sibling row sgr.fg.absent is not in this run/)
})
