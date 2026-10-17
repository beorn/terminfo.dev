/**
 * Release 1 decisive-count reader (#27909) — the instrument behind the Release 1 bar.
 *
 * No shebang: the file is mode 100644, so nothing ever executed it as a program (every caller runs
 * `bun scripts/decisive-share.ts`, or imports it), and a shebang is what the VitePress data loader
 * that consumes this reader for the candidate-2 page refuses with a syntax error.
 *
 * Read-only. Two sections:
 *
 *  1. BAR ROWS — one per Release 1 desktop context (terminal id + os, from the 15323 § Release 1
 *     plan: Linux kitty/ghostty/wezterm/alacritty/xterm, macOS terminal-app/iterm2/ghostty/alacritty/
 *     kitty, Windows Terminal). Each row resolves the run the SITE selects for that context, by
 *     reusing docs/data/current-results.ts — there is no second selection here. When several contexts
 *     are current for one (terminal id, os) the reviewed `content/default-contexts.json` row decides,
 *     the same policy `compatibilityTargets` applies; the row it used is printed. It prints the run
 *     id, the decisive count and share over the declared 62 tier-1 rows AND over the included 52, the
 *     inconclusive share ON THE INCLUDED 52, the remainder rows by name, each row's selected suite id,
 *     and the D3 verdict label over the included 52 (the declared 62 prints only as a labelled
 *     context line, never as the verdict). A context with no selected run
 *     prints "not measured — no selected run", a real tie with no reviewed row prints "ambiguous"
 *     naming the contexts, and neither is ever 0%. The header names the Release 1 exceptions once
 *     with their ruling ids - ruled by name, not excluded by this reader, so a named row still
 *     prints its own FAIL/PASS on the bar.
 *  2. ADMITTED RUNS — one line per run the site ADMITS under content/probes-apps, labelled
 *     `<terminal id> <version> <os> <runId>` with decisive/62 and decisive/52, so the Release 1 Linux
 *     runs and any admitted-but-unselected run stay visible by run id without polluting the bar rows.
 *     SITE-EXCLUDED RUNS — every app run THIS READER measures that the site REFUSES, each named
 *     with the ONE admission gate's own reason, beside the admitted list and never folded into it;
 *     an empty list prints "none" rather than omitting the section. The section is SCOPED to the app
 *     runs read here, so its count is not the header's wider "rejected" count of every document the
 *     projection refused.
 *
 * It never touches content/terminals.json, collectors/probe-defs, the launcher, or any admitted run
 * document. It writes nothing. Bucket math is the site's own `aggregateCells` over the reader's
 * classified table, not a second copy.
 *
 * Usage: bun scripts/decisive-share.ts [--cohort candidate1|candidate2|candidate4] [terminal-id ...]
 * Candidate 1 is the default. Candidate 2 keeps all 125 classics on the suite registry's current freeze.
 * When live selection moves past it, bar rows name the selected run's suite and required frozen suite
 * as ineligible. Only admitted history on that required suite then receives the 125 verdict.
 *
 * Candidate 4 is the extensions and input slices the tier adds, read on candidate 2's required suite,
 * passed EXPLICITLY and printed: that suite is frozen for candidate 2 and is being read for
 * candidate-4 ids, because no candidate-4 freeze exists yet. The report never falls back to a
 * manifest that does not name the cohort: a cohort with no manifest still refuses. Both cohorts run
 * the ONE buildReport path: the cohort is data (name, slices, suite ownership).
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { parseArgs } from "node:util"
import { parseJsonStrict, parseSuiteManifest } from "@terminfo/run-parser"
import { splitDecidableBasis } from "@terminfo/probe-defs"
import { loadFeatures, type FeatureCatalog, type Slice } from "@terminfo/catalog"
import {
  loadCurrentResults,
  loadDefaultContextPolicy,
  type DefaultContextReview,
} from "../docs/data/current-results.ts"
import { statesFor } from "../docs/data/selected-results.ts"
import {
  frozenSuiteIdFor,
  loadReleaseScope,
  loadFeatureCohort,
  type FeatureCohort,
  type FeatureCohortName,
} from "../docs/data/load-release-scope.ts"
import { loadCategories, orderedCategoryIds, type CategoryMeta } from "../docs/data/categories.ts"
import {
  aggregateCells,
  d3Verdict,
  D3_VERDICT_BAR,
  tier1Included,
  type CellState,
  type D3Verdict,
} from "../docs/data/release-scope.ts"

import {
  candidateFromSelected,
  pickContextRun,
  type ContextCandidate,
  type RunSelection,
  type ShareCells,
} from "../docs/data/run-selection.ts"

/** The eleven Release 1 desktop contexts (15323 § Release 1; children 27834 Mac, 27835 Linux+Windows). */
export const RELEASE_1_CONTEXTS = [
  { terminalId: "kitty", os: "linux" },
  { terminalId: "ghostty", os: "linux" },
  { terminalId: "wezterm", os: "linux" },
  { terminalId: "alacritty", os: "linux" },
  { terminalId: "xterm", os: "linux" },
  { terminalId: "terminal-app", os: "macos" },
  { terminalId: "iterm2", os: "macos" },
  { terminalId: "ghostty", os: "macos" },
  { terminalId: "alacritty", os: "macos" },
  { terminalId: "kitty", os: "macos" },
  { terminalId: "windows-terminal", os: "windows" },
] as const

