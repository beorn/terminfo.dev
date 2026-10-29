/** Reviewed selection and projection for terminal observations. */
import { existsSync, readFileSync, readdirSync } from "node:fs"
import { isAbsolute, join } from "node:path"
import { aggregateCurrentResults, treeMovedPastRelease, type SuiteRelation } from "./release-scope.ts"
import { loadFeatures } from "@terminfo/catalog"
import type { CensusContext } from "./full-census.ts"
import {
  type Interpretation,
  type ProbeResult,
  type ProbeStatus,
  type HistoricalProbeRun,
  type ObservationFrame,
  type ProbeSubject,
  type RunOrigin,
  type UngradedDiagnostic,
  type ProbeSuiteManifest,
  type TextQualification,
  finalizeProbeResult,
  type TextQualificationAssessment,
  type CollectorSelection,
  type CollectorAttempt,
  readCollectorSelection,
  readCollectorAttempt,
} from "@terminfo/probe-defs"
import { type LoadedRun, parseSuiteManifest, parseRun, parseJsonStrict } from "@terminfo/run-parser"
import {
  canConcludeObservation,
  textQualificationFailure,
  consoleHostHold,
  validateCorrectedObservation,
} from "../../packages/run-parser/src/observations.ts"
import {
  assessRunAdmission,
  RETAINED_ARTIFACT_KINDS,
  verifyRetainedArtifact,
  type IdentityAdmission,
  type RetainedArtifactKind,
} from "../../packages/admin/run-admission.ts"
import {
  activeInterpretations,
  applies,
  fail,
  hasPresentationDecision,
  nonempty,
  parseInterpretations,
  validatePresentationShape,
  validatePresentationSupersession,
} from "../../scripts/interpretations.ts"
export { parseInterpretations } from "../../scripts/interpretations.ts"

/** Public migration explanation derived from legacy booleans, never an original run note. */
export const HISTORICAL_RERUN_NOTE = "Historical result lacks retained attempt evidence; rerun required (TEST TODO)."

type ReadObservation = HistoricalProbeRun["observations"][number]
type ReadAssertion = HistoricalProbeRun["assertions"][number]
export interface SelectedCell extends ReadObservation {
  conclusive: boolean
  /** Same-run mapping failure, computed from retained evidence; absent when no assessment failed. */
  textQualificationReason?: string
  /** Why the Windows console-host rule holds this cell (#30720); the cell's note says the same. */
  consoleHostHold?: string
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
  presentation?: {
    decision: Pick<Interpretation, "id" | "reviewer" | "reason" | "sources"> & { presentsEvidence: boolean }
    original: { observation: ReadObservation; record: SelectedCell["record"] }
  }
}

export type { IdentityAdmission } from "../../packages/admin/run-admission.ts"

