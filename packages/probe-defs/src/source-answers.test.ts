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
const original = {
  reviewRef: "collector.review.original",
  reviewer: "@cto",
  reason: "No handler",
  sources: ["original citation"],
}
const answer: SourceAnswer = {
  subject,
  featureId: "extensions.example",
  answers: [{ status: "unsupported", citedBlobs: [], originals: [original] }],
}
const blob = {
  repository: "https://example.test/engine.git",
  commit: "a".repeat(40),
  path: "src/parser.ts",
  oid: "b".repeat(40),
}
const bound: SourceAnswer = {
  ...answer,
  answers: [{ status: "unsupported", citedBlobs: [blob], originals: [original] }],
}

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
])("does not borrow a static answer for %s", (_name, current) => {
  expect(resolveSourceAnswer([answer], { subject: current, featureId: answer.featureId })).toEqual({ kind: "none" })
})

it("keeps another version's static answer pending with its candidate key", () => {
  expect(
    resolveSourceAnswer([answer], { subject: { ...subject, version: "2.0" }, featureId: answer.featureId }),
  ).toEqual({
    kind: "pending",
    reason: "cited source not resolvable",
    rowKeys: [sourceAnswerKey(subject, answer.featureId)],
  })
})

it("carries across versions only when every cited blob matches current identity facts", () => {
  const second = { ...blob, path: "src/feature.ts", oid: "c".repeat(40) }
  const row: SourceAnswer = {
    ...answer,
    answers: [{ status: "unsupported", citedBlobs: [blob, second], originals: [original] }],
  }
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
  const supported: SourceAnswer = {
    ...bound,
    subject: { ...subject, version: "2.0" },
    answers: [{ status: "supported", citedBlobs: [blob], originals: [original] }],
  }
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
  // A label match cannot excuse a named different source revision whose objects are absent.
  const missingRevision = "c".repeat(40)
  expect(
    resolveSourceAnswer([bound], {
      ...input,
      subject,
      runtimeIdentity: {
        ...runtimeIdentity,
        integrity: { ...runtimeIdentity.integrity, revision: missingRevision },
      },
    }),
  ).toMatchObject({
    kind: "pending",
    reason: `cited source not resolvable at ${blob.repository}@${missingRevision.slice(0, 12)}`,
  })
  for (const [currentOid, kind, reason] of [
    [blob.oid, "answer", undefined],
    ["d".repeat(40), "pending", "cited source changed"],
  ] as const) {
    const resolution = resolveSourceAnswer([bound], {
      ...input,
      subject,
      runtimeIdentity: { ...runtimeIdentity, integrity: { ...runtimeIdentity.integrity, revision: missingRevision } },
      readBlob: (_repository, revision) => (revision === blob.commit ? blob.oid : currentOid),
    })
    expect(resolution).toMatchObject({ kind, ...(reason && { reason }) })
  }
  expect(
    resolveSourceAnswer([bound], {
      ...input,
      readBlob: () => {
        throw new Error("Same immutable commit must not need object reads")
      },
    }),
  ).toMatchObject({ kind: "answer", status: "unsupported" })
  expect(
    resolveSourceAnswer([bound], {
      ...input,
      runtimeIdentity: { ...runtimeIdentity, integrity: { ...runtimeIdentity.integrity, cleanTree: false } },
    }),
  ).toMatchObject({
    kind: "pending",
    reason: `cited source not resolvable at ${blob.repository}@${blob.commit.slice(0, 12)}`,
  })
  expect(
    resolveSourceAnswer([bound], {
      ...input,
      runtimeIdentity: { ...runtimeIdentity, integrity: { kind: "registry", lockIntegrity: "sha512-package" } },
    }),
  ).toMatchObject({ kind: "pending", reason: "cited source not resolvable" })
})

it("uses measured adapter path OIDs to detect drift even at the original version", () => {
  const adapter: SourceAnswer = {
    ...bound,
    answers: [
      {
        status: "unsupported",
        citedBlobs: [{ ...blob, repository: "git@github.com:beorn/termless.git" }],
        originals: [original],
      },
    ],
  }
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

// CTO19:35: merged row-level citations can make both original answers impossible.
// Each original must qualify independently, including at its own subject version.
it("evaluates two OIDs for one path independently and retains the matching original", () => {
  const secondBlob = { ...blob, commit: "c".repeat(40), oid: "d".repeat(40) }
  const row: SourceAnswer = {
    subject,
    featureId: answer.featureId,
    answers: [
      { status: "unsupported", citedBlobs: [blob], originals: [original] },
      {
        status: "unsupported",
        citedBlobs: [secondBlob],
        originals: [{ ...original, reviewRef: "collector.review.second" }],
      },
    ],
  }
  for (const version of ["1.0", "2.0"]) {
    const result = resolveSourceAnswer([row], {
      subject: { ...subject, version },
      featureId: answer.featureId,
      blobs: [blob],
    })
    expect(result).toMatchObject({
      kind: "answer",
      status: "unsupported",
      answers: [{ originals: [{ reviewRef: "collector.review.original" }] }],
    })
    if (result.kind !== "answer") throw new Error("One matching original must remain applicable")
    expect(result.answers).toHaveLength(1)
  }
  expect(
    resolveSourceAnswer([row], { subject, featureId: answer.featureId, blobs: [{ ...blob, oid: "e".repeat(40) }] }),
  ).toMatchObject({ kind: "pending", reason: "cited source changed" })
})

it("keeps differing qualifying originals under one key pending", () => {
  const row: SourceAnswer = {
    subject,
    featureId: answer.featureId,
    answers: [
      { status: "unsupported", citedBlobs: [blob], originals: [original] },
      {
        status: "supported",
        citedBlobs: [blob],
        originals: [{ ...original, reviewRef: "collector.review.different-status" }],
      },
    ],
  }
  const resolution = resolveSourceAnswer([row], { subject, featureId: answer.featureId, blobs: [blob] })
  // Both kept originals travel with the dispute so the cell can name each one (@cto 85a9cfd9).
  expect(resolution).toEqual({
    kind: "pending",
    reason: "kept answers disagree",
    rowKeys: [sourceAnswerKey(subject, answer.featureId)],
    answers: [row.answers[0], row.answers[1]],
  })
})
