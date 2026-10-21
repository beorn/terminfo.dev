/** Shared immutable capture finalization and persistence for every collector. */
import { createHash } from "node:crypto"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import {
  sealRunDraft,
  type CapturedRunDraft as CollectedProbeRun,
  type CurrentProbeRun,
  type ProbeTarget,
} from "@terminfo/probe-defs"
import { retainCaptureBinding, applyCaptureDecision } from "@terminfo/run-parser"

export interface CaptureReviewInput {
  source: string
  startedAt: string
}

/** Enrich the same capture before seal; pending review is a valid private draft. */
export function finalizeCollectedDraft(
  run: CollectedProbeRun,
  intended?: { kind: ProbeTarget["kind"]; id: string; version: string },
  reviews: readonly CaptureReviewInput[] = [],
): CollectedProbeRun | CurrentProbeRun {
  if (run.schemaVersion !== 3 || !Array.isArray(run.results)) {
    throw new Error("Final writer requires the current schema-3 draft; historical runs are read-only")
  }
  if ("sealedAt" in run) {
    throw new Error(`Run ${run.runId} is already sealed; enrichment cannot change immutable results`)
  }
  if (intended && run.target.id !== intended.id && run.target.id !== "unknown") {
    throw new Error(
      `Measured terminal ${run.target.id} differs from intended ${intended.id}; refusing to relabel capture`,
    )
  }
  if (intended && run.target.version !== intended.version && run.target.version !== "unknown") {
    throw new Error(
      `Measured version ${run.target.version} differs from intended ${intended.version}; refusing to relabel capture`,
    )
  }
  const captured = globalThis.structuredClone(run)
  if (intended) {
    captured.target.kind = intended.kind
    captured.intendedContext = { ...captured.intendedContext, ...intended }
    captured.rawReplies["collector.intent"] = JSON.stringify(intended)
  }
  for (const result of captured.results) {
    if (result.checks.some((check) => check.id === "review" && check.status === "test-todo")) {
      retainCaptureBinding(captured, result.featureId)
    }
  }
  for (const review of reviews) applyCaptureDecision(captured, review.source, review.startedAt)
  if (
    captured.results.some((result) =>
      result.checks.some((check) => check.id === "review" && check.status === "test-todo"),
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
  intended?: { kind: ProbeTarget["kind"]; id: string; version: string },
  reviews: readonly CaptureReviewInput[] = [],
): string {
  const captured = finalizeCollectedDraft(run, intended, reviews)
  for (const value of [captured.target.id, captured.target.version, captured.target.os ?? "unknown", captured.runId]) {
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
    `${captured.target.id}-${captured.target.version}-${captured.target.os ?? "unknown"}-${captured.runId}${snapshot}${captured.sealedAt === undefined ? ".draft" : ""}.json`,
  )
  writeFileSync(file, bytes, { flag: "wx", mode: 0o600 })
  return file
}
