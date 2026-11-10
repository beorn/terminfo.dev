import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, test } from "vitest"
import {
  COLLECTOR_FLUSH_MARGIN_S,
  collectorPollSeconds,
  writeExpiredCollection,
} from "./flush-expired-collection.ts"

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

test("a collector that outlives the poll leaves the unfinished rows", () => {
  expect(collectorPollSeconds(25 * 60, 113)).toBe(25 * 60 - COLLECTOR_FLUSH_MARGIN_S - 113)
  const dir = mkdtempSync(join(tmpdir(), "flush-33048-"))
  roots.push(dir)
  const path = join(dir, "run.json")
  writeExpiredCollection(path, {
    ids: ["charsets.dec-line-drawing", "editing.decrqcra", "unicode.wrap-boundary"],
    finishedIds: [],
    startedId: "charsets.dec-line-drawing",
    collectorDurationMs: 1_016_000,
  })
  const run = JSON.parse(readFileSync(path, "utf8")) as {
    suiteComplete: boolean
    collectorDurationMs: number
    results: { featureId: string; harness: string }[]
  }
  expect(run.suiteComplete).toBe(false)
  expect(run.collectorDurationMs).toBe(1_016_000)
  expect(run.results).toEqual([
    { featureId: "charsets.dec-line-drawing", harness: "killed-mid-probe" },
    { featureId: "editing.decrqcra", harness: "never-started" },
    { featureId: "unicode.wrap-boundary", harness: "never-started" },
  ])
})
