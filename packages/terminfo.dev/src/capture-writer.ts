/** Shared immutable capture finalization and persistence for every collector. */
import { createHash } from "node:crypto"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import {
  REPLY_PATH_AUDIT_REVIEW,
  SOURCE_NEGATIVE_REVIEW,
  sourceAnswerForRef,
  finalizeProbeResult,
  sealRunDraft,
  type CapturedRunDraft as CollectedProbeRun,
  type CurrentProbeRun,
  type AssertionType,
  type ProbeSubject,
  type ProbeSuiteManifest,
} from "@terminfo/probe-defs"
import {
  retainCaptureBinding,
  applyCaptureDecision,
  parseCaptureDecision,
  parseJsonStrict,
  parseRun,
  resolveMeasuredSourceAnswer,
} from "@terminfo/run-parser"

const DA1_QUERY = "\u001b[c"
const DA1_REPLY = /\u001b\[\?[0-9;]*c/u

function replySource(sequence: string, reply: string): "host" | "terminal" | "none" {
  const da1 = sequence !== DA1_QUERY && sequence.endsWith(DA1_QUERY) ? DA1_REPLY.exec(reply) : null
  if (da1 === null) return reply === "" ? "none" : "host"
  if (da1.index > 0) return "host"
  return da1.index + da1[0].length < reply.length ? "terminal" : "none"
}

/** The console host a reason names: a text read's recorded host, else the ownership receipt's image. */
function consoleHostBinary(run: CollectedProbeRun): string {
  const hosts = new Set(
    run.results.flatMap((cell) =>
      cell.host ? [`${cell.host.image} ${cell.host.executableSha256.slice(0, "sha256:".length + 12)}`] : [],
    ),
  )
  if (hosts.size > 1) throw new Error(`Run ${run.runId} names ${hosts.size} console hosts; one run has one`)
  const [host] = hosts
  if (host !== undefined) return host
  const receipt = run.rawReplies["collector.terminalOwnership"]
  const image =
    receipt === undefined
      ? undefined
      : (JSON.parse(receipt) as { windowsHosted?: { consoleHost?: { image?: unknown } } }).windowsHosted?.consoleHost
          ?.image
  return typeof image === "string" && image !== "" ? image : "(console host binary not recorded)"
}

function consoleHostHold(
  run: CollectedProbeRun,
  cell: { featureId: string; assertionType?: AssertionType; rawReplyRef?: string },
  verdict: string,
): string | undefined {
  if (run.subject.kind !== "term" || run.subject.os?.toLowerCase() !== "windows") return undefined
  if (verdict !== "supported" && verdict !== "unsupported") return undefined
  if (cell.assertionType !== "query_reply" || cell.rawReplyRef === undefined) {
    return undefined
  }
  const stored = run.rawReplies[cell.rawReplyRef]
  if (stored === undefined) {
    throw new Error(`Run ${run.runId}: ${cell.featureId} cites raw reply ${cell.rawReplyRef}, which the run lacks`)
  }
  const queries = stored.startsWith("{") ? (JSON.parse(stored) as { queries?: unknown }).queries : undefined
  if (stored.startsWith("{") && (!Array.isArray(queries) || queries.length === 0)) return undefined
  const sources = Array.isArray(queries)
    ? queries.map((query: unknown, index) => {
        const { sequence, raw } = (query ?? {}) as { sequence?: unknown; raw?: unknown }
        if (typeof sequence !== "string" || (raw !== undefined && typeof raw !== "string")) {
          throw new Error(`Run ${run.runId}: ${cell.featureId} query ${index} has no readable sequence and reply`)
        }
        return replySource(sequence, raw ?? "")
      })
    : [replySource("", stored)]
  if (sources.every((source) => source === "terminal")) return undefined
  return sources.includes("host")
    ? `answered by the Windows console host ${consoleHostBinary(run)}, not measured on the terminal`
    : "no reply after the console host's DA1; the host may have swallowed the query"
}

export interface CaptureReviewInput {
  source: string
  startedAt: string
}

export interface CaptureReviewReport {
  featureId: string
  evidenceSha256?: string
  oldRule: Array<{ id: string; status: "carried" | "lapsed"; reason?: string }>
  candidates: Array<{ id: string; status: "carried" | "lapsed" | "refused"; reason?: string }>
  newRule: "carried" | "lapsed" | "conflict" | "pending"
  selected?: string
  duplicates: string[]
  reason: string
}

/** Selection only: both shadow rules and the chosen decision use the canonical applier. */
function carryCaptureReviews(
  captured: CollectedProbeRun,
  reviews: NonNullable<Parameters<typeof finalizeCollectedDraft>[2]>,
): void {
  const pending = captured.results.filter(
    (result) =>
      !(result.reviewRef && sourceAnswerForRef(result.reviewRef)) &&
      result.tests.some(
        (test) =>
          test.id === "review" &&
          (test.status === "test-todo" ||
            (result.criterionBranch === SOURCE_NEGATIVE_REVIEW && test.status === "test-failure")),
      ),
  )
  if (reviews.manifest.catalogIds === undefined) {
    for (const result of pending) {
      reviews.report?.({
        featureId: result.featureId,
        oldRule: [],
        candidates: [],
        newRule: "lapsed",
        duplicates: [],
        reason: "manifest.catalogIds unavailable; capture reviews not applied",
      })
    }
    return
  }
  const catalog = new Set(reviews.manifest.catalogIds)
  const skipped: Array<{ id: string; featureId?: string }> = []
  const inputs = reviews.decisions.flatMap((input) => {
    const value = parseJsonStrict("capture review", input.source)
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error("capture review: accepted record requires an id")
    }
    const record = value as Record<string, unknown>
    if (typeof record.id !== "string") throw new Error("capture review: accepted record requires an id")
    const historical = typeof record.scope === "object" && record.scope !== null && "target" in record.scope
    if (historical || !("captureSha256" in record || "decision" in record || "evidence" in record)) {
      skipped.push({ id: record.id, ...(typeof record.featureId === "string" && { featureId: record.featureId }) })
      return []
    }
    return [{ ...input, decision: parseCaptureDecision(value, "capture review", catalog) }]
  })
  for (const result of captured.results) {
    if (result.reviewRef && sourceAnswerForRef(result.reviewRef)) continue
    if (
      !result.tests.some(
        (test) =>
          test.id === "review" &&
          (test.status === "test-todo" ||
            (result.criterionBranch === SOURCE_NEGATIVE_REVIEW && test.status === "test-failure")),
      )
    ) {
      continue
    }
    const candidates = inputs.filter(
      ({ decision }) =>
        decision.featureId === result.featureId &&
        decision.scope.subject.kind === captured.subject.kind &&
        decision.scope.subject.id === captured.subject.id,
    )
    const report: CaptureReviewReport = {
      featureId: result.featureId,
      oldRule: [],
      candidates: skipped
        .filter((entry) => entry.featureId === undefined || entry.featureId === result.featureId)
        .map(({ id }) => ({
          id,
          status: "refused",
          reason: "Non-capture/historical interpretation skipped; source unchanged",
        })),
      newRule: candidates.length ? "lapsed" : "pending",
      duplicates: [],
      reason: "No accepted decision for this subject and feature",
    }
    const hash = reviews.manifest.catalogEntrySha256?.[result.featureId]
    const retained = hash === undefined ? undefined : retainCaptureBinding(captured, result.featureId, hash).evidence
    if (retained) report.evidenceSha256 = retained.sha256
    const matching: typeof candidates = []
    for (const input of candidates) {
      // This private comparison never changes or promotes the accepted source record.
      const { evidence: _newKey, ...oldDecision } = input.decision
      const old = globalThis.structuredClone(captured)
      try {
        applyCaptureDecision(old, JSON.stringify(oldDecision), input.startedAt)
        const reason = old.rawReplies[`collector.review.${input.decision.id}.lapse`]
        report.oldRule.push({ id: input.decision.id, status: reason ? "lapsed" : "carried", ...(reason && { reason }) })
      } catch (error) {
        report.oldRule.push({
          id: input.decision.id,
          status: "lapsed",
          reason: error instanceof Error ? error.message : String(error),
        })
      }
      if (!input.decision.evidence) {
        report.candidates.push({
          id: input.decision.id,
          status: "lapsed",
          reason: "Explicit evidence-output decision required; historical record unchanged",
        })
        continue
      }
      const shadow = globalThis.structuredClone(captured)
      try {
        applyCaptureDecision(shadow, input.source, input.startedAt, undefined, hash)
      } catch (error) {
        report.candidates.push({
          id: input.decision.id,
          status: "refused",
          reason: error instanceof Error ? error.message : String(error),
        })
        continue
      }
      const reason = shadow.rawReplies[`collector.review.${input.decision.id}.lapse`]
      report.candidates.push({
        id: input.decision.id,
        status: reason ? "lapsed" : "carried",
        ...(reason && { reason }),
      })
      if (!reason) matching.push(input)
    }
    const first = matching[0]
    if (first) {
      const conflicts = matching.some(
        ({ decision }) => decision.decision !== first.decision.decision || decision.reason !== first.decision.reason,
      )
      report.newRule = conflicts ? "conflict" : "carried"
      report.reason = conflicts
        ? `Conflicting evidence-matched decisions: ${matching.map(({ decision }) => decision.id).join(", ")}`
        : "Evidence output unchanged"
      if (!conflicts) {
        applyCaptureDecision(captured, first.source, first.startedAt, undefined, hash)
        report.selected = first.decision.id
        report.duplicates = matching.slice(1).map(({ decision }) => decision.id)
      }
    } else if (candidates.length) {
      if (report.candidates.every((candidate) => candidate.status === "refused")) report.newRule = "pending"
      report.reason = report.candidates.map((candidate) => `${candidate.id}: ${candidate.reason}`).join("; ")
    }
    reviews.report?.(report)
  }
}

