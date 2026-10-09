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
import {
  contractGaps,
  loadGroupRows,
  requireStoredObservation,
  storedObservation,
  type NamedUnavailable,
} from "./group-harness.ts"

function fixture(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "group-harness-"))
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

function writeRun(root: string, dir: string, name: string, body: Record<string, unknown> = {}): void {
  mkdirSync(join(root, dir), { recursive: true })
  writeFileSync(
    join(root, dir, name),
    JSON.stringify({
      schemaVersion: 2,
      runId: name,
      target: { id: "fixture", version: "1.0.0" },
      rawReplies: {},
      ...body,
    }),
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

test("the repo's own content loads every default source, and every exclusion is a NAMED non-v2 run", () => {
  const root = join(import.meta.dirname, "../../../..")
  const read = loadGroupRows(join(root, "content"))
  // No required source silently read as empty: the default sources exist and load.
  expect(read.rows.length).toBeGreaterThan(0)
  // The repo genuinely carries legacy non-v2 runs (e.g. content/probes-mux/screen-4.00.03-macos.json),
  // so they are excluded BY NAME - never skipped in silence. No source was absent/unreadable.
  expect(read.excluded.every((entry) => entry.cause.includes("schemaVersion"))).toBe(true)
  expect(read.excluded.every((entry) => entry.cause.includes("not 2"))).toBe(true)
})

test("a non-v2 run is NAMED in excluded, never skipped in silence", () => {
  const { root, cleanup } = fixture()
  try {
    writeRun(root, "probes-apps", "ok.json")
    writeRun(root, "probes-apps", "legacy.json", { schemaVersion: 1 })
    const read = loadGroupRows(root, [{ dir: "probes-apps" }])
    expect(read.rows.map((row) => row.file)).toEqual(["probes-apps/ok.json"])
    expect(read.excluded.map((entry) => entry.path)).toContain(join(root, "probes-apps", "legacy.json"))
    expect(read.excluded[0]?.cause).toContain("schemaVersion 1")
  } finally {
    cleanup()
  }
})

test("a stored observation is read by featureId, and a required missing id is loud", () => {
  const { root, cleanup } = fixture()
  try {
    writeRun(root, "probes-apps", "obs.json", {
      observations: [{ featureId: "sgr.bold", outcome: "supported", note: "parser-state" }],
    })
    const [row] = loadGroupRows(root, [{ dir: "probes-apps" }]).rows
    expect(row, "the run loaded").toBeDefined()
    if (!row) return
    expect(storedObservation(row, "sgr.bold")).toEqual({ outcome: "supported", note: "parser-state" })
    expect(storedObservation(row, "sgr.faint")).toBeUndefined()
    expect(() => requireStoredObservation(row, "sgr.faint")).toThrow(/sgr\.faint/u)
    expect(() => requireStoredObservation(row, "sgr.faint")).toThrow(/obs\.json/u)
  } finally {
    cleanup()
  }
})

test("contractGaps names a catalog-only id, unless the spec declares it named-unavailable", () => {
  const probes = [{ id: "group.bound" }, { id: "group.other" }] as never
  const contract = [{ id: "group.bound", expected: "decided", claim: "bound" }] as never
  const withCatalog = [...(contract as Array<{ id: string }>), { id: "group.catalog-only" }] as never
  expect(contractGaps(probes, withCatalog).unknown).toEqual(["group.catalog-only"])
  const unavailable: NamedUnavailable[] = [
    { id: "group.catalog-only", reason: "no-semantic-observable", noObservable: "no definition in the frozen suite" },
  ]
  expect(contractGaps(probes, withCatalog, unavailable).unknown).toEqual([])
  expect(contractGaps(probes, withCatalog, unavailable).misdeclared).toEqual([])
  // a declared-unavailable id that DOES have a probe is a contradiction
  const bad: NamedUnavailable[] = [{ id: "group.bound", reason: "no-semantic-observable", noObservable: "x" }]
  expect(contractGaps(probes, withCatalog, bad).misdeclared).toEqual(["group.bound"])
})
