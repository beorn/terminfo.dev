#!/usr/bin/env bun
/**
 * The terminfo.dev preview's landed serve: build the site when the served output is not the landing's own
 * revision, then serve that output read-only over the tailnet.
 *
 * This is the `terminfo-site` resident's command (28268 AC4). It used to be an inline `bun -e` server declared in
 * `hh.hab.tsx` over a dist built by hand inside a seat worktree, so the served corpus went stale on every
 * `vendor/terminfo.dev` advance until somebody ran `bun run build` in that worktree. Here the serve and the build
 * that feeds it are one program in the repository the corpus comes from.
 *
 * Build-if-needed: the build is skipped only when the output's own `/build.json` names the revision this checkout
 * is at. Any other state — absent, stale, unreadable — rebuilds. A build that fails exits non-zero and the process
 * never serves the previous dist: serving a corpus older than the code that produced it IS the defect this
 * program exists to remove, so there is no fallback path. Downtime is the ~60 s build; for an internal preview
 * that is accepted, and the readiness ceiling in the declaration covers it.
 *
 * `TERMINFO_SITE_OUT_DIR` roots every build write (see `./site-out.ts`), so this can run from a read-only landing.
 * While a rebuild runs it writes `rebuild.json` into that root, naming the revision being built TO; the health probe
 * reads it to answer `starting` (28268 AC4), so a mid-rebuild preview waits for readiness instead of reading stale.
 *
 * Hourly runs (@cto scope GO 2026-11-02): with `TERMINFO_SITE_WORKING_RUNS_DIR` set, the same rebuild check also
 * compares the newest COMPLETE hourly re-measure run (`docs/data/working-runs.ts`) with the run the served stamp
 * names, and a new one triggers ONE rebuild. That rebuild is not a code change: the served corpus stays the code's own,
 * so it builds into `<out>/staging` while the previous build keeps serving, and swaps in only on success. A failed run
 * rebuild keeps serving the previous build, says so on stderr, leaves the rebuild marker behind (as a failed code
 * rebuild does), and is not retried for the same run. The check runs at start and on changes under the runs directory
 * (an inotify watch inside this process; no new timer, service or gate).
 */
import { execFileSync, spawn, spawnSync } from "node:child_process"
import { existsSync, readFileSync, renameSync, rmSync, statSync, watch } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { siteDistDir, siteOutRoot, writeSiteRebuildMarker } from "./site-out.ts"
import { newestCompleteRun, siteWorkingRunsDir } from "../docs/data/working-runs.ts"

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const distDir = siteDistDir(repoRoot)
const hostname = process.env["TERMINFO_SITE_HOST"] ?? "100.87.90.48"
const port = Number(process.env["TERMINFO_SITE_PORT"] ?? "4173")

