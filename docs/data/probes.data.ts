/**
 * VitePress build-time data loader for probe results.
 *
 * Projects stored current runs through the canonical selector and joins
 * their display metadata with the feature catalog for the matrix page.
 *
 * Consumed via: import { data } from './data/probes.data'
 */
import { readFileSync, existsSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { manifest } from "@termless/core"
import { parseJsonStrict } from "@terminfo/run-parser"
import { loadFeatures, loadTerminals, subjectLabel, type FeatureCatalog } from "@terminfo/catalog"
import { compatibilitySubjects, joinedAppCells, loadCurrentResults } from "./current-results.ts"
import { DIFFERS_BY_CONTEXT, type AppCellStatus } from "./app-cells.ts"
import {
  publicResults,
  type PublicProjection,
  type PublicCurrentResult,
  type PublicRunMetadata,
} from "./public-results.ts"
import { loadCategories, orderedCategoryIds } from "./categories.ts"
import { selectedSiteWorkingRun, siteWorkingHistory, type WorkingContext, type WorkingView } from "./working-runs.ts"
import { createBuildMetadata } from "../../scripts/build-metadata.ts"
import { siteProbesPath } from "../../scripts/site-out.ts"
import { publicFeatures } from "./public-features.ts"
import { loadRunObservers, type RunObservers } from "./run-observers.ts"
import { displayVersions } from "../.vitepress/theme/display-version.ts"
import { collectGarbage } from "../../packages/admin/corpus-placement.ts"
import { scoredFeatureIds, type ProbeStatus, type FeatureResultStatus } from "@terminfo/probe-defs"
import {
  aggregateCurrentResults,
  currentSupportedShare,
  rollupInputs,
  hasCurrentSource,
  staleCaption,
  type CurrentAggregate,
  type RollupCounts,
} from "./release-scope.ts"

const __dirname = dirname(fileURLToPath(import.meta.url))
const contentDir = join(__dirname, "..", "..", "content")

export interface BackendInfo {
  name: string
  versions: string[]
  engine: string
  type?: "term" | "lib" | "mux"
  platforms?: string[]
}

export interface FeatureResult {
  id: string
  name: string
  category: string
  spec?: string
}

export interface TerminalMeta {
  name?: string
  description?: string
  body?: string
  url?: string
  repo?: string
  author?: string
}

export interface BackendMeta {
  /** Unique in plain text: names the platform in words when two contexts share one terminal page. */
  label?: string
  /** #37761: the same name without the platform words, for places that show the platform icon beside it. */
  shortLabel?: string
  description?: string
  body?: string
  url?: string
  upstream?: string
  type?: string
  caveat?: string
  slug?: string
  repo?: string
  terminal?: TerminalMeta
}

export interface ProbeData {
  backends: BackendInfo[]
  features: FeatureResult[]
  /** category -> FeatureResult[] */
  categories: Record<string, FeatureResult[]>
  /**
   * Current terminal id -> feature id -> the published (decided) feature status, which may read differs-by-context. A
   * feature with no decided result is absent (#37341 Q1).
   */
  results: Record<string, Record<string, AppCellStatus>>
  /** backend name -> feature id -> published reason */
  notes: Record<string, Record<string, string>>
  /** run id -> the observer-only switches that run turned on (#37761, @cto e81def55); absent when none. */
  observers: Record<string, string[]>
  /** Current counts: Supported and tested of the graded positions, independently of completion (#37341 D2). */
  stats: Record<string, CurrentStats>
  /** backend name -> metadata from backends.json */
  meta: Record<string, BackendMeta>
  /** "backend:feature" -> { note, url? } from annotations.json */
  annotations: Record<string, { note: string; url?: string }>
  /** feature id -> { name, url? } from features.json: the public catalogue, without the environment positions (Q2) */
  featureDescriptions: FeatureCatalog
  /** baseline -> feature ids */
  baselines: Record<string, string[]>
  /** Backend name -> baseline Supported/all score and recorded catalog coverage. */
  baselineStats: Record<string, Record<string, CurrentStats>>
  /** category slug -> display label */
  categoryLabels: Record<string, string>
  /** Category IDs in the curated catalog's numeric display order. */
  categoryOrder: string[]
  /** platform id -> display label, so a printed score can name the OS it came from (macos -> macOS) */
  platformLabels: Record<string, string>
  generated: string
  selected: PublicProjection
  selectedByBackend: Record<string, PublicCurrentResult>
  currentContextCount: number
  releaseBars: Record<string, CurrentAggregate>
  /** Backend name -> the bar's SUPPORTED share label, the front page's secondary readout beside the D3 verdict. */
  releaseShares: Record<string, string>
  /** Default-run stale caption when suiteFreshness is not current; null when current. */
  releaseStale: Record<string, string | null>
  /**
   * The reader's classified table for every run a terminal page can pick, keyed by run id: one
   * classification per cell, made once in the projection, so pages read the classified table rather
   * than walking the run's raw cells or holding a second classifier.
   */
  releaseTable: Record<string, Readonly<Record<string, ProbeStatus>>>
}

interface CurrentStats {
  score: { supported: number; all: number }
  /** Every bucket over the graded positions, folded from the published cells; an absent cell folds as open. */
  counts: CurrentAggregate["counts"]
  /** Cells whose same-suite contexts disagree: decided, but never counted as Supported or Unsupported (@cto d321729a). */
  differs: number
  /** Of `counts.unsupported`, the cells derived from a refused parent (#33019). */
  derived: number
  /** Of `counts.untestable`, the cells a reviewed declaration made untestable (@cto b0d3cd4e condition 5). */
  byReview: number
  complete: boolean
  /** Supported of the graded positions, for a bar's width only; never printed (#37341 D2). Null with no graded position. */
  pct: number | null
}

type JoinedApp = NonNullable<ReturnType<ReturnType<typeof joinedAppCells>["get"]>>

/**
 * One subject's site stats, as the OS table and the matrix read them: its joined app's counts when contexts joined,
 * else its own. A reviewed declaration covers every context of its app on its OS, so a declared cell is counted by
 * review wherever its counted status reads untestable.
 */
export function subjectStats(selected: PublicCurrentResult["selected"], app: JoinedApp | undefined): CurrentStats {
  // Counts are per app and probe (@cto d321729a rule 5): every joined context's grade counts in its
  // bucket here, and a disagreement lands in its own `differs-by-context` bucket instead of Supported or
  // Unsupported (@cto c3c2f885). The joined app already counts all seven buckets. A stored-only context's
  // published counts carry its decided buckets only (#37341 Q4), so its cells are folded again over its catalogue.
  const counts: RollupCounts = app
    ? { ...app.counts }
    : aggregateCurrentResults(rollupInputs(selected.contextKey, selected), selected.catalogIds).counts
  const supported = app ? app.counts.supported : selected.score.supported
  const byReview = scoredFeatureIds(selected.catalogIds).filter(
    (id) =>
      selected.featureResults[id]?.declared !== undefined &&
      (app?.cells[id]?.status ?? selected.featureResults[id]?.status) === "untestable",
  ).length
  return {
    score: { supported, all: selected.score.all },
    counts: { ...counts },
    differs: counts[DIFFERS_BY_CONTEXT],
    derived: selected.derivedIds.length,
    byReview,
    complete: selected.complete,
    pct: selected.score.all === 0 ? null : Math.round((100 * supported) / selected.score.all),
  }
}

/** One subject's stats over one baseline's features, as the baseline page reads them. */
export function baselineStat(
  name: string,
  selected: PublicCurrentResult["selected"],
  ids: readonly string[],
): CurrentStats {
  const wanted = new Set(ids)
  const bar = aggregateCurrentResults(
    rollupInputs(name, selected).filter((result) => wanted.has(result.featureId)),
    ids,
  )
  return {
    score: { supported: bar.supported, all: bar.denominator },
    counts: bar.counts,
    differs: 0,
    derived: bar.derived,
    byReview: bar.byReview,
    complete: bar.complete,
    pct: bar.denominator === 0 ? null : Math.round((100 * bar.supported) / bar.denominator),
  }
}

function loadFeatureDescriptions(): FeatureCatalog {
  // The feature catalog, through its one loader (@terminfo/catalog). The loader already refuses a
  // nameless entry and drops $-prefixed comment keys, so the old string-vs-object normalization and
  // its per-field tests live in one place now.
  return loadFeatures(contentDir)
}

function loadAnnotations(): Record<string, { note: string; url?: string }> {
  const annotationsPath = join(__dirname, "..", "..", "content", "annotations.json")
  if (!existsSync(annotationsPath)) {
    throw new Error(`annotations.json not found at ${annotationsPath}`)
  }
  const raw = parseJsonStrict(annotationsPath, readFileSync(annotationsPath, "utf-8"))
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`${annotationsPath}: expected annotation catalog object`)
  }
  return raw as Record<string, { note: string; url?: string }>
}

