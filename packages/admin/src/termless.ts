/** Collect private v2 headless runs; each engine is resolved through Termless. */

import { collectHeadlessRuns, headlessCollectorSuite } from "../../probes/collect-headless.ts"
import { shadowCollectedRun } from "./collected-run.ts"

export async function runTermlessProbes(
  selectors: string[],
  opts: { force?: boolean; probeIds?: string[] },
): Promise<void> {
  const collection = await collectHeadlessRuns(selectors, undefined, undefined, opts.probeIds)
  console.log(`Headless raw runs: ${collection.runs.length}; directory: ${collection.directory}`)
  // #30932 S3: each saved run's private shadow report, awaited, before any refusal below is raised. The shadow never
  // throws and never touches the run; a report it cannot write is named on stderr.
  const suite = () => {
    const { manifest, runRevision } = headlessCollectorSuite()
    return { manifest, sourceRevision: runRevision }
  }
  for (const run of collection.runs) await shadowCollectedRun(run, suite)
  if (collection.failures.length) {
    throw new Error(
      `${collection.failures.length} headless engine(s) refused; successful raw runs remain private at ${collection.directory}:\n` +
        collection.failures
          .map(({ backend, package: specifier, error }) => `${backend} (${specifier}): ${error}`)
          .join("\n"),
    )
  }
}
