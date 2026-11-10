/**
 * CLI probe adapter — wraps unified probe-defs with TermProbeSource from tty.ts.
 *
 * Imports ALL_PROBES from @terminfo/probe-defs, creates a TermProbeSource using
 * the tty.ts helpers (query, queryCursorPosition, measureRenderedWidth, queryMode),
 * and exports the same `Probe[]` interface the CLI expects.
 */

import {
  ALL_PROBES as PROBE_DEFS,
  resolveProbeIds,
  recordExecutedProbe,
  colourSiblingSeparation,
  type OuterColourControl,
  finalizeProbeResult,
  finalizeVisualResult,
  fontLigatureMuxCoverage,
  withReplyFailureEvidence,
  declaredUntestableResult,
  type ProbeResult,
  type ProbeSubject,
  type RunDraft,
  type CaptureCells,
  type CapturePixelGeometry,
  type ConsoleBufferOwner,
  type InputFixture,
  type NotTestedCoverage,
  type PasteRoute,
  type Observation,
  type ObservationFrame,
  type ProbeAssertion,
  type ProbeDefinition,
  type ProbeCallbackResult,
  type TermProbeSource,
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
  readInjectedOutcome,
  releaseTTYQueue,
  withTTYOperation,
  withTTYQueryTrace,
  writeTTY,
  type TTYQueryTrace,
  type TTYTraceEvent,
} from "../tty.ts"
import type { ClipboardTraceEvent } from "../linux-clipboard.ts"
import { createCallLog, withCallLog } from "viprobe"
import {
  ownedTerminalVerifiedFor,
  ownedTerminalProcessBasisFor,
  type GeometryMeasurement,
  type OwnedTerminal,
} from "../owned-terminal.ts"
import { bindReceiptToRun, readDisposableReceipt, type DisposableReceipt } from "../disposable-receipt.ts"
import { beginMuxSgrCommandRead } from "../app-semantic-state.ts"

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

/** Build a TermProbeSource from the tty.ts helpers */
export function createTermProbeSource({
  probe,
  geometry,
  utf8Decoding,
  captureGeometryRefusal,
  onWrite,
}: {
  onWrite?: (text: string) => void
  probe: ProbeDefinition
  geometry?: Pick<Extract<GeometryMeasurement, { status: "measured" }>, "rows" | "cols">
  utf8Decoding: () => Promise<Utf8DecodingReading>
  captureGeometryRefusal?: string
}): TermProbeSource {
  const size = () => {
    if (probe.termNeedsGeometry !== true || !geometry) {
      const error = new Error(`App callback ${probe.id} accessed undeclared or unavailable terminal geometry`)
      error.name = "UndeclaredTerminalGeometry"
      throw error
    }
    return geometry
  }
  return {
    kind: "live",
    write(text: string) {
      onWrite?.(text)
      writeTTY(text)
    },
    async queryCursorPosition() {
      const result = await queryCursorPosition()
      if (!result) return null
      return { row: result[0], col: result[1] }
    },
    measureRenderedWidth,
    query,
    queryOutcome,
    queryWithSentinel,
    queryWithSentinelOutcome,
    queryMode,
    readInput: (pattern, timeoutMs = 1000, inject) => readResponse(pattern, timeoutMs, inject),
    readInjected: (pattern, timeoutMs, inject) => readInjectedOutcome(pattern, timeoutMs, inject),
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
  results: ProbeResult[]
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
  const resolved = resolveProbeIds(ids ?? expected.map((probe) => probe.id))
  if (resolved.result === "invalid") {
    if (resolved.unknownIds.length) throw new Error(`Unknown or inapplicable app probe ${resolved.unknownIds[0]}`)
    throw new Error("Duplicate probe ID in app batch")
  }
  const inapplicable = resolved.probes.find((probe) => probe.term === null)
  if (inapplicable) throw new Error(`Unknown or inapplicable app probe ${inapplicable.id}`)
  // Preserve the caller's schedule; the shared registry resolves definitions in catalogue order.
  const requested = ids ? resolved.probes.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id)) : resolved.probes
  return {
    expected,
    selected: scheduleAppProbes(requested),
  }
}

/**
 * OSC 52 stays after the other probes so a clipboard write does not disturb them. DECRQCRA is
 * last: on iTerm2 it raises a consent banner that covers every later pixel probe (#31741).
 */
