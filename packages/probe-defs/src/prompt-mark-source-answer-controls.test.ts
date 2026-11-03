/**
 * @failure A prompt-mark cell decides from an uncited answer, or a cited answer at the measured engine revision fails to decide.
 * @level l0
 * @consumer Source-answer resolution and result finalization for the OSC 133/633 mark family
 * @testonly none
 */
import { expect, it } from "vitest"
import { finalizeProbeResult } from "./helpers.ts"
import { SOURCE_ANSWERS, resolveSourceAnswer, type SourceAnswer, type SourceAnswerInput } from "./source-answers.ts"

// The measured subject and identity of the retained 23:34 run (2026-11-03T07-34-03-895Z-11088e3fedfc).
const measured = { kind: "lib" as const, id: "vt100", version: "0.10.1", os: "linux" }
const sourceRevision = "f65d768e3a3365df9582b01d94b83702b7ad3140"
const engine = { repository: "git@github.com:beorn/vterm.git", commit: "9e99e4d23cdc606fca258b1863aa2be7ae79eed3" }
const screenPath = "packages/vt100/src/screen.ts"
const screenOid = "cd71776df5f72918cd06934d724a5c2e3585a89d"
const runtimeIdentity = {
  kind: "js" as const,
  adapterVersion: "0.10.2",
  engineVersion: "0.10.1",
  resolvedPath: "vendor/vterm/packages/vt100/src/index.ts",
  termlessRevision: "80dd254111ab82279125555f9ca1e68b112cd7e3",
  runtimeFormat: "js" as const,
  integrity: {
    kind: "source" as const,
    repository: engine.repository,
    revision: engine.commit,
    treeOid: "b941dae48b25ae8825c394750bda5245c9d93dfa",
    cleanTree: true,
  },
}
const featureId = "extensions.osc133-p"
const reviewTest = {
  id: "review",
  status: "test-todo" as const,
  attempt: { scope: "none" as const },
  reason: "independent source review required",
}
const original = {
  reviewRef: "dev8.prompt-mark-control",
  reviewer: "@dev/8",
  reason: "screen.ts:505-520 handleOSC switch, cases 0/1/2 only: no case 133",
  sources: [`vt100 ${engine.commit} ${screenPath}:505-520`],
}
const cited: SourceAnswer = {
  subject: { ...measured, version: "0.10.0" },
  featureId,
  answers: [
    {
      status: "unsupported",
      citedBlobs: [{ repository: engine.repository, commit: engine.commit, path: screenPath, oid: screenOid }],
      originals: [original],
    },
  ],
}
const input: SourceAnswerInput = { subject: measured, featureId, sourceRevision, runtimeIdentity }

// The shipped 0.4.0 WASM rejects OSC 633 in its pinned parser. The previous controls
// cover vt100/vt220 only; they cannot detect missing Ghostty build-bound decisions.
const ghosttyInput: SourceAnswerInput = {
  subject: { kind: "lib", id: "ghostty", version: "0.4.0", os: "linux" },
  featureId: "extensions.osc633-a",
  sourceRevision: "c65d5abdb6ee7e13ea14eddca0523f75266d63df",
  runtimeIdentity: {
    kind: "js",
    adapterVersion: "0.10.2",
    engineVersion: "0.4.0",
    termlessRevision: "25089207e11420cf7a588987c1dc2683a45e8372",
    resolvedPath: "vendor/ghostty-web/dist/ghostty-web.js",
    runtimeFormat: "wasm",
    loadedBinary: {
      path: "vendor/ghostty-web/ghostty-vt.wasm",
      sha256: "42e84af1b38be94571974a23fa4667c4735ee7a272dcff39afd5cba40dcf48de",
    },
    integrity: {
      kind: "source",
      repository: "git@github.com:beorn/termless.git",
      revision: "25089207e11420cf7a588987c1dc2683a45e8372",
      treeOid: "ad3571a518e9e672e102eb83becc2caa03b9ffc3",
      cleanTree: true,
    },
  },
}
it.each(["a", "b", "c", "d", "e", "p"])("decides Ghostty OSC 633;%s from the shipped build", (suffix) => {
  const featureId = `extensions.osc633-${suffix}`
  const resolution = resolveSourceAnswer(SOURCE_ANSWERS, { ...ghosttyInput, featureId })
  expect(resolution).toMatchObject({ kind: "answer", status: "unsupported" })
  expect(finalizeProbeResult({ featureId, attempt: { scope: "none" }, tests: [reviewTest] }, resolution).status).toBe(
    "unsupported",
  )
})

it("leaves a Ghostty prompt answer pending when its shipped WASM changes", () => {
  const resolution = resolveSourceAnswer(SOURCE_ANSWERS, {
    ...ghosttyInput,
    blobs: [
      {
        repository: "git@github.com:beorn/termless.git",
        path: "vendor/ghostty-web/ghostty-vt.wasm",
        oid: "0".repeat(40),
      },
    ],
  })
  expect(resolution).toMatchObject({ kind: "pending" })
  expect(
    finalizeProbeResult(
      { featureId: ghosttyInput.featureId, attempt: { scope: "none" }, tests: [reviewTest] },
      resolution,
    ).status,
  ).toBe("test-todo")
})

