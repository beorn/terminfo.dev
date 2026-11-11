import type { Cell } from "@termless/core/io"

/** A mode readback; null means this source does not expose the requested state. */
export type ModeState = boolean | null

/** A probe ran and retained raw state, but this environment exposes no applicable observable for the claim. */
export interface NoSemanticObservable {
  /** Closed reason for a coverage record. */
  reason: "no-semantic-observable"
  /** The specific semantic observable this environment cannot expose. */
  noObservable: string
}

/** A callback retains a measurement, named coverage, or an execution-only TODO/FAILURE. */
export type ProbeCallbackResult =
  | MeasuredProbeCallbackResult
  | NotTestedCoverageResult
  | ExecutionOnlyProbeCallbackResult

export const HOST_INPUT_NAMES = [
  "foreground-rgb",
  "background-rgb",
  "cursor-rgb",
  "palette-entry-rgb",
  "pixel-geometry",
  "clipboard-read-permission",
] as const
export type HostInputName = (typeof HOST_INPUT_NAMES)[number]
export type HostRecipeName = "color-request" | "text-area-size" | "clipboard-load"
export interface HostRecipeExpectation {
  recipe: HostRecipeName
  query: string
  missing: readonly HostInputName[]
}
export type CallbackHostRecipeCause =
  | { recipe: HostRecipeName; cause: { kind: "observed"; missing: HostInputName; query: string } }
  | {
      recipe: HostRecipeName
      cause: {
        kind: "source-audited" | "unimplemented"
        missing: HostInputName
        artifactSha256: string
        sourceCitation: string
      }
    }
export type RetainedHostRecipeCause =
  | { recipe: HostRecipeName; cause: { kind: "observed"; missing: HostInputName; runId: string; eventRef: string } }
  | {
      recipe: HostRecipeName
      cause: {
        kind: "source-audited"
        missing: HostInputName
        runId: string
        artifactSha256: string
        citation: { inputRecordRef: string; sha256: string; input: HostInputName; sourceLocation: string }
      }
    }
  | {
      recipe: HostRecipeName
      /** The audited artifact has no reply path for the query; the citation names that source, not a host input. */
      cause: {
        kind: "unimplemented"
        missing: HostInputName
        runId: string
        artifactSha256: string
        citation: { sourceLocation: string }
      }
    }

export interface MeasuredProbeCallbackResult extends ProbeExecutionTests {
  /** Callback-only intent; producers append actual request evidence to these failure reasons. */
  readonly replyFailureTestIds?: readonly string[]
  hostRecipeCauses?: readonly CallbackHostRecipeCause[]
  /** Historical raw documents carry it; the live collector reads only observation. */
  pass: boolean
  note?: string
  response?: string
  /** The explicit measured result. Never promoted from pass. */
  observation: Omit<Observation, "featureId" | "rawReplyRef">
  assertions?: Array<Omit<ProbeAssertion, "featureId" | "rawReplyRef">>
  notTested?: never
}

export interface NotTestedCoverageResult extends ProbeExecutionTests {
  readonly replyFailureTestIds?: never
  hostRecipeCauses?: readonly CallbackHostRecipeCause[]
  pass: boolean
  note?: string
  response?: string
  observation?: never
  assertions?: never
  /** Per-result coverage: the probe ran and captured raw state, but no applicable observable exists here. */
  notTested: NoSemanticObservable
}

/** No deciding observation was retained. Legacy pass belongs only to the diagnostic runner (#30929). */
export interface ExecutionOnlyProbeCallbackResult {
  /** Callback-only intent; producers append actual request evidence to these failure reasons. */
  readonly replyFailureTestIds?: readonly string[]
  hostRecipeCauses?: readonly CallbackHostRecipeCause[]
  pass: boolean
  note?: string
  response?: string
  observation?: never
  assertions?: never
  notTested?: never
  tests: [
    ProbeTestInput & { status: "probe-todo" | "probe-invalid"; reason: string },
    ...Array<ProbeTestInput & { status: "probe-todo" | "probe-invalid"; reason: string }>,
  ]
  criterionBranch?: string
}

/** Execution-owned disposition; historical ObservationOutcome is never a current result. */
export const PROBE_STATUSES = ["supported", "unsupported", "untestable", "probe-todo", "probe-invalid"] as const
export type ProbeStatus = (typeof PROBE_STATUSES)[number]
/** A feature result can expose a disagreement that no individual probe result can carry. */
export const FEATURE_RESULT_STATUSES = [...PROBE_STATUSES, "probe-conflict"] as const
export type FeatureResultStatus = (typeof FEATURE_RESULT_STATUSES)[number]
export type ProbeAttempt =
  | { scope: "none" }
  | { scope: "collection" | "probe"; startedAt: string; diagnosticRef?: string }

/** Resolved callback intent; an empty list explicitly schedules no work. */
export interface CollectorSelection {
  ids: string[]
}

/** Retained collection lifecycle. An absent result preserves a historical recorded start. */
export type CollectorAttempt = CollectorSelection & {
  startedAt?: string
  hostInputs?: Record<string, string>
} & (
    | { result: "started" | "completed"; startedAt: string; error?: never }
    | { result: "empty"; error?: never }
    | { result: "cancelled" | "failed"; error: string }
    | { result?: undefined; startedAt: string; error?: never }
  )

/** The still-required tests for the frozen criterion branch, retained at execution. */
export interface ProbeTestResult {
  id: string
  status: ProbeStatus
  attempt: ProbeAttempt
  assertionRefs?: number[]
  rawReplyRef?: string
  reviewRef?: string
  reason?: string
}
/** Callback criterion facts; the producer supplies actual attempt timestamps and global evidence refs. */
export type ProbeTestInput = Pick<ProbeTestResult, "id" | "status" | "reason" | "assertionRefs">
interface ProbeExecutionTests {
  tests?: ProbeTestInput[]
  criterionBranch?: string
}

/** A reading that says the harness did not finish, not what the terminal did. */
export const HARNESS_OUTCOMES = [
  "probe-exceeded",
  "unfinished-calls",
  "capture-refused",
  // Written by the 33048 expiry path, not by this package.
  "killed-mid-probe",
  "never-started",
] as const
export type HarnessOutcome = (typeof HARNESS_OUTCOMES)[number]
export function isHarnessOutcome(value: unknown): value is HarnessOutcome {
  return typeof value === "string" && (HARNESS_OUTCOMES as readonly string[]).includes(value)
}

export interface ProbeResult {
  featureId: string
  status: ProbeStatus
  attempt: ProbeAttempt
  /** Set only when this result is a harness outcome. Absent means the status is the terminal's. */
  harnessOutcome?: HarnessOutcome
  tests: ProbeTestResult[]
  criterionBranch?: string
  rawReplyRef?: string
  reviewRef?: string
  reason?: string
  frames?: ObservationFrame[]
  screenshotRef?: string
  host?: ConsoleBufferOwner
  assertionType?: AssertionType
}

