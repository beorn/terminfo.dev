#!/usr/bin/env bun
/**
 * The VitePress site build, with the one knob VitePress does not expose as configuration.
 *
 * The CLI is `vitepress build docs`; this calls the same `build()` entry point so it can pass
 * `onAfterConfigResolve` and root the resolved SSR scratch directory (`tempDir`) outside the source tree. VitePress
 * hardcodes `tempDir` at `<site root>/.temp` (`dist/node/chunk-*.js`: `tempDir: resolve(root, ".temp")`) and sends
 * the SSR build there, so an otherwise write-once build still mutates the checkout it runs from — fatal in a hab
 * landing, where that write would land in the landing it is serving. `TERMINFO_SITE_OUT_DIR` (see `./site-out.ts`)
 * moves it under `<out>/temp`; unset, VitePress's own default is used unchanged.
 */
import { dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { lstatSync, mkdirSync, readlinkSync, symlinkSync, unlinkSync } from "node:fs"
import { build } from "vitepress"
import { siteTempDir } from "./site-out.ts"

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const tempDir = siteTempDir()

/**
 * The SSR bundle VitePress writes into `tempDir` imports the site's own dependencies (`vue`, …) when it runs, and
 * Node/Bun resolve those by walking up from the importing file. Once the scratch root is outside the checkout that
 * walk finds no `node_modules`, so the state root gets a link to the tree being built.
 *
 * The link is MANAGED, never merely created: ONE state output root outlives the checkout that first built into it
 * (a landing is replaced at every promotion), so a link left pointing at a retired tree would silently build the new
 * landing's SSR bundle against the old one's dependencies. It is repointed to this checkout on every build, and
 * anything but a symlink where it belongs refuses loudly rather than build against a tree we did not choose.
 */
function linkIncludes(repoRoot: string, scratchParent: string): void {
  const link = join(scratchParent, "node_modules")
  const target = join(repoRoot, "node_modules")
  const existing = lstatSync(link, { throwIfNoEntry: false })
  if (existing === undefined) {
    symlinkSync(target, link, "dir")
    return
  }
  if (!existing.isSymbolicLink()) {
    console.error(`site-build: ${link} exists and is not a symlink; refusing to build against an unknown tree`)
    process.exit(1)
  }
  if (readlinkSync(link) !== target) {
    unlinkSync(link)
    symlinkSync(target, link, "dir")
  }
}

if (tempDir !== undefined) {
  const scratchParent = dirname(tempDir)
  mkdirSync(scratchParent, { recursive: true })
  // Only when the scratch root is outside the checkout: inside it, the walk up already reaches this tree's own
  // node_modules and a link would be noise (and could collide with a real one).
  if (relative(repoRoot, scratchParent).startsWith("..")) linkIncludes(repoRoot, scratchParent)
}

try {
  await build(join(repoRoot, "docs"), {
    onAfterConfigResolve(siteConfig) {
      if (tempDir !== undefined) siteConfig.tempDir = tempDir
    },
  })
} catch (error) {
  console.error(error instanceof Error ? (error.stack ?? error.message) : error)
  process.exit(1)
}
