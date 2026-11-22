import {
  FEATURE_RESULT_STATUSES,
  type FeatureResultStatus,
  type AssertionType,
  type ProbeResult,
  type ProbeStatus,
  type ProbeSubject,
} from "../../packages/probe-defs/src/types.ts"
import { environmentGroupIds, scoredFeatureIds } from "../../packages/probe-defs/src/environment-groups.ts"
import type { PublicVersion, PublicProbeResult, PublicFeatureResult, PublicContextSummary } from "./public-results.ts"
import { APP_CELL_STATUSES, DIFFERS_BY_CONTEXT, type AppCellStatus } from "./app-cells.ts"

/** Read a current (schema 3 or 4) published result without manufacturing any legacy observation. */
export function publicResultFor(
  version: PublicVersion | PublicContextSummary | undefined,
  featureId: string,
): PublicProbeResult | PublicFeatureResult | undefined {
  if (!version) return undefined
  if ("featureResults" in version) return version.featureResults[featureId]
  return version.results.find((result) => result.featureId === featureId)
}

/** One published cell as the shared rollup reads it. */
type PublishedCell = {
  readonly featureId: string
  readonly status: AppCellStatus
  readonly derived?: unknown
  readonly declared?: unknown
}

/**
 * The input the shared terminal rollup accepts: every published cell's verdict over the whole recorded catalogue,
 * including the derived `differs-by-context` bucket (@cto c3c2f885). The rollup counts a disagreement in its own
 * bucket: it is decided, never Supported or Unsupported, and never open. Every bar, baseline and page that folds
 * published cells through the rollup reads them through here.
 *
 * #37341 Q4: the public projection publishes a decided cell or nothing, so a catalogue id with no published cell is
 * a result we haven't decided and folds as open (`probe-todo`, the bucket of a result not yet decided). A status
 * outside `AppCellStatus`, an id outside the catalogue or a repeated id still refuses loudly instead of being folded
 * into a bucket that does not mean it.
 */
export function rollupInputs(
  app: string,
  published: { readonly catalogIds: readonly string[] } & (
    | { readonly featureResults: Readonly<Record<string, PublishedCell>> }
    | { readonly results: readonly PublishedCell[] }
  ),
): Array<{ featureId: string; status: AppCellStatus; derived?: unknown; declared?: unknown }> {
  if (!Array.isArray(published.catalogIds)) {
    throw new Error(`${app}: published cells carry no catalogIds; a bar folds its cells over the catalogue it was measured on`)
  }
  const cells = "featureResults" in published ? Object.values(published.featureResults) : published.results
  const catalogue = new Set(published.catalogIds)
  const byId = new Map<string, { featureId: string; status: AppCellStatus; derived?: unknown; declared?: unknown }>()
  for (const result of cells) {
    if (!APP_CELL_STATUSES.includes(result.status)) {
      throw new Error(
        `${app}: ${result.featureId} has unknown feature status ${JSON.stringify(result.status)}; this bar cannot count it`,
      )
    }
    if (!catalogue.has(result.featureId)) {
      throw new Error(`${app}: ${result.featureId} is published outside its recorded catalogue; this bar cannot count it`)
    }
    if (byId.has(result.featureId)) throw new Error(`${app}: ${result.featureId} is published twice`)
    byId.set(result.featureId, {
      featureId: result.featureId,
      status: result.status,
      derived: result.derived,
      declared: result.declared,
    })
  }
  return published.catalogIds.map((featureId) => byId.get(featureId) ?? { featureId, status: "probe-todo" })
}

/** The populated categories a page displays, preserving the catalog's supplied order. */
export function visibleCategoryIds(
  categoryOrder: readonly string[],
  categories: Readonly<Record<string, readonly unknown[]>>,
): string[] {
  return categoryOrder.filter((id) => (categories[id]?.length ?? 0) > 0)
}

/**
 * The five states one measured cell can be in. Current readings publish stored `ProbeStatus`
 * values directly; these names survive for the archived legacy evidence the v1 API still renders.
 *
 * Presentation states retain their existing keys: inconclusive is reserved for reviewed Untestable
 * claims, error is PROBE INVALID, and untested is PROBE TODO. A missing cell or evidence "none" means
 * no feature measurement started; an undecided attempt is a failed test, not terminal non-support.
 */