export interface ReleaseContext {
  terminalId: string
  os: string
}

/**
 * The Release 1 named exceptions, ruled by name (@chief). They are excluded from the RELEASE
 * DECISION by the ruling, not by this reader: every row is still graded on the bar, so a row listed
 * here that fails on the 52 prints FAIL — the bar's own truth — and the header names it so the FAIL
 * is not read as a release blocker (or the header read as a claim the reader excludes it).
 */
export const NAMED_EXCEPTIONS = [
  {
    terminalId: "kitty",
    os: "macos",
    note: "31/52 by contract - codimac is persistent hardware and can carry no legitimate disposable receipt (@chief e0bd3081)",
  },
  {
    terminalId: "windows-terminal",
    os: "windows",
    note: "row owed by @dev/agy-other (27931); a named gap, not a silent omission, if absent at the act (@chief 009afbbc)",
  },
] as const

/** The header line that names the exceptions once, with their ruling ids. */
export function namedExceptionsLine(): string {
  const named = NAMED_EXCEPTIONS.map((entry) => `${entry.terminalId}/${entry.os} - ${entry.note}`).join("; ")
  return `named exceptions (excluded from the decision by name, NOT by this reader): ${named}`
}

/** A row that is neither decisive nor inconclusive: a present-but-error cell, or no cell at all. */
export interface RemainderRow {
  featureId: string
  bucket: "error" | "untested"
}

export interface DecisiveShare {
  denominator: number
  decisive: number
  decisivePct: number
  inconclusive: number
  inconclusivePct: number
  inconclusiveIds: string[]
  remainder: RemainderRow[]
  verdict: D3Verdict
}

/** One inconclusive row, with the run's own reason and note when the cell carries them. */
export interface InconclusiveRow {
  featureId: string
  reason?: string
  note?: string
}

/**
 * The inconclusive ids of a share, each carrying its cell's own `reason`/`note`. The run is the only
 * source: a row whose cell has gone missing is a loud fault, not an unnamed gap.
 */
export function inconclusiveRows(cells: ShareCells, share: DecisiveShare): InconclusiveRow[] {
  return share.inconclusiveIds.map((id) => {
    const cell = cells[id]
    if (!cell) throw new Error(`inconclusive row ${id} has no cell in the run; the share and the run disagree`)
    return {
      featureId: id,
      ...(cell.reason !== undefined && { reason: cell.reason }),
      ...(cell.note !== undefined && { note: cell.note }),
    }
  })
}

function sharePct(count: number, denominator: number): number {
  return denominator === 0 ? 0 : Math.round((count / denominator) * 100)
}

/**
 * Reduce one CLASSIFIED cell map to the three buckets over the given tier-1 ids. Counts come from ONE
 * `aggregateCells` fold over the reader's table; the remainder is a view of that same table in the
 * BASIS's own order (the order the retired bar printed), so nothing is re-classified and nothing needs
 * the old cross-check.
 */
export function decisiveShare(
  states: Readonly<Record<string, CellState>>,
  measuredIds: readonly string[],
): DecisiveShare {
  const aggregate = aggregateCells(states, measuredIds)
  const decisive = aggregate.counts.supported + aggregate.counts.unsupported
  // The remainder reads the basis in ITS OWN order — error and untested rows interleaved exactly as the
  // basis names them — over the reader's classified table, so no id is classified twice.
  const remainder: RemainderRow[] = []
  for (const id of measuredIds) {
    const state = states[id] ?? "untested"
    if (state === "error") remainder.push({ featureId: id, bucket: "error" })
    else if (state === "untested") remainder.push({ featureId: id, bucket: "untested" })
  }
  return {
    denominator: aggregate.denominator,
    decisive,
    decisivePct: sharePct(decisive, aggregate.denominator),
    inconclusive: aggregate.counts.inconclusive,
    inconclusivePct: sharePct(aggregate.counts.inconclusive, aggregate.denominator),
    inconclusiveIds: [...aggregate.idsByState.inconclusive],
    remainder,
    verdict: d3Verdict(decisive, aggregate.denominator),
  }
}

/** The declared 62 tier-1 ids: the catalog rows whose slice is `tier1`, ascending. */
export function tierOneIds(contentDir: string): string[] {
  const catalog = featureCatalog(contentDir)
  return loadReleaseScope({ catalog, categories: loadCategories(contentDir) }).measuredIds
}

function featureCatalog(contentDir: string): FeatureCatalog {
  return loadFeatures(contentDir)
}

export interface ContextShares {
  tier62: DecisiveShare
  tier52: DecisiveShare
}

