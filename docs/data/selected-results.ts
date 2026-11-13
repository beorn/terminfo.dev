/** Stored selection and projection for terminal observations. */
import { existsSync, readFileSync } from "node:fs"
import { isAbsolute, join } from "node:path"
import {
  aggregateCurrentResults,
  type RollupCounts,
  classifyResultMethod,
  computeFeatureResults,
  type FeatureResult,
  type ProbeMethod,
  type SuiteRelation,
} from "./release-scope.ts"
import { loadFeatures } from "@terminfo/catalog"
import type { CensusContext } from "./full-census.ts"
import { isDefaultOf, MUX_DEFAULT_CONFIG, supplementOf, type ContextSupplement } from "./context-supplements.ts"
import { cellLabel, loadReopenedCells, type ReopenedCell, type ReopenedMarker } from "./reopened-cells.ts"
import {
  REMOVE_DECLARED_ROW,
  loadDeclaredUntestable,
  type DeclaredMarker,
  type DeclaredUntestableCell,
} from "./declared-untestable.ts"
import { applyDerived, DERIVED_UNSUPPORTED, type DerivedMarker, type DerivedPair } from "./derived-cells.ts"
import { applyHeld, HELD_NEGATIVES, supportedSuites, type HeldMarker } from "./held-negatives.ts"
import { applyOuterAbsent, type OuterAbsentMarker } from "./mux-outer-demotion.ts"
import type { CurrentTraceDocument } from "./run-trace.ts"
import {
  type Interpretation,
  type ProbeResult,
  type ProbeStatus,
  type FeatureResultStatus,
  type HistoricalRun,
  type ObservationFrame,
  type ProbeSubject,
  type RunOrigin,
  type RunDraft,
  type UngradedDiagnostic,
  type TextQualification,
  type CollectorSelection,
  type CollectorAttempt,
  readCollectorSelection,
  readCollectorAttempt,
  isHarnessOutcome,
} from "@terminfo/probe-defs"
import { type LoadedRun, type RunTraceFacts, parseJsonStrict } from "@terminfo/run-parser"
import {
  loadStoredRuns,
  RETAINED_ARTIFACT_KINDS,
  verifyRetainedArtifact,
  type RetainedArtifactKind,
} from "../../packages/admin/corpus-placement.ts"
const nonempty = (value: unknown): value is string => typeof value === "string" && value.length > 0
function fail(path: string, message: string): never {
  throw new Error(`${path}: ${message}`)
}

type ReadObservation = HistoricalRun["observations"][number]
type ReadAssertion = HistoricalRun["assertions"][number]

/** Created only for a digest-bound stored reference; mutable working inputs never have one. */
interface RunTraceMemo {
  value?: { url: string; sha256: string; bytes: string; document: CurrentTraceDocument }
}

/** Selection facts only; run-owned evidence is read once when its public trace is built. */
export type ProjectionRun = Pick<
  LoadedRun,
  | "path"
  | "schemaVersion"
  | "source"
  | "runId"
  | "sha256"
  | "subject"
  | "measuredAt"
  | "suiteId"
  | "probeHash"
  | "sourceRevision"
  | "catalogIds"
  | "results"
  | "screenshotRefs"
  | "textSnapshotRefs"
> & {
  assertions: Array<Pick<ReadAssertion, "featureId" | "kind" | "assertionType">>
  selection: CollectorSelection | undefined
  attempt: CollectorAttempt | undefined
  screenRecord: string | undefined
  outerApp?: Pick<NonNullable<LoadedRun["outerApp"]>, "subject">
  readRaw: () => RunTraceFacts
  traceMemo?: RunTraceMemo
}

function compactRun(run: LoadedRun, readRaw: () => RunTraceFacts): ProjectionRun {
  return {
    path: run.path,
    schemaVersion: run.schemaVersion,
    source: run.source,
    runId: run.runId,
    sha256: run.sha256,
    subject: run.subject,
    measuredAt: run.measuredAt,
    suiteId: run.suiteId,
    probeHash: run.probeHash,
    sourceRevision: run.sourceRevision,
    catalogIds: run.catalogIds,
    results: run.results,
    screenshotRefs: run.screenshotRefs,
    textSnapshotRefs: run.textSnapshotRefs,
    assertions: run.assertions.map(({ featureId, kind, assertionType }) => ({ featureId, kind, assertionType })),
    selection: readCollectorSelection(run.rawReplies),
    attempt: readCollectorAttempt(run.rawReplies),
    screenRecord: run.rawReplies["collector.geometry"],
    readRaw,
    ...(run.outerApp && { outerApp: { subject: run.outerApp.subject } }),
  }
}

function projectionRun(run: LoadedRun | ProjectionRun): ProjectionRun {
  // Explicit in-memory working inputs and pure projection callers own their raw input's lifetime.
  return "readRaw" in run ? run : compactRun(run, () => run)
}
export interface SelectedCell extends ReadObservation {
  conclusive: boolean
  /** Same-run mapping failure, computed from retained evidence; absent when no assessment failed. */
  textQualificationReason?: string
  record: {
    rawReply?: string
    assertions: ReadAssertion[]
    screenshot?: { url: string; sha256: string }
    frames?: Array<{
      role: ObservationFrame["role"]
      label: string
      capturedAt: number
      /** Which read produced the frame. A text frame has no `url`: the site cannot render one yet. */
      kind: "pixels" | "text-cells"
      url?: string
      sha256: string
      sourceRef?: string
    }>
  }
  chain: {
    origin: RunOrigin
    method: ReadObservation["assertionType"]
    runId: string
    runSha256: string
    rawReplyRef?: string
    screenshotRef?: string
    sources?: string[]
  }
}

export interface SelectedVersion {
  schemaVersion: 1 | 2
  runId: string
  subject: ProbeSubject
  measuredAt: string
  suiteId: string
  probeHash: string | null
  suiteFreshness: string
  /** The machine fact behind `suiteFreshness`: whether this run matches the tree or is older/partial. */
  suiteRelation: SuiteRelation
  suite: { observed: number; expected: number | null; complete: boolean; namedNotTested: number }
  sourceRevision: string | null
  sha256: string
  /** The identity the run recorded for itself. Only its trace document publishes it. */
  identity: LoadedRun["identity"]
  /** Immutable run-owned witnesses; no derived assessment is stored here. */
  textQualification?: TextQualification
  cells: Record<string, SelectedCell>
  v1: Record<string, boolean>
  ungradedDiagnostics: {
    label: "old callback result, unverified"
    results: Record<string, UngradedDiagnostic>
  }
  reviews: Array<Pick<Interpretation, "id" | "reviewer" | "reason" | "sources">>
  counts: {
    catalog: number
    tested: number
    notTested: number
    conclusive: number
    supported: number
    unsupported: number
  }
  /** Named coverage records (a subset of counts.notTested) and their disjoint partition of the catalog. */
  notTestedCoverage: {
    named: Array<{ featureId: string; reason: "no-semantic-observable"; noObservable: string; rawReplyRef: string }>
    measured: number
    namedCount: number
    remainder: number
  }
}

