/**
 * @failure A text snapshot is admitted as a pixel frame, or a text probe result cannot be recomputed
 *   from the run it was admitted with, so a published decision rests on evidence nobody can
 *   re-check.
 * @level l1
 * @consumer parseRun, the one gate every admitted run passes through.
 * @testonly none
 */
import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import { initializeRunDraft, type ProbeSuiteManifest } from "@terminfo/probe-defs"
import { decodeCollectorDraft, parseRun, parseSuiteManifest } from "./index.ts"

const digest = (seed: string) => `sha256:${createHash("sha256").update(seed).digest("hex")}`
const FEATURE = "erase.el"
const SUITE = "452ac343b55d"
const TARGET = {
  kind: "term",
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
      schemaVersion: 4,
      catalogIds: [FEATURE],
      probeHash: SUITE,
      adapterVersion: "3.3.1",
      sourceRevision: "4".repeat(40),
      generatedAt: "2026-10-10T22:00:00.000Z",
      probes: { term: [FEATURE], lib: [], mux: [] },
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

const textRun = (overrides: Record<string, unknown> = {}) => {
  const manifest = suites.get(SUITE)!
  const draft = initializeRunDraft({
    runId: "text-iterm2",
    sourceRevision: "4".repeat(40),
    manifest: { ...manifest, schemaVersion: 4 },
    source: { kind: "live" },
    intendedSubject: { kind: "term", id: "iterm2" },
  })
  draft.subject = TARGET
  draft.identity = "unverified"
  draft.measuredAt = "2026-10-17T18:00:00.000Z"
  draft.origin = { kind: "collector" }
  const attempt = { scope: "probe" as const, startedAt: draft.measuredAt }
  return {
    ...draft,
    rawReplies: { [FEATURE]: JSON.stringify({ writes: [], queries: [], events: [] }) },
    assertions: [
      {
        featureId: FEATURE,
        kind: "positive",
        assertionType: "buffer_state",
        rawReplyRef: FEATURE,
        expected: `${FEATURE}: the text cells equal the same-run expected snapshot`,
        observed: CELL,
      },
    ],
    screenshotRefs: [],
    textSnapshotRefs: [SNAPSHOT],
    results: [
      {
        featureId: FEATURE,
        status: "supported",
        assertionType: "buffer_state",
        attempt,
        rawReplyRef: FEATURE,
        frames: [textFrame("control", 1), textFrame("target", 2)],
        tests: [
          { id: "criterion", status: "supported", attempt, assertionRefs: [0] },
          { id: "text-qualification", status: "supported", attempt },
        ],
      },
    ],
    ...overrides,
  }
}

const parse = (run: Record<string, unknown>) => parseRun("text-frames.json", JSON.stringify(run), [FEATURE], suites)

describe("text frames — admitted only as what they are", () => {
  it("admits a text probe result that cites its frame's cell digest, recomputable from the run alone", () => {
    const loaded = parse(textRun())
    expect(loaded.results![0]).toMatchObject({ status: "supported", assertionType: "buffer_state" })
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
    const loaded = parse({ ...run, results: [{ ...(run.results as object[])[0], host }] })
    expect(loaded.results![0]?.host).toEqual(host)
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
        assertions: [{ ...run.assertions[0]!, assertionType: "screenshot", observed: png }],
        screenshotRefs: [png],
        textSnapshotRefs: [],
        results: [
          {
            ...(run.results as object[])[0],
            assertionType: "screenshot",
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
    ).toThrow(/screenshot observation for erase\.el carries host/u)
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
        results: [
          {
            ...(run.results as object[])[0],
            assertionType: "screenshot",
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
        results: [{ ...(run.results as object[])[0], frames }],
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
        results: [
          {
            ...(run.results as object[])[0],
            assertionType: "screenshot",
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
        results: [{ ...(run.results as object[])[0], screenshotRef: png }],
      }),
    ).toThrow(/text observation erase\.el cannot carry screenshotRef/u)
  })

  it("refuses one digest listed as both a screenshot and a text snapshot", () => {
    const run = textRun()
    expect(() => parse({ ...run, screenshotRefs: [SNAPSHOT] })).toThrow(
      /text snapshot .* is also listed as a screenshotRef/u,
    )
  })

  it("refuses a probe result that cites only the whole-frame digest, which decided no cells", () => {
    const run = textRun()
    const assertions = [{ ...(run.assertions as object[])[0], observed: WHOLE }]
    expect(() => parse({ ...run, assertions })).toThrow(
      "cites only source or whole-frame digests; a probe result must cite a frame's ref or the digest of the cells it compared",
    )
  })

  it("refuses a text frame that carries a pixel field", () => {
    const run = textRun()
    const frames = [textFrame("control", 1), { ...textFrame("target", 2), regionDigest: digest("px") }]
    expect(() => parse({ ...run, results: [{ ...(run.results as object[])[0], frames }] })).toThrow(
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
        results: [
          { ...(run.results as object[])[0], frames, assertionType: "screenshot", screenshotRef: digest("some-png") },
        ],
      }),
    ).toThrow(/absent from the run's screenshotRefs/u)
  })

  it("refuses a text probe result whose assertion does not cite a frame digest", () => {
    const run = textRun()
    const assertions = [{ ...(run.assertions as object[])[0], observed: digest("elsewhere") }]
    expect(() => parse({ ...run, assertions })).toThrow(/not the ref or a digest of a frame/u)
  })

  it("refuses a frame kind outside the union", () => {
    const run = textRun()
    const frames = [textFrame("control", 1), { ...textFrame("target", 2), kind: "cells" }]
    expect(() => parse({ ...run, results: [{ ...(run.results as object[])[0], frames }] })).toThrow(
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
    const observation = (frames: unknown[]) => [{ ...(run.results as object[])[0], frames }]
    expect(() => parse({ ...run, results: observation(withRectangle({ top: 1, left: 1 })) })).toThrow(
      /invalid frame cellRectangle/u,
    )
    expect(() =>
      parse({
        ...run,
        results: observation(withRectangle({ top: 2, left: 1, bottom: 1, right: 3 })),
      }),
    ).toThrow(/rectangle is empty/u)
    expect(() =>
      parse({
        ...run,
        results: observation(withRectangle({ top: 1, left: 3, bottom: 1, right: 2 })),
      }),
    ).toThrow(/rectangle is empty/u)
  })

  it("refuses a cell or frame digest that is not a SHA256", () => {
    const run = textRun()
    const withFrame = (frame: Record<string, unknown>) => [
      textFrame("control", 1),
      { ...textFrame("target", 2), ...frame },
    ]
    const observation = (frames: unknown[]) => [{ ...(run.results as object[])[0], frames }]
    expect(() => parse({ ...run, results: observation(withFrame({ cellDigest: "sha256:zz" })) })).toThrow(
      /invalid frame cellDigest/u,
    )
    expect(() => parse({ ...run, results: observation(withFrame({ frameDigest: "sha256:zz" })) })).toThrow(
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
  const manifest = { ...suites.get(SUITE)!, schemaVersion: 4, catalogIds: [FEATURE] }

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
      decodeCollectorDraft(
        "collector.json",
        JSON.stringify({ ...textRun({ textQualification: qualification }), sealedAt: undefined }),
        declared,
        "4".repeat(40),
      ).run.textQualification,
    ).toEqual(qualification)
    expect(parse(textRun())).not.toHaveProperty("textQualification")
    expect(parse(textRun())).not.toHaveProperty("textClaims")
    expect(parseSuiteManifest("old.json", JSON.stringify(manifest))).toEqual({
      ...manifest,
      probes: { term: [FEATURE], lib: [], mux: [] },
    })
  })

  // 30729 AC3b: a refused shape may carry the diagnostic its reply stated, in exactly the typed
  // record — and never the reply's raw contents, which is what the old payload named.
  it("carries a refused shape's diagnostic and refuses one that names contents", () => {
    const refused = {
      shape: "soft-wrap",
      reason: "Terminal.app returned 29 rows where the measured screen has 30",
      diagnostic: {
        tty: "/dev/ttys003",
        appCols: 100,
        appRows: 30,
        splitRows: 31,
        terminatorRemoved: true,
        rowsAfterPop: 30,
        lineLengths: [100, 2],
        lineLengthsTruncated: false,
      },
    }
    const written = { ...qualification, shapes: [refused] }
    expect(parse(textRun({ textQualification: written })).textQualification).toEqual(written)
    const refusedShape = refused.shape
    const malformations: [Record<string, unknown>, RegExp][] = [
      [
        { ...refused, diagnostic: { ...refused.diagnostic, contents: "raw screen" } },
        new RegExp(`invalid textQualification ${refusedShape} diagnostic`, "u"),
      ],
      [{ ...refused, diagnostic: { ...refused.diagnostic, lineLengths: [-1] } }, /diagnostic line lengths/u],
      [{ ...refused, diagnosticDropped: 0 }, /diagnosticDropped/u],
      [
        {
          shape: refusedShape,
          frames: [textFrame("control", 1), textFrame("target", 2)],
          diagnostic: refused.diagnostic,
        },
        /diagnostic only with its refusal reason/u,
      ],
    ]
    for (const [shapes, pattern] of malformations) {
      expect(() => parse(textRun({ textQualification: { ...qualification, shapes: [shapes] } }))).toThrow(pattern)
    }
  })

  it.each([3, 7])("retains future version %s and recipe without qualifying it", (version) => {
    const future = { ...qualification, version, recipe: "future-recipe" }
    expect(parse(textRun({ textQualification: future })).textQualification).toEqual(future)
    expect(
      parseSuiteManifest(
        "future-suite.json",
        JSON.stringify({ ...manifest, textQualification: { version, recipe: "future-recipe" } }),
      ).textQualification,
    ).toEqual({ version, recipe: "future-recipe" })
  })

  it("reads a declared Windows observer and ownership witness without changing its recorded result", () => {
    const declaration = { version: 2, recipes: ["macos-text-cells-v1", "windows-terminal-text-cells-v1"] }
    const ownership = {
      shape: "console-host-ownership",
      ownership: { cell: { row: 1, col: 1 }, host: "\u0001", observerRow: "☺  " },
    }
    const declared = parseSuiteManifest(
      "suite-v2.json",
      JSON.stringify({ ...manifest, textClaims: [FEATURE], textQualification: declaration }),
    )
    const raw = textRun({
      subject: { ...TARGET, id: "windows-terminal", os: "windows", version: "1.21" },
      intendedSubject: { kind: "term", id: "windows-terminal" },
      textQualification: {
        ...qualification,
        version: 2,
        recipe: "windows-terminal-text-cells-v1",
        shapes: [shape, ownership],
      },
    })
    const loaded = parseRun("uia-v2.json", JSON.stringify(raw), [FEATURE], new Map([[SUITE, declared]]))
    expect(loaded.results).toEqual(raw.results)
    expect(loaded.textQualificationSpec).toEqual(declaration)
    expect(loaded.textQualification?.shapes[1]).toEqual(ownership)

    for (const subject of [
      { ...TARGET, os: "macos" },
      { ...TARGET, id: "kitty", os: "linux" },
    ]) {
      expect(() =>
        parseRun(
          "wrong-context.json",
          JSON.stringify({ ...raw, subject, intendedSubject: { kind: "term", id: subject.id } }),
          [FEATURE],
          new Map([[SUITE, declared]]),
        ),
      ).toThrow(/text qualification.*observer context/u)
    }
    const host = { image: "OpenConsole.exe", executablePath: "C:\\OpenConsole.exe", executableSha256: digest("host") }
    expect(() =>
      parseRun(
        "host-v2.json",
        JSON.stringify({ ...raw, results: [{ ...raw.results[0], host }] }),
        [FEATURE],
        new Map([[SUITE, declared]]),
      ),
    ).toThrow(/text qualification.*observer context/u)
    expect(() =>
      parseRun(
        "undeclared-v2.json",
        JSON.stringify(raw),
        [FEATURE],
        new Map([[SUITE, { ...declared, textClaims: [] }]]),
      ),
    ).toThrow(/text qualification.*observer context/u)
  })

  it.each([
    { cell: { row: 0, col: 1 }, host: "\u0001", observerRow: "☺" },
    { cell: { row: 1, col: 1 }, host: 1, observerRow: "☺" },
    { cell: { row: 1, col: 1 }, host: "\u0001", observerRow: "☺", extra: true },
  ])("refuses malformed raw ownership facts", (ownership) => {
    expect(() =>
      parse(
        textRun({ textQualification: { ...qualification, shapes: [{ shape: "console-host-ownership", ownership }] } }),
      ),
    ).toThrow(/textQualification console-host-ownership/u)
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
