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
  colourOnlyAttempts,
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
  type CaptureRequest,
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
  type TTYTraceScope,
} from "../tty.ts"
import type { ClipboardTraceEvent, LinuxClipboardAdapter } from "../linux-clipboard.ts"
import { createNotificationObserver, sendTerminalSideControl } from "../linux-notification.ts"
import { qualifyNotificationDefaults, qualifyOuterTerminalRecord } from "../notification-defaults.ts"
import { createCallLog, withCallLog } from "viprobe"
import {
  ownedTerminalVerifiedFor,
  ownedTerminalProcessBasisFor,
  type GeometryMeasurement,
  type OwnedTerminal,
} from "../owned-terminal.ts"
import { bindReceiptToRun, readDisposableReceipt, type DisposableReceipt } from "../disposable-receipt.ts"
import {
  checkOrdinaryOpenLiveAncestry,
  ordinaryOpenAdmission,
  type LiveAncestryReader,
  type OrdinaryOpenReceipt,
} from "../ordinary-open-receipt.ts"
import { beginMuxSgrCommandRead, hasOuterCommandMatcher } from "../app-semantic-state.ts"

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
  /** A second cell-aligned region digested from the same captured image, beside `cells`. */
  controlCells?: CaptureCells
  /** The terminal's own pixel report, required alongside `cells`. */
  pixelGeometry?: CapturePixelGeometry
  /** An exact colour to find in the whole decoded frame; the frame answers `located`. */
  locate?: CaptureRequest["locate"]
  /** Cells the probe's own output may cover; the read never paints its sentinel there (33985). */
  avoid?: CaptureRequest["avoid"]
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

/**
 * The one app-selection rule: ids resolve against the catalogue or the run refuses by name. Exported so a
 * caller that is about to stage source onto another host can apply the SAME rule before it copies anything
 * (@cto 737a99e3 condition 2: same error text, never a second validator).
 */
