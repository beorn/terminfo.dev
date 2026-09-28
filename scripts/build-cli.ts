#!/usr/bin/env bun
/** Bundle the publishable CLI with the one trusted suite declaration. */

import { execFileSync } from "node:child_process"
import { mkdirSync, renameSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { probeSuiteSnapshot } from "../packages/admin/versions.ts"
import { checkCurrentSuiteManifest } from "./suite-manifest.ts"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")

async function main(): Promise<void> {
  const snapshot = probeSuiteSnapshot()
  const sourcePaths = [
    ...snapshot.sourcePaths,
    "packages/terminfo.dev/src",
    "packages/terminfo.dev/bin/terminfo.mjs",
    "packages/admin/versions.ts",
    "scripts/build-cli.ts",
    "scripts/suite-manifest.ts",
    "bun.lock",
    `content/suites/${snapshot.probeHash}.json`,
  ]
  const dirty = execFileSync("git", ["status", "--porcelain", "--", ...sourcePaths], {
    cwd: ROOT,
    encoding: "utf8",
  }).trim()
  if (dirty) throw new Error(`Cannot bundle an uncommitted CLI collector:\n${dirty}`)
  const manifest = checkCurrentSuiteManifest()
  const collectorRevision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim()
  const result = await Bun.build({
    entrypoints: [join(ROOT, "packages", "terminfo.dev", "src", "index.tsx")],
    target: "bun",
    format: "esm",
    external: ["@silvery/ansi", "@silvery/commander", "silvery", "react"],
    define: { __TERMINFO_BUNDLED_SUITE__: JSON.stringify({ manifest, collectorRevision }) },
  })
  if (!result.success || result.outputs.length !== 1) {
    throw new Error(
      `CLI bundle failed: ${result.logs.map((entry) => entry.message).join("; ") || `${result.outputs.length} outputs`}`,
    )
  }
  const dist = join(ROOT, "packages", "terminfo.dev", "dist")
  mkdirSync(dist, { recursive: true })
  const destination = join(dist, "terminfo.bundle.mjs")
  const temporary = `${destination}.tmp-${process.pid}`
  const [output] = result.outputs
  if (!output) throw new Error("CLI bundle succeeded without an output")
  writeFileSync(temporary, Buffer.from(await output.arrayBuffer()))
  renameSync(temporary, destination)
  console.log(`CLI bundle ready: ${destination} (${manifest.probeHash}, ${collectorRevision})`)
}

if (import.meta.main) await main()
