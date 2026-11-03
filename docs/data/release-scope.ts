import {
  PROBE_STATUSES,
  type AssertionType,
  type ProbeResult,
  type ProbeStatus,
  type ProbeSubject,
} from "../../packages/probe-defs/src/types.ts"
import { environmentGroupIds, gradedFeatureIds } from "../../packages/probe-defs/src/environment-groups.ts"
import {
  SOURCE_ANSWER_PENDING_LABELS,
  hasUnverifiedSourceAnswerSuffix,
  publicSourceAnswerPendingLabel,
  sourceAnswerForRef,
} from "../../packages/probe-defs/src/source-answers.ts"
import type { PublicVersion, PublicProbeResult, PublicContextSummary } from "./public-results.ts"

/** Read a current (schema 3 or 4) published result without manufacturing any legacy observation. */
export function publicResultFor(
  version: PublicVersion | PublicContextSummary | undefined,
  featureId: string,
): PublicProbeResult | undefined {
  if (!version) return undefined
  if ("cells" in version) return version.cells[featureId]
  return version.results.find((result) => result.featureId === featureId)
}

/** Release 1 measurement claim: 62 query/reply features of the 270-feature catalog. */

/** The populated categories a page displays, preserving the catalog's supplied order. */
export function visibleCategoryIds(
  categoryOrder: readonly string[],
  categories: Readonly<Record<string, readonly unknown[]>>,
): string[] {
  return categoryOrder.filter((id) => (categories[id]?.length ?? 0) > 0)
}

export interface ReleaseFeature {
  id: string
  name: string
  status: "not measured in this release"
}

export interface ReleaseScope {
  tier: number
  method: string
  measuredIds: string[]
  /**
   * The declared ids an APP run can decide: `measuredIds` minus the app-unobservable rows. This is
   * the denominator every decisive share is scored over, so a row whose decider is the parser
   * surface only (see `@terminfo/probe-defs` `APP_UNOBSERVABLE_ROWS`) never reads as a terminal
   * undecidability.
   */
  scoredIds: string[]
  /** The declared rows an app run cannot decide, in declaration order, named and never scored. */
  libraryOnlyIds: string[]
  measuredCount: number
  catalogCount: number
  unmeasured: ReleaseFeature[]
}

/**
 * The five states one measured cell can be in. Current readings publish sealed `ProbeStatus`
 * values directly; these names survive for the archived legacy evidence the v1 API still renders.
 *
 * Presentation states retain their existing keys: inconclusive is reserved for reviewed Untestable
 * claims, error is TEST FAILURE, and untested is TEST TODO. A missing cell or evidence "none" means
 * no feature measurement started; an undecided attempt is a failed test, not terminal non-support.
 */
export type CellState = "supported" | "unsupported" | "inconclusive" | "error" | "untested"

function utcDate(measuredAt: string): string {
  const value = new Date(measuredAt)
  if (Number.isNaN(value.getTime())) throw new Error(`invalid measuredAt ${measuredAt}`)
  return value.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" })
}

export function staleCaption(measuredAt: string): string {
  return `not re-measured since ${utcDate(measuredAt)}`
}

/** Which suite a run measured, compared with the live tree (`probeHash()` at build time). */
export type SuiteRelation = "tree" | "older" | "partial"

/**
 * A run measured on the live tree suite is current; "older" and "partial" are
 * stale. This is the ONE staleness fact — never re-derive it by re-parsing the display label.
 */
export function isStaleRelation(relation: SuiteRelation): boolean {
  return relation === "older" || relation === "partial"
}

/** A context remains current when any original evidence source is current; safe for site clients. */
export function hasCurrentSource(sources: readonly { suiteRelation: SuiteRelation }[]): boolean {
  return sources.some((source) => !isStaleRelation(source.suiteRelation))
}

