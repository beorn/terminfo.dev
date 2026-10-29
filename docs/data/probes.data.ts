/**
 * VitePress build-time data loader for probe results.
 *
 * Projects reviewed current runs through the canonical selector and joins
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
import { compatibilitySubjects, loadCurrentResults } from "./current-results.ts"
import { publicResults, type PublicProjection, type PublicCurrentResult } from "./public-results.ts"
import { loadCategories, orderedCategoryIds } from "./categories.ts"
import { loadReleaseScope } from "./load-release-scope.ts"
import type { ProbeStatus } from "@terminfo/probe-defs"
import {
  aggregateCurrentResults,
  currentSupportedShare,
  isStaleRelation,
  runDecidedNothing,
  staleCaption,
  type CurrentAggregate,
  type ReleaseScope,
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
  label?: string
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
  /** Current terminal id -> feature id -> exact sealed five-status value. */
  results: Record<string, Record<string, ProbeStatus>>
  /** backend name -> feature id -> published reason */
  notes: Record<string, Record<string, string>>
  /** Current scores use Supported/all positions, independently of completion. */
  stats: Record<string, CurrentStats>
  /** backend name -> metadata from backends.json */
  meta: Record<string, BackendMeta>
  /** "backend:feature" -> { note, url? } from annotations.json */
  annotations: Record<string, { note: string; url?: string; result?: string }>
  /** feature id -> { name, url? } from features.json */
  featureDescriptions: FeatureCatalog
  /** baseline -> feature ids */
  baselines: Record<string, string[]>
  /** Backend name -> baseline Supported/all score and frozen catalog coverage. */
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
  releaseScope: ReleaseScope
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
  /** The two suite facts, and whether the live tree has moved past the release suite (one banner when it has). */
  suiteMove: { treeSuiteId: string; releaseSuiteId: string | null; treeMovedPastRelease: boolean }
}

interface CurrentStats {
  score: { supported: number; all: number }
  counts: Record<ProbeStatus, number>
  complete: boolean
  pct: number | null
}

function loadFeatureDescriptions(): FeatureCatalog {
  // The feature catalog, through its one loader (@terminfo/catalog). The loader already refuses a
  // nameless entry and drops $-prefixed comment keys, so the old string-vs-object normalization and
  // its per-field tests live in one place now.
  return loadFeatures(contentDir)
}

function loadAnnotations(): Record<string, { note: string; url?: string; result?: string }> {
  const annotationsPath = join(__dirname, "..", "..", "content", "annotations.json")
  if (!existsSync(annotationsPath)) {
    throw new Error(`annotations.json not found at ${annotationsPath}`)
  }
  const raw = parseJsonStrict(annotationsPath, readFileSync(annotationsPath, "utf-8"))
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`${annotationsPath}: expected annotation catalog object`)
  }
  return raw as Record<string, { note: string; url?: string; result?: string }>
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
export type ClientProbeData = Omit<ProbeData, "selected">

declare const data: ClientProbeData
export { data }

