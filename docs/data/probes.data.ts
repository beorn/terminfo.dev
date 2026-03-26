/**
 * VitePress build-time data loader for probe results.
 *
 * Reads probe result JSON files from content/probes-apps/ and content/probes-libs/,
 * merges with curated content, and reshapes for the matrix page.
 *
 * Consumed via: import { data } from './data/probes.data'
 */
import { readFileSync, existsSync, readdirSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { manifest } from "@termless/core"

const __dirname = dirname(fileURLToPath(import.meta.url))
const contentDir = join(__dirname, "..", "..", "content")
const probesAppsDir = join(contentDir, "probes-apps")
const probesMuxDir = join(contentDir, "probes-mux")
const probesLibsDir = join(contentDir, "probes-libs")

export interface BackendInfo {
  name: string
  version: string
  engine: string
  type?: "app" | "headless"
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
  terminal?: TerminalMeta
}

export interface ProbeData {
  backends: BackendInfo[]
  features: FeatureResult[]
  /** category -> FeatureResult[] */
  categories: Record<string, FeatureResult[]>
  /** backend name -> feature id -> "yes" | "no" | "partial" */
  results: Record<string, Record<string, string>>
  /** backend name -> feature id -> note string */
  notes: Record<string, Record<string, string>>
  /** backend name -> { total, yes, no, partial, pct } */
  stats: Record<string, { total: number; yes: number; no: number; partial: number; pct: number }>
  /** backend name -> metadata from backends.json */
  meta: Record<string, BackendMeta>
  /** "backend:feature" -> { note, url? } from annotations.json */
  annotations: Record<string, { note: string; url?: string; result?: string }>
  /** feature id -> { name, url? } from features.json */
  featureDescriptions: Record<string, FeatureMeta>
  /** baseline -> feature ids */
  baselines: Record<string, string[]>
  /** backend name -> baseline -> { total, yes, pct } */
  baselineStats: Record<string, Record<string, { total: number; yes: number; pct: number }>>
  /** category slug -> display label */
  categoryLabels: Record<string, string>
  generated: string
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

function loadFeatureDescriptions(): Record<string, FeatureMeta> {
  const path = join(__dirname, "..", "..", "content", "features.json")
  if (!existsSync(path)) {
    throw new Error(`features.json not found at ${path}`)
  }
  {
    const raw = JSON.parse(readFileSync(path, "utf-8")) as Record<string, any>
    delete raw.$comment
    // Normalize: strings become { name: string }, objects stay as-is
    const result: Record<string, FeatureMeta> = {}
    for (const [id, val] of Object.entries(raw)) {
      if (typeof val === "string") result[id] = { name: val }
      else {
        const v = val as any
        result[id] = {
          name: v.name,
          slug: v.slug,
          url: v.url,
          tags: v.tags,
          group: v.group,
          body: v.body,
          probe: v.probe,
          baseline: v.baseline,
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
  return JSON.parse(readFileSync(annotationsPath, "utf-8")) as Record<
    string,
    { note: string; url?: string; result?: string }
  >
}

function loadCategoryLabels(): Record<string, string> {
  const path = join(__dirname, "..", "..", "content", "categories.json")
  const raw = JSON.parse(readFileSync(path, "utf-8")) as Record<string, { label: string }>
  return Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, v.label]))
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

declare const data: ProbeData
export { data }

export default {
  load(): ProbeData {
    // Load app (community) results as primary — these test real terminals
    const appData = loadAppResults()

    // Load headless results as fallback for terminals without app results
    let headlessData: ProbeData
    const unifiedPath = join(probesLibsDir, "unified.json")
    if (existsSync(unifiedPath)) {
      headlessData = loadUnifiedProbes(unifiedPath)
    } else {
      headlessData = loadPerBackendResults()
    }

    let result: ProbeData
    // If we have app results, merge them as primary
    if (appData.backends.length > 0) {
      result = mergeResults(appData, headlessData)
    } else {
      // Fallback to headless only
      result = headlessData
    }

    // Compute baseline stats
    computeBaselines(result)
    return result
  },
}

/** Merge app results (primary) with headless results (fallback for missing terminals) */
function mergeResults(app: ProbeData, headless: ProbeData): ProbeData {
  const merged = { ...app }

  // Add headless-only backends that don't have app results
  const appNames = new Set(app.backends.map((b) => b.name))
  for (const hb of headless.backends) {
    // Map headless backend names to app terminal names
    const appName = headlessToAppName(hb.name)
    if (!appNames.has(appName) && !appNames.has(hb.name)) {
      merged.backends.push(hb)
      merged.results[hb.name] = headless.results[hb.name] ?? {}
      merged.notes[hb.name] = headless.notes[hb.name] ?? {}
      merged.stats[hb.name] = headless.stats[hb.name] ?? { total: 0, yes: 0, no: 0, partial: 0, pct: 0 }
      if (headless.meta[hb.name]) merged.meta[hb.name] = headless.meta[hb.name]!
    }
  }

  // Merge headless-only features into the feature list
  const existingIds = new Set(merged.features.map((f) => f.id))
  for (const hf of headless.features) {
    if (!existingIds.has(hf.id)) {
      merged.features.push(hf)
      existingIds.add(hf.id)
    }
  }
  // Re-sort features and rebuild categories
  merged.features.sort((a, b) => a.id.localeCompare(b.id))
  merged.categories = {}
  for (const f of merged.features) {
    if (!merged.categories[f.category]) merged.categories[f.category] = []
    merged.categories[f.category]!.push(f)
  }

  return merged
}

function headlessToAppName(backend: string): string {
  const terms = loadTerminals()
  for (const [name, entry] of Object.entries(terms)) {
    if ((entry as any).headlessBackends?.includes(backend)) return name
  }
  return backend
}

/** Load community/app results from content/probes-apps/ and content/probes-mux/ */
function loadAppResults(): ProbeData {
  // Scan both app and mux result directories
  const resultDirs = [probesAppsDir, probesMuxDir]
  const allFiles: Array<{ dir: string; file: string }> = []
  for (const dir of resultDirs) {
    try {
      for (const file of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
        allFiles.push({ dir, file })
      }
    } catch {}
  }
  if (allFiles.length === 0) return emptyData()

  // Keep only latest result per terminal, and collect all platforms per terminal
  const latest = new Map<string, any>()
  const platformMap = new Map<string, Set<string>>()
  for (const { dir, file } of allFiles) {
    try {
      const raw = JSON.parse(readFileSync(join(dir, file), "utf-8")) as any
      if (!raw.terminal || !raw.results) continue
      const key = raw.terminal
      if (!latest.has(key) || (raw.generated ?? "") > (latest.get(key).generated ?? "")) {
        latest.set(key, raw)
      }
      if (raw.os) {
        if (!platformMap.has(key)) platformMap.set(key, new Set())
        platformMap.get(key)!.add(raw.os)
      }
    } catch {}
  }

  const allBackends: BackendInfo[] = []
  const results: Record<string, Record<string, string>> = {}
  const notes: Record<string, Record<string, string>> = {}
  const featureSet = new Map<string, FeatureResult>()
  const featureDescs = loadFeatureDescriptions()

  for (const [name, raw] of latest) {
    allBackends.push({
      name,
      version: raw.terminalVersion ?? "",
      engine: "",
      type: "app",
      platforms: [...(platformMap.get(name) ?? [])],
    })
    results[name] = {}
    notes[name] = {}
    for (const [id, val] of Object.entries(raw.results ?? {})) {
      results[name][id] = val ? "yes" : "no"
      if (raw.notes?.[id]) notes[name][id] = raw.notes[id]
      if (!featureSet.has(id)) {
        const cat = id.split(".")[0]!
        const meta = featureDescs[id]
        featureSet.set(id, {
          id,
          name: meta?.name || id,
          category: cat,
          spec: meta?.url,
        })
      }
    }
  }

  // Sort by score (highest first)
  allBackends.sort((a, b) => {
    const aYes = Object.values(results[a.name] ?? {}).filter((v) => v === "yes").length
    const bYes = Object.values(results[b.name] ?? {}).filter((v) => v === "yes").length
    return bYes - aYes
  })

  const features = Array.from(featureSet.values()).sort((a, b) => a.id.localeCompare(b.id))
  const categories: Record<string, FeatureResult[]> = {}
  for (const f of features) {
    if (!categories[f.category]) categories[f.category] = []
    categories[f.category]!.push(f)
  }

  const stats: ProbeData["stats"] = {}
  for (const b of allBackends) {
    const entries = Object.values(results[b.name]!)
    const total = entries.length
    const yes = entries.filter((v) => v === "yes").length
    const no = entries.filter((v) => v === "no").length
    const partial = entries.filter((v) => v === "partial").length
    const pct = total > 0 ? Math.round((yes / total) * 100) : 0
    stats[b.name] = { total, yes, no, partial, pct }
  }

  // Build meta — app metadata takes priority over headless backend metadata
  const meta: Record<string, BackendMeta> = {}
  for (const b of allBackends) {
    meta[b.name] = buildAppMeta(b.name)
  }

  return {
    backends: allBackends,
    features,
    categories,
    results,
    notes,
    stats,
    meta,
    annotations: loadAnnotations(),
    featureDescriptions: featureDescs,
    baselines: {},
    baselineStats: {},
    categoryLabels: loadCategoryLabels(),
    generated: new Date().toISOString(),
  }
}

let _terminals: Record<string, any> | null = null
function loadTerminals(): Record<string, any> {
  if (_terminals) return _terminals
  const path = join(__dirname, "..", "..", "content", "terminals.json")
  _terminals = JSON.parse(readFileSync(path, "utf-8")) as Record<string, any>
  return _terminals!
}

function buildAppMeta(terminalName: string): BackendMeta {
  const terminals = loadTerminals()
  const t = terminals[terminalName]

  // Look up terminal metadata from @termless/core manifest
  let terminalMeta: TerminalMeta | undefined
  const manifestName = t?.manifestBackend
  if (manifestName) {
    try {
      const m = manifest()
      const entry = m.backends[manifestName]
      if (entry?.terminal) terminalMeta = entry.terminal
    } catch {}
  }

  if (!t) {
    // Unknown terminal — generate basic meta
    return {
      label: terminalName,
      slug: terminalName.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
      description: `${terminalName} terminal emulator`,
      terminal: terminalMeta,
    }
  }

  return {
    label: t.label ?? terminalName,
    slug: t.slug ?? terminalName.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
    description: t.description ?? `${t.label ?? terminalName} terminal emulator`,
    body: t.body,
    url: t.url,
    terminal: terminalMeta,
  }
}

function loadUnifiedProbes(path: string): ProbeData {
  const raw = JSON.parse(readFileSync(path, "utf-8")) as any

  const backends: BackendInfo[] = (Object.values(raw.backends ?? {}) as BackendInfo[]).map((b) => ({
    ...b,
    type: "headless" as const,
    platforms: ["macos", "linux", "windows"],
  }))
  const backendNames = backends.map((b) => b.name)

  const features: FeatureResult[] = (raw.features ?? []).map((f: any) => ({
    id: f.id,
    name: f.name,
    category: f.category,
    spec: f.spec,
  }))

  // Group by category
  const categories: Record<string, FeatureResult[]> = {}
  for (const f of features) {
    if (!categories[f.category]) categories[f.category] = []
    categories[f.category]!.push(f)
  }

  // Build results and notes maps
  const results: Record<string, Record<string, string>> = {}
  const notes: Record<string, Record<string, string>> = {}
  for (const name of backendNames) {
    results[name] = {}
    notes[name] = {}
  }
  for (const f of raw.features ?? []) {
    for (const [backendName, result] of Object.entries(f.results ?? {})) {
      const r = result as any
      results[backendName] ??= {}
      notes[backendName] ??= {}
      results[backendName]![f.id] = r.support ?? "unknown"
      if (r.notes) notes[backendName]![f.id] = r.notes
    }
  }

  // Load annotations and merge into notes + apply result overrides
  const annotations = loadAnnotations()
  for (const [key, ann] of Object.entries(annotations)) {
    const [backend, ...featureParts] = key.split(":")
    const feature = featureParts.join(":")
    if (!notes[backend!]) notes[backend!] = {}
    // Annotation note replaces the auto-generated note
    notes[backend!]![feature] = ann.note
    // Annotation can override the probe result (e.g., "partial" for headless API gaps)
    if (ann.result && results[backend!]) {
      results[backend!]![feature] = ann.result
    }
  }

  // Compute per-backend stats
  const stats: ProbeData["stats"] = {}
  for (const name of backendNames) {
    const entries = Object.values(results[name]!)
    const total = entries.length
    const yes = entries.filter((v) => v === "yes").length
    const no = entries.filter((v) => v === "no").length
    const partial = entries.filter((v) => v === "partial").length
    const pct = total > 0 ? Math.round((yes / total) * 100) : 0
    stats[name] = { total, yes, no, partial, pct }
  }

  return {
    backends,
    features,
    categories,
    results,
    notes,
    stats,
    meta: loadBackendMeta(),
    annotations,
    featureDescriptions: loadFeatureDescriptions(),
    baselines: {},
    baselineStats: {},
    categoryLabels: loadCategoryLabels(),
    generated: raw.generated ?? "",
  }
}

function loadPerBackendResults(): ProbeData {
  let files: string[]
  try {
    files = readdirSync(probesLibsDir).filter((f) => f.endsWith(".json") && f !== "unified.json")
  } catch (err) {
    throw new Error(`Failed to read probe results from ${probesLibsDir}: ${err}`)
  }

  if (files.length === 0) return emptyData()

  // Each file is a per-backend result
  const allBackends: BackendInfo[] = []
  const results: Record<string, Record<string, string>> = {}
  const notes: Record<string, Record<string, string>> = {}
  const featureSet = new Map<string, FeatureResult>()
  const featureDescs = loadFeatureDescriptions()

  for (const file of files) {
    try {
      const raw = JSON.parse(readFileSync(join(probesLibsDir, file), "utf-8")) as any
      if (!raw.backend) continue
      allBackends.push({
        name: raw.backend,
        version: raw.version ?? "",
        engine: raw.engine ?? "",
        type: "headless",
        platforms: ["macos", "linux", "windows"],
      })
      results[raw.backend] = {}
      notes[raw.backend] = {}
      const rawNotes = raw.notes ?? {}
      for (const [id, val] of Object.entries(raw.results ?? {})) {
        results[raw.backend]![id] =
          typeof val === "boolean" ? (val ? "yes" : "no") : ((val as any).support ?? "unknown")
        if (rawNotes[id]) notes[raw.backend]![id] = rawNotes[id]
        if (!featureSet.has(id)) {
          const cat = id.split(".")[0]!
          const suffix = id.slice(cat.length + 1)
          const meta = featureDescs[id]
          featureSet.set(id, {
            id,
            name: meta?.name || suffix || id,
            category: cat,
            spec: meta?.url,
          })
        }
      }
    } catch (err) {
      throw new Error(`Failed to parse probe result ${file}: ${err}`)
    }
  }

  allBackends.sort((a, b) => a.name.localeCompare(b.name))
  const features = Array.from(featureSet.values()).sort((a, b) => a.id.localeCompare(b.id))

  const categories: Record<string, FeatureResult[]> = {}
  for (const f of features) {
    if (!categories[f.category]) categories[f.category] = []
    categories[f.category]!.push(f)
  }

  const stats: ProbeData["stats"] = {}
  for (const b of allBackends) {
    const entries = Object.values(results[b.name]!)
    const total = entries.length
    const yes = entries.filter((v) => v === "yes").length
    const no = entries.filter((v) => v === "no").length
    const partial = entries.filter((v) => v === "partial").length
    const pct = total > 0 ? Math.round((yes / total) * 100) : 0
    stats[b.name] = { total, yes, no, partial, pct }
  }

  const generated = new Date().toISOString()

  const annotations = loadAnnotations()
  for (const [key, ann] of Object.entries(annotations)) {
    const [backend, ...fp] = key.split(":")
    const feature = fp.join(":")
    if (notes[backend!]) notes[backend!]![feature] = ann.note
    if (ann.result && results[backend!]) results[backend!]![feature] = ann.result
  }

  // Recompute stats after overrides
  for (const b of allBackends) {
    const entries = Object.values(results[b.name]!)
    const total = entries.length
    const yes = entries.filter((v) => v === "yes").length
    const no = entries.filter((v) => v === "no").length
    const partial = entries.filter((v) => v === "partial").length
    const pct = total > 0 ? Math.round((yes / total) * 100) : 0
    stats[b.name] = { total, yes, no, partial, pct }
  }

  return {
    backends: allBackends,
    features,
    categories,
    results,
    notes,
    stats,
    meta: loadBackendMeta(),
    annotations,
    featureDescriptions: loadFeatureDescriptions(),
    baselines: {},
    baselineStats: {},
    categoryLabels: loadCategoryLabels(),
    generated,
  }
}

function emptyData(): ProbeData {
  return {
    backends: [],
    features: [],
    categories: {},
    results: {},
    notes: {},
    stats: {},
    meta: {},
    annotations: {},
    featureDescriptions: loadFeatureDescriptions(),
    baselines: {},
    baselineStats: {},
    categoryLabels: {},
    generated: "",
  }
}

function computeBaselines(data: ProbeData): void {
  const baselineOrder = ["core", "modern", "rich", "unicode"]
  const baselines: Record<string, string[]> = {}
  for (const bl of baselineOrder) baselines[bl] = []

  // Group features by baseline
  for (const [id, meta] of Object.entries(data.featureDescriptions)) {
    if (meta.baseline && baselines[meta.baseline]) {
      baselines[meta.baseline]!.push(id)
    }
  }

  // Compute per-backend baseline stats
  const baselineStats: Record<string, Record<string, { total: number; yes: number; pct: number }>> = {}
  for (const backend of data.backends) {
    baselineStats[backend.name] = {}
    const br = data.results[backend.name] ?? {}
    for (const bl of baselineOrder) {
      const ids = baselines[bl] ?? []
      const total = ids.length
      const yes = ids.filter((id) => br[id] === "yes" || br[id] === "partial").length
      baselineStats[backend.name]![bl] = { total, yes, pct: total > 0 ? Math.round((yes / total) * 100) : 0 }
    }
  }

  data.baselines = baselines
  data.baselineStats = baselineStats
}
