/**
 * Write the current selection to a caller-given path. The file is never committed and is not under content/.
 * Placed runs come from content/. Each --working-run is passed through the existing workingRuns input.
 */
import { writeFileSync } from "node:fs"
import { isAbsolute, relative, resolve, sep } from "node:path"
import { loadFeatures } from "@terminfo/catalog"
import { probeHash } from "../../packages/admin/versions.ts"
import { CONTENT_DIR } from "../../packages/admin/corpus-placement.ts"
import { loadRawCapture } from "../../packages/admin/raw-capture.ts"
import {
  loadSelectedResults,
  suiteRelationOf,
  type SelectedContextCell,
  type SelectedProjection,
} from "./selected-results.ts"
import { compatibilitySubjects, joinedAppCells, type CurrentResult } from "./current-results.ts"
import { scoredFeatureIds } from "@terminfo/probe-defs"
import type { AppCellStatus } from "./app-cells.ts"

export interface SelectionFileCell {
  featureId: string
  status: string
  terminalId: string
  version: string
  os: string | null
  /** The projection's context key, the same key the site's selection uses. */
  context: string
  measuredAt: string
  suiteId: string
  /** The site's suite comparison for this cell's run: "tree", or "older" with its label `older suite <hash>` (33109). */
  suiteRelation: ReturnType<typeof suiteRelationOf>["suiteRelation"]
  suiteFreshness: string
  runId: string
  source: "placed" | "working"
  /** Repository-relative run file for a placed row (`content/...`); null for a working run, which is not placed. */
  contentPath: string | null
  /** Present only when a context supplement read this cell (selected-results.ts SelectedContextCell.supplement). */
  supplement?: SelectedContextCell["supplement"]
  /** Present only when a reopened-cells row withdrew this cell's grade (#33164); the status map counts these (33109). */
  reopened?: SelectedContextCell["reopened"]
  /** Present only when the mux-input demotion read this cell (#33665): measured status and the outer run it leaned on. */
  outerAbsent?: SelectedContextCell["outerAbsent"]
  /**
   * Present only on an untestable cell (#33928): why no route measures it, as stored — the mux-input demotion's reason
   * when that demotion made it untestable, else the run's own result reason. null when the run stored none, so a
   * reader shows the gap instead of dropping the row.
   */
  reason?: string | null
}

/** The stored reason an untestable cell gives; never invented. */
function untestableReason(cell: SelectedContextCell): string | null {
  const reason = cell.outerAbsent?.reason ?? cell.result.reason
  return reason?.trim() ? reason.trim() : null
}

function isUnder(path: string, dir: string): boolean {
  const rel = relative(resolve(dir), resolve(path))
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel))
}

export function selectionFile(
  projection: SelectedProjection,
  workingRunIds: ReadonlySet<string>,
  contentDir: string,
): { cells: SelectionFileCell[]; outerAbsentRefusals: string[] } {
  const root = resolve(contentDir, "..")
  const cells: SelectionFileCell[] = []
  for (const [context, summary] of Object.entries(projection.contexts)) {
    for (const [featureId, cell] of Object.entries(summary.cells)) {
      const runId = cell.origin.runId
      const version = cell.run.subject.version
      if (!version) throw new Error(`${runId} ${featureId}: selected cell has no subject version`)
      const working = workingRunIds.has(runId)
      if (!cell.run.probeHash) throw new Error(`${runId} ${featureId}: selected cell's run has no probe hash`)
      if (!working && !isUnder(cell.run.path, contentDir)) {
        throw new Error(`${runId} ${featureId}: placed run file ${cell.run.path} is not under ${contentDir}`)
      }
      const status = cell.featureResult?.status ?? cell.result.status
      cells.push({
        featureId,
        status,
        terminalId: cell.run.subject.id,
        version,
        os: cell.run.subject.os,
        context,
        measuredAt: cell.run.measuredAt,
        suiteId: cell.run.suiteId,
        ...suiteRelationOf(cell.run.probeHash, projection.treeSuiteId),
        runId,
        source: working ? "working" : "placed",
        contentPath: working ? null : relative(root, resolve(cell.run.path)).split(sep).join("/"),
        ...(cell.supplement && { supplement: cell.supplement }),
        ...(cell.reopened && { reopened: cell.reopened }),
        ...(cell.outerAbsent && { outerAbsent: cell.outerAbsent }),
        ...(status === "untestable" && { reason: untestableReason(cell) }),
      })
    }
  }
  cells.sort((a, b) => a.terminalId.localeCompare(b.terminalId) || a.featureId.localeCompare(b.featureId))
  // #33665 condition 2: a mux run whose Unsupported input rows kept their reading says why, in the file the map reads.
  const outerAbsentRefusals = Object.values(projection.contexts).flatMap((summary) => summary.outerAbsentRefusals ?? [])
  return { cells, outerAbsentRefusals }
}