export function loadFullProbes(): ProbeData {
  const categoryCatalog = loadCategories(contentDir)
  const { projection } = loadCurrentResults(contentDir)
  const published = publicResults(projection, compatibilitySubjects(projection, contentDir))
  const bySubject = new Map(Object.entries(published.selectedByBackend))
  const featureDescriptions = loadFeatureDescriptions()
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
  // #30759 Slice A: the site renders the frozen suite only, so a historical-only target is
  // not a matrix row any more; it gets no metadata and no page.
  for (const [key, { selected }] of bySubject) {
    if (!selected.subject) throw new Error(`Selected context ${key} has no physical subject`)
    const id = selected.subject.id
    if (key !== id) {
      const label = subjectLabel(catalog, id, selected.subject.kind, meta[id]?.label)
      meta[key] = { ...meta[id], label, slug: key }
    }
  }
  const annotations = loadAnnotations()
  const backends: BackendInfo[] = []
  const results: ProbeData["results"] = {}
  const notes: ProbeData["notes"] = {}
  const stats: ProbeData["stats"] = {}
  const selectedByBackend: ProbeData["selectedByBackend"] = Object.fromEntries(bySubject)
  for (const [key, { selected }] of bySubject) {
    if (!selected.subject) throw new Error(`Selected public context ${key} has no physical subject`)
    const { kind, os } = selected.subject
    if (results[key]) throw new Error(`Ambiguous published terminal ${key}: multiple selected targets`)
    backends.push({
      name: key,
      versions: [...new Set(Object.values(selected.sources).map((source) => source.subject.version))],
      engine: "",
      type: kind,
      ...(os && { platforms: [os] }),
    })
    results[key] = Object.fromEntries(selected.catalogIds.map((id) => [id, selected.cells[id]?.status ?? "test-todo"]))
    notes[key] = Object.fromEntries(
      Object.values(selected.cells).flatMap((result) => (result.reason ? [[result.featureId, result.reason]] : [])),
    )
    stats[key] = {
      score: { ...selected.score },
      counts: { ...selected.counts },
      complete: selected.complete,
      // #30784: a run that decided nothing has no percentage to print; every reader shows the
      // not-measured words instead of a measured-looking 0%.
      pct: runDecidedNothing(selected.counts)
        ? null
        : Math.round((100 * selected.score.supported) / selected.score.all),
    }
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
  const release = loadReleaseScope({ catalog: featureDescriptions, categories: categoryCatalog })
  const releaseBars: Record<string, CurrentAggregate> = {}
  const releaseShares: Record<string, string> = {}
  const releaseStale: Record<string, string | null> = {}
  for (const [key, entry] of bySubject) {
    const { selected } = entry
    const original = projection.contexts[entry.contextKey]
    if (!original) throw new Error(`Missing composed current context for ${key}`)
    const bar = aggregateCurrentResults(
      original.catalogIds.map((id) => ({ featureId: id, status: original.cells[id]?.result.status ?? "test-todo" })),
      original.catalogIds,
    )
    releaseBars[key] = bar
    releaseShares[key] = currentSupportedShare(bar)
    const sources = Object.values(selected.sources)
    releaseStale[key] = sources.every((source) => isStaleRelation(source.suiteRelation))
      ? sources.map((source) => `${source.runId}: ${staleCaption(source.measuredAt)}`).join("; ")
      : null
  }
  const releaseTable: Record<string, Readonly<Record<string, ProbeStatus>>> = {}
  for (const run of Object.values(published.projection.history).flat()) {
    const rows = projection.table[run.runId]
    if (!rows) throw new Error(`The projection has no sealed status row for run ${run.runId}`)
    releaseTable[run.runId] = rows
  }
  const result: ProbeData = {
    backends,
    features,
    categories,
    results,
    notes,
    stats,
    meta,
    annotations,
    featureDescriptions,
    baselines: {},
    baselineStats: {},
    categoryLabels: Object.fromEntries(Object.entries(categoryCatalog).map(([id, value]) => [id, value.label])),
    categoryOrder: orderedCategoryIds(categoryCatalog),
    platformLabels: loadPlatformLabels(),
    generated,
    selected: published.projection,
    selectedByBackend,
    currentContextCount: published.projection.contextCount,
    releaseScope: release,
    releaseBars,
    releaseShares,
    releaseStale,
    releaseTable,
    suiteMove: {
      treeSuiteId: projection.treeSuiteId,
      releaseSuiteId: projection.releaseSuiteId,
      treeMovedPastRelease: projection.treeMovedPastRelease,
    },
  }
  computeBaselines(result, projection)
  return result
}

export default {
  /** #30759: the full projection stays behind at build time; the client payload omits it. */
  load(): ClientProbeData {
    const { selected: _selected, ...client } = loadFullProbes()
    return client
  },
}

function computeBaselines(data: ProbeData, projection: import("./selected-results.ts").SelectedProjection): void {
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
    const original = projection.contexts[selected.contextKey]
    if (!original) throw new Error(`Missing composed current context ${selected.contextKey}`)
    for (const bl of baselineOrder) {
      const group = new Set(baselines[bl] ?? [])
      const ids = original.catalogIds.filter((id) => group.has(id))
      if (!ids.length) continue
      const wanted = new Set(ids)
      const bar = aggregateCurrentResults(
        original.catalogIds
          .filter((id) => wanted.has(id))
          .map((id) => ({ featureId: id, status: original.cells[id]?.result.status ?? "test-todo" })),
        ids,
      )
      backendStats[bl] = {
        score: { supported: bar.supported, all: bar.denominator },
        counts: bar.counts,
        complete: bar.complete,
        pct: Math.round((100 * bar.supported) / bar.denominator),
      }
    }
  }

  data.baselines = baselines
  data.baselineStats = baselineStats
}
