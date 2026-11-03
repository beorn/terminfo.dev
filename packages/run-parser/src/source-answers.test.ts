/**
 * @failure Source grading quietly treats a broken checkout as missing evidence, or production skips Git facts.
 * @level l1
 * @consumer Canonical parser, collection finalizer and build-time site loader
 * @testonly none
 */
import { afterEach, expect, it, vi } from "vitest"
import { readFileSync } from "node:fs"
import { SOURCE_ANSWERS, type CapturedRunDraft } from "@terminfo/probe-defs"

const control = vi.hoisted(() => ({ mode: "normal" }))
vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof import("node:child_process")>()
  return {
    ...actual,
    spawnSync: vi.fn(
      (command: string, args: string[], options: import("node:child_process").SpawnSyncOptionsWithStringEncoding) => {
        const values = args as string[]
        if (command === "git" && values.includes("-C")) {
          const response = (stdout: string, status = 0) => ({ stdout, stderr: "", status, error: undefined })
          if (control.mode === "remote" && values.includes("get-url")) {
            return response("https://example.test/another.git\n")
          }
          if (control.mode === "shallow" && values.includes("--is-shallow-repository")) return response("true\n")
          if (values.includes("--get-regexp") && control.mode === "absent") return response("", 1)
          if (values.includes("--get-regexp") && control.mode === "promisor") {
            return response("remote.origin.promisor true\n")
          }
          if (values.some((arg) => arg.startsWith("--batch-check"))) {
            if (control.mode === "absent" || control.mode === "promisor") {
              return response(`${String(options.input).trim()} missing\n`)
            }
            if (control.mode === "broken") return { ...response("", 128), stderr: "cannot read object store" }
          }
        }
        return actual.spawnSync(command, args, options)
      },
    ),
  }
})
vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>()
  return {
    ...actual,
    existsSync: vi.fn((path: import("node:fs").PathLike) =>
      control.mode === "checkout" &&
      (String(path).endsWith("/termless") || /[\\/]\.ci-siblings[\\/]\d+$/.test(String(path)))
        ? false
        : actual.existsSync(path),
    ),
  }
})
afterEach(() => {
  control.mode = "normal"
  vi.restoreAllMocks()
  vi.resetModules()
})

// Pure qualification tests cannot distinguish an absent object from a broken environment.
it.each(["checkout", "remote", "shallow", "broken", "promisor", "absent"])(
  "reports source environment %s without inventing an answer",
  async (mode) => {
    const { resolveMeasuredSourceAnswer } = await import("./source-answers.ts")
    const row = SOURCE_ANSWERS.find((row) =>
      row.answers.some((answer) =>
        answer.citedBlobs.some((blob) => blob.repository === "git@github.com:beorn/termless.git"),
      ),
    )!
    control.mode = mode
    const resolve = () =>
      resolveMeasuredSourceAnswer({
        subject: { ...row.subject, version: "unreviewed-version" },
        featureId: row.featureId,
        runtimeIdentity: {
          kind: "js",
          runtimeFormat: "js",
          resolvedPath: "/engine/index.js",
          engineVersion: "unreviewed-version",
          adapterVersion: "1",
          termlessRevision: "0".repeat(40),
          integrity: { kind: "registry", lockIntegrity: "sha512-package" },
        },
      })
    if (mode === "absent") {
      expect(resolve()).toMatchObject({
        kind: "pending",
        reason: "cited source not resolvable at git@github.com:beorn/termless.git@000000000000",
      })
    } else expect(resolve).toThrow(/(?:repository|history|source).*termless.*0000000000000000000000000000000000000000/i)
  },
)