/** A private in-flight run; intended subject is never measured identity/provenance. */
export interface RunDraft {
  schemaVersion: 4
  source:
    | { kind: "live" }
    | {
        kind: "trace"
        trace: { path: string; sha256: string }
        captureRunId: string
        captureSuiteId: string
        captureSourceRevision: string
      }
  runId: string
  suiteId: string
  probeHash: string
  sourceRevision: string
  intendedSubject: Partial<ProbeSubject>
  subject?: ProbeSubject
  identity?: "verified" | "unverified" | "disputed"
  runtimeIdentity?: HeadlessRuntimeIdentity
  provenance?: RunProvenance
  outerApp?: OuterAppProof
  measuredAt?: string
  origin?: RunOrigin
  rawReplies: Record<string, string>
  assertions: ProbeAssertion[]
  screenshotRefs: string[]
  textSnapshotRefs?: string[]
  textQualification?: TextQualification
  results: ProbeResult[]
  /** Wall time of a live collection. Absent on runs written before the field existed. */
  collectorDurationMs?: number
}

/** Captured identity is present, but HTTP/intent/app-launch enrichment and review can still run. */
export type CapturedRunDraft = RunDraft & Required<Pick<RunDraft, "subject" | "identity" | "measuredAt" | "origin">>

/** Final status bytes are immutable after all legitimate enrichment and required review. */
export interface CurrentRun extends Omit<RunDraft, "subject" | "identity" | "measuredAt" | "origin"> {
  subject: ProbeSubject
  identity: "verified" | "unverified" | "disputed"
  measuredAt: string
  origin: RunOrigin
}

/** A proposition's measured outcome. Missing catalog IDs mean not tested. */
export const OBSERVATION_OUTCOMES = ["supported", "unsupported", "inconclusive", "error"] as const
export type ObservationOutcome = (typeof OBSERVATION_OUTCOMES)[number]

export const OBSERVATION_REASONS = [
  "no-response",
  "timeout",
  "permission",
  "policy-refused",
  "collector-error",
  "invalid-reply",
  /** A valid consumption or state was observed, but it cannot establish the tested result. */
  "insufficient-evidence",
  /**
   * The DA1 fence answered with nothing before it (#33165). The callback decides nothing: the recorder maps it
   * through the feature row's declared silence rule (`SilenceDeclaration`; absent means Unsupported).
   */
  "fenced-silence",
] as const
export type ObservationReason = (typeof OBSERVATION_REASONS)[number]

/**
 * The non-default silence rules a content/features.json row may declare (#33165, @cto be3fb080). A row that
 * declares none takes the default: a fenced silence is Unsupported.
 * - `switchable`: the terminal can answer once something is enabled, so silence is PROBE INVALID; the reason names it.
 * - `untestable`: silence cannot decide the row; it reads Untestable through the declared route, with the reason.
 */
export const SILENCE_RULES = ["switchable", "untestable"] as const
export type SilenceRule = (typeof SILENCE_RULES)[number]

/** A row's declared silence rule, `"silence": { "rule", "reason" }` on its content/features.json entry. */
export interface SilenceDeclaration {
  readonly rule: SilenceRule
  readonly reason: string
}

/** Class of the retained deciding observation, independent of assertion polarity and capture payload kind. */
export const ASSERTION_TYPES = [
  "query_reply",
  "buffer_state",
  "screenshot",
  "input_bytes",
  "clipboard",
  "process_environment",
] as const
export type AssertionType = (typeof ASSERTION_TYPES)[number]
/** Source identity is retained by schema 4 without changing historical run formats. */
export type ProbeSourceKind = RunDraft["source"]["kind"]

/** The program whose console buffer a TEXT read returned. */
export interface ConsoleBufferOwner {
  image: string
  executablePath: string
  executableSha256: string
}

export interface Observation {
  featureId: string
  outcome: ObservationOutcome
  reason?: ObservationReason
  assertionType: AssertionType
  rawReplyRef?: string
  screenshotRef?: string
  frames?: ObservationFrame[]
  /** Present only on a text read whose buffer had a console host (Windows): image, path, digest.
   * `pid` and `ppid` stay in the run artifact, because they name one process instance rather than a
   * host a reader can check (30055 AC4; @cto ruling 6255e75d). */
  host?: ConsoleBufferOwner
  note?: string
}

/** Collector-owned capture checkpoint, with the published PNG bound by its digest. */
export interface ObservationFrameBase {
  role: "control" | "target"
  ref: string
  capturedAt: number
  label: string
  /** Original capture bytes, such as XWD; retained with the raw run receipt. */
  sourceRef?: string
}

/**
 * A frame read from the screen's PIXELS. Its digests are over raw bytes, so two frames are
 * comparable only when their rectangles match.
 */
export interface PixelObservationFrame extends ObservationFrameBase {
  /**
   * Optional HERE on purpose: every frame written before text frames existed is a pixel frame and every one of
   * them parses as exactly that. A text frame is the only frame that must say so, and the `never`
   * fields below make the two kinds mutually exclusive, so no reader can treat one as the other.
   */
  kind?: "pixels"
  cellDigest?: never
  frameDigest?: never
  cellRectangle?: never
  /**
   * Raw-pixel digest of the cell-aligned region named by the request's `cells`, taken in-run from
   * the same buffer as `pixelsDigest`. Present exactly when the request named cells.
   */
  regionDigest?: string
  /**
   * Raw-pixel digest of the whole captured window, over raw pixel bytes at a fixed depth and
   * colorspace — never the encoded container, whose text chunks differ between identical frames.
   * It separates "the frame moved while the witness cell stood still" from "nothing moved at all".
   */
  pixelsDigest?: string
  /**
   * The screen rectangle the cell-aligned region was cropped from, in the captured window's own
   * pixels. Carried beside `regionDigest`, which was computed over exactly this crop, so a reader
   * can tell whether two frames' region digests were taken from the same screen position at all:
   * the capture arm places the text area per frame, and two frames cropped 26 px apart are not the
   * same cells (29580). Present exactly when `regionDigest` is; a request that named no cells
   * carries neither.
   */
  regionRectangle?: CaptureRectangle
  /**
   * Raw-pixel digest of the second cell-aligned region named by the request's `controlCells`,
   * cropped from the SAME captured image as `regionDigest` and `pixelsDigest`, so the two
   * regions are simultaneous rather than one capture apart. Present exactly when the request
   * named control cells and the arm could crop both regions from its one shot.
   */
  controlRegionDigest?: string
  /**
   * The screen rectangle the control region was cropped from, in the captured window's own
   * pixels. Carried beside `controlRegionDigest` exactly as `regionRectangle` is carried beside
   * `regionDigest`. Present exactly when `controlRegionDigest` is.
   */
  controlRegionRectangle?: CaptureRectangle
  /**
   * Where the request's `locate` colour sits in this decoded frame: the bounding box of every pixel
   * of exactly that colour, in the captured window's own pixels, and how many pixels matched.
   * `null` means the colour is absent from the whole frame. Absent (undefined) when the request
   * named no colour, or when the arm could not decode its frame; undefined is never read as null.
   */
  located?: CaptureLocated | null
}