/** platform id -> display label; the site prints it beside a score so the OS is never implied. */
function loadPlatformLabels(): Record<string, string> {
  const path = join(contentDir, "platforms.json")
  const raw = parseJsonStrict(path, readFileSync(path, "utf-8"))
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`${path}: expected platform catalog object`)
  }
  return Object.fromEntries(
    Object.entries(raw as Record<string, { label?: string }>)
      .filter(([, value]) => value && typeof value.label === "string")
      .map(([id, value]) => [id, value.label as string]),
  )
}

/**
 * #37761 item 10: an app's own facts. The catalog entry wins as before; what only the manifest's headless backend
 * of the same id supplies (its upstream package, engine type and caveat) is left out instead of being shown as the app's.
 */
function appMeta(merged: BackendMeta | undefined, entry: object | undefined): BackendMeta {
  const { upstream: _upstream, type: _type, caveat: _caveat, ...kept } = merged ?? {}
  return { ...kept, ...(entry as BackendMeta | undefined) }
}

function loadBackendMeta(): Record<string, BackendMeta> {
  const m = manifest()
  const meta: Record<string, BackendMeta> = {}
  for (const [name, entry] of Object.entries(m.backends)) {
    meta[name] = {
      label: entry.label,
      description: entry.description,
      url: entry.url,
      upstream: entry.upstream ?? undefined,
      type: entry.type,
      caveat: entry.caveat,
      slug: entry.slug,
      terminal: entry.terminal,
    }
  }
  return meta
}

