/**
 * VitePress build-time data loader for census results.
 *
 * Reads the unified census.json (copied from Termless during build/deploy)
 * and reshapes it for the matrix page.
 *
 * Consumed via: import { data } from './data/census.data'
 */
import { readFileSync, existsSync, readdirSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { manifest } from "@termless/core"

const __dirname = dirname(fileURLToPath(import.meta.url))
const resultsDir = join(__dirname, "results")

export interface BackendInfo {
  name: string
  version: string
  engine: string
  type?: "app" | "headless"
}

export interface FeatureResult {
  id: string
  name: string
  category: string
  spec?: string
}

export interface BackendMeta {
  label?: string
  description?: string
  url?: string
  upstream?: string
  type?: string
  caveat?: string
  slug?: string
}

export interface CensusData {
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
}

function loadFeatureDescriptions(): Record<string, FeatureMeta> {
  const path = join(__dirname, "..", "..", "features.json")
  if (!existsSync(path)) {
    throw new Error(`features.json not found at ${path}`)
  }
  {
    const raw = JSON.parse(readFileSync(path, "utf-8"))
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
        }
      }
    }
    return result
  }
}

function loadAnnotations(): Record<string, { note: string; url?: string; result?: string }> {
  const annotationsPath = join(__dirname, "..", "..", "annotations.json")
  if (!existsSync(annotationsPath)) {
    throw new Error(`annotations.json not found at ${annotationsPath}`)
  }
  return JSON.parse(readFileSync(annotationsPath, "utf-8"))
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
    }
  }
  return meta
}

declare const data: CensusData
export { data }

export default {
  load(): CensusData {
    // Load app (community) results as primary — these test real terminals
    const appData = loadAppResults()

    // Load headless results as fallback for terminals without app results
    let headlessData: CensusData
    const unifiedPath = join(resultsDir, "census.json")
    if (existsSync(unifiedPath)) {
      headlessData = loadUnifiedCensus(unifiedPath)
    } else {
      headlessData = loadPerBackendResults()
    }

    // If we have app results, merge them as primary
    if (appData.backends.length > 0) {
      return mergeResults(appData, headlessData)
    }

    // Fallback to headless only
    return headlessData
  },
}

/** Merge app results (primary) with headless results (fallback for missing terminals) */
function mergeResults(app: CensusData, headless: CensusData): CensusData {
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
      if (headless.meta[hb.name]) merged.meta[hb.name] = headless.meta[hb.name]
    }
  }

  return merged
}

function headlessToAppName(backend: string): string {
  const map: Record<string, string> = {
    xtermjs: "com.microsoft.VSCode",
    "ghostty-native": "ghostty",
    kitty: "kitty",
  }
  return map[backend] ?? backend
}

