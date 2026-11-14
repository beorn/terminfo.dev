/**
 * @failure The window-basis table drifts from the retained traces — a cell is admitted for a pre-seed
 *   or a restore target nobody derived, and the drift only shows up mid-run as a ledger refusal that
 *   stops everything (@dev/brain e1b6910e1 review 2).
 * @level l1
 * @consumer 34148 folds 2 and 3: the generated admission table.
 * @reach none
 * @testonly none
 */
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { describe, expect, test } from "vitest"

const ROOT = fileURLToPath(new URL("../../../../", import.meta.url))

describe("window basis table (#34148)", () => {
  test("the committed table is what the generator produces from the traces", () => {
    const run = spawnSync("bun", ["scripts/generate-window-basis-table.ts", "--check"], {
      cwd: ROOT,
      encoding: "utf8",
    })
    expect(run.stderr, "run bun scripts/generate-window-basis-table.ts and commit the result").not.toContain("is stale")
    expect(run.status, "the generator's --check exits 0").toBe(0)
  }, 30_000)
})
