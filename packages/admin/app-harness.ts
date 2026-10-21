#!/usr/bin/env bun
/** Source-tree harness for one immutable current real-terminal capture. */

import { writeFileSync } from "node:fs"
import { finalizeCollectedDraft } from "../terminfo.dev/src/daemon-client.ts"
import { ensureSourceSuiteEnvironment } from "./versions.ts"

async function main(): Promise<void> {
  const outputPath = process.argv[2]
  if (!outputPath) throw new Error("Usage: app-harness.ts <output-path>")
  ensureSourceSuiteEnvironment()
  const { collectProbeRun } = await import("../terminfo.dev/src/serve.ts")
  const run = finalizeCollectedDraft(await collectProbeRun())
  writeFileSync(outputPath, `${JSON.stringify(run, null, 2)}\n`, { flag: "wx" })
  writeFileSync(`${outputPath}.done`, "", { flag: "wx" })
}

await main()
