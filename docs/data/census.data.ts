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

const __dirname = dirname(fileURLToPath(import.meta.url))
const resultsDir = join(__dirname, "results")

export interface BackendInfo {
  name: string
  version: string
  engine: string
}

export interface FeatureResult {
  id: string
  name: string
  category: string
  spec?: string
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
  generated: string
}

declare const data: CensusData
export { data }

export default {
  load(): CensusData {
    // Try unified census.json first (primary source)
    const unifiedPath = join(resultsDir, "census.json")
    if (existsSync(unifiedPath)) {
      return loadUnifiedCensus(unifiedPath)
    }

    // Try per-backend JSON files as fallback
    return loadPerBackendResults()
  },
}

function loadUnifiedCensus(path: string): CensusData {
  const raw = JSON.parse(readFileSync(path, "utf-8"))

  const backends: BackendInfo[] = Object.values(raw.backends ?? {})
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
    generated: raw.generated ?? "",
  }
}

function loadPerBackendResults(): CensusData {
  let files: string[]
  try {
    files = readdirSync(resultsDir).filter((f) => f.endsWith(".json") && f !== "census.json")
  } catch {
    return emptyData()
  }

  if (files.length === 0) return emptyData()

  // Each file is a per-backend result
  const allBackends: BackendInfo[] = []
  const results: Record<string, Record<string, string>> = {}
  const notes: Record<string, Record<string, string>> = {}
  const featureSet = new Map<string, FeatureResult>()

  for (const file of files) {
    try {
      const raw = JSON.parse(readFileSync(join(resultsDir, file), "utf-8"))
      if (!raw.backend) continue
      allBackends.push({
        name: raw.backend,
        version: raw.version ?? "",
        engine: raw.engine ?? "",
      })
      results[raw.backend] = {}
      notes[raw.backend] = {}
      for (const [id, val] of Object.entries(raw.results ?? {})) {
        const v = val as any
        results[raw.backend][id] = typeof v === "boolean" ? (v ? "yes" : "no") : (v.support ?? "unknown")
        if (v.notes) notes[raw.backend][id] = v.notes
        if (!featureSet.has(id)) {
          featureSet.set(id, {
            id,
            name: id,
            category: id.split("-")[0],
          })
        }
      }
    } catch {
      // skip malformed
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

  return { backends: allBackends, features, categories, results, notes, stats, generated }
}

function emptyData(): CensusData {
  return {
    backends: [],
    features: [],
    categories: {},
    results: {},
    notes: {},
    stats: {},
    generated: "",
  }
}
