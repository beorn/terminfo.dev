/** Reviewed selection and projection for terminal observations. */
import { existsSync, readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import {
  aggregateCurrentResults,
  classifyCells,
  treeMovedPastRelease,
  type CellState,
  type SuiteRelation,
} from "./release-scope.ts"
import { loadFeatures } from "@terminfo/catalog"
import {
  type Interpretation,
  type CapabilityResult,
  type CapabilityStatus,
  type Observation,
  type ObservationFrame,
  type ProbeAssertion,
  type ProbeTarget,
  type RunOrigin,
  type UngradedDiagnostic,
  type ProbeSuiteManifest,
  type TextQualification,
  isNonMeasuringEvidence,
  assessTextQualification,
  finalizeCapabilityResult,
  type TextQualificationAssessment,
} from "@terminfo/probe-defs"
import {
  type LoadedRun,
  parseSuiteManifest,
  parseRun,
  parseObservationFrames,
  validateObservation,
  validateObservationOutcome,
} from "@terminfo/run-parser"
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

export interface SelectedCell extends Observation {
  conclusive: boolean
  /** Same-run mapping failure, computed from retained evidence; absent when no assessment failed. */
  textQualificationReason?: string
  /** Why the Windows console-host rule holds this cell (#30720); the cell's note says the same. */
  consoleHostHold?: string
  record: {
    rawReply?: string
    assertions: ProbeAssertion[]
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
    method: Observation["evidence"]
    runId: string
    runSha256: string
    rawReplyRef?: string
    screenshotRef?: string
    correctionId?: string
    sources?: string[]
  }
  presentation?: {
    decision: Pick<Interpretation, "id" | "reviewer" | "reason" | "sources"> & { presentsEvidence: boolean }
    original: { observation: Observation; record: SelectedCell["record"] }
  }
}

export type { IdentityAdmission } from "../../packages/admin/run-admission.ts"

export interface SelectedVersion {
  schemaVersion: 1 | 2
  runId: string
  target: ProbeTarget
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
    evidence: "legacy"
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

/**
 * The reader's one product: the classified state of every cell of every run the projection read, keyed
 * by run id. Every bar, page and CLI view folds THIS table (`aggregateCells` in `release-scope.ts`)
 * rather than walking raw cells, so `classifyCell` runs once per cell, here, and no consumer can drift
 * into a second copy of the classification (28792 item 1).
 *
 * The key is the run id, not the context key: a consumer of the SELECTED run reads
 * `table[current[context].runId]`, while `decisive-share` also cuts bars over the runs in `history`
 * (its ADMITTED RUNS section), and one run belongs to exactly one context, so this key covers both
 * without re-classifying anything.
 */
export type CellTable = Readonly<Record<string, Readonly<Record<string, CellState>>>>

export interface HistoricalProjection {
  current: Record<string, SelectedVersion>
  versions: Record<string, SelectedVersion[]>
  /** The classified state of every run's cells, keyed by run id and then by feature id. */
  table: CellTable
  /** Includes every valid raw run, even ones excluded from selection. */
  history: Record<string, SelectedVersion[]>
  exclusions: Array<{ runId: string; path: string; reason: string }>
  /** The release suite this projection was labelled against, or null when no release declaration pins one. */
  releaseSuiteId: string | null
  /** The live tree suite the site was built from. */
  treeSuiteId: string
  /** True when the tree has moved past the release suite; the site prints ONE banner when it is. */
  treeMovedPastRelease: boolean
}

/**
 * A current row is the collector's sealed result, never an observation regraded by this reader, with one
 * named exception: the Windows console-host rule (`consoleHostHeldResults`, #30720). A second exception
 * goes to @cto first.
 */
export interface CurrentSelectedVersion {
  schemaVersion: 3
  runId: string
  target: ProbeTarget
  measuredAt: string
  suiteId: string
  probeHash: string
  sourceRevision: string
  sealedAt: string
  sha256: string
  /** The identity the run recorded for itself. Only its trace document publishes it. */
  identity: LoadedRun["identity"]
  catalogIds: string[]
  results: CapabilityResult[]
  rawReplies: Record<string, string>
  assertions: ProbeAssertion[]
  origin: RunOrigin
  textQualification?: TextQualification
  presentations: Record<
    string,
    Pick<Interpretation, "id" | "reviewer" | "reason" | "sources"> & { presentsEvidence: boolean }
  >
  identityAdmission?: IdentityAdmission
  suiteRelation: SuiteRelation
  suiteFreshness: string
  counts: Record<CapabilityStatus, number>
  score: { supported: number; all: number }
  complete: boolean
}

export interface SelectedProjection {
  current: Record<string, CurrentSelectedVersion>
  versions: Record<string, CurrentSelectedVersion[]>
  history: Record<string, CurrentSelectedVersion[]>
  table: Readonly<Record<string, Readonly<Record<string, CapabilityStatus>>>>
  exclusions: Array<{ runId: string; path: string; reason: string }>
  releaseSuiteId: string | null
  treeSuiteId: string
  treeMovedPastRelease: boolean
}

const TEMPORAL_PIXEL_FEATURES = new Set([
  "sgr.blink",
  "extensions.kitty-graphics.animation",
  "modes.synchronized-output",
  "extensions.osc555-flash",
])

function observationRecord(run: LoadedRun, observation: Observation): SelectedCell["record"] {
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
const DA1_QUERY = "\u001b[c"
const DA1_REPLY = /\u001b\[\?[0-9;]*c/u

function replySource(sequence: string, reply: string): "host" | "terminal" | "none" {
  const da1 = sequence !== DA1_QUERY && sequence.endsWith(DA1_QUERY) ? DA1_REPLY.exec(reply) : null
  if (da1 === null) return reply === "" ? "none" : "host"
  if (da1.index > 0) return "host"
  return da1.index + da1[0].length < reply.length ? "terminal" : "none"
}

/** The console host a reason names: a text read's recorded host, else the ownership receipt's image. */
function consoleHostBinary(run: LoadedRun): string {
  const hosts = new Set(
    [...(run.results ?? []), ...run.observations].flatMap((cell) =>
      cell.host ? [`${cell.host.image} ${cell.host.executableSha256.slice(0, "sha256:".length + 12)}`] : [],
    ),
  )
  if (hosts.size > 1) throw new Error(`Run ${run.runId} names ${hosts.size} console hosts; one run has one`)
  const [host] = hosts
  if (host !== undefined) return host
  const receipt = run.rawReplies["collector.terminalOwnership"]
  const image =
    receipt === undefined
      ? undefined
      : (JSON.parse(receipt) as { windowsHosted?: { consoleHost?: { image?: unknown } } }).windowsHosted?.consoleHost
          ?.image
  return typeof image === "string" && image !== "" ? image : "(console host binary not recorded)"
}

function consoleHostHold(
  run: LoadedRun,
  cell: { featureId: string; evidence?: string; rawReplyRef?: string },
  verdict: string,
): string | undefined {
  if (run.target.kind !== "app" || run.target.os?.toLowerCase() !== "windows") return undefined
  if (verdict !== "supported" && verdict !== "unsupported") return undefined
  if ((cell.evidence !== "query" && cell.evidence !== "behavior") || cell.rawReplyRef === undefined) return undefined
  const stored = run.rawReplies[cell.rawReplyRef]
  if (stored === undefined) {
    throw new Error(`Run ${run.runId}: ${cell.featureId} cites raw reply ${cell.rawReplyRef}, which the run lacks`)
  }
  const queries = stored.startsWith("{") ? (JSON.parse(stored) as { queries?: unknown }).queries : undefined
  if (stored.startsWith("{") && (!Array.isArray(queries) || queries.length === 0)) return undefined
  const sources = Array.isArray(queries)
    ? queries.map((query: unknown, index) => {
        const { sequence, raw } = (query ?? {}) as { sequence?: unknown; raw?: unknown }
        if (typeof sequence !== "string" || (raw !== undefined && typeof raw !== "string")) {
          throw new Error(`Run ${run.runId}: ${cell.featureId} query ${index} has no readable sequence and reply`)
        }
        return replySource(sequence, raw ?? "")
      })
    : [replySource("", stored)]
  if (sources.every((source) => source === "terminal")) return undefined
  return sources.includes("host")
    ? `answered by the Windows console host ${consoleHostBinary(run)}, not measured on the terminal`
    : "no reply after the console host's DA1; the host may have swallowed the query"
}

/** A current run's sealed results as this reader counts them: unchanged but for the console-host rule. */
export function consoleHostHeldResults(run: LoadedRun): CapabilityResult[] {
  if (!run.results) throw new Error(`Run ${run.runId} has no current schema-3 results`)
  return run.results.map((result) => {
    const hold = consoleHostHold(run, result, result.status)
    if (hold === undefined) return result
    const { status: _sealed, ...unsealed } = result
    return finalizeCapabilityResult({
      ...unsealed,
      checks: [...result.checks, { id: "console-host", status: "test-todo", attempt: { scope: "none" }, reason: hold }],
      reason: hold,
    })
  })
}

function isConclusiveObservation(run: LoadedRun, observation: Observation, text: TextQualificationAssessment): boolean {
  return (
    !run.legacy &&
    (observation.evidence !== "text" ||
      (run.target.kind === "app" &&
        run.target.os?.toLowerCase() === "macos" &&
        observation.host === undefined &&
        !run.observations.some(
          (recorded) => recorded.featureId === observation.featureId && recorded.host !== undefined,
        ) &&
        text.qualified &&
        run.textClaims?.includes(observation.featureId) === true)) &&
    !isNonMeasuringEvidence(observation.evidence) &&
    (observation.outcome === "supported" || observation.outcome === "unsupported")
  )
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
      conclusive: hold === undefined && isConclusiveObservation(run, observation, text),
      ...(observation.evidence === "text" &&
      run.textQualification !== undefined &&
      !text.qualified &&
      text.reason !== undefined
        ? { textQualificationReason: text.reason }
        : {}),
      chain: {
        origin: run.origin,
        method: observation.evidence,
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
    const observation = entry.observation
    if (correctedFeatures.has(entry.featureId)) throw new Error(`conflicting active corrections for ${entry.featureId}`)
    correctedFeatures.add(entry.featureId)
    validateObservationOutcome(observation as unknown as Record<string, unknown>, entry.id, entry.featureId)
    validateObservation(observation, `interpretation ${entry.id}`, run.rawReplies, run.assertions)
    if (observation.evidence === "query" && !observation.rawReplyRef) {
      throw new Error(`interpretation ${entry.id}: query requires rawReplyRef`)
    }
    if (observation.evidence === "pixels" && !observation.screenshotRef) {
      throw new Error(`interpretation ${entry.id}: pixels requires screenshotRef`)
    }
    if (observation.evidence === "text" && observation.screenshotRef) {
      throw new Error(`interpretation ${entry.id}: text evidence cannot carry screenshotRef`)
    }
    if (observation.screenshotRef && !run.screenshotRefs.includes(observation.screenshotRef)) {
      throw new Error(`interpretation ${entry.id}: unknown screenshotRef ${observation.screenshotRef}`)
    }
    const frames = parseObservationFrames(
      observation.frames,
      `interpretation ${entry.id}`,
      entry.featureId,
      run.screenshotRefs,
      run.textSnapshotRefs,
      observation.screenshotRef,
      observation.evidence,
    )
    // A decided interpretation is recomputable from the run alone, pixels or cells: both kinds cite
    // frames, and both must cite THIS run's bytes and the frames that run already recorded.
    const decided = observation.outcome === "supported" || observation.outcome === "unsupported"
    if ((observation.evidence === "pixels" || observation.evidence === "text") && decided) {
      const kind = observation.evidence
      if (entry.runId !== run.runId || entry.runSha256 !== run.sha256) {
        throw new Error(`${kind} interpretation ${entry.id} requires exact run SHA256`)
      }
      if (!frames) throw new Error(`${kind} interpretation ${entry.id} requires control and target frames`)
      const originalFrames = [...(recordedObservation.frames ?? [])]
      for (const frame of frames) {
        const match = originalFrames.findIndex(
          (recorded) =>
            recorded.role === frame.role &&
            recorded.ref === frame.ref &&
            recorded.capturedAt === frame.capturedAt &&
            recorded.label === frame.label &&
            recorded.sourceRef === frame.sourceRef,
        )
        if (match < 0) {
          throw new Error(
            `${kind} interpretation ${entry.id} cites a frame outside immutable ${entry.featureId} feature frames`,
          )
        }
        originalFrames.splice(match, 1)
      }
      if (kind === "pixels") {
        if (
          TEMPORAL_PIXEL_FEATURES.has(entry.featureId) &&
          frames.filter((frame) => frame.role === "target").length < 2
        ) {
          throw new Error(`temporal pixels interpretation ${entry.id} requires 2 target frames`)
        }
        if (run.target.os?.toLowerCase().startsWith("linux") && !run.provenance) {
          throw new Error(`pixels interpretation ${entry.id} requires Linux fixture provenance for geometry and font`)
        }
      }
    }
    const hold = consoleHostHold(run, observation, observation.outcome)
    cells[entry.featureId] = {
      ...observation,
      ...(hold !== undefined && { note: hold, consoleHostHold: hold }),
      record: observationRecord(run, observation),
      conclusive: hold === undefined && isConclusiveObservation(run, observation, text),
      ...(observation.evidence === "text" &&
      run.textQualification !== undefined &&
      !text.qualified &&
      text.reason !== undefined
        ? { textQualificationReason: text.reason }
        : {}),
      chain: {
        origin: run.origin,
        method: observation.evidence,
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
  states: Record<string, CapabilityStatus>
} {
  if (run.schemaVersion !== 3 || !run.results) {
    throw new Error(
      `Development run ${run.runId} requires current schema-3 recorded results; use the historical reader for old runs`,
    )
  }
  return {
    mode: "development",
    runId: run.runId,
    states: Object.fromEntries(consoleHostHeldResults(run).map((result) => [result.featureId, result.status])),
  }
}

function projectRun(
  run: LoadedRun,
  interpretations: readonly Interpretation[],
  catalogIds: readonly string[],
  currentProbeHash: string,
  releaseSuiteId: string | null,
  identityAdmission: IdentityAdmission | null,
  text: TextQualificationAssessment,
): SelectedVersion {
  const { cells, correctedFeatures } = prepareRunCells(run, interpretations, text)
  for (const entry of interpretations) {
    if (!hasPresentationDecision(entry) || !applies(entry, run)) continue
    const featureId = entry.featureId
    if (!featureId) throw new Error(`presentation ${entry.id}: missing featureId`)
    const recordedObservation = run.observations.find((observation) => observation.featureId === featureId)
    const cell = cells[featureId]
    if (!recordedObservation || !cell) throw new Error(`presentation ${entry.id}: missing original observation`)
    cell.presentation = {
      decision: {
        id: entry.id,
        reviewer: entry.reviewer,
        reason: entry.reason,
        sources: [...entry.sources],
        presentsEvidence: entry.presentsEvidence as boolean,
      },
      original: globalThis.structuredClone({
        observation: recordedObservation,
        record: observationRecord(run, recordedObservation),
      }),
    }
  }
  const values = Object.values(cells)
  const tested = values.length
  const conclusive = values.filter((v) => v.conclusive).length
  const supported = values.filter((v) => v.conclusive && v.outcome === "supported").length
  const unsupported = values.filter((v) => v.conclusive && v.outcome === "unsupported").length
  const v1: Record<string, boolean> = {}
  for (const [id, cell] of Object.entries(cells)) {
    if (cell.conclusive && cell.outcome === "supported") v1[id] = true
    else if (cell.conclusive && cell.outcome === "unsupported") v1[id] = false
  }
  const named = (run.notTested ?? []).map((entry) => ({
    featureId: entry.featureId,
    reason: entry.reason,
    noObservable: entry.noObservable,
    rawReplyRef: entry.rawReplyRef,
  }))
  for (const entry of named) {
    if (cells[entry.featureId]) {
      throw new Error(`named not-tested ${entry.featureId} is also measured in ${run.runId}`)
    }
  }
  const namedCount = named.length
  const remainder = catalogIds.length - tested - namedCount
  if (remainder < 0) throw new Error(`not-tested partition exceeds catalog for ${run.runId}`)
  const suiteObserved = run.observations.length + namedCount
  const suiteRelation: SuiteRelation =
    !run.legacy && !run.suiteComplete
      ? "partial"
      : run.suiteComplete && run.probeHash !== null && releaseSuiteId !== null && run.probeHash === releaseSuiteId
        ? "release"
        : run.suiteComplete && run.probeHash !== null && run.probeHash === currentProbeHash
          ? "tree"
          : "older"
  const suiteFreshness =
    suiteRelation === "partial"
      ? `partial (${suiteObserved} of ${run.suiteProbeCount} probes)`
      : suiteRelation === "release"
        ? `release suite ${releaseSuiteId}`
        : suiteRelation === "tree"
          ? `tree suite ${currentProbeHash}`
          : `older suite (${suiteObserved} probes)${run.probeHash ? "" : "; missing probeHash"}`
  if (run.schemaVersion === 3) throw new Error(`Current run ${run.runId} cannot use the historical observation reader`)
  return {
    schemaVersion: run.schemaVersion,
    runId: run.runId,
    target: run.target,
    measuredAt: run.measuredAt,
    suiteId: run.suiteId,
    probeHash: run.probeHash,
    suiteFreshness,
    suiteRelation,
    suite: {
      observed: suiteObserved,
      expected: run.suiteProbeCount,
      complete: run.suiteComplete,
      namedNotTested: namedCount,
    },
    sourceRevision: run.sourceRevision,
    sha256: run.sha256,
    identity: run.identity,
    ...(identityAdmission && { identityAdmission }),
    ...(run.textQualification === undefined ? {} : { textQualification: run.textQualification }),
    cells,
    v1,
    ungradedDiagnostics: {
      evidence: "legacy",
      label: "old callback result, unverified",
      results: run.ungradedDiagnostics,
    },
    reviews: interpretations
      .filter(
        (entry) =>
          applies(entry, run) &&
          ((entry.runId === run.runId &&
            entry.runSha256 === run.sha256 &&
            (entry.verifiesIdentity || entry.reviewed)) ||
            (entry.observation &&
              entry.featureId &&
              correctedFeatures.has(entry.featureId) &&
              entry.origin !== "documentation")),
      )
      .map(({ id, reviewer, reason, sources }) => ({ id, reviewer, reason, sources })),
    counts: {
      catalog: catalogIds.length,
      tested,
      notTested: catalogIds.length - tested,
      conclusive,
      supported,
      unsupported,
    },
    notTestedCoverage: { named, measured: tested, namedCount, remainder },
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
    ? config.replace(/\/nix\/store\/[a-z0-9]+-terminfo-linux-runner\/index\.js/g, "<terminfo-linux-runner>")
    : config
}

const contextKey = (t: ProbeTarget): string =>
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
 * Count over EVERY run the corpus holds for the target, legacy and schema 3, and pass the one result to
 * both projections; a projection counting its own runs keys one context two ways (30661).
 */
export function countContexts(runs: readonly LoadedRun[]): Map<string, Set<string>> {
  const counts = new Map<string, Set<string>>()
  for (const run of runs) {
    const stem = `${run.target.kind}:${run.target.id}`
    const contexts = counts.get(stem) ?? new Set<string>()
    contexts.add(contextKey(run.target))
    counts.set(stem, contexts)
  }
  return counts
}

/**
 * The key one run's context carries in the projection: the bare `<kind>:<id>` while its group has ONE
 * context, and `<kind>:<id>@<context>` once the group carries more, so a multi-context tie never hides
 * behind an id-level key. The group spans every run of the target, legacy and schema 3, so one context
 * carries one key in `current` and in `historical.current` and a reviewed default-context row names it once (30661). `run-selection.ts` reads this shape back to tell a stale reviewed row from a
 * review that names another os; tests build fixtures through THIS function, never a hand-copied shape.
 */
export function projectedContextKey(target: ProbeTarget, contextCount: number): string {
  const stem = `${target.kind}:${target.id}`
  return contextCount === 1 ? stem : `${stem}@${contextKey(target)}`
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

/** The stems a bare key can name: exactly `ProbeTarget.kind` (`packages/probe-defs/src/types.ts`). */
const BARE_STEM = /^(?:app|headless|mux):[^@/]+$/

/** Read a context key as one of the shapes the builder writes; a bare stem is legitimate, not a defect. */
export function recognizeProjectedContextKey(key: string): RecognizedProjectedContextKey {
  const parts = parseProjectedContextKey(key)
  if (parts !== undefined) return { shape: "full", parts }
  return BARE_STEM.test(key) ? { shape: "bare-stem" } : { shape: "unreadable" }
}
const versionCompare = (a: string, b: string): number => a.localeCompare(b, undefined, { numeric: true })

/**
 * The runs admission refuses, with the reason each was refused: the one part of the historical read that
 * production still consumes (public results, the API generator and the collector all read `exclusions`).
 * The display projection this function used to build had no reader outside tests (#30759 AC3).
 */
export function historicalExclusions(
  runs: readonly LoadedRun[],
  interpretations: readonly Interpretation[],
  catalogIds: readonly string[],
  policy: { currentProbeHash: string; textSnapshots?: ReadonlyMap<string, Uint8Array> },
): Array<{ runId: string; path: string; reason: string }> {
  if (!nonempty(policy.currentProbeHash)) throw new Error("currentProbeHash is required")
  const ids = new Set<string>()
  const byRunId = new Map<string, LoadedRun>()
  const textAssessments = new Map<string, TextQualificationAssessment>()
  for (const run of runs) {
    if (ids.has(run.runId)) throw new Error(`duplicate runId ${run.runId}`)
    ids.add(run.runId)
    byRunId.set(run.runId, run)
    textAssessments.set(run.runId, assessTextQualification(run, policy.textSnapshots))
  }
  const catalog = new Set(catalogIds)
  for (const entry of interpretations) {
    if (!hasPresentationDecision(entry)) continue
    validatePresentationShape(entry as unknown as Record<string, unknown>, `interpretation ${entry.id}`, catalog)
    const run = byRunId.get(entry.runId as string)
    if (!run) throw new Error(`presentation ${entry.id}: runId ${entry.runId} does not name a raw run`)
    if (entry.runSha256 !== run.sha256) throw new Error(`presentation ${entry.id}: run SHA256 mismatch`)
    if (!applies(entry, run)) throw new Error(`presentation ${entry.id}: scope does not match exact run`)
    if (!run.observations.some((observation) => observation.featureId === entry.featureId)) {
      throw new Error(`presentation ${entry.id}: missing original observation for ${entry.featureId}`)
    }
  }
  validatePresentationSupersession(interpretations, "interpretations")
  const active = activeInterpretations(interpretations)
  const presented = new Map<string, string>()
  for (const entry of active) {
    if (!hasPresentationDecision(entry)) continue
    const key = `${entry.runId}\0${entry.featureId}`
    const prior = presented.get(key)
    if (prior) {
      throw new Error(`presentation ${entry.id} conflicts with active ${prior} for ${entry.runId}/${entry.featureId}`)
    }
    presented.set(key, entry.id)
  }
  const exclusions: Array<{ runId: string; path: string; reason: string }> = []
  for (const run of runs) {
    const assessment = assessRunAdmission(run, active, { mode: "historical" })
    if (!assessment.accepted) exclusions.push({ runId: run.runId, path: run.path, reason: assessment.reason })
  }
  return exclusions
}

/** Read current execution results without applying later feature interpretations or grading. */
export function projectResults(
  runs: readonly LoadedRun[],
  interpretations: readonly Interpretation[],
  catalogIds: readonly string[],
  policy: { currentProbeHash: string; releaseSuiteId?: string | null; textSnapshots?: ReadonlyMap<string, Uint8Array> },
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
      !(run.schemaVersion === 3 ? run.results : run.observations)?.some(
        (result) => result.featureId === entry.featureId,
      )
    ) {
      throw new Error(`presentation ${entry.id}: missing original result for ${entry.featureId}`)
    }
  }
  // 30661: one context count for both projections, every run of the target, legacy and schema 3. Counted per
  // projection, alacritty's one schema-3 context was the bare stem while its three legacy contexts carried
  // full keys, and no reviewed default-context row could name the Windows context for both readers.
  const contexts = countContexts(runs)
  const exclusions = historicalExclusions(
    runs.filter((run) => run.schemaVersion !== 3),
    interpretations.filter(
      (entry) => !("captureSha256" in entry) && runs.some((run) => run.schemaVersion !== 3 && applies(entry, run)),
    ),
    catalogIds,
    policy,
  )
  const currentRuns = runs.filter((run) => run.schemaVersion === 3)
  const releaseSuiteId = policy.releaseSuiteId ?? null
  const ids = new Set<string>()
  for (const run of runs) {
    if (ids.has(run.runId)) throw new Error(`duplicate runId ${run.runId}`)
    ids.add(run.runId)
  }
  const projection: SelectedProjection = {
    current: {},
    versions: {},
    history: {},
    table: {},
    historical,
    exclusions,
    treeSuiteId: policy.currentProbeHash,
    treeMovedPastRelease: treeMovedPastRelease(policy.currentProbeHash, releaseSuiteId),
  }
  const table: Record<string, Record<string, CapabilityStatus>> = {}
  validatePresentationSupersession(interpretations, "interpretations")
  const active = activeInterpretations(interpretations)
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
      schemaVersion: 3,
      runId: run.runId,
      target: run.target,
      measuredAt: run.measuredAt,
      suiteId: run.suiteId,
      probeHash: run.probeHash,
      sourceRevision: run.sourceRevision,
      sealedAt: run.sealedAt,
      sha256: run.sha256,
      identity: run.identity,
      catalogIds: [...run.catalogIds],
      results: globalThis.structuredClone(results),
      suiteRelation,
      rawReplies: { ...run.rawReplies },
      assertions: globalThis.structuredClone(run.assertions),
      origin: globalThis.structuredClone(run.origin),
      presentations,
      ...(run.textQualification && { textQualification: globalThis.structuredClone(run.textQualification) }),
      suiteFreshness: `${suiteRelation} suite ${run.probeHash}`,
      ...(assessment.identityAdmission && { identityAdmission: assessment.identityAdmission }),
      counts,
      score: { supported: counts.supported, all: run.catalogIds.length },
      complete: aggregate.complete,
    }
    const stem = `${run.target.kind}:${run.target.id}`
    const key = projectedContextKey(run.target, contexts.get(stem)?.size ?? 0)
    ;(projection.history[key] ??= []).push(version)
    if (!assessment.accepted) {
      projection.exclusions.push({ runId: run.runId, path: run.path, reason: assessment.reason })
      continue
    }
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
        versionCompare(b.target.version, a.target.version) ||
        rank(b) - rank(a) ||
        Date.parse(b.measuredAt) - Date.parse(a.measuredAt) ||
        b.runId.localeCompare(a.runId),
    )
    const unique = versions.filter(
      (version, index) => versions.findIndex((entry) => entry.target.version === version.target.version) === index,
    )
    projection.versions[key] = unique
    const selected = unique[0]
    if (!selected) throw new Error(`missing selected current version for ${key}`)
    projection.current[key] = selected
  }
  return { ...projection, table }
}

/**
 * The classified states for one run, BY NAME: a run the projection never read is a loud error, never a
 * silent empty map that would read as a zero-row basis (28792 item 1).
 */
export function historicalStatesFor(
  projection: HistoricalProjection,
  runId: string,
): Readonly<Record<string, CellState>> {
  const states = projection.table[runId]
  if (!states) throw new Error(`The historical projection classified no row for run ${runId}`)
  return states
}

export function statesFor(projection: SelectedProjection, runId: string): Readonly<Record<string, CapabilityStatus>> {
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
export function loadSelectedResults(
  contentDir: string,
  currentProbeHash: string,
  options: { artifactDir?: string; releaseSuiteId?: string | null } = {},
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
  return projectResults(runs, interpretations, catalog, {
    currentProbeHash,
    textSnapshots,
    releaseSuiteId: options.releaseSuiteId ?? null,
  })
}