export type FeatureResultDisplayState = "supported" | "unsupported" | "inconclusive" | "error" | "untested"

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

/**
 * Every bucket a rollup counts: the six stored statuses plus the derived disagreement bucket
 * (@cto c3c2f885). A reader that names this type is forced to handle differs; a differs cell is decided,
 * it is never in the Supported or Unsupported numerator, and it is never open.
 */
export type RollupCounts = Record<AppCellStatus, number>

/** The seven buckets at zero, in display order: Supported, Unsupported, Differs by context, then the rest. */
export function emptyRollupCounts(): RollupCounts {
  return {
    supported: 0,
    unsupported: 0,
    [DIFFERS_BY_CONTEXT]: 0,
    untestable: 0,
    "probe-todo": 0,
    "probe-invalid": 0,
    "probe-conflict": 0,
  }
}

/**
 * A count set as a STORED file may hold it: the six stored statuses. `differs-by-context` is derived by the
 * context join and never stored (@cto c3c2f885 condition 5), so a zero bucket is dropped and a NON-zero one
 * refuses loudly — a derived count reaching a stored writer means the boundary broke, and silently dropping
 * it would hide that. `where` names the file (and, for a summary, the engine) the count set belongs to.
 */
export function storedCounts<T extends Record<string, number>>(
  counts: T,
  where: string,
): Omit<T, typeof DIFFERS_BY_CONTEXT> {
  const { [DIFFERS_BY_CONTEXT]: derived, ...stored } = counts
  if (derived !== undefined && derived !== 0) {
    throw new Error(
      `${where}: counts.${DIFFERS_BY_CONTEXT} is ${derived}; that bucket is derived by the context join and never enters a stored file (@cto c3c2f885)`,
    )
  }
  return stored
}

/** A rollup as a stored file may hold it: identical sums, every count set reduced by `storedCounts`. */
export interface StoredTerminalStatusRollup extends Omit<TerminalStatusRollup, "counts" | "families"> {
  readonly counts: Record<FeatureResultStatus, number>
  readonly families: Record<
    string,
    Omit<FamilyRollup, "counts"> & { readonly counts: Record<FeatureResultStatus, number> }
  >
}

export function storedRollup(rollup: TerminalStatusRollup, where: string): StoredTerminalStatusRollup {
  return {
    ...rollup,
    counts: storedCounts(rollup.counts, where),
    families: Object.fromEntries(
      Object.entries(rollup.families).map(([family, entry]) => [
        family,
        { ...entry, counts: storedCounts(entry.counts, `${where} family ${family}`) },
      ]),
    ),
  }
}

/**
 * What one bucket means to a bar. Total over `AppCellStatus`: a new bucket is a compile error here, so no
 * reader can fold it into "open" or "supported" with a default branch. Differs is decided and is neither a
 * supported nor an unsupported measurement.
 */
const BUCKET_KIND: Readonly<Record<AppCellStatus, "supported" | "unsupported" | "differs" | "untestable" | "open">> = {
  supported: "supported",
  unsupported: "unsupported",
  [DIFFERS_BY_CONTEXT]: "differs",
  untestable: "untestable",
  "probe-todo": "open",
  "probe-invalid": "open",
  "probe-conflict": "open",
}

/** Sum the buckets that mean one of `kinds`; every bucket is classified by `BUCKET_KIND`, never defaulted. */
function sumBuckets(counts: RollupCounts, kinds: ReadonlyArray<(typeof BUCKET_KIND)[AppCellStatus]>): number {
  let total = 0
  for (const status of APP_CELL_STATUSES) if (kinds.includes(BUCKET_KIND[status])) total += counts[status]
  return total
}

/** Current score and completion fold recorded statuses over exactly the recorded catalogue. */
export interface CurrentAggregate {
  denominator: number
  counts: RollupCounts
  /** Of `counts.unsupported`, the cells derived from a refused parent (#33019); never a measurement. */
  derived: number
  /** Of `counts.untestable`, the cells a reviewed declaration made untestable (@cto 82a54984); never a probe answer. */
  byReview: number
  idsByState: Record<AppCellStatus, string[]>
  supported: number
  complete: boolean
}

