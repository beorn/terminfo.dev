/** Stored selection and projection for terminal observations. */
import { existsSync, readFileSync } from "node:fs"
import { isAbsolute, join } from "node:path"
import {
  aggregateCurrentResults,
  classifyResultMethod,
  computeFeatureResults,
  type FeatureResult,
  type ProbeMethod,
  type SuiteRelation,
} from "./release-scope.ts"
import { loadFeatures } from "@terminfo/catalog"
import type { CensusContext } from "./full-census.ts"
import { supplementOf, type ContextSupplement } from "./context-supplements.ts"
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
import { type LoadedRun, parseJsonStrict } from "@terminfo/run-parser"
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
    correctionId?: string
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
  /** The identity the run recorded for itself. Only its trace document publishes it. */
  identity: LoadedRun["identity"]
  catalogIds: string[]
  results: ProbeResult[]
  rawReplies: Record<string, string>
  assertions: ReadAssertion[]
  origin: RunOrigin
  textQualification?: TextQualification
  suiteRelation: SuiteRelation
  suiteFreshness: string
  counts: Record<ProbeStatus, number>
  score: { supported: number; all: number }
  complete: boolean
}

/** A private view refers to the original result and its own run, never to a synthetic capture. */
export interface SelectedContextCell {
  origin: { runId: string; resultId: string }
  run: LoadedRun
  result: ProbeResult
  /** Environment groups are retained run metadata, outside the feature-result catalogue. */
  featureResult?: FeatureResult
  /**
   * Set only when a context supplement (context-supplements.ts) read this open cell. `filled`: the cell is the
   * supplement's own result and run. `open`: the supplement gave no proof, so the default cell stays, with this reason.
   */
  supplement?: { name: string; qualifier: string; runId: string; declaredDefault?: string } & (
    | { filled: true }
    | { filled: false; open: string }
  )
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
  counts: Record<FeatureResultStatus, number>
  score: { supported: number; all: number }
  /** Completeness of the recorded cell set, not a claim that a requested attempt completed. */
  complete: boolean
}

