/**
 * ONE loader for the content catalogs — `content/features.json` and `content/terminals.json`.
 *
 * Every reader on both sides of the docs/scripts boundary imports these two functions, so a
 * catalog field has a single parse, a single shape and a single set of defaults. Before this
 * module, features.json was read from 17 non-test files and terminals.json from 14, each with its
 * own JSON.parse, its own `$comment` handling and its own idea of which fields are required
 * (@cto verdict 2026-10-12, read-side consolidation item 2).
 *
 * The loader is strict: a defect throws with the path and the entry that carries it, never a
 * partially-typed record. Results are cached per absolute content directory, so the 16 parses
 * collapse to one per directory per process.
 *
 * `content/categories.json` is deliberately NOT here — it already has one owner
 * (`docs/data/categories.ts`), and folding it in belongs to the separate layer-loop work.
 *
 * Writers that read-modify-write a catalog as raw JSON — `scripts/watch-releases.ts` (terminals)
 * and `scripts/candidates.ts` (features) — keep their own read, because they round-trip fields this
 * loader does not model (`latestRelease`). This module is the ONE reader's door, not the writer's.
 */
import { existsSync, readFileSync } from "node:fs"
import { isAbsolute, join } from "node:path"
import { parseJsonStrict } from "@terminfo/run-parser"

/** One feature catalog entry, keyed by its probe dot-path id in `content/features.json`. */
export interface FeatureRecord {
  name: string
  slug: string
  body: string
  probe: string
  baseline: string
  url?: string
  tags?: string[]
  sequence?: string
  group?: string
  probeStatus?: string
}

export type FeatureCatalog = Readonly<Record<string, FeatureRecord>>

/** One terminal catalog entry, keyed by its terminal id in `content/terminals.json`. */
export interface TerminalRecord {
  label: string
  slug: string
  url: string
  description: string
  body: string
  kind?: string
  headlessBackends?: string[]
  manifestBackend?: string
  platforms?: string[]
  repo?: string
  intermediary?: boolean
  historical?: boolean
  year?: number
  manufacturer?: string
  significance?: string
  cpu?: string
}

export type TerminalCatalog = Readonly<Record<string, TerminalRecord>>

const cache = new Map<string, unknown>()

/** Parse one catalog file into a record of entries, dropping `$`-prefixed comment keys. */
function readObject(contentDir: string, fileName: string): Record<string, unknown> {
  if (!isAbsolute(contentDir)) throw new Error(`Content directory must be absolute: ${contentDir}`)
  const path = join(contentDir, fileName)
  if (!existsSync(path)) throw new Error(`Missing required content catalog: ${path}`)
  let root: unknown
  try {
    root = parseJsonStrict(path, readFileSync(path, "utf-8"))
  } catch (cause) {
    throw new Error(`${path}: required content catalog could not be read or parsed`, { cause })
  }
  if (root === null || typeof root !== "object" || Array.isArray(root)) {
    throw new Error(`${path}: expected a catalog object`)
  }
  return root as Record<string, unknown>
}

function requireString(path: string, id: string, field: string, value: unknown): string {
  if (typeof value !== "string" || value === "") {
    throw new Error(`${path}: entry "${id}" is missing a non-empty "${field}"`)
  }
  return value
}

function optionalString(path: string, id: string, field: string, value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== "string") throw new Error(`${path}: entry "${id}" has a non-string "${field}"`)
  return value
}

function optionalStringArray(path: string, id: string, field: string, value: unknown): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${path}: entry "${id}" has a non-string-array "${field}"`)
  }
  return value as string[]
}

function optionalBoolean(path: string, id: string, field: string, value: unknown): boolean | undefined {
  if (value === undefined) return undefined
  if (typeof value !== "boolean") throw new Error(`${path}: entry "${id}" has a non-boolean "${field}"`)
  return value
}

function optionalNumber(path: string, id: string, field: string, value: unknown): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== "number" || Number.isNaN(value)) {
    throw new Error(`${path}: entry "${id}" has a non-number "${field}"`)
  }
  return value
}

function entries(path: string, root: Record<string, unknown>): Array<[string, Record<string, unknown>]> {
  const out: Array<[string, Record<string, unknown>]> = []
  for (const [id, value] of Object.entries(root)) {
    if (id.startsWith("$")) continue
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`${path}: entry "${id}" is not an object`)
    }
    out.push([id, value as Record<string, unknown>])
  }
  return out
}

function parseFeature(path: string, id: string, raw: Record<string, unknown>): FeatureRecord {
  return {
    name: requireString(path, id, "name", raw.name),
    slug: requireString(path, id, "slug", raw.slug),
    body: requireString(path, id, "body", raw.body),
    probe: requireString(path, id, "probe", raw.probe),
    baseline: requireString(path, id, "baseline", raw.baseline),
    url: optionalString(path, id, "url", raw.url),
    tags: optionalStringArray(path, id, "tags", raw.tags),
    sequence: optionalString(path, id, "sequence", raw.sequence),
    group: optionalString(path, id, "group", raw.group),
    probeStatus: optionalString(path, id, "probeStatus", raw.probeStatus),
  }
}

function parseTerminal(path: string, id: string, raw: Record<string, unknown>): TerminalRecord {
  return {
    label: requireString(path, id, "label", raw.label),
    slug: requireString(path, id, "slug", raw.slug),
    url: requireString(path, id, "url", raw.url),
    description: requireString(path, id, "description", raw.description),
    body: requireString(path, id, "body", raw.body),
    kind: optionalString(path, id, "kind", raw.kind),
    headlessBackends: optionalStringArray(path, id, "headlessBackends", raw.headlessBackends),
    manifestBackend: optionalString(path, id, "manifestBackend", raw.manifestBackend),
    platforms: optionalStringArray(path, id, "platforms", raw.platforms),
    repo: optionalString(path, id, "repo", raw.repo),
    intermediary: optionalBoolean(path, id, "intermediary", raw.intermediary),
    historical: optionalBoolean(path, id, "historical", raw.historical),
    year: optionalNumber(path, id, "year", raw.year),
    manufacturer: optionalString(path, id, "manufacturer", raw.manufacturer),
    significance: optionalString(path, id, "significance", raw.significance),
    cpu: optionalString(path, id, "cpu", raw.cpu),
  }
}

/** Load `content/features.json` from an absolute content directory. Cached per directory. */
export function loadFeatures(contentDir: string): FeatureCatalog {
  const cacheKey = `${contentDir}#features`
  const cached = cache.get(cacheKey)
  if (cached) return cached as FeatureCatalog
  const path = join(contentDir, "features.json")
  const root = readObject(contentDir, "features.json")
  const catalog: Record<string, FeatureRecord> = {}
  for (const [id, raw] of entries(path, root)) catalog[id] = parseFeature(path, id, raw)
  const frozen = Object.freeze(catalog)
  cache.set(cacheKey, frozen)
  return frozen
}

/** Load `content/terminals.json` from an absolute content directory. Cached per directory. */
export function loadTerminals(contentDir: string): TerminalCatalog {
  const cacheKey = `${contentDir}#terminals`
  const cached = cache.get(cacheKey)
  if (cached) return cached as TerminalCatalog
  const path = join(contentDir, "terminals.json")
  const root = readObject(contentDir, "terminals.json")
  const catalog: Record<string, TerminalRecord> = {}
  for (const [id, raw] of entries(path, root)) catalog[id] = parseTerminal(path, id, raw)
  const frozen = Object.freeze(catalog)
  cache.set(cacheKey, frozen)
  return frozen
}
