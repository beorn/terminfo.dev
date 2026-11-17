/**
 * #30932 S2 (@cto ruling 30932-s2-plan-ruling-1430): re-grade every complete-log row of a stored run from the
 * artifact alone and report, family by family, whether the replay reaches the stored status.
 *
 * The replay is the one per-row replay `runEraseReplay` also uses, and the grade is the one grader:
 * `recordExecutedProbe` and `finalizeVisualResult`. The report is private evidence. It changes no stored byte,
 * no status and no published output, and it is not a gate: deletion of live grading still waits on the parent's
 * full same-context run.
 */
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { basename, dirname } from "node:path"
import {
  ALL_PROBES,
  finalizeVisualResult,
  recordExecutedProbe,
  type CapturedRunDraft,
  type ObservationFrame,
  type ProbeAssertion,
  type ProbeCallbackResult,
  type ProbeResult,
  type ProbeSubject,
  type ProbeSuiteManifest,
  type TermProbeSource,
} from "@terminfo/probe-defs"
import { parseJsonStrict } from "@terminfo/run-parser"
import { IncompleteReplay, readCallLog, withCallLog } from "viprobe"
import { hasOuterCommandMatcher } from "../terminfo.dev/src/app-semantic-state.ts"
import { readProbeCapture } from "./erase-capture.ts"

export const SHADOW_REPORT_FORMAT = "terminfo.shadow-report"
export const SHADOW_REPORT_VERSION = 1

/** The bound reader's validated run: every binding, installation order, geometry and call log already checked. */
type ValidatedRun = ReturnType<typeof readProbeCapture>["capture"]

export interface ReplayedRow {
  startedAt: string
  result: ProbeCallbackResult
  /** The frames the recorded `context.capture` calls returned, in order: the finalizer's evidence. */
  frames: ObservationFrame[]
}

const errorName = (error: unknown) => (error instanceof Error ? error.name : "Error")
const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error))

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

/** A data property of the recorded source, read from the log's root snapshot so no recorded call is consumed. */
function recordedRootValue(log: unknown, key: string): { present: boolean; value?: unknown } {
  const root = object(log) ? log.root : undefined
  const entries = object(root) && Array.isArray(root.entries) ? (root.entries as unknown[]) : []
  const entry = entries.find((item): item is [string, unknown] => Array.isArray(item) && item[0] === key)
  return entry ? { present: true, value: entry[1] } : { present: false }
}

/**
 * The live collector grades a row whose geometry changed during it as `resized-capture`; a replay has no second
 * geometry reading, so it names the change instead of grading it.
 */
export function rowGeometryChange(rawReplies: Record<string, string>, featureId: string): string | undefined {
  const geometryRaw = rawReplies["collector.geometry"]
  if (typeof geometryRaw !== "string") return undefined
  const geometry = parseJsonStrict("replay geometry", geometryRaw) as {
    checks?: Array<{
      featureId: string
      pre?: { status: string; rows?: number; cols?: number }
      post?: { status: string; rows?: number; cols?: number }
    }>
  }
  const measured = geometry.checks?.find((check) => check.featureId === featureId)
  if (
    measured?.pre?.status === "measured" &&
    (measured.post?.status !== "measured" ||
      measured.pre.rows !== measured.post.rows ||
      measured.pre.cols !== measured.post.cols)
  ) {
    return "geometry changed or became unavailable during " + featureId
  }
  return undefined
}

/**
 * Replay one row's term callback from its own full-source call log. Every divergence is an `IncompleteReplay`;
 * a log recorded before the source clock existed is refused by name, never handed this machine's time.
 */
