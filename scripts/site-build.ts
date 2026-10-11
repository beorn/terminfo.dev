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
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { lstatSync, mkdirSync, symlinkSync } from "node:fs"
import { build } from "vitepress"
import { siteTempDir } from "./site-out.ts"

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const tempDir = siteTempDir()

if (tempDir !== undefined) {
  // The SSR bundle VitePress writes into tempDir imports the site's own dependencies (`vue`, …) when it runs, and
  // Node/Bun resolve those by walking up from the importing file. Moved outside the checkout, that walk finds no
  // node_modules, so the scratch root gets a link to the checkout's tree. The write is into the state root; the
  // landing is never touched.
  const scratchParent = dirname(tempDir)
  mkdirSync(scratchParent, { recursive: true })
  const link = join(scratchParent, "node_modules")
  if (lstatSync(link, { throwIfNoEntry: false }) === undefined) {
    symlinkSync(join(repoRoot, "node_modules"), link, "dir")
  }
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
