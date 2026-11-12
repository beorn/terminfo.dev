import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "vitest"
import type { SelectedProjection } from "../docs/data/selected-results.ts"
import { parseSelectionArgs, refuseOutputUnderContent, selectionFile } from "../docs/data/write-selection.ts"

const projection = {
  contexts: {
    "term:screen": {
      cells: {
        "sgr.reset": {
          origin: { runId: "placed-run", resultId: "sgr.reset" },
          run: {
            subject: { id: "screen", version: "5.0.2", os: "linux" },
            path: "/repo/content/results/term/screen-placed.json",
            measuredAt: "2026-11-10T15:32:47.000Z",
            suiteId: "99ceae876abc",
            probeHash: "99ceae876abc",
          },
          result: { status: "supported" },
        },
        "sgr.bold": {
          origin: { runId: "working-run", resultId: "sgr.bold" },
          run: {
            subject: { id: "screen", version: "5.0.2", os: "linux" },
            path: "/scratch/working-run.json",
            measuredAt: "2026-11-10T16:00:00.000Z",
            suiteId: "0123456789ab",
            probeHash: "0123456789ab",
          },
          result: { status: "probe-todo" },
        },
      },
    },
  },
  treeSuiteId: "99ceae876abc",
} as unknown as SelectedProjection

// 33109: a working run at an older suite carries the site's own label "older suite <hash>" (suiteRelationOf), so the
// map can show it as older; the file had no suite relation before, so the earlier rows could not catch its absence.
test("a cell from a working run is marked working and a placed cell is not; each carries its suite relation", () => {
  expect(selectionFile(projection, new Set(["working-run"]), "/repo/content")).toEqual({
    cells: [
      {
        featureId: "sgr.bold",
        status: "probe-todo",
        terminalId: "screen",
        version: "5.0.2",
        os: "linux",
        context: "term:screen",
        measuredAt: "2026-11-10T16:00:00.000Z",
        suiteId: "0123456789ab",
        suiteRelation: "older",
        suiteFreshness: "older suite 0123456789ab",
        runId: "working-run",
        source: "working",
        contentPath: null,
      },
      {
        featureId: "sgr.reset",
        status: "supported",
        terminalId: "screen",
        version: "5.0.2",
        os: "linux",
        context: "term:screen",
        measuredAt: "2026-11-10T15:32:47.000Z",
        suiteId: "99ceae876abc",
        suiteRelation: "tree",
        suiteFreshness: "tree suite 99ceae876abc",
        runId: "placed-run",
        source: "placed",
        contentPath: "content/results/term/screen-placed.json",
      },
    ],
    outerAbsentRefusals: [],
  })
})

// 33109 row 4: the status map takes every App cell from this file, so a cell a reopened-cells row withdrew (#33164) must
// say so here; the row above has no reopened cell, so it cannot see the marker being dropped.
test("a cell a reopened-cells row withdrew carries that marker into the file", () => {
  const reopened = { reason: "stored grade cannot stand", reopenedOn: "2026-11-10", exit: "remeasure" }
  const cell = projection.contexts["term:screen"]!.cells["sgr.reset"]!
  const withMarker = {
    ...projection,
    contexts: { "term:screen": { cells: { "sgr.reset": { ...cell, reopened } } } },
  } as unknown as SelectedProjection
  const [only] = selectionFile(withMarker, new Set(), "/repo/content").cells
  expect(only).toMatchObject({ featureId: "sgr.reset", reopened })
  expect(selectionFile(projection, new Set(["working-run"]), "/repo/content").cells.some((c) => "reopened" in c)).toBe(
    false,
  )
})

test("a placed cell whose run file is outside content/ is an error, not a guessed path", () => {
  expect(() => selectionFile(projection, new Set(), "/other/content")).toThrow(/not under/)
})

test("--out under content is refused", () => {
  const content = mkdtempSync(join(tmpdir(), "selection-content-"))
  expect(() => refuseOutputUnderContent(join(content, "out.json"), content)).toThrow(/content/)
  expect(() => refuseOutputUnderContent(join(tmpdir(), "selection-out.json"), content)).not.toThrow()
})

test("--out is required and --working-run repeats", () => {
  expect(() => parseSelectionArgs([])).toThrow(/--out is required/)
  const parsed = parseSelectionArgs(["--out", "/tmp/out.json", "--working-run", "a.json", "--working-run", "b.json"])
  expect(parsed.out).toBe("/tmp/out.json")
  expect(parsed.workingRuns).toEqual(["a.json", "b.json"])
  expect(parsed.content).toContain("content")
})
