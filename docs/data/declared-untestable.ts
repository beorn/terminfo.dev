/**
 * Declared-untestable cells (@cto 82a54984 (c), PLAN GO b0d3cd4e): the one table that moves an app's open cell to
 * Untestable because no observable probe can answer it there. A row names a CELL (kind, id, os, feature) and covers
 * every context of that app on that OS; the build log lists every cell a row changed. It is never a result: the cell
 * keeps no grade, its original run and result stay, and the public sentence says a person reviewed it and why.
 *
 * Three rules (@cto 82a54984):
 * 1. A measured result always beats a declaration. A row whose cell reads anything but PROBE TODO (Supported,
 *    Unsupported, a probe's own Untestable, PROBE INVALID, PROBE CONFLICT, or a reopened cell) throws naming the row,
 *    and a row that matches no cell throws too; the fix is to remove the row.
 * 2. Every row carries its review: `reviewedBy` and `reviewedOn`, and the reviewer is never the declarer.
 * 3. Every count that includes these cells shows them apart: "N Untestable (M by review)" (release-scope.ts).
 *
 * The rows are typed by hand, one reviewed batch at a time: @cpo/term owns the reason text and @cto the review.
 */
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { cellLabel, checkPublicText } from "./reopened-cells.ts"

export interface DeclaredUntestableCell {
  kind: "term" | "mux"
  id: string
  os: string
  featureId: string
  /** In plain words for the public page: why no observable probe can answer this cell. No seat, id or issue number. */
  reason: string
  /** In plain words: what would make the cell testable, so the row's exit is stated. */
  testableIf: string
  /** Who proposed the row; kept in the file, never projected. */
  declaredBy: string
  /** The day the row was proposed (YYYY-MM-DD). */
  declaredOn: string
  /** Who reviewed the row; never the declarer. Kept in the file, never projected. */
  reviewedBy: string
  /** The day the row was reviewed (YYYY-MM-DD), shown with the reason. */
  reviewedOn: string
  /** The ruling, with its seat, date and message id. Kept in the file for us; never projected. */
  ruling: string
}

/** What a declared cell carries for its readers: the row's public words and review date. */
export interface DeclaredMarker {
  reason: string
  testableIf: string
  reviewedOn: string
}

export const DECLARED_UNTESTABLE_FILE = "declared-untestable.json"

/** The sentence the public page shows on a declared cell: reviewed by a person, never a grade. */
export function publicDeclaredReason(marker: DeclaredMarker): string {
  return `untestable by review ${marker.reviewedOn}: ${marker.reason}; testable once ${marker.testableIf}`
}

/** The error text every refused row ends with: the one fix. */
export const REMOVE_DECLARED_ROW = `remove this row from content/${DECLARED_UNTESTABLE_FILE}`

/**
 * Read and check content/declared-untestable.json. A missing file is no rows. A malformed row, a duplicate cell, a
 * missing review or a reviewer who is the declarer throws, naming the row.
 */
export function loadDeclaredUntestable(contentDir: string): DeclaredUntestableCell[] {
  const path = join(contentDir, DECLARED_UNTESTABLE_FILE)
  if (!existsSync(path)) return []
  const parsed = JSON.parse(readFileSync(path, "utf8")) as { rows?: unknown }
  if (!Array.isArray(parsed.rows)) throw new Error(`${path}: rows must be an array`)
  const rows = parsed.rows.map((row, index) => checkRow(row, `${path} row ${index}`))
  const seen = new Set<string>()
  for (const row of rows) {
    const label = cellLabel(row)
    if (seen.has(label)) throw new Error(`${path}: cell ${label} is declared twice`)
    seen.add(label)
  }
  return rows
}

function checkRow(value: unknown, where: string): DeclaredUntestableCell {
  const row = value as Partial<DeclaredUntestableCell>
  const text = (key: keyof DeclaredUntestableCell): string => {
    const field = row[key]
    if (typeof field !== "string" || field.trim().length === 0) {
      throw new Error(`${where}: ${key} must be a non-empty string`)
    }
    return field
  }
  const day = (key: "declaredOn" | "reviewedOn"): string => {
    const field = row[key]
    if (field === undefined || !/^\d{4}-\d{2}-\d{2}$/.test(field)) {
      throw new Error(`${where}: ${key} must be YYYY-MM-DD`)
    }
    return field
  }
  if (row.kind !== "term" && row.kind !== "mux") throw new Error(`${where}: kind must be term or mux`)
  const reason = checkPublicText(text("reason"), where, "reason")
  const testableIf = checkPublicText(text("testableIf"), where, "testableIf")
  // A declaration is never a result: its words may not read as a grade.
  for (const [field, words] of [
    ["reason", reason],
    ["testableIf", testableIf],
  ] as const) {
    if (/\b(un)?supported\b/i.test(words)) {
      throw new Error(`${where}: the public ${field} reads as a grade; say why no observable probe can answer the cell`)
    }
  }
  const declaredBy = text("declaredBy")
  const reviewedBy = text("reviewedBy")
  if (declaredBy === reviewedBy) {
    throw new Error(`${where}: reviewedBy is the declarer (${declaredBy}); a row needs a second person's review`)
  }
  return {
    kind: row.kind,
    id: text("id"),
    os: text("os"),
    featureId: text("featureId"),
    reason,
    testableIf,
    declaredBy,
    declaredOn: day("declaredOn"),
    reviewedBy,
    reviewedOn: day("reviewedOn"),
    ruling: text("ruling"),
  }
}
