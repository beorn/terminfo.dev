#!/usr/bin/env bun
/** Executable admission facade; the shared module owns the one implementation. */
import { dirname, join } from "node:path"
import { readFileSync } from "node:fs"
import { decodeCollectorDraft } from "@terminfo/run-parser"
import { derivedSuiteManifest, probeSuiteSnapshot } from "../packages/admin/versions.ts"
import { execFileSync } from "node:child_process"
import { saveDaemonProbeRun } from "../packages/terminfo.dev/src/daemon-client.ts"
import { admitRun, planAdmission, CONTENT_DIR } from "../packages/admin/run-admission.ts"
export {
  admitRun,
  assessRunAdmission,
  placeOwnershipReceipt,
  placeRun,
  placeRetainedArtifacts,
  planAdmission,
  type IdentityAdmission,
  type AdmissionExclusionCode,
  type AdmissionPlan,
} from "../packages/admin/run-admission.ts"

function usage(): never {
  console.error(
    "Usage: bun scripts/admit-run.ts --for <run.json> [--into <path>] [--review <decision.json> ... --review-started-at <ISO timestamp>]\n" +
      "  --review resumes an unsealed capture with exact typed decision files and their actual review-attempt timestamp.\n" +
      "  Declares the run's suite manifest (derived record only) and places the run and every\n" +
      "  retained artifact it cites in content/. Refuses by name if a cited artifact is missing.\n" +
      "  Refuses unless this tree runs the run's own suite; commit the admission in your own worktree.\n" +
      "  Refuses by name when a receipt the run cites is missing beside it, mismatched or bound to another target.",
  )
  process.exit(2)
}

if (import.meta.main) {
  const argv = process.argv.slice(2)
  let source: string | undefined
  let into: string | undefined
  const reviews: string[] = []
  let reviewStartedAt: string | undefined
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--for") source = argv[++index]
    else if (argv[index] === "--into") into = argv[++index]
    else if (argv[index] === "--review" && argv[index + 1]) {
      const reviewPath = argv[++index]
      if (!reviewPath) usage()
      reviews.push(reviewPath)
    } else if (argv[index] === "--review-started-at") reviewStartedAt = argv[++index]
    else usage()
  }
  if (!source) usage()
  try {
    if (reviews.length > 0 !== (reviewStartedAt !== undefined)) {
      throw new Error(
        "Capture review requires both --review decision files and --review-started-at actual attempt timestamp",
      )
    }
    if (reviews.length > 0) {
      if (!reviewStartedAt) throw new Error("Capture review requires its actual attempt timestamp")
      const startedAt = reviewStartedAt
      const manifest = derivedSuiteManifest(probeSuiteSnapshot())
      const revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: import.meta.dirname, encoding: "utf8" }).trim()
      const decoded = decodeCollectorDraft(source, readFileSync(source, "utf8"), manifest, revision)
      source = saveDaemonProbeRun(
        decoded.run,
        dirname(source),
        undefined,
        reviews.map((path) => ({ source: readFileSync(path, "utf8"), startedAt })),
      )
      console.log(`Retained reviewed capture ${source}; original draft unchanged`)
      if (source.endsWith(".draft.json")) throw new Error(`Required reviews remain pending in ${source}; no admission`)
    }
    const plan = planAdmission(source, into)
    const result = admitRun(plan)
    console.log(
      `Admitted run ${result.run} (screenshots ${result.screenshots.created} created, ` +
        `${result.screenshots.existing} already present): ${plan.destination}`,
    )
    console.log(`Suite manifest ${result.manifest}: ${join(CONTENT_DIR, "suites", `${plan.probeHash}.json`)}`)
    console.log(`Ownership receipt ${result.receipt.placed}: ${result.receipt.detail}`)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
