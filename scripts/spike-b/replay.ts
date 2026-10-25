import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { isDeepStrictEqual } from "node:util"
import {
  ALL_PROBES,
  recordExecutedCapability,
  type CapturedRunDraft,
  type ProbeResult,
  type TermContext,
} from "@terminfo/probe-defs"
import type { TTYTraceEvent } from "../../packages/terminfo.dev/src/tty.ts"
import { withCallLog, type CallLog, type MethodCall } from "./call-log.ts"

interface RecordedCallback {
  version: 1
  runId: string
  mode: "selection" | "baseline" | "decorated"
  featureId: string
  pid: number
  startedAt: number
  finishedAt: number
  startedMonotonic: number
  finishedMonotonic: number
  firstEvent: number
  nextEvent: number
  events: TTYTraceEvent[]
  log?: CallLog
  result?: ProbeResult
  failure?: { name: string; message: string }
}

const [selectionDirectory, baselineDirectory, decoratedDirectory, outputDirectory] = process.argv.slice(2)
if (!selectionDirectory || !baselineDirectory || !decoratedDirectory || !outputDirectory) {
  throw new Error("Usage: replay.ts SELECTION_RAW BASELINE_RAW DECORATED_RAW NEW_OUTPUT")
}
const startedAt = new Date().toISOString()
const startedMonotonic = performance.now()
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex")
const jsonValue = (value: unknown): unknown => JSON.parse(JSON.stringify(value))
const readJson = <Value>(path: string): Value => JSON.parse(readFileSync(path, "utf8")) as Value
const selection = readJson<CapturedRunDraft>(join(selectionDirectory, "v3-capture.json"))
const selectionCallback = readJson<RecordedCallback>(join(selectionDirectory, "spike-b", "sgr.bold.json"))
const baseline = readJson<CapturedRunDraft>(join(baselineDirectory, "v3-capture.json"))
const decorated = readJson<CapturedRunDraft>(join(decoratedDirectory, "v3-capture.json"))
const decoratedSelection = decorated.rawReplies["collector.selection"]
const baselineSelection = baseline.rawReplies["collector.selection"]
if (decoratedSelection === undefined || baselineSelection === undefined) {
  throw new Error("Baseline or decorated capture lacks collector.selection")
}
const ids = (JSON.parse(decoratedSelection) as { ids: string[] }).ids
if (ids.length !== 3 || !ids.includes("device.tertiary-da") || !ids.includes("erase.screen.scrollback")) {
  throw new Error("Decorated capture does not name the admitted three-specimen selection")
}
const frameId = ids.find((id) => id !== "device.tertiary-da" && id !== "erase.screen.scrollback")
if (frameId !== "sgr.bold" && frameId !== "extensions.font-ligatures") {
  throw new Error(`Frame specimen outside the admitted selection: ${frameId}`)
}
const selectionObservation = selectionCallback.result?.observation
if (
  frameId === "extensions.font-ligatures" &&
  (selectionObservation?.evidence !== "query" || !["supported", "unsupported"].includes(selectionObservation.outcome))
) {
  throw new Error("Font-ligature substitution requires the natural SGR check to have decided from query evidence")
}
if (!isDeepStrictEqual((JSON.parse(baselineSelection) as { ids: string[] }).ids, ids)) {
  throw new Error("Baseline and decorated capture selections differ")
}
if (selection.sourceRevision !== baseline.sourceRevision || baseline.sourceRevision !== decorated.sourceRevision) {
  throw new Error("Selection, baseline and decorated captures name different source revisions")
}

function callbackGrade(featureId: string, result: ProbeResult, attemptAt: number) {
  return recordExecutedCapability({
    featureId,
    attempt: { scope: "probe", startedAt: new Date(attemptAt).toISOString() },
    ...(result.observation ? { observation: { featureId, ...result.observation } } : {}),
    ...(result.notTested ? { coverage: { featureId, ...result.notTested, rawReplyRef: featureId } } : {}),
    assertions: (result.assertions ?? []).map((assertion) => ({ featureId, ...assertion })),
    checks: result.checks,
    criterionBranch: result.criterionBranch,
  })
}

function eventForCall(call: MethodCall): { kind: "write" | "query"; sequence: string } | undefined {
  if (call.path === "context.readInput") return { kind: "query", sequence: "" }
  if (typeof call.args[0] !== "string") return undefined
  if (call.path === "context.write") return { kind: "write", sequence: call.args[0] }
  if (call.path === "context.query" || call.path === "context.queryOutcome") {
    return { kind: "query", sequence: call.args[0] }
  }
  if (call.path === "context.queryWithSentinel" || call.path === "context.queryWithSentinelOutcome") {
    return { kind: "query", sequence: call.args[0] === "\x1b[c" ? call.args[0] : call.args[0] + "\x1b[c" }
  }
  return undefined
}

