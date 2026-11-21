/**
 * Placement's two refusals (#37245, @cto 39b625fe, ff0c53b4, a256c184):
 *
 * 1. A run may not turn a cell the site serves as decided into an undecided one unless the placer accepts that exact
 *    count with a reason. "Served" is the site's own projection (loadCurrentResults + compatibilitySubjects), read
 *    once over the corpus and once with the candidate as a working run, so the check follows the projection's
 *    selection rules and never re-derives them.
 * 2. Placement stages exactly the paths it wrote, then every artifact the run cites must be in the git index.
 *    Present on disk is not committed: an untracked file passes an existence check, which is how a placement shipped
 *    without 933 of its artifacts (be7b2bb73) and then 208 more (983f0c94f).
 *
 * This module sits beside corpus-placement.ts, not inside it: the projection imports corpus-placement.ts.
 */
import { spawnSync } from "node:child_process"
import { writeFileSync } from "node:fs"
import { isAbsolute, join, relative, resolve } from "node:path"
import type { ProbeSuiteManifest } from "@terminfo/probe-defs"
import type { LoadedRun } from "@terminfo/run-parser"
import { DECIDED_STATUSES } from "../../docs/data/app-cells.ts"
import { compatibilitySubjects, loadCurrentResults } from "../../docs/data/current-results.ts"
import {
  CONTENT_DIR,
  citedArtifacts,
  prepareCollectedRun,
  writePreparedRun,
  type PreparedRun,
  type WrittenRun,
} from "./corpus-placement.ts"

/** How many cells or paths a refusal names before it gives the count of the rest. */
const LIST_LIMIT = 20

export interface CellChange {
  featureId: string
  was: string
  now: string
}

/** What placing a run would change in the cells the site serves for its subject. */
export interface DowngradeReport {
  /** The run's (kind, id, OS). */
  subject: string
  /** The context the projection serves for the subject without the run, and with it; null when none is served. */
  before: string | null
  after: string | null
  /** Decided before, undecided (or no longer served) after: refused unless accepted at this exact count. */
  downgrades: CellChange[]
  /** Decided before, a different decided status after: listed, never refused. */
  flips: CellChange[]
}

export interface AcceptDowngrades {
  count: number
  reason: string
}

/** The definition every refusal states, so a reader can derive the count it prints. */
export const DOWNGRADE_DEFINITION =
  `a downgrade is a cell the site's projection serves as decided (${[...DECIDED_STATUSES].join(", ")}) ` +
  "without this run and as undecided with it"

function served(
  results: ReturnType<typeof loadCurrentResults>,
  contentDir: string,
  run: LoadedRun,
): { key: string; cells: Map<string, string> } | null {
  const os = run.subject.os ?? null
  for (const entry of compatibilitySubjects(results.projection, contentDir).values()) {
    const subject = entry.selected.subject
    if (!subject || subject.kind !== run.subject.kind || subject.id !== run.subject.id) continue
    if ((subject.os ?? null) !== os) continue
    const cells = new Map<string, string>()
    for (const [featureId, cell] of Object.entries(entry.selected.cells)) {
      cells.set(featureId, cell.featureResult?.status ?? cell.result.status)
    }
    return { key: entry.contextKey, cells }
  }
  return null
}

/** The served cells of the run's subject, before and after placing it, compared cell by cell. */
export function placementDowngrades(run: LoadedRun, contentDir: string = CONTENT_DIR): DowngradeReport {
  // An explicit empty working set is never served from loadCurrentResults' per-process cache: a process that places
  // more than one run (terminfo-remeasure's default, then its supplements; #37256) reads the corpus as the previous
  // placement left it, not as the first read found it.
  const before = served(loadCurrentResults(contentDir, { workingRuns: [] }), contentDir, run)
  const after = served(loadCurrentResults(contentDir, { workingRuns: [run] }), contentDir, run)
  const downgrades: CellChange[] = []
  const flips: CellChange[] = []
  for (const [featureId, was] of before?.cells ?? []) {
    if (!DECIDED_STATUSES.has(was)) continue
    const now = after?.cells.get(featureId) ?? "missing"
    if (!DECIDED_STATUSES.has(now)) downgrades.push({ featureId, was, now })
    else if (now !== was) flips.push({ featureId, was, now })
  }
  return {
    subject: `${run.subject.kind}:${run.subject.id}@${run.subject.os ?? "unknown"}`,
    before: before?.key ?? null,
    after: after?.key ?? null,
    downgrades,
    flips,
  }
}