/**
 * A frame read from the terminal's OWN TEXT: exact cells, never pixels.
 * It exists as a separate kind so no reader can mistake a text snapshot for a pixel witness — the
 * pixel-only fields are not present here at all, and a digest that is absent has exactly one
 * meaning in each kind.
 */
export interface TextCellsObservationFrame extends ObservationFrameBase {
  kind: "text-cells"
  regionDigest?: never
  pixelsDigest?: never
  regionRectangle?: never
  controlRegionDigest?: never
  controlRegionRectangle?: never
  located?: never
  /** Digest over the named cells' characters, and their attributes where the arm reports them. */
  cellDigest: string
  /** Digest over the whole visible rect, so "the screen moved while the cells stood still" is
   * still separable, exactly as `pixelsDigest` does for a pixel frame. */
  frameDigest: string
  /** The compared rectangle in CELLS: the text frame's twin of `regionRectangle`. */
  cellRectangle: CaptureCells
}

/** Run-owned mapping witnesses, never a stored qualification verdict. */
export type TextQualificationShape =
  | "mid-line-gap"
  | "trailing-gap"
  | "soft-wrap"
  | "prior-scrollback"
  | "empty-last-row"
  | "console-host-ownership"

/** New suites declare version 2 recipes. Historical and future single-recipe declarations remain
 * readable; qualification separately checks which version and recipe the observer implements. */
export type TextQualificationSpec = { version: number; recipe: string } | { version: 2; recipes: readonly string[] }

/** One cell written as U+0001 straight into the console host's buffer, then read from both
 * buffers. The host keeps the control character; a terminal-owned observer never shows it. */
export interface TextQualificationOwnership {
  cell: { row: number; col: number }
  /** The console host buffer's character at `cell`. */
  host: string
  /** The observer's whole row as it read it, before any cell mapping refuses the control character. */
  observerRow: string
}

export interface TextQualification {
  version: number
  recipe: string
  grid: { rows: number; cols: number }
  shapes: Array<
    | { shape: TextQualificationShape; frames: TextCellsObservationFrame[]; reason?: never; ownership?: never }
    | { shape: TextQualificationShape; reason: string; frames?: never; ownership?: never }
    | { shape: "console-host-ownership"; ownership: TextQualificationOwnership; frames?: never; reason?: never }
  >
}

/** One checkpoint, in the one kind it was actually read in. */
export type ObservationFrame = PixelObservationFrame | TextCellsObservationFrame

/** The two digests every frame carries, whichever kind it is: the cells that were compared, and
 * the whole screen they sat in. This is the ONLY way a comparison should reach them, so the
 * three-frame path is one path for both kinds. */
export function frameDigests(frame: ObservationFrame): { cells: string | undefined; whole: string | undefined } {
  // "Not text-cells" is a pixel frame: that is what every frame written before text frames existed is.
  return frame.kind === "text-cells"
    ? { cells: frame.cellDigest, whole: frame.frameDigest }
    : { cells: frame.regionDigest, whole: frame.pixelsDigest }
}

/** A rectangle in the captured window's own pixels: zero-based edges, positive sizes, integers. */
export interface CaptureRectangle {
  /** Left edge, in pixels from the window's left. */
  x: number
  /** Top edge, in pixels from the window's top. */
  y: number
  /** Width, in pixels. */
  width: number
  /** Height, in pixels. */
  height: number
}

/** A cell-aligned region in the run's measured grid: 1-based and inclusive on all four edges. */
export interface CaptureCells {
  top: number
  left: number
  bottom: number
  right: number
}

/**
 * Positive integer cell geometry from usable own replies or a complete witnessed raster in this
 * run. Window dimensions divided by cell counts never establish a raster geometry.
 */
export interface CapturePixelGeometry {
  cellWidth: number
  cellHeight: number
  textWidth: number
  textHeight: number
}

/**
 * A capture checkpoint. `cells` asks the collector to digest one cell-aligned region of the same
 * capture; `ref`, `sourceRef`, `capturedAt` and `label` keep their shape either way, so a request
 * without `cells` is byte for byte the previous path.
 */
export interface CaptureRequest {
  role: ObservationFrame["role"]
  label: string
  /** The region to digest, in cells. `pixelGeometry` is required with it. */
  cells?: CaptureCells
  /**
   * A second region to digest from the SAME captured image, in cells: the control beside the
   * target, simultaneous with it rather than one capture later. Only alongside `cells`, under
   * the same `pixelGeometry`. An arm that cannot crop both regions from one shot returns a
   * frame without the control digest, and the consumer names that absence.
   */
  controlCells?: CaptureCells
  /** The run's measured pixel geometry, required alongside `cells`. */
  pixelGeometry?: CapturePixelGeometry
  /**
   * An exact RGB colour to find in the whole decoded frame; the frame answers `located`. Optional:
   * a request without it is byte for byte the previous path. Needs no `cells`.
   */
  locate?: { rgb: readonly [number, number, number] }
}

/** Calibration's witnessed solid paint: which SGR form painted it and the exact colour it measured. */
export interface CalibrationSentinel {
  form: "basic" | "reverse"
  rgb: readonly [number, number, number]
}

/** One colour's footprint in a decoded frame: its bounding box and its matching-pixel count. */
export interface CaptureLocated {
  box: CaptureRectangle
  pixels: number
}

export interface ProbeSubject {
  kind: "term" | "lib" | "mux"
  id: string
  version: string
  os: string | null
  osVersion: string | null
  outerTerminal: string | null
  mux: string | null
  config: string | null
  permissions: string | null
}

export interface RunOrigin {
  kind: "collector" | "community-issue" | "manual-capture"
  url?: string
  /** Captured by the process-owning app launcher, separate from terminal replies. */
  appLaunch?: AppLaunchReceipt
}

export interface WindowsMesaRendererDllReceipt {
  name: string
  path: string
  sha256: string
}

export interface WindowsMesaRendererReceipt {
  upstream: string
  version: string
  archivePath: string
  archiveSha256: string
  dlls: WindowsMesaRendererDllReceipt[]
}

