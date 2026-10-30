/** The sole site/API mapping. Presentation decisions are not repository privacy controls. */
import { createHash } from "node:crypto"
import { resultTextQualification } from "../../packages/run-parser/src/observations.ts"
import { isEnvironmentGroup, readCollectorSelection } from "@terminfo/probe-defs"
import type {
  ProbeResult,
  ProbeStatus,
  ConsoleBufferOwner,
  Observation,
  ObservationFrame,
  ProbeAssertion,
  RunOrigin,
  TextQualification,
  TextCellsObservationFrame,
} from "../../packages/probe-defs/src/types.ts"
import type { CurrentResult } from "./current-results.ts"
import {
  type SelectedCell,
  type SelectedContextSummary,
  type SelectedProjection,
  type CurrentSelectedVersion,
  type SelectedVersion,
  originalRunFor,
} from "./selected-results.ts"
import type { CellState } from "./release-scope.ts"
import { currentTrace, type CurrentTraceDocument } from "./run-trace.ts"

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
  observation: Pick<Observation, "featureId" | "outcome" | "reason" | "assertionType" | "note">
  record: PublicImages & { rawReply?: string; assertions: SelectedCell["record"]["assertions"] }
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
    }>
  }
}

/** How a published cell's review reads on the page. */
export type PublicPresentation =
  | { state: "not-reviewed" }
  | { state: "withdrawn"; review: PublicReview }
  | { state: "presented"; review: PublicReview; url: string; sha256: string }

