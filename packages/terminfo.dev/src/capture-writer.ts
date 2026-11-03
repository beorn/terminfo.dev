/** Shared immutable capture finalization and persistence for every collector. */
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import {
  REPLY_PATH_AUDIT_REVIEW,
  SOURCE_NEGATIVE_REVIEW,
  finalizeProbeResult,
  type CapturedRunDraft as CollectedProbeRun,
  type ProbeSubject,
} from "@terminfo/probe-defs"
import { resolveMeasuredSourceAnswer } from "@terminfo/run-parser"

/** Finalize one measured capture with applicable source answers. */
export function finalizeCollectedDraft(
  run: CollectedProbeRun,
  intended?: { kind: ProbeSubject["kind"]; id: string; version: string },
): CollectedProbeRun {
  if (run.schemaVersion !== 4 || !Array.isArray(run.results)) {
    throw new Error("Final writer requires the current schema-4 draft; historical runs are read-only")
  }
  if (run.source?.kind !== "live") {
    throw new Error(`Probe source ${String(run.source?.kind)} has no implementation at this source`)
  }
  if (Object.keys(run.source).length !== 1) {
    throw new Error("Current run writer requires exactly { kind: live }")
  }
  if (!run.subject || !run.identity || !run.measuredAt || !run.origin) {
    throw new Error(`Run ${run.runId} has no complete measured identity`)
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
  captured.results = captured.results.map((result) => {
    if (
      !result.tests.some(
        (test) =>
          test.id === "review" &&
          (test.status === "test-todo" ||
            (result.criterionBranch === SOURCE_NEGATIVE_REVIEW && test.status === "test-failure")),
      )
    ) {
      return result
    }
    const resolution = resolveMeasuredSourceAnswer({
      subject: captured.subject,
      featureId: result.featureId,
      ...(captured.runtimeIdentity && { runtimeIdentity: captured.runtimeIdentity }),
      sourceRevision: captured.sourceRevision,
    })
    // A reply-path gate measured zero reply bytes; a kept answer that claims support contradicts the measurement.
    if (
      result.criterionBranch === REPLY_PATH_AUDIT_REVIEW &&
      resolution.kind === "answer" &&
      resolution.status === "supported"
    ) {
      throw new Error(
        `Reply-path gate for ${result.featureId} measured a zero-byte reply but its kept answers claim support`,
      )
    }
    return finalizeProbeResult(result, resolution)
  })
  return captured
}

/** Preserve one immutable collected run under its measured identity. */
export function saveDaemonProbeRun(
  run: CollectedProbeRun,
  directory: string,
  intended?: { kind: ProbeSubject["kind"]; id: string; version: string },
): string {
  const captured = finalizeCollectedDraft(run, intended)
  for (const value of [
    captured.subject.id,
    captured.subject.version,
    captured.subject.os ?? "unknown",
    captured.runId,
  ]) {
    if (!/^[a-zA-Z0-9._-]+$/.test(value)) throw new Error(`Unsafe capture filename component: ${value}`)
  }
  mkdirSync(directory, { recursive: true })
  const bytes = `${JSON.stringify(captured, null, 2)}\n`
  const file = join(
    directory,
    `${captured.subject.id}-${captured.subject.version}-${captured.subject.os ?? "unknown"}-${captured.runId}.draft.json`,
  )
  writeFileSync(file, bytes, { flag: "wx", mode: 0o600 })
  return file
}
