/**
 * @failure A group fixture reads a required content directory as an empty set, so a missing or
 *   unreadable probes dir passes a contract that had nothing to measure.
 * @level l0
 * @consumer 28453 group harness adopters (28454); 2026-10-09 @dev/10 review.
 * @reach fs-walk vendor/terminfo.dev/content/probes-apps/ vendor/terminfo.dev/content/probes-mux/ /tmp/group-harness-*
 * @testonly none
 */
import { expect, test } from "vitest"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadGroupRows } from "./group-harness.ts"

function fixture(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "group-harness-"))
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

function writeRun(root: string, dir: string, name: string): void {
  mkdirSync(join(root, dir), { recursive: true })
  writeFileSync(
    join(root, dir, name),
    JSON.stringify({ schemaVersion: 2, runId: name, target: { id: "fixture", version: "1.0.0" }, rawReplies: {} }),
  )
}

test("a required content directory that cannot be read is a loud fault naming the queried path", () => {
  const { root, cleanup } = fixture()
  try {
    expect(() => loadGroupRows(root)).toThrow(/probes-apps/u)
    expect(() => loadGroupRows(root)).toThrow(
      new RegExp(join(root, "probes-apps").replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"),
    )
  } finally {
    cleanup()
  }
})

test("a declared optional directory is excluded with its path and cause, never dropped in silence", () => {
  const { root, cleanup } = fixture()
  try {
    writeRun(root, "probes-apps", "one.json")
    const read = loadGroupRows(root, [{ dir: "probes-apps" }, { dir: "probes-mux", optional: true }])
    expect(read.rows.map((row) => row.file)).toEqual(["probes-apps/one.json"])
    expect(read.excluded).toHaveLength(1)
    expect(read.excluded[0]?.dir).toBe("probes-mux")
    expect(read.excluded[0]?.path).toBe(join(root, "probes-mux"))
    expect(read.excluded[0]?.cause).toContain("ENOENT")
  } finally {
    cleanup()
  }
})

test("the repo's own content loads every default source with no exclusion", () => {
  const root = join(import.meta.dirname, "../../../..")
  const read = loadGroupRows(join(root, "content"))
  expect(read.excluded).toEqual([])
  expect(read.rows.length).toBeGreaterThan(0)
})
