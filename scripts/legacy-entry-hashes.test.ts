/**
 * @failure A reconstructed entry hash outlives its use or shadows a recorded one, so a row is judged by a stale
 *   criterion and the file never shrinks to deletion.
 * @level l2
 * @consumer Site per-row context join (app-cells.ts via legacy-entry-hashes.ts suiteEntryHashes)
 * @testonly none
 * @reach fs-walk vendor/terminfo.dev/content/**
 */
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import { loadFeatures } from "../packages/catalog/src/index.ts"
import { loadStoredRuns } from "../packages/admin/corpus-placement.ts"
import { loadLegacyEntryHashes, suiteEntryHashes } from "../docs/data/legacy-entry-hashes.ts"

const content = join(import.meta.dirname, "..", "content")
const legacy = loadLegacyEntryHashes(content)

// 33587, @cto d7ad1307 condition 4: the file holds only suites that need it, so it shrinks to nothing.
it("lists no suite whose manifest records its own entry hashes", () => {
  const recorded = readdirSync(join(content, "suites"))
    .filter((name) => name.endsWith(".json"))
    .map((name) => JSON.parse(readFileSync(join(content, "suites", name), "utf8")) as Record<string, unknown>)
    .filter((manifest) => manifest.catalogEntrySha256 !== undefined)
    .map((manifest) => manifest.probeHash as string)
  expect(Object.keys(legacy).filter((suiteId) => recorded.includes(suiteId))).toEqual([])
})

it("lists no suite that no placed run uses, and each listed suite's placed runs share its sourceRevision", () => {
  const runs = loadStoredRuns(content, Object.keys(loadFeatures(content)))
  const placed = new Set(runs.map((run) => run.probeHash))
  expect(Object.keys(legacy).filter((suiteId) => !placed.has(suiteId))).toEqual([])
  const foreign = runs
    .filter((run) => run.probeHash !== null && legacy[run.probeHash] !== undefined)
    .filter((run) => run.sourceRevision !== legacy[run.probeHash as string]?.sourceRevision)
    .map((run) => `${run.runId} on ${run.probeHash}`)
  expect(foreign).toEqual([])
}, 60_000) // loads and validates every placed run (~8 s)

it("refuses a listed suite whose manifest records its own entry hashes when the join reads it", () => {
  const recordedSuite = readdirSync(join(content, "suites"))
    .map((name) => JSON.parse(readFileSync(join(content, "suites", name), "utf8")) as Record<string, unknown>)
    .find((manifest) => manifest.catalogEntrySha256 !== undefined)?.probeHash as string
  const dir = mkdtempSync(join(tmpdir(), "legacy-entry-hashes-"))
  try {
    mkdirSync(join(dir, "suites"))
    copyFileSync(join(content, "suites", `${recordedSuite}.json`), join(dir, "suites", `${recordedSuite}.json`))
    writeFileSync(
      join(dir, "legacy-entry-hashes.json"),
      JSON.stringify({
        [recordedSuite]: { sourceRevision: "x", generatedBy: "x", generatedOn: "x", catalogEntrySha256: {} },
      }),
    )
    expect(() => suiteEntryHashes(dir)(recordedSuite)).toThrow(/is listed but .* records its own entry hashes/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
