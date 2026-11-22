/** The sole site/API mapping. Presentation decisions are not repository privacy controls. */
import { createHash } from "node:crypto"
import { isEnvironmentGroup } from "@terminfo/probe-defs"
import type {
  ProbeResult,
  FeatureResultStatus,
  Observation,
  ObservationFrame,
  TextQualification,
  TextCellsObservationFrame,
} from "../../packages/probe-defs/src/types.ts"
import { classifyProjectionSetups, type CurrentResult } from "./current-results.ts"
import { gitSourceHistory, type SourceHistory } from "./source-history.ts"
import type { SetupStanding } from "./run-selection.ts"
import { isPublishedStatus, standInGrade, type AppCellStatus, type JoinedApp } from "./app-cells.ts"
import type { FeatureResult, RollupCounts } from "./release-scope.ts"
import { publicReopenedReason } from "./reopened-cells.ts"
import { publicDeclaredReason } from "./declared-untestable.ts"
import { publicDerivedReason, type DerivedMarker } from "./derived-cells.ts"
import { publicHeldReason } from "./held-negatives.ts"
import {
  type SelectedCell,
  type SelectedContextCell,
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
  for (const featureId of Object.keys(trace.document.featureResults)) {
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

/**
 * Current public results retain stored statuses; evidence remains separately publication-reviewed. #37341 Q4: only a
 * decided result is published, with its decided tests only; a result we haven't decided is absent.
 */
export interface PublicProbeResult extends Pick<
  ProbeResult,
  "featureId" | "status" | "attempt" | "tests" | "assertionType"
> {
  reason?: string
  /**
   * The Windows console-host hold this reader applied (#30720): it names the host that answered the queries. Read
   * from a decided console-host test only, so no undecided test's words reach a card (@cto 760e9219).
   */
  hold?: string
  record?: PublicImages
  presentation: PublicPresentation
}

/** #37341 Q4, D6: the counts a published document carries: its decided buckets, never the undecided keys. */
export type PublicCounts = Omit<RollupCounts, (typeof UNPUBLISHED_COUNT_KEYS)[number]>

/** The count keys a published document leaves out (#37341 D6); api.md's dated note names them. */
export const UNPUBLISHED_COUNT_KEYS = ["probe-todo", "probe-invalid", "probe-conflict"] as const

/** A count set as a published document carries it: the undecided keys are left out by name. */
export function publicCounts(counts: Readonly<Record<string, number>>): PublicCounts {
  const { "probe-todo": _todo, "probe-invalid": _invalid, "probe-conflict": _conflict, ...decided } = counts
  return decided as PublicCounts
}

export interface PublicVersion extends Omit<
  CurrentSelectedVersion,
  "results" | "selection" | "screenRecord" | "readRaw" | "traceMemo" | "identityRuleCheck" | "counts"
> {
  counts: PublicCounts
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
  states: Readonly<Record<string, AppCellStatus>>
}

/** An original run's public receipt, separate from a context's composed cells. */
export type PublicRunMetadata = Omit<PublicVersion, "results">

export type PublicFeatureResult = Omit<PublicProbeResult, "status"> &
  Pick<FeatureResult, "strength" | "conflictingProbes"> & {
    /** This cell's published verdict: the joined grade when contexts joined, else this run's stored grade. */
    status: AppCellStatus
  }

export interface PublicContextSummary extends Omit<SelectedContextSummary, "cells" | "attempts" | "counts"> {
  /** The context's decided buckets (#37341 Q4); `score` and `complete` stay folded over the whole catalogue. */
  counts: PublicCounts
  /**
   * The context's standing among its own app's setups: the group's newest setup, or one strictly behind it. Explicit on
   * every published context, so no reader can read an absence as current (@cto 026fd6fd rule 2).
   */
  standing: SetupStanding
  featureResults: Record<
    string,
    PublicFeatureResult & {
      /**
       * The joined verdict across every context that measured the same release (@cto d321729a). Present
       * only when more than one context joined; its `status` alone may read "differs by context".
       */
      joined?: { status: AppCellStatus; from: PublicFeatureGradeSource[] }
      origin: { runId: string; resultId: string }
      measuredAt: string
      suiteId: string
      suiteRelation: CurrentSelectedVersion["suiteRelation"]
      /** Present only when a context supplement read this cell; the qualifier and declared default show beside it. */
      supplement?: SelectedContextCell["supplement"]
      /** Present only when a reopened-cells row withdrew this cell's grade (#33164); `reason` says so in words. */
      reopened?: SelectedContextCell["reopened"]
      /**
       * Present only when a declared pair derived this cell from its parent (#33019); `reason` says so in words. The
       * cell cites the parent's entry, which the derivation read (#37341 D5); the child's own undecided reading stays
       * in the stored run and is never published.
       */
      derived?: Omit<DerivedMarker, "ownStatus" | "ownReason">
      /** Present only when a held negative waits for a Supported reading in its suite (#33034); `reason` says so. */
      held?: SelectedContextCell["held"]
      /** Present only when a reviewed declaration made this open cell untestable (@cto 82a54984); `reason` says so. */
      declared?: SelectedContextCell["declared"]
      /**
       * Present only when this older decision was kept against a newer same-suite attempt whose harness reading did
       * not finish (34675). The cell's own status, reason and origin stay the older decision's; this names the newest
       * refused attempt, its time read from that run's own original.
       */
      refusedAttempt?: NonNullable<SelectedContextCell["refusedAttempt"]>
    }
  >
  sources: Record<string, PublicRunMetadata>
  /** Public attempt facts are flat; private paths and original outcomes remain in the canonical input. */
  attempts: Array<{ runId: string; startedAt?: string; noOutputIds: string[] }>
  /**
   * Every context joined into this app's cells, primary first, when more than one measured the same
   * app version and probe suite (@cto d321729a). Absent when the app has one context.
   */
  contexts?: string[]
}

/** One context's contribution to a joined cell's grade, for the cell that must name its contexts. */
export interface PublicFeatureGradeSource {
  context: string
  status: FeatureResultStatus
}

/**
 * One app's published summary: the primary context's identity and evidence, with every joined context's
 * grades applied. `from` names the contexts behind each cell so a page can apply rule 4; a cell whose
 * grade came from a joined context carries that context's evidence rather than the primary's.
 */
export function composeJoinedSummary(
  primary: PublicContextSummary,
  app: JoinedApp,
  contexts: Record<string, PublicContextSummary>,
): PublicContextSummary {
  if (app.contexts.length < 2) return primary
  const featureResults = { ...primary.featureResults }
  // A cell that carries another context's evidence names that context's run, so the summary carries its
  // receipt too: a reader resolves every cell as `sources[cell.origin.runId]` (docs/api.md, 33979).
  // `contributingRunIds` stays the primary's; a page matches its analysis entry on these `sources` (34533).
  const sources = { ...primary.sources }
  for (const [featureId, cell] of Object.entries(app.cells)) {
    const own = primary.featureResults[featureId]
    if (!own) continue
    // The primary's own result carries the origin, measuredAt and reason a page shows whenever the
    // primary decided; another context's result stands in only when the primary did not decide
    // (@cto c5ddabf3).
    const source = standInGrade(cell, primary.contextKey)
    const other = source ? contexts[source.context]?.featureResults[featureId] : undefined
    if (source && other && !(other.origin.runId in sources)) {
      const receipt = contexts[source.context]?.sources[other.origin.runId]
      if (!receipt) {
        throw new Error(`Joined context ${source.context} lacks source ${other.origin.runId} for ${featureId}`)
      }
      sources[other.origin.runId] = receipt
    }
    featureResults[featureId] = {
      ...(other ?? own),
      status: cell.status,
      joined: {
        status: cell.status,
        from: cell.from.map((grade) => ({ context: grade.context, status: grade.status })),
      },
    }
  }
  // One published count set: the join's. `score.all` stays the primary's graded positions, which the
  // join never adds to — a context adds evidence, never a cell (@cto d321729a).
  return {
    ...primary,
    featureResults,
    sources,
    contexts: app.contexts,
    counts: { ...app.counts },
    score: { supported: app.counts.supported, all: primary.score.all },
  }
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

/**
 * #37341 D5: the entry a derived cell cites is its parent's, which is what the derivation read: the parent cell of the
 * same context, measured by the run the marker names. Anything else refuses, naming the cell.
 */
function derivedOrigin(
  key: string,
  id: string,
  derived: DerivedMarker,
  cells: Readonly<Record<string, SelectedContextCell>>,
): SelectedContextCell["origin"] {
  const parent = cells[derived.parent]
  if (!parent || parent.origin.runId !== derived.parentRunId) {
    throw new Error(
      `${key}/${id}: derived from ${derived.parent} in run ${derived.parentRunId}, but this context's ${derived.parent} cell is ${parent ? `from run ${parent.origin.runId}` : "absent"}`,
    )
  }
  return parent.origin
}

/** #37341 Q4: a derived marker as published: the child's own undecided reading stays in the stored run. */
function publishedDerived(derived: DerivedMarker): Omit<DerivedMarker, "ownStatus" | "ownReason"> {
  const { ownStatus: _ownStatus, ownReason: _ownReason, ...published } = derived
  return published
}

/**
 * #37341 Q4 (@cpo/term f16a5a52): the ONE place a result we haven't decided leaves the public projection. Its cell is
 * absent (so the site renders the blank it renders for no result), a joined cell names only the contexts that decided
 * it, and the counts carry the decided buckets only; `score` and `complete` stay folded over the whole catalogue.
 */
function decidedSummary(summary: PublicContextSummary): PublicContextSummary {
  const featureResults: PublicContextSummary["featureResults"] = {}
  for (const [id, cell] of Object.entries(summary.featureResults)) {
    if (!isPublishedStatus(cell.status)) continue
    featureResults[id] = cell.joined
      ? {
          ...cell,
          joined: { ...cell.joined, from: cell.joined.from.filter((grade) => isPublishedStatus(grade.status)) },
        }
      : cell
  }
  return { ...summary, counts: publicCounts(summary.counts), featureResults }
}

/**
 * #37341 D5 (@cto 97ba8eea): every published card cites an entry of its run's public trace that is itself decided, or,
 * for a reviewed declaration, its review (the cell's reason). A card whose citation is missing refuses here, at build
 * time, naming the cell, instead of failing in a reader's browser.
 */
function checkCitations(where: string, summary: PublicContextSummary, documents: PublicDocuments): void {
  for (const [id, cell] of Object.entries(summary.featureResults)) {
    if (cell.declared) continue
    const receipt = summary.sources[cell.origin.runId]?.trace
    const document = receipt ? documents.get(receipt.url)?.document : undefined
    const entry =
      document && "featureResults" in document && !("cells" in document)
        ? (document as CurrentTraceDocument).featureResults[cell.origin.resultId]
        : undefined
    if (!entry || !isPublishedStatus(entry.status)) {
      throw new Error(
        `${where}/${id}: the published cell cites ${cell.origin.runId}/${cell.origin.resultId}, which its run's public trace does not hold as a decided entry`,
      )
    }
  }
}

/** The API and site consume canonical contexts and original run-owned evidence documents. */
export function publicResults(
  projection: SelectedProjection,
  subjects: ReadonlyMap<string, CurrentResult>,
  /** The same-suite join for every chosen subject (`joinedAppCells`); omitted by readers that hold one context. */
  joined?: ReadonlyMap<string, JoinedApp>,
  /** The history the setup order reads; a fixture passes a stub rather than a repository. */
  history: Pick<SourceHistory, "isAncestor"> = gitSourceHistory(),
) {
  const setups = classifyProjectionSetups(projection, history)
  const traced = new Set(Object.values(projection.contexts).flatMap((context) => context.contributingRunIds))
  const documents: PublicDocuments = new Map()
  // #37341 Q4: a result's undecided tests, and the words they recorded, are never published (@cto 760e9219). A
  // decided result carries no reason of its own here: a cell's reason comes from the marker that decided it.
  const mapResult = (result: ProbeResult): PublicProbeResult => {
    const tests = result.tests.filter((check) => isPublishedStatus(check.status))
    const hold = tests.find((check) => check.id === "console-host")?.reason
    return {
      featureId: result.featureId,
      status: result.status,
      attempt: publicAttempt(result.attempt),
      tests: tests.map((check) => ({
        id: check.id,
        status: check.status,
        attempt: publicAttempt(check.attempt),
        ...(check.assertionRefs && { assertionRefs: [...check.assertionRefs] }),
      })),
      ...(result.assertionType && { assertionType: result.assertionType }),
      ...(hold !== undefined && { hold }),
      presentation: { state: "not-reviewed" },
    }
  }
  const mappedRuns = new Map<string, PublicVersion>()
  const mapVersion = (version: CurrentSelectedVersion): PublicVersion => {
    const prior = mappedRuns.get(version.runId)
    if (prior) {
      if (prior.sha256 !== version.sha256) throw new Error(`Conflicting stored current run ${version.runId}`)
      return prior
    }
    const {
      selection: _selection,
      screenRecord: _screen,
      readRaw: _read,
      traceMemo: _trace,
      // #34617: the identity-rule claim is published only inside the run's trace document.
      identityRuleCheck: _identityRuleCheck,
      results,
      ...metadata
    } = version
    const screen = screenGeometry(version.screenRecord)
    // Every result is mapped, so a decided cell built on an undecided reading (a derived or declared cell) still
    // finds its original here; `publishedVersion` leaves the undecided ones out of every published document.
    const mappedResults = results.map(mapResult)
    const mapped: PublicVersion = {
      ...metadata,
      ...(traced.has(version.runId) && traceReceipt(documents, currentTrace(version), version.schemaVersion)),
      ...(screen && { screen }),
      catalogIds: [...version.catalogIds],
      counts: publicCounts(version.counts),
      score: { ...version.score },
      results: mappedResults,
    }
    mappedRuns.set(version.runId, mapped)
    return mapped
  }
  /** #37341 Q4, D6: a published run carries its decided results only. */
  const publishedVersion = (version: CurrentSelectedVersion): PublicVersion => {
    const mapped = mapVersion(version)
    return { ...mapped, results: mapped.results.filter((result) => isPublishedStatus(result.status)) }
  }
  const mapGroups = (groups: Record<string, CurrentSelectedVersion[]>) =>
    Object.fromEntries(Object.entries(groups).map(([key, versions]) => [key, versions.map(publishedVersion)]))
  const contexts: Record<string, PublicContextSummary> = Object.fromEntries(
    Object.entries(projection.contexts).map(([key, context]) => {
      const sources: Record<string, PublicRunMetadata> = {}
      for (const runId of context.contributingRunIds) {
        const original = originalRunFor(projection, key, runId)
        const { results: _results, ...metadata } = mapVersion(original)
        sources[runId] = metadata
      }
      const featureResults = Object.fromEntries(
        Object.entries(context.cells).map(([id, cell]) => {
          const own = originalRunFor(projection, key, cell.origin.runId)
          const result = mapVersion(own).results.find((row) => row.featureId === cell.origin.resultId)
          if (!result) {
            throw new Error(`Original run ${own.runId} lacks result ${cell.origin.resultId} for ${key}/${id}`)
          }
          // #37341 D5: a derived card cites the parent entry its derivation read, never the child's own undecided one.
          const origin = cell.derived ? derivedOrigin(key, id, cell.derived, context.cells) : cell.origin
          const original = origin === cell.origin ? own : originalRunFor(projection, key, origin.runId)
          const featureResult = isEnvironmentGroup(id)
            ? { status: result.status, strength: null, conflictingProbes: [] }
            : cell.featureResult
          if (!featureResult) throw new Error(`Context ${key}/${id} lacks its computed feature result`)
          return [
            id,
            {
              ...result,
              status: featureResult.status,
              strength: featureResult.strength,
              conflictingProbes: featureResult.conflictingProbes,
              origin,
              measuredAt: original.measuredAt,
              suiteId: original.suiteId,
              suiteRelation: original.suiteRelation,
              ...(cell.supplement && { supplement: cell.supplement }),
              ...(cell.reopened && {
                reopened: cell.reopened,
                reason: publicReopenedReason(cell.reopened),
              }),
              ...(cell.held && { held: cell.held, reason: publicHeldReason(cell.held) }),
              ...(cell.derived && {
                derived: publishedDerived(cell.derived),
                reason: publicDerivedReason(cell.derived),
              }),
              ...(cell.outerAbsent && { outerAbsent: cell.outerAbsent, reason: cell.outerAbsent.reason }),
              ...(cell.declared && { declared: cell.declared, reason: publicDeclaredReason(cell.declared) }),
              // 34675: qualified through the existing original-run store; a refusal-only run need not contribute.
              ...(cell.refusedAttempt && {
                refusedAttempt: {
                  ...cell.refusedAttempt,
                  measuredAt: originalRunFor(projection, key, cell.refusedAttempt.runId).measuredAt,
                },
              }),
            },
          ]
        }),
      )
      const { cells: _cells, ...metadata } = context
      const standing = setups.standings.get(key)
      if (standing === undefined) {
        throw new Error(`Context ${key} has no setup standing; every published context is classified`)
      }
      return [
        key,
        {
          ...metadata,
          standing,
          contributingRunIds: context.contributingRunIds,
          featureResults,
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
  const published = (where: string, summary: PublicContextSummary) => {
    const decided = decidedSummary(summary)
    checkCitations(where, decided, documents)
    return decided
  }
  const selected: PublicProjection = {
    contexts: Object.fromEntries(Object.entries(contexts).map(([key, context]) => [key, published(key, context)])),
    versions: mapGroups(projection.versions),
    history: mapGroups(projection.history),
    contextCount: Object.keys(contexts).length,
    exclusions: projection.exclusions.map(({ runId, reason }) => ({ runId, reason })),
  }
  const selectedByBackend: Record<string, PublicCurrentResult> = Object.fromEntries(
    [...subjects].map(([key, value]) => {
      const context = contexts[value.contextKey]
      if (!context) throw new Error(`Selected context ${value.contextKey} for ${key} is absent from public contexts`)
      const app = joined?.get(key)
      // The join reads every context's full cells; only its decided result is published.
      const summary = published(key, app ? composeJoinedSummary(context, app, contexts) : context)
      return [
        key,
        {
          routeKey: value.routeKey,
          os: value.os,
          contextKey: value.contextKey,
          selected: summary,
          states: Object.fromEntries(
            Object.values(summary.featureResults).map((result) => [result.featureId, result.status]),
          ),
        },
      ]
    }),
  )
  return { projection: selected, selectedByBackend, documents }
}
