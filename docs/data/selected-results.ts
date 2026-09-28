/** Canonical parser, selector, and projection for terminal observations. */
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import {
  OBSERVATION_EVIDENCE,
  OBSERVATION_OUTCOMES,
  OBSERVATION_REASONS,
  type Interpretation,
  type Observation,
  type ProbeAssertion,
  type ProbeRun,
  type ProbeTarget,
  type RunOrigin,
  type AppLaunchReceipt,
  type HeadlessRuntimeIdentity,
  type UngradedDiagnostic,
  type ProbeSuiteManifest,
} from "@terminfo/probe-defs"
import { verifyTerminalIdentity, TERMINAL_IDENTITY_RULES } from "terminfo.dev/src/identity-guard.ts"

export interface LoadedRun {
  path: string
  sha256: string
  schemaVersion: 1 | 2
  runId: string
  target: ProbeTarget
  identity: ProbeRun["identity"]
  runtimeIdentity?: HeadlessRuntimeIdentity
  suiteId: string
  probeHash: string | null
  suiteComplete: boolean
  suiteProbeCount: number | null
  sourceRevision: string | null
  measuredAt: string
  origin: RunOrigin
  rawReplies: Record<string, string>
  assertions: ProbeAssertion[]
  screenshotRefs: string[]
  observations: Observation[]
  ungradedDiagnostics: Record<string, UngradedDiagnostic>
  legacy: boolean
}

export interface SelectedCell extends Observation {
  conclusive: boolean
  record: {
    rawReply?: string
    assertions: ProbeAssertion[]
    screenshot?: { url: string; sha256: string }
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
const screenshotDigest = (value: unknown): value is string =>
  typeof value === "string" && /^sha256:[0-9a-f]{64}$/.test(value)
const date = (value: unknown): value is string => nonempty(value) && !Number.isNaN(Date.parse(value))
function fail(path: string, message: string): never {
  throw new Error(`${path}: ${message}`)
}
const asString = (value: unknown, path: string, name: string): string =>
  nonempty(value) ? value : fail(path, `missing ${name}`)
const nullableString = (value: unknown, path: string, name: string): string | null =>
  value === null ? null : asString(value, path, name)

/** JSON.parse drops duplicate keys. Reject them before any evidence is selected. */
function rejectDuplicateKeys(source: string, path: string): void {
  let i = 0
  const ws = () => {
    while (/\s/.test(source[i] ?? "")) i++
  }
  const quoted = (): string => {
    const start = i++
    while (i < source.length) {
      if (source[i] === "\\") {
        i += 2
        continue
      }
      if (source[i++] === '"') break
    }
    return JSON.parse(source.slice(start, i)) as string
  }
  const value = (): void => {
    ws()
    if (source[i] === "{") {
      i++
      const keys = new Set<string>()
      ws()
      while (source[i] !== "}") {
        const key = quoted()
        if (keys.has(key)) fail(path, `duplicate key ${key}`)
        keys.add(key)
        ws()
        i++ // colon, already syntax-checked by JSON.parse
        value()
        ws()
        if (source[i] === ",") {
          i++
          ws()
        } else break
      }
      i++
    } else if (source[i] === "[") {
      i++
      ws()
      while (source[i] !== "]") {
        value()
        ws()
        if (source[i] === ",") {
          i++
          ws()
        } else break
      }
      i++
    } else if (source[i] === '"') {
      quoted()
    } else {
      while (i < source.length && !/[\s,}\]]/.test(source.charAt(i))) i++
    }
  }
  value()
}

export function parseJsonStrict(path: string, source: string): unknown {
  let parsed: unknown
  try {
    parsed = JSON.parse(source)
  } catch (error) {
    fail(path, `invalid JSON: ${String(error)}`)
  }
  rejectDuplicateKeys(source, path)
  return parsed
}

