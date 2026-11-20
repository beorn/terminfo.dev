/** Host validation of the existing immutable schema-4 capture before offline erase execution. */
import { isDeepStrictEqual } from "node:util"
import type { RunDraft, ProbeSubject, HeadlessRuntimeIdentity, ProbeSuiteManifest } from "@terminfo/probe-defs"
import { parseRun, parseJsonStrict } from "@terminfo/run-parser"
import { readCallLog, withCallLog, IncompleteReplay, type CallLog } from "viprobe"
import {
  CAPTURE_BINDING_SUFFIX,
  CaptureBindingMalformed,
  parseCaptureBinding,
  type CaptureBinding,
} from "@terminfo/probe-defs"
import { eraseProbes } from "../probe-defs/src/erase.ts"
import { HEADLESS_TERMINAL } from "./headless-terminal.ts"
import { resolveRetained, RetainedStoreError, type RetainedResolution } from "../terminfo.dev/src/capture-core.ts"

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

/**
 * One retained reference through the retention owner (#34769): the exact present file, or an absent
 * original its directory's receipt maps to an encoded file. Refusals keep the replay error type.
 */
export function resolveReference(directory: string, reference: unknown): RetainedResolution {
  try {
    return resolveRetained(directory, reference)
  } catch (error) {
    if (error instanceof RetainedStoreError) throw new IncompleteReplay(error.message)
    throw error
  }
}

/** Shared private schema-4 artifact binding; family-specific checks follow this read. */
export function readProbeCapture(
  directory: string,
  source: Extract<RunDraft["source"], { kind: "trace" }>,
  expected: {
    manifest: ProbeSuiteManifest & { schemaVersion: 4 }
    sourceRevision: string
    subject: ProbeSubject
    runtimeIdentity?: HeadlessRuntimeIdentity
  },
) {
  const trace = resolveReference(directory, source.trace)
  const bytes = trace.bytes.toString("utf8")
  const capture = parseRun(
    source.trace.path,
    bytes,
    expected.manifest.catalogIds ?? [],
    new Map([[expected.manifest.probeHash, expected.manifest]]),
  )
  if (
    capture.schemaVersion !== 4 ||
    capture.source?.kind !== "live" ||
    capture.runId !== source.captureRunId ||
    capture.suiteId !== source.captureSuiteId ||
    capture.suiteId !== expected.manifest.probeHash ||
    capture.sourceRevision !== source.captureSourceRevision ||
    capture.sourceRevision !== expected.sourceRevision ||
    !isDeepStrictEqual(capture.subject, expected.subject) ||
    !isDeepStrictEqual(capture.runtimeIdentity, expected.runtimeIdentity)
  ) {
    throw new IncompleteReplay("Capture run, suite, source, subject or loaded runtime binding differs")
  }
  // Physical dependencies, as the retention owner resolved them; a receipt serving many blobs is listed once.
  const files = [...trace.files]
  const references = [...capture.screenshotRefs, ...capture.textSnapshotRefs]
  // These are dependency slots, not a second observation/result parser. Parsed frames
  // already have semantic validation; raw traces need only their binding checked here.
  const frameReference = (frame: unknown) => {
    if (!object(frame)) throw new IncompleteReplay("Capture frame binding is not an object")
    for (const key of ["ref", "sourceRef"] as const) {
      const ref = frame[key]
      if (key === "sourceRef" && ref === undefined) continue
      if (typeof ref !== "string" || !/^sha256:[0-9a-f]{64}$/.test(ref)) {
        throw new IncompleteReplay("Capture frame requires a canonical " + key)
      }
      references.push(ref)
    }
  }
  for (const result of [...(capture.results ?? []), ...capture.observations]) {
    for (const frame of result.frames ?? []) frameReference(frame)
  }
  for (const shape of capture.textQualification?.shapes ?? []) {
    for (const frame of shape.frames ?? []) frameReference(frame)
  }
  const traceReferences = (label: string, raw: string) => {
    const trace = parseJsonStrict(label, raw)
    if (!object(trace)) throw new IncompleteReplay("Capture trace is not an object: " + label)
    if (trace.captures === undefined) return
    if (!Array.isArray(trace.captures)) throw new IncompleteReplay("Capture trace frames are not an array: " + label)
    for (const capture of trace.captures) {
      if (!object(capture)) throw new IncompleteReplay("Capture trace entry is not an object: " + label)
      frameReference(capture.frame)
    }
  }
  for (const result of capture.results ?? []) {
    if (!result.rawReplyRef) continue
    const raw = capture.rawReplies[result.rawReplyRef]
    // Query-only and headless records also use rawReplyRef; their plain replies are not native traces.
    if (typeof raw === "string" && raw.trimStart().startsWith("{")) traceReferences(result.rawReplyRef, raw)
  }
  const calibration = capture.rawReplies["collector.captureCalibration.trace"]
  if (calibration !== undefined) traceReferences("collector.captureCalibration.trace", calibration)
  for (const result of capture.results ?? []) {
    const key = result.featureId + ".callLog"
    const raw = capture.rawReplies[key]
    if (raw === undefined) {
      // A row with no call log still has its association checked against the installation records.
      readCaptureBinding(capture.rawReplies, result.featureId)
      continue
    }
    const log = readCallLog(parseJsonStrict(key, raw), {
      onOperation(operation) {
        if (operation.path === "context.capture" && "value" in operation.outcome) {
          frameReference(operation.outcome.value)
        }
      },
    })
    checkCaptureBinding(capture.rawReplies, result.featureId, log)
  }
  const manifestRaw = capture.rawReplies["collector.traceManifest"]
  if (manifestRaw !== undefined || references.length) {
    if (typeof manifestRaw !== "string") throw new IncompleteReplay("Capture dependencies lack collector.traceManifest")
    const manifest = parseJsonStrict("capture trace manifest", manifestRaw)
    if (!object(manifest) || !Array.isArray(manifest.blobs)) {
      throw new IncompleteReplay("Capture dependencies lack their blob manifest")
    }
    const blobPaths = new Set<string>()
    const blobDigests = new Set<string>()
    for (const blob of manifest.blobs) {
      const resolved = resolveReference(directory, blob)
      if (!object(blob) || typeof blob.path !== "string" || blobPaths.has(blob.path)) {
        throw new IncompleteReplay("Capture contains duplicate blob references")
      }
      blobPaths.add(blob.path)
      blobDigests.add("sha256:" + blob.sha256)
      for (const file of resolved.files) if (!files.includes(file)) files.push(file)
    }
    for (const path of references) {
      if (!blobDigests.has(path)) throw new IncompleteReplay("Capture has an unbound blob: " + path)
    }
  }
  return { capture, files }
}

