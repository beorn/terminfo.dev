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

/** Derived analysis snapshot: `content/analysis.json`, or `<TERMINFO_SITE_OUT_DIR>/content/analysis.json`. */
export function siteAnalysisPath(repoRoot: string, env: NodeJS.ProcessEnv = process.env): string {
  const root = siteOutRoot(env)
  return root ? resolve(root, "content", "analysis.json") : resolve(repoRoot, "content", "analysis.json")
}
