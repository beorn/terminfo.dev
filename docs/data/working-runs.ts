/**
 * The internal preview's hourly re-measure view: every raw (unreviewed) result of the newest COMPLETE hourly run,
 * shown BESIDE the reviewed answers the site already publishes (@cto scope GO 2026-11-02, operator-authorized).
 *
 * One environment variable, `TERMINFO_SITE_WORKING_RUNS_DIR`, names the re-measure's `runs/` directory. Unset, this
 * module returns null and the site is exactly the accepted-only site it was. Set, the newest complete run is read
 * through the one raw-capture reader (`packages/admin/raw-capture.ts`), and a missing directory, a run with no
 * complete sibling, or any unreadable capture fails the build loudly.
 *
 * Rules (verbatim intent of the scope GO):
 * - Where a reviewed answer exists it stays the HEADLINE; the raw cell sits beside it labelled "raw, unreviewed" with
 *   its run id, suite and time. On the same suite a disagreement is ALSO marked "differs from reviewed"; on a different
 *   suite the reviewed answer keeps its existing suite label and raw sits beside it. Where raw is the only answer the
 *   cell still says "raw, unreviewed".
 * - Raw has its own five counts from the shared rollup, but never enters an accepted score, count or completeness tier:
 *   this view is built AFTER the accepted projection
 *   and only reads it. No working run is ever passed into `loadCurrentResults`, whose composed contexts would fold
 *   raw cells into accepted context cells and their counts.
 * - A pending source review (criterionBranch `source-negative-review` still at TEST TODO or TEST FAILURE) reads
 *   "pending review", not failure; a reviewed answer on that branch (e.g. sealed unsupported) reads as its status.
 * - "Differs from reviewed" needs the same suite AND the same engine version, and never marks a pending raw cell.
 */
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs"
import { join, resolve, sep } from "node:path"
import { loadFeatures } from "@terminfo/catalog"
import { PROBE_STATUSES, type ProbeStatus } from "@terminfo/probe-defs"
import { parseJsonStrict, type LoadedRun } from "@terminfo/run-parser"
import { loadRawCapture, UntrustedSuiteError } from "../../packages/admin/raw-capture.ts"
import { compatibilitySubjects, loadCurrentResults, type CurrentResult } from "./current-results.ts"
import { admittedContextKeys, originalRunFor, workingSubjectKey, type SelectedProjection } from "./selected-results.ts"
import { rollupTerminalStatuses, type TerminalStatusRollup } from "./release-scope.ts"

export const WORKING_RUNS_ENV = "TERMINFO_SITE_WORKING_RUNS_DIR"
export const RAW_LABEL = "raw, unreviewed"

/** A re-measure run directory: `<ISO time with : and . as ->-<root sha, 12 hex>`. */
const RUN_DIR = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z-[0-9a-f]{12}$/

export interface WorkingRunSelection {
  /** The run directory's name: the re-measure's own run identity. */
  id: string
  dir: string
  /** When the hourly run started, from its directory name. */
  startedAt: string
}

export interface LoadedWorkingRun extends WorkingRunSelection {
  runs: LoadedRun[]
  /** Retained view shape; a complete collection must contain every requested engine. */
  unmeasured: Array<{ engine: string; status: string; reason: string }>
  /**
   * Set when the run's suite has no trusted manifest in this tree (the re-measure ran on the previous suite, e.g. right
   * after a landing changed probe sources). The build still succeeds with accepted results unchanged, and the page
   * says so loudly; `runs` is then empty. Every other read failure throws.
   */
  unreadable?: { suiteId: string; treeSuiteId: string; reason: string; banner: string }
}

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)

/**
 * The newest COMPLETE hourly run under `runsDir`. A run is complete when its `summary.json` says `complete: true`
 * and its `cells.json` exists; the re-measure writes the summary last, so a directory without one is still being
 * written (or never finished) and is never newest. A finished partial run (`complete: false`) is skipped by name. A
 * summary that exists but does not parse is a loud error, never a skip.
 */
