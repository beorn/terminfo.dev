/** Explicit private erase capture/assertion run; does not change the all-engine diagnostic suite. */
import { join } from "node:path"
import { mkdirSync, mkdtempSync } from "node:fs"
import { defineConfig } from "vitest/config"
import CensusReporter from "../admin/reporter.ts"
import { ERASE_REPLAY_ROOT } from "./erase-store.ts"
export default defineConfig(() => {
  mkdirSync(ERASE_REPLAY_ROOT, { recursive: true })
  const directory = mkdtempSync(join(ERASE_REPLAY_ROOT, "report-"))
  return {
    test: {
      attachmentsDir: join(directory, "vitest-attachments"),
      include: ["packages/probes/erase-replay.probe.ts"],
      reporters: ["default", new CensusReporter(directory)],
    },
  }
})
