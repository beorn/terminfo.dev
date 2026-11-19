/**
 * @failure A reconstructed entry hash outlives its use or shadows a recorded one, so a row is judged by a stale
 *   criterion and the file never shrinks to deletion.
 * @level l2
 * @consumer Site per-row context join (app-cells.ts via legacy-entry-hashes.ts suiteEntryHashes and cellEntryHashes)
 * @testonly none
 * @reach fs-walk vendor/terminfo.dev/content/**
 */
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import { loadFeatures } from "../packages/catalog/src/index.ts"
import { loadStoredRuns } from "../packages/admin/corpus-placement.ts"
import { cellEntryHashes, loadLegacyEntryHashes, suiteEntryHashes } from "../docs/data/legacy-entry-hashes.ts"

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
  // 34760: project each run to the three fields this join reads. Retaining every parsed run peaked at 3.7 GiB in
  // one worker, above the 3 GiB worker RSS cap, so the watchdog SIGKILLed the file; the projecting form drops a
  // run as soon as it is summarised.
  const runs = loadStoredRuns(content, Object.keys(loadFeatures(content)), (run) => ({
    runId: run.runId,
    probeHash: run.probeHash,
    sourceRevision: run.sourceRevision,
  }))
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

// #34953 (@cto 34953-retained-manifest-go-1830): the real xterm Linux specimen of Nov 19 01:36Z, suite cc97c723ab1f,
// whose default run and read-allowed run were each validated against the manifest their pass retained. With no
// committed suites/cc97c723ab1f.json the app join saw no entry hash, refused the read-allowed rows and reopened the
// clipboard pair; the selection's cells were unchanged.
const XTERM_SUITE = "cc97c723ab1f"
const XTERM_DEFAULT_RUN = "821362972429016c5b79f63f89701c24"
const XTERM_READ_ALLOWED_RUN = "746b496d58f2c0ec92c6c45b0a189972"
const XTERM_RETAINED = {
  "extensions.osc52-read": "7e7c835256e109bd53fa59458e448e94c7e6816286e803ec664453e0a6b41ff8",
  "extensions.osc52-clipboard": "a97bfbdabe153f959b89987d8c60f697e2601fe43d656f0cc548a14e75fba46d",
}
const retainedByRun = (...runIds: string[]) =>
  new Map(runIds.map((runId) => [runId, { suiteId: XTERM_SUITE, catalogEntrySha256: XTERM_RETAINED }]))
const noDeclaration = () => undefined

it("gives each working run its own retained entry hashes when no committed or legacy declaration exists", () => {
  const lookup = cellEntryHashes(noDeclaration, retainedByRun(XTERM_DEFAULT_RUN, XTERM_READ_ALLOWED_RUN))
  for (const runId of [XTERM_DEFAULT_RUN, XTERM_READ_ALLOWED_RUN]) {
    expect(lookup(XTERM_SUITE, runId)?.["extensions.osc52-read"]).toBe(XTERM_RETAINED["extensions.osc52-read"])
  }
})

it("lends a retained hash to no other run and to no other suite", () => {
  const lookup = cellEntryHashes(noDeclaration, retainedByRun(XTERM_READ_ALLOWED_RUN))
  // A placed or unvalidated run on the same suite borrows nothing from the run that retained the manifest.
  expect(lookup(XTERM_SUITE, XTERM_DEFAULT_RUN)).toBeUndefined()
  expect(lookup(XTERM_SUITE, "placed-run")).toBeUndefined()
  // The retaining run's own cell on a different suite is not answered by this suite's manifest.
  expect(lookup("044c44b73a50", XTERM_READ_ALLOWED_RUN)).toBeUndefined()
})

it("keeps the committed declaration authoritative and refuses a retained record that disagrees with it", () => {
  const committed = (suiteId: string) => (suiteId === XTERM_SUITE ? XTERM_RETAINED : undefined)
  expect(cellEntryHashes(committed, retainedByRun(XTERM_READ_ALLOWED_RUN))(XTERM_SUITE, "placed-run")).toBe(
    XTERM_RETAINED,
  )
  const changed = { ...XTERM_RETAINED, "extensions.osc52-read": "0".repeat(64) }
  const disagreeing = cellEntryHashes(
    committed,
    new Map([[XTERM_READ_ALLOWED_RUN, { suiteId: XTERM_SUITE, catalogEntrySha256: changed }]]),
  )
  expect(() => disagreeing(XTERM_SUITE, XTERM_READ_ALLOWED_RUN)).toThrow(
    /working run 746b496d58f2c0ec92c6c45b0a189972 retained entry hashes that disagree/,
  )
})

it("refuses two working runs whose retained manifests give one suite different entry hashes", () => {
  const changed = { ...XTERM_RETAINED, "extensions.osc52-clipboard": "1".repeat(64) }
  const working = new Map([
    [XTERM_DEFAULT_RUN, { suiteId: XTERM_SUITE, catalogEntrySha256: XTERM_RETAINED }],
    [XTERM_READ_ALLOWED_RUN, { suiteId: XTERM_SUITE, catalogEntrySha256: changed }],
  ])
  expect(() => cellEntryHashes(noDeclaration, working)).toThrow(/retained manifests with different entry hashes/)
})
