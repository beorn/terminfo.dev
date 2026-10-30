/**
 * VitePress build-time data loader for the full-scope private preview: all 273 catalog rows over all
 * 33 expected contexts.
 *
 * The page is a DEVELOPMENT reading, never an admitted one: it scores the live tree suite against
 * whatever current runs exist today and names every context it cannot score. It does not select a
 * final suite, admit a run, freeze anything or publish a claim. The one arithmetic owner is
 * `full-scope.ts`; the one run selection is `run-selection.ts`; this loader only composes them.
 */
import { join } from "node:path"
import { isEnvironmentGroup } from "../../packages/probe-defs/src/environment-groups.ts"
import { loadFeatures } from "@terminfo/catalog"
import { probeHash } from "../../packages/admin/versions.ts"
import { loadCategories, orderedCategoryIds } from "./categories.ts"
import { compatibilitySubjects, loadCurrentResults, loadDefaultContextPolicy } from "./current-results.ts"
import { publicResults, type PublicContextSummary } from "./public-results.ts"
import { candidateFromSelected, type ContextCandidate } from "./run-selection.ts"
import { statesFor } from "./selected-results.ts"
import { fullContextCensus } from "./full-census.ts"
import { buildFullProjectRows, type FullContextRow } from "./full-project.ts"

const contentDir = join(import.meta.dirname, "..", "..", "content")

// Technical-owner DATA snapshot, accepted by @dev/10 (e209d32a).
// Source: 31733-selected-membership-20261029-1610.json, SHA-256 below.
// CTO 5af532bb: keep this private beside the preview; future rows require reviewed delivery.
// This incomplete diagnostic receipt does not admit a run or certify the remaining population.
const toolGapMembership = {
  authoritySha256: "aeaaefbd91bc6d34a6cd6057590fd1234912e2c10ed239b11ec6fa08085e32ad",
  membershipComplete: false,
  rows: [
    {
      context: "lib:libvterm",
      engine: "libvterm",
      engineVersion: "0.3.3",
      feature: "extensions.osc1-icon",
      suite: "c7df853eef35",
      run: "959ccc7dfdd25375a9922b33286f7180",
      namedGap: "icon-name state",
      plainCause: "Our libvterm adapter does not expose the engine's icon-name callback state.",
      recordedStatus: "test-todo",
      measuredAt: "2026-10-29T22:37:32.875Z",
      sourceRevision: "0df200f426a0adf5b4518eb38a7474bbd4bc5abe",
      adapterRevision: "cd5cd5172680fd240ee3445dea96289793bc2d59",
      loadedBinarySha256: "5937bd79139ee5856bcf1bd619cc44fcd2d750d3def3066a74956678cdaaaeb2",
      rawSha256: "ebba95d6da8e6efa8fa8e80bf522de1af1f560fd968897eadf28a28b7780a9fe",
    },
  ],
}

export interface FullProjectData {
  /** Always `development`: this reading is unadmitted and cannot be published as a result. */
  mode: "development"
  /** The live tree suite every collected row was measured on. */
  suiteId: string
  catalogRows: number
  gradedRows: number
  environmentGroups: number
  /**
   * The collected context -> its selected run as the site publishes it, so every row can render the
   * established evidence cell and open the run's own evidence document. Nothing is re-derived here.
   */
  evidenceContexts: Readonly<Record<string, PublicContextSummary>>
  contexts: readonly FullContextRow[]
  collected: number
  notCollected: number
  complete: boolean
  recordedPositions: number
  /** Read-time explanation and counts, never admission, publication or a stored grade. */
  toolGaps: {
    authorityPath: string
    authoritySha256: string
    membershipComplete: boolean
    classes: Array<{ name: string; accepted: number; matched: number }>
    namedTodo: number
    unnamedTodo: number
    failures: number
    eligibleForConsideration: boolean
  }
}

/** Every catalog row in the site's category order; an ungroupable id is refused, never dropped. */
function catalogIdsInDisplayOrder(): string[] {
  const catalog = loadFeatures(contentDir)
  const categories = loadCategories(contentDir)
  const ids: string[] = []
  for (const key of orderedCategoryIds(categories)) {
    const prefix = `${key}.`
    for (const id of Object.keys(catalog)
      .filter((featureId) => featureId.startsWith(prefix))
      .sort()) {
      ids.push(id)
    }
  }
  const grouped = new Set(ids)
  const missing = Object.keys(catalog).filter((id) => !grouped.has(id))
  if (missing.length > 0) {
    throw new Error(`catalog rows outside every category: ${missing.join(", ")}`)
  }
  return ids
}