/** Current score and completion fold recorded statuses over exactly the frozen catalogue. */
export interface CurrentAggregate {
  denominator: number
  counts: Record<ProbeStatus, number>
  idsByState: Record<ProbeStatus, string[]>
  supported: number
  complete: boolean
}

export interface FamilyRollup {
  readonly family: string
  readonly positions: number
  readonly environmentPositions: number
  readonly counts: Record<ProbeStatus, number>
  readonly decided: number
  readonly open: number
  readonly donePct: number
}

export interface TerminalStatusRollup {
  readonly positions: number
  readonly environmentPositions: number
  readonly counts: Record<ProbeStatus, number>
  readonly decisive: number
  readonly decided: number
  readonly open: number
  readonly donePct: number
  readonly supportedPct: number | null
  readonly completenessTier: 0 | 1 | 2 | 3
  readonly families: Record<string, FamilyRollup>
}

export interface ProbeOpenRankRow {
  readonly featureId: string
  readonly family: string
  readonly libOpen: number
  readonly libFailure: number
  readonly libTodo: number
}

/**
 * The single status-and-rollup computation over one terminal's recorded statuses (Phase 2.4):
 * folds the graded positions (`gradedFeatureIds`) into the five status counts, family rollups,
 * decisive/decided/open sums, percentages, and four-way completeness tier.
 */
export function rollupTerminalStatuses(
  statuses: Readonly<Record<string, string>>,
  catalogIds: readonly string[] = Object.keys(statuses),
): TerminalStatusRollup {
  const counts: Record<ProbeStatus, number> = {
    supported: 0,
    unsupported: 0,
    untestable: 0,
    "test-todo": 0,
    "test-failure": 0,
  }
  const familyAcc = new Map<
    string,
    { positions: number; environmentPositions: number; counts: Record<ProbeStatus, number> }
  >()
  const ensureFamily = (family: string) => {
    let entry = familyAcc.get(family)
    if (!entry) {
      entry = {
        positions: 0,
        environmentPositions: 0,
        counts: { supported: 0, unsupported: 0, untestable: 0, "test-todo": 0, "test-failure": 0 },
      }
      familyAcc.set(family, entry)
    }
    return entry
  }

  // D132 B (#30917): grading covers the graded ids only. The nine environment groups stay in the
  // catalogue, but they are not features and a run cannot grade them, so they are tracked as
  // ungraded environmentPositions, never as TEST TODO.
  const envIds = environmentGroupIds(catalogIds)
  for (const id of envIds) {
    ensureFamily(id.split(".")[0] ?? id).environmentPositions++
  }
  const gradedIds = gradedFeatureIds(catalogIds)
  for (const id of gradedIds) {
    const status = Object.hasOwn(statuses, id) ? statuses[id] : undefined
    if (!status || !PROBE_STATUSES.includes(status as ProbeStatus)) {
      throw new Error(`Invalid stored current status for ${id}`)
    }
    const probeStatus = status as ProbeStatus
    counts[probeStatus]++
    const familyEntry = ensureFamily(id.split(".")[0] ?? id)
    familyEntry.positions++
    familyEntry.counts[probeStatus]++
  }

  const positions = gradedIds.length
  const environmentPositions = envIds.length
  const decisive = decisiveCells(counts)
  const decided = decisive + counts.untestable
  const open = counts["test-todo"] + counts["test-failure"]
  const donePct = positions === 0 ? 0 : Math.round((100 * decided) / positions)
  const supportedPct = decisive === 0 || positions === 0 ? null : Math.round((100 * counts.supported) / positions)
  const completenessTier: 0 | 1 | 2 | 3 =
    positions === 0 ? 0 : counts["test-todo"] > 0 ? 1 : counts["test-failure"] > 0 ? 2 : 3

  const families: Record<string, FamilyRollup> = {}
  for (const [family, entry] of familyAcc) {
    const famDecided = entry.counts.supported + entry.counts.unsupported + entry.counts.untestable
    const famOpen = entry.counts["test-todo"] + entry.counts["test-failure"]
    families[family] = {
      family,
      positions: entry.positions,
      environmentPositions: entry.environmentPositions,
      counts: entry.counts,
      decided: famDecided,
      open: famOpen,
      donePct: entry.positions === 0 ? 0 : Math.round((100 * famDecided) / entry.positions),
    }
  }

  return {
    positions,
    environmentPositions,
    counts,
    decisive,
    decided,
    open,
    donePct,
    supportedPct,
    completenessTier,
    families,
  }
}

