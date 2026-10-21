/**
 * CLI probe adapter — wraps unified probe-defs with TermContext from tty.ts.
 *
 * Imports ALL_PROBES from @terminfo/probe-defs, creates a TermContext using
 * the tty.ts helpers (query, queryCursorPosition, measureRenderedWidth, queryMode),
 * and exports the same `Probe[]` interface the CLI expects.
 */

import {
  ALL_PROBES as PROBE_DEFS,
  recordExecutedCapability,
  type CapabilityResult,
  type RunDraft,
  type CaptureCells,
  type CapturePixelGeometry,
  type ConsoleBufferOwner,
  type InputFixture,
  type NotTestedCoverage,
  type Observation,
  type ObservationFrame,
  type ProbeAssertion,
  type ProbeDefinition,
  type ProbeResult,
  type TermContext,
  type UngradedDiagnostic,
  type Utf8DecodingReading,
} from "@terminfo/probe-defs"
import {
  query,
  queryOutcome,
  queryWithSentinel,
  queryWithSentinelOutcome,
  queryCursorPosition,
  measureRenderedWidth,
  measureUtf8Decoding,
  queryMode,
  readResponse,
  withTTYOperation,
  withTTYQueryTrace,
  type TTYQueryTrace,
  type TTYTraceEvent,
} from "../tty.ts"
import type { ClipboardTraceEvent } from "../linux-clipboard.ts"
import { ownedTerminalVerifiedFor, type GeometryMeasurement, type OwnedTerminal } from "../owned-terminal.ts"
import {
  bindReceiptToRun,
  readDisposableReceipt,
  type DisposableReceipt,
  type ReceiptTarget,
} from "../disposable-receipt.ts"

/**
 * Resolve the disposable-ownership receipt once per batch (27832 amendment 1). No receipt is
 * normal and means the untouched default path; a receipt that was declared but cannot be verified
 * is loud, before any byte is written, because a silent fall back to "shared" would look like a
 * gate while grading nothing.
 */
function resolveDisposableReceipt(): DisposableReceipt | undefined {
  const path = process.env.TERMINFO_DISPOSABLE_RECEIPT
  return path ? readDisposableReceipt(path) : undefined
}

export interface Probe {
  id: string
  name: string
}

/** Build a TermContext from the tty.ts helpers */
function createTermContext({
  out,
  writes,
  events,
  probe,
  geometry,
  utf8Decoding,
  captureGeometryRefusal,
}: {
  out: NodeJS.WriteStream
  writes?: string[]
  events?: TTYTraceEvent[]
  probe: ProbeDefinition
  geometry?: Pick<Extract<GeometryMeasurement, { status: "measured" }>, "rows" | "cols">
  utf8Decoding: () => Promise<Utf8DecodingReading>
  captureGeometryRefusal?: string
}): TermContext {
  const size = () => {
    if (probe.termNeedsGeometry !== true || !geometry) {
      const error = new Error(`App callback ${probe.id} accessed undeclared or unavailable terminal geometry`)
      error.name = "UndeclaredTerminalGeometry"
      throw error
    }
    return geometry
  }
  return {
    write(text: string) {
      writes?.push(text)
      events?.push({ kind: "write", sequence: text })
      out.write(text)
    },
    async queryCursorPosition() {
      const result = await queryCursorPosition()
      if (!result) return null
      return { row: result[0], col: result[1] }
    },
    async measureRenderedWidth(text) {
      const setup = "\x1b7\x1b[1G" + text
      writes?.push(setup)
      events?.push({ kind: "write", sequence: setup })
      try {
        return await measureRenderedWidth(text)
      } finally {
        writes?.push("\x1b8")
        events?.push({ kind: "write", sequence: "\x1b8" })
      }
    },
    query,
    queryOutcome,
    queryWithSentinel,
    queryWithSentinelOutcome,
    queryMode,
    readInput: (pattern, timeoutMs = 1000, inject) => readResponse(pattern, timeoutMs, inject),
    get cols() {
      return size().cols
    },
    get rows() {
      return size().rows
    },
    utf8Decoding,
    captureGeometryRefusal,
  }
}

/** Preserve the applicable CLI inventory; execution goes through runProbeBatch. */
export const ALL_PROBES: Probe[] = PROBE_DEFS.filter((p) => p.term !== null).map((p) => ({
  id: p.id,
  name: p.id,
}))