/** One admission refusal the projection reports: a run it read but did not select, and why. */
export interface SelectedExclusion {
  readonly runId: string
  /** The run document, as the content root names it (`probes-libs/...`), so the row stays portable. */
  readonly path: string
  readonly reason: string
}

/**
 * A current row retains the collector's recorded grades and reasons. Required grading conditions,
 * including Windows console-host ownership, are finalized before the run is stored.
 */
export interface CurrentSelectedVersion {
  schemaVersion: 3 | 4
  /** Recorded by schema 4; historical source absence remains absence. */
  source?: RunDraft["source"]
  runId: string
  subject: ProbeSubject
  measuredAt: string
  suiteId: string
  probeHash: string
  sourceRevision: string
  sha256: string
  catalogIds: string[]
  results: ProbeResult[]
  selection: CollectorSelection | undefined
  screenRecord: string | undefined
  readRaw: () => RunTraceFacts
  traceMemo?: RunTraceMemo
  suiteRelation: SuiteRelation
  suiteFreshness: string
  counts: Record<ProbeStatus, number>
  score: { supported: number; all: number }
  complete: boolean
}

/** A private view refers to the original result and its own run, never to a synthetic capture. */
export interface SelectedContextCell {
  origin: { runId: string; resultId: string }
  run: ProjectionRun
  result: ProbeResult
  /** Environment groups are retained run metadata, outside the feature-result catalogue. */
  featureResult?: FeatureResult
  /**
   * Set only when a context supplement (context-supplements.ts) read this cell. `filled`: the cell is the
   * supplement's own result and run. `open`: the supplement gave no proof, so the default cell stays, with this reason.
   * `noted`: a decided default cell keeps its status, reason and tests; the supplement's decided status is only a note
   * (#33151, a supplement that declares notesDecided).
   */
  supplement?: { name: string; qualifier: string; runId: string; declaredDefault?: string } & (
    | { filled: true }
    | { filled: false; open: string }
    | { filled: false; noted: ProbeResult["status"] }
  )
  /**
   * Set only when a reopened-cells row (reopened-cells.ts, #33164) withdrew this cell's grade: the feature result reads
   * probe-todo, while `result`, `run` and `origin` stay the witnessed original.
   */
  reopened?: ReopenedMarker
  /**
   * Set only when a declared-untestable row (declared-untestable.ts, @cto 82a54984) read this open cell: the feature
   * result reads untestable by review, while `result`, `run` and `origin` stay the original. Never a grade.
   */
  declared?: DeclaredMarker
  /**
   * Set only when a declared pair (derived-cells.ts, #33019) read this cell from a decided-Unsupported parent in the
   * same context: the feature result reads unsupported, while `result`, `run` and `origin` stay the child's own.
   */
  derived?: DerivedMarker
  /**
   * Set only when a held-negatives row (held-negatives.ts, #33034) found this negative unwitnessed: no run under the
   * same suite reads the feature Supported, so the cell reads probe-invalid while `result` stays the original.
   */
  held?: HeldMarker
  /**
   * Set only when the mux-input demotion (mux-outer-demotion.ts, #33665) read this cell: the mux measured Unsupported on
   * an input row the placed outer terminal of the same version also reads Unsupported, so the feature result reads
   * untestable while `result`, `run` and `origin` stay the measured original.
   */
  outerAbsent?: OuterAbsentMarker
}

/** An initialized draft can retain intent even when no measured subject or result exists. */
export interface SelectedAttemptInput {
  context: CensusContext
  intendedSubject: Record<string, unknown>
  runId: string
  path: string
  rawReplies: Record<string, string>
}

export interface SelectedContextAttempt {
  runId: string
  path: string
  selection: CollectorSelection
  attempt: CollectorAttempt | undefined
  noOutputIds: string[]
}

export interface SelectedContextSummary {
  contextKey: string
  /** Shared physical context facts; absent for an unmeasured pre-start attempt. */
  subject?: Omit<ProbeSubject, "version">
  catalogIds: string[]
  cells: Record<string, SelectedContextCell>
  missingIds: string[]
  contributingRunIds: string[]
  attempts: SelectedContextAttempt[]
  /** Every rollup bucket, including the derived disagreement bucket (@cto c3c2f885); never Supported. */
  counts: RollupCounts
  /** Cells counted in `counts.unsupported` only by derivation (#33019); never direct measurements. */
  derivedIds: string[]
  score: { supported: number; all: number }
  /** Completeness of the recorded cell set, not a claim that a requested attempt completed. */
  complete: boolean
  /** Set only when a mux run's Unsupported input rows kept their reading: why, per run (#33665 condition 2). */
  outerAbsentRefusals?: string[]
}

export interface SelectedProjection {
  /** The canonical composed view for private and public consumers. */
  contexts: Record<string, SelectedContextSummary>
  versions: Record<string, CurrentSelectedVersion[]>
  history: Record<string, CurrentSelectedVersion[]>
  /**
   * Working inputs stay private: an unadmitted run's original resolves here, keyed by the context it
   * joins, never through `history`. Without this a composed row that cites a working run cannot name
   * the run it was measured from (#33640).
   */
  workingOriginals: Record<string, CurrentSelectedVersion[]>
  table: Readonly<Record<string, Readonly<Record<string, ProbeStatus>>>>
  /** Archived assessment refusals followed by the current-run refusals this reading assessed. */
  exclusions: SelectedExclusion[]
  treeSuiteId: string
}

export type { TextQualificationAssessment } from "@terminfo/probe-defs"

/** Read one parsed development run's recorded statuses without admission, selection or regrading. */
export function classifyDevelopmentRun(run: LoadedRun): {
  mode: "development"
  runId: string
  states: Record<string, ProbeStatus>
} {
  if ((run.schemaVersion !== 3 && run.schemaVersion !== 4) || !run.results) {
    throw new Error(
      `Development run ${run.runId} requires stored current results; use the historical reader for old runs`,
    )
  }
  return {
    mode: "development",
    runId: run.runId,
    states: Object.fromEntries(run.results.map((result) => [result.featureId, result.status])),
  }
}

