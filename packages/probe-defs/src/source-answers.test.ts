/**
 * @failure A kept answer crosses identity without source proof, survives a changed blob, or loses conflicting provenance.
 * @level l0
 * @consumer Source-answer result finalization and canonical run reader
 * @testonly none
 */
import { expect, it } from "vitest"
import { finalizeProbeResult } from "./helpers.ts"
import { parseSourceAnswerKey, resolveSourceAnswer, sourceAnswerKey, type SourceAnswer } from "./source-answers.ts"

const subject = { kind: "lib" as const, id: "example", version: "1.0", os: "linux" }
const answer: SourceAnswer = {
  subject,
  featureId: "extensions.example",
  status: "unsupported",
  answers: [
    { reviewRef: "collector.review.original", reviewer: "@cto", reason: "No handler", sources: ["original citation"] },
  ],
  citedBlobs: [],
}
const blob = {
  repository: "https://example.test/engine.git",
  commit: "a".repeat(40),
  path: "src/parser.ts",
  oid: "b".repeat(40),
}
const bound = { ...answer, citedBlobs: [blob] }

it("keeps the exact subject and original references without inventing a review date", () => {
  const result = resolveSourceAnswer([answer], { subject, featureId: answer.featureId })
  expect(result).toMatchObject({
    kind: "answer",
    status: "unsupported",
    rowKeys: [sourceAnswerKey(subject, answer.featureId)],
    label: "reviewed at 1.0, not re-verified",
  })
  if (result.kind !== "answer") throw new Error("Expected the original subject's answer")
  expect(result.rows.flatMap((row) => row.answers)).toEqual(answer.answers)
  expect(parseSourceAnswerKey(sourceAnswerKey(subject, answer.featureId))).toEqual({
    subject,
    featureId: answer.featureId,
  })
  expect(parseSourceAnswerKey("collector.review.original")).toBeUndefined()
  expect(() => parseSourceAnswerKey("[bad")).toThrow("Invalid source-answer key")
})

it.each([
  ["different engine", { ...subject, id: "other" }],
  ["different OS", { ...subject, os: "darwin" }],
  ["different subject kind", { ...subject, kind: "term" as const }],
  ["different version without blobs", { ...subject, version: "2.0" }],
])("does not borrow a static answer for %s", (_name, current) => {
  expect(resolveSourceAnswer([answer], { subject: current, featureId: answer.featureId })).toEqual({ kind: "none" })
})

it("carries across versions only when every cited blob matches current identity facts", () => {
  const second = { ...blob, path: "src/feature.ts", oid: "c".repeat(40) }
  const row = { ...answer, citedBlobs: [blob, second] }
  const input = { subject: { ...subject, version: "2.0" }, featureId: answer.featureId }
  const unresolved = resolveSourceAnswer([row], { ...input, blobs: [blob] })
  expect(unresolved).toEqual({
    kind: "pending",
    reason: "cited source not resolvable",
    rowKeys: [sourceAnswerKey(subject, answer.featureId)],
  })
  expect(resolveSourceAnswer([row], { ...input, blobs: [blob, second] })).toMatchObject({
    kind: "answer",
    status: "unsupported",
    rows: [row],
  })
  expect(resolveSourceAnswer([bound], { subject, featureId: answer.featureId })).toMatchObject({
    kind: "answer",
    status: "unsupported",
  })
})

it.each(["1.0", "2.0"])(
  "reopens a positively changed source at version %s, including its original version",
  (version) => {
    expect(
      resolveSourceAnswer([bound], {
        subject: { ...subject, version },
        featureId: answer.featureId,
        blobs: [{ ...blob, oid: "d".repeat(40) }],
      }),
    ).toEqual({
      kind: "pending",
      reason: "cited source changed",
      rowKeys: [sourceAnswerKey(subject, answer.featureId)],
    })
  },
)

it("keeps conflicting qualifying rows pending without choosing the newest version", () => {
  const supported = { ...bound, subject: { ...subject, version: "2.0" }, status: "supported" as const }
  const input = { subject: { ...subject, version: "3.0" }, featureId: answer.featureId, blobs: [blob] }
  for (const rows of [
    [bound, supported],
    [supported, bound],
  ]) {
    const result = resolveSourceAnswer(rows, input)
    expect(result.kind).toBe("pending")
    expect(result).toMatchObject({ reason: "kept answers disagree" })
    if (result.kind === "none") throw new Error("Conflicting kept answers must stay visible")
    expect(result.rowKeys).toHaveLength(2)
  }
})

