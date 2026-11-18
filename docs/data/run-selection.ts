/** One context selection rule shared by compatibility and full-project readers. */
import { type FeatureResultStatus, type ProbeResult } from "@terminfo/probe-defs"
import { hasCurrentSource, type FeatureResultDisplayState, type SuiteRelation } from "./release-scope.ts"
import type { SourceHistory } from "./source-history.ts"
import {
  versionCompare,
  originalRunFor,
  type SelectedVersion,
  type CurrentSelectedVersion,
  type SelectedContextSummary,
  type SelectedProjection,
} from "./selected-results.ts"

/**
 * Minimal cell view a reader keeps beside the classified `states`; `SelectedCell` satisfies it
 * structurally. `reason` and `note` are carried so a consumer can print the RUN'S OWN words for an
 * inconclusive row (the named cause, such as a terminal that never answers `CSI 16 t`) instead of
 * paraphrasing one of its own. Bars are cut over `states`; this raw view is only the run's own words.
 */
export type ShareCells = Record<
  string,
  { outcome: string; conclusive?: boolean; reason?: string; note?: string; evidence?: string }
>

/** One candidate context the site currently selects, reduced to what the readers consume. */
export interface ContextCandidate {
  key: string
  kind: string
  terminalId: string
  os: string
  permissions: string | null
  sources: Array<{
    runId: string
    measuredAt: string
    suiteId: string
    suiteRelation: SuiteRelation
    /**
     * This run recorded a probe selection, so it never measured the whole suite. Absent means this
     * reader held no raw replies to judge (the historical per-version overload); it never means the
     * run was proven full. Only the composed projection path can see `collector.selection`.
     */
    partial?: boolean
  }>
  /** The canonical context, when this candidate is a composed view. */
  context?: SelectedContextSummary
  cells?: ShareCells
  results?: ProbeResult[]
  /**
   * The run's states as the projection published them (28792 item 1). A reader cuts its bars over
   * this, never over the raw `cells`.
   */
  states: Readonly<Record<string, FeatureResultDisplayState | FeatureResultStatus>>
}

export interface HistoricalContextCandidate extends ContextCandidate {
  cells: ShareCells
  results?: never
  states: Readonly<Record<string, FeatureResultDisplayState>>
}

export interface CurrentContextCandidate extends ContextCandidate {
  results: ProbeResult[]
  cells?: never
  states: Readonly<Record<string, FeatureResultStatus>>
}

/** The candidate for one context key, from the projection's own selected version. */
export function candidateFromSelected(
  key: string,
  selected: SelectedContextSummary,
  states: Readonly<Record<string, FeatureResultStatus>>,
  projection: SelectedProjection,
): CurrentContextCandidate | undefined
export function candidateFromSelected(
  key: string,
  selected: SelectedVersion,
  states: Readonly<Record<string, FeatureResultDisplayState>>,
): HistoricalContextCandidate
export function candidateFromSelected(
  key: string,
  selected: CurrentSelectedVersion,
  states: Readonly<Record<string, FeatureResultStatus>>,
): CurrentContextCandidate
export function candidateFromSelected(
  key: string,
  selected: SelectedVersion | CurrentSelectedVersion,
  states: Readonly<Record<string, FeatureResultDisplayState | FeatureResultStatus>>,
): ContextCandidate
export function candidateFromSelected(
  key: string,
  selected: SelectedVersion | CurrentSelectedVersion | SelectedContextSummary,
  states: Readonly<Record<string, FeatureResultDisplayState | FeatureResultStatus>>,
  projection?: SelectedProjection,
): ContextCandidate | undefined {
  if ("contributingRunIds" in selected) {
    if (selected.contributingRunIds.length === 0) return undefined
    if (!selected.subject) throw new Error(`Context ${key} has contributing evidence without physical subject facts`)
    if (!projection) throw new Error(`Context ${key} needs its original projection history`)
    return {
      key,
      kind: selected.subject.kind,
      terminalId: selected.subject.id,
      os: selected.subject.os ?? "",
      permissions: selected.subject.permissions,
      sources: selected.contributingRunIds.map((runId) => {
        const original = originalRunFor(projection, key, runId)
        return {
          runId,
          measuredAt: original.measuredAt,
          suiteId: original.suiteId,
          suiteRelation: original.suiteRelation,
          partial: measuresSelectionOnly(original),
        }
      }),
      context: selected,
      results: Object.values(selected.cells).map((cell) => cell.result),
      states,
    }
  }
  return {
    key,
    kind: selected.subject.kind,
    terminalId: selected.subject.id,
    os: selected.subject.os ?? "",
    permissions: selected.subject.permissions ?? null,
    sources: [
      {
        runId: selected.runId,
        measuredAt: selected.measuredAt,
        suiteId: selected.suiteId,
        suiteRelation: selected.suiteRelation,
      },
    ],
    ...("results" in selected ? { results: selected.results } : { cells: selected.cells }),
    states,
  }
}