/** Refuse a path that is the content directory or inside it. */
export function refuseOutputUnderContent(outPath: string, contentDir: string): void {
  if (isUnder(outPath, contentDir)) {
    throw new Error(`${outPath}: --out must not be under content/`)
  }
}

export function parseSelectionArgs(argv: readonly string[]): {
  out: string
  content: string
  workingRuns: string[]
} {
  let out: string | undefined
  let content = CONTENT_DIR
  const workingRuns: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const next = argv[i + 1]
    if (arg === "--out" && next) {
      out = next
      i++
    } else if (arg === "--content" && next) {
      content = next
      i++
    } else if (arg === "--working-run" && next) {
      workingRuns.push(next)
      i++
    } else {
      throw new Error(`unknown argument ${arg ?? ""}`)
    }
  }
  if (!out) throw new Error("--out is required")
  return { out, content, workingRuns }
}

export function writeSelection(options: { out: string; content: string; workingRuns: readonly string[] }): number {
  refuseOutputUnderContent(options.out, options.content)
  const catalog = Object.keys(loadFeatures(options.content))
  const root = resolve(options.content, "..")
  const loaded = options.workingRuns.map((path) => loadRawCapture(path, { root, catalogIds: catalog }))
  const projection = loadSelectedResults(options.content, probeHash(), { workingRuns: loaded })
  const document = selectionFile(projection, new Set(loaded.map((run) => run.runId)), options.content)
  const apps = appSections(projection, compatibilitySubjects(projection, options.content), options.content)
  writeFileSync(options.out, `${JSON.stringify({ ...document, apps }, null, 2)}\n`)
  console.log(`wrote ${document.cells.length} cells`)
  return document.cells.length
}

if (import.meta.main) {
  const args = parseSelectionArgs(process.argv.slice(2))
  writeSelection(args)
}

/** One app as the site counts it: every context that measured the same release, joined by rule (@cto d321729a). */
export interface SelectionFileApp {
  routeKey: string
  kind: string
  /** The measured app id, the same `terminalId` the per-cell rows carry. */
  id: string
  /** The recorded OS of the primary context, so a page can key an app exactly as its cells key it. */
  os: string | null
  /** The newest contributing measurement across the joined contexts. */
  date: string
  /** The joined contexts, primary first. The primary is the one the site's pick order has always chosen. */
  contexts: string[]
  runs: string[]
  suites: string[]
  paths: string[]
  /** The graded probe positions the counts fold over; the catalogue's environment groups are not scores. */
  positions: number
  counts: Record<AppCellStatus, number>
  cells: Record<string, { status: AppCellStatus; from: Array<{ context: string; status: string }> }>
}

/**
 * The per-app section a status-page build reads instead of choosing the newest context itself: the same
 * `compatibilitySubjects` + `joinedAppCells` the site's own pages use, so the two can never count
 * differently. Keyed by the site's compatibility key (the app's published name).
 */
export function appSections(
  projection: SelectedProjection,
  subjects: ReadonlyMap<string, CurrentResult>,
  contentDir: string,
): Record<string, SelectionFileApp> {
  const joined = joinedAppCells(projection, subjects, contentDir)
  const apps: Record<string, SelectionFileApp> = {}
  for (const [key, subject] of subjects) {
    const app = joined.get(key)
    const primary = projection.contexts[subject.contextKey]
    if (!app || !primary?.subject) continue
    const contexts = app.contexts.flatMap((contextKey) => {
      const summary = projection.contexts[contextKey]
      return summary ? [summary] : []
    })
    const runs = new Set<string>()
    const suites = new Set<string>()
    const paths = new Set<string>()
    let date = ""
    for (const summary of contexts) {
      for (const cell of Object.values(summary.cells)) {
        runs.add(cell.run.runId)
        suites.add(cell.run.suiteId)
        if (cell.run.path) paths.add(relative(resolve(contentDir, ".."), resolve(cell.run.path)).split(sep).join("/"))
        if (cell.run.measuredAt > date) date = cell.run.measuredAt
      }
    }
    apps[key] = {
      routeKey: subject.routeKey,
      kind: primary.subject.kind,
      id: primary.subject.id,
      os: subject.os,
      date,
      contexts: app.contexts,
      runs: [...runs].sort(),
      suites: [...suites].sort(),
      paths: [...paths].sort(),
      positions: scoredFeatureIds(primary.catalogIds).length,
      counts: { ...app.counts },
      cells: Object.fromEntries(
        Object.entries(app.cells).map(([featureId, cell]) => [
          featureId,
          { status: cell.status, from: cell.from.map((grade) => ({ context: grade.context, status: grade.status })) },
        ]),
      ),
    }
  }
  return apps
}