export function loadFullProjectData(): FullProjectData {
  const requiredSuiteId = probeHash()
  const projection = loadCurrentResults(contentDir, { releaseSuiteId: requiredSuiteId }).projection
  const candidates: ContextCandidate[] = Object.entries(projection.contexts).flatMap(([key, selected]) => {
    const candidate = candidateFromSelected(key, selected, statesFor(projection, key), projection)
    return candidate ? [candidate] : []
  })
  const reviewed = loadDefaultContextPolicy(contentDir)
  const published = publicResults(projection, compatibilitySubjects(projection, contentDir)).projection
  const rows = buildFullProjectRows({
    census: fullContextCensus(contentDir).contexts,
    catalogIds: catalogIdsInDisplayOrder(),
    candidates,
    requiredSuiteId,
    reviewed,
  })
  const evidenceContexts: Record<string, PublicContextSummary> = {}
  const toolGaps: FullProjectData["toolGaps"] = {
    authorityPath: "docs/data/full-project.data.ts",
    authoritySha256: toolGapMembership.authoritySha256,
    membershipComplete: toolGapMembership.membershipComplete,
    classes: [],
    namedTodo: 0,
    unnamedTodo: 0,
    failures: 0,
    eligibleForConsideration: false,
  }
  const classes = new Map<string, { name: string; accepted: number; matched: number }>()
  const matchedGaps = new Set<(typeof toolGapMembership.rows)[number]>()
  const membershipKeys = new Set<string>()
  for (const gap of toolGapMembership.rows) {
    for (const key of [
      "context",
      "engine",
      "engineVersion",
      "feature",
      "suite",
      "run",
      "namedGap",
      "plainCause",
      "measuredAt",
      "sourceRevision",
      "adapterRevision",
      "loadedBinarySha256",
      "rawSha256",
    ] as const) {
      if (typeof gap[key] !== "string" || !gap[key].trim()) {
        throw new Error(`${toolGaps.authorityPath}: accepted tool-gap row lacks ${key}`)
      }
    }
    if (gap.recordedStatus !== "test-todo") {
      throw new Error(`${toolGaps.authorityPath}: accepted tool-gap row must name TEST TODO`)
    }
    const key = JSON.stringify([gap.suite, gap.run, gap.context, gap.feature])
    if (membershipKeys.has(key)) throw new Error(`${toolGaps.authorityPath}: duplicate accepted tool-gap cell ${key}`)
    membershipKeys.add(key)
    const group = classes.get(gap.namedGap) ?? { name: gap.namedGap, accepted: 0, matched: 0 }
    group.accepted++
    classes.set(gap.namedGap, group)
  }
  // Census and kind own the required contexts; no second list of eleven library identities.
  let boundInputs =
    rows.notCollected === 0 && rows.contexts.length > 0 && rows.contexts.some((row) => row.kind === "lib")
  for (const row of rows.contexts) {
    if (!row.collected) continue
    if (row.heldIds.length || row.sources.length === 0) boundInputs = false
    const context = published.contexts[row.selection.contextKey]
    if (!context) {
      throw new Error(
        `collected context ${row.context} names ${row.selection.contextKey}, which the public projection does not carry`,
      )
    }
    evidenceContexts[row.context] = context
    for (const observation of row.observations) {
      observation.reason = context.cells[observation.id]?.reason ?? null
      if (isEnvironmentGroup(observation.id)) continue
      const original = projection.contexts[row.selection.contextKey]?.cells[observation.id]
      if (!original || observation.suiteId !== requiredSuiteId || !original.run.sourceRevision) boundInputs = false
      if (observation.state === "test-failure") toolGaps.failures++
      if (observation.state !== "test-todo") continue
      const gap =
        !observation.hold &&
        !row.heldIds.includes(observation.id) &&
        row.kind === "lib" &&
        original?.result.status === "test-todo"
          ? toolGapMembership.rows.find(
              (member) =>
                member.context === row.selection.contextKey &&
                member.feature === observation.id &&
                member.feature === observation.origin.resultId &&
                member.run === observation.origin.runId &&
                member.suite === observation.suiteId &&
                member.suite === requiredSuiteId &&
                member.run === original.run.runId &&
                member.suite === original.run.suiteId &&
                member.rawSha256 === original.run.sha256 &&
                member.sourceRevision === original.run.sourceRevision &&
                member.engine === original.run.subject.id &&
                member.engineVersion === original.run.subject.version &&
                member.measuredAt === observation.measuredAt &&
                member.measuredAt === original.run.measuredAt &&
                member.engineVersion === original.run.runtimeIdentity?.engineVersion &&
                member.adapterRevision === original.run.runtimeIdentity?.termlessRevision &&
                original.run.runtimeIdentity !== undefined &&
                "loadedBinary" in original.run.runtimeIdentity &&
                member.loadedBinarySha256 === original.run.runtimeIdentity.loadedBinary?.sha256,
            )
          : undefined
      if (gap) {
        observation.note = gap.plainCause
        toolGaps.namedTodo++
        matchedGaps.add(gap)
      } else toolGaps.unnamedTodo++
    }
  }
  for (const group of classes.values()) {
    group.matched = [...matchedGaps].filter((gap) => gap.namedGap === group.name).length
  }
  toolGaps.classes = [...classes.values()].sort((a, b) => a.name.localeCompare(b.name))
  toolGaps.eligibleForConsideration =
    boundInputs && toolGaps.membershipComplete && toolGaps.failures === 0 && toolGaps.unnamedTodo === 0
  return {
    mode: "development",
    suiteId: requiredSuiteId,
    catalogRows: rows.catalogRows,
    gradedRows: rows.gradedRows,
    environmentGroups: rows.environmentGroups,
    evidenceContexts,
    contexts: rows.contexts,
    collected: rows.collected,
    notCollected: rows.notCollected,
    complete: rows.complete,
    recordedPositions: rows.recordedPositions,
    toolGaps,
  }
}

export default {
  load(): FullProjectData {
    return loadFullProjectData()
  },
}

declare const data: FullProjectData
export { data }