/**
 * Did this run measure a selection rather than the suite (#34868)? Presence of a selection cannot decide it,
 * because every app run records one: a suite-complete wezterm macOS run selects all 264 ids its suite declares
 * and leaves only the 9 ids outside that suite unselected, while the 04:31 draft selected 9. Completeness is
 * set membership against the run own declared suite cohort (selectionCoversCohort in selected-results.ts), so
 * 263 of 264 and a same-length wrong-id selection are both a selection, not a reading of the suite (@cto
 * 34868-scope-membership ruling).
 */
export function measuresSelectionOnly(run: {
  selection?: { ids: readonly string[] }
  selectionCoversSuite?: boolean
}): boolean {
  return run.selection !== undefined && run.selectionCoversSuite === false
}

/** How the summary context was chosen, printed beside the row. */
export type RunSelection =
  | "only current"
  | "default profile"
  | "latest original evidence"
  /** The only candidate standing was a selected run, so the summary covers its selection, not the suite. */
  | "latest partial selection"
  | "app version, then source ancestry"

/** One run that contributed cells to a candidate context: what the lineage pick orders by. */
export interface LineageRun {
  runId: string
  version: string | null
  sourceRevision: string | null
}

/**
 * The run-order-independent pick (33587, @cto d805d1af): the site's per-(app, OS) primary is the candidate with the
 * highest app version, then the descendant source revision. Wall-clock time and arrival order never choose.
 */
export interface ContextLineage<T extends ContextCandidate = ContextCandidate> {
  /** Every run that contributed cells to `candidate`. */
  runs: (candidate: T) => readonly LineageRun[]
  history: Pick<SourceHistory, "isAncestor">
}

export type PickedContextRun<T extends ContextCandidate = ContextCandidate> = { run: T; selection: RunSelection }

/**
 * Prefer current-suite evidence, then a unique permissions-free profile. Remaining ties use the newest
 * contributing original measurement, then the stable context key. Attempts never refresh evidence.
 * This chooses a summary only; the projection retains every context and its original cells.
 *
 * With `lineage` (the site's per-(app, OS) primary, whose observation a row the join refuses shows), the pick
 * is `pickByLineage` instead: app version, then source-revision ancestry, never newest evidence.
 */
export function pickContextRun<T extends ContextCandidate>(
  candidates: readonly T[],
  lineage?: ContextLineage<T>,
): PickedContextRun<T> | undefined {
  if (lineage) return pickByLineage(candidates, lineage)
  const dated = candidates.map((candidate) => {
    const latest = Math.max(...candidate.sources.map((source) => Date.parse(source.measuredAt)))
    if (!Number.isFinite(latest)) throw new Error(`Context ${candidate.key} has no finite original evidence time`)
    return { candidate, latest }
  })
  if (dated.length === 0) return undefined
  const current = dated.filter(({ candidate }) => hasCurrentSource(candidate.sources))
  const considered = current.length > 0 ? current : dated
  // A run that measured a selection is a real reading of its ids and never a reading of the suite, so a
  // full run outranks it at equal standing — in the current-suite pool and in the fallback alike. Only
  // when no full run stands at all may a selected run be the summary, and then the reason says so.
  const full = considered.filter(({ candidate }) => !carriesPartial(candidate))
  const partialOnly = full.length === 0
  const pool = partialOnly ? considered : full
  const [only] = pool
  if (pool.length === 1 && only) {
    return { run: only.candidate, selection: partialOnly ? "latest partial selection" : "only current" }
  }
  const defaults = pool.filter(({ candidate }) => candidate.permissions === null)
  const [onlyDefault] = defaults
  if (defaults.length === 1 && onlyDefault) {
    return {
      run: onlyDefault.candidate,
      selection: partialOnly ? "latest partial selection" : "default profile",
    }
  }
  const [latest] = [...pool].sort(
    (left, right) =>
      right.latest - left.latest ||
      (left.candidate.key < right.candidate.key ? -1 : left.candidate.key > right.candidate.key ? 1 : 0),
  )
  return (
    latest && {
      run: latest.candidate,
      selection: partialOnly ? "latest partial selection" : "latest original evidence",
    }
  )
}

/** The one revision among `revisions` that descends from (or is) every other, or undefined when none does. */
function descendantOfAll(revisions: readonly string[], history: ContextLineage["history"]): string | undefined {
  return revisions.find((tip) => revisions.every((other) => history.isAncestor(other, tip)))
}

