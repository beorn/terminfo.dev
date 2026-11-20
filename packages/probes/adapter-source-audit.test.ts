/**
 * @failure The declared adapter-source cohorts drift from the Termless source the pin runs, so every
 *   collection at that pin emits [unaudited-adapter-sources] and no one reads it (#33939).
 * @level l1
 * @consumer ADAPTER_SOURCE_AUDITS in packages/probe-defs/src/helpers.ts
 * @reach fs-walk vendor/termless/**
 * @testonly none
 */
import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { expect, test } from "vitest"
import { ADAPTER_SOURCE_AUDITS } from "../probe-defs/src/helpers.ts"
import { OWNED_LAYOUT } from "./fixtures/owned-layout.fixture.ts"
import { owningCheckout } from "./termless-root.ts"

/** The cohort each rebuilt engine must equal at the Termless pin the workspace carries (#33939). */
const pinnedCohorts = {
  xtermjs: "xtermjsAt74b5c9c8",
  vt100: "vt100At74b5c9c8",
  vt220: "vt220At74b5c9c8",
  vterm: "vtermAt74b5c9c8",
  // A termless bump that changed these blobs once dropped nine kitty rows to probe-todo unnoticed (34051).
  kitty: "kitty3da7fd0e",
} as const satisfies Record<string, keyof typeof ADAPTER_SOURCE_AUDITS>

function blobOid(checkout: string, path: string): string {
  return execFileSync("git", ["-C", checkout, "hash-object", path], { encoding: "utf8" }).trim()
}

// Standalone component CI resolves the published @termless packages instead of the owned checkout, so
// only the owned layout can answer which source the pin runs; there the pin itself is not present.
test.runIf(OWNED_LAYOUT).each(Object.entries(pinnedCohorts))(
  "the %s cohort is the source the pinned Termless serves",
  (engine, cohort) => {
    const declared = ADAPTER_SOURCE_AUDITS[cohort] as Record<string, string>
    const paths = Object.keys(declared)
    expect(paths.length).toBeGreaterThan(0)
    const checkout = owningCheckout(fileURLToPath(import.meta.resolve(`@termless/${engine}`)), `@termless/${engine}`)
    for (const path of paths) {
      expect(`${path}@${blobOid(checkout, path)}`).toBe(`${path}@${declared[path]}`)
    }
  },
)