export function readEraseCapture(
  directory: string,
  source: Extract<RunDraft["source"], { kind: "trace" }>,
  expected: {
    manifest: ProbeSuiteManifest & { schemaVersion: 4 }
    sourceRevision: string
    subject: ProbeSubject
    runtimeIdentity: HeadlessRuntimeIdentity
    geometry: typeof HEADLESS_TERMINAL
  },
) {
  const { capture } = readProbeCapture(directory, source, expected)
  const manifestRaw = capture.rawReplies["collector.traceManifest"]
  if (typeof manifestRaw !== "string") throw new IncompleteReplay("Erase capture is missing collector.traceManifest")
  const manifest = parseJsonStrict("erase trace manifest", manifestRaw)
  if (
    !object(manifest) ||
    Object.keys(manifest).sort().join(",") !== "blobs,captureKind,geometry" ||
    manifest.captureKind !== "buffer_state" ||
    !isDeepStrictEqual(manifest.geometry, expected.geometry) ||
    !Array.isArray(manifest.blobs)
  ) {
    throw new IncompleteReplay("Erase capture kind, geometry or blob manifest differs")
  }
  const raw = capture.rawReplies["collector.callLog"]
  if (typeof raw !== "string") throw new IncompleteReplay("Erase capture is missing collector.callLog")
  const opened: string[] = []
  const log = readCallLog(parseJsonStrict("erase capture call log", raw), {
    onOperation(operation) {
      if (operation.path !== "context.open") return
      if (
        typeof operation.args[0] !== "string" ||
        !isDeepStrictEqual(operation.args[1], expected.geometry) ||
        !("value" in operation.outcome) ||
        !object(operation.outcome.value) ||
        operation.outcome.value.cols !== expected.geometry.cols
      ) {
        throw new IncompleteReplay("Erase context geometry differs from its capture manifest")
      }
      opened.push(operation.args[0])
    },
  })
  if (
    !isDeepStrictEqual(
      opened,
      eraseProbes.map(({ id }) => id),
    )
  ) {
    throw new IncompleteReplay("Erase capture does not contain the selected eleven-probe family")
  }
  return { capture, log }
}

/** One installation's own record, read from its `.trace`: the row it was prepared for and what it handed. */
type RecordedInstallation = {
  preparedAt: { row: string; index: number }
  refusal: string | undefined
  captureGeometry: unknown
}

function recordedInstallation(
  rawReplies: Readonly<Record<string, string>>,
  calibrationId: string,
  featureId: string,
): RecordedInstallation | undefined {
  const raw = rawReplies[calibrationId + ".trace"]
  if (raw === undefined) return undefined
  const trace = parseJsonStrict(calibrationId + ".trace", raw)
  const preparedAt = object(trace) ? trace.preparedAt : undefined
  if (
    !object(trace) ||
    !object(preparedAt) ||
    typeof preparedAt.row !== "string" ||
    typeof preparedAt.index !== "number" ||
    !Number.isSafeInteger(preparedAt.index)
  ) {
    throw new IncompleteReplay(
      `replay-incomplete: ${calibrationId} records no preparing row (run predates it) (${featureId})`,
    )
  }
  return {
    preparedAt: { row: preparedAt.row, index: preparedAt.index },
    refusal: typeof trace.refusal === "string" ? trace.refusal : undefined,
    captureGeometry: trace.captureGeometry,
  }
}

