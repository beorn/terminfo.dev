/**
 * VitePress build-time data loader for the terminfo v0.1 candidate 2 preview page.
 *
 * This page is its own surface for ONE reason: the published matrix keeps its Release-1 tier-1 scope,
 * so the 125 classics the epic (bead 28018) lists need a page that can claim them WITHOUT moving the
 * frozen probe suite or touching the D3 bar. Both scopes are labels in the catalog now (item 3): the
 * tier-1 rows carry a `tier1` field, and the classics are the rows whose category slice is `classics`.
 *
 * It re-derives nothing. The numbers come from the ONE reader (`scripts/decisive-share.ts`
 * `buildHistoricalReport`), which resolves the ONE selection (`docs/data/current-results.ts`) — so this page and
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
import { frozenSuiteLineage } from "./load-release-scope.ts"
import type { ContextCandidate } from "./run-selection.ts"
import { D3_VERDICT_BAR, type D3Label } from "./release-scope.ts"
import {
  buildHistoricalReport,
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
   * True only when EVERY context with a published run clears the group's pass bar, so the group is
   * included on every context the page measured. Editing and Character Sets may also name partial
   * inclusion in `includedOn` without changing this global state.
   */
  included: boolean
  /**
   * The published contexts that CLEAR this group's bar, in page order — what the page includes it on
   * when per-context inclusion applies to the group. Only the groups the ruling names carry a
   * claim here; other groups leave this empty and retain their global inclusion state.
   */
  includedOn: string[]
  /** The measured contexts that keep this group out of the included set, in page order. */
  heldBy: Candidate2HeldContext[]
  /**
   * Contexts published on the previous freeze that have no run on the required suite now, where the
   * group sits below its bar on that run. A group must not read as included because these went dark.
   */
  darkHeldBy: Candidate2DarkHeldContext[]
  /**
   * The ruled per-context contexts that are not measured now: named as ruled but unmeasurable, never
   * counted as included. A RULING, not a measurement, so moving the release pointer can never shrink
   * the ruled basis when a context's newest history run stops clearing the bar.
   */
  darkRuled: string[]
  /**
   * How many contexts the per-context ruling names, measured or dark. The ruled basis is a RULING, so
   * it stays at six when one of its contexts becomes measured below the bar: rendering only
   * includedOn + darkRuled would drop that context and shrink the public claim (30033).
   */
  ruledTotal: number
  /** Contexts with no published run: neither included nor held, named with the row's own reason. */
  unmeasured: Candidate2Unmeasured[]
  /** Every included capability of this group (the ratified base). */
  capabilities: Candidate2Capability[]
  /** How many of them every fraction below divides over — the decidable base. */
  denominator: number
  /** Included, decided by the parser surface only: named beside the fraction, never scored. */
  libraryOnly: Candidate2Capability[]
  /** Included, with no probe in the frozen suite at all: named beside the fraction, never scored. */
  unavailable: Candidate2Capability[]
}

/** One context the page cannot judge a group on, with the reader's own reason for the missing run. */
export interface Candidate2Unmeasured {
  context: string
  reason: string
}

/** One measured context that is below a group's pass bar, with the fraction that says so. */
export interface Candidate2HeldContext {
  context: string
  decisive: number
  denominator: number
  decisivePct: number
  verdictLabel: D3Label
}

