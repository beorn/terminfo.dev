/** Collect private v2 headless runs; each engine is resolved through Termless. */

import { collectHeadlessRuns } from "../../probes/collect-headless.ts"

export async function runTermlessProbes(selectors: string[], opts: { force?: boolean; probeIds?: string[] }): Promise<void> {
  const collection = await collectHeadlessRuns(selectors, undefined, undefined, opts.probeIds)
  console.log(`Headless raw runs: ${collection.runs.length}; directory: ${collection.directory}`)
  if (collection.failures.length) {
    throw new Error(
      `${collection.failures.length} headless engine(s) refused; successful raw runs remain private at ${collection.directory}:\n` +
        collection.failures
          .map(({ backend, package: specifier, error }) => `${backend} (${specifier}): ${error}`)
          .join("\n"),
    )
  }
}
