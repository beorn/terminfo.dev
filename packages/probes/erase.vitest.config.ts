/** Explicit private erase capture/assertion run; does not change the all-engine diagnostic suite. */
import { isAbsolute } from "node:path"
import { defineConfig } from "vitest/config"
import CensusReporter from "../admin/reporter.ts"
const directory = process.env.TERMINFO_ARTIFACT_ROOT
if (!directory || !isAbsolute(directory)) {
  throw new Error("Set TERMINFO_ARTIFACT_ROOT to an absolute artifact directory for erase capture/replay")
}
export default defineConfig({
  test: {
    include: ["packages/probes/erase-replay.probe.ts"],
    provide: { eraseArtifactRoot: directory },
    reporters: ["default", new CensusReporter(directory)],
  },
})