export interface SelectedVersion {
  schemaVersion: 1 | 2
  runId: string
  subject: ProbeSubject
  measuredAt: string
  suiteId: string
  probeHash: string | null
  suiteFreshness: string
  /** The machine fact behind `suiteFreshness`: which suite this run matched (release | tree | older | partial). */
  suiteRelation: SuiteRelation
  suite: { observed: number; expected: number | null; complete: boolean; namedNotTested: number }
  sourceRevision: string | null
  sha256: string
  /** The identity the run recorded for itself. Only its trace document publishes it. */
  identity: LoadedRun["identity"]
  identityAdmission?: IdentityAdmission
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
 * A current row is the collector's sealed result, never an observation regraded by this reader, with one
 * named exception: the Windows console-host rule (`consoleHostHeldResults`, #30720). A second exception
 * goes to @cto first.
 */
export interface CurrentSelectedVersion {
  schemaVersion: 3 | 4
  /** Recorded by schema 4; historical source absence remains absence. */
  source?: { kind: "live" }
  runId: string
  subject: ProbeSubject
  measuredAt: string
  suiteId: string
  probeHash: string
  sourceRevision: string
  sealedAt: string
  sha256: string
  /** The identity the run recorded for itself. Only its trace document publishes it. */
  identity: LoadedRun["identity"]
  catalogIds: string[]
  results: ProbeResult[]
  rawReplies: Record<string, string>
  assertions: ReadAssertion[]
  origin: RunOrigin
  textQualification?: TextQualification
  presentations: Record<
    string,
    Pick<Interpretation, "id" | "reviewer" | "reason" | "sources"> & { presentsEvidence: boolean }
  >
  identityAdmission?: IdentityAdmission
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
  counts: Record<ProbeStatus, number>
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
  releaseSuiteId: string | null
  treeSuiteId: string
  treeMovedPastRelease: boolean
}

function observationRecord(run: LoadedRun, observation: ReadObservation): SelectedCell["record"] {
  const { rawReplyRef, screenshotRef } = observation
  return {
    ...(rawReplyRef && { rawReply: run.rawReplies[rawReplyRef] }),
    assertions: run.assertions.filter((assertion) => assertion.featureId === observation.featureId),
    ...(screenshotRef && {
      screenshot: {
        url: `/artifacts/${screenshotRef.slice("sha256:".length)}.png`,
        sha256: screenshotRef.slice("sha256:".length),
      },
    }),
    ...(observation.frames && {
      // The frame's kind travels with its digest. A pixel frame also gets the .png URL the site can
      // render; a text frame does NOT, because the site's evidence cell renders every frame as an
      // <img> and its artifact inventory admits only .png. The public projection refuses a text
      // frame BY NAME until the site can render one, rather than emitting a .txt URL nobody can.
      frames: observation.frames.map((frame) => ({
        role: frame.role,
        label: frame.label,
        capturedAt: frame.capturedAt,
        kind: frame.kind ?? ("pixels" as const),
        sha256: frame.ref.slice("sha256:".length),
        ...(frame.kind === "text-cells" ? {} : { url: `/artifacts/${frame.ref.slice("sha256:".length)}.png` }),
        ...(frame.sourceRef && { sourceRef: frame.sourceRef }),
      })),
    }),
  }
}

export type { TextQualificationAssessment } from "@terminfo/probe-defs"

/**
 * #30720, @cto rulings fc63f412, 1ee8cf0b and f126327b. Under ConPTY a Windows console host (conhost.exe or
 * OpenConsole.exe) sits between the collector and the terminal. It answers every query it implements
 * itself, swallows most others and passes only a few through. It also answers the DA1 sentinel (ESC [ c)
 * that ends each probe query, and it reads input in order. So within one query's stored reply, a reply
 * before the host's DA1 is the host's, a reply after it is the terminal's, and nothing after it means the
 * terminal was never heard from. A query with no sentinel (the cursor report ESC [ 6 n) is the host's.
 *
 * A Windows app's supported or unsupported verdict from a reply counts only when every query was answered
 * after the host's DA1. Otherwise both paths hold it with the reason this returns: the current path as
 * test-todo, the historical path as inconclusive with that note. The rule reads this run alone, never
 * another OS's answer. A plain reply string (a DA or XTVERSION reply) has no sentinel either, so it is the
 * host's, or none when empty. A test-failure stays visible as the repair item it is.
 *
 * Known limit, accepted by @cto: the scope is every Windows app run, so a future Windows context whose
 * host passes queries straight through is held here (under-counted), never mislabeled. Whoever adds such
 * a context changes this scope on purpose.
 */
/** A current run's sealed results as this reader counts them: unchanged but for the console-host rule. */
export function consoleHostHeldResults(run: LoadedRun): ProbeResult[] {
  if (!run.results) throw new Error(`Run ${run.runId} has no current sealed results`)
  return run.results.map((result) => {
    const hold = consoleHostHold(run, result, result.status)
    if (hold === undefined) return result
    const { status: _sealed, ...unsealed } = result
    return finalizeProbeResult({
      ...unsealed,
      tests: [...result.tests, { id: "console-host", status: "test-todo", attempt: { scope: "none" }, reason: hold }],
      reason: hold,
    })
  })
}

function prepareRunCells(
  run: LoadedRun,
  interpretations: readonly Interpretation[],
  text: TextQualificationAssessment,
): { cells: Record<string, SelectedCell>; correctedFeatures: ReadonlySet<string> } {
  const cells: Record<string, SelectedCell> = {}
  const correctedFeatures = new Set<string>()
  for (const observation of run.observations) {
    const hold = consoleHostHold(run, observation, observation.outcome)
    cells[observation.featureId] = {
      ...observation,
      ...(run.legacy ? { note: HISTORICAL_RERUN_NOTE } : {}),
      ...(hold !== undefined && { note: hold, consoleHostHold: hold }),
      record: observationRecord(run, observation),
      conclusive: hold === undefined && canConcludeObservation(run, observation, text),
      ...(textQualificationFailure(run, observation, text) === undefined
        ? {}
        : { textQualificationReason: textQualificationFailure(run, observation, text) }),
      chain: {
        origin: run.origin,
        method: observation.assertionType,
        runId: run.runId,
        runSha256: run.sha256,
        ...(observation.rawReplyRef && { rawReplyRef: observation.rawReplyRef }),
        ...(observation.screenshotRef && { screenshotRef: observation.screenshotRef }),
      },
    }
  }
  for (const entry of interpretations) {
    if (!applies(entry, run) || !entry.observation || !entry.featureId || entry.origin === "documentation") continue
    if (entry.observation.featureId !== entry.featureId) {
      throw new Error(`interpretation ${entry.id}: observation feature mismatch`)
    }
    const recordedObservation = run.observations.find((observation) => observation.featureId === entry.featureId)
    if (!recordedObservation) {
      throw new Error(`interpretation ${entry.id}: no raw observation for ${entry.featureId}`)
    }
    let observation = entry.observation
    if (correctedFeatures.has(entry.featureId)) throw new Error(`conflicting active corrections for ${entry.featureId}`)
    correctedFeatures.add(entry.featureId)
    observation = validateCorrectedObservation(run, entry)
    const hold = consoleHostHold(run, observation, observation.outcome)
    cells[entry.featureId] = {
      ...observation,
      ...(hold !== undefined && { note: hold, consoleHostHold: hold }),
      record: observationRecord(run, observation),
      conclusive: hold === undefined && canConcludeObservation(run, observation, text),
      ...(textQualificationFailure(run, observation, text) === undefined
        ? {}
        : { textQualificationReason: textQualificationFailure(run, observation, text) }),
      chain: {
        origin: run.origin,
        method: observation.assertionType,
        runId: run.runId,
        runSha256: run.sha256,
        ...(observation.rawReplyRef && { rawReplyRef: observation.rawReplyRef }),
        ...(observation.screenshotRef && { screenshotRef: observation.screenshotRef }),
        correctionId: entry.id,
        sources: entry.sources,
      },
    }
  }
  return { cells, correctedFeatures }
}

/** Classify one parsed development run with the projection's active corrections, without admission or selection. */
export function classifyDevelopmentRun(run: LoadedRun): {
  mode: "development"
  runId: string
  states: Record<string, ProbeStatus>
} {
  if ((run.schemaVersion !== 3 && run.schemaVersion !== 4) || !run.results) {
    throw new Error(
      `Development run ${run.runId} requires current sealed recorded results; use the historical reader for old runs`,
    )
  }
  return {
    mode: "development",
    runId: run.runId,
    states: Object.fromEntries(consoleHostHeldResults(run).map((result) => [result.featureId, result.status])),
  }
}

/**
 * The frozen runner's own build hash changes with every suite (its bundle embeds the suite), so the
 * same row measured on a later suite would otherwise land in a NEW context and never supersede the run
 * it replaces (27929 D5: three xterm/linux runs differed ONLY in this path). Mask it wherever a
 * config string enters a context key — it is apparatus, not a difference in how the row was measured.
 * Exported so the reviewed `default-contexts.json` rows, which record the unmasked key from the era
 * they were reviewed in, are normalized by the SAME rule instead of needing a hand edit per collect.
 */
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
 * carries one key in `current` and in `historical.current` and a reviewed default-context row names it once (30661). `run-selection.ts` reads this shape back to tell a stale reviewed row from a
 * review that names another os; tests build fixtures through THIS function, never a hand-copied shape.
 */
export function projectedContextKey(subject: ProbeSubject, contextCount: number): string {
  const stem = `${subject.kind}:${subject.id}`
  return contextCount === 1 ? stem : `${stem}@${contextKey(subject)}`
}

/** The eight fields `projectedContextKey` writes, in its order. */
export type ProjectedContextKeyParts = readonly [
  string,
  string,
  string,
  string | null,
  string | null,
  string | null,
  string | null,
  string | null,
]

/** Read `projectedContextKey` back. A bare `<kind>:<id>` — a ONE-context group's key — parses to undefined. */
export function parseProjectedContextKey(key: string): ProjectedContextKeyParts | undefined {
  const at = key.indexOf("@[")
  if (at < 0) return undefined
  let parts: unknown
  try {
    parts = JSON.parse(key.slice(at + 1))
  } catch {
    // silent-fallback-allow: the caller refuses this key loudly, naming it and the cure; undefined
    // here is the parser's report, never a swallowed error.
    return undefined
  }
  if (!Array.isArray(parts) || parts.length !== 8 || typeof parts[2] !== "string") return undefined
  return parts as unknown as ProjectedContextKeyParts
}

/**
 * The three shapes a context key can carry, recognized in ONE place: the full `<stem>@<context>` key,
 * the bare `<kind>:<id>` stem a ONE-context group carries, and anything else — a key `projectedContextKey`
 * never wrote, which every caller refuses by name rather than skipping.
 */
export type RecognizedProjectedContextKey =
  | { shape: "full"; parts: ProjectedContextKeyParts }
  | { shape: "bare-stem" }
  | { shape: "unreadable" }

/** The stems a bare key can name: exactly `ProbeSubject.kind` (`packages/probe-defs/src/types.ts`). */
const BARE_STEM = /^(?:term|lib|mux):[^@/]+$/

/** Read a context key as one of the shapes the builder writes; a bare stem is legitimate, not a defect. */
export function recognizeProjectedContextKey(key: string): RecognizedProjectedContextKey {
  const parts = parseProjectedContextKey(key)
  if (parts !== undefined) return { shape: "full", parts }
  return BARE_STEM.test(key) ? { shape: "bare-stem" } : { shape: "unreadable" }
}
const versionCompare = (a: string, b: string): number => a.localeCompare(b, undefined, { numeric: true })

/**
 * Read current execution results without applying later feature interpretations or grading.
 * `archivedExclusions` are the frozen refusals of legacy runs (#30759 AC3); they lead the published
 * list, and refusals this reading assesses for schema-3 or schema-4 runs are appended after them.
 */
export function projectResults(
  runs: readonly LoadedRun[],
  interpretations: readonly Interpretation[],
  catalogIds: readonly string[],
  policy: {
    currentProbeHash: string
    releaseSuiteId?: string | null
    textSnapshots?: ReadonlyMap<string, Uint8Array>
    workingRuns?: readonly LoadedRun[]
    workingAttempts?: readonly SelectedAttemptInput[]
  },
  archivedExclusions: readonly SelectedExclusion[],
): SelectedProjection {
  if (!nonempty(policy.currentProbeHash)) throw new Error("currentProbeHash is required")
  for (const entry of interpretations) {
    if (!hasPresentationDecision(entry)) continue
    const run = runs.find((candidate) => candidate.runId === entry.runId)
    if (!run) throw new Error(`presentation ${entry.id}: runId ${entry.runId} does not name a raw run`)
    validatePresentationShape(
      entry as unknown as Record<string, unknown>,
      `interpretation ${entry.id}`,
      new Set(run.catalogIds ?? catalogIds),
    )
    if (entry.runSha256 !== run.sha256) throw new Error(`presentation ${entry.id}: run SHA256 mismatch`)
    if (!applies(entry, run)) throw new Error(`presentation ${entry.id}: scope does not match exact run`)
    if (
      !(run.schemaVersion === 3 || run.schemaVersion === 4 ? run.results : run.observations)?.some(
        (result) => result.featureId === entry.featureId,
      )
    ) {
      throw new Error(`presentation ${entry.id}: missing original result for ${entry.featureId}`)
    }
  }
  // 30661: the context count is per target across every run the projection read, so a context key is
  // qualified exactly as the runs measured it rather than as whichever runs are current today.
  const contexts = countContexts(runs)
  const currentRuns = runs.filter((run) => run.schemaVersion === 3 || run.schemaVersion === 4)
  const releaseSuiteId = policy.releaseSuiteId ?? null
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
    releaseSuiteId,
    treeSuiteId: policy.currentProbeHash,
    treeMovedPastRelease: treeMovedPastRelease(policy.currentProbeHash, releaseSuiteId),
  }
  const table: Record<string, Record<string, ProbeStatus>> = {}
  validatePresentationSupersession(interpretations, "interpretations")
  const active = activeInterpretations(interpretations)
  const acceptedRuns: LoadedRun[] = []
  const baselineRunIds: string[] = []
  for (const run of currentRuns) {
    if (!run.results || !run.catalogIds || !run.sealedAt || !run.probeHash || !run.sourceRevision) {
      throw new Error(`Current run ${run.runId} lacks its sealed execution contract`)
    }
    const results = consoleHostHeldResults(run)
    const aggregate = aggregateCurrentResults(results, run.catalogIds)
    const counts = aggregate.counts
    const states = Object.fromEntries(results.map((result) => [result.featureId, result.status]))
    table[run.runId] = states
    const suiteRelation: SuiteRelation =
      run.probeHash === releaseSuiteId ? "release" : run.probeHash === policy.currentProbeHash ? "tree" : "older"
    const assessment = assessRunAdmission(run, active, { mode: "historical" })
    const presentations: CurrentSelectedVersion["presentations"] = {}
    for (const entry of active) {
      if (!hasPresentationDecision(entry) || entry.runId !== run.runId) continue
      validatePresentationShape(
        entry as unknown as Record<string, unknown>,
        `interpretation ${entry.id}`,
        new Set(run.catalogIds),
      )
      if (entry.runSha256 !== run.sha256) throw new Error(`presentation ${entry.id}: run SHA256 mismatch`)
      if (!applies(entry, run)) throw new Error(`presentation ${entry.id}: scope does not match exact run`)
      if (!entry.featureId || !run.results.some((result) => result.featureId === entry.featureId)) {
        throw new Error(`presentation ${entry.id}: missing original result for ${entry.featureId}`)
      }
      if (presentations[entry.featureId]) throw new Error(`presentation ${entry.id}: conflicting active presentation`)
      presentations[entry.featureId] = {
        id: entry.id,
        reviewer: entry.reviewer,
        reason: entry.reason,
        sources: [...entry.sources],
        presentsEvidence: entry.presentsEvidence as boolean,
      }
    }
    const version: CurrentSelectedVersion = {
      schemaVersion: run.schemaVersion as 3 | 4,
      ...(run.schemaVersion === 4 ? { source: { ...run.source } } : {}),
      runId: run.runId,
      subject: run.subject,
      measuredAt: run.measuredAt,
      suiteId: run.suiteId,
      probeHash: run.probeHash,
      sourceRevision: run.sourceRevision,
      sealedAt: run.sealedAt,
      sha256: run.sha256,
      identity: run.identity,
      catalogIds: [...run.catalogIds],
      // Preserve the parser's result objects: its private historical facts are keyed by identity.
      results,
      suiteRelation,
      rawReplies: { ...run.rawReplies },
      assertions: globalThis.structuredClone(run.assertions),
      origin: globalThis.structuredClone(run.origin),
      presentations,
      ...(run.textQualification && { textQualification: globalThis.structuredClone(run.textQualification) }),
      suiteFreshness: `${suiteRelation} suite ${run.probeHash}`,
      ...(assessment.identityAdmission && { identityAdmission: assessment.identityAdmission }),
      counts,
      // D132 B (#30917): numerator and denominator come from the ONE fold, so both cover the same
      // graded ids (264 for a current 273-row run). Never recompute either from the raw catalogue.
      score: { supported: aggregate.supported, all: aggregate.denominator },
      complete: aggregate.complete,
    }
    const stem = `${run.subject.kind}:${run.subject.id}`
    const key = projectedContextKey(run.subject, contexts.get(stem)?.size ?? 0)
    ;(projection.history[key] ??= []).push(version)
    if (!assessment.accepted) {
      projection.exclusions.push({ runId: run.runId, path: run.path, reason: assessment.reason })
      continue
    }
    acceptedRuns.push(run)
    ;(projection.versions[key] ??= []).push(version)
  }
  const rank = (version: CurrentSelectedVersion): number =>
    projection.treeMovedPastRelease && version.suiteRelation === "release"
      ? 2
      : version.suiteRelation === "tree"
        ? 1
        : 0
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
      new Map(
        Object.entries(projection.versions).flatMap(([key, versions]) =>
          versions.map((version) => [contextKey(version.subject), key] as const),
        ),
      ),
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

function composeContextSummaries(
  acceptedRuns: readonly LoadedRun[],
  baselineRunIds: readonly string[],
  workingRuns: readonly LoadedRun[],
  workingAttempts: readonly SelectedAttemptInput[],
  catalogIds: readonly string[],
  contextKeys: ReadonlyMap<string, string>,
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
  // Working inputs cannot rename an admitted key. Working-only contexts take the existing qualified
  // form (the multi-context branch), even when they are the only working context for this target.
  const keyFor = (run: LoadedRun): string =>
    contextKeys.get(contextKey(run.subject)) ?? projectedContextKey(run.subject, 2)
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
    const baselines = [
      ...candidates.filter((run) => baselineIds.has(run.runId)),
      ...candidates.filter((run) => workingIds.has(run.runId) && readCollectorSelection(run.rawReplies) === undefined),
    ]
    const remember = (run: LoadedRun, result: ProbeResult): void => {
      cells[result.featureId] = { origin: { runId: run.runId, resultId: result.featureId }, run, result }
    }
    for (const run of baselines) {
      for (const result of consoleHostHeldResults(run)) remember(run, result)
    }
    const selected = candidates.flatMap((run) => {
      const selection = readCollectorSelection(run.rawReplies)
      return selection ? [{ runId: run.runId, run, selection, attempt: readCollectorAttempt(run.rawReplies) }] : []
    })
    selected.sort(compareContextAttempts)
    const attempts: SelectedContextAttempt[] = []
    for (const { run, selection, attempt } of selected) {
      const results = consoleHostHeldResults(run)
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
    const contributing = new Set(Object.values(cells).map((cell) => cell.origin.runId))
    const sourceOrder = [...baselines, ...selected.map((entry) => entry.run), ...candidates]
    const contributingRunIds = [...new Set(sourceOrder.map((run) => run.runId))].filter((id) => contributing.has(id))
    const missingIds = viewIds.filter((id) => !cells[id])
    const aggregate = aggregateCurrentResults(
      viewIds.map((featureId) => ({ featureId, status: cells[featureId]?.result.status ?? "test-todo" })),
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

export function statesFor(projection: SelectedProjection, runId: string): Readonly<Record<string, ProbeStatus>> {
  const states = projection.table[runId]
  if (!states) throw new Error(`The projection classified no row for run ${runId}`)
  return states
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
    releaseSuiteId?: string | null
    workingRuns?: readonly LoadedRun[]
    workingAttempts?: readonly SelectedAttemptInput[]
  } = {},
): SelectedProjection {
  const featuresPath = join(contentDir, "features.json")
  if (!existsSync(featuresPath)) fail(featuresPath, "missing required catalog")
  const catalog = Object.keys(loadFeatures(contentDir))
  const suites = new Map<string, ProbeSuiteManifest>()
  const suitesDir = join(contentDir, "suites")
  if (existsSync(suitesDir)) {
    for (const file of readdirSync(suitesDir)
      .filter((name) => name.endsWith(".json"))
      .sort()) {
      const path = join(suitesDir, file)
      const manifest = parseSuiteManifest(path, readFileSync(path, "utf8"))
      if (file !== `${manifest.probeHash}.json`) fail(path, `suite filename does not match ${manifest.probeHash}`)
      suites.set(manifest.probeHash, manifest)
    }
  }
  const runs: LoadedRun[] = []
  const verifiedArtifacts = new Set<string>()
  const textSnapshots = new Map<string, Uint8Array>()
  for (const dir of ["probes-apps", "probes-mux", "probes-libs"]) {
    const path = join(contentDir, dir)
    if (!existsSync(path)) fail(path, "missing required probe directory")
    for (const file of readdirSync(path)
      .filter((f) => f.endsWith(".json") && f !== "unified.json")
      .sort()) {
      const runPath = join(path, file)
      const run = parseRun(runPath, readFileSync(runPath, "utf8"), catalog, suites)
      for (const ref of run.screenshotRefs) {
        if (verifiedArtifacts.has(`screenshot:${ref}`)) continue
        readVerifiedArtifact(contentDir, ref, runPath, "screenshot")
        verifiedArtifacts.add(`screenshot:${ref}`)
      }
      for (const ref of run.textSnapshotRefs ?? []) {
        if (verifiedArtifacts.has(`text-snapshot:${ref}`)) continue
        textSnapshots.set(ref, readVerifiedArtifact(contentDir, ref, runPath, "text-snapshot"))
        verifiedArtifacts.add(`text-snapshot:${ref}`)
      }
      runs.push(run)
    }
  }
  const interpretationsPath = join(contentDir, "interpretations.json")
  const interpretations = existsSync(interpretationsPath)
    ? parseInterpretations(interpretationsPath, readFileSync(interpretationsPath, "utf8"), catalog)
    : []
  return projectResults(
    runs,
    interpretations,
    catalog,
    {
      currentProbeHash,
      textSnapshots,
      releaseSuiteId: options.releaseSuiteId ?? null,
      workingRuns: options.workingRuns,
      workingAttempts: options.workingAttempts,
    },
    loadArchivedExclusions(contentDir),
  )
}
