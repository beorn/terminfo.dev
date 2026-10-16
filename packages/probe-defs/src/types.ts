/** A probe ran and retained raw state, but this environment exposes no applicable observable for the claim. */
export interface NoSemanticObservable {
  /** Closed reason for a coverage record. */
  reason: "no-semantic-observable"
  /** The specific semantic observable this environment cannot expose. */
  noObservable: string
}

/** A probe result is exactly one of two things: a measured observation, or a coverage record. */
export type ProbeResult = MeasuredProbeResult | NotTestedCoverageResult

export interface MeasuredProbeResult {
  /** Historical raw documents carry it; the live collector reads only observation. */
  pass: boolean
  note?: string
  response?: string
  /** The explicit measured result. Never promoted from pass. */
  observation: Omit<Observation, "featureId" | "rawReplyRef">
  assertions?: Array<Omit<ProbeAssertion, "featureId" | "rawReplyRef">>
  notTested?: never
}

export interface NotTestedCoverageResult {
  pass: boolean
  note?: string
  response?: string
  observation?: never
  assertions?: never
  /** Per-result coverage: the probe ran and captured raw state, but no applicable observable exists here. */
  notTested: NoSemanticObservable
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
] as const
export type ObservationReason = (typeof OBSERVATION_REASONS)[number]

/** Method of observing a claim, independent of the run's source origin. */
export const OBSERVATION_EVIDENCE = [
  "query",
  "behavior",
  "parser-state",
  "pixels",
  "interaction",
  "consumed",
  "legacy",
  /** No terminal measurement: the collector declined to run the callback. */
  "none",
] as const
export type ObservationEvidence = (typeof OBSERVATION_EVIDENCE)[number]

/** These methods cannot by themselves establish a support result. */
export const NON_MEASURING_EVIDENCE: ReadonlySet<ObservationEvidence> = new Set<ObservationEvidence>([
  "consumed",
  "legacy",
  "none",
])
export function isNonMeasuringEvidence(evidence: ObservationEvidence): boolean {
  return NON_MEASURING_EVIDENCE.has(evidence)
}

export interface Observation {
  featureId: string
  outcome: ObservationOutcome
  reason?: ObservationReason
  evidence: ObservationEvidence
  rawReplyRef?: string
  screenshotRef?: string
  frames?: ObservationFrame[]
  note?: string
}

/** Collector-owned capture checkpoint, with the published PNG bound by its digest. */
export interface ObservationFrame {
  role: "control" | "target"
  ref: string
  capturedAt: number
  label: string
  /** Original capture bytes, such as XWD; retained with the raw run receipt. */
  sourceRef?: string
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
  /** The run's measured pixel geometry, required alongside `cells`. */
  pixelGeometry?: CapturePixelGeometry
}

