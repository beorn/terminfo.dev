/** A single admission point for published result consumers. */
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { probeHash } from "../../packages/admin/versions.ts"
import {
  loadSelectedResults,
  maskRunnerStorePath,
  type SelectedProjection,
  type SelectedVersion,
  type CurrentSelectedVersion,
} from "./selected-results.ts"
import type { ProbeStatus } from "@terminfo/probe-defs"
import type { CellState } from "./release-scope.ts"
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
  selected: CurrentSelectedVersion
  policy?: DefaultContextReview
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
  if (!declared?.has(kind)) throw new Error(`Undeclared compatibility target ${kind}:${id} in terminals.json`)
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
 * reviewed row `compatibilitySubjects` applies — one policy source, not a second parser.
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
    const canonicalId = id.replace(/^app:/, "term:").replace(/^headless:/, "lib:")
    policy[canonicalId] = {
      ...(row as unknown as DefaultContextReview),
      contextKey: maskRunnerStorePath(row.contextKey) as string,
    }
  }
  return policy
}

/**
 * The reviewed row that applies to ONE context. An os-qualified key (`app:kitty/linux`) is read before
 * the id-level key (`app:kitty`) for that os ONLY, so a review can break a tie inside a group the
 * id-level row cannot address: `app:kitty` names the macOS context, and the linux group (one default
 * profile plus two clipboard overrides) would otherwise have no reviewed choice at all. The bar's
 * per-context rows and the census ledger both call THIS function, so the site and the census can never
 * select different runs for the same context. A context with no os-qualified row resolves exactly as
 * it did before this key existed.
 */
export function reviewedContextFor<Row extends { contextKey: string }>(
  policy: Readonly<Record<string, Row>>,
  kind: string,
  id: string,
  os: string,
): Row | undefined {
  return policy[`${kind}:${id}/${os}`] ?? policy[`${kind}:${id}`]
}

/** Compatibility consumers select one reviewed context per kind:id, then derive stable v1/site keys. */
export function compatibilitySubjects(projection: SelectedProjection, contentDir: string): Map<string, CurrentResult> {
  return compatibilitySubjectsFor(projection, contentDir)
}

function compatibilitySubjectsFor<Version extends SelectedVersion | CurrentSelectedVersion>(
  projection: {
    current: Record<string, Version>
    table: Readonly<Record<string, Readonly<Record<string, CellState | ProbeStatus>>>>
  },
  contentDir: string,
): Map<string, { contextKey: string; selected: Version; policy?: DefaultContextReview }> {
  const policy = loadDefaultContextPolicy(contentDir)
  const catalog = loadCatalogKeys(contentDir)
  type SubjectResult = { contextKey: string; selected: Version; policy?: DefaultContextReview }
  const groups = new Map<string, SubjectResult[]>()
  for (const [contextKey, selected] of Object.entries(projection.current)) {
    const subjectKey = `${selected.subject.kind}:${selected.subject.id}`
    const group = groups.get(subjectKey) ?? []
    group.push({ contextKey, selected })
    groups.set(subjectKey, group)
  }
  const bySubject = new Map<string, SubjectResult>()
  for (const [subjectKey, group] of groups) {
    const review = policy[subjectKey]
    // The one run-selection rule; this site and the decisive-share reader must not hold two copies.
    const byKey = new Map(group.map((entry) => [entry.contextKey, entry]))
    const picked = pickContextRun(
      group.map((entry) =>
        candidateFromSelected(entry.contextKey, entry.selected, selectedStates(projection.table, entry.selected.runId)),
      ),
      review,
    )
    if (picked === undefined) throw new Error(`No current run for ${subjectKey}`)
    if ("ambiguous" in picked) {
      throw new Error(
        `Ambiguous current ${subjectKey}: ${picked.ambiguous.join(", ")}; reviewed defaultContext row required`,
      )
    }
    if ("stale" in picked) throw new Error(picked.stale)
    if (review && picked.selection !== "reviewed default-context row") {
      throw new Error(
        `${join(contentDir, "default-contexts.json")}: ${subjectKey} chooses a noncurrent context ${review.contextKey}`,
      )
    }
    // pickContextRun returns one of the candidates it was given, so this lookup cannot miss.
    const chosen = byKey.get(picked.run.key)
    if (!chosen) throw new Error(`Selected run ${picked.run.key} is not among ${subjectKey} current contexts`)
    const key = compatibilityKey(chosen.selected.subject.kind, chosen.selected.subject.id, catalog)
    if (bySubject.has(key)) throw new Error(`Ambiguous compatibility key ${key}: multiple catalog targets`)
    bySubject.set(key, { ...chosen, ...(review && { policy: review }) })
  }
  return bySubject
}

function selectedStates(
  table: Readonly<Record<string, Readonly<Record<string, CellState | ProbeStatus>>>>,
  runId: string,
): Readonly<Record<string, CellState | ProbeStatus>> {
  const states = table[runId]
  if (!states) throw new Error(`Selected run ${runId} has no projected result table`)
  return states
}