export type AppLaunchReceipt =
  | {
      platform?: never
      bundlePath: string
      cfBundleShortVersionString: string
      cfBundleVersion: string
      /**
       * The defined transformed invocation array this process received, argv[0] first. The invoked
       * binary may differ from executablePath (WezTerm, Cursor and VS Code). Absent, never empty,
       * when the route used a wrapper or did not observe the array; the trace names why.
       *
       * Guarantee boundary, not an entropy detector: only a value following a secret-shaped flag
       * name or an argument the launcher declares sensitive is redacted. A secret in an unflagged
       * positional argument, URL or config path may appear verbatim. The fixed [redacted] sentinel
       * reveals neither the value nor its reuse. Redaction precedes persistence; environment is never captured.
       */
      argv?: string[]
      executablePath: string
      executableSha256: string
      sourceArtifact: AppSourceArtifact
    }
  | {
      platform: "win32"
      /**
       * The defined transformed invocation array this process received, argv[0] first. The invoked
       * binary may differ from executablePath (WezTerm, Cursor and VS Code). Absent, never empty,
       * when the route used a wrapper or did not observe the array; the trace names why.
       *
       * Guarantee boundary, not an entropy detector: only a value following a secret-shaped flag
       * name or an argument the launcher declares sensitive is redacted. A secret in an unflagged
       * positional argument, URL or config path may appear verbatim. The fixed [redacted] sentinel
       * reveals neither the value nor its reuse. Redaction precedes persistence; environment is never captured.
       */
      argv?: string[]
      executablePath: string
      productVersion: string
      executableSha256: string
      sourceArtifact: { kind: "portable-zip" | "portable-exe"; path: string; sha256: string }
      mesaRenderer?: WindowsMesaRendererReceipt
    }

/**
 * A source artifact DERIVED from an upstream tree: a deterministic tar of a recursive `src`, flat
 * hashed, with the tree hash it was made from (@cto 2026-10-06, 27892). `narSri` is the trust root -
 * the tree hash nixpkgs pins for the source - and `sha256` is the derived tar's flat hash, the one
 * the image re-measures. Its presence is NAMED by `kind`; an absent kind keeps the flat-archive.
 */
export interface DerivedSourceTreeArtifact {
  kind: "derived-source-tree"
  url: string
  revision: string
  narSri: string
  sha256: string
}

/**
 * An installed app may come from a retained file, a measured sealed macOS system volume, or a source
 * tree this repo derived a flat artifact from, or an installed Developer ID signed bundle.
 * The signed-bundle alternative records the measured signature and separate executable digest;
 * it does not establish installer/upstream provenance, notarization or running-image identity.
 */
export type AppSourceArtifact =
  | { path: string; sha256: string }
  | {
      kind: "sealed-macos-system-volume"
      macOSBuild: string
      snapshotUUID: string
      snapshotName: string
      sealed: true
      codeSignature: { identifier: string; cdHash: string; strictVerified: true }
    }
  | {
      kind: "developer-id-signed-bundle"
      codeSignature: { identifier: string; cdHash: string; strictVerified: true }
    }
  | DerivedSourceTreeArtifact

/**
 * Immutable declaration of the probes available in one suite revision.
 *
 * `probeHash`, `adapterVersion` and `probes` are the DERIVED record: a pure function of the suite
 * sources (27832 manifest direction (2)). `sourceRevision` and `generatedAt` are legacy provenance
 * that only old manifests carry. They are BOTH-OR-NEITHER: a manifest is legacy-complete (both,
 * validated as today) or new-minimal (neither). A half-present pair can only come from a hand edit
 * or corruption, so the parser refuses it by name.
 */
export interface ProbeSuiteManifest {
  /** Absent only on normalized historical declarations; every current writer emits 4. */
  schemaVersion?: 4
  probeHash: string
  sourceRevision?: string
  generatedAt?: string
  adapterVersion: string
  /** Complete frozen membership, distinct from callback schedules. Absent only in historical suites. */
  catalogIds?: string[]
  /** Whole raw catalogue entries at collection time; absent only in historical declarations. */
  catalogEntrySha256?: Record<string, string>
  probes: Record<ProbeSubject["kind"], string[]>
  textClaims?: string[]
  textQualification?: TextQualificationSpec
}

/** Proof a negative assertion was decided on. A union on `kind`, so the next witness adds a member
 * rather than a field on ProbeAssertion. Added 2026-11-10 (#33041); optional and additive, so
 * schemaVersion stays 4 and runs written before this parse unchanged. */
export type ProbeWitness = ColourSiblingSeparationWitness | ColourNoAttributeWitness

/**
 * The underline-colour negative witnessed by this row's own frames (#33054, moved from prose): the
 * seed frame shows the underline, and the expected frame equals the no-attribute (plain text)
 * frame after the sequence ran. The parser checks the three digests are this row's frames, that
 * expected equals noAttribute while the seed differs, and the rectangle against those frames.
 */
export interface ColourNoAttributeWitness {
  kind: "colour-no-attribute-witness"
  rowId: string
  /** The SGR parameters under test, e.g. `58;2;255;0;128`. */
  encoding: string
  rectangle: { x: number; y: number; width: number; height: number }
  frames: { seed: string; expected: string; noAttribute: string }
}

/**
 * The same-channel sibling that proves this capture can show a colour in this rectangle.
 * The parser checks the hashes and the rectangle against this run's frames. It does not check
 * `outerTerminal.recordPath` or `recordRunId` (those name another file) or the colour assumption
 * (that is declared, not measured).
 */
export interface ColourSiblingSeparationWitness {
  kind: "colour-sibling-separation"
  requestedRowId: string
  requestedEncoding: string
  siblingRowId: string
  siblingEncoding: string
  channel: "fg" | "bg"
  runId: string
  rectangle: { x: number; y: number; width: number; height: number }
  requested: { seed: string; target: string; expected: string; ignored: string }
  sibling: { seed: string; target: string }
  colour: { requested: string; assumption: string; harnessProfile: string; muxConfig: string }
  outerTerminal: {
    id: string
    version: string
    rowId: string
    status: "supported"
    recordPath: string
    recordRunId: string
  }
}

export interface ProbeAssertion {
  featureId: string
  kind: "positive" | "negative"
  assertionType: AssertionType
  rawReplyRef?: string
  /** The predicate/expected state and the actually observed bytes or serialized state. */
  expected: string
  observed: string
  /** Required for interaction evidence; names the action actually performed. */
  action?: string
  note?: string
  /** Structured proof for one negative branch. Absent on every other assertion. */
  witness?: ProbeWitness
}

export type UngradedDiagnostic =
  /**
   * HISTORICAL ONLY. Raised by the collector before the one-probe-result-path refactor (27832) and
   * still present in immutable run documents, which the parser must keep reading. No collector path
   * produces it any more: a result that is neither a measurement nor a coverage record is refused
   * as a `collector-error` instead.
   */
  | { kind: "legacy-callback"; pass: boolean; note?: string; response?: string }
  | { kind: "collector-error"; name: string; message?: string }

/**
 * One named coverage record: the probe ran and its raw state is retained, but the environment exposes
 * no applicable observable for the feature. Additive; disjoint from observations and assertions.
 */
export interface NotTestedCoverage {
  featureId: string
  reason: "no-semantic-observable"
  /** The specific semantic observable this environment cannot expose. */
  noObservable: string
  /** Points at the retained nonempty raw trace for this feature. */
  rawReplyRef: string
}

/** Captured from the module/binary actually loaded by a headless run. */
export interface LoadedEngineBinary {
  path: string
  sha256: string
}

