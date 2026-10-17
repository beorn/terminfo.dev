/**
 * VitePress build-time data loader for the terminfo v0.1 candidate 2 preview page.
 *
 * This page is its own surface for ONE reason: the published matrix keeps its Release-1 tier-1 scope,
 * so the 125 classics the epic (bead 28018) lists need a page that can claim them WITHOUT moving the
 * frozen probe suite or touching the D3 bar. Both scopes are labels in the catalog now (item 3): the
 * tier-1 rows carry a `tier1` field, and the classics are the rows whose category slice is `classics`.
 *
 * It re-derives nothing. The numbers come from the ONE reader (`scripts/decisive-share.ts`
 * `buildReport`), which resolves the ONE selection (`docs/data/current-results.ts`) — so this page and
 * `bun run decisive-share --cohort candidate2` can never print two different shares for one run. The
 * two bases the reader keeps apart are kept apart here too:
 *
 *  - the RATIFIED base (125 ids) is what the page CLAIMS: the included capability list, group by group;
 *  - the DECIDABLE base (the ids with a probe in the required suite, 121 in 9 groups) is every printed
 *    fraction's denominator, and the rows outside it — the library-only rows and the ids the suite
 *    does not cover — are named beside their group, never scored.
 *
 * The publication rule is the epic's AC4, enforced here rather than trusted: a context row is PUBLISHED
 * only when its selected run sits on the candidate-2 frozen suite. A run on any other suite keeps the
 * reader's own refusal reason and renders as named-ineligible — no share, no fraction. A page that
 * printed one would be publishing a row on an older suite.
 */
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { loadFeatures } from "@terminfo/catalog"
import { loadCategories } from "./categories.ts"
import { D3_VERDICT_BAR, type D3Label } from "./release-scope.ts"
import {
  buildReport,
  candidate2Cohort,
  categoryShares,
  cohortCategories,
  decisiveShare,
  inconclusiveRows,
  type CohortBarRow,
  type InconclusiveRow,
  type RemainderRow,
} from "../../scripts/decisive-share.ts"

const __dirname = dirname(fileURLToPath(import.meta.url))
const contentDir = join(__dirname, "..", "..", "content")

export interface Candidate2Capability {
  id: string
  name: string
}

/** One of the 9 groups: what it INCLUDES, and the rows of it no app run can decide. */
export interface Candidate2Group {
  key: string
  label: string
  order: number
  /**
   * True only when EVERY context with a published run clears the group's pass bar. The page may not
   * claim a group globally included while a measured context sits below the bar (@chief cf1daa5a).
   */
  included: boolean
  /** The measured contexts that keep this group out of the included set, in page order. */
  heldBy: Candidate2HeldContext[]
  /** Every included capability of this group (the ratified base). */
  capabilities: Candidate2Capability[]
  /** How many of them every fraction below divides over — the decidable base. */
  denominator: number
  /** Included, decided by the parser surface only: named beside the fraction, never scored. */
  libraryOnly: Candidate2Capability[]
  /** Included, with no probe in the frozen suite at all: named beside the fraction, never scored. */
  unavailable: Candidate2Capability[]
}

/** One measured context that is below a group's pass bar, with the fraction that says so. */
export interface Candidate2HeldContext {
  context: string
  decisive: number
  denominator: number
  decisivePct: number
  verdictLabel: D3Label
}

/**
 * A group's ACCEPTANCE share: the ruled base for the group, which counts its defined library-only
 * rows alongside the app-observable ones. Null for a group with no library-only rows, whose acceptance
 * base and decidable base are the same list.
 */
export interface Candidate2Acceptance {
  decisive: number
  denominator: number
  decisivePct: number
  verdictLabel: D3Label
  inconclusive: InconclusiveRow[]
}

/** One group's decisive share inside one PUBLISHED context row. */
export interface Candidate2GroupShare {
  key: string
  decisive: number
  denominator: number
  decisivePct: number
  verdictLabel: D3Label
  inconclusive: InconclusiveRow[]
  /** The group's ruled acceptance share, where it differs from the app-observable fraction above. */
  acceptance: Candidate2Acceptance | null
}

export interface Candidate2ContextRow {
  context: string
  terminalId: string
  os: string
  /** True only when the selected run is on the candidate-2 frozen suite (AC4). */
  published: boolean
  /** The reader's own reason, verbatim, when the row is not published. */
  reason: string | null
  runId: string | null
  suiteId: string | null
  measuredAt: string | null
  selection: string | null
  decisive: number
  denominator: number
  decisivePct: number
  verdictText: string | null
  verdictLabel: D3Label | null
  inconclusive: InconclusiveRow[]
  remainder: RemainderRow[]
  groups: Candidate2GroupShare[]
}

