/** Reviewed selection and projection for terminal observations. */
import { createHash } from "node:crypto"
import { existsSync, readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
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
  validateObservationOutcome,
  validateObservation,
} from "@terminfo/run-parser"
import { verifyTerminalIdentity, TERMINAL_IDENTITY_RULES } from "terminfo.dev/src/identity-guard.ts"

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

export interface SelectedVersion {
  runId: string
  target: ProbeTarget
  measuredAt: string
  suiteId: string
  probeHash: string | null
  suiteFreshness: string
  suite: { observed: number; expected: number | null; complete: boolean }
  sourceRevision: string | null
  sha256: string
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
}

export interface SelectedProjection {
  current: Record<string, SelectedVersion>
  versions: Record<string, SelectedVersion[]>
  /** Includes every valid raw run, even ones excluded from selection. */
  history: Record<string, SelectedVersion[]>
  exclusions: Array<{ runId: string; path: string; reason: string }>
}

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
const nonempty = (value: unknown): value is string => typeof value === "string" && value.length > 0
function fail(path: string, message: string): never {
  throw new Error(`${path}: ${message}`)
}
const asString = (value: unknown, path: string, name: string): string =>
  nonempty(value) ? value : fail(path, `missing ${name}`)

const hasPresentationDecision = (entry: object): boolean => Object.hasOwn(entry, "presentsEvidence")

function validatePresentationShape(entry: Record<string, unknown>, path: string, catalog: ReadonlySet<string>): void {
  if (!hasPresentationDecision(entry)) return
  const id = nonempty(entry.id) ? entry.id : "unnamed"
  if (typeof entry.presentsEvidence !== "boolean") fail(path, `presentation ${id}: invalid presentsEvidence`)
  for (const field of ["reviewed", "verifiesIdentity", "observation", "origin"]) {
    if (Object.hasOwn(entry, field)) fail(path, `presentation ${id} cannot set ${field}`)
  }
  if (!nonempty(entry.runId)) fail(path, `presentation ${id} requires exact runId`)
  if (typeof entry.runSha256 !== "string" || !/^[a-f0-9]{64}$/.test(entry.runSha256)) {
    fail(path, `presentation ${id} requires exact run SHA256`)
  }
  if (!nonempty(entry.featureId) || !catalog.has(entry.featureId)) {
    fail(path, `presentation ${id} requires catalog featureId`)
  }
  if (!nonempty(entry.reviewer) || !nonempty(entry.reason)) {
    fail(path, `presentation ${id} requires reviewer and reason`)
  }
  if (!Array.isArray(entry.sources) || entry.sources.length === 0 || !entry.sources.every(nonempty)) {
    fail(path, `presentation ${id} requires sources`)
  }
  if (
    !object(entry.scope) ||
    !object(entry.scope.target) ||
    !["app", "headless", "mux"].includes(String(entry.scope.target.kind)) ||
    !nonempty(entry.scope.target.id) ||
    !Array.isArray(entry.scope.versions) ||
    entry.scope.versions.length !== 2 ||
    !entry.scope.versions.every(nonempty) ||
    !Array.isArray(entry.scope.suites) ||
    entry.scope.suites.length !== 2 ||
    !entry.scope.suites.every(nonempty)
  ) {
    fail(path, `presentation ${id} requires a valid scope`)
  }
}

function validatePresentationSupersession(entries: readonly Interpretation[], path: string): void {
  const byId = new Map(entries.map((entry) => [entry.id, entry]))
  for (const entry of entries) {
    for (const priorId of entry.supersedes) {
      const prior = byId.get(priorId)
      if (!prior) fail(path, `interpretation ${entry.id} supersedes unknown ${priorId}`)
      const currentPresentation = hasPresentationDecision(entry)
      const priorPresentation = hasPresentationDecision(prior)
      if (
        (currentPresentation || priorPresentation) &&
        (!currentPresentation ||
          !priorPresentation ||
          entry.runId !== prior.runId ||
          entry.runSha256 !== prior.runSha256 ||
          entry.featureId !== prior.featureId)
      ) {
        fail(path, `presentation ${entry.id} cannot supersede ${prior.id} outside the same exact run/SHA/feature`)
      }
    }
  }
}

const TEMPORAL_PIXEL_FEATURES = new Set([
  "sgr.blink",
  "extensions.kitty-graphics.animation",
  "modes.synchronized-output",
  "extensions.osc555-flash",
])