export async function replayRow(validated: ValidatedRun, featureId: string): Promise<ReplayedRow> {
  const definition = ALL_PROBES.find(({ id }) => id === featureId)
  if (!definition?.term) throw new IncompleteReplay("Missing term callback: " + featureId)
  const raw = validated.rawReplies[featureId + ".callLog"]
  if (typeof raw !== "string") throw new IncompleteReplay("Missing full-source call log: " + featureId)
  const parsed = parseJsonStrict(featureId + " call log", raw)
  const frames: ObservationFrame[] = []
  const log = readCallLog(parsed, {
    onOperation(operation) {
      if (operation.path === "context.capture" && "value" in operation.outcome) {
        frames.push(operation.outcome.value as ObservationFrame)
      }
    },
  })
  const session = withCallLog<TermProbeSource>(null, { mode: "replay", log })
  if (session.context.kind !== validated.source.kind) {
    throw new IncompleteReplay("Source shape does not match its live capture: " + featureId)
  }
  // A log recorded before the source clock existed (#30932 S2) has no `now` to give. When the callback asks for
  // it, `sourceNow` refuses; a cleanup step after that refusal can then diverge from the log and throw a later,
  // less telling error, so the request itself is what names the cause.
  const clockRecorded = recordedRootValue(parsed, "now").present
  let clockRequested = false
  const context = clockRecorded
    ? session.context
    : new Proxy(session.context, {
        get(target, key) {
          if (key === "now") clockRequested = true
          return Reflect.get(target, key) as unknown
        },
      })
  const startedAt = new Date().toISOString()
  let result: ProbeCallbackResult
  try {
    result = await definition.term(context)
  } catch (error) {
    if (clockRequested) throw new IncompleteReplay(`call log predates the recorded source clock (${featureId})`)
    throw error
  }
  if (clockRequested) throw new IncompleteReplay(`call log predates the recorded source clock (${featureId})`)
  session.finish()
  // Replay decorators must not escape into a persisted record: keep the JSON data the owner writes to disk.
  return { startedAt, result: JSON.parse(JSON.stringify(result)) as ProbeCallbackResult, frames }
}

/**
 * Grade one replayed callback result through the one grader. Raw replies and assertions go into the caller's
 * draft lists, exactly as the retained replay has always written them.
 */
export function recordReplayedRow(input: {
  featureId: string
  startedAt: string
  result: ProbeCallbackResult
  rawReplies: Record<string, string>
  assertions: ProbeAssertion[]
  precondition?: string
}): ProbeResult {
  const { featureId, startedAt, result } = input
  if (result.response !== undefined) input.rawReplies[featureId] = result.response
  const rawReplyRef = Object.hasOwn(input.rawReplies, featureId) ? featureId : undefined
  for (const item of result.assertions ?? []) input.assertions.push({ ...item, featureId, rawReplyRef })
  return recordExecutedProbe({
    featureId,
    attempt: { scope: "probe", startedAt },
    assertions: input.assertions,
    tests: result.tests,
    criterionBranch: result.criterionBranch,
    observation: result.observation && { ...result.observation, featureId, rawReplyRef },
    // Coverage requires retained raw state; its absent trace must still fail the parser.
    coverage: result.notTested && { ...result.notTested, featureId, rawReplyRef: featureId },
    diagnostic:
      input.precondition && !result.tests?.some((test) => test.id === "criterion" && test.status === "probe-invalid")
        ? { kind: "collector-error", name: "PreconditionFailed", message: input.precondition }
        : undefined,
    rawReplyRef,
  })
}

export type ShadowFamily = "sgr" | "outer-command"

export type ShadowRow = { featureId: string; family: ShadowFamily } & (
  | { outcome: "agree"; status: ProbeResult["status"]; reasonsEqual: boolean }
  | {
      outcome: "disagree"
      stored: { status: ProbeResult["status"]; reason?: string }
      replayed: { status: ProbeResult["status"]; reason?: string }
    }
  | { outcome: "incomplete"; reason: string }
  | { outcome: "not-comparable"; input: string; storedStatus: ProbeResult["status"] }
)

export interface ShadowReport {
  format: typeof SHADOW_REPORT_FORMAT
  version: typeof SHADOW_REPORT_VERSION
  /** What was queried, where, and what was left out, so an empty or partial report is never read as a pass. */
  scope: string
  run: {
    runId: string
    suiteId: string
    sourceRevision: string
    subject: Pick<ProbeSubject, "kind" | "id" | "version">
    artifact: { path: string; sha256: string }
  }
  replayedWith: { suiteId: string; sourceRevision: string }
  /** Set when the bound reader refused the whole run; every eligible row is then incomplete with this reason. */
  runIncomplete?: string
  families: Array<{
    family: ShadowFamily
    rows: number
    agree: number
    disagree: number
    incomplete: number
    notComparable: number
  }>
  excluded: Array<{ reason: string; rows: number; featureIds: string[] }>
  rows: ShadowRow[]
}

