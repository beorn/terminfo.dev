/** Canonical parser and decoder for immutable terminal runs. */
import { createHash } from "node:crypto"
import { isAbsolute, win32 } from "node:path"
import {
  CAPABILITY_STATUSES,
  finalizeCapabilityResult,
  type CaptureDecision,
  type RunDraft,
  type CapturedRunDraft,
  type HistoricalProbeRun,
  type CapabilityResult,
  type CapabilityAttempt,
  type CheckResult,
  OBSERVATION_EVIDENCE,
  OBSERVATION_OUTCOMES,
  OBSERVATION_REASONS,
  TEXT_QUALIFICATION_SHAPES,
  frameDigests,
  isNonMeasuringEvidence,
  type ConsoleBufferOwner,
  type NotTestedCoverage,
  type Observation,
  type ObservationFrame,
  type ProbeAssertion,
  type ProbeRun,
  type ProbeTarget,
  type RunOrigin,
  type HeadlessRuntimeIdentity,
  type RunProvenance,
  type OuterAppProof,
  type UngradedDiagnostic,
  type ProbeSuiteManifest,
  type TextQualification,
  type TextQualificationOwnership,
  type TextQualificationSpec,
  type TextQualificationShape,
  type TextCellsObservationFrame,
} from "@terminfo/probe-defs"
import { ALACRITTY_VERSION_PATTERN, PLACEHOLDER, parseAppLaunchReceipt, parseDerivedSourceTree } from "./app-launch.ts"

export { ALACRITTY_VERSION_PATTERN, parseAppLaunchReceipt, parseDerivedSourceTree }

