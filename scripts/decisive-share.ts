#!/usr/bin/env bun
/**
 * Release 1 decisive-count reader (#27909) — the instrument behind the Release 1 bar.
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
 *  2. ADMITTED RUNS — one line per admitted schema-v2 run under content/probes-apps, labelled
 *     `<terminal id> <version> <os> <runId>` with decisive/62 and decisive/52, so the Release 1 Linux
 *     runs and any admitted-but-unselected run stay visible by run id without polluting the bar rows.
 *
 * It never touches content/terminals.json, collectors/probe-defs, the launcher, or any admitted run
 * document. It writes nothing. Bucket math is barOverMeasured's, not a second copy.
 *
 * Usage: bun scripts/decisive-share.ts [--cohort candidate1|candidate2] [terminal-id ...]
 * Candidate 1 is the default. Candidate 2 keeps all 125 classics on frozen suite a8bafe49cdd4.
 * When live selection moves past it, bar rows are ineligible: selected run on suite X, required
 * a8bafe49cdd4. The 125 verdict then lives only in admitted history for suite-H runs.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { parseArgs } from "node:util"
import { parseJsonStrict, parseSuiteManifest } from "@terminfo/run-parser"
import { splitDecidableBasis } from "@terminfo/probe-defs"
import {
  loadCurrentResults,
  loadDefaultContextPolicy,
  type DefaultContextReview,
} from "../docs/data/current-results.ts"
import { loadReleaseScope, loadFeatureCohort, type FeatureCohort } from "../docs/data/load-release-scope.ts"
import { loadCategories, type CategoryMeta } from "../docs/data/categories.ts"
import {
  barOverMeasured,
  d3Verdict,
  D3_VERDICT_BAR,
  F2_MOVERS,
  INCLUDED_TIER1_COUNT,
  includedTierOneIds,
  isStaleRelation,
  type D3Verdict,
  type SuiteRelation,
} from "../docs/data/release-scope.ts"

// The included-52 set and the D3 verdict rule are ONE owner, in docs/data/release-scope.ts, so the
// site's label and this reader's verdict can never be two copies. Re-exported for the reader's callers.
export { F2_MOVERS, INCLUDED_TIER1_COUNT, includedTierOneIds }
import type { SelectedVersion } from "../docs/data/selected-results.ts"

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
  remainder: RemainderRow[]
  verdict: D3Verdict
}

/** Minimal cell view barOverMeasured consumes; SelectedCell satisfies it structurally. */
export type ShareCells = Record<string, { outcome: string; conclusive?: boolean }>

function sharePct(count: number, denominator: number): number {
  return denominator === 0 ? 0 : Math.round((count / denominator) * 100)
}

/**
 * Reduce one cell map to the three buckets over the given tier-1 ids. Counts come from
 * barOverMeasured; the remainder names are a filter of the same cells, cross-checked against the
 * bar's own error+untested totals so the two can never drift apart silently.
 */
export function decisiveShare(cells: ShareCells, measuredIds: readonly string[]): DecisiveShare {
  const bar = barOverMeasured(cells, measuredIds)
  const remainder: RemainderRow[] = []
  for (const id of measuredIds) {
    const cell = cells[id]
    if (!cell) remainder.push({ featureId: id, bucket: "untested" })
    else if (cell.outcome === "error") remainder.push({ featureId: id, bucket: "error" })
  }
  if (remainder.length !== bar.errors + bar.untested) {
    throw new Error(
      `decisive-share remainder ${remainder.length} disagrees with barOverMeasured errors+untested ` +
        `${bar.errors + bar.untested} over ${measuredIds.length} rows`,
    )
  }
  const decisivePct = sharePct(bar.conclusive, bar.denominator)
  const inconclusivePct = sharePct(bar.inconclusive, bar.denominator)
  return {
    denominator: bar.denominator,
    decisive: bar.conclusive,
    decisivePct,
    inconclusive: bar.inconclusive,
    inconclusivePct,
    remainder,
    verdict: d3Verdict(bar.conclusive, bar.denominator),
  }
}

/** The declared 62 tier-1 ids, validated against the feature catalog by the declaration's owner. */
export function tierOneIds(contentDir: string): string[] {
  const catalog = featureCatalog(contentDir)
  return loadReleaseScope({ catalog, declarationPath: join(contentDir, "release-scope.json") }).measuredIds
}

function featureCatalog(contentDir: string): Record<string, { name: string }> {
  const featuresPath = join(contentDir, "features.json")
  const raw = parseJsonStrict(featuresPath, readFileSync(featuresPath, "utf8"))
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`${featuresPath}: expected a feature catalog object`)
  }
  const catalog: Record<string, { name: string }> = {}
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (id.startsWith("$")) continue
    const declared = typeof value === "object" && value !== null ? (value as { name?: unknown }).name : value
    catalog[id] = { name: typeof declared === "string" && declared ? declared : id }
  }
  return catalog
}

