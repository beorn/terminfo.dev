#!/usr/bin/env bun
/** Source-tree harness for one immutable real-terminal v2 capture. */

import { writeFileSync } from "node:fs"
import { sourceSuiteEnvironment } from "./versions.ts"

async function main(): Promise<void> {
  const outputPath = process.argv[2]
  if (!outputPath) throw new Error("Usage: app-harness.ts <output-path>")
  Object.assign(process.env, sourceSuiteEnvironment())
  const { collectProbeRun } = await import("terminfo.dev/src/serve.ts")
  const run = await collectProbeRun()
  writeFileSync(outputPath, `${JSON.stringify(run, null, 2)}\n`, { flag: "wx" })
  writeFileSync(`${outputPath}.done`, "", { flag: "wx" })
}

await main()