it("discharges only the required source test and preserves an actual failed criterion", () => {
  const input = {
    featureId: answer.featureId,
    attempt: { scope: "probe" as const, startedAt: "2026-11-02T00:00:00Z" },
    tests: [
      {
        id: "review",
        status: "test-todo" as const,
        attempt: { scope: "none" as const },
        reason: "Source review pending",
      },
    ],
  }
  const resolution = resolveSourceAnswer([answer], { subject, featureId: answer.featureId })
  const result = finalizeProbeResult(input, resolution)
  expect(result.status).toBe("unsupported")
  expect(result.reviewRef).toBe(sourceAnswerKey(subject, answer.featureId))
  expect(result.tests[0]).toMatchObject({ status: "unsupported", reviewRef: result.reviewRef, attempt: input.attempt })
  const failed = finalizeProbeResult(
    {
      ...input,
      tests: [
        ...input.tests,
        { id: "criterion", status: "test-failure" as const, attempt: input.attempt, reason: "Actual failed control" },
      ],
    },
    resolution,
  )
  expect(failed.status).toBe("test-failure")
  expect(failed.tests.find((test) => test.id === "criterion")?.reason).toBe("Actual failed control")
})

it("retains a named candidate when cross-version proof is unavailable", () => {
  const input = {
    featureId: answer.featureId,
    attempt: { scope: "probe" as const, startedAt: "2026-11-02T00:00:00Z" },
    tests: [
      {
        id: "review",
        status: "test-todo" as const,
        attempt: { scope: "none" as const },
        reason: "Source review pending",
      },
    ],
  }
  const resolution = resolveSourceAnswer([bound], {
    subject: { ...subject, version: "2.0" },
    featureId: answer.featureId,
  })
  const result = finalizeProbeResult(input, resolution)
  expect(result.status).toBe("test-todo")
  expect(result.reason).toContain("cited source not resolvable")
  expect(result.reason).toContain(sourceAnswerKey(subject, answer.featureId))
})

it("does not accept an unknown C1 row key as a legacy review", () => {
  expect(() =>
    finalizeProbeResult({
      featureId: answer.featureId,
      attempt: { scope: "none" },
      tests: [
        {
          id: "review",
          status: "untestable",
          attempt: { scope: "none" },
          reason: "Unproven",
          reviewRef: sourceAnswerKey(subject, answer.featureId),
        },
      ],
    }),
  ).toThrow("Missing source-answer row")
})

it("resolves cited engine blobs only from the measured clean source revision", () => {
  const runtimeIdentity = {
    kind: "js" as const,
    runtimeFormat: "js" as const,
    resolvedPath: "/engine/index.js",
    engineVersion: "2.0",
    adapterVersion: "1",
    termlessRevision: "e".repeat(40),
    integrity: {
      kind: "source" as const,
      repository: blob.repository,
      revision: blob.commit,
      treeOid: "f".repeat(40),
      cleanTree: true,
    },
  }
  const input = { subject: { ...subject, version: "2.0" }, featureId: answer.featureId, runtimeIdentity }
  expect(resolveSourceAnswer([bound], input)).toMatchObject({ kind: "answer", status: "unsupported" })
  expect(
    resolveSourceAnswer([bound], {
      ...input,
      runtimeIdentity: { ...runtimeIdentity, integrity: { ...runtimeIdentity.integrity, cleanTree: false } },
    }),
  ).toMatchObject({ kind: "pending", reason: "cited source not resolvable" })
  expect(
    resolveSourceAnswer([bound], {
      ...input,
      runtimeIdentity: { ...runtimeIdentity, integrity: { kind: "registry", lockIntegrity: "sha512-package" } },
    }),
  ).toMatchObject({ kind: "pending", reason: "cited source not resolvable" })
})

it("uses measured adapter path OIDs to detect drift even at the original version", () => {
  const adapter = { ...bound, citedBlobs: [{ ...blob, repository: "git@github.com:beorn/termless.git" }] }
  const runtimeIdentity = {
    kind: "js" as const,
    runtimeFormat: "js" as const,
    resolvedPath: "/engine/index.js",
    engineVersion: "1.0",
    adapterVersion: "1",
    termlessRevision: "e".repeat(40),
    integrity: { kind: "registry" as const, lockIntegrity: "sha512-package" },
    adapterSources: [{ path: blob.path, blobOid: "d".repeat(40) }],
  }
  expect(resolveSourceAnswer([adapter], { subject, featureId: answer.featureId, runtimeIdentity })).toMatchObject({
    kind: "pending",
    reason: "cited source changed",
  })
})
