/** Canonical parser and decoder for immutable terminal runs. */
import { createHash } from "node:crypto"
import { isDeepStrictEqual } from "node:util"
import {
  SEMANTIC_PROMPT_SOURCE_REVIEW,
  HARNESS_INCOMPLETE_TEST,
  UNTESTABLE_ONLY_REVIEW_BRANCHES,
  SOURCE_ONLY_NEGATIVE_REVIEW_BRANCHES,
  HOST_INPUT_NAMES,
  type HostRecipeExpectation,
  type HostRecipeName,
  PROBE_STATUSES,
  parseSourceAnswerKey,
  initializeRunDraft,
  recordCollectorSelection,
  readCollectorSelection,
  readCollectorAttempt,
  collectorAttemptDigest,
  type RetainedHostRecipeCause,
  type RunDraft,
  type CapturedRunDraft,
  type HistoricalProbeRun,
  type ProbeResult,
  type ProbeAttempt,
  type ProbeTestResult,
  ASSERTION_TYPES,
  type AssertionType,
  TEXT_QUALIFICATION_SHAPES,
  type NotTestedCoverage,
  type Observation,
  type ProbeAssertion,
  type ProbeRun,
  type ProbeSubject,
  type RunOrigin,
  type HeadlessRuntimeIdentity,
  type RunProvenance,
  type OuterAppProof,
  type UngradedDiagnostic,
  type ProbeSuiteManifest,
  type TextQualification,
  type TextQualificationSpec,
  type TextQualificationShape,
  type TextCellsObservationFrame,
} from "@terminfo/probe-defs"
import { parseObservation, parseObservationFrames, validateCurrentAssertions } from "./observations.ts"
export { parseObservationFrames, validateObservation, validateObservationOutcome } from "./observations.ts"
import { parseJsonStrict } from "./json.ts"
export { parseJsonStrict, canonicalJson, FEATURE_ENTRY_PROSE_DENYLIST, boundFeatureEntry } from "./json.ts"
import { ALACRITTY_VERSION_PATTERN, PLACEHOLDER, parseAppLaunchReceipt, parseDerivedSourceTree } from "./app-launch.ts"

export { ALACRITTY_VERSION_PATTERN, parseAppLaunchReceipt, parseDerivedSourceTree }

interface LoadedRunFields {
  path: string
  sha256: string
  runId: string
  subject: ProbeSubject
  identity: ProbeRun["identity"]
  runtimeIdentity?: HeadlessRuntimeIdentity
  provenance?: RunProvenance
  outerApp?: OuterAppProof
  suiteId: string
  probeHash: string | null
  suiteComplete: boolean
  suiteProbeCount: number | null
  sourceRevision: string | null
  measuredAt: string
  origin: RunOrigin
  rawReplies: Record<string, string>
  screenshotRefs: string[]
  /** Retained text snapshots: the text-frame twin of `screenshotRefs`, kept separate
   * because every consumer of that list assumes a PNG. Absent in runs written before it exists. */
  textSnapshotRefs: string[]
  textQualification?: TextQualification
  textQualificationSpec?: TextQualificationSpec
  textClaims?: string[]
  notTested: NotTestedCoverage[]
  ungradedDiagnostics: Record<string, UngradedDiagnostic>
  legacy: boolean
  results?: ProbeResult[]
  catalogIds?: string[]
  intendedSubject?: Partial<ProbeSubject>
}

type ReadObservation = HistoricalProbeRun["observations"][number]
type ReadAssertion = HistoricalProbeRun["assertions"][number]
export type LoadedRun = LoadedRunFields &
  (
    | { schemaVersion: 4; source: RunDraft["source"]; assertions: ProbeAssertion[]; observations: Observation[] }
    | { schemaVersion: 1 | 2 | 3; source?: never; assertions: ReadAssertion[]; observations: ReadObservation[] }
  )

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

function parseCurrentSource(value: unknown, path: string): RunDraft["source"] {
  if (!object(value)) fail(path, "schema 4 requires source")
  const keys = (record: Record<string, unknown>, expected: string[]) =>
    Object.keys(record).length === expected.length && expected.every((key) => Object.hasOwn(record, key))
  if (value.kind === "live" && keys(value, ["kind"])) return { kind: "live" }
  if (
    value.kind !== "trace" ||
    !keys(value, ["kind", "trace", "captureRunId", "captureSuiteId", "captureSourceRevision"]) ||
    !object(value.trace) ||
    !keys(value.trace, ["path", "sha256"])
  ) {
    fail(path, "invalid source; require exactly { kind: live } or a bound trace source")
  }
  const artifact = value.trace
  if (
    !nonempty(artifact.path) ||
    !artifact.path.trim() ||
    /^(?:[\\/]|[a-z]:)/i.test(artifact.path) ||
    artifact.path.split(/[\\/]/).includes("..") ||
    typeof artifact.sha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(artifact.sha256) ||
    !nonempty(value.captureRunId) ||
    !value.captureRunId.trim() ||
    !nonempty(value.captureSuiteId) ||
    !value.captureSuiteId.trim() ||
    typeof value.captureSourceRevision !== "string" ||
    !/^[0-9a-f]{40}$/.test(value.captureSourceRevision)
  ) {
    fail(path, "invalid trace source artifact reference or capture identity")
  }
  return {
    kind: "trace",
    trace: { path: artifact.path, sha256: artifact.sha256 },
    captureRunId: value.captureRunId,
    captureSuiteId: value.captureSuiteId,
    captureSourceRevision: value.captureSourceRevision,
  }
}

function rejectUnknownFields(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  shape: string,
): void {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key))
  if (unknown !== undefined) fail(path, `unknown ${shape} field ${unknown}`)
}

export function parseSubject(value: unknown, path: string, schemaVersion: 2 | 3 | 4 = 4): ProbeSubject {
  const subjectKey = schemaVersion === 4 ? "subject" : "target"
  if (!object(value)) fail(path, `missing ${subjectKey}`)
  if (schemaVersion === 4) {
    rejectUnknownFields(
      value,
      ["kind", "id", "version", "os", "osVersion", "outerTerminal", "mux", "config", "permissions"],
      path,
      "subject",
    )
  }
  const kinds = schemaVersion === 4 ? ["term", "lib", "mux"] : ["app", "headless", "mux"]
  if (!kinds.includes(String(value.kind))) fail(path, `invalid ${schemaVersion === 4 ? "subject" : "target"}.kind`)
  const kind = value.kind === "app" ? "term" : value.kind === "headless" ? "lib" : value.kind

  return {
    kind: kind as ProbeSubject["kind"],
    id: asString(value.id, path, `${subjectKey}.id`),
    version: asString(value.version, path, `${subjectKey}.version`),
    os: nullableString(value.os, path, `${subjectKey}.os`),
    osVersion: nullableString(value.osVersion, path, `${subjectKey}.osVersion`),
    outerTerminal: nullableString(value.outerTerminal, path, `${subjectKey}.outerTerminal`),
    mux: nullableString(value.mux, path, `${subjectKey}.mux`),
    config: nullableString(value.config, path, `${subjectKey}.config`),
    permissions: nullableString(value.permissions, path, `${subjectKey}.permissions`),
  }
}