// The writer qualifies source answers; decoding retained results must not require source checkouts.
it("qualifies at the writer and preserves stored answers when decoding", async () => {
  const io = await import("./source-answers.ts")
  const { parseRun, parseSuiteManifest } = await import("./index.ts")
  const { finalizeCollectedDraft } = await import("../../terminfo.dev/src/capture-writer.ts")
  const path = new URL(
    "../../../content/probes-apps/alacritty-0.17.0-linux-f504922f67f074794c588cf3a14e2114.json",
    import.meta.url,
  )
  const bytes = readFileSync(path, "utf8")
  const manifestPath = new URL("../../../content/suites/4b01b0117e18.json", import.meta.url)
  const manifest = parseSuiteManifest(manifestPath.pathname, readFileSync(manifestPath, "utf8"))
  const parse = () => parseRun(path.pathname, bytes, manifest.catalogIds!, new Map([[manifest.probeHash, manifest]]))
  const loaded = parse()
  const raw = JSON.parse(bytes) as Parameters<typeof finalizeCollectedDraft>[0] & { sealedAt?: string }
  delete raw.sealedAt
  const result = raw.results.find((result) => result.reviewRef?.startsWith("["))!
  result.tests = result.tests.map((test) => (test.id === "review" ? { ...test, status: "test-todo" } : test))
  vi.spyOn(io, "resolveMeasuredSourceAnswer").mockImplementation(() => {
    throw new Error("source I/O reached")
  })
  expect(parse()).toEqual(loaded)
  expect(() => finalizeCollectedDraft(raw)).toThrow("source I/O reached")
})

// The retained C1 fixtures already had references from the old review applier. Fresh OSC176
// captures leave the review pending with [], even though their real negative assertion exists.
it.each(["measured", "missing", "positive", "other-feature", "empty-expected", "empty-observed"])(
  "source finalization binds only the current deciding assertion (%s)",
  async (mode) => {
    const { finalizeCollectedDraft } = await import("../../terminfo.dev/src/capture-writer.ts")
    const featureId = "extensions.osc176-app-id"
    const path = new URL(
      "../../../content/probes-libs/vterm-0.10.1-linux-a22f06ca-2505-4c0d-a518-b0b01f8bbe76.json",
      import.meta.url,
    )
    const capture = JSON.parse(readFileSync(path, "utf8")) as Parameters<typeof finalizeCollectedDraft>[0] & {
      sealedAt?: string
    }
    delete capture.sealedAt
    const row = capture.results.find((result) => result.featureId === featureId)!
    row.status = "test-todo"
    row.tests = row.tests.map((test) =>
      test.id === "review" ? { ...test, status: "test-todo", assertionRefs: [] } : test,
    )
    const measured = capture.assertions.flatMap((assertion, index) =>
      assertion.featureId === featureId && assertion.kind === "negative" ? [index] : [],
    )
    expect(measured.length).toBeGreaterThan(0)
    for (const index of measured) {
      const assertion = capture.assertions[index]!
      if (mode === "other-feature") assertion.featureId = "other-feature"
      if (mode === "positive") assertion.kind = "positive"
      if (mode === "empty-expected") assertion.expected = ""
      if (mode === "empty-observed") assertion.observed = ""
    }
    if (mode === "missing") {
      capture.assertions = capture.assertions.filter((assertion) => assertion.featureId !== featureId)
    }
    const assertions = structuredClone(capture.assertions)
    const finalized = finalizeCollectedDraft(capture)
    const result = finalized.results.find((entry) => entry.featureId === featureId)!
    expect(finalized.assertions).toEqual(assertions)
    expect(capture.results.find((entry) => entry.featureId === featureId)?.status).toBe("test-todo")
    if (mode === "measured") {
      expect(result.status).toBe("unsupported")
      expect(result.tests.find((test) => test.id === "review")?.assertionRefs).toEqual(measured)
    } else {
      expect(result.status).toBe("test-todo")
      expect(result.reason).toContain("current deciding negative assertion")
      expect(result.tests.find((test) => test.id === "review")?.assertionRefs).toEqual([])
    }
  },
)