export interface MeasuredRow {
  context: ReleaseContext
  measured: true
  run: ContextCandidate
  selection: RunSelection
  shares: ContextShares
}

export interface NotMeasuredRow {
  context: ReleaseContext
  measured: false
  reason: string
}

export type BarRow = MeasuredRow | NotMeasuredRow

export function barRowForContext(args: {
  context: ReleaseContext
  candidates: readonly ContextCandidate[]
  reviewed?: DefaultContextReview
  tier62Ids: readonly string[]
  tier52Ids: readonly string[]
}): BarRow {
  const picked = pickContextRun(args.candidates, args.reviewed)
  if (!picked) {
    return {
      context: args.context,
      measured: false,
      reason: `not measured — no selected run for ${args.context.terminalId}/${args.context.os}`,
    }
  }
  if ("ambiguous" in picked) {
    return {
      context: args.context,
      measured: false,
      reason:
        `not measured — ambiguous current selection for ${args.context.terminalId}/${args.context.os}: ` +
        `${picked.ambiguous.join(", ")}; a reviewed default-context row must choose one`,
    }
  }
  return {
    context: args.context,
    measured: true,
    run: picked.run,
    selection: picked.selection,
    shares: {
      tier62: decisiveShare(picked.run.states, args.tier62Ids),
      tier52: decisiveShare(picked.run.states, args.tier52Ids),
    },
  }
}

/** A run document the site refused, with the ONE admission gate's own reason (projection.exclusions). */
export interface RefusedRun {
  run: ContextCandidate
  reason: string
}

/** The one run order every list in this reader uses: terminal, os, newest first, then run id. */
function byRunIdOrder(left: ContextCandidate, right: ContextCandidate): number {
  return (
    left.terminalId.localeCompare(right.terminalId) ||
    left.os.localeCompare(right.os) ||
    right.measuredAt.localeCompare(left.measuredAt) ||
    left.runId.localeCompare(right.runId)
  )
}

export interface Report {
  tier62Ids: string[]
  tier52Ids: string[]
  barRows: BarRow[]
  admittedRuns: ContextCandidate[]
  refusedRuns: RefusedRun[]
  legacySkipped: number
  rejected: number
  searched: string
  /** The selected cohort's report; absent under candidate1. Named by `cohort.name`. */
  cohort?: ScorableCohort & {
    decidableIds: string[]
    unavailableIds: string[]
    libraryOnlyIds: string[]
    barRows: CohortBarRow[]
    admittedRuns: CohortRun[]
    refusedRuns: RefusedRun[]
    slices: CohortSpec["slices"]
    suiteFrozenFor: FeatureCohortName
  }
}

/**
 * The cohort reduced to what a decisive share is scored over. `measuredIds` holds the cohort's full
 * catalog set; the release share divides over `scoredIds` — the cohort ids an APP run can decide,
 * which is `measuredIds` minus the app-unobservable rows — and the per-category block divides over
 * `decidableIds`, the scored ids the required suite's schedule also covers. Two lists stay OUT of
 * every denominator and are named beside each fraction: the ids the schedule does not cover
 * (`unavailableIds`) and the rows no app run can decide (`libraryOnlyIds`).
 */
export type ScorableCohort = FeatureCohort & { readonly decidableIds: readonly string[] }

/**
 * The cohort as DATA, so one report serves every cohort: its name, the catalog category slices it is
 * the union of, the suite the reading is taken on, and whose freeze declared that suite. Nobody
 * branches on the cohort name; the only difference between two cohorts is this value.
 */
export interface CohortSpec {
  name: FeatureCohortName
  slices: readonly Slice[]
  /** Candidate 4 is the tier this cohort ADDS, so it drops the rows already labelled tier 1. */
  excludingTier1: boolean
  suiteId: string
  /** The cohort whose manifest froze `suiteId`; the report prints that this suite is read for another. */
  suiteFrozenFor: FeatureCohortName
}

/**
 * Candidate 2's cohort: the categories the catalog labels `classics`, read on the suite the
 * candidate-4 freeze declares. The classics bar moves to that suite so the reading never falls
 * between two freezes; the printed ownership says whose freeze declared it.
 */
export function candidate2Cohort(contentDir: string): CohortSpec {
  return {
    name: "candidate2",
    slices: ["classics"],
    excludingTier1: false,
    suiteId: frozenSuiteIdFor(contentDir, "candidate4"),
    suiteFrozenFor: "candidate4",
  }
}

/**
 * Candidate 4's cohort: the extensions and input slices, read on the suite candidate 4's own freeze
 * declares. The suite is named here EXPLICITLY, so the printed ownership is read, never assumed.
 */
export function candidate4Cohort(contentDir: string): CohortSpec {
  return {
    name: "candidate4",
    slices: ["extensions", "input"],
    excludingTier1: true,
    suiteId: frozenSuiteIdFor(contentDir, "candidate4"),
    suiteFrozenFor: "candidate4",
  }
}

