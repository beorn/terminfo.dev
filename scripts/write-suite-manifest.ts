#!/usr/bin/env bun
/**
 * Write this tree's suite manifest to content/suites/<suite>.json (33109, @cto 0e10dc13, d05d6b32). The definition
 * batch's last step: after the batch's final merge, run this on main's tree and submit the one file alone (it moves
 * no suite), so every working run at main's new suite stays readable by the selection without anyone placing a run.
 * Safe to run any time: same writer and bytes as placement, an identical existing file is a no-op, different bytes
 * under the same suite id refuse. Prints the suite id it wrote or found.
 */
import { placeSuiteManifest } from "../packages/admin/corpus-placement.ts"

if (import.meta.main) {
  if (process.argv.length > 2) {
    throw new Error(`write-suite-manifest takes no arguments; got ${process.argv.slice(2).join(" ")}`)
  }
  const { suiteId, path, outcome } = placeSuiteManifest()
  console.log(`${outcome === "created" ? "wrote" : "already present, identical:"} suite ${suiteId} manifest ${path}`)
}
