/**
 * @failure A text snapshot is admitted as a pixel frame, or a text verdict cannot be recomputed
 *   from the run it was admitted with, so a published decision rests on evidence nobody can
 *   re-check.
 * @level l1
 * @consumer parseRun, the one gate every admitted run passes through.
 * @testonly none
 */
import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import type { ProbeSuiteManifest } from "@terminfo/probe-defs"
import { decodeCollectorRun, parseRun, parseSuiteManifest } from "./index.ts"

const digest = (seed: string) => `sha256:${createHash("sha256").update(seed).digest("hex")}`
const FEATURE = "erase.el"
const SUITE = "452ac343b55d"
const TARGET = {
  kind: "app",
  id: "iterm2",
  version: "3.6.11",
  os: "darwin",
  osVersion: null,
  outerTerminal: null,
  mux: null,
  config: null,
  permissions: null,
} as const
const suites = new Map<string, ProbeSuiteManifest>([
  [
    SUITE,
    {
      probeHash: SUITE,
      adapterVersion: "3.3.1",
      generatedAt: "2026-10-10T22:00:00.000Z",
      probes: { app: [FEATURE], headless: [], mux: [] },
    },
  ],
])

const CELL = digest("text-cells")
const WHOLE = digest("text-whole")
const SNAPSHOT = digest("snapshot-text")

const textFrame = (role: "control" | "target", at: number) => ({
  kind: "text-cells",
  role,
  label: `text frame ${role}`,
  capturedAt: at,
  ref: SNAPSHOT,
  cellDigest: CELL,
  frameDigest: WHOLE,
  cellRectangle: { top: 1, left: 1, bottom: 1, right: 3 },
})

const textRun = (overrides: Record<string, unknown> = {}) => ({
  schemaVersion: 2,
  runId: "text-iterm2",
  target: TARGET,
  identity: "unverified",
  suiteId: SUITE,
  probeHash: SUITE,
  suiteComplete: true,
  sourceRevision: "4".repeat(40),
  measuredAt: "2026-10-17T18:00:00.000Z",
  origin: { kind: "collector" },
  rawReplies: { [FEATURE]: JSON.stringify({ writes: [], queries: [], events: [] }) },
  assertions: [
    {
      featureId: FEATURE,
      kind: "positive",
      rawReplyRef: FEATURE,
      expected: `${FEATURE}: the text cells equal the same-run expected snapshot`,
      observed: CELL,
    },
  ],
  screenshotRefs: [],
  textSnapshotRefs: [SNAPSHOT],
  observations: [
    {
      featureId: FEATURE,
      outcome: "supported",
      evidence: "text",
      rawReplyRef: FEATURE,
      frames: [textFrame("control", 1), textFrame("target", 2)],
    },
  ],
  ...overrides,
})

const parse = (run: Record<string, unknown>) => parseRun("text-frames.json", JSON.stringify(run), [FEATURE], suites)

