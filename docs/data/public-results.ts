/** The sole site/API mapping. Presentation decisions are not repository privacy controls. */
import { createHash } from "node:crypto"
import {
  isEnvironmentGroup,
  readCollectorSelection,
} from "@terminfo/probe-defs"
import type {
  ProbeResult,
  ProbeStatus,
  ConsoleBufferOwner,
  Observation,
  ObservationFrame,
  ProbeAssertion,
  RunOrigin,
  RunDraft,
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
  readCellTrace,
  type CellTraceExpectation,
  type LoadedCellTrace,
  type TracePaneCopy,
} from "./evidence-reader.ts"

export { describeTracePanes, readCellTrace, type CellTraceExpectation, type LoadedCellTrace, type TracePaneCopy }

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
export type PublicPresentation = { state: "not-reviewed" }

/** Where a displayed run's trace document lives, and the SHA-256 of its exact bytes. */
export interface TraceReceipt {
  url: string
  sha256: string
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

/** Current public results retain stored statuses; evidence remains separately publication-reviewed. */
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
  "results" | "rawReplies" | "assertions" | "origin" | "textQualification" | "identity"
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

type PublicDocuments = Map<
  string,
  {
    bytes: string
    document: HistoricalEvidenceDocument | TextQualificationDocument | CurrentTraceDocument
  }
>

function publicAttempt(attempt: ProbeResult["attempt"]): ProbeResult["attempt"] {
  return attempt.scope === "none" ? { scope: "none" } : { scope: attempt.scope, startedAt: attempt.startedAt }
}

/** The API and site consume canonical contexts and original run-owned evidence documents. */
export function publicResults(projection: SelectedProjection, subjects: ReadonlyMap<string, CurrentResult>) {
  const traced = new Set(Object.values(projection.contexts).flatMap((context) => context.contributingRunIds))
  const documents: PublicDocuments = new Map()
  const mapResult = (result: ProbeResult, version: CurrentSelectedVersion): PublicProbeResult => {
    const hold = result.tests.find((check) => check.id === "console-host")?.reason
    const selection =
      result.status === "test-todo" && result.attempt.scope === "none" && !isEnvironmentGroup(result.featureId)
        ? readCollectorSelection(version.rawReplies)
        : undefined
    // Scheduling facts explain an untouched row without presenting unreviewed callback evidence.
    const reason =
      selection && !selection.ids.includes(result.featureId)
        ? "Not selected for this collection; no test was attempted."
        : undefined
    const mapped: PublicProbeResult = {
      featureId: result.featureId,
      status: result.status,
      attempt: publicAttempt(result.attempt),
      tests: result.tests.map((check) => ({
        id: check.id,
        status: check.status,
        attempt: publicAttempt(check.attempt),
        ...(check.assertionRefs && { assertionRefs: [...check.assertionRefs] }),
      })),
      ...(result.assertionType && { assertionType: result.assertionType }),
      ...(reason !== undefined && { reason }),
      ...(hold !== undefined && { hold }),
      presentation: { state: "not-reviewed" },
    }
    return mapped
  }
  const mappedRuns = new Map<string, PublicVersion>()
  const mapVersion = (version: CurrentSelectedVersion): PublicVersion => {
    const prior = mappedRuns.get(version.runId)
    if (prior) {
      if (prior.sha256 !== version.sha256) throw new Error(`Conflicting stored current run ${version.runId}`)
      return prior
    }
    const {
      rawReplies: _raw,
      assertions: _assertions,
      origin: _origin,
      textQualification: _qualification,
      identity: _identity,
      results,
      ...metadata
    } = version
    const screen = screenGeometry(version.rawReplies["collector.geometry"])
    const mappedResults = results.map((result) => mapResult(result, version))
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
        },
      ]
    }),
  )
  return { projection: selected, selectedByBackend, documents }
}
