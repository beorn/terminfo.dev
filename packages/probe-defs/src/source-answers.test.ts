/**
 * @failure A kept answer crosses identity without source proof, survives a changed blob, or loses conflicting provenance.
 * @level l0
 * @consumer Source-answer result finalization and canonical run reader
 * @testonly none
 */
import { expect, it } from "vitest"
import { finalizeProbeResult } from "./helpers.ts"
import {
  SOURCE_ANSWER_PENDING_LABELS,
  publicSourceAnswerPendingLabel,
  parseSourceAnswerKey,
  repositoryIdentity,
  resolveSourceAnswer,
  sourceAnswerKey,
  hasUnverifiedSourceAnswerSuffix,
  sourceAnswerVersionLabel,
  type SourceAnswer,
} from "./source-answers.ts"

const subject = { kind: "lib" as const, id: "example", version: "1.0", os: "linux" }

// @cto 18a3b98f: the fixed pending labels are the only phrases a public consumer may forward.
it("publishes only the fixed pending labels", () => {
  expect(Object.values(SOURCE_ANSWER_PENDING_LABELS)).toEqual([
    "cited source changed",
    "kept answers disagree",
    "cited source not resolvable",
  ])
  expect(sourceAnswerVersionLabel("0.4.0")).toBe("reviewed at 0.4.0, not re-verified")
})
// Fixed-label matching is a privacy boundary: qualified producer reasons may carry
// private provenance, while similar prose is not an authorized public cause.
it("forwards only fixed pending causes across producer formats and rejects near prefixes", () => {
  for (const label of ["cited source changed", "kept answers disagree", "cited source not resolvable"]) {
    expect(publicSourceAnswerPendingLabel(label)).toBe(label)
    expect(publicSourceAnswerPendingLabel(`${label}: ["lib","example"]; kept originals: @dev/private`)).toBe(label)
    expect(publicSourceAnswerPendingLabel(`${label} at https://example.test/private@abcdef123456`)).toBe(label)
    for (const privateReason of [
      `${label}ish`,
      `${label}:private`,
      `${label} atprivate`,
      `${label} private`,
      `private ${label}`,
    ]) {
      expect(publicSourceAnswerPendingLabel(privateReason)).toBeUndefined()
    }
  }
  expect(publicSourceAnswerPendingLabel("unrelated private reason @dev/private")).toBeUndefined()
  expect(publicSourceAnswerPendingLabel("")).toBeUndefined()
  expect(publicSourceAnswerPendingLabel(undefined)).toBeUndefined()
})

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

const engineCore = "https://github.com/ghostty-org/ghostty"
const wasmIdentity = {
  kind: "js" as const,
  runtimeFormat: "wasm" as const,
  resolvedPath: "/fixture/ghostty-web.js",
  engineVersion: "0.4.0",
  adapterVersion: "0.10.2",
  termlessRevision: "c".repeat(40),
  integrity: { kind: "registry" as const, lockIntegrity: "sha512-fixture" },
  loadedBinary: { path: "ghostty-vt.wasm", sha256: "7".repeat(64) },
}

it("reads the same repository however a citation spells it", () => {
  expect(repositoryIdentity("git@github.com:ghostty-org/ghostty.git")).toBe(repositoryIdentity(engineCore))
  expect(repositoryIdentity("https://github.com/ghostty-org/ghostty")).toBe(repositoryIdentity(engineCore))
  expect(repositoryIdentity("git@github.com:beorn/termless.git")).not.toBe(repositoryIdentity(engineCore))
})