/**
 * Work-list ranking over the graded positions (`gradedFeatureIds`) across library status maps
 * (Phase 2.4 A5): deterministic tie-breaking by `(-libOpen, -libFailure, featureId)`.
 */
export function rankOpenProbes(
  libCells: Readonly<Record<string, Readonly<Record<string, string>>>>,
  catalogIds: readonly string[] = [
    ...new Set(Object.values(libCells).flatMap((statuses) => Object.keys(statuses))),
  ].sort(),
): ProbeOpenRankRow[] {
  const gradedIds = gradedFeatureIds(catalogIds)
  const libMaps = Object.values(libCells)
  const rows: ProbeOpenRankRow[] = []

  for (const featureId of gradedIds) {
    let libFailure = 0
    let libTodo = 0
    for (const statuses of libMaps) {
      const status = Object.hasOwn(statuses, featureId) ? statuses[featureId] : undefined
      if (!status || !PROBE_STATUSES.includes(status as ProbeStatus)) {
        throw new Error(`Invalid stored current status for ${featureId}`)
      }
      if (status === "test-failure") libFailure++
      else if (status === "test-todo") libTodo++
    }
    const libOpen = libFailure + libTodo
    rows.push({
      featureId,
      family: featureId.split(".")[0] ?? featureId,
      libOpen,
      libFailure,
      libTodo,
    })
  }

  rows.sort(
    (a, b) =>
      b.libOpen - a.libOpen ||
      b.libFailure - a.libFailure ||
      (a.featureId < b.featureId ? -1 : a.featureId > b.featureId ? 1 : 0),
  )
  return rows
}

export function aggregateCurrentResults(
  results: readonly Pick<ProbeResult, "featureId" | "status">[],
  catalogIds: readonly string[],
): CurrentAggregate {
  if (!catalogIds.length || new Set(catalogIds).size !== catalogIds.length) {
    throw new Error("Current aggregate requires a nonempty unique frozen catalogue")
  }
  const statuses: Record<string, string> = {}
  const idsByState: Record<ProbeStatus, string[]> = {
    supported: [],
    unsupported: [],
    untestable: [],
    "test-todo": [],
    "test-failure": [],
  }
  for (const result of results) {
    statuses[result.featureId] = result.status
  }
  if (
    Object.keys(statuses).length !== results.length ||
    results.length !== catalogIds.length ||
    catalogIds.some((id) => !Object.hasOwn(statuses, id))
  ) {
    throw new Error("Current results differ from frozen catalogue membership")
  }
  const rollup = rollupTerminalStatuses(statuses, catalogIds)
  for (const id of gradedFeatureIds(catalogIds)) {
    idsByState[statuses[id] as ProbeStatus].push(id)
  }
  return {
    denominator: rollup.positions,
    counts: rollup.counts,
    idsByState,
    supported: rollup.counts.supported,
    complete: rollup.open === 0,
  }
}

/**
 * A library's completeness tier over its graded positions (the environment groups excluded): 0 nothing graded was
 * measured, 1 incomplete (any TEST TODO), 2 broken (TEST FAILURE and no TEST TODO), 3 every graded position decided.
 * Not the Release 1 scope `tier` of {@link ReleaseScope} (#31733 A3). This is the rule's one home: the hourly
 * re-measure imports it from the pinned checkout and the site renders from it (#31733 A2, #31747).
 */
