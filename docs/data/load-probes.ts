/**
 * Shared probe data loader for dynamic route generators.
 *
 * Loads data from probes.data.ts at build time and provides
 * helper functions for slug generation and category labels.
 */
import { readFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import probesLoader from "./probes.data"
import type { ProbeData } from "./probes.data"

export type { ProbeData }

const __dirname = dirname(fileURLToPath(import.meta.url))

let _cached: ProbeData | null = null

export function loadProbes(): ProbeData {
  if (!_cached) _cached = probesLoader.load()
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
}

let _featuresMeta: Record<string, FeatureMeta> | null = null

/** Load features.json with tags and groups (richer than probes featureDescriptions) */
export function loadFeaturesMeta(): Record<string, FeatureMeta> {
  if (!_featuresMeta) {
    try {
      const path = join(__dirname, "..", "..", "content", "features.json")
      const raw = JSON.parse(readFileSync(path, "utf-8")) as Record<string, FeatureMeta>
      delete raw.$comment
      _featuresMeta = raw
    } catch {
      _featuresMeta = {}
    }
  }
  return _featuresMeta!
}

/** Get all unique tags from features.json */
export function getAllTags(): string[] {
  const meta = loadFeaturesMeta()
  const tags = new Set<string>()
  for (const entry of Object.values(meta)) {
    for (const tag of entry.tags ?? []) {
      tags.add(tag)
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

function loadStandards(): Record<string, { label: string; url: string; description: string }> {
  const path = join(__dirname, "..", "..", "content", "standards.json")
  return JSON.parse(readFileSync(path, "utf-8")) as Record<string, { label: string; url: string; description: string }>
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

export function tagLabel(tag: string): string {
  return tagLabels[tag] ?? tag.charAt(0).toUpperCase() + tag.slice(1).replace(/-/g, " ")
}
