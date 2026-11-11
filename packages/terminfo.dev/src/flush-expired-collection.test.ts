import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, expect, test } from "vitest"
import type { ProbeSuiteManifest } from "../../probe-defs/src/types.ts"
import { parseProbeResults, parseRun } from "../../run-parser/src/index.ts"
import { collectionIds, rowsFromDraft, startedIdFromLog, writeExpiredCollection } from "./flush-expired-collection.ts"

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
  expect(
    collectionIds("null", join(dirname(fileURLToPath(import.meta.url)), "../../../content")).length,
  ).toBeGreaterThan(0)
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
    collectorDurationMs: number
    results: { featureId: string; harnessOutcome?: string }[]
  }
  expect(run).not.toHaveProperty("suiteComplete")
  expect(run.collectorDurationMs).toBe(1_016_000)
  expect(run.results[0]).toEqual(finished)
  expect(run.results.slice(1)).toEqual([
    expect.objectContaining({ featureId: "charsets.dec-line-drawing", harnessOutcome: "killed-mid-probe" }),
    expect.objectContaining({ featureId: "editing.decrqcra", harnessOutcome: "never-started" }),
  ])
  expect(parseProbeResults(run.results, path, new Set(ids), {}, [])).toHaveLength(3)
})

// @cto 3268e73a (2026-11-10): one writer-to-parser test for the two failures that day — the parser rejected
// collectorDurationMs on a finished run, and the expired flush was checked row by row, never as a whole run.
test("finished and expired collection documents with collectorDurationMs pass the run parser", () => {
  const ids = ["modes.cursor.shape", "charsets.dec-line-drawing", "editing.decrqcra"]
  const suite = "3304833048aa"
  const manifest: ProbeSuiteManifest = {
    schemaVersion: 4,
    probeHash: suite,
    adapterVersion: "3.3.1",
    generatedAt: "2026-11-10T17:00:00.000Z",
    catalogIds: ids,
    probes: { term: ids, lib: [], mux: [] },
  }
  const envelope = {
    schemaVersion: 4,
    source: { kind: "live" },
    runId: "flush-33048",
    suiteId: suite,
    probeHash: suite,
    sourceRevision: "4".repeat(40),
    intendedSubject: { kind: "term", id: "terminal-app" },
    subject: {
      kind: "term",
      id: "terminal-app",
      version: "2.14",
      os: "macos",
      osVersion: null,
      outerTerminal: null,
      mux: null,
      config: null,
      permissions: null,
    },
    identity: "unverified",
    measuredAt: "2026-11-10T17:00:00.000Z",
    origin: { kind: "collector" },
    rawReplies: {},
    assertions: [],
    screenshotRefs: [],
  }
  const suites = new Map([[suite, manifest]])
  const todo = (featureId: string) => ({ ...finished, featureId })

  // Finished: serve.ts sets collectorDurationMs on the run it checkpoints.
  const done = { ...envelope, results: ids.map(todo), collectorDurationMs: 1_016_000 }
  expect(parseRun("finished.json", JSON.stringify(done), ids, suites).collectorDurationMs).toBe(1_016_000)

  // Expired: the real flush writer over the collector's envelope, one row killed mid-probe, one never started.
  const dir = mkdtempSync(join(tmpdir(), "flush-33048-"))
  roots.push(dir)
  const path = join(dir, "run.json")
  writeExpiredCollection(path, {
    ids,
    existing: { ...envelope, results: [todo(ids[0]!)] },
    startedId: ids[1],
    collectorDurationMs: 1_016_000,
  })
  const loaded = parseRun(path, readFileSync(path, "utf8"), ids, suites)
  expect(loaded.collectorDurationMs).toBe(1_016_000)
  expect(loaded.results?.map((row) => [row.featureId, (row as { harnessOutcome?: string }).harnessOutcome])).toEqual([
    [ids[0], undefined],
    [ids[1], "killed-mid-probe"],
    [ids[2], "never-started"],
  ])
})