export interface ProbeBatch {
  results: CapabilityResult[]
  rawReplies: Record<string, string>
  observations: Observation[]
  assertions: ProbeAssertion[]
  notTested: NotTestedCoverage[]
  ungradedDiagnostics: Record<string, UngradedDiagnostic>
  suiteComplete: boolean
  screenshotRefs: string[]
  /** Retained text snapshots, kept apart from `screenshotRefs` because every consumer of that list
   * assumes a PNG. */
  textSnapshotRefs: string[]
  /** The apparatus-measured launch receipt, parsed by the ONE parser; the caller copies this block
   * into origin.appLaunch of the run document, adding and editing nothing (28216). */
  appLaunch?: DisposableReceipt["appLaunch"]
}

export type ProbeCapture = (checkpoint: {
  featureId: string
  role: ObservationFrame["role"]
  label: string
  /** The cell-aligned region to digest; the collector maps it to window pixels itself. */
  cells?: CaptureCells
  /** The terminal's own pixel report, required alongside `cells`. */
  pixelGeometry?: CapturePixelGeometry
}) => Promise<{ frame: ObservationFrame; trace: Record<string, unknown> }>

type CapturedProbeFrame = Awaited<ReturnType<ProbeCapture>>

export interface GeometryCorroboration {
  status: "agree" | "conflict" | "uncorroborated" | "silent" | "malformed"
  query: {
    sequence: "\x1b[18t"
    outbound: "\x1b[18t\x1b[c"
    reason: "reply" | "sentinel" | "timeout"
    raw: string
    rawBase64: string
  }
  rows?: number
  cols?: number
}

function selectAppProbes(ids?: string[]): { expected: ProbeDefinition[]; selected: ProbeDefinition[] } {
  const expected = PROBE_DEFS.filter((probe) => probe.term !== null)
  const requested = ids
    ? ids.map((id) => {
        const probe = expected.find((item) => item.id === id)
        if (!probe) throw new Error(`Unknown or inapplicable app probe ${id}`)
        return probe
      })
    : expected
  if (new Set(requested.map((probe) => probe.id)).size !== requested.length) {
    throw new Error("Duplicate probe ID in app batch")
  }
  return {
    expected,
    selected: [
      ...requested.filter((probe) => !probe.id.startsWith("extensions.osc52-")),
      ...requested.filter((probe) => probe.id.startsWith("extensions.osc52-")),
    ],
  }
}

/**
 * The console host a text capture recorded, in the shape the observation publishes: image, the
 * executable this run opened, and that executable's digest. `pid` and `ppid` stay in the trace,
 * because they name one process instance rather than a host a reader can check (30055 AC4; @cto
 * ruling 6255e75d). A malformed owner is loud here rather than dropped.
 */
function capturedConsoleHost(trace: Record<string, unknown>): ConsoleBufferOwner | undefined {
  const owner = trace.bufferOwner
  if (owner === undefined) return undefined
  if (typeof owner !== "object" || owner === null) throw new Error("capture trace bufferOwner is not an object")
  const { image, executablePath, executableSha256 } = owner as Record<string, unknown>
  if (typeof image !== "string" || typeof executablePath !== "string" || typeof executableSha256 !== "string") {
    throw new Error("capture trace bufferOwner is missing image, executablePath or executableSha256")
  }
  return { image, executablePath, executableSha256 }
}

/**
 * Runtime totality guard. `ProbeResult` is a union that makes a measurement or a coverage
 * record mandatory, so a typed callback cannot reach here without one; an untyped caller
 * can, and that is reported rather than silently ungraded.
 */
function claimsMeasurement(result: ProbeResult): boolean {
  const widened: { observation?: unknown; assertions?: readonly unknown[] } = result
  return widened.observation !== undefined || (widened.assertions?.length ?? 0) > 0
}

/** A refused claim keeps its own observation detail and assertion contents in the error text, never as a claim. */
function refusedClaimEvidence(result: ProbeResult): string {
  const parts: string[] = []
  const observation = result.observation
  if (observation) {
    parts.push(
      `observation(${[
        `outcome=${observation.outcome}`,
        ...(observation.reason ? [`reason=${observation.reason}`] : []),
        `evidence=${observation.evidence}`,
        ...(observation.note ? [`note=${JSON.stringify(observation.note)}`] : []),
      ].join(", ")})`,
    )
  }
  for (const assertion of result.assertions ?? []) {
    parts.push(
      `assertion(${[
        `kind=${assertion.kind}`,
        `expected=${JSON.stringify(assertion.expected)}`,
        `observed=${JSON.stringify(assertion.observed)}`,
        ...(assertion.note ? [`note=${JSON.stringify(assertion.note)}`] : []),
      ].join(", ")})`,
    )
  }
  return parts.join(" and ")
}