/** One candidate context the site currently selects, reduced to what the reader consumes. */
export interface ContextCandidate {
  key: string
  kind: string
  terminalId: string
  os: string
  permissions: string | null
  runId: string
  version: string
  measuredAt: string
  suiteId: string
  suiteFreshness: string
  suiteRelation: SuiteRelation
  cells: ShareCells
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

/** How the one run for a context was chosen, printed with the row so the choice is auditable. */
export type RunSelection = "only current" | "reviewed default-context row" | "default profile"

export type PickedContextRun = { run: ContextCandidate; selection: RunSelection } | { ambiguous: string[] }

/**
 * Choose the one run the site selects for a (terminal id, os) context. The site's own selection keys by
 * terminal id, not by id+os, so a context can carry several current entries: kitty/linux has the
 * default and two clipboard-override profiles, and xterm/linux carries one entry per frozen-runner
 * store path. The site resolves such a tie by the reviewed `default-contexts.json` row
 * (`compatibilityTargets`), and so does this reader.
 *
 * The bar keys rows by terminal id + os while the review is keyed by terminal id alone, so a review
 * is a tie-break ONLY for the group whose context it names — `app:kitty` names the macOS context, and
 * kitty/linux must still resolve on its own. A review that names no candidate of this group is
 * therefore not this group's tie-break and the fallbacks below apply; the single permissions-free
 * entry is the row, and anything still ambiguous is reported with its contexts, never guessed.
 *
 * The fallbacks consider only CURRENT-suite candidates whenever any are present: the bar reports a
 * run's decisive share on the current suite, so an older-suite entry can never be the measured row,
 * and letting it tie up the choice reports a false ambiguity (kitty/linux: one stale permissions-free
 * entry beside the current one and a current clipboard override, which read "ambiguous" until this
 * rule). With no current-suite candidate the fallbacks are unchanged, and a review still names any
 * candidate it likes — this rule is the tie-break of last resort, not a filter on the review.
 */
export function pickContextRun(
  candidates: readonly ContextCandidate[],
  reviewed?: DefaultContextReview,
): PickedContextRun | undefined {
  if (candidates.length === 0) return undefined
  if (reviewed !== undefined) {
    const chosen = candidates.find((candidate) => candidate.key === reviewed.contextKey)
    if (chosen) return { run: chosen, selection: "reviewed default-context row" }
  }
  const current = candidates.filter((candidate) => !isStaleRelation(candidate.suiteRelation))
  const considered = current.length > 0 ? current : candidates
  const [only] = considered
  if (considered.length === 1 && only) return { run: only, selection: "only current" }
  const defaults = considered.filter((candidate) => candidate.permissions === null)
  const [onlyDefault] = defaults
  if (defaults.length === 1 && onlyDefault) return { run: onlyDefault, selection: "default profile" }
  return { ambiguous: considered.map((candidate) => candidate.key) }
}

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
      tier62: decisiveShare(picked.run.cells, args.tier62Ids),
      tier52: decisiveShare(picked.run.cells, args.tier52Ids),
    },
  }
}

function candidateFromSelected(key: string, selected: SelectedVersion): ContextCandidate {
  return {
    key,
    kind: selected.target.kind,
    terminalId: selected.target.id,
    os: selected.target.os ?? "",
    permissions: selected.target.permissions ?? null,
    runId: selected.runId,
    version: selected.target.version ?? "",
    measuredAt: selected.measuredAt,
    suiteId: selected.suiteId,
    suiteFreshness: selected.suiteFreshness,
    suiteRelation: selected.suiteRelation,
    cells: selected.cells,
  }
}

export interface Report {
  tier62Ids: string[]
  tier52Ids: string[]
  barRows: BarRow[]
  admittedRuns: ContextCandidate[]
  legacySkipped: number
  rejected: number
  searched: string
  candidate2?: ScorableCohort & {
    decidableIds: string[]
    unavailableIds: string[]
    barRows: CohortBarRow[]
    admittedRuns: CohortRun[]
  }
}

/**
 * The cohort reduced to what a decisive share is scored over: the ratified `measuredIds` (which stay
 * the full 125, pinned by SHA in the reader's test) AND the decidable basis `splitDecidableBasis`
 * derives from the required suite's schedule. The share divides over `decidableIds`; the ids the
 * schedule does not cover are named beside the fraction, never inside a denominator.
 */
