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
import { loadFeatures, loadTerminals, type FeatureCatalog } from "@terminfo/catalog"
import { compatibilityTargets, loadCurrentResults } from "./current-results.ts"
import { publicResults, type PublicProjection, type PublicCurrentResult } from "./public-results.ts"
import { loadCategories } from "./categories.ts"
import { loadReleaseScope } from "./load-release-scope.ts"
import { type CellTable } from "./selected-results.ts"
import {
  aggregateCells,
  coverageSentence,
  d3Verdict,
  isStaleRelation,
  staleCaption,
  supportedShare,
  tier1Included,
  tierLine,
  type D3Verdict,
  type CellAggregate,
  type CellState,
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
  /** Selected terminal id -> feature id -> conclusive "yes" | "no". */
  results: Record<string, Record<string, string>>
  /** backend name -> feature id -> note string */
  notes: Record<string, Record<string, string>>
  /** Selected terminal id -> conclusive-only compatibility score. */
  stats: Record<string, { total: number; yes: number; no: number; partial: number; pct: number | null }>
  /** backend name -> metadata from backends.json */
  meta: Record<string, BackendMeta>
  /** "backend:feature" -> { note, url? } from annotations.json */
  annotations: Record<string, { note: string; url?: string; result?: string }>
  /** feature id -> { name, url? } from features.json */
  featureDescriptions: FeatureCatalog
  /** baseline -> feature ids */
  baselines: Record<string, string[]>
  /** Backend name -> baseline conclusive score and full catalog coverage. */
  baselineStats: Record<string, Record<string, BaselineStats>>
  /** category slug -> display label */
  categoryLabels: Record<string, string>
  /** platform id -> display label, so a printed score can name the OS it came from (macos -> macOS) */
  platformLabels: Record<string, string>
  generated: string
  selected: PublicProjection
  selectedByBackend: Record<string, PublicCurrentResult>
  releaseScope: ReleaseScope & { line: string }
  releaseBars: Record<string, CellAggregate>
  /** Backend name -> the bar's SUPPORTED share label, the front page's secondary readout beside the D3 verdict. */
  releaseShares: Record<string, string>
  /** Backend name -> the D3 release verdict over the INCLUDED 52 (@chief 2026-10-07). */
  releaseVerdicts: Record<string, D3Verdict>
  /** Default-run stale caption when suiteFreshness is not current; null when current. */
  releaseStale: Record<string, string | null>
  /**
   * The reader's classified table for every run a terminal page can pick, keyed by run id: one
   * classification per cell, made once in the projection. A page folds it (`aggregateCells`) for the
   * basis it shows rather than walking the run's raw cells, so no page holds a second classifier.
   */
  releaseTable: Record<string, Readonly<Record<string, CellState>>>
  /** The two suite facts, and whether the live tree has moved past the release suite (one banner when it has). */
  suiteMove: { treeSuiteId: string; releaseSuiteId: string | null; treeMovedPastRelease: boolean }
}