/**
 * Whether this probe is offered a capture adapter at all.
 *
 * A pixel run is gated by the measured-geometry refusal. A text run is gated by the consumer
 * instead: only the probe whose verdict is about cells may read the text snapshot, because every
 * other probe grades pixels and must take its own named no-capture branch rather than record a
 * pixel claim over a text frame. A text adapter needs no pixel geometry, so a refusal never blocks
 * it.
 */
export function captureAdapterEligible(
  probe: Pick<ProbeDefinition, "cellReadback">,
  captureKind: "pixels" | "text-cells" | undefined,
  captureGeometryRefusal: string | undefined,
): boolean {
  return captureKind === "text-cells" ? probe.cellReadback === true : !captureGeometryRefusal
}

/** Collect the real callback result, without treating its legacy boolean as an observation. */
export async function runProbeBatch(
  options: {
    ids?: string[]
    capture?: ProbeCapture
    /** What the installed adapter reads; a text adapter is honest even where pixel geometry was
     * refused, so it is installed regardless of `captureGeometryRefusal`. */
    captureKind?: "pixels" | "text-cells"
    /** Prepare owned capture calibration and verify restoration before the first callback. */
    prepareCapture?: (input: {
      context: TermContext
      featureId: string
      recordCapture: (result: CapturedProbeFrame) => void
    }) => Promise<void>
    /**
     * The named cause when this run's owned capture pre-flight refused to map the terminal's own
     * cell-to-pixel geometry (28785): it reaches each row's context so a refused row NAMES the
     * cause instead of reporting only that no capture adapter exists. Absent when an adapter was
     * installed, and absent when this run has no capture path at all. Named captureGeometryRefusal
     * so it does not collide with probe-defs' own captureRefusal (a row refusing to capture an
     * undersized terminal) — one name per concept (@cto, 28785 REVISE round 2, must 4).
     */
    captureGeometryRefusal?: string
    input?: InputFixture
    ownedTerminal?: OwnedTerminal
    captureRunId?: string
    out?: NodeJS.WriteStream
    geometryCorroboration?: GeometryCorroboration
    /** The target this run is measuring, from the measured side (the launched app), never read out
     * of the receipt. A receipt naming another target is refused before the first write (27874). */
    target?: ReceiptTarget
    draft?: Pick<RunDraft, "results">
    onCheckpoint?: (batch: ProbeBatch) => void
  } = {},
): Promise<ProbeBatch> {
  const out = options.out ?? process.stdout
  const { expected, selected } = selectAppProbes(options.ids)
  const batch: ProbeBatch = {
    results:
      options.draft?.results ??
      PROBE_DEFS.map((probe) => ({
        featureId: probe.id,
        status: "test-todo",
        attempt: { scope: "none" },
        checks: [],
        reason: "Required callback has not started",
      })),
    rawReplies: {},
    observations: [],
    assertions: [],
    notTested: [],
    ungradedDiagnostics: {},
    suiteComplete: false,
    screenshotRefs: [],
    textSnapshotRefs: [],
  }
  const geometryChecks: Array<{
    featureId: string
    pre?: GeometryMeasurement
    post?: GeometryMeasurement
    diagnostic?: string
  }> = []
  const unavailable = (error: unknown): GeometryMeasurement => ({
    status: "unavailable",
    at: new Date().toISOString(),
    source: options.ownedTerminal?.geometrySource ?? "unavailable: no verified output device",
    diagnostic: error instanceof Error ? error.message : String(error),
    stdout: "",
    stderr: "",
  })
  const readGeometry = async (): Promise<GeometryMeasurement> => {
    try {
      if (!options.ownedTerminal) throw new Error("No owned geometry reader")
      return await options.ownedTerminal.readGeometry()
    } catch (error) {
      return unavailable(error)
    }
  }
  // Ownership is checked ONCE, before the first write, never per probe (27832 amendment 1). A
  // mutation-and-readback probe additionally needs a verified disposable-ownership receipt; an
  // absent or unparsable receipt is loud, and no env flag or caller option stands in for it.
  const ownsTerminal = ownedTerminalVerifiedFor(options.ownedTerminal, options.captureRunId ?? "", out)
  const clipboard = ownsTerminal ? options.ownedTerminal?.clipboard : undefined
  const assertOwned = clipboard?.assertOwned.bind(clipboard)
  const custody: { failure?: { error: unknown } } = {}
  const verify = assertOwned
    ? async () => {
        if (custody.failure) throw custody.failure.error
        try {
          await assertOwned()
        } catch (error) {
          custody.failure ??= { error }
          throw custody.failure.error
        }
      }
    : undefined
  const disposable = resolveDisposableReceipt()
  // Bind BEFORE the first write: a receipt for another target must not authorize this terminal, and
  // checking it afterwards would mean the wrong terminal was already written to. (27874)
  if (disposable) bindReceiptToRun(disposable, options.target, "collector.disposableOwnership")
  const authorizedToWrite = ownsTerminal || Boolean(disposable)
  if (disposable?.appLaunch) batch.appLaunch = disposable.appLaunch
  batch.rawReplies["collector.disposableOwnership"] = JSON.stringify(
    disposable
      ? {
          kind: disposable.kind,
          runId: disposable.runId,
          collectedAt: disposable.collectedAt,
          receiptSha256: disposable.sha256,
          ...(disposable.declaredTarget ? { declaredTarget: disposable.declaredTarget } : {}),
          ...(disposable.identity ? { identity: disposable.identity } : {}),
        }
      : { kind: "shared" },
  )
  // ONE measured context fact for the whole run (28752): how this terminal decodes a plainly
  // written two-byte UTF-8 character. A row whose oracle compares plainly written glyphs asks for
  // it before grading; the first ask measures, every later ask reads the same answer, and the raw
  // reply is recorded beside the other collector facts so a reader can see what was measured.
  // The ATTEMPT is the memo, not its fulfilled value (@dev/review2): two rows that ask before the
  // first round trip returns share ONE measurement instead of racing a second, and an attempt that
  // fails stays failed for the batch rather than being retried by every later row — so the run's
  // recorded fact and the answer each row grades against are always the same single attempt.
  let decodingAttempt: Promise<Utf8DecodingReading> | undefined
  const readUtf8Decoding = (): Promise<Utf8DecodingReading> => {
    decodingAttempt ??= measureUtf8Decoding().then((reading) => {
      batch.rawReplies["collector.utf8Decoding"] = JSON.stringify({ decoding: reading })
      return reading
    })
    return decodingAttempt
  }
  // Calibrate and prove restoration once before the first callback. The same measured geometry
  // reaches every later context; a query callback is not permission to paint an unowned terminal.
  let capturePrepared = false
  let captureGeometry: TermContext["captureGeometry"]
  let captureGeometryRefusal = options.captureGeometryRefusal
  const recordCapture = (
    featureId: string,
    captures: CapturedProbeFrame[],
    result: CapturedProbeFrame,
    expectedRole?: ObservationFrame["role"],
  ) => {
    if (
      (expectedRole !== undefined && result.frame.role !== expectedRole) ||
      !/^sha256:[a-f0-9]{64}$/.test(result.frame.ref)
    ) {
      throw new Error(`Capture adapter returned an invalid frame for ${featureId}`)
    }
    captures.push(result)
    // The frame's own kind decides which list holds its ref, so a text snapshot is never listed as a
    // screenshot.
    const refs = result.frame.kind === "text-cells" ? batch.textSnapshotRefs : batch.screenshotRefs
    if (!refs.includes(result.frame.ref)) refs.push(result.frame.ref)
  }
  for (const probe of selected) {
    const writes: string[] = []
    const queries: TTYQueryTrace[] = []
    const events: TTYTraceEvent[] = []
    const clipboardEvents: ClipboardTraceEvent[] = []
    const captures: Array<{ frame: ObservationFrame; trace: Record<string, unknown> }> = []
    let captureAttempted = false
    const needsOwnership = probe.termWrites !== "query" || probe.termNeedsDisposable === true
    const refusedBecause = !needsOwnership
      ? undefined
      : !authorizedToWrite
        ? "neither a verified owned terminal nor a verified disposable-ownership receipt was presented"
        : probe.termNeedsDisposable === true && !disposable
          ? "no verified disposable-ownership receipt was presented"
          : undefined
    if (refusedBecause) {
      batch.observations.push({
        featureId: probe.id,
        outcome: "inconclusive",
        reason: "policy-refused",
        evidence: "none",
        note: `Collector refused before sending bytes because ${refusedBecause}`,
        rawReplyRef: probe.id,
      })
      batch.rawReplies[probe.id] = JSON.stringify({ writes, queries, events })
      const pending = batch.results.find((result) => result.featureId === probe.id)
      if (!pending) throw new Error(`Native prerequisite ${probe.id} is outside initialized catalogue`)
      pending.reason = `Required grant missing: ${refusedBecause}`
      pending.rawReplyRef = probe.id
      pending.checks = [
        {
          id: "prerequisite",
          status: "test-todo",
          attempt: { scope: "none" },
          reason: pending.reason,
          rawReplyRef: probe.id,
        },
      ]
      options.onCheckpoint?.(batch)
      continue
    }
    let geometryStartedAt: string | undefined
    let preGeometry: GeometryMeasurement | undefined
    let geometryCheck: (typeof geometryChecks)[number] | undefined
    if (probe.termNeedsGeometry) {
      geometryCheck = { featureId: probe.id }
      geometryChecks.push(geometryCheck)
      const grant = ownsTerminal ? options.ownedTerminal?.geometryAtGrant : undefined
      if (grant?.status === "measured") {
        geometryStartedAt = new Date().toISOString()
        preGeometry = await readGeometry()
        geometryCheck.pre = preGeometry
      }
      const corroboration = options.geometryCorroboration
      const diagnostic = !ownsTerminal
        ? "No verified owned terminal for geometry read"
        : grant?.status !== "measured"
          ? `Grant geometry unavailable: ${grant?.status === "unavailable" ? grant.diagnostic : "no owned measurement"}`
          : preGeometry?.status !== "measured"
            ? `Pre-callback geometry unavailable: ${preGeometry?.status === "unavailable" ? preGeometry.diagnostic : "no measurement"}`
            : corroboration?.status === "conflict"
              ? `CSI 18t geometry ${corroboration.rows}x${corroboration.cols} conflicts with stty ${preGeometry.rows}x${preGeometry.cols}`
              : corroboration?.status === "agree" &&
                  (corroboration.rows !== preGeometry.rows || corroboration.cols !== preGeometry.cols)
                ? `Pre-callback stty geometry ${preGeometry.rows}x${preGeometry.cols} differs from CSI 18t ${corroboration.rows}x${corroboration.cols}`
                : undefined
      if (diagnostic) {
        geometryCheck.diagnostic = diagnostic
        batch.observations.push({
          featureId: probe.id,
          outcome: "inconclusive",
          reason: "insufficient-evidence",
          evidence: "none",
          note: diagnostic,
          rawReplyRef: probe.id,
        })
        batch.rawReplies[probe.id] = JSON.stringify({ writes, queries, events })
        const pending = batch.results.find((result) => result.featureId === probe.id)
        if (!pending) throw new Error(`Native geometry ${probe.id} is outside initialized catalogue`)
        const attempt = geometryStartedAt
          ? { scope: "probe" as const, startedAt: geometryStartedAt }
          : { scope: "none" as const }
        pending.status = geometryStartedAt ? "test-failure" : "test-todo"
        pending.attempt = attempt
        pending.reason = diagnostic
        pending.rawReplyRef = probe.id
        pending.checks = [
          { id: "geometry", status: pending.status, attempt, reason: diagnostic, rawReplyRef: probe.id },
        ]
        options.onCheckpoint?.(batch)
        continue
      }
    }
    const context = createTermContext({
      out,
      writes,
      events,
      probe,
      geometry: preGeometry?.status === "measured" ? preGeometry : undefined,
      utf8Decoding: readUtf8Decoding,
      captureGeometryRefusal,
    })
    if (captureGeometry) context.captureGeometry = captureGeometry
    if (clipboard && clipboard.profile !== "default" && verify) {
      context.withClipboardFixture = (work) =>
        clipboard.withClipboardFixture(work, (event) => clipboardEvents.push(event), verify)
    }
    if (options.input) {
      const input = options.input
      const injectDrag = input.injectDrag?.bind(input)
      context.input = {
        injectKey: (keys) => withTTYOperation(() => input.injectKey(keys), out, verify),
        injectClick: (button) => withTTYOperation(() => input.injectClick(button), out, verify),
        ...(injectDrag && { injectDrag: (button: 1) => withTTYOperation(() => injectDrag(button), out, verify) }),
      }
    }
    const capture = options.capture
    // A text run hands its adapter to the region readback alone: it is the one consumer whose
    // verdict is about cells. Every other probe reads pixels, so it gets no adapter here and takes
    // its own named no-capture branch — an error row where a named refusal belongs is exactly what
    // the no-capture branches exist to avoid.
    const textCells = options.captureKind === "text-cells"
    const captureEligible = captureAdapterEligible(probe, options.captureKind, captureGeometryRefusal)
    if (capture && captureEligible) {
      if (textCells) {
        context.captureKind = "text-cells"
        context.cells = async (checkpoint) => {
          captureAttempted = true
          const result = await withTTYOperation(() => capture({ featureId: probe.id, ...checkpoint }), out, verify)
          recordCapture(probe.id, captures, result, checkpoint.role)
          return result.frame
        }
      } else {
        context.capture = async (checkpoint) => {
          captureAttempted = true
          const result = await withTTYOperation(() => capture({ featureId: probe.id, ...checkpoint }), out, verify)
          recordCapture(probe.id, captures, result, checkpoint.role)
          return result.frame
        }
      }
    }
    const prepareCapture = options.prepareCapture
    if (prepareCapture && !capturePrepared) {
      if (!authorizedToWrite) throw new Error("Capture preparation requires verified terminal ownership before paint")
      const calibrationId = "collector.captureCalibration"
      const declared = ownsTerminal ? options.ownedTerminal?.geometryAtGrant : undefined
      const reported = options.geometryCorroboration
      let preparationGrid: { rows: number; cols: number } | undefined
      const calibrationWrites: string[] = []
      const calibrationQueries: TTYQueryTrace[] = []
      const calibrationEvents: TTYTraceEvent[] = []
      const calibrationCaptures: CapturedProbeFrame[] = []
      try {
        if (reported?.query.reason === "timeout") {
          throw new Error(
            `Capture calibration CSI 18t timed out; repeat the run. Reply: ${JSON.stringify(reported.query)}`,
          )
        }
        if (reported?.status === "conflict" || reported?.status === "malformed") {
          throw Object.assign(
            new Error(`Capture calibration verified grid disagrees with terminal reply: ${reported.status}`),
            { name: "CaptureCalibrationRefused" },
          )
        }
        if (declared?.status !== "measured") {
          if (
            !reported ||
            !["agree", "uncorroborated"].includes(reported.status) ||
            typeof reported.rows !== "number" ||
            typeof reported.cols !== "number" ||
            !Number.isSafeInteger(reported.rows) ||
            !Number.isSafeInteger(reported.cols) ||
            reported.rows < 2 ||
            reported.cols < 2
          ) {
            throw new Error(
              "Capture calibration verified grid is unavailable: no terminal grid reply or verified declared size",
            )
          }
          preparationGrid = { rows: reported.rows, cols: reported.cols }
        } else {
          const current = preGeometry ?? (await readGeometry())
          geometryChecks.push({ featureId: calibrationId, pre: current })
          if (current.status !== "measured") {
            throw new Error(`Capture calibration current owned grid is unavailable: ${current.diagnostic}`)
          }
          if (current.rows !== declared.rows || current.cols !== declared.cols) {
            throw new Error(
              `Capture calibration owned grid changed from grant ${declared.rows}x${declared.cols} to ${current.rows}x${current.cols}`,
            )
          }
          if (
            reported &&
            ["agree", "uncorroborated"].includes(reported.status) &&
            (reported.rows !== current.rows || reported.cols !== current.cols)
          ) {
            throw Object.assign(
              new Error(
                `Capture calibration current owned grid ${current.rows}x${current.cols} disagrees with terminal grid ${reported.rows}x${reported.cols}`,
              ),
              { name: "CaptureCalibrationRefused" },
            )
          }
          preparationGrid = { rows: current.rows, cols: current.cols }
        }
        const preparationContext = createTermContext({
          out,
          writes: calibrationWrites,
          events: calibrationEvents,
          probe: { ...probe, termNeedsGeometry: true },
          geometry: preparationGrid,
          utf8Decoding: readUtf8Decoding,
          captureGeometryRefusal,
        })
        // Outside the per-probe catch: an unproved restore fails the RUN, not one feature.
        await withTTYOperation(
          () =>
            withTTYQueryTrace(calibrationQueries, calibrationEvents, () =>
              prepareCapture({
                context: preparationContext,
                featureId: calibrationId,
                recordCapture: (captured) => recordCapture(calibrationId, calibrationCaptures, captured),
              }),
            ),
          out,
          verify,
        )
        captureGeometry = preparationContext.captureGeometry
        captureGeometryRefusal = preparationContext.captureGeometryRefusal
      } catch (error) {
        if (!(error instanceof Error) || error.name !== "CaptureCalibrationRefused") throw error
        captureGeometryRefusal = error.message
      } finally {
        batch.rawReplies[`${calibrationId}.trace`] = JSON.stringify({
          grid: preparationGrid,
          geometryCorroboration: reported,
          refusal: captureGeometryRefusal,
          writes: calibrationWrites,
          queries: calibrationQueries,
          events: calibrationEvents,
          captures: calibrationCaptures,
        })
      }
      capturePrepared = true
      if (captureGeometry) context.captureGeometry = captureGeometry
      if (captureGeometryRefusal) context.captureGeometryRefusal = captureGeometryRefusal
      if (captureGeometryRefusal) context.capture = undefined
    }
    const attempt = { scope: "probe" as const, startedAt: new Date().toISOString() }
    const activeIndex = batch.results.findIndex((result) => result.featureId === probe.id)
    const active = batch.results[activeIndex]
    if (!active) throw new Error(`Native callback ${probe.id} is outside the initialized catalogue`)
    batch.results[activeIndex] = {
      ...active,
      attempt,
      reason: "Callback attempt started; no result recorded yet",
    }
    options.onCheckpoint?.(batch)
    let callbackChecks: ProbeResult["checks"]
    let criterionBranch: string | undefined
    try {
      if (!probe.term) throw new Error(`No app callback for ${probe.id}`)
      const callback = probe.term
      let result
      try {
        result = await withTTYOperation(
          () =>
            withTTYQueryTrace(queries, events, async () => {
              return callback(context)
            }),
          out,
          verify,
        )
      } finally {
        if (geometryCheck) geometryCheck.post = await readGeometry()
      }
      callbackChecks = result.checks
      criterionBranch = result.criterionBranch
      if (
        captureGeometryRefusal &&
        result.observation?.outcome === "inconclusive" &&
        result.observation.evidence === "consumed"
      ) {
        const prior = result.observation.note
        result.observation.note = `${prior ? `${prior}; ` : ""}Pixel capture unavailable: ${captureGeometryRefusal}`
      }
      if (result.notTested) {
        const reason = result.notTested.reason
        const noObservable = result.notTested.noObservable
        if (result.response !== undefined) {
          batch.rawReplies[`${probe.id}.callbackResponse`] = result.response
        }
        if (claimsMeasurement(result)) {
          batch.ungradedDiagnostics[probe.id] = {
            kind: "collector-error",
            name: "Error",
            message: `Not-tested coverage for ${probe.id} arrived beside ${refusedClaimEvidence(result)}; a probe that claims no semantic observable cannot also carry a measurement, so the coverage claim is refused and its evidence stays a collector error`,
          }
        } else if (reason !== "no-semantic-observable" || noObservable.trim().length === 0) {
          batch.ungradedDiagnostics[probe.id] = {
            kind: "collector-error",
            name: "Error",
            message: "Not-tested coverage for " + probe.id + " requires a closed reason and a specific noObservable",
          }
        } else {
          batch.notTested.push({ featureId: probe.id, reason, noObservable, rawReplyRef: probe.id })
        }
      } else if (result.observation) {
        if (result.response !== undefined) {
          batch.rawReplies[`${probe.id}.callbackResponse`] = result.response
        }
        const rawReplyRef =
          queries.length || captureAttempted || clipboardEvents.length || result.observation.evidence === "none"
            ? probe.id
            : undefined
        const post = geometryCheck?.post
        const resized =
          preGeometry?.status === "measured" &&
          (post?.status !== "measured" || post.rows !== preGeometry.rows || post.cols !== preGeometry.cols)
        if (resized) {
          callbackChecks = [
            {
              id: "geometry",
              status: "test-failure",
              reason: `Measured geometry changed or became unavailable after ${probe.id}`,
            },
          ]
          criterionBranch = "resized-capture"
        }
        // The capture trace is where a text read records whose buffer it returned; the observation
        // carries that host so no consumer parses it out of a caption (30055 AC4).
        const host = captures.map((capture) => capturedConsoleHost(capture.trace)).find((value) => value !== undefined)
        batch.observations.push({
          featureId: probe.id,
          ...result.observation,
          ...(host === undefined ? {} : { host }),
          ...(result.note && !result.observation.note ? { note: result.note } : {}),
          ...(resized
            ? {
                outcome: "inconclusive" as const,
                reason: "insufficient-evidence" as const,
                note: `Measured geometry changed or became unavailable after ${probe.id}`,
              }
            : {}),
          ...(rawReplyRef ? { rawReplyRef } : {}),
        })
        for (const assertion of resized ? [] : (result.assertions ?? [])) {
          batch.assertions.push({ featureId: probe.id, ...assertion, ...(rawReplyRef ? { rawReplyRef } : {}) })
        }
      } else {
        // The callback returned neither a measurement nor a coverage record. The type makes
        // that impossible for a typed callback; an untyped caller still gets a loud error.
        batch.ungradedDiagnostics[probe.id] = {
          kind: "collector-error",
          name: "Error",
          message: `Callback for ${probe.id} returned neither an observation nor a not-tested coverage record; its conclusion cannot be graded`,
        }
      }
    } catch (error) {
      if (custody.failure) throw custody.failure.error
      const name = error instanceof Error ? error.name : "Error"
      const message = error instanceof Error ? error.message : String(error)
      // FrameUnavailable joins UndeclaredTerminalGeometry: the probe could not run at all, so the
      // error is named in its own result and nothing about pixels is claimed (27875).
      const errorEvidence =
        name === "UndeclaredTerminalGeometry" || name === "FrameUnavailable"
          ? undefined
          : captureAttempted
            ? options.captureKind === "text-cells"
              ? "text"
              : "pixels"
            : probe.termObservationEvidence
      if (errorEvidence) {
        batch.observations.push({
          featureId: probe.id,
          outcome: "error",
          reason: "collector-error",
          evidence: errorEvidence,
          note: message,
          ...(queries.length || captureAttempted || clipboardEvents.length ? { rawReplyRef: probe.id } : {}),
        })
      } else {
        batch.ungradedDiagnostics[probe.id] = { kind: "collector-error", name, message }
      }
    } finally {
      const trace = JSON.stringify({
        writes,
        queries,
        events,
        ...(clipboardEvents.length ? { clipboard: clipboardEvents } : {}),
        ...(captureAttempted ? { captures } : {}),
      })
      if (probe.id === "device.primary-da" || probe.id === "device.secondary-da" || probe.id === "device.xtversion") {
        const queriedRaw = queries.map((item) => item.raw).join("")
        const emittedNotTested = batch.notTested.some((entry) => entry.featureId === probe.id)
        batch.rawReplies[probe.id] = emittedNotTested && queriedRaw.length === 0 ? trace : queriedRaw
        batch.rawReplies[`${probe.id}.trace`] = trace
      } else {
        batch.rawReplies[probe.id] = trace
      }
      const index = batch.results.findIndex((result) => result.featureId === probe.id)
      if (index < 0) throw new Error(`Native callback ${probe.id} is outside the initialized catalogue`)
      batch.results[index] = recordExecutedCapability({
        featureId: probe.id,
        attempt,
        observation: batch.observations.find((entry) => entry.featureId === probe.id),
        diagnostic: batch.ungradedDiagnostics[probe.id],
        coverage: batch.notTested.find((entry) => entry.featureId === probe.id),
        assertions: batch.assertions,
        checks: callbackChecks,
        criterionBranch,
      })
      options.onCheckpoint?.(batch)
    }
  }
  if (ownsTerminal && options.ownedTerminal) {
    batch.rawReplies["collector.geometry"] = JSON.stringify({
      source: options.ownedTerminal?.geometrySource ?? "unavailable: no verified output device",
      bindingReceiptRef: "collector.terminalOwnership",
      grant: options.ownedTerminal.geometryAtGrant ?? null,
      corroboration: options.geometryCorroboration ?? null,
      checks: geometryChecks,
    })
  }
  const observed = new Set(batch.observations.map((item) => item.featureId))
  const namedNotTested = new Set(batch.notTested.map((item) => item.featureId))
  batch.suiteComplete =
    expected.every((probe) => observed.has(probe.id) || namedNotTested.has(probe.id)) &&
    Object.keys(batch.ungradedDiagnostics).length === 0
  await verify?.()
  return batch
}