/**
 * The frozen runner's own build hash changes with every suite (its bundle embeds the suite), so the
 * same row measured on a later suite would otherwise land in a NEW context and never supersede the run
 * it replaces (27929 D5: three xterm/linux runs differed ONLY in this path). Mask it wherever a
 * config string enters a context key — it is apparatus, not a difference in how the row was measured.
 * The same normalization is used for original and working subject configurations.
 *
 * A unix socket address given to `--listen-on` is apparatus in the same way (#33543, @cto 22819c2f): the container
 * runner names Kitty's socket after the run id, so each run opened a new context. That a terminal listens on a unix
 * socket stays in the key (it changes behaviour); where it listens does not. A `tcp:` address is left as recorded.
 */
export function maskRunnerStorePath(config: string | null): string | null
export function maskRunnerStorePath(config: unknown): unknown
export function maskRunnerStorePath(config: unknown): unknown {
  return typeof config === "string"
    ? config
        .replace(/\/nix\/store\/[a-z0-9]+-terminfo-linux-runner\/index\.js/g, "<terminfo-linux-runner>")
        .replace(/(--listen-on[ =]unix:)\S+/g, "$1<socket>")
        // Only the kind positions of an actual reviewed context key are historical vocabulary.
        .replace(/^(app|headless):([^@]+)@\["\1",/, (_prefix, kind: string, id: string) => {
          const canonical = kind === "app" ? "term" : "lib"
          return `${canonical}:${id}@["${canonical}",`
        })
    : config
}

const contextKey = (t: ProbeSubject): string =>
  JSON.stringify([
    t.kind,
    t.id,
    t.os,
    t.osVersion,
    t.outerTerminal,
    t.mux,
    maskRunnerStorePath(t.config),
    t.permissions,
  ])

/**
 * Distinct contexts per `<kind>:<id>` across the given runs: the group size `projectedContextKey` keys by.
 * Count over EVERY run the corpus holds for the target, legacy and current, and pass the one result to
 * both projections; a projection counting its own runs keys one context two ways (30661).
 */
export function countContexts(runs: readonly Pick<LoadedRun, "subject">[]): Map<string, Set<string>> {
  const counts = new Map<string, Set<string>>()
  for (const run of runs) {
    const stem = `${run.subject.kind}:${run.subject.id}`
    const contexts = counts.get(stem) ?? new Set<string>()
    contexts.add(contextKey(run.subject))
    counts.set(stem, contexts)
  }
  return counts
}

/**
 * The key one run's context carries in the projection: the bare `<kind>:<id>` while its group has ONE
 * context, and `<kind>:<id>@<context>` once the group carries more, so a multi-context tie never hides
 * behind an id-level key. The group spans every run of the target, legacy and current, so one context
 * carries one key in `contexts` and in historical groups (30661). Tests build fixtures through
 * this function, never a hand-copied shape.
 */
export function projectedContextKey(subject: ProbeSubject, contextCount: number): string {
  const stem = `${subject.kind}:${subject.id}`
  return contextCount === 1 ? stem : `${stem}@${contextKey(subject)}`
}

/**
 * The admitted context key of every accepted subject, from the projection's own `versions`: the map a working input
 * is keyed through, so a working run never renames an admitted key.
 */
export function admittedContextKeys(
  versions: Readonly<Record<string, readonly Pick<CurrentSelectedVersion, "subject">[]>>,
): Map<string, string> {
  return new Map(
    Object.entries(versions).flatMap(([key, rows]) =>
      rows.map((version) => [contextKey(version.subject), key] as const),
    ),
  )
}

/**
 * The context key a WORKING (unadmitted) run takes: an admitted subject keeps its admitted key, and a working-only
 * context takes the existing qualified form (the multi-context branch), even when it is the only working context for
 * its target. The composed view and the preview's hourly raw view both key working runs through this one rule.
 */
export function workingSubjectKey(admitted: ReadonlyMap<string, string>, subject: ProbeSubject): string {
  return admitted.get(contextKey(subject)) ?? projectedContextKey(subject, 2)
}

/** The one app-version order: the projection's baseline choice and the site's context pick both use it. */
export const versionCompare = (a: string, b: string): number => a.localeCompare(b, undefined, { numeric: true })

interface SupplementInput {
  run: ProjectionRun
  supplement: ContextSupplement
  /** The default context's projected key: the only context this supplement may read into. */
  contextKey: string
}

/**
 * Read current execution results without applying later feature interpretations or grading.
 * `archivedExclusions` are the frozen refusals of legacy runs (#30759 AC3); they lead the published
 * list, and refusals this reading assesses for schema-3 or schema-4 runs are appended after them.
 */
export function projectResults(
  inputRuns: readonly (LoadedRun | ProjectionRun)[],
  catalogIds: readonly string[],
  policy: {
    currentProbeHash: string
    textSnapshots?: ReadonlyMap<string, Uint8Array>
    workingRuns?: readonly LoadedRun[]
    workingAttempts?: readonly SelectedAttemptInput[]
    log?: (line: string) => void
    /** Cells whose grade a ruling withdrew (content/reopened-cells.json); loadSelectedResults always passes them. */
    reopened?: readonly ReopenedCell[]
    /** Open cells reviewed as untestable (content/declared-untestable.json); loadSelectedResults always passes them. */
    declared?: readonly DeclaredUntestableCell[]
    /** Declared derived-Unsupported pairs; absent means the one table, DERIVED_UNSUPPORTED (#33019). */
    derived?: readonly DerivedPair[]
  },
  archivedExclusions: readonly SelectedExclusion[],
): SelectedProjection {
  const runs = inputRuns.map(projectionRun)
  if (!nonempty(policy.currentProbeHash)) throw new Error("currentProbeHash is required")
  checkReopenedWitnesses(policy.reopened ?? [], runs)
  // 30661: the context count is per target across every run the projection read, so a context key is
  // qualified exactly as the runs measured it rather than as whichever runs are current today.
  // 33119: a context supplement is never a context, so it is set aside before any context is counted or keyed.
  const supplementRuns = runs.filter((run) => supplementOf(run.subject) !== undefined)
  const contextRuns = runs.filter((run) => supplementOf(run.subject) === undefined)
  // #33151: a Linux mux run is the launcher's default config or a declared supplement; any third config would read as
  // a default context, so it is refused by name.
  for (const run of contextRuns) {
    const { kind, id, os, config } = run.subject
    if (kind === "mux" && os === "linux" && config !== MUX_DEFAULT_CONFIG) {
      throw new Error(
        `${run.runId}: mux ${id} records config ${JSON.stringify(config)}, which is neither the default ${MUX_DEFAULT_CONFIG} nor a declared context supplement`,
      )
    }
  }
  const contexts = countContexts(contextRuns)
  const currentRuns = contextRuns.filter((run) => run.schemaVersion === 3 || run.schemaVersion === 4)
  const ids = new Set<string>()
  for (const run of runs) {
    if (ids.has(run.runId)) throw new Error(`duplicate runId ${run.runId}`)
    ids.add(run.runId)
  }
  const projection: SelectedProjection = {
    contexts: {},
    versions: {},
    history: {},
    workingOriginals: {},
    table: {},
    exclusions: archivedExclusions.map((row) => ({ ...row })),
    treeSuiteId: policy.currentProbeHash,
  }
  const table: Record<string, Record<string, ProbeStatus>> = {}
  const acceptedRuns: ProjectionRun[] = []
  const baselineRunIds: string[] = []
  const historyVersion = (run: ProjectionRun, recordTable = true): CurrentSelectedVersion => {
    if (!run.results || !run.catalogIds || !run.probeHash || !run.sourceRevision) {
      throw new Error(`Current run ${run.runId} lacks its sealed execution contract`)
    }
    const results = run.results
    const aggregate = aggregateCurrentResults(results, run.catalogIds)
    const counts = aggregate.counts
    const states = Object.fromEntries(results.map((result) => [result.featureId, result.status]))
    if (recordTable) table[run.runId] = states
    const { suiteRelation, suiteFreshness } = suiteRelationOf(run.probeHash, policy.currentProbeHash)
    const version: CurrentSelectedVersion = {
      schemaVersion: run.schemaVersion as 3 | 4,
      ...(run.schemaVersion === 4 ? { source: run.source } : {}),
      runId: run.runId,
      subject: run.subject,
      measuredAt: run.measuredAt,
      suiteId: run.suiteId,
      probeHash: run.probeHash,
      sourceRevision: run.sourceRevision,
      sha256: run.sha256,
      catalogIds: [...run.catalogIds],
      // Preserve the parser's result objects: its private historical facts are keyed by identity.
      results,
      suiteRelation,
      selection: run.selection,
      screenRecord: run.screenRecord,
      readRaw: run.readRaw,
      ...(run.traceMemo && { traceMemo: run.traceMemo }),
      suiteFreshness,
      counts,
      // D132 B (#30917): numerator and denominator come from the ONE fold, so both cover the same
      // graded ids (264 for a current 273-row run). Never recompute either from the raw catalogue.
      score: { supported: aggregate.supported, all: aggregate.denominator },
      complete: aggregate.complete,
    }
    return version
  }
  for (const run of currentRuns) {
    const version = historyVersion(run)
    const stem = `${run.subject.kind}:${run.subject.id}`
    const key = projectedContextKey(run.subject, contexts.get(stem)?.size ?? 0)
    ;(projection.history[key] ??= []).push(version)
    acceptedRuns.push(run)
    ;(projection.versions[key] ??= []).push(version)
  }
  // A supplement joins its default context's history (so its cell's origin resolves) and the per-run table, never
  // `versions` or the context count. Without exactly one default context to supplement, it fills nothing.
  const supplements: SupplementInput[] = []
  for (const run of supplementRuns) {
    const supplement = supplementOf(run.subject)
    if (!supplement || run.schemaVersion !== 4) continue
    const defaults = [
      ...new Set(
        acceptedRuns
          .filter((candidate) => isDefaultOf(candidate.subject, run.subject))
          .map((candidate) =>
            projectedContextKey(
              candidate.subject,
              contexts.get(`${candidate.subject.kind}:${candidate.subject.id}`)?.size ?? 0,
            ),
          ),
      ),
    ]
    const [key] = defaults
    if (defaults.length !== 1 || !key) {
      policy.log?.(
        `supplement ${run.runId} (${supplement.name}) has ${defaults.length} default contexts; it fills nothing`,
      )
      continue
    }
    ;(projection.history[key] ??= []).push(historyVersion(run))
    supplements.push({ run, supplement, contextKey: key })
  }
  const rank = (version: CurrentSelectedVersion): number => (version.suiteRelation === "tree" ? 1 : 0)
  for (const [key, versions] of Object.entries(projection.versions)) {
    versions.sort(
      (a, b) =>
        versionCompare(b.subject.version, a.subject.version) ||
        rank(b) - rank(a) ||
        Date.parse(b.measuredAt) - Date.parse(a.measuredAt) ||
        b.runId.localeCompare(a.runId),
    )
    // Original versions retain their display order. Only an explicit historical baseline supplies
    // untouched cells; selected attempts are folded independently by their recorded start below.
    const baseline = versions.find((version) => version.selection === undefined)
    if (baseline) baselineRunIds.push(baseline.runId)
    const unique = versions.filter(
      (version, index) => versions.findIndex((entry) => entry.subject.version === version.subject.version) === index,
    )
    projection.versions[key] = unique
  }
  const admitted = admittedContextKeys(projection.versions)
  const workingRuns = (policy.workingRuns ?? []).map(projectionRun)
  for (const run of workingRuns) {
    // A working run keeps its admitted subject's key, so its original resolves under the same context
    // the composed row cites. It never enters `table`, `versions` or `history`.
    const key = workingSubjectKey(admitted, run.subject)
    ;(projection.workingOriginals[key] ??= []).push(historyVersion(run, false))
  }
  return {
    ...projection,
    table,
    contexts: composeContextSummaries(
      acceptedRuns,
      baselineRunIds,
      workingRuns,
      policy.workingAttempts ?? [],
      catalogIds,
      admitted,
      policy.log,
      supplements,
      policy.reopened ?? [],
      policy.derived ?? DERIVED_UNSUPPORTED,
      policy.declared ?? [],
    ),
  }
}

/** Every witness of a reopened row is a run the projection read, citing the row's feature at that assertion index. */
function checkReopenedWitnesses(rows: readonly ReopenedCell[], runs: readonly ProjectionRun[]): void {
  const byId = new Map(runs.map((run) => [run.runId, run]))
  for (const row of rows) {
    for (const { runId, assertionIndex } of row.witnesses) {
      const run = byId.get(runId)
      if (!run) throw new Error(`Reopened cell ${cellLabel(row)} cites witness run ${runId}, which is not placed`)
      const assertion = run.assertions[assertionIndex]
      if (assertion?.featureId !== row.featureId) {
        throw new Error(
          `Reopened cell ${cellLabel(row)} cites ${runId} assertion ${assertionIndex}, which is ${
            assertion ? `for ${assertion.featureId}` : "absent"
          }`,
        )
      }
    }
  }
}

/**
 * Read the reopened rows into one context's cells (#33164). A row whose cell this context grades as the row's withdrawn
 * grade reopens it: the feature result reads probe-todo with the row's words; result, run and origin stay. A
 * remeasured row whose cell is graded under a suite it does not name is stale and throws.
 */
function applyReopened(
  contextKey: string,
  cells: Record<string, SelectedContextCell>,
  subject: ProbeSubject | undefined,
  rows: readonly ReopenedCell[],
  applied: Set<ReopenedCell>,
): void {
  if (!subject) return
  for (const row of rows) {
    if (row.kind !== subject.kind || row.id !== subject.id || row.os !== subject.os) continue
    const cell = cells[row.featureId]
    const featureResult = cell?.featureResult
    if (!cell || featureResult?.status !== row.graded) continue
    if (row.exit.kind === "remeasured" && !row.exit.suiteIds.includes(cell.run.suiteId)) {
      throw new Error(
        `Reopened cell ${cellLabel(row)} is graded ${row.graded} in ${contextKey} by run ${cell.run.runId} under suite ${cell.run.suiteId}, which the row does not name; it was re-measured, so delete the row`,
      )
    }
    cells[row.featureId] = {
      ...cell,
      featureResult: { ...featureResult, status: "probe-todo", strength: null },
      reopened: { reason: row.reason, reopenedOn: row.reopenedOn, exit: row.exit.kind },
    }
    applied.add(row)
  }
}

/**
 * Read the declared-untestable rows into one context's cells (@cto 82a54984 (c), b0d3cd4e). A row covers every context
 * of its app on its OS. Its cell must read PROBE TODO: then the feature result reads untestable with the row's words,
 * and result, run and origin stay. A measured cell, a probe's own Untestable, a probe defect (PROBE INVALID, PROBE
 * CONFLICT), a reopened cell or a missing cell throws naming the row: a measured result always beats a declaration.
 */
function applyDeclared(
  contextKey: string,
  cells: Record<string, SelectedContextCell>,
  subject: ProbeSubject | undefined,
  rows: readonly DeclaredUntestableCell[],
  applied: Set<DeclaredUntestableCell>,
  log?: (line: string) => void,
): void {
  if (!subject) return
  for (const row of rows) {
    if (row.kind !== subject.kind || row.id !== subject.id || row.os !== subject.os) continue
    const cell = cells[row.featureId]
    const featureResult = cell?.featureResult
    const status = cell?.reopened ? "reopened" : (featureResult?.status ?? "missing")
    if (!cell || !featureResult || status !== "probe-todo") {
      throw new Error(
        `Declared-untestable cell ${cellLabel(row)} reads ${status} in ${contextKey}${
          cell ? ` (run ${cell.run.runId})` : ""
        }; a probe result beats a declaration, so ${REMOVE_DECLARED_ROW}`,
      )
    }
    cells[row.featureId] = {
      ...cell,
      featureResult: { ...featureResult, status: "untestable", strength: null },
      declared: { reason: row.reason, testableIf: row.testableIf, reviewedOn: row.reviewedOn },
    }
    applied.add(row)
    log?.(`declared untestable by review: ${contextKey}/${row.featureId} (row ${cellLabel(row)})`)
  }
}

/** One composition within projectResults; all immutable public run objects remain separate. */
function compareContextAttempts(
  a: Pick<SelectedContextAttempt, "runId" | "attempt">,
  b: Pick<SelectedContextAttempt, "runId" | "attempt">,
): number {
  const left = a.attempt?.startedAt
  const right = b.attempt?.startedAt
  if (left === undefined || right === undefined) {
    return left === right ? a.runId.localeCompare(b.runId) : left === undefined ? 1 : -1
  }
  return Date.parse(left) - Date.parse(right) || a.runId.localeCompare(b.runId)
}

/**
 * The one suite comparison: a run on the tree's probe hash is "tree", any other is "older". Its label
 * (`older suite <hash>`) is what the site shows and what the selection file carries (33109).
 */
export function suiteRelationOf(
  probeHash: string,
  treeSuiteId: string,
): { suiteRelation: SuiteRelation; suiteFreshness: string } {
  const suiteRelation: SuiteRelation = probeHash === treeSuiteId ? "tree" : "older"
  return { suiteRelation, suiteFreshness: `${suiteRelation} suite ${probeHash}` }
}

/** Resolve one immutable original within its canonical context; working inputs stay private. */
export function originalRunFor<T extends Pick<CurrentSelectedVersion, "runId">>(
  projection: {
    history: Readonly<Record<string, readonly T[]>>
    workingOriginals?: Readonly<Record<string, readonly T[]>>
  },
  contextKey: string,
  runId: string,
): T {
  const run =
    projection.history[contextKey]?.find((original) => original.runId === runId) ??
    projection.workingOriginals?.[contextKey]?.find((original) => original.runId === runId)
  if (!run) {
    throw new Error(
      `Context ${contextKey} names missing original run ${runId}: it is in neither the admitted history nor this read's working inputs`,
    )
  }
  return run
}

function composeContextSummaries(
  acceptedRuns: readonly ProjectionRun[],
  baselineRunIds: readonly string[],
  workingRuns: readonly ProjectionRun[],
  workingAttempts: readonly SelectedAttemptInput[],
  catalogIds: readonly string[],
  contextKeys: ReadonlyMap<string, string>,
  log?: (line: string) => void,
  supplements: readonly SupplementInput[] = [],
  reopened: readonly ReopenedCell[] = [],
  derivedPairs: readonly DerivedPair[] = DERIVED_UNSUPPORTED,
  declared: readonly DeclaredUntestableCell[] = [],
): Record<string, SelectedContextSummary> {
  const reopenedApplied = new Set<ReopenedCell>()
  const declaredApplied = new Set<DeclaredUntestableCell>()
  const runsById = new Map<string, ProjectionRun>()
  for (const run of [...acceptedRuns, ...workingRuns]) {
    // A pass may cite its original draft and its sealed admitted snapshot: one run, different
    // envelopes. Keep the admitted immutable owner; both input paths remain report evidence.
    if (!runsById.has(run.runId)) runsById.set(run.runId, run)
  }
  const runs = [...runsById.values()]
  const heldWitnesses = supportedSuites(runs, HELD_NEGATIVES)
  const baselineIds = new Set(baselineRunIds)
  const workingIds = new Set(workingRuns.map((run) => run.runId))
  // Working inputs cannot rename an admitted key; see workingSubjectKey.
  const keyFor = (run: ProjectionRun): string => workingSubjectKey(contextKeys, run.subject)
  const groups = new Map<string, ProjectionRun[]>()
  for (const run of runs) {
    const key = keyFor(run)
    groups.set(key, [...(groups.get(key) ?? []), run])
  }
  const attemptsByContext = new Map<string, SelectedAttemptInput[]>()
  for (const input of workingAttempts) {
    const declared = input.context
    const matches = [...groups].filter(([, candidates]) =>
      candidates.some((run) => {
        if (run.subject.kind !== declared.kind || run.subject.id !== declared.terminalId) return false
        if (declared.kind !== "lib" && run.subject.os !== declared.os) return false
        return Object.entries(input.intendedSubject).every(
          ([key, value]) => value === undefined || run.subject[key as keyof ProbeSubject] === value,
        )
      }),
    )
    const explicit = matches.filter(([, candidates]) => candidates.some((run) => workingIds.has(run.runId)))
    const candidates = explicit.length > 0 ? explicit : matches
    // Unmeasured or ambiguous configurations retain the declared context; no subject is invented.
    const [only] = candidates
    const key = candidates.length === 1 && only ? only[0] : declared.context
    if (!groups.has(key)) groups.set(key, [])
    attemptsByContext.set(key, [...(attemptsByContext.get(key) ?? []), input])
  }
  const summaries: Record<string, SelectedContextSummary> = {}
  for (const [contextKey, candidates] of groups) {
    const cells: Record<string, SelectedContextCell> = {}
    const ids = [...new Set(candidates.flatMap((run) => run.catalogIds ?? []))]
    // No measured run exists for a pre-start refusal: the explicit catalogue remains visible as
    // missingIds/TODO counts, without manufacturing ProbeResult or subject records.
    const viewIds = ids.length ? ids : [...catalogIds]
    const chosenBaselines = candidates.filter((run) => baselineIds.has(run.runId))
    const baselines = [
      // Keep independent methods from the chosen subject version, with its preferred baseline last.
      ...candidates
        .filter(
          (run) =>
            !baselineIds.has(run.runId) &&
            !workingIds.has(run.runId) &&
            run.selection === undefined &&
            chosenBaselines.some((baseline) => baseline.subject.version === run.subject.version),
        )
        .sort((a, b) => Date.parse(a.measuredAt) - Date.parse(b.measuredAt) || a.runId.localeCompare(b.runId)),
      ...chosenBaselines,
      ...candidates.filter((run) => workingIds.has(run.runId) && run.selection === undefined),
    ]
    const currentMethods = new Map<
      string,
      {
        version: string
        suite: string | null
        probes: Map<ProbeMethod | null, { run: ProjectionRun; result: ProbeResult }>
      }
    >()
    const decided = new Set<FeatureResultStatus>(["supported", "unsupported", "untestable"])
    const keptStreak = new Map<string, number>()
    let keptCount = 0
    const keptDecidedCell = (run: ProjectionRun, result: ProbeResult): boolean => {
      if (!isHarnessOutcome(result.harnessOutcome)) {
        keptStreak.delete(result.featureId)
        return false
      }
      const prior = cells[result.featureId]
      const priorStatus = prior?.featureResult?.status ?? prior?.result.status
      const sameProbe =
        prior !== undefined &&
        prior.run.subject.version === run.subject.version &&
        prior.run.probeHash === run.probeHash
      if (!prior || !sameProbe || priorStatus === undefined || !decided.has(priorStatus)) {
        if (prior && !sameProbe) {
          log?.(
            `placed ${run.subject.id} ${result.featureId} harness ${result.harnessOutcome} because the probe changed`,
          )
        }
        keptStreak.delete(result.featureId)
        return false
      }
      const streak = (keptStreak.get(result.featureId) ?? 0) + 1
      keptStreak.set(result.featureId, streak)
      keptCount += 1
      log?.(
        `kept ${run.subject.id} ${result.featureId} ${priorStatus} refused ${result.harnessOutcome} from ${run.runId} streak ${streak}${streak >= 3 ? " needs its own issue" : ""}`,
      )
      return true
    }
    const remember = (run: ProjectionRun, result: ProbeResult): void => {
      const classification = classifyResultMethod(result, run.subject, run.assertions)
      const method = classification.kind === "method" ? classification.method : null
      const prior = currentMethods.get(result.featureId)
      // Unmapped/open attempts, subject-version changes and new suites replace historical methods.
      const probes =
        prior?.version === run.subject.version &&
        prior.suite === run.probeHash &&
        method !== null &&
        !prior.probes.has(null)
          ? prior.probes
          : new Map<ProbeMethod | null, { run: ProjectionRun; result: ProbeResult }>()
      probes.set(method, { run, result })
      currentMethods.set(result.featureId, { version: run.subject.version, suite: run.probeHash, probes })
      const currentProbes = [...probes].map(([probeMethod, probe]) => ({
        ...probe,
        probeId: `${result.featureId}:${probeMethod ?? "unobserved"}`,
        method: probeMethod,
      }))
      const featureResult = computeFeatureResults(
        currentProbes.map((probe) => ({
          featureId: result.featureId,
          probeId: probe.probeId,
          method: probe.method,
          status: probe.result.status,
        })),
        [result.featureId],
      )[result.featureId]
      const representative = featureResult?.probeId
        ? currentProbes.find((probe) => probe.probeId === featureResult.probeId)
        : { run, result }
      if (!representative) {
        throw new Error(`Feature ${result.featureId} selects missing current probe ${featureResult?.probeId}`)
      }
      cells[result.featureId] = {
        origin: { runId: representative.run.runId, resultId: result.featureId },
        run: representative.run,
        result: representative.result,
        ...(featureResult && { featureResult }),
      }
    }
    for (const run of baselines) {
      if (!run.results) throw new Error(`Run ${run.runId} has no stored current results`)
      for (const result of run.results) remember(run, result)
    }
    const selected = candidates.flatMap((run) => {
      const selection = run.selection
      return selection ? [{ runId: run.runId, run, selection, attempt: run.attempt }] : []
    })
    selected.sort(compareContextAttempts)
    const attempts: SelectedContextAttempt[] = []
    for (const { run, selection, attempt } of selected) {
      if (!run.results) throw new Error(`Run ${run.runId} has no stored current results`)
      const results = run.results
      // A real initialized TODO is useful missing-evidence data when no prior cell exists; it
      // never replaces a prior cell and never becomes an emitted measurement.
      for (const result of results) {
        if (!cells[result.featureId] && result.attempt.scope === "none") remember(run, result)
      }
      const emitted = new Map(results.filter((result) => result.attempt.scope !== "none").map((r) => [r.featureId, r]))
      const noOutputIds: string[] = []
      for (const id of selection.ids) {
        const result = emitted.get(id)
        if (!result || attempt?.startedAt === undefined) noOutputIds.push(id)
        else if (keptDecidedCell(run, result)) continue
        else remember(run, result)
      }
      attempts.push({ runId: run.runId, path: run.path, selection, attempt, noOutputIds })
    }
    for (const input of attemptsByContext.get(contextKey) ?? []) {
      if (attempts.some((attempt) => attempt.runId === input.runId)) continue
      const selection = readCollectorSelection(input.rawReplies)
      if (selection) {
        attempts.push({
          runId: input.runId,
          path: input.path,
          selection,
          attempt: readCollectorAttempt(input.rawReplies),
          noOutputIds: [...selection.ids],
        })
      }
    }
    attempts.sort(compareContextAttempts)
    const supplementFilled = applySupplements(
      cells,
      supplements.filter((input) => input.contextKey === contextKey),
      decided,
    )
    applyReopened(contextKey, cells, candidates[0]?.subject, reopened, reopenedApplied)
    // After reopening, so a reopened cell refuses a declaration; before derivation, so a declared parent derives nothing.
    applyDeclared(contextKey, cells, candidates[0]?.subject, declared, declaredApplied, log)
    // Before derivation, so a held child can still read its parent's refusal (#33034, @cto edab7573).
    applyHeld(cells, HELD_NEGATIVES, heldWitnesses)
    // After reopening and holding, before derivation, so a demoted parent derives nothing (#33665, @cto fccc41a9).
    // Placed runs only: a working run is never an outer reading (@cto 0f1274ed condition 4).
    const outerAbsentRefusals = applyOuterAbsent(contextKey, cells, acceptedRuns)
    for (const refusal of outerAbsentRefusals) log?.(refusal)
    // After reopening, so a reopened parent reads probe-todo and entails nothing (#33019, @cto 6588ac5f).
    const derivedIds = applyDerived(contextKey, cells, derivedPairs)
    const contributing = new Set(
      [...currentMethods.values()].flatMap(({ probes }) => [...probes.values()].map(({ run }) => run.runId)),
    )
    const sourceOrder = [...baselines, ...selected.map((entry) => entry.run), ...candidates]
    const contributingRunIds = [
      ...[...new Set(sourceOrder.map((run) => run.runId))].filter((id) => contributing.has(id)),
      ...supplementFilled,
    ]
    if (keptCount > 0) log?.(`kept ${keptCount} row(s) for ${contextKey}`)
    const missingIds = viewIds.filter((id) => !cells[id])
    const aggregate = aggregateCurrentResults(
      // Environment groups have retained run metadata but no computed feature result.
      viewIds.map((featureId) => ({
        featureId,
        status: cells[featureId]?.featureResult?.status ?? cells[featureId]?.result.status ?? "probe-todo",
        ...(cells[featureId]?.derived && { derived: cells[featureId]?.derived }),
        ...(cells[featureId]?.declared && { declared: cells[featureId]?.declared }),
      })),
      viewIds,
    )
    summaries[contextKey] = {
      contextKey,
      ...(candidates[0] && {
        subject: {
          kind: candidates[0].subject.kind,
          id: candidates[0].subject.id,
          os: candidates[0].subject.os,
          osVersion: candidates[0].subject.osVersion,
          outerTerminal: candidates[0].subject.outerTerminal,
          mux: candidates[0].subject.mux,
          config: maskRunnerStorePath(candidates[0].subject.config),
          permissions: candidates[0].subject.permissions,
        },
      }),
      catalogIds: viewIds,
      cells,
      missingIds,
      contributingRunIds,
      attempts,
      counts: aggregate.counts,
      derivedIds,
      score: { supported: aggregate.supported, all: aggregate.denominator },
      complete: aggregate.complete,
      ...(outerAbsentRefusals.length > 0 && { outerAbsentRefusals }),
    }
  }
  // No silent no-match: a row that reopened nothing names a cell no context grades that way any more.
  const unmatched = reopened.filter((row) => !reopenedApplied.has(row))
  if (unmatched.length > 0) {
    throw new Error(
      `${unmatched.length} reopened row(s) match no context cell graded as withdrawn; delete or re-confirm: ${unmatched
        .map((row) => `${cellLabel(row)} (${row.graded})`)
        .join(", ")}`,
    )
  }
  const undeclared = declared.filter((row) => !declaredApplied.has(row))
  if (undeclared.length > 0) {
    throw new Error(
      `${undeclared.length} declared-untestable row(s) match no context cell: ${undeclared
        .map((row) => cellLabel(row))
        .join(", ")}; ${REMOVE_DECLARED_ROW}`,
    )
  }
  return summaries
}

/**
 * Read a default context's supplements into its open cells, for their declared ids only (33119, @cto f7b7afb2). The
 * newest supplement run that emitted an id answers it, and only when that run's subject version is the open cell's.
 * A decided default cell is never touched. Returns the run ids that filled a cell, in fill order.
 */
function applySupplements(
  cells: Record<string, SelectedContextCell>,
  supplements: readonly SupplementInput[],
  decided: ReadonlySet<string>,
): string[] {
  const filled: string[] = []
  const newestFirst = [...supplements].sort(
    (a, b) => Date.parse(b.run.measuredAt) - Date.parse(a.run.measuredAt) || b.run.runId.localeCompare(a.run.runId),
  )
  const ids = [...new Set(newestFirst.flatMap(({ supplement }) => supplement.featureIds))]
  for (const id of ids) {
    const prior = cells[id]
    const priorStatus = prior?.featureResult?.status ?? prior?.result.status
    const priorDecided = priorStatus !== undefined && decided.has(priorStatus)
    if (
      priorDecided &&
      !newestFirst.some(({ supplement }) => supplement.notesDecided && supplement.featureIds.includes(id))
    ) {
      continue
    }
    const source = newestFirst.find(
      ({ run, supplement }) =>
        supplement.featureIds.includes(id) &&
        (prior === undefined || run.subject.version === prior.run.subject.version) &&
        run.results?.some((result) => result.featureId === id && result.attempt.scope !== "none"),
    )
    const result = source?.run.results?.find((entry) => entry.featureId === id)
    if (!source || !result) continue
    const { run, supplement } = source
    const ignoresInSilence = supplement.silentIgnore.includes(run.subject.id)
    // A non-mux no-reply publishes probe-invalid (probe-defs extensions.ts, `no-response`). On an app that may ignore
    // the setting without a word, that is the very case `notInForce` names, so it reaches the branch below (33324).
    if (!decided.has(result.status) && !(ignoresInSilence && result.status === "probe-invalid" && !priorDecided)) {
      continue
    }
    const declaredDefault = supplement.declaredDefaults[run.subject.id]
    const marker = {
      name: supplement.name,
      qualifier: supplement.qualifier,
      runId: run.runId,
      ...(declaredDefault && { declaredDefault }),
    }
    if (priorDecided && !(prior && supplement.notesDecided && priorStatus === "untestable")) {
      // A decided default cell keeps its status, reason and tests: the supplement's decided status is a note only.
      if (prior && supplement.notesDecided) {
        cells[id] = { ...prior, supplement: { ...marker, filled: false, noted: result.status } }
      }
      continue
    }
    // The one decided status a supplement may replace is Untestable: it is a statement about the config the default
    // run measured (the default tmux config forwards no title), so a run under a declared config that can decide the
    // row is the deciding observation, not a note (#32593, @cto 2026-11-12 (a)). It still takes a supplement that
    // declares notesDecided, and only its own declared ids, so no other decided row moves.
    if (result.status !== "supported" && ignoresInSilence) {
      // No reply under a setting the terminal may have ignored proves nothing: the default cell stays open. A
      // schema-4 default run records every catalog id, so a prior cell is present; were one absent, there is no cell
      // to mark and the id stays absent, which every reader already reads as probe-todo (statesFor).
      if (prior) cells[id] = { ...prior, supplement: { ...marker, filled: false, open: supplement.notInForce } }
      continue
    }
    // The same one-probe fold remember() uses, so every consumer reads the filled cell as it reads any other.
    const classification = classifyResultMethod(result, run.subject, run.assertions)
    const method = classification.kind === "method" ? classification.method : null
    const featureResult = computeFeatureResults(
      [{ featureId: id, probeId: `${id}:${method ?? "unobserved"}`, method, status: result.status }],
      [id],
    )[id]
    cells[id] = {
      origin: { runId: run.runId, resultId: id },
      run,
      result,
      ...(featureResult && { featureResult }),
      supplement: { ...marker, filled: true },
    }
    if (!filled.includes(run.runId)) filled.push(run.runId)
  }
  return filled
}

export function statesFor(
  projection: SelectedProjection,
  contextKey: string,
): Readonly<Record<string, FeatureResultStatus>> {
  const context = projection.contexts[contextKey]
  if (!context) throw new Error(`The projection classified no context ${contextKey}`)
  return Object.fromEntries(
    context.catalogIds.map((id) => [
      id,
      context.cells[id]?.featureResult?.status ?? context.cells[id]?.result.status ?? "probe-todo",
    ]),
  )
}

/**
 * Read only the exact bytes named by a digest-backed artifact reference, checked as its kind. The
 * kind table and the check are admission's own (`verifyRetainedArtifact`), so the site accepts
 * exactly what admission would place and no second PNG or UTF-8 check can drift from it.
 */
export function readVerifiedArtifact(
  contentDir: string,
  ref: string,
  sourcePath: string,
  kind: RetainedArtifactKind = "screenshot",
): Buffer {
  const rules = RETAINED_ARTIFACT_KINDS[kind]
  if (!/^sha256:[a-f0-9]{64}$/.test(ref)) fail(sourcePath, `invalid ${kind}Ref ${ref}`)
  const digest = ref.slice("sha256:".length)
  const artifactPath = join(contentDir, "artifacts", `${digest}.${rules.extension}`)
  if (!existsSync(artifactPath)) fail(sourcePath, `missing ${rules.noun.toLowerCase()} artifact ${artifactPath}`)
  const bytes = readFileSync(artifactPath)
  try {
    verifyRetainedArtifact(kind, bytes, ref, artifactPath)
  } catch (error) {
    fail(sourcePath, error instanceof Error ? error.message : String(error))
  }
  return bytes
}

/** Validate all referenced screenshots; the accepted artifactDir option has no write side effect. */
const ARCHIVED_EXCLUSIONS_FILE = "archived-exclusions.json"

/**
 * The archived admission refusals of legacy runs, carried as data (#30759 AC3, @cto 2026-10-23).
 *
 * The historical projection that assessed these runs is gone, so these rows are frozen facts, not a
 * re-assessment: their order and duplicates are exactly what that reader emitted, and the published
 * list is these rows followed by whatever the current reading refuses. Regenerating them would need
 * the reader this migration removed. A missing row, a malformed row or a path escaping the content
 * root is a loud failure: the list is published (api/v3 `exclusions`, the admin report), where an
 * empty list would read as "nothing was excluded".
 */
export function loadArchivedExclusions(contentDir: string): SelectedExclusion[] {
  const path = join(contentDir, ARCHIVED_EXCLUSIONS_FILE)
  if (!existsSync(path)) fail(path, "missing archived exclusions")
  const parsed = parseJsonStrict(path, readFileSync(path, "utf8"))
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    fail(path, "expected an object with archivedExclusions")
  }
  const rows = (parsed as Record<string, unknown>).archivedExclusions
  // An empty list is a real state (a corpus with no archived refusals); a missing FILE is not, since
  // that would silently publish "nothing was excluded" for a corpus that has them.
  if (!Array.isArray(rows)) fail(path, "archivedExclusions must be an array")
  return rows.map((value, index) => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      fail(path, `row ${index} is not an object`)
    }
    const { runId, path: runPath, reason } = value as Record<string, unknown>
    if (!nonempty(runId) || !nonempty(reason)) fail(path, `row ${index} requires runId and reason`)
    if (!nonempty(runPath) || isAbsolute(runPath) || runPath.split(/[\\/]/).includes("..")) {
      fail(path, `row ${index} path must be relative to the content root`)
    }
    return { runId, path: join(contentDir, runPath), reason }
  })
}

