/**
 * A content root for tests that need a real round after the old runs leave `content/` (#30764 M4).
 *
 * The probes, receipts and interpretations are checked-in copies of what the round contained on
 * 2026-10-22 (the three probes folders, `receipts/`, `interpretations.json`); everything the delete KEEPS —
 * suites, categories, features, baselines, the curated catalogs — is copied live from `content/`, so a
 * fixture never drifts from the shipped catalogs. One temporary root per process.
 */
import { cpSync, mkdirSync, mkdtempSync, readdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const REPO = join(import.meta.dirname, "..")
const FIXTURES = import.meta.dirname
const RUN_FOLDERS = ["probes-apps", "probes-libs", "probes-mux"] as const
/** Generated or deleted by the round itself; a fixture carries its own pruned copy instead. */
const NOT_COPIED = new Set(["analysis.json", "interpretations.json", ...RUN_FOLDERS, "receipts", "artifacts"])

let cached: string | undefined

export function fixtureContentDir(): string {
  if (cached) return cached
  const dir = mkdtempSync(join(tmpdir(), "terminfo-fixture-content-"))
  for (const entry of readdirSync(join(REPO, "content"))) {
    if (NOT_COPIED.has(entry)) continue
    cpSync(join(REPO, "content", entry), join(dir, entry), { recursive: true })
  }
  for (const folder of RUN_FOLDERS) {
    mkdirSync(join(dir, folder), { recursive: true })
    cpSync(join(FIXTURES, folder), join(dir, folder), { recursive: true })
  }
  cpSync(join(FIXTURES, "receipts"), join(dir, "receipts"), { recursive: true })
  cpSync(join(FIXTURES, "interpretations.json"), join(dir, "interpretations.json"))
  cached = dir
  return dir
}