export function newestCompleteRun(runsDir: string): WorkingRunSelection {
  let names: string[]
  try {
    names = readdirSync(runsDir)
  } catch (cause) {
    throw new Error(
      `${WORKING_RUNS_ENV}=${runsDir}: cannot list hourly runs (${cause instanceof Error ? cause.message : String(cause)})`,
      { cause },
    )
  }
  const skipped: string[] = []
  // Entries that are not run directories (no ISO-time-and-root name) are not runs and are not read.
  for (const name of names
    .filter((entry) => RUN_DIR.test(entry))
    .sort()
    .reverse()) {
    const dir = join(runsDir, name)
    const summaryPath = join(dir, "summary.json")
    if (!existsSync(summaryPath)) {
      skipped.push(`${name} (no summary.json: still being written or never finished)`)
      continue
    }
    const summary = parseJsonStrict(summaryPath, readFileSync(summaryPath, "utf8"))
    if (!record(summary) || typeof summary.complete !== "boolean") {
      throw new Error(`${summaryPath}: summary requires a boolean "complete"`)
    }
    if (!summary.complete) {
      skipped.push(`${name} (complete: false)`)
      continue
    }
    if (!existsSync(join(dir, "cells.json"))) {
      throw new Error(`${join(dir, "cells.json")}: complete summary names a run whose cells are absent`)
    }
    const [, day, hh, mm, ss, ms] = RUN_DIR.exec(name) ?? []
    return { id: name, dir, startedAt: `${day}T${hh}:${mm}:${ss}.${ms}Z` }
  }
  throw new Error(
    `no complete hourly run in ${runsDir}${skipped.length ? `; skipped ${skipped.join(", ")}` : "; no run directories"}`,
  )
}

