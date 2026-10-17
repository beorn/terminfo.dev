#!/usr/bin/env bun
/** Executable suite check facade; shared modules own declaration and registry operations. */
import { basename } from "node:path"
import {
  checkCitedSuiteManifests,
  freezeCurrentSuiteManifest,
  suiteManifestMode,
} from "../packages/admin/suite-manifest.ts"
export * from "../packages/admin/suite-manifest.ts"

const USAGE = [
  "Usage: bun scripts/suite-manifest.ts --check | --freeze <release>",
  "  --check  verify that every committed run has a matching committed declaration",
  "           (a composed tree whose own suite is uncited is not an error: nothing cites it)",
  "  --freeze write the current collector's declaration carrying freeze.release <release>,",
  "           so the pointer that names a release's current suite is emitted by the writer",
  "",
  "Admitting a run is not a freeze: bun scripts/admit-run.ts --for <run.json> declares the suite",
  "without claiming it as any release's current one.",
].join("\n")

if (import.meta.main) {
  const mode = suiteManifestMode(process.argv.slice(2))
  if (mode === "usage") {
    console.error(USAGE)
    process.exitCode = 2
  } else {
    try {
      if (mode === "freeze") {
        const release = process.argv[3]
        if (release === undefined) throw new Error("--freeze needs a release name")
        const root = process.cwd()
        // One call: the claimant scan runs BEFORE the write, then the pointer is written and the
        // registry resolved. A second claimant throws the reader's own refusal before any byte moves.
        const frozen = freezeCurrentSuiteManifest(root, release)
        console.log(
          `Suite ${basename(frozen.path)} is ${frozen.status} and declares freeze.release "${release}"; ` +
            `${release} resolves to ${frozen.suiteId}`,
        )
      } else {
        const { cited } = checkCitedSuiteManifests()
        console.log(`Suite manifests valid for ${cited} cited suite(s)`)
      }
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error))
      process.exitCode = 1
    }
  }
}