// The live store must carry the citation at the measured version; the 0.10.0 row stays as history
// and is superseded rather than rewritten.
it("cites the engine file in the live vt100 mark answer at the measured version", () => {
  const row = SOURCE_ANSWERS.find(
    (entry) =>
      entry.subject.id === "vt100" && entry.subject.version === measured.version && entry.featureId === featureId,
  )
  expect(row).toBeDefined()
  const blobs = row?.answers.flatMap((answer) => answer.citedBlobs) ?? []
  expect(blobs).toContainEqual({
    repository: engine.repository,
    commit: engine.commit,
    path: screenPath,
    oid: screenOid,
  })
})

// The same control against the retained store: the measured vt100 mark cell decides.
it("decides the live vt100 mark cell at the measured revision", () => {
  expect(resolveSourceAnswer(SOURCE_ANSWERS, input)).toMatchObject({ kind: "answer", status: "unsupported" })
})

// Positive control: a cited answer reviewed at an older engine version decides at the measured
// revision, because the named commit IS the measured revision.
it("decides a mark cell from a cited answer at a drifted version", () => {
  const resolution = resolveSourceAnswer([cited], input)
  expect(resolution).toMatchObject({ kind: "answer", status: "unsupported" })
  const result = finalizeProbeResult({ featureId, attempt: { scope: "none" }, tests: [reviewTest] }, resolution)
  expect(result.status).toBe("unsupported")
  expect(result.tests[0]).toMatchObject({ status: "unsupported" })
})

// Do-nothing negative: the same answer with no citation must decide nothing and leave the
// review test exactly as the probe wrote it.
it("decides nothing from an uncited answer at a drifted version", () => {
  const uncited: SourceAnswer = {
    ...cited,
    answers: [{ ...cited.answers[0]!, citedBlobs: [] }],
  }
  const resolution = resolveSourceAnswer([uncited], input)
  expect(resolution).toMatchObject({ kind: "pending", reason: "cited source not resolvable" })
  const result = finalizeProbeResult({ featureId, attempt: { scope: "none" }, tests: [reviewTest] }, resolution)
  expect(result.status).toBe("test-todo")
  expect(result.tests[0]).toMatchObject({ status: "test-todo" })
})

// The existing P control covered only vt100; eighteen other current mark cells still selected
// unqualified 0.10.0 originals. These are the runtime/source facts in the retained 07:25 author run.
// Each decision must cite both the engine's dispatch and the wrapper that forwards the OSC unchanged.
const currentPromptFeatures = [
  "extensions.semantic-prompts",
  "extensions.osc-633-vscode",
  "extensions.osc133-a",
  "extensions.osc133-b",
  "extensions.osc133-c",
  "extensions.osc133-d",
  "extensions.osc633-a",
  "extensions.osc633-b",
  "extensions.osc633-c",
] as const
const currentPromptContexts = [
  {
    id: "vt100",
    screenOid: "cd71776df5f72918cd06934d724a5c2e3585a89d",
    treeOid: "b941dae48b25ae8825c394750bda5245c9d93dfa",
    indexOid: "99833d737402f9d1d8e3e257e3a255d8aa1facc3",
    backendOid: "cdb8be8c5ebbba68a5920cfa4df27c9deb31745a",
  },
  {
    id: "vt220",
    screenOid: "cc5c5c79b0c882cb1c335f2ccaf2c555884a05ee",
    treeOid: "4205f8936ad1848d1029729f3ada888cd61759a8",
    indexOid: "601dd26eb7e753a5396ebdf72f1ef8ee2cc4355f",
    backendOid: "7369e3710e36aa649372fd09011ecfdd6ba47c73",
  },
] as const

it.each(currentPromptContexts.flatMap((context) => currentPromptFeatures.map((id) => ({ ...context, featureId: id }))))(
  "$id $featureId decides from the measured engine and adapter source",
  (context) => {
    const subject = { ...measured, id: context.id }
    const adapterPath = `packages/${context.id}/src/backend.ts`
    const screen = `packages/${context.id}/src/screen.ts`
    const termlessRevision = "25089207e11420cf7a588987c1dc2683a45e8372"
    const resolution = resolveSourceAnswer(SOURCE_ANSWERS, {
      subject,
      featureId: context.featureId,
      sourceRevision: "dc96de335161c02f879a062e85a9be54393e17aa",
      runtimeIdentity: {
        ...runtimeIdentity,
        termlessRevision,
        resolvedPath: `vendor/vterm/packages/${context.id}/src/index.ts`,
        integrity: { ...runtimeIdentity.integrity, treeOid: context.treeOid },
        adapterSources: [
          { path: `packages/${context.id}/src/index.ts`, blobOid: context.indexOid },
          { path: adapterPath, blobOid: context.backendOid },
        ],
      },
    })
    expect(resolution).toMatchObject({ kind: "answer", status: "unsupported" })
    const row = SOURCE_ANSWERS.find(
      (entry) =>
        entry.subject.id === context.id &&
        entry.subject.version === measured.version &&
        entry.featureId === context.featureId,
    )
    expect(row?.answers.flatMap((answer) => answer.citedBlobs)).toEqual(
      expect.arrayContaining([
        { repository: engine.repository, commit: engine.commit, path: screen, oid: context.screenOid },
        {
          repository: "git@github.com:beorn/termless.git",
          commit: termlessRevision,
          path: adapterPath,
          oid: context.backendOid,
        },
      ]),
    )
  },
)
