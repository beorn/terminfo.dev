/** Canonical parser and decoder for immutable terminal runs. */
import { createHash } from "node:crypto"
import {
  PROBE_STATUSES,
  finalizeProbeResult,
  type CaptureDecision,
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
import {
  parseObservation,
  parseObservationFrames,
  decodeLegacyBooleanObservation,
  projectHistoricalResult,
  projectHistoricalAssertions,
  validateCurrentAssertions,
} from "./observations.ts"
export { parseObservationFrames, validateObservation, validateObservationOutcome } from "./observations.ts"
import { parseJsonStrict } from "./json.ts"
export { parseJsonStrict } from "./json.ts"
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
  sealedAt?: string
  intendedSubject?: Partial<ProbeSubject>
}

type ReadObservation = HistoricalProbeRun["observations"][number]
type ReadAssertion = HistoricalProbeRun["assertions"][number]
export type LoadedRun = LoadedRunFields &
  (
    | { schemaVersion: 4; source: { kind: "live" }; assertions: ProbeAssertion[]; observations: Observation[] }
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

/** The console host a text read returned: its image, the executable this run opened, and that
 * executable's digest. The digest keeps the `sha256:` prefix the 30042 source emits, and the path
 * must be absolute as either platform writes it — the collector runs on Windows, the parser may not
 * (30055 AC4; @cto ruling 6255e75d conditions 1 and 5). */
function parseDiagnostics(
  value: unknown,
  path: string,
  catalog: Set<string>,
  observations: readonly ReadObservation[],
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

/**
 * A suite manifest plus the optional `freeze` pointer a freeze act writes on it. The pointer lives on
 * the manifest itself (the 83 manifests ARE the suite registry), so it can never name a manifest that
 * does not exist. `ProbeSuiteManifest` in @terminfo/probe-defs is a suite-hashed input, so the field
 * is added here rather than there; the extra field is erased for every consumer that only reads the
 * derived record.
 */
export interface ParsedSuiteManifest extends ProbeSuiteManifest {
  /** Written only by a freeze act: the release whose current suite this manifest is. */
  freeze?: {
    release: string
    at: string
    /**
     * The suites this release published on before the pointer reached this one, oldest first. The
     * move carries the list forward and appends the suite it leaves, so the history survives every
     * later move; nothing walks another manifest to recover it.
     */
    previous?: { suite: string; from: string; until: string }[]
  }
}

export function parseSuiteManifest(path: string, source: string): ParsedSuiteManifest {
  const value = parseJsonStrict(path, source)
  if (!object(value)) fail(path, "invalid suite manifest shape")
  // A manifest is legacy-complete (sourceRevision AND generatedAt) or new-minimal (neither): the
  // derived record is a pure function of the suite sources (27832 manifest direction (2)), and the
  // legacy provenance is optional. A half-present pair can only come from a hand edit or
  // corruption, so it refuses by name. Unknown fields are refused rather than silently accepted.
  const derivedKeys = ["adapterVersion", "probeHash", "probes"]
  const legacyKeys = ["generatedAt", "sourceRevision"]
  const pointerKeys = ["schemaVersion", "freeze", "textClaims", "textQualification", "catalogIds"]
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
  let freeze: ParsedSuiteManifest["freeze"]
  if ("freeze" in value) {
    const raw = value.freeze
    if (!object(raw)) fail(path, "invalid suite freeze pointer")
    const rawKeys = Object.keys(raw).sort().join(",")
    if (rawKeys !== "at,release" && rawKeys !== "at,previous,release") fail(path, "invalid suite freeze pointer")
    if (typeof raw.release !== "string" || !raw.release.trim()) fail(path, "invalid suite freeze release")
    if (typeof raw.at !== "string" || !date(raw.at) || new Date(raw.at).toISOString() !== raw.at) {
      fail(path, "invalid suite freeze at")
    }
    let previous: { suite: string; from: string; until: string }[] | undefined
    if ("previous" in raw) {
      const rawPrevious = raw.previous
      if (!Array.isArray(rawPrevious)) fail(path, "invalid suite freeze previous lineage")
      const lineage: { suite: string; from: string; until: string }[] = []
      for (const entry of rawPrevious) {
        if (!object(entry) || Object.keys(entry).sort().join(",") !== "from,suite,until") {
          fail(path, "invalid suite freeze previous entry")
        }
        if (typeof entry.suite !== "string" || !entry.suite.trim()) fail(path, "invalid suite freeze previous suite")
        for (const key of ["from", "until"] as const) {
          const value = entry[key]
          if (typeof value !== "string" || !date(value) || new Date(value).toISOString() !== value) {
            fail(path, `invalid suite freeze previous ${key}`)
          }
        }
        if (lineage.some((seen) => seen.suite === entry.suite) || entry.suite === probeHash) {
          fail(path, `suite freeze previous lineage repeats suite ${entry.suite}`)
        }
        // Oldest first, each window starting where the one before it ended: the move writes exactly
        // this, so another order or a gap is a hand edit the lineage reader would misread.
        const from = entry.from as string
        const until = entry.until as string
        const before = lineage[lineage.length - 1]
        if (until < from || (before !== undefined && before.until !== from)) {
          fail(path, `invalid suite freeze previous window for suite ${entry.suite}`)
        }
        lineage.push({ suite: entry.suite, from, until })
      }
      const last = lineage[lineage.length - 1]
      if (last !== undefined && last.until !== raw.at) {
        fail(path, `suite freeze previous lineage ends at ${last.until}, not at this freeze (${raw.at})`)
      }
      previous = lineage
    }
    freeze = { release: raw.release, at: raw.at, ...(previous === undefined ? {} : { previous }) }
  }
  return {
    ...(value.schemaVersion === 4 ? { schemaVersion: 4 as const } : {}),
    probeHash,
    adapterVersion,
    probes,
    ...(catalogIds === undefined ? {} : { catalogIds }),
    ...(textClaims === undefined ? {} : { textClaims }),
    ...(textQualification === undefined ? {} : { textQualification }),
    ...(sourceRevision === undefined ? {} : { sourceRevision }),
    ...(generatedAt === undefined ? {} : { generatedAt }),
    ...(freeze === undefined ? {} : { freeze }),
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

function parseNotTested(
  value: unknown,
  path: string,
  catalog: Set<string>,
  expected: ReadonlySet<string>,
  rawReplies: Record<string, string>,
  observations: readonly ReadObservation[],
  assertions: readonly ReadAssertion[],
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

/** Typed feature review of immutable capture bytes, separate from final-run admission review. */
export function parseCaptureDecision(
  value: unknown,
  path: string,
  catalog: ReadonlySet<string>,
  schemaVersion: 2 | 3 | 4 = 4,
): CaptureDecision {
  if (!object(value)) fail(path, "invalid pre-seal capture decision")
  for (const key of ["runSha256", "observation", "verifiesIdentity", "presentsEvidence", "origin"]) {
    if (Object.hasOwn(value, key)) fail(path, `pre-seal capture decision cannot set ${key}`)
  }
  for (const key of ["id", "runId", "featureId", "reviewer", "reason"]) {
    if (!nonempty(value[key])) fail(path, `pre-seal capture decision requires ${key}`)
  }
  if (!catalog.has(String(value.featureId))) fail(path, "pre-seal capture decision feature is outside catalogue")
  if (!["supported", "unsupported", "untestable"].includes(String(value.decision)) || value.reviewed !== true) {
    fail(path, "pre-seal capture decision requires a typed reviewed decision")
  }
  if (typeof value.captureSha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.captureSha256)) {
    fail(path, "invalid pre-seal capture SHA256")
  }
  const scope = value.scope
  const subjectKey = schemaVersion === 4 ? "subject" : "target"
  const kinds = schemaVersion === 4 ? ["term", "lib", "mux"] : ["app", "headless", "mux"]
  if (
    !object(scope) ||
    !object(scope[subjectKey]) ||
    !kinds.includes(String((scope[subjectKey] as Record<string, unknown>).kind)) ||
    !nonempty((scope[subjectKey] as Record<string, unknown>).id)
  ) {
    fail(path, "invalid pre-seal capture target scope")
  }
  for (const key of ["versions", "suites"]) {
    const range = scope[key]
    if (!Array.isArray(range) || range.length !== 2 || !range.every(nonempty) || range[0] !== range[1]) {
      fail(path, `pre-seal capture decision requires exact ${key}`)
    }
  }
  if (
    !Array.isArray(value.sources) ||
    value.sources.length === 0 ||
    !value.sources.every(nonempty) ||
    !Array.isArray(value.supersedes) ||
    !value.supersedes.every(nonempty)
  ) {
    fail(path, "pre-seal capture decision requires sources and supersedes")
  }
  if (Object.hasOwn(scope, schemaVersion === 4 ? "target" : "subject")) fail(path, "mixed capture scope vocabulary")
  const { target: _historicalTarget, subject: _currentSubject, ...ranges } = scope
  const subject = normalizeIntendedSubject(scope[subjectKey], schemaVersion, path)
  return { ...value, scope: { ...ranges, subject } } as unknown as CaptureDecision
}

/** The existing raw-reply custody retains only binding metadata, never duplicate frame/trace blobs. */
function captureBindingSource(
  draft: Omit<
    Pick<
      RunDraft,
      | "runId"
      | "suiteId"
      | "probeHash"
      | "sourceRevision"
      | "intendedSubject"
      | "subject"
      | "results"
      | "rawReplies"
      | "assertions"
    >,
    "assertions"
  > & { assertions: readonly ReadAssertion[] },
  featureId: string,
  historicalSource?: Record<string, unknown>,
): string {
  const result = draft.results.find((entry) => entry.featureId === featureId)
  if (!result) throw new Error(`Capture feature ${featureId} is outside frozen catalogue`)
  const rawKeys = new Set<string>()
  if (result.rawReplyRef) rawKeys.add(result.rawReplyRef)
  for (const test of result.tests) if (test.rawReplyRef) rawKeys.add(test.rawReplyRef)
  for (const frame of result.frames ?? []) {
    if (frame.sourceRef && Object.hasOwn(draft.rawReplies, frame.sourceRef)) rawKeys.add(frame.sourceRef)
  }
  for (const key of Object.keys(draft.rawReplies)) {
    if (key.startsWith("collector.") && !key.startsWith("collector.capture.") && !key.startsWith("collector.review.")) {
      rawKeys.add(key)
    }
  }
  const hash = (source: string): string => createHash("sha256").update(source, "utf8").digest("hex")
  const rawReplyRefs = [...rawKeys].sort().map((key) => {
    const bytes = draft.rawReplies[key]
    if (bytes === undefined) throw new Error(`Capture ${featureId} missing raw bytes ${key}`)
    return { key, sha256: hash(bytes) }
  })
  // Review assertions are derived from this immutable capture after review, and are bound
  // separately by the retained typed decision. Capture assertions remain byte-for-byte bound.
  const reviewAssertions = new Set(
    result.tests.filter((test) => test.id === "review").flatMap((test) => test.assertionRefs ?? []),
  )
  const assertionRefs = draft.assertions.flatMap((assertion, index) =>
    assertion.featureId === featureId && !reviewAssertions.has(index)
      ? [{ index, sha256: hash(JSON.stringify(assertion)) }]
      : [],
  )
  const historicalResult =
    historicalSource === undefined
      ? undefined
      : (historicalSource.results as Array<Record<string, unknown>>).find((entry) => entry.featureId === featureId)
  return JSON.stringify({
    runId: draft.runId,
    probeHash: draft.probeHash,
    sourceRevision: draft.sourceRevision,
    ...(historicalSource === undefined
      ? { intendedSubject: draft.intendedSubject, ...(draft.subject && { subject: draft.subject }) }
      : {
          intendedContext: historicalSource.intendedContext,
          ...(historicalSource.target !== undefined ? { target: historicalSource.target } : {}),
        }),
    featureId,
    rawReplyRefs,
    assertionRefs,
    frames: result.frames ?? [],
    ...(result.screenshotRef && { screenshotRef: result.screenshotRef }),
    ...(result.host && { host: result.host }),
    ...(historicalSource === undefined
      ? result.assertionType && { assertionType: result.assertionType }
      : historicalResult?.evidence !== undefined
        ? { evidence: historicalResult.evidence }
        : {}),
    ...(result.criterionBranch && { criterionBranch: result.criterionBranch }),
  })
}

/** Called only when this criterion requires review, after collector/intent/target enrichment. */
export function retainCaptureBinding(
  draft: RunDraft,
  featureId: string,
): { source: string; sha256: string; rawReplyRef: string } {
  if ("sealedAt" in draft) throw new Error(`Run ${draft.runId} is already sealed`)
  const result = draft.results.find((entry) => entry.featureId === featureId)
  if (!result?.tests.some((test) => test.id === "review")) {
    throw new Error(`Capture ${featureId} has no required review`)
  }
  const source = captureBindingSource(draft, featureId)
  const rawReplyRef = `collector.capture.${featureId}`
  if (draft.rawReplies[rawReplyRef] !== undefined && draft.rawReplies[rawReplyRef] !== source) {
    throw new Error(`Capture ${featureId} binding is immutable`)
  }
  draft.rawReplies[rawReplyRef] = source
  return { source, sha256: createHash("sha256").update(source, "utf8").digest("hex"), rawReplyRef }
}

function validateCaptureBinding(
  draft: Parameters<typeof captureBindingSource>[0],
  decision: CaptureDecision,
  path: string,
  historicalSource?: Record<string, unknown>,
): void {
  const source = draft.rawReplies[`collector.capture.${decision.featureId}`]
  if (!source || createHash("sha256").update(source, "utf8").digest("hex") !== decision.captureSha256) {
    fail(path, "capture digest mismatch or absent capture")
  }
  if (source !== captureBindingSource(draft, decision.featureId, historicalSource)) {
    fail(path, "capture context/source/suite/evidence binding changed")
  }
  if (decision.runId !== draft.runId) fail(path, "capture runId mismatch")
  const subject = draft.subject ?? draft.intendedSubject
  if (
    decision.scope.subject.kind !== subject.kind ||
    decision.scope.subject.id !== subject.id ||
    decision.scope.versions[0] !== subject.version ||
    decision.scope.suites[0] !== draft.probeHash ||
    draft.probeHash !== draft.suiteId
  ) {
    fail(path, "capture scope mismatch")
  }
}

/** Apply one typed decision to its still-open required review; final-run reviews cannot use this path. */
export function applyCaptureDecision(draft: RunDraft, source: string, startedAt: string): void {
  if ("sealedAt" in draft) throw new Error(`Run ${draft.runId} is already sealed`)
  if (!date(startedAt)) throw new Error("Capture review requires its actual attempt timestamp")
  const decision = parseCaptureDecision(
    parseJsonStrict("capture review", source),
    "capture review",
    new Set(draft.results.map((result) => result.featureId)),
  )
  validateCaptureBinding(draft, decision, "capture review")
  const index = draft.results.findIndex((result) => result.featureId === decision.featureId)
  const result = draft.results[index]
  if (!result || !result.tests.some((test) => test.id === "review" && test.status === "test-todo")) {
    throw new Error(`Capture ${decision.featureId} has no pending required review`)
  }
  const reviewRef = `collector.review.${decision.id}`
  if (Object.hasOwn(draft.rawReplies, reviewRef)) throw new Error(`Capture review ${decision.id} already retained`)
  let assertionRefs: number[] | undefined
  if (decision.decision !== "untestable") {
    const captured = draft.assertions.filter((assertion) => assertion.featureId === decision.featureId)
    if (!captured.length || captured.some((assertion) => !assertion.expected || !assertion.observed)) {
      throw new Error(`Capture ${decision.featureId} review requires retained TESTED/EXPECTED assertions`)
    }
    assertionRefs = captured.map((assertion) => {
      const index = draft.assertions.length
      draft.assertions.push({
        ...assertion,
        kind: decision.decision === "supported" ? "positive" : "negative",
        note: `Capture review ${decision.id}: ${decision.reason}`,
      })
      return index
    })
  }
  const tests = result.tests.map((test): ProbeTestResult =>
    test.id === "review"
      ? {
          ...test,
          status: decision.decision,
          attempt: { scope: "probe", startedAt },
          reviewRef,
          reason: decision.reason,
          ...(assertionRefs && { assertionRefs }),
        }
      : test,
  )
  draft.rawReplies[reviewRef] = source
  draft.results[index] = finalizeProbeResult({
    ...result,
    tests: tests,
    reviewRef,
    reason: decision.reason,
    attempt: { scope: "probe", startedAt },
  })
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

export function parseProbeResults(
  value: unknown,
  path: string,
  expected: ReadonlySet<string>,
  rawReplies: Record<string, string>,
  assertions: readonly ReadAssertion[],
  screenshotRefs: readonly string[] = [],
  textSnapshotRefs: readonly string[] = [],
  schemaVersion: 3 | 4 = 4,
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
    const testKey = schemaVersion === 4 ? "tests" : "checks"
    const displaced = schemaVersion === 4 ? ["checks", "evidence"] : ["tests", "assertionType"]
    for (const key of displaced) {
      if (Object.hasOwn(item, key)) fail(path, `${featureId} schema ${schemaVersion} cannot carry ${key}`)
    }
    if (schemaVersion === 4) {
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
    }
    if (!Array.isArray(item[testKey])) fail(path, `${featureId} requires its explicit test set`)
    const testIds = new Set<string>()
    const tests = (item[testKey] as unknown[]).map((entry): ProbeTestResult => {
      if (!object(entry) || !nonempty(entry.id) || testIds.has(entry.id)) {
        fail(path, `${featureId} requires unique test ids`)
      }
      if (schemaVersion === 4) {
        rejectUnknownFields(
          entry,
          ["id", "status", "attempt", "assertionRefs", "rawReplyRef", "reviewRef", "reason"],
          path,
          `${featureId}/${entry.id} test`,
        )
      }
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
    if (finalizeProbeResult(result).status !== status) {
      fail(path, `${featureId} recorded status hides required test work`)
    }
    if (status === "supported" || status === "unsupported") {
      if (attempt.scope === "none" || !(schemaVersion === 4 ? item.assertionType : item.evidence)) {
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
        schemaVersion,
      )
      if (
        (schemaVersion === 3
          ? item.evidence === "text"
          : item.assertionType === "buffer_state" &&
            Array.isArray(item.frames) &&
            item.frames.some((frame) => object(frame) && frame.kind === "text-cells")) &&
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
    if (status === "untestable") {
      const key = result.reviewRef ?? tests.find((test) => test.status === "untestable")?.reviewRef
      if (!key || !rawReplies[key]) fail(path, `${featureId} requires its immutable reviewed impossibility reason`)
      const review = parseCaptureDecision(
        parseJsonStrict(`${path}: ${key}`, rawReplies[key]),
        path,
        expected,
        schemaVersion,
      )
      if (review.decision !== "untestable" || review.featureId !== featureId || review.reason !== result.reason) {
        fail(path, `${featureId} invalid context-impossibility review`)
      }
    }
    return schemaVersion === 3
      ? projectHistoricalResult({ ...item, featureId, status, attempt }, tests, rawReplies)
      : result
  })
  if (results.length !== expected.size || [...expected].some((id) => !seen.has(id))) {
    fail(path, "results differ from frozen catalogue membership")
  }
  return results
}

export function parseRun(
  path: string,
  source: string,
  catalogIds: readonly string[],
  suites: ReadonlyMap<string, ProbeSuiteManifest> = new Map(),
  options: { mode?: "sealed" | "capture" } = {},
): LoadedRun {
  const sha256 = createHash("sha256").update(source).digest("hex")
  const raw = parseJsonStrict(path, source)
  if (!object(raw)) fail(path, "run must be an object")
  if (raw.outerApp !== undefined && raw.schemaVersion !== 2 && raw.schemaVersion !== 3 && raw.schemaVersion !== 4) {
    fail(path, "outerApp requires a schema-v2 mux run")
  }
  if (
    raw.schemaVersion !== undefined &&
    raw.schemaVersion !== 2 &&
    raw.schemaVersion !== 3 &&
    raw.schemaVersion !== 4
  ) {
    fail(path, `unsupported schemaVersion ${String(raw.schemaVersion)}`)
  }
  const execution = raw.schemaVersion === 3 || raw.schemaVersion === 4
  const citedCatalog = execution ? suites.get(String(raw.probeHash))?.catalogIds : undefined
  if (execution && !citedCatalog) fail(path, "current run requires frozen catalogue membership")
  const catalog = new Set(citedCatalog ?? catalogIds)
  if (raw.schemaVersion === 2 || raw.schemaVersion === 3 || raw.schemaVersion === 4) {
    const schemaVersion = raw.schemaVersion
    const current = execution
    const subjectKey = schemaVersion === 4 ? "subject" : "target"
    const intendedKey = schemaVersion === 4 ? "intendedSubject" : "intendedContext"
    const displaced = schemaVersion === 4 ? ["target", "intendedContext"] : ["subject", "intendedSubject", "source"]
    for (const key of displaced) {
      if (Object.hasOwn(raw, key)) fail(path, `schema ${schemaVersion} run cannot carry ${key}`)
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
      if (!object(raw.source)) fail(path, "schema 4 requires source")
      if (raw.source.kind === "trace") fail(path, "trace probe source has no implementation at this source")
      if (Object.keys(raw.source).join(",") !== "kind" || raw.source.kind !== "live") {
        fail(path, "invalid source; schema 4 requires { kind: live }")
      }
    }
    if (!current && Object.hasOwn(raw, "results")) fail(path, "v2 run cannot contain legacy boolean results")
    const subject = parseSubject(raw[subjectKey], path, schemaVersion)
    const runtimeIdentity = parseRuntimeIdentity(raw.runtimeIdentity, subject, path, schemaVersion)
    const runId = asString(raw.runId, path, "runId")
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
      if (
        !object(assertion) ||
        !catalog.has(assertion.featureId) ||
        !["positive", "negative"].includes(assertion.kind)
      ) {
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
    if (
      current &&
      options.mode !== "capture" &&
      (!date(raw.sealedAt) || new Date(raw.sealedAt).toISOString() !== raw.sealedAt)
    ) {
      fail(path, "missing or invalid sealedAt; retain an unsealed run as a draft")
    }
    if (current && ["observations", "notTested", "ungradedDiagnostics"].some((key) => Object.hasOwn(raw, key))) {
      fail(path, "current run cannot carry displaced live dispositions")
    }
    if (!current && !Array.isArray(raw.observations)) fail(path, "missing observations")
    const observations = (current ? [] : (raw.observations as unknown[])).map((v) =>
      parseObservation(
        v,
        path,
        catalog,
        raw.rawReplies as Record<string, string>,
        assertions,
        raw.screenshotRefs as string[],
        textSnapshotRefs,
        schemaVersion,
      ),
    )
    if (new Set(observations.map((v) => v.featureId)).size !== observations.length) {
      fail(path, "duplicate observation feature ID")
    }
    if (!current && raw.suiteComplete !== true && raw.suiteComplete !== false) fail(path, "missing suiteComplete")
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
    const expected = new Set(current ? manifest.catalogIds : manifest.probes[subject.kind])
    for (const assertion of assertions) {
      if (!expected.has(assertion.featureId)) {
        fail(path, `assertion ${assertion.featureId} is outside suite ${probeHash} for ${subject.kind}`)
      }
    }
    for (const observation of observations) {
      if (!expected.has(observation.featureId)) {
        fail(path, `${observation.featureId} is outside suite ${probeHash} for ${subject.kind}`)
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
    if (!current && raw.suiteComplete !== suiteComplete) {
      fail(
        path,
        `suiteComplete disagrees with observed and not-tested membership (${observations.length} measured + ${notTested.length} not tested of ${expected.size} probes)`,
      )
    }
    const ungradedDiagnostics = parseDiagnostics(raw.ungradedDiagnostics, path, catalog, observations)
    for (const id of Object.keys(ungradedDiagnostics)) {
      if (!expected.has(id)) fail(path, `diagnostic ${id} is outside suite ${probeHash} for ${subject.kind}`)
      if (notTested.some((item) => item.featureId === id)) {
        fail(path, `diagnostic ${id} also occurs in notTested`)
      }
    }
    if (!date(raw.measuredAt)) fail(path, "invalid measuredAt")
    const results = current
      ? parseProbeResults(
          raw.results,
          path,
          expected,
          raw.rawReplies as Record<string, string>,
          assertions,
          raw.screenshotRefs as string[],
          textSnapshotRefs,
          schemaVersion as 3 | 4,
        )
      : undefined
    if (schemaVersion === 4) {
      validateCurrentAssertions(
        assertions as ProbeAssertion[],
        raw.rawReplies as Record<string, string>,
        results ?? [],
        subject.kind,
        path,
      )
    }
    if (current && results) {
      if (
        raw.sealedAt !== undefined &&
        results.some((result) => result.tests.some((test) => test.id === "review" && test.status === "test-todo"))
      ) {
        fail(path, "required review pending; retain its unsealed capture")
      }
      if (!object(raw[intendedKey])) fail(path, "current run requires intendedSubject")
      const captureRun = {
        runId,
        suiteId: asString(raw.suiteId, path, "suiteId"),
        probeHash,
        sourceRevision,
        intendedSubject: normalizeIntendedSubject(raw[intendedKey], schemaVersion, path),
        subject: subject,
        results,
        rawReplies: raw.rawReplies as Record<string, string>,
        assertions,
      }
      for (const result of results) {
        const refs = new Set(
          [result.reviewRef, ...result.tests.map((test) => test.reviewRef)].filter(
            (ref): ref is string => ref !== undefined,
          ),
        )
        for (const ref of refs) {
          const bytes = captureRun.rawReplies[ref]
          if (!bytes) fail(path, `missing immutable capture decision ${ref}`)
          const decision = parseCaptureDecision(parseJsonStrict(path, bytes), path, expected, schemaVersion)
          if (decision.featureId !== result.featureId) fail(path, "capture decision feature mismatch")
          validateCaptureBinding(captureRun, decision, path, schemaVersion === 3 ? raw : undefined)
          for (const test of result.tests.filter((test) => test.reviewRef === ref)) {
            if (test.status !== decision.decision) fail(path, "capture decision differs from recorded test")
          }
        }
      }
    }
    return {
      path,
      sha256,
      schemaVersion: raw.schemaVersion,
      ...(schemaVersion === 4 ? { source: { kind: "live" as const } } : {}),
      ...(current
        ? {
            results,
            catalogIds: [...expected],
            sealedAt: raw.sealedAt as string,
            intendedSubject: normalizeIntendedSubject(raw[intendedKey], schemaVersion, path),
          }
        : {}),
      runId,
      subject: subject,
      identity: raw.identity as LoadedRun["identity"],
      ...(runtimeIdentity && { runtimeIdentity }),
      ...(provenance && { provenance }),
      ...(outerApp && { outerApp }),
      suiteId: asString(raw.suiteId, path, "suiteId"),
      probeHash,
      suiteComplete: current || suiteComplete,
      suiteProbeCount: expected.size,
      sourceRevision,
      measuredAt: raw.measuredAt,
      origin: {
        kind: raw.origin.kind as RunOrigin["kind"],
        ...(typeof raw.origin.url === "string" && { url: raw.origin.url }),
        ...(appLaunch && { appLaunch }),
      },
      rawReplies: raw.rawReplies as Record<string, string>,
      assertions:
        schemaVersion === 4
          ? assertions
          : projectHistoricalAssertions(
              assertions,
              [...observations, ...(results ?? [])],
              raw.rawReplies as Record<string, string>,
            ),
      screenshotRefs: raw.screenshotRefs as string[],
      textSnapshotRefs,
      ...(textQualification === undefined ? {} : { textQualification }),
      ...(manifest.textQualification === undefined ? {} : { textQualificationSpec: manifest.textQualification }),
      ...(manifest.textClaims === undefined ? {} : { textClaims: manifest.textClaims }),
      observations,
      notTested,
      ungradedDiagnostics,
      legacy: false,
    } as LoadedRun
  }

  // Existing boolean captures are preserved byte-for-byte and never graded.
  const kind: ProbeSubject["kind"] = path.includes("probes-mux/") ? "mux" : raw.backend ? "lib" : "term"
  const id = asString(raw.backend ?? raw.terminal, path, "backend/terminal")
  const version = asString(raw.version ?? raw.terminalVersion, path, "version")
  if (!date(raw.generated)) fail(path, "invalid generated timestamp")
  if (!object(raw.results)) fail(path, "missing results")
  const observations: ReadObservation[] = []
  for (const [featureId, value] of Object.entries(raw.results)) {
    if (!catalog.has(featureId)) fail(path, `unknown feature ${featureId}`)
    if (typeof value !== "boolean") fail(path, `invalid legacy result for ${featureId}`)
    observations.push(decodeLegacyBooleanObservation(featureId, value))
  }
  const subject: ProbeSubject = {
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
    subject: subject,
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
    textSnapshotRefs: [],
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
export function decodeHistoricalCollectorRun(
  path: string,
  raw: string,
  manifest: ProbeSuiteManifest,
  collectorRevision: string,
): { run: HistoricalProbeRun; raw: string; sha256: string } {
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
  const run: HistoricalProbeRun = {
    schemaVersion: 2,
    runId: measured.runId,
    subject: measured.subject,
    identity: "unverified",
    ...(measured.runtimeIdentity && { runtimeIdentity: measured.runtimeIdentity }),
    ...(measured.provenance && { provenance: measured.provenance }),
    ...(measured.outerApp && { outerApp: measured.outerApp }),
    suiteId: measured.suiteId,
    probeHash: manifest.probeHash,
    suiteComplete: measured.suiteComplete,
    sourceRevision: collectorRevision,
    measuredAt: measured.measuredAt,
    origin: measured.origin,
    rawReplies: measured.rawReplies,
    assertions: measured.assertions,
    screenshotRefs: measured.screenshotRefs,
    ...(measured.textSnapshotRefs.length > 0 && { textSnapshotRefs: measured.textSnapshotRefs }),
    ...(measured.textQualification === undefined ? {} : { textQualification: measured.textQualification }),
    observations: measured.observations,
    ...(measured.notTested.length > 0 && { notTested: measured.notTested }),
    ungradedDiagnostics: measured.ungradedDiagnostics,
  }
  return { run, raw, sha256: measured.sha256 }
}

/** Canonical live collector transport is an unsealed schema-4 capture; final writer seals later. */
export function decodeCollectorDraft(
  path: string,
  raw: string,
  manifest: ProbeSuiteManifest,
  collectorRevision: string,
): { run: CapturedRunDraft; raw: string; sha256: string } {
  const value = parseJsonStrict(path, raw)
  if (!object(value) || value.schemaVersion !== 4 || Object.hasOwn(value, "sealedAt")) {
    fail(path, "expected unsealed schemaVersion 4 collector draft")
  }
  const measured = parseRun(path, raw, manifest.catalogIds ?? [], new Map([[manifest.probeHash, manifest]]), {
    mode: "capture",
  })
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
  return { run: value as unknown as CapturedRunDraft, raw, sha256: measured.sha256 }
}

/** A final file is current only when sealed; historical files have their explicit historical decoder. */
export function decodeCollectorRun(
  path: string,
  raw: string,
  manifest: ProbeSuiteManifest,
  collectorRevision: string,
): { run: ProbeRun; raw: string; sha256: string } {
  const measured = parseRun(path, raw, manifest.catalogIds ?? [], new Map([[manifest.probeHash, manifest]]))
  if (measured.schemaVersion !== 4) fail(path, "expected sealed schemaVersion 4 collector run")
  if (
    measured.probeHash !== manifest.probeHash ||
    measured.suiteId !== manifest.probeHash ||
    measured.sourceRevision !== collectorRevision
  ) {
    fail(path, "collector run differs from trusted suite/source")
  }
  if (measured.identity !== "unverified" || measured.origin.kind !== "collector") {
    fail(path, "collector run requires unverified measured identity and collector origin")
  }
  return { run: parseJsonStrict(path, raw) as unknown as ProbeRun, raw, sha256: measured.sha256 }
}
