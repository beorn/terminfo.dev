/** Shared interpretation parsing, scope matching and supersession; no filesystem effects. */
import type { Interpretation } from "@terminfo/probe-defs"
import { parseJsonStrict, validateObservationOutcome, type LoadedRun } from "@terminfo/run-parser"

export const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
export const nonempty = (value: unknown): value is string => typeof value === "string" && value.length > 0
export function fail(path: string, message: string): never {
  throw new Error(`${path}: ${message}`)
}
export const asString = (value: unknown, path: string, name: string): string =>
  nonempty(value) ? value : fail(path, `missing ${name}`)

export const hasPresentationDecision = (entry: object): boolean => Object.hasOwn(entry, "presentsEvidence")

export function validatePresentationShape(
  entry: Record<string, unknown>,
  path: string,
  catalog: ReadonlySet<string>,
): void {
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

export function validatePresentationSupersession(entries: readonly Interpretation[], path: string): void {
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

export function inRange(value: string, [low, high]: [string, string]): boolean {
  return (
    value.localeCompare(low, undefined, { numeric: true }) >= 0 &&
    value.localeCompare(high, undefined, { numeric: true }) <= 0
  )
}

export function applies(entry: Interpretation, run: LoadedRun): boolean {
  return (
    entry.scope.target.kind === run.target.kind &&
    entry.scope.target.id === run.target.id &&
    (!entry.runId || entry.runId === run.runId) &&
    (!entry.runSha256 || entry.runSha256 === run.sha256) &&
    inRange(run.target.version, entry.scope.versions) &&
    inRange(run.suiteId, entry.scope.suites)
  )
}

export function activeInterpretations(entries: readonly Interpretation[]): Interpretation[] {
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
