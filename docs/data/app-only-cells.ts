/**
 * App only (#38772, @cto e777b8ab; list @cpo/term 20882c8a): a feature row that only an app window can measure, OS input
 * injection or glyph drawing, declares `appOnly: { reason }` in content/features.json. On a library row the projection
 * shows that cell as App only and leaves it out of the row's counts. The stored result stays exactly as measured, and
 * terminal and multiplexer rows are graded as usual. The declarations are data; this reader names no feature.
 */
import { join } from "node:path"
import { loadFeatures, type AppOnlyDeclaration } from "@terminfo/catalog"
import type { ProbeSubject } from "@terminfo/probe-defs"
import type { SelectedContextCell } from "./selected-results.ts"

const contentDir = join(import.meta.dirname, "..", "..", "content")

/** Every row the catalogue declares App only, with its reason. */
export function catalogAppOnly(dir: string = contentDir): ReadonlyMap<string, AppOnlyDeclaration> {
  const declared = new Map<string, AppOnlyDeclaration>()
  for (const [id, row] of Object.entries(loadFeatures(dir))) {
    if (row.appOnly) declared.set(id, row.appOnly)
  }
  return declared
}

/**
 * Mark the App only cells of one library context in place; returns every declared id, in catalogue order. A terminal or
 * multiplexer context, or a context with no subject, is left as it reads. A declared feature the library never measured
 * has no cell to mark, but its id is still returned, so the row reads it as App only rather than an open position no
 * library run can close (#38801, @dev/review2 87da1a99).
 */
export function applyAppOnly(
  cells: Record<string, SelectedContextCell>,
  subject: Pick<ProbeSubject, "kind"> | undefined,
  declared: ReadonlyMap<string, AppOnlyDeclaration>,
  catalogIds: readonly string[],
): string[] {
  if (subject?.kind !== "lib") return []
  const marked: string[] = []
  for (const id of catalogIds) {
    const declaration = declared.get(id)
    const cell = cells[id]
    if (!declaration) continue
    if (cell) cells[id] = { ...cell, appOnly: { reason: declaration.reason } }
    marked.push(id)
  }
  return marked
}