/**
 * A STRICT-SUBSET-ONLY candidate is one whose every contributing run measured only a selection: it is a real
 * reading of its ids and never a reading of the suite. A candidate that also holds a full-scope run is
 * qualified (#34868 scope-membership: @cto 2026-11-18), because demoting it would hand the bar to older
 * evidence than the run that joined the partial cells. Both picks use this one predicate.
 */
function carriesPartial(candidate: ContextCandidate): boolean {
  return candidate.sources.length > 0 && candidate.sources.every((source) => source.partial === true)
}

/**
 * Highest app version (`versionCompare`, the projection's own order), then the context whose source revision
 * descends from every other's. A context's revision is the tip of its contributing runs at that version, which must
 * themselves form one line. Unrelated revisions refuse by name; equal tips fall to a unique permissions-free
 * profile, then the stable context key.
 */
function pickByLineage<T extends ContextCandidate>(
  candidates: readonly T[],
  lineage: ContextLineage<T>,
): PickedContextRun<T> | undefined {
  const [single] = candidates
  if (candidates.length === 1 && single) {
    return {
      run: single,
      selection: carriesPartial(single) ? "latest partial selection" : "only current",
    }
  }
  if (candidates.length === 0) return undefined
  const facts = candidates.map((candidate) => {
    const runs = lineage.runs(candidate)
    if (runs.length === 0) throw new Error(`Context ${candidate.key} has no contributing run to pick by`)
    for (const run of runs) {
      if (run.version === null) throw new Error(`Context ${candidate.key} run ${run.runId} records no app version`)
    }
    const version = runs
      .map((run) => run.version as string)
      .sort((left, right) => versionCompare(right, left))[0] as string
    return { candidate, version, runs: runs.filter((run) => run.version === version) }
  })
  const top = facts.map((fact) => fact.version).sort((left, right) => versionCompare(right, left))[0]
  // A run that measured a selection is never a reading of the suite (#34868). At the newest app version a
  // complete context outranks a partial one however ancestry orders them: a 9-row run at the newest revision
  // must not take the app bar from a complete run one revision behind. Only when nothing complete stands may
  // a partial run be the primary, and the reason then says so.
  const atTopVersion = facts.filter((fact) => fact.version === top)
  const complete = atTopVersion.filter((fact) => !carriesPartial(fact.candidate))
  const considered = complete.length > 0 ? complete : atTopVersion
  const tips = considered.map((fact) => {
    const revisions = [
      ...new Set(
        fact.runs.map((run) => {
          if (run.sourceRevision === null) {
            throw new Error(`Context ${fact.candidate.key} run ${run.runId} records no source revision`)
          }
          return run.sourceRevision
        }),
      ),
    ]
    const tip = descendantOfAll(revisions, lineage.history)
    if (tip === undefined) {
      throw new Error(
        `Context ${fact.candidate.key} holds runs of app version ${fact.version} from unrelated source revisions ` +
          `${revisions.join(", ")}; the pick refuses`,
      )
    }
    return { candidate: fact.candidate, tip }
  })
  const winner = descendantOfAll(
    tips.map((entry) => entry.tip),
    lineage.history,
  )
  if (winner === undefined) {
    throw new Error(
      `Contexts ${tips.map((entry) => `${entry.candidate.key} (${entry.tip})`).join(", ")} measured app version ${top} ` +
        `from unrelated source revisions; the pick refuses`,
    )
  }
  const tied = tips.filter((entry) => entry.tip === winner).map((entry) => entry.candidate)
  // Equal standing only: among candidates the version-and-ancestry order cannot separate, a full run wins.
  const fullTied = tied.filter((candidate) => !carriesPartial(candidate))
  const pool = fullTied.length > 0 ? fullTied : tied
  const partialOnly = complete.length === 0
  const defaults = pool.filter((candidate) => candidate.permissions === null)
  const [chosen] =
    defaults.length === 1 ? defaults : [...pool].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
  return (
    chosen && {
      run: chosen,
      selection: partialOnly ? "latest partial selection" : "app version, then source ancestry",
    }
  )
}

/** The physical facts that separate one setup from another: every context-key field except `config`. */
export interface SetupSubject {
  kind: string
  id: string
  os: string | null
  osVersion: string | null
  outerTerminal: string | null
  mux: string | null
  permissions: string | null
}

/** One context as the setup classifier sees it: what it was measured as, and the runs behind it. */
export interface SetupContext {
  key: string
  subject: SetupSubject
  runs: readonly LineageRun[]
}