const SCOPE =
  "Every row of the stored run is counted once. sgr.* rows, and outer-command rows on a mux subject, carry a " +
  "full-source call log and are replayed offline through the bound reader, the row's own term callback and the " +
  "one grader, then compared with the stored status. Every other row is excluded with its reason; the headless " +
  "erase family is shadowed by its own collector (#30932 S3)."

function familyOf(featureId: string, subject: Pick<ProbeSubject, "kind">): ShadowFamily | string {
  if (featureId.startsWith("sgr.")) return "sgr"
  // The live collector records a full-source log for an outer-command row only on a mux subject (unified.ts).
  if (hasOuterCommandMatcher(featureId)) {
    return subject.kind === "mux" ? "outer-command" : "outer-command row on a non-mux subject: host-level log only"
  }
  return "host-level log only (" + featureId.slice(0, featureId.indexOf(".") + 1 || featureId.length) + "*)"
}

/**
 * The live inputs and grading steps a replay of the call log does not reproduce. A row graded with one of them is
 * not comparable, whatever status the replay reaches: an equal status there proves nothing.
 */
function liveOnlyInput(validated: ValidatedRun, stored: ProbeResult): string | undefined {
  const id = stored.featureId
  if (stored.harnessOutcome) return "harness outcome " + stored.harnessOutcome
  const diagnostic = validated.ungradedDiagnostics?.[id]
  if (diagnostic) {
    return "live diagnostic " + (diagnostic.kind === "collector-error" ? diagnostic.name : diagnostic.kind)
  }
  if (validated.observations.some((entry) => entry.featureId === id && entry.outcome === "error")) {
    return "live callback-error arm"
  }
  if (validated.rawReplies[id + ".outerCommands"] !== undefined) return "outer command read"
  if (stored.criterionBranch === "colour-only-mismatch") return "live colour attempt policy"
  const geometry = rowGeometryChange(validated.rawReplies, id)
  if (geometry) return geometry
  const raw = validated.rawReplies[id + ".callLog"]
  if (typeof raw === "string" && (validated.subject?.kind === "term" || validated.subject?.kind === "mux")) {
    const log = parseJsonStrict(id + " call log", raw)
    const refusal = recordedRootValue(log, "captureGeometryRefusal").value
    const kind = recordedRootValue(log, "runCaptureKind").value
    // 34675: a pixel run hands the live finalizer this refusal; the replay's finalizer is handed none.
    if (typeof refusal === "string" && refusal.length > 0 && kind !== "text-cells") {
      return "capture-geometry refusal handed to the live finalizer"
    }
  }
  return undefined
}

/**
 * Shadow one stored run. `runPath` is the saved private run; its blobs sit under the same directory. `suite` is
 * the suite this process executes, so a run from another suite is refused by the bound reader, by name.
 */
