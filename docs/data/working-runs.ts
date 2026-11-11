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
 * - Every cell reads as its status; no cell waits on a source review (#32246).
 * - "Differs from reviewed" needs the same suite AND the same engine version and a different status.
 */
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs"
import { basename, dirname, join, resolve, sep } from "node:path"
import { loadFeatures } from "@terminfo/catalog"
import {
  PROBE_STATUSES,
  FEATURE_RESULT_STATUSES,
  isEnvironmentGroup,
  type ProbeStatus,
  type FeatureResultStatus,
} from "@terminfo/probe-defs"
import { parseJsonStrict, storedProbeStatus, type LoadedRun } from "@terminfo/run-parser"
import { loadRawCapture, UntrustedSuiteError } from "../../packages/admin/raw-capture.ts"
import { compatibilitySubjects, loadCurrentResults, type CurrentResult } from "./current-results.ts"
import { admittedContextKeys, originalRunFor, workingSubjectKey, type SelectedProjection } from "./selected-results.ts"
import { rollupTerminalStatuses, type TerminalStatusRollup } from "./release-scope.ts"
import { fullContextCensus, type CensusContext } from "./full-census.ts"

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
  /** Existing hourly summary receipt, consumed only by private history presentation. */
  changeRecord?: unknown
  /** Retained view shape; a complete collection must contain every requested engine. */
  unmeasured: Array<{ engine: string; status: string; reason: string }>
  /**
   * Set when the run's suite has no trusted manifest in this tree (the re-measure ran on the previous suite, e.g. right
   * after a landing changed probe sources). The build still succeeds with accepted results unchanged, and the page
   * says so loudly; `runs` is then empty. Every other read failure throws.
   */
  unreadable?: { suiteId: string; treeSuiteId: string; reason: string; banner: string }
  /**
   * The pass's context supplements (33119) this preview does not apply, in one line. A supplement's answers reach a
   * cell only once placed beside its default run (33550, @cto 2c2f2394), so the preview says what it leaves out.
   */
  unapplied?: string
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
  const [selection] = completeRunSelections(runsDir)
  // The enumeration throws when no complete selection exists.
  return selection as WorkingRunSelection
}

