#!/usr/bin/env bun
/** Executable suite check facade; shared modules own declaration and registry operations. */
import { basename } from "node:path"
import {
  checkCitedSuiteManifests,
  freezeCurrentSuiteManifest,
  moveReleasePointer,
  suiteManifestMode,
} from "../packages/admin/suite-manifest.ts"
export * from "../packages/admin/suite-manifest.ts"

const USAGE = [
  "Usage: bun scripts/suite-manifest.ts --check | --freeze <release> | --move <release>",
  "  --check  verify that every committed run has a matching committed declaration",
  "           (a composed tree whose own suite is uncited is not an error: nothing cites it)",
  "  --freeze write the current collector's declaration carrying freeze.release <release>,",
  "           so the pointer that names a release's current suite is emitted by the writer",
  "  --move   move <release>'s pointer onto the current collector's suite, recording the suite it",
  "           leaves on the new freeze record; a pointer move happens only through this command",
  "",
  "Admitting a run is not a freeze: bun scripts/admit-run.ts --for <run.json> declares the suite",
  "without claiming it as any release's current one.",
].join("\n")

if (import.meta.main) {
  const argv = process.argv.slice(2)
  if (argv[0] === "--move") {
    const release = argv[1]
    if (release === undefined) {
      console.error("--move needs a release name")
      process.exitCode = 2
    } else {
      try {
        const moved = moveReleasePointer(process.cwd(), release)
        console.log(
          `Suite ${basename(moved.path)} declares freeze.release "${release}"; ${release} moved` +
            `${moved.from === undefined ? "" : ` off suite ${moved.from}`} to ${moved.to}`,
        )
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error))
        process.exitCode = 1
      }
    }
  } else {
    const mode = suiteManifestMode(argv)
    if (mode === "usage") {
      console.error(USAGE)
      process.exitCode = 2
    } else {
      try {
        if (mode === "freeze") {
          const release = argv[1]
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
}
