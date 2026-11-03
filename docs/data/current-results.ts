/** A single admission point for published result consumers. */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { probeHash } from "../../packages/admin/versions.ts"
import {
  loadSelectedResults,
  type SelectedProjection,
  type SelectedVersion,
  type SelectedAttemptInput,
  type SelectedContextSummary,
  statesFor,
} from "./selected-results.ts"
import { candidateFromSelected, pickContextRun } from "./run-selection.ts"
import { parseJsonStrict, type LoadedRun } from "@terminfo/run-parser"
import { loadTerminals } from "@terminfo/catalog"

export interface CurrentResult {
  contextKey: string
  selected: SelectedContextSummary
}

export interface CurrentResults {
  projection: SelectedProjection
}

type SubjectKind = SelectedVersion["subject"]["kind"]

interface CatalogSubject {
  kind: SubjectKind
  slug: string
  headlessBackends: string[]
}

interface CatalogKeys {
  kinds: Map<string, Set<SubjectKind>>
  released: Map<string, { key: string; kind: SubjectKind }>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function isSubjectKind(value: unknown): value is SubjectKind {
  return value === "term" || value === "lib" || value === "mux"
}

function isIdList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((id: unknown) => typeof id === "string" && id.length > 0)
}

/** Stable compatibility names come from declarations, never the runs that happen to exist today. */
function loadCatalogKeys(contentDir: string): CatalogKeys {
  const catalogPath = join(contentDir, "terminals.json")
  const rawCatalog = loadTerminals(contentDir)
  const catalog = new Map<string, CatalogSubject>()
  const kinds = new Map<string, Set<SubjectKind>>()
  const declare = (id: string, kind: SubjectKind): void => {
    const declared = kinds.get(id) ?? new Set<SubjectKind>()
    declared.add(kind)
    kinds.set(id, declared)
  }
  for (const [id, value] of Object.entries(rawCatalog)) {
    if (value.historical === true) continue
    if (!isSubjectKind(value.kind) || typeof value.slug !== "string" || !value.slug) {
      throw new Error(`${catalogPath}: ${id} requires a declared kind and slug`)
    }
    const backends = value.headlessBackends ?? []
    if (!isIdList(backends)) {
      throw new Error(`${catalogPath}: ${id}.headlessBackends must contain IDs`)
    }
    catalog.set(id, { kind: value.kind, slug: value.slug, headlessBackends: backends })
    declare(id, value.kind)
    for (const backend of backends) declare(backend, "lib")
  }

  const snapshotPath = join(import.meta.dirname, "..", "..", "content", "released-v1-keys.json")
  const snapshot = parseJsonStrict(snapshotPath, readFileSync(snapshotPath, "utf8"))
  if (!isRecord(snapshot) || !isRecord(snapshot.keys) || !/^[0-9a-f]{40}$/.test(String(snapshot.sourceRevision))) {
    throw new Error(`${snapshotPath}: invalid released v1 key declaration`)
  }
  const released = new Map<string, { key: string; kind: SubjectKind }>()
  for (const [key, historicalValue] of Object.entries(snapshot.keys)) {
    // Released-key declarations retain their original wire labels.
    const value = historicalValue === "app" ? "term" : historicalValue === "headless" ? "lib" : historicalValue
    if (!isSubjectKind(value) || value === "mux") throw new Error(`${snapshotPath}: invalid released kind for ${key}`)
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

function compatibilityKey(kind: SubjectKind, id: string, catalog: CatalogKeys): string {
  const declared = catalog.kinds.get(id)
  if (!declared?.has(kind)) throw new Error(`Undeclared compatibility subject ${kind}:${id} in terminals.json`)
  const released = catalog.released.get(id)
  const bare = released?.key ?? id
  const owner = released?.kind ?? (declared.has("term") ? "term" : kind)
  // Published route IDs retain their historical prefixes; the subject kind is canonical above.
  const routeKind = kind === "lib" ? "headless" : kind === "term" ? "app" : kind
  return kind === owner ? bare : `${routeKind}-${bare}`
}

/**
 * The projection is the ONE read of the committed corpus, and it is expensive: it parses every run,
 * verifies every screenshot digest and classifies every cell. Each published consumer used to call the
 * reader for itself, so one `bun run build` read the same corpus once per consumer (measured 2026-10-12:
 * sixteen times) when it needed one read (28792 item 1 — project once per build).
 *
 * The memo cannot live at module scope: VitePress bundles each data loader's module graph separately
 * (seven `*.paths.ts` files, `probes.data.ts` and `config.ts` each carry their own copy of this
 * module), so a module-level Map would still read the corpus once per BUNDLE. The
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
  options: {
    artifactDir?: string
    workingRuns?: readonly LoadedRun[]
    workingAttempts?: readonly SelectedAttemptInput[]
  } = {},
): CurrentResults {
  // Explicit working evidence is not a cached corpus reading, including an explicit empty input.
  if (options.workingRuns !== undefined || options.workingAttempts !== undefined) {
    return { projection: loadSelectedResults(contentDir, probeHash(), options) }
  }
  const key = `${contentDir}\u0000${probeHash()}\u0000${options.artifactDir ?? ""}`
  const cache = currentResultsCache()
  const memoized = cache.get(key)
  if (memoized) return memoized
  const projection = loadSelectedResults(contentDir, probeHash(), options)
  const results: CurrentResults = { projection }
  cache.set(key, results)
  return results
}

/**
 * Select a deterministic summary per kind:id while retaining every projected context. */
export function compatibilitySubjects(projection: SelectedProjection, contentDir: string): Map<string, CurrentResult> {
  const catalog = loadCatalogKeys(contentDir)
  type SubjectResult = CurrentResult
  const groups = new Map<string, SubjectResult[]>()
  for (const [contextKey, selected] of Object.entries(projection.contexts)) {
    if (selected.contributingRunIds.length === 0) continue
    if (!selected.subject) throw new Error(`Context ${contextKey} has evidence without physical subject facts`)
    const subjectKey = `${selected.subject.kind}:${selected.subject.id}`
    const group = groups.get(subjectKey) ?? []
    group.push({ contextKey, selected })
    groups.set(subjectKey, group)
  }
  const bySubject = new Map<string, SubjectResult>()
  for (const [subjectKey, group] of groups) {
    // The one run-selection rule; this site and the decisive-share reader must not hold two copies.
    const byKey = new Map(group.map((entry) => [entry.contextKey, entry]))
    const picked = pickContextRun(
      group.flatMap((entry) => {
        const candidate = candidateFromSelected(
          entry.contextKey,
          entry.selected,
          statesFor(projection, entry.contextKey),
          projection,
        )
        return candidate ? [candidate] : []
      }),
    )
    if (picked === undefined) throw new Error(`No current run for ${subjectKey}`)
    // pickContextRun returns one of the candidates it was given, so this lookup cannot miss.
    const chosen = byKey.get(picked.run.key)
    if (!chosen) throw new Error(`Selected run ${picked.run.key} is not among ${subjectKey} current contexts`)
    if (!chosen.selected.subject) throw new Error(`Selected context ${picked.run.key} has no physical subject`)
    const key = compatibilityKey(chosen.selected.subject.kind, chosen.selected.subject.id, catalog)
    if (bySubject.has(key)) throw new Error(`Ambiguous compatibility key ${key}: multiple catalog targets`)
    bySubject.set(key, chosen)
  }
  return bySubject
}