export interface Candidate2Data {
  name: string
  frozenSuiteId: string
  /** The ratified base: every capability this page claims as included. */
  ratifiedCount: number
  /** The app-decidable base: the denominator of every per-context total. */
  scoredCount: number
  /** The suite-covered base: the denominator of every per-group fraction. */
  decidableCount: number
  /** Newest measurement among the published rows, ISO 8601, or empty when nothing is published. */
  measuredAt: string
  libraryOnly: Candidate2Capability[]
  unavailable: Candidate2Capability[]
  groups: Candidate2Group[]
  contexts: Candidate2ContextRow[]
}

/**
 * Feature display names, from the same catalog the declarations are validated against. The catalog
 * loader refuses a nameless entry before this page ever runs, so a row can never be labelled with its
 * own id through a quiet fallback: every cohort id is a catalog row by construction
 * (`cohortIds` filters the catalog itself).
 */
function loadCatalogNames(): Record<string, string> {
  const names: Record<string, string> = {}
  for (const [id, entry] of Object.entries(loadFeatures(contentDir))) names[id] = entry.name
  return names
}

/**
 * A feature's group is its first dot-segment — the site's own invariant (`scripts/validate.ts` refuses
 * a prefix that is not a `categories.json` key), and the rule `cohortCategories` groups by. Read from
 * the SAME owner rather than re-derived, so a named row can never be looked up under another group.
 */
function groupKey(id: string, known: ReadonlySet<string>): string {
  const key = id.split(".")[0] ?? ""
  if (!known.has(key)) {
    throw new Error(`feature id "${id}" has prefix "${key}", which is not a category in categories.json`)
  }
  return key
}