export interface LoadedRun {
  path: string
  sha256: string
  schemaVersion: 1 | 2 | 3
  runId: string
  target: ProbeTarget
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
  assertions: ProbeAssertion[]
  screenshotRefs: string[]
  /** Retained text snapshots: the text-frame twin of `screenshotRefs`, kept separate
   * because every consumer of that list assumes a PNG. Absent in runs written before it exists. */
  textSnapshotRefs: string[]
  textQualification?: TextQualification
  textQualificationSpec?: TextQualificationSpec
  textClaims?: string[]
  observations: Observation[]
  notTested: NotTestedCoverage[]
  ungradedDiagnostics: Record<string, UngradedDiagnostic>
  legacy: boolean
  results?: CapabilityResult[]
  catalogIds?: string[]
  sealedAt?: string
  intendedContext?: Partial<ProbeTarget>
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

/**
 * The screen rectangle a frame's `regionDigest` was taken over. It travels with the digest for the
 * same reason the digest survives the parse: a verdict recomputed from the parsed frame must still
 * be able to tell whether two frames were cropped from the same cells (29580). A rectangle that is
 * not four non-negative integers with positive sizes fails the parse; it is never dropped.
 */
function frameRegionRectangle(
  value: unknown,
  path: string,
  index: number,
  featureId: string,
): ObservationFrame["regionRectangle"] {
  if (value === undefined) return undefined
  if (!object(value)) fail(path, `invalid frame regionRectangle ${index} for ${featureId}`)
  const integerEdge = (edge: "x" | "y" | "width" | "height"): number => {
    const edgeValue = value[edge]
    if (typeof edgeValue !== "number" || !Number.isSafeInteger(edgeValue)) {
      fail(path, `invalid frame regionRectangle ${edge} ${index} for ${featureId}`)
    }
    return edgeValue
  }
  const rectangle = {
    x: integerEdge("x"),
    y: integerEdge("y"),
    width: integerEdge("width"),
    height: integerEdge("height"),
  }
  if (rectangle.x < 0 || rectangle.y < 0 || rectangle.width < 1 || rectangle.height < 1) {
    fail(path, `invalid frame regionRectangle ${index} for ${featureId}: edges are non-negative and sizes positive`)
  }
  return rectangle
}

/** The compared rectangle of a text-cells frame, in CELLS. Same rule as a pixel crop: carried, never
 * dropped, and refused when it is not a real rectangle. */
function frameCellRectangle(
  value: unknown,
  path: string,
  index: number,
  featureId: string,
): Extract<ObservationFrame, { kind: "text-cells" }>["cellRectangle"] {
  if (!object(value)) fail(path, `invalid frame cellRectangle ${index} for ${featureId}`)
  const edge = (name: "top" | "left" | "bottom" | "right"): number => {
    const edgeValue = value[name]
    if (typeof edgeValue !== "number" || !Number.isSafeInteger(edgeValue) || edgeValue < 1) {
      fail(path, `invalid frame cellRectangle ${name} ${index} for ${featureId}`)
    }
    return edgeValue
  }
  const rectangle = { top: edge("top"), left: edge("left"), bottom: edge("bottom"), right: edge("right") }
  if (rectangle.bottom < rectangle.top || rectangle.right < rectangle.left) {
    fail(path, `invalid frame cellRectangle ${index} for ${featureId}: the rectangle is empty`)
  }
  return rectangle
}
const asString = (value: unknown, path: string, name: string): string =>
  nonempty(value) ? value : fail(path, `missing ${name}`)
const nullableString = (value: unknown, path: string, name: string): string | null =>
  value === null ? null : asString(value, path, name)

/** JSON.parse drops duplicate keys. Reject them before any evidence is selected. */
function rejectDuplicateKeys(source: string, path: string): void {
  let i = 0
  const ws = () => {
    // JSON.parse has already checked syntax; JSON whitespace is exactly these four bytes.
    while (i < source.length) {
      const code = source.charCodeAt(i)
      if (code !== 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) break
      i++
    }
  }
  const quoted = (): void => {
    i++
    while (i < source.length) {
      if (source[i] === "\\") {
        i += 2
        continue
      }
      if (source[i++] === '"') break
    }
  }
  const value = (): void => {
    ws()
    if (source[i] === "{") {
      i++
      const keys = new Set<string>()
      ws()
      while (source[i] !== "}") {
        const start = i
        quoted()
        const key = JSON.parse(source.slice(start, i)) as string
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

export function parseTarget(value: unknown, path: string): ProbeTarget {
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
  textSnapshotRefs: readonly string[],
  primaryRef: string | undefined,
  evidence: Observation["evidence"],
): ObservationFrame[] | undefined {
  if (value === undefined) return undefined
  if ((evidence !== "pixels" && evidence !== "text") || !Array.isArray(value) || value.length < 2) {
    fail(path, `invalid frames for ${featureId}; pixels require control and target`)
  }
  const frames: ObservationFrame[] = value.map((entry: unknown, index: number) => {
    if (!object(entry) || !["control", "target"].includes(String(entry.role))) {
      fail(path, `invalid frame role ${index} for ${featureId}`)
    }
    const ref = asString(entry.ref, path, `frame ${index} ref for ${featureId}`)
    if (!screenshotDigest(ref)) fail(path, `invalid frame ref ${index} for ${featureId}`)
    // Read-side exclusivity: a kind and its fields must agree, and the ref must be
    // listed under the SAME kind. A text snapshot in the screenshot list would be refused at
    // admission or served as an image, which is the confusion the union exists to prevent.
    const kind = entry.kind === undefined ? "pixels" : entry.kind
    if (kind !== "pixels" && kind !== "text-cells") {
      fail(path, `invalid frame kind ${String(entry.kind)} ${index} for ${featureId}`)
    }
    // Evidence and frame kind must agree: a text row is decided from the terminal's own cells and a
    // pixels row from a raster, so a run cannot grade one from the other's frame.
    if (evidence === "text" && kind !== "text-cells") {
      fail(path, `text observation for ${featureId} cites a ${kind} frame ${index}`)
    }
    if (evidence === "pixels" && kind !== "pixels") {
      fail(path, `pixels observation for ${featureId} cites a ${kind} frame ${index}`)
    }
    const textFields = ["cellDigest", "frameDigest", "cellRectangle"] as const
    const pixelFields = ["regionDigest", "pixelsDigest", "regionRectangle"] as const
    if (kind === "pixels") {
      const stray = textFields.find((field) => entry[field] !== undefined)
      if (stray !== undefined) {
        fail(path, `pixel frame ${index} for ${featureId} carries text field ${stray} without kind "text-cells"`)
      }
      if (!screenshotRefs.includes(ref)) {
        fail(path, `pixel frame ${ref} for ${featureId} is absent from the run's screenshotRefs`)
      }
    } else {
      const stray = pixelFields.find((field) => entry[field] !== undefined)
      if (stray !== undefined) {
        fail(path, `text-cells frame ${index} for ${featureId} carries pixel field ${stray}`)
      }
      if (!textSnapshotRefs.includes(ref)) {
        fail(path, `text-cells frame ${ref} for ${featureId} is absent from the run's textSnapshotRefs`)
      }
    }
    if (typeof entry.capturedAt !== "number" || !Number.isFinite(entry.capturedAt) || entry.capturedAt < 0) {
      fail(path, `invalid frame capturedAt ${index} for ${featureId}`)
    }
    const label = asString(entry.label, path, `frame ${index} label for ${featureId}`)
    const sourceRef = entry.sourceRef
    if (sourceRef !== undefined && !screenshotDigest(sourceRef)) {
      fail(path, `invalid frame sourceRef ${index} for ${featureId}`)
    }
    // The raw-pixel and cell-aligned digests are the frame's own measurement: an in-run verdict on
    // pixels is recomputable only while they survive the parse, so they are carried, not dropped.
    const regionDigest = entry.regionDigest
    if (regionDigest !== undefined && !screenshotDigest(regionDigest)) {
      fail(path, `invalid frame regionDigest ${index} for ${featureId}`)
    }
    const pixelsDigest = entry.pixelsDigest
    if (pixelsDigest !== undefined && !screenshotDigest(pixelsDigest)) {
      fail(path, `invalid frame pixelsDigest ${index} for ${featureId}`)
    }
    const regionRectangle = frameRegionRectangle(entry.regionRectangle, path, index, featureId)
    const base = {
      role: entry.role as ObservationFrame["role"],
      ref,
      capturedAt: entry.capturedAt,
      label,
      ...(sourceRef && { sourceRef }),
    }
    if (kind === "text-cells") {
      const cellDigest = asString(entry.cellDigest, path, `frame cellDigest ${index} for ${featureId}`)
      if (!screenshotDigest(cellDigest)) fail(path, `invalid frame cellDigest ${index} for ${featureId}`)
      const frameDigest = asString(entry.frameDigest, path, `frame frameDigest ${index} for ${featureId}`)
      if (!screenshotDigest(frameDigest)) fail(path, `invalid frame frameDigest ${index} for ${featureId}`)
      const cellRectangle = frameCellRectangle(entry.cellRectangle, path, index, featureId)
      return { ...base, kind: "text-cells" as const, cellDigest, frameDigest, cellRectangle }
    }
    return {
      ...base,
      ...(regionDigest && { regionDigest }),
      ...(pixelsDigest && { pixelsDigest }),
      ...(regionRectangle && { regionRectangle }),
    }
  })
  const targets = frames.filter((frame) => frame.role === "target")
  if (!frames.some((frame) => frame.role === "control") || targets.length === 0) {
    fail(path, `frames for ${featureId} require control and target`)
  }
  // A text verdict has no screenshot: its frames' own refs are the retained artifacts it cites.
  if (evidence === "pixels" && (!primaryRef || !targets.some((frame) => frame.ref === primaryRef))) {
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

/** The two committed suites that declared one recipe (version 1). Every later suite writes version 2. */
const VERSION_1_TEXT_QUALIFICATION_SUITES = ["448ce7769d2c", "f9450b3bc56a"]

/** A run's version and recipe: the header both its witnesses and its suite's declaration name. */
function parseTextQualificationHeader(
  value: Record<string, unknown>,
  path: string,
  fields: readonly string[],
): { version: number; recipe: string } {
  const unknown = Object.keys(value).find((key) => !fields.includes(key))
  if (unknown !== undefined) fail(path, `unknown textQualification field ${unknown}`)
  if (typeof value.version !== "number" || !Number.isSafeInteger(value.version) || value.version <= 0) {
    fail(path, "invalid textQualification version")
  }
  if (!nonempty(value.recipe) || !value.recipe.trim()) fail(path, "invalid textQualification recipe")
  return { version: value.version, recipe: value.recipe }
}

/** Structural ingestion only: completeness and recipe agreement belong to the selector. */
function parseTextQualificationSpec(value: unknown, path: string, probeHash: string): TextQualificationSpec {
  if (!object(value)) fail(path, "invalid textQualification object")
  if (value.version === 1) {
    if (!VERSION_1_TEXT_QUALIFICATION_SUITES.includes(probeHash)) {
      fail(
        path,
        `textQualification version 1 is read only for suites ${VERSION_1_TEXT_QUALIFICATION_SUITES.join(" and ")}`,
      )
    }
    const { recipe } = parseTextQualificationHeader(value, path, ["version", "recipe"])
    return { version: 1, recipe }
  }
  if (value.version !== 2) fail(path, "invalid textQualification version")
  const unknown = Object.keys(value).find((key) => !["version", "recipes"].includes(key))
  if (unknown !== undefined) fail(path, `unknown textQualification field ${unknown}`)
  if (
    !Array.isArray(value.recipes) ||
    value.recipes.length === 0 ||
    !value.recipes.every((recipe) => nonempty(recipe) && recipe.trim() !== "") ||
    new Set(value.recipes).size !== value.recipes.length
  ) {
    fail(path, "invalid textQualification recipes")
  }
  return { version: 2, recipes: value.recipes as string[] }
}

function parseTextQualificationOwnership(value: unknown, path: string): TextQualificationOwnership {
  const cell = object(value) ? value.cell : undefined
  if (
    !object(value) ||
    Object.keys(value).sort().join(",") !== "cell,host,observerRow" ||
    !object(cell) ||
    Object.keys(cell).sort().join(",") !== "col,row" ||
    ![cell.row, cell.col].every((edge) => typeof edge === "number" && Number.isSafeInteger(edge) && edge > 0) ||
    typeof value.host !== "string" ||
    typeof value.observerRow !== "string"
  ) {
    fail(path, "invalid textQualification console-host-ownership witness")
  }
  return {
    cell: { row: cell.row as number, col: cell.col as number },
    host: value.host,
    observerRow: value.observerRow,
  }
}

function parseTextQualification(
  value: unknown,
  path: string,
  textSnapshotRefs: readonly string[],
): TextQualification | undefined {
  if (value === undefined) return undefined
  if (!object(value)) fail(path, "invalid textQualification object")
  const spec = parseTextQualificationHeader(value, path, ["version", "recipe", "grid", "shapes"])
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
    const unknown = Object.keys(entry).find((key) => !["shape", "frames", "reason", "ownership"].includes(key))
    if (unknown !== undefined) fail(path, `unknown ${context} field ${unknown}`)
    if (["frames", "reason", "ownership"].filter((key) => Object.hasOwn(entry, key)).length > 1) {
      fail(path, `${context} carries more than one of frames, reason and ownership`)
    }
    if (Object.hasOwn(entry, "reason")) {
      if (!nonempty(entry.reason) || !entry.reason.trim()) fail(path, `invalid ${context} reason`)
      return { shape, reason: entry.reason }
    }
    // The ownership witness is two raw reads of one cell, never a frame; every other shape is frames.
    if (shape === "console-host-ownership") {
      return { shape, ownership: parseTextQualificationOwnership(entry.ownership, path) }
    }
    if (Object.hasOwn(entry, "ownership")) fail(path, `${context} cannot carry an ownership witness`)
    const frames = parseObservationFrames(entry.frames, path, context, [], textSnapshotRefs, undefined, "text")
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
function consoleBufferOwner(value: unknown, path: string, featureId: string): ConsoleBufferOwner {
  if (!object(value)) fail(path, `host for ${featureId} is not an object`)
  const image = asString(value.image, path, `host.image for ${featureId}`)
  if (image.length === 0) fail(path, `host.image for ${featureId} is empty`)
  const executablePath = asString(value.executablePath, path, `host.executablePath for ${featureId}`)
  if (!isAbsolute(executablePath) && !win32.isAbsolute(executablePath)) {
    fail(path, `host.executablePath for ${featureId} is not an absolute path`)
  }
  const executableSha256 = asString(value.executableSha256, path, `host.executableSha256 for ${featureId}`)
  if (!/^sha256:[0-9a-f]{64}$/u.test(executableSha256)) {
    fail(path, `host.executableSha256 for ${featureId} is not a sha256: digest`)
  }
  return { image, executablePath, executableSha256 }
}

function parseObservation(
  value: unknown,
  path: string,
  catalog: Set<string>,
  rawReplies: Record<string, string>,
  assertions: ProbeAssertion[],
  screenshotRefs: string[],
  textSnapshotRefs: string[],
): Observation {
  if (!object(value)) fail(path, "invalid observation")
  const featureId = asString(value.featureId, path, "observation.featureId")
  if (!catalog.has(featureId)) fail(path, `unknown feature ${featureId}`)
  validateObservationOutcome(value, path, featureId)
  // A console host belongs to a text read alone: it names the program whose buffer the read
  // returned, and a pixels row has no such program. Refused by name, like the frame stray fields,
  // so no run can carry a host that nothing reads (30055 AC4; @cto ruling 6255e75d condition 2).
  if (value.host !== undefined && value.evidence !== "text") {
    fail(path, `${String(value.evidence)} observation for ${featureId} carries host, which only a text read records`)
  }
  if (value.evidence === "none" && value.screenshotRef !== undefined) {
    fail(path, `none evidence for ${featureId} cannot carry screenshotRef`)
  }
  if (value.evidence === "none" && value.frames !== undefined) {
    fail(path, `none evidence for ${featureId} cannot carry frames`)
  }
  // A pixels verdict is allowed only as a decided frame pair. Equality of retained digests is a
  // measurement, so it belongs in the raw run; a lone screenshotRef is still a pixel the collector
  // cannot decide, and it keeps the old refusal. Bounds, roles and capturedAt are enforced below.
  if (
    (value.evidence === "pixels" || value.evidence === "text") &&
    (value.outcome === "supported" || value.outcome === "unsupported") &&
    value.frames === undefined
  ) {
    fail(
      path,
      `${String(value.evidence)} verdict for ${featureId} requires control and target frames; a lone screenshotRef stays inconclusive`,
    )
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
  // A text snapshot is never a screenshot: the two lists name different artifact kinds, and a text
  // row points at its frames alone.
  if (value.evidence === "text" && screenshotRef !== undefined) {
    fail(path, `text observation ${featureId} cannot carry screenshotRef`)
  }
  if (screenshotRef && !screenshotRefs.includes(screenshotRef)) {
    fail(path, `screenshotRef ${screenshotRef} is absent from run`)
  }
  const frames = parseObservationFrames(
    value.frames,
    path,
    featureId,
    screenshotRefs,
    textSnapshotRefs,
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
  if (value.host !== undefined) observation.host = consoleBufferOwner(value.host, path, featureId)
  if (value.note !== undefined) observation.note = asString(value.note, path, `note for ${featureId}`)
  validateObservation(observation, path, rawReplies, assertions)
  // A pixels verdict the collector decided in-run is a measurement, so the run alone must be able
  // to recompute it: its own assertion, bound like every other measuring evidence, and every digest
  // that assertion cites is a frame's ref or cell-aligned regionDigest. A reviewed Interpretation is
  // exempt — its evidence is the frame pair itself, checked by its own validator.
  if (
    (observation.evidence === "pixels" || observation.evidence === "text") &&
    (observation.outcome === "supported" || observation.outcome === "unsupported")
  ) {
    requireCitedFrameDigests(observation, boundAssertion(observation, path, assertions), path)
  }
  return observation
}

/** The run's own conclusive assertion for an observation, bound by rawReplyRef like every measurement. */
function boundAssertion(observation: Observation, path: string, assertions: readonly ProbeAssertion[]): ProbeAssertion {
  const { featureId, outcome, rawReplyRef } = observation
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
  return assertion
}

/** Keeps a pixels verdict recomputable: every digest it cites is a frame's ref or cell-aligned regionDigest, and it cites one. */
function requireCitedFrameDigests(observation: Observation, assertion: ProbeAssertion, path: string): void {
  const { featureId } = observation
  const frames = observation.frames ?? []
  const cited = assertion.observed.match(/sha256:[0-9a-f]{64}/g) ?? []
  if (cited.length === 0) {
    fail(path, `${observation.evidence} verdict for ${featureId} must cite the frame digest it decided on`)
  }
  for (const digest of cited) {
    // The same accessor the probe compares with, so a text verdict recomputes exactly as a pixel one
    // does: the cited digest must be a frame's ref or the digest of the cells it compared. The
    // whole-frame digest is NOT enough, because a verdict citing it alone decided no cells.
    if (
      !frames.some((frame) => {
        const digests = frameDigests(frame)
        return frame.ref === digest || digests.cells === digest
      })
    ) {
      fail(
        path,
        `${observation.evidence} verdict for ${featureId} cites ${digest}, which is not the ref or a digest of a frame in this observation`,
      )
    }
  }
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
  // A pixels observation reaching this validator is a reviewed Interpretation: its evidence is the
  // frame pair, not an assertion in the run, and selected-results checks those frames itself. The
  // raw-run path enforces the recomputability of the collector's own pixels verdicts in parseObservation.
  if (evidence === "pixels" || evidence === "text") return
  const assertion = boundAssertion(observation, path, assertions)
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
  const pointerKeys = ["freeze", "textClaims", "textQualification", "catalogIds"]
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
      if (!probes.app.includes(id)) fail(path, `suite textClaims ${id} is outside app suite membership`)
    }
  }
  const textQualification =
    "textQualification" in value ? parseTextQualificationSpec(value.textQualification, path, probeHash) : undefined
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
 * exactly one version token equal to the run's declared target version; a second bare number (a
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
  if (versionTokens.length !== 1 || versionTokens[0] !== target.version) {
    fail(path, `provenance.executable.version differs from target.version ${target.version}`)
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

export function parseOuterApp(
  value: unknown,
  target: ProbeTarget,
  originKind: RunOrigin["kind"],
  expected: { probeHash: string; sourceRevision: string },
  path: string,
): OuterAppProof | undefined {
  if (value === undefined) return undefined
  if (target.kind !== "mux") fail(path, "outerApp is only valid for a mux target")
  if (
    !object(value) ||
    Object.keys(value).some((key) => !["target", "rawReplies", "provenance", "appLaunch"].includes(key))
  ) {
    fail(path, "invalid outerApp fields")
  }
  const outerTarget = parseTarget(value.target, `${path}.outerApp`)
  if (outerTarget.kind !== "app" || outerTarget.outerTerminal !== null || outerTarget.mux !== null) {
    fail(path, "outerApp requires one app target without another outer terminal or mux")
  }
  if (target.outerTerminal !== outerTarget.id || target.mux !== target.id) {
    fail(path, "outerApp disagrees with the claimed outer terminal or mux")
  }
  if (
    target.os !== outerTarget.os ||
    target.osVersion !== outerTarget.osVersion ||
    target.permissions !== outerTarget.permissions
  ) {
    fail(path, "outerApp disagrees with the run OS or permission context")
  }
  if (!object(value.rawReplies) || !Object.values(value.rawReplies).every((reply) => typeof reply === "string")) {
    fail(path, "invalid outerApp.rawReplies")
  }
  const provenance = parseRunProvenance(value.provenance, outerTarget, expected, `${path}.outerApp`)
  const appLaunch = parseAppLaunchReceipt(value.appLaunch, originKind, outerTarget.kind, `${path}.outerApp`)
  return {
    target: { ...outerTarget, kind: "app" },
    rawReplies: value.rawReplies as Record<string, string>,
    ...(provenance && { provenance }),
    ...(appLaunch && { appLaunch }),
  }
}

/** Typed capability review of immutable capture bytes, separate from final-run admission review. */
export function parseCaptureDecision(value: unknown, path: string, catalog: ReadonlySet<string>): CaptureDecision {
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
  if (
    !object(scope) ||
    !object(scope.target) ||
    !["app", "headless", "mux"].includes(String(scope.target.kind)) ||
    !nonempty(scope.target.id)
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
  return value as unknown as CaptureDecision
}

/** The existing raw-reply custody retains only binding metadata, never duplicate frame/trace blobs. */
function captureBindingSource(
  draft: Pick<
    RunDraft,
    | "runId"
    | "suiteId"
    | "probeHash"
    | "sourceRevision"
    | "intendedContext"
    | "target"
    | "results"
    | "rawReplies"
    | "assertions"
  >,
  featureId: string,
): string {
  const result = draft.results.find((entry) => entry.featureId === featureId)
  if (!result) throw new Error(`Capture feature ${featureId} is outside frozen catalogue`)
  const rawKeys = new Set<string>()
  if (result.rawReplyRef) rawKeys.add(result.rawReplyRef)
  for (const check of result.checks) if (check.rawReplyRef) rawKeys.add(check.rawReplyRef)
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
    result.checks.filter((check) => check.id === "review").flatMap((check) => check.assertionRefs ?? []),
  )
  const assertionRefs = draft.assertions.flatMap((assertion, index) =>
    assertion.featureId === featureId && !reviewAssertions.has(index)
      ? [{ index, sha256: hash(JSON.stringify(assertion)) }]
      : [],
  )
  return JSON.stringify({
    runId: draft.runId,
    probeHash: draft.probeHash,
    sourceRevision: draft.sourceRevision,
    intendedContext: draft.intendedContext,
    ...(draft.target && { target: draft.target }),
    featureId,
    rawReplyRefs,
    assertionRefs,
    frames: result.frames ?? [],
    ...(result.screenshotRef && { screenshotRef: result.screenshotRef }),
    ...(result.host && { host: result.host }),
    ...(result.evidence && { evidence: result.evidence }),
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
  if (!result?.checks.some((check) => check.id === "review")) {
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
): void {
  const source = draft.rawReplies[`collector.capture.${decision.featureId}`]
  if (!source || createHash("sha256").update(source, "utf8").digest("hex") !== decision.captureSha256) {
    fail(path, "capture digest mismatch or absent capture")
  }
  if (source !== captureBindingSource(draft, decision.featureId)) {
    fail(path, "capture context/source/suite/evidence binding changed")
  }
  if (decision.runId !== draft.runId) fail(path, "capture runId mismatch")
  const context = draft.target ?? draft.intendedContext
  if (
    decision.scope.target.kind !== context.kind ||
    decision.scope.target.id !== context.id ||
    decision.scope.versions[0] !== context.version ||
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
  if (!result || !result.checks.some((check) => check.id === "review" && check.status === "test-todo")) {
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
  const checks = result.checks.map((check): CheckResult =>
    check.id === "review"
      ? {
          ...check,
          status: decision.decision,
          attempt: { scope: "probe", startedAt },
          reviewRef,
          reason: decision.reason,
          ...(assertionRefs && { assertionRefs }),
        }
      : check,
  )
  draft.rawReplies[reviewRef] = source
  draft.results[index] = finalizeCapabilityResult({
    ...result,
    checks,
    reviewRef,
    reason: decision.reason,
    attempt: { scope: "probe", startedAt },
  })
}

/** Validate recorded execution facts; this never infers a current result from a missing row. */
function capabilityAttempt(value: unknown, path: string, rawReplies: Record<string, string>): CapabilityAttempt {
  if (!object(value) || !["none", "collection", "probe"].includes(String(value.scope))) {
    fail(path, "invalid capability attempt scope")
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

export function parseCapabilityResults(
  value: unknown,
  path: string,
  expected: ReadonlySet<string>,
  rawReplies: Record<string, string>,
  assertions: readonly ProbeAssertion[],
  screenshotRefs: readonly string[] = [],
  textSnapshotRefs: readonly string[] = [],
): CapabilityResult[] {
  if (!Array.isArray(value)) fail(path, "missing explicit capability results")
  const seen = new Set<string>()
  const results = value.map((item): CapabilityResult => {
    if (!object(item) || !nonempty(item.featureId)) fail(path, "invalid capability result")
    const featureId = item.featureId
    if (seen.has(featureId)) fail(path, `duplicate capability ${featureId}`)
    seen.add(featureId)
    if (!expected.has(featureId)) fail(path, `${featureId} is outside frozen catalogue membership`)
    if (!CAPABILITY_STATUSES.includes(item.status as CapabilityResult["status"])) {
      fail(path, `invalid capability status for ${featureId}`)
    }
    const status = item.status as CapabilityResult["status"]
    const attempt = capabilityAttempt(item.attempt, `${path}: ${featureId}`, rawReplies)
    if (["test-todo", "test-failure", "untestable"].includes(status) && !nonempty(item.reason)) {
      fail(path, `${featureId} ${status} requires reason`)
    }
    if (status === "test-failure" && attempt.scope === "none") {
      fail(path, `${featureId} failure requires a retained attempt`)
    }
    if (!Array.isArray(item.checks)) fail(path, `${featureId} requires its explicit check set`)
    const checkIds = new Set<string>()
    const checks = item.checks.map((entry): CheckResult => {
      if (!object(entry) || !nonempty(entry.id) || checkIds.has(entry.id)) {
        fail(path, `${featureId} requires unique check ids`)
      }
      checkIds.add(entry.id)
      if (!CAPABILITY_STATUSES.includes(entry.status as CheckResult["status"])) {
        fail(path, `invalid check status for ${featureId}/${entry.id}`)
      }
      const checkAttempt = capabilityAttempt(entry.attempt, `${path}: ${featureId}/${entry.id}`, rawReplies)
      if (entry.status !== "test-todo" && checkAttempt.scope === "none") {
        fail(path, `decided check ${featureId}/${entry.id} has no attempt`)
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
        fail(path, `missing raw check evidence for ${featureId}`)
      }
      return { ...entry, attempt: checkAttempt } as unknown as CheckResult
    })
    const result = { ...item, featureId, status, attempt, checks } as unknown as CapabilityResult
    if (finalizeCapabilityResult(result).status !== status) {
      fail(path, `${featureId} recorded status hides required check work`)
    }
    if (status === "supported" || status === "unsupported") {
      if (
        attempt.scope === "none" ||
        !item.evidence ||
        isNonMeasuringEvidence(item.evidence as Observation["evidence"])
      ) {
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
      )
      if (
        item.evidence === "text" &&
        !checks.some((check) => check.id === "text-qualification" && check.status === "supported")
      ) {
        fail(path, `${featureId} text support requires its recorded qualification check`)
      }
      const deciding = checks.filter((check) => check.status === status)
      if (
        !deciding.some((check) =>
          (check.assertionRefs ?? []).some((index) => {
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
      const key = result.reviewRef ?? checks.find((check) => check.status === "untestable")?.reviewRef
      if (!key || !rawReplies[key]) fail(path, `${featureId} requires its immutable reviewed impossibility reason`)
      const review = parseCaptureDecision(parseJsonStrict(`${path}: ${key}`, rawReplies[key]), path, expected)
      if (review.decision !== "untestable" || review.featureId !== featureId || review.reason !== result.reason) {
        fail(path, `${featureId} invalid context-impossibility review`)
      }
    }
    return result
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
  const raw = parseJsonStrict(path, source)
  if (!object(raw)) fail(path, "run must be an object")
  if (raw.outerApp !== undefined && raw.schemaVersion !== 2 && raw.schemaVersion !== 3) {
    fail(path, "outerApp requires a schema-v2 mux run")
  }
  if (raw.schemaVersion !== undefined && raw.schemaVersion !== 2 && raw.schemaVersion !== 3) {
    fail(path, `unsupported schemaVersion ${String(raw.schemaVersion)}`)
  }
  const citedCatalog = raw.schemaVersion === 3 ? suites.get(String(raw.probeHash))?.catalogIds : undefined
  if (raw.schemaVersion === 3 && !citedCatalog) fail(path, "current run requires frozen catalogue membership")
  const catalog = new Set(citedCatalog ?? catalogIds)
  const sha256 = createHash("sha256").update(source).digest("hex")
  if (raw.schemaVersion === 2 || raw.schemaVersion === 3) {
    const current = raw.schemaVersion === 3
    if (!current && Object.hasOwn(raw, "results")) fail(path, "v2 run cannot contain legacy boolean results")
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
      ),
    )
    if (new Set(observations.map((v) => v.featureId)).size !== observations.length) {
      fail(path, "duplicate observation feature ID")
    }
    if (!current && raw.suiteComplete !== true && raw.suiteComplete !== false) fail(path, "missing suiteComplete")
    const probeHash = asString(raw.probeHash, path, "probeHash")
    const sourceRevision = asString(raw.sourceRevision, path, "sourceRevision")
    const provenance = parseRunProvenance(raw.provenance, target, { probeHash, sourceRevision }, path)
    const outerApp = parseOuterApp(
      raw.outerApp,
      target,
      raw.origin.kind as RunOrigin["kind"],
      { probeHash, sourceRevision },
      path,
    )
    const manifest = suites.get(probeHash)
    if (!manifest || manifest.probeHash !== probeHash) {
      fail(path, `unknown suite ${probeHash}; missing trusted manifest`)
    }
    const expected = new Set(current ? manifest.catalogIds : manifest.probes[target.kind])
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
    if (!current && raw.suiteComplete !== suiteComplete) {
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
    const results = current
      ? parseCapabilityResults(
          raw.results,
          path,
          expected,
          raw.rawReplies as Record<string, string>,
          assertions,
          raw.screenshotRefs as string[],
          textSnapshotRefs,
        )
      : undefined
    if (current && results) {
      if (
        raw.sealedAt !== undefined &&
        results.some((result) => result.checks.some((check) => check.id === "review" && check.status === "test-todo"))
      ) {
        fail(path, "required review pending; retain its unsealed capture")
      }
      if (!object(raw.intendedContext)) fail(path, "current run requires intendedContext")
      const captureRun = {
        runId,
        suiteId: asString(raw.suiteId, path, "suiteId"),
        probeHash,
        sourceRevision,
        intendedContext: raw.intendedContext as Partial<ProbeTarget>,
        target,
        results,
        rawReplies: raw.rawReplies as Record<string, string>,
        assertions,
      }
      for (const result of results) {
        const refs = new Set(
          [result.reviewRef, ...result.checks.map((check) => check.reviewRef)].filter(
            (ref): ref is string => ref !== undefined,
          ),
        )
        for (const ref of refs) {
          const bytes = captureRun.rawReplies[ref]
          if (!bytes) fail(path, `missing immutable capture decision ${ref}`)
          const decision = parseCaptureDecision(parseJsonStrict(path, bytes), path, expected)
          if (decision.featureId !== result.featureId) fail(path, "capture decision feature mismatch")
          validateCaptureBinding(captureRun, decision, path)
          for (const check of result.checks.filter((check) => check.reviewRef === ref)) {
            if (check.status !== decision.decision) fail(path, "capture decision differs from recorded check")
          }
        }
      }
    }
    return {
      path,
      sha256,
      schemaVersion: raw.schemaVersion,
      ...(current
        ? {
            results,
            catalogIds: [...expected],
            sealedAt: raw.sealedAt as string,
            intendedContext: raw.intendedContext as Partial<ProbeTarget>,
          }
        : {}),
      runId,
      target,
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
      assertions,
      screenshotRefs: raw.screenshotRefs as string[],
      textSnapshotRefs,
      ...(textQualification === undefined ? {} : { textQualification }),
      ...(manifest.textQualification === undefined ? {} : { textQualificationSpec: manifest.textQualification }),
      ...(manifest.textClaims === undefined ? {} : { textClaims: manifest.textClaims }),
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
    target: measured.target,
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

/** Canonical live collector transport is an unsealed schema-3 capture; final writer seals later. */
export function decodeCollectorDraft(
  path: string,
  raw: string,
  manifest: ProbeSuiteManifest,
  collectorRevision: string,
): { run: CapturedRunDraft; raw: string; sha256: string } {
  const value = parseJsonStrict(path, raw)
  if (!object(value) || value.schemaVersion !== 3 || Object.hasOwn(value, "sealedAt")) {
    fail(path, "expected unsealed schemaVersion 3 collector draft")
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
  if (measured.schemaVersion !== 3) fail(path, "expected sealed schemaVersion 3 collector run")
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
