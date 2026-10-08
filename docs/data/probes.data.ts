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
import { compatibilityTargets, loadCurrentResults } from "./current-results.ts"
import { publicResults, type PublicProjection, type PublicCurrentResult } from "./public-results.ts"
import { loadReleaseScope } from "./load-release-scope.ts"
import {
  barOverMeasured,
  coverageSentence,
  d3Verdict,
  includedTierOneIds,
  isStaleSuite,
  staleCaption,
  supportedShare,
  tierLine,
  type D3Verdict,
  type MeasuredBar,
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
  featureDescriptions: Record<string, FeatureMeta>
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
  releaseBars: Record<string, MeasuredBar>
  /** Backend name -> the bar's SUPPORTED share label, the front page's secondary readout beside the D3 verdict. */
  releaseShares: Record<string, string>
  /** Backend name -> the D3 release verdict over the INCLUDED 52 (@chief 2026-10-07). */
  releaseVerdicts: Record<string, D3Verdict>
  /** Default-run stale caption when suiteFreshness is not current; null when current. */
  releaseStale: Record<string, string | null>
}

interface FeatureMeta {
  name: string
  slug?: string
  url?: string
  tags?: string[]
  group?: string
  body?: string
  probe?: string
  baseline?: string
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

function loadFeatureDescriptions(): Record<string, FeatureMeta> {
  const path = join(__dirname, "..", "..", "content", "features.json")
  if (!existsSync(path)) {
    throw new Error(`features.json not found at ${path}`)
  }
  {
    const raw: unknown = JSON.parse(readFileSync(path, "utf-8"))
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`Invalid feature catalog ${path}`)
    // Normalize: strings become { name: string }, objects stay as-is
    const result: Record<string, FeatureMeta> = {}
    for (const [id, val] of Object.entries(raw as Record<string, unknown>)) {
      if (id.startsWith("$")) continue
      if (typeof val === "string") result[id] = { name: val }
      else {
        if (!val || typeof val !== "object" || Array.isArray(val)) {
          throw new Error(`${path}: ${id} requires a feature name`)
        }
        const v = val as Record<string, unknown>
        if (typeof v.name !== "string") throw new Error(`${path}: ${id} requires a feature name`)
        const optionalString = (field: string): string | undefined => {
          const value = v[field]
          if (value === undefined) return undefined
          if (typeof value !== "string") throw new Error(`${path}: invalid ${id}.${field}`)
          return value
        }
        if (v.tags !== undefined && (!Array.isArray(v.tags) || !v.tags.every((tag) => typeof tag === "string"))) {
          throw new Error(`${path}: invalid ${id}.tags`)
        }
        result[id] = {
          name: v.name,
          slug: optionalString("slug"),
          url: optionalString("url"),
          tags: v.tags as string[] | undefined,
          group: optionalString("group"),
          body: optionalString("body"),
          probe: optionalString("probe"),
          baseline: optionalString("baseline"),
        }
      }
    }
    return result
  }
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
  const path = join(__dirname, "..", "..", "content", "categories.json")
  const raw = parseJsonStrict(path, readFileSync(path, "utf-8"))
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`${path}: expected category catalog object`)
  }
  return Object.fromEntries(
    Object.entries(raw as Record<string, { label: string }>).map(([id, value]) => [id, value.label]),
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

  const terminalPath = join(contentDir, "terminals.json")
  const terminalContent = parseJsonStrict(terminalPath, readFileSync(terminalPath, "utf8"))
  if (!terminalContent || typeof terminalContent !== "object" || Array.isArray(terminalContent)) {
    throw new Error(`${terminalPath}: expected terminal catalog object`)
  }
  const meta = loadBackendMeta()
  for (const [id, terminal] of Object.entries(terminalContent)) {
    if (!terminal || typeof terminal !== "object" || Array.isArray(terminal)) {
      throw new Error(`${terminalPath}: ${id} requires a terminal metadata object`)
    }
    meta[id] = { ...meta[id], ...(terminal as BackendMeta) }
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
  const release = loadReleaseScope({
    catalog: featureDescriptions,
    declarationPath: join(contentDir, "release-scope.json"),
  })
  const releaseScope = {
    ...release,
    line: tierLine(release, generated ? { measuredAt: generated } : undefined),
  }
  const releaseBars: Record<string, MeasuredBar> = {}
  const releaseShares: Record<string, string> = {}
  const releaseVerdicts: Record<string, D3Verdict> = {}
  const releaseStale: Record<string, string | null> = {}
  // The verdict is over the INCLUDED 52, not the declared 62: the ten F2 movers are excluded by
  // contract and never counted (docs/data/release-scope.ts owns the list and the D3 rule).
  const includedIds = includedTierOneIds(release.measuredIds)
  for (const [key, { selected }] of byTarget) {
    const bar = barOverMeasured(selected.cells, release.measuredIds)
    if (bar.denominator && coverageSentence(bar) === "No selected run") {
      throw new Error(`release bar ${key} has a denominator but no coverage sentence`)
    }
    releaseBars[key] = bar
    releaseShares[key] = supportedShare(bar)
    const includedBar = barOverMeasured(selected.cells, includedIds)
    if (includedBar.denominator > 0) releaseVerdicts[key] = d3Verdict(includedBar.conclusive, includedBar.denominator)
    releaseStale[key] = isStaleSuite(selected.suiteFreshness) ? staleCaption(selected.measuredAt) : null
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
  }
  computeBaselines(result)
  return result
}

export default {
  load(): Omit<ProbeData, "selected"> {
    const { selected: _selected, ...client } = loadFullProbes()
    return client
  },
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
  const baselineStats: Record<string, Record<string, BaselineStats>> = {}
  for (const backend of data.backends) {
    const backendStats: Record<string, BaselineStats> = {}
    baselineStats[backend.name] = backendStats
    const cells = data.selectedByBackend[backend.name]?.selected.cells
    if (!cells) throw new Error(`Missing selected public cells for ${backend.name}`)
    for (const bl of baselineOrder) {
      const ids = baselines[bl] ?? []
      let supported = 0
      let unsupported = 0
      let inconclusive = 0
      let errors = 0
      let untested = 0
      for (const id of ids) {
        const cell = cells[id]
        if (!cell) untested++
        else if (cell.outcome === "error") errors++
        else if (cell.conclusive && cell.outcome === "supported") supported++
        else if (cell.conclusive && cell.outcome === "unsupported") unsupported++
        else inconclusive++
      }
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