const COHORT_LABELS: Readonly<Record<FeatureCohortName, string>> = {
  candidate2: "Candidate 2 classics",
  candidate4: "Candidate 4 extensions and input",
}

type CohortReport = NonNullable<Report["cohort"]>

/**
 * The one header line every cohort prints. It names the required suite and WHOSE freeze declared it:
 * reading another cohort's frozen suite is allowed only when it is said out loud, so the ownership is
 * rendered, never inferred by the reader.
 */
export function cohortHeaderLine(cohort: CohortReport): string {
  const suite = `required suite ${cohort.frozenSuiteId}`
  const suiteNote =
    cohort.suiteFrozenFor === cohort.name
      ? suite
      : `${suite} — frozen for ${cohort.suiteFrozenFor}, read here for ${cohort.name} ids`
  return `${COHORT_LABELS[cohort.name]} · ${cohort.measuredIds.length} IDs (${cohort.decidableIds.length} with a probe in ${suite} and app-observable) · ${suiteNote}; ineligible: selected run on suite X, required ${cohort.frozenSuiteId} when live selection moves; only frozen-suite admitted history then receives the cohort verdict`
}

export type CohortRun =
  | { run: ContextCandidate; measured: true; share: DecisiveShare }
  | { run: ContextCandidate; measured: false; reason: string }

export type CohortBarRow = NotMeasuredRow | (CohortRun & { context: ReleaseContext; selection: RunSelection })

function cohortRun(run: ContextCandidate, cohort: ScorableCohort, role: "selected" | "admitted"): CohortRun {
  if (run.suiteId !== cohort.frozenSuiteId) {
    return {
      run,
      measured: false,
      reason: `ineligible: ${role} run on suite ${run.suiteId}, required ${cohort.frozenSuiteId}`,
    }
  }
  // The RELEASE line is the D3 bar over the cohort's `measuredIds` with the app-unobservable rows
  // removed: an id leaves the cohort only as a NAMED row, never silently. An id with no probe in the
  // required suite counts as NOT decisive there and is named beside the fraction — the gap is in the
  // suite, not in the cohort. Only the per-category block divides over the decidable basis.
  return { run, measured: true, share: decisiveShare(run.states, cohort.scoredIds) }
}

/** Eligibility follows the site's completed selection; history never replaces the selected run. */
export function cohortRowForSelected(row: BarRow, cohort: ScorableCohort): CohortBarRow {
  if (!row.measured) return row
  return { ...cohortRun(row.run, cohort, "selected"), context: row.context, selection: row.selection }
}

/**
 * The whole report: bar rows from the site's current selection, and every admitted schema-v2 `app` run
 * (newest first per context key) for the by-run-id section.
 */