export function selectAppProbes(ids?: string[]): { expected: ProbeDefinition[]; selected: ProbeDefinition[] } {
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
 * OSC633 P can pin the pane cwd until it closes, so it follows cwd and prompt observations.
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
  const cwdPin = body.findIndex((probe) => probe.id === "extensions.osc633-p")
  if (cwdPin !== -1) body.push(...body.splice(cwdPin, 1))
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

/** Probes that press the App's paste key: clipboard-paste, and bracketed-paste, whose App effect reuses it. */
const PASTE_PROBE_IDS: ReadonlySet<string> = new Set(["extensions.clipboard-paste", "modes.bracketed-paste"])

/**
 * A live ancestry walk that refused mid-probe. Its own type so the ordinary-open fixture wrapper can tell "the
 * method is gone" (a named probe-todo) from a real adapter failure, which must still propagate as itself.
 */
class OrdinaryOpenAncestryRefusal extends Error {}

/** Why this run's recording pasteboard did not admit a clipboard row (#31741). */
function clipboardGateRefusal(
  clipboard: LinuxClipboardAdapter | undefined,
  subject: { kind: "term" | "lib" | "mux"; id: string; os: string } | undefined,
): string {
  if (!clipboard) return "this run records no clipboard fixture"
  if (!subject) return "this run records a clipboard fixture but declares no subject to bind it to"
  if (clipboard.pasteboard === "darwin") {
    const app = clipboard.pasteboardApp
    if (app !== subject.id) {
      return `this run's Darwin pasteboard belongs to ${app === undefined ? "no recorded app" : JSON.stringify(app)}, not to the run subject ${JSON.stringify(subject.id)}`
    }
    if (subject.kind !== "term") {
      return `this run's Darwin pasteboard is bound to ${JSON.stringify(subject.id)} but the subject is a ${subject.kind}, and only an owned app takes a direct pasteboard route`
    }
  }
  return `this run's clipboard fixture (${JSON.stringify(clipboard.profile)} profile${clipboard.muxAttachmentProof ? `, mux ${clipboard.muxAttachmentProof.mux}` : ""}) does not admit this subject`
}

/**
 * Direct Linux Apps whose default paste action is reviewed (@cto 73d66ae2, a4ec8fe2); any other App stays gated.
 * Each route is evidence: the App's own source or manual, at the pinned version, binds the key to paste that
 * selection, and the owned launch passes no config or resource that rebinds it (#32164).
 */
const LINUX_PASTE_ROUTES: Readonly<Record<string, PasteRoute>> = {
  kitty: {
    selection: "clipboard",
    key: "ctrl+shift+v",
    binding:
      "kitty 0.49.2 (tag v0.49.2): kitty/options/definition.py:3811 maps kitty_mod+v to paste_from_clipboard, and kitty_mod defaults to ctrl+shift (definition.py:3648-3651)",
  },
  ghostty: {
    selection: "clipboard",
    key: "ctrl+shift+v",
    binding:
      "ghostty 1.4.0 (tag v1.4.0): src/config/Config.zig:6698-6716 binds ctrl+shift+v to paste_from_clipboard on Linux",
  },
  alacritty: {
    selection: "clipboard",
    key: "ctrl+shift+v",
    binding:
      "alacritty 0.17.0 (tag v0.17.0): alacritty/src/config/bindings.rs:544-549 binds Ctrl+Shift+V to Paste (CLIPBOARD)",
  },
  wezterm: {
    selection: "clipboard",
    key: "ctrl+shift+v",
    binding:
      "wezterm 0-unstable-2026-10-10 (rev e2a98e1b8af1): wezterm-gui/src/commands.rs:665-670 declares PasteFrom(Clipboard) on SUPER+v and :126-131 derives CTRL+SHIFT+v from it; docs default-keys.md:19",
  },
  xterm: {
    selection: "primary",
    key: "shift+Insert",
    binding:
      "xterm 411 (xterm-411.tgz SHA256 969be283): charproc.c:15024, in VTInitTranslations, binds Shift<KeyPress>Insert to insert-selection(SELECT, CUT_BUFFER0); SELECT is PRIMARY under the default selectToClipboard false (xterm.man:5458)",
  },
}

/**
 * The one subject whose absent title decides: a run that does not show the OSC 7 path on its public title reads
 * Unsupported there, and stays open on every other subject (#33375, @cto 2026-11-11 04:36Z step 4). Ghostty is
 * the exception because its deciding negative is already established; a second subject needs its own ask with a
 * same-run control, never a row here. This predicate never gates installing a reader — the run's own OSC 2
 * controls do that.
 */
function titleAbsenceDecides(subject: { kind: "term" | "lib" | "mux"; id: string; os: string } | undefined): boolean {
  return subject?.kind === "term" && subject.id === "ghostty" && subject.os === "linux"
}

/** Collect the real callback result, without treating its legacy boolean as an observation. */
export async function runProbeBatch(
  options: {
    ids?: string[]
    capture?: ProbeCapture
    /** The pixel adapter's fixed wait before it reads the screen, when it declares one (#33032). */
    captureSettleMs?: number
    /** What the installed adapter reads; a text adapter is honest even where pixel geometry was
     * refused, so it is installed regardless of `captureGeometryRefusal`. */
    captureKind?: "pixels" | "text-cells"
    /** Prepare owned capture through its existing factory, query trace and frame recorder. */
    prepareCapture?: (input: {
      source: TermProbeSource
      featureId: string
      recordCapture: (result: CapturedProbeFrame) => void
    }) => Promise<void>
    /**
     * The one after-probes call point: runs once after every probe callback and the final ownership
     * check, through the same query trace and frame recorder. The caller decides what belongs before
     * probes and what after; an owner that closes and proves its window qualifies text here (32670).
     */
    finishCapture?: (input: {
      source: TermProbeSource
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
    input?: InputFixture & {
      resizeWindow?(width: number, height: number, featureId?: string): Promise<{ width: number; height: number }>
    }
    ownedTerminal?: OwnedTerminal
    /**
     * An app a person opened normally (@cto 2026-11-13): the receipt that names it and the adapter the Mac run
     * path built from the receipt's own subject. This grants NOTHING beyond the three OSC 52 rows — it is never
     * OR'd into `authorizedToWrite` — and every probe it might cover has to pass a LIVE ancestry walk first.
     */
    ordinaryOpen?: {
      readonly receipt: OrdinaryOpenReceipt
      readonly clipboard: NonNullable<OwnedTerminal["clipboard"]>
      /** The bundle id the one Mac app registry names for the subject; without it the receipt binds to no app. */
      readonly expectedBundleId: string | undefined
      /** Overridable only so a test can drive the walk; production reads the real parent chain. */
      readonly readAncestry?: LiveAncestryReader
    }
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
  // Ordinary-open (@cto 2026-11-13): a person launched the app themselves and a receipt names the live process
  // chain that reached it. This is NOT ownership and never enters `authorizedToWrite`; it grants only the three
  // OSC 52 rows, and each of those still has to pass a LIVE ancestry walk at the moment it runs.
  const ordinaryOpen = options.ordinaryOpen
  // Never a pass when the registry names no bundle: the live walk refuses that case itself, so this wrapper
  // cannot turn a missing bundle id into admission (@cto 2026-11-13).
  const ordinaryOpenLiveRefusal = (): string | undefined => {
    if (!ordinaryOpen) return undefined
    const verdict = checkOrdinaryOpenLiveAncestry({
      receipt: ordinaryOpen.receipt,
      expectedBundleId: ordinaryOpen.expectedBundleId,
      probePid: process.pid,
      ...(ordinaryOpen.readAncestry && { reader: ordinaryOpen.readAncestry }),
    })
    return verdict.ok ? undefined : verdict.probeTodo
  }
  // Resolves when the live walk passes, rejects with the row's named refusal when it does not. Written without
  // `async` because the walk is synchronous: the promise is the contract the fixture takes, not a wrapper around
  // an await, and an async function with nothing to await hides that.
  const ordinaryOpenVerify = ordinaryOpen
    ? () => {
        const probeTodo = ordinaryOpenLiveRefusal()
        return probeTodo === undefined ? Promise.resolve() : Promise.reject(new OrdinaryOpenAncestryRefusal(probeTodo))
      }
    : undefined
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
  // Preparation belongs to the batch; an RIS write expires its geometry after that row finishes.
  // Keep each preparation's evidence, and finish once after the last when the caller asks.
  let capturePrepared = false
  let capturePreparations = 0
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
  const prepareCaptureWith = async (
    prepareCapture: typeof options.prepareCapture,
    probe: ProbeDefinition,
    preGeometry?: GeometryMeasurement,
    calibrationId = "collector.captureCalibration",
  ): Promise<void> => {
    if (prepareCapture) {
      if (!authorizedToWrite) throw new Error("Capture preparation requires verified terminal ownership before paint")
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
    // Admission runs on EVERY row of an ordinary-open run, not only rows that need ownership, and the fixture
    // hand-out below keys on an explicit `admitted: true`. Otherwise a row that is not marked as needing ownership
    // would be handed the adapter unadmitted, and with no registry bundle id it would also skip the walk
    // (@cto 2026-11-13, fail-open path 1). A row the receipt does not admit is refused BY NAME, never silently.
    const ordinaryOpenGrant = ordinaryOpen
      ? (() => {
          const subject = options.subject
          if (!subject) {
            return {
              admitted: false as const,
              unprovable: true,
              refusal: "an ordinary-open receipt binds an app by name, and this run names no subject",
            }
          }
          const admission = ordinaryOpenAdmission({
            receipt: ordinaryOpen.receipt,
            probeId: probe.id,
            subject,
            measuredVersion: subject.version,
            expectedBundleId: ordinaryOpen.expectedBundleId,
          })
          // One shape for every refusal: the receipt's own gate returns `admit`, and handing that arm back
          // unmapped made `admitted` unreadable to both consumers below (root typecheck, 2026-11-13).
          if (!admission.admit) {
            return { admitted: false as const, refusal: admission.refusal, unprovable: admission.unprovable }
          }
          const liveRefusal = ordinaryOpenLiveRefusal()
          return liveRefusal === undefined
            ? { admitted: true as const }
            : { admitted: false as const, unprovable: true, refusal: liveRefusal }
        })()
      : undefined
    const refusedBecause = !needsOwnership
      ? undefined
      : ordinaryOpen !== undefined && !authorizedToWrite
        ? ordinaryOpenGrant?.admitted === true
          ? undefined
          : (ordinaryOpenGrant?.refusal ?? "an ordinary-open receipt was not admitted for this row")
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
    let rowSentRis = false
    const probeSource = createTermProbeSource({
      onWrite(text) {
        rowSentRis ||= text.includes("\x1bc")
        options.onWrite?.(text)
      },
      probe,
      geometry: preGeometry?.status === "measured" ? preGeometry : undefined,
      utf8Decoding: readUtf8Decoding,
      captureGeometryRefusal,
    })
    if (ownsTerminal) {
      // The verified owner knows which rows its reader observes. Other rows retain their original term
      // callbacks, including wrappers whose unavailable reading does not fall back.
      const semanticFeatures = options.ownedTerminal?.appSemanticStateFeatures
      if (semanticFeatures === undefined || semanticFeatures.has(probe.id)) {
        probeSource.readAppSemanticState = options.ownedTerminal?.readAppSemanticState
      }
      const read = options.ownedTerminal?.getScrollback
      if (read) probeSource.getScrollback = () => withTTYOperation(read, out, verify)
      const reset = options.ownedTerminal?.resetScrollback
      if (reset) probeSource.resetScrollback = () => withTTYOperation(reset, out, verify)
      // The collector's measured absence of a pane read has to reach the rows through THIS handoff, not only
      // through the OwnedTerminal record: without this copy every history row fell back to its screenshot arm
      // and declared nothing (0/12 in the peer's faithful replay, @dev/3 REVISE at b48438b96).
      const unavailableReason = options.ownedTerminal?.scrollbackUnavailable
      if (unavailableReason) probeSource.scrollbackUnavailable = unavailableReason
      // The arm's own missing prerequisite, kept distinct from the declaration above: the rows say what this
      // run could not reach instead of quietly using the screenshot path (8c084f05, A0).
      const probeTodoReason = options.ownedTerminal?.scrollbackProbeTodo
      if (probeTodoReason) probeSource.scrollbackProbeTodo = probeTodoReason
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
    if (readTitle) {
      // #33375: the reader installs wherever the owned run has one, for every probe that reads a title. No
      // subject name chooses whether the OSC 7 arm gets this surface; its own OSC 2 controls qualify the reading.
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
      if (probe.id === "extensions.osc7-cwd" && titleAbsenceDecides(options.subject)) {
        probeSource.readTitleAbsenceDecides = true
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
    // #31741: this gate admitted nothing on a Mac for two independent reasons. Production spells the OS
    // `macos` (detect.ts detectOS over process.platform), and a github-hosted-runner receipt is the one
    // kind a hosted Mac run can carry while carrying no declaredTarget by design (disposable-receipt.ts) —
    // so `os === "darwin"` and the target clause were both unreachable. @cto a6f2b5fd chose the binding
    // proof over a receipt-format change: the adapter that owns this run's pasteboard is built from the
    // receipt's launched executable and now carries that app's id, so the gate matches the FIELD and a
    // pasteboard built for app A cannot admit a run of app B.
    const isDirectDarwinApp =
      clipboard?.pasteboard === "darwin" &&
      options.subject?.kind === "term" &&
      options.subject.os === "macos" &&
      clipboard.pasteboardApp === options.subject.id &&
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
            probe.id === "modes.bracketed-paste" ||
            probe.id === "extensions.osc52-write" ||
            probe.id === "extensions.osc52-read" ||
            probe.id === "extensions.osc52-clipboard")))
    ) {
      // #33058: Screen answers no 2004 mode report, so bracketed paste is decided by the same disposable
      // paste read as clipboard-paste (@cto d0e1a960).
      const allowDisposablePasteSetup =
        (probe.id === "extensions.clipboard-paste" || probe.id === "modes.bracketed-paste") &&
        isVerifiedLinuxMux &&
        options.subject?.id === "screen"
      // A paste route only where it is reviewed: the direct App's own, or Kitty's for a mux, whose outer the
      // owned launch refuses to be anything but Kitty (linux-container-run.sh "Owned Linux mux outer must be Kitty").
      const pasteRoute =
        !PASTE_PROBE_IDS.has(probe.id) || clipboard.pasteboard === "darwin"
          ? undefined
          : isVerifiedLinuxMux
            ? LINUX_PASTE_ROUTES.kitty
            : LINUX_PASTE_ROUTES[options.subject?.id ?? ""]
      const missingPrimary = (): Promise<never> =>
        Promise.reject(new Error("Owned PRIMARY selection is absent from this run's clipboard receipt"))
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
    } else if (ordinaryOpen && ordinaryOpenVerify && ordinaryOpenGrant?.admitted === true) {
      // @cto 2026-11-13: this adapter was built by the collector's Mac run path from the receipt's own subject, and
      // the gate only admits it. The live ancestry walk in `ordinaryOpenVerify` repeats on every fixture use.
      const ordinaryOpenClipboard = ordinaryOpen.clipboard
      probeSource.withClipboardFixture = async (work) => {
        try {
          return await ordinaryOpenClipboard.withClipboardFixture(
            (fixture) => work(fixture),
            (event) => clipboardEvents.push(event),
            ordinaryOpenVerify,
          )
        } catch (error) {
          // A walk that passed at the gate and fails inside the fixture keeps the row's named probe-todo wording
          // (@dev/16 19:42 item 3); any other adapter failure still propagates as itself.
          if (!(error instanceof OrdinaryOpenAncestryRefusal)) throw error
          return {
            pass: false,
            note: error.message,
            tests: [{ id: "prerequisite", status: "probe-todo" as const, reason: error.message }],
          }
        }
      }
    } else if (clipboard && verify) {
      // #31741: the run HAS a pasteboard, so the row must not be told it has no fixture — that reason
      // named a thing the same artifact records as present. Say what the gate actually found instead.
      probeSource.clipboardFixtureRefusal = clipboardGateRefusal(clipboard, options.subject)
    }
    if (options.subject?.os === "macos" || options.subject?.os === "linux") {
      // #31741 item 4: the row names the mechanism this platform's owned route drives — CGEvent on a
      // Mac (darwin-input.ts), XTEST on X11 — never the other platform's name.
      probeSource.inputMechanism = options.subject.os === "macos" ? "CGEvent" : "XTEST"
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
        ...(focusRoundTrip && {
          focusRoundTrip: (work?: (readFocus: () => Promise<string>) => Promise<void>) =>
            withTTYOperation(() => focusRoundTrip(work), out, verify),
        }),
        ...(resizeWindow && {
          resizeWindow: (width: number, height: number) =>
            withTTYOperation(() => resizeWindow(width, height, probe.id), out, verify),
        }),
      }
    }
    const notificationReceiptPath = process.env.TERMINFO_NOTIFICATION_FIXTURE_RECEIPT
    if (
      notificationReceiptPath &&
      verify &&
      (isDirectLinuxApp || isVerifiedLinuxMux) &&
      (probe.id === "extensions.notifications" || probe.id === "extensions.osc777-notify")
    ) {
      probeSource.withNotificationObserver = async (work) => {
        await verify()
        const address = process.env.DBUS_SESSION_BUS_ADDRESS
        if (!address) throw new Error("Owned notification recorder declared without DBUS_SESSION_BUS_ADDRESS")
        const observer = await createNotificationObserver({ receiptPath: notificationReceiptPath, address })
        // The terminal's own bus and a control sent from its own environment (#33333): without both, silence
        // is unreadable, and a row may not claim the terminal does not notify.
        const terminalEnvironment = options.ownedTerminal?.readNotificationEnvironment?.()
        const measured =
          terminalEnvironment?.status === "measured" && terminalEnvironment.bus !== undefined
            ? terminalEnvironment
            : undefined
        const terminalBus = measured?.bus ?? {
          state: "unknown" as const,
          reason:
            terminalEnvironment?.reason ??
            "The terminal process environment was not independently read: this run has no owned reader for it",
        }
        // Default configuration, stated only from what this run controls: its own launch line, and tmux's
        // live allow-passthrough (#33333 condition 4). A user's dotfiles are never read, so never claimed.
        const allowPassthrough =
          options.subject?.kind === "mux" && options.subject.id === "tmux" && clipboard?.readAllowPassthrough
            ? await clipboard.readAllowPassthrough()
            : undefined
        const notificationDefaults = qualifyNotificationDefaults({
          ...(clipboard?.config ? { launchLine: clipboard.config } : {}),
          ...(allowPassthrough === undefined ? {} : { passthrough: allowPassthrough }),
        })
        // A mux may carry a negative only when the terminal that hosted this very run measured the same row as
        // supported (#33333 condition 3); the record is this run's own outer-terminal record.
        const outerReading =
          options.subject?.kind === "mux"
            ? qualifyOuterTerminalRecord({ record: options.colourControl?.outer, probeId: probe.id })
            : undefined
        let terminalSideControl: { nonce: string; id: number; latencyMs: number } | undefined
        let terminalSideControlRefusal: string | undefined
        // The control goes to the bus named in the TERMINAL's own environment, in memory, not to the
        // collector's: an explicit address overrides the environment's, so using ours would prove only that
        // the recorder's bus accepts us (peer review, @dev/8 14:30Z).
        const terminalAddress = measured?.environment?.DBUS_SESSION_BUS_ADDRESS
        if (measured?.environment !== undefined && terminalAddress !== undefined && terminalAddress !== "") {
          try {
            terminalSideControl = await sendTerminalSideControl({
              address: terminalAddress,
              recordPath: observer.receipt.recordPath,
              environment: measured.environment,
              deadlineMs: 1000,
            })
          } catch (controlError) {
            terminalSideControlRefusal = (controlError as Error).message
          }
        } else {
          terminalSideControlRefusal = terminalBus.reason
        }
        const result = await work({
          control: observer.control,
          recordPath: observer.receipt.recordPath,
          deadlineMs: 1000,
          terminalBus,
          ...(terminalSideControl === undefined ? {} : { terminalSideControl }),
          ...(terminalSideControlRefusal === undefined ? {} : { terminalSideControlRefusal }),
          ...(outerReading?.record === undefined ? {} : { outerTerminalRecord: outerReading.record }),
          ...(outerReading?.refusal === undefined ? {} : { outerTerminalRecordRefusal: outerReading.refusal }),
          profile: notificationDefaults,
          cursor: () => observer.cursor(),
          readSince: (cursor) => observer.readSince(cursor),
        })
        await verify()
        return result
      }
    }
    const capture = options.capture
    // A run-level fact, set for every row whether or not this row gets the adapter: a row may state
    // what no capture in this run can see (#33032).
    if (options.captureSettleMs !== undefined) probeSource.captureSettleMs = options.captureSettleMs
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
          (imageSubject.id === "wezterm" && imageSubject.version === "0-unstable-2026-10-10") ||
          (imageSubject.id === "ghostty" && imageSubject.version === "1.4.0") ||
          (imageSubject.id === "alacritty" && imageSubject.version === "0.17.0")))
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
    if (options.prepareCapture && !capturePrepared) {
      const calibrationId =
        capturePreparations === 0
          ? "collector.captureCalibration"
          : `collector.captureCalibration.renewal.${capturePreparations}`
      capturePreparations++
      await prepareCaptureWith(options.prepareCapture, probe, preGeometry, calibrationId)
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
      ownsTerminal && subject?.kind === "mux" && hasOuterCommandMatcher(probe.id)
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
      // An outer command read matches this callback's own writes, so it records them the same way.
      const sourceLog = probe.id.startsWith("sgr.") || outerCommands ? createCallLog() : undefined
      const sourceSession = sourceLog ? withCallLog(probeSource, { mode: "record", log: sourceLog }) : undefined
      let result: ProbeCallbackResult
      let probeWallExceeded = false
      try {
        // A probe may declare its own wall. The default stays 30s. Run 42836445788 cut
        // font-ligatures, reset.sgr and modes.xtrestore at that default.
        const wallMs = probe.wallMs ?? 30_000
        let wall: ReturnType<typeof setTimeout> | undefined
        let traceScope: TTYTraceScope | undefined
        const operation = withTTYOperation(
          () =>
            withTTYQueryTrace(
              queries,
              events,
              async () => {
                return callback(sourceSession?.context ?? probeSource)
              },
              {
                onScope(scope) {
                  traceScope = scope
                },
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
          // The callback did not return. Abandon its trace before the queue moves on: the scope
          // keeps the writes it settled before the wall and refuses every later one, so the
          // abandoned callback cannot reach the terminal while the next probe runs (#33431).
          // The wall's own flags and the queue release cannot wait on that projection: an abandon
          // that failed would otherwise leave 33017's chained queue behind the hung callback.
          operation.catch(() => {})
          probeWallExceeded = true
          wallFired = true
          try {
            traceScope?.abandon()
          } catch (error) {
            batch.ungradedDiagnostics[probe.id] = {
              kind: "collector-error",
              name: "Error",
              message: `Wall timeout trace snapshot failed for ${probe.id}: ${error instanceof Error ? error.message : String(error)}`,
            }
          } finally {
            sourceSession?.abandon()
            releaseTTYQueue()
          }
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
        // The wall ends the callback's hold on the terminal, not the measurement: the geometry
        // after it is what the timed-out row is judged against (#33431).
        if (geometryCheck) geometryCheck.post = await readGeometry()
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
      // A multiplexer arm that asks the outer command reader is graded by its own definition from
      // that reading alone (@cto 1818f9ec). With no verified owned mux terminal the read is not attempted.
      if (probe.outerCommands && subject?.kind === "mux" && result.criterionBranch === probe.outerCommands.branch) {
        const commands =
          outerCommands?.status === "ready"
            ? await outerCommands.read(batch.rawReplies[`${probe.id}.callLog`])
            : (outerCommands ?? {
                status: "unavailable" as const,
                reason: "Outer command read not attempted: no verified owned mux terminal",
              })
        batch.rawReplies[`${probe.id}.outerCommands`] = JSON.stringify(commands)
        result = probe.outerCommands.grade(commands)
      }
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
      if (declaration && claimsMeasurement(result)) {
        batch.ungradedDiagnostics[probe.id] = {
          kind: "collector-error",
          name: "DeclaredUntestableCollision",
          message: `Declared-untestable collision for ${probe.id}: ${declaration}; ${refusedClaimEvidence(result)} is retained and the declaration is refused`,
        }
        batch.rawReplies[`${probe.id}.declarationCollision`] = JSON.stringify(batch.ungradedDiagnostics[probe.id])
      } else if (declaration && unresolved) {
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
        // The colour branch grades only when EVERY attempt reaching the comparison fires it (@cto
        // 91917ee1): a terminal that supports a reset but paints late would otherwise grade from one
        // stale frame. The attempts are visible here, in the capture list, not inside the reader.
        const colourAttempts =
          criterionBranch === "colour-only-mismatch"
            ? colourOnlyAttempts(
                probe.id,
                captures.map(({ frame }) => frame),
              )
            : undefined
        const colourNote = colourAttempts && "note" in colourAttempts ? colourAttempts.note : undefined
        const colourDisagreement =
          colourAttempts && "disagreement" in colourAttempts ? colourAttempts.disagreement : undefined
        batch.observations.push({
          featureId: probe.id,
          ...result.observation,
          // The recorder's callback sees proxy frames; persistence owns the original captured values.
          ...(result.observation.frames && { frames: captures.map(({ frame }) => frame) }),
          ...(host === undefined ? {} : { host }),
          ...(result.note && !result.observation.note ? { note: result.note } : {}),
          ...(colourNote === undefined
            ? {}
            : { note: [result.observation.note, colourNote].filter(Boolean).join("; ") }),
          ...(colourDisagreement === undefined
            ? {}
            : {
                outcome: "inconclusive" as const,
                reason: "insufficient-evidence" as const,
                note: colourDisagreement,
              }),
          ...(resized
            ? {
                outcome: "inconclusive" as const,
                reason: "insufficient-evidence" as const,
                note: `${(result.observation.note ?? result.note) ? `${result.observation.note ?? result.note}; ` : ""}Measured geometry changed or became unavailable after ${probe.id} (resized)`,
              }
            : {}),
          ...(rawReplyRef ? { rawReplyRef } : {}),
        })
        for (const { witness, ...assertion } of result.assertions ?? []) {
          batch.assertions.push({
            featureId: probe.id,
            ...assertion,
            // A resized row is re-labelled resized-capture, so a branch's witness no longer stands for it (#33054).
            ...(resized
              ? { note: `${assertion.note ? `${assertion.note}; ` : ""}Geometry resized during probe` }
              : witness === undefined
                ? {}
                : { witness }),
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
      const diagnostic = batch.ungradedDiagnostics[probe.id]
      const recorded = recordExecutedProbe({
        featureId: probe.id,
        attempt,
        observation,
        // This names the refused declaration, not a defect in the retained measurement.
        diagnostic:
          diagnostic?.kind === "collector-error" && diagnostic.name === "DeclaredUntestableCollision"
            ? undefined
            : diagnostic,
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
      // Do not reinterpret the resetting row's captures or mutate a source already handed to it.
      // The next row must prepare again, even if this attempt previously refused calibration.
      if (rowSentRis && options.prepareCapture) {
        capturePrepared = false
        captureGeometry = undefined
        captureGeometryRefusal = undefined
      }
      options.onCheckpoint?.(batch)
    }
  }
  if (options.finishCapture) {
    await verify?.()
    const probe = selected[0]
    if (probe) {
      await prepareCaptureWith(
        options.finishCapture,
        probe,
        undefined,
        capturePreparations === 0 ? "collector.captureCalibration" : "collector.textQualification",
      )
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
  if (!options.finishCapture) await verify?.()
  const runMux =
    options.ownedTerminal?.muxAttachmentProof?.mux ??
    (options.subject?.kind === "mux" && (options.subject.id === "tmux" || options.subject.id === "screen")
      ? options.subject.id
      : undefined)
  if (runMux && options.colourControl) {
    applyColourSiblingSeparation(batch, { mux: runMux, runId: options.captureRunId, ...options.colourControl })
  }
  applyUnreachedSteps(batch)
  return batch
}

/** A step that can only be measured after its entry, as data: no terminal is named (#32785). */
export interface UnreachedStepPair {
  readonly step: string
  readonly entry: string
  /** The entry as a reader knows it, for the step's reason. */
  readonly entryName: string
}

export const UNREACHED_STEPS: readonly UnreachedStepPair[] = [
  {
    step: "modes.alt-screen.exit",
    entry: "modes.alt-screen.enter",
    entryName: "switching to the alternate screen (modes.alt-screen.enter)",
  },
]

/**
 * The unreached-step pass (#32785). It runs after every row exists, because the step's result depends on a second
 * row's result. A step still open while the same run reads its entry Unsupported was never reached: it reads
 * Untestable through the one declared form, and its reason names the entry step and that result (operator yes on
 * card terminfo-untestable-1110, Nov 10 2026 20:11 PST; @cto record terminfo-untestable-prerequisite-ruling-2026-11-10).
 * The entry keeps its own result. Any other entry result, an entry absent from this run, a step this run did not
 * attempt, or a step already decided is left exactly as it reads. The step keeps its own frames and raw reference: they are this run's attempt.
 */
export function applyUnreachedSteps(
  batch: Pick<ProbeBatch, "results">,
  pairs: readonly UnreachedStepPair[] = UNREACHED_STEPS,
): void {
  for (const pair of pairs) {
    const index = batch.results.findIndex((result) => result.featureId === pair.step)
    const step = batch.results[index]
    const entry = batch.results.find((result) => result.featureId === pair.entry)
    // A step this run never attempted (not selected) is not "never reached": it keeps its own Probe to-do.
    if (step === undefined || step.status !== "probe-todo" || step.attempt.scope === "none") continue
    if (entry?.status !== "unsupported") continue
    const reason = `Untestable (no setup): this run reads ${pair.entryName} Unsupported, so this step was never reached and was not measured.`
    const declared = declaredUntestableResult(reason, { entry: pair.entry, entryStatus: entry.status })
    const { status: _status, reason: _reason, ...kept } = step
    batch.results[index] = finalizeProbeResult({
      ...kept,
      criterionBranch: declared.criterionBranch,
      reason,
      tests: (declared.tests ?? []).map((test) => ({
        ...test,
        // A decided test carries the attempt that produced it: the step's own attempt in this run.
        attempt: step.attempt,
        assertionRefs: [],
        ...(step.rawReplyRef === undefined ? {} : { rawReplyRef: step.rawReplyRef }),
      })),
    })
  }
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
