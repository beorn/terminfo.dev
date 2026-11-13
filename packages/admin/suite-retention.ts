/**
 * Retain the declaring suite beside the run it measured (33987, @cto ruling C: "the run carries its own manifest
 * and every reader of an unplaced run reads that one").
 *
 * A composed pin may hash to a suite no committed tree defines; that is normal, not a fault. What must hold is that
 * every collection route writes `suites/<probeHash>.json` into its own output directory and names that relative path
 * in its own record (`collection.json` for a headless collection, `pass.json` for an app, hosted or owned-app pass),
 * so every reader of a working run reads the file the producer retained instead of looking in `content/suites`.
 *
 * One writer and one reader-shaped resolver: a missing or misfiled retained declaration refuses by name, and there is
 * no fallback chain, so a run whose suite declaration is absent or disagrees with the capture is never read anyway.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { canonicalJson, parseSuiteManifest } from "@terminfo/run-parser"
import { derivedSuiteManifest, type ProbeSuiteSnapshot } from "./versions.ts"

/** The relative name a collection record carries for its retained declaration. */
const RETAINED_SUITE_RE = /^suites\/[0-9a-f]{12}\.json$/u

/**
 * Write this suite's declaration into the collection's own directory and return the relative name its record must
 * carry. Refuses an existing file (flag `wx`): a collection directory is written once, and a second declaration
 * under the same suite id would be a second trust source.
 */
export function retainSuiteManifest(directory: string, snapshot: ProbeSuiteSnapshot): string {
  const suiteManifest = `suites/${snapshot.probeHash}.json`
  const path = join(directory, suiteManifest)
  const bytes = `${canonicalJson(derivedSuiteManifest(snapshot))}\n`
  const retained = parseSuiteManifest(path, bytes)
  if (retained.probeHash !== snapshot.probeHash) {
    throw new Error(`${path}: retained suite ${retained.probeHash} disagrees with producer suite ${snapshot.probeHash}`)
  }
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, bytes, { flag: "wx" })
  return suiteManifest
}

/**
 * Resolve the declaration a reader was handed: `<collectionDirectory>/suites/<suiteId>.json`. An absent field, a name
 * outside the retained shape, and a missing file each refuse by name — the retained declaration is mandatory and
 * exclusive for a working run that records one.
 */
export function retainedSuiteManifestPath(
  collectionDirectory: string,
  suiteManifest: unknown,
  recordPath: string,
): string {
  if (typeof suiteManifest !== "string" || !RETAINED_SUITE_RE.test(suiteManifest)) {
    throw new Error(
      `${recordPath}: suiteManifest must name suites/<twelve-lowercase-hex-suite-id>.json; got ${JSON.stringify(suiteManifest)}`,
    )
  }
  const path = join(collectionDirectory, suiteManifest)
  if (!existsSync(path)) {
    throw new Error(
      `${recordPath}: retained suite manifest ${path} is absent; a working run is read only through the declaration its producer retained beside it`,
    )
  }
  return path
}