export function buildReport(args: {
  contentDir: string
  contexts?: readonly ReleaseContext[]
  cohort?: CohortSpec
}): Report {
  let cohort: (ScorableCohort & { slices: CohortSpec["slices"]; suiteFrozenFor: FeatureCohortName }) | undefined
  let unavailableIds: string[] = []
  let libraryOnlyIds: string[] = []
  if (args.cohort) {
    const categories = loadCategories(args.contentDir)
    const declared = loadFeatureCohort({
      catalog: featureCatalog(args.contentDir),
      categories,
      name: args.cohort.name,
      slices: args.cohort.slices,
      excludingTier1: args.cohort.excludingTier1,
      frozenSuiteId: args.cohort.suiteId,
    })
    const manifestPath = join(args.contentDir, "suites", `${declared.frozenSuiteId}.json`)
    const manifest = parseSuiteManifest(manifestPath, readFileSync(manifestPath, "utf8"))
    if (manifest.probeHash !== declared.frozenSuiteId) {
      throw new Error(
        `${manifestPath}: probeHash ${manifest.probeHash} does not match required ${declared.frozenSuiteId}`,
      )
    }
    // The header prints whose freeze declared this suite, so the manifest must BE that cohort's freeze.
    // Printing the spec's claim without checking it would let a stale or borrowed suite read aloud as
    // the cohort's own.
    if (manifest.freeze?.release !== args.cohort.suiteFrozenFor) {
      throw new Error(
        `${manifestPath}: freeze.release is "${manifest.freeze?.release ?? "(none)"}", not "${args.cohort.suiteFrozenFor}", ` +
          `so the suite cannot be printed as frozen for ${args.cohort.suiteFrozenFor}`,
      )
    }
    // ONE basis, one owner: the required schedule is the source of availability. The split runs over
    // `scoredIds` (the app-observable rows), so an app-unobservable row can never enter a category
    // denominator, and the ids the schedule does not cover are carried as `unavailableIds` — named
    // beside the fraction, never in a denominator.
    const basis = splitDecidableBasis(declared.scoredIds, manifest.probes.app)
    unavailableIds = [...basis.unavailableIds]
    libraryOnlyIds = [...declared.libraryOnlyIds]
    cohort = {
      ...declared,
      decidableIds: basis.decidableIds,
      slices: args.cohort.slices,
      suiteFrozenFor: args.cohort.suiteFrozenFor,
    }
  }
  const projection = loadCurrentResults(args.contentDir).projection
  const current = Object.entries(projection.current).map(([key, selected]) =>
    candidateFromSelected(key, selected, statesFor(projection, selected.runId)),
  )
  const reviewed = loadDefaultContextPolicy(args.contentDir)
  // The ONE admission gate decides membership: a run the projection put in `exclusions` was refused
  // by admitRun(), so it is named as a refusal WITH that reason and never listed as admitted. Nothing
  // is re-decided here, so the reader can never disagree with the site about the same run document.
  const refusals = new Map(projection.exclusions.map((entry) => [entry.runId, entry.reason]))
  const admitted: ContextCandidate[] = []
  const refused: RefusedRun[] = []
  let legacySkipped = 0
  for (const [key, list] of Object.entries(projection.history)) {
    for (const selected of list) {
      if (selected.target.kind !== "app") continue
      // The projection marks a schema-v1 legacy document with suiteId "legacy"; its boolean results
      // are unverified, so a bare decisive share would read as a false 0%.
      if (selected.suiteId === "legacy") {
        legacySkipped++
        continue
      }
      const candidate = candidateFromSelected(key, selected, statesFor(projection, selected.runId))
      // Membership, not truthiness: `undefined` is the only thing that means "the projection did not
      // refuse this run". A falsy-but-present reason must never be read as an admission.
      const reason = refusals.get(selected.runId)
      if (reason === undefined) admitted.push(candidate)
      else refused.push({ run: candidate, reason })
    }
  }
  admitted.sort(byRunIdOrder)
  refused.sort((left, right) => byRunIdOrder(left.run, right.run))
  const tier62Ids = tierOneIds(args.contentDir)
  const tier52Ids = tier1Included(featureCatalog(args.contentDir), tier62Ids)
  const contexts = args.contexts ?? RELEASE_1_CONTEXTS
  const barRows = contexts.map((context) =>
    barRowForContext({
      context,
      candidates: current.filter(
        (candidate) =>
          candidate.kind === "app" && candidate.terminalId === context.terminalId && candidate.os === context.os,
      ),
      reviewed: reviewed[`app:${context.terminalId}`],
      tier62Ids,
      tier52Ids,
    }),
  )
  const report: Report = {
    tier62Ids,
    tier52Ids,
    barRows,
    admittedRuns: admitted,
    refusedRuns: refused,
    legacySkipped,
    rejected: projection.exclusions.length,
    searched: join(args.contentDir, "probes-apps"),
  }
  if (cohort) {
    report.cohort = {
      ...cohort,
      decidableIds: [...cohort.decidableIds],
      unavailableIds,
      libraryOnlyIds,
      barRows: barRows.map((row) => cohortRowForSelected(row, cohort)),
      admittedRuns: admitted.map((run) => cohortRun(run, cohort, "admitted")),
      refusedRuns: refused,
    }
  }
  return report
}

/**
 * One cohort category: its key, display label, catalog order, and the cohort ids that belong to it.
 * Membership is the feature id's first dot-segment — the site's own invariant (scripts/validate.ts
 * refuses a prefix that is not a categories.json key) — and categories.json is the ONE owner of the
 * label and order. The partition is checked, not trusted: an unknown prefix throws rather than
 * silently dropping a capability from every category denominator.
 */
export interface CohortCategory {
  key: string
  label: string
  order: number
  ids: string[]
}

/** Partition a cohort's measured ids into their categories, returned in categories.json order. */
export function cohortCategories(
  measuredIds: readonly string[],
  categories: Record<string, CategoryMeta>,
): CohortCategory[] {
  const byKey = new Map<string, string[]>()
  for (const id of measuredIds) {
    const key = id.split(".")[0] ?? ""
    const meta = categories[key]
    if (!meta) {
      throw new Error(`feature id "${id}" has prefix "${key}", which is not a category in categories.json`)
    }
    const list = byKey.get(key)
    if (list) list.push(id)
    else byKey.set(key, [id])
  }
  const grouped = [...byKey.entries()].map(([key, ids]) => ({
    key,
    label: categories[key]?.label ?? key,
    order: categories[key]?.order ?? 0,
    ids,
  }))
  const assigned = grouped.reduce((count, category) => count + category.ids.length, 0)
  if (assigned !== measuredIds.length) {
    throw new Error(`category partition covered ${assigned} ids, not the cohort's ${measuredIds.length}`)
  }
  const order = orderedCategoryIds(Object.fromEntries(grouped.map((category) => [category.key, category])))
  return order.flatMap((key) => grouped.filter((category) => category.key === key))
}

/** One category's decisive share over its own ids, at the same D3 bar as the cohort. */
export interface CategoryShare {
  category: CohortCategory
  share: DecisiveShare
}