export function loadCandidate2Data(): Candidate2Data {
  const report = buildReport({ contentDir, cohort: candidate2Cohort(contentDir) })
  const cohort = report.cohort
  if (!cohort) throw new Error("candidate-2 report carried no cohort; the page has nothing to claim")
  const names = loadCatalogNames()
  const catalog = loadCategories(contentDir)
  const known = new Set(Object.keys(catalog))
  const capability = (id: string): Candidate2Capability => ({ id, name: names[id] ?? id })

  // The reader's own two groupings, never a third: the included list is grouped from the ratified
  // base, the fractions from the decidable base. Both throw on an ungroupable id rather than drop it.
  const included = cohortCategories(cohort.measuredIds, catalog)
  const decidable = cohortCategories(cohort.decidableIds, catalog)
  const decidableByKey = new Map(decidable.map((category) => [category.key, category]))
  const includedByKey = new Map(included.map((category) => [category.key, category]))
  const libraryOnly = new Set(cohort.libraryOnlyIds)
  const unavailable = new Set(cohort.unavailableIds)

  const groups: Omit<Candidate2Group, "included" | "heldBy">[] = included.map((category) => {
    const scored = decidableByKey.get(category.key)
    if (!scored) throw new Error(`group ${category.key} is included but has no decidable rows; the two bases disagree`)
    return {
      key: category.key,
      label: category.label,
      order: category.order,
      capabilities: category.ids.map(capability),
      denominator: scored.ids.length,
      libraryOnly: category.ids.filter((id) => libraryOnly.has(id)).map(capability),
      unavailable: category.ids.filter((id) => unavailable.has(id)).map(capability),
    }
  })
  const scoredTotal = decidable.reduce((count, category) => count + category.ids.length, 0)
  if (scoredTotal !== cohort.decidableIds.length) {
    throw new Error(`decidable groups cover ${scoredTotal} ids, not the cohort's ${cohort.decidableIds.length}`)
  }
  const includedTotal = included.reduce((count, category) => count + category.ids.length, 0)
  if (includedTotal !== cohort.measuredIds.length) {
    throw new Error(`included groups cover ${includedTotal} ids, not the cohort's ${cohort.measuredIds.length}`)
  }

  const contexts: Candidate2ContextRow[] = cohort.barRows.map((row: CohortBarRow) => {
    const base = {
      context: `${row.context.terminalId}/${row.context.os}`,
      terminalId: row.context.terminalId,
      os: row.context.os,
    }
    if (!row.measured) {
      // The reader's refusal, verbatim: an ineligible suite, an ambiguous selection, or no selected run.
      return {
        ...base,
        published: false,
        reason: row.reason,
        runId: null,
        suiteId: null,
        measuredAt: null,
        selection: null,
        decisive: 0,
        denominator: 0,
        decisivePct: 0,
        verdictText: null,
        verdictLabel: null,
        inconclusive: [],
        remainder: [],
        groups: [],
      }
    }
    const { share } = row
    return {
      ...base,
      published: true,
      reason: null,
      runId: row.run.runId,
      suiteId: row.run.suiteId,
      measuredAt: row.run.measuredAt,
      selection: row.selection,
      decisive: share.decisive,
      denominator: share.denominator,
      decisivePct: share.decisivePct,
      verdictText: share.verdict.text,
      verdictLabel: share.verdict.label,
      inconclusive: inconclusiveRows(row.run.cells, share),
      remainder: share.remainder,
      groups: categoryShares(row.run.states, decidable).map(({ category, share: groupShare }) => {
        // The acceptance base is the reader's own: the category's decidable rows plus its defined
        // library-only rows, aggregated by the same classifier. No second share is invented here.
        const libraryOnlyIds = (includedByKey.get(category.key)?.ids ?? []).filter((id) => libraryOnly.has(id))
        const acceptance =
          libraryOnlyIds.length > 0 ? decisiveShare(row.run.states, [...category.ids, ...libraryOnlyIds]) : null
        return {
          key: category.key,
          decisive: groupShare.decisive,
          denominator: groupShare.denominator,
          decisivePct: groupShare.decisivePct,
          verdictLabel: groupShare.verdict.label,
          inconclusive: inconclusiveRows(row.run.cells, groupShare),
          acceptance: acceptance
            ? {
                decisive: acceptance.decisive,
                denominator: acceptance.denominator,
                decisivePct: acceptance.decisivePct,
                verdictLabel: acceptance.verdict.label,
                inconclusive: inconclusiveRows(row.run.cells, acceptance),
              }
            : null,
        }
      }),
    }
  })

  const measuredAt =
    contexts
      .flatMap((row) => (row.measuredAt === null ? [] : [row.measuredAt]))
      .sort()
      .at(-1) ?? ""

  // Every id of both named lists must sit in a group the page prints, or the disclosure is a lie.
  for (const id of [...libraryOnly, ...unavailable]) {
    const key = groupKey(id, known)
    const group = groups.find((entry) => entry.key === key)
    if (!group) throw new Error(`named row ${id} belongs to group ${key}, which this page does not print`)
    if (!group.capabilities.some((entry) => entry.id === id)) {
      throw new Error(`named row ${id} is not in its group's included list; it would be named but never shown`)
    }
  }

  // Inclusion is MEASURED per group, never claimed page-wide: a group is included only when every
  // context we actually measured clears its pass bar, and the contexts that do not are named. A
  // context with no published run cannot hold a group, and cannot accept one either.
  const groupsWithState: Candidate2Group[] = groups.map((group) => {
    const heldBy: Candidate2HeldContext[] = []
    let measuredContexts = 0
    for (const row of contexts) {
      if (!row.published) continue
      const share = row.groups.find((entry) => entry.key === group.key)
      if (!share) {
        // Fail loud: every included group has a decidable category, so every published row must
        // carry its share. Skipping one would judge "included" without checking an eligible row.
        throw new Error(`published context ${row.context} carries no ${group.key} share; inclusion cannot skip it`)
      }
      measuredContexts++
      // The bar is the group's RULED basis: where the reader carries an acceptance share (the
      // decidable rows plus the group's defined library-only rows), that is the denominator the
      // group is accepted over. The app-observable fraction is narrower and can read 100% while
      // the acceptance basis sits below the bar (@dev/review2 023f208b).
      const basis = share.acceptance ?? share
      if (basis.decisivePct < D3_VERDICT_BAR.passPct) {
        heldBy.push({
          context: row.context,
          decisive: basis.decisive,
          denominator: basis.denominator,
          decisivePct: basis.decisivePct,
          verdictLabel: basis.verdictLabel,
        })
      }
    }
    return { ...group, included: measuredContexts > 0 && heldBy.length === 0, heldBy }
  })

  return {
    name: cohort.name,
    frozenSuiteId: cohort.frozenSuiteId,
    ratifiedCount: cohort.measuredIds.length,
    scoredCount: cohort.scoredIds.length,
    decidableCount: cohort.decidableIds.length,
    measuredAt,
    libraryOnly: cohort.libraryOnlyIds.map(capability),
    unavailable: cohort.unavailableIds.map(capability),
    groups: groupsWithState,
    contexts,
  }
}

export default {
  load(): Candidate2Data {
    return loadCandidate2Data()
  },
}

declare const data: Candidate2Data
export { data }