const specimens = []
for (const featureId of ids) {
  const live = readJson<RecordedCallback>(join(decoratedDirectory, "spike-b", `${featureId}.json`))
  const baselineCallback = readJson<RecordedCallback>(join(baselineDirectory, "spike-b", `${featureId}.json`))
  if (!live.log || live.mode !== "decorated" || live.featureId !== featureId || live.runId !== decorated.runId) {
    throw new Error(`Missing or mismatched decorated callback log for ${featureId}`)
  }
  const definition = ALL_PROBES.find((probe) => probe.id === featureId)
  if (!definition?.term) throw new Error(`Original app callback missing for ${featureId}`)
  const replay = withCallLog<TermContext>(null, { mode: "replay", log: live.log })
  const replayStartedAt = Date.now()
  const replayStartedMonotonic = performance.now()
  let result: ProbeResult | undefined
  let failure: { name: string; message: string } | undefined
  let completionError: string | undefined
  try {
    result = await definition.term(replay.context)
  } catch (error) {
    failure =
      error instanceof Error
        ? { name: error.name, message: error.message }
        : { name: "ThrownValue", message: String(error) }
  }
  try {
    replay.finish()
  } catch (error) {
    completionError = String(error)
  }
  const replayFinishedMonotonic = performance.now()
  const replayFinishedAt = Date.now()
  const rawTraceText = decorated.rawReplies[featureId]
  if (rawTraceText === undefined) throw new Error(`Actual collector trace missing for ${featureId}`)
  const rawTrace = JSON.parse(rawTraceText) as { events: TTYTraceEvent[] }
  const available = live.log.calls.map((call) => ({ call, event: eventForCall(call) }))
  const correspondence = live.events.map((event, index) => {
    const matching = available.findIndex(
      (entry) => entry.event?.kind === event.kind && entry.event.sequence === event.sequence,
    )
    if (matching < 0) {
      return {
        eventIndex: live.firstEvent + index,
        event,
        covered: false,
        cause:
          "No direct decorated method matches this ALS event; helper-internal calls do not re-enter the context proxy",
      }
    }
    const matched = available.splice(matching, 1)[0]
    if (!matched) throw new Error(`Matched method disappeared for ${featureId} event ${index}`)
    return {
      eventIndex: live.firstEvent + index,
      event,
      covered: true,
      callId: matched.call.id,
      path: matched.call.path,
    }
  })
  const liveGrade = live.result ? callbackGrade(featureId, live.result, live.startedAt) : undefined
  const replayGrade = result ? callbackGrade(featureId, result, live.startedAt) : undefined
  const baselineGrade = baseline.results.find((entry) => entry.featureId === featureId)
  const decoratedGrade = decorated.results.find((entry) => entry.featureId === featureId)
  if (!baselineGrade || !decoratedGrade) throw new Error(`Actual collector grade missing for ${featureId}`)
  const deadlineTimings = live.log.calls.flatMap((call) => {
    const deadlineMs = call.effectiveDeadlineMs
    if (deadlineMs === undefined) return []
    const timing = replay.replayTimings.find((entry) => entry.id === call.id)
    const elapsedMs =
      timing?.finishedMonotonic === undefined ? undefined : timing.finishedMonotonic - timing.startedMonotonic
    return [
      {
        id: call.id,
        path: call.path,
        effectiveDeadlineMs: deadlineMs,
        liveElapsedMs:
          call.timing.settledPerformanceMs === undefined
            ? undefined
            : call.timing.settledPerformanceMs - call.timing.startedPerformanceMs,
        replayElapsedMs: elapsedMs,
        belowOneTenthDeadline: elapsedMs !== undefined && elapsedMs < deadlineMs / 10,
      },
    ]
  })
  specimens.push({
    featureId,
    baselineCallback,
    live,
    replay: {
      startedAt: replayStartedAt,
      finishedAt: replayFinishedAt,
      startedMonotonic: replayStartedMonotonic,
      finishedMonotonic: replayFinishedMonotonic,
      result,
      failure,
      complete: completionError === undefined,
      unansweredCalls: completionError === undefined ? 0 : "unresolved; see completionError",
      completionError,
      timings: replay.replayTimings,
    },
    sameCallbackOutcome: isDeepStrictEqual(
      jsonValue({ result: live.result, failure: live.failure }),
      jsonValue({ result, failure }),
    ),
    liveCallbackGrade: liveGrade,
    replayCallbackGrade: replayGrade,
    sameCallbackGrade: isDeepStrictEqual(jsonValue({ grade: liveGrade }), jsonValue({ grade: replayGrade })),
    baselineCollectorGrade: baselineGrade,
    decoratedCollectorGrade: decoratedGrade,
    sameBaselineStatus: baselineGrade.status === decoratedGrade.status,
    replayMatchesCollectorStatus: replayGrade?.status === decoratedGrade.status,
    clockViolations: live.log.calls
      .filter(
        (call) =>
          call.timing.settledPerformanceMs === undefined ||
          call.timing.startedPerformanceMs < live.startedMonotonic ||
          call.timing.settledPerformanceMs < call.timing.startedPerformanceMs ||
          call.timing.settledPerformanceMs > live.finishedMonotonic,
      )
      .map((call) => ({ id: call.id, path: call.path, timing: call.timing })),
    frameClockChecks: (live.result?.observation?.frames ?? []).map((frame) => ({
      label: frame.label,
      capturedAt: frame.capturedAt,
      withinCallbackWallInterval: frame.capturedAt >= live.startedAt && frame.capturedAt <= live.finishedAt,
    })),
    capturedFrameCalls: live.log.calls.filter((call) => call.path === "context.capture" && call.finished && !call.error)
      .length,
    rawTrace,
    sameALSSlice: isDeepStrictEqual(rawTrace.events.slice(live.firstEvent, live.nextEvent), live.events),
    correspondence,
    unmatchedDirectMethods: available
      .filter((entry) => entry.event !== undefined)
      .map((entry) => ({ id: entry.call.id, path: entry.call.path })),
    deadlineTimings,
  })
}