export function parseInterpretations(path: string, source: string, catalogIds: readonly string[]): Interpretation[] {
  const raw = parseJsonStrict(path, source)
  if (!Array.isArray(raw)) fail(path, "interpretations must be an array")
  const ids = new Set<string>()
  const catalog = new Set(catalogIds)
  for (const entry of raw) {
    if (!object(entry)) fail(path, "invalid interpretation")
    const id = asString(entry.id, path, "interpretation.id")
    if (ids.has(id)) fail(path, `duplicate interpretation ${id}`)
    ids.add(id)
    asString(entry.reviewer, path, `reviewer for ${id}`)
    asString(entry.reason, path, `reason for ${id}`)
    if (
      !object(entry.scope) ||
      !object(entry.scope.target) ||
      !["app", "headless", "mux"].includes(String(entry.scope.target.kind)) ||
      !nonempty(entry.scope.target.id)
    ) {
      fail(path, `invalid scope target for ${id}`)
    }
    if (
      !Array.isArray(entry.scope.versions) ||
      entry.scope.versions.length !== 2 ||
      !entry.scope.versions.every(nonempty)
    ) {
      fail(path, `invalid versions for ${id}`)
    }
    if (!Array.isArray(entry.scope.suites) || entry.scope.suites.length !== 2 || !entry.scope.suites.every(nonempty)) {
      fail(path, `invalid suites for ${id}`)
    }
    if (!Array.isArray(entry.sources) || entry.sources.length === 0 || !entry.sources.every(nonempty)) {
      fail(path, `missing sources for ${id}`)
    }
    if (!Array.isArray(entry.supersedes) || !entry.supersedes.every(nonempty)) {
      fail(path, `invalid supersedes for ${id}`)
    }
    if (new Set(entry.supersedes).size !== entry.supersedes.length || entry.supersedes.includes(id)) {
      fail(path, `duplicate/self supersedes for ${id}`)
    }
    if (entry.runId !== undefined && !nonempty(entry.runId)) fail(path, `invalid runId for ${id}`)
    if (
      entry.runSha256 !== undefined &&
      (typeof entry.runSha256 !== "string" || !/^[a-f0-9]{64}$/.test(entry.runSha256))
    ) {
      fail(path, `invalid run SHA256 for ${id}`)
    }
    validatePresentationShape(entry, path, catalog)
    for (const flag of ["reviewed", "verifiesIdentity"] as const) {
      if (entry[flag] !== undefined && typeof entry[flag] !== "boolean") fail(path, `invalid ${flag} for ${id}`)
    }
    if (entry.verifiesIdentity || entry.reviewed) {
      if (!nonempty(entry.runId)) fail(path, `identity/community review ${id} requires exact runId`)
      if (typeof entry.runSha256 !== "string" || !/^[a-f0-9]{64}$/.test(entry.runSha256)) {
        fail(path, `identity/community review ${id} requires exact run SHA256`)
      }
    }
    if (entry.featureId !== undefined && (!nonempty(entry.featureId) || !catalog.has(entry.featureId))) {
      fail(path, `unknown feature ${String(entry.featureId)}`)
    }
    if (entry.origin === "documentation" && entry.observation) {
      fail(path, `documentation ${id} cannot be an observation`)
    }
    if (entry.observation !== undefined) {
      if (!object(entry.observation)) fail(path, `invalid observation in ${id}`)
      if (!nonempty(entry.featureId) || entry.observation.featureId !== entry.featureId) {
        fail(path, `observation feature mismatch in ${id}`)
      }
      validateObservationOutcome(entry.observation, path, entry.featureId)
      if (entry.observation.evidence === "pixels" && !nonempty(entry.observation.screenshotRef)) {
        fail(path, `pixels correction ${id} requires screenshotRef`)
      }
      if (entry.observation.evidence === "query" && !nonempty(entry.observation.rawReplyRef)) {
        fail(path, `query correction ${id} requires rawReplyRef`)
      }
    }
  }
  validatePresentationSupersession(raw as Interpretation[], path)
  return raw as Interpretation[]
}

function inRange(value: string, [low, high]: [string, string]): boolean {
  return (
    value.localeCompare(low, undefined, { numeric: true }) >= 0 &&
    value.localeCompare(high, undefined, { numeric: true }) <= 0
  )
}

function applies(entry: Interpretation, run: LoadedRun): boolean {
  return (
    entry.scope.target.kind === run.target.kind &&
    entry.scope.target.id === run.target.id &&
    (!entry.runId || entry.runId === run.runId) &&
    (!entry.runSha256 || entry.runSha256 === run.sha256) &&
    inRange(run.target.version, entry.scope.versions) &&
    inRange(run.suiteId, entry.scope.suites)
  )
}

function identityRepliesMatch(run: LoadedRun): boolean {
  if (run.target.kind === "headless") {
    const receipt = run.runtimeIdentity
    if (!receipt || receipt.engineVersion !== run.target.version) return false
    return receipt.kind === "native" || receipt.integrity.kind === "registry" || receipt.integrity.cleanTree
  }
  const rule = TERMINAL_IDENTITY_RULES[run.target.id]
  if (!rule || !nonempty(run.rawReplies["device.primary-da"])) return false
  const results = Object.fromEntries(run.observations.map((o) => [o.featureId, o.outcome === "supported"]))
  const verification = verifyTerminalIdentity(run.target.id, run.rawReplies, results)
  if (!verification.checked || !verification.ok) return false
  if (rule.forbidXtversion) {
    const receipt = run.origin.appLaunch
    return !!receipt && run.target.version !== "unknown" && receipt.cfBundleShortVersionString === run.target.version
  }
  if (rule.requireXtversion && !nonempty(run.rawReplies["device.xtversion"])) return false
  const versionReply = run.rawReplies["device.xtversion"]
  if (!versionReply) return false
  const escapedVersion = run.target.version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  return new RegExp(`(^|[^a-zA-Z0-9])${escapedVersion}($|[^a-zA-Z0-9])`).test(versionReply)
}