export interface SelectedProjection {
  /** The canonical composed view for private and public consumers. */
  contexts: Record<string, SelectedContextSummary>
  versions: Record<string, CurrentSelectedVersion[]>
  history: Record<string, CurrentSelectedVersion[]>
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
 */
export function maskRunnerStorePath(config: string | null): string | null
export function maskRunnerStorePath(config: unknown): unknown
export function maskRunnerStorePath(config: unknown): unknown {
  return typeof config === "string"
    ? config
        .replace(/\/nix\/store\/[a-z0-9]+-terminfo-linux-runner\/index\.js/g, "<terminfo-linux-runner>")
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
export function countContexts(runs: readonly LoadedRun[]): Map<string, Set<string>> {
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

const versionCompare = (a: string, b: string): number => a.localeCompare(b, undefined, { numeric: true })

interface SupplementInput {
  run: LoadedRun
  supplement: ContextSupplement
  /** The default context's projected key: the only context this supplement may read into. */
  contextKey: string
}

/** A default context run of the same physical terminal: same kind, id, os, host and mux, with no permissions. */
function isDefaultOf(candidate: ProbeSubject, supplement: ProbeSubject): boolean {
  return (
    candidate.permissions === null &&
    candidate.kind === supplement.kind &&
    candidate.id === supplement.id &&
    candidate.os === supplement.os &&
    candidate.osVersion === supplement.osVersion &&
    candidate.outerTerminal === supplement.outerTerminal &&
    candidate.mux === supplement.mux
  )
}

/**
 * Read current execution results without applying later feature interpretations or grading.
 * `archivedExclusions` are the frozen refusals of legacy runs (#30759 AC3); they lead the published
 * list, and refusals this reading assesses for schema-3 or schema-4 runs are appended after them.
 */
export function projectResults(
  runs: readonly LoadedRun[],
  catalogIds: readonly string[],
  policy: {
    currentProbeHash: string
    textSnapshots?: ReadonlyMap<string, Uint8Array>
    workingRuns?: readonly LoadedRun[]
    workingAttempts?: readonly SelectedAttemptInput[]
    log?: (line: string) => void
  },
  archivedExclusions: readonly SelectedExclusion[],
): SelectedProjection {
  if (!nonempty(policy.currentProbeHash)) throw new Error("currentProbeHash is required")
  // 30661: the context count is per target across every run the projection read, so a context key is
  // qualified exactly as the runs measured it rather than as whichever runs are current today.
  // 33119: a context supplement is never a context, so it is set aside before any context is counted or keyed.
  const supplementRuns = runs.filter((run) => supplementOf(run.subject) !== undefined)
  const contextRuns = runs.filter((run) => supplementOf(run.subject) === undefined)
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
    table: {},
    exclusions: archivedExclusions.map((row) => ({ ...row })),
    treeSuiteId: policy.currentProbeHash,
  }
  const table: Record<string, Record<string, ProbeStatus>> = {}
  const acceptedRuns: LoadedRun[] = []
  const baselineRunIds: string[] = []
  const historyVersion = (run: LoadedRun): CurrentSelectedVersion => {
    if (!run.results || !run.catalogIds || !run.probeHash || !run.sourceRevision) {
      throw new Error(`Current run ${run.runId} lacks its sealed execution contract`)
    }
    const results = run.results
    const aggregate = aggregateCurrentResults(results, run.catalogIds)
    const counts = aggregate.counts
    const states = Object.fromEntries(results.map((result) => [result.featureId, result.status]))
    table[run.runId] = states
    const suiteRelation: SuiteRelation = run.probeHash === policy.currentProbeHash ? "tree" : "older"
    const version: CurrentSelectedVersion = {
      schemaVersion: run.schemaVersion as 3 | 4,
      ...(run.schemaVersion === 4 ? { source: { ...run.source } } : {}),
      runId: run.runId,
      subject: run.subject,
      measuredAt: run.measuredAt,
      suiteId: run.suiteId,
      probeHash: run.probeHash,
      sourceRevision: run.sourceRevision,
      sha256: run.sha256,
      identity: run.identity,
      catalogIds: [...run.catalogIds],
      // Preserve the parser's result objects: its private historical facts are keyed by identity.
      results,
      suiteRelation,
      rawReplies: { ...run.rawReplies },
      assertions: globalThis.structuredClone(run.assertions),
      origin: globalThis.structuredClone(run.origin),
      ...(run.textQualification && { textQualification: globalThis.structuredClone(run.textQualification) }),
      suiteFreshness: `${suiteRelation} suite ${run.probeHash}`,
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
    const baseline = versions.find((version) => readCollectorSelection(version.rawReplies) === undefined)
    if (baseline) baselineRunIds.push(baseline.runId)
    const unique = versions.filter(
      (version, index) => versions.findIndex((entry) => entry.subject.version === version.subject.version) === index,
    )
    projection.versions[key] = unique
  }
  return {
    ...projection,
    table,
    contexts: composeContextSummaries(
      acceptedRuns,
      baselineRunIds,
      policy.workingRuns ?? [],
      policy.workingAttempts ?? [],
      catalogIds,
      admittedContextKeys(projection.versions),
      policy.log,
      supplements,
    ),
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

/** Resolve one immutable original within its canonical context; working inputs stay private. */
export function originalRunFor<T extends Pick<CurrentSelectedVersion, "runId">>(
  projection: { history: Readonly<Record<string, readonly T[]>> },
  contextKey: string,
  runId: string,
): T {
  const run = projection.history[contextKey]?.find((original) => original.runId === runId)
  if (!run) throw new Error(`Context ${contextKey} names missing original run ${runId}`)
  return run
}

function composeContextSummaries(
  acceptedRuns: readonly LoadedRun[],
  baselineRunIds: readonly string[],
  workingRuns: readonly LoadedRun[],
  workingAttempts: readonly SelectedAttemptInput[],
  catalogIds: readonly string[],
  contextKeys: ReadonlyMap<string, string>,
  log?: (line: string) => void,
  supplements: readonly SupplementInput[] = [],
): Record<string, SelectedContextSummary> {
  const runsById = new Map<string, LoadedRun>()
  for (const run of [...acceptedRuns, ...workingRuns]) {
    // A pass may cite its original draft and its sealed admitted snapshot: one run, different
    // envelopes. Keep the admitted immutable owner; both input paths remain report evidence.
    if (!runsById.has(run.runId)) runsById.set(run.runId, run)
  }
  const runs = [...runsById.values()]
  const baselineIds = new Set(baselineRunIds)
  const workingIds = new Set(workingRuns.map((run) => run.runId))
  // Working inputs cannot rename an admitted key; see workingSubjectKey.
  const keyFor = (run: LoadedRun): string => workingSubjectKey(contextKeys, run.subject)
  const groups = new Map<string, LoadedRun[]>()
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
            readCollectorSelection(run.rawReplies) === undefined &&
            chosenBaselines.some((baseline) => baseline.subject.version === run.subject.version),
        )
        .sort((a, b) => Date.parse(a.measuredAt) - Date.parse(b.measuredAt) || a.runId.localeCompare(b.runId)),
      ...chosenBaselines,
      ...candidates.filter((run) => workingIds.has(run.runId) && readCollectorSelection(run.rawReplies) === undefined),
    ]
    const currentMethods = new Map<
      string,
      {
        version: string
        suite: string | null
        probes: Map<ProbeMethod | null, { run: LoadedRun; result: ProbeResult }>
      }
    >()
    const decided = new Set<FeatureResultStatus>(["supported", "unsupported", "untestable"])
    const keptStreak = new Map<string, number>()
    let keptCount = 0
    const keptDecidedCell = (run: LoadedRun, result: ProbeResult): boolean => {
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
    const remember = (run: LoadedRun, result: ProbeResult): void => {
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
          : new Map<ProbeMethod | null, { run: LoadedRun; result: ProbeResult }>()
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
      const selection = readCollectorSelection(run.rawReplies)
      return selection ? [{ runId: run.runId, run, selection, attempt: readCollectorAttempt(run.rawReplies) }] : []
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
      score: { supported: aggregate.supported, all: aggregate.denominator },
      complete: aggregate.complete,
    }
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
    if (priorStatus !== undefined && decided.has(priorStatus)) continue
    const source = newestFirst.find(
      ({ run, supplement }) =>
        supplement.featureIds.includes(id) &&
        (prior === undefined || run.subject.version === prior.run.subject.version) &&
        run.results?.some((result) => result.featureId === id && result.attempt.scope !== "none"),
    )
    const result = source?.run.results?.find((entry) => entry.featureId === id)
    if (!source || !result || !decided.has(result.status)) continue
    const { run, supplement } = source
    const declaredDefault = supplement.declaredDefaults[run.subject.id]
    const marker = {
      name: supplement.name,
      qualifier: supplement.qualifier,
      runId: run.runId,
      ...(declaredDefault && { declaredDefault }),
    }
    if (result.status !== "supported" && supplement.silentIgnore.includes(run.subject.id)) {
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
  const catalog = Object.keys(loadFeatures(contentDir))
  const runs = loadStoredRuns(contentDir, catalog)
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
    },
    loadArchivedExclusions(contentDir),
  )
}