export type CompletenessTier = Readonly<{
  completenessTier: 0 | 1 | 2 | 3
  todo: number
  failure: number
  positions: number
}>

/** The completeness tier of one library's recorded statuses, keyed by feature id. */
export function completenessTierOf(statuses: Readonly<Record<string, string>>): CompletenessTier {
  const rollup = rollupTerminalStatuses(statuses)
  return {
    completenessTier: rollup.completenessTier,
    todo: rollup.counts["test-todo"],
    failure: rollup.counts["test-failure"],
    positions: rollup.positions,
  }
}

export function currentCoverageSentence(
  aggregate: Pick<CurrentAggregate, "counts">,
  catalogIds?: readonly string[],
): string {
  const counts = aggregate.counts
  const graded = `${counts.supported} Supported · ${counts.unsupported} Unsupported · ${counts.untestable} Untestable · ${counts["test-todo"]} TEST TODO · ${counts["test-failure"]} TEST FAILURE`
  // D132 B (#30917): an exclusion the site cannot explain reads as a terminal verdict, so a caller
  // that knows the run's catalogue names the environment groups it recorded as ungraded.
  const environmentGroups = catalogIds ? environmentGroupIds(catalogIds).length : 0
  return environmentGroups === 0
    ? graded
    : `${graded} · ${environmentGroups} environment groups manual by design (catalogue), ungraded`
}

export function currentSupportedShare(aggregate: CurrentAggregate): string {
  // #30784: the same rule as a baseline row, one level up. A run whose every cell is TEST TODO or
  // TEST FAILURE decided nothing, so "0/264 supported (0%)" would read as a measured fail.
  if (runDecidedNothing(aggregate.counts)) return NOT_MEASURED_TEXT
  return `${aggregate.supported}/${aggregate.denominator} supported (${Math.round((100 * aggregate.supported) / aggregate.denominator)}%)`
}

/**
 * The cells of a bar that carry a verdict about the terminal: Supported and Unsupported. A reviewed
 * Untestable claim says the row cannot be probed, not that the terminal was judged, and TEST TODO /
 * TEST FAILURE decide nothing. This is the ONE owner of that sum for the baseline row readout.
 */
export function decisiveCells(counts: { readonly supported: number; readonly unsupported: number }): number {
  return counts.supported + counts.unsupported
}

/**
 * Whether a run judged nothing at all (#30784): every cell is TEST TODO, TEST FAILURE or a reviewed
 * Untestable claim. This is the run-level twin of `notMeasuredReadout`, and the ONE predicate every
 * whole-run readout asks, so a page cannot print a measured-looking zero for it.
 */
export function runDecidedNothing(counts: Readonly<Record<ProbeStatus, number>>): boolean {
  return decisiveCells(counts) === 0
}

/**
 * The words a baseline row prints in place of a percentage when its run judged nothing (#30763):
 * "0%" there reads as a measured fail for a terminal no run ever decided. The counts stay in the
 * row's tooltip.
 *
 * TBD (#30763 AC5): the operator's naming menu has not ruled between "Not tested yet" and
 * "Not measured yet"; this placeholder ships until that approval lands.
 */
export const NOT_MEASURED_TEXT = "Not measured yet"

/**
 * The one thing both baseline pages share for a row that decided nothing (#30763): the not-measured
 * words, with what the row looked at in its title. A row with any decisive cell returns undefined and
 * each page keeps its own decided-row text, byte-identical to what it printed before the fix — the
 * defect is the false "0%", and nothing beside it may move.
 */
export function notMeasuredReadout(
  counts: Readonly<Record<ProbeStatus, number>>,
): { text: string; title: string } | undefined {
  if (decisiveCells(counts) > 0) return undefined
  return { text: NOT_MEASURED_TEXT, title: currentCoverageSentence({ counts }) }
}

/**
 * Operator-approved Probe Method rank table (GLOSSARY.md ec065acbdb22, @cto 3bfdb550):
 * one fixed confidence order, weakest (1) to strongest (5).
 */