/** Load the current hourly collection and verify its recorded rollups through the one raw-capture reader. */
export function loadWorkingRun(
  selection: WorkingRunSelection,
  options: { root: string; catalogIds: readonly string[] },
): LoadedWorkingRun {
  const summaryPath = join(selection.dir, "summary.json")
  const summary = parseJsonStrict(summaryPath, readFileSync(summaryPath, "utf8"))
  const collectionPath = join(selection.dir, "headless", "collection.json")
  const collection = parseJsonStrict(collectionPath, readFileSync(collectionPath, "utf8"))
  const strings = (value: unknown): value is string[] =>
    Array.isArray(value) && value.every((entry) => typeof entry === "string" && entry.length > 0)
  if (
    !record(collection) ||
    !strings(collection.requested) ||
    !strings(collection.runs) ||
    !Array.isArray(collection.failures)
  ) {
    throw new Error(`${collectionPath}: collection requires requested, runs and failures arrays`)
  }
  const expected = collection.requested
  if (
    !record(summary) ||
    summary.complete !== true ||
    !strings(summary.expectedEngines) ||
    !strings(summary.presentEngines) ||
    !Array.isArray(summary.missingEngines) ||
    !Array.isArray(summary.refused) ||
    expected.length === 0 ||
    new Set(expected).size !== expected.length ||
    collection.runs.length !== expected.length ||
    collection.failures.length !== 0 ||
    summary.missingEngines.length !== 0 ||
    summary.refused.length !== 0 ||
    [summary.expectedEngines, summary.presentEngines].some(
      (engines) =>
        engines.length !== expected.length ||
        new Set(engines).size !== expected.length ||
        engines.some((engine) => !expected.includes(engine)),
    )
  ) {
    throw new Error(
      `${summaryPath}: complete run must record every requested engine without missing or refused captures (${collectionPath})`,
    )
  }
  const rollups = summary.rollups
  if (!record(rollups)) throw new Error(`${summaryPath}: complete run requires per-engine rollups`)
  for (const engine of expected) {
    const rollup = rollups[engine]
    const counts = record(rollup) ? rollup.counts : undefined
    if (
      !record(counts) ||
      !PROBE_STATUSES.every(
        (status) =>
          typeof counts[status] === "number" && Number.isInteger(counts[status]) && Number(counts[status]) >= 0,
      )
    ) {
      throw new Error(`${summaryPath}: missing or invalid rollup for ${engine}`)
    }
  }
  const runRoot = realpathSync(selection.dir) + sep
  // Check every expected resource before an older-suite warning can return early.
  const rawPaths = collection.runs.map((path) => {
    const rawPath = resolve(selection.dir, path)
    if (!existsSync(rawPath) || !realpathSync(rawPath).startsWith(runRoot)) {
      throw new Error(`${collectionPath}: raw capture ${path} outside the run directory or absent`)
    }
    return rawPath
  })
  const runs: LoadedRun[] = []
  const seen = new Set<string>()
  for (const rawPath of rawPaths) {
    let run: LoadedRun
    try {
      run = loadRawCapture(rawPath, { root: options.root, catalogIds: options.catalogIds })
    } catch (error) {
      if (!(error instanceof UntrustedSuiteError)) throw error
      return {
        ...selection,
        runs: [],
        unmeasured: [],
        unreadable: {
          suiteId: error.suiteId,
          treeSuiteId: error.treeSuiteId,
          reason: error.message,
          banner:
            `Hourly run ${selection.id} (suite ${error.suiteId}) cannot be read by this build: no trusted manifest ` +
            `for that suite; next hourly run on suite ${error.treeSuiteId} will show`,
        },
      }
    }
    const engine = run.subject.id
    if (!expected.includes(engine) || seen.has(engine)) {
      throw new Error(`${collectionPath}: unexpected or duplicate captured engine ${engine} in ${rawPath}`)
    }
    seen.add(engine)
    const rollup = rollups[engine]
    const actual = rollupTerminalStatuses(
      Object.fromEntries((run.results ?? []).map((result) => [result.featureId, result.status])),
      options.catalogIds,
    )
    if (
      !record(rollup) ||
      !record(rollup.counts) ||
      rollup.positions !== actual.positions ||
      rollup.environmentPositions !== actual.environmentPositions ||
      PROBE_STATUSES.some((status) => record(rollup.counts) && rollup.counts[status] !== actual.counts[status])
    ) {
      throw new Error(`${summaryPath}: rollup for ${engine} disagrees with recorded capture ${rawPath}`)
    }
    runs.push(run)
  }
  return { ...selection, runs, unmeasured: [] }
}

/** The runs directory the site build reads, or undefined when the variable is unset or blank. */
export function siteWorkingRunsDir(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const raw = env[WORKING_RUNS_ENV]?.trim()
  if (!raw) return undefined
  if (!statSync(raw, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`${WORKING_RUNS_ENV}=${raw}: not a directory`)
  }
  return raw
}

/**
 * One selection per process, shared through `globalThis` like the results cache (VitePress bundles each data loader
 * separately): the config's build stamp and every page read the SAME run, even if a newer one completes mid-build.
 */
const SELECTION_CACHE = Symbol.for("terminfo.dev/workingRunSelection")
const LOADED_CACHE = Symbol.for("terminfo.dev/workingRunLoaded")
const host = globalThis as unknown as { [k: symbol]: Map<string, unknown> | undefined }

export function selectedSiteWorkingRun(env: NodeJS.ProcessEnv = process.env): WorkingRunSelection | null {
  const dir = siteWorkingRunsDir(env)
  if (dir === undefined) return null
  const cache = (host[SELECTION_CACHE] ??= new Map())
  const known = cache.get(dir) as WorkingRunSelection | undefined
  if (known) return known
  const selection = newestCompleteRun(dir)
  cache.set(dir, selection)
  return selection
}

const REPO_ROOT = join(import.meta.dirname, "..", "..")

