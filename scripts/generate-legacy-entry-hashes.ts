/**
 * Generator for content/legacy-entry-hashes.json (33587, @cto d7ad1307 option a, d805d1af).
 *
 *   bun scripts/generate-legacy-entry-hashes.ts <suite-id> <detached checkout of the runs' sourceRevision>
 *
 * Refuses unless every placed run on <suite-id> recorded the checkout's HEAD as its sourceRevision, the suite's
 * committed manifest records no entry hashes of its own, and the checkout's own probeSuiteSnapshot recomputes
 * <suite-id> exactly, so a reconstructed hash is tied to the tree the runs came from. Entry hashes use this tree's loadFeatureEntryHashes over that checkout's
 * content/, so they compare with current manifests. The build never runs this; delete it with the file.
 */
import { execFileSync } from "node:child_process"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { loadFeatureEntryHashes, loadFeatures } from "../packages/catalog/src/index.ts"
import { loadStoredRuns } from "../packages/admin/corpus-placement.ts"
import { parseSuiteManifest } from "../packages/run-parser/src/index.ts"
import { LEGACY_ENTRY_HASHES_FILE, type LegacyEntryHashes } from "../docs/data/legacy-entry-hashes.ts"

const [suiteId, tree] = process.argv.slice(2)
if (!suiteId || !tree) throw new Error("usage: generate-legacy-entry-hashes.ts <suite-id> <checkout>")
const sourceRevision = execFileSync("git", ["-C", tree, "rev-parse", "HEAD"], { encoding: "utf8" }).trim()
if (execFileSync("git", ["-C", tree, "status", "--porcelain"], { encoding: "utf8" }).trim() !== "") {
  throw new Error(`${tree} is dirty; a reconstructed hash needs the committed tree`)
}
const content = join(import.meta.dirname, "..", "content")
const manifestPath = join(content, "suites", `${suiteId}.json`)
if (!existsSync(manifestPath)) throw new Error(`${manifestPath}: no committed manifest for ${suiteId}; refusing`)
if (parseSuiteManifest(manifestPath, readFileSync(manifestPath, "utf8")).catalogEntrySha256 !== undefined) {
  throw new Error(`${manifestPath} records its own entry hashes; a reconstructed row would be a second answer`)
}
const placed = loadStoredRuns(content, Object.keys(loadFeatures(content))).filter((run) => run.probeHash === suiteId)
if (placed.length === 0) throw new Error(`no placed run uses suite ${suiteId}; nothing needs its hashes`)
const foreign = placed.filter((run) => run.sourceRevision !== sourceRevision)
if (foreign.length > 0) {
  throw new Error(
    `placed runs ${foreign.map((run) => `${run.runId} (${run.sourceRevision})`).join(", ")} on ${suiteId} were not ` +
      `measured from ${sourceRevision}; refusing`,
  )
}
const { probeSuiteSnapshot } = (await import(join(tree, "packages/admin/versions.ts"))) as {
  probeSuiteSnapshot: (root: string) => { probeHash: string; catalogIds: string[] }
}
const snapshot = probeSuiteSnapshot(tree)
if (snapshot.probeHash !== suiteId) {
  throw new Error(`${tree} at ${sourceRevision} recomputes suite ${snapshot.probeHash}, not ${suiteId}; refusing`)
}
const catalogEntrySha256 = loadFeatureEntryHashes(join(tree, "content"))
if (JSON.stringify(Object.keys(catalogEntrySha256).sort()) !== JSON.stringify([...snapshot.catalogIds].sort())) {
  throw new Error(`${suiteId}: entry hashes do not cover exactly the suite's catalogue`)
}
const path = join(import.meta.dirname, "..", LEGACY_ENTRY_HASHES_FILE)
const file = (existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {}) as LegacyEntryHashes
file[suiteId] = {
  sourceRevision,
  generatedBy: `bun scripts/generate-legacy-entry-hashes.ts ${suiteId} <detached checkout of ${sourceRevision}>`,
  generatedOn: new Date().toISOString().slice(0, 10),
  catalogEntrySha256,
}
writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`)
console.log(`${suiteId}: ${Object.keys(catalogEntrySha256).length} rows from ${sourceRevision}`)