// Requirement: kept answer references identify their own feature and measured subject. The
// existing positive read does not detect a borrowed row or a missing subject context.
it("rejects a kept answer borrowed by another feature or measured subject", async () => {
  const { parseProbeResults, parseRun, parseSuiteManifest } = await import("./index.ts")
  const path = new URL(
    "../../../content/probes-apps/alacritty-0.17.0-linux-f504922f67f074794c588cf3a14e2114.json",
    import.meta.url,
  )
  const raw = JSON.parse(readFileSync(path, "utf8")) as CapturedRunDraft
  const manifestPath = new URL(`../../../content/suites/${raw.probeHash}.json`, import.meta.url)
  const manifest = parseSuiteManifest(manifestPath.pathname, readFileSync(manifestPath, "utf8"))
  const read = (value: unknown) =>
    parseRun(path.pathname, JSON.stringify(value), manifest.catalogIds ?? [], new Map([[raw.probeHash, manifest]]))
  const original = read(raw)
  const sourceResult = raw.results.find(
    (result: { featureId: string }) => result.featureId === "extensions.iterm2-images",
  )!
  expect(original.results?.find((result) => result.featureId === sourceResult.featureId)?.status).toBe(
    sourceResult.status,
  )
  const otherSubject = structuredClone(raw)
  otherSubject.subject.id = "other-measured-terminal"
  expect(() => read(otherSubject)).toThrow("source answer does not apply to measured identity")
  const otherFeature = structuredClone(raw)
  const target = otherFeature.results.find((result: { featureId: string }) => result.featureId === "sgr.bold")!
  target.reviewRef = sourceResult.reviewRef
  target.tests = target.tests.map((test) =>
    test.id === "review" ? { ...test, reviewRef: sourceResult.reviewRef } : test,
  )
  expect(() => read(otherFeature)).toThrow("source answer feature mismatch")
  expect(() =>
    parseProbeResults([sourceResult], "source.json", new Set([sourceResult.featureId]), raw.rawReplies, raw.assertions),
  ).toThrow("source answer requires measured subject context")
})

