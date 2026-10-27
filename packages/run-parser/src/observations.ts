/** Versioned observation decoding. Historical wire labels and selection facts stay private here. */
import { isAbsolute, win32 } from "node:path"
import {
  ASSERTION_TYPES,
  OBSERVATION_OUTCOMES,
  OBSERVATION_REASONS,
  frameDigests,
  type AssertionType,
  type Observation,
  type ObservationFrame,
  type ProbeAssertion,
  type ProbeResult,
  type ConsoleBufferOwner,
  type HistoricalProbeRun,
  type TextQualificationAssessment,
} from "@terminfo/probe-defs"
import type { LoadedRun } from "./index.ts"
import { parseJsonStrict } from "./json.ts"

type ReadObservation = HistoricalProbeRun["observations"][number]
type ReadAssertion = HistoricalProbeRun["assertions"][number]
// Only strict historical inputs use these values. They never leave this reader.
const HISTORICAL_EVIDENCE = [
  "query",
  "behavior",
  "parser-state",
  "pixels",
  "text",
  "interaction",
  "consumed",
  "legacy",
  "none",
] as const
type HistoricalEvidence = (typeof HISTORICAL_EVIDENCE)[number]
type ObservationInput = ReadObservation & { evidence?: HistoricalEvidence }
const historical = new WeakMap<
  object,
  {
    input: ObservationInput
    nonMeasuring: boolean
    requiresTextQualification: boolean
  }
>()
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
const nonempty = (value: unknown): value is string => typeof value === "string" && value.length > 0
const screenshotDigest = (value: unknown): value is string =>
  typeof value === "string" && /^sha256:[0-9a-f]{64}$/.test(value)
function fail(path: string, message: string): never {
  throw new Error(`${path}: ${message}`)
}
const asString = (value: unknown, path: string, name: string): string =>
  nonempty(value) ? value : fail(path, `missing ${name}`)
const textRead = (value: ObservationInput): boolean =>
  value.evidence === "text" ||
  (value.evidence === undefined &&
    value.assertionType === "buffer_state" &&
    value.frames?.some((frame) => frame.kind === "text-cells") === true)
const pixelRead = (value: ObservationInput): boolean =>
  value.evidence === "pixels" || value.assertionType === "screenshot"
const nonMeasuring = (evidence: HistoricalEvidence | undefined): boolean =>
  evidence === "consumed" || evidence === "none" || evidence === "legacy"
const methodName = (value: ObservationInput): string =>
  value.evidence ?? value.assertionType ?? "unclassified historical"

function classifyHistorical(input: ObservationInput, rawReplies: Record<string, string>): AssertionType | undefined {
  const raw = input.rawReplyRef === undefined ? undefined : rawReplies[input.rawReplyRef]
  switch (input.evidence) {
    case "pixels":
      return input.screenshotRef || input.frames?.some((frame) => frame.kind !== "text-cells")
        ? "screenshot"
        : undefined
    case "text":
      return input.frames?.some((frame) => frame.kind === "text-cells") || nonempty(raw) ? "buffer_state" : undefined
    case "parser-state":
      return nonempty(raw) ? "buffer_state" : undefined
    case "query": {
      if (!nonempty(raw)) return undefined
      // A trace's retained writes/empty query attempts are not returned query bytes.
      if (raw.startsWith("{")) {
        let payload: unknown
        try {
          payload = JSON.parse(raw)
        } catch {
          return "query_reply"
        }
        if (object(payload) && Array.isArray(payload.queries)) {
          return payload.queries.some((query) => object(query) && nonempty(query.raw)) ? "query_reply" : undefined
        }
      }
      return "query_reply"
    }
    // The old label does not establish how the deciding value was read.
    default:
      return undefined
  }
}

function projectHistorical(input: ObservationInput, rawReplies: Record<string, string>): ReadObservation {
  const { evidence, ...fields } = input
  const assertionType = classifyHistorical(input, rawReplies)
  const projected: ReadObservation = { ...fields, ...(assertionType === undefined ? {} : { assertionType }) }
  historical.set(projected, {
    input,
    nonMeasuring: nonMeasuring(evidence),
    requiresTextQualification: evidence === "text",
  })
  return projected
}

/** Old booleans remain unverified and ungraded, with no invented observable. */
export function decodeLegacyBooleanObservation(featureId: string, supported: boolean): ReadObservation {
  return projectHistorical({ featureId, outcome: supported ? "supported" : "unsupported", evidence: "legacy" }, {})
}