export const PROBE_METHODS = ["source-reading", "library", "app-text", "app-screenshot", "real-os-device"] as const

export type ProbeMethod = (typeof PROBE_METHODS)[number]

export const PROBE_METHOD_RANK: Readonly<Record<ProbeMethod, 1 | 2 | 3 | 4 | 5>> = {
  "source-reading": 1,
  library: 2,
  "app-text": 3,
  "app-screenshot": 4,
  "real-os-device": 5,
}

export type MinimumMethodMap = Readonly<Record<string, Partial<Record<ProbeSubject["kind"], ProbeMethod | null>>>>

export type ResultMethodClassification =
  | {
      readonly kind: "method"
      readonly method: ProbeMethod
      readonly confidenceRank: 1 | 2 | 3 | 4 | 5
      readonly source: "assertion" | "review-ref"
      readonly assertionType?: AssertionType
    }
  | {
      readonly kind: "kept-answer-not-reverified"
      readonly label: "kept answer, not re-verified"
      readonly reviewRef: string
      readonly rowAlsoHoldsCitedAnswer: boolean
    }
  | {
      readonly kind: "unobserved-open"
      readonly isDisagreedSourceAnswer: boolean
    }
  | {
      readonly kind: "mixed"
      readonly assertionTypes: readonly AssertionType[]
    }
  | {
      readonly kind: "unmapped"
      readonly reason: string
    }

/**
 * Report-only finding status for one subject and feature (Phase 2.4 extension, @cto 3bfdb550).
 * Nothing in `generate-api`, the site, or `rollupTerminalStatuses` reads `findingStatus` in this batch.
 */
export type FindingStatus = ProbeStatus | "test-conflict" | "no-minimum-declared"

/**
 * Report-only feature finding over one subject's run(s) and declared minimum method (@cto 3bfdb550).
 * Nothing in `generate-api`, the site, or `rollupTerminalStatuses` reads `findingStatus` in this batch.
 */
export interface FeatureFinding {
  readonly featureId: string
  readonly storedStatus: ProbeStatus
  readonly observedMethods: readonly ProbeMethod[]
  readonly highestObservedMethod: ProbeMethod | null
  readonly minimumMethod: ProbeMethod | null
  readonly findingStatus: FindingStatus
  readonly winningMethod: ProbeMethod | null
  readonly neededMethod: ProbeMethod | null
}

export interface KeptAnswerNotReverifiedBucket {
  readonly label: "kept answer, not re-verified"
  readonly count: number
  readonly rowAlsoHoldsCitedAnswerCount: number
  readonly rowAlsoHoldsCitedAnswerLabel: "row also holds a cited answer; not proof it applied"
  readonly items: readonly {
    readonly featureId: string
    readonly reviewRef: string
    readonly rowAlsoHoldsCitedAnswer: boolean
  }[]
}

/**
 * Report-only method-and-findings rollup for one subject (@cto 3bfdb550).
 * Nothing in `generate-api`, the site, or `rollupTerminalStatuses` reads `findingStatus` in this batch.
 */
export interface SubjectMethodFindingsReport {
  readonly subject: Pick<ProbeSubject, "kind" | "id" | "version" | "os">
  readonly positions: number
  readonly environmentPositions: number
  readonly findingCounts: Readonly<Record<FindingStatus, number>>
  readonly findings: Readonly<Record<string, FeatureFinding>>
  readonly needsByMethod: Readonly<Record<ProbeMethod, readonly string[]>>
  readonly buckets: {
    readonly keptAnswerNotReverified: KeptAnswerNotReverifiedBucket
    readonly noMinimum: readonly string[]
    readonly mixed: readonly { readonly featureId: string; readonly assertionTypes: readonly AssertionType[] }[]
    readonly unmapped: readonly { readonly featureId: string; readonly status: ProbeStatus; readonly reason: string }[]
    readonly wouldBeConflicts: readonly string[]
  }
}