function normalizeIntendedSubject(value: unknown, schemaVersion: 2 | 3 | 4, path: string): Partial<ProbeSubject> {
  if (!object(value)) fail(path, `schema ${schemaVersion} requires intended subject`)
  const kinds = schemaVersion === 4 ? ["term", "lib", "mux"] : ["app", "headless", "mux"]
  if (value.kind !== undefined && !kinds.includes(String(value.kind))) fail(path, "invalid intended subject kind")
  return {
    ...value,
    ...(value.kind === undefined
      ? {}
      : { kind: value.kind === "app" ? "term" : value.kind === "headless" ? "lib" : value.kind }),
  } as Partial<ProbeSubject>
}

function parseRuntimeIdentity(
  value: unknown,
  subject: ProbeSubject,
  path: string,
  schemaVersion: 2 | 3 | 4,
): HeadlessRuntimeIdentity | undefined {
  if (subject.kind !== "lib") {
    if (value !== undefined) {
      fail(path, `runtimeIdentity is only valid for ${schemaVersion === 4 ? "lib subjects" : "headless targets"}`)
    }
    return undefined
  }
  if (!object(value) || !["js", "native"].includes(String(value.kind))) {
    fail(path, `missing ${schemaVersion === 4 ? "lib" : "headless"} runtimeIdentity`)
  }
  const engineVersion = asString(value.engineVersion, path, "runtimeIdentity.engineVersion")
  if (engineVersion !== subject.version) {
    fail(
      path,
      `runtimeIdentity.engineVersion ${engineVersion} conflicts with ${schemaVersion === 4 ? "subject" : "target"}.version ${subject.version}`,
    )
  }
  const adapterVersion = asString(value.adapterVersion, path, "runtimeIdentity.adapterVersion")
  const termlessRevision = asString(value.termlessRevision, path, "runtimeIdentity.termlessRevision")
  let adapterSources: HeadlessRuntimeIdentity["adapterSources"]
  if (value.adapterSources !== undefined) {
    if (!Array.isArray(value.adapterSources) || !value.adapterSources.length) {
      fail(path, "runtimeIdentity.adapterSources must be nonempty")
    }
    adapterSources = value.adapterSources.map((source, index) => {
      if (!object(source)) fail(path, `runtimeIdentity.adapterSources[${index}] must bind path/blobOid`)
      const sourcePath = asString(source.path, path, `runtimeIdentity.adapterSources[${index}].path`)
      const blobOid = asString(source.blobOid, path, `runtimeIdentity.adapterSources[${index}].blobOid`)
      if (!/^[0-9a-f]{40}$/.test(blobOid)) {
        fail(path, `runtimeIdentity.adapterSources[${index}].blobOid must be Git blob OID`)
      }
      return { path: sourcePath, blobOid }
    })
  }
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
      ...(adapterSources && { adapterSources }),
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
    ...(adapterSources && { adapterSources }),
  }
}

function parseTextQualificationSpec(
  value: unknown,
  path: string,
  fields: readonly string[] = ["version", "recipe"],
): TextQualificationSpec {
  if (!object(value)) fail(path, "invalid textQualification object")
  const unknown = Object.keys(value).find((key) => !fields.includes(key))
  if (unknown !== undefined) fail(path, `unknown textQualification field ${unknown}`)
  if (typeof value.version !== "number" || !Number.isSafeInteger(value.version) || value.version <= 0) {
    fail(path, "invalid textQualification version")
  }
  if (!nonempty(value.recipe) || !value.recipe.trim()) fail(path, "invalid textQualification recipe")
  return { version: value.version, recipe: value.recipe }
}

function parseTextQualification(
  value: unknown,
  path: string,
  textSnapshotRefs: readonly string[],
): TextQualification | undefined {
  if (value === undefined) return undefined
  const spec = parseTextQualificationSpec(value, path, ["version", "recipe", "grid", "shapes"])
  if (!object(value)) fail(path, "invalid textQualification object")
  const grid = value.grid
  if (
    !object(grid) ||
    Object.keys(grid).sort().join(",") !== "cols,rows" ||
    ![grid.rows, grid.cols].every((edge) => typeof edge === "number" && Number.isSafeInteger(edge) && edge > 0)
  ) {
    fail(path, "invalid textQualification grid")
  }
  if (!Array.isArray(value.shapes)) fail(path, "invalid textQualification shapes")
  const seen = new Set<string>()
  const shapes: TextQualification["shapes"] = value.shapes.map((entry: unknown) => {
    if (!object(entry) || !TEXT_QUALIFICATION_SHAPES.some((shape) => shape === entry.shape)) {
      fail(path, "invalid textQualification shape")
    }
    const shape = entry.shape as TextQualificationShape
    if (seen.has(shape)) fail(path, `duplicate textQualification shape ${shape}`)
    seen.add(shape)
    const context = `textQualification ${shape}`
    const unknown = Object.keys(entry).find((key) => !["shape", "frames", "reason"].includes(key))
    if (unknown !== undefined) fail(path, `unknown ${context} field ${unknown}`)
    if (Object.hasOwn(entry, "frames") && Object.hasOwn(entry, "reason")) {
      fail(path, `${context} cannot carry both frames and reason`)
    }
    if (Object.hasOwn(entry, "reason")) {
      if (!nonempty(entry.reason) || !entry.reason.trim()) fail(path, `invalid ${context} reason`)
      return { shape, reason: entry.reason }
    }
    const frames = parseObservationFrames(entry.frames, path, context, [], textSnapshotRefs, undefined, "buffer_state")
    if (frames === undefined) fail(path, `${context} requires frames or reason`)
    // The existing parser enforces text kind, roles and retained-reference membership.
    return { shape, frames: frames as TextCellsObservationFrame[] }
  })
  return { ...spec, grid: { rows: grid.rows as number, cols: grid.cols as number }, shapes }
}

export type ParsedSuiteManifest = ProbeSuiteManifest

