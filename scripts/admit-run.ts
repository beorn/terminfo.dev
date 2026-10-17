#!/usr/bin/env bun
/** Executable admission facade; the shared module owns the one implementation. */
import { join } from "node:path"
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
    "Usage: bun scripts/admit-run.ts --for <run.json> [--into <path>]\n" +
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
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--for") source = argv[++index]
    else if (argv[index] === "--into") into = argv[++index]
    else usage()
  }
  if (!source) usage()
  try {
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