function parseTarget(value: unknown, path: string): ProbeTarget {
  if (!object(value)) fail(path, "missing target")
  if (!["app", "headless", "mux"].includes(String(value.kind))) fail(path, "invalid target.kind")
  return {
    kind: value.kind as ProbeTarget["kind"],
    id: asString(value.id, path, "target.id"),
    version: asString(value.version, path, "target.version"),
    os: nullableString(value.os, path, "target.os"),
    osVersion: nullableString(value.osVersion, path, "target.osVersion"),
    outerTerminal: nullableString(value.outerTerminal, path, "target.outerTerminal"),
    mux: nullableString(value.mux, path, "target.mux"),
    config: nullableString(value.config, path, "target.config"),
    permissions: nullableString(value.permissions, path, "target.permissions"),
  }
}

function parseRuntimeIdentity(value: unknown, target: ProbeTarget, path: string): HeadlessRuntimeIdentity | undefined {
  if (target.kind !== "headless") {
    if (value !== undefined) fail(path, "runtimeIdentity is only valid for headless targets")
    return undefined
  }
  if (!object(value) || !["js", "native"].includes(String(value.kind))) fail(path, "missing headless runtimeIdentity")
  const engineVersion = asString(value.engineVersion, path, "runtimeIdentity.engineVersion")
  if (engineVersion !== target.version) {
    fail(path, `runtimeIdentity.engineVersion ${engineVersion} conflicts with target.version ${target.version}`)
  }
  const adapterVersion = asString(value.adapterVersion, path, "runtimeIdentity.adapterVersion")
  const termlessRevision = asString(value.termlessRevision, path, "runtimeIdentity.termlessRevision")
  const sha256 = (digest: unknown, field: string): string => {
    const parsed = asString(digest, path, field)
    if (!/^[0-9a-f]{64}$/.test(parsed)) fail(path, `${field} must be SHA256`)
    return parsed
  }
  const loadedBinary = (binary: unknown): { path: string; sha256: string } => {
    if (!object(binary)) fail(path, "runtimeIdentity.loadedBinary is missing")
    return {
      path: asString(binary.path, path, "runtimeIdentity.loadedBinary.path"),
      sha256: sha256(binary.sha256, "runtimeIdentity.loadedBinary.sha256"),
    }
  }
  const cleanTree = (value: unknown): boolean => {
    if (typeof value !== "boolean") fail(path, "runtimeIdentity.integrity.cleanTree must be boolean")
    return value
  }
  if (value.kind === "js") {
    if (!object(value.integrity)) fail(path, "runtimeIdentity.integrity is missing")
    const integrity =
      value.integrity.kind === "registry"
        ? {
            kind: "registry" as const,
            lockIntegrity: asString(value.integrity.lockIntegrity, path, "runtimeIdentity.integrity.lockIntegrity"),
          }
        : value.integrity.kind === "source"
          ? {
              kind: "source" as const,
              repository: asString(value.integrity.repository, path, "runtimeIdentity.integrity.repository"),
              revision: asString(value.integrity.revision, path, "runtimeIdentity.integrity.revision"),
              treeOid: asString(value.integrity.treeOid, path, "runtimeIdentity.integrity.treeOid"),
              cleanTree: cleanTree(value.integrity.cleanTree),
            }
          : fail(path, "runtimeIdentity.integrity.kind must be registry or source")
    if (integrity.kind === "source") {
      if (
        !/^[0-9a-f]{40}$/.test(integrity.revision) ||
        !/^[0-9a-f]{40}$/.test(integrity.treeOid) ||
        typeof integrity.cleanTree !== "boolean"
      ) {
        fail(path, "runtimeIdentity source integrity has invalid revision, treeOid, or cleanTree")
      }
    }
    const runtimeFormat = value.runtimeFormat
    if (runtimeFormat !== "js" && runtimeFormat !== "wasm") {
      fail(path, "runtimeIdentity.runtimeFormat must be js or wasm")
    }
    const common = {
      kind: "js" as const,
      engineVersion,
      resolvedPath: asString(value.resolvedPath, path, "runtimeIdentity.resolvedPath"),
      integrity,
      adapterVersion,
      termlessRevision,
    }
    if (runtimeFormat === "wasm") return { ...common, runtimeFormat, loadedBinary: loadedBinary(value.loadedBinary) }
    if (value.loadedBinary !== undefined) fail(path, "pure JS runtimeIdentity cannot claim loadedBinary")
    return {
      ...common,
      runtimeFormat,
    }
  }
  const binary = loadedBinary(value.loadedBinary)
  if (!object(value.provenance)) fail(path, "runtimeIdentity.provenance is missing")
  const provenance = {
    sha256: sha256(value.provenance.sha256, "runtimeIdentity.provenance.sha256"),
    sourceCommit: asString(value.provenance.sourceCommit, path, "runtimeIdentity.provenance.sourceCommit"),
    buildHash: sha256(value.provenance.buildHash, "runtimeIdentity.provenance.buildHash"),
    toolchain: asString(value.provenance.toolchain, path, "runtimeIdentity.provenance.toolchain"),
    lockSha256: sha256(value.provenance.lockSha256, "runtimeIdentity.provenance.lockSha256"),
  }
  if (provenance.sha256 !== binary.sha256) fail(path, "native sidecar SHA256 differs from loaded binary")
  return {
    kind: "native",
    engineVersion,
    loadedBinary: binary,
    provenance,
    adapterVersion,
    termlessRevision,
  }
}

