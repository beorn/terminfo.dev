/**
 * Write the current selection to a caller-given path. The file is never committed and is not under content/.
 * Placed runs come from content/. Each --working-run is passed through the existing workingRuns input.
 */
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { loadFeatures } from "@terminfo/catalog"
import { parseJsonStrict, type LoadedRun } from "@terminfo/run-parser"
import { probeHash } from "../../packages/admin/versions.ts"
import { CONTENT_DIR } from "../../packages/admin/corpus-placement.ts"
import { loadRawCapture, loadRawCaptureWithManifest } from "../../packages/admin/raw-capture.ts"
import { retainedSuiteManifestPath } from "../../packages/admin/suite-retention.ts"
import {
  loadSelectedResults,
  suiteRelationOf,
  type SelectedContextCell,
  type SelectedProjection,
} from "./selected-results.ts"
import { compatibilitySubjects, joinedAppCells, type CurrentResult } from "./current-results.ts"
import { sameRunEntryHashes, type RunEntryHashes } from "./legacy-entry-hashes.ts"
import { publicDeclaredReason } from "./declared-untestable.ts"
import { scoredFeatureIds } from "@terminfo/probe-defs"
import type { AppCellStatus } from "./app-cells.ts"
import { rollupTerminalStatuses } from "./release-scope.ts"

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
  /** Present only when a reviewed declaration made this open cell untestable (@cto 82a54984); counted "by review". */
  declared?: SelectedContextCell["declared"]
  /**
   * Present only on an untestable cell (#33928): why no route measures it, as stored — the mux-input demotion's reason
   * when that demotion made it untestable, else the run's own result reason. null when the run stored none, so a
   * reader shows the gap instead of dropping the row.
   */
  reason?: string | null
}

/** The stored reason an untestable cell gives; never invented. */
function untestableReason(cell: SelectedContextCell): string | null {
  const reason = cell.declared ? publicDeclaredReason(cell.declared) : (cell.outerAbsent?.reason ?? cell.result.reason)
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
        ...(cell.declared && { declared: cell.declared }),
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
  /** A file of {id, os, probe} rows a status page defers to a later release; each app's asideTier leaves them out. */
  aside?: string
} {
  let out: string | undefined
  let content = CONTENT_DIR
  let aside: string | undefined
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
    } else if (arg === "--aside" && next) {
      aside = next
      i++
    } else {
      throw new Error(`unknown argument ${arg ?? ""}`)
    }
  }
  if (!out) throw new Error("--out is required")
  return aside === undefined ? { out, content, workingRuns } : { out, content, workingRuns, aside }
}

