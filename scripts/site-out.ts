/**
 * The one environment variable that roots every write of a terminfo.dev site build.
 *
 * `bun run build` writes three things: the VitePress output, the VitePress incremental cache, and the derived
 * `content/analysis.json`. Two of them land inside the source tree, which is fine for a developer checkout and
 * fatal for a hab landing: a landing is an immutable projection, so a build that writes into its own checkout
 * mutates the landing it is serving and every later promotion inherits the drift.
 *
 * With `TERMINFO_SITE_OUT_DIR` set, all three move under that one directory and the checkout stays write-once.
 * With it unset, every path is exactly what it was before this module existed, so an unset build is byte-identical.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"

/** The one write-root override. `undefined` means "the historical, in-tree paths". */
export function siteOutRoot(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const raw = env["TERMINFO_SITE_OUT_DIR"]?.trim()
  return raw ? raw : undefined
}

/** VitePress output: `docs/.vitepress/dist`, or `<TERMINFO_SITE_OUT_DIR>/dist` when the override is set. */
export function siteDistDir(repoRoot: string, env: NodeJS.ProcessEnv = process.env): string {
  const root = siteOutRoot(env)
  return root ? resolve(root, "dist") : resolve(repoRoot, "docs", ".vitepress", "dist")
}

/** VitePress incremental cache; `undefined` keeps VitePress's own default (`docs/.vitepress/cache`). */
export function siteCacheDir(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const root = siteOutRoot(env)
  return root ? resolve(root, "cache") : undefined
}

/**
 * VitePress's SSR scratch directory. VitePress hardcodes it at `<site root>/.temp` and has no config field for it,
 * so `scripts/site-build.ts` overrides the resolved value through the build hook.
 */
export function siteTempDir(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const root = siteOutRoot(env)
  return root ? resolve(root, "temp") : undefined
}

/** Derived analysis snapshot: `content/analysis.json`, or `<TERMINFO_SITE_OUT_DIR>/content/analysis.json`. */
export function siteAnalysisPath(repoRoot: string, env: NodeJS.ProcessEnv = process.env): string {
  const root = siteOutRoot(env)
  return root ? resolve(root, "content", "analysis.json") : resolve(repoRoot, "content", "analysis.json")
}

/** Prepared client probe data, beside this build's analysis snapshot. */
export function siteProbesPath(repoRoot: string, env: NodeJS.ProcessEnv = process.env): string {
  return resolve(dirname(siteAnalysisPath(repoRoot, env)), "probes.json")
}

/** Prepared lazy working-run history payload (preview-only), beside probes.json (#38451). */
export function siteWorkingHistoryPath(repoRoot: string, env: NodeJS.ProcessEnv = process.env): string {
  return resolve(dirname(siteAnalysisPath(repoRoot, env)), "working-history.json")
}

/**
 * The build marker's path: `<TERMINFO_SITE_OUT_DIR>/rebuild.json`, or `undefined` with no state root. It sits at the
 * root of the write tree, clear of `dist/`, `cache/`, `temp/` and `content/`, so no build step can clobber it.
 */
export function siteRebuildMarkerPath(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const root = siteOutRoot(env)
  return root ? resolve(root, "rebuild.json") : undefined
}

/** What a marker's build was for: see `writeSiteRebuildMarker` for why the probe must be able to tell them apart. */
export type SiteRebuildKind = "code" | "run"

/**
 * Write the rebuild marker, naming the revision the build is writing TO (28268 AC4), and return the action that
 * clears it on success. `undefined` (and no write) with no state root, so a bare developer checkout is unchanged.
 *
 * The caller clears the marker only AFTER the build has stamped the target revision. A build that exits non-zero
 * leaves the marker behind on purpose, and `kind` is what lets the health probe read that leftover correctly:
 *
 * - `code` (a landing's own revision is not the served one): the preview cannot serve the new code until this build
 *   lands, so the probe answers `starting` inside the readiness window and a marker still there past it is a stale
 *   CODE page — the loud failure we want instead of a silent serve of the previous dist.
 * - `run` (the served code already is the landing; only a newer hourly run is being folded in): the previous dist
 *   keeps serving the landing's code for the whole build, so a failed or slow run build must never be reported as a
 *   stale code build (#38595, page 35dd8a8c: a failed hourly run build paged `terminfo-site-stale` on a preview that
 *   answered 200 on the landing's own code).
 *
 * `serving` (#30205) names the previous build's code revision when the program keeps serving it while this build runs
 * beside it. The health probe then answers healthy (the preview IS up) instead of `starting`, so a restart is not held
 * for the whole build; the preview follow reads the same field to know a rebuild is in flight, not stuck.
 */
export function writeSiteRebuildMarker(
  target: string,
  env: NodeJS.ProcessEnv = process.env,
  kind: SiteRebuildKind = "code",
  serving: string | null = null,
): (() => void) | undefined {
  const path = siteRebuildMarkerPath(env)
  if (path === undefined) return undefined
  // The state root is not guaranteed to exist: a unit's first start writes the marker BEFORE the first build, and
  // nothing else creates /hh/var/terminfo-site. Without this the first run throws ENOENT in the write below — before
  // any build — and the unit restart-loops (@cto 0dc097ac, measured: the directory did not exist).
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(
    path,
    `${JSON.stringify({
      schema: "terminfo-site-rebuild/1",
      target,
      kind,
      ...(serving === null ? {} : { serving }),
      startedAt: new Date().toISOString(),
    })}\n`,
  )
  return () => rmSync(path, { force: true })
}

/**
 * Record on the marker that its build FAILED (#30205), keeping every field the build wrote. The marker stays, so a
 * failed rebuild is read as failed — by the health probe (stale, at once) and by the preview follow (its one alert) —
 * and never as an absent marker that only a timeout could tell from a build still running. No-op with no state root.
 */
export function recordSiteRebuildFailure(cause: string, env: NodeJS.ProcessEnv = process.env): void {
  const path = siteRebuildMarkerPath(env)
  if (path === undefined) return
  let written: Record<string, unknown> = {}
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"))
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      written = parsed as Record<string, unknown>
    }
  } catch (error) {
    // The build wrote this marker before it started; losing it is a surprise worth a line, and the failure is still
    // written below so it stays readable (NO SILENT ERRORS).
    console.error(
      `terminfo-site: rebuild marker at ${path} unreadable while recording a failure (${
        error instanceof Error ? error.message : String(error)
      }); writing the failure alone`,
    )
  }
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(
    path,
    `${JSON.stringify({
      schema: "terminfo-site-rebuild/1",
      ...written,
      failure: cause,
      failedAt: new Date().toISOString(),
    })}\n`,
  )
}