// #32203: exact00:34 source identity projections from the retained273-cell drafts. The generic
// resolver tests do not detect missing or wrongly cited live underline answers. No historical run is rewritten.
const CURRENT_UNDERLINE_INPUTS: Array<{ engine: string; input: import("@terminfo/probe-defs").SourceAnswerInput }> = [
  {
    engine: "vt100",
    input: {
      subject: {
        kind: "lib",
        id: "vt100",
        version: "0.10.1",
        os: "linux",
        osVersion: "7.0.0-34-generic",
        outerTerminal: null,
        mux: null,
        config: "80x24 default Termless backend",
        permissions: null,
      },
      featureId: "sgr.underline.double",
      runtimeIdentity: {
        kind: "js",
        adapterVersion: "0.10.2",
        termlessRevision: "80dd254111ab82279125555f9ca1e68b112cd7e3",
        resolvedPath: "vendor/vterm/packages/vt100/src/index.ts",
        integrity: {
          kind: "source",
          repository: "git@github.com:beorn/vterm.git",
          revision: "9e99e4d23cdc606fca258b1863aa2be7ae79eed3",
          treeOid: "b941dae48b25ae8825c394750bda5245c9d93dfa",
          cleanTree: true,
        },
        runtimeFormat: "js",
        engineVersion: "0.10.1",
        adapterSources: [
          {
            path: "packages/vt100/src/index.ts",
            blobOid: "99833d737402f9d1d8e3e257e3a255d8aa1facc3",
          },
          {
            path: "packages/vt100/src/backend.ts",
            blobOid: "cdb8be8c5ebbba68a5920cfa4df27c9deb31745a",
          },
        ],
      },
      sourceRevision: "172842d5c3b06da9aba3f1d30c03399d7d522b87",
    },
  },
  {
    engine: "vt220",
    input: {
      subject: {
        kind: "lib",
        id: "vt220",
        version: "0.10.1",
        os: "linux",
        osVersion: "7.0.0-34-generic",
        outerTerminal: null,
        mux: null,
        config: "80x24 default Termless backend",
        permissions: null,
      },
      featureId: "sgr.underline.double",
      runtimeIdentity: {
        kind: "js",
        adapterVersion: "0.10.2",
        termlessRevision: "80dd254111ab82279125555f9ca1e68b112cd7e3",
        resolvedPath: "vendor/vterm/packages/vt220/src/index.ts",
        integrity: {
          kind: "source",
          repository: "git@github.com:beorn/vterm.git",
          revision: "9e99e4d23cdc606fca258b1863aa2be7ae79eed3",
          treeOid: "4205f8936ad1848d1029729f3ada888cd61759a8",
          cleanTree: true,
        },
        runtimeFormat: "js",
        engineVersion: "0.10.1",
        adapterSources: [
          {
            path: "packages/vt220/src/index.ts",
            blobOid: "601dd26eb7e753a5396ebdf72f1ef8ee2cc4355f",
          },
          {
            path: "packages/vt220/src/backend.ts",
            blobOid: "7369e3710e36aa649372fd09011ecfdd6ba47c73",
          },
        ],
      },
      sourceRevision: "172842d5c3b06da9aba3f1d30c03399d7d522b87",
    },
  },
  {
    engine: "vt100-rust",
    input: {
      subject: {
        kind: "lib",
        id: "vt100-rust",
        version: "0.16.2",
        os: "linux",
        osVersion: "7.0.0-34-generic",
        outerTerminal: null,
        mux: null,
        config: "80x24 default Termless backend",
        permissions: null,
      },
      featureId: "sgr.underline.double",
      runtimeIdentity: {
        kind: "native",
        engineVersion: "0.16.2",
        adapterVersion: "0.10.2",
        termlessRevision: "80dd254111ab82279125555f9ca1e68b112cd7e3",
        loadedBinary: {
          path: "vendor/termless/packages/vt100-rust/termless-vt100-rust.node",
          sha256: "84a5b6a3a40a7c16c6bae8b64534b730403df911498bb34bded68c3a17e2d408",
        },
        provenance: {
          sha256: "84a5b6a3a40a7c16c6bae8b64534b730403df911498bb34bded68c3a17e2d408",
          sourceCommit: "286fddf6632e43ccd62f9050be41ec7b2908e43e",
          buildHash: "30b232d295488042b0d6164e881e319dea8d7fae06ac766b3b568fd4832bf074",
          toolchain:
            "rustc 1.94.0 (4a4ef493e 2026-03-02) (built from a source tarball); cargo 1.94.0 (85eff7c80 2026-01-15)",
          lockSha256: "4cf037e4efa648ca41d08b30ef5c4ce7ada29ad61fcad45a7d1aa97bf55391c6",
        },
        adapterSources: [
          {
            path: "packages/vt100-rust/src/index.ts",
            blobOid: "3ddb74f3ae1f79bb356952103853232f69211268",
          },
          {
            path: "packages/vt100-rust/src/backend.ts",
            blobOid: "9b3477c0fedf8586430781e8f4d17019569af98b",
          },
        ],
      },
      sourceRevision: "172842d5c3b06da9aba3f1d30c03399d7d522b87",
    },
  },
  {
    engine: "libvterm",
    input: {
      subject: {
        kind: "lib",
        id: "libvterm",
        version: "0.3.3",
        os: "linux",
        osVersion: "7.0.0-34-generic",
        outerTerminal: null,
        mux: null,
        config: "80x24 default Termless backend",
        permissions: null,
      },
      featureId: "sgr.underline.double",
      runtimeIdentity: {
        kind: "js",
        adapterVersion: "0.10.2",
        termlessRevision: "80dd254111ab82279125555f9ca1e68b112cd7e3",
        resolvedPath: "vendor/termless/packages/libvterm/src/index.ts",
        integrity: {
          kind: "source",
          repository: "git@github.com:beorn/termless.git",
          revision: "80dd254111ab82279125555f9ca1e68b112cd7e3",
          treeOid: "ae0b11bb808b8c402c168869d7caa5a5f62566c2",
          cleanTree: true,
        },
        runtimeFormat: "wasm",
        engineVersion: "0.3.3",
        loadedBinary: {
          path: "vendor/termless/packages/libvterm/wasm/libvterm.wasm",
          sha256: "3d67045bb43c5e4081c70dc58088af8f735416c20df2d7843d765e5aad8ef62a",
        },
        adapterSources: [
          {
            path: "packages/libvterm/src/index.ts",
            blobOid: "2b4708b1081e701b99893ca055ded781dc46cf25",
          },
          {
            path: "packages/libvterm/src/backend.ts",
            blobOid: "eb513ccd443e30c7a869a8ba41f8126e1c0ddf00",
          },
          {
            path: "packages/libvterm/src/wasm-bindings.ts",
            blobOid: "2bbd4d5cf59b8d53db8f5c0329d2ed7853c43e45",
          },
          {
            path: "packages/libvterm/wasm/libvterm.js",
            blobOid: "1e784be87614ab924b96844009919b7c21ce150e",
          },
        ],
      },
      sourceRevision: "172842d5c3b06da9aba3f1d30c03399d7d522b87",
    },
  },
]
const UNDERLINE_COLOUR_IDS = ["sgr.underline.color", "sgr.underline-color-rgb", "sgr.underline-color-indexed"]
const UNDERLINE_STYLE_IDS = [
  "sgr.underline.double",
  "sgr.underline.curly",
  "sgr.underline.dotted",
  "sgr.underline.dashed",
]
it.each(CURRENT_UNDERLINE_INPUTS)(
  "qualifies the current $engine underline negatives while leaving SGR59 pending",
  async ({ engine, input }) => {
    const { resolveMeasuredSourceAnswer } = await import("./source-answers.ts")
    const styles = engine === "libvterm" ? UNDERLINE_STYLE_IDS.slice(2) : UNDERLINE_STYLE_IDS
    for (const featureId of [...UNDERLINE_COLOUR_IDS, ...styles]) {
      expect(resolveMeasuredSourceAnswer({ ...input, featureId }), featureId).toMatchObject({
        kind: "answer",
        status: "unsupported",
      })
    }
    expect(resolveMeasuredSourceAnswer({ ...input, featureId: "sgr.underline-color-reset" })).toEqual({ kind: "none" })
  },
)