/** Enrich the same capture before seal; pending review is a valid private draft. */
export function finalizeCollectedDraft(
  run: CollectedProbeRun,
  intended?: { kind: ProbeSubject["kind"]; id: string; version: string },
  reviews?: {
    manifest: ProbeSuiteManifest
    decisions: readonly CaptureReviewInput[]
    origin: (runId: string) => { path: string; source: string } | undefined
    /** Natural collection supplies accepted, already supersession-filtered decisions. */
    carry?: boolean
    /** Explicitly retain a draft even when every required review completes. */
    keepDraft?: boolean
    report?: (entry: CaptureReviewReport) => void
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
  captured.results = captured.results.map((result) => {
    const reason = consoleHostHold(captured, result, result.status)
    if (reason === undefined) return result
    return {
      ...result,
      reason,
      tests: [
        ...result.tests.filter((test) => test.id !== "console-host"),
        { id: "console-host", status: "test-todo" as const, attempt: { scope: "none" as const }, reason },
      ],
    }
  })
  captured.results = captured.results.map((result) => {
    if (
      !result.tests.some(
        (test) =>
          test.id === "review" &&
          (test.status === "test-todo" ||
            (result.criterionBranch === SOURCE_NEGATIVE_REVIEW && test.status === "test-failure")),
      )
    ) {
      return finalizeProbeResult(result)
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
  for (const result of captured.results) {
    if (result.reviewRef && sourceAnswerForRef(result.reviewRef)) continue
    if (
      result.tests.some(
        (check) =>
          check.id === "review" &&
          (check.status === "test-todo" ||
            (result.criterionBranch === SOURCE_NEGATIVE_REVIEW && check.status === "test-failure")),
      )
    ) {
      retainCaptureBinding(captured, result.featureId, reviews?.manifest.catalogEntrySha256?.[result.featureId])
    }
  }
  if (reviews?.carry) carryCaptureReviews(captured, reviews)
  for (const review of reviews?.carry ? [] : (reviews?.decisions ?? [])) {
    const decision = parseCaptureDecision(
      parseJsonStrict("capture review", review.source),
      "capture review",
      new Set(captured.results.map((result) => result.featureId)),
    )
    const result = captured.results.find((result) => result.featureId === decision.featureId)
    let originBinding: string | undefined
    if (
      reviews &&
      decision.evidence === undefined &&
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
    applyCaptureDecision(
      captured,
      review.source,
      review.startedAt,
      originBinding,
      reviews?.manifest.catalogEntrySha256?.[decision.featureId],
    )
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
  return reviews?.keepDraft ? captured : sealRunDraft(captured)
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
    Object.keys(captured.rawReplies).some(
      (key) => key.startsWith("collector.review.") || key.startsWith("collector.evidence."),
    )
  const bytes = `${JSON.stringify(captured, null, 2)}\n`
  const snapshot = reviewedPending ? `.${createHash("sha256").update(bytes).digest("hex")}` : ""
  const file = join(
    directory,
    `${captured.subject.id}-${captured.subject.version}-${captured.subject.os ?? "unknown"}-${captured.runId}${snapshot}${captured.sealedAt === undefined ? ".draft" : ""}.json`,
  )
  writeFileSync(file, bytes, { flag: "wx", mode: 0o600 })
  return file
}
