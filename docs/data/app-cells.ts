/**
 * One app's cells, joined row by row from the contexts that measured the same release.
 *
 * The site chooses ONE primary context per app and OS (`pickContextRun` in run-selection.ts, by app version and
 * then source-revision ancestry). Another context's cell joins the primary's cell for a row only when all three
 * tests hold (33587, @cto d805d1af):
 * 1. the app version is equal (a missing version never joins, @cto c5ddabf3);
 * 2. the row's catalogue entry hash (`catalogEntrySha256[row]` of each run's suite manifest, or the reconstructed
 *    row in content/legacy-entry-hashes.json) is equal;
 * 3. the probe-defs file that defines the row is byte-equal at the two runs' source revisions.
 * Otherwise the other cell is refused for that row by name (`refused`, naming the failed test), and the row shows
 * only the primary run's observation: nothing merges in from the refused cell and no grade is read from source.
 *
 * Wherever the site lists apps (tables, counts, percentages, app pages), the unit is (app, OS).
 * An app measured on multiple OSes has a column per OS, labelled with the OS; single-OS labels stay
 * unchanged. Released app URLs stay unchanged. The legacy key's OS order is Linux, macOS, Windows,
 * other OS lexical, missing OS last; measurement dates never choose that key's OS (@cto ad37642d).
 *
 * Inside a joined row: each context already holds its newest observation (the projection's rule, where
 * could-not-measure never replaces decided). Across contexts, one decided grade wins over the others'
 * could-not-measure; two different decided grades read open `probe-conflict` and name both contexts (@cpo/term
 * 62555b47, replacing the decided `differs-by-context`); when no joined context decided, Conflicting outranks
 * Invalid outranks To do, and the cell names where the error was seen. A cell a ruling reopened stays To do —
 * no other context may decide it.
 *
 * Counts stay per app and probe: a context that joins adds evidence, never a cell.
 */
import type { FeatureResultStatus } from "@terminfo/probe-defs"

/**
 * The retired disagreement bucket. The join no longer produces it (two decided grades read `probe-conflict`), so it
 * counts zero; it stays in the bucket list only while the pages and the stored-count refusal still name it.
 */
export const DIFFERS_BY_CONTEXT = "differs-by-context" as const
export type AppCellStatus = FeatureResultStatus | typeof DIFFERS_BY_CONTEXT

/** The five decided or open states a joined cell can read, plus the retired disagreement bucket. */
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
  /** The probe suite hash the measuring run recorded; null when it recorded none. Named in refusals only. */
  suite: string | null
  /** This row's catalogue entry hash under the run's suite; null when no manifest or legacy row records it. */
  entryHash: string | null
  /** The source revision the measuring run recorded; null when it recorded none, and that never joins. */
  sourceRevision: string | null
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

/** Another context's cell for a row that did not join the primary's, and the test it failed. */
export interface JoinRefusal {
  context: string
  runId: string
  reason: string
}

export interface JoinedCell {
  status: AppCellStatus
  /** The contexts whose grades produced `status`, each with its own recorded grade. Empty for To do. */
  from: JoinedCellSource[]
  /** The primary context's run the row was read from; absent when the primary never attempted the row. */
  primary?: JoinedCellSource
  /** Other contexts' cells for this row that did not join, each with the test it failed. */
  refused: JoinRefusal[]
}

export interface JoinedApp {
  /** Every context that contributed to at least one cell, primary first. */
  contexts: string[]
  cells: Record<string, JoinedCell>
  counts: Record<AppCellStatus, number>
}

/**
 * Why the probe-defs file defining `featureId` is not byte-equal at the two source revisions, or null when it is
 * (source-history.ts `definitionDiffers`).
 */
export type DefinitionCheck = (featureId: string, left: string, right: string) => string | null

const isDecided = (status: string): status is FeatureResultStatus => DECIDED.has(status)

type NamedCell = { context: string } & ContextCellFacts