/** Load community/app results from docs/data/results/app/ */
function loadAppResults(): CensusData {
  const appDir = join(resultsDir, "app")
  let files: string[]
  try {
    files = readdirSync(appDir).filter((f) => f.endsWith(".json"))
  } catch {
    return emptyData()
  }
  if (files.length === 0) return emptyData()

  // Keep only latest result per terminal
  const latest = new Map<string, any>()
  for (const file of files) {
    try {
      const raw = JSON.parse(readFileSync(join(appDir, file), "utf-8"))
      if (!raw.terminal || !raw.results) continue
      const key = raw.terminal
      if (!latest.has(key) || (raw.generated ?? "") > (latest.get(key).generated ?? "")) {
        latest.set(key, raw)
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
    })
    results[name] = {}
    notes[name] = {}
    for (const [id, val] of Object.entries(raw.results ?? {})) {
      results[name][id] = val ? "yes" : "no"
      if (raw.notes?.[id]) notes[name][id] = raw.notes[id]
      if (!featureSet.has(id)) {
        const cat = id.split(".")[0]
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
    categories[f.category].push(f)
  }

  const stats: CensusData["stats"] = {}
  for (const b of allBackends) {
    const entries = Object.values(results[b.name])
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
    generated: new Date().toISOString(),
  }
}

function buildAppMeta(terminal: string): BackendMeta {
  const labels: Record<string, string> = {
    ghostty: "Ghostty",
    kitty: "Kitty",
    iterm2: "iTerm2",
    "terminal-app": "Terminal.app",
    warp: "Warp",
    cmux: "cmux",
    cursor: "Cursor",
    "com.microsoft.VSCode": "VS Code",
    "com.todesktop.230313mzl4w4u92": "Cursor",
  }
  const slugs: Record<string, string> = {
    ghostty: "ghostty",
    kitty: "kitty",
    iterm2: "iterm2",
    "terminal-app": "terminal-app",
    warp: "warp",
    cmux: "cmux",
    cursor: "cursor",
    "com.microsoft.VSCode": "vscode",
    "com.todesktop.230313mzl4w4u92": "cursor",
  }
  return {
    label: labels[terminal] ?? terminal,
    slug: slugs[terminal] ?? terminal.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
    description: `${labels[terminal] ?? terminal} terminal emulator`,
  }
}

function loadUnifiedCensus(path: string): CensusData {
  const raw = JSON.parse(readFileSync(path, "utf-8"))

  const backends: BackendInfo[] = (Object.values(raw.backends ?? {}) as BackendInfo[]).map((b) => ({
    ...b,
    type: "headless" as const,
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
    categories[f.category].push(f)
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
      results[backendName][f.id] = r.support ?? "unknown"
      if (r.notes) notes[backendName][f.id] = r.notes
    }
  }

  // Load annotations and merge into notes + apply result overrides
  const annotations = loadAnnotations()
  for (const [key, ann] of Object.entries(annotations)) {
    const [backend, ...featureParts] = key.split(":")
    const feature = featureParts.join(":")
    if (!notes[backend]) notes[backend] = {}
    // Annotation note replaces the auto-generated note
    notes[backend][feature] = ann.note
    // Annotation can override the probe result (e.g., "partial" for headless API gaps)
    if (ann.result && results[backend]) {
      results[backend][feature] = ann.result
    }
  }

  // Compute per-backend stats
  const stats: CensusData["stats"] = {}
  for (const name of backendNames) {
    const entries = Object.values(results[name])
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
    generated: raw.generated ?? "",
  }
}

function loadPerBackendResults(): CensusData {
  let files: string[]
  try {
    files = readdirSync(resultsDir).filter((f) => f.endsWith(".json") && f !== "census.json")
  } catch (err) {
    throw new Error(`Failed to read census results from ${resultsDir}: ${err}`)
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
      const raw = JSON.parse(readFileSync(join(resultsDir, file), "utf-8"))
      if (!raw.backend) continue
      allBackends.push({
        name: raw.backend,
        version: raw.version ?? "",
        engine: raw.engine ?? "",
        type: "headless",
      })
      results[raw.backend] = {}
      notes[raw.backend] = {}
      const rawNotes = raw.notes ?? {}
      for (const [id, val] of Object.entries(raw.results ?? {})) {
        results[raw.backend][id] = typeof val === "boolean" ? (val ? "yes" : "no") : ((val as any).support ?? "unknown")
        if (rawNotes[id]) notes[raw.backend][id] = rawNotes[id]
        if (!featureSet.has(id)) {
          const cat = id.split(".")[0]
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
      throw new Error(`Failed to parse census result ${file}: ${err}`)
    }
  }

  allBackends.sort((a, b) => a.name.localeCompare(b.name))
  const features = Array.from(featureSet.values()).sort((a, b) => a.id.localeCompare(b.id))

  const categories: Record<string, FeatureResult[]> = {}
  for (const f of features) {
    if (!categories[f.category]) categories[f.category] = []
    categories[f.category].push(f)
  }

  const stats: CensusData["stats"] = {}
  for (const b of allBackends) {
    const entries = Object.values(results[b.name])
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
    if (notes[backend]) notes[backend][feature] = ann.note
    // Apply result overrides from annotations
    if (ann.result && results[backend]) results[backend][feature] = ann.result
  }

  // Recompute stats after overrides
  for (const b of allBackends) {
    const entries = Object.values(results[b.name])
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
    generated,
  }
}

function emptyData(): CensusData {
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
    generated: "",
  }
}
