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

/** What a move did, in words that stay true when the pointer already names this suite. */
export function moveSummary(release: string, moved: ReturnType<typeof moveReleasePointer>): string {
  if (moved.status === "existing") {
    return `Suite ${basename(moved.path)} already declares freeze.release "${release}"; nothing moved`
  }
  return (
    `Suite ${basename(moved.path)} declares freeze.release "${release}"; ${release} moved off suite ` +
    `${moved.from} to ${moved.to}`
  )
}

const USAGE = [
  "Usage: bun scripts/suite-manifest.ts --check | --freeze <release> [--suite <id>] | --move <release> [--suite <id>]",
  "  --check  verify that every committed run has a matching committed declaration",
  "           (a composed tree whose own suite is uncited is not an error: nothing cites it)",
  "  --freeze write the current collector's declaration carrying freeze.release <release>,",
  "           so the pointer that names a release's current suite is emitted by the writer",
  "  --move   move <release>'s pointer onto the current collector's suite, recording the suite it",
  "           leaves on the new freeze record; move a release's pointer only with this command",
  "  --suite  name the target suite explicitly instead of the live collector's. The id must be twelve",
  "           lowercase hex, a manifest must carry it, and that manifest must declare its own id. This",
  "           is how a ruling that names an older suite is recorded when the collector has moved on;",
  "           the target is read from the registry and never compared with the live suite.",
  "",
  "Admitting a run is not a freeze: bun scripts/admit-run.ts --for <run.json> declares the suite",
  "without claiming it as any release's current one.",
].join("\n")

if (import.meta.main) {
  const argv = process.argv.slice(2)
  const mode = suiteManifestMode(argv)
  if (mode === "usage") {
    console.error(USAGE)
    process.exitCode = 2
  } else {
    try {
      if (mode === "check") {
        const { cited } = checkCitedSuiteManifests()
        console.log(`Suite manifests valid for ${cited} cited suite(s)`)
      } else {
        const release = argv[1]
        if (release === undefined) throw new Error(`${argv[0]} needs a release name`)
        const root = process.cwd()
        const suite = argv[2] === "--suite" ? argv[3] : undefined
        if (mode === "move") {
          console.log(moveSummary(release, moveReleasePointer(root, release, { suite })))
        } else {
          // One call: the claimant scan runs BEFORE the write, then the pointer is written and the
          // registry resolved. A second claimant throws the reader's own refusal before any byte moves.
          const frozen = freezeCurrentSuiteManifest(root, release, { suite })
          console.log(
            `Suite ${basename(frozen.path)} is ${frozen.status} and declares freeze.release "${release}"; ` +
              `${release} resolves to ${frozen.suiteId}`,
          )
        }
      }
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error))
      process.exitCode = 1
    }
  }
}