export function parseSuiteManifest(path: string, source: string): ParsedSuiteManifest {
  const value = parseJsonStrict(path, source)
  if (!object(value)) fail(path, "invalid suite manifest shape")
  // A manifest is legacy-complete (sourceRevision AND generatedAt) or new-minimal (neither): the
  // derived record is a pure function of the suite sources (27832 manifest direction (2)), and the
  // legacy provenance is optional. A half-present pair can only come from a hand edit or
  // corruption, so it refuses by name. Unknown fields are refused rather than silently accepted.
  const derivedKeys = ["adapterVersion", "probeHash", "probes"]
  const legacyKeys = ["generatedAt", "sourceRevision"]
  const pointerKeys = ["schemaVersion", "textClaims", "textQualification", "catalogIds", "catalogEntrySha256"]
  const known = new Set([...derivedKeys, ...legacyKeys, ...pointerKeys])
  const unknown = Object.keys(value)
    .filter((key) => !known.has(key))
    .sort()
  if (unknown.length > 0) fail(path, `unknown suite manifest field ${unknown[0]}`)
  for (const key of derivedKeys) {
    if (!(key in value)) fail(path, `missing suite manifest field ${key}`)
  }
  const legacyPresent = legacyKeys.map((key) => key in value)
  if (legacyPresent[0] !== legacyPresent[1]) {
    fail(path, "partial suite manifest provenance: sourceRevision and generatedAt are both-or-neither")
  }
  const probeHash = asString(value.probeHash, path, "suite probeHash")
  const adapterVersion = asString(value.adapterVersion, path, "suite adapterVersion")
  let sourceRevision: string | undefined
  let generatedAt: string | undefined
  if (legacyPresent[1]) {
    if (typeof value.sourceRevision !== "string" || !/^[0-9a-f]{40}$/.test(value.sourceRevision)) {
      fail(path, "invalid suite sourceRevision")
    }
    if (
      typeof value.generatedAt !== "string" ||
      !date(value.generatedAt) ||
      new Date(value.generatedAt).toISOString() !== value.generatedAt
    ) {
      fail(path, "invalid suite generatedAt")
    }
    sourceRevision = value.sourceRevision
    generatedAt = value.generatedAt
  }
  if (value.schemaVersion !== undefined && value.schemaVersion !== 4) {
    fail(path, `unsupported suite schemaVersion ${String(value.schemaVersion)}`)
  }
  const suiteKinds =
    value.schemaVersion === 4 ? (["term", "lib", "mux"] as const) : (["app", "headless", "mux"] as const)
  if (!object(value.probes) || Object.keys(value.probes).sort().join(",") !== [...suiteKinds].sort().join(",")) {
    fail(path, `invalid suite probe kinds for ${value.schemaVersion === 4 ? "schema 4" : "historical manifest"}`)
  }
  const probes: ProbeSuiteManifest["probes"] = { term: [], lib: [], mux: [] }
  for (const kind of suiteKinds) {
    const ids = value.probes[kind]
    if (!Array.isArray(ids) || !ids.every(nonempty) || new Set(ids).size !== ids.length) {
      fail(path, `invalid ${kind} suite membership`)
    }
    probes[kind === "app" ? "term" : kind === "headless" ? "lib" : kind] = ids
  }
  let catalogIds: string[] | undefined
  if (value.catalogIds !== undefined) {
    if (
      !Array.isArray(value.catalogIds) ||
      !value.catalogIds.every(nonempty) ||
      new Set(value.catalogIds).size !== value.catalogIds.length ||
      value.catalogIds.length === 0
    ) {
      fail(path, "invalid frozen catalogIds")
    }
    catalogIds = value.catalogIds
    for (const id of Object.values(probes).flat()) {
      if (!catalogIds.includes(id)) fail(path, `scheduled ${id} is outside frozen catalogue membership`)
    }
  }
  let textClaims: string[] | undefined
  let catalogEntrySha256: Record<string, string> | undefined
  if (value.catalogEntrySha256 !== undefined) {
    const hashes = value.catalogEntrySha256
    if (
      !object(hashes) ||
      !catalogIds ||
      Object.keys(hashes).length !== catalogIds.length ||
      catalogIds.some((id) => typeof hashes[id] !== "string" || !/^[0-9a-f]{64}$/.test(hashes[id]))
    ) {
      fail(path, "invalid frozen catalogue entry hashes")
    }
    catalogEntrySha256 = value.catalogEntrySha256 as Record<string, string>
  }
  if ("textClaims" in value) {
    if (
      !Array.isArray(value.textClaims) ||
      !value.textClaims.every(nonempty) ||
      new Set(value.textClaims).size !== value.textClaims.length
    ) {
      fail(path, "invalid suite textClaims")
    }
    textClaims = value.textClaims
    for (const id of textClaims) {
      if (!probes.term.includes(id)) fail(path, `suite textClaims ${id} is outside app suite membership`)
    }
  }
  const textQualification =
    "textQualification" in value ? parseTextQualificationSpec(value.textQualification, path) : undefined
  return {
    ...(value.schemaVersion === 4 ? { schemaVersion: 4 as const } : {}),
    probeHash,
    adapterVersion,
    probes,
    ...(catalogIds === undefined ? {} : { catalogIds }),
    ...(catalogEntrySha256 === undefined ? {} : { catalogEntrySha256 }),
    ...(textClaims === undefined ? {} : { textClaims }),
    ...(textQualification === undefined ? {} : { textQualification }),
    ...(sourceRevision === undefined ? {} : { sourceRevision }),
    ...(generatedAt === undefined ? {} : { generatedAt }),
  }
}

/**
 * The ONE measured-version extractor. An apparatus- or terminal-reported version string must carry
 * exactly one version token equal to the run's declared subject version; a second bare number (a
 * build id) must never let a disagreement pass falsely. Shared by native-run sealing
 * (`parseRunProvenance`) and Linux identity admission (`docs/data/selected-results.ts`) so the two
 * cannot drift into different answers (@cto 2026-10-07, 27916 AC2).
 */
export function measuredVersionTokens(version: string): string[] {
  return version.match(/(?<![A-Za-z0-9.])\d+(?:\.\d+){0,3}(?:[-+][A-Za-z0-9.-]+)?(?![A-Za-z0-9.])/g) ?? []
}

/** The collector and loader share this validation before a native run is sealed or selected. */
export function parseRunProvenance(
  value: unknown,
  subject: ProbeSubject,
  expected: { probeHash: string; sourceRevision: string },
  path: string,
): RunProvenance | undefined {
  return parseRunProvenanceForSchema(value, subject, expected, path, 4)
}

/** Historical raw documents retain target/app diagnostics; current callers name subject/term. */
function parseRunProvenanceForSchema(
  value: unknown,
  subject: ProbeSubject,
  expected: { probeHash: string; sourceRevision: string },
  path: string,
  schemaVersion: 2 | 3 | 4,
): RunProvenance | undefined {
  if (value === undefined) return undefined
  if (subject.kind !== "term") {
    fail(path, `native provenance requires ${schemaVersion === 4 ? "a term subject" : "an app target"}`)
  }
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
    // 28260: one repeated character is what a hand writes when nothing was measured, so it is
    // refused BY NAME, through the one predicate the app-launch branch already owns.
    if (PLACEHOLDER.test(parsed)) {
      fail(path, `${field} is a placeholder: one repeated character, so no bytes were measured`)
    }
    return parsed
  }
  const executablePath = asString(value.executable.path, path, "provenance.executable.path")
  if (!executablePath.startsWith("/")) fail(path, "provenance.executable.path must be absolute")
  const version = asString(value.executable.version, path, "provenance.executable.version")
  const versionTokens = measuredVersionTokens(version)
  if (versionTokens.length !== 1 || versionTokens[0] !== subject.version) {
    fail(
      path,
      `provenance.executable.version differs from ${schemaVersion === 4 ? "subject" : "target"}.version ${subject.version}`,
    )
  }
  // An absent kind keeps today's meaning: flat bytes at `url` (xterm, kitty). A derived tree names
  // its own proof, so the discriminator here mirrors the app-launch one (@cto 2026-10-06, 27892).
  let parsedSourceArtifact: RunProvenance["sourceArtifact"]
  if (value.sourceArtifact.kind === undefined) {
    const sourceUrl = asString(value.sourceArtifact.url, path, "provenance.sourceArtifact.url")
    let parsedUrl: URL
    try {
      parsedUrl = new URL(sourceUrl)
    } catch {
      fail(path, "invalid provenance.sourceArtifact.url")
    }
    if (parsedUrl.protocol !== "https:") fail(path, "provenance.sourceArtifact.url must use HTTPS")
    parsedSourceArtifact = {
      url: sourceUrl,
      sha256: digest(value.sourceArtifact.sha256, "provenance.sourceArtifact.sha256"),
    }
  } else if (value.sourceArtifact.kind === "derived-source-tree") {
    parsedSourceArtifact = parseDerivedSourceTree(value.sourceArtifact, path, "provenance.sourceArtifact")
  } else {
    fail(path, "unknown provenance.sourceArtifact kind")
  }
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
    sourceArtifact: parsedSourceArtifact,
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

