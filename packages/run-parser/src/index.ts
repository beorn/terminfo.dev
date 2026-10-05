/** Canonical parser and decoder for immutable terminal runs. */
import { createHash } from "node:crypto"
import {
  OBSERVATION_EVIDENCE,
  OBSERVATION_OUTCOMES,
  OBSERVATION_REASONS,
  isNonMeasuringEvidence,
  type NotTestedCoverage,
  type Observation,
  type ObservationFrame,
  type ProbeAssertion,
  type ProbeRun,
  type ProbeTarget,
  type RunOrigin,
  type AppLaunchReceipt,
  type HeadlessRuntimeIdentity,
  type RunProvenance,
  type UngradedDiagnostic,
  type ProbeSuiteManifest,
} from "@terminfo/probe-defs"

export interface LoadedRun {
  path: string
  sha256: string
  schemaVersion: 1 | 2
  runId: string
  target: ProbeTarget
  identity: ProbeRun["identity"]
  runtimeIdentity?: HeadlessRuntimeIdentity
  provenance?: RunProvenance
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
  notTested: NotTestedCoverage[]
  ungradedDiagnostics: Record<string, UngradedDiagnostic>
  legacy: boolean
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

export function parseObservationFrames(
  value: unknown,
  path: string,
  featureId: string,
  screenshotRefs: readonly string[],
  primaryRef: string | undefined,
  evidence: Observation["evidence"],
): ObservationFrame[] | undefined {
  if (value === undefined) return undefined
  if (evidence !== "pixels" || !Array.isArray(value) || value.length < 2) {
    fail(path, `invalid frames for ${featureId}; pixels require control and target`)
  }
  const frames: ObservationFrame[] = value.map((entry: unknown, index: number) => {
    if (!object(entry) || !["control", "target"].includes(String(entry.role))) {
      fail(path, `invalid frame role ${index} for ${featureId}`)
    }
    const ref = asString(entry.ref, path, `frame ${index} ref for ${featureId}`)
    if (!screenshotDigest(ref)) fail(path, `invalid frame ref ${index} for ${featureId}`)
    if (!screenshotRefs.includes(ref)) fail(path, `frame ${ref} is absent from run`)
    if (typeof entry.capturedAt !== "number" || !Number.isFinite(entry.capturedAt) || entry.capturedAt < 0) {
      fail(path, `invalid frame capturedAt ${index} for ${featureId}`)
    }
    const label = asString(entry.label, path, `frame ${index} label for ${featureId}`)
    const sourceRef = entry.sourceRef
    if (sourceRef !== undefined && !screenshotDigest(sourceRef)) {
      fail(path, `invalid frame sourceRef ${index} for ${featureId}`)
    }
    return {
      role: entry.role as ObservationFrame["role"],
      ref,
      capturedAt: entry.capturedAt,
      label,
      ...(sourceRef && { sourceRef }),
    }
  })
  const targets = frames.filter((frame) => frame.role === "target")
  if (!frames.some((frame) => frame.role === "control") || targets.length === 0) {
    fail(path, `frames for ${featureId} require control and target`)
  }
  if (!primaryRef || !targets.some((frame) => frame.ref === primaryRef)) {
    fail(path, `primary screenshotRef for ${featureId} must be a target frame`)
  }
  let priorTargetAt = -1
  for (const targetFrame of targets) {
    if (targetFrame.capturedAt <= priorTargetAt) {
      fail(path, `target frames for ${featureId} require strictly increasing capturedAt`)
    }
    priorTargetAt = targetFrame.capturedAt
  }
  return frames
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
  if (value.evidence === "none" && value.screenshotRef !== undefined) {
    fail(path, `none evidence for ${featureId} cannot carry screenshotRef`)
  }
  if (value.evidence === "none" && value.frames !== undefined) {
    fail(path, `none evidence for ${featureId} cannot carry frames`)
  }
  if (value.evidence === "pixels" && (value.outcome === "supported" || value.outcome === "unsupported")) {
    fail(path, `collector pixels for ${featureId} must remain inconclusive until reviewed Interpretation`)
  }
  const rawReplyRef =
    value.rawReplyRef === undefined ? undefined : asString(value.rawReplyRef, path, `rawReplyRef for ${featureId}`)
  if (rawReplyRef && !Object.hasOwn(rawReplies, rawReplyRef)) {
    fail(path, `missing raw reply ${rawReplyRef} for ${featureId}`)
  }
  const screenshotRef =
    value.screenshotRef === undefined
      ? undefined
      : asString(value.screenshotRef, path, `screenshotRef for ${featureId}`)
  if (value.evidence === "pixels" && value.outcome !== "error" && !screenshotRef) {
    fail(path, `pixels observation ${featureId} requires screenshotRef`)
  }
  if (screenshotRef && !screenshotRefs.includes(screenshotRef)) {
    fail(path, `screenshotRef ${screenshotRef} is absent from run`)
  }
  const frames = parseObservationFrames(
    value.frames,
    path,
    featureId,
    screenshotRefs,
    screenshotRef,
    value.evidence as Observation["evidence"],
  )
  const observation: Observation = {
    featureId,
    outcome: value.outcome as Observation["outcome"],
    evidence: value.evidence as Observation["evidence"],
  }
  if (value.reason !== undefined) observation.reason = value.reason as Observation["reason"]
  if (rawReplyRef) observation.rawReplyRef = rawReplyRef
  if (screenshotRef) observation.screenshotRef = screenshotRef
  if (frames) observation.frames = frames
  if (value.note !== undefined) observation.note = asString(value.note, path, `note for ${featureId}`)
  validateObservation(observation, path, rawReplies, assertions)
  return observation
}

export function validateObservation(
  observation: Observation,
  path: string,
  rawReplies: Record<string, string>,
  assertions: readonly ProbeAssertion[],
): void {
  const { featureId, evidence, outcome, rawReplyRef } = observation
  if (rawReplyRef && !Object.hasOwn(rawReplies, rawReplyRef)) {
    fail(path, `missing raw reply ${rawReplyRef} for ${featureId}`)
  }
  if ((outcome === "supported" || outcome === "unsupported") && isNonMeasuringEvidence(evidence)) {
    fail(path, `conclusive ${featureId} cannot use ${evidence} evidence`)
  }
  if (evidence === "none") {
    if (
      outcome !== "inconclusive" ||
      (observation.reason !== "policy-refused" && observation.reason !== "insufficient-evidence")
    ) {
      fail(path, `none evidence for ${featureId} requires inconclusive policy-refused or insufficient-evidence outcome`)
    }
    if (observation.screenshotRef !== undefined || observation.frames !== undefined) {
      fail(path, `none evidence for ${featureId} cannot carry screenshotRef or frames`)
    }
    if (!rawReplyRef || rawReplyRef !== featureId) {
      fail(path, `none evidence for ${featureId} requires its own rawReplyRef`)
    }
    const rawTrace = rawReplies[rawReplyRef]
    if (typeof rawTrace !== "string") fail(path, `none evidence for ${featureId} requires its own raw trace`)
    const trace = parseJsonStrict(`${path}: ${featureId} none trace`, rawTrace)
    if (
      !object(trace) ||
      Object.keys(trace).sort().join(",") !== "events,queries,writes" ||
      !Array.isArray(trace.writes) ||
      trace.writes.length !== 0 ||
      !Array.isArray(trace.queries) ||
      trace.queries.length !== 0 ||
      !Array.isArray(trace.events) ||
      trace.events.length !== 0 ||
      assertions.some((entry) => entry.featureId === featureId)
    ) {
      fail(path, `none evidence for ${featureId} requires a zero-byte trace without assertions`)
    }
  }
  if (outcome !== "supported" && outcome !== "unsupported") return
  if (evidence === "pixels") return
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

export function validateObservationOutcome(value: Record<string, unknown>, path: string, featureId: string): void {
  if (!OBSERVATION_OUTCOMES.includes(value.outcome as Observation["outcome"])) {
    fail(path, `invalid outcome for ${featureId}`)
  }
  if (!OBSERVATION_EVIDENCE.includes(value.evidence as Observation["evidence"])) {
    fail(path, `invalid evidence for ${featureId}`)
  }
  if (value.reason !== undefined && !OBSERVATION_REASONS.includes(value.reason as NonNullable<Observation["reason"]>)) {
    fail(path, `invalid reason for ${featureId}`)
  }
  if (value.reason === "insufficient-evidence" && value.outcome !== "inconclusive") {
    fail(path, `insufficient-evidence requires inconclusive outcome for ${featureId}`)
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
  let sourceArtifact: AppLaunchReceipt["sourceArtifact"]
  if (value.sourceArtifact.kind === "sealed-macos-system-volume") {
    if (
      Object.keys(value.sourceArtifact).sort().join(",") !==
      "codeSignature,kind,macOSBuild,sealed,snapshotName,snapshotUUID"
    ) {
      fail(path, "invalid sealed appLaunch.sourceArtifact fields")
    }
    const macOSBuild = asString(value.sourceArtifact.macOSBuild, path, "appLaunch.sourceArtifact.macOSBuild")
    const snapshotUUID = asString(value.sourceArtifact.snapshotUUID, path, "appLaunch.sourceArtifact.snapshotUUID")
    const snapshotName = asString(value.sourceArtifact.snapshotName, path, "appLaunch.sourceArtifact.snapshotName")
    if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(snapshotUUID)) {
      fail(path, "invalid appLaunch.sourceArtifact.snapshotUUID")
    }
    if (value.sourceArtifact.sealed !== true) fail(path, "appLaunch.sourceArtifact.sealed must be true")
    if (!object(value.sourceArtifact.codeSignature)) fail(path, "missing appLaunch.sourceArtifact.codeSignature")
    const identifier = asString(
      value.sourceArtifact.codeSignature.identifier,
      path,
      "appLaunch.codeSignature.identifier",
    )
    const cdHash = asString(value.sourceArtifact.codeSignature.cdHash, path, "appLaunch.codeSignature.cdHash")
    if (!/^[a-f0-9]{40}$/.test(cdHash)) fail(path, "invalid appLaunch.sourceArtifact.codeSignature.cdHash")
    if (value.sourceArtifact.codeSignature.strictVerified !== true) {
      fail(path, "appLaunch.sourceArtifact.codeSignature.strictVerified must be true")
    }
    sourceArtifact = {
      kind: "sealed-macos-system-volume",
      macOSBuild,
      snapshotUUID,
      snapshotName,
      sealed: true,
      codeSignature: { identifier, cdHash, strictVerified: true },
    }
  } else if (value.sourceArtifact.kind === undefined) {
    const sourcePath = asString(value.sourceArtifact.path, path, "appLaunch.sourceArtifact.path")
    if (!sourcePath.startsWith("/") || !/^[a-f0-9]{64}$/.test(String(value.sourceArtifact.sha256))) {
      fail(path, "invalid appLaunch.sourceArtifact")
    }
    sourceArtifact = { path: sourcePath, sha256: value.sourceArtifact.sha256 as string }
  } else {
    fail(path, "unknown appLaunch.sourceArtifact kind")
  }
  return {
    bundlePath,
    cfBundleShortVersionString,
    cfBundleVersion,
    executablePath,
    executableSha256: value.executableSha256 as string,
    sourceArtifact,
  }
}

/** The collector and loader share this validation before a native run is sealed or selected. */
export function parseRunProvenance(
  value: unknown,
  target: ProbeTarget,
  expected: { probeHash: string; sourceRevision: string },
  path: string,
): RunProvenance | undefined {
  if (value === undefined) return undefined
  if (target.kind !== "app") fail(path, "native provenance requires an app target")
  if (
    !object(value) ||
    !object(value.executable) ||
    !object(value.sourceArtifact) ||
    !object(value.runtime) ||
    !object(value.fixture)
  ) {
    fail(path, "invalid native provenance blocks")
  }
  const digest = (input: unknown, field: string): string => {
    const parsed = asString(input, path, field)
    if (!/^[a-f0-9]{64}$/.test(parsed)) fail(path, `invalid ${field} SHA256`)
    return parsed
  }
  const executablePath = asString(value.executable.path, path, "provenance.executable.path")
  if (!executablePath.startsWith("/")) fail(path, "provenance.executable.path must be absolute")
  const version = asString(value.executable.version, path, "provenance.executable.version")
  const versionTokens = version.match(/(?<![A-Za-z0-9.])\d+(?:\.\d+){1,3}(?:[-+][A-Za-z0-9.-]+)?(?![A-Za-z0-9.])/g)
  if (versionTokens?.length !== 1 || versionTokens[0] !== target.version) {
    fail(path, `provenance.executable.version differs from target.version ${target.version}`)
  }
  const sourceUrl = asString(value.sourceArtifact.url, path, "provenance.sourceArtifact.url")
  let parsedUrl: URL
  try {
    parsedUrl = new URL(sourceUrl)
  } catch {
    fail(path, "invalid provenance.sourceArtifact.url")
  }
  if (parsedUrl.protocol !== "https:") fail(path, "provenance.sourceArtifact.url must use HTTPS")
  const imageId = asString(value.runtime.imageId, path, "provenance.runtime.imageId")
  if (!/^sha256:[a-f0-9]{64}$/.test(imageId)) fail(path, "invalid provenance.runtime.imageId")
  const nixLockRevision = asString(value.runtime.nixLockRevision, path, "provenance.runtime.nixLockRevision")
  if (!/^[a-f0-9]{40}$/.test(nixLockRevision)) fail(path, "invalid provenance.runtime.nixLockRevision")
  const sourceRevision = asString(value.runtime.sourceRevision, path, "provenance.runtime.sourceRevision")
  if (!/^[a-f0-9]{40}$/.test(sourceRevision) || sourceRevision !== expected.sourceRevision) {
    fail(path, "provenance.runtime.sourceRevision differs from run sourceRevision")
  }
  const suiteHash = asString(value.runtime.suiteHash, path, "provenance.runtime.suiteHash")
  if (suiteHash !== expected.probeHash) fail(path, "provenance.runtime.suiteHash differs from run probeHash")
  if (typeof value.runtime.cleanTree !== "boolean") fail(path, "provenance.runtime.cleanTree must be boolean")
  return {
    executable: {
      path: executablePath,
      sha256: digest(value.executable.sha256, "provenance.executable.sha256"),
      version,
    },
    sourceArtifact: { url: sourceUrl, sha256: digest(value.sourceArtifact.sha256, "provenance.sourceArtifact.sha256") },
    runtime: {
      imageId,
      imageTarSha256: digest(value.runtime.imageTarSha256, "provenance.runtime.imageTarSha256"),
      arch: asString(value.runtime.arch, path, "provenance.runtime.arch"),
      nixLockRevision,
      sourceRevision,
      cleanTree: value.runtime.cleanTree,
      suiteHash,
    },
    fixture: {
      definition: asString(value.fixture.definition, path, "provenance.fixture.definition"),
      config: asString(value.fixture.config, path, "provenance.fixture.config"),
      font: asString(value.fixture.font, path, "provenance.fixture.font"),
      geometry: asString(value.fixture.geometry, path, "provenance.fixture.geometry"),
      display: asString(value.fixture.display, path, "provenance.fixture.display"),
      gl: asString(value.fixture.gl, path, "provenance.fixture.gl"),
    },
  }
}

function parseNotTested(
  value: unknown,
  path: string,
  catalog: Set<string>,
  expected: ReadonlySet<string>,
  rawReplies: Record<string, string>,
  observations: readonly Observation[],
  assertions: readonly ProbeAssertion[],
): NotTestedCoverage[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) fail(path, "invalid notTested")
  const records: NotTestedCoverage[] = []
  const seen = new Set<string>()
  for (const entry of value) {
    if (!object(entry)) fail(path, "invalid notTested record")
    const featureId = asString(entry.featureId, path, "notTested.featureId")
    if (!catalog.has(featureId)) fail(path, `unknown notTested feature ${featureId}`)
    if (!expected.has(featureId)) fail(path, `notTested ${featureId} is outside the trusted suite`)
    if (seen.has(featureId)) fail(path, `duplicate notTested feature ${featureId}`)
    seen.add(featureId)
    if (entry.reason !== "no-semantic-observable") fail(path, `invalid notTested reason for ${featureId}`)
    const noObservable = asString(entry.noObservable, path, `notTested.noObservable for ${featureId}`)
    if (noObservable.trim().length === 0) fail(path, `notTested ${featureId} requires a specific noObservable`)
    const rawReplyRef = asString(entry.rawReplyRef, path, `notTested.rawReplyRef for ${featureId}`)
    if (rawReplyRef !== featureId) {
      fail(path, `notTested ${featureId} requires its own rawReplyRef`)
    }
    const rawTrace = rawReplies[rawReplyRef]
    if (typeof rawTrace !== "string" || rawTrace.length === 0) {
      fail(path, `notTested ${featureId} requires a retained nonempty raw trace`)
    }
    if (entry.probeId !== undefined) {
      const probeId = asString(entry.probeId, path, `notTested.probeId for ${featureId}`)
      if (probeId !== featureId) fail(path, `notTested probeId ${probeId} does not identify ${featureId}`)
    }
    if (observations.some((item) => item.featureId === featureId)) {
      fail(path, `notTested ${featureId} also occurs in observations`)
    }
    if (assertions.some((item) => item.featureId === featureId)) {
      fail(path, `notTested ${featureId} also occurs in assertions`)
    }
    records.push({ featureId, reason: "no-semantic-observable", noObservable, rawReplyRef })
  }
  return records
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
    if (Object.hasOwn(raw, "results")) fail(path, "v2 run cannot contain legacy boolean results")
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
    const sourceRevision = asString(raw.sourceRevision, path, "sourceRevision")
    const provenance = parseRunProvenance(raw.provenance, target, { probeHash, sourceRevision }, path)
    const manifest = suites.get(probeHash)
    if (!manifest || manifest.probeHash !== probeHash) {
      fail(path, `unknown suite ${probeHash}; missing trusted manifest`)
    }
    const expected = new Set(manifest.probes[target.kind])
    for (const assertion of assertions) {
      if (!expected.has(assertion.featureId)) {
        fail(path, `assertion ${assertion.featureId} is outside suite ${probeHash} for ${target.kind}`)
      }
    }
    for (const observation of observations) {
      if (!expected.has(observation.featureId)) {
        fail(path, `${observation.featureId} is outside suite ${probeHash} for ${target.kind}`)
      }
    }
    const notTested = parseNotTested(
      raw.notTested,
      path,
      catalog,
      expected,
      raw.rawReplies as Record<string, string>,
      observations,
      assertions,
    )
    const suiteComplete = observations.length + notTested.length === expected.size
    if (raw.suiteComplete !== suiteComplete) {
      fail(
        path,
        `suiteComplete disagrees with observed and not-tested membership (${observations.length} measured + ${notTested.length} not tested of ${expected.size} probes)`,
      )
    }
    const ungradedDiagnostics = parseDiagnostics(raw.ungradedDiagnostics, path, catalog, observations)
    for (const id of Object.keys(ungradedDiagnostics)) {
      if (!expected.has(id)) fail(path, `diagnostic ${id} is outside suite ${probeHash} for ${target.kind}`)
      if (notTested.some((item) => item.featureId === id)) {
        fail(path, `diagnostic ${id} also occurs in notTested`)
      }
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
      ...(provenance && { provenance }),
      suiteId: asString(raw.suiteId, path, "suiteId"),
      probeHash,
      suiteComplete,
      suiteProbeCount: expected.size,
      sourceRevision,
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
      notTested,
      ungradedDiagnostics,
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
    notTested: [],
    ungradedDiagnostics: {},
    legacy: true,
  }
}

/** Decode file/HTTP bytes without replacing malformed UTF-8 or discarding a BOM. */
export function decodeExactUtf8(bytes: Uint8Array, path: string): string {
  let source: string
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch {
    return fail(path, "invalid UTF-8 in raw run")
  }
  if (!Buffer.from(source, "utf8").equals(Buffer.from(bytes))) {
    fail(path, "raw UTF-8 bytes change when decoded")
  }
  return source
}

/** One public/admin collector boundary over the same canonical run parser. */
export function decodeCollectorRun(
  path: string,
  raw: string,
  manifest: ProbeSuiteManifest,
  collectorRevision: string,
): { run: ProbeRun; raw: string; sha256: string } {
  const catalog = [...new Set(Object.values(manifest.probes).flat())]
  const measured = parseRun(path, raw, catalog, new Map([[manifest.probeHash, manifest]]))
  if (measured.schemaVersion !== 2) fail(path, "expected schemaVersion 2 collector run, not legacy boolean results")
  if (measured.probeHash !== manifest.probeHash || measured.suiteId !== manifest.probeHash) {
    fail(path, `collector suite differs from trusted ${manifest.probeHash}`)
  }
  if (measured.sourceRevision !== collectorRevision) {
    fail(path, `collector sourceRevision differs from trusted ${collectorRevision}`)
  }
  if (measured.identity !== "unverified" || measured.origin.kind !== "collector") {
    fail(path, "public collector run must have unverified identity and collector origin")
  }
  const run: ProbeRun = {
    schemaVersion: 2,
    runId: measured.runId,
    target: measured.target,
    identity: "unverified",
    ...(measured.runtimeIdentity && { runtimeIdentity: measured.runtimeIdentity }),
    ...(measured.provenance && { provenance: measured.provenance }),
    suiteId: measured.suiteId,
    probeHash: manifest.probeHash,
    suiteComplete: measured.suiteComplete,
    sourceRevision: collectorRevision,
    measuredAt: measured.measuredAt,
    origin: measured.origin,
    rawReplies: measured.rawReplies,
    assertions: measured.assertions,
    screenshotRefs: measured.screenshotRefs,
    observations: measured.observations,
    ...(measured.notTested.length > 0 && { notTested: measured.notTested }),
    ungradedDiagnostics: measured.ungradedDiagnostics,
  }
  return { run, raw, sha256: measured.sha256 }
}