// The addon is built at its own source commit, not at the pinned Termless revision (@cto de41833e c3).
it("resolves the vt100-rust addon at its own source commit, not the Termless pin", () => {
  const addon = "1".repeat(40)
  const addonBlob = {
    repository: "git@github.com:beorn/termless.git",
    commit: addon,
    path: "packages/vt100-rust/native/src/lib.rs",
    oid: "2".repeat(40),
  }
  const row: SourceAnswer = {
    subject: { kind: "lib" as const, id: "vt100-rust", version: "0.16.2", os: "linux" },
    featureId: "extensions.addon",
    answers: [{ status: "unsupported", citedBlobs: [addonBlob], originals: [original] }],
  }
  const native = {
    kind: "native" as const,
    engineVersion: "0.16.2",
    adapterVersion: "0.10.2",
    termlessRevision: "9".repeat(40),
    loadedBinary: { path: "lib.dylib", sha256: "3".repeat(64) },
    provenance: {
      sha256: "3".repeat(64),
      sourceCommit: addon,
      buildHash: "4".repeat(64),
      toolchain: "fixture",
      lockSha256: "5".repeat(64),
    },
  }
  expect(
    resolveSourceAnswer([row], { subject: row.subject, featureId: row.featureId, runtimeIdentity: native }),
  ).toMatchObject({ kind: "answer", status: "unsupported" })

  // The same addon path on a js identity has no addon commit at all: covered by neither revision.
  expect(
    resolveSourceAnswer([row], {
      subject: row.subject,
      featureId: row.featureId,
      runtimeIdentity: { ...wasmIdentity, engineVersion: "0.16.2" },
    }),
  ).toMatchObject({ kind: "pending", reason: "cited source not resolvable" })
})

it("resolves other Termless paths at the pinned Termless revision", () => {
  const pinned = "6".repeat(40)
  const row: SourceAnswer = {
    subject: { kind: "lib" as const, id: "ghostty", version: "0.4.0", os: "linux" },
    featureId: "extensions.adapter",
    answers: [
      {
        status: "unsupported",
        citedBlobs: [
          {
            repository: "git@github.com:beorn/termless.git",
            commit: pinned,
            path: "packages/probe-defs/src/extensions.ts",
            oid: "8".repeat(40),
          },
        ],
        originals: [original],
      },
    ],
  }
  expect(
    resolveSourceAnswer([row], {
      subject: row.subject,
      featureId: row.featureId,
      runtimeIdentity: { ...wasmIdentity, termlessRevision: pinned },
    }),
  ).toMatchObject({ kind: "answer", status: "unsupported" })
})

// @cto 00cce4ce: a verified kept answer leads the resolution, so the stored reason, rows and ref agree.
const ownUnverified: SourceAnswer = {
  subject: { ...subject, version: "2.0" },
  featureId: "extensions.mixed",
  answers: [
    {
      status: "unsupported",
      citedBlobs: [],
      originals: [
        { reviewRef: "collector.review.own", reviewer: "@dev/2", reason: "Own unverified review", sources: ["own"] },
      ],
    },
  ],
}
const verifiedOlder: SourceAnswer = {
  subject: { ...subject, version: "1.0" },
  featureId: "extensions.mixed",
  answers: [
    {
      status: "unsupported",
      citedBlobs: [blob],
      originals: [
        { reviewRef: "collector.review.older", reviewer: "@cto", reason: "Verified older review", sources: ["old"] },
      ],
    },
  ],
}
const equallyVerified: SourceAnswer = {
  subject: { ...subject, version: "0.9" },
  featureId: "extensions.mixed",
  answers: [
    {
      status: "unsupported",
      citedBlobs: [blob],
      originals: [
        {
          reviewRef: "collector.review.oldest",
          reviewer: "@dev/4",
          reason: "Second verified review",
          sources: ["oldest"],
        },
      ],
    },
  ],
}
const mixedInput = { subject: { ...subject, version: "2.0" }, featureId: "extensions.mixed", blobs: [blob] }

