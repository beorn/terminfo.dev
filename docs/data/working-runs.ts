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
 * - Raw never enters any score, count, completeness tier or rollup: this view is built AFTER the accepted projection
 *   and only reads it. No working run is ever passed into `loadCurrentResults`, whose composed contexts would fold
 *   raw cells into accepted context cells and their counts.
 * - A pending source review (criterionBranch `source-negative-review` still at TEST TODO or TEST FAILURE) reads
 *   "pending review", not failure; a reviewed answer on that branch (e.g. sealed unsupported) reads as its status.
 * - "Differs from reviewed" needs the same suite AND the same engine version, and never marks a pending raw cell.
 */
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs"
import { join, resolve, sep } from "node:path"
import { loadFeatures } from "@terminfo/catalog"
import { SOURCE_NEGATIVE_REVIEW, type ProbeStatus } from "@terminfo/probe-defs"
import { parseJsonStrict, type LoadedRun } from "@terminfo/run-parser"
import { loadRawCapture, UntrustedSuiteError } from "../../packages/admin/raw-capture.ts"
import { compatibilitySubjects, loadCurrentResults, type CurrentResult } from "./current-results.ts"
import { admittedContextKeys, originalRunFor, workingSubjectKey, type SelectedProjection } from "./selected-results.ts"

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
  /** Contexts the run's pass names without a captured run, with the pass's own status and reason. */
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
      skipped.push(`${name} (complete summary without cells.json)`)
      continue
    }
    const [, day, hh, mm, ss, ms] = RUN_DIR.exec(name) ?? []
    return { id: name, dir, startedAt: `${day}T${hh}:${mm}:${ss}.${ms}Z` }
  }
  throw new Error(
    `no complete hourly run in ${runsDir}${skipped.length ? `; skipped ${skipped.join(", ")}` : "; no run directories"}`,
  )
}

/** Load every raw capture the selected run's pass cites, through the one raw-capture reader. */
export function loadWorkingRun(
  selection: WorkingRunSelection,
  options: { root: string; catalogIds: readonly string[] },
): LoadedWorkingRun {
  const passes = readdirSync(selection.dir).filter((name) => name.startsWith("pass-"))
  const [passName] = passes
  if (passes.length !== 1 || !passName) {
    throw new Error(`${selection.dir}: expected exactly one pass-* directory, found ${passes.length}`)
  }
  const passPath = join(selection.dir, passName, "pass.json")
  const pass = parseJsonStrict(passPath, readFileSync(passPath, "utf8"))
  if (!record(pass) || !Array.isArray(pass.contexts)) throw new Error(`${passPath}: pass requires a contexts array`)
  const runRoot = realpathSync(selection.dir) + sep
  const runs: LoadedRun[] = []
  const unmeasured: LoadedWorkingRun["unmeasured"] = []
  for (const value of pass.contexts) {
    if (!record(value) || !record(value.context) || typeof value.context.id !== "string") {
      throw new Error(`${passPath}: a pass context requires its context identity`)
    }
    const engine = value.context.id
    if (typeof value.rawRun !== "string") {
      unmeasured.push({
        engine,
        status: String(value.status ?? "not recorded"),
        reason: String(value.error ?? value.reason ?? "no captured run recorded"),
      })
      continue
    }
    const rawPath = resolve(selection.dir, value.rawRun)
    if (!existsSync(rawPath) || !realpathSync(rawPath).startsWith(runRoot)) {
      throw new Error(`${passPath}: ${engine} cites raw capture ${value.rawRun} outside the run directory or absent`)
    }
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
    if (run.subject.id !== engine) {
      throw new Error(`${rawPath}: pass names ${engine}, capture records ${run.subject.id}`)
    }
    runs.push(run)
  }
  if (runs.length === 0) throw new Error(`${passPath}: the run cites no raw capture`)
  return { ...selection, runs, unmeasured }
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
  raw: RawSide & { label: typeof RAW_LABEL; display: string; pendingReview: boolean; differsFromReviewed: boolean }
}

/**
 * The one "pending review" rule: a source-negative-review row still open (TEST TODO or TEST FAILURE). A REVIEWED
 * answer keeps that branch with its decided status (run-parser seals e.g. unsupported through it), so the branch
 * alone never means pending.
 */
export function pendingReview(side: { status: ProbeStatus; criterionBranch?: string }): boolean {
  return (
    side.criterionBranch === SOURCE_NEGATIVE_REVIEW && (side.status === "test-todo" || side.status === "test-failure")
  )
}
const display = (side: { status: ProbeStatus; criterionBranch?: string }): string =>
  pendingReview(side) ? "pending review" : side.status

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
      pendingReview: pendingReview(raw),
      differsFromReviewed:
        relation === "same-suite" &&
        reviewed?.version === raw.version &&
        !pendingReview(raw) &&
        reviewed.status !== raw.status,
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
    }
  })
  contexts.sort((a, b) => a.engine.localeCompare(b.engine) || a.contextKey.localeCompare(b.contextKey))
  return {
    label: RAW_LABEL,
    rule:
      "Raw, unreviewed hourly results sit beside the reviewed answer and never replace it. They enter no score, " +
      "count, completeness tier or rollup.",
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
