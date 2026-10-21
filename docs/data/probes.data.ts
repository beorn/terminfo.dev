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
import { loadFeatures, loadTerminals, targetLabel, type FeatureCatalog } from "@terminfo/catalog"
import { compatibilityTargets, historicalCompatibilityTargets, loadCurrentResults } from "./current-results.ts"
import {
  publicResults,
  type PublicProjection,
  type PublicCurrentResult,
  type HistoricalPublicCurrentResult,
} from "./public-results.ts"
import { loadCategories, orderedCategoryIds } from "./categories.ts"
import { loadReleaseScope } from "./load-release-scope.ts"
import type { CellState } from "./release-scope.ts"
import type { CapabilityStatus } from "@terminfo/probe-defs"
import {
  aggregateCurrentResults,
  currentSupportedShare,
  isStaleRelation,
  staleCaption,
  tierLine,
  type CurrentAggregate,
  type ReleaseScope,
} from "./release-scope.ts"

const __dirname = dirname(fileURLToPath(import.meta.url))
const contentDir = join(__dirname, "..", "..", "content")

export interface BackendInfo {
  name: string
  version: string
  engine: string
  type?: "app" | "headless" | "mux"
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
  results: Record<string, Record<string, CapabilityStatus>>
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
  historicalByBackend: Record<string, HistoricalPublicCurrentResult>
  currentRunCount: number
  historicalTable: Readonly<Record<string, Readonly<Record<string, CellState>>>>
  releaseScope: ReleaseScope & { line: string }
  releaseBars: Record<string, CurrentAggregate>
  /** Backend name -> the bar's SUPPORTED share label, the front page's secondary readout beside the D3 verdict. */
  releaseShares: Record<string, string>
  /** Default-run stale caption when suiteFreshness is not current; null when current. */
  releaseStale: Record<string, string | null>
  /**
   * The reader's classified table for every run a terminal page can pick, keyed by run id: one
   * classification per cell, made once in the projection. A page folds it (`aggregateCells`) for the
   * basis it shows rather than walking the run's raw cells, so no page holds a second classifier.
   */
  releaseTable: Record<string, Readonly<Record<string, CapabilityStatus>>>
  /** The two suite facts, and whether the live tree has moved past the release suite (one banner when it has). */
  suiteMove: { treeSuiteId: string; releaseSuiteId: string | null; treeMovedPastRelease: boolean }
}

interface CurrentStats {
  score: { supported: number; all: number }
  counts: Record<CapabilityStatus, number>
  complete: boolean
  pct: number | null
}

function loadFeatureDescriptions(): FeatureCatalog {
  // The feature catalog, through its one loader (@terminfo/catalog). The loader already refuses a
  // nameless entry and drops $-prefixed comment keys, so the old string-vs-object normalization and
  // its per-field checks live in one place now.
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

declare const data: Omit<ProbeData, "selected">
export { data }

export function loadFullProbes(): ProbeData {
  const categoryCatalog = loadCategories(contentDir)
  const { projection } = loadCurrentResults(contentDir)
  const published = publicResults(
    projection,
    compatibilityTargets(projection, contentDir),
    historicalCompatibilityTargets(projection.historical, contentDir),
  )
  const byTarget = new Map(Object.entries(published.selectedByBackend))
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
  // A target published apart from its catalog entry gets its own name and slug, current or historical-only.
  // A historical-only one takes nothing else: its entry's prose describes the app, not this target.
  const historicalOnly = Object.entries(published.historicalByBackend).filter(([key]) => !byTarget.has(key))
  for (const [key, { selected }] of [...byTarget, ...historicalOnly]) {
    const id = selected.target.id
    if (key !== id) {
      const label = targetLabel(catalog, id, selected.target.kind, meta[id]?.label)
      meta[key] = byTarget.has(key) ? { ...meta[id], label, slug: key } : { label, slug: key }
    }
  }
  const annotations = loadAnnotations()
  const backends: BackendInfo[] = []
  const results: ProbeData["results"] = {}
  const notes: ProbeData["notes"] = {}
  const stats: ProbeData["stats"] = {}
  const selectedByBackend: ProbeData["selectedByBackend"] = Object.fromEntries(byTarget)
  for (const [key, { selected }] of byTarget) {
    const { kind, os } = selected.target
    if (results[key]) throw new Error(`Ambiguous published terminal ${key}: multiple selected targets`)
    backends.push({
      name: key,
      version: selected.target.version,
      engine: "",
      type: kind,
      ...(os && { platforms: [os] }),
    })
    results[key] = Object.fromEntries(selected.results.map((result) => [result.featureId, result.status]))
    notes[key] = Object.fromEntries(
      selected.results.flatMap((result) => (result.reason ? [[result.featureId, result.reason]] : [])),
    )
    stats[key] = {
      score: { ...selected.score },
      counts: { ...selected.counts },
      complete: selected.complete,
      pct: Math.round((100 * selected.score.supported) / selected.score.all),
    }
  }
  backends.sort(
    (a, b) =>
      (stats[b.name]?.score.supported ?? 0) - (stats[a.name]?.score.supported ?? 0) || a.name.localeCompare(b.name),
  )
  const generated =
    Object.values(projection.current)
      .map((v) => v.measuredAt)
      .sort()
      .at(-1) ?? ""
  const release = loadReleaseScope({ catalog: featureDescriptions, categories: categoryCatalog })
  const releaseScope = {
    ...release,
    line: tierLine(release, generated ? { measuredAt: generated } : undefined),
  }
  const releaseBars: Record<string, CurrentAggregate> = {}
  const releaseShares: Record<string, string> = {}
  const releaseStale: Record<string, string | null> = {}
  for (const [key, entry] of byTarget) {
    const { selected } = entry
    // The sealed run's complete frozen catalog is the current score basis.
    const original = projection.current[entry.contextKey]
    if (!original) throw new Error(`Missing sealed current run for ${key}`)
    const bar = aggregateCurrentResults(original.results, original.catalogIds)
    releaseBars[key] = bar
    releaseShares[key] = currentSupportedShare(bar)
    releaseStale[key] = isStaleRelation(selected.suiteRelation) ? staleCaption(selected.measuredAt) : null
  }
  const releaseTable: Record<string, Readonly<Record<string, CapabilityStatus>>> = {}
  for (const run of Object.values(published.projection.versions).flat()) {
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
    historicalByBackend: published.historicalByBackend,
    currentRunCount: published.projection.currentRunCount,
    historicalTable: projection.historical.table,
    releaseScope,
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
  load(): Omit<ProbeData, "selected"> {
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
    const original = Object.values(projection.current).find((run) => run.runId === selected.runId)
    if (!original) throw new Error(`Missing frozen current results for ${selected.runId}`)
    for (const bl of baselineOrder) {
      const group = new Set(baselines[bl] ?? [])
      const ids = original.catalogIds.filter((id) => group.has(id))
      if (!ids.length) continue
      const wanted = new Set(ids)
      const bar = aggregateCurrentResults(
        original.results.filter((result) => wanted.has(result.featureId)),
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
