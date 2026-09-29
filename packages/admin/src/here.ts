/** Inline real-terminal collection through the shared v2 batch. */

import { ensureSourceSuiteEnvironment } from "../versions.ts"

export async function handleHere(opts: { json?: boolean }): Promise<void> {
  ensureSourceSuiteEnvironment()
  const { collectProbeRun } = await import("terminfo.dev/src/serve.ts")
  const run = await collectProbeRun()
  if (opts.json) {
    console.log(JSON.stringify(run, null, 2))
    return
  }
  const total = run.observations.length + Object.keys(run.ungradedDiagnostics ?? {}).length
  console.log(`${run.target.id} ${run.target.version}: ${run.observations.length}/${total} explicit observations`)
  console.log(`Run ${run.runId} is unreviewed${run.suiteComplete ? "" : " and partial"}; use --json for raw evidence.`)
}
