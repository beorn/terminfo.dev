/** Release 1 measurement claim: 62 query/reply features of the 270-feature catalog. */
import { readFileSync } from "node:fs"

export interface ReleaseFeature {
  id: string
  name: string
  status: "not measured in this release"
}

export interface ReleaseScope {
  tier: number
  method: string
  measuredIds: string[]
  measuredCount: number
  catalogCount: number
  unmeasured: ReleaseFeature[]
}

export interface MeasuredBar {
  denominator: number
  supported: number
  unsupported: number
  inconclusive: number
  errors: number
  untested: number
  conclusive: number
  fillPct: number
}

interface ReleaseDeclaration {
  tier: number
  method: string
  featureIds: string[]
}

interface CatalogEntry {
  name: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function utcDate(measuredAt: string): string {
  const value = new Date(measuredAt)
  if (Number.isNaN(value.getTime())) throw new Error(`invalid measuredAt ${measuredAt}`)
  return value.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" })
}

export function loadReleaseScope(args: {
  catalog: Record<string, CatalogEntry>
  declarationPath: string
}): ReleaseScope {
  const raw: unknown = JSON.parse(readFileSync(args.declarationPath, "utf8"))
  if (
    !isRecord(raw) ||
    typeof raw.tier !== "number" ||
    typeof raw.method !== "string" ||
    !Array.isArray(raw.featureIds)
  ) {
    throw new Error(`${args.declarationPath}: expected { tier, method, featureIds }`)
  }
  const declaration = raw as unknown as ReleaseDeclaration
  if (declaration.featureIds.some((id) => typeof id !== "string" || !id)) {
    throw new Error(`${args.declarationPath}: featureIds must be nonempty strings`)
  }
  const measuredIds = [...new Set(declaration.featureIds)]
  if (measuredIds.length !== declaration.featureIds.length) {
    throw new Error(`${args.declarationPath}: featureIds must be unique`)
  }
  const missing = measuredIds.filter((id) => !args.catalog[id])
  if (missing.length) throw new Error(`${args.declarationPath}: unknown features ${missing.join(", ")}`)
  const catalogIds = Object.keys(args.catalog)
  const measured = new Set(measuredIds)
  const unmeasured = catalogIds
    .filter((id) => !measured.has(id))
    .sort()
    .map((id) => {
      const entry = args.catalog[id]
      if (!entry) throw new Error(`${args.declarationPath}: catalog lost ${id} while listing unmeasured features`)
      return {
        id,
        name: entry.name,
        status: "not measured in this release" as const,
      }
    })
  return {
    tier: declaration.tier,
    method: declaration.method,
    measuredIds,
    measuredCount: measuredIds.length,
    catalogCount: catalogIds.length,
    unmeasured,
  }
}

export function tierLine(scope: ReleaseScope, options?: { measuredAt?: string }): string {
  const base = `${scope.measuredCount} of ${scope.catalogCount} features (tier ${scope.tier}, ${scope.method})`
  return options?.measuredAt ? `${base} · measured ${utcDate(options.measuredAt)}` : base
}

export function staleCaption(measuredAt: string): string {
  return `not re-measured since ${utcDate(measuredAt)}`
}

export function isStaleSuite(suiteFreshness: string): boolean {
  return !suiteFreshness.startsWith("current")
}

export function barOverMeasured(
  cells: Record<string, { outcome: string; conclusive?: boolean }>,
  measuredIds: readonly string[],
): MeasuredBar {
  let supported = 0
  let unsupported = 0
  let inconclusive = 0
  let errors = 0
  let untested = 0
  for (const id of measuredIds) {
    const cell = cells[id]
    if (!cell) untested++
    else if (cell.outcome === "error") errors++
    else if (cell.conclusive && cell.outcome === "supported") supported++
    else if (cell.conclusive && cell.outcome === "unsupported") unsupported++
    else inconclusive++
  }
  const denominator = measuredIds.length
  return {
    denominator,
    supported,
    unsupported,
    inconclusive,
    errors,
    untested,
    conclusive: supported + unsupported,
    fillPct: denominator === 0 ? 0 : Math.round((supported / denominator) * 100),
  }
}