export async function shadowStoredRun(
  runPath: string,
  suite: { manifest: ProbeSuiteManifest & { schemaVersion: 4 }; sourceRevision: string },
): Promise<ShadowReport> {
  const bytes = readFileSync(runPath)
  const sha256 = createHash("sha256").update(bytes).digest("hex")
  const stored = parseJsonStrict("stored run " + basename(runPath), bytes.toString("utf8")) as CapturedRunDraft
  const directory = dirname(runPath)
  const report: ShadowReport = {
    format: SHADOW_REPORT_FORMAT,
    version: SHADOW_REPORT_VERSION,
    scope: SCOPE,
    run: {
      runId: stored.runId,
      suiteId: stored.suiteId,
      sourceRevision: stored.sourceRevision,
      subject: { kind: stored.subject.kind, id: stored.subject.id, version: stored.subject.version },
      artifact: { path: basename(runPath), sha256 },
    },
    replayedWith: { suiteId: suite.manifest.probeHash, sourceRevision: suite.sourceRevision },
    families: [],
    excluded: [],
    rows: [],
  }
  let validated: ValidatedRun | undefined
  try {
    validated = readProbeCapture(
      directory,
      {
        kind: "trace",
        trace: { path: basename(runPath), sha256 },
        captureRunId: stored.runId,
        captureSuiteId: stored.suiteId,
        captureSourceRevision: stored.sourceRevision,
      },
      {
        manifest: suite.manifest,
        sourceRevision: suite.sourceRevision,
        subject: stored.subject,
        ...(stored.runtimeIdentity && { runtimeIdentity: stored.runtimeIdentity }),
      },
    ).capture
  } catch (error) {
    // The bound reader refused the run: an unbound, unparsable or tampered artifact is not replayable.
    report.runIncomplete =
      error instanceof IncompleteReplay ? error.message : `${errorName(error)}: ${errorMessage(error)}`
  }
  const excluded = new Map<string, string[]>()
  for (const result of stored.results ?? []) {
    const featureId = result.featureId
    if (result.attempt?.scope === "none") {
      excluded.set("not executed in this run", [...(excluded.get("not executed in this run") ?? []), featureId])
      continue
    }
    const family = familyOf(featureId, stored.subject)
    if (family !== "sgr" && family !== "outer-command") {
      excluded.set(family, [...(excluded.get(family) ?? []), featureId])
      continue
    }
    report.rows.push(await shadowRow(validated, report.runIncomplete, result, family))
  }
  for (const [reason, featureIds] of excluded) report.excluded.push({ reason, rows: featureIds.length, featureIds })
  for (const family of ["sgr", "outer-command"] as const) {
    const rows = report.rows.filter((row) => row.family === family)
    report.families.push({
      family,
      rows: rows.length,
      agree: rows.filter((row) => row.outcome === "agree").length,
      disagree: rows.filter((row) => row.outcome === "disagree").length,
      incomplete: rows.filter((row) => row.outcome === "incomplete").length,
      notComparable: rows.filter((row) => row.outcome === "not-comparable").length,
    })
  }
  const counted = report.rows.length + report.excluded.reduce((sum, entry) => sum + entry.rows, 0)
  if (counted !== (stored.results ?? []).length) {
    throw new Error(`Shadow counted ${counted} rows of ${(stored.results ?? []).length} in ${basename(runPath)}`)
  }
  return report
}

async function shadowRow(
  validated: ValidatedRun | undefined,
  runIncomplete: string | undefined,
  stored: ProbeResult,
  family: ShadowFamily,
): Promise<ShadowRow> {
  const { featureId } = stored
  if (!validated) return { featureId, family, outcome: "incomplete", reason: runIncomplete ?? "run not validated" }
  // Comparability is decided before any status is compared.
  const input = liveOnlyInput(validated, stored)
  if (input) return { featureId, family, outcome: "not-comparable", input, storedStatus: stored.status }
  let replayed: ReplayedRow
  try {
    replayed = await replayRow(validated, featureId)
  } catch (error) {
    const reason =
      error instanceof IncompleteReplay ? error.message : `replay threw ${errorName(error)}: ${errorMessage(error)}`
    return { featureId, family, outcome: "incomplete", reason }
  }
  const domain = recordReplayedRow({ featureId, ...replayed, rawReplies: {}, assertions: [] })
  const subject = validated.subject
  const graded =
    subject && (subject.kind === "term" || subject.kind === "mux")
      ? finalizeVisualResult(domain, subject, replayed.frames)
      : domain
  if (graded.status === stored.status) {
    return { featureId, family, outcome: "agree", status: graded.status, reasonsEqual: graded.reason === stored.reason }
  }
  return {
    featureId,
    family,
    outcome: "disagree",
    stored: { status: stored.status, ...(stored.reason !== undefined && { reason: stored.reason }) },
    replayed: { status: graded.status, ...(graded.reason !== undefined && { reason: graded.reason }) },
  }
}