/** The per-category decisive shares of a run's cells, one per category, in catalog order. */
export function categoryShares(
  states: Readonly<Record<string, CellState>>,
  categories: readonly CohortCategory[],
): CategoryShare[] {
  return categories.map((category) => ({ category, share: decisiveShare(states, category.ids) }))
}

/**
 * The block header printed under each measured context's aggregate lines. It states the basis ONCE
 * (@cto 2026-10-10T15:49Z): the denominator of every fraction here is the cohort ids with a probe in
 * the required suite; the ids without one are named beside each affected row, never inside a
 * denominator, so no reader has to guess what the numbers are divided by.
 */
export function categoryBlockHeader(
  ratifiedCount: number,
  decidableCount: number,
  suiteId: string,
  libraryOnlyCount = 0,
): string {
  const libraryOnly =
    libraryOnlyCount === 0
      ? ""
      : `; ${libraryOnlyCount} ${libraryOnlyCount === 1 ? "row is" : "rows are"} library-only and not scored in apps`
  return (
    `CATEGORIES OF THE ${ratifiedCount} — n = ${decidableCount} cohort ids with a probe in required suite ` +
    `${suiteId} and app-observable${libraryOnly}; unavailable listed beside — ` +
    `D3 bar per category: >=90% pass, >=70% with gaps, else fail`
  )
}

/**
 * One category line — the fraction beside the label, the D3 label (not the full verdict text, so the
 * fraction is not printed a third time) — plus its named remainder, indented beneath.
 */
export function formatCategoryRow(
  category: CohortCategory,
  share: DecisiveShare,
  labelWidth: number,
  unavailableIds: readonly string[] = [],
  libraryOnlyIds: readonly string[] = [],
): string[] {
  if (share.denominator !== category.ids.length) {
    throw new Error(
      `category ${category.key} share denominator ${share.denominator} does not match its ${category.ids.length} cohort ids`,
    )
  }
  const beside = [
    ...(unavailableIds.length ? [`unavailable: ${unavailableIds.join(", ")}`] : []),
    ...(libraryOnlyIds.length ? [`library-only: ${libraryOnlyIds.join(", ")}`] : []),
  ]
  return [
    `    ${category.label.padEnd(labelWidth)}  ${share.decisive}/${share.denominator} = ${share.decisivePct}% · ${share.verdict.label}${beside.length ? `   (${beside.join("; ")})` : ""}`,
    inconclusiveLine(share.inconclusiveIds, "      "),
    remainderLine(share.remainder, "      "),
  ]
}

/**
 * Every printed line for one candidate-2 bar row: the aggregate decisive/inconclusive lines and the
 * whole-cohort remainder, then — only for a MEASURED context — the per-category block. A context with
 * no selected run (or a run on the wrong suite) prints its reason and NO category lines, because there
 * is no run to measure.
 */
export function formatCohortRow(
  row: CohortBarRow,
  categories: readonly CohortCategory[],
  labelWidth: number,
  unavailableIds: readonly string[] = [],
  libraryOnlyIds: readonly string[] = [],
): string[] {
  const lines = [`${row.context.terminalId}/${row.context.os}`]
  if ("run" in row) {
    lines.push(`  run ${row.run.runId} · suite ${row.run.suiteId} · selected by ${row.selection} · ${row.run.key}`)
  }
  if (!row.measured) {
    lines.push(`  not measured — ${row.reason}`)
    return lines
  }
  // The ratified cohort is the operator's list; the fraction divides over the app-observable rows, so
  // the header states the ratified size and the moved rows are named and counted, never dropped silently.
  const ratifiedCount = row.share.denominator + libraryOnlyIds.length
  const beside = [
    ...(unavailableIds.length ? [`unavailable: ${unavailableIds.join(", ")}`] : []),
    ...(libraryOnlyIds.length ? [`library-only: ${libraryOnlyIds.join(", ")}`] : []),
  ]
  const decidableCount = categories.reduce((count, category) => count + category.ids.length, 0)
  lines.push(
    `  decisive/${row.share.denominator} ${row.share.decisive}/${row.share.denominator} = ${row.share.decisivePct}% · verdict ${row.share.verdict.text}${beside.length ? `   (${beside.join("; ")})` : ""}`,
    `  inconclusive/${row.share.denominator} ${row.share.inconclusive}/${row.share.denominator} = ${row.share.inconclusivePct}%`,
    inconclusiveLine(row.share.inconclusiveIds),
    remainderLine(row.share.remainder),
    `  ${categoryBlockHeader(ratifiedCount, decidableCount, row.run.suiteId, libraryOnlyIds.length)}`,
  )
  for (const { category, share } of categoryShares(row.run.states, categories)) {
    const categoryUnavailable = unavailableIds.filter((id) => (id.split(".")[0] ?? "") === category.key)
    const categoryLibraryOnly = libraryOnlyIds.filter((id) => (id.split(".")[0] ?? "") === category.key)
    lines.push(...formatCategoryRow(category, share, labelWidth, categoryUnavailable, categoryLibraryOnly))
    if (category.key === "scrollback" && categoryLibraryOnly.length > 0) {
      // Group acceptance includes the defined library-only rows; the app projection above does not.
      // Both bases read the same classified table through the existing aggregation.
      const acceptance = decisiveShare(row.run.states, [...category.ids, ...categoryLibraryOnly])
      const inconclusive = `${acceptance.inconclusive} inconclusive${
        acceptance.inconclusiveIds.length ? `: ${acceptance.inconclusiveIds.join(", ")}` : ""
      }`
      lines.push(
        `      Scrollback acceptance ${acceptance.decisive}/${acceptance.denominator} = ${acceptance.decisivePct}% · ${acceptance.verdict.label} (${inconclusive}; group stays open below ${D3_VERDICT_BAR.passPct}%)`,
      )
    }
  }
  return lines
}