function parseObservation(
  value: unknown,
  path: string,
  catalog: Set<string>,
  rawReplies: Record<string, string>,
  assertions: ProbeAssertion[],
  screenshotRefs: string[],
): Observation {
  if (!object(value)) fail(path, "invalid observation")
  const featureId = asString(value.featureId, path, "observation.featureId")
  if (!catalog.has(featureId)) fail(path, `unknown feature ${featureId}`)
  validateObservationOutcome(value, path, featureId)
  const rawReplyRef =
    value.rawReplyRef === undefined ? undefined : asString(value.rawReplyRef, path, `rawReplyRef for ${featureId}`)
  if (rawReplyRef && !Object.hasOwn(rawReplies, rawReplyRef)) {
    fail(path, `missing raw reply ${rawReplyRef} for ${featureId}`)
  }
  const screenshotRef =
    value.screenshotRef === undefined
      ? undefined
      : asString(value.screenshotRef, path, `screenshotRef for ${featureId}`)
  if (value.evidence === "pixels" && !screenshotRef) {
    fail(path, `pixels observation ${featureId} requires screenshotRef`)
  }
  if (screenshotRef && !screenshotRefs.includes(screenshotRef)) {
    fail(path, `screenshotRef ${screenshotRef} is absent from run`)
  }
  const observation: Observation = {
    featureId,
    outcome: value.outcome as Observation["outcome"],
    evidence: value.evidence as Observation["evidence"],
  }
  if (value.reason !== undefined) observation.reason = value.reason as Observation["reason"]
  if (rawReplyRef) observation.rawReplyRef = rawReplyRef
  if (screenshotRef) observation.screenshotRef = screenshotRef
  if (value.note !== undefined) observation.note = asString(value.note, path, `note for ${featureId}`)
  validateObservation(observation, path, rawReplies, assertions)
  return observation
}