/**
 * #30759: the client payload is exactly what `load()` returns — the full projection stays behind at
 * build time. One alias names it for both the loader and the `data` a page imports, so a field
 * `load()` drops can never stay advertised in the client-side type.
 */
export type ClientProbeData = Omit<ProbeData, "selected"> & {
  workingHistory?: ClientWorkingView[]
  /** #33037: each distinct historical status map once; a history context names its map by `statesRef`. */
  workingStates?: Array<Readonly<Record<string, FeatureResultStatus>>>
  workingOriginals?: Record<string, Array<PublicRunMetadata & { states: Record<string, ProbeStatus> }>>
}

export type ClientWorkingContext = Omit<WorkingContext, "states"> & { statesRef?: number }
export type ClientWorkingView = Omit<WorkingView, "contexts"> & { contexts: ClientWorkingContext[] }

declare const data: ClientProbeData
export { data }

export function loadFullProbes(): ProbeData {
  const categoryCatalog = loadCategories(contentDir)
  const { projection } = loadCurrentResults(contentDir)
  const subjects = compatibilitySubjects(projection, contentDir)
  const joined = joinedAppCells(projection, subjects, contentDir)
  const published = publicResults(projection, subjects, joined)
  const bySubject = new Map(Object.entries(published.selectedByBackend))
  // Q2 (@cpo/term f16a5a52): pages list the public catalogue, so the nine environment positions leave features,
  // categories, the client payload, results, notes and baselines here. No count moves: the folds grade the graded
  // ids only, and the stats and bars below still read each run's full recorded catalogIds.
  const featureDescriptions = publicFeatures(loadFeatureDescriptions())
  const features: FeatureResult[] = Object.entries(featureDescriptions)
    .filter(([id]) => !id.startsWith("$"))
    .map(([id, meta]) => ({ id, name: meta.name || id, category: id.split(".")[0] ?? id, spec: meta.url }))
    .sort((a, b) => a.id.localeCompare(b.id))
  const categories: Record<string, FeatureResult[]> = {}
  for (const feature of features) (categories[feature.category] ??= []).push(feature)

  const meta = loadBackendMeta()
  const catalog = loadTerminals(contentDir)
  for (const [id, terminal] of Object.entries(catalog)) {
    meta[id] = { ...meta[id], ...terminal }
  }
  const systemCounts = new Map<string, number>()
  const routeMeta = new Map<string, BackendMeta>()
  const platformLabels = loadPlatformLabels()
  for (const { routeKey } of bySubject.values()) systemCounts.set(routeKey, (systemCounts.get(routeKey) ?? 0) + 1)
  // #37761: a non-default kind is named only where a terminal app ("term", the default) shares its catalog id.
  const appIds = new Set(
    [...bySubject.values()].flatMap(({ selected }) => (selected.subject?.kind === "term" ? [selected.subject.id] : [])),
  )
  // Columns have their own explicit OS, but every OS of one app links to its released app route.
  for (const [key, { selected, routeKey, os }] of bySubject) {
    if (!selected.subject) throw new Error(`Selected context ${key} has no physical subject`)
    const id = selected.subject.id
    const kind = selected.subject.kind
    // #37761 item 10: a manifest backend entry describes the headless library of that id (Ghostty's is the
    // ghostty-web wasm build), so an app or multiplexer context keeps only the catalog's own facts about it.
    const own = kind === "lib" ? meta[id] : appMeta(meta[id], catalog[id])
    const original =
      routeMeta.get(routeKey) ??
      (routeKey === id && (kind === "term" || !appIds.has(id))
        ? { ...own }
        : {
            ...own,
            label: subjectLabel(catalog, id, kind, own?.label),
            ...(routeKey !== id && { slug: routeKey }),
          })
    routeMeta.set(routeKey, original)
    const platform = os === null ? "OS not recorded" : (platformLabels[os] ?? os)
    const contextMeta: BackendMeta = {
      ...original,
      shortLabel: original.label ?? id,
      ...((systemCounts.get(routeKey) ?? 0) > 1 && { label: `${original.label ?? id} (${platform})` }),
    }
    if (kind === "mux" && id === "tmux" && selected.subject.config === "tmux: focus-events on") {
      contextMeta.label = `${contextMeta.label ?? id} (focus-events on; default off)`
      contextMeta.shortLabel = `${contextMeta.shortLabel ?? id} (focus-events on; default off)`
    }
    meta[key] = contextMeta
  }
  const annotations = loadAnnotations()
  const backends: BackendInfo[] = []
  const results: ProbeData["results"] = {}
  const notes: ProbeData["notes"] = {}
  const runObservers: Record<string, RunObservers> = loadRunObservers(
    contentDir,
    new Set(Object.keys(featureDescriptions)),
  )
  const observers: ProbeData["observers"] = Object.fromEntries(
    Object.entries(runObservers).map(([runId, row]) => [runId, [...row.observers]]),
  )
  const stats: ProbeData["stats"] = {}
  const selectedByBackend: ProbeData["selectedByBackend"] = Object.fromEntries(bySubject)
  for (const [key, { selected }] of bySubject) {
    if (!selected.subject) throw new Error(`Selected public context ${key} has no physical subject`)
    const { kind, os } = selected.subject
    if (results[key]) throw new Error(`Ambiguous published terminal ${key}: multiple selected targets`)
    backends.push({
      name: key,
      versions: displayVersions(Object.values(selected.sources)),
      engine: "",
      type: kind,
      ...(os && { platforms: [os] }),
    })
    const app = joined.get(key)
    // #37341 Q1: the published cells only; publicResults left out every result we haven't decided. Q2: public features only.
    results[key] = Object.fromEntries(
      Object.values(selected.featureResults)
        .filter((result) => Object.hasOwn(featureDescriptions, result.featureId))
        .map((result) => [result.featureId, result.status]),
    )
    notes[key] = Object.fromEntries(
      Object.values(selected.featureResults).flatMap((result) => {
        if (!Object.hasOwn(featureDescriptions, result.featureId)) return []
        // #37761 (@cto e81def55): a cell an observer-only switch let the probe read says so beside its own reason.
        // A cell names the run it came from (origin); a cell with none came from no observed run.
        const observed = result.origin ? runObservers[result.origin.runId] : undefined
        const note = observed?.featureIds.includes(result.featureId) ? observed.note : undefined
        const text = [result.reason, note].filter(Boolean).join(" ")
        return text ? [[result.featureId, text]] : []
      }),
    )
    stats[key] = subjectStats(selected, app)
  }
  backends.sort(
    (a, b) =>
      (stats[b.name]?.score.supported ?? 0) - (stats[a.name]?.score.supported ?? 0) || a.name.localeCompare(b.name),
  )
  const generated =
    Object.values(published.projection.contexts)
      .flatMap((context) => Object.values(context.sources).map((source) => source.measuredAt))
      .sort()
      .at(-1) ?? ""
  const releaseBars: Record<string, CurrentAggregate> = {}
  const releaseShares: Record<string, string> = {}
  const releaseStale: Record<string, string | null> = {}
  for (const [key, entry] of bySubject) {
    const { selected } = entry
    const bar = aggregateCurrentResults(rollupInputs(key, selected), selected.catalogIds)
    releaseBars[key] = bar
    releaseShares[key] = currentSupportedShare(bar)
    const sources = Object.values(selected.sources)
    releaseStale[key] = !hasCurrentSource(sources)
      ? sources.map((source) => `${source.runId}: ${staleCaption(source.measuredAt)}`).join("; ")
      : null
  }
  const releaseTable: Record<string, Readonly<Record<string, ProbeStatus>>> = {}
  for (const run of Object.values(published.projection.history).flat()) {
    const rows = projection.table[run.runId]
    if (!rows) throw new Error(`The projection has no stored status row for run ${run.runId}`)
    releaseTable[run.runId] = rows
  }
  const result: ProbeData = {
    backends,
    features,
    categories,
    results,
    notes,
    observers,
    stats,
    meta,
    annotations,
    featureDescriptions,
    baselines: {},
    baselineStats: {},
    categoryLabels: Object.fromEntries(Object.entries(categoryCatalog).map(([id, value]) => [id, value.label])),
    categoryOrder: orderedCategoryIds(categoryCatalog),
    platformLabels,
    generated,
    selected: published.projection,
    selectedByBackend,
    currentContextCount: published.projection.contextCount,
    releaseBars,
    releaseShares,
    releaseStale,
    releaseTable,
  }
  computeBaselines(result)
  collectGarbage()
  return result
}