export interface MethodFindingsRunInput {
  readonly subject: Pick<ProbeSubject, "kind" | "id" | "version" | "os">
  readonly results?: readonly ProbeResult[]
  readonly assertions: readonly { readonly assertionType?: AssertionType }[]
  readonly catalogIds?: readonly string[]
  readonly suite?: { readonly catalogIds: readonly string[] }
}

/**
 * Total and loud field-to-method mapping for one graded ProbeResult (@cto 3bfdb550 Adjustments 1, 2, 4, 7).
 */
export function classifyResultMethod(
  result: ProbeResult,
  subjectKind: ProbeSubject["kind"],
  runAssertions: readonly { readonly assertionType?: AssertionType }[],
): ResultMethodClassification {
  const distinctTypes = new Set<AssertionType>()
  if (result.assertionType !== undefined) {
    distinctTypes.add(result.assertionType)
  }
  for (const test of result.tests) {
    for (const refIdx of test.assertionRefs ?? []) {
      const assertion = runAssertions[refIdx]
      if (!assertion || !assertion.assertionType) {
        throw new Error(`Missing assertion ref ${refIdx} for ${result.featureId}`)
      }
      distinctTypes.add(assertion.assertionType)
    }
  }

  if (distinctTypes.size > 1) {
    return {
      kind: "mixed",
      assertionTypes: [...distinctTypes].sort(),
    }
  }

  const isDecided = result.status === "supported" || result.status === "unsupported" || result.status === "untestable"

  if (isDecided && result.reviewRef) {
    const row = sourceAnswerForRef(result.reviewRef)
    if (!row) {
      throw new Error(`Missing source-answer row ${result.reviewRef}`)
    }
    const matching = row.answers.filter((answer) => answer.status === result.status)
    if (matching.length === 0) {
      return {
        kind: "unmapped",
        reason: `reviewRef ${result.reviewRef} has no answer matching status ${result.status}`,
      }
    }
    if (!hasUnverifiedSourceAnswerSuffix(result.reason, row.subject.version)) {
      return {
        kind: "method",
        method: "source-reading",
        confidenceRank: 1,
        source: "review-ref",
      }
    }
    return {
      kind: "kept-answer-not-reverified",
      label: "kept answer, not re-verified",
      reviewRef: result.reviewRef,
      rowAlsoHoldsCitedAnswer: matching.some((answer) => answer.citedBlobs.length > 0),
    }
  }

  const onlyType = distinctTypes.size === 1 ? [...distinctTypes][0] : undefined
  if (onlyType !== undefined) {
    if (subjectKind === "lib") {
      if (
        onlyType === "buffer_state" ||
        onlyType === "query_reply" ||
        onlyType === "input_bytes" ||
        onlyType === "clipboard"
      ) {
        return {
          kind: "method",
          method: "library",
          confidenceRank: 2,
          source: "assertion",
          assertionType: onlyType,
        }
      }
      return {
        kind: "unmapped",
        reason: `assertionType ${onlyType} is not mapped for subject kind lib`,
      }
    }
    if (onlyType === "buffer_state" || onlyType === "query_reply") {
      return {
        kind: "method",
        method: "app-text",
        confidenceRank: 3,
        source: "assertion",
        assertionType: onlyType,
      }
    }
    if (onlyType === "screenshot") {
      return {
        kind: "method",
        method: "app-screenshot",
        confidenceRank: 4,
        source: "assertion",
        assertionType: onlyType,
      }
    }
    if (onlyType === "input_bytes" || onlyType === "clipboard") {
      return {
        kind: "method",
        method: "real-os-device",
        confidenceRank: 5,
        source: "assertion",
        assertionType: onlyType,
      }
    }
  }

  if (isDecided) {
    return {
      kind: "unmapped",
      reason: `decided status ${result.status} without assertionType or reviewRef`,
    }
  }

  return {
    kind: "unobserved-open",
    isDisagreedSourceAnswer:
      result.status === "test-todo" &&
      publicSourceAnswerPendingLabel(result.reason) === SOURCE_ANSWER_PENDING_LABELS.disagree,
  }
}