export interface FamilyRollup {
  readonly family: string
  readonly positions: number
  readonly environmentPositions: number
  readonly counts: RollupCounts
  readonly decided: number
  readonly open: number
  readonly donePct: number
}

export interface TerminalStatusRollup {
  readonly positions: number
  readonly environmentPositions: number
  readonly counts: RollupCounts
  /** Of `counts.unsupported`, the cells derived from a refused parent (#33019). */
  readonly derived: number
  /** Of `counts.untestable`, the cells a reviewed declaration made untestable (@cto 82a54984). */
  readonly byReview: number
  /** Supported plus directly measured Unsupported: derived cells are not measurements. */
  readonly decisive: number
  /** No longer open: decisive, derived and Untestable. */
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
 * folds the graded positions (`scoredFeatureIds`) into the five status counts, family rollups,
 * decisive/decided/open sums, percentages, and four-way completeness tier.
 */
export function rollupTerminalStatuses(
  statuses: Readonly<Record<string, string>>,
  catalogIds: readonly string[] = Object.keys(statuses),
  /** Cells whose Unsupported is derived from a refused parent (#33019); counted, never measured. */
  derivedIds: ReadonlySet<string> = new Set(),
  /** Cells a reviewed declaration made untestable (@cto 82a54984); counted apart, never probe-answered. */
  reviewedIds: ReadonlySet<string> = new Set(),
): TerminalStatusRollup {
  const counts = emptyRollupCounts()
  const familyAcc = new Map<string, { positions: number; environmentPositions: number; counts: RollupCounts }>()
  const ensureFamily = (family: string) => {
    let entry = familyAcc.get(family)
    if (!entry) {
      entry = {
        positions: 0,
        environmentPositions: 0,
        counts: emptyRollupCounts(),
      }
      familyAcc.set(family, entry)
    }
    return entry
  }

  // D132 B (#30917): grading covers the graded ids only. The nine environment groups stay in the
  // catalogue, but they are not features and a run cannot grade them, so they are tracked as
  // ungraded environmentPositions, never as PROBE TODO.
  const envIds = environmentGroupIds(catalogIds)
  for (const id of envIds) {
    ensureFamily(id.split(".")[0] ?? id).environmentPositions++
  }
  const gradedIds = scoredFeatureIds(catalogIds)
  for (const id of gradedIds) {
    const status = Object.hasOwn(statuses, id) ? statuses[id] : undefined
    if (!status || !APP_CELL_STATUSES.includes(status as AppCellStatus)) {
      throw new Error(`Invalid stored current status for ${id}`)
    }
    const bucket = status as AppCellStatus
    counts[bucket]++
    const familyEntry = ensureFamily(id.split(".")[0] ?? id)
    familyEntry.positions++
    familyEntry.counts[bucket]++
  }

  const positions = gradedIds.length
  const environmentPositions = envIds.length
  const derived = gradedIds.filter((id) => derivedIds.has(id) && statuses[id] === "unsupported").length
  const byReview = gradedIds.filter((id) => reviewedIds.has(id) && statuses[id] === "untestable").length
  const decisive = decisiveCells(counts, derived)
  // Differs is decided: two contexts measured the cell and disagreed. It is never supported, never
  // open, and never part of `decisive`, so neither percentage numerator can absorb it.
  const decided = sumBuckets(counts, ["supported", "unsupported", "differs", "untestable"])
  const open = sumBuckets(counts, ["open"])
  const donePct = positions === 0 ? 0 : Math.round((100 * decided) / positions)
  // The share line and this number ask ONE predicate (@dev/16 on #33600): a bar whose only decided cells
  // disagree judged something, so it reads 0% in both rather than a percentage beside a null.
  const supportedPct =
    runDecidedNothing(counts, derived) || positions === 0 ? null : Math.round((100 * counts.supported) / positions)
  const completenessTier: 0 | 1 | 2 | 3 =
    positions === 0 ? 0 : counts["probe-todo"] > 0 ? 1 : counts["probe-invalid"] + counts["probe-conflict"] > 0 ? 2 : 3

  const families: Record<string, FamilyRollup> = {}
  for (const [family, entry] of familyAcc) {
    const famDecided = sumBuckets(entry.counts, ["supported", "unsupported", "differs", "untestable"])
    const famOpen = sumBuckets(entry.counts, ["open"])
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
    derived,
    byReview,
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
 * Work-list ranking over the graded positions (`scoredFeatureIds`) across library status maps
 * (Phase 2.4 A5): deterministic tie-breaking by `(-libOpen, -libFailure, featureId)`.
 */
export function rankOpenProbes(
  libCells: Readonly<Record<string, Readonly<Record<string, string>>>>,
  catalogIds: readonly string[] = [
    ...new Set(Object.values(libCells).flatMap((statuses) => Object.keys(statuses))),
  ].sort(),
): ProbeOpenRankRow[] {
  const gradedIds = scoredFeatureIds(catalogIds)
  const libMaps = Object.values(libCells)
  const rows: ProbeOpenRankRow[] = []

  for (const featureId of gradedIds) {
    let libFailure = 0
    let libTodo = 0
    for (const statuses of libMaps) {
      const status = Object.hasOwn(statuses, featureId) ? statuses[featureId] : undefined
      if (!status || !FEATURE_RESULT_STATUSES.includes(status as FeatureResultStatus)) {
        throw new Error(`Invalid stored current status for ${featureId}`)
      }
      if (status === "probe-invalid" || status === "probe-conflict") libFailure++
      else if (status === "probe-todo") libTodo++
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
  results: readonly (Pick<FeatureResult, "featureId"> & {
    readonly status: AppCellStatus
    readonly derived?: unknown
    readonly declared?: unknown
  })[],
  catalogIds: readonly string[],
): CurrentAggregate {
  if (!catalogIds.length || new Set(catalogIds).size !== catalogIds.length) {
    throw new Error("Current aggregate requires a nonempty unique recorded catalogue")
  }
  const statuses: Record<string, string> = {}
  const idsByState = Object.fromEntries(APP_CELL_STATUSES.map((status) => [status, [] as string[]])) as Record<
    AppCellStatus,
    string[]
  >
  for (const result of results) {
    statuses[result.featureId] = result.status
  }
  if (
    Object.keys(statuses).length !== results.length ||
    results.length !== catalogIds.length ||
    catalogIds.some((id) => !Object.hasOwn(statuses, id))
  ) {
    throw new Error("Current results differ from recorded catalogue membership")
  }
  const derivedIds = new Set(results.filter((result) => result.derived !== undefined).map((result) => result.featureId))
  const reviewedIds = new Set(
    results.filter((result) => result.declared !== undefined).map((result) => result.featureId),
  )
  const rollup = rollupTerminalStatuses(statuses, catalogIds, derivedIds, reviewedIds)
  for (const id of scoredFeatureIds(catalogIds)) {
    idsByState[statuses[id] as AppCellStatus].push(id)
  }
  return {
    denominator: rollup.positions,
    counts: rollup.counts,
    derived: rollup.derived,
    byReview: rollup.byReview,
    idsByState,
    supported: rollup.counts.supported,
    complete: rollup.open === 0,
  }
}

/**
 * A library's completeness tier over its graded positions (the environment groups excluded): 0 nothing graded was
 * measured, 1 incomplete (any PROBE TODO), 2 broken (PROBE INVALID and no PROBE TODO), 3 every graded position decided.
 * This is the rule's one home: the hourly re-measure imports it from the pinned checkout and the site
 * renders from it (#31733 A2, #31747).
 */
export type CompletenessTier = Readonly<{
  completenessTier: 0 | 1 | 2 | 3
  todo: number
  failure: number
  positions: number
}>

/**
 * The completeness tier of one library's recorded statuses, keyed by feature id.
 *
 * This is a STORED-status reader — the hourly re-measure writes through it — so the derived
 * `differs-by-context` bucket is refused here: it is computed by the site's context join and never stored
 * (@cto c3c2f885 condition 5).
 */
export function completenessTierOf(statuses: Readonly<Record<string, string>>): CompletenessTier {
  for (const [id, status] of Object.entries(statuses)) {
    if (status === DIFFERS_BY_CONTEXT) {
      throw new Error(
        `completenessTierOf reads stored statuses only; ${id} reads ${DIFFERS_BY_CONTEXT}, which the context join derives and never stores`,
      )
    }
  }
  const rollup = rollupTerminalStatuses(statuses)
  return {
    completenessTier: rollup.completenessTier,
    todo: rollup.counts["probe-todo"],
    failure: rollup.counts["probe-invalid"] + rollup.counts["probe-conflict"],
    positions: rollup.positions,
  }
}

/**
 * How many graded features a count set has a decided result for, of how many graded features it folded
 * (#37341 D1/D2, @cpo/term bfbbc644). Tested is Supported, Unsupported, Untestable and Differs by context; graded is
 * every bucket, because a fold counts each graded id once. The fold's undecided buckets are required: a published
 * count set has dropped them, so it cannot say how many features were graded, and refuses here.
 */
export function testedOfGraded(counts: ReadableCounts): { tested: number; graded: number } {
  for (const bucket of ["supported", "unsupported", "untestable", "probe-todo", "probe-invalid"] as const) {
    if (typeof counts[bucket] !== "number") {
      throw new Error(
        `coverage counts lack the ${bucket} bucket; fold the cells over their catalogue (rollupInputs) before counting`,
      )
    }
  }
  const differs = counts[DIFFERS_BY_CONTEXT] ?? 0
  const tested = counts.supported + counts.unsupported + counts.untestable + differs
  return { tested, graded: tested + counts["probe-todo"] + counts["probe-invalid"] + (counts["probe-conflict"] ?? 0) }
}

/**
 * The ONE coverage sentence (#37341 D1, D12): "T of N tested" over the graded features, the environment groups
 * excluded. Every page, the admin tools and the CLI print it after `currentSupportedShare`, so the whole readout is
 * "S supported · T of 264 tested". A caller that names the catalogue is checked against it: a count set that does
 * not cover exactly that catalogue's graded features refuses.
 */
export function currentCoverageSentence(
  aggregate: { readonly counts: ReadableCounts },
  catalogIds?: readonly string[],
): string {
  const { tested, graded } = testedOfGraded(aggregate.counts)
  if (catalogIds !== undefined) {
    const named = scoredFeatureIds(catalogIds).length
    if (named !== graded) {
      throw new Error(
        `coverage counts fold ${graded} graded features, but the catalogue they are printed for has ${named} graded features`,
      )
    }
  }
  return `${tested} of ${graded} tested`
}

/** The ONE supported readout (#37341 D2): a count, never a share of anything. */
export function currentSupportedShare(aggregate: { readonly counts: Pick<ReadableCounts, "supported"> }): string {
  return `${aggregate.counts.supported} supported`
}

/**
 * The cells of a bar that carry a verdict about the terminal: Supported and Unsupported. A reviewed
 * Untestable claim says the row cannot be probed, not that the terminal was judged, and PROBE TODO /
 * PROBE INVALID decide nothing. This is the ONE owner of that sum for the baseline row readout.
 */
export function decisiveCells(
  counts: { readonly supported: number; readonly unsupported: number },
  derived = 0,
): number {
  // #33019: a derived Unsupported reads Unsupported but was decided by no test of its own.
  return counts.supported + counts.unsupported - derived
}

/**
 * The counts a page or a row reads: every stored status, plus the derived disagreement bucket when the
 * reader was handed a joined bar (@cto c3c2f885). A stored-only aggregate simply has no differs member.
 */
export type ReadableCounts = Readonly<
  Record<ProbeStatus, number> & Partial<Record<"probe-conflict" | typeof DIFFERS_BY_CONTEXT, number>>
>

/**
 * Whether a run judged nothing at all (#30784): every cell is PROBE TODO, PROBE INVALID or a reviewed
 * Untestable claim. The ONE predicate a rollup asks before it prints a supported percentage, so a run that
 * judged nothing carries `supportedPct: null` rather than a measured-looking zero.
 *
 * A differs cell was measured by two same-suite contexts and they disagreed, so a run whose only decided
 * cells disagree did judge something: it prints its real percentage, never the not-measured words
 * (@dev/16's round-2 nit on 33595).
 */
export function runDecidedNothing(counts: ReadableCounts, derived = 0): boolean {
  return decisiveCells(counts, derived) === 0 && (counts[DIFFERS_BY_CONTEXT] ?? 0) === 0
}

/** Canonical probe methods, ordered from weakest to strongest. */
export const PROBE_METHODS = ["source", "internal", "output", "visual", "end-to-end"] as const
export type ProbeMethod = (typeof PROBE_METHODS)[number]
export const PROBE_METHOD_RANK = { source: 1, internal: 2, output: 3, visual: 4, "end-to-end": 5 } as const

export type ResultMethodClassification =
  | {
      readonly kind: "method"
      readonly method: ProbeMethod
      readonly strength: 1 | 2 | 3 | 4 | 5
      readonly source: "assertion"
      readonly assertionType?: AssertionType
    }
  | { readonly kind: "unobserved-open" }
  | { readonly kind: "mixed"; readonly assertionTypes: readonly AssertionType[] }
  | { readonly kind: "unmapped"; readonly reason: string }

export interface FeatureResult {
  readonly featureId: string
  readonly status: FeatureResultStatus
  readonly strength: 1 | 2 | 3 | 4 | 5 | null
  /** Original current probe supplying this result's representative evidence; conflicts have none. */
  readonly probeId: string | null
  readonly conflictingProbes: readonly string[]
}

/** Fold the current probes for one subject; historical reruns must be selected before this boundary. */
export function computeFeatureResults(
  probes: readonly {
    readonly featureId: string
    readonly probeId: string
    readonly method: ProbeMethod | null
    readonly status: ProbeStatus
  }[],
  catalogIds: readonly string[],
): Record<string, FeatureResult> {
  const results: Record<string, FeatureResult> = {}
  for (const featureId of scoredFeatureIds(catalogIds)) {
    const observed = probes.filter((probe) => probe.featureId === featureId && probe.method !== "source")
    const decided = observed.filter((probe) => probe.status === "supported" || probe.status === "unsupported")
    const first = decided[0]
    const conflict = first !== undefined && decided.some((probe) => probe.status !== first.status)
    const strongest = decided.reduce<typeof first>(
      (best, probe) =>
        !best ||
        (probe.method === null ? 0 : PROBE_METHOD_RANK[probe.method]) >
          (best.method === null ? 0 : PROBE_METHOD_RANK[best.method])
          ? probe
          : best,
      undefined,
    )
    const status: FeatureResultStatus = conflict
      ? "probe-conflict"
      : strongest
        ? strongest.status
        : observed.some((probe) => probe.status === "probe-invalid")
          ? "probe-invalid"
          : observed.length === 0 || observed.some((probe) => probe.status === "probe-todo")
            ? "probe-todo"
            : "untestable"
    results[featureId] = {
      featureId,
      status,
      strength: !conflict && strongest?.method ? PROBE_METHOD_RANK[strongest.method] : null,
      probeId: conflict ? null : ((strongest ?? observed.find((probe) => probe.status === status))?.probeId ?? null),
      conflictingProbes: conflict ? decided.map((probe) => probe.probeId) : [],
    }
  }
  return results
}

export function classifyResultMethod(
  result: ProbeResult,
  subject: Pick<ProbeSubject, "kind" | "version">,
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

  const isDecided = result.status === "supported" || result.status === "unsupported"

  const onlyType = distinctTypes.size === 1 ? [...distinctTypes][0] : undefined
  if (onlyType !== undefined) {
    if (subject.kind === "lib") {
      if (
        onlyType === "buffer_state" ||
        onlyType === "query_reply" ||
        onlyType === "input_bytes" ||
        onlyType === "clipboard"
      ) {
        return {
          kind: "method",
          method: "internal",
          strength: 2,
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
        method: "output",
        strength: 3,
        source: "assertion",
        assertionType: onlyType,
      }
    }
    if (onlyType === "screenshot") {
      return {
        kind: "method",
        method: "visual",
        strength: 4,
        source: "assertion",
        assertionType: onlyType,
      }
    }
    if (
      onlyType === "input_bytes" ||
      onlyType === "clipboard" ||
      onlyType === "process_environment" ||
      onlyType === "notification"
    ) {
      return {
        kind: "method",
        method: "end-to-end",
        strength: 5,
        source: "assertion",
        assertionType: onlyType,
      }
    }
  }

  if (isDecided) {
    return {
      kind: "unmapped",
      reason: `decided status ${result.status} without assertionType`,
    }
  }

  return {
    kind: "unobserved-open",
  }
}