export function siteWorkingRun(env: NodeJS.ProcessEnv = process.env): LoadedWorkingRun | null {
  const selection = selectedSiteWorkingRun(env)
  if (selection === null) return null
  const cache = (host[LOADED_CACHE] ??= new Map())
  const known = cache.get(selection.dir) as LoadedWorkingRun | undefined
  if (known) return known
  const catalogIds = Object.keys(loadFeatures(join(REPO_ROOT, "content")))
  const loaded = loadWorkingRun(selection, { root: REPO_ROOT, catalogIds })
  // Once per process (memoized): the unit log carries the reason beside the banner the page shows.
  if (loaded.unreadable) {
    console.warn(`terminfo-site: WARNING ${loaded.unreadable.banner} (${loaded.unreadable.reason})`)
  }
  cache.set(selection.dir, loaded)
  return loaded
}

/** The `workingRun` field of build.json: the run every page read, and why it could not be read when it could not. */
export function workingRunStamp(loaded: LoadedWorkingRun): { id: string; startedAt: string; unreadable?: string } {
  return {
    id: loaded.id,
    startedAt: loaded.startedAt,
    ...(loaded.unreadable && { unreadable: loaded.unreadable.reason }),
  }
}

export interface RawSide {
  featureId: string
  status: ProbeStatus
  criterionBranch?: string
  runId: string
  suiteId: string
  /** The engine version the raw run measured. */
  version: string
  measuredAt: string
}

export interface ReviewedSide {
  status: ProbeStatus
  criterionBranch?: string
  runId: string
  suiteId: string
  /** The engine version the reviewed run measured; a different version never "differs". */
  version: string
  measuredAt: string
  /** The reviewed run's existing suite label (`release suite …`, `older suite …`), shown unchanged. */
  suiteLabel: string
}

export interface WorkingCell {
  featureId: string
  /** Which side is the headline: the reviewed answer wherever one exists. */
  headline: "reviewed" | "raw"
  relation: "same-suite" | "different-suite" | "raw-only"
  reviewed: (ReviewedSide & { display: string }) | null
  raw: RawSide & { label: typeof RAW_LABEL; display: string; differsFromReviewed: boolean }
}

// No cell waits on a source review any more (#32246): a retired source-negative cell reads its own status.
const display = (side: { status: ProbeStatus }): string => side.status

/** The per-cell provenance rule; pure, so the headline rule is tested without a corpus. */
export function workingCell(raw: RawSide, reviewed: ReviewedSide | undefined): WorkingCell {
  const relation =
    reviewed === undefined ? "raw-only" : reviewed.suiteId === raw.suiteId ? "same-suite" : "different-suite"
  return {
    featureId: raw.featureId,
    headline: reviewed === undefined ? "raw" : "reviewed",
    relation,
    reviewed: reviewed === undefined ? null : { ...reviewed, display: display(reviewed) },
    raw: {
      ...raw,
      label: RAW_LABEL,
      display: display(raw),
      differsFromReviewed:
        relation === "same-suite" && reviewed?.version === raw.version && reviewed.status !== raw.status,
    },
  }
}

export interface WorkingContext {
  /** The projection's key for this working run: the admitted key, or the qualified working-only form. */
  contextKey: string
  /** The reviewed context the site publishes for this subject, or null when raw is the only answer. */
  reviewedContextKey: string | null
  kind: string
  engine: string
  version: string
  runId: string
  suiteId: string
  sourceRevision: string
  measuredAt: string
  cells: WorkingCell[]
  counts: TerminalStatusRollup["counts"]
  positions: TerminalStatusRollup["positions"]
}

export interface WorkingView {
  label: typeof RAW_LABEL
  rule: string
  run: { id: string; startedAt: string; newestCaptureAt: string; suites: string[] }
  /** The loud banner when this build cannot read the run's suite; `contexts` is then empty. */
  unreadable?: LoadedWorkingRun["unreadable"]
  contexts: WorkingContext[]
  unmeasured: LoadedWorkingRun["unmeasured"]
}

/**
 * Compose the hourly view beside the ACCEPTED projection. `reviewed` is the site's own reviewed selection per subject
 * (`compatibilitySubjects`); the projection is only read, so every accepted rollup is untouched.
 */
