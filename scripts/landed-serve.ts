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
 */
import { execFileSync, spawnSync } from "node:child_process"
import { existsSync, readFileSync, statSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { siteDistDir, writeSiteRebuildMarker } from "./site-out.ts"

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const distDir = siteDistDir(repoRoot)
const hostname = process.env["TERMINFO_SITE_HOST"] ?? "100.87.90.48"
const port = Number(process.env["TERMINFO_SITE_PORT"] ?? "4173")

/** The revision this checkout is at — for a landing, the gitlink of vendor/terminfo.dev. */
function landingRevision(): string {
  return execFileSync("git", ["-C", repoRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim()
}

/** The revision the served output was built from, or null when there is no readable stamp. */
function servedRevision(): string | null {
  const stamp = join(distDir, "build.json")
  if (!existsSync(stamp)) return null
  try {
    const parsed: unknown = JSON.parse(readFileSync(stamp, "utf8"))
    if (parsed === null || typeof parsed !== "object") return null
    const source = (parsed as { sourceCommit?: unknown }).sourceCommit
    return typeof source === "string" ? source : null
  } catch {
    return null
  }
}

function build(target: string): void {
  console.log(`terminfo-site: served output is ${servedRevision() ?? "absent"}, landing is ${target} — rebuilding`)
  // The marker the health probe reads while this rebuild runs (28268 AC4); see `writeSiteRebuildMarker` for why it
  // is cleared only on success.
  const clearMarker = writeSiteRebuildMarker(target)
  const result = spawnSync("bun", ["run", "build"], { cwd: repoRoot, stdio: "inherit", env: process.env })
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

const target = landingRevision()
if (servedRevision() !== target) build(target)

const notFound = join(distDir, "404.html")
console.log(`terminfo-site: serving ${distDir} (${target.slice(0, 10)}) at http://${hostname}:${port}/`)
Bun.serve({
  hostname,
  port,
  fetch(request) {
    if (request.method !== "GET" && request.method !== "HEAD") return new Response("read-only", { status: 405 })
    let urlPath = decodeURIComponent(new URL(request.url).pathname)
    if (urlPath.endsWith("/")) urlPath += "index.html"
    const candidate = resolve(distDir, "." + urlPath)
    let file = candidate.startsWith(distDir + "/") ? candidate : notFound
    const stat = statSync(file, { throwIfNoEntry: false })
    if (stat === undefined) file = notFound
    else if (stat.isDirectory()) file = join(file, "index.html")
    return new Response(Bun.file(file), { status: file === notFound ? 404 : 200 })
  },
})
