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
