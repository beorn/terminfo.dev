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
  /**
   * The tier-1 Release 1 label. Only the 62 declared rows carry it: `included` for the 52 that are
   * scored, `excluded` for the ten silent-consumed or fixture-gated OSC rows the 27832 audit names.
   * Every other row's slice is its category's slice — see `slice()`.
   */
  tier1?: Tier1
  probeStatus?: string
  /** Why a reviewed probeStatus override is what it is; required beside any override. */
  probeStatusReason?: string
}

export type FeatureCatalog = Readonly<Record<string, FeatureRecord>>

/** The two tier-1 labels a declared Release 1 row can carry. */
export type Tier1 = "included" | "excluded"

export const TIER1_VALUES: readonly Tier1[] = ["included", "excluded"]

/**
 * A feature's slice — the scope label the cohorts and scopes filter over. `tier1` is never stored on
 * the row; it is what `slice()` returns for a row that carries a `tier1` field, so a slice can never
 * disagree with the category it came from.
 */
export type Slice = "tier1" | "classics" | "extensions" | "input" | "modes" | "device"

export const SLICES: readonly Slice[] = ["tier1", "classics", "extensions", "input", "modes", "device"]

/** The only fact `slice()` needs from a category: its slice label. */
export interface SliceCategory {
  slice: Slice
}

export type SliceCatalog = Readonly<Record<string, SliceCategory>>

/** One terminal catalog entry, keyed by its terminal id in `content/terminals.json`. */
export interface TerminalRecord {
  label: string
  slug: string
  url: string
  description: string
  body: string
  kind?: string
  headlessBackends?: string[]
  /** Label of the headless backend that shares this entry's id: the app's own core, measured without the app. */
  headlessLabel?: string
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

/** The label of the headless backend sharing this entry's id, which the entry must itself list as measured. */
function optionalHeadlessLabel(
  path: string,
  id: string,
  value: unknown,
  backends: string[] | undefined,
): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== "string" || value === "") {
    throw new Error(`${path}: entry "${id}" has a "headlessLabel" that is not a non-empty string`)
  }
  if (!backends?.includes(id)) {
    throw new Error(`${path}: entry "${id}" has a "headlessLabel" but does not list "${id}" in "headlessBackends"`)
  }
  return value
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

function optionalTier1(path: string, id: string, value: unknown): Tier1 | undefined {
  if (value === undefined) return undefined
  if (!TIER1_VALUES.includes(value as Tier1)) {
    throw new Error(
      `${path}: entry "${id}" has an invalid tier1 "${String(value)}"; expected ${TIER1_VALUES.join(" or ")}`,
    )
  }
  return value as Tier1
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
    tier1: optionalTier1(path, id, raw.tier1),
    probeStatus: optionalString(path, id, "probeStatus", raw.probeStatus),
    probeStatusReason: optionalString(path, id, "probeStatusReason", raw.probeStatusReason),
  }
}

function parseTerminal(path: string, id: string, raw: Record<string, unknown>): TerminalRecord {
  const headlessBackends = optionalStringArray(path, id, "headlessBackends", raw.headlessBackends)
  // Catalog bytes retain historical kind labels; consumers use canonical subject kinds.
  const historicalKind = optionalString(path, id, "kind", raw.kind)
  const kind = historicalKind === "app" ? "term" : historicalKind === "headless" ? "lib" : historicalKind
  return {
    label: requireString(path, id, "label", raw.label),
    slug: requireString(path, id, "slug", raw.slug),
    url: requireString(path, id, "url", raw.url),
    description: requireString(path, id, "description", raw.description),
    body: requireString(path, id, "body", raw.body),
    kind,
    headlessBackends,
    headlessLabel: optionalHeadlessLabel(path, id, raw.headlessLabel, headlessBackends),
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

type LabelSource = Readonly<Record<string, Pick<TerminalRecord, "label" | "kind" | "headlessLabel">>>

/**
 * The catalog's name for headless backend `id`: its entry's `headlessLabel`, else that entry's label
 * when the entry is itself a headless engine. Undefined when the catalog does not name it.
 */
export function headlessName(terminals: LabelSource, id: string): string | undefined {
  const entry = terminals[id]
  return entry?.headlessLabel ?? (entry?.kind === "lib" ? entry.label : undefined)
}

/**
 * The display name of catalog id `id` measured as `kind` on a page of its own: the catalog's headless
 * name for a headless target, else the entry label (or `fallback`) qualified by the kind.
 */
export function subjectLabel(terminals: LabelSource, id: string, kind: string, fallback: string = id): string {
  return (kind === "lib" ? headlessName(terminals, id) : undefined) ?? `${terminals[id]?.label ?? fallback} (${kind})`
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

/**
 * The ONE slice function: `tier1` when the feature carries a tier1 field, otherwise its category's
 * slice. It is a function, never a stored field, so a row's slice can never disagree with the
 * category it belongs to (and storing it on all 273 rows would need a drift check). Cohorts and
 * scopes are filters over this label.
 */
export function slice(features: FeatureCatalog, categories: SliceCatalog, id: string): Slice {
  const feature = features[id]
  if (!feature) throw new Error(`slice(): no feature "${id}" in the catalog`)
  if (feature.tier1 !== undefined) return "tier1"
  const key = id.split(".")[0] ?? ""
  const category = categories[key]
  if (!category) throw new Error(`slice(): feature "${id}" has prefix "${key}", which is not a category`)
  return category.slice
}