export function scheduleAppProbes<T extends { readonly id: string }>(requested: readonly T[]): T[] {
  const body: T[] = []
  const clipboard: T[] = []
  const consent: T[] = []
  for (const probe of requested) {
    if (probe.id === "editing.decrqcra") consent.push(probe)
    else if (probe.id.startsWith("extensions.osc52-")) clipboard.push(probe)
    else body.push(probe)
  }
  return [...body, ...clipboard, ...consent]
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
 * Identify retained measurement claims separately from coverage and execution-only tests, so a
 * callback cannot combine not-tested coverage with an observation or assertion.
 */
function claimsMeasurement(result: ProbeCallbackResult): boolean {
  const widened: { observation?: unknown; assertions?: readonly unknown[] } = result
  return widened.observation !== undefined || (widened.assertions?.length ?? 0) > 0
}

/** A refused claim keeps its own observation detail and assertion contents in the error text, never as a claim. */
function refusedClaimEvidence(result: ProbeCallbackResult): string {
  const parts: string[] = []
  const observation = result.observation
  if (observation) {
    parts.push(
      `observation(${[
        `outcome=${observation.outcome}`,
        ...(observation.reason ? [`reason=${observation.reason}`] : []),
        `assertionType=${observation.assertionType}`,
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

/**
 * Direct Linux Apps whose default paste action is reviewed (@cto 73d66ae2, a4ec8fe2); any other App stays gated.
 * Each route is evidence: the App's own source or manual, at the pinned version, binds the key to paste that
 * selection, and the owned launch passes no config or resource that rebinds it (#32164).
 */
export const LINUX_PASTE_ROUTES: Readonly<Record<string, PasteRoute>> = {
  kitty: { selection: "clipboard", key: "ctrl+shift+v", binding: 
      "kitty 0.49.2 (tag v0.49.2): kitty/options/definition.py:3811 maps kitty_mod+v to paste_from_clipboard, and kitty_mod defaults to ctrl+shift (definition.py:3648-3651)" },
  ghostty: { selection: "clipboard", key: "ctrl+shift+v", binding: 
      "ghostty 1.4.0 (tag v1.4.0): src/config/Config.zig:6698-6716 binds ctrl+shift+v to paste_from_clipboard on Linux" },
  alacritty: { selection: "clipboard", key: "ctrl+shift+v", binding: 
      "alacritty 0.17.0 (tag v0.17.0): alacritty/src/config/bindings.rs:544-549 binds Ctrl+Shift+V to Paste (CLIPBOARD)" },
  wezterm: { selection: "clipboard", key: "ctrl+shift+v", binding: 
      "wezterm 0-unstable-2026-10-10 (rev e2a98e1b8af1): wezterm-gui/src/commands.rs:665-670 declares PasteFrom(Clipboard) on SUPER+v and :126-131 derives CTRL+SHIFT+v from it; docs default-keys.md:19" },
  xterm: {
    selection: "primary",
    key: "shift+Insert",
    binding:
      "xterm 411 (xterm-411.tgz SHA256 969be283): charproc.c:15024, in VTInitTranslations, binds Shift<KeyPress>Insert to insert-selection(SELECT, CUT_BUFFER0); SELECT is PRIMARY under the default selectToClipboard false (xterm.man:5458)",
  },
}

/** Collect the real callback result, without treating its legacy boolean as an observation. */
export async function runProbeBatch(
  options: {
    ids?: string[]
    capture?: ProbeCapture
    /** What the installed adapter reads; a text adapter is honest even where pixel geometry was
     * refused, so it is installed regardless of `captureGeometryRefusal`. */
    captureKind?: "pixels" | "text-cells"
    /** Prepare owned capture through its existing factory, query trace and frame recorder. */
    prepareCapture?: (input: {
      source: TermProbeSource
      featureId: string
      recordCapture: (result: CapturedProbeFrame) => void
    }) => Promise<void>
    /** Default preparation precedes probes; the owned Terminal text arm finishes TTY work last. */
    prepareCapturePhase?: "before-probes" | "after-probes"
    /**
     * The named cause when this run's owned capture pre-flight refused to map the terminal's own
     * cell-to-pixel geometry (28785): it reaches each row's context so a refused row NAMES the
     * cause instead of reporting only that no capture adapter exists. Absent when an adapter was
     * installed, and absent when this run has no capture path at all. Named captureGeometryRefusal
     * so it does not collide with probe-defs' own captureRefusal (a row refusing to capture an
     * undersized terminal) — one name per concept (@cto, 28785 REVISE round 2, must 4).
     */
    captureGeometryRefusal?: string
    input?: InputFixture & {
      resizeWindow?(width: number, height: number, featureId?: string): Promise<{ width: number; height: number }>
    }
    ownedTerminal?: OwnedTerminal
    /** Sees every probe write before it is sent: an owned reader that must know what was drawn. */
    onWrite?: (text: string) => void
    captureRunId?: string
    out?: NodeJS.WriteStream
    geometryCorroboration?: GeometryCorroboration
    /** The target this run is measuring, from the measured side (the launched app), never read out
     * of the receipt. A receipt naming another target is refused before the first write (27874). */
    subject?: { kind: "term" | "lib" | "mux"; id: string; os: string; version?: string }
    /** Exact-version App declarations selected by the collector; only unresolved callbacks use them. */
    appDeclarations?: Readonly<Record<string, string>>
    draft?: Pick<RunDraft, "results"> & Partial<Pick<RunDraft, "subject">>
    onCheckpoint?: (batch: ProbeBatch) => void
    /**
     * The outer control a mux colour negative needs (#33041): the placed outer-terminal record the
     * launcher matched, or why there is none, plus the declared harness profile and mux config the
     * default-colour assumption rests on. Absent on a run that is not a mux run.
     */
    colourControl?: { outer: OuterColourControl; harnessProfile: string; muxConfig: string }
  } = {},
): Promise<ProbeBatch> {
  const out = options.out ?? process.stdout
  const { expected, selected } = selectAppProbes(options.ids)
  const batch: ProbeBatch = {
    results:
      options.draft?.results ??
      PROBE_DEFS.map((probe) => ({
        featureId: probe.id,
        status: "probe-todo",
        attempt: { scope: "none" },
        tests: [],
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
  // mutation-and-readback probe additionally needs a verified disposable receipt or the verified
  // run-scoped process arm. An env flag, caller option or shared application owner grants neither.
  const ownsTerminal = ownedTerminalVerifiedFor(options.ownedTerminal, options.captureRunId ?? "", out)
  const processOwnerBasis = ownedTerminalProcessBasisFor(options.ownedTerminal, options.captureRunId ?? "", out)
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
  if (disposable) {
    bindReceiptToRun(disposable, options.subject, "collector.disposableOwnership")
  }
  const authorizedToWrite = ownsTerminal || Boolean(disposable)
  if (disposable?.appLaunch) {
    batch.appLaunch = disposable.appLaunch
    if (disposable.appLaunch.argv === undefined) {
      batch.rawReplies["collector.appLaunchTrace"] = JSON.stringify({
        argvAbsentReason: `${disposable.appLaunch.executablePath}: hosted wrapper or unpromoted route did not observe an app invocation array`,
      })
    }
  } else if (disposable?.kind === "github-hosted-runner") {
    batch.rawReplies["collector.appLaunchTrace"] = JSON.stringify({
      argvAbsentReason: "Hosted platform measured no app launch receipt; invocation array was not recorded",
    })
  }
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
    if (!decodingAttempt) {
      const queries: TTYQueryTrace[] = []
      const events: TTYTraceEvent[] = []
      let decoding: Utf8DecodingReading | undefined
      decodingAttempt = withTTYQueryTrace(queries, events, measureUtf8Decoding, {
        onLog(log) {
          batch.rawReplies["collector.utf8Decoding.callLog"] = JSON.stringify(log)
        },
      })
        .then((reading) => {
          decoding = reading
          return reading
        })
        .finally(() => {
          batch.rawReplies["collector.utf8Decoding"] = JSON.stringify({
            decoding,
            writes: events.filter((event) => event.kind === "write").map((event) => event.sequence),
            queries,
            events,
          })
        })
    }
    return decodingAttempt
  }
  // Prepare once in the selected phase; default callers still prepare before their first callback.
  // The same measured geometry reaches later contexts; a query callback grants no paint authority.
  let capturePrepared = false
  let captureGeometry: TermProbeSource["captureGeometry"]
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
  const prepareCaptureOnce = async (probe: ProbeDefinition, preGeometry?: GeometryMeasurement): Promise<void> => {
    const prepareCapture = options.prepareCapture
    if (prepareCapture && !capturePrepared) {
      if (!authorizedToWrite) throw new Error("Capture preparation requires verified terminal ownership before paint")
      const calibrationId = "collector.captureCalibration"
      const declared = ownsTerminal ? options.ownedTerminal?.geometryAtGrant : undefined
      const reported = options.geometryCorroboration
      let preparationGrid: { rows: number; cols: number } | undefined
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
        const preparationSource = createTermProbeSource({
          ...(options.onWrite && { onWrite: options.onWrite }),
          probe: { ...probe, termNeedsGeometry: true },
          geometry: preparationGrid,
          utf8Decoding: readUtf8Decoding,
          captureGeometryRefusal,
        })
        // Outside the per-probe catch: an unproved restore fails the RUN, not one feature.
        await withTTYOperation(
          () =>
            withTTYQueryTrace(
              calibrationQueries,
              calibrationEvents,
              () =>
                prepareCapture({
                  source: preparationSource,
                  featureId: calibrationId,
                  recordCapture: (captured) => recordCapture(calibrationId, calibrationCaptures, captured),
                }),
              {
                onLog(log) {
                  batch.rawReplies[calibrationId + ".callLog"] = JSON.stringify(log)
                },
              },
            ),
          out,
          verify,
        )
        captureGeometry = preparationSource.captureGeometry
        captureGeometryRefusal = preparationSource.captureGeometryRefusal
      } catch (error) {
        if (!(error instanceof Error) || error.name !== "CaptureCalibrationRefused") throw error
        captureGeometryRefusal = error.message
      } finally {
        batch.rawReplies[`${calibrationId}.trace`] = JSON.stringify({
          grid: preparationGrid,
          geometryCorroboration: reported,
          refusal: captureGeometryRefusal,
          writes: calibrationEvents.filter((event) => event.kind === "write").map((event) => event.sequence),
          queries: calibrationQueries,
          events: calibrationEvents,
          captures: calibrationCaptures,
        })
        // A run-fatal calibration error drops this batch, so the failure draft keeps the trace only from here (30666).
        options.onCheckpoint?.(batch)
      }
      capturePrepared = true
    }
  }
  let sizeLeftBehind: string | undefined
  for (const probe of selected) {
    if (sizeLeftBehind) {
      const pending = batch.results.find((result) => result.featureId === probe.id)
      if (!pending) throw new Error(`Native size stop ${probe.id} is outside initialized catalogue`)
      const attempt = { scope: "none" as const }
      pending.status = "probe-invalid"
      pending.attempt = attempt
      pending.reason = sizeLeftBehind
      pending.rawReplyRef = probe.id
      pending.tests = [
        { id: "geometry", status: "probe-invalid", attempt, reason: sizeLeftBehind, rawReplyRef: probe.id },
      ]
      batch.rawReplies[probe.id] = JSON.stringify({ writes: [], queries: [], events: [] })
      options.onCheckpoint?.(batch)
      continue
    }
    const queries: TTYQueryTrace[] = []
    const events: TTYTraceEvent[] = []
    const clipboardEvents: ClipboardTraceEvent[] = []
    const titleReads: Array<{ title: string } | { error: string }> = []
    const captures: Array<{ frame: ObservationFrame; trace: Record<string, unknown> }> = []
    let captureAttempted = false
    const needsOwnership = probe.termWrites !== "query" || probe.termNeedsDisposable === true
    const refusedBecause = !needsOwnership
      ? undefined
      : !authorizedToWrite
        ? "neither a verified owned terminal nor a verified disposable-ownership receipt was presented"
        : probe.termNeedsDisposable === true && !disposable && !processOwnerBasis
          ? "no verified disposable-ownership receipt was presented"
          : undefined
    if (refusedBecause) {
      batch.rawReplies[probe.id] = JSON.stringify({ writes: [], queries, events })
      const pending = batch.results.find((result) => result.featureId === probe.id)
      if (!pending) throw new Error(`Native prerequisite ${probe.id} is outside initialized catalogue`)
      pending.reason = `Required grant missing: ${refusedBecause}`
      pending.rawReplyRef = probe.id
      pending.tests = [
        {
          id: "prerequisite",
          status: "probe-todo",
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

        batch.rawReplies[probe.id] = JSON.stringify({ writes: [], queries, events })
        const pending = batch.results.find((result) => result.featureId === probe.id)
        if (!pending) throw new Error(`Native geometry ${probe.id} is outside initialized catalogue`)
        const attempt = geometryStartedAt
          ? { scope: "probe" as const, startedAt: geometryStartedAt }
          : { scope: "none" as const }
        pending.status = geometryStartedAt ? "probe-invalid" : "probe-todo"
        pending.attempt = attempt
        pending.reason = diagnostic
        pending.rawReplyRef = probe.id
        pending.tests = [{ id: "geometry", status: pending.status, attempt, reason: diagnostic, rawReplyRef: probe.id }]
        options.onCheckpoint?.(batch)
        continue
      }
    }
    const probeSource = createTermProbeSource({
      ...(options.onWrite && { onWrite: options.onWrite }),
      probe,
      geometry: preGeometry?.status === "measured" ? preGeometry : undefined,
      utf8Decoding: readUtf8Decoding,
      captureGeometryRefusal,
    })
    if (ownsTerminal) {
      probeSource.readAppSemanticState = options.ownedTerminal?.readAppSemanticState
      const read = options.ownedTerminal?.getScrollback
      if (read) probeSource.getScrollback = () => withTTYOperation(read, out, verify)
      const reset = options.ownedTerminal?.resetScrollback
      if (reset) probeSource.resetScrollback = () => withTTYOperation(reset, out, verify)
    }
    if (ownsTerminal && (options.subject?.kind === "term" || options.subject?.kind === "mux")) {
      // 32569: a mux child reads the same marker path; the reading names the mux, since a present value there may
      // come from the outer terminal (@cto third-table ruling 2026-11-06).
      const read = options.ownedTerminal?.readTermFeatures
      const mux = options.ownedTerminal?.muxAttachmentProof?.mux
      probeSource.readTermFeatures =
        read && mux
          ? async () => {
              const reading = await read()
              return reading.status === "measured" ? { ...reading, mux } : reading
            }
          : read
    }
    const subjectMux =
      options.ownedTerminal?.muxAttachmentProof?.mux ??
      (options.subject?.kind === "mux" && (options.subject.id === "tmux" || options.subject.id === "screen")
        ? options.subject.id
        : undefined)
    if (subjectMux) probeSource.mux = subjectMux
    const readTitle = ownsTerminal ? options.ownedTerminal?.readTitle : undefined
    if (
      readTitle &&
      (probe.id !== "extensions.osc7-cwd" ||
        (options.subject?.kind === "term" && options.subject.id === "ghostty" && options.subject.os === "linux"))
    ) {
      probeSource.readTitle = async () => {
        try {
          const title = await withTTYOperation(readTitle, out, verify)
          titleReads.push({ title })
          return title
        } catch (error) {
          titleReads.push({ error: error instanceof Error ? error.message : String(error) })
          throw error
        }
      }
    }
    if (captureGeometry) probeSource.captureGeometry = captureGeometry
    const isDirectLinuxApp =
      options.subject?.kind === "term" &&
      options.subject.os === "linux" &&
      disposable?.declaredTarget?.kind === "app" &&
      disposable.declaredTarget.id === options.subject.id &&
      disposable.declaredTarget.os === "linux" &&
      !clipboard?.muxAttachmentProof
    const directLinuxPasteRoute = isDirectLinuxApp ? LINUX_PASTE_ROUTES[options.subject?.id ?? ""] : undefined
    const isVerifiedLinuxMux =
      options.subject?.kind === "mux" &&
      (options.subject.id === "tmux" || options.subject.id === "screen") &&
      options.subject.os === "linux" &&
      disposable?.declaredTarget?.kind === "mux" &&
      disposable.declaredTarget.id === options.subject.id &&
      disposable.declaredTarget.os === "linux" &&
      clipboard?.muxAttachmentProof?.platform === "linux" &&
      clipboard.muxAttachmentProof.mux === options.subject.id
    const isDirectDarwinApp =
      clipboard?.pasteboard === "darwin" &&
      options.subject?.kind === "term" &&
      options.subject.os === "darwin" &&
      disposable?.declaredTarget?.kind === "app" &&
      disposable.declaredTarget.id === options.subject.id &&
      disposable.declaredTarget.os === "darwin" &&
      !clipboard.muxAttachmentProof
    if (
      clipboard &&
      verify &&
      (clipboard.profile !== "default" ||
        (isDirectLinuxApp && probe.id === "extensions.osc52-write") ||
        (directLinuxPasteRoute && probe.id === "extensions.clipboard-paste") ||
        (isDirectDarwinApp &&
          (probe.id === "extensions.osc52-write" ||
            probe.id === "extensions.osc52-read" ||
            probe.id === "extensions.osc52-clipboard")) ||
        (isVerifiedLinuxMux &&
          (probe.id === "extensions.clipboard-paste" ||
            probe.id === "extensions.osc52-write" ||
            probe.id === "extensions.osc52-read" ||
            probe.id === "extensions.osc52-clipboard")))
    ) {
      const allowDisposablePasteSetup =
        probe.id === "extensions.clipboard-paste" && isVerifiedLinuxMux && options.subject?.id === "screen"
      // A paste route only where it is reviewed: the direct App's own, or Kitty's for a mux, whose outer the
      // owned launch refuses to be anything but Kitty (linux-container-run.sh "Owned Linux mux outer must be Kitty").
      const pasteRoute =
        probe.id !== "extensions.clipboard-paste" || clipboard.pasteboard === "darwin"
          ? undefined
          : isVerifiedLinuxMux
            ? LINUX_PASTE_ROUTES.kitty
            : LINUX_PASTE_ROUTES[options.subject?.id ?? ""]
      const missingPrimary = async (): Promise<never> => {
        throw new Error("Owned PRIMARY selection is absent from this run's clipboard receipt")
      }
      const transaction: typeof clipboard.withClipboardFixture =
        pasteRoute?.selection === "primary"
          ? (clipboard.withPrimaryFixture ?? missingPrimary)
          : clipboard.withClipboardFixture
      probeSource.withClipboardFixture = (work) =>
        transaction(
          (fixture) =>
            work({
              ...fixture,
              ...(allowDisposablePasteSetup && { disposableSession: true }),
              ...(pasteRoute && { paste: pasteRoute }),
            }),
          (event) => clipboardEvents.push(event),
          verify,
        )
    }
    if (options.input) {
      const input = options.input
      const injectMove = input.injectMove?.bind(input)
      const injectDrag = input.injectDrag?.bind(input)
      const focusRoundTrip = input.focusRoundTrip?.bind(input)
      const resizeWindow = input.resizeWindow?.bind(input)
      probeSource.input = {
        injectKey: (keys) => withTTYOperation(() => input.injectKey(keys), out, verify),
        injectClick: (button, position) => withTTYOperation(() => input.injectClick(button, position), out, verify),
        ...(injectMove && {
          injectMove: (x: number, y: number) => withTTYOperation(() => injectMove(x, y), out, verify),
        }),
        ...(injectDrag && { injectDrag: (button: 1) => withTTYOperation(() => injectDrag(button), out, verify) }),
        ...(focusRoundTrip && { focusRoundTrip: () => withTTYOperation(focusRoundTrip, out, verify) }),
        ...(resizeWindow && {
          resizeWindow: (width: number, height: number) =>
            withTTYOperation(() => resizeWindow(width, height, probe.id), out, verify),
        }),
      }
    }
    const capture = options.capture
    // A text run hands its adapter to the region readback alone: it is the one consumer whose
    // verdict is about cells. Every other probe reads pixels, so it gets no adapter here and takes
    // its own named no-capture branch — an error row where a named refusal belongs is exactly what
    // the no-capture branches exist to avoid.
    const textCells = options.captureKind === "text-cells"
    const imageSubject = options.subject
    const pointerImageEligible =
      probe.id !== "extensions.osc22-pointer" ||
      (ownsTerminal &&
        imageSubject?.kind === "term" &&
        imageSubject.os === "linux" &&
        ((imageSubject.id === "xterm" && imageSubject.version === "411") ||
          (imageSubject.id === "wezterm" && imageSubject.version === "0-unstable-2026-10-10")))
    const captureEligible =
      pointerImageEligible && captureAdapterEligible(probe, options.captureKind, captureGeometryRefusal)
    if (capture && captureEligible) {
      if (textCells) {
        probeSource.captureKind = "text-cells"
        probeSource.cells = async (checkpoint) => {
          captureAttempted = true
          const result = await withTTYOperation(() => capture({ featureId: probe.id, ...checkpoint }), out, verify)
          recordCapture(probe.id, captures, result, checkpoint.role)
          return result.frame
        }
      } else {
        probeSource.capture = async (checkpoint) => {
          captureAttempted = true
          const result = await withTTYOperation(() => capture({ featureId: probe.id, ...checkpoint }), out, verify)
          recordCapture(probe.id, captures, result, checkpoint.role)
          return result.frame
        }
      }
    }
    if (options.prepareCapturePhase !== "after-probes" && options.prepareCapture && !capturePrepared) {
      await prepareCaptureOnce(probe, preGeometry)
      if (captureGeometry) probeSource.captureGeometry = captureGeometry
      if (captureGeometryRefusal) probeSource.captureGeometryRefusal = captureGeometryRefusal
      if (captureGeometryRefusal) probeSource.capture = undefined
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
    let callbackTests: ProbeCallbackResult["tests"]
    let criterionBranch: string | undefined
    let wallFired = false
    const subject: (Pick<ProbeSubject, "kind" | "id" | "os"> & Partial<ProbeSubject>) | undefined =
      options.draft?.subject ?? options.subject
    const muxProof = options.ownedTerminal?.muxAttachmentProof
    const outerCommands =
      ownsTerminal && subject?.kind === "mux" && probe.id.startsWith("sgr.")
        ? beginMuxSgrCommandRead({
            featureId: probe.id,
            subject,
            proof: muxProof?.platform === "linux" ? muxProof : undefined,
          })
        : undefined
    try {
      if (!probe.term) throw new Error(`No app callback for ${probe.id}`)
      const callback = probe.term
      // The SGR callback branches on its source's available methods. Retain that
      // context with the existing recorder; the inner TTY log still projects all
      // legacy transport events, while this artifact can replay the callback itself.
      const sourceLog = probe.id.startsWith("sgr.") ? createCallLog() : undefined
      const sourceSession = sourceLog ? withCallLog(probeSource, { mode: "record", log: sourceLog }) : undefined
      let result: ProbeCallbackResult
      let probeWallExceeded = false
      try {
        // A probe may declare its own wall. The default stays 30s. Run 42836445788 cut
        // font-ligatures, reset.sgr and modes.xtrestore at that default.
        const wallMs = probe.wallMs ?? 30_000
        let wall: ReturnType<typeof setTimeout> | undefined
        const operation = withTTYOperation(
          () =>
            withTTYQueryTrace(
              queries,
              events,
              async () => {
                return callback(sourceSession?.context ?? probeSource)
              },
              {
                onLog(log) {
                  if (!sourceLog) batch.rawReplies[probe.id + ".callLog"] = JSON.stringify(log)
                },
              },
            ),
          out,
          verify,
        ).then((value) => ({ timedOut: false as const, value }))
        const raced = await Promise.race([
          operation,
          new Promise<{ timedOut: true }>((resolve) => {
            wall = setTimeout(() => resolve({ timedOut: true }), wallMs)
          }),
        ])
        clearTimeout(wall)
        if (raced.timedOut) {
          // The callback did not return. Drop its call log and release the TTY queue so the
          // next probe is not left with unfinished calls (#33017).
          operation.catch(() => {})
          sourceSession?.abandon()
          releaseTTYQueue()
          probeWallExceeded = true
          wallFired = true
          result = {
            pass: false,
            tests: [{ id: "criterion", status: "probe-todo", reason: `Probe exceeded ${wallMs}ms` }],
          }
        } else {
          result = raced.value
        }
      } catch (error) {
        // An unavailable Screen query before the first write is an absent apparatus, not a target negative.
        // A later read or restoration failure remains invalid and retains the ordinary error path.
        if (
          options.subject?.kind === "mux" &&
          options.subject.id === "screen" &&
          titleReads.length === 1 &&
          titleReads.some((reading) => "error" in reading) &&
          !events.some((event) => event.kind === "write")
        ) {
          result = {
            pass: false,
            notTested: {
              reason: "no-semantic-observable",
              noObservable: `Screen: screen -Q title is unavailable: ${error instanceof Error ? error.message : String(error)}`,
            },
          }
        } else throw error
      } finally {
        sourceSession?.finish()
        // An abandoned log is not complete. Stringifying it throws
        // "call log recording has not completed" and replaces the probe-todo (#33047).
        if (sourceLog && !probeWallExceeded) {
          batch.rawReplies[probe.id + ".callLog"] = JSON.stringify(sourceLog)
        }
        if (geometryCheck && !probeWallExceeded) geometryCheck.post = await readGeometry()
      }
      result = withReplyFailureEvidence(probe.id, result, {
        producer: "TTY",
        attempts: queries.map((query) => ({
          sequence: query.sequence,
          received: query.raw,
          timeoutMs: query.timeoutMs,
          match: query.match,
          reason: query.reason,
        })),
      })
      // Screen's query is a candidate reader, not an already qualified title surface (@cto32573).
      // Preserve its failed controls as a named reader gap; never substitute the outer window.
      if (
        options.subject?.kind === "mux" &&
        options.subject.id === "screen" &&
        result.criterionBranch === "app-title-control"
      ) {
        const response = result.response
        result = {
          pass: false,
          notTested: {
            reason: "no-semantic-observable",
            noObservable:
              "Screen: screen -Q title did not read the owned title controls; no qualified own-title reader is available",
          },
          ...(response === undefined ? {} : { response }),
        }
      }
      const declaration = options.appDeclarations?.[probe.id]
      const onlyTodoTests = !result.tests?.some((test) => test.status !== "probe-todo")
      const unresolved = result.notTested
        ? result.notTested.reason === "no-semantic-observable" &&
          result.notTested.noObservable.trim().length > 0 &&
          onlyTodoTests
        : Boolean(result.tests?.length) && onlyTodoTests
      if (declaration && unresolved && !claimsMeasurement(result)) {
        const response = result.response
        result = {
          ...declaredUntestableResult(declaration, { featureId: probe.id }),
          ...(response === undefined ? {} : { response }),
        }
      }
      if (
        probe.id === "editing.decsace" &&
        subject &&
        subject.kind !== "lib" &&
        result.notTested?.noObservable.startsWith("Untestable (no setup): DECCARA") &&
        result.tests?.every((test) => test.status === "untestable")
      ) {
        const route =
          subject.kind === "mux"
            ? `the ${subject.id} mux route with outer terminal ${subject.outerTerminal ?? "unrecorded"} (either may stop DECCARA)`
            : `the ${subject.id} app`
        const reason = result.notTested.noObservable.replace("this app", route)
        result = {
          ...result,
          notTested: { ...result.notTested, noObservable: reason },
          tests: result.tests.map((test) => ({ ...test, reason })),
        }
      }
      callbackTests = result.tests
      criterionBranch = result.criterionBranch
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
          result.observation.assertionType === "process_environment" && result.response !== undefined
            ? `${probe.id}.callbackResponse`
            : events.some((event) => event.kind === "write") ||
                queries.length ||
                captureAttempted ||
                clipboardEvents.length
              ? probe.id
              : undefined
        const post = geometryCheck?.post
        const resized =
          preGeometry?.status === "measured" &&
          (post?.status !== "measured" || post.rows !== preGeometry.rows || post.cols !== preGeometry.cols)
        if (resized) {
          batch.rawReplies[`${probe.id}.callbackObservation`] = JSON.stringify(result.observation)
          callbackTests = [
            {
              id: "geometry",
              status: "probe-invalid",
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
          // The recorder's callback sees proxy frames; persistence owns the original captured values.
          ...(result.observation.frames && { frames: captures.map(({ frame }) => frame) }),
          ...(host === undefined ? {} : { host }),
          ...(result.note && !result.observation.note ? { note: result.note } : {}),
          ...(resized
            ? {
                outcome: "inconclusive" as const,
                reason: "insufficient-evidence" as const,
                note: `${(result.observation.note ?? result.note) ? `${result.observation.note ?? result.note}; ` : ""}Measured geometry changed or became unavailable after ${probe.id} (resized)`,
              }
            : {}),
          ...(rawReplyRef ? { rawReplyRef } : {}),
        })
        for (const assertion of result.assertions ?? []) {
          batch.assertions.push({
            featureId: probe.id,
            ...assertion,
            ...(resized ? { note: `${assertion.note ? `${assertion.note}; ` : ""}Geometry resized during probe` } : {}),
            ...(rawReplyRef ? { rawReplyRef } : {}),
          })
        }
      } else if (
        result.tests?.length &&
        result.tests.every(
          (test) =>
            (test.status === "probe-todo" || test.status === "probe-invalid") &&
            typeof test.reason === "string" &&
            test.reason.trim().length > 0,
        )
      ) {
        if (result.response !== undefined) batch.rawReplies[`${probe.id}.callbackResponse`] = result.response
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
      const errorAssertionType =
        name === "UndeclaredTerminalGeometry" || name === "FrameUnavailable"
          ? undefined
          : captureAttempted
            ? options.captureKind === "text-cells"
              ? "buffer_state"
              : "screenshot"
            : undefined
      if (errorAssertionType) {
        batch.observations.push({
          featureId: probe.id,
          outcome: "error",
          reason: "collector-error",
          assertionType: errorAssertionType,
          note: message,
          ...(queries.length || captureAttempted || clipboardEvents.length ? { rawReplyRef: probe.id } : {}),
        })
      } else {
        batch.ungradedDiagnostics[probe.id] = { kind: "collector-error", name, message }
      }
    } finally {
      const observation = batch.observations.find((entry) => entry.featureId === probe.id)
      if (probe.termNeedsDisposable && !disposable && processOwnerBasis && observation) {
        observation.note = `${observation.note ? `${observation.note}; ` : ""}${processOwnerBasis}`
      }
      const trace = JSON.stringify({
        writes: events.filter((event) => event.kind === "write").map((event) => event.sequence),
        queries,
        events,
        ...(clipboardEvents.length ? { clipboard: clipboardEvents } : {}),
        ...(titleReads.length ? { titleReads } : {}),
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
      const recorded = recordExecutedProbe({
        featureId: probe.id,
        attempt,
        observation,
        diagnostic: batch.ungradedDiagnostics[probe.id],
        coverage: batch.notTested.find((entry) => entry.featureId === probe.id),
        assertions: batch.assertions,
        tests: callbackTests,
        rawReplyRef: probe.id,
        criterionBranch,
        ...(wallFired ? { harnessOutcome: "probe-exceeded" as const } : {}),
      })
      const commands =
        recorded.status === "unsupported" &&
        recorded.criterionBranch === "sgr-attribute-same-run" &&
        subject?.kind === "mux"
          ? outerCommands?.status === "ready"
            ? await outerCommands.read(batch.rawReplies[`${probe.id}.callLog`])
            : (outerCommands ?? {
                status: "unavailable" as const,
                reason: "Outer command read not attempted: no verified owned mux terminal",
              })
          : undefined
      if (commands) batch.rawReplies[`${probe.id}.outerCommands`] = JSON.stringify(commands)
      // Completed command evidence resolves the mux ambiguity, while the existing
      // visual finalizer must still validate this probe's own captured frame first.
      const visualInput =
        commands?.status === "measured" ? { ...recorded, criterionBranch: "sgr-attribute-outer-command" } : recorded
      let finalized =
        subject?.kind === "term" || subject?.kind === "mux"
          ? finalizeVisualResult(
              visualInput,
              subject,
              captures.map(({ frame }) => frame),
            )
          : recorded
      if (commands?.status === "measured" && finalized.status === "unsupported") {
        if (commands.targetSent) {
          const reason = `${subject?.id}: SGR ${commands.target} was passed to outer terminal ${subject?.outerTerminal}; the controlled sample still drew no distinct target effect`
          const declared = declaredUntestableResult(reason, commands)
          finalized = {
            ...finalized,
            ...recordExecutedProbe({
              featureId: probe.id,
              attempt,
              coverage: { featureId: probe.id, ...declared.notTested, rawReplyRef: `${probe.id}.outerCommands` },
              criterionBranch: declared.criterionBranch,
              tests: declared.tests,
              assertions: [],
              rawReplyRef: `${probe.id}.outerCommands`,
            }),
          }
        } else {
          const reason = `${subject?.id} did not forward SGR ${commands.target} to outer terminal ${subject?.outerTerminal}`
          finalized = finalizeProbeResult({ ...finalized, reason })
        }
      } else if (commands?.status === "unavailable" && finalized.status === "probe-todo" && subject?.outerTerminal) {
        const reason = `${finalized.reason}; ${commands.reason}`
        finalized = finalizeProbeResult({
          ...finalized,
          reason,
          tests: finalized.tests.map((test) =>
            test.id === "attribute" && test.status === "probe-todo" ? { ...test, reason } : test,
          ),
        })
      }
      const ligatureCoverage =
        probe.id === "extensions.font-ligatures" && subject
          ? fontLigatureMuxCoverage(subject, { raw: batch.rawReplies[probe.id] ?? "" })
          : undefined
      if (ligatureCoverage) {
        // The coverage list is what the run document reads (902-921); replace this feature's entry
        // rather than adding a second one, because the pixel arm may already have recorded a refusal.
        const coverage = { featureId: probe.id, ...ligatureCoverage.notTested, rawReplyRef: probe.id }
        const existing = batch.notTested.findIndex((entry) => entry.featureId === probe.id)
        if (existing < 0) batch.notTested.push(coverage)
        else batch.notTested[existing] = coverage
        // D160 exception to the refuse-coverage-with-measurement rule (908-913): the mux pixel arm may
        // already have recorded this feature's screenshot observation and assertion, and the coverage
        // record is the only claim this run keeps, so both lists drop the feature as well.
        batch.observations = batch.observations.filter((entry) => entry.featureId !== probe.id)
        batch.assertions = batch.assertions.filter((entry) => entry.featureId !== probe.id)
      }
      // The coverage result stands alone: spreading `finalized` would carry the pixel arm's frames,
      // screenshotRef, assertionType and criterionBranch onto a record that measured nothing.
      batch.results[index] = ligatureCoverage
        ? recordExecutedProbe({
            featureId: probe.id,
            attempt,
            coverage: { featureId: probe.id, ...ligatureCoverage.notTested, rawReplyRef: probe.id },
            criterionBranch: ligatureCoverage.criterionBranch,
            tests: ligatureCoverage.tests,
            assertions: [],
            rawReplyRef: probe.id,
          })
        : finalized
      if (
        probe.id === "modes.deccolm" &&
        geometryCheck?.pre?.status === "measured" &&
        geometryCheck.post?.status === "measured" &&
        (geometryCheck.pre.rows !== geometryCheck.post.rows || geometryCheck.pre.cols !== geometryCheck.post.cols)
      ) {
        sizeLeftBehind = `modes.deccolm left the terminal at ${geometryCheck.post.rows}x${geometryCheck.post.cols}; it started at ${geometryCheck.pre.rows}x${geometryCheck.pre.cols}`
      }
      options.onCheckpoint?.(batch)
    }
  }
  if (options.prepareCapturePhase === "after-probes") {
    await verify?.()
    const probe = selected[0]
    if (probe) await prepareCaptureOnce(probe)
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
  if (options.prepareCapturePhase !== "after-probes") await verify?.()
  const runMux =
    options.ownedTerminal?.muxAttachmentProof?.mux ??
    (options.subject?.kind === "mux" && (options.subject.id === "tmux" || options.subject.id === "screen")
      ? options.subject.id
      : undefined)
  if (runMux && options.colourControl) {
    applyColourSiblingSeparation(batch, { mux: runMux, runId: options.captureRunId, ...options.colourControl })
  }
  return batch
}

/**
 * The colour-sibling-separation pass (#33041). It runs after every row exists, because a row's
 * proof is a second row's frames; no probe order is assumed. A decided row is re-recorded through
 * the same recorder as every other row, with its witness assertion appended; an open row keeps its
 * own verdict and gains the reason the decision was not made.
 */
export function applyColourSiblingSeparation(
  batch: Pick<ProbeBatch, "results" | "observations" | "assertions">,
  input: {
    mux: "tmux" | "screen"
    runId: string | undefined
    outer: OuterColourControl
    harnessProfile: string
    muxConfig: string
  },
): void {
  for (const observation of batch.observations) {
    const decision = colourSiblingSeparation({
      featureId: observation.featureId,
      mux: input.mux,
      runId: input.runId ?? "",
      observations: batch.observations,
      outer: input.runId === undefined ? { missing: "this run has no run id to cite" } : input.outer,
      harnessProfile: input.harnessProfile,
      muxConfig: input.muxConfig,
    })
    if (decision === undefined) continue
    const index = batch.results.findIndex((result) => result.featureId === observation.featureId)
    const current = batch.results[index]
    if (current === undefined) {
      throw new Error(`colour-sibling-separation: ${observation.featureId} has an observation but no result`)
    }
    if (decision.kind === "open") {
      batch.results[index] = {
        ...current,
        ...(current.reason === undefined ? {} : { reason: `${current.reason}; ${decision.reason}` }),
        tests: current.tests.map((test) => ({
          ...test,
          reason: test.reason ? `${test.reason}; ${decision.reason}` : decision.reason,
        })),
      }
      continue
    }
    if (current.attempt.scope === "none") {
      throw new Error(`colour-sibling-separation: ${observation.featureId} was decided but recorded no attempt`)
    }
    const decided: Observation = { featureId: observation.featureId, ...decision.observation }
    batch.observations[batch.observations.indexOf(observation)] = decided
    // A test names a row-local assertion ordinal; the witness lands after any the row already holds.
    const ordinal = batch.assertions.filter((assertion) => assertion.featureId === observation.featureId).length
    batch.assertions.push({
      featureId: observation.featureId,
      ...decision.assertion,
      ...(current.rawReplyRef === undefined ? {} : { rawReplyRef: current.rawReplyRef }),
    })
    batch.results[index] = recordExecutedProbe({
      featureId: observation.featureId,
      attempt: current.attempt,
      observation: decided,
      assertions: batch.assertions,
      tests: [{ ...decision.test, assertionRefs: [ordinal] }],
      criterionBranch: decision.criterionBranch,
      ...(current.rawReplyRef === undefined ? {} : { rawReplyRef: current.rawReplyRef }),
    })
  }
}