function validateObservation(
  observation: Observation,
  path: string,
  rawReplies: Record<string, string>,
  assertions: readonly ProbeAssertion[],
): void {
  const { featureId, evidence, outcome, rawReplyRef } = observation
  if (rawReplyRef && !Object.hasOwn(rawReplies, rawReplyRef)) {
    fail(path, `missing raw reply ${rawReplyRef} for ${featureId}`)
  }
  if (outcome !== "supported" && outcome !== "unsupported") return
  if (evidence === "consumed" || evidence === "legacy" || evidence === "pixels") return
  const kind = outcome === "supported" ? "positive" : "negative"
  const assertion = assertions.find(
    (entry) =>
      entry.featureId === featureId &&
      entry.kind === kind &&
      nonempty(rawReplyRef) &&
      entry.rawReplyRef === rawReplyRef,
  )
  if (!assertion) fail(path, `${featureId} lacks bound ${kind} assertion`)
  if (!nonempty(assertion.expected) || !nonempty(assertion.observed)) {
    fail(path, `${featureId} assertion requires expected and observed evidence`)
  }
  if (evidence === "parser-state" || evidence === "interaction") {
    const state = parseJsonStrict(`${path}: ${featureId} state snapshot`, assertion.observed)
    if (!object(state) || Object.keys(state).length === 0) fail(path, `${featureId} requires an actual state snapshot`)
    if (evidence === "interaction" && !nonempty(assertion.action)) {
      fail(path, `${featureId} requires the performed action`)
    }
  }
}

function parseDiagnostics(
  value: unknown,
  path: string,
  catalog: Set<string>,
  observations: readonly Observation[],
): Record<string, UngradedDiagnostic> {
  if (value === undefined) return {}
  if (!object(value)) fail(path, "invalid ungradedDiagnostics")
  const diagnostics: Record<string, UngradedDiagnostic> = {}
  for (const [id, entry] of Object.entries(value)) {
    if (!catalog.has(id)) fail(path, `unknown diagnostic feature ${id}`)
    if (observations.some((observation) => observation.featureId === id)) {
      fail(path, `${id} occurs in both observations and ungradedDiagnostics`)
    }
    if (!object(entry)) fail(path, `invalid diagnostic for ${id}`)
    const allowed =
      entry.kind === "legacy-callback" ? ["kind", "pass", "note", "response"] : ["kind", "name", "message"]
    if (Object.keys(entry).some((key) => !allowed.includes(key))) fail(path, `invalid diagnostic fields for ${id}`)
    if (entry.kind === "legacy-callback" && typeof entry.pass === "boolean") {
      for (const key of ["note", "response"]) {
        if (entry[key] !== undefined && typeof entry[key] !== "string") {
          fail(path, `invalid diagnostic ${key} for ${id}`)
        }
      }
    } else if (entry.kind === "collector-error" && nonempty(entry.name)) {
      if (entry.message !== undefined && typeof entry.message !== "string") {
        fail(path, `invalid diagnostic message for ${id}`)
      }
    } else fail(path, `invalid diagnostic for ${id}`)
    diagnostics[id] = entry as UngradedDiagnostic
  }
  return diagnostics
}

function validateObservationOutcome(value: Record<string, unknown>, path: string, featureId: string): void {
  if (!OBSERVATION_OUTCOMES.includes(value.outcome as Observation["outcome"])) {
    fail(path, `invalid outcome for ${featureId}`)
  }
  if (!OBSERVATION_EVIDENCE.includes(value.evidence as Observation["evidence"])) {
    fail(path, `invalid evidence for ${featureId}`)
  }
  if (value.reason !== undefined && !OBSERVATION_REASONS.includes(value.reason as NonNullable<Observation["reason"]>)) {
    fail(path, `invalid reason for ${featureId}`)
  }
  if ((value.outcome === "error" || value.outcome === "inconclusive") && !value.reason) {
    fail(path, `missing reason for ${featureId}`)
  }
  if ((value.outcome === "supported" || value.outcome === "unsupported") && value.reason) {
    fail(path, `conclusive ${featureId} cannot have an unknown-cause reason`)
  }
}