/** #30759: the full projection stays behind at build time; the client payload omits it. */
export function loadClientProbes(): ClientProbeData {
  const { selected, ...client } = loadFullProbes()
  const workingHistory = siteWorkingHistory(contentDir)
  if (!workingHistory) return client
  // Reuse the projection already built once; never reread the corpus or carry full evidence per feature.
  const workingOriginals = Object.fromEntries(
    Object.entries(selected.history).map(([key, originals]) => [
      key,
      originals.map(({ results, ...original }) => ({
        ...original,
        states: Object.fromEntries(results.map((result) => [result.featureId, result.status])),
      })),
    ]),
  )
  return { ...client, ...shareStates(workingHistory), workingOriginals }
}

export default {
  load(): ClientProbeData {
    const root = join(contentDir, "..")
    const path = siteProbesPath(root)
    const snapshot = parseJsonStrict(path, readFileSync(path, "utf8")) as {
      sourceCommit: string
      workingRunId: string | null
      data: ClientProbeData
    } | null
    if (
      snapshot?.sourceCommit !== createBuildMetadata(root).sourceCommit ||
      (snapshot.workingRunId ?? null) !== (selectedSiteWorkingRun()?.id ?? null)
    ) {
      throw new Error(`${path}: probe snapshot inputs differ from this build; run bun analysis`)
    }
    if (!snapshot.data || typeof snapshot.data !== "object" || Array.isArray(snapshot.data)) {
      throw new Error(`${path}: invalid client probe data; run bun analysis`)
    }
    return snapshot.data
  },
}