it.each([
  ["own row first", [ownUnverified, verifiedOlder]],
  ["verified row first", [verifiedOlder, ownUnverified]],
])("leads with the blob-verified answer and drops the label (%s)", (_name, rows) => {
  const result = resolveSourceAnswer(rows, mixedInput)
  if (result.kind !== "answer") throw new Error("Expected one applicable answer")
  expect(result.label).toBeUndefined()
  expect(result.answers[0]).toBe(verifiedOlder.answers[0])
  expect(result.rows[0]).toBe(verifiedOlder)
  expect(result.rowKeys[0]).toBe(sourceAnswerKey(verifiedOlder.subject, verifiedOlder.featureId))
  expect(result.answers).toEqual([verifiedOlder.answers[0], ownUnverified.answers[0]])
})

it("finalizes the verified reason with its matching ref and no version label", () => {
  const result = finalizeProbeResult(
    {
      featureId: "extensions.mixed",
      attempt: { scope: "none" as const },
      tests: [
        {
          id: "review",
          status: "test-todo" as const,
          attempt: { scope: "none" as const },
          reason: "Source review pending",
        },
      ],
    },
    resolveSourceAnswer([ownUnverified, verifiedOlder], mixedInput),
  )
  expect(result.reviewRef).toBe(sourceAnswerKey(verifiedOlder.subject, verifiedOlder.featureId))
  expect(result.reason).toBe("Verified older review")
})

it("keeps the version label when no applicable answer is verified", () => {
  expect(resolveSourceAnswer([ownUnverified], mixedInput)).toMatchObject({
    kind: "answer",
    label: "reviewed at 2.0, not re-verified",
  })
})

it("keeps table order among equally verified answers", () => {
  const result = resolveSourceAnswer([verifiedOlder, equallyVerified], mixedInput)
  if (result.kind !== "answer") throw new Error("Expected one applicable answer")
  expect(result.answers[0]).toBe(verifiedOlder.answers[0])
  expect(result.rows[0]).toBe(verifiedOlder)
  expect(result.label).toBeUndefined()
})

// @cto 00cce4ce / Dev4 4c2f4724: a disagreement keeps the order the reader already published, verified or not.
const verifiedDisagree: SourceAnswer = {
  subject: { ...subject, version: "1.0" },
  featureId: "extensions.mixed",
  answers: [
    {
      status: "supported",
      citedBlobs: [blob],
      originals: [
        {
          reviewRef: "collector.review.supported",
          reviewer: "@cto",
          reason: "Verified differing review",
          sources: ["s"],
        },
      ],
    },
  ],
}

it.each([
  ["unverified first", [ownUnverified, verifiedDisagree]],
  ["verified first", [verifiedDisagree, ownUnverified]],
])("keeps the published disagreement order and originals (%s)", (_name, rows) => {
  const result = resolveSourceAnswer(rows, mixedInput)
  if (result.kind !== "pending") throw new Error("Conflicting kept answers must stay pending")
  expect(result.reason).toBe("kept answers disagree")
  expect(result.rowKeys).toEqual(rows.map((row) => sourceAnswerKey(row.subject, row.featureId)))
  expect(result.answers?.map((answer) => answer.originals[0]?.reviewRef)).toEqual(
    rows.map((row) => row.answers[0]?.originals[0]?.reviewRef),
  )
})

it("detects the unverified version label suffix on stored ProbeResult.reason values (hasUnverifiedSourceAnswerSuffix)", () => {
  expect(hasUnverifiedSourceAnswerSuffix(undefined, "1.0.0")).toBe(false)
  expect(hasUnverifiedSourceAnswerSuffix("", "1.0.0")).toBe(false)
  expect(hasUnverifiedSourceAnswerSuffix("Verified against source blob", "1.0.0")).toBe(false)
  expect(hasUnverifiedSourceAnswerSuffix("reviewed at 1.0.0, not re-verified", "1.0.0")).toBe(true)
  expect(
    hasUnverifiedSourceAnswerSuffix("Verified at 1.0.0 in src/vt.zig; reviewed at 1.0.0, not re-verified", "1.0.0"),
  ).toBe(true)
  expect(
    hasUnverifiedSourceAnswerSuffix("Verified at 1.0.0 in src/vt.zig; reviewed at 0.9.0, not re-verified", "1.0.0"),
  ).toBe(false)
})