/** One collection record: `collection.json` for a headless collection, `pass.json` for an app, hosted or owned-app pass. */
export interface WorkingRunRecord {
  readonly directory: string
  readonly recordPath: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function physicalPath(path: string): string | undefined {
  return existsSync(path) ? realpathSync(path) : undefined
}

/**
 * The pass that recorded this run. An app run sits below its pass — `<pass>/linux/<context>/<run>/raw/v3-run.json`,
 * and a draft `raw/artifacts/<runId>.draft.json` one level deeper again — so the record is wherever it is, and the
 * walk goes to the filesystem root rather than to a guessed depth. Only a pass whose `contexts[]` (or a supplement)
 * names this exact raw run is that run's record: a pass that does not name it refuses by name, because reading the
 * run under it would swap its trust source silently.
 */
function passRecordingRun(target: string, rawPath: string): WorkingRunRecord | undefined {
  let directory = dirname(rawPath)
  for (;;) {
    const parent = dirname(directory)
    const recordPath = join(parent, "pass.json")
    if (existsSync(recordPath)) {
      const record = parseJsonStrict(recordPath, readFileSync(recordPath, "utf8"))
      if (!isRecord(record) || !Array.isArray(record.contexts)) {
        throw new Error(`${recordPath}: a pass record carries its contexts`)
      }
      const names = (value: unknown): boolean => {
        if (typeof value !== "string") return false
        return physicalPath(resolve(parent, value)) === target
      }
      const recorded = record.contexts.some(
        (row) =>
          isRecord(row) &&
          (names(row.rawRun) ||
            (Array.isArray(row.supplements) && row.supplements.some((item) => isRecord(item) && names(item.rawRun)))),
      )
      if (!recorded) {
        throw new Error(
          `${recordPath}: names no working run ${rawPath}; an app run is read through the pass that recorded it`,
        )
      }
      return { directory: parent, recordPath }
    }
    if (parent === directory) return undefined
    directory = parent
  }
}

/**
 * The record a working run is read through. 33987 (@cto ruling C): every reader of an unplaced run reads the
 * declaration the producer retained beside that run, found through this record and never in `content/suites`.
 *
 * A placed corpus original is the one run with no record, and only inside `content/` is it one: an unplaced run whose
 * producer wrote no record refuses by name, because it would otherwise be read under committed or current-tree trust —
 * the silent trust swap this rule exists to prevent.
 */
export function workingRunRecord(rawPath: string, contentDir: string): WorkingRunRecord | undefined {
  const target = physicalPath(rawPath)
  // An absent run is named by the capture reader, which says what is missing about it.
  if (target === undefined) return undefined
  const directory = dirname(rawPath)
  const beside = ["collection.json", "pass.json"]
    .map((name) => join(directory, name))
    .filter((path) => existsSync(path))
  if (beside.length > 1) {
    throw new Error(`${directory}: a working run's collection carries one record; found ${beside.join(", ")}`)
  }
  const recordPath = beside[0]
  if (recordPath !== undefined) return { directory, recordPath }
  const recorded = passRecordingRun(target, rawPath)
  if (recorded !== undefined) return recorded
  if (isUnder(target, contentDir)) return undefined
  throw new Error(
    `${rawPath}: no collection record names this working run and it is not under ${contentDir}; an unplaced run is read through the record its producer wrote`,
  )
}

/** A loaded working run, with its retained manifest's entry hashes when the run was read through one (34953). */
interface WorkingRead {
  run: LoadedRun
  retained?: RunEntryHashes
}

function readWorkingRun(rawPath: string, contentDir: string, root: string, catalogIds: readonly string[]): WorkingRead {
  const found = workingRunRecord(rawPath, contentDir)
  if (found === undefined) return { run: loadRawCapture(rawPath, { root, catalogIds }) }
  const record = parseJsonStrict(found.recordPath, readFileSync(found.recordPath, "utf8"))
  if (!isRecord(record)) throw new Error(`${found.recordPath}: a collection record is a JSON object`)
  // A pass written before the field existed keeps the custody it had (33987, @cto c11afb84 cure (a)).
  if (!("suiteManifest" in record)) return { run: loadRawCapture(rawPath, { root, catalogIds }) }
  const manifestPath = retainedSuiteManifestPath(found.directory, record.suiteManifest, found.recordPath)
  const { run, manifest } = loadRawCaptureWithManifest(rawPath, { root, catalogIds, manifestPath })
  const hashes = manifest.catalogEntrySha256
  return hashes === undefined ? { run } : { run, retained: { suiteId: manifest.probeHash, catalogEntrySha256: hashes } }
}

/** Each working run read through its retained manifest, by run id; one id read twice must agree (34953). */
function retainedEntryHashes(reads: readonly WorkingRead[]): Map<string, RunEntryHashes> {
  const byRun = new Map<string, RunEntryHashes>()
  for (const { run, retained } of reads) {
    if (retained === undefined) continue
    const seen = byRun.get(run.runId)
    if (seen !== undefined && !sameRunEntryHashes(seen, retained)) {
      throw new Error(
        `working run ${run.runId} was read twice through different retained manifests; ` +
          "pass each raw run once with --working-run, or re-capture it so one manifest holds it",
      )
    }
    byRun.set(run.runId, retained)
  }
  return byRun
}

/**
 * The --aside file: a JSON array of {id, os, probe} rows, keyed here as "<id>/<os>/<probe>". A row missing a field is refused
 * by its index, never skipped, so a status page cannot set aside less than it listed (#37673).
 */
export function readAsideRows(path: string): Set<string> {
  const rows: unknown = parseJsonStrict(path, readFileSync(path, "utf8"))
  if (!Array.isArray(rows)) throw new Error(`${path}: --aside takes a JSON array of {id, os, probe} rows`)
  return new Set(
    rows.map((row, index) => {
      if (!isRecord(row) || typeof row.id !== "string" || typeof row.os !== "string" || typeof row.probe !== "string") {
        throw new Error(`${path} row ${index} needs string id, os and probe: ${JSON.stringify(row)}`)
      }
      return `${row.id}/${row.os}/${row.probe}`
    }),
  )
}

/**
 * One joined app's completeness tier as the site counts it, and the same rule with `aside` (feature ids) left out of both
 * the statuses and the catalogue, with how many open results that set aside (#37673): a set-aside result a run has since
 * decided lowers no tier, so it is not counted. All three read rollupTerminalStatuses, the one tier rule; a status page
 * shows them side by side and never re-derives any.
 */
export function appTiers(
  cells: Readonly<Record<string, { readonly status: AppCellStatus }>>,
  catalogIds: readonly string[],
  aside: ReadonlySet<string>,
): { completenessTier: 0 | 1 | 2 | 3; asideTier: 0 | 1 | 2 | 3; aside: number } {
  const statuses = Object.fromEntries(Object.entries(cells).map(([featureId, cell]) => [featureId, cell.status]))
  const kept = catalogIds.filter((featureId) => !aside.has(featureId))
  const keptStatuses = Object.fromEntries(Object.entries(statuses).filter(([featureId]) => !aside.has(featureId)))
  const site = rollupTerminalStatuses(statuses, catalogIds)
  const release = rollupTerminalStatuses(keptStatuses, kept)
  return {
    completenessTier: site.completenessTier,
    asideTier: release.completenessTier,
    aside: site.open - release.open,
  }
}

export function writeSelection(options: {
  out: string
  content: string
  workingRuns: readonly string[]
  aside?: string
}): number {
  refuseOutputUnderContent(options.out, options.content)
  const catalog = Object.keys(loadFeatures(options.content))
  const root = resolve(options.content, "..")
  const reads = options.workingRuns.map((path) => readWorkingRun(path, options.content, root, catalog))
  const loaded = reads.map((read) => read.run)
  const projection = loadSelectedResults(options.content, probeHash(), { workingRuns: loaded })
  const document = selectionFile(projection, new Set(loaded.map((run) => run.runId)), options.content)
  const subjects = compatibilitySubjects(projection, options.content)
  const aside = options.aside === undefined ? new Set<string>() : readAsideRows(options.aside)
  const apps = appSections(projection, subjects, options.content, retainedEntryHashes(reads), aside)
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
  /** The site's completeness tier over the joined cells, and the same rule with the --aside rows left out (#37673). */
  completenessTier: 0 | 1 | 2 | 3
  asideTier: 0 | 1 | 2 | 3
  /** How many open results --aside left out of asideTier (a decided one lowers no tier and is not counted). */
  aside: number
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
  working: ReadonlyMap<string, RunEntryHashes> = new Map(),
  /** "<id>/<os>/<probe>" rows set aside from each app's asideTier (readAsideRows). */
  aside: ReadonlySet<string> = new Set(),
): Record<string, SelectionFileApp> {
  const joined = joinedAppCells(projection, subjects, contentDir, undefined, working)
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
      ...appTiers(
        app.cells,
        primary.catalogIds,
        new Set(
          primary.catalogIds.filter((featureId) => aside.has(`${primary.subject.id}/${subject.os}/${featureId}`)),
        ),
      ),
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
