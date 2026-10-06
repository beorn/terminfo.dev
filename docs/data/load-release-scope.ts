/** Node-only loader for the Release 1 measurement declaration. */
import { readFileSync } from "node:fs"
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
