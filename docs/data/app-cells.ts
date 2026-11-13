/**
 * One app's cells, joined from the contexts that measured the same release.
 *
 * The site chooses ONE primary context per app and OS (`pickContextRun` in
 * run-selection.ts). A second context joins that primary only when it measured the same app version
 * with the same probe suite: those are the only contexts whose answers can be compared. A context on
 * another suite or another app version is history — it is shown where history is shown and never
 * changes a grade, an undecided label or a count (criterion c88ab98d, @cto c5ddabf3).
 *
 * Wherever the site lists apps (tables, counts, percentages, app pages), the unit is (app, OS).
 * An app measured on multiple OSes has a column per OS, labelled with the OS; single-OS labels stay
 * unchanged. Released app URLs stay unchanged. The legacy key's OS order is Linux, macOS, Windows,
 * other OS lexical, missing OS last; measurement dates never choose that key's OS (@cto ad37642d).
 * Newest-observation macOS selection is the separate follow-up #33587, not this same-suite join.
 *
 * Inside the join (@cto 4eef35ea): a decided grade in any joined context decides the cell; two
 * disagreeing decided grades read `differs-by-context` and name each context's grade; when no joined
 * context decided, Conflicting outranks Invalid outranks To do, and the cell names where the error was
 * seen. A cell a ruling reopened stays To do — no other context may decide it.
 *
 * Counts stay per app and probe: a context that joins adds evidence, never a cell.
 */
import type { FeatureResultStatus } from "@terminfo/probe-defs"

/** A cell's grade when the contexts that measured it disagree. Its own decided bucket, never Supported. */
export const DIFFERS_BY_CONTEXT = "differs-by-context" as const
export type AppCellStatus = FeatureResultStatus | typeof DIFFERS_BY_CONTEXT

/** The five decided or open states a joined cell can read, plus the disagreement bucket. */
export const APP_CELL_STATUSES: readonly AppCellStatus[] = [
  "supported",
  "unsupported",
  "untestable",
  DIFFERS_BY_CONTEXT,
  "probe-todo",
  "probe-invalid",
  "probe-conflict",
]

const COUNTED_MISSING = "Counted feature is absent from the joined catalogue: "

const DECIDED: ReadonlySet<string> = new Set<FeatureResultStatus>(["supported", "unsupported", "untestable"])

/** What one context recorded for one probe, reduced to the facts the join compares and names. */
export interface ContextCellFacts {
  status: FeatureResultStatus
  /**
   * The app version the measuring run recorded; a different version is a different app, not a context.
   * Null when the run recorded none, and a missing version never joins (@cto c5ddabf3).
   */
  version: string | null
  /** The probe suite hash the measuring run recorded; null when it recorded none, and that never joins. */
  suite: string | null
  runId: string
  /** Set when a reopened-cells row withdrew this grade; the cell reads probe-todo until its exit is met. */
  reopened?: boolean
}

/** One context's recorded cells, keyed by feature id. */
export interface ContextFacts {
  /** The projection's context key — what the site names a context by. */
  key: string
  cells: Readonly<Record<string, ContextCellFacts | undefined>>
}

/** One context's contribution to a cell's grade. */
export interface JoinedCellSource {
  context: string
  status: FeatureResultStatus
  runId: string
}

export interface JoinedCell {
  status: AppCellStatus
  /** The contexts whose grades produced `status`, each with its own recorded grade. Empty for To do. */
  from: JoinedCellSource[]
}

export interface JoinedApp {
  /** Every context that contributed to at least one cell, primary first. */
  contexts: string[]
  cells: Record<string, JoinedCell>
  counts: Record<AppCellStatus, number>
}

const isDecided = (status: string): status is FeatureResultStatus => DECIDED.has(status)

/** The contexts whose cell for `featureId` measured the same app version and the same suite as the primary. */
function joinedCells(
  primary: ContextFacts,
  others: readonly ContextFacts[],
  featureId: string,
): Array<{ context: string } & ContextCellFacts> {
  const anchor = primary.cells[featureId]
  if (!anchor) return []
  const joined: Array<{ context: string } & ContextCellFacts> = [{ context: primary.key, ...anchor }]
  // Two absences are not a match: a run that recorded no suite hash or no app version cannot prove it
  // measured the same release, so it never joins, not even another context that recorded nothing either.
  if (anchor.version === null || anchor.suite === null) return joined
  for (const other of others) {
    const cell = other.cells[featureId]
    if (!cell || cell.version === null || cell.suite === null) continue
    if (cell.version !== anchor.version || cell.suite !== anchor.suite) continue
    joined.push({ context: other.key, ...cell })
  }
  return joined
}

function mergedCell(joined: Array<{ context: string } & ContextCellFacts>): JoinedCell {
  const source = (cell: { context: string } & ContextCellFacts): JoinedCellSource => ({
    context: cell.context,
    status: cell.status,
    runId: cell.runId,
  })
  if (joined.some((cell) => cell.reopened === true)) return { status: "probe-todo", from: [] }
  const decided = joined.filter((cell) => isDecided(cell.status))
  const grades = new Set(decided.map((cell) => cell.status))
  if (grades.size > 1) return { status: DIFFERS_BY_CONTEXT, from: decided.map(source) }
  const [grade] = grades
  if (grade !== undefined) return { status: grade, from: decided.map(source) }
  const conflict = joined.filter((cell) => cell.status === "probe-conflict")
  if (conflict.length > 0) return { status: "probe-conflict", from: conflict.map(source) }
  const invalid = joined.filter((cell) => cell.status === "probe-invalid")
  if (invalid.length > 0) return { status: "probe-invalid", from: invalid.map(source) }
  return { status: "probe-todo", from: [] }
}

/**
 * Join every context that measured `primary`'s release into one cell set.
 *
 * `featureIds` is the app's published catalogue: a feature the primary never attempted stays To do,
 * because no joined context can be compared with it. `countedIds` is the graded subset the counts fold
 * over: the catalogue's environment positions are graded by nobody and stay out of a score, the same
 * split rollupTerminalStatuses makes.
 */
export function joinContextCells(
  primary: ContextFacts,
  others: readonly ContextFacts[],
  featureIds: readonly string[],
  countedIds: readonly string[] = featureIds,
): JoinedApp {
  const counts = Object.fromEntries(APP_CELL_STATUSES.map((status) => [status, 0])) as Record<AppCellStatus, number>
  const cells: Record<string, JoinedCell> = {}
  const contributors = new Set<string>()
  for (const featureId of featureIds) {
    const joined = joinedCells(primary, others, featureId)
    const cell = mergedCell(joined)
    cells[featureId] = cell
    contributors.add(primary.key)
    for (const entry of joined) contributors.add(entry.context)
  }
  for (const featureId of countedIds) {
    const cell = cells[featureId]
    if (!cell) throw new Error(COUNTED_MISSING + featureId)
    counts[cell.status]++
  }
  const ordered = [primary.key, ...[...others].map((other) => other.key).filter((key) => contributors.has(key))]
  return { contexts: ordered, cells, counts }
}