/** The first of the three join tests `cell` fails against `anchor` for `featureId`, or null when it joins. */
function joinRefusal(
  anchor: NamedCell,
  cell: NamedCell,
  featureId: string,
  definition: DefinitionCheck,
): string | null {
  // Two absences are not a match: a run that recorded no app version, entry hash or source revision cannot prove
  // it measured the same row, so it never joins, not even another context that recorded nothing either.
  if (anchor.version === null || cell.version === null) {
    return `app version not recorded by ${anchor.version === null ? anchor.runId : cell.runId}`
  }
  if (anchor.version !== cell.version) return `app version ${cell.version} differs from ${anchor.version}`
  if (anchor.entryHash === null || cell.entryHash === null) {
    const missing = anchor.entryHash === null ? anchor : cell
    return `suite ${missing.suite ?? "not recorded"} records no catalogue entry hash for ${featureId}`
  }
  if (anchor.entryHash !== cell.entryHash) {
    return `catalogue entry for ${featureId} differs between suite ${cell.suite ?? "not recorded"} and ${anchor.suite ?? "not recorded"}`
  }
  if (anchor.sourceRevision === null || cell.sourceRevision === null) {
    return `source revision not recorded by ${anchor.sourceRevision === null ? anchor.runId : cell.runId}`
  }
  return definition(featureId, anchor.sourceRevision, cell.sourceRevision)
}

/** The primary's cell for `featureId`, the other contexts' cells that pass the join tests, and those refused. */
function joinedCells(
  primary: ContextFacts,
  others: readonly ContextFacts[],
  featureId: string,
  definition: DefinitionCheck,
): { joined: NamedCell[]; refused: JoinRefusal[] } {
  const facts = primary.cells[featureId]
  if (!facts) return { joined: [], refused: [] }
  const anchor: NamedCell = { context: primary.key, ...facts }
  const joined: NamedCell[] = [anchor]
  const refused: JoinRefusal[] = []
  for (const other of others) {
    const cell = other.cells[featureId]
    if (!cell) continue
    const named: NamedCell = { context: other.key, ...cell }
    const reason = joinRefusal(anchor, named, featureId, definition)
    if (reason === null) joined.push(named)
    else refused.push({ context: other.key, runId: cell.runId, reason })
  }
  return { joined, refused }
}

const source = (cell: NamedCell): JoinedCellSource => ({
  context: cell.context,
  status: cell.status,
  runId: cell.runId,
})

function mergedCell(joined: readonly NamedCell[]): Pick<JoinedCell, "status" | "from"> {
  if (joined.some((cell) => cell.reopened === true)) return { status: "probe-todo", from: [] }
  const decided = joined.filter((cell) => isDecided(cell.status))
  const grades = new Set(decided.map((cell) => cell.status))
  // Two contexts that decided differently leave the row open, naming both (@cpo/term 62555b47).
  if (grades.size > 1) return { status: "probe-conflict", from: decided.map(source) }
  const [grade] = grades
  if (grade !== undefined) return { status: grade, from: decided.map(source) }
  const conflict = joined.filter((cell) => cell.status === "probe-conflict")
  if (conflict.length > 0) return { status: "probe-conflict", from: conflict.map(source) }
  const invalid = joined.filter((cell) => cell.status === "probe-invalid")
  if (invalid.length > 0) return { status: "probe-invalid", from: invalid.map(source) }
  return { status: "probe-todo", from: [] }
}

/**
 * Join every context's cells that pass the per-row tests into `primary`'s cell set.
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
  definition: DefinitionCheck,
  countedIds: readonly string[] = featureIds,
): JoinedApp {
  const counts = Object.fromEntries(APP_CELL_STATUSES.map((status) => [status, 0])) as Record<AppCellStatus, number>
  const cells: Record<string, JoinedCell> = {}
  const contributors = new Set<string>([primary.key])
  for (const featureId of featureIds) {
    const { joined, refused } = joinedCells(primary, others, featureId, definition)
    const [anchor] = joined
    cells[featureId] = { ...mergedCell(joined), ...(anchor && { primary: source(anchor) }), refused }
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