function listed(cells: readonly CellChange[]): string {
  const shown = cells.slice(0, LIST_LIMIT).map(({ featureId, was, now }) => `${featureId} ${was} -> ${now}`)
  const rest = cells.length - shown.length
  return shown.join("; ") + (rest > 0 ? `; and ${rest} more` : "")
}

/** Refuse unless the downgrades are none, or accepted at exactly their count and with a reason. */
export function checkDowngrades(source: string, report: DowngradeReport, accept?: AcceptDowngrades): void {
  const count = report.downgrades.length
  const named = count === 0 ? "" : `: ${listed(report.downgrades)}`
  if (accept === undefined) {
    if (count === 0) return
    throw new Error(
      `${source}: placing it would turn ${count} decided cell(s) of ${report.subject} undecided (${DOWNGRADE_DEFINITION})${named}. ` +
        `To place it anyway: terminfo place ${source} --accept-downgrades ${count} --reason "<why>"`,
    )
  }
  if (accept.reason.trim() === "") {
    throw new Error(`${source}: --accept-downgrades ${accept.count} needs --reason "<why>"`)
  }
  if (accept.count !== count) {
    throw new Error(
      `${source}: --accept-downgrades ${accept.count} does not match the ${count} downgrade(s) this run makes ` +
        `(${DOWNGRADE_DEFINITION})${named}`,
    )
  }
}

export interface CheckedPlacement {
  prepared: PreparedRun
  written: WrittenRun
  report: DowngradeReport
  accepted: AcceptDowngrades | null
}

/** Every factual check, then the downgrade check, then the write. A refusal writes nothing. */
export function placeCheckedRun(
  source: string,
  trustedSuite: ProbeSuiteManifest,
  contentDir: string = CONTENT_DIR,
  accept?: AcceptDowngrades,
): CheckedPlacement {
  const prepared = prepareCollectedRun(source, trustedSuite, contentDir)
  const report = placementDowngrades(prepared.loaded, contentDir)
  checkDowngrades(source, report, accept)
  return { prepared, written: writePreparedRun(prepared), report, accepted: accept ?? null }
}

function git(repoRoot: string, args: readonly string[], env?: NodeJS.ProcessEnv) {
  const result = spawnSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    ...(env && { env: { ...process.env, ...env } }),
  })
  if (result.error) throw new Error(`git ${args[0]} in ${repoRoot} failed to start`, { cause: result.error })
  if (result.status !== 0) {
    const outcome = result.signal === null ? `exited ${result.status}` : `was killed by ${result.signal}`
    throw new Error(`git ${args[0]} in ${repoRoot} ${outcome}: ${result.stderr.trim()}`)
  }
  return result.stdout
}

function repoRelative(repoRoot: string, path: string): string {
  const rel = relative(repoRoot, resolve(path))
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`Placement wrote ${path}, outside the repository at ${repoRoot}`)
  }
  return rel
}

/**
 * The cited artifacts of `run` that the index `repoRoot` reads (or the one `indexFile` names) does not hold, as
 * repository paths. An index, never the filesystem: a file on disk but untracked is exactly what this exists to catch.
 */