// Reproducible projection of retained vt100 runfe2b05cf/suite987ca95c0608: one real
// negative and its exact measured context. Existing OSC176 controls own the same linker; no second linker.
const UNDERLINE_RETAINED_CAPTURE = {
  schemaVersion: 4,
  source: {
    kind: "live",
  },
  runId: "fe2b05cf-0cd4-45cc-9677-5b494dacd5b3",
  suiteId: "987ca95c0608",
  probeHash: "987ca95c0608",
  sourceRevision: "172842d5c3b06da9aba3f1d30c03399d7d522b87",
  intendedSubject: {
    kind: "lib",
    id: "vt100",
    os: "linux",
  },
  results: [
    {
      featureId: "sgr.underline.double",
      attempt: {
        scope: "probe",
        startedAt: "2026-11-03T08:36:40.215Z",
      },
      tests: [
        {
          id: "review",
          status: "test-todo",
          attempt: {
            scope: "none",
          },
          assertionRefs: [],
          rawReplyRef: "sgr.underline.double",
          reason: "Cell readback cannot distinguish unsupported double underline from a collapsed underline style",
        },
      ],
      criterionBranch: "source-negative-review",
      assertionType: "buffer_state",
      rawReplyRef: "sgr.underline.double",
      status: "test-todo",
      reason: "Cell readback cannot distinguish unsupported double underline from a collapsed underline style",
    },
  ],
  rawReplies: {
    "sgr.underline.double":
      '{"char":"X","fg":null,"bg":null,"bold":false,"dim":null,"italic":null,"underline":false,"underlineColor":null,"strikethrough":null,"inverse":false,"blink":false,"overline":null,"hidden":false,"wide":false,"continuation":false}',
  },
  assertions: [
    {
      featureId: "sgr.underline.double",
      assertionType: "buffer_state",
      kind: "negative",
      expected: "sgr.underline.double: attribute applied to the rendered X cell",
      observed:
        '{"char":"X","fg":null,"bg":null,"bold":false,"dim":null,"italic":null,"underline":false,"underlineColor":null,"strikethrough":null,"inverse":false,"blink":false,"overline":null,"hidden":false,"wide":false,"continuation":false}',
      rawReplyRef: "sgr.underline.double",
    },
  ],
  screenshotRefs: [],
  runtimeIdentity: {
    kind: "js",
    adapterVersion: "0.10.2",
    termlessRevision: "80dd254111ab82279125555f9ca1e68b112cd7e3",
    resolvedPath: "vendor/vterm/packages/vt100/src/index.ts",
    integrity: {
      kind: "source",
      repository: "git@github.com:beorn/vterm.git",
      revision: "9e99e4d23cdc606fca258b1863aa2be7ae79eed3",
      treeOid: "b941dae48b25ae8825c394750bda5245c9d93dfa",
      cleanTree: true,
    },
    runtimeFormat: "js",
    engineVersion: "0.10.1",
    adapterSources: [
      {
        path: "packages/vt100/src/index.ts",
        blobOid: "99833d737402f9d1d8e3e257e3a255d8aa1facc3",
      },
      {
        path: "packages/vt100/src/backend.ts",
        blobOid: "cdb8be8c5ebbba68a5920cfa4df27c9deb31745a",
      },
    ],
  },
  subject: {
    kind: "lib",
    id: "vt100",
    version: "0.10.1",
    os: "linux",
    osVersion: "7.0.0-34-generic",
    outerTerminal: null,
    mux: null,
    config: "80x24 default Termless backend",
    permissions: null,
  },
  identity: "unverified",
  measuredAt: "2026-11-03T08:36:47.070Z",
  origin: {
    kind: "collector",
  },
} as CapturedRunDraft
it.each(["measured", "positive", "other-feature", "missing"])(
  "keeps the retained underline witness at the collection/reader boundary (%s)",
  async (mode) => {
    const { finalizeCollectedDraft } = await import("../../terminfo.dev/src/capture-writer.ts")
    const { parseProbeResults } = await import("./index.ts")
    const capture = structuredClone(UNDERLINE_RETAINED_CAPTURE)
    const featureId = "sgr.underline.double"
    if (mode === "positive") capture.assertions[0]!.kind = "positive"
    if (mode === "other-feature") capture.assertions[0]!.featureId = "sgr.underline.single"
    if (mode === "missing") capture.assertions = []
    const before = structuredClone(capture)
    const finalized = finalizeCollectedDraft(capture)
    expect(capture).toEqual(before)
    expect(finalized.assertions).toEqual(before.assertions)
    const result = finalized.results[0]!
    if (mode === "measured") {
      expect(result.status).toBe("unsupported")
      expect(result.tests[0]?.assertionRefs).toEqual([0])
      expect(
        parseProbeResults(
          finalized.results,
          "retained-underline-control",
          new Set([featureId]),
          finalized.rawReplies,
          finalized.assertions,
          [],
          [],
          {
            subject: finalized.subject,
            runtimeIdentity: finalized.runtimeIdentity,
            sourceRevision: finalized.sourceRevision,
          },
        )[0]?.status,
      ).toBe("unsupported")
    } else {
      expect(result.status).toBe("test-todo")
      expect(result.tests[0]?.assertionRefs).toEqual([])
      expect(result.reason).toContain("current deciding negative assertion")
    }
  },
)