function remainderLine(remainder: readonly RemainderRow[], indent = "    "): string {
  if (remainder.length === 0) return `${indent}remainder    0 rows`
  const named = remainder.map((entry) => `${entry.featureId} (${entry.bucket})`).join(", ")
  return `${indent}remainder    ${remainder.length} rows: ${named}`
}

function inconclusiveLine(ids: readonly string[], indent = "    "): string {
  if (ids.length === 0) return `${indent}inconclusive    0 rows`
  return `${indent}inconclusive    ${ids.length} rows: ${ids.join(", ")}`
}

export function formatBarRow(row: BarRow): string[] {
  const label = `${row.context.terminalId}/${row.context.os || "os not recorded"}`
  if (!row.measured) return [label, `  ${row.reason}`]
  const { tier62, tier52 } = row.shares
  const lines = [
    `${label} ${row.run.version || "version not recorded"}`,
    `  run ${row.run.runId} · measured ${row.run.measuredAt} · suite ${row.run.suiteId} · ${row.run.suiteFreshness}`,
  ]
  if (row.selection !== "only current") {
    lines.push(`  selected by the ${row.selection} · ${row.run.key}`)
  }
  lines.push(
    `    decisive/52     ${tier52.decisive}/${tier52.denominator} = ${tier52.decisivePct}%  (pass >= ${D3_VERDICT_BAR.passPct}%)`,
    `    inconclusive/52 ${tier52.inconclusive}/${tier52.denominator} = ${tier52.inconclusivePct}%`,
    inconclusiveLine(tier52.inconclusiveIds),
    remainderLine(tier52.remainder),
    `    verdict         ${tier52.verdict.text}  (${tier52.decisivePct}% decisive of the included ${tier52.denominator})`,
    `    context/62      decisive ${tier62.decisive}/${tier62.denominator} = ${tier62.decisivePct}%, inconclusive ${tier62.inconclusive}/${tier62.denominator} = ${tier62.inconclusivePct}%  (context only, not the verdict)`,
  )
  return lines
}

export function formatAdmittedRun(run: ContextCandidate, shares: ContextShares): string {
  return (
    `${run.terminalId} ${run.version || "version not recorded"} ${run.os || "os not recorded"} ${run.runId} ` +
    `suite ${run.suiteId} · ` +
    `decisive/62 ${shares.tier62.decisive}/${shares.tier62.denominator} = ${shares.tier62.decisivePct}% · ` +
    `decisive/52 ${shares.tier52.decisive}/${shares.tier52.denominator} = ${shares.tier52.decisivePct}%`
  )
}

/** One refused run: the same identity columns as an admitted row, then the gate's own reason. */
export function formatRefusedRun(run: ContextCandidate, reason: string): string {
  return (
    `${run.terminalId} ${run.version || "version not recorded"} ${run.os || "os not recorded"} ${run.runId} · ` +
    `suite ${run.suiteId} · excluded: ${reason}`
  )
}

/**
 * The refusals as their own section. A run document the site refuses is never folded into the admitted
 * list, and the section is never omitted when it is empty: "none" tells a reader the site refused
 * nothing, which an absent section cannot.
 */
export function refusedRunsSection(runs: readonly RefusedRun[]): string[] {
  const lines = [
    "SITE-EXCLUDED RUNS — every app run this reader measures that the site REFUSES, with the admission gate's own reason",
  ]
  if (runs.length === 0) {
    // Scoped, like the heading: this list covers the app runs this reader measures, so it must not
    // claim the site admitted EVERY document it read — the projection refuses plenty this reader
    // never names.
    lines.push("  none — no app run this reader measures is refused")
    return lines
  }
  for (const entry of runs) lines.push(`  ${formatRefusedRun(entry.run, entry.reason)}`)
  return lines
}

export function parseReaderArgs(args: string[]): {
  cohort: ReaderCohort
  terminalIds: string[]
} {
  const { values, positionals: terminalIds } = parseArgs({
    args,
    strict: true,
    allowPositionals: true,
    options: { cohort: { type: "string", default: "candidate1" } },
  })
  if (values.cohort !== "candidate1" && values.cohort !== "candidate2" && values.cohort !== "candidate4") {
    throw new Error(`Unknown cohort ${values.cohort}; accepted values: candidate1, candidate2, candidate4`)
  }
  return { cohort: values.cohort, terminalIds }
}

