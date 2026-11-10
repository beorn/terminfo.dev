import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, expect, test } from "vitest"
import { parseProbeResults } from "../../run-parser/src/index.ts"
import {
  COLLECTOR_FLUSH_MARGIN_S,
  collectorPollSeconds,
  collectionIds,
  rowsFromDraft,
  startedIdFromLog,
  writeExpiredCollection,
} from "./flush-expired-collection.ts"

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const finished = {
  featureId: "modes.cursor.shape",
  status: "probe-todo",
  reason: "already recorded",
  attempt: { scope: "none" },
  tests: [{ id: "criterion", status: "probe-todo", reason: "already recorded", attempt: { scope: "none" } }],
}

test("a collector that outlives the poll leaves a run the parser accepts", () => {
  expect(collectorPollSeconds(25 * 60, 113)).toBe(25 * 60 - COLLECTOR_FLUSH_MARGIN_S - 113)
  expect(collectionIds("null", join(dirname(fileURLToPath(import.meta.url)), "../../../content")).length).toBeGreaterThan(0)
  const ids = ["modes.cursor.shape", "charsets.dec-line-drawing", "editing.decrqcra"]
  expect(startedIdFromLog("start charsets.dec-line-drawing\nthen editing.decrqcra", ids)).toBe("editing.decrqcra")
  expect(
    rowsFromDraft({
      results: [finished, { featureId: "charsets.dec-line-drawing", attempt: { scope: "probe" }, tests: [] }],
    }).startedId,
  ).toBe("charsets.dec-line-drawing")
  const dir = mkdtempSync(join(tmpdir(), "flush-33048-"))
  roots.push(dir)
  const path = join(dir, "run.json")
  writeExpiredCollection(path, {
    ids,
    existing: { results: [finished] },
    startedId: "charsets.dec-line-drawing",
    collectorDurationMs: 1_016_000,
  })
  const run = JSON.parse(readFileSync(path, "utf8")) as {
    suiteComplete: boolean
    collectorDurationMs: number
    results: { featureId: string; harnessOutcome?: string }[]
  }
  expect(run.suiteComplete).toBe(false)
  expect(run.collectorDurationMs).toBe(1_016_000)
  expect(run.results[0]).toEqual(finished)
  expect(run.results.slice(1)).toEqual([
    expect.objectContaining({ featureId: "charsets.dec-line-drawing", harnessOutcome: "killed-mid-probe" }),
    expect.objectContaining({ featureId: "editing.decrqcra", harnessOutcome: "never-started" }),
  ])
  expect(parseProbeResults(run.results, path, new Set(ids), {}, [])).toHaveLength(3)
})
