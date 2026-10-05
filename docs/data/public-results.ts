/** The sole site/API mapping. Presentation decisions are not repository privacy controls. */
import { createHash } from "node:crypto"
import type { Observation, ProbeAssertion, ProbeTarget, RunOrigin } from "@terminfo/probe-defs"
import type { CurrentResult } from "./current-results.ts"
import type { SelectedCell, SelectedProjection, SelectedVersion } from "./selected-results.ts"

type PublicReview = SelectedVersion["reviews"][number]
type PublicFrame = Omit<NonNullable<SelectedCell["record"]["frames"]>[number], "sourceRef">
type PublicImages = { screenshot?: SelectedCell["record"]["screenshot"]; frames?: PublicFrame[] }

export interface EvidenceDocument {
  version: 1
  runId: string
  runSha256: string
  featureId: string
  observation: Pick<Observation, "featureId" | "outcome" | "reason" | "evidence" | "note">
  record: PublicImages & { rawReply?: string; assertions: ProbeAssertion[] }
  review: PublicReview
}

export interface PublicCell extends Pick<SelectedCell, "featureId" | "outcome" | "reason" | "evidence" | "conclusive"> {
  note?: string
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

export interface PublicVersion extends Omit<SelectedVersion, "cells" | "ungradedDiagnostics"> {
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
}

/** Only web references are links in public summaries; internal paths remain in the source record. */
function publicSources(sources: readonly string[]): string[] {
  return sources.filter((source) => /^https?:\/\//.test(source))
}

function publicReview(review: PublicReview): PublicReview {
  return { id: review.id, reviewer: review.reviewer, reason: review.reason, sources: publicSources(review.sources) }
}

function images(record: SelectedCell["record"]): PublicImages {
  return {
    ...(record.screenshot && { screenshot: { url: record.screenshot.url, sha256: record.screenshot.sha256 } }),
    ...(record.frames && {
      frames: record.frames.map(({ role, label, capturedAt, url, sha256 }) => ({
        role,
        label,
        capturedAt,
        url,
        sha256,
      })),
    }),
  }
}

/** One mapping also supplies the exact lazy documents that generate-api writes. */
export function publicResults(projection: SelectedProjection, targets: ReadonlyMap<string, CurrentResult>) {
  const documents = new Map<string, { bytes: string; document: EvidenceDocument }>()
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
      ...((reviewedCorrection || approved) && cell.note !== undefined && { note: cell.note }),
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
        ...images(record),
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
    }
    const url = `/api/v2/evidence/${version.sha256}/${encodeURIComponent(cell.featureId)}.json`
    const bytes = JSON.stringify(document, null, 2) + "\n"
    const prior = documents.get(url)
    if (prior && prior.bytes !== bytes) throw new Error(`Conflicting evidence document ${url}`)
    documents.set(url, { bytes, document })
    result.presentation = { state: "presented", review, url, sha256: createHash("sha256").update(bytes).digest("hex") }
    result.record = images(record)
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
    suite: {
      observed: version.suite.observed,
      expected: version.suite.expected,
      complete: version.suite.complete,
      namedNotTested: version.suite.namedNotTested,
    },
    sourceRevision: version.sourceRevision,
    sha256: version.sha256,
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
