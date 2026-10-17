/**
 * @failure A text snapshot is admitted as a pixel frame, or a text verdict cannot be recomputed
 *   from the run it was admitted with, so a published class-A decision rests on evidence nobody can
 *   re-check.
 * @level l1
 * @consumer parseRun, the one gate every admitted run passes through.
 * @testonly none
 */
import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import type { ProbeSuiteManifest } from "@terminfo/probe-defs"
import { parseRun } from "./index.ts"

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
