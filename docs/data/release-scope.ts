import { PROBE_STATUSES, type ProbeResult, type ProbeStatus } from "../../packages/probe-defs/src/types.ts"
import { environmentGroupIds, gradedFeatureIds } from "../../packages/probe-defs/src/environment-groups.ts"
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

/**
 * Which suite a run was measured on, relative to the two facts the site must never conflate:
 * the RELEASE suite (the scope's `frozenSuiteId`) and the live TREE suite (`probeHash()` at build time).
 */
export type SuiteRelation = "release" | "tree" | "older" | "partial"

/**
 * A run measured on the release suite or on the live tree suite is current; "older" and "partial" are
 * stale. This is the ONE staleness fact — never re-derive it by re-parsing the display label.
 */
export function isStaleRelation(relation: SuiteRelation): boolean {
  return relation === "older" || relation === "partial"
}

/** A context remains current when any original evidence source is current; safe for site clients. */
export function hasCurrentSource(sources: readonly { suiteRelation: SuiteRelation }[]): boolean {
  return sources.some((source) => !isStaleRelation(source.suiteRelation))
}

/** True when the live tree has moved past the release suite, so a banner must say so (one, not two). */
export function treeMovedPastRelease(treeSuiteId: string | null, releaseSuiteId: string | null): boolean {
  return Boolean(treeSuiteId) && Boolean(releaseSuiteId) && treeSuiteId !== releaseSuiteId
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
