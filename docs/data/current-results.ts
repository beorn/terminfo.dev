/** A single admission point for published result consumers. */
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { probeHash } from "../../packages/admin/versions.ts"
import {
  loadSelectedResults,
  parseJsonStrict,
  type SelectedProjection,
  type SelectedVersion,
} from "./selected-results.ts"

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

export function loadCurrentResults(contentDir: string): CurrentResults {
  const projection = loadSelectedResults(contentDir, probeHash())
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
    )
      throw new Error(`${path}: ${id} requires contextKey, reviewer, reason and sources`)
    policy[id] = row as unknown as DefaultContextReview
  }
  return policy
}

/** Compatibility consumers have one slot per terminal id; ambiguous contexts need a reviewed policy row. */
export function compatibilityTargets(projection: SelectedProjection, contentDir: string): Map<string, CurrentResult> {
  const policy = loadDefaultContextPolicy(contentDir)
  const groups = new Map<string, CurrentResult[]>()
  for (const [contextKey, selected] of Object.entries(projection.current)) {
    const id = selected.target.id
    const group = groups.get(id) ?? []
    group.push({ contextKey, selected })
    groups.set(id, group)
  }
  const byTarget = new Map<string, CurrentResult>()
  for (const [id, group] of groups) {
    const review = policy[id]
    if (group.length > 1 && !review) {
      throw new Error(
        `Ambiguous current ${id}: ${group.map((entry) => entry.contextKey).join(", ")}; reviewed defaultContext row required`,
      )
    }
    const chosen = review ? group.find((entry) => entry.contextKey === review.contextKey) : group[0]
    if (!chosen)
      throw new Error(
        `${join(contentDir, "default-contexts.json")}: ${id} chooses a noncurrent context ${review?.contextKey}`,
      )
    byTarget.set(id, { ...chosen, ...(review && { policy: review }) })
  }
  return byTarget
}