/** The revision this checkout is at — for a landing, the gitlink of vendor/terminfo.dev. */
function landingRevision(): string {
  return execFileSync("git", ["-C", repoRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim()
}

/** What a dist's own `/build.json` says it was built from: its code revision and the hourly run it shows. */
export interface ServedStamp {
  sourceCommit: string | null
  workingRunId: string | null
}

/** The stamp of the output in `dir`, with nulls when there is no readable stamp. */
export function readServedStamp(dir: string): ServedStamp {
  const stamp = join(dir, "build.json")
  if (!existsSync(stamp)) return { sourceCommit: null, workingRunId: null }
  try {
    const parsed: unknown = JSON.parse(readFileSync(stamp, "utf8"))
    if (parsed === null || typeof parsed !== "object") return { sourceCommit: null, workingRunId: null }
    const source = (parsed as { sourceCommit?: unknown }).sourceCommit
    const run = (parsed as { workingRun?: { id?: unknown } }).workingRun?.id
    return {
      sourceCommit: typeof source === "string" ? source : null,
      workingRunId: typeof run === "string" ? run : null,
    }
  } catch (error) {
    // An unreadable or malformed stamp is not the same as an absent one: absent means "no build yet", but a stamp
    // that exists and cannot be parsed is a surprise worth a line, so the rebuild it triggers is attributable rather
    // than silent (NO SILENT ERRORS). The caller rebuilds either way, and the build verifies its own stamp after.
    console.warn(
      `terminfo-site: unreadable build stamp at ${stamp} (${
        error instanceof Error ? error.message : String(error)
      }); rebuilding`,
    )
    return { sourceCommit: null, workingRunId: null }
  }
}

/** The revision the served output was built from, or null when there is no readable stamp. */
function servedRevision(): string | null {
  return readServedStamp(distDir).sourceCommit
}

/**
 * The one rebuild check: `code` when the served output is not this landing's revision (rebuild in place, no fallback),
 * `run` when the code matches but a newer complete hourly run exists than the one the output shows, else null.
 */
export function rebuildReason(target: string, stamp: ServedStamp, newestRunId: string | null): "code" | "run" | null {
  if (stamp.sourceCommit !== target) return "code"
  if (newestRunId !== null && stamp.workingRunId !== newestRunId) return "run"
  return null
}

type RunBuild = (env: NodeJS.ProcessEnv) => Promise<number | null>

/** The real site build, run asynchronously so the previous build keeps serving while it runs. */
const siteBuild: RunBuild = (env) =>
  new Promise((resolve) => {
    const child = spawn("bun", ["run", "build"], { cwd: repoRoot, stdio: "inherit", env })
    child.on("error", (error) => {
      console.error(`terminfo-site: cannot run the site build: ${error.message}`)
      resolve(null)
    })
    child.on("exit", (code) => resolve(code))
  })

/**
 * Rebuild for a new hourly run into `<outRoot>/staging` and swap the staged dist in only on success. On failure the
 * served dist is untouched, the failure is printed on stderr, and the rebuild marker stays behind; returns false.
 */
export async function rebuildForRun(args: {
  outRoot: string
  target: string
  runId: string
  runBuild?: RunBuild
}): Promise<boolean> {
  const served = join(args.outRoot, "dist")
  const staging = join(args.outRoot, "staging")
  const stagedDist = join(staging, "dist")
  const previous = readServedStamp(served).workingRunId ?? "none"
  const fail = (cause: string): false => {
    console.error(
      `terminfo-site: rebuild for hourly run ${args.runId} failed (${cause}); still serving the previous build ` +
        `(hourly run ${previous}) from ${served}; marker ${join(args.outRoot, "rebuild.json")} left in place`,
    )
    return false
  }
  console.log(
    `terminfo-site: hourly run ${args.runId} is newer than the served ${previous} — rebuilding into ${staging}`,
  )
  const clearMarker = writeSiteRebuildMarker(args.target, { TERMINFO_SITE_OUT_DIR: args.outRoot })
  // raw-delete-allow: standalone component repository without hh's removely; the staged dist is this program's own scratch output under its state root
  rmSync(stagedDist, { recursive: true, force: true })
  const status = await (args.runBuild ?? siteBuild)({
    ...process.env,
    TERMINFO_SITE_OUT_DIR: staging,
    TERMINFO_SITE_CODE_GITLINK: args.target,
  })
  if (status !== 0) return fail(`site build exit ${String(status)}`)
  const staged = readServedStamp(stagedDist)
  if (staged.sourceCommit !== args.target || staged.workingRunId === null) {
    return fail(`staged build stamped ${staged.sourceCommit ?? "nothing"} / run ${staged.workingRunId ?? "none"}`)
  }
  const retired = join(args.outRoot, "dist.previous")
  // raw-delete-allow: standalone component repository without hh's removely; dist.previous is this program's own retired output
  rmSync(retired, { recursive: true, force: true })
  if (existsSync(served)) renameSync(served, retired)
  renameSync(stagedDist, served)
  // raw-delete-allow: standalone component repository without hh's removely; dist.previous is this program's own retired output
  rmSync(retired, { recursive: true, force: true })
  clearMarker?.()
  console.log(`terminfo-site: now serving hourly run ${staged.workingRunId} (${args.target.slice(0, 10)})`)
  return true
}

/**
 * The hourly half of the rebuild check, for a process that is already serving: one rebuild per new complete run,
 * never two at once, and never a retry of a run whose rebuild failed (a later run, or a restart, tries again).
 */
export function createRunRebuilder(args: { runsDir: string; outRoot: string; target: string; runBuild?: RunBuild }): {
  check(): Promise<void>
} {
  const attempted = new Set<string>()
  let running: Promise<void> | null = null
  let again = false
  const once = async (): Promise<void> => {
    let newest: string
    try {
      newest = newestCompleteRun(args.runsDir).id
    } catch (error) {
      console.error(
        `terminfo-site: cannot read hourly runs (${error instanceof Error ? error.message : String(error)}); ` +
          "still serving the previous build",
      )
      return
    }
    const stamp = readServedStamp(join(args.outRoot, "dist"))
    if (rebuildReason(args.target, stamp, newest) !== "run" || attempted.has(newest)) return
    attempted.add(newest)
    await rebuildForRun({ outRoot: args.outRoot, target: args.target, runId: newest, runBuild: args.runBuild })
  }
  const check = async (): Promise<void> => {
    if (running) {
      again = true
      return running
    }
    running = (async () => {
      do {
        again = false
        await once()
      } while (again)
    })()
    try {
      await running
    } finally {
      running = null
    }
  }
  return { check }
}

function build(target: string): void {
  console.log(`terminfo-site: served output is ${servedRevision() ?? "absent"}, landing is ${target} — rebuilding`)
  // The marker the health probe reads while this rebuild runs (28268 AC4); see `writeSiteRebuildMarker` for why it
  // is cleared only on success.
  const clearMarker = writeSiteRebuildMarker(target)
  // The build records the CODE gitlink it was made from into the dist's stamp, so the health probe can read which
  // CODE pin the served corpus belongs to straight from /build.json with no walk of the CODE root (28620). This
  // checkout's HEAD is that pin, and `target` is it; the build has no other way to know a landing is the caller.
  const result = spawnSync("bun", ["run", "build"], {
    cwd: repoRoot,
    stdio: "inherit",
    env: { ...process.env, TERMINFO_SITE_CODE_GITLINK: target },
  })
  if (result.error) {
    console.error(`terminfo-site: cannot run the site build: ${result.error.message}`)
    process.exit(1)
  }
  if (result.status !== 0) {
    console.error(`terminfo-site: site build failed (exit ${result.status}); refusing to serve the previous output`)
    process.exit(1)
  }
  const built = servedRevision()
  if (built !== target) {
    console.error(`terminfo-site: build stamped ${built ?? "nothing"}, expected ${target}; refusing to serve`)
    process.exit(1)
  }
  clearMarker?.()
}

/**
 * Resolve one request path inside the dist the way Cloudflare Pages does for this site's clean URLs: an exact file
 * wins, then `<path>.html`, then `<path>/index.html`. `<path>.html` deliberately outranks a same-named directory,
 * because VitePress builds `cleanUrls: true` pages that sit beside a directory of the same name (`cursor.html` plus
 * `cursor/`), and a directory must never shadow its own page. Returns null for a miss, a malformed escape, or a path
 * that escapes the dist; the caller answers 404, never 500 (30757).
 */
export function resolveServedPath(distDir: string, requestPath: string): string | null {
  let decoded: string
  try {
    decoded = decodeURIComponent(requestPath)
  } catch {
    // silent-fallback-allow: malformed URI percent-encoding in an HTTP request path is a client 404 miss, not a server error (30757)
    return null
  }
  const relative = decoded.endsWith("/") ? `${decoded}index.html` : decoded
  const candidate = resolve(distDir, `.${relative}`)
  if (!candidate.startsWith(distDir + "/")) return null
  if (isFile(candidate)) return candidate
  const withHtml = `${candidate}.html`
  if (!decoded.endsWith(".html") && isFile(withHtml)) return withHtml
  if (isDirectory(candidate)) {
    const index = join(candidate, "index.html")
    if (isFile(index)) return index
  }
  return null
}

function isFile(path: string): boolean {
  const stat = statSync(path, { throwIfNoEntry: false })
  return stat !== undefined && stat.isFile()
}

function isDirectory(path: string): boolean {
  const stat = statSync(path, { throwIfNoEntry: false })
  return stat !== undefined && stat.isDirectory()
}

/** The read-only GET/HEAD handler over one dist directory; exported so the tests drive the real routing. */
export function createPreviewHandler(distDir: string): (request: Request) => Response {
  const notFound = join(distDir, "404.html")
  return (request) => {
    if (request.method !== "GET" && request.method !== "HEAD") return new Response("read-only", { status: 405 })
    const resolved = resolveServedPath(distDir, new URL(request.url).pathname)
    return resolved === null
      ? new Response(Bun.file(notFound), { status: 404 })
      : new Response(Bun.file(resolved), { status: 200 })
  }
}

function serveLanded(): void {
  const target = landingRevision()
  const runsDir = siteWorkingRunsDir()
  const outRoot = siteOutRoot()
  if (runsDir !== undefined && outRoot === undefined) {
    throw new Error(
      "TERMINFO_SITE_WORKING_RUNS_DIR needs TERMINFO_SITE_OUT_DIR: an hourly rebuild stages beside the served build",
    )
  }
  // A code mismatch rebuilds in place before serving, exactly as before; that build reads the newest hourly run itself.
  if (servedRevision() !== target) build(target)

  console.log(`terminfo-site: serving ${distDir} (${target.slice(0, 10)}) at http://${hostname}:${port}/`)
  Bun.serve({ hostname, port, fetch: createPreviewHandler(distDir) })
  if (runsDir === undefined || outRoot === undefined) return
  const rebuilder = createRunRebuilder({ runsDir, outRoot, target })
  void rebuilder.check()
  // The re-measure writes summary.json last; settle briefly after the last change so a half-written file is not read.
  let settle: ReturnType<typeof setTimeout> | undefined
  watch(runsDir, { recursive: true }, () => {
    clearTimeout(settle)
    settle = setTimeout(() => void rebuilder.check(), 5000)
  })
  console.log(`terminfo-site: rebuilding on each new complete hourly run under ${runsDir}`)
}

if (import.meta.main) serveLanded()