export interface ProbeTarget {
  kind: "app" | "headless" | "mux"
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

export type AppLaunchReceipt =
  | {
      platform?: never
      bundlePath: string
      cfBundleShortVersionString: string
      cfBundleVersion: string
      executablePath: string
      executableSha256: string
      sourceArtifact: AppSourceArtifact
    }
  | {
      platform: "win32"
      executablePath: string
      productVersion: string
      executableSha256: string
      sourceArtifact: { kind: "portable-zip"; path: string; sha256: string }
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
 * tree this repo derived a flat artifact from.
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
  probeHash: string
  sourceRevision?: string
  generatedAt?: string
  adapterVersion: string
  probes: Record<ProbeTarget["kind"], string[]>
}

export interface ProbeAssertion {
  featureId: string
  kind: "positive" | "negative"
  rawReplyRef?: string
  /** The predicate/expected state and the actually observed bytes or serialized state. */
  expected: string
  observed: string
  /** Required for interaction evidence; names the action actually performed. */
  action?: string
  note?: string
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

/** Raw run records are immutable; review decisions live in Interpretation. */
export interface ProbeRun {
  schemaVersion: 2
  runId: string
  target: ProbeTarget
  identity: "verified" | "unverified" | "disputed"
  runtimeIdentity?: HeadlessRuntimeIdentity
  /** Measured in the running native-app environment before the run is sealed. */
  provenance?: RunProvenance
  suiteId: string
  probeHash: string
  suiteComplete: boolean
  sourceRevision: string
  measuredAt: string
  origin: RunOrigin
  rawReplies: Record<string, string>
  assertions: ProbeAssertion[]
  screenshotRefs: string[]
  observations: Observation[]
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

export interface Interpretation {
  id: string
  /** A review of identity or community origin must name the exact immutable run. */
  runId?: string
  /** SHA256 of the exact raw run bytes; a review cannot move to another capture. */
  runSha256?: string
  reviewer: string
  reason: string
  scope: {
    target: Pick<ProbeTarget, "kind" | "id">
    versions: [string, string]
    suites: [string, string]
  }
  sources: string[]
  supersedes: string[]
  featureId?: string
  observation?: Observation
  reviewed?: boolean
  verifiesIdentity?: boolean
  /** Controls evidence shown by the site and API; not a privacy control in this public repository. */
  presentsEvidence?: boolean
  origin?: "documentation"
}

/** Context for headless backends (synchronous cell-state access) */
export interface TermlessContext {
  /** Existing HyperlinkExtension method; present only for exposed parser metadata. */
  getHyperlinkAt?(row: number, col: number): string | null
  /** Width read back from the backend after initialization, never inferred from cursor behavior. */
  readonly cols: number
  feed(text: string): void
  feedCapture(text: string): string
  getCell(
    row: number,
    col: number,
  ): {
    char: string
    /** Absent: backend does not report links; null: reported unlinked; string: exact URI. */
    hyperlink?: string | null
    bold: boolean
    dim: boolean
    italic: boolean
    // oxlint-disable-next-line typescript/no-explicit-any -- Existing Termless cell contract; observation schema does not change it.
    underline: any
    underlineColor?: { r: number; g: number; b: number } | null
    strikethrough: boolean
    inverse: boolean
    hidden: boolean
    blink: boolean
    overline?: boolean
    fg: { r: number; g: number; b: number } | null
    bg: { r: number; g: number; b: number } | null
    wide: boolean
  }
  getCursor(): { x: number; y: number; visible: boolean | null; style: string | null }
  getMode(mode: string): boolean
  getText(): string
  getScrollback(): { viewportOffset: number; totalLines: number; screenLines: number }
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
    unicode: string
    extensions: Set<string>
  }
}

/**
 * How the run's terminal decodes a plainly written two-byte UTF-8 character, MEASURED by the
 * owning collector through one DSR 6n round trip: a UTF-8 context advances the cursor one cell per
 * code point, an 8-bit (ISO-8859-1) context advances one cell per BYTE. A pixel oracle that
 * compares a sequence's pixels with the same terminal's rendering of the literal glyph assumes
 * the first, so the second is a fact about the CONTEXT, never a terminal capability (#28752).
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

/** Context for real terminal probing (async TTY I/O) */
export interface TerminalQueryOutcome {
  match: string[] | null
  reason: "reply" | "sentinel" | "timeout"
  raw: string
  rawBase64: string
  /**
   * The DA1 sentinel's arrival, in ms measured from the query write, with the grace window that
   * followed it. Present exactly when DA1 was answered before this query's reply: a later reply is
   * a late reply graded by the reply, and a silent grace window is the measured negative that the
   * grader records as "negative by sentinel". Absent when nothing answered DA1.
   */
  sentinel?: { atMs: number; graceMs: number }
}

/** Independently observed text selection in an owned disposable display. */
export interface ClipboardFixture {
  readText(): Promise<string>
  writeText(text: string): Promise<void>
}

/** OS-level XTEST key/click/wheel/drag injection into the focused owned window. */
export interface InputFixture {
  injectKey(keys: string): Promise<void>
  injectClick(button: 1 | 4 | 5): Promise<void>
  /** Button-event (1002) motion. Absent adapters stay click-only. */
  injectDrag?(button: 1): Promise<void>
}

export interface TermContext {
  /** Complete same-run raster geometry, installed only after witnessed paint and restore. */
  captureGeometry?: {
    geometry: CapturePixelGeometry
    source: "measured by complete raster calibration"
  }
  write(text: string): void
  queryCursorPosition(): Promise<{ row: number; col: number } | null>
  measureRenderedWidth(text: string): Promise<number | null>
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
   * capability negative (#28752).
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
  withClipboardFixture?: (work: (fixture: ClipboardFixture) => Promise<ProbeResult>) => Promise<ProbeResult>
  /** Present only when an owned OS capture adapter is installed for this run. */
  capture?: (request: CaptureRequest) => Promise<ObservationFrame>
  /** Present only when an owned OS XTEST adapter is installed for this run. */
  input?: InputFixture
  /** Read unsolicited stdin. `inject` runs after the stdin listener is attached. */
  readInput?: (pattern: RegExp, timeoutMs?: number, inject?: () => Promise<void>) => Promise<string[] | null>
  cols: number
  rows: number
}

export interface ProbeDefinition {
  id: string
  termless: ((ctx: TermlessContext) => ProbeResult) | null
  term: ((ctx: TermContext) => Promise<ProbeResult>) | null
  /** Only an explicitly reviewed report request may run without a disposable terminal. */
  termWrites?: "query"
  /**
   * This callback may MUTATE the terminal and read the state back, so it needs a verified
   * disposable-ownership receipt as well as an owned terminal. A person's terminal is never
   * authorized: absent, forged or foreign receipt leaves the untouched default path.
   */
  termNeedsDisposable?: true
  /** App callback requires measured geometry from its owned output stream. */
  termNeedsGeometry?: true
  /** Explicit opt-in for recording callback exceptions as observations. */
  termObservationEvidence?: ObservationEvidence
  /** Every observation this Termless callback returns names this method, or none for a refusal before measurement. */
  termlessObservationEvidence?: ObservationEvidence
}
