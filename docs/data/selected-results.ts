/** Reviewed selection and projection for terminal observations. */
import { createHash } from "node:crypto"
import { existsSync, readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { classifyCells, treeMovedPastRelease, type CellState, type SuiteRelation } from "./release-scope.ts"
import { loadFeatures } from "@terminfo/catalog"
import {
  type Interpretation,
  type Observation,
  type ObservationFrame,
  type ProbeAssertion,
  type ProbeTarget,
  type RunOrigin,
  type UngradedDiagnostic,
  type ProbeSuiteManifest,
  isNonMeasuringEvidence,
} from "@terminfo/probe-defs"
import {
  type LoadedRun,
  parseJsonStrict,
  parseSuiteManifest,
  parseRun,
  parseObservationFrames,
  validateObservation,
  validateObservationOutcome,
} from "@terminfo/run-parser"
import { assessRunAdmission, type IdentityAdmission } from "../../scripts/admit-run.ts"
import {
  activeInterpretations,
  applies,
  fail,
  hasPresentationDecision,
  nonempty,
  object,
  parseInterpretations,
  validatePresentationShape,
  validatePresentationSupersession,
} from "../../scripts/interpretations.ts"
export { parseInterpretations } from "../../scripts/interpretations.ts"

export interface SelectedCell extends Observation {
  conclusive: boolean
  record: {
    rawReply?: string
    assertions: ProbeAssertion[]
    screenshot?: { url: string; sha256: string }
    frames?: Array<{
      role: ObservationFrame["role"]
      label: string
      capturedAt: number
      url: string
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

export type { IdentityAdmission } from "../../scripts/admit-run.ts"

export interface SelectedVersion {
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
  identityAdmission?: IdentityAdmission
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

export interface SelectedProjection {
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
      frames: observation.frames.map((frame) => ({
        role: frame.role,
        label: frame.label,
        capturedAt: frame.capturedAt,
        url: `/artifacts/${frame.ref.slice("sha256:".length)}.png`,
        sha256: frame.ref.slice("sha256:".length),
        ...(frame.sourceRef && { sourceRef: frame.sourceRef }),
      })),
    }),
  }
}

function projectRun(
  run: LoadedRun,
  interpretations: readonly Interpretation[],
  catalogIds: readonly string[],
  currentProbeHash: string,
  releaseSuiteId: string | null,
  identityAdmission: IdentityAdmission | null,
): SelectedVersion {
  const cells: Record<string, SelectedCell> = {}
  const correctedFeatures = new Set<string>()
  for (const observation of run.observations) {
    cells[observation.featureId] = {
      ...observation,
      record: observationRecord(run, observation),
      conclusive:
        !run.legacy &&
        !isNonMeasuringEvidence(observation.evidence) &&
        (observation.outcome === "supported" || observation.outcome === "unsupported"),
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
    if (observation.screenshotRef && !run.screenshotRefs.includes(observation.screenshotRef)) {
      throw new Error(`interpretation ${entry.id}: unknown screenshotRef ${observation.screenshotRef}`)
    }
    const frames = parseObservationFrames(
      observation.frames,
      `interpretation ${entry.id}`,
      entry.featureId,
      run.screenshotRefs,
      observation.screenshotRef,
      observation.evidence,
    )
    if (
      observation.evidence === "pixels" &&
      (observation.outcome === "supported" || observation.outcome === "unsupported")
    ) {
      if (entry.runId !== run.runId || entry.runSha256 !== run.sha256) {
        throw new Error(`pixels interpretation ${entry.id} requires exact run SHA256`)
      }
      if (!frames) throw new Error(`pixels interpretation ${entry.id} requires control and target frames`)
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
            `pixels interpretation ${entry.id} cites a frame outside immutable ${entry.featureId} feature frames`,
          )
        }
        originalFrames.splice(match, 1)
      }
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
    cells[entry.featureId] = {
      ...observation,
      record: observationRecord(run, observation),
      conclusive:
        !run.legacy &&
        !isNonMeasuringEvidence(observation.evidence) &&
        (observation.outcome === "supported" || observation.outcome === "unsupported"),
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
  return {
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
    ...(identityAdmission && { identityAdmission }),
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
const versionCompare = (a: string, b: string): number => a.localeCompare(b, undefined, { numeric: true })

export function projectResults(
  runs: readonly LoadedRun[],
  interpretations: readonly Interpretation[],
  catalogIds: readonly string[],
  policy: { currentProbeHash: string; releaseSuiteId?: string | null },
): SelectedProjection {
  if (!nonempty(policy.currentProbeHash)) throw new Error("currentProbeHash is required")
  const releaseSuiteId = policy.releaseSuiteId ?? null
  const ids = new Set<string>()
  const byRunId = new Map<string, LoadedRun>()
  for (const run of runs) {
    if (ids.has(run.runId)) throw new Error(`duplicate runId ${run.runId}`)
    ids.add(run.runId)
    byRunId.set(run.runId, run)
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
  const contextCounts = new Map<string, Set<string>>()
  for (const run of runs) {
    const stem = `${run.target.kind}:${run.target.id}`
    if (!contextCounts.has(stem)) contextCounts.set(stem, new Set())
    const contexts = contextCounts.get(stem)
    if (!contexts) fail(run.path, `missing context group for ${stem}`)
    contexts.add(contextKey(run.target))
  }
  const keyFor = (run: LoadedRun): string => {
    const stem = `${run.target.kind}:${run.target.id}`
    return contextCounts.get(stem)?.size === 1 ? stem : `${stem}@${contextKey(run.target)}`
  }
  const current: SelectedProjection["current"] = {}
  const versions: SelectedProjection["versions"] = {}
  const history: SelectedProjection["history"] = {}
  const exclusions: SelectedProjection["exclusions"] = []
  const groups = new Map<string, LoadedRun[]>()
  const assessments = new Map<string, ReturnType<typeof assessRunAdmission>>()
  for (const run of runs) {
    const key = keyFor(run)
    history[key] ??= []
    const assessment = assessRunAdmission(run, active)
    assessments.set(run.runId, assessment)
    history[key].push(
      projectRun(run, active, catalogIds, policy.currentProbeHash, releaseSuiteId, assessment.identityAdmission),
    )
    if (!assessment.accepted) {
      exclusions.push({ runId: run.runId, path: run.path, reason: assessment.reason })
      continue
    }
    if (!groups.has(key)) groups.set(key, [])
    const group = groups.get(key)
    if (!group) fail(run.path, `missing run group for ${key}`)
    group.push(run)
  }
  for (const [key, group] of groups) {
    const byVersion = new Map<string, LoadedRun[]>()
    for (const run of group) {
      const version = run.target.version
      if (!byVersion.has(version)) byVersion.set(version, [])
      const versionGroup = byVersion.get(version)
      if (!versionGroup) fail(run.path, `missing version group for ${version}`)
      versionGroup.push(run)
    }
    versions[key] = []
    for (const version of [...byVersion.keys()].sort((a, b) => versionCompare(b, a))) {
      const choices = byVersion.get(version)
      if (!choices?.length) throw new Error(`missing run choices for ${key} ${version}`)
      choices.sort((a, b) => {
        const af = a.probeHash === policy.currentProbeHash && a.suiteComplete ? 1 : 0
        const bf = b.probeHash === policy.currentProbeHash && b.suiteComplete ? 1 : 0
        return bf - af || Date.parse(b.measuredAt) - Date.parse(a.measuredAt) || b.runId.localeCompare(a.runId)
      })
      const chosen = choices[0]
      if (!chosen) throw new Error(`missing chosen run for ${key} ${version}`)
      const assessment = assessments.get(chosen.runId)
      if (!assessment) throw new Error(`Missing admission assessment for selected run ${chosen.runId}`)
      versions[key].push(
        projectRun(chosen, active, catalogIds, policy.currentProbeHash, releaseSuiteId, assessment.identityAdmission),
      )
    }
    const selected = versions[key][0]
    if (!selected) throw new Error(`missing selected version for ${key}`)
    current[key] = selected
  }
  // One classification per cell, for every run the projection read: `current` and `versions` are drawn
  // from `history`, so classifying the history covers every consumer, and a run's cells are classified
  // once rather than once per reader.
  const table: Record<string, Record<string, CellState>> = {}
  for (const list of Object.values(history)) {
    for (const version of list) table[version.runId] = classifyCells(version.cells)
  }
  return {
    current,
    table,
    versions,
    history,
    exclusions,
    releaseSuiteId,
    treeSuiteId: policy.currentProbeHash,
    treeMovedPastRelease: treeMovedPastRelease(policy.currentProbeHash, releaseSuiteId),
  }
}

/**
 * The classified states for one run, BY NAME: a run the projection never read is a loud error, never a
 * silent empty map that would read as a zero-row basis (28792 item 1).
 */
export function statesFor(projection: SelectedProjection, runId: string): Readonly<Record<string, CellState>> {
  const states = projection.table[runId]
  if (!states) throw new Error(`The projection classified no row for run ${runId}`)
  return states
}

/** Read only the exact PNG bytes named by a digest-backed screenshot reference. */
export function readVerifiedScreenshot(contentDir: string, ref: string, sourcePath: string): Buffer {
  if (!/^sha256:[a-f0-9]{64}$/.test(ref)) fail(sourcePath, `invalid screenshotRef ${ref}`)
  const digest = ref.slice("sha256:".length)
  const artifactPath = join(contentDir, "artifacts", `${digest}.png`)
  if (!existsSync(artifactPath)) fail(sourcePath, `missing screenshot artifact ${artifactPath}`)
  const bytes = readFileSync(artifactPath)
  if (createHash("sha256").update(bytes).digest("hex") !== digest) {
    fail(sourcePath, `screenshot artifact digest mismatch at ${artifactPath}`)
  }
  if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    fail(sourcePath, `screenshot artifact is not a PNG at ${artifactPath}`)
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
  const verifiedScreenshots = new Set<string>()
  for (const dir of ["probes-apps", "probes-mux", "probes-libs"]) {
    const path = join(contentDir, dir)
    if (!existsSync(path)) fail(path, "missing required probe directory")
    for (const file of readdirSync(path)
      .filter((f) => f.endsWith(".json") && f !== "unified.json")
      .sort()) {
      const runPath = join(path, file)
      const run = parseRun(runPath, readFileSync(runPath, "utf8"), catalog, suites)
      for (const ref of run.screenshotRefs) {
        if (verifiedScreenshots.has(ref)) continue
        readVerifiedScreenshot(contentDir, ref, runPath)
        verifiedScreenshots.add(ref)
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
    releaseSuiteId: options.releaseSuiteId ?? null,
  })
}
