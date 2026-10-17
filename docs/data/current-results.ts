/** A single admission point for published result consumers. */
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { probeHash } from "../../packages/admin/versions.ts"
import {
  loadSelectedResults,
  maskRunnerStorePath,
  type SelectedProjection,
  type SelectedVersion,
  statesFor,
} from "./selected-results.ts"
import { frozenSuiteIdFor } from "./load-release-scope.ts"
import { candidateFromSelected, pickContextRun } from "./run-selection.ts"
import { parseJsonStrict } from "@terminfo/run-parser"
import { loadTerminals } from "@terminfo/catalog"

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
  const rawCatalog = loadTerminals(contentDir)
  const catalog = new Map<string, CatalogTarget>()
  const kinds = new Map<string, Set<TargetKind>>()
  const declare = (id: string, kind: TargetKind): void => {
    const declared = kinds.get(id) ?? new Set<TargetKind>()
    declared.add(kind)
    kinds.set(id, declared)
  }
  for (const [id, value] of Object.entries(rawCatalog)) {
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

/**
 * The projection is the ONE read of the committed corpus, and it is expensive: it parses every run,
 * verifies every screenshot digest and classifies every cell. Each published consumer used to call the
 * reader for itself, so one `bun run build` read the same corpus once per consumer (measured 2026-10-12:
 * sixteen times) when it needed one read (28792 item 1 — project once per build).
 *
 * The memo cannot live at module scope: VitePress bundles each data loader's module graph separately
 * (seven `*.paths.ts` files, `probes.data.ts`, `candidate-2.data.ts` and `config.ts` each carry their
 * own copy of this module), so a module-level Map would still read the corpus once per BUNDLE. The
 * cache therefore hangs off `globalThis` under a registered symbol, which every copy in one process
 * shares — the corpus is read once per process.
 *
 * The cache never outlives its process: content/ is read with `node:fs`, not imported, so a consumer
 * asks a new process for new data (a site build, a CLI run) — the same freshness the reader had before
 * this cache, since VitePress never watched content/. Nothing goes stale silently.
 */
const RESULTS_CACHE = Symbol.for("terminfo.dev/currentResultsCache")
const cacheHost = globalThis as unknown as { [k: symbol]: Map<string, CurrentResults> | undefined }

function currentResultsCache(): Map<string, CurrentResults> {
  return (cacheHost[RESULTS_CACHE] ??= new Map())
}

export function loadCurrentResults(
  contentDir: string,
  options: { artifactDir?: string; releaseSuiteId?: string } = {},
): CurrentResults {
  // A reading may be taken on another cohort's freeze (candidate 2 reads the c240 suite candidate 4
  // froze). The caller that holds that suite names it here, so one home decides it; otherwise the
  // registry is read and throws loudly when it names no suite.
  const releaseSuiteId = options.releaseSuiteId ?? releaseSuiteIdFor(contentDir)
  const key = `${contentDir}\u0000${probeHash()}\u0000${options.artifactDir ?? ""}\u0000${releaseSuiteId}`
  const cache = currentResultsCache()
  const memoized = cache.get(key)
  if (memoized) return memoized
  const projection = loadSelectedResults(contentDir, probeHash(), { ...options, releaseSuiteId })
  const results: CurrentResults = { projection }
  cache.set(key, results)
  return results
}

/**
 * The release suite this content pins: the one suite manifest whose `freeze.release` names the
 * Release 1 candidate (`frozenSuiteIdFor`, item 3). The pointer is REQUIRED and read from the suite
 * registry, so it can never name a missing manifest: without it every run measured on the release
 * suite would be relabelled "older suite" and the tree-move banner would vanish.
 */
function releaseSuiteIdFor(contentDir: string): string {
  return frozenSuiteIdFor(contentDir, "candidate2")
}

/**
 * Parse the reviewed choice for a compatibility key without changing v2's complete context map. Also
 * consumed by `scripts/decisive-share.ts`, so the bar reader resolves a multi-current tie by the SAME
 * reviewed row `compatibilityTargets` applies — one policy source, not a second parser.
 */
export function loadDefaultContextPolicy(contentDir: string): Record<string, DefaultContextReview> {
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
    // Normalize the reviewed key by the same rule the projection uses, so a row recorded before a
    // re-collect (with the era's runner store path in its key) still chooses the context it reviewed
    // (27929 D5). See maskRunnerStorePath.
    policy[id] = {
      ...(row as unknown as DefaultContextReview),
      contextKey: maskRunnerStorePath(row.contextKey) as string,
    }
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
    // The one run-selection rule; this site and the decisive-share reader must not hold two copies.
    const byKey = new Map(group.map((entry) => [entry.contextKey, entry]))
    const picked = pickContextRun(
      group.map((entry) =>
        candidateFromSelected(entry.contextKey, entry.selected, statesFor(projection, entry.selected.runId)),
      ),
      review,
    )
    if (picked === undefined) throw new Error(`No current run for ${targetKey}`)
    if ("ambiguous" in picked) {
      throw new Error(
        `Ambiguous current ${targetKey}: ${picked.ambiguous.join(", ")}; reviewed defaultContext row required`,
      )
    }
    if (review && picked.selection !== "reviewed default-context row") {
      throw new Error(
        `${join(contentDir, "default-contexts.json")}: ${targetKey} chooses a noncurrent context ${review.contextKey}`,
      )
    }
    // pickContextRun returns one of the candidates it was given, so this lookup cannot miss.
    const chosen = byKey.get(picked.run.key)
    if (!chosen) throw new Error(`Selected run ${picked.run.key} is not among ${targetKey} current contexts`)
    const key = compatibilityKey(chosen.selected.target.kind, chosen.selected.target.id, catalog)
    if (byTarget.has(key)) throw new Error(`Ambiguous compatibility key ${key}: multiple catalog targets`)
    byTarget.set(key, { ...chosen, ...(review && { policy: review }) })
  }
  return byTarget
}