export function parseOuterApp(
  value: unknown,
  subject: ProbeSubject,
  originKind: RunOrigin["kind"],
  expected: { probeHash: string; sourceRevision: string },
  path: string,
  schemaVersion: 2 | 3 | 4 = 4,
): OuterAppProof | undefined {
  if (value === undefined) return undefined
  const subjectKey = schemaVersion === 4 ? "subject" : "target"
  if (subject.kind !== "mux") fail(path, `outerApp is only valid for a mux ${subjectKey}`)
  if (
    !object(value) ||
    Object.keys(value).some((key) => ![subjectKey, "rawReplies", "provenance", "appLaunch"].includes(key))
  ) {
    fail(path, "invalid outerApp fields")
  }
  const outerSubject = parseSubject(value[subjectKey], `${path}.outerApp`, schemaVersion)
  if (outerSubject.kind !== "term" || outerSubject.outerTerminal !== null || outerSubject.mux !== null) {
    fail(
      path,
      `outerApp requires one ${schemaVersion === 4 ? "term subject" : "app target"} without another outer terminal or mux`,
    )
  }
  if (subject.outerTerminal !== outerSubject.id || subject.mux !== subject.id) {
    fail(path, "outerApp disagrees with the claimed outer terminal or mux")
  }
  if (
    subject.os !== outerSubject.os ||
    subject.osVersion !== outerSubject.osVersion ||
    subject.permissions !== outerSubject.permissions
  ) {
    fail(path, "outerApp disagrees with the run OS or permission context")
  }
  if (!object(value.rawReplies) || !Object.values(value.rawReplies).every((reply) => typeof reply === "string")) {
    fail(path, "invalid outerApp.rawReplies")
  }
  const provenance = parseRunProvenanceForSchema(
    value.provenance,
    outerSubject,
    expected,
    `${path}.outerApp`,
    schemaVersion,
  )
  const appLaunch = parseAppLaunchReceipt(value.appLaunch, originKind, outerSubject.kind, `${path}.outerApp`)
  return {
    subject: { ...outerSubject, kind: "term" },
    rawReplies: value.rawReplies as Record<string, string>,
    ...(provenance && { provenance }),
    ...(appLaunch && { appLaunch }),
  }
}

/** Validate recorded execution facts; this never infers a current result from a missing row. */
function probeAttempt(value: unknown, path: string, rawReplies: Record<string, string>): ProbeAttempt {
  if (!object(value) || !["none", "collection", "probe"].includes(String(value.scope))) {
    fail(path, "invalid probe attempt scope")
  }
  if (value.scope === "none") {
    if (value.startedAt !== undefined || value.diagnosticRef !== undefined) {
      fail(path, "unstarted attempt cannot carry execution facts")
    }
    return { scope: "none" }
  }
  if (!date(value.startedAt)) fail(path, "attempt requires startedAt")
  if (
    value.diagnosticRef !== undefined &&
    (!nonempty(value.diagnosticRef) || !Object.hasOwn(rawReplies, value.diagnosticRef))
  ) {
    fail(path, "missing attempt diagnostic bytes")
  }
  return {
    scope: value.scope as "collection" | "probe",
    startedAt: value.startedAt,
    ...(typeof value.diagnosticRef === "string" ? { diagnosticRef: value.diagnosticRef } : {}),
  }
}

/** The reason a stored source-answer cell reads with, now that source answers no longer count (#32246). */
export const SOURCE_ANSWER_RETIRED_REASON = "source answer no longer counts (operator 2026-11-03)"

/** Map one stored source-answer cell to TEST TODO; its references and branch stay in the stored file only. */
function retiredSourceAnswer(result: ProbeResult): ProbeResult {
  const { reviewRef: _reviewRef, ...rest } = result
  return {
    ...rest,
    status: "test-todo",
    reason: SOURCE_ANSWER_RETIRED_REASON,
    tests: result.tests.map((test) => {
      if (test.id !== "review" && test.reviewRef === undefined) return test
      const { reviewRef: _testRef, ...kept } = test
      return { ...kept, status: "test-todo", reason: SOURCE_ANSWER_RETIRED_REASON }
    }),
  }
}

function isSourceOnlyNegativeReview(result: ProbeResult, assertions: readonly ReadAssertion[]): boolean {
  return (
    // Which branches admit which shape has one home, in probe-defs: the source-negative review and the reply-path
    // gate, whose measurement is a zero-byte reply (@cto 93c86660). The shape stays identical, so a reply-path cell
    // still cannot carry an assertion or assertionRefs, and the route-specific guards against "supported" remain.
    SOURCE_ONLY_NEGATIVE_REVIEW_BRANCHES.has(result.criterionBranch ?? "") &&
    result.assertionType === undefined &&
    !assertions.some((assertion) => assertion.featureId === result.featureId) &&
    !result.tests.some((test) => (test.assertionRefs?.length ?? 0) > 0)
  )
}

