/** Explicit private erase capture/assertion run; does not change the all-engine diagnostic suite. */
import { dirname, join } from "node:path"
import { mkdirSync, mkdtempSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { defineConfig } from "vitest/config"
import CensusReporter from "../admin/reporter.ts"
import { checkoutInlineDeps, terminfoCheckoutAliases } from "../../scripts/checkout-alias.ts"
import { ERASE_REPLAY_ROOT } from "./erase-store.ts"

const root = join(dirname(fileURLToPath(import.meta.url)), "../..")

export default defineConfig(() => {
  mkdirSync(ERASE_REPLAY_ROOT, { recursive: true })
  const directory = mkdtempSync(join(ERASE_REPLAY_ROOT, "report-"))
  return {
    resolve: { alias: terminfoCheckoutAliases(root) },
    test: {
      attachmentsDir: join(directory, "vitest-attachments"),
      include: ["packages/probes/erase-replay.probe.ts"],
      reporters: ["default", new CensusReporter(directory)],
      server: { deps: { inline: checkoutInlineDeps(root) } },
    },
  }
})
