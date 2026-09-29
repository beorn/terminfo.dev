/**
 * Shared probe data loader for dynamic route generators.
 *
 * Loads data from probes.data.ts at build time and provides
 * helper functions for slug generation and category labels.
 */
import { readFileSync, existsSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { loadFullProbes } from "./probes.data"
import type { ProbeData } from "./probes.data"
import { generateAnalysis } from "../../scripts/generate-analysis.ts"

export type { ProbeData }

const __dirname = dirname(fileURLToPath(import.meta.url))

let _cached: ProbeData | null = null

export function loadProbes(): ProbeData {
  if (!_cached) _cached = loadFullProbes()
  return _cached
}

/** @deprecated Use loadProbes() */
export const loadCensus = loadProbes

export interface FeatureMeta {
  name: string
  slug?: string
  url?: string
  tags?: string[]
  group?: string
  body?: string
  probe?: string
  baseline?: string
  probeStatus?: string
  sequence?: string
}

let _featuresMeta: Record<string, FeatureMeta> | null = null

/** Load features.json with tags and groups (richer than probes featureDescriptions) */
export function loadFeaturesMeta(): Record<string, FeatureMeta> {
  if (_featuresMeta) return _featuresMeta
  const path = join(__dirname, "..", "..", "content", "features.json")
  try {
    const raw: unknown = JSON.parse(readFileSync(path, "utf-8"))
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error("Expected a feature metadata object")
    }
    const metadata = raw as Record<string, FeatureMeta>
    delete metadata.$comment
    _featuresMeta = metadata
    return metadata
  } catch (cause) {
    throw new Error(`${path}: required feature metadata could not be read or parsed`, { cause })
  }
}

/** Get all unique tags from features.json, validating against standards.json */
export function getAllTags(): string[] {
  const meta = loadFeaturesMeta()
  const standards = loadStandards()
  const validTags = new Set(Object.keys(standards))
  const tags = new Set<string>()
  for (const [id, entry] of Object.entries(meta)) {
    for (const tag of entry.tags ?? []) {
      tags.add(tag)
      if (!validTags.has(tag)) {
        console.warn(
          `[tags] WARNING: feature "${id}" uses unknown tag "${tag}" — ` +
            `add it to standards.json or use an existing tag: ${[...validTags].sort().join(", ")}`,
        )
      }
    }
  }
  return [...tags].sort()
}

/** Get feature IDs that have a given tag */
export function getFeaturesForTag(tag: string): string[] {
  const meta = loadFeaturesMeta()
  return Object.entries(meta)
    .filter(([_, entry]) => entry.tags?.includes(tag))
    .map(([id]) => id)
}

/** Convert feature dot-path ID to URL slug, using features.json slug if available */
export function featureSlug(id: string): string {
  const meta = loadFeaturesMeta()
  return meta[id]?.slug ?? id.replaceAll(".", "-")
}

/**
 * Convert backend name to a URL-friendly terminal slug using the label.
 * ghostty-native -> ghostty, xtermjs -> xterm-js, ghostty (WASM) -> ghostty-wasm
 */
export function terminalSlug(name: string, meta: ProbeData["meta"]): string {
  if (meta[name]?.slug === name) return name
  const label = (meta[name]?.label ?? name).toLowerCase()
  return label.replace(/[^a-z0-9]+/g, "-").replace(/-+$/, "")
}

function loadCategories(): Record<string, { label: string; order: number; description: string }> {
  const path = join(__dirname, "..", "..", "content", "categories.json")
  return JSON.parse(readFileSync(path, "utf-8")) as Record<
    string,
    { label: string; order: number; description: string }
  >
}

export const categoryLabels: Record<string, string> = Object.fromEntries(
  Object.entries(loadCategories()).map(([k, v]) => [k, v.label]),
)

export function catLabel(cat: string): string {
  return categoryLabels[cat] ?? cat.charAt(0).toUpperCase() + cat.slice(1)
}

export const categoryDescriptions: Record<string, string> = Object.fromEntries(
  Object.entries(loadCategories()).map(([k, v]) => [k, v.description]),
)

function loadStandards(): Record<string, { label: string; url: string; description: string; body?: string }> {
  const path = join(__dirname, "..", "..", "content", "standards.json")
  return JSON.parse(readFileSync(path, "utf-8")) as Record<
    string,
    { label: string; url: string; description: string; body?: string }
  >
}

export const tagLabels: Record<string, string> = Object.fromEntries(
  Object.entries(loadStandards()).map(([k, v]) => [k, v.label]),
)

export const tagUrls: Record<string, string> = Object.fromEntries(
  Object.entries(loadStandards()).map(([k, v]) => [k, v.url]),
)

export const tagDescriptions: Record<string, string> = Object.fromEntries(
  Object.entries(loadStandards()).map(([k, v]) => [k, v.description]),
)

export const tagBodies: Record<string, string> = Object.fromEntries(
  Object.entries(loadStandards()).map(([k, v]) => [k, v.body ?? ""]),
)

export function tagLabel(tag: string): string {
  return tagLabels[tag] ?? tag.charAt(0).toUpperCase() + tag.slice(1).replace(/-/g, " ")
}

export interface AnalysisEntry {
  analysis: string
  date: string
  changes?: string | null
  runSha256?: string
  measuredAt?: string
  counts?: { conclusive: number; supported: number; unsupported: number }
}

let _analysisCached: Record<string, AnalysisEntry> | null = null

/** Regenerate analysis from the same selected runs as the matrix. The checked-in snapshot is historical. */
export function loadAnalysis(): Record<string, AnalysisEntry> {
  if (!_analysisCached) {
    const path = join(__dirname, "..", "..", "content", "analysis.json")
    if (existsSync(path)) console.warn(`${path}: historical analysis snapshot is not current evidence; regenerating`)
    _analysisCached = generateAnalysis()
  }
  if (!_analysisCached) throw new Error("Analysis failed to initialize")
  return _analysisCached
}

export interface PlatformSource {
  label: string
  url: string
}

export interface PlatformGap {
  label: string
  url: string
  type: string
  note: string
}

export interface PlatformMeta {
  label: string
  slug: string
  tagline: string
  description: string
  appTerminalIds: string[]
  parserBackendIds: string[]
  multiplexerIds: string[]
  untrackedTerminals: PlatformGap[]
  notes: string[]
  sources: PlatformSource[]
}

let _platformsCached: Record<string, PlatformMeta> | null = null

/** Load content/platforms.json — curated platform metadata for /os pages */
export function loadPlatformsMeta(): Record<string, PlatformMeta> {
  if (!_platformsCached) {
    const path = join(__dirname, "..", "..", "content", "platforms.json")
    const raw = JSON.parse(readFileSync(path, "utf-8")) as Record<string, PlatformMeta>
    delete (raw as Record<string, unknown>).$comment
    _platformsCached = raw
  }
  return _platformsCached
}