const artifacts = []
for (const [mode, directory] of [
  ["selection", selectionDirectory],
  ["baseline", baselineDirectory],
  ["decorated", decoratedDirectory],
] as const) {
  for (const filename of readdirSync(join(directory, "artifacts")).sort()) {
    const bytes = readFileSync(join(directory, "artifacts", filename))
    const hash = sha256(bytes)
    if (!filename.startsWith(hash + ".")) throw new Error(`Retained capture digest differs: ${mode}/${filename}`)
    artifacts.push({ mode, filename, sha256: hash, bytes: bytes.length, dataBase64: bytes.toString("base64") })
  }
}
const bundle = {
  version: 1,
  invocation: {
    argv: process.argv,
    cwd: process.cwd(),
    startedAt,
    finishedAt: new Date().toISOString(),
    elapsedMs: performance.now() - startedMonotonic,
  },
  sourceRevision: decorated.sourceRevision,
  frameSpecimen: {
    featureId: frameId,
    substituted: frameId !== "sgr.bold",
    reason:
      frameId === "sgr.bold"
        ? "Natural SGR capture arm selected"
        : "Natural sgr.bold selection answered query-first; existing font-ligature callback exercises Frame capture",
  },
  liveContext: null,
  runs: { selection, baseline, decorated },
  selectionCallback,
  specimens,
  artifacts,
  limitations: [
    "ALS event time is not a source field; correspondence uses exact bytes and per-method clocks, preserving original sentinel-relative and Frame wall clocks",
    "Callback grades and actual collector grades are separate; replay does not simulate collector geometry postprocessing",
    "Synthetic timeout contract proof is separate from these live captures",
  ],
}
mkdirSync(outputDirectory)
const bytes = Buffer.from(JSON.stringify(bundle, null, 2) + "\n")
writeFileSync(join(outputDirectory, "bundle.json"), bytes, { flag: "wx", mode: 0o600 })
const summary = {
  bundleSha256: sha256(bytes),
  bundleBytes: bytes.length,
  frameSpecimen: bundle.frameSpecimen,
  retainedPngFilesIncludingCalibration: artifacts.filter(
    (artifact) => artifact.mode === "decorated" && artifact.filename.endsWith(".png"),
  ).length,
  frameShapeMeasured: specimens.some((entry) => entry.featureId === frameId && entry.capturedFrameCalls > 0),
  specimens: specimens.map((entry) => ({
    featureId: entry.featureId,
    complete: entry.replay.complete,
    sameCallbackOutcome: entry.sameCallbackOutcome,
    sameCallbackGrade: entry.sameCallbackGrade,
    sameBaselineStatus: entry.sameBaselineStatus,
    replayMatchesCollectorStatus: entry.replayMatchesCollectorStatus,
    sameALSSlice: entry.sameALSSlice,
    alsEvents: entry.correspondence.length,
    uncoveredEvents: entry.correspondence.filter((event) => !event.covered).length,
    unmatchedDirectMethods: entry.unmatchedDirectMethods,
    completionError: entry.replay.completionError,
    deadlineTimings: entry.deadlineTimings,
    clockViolations: entry.clockViolations,
    frameClockChecks: entry.frameClockChecks,
    capturedFrameCalls: entry.capturedFrameCalls,
  })),
}
writeFileSync(join(outputDirectory, "summary.json"), JSON.stringify(summary, null, 2) + "\n", {
  flag: "wx",
  mode: 0o600,
})
console.log(JSON.stringify(summary, null, 2))
