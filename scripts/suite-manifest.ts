#!/usr/bin/env bun
/** Executable suite check facade; shared modules own declaration and registry operations. */
import { checkCitedSuiteManifests, suiteManifestMode } from "../packages/admin/suite-manifest.ts"
export * from "../packages/admin/suite-manifest.ts"

const USAGE = [
  "Usage: bun scripts/suite-manifest.ts --check",
  "  --check  verify that every committed run has a matching committed declaration",
  "           (a composed tree whose own suite is uncited is not an error: nothing cites it)",
  "",
  "Declaring a suite is admission, not a standalone verb: bun scripts/admit-run.ts --for <run.json>",
].join("\n")

if (import.meta.main) {
  const mode = suiteManifestMode(process.argv.slice(2))
  if (mode === "usage") {
    console.error(USAGE)
    process.exitCode = 2
  } else {
    try {
      const { cited } = checkCitedSuiteManifests()
      console.log(`Suite manifests valid for ${cited} cited suite(s)`)
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error))
      process.exitCode = 1
    }
  }
}
