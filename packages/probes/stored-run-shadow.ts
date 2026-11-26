/**
 * #30932 S2 (@cto ruling 30932-s2-plan-ruling-1430): re-grade every complete-log row of a stored run from the
 * artifact alone and report, family by family, whether the replay reaches the stored status.
 *
 * The replay is the one per-row replay `runEraseReplay` also uses, and the grade is the one grader:
 * `recordExecutedProbe` and `finalizeVisualResult`. S3 (@cto ruling 30932-s3-plan-ruling-1626) adds headless lib
 * rows: the same replay, dispatched by subject kind, graded by the headless collector's own `gradeLibRow`.
 * The report is private evidence. It changes no stored byte,
 * no status and no published output, and it is not a gate: deletion of live grading still waits on the parent's
 * full same-context run.
 */
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { basename, dirname } from "node:path"
import {
  ALL_PROBES,
  HARNESS_INCOMPLETE_TEST,
  finalizeVisualResult,
  recordExecutedProbe,
  type AssertionType,
  type CapturedRunDraft,
  type LibProbeSource,
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
import { isDeclaredUntestable } from "../probe-defs/src/helpers.ts"
import { hasOuterCommandMatcher } from "../terminfo.dev/src/app-semantic-state.ts"
import { readProbeCapture } from "./erase-capture.ts"
import { declaredLibAssertionTypes, gradeLibRow } from "./headless-batch.ts"

export const SHADOW_REPORT_FORMAT = "terminfo.shadow-report"
export const SHADOW_REPORT_VERSION = 1

/** The bound reader's validated run: every binding, installation order, geometry and call log already checked. */
type ValidatedRun = ReturnType<typeof readProbeCapture>["capture"]

export interface ReplayedRow {
  startedAt: string
  result: ProbeCallbackResult
  /** The frames the recorded `context.capture` calls returned, in order: the finalizer's evidence. */
  frames: ObservationFrame[]
  /** A lib row's declared assertion types, as its replayed declaration predicate chose them. */
  declared?: readonly AssertionType[] | null
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
 * Replay one row from its own full-source call log, with the callback its run's subject ran: a lib subject's
 * declaration predicate and lib callback, otherwise the term callback. Every divergence is an `IncompleteReplay`;
 * a term log recorded before the source clock existed is refused by name, never handed this machine's time.
 */
export async function replayRow(validated: ValidatedRun, featureId: string): Promise<ReplayedRow> {
  if (validated.subject?.kind === "lib") return replayLibRow(validated, featureId)
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
 * #30932 S3: a headless lib row, replayed in the order the collector ran it on the recorded source: the declaration
 * predicate, then the callback. Both read the replay context, so a different read sequence diverges loudly. The
 * recorded returns already carry the collector's query wrapper; nothing is rebuilt. Lib sources have no clock.
 */
function replayLibRow(validated: ValidatedRun, featureId: string): ReplayedRow {
  const definition = ALL_PROBES.find(({ id }) => id === featureId)
  if (!definition?.lib) throw new IncompleteReplay("Missing lib callback: " + featureId)
  // #30932 AC1: a fresh-instance repeated row stores the second pass's own result, so the second pass's recorded log
  // is the evidence for it; the first pass's log same-named beside the run is not.
  const raw =
    validated.rawReplies["collector.repeatCallLog." + featureId] ?? validated.rawReplies[featureId + ".callLog"]
  if (typeof raw !== "string") throw new IncompleteReplay("Missing full-source call log: " + featureId)
  const log = readCallLog(parseJsonStrict(featureId + " call log", raw))
  const session = withCallLog<LibProbeSource>(null, { mode: "replay", log })
  if (session.context.kind !== validated.source.kind) {
    throw new IncompleteReplay("Source shape does not match its live capture: " + featureId)
  }
  const startedAt = new Date().toISOString()
  const declared = declaredLibAssertionTypes(definition, session.context)
  const result = definition.lib(session.context)
  session.finish()
  return {
    startedAt,
    result: JSON.parse(JSON.stringify(result)) as ProbeCallbackResult,
    frames: [],
    ...(declared !== undefined && { declared }),
  }
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

export type ShadowFamily = "sgr" | "outer-command" | `headless:${string}`

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
  "one grader, then compared with the stored status. On a headless (lib) subject every executed row with a lib " +
  "callback is in its headless:<feature prefix> family: replayed from its own call log through the bound reader, " +
  "its declaration predicate and lib callback and the headless collector's grader; a row without a log is " +
  "incomplete there, never excluded. A row the library collector never sent (App only, #38801) is excluded, as is " +
  "every other row, with its reason."

/** #38801: the exclusion reason for a row the library collector never sent. */
export const APP_ONLY_EXCLUSION = "App only: never sent by the library collector"

/** A headless row's family: its feature id's prefix. One rule for every lib probe, so no row falls outside it. */
export function headlessFamily(featureId: string): `headless:${string}` {
  const dot = featureId.indexOf(".")
  return `headless:${dot > 0 ? featureId.slice(0, dot) : featureId}`
}

function shadowFamily(family: string): family is ShadowFamily {
  return family === "sgr" || family === "outer-command" || family.startsWith("headless:")
}

function familyOf(featureId: string, subject: Pick<ProbeSubject, "kind">): ShadowFamily | string {
  // A headless run's family comes from its definition, never from whether a log exists: a missing log is then
  // counted incomplete in that family instead of vanishing from it.
  if (subject.kind === "lib") {
    return ALL_PROBES.find(({ id }) => id === featureId)?.lib ? headlessFamily(featureId) : "no lib callback"
  }
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
  if (
    validated.subject?.kind !== "lib" &&
    validated.observations.some((entry) => entry.featureId === id && entry.outcome === "error")
  ) {
    return "live callback-error arm"
  }
  if (validated.rawReplies[id + ".outerCommands"] !== undefined) return "outer command read"
  if (stored.criterionBranch === "colour-only-mismatch" || stored.criterionBranch === "underline-band") {
    return "live colour attempt policy"
  }
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
 * #30932 S3: the headless collector's own live inputs for one lib row, read from that row's records only. Each one
 * can decide or replace the stored status after the callback returned, so a replay of the callback cannot speak
 * for it. A record that is present but unreadable throws, and the row is then incomplete.
 */
function headlessLiveInput(validated: ValidatedRun, stored: ProbeResult): string | undefined {
  const id = stored.featureId
  const raw = validated.rawReplies
  if (raw[id + ".late"] !== undefined) return "late reply after the sentinel"
  if (raw["collector.repeats." + id] !== undefined && repeatPassRefusal(validated, stored)) {
    return "fresh-instance repeat passes regraded this row"
  }
  // A native host-recipe record is not an input of its own: its captures are the query pairs the callback saw, and
  // the replay hands those back. Only a query that errored live, or a record that cannot be read, leaves the row
  // unspeakable for a replay.
  if (raw["collector.hostRecipes." + id] !== undefined) {
    const captures = hostRecipeCaptures(validated, id)
    const failed = captures.find((capture) => capture.error !== null)
    if (failed) return `native host-recipe query error (${JSON.stringify(failed.query)})`
  }
  if (stored.tests.some((test) => test.id === HARNESS_INCOMPLETE_TEST)) return "harness incomplete (unreproduced)"
  if (stored.tests.some((test) => test.id === "cleanup")) return "backend cleanup failure replaced the graded result"
  // A saved schema-4 run keeps no diagnostics list: the collector's caught error is the row's reason, which it
  // always opens with `headless <backend> probe <id>: ` (headless-batch collectPass). The grader's own refusals
  // ("Callback for ...") are decided from the callback result, which the replay reproduces, so they stay comparable.
  if (
    stored.status === "probe-invalid" &&
    /^headless \S+ probe /.test(stored.reason ?? "") &&
    stored.reason?.includes(` probe ${id}: `)
  ) {
    return "live collector error: " + stored.reason
  }
  const external = LIB_EXTERNAL_READS[id]
  if (external) return "callback reads outside its source: " + external
  return undefined
}

/**
 * Lib callbacks that read something their source does not hand them (census for #30932 S3). A replay cannot give
 * them that read, so their rows are not comparable by name.
 */
const LIB_EXTERNAL_READS: Readonly<Record<string, string>> = {
  // probe-defs extensions.ts: each fresh random value goes into what the callback feeds and expects.
  "extensions.osc52-clipboard": "randomUUID clipboard nonce (headlessClipboardRoundtrip)",
  "extensions.osc52-write": "randomUUID control and target payloads (headlessOsc52Write)",
  "extensions.osc52-read": "randomUUID clipboard nonce (headlessClipboardRead)",
  "extensions.clipboard-paste": "randomUUID paste text (headlessClipboardPaste)",
  "extensions.kitty-graphics.transmit": "crypto.randomUUID image number (newNumber)",
  "extensions.kitty-graphics.display": "crypto.randomUUID image number (newNumber)",
  "extensions.osc99-kitty-notify": "crypto.randomUUID notification id",
}

/** The query captures the live collector handed `withReplyFailureEvidence` for this row. */
/**
 * The query pairs a native host-recipe row recorded, in the order the callback asked. `error` is kept so a row whose
 * live query failed is refused by name rather than replayed as an empty answer.
 */
function hostRecipeCaptures(
  validated: ValidatedRun,
  featureId: string,
): { query: string; response: string; error: unknown }[] {
  const raw = validated.rawReplies["collector.hostRecipes." + featureId]
  if (typeof raw !== "string") throw new IncompleteReplay("Missing native host-recipe record: " + featureId)
  const parsed = parseJsonStrict(featureId + " host recipes", raw)
  const captures = object(parsed) ? parsed.captures : undefined
  if (
    !Array.isArray(captures) ||
    !captures.every(
      (entry) =>
        object(entry) &&
        typeof entry.query === "string" &&
        typeof entry.response === "string" &&
        Object.hasOwn(entry, "error"),
    )
  ) {
    throw new IncompleteReplay("Native host-recipe record is malformed: " + featureId)
  }
  return captures as { query: string; response: string; error: unknown }[]
}

/**
 * #30932 AC1: a fresh-instance repeat stores the second pass's own result. Its row is therefore speakable exactly when
 * that pass is the one that graded it - not a control refusal or a cross-pass disagreement - and the collector
 * recorded that pass's log. An older run recorded neither, and stays unspeakable by name.
 */
function repeatPassRefusal(validated: ValidatedRun, stored: ProbeResult): boolean {
  const id = stored.featureId
  if (stored.tests.some((test) => REPEAT_CROSS_PASS_TESTS.has(test.id))) return true
  if (repeatSecondCaptures(validated, id) === undefined) return true
  return validated.rawReplies["collector.repeatCallLog." + id] === undefined
}

/** The tests the collector writes when a cross-pass comparison, not a callback, decided the stored row. */
const REPEAT_CROSS_PASS_TESTS: ReadonlySet<string> = new Set([
  "reply-control",
  "repeat-execution",
  "repeat-consistency",
])

/** The query pairs of the pass whose result is stored, or undefined when the record names none. */
function repeatSecondCaptures(
  validated: ValidatedRun,
  featureId: string,
): { query: string; response: string }[] | undefined {
  const raw = validated.rawReplies["collector.repeats." + featureId]
  if (typeof raw !== "string") return undefined
  const parsed = parseJsonStrict(featureId + " repeat passes", raw)
  const second = object(parsed) ? parsed.second : undefined
  const captures = object(second) ? second.captures : undefined
  if (captures === undefined) return undefined
  if (
    !Array.isArray(captures) ||
    !captures.every((entry) => object(entry) && typeof entry.query === "string" && typeof entry.response === "string")
  ) {
    throw new IncompleteReplay("Fresh-instance repeat record is malformed: " + featureId)
  }
  return captures as { query: string; response: string }[]
}

function retainedCaptures(validated: ValidatedRun, featureId: string): { query: string; response: string }[] {
  const repeated = repeatSecondCaptures(validated, featureId)
  if (repeated !== undefined) return repeated
  const raw = validated.rawReplies["collector.queryCaptures." + featureId]
  // A native host-recipe row keeps the same query/response pairs under its own record, because the collector's
  // `replyCaptures` are that record's captures.
  if (typeof raw !== "string") {
    const record = validated.rawReplies["collector.hostRecipes." + featureId]
    if (typeof record === "string") {
      return hostRecipeCaptures(validated, featureId).map(({ query, response }) => ({ query, response }))
    }
    throw new IncompleteReplay("Missing retained query captures: " + featureId)
  }
  const parsed = parseJsonStrict(featureId + " query captures", raw)
  const captures = object(parsed) ? parsed.captures : undefined
  if (
    !Array.isArray(captures) ||
    !captures.every((entry) => object(entry) && typeof entry.query === "string" && typeof entry.response === "string")
  ) {
    throw new IncompleteReplay("Retained query captures are malformed: " + featureId)
  }
  return captures as { query: string; response: string }[]
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
    // #38801: the library collector decides an App only row at collection scope and never sends its probe, so there
    // is no call log to replay. A callback's own declared Untestable is recorded at probe scope and still replays.
    if (stored.subject?.kind === "lib" && result.attempt?.scope === "collection" && isDeclaredUntestable(result)) {
      excluded.set(APP_ONLY_EXCLUSION, [...(excluded.get(APP_ONLY_EXCLUSION) ?? []), featureId])
      continue
    }
    const family = familyOf(featureId, stored.subject)
    if (!shadowFamily(family)) {
      excluded.set(family, [...(excluded.get(family) ?? []), featureId])
      continue
    }
    report.rows.push(await shadowRow(validated, report.runIncomplete, result, family))
  }
  for (const [reason, featureIds] of excluded) report.excluded.push({ reason, rows: featureIds.length, featureIds })
  const families: ShadowFamily[] =
    stored.subject.kind === "lib" ? [...new Set(report.rows.map((row) => row.family))].sort() : ["sgr", "outer-command"]
  for (const family of families) {
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
  // Comparability is decided before any status is compared. A live input that cannot be read (a malformed
  // geometry check, say) leaves this one row incomplete, never the whole run.
  let input: string | undefined
  try {
    input =
      liveOnlyInput(validated, stored) ??
      (validated.subject?.kind === "lib" ? headlessLiveInput(validated, stored) : undefined)
  } catch (error) {
    return {
      featureId,
      family,
      outcome: "incomplete",
      reason: `live inputs unreadable: ${errorName(error)}: ${errorMessage(error)}`,
    }
  }
  if (input) return { featureId, family, outcome: "not-comparable", input, storedStatus: stored.status }
  let replayed: ReplayedRow
  try {
    replayed = await replayRow(validated, featureId)
  } catch (error) {
    const reason =
      error instanceof IncompleteReplay ? error.message : `replay threw ${errorName(error)}: ${errorMessage(error)}`
    return { featureId, family, outcome: "incomplete", reason }
  }
  const subject = validated.subject
  let graded: ProbeResult
  if (subject?.kind === "lib") {
    const probe = ALL_PROBES.find(({ id }) => id === featureId)
    let captures: { query: string; response: string }[]
    try {
      captures = retainedCaptures(validated, featureId)
    } catch (error) {
      return { featureId, family, outcome: "incomplete", reason: errorMessage(error) }
    }
    if (!probe) return { featureId, family, outcome: "incomplete", reason: "Missing lib callback: " + featureId }
    graded = gradeLibRow({
      probe,
      result: replayed.result,
      declared: replayed.declared,
      attempt: { scope: "probe", startedAt: replayed.startedAt },
      captures,
    })
  } else {
    const domain = recordReplayedRow({ featureId, ...replayed, rawReplies: {}, assertions: [] })
    graded =
      subject && (subject.kind === "term" || subject.kind === "mux")
        ? finalizeVisualResult(domain, subject, replayed.frames)
        : domain
  }
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