/**
 * Fold one subject's run(s) and declared minimum methods into a report-only SubjectMethodFindingsReport
 * over the graded catalogue positions (@cto 3bfdb550).
 */
export function rollupSubjectMethodFindings(
  runs: readonly MethodFindingsRunInput[],
  minimumMethods: MinimumMethodMap = {},
  catalogIds?: readonly string[],
): SubjectMethodFindingsReport {
  const firstRun = runs[0]
  if (!firstRun) {
    throw new Error("Method findings require at least one run")
  }
  const subject = firstRun.subject
  const resolvedCatalogIds = catalogIds ?? firstRun.catalogIds ?? firstRun.suite?.catalogIds
  if (!resolvedCatalogIds || resolvedCatalogIds.length === 0) {
    throw new Error("Method findings require a nonempty catalogue")
  }

  const envIds = environmentGroupIds(resolvedCatalogIds)
  const gradedIds = gradedFeatureIds(resolvedCatalogIds)

  const runResultMaps = runs.map((run) => {
    if (run.subject.kind !== subject.kind || run.subject.id !== subject.id) {
      throw new Error(
        `Method findings require runs for one subject; got ${subject.kind}:${subject.id} and ${run.subject.kind}:${run.subject.id}`,
      )
    }
    if (!run.results) {
      throw new Error(`Method findings require current-schema run results for ${subject.kind}:${subject.id}`)
    }
    const map = new Map<string, ProbeResult>()
    for (const res of run.results) {
      map.set(res.featureId, res)
    }
    return { run, map }
  })

  const findingCounts: Record<FindingStatus, number> = {
    supported: 0,
    unsupported: 0,
    untestable: 0,
    "test-todo": 0,
    "test-failure": 0,
    "test-conflict": 0,
    "no-minimum-declared": 0,
  }
  const findings: Record<string, FeatureFinding> = {}
  const needsByMethod: Record<ProbeMethod, string[]> = {
    "source-reading": [],
    library: [],
    "app-text": [],
    "app-screenshot": [],
    "real-os-device": [],
  }
  const keptNotReverifiedItems: Array<{
    readonly featureId: string
    readonly reviewRef: string
    readonly rowAlsoHoldsCitedAnswer: boolean
  }> = []
  let rowAlsoHoldsCitedAnswerCount = 0
  const noMinimum: string[] = []
  const mixed: Array<{ readonly featureId: string; readonly assertionTypes: readonly AssertionType[] }> = []
  const unmapped: Array<{ readonly featureId: string; readonly status: ProbeStatus; readonly reason: string }> = []
  const wouldBeConflicts: string[] = []

  for (const featureId of gradedIds) {
    const cells: Array<{
      readonly result: ProbeResult
      readonly classification: ResultMethodClassification
    }> = []

    let hasC1Disagreement = false
    for (const { run, map } of runResultMaps) {
      const result = map.get(featureId)
      if (!result || !PROBE_STATUSES.includes(result.status)) {
        throw new Error(`Invalid stored current status for ${featureId}`)
      }
      const classification = classifyResultMethod(result, subject.kind, run.assertions)
      cells.push({ result, classification })

      if (classification.kind === "kept-answer-not-reverified") {
        keptNotReverifiedItems.push({
          featureId,
          reviewRef: classification.reviewRef,
          rowAlsoHoldsCitedAnswer: classification.rowAlsoHoldsCitedAnswer,
        })
        if (classification.rowAlsoHoldsCitedAnswer) {
          rowAlsoHoldsCitedAnswerCount++
        }
      } else if (classification.kind === "mixed") {
        mixed.push({ featureId, assertionTypes: classification.assertionTypes })
      } else if (classification.kind === "unmapped") {
        unmapped.push({ featureId, status: result.status, reason: classification.reason })
      }

      if (
        result.status === "test-todo" &&
        publicSourceAnswerPendingLabel(result.reason) === SOURCE_ANSWER_PENDING_LABELS.disagree
      ) {
        hasC1Disagreement = true
      }
    }

    if (hasC1Disagreement) {
      wouldBeConflicts.push(featureId)
    }

    const firstCell = cells[0]
    if (!firstCell) {
      throw new Error(`Missing cell for ${featureId}`)
    }
    const storedStatus = firstCell.result.status
    const observedMethodSet = new Set<ProbeMethod>()
    for (const { classification } of cells) {
      if (classification.kind === "method") {
        observedMethodSet.add(classification.method)
      }
    }
    const observedMethods = [...observedMethodSet].sort((a, b) => PROBE_METHOD_RANK[a] - PROBE_METHOD_RANK[b])
    const highestObservedMethod = observedMethods.at(-1) ?? null

    const minimumMethod = minimumMethods[featureId]?.[subject.kind] ?? null

    let findingStatus: FindingStatus
    let winningMethod: ProbeMethod | null = null
    let neededMethod: ProbeMethod | null = null

    if (minimumMethod === null) {
      findingStatus = "no-minimum-declared"
      noMinimum.push(featureId)
    } else {
      const minRank = PROBE_METHOD_RANK[minimumMethod]
      const qualifyingDecided = cells.filter(
        (
          cell,
        ): cell is {
          readonly result: ProbeResult & { readonly status: "supported" | "unsupported" | "untestable" }
          readonly classification: Extract<ResultMethodClassification, { readonly kind: "method" }>
        } =>
          (cell.result.status === "supported" ||
            cell.result.status === "unsupported" ||
            cell.result.status === "untestable") &&
          cell.classification.kind === "method" &&
          cell.classification.confidenceRank >= minRank,
      )

      const distinctDecidedStatuses = new Set(qualifyingDecided.map((cell) => cell.result.status))
      const firstQualifying = qualifyingDecided[0]

      if (distinctDecidedStatuses.size > 1 || (qualifyingDecided.length === 0 && minRank === 1 && hasC1Disagreement)) {
        findingStatus = "test-conflict"
      } else if (distinctDecidedStatuses.size === 1 && firstQualifying) {
        findingStatus = firstQualifying.result.status
        const best = qualifyingDecided.reduce((acc, cur) =>
          cur.classification.confidenceRank > acc.classification.confidenceRank ? cur : acc,
        )
        winningMethod = best.classification.method
      } else {
        const hasInvalid = cells.some((cell) => cell.result.status === "test-failure")
        findingStatus = hasInvalid ? "test-failure" : "test-todo"
        neededMethod = minimumMethod
        needsByMethod[minimumMethod].push(featureId)
      }
    }

    findingCounts[findingStatus]++
    findings[featureId] = {
      featureId,
      storedStatus,
      observedMethods,
      highestObservedMethod,
      minimumMethod,
      findingStatus,
      winningMethod,
      neededMethod,
    }
  }

  return {
    subject: {
      kind: subject.kind,
      id: subject.id,
      version: subject.version,
      os: subject.os,
    },
    positions: gradedIds.length,
    environmentPositions: envIds.length,
    findingCounts,
    findings,
    needsByMethod,
    buckets: {
      keptAnswerNotReverified: {
        label: "kept answer, not re-verified",
        count: keptNotReverifiedItems.length,
        rowAlsoHoldsCitedAnswerCount,
        rowAlsoHoldsCitedAnswerLabel: "row also holds a cited answer; not proof it applied",
        items: keptNotReverifiedItems,
      },
      noMinimum,
      mixed,
      unmapped,
      wouldBeConflicts,
    },
  }
}
