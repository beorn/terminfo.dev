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
 * is at. Any other state — absent, stale, unreadable — rebuilds into `<out>/staging` and swaps that in only on
 * success (`buildLanding`, #38423). A build that fails leaves the served dist untouched: the program keeps serving
 * the previous build and says on stderr which older landing is being shown, because a 502 from a build that merely
 * ran out of memory is worse than a preview that names its own staleness — the health probe answers `starting` while
 * the marker is up, so the staleness is never silent. It exits non-zero only when there is no previous build at all,
 * where serving nothing is the honest answer. Downtime on a landing restart is that build (measured 150-210 s on a
 * code-only corpus and ~10 min with the full hourly-run set, analysis included); the readiness window in the
 * declaration has to cover it.
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
 *
 * Only output this program produced is ever deleted. `<out>/staging` is reused when its own marker names a staging
 * tree this program created, and `<out>/dist.previous` when the retired dist's own `build.json` proves a terminfo
 * build wrote it; anything else — a tree that merely has the name — is renamed aside and reported on stderr, because
 * a pre-existing staging or retired tree of unproven origin is retained evidence, not scratch (@cto 2026-11-22,
 * #34952).
 */
import { execFileSync, spawn } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, watch, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { siteDistDir, siteOutRoot, writeSiteRebuildMarker } from "./site-out.ts"
import { peakCeilingBytes } from "./build-peak-guard.ts"
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
 * The one rebuild check: `code` when the served output is not this landing's revision (a staged rebuild that keeps the
 * previous dist if it fails, #38423), `run` when the code matches but a newer complete hourly run exists than the one
 * the output shows, else null.
 */
export function rebuildReason(target: string, stamp: ServedStamp, newestRunId: string | null): "code" | "run" | null {
  if (stamp.sourceCommit !== target) return "code"
  if (newestRunId !== null && stamp.workingRunId !== newestRunId) return "run"
  return null
}

type RunBuild = (env: NodeJS.ProcessEnv) => Promise<number | null>

/**
 * Hosted builds carry the existing task declaration so the host judges their own memory ceiling. The host's ceiling is
 * the build's one declared ceiling, `TERMINFO_SITE_PEAK_CEILING_BYTES` (default 16 GiB, so 16384 MiB), never a second
 * number: a build that outgrows it is raised in one place, the service's env (33965).
 */
export function siteBuildArgs(env: NodeJS.ProcessEnv): string[] {
  const landingRoot = env["TERMINFO_SITE_LANDING_ROOT"]
  return landingRoot === undefined
    ? ["run", "build"]
    : [
        join(landingRoot, "tools", "gate-task-guard.ts"),
        "--task",
        "terminfo-site-build",
        "--max-rss-mib",
        String(Math.ceil(peakCeilingBytes(env) / 1024 ** 2)),
        "--",
        "bun",
        "run",
        "build",
      ]
}

/**
 * The marker this program writes into a staging root before a build writes there. It is what makes the tree
 * provably this program's scratch on a later run: the path alone proves nothing (@cto 2026-11-22, #34952).
 */
const STAGING_MARKER = ".terminfo-site-staging.json"
const STAGING_MARKER_SCHEMA = "terminfo-site-staging/1"

/** The `.unproven-<timestamp>` name a kept tree takes, so nothing of unknown origin is ever overwritten. */
function keptAside(path: string, now: Date): string {
  return `${path}.unproven-${now.toISOString().replace(/[:.]/g, "-")}`
}

function carriesStagingMarker(staging: string): boolean {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(staging, STAGING_MARKER), "utf8"))
    return (
      parsed !== null && typeof parsed === "object" && (parsed as { schema?: unknown }).schema === STAGING_MARKER_SCHEMA
    )
  } catch {
    // silent-fallback-allow: provenance test only — absent, unreadable or foreign marker all mean "not ours", which the caller keeps instead of deleting
    return false
  }
}

/**
 * Make `staging` a tree this program may build into and clear. A staging root carrying our own marker is reused,
 * including the remains of a build that failed (a retry must be free to replace those); anything else is renamed
 * aside and reported, never deleted. Returns the path an unproven tree was kept at, or null when there was nothing.
 */
