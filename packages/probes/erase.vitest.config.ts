/** Explicit private erase capture/assertion run; does not change the all-engine diagnostic suite. */
import { join } from "node:path"
import { defineConfig } from "vitest/config"
import CensusReporter from "../admin/reporter.ts"
import { ERASE_REPLAY_ROOT } from "./erase-store.ts"
export default defineConfig({
  test: {
    attachmentsDir: join(ERASE_REPLAY_ROOT, "vitest-attachments"),
    include: ["packages/probes/erase-replay.probe.ts"],
    reporters: ["default", new CensusReporter(ERASE_REPLAY_ROOT)],
  },
})