export type EngineIntegrity =
  | { kind: "registry"; lockIntegrity: string }
  | { kind: "source"; repository: string; revision: string; treeOid: string; cleanTree: boolean }

interface HeadlessRuntimeBase {
  /** Verified by current collectors; absent in historical captures. */
  adapterSources?: readonly { readonly path: string; readonly blobOid: string }[]
  engineVersion: string
  adapterVersion: string
  termlessRevision: string
}

export type HeadlessRuntimeIdentity =
  | (HeadlessRuntimeBase & {
      kind: "js"
      runtimeFormat: "js"
      resolvedPath: string
      integrity: EngineIntegrity
    })
  | (HeadlessRuntimeBase & {
      kind: "js"
      runtimeFormat: "wasm"
      resolvedPath: string
      integrity: EngineIntegrity
      loadedBinary: LoadedEngineBinary
    })
  | (HeadlessRuntimeBase & {
      kind: "native"
      loadedBinary: LoadedEngineBinary
      provenance: {
        /** Sidecar output digest must equal loadedBinary.sha256. */
        sha256: string
        sourceCommit: string
        buildHash: string
        toolchain: string
        lockSha256: string
      }
    })

/** One app preflight measured before attaching a mux. */
export interface OuterAppProof {
  subject: ProbeSubject & { kind: "term" }
  rawReplies: Record<string, string>
  provenance?: RunProvenance
  appLaunch?: AppLaunchReceipt
}

/** Snapshot verified by the live Linux owner, retained for historical joins without live PID queries. */
export interface LinuxMuxAttachmentProof {
  platform: "linux"
  mux: "tmux" | "screen"
  bootId: string
  receiptSha256: string
  launchRunId: string
  captureRunId: string
  preflightCollector: { pid: number; startTicks: string }
  outerShell: { pid: number; startTicks: string; ttyRdev: number }
  outerTerminal: { pid: number; startTicks: string }
  collector: { pid: number; startTicks: string; ttyRdev: number }
  attachedClient: { pid: number; startTicks: string; ttyRdev: number }
  chain: { pid: number; startTicks: string; executablePath: string; ttyRdev: number }[]
  executable: { path: string; sha256: string; version: string }
  config: { path: string; sha256: string }
  socketPath: string
  session: string
}

/** The Darwin arm, written only from codimac's measured chain (#30518 D4). Birth is
 * `startedAtEpochSeconds` (D3); the root hop is the measured `/usr/bin/login`, and every row names a TTY. */
export interface DarwinMuxAttachmentProof {
  platform: "darwin"
  mux: "tmux" | "screen"
  bootId: string
  receiptSha256: string
  launchRunId: string
  captureRunId: string
  preflightCollector: { pid: number; startedAtEpochSeconds: number }
  outerShell: { pid: number; startedAtEpochSeconds: number; ttyRdev: number }
  outerTerminal: { pid: number; startedAtEpochSeconds: number }
  collector: { pid: number; startedAtEpochSeconds: number; ttyRdev: number }
  attachedClient: { pid: number; startedAtEpochSeconds: number; ttyRdev: number }
  chain: {
    pid: number
    ppid: number
    uid: number
    startedAtEpochSeconds: number
    executablePath: string
    /** r13 measured no controlling terminal on the outer terminal (a GUI process), so the last row —
     * and only the last row — may be null. Every other row names one. */
    ttyRdev: number | null
  }[]
  executable: { path: string; sha256: string; version: string }
  config: { path: string; sha256: string }
  socketPath: string
  session: string
}

/** One arm per platform, keyed by `platform` (#30518 D4). */
export type MuxAttachmentProof = LinuxMuxAttachmentProof | DarwinMuxAttachmentProof

/** Raw run records are immutable; review decisions live in Interpretation. */
export interface HistoricalRun {
  schemaVersion: 2
  runId: string
  subject: ProbeSubject
  source?: never
  identity: "verified" | "unverified" | "disputed"
  runtimeIdentity?: HeadlessRuntimeIdentity
  /** Measured in the running native-app environment before the run is sealed. */
  provenance?: RunProvenance
  /** Independently measured app preflight before attaching the mux; never another probe run. */
  outerApp?: OuterAppProof
  suiteId: string
  probeHash: string
  suiteComplete: boolean
  sourceRevision: string
  measuredAt: string
  origin: RunOrigin
  /**
   * Raw replies and traces by feature id. In a headless run, a callback result the collector refuses
   * still keeps its response here under its feature id; its refused observation and assertions survive
   * only as text in the collector-error note or message, never as claims. A late reply adds `<id>.late`.
   */
  rawReplies: Record<string, string>
  assertions: Array<Omit<ProbeAssertion, "assertionType"> & { assertionType?: AssertionType }>
  screenshotRefs: string[]
  /** Retained TEXT snapshots, the text-frame twin of `screenshotRefs` and a separate list because
   * every consumer of that one assumes a PNG. Absent in runs written before it existed. */
  textSnapshotRefs?: string[]
  textQualification?: TextQualification
  observations: Array<Omit<Observation, "assertionType"> & { assertionType?: AssertionType }>
  /** Named coverage records for features with no applicable observable here; disjoint from observations. */
  notTested?: NotTestedCoverage[]
  ungradedDiagnostics?: Record<string, UngradedDiagnostic>
}

/** One native-app receipt, independent of which OS executed the collector. */
export interface RunProvenance {
  executable: { path: string; sha256: string; version: string }
  sourceArtifact: { url: string; sha256: string } | DerivedSourceTreeArtifact
  runtime: {
    imageId: string
    imageTarSha256: string
    arch: string
    nixLockRevision: string
    sourceRevision: string
    cleanTree: boolean
    suiteHash: string
  }
  fixture: { definition: string; config: string; font: string; geometry: string; display: string; gl: string }
}

export interface HistoricalInterpretation {
  id: string
  /** An exact sealed-run overlay names buildable instrumentation work without rewriting the capture. */
  decision?: "tool-gap"
  /** A review of identity or community origin must name the exact immutable run. */
  runId?: string
  /** SHA256 of the exact raw run bytes; a review cannot move to another capture. */
  runSha256?: string
  reviewer: string
  reason: string
  scope: {
    subject: Pick<ProbeSubject, "kind" | "id">
    versions: [string, string]
    suites: [string, string]
  }
  sources: string[]
  supersedes: string[]
  featureId?: string
  observation?: Omit<Observation, "assertionType"> & { assertionType?: AssertionType }
  reviewed?: boolean
  verifiesIdentity?: boolean
  /** Controls evidence shown by the site and API; not a privacy control in this public repository. */
  presentsEvidence?: boolean
  /** Required on a presentation decision: the non-author acceptor, their GO message id and an ISO time with an offset. */
  accepted?: { by: string; wire: string; at: string }
  origin?: "documentation"
}

export type Interpretation = HistoricalInterpretation

/**
 * One sequence a library reported as passed through unhandled. The binding records the number only:
 * an OSC command number, the library's own normalized CSI values with the final byte ("5m", "4:3m", "?5m"),
 * or the initial APC payload byte ("G"), without the remaining payload.
 */
