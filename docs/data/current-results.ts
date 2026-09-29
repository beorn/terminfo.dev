/** A single admission point for published result consumers. */
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { probeHash } from "../../packages/admin/versions.ts"
import { loadSelectedResults, type SelectedProjection, type SelectedVersion } from "./selected-results.ts"
import { parseJsonStrict } from "@terminfo/run-parser"

export interface DefaultContextReview {
  contextKey: string
  reviewer: string
  reason: string
  sources: string[]
}

export interface CurrentResult {
  contextKey: string
  selected: SelectedVersion
  policy?: DefaultContextReview
}

export interface CurrentResults {
  projection: SelectedProjection
}

type TargetKind = SelectedVersion["target"]["kind"]

interface CatalogTarget {
  kind: TargetKind
  slug: string
  headlessBackends: string[]
}

interface CatalogKeys {
  kinds: Map<string, Set<TargetKind>>
  released: Map<string, { key: string; kind: TargetKind }>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function isTargetKind(value: unknown): value is TargetKind {
  return value === "app" || value === "headless" || value === "mux"
}

function isIdList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((id: unknown) => typeof id === "string" && id.length > 0)
}

/** Stable compatibility names come from declarations, never the runs that happen to exist today. */
function loadCatalogKeys(contentDir: string): CatalogKeys {
  const catalogPath = join(contentDir, "terminals.json")
  const rawCatalog = parseJsonStrict(catalogPath, readFileSync(catalogPath, "utf8"))
  if (!isRecord(rawCatalog)) throw new Error(`${catalogPath}: expected terminal catalog object`)
  const catalog = new Map<string, CatalogTarget>()
  const kinds = new Map<string, Set<TargetKind>>()
  const declare = (id: string, kind: TargetKind): void => {
    const declared = kinds.get(id) ?? new Set<TargetKind>()
    declared.add(kind)
    kinds.set(id, declared)
  }
  for (const [id, value] of Object.entries(rawCatalog)) {
    if (!isRecord(value)) throw new Error(`${catalogPath}: invalid ${id} entry`)
    if (value.historical === true) continue
    if (!isTargetKind(value.kind) || typeof value.slug !== "string" || !value.slug) {
      throw new Error(`${catalogPath}: ${id} requires a declared kind and slug`)
    }
    const backends = value.headlessBackends ?? []
    if (!isIdList(backends)) {
      throw new Error(`${catalogPath}: ${id}.headlessBackends must contain IDs`)
    }
    catalog.set(id, { kind: value.kind, slug: value.slug, headlessBackends: backends })
    declare(id, value.kind)
    for (const backend of backends) declare(backend, "headless")
  }

  const snapshotPath = join(import.meta.dirname, "..", "..", "content", "released-v1-keys.json")
  const snapshot = parseJsonStrict(snapshotPath, readFileSync(snapshotPath, "utf8"))
  if (!isRecord(snapshot) || !isRecord(snapshot.keys) || !/^[0-9a-f]{40}$/.test(String(snapshot.sourceRevision))) {
    throw new Error(`${snapshotPath}: invalid released v1 key declaration`)
  }
  const released = new Map<string, { key: string; kind: TargetKind }>()
  for (const [key, value] of Object.entries(snapshot.keys)) {
    if (!isTargetKind(value) || value === "mux") throw new Error(`${snapshotPath}: invalid released kind for ${key}`)
    const matches = [...catalog.entries()].filter(([id, row]) => id === key || row.slug === key)
    if (matches.length !== 1) {
      throw new Error(`${snapshotPath}: released key ${key} has ${matches.length} catalog owners`)
    }
    const owner = matches[0]
    if (!owner) throw new Error(`${snapshotPath}: released key ${key} has no catalog owner`)
    const [id] = owner
    if (!kinds.get(id)?.has(value)) {
      throw new Error(
        `${snapshotPath}: released key ${key} changed meaning from ${value} to catalog ${[...(kinds.get(id) ?? [])].join(", ")}`,
      )
    }
    if (released.has(id)) throw new Error(`${snapshotPath}: multiple released keys name ${id}`)
    released.set(id, { key, kind: value })
  }
  return { kinds, released }
}

function compatibilityKey(kind: TargetKind, id: string, catalog: CatalogKeys): string {
  const declared = catalog.kinds.get(id)
  if (!declared?.has(kind)) throw new Error(`Undeclared compatibility target ${kind}:${id} in terminals.json`)
  const released = catalog.released.get(id)
  const bare = released?.key ?? id
  const owner = released?.kind ?? (declared.has("app") ? "app" : kind)
  return kind === owner ? bare : `${kind}-${bare}`
}

export function loadCurrentResults(contentDir: string, options: { artifactDir?: string } = {}): CurrentResults {
  const projection = loadSelectedResults(contentDir, probeHash(), options)
  return { projection }
}

/** Parse the reviewed choice for a compatibility key without changing v2's complete context map. */
function loadDefaultContextPolicy(contentDir: string): Record<string, DefaultContextReview> {
  const path = join(contentDir, "default-contexts.json")
  if (!existsSync(path)) return {}
  const parsed = parseJsonStrict(path, readFileSync(path, "utf8"))
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${path}: invalid policy object`)
  const rows = (parsed as Record<string, unknown>).defaultContext
  if (!rows || typeof rows !== "object" || Array.isArray(rows)) throw new Error(`${path}: missing defaultContext`)
  const policy: Record<string, DefaultContextReview> = {}
  for (const [id, value] of Object.entries(rows)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path}: invalid ${id} row`)
    const row = value as Record<string, unknown>
    if (
      ![row.contextKey, row.reviewer, row.reason].every((part) => typeof part === "string" && part.length > 0) ||
      !Array.isArray(row.sources) ||
      row.sources.length === 0 ||
      !row.sources.every((source) => typeof source === "string" && source.length > 0)
    ) {
      throw new Error(`${path}: ${id} requires contextKey, reviewer, reason and sources`)
    }
    policy[id] = row as unknown as DefaultContextReview
  }
  return policy
}

/** Compatibility consumers select one reviewed context per kind:id, then derive stable v1/site keys. */
export function compatibilityTargets(projection: SelectedProjection, contentDir: string): Map<string, CurrentResult> {
  const policy = loadDefaultContextPolicy(contentDir)
  const catalog = loadCatalogKeys(contentDir)
  const groups = new Map<string, CurrentResult[]>()
  for (const [contextKey, selected] of Object.entries(projection.current)) {
    const targetKey = `${selected.target.kind}:${selected.target.id}`
    const group = groups.get(targetKey) ?? []
    group.push({ contextKey, selected })
    groups.set(targetKey, group)
  }
  const byTarget = new Map<string, CurrentResult>()
  for (const [targetKey, group] of groups) {
    const review = policy[targetKey]
    if (group.length > 1 && !review) {
      throw new Error(
        `Ambiguous current ${targetKey}: ${group.map((entry) => entry.contextKey).join(", ")}; reviewed defaultContext row required`,
      )
    }
    const chosen = review ? group.find((entry) => entry.contextKey === review.contextKey) : group[0]
    if (!chosen) {
      throw new Error(
        `${join(contentDir, "default-contexts.json")}: ${targetKey} chooses a noncurrent context ${review?.contextKey}`,
      )
    }
    const key = compatibilityKey(chosen.selected.target.kind, chosen.selected.target.id, catalog)
    if (byTarget.has(key)) throw new Error(`Ambiguous compatibility key ${key}: multiple catalog targets`)
    byTarget.set(key, { ...chosen, ...(review && { policy: review }) })
  }
  return byTarget
}
