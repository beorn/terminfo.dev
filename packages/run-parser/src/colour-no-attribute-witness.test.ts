/**
 * @failure A colour-no-attribute-witness that cites digests that are not this row's compared cells,
 *   whose expected frame is not the plain-text frame, whose seed never showed the underline, or that
 *   disagrees with its row reaches content/ as proof of an underline-colour negative (#33054).
 * @level l1
 * @consumer run-parser's witness validator for colour-no-attribute-witness assertions.
 * @testonly none
 */
import { createHash } from "node:crypto"
import { expect, it } from "vitest"
import { initializeRunDraft, type ProbeSuiteManifest } from "@terminfo/probe-defs"
import { parseRun } from "./index.ts"

const digest = (seed: string) => `sha256:${createHash("sha256").update(seed).digest("hex")}`
const ROW = "sgr.underline.color"
const SUITE = "452ac343b55d"
const suites = new Map<string, ProbeSuiteManifest>([
  [
    SUITE,
    {
      schemaVersion: 4,
      catalogIds: [ROW],
      probeHash: SUITE,
      adapterVersion: "3.3.1",
      sourceRevision: "4".repeat(40),
      generatedAt: "2026-10-10T22:00:00.000Z",
      probes: { term: [ROW], lib: [], mux: [] },
    },
  ],
])

const rectangle = { x: 29, y: 68, width: 52, height: 29 }
const frame = (region: string, at = rectangle) => ({
  role: "target" as const,
  ref: digest(`ref-${region}`),
  capturedAt: 1,
  label: region,
  kind: "pixels" as const,
  regionDigest: region,
  pixelsDigest: digest(`whole-${region}`),
  regionRectangle: at,
})

const witness = () => ({
  kind: "colour-no-attribute-witness",
  rowId: ROW,
  encoding: "58;2;255;0;128",
  rectangle: { ...rectangle },
  frames: { seed: digest("underlined"), expected: digest("plain"), noAttribute: digest("plain") },
})

const run = () => {
  const draft = initializeRunDraft({
    runId: "xterm-run",
    sourceRevision: "4".repeat(40),
    manifest: { ...suites.get(SUITE)!, schemaVersion: 4 },
    source: { kind: "live" },
    intendedSubject: { kind: "term", id: "xterm" },
  })
  const attempt = { scope: "probe" as const, startedAt: "2026-11-10T15:32:47.000Z" }
  return {
    ...draft,
    subject: {
      kind: "term",
      id: "xterm",
      version: "411",
      os: "linux",
      osVersion: null,
      outerTerminal: null,
      mux: null,
      config: null,
      permissions: null,
    },
    identity: "unverified",
    measuredAt: "2026-11-10T15:32:47.000Z",
    origin: { kind: "collector" },
    rawReplies: { [ROW]: "row" },
    assertions: [
      {
        featureId: ROW,
        kind: "negative",
        assertionType: "screenshot",
        rawReplyRef: ROW,
        expected: `${ROW}: the terminal paints SGR 58;2;255;0;128 as something other than plain text`,
        observed: digest("plain"),
        witness: witness(),
      },
    ],
    screenshotRefs: [],
    results: [
      {
        featureId: ROW,
        status: "probe-todo",
        attempt,
        criterionBranch: "colour-no-attribute-witness",
        rawReplyRef: ROW,
        reason: "open",
        frames: [frame(digest("underlined")), frame(digest("plain"))],
        tests: [{ id: "criterion", status: "probe-todo", attempt, reason: "open" }],
      },
    ],
  }
}

type Witness = ReturnType<typeof witness>
const witnessOf = (value: ReturnType<typeof run>) => (value.assertions[0] as unknown as { witness: Witness }).witness
const parse = (value: Record<string, unknown>) => parseRun("xterm.json", JSON.stringify(value), [ROW], suites)

it("a complete witness round-trips; a missing or unknown field fails", () => {
  expect(parse(run()).assertions[0]?.witness).toMatchObject({ kind: "colour-no-attribute-witness", rowId: ROW })
  const missing = run()
  delete (witnessOf(missing) as { encoding?: string }).encoding
  expect(() => parse(missing)).toThrow(/witness missing encoding/)
  const extra = run()
  ;(witnessOf(extra).frames as Record<string, string>).target = digest("plain")
  expect(() => parse(extra)).toThrow(/unknown .* witness frames field target/)
})

it("refuses a witness whose kind disagrees with the row's branch, or that names another row", () => {
  const branch = run()
  ;(branch.results[0] as { criterionBranch?: string }).criterionBranch = "colour-sibling-separation"
  expect(() => parse(branch)).toThrow(/disagrees with criterionBranch/)
  const other = run()
  witnessOf(other).rowId = "sgr.underline-color-rgb"
  expect(() => parse(other)).toThrow(/witness rowId sgr.underline-color-rgb is not this row/)
})

it("refuses digests that are not this row's compared cells, and frames that do not prove the decision", () => {
  const absent = run()
  witnessOf(absent).frames.seed = digest("missing")
  expect(() => parse(absent)).toThrow(/frames.seed is not a frame digest of this row/)
  // A frame's whole-window digest is not the cells compared.
  const whole = run()
  witnessOf(whole).frames.seed = digest(`whole-${digest("underlined")}`)
  expect(() => parse(whole)).toThrow(/frames.seed is not a frame digest of this row/)
  const painted = run()
  witnessOf(painted).frames.expected = digest("underlined")
  expect(() => parse(painted)).toThrow(/expected frame is not the no-attribute frame/)
  const noSeed = run()
  witnessOf(noSeed).frames.seed = digest("plain")
  expect(() => parse(noSeed)).toThrow(/seed frame does not show the attribute/)
})

it("refuses a rectangle that is not where the cited frames were compared", () => {
  const moved = run()
  witnessOf(moved).rectangle = { ...rectangle, y: 97 }
  expect(() => parse(moved)).toThrow(/rectangle does not match/)
})