export interface UnhandledSequence {
  readonly kind: "osc" | "csi" | "apc"
  readonly code: string
}

/** Source for library probing (synchronous cell-state access) */
export interface LibProbeSource {
  /** Existing adapter name, retained only for human-readable binding diagnostics. */
  readonly backendName: string
  readonly kind: ProbeSourceKind
  /** The collector's measured loaded module/engine, never inferred from capabilities or versions. */
  readonly runtimeIdentity?: HeadlessRuntimeIdentity
  /** Existing HyperlinkExtension method; present only for exposed parser metadata. */
  getHyperlinkAt?(row: number, col: number): string | null
  /** Current engine defaults; null is an observed unset slot. Available for all three slots or absent. */
  getDefaultColors?(): {
    fg: { r: number; g: number; b: number } | null
    bg: { r: number; g: number; b: number } | null
    cursor: { r: number; g: number; b: number } | null
  }
  /** Effective instance reflow setting; absent: backend does not report. */
  getReflowState?(): { enabled: boolean }
  /** Icon name. Present only when the backend reports it separately from the window title. */
  getIconLabel?(): string
  /** Exact OSC 7 URI; null is an observed unset slot, absent means no reader. */
  getCwd?(): string | null
  /** Copied parser notification payloads; this does not observe OS notification delivery. */
  getNotifications?(): readonly string[]
  /** Copied OSC 777 payloads after "777;", verbatim and in order, notify or not; absent means no reader. */
  getOsc777Payloads?(): readonly string[]
  /** Engine-stored OSC 9;4 state/value; null means no report where known. WezTerm initial/clear/pause are state0/null. */
  getProgress?(): { state: number; value: number | null } | null
  /** Copied parsed OSC 9/777 toasts, engine fields verbatim, in order; the store does not say which OSC made one. */
  getToasts?(): readonly { title: string | null; body: string }[]
  /** Sequences this library reported as passed through without acting on them, in order; absent means no report on
   * this adapter, which stays missing evidence rather than a negative (@cto 2026-11-05 07:25 appendix, Case 1). */
  getUnhandledSequences?(): readonly UnhandledSequence[]
  /** Copied entries selected by semantic-marks (starts) or semantic-command-end (raw completion); absent means no reader. */
  getSemanticMarks?(): readonly (
    | {
        readonly type: "prompt" | "command" | "output"
        readonly startRow: number
        readonly startCol: number
      }
    | {
        readonly type: "command-end"
        readonly rawStatus: string
      }
  )[]
  /** Actual stored type at getCell coordinates, declared by semantic-cells; never mark history. */
  getCellSemanticType?(row: number, col: number): "prompt" | "input" | "output"
  /** Stored image attachments at getCell coordinates, declared by cell-images; not rendered pixels. */
  getCellImageCount?(row: number, col: number): number
  /** Current logical pointer shape from the library, declared by mouse-shape; not text-caret style. */
  getMouseShape?(): string
  /** Copied raw payloads and DCS start positions, without raster rendering or cell geometry. */
  getSixelImages?(): readonly {
    readonly data: string
    readonly row: number
    readonly col: number
  }[]
  /** Present only when the backend exposes the engine's clipboard callback state. */
  getClipboardState?(): {
    writes: { selector: string; payload: string; text?: string; decodeError?: string }[]
    pasteSelector?: string
    /** The engine's effective clipboard_control, when it reports one (Termless kitty) */
    control?: readonly string[]
  }
  /** Width read back from the backend after initialization, never inferred from cursor behavior. */
  readonly cols: number
  /** Controlled engine resize. Production sources always forward the required backend operation. */
  resize?(cols: number, rows: number): void
  feed(text: string): void
  feedCapture(text: string): string
  /**
   * F1 (27832) on a headless engine (#30554). Present only when the collector holds a proof that this
   * adapter's complete reply-delivery declaration matches its loaded source and engine; an
   * arm that finds it absent keeps its plain capture, so a silent query stays inconclusive there. It
   * captures `sequence`, then a DA1 query in a capture of its own, and reads the two with the live
   * collector's rule (readSentinelReply): DA1 answered in its own capture with no reply is the
   * `sentinel` outcome live records, a measured negative only when nothing preceded the answer.
   */
  queryWithSentinelOutcome?(sequence: string, pattern: RegExp): TerminalQueryOutcome
  /**
   * Shared cell attributes; probes do not require continuation or metadata.
   * Absent hyperlink: unreported; null: reported unlinked; string: exact URI.
   */
  getCell(
    row: number,
    col: number,
  ): Omit<Cell, "continuation" | "hyperlink" | "underlineColor" | "underline"> &
    Partial<Pick<Cell, "hyperlink" | "underlineColor">> & {
      /** true and null are probe-only readings in addition to the canonical styles. */
      underline: Cell["underline"] | true | null
    }
  getCursor(): { x: number; y: number; visible: boolean | null; style: string | null }
  getMode(mode: string): ModeState
  getText(): string
  getScrollback(): { viewportOffset: number; totalLines: number; screenLines: number }
  /**
   * Viewport scroll control, present only when the adapter can drive the backend's documented
   * `scrollViewport(delta)`. Both directions are needed to qualify a viewport observation: backends
   * disagree on the sign that scrolls up (measured 2026-10-29 on termless 06340a5c — ghostty-native
   * and xtermjs scroll up on -1; alacritty, vt100, vt220 and vterm on +1), and a backend with no
   * viewport scroll state ignores both. Absent, a viewport reading cannot qualify a negative.
   */
  scrollViewport?(delta: number): void
  /**
   * Library mouse-event encoder delegate, wired by `createLibProbeSource` only when
   * `capabilities.extensions.has("mouse-encoding")` and `typeof backend.encodeMouse === "function"` (#31798, @cto C3).
   */
  encodeMouse?(event: LibMouseEvent): Uint8Array | null
  /**
   * Library-native paste encoder, wired only when `capabilities.extensions.has("paste-encoding")`
   * and `typeof backend.encodePaste === "function"`. Returns this instance's bytes in its current mode.
   */
  encodePaste?(text: string): Uint8Array
  /** Library-native key bytes in this instance's modes; absent for host-encoded adapters. */
  encodeKey?(event: LibKeyEvent): Uint8Array
  getTitle(): string
  reset(): void
  capabilities: {
    truecolor: boolean
    kittyKeyboard: boolean
    kittyGraphics: boolean
    sixel: boolean
    osc8Hyperlinks: boolean
    semanticPrompts: boolean
    reflow: boolean
    /** Audited library-interface absence; undefined is undeclared. Retain the reason in capture state. */
    productViewport?: { available: false; reason: string }
    unicode: string
    extensions: Set<string>
  }
}

