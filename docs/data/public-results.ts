/** The sole site/API mapping. Presentation decisions are not repository privacy controls. */
import { createHash } from "node:crypto"
import type {
  CapabilityResult,
  CapabilityStatus,
  ConsoleBufferOwner,
  Observation,
  ObservationFrame,
  ProbeAssertion,
  ProbeTarget,
  RunOrigin,
  TextQualification,
  TextQualificationOwnership,
  TextCellsObservationFrame,
} from "../../packages/probe-defs/src/types.ts"
import type { CurrentResult, HistoricalCurrentResult } from "./current-results.ts"
import {
  HISTORICAL_RERUN_NOTE,
  statesFor,
  historicalStatesFor,
  type SelectedCell,
  type SelectedProjection,
  type HistoricalProjection,
  type CurrentSelectedVersion,
  type SelectedVersion,
} from "./selected-results.ts"
import type { CellState } from "./release-scope.ts"
import { currentTrace, historicalTrace, type CurrentTraceDocument, type HistoricalTraceDocument } from "./run-trace.ts"

type PublicReview = SelectedVersion["reviews"][number]
/** Missing kind retains the historical PNG shape byte for byte. */
export type PublicFrame = {
  kind?: "text-cells"
  role: ObservationFrame["role"]
  label: string
  capturedAt: number
  url: string
  sha256: string
}
type PublicImages = { screenshot?: SelectedCell["record"]["screenshot"]; frames?: PublicFrame[] }

import {
  describeTracePanes,
  readCellEvidence,
  readCellTrace,
  type CellEvidenceExpectation,
  type CellTraceExpectation,
  type LoadedCellEvidence,
  type LoadedCellTrace,
  type TracePaneCopy,
} from "./evidence-reader.ts"

export {
  describeTracePanes,
  readCellEvidence,
  readCellTrace,
  type CellEvidenceExpectation,
  type CellTraceExpectation,
  type LoadedCellEvidence,
  type LoadedCellTrace,
  type TracePaneCopy,
}

export interface HistoricalCellEvidence {
  featureId: string
  observation: Pick<Observation, "featureId" | "outcome" | "reason" | "evidence" | "note">
  record: PublicImages & { rawReply?: string; assertions: ProbeAssertion[] }
  review: PublicReview
  textQualification?: { url: string; sha256: string }
}

export interface HistoricalEvidenceDocument {
  version: 2
  runId: string
  runSha256: string
  cells: Record<string, HistoricalCellEvidence>
}

export interface TextQualificationDocument {
  version: 1
  runId: string
  runSha256: string
  qualification: Omit<TextQualification, "shapes"> & {
    shapes: Array<{
      shape: TextQualification["shapes"][number]["shape"]
      frames?: Array<PublicFrame & Pick<TextCellsObservationFrame, "cellDigest" | "frameDigest" | "cellRectangle">>
      reason?: string
      ownership?: TextQualificationOwnership
    }>
  }
}

export interface HistoricalPublicCell extends Pick<
  SelectedCell,
  "featureId" | "outcome" | "reason" | "evidence" | "conclusive"
> {
  note?: string
  /** The console host the read returned; absent on a pixels row and on a text row that had none. */
  host?: ConsoleBufferOwner
  textQualificationReason?: string
  textQualification?: { url: string; sha256: string }
  chain: {
    origin: Pick<RunOrigin, "kind" | "url">
    method: Observation["evidence"]
    runId: string
    runSha256: string
    correctionId?: string
    sources?: string[]
  }
  record?: PublicImages
  presentation:
    | { state: "not-reviewed" }
    | { state: "withdrawn"; review: PublicReview }
    | { state: "presented"; review: PublicReview; url: string; sha256: string }
}

export interface HistoricalPublicVersion extends Omit<
  SelectedVersion,
  "cells" | "ungradedDiagnostics" | "textQualification" | "identity"
> {
  cells: Record<string, HistoricalPublicCell>
  /** The receipt of this run's trace document; only a run a page displays has one. */
  trace?: TraceReceipt
}