interface BaselineStats {
  total: number
  yes: number
  pct: number | null
  catalog: number
  supported: number
  unsupported: number
  inconclusive: number
  errors: number
  untested: number
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

function loadCategoryLabels(): Record<string, string> {
  // The category catalog is read through its one owner, docs/data/categories.ts.
  return Object.fromEntries(
    Object.entries(loadCategories(join(__dirname, "..", "..", "content"))).map(([id, value]) => [id, value.label]),
  )
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
  const { projection } = loadCurrentResults(contentDir)
  const published = publicResults(projection, compatibilityTargets(projection, contentDir))
  const byTarget = new Map(Object.entries(published.selectedByBackend))
  const featureDescriptions = loadFeatureDescriptions()
  const features: FeatureResult[] = Object.entries(featureDescriptions)
    .filter(([id]) => !id.startsWith("$"))
    .map(([id, meta]) => ({ id, name: meta.name || id, category: id.split(".")[0] ?? id, spec: meta.url }))
    .sort((a, b) => a.id.localeCompare(b.id))
  const categories: Record<string, FeatureResult[]> = {}
  for (const feature of features) (categories[feature.category] ??= []).push(feature)

  const meta = loadBackendMeta()
  for (const [id, terminal] of Object.entries(loadTerminals(contentDir))) {
    meta[id] = { ...meta[id], ...terminal }
  }
  for (const [key, { selected }] of byTarget) {
    const id = selected.target.id
    if (key !== id) {
      meta[key] = {
        ...meta[id],
        label: `${meta[id]?.label ?? id} (${selected.target.kind})`,
        slug: key,
      }
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
    results[key] = Object.fromEntries(
      Object.entries(selected.v1).map(([feature, value]) => [feature, value ? "yes" : "no"]),
    )
    notes[key] = Object.fromEntries(
      Object.entries(selected.cells).flatMap(([feature, cell]) =>
        Object.hasOwn(selected.v1, feature) && cell.note ? [[feature, cell.note]] : [],
      ),
    )
    const { conclusive, supported, unsupported } = selected.counts
    stats[key] = {
      total: conclusive,
      yes: supported,
      no: unsupported,
      partial: 0,
      pct: conclusive > 0 ? Math.round((supported / conclusive) * 100) : null,
    }
  }
  backends.sort((a, b) => (stats[b.name]?.yes ?? 0) - (stats[a.name]?.yes ?? 0) || a.name.localeCompare(b.name))
  const generated =
    Object.values(projection.current)
      .map((v) => v.measuredAt)
      .sort()
      .at(-1) ?? ""
  const release = loadReleaseScope({ catalog: featureDescriptions, categories: loadCategories(contentDir) })
  const releaseScope = {
    ...release,
    line: tierLine(release, generated ? { measuredAt: generated } : undefined),
  }
  const releaseBars: Record<string, CellAggregate> = {}
  const releaseShares: Record<string, string> = {}
  const releaseVerdicts: Record<string, D3Verdict> = {}
  const releaseStale: Record<string, string | null> = {}
  // The bar and the verdict are over the app denominator, never the declared 62: the ten rows the
  // 27832 audit excludes by contract carry tier1 "excluded", and the app-unobservable rows are out by
  // construction, since no app run can decide them (@terminfo/catalog and @terminfo/probe-defs own
  // the labels and the D3 rule).
  const includedIds = tier1Included(featureDescriptions, release.scoredIds)
  for (const [key, { selected }] of byTarget) {
    // One fold over the reader's classified table, never a second walk over the run's raw cells.
    const table = projection.table[selected.runId]
    if (!table) throw new Error(`release bar ${key}: the projection classified no row for run ${selected.runId}`)
    const bar = aggregateCells(table, release.scoredIds)
    if (bar.denominator && coverageSentence(bar) === "No selected run") {
      throw new Error(`release bar ${key} has a denominator but no coverage sentence`)
    }
    releaseBars[key] = bar
    releaseShares[key] = supportedShare(bar)
    const includedBar = aggregateCells(table, includedIds)
    if (includedBar.denominator > 0) {
      const decisive = includedBar.counts.supported + includedBar.counts.unsupported
      releaseVerdicts[key] = d3Verdict(decisive, includedBar.denominator)
    }
    releaseStale[key] = isStaleRelation(selected.suiteRelation) ? staleCaption(selected.measuredAt) : null
  }
  // The table slice a terminal page folds: every run its run picker can select, classified once here.
  const releaseTable: Record<string, Readonly<Record<string, CellState>>> = {}
  for (const run of Object.values(published.projection.versions).flat()) {
    const rows = projection.table[run.runId]
    if (!rows) throw new Error(`The projection classified no row for version run ${run.runId}`)
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
    categoryLabels: loadCategoryLabels(),
    platformLabels: loadPlatformLabels(),
    generated,
    selected: published.projection,
    selectedByBackend,
    releaseScope,
    releaseBars,
    releaseShares,
    releaseVerdicts,
    releaseStale,
    releaseTable,
    suiteMove: {
      treeSuiteId: projection.treeSuiteId,
      releaseSuiteId: projection.releaseSuiteId,
      treeMovedPastRelease: projection.treeMovedPastRelease,
    },
  }
  computeBaselines(result, projection.table)
  return result
}

export default {
  load(): Omit<ProbeData, "selected"> {
    const { selected: _selected, ...client } = loadFullProbes()
    return client
  },
}

function computeBaselines(data: ProbeData, table: CellTable): void {
  const baselineOrder = ["core", "modern", "rich", "unicode", "legacy"]
  const baselines: Record<string, string[]> = {}
  for (const bl of baselineOrder) baselines[bl] = []

  // Group features by baseline
  for (const [id, meta] of Object.entries(data.featureDescriptions)) {
    if (meta.baseline) baselines[meta.baseline]?.push(id)
  }

  // Compute per-backend baseline stats
  const baselineStats: Record<string, Record<string, BaselineStats>> = {}
  for (const backend of data.backends) {
    const backendStats: Record<string, BaselineStats> = {}
    baselineStats[backend.name] = backendStats
    const selected = data.selectedByBackend[backend.name]?.selected
    if (!selected) throw new Error(`Missing selected public run for ${backend.name}`)
    const rows = table[selected.runId]
    if (!rows) throw new Error(`The projection classified no row for run ${selected.runId}`)
    for (const bl of baselineOrder) {
      const ids = baselines[bl] ?? []
      const { supported, unsupported, inconclusive, error: errors, untested } = aggregateCells(rows, ids).counts
      const total = supported + unsupported
      backendStats[bl] = {
        total,
        yes: supported,
        pct: total > 0 ? Math.round((supported / total) * 100) : null,
        catalog: ids.length,
        supported,
        unsupported,
        inconclusive,
        errors,
        untested,
      }
    }
  }

  data.baselines = baselines
  data.baselineStats = baselineStats
}
