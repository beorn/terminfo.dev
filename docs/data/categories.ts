/**
 * One owner for the category catalog (`content/categories.json`): every category key mapped to its
 * display label, order and description. The site's route generators, the analysis and validation
 * scripts, and the decisive-share reader all read the catalog through this typed loader, so a
 * category label or order has a single source and the readers can never drift into five private
 * parses. The category membership of a feature is its feature-id prefix — the same invariant
 * `scripts/validate.ts` enforces — so this module owns the metadata, not the membership.
 */
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { parseJsonStrict } from "@terminfo/run-parser"
import { SLICES, type Slice } from "@terminfo/catalog"

export interface CategoryMeta {
  label: string
  order: number
  description: string
  /** The scope label the cohorts filter over; `slice()` in @terminfo/catalog reads it. */
  slice: Slice
}

/** Category IDs in their curated display order; equal orders retain catalog entry order. */
export function orderedCategoryIds(categories: Readonly<Record<string, Pick<CategoryMeta, "order">>>): string[] {
  return Object.entries(categories)
    .sort(([, left], [, right]) => left.order - right.order)
    .map(([id]) => id)
}

/** Load and shape-check `content/categories.json` from a content directory. Throws on any defect. */
export function loadCategories(contentDir: string): Record<string, CategoryMeta> {
  const path = join(contentDir, "categories.json")
  if (!existsSync(path)) throw new Error(`Missing required category catalog: ${path}`)
  const raw = parseJsonStrict(path, readFileSync(path, "utf-8"))
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`${path}: expected a category catalog object`)
  }
  const categories: Record<string, CategoryMeta> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (key.startsWith("$")) continue
    const entry = value as { label?: unknown; order?: unknown; description?: unknown; slice?: unknown } | null
    if (!entry || typeof entry.label !== "string" || !entry.label) {
      throw new Error(`${path}: category "${key}" is missing a label`)
    }
    if (typeof entry.order !== "number") {
      throw new Error(`${path}: category "${key}" is missing an order`)
    }
    if (typeof entry.description !== "string") {
      throw new Error(`${path}: category "${key}" is missing a description`)
    }
    if (!SLICES.includes(entry.slice as Slice)) {
      throw new Error(
        `${path}: category "${key}" has an invalid slice "${String(entry.slice)}"; expected ${SLICES.join(", ")}`,
      )
    }
    const slice = entry.slice as Slice
    categories[key] = {
      label: entry.label,
      order: entry.order,
      description: entry.description,
      slice,
    }
  }
  return categories
}
