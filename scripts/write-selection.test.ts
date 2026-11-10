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
            subject: { id: "screen", version: "5.0.2" },
            measuredAt: "2026-11-10T15:32:47.000Z",
            suiteId: "99ceae876abc",
          },
          result: { status: "supported" },
        },
        "sgr.bold": {
          origin: { runId: "working-run", resultId: "sgr.bold" },
          run: {
            subject: { id: "screen", version: "5.0.2" },
            measuredAt: "2026-11-10T16:00:00.000Z",
            suiteId: "99ceae876abc",
          },
          result: { status: "probe-todo" },
        },
      },
    },
  },
} as unknown as SelectedProjection

test("a cell from a working run is marked working and a placed cell is not", () => {
  expect(selectionFile(projection, new Set(["working-run"]))).toEqual({
    cells: [
      {
        featureId: "sgr.bold",
        status: "probe-todo",
        terminalId: "screen",
        version: "5.0.2",
        measuredAt: "2026-11-10T16:00:00.000Z",
        suiteId: "99ceae876abc",
        runId: "working-run",
        source: "working",
      },
      {
        featureId: "sgr.reset",
        status: "supported",
        terminalId: "screen",
        version: "5.0.2",
        measuredAt: "2026-11-10T15:32:47.000Z",
        suiteId: "99ceae876abc",
        runId: "placed-run",
        source: "placed",
      },
    ],
  })
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
