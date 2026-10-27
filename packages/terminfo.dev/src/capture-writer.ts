/** Shared immutable capture finalization and persistence for every collector. */
import { createHash } from "node:crypto"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import {
  SOURCE_NEGATIVE_REVIEW,
  sealRunDraft,
  type CapturedRunDraft as CollectedProbeRun,
  type CurrentProbeRun,
  type ProbeSubject,
  type ProbeSuiteManifest,
} from "@terminfo/probe-defs"
import {
  retainCaptureBinding,
  applyCaptureDecision,
  parseCaptureDecision,
  parseJsonStrict,
  parseRun,
} from "@terminfo/run-parser"

export interface CaptureReviewInput {
  source: string
  startedAt: string
}

/** Enrich the same capture before seal; pending review is a valid private draft. */
export function finalizeCollectedDraft(
  run: CollectedProbeRun,
  intended?: { kind: ProbeSubject["kind"]; id: string; version: string },
  reviews?: {
    manifest: ProbeSuiteManifest
    decisions: readonly CaptureReviewInput[]
    origin: (runId: string) => { path: string; source: string } | undefined
  },
): CollectedProbeRun | CurrentProbeRun {
  if (run.schemaVersion !== 4 || !Array.isArray(run.results)) {
    throw new Error("Final writer requires the current schema-4 draft; historical runs are read-only")
  }
  if (run.source?.kind !== "live") {
    throw new Error(`Probe source ${String(run.source?.kind)} has no implementation at this source`)
  }
  if ("sealedAt" in run) {
    throw new Error(`Run ${run.runId} is already sealed; enrichment cannot change immutable results`)
  }
  if (reviews && (!reviews.manifest || !Array.isArray(reviews.decisions) || typeof reviews.origin !== "function")) {
    throw new Error("Capture reviews require one trusted-manifest batch with decisions and an explicit origin reader")
  }
  if (intended && run.subject.id !== intended.id && run.subject.id !== "unknown") {
    throw new Error(
      `Measured terminal ${run.subject.id} differs from intended ${intended.id}; refusing to relabel capture`,
    )
  }
  if (intended && run.subject.version !== intended.version && run.subject.version !== "unknown") {
    throw new Error(
      `Measured version ${run.subject.version} differs from intended ${intended.version}; refusing to relabel capture`,
    )
  }
  const captured = globalThis.structuredClone(run)
  if (intended) {
    captured.subject.kind = intended.kind
    captured.intendedSubject = { ...captured.intendedSubject, ...intended }
    captured.rawReplies["collector.intent"] = JSON.stringify(intended)
  }
  for (const result of captured.results) {
    if (
      result.tests.some(
        (check) =>
          check.id === "review" &&
          (check.status === "test-todo" ||
            (result.criterionBranch === SOURCE_NEGATIVE_REVIEW && check.status === "test-failure")),
      )
    ) {
      retainCaptureBinding(captured, result.featureId)
    }
  }
  for (const review of reviews?.decisions ?? []) {
    const decision = parseCaptureDecision(
      parseJsonStrict("capture review", review.source),
      "capture review",
      new Set(captured.results.map((result) => result.featureId)),
    )
    const result = captured.results.find((result) => result.featureId === decision.featureId)
    let originBinding: string | undefined
    if (
      reviews &&
      result?.criterionBranch === SOURCE_NEGATIVE_REVIEW &&
      decision.runId !== captured.runId &&
      decision.scope.suites[0] === captured.probeHash &&
      captured.probeHash === captured.suiteId
    ) {
      if (reviews.manifest.probeHash !== decision.scope.suites[0]) {
        throw new Error(`Capture review ${decision.id} trusted manifest differs from its suite scope`)
      }
      const origin = reviews.origin(decision.runId)
      if (origin !== undefined) {
        const parsed = parseRun(
          origin.path,
          origin.source,
          reviews.manifest.catalogIds ?? [],
          new Map([[reviews.manifest.probeHash, reviews.manifest]]),
        )
        if (!parsed.sealedAt || parsed.runId !== decision.runId) {
          throw new Error(`Capture review ${decision.id} origin is not the named sealed run ${decision.runId}`)
        }
        originBinding = parsed.rawReplies[`collector.capture.${decision.featureId}`]
        if (originBinding === undefined) {
          throw new Error(`Origin run ${decision.runId} is missing capture binding for ${decision.featureId}`)
        }
      }
    }
    applyCaptureDecision(captured, review.source, review.startedAt, originBinding)
  }
  if (
    captured.results.some((result) =>
      result.tests.some(
        (check) =>
          check.id === "review" &&
          (check.status === "test-todo" ||
            (result.criterionBranch === SOURCE_NEGATIVE_REVIEW && check.status === "test-failure")),
      ),
    )
  ) {
    return captured
  }
  return sealRunDraft(captured)
}

/** Preserve one immutable final run, or explicit pending-review draft, under its measured identity. */
export function saveDaemonProbeRun(
  run: CollectedProbeRun,
  directory: string,
  intended?: { kind: ProbeSubject["kind"]; id: string; version: string },
  reviews?: Parameters<typeof finalizeCollectedDraft>[2],
): string {
  const captured = finalizeCollectedDraft(run, intended, reviews)
  for (const value of [
    captured.subject.id,
    captured.subject.version,
    captured.subject.os ?? "unknown",
    captured.runId,
  ]) {
    if (!/^[a-zA-Z0-9._-]+$/.test(value)) throw new Error(`Unsafe capture filename component: ${value}`)
  }
  mkdirSync(directory, { recursive: true })
  // A partially reviewed draft is a new immutable snapshot of the same logical capture.
  // Keep the original pending bytes; the existing private writer needs no second store.
  const reviewedPending =
    captured.sealedAt === undefined &&
    Object.keys(captured.rawReplies).some((key) => key.startsWith("collector.review."))
  const bytes = `${JSON.stringify(captured, null, 2)}\n`
  const snapshot = reviewedPending ? `.${createHash("sha256").update(bytes).digest("hex")}` : ""
  const file = join(
    directory,
    `${captured.subject.id}-${captured.subject.version}-${captured.subject.os ?? "unknown"}-${captured.runId}${snapshot}${captured.sealedAt === undefined ? ".draft" : ""}.json`,
  )
  writeFileSync(file, bytes, { flag: "wx", mode: 0o600 })
  return file
}