/** Installations are numbered in run order: the first, then `renewal.1`, `renewal.2`, and so on. */
function nextCalibrationId(calibrationId: string): string {
  const renewal = /\.renewal\.([1-9][0-9]*)$/.exec(calibrationId)
  return `collector.captureCalibration.renewal.${renewal ? Number(renewal[1]) + 1 : 1}`
}

/**
 * #30932 S1: one row's stored association to the capture installation it was handed, validated, or
 * undefined when the row has none. It is checked against the NAMED installation's own record: the row
 * runs at or after that installation's preparing row and before the next installation's, and the
 * geometry or refusal it carries is the one that installation recorded. Any failure is a named
 * incomplete replay; the stored status of the row is never touched here.
 */
export function readCaptureBinding(
  rawReplies: Readonly<Record<string, string>>,
  featureId: string,
): CaptureBinding | undefined {
  const raw = rawReplies[featureId + CAPTURE_BINDING_SUFFIX]
  if (raw === undefined) return undefined
  let binding: CaptureBinding
  try {
    binding = parseCaptureBinding(parseJsonStrict(featureId + CAPTURE_BINDING_SUFFIX, raw))
  } catch (error) {
    if (error instanceof CaptureBindingMalformed) {
      throw new IncompleteReplay(`replay-incomplete: ${error.message} (${featureId})`)
    }
    throw error
  }
  const id = binding.calibrationId
  const incomplete = (reason: string): never => {
    throw new IncompleteReplay(`replay-incomplete: capture binding names ${id}, ${reason} (${featureId})`)
  }
  // Every preparation retains its `.trace`, refused ones included; its paint `.callLog` exists only
  // when the traced scope finished, so the trace is the installation's record.
  const installation = recordedInstallation(rawReplies, id, featureId) ?? incomplete("which this run did not record")
  const { preparedAt } = installation
  if (binding.rowIndex < preparedAt.index) incomplete(`installed at row ${preparedAt.row}, after this row ran`)
  if (featureId === preparedAt.row && binding.rowIndex !== preparedAt.index) {
    incomplete("whose preparing row is this row at another run position")
  }
  const next = nextCalibrationId(id)
  const following = recordedInstallation(rawReplies, next, featureId)
  if (following !== undefined && following.preparedAt.index <= binding.rowIndex) {
    incomplete(`but ${next} was installed at row ${following.preparedAt.row}, before this row ran`)
  }
  // The row a preparation ran for is recorded by that installation alone, so a row that prepared one
  // installation can never be associated with another, wherever its stored run position says it was.
  for (let other = "collector.captureCalibration"; ; other = nextCalibrationId(other)) {
    const recorded = other === id ? installation : recordedInstallation(rawReplies, other, featureId)
    if (recorded === undefined) break
    if (other !== id && recorded.preparedAt.row === featureId) incomplete(`but this row prepared ${other}`)
  }
  if (binding.outcome === "installed") {
    if (!isDeepStrictEqual(binding.captureGeometry, installation.captureGeometry)) {
      incomplete("whose recorded geometry differs from the one this row carries")
    }
  } else if (installation.captureGeometry !== undefined || installation.refusal !== binding.refusal) {
    incomplete("whose recorded refusal differs from the one this row carries")
  }
  return binding
}

/** The capture geometry the recorded callback context was handed, read without consuming a call. */
function recordedCaptureGeometry(log: CallLog): unknown {
  const session = withCallLog<{ captureGeometry?: unknown }>(null, { mode: "replay", log })
  try {
    const recorded = session.context.captureGeometry
    return recorded === undefined ? undefined : JSON.parse(JSON.stringify(recorded))
  } finally {
    session.abandon()
  }
}

/**
 * A recorded callback that was handed measured geometry must name the installation it came from, and
 * the two must agree: the association is evidence beside the context, never a second value for it.
 */
function checkCaptureBinding(rawReplies: Readonly<Record<string, string>>, featureId: string, log: CallLog): void {
  const binding = readCaptureBinding(rawReplies, featureId)
  const recorded = recordedCaptureGeometry(log)
  // A TTY-only log records no callback context; its row's association is validated above and the
  // geometry comparison applies only where a context was recorded.
  if (recorded === undefined) return
  if (binding === undefined) {
    throw new IncompleteReplay(`replay-incomplete: no capture binding recorded (run predates it) (${featureId})`)
  }
  if (binding.outcome !== "installed" || !isDeepStrictEqual(binding.captureGeometry, recorded)) {
    throw new IncompleteReplay(
      `replay-incomplete: capture binding differs from the geometry the recorded callback was handed (${featureId})`,
    )
  }
}