export function claimStaging(
  staging: string,
  build: { target: string; runId: string | null },
  now: Date = new Date(),
): string | null {
  let kept: string | null = null
  if (existsSync(staging) && !carriesStagingMarker(staging)) {
    kept = keptAside(staging, now)
    renameSync(staging, kept)
    console.error(
      `terminfo-site: ${staging} is not this program's build scratch (no ${STAGING_MARKER} naming a terminfo ` +
        `build); kept it at ${kept} instead of deleting it`,
    )
  }
  mkdirSync(staging, { recursive: true })
  writeFileSync(
    join(staging, STAGING_MARKER),
    `${JSON.stringify({ schema: STAGING_MARKER_SCHEMA, ...build, startedAt: now.toISOString() })}\n`,
  )
  // raw-delete-allow: standalone component repository without hh's removely; the staged dist is this program's own scratch output under a staging root it just marked
  rmSync(join(staging, "dist"), { recursive: true, force: true })
  return kept
}

/**
 * Delete a retired dist only when its own `build.json` proves a terminfo build wrote it. `<out>/dist.previous` under
 * our root is normally the output the last swap retired, but the name is not proof: a tree of unproven origin is
 * renamed aside and reported, never deleted. Returns the kept path, or null.
 */
export function discardRetiredDist(retired: string, now: Date = new Date()): string | null {
  if (!existsSync(retired)) return null
  const source = readServedStamp(retired).sourceCommit
  if (source !== null && /^[0-9a-f]{40}$/.test(source)) {
    // raw-delete-allow: standalone component repository without hh's removely; the tree's own build stamp proves a terminfo build produced it
    rmSync(retired, { recursive: true, force: true })
    return null
  }
  const kept = keptAside(retired, now)
  renameSync(retired, kept)
  console.error(`terminfo-site: ${retired} carries no terminfo build stamp; kept it at ${kept} instead of deleting it`)
  return kept
}

/** The real site build, run asynchronously so the previous build keeps serving while it runs. */
const siteBuild: RunBuild = (env) =>
  new Promise((resolve) => {
    const child = spawn("bun", siteBuildArgs(env), { cwd: repoRoot, stdio: "inherit", env })
    child.on("error", (error) => {
      console.error(`terminfo-site: cannot run the site build: ${error.message}`)
      resolve(null)
    })
    child.on("exit", (code) => resolve(code))
  })

/**
 * Retire the served dist and move a proven staged dist into place. Only trees this program produced are deleted;
 * `discardRetiredDist` keeps anything of unproven origin instead.
 */
function swapStagedDist(served: string, stagedDist: string, retired: string): void {
  discardRetiredDist(retired)
  if (existsSync(served)) renameSync(served, retired)
  renameSync(stagedDist, served)
  // raw-delete-allow: standalone component repository without hh's removely; this is exactly the served dist the swap above retired a moment ago
  rmSync(retired, { recursive: true, force: true })
}

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
  claimStaging(staging, { target: args.target, runId: args.runId })
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
  swapStagedDist(served, stagedDist, retired)
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

/**
 * Build this landing before the first serve, into `<outRoot>/staging`, and swap it in only on success (#38423).
 * A failed build leaves the served dist untouched: the preview keeps serving the previous build and names both
 * commits, because a 502 caused by a build that is merely over the memory ceiling is worse than a preview that says
 * which older landing it is showing. The process exits only when there is nothing at all to serve, where serving
 * nothing is the honest answer. Returns true when the staged build was swapped in.
 */