/** One context that was published on the previous freeze and has gone dark, with its row's reason. */
export interface Candidate2DarkHeldContext {
  context: string
  decisive: number
  denominator: number
  decisivePct: number
  reason: string
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
  /** The ruled contexts the cohort carries, measured or dark: the basis every per-context group counts. */
  ruledContexts: string[]
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

/**
 * The suites a release published on that this cohort does not read: a run there went dark. The suite
 * the cohort reads is never dark, even when a pointer move put the release on it — its runs are the
 * data the page measures, so counting them as history would let a claim rest on a run it also counts.
 */
export function darkSuitesForLineage(lineage: readonly string[], readingSuiteId: string): Set<string> {
  return new Set(lineage.filter((suiteId) => suiteId !== readingSuiteId))
}

export function loadCandidate2Data(): Candidate2Data {
  const report = buildHistoricalReport({ contentDir, cohort: candidate2Cohort(contentDir) })
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
  // Every suite candidate 2 published on that this cohort does not read: a run there is data that
  // WENT DARK, not missing data. The set is the lineage the pointer moves recorded, never the current
  // pointer read back as history; runs on any suite outside the lineage were never published and
  // cannot hold a claim.
  const darkSuites = darkSuitesForLineage(frozenSuiteLineage(contentDir, "candidate2"), cohort.frozenSuiteId)
  // A hold may be read from history, a claim may not: the newest admitted run per context on a dark
  // suite is what a dark context held the group with. The report's admitted runs are already newest
  // first, so the first per context is the one to use.
  const previousRunsByContext = new Map<string, ContextCandidate>()
  for (const entry of cohort.admittedRuns) {
    const run = entry.run
    if (!darkSuites.has(run.suiteId)) continue
    const key = `${run.terminalId}/${run.os}`
    if (!previousRunsByContext.has(key)) previousRunsByContext.set(key, run)
  }

  // The groups the per-context include ruling names. Membership is data, not a name test at the
  // call site. The test keeps an independent statement of these groups.
  const PER_CONTEXT_INCLUDED = new Set(["editing", "charsets", "reset"])
  // Reset joined them at @cto's c67af756 (2026-10-19): "included on each context clearing 90, held
  // by name on each that does not", the same option A (6a257095) Editing and Character Sets closed
  // under. Its library-only row is named, never scored.
  // The groups whose RULED acceptance base counts their library-only rows. It is a ruling per group,
  // not a rule: chief 11cede0b put Scrollback's two library-only rows in its acceptance base (7/9),
  // while @cto c67af756 (chief 450d65e4 (b)) keeps reset.method OUTSIDE Reset's denominator, where
  // the four scored rows give kitty and xterm 4/4.
  const ACCEPTANCE_COUNTS_LIBRARY_ONLY = new Set(["scrollback"])
  const groups: Omit<
    Candidate2Group,
    "included" | "includedOn" | "heldBy" | "darkHeldBy" | "darkRuled" | "ruledTotal" | "unmeasured"
  >[] = included.map((category) => {
    const scored = decidableByKey.get(category.key)
    if (!scored) {
      throw new Error(`group ${category.key} is included but has no decidable rows; the two bases disagree`)
    }
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
          libraryOnlyIds.length > 0 && ACCEPTANCE_COUNTS_LIBRARY_ONLY.has(category.key)
            ? decisiveShare(row.run.states, [...category.ids, ...libraryOnlyIds])
            : null
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
  // The same ruling names SEVEN contexts for the groups it covers: the five Linux app rows measured on
  // the required suite, plus Ghostty and Alacritty on macOS (27928, 30297). It is a RULING, not a
  // measurement —
  // a ruled context stays in the basis while it is dark, even when its newest history run no longer
  // clears the bar, so moving the release pointer can never improve a public claim by shrinking it.
  const RULED_CONTEXTS = new Set([
    "kitty/linux",
    "ghostty/linux",
    "wezterm/linux",
    "alacritty/linux",
    "xterm/linux",
    "ghostty/macos",
    "alacritty/macos",
  ])
  // The ruling's named contexts that this cohort actually carries, measured or dark. The count is
  // the ruled basis, so it is independent of publication: a ruled context that becomes measured
  // below the bar stays in it rather than shrinking the claim to the contexts that clear the bar.
  const ruledContextsPresent = contexts.filter((row) => RULED_CONTEXTS.has(row.context)).map((row) => row.context)
  const groupsWithState: Candidate2Group[] = groups.map((group) => {
    const includedOn: string[] = []
    const heldBy: Candidate2HeldContext[] = []
    const darkHeldBy: Candidate2DarkHeldContext[] = []
    const darkRuled: string[] = []
    let measuredContexts = 0
    for (const [index, row] of contexts.entries()) {
      if (!row.published) {
        // Ruled and dark is ruled-but-not-measurable whether or not a history run still clears it.
        if (PER_CONTEXT_INCLUDED.has(group.key) && RULED_CONTEXTS.has(row.context)) darkRuled.push(row.context)
        const bar = cohort.barRows[index]
        const selectedRun = bar && "run" in bar ? bar.run : undefined
        // History may HOLD a group, never CLAIM one. When a newer off-freeze run has taken selection,
        // the hold is read from the dark lineage's admitted run rather than from the selected run;
        // the selected run itself is never replaced (the 28467 pin).
        const run =
          selectedRun !== undefined && darkSuites.has(selectedRun.suiteId)
            ? selectedRun
            : previousRunsByContext.get(row.context)
        if (!run) continue
        if (!row.reason) {
          throw new Error(`unpublished context ${row.context} carries no reason; cannot name it as unmeasured`)
        }
        // The acceptance basis is the decidable rows plus the library-only rows ONCE — the same
        // composition the published branch uses. Taking both from the ratified base counted the
        // library-only rows twice (30248: Reset read 6 and Scrollback 12 on history rows, not 5 and 9).
        const category = decidableByKey.get(group.key)
        const ratified = includedByKey.get(group.key)
        if (!category || !ratified) {
          throw new Error(`group ${group.key} is not in the decidable base; cannot judge a dark context`)
        }
        const libraryOnlyIds = ratified.ids.filter((id) => libraryOnly.has(id))
        const share = decisiveShare(run.states, category.ids)
        const acceptance =
          libraryOnlyIds.length > 0 && ACCEPTANCE_COUNTS_LIBRARY_ONLY.has(category.key)
            ? decisiveShare(run.states, [...category.ids, ...libraryOnlyIds])
            : null
        const basis = acceptance ?? share
        if (basis.decisivePct < D3_VERDICT_BAR.passPct) {
          darkHeldBy.push({
            context: row.context,
            decisive: basis.decisive,
            denominator: basis.denominator,
            decisivePct: basis.decisivePct,
            reason: row.reason,
          })
        }
        continue
      }
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
      } else if (PER_CONTEXT_INCLUDED.has(group.key)) {
        // Per-context inclusion applies only to these groups; the rest keep their global state, so no
        // consumer can promote them on a context the ruling did not cover.
        includedOn.push(row.context)
      }
    }
    // A context without a published run is neither included nor held: it is named as unmeasured with
    // the reader's own reason, so no claim and no "held" verdict is manufactured for it.
    const unmeasured = contexts
      .filter((row) => !row.published)
      .map((row) => {
        if (!row.reason) {
          throw new Error(`unpublished context ${row.context} carries no reason; cannot name it as unmeasured`)
        }
        return { context: row.context, reason: row.reason }
      })
    return {
      ...group,
      // A dark context that held the group blocks inclusion exactly as a measured one does: moving
      // data out of the measurement may never improve a claim (@chief 2026-10-17).
      included: measuredContexts > 0 && heldBy.length === 0 && darkHeldBy.length === 0,
      includedOn,
      heldBy,
      darkHeldBy,
      darkRuled,
      ruledTotal: PER_CONTEXT_INCLUDED.has(group.key) ? ruledContextsPresent.length : 0,
      unmeasured,
    }
  })

  return {
    name: cohort.name,
    frozenSuiteId: cohort.frozenSuiteId,
    ratifiedCount: cohort.measuredIds.length,
    scoredCount: cohort.scoredIds.length,
    decidableCount: cohort.decidableIds.length,
    ruledContexts: ruledContextsPresent,
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