export type ScorableCohort = FeatureCohort & { readonly decidableIds: readonly string[] }

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
  // The RELEASE line is the operator's D3 bar over the ratified cohort (`measuredIds`, the 125): an id
  // leaves the 125 only on an operator ruling, and an id with no probe in the required suite counts as
  // NOT decisive there and is named beside the fraction — the gap is in the suite, not in the cohort
  // (@cto 2026-10-10T15:59Z). Only the per-category block divides over the decidable basis.
  return { run, measured: true, share: decisiveShare(run.cells, cohort.measuredIds) }
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
  cohort?: "candidate1" | "candidate2"
}): Report {
  let cohort: ScorableCohort | undefined
  let unavailableIds: string[] = []
  if (args.cohort === "candidate2") {
    const declared = loadFeatureCohort({
      catalog: featureCatalog(args.contentDir),
      declarationPath: join(args.contentDir, "release-scope-candidate2.json"),
    })
    const manifestPath = join(args.contentDir, "suites", `${declared.frozenSuiteId}.json`)
    const manifest = parseSuiteManifest(manifestPath, readFileSync(manifestPath, "utf8"))
    if (manifest.probeHash !== declared.frozenSuiteId) {
      throw new Error(
        `${manifestPath}: probeHash ${manifest.probeHash} does not match required ${declared.frozenSuiteId}`,
      )
    }
    // ONE basis, one owner: the required schedule is the source of availability, and the ids it does
    // not cover are carried as `unavailableIds` (named beside the fraction, never in a denominator).
    const basis = splitDecidableBasis(declared.measuredIds, manifest.probes.app)
    unavailableIds = [...basis.unavailableIds]
    cohort = { ...declared, decidableIds: basis.decidableIds }
  }
  const projection = loadCurrentResults(args.contentDir).projection
  const current = Object.entries(projection.current).map(([key, selected]) => candidateFromSelected(key, selected))
  const reviewed = loadDefaultContextPolicy(args.contentDir)
  const admitted: ContextCandidate[] = []
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
      const candidate = candidateFromSelected(key, selected)
      admitted.push(candidate)
    }
  }
  admitted.sort(
    (left, right) =>
      left.terminalId.localeCompare(right.terminalId) ||
      left.os.localeCompare(right.os) ||
      right.measuredAt.localeCompare(left.measuredAt) ||
      left.runId.localeCompare(right.runId),
  )
  const tier62Ids = tierOneIds(args.contentDir)
  const tier52Ids = includedTierOneIds(tier62Ids)
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
    legacySkipped,
    rejected: projection.exclusions.length,
    searched: join(args.contentDir, "probes-apps"),
  }
  if (cohort) {
    report.candidate2 = {
      ...cohort,
      decidableIds: [...cohort.decidableIds],
      unavailableIds,
      barRows: barRows.map((row) => cohortRowForSelected(row, cohort)),
      admittedRuns: admitted.map((run) => cohortRun(run, cohort, "admitted")),
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
  grouped.sort((left, right) => left.order - right.order)
  return grouped
}

/** One category's decisive share over its own ids, at the same D3 bar as the cohort. */
export interface CategoryShare {
  category: CohortCategory
  share: DecisiveShare
}

/** The per-category decisive shares of a run's cells, one per category, in catalog order. */
export function categoryShares(cells: ShareCells, categories: readonly CohortCategory[]): CategoryShare[] {
  return categories.map((category) => ({ category, share: decisiveShare(cells, category.ids) }))
}

/**
 * The block header printed under each measured context's aggregate lines. It states the basis ONCE
 * (@cto 2026-10-10T15:49Z): the denominator of every fraction here is the cohort ids with a probe in
 * the required suite; the ids without one are named beside each affected row, never inside a
 * denominator, so no reader has to guess what the numbers are divided by.
 */
export function categoryBlockHeader(cohortCount: number, decidableCount: number, suiteId: string): string {
  return (
    `CATEGORIES OF THE ${cohortCount} — n = ${decidableCount} cohort ids with a probe in required suite ` +
    `${suiteId}; unavailable listed beside — D3 bar per category: >=90% pass, >=70% with gaps, else fail`
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
): string[] {
  if (share.denominator !== category.ids.length) {
    throw new Error(
      `category ${category.key} share denominator ${share.denominator} does not match its ${category.ids.length} cohort ids`,
    )
  }
  const unavailable = unavailableIds.length ? `   (unavailable: ${unavailableIds.join(", ")})` : ""
  return [
    `    ${category.label.padEnd(labelWidth)}  ${share.decisive}/${share.denominator} = ${share.decisivePct}% · ${share.verdict.label}${unavailable}`,
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
): string[] {
  const lines = [`${row.context.terminalId}/${row.context.os}`]
  if ("run" in row) {
    lines.push(`  run ${row.run.runId} · suite ${row.run.suiteId} · selected by ${row.selection} · ${row.run.key}`)
  }
  if (!row.measured) {
    lines.push(`  not measured — ${row.reason}`)
    return lines
  }
  const unavailable = unavailableIds.length ? `   (unavailable: ${unavailableIds.join(", ")})` : ""
  const decidableCount = categories.reduce((count, category) => count + category.ids.length, 0)
  lines.push(
    `  decisive/${row.share.denominator} ${row.share.decisive}/${row.share.denominator} = ${row.share.decisivePct}% · verdict ${row.share.verdict.text}${unavailable}`,
    `  inconclusive/${row.share.denominator} ${row.share.inconclusive}/${row.share.denominator} = ${row.share.inconclusivePct}%`,
    remainderLine(row.share.remainder),
    `  ${categoryBlockHeader(row.share.denominator, decidableCount, row.run.suiteId)}`,
  )
  for (const { category, share } of categoryShares(row.run.cells, categories)) {
    const categoryUnavailable = unavailableIds.filter((id) => (id.split(".")[0] ?? "") === category.key)
    lines.push(...formatCategoryRow(category, share, labelWidth, categoryUnavailable))
  }
  return lines
}

function remainderLine(remainder: readonly RemainderRow[], indent = "    "): string {
  if (remainder.length === 0) return `${indent}remainder    0 rows`
  const named = remainder.map((entry) => `${entry.featureId} (${entry.bucket})`).join(", ")
  return `${indent}remainder    ${remainder.length} rows: ${named}`
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

export function parseReaderArgs(args: string[]): { cohort: "candidate1" | "candidate2"; terminalIds: string[] } {
  const { values, positionals: terminalIds } = parseArgs({
    args,
    strict: true,
    allowPositionals: true,
    options: { cohort: { type: "string", default: "candidate1" } },
  })
  if (values.cohort !== "candidate1" && values.cohort !== "candidate2") {
    throw new Error(`Unknown cohort ${values.cohort}; accepted values: candidate1, candidate2`)
  }
  return { cohort: values.cohort, terminalIds }
}

function main(): void {
  const contentDir = join(import.meta.dirname ?? process.cwd(), "..", "content")
  const { cohort: selectedCohort, terminalIds } = parseReaderArgs(process.argv.slice(2))
  const report = buildReport({ contentDir, cohort: selectedCohort })
  if (report.candidate2) {
    const cohort = report.candidate2
    console.log(
      `Candidate 2 classics · ${cohort.measuredIds.length} IDs (${cohort.decidableIds.length} with a probe in required suite ${cohort.frozenSuiteId}) · required suite ${cohort.frozenSuiteId}; ineligible: selected run on suite X, required ${cohort.frozenSuiteId} when live selection moves; only frozen-suite admitted history then receives the cohort verdict`,
    )
    console.log(
      `read ${report.searched} through the published selection projection; skipped ${report.legacySkipped} legacy documents; ${report.rejected} rejected`,
    )
    console.log(
      `basis: release: the operator's ${cohort.measuredIds.length}, an id with no probe in the required suite counts as not decisive and is named; categories: ids with a probe in the required suite (${cohort.decidableIds.length} of ${cohort.measuredIds.length}), unavailable named beside: ${cohort.unavailableIds.join(", ") || "none"}`,
    )
    const categories = cohortCategories(cohort.decidableIds, loadCategories(contentDir))
    const labelWidth = Math.max(...categories.map((category) => category.label.length))
    console.log("BAR ROWS — the site's selected run per Release 1 (terminal, os) context")
    for (const row of cohort.barRows.filter(
      (row) => !terminalIds.length || terminalIds.includes(row.context.terminalId),
    )) {
      for (const line of formatCohortRow(row, categories, labelWidth, cohort.unavailableIds)) console.log(line)
    }
    console.log(`ADMITTED RUNS — every admitted schema-v2 app run in ${report.searched}`)
    for (const row of cohort.admittedRuns) {
      console.log(
        `  ${row.run.terminalId} ${row.run.version} ${row.run.os} ${row.run.runId} · suite ${row.run.suiteId} · ` +
          (row.measured
            ? `decisive/${cohort.measuredIds.length} ${row.share.decisive}/${row.share.denominator} = ${row.share.decisivePct}% · verdict ${row.share.verdict.text}`
            : row.reason),
      )
    }
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
  console.log(`ADMITTED RUNS — every admitted schema-v2 app run in ${report.searched}`)
  for (const run of report.admittedRuns) {
    console.log(
      `  ${formatAdmittedRun(run, {
        tier62: decisiveShare(run.cells, report.tier62Ids),
        tier52: decisiveShare(run.cells, report.tier52Ids),
      })}`,
    )
  }
}

if (import.meta.main) main()