/** The cohort a reader run selects; candidate 1 measures no cohort of its own. */
export type ReaderCohort = "candidate1" | FeatureCohortName

/**
 * Every accepted `--cohort` value mapped to its spec factory, candidate 1 included as the absence of
 * one. A record rather than a chain of name comparisons: the key type makes a newly accepted cohort
 * value a compile error until it is given a factory, so no accepted value can fall through to
 * "no cohort" by omission.
 */
export const COHORT_FACTORIES: Readonly<Record<ReaderCohort, ((contentDir: string) => CohortSpec) | undefined>> = {
  candidate1: undefined,
  candidate2: candidate2Cohort,
  candidate4: candidate4Cohort,
}

function main(): void {
  const contentDir = join(import.meta.dirname ?? process.cwd(), "..", "content")
  const { cohort: selectedCohort, terminalIds } = parseReaderArgs(process.argv.slice(2))
  const cohortSpec = COHORT_FACTORIES[selectedCohort]?.(contentDir)
  const report = buildReport({ contentDir, cohort: cohortSpec })
  if (report.cohort) {
    const cohort = report.cohort
    console.log(cohortHeaderLine(cohort))
    console.log(
      `read ${report.searched} through the published selection projection; skipped ${report.legacySkipped} legacy documents; ${report.rejected} rejected`,
    )
    console.log(
      `basis: release: the cohort's ${cohort.measuredIds.length} scored over the ${cohort.scoredIds.length} an app run can decide, an id with no probe in the required suite counts as not decisive and is named, and ${cohort.libraryOnlyIds.length} ${cohort.libraryOnlyIds.length === 1 ? "row is" : "rows are"} library-only and not scored in apps; categories: ids with a probe in the required suite (${cohort.decidableIds.length} of ${cohort.measuredIds.length}), unavailable named beside: ${cohort.unavailableIds.join(", ") || "none"}, library-only named beside: ${cohort.libraryOnlyIds.join(", ") || "none"}`,
    )
    const categories = cohortCategories(cohort.decidableIds, loadCategories(contentDir))
    const labelWidth = Math.max(...categories.map((category) => category.label.length))
    console.log("BAR ROWS — the site's selected run per Release 1 (terminal, os) context")
    for (const row of cohort.barRows.filter(
      (row) => !terminalIds.length || terminalIds.includes(row.context.terminalId),
    )) {
      for (const line of formatCohortRow(row, categories, labelWidth, cohort.unavailableIds, cohort.libraryOnlyIds)) {
        console.log(line)
      }
    }
    console.log(`ADMITTED RUNS — every schema-v2 app run the site admits in ${report.searched}`)
    for (const row of cohort.admittedRuns) {
      console.log(
        `  ${row.run.terminalId} ${row.run.version} ${row.run.os} ${row.run.runId} · suite ${row.run.suiteId} · ` +
          (row.measured
            ? `decisive/${cohort.scoredIds.length} ${row.share.decisive}/${row.share.denominator} = ${row.share.decisivePct}% · verdict ${row.share.verdict.text}`
            : row.reason),
      )
    }
    for (const line of refusedRunsSection(cohort.refusedRuns)) console.log(line)
    return
  }
  const contexts = terminalIds.length
    ? report.barRows.filter((row) => terminalIds.includes(row.context.terminalId))
    : report.barRows

  console.log(
    `Release 1 decisive-count reader · tier-1 rows: ${report.tier62Ids.length} declared / ` +
      `${report.tier52Ids.length} included (62 minus the ten 27832 F2 movers) · verdict ON THE INCLUDED 52: ` +
      `>=${D3_VERDICT_BAR.passPct}% decisive = pass, >=${D3_VERDICT_BAR.gapsPct}% = with gaps, else fail`,
  )
  console.log(
    `read ${report.searched} through the published selection projection (docs/data/current-results.ts); ` +
      `skipped ${report.legacySkipped} schema-v1 legacy documents (unverified callback results); ` +
      `${report.rejected} run documents rejected by that projection`,
  )
  console.log(namedExceptionsLine())
  console.log("")
  console.log(`BAR ROWS — the site's selected run per Release 1 (terminal, os) context`)
  for (const row of contexts) {
    for (const line of formatBarRow(row)) console.log(line)
    console.log("")
  }
  console.log(`ADMITTED RUNS — every schema-v2 app run the site admits in ${report.searched}`)
  for (const run of report.admittedRuns) {
    console.log(
      `  ${formatAdmittedRun(run, {
        tier62: decisiveShare(run.states, report.tier62Ids),
        tier52: decisiveShare(run.states, report.tier52Ids),
      })}`,
    )
  }
  for (const line of refusedRunsSection(report.refusedRuns)) console.log(line)
}

if (import.meta.main) main()