export async function buildLanding(
  args: { outRoot: string; target: string; runBuild?: RunBuild },
  now: Date = new Date(),
): Promise<boolean> {
  const served = join(args.outRoot, "dist")
  const staging = join(args.outRoot, "staging")
  const stagedDist = join(staging, "dist")
  const previous = readServedStamp(served).sourceCommit
  console.log(
    `terminfo-site: served output is ${previous ?? "absent"}, landing is ${args.target} — rebuilding into ${staging}`,
  )
  // The marker the health probe reads while this rebuild runs (28268 AC4); see `writeSiteRebuildMarker` for why it
  // is cleared only once the outcome is known: on success because the build landed, on a kept previous build because
  // this program has stopped rebuilding and is serving again.
  const clearMarker = writeSiteRebuildMarker(args.target, { TERMINFO_SITE_OUT_DIR: args.outRoot })
  claimStaging(staging, { target: args.target, runId: null }, now)
  // The build records the CODE gitlink it was made from into the dist's stamp, so the health probe can read which
  // CODE pin the served corpus belongs to straight from /build.json with no walk of the CODE root (28620). This
  // checkout's HEAD is that pin, and `target` is it; the build has no other way to know a landing is the caller.
  const status = await (args.runBuild ?? siteBuild)({
    ...process.env,
    TERMINFO_SITE_OUT_DIR: staging,
    TERMINFO_SITE_CODE_GITLINK: args.target,
  })
  const staged = readServedStamp(stagedDist)
  const failure = status !== 0 ? `site build failed (exit ${String(status)})` : null
  const mismatch =
    failure === null && staged.sourceCommit !== args.target
      ? `build stamped ${staged.sourceCommit ?? "nothing"}, expected ${args.target}`
      : null
  if (failure !== null || mismatch !== null) {
    if (previous === null) {
      console.error(`terminfo-site: ${failure ?? mismatch}; no previous build to serve`)
      process.exit(1)
    }
    console.error(
      `terminfo-site: ${failure ?? mismatch}; NOT serving ${args.target.slice(0, 12)} — still serving the previous ` +
        `build ${previous.slice(0, 12)} from ${served} until a build passes`,
    )
    clearMarker?.()
    return false
  }
  swapStagedDist(served, stagedDist, join(args.outRoot, "dist.previous"))
  clearMarker?.()
  return true
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

const COMPRESSIBLE_EXT = /\.(?:html|js|mjs|css|json|svg|xml|txt)$/i

function serveStaticFile(filePath: string, status: number, request: Request): Response {
  const file = Bun.file(filePath)
  const acceptEncoding = request.headers.get("accept-encoding") ?? ""
  if (COMPRESSIBLE_EXT.test(filePath) && acceptEncoding.includes("gzip")) {
    const raw = readFileSync(filePath)
    if (raw.byteLength >= 1024) {
      const headers = new Headers({
        "content-type": file.type || "application/octet-stream",
        "content-encoding": "gzip",
        vary: "Accept-Encoding",
        ...(filePath.includes("/assets/") ? { "cache-control": "public, max-age=31536000, immutable" } : {}),
      })
      if (request.method === "HEAD") return new Response(null, { status, headers })
      const compressed = Bun.gzipSync(raw)
      headers.set("content-length", String(compressed.byteLength))
      return new Response(compressed, { status, headers })
    }
  }
  const headers = new Headers()
  if (filePath.includes("/assets/")) headers.set("cache-control", "public, max-age=31536000, immutable")
  return new Response(request.method === "HEAD" ? null : file, { status, headers })
}

/** The read-only GET/HEAD handler over one dist directory; exported so the tests drive the real routing. */
export function createPreviewHandler(distDir: string): (request: Request) => Response {
  const notFound = join(distDir, "404.html")
  return (request) => {
    if (request.method !== "GET" && request.method !== "HEAD") return new Response("read-only", { status: 405 })
    const resolved = resolveServedPath(distDir, new URL(request.url).pathname)
    return resolved === null ? serveStaticFile(notFound, 404, request) : serveStaticFile(resolved, 200, request)
  }
}

async function serveLanded(): Promise<void> {
  const target = landingRevision()
  const runsDir = siteWorkingRunsDir()
  const outRoot = siteOutRoot()
  if (runsDir !== undefined && outRoot === undefined) {
    throw new Error(
      "TERMINFO_SITE_WORKING_RUNS_DIR needs TERMINFO_SITE_OUT_DIR: an hourly rebuild stages beside the served build",
    )
  }
  // A code mismatch rebuilds into the staging root before serving; that build reads the newest hourly run itself, and
  // a failure keeps the previous build serving instead of taking the preview down (#38423).
  if (servedRevision() !== target) {
    await buildLanding({ outRoot: outRoot ?? resolve(repoRoot, "docs", ".vitepress"), target })
  }

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

if (import.meta.main) void serveLanded()
