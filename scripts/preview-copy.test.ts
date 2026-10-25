/**
 * @failure A page template prints build-state commentary as published copy, or prints "No score" on every
 *          row when a cut has no admitted run — the two things the operator flagged on 2026-10-22 (30753).
 * @level l1
 * @consumer the rendered page templates under docs/.
 * @testonly none
 * @reach fs-walk docs/**
 */

import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..")

/**
 * The page templates that render. `docs/api.md` and `docs/release/full-273.md` quote the v3 `message`
 * string on purpose — they document the API's currentRunCount-0 response, not page copy.
 */
const pageTemplates = [
  "docs/index.md",
  "docs/[id].md",
  "docs/[category]/[id].md",
  "docs/baseline/[id].md",
  "docs/compare/[id].md",
  "docs/terminals/[id].md",
]

describe("preview copy (30753)", () => {
  it("renders no build-state sentence and no No score placeholder", () => {
    const offenders = pageTemplates.filter((path) => {
      const text = readFileSync(join(repoRoot, path), "utf8")
      return /'No score'|>No score</.test(text) || text.includes("No current schema-3 runs")
    })
    expect(offenders).toEqual([])
  })

  it("keeps private evidence fixtures out of tracked production pages", () => {
    const result = spawnSync(
      "git",
      [
        "grep",
        "-n",
        "-E",
        "fixtureEvidence|fixture-evidence",
        "--",
        "docs",
        ":(exclude)docs/.vitepress/theme/ResultEvidenceCell.vue",
      ],
      { cwd: repoRoot, encoding: "utf8" },
    )
    expect(result.error).toBeUndefined()
    expect(result.status, result.stderr || result.stdout).toBe(1)
    expect(result.stdout).toBe("")
  })
})
