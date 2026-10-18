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
import { compatibilityTargets, loadCurrentResults, loadDefaultContextPolicy } from "./current-results.ts"
import { publicResults, type PublicVersion } from "./public-results.ts"
import { candidateFromSelected, type ContextCandidate } from "./run-selection.ts"
import { statesFor } from "./selected-results.ts"
import { DESIGN_EXCLUSION_CAUSES, DESIGN_EXCLUSION_IDS, MISSING_DEFINITION_IDS } from "./full-scope.ts"
import { fullContextCensus } from "./full-census.ts"
import { buildFullProjectRows, type FullContextRow } from "./full-project.ts"
import { INSTRUMENT_LIMITS } from "./full-scope.ts"

const contentDir = join(import.meta.dirname, "..", "..", "content")

export interface FullProjectData {
  /** Always `development`: this reading is unadmitted and cannot be published as a result. */
  mode: "development"
  /** The live tree suite every collected row was measured on. */
  suiteId: string
  catalogRows: number
  designExclusions: readonly string[]
  /** The stated cause for each design exclusion, keyed by catalog id. */
  designExclusionCauses: Readonly<Record<string, string>>
  missingDefinitions: readonly string[]
  /** Reviewed per-context instrument limits. Recorded here; each context reports how many it applied. */
  instrumentLimits: readonly { id: string; cause: string }[]
  /**
   * The collected context -> its selected run as the site publishes it, so every row can render the
   * established evidence cell and open the run's own evidence document. Nothing is re-derived here.
   */
  evidenceVersions: Readonly<Record<string, PublicVersion>>
  contexts: readonly FullContextRow[]
  collected: number
  notCollected: number
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
  const candidates: ContextCandidate[] = Object.entries(projection.current).map(([key, selected]) =>
    candidateFromSelected(key, selected, statesFor(projection, selected.runId)),
  )
  const reviewed = loadDefaultContextPolicy(contentDir)
  const published = publicResults(projection, compatibilityTargets(projection, contentDir)).projection
  const rows = buildFullProjectRows({
    census: fullContextCensus(contentDir).contexts,
    catalogIds: catalogIdsInDisplayOrder(),
    candidates,
    requiredSuiteId,
    reviewed,
  })
  const evidenceVersions: Record<string, PublicVersion> = {}
  for (const row of rows.contexts) {
    if (!row.collected) continue
    const version = published.versions[row.run.contextKey]?.find((entry) => entry.runId === row.run.runId)
    if (!version) {
      throw new Error(
        `collected context ${row.context} names run ${row.run.runId}, which the public projection does not carry`,
      )
    }
    evidenceVersions[row.context] = version
  }
  return {
    mode: "development",
    suiteId: requiredSuiteId,
    catalogRows: rows.catalogRows,
    designExclusions: DESIGN_EXCLUSION_IDS,
    designExclusionCauses: DESIGN_EXCLUSION_CAUSES,
    missingDefinitions: MISSING_DEFINITION_IDS,
    instrumentLimits: INSTRUMENT_LIMITS,
    evidenceVersions,
    contexts: rows.contexts,
    collected: rows.collected,
    notCollected: rows.notCollected,
  }
}

export default {
  load(): FullProjectData {
    return loadFullProjectData()
  },
}

declare const data: FullProjectData
export { data }