/**
 * #33037: the client chunk is one JSON value, so a status map repeated per run per context was sent every time
 * (2,151 maps, 240 distinct, 92.6% of the theme chunk). Equal maps are sent once; the cached server views stay whole.
 */
function shareStates(views: WorkingView[]): Pick<ClientProbeData, "workingHistory" | "workingStates"> {
  const workingStates: NonNullable<ClientProbeData["workingStates"]> = []
  const refs = new Map<string, number>()
  const workingHistory = views.map((view) => ({
    ...view,
    contexts: view.contexts.map(({ states, ...context }): ClientWorkingContext => {
      if (!states) return context
      const key = JSON.stringify(states)
      let statesRef = refs.get(key)
      if (statesRef === undefined) {
        statesRef = workingStates.push(states) - 1
        refs.set(key, statesRef)
      }
      return { ...context, statesRef }
    }),
  }))
  return { workingHistory, workingStates }
}

function computeBaselines(data: ProbeData): void {
  const baselineOrder = ["core", "modern", "rich", "unicode", "legacy"]
  const baselines: Record<string, string[]> = {}
  for (const bl of baselineOrder) baselines[bl] = []

  // Group features by baseline
  for (const [id, meta] of Object.entries(data.featureDescriptions)) {
    if (meta.baseline) baselines[meta.baseline]?.push(id)
  }

  // Compute per-backend baseline stats
  const baselineStats: Record<string, Record<string, CurrentStats>> = {}
  for (const backend of data.backends) {
    const backendStats: Record<string, CurrentStats> = {}
    baselineStats[backend.name] = backendStats
    const selected = data.selectedByBackend[backend.name]?.selected
    if (!selected) throw new Error(`Missing selected public run for ${backend.name}`)
    for (const bl of baselineOrder) {
      const group = new Set(baselines[bl] ?? [])
      const ids = selected.catalogIds.filter((id) => group.has(id))
      if (!ids.length) continue
      backendStats[bl] = baselineStat(backend.name, selected, ids)
    }
  }

  data.baselines = baselines
  data.baselineStats = baselineStats
}