/**
 * How the run's terminal decodes a plainly written two-byte UTF-8 character, MEASURED by the
 * owning collector through one DSR 6n round trip: a UTF-8 context advances the cursor one cell per
 * code point, an 8-bit (ISO-8859-1) context advances one cell per BYTE. A pixel oracle that
 * compares a sequence's pixels with the same terminal's rendering of the literal glyph assumes
 * the first, so the second is a fact about the SUBJECT CONFIGURATION, never a terminal feature (#28752).
 */
export type Utf8Decoding = "utf8" | "8-bit"

/**
 * A measured decode context, or the NAMED reason this run could not measure one (#28752, review2):
 * `silent` is a terminal that answered no cursor report, and `unusable` is a terminal that answered
 * at a coordinate the measurement cannot read. Neither is a decoding and neither is claimed to be
 * silence, so a record can say which happened. A context with no collector measuring it at all is
 * absent, which is the launcher's own `not-measured`.
 */
export type Utf8DecodingReading = Utf8Decoding | "silent" | "unusable"

/** A measured width, or the exact missing/wrong fixture readback that prevents one. */
export type RenderedWidthResult =
  | number
  | { kind: "no-reply"; step: "origin" | "ascii" | "sample" | "trailing" }
  | {
      kind: "control-mismatch"
      step: "origin" | "ascii" | "sample" | "trailing"
      observed: { row: number; col: number }
    }
  | { kind: "wrapped"; observed: { row: number; col: number } }

/** Source for terminal probing (async TTY I/O) */
export interface TerminalQueryOutcome {
  match: string[] | null
  reason: "reply" | "sentinel" | "timeout"
  raw: string
  rawBase64: string
  /**
   * The DA1 sentinel's arrival, in ms measured from the query write, with the grace window that
   * followed it. Present exactly when DA1 was answered before this query's reply: a later reply is
   * a late reply graded by the reply, and a grace window with nothing before the sentinel's answer
   * and nothing after it is the measured negative that the grader records as "negative by
   * sentinel". Absent when nothing answered DA1.
   */
  sentinel?: { atMs: number; graceMs: number }
}

/** Library key-event input; the collector translates only these named fields. */
export interface LibKeyEvent {
  key: string
  shift?: boolean
  ctrl?: boolean
  alt?: boolean
  super?: boolean
}

/** Library mouse-event input matching `@termless/core` `MouseEvent` (#31798). */
export interface LibMouseEvent {
  x: number
  y: number
  /**
   * Zero-based integer pixel offsets from the terminal-content top-left, in caller-supplied pixel space.
   * Both axes must be in 0..Number.MAX_SAFE_INTEGER-1; SGR-pixel wire coordinates add 1 to each axis.
   * Other mouse formats ignore this field.
   */
  pixel?: { x: number; y: number }
  button: "left" | "middle" | "right" | "none" | "wheelUp" | "wheelDown"
  action: "press" | "release" | "move"
  shift?: boolean
  ctrl?: boolean
  alt?: boolean
}

/** A terminal's default paste action: the X11 selection it reads, the key that triggers it, and where that is defined. */
export interface PasteRoute {
  readonly selection: "clipboard" | "primary"
  readonly key: string
  /** The terminal's own source or manual, at the pinned version, that binds `key` to paste `selection`. */
  readonly binding: string
}

/** Independently observed text selection in an owned disposable display. */
export interface ClipboardFixture {
  /** Owned transaction baseline verified before the callback starts. */
  readonly baseline?: string
  /** True only when the collector verified a disposable session that sets and restores 2004 blind (#32164). */
  readonly disposableSession?: boolean
  /** Verified tmux server `set-clipboard` option read before the callback (#32164). */
  readonly tmuxSetClipboard?: string
  /** Bounded post-CPR wait window in ms for OSC 52 write selection settlement (default 1000, max 2000). */
  readonly writeDeadlineMs?: number
  /** Polling interval in ms for post-CPR OSC 52 write selection settlement (default 25). */
  readonly writePollMs?: number
  /**
   * The App's default paste action, chosen by the collector (#32164, @cto a4ec8fe2): readText/writeText act on
   * `selection`, and `key` is the keypress that pastes it. Present only on a clipboard-paste fixture.
   */
  readonly paste?: PasteRoute
  readText(): Promise<string>
  writeText(text: string): Promise<void>
  /**
   * X selection fixtures only: one real key event (shift press and release) on the owned window, recorded in the
   * clipboard trace. A terminal stamps its OSC 52 selection claim with its last input-event time, and X ignores a
   * claim older than the current owner's, so a terminal that never saw input loses to the fixture's own writer
   * (#33145). The OSC 52 write and roundtrip probes call it before their write, inside a PTY read.
   */
  realKeyEvent?(): Promise<void>
}

/** OS-level XTEST key/click/wheel/drag injection into the focused owned window. */
export interface InputFixture {
  injectKey(keys: string): Promise<void>
  /** Move focus to the display root and back, verifying both owned X focus reads. */
  focusRoundTrip?(): Promise<{
    ownedWindowId: string
    rootWindowId: string
    focusedWindowIds: [string, string, string]
  }>
  injectClick(button: 1 | 4 | 5, position?: { x: number; y: number }): Promise<void>
  /** Resize the owned disposable window, returning its previous pixel size. */
  resizeWindow?(width: number, height: number): Promise<{ width: number; height: number }>
  /** Buttonless motion in owned-window pixels; absent adapters stay click-only. */
  injectMove?(x: number, y: number): Promise<void>
  /** Button-event (1002) motion. Absent adapters stay click-only. */
  injectDrag?(button: 1): Promise<void>
}

export type TermFeaturesReading =
  | {
      status: "measured"
      present: boolean
      value: string
      runId: string
      launchMarker: string
      pid: number
      tty: string
      /** The multiplexer this child runs inside (#32569): a present value may come from the outer terminal. */
      mux?: "tmux" | "screen"
    }
  | { status: "unavailable"; reason: string }
  | { status: "invalid"; reason: string }

/** Same-row observations from the owned App reader; no App identity enters probe definitions. */
export type AppSemanticReading =
  | {
      status: "measured"
      reader: "state"
      runId: string
      unknown: { before: string; after: string }
      handled: { before: string; after: string; expected: string }
      target: { before: string; after: string; expected: string }
      detail: object
    }
  | {
      status: "measured"
      reader: "report"
      runId: string
      unknown: { code: string; reports: string[] }
      handled: { applied: boolean; reports: string[] }
      target: { code: string; reports: string[] }
      detail: object
    }
  | { status: "unavailable" | "invalid"; reason: string; detail?: object }

/** Same-session terminal report. Unreported fields are absent, never inferred. */
export type TerminalScrollbackReading = Readonly<{
  totalLines: number
  screenLines?: number
  /** Top-relative, as in the library reading. */
  viewportOffset?: number
  /** Maximum retained scrollback history lines, when known by the reader. */
  capacity?: number
}>

/** Post-reset receipt from an owned multiplexer window history reset (#32874). */
export type TerminalScrollbackReset = Readonly<{
  status: "reset"
  capacity: number
}>