export function parseProbeResults(
  value: unknown,
  path: string,
  expected: ReadonlySet<string>,
  rawReplies: Record<string, string>,
  assertions: readonly ReadAssertion[],
  screenshotRefs: readonly string[] = [],
  textSnapshotRefs: readonly string[] = [],
): ProbeResult[] {
  if (!Array.isArray(value)) fail(path, "missing explicit probe results")
  const seen = new Set<string>()
  const results = value.map((item): ProbeResult => {
    if (!object(item) || !nonempty(item.featureId)) fail(path, "invalid probe result")
    const featureId = item.featureId
    if (seen.has(featureId)) fail(path, `duplicate feature ${featureId}`)
    seen.add(featureId)
    if (!expected.has(featureId)) fail(path, `${featureId} is outside frozen catalogue membership`)
    if (!PROBE_STATUSES.includes(item.status as ProbeResult["status"])) {
      fail(path, `invalid probe status for ${featureId}`)
    }
    const status = item.status as ProbeResult["status"]
    const attempt = probeAttempt(item.attempt, `${path}: ${featureId}`, rawReplies)
    if (["test-todo", "test-failure", "untestable"].includes(status) && !nonempty(item.reason)) {
      fail(path, `${featureId} ${status} requires reason`)
    }
    if (status === "test-failure" && attempt.scope === "none") {
      fail(path, `${featureId} failure requires a retained attempt`)
    }
    const displaced = ["checks", "evidence"]
    for (const key of displaced) {
      if (Object.hasOwn(item, key)) fail(path, `${featureId} schema 4 cannot carry ${key}`)
    }
    rejectUnknownFields(
      item,
      [
        "featureId",
        "status",
        "attempt",
        "tests",
        "criterionBranch",
        "rawReplyRef",
        "reviewRef",
        "reason",
        "frames",
        "screenshotRef",
        "host",
        "assertionType",
      ],
      path,
      `${featureId} result`,
    )
    if (item.assertionType !== undefined && !ASSERTION_TYPES.includes(item.assertionType as AssertionType)) {
      fail(path, `invalid assertionType for ${featureId}`)
    }
    if (!Array.isArray(item.tests)) fail(path, `${featureId} requires its explicit test set`)
    const testIds = new Set<string>()
    const tests = item.tests.map((entry): ProbeTestResult => {
      if (!object(entry) || !nonempty(entry.id) || testIds.has(entry.id)) {
        fail(path, `${featureId} requires unique test ids`)
      }
      rejectUnknownFields(
        entry,
        ["id", "status", "attempt", "assertionRefs", "rawReplyRef", "reviewRef", "reason"],
        path,
        `${featureId}/${entry.id} test`,
      )
      testIds.add(entry.id)
      if (!PROBE_STATUSES.includes(entry.status as ProbeTestResult["status"])) {
        fail(path, `invalid test status for ${featureId}/${entry.id}`)
      }
      const checkAttempt = probeAttempt(entry.attempt, `${path}: ${featureId}/${entry.id}`, rawReplies)
      if (entry.status !== "test-todo" && checkAttempt.scope === "none") {
        fail(path, `decided test ${featureId}/${entry.id} has no attempt`)
      }
      if (
        entry.assertionRefs !== undefined &&
        (!Array.isArray(entry.assertionRefs) ||
          !entry.assertionRefs.every(
            (index) =>
              Number.isSafeInteger(index) && Number(index) >= 0 && assertions[Number(index)]?.featureId === featureId,
          ))
      ) {
        fail(path, `invalid assertion references for ${featureId}/${entry.id}`)
      }
      if (
        entry.rawReplyRef !== undefined &&
        (!nonempty(entry.rawReplyRef) || !Object.hasOwn(rawReplies, entry.rawReplyRef))
      ) {
        fail(path, `missing raw test evidence for ${featureId}`)
      }
      return { ...entry, attempt: checkAttempt } as unknown as ProbeTestResult
    })
    const result = { ...item, featureId, status, attempt, tests: tests } as unknown as ProbeResult
    // Missing-observable reviews cannot establish support or a measured negative.
    if (
      result.criterionBranch !== undefined &&
      UNTESTABLE_ONLY_REVIEW_BRANCHES.has(result.criterionBranch) &&
      tests.some((test) => test.id === "review" && (test.status === "supported" || test.status === "unsupported"))
    ) {
      fail(path, `${featureId} ${result.criterionBranch} review admits only an untestable decision`)
    }
    // A capture that reached a callback the adapter does not reproduce is a harness gap, never a terminal property.
    const harnessRow = tests.find((test) => test.id === HARNESS_INCOMPLETE_TEST)
    const rawState = nonempty(item.rawReplyRef) ? rawReplies[item.rawReplyRef] : undefined
    // Found by its key, never by its serialized prefix: key order or JSON whitespace must not hide the record.
    const parsed: unknown =
      rawState !== undefined && /^[\t\n\r ]*\{/.test(rawState)
        ? parseJsonStrict(`${path}: ${featureId}`, rawState)
        : undefined
    if (harnessRow || (object(parsed) && Object.hasOwn(parsed, "unreproduced"))) {
      const record = object(parsed) ? parsed.unreproduced : undefined
      const recorded =
        object(record) &&
        nonempty(record.backend) &&
        Array.isArray(record.captures) &&
        record.captures.length > 0 &&
        record.captures.every(
          (capture) =>
            object(capture) &&
            typeof capture.query === "string" &&
            Array.isArray(capture.callbacks) &&
            capture.callbacks.length > 0 &&
            capture.callbacks.every(nonempty),
        )
      if (!recorded || harnessRow?.status !== "test-failure" || status !== "test-failure") {
        fail(path, `${featureId} unreproduced-callback record requires its failed harness row, and the row its record`)
      }
    }
    const sourceRefs = [
      ...new Set(
        [result.reviewRef, ...tests.map((test) => test.reviewRef)].filter((ref): ref is string => ref !== undefined),
      ),
    ]
    for (const ref of sourceRefs) {
      if (!nonempty(ref) || !parseSourceAnswerKey(ref)) {
        fail(path, `${featureId} unresolved review reference ${String(ref)}`)
      }
    }
    // No result is answered from source (operator 2026-11-03, @cto 153143ff): a cell recognised by its stored
    // source-answer marker reads TEST TODO, and the stored run stays byte-unchanged (#32246).
    if (sourceRefs.length > 0 || SOURCE_ONLY_NEGATIVE_REVIEW_BRANCHES.has(result.criterionBranch ?? "")) {
      return retiredSourceAnswer(result)
    }
    const semanticSource =
      result.criterionBranch === SEMANTIC_PROMPT_SOURCE_REVIEW && (status === "supported" || status === "unsupported")
    const sourceOnlyNegative = status === "unsupported" && isSourceOnlyNegativeReview(result, assertions)
    if (semanticSource || sourceOnlyNegative || status === "untestable") {
      fail(path, `${featureId} ${status} requires a probe observation; a source answer no longer counts`)
    }
    if ((status === "supported" || status === "unsupported") && !semanticSource && !sourceOnlyNegative) {
      if (attempt.scope === "none" || !item.assertionType) {
        fail(path, `${featureId} support result requires measured evidence`)
      }
      // Reuse the existing raw/assertion/frame validator without persisting or deriving
      // another disposition. The result's recorded status remains authoritative.
      parseObservation(
        { ...item, reason: undefined, outcome: status },
        path,
        new Set(expected),
        rawReplies,
        [...assertions],
        [...screenshotRefs],
        [...textSnapshotRefs],
        4,
      )
      if (
        item.assertionType === "buffer_state" &&
        Array.isArray(item.frames) &&
        item.frames.some((frame) => object(frame) && frame.kind === "text-cells") &&
        !tests.some((test) => test.id === "text-qualification" && test.status === "supported")
      ) {
        fail(path, `${featureId} text support requires its recorded qualification test`)
      }
      const deciding = tests.filter((test) => test.status === status)
      if (
        !deciding.some((test) =>
          (test.assertionRefs ?? []).some((index) => {
            const assertion = assertions[index]
            return (
              assertion?.kind === (status === "supported" ? "positive" : "negative") &&
              nonempty(assertion.expected) &&
              nonempty(assertion.observed)
            )
          }),
        )
      ) {
        fail(path, `${featureId} requires its deciding expected/observed assertion`)
      }
    }
    return result
  })
  if (results.length !== expected.size || [...expected].some((id) => !seen.has(id))) {
    fail(path, "results differ from frozen catalogue membership")
  }
  return results
}

/** Closed host-request families dispatched by the audited native embedding, not a terminal parser. */
function capturedHostQueries(text: string): Array<{ recipe: HostRecipeName; query: string }> {
  const queries: Array<{ recipe: HostRecipeName; query: string }> = []
  for (const match of text.matchAll(/\x1b\](4|10|11|12|52);([^\x07\x1b]*)(?:\x07|\x1b\\)/g)) {
    const selector = match[1],
      body = match[2]
    if (
      body !== undefined &&
      (selector === "52"
        ? /^[^;]*;\?$/.test(body)
        : selector === "4"
          ? /(?:^|;)\d+;\?(?:;|$)/.test(body)
          : body === "?")
    ) {
      queries.push({ recipe: selector === "52" ? "clipboard-load" : "color-request", query: match[0] })
    }
  }
  for (const match of text.matchAll(/\x1b\[14(?:;2)?t/g)) queries.push({ recipe: "text-area-size", query: match[0] })
  return queries
}

/** One custody validator shared by collection and immutable-run reading. It never assigns a grade. */
export function validateHostRecipeCauses(
  path: string,
  runId: string,
  featureId: string,
  expectations: readonly HostRecipeExpectation[],
  rawReplies: Readonly<Record<string, string>>,
  identity: HeadlessRuntimeIdentity | undefined,
): { runId: string; captures: unknown[]; causes: RetainedHostRecipeCause[] } {
  const refuse: (reason: string) => never = (reason) => fail(path, `${featureId} host recipe: ${reason}`)
  const inputNames = new Set<string>(HOST_INPUT_NAMES)
  const recipes = new Set(["color-request", "text-area-size", "clipboard-load"])
  for (const expected of expectations) {
    if (
      !object(expected) ||
      !recipes.has(expected.recipe) ||
      !nonempty(expected.query) ||
      !Array.isArray(expected.missing) ||
      !expected.missing.length ||
      !expected.missing.every((name) => inputNames.has(name))
    ) {
      refuse("invalid criterion declaration")
    }
  }
  const recordRef = `collector.hostRecipes.${featureId}`
  const retained = rawReplies[recordRef]
  if (retained === undefined) refuse("missing retained query/cause record")
  const record = parseJsonStrict(`${path}: ${recordRef}`, retained)
  if (!object(record) || record.runId !== runId || !Array.isArray(record.captures) || !Array.isArray(record.causes)) {
    refuse("query/cause record does not belong to this run")
  }
  const captures = record.captures.map((capture: unknown) => {
    if (
      !object(capture) ||
      typeof capture.query !== "string" ||
      typeof capture.response !== "string" ||
      !(capture.error === null || typeof capture.error === "string")
    ) {
      refuse("invalid query capture")
    }
    // A-prime (@cto 4ac8b275): a zero-byte capture beside a callback the harness did not reproduce carries its cause.
    const cause = capture.cause
    if (
      cause !== undefined &&
      !(
        object(cause) &&
        cause.kind === "harness-unreproduced" &&
        Object.keys(cause).every((key) => key === "kind" || key === "callbacks") &&
        Array.isArray(cause.callbacks) &&
        cause.callbacks.length > 0 &&
        cause.callbacks.every(nonempty) &&
        capture.response === "" &&
        capture.error === null
      )
    ) {
      refuse("invalid harness-unreproduced capture cause")
    }
    return { query: capture.query, response: capture.response, error: capture.error, harness: cause !== undefined }
  })
  // A terminal parses the ordered input stream, including a query split across writes.
  for (const actual of capturedHostQueries(captures.map((capture) => capture.query).join(""))) {
    if (!expectations.some((expected) => expected.recipe === actual.recipe && expected.query === actual.query)) {
      refuse(`captured undeclared ${actual.recipe} query`)
    }
  }
  const causes = record.causes.map((entry: unknown) => {
    if (!object(entry) || !object(entry.cause)) refuse("invalid cause record")
    const cause = entry.cause,
      missing = cause.missing
    if (
      !nonempty(missing) ||
      !inputNames.has(missing) ||
      cause.runId !== runId ||
      !expectations.some(
        (expected) => expected.recipe === entry.recipe && new Set<string>(expected.missing).has(missing),
      )
    ) {
      refuse("cause has a foreign run or undeclared missing input")
    }
    if (cause.kind === "observed") {
      if (
        cause.eventRef !== recordRef ||
        Object.keys(cause).some((key) => !["kind", "missing", "runId", "eventRef"].includes(key)) ||
        !expectations.some(
          (expected) =>
            expected.recipe === entry.recipe &&
            new Set<string>(expected.missing).has(missing) &&
            captures.some(
              (capture) => capture.query === expected.query && capture.response === "" && capture.error === null,
            ),
        )
      ) {
        refuse("observed reference does not resolve to this run's empty target capture")
      }
    } else if (cause.kind === "source-audited" || cause.kind === "unimplemented") {
      if (
        Object.keys(cause).some((key) => !["kind", "missing", "runId", "artifactSha256", "citation"].includes(key)) ||
        identity?.kind !== "native" ||
        cause.artifactSha256 !== identity.loadedBinary.sha256
      ) {
        refuse("stale native artifact citation")
      }
      const citation = cause.citation
      if (cause.kind === "unimplemented") {
        // The audited artifact has no reply path for the query, so the citation names that source and no host input.
        if (
          !object(citation) ||
          Object.keys(citation).some((key) => key !== "sourceLocation") ||
          !nonempty(citation.sourceLocation)
        ) {
          refuse("invalid no-reply-path citation")
        }
        return entry
      }
      if (
        !object(citation) ||
        citation.inputRecordRef !== "collector.collectionAttempt" ||
        citation.input !== missing ||
        !nonempty(citation.sourceLocation)
      ) {
        refuse("invalid declared-input citation")
      }
      const inputs = rawReplies[citation.inputRecordRef]
      if (inputs === undefined || citation.sha256 !== collectorAttemptDigest(inputs)) {
        refuse("stale declared-input digest")
      }
      const inputRecord = parseJsonStrict(`${path}: declared host inputs`, inputs)
      if (
        !object(inputRecord) ||
        !object(inputRecord.hostInputs) ||
        inputRecord.hostInputs[missing] !== "not-supplied"
      ) {
        refuse("cited input was not declared absent")
      }
    } else refuse("unrecognized cause kind")
    return entry
  })
  for (const expected of expectations) {
    const target = captures.filter((capture) => capture.query === expected.query && capture.error === null)
    if (!target.length) refuse("missing applicable target query capture")
    const silent = target.filter((capture) => capture.response === "")
    if (
      silent.length > 0 &&
      !silent.every((capture) => capture.harness) &&
      !causes.some(
        (entry) =>
          entry.recipe === expected.recipe &&
          object(entry.cause) &&
          new Set<string>(expected.missing).has(String(entry.cause.missing)),
      )
    ) {
      refuse("missing cause for captured empty target response")
    }
  }
  return record as { runId: string; captures: unknown[]; causes: RetainedHostRecipeCause[] }
}

export function parseRun(
  path: string,
  source: string,
  _catalogIds: readonly string[],
  suites: ReadonlyMap<string, ProbeSuiteManifest> = new Map(),
): LoadedRun {
  const sha256 = createHash("sha256").update(source).digest("hex")
  const raw = parseJsonStrict(path, source)
  if (!object(raw)) fail(path, "run must be an object")
  if (raw.schemaVersion !== 4) fail(path, `unsupported schemaVersion ${String(raw.schemaVersion)}`)
  const citedCatalog = suites.get(String(raw.probeHash))?.catalogIds
  if (!citedCatalog) fail(path, "current run requires frozen catalogue membership")
  const catalog = new Set(citedCatalog)
  const schemaVersion = 4 as const
  for (const key of ["target", "intendedContext"]) {
    if (Object.hasOwn(raw, key)) fail(path, `schema 4 run cannot carry ${key}`)
  }
  if (schemaVersion === 4) {
    rejectUnknownFields(
      raw,
      [
        "schemaVersion",
        "source",
        "runId",
        "suiteId",
        "probeHash",
        "sourceRevision",
        "intendedSubject",
        "subject",
        "identity",
        "runtimeIdentity",
        "provenance",
        "outerApp",
        "measuredAt",
        "origin",
        "rawReplies",
        "assertions",
        "screenshotRefs",
        "textSnapshotRefs",
        "textQualification",
        "results",
        "sealedAt",
      ],
      path,
      "schema 4 run",
    )
    parseCurrentSource(raw.source, path)
  }
  const subject = parseSubject(raw.subject, path, schemaVersion)
  const runtimeIdentity = parseRuntimeIdentity(raw.runtimeIdentity, subject, path, schemaVersion)
  const runId = asString(raw.runId, path, "runId")
  if (schemaVersion === 4) {
    const source = parseCurrentSource(raw.source, path)
    if (source.kind === "trace" && source.captureRunId === runId) {
      fail(path, "trace source capture runId must differ from the assertion runId")
    }
  }
  if (!["verified", "unverified", "disputed"].includes(String(raw.identity))) fail(path, "invalid identity")
  if (!object(raw.origin) || !["collector", "community-issue", "manual-capture"].includes(String(raw.origin.kind))) {
    fail(path, "invalid origin")
  }
  const appLaunch = parseAppLaunchReceipt(
    raw.origin.appLaunch,
    raw.origin.kind as RunOrigin["kind"],
    subject.kind,
    path,
  )
  if (!object(raw.rawReplies) || !Object.values(raw.rawReplies).every((v) => typeof v === "string")) {
    fail(path, "invalid rawReplies")
  }
  if (
    schemaVersion === 4 &&
    runtimeIdentity?.kind === "native" &&
    typeof raw.rawReplies["collector.replyPath"] === "string"
  ) {
    const replyPath = parseJsonStrict(`${path}: collector.replyPath`, raw.rawReplies["collector.replyPath"])
    if (
      object(replyPath) &&
      object(replyPath.declaration) &&
      object(replyPath.declaration.engine) &&
      replyPath.declaration.engine.kind === "native"
    ) {
      if (!object(replyPath.decisions)) fail(path, "host recipe: missing per-feature decisions")
      for (const [featureId, decision] of Object.entries(replyPath.decisions)) {
        if (!catalog.has(featureId) || !object(decision) || !Array.isArray(decision.hostRecipes)) {
          fail(path, "host recipe: missing criterion declaration")
        }
        const instance = parseRuntimeIdentity(decision.runtimeIdentity, subject, path, schemaVersion)
        if (!isDeepStrictEqual(instance, runtimeIdentity)) {
          fail(path, "host recipe: initialized instance identity differs from the recorded run identity")
        }
        validateHostRecipeCauses(
          path,
          runId,
          featureId,
          decision.hostRecipes as HostRecipeExpectation[],
          raw.rawReplies as Record<string, string>,
          instance,
        )
      }
    }
  }
  if (
    !Array.isArray(raw.assertions) ||
    !Array.isArray(raw.screenshotRefs) ||
    !raw.screenshotRefs.every(screenshotDigest)
  ) {
    fail(path, "invalid assertions or screenshotRefs")
  }
  // Optional: absent in every run written before text frames existed, and that absence means none.
  if (
    raw.textSnapshotRefs !== undefined &&
    (!Array.isArray(raw.textSnapshotRefs) || !raw.textSnapshotRefs.every(screenshotDigest))
  ) {
    fail(path, "invalid textSnapshotRefs")
  }
  const textSnapshotRefs = (raw.textSnapshotRefs as string[] | undefined) ?? []
  // One digest, one kind. A ref listed as both a screenshot and a text snapshot would be verified
  // as a PNG on one path and as UTF-8 text on the other.
  const bothLists = textSnapshotRefs.filter((ref) => (raw.screenshotRefs as string[]).includes(ref))
  if (bothLists.length > 0) fail(path, `text snapshot ${bothLists[0]} is also listed as a screenshotRef`)
  const textQualification = parseTextQualification(raw.textQualification, path, textSnapshotRefs)
  const assertions = raw.assertions as ReadAssertion[]
  for (const assertion of assertions) {
    if (!object(assertion) || !catalog.has(assertion.featureId) || !["positive", "negative"].includes(assertion.kind)) {
      fail(path, "invalid assertion")
    }
    if (
      schemaVersion === 4
        ? !ASSERTION_TYPES.includes(assertion.assertionType as AssertionType)
        : Object.hasOwn(assertion, "assertionType")
    ) {
      fail(
        path,
        schemaVersion === 4 ? "invalid assertion assertionType" : "historical assertion cannot carry assertionType",
      )
    }
    if (schemaVersion === 4) {
      rejectUnknownFields(
        assertion,
        ["featureId", "kind", "assertionType", "rawReplyRef", "expected", "observed", "action", "note"],
        path,
        "assertion",
      )
    }
    if (Object.hasOwn(assertion, "evidence")) fail(path, "assertion cannot carry evidence")
    if (assertion.rawReplyRef && !Object.hasOwn(raw.rawReplies, assertion.rawReplyRef)) {
      fail(path, `missing assertion raw reply ${assertion.rawReplyRef}`)
    }
  }
  if (["observations", "notTested", "ungradedDiagnostics"].some((key) => Object.hasOwn(raw, key))) {
    fail(path, "current run cannot carry displaced live dispositions")
  }
  const probeHash = asString(raw.probeHash, path, "probeHash")
  const sourceRevision = asString(raw.sourceRevision, path, "sourceRevision")
  const provenance = parseRunProvenanceForSchema(
    raw.provenance,
    subject,
    { probeHash, sourceRevision },
    path,
    schemaVersion,
  )
  const outerApp = parseOuterApp(
    raw.outerApp,
    subject,
    raw.origin.kind as RunOrigin["kind"],
    { probeHash, sourceRevision },
    path,
    schemaVersion,
  )
  const manifest = suites.get(probeHash)
  if (!manifest || manifest.probeHash !== probeHash) {
    fail(path, `unknown suite ${probeHash}; missing trusted manifest`)
  }
  const expected = new Set(manifest.catalogIds)
  for (const assertion of assertions) {
    if (!expected.has(assertion.featureId)) {
      fail(path, `assertion ${assertion.featureId} is outside suite ${probeHash} for ${subject.kind}`)
    }
  }
  if (!date(raw.measuredAt)) fail(path, "invalid measuredAt")
  const results = parseProbeResults(
    raw.results,
    path,
    expected,
    raw.rawReplies as Record<string, string>,
    assertions,
    raw.screenshotRefs as string[],
    textSnapshotRefs,
  )
  if (schemaVersion === 4) {
    validateCurrentAssertions(
      assertions as ProbeAssertion[],
      raw.rawReplies as Record<string, string>,
      results ?? [],
      subject.kind,
      path,
    )
  }
  if (!object(raw.intendedSubject)) fail(path, "current run requires intendedSubject")
  return {
    path,
    sha256,
    schemaVersion: raw.schemaVersion,
    source: parseCurrentSource(raw.source, path),
    results,
    catalogIds: [...expected],
    intendedSubject: normalizeIntendedSubject(raw.intendedSubject, schemaVersion, path),
    runId,
    subject: subject,
    identity: raw.identity as LoadedRun["identity"],
    ...(runtimeIdentity && { runtimeIdentity }),
    ...(provenance && { provenance }),
    ...(outerApp && { outerApp }),
    suiteId: asString(raw.suiteId, path, "suiteId"),
    probeHash,
    suiteComplete: true,
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
    textSnapshotRefs,
    ...(textQualification === undefined ? {} : { textQualification }),
    ...(manifest.textQualification === undefined ? {} : { textQualificationSpec: manifest.textQualification }),
    ...(manifest.textClaims === undefined ? {} : { textClaims: manifest.textClaims }),
    observations: [],
    notTested: [],
    ungradedDiagnostics: {},
    legacy: false,
  } as LoadedRun
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

/** Locate altered initialized draft content without hiding it beneath an empty-selection label. */
function initializedDraftDifference(actual: unknown, expected: unknown, path = ""): string | undefined {
  if (isDeepStrictEqual(actual, expected)) return undefined
  if (Array.isArray(actual) && Array.isArray(expected)) {
    for (let index = 0; index < Math.max(actual.length, expected.length); index++) {
      const changed = initializedDraftDifference(actual[index], expected[index], `${path}[${index}]`)
      if (changed) return changed
    }
  } else if (object(actual) && object(expected)) {
    for (const key of new Set([...Object.keys(expected), ...Object.keys(actual)])) {
      const changed = initializedDraftDifference(actual[key], expected[key], path ? `${path}.${key}` : key)
      if (changed) return changed
    }
  }
  return path
}

export type DecodedCollectorDraft = { raw: string; sha256: string } & (
  | { kind: "captured"; run: CapturedRunDraft }
  | { kind: "empty-selection"; run: RunDraft }
)

/** Canonical live transport retains a capture or an explicitly empty initialized draft. */
export function decodeCollectorDraft(
  path: string,
  raw: string,
  manifest: ProbeSuiteManifest,
  collectorRevision: string,
): DecodedCollectorDraft {
  const value = parseJsonStrict(path, raw)
  if (!object(value) || value.schemaVersion !== 4) {
    fail(path, "expected schemaVersion 4 collector draft")
  }
  if (object(value.rawReplies)) {
    const rawReplies = value.rawReplies
    if (!Object.values(rawReplies).every((entry) => typeof entry === "string")) fail(path, "invalid rawReplies")
    const records = rawReplies as Record<string, string>
    const attempt = readCollectorAttempt(records)
    if (attempt?.result === "empty") {
      const refuse = (changed: string): never => {
        throw Object.assign(new Error(`${path}: invalid empty selection at ${changed}`), {
          kind: "invalid-empty-selection" as const,
          path: changed,
        })
      }
      const selection = readCollectorSelection(records)
      if (!selection) return refuse("collector.selection.ids")
      if (selection.ids.length || attempt.ids.length) refuse("collector.selection.ids")
      if (attempt.startedAt !== undefined) refuse("collector.collectionAttempt.startedAt")
      if (manifest.schemaVersion !== 4) refuse("schemaVersion")
      if (!nonempty(value.runId)) refuse("runId")
      if (!object(value.intendedSubject)) refuse("intendedSubject")
      const intended = value.intendedSubject as Record<string, unknown>
      for (const [key, entry] of Object.entries(intended)) {
        if (key === "kind") {
          if (entry !== "term" && entry !== "lib" && entry !== "mux") refuse(`intendedSubject.${key}`)
        } else if (
          !["id", "version", "os", "osVersion", "outerTerminal", "mux", "config", "permissions"].includes(key) ||
          !(nonempty(entry) || (entry === null && key !== "id" && key !== "version"))
        ) {
          refuse(`intendedSubject.${key}`)
        }
      }
      for (const key of Object.keys(records)) {
        if (!["collector.selection", "collector.collectionAttempt", "collector.httpResponseSha256"].includes(key)) {
          refuse(`rawReplies.${key}`)
        }
      }
      const initialized = initializeRunDraft({
        runId: value.runId as string,
        sourceRevision: collectorRevision,
        source: parseCurrentSource(value.source, path),
        intendedSubject: intended as Partial<ProbeSubject>,
        manifest: manifest as ProbeSuiteManifest & { schemaVersion: 4 },
      })
      let difference = initializedDraftDifference(value, { ...initialized, rawReplies: records })
      if (difference) {
        recordCollectorSelection(initialized, selection.ids)
        difference = initializedDraftDifference(value, { ...initialized, rawReplies: records })
      }
      if (difference) refuse(difference)
      return {
        kind: "empty-selection",
        run: value as unknown as RunDraft,
        raw,
        sha256: createHash("sha256").update(raw).digest("hex"),
      }
    }
  }
  const measured = parseRun(path, raw, manifest.catalogIds ?? [], new Map([[manifest.probeHash, manifest]]))
  if (
    measured.probeHash !== manifest.probeHash ||
    measured.suiteId !== manifest.probeHash ||
    measured.sourceRevision !== collectorRevision
  ) {
    fail(path, "collector draft differs from trusted suite/source")
  }
  if (measured.identity !== "unverified" || measured.origin.kind !== "collector") {
    fail(path, "collector draft requires unverified measured identity and collector origin")
  }
  return { kind: "captured", run: value as unknown as CapturedRunDraft, raw, sha256: measured.sha256 }
}
