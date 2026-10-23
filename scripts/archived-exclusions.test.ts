/**
 * @failure The published exclusion list would silently empty, reorder or lose a duplicate row when the
 *   historical reader that produced it was removed — the site and admin would report "nothing was
 *   excluded" for a corpus that excluded eighty runs.
 * @level l2
 * @consumer api/v3 `exclusions`, admin status and report, the `--admit` projection
 * @testonly none
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { loadArchivedExclusions } from "../docs/data/selected-results.ts"

const content = (rows: unknown): string => {
  const dir = mkdtempSync(join(tmpdir(), "terminfo-archived-exclusions-"))
  writeFileSync(join(dir, "archived-exclusions.json"), JSON.stringify(rows))
  return dir
}

describe("archived assessment exclusions", () => {
  it("keeps the archived rows in file order, duplicates included, rooted at the content dir", () => {
    const dir = content({
      archivedExclusions: [
        { runId: "first", path: "probes-libs/one.json", reason: "identity-no-profile" },
        { runId: "second", path: "probes-apps/two.json", reason: "identity-replies-mismatch" },
        { runId: "first", path: "probes-libs/one.json", reason: "identity-no-profile" },
      ],
    })
    try {
      expect(loadArchivedExclusions(dir)).toEqual([
        { runId: "first", path: join(dir, "probes-libs", "one.json"), reason: "identity-no-profile" },
        { runId: "second", path: join(dir, "probes-apps", "two.json"), reason: "identity-replies-mismatch" },
        { runId: "first", path: join(dir, "probes-libs", "one.json"), reason: "identity-no-profile" },
      ])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("reads an empty archive as a real state, not as a missing one", () => {
    const dir = content({ archivedExclusions: [] })
    try {
      expect(loadArchivedExclusions(dir)).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it.each([
    ["a missing archive", undefined, /missing archived exclusions/],
    ["no row array", { archivedExclusions: "none" }, /archivedExclusions must be an array/],
    [
      "a row without a reason",
      { archivedExclusions: [{ runId: "x", path: "probes-libs/x.json" }] },
      /requires runId and reason/,
    ],
    [
      "an absolute path",
      { archivedExclusions: [{ runId: "x", path: "/content/probes-libs/x.json", reason: "r" }] },
      /path must be relative to the content root/,
    ],
    [
      "a path escaping the root",
      { archivedExclusions: [{ runId: "x", path: "../outside.json", reason: "r" }] },
      /path must be relative to the content root/,
    ],
  ])("refuses %s loudly", (_label, rows, message) => {
    const dir = mkdtempSync(join(tmpdir(), "terminfo-archived-exclusions-"))
    try {
      if (rows !== undefined) writeFileSync(join(dir, "archived-exclusions.json"), JSON.stringify(rows))
      expect(() => loadArchivedExclusions(dir)).toThrow(message)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