describe("text frames — admitted only as what they are", () => {
  it("admits a text verdict that cites its frame's cell digest, recomputable from the run alone", () => {
    const loaded = parse(textRun())
    expect(loaded.observations[0]).toMatchObject({ outcome: "supported", evidence: "text" })
    expect(loaded.textSnapshotRefs).toEqual([SNAPSHOT])
  })

  // 30055 AC4: the host the collector recorded survives the parse, so the projection and the site
  // read one structured field instead of parsing a caption out of the raw reply.
  it("carries the console host a text observation recorded, unchanged", () => {
    const host = {
      image: "OpenConsole.exe",
      executablePath: "C:\\Windows\\System32\\OpenConsole.exe",
      executableSha256: digest("console-host"),
    }
    const run = textRun()
    const loaded = parse({ ...run, observations: [{ ...(run.observations as object[])[0], host }] })
    expect(loaded.observations[0]?.host).toEqual(host)
  })

  // A host belongs to a text read alone. On a pixels row it is a stray field, refused by name the
  // same way a pixel frame carrying text fields is — no new gate (@cto ruling 6255e75d condition 2).
  it("refuses a pixels observation that carries a console host, naming the observation and the field", () => {
    const run = textRun()
    const png = digest("some-png")
    const frames = [textFrame("control", 1), textFrame("target", 2)].map(
      ({ kind: _kind, cellDigest: _c, frameDigest: _f, cellRectangle: _r, ...rest }) => ({ ...rest, ref: png }),
    )
    expect(() =>
      parse({
        ...run,
        assertions: [],
        screenshotRefs: [png],
        textSnapshotRefs: [],
        observations: [
          {
            ...(run.observations as object[])[0],
            outcome: "inconclusive",
            reason: "insufficient-evidence",
            evidence: "pixels",
            screenshotRef: png,
            frames,
            host: {
              image: "OpenConsole.exe",
              executablePath: "C:\\Windows\\System32\\OpenConsole.exe",
              executableSha256: digest("console-host"),
            },
          },
        ],
      }),
    ).toThrow(/pixels observation for erase\.el carries host/u)
  })

  it("refuses a pixel frame that carries a text field without declaring kind text-cells", () => {
    const run = textRun()
    const png = digest("some-png")
    // A PIXELS frame with a cellDigest but no kind: exactly the confusion the union prevents.
    const frames = [textFrame("control", 1), textFrame("target", 2)].map((frame) => {
      const { kind: _kind, ...rest } = frame
      return { ...rest, ref: png }
    })
    expect(() =>
      parse({
        ...run,
        screenshotRefs: [png],
        textSnapshotRefs: [],
        observations: [
          {
            ...(run.observations as object[])[0],
            evidence: "pixels",
            screenshotRef: png,
            frames,
          },
        ],
      }),
    ).toThrow(/pixel frame 0 for erase\.el carries text field cellDigest/u)
  })

  it("refuses a text observation that cites a pixel frame", () => {
    const run = textRun()
    const png = digest("some-png")
    const frames = [textFrame("control", 1), textFrame("target", 2)].map(
      ({ kind: _kind, cellDigest: _c, frameDigest: _f, cellRectangle: _r, ...rest }) => rest,
    )
    expect(() =>
      parse({
        ...run,
        screenshotRefs: [png],
        textSnapshotRefs: [SNAPSHOT],
        observations: [{ ...(run.observations as object[])[0], frames }],
      }),
    ).toThrow(/text observation for erase\.el cites a pixels frame/u)
  })

  it("refuses a pixels observation that cites a text frame", () => {
    const run = textRun()
    const png = digest("some-png")
    expect(() =>
      parse({
        ...run,
        screenshotRefs: [png],
        textSnapshotRefs: [SNAPSHOT],
        observations: [
          {
            ...(run.observations as object[])[0],
            evidence: "pixels",
            screenshotRef: png,
            frames: [textFrame("control", 1), textFrame("target", 2)],
          },
        ],
      }),
    ).toThrow(/pixels observation for erase\.el cites a text-cells frame/u)
  })

  it("refuses a text observation that also carries a screenshotRef", () => {
    const run = textRun()
    const png = digest("some-png")
    expect(() =>
      parse({
        ...run,
        screenshotRefs: [png],
        observations: [{ ...(run.observations as object[])[0], screenshotRef: png }],
      }),
    ).toThrow(/text observation erase\.el cannot carry screenshotRef/u)
  })

  it("refuses one digest listed as both a screenshot and a text snapshot", () => {
    const run = textRun()
    expect(() => parse({ ...run, screenshotRefs: [SNAPSHOT] })).toThrow(
      /text snapshot .* is also listed as a screenshotRef/u,
    )
  })

  it("refuses a text verdict with no frames at all", () => {
    const run = textRun()
    const { frames: _frames, ...headless } = (run.observations as Record<string, unknown>[])[0]!
    expect(() => parse({ ...run, observations: [headless] })).toThrow(/requires control and target frames/u)
  })

  it("refuses a verdict that cites only the whole-frame digest, which decided no cells", () => {
    const run = textRun()
    const assertions = [{ ...(run.assertions as object[])[0], observed: WHOLE }]
    expect(() => parse({ ...run, assertions })).toThrow(/not the ref or a digest of a frame/u)
  })

  it("refuses a text frame that carries a pixel field", () => {
    const run = textRun()
    const frames = [textFrame("control", 1), { ...textFrame("target", 2), regionDigest: digest("px") }]
    expect(() => parse({ ...run, observations: [{ ...(run.observations as object[])[0], frames }] })).toThrow(
      /text-cells frame .* carries pixel field regionDigest/u,
    )
  })

  it("refuses a text frame whose ref is listed only as a screenshot", () => {
    const run = textRun()
    expect(() => parse({ ...run, screenshotRefs: [SNAPSHOT], textSnapshotRefs: [] })).toThrow(
      /absent from the run's textSnapshotRefs/u,
    )
  })

  it("refuses a pixel frame whose ref is listed only as a text snapshot", () => {
    const run = textRun()
    const frames = [textFrame("control", 1), textFrame("target", 2)].map(
      ({ kind: _kind, cellDigest: _c, frameDigest: _f, cellRectangle: _r, ...rest }) => rest,
    )
    expect(() =>
      parse({
        ...run,
        screenshotRefs: [digest("some-png")],
        textSnapshotRefs: [SNAPSHOT],
        observations: [
          { ...(run.observations as object[])[0], frames, evidence: "pixels", screenshotRef: digest("some-png") },
        ],
      }),
    ).toThrow(/absent from the run's screenshotRefs/u)
  })

  it("refuses a text verdict whose assertion does not cite a frame digest", () => {
    const run = textRun()
    const assertions = [{ ...(run.assertions as object[])[0], observed: digest("elsewhere") }]
    expect(() => parse({ ...run, assertions })).toThrow(/not the ref or a digest of a frame/u)
  })

  it("refuses a frame kind outside the union", () => {
    const run = textRun()
    const frames = [textFrame("control", 1), { ...textFrame("target", 2), kind: "cells" }]
    expect(() => parse({ ...run, observations: [{ ...(run.observations as object[])[0], frames }] })).toThrow(
      /invalid frame kind cells 1 for erase\.el/u,
    )
  })

  it("refuses a textSnapshotRefs list that is not a list of digests", () => {
    const run = textRun()
    expect(() => parse({ ...run, textSnapshotRefs: ["not-a-digest"] })).toThrow(/invalid textSnapshotRefs/u)
    expect(() => parse({ ...run, textSnapshotRefs: SNAPSHOT })).toThrow(/invalid textSnapshotRefs/u)
  })

  it("refuses a cell rectangle that is malformed, empty or outside the grid", () => {
    const run = textRun()
    const withRectangle = (cellRectangle: unknown) => [
      textFrame("control", 1),
      { ...textFrame("target", 2), cellRectangle },
    ]
    const observation = (frames: unknown[]) => [{ ...(run.observations as object[])[0], frames }]
    expect(() => parse({ ...run, observations: observation(withRectangle({ top: 1, left: 1 })) })).toThrow(
      /invalid frame cellRectangle/u,
    )
    expect(() =>
      parse({
        ...run,
        observations: observation(withRectangle({ top: 2, left: 1, bottom: 1, right: 3 })),
      }),
    ).toThrow(/rectangle is empty/u)
    expect(() =>
      parse({
        ...run,
        observations: observation(withRectangle({ top: 1, left: 3, bottom: 1, right: 2 })),
      }),
    ).toThrow(/rectangle is empty/u)
  })

  it("refuses a cell or frame digest that is not a SHA256", () => {
    const run = textRun()
    const withFrame = (frame: Record<string, unknown>) => [
      textFrame("control", 1),
      { ...textFrame("target", 2), ...frame },
    ]
    const observation = (frames: unknown[]) => [{ ...(run.observations as object[])[0], frames }]
    expect(() => parse({ ...run, observations: observation(withFrame({ cellDigest: "sha256:zz" })) })).toThrow(
      /invalid frame cellDigest/u,
    )
    expect(() => parse({ ...run, observations: observation(withFrame({ frameDigest: "sha256:zz" })) })).toThrow(
      /invalid frame frameDigest/u,
    )
  })
})

// 30035 AC2/AC3: these records enter through the public parser, outside feature observations.
// Existing frame cases cannot detect dropped qualification or claims borrowed from the live suite.
describe("run-owned text qualification ingestion", () => {
  const spec = { version: 1, recipe: "macos-text-cells-v1" }
  const shape = { shape: "mid-line-gap", frames: [textFrame("control", 1), textFrame("target", 2)] }
  const qualification = { ...spec, grid: { rows: 4, cols: 12 }, shapes: [shape] }
  const manifest = { probeHash: SUITE, adapterVersion: "3.3.1", probes: { app: [FEATURE], headless: [], mux: [] } }

  it("carries a partial qualification and only the cited suite's declarations", () => {
    const declared = parseSuiteManifest(
      "suite.json",
      JSON.stringify({ ...manifest, textClaims: [FEATURE], textQualification: spec }),
    )
    const loaded = parseRun(
      "qualification.json",
      JSON.stringify(textRun({ textQualification: qualification })),
      [FEATURE],
      new Map([[SUITE, declared]]),
    )
    expect(loaded.textQualification).toEqual(qualification)
    expect(loaded.textQualificationSpec).toEqual(spec)
    expect(loaded.textClaims).toEqual([FEATURE])
    expect(
      decodeCollectorRun(
        "collector.json",
        JSON.stringify(textRun({ textQualification: qualification })),
        declared,
        "4".repeat(40),
      ).run.textQualification,
    ).toEqual(qualification)
    expect(parse(textRun())).not.toHaveProperty("textQualification")
    expect(parse(textRun())).not.toHaveProperty("textClaims")
    expect(parseSuiteManifest("old.json", JSON.stringify(manifest))).toEqual(manifest)
  })

  it("retains a future version and recipe so the selector can name their mismatch", () => {
    const future = { ...qualification, version: 7, recipe: "future-recipe" }
    expect(parse(textRun({ textQualification: future })).textQualification).toEqual(future)
    expect(
      parseSuiteManifest(
        "future-suite.json",
        JSON.stringify({ ...manifest, textQualification: { version: 7, recipe: "future-recipe" } }),
      ).textQualification,
    ).toEqual({ version: 7, recipe: "future-recipe" })
  })

  it.each([
    [{ ...qualification, shapes: [shape, shape] }, /duplicate textQualification shape mid-line-gap/u],
    [{ ...qualification, pass: true }, /textQualification field pass/u],
    [{ ...qualification, grid: { rows: 0, cols: 12 } }, /textQualification grid/u],
    [
      { ...qualification, shapes: [{ ...shape, frames: [textFrame("target", 1), textFrame("target", 2)] }] },
      /textQualification.*control and target/u,
    ],
    [{ ...qualification, shapes: [{ ...shape, shape: "unknown" }] }, /invalid textQualification shape/u],
    [{ ...qualification, shapes: [{ ...shape, reason: "unavailable" }] }, /textQualification.*frames.*reason/u],
    [{ ...qualification, shapes: [{ shape: "soft-wrap", reason: "" }] }, /textQualification.*reason/u],
    [
      {
        ...qualification,
        shapes: [
          { ...shape, frames: [textFrame("control", 1), { ...textFrame("target", 2), ref: digest("unretained") }] },
        ],
      },
      /textQualification.*textSnapshotRefs/u,
    ],
  ])("refuses malformed qualification with a named cause", (value, reason) => {
    expect(() => parse(textRun({ textQualification: value }))).toThrow(reason)
  })

  it("accepts a named unavailable shape without inventing frames", () => {
    const unavailable = { ...qualification, shapes: [{ shape: "soft-wrap", reason: "snapshot unavailable" }] }
    expect(parse(textRun({ textQualification: unavailable })).textQualification).toEqual(unavailable)
  })

  it.each([
    [{ textClaims: ["foreign"], textQualification: spec }, /textClaims.*app suite membership/u],
    [{ textClaims: [FEATURE, FEATURE], textQualification: spec }, /invalid suite textClaims/u],
    [{ textClaims: [FEATURE], textQualification: { version: 0, recipe: spec.recipe } }, /textQualification.*version/u],
    [{ textClaims: [FEATURE], textQualification: { ...spec, pass: true } }, /textQualification.*field pass/u],
  ])("refuses malformed trusted suite declarations", (metadata, reason) => {
    expect(() => parseSuiteManifest("suite.json", JSON.stringify({ ...manifest, ...metadata }))).toThrow(reason)
  })
})
