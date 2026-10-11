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
import { rmSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"

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

/**
 * The build marker's path: `<TERMINFO_SITE_OUT_DIR>/rebuild.json`, or `undefined` with no state root. It sits at the
 * root of the write tree, clear of `dist/`, `cache/`, `temp/` and `content/`, so no build step can clobber it.
 */
export function siteRebuildMarkerPath(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const root = siteOutRoot(env)
  return root ? resolve(root, "rebuild.json") : undefined
}

/**
 * Write the rebuild marker, naming the revision the build is writing TO (28268 AC4), and return the action that
 * clears it on success. `undefined` (and no write) with no state root, so a bare developer checkout is unchanged.
 *
 * The caller clears the marker only AFTER the build has stamped the target revision. A build that exits non-zero
 * leaves the marker behind on purpose: the health probe then keeps answering `starting` until the declared readiness
 * window fails the unit, which is the loud failure we want instead of a silent serve of the previous dist.
 */
export function writeSiteRebuildMarker(target: string, env: NodeJS.ProcessEnv = process.env): (() => void) | undefined {
  const path = siteRebuildMarkerPath(env)
  if (path === undefined) return undefined
  writeFileSync(
    path,
    `${JSON.stringify({ schema: "terminfo-site-rebuild/1", target, startedAt: new Date().toISOString() })}\n`,
  )
  return () => rmSync(path, { force: true })
}
