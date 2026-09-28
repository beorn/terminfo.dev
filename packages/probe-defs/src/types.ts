export interface ProbeResult {
  pass: boolean
  note?: string
  response?: string
  /** Explicit measured result; the legacy pass boolean is never promoted. */
  observation?: Omit<Observation, "featureId" | "rawReplyRef">
  assertions?: Array<Omit<ProbeAssertion, "featureId" | "rawReplyRef">>
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
] as const
export type ObservationEvidence = (typeof OBSERVATION_EVIDENCE)[number]

export interface Observation {
  featureId: string
  outcome: ObservationOutcome
  reason?: ObservationReason
  evidence: ObservationEvidence
  rawReplyRef?: string
  screenshotRef?: string
  note?: string
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

export interface AppLaunchReceipt {
  bundlePath: string
  cfBundleShortVersionString: string
  cfBundleVersion: string
  executablePath: string
  executableSha256: string
  sourceArtifact: { path: string; sha256: string }
}

/** Immutable declaration of the probes available in one suite revision. */
export interface ProbeSuiteManifest {
  probeHash: string
  sourceRevision: string
  generatedAt: string
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
  | { kind: "legacy-callback"; pass: boolean; note?: string; response?: string }
  | { kind: "collector-error"; name: string; message?: string }

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
  ungradedDiagnostics?: Record<string, UngradedDiagnostic>
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
  origin?: "documentation"
}

/** Context for headless backends (synchronous cell-state access) */
export interface TermlessContext {
  feed(text: string): void
  feedCapture(text: string): string
  getCell(
    row: number,
    col: number,
  ): {
    char: string
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

/** Context for real terminal probing (async TTY I/O) */
export interface TerminalQueryOutcome {
  match: string[] | null
  reason: "reply" | "sentinel" | "timeout"
  raw: string
  rawBase64: string
}

export interface TermContext {
  write(text: string): void
  queryCursorPosition(): Promise<{ row: number; col: number } | null>
  measureRenderedWidth(text: string): Promise<number | null>
  query(sequence: string, pattern: RegExp, timeoutMs?: number): Promise<string[] | null>
  queryWithSentinel(sequence: string, pattern: RegExp, timeoutMs?: number): Promise<string[] | null>
  queryOutcome(sequence: string, pattern: RegExp, timeoutMs?: number): Promise<TerminalQueryOutcome>
  queryWithSentinelOutcome(sequence: string, pattern: RegExp, timeoutMs?: number): Promise<TerminalQueryOutcome>
  queryMode(modeNum: number): Promise<"set" | "reset" | "unknown" | null>
  cols: number
}

export interface ProbeDefinition {
  id: string
  termless: ((ctx: TermlessContext) => ProbeResult) | null
  term: ((ctx: TermContext) => Promise<ProbeResult>) | null
  /** Explicit opt-in for recording callback exceptions as observations. */
  termObservationEvidence?: ObservationEvidence
}
