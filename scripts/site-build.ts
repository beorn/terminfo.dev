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
 *
 * It also enforces the build's resident-memory ceiling (28662 AC3): an in-process guard samples the resident set and
 * fails the build LOUDLY the moment it passes `TERMINFO_SITE_PEAK_CEILING_BYTES` (default 16 GiB, the declared value),
 * naming the peak and the phase. See `./build-peak-guard.ts` for why a silent continue is not an option here.
 */
import { dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { lstatSync, mkdirSync, readlinkSync, symlinkSync, unlinkSync } from "node:fs"
import { build } from "vitepress"
import {
  installRenderPhaseHook,
  invalidateBuildStamp,
  peakBreachMessage,
  peakCeilingBytes,
  phasePeaksMessage,
  startPeakGuard,
} from "./build-peak-guard.ts"
import { siteDistDir, siteTempDir } from "./site-out.ts"
import { loadFeatures } from "@terminfo/catalog"
import { probeStatusSummary } from "../docs/data/probe-status.ts"

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

const ceilingBytes = peakCeilingBytes()
const guard = startPeakGuard({
  ceilingBytes,
  onBreach(breach) {
    // The build's own buildEnd may already have stamped the dist; a stamp left behind is a dist the NEXT start would
    // serve without rebuilding. Remove it, so a breached output is never served (28662 AC3).
    const invalidated = invalidateBuildStamp(siteDistDir(repoRoot))
    console.error(peakBreachMessage({ ...breach, ceilingBytes }))
    console.error(
      invalidated.length === 0
        ? "site-build: the breach came before any served stamp existed; nothing to invalidate"
        : `site-build: removed the served stamp (${invalidated.join(", ")}), so this output is never served`,
    )
    // A breached build still reports its phase band: the failing run is exactly the one worth measuring, and the
    // exit below would otherwise be the only outcome that never printed it.
    console.log(phasePeaksMessage(guard.phasePeaks()))
    // The build owns a scratch root, not the served dist: a half-built output is never served, because landed-serve
    // refuses the output of a failed build and the health probe keeps answering `starting` until it is rebuilt.
    process.exit(1)
  },
})

/** One line, whatever the outcome: the peak this build measured against its ceiling, so the unit's log carries it. */
function reportPeak(status: string): void {
  const where = guard.peakPhase()
  const gib = (bytes: number): string => (bytes / 1024 ** 3).toFixed(2)
  console.log(
    `site-build: ${status} — peak resident ${gib(guard.peakBytes())} GB ` +
      `(ceiling ${(ceilingBytes / 1024 ** 3).toFixed(2)} GB; largest in ${where?.label ?? "no phase named"})`,
  )
  // Every phase's own high-water, not only the largest: the next measurement chooses what to bound from the band.
  console.log(phasePeaksMessage(guard.phasePeaks()))
}

/**
 * The probeStatus gap, printed with every build: the distribution, how many rows still read the
 * temporary `undeclared`, and which reviewed values stand over a settled derivation (a gate). 28792
 * item 4; 28801 deletes `undeclared` when its count reaches zero.
 */
function reportProbeStatus(): void {
  const summary = probeStatusSummary(loadFeatures(join(repoRoot, "content")))
  const gated = summary.gated.length > 0 ? summary.gated.join(", ") : "none"
  console.log(
    `site-build: probe status ${summary.counts.automated} automated, ${summary.counts.partial} partial, ` +
      `${summary.counts.manual} manual, ${summary.counts.unprobed} unprobed, ${summary.counts.undeclared} undeclared; ` +
      `gated (reviewed over a settled derivation): ${summary.gated.length} — ${gated}`,
  )
}

try {
  await build(join(repoRoot, "docs"), {
    onAfterConfigResolve(siteConfig) {
      if (tempDir !== undefined) siteConfig.tempDir = tempDir
      guard.phase("bundles")
      installRenderPhaseHook(siteConfig, guard)
    },
  })
  guard.phase("emit")
} catch (error) {
  console.error(error instanceof Error ? (error.stack ?? error.message) : error)
  guard.stop()
  reportPeak("FAILED")
  process.exit(1)
}
guard.stop()
reportProbeStatus()
reportPeak("done")