export function parseSuiteManifest(path: string, source: string): ProbeSuiteManifest {
  const value = parseJsonStrict(path, source)
  if (
    !object(value) ||
    Object.keys(value).sort().join(",") !== "adapterVersion,generatedAt,probeHash,probes,sourceRevision"
  ) {
    fail(path, "invalid suite manifest shape")
  }
  const probeHash = asString(value.probeHash, path, "suite probeHash")
  const adapterVersion = asString(value.adapterVersion, path, "suite adapterVersion")
  if (typeof value.sourceRevision !== "string" || !/^[0-9a-f]{40}$/.test(value.sourceRevision)) {
    fail(path, "invalid suite sourceRevision")
  }
  if (!date(value.generatedAt) || new Date(value.generatedAt).toISOString() !== value.generatedAt) {
    fail(path, "invalid suite generatedAt")
  }
  if (!object(value.probes) || Object.keys(value.probes).sort().join(",") !== "app,headless,mux") {
    fail(path, "invalid suite probe kinds")
  }
  const probes: ProbeSuiteManifest["probes"] = { app: [], headless: [], mux: [] }
  for (const kind of ["app", "headless", "mux"] as const) {
    const ids = value.probes[kind]
    if (!Array.isArray(ids) || !ids.every(nonempty) || new Set(ids).size !== ids.length) {
      fail(path, `invalid ${kind} suite membership`)
    }
    probes[kind] = ids
  }
  return { probeHash, sourceRevision: value.sourceRevision, generatedAt: value.generatedAt, adapterVersion, probes }
}

function parseAppLaunchReceipt(
  value: unknown,
  originKind: RunOrigin["kind"],
  targetKind: ProbeTarget["kind"],
  path: string,
): AppLaunchReceipt | undefined {
  if (value === undefined) return undefined
  if (originKind !== "collector" || targetKind !== "app" || !object(value)) {
    fail(path, "appLaunch requires an app collector run")
  }
  const bundlePath = asString(value.bundlePath, path, "appLaunch.bundlePath")
  const cfBundleShortVersionString = asString(
    value.cfBundleShortVersionString,
    path,
    "appLaunch.cfBundleShortVersionString",
  )
  const cfBundleVersion = asString(value.cfBundleVersion, path, "appLaunch.cfBundleVersion")
  const executablePath = asString(value.executablePath, path, "appLaunch.executablePath")
  if (!bundlePath.startsWith("/") || !executablePath.startsWith("/")) {
    fail(path, "appLaunch bundle and executable paths must be absolute")
  }
  if (!/^[a-f0-9]{64}$/.test(String(value.executableSha256))) {
    fail(path, "invalid appLaunch.executableSha256")
  }
  if (!object(value.sourceArtifact)) fail(path, "missing appLaunch.sourceArtifact")
  const sourcePath = asString(value.sourceArtifact.path, path, "appLaunch.sourceArtifact.path")
  if (!sourcePath.startsWith("/") || !/^[a-f0-9]{64}$/.test(String(value.sourceArtifact.sha256))) {
    fail(path, "invalid appLaunch.sourceArtifact")
  }
  return {
    bundlePath,
    cfBundleShortVersionString,
    cfBundleVersion,
    executablePath,
    executableSha256: value.executableSha256 as string,
    sourceArtifact: { path: sourcePath, sha256: value.sourceArtifact.sha256 as string },
  }
}