export function citedArtifactsMissingFromIndex(
  repoRoot: string,
  contentDir: string,
  run: Pick<LoadedRun, "screenshotRefs" | "textSnapshotRefs">,
  indexFile?: string,
): { cited: number; missing: string[] } {
  const paths = [
    ...new Set(citedArtifacts(run).map(({ name }) => repoRelative(repoRoot, join(contentDir, "artifacts", name)))),
  ]
  if (paths.length === 0) return { cited: 0, missing: [] }
  const env = indexFile === undefined ? undefined : { GIT_INDEX_FILE: resolve(indexFile) }
  // One read of every tracked path under artifacts/, then a set difference: one process, whatever the count.
  const artifactsDir = repoRelative(repoRoot, join(contentDir, "artifacts"))
  const tracked = new Set(git(repoRoot, ["ls-files", "-z", "--cached", "--", artifactsDir], env).split("\0"))
  return { cited: paths.length, missing: paths.filter((path) => !tracked.has(path)) }
}

/** Refuse, naming the first paths and the count, when any cited artifact is not in the index. */
export function checkCitedInIndex(
  repoRoot: string,
  contentDir: string,
  run: Pick<LoadedRun, "screenshotRefs" | "textSnapshotRefs">,
  staged: readonly string[] = [],
  indexFile?: string,
): void {
  const { cited, missing } = citedArtifactsMissingFromIndex(repoRoot, contentDir, run, indexFile)
  if (missing.length === 0) return
  const shown = missing.slice(0, LIST_LIMIT).join(", ")
  const rest = missing.length > LIST_LIMIT ? ` and ${missing.length - LIST_LIMIT} more` : ""
  const unstage =
    staged.length === 0
      ? ""
      : ` This placement wrote and staged ${staged.length} path(s); to unstage them (the files stay): ` +
        `git -C ${repoRoot} reset -q -- ${staged.join(" ")}`
  throw new Error(
    `${missing.length} of the ${cited} artifact(s) this run cites are not in the git index: ${shown}${rest}.${unstage}`,
  )
}

/** The commit message placement writes; the record of an accepted downgrade lives in git, not beside the run. */
export function placementCommitMessage(placement: Pick<CheckedPlacement, "prepared" | "report" | "accepted">): string {
  const { subject, runId } = placement.prepared.loaded
  const lines = [
    `data(terminfo): place ${subject.id} ${subject.version} ${subject.os ?? "unknown"} run ${runId}`,
    "",
    `Placed by terminfo place. ${placement.report.downgrades.length} downgrade(s), ${placement.report.flips.length} ` +
      `changed decided value(s); ${DOWNGRADE_DEFINITION}.`,
  ]
  if (placement.report.downgrades.length > 0) {
    lines.push(
      "",
      "Downgraded cells:",
      ...placement.report.downgrades.map((c) => `- ${c.featureId}: ${c.was} -> ${c.now}`),
    )
  }
  if (placement.report.flips.length > 0) {
    lines.push("", "Changed decided values (listed, not refused):")
    lines.push(...placement.report.flips.map((c) => `- ${c.featureId}: ${c.was} -> ${c.now}`))
  }
  if (placement.accepted !== null && placement.report.downgrades.length > 0) {
    lines.push(
      "",
      `Accepted-Downgrades: ${placement.accepted.count}`,
      `Downgrade-Reason: ${placement.accepted.reason.replace(/\s+/g, " ").trim()}`,
    )
  }
  return lines.join("\n") + "\n"
}

/**
 * Stage exactly what the placement wrote (explicit paths, never -A or a directory), refuse when any cited artifact is
 * still outside the index, then write the commit message and return the one command that commits it. That command
 * takes no pathspec: a pathspec commit would leave the staged artifacts out, which is the trap this closes.
 */
export function stagePlacement(
  repoRoot: string,
  placement: CheckedPlacement,
): { messageFile: string; command: string } {
  const staged = placement.written.paths.map((path) => repoRelative(repoRoot, path))
  git(repoRoot, ["add", "--", ...staged])
  checkCitedInIndex(repoRoot, placement.prepared.contentDir, placement.prepared.loaded, staged)
  const messageFile = resolve(repoRoot, git(repoRoot, ["rev-parse", "--git-path", "terminfo-place-message"]).trim())
  writeFileSync(messageFile, placementCommitMessage(placement))
  return { messageFile, command: `git -C ${repoRoot} commit -F ${messageFile}` }
}