/** Associate a strictly decoded historical result with its own original primary observation. */
export function projectHistoricalResult(
  value: Record<string, unknown>,
  tests: ProbeResult["tests"],
  rawReplies: Record<string, string>,
): ProbeResult {
  const { evidence, checks: _checks, ...fields } = value
  const result = { ...fields, tests } as unknown as ProbeResult
  if (evidence !== undefined) {
    if (!HISTORICAL_EVIDENCE.includes(evidence as HistoricalEvidence))
      fail("historical result", `invalid evidence for ${String(value.featureId)}`)
    const input = { ...value, outcome: value.status } as unknown as ObservationInput
    const assertionType = classifyHistorical(input, rawReplies)
    if (assertionType !== undefined) result.assertionType = assertionType
    historical.set(result, {
      input,
      nonMeasuring: nonMeasuring(evidence as HistoricalEvidence),
      requiresTextQualification: evidence === "text",
    })
  }
  return result
}

/** Assertion classification follows its own binding; a different primary result cannot classify it. */
export function projectHistoricalAssertions(
  assertions: readonly ReadAssertion[],
  observations: readonly (ReadObservation | ProbeResult)[],
  rawReplies: Record<string, string>,
): ReadAssertion[] {
  return assertions.map((assertion) => {
    const bound = observations.filter(
      (observation) =>
        observation.featureId === assertion.featureId &&
        observation.rawReplyRef !== undefined &&
        observation.rawReplyRef === assertion.rawReplyRef,
    )
    const types = new Set(
      bound.flatMap((observation) => {
        const input = historical.get(observation)?.input
        if (!input || !nonempty(assertion.observed)) return []
        const type = classifyHistorical(input, rawReplies)
        // A frame assertion must actually cite a retained frame digest.
        if (
          (type === "screenshot" || textRead(input)) &&
          !(input.frames ?? []).some(
            (frame) =>
              assertion.observed.includes(frame.ref) ||
              (frameDigests(frame).cells !== undefined && assertion.observed.includes(frameDigests(frame).cells!)),
          )
        )
          return []
        return type === undefined ? [] : [type]
      }),
    )
    const [assertionType] = types
    return { ...assertion, ...(types.size === 1 && assertionType !== undefined ? { assertionType } : {}) }
  })
}

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
export function parseObservationFrames(
  value: unknown,
  path: string,
  featureId: string,
  screenshotRefs: readonly string[],
  textSnapshotRefs: readonly string[],
  primaryRef: string | undefined,
  assertionType: AssertionType | undefined,
): ObservationFrame[] | undefined {
  if (value === undefined) return undefined
  if (
    (assertionType !== "screenshot" && assertionType !== "buffer_state") ||
    !Array.isArray(value) ||
    value.length < 2
  ) {
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
    if (assertionType === "buffer_state" && kind !== "text-cells") {
      fail(path, `text observation for ${featureId} cites a ${kind} frame ${index}`)
    }
    if (assertionType === "screenshot" && kind !== "pixels") {
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
  if (assertionType === "screenshot" && (!primaryRef || !targets.some((frame) => frame.ref === primaryRef))) {
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

/** Structural ingestion only: completeness and recipe agreement belong to the selector. */
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

export function parseObservation(
  value: unknown,
  path: string,
  catalog: Set<string>,
  rawReplies: Record<string, string>,
  assertions: ReadAssertion[],
  screenshotRefs: string[],
  textSnapshotRefs: string[],
  schemaVersion: 2 | 3 | 4 = 4,
): ReadObservation {
  if (!object(value)) fail(path, "invalid observation")
  const featureId = asString(value.featureId, path, "observation.featureId")
  if (!catalog.has(featureId)) fail(path, `unknown feature ${featureId}`)
  validateObservationOutcome(value, path, featureId, schemaVersion)
  const input = value as unknown as ObservationInput
  // A console host belongs to a text read alone: it names the program whose buffer the read
  // returned, and a pixels row has no such program. Refused by name, like the frame stray fields,
  // so no run can carry a host that nothing reads (30055 AC4; @cto ruling 6255e75d condition 2).
  if (value.host !== undefined && !textRead(input)) {
    fail(path, `${methodName(input)} observation for ${featureId} carries host, which only a text read records`)
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
    (pixelRead(input) || textRead(input)) &&
    (value.outcome === "supported" || value.outcome === "unsupported") &&
    value.frames === undefined
  ) {
    fail(
      path,
      `${methodName(input)} verdict for ${featureId} requires control and target frames; a lone screenshotRef stays inconclusive`,
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
  if (pixelRead(input) && value.outcome !== "error" && !screenshotRef) {
    fail(path, `pixels observation ${featureId} requires screenshotRef`)
  }
  // A text snapshot is never a screenshot: the two lists name different artifact kinds, and a text
  // row points at its frames alone.
  if (textRead(input) && screenshotRef !== undefined) {
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
    pixelRead(input) ? "screenshot" : textRead(input) ? "buffer_state" : input.assertionType,
  )
  const observation: ObservationInput = {
    featureId,
    outcome: value.outcome as Observation["outcome"],
    ...(schemaVersion === 4
      ? { assertionType: value.assertionType as AssertionType }
      : { evidence: value.evidence as HistoricalEvidence }),
  }
  if (value.reason !== undefined) observation.reason = value.reason as Observation["reason"]
  if (rawReplyRef) observation.rawReplyRef = rawReplyRef
  if (screenshotRef) observation.screenshotRef = screenshotRef
  if (frames) observation.frames = frames
  if (value.host !== undefined) observation.host = consoleBufferOwner(value.host, path, featureId)
  if (value.note !== undefined) observation.note = asString(value.note, path, `note for ${featureId}`)
  validateInput(observation, path, rawReplies, assertions)
  // A pixels verdict the collector decided in-run is a measurement, so the run alone must be able
  // to recompute it: its own assertion, bound like every other measuring evidence, and every digest
  // that assertion cites is a frame's ref or cell-aligned regionDigest. A reviewed Interpretation is
  // exempt — its evidence is the frame pair itself, checked by its own validator.
  if (
    (pixelRead(observation) || textRead(observation)) &&
    (observation.outcome === "supported" || observation.outcome === "unsupported")
  ) {
    requireCitedFrameDigests(observation, boundAssertion(observation, path, assertions), path)
  }
  return schemaVersion === 4 ? observation : projectHistorical(observation, rawReplies)
}

/** The run's own conclusive assertion for an observation, bound by rawReplyRef like every measurement. */
function boundAssertion(
  observation: ReadObservation,
  path: string,
  assertions: readonly ReadAssertion[],
): ReadAssertion {
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
function requireCitedFrameDigests(observation: ObservationInput, assertion: ReadAssertion, path: string): void {
  const { featureId } = observation
  const frames = observation.frames ?? []
  const cited = assertion.observed.match(/sha256:[0-9a-f]{64}/g) ?? []
  if (cited.length === 0) {
    fail(path, `${methodName(observation)} verdict for ${featureId} must cite the frame digest it decided on`)
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
        `${methodName(observation)} verdict for ${featureId} cites ${digest}, which is not the ref or a digest of a frame in this observation`,
      )
    }
  }
}

function validateInput(
  observation: ObservationInput,
  path: string,
  rawReplies: Record<string, string>,
  assertions: readonly ReadAssertion[],
): void {
  const { featureId, evidence, outcome, rawReplyRef } = observation
  if (rawReplyRef && !Object.hasOwn(rawReplies, rawReplyRef)) {
    fail(path, `missing raw reply ${rawReplyRef} for ${featureId}`)
  }
  if ((outcome === "supported" || outcome === "unsupported") && nonMeasuring(evidence)) {
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
  if (pixelRead(observation) || textRead(observation)) return
  const assertion = boundAssertion(observation, path, assertions)
  if (
    evidence === "parser-state" ||
    evidence === "interaction" ||
    observation.assertionType === "buffer_state" ||
    observation.assertionType === "input_bytes"
  ) {
    const state = parseJsonStrict(`${path}: ${featureId} state snapshot`, assertion.observed)
    if (!object(state) || Object.keys(state).length === 0) fail(path, `${featureId} requires an actual state snapshot`)
    if ((evidence === "interaction" || observation.assertionType === "input_bytes") && !nonempty(assertion.action)) {
      fail(path, `${featureId} requires the performed action`)
    }
  }
}

export function validateObservationOutcome(
  value: Record<string, unknown>,
  path: string,
  featureId: string,
  schemaVersion: 2 | 3 | 4 = 4,
): void {
  if (!OBSERVATION_OUTCOMES.includes(value.outcome as Observation["outcome"])) {
    fail(path, `invalid outcome for ${featureId}`)
  }
  if (schemaVersion === 4) {
    if (Object.hasOwn(value, "evidence")) fail(path, `schema 4 observation ${featureId} cannot carry evidence`)
    if (!ASSERTION_TYPES.includes(value.assertionType as AssertionType))
      fail(path, `invalid assertionType for ${featureId}`)
  } else {
    if (Object.hasOwn(value, "assertionType"))
      fail(path, `historical observation ${featureId} cannot carry assertionType`)
    if (!HISTORICAL_EVIDENCE.includes(value.evidence as HistoricalEvidence))
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

/** Validate current or strictly decoded historical correction against this run's retained bytes. */
export function validateObservation(
  observation: ReadObservation,
  path: string,
  rawReplies: Record<string, string>,
  assertions: readonly ReadAssertion[],
): void {
  validateInput(historical.get(observation)?.input ?? observation, path, rawReplies, assertions)
}

/** Decode a historical correction's shape; run-bound validation follows before selection. */
export function decodeHistoricalCorrection(value: unknown, path: string, featureId: string): ReadObservation {
  if (!object(value)) fail(path, `invalid observation in ${featureId}`)
  validateObservationOutcome(value, path, featureId, 2)
  if (value.evidence === "pixels" && !nonempty(value.screenshotRef))
    fail(path, `pixels correction ${featureId} requires screenshotRef`)
  if (value.evidence === "query" && !nonempty(value.rawReplyRef))
    fail(path, `query correction ${featureId} requires rawReplyRef`)
  return projectHistorical(value as unknown as ObservationInput, {})
}

export function canConcludeObservation(
  run: LoadedRun,
  observation: ReadObservation,
  text: TextQualificationAssessment,
): boolean {
  const facts = historical.get(observation)
  const requiresTextQualification = facts?.requiresTextQualification ?? textRead(observation)
  return (
    !run.legacy &&
    (!requiresTextQualification ||
      (run.subject.kind === "term" &&
        run.subject.os?.toLowerCase() === "macos" &&
        observation.host === undefined &&
        !run.observations.some(
          (recorded) => recorded.featureId === observation.featureId && recorded.host !== undefined,
        ) &&
        text.qualified &&
        run.textClaims?.includes(observation.featureId) === true)) &&
    !(facts?.nonMeasuring ?? observation.assertionType === undefined) &&
    (observation.outcome === "supported" || observation.outcome === "unsupported")
  )
}

export function textQualificationFailure(
  run: LoadedRun,
  observation: ReadObservation,
  text: TextQualificationAssessment,
): string | undefined {
  return (historical.get(observation)?.requiresTextQualification ?? textRead(observation)) &&
    run.textQualification !== undefined &&
    !text.qualified
    ? text.reason
    : undefined
}

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

export function consoleHostHold(
  run: LoadedRun,
  cell: { featureId: string; assertionType?: AssertionType; rawReplyRef?: string },
  verdict: string,
): string | undefined {
  if (run.subject.kind !== "term" || run.subject.os?.toLowerCase() !== "windows") return undefined
  if (verdict !== "supported" && verdict !== "unsupported") return undefined
  const old = historical.get(cell)?.input.evidence
  if (
    (old !== undefined ? old !== "query" && old !== "behavior" : cell.assertionType !== "query_reply") ||
    cell.rawReplyRef === undefined
  )
    return undefined
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

const TEMPORAL_PIXEL_FEATURES = new Set([
  "sgr.blink",
  "extensions.kitty-graphics.animation",
  "modes.synchronized-output",
  "extensions.osc555-flash",
])

/** Run-bound interpretation validation precedes selection, including the historical rule set. */
export function validateCorrectedObservation(
  run: LoadedRun,
  entry: {
    id: string
    featureId?: string
    runId?: string
    runSha256?: string
    observation?: ReadObservation
  },
): ReadObservation {
  if (!entry.observation || !entry.featureId) fail(entry.id, "correction requires feature and observation")
  const recordedObservation = run.observations.find((observation) => observation.featureId === entry.featureId)
  if (!recordedObservation) fail(entry.id, `no raw observation for ${entry.featureId}`)
  const original = historical.get(entry.observation!)?.input
  const input: ObservationInput = original ?? entry.observation!
  validateObservationOutcome(
    input as unknown as Record<string, unknown>,
    entry.id,
    entry.featureId!,
    original === undefined ? 4 : 2,
  )
  const observation = original === undefined ? entry.observation! : projectHistorical(original, run.rawReplies)
  validateObservation(observation, `interpretation ${entry.id}`, run.rawReplies, run.assertions)
  if ((input.evidence === "query" || input.assertionType === "query_reply") && !observation.rawReplyRef) {
    throw new Error(`interpretation ${entry.id}: query requires rawReplyRef`)
  }
  if (pixelRead(input) && !observation.screenshotRef) {
    throw new Error(`interpretation ${entry.id}: pixels requires screenshotRef`)
  }
  if (textRead(input) && observation.screenshotRef) {
    throw new Error(`interpretation ${entry.id}: text evidence cannot carry screenshotRef`)
  }
  if (observation.screenshotRef && !run.screenshotRefs.includes(observation.screenshotRef)) {
    throw new Error(`interpretation ${entry.id}: unknown screenshotRef ${observation.screenshotRef}`)
  }
  const frames = parseObservationFrames(
    observation.frames,
    `interpretation ${entry.id}`,
    entry.featureId!,
    run.screenshotRefs,
    run.textSnapshotRefs,
    observation.screenshotRef,
    pixelRead(input) ? "screenshot" : textRead(input) ? "buffer_state" : observation.assertionType,
  )
  // A decided interpretation is recomputable from the run alone, pixels or cells: both kinds cite
  // frames, and both must cite THIS run's bytes and the frames that run already recorded.
  const decided = observation.outcome === "supported" || observation.outcome === "unsupported"
  if ((pixelRead(input) || textRead(input)) && decided) {
    const kind = pixelRead(input) ? "pixels" : "text"
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
      if (run.subject.os?.toLowerCase().startsWith("linux") && !run.provenance) {
        throw new Error(`pixels interpretation ${entry.id} requires Linux fixture provenance for geometry and font`)
      }
    }
  }
  return observation
}

/** Each v4 assertion must describe its own retained observable, independent of the primary result. */
export function validateCurrentAssertions(
  assertions: readonly ProbeAssertion[],
  rawReplies: Record<string, string>,
  results: readonly ProbeResult[],
  subjectKind: "term" | "lib" | "mux",
  path: string,
): void {
  for (const assertion of assertions) {
    const { featureId, rawReplyRef, assertionType } = assertion
    if (!nonempty(assertion.expected) || !nonempty(assertion.observed))
      fail(path, `${featureId} assertion requires expected and observed evidence`)
    if (!rawReplyRef || !nonempty(rawReplies[rawReplyRef]))
      fail(path, `${featureId} assertion requires its retained raw payload`)
    const raw = rawReplies[rawReplyRef]!
    const frames = results.filter((result) => result.featureId === featureId).flatMap((result) => result.frames ?? [])
    if (assertionType === "query_reply") {
      // Raw replies are arbitrary bytes; only a real trace envelope has a query list.
      let trace: unknown
      if (raw.startsWith("{")) {
        try {
          trace = JSON.parse(raw)
        } catch {
          /* A query may itself return non-JSON text beginning with {. */
        }
      }
      if (
        object(trace) &&
        Array.isArray(trace.queries) &&
        !trace.queries.some((query) => object(query) && nonempty(query.raw))
      ) {
        fail(path, `${featureId} query_reply assertion requires returned query bytes`)
      }
    } else if (
      assertionType === "screenshot" ||
      (assertionType === "buffer_state" && frames.some((frame) => frame.kind === "text-cells"))
    ) {
      const matchingFrames = frames.filter((frame) =>
        assertionType === "screenshot" ? frame.kind !== "text-cells" : frame.kind === "text-cells",
      )
      requireCitedFrameDigests(
        {
          featureId,
          outcome: assertion.kind === "positive" ? "supported" : "unsupported",
          assertionType,
          frames: matchingFrames,
        },
        assertion,
        path,
      )
    } else if (assertionType === "buffer_state" || assertionType === "input_bytes") {
      const state = parseJsonStrict(`${path}: ${featureId} state snapshot`, assertion.observed)
      if (!object(state) || Object.keys(state).length === 0)
        fail(path, `${featureId} requires an actual state snapshot`)
      if (assertionType === "input_bytes" && !nonempty(assertion.action))
        fail(path, `${featureId} requires the performed action`)
      if (assertionType === "buffer_state" && subjectKind === "lib" && assertion.observed !== raw) {
        fail(path, `${featureId} lib buffer_state assertion differs from its retained response`)
      }
    }
  }
}