function activeInterpretations(entries: readonly Interpretation[]): Interpretation[] {
  const byId = new Map(entries.map((entry) => [entry.id, entry]))
  if (byId.size !== entries.length) throw new Error("duplicate interpretation ID")
  const visited = new Set<string>()
  const visiting = new Set<string>()
  const superseded = new Set<string>()
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new Error(`interpretation supersession cycle at ${id}`)
    if (visited.has(id)) return
    const entry = byId.get(id)
    if (!entry) throw new Error(`unknown superseded interpretation ${id}`)
    visiting.add(id)
    for (const prior of entry.supersedes) {
      superseded.add(prior)
      visit(prior)
    }
    visiting.delete(id)
    visited.add(id)
  }
  for (const entry of entries) visit(entry.id)
  return entries.filter((entry) => !superseded.has(entry.id))
}

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
  const suiteFreshness =
    !run.legacy && !run.suiteComplete
      ? `partial (${run.observations.length} of ${run.suiteProbeCount} probes)`
      : run.probeHash === currentProbeHash && run.suiteComplete
        ? "current suite"
        : `older suite (${run.observations.length} probes)${run.probeHash ? "" : "; missing probeHash"}`
  return {
    runId: run.runId,
    target: run.target,
    measuredAt: run.measuredAt,
    suiteId: run.suiteId,
    probeHash: run.probeHash,
    suiteFreshness,
    suite: { observed: run.observations.length, expected: run.suiteProbeCount, complete: run.suiteComplete },
    sourceRevision: run.sourceRevision,
    sha256: run.sha256,
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
  }
}

const contextKey = (t: ProbeTarget): string =>
  JSON.stringify([t.kind, t.id, t.os, t.osVersion, t.outerTerminal, t.mux, t.config, t.permissions])
const versionCompare = (a: string, b: string): number => a.localeCompare(b, undefined, { numeric: true })

export function projectResults(
  runs: readonly LoadedRun[],
  interpretations: readonly Interpretation[],
  catalogIds: readonly string[],
  policy: { currentProbeHash: string },
): SelectedProjection {
  if (!nonempty(policy.currentProbeHash)) throw new Error("currentProbeHash is required")
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
    if (prior)
      throw new Error(`presentation ${entry.id} conflicts with active ${prior} for ${entry.runId}/${entry.featureId}`)
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
  for (const run of runs) {
    const key = keyFor(run)
    history[key] ??= []
    history[key].push(projectRun(run, active, catalogIds, policy.currentProbeHash))
    const reviewed = active.some(
      (entry) => entry.runId === run.runId && entry.runSha256 === run.sha256 && applies(entry, run) && entry.reviewed,
    )
    const identityReview = active.some(
      (entry) =>
        entry.runId === run.runId && entry.runSha256 === run.sha256 && applies(entry, run) && entry.verifiesIdentity,
    )
    const reason =
      run.identity === "disputed"
        ? "identity-disputed"
        : !identityReview
          ? run.identity === "unverified"
            ? "identity-unverified"
            : "identity-unreviewed"
          : run.target.kind === "app" && run.target.os?.toLowerCase().startsWith("linux") && !run.provenance
            ? "native-provenance-missing"
            : run.provenance && !run.provenance.runtime.cleanTree
              ? "native-provenance-dirty"
              : !identityRepliesMatch(run)
                ? run.target.kind === "headless"
                  ? "runtime-identity-unverified"
                  : "identity-replies-mismatch"
                : !/^[0-9a-f]{40}$/.test(run.sourceRevision ?? "")
                  ? "source-uncommitted"
                  : run.origin.kind === "community-issue" && !reviewed
                    ? "community-unreviewed"
                    : !run.suiteComplete
                      ? "suite-incomplete"
                      : null
    if (reason) {
      exclusions.push({ runId: run.runId, path: run.path, reason })
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
      versions[key].push(projectRun(chosen, active, catalogIds, policy.currentProbeHash))
    }
    const selected = versions[key][0]
    if (!selected) throw new Error(`missing selected version for ${key}`)
    current[key] = selected
  }
  return { current, versions, history, exclusions }
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
  _options: { artifactDir?: string } = {},
): SelectedProjection {
  const featuresPath = join(contentDir, "features.json")
  if (!existsSync(featuresPath)) fail(featuresPath, "missing required catalog")
  const features = parseJsonStrict(featuresPath, readFileSync(featuresPath, "utf8"))
  if (!object(features)) fail(featuresPath, "invalid catalog")
  const catalog = Object.keys(features).filter((id) => !id.startsWith("$"))
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
  return projectResults(runs, interpretations, catalog, { currentProbeHash })
}