export function composeWorkingView(
  projection: SelectedProjection,
  reviewed: ReadonlyMap<string, CurrentResult>,
  working: LoadedWorkingRun,
): WorkingView {
  const admitted = admittedContextKeys(projection.versions)
  const bySubject = new Map<string, CurrentResult>()
  for (const entry of reviewed.values()) {
    if (!entry.selected.subject) throw new Error(`Reviewed context ${entry.contextKey} has no physical subject`)
    bySubject.set(`${entry.selected.subject.kind}:${entry.selected.subject.id}`, entry)
  }
  const seen = new Set<string>()
  const contexts = working.runs.map((run): WorkingContext => {
    if (!run.results || !run.probeHash || !run.sourceRevision) {
      throw new Error(`Working run ${run.runId} lacks its recorded results, suite or source revision`)
    }
    const contextKey = workingSubjectKey(admitted, run.subject)
    if (seen.has(contextKey)) throw new Error(`Hourly run ${working.id} carries two runs for ${contextKey}`)
    seen.add(contextKey)
    const review = bySubject.get(`${run.subject.kind}:${run.subject.id}`)
    const suiteId = run.probeHash
    const cells = run.results.map((result) => {
      const cell = review?.selected.cells[result.featureId]
      const reviewedSide: ReviewedSide | undefined =
        cell && review
          ? {
              status: cell.result.status,
              ...(cell.result.criterionBranch !== undefined && { criterionBranch: cell.result.criterionBranch }),
              runId: cell.run.runId,
              suiteId: cell.run.probeHash ?? cell.run.suiteId,
              version: cell.run.subject.version,
              measuredAt: cell.run.measuredAt,
              suiteLabel: originalRunFor(projection, review.contextKey, cell.run.runId).suiteFreshness,
            }
          : undefined
      return workingCell(
        {
          featureId: result.featureId,
          status: result.status,
          ...(result.criterionBranch !== undefined && { criterionBranch: result.criterionBranch }),
          runId: run.runId,
          suiteId,
          version: run.subject.version,
          measuredAt: run.measuredAt,
        },
        reviewedSide,
      )
    })
    const { counts, positions } = rollupTerminalStatuses(
      Object.fromEntries(run.results.map((result) => [result.featureId, result.status])),
    )
    return {
      contextKey,
      reviewedContextKey: review?.contextKey ?? null,
      kind: run.subject.kind,
      engine: run.subject.id,
      version: run.subject.version,
      runId: run.runId,
      suiteId,
      sourceRevision: run.sourceRevision,
      measuredAt: run.measuredAt,
      cells,
      counts,
      positions,
    }
  })
  contexts.sort((a, b) => a.engine.localeCompare(b.engine) || a.contextKey.localeCompare(b.contextKey))
  return {
    label: RAW_LABEL,
    rule:
      "Raw, unreviewed hourly results have their own counts beside the reviewed answer and never replace it. " +
      "They enter no accepted score, count, completeness tier or rollup.",
    run: {
      id: working.id,
      startedAt: working.startedAt,
      newestCaptureAt:
        working.runs
          .map((run) => run.measuredAt)
          .sort()
          .at(-1) ?? (working.unreadable ? "not read (no trusted manifest for its suite)" : ""),
      suites: working.unreadable
        ? [working.unreadable.suiteId]
        : [...new Set(contexts.map((context) => context.suiteId))].sort(),
    },
    contexts,
    unmeasured: working.unmeasured,
    ...(working.unreadable && { unreadable: working.unreadable }),
  }
}

/** The site's hourly view from the default accepted reading, or null when the variable is unset. */
export function siteWorkingView(contentDir: string, env: NodeJS.ProcessEnv = process.env): WorkingView | null {
  const working = siteWorkingRun(env)
  if (working === null) return null
  const { projection } = loadCurrentResults(contentDir)
  return composeWorkingView(projection, compatibilitySubjects(projection, contentDir), working)
}