/** Where a displayed run's trace document lives, and the SHA-256 of its exact bytes. */
export interface TraceReceipt {
  url: string
  sha256: string
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
  trace: ReturnType<typeof currentTrace>,
  schemaVersion: 3 | 4,
): { trace?: TraceReceipt } {
  if (!trace) return {}
  const prior = documents.get(trace.url)
  if (prior && prior.bytes !== trace.bytes) throw new Error(`Conflicting trace document ${trace.url}`)
  const actualSha256 = createHash("sha256").update(trace.bytes).digest("hex")
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
export interface PublicProbeResult extends Pick<
  ProbeResult,
  "featureId" | "status" | "attempt" | "tests" | "assertionType"
> {
  reason?: string
  /**
   * The Windows console-host hold this reader applied (#30720): it names the host that answered the
   * queries, which is why the cell reads TEST TODO. Published even when the cell's own evidence prose is
   * not approved for publication, because it explains the displayed verdict rather than adding evidence.
   */
  hold?: string
  record?: PublicImages
  presentation: PublicPresentation
}

export interface PublicVersion extends Omit<
  CurrentSelectedVersion,
  "results" | "rawReplies" | "assertions" | "origin" | "presentations" | "textQualification" | "identity"
> {
  results: PublicProbeResult[]
  /** The receipt of this run's trace document; only a run a page displays has one. */
  trace?: TraceReceipt
  /** The screen size this run measured for its own terminal; absent when its receipt recorded none. */
  screen?: { rows: number; cols: number }
}

export interface PublicProjection {
  contexts: Record<string, PublicContextSummary>
  versions: Record<string, PublicVersion[]>
  history: Record<string, PublicVersion[]>
  contextCount: number
  exclusions: Array<{ runId: string; reason: string }>
}

export interface PublicCurrentResult extends Omit<CurrentResult, "selected"> {
  selected: PublicContextSummary
  states: Readonly<Record<string, ProbeStatus>>
}

/** An original run's public receipt, separate from a context's composed cells. */
export type PublicRunMetadata = Omit<PublicVersion, "results">

export interface PublicContextSummary extends Omit<SelectedContextSummary, "cells" | "attempts"> {
  cells: Record<
    string,
    PublicProbeResult & {
      origin: { runId: string; resultId: string }
      measuredAt: string
      suiteId: string
      suiteRelation: CurrentSelectedVersion["suiteRelation"]
    }
  >
  sources: Record<string, PublicRunMetadata>
  /** Public attempt facts are flat; private paths and original outcomes remain in the canonical input. */
  attempts: Array<{ runId: string; startedAt?: string; noOutputIds: string[] }>
}

export interface CellEvidence {
  featureId: string
  result: ProbeResult
  record: PublicImages & { rawReply?: string; assertions: SelectedCell["record"]["assertions"] }
  review: PublicReview
  textQualification?: { url: string; sha256: string }
}

export interface EvidenceDocument {
  source?: { kind: "live" }
  version: 4
  runId: string
  runSha256: string
  cells: Record<string, CellEvidence>
}

type PublicDocuments = Map<
  string,
  {
    bytes: string
    document: EvidenceDocument | HistoricalEvidenceDocument | TextQualificationDocument | CurrentTraceDocument
  }
>

function publicAttempt(attempt: ProbeResult["attempt"]): ProbeResult["attempt"] {
  return attempt.scope === "none" ? { scope: "none" } : { scope: attempt.scope, startedAt: attempt.startedAt }
}

/** The API and site consume canonical contexts and original run-owned evidence documents. */
export function publicResults(projection: SelectedProjection, subjects: ReadonlyMap<string, CurrentResult>) {
  const traced = new Set(Object.values(projection.contexts).flatMap((context) => context.contributingRunIds))
  const documents: PublicDocuments = new Map()
  const mapResult = (
    result: ProbeResult,
    version: CurrentSelectedVersion,
    evidenceCells: Record<string, CellEvidence>,
  ): PublicProbeResult => {
    const decision = version.presentations[result.featureId]
    const approved = decision?.presentsEvidence === true
    const hold = result.tests.find((check) => check.id === "console-host")?.reason
    const selection =
      result.status === "test-todo" && result.attempt.scope === "none" && !isEnvironmentGroup(result.featureId)
        ? readCollectorSelection(version.rawReplies)
        : undefined
    // Scheduling facts explain an untouched row without presenting unreviewed callback evidence.
    const reason =
      selection && !selection.ids.includes(result.featureId)
        ? "Not selected for this collection; no test was attempted."
        : approved
          ? result.reason
          : undefined
    const mapped: PublicProbeResult = {
      featureId: result.featureId,
      status: result.status,
      attempt: publicAttempt(result.attempt),
      tests: result.tests.map((check) => ({
        id: check.id,
        status: check.status,
        attempt: publicAttempt(check.attempt),
        ...(approved && check.reason !== undefined && { reason: check.reason }),
        ...(check.assertionRefs && { assertionRefs: [...check.assertionRefs] }),
      })),
      ...(result.assertionType && { assertionType: result.assertionType }),
      ...(reason !== undefined && { reason }),
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
    const textQualification = qualificationFor(
      { ...version, textQualification: resultTextQualification(result, version.textQualification) },
      documents,
      3,
    )
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
        ...(version.schemaVersion === 4 && version.source && { source: { ...version.source } }),
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
      ...(traced.has(version.runId) && traceReceipt(documents, currentTrace(version), version.schemaVersion)),
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
  const contexts: Record<string, PublicContextSummary> = Object.fromEntries(
    Object.entries(projection.contexts).map(([key, context]) => {
      const sources: Record<string, PublicRunMetadata> = {}
      for (const runId of context.contributingRunIds) {
        const original = originalRunFor(projection, key, runId)
        const { results: _results, ...metadata } = mapVersion(original)
        sources[runId] = metadata
      }
      const cells = Object.fromEntries(
        Object.entries(context.cells).map(([id, cell]) => {
          const original = originalRunFor(projection, key, cell.origin.runId)
          const result = mapVersion(original).results.find((row) => row.featureId === cell.origin.resultId)
          if (!result) {
            throw new Error(`Original run ${original.runId} lacks result ${cell.origin.resultId} for ${key}/${id}`)
          }
          return [
            id,
            {
              ...result,
              origin: cell.origin,
              measuredAt: original.measuredAt,
              suiteId: original.suiteId,
              suiteRelation: original.suiteRelation,
            },
          ]
        }),
      )
      return [
        key,
        {
          ...context,
          contributingRunIds: context.contributingRunIds,
          cells,
          sources,
          attempts: context.attempts.map((attempt) => ({
            runId: attempt.runId,
            noOutputIds: attempt.noOutputIds,
            ...(attempt.attempt?.startedAt && { startedAt: attempt.attempt.startedAt }),
          })),
        },
      ]
    }),
  )
  const selected: PublicProjection = {
    contexts,
    versions: mapGroups(projection.versions),
    history: mapGroups(projection.history),
    contextCount: Object.keys(contexts).length,
    exclusions: projection.exclusions.map(({ runId, reason }) => ({ runId, reason })),
  }
  const selectedByBackend: Record<string, PublicCurrentResult> = Object.fromEntries(
    [...subjects].map(([key, value]) => {
      const context = contexts[value.contextKey]
      if (!context) throw new Error(`Selected context ${value.contextKey} for ${key} is absent from public contexts`)
      return [
        key,
        {
          contextKey: value.contextKey,
          selected: context,
          states: Object.fromEntries(context.catalogIds.map((id) => [id, context.cells[id]?.status ?? "test-todo"])),
          ...(value.policy && { policy: { ...value.policy, sources: publicSources(value.policy.sources) } }),
        },
      ]
    }),
  )
  return { projection: selected, selectedByBackend, documents }
}
