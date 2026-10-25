/** Inline real-terminal collection through the shared current execution batch. */

import { finalizeCollectedDraft } from "../../terminfo.dev/src/daemon-client.ts"
import {
  aggregateCurrentResults,
  currentCoverageSentence,
  currentSupportedShare,
} from "../../../docs/data/release-scope.ts"
import { ensureSourceSuiteEnvironment } from "../versions.ts"

export async function handleHere(opts: { json?: boolean }): Promise<void> {
  ensureSourceSuiteEnvironment()
  const { collectProbeRun } = await import("../../terminfo.dev/src/serve.ts")
  const run = finalizeCollectedDraft(await collectProbeRun())
  if (opts.json) {
    console.log(JSON.stringify(run, null, 2))
    return
  }
  const catalogIds = run.results.map((result) => result.featureId)
  const aggregate = aggregateCurrentResults(run.results, catalogIds)
  console.log(`${run.target.id} ${run.target.version}: ${currentSupportedShare(aggregate)}`)
  console.log(currentCoverageSentence(aggregate, catalogIds))
  console.log(
    `Run ${run.runId}: ${run.sealedAt === undefined ? "required review pending; unsealed draft" : "sealed"}; identity unverified.`,
  )
}
