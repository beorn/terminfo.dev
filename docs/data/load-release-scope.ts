/** Node-only loader for the Release 1 measurement declaration. */
import { readFileSync } from "node:fs"
import { parseJsonStrict } from "@terminfo/run-parser"
import type { ReleaseFeature, ReleaseScope } from "./release-scope.ts"

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

function validateFeatureIds(ids: unknown[], catalog: Record<string, CatalogEntry>, path: string): string[] {
  if (ids.some((id) => typeof id !== "string" || !id)) {
    throw new Error(`${path}: featureIds must be nonempty strings`)
  }
  const measuredIds = [...new Set(ids as string[])]
  if (measuredIds.length !== ids.length) throw new Error(`${path}: featureIds must be unique`)
  const missing = measuredIds.filter((id) => !catalog[id])
  if (missing.length) throw new Error(`${path}: unknown features ${missing.join(", ")}`)
  return measuredIds
}

export interface FeatureCohort {
  name: "candidate2"
  frozenSuiteId: string
  measuredIds: string[]
}

export function loadFeatureCohort(args: {
  catalog: Record<string, CatalogEntry>
  declarationPath: string
}): FeatureCohort {
  const raw: unknown = parseJsonStrict(args.declarationPath, readFileSync(args.declarationPath, "utf8"))
  if (
    !isRecord(raw) ||
    raw.name !== "candidate2" ||
    typeof raw.frozenSuiteId !== "string" ||
    !raw.frozenSuiteId.trim() ||
    !Array.isArray(raw.featureIds) ||
    raw.featureIds.length === 0
  ) {
    throw new Error(
      `${args.declarationPath}: expected { name: "candidate2", frozenSuiteId: nonempty string, featureIds: nonempty array }`,
    )
  }
  return {
    name: raw.name,
    frozenSuiteId: raw.frozenSuiteId,
    measuredIds: validateFeatureIds(raw.featureIds, args.catalog, args.declarationPath),
  }
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
  const measuredIds = validateFeatureIds(declaration.featureIds, args.catalog, args.declarationPath)
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
      } satisfies ReleaseFeature
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