export function parseRun(
  path: string,
  source: string,
  catalogIds: readonly string[],
  suites: ReadonlyMap<string, ProbeSuiteManifest> = new Map(),
): LoadedRun {
  const raw = parseJsonStrict(path, source)
  if (!object(raw)) fail(path, "run must be an object")
  if (raw.schemaVersion !== undefined && raw.schemaVersion !== 2) {
    fail(path, `unsupported schemaVersion ${String(raw.schemaVersion)}`)
  }
  const catalog = new Set(catalogIds)
  const sha256 = createHash("sha256").update(source).digest("hex")
  if (raw.schemaVersion === 2) {
    const target = parseTarget(raw.target, path)
    const runtimeIdentity = parseRuntimeIdentity(raw.runtimeIdentity, target, path)
    const runId = asString(raw.runId, path, "runId")
    if (!["verified", "unverified", "disputed"].includes(String(raw.identity))) fail(path, "invalid identity")
    if (!object(raw.origin) || !["collector", "community-issue", "manual-capture"].includes(String(raw.origin.kind))) {
      fail(path, "invalid origin")
    }
    const appLaunch = parseAppLaunchReceipt(
      raw.origin.appLaunch,
      raw.origin.kind as RunOrigin["kind"],
      target.kind,
      path,
    )
    if (!object(raw.rawReplies) || !Object.values(raw.rawReplies).every((v) => typeof v === "string")) {
      fail(path, "invalid rawReplies")
    }
    if (
      !Array.isArray(raw.assertions) ||
      !Array.isArray(raw.screenshotRefs) ||
      !raw.screenshotRefs.every(screenshotDigest)
    ) {
      fail(path, "invalid assertions or screenshotRefs")
    }
    const assertions = raw.assertions as ProbeAssertion[]
    for (const assertion of assertions) {
      if (
        !object(assertion) ||
        !catalog.has(assertion.featureId) ||
        !["positive", "negative"].includes(assertion.kind)
      ) {
        fail(path, "invalid assertion")
      }
      if (assertion.rawReplyRef && !Object.hasOwn(raw.rawReplies, assertion.rawReplyRef)) {
        fail(path, `missing assertion raw reply ${assertion.rawReplyRef}`)
      }
    }
    if (!Array.isArray(raw.observations)) fail(path, "missing observations")
    const observations = raw.observations.map((v) =>
      parseObservation(
        v,
        path,
        catalog,
        raw.rawReplies as Record<string, string>,
        assertions,
        raw.screenshotRefs as string[],
      ),
    )
    if (new Set(observations.map((v) => v.featureId)).size !== observations.length) {
      fail(path, "duplicate observation feature ID")
    }
    if (raw.suiteComplete !== true && raw.suiteComplete !== false) fail(path, "missing suiteComplete")
    const probeHash = asString(raw.probeHash, path, "probeHash")
    const manifest = suites.get(probeHash)
    if (!manifest || manifest.probeHash !== probeHash) {
      fail(path, `unknown suite ${probeHash}; missing trusted manifest`)
    }
    const expected = new Set(manifest.probes[target.kind])
    for (const observation of observations) {
      if (!expected.has(observation.featureId)) {
        fail(path, `${observation.featureId} is outside suite ${probeHash} for ${target.kind}`)
      }
    }
    const suiteComplete = observations.length === expected.size
    if (raw.suiteComplete !== suiteComplete) {
      fail(path, `suiteComplete disagrees with observed membership (${observations.length} of ${expected.size} probes)`)
    }
    if (!date(raw.measuredAt)) fail(path, "invalid measuredAt")
    return {
      path,
      sha256,
      schemaVersion: 2,
      runId,
      target,
      identity: raw.identity as LoadedRun["identity"],
      ...(runtimeIdentity && { runtimeIdentity }),
      suiteId: asString(raw.suiteId, path, "suiteId"),
      probeHash,
      suiteComplete,
      suiteProbeCount: expected.size,
      sourceRevision: asString(raw.sourceRevision, path, "sourceRevision"),
      measuredAt: raw.measuredAt,
      origin: {
        kind: raw.origin.kind as RunOrigin["kind"],
        ...(typeof raw.origin.url === "string" && { url: raw.origin.url }),
        ...(appLaunch && { appLaunch }),
      },
      rawReplies: raw.rawReplies as Record<string, string>,
      assertions,
      screenshotRefs: raw.screenshotRefs as string[],
      observations,
      ungradedDiagnostics: parseDiagnostics(raw.ungradedDiagnostics, path, catalog, observations),
      legacy: false,
    }
  }

  // Existing boolean captures are preserved byte-for-byte and never graded.
  const kind: ProbeTarget["kind"] = path.includes("probes-mux/") ? "mux" : raw.backend ? "headless" : "app"
  const id = asString(raw.backend ?? raw.terminal, path, "backend/terminal")
  const version = asString(raw.version ?? raw.terminalVersion, path, "version")
  if (!date(raw.generated)) fail(path, "invalid generated timestamp")
  if (!object(raw.results)) fail(path, "missing results")
  const observations: Observation[] = []
  for (const [featureId, value] of Object.entries(raw.results)) {
    if (!catalog.has(featureId)) fail(path, `unknown feature ${featureId}`)
    if (typeof value !== "boolean") fail(path, `invalid legacy result for ${featureId}`)
    observations.push({ featureId, outcome: value ? "supported" : "unsupported", evidence: "legacy" })
  }
  const target: ProbeTarget = {
    kind,
    id,
    version,
    os: typeof raw.os === "string" ? raw.os : null,
    osVersion: typeof raw.osVersion === "string" ? raw.osVersion : null,
    outerTerminal: null,
    mux: null,
    config: null,
    permissions: null,
  }
  return {
    path,
    sha256,
    schemaVersion: 1,
    runId: typeof raw.runId === "string" ? raw.runId : `legacy-${sha256.slice(0, 16)}`,
    target,
    identity: "unverified",
    suiteId: "legacy",
    probeHash: typeof raw.probeHash === "string" ? raw.probeHash : null,
    suiteComplete: false,
    suiteProbeCount: null,
    sourceRevision: null,
    measuredAt: raw.generated,
    origin: { kind: "collector" },
    rawReplies:
      object(raw.responses) && Object.values(raw.responses).every((v) => typeof v === "string")
        ? (raw.responses as Record<string, string>)
        : {},
    assertions: [],
    screenshotRefs: [],
    observations,
    ungradedDiagnostics: {},
    legacy: true,
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
  for (const entry of raw as Interpretation[]) {
    for (const superseded of entry.supersedes) {
      if (!ids.has(superseded)) fail(path, `interpretation ${entry.id} supersedes unknown ${superseded}`)
    }
  }
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
        observation.evidence !== "consumed" &&
        observation.evidence !== "legacy" &&
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
    if (!run.observations.some((observation) => observation.featureId === entry.featureId)) {
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
    cells[entry.featureId] = {
      ...observation,
      record: observationRecord(run, observation),
      conclusive:
        !run.legacy &&
        observation.evidence !== "consumed" &&
        observation.evidence !== "legacy" &&
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
  const active = activeInterpretations(interpretations)
  const ids = new Set<string>()
  for (const run of runs) {
    if (ids.has(run.runId)) throw new Error(`duplicate runId ${run.runId}`)
    ids.add(run.runId)
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

/** When artifactDir is supplied by a build, emit the exact bytes verified by this loader. */
export function loadSelectedResults(
  contentDir: string,
  currentProbeHash: string,
  options: { artifactDir?: string } = {},
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
        const digest = ref.slice("sha256:".length)
        const artifactPath = join(contentDir, "artifacts", `${digest}.png`)
        if (!existsSync(artifactPath)) fail(runPath, `missing screenshot artifact ${artifactPath}`)
        const bytes = readFileSync(artifactPath)
        if (createHash("sha256").update(bytes).digest("hex") !== digest) {
          fail(runPath, `screenshot artifact digest mismatch at ${artifactPath}`)
        }
        if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
          fail(runPath, `screenshot artifact is not a PNG at ${artifactPath}`)
        }
        if (options.artifactDir) {
          mkdirSync(options.artifactDir, { recursive: true })
          const publishedPath = join(options.artifactDir, `${digest}.png`)
          if (existsSync(publishedPath)) {
            if (!readFileSync(publishedPath).equals(bytes)) {
              fail(publishedPath, "existing screenshot artifact differs from verified bytes")
            }
          } else {
            writeFileSync(publishedPath, bytes, { flag: "wx" })
          }
        }
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