export interface TermProbeSource {
  readonly kind: ProbeSourceKind
  /** Verified multiplexer identity when this run's subject is a multiplexer (#32774). */
  mux?: "tmux" | "screen"
  /** Same-session owned history. Absent when the terminal exposes no complete reading. */
  getScrollback?: () => Promise<TerminalScrollbackReading>
  /** Reset owned window history to empty at the run's configured capacity before baseline read (#32801, #32874). */
  resetScrollback?: () => Promise<TerminalScrollbackReset>
  /** This run's owned public title surface; empty is a title, and a failed read throws its cause. */
  readTitle?: () => Promise<string>
  /** One allowlisted export, qualified by the fresh launch and this child's run/PID/TTY. */
  readTermFeatures?: () => Promise<TermFeaturesReading>
  /** Writes use the callback's recorder; reads bind to this run's verified App or mux. */
  readAppSemanticState?: (featureId: string, write: (text: string) => void) => Promise<AppSemanticReading>
  /** Complete same-run raster geometry, installed only after witnessed paint and restore. */
  captureGeometry?: {
    geometry: CapturePixelGeometry
    source: "measured by complete raster calibration"
    /**
     * The solid paint calibration witnessed, and the exact colour it measured for it. A later
     * layout check repaints with this form and looks for this colour; absent on a run calibrated
     * before the check existed.
     */
    sentinel?: CalibrationSentinel
  }
  write(text: string): void
  queryCursorPosition(): Promise<{ row: number; col: number } | null>
  measureRenderedWidth(text: string): Promise<RenderedWidthResult>
  query(sequence: string, pattern: RegExp, timeoutMs?: number): Promise<string[] | null>
  queryWithSentinel(sequence: string, pattern: RegExp, timeoutMs?: number): Promise<string[] | null>
  queryOutcome(sequence: string, pattern: RegExp, timeoutMs?: number): Promise<TerminalQueryOutcome>
  queryWithSentinelOutcome(sequence: string, pattern: RegExp, timeoutMs?: number): Promise<TerminalQueryOutcome>
  queryMode(modeNum: number): Promise<"set" | "reset" | "unknown" | null>
  /**
   * The decoding this run gives a plainly written two-byte UTF-8 character, measured at most once
   * per run by the collector that owns the terminal (see Utf8DecodingReading). `silent` means no
   * cursor report arrived and `unusable` that one arrived this measurement cannot read, so an
   * answered-but-unreadable reply is never recorded as silence; absent means this context has no
   * collector that measures it. A row whose oracle compares plainly written glyphs reads it before
   * grading, so a Latin-1 context is named as the cause instead of being read as a terminal
   * feature negative (#28752).
   */
  utf8Decoding?: () => Promise<Utf8DecodingReading>
  /**
   * Present exactly when this run's owned capture pre-flight measured the cell-to-pixel geometry and
   * REFUSED it, by name (28785): a row that finds no capture adapter names this cause — the terminal
   * whose own numbers do not fit a cell, or one that answered DA1 and then stayed silent — instead of
   * claiming the run never had a capture path. Absent when an adapter was installed, and absent when
   * this context has no capture path at all. Named captureGeometryRefusal because probe-defs already
   * uses `captureRefusal` for a row's own refusal to capture an undersized terminal (modes.ts:6,
   * reset.ts:54); one name carries one concept (@cto, 28785 REVISE round 2, must 4).
   */
  captureGeometryRefusal?: string
  /** An owned Linux collector installs this only after verifying the launch receipt. */
  withClipboardFixture?: (
    work: (fixture: ClipboardFixture) => Promise<ProbeCallbackResult>,
  ) => Promise<ProbeCallbackResult>
  /** Present only when an owned OS capture adapter is installed for this run. */
  capture?: (request: CaptureRequest) => Promise<ObservationFrame>
  /** The terminal's OWN CELLS, on a text arm. Separate from `capture` because only the region
   * readback can decide a row from cells: every other consumer reads pixels, so a text run hands it
   * no adapter and the consumer takes its own named no-capture branch. */
  cells?: (request: CaptureRequest) => Promise<ObservationFrame>
  /** What the adapter reads: the screen's pixels, or the terminal's own text. Absent when
   * no adapter is installed, and absent in every run recorded before text frames existed, where the
   * only adapter that could have been installed was a pixel one. */
  captureKind?: "pixels" | "text-cells"
  /** Present only when an owned OS XTEST adapter is installed for this run. */
  input?: InputFixture
  /** Read unsolicited stdin. `inject` runs after the stdin listener is attached. */
  readInput?: (pattern: RegExp, timeoutMs?: number, inject?: () => Promise<void>) => Promise<string[] | null>
  /** Like readInput, but returns the raw bytes. The listener is armed before inject runs. */
  readInjected?: (pattern: RegExp, timeoutMs: number, inject: () => Promise<void>) => Promise<TerminalQueryOutcome>
  cols: number
  rows: number
}

export interface ProbeDefinition {
  libHostRecipes?: readonly HostRecipeExpectation[]
  id: string
  lib: ((ctx: LibProbeSource) => ProbeCallbackResult) | null
  term: ((ctx: TermProbeSource) => Promise<ProbeCallbackResult>) | null
  /** Harness wall for this probe's app callback, in milliseconds. Absent uses the runner's 30s default. */
  wallMs?: number
  /** Only an explicitly reviewed report request may run without a disposable terminal. */
  termWrites?: "query"
  /**
   * This callback may MUTATE the terminal and read the state back, so it needs a verified
   * disposable-ownership receipt or a verified run-scoped process owner. Shared application
   * ownership alone never authorizes it; absent, forged or foreign authority leaves the terminal untouched.
   */
  termNeedsDisposable?: true
  /** App callback requires measured geometry from its owned output stream. */
  termNeedsGeometry?: true
  /** This callback decides at least one row through the region readback, so a text-cells run hands
   * it the cells adapter. Every other probe is handed nothing on such a run. */
  cellReadback?: true
  /** Reviewed character-only claim; adapter routing alone never implies eligibility. */
  textClaim?: "characters"
  /** A null term arm is absent. A null declaration means the running arm retains no typed deciding
   * observable; undefined is temporarily undeclared (#28801), never equivalent to null. */
  termAssertionType?: AssertionType | null
  /** Same declaration contract as termAssertionType, for the library callback. */
  libAssertionType?:
    | AssertionType
    | null
    | {
        readonly when: (
          source: Pick<
            LibProbeSource,
            | "runtimeIdentity"
            | "getTitle"
            | "getIconLabel"
            | "getUnhandledSequences"
            | "getCellImageCount"
            | "getMouseShape"
            | "capabilities"
          >,
        ) => boolean
        readonly then: readonly [AssertionType, ...AssertionType[]]
        readonly otherwise: readonly [AssertionType, ...AssertionType[]]
      }
}

/** The only live run contract; v1/v2 are historical reader inputs. */
export type Run = CurrentRun
