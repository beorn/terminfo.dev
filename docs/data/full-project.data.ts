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
  for (const row of rows.contexts) {
    if (!row.collected) continue
    const context = published.contexts[row.selection.contextKey]
    if (!context) {
      throw new Error(
        `collected context ${row.context} names ${row.selection.contextKey}, which the public projection does not carry`,
      )
    }
    evidenceContexts[row.context] = context
    for (const observation of row.observations) {
      observation.reason = context.cells[observation.id]?.reason ?? null
    }
  }
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
  }
}

export default {
  load(): FullProjectData {
    return loadFullProjectData()
  },
}

declare const data: FullProjectData
export { data }