export function loadSelectedResults(
  contentDir: string,
  currentProbeHash: string,
  options: {
    artifactDir?: string
    workingRuns?: readonly LoadedRun[]
    workingAttempts?: readonly SelectedAttemptInput[]
  } = {},
): SelectedProjection {
  const featuresPath = join(contentDir, "features.json")
  if (!existsSync(featuresPath)) fail(featuresPath, "missing required catalog")
  const features = loadFeatures(contentDir)
  const catalog = Object.keys(features)
  const runs = loadStoredRuns(contentDir, catalog, (run, readRaw): ProjectionRun => ({
    ...compactRun(run, readRaw),
    traceMemo: {},
  }))
  const verifiedArtifacts = new Set<string>()
  const textSnapshots = new Map<string, Uint8Array>()
  for (const run of runs) {
    for (const ref of run.screenshotRefs) {
      if (verifiedArtifacts.has(`screenshot:${ref}`)) continue
      readVerifiedArtifact(contentDir, ref, run.path, "screenshot")
      verifiedArtifacts.add(`screenshot:${ref}`)
    }
    for (const ref of run.textSnapshotRefs ?? []) {
      if (verifiedArtifacts.has(`text-snapshot:${ref}`)) continue
      textSnapshots.set(ref, readVerifiedArtifact(contentDir, ref, run.path, "text-snapshot"))
      verifiedArtifacts.add(`text-snapshot:${ref}`)
    }
  }
  return projectResults(
    runs,
    catalog,
    {
      currentProbeHash,
      textSnapshots,
      workingRuns: options.workingRuns,
      workingAttempts: options.workingAttempts,
      log: (line) => console.log(line),
      reopened: loadReopenedCells(contentDir, features),
      declared: loadDeclaredUntestable(contentDir),
    },
    loadArchivedExclusions(contentDir),
  )
}