/**
 * A context's standing among the setups of one app on one machine: the group's newest setup, or one strictly behind
 * it. Only `config` may differ inside a group, so a second font measured by the newest run is likewise current.
 */
export type SetupStanding = "current" | "older setup"

export interface SetupClassification {
  /** Every classified context, with an explicit standing. A context absent from this map was never classified. */
  standings: Map<string, SetupStanding>
  /** Groups whose order the version-and-ancestry rule cannot decide, named; nothing in them is older. */
  undecidable: string[]
}

/** The group a context belongs to: setups that differ only in `config`. */
function setupGroupKey(subject: SetupSubject): string {
  return JSON.stringify([
    subject.kind,
    subject.id,
    subject.os,
    subject.osVersion,
    subject.outerTerminal,
    subject.mux,
    subject.permissions,
  ])
}

/** A readable name for a group, so an undecidable one is named rather than defaulted (@cto 026fd6fd rule 4). */
function setupGroupName(subject: SetupSubject): string {
  const parts = [`${subject.kind}:${subject.id}`, subject.os ?? "no OS"]
  if (subject.osVersion) parts.push(subject.osVersion)
  if (subject.outerTerminal) parts.push(`outer ${subject.outerTerminal}`)
  if (subject.mux) parts.push(`mux ${subject.mux}`)
  if (subject.permissions) parts.push(`permissions ${subject.permissions}`)
  return parts.join(" · ")
}

/**
 * Which setup of an app is current, and which are older, by the one order the site already uses (33587): the highest
 * app version, then the source revision that descends from every other. A context is current only when it sits AT the
 * group's newest position; every context strictly behind it is "older setup". Ties are not broken: two configs at the
 * newest position, such as two fonts measured by the same run, are both current.
 *
 * A group whose order cannot be decided — a run without an app version, runs of one version from unrelated source
 * revisions, or tips that no single revision descends from — classifies NOTHING in it as older and names the group.
 * There is no default in either direction (@cto 026fd6fd rules 1-4).
 */
export function classifySetups(
  contexts: readonly SetupContext[],
  history: Pick<SourceHistory, "isAncestor">,
): SetupClassification {
  const groups = new Map<string, SetupContext[]>()
  for (const context of contexts) {
    const key = setupGroupKey(context.subject)
    const group = groups.get(key) ?? []
    group.push(context)
    groups.set(key, group)
  }
  const standings = new Map<string, SetupStanding>()
  const undecidable: string[] = []
  for (const group of groups.values()) {
    const [first] = group
    if (!first) continue
    // A group of one is its own newest setup; no order is needed, so no history is read.
    if (group.length === 1) {
      standings.set(first.key, "current")
      continue
    }
    const named = setupGroupName(first.subject)
    const facts = group.map((context) => {
      if (context.runs.length === 0) return { context, undecidable: `no contributing run` }
      if (context.runs.some((run) => run.version === null)) {
        return { context, undecidable: `a run records no app version` }
      }
      const version = context.runs
        .map((run) => run.version as string)
        .sort((left, right) => versionCompare(right, left))[0] as string
      const revisions = [
        ...new Set(
          context.runs
            .filter((run) => run.version === version)
            .map((run) => {
              if (run.sourceRevision === null) return ""
              return run.sourceRevision
            }),
        ),
      ]
      if (revisions.some((revision) => revision === "")) {
        return { context, undecidable: `a run of version ${version} records no source revision` }
      }
      const tip = descendantOfAll(revisions, history)
      if (tip === undefined) {
        return {
          context,
          undecidable: `version ${version} from unrelated source revisions ${revisions.join(", ")}`,
        }
      }
      return { context, version, tip }
    })
    const refused = facts.find((fact) => fact.undecidable !== undefined)
    if (refused) {
      undecidable.push(`${named}: ${refused.undecidable}`)
      for (const context of group) standings.set(context.key, "current")
      continue
    }
    const settled = facts as Array<{ context: SetupContext; version: string; tip: string }>
    const top = settled.map((fact) => fact.version).sort((left, right) => versionCompare(right, left))[0] as string
    const atTop = settled.filter((fact) => fact.version === top)
    const winner = descendantOfAll(
      atTop.map((fact) => fact.tip),
      history,
    )
    if (winner === undefined) {
      undecidable.push(
        `${named}: version ${top} from unrelated source revisions ${atTop.map((fact) => fact.tip).join(", ")}`,
      )
      for (const context of group) standings.set(context.key, "current")
      continue
    }
    for (const fact of settled) {
      const current = fact.version === top && fact.tip === winner
      standings.set(fact.context.key, current ? "current" : "older setup")
    }
  }
  return { standings, undecidable }
}