/** Where a displayed run's trace document lives, and the SHA-256 of its exact bytes. */
export interface TraceReceipt {
  url: string
  sha256: string
}

export interface HistoricalPublicProjection {
  current: Record<string, HistoricalPublicVersion>
  versions: Record<string, HistoricalPublicVersion[]>
  history: Record<string, HistoricalPublicVersion[]>
  exclusions: Array<{ runId: string; reason: string }>
}

export interface HistoricalPublicCurrentResult extends Omit<HistoricalCurrentResult, "selected"> {
  selected: HistoricalPublicVersion
  /**
   * The reader's classified states for this backend's selected run, keyed by feature id. A page that
   * names a backend (its bar, its tooltip) reads the state here, so it never classifies the run's raw
   * cells a second time (28792 item 1).
   */
  states: Readonly<Record<string, CellState>>
}

/** Only web references are links in public summaries; internal paths remain in the source record. */
function publicSources(sources: readonly string[]): string[] {
  return sources.filter((source) => /^https?:\/\//.test(source))
}

function publicReview(review: PublicReview): PublicReview {
  return { id: review.id, reviewer: review.reviewer, reason: review.reason, sources: publicSources(review.sources) }
}

/**
 * The one public frame mapping: text URLs retain their kind; historical PNG records retain their shape.
 */
function images(record: SelectedCell["record"], where: string): PublicImages {
  return {
    ...(record.screenshot && { screenshot: { url: record.screenshot.url, sha256: record.screenshot.sha256 } }),
    ...(record.frames && {
      frames: record.frames.map((frame) => {
        if (frame.kind !== "text-cells" && frame.url === undefined) throw new Error(`${where}: pixel frame has no URL`)
        return {
          role: frame.role,
          label: frame.label,
          capturedAt: frame.capturedAt,
          url: frame.kind === "text-cells" ? `/artifacts/${frame.sha256}.txt` : (frame.url as string),
          sha256: frame.sha256,
          ...(frame.kind === "text-cells" && { kind: "text-cells" as const }),
        }
      }),
    }),
  }
}

/** One mapping also supplies the exact lazy documents that generate-api writes. */
export function publicHistoricalResults(
  projection: HistoricalProjection,
  targets: ReadonlyMap<string, HistoricalCurrentResult>,
  /** Run IDs a page displays; each gets a trace. By default, every target's selected run. */
  traced: ReadonlySet<string> = new Set([...targets.values()].map((value) => value.selected.runId)),
) {
  const documents = new Map<
    string,
    { bytes: string; document: HistoricalEvidenceDocument | TextQualificationDocument | HistoricalTraceDocument }
  >()
  const traces = new Map<string, { trace?: TraceReceipt }>()
  /** Every mapping of one run carries the same receipt, so its run document has one form. */
  const traceOf = (version: SelectedVersion): { trace?: TraceReceipt } => {
    if (!traced.has(version.runId)) return {}
    const known = traces.get(version.sha256)
    if (known) return known
    const receipt = traceReceipt(documents, historicalTrace(version))
    traces.set(version.sha256, receipt)
    return receipt
  }
  const mapCell = (
    cell: SelectedCell,
    version: SelectedVersion,
    evidenceCells: Record<string, HistoricalCellEvidence>,
  ): HistoricalPublicCell => {
    const approved = cell.presentation?.decision.presentsEvidence === true
    const reviewedCorrection = cell.chain.correctionId !== undefined
    const origin = cell.chain.origin
    const result: HistoricalPublicCell = {
      featureId: cell.featureId,
      outcome: cell.outcome,
      evidence: cell.evidence,
      conclusive: cell.conclusive,
      ...(cell.reason && { reason: cell.reason }),
      ...(cell.host !== undefined && { host: cell.host }),
      ...(cell.textQualificationReason !== undefined && { textQualificationReason: cell.textQualificationReason }),
      ...((reviewedCorrection ||
        approved ||
        cell.note === HISTORICAL_RERUN_NOTE ||
        cell.consoleHostHold !== undefined) &&
        cell.note !== undefined && { note: cell.note }),
      chain: {
        origin: { kind: origin.kind, ...(origin.url && /^https?:\/\//.test(origin.url) && { url: origin.url }) },
        method: cell.chain.method,
        runId: cell.chain.runId,
        runSha256: cell.chain.runSha256,
        ...(cell.chain.correctionId && { correctionId: cell.chain.correctionId }),
        ...(reviewedCorrection && cell.chain.sources && { sources: publicSources(cell.chain.sources) }),
      },
      presentation: { state: "not-reviewed" },
    }
    if (!cell.presentation) return result
    const { decision, original } = cell.presentation
    const review = publicReview(decision)
    if (!decision.presentsEvidence) {
      result.presentation = { state: "withdrawn", review }
      return result
    }
    const { observation, record } = original
    const textQualification = cell.evidence === "text" ? qualificationFor(version, documents, 2) : undefined
    evidenceCells[cell.featureId] = {
      featureId: cell.featureId,
      observation: {
        featureId: observation.featureId,
        outcome: observation.outcome,
        evidence: observation.evidence,
        ...(observation.reason && { reason: observation.reason }),
        ...(observation.note !== undefined && { note: observation.note }),
      },
      record: {
        ...images(record, `run ${version.runId} feature ${cell.featureId}`),
        ...(record.rawReply !== undefined && { rawReply: record.rawReply }),
        assertions: record.assertions.map(({ featureId, kind, rawReplyRef, expected, observed, action, note }) => ({
          featureId,
          kind,
          expected,
          observed,
          ...(rawReplyRef && { rawReplyRef }),
          ...(action && { action }),
          ...(note && { note }),
        })),
      },
      review,
      ...(textQualification && { textQualification }),
    }
    const url = `/api/v2/evidence/${version.sha256}.json#${encodeURIComponent(cell.featureId)}`
    result.presentation = { state: "presented", review, url, sha256: "" }
    result.record = images(record, `run ${version.runId} feature ${cell.featureId}`)
    if (textQualification) result.textQualification = textQualification
    return result
  }
  const target = (value: ProbeTarget): ProbeTarget => ({
    kind: value.kind,
    id: value.id,
    version: value.version,
    os: value.os,
    osVersion: value.osVersion,
    outerTerminal: value.outerTerminal,
    mux: value.mux,
    config: value.config,
    permissions: value.permissions,
  })
  const mapVersion = (version: SelectedVersion): HistoricalPublicVersion => {
    const evidenceCells: Record<string, HistoricalCellEvidence> = {}
    const cells = Object.fromEntries(
      Object.entries(version.cells).map(([id, cell]) => [id, mapCell(cell, version, evidenceCells)]),
    )
    if (Object.keys(evidenceCells).length > 0) {
      const document: HistoricalEvidenceDocument = {
        version: 2,
        runId: version.runId,
        runSha256: version.sha256,
        cells: evidenceCells,
      }
      const docUrl = `/api/v2/evidence/${version.sha256}.json`
      const bytes = JSON.stringify(document, null, 2) + "\n"
      const prior = documents.get(docUrl)
      if (prior && prior.bytes !== bytes) throw new Error(`Conflicting evidence document ${docUrl}`)
      documents.set(docUrl, { bytes, document })
      const sha256 = createHash("sha256").update(bytes).digest("hex")
      for (const cell of Object.values(cells)) {
        if (cell.presentation.state === "presented") {
          readCellEvidence(document, {
            schemaVersion: version.schemaVersion,
            runId: version.runId,
            runSha256: version.sha256,
            featureId: cell.featureId,
            reviewId: cell.presentation.review.id,
          })
          cell.presentation.sha256 = sha256
        }
      }
    }
    return {
      schemaVersion: version.schemaVersion,
      runId: version.runId,
      target: target(version.target),
      measuredAt: version.measuredAt,
      suiteId: version.suiteId,
      probeHash: version.probeHash,
      suiteFreshness: version.suiteFreshness,
      suiteRelation: version.suiteRelation,
      suite: {
        observed: version.suite.observed,
        expected: version.suite.expected,
        complete: version.suite.complete,
        namedNotTested: version.suite.namedNotTested,
      },
      sourceRevision: version.sourceRevision,
      sha256: version.sha256,
      ...(version.identityAdmission && { identityAdmission: version.identityAdmission }),
      ...traceOf(version),
      cells,
      v1: { ...version.v1 },
      reviews: version.reviews.map(publicReview),
      counts: {
        catalog: version.counts.catalog,
        tested: version.counts.tested,
        notTested: version.counts.notTested,
        conclusive: version.counts.conclusive,
        supported: version.counts.supported,
        unsupported: version.counts.unsupported,
      },
      notTestedCoverage: version.notTestedCoverage,
    }
  }
  const mapGroups = (groups: Record<string, SelectedVersion[]>) =>
    Object.fromEntries(Object.entries(groups).map(([key, versions]) => [key, versions.map(mapVersion)]))
  const selected: HistoricalPublicProjection = {
    current: Object.fromEntries(Object.entries(projection.current).map(([key, version]) => [key, mapVersion(version)])),
    versions: mapGroups(projection.versions),
    history: mapGroups(projection.history),
    exclusions: projection.exclusions.map(({ runId, reason }) => ({ runId, reason })),
  }
  const selectedByBackend: Record<string, HistoricalPublicCurrentResult> = Object.fromEntries(
    [...targets].map(([key, value]) => [
      key,
      {
        contextKey: value.contextKey,
        selected: mapVersion(value.selected),
        // The selected run's states come from the projection's ONE table, never a second classification.
        states: historicalStatesFor(projection, value.selected.runId),
        ...(value.policy && {
          policy: {
            contextKey: value.policy.contextKey,
            reviewer: value.policy.reviewer,
            reason: value.policy.reason,
            sources: publicSources(value.policy.sources),
          },
        }),
      },
    ]),
  )
  return { projection: selected, selectedByBackend, documents }
}

function qualificationFor(
  version: Pick<SelectedVersion, "runId" | "sha256" | "textQualification">,
  documents: PublicDocuments,
  apiVersion: 2 | 3,
): { url: string; sha256: string } | undefined {
  if (!version.textQualification) return undefined
  const qualification = version.textQualification
  const document: TextQualificationDocument = {
    version: 1,
    runId: version.runId,
    runSha256: version.sha256,
    qualification: {
      ...qualification,
      shapes: qualification.shapes.map((shape) => {
        if (shape.reason !== undefined) return { shape: shape.shape, reason: shape.reason }
        if (shape.ownership !== undefined) {
          return { shape: shape.shape, ownership: { ...shape.ownership, cell: { ...shape.ownership.cell } } }
        }
        const frames = images(
          {
            assertions: [],
            frames: shape.frames.map((frame) => ({
              role: frame.role,
              label: frame.label,
              capturedAt: frame.capturedAt,
              kind: "text-cells",
              sha256: frame.ref.slice(7),
            })),
          },
          `run ${version.runId} qualification ${shape.shape}`,
        ).frames
        if (!frames) throw new Error(`Missing mapped qualification frames for ${version.runId}/${shape.shape}`)
        return {
          shape: shape.shape,
          frames: frames.map((frame, index) => {
            const raw = shape.frames[index]
            if (!raw) throw new Error(`Missing original qualification frame for ${version.runId}/${shape.shape}`)
            return {
              ...frame,
              cellDigest: raw.cellDigest,
              frameDigest: raw.frameDigest,
              cellRectangle: { ...raw.cellRectangle },
            }
          }),
        }
      }),
    },
  }
  const url = `/api/v${apiVersion}/evidence/${version.sha256}/text-qualification.json`
  const bytes = JSON.stringify(document, null, 2) + "\n"
  const prior = documents.get(url)
  if (prior && prior.bytes !== bytes) throw new Error(`Conflicting qualification document ${url}`)
  documents.set(url, { bytes, document })
  return { url, sha256: createHash("sha256").update(bytes).digest("hex") }
}

/** Keeps a run's trace document for generate-api and returns the receipt its run version carries. */
function traceReceipt(
  documents: PublicDocuments,
  trace: ReturnType<typeof historicalTrace> | ReturnType<typeof currentTrace>,
): { trace?: TraceReceipt } {
  if (!trace) return {}
  const prior = documents.get(trace.url)
  if (prior && prior.bytes !== trace.bytes) throw new Error(`Conflicting trace document ${trace.url}`)
  const actualSha256 = createHash("sha256").update(trace.bytes).digest("hex")
  const schemaVersion = trace.url.startsWith("/api/v3/") ? 3 : 2
  for (const featureId of Object.keys(trace.document.cells)) {
    const loaded = readCellTrace(trace.document, {
      schemaVersion,
      runId: trace.document.runId,
      runSha256: trace.document.runSha256,
      featureId,
      expectedSha256: trace.sha256,
      actualSha256,
    })
    describeTracePanes(loaded)
  }
  documents.set(trace.url, { bytes: trace.bytes, document: trace.document })
  return { trace: { url: trace.url, sha256: trace.sha256 } }
}

/**
 * The screen size a run measured for its own terminal, from its `collector.geometry` receipt: the corroborated
 * size when the terminal's own reply agreed with the granted read, else the granted `stty size` measurement.
 * The popover prints expected positions as numbers, so this — not the words "the last column" — is the only
 * width a page may cite (#30756).
 */
function screenGeometry(receipt: string | undefined): { rows: number; cols: number } | undefined {
  if (receipt === undefined) return undefined
  const parsed = JSON.parse(receipt) as {
    grant?: { status?: string; rows?: unknown; cols?: unknown } | null
    corroboration?: { status?: string; rows?: unknown; cols?: unknown } | null
  }
  const corroborated = parsed.corroboration?.status === "agree" ? parsed.corroboration : undefined
  const granted = parsed.grant?.status === "measured" ? parsed.grant : undefined
  for (const candidate of [corroborated, granted]) {
    if (candidate === undefined) continue
    if (!Number.isSafeInteger(candidate.rows) || !Number.isSafeInteger(candidate.cols)) {
      throw new Error(`collector.geometry recorded a size without whole rows and columns: ${receipt}`)
    }
    return { rows: candidate.rows as number, cols: candidate.cols as number }
  }
  return undefined
}

/** Current public results retain sealed statuses; evidence remains separately publication-reviewed. */
export interface PublicCapabilityResult extends Pick<
  CapabilityResult,
  "featureId" | "status" | "attempt" | "checks" | "evidence"
> {
  reason?: string
  /**
   * The Windows console-host hold this reader applied (#30720): it names the host that answered the
   * queries, which is why the cell reads TEST TODO. Published even when the cell's own evidence prose is
   * not approved for publication, because it explains the displayed verdict rather than adding evidence.
   */
  hold?: string
  record?: PublicImages
  presentation: HistoricalPublicCell["presentation"]
}

export interface PublicVersion extends Omit<
  CurrentSelectedVersion,
  "results" | "rawReplies" | "assertions" | "origin" | "presentations" | "textQualification" | "identity"
> {
  results: PublicCapabilityResult[]
  /** The receipt of this run's trace document; only a run a page displays has one. */
  trace?: TraceReceipt
  /** The screen size this run measured for its own terminal; absent when its receipt recorded none. */
  screen?: { rows: number; cols: number }
}

export interface PublicProjection {
  current: Record<string, PublicVersion>
  versions: Record<string, PublicVersion[]>
  history: Record<string, PublicVersion[]>
  historical: HistoricalPublicProjection
  currentRunCount: number
  exclusions: HistoricalPublicProjection["exclusions"]
}

export interface PublicCurrentResult extends Omit<CurrentResult, "selected"> {
  selected: PublicVersion
  states: Readonly<Record<string, CapabilityStatus>>
}

export interface CellEvidence {
  featureId: string
  result: CapabilityResult
  record: PublicImages & { rawReply?: string; assertions: ProbeAssertion[] }
  review: PublicReview
  textQualification?: { url: string; sha256: string }
}

export interface EvidenceDocument {
  version: 4
  runId: string
  runSha256: string
  cells: Record<string, CellEvidence>
}

type PublicDocuments = Map<
  string,
  {
    bytes: string
    document:
      | EvidenceDocument
      | HistoricalEvidenceDocument
      | TextQualificationDocument
      | HistoricalTraceDocument
      | CurrentTraceDocument
  }
>

function publicAttempt(attempt: CapabilityResult["attempt"]): CapabilityResult["attempt"] {
  return attempt.scope === "none" ? { scope: "none" } : { scope: attempt.scope, startedAt: attempt.startedAt }
}

/** The API and the site consume the same current/history split and the same evidence documents. */
export function publicResults(
  projection: SelectedProjection,
  targets: ReadonlyMap<string, CurrentResult>,
  historicalTargets: ReadonlyMap<string, HistoricalCurrentResult> = new Map(),
) {
  // A page displays a historical run only for a context with no current selection.
  const historical = publicHistoricalResults(
    projection.historical,
    historicalTargets,
    new Set([...historicalTargets].filter(([key]) => !targets.has(key)).map(([, value]) => value.selected.runId)),
  )
  const traced = new Set([...targets.values()].map((value) => value.selected.runId))
  const documents: PublicDocuments = new Map(historical.documents)
  const mapResult = (
    result: CapabilityResult,
    version: CurrentSelectedVersion,
    evidenceCells: Record<string, CellEvidence>,
  ): PublicCapabilityResult => {
    const decision = version.presentations[result.featureId]
    const approved = decision?.presentsEvidence === true
    const hold = result.checks.find((check) => check.id === "console-host")?.reason
    const mapped: PublicCapabilityResult = {
      featureId: result.featureId,
      status: result.status,
      attempt: publicAttempt(result.attempt),
      checks: result.checks.map((check) => ({
        id: check.id,
        status: check.status,
        attempt: publicAttempt(check.attempt),
        ...(approved && check.reason !== undefined && { reason: check.reason }),
        ...(check.assertionRefs && { assertionRefs: [...check.assertionRefs] }),
      })),
      ...(result.evidence && { evidence: result.evidence }),
      ...(approved && result.reason !== undefined && { reason: result.reason }),
      ...(hold !== undefined && { hold }),
      presentation: { state: "not-reviewed" },
    }
    if (!decision) return mapped
    const review = publicReview(decision)
    if (!approved) {
      mapped.presentation = { state: "withdrawn", review }
      return mapped
    }
    const rawReply = result.rawReplyRef === undefined ? undefined : version.rawReplies[result.rawReplyRef]
    if (result.rawReplyRef !== undefined && rawReply === undefined) {
      throw new Error(`Run ${version.runId}/${result.featureId}: missing retained raw reply ${result.rawReplyRef}`)
    }
    const record: SelectedCell["record"] = {
      assertions: version.assertions.filter((assertion) => assertion.featureId === result.featureId),
      ...(rawReply !== undefined && { rawReply }),
      ...(result.frames && {
        frames: result.frames.map((frame) => ({
          role: frame.role,
          label: frame.label,
          capturedAt: frame.capturedAt,
          kind: frame.kind === "text-cells" ? ("text-cells" as const) : ("pixels" as const),
          sha256: frame.ref.slice(7),
          ...(frame.kind !== "text-cells" && { url: `/artifacts/${frame.ref.slice(7)}.png` }),
        })),
      }),
      ...(result.screenshotRef && {
        screenshot: {
          url: `/artifacts/${result.screenshotRef.slice("sha256:".length)}.png`,
          sha256: result.screenshotRef.slice("sha256:".length),
        },
      }),
    }
    const textQualification = result.evidence === "text" ? qualificationFor(version, documents, 3) : undefined
    evidenceCells[result.featureId] = {
      featureId: result.featureId,
      result: globalThis.structuredClone(result),
      record: {
        ...images(record, `run ${version.runId}/${result.featureId}`),
        assertions: record.assertions,
        ...(rawReply !== undefined && { rawReply }),
      },
      review,
      ...(textQualification && { textQualification }),
    }
    const url = `/api/v3/evidence/${version.sha256}.json#${encodeURIComponent(result.featureId)}`
    mapped.presentation = { state: "presented", review, url, sha256: "" }
    mapped.record = images(record, `run ${version.runId}/${result.featureId}`)
    return mapped
  }
  const mappedRuns = new Map<string, PublicVersion>()
  const mapVersion = (version: CurrentSelectedVersion): PublicVersion => {
    const prior = mappedRuns.get(version.runId)
    if (prior) {
      if (prior.sha256 !== version.sha256) throw new Error(`Conflicting sealed current run ${version.runId}`)
      return prior
    }
    const {
      rawReplies: _raw,
      assertions: _assertions,
      origin: _origin,
      presentations: _presentations,
      textQualification: _qualification,
      identity: _identity,
      results,
      ...metadata
    } = version
    const screen = screenGeometry(version.rawReplies["collector.geometry"])
    const evidenceCells: Record<string, CellEvidence> = {}
    const mappedResults = results.map((result) => mapResult(result, version, evidenceCells))
    if (Object.keys(evidenceCells).length > 0) {
      const document: EvidenceDocument = {
        version: 4,
        runId: version.runId,
        runSha256: version.sha256,
        cells: evidenceCells,
      }
      const docUrl = `/api/v3/evidence/${version.sha256}.json`
      const bytes = JSON.stringify(document, null, 2) + "\n"
      const existing = documents.get(docUrl)
      if (existing && existing.bytes !== bytes) throw new Error(`Conflicting evidence document ${docUrl}`)
      documents.set(docUrl, { bytes, document })
      const sha256 = createHash("sha256").update(bytes).digest("hex")
      for (const result of mappedResults) {
        if (result.presentation.state === "presented") {
          readCellEvidence(document, {
            schemaVersion: version.schemaVersion,
            runId: version.runId,
            runSha256: version.sha256,
            featureId: result.featureId,
            reviewId: result.presentation.review.id,
            status: result.status,
          })
          result.presentation.sha256 = sha256
        }
      }
    }
    const mapped: PublicVersion = {
      ...metadata,
      ...(traced.has(version.runId) && traceReceipt(documents, currentTrace(version))),
      ...(screen && { screen }),
      catalogIds: [...version.catalogIds],
      counts: { ...version.counts },
      score: { ...version.score },
      results: mappedResults,
    }
    mappedRuns.set(version.runId, mapped)
    return mapped
  }
  const mapGroups = (groups: Record<string, CurrentSelectedVersion[]>) =>
    Object.fromEntries(Object.entries(groups).map(([key, versions]) => [key, versions.map(mapVersion)]))
  const selected: PublicProjection = {
    current: Object.fromEntries(Object.entries(projection.current).map(([key, version]) => [key, mapVersion(version)])),
    versions: mapGroups(projection.versions),
    history: mapGroups(projection.history),
    historical: historical.projection,
    currentRunCount: Object.keys(projection.current).length,
    exclusions: projection.exclusions.map(({ runId, reason }) => ({ runId, reason })),
  }
  const selectedByBackend: Record<string, PublicCurrentResult> = Object.fromEntries(
    [...targets].map(([key, value]) => [
      key,
      {
        contextKey: value.contextKey,
        selected: mapVersion(value.selected),
        states: statesFor(projection, value.selected.runId),
        ...(value.policy && { policy: { ...value.policy, sources: publicSources(value.policy.sources) } }),
      },
    ]),
  )
  return { projection: selected, selectedByBackend, historicalByBackend: historical.selectedByBackend, documents }
}
