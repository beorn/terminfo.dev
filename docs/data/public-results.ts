/** The sole site/API mapping. Presentation decisions are not repository privacy controls. */
import { createHash } from "node:crypto"
import type {
  ConsoleBufferOwner,
  Observation,
  ObservationFrame,
  ProbeAssertion,
  ProbeTarget,
  RunOrigin,
  TextQualification,
  TextCellsObservationFrame,
} from "@terminfo/probe-defs"
import type { CurrentResult } from "./current-results.ts"
import {
  HISTORICAL_RERUN_NOTE,
  statesFor,
  type SelectedCell,
  type SelectedProjection,
  type SelectedVersion,
} from "./selected-results.ts"
import type { CellState } from "./release-scope.ts"

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

export interface EvidenceDocument {
  version: 1
  runId: string
  runSha256: string
  featureId: string
  observation: Pick<Observation, "featureId" | "outcome" | "reason" | "evidence" | "note">
  record: PublicImages & { rawReply?: string; assertions: ProbeAssertion[] }
  review: PublicReview
  textQualification?: { url: string; sha256: string }
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
    }>
  }
}

export interface PublicCell extends Pick<SelectedCell, "featureId" | "outcome" | "reason" | "evidence" | "conclusive"> {
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

export interface PublicVersion extends Omit<SelectedVersion, "cells" | "ungradedDiagnostics" | "textQualification"> {
  cells: Record<string, PublicCell>
}

export interface PublicProjection {
  current: Record<string, PublicVersion>
  versions: Record<string, PublicVersion[]>
  history: Record<string, PublicVersion[]>
  exclusions: Array<{ runId: string; reason: string }>
}

export interface PublicCurrentResult extends Omit<CurrentResult, "selected"> {
  selected: PublicVersion
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
export function publicResults(projection: SelectedProjection, targets: ReadonlyMap<string, CurrentResult>) {
  const documents = new Map<string, { bytes: string; document: EvidenceDocument | TextQualificationDocument }>()
  const qualificationFor = (version: SelectedVersion): { url: string; sha256: string } | undefined => {
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
    const url = `/api/v2/evidence/${version.sha256}/text-qualification.json`
    const bytes = JSON.stringify(document, null, 2) + "\n"
    const prior = documents.get(url)
    if (prior && prior.bytes !== bytes) throw new Error(`Conflicting qualification document ${url}`)
    documents.set(url, { bytes, document })
    return { url, sha256: createHash("sha256").update(bytes).digest("hex") }
  }
  const mapCell = (cell: SelectedCell, version: SelectedVersion): PublicCell => {
    const approved = cell.presentation?.decision.presentsEvidence === true
    const reviewedCorrection = cell.chain.correctionId !== undefined
    const origin = cell.chain.origin
    const result: PublicCell = {
      featureId: cell.featureId,
      outcome: cell.outcome,
      evidence: cell.evidence,
      conclusive: cell.conclusive,
      ...(cell.reason && { reason: cell.reason }),
      ...(cell.host !== undefined && { host: cell.host }),
      ...(cell.textQualificationReason !== undefined && { textQualificationReason: cell.textQualificationReason }),
      ...((reviewedCorrection || approved || cell.note === HISTORICAL_RERUN_NOTE) &&
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
    const textQualification = cell.evidence === "text" ? qualificationFor(version) : undefined
    const document: EvidenceDocument = {
      version: 1,
      runId: version.runId,
      runSha256: version.sha256,
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
    const url = `/api/v2/evidence/${version.sha256}/${encodeURIComponent(cell.featureId)}.json`
    const bytes = JSON.stringify(document, null, 2) + "\n"
    const prior = documents.get(url)
    if (prior && prior.bytes !== bytes) throw new Error(`Conflicting evidence document ${url}`)
    documents.set(url, { bytes, document })
    result.presentation = { state: "presented", review, url, sha256: createHash("sha256").update(bytes).digest("hex") }
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
  const mapVersion = (version: SelectedVersion): PublicVersion => ({
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
    cells: Object.fromEntries(Object.entries(version.cells).map(([id, cell]) => [id, mapCell(cell, version)])),
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
  })
  const mapGroups = (groups: Record<string, SelectedVersion[]>) =>
    Object.fromEntries(Object.entries(groups).map(([key, versions]) => [key, versions.map(mapVersion)]))
  const selected: PublicProjection = {
    current: Object.fromEntries(Object.entries(projection.current).map(([key, version]) => [key, mapVersion(version)])),
    versions: mapGroups(projection.versions),
    history: mapGroups(projection.history),
    exclusions: projection.exclusions.map(({ runId, reason }) => ({ runId, reason })),
  }
  const selectedByBackend: Record<string, PublicCurrentResult> = Object.fromEntries(
    [...targets].map(([key, value]) => [
      key,
      {
        contextKey: value.contextKey,
        selected: mapVersion(value.selected),
        // The selected run's states come from the projection's ONE table, never a second classification.
        states: statesFor(projection, value.selected.runId),
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