/** One enumeration owner for newest-only callers and retained page history. */
function* completeRunSelections(runsDir: string, latestId?: string): Generator<WorkingRunSelection> {
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
  let found = false
  // Entries that are not run directories (no ISO-time-and-root name) are not runs and are not read.
  for (const name of names
    .filter((entry) => RUN_DIR.test(entry) && (latestId === undefined || entry <= latestId))
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
    found = true
    yield { id: name, dir, startedAt: `${day}T${hh}:${mm}:${ss}.${ms}Z` }
  }
  if (!found) {
    throw new Error(
      `no complete hourly run in ${runsDir}${skipped.length ? `; skipped ${skipped.join(", ")}` : "; no run directories"}`,
    )
  }
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
  const decodedCounts = new Map<string, Map<FeatureResultStatus, number>>()
  for (const engine of expected) {
    const rollup = rollups[engine]
    const counts = record(rollup) ? rollup.counts : undefined
    if (!record(counts)) {
      throw new Error(`${summaryPath}: missing or invalid rollup for ${engine}`)
    }
    const normalized = new Map<FeatureResultStatus, number>()
    for (const [key, count] of Object.entries(counts)) {
      const decoded = storedProbeStatus(key)
      const status = FEATURE_RESULT_STATUSES.find((status) => status === decoded)
      if (status === undefined) {
        throw new Error(`${summaryPath}: rollup for ${engine} has unknown status key ${key}`)
      }
      if (normalized.has(status)) {
        throw new Error(`${summaryPath}: rollup for ${engine} contains both legacy and canonical keys for ${status}`)
      }
      if (typeof count !== "number" || !Number.isInteger(count) || count < 0) {
        throw new Error(`${summaryPath}: missing or invalid rollup for ${engine}`)
      }
      normalized.set(status, count)
    }
    if (!PROBE_STATUSES.every((status) => normalized.has(status))) {
      throw new Error(`${summaryPath}: missing or invalid rollup for ${engine}`)
    }
    decodedCounts.set(engine, normalized)
  }
  const runRoot = realpathSync(selection.dir) + sep
  const retainedPaths = [...collection.runs]
  const runCount = retainedPaths.length
  if (Object.hasOwn(collection, "suiteManifest")) {
    if (
      typeof collection.suiteManifest !== "string" ||
      !/^suites\/[0-9a-f]{12}\.json$/u.test(collection.suiteManifest)
    ) {
      throw new Error(`${collectionPath}: suiteManifest must name suites/<twelve-lowercase-hex-suite-id>.json`)
    }
    retainedPaths.push(resolve(selection.dir, "headless", collection.suiteManifest))
  }
  // Check every expected resource before an older-suite warning can return early.
  const checkedPaths = retainedPaths.map((path, index) => {
    const rawPath = resolve(selection.dir, path)
    if (!existsSync(rawPath) || !realpathSync(rawPath).startsWith(runRoot)) {
      const resource = index < runCount ? "raw capture" : "suite manifest"
      throw new Error(`${collectionPath}: ${resource} ${path} outside the run directory or absent`)
    }
    return rawPath
  })
  const rawPaths = checkedPaths.slice(0, runCount)
  const manifestPath = checkedPaths[runCount]
  const runs: LoadedRun[] = []
  const seen = new Set<string>()
  for (const rawPath of rawPaths) {
    let run: LoadedRun
    try {
      run = loadRawCapture(rawPath, { root: options.root, catalogIds: options.catalogIds, manifestPath })
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
    const counts = decodedCounts.get(engine)
    const actual = rollupTerminalStatuses(
      Object.fromEntries((run.results ?? []).map((result) => [result.featureId, result.status])),
      options.catalogIds,
    )
    if (
      !record(rollup) ||
      !counts ||
      rollup.positions !== actual.positions ||
      rollup.environmentPositions !== actual.environmentPositions ||
      // The feature-only conflict counter was absent in retained five-status hourly summaries.
      FEATURE_RESULT_STATUSES.some((status) => (counts.get(status) ?? 0) !== actual.counts[status])
    ) {
      throw new Error(`${summaryPath}: rollup for ${engine} disagrees with recorded capture ${rawPath}`)
    }
    runs.push(run)
  }
  return { ...selection, runs, unmeasured: [], ...(Object.hasOwn(summary, "moved") && { changeRecord: summary.moved }) }
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
const HISTORY_CACHE = Symbol.for("terminfo.dev/workingRunHistorySelections")
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
  return loadedSiteWorkingRun(selection)
}

function loadedSiteWorkingRun(selection: WorkingRunSelection, retain = true): LoadedWorkingRun {
  const cache = (host[LOADED_CACHE] ??= new Map())
  const known = cache.get(selection.dir) as LoadedWorkingRun | undefined
  if (known) return known
  const catalogIds = Object.keys(loadFeatures(join(REPO_ROOT, "content")))
  const loaded = loadWorkingRun(selection, { root: REPO_ROOT, catalogIds })
  // Once per process (memoized): the unit log carries the reason beside the banner the page shows.
  if (loaded.unreadable) {
    console.warn(`terminfo-site: WARNING ${loaded.unreadable.banner} (${loaded.unreadable.reason})`)
  }
  if (retain) cache.set(selection.dir, loaded)
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
  status: FeatureResultStatus
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
const display = (side: { status: FeatureResultStatus }): string => side.status

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
  /** Original receipts and recorded change captions, populated only in private history views. */
  sha256?: string
  identity?: LoadedRun["identity"]
  changeBaseline?: string
  changeQualification?: string
  changes?: Record<string, string>
  /** Private history stores each recorded status once; receipts live on this context. */
  states?: Readonly<Record<string, FeatureResultStatus>>
}

export interface WorkingView {
  label: typeof RAW_LABEL
  rule: string
  run: { id: string; startedAt: string; newestCaptureAt: string; suites: string[] }
  /** A suite or retained-input gap is visible without inventing context counts. */
  unreadable?: Pick<NonNullable<LoadedWorkingRun["unreadable"]>, "reason" | "banner">
  unapplied?: string
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
    const candidate = bySubject.get(`${run.subject.kind}:${run.subject.id}`)
    const review =
      run.subject.kind === "lib" || candidate?.selected.subject?.os === run.subject.os ? candidate : undefined
    const suiteId = run.probeHash
    const cells = run.results.map((result) => {
      const cell = review?.selected.cells[result.featureId]
      const status = isEnvironmentGroup(result.featureId) ? cell?.result.status : cell?.featureResult?.status
      if (cell && status === undefined) {
        throw new Error(`Reviewed context ${review?.contextKey}/${result.featureId} lacks its computed feature result`)
      }
      const reviewedSide: ReviewedSide | undefined =
        cell && review && status !== undefined
          ? {
              status,
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
    ...(working.unapplied !== undefined && { unapplied: working.unapplied }),
  }
}

/** The site's hourly view from the default accepted reading, or null when the variable is unset. */
export function siteWorkingView(contentDir: string, env: NodeJS.ProcessEnv = process.env): WorkingView | null {
  const working = siteWorkingRun(env)
  if (working === null) return null
  const { projection } = loadCurrentResults(contentDir)
  return composeWorkingView(projection, compatibilitySubjects(projection, contentDir), working)
}

/** App passes retain their own index; capture decoding and status folding keep their existing owners. */
function loadAppWorkingRun(
  selection: WorkingRunSelection,
  context: CensusContext,
  librariesDir: string,
  catalogIds: readonly string[],
): LoadedWorkingRun {
  const passes = readdirSync(selection.dir).filter(
    (name) => name.startsWith("pass-") && statSync(join(selection.dir, name)).isDirectory(),
  )
  const [passName] = passes
  if (passes.length !== 1 || passName === undefined) {
    throw new Error(`${selection.dir}: expected one retained pass; found ${passes.length}`)
  }
  const path = join(selection.dir, passName, "pass.json")
  const pass = parseJsonStrict(path, readFileSync(path, "utf8"))
  if (!record(pass) || !Array.isArray(pass.contexts)) throw new Error(`${path}: missing retained contexts`)
  const rows = pass.contexts.filter(
    (row) =>
      record(row) &&
      record(row.context) &&
      row.context.id === context.terminalId &&
      row.context.kind === context.kind &&
      row.context.os === context.os,
  )
  const row = rows[0]
  if (rows.length !== 1 || !record(row) || row.status !== "classified" || typeof row.rawRun !== "string") {
    throw new Error(`${path}: ${context.context} has no single classified raw capture`)
  }
  const rawPath = resolve(dirname(path), row.rawRun)
  if (!realpathSync(rawPath).startsWith(realpathSync(selection.dir) + sep)) {
    throw new Error(`${path}: raw capture outside its retained collection`)
  }
  const options = { root: REPO_ROOT, catalogIds }
  let run: LoadedRun
  try {
    run = loadRawCapture(rawPath, options)
  } catch (error) {
    if (!(error instanceof UntrustedSuiteError)) throw error
    // Only an exact named manifest in the configured producer's library store supplies custody.
    const manifestPath = readdirSync(librariesDir)
      .filter((name) => RUN_DIR.test(name))
      .sort()
      .reverse()
      .map((name) => join(librariesDir, name, "headless", "suites", `${error.suiteId}.json`))
      .find((candidate) => existsSync(candidate))
    if (!manifestPath) {
      return {
        ...selection,
        runs: [],
        unmeasured: [],
        unreadable: {
          suiteId: error.suiteId,
          treeSuiteId: error.treeSuiteId,
          reason: `${error.message}; no exact retained library manifest at ${librariesDir}/<run>/headless/suites/${error.suiteId}.json`,
          banner: `Retained app collection ${context.context}/${selection.id} is unavailable: suite ${error.suiteId} has no trusted manifest.`,
        },
      }
    }
    const libraryRun = dirname(dirname(dirname(manifestPath)))
    if (!realpathSync(manifestPath).startsWith(realpathSync(libraryRun) + sep)) {
      throw new Error(`${manifestPath}: suite manifest outside its retained library run`)
    }
    run = loadRawCapture(rawPath, { ...options, manifestPath })
  }
  if (run.subject.id !== context.terminalId || run.subject.kind !== context.kind || run.subject.os !== context.os) {
    throw new Error(`${rawPath}: captured subject disagrees with ${context.context}`)
  }
  const unapplied = unappliedSupplements(row.supplements)
  return { ...selection, runs: [run], unmeasured: [], ...(unapplied !== undefined && { unapplied }) }
}

/** One line naming the pass row's supplements, which this preview reads no answer from. */
function unappliedSupplements(supplements: unknown): string | undefined {
  if (supplements === undefined) return undefined
  if (!Array.isArray(supplements)) throw new Error("pass row supplements must be a list")
  const named = supplements.map((entry) => {
    if (!record(entry) || typeof entry.name !== "string" || !Array.isArray(entry.featureIds)) {
      throw new Error("pass row supplement must carry its name and featureIds")
    }
    return `${entry.name} (${entry.featureIds.join(", ")})`
  })
  if (named.length === 0) return undefined
  return `Not applied in this preview: the ${named.join("; ")} supplement run of this pass. Its answers reach a cell only once it is placed beside the default run.`
}

/** Private page history uses the same raw reader and view; public API generation remains newest-only. */
export function siteWorkingHistory(contentDir: string, env: NodeJS.ProcessEnv = process.env): WorkingView[] | null {
  const newest = selectedSiteWorkingRun(env)
  if (newest === null) return null
  const dir = dirname(newest.dir)
  const cache = (host[HISTORY_CACHE] ??= new Map())
  const known = cache.get(newest.dir) as WorkingView[] | undefined
  if (known) return known
  const selections: Array<{ selection: WorkingRunSelection; context?: CensusContext }> = [
    ...completeRunSelections(dir, newest.id),
  ]
    .reverse()
    .map((selection) => ({ selection }))
  const gaps: LoadedWorkingRun["unmeasured"] = []
  for (const context of fullContextCensus(contentDir).contexts.filter((context) => context.kind !== "lib")) {
    const appDir = join(dirname(dir), "apps", context.terminalId, context.os, "runs")
    if (!existsSync(appDir)) {
      gaps.push({
        engine: context.context,
        status: "unmeasured",
        reason: `No retained app store at ${appDir}; a missing store is not a measured result.`,
      })
      continue
    }
    try {
      selections.push(...[...completeRunSelections(appDir)].reverse().map((selection) => ({ selection, context })))
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes(appDir)) throw error
      gaps.push({ engine: context.context, status: "unavailable", reason: `${appDir}: ${error.message}` })
    }
  }
  const { projection } = loadCurrentResults(contentDir)
  const reviewed = compatibilitySubjects(projection, contentDir)
  const earlier = new Map<string, WorkingView>()
  const runtimeReceipts = new Map<string, Map<string, string | undefined>>()
  // Keep the small page views across loaders, not every historical capture's full evidence payload.
  const views = selections.map(({ selection, context: app }): WorkingView => {
    try {
      const loaded = app
        ? loadAppWorkingRun(selection, app, dir, Object.keys(loadFeatures(contentDir)))
        : loadedSiteWorkingRun(selection, selection.id === newest.id)
      const view = composeWorkingView(projection, reviewed, loaded)
      if (app) view.run.id = `apps/${app.context}/${selection.id}`
      else if (selection.id === newest.id) view.unmeasured = [...view.unmeasured, ...gaps]
      const fingerprints = new Map<string, string | undefined>()
      for (const context of view.contexts) {
        context.states = Object.fromEntries(context.cells.map((cell) => [cell.featureId, cell.raw.status]))
        context.cells = []
        const original = loaded.runs.find((run) => run.subject.id === context.engine)
        context.sha256 = original?.sha256
        context.identity = original?.identity
        if (app) {
          context.changeQualification =
            "Recorded runtime identity differs or is missing; moves are not comparable. Required app/mux pairs remain UNMEASURED."
          continue
        }
        fingerprints.set(context.contextKey, JSON.stringify(original?.runtimeIdentity))
        const receipt = loaded.changeRecord
        if (!record(receipt) || typeof receipt.since !== "string" || !Array.isArray(receipt.moves)) {
          context.changeQualification = "No usable comparison receipt was recorded for this collection."
          continue
        }
        const baseline = basename(receipt.since)
        context.changeBaseline = baseline
        const prior = earlier.get(baseline)?.contexts.find((candidate) => candidate.contextKey === context.contextKey)
        const priorRuntime = runtimeReceipts.get(baseline)?.get(context.contextKey)
        if (!prior) {
          context.changeQualification = "The recorded baseline context is unavailable in this history reading."
          continue
        }
        if (prior.suiteId !== context.suiteId || prior.version !== context.version) {
          context.changeQualification = "Different suite or engine version; recorded moves are not comparable."
          continue
        }
        if (priorRuntime === undefined || priorRuntime !== fingerprints.get(context.contextKey)) {
          context.changeQualification = "Recorded runtime identity differs or is missing; moves are not comparable."
          continue
        }
        const moves = receipt.moves
        if (
          !moves.every(
            (move): move is Record<"engine" | "feature" | "from" | "to" | "comparison", string> =>
              record(move) &&
              ["engine", "feature", "from", "to", "comparison"].every((key) => typeof move[key] === "string"),
          )
        ) {
          context.changeQualification = "The retained change receipt is malformed; comparison is unavailable."
          continue
        }
        const ownMoves = moves.filter((move) => move.engine === context.engine)
        if (
          ownMoves.some(
            (move) =>
              prior.states?.[move.feature] !== storedProbeStatus(move.from) ||
              context.states?.[move.feature] !== storedProbeStatus(move.to),
          )
        ) {
          context.changeQualification =
            "The recorded change does not match the decoded captures; comparison is unavailable."
          continue
        }
        context.changeQualification = `Same recorded context, suite, engine version and runtime identity; baseline capture ${prior.runId}, source ${prior.sourceRevision}. A recorded identity match is not runtime verification.`
        context.changes = Object.fromEntries(
          ownMoves.map((move) => [move.feature, `${move.from} → ${move.to} (${move.comparison})`]),
        )
      }
      earlier.set(selection.id, view)
      runtimeReceipts.set(selection.id, fingerprints)
      if (view.unreadable) {
        view.unreadable = {
          ...view.unreadable,
          reason: view.unreadable.reason.replaceAll(dir, "retained runs").replaceAll(REPO_ROOT, "source tree"),
        }
      }
      return view
    } catch (error) {
      // A reader diagnostic naming this older collection is an input gap, not zero results.
      // Newest-run failures and errors outside that input still propagate unchanged.
      if ((!app && selection.id === newest.id) || !(error instanceof Error)) throw error
      const missingInput =
        "code" in error &&
        error.code === "ENOENT" &&
        "path" in error &&
        typeof error.path === "string" &&
        error.path.startsWith(selection.dir + sep)
      if (
        !missingInput &&
        !error.message.startsWith(selection.dir + sep) &&
        !(app && (error.message.startsWith(selection.dir + ":") || error.message.startsWith(dir + sep)))
      ) {
        throw error
      }
      const reason = error.message.replaceAll(selection.dir, selection.id)
      const banner = `Retained collection ${app ? app.context + "/" : ""}${selection.id} has unreadable input; results and counts are unavailable.`
      console.warn(`terminfo-site: WARNING ${banner} (${reason})`)
      return {
        label: RAW_LABEL,
        rule: "Missing retained inputs are not zero results and do not change accepted answers.",
        run: {
          id: app ? `apps/${app.context}/${selection.id}` : selection.id,
          startedAt: selection.startedAt,
          newestCaptureAt: "not read",
          suites: [],
        },
        contexts: [],
        unmeasured: [],
        unreadable: { banner, reason },
      }
    }
  })
  views.sort(
    (left, right) => left.run.startedAt.localeCompare(right.run.startedAt) || left.run.id.localeCompare(right.run.id),
  )
  cache.set(newest.dir, views)
  return views
}
