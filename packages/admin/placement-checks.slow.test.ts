/**
 * #37245: placement's downgrade check on real corpus data. Each case builds a small corpus of one app's placed runs
 * (everything else symlinked from content/, rows of the two cross-checked files kept for that app), so the site's own
 * projection runs over real readings in seconds rather than the whole corpus.
 *
 * Case 1 (must refuse): Warp hosted run 44792556294 (fixture, sha256 0ccbcf10…5c4e) over the placed Warp macOS
 * readings: the projection serves 79 decided cells that would become undecided. Case 3 (must place): the Cursor
 * 3.30.14 cohort run de27164b over the other placed Cursor 3.30.14 macOS readings: 0 downgrades, same context served.
 *
 * @failure  a placement that downgrades served cells goes through silently, or a harmless partial run is refused
 * @level    l3
 * @consumer #37245 placement refusals: the 79-cell Warp downgrade of hosted run 44792556294
 * @reach    fs-walk vendor/terminfo.dev/content/**
 * @testonly none
 */
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { gunzipSync } from "node:zlib"
import { afterEach, expect, test, vi } from "vitest"
import { parseRun, parseSuiteManifest, type LoadedRun } from "@terminfo/run-parser"
import { loadFeatures } from "@terminfo/catalog"
import { CONTENT_DIR } from "./corpus-placement.ts"
import { checkDowngrades, placementDowngrades } from "./placement-checks.ts"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..")
const APPS = join(CONTENT_DIR, "probes-apps")
const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** A corpus holding only `runs` of app `id`; the files that cross-check other apps' runs keep only rows of `id`. */
function corpusOf(id: string, runs: readonly string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "placement-37245-"))
  dirs.push(dir)
  for (const name of readdirSync(CONTENT_DIR)) {
    if (name === "probes-apps" || name === "probes-mux" || name === "probes-libs") mkdirSync(join(dir, name))
    else if (name === "reopened-cells.json" || name === "declared-untestable.json") {
      const doc = JSON.parse(readFileSync(join(CONTENT_DIR, name), "utf8")) as { rows: Array<{ id: string }> }
      writeFileSync(join(dir, name), JSON.stringify({ ...doc, rows: doc.rows.filter((row) => row.id === id) }))
    } else symlinkSync(join(CONTENT_DIR, name), join(dir, name))
  }
  for (const run of runs) symlinkSync(run, join(dir, "probes-apps", basename(run)))
  return dir
}

function loadRun(path: string, text: string = readFileSync(path, "utf8")): LoadedRun {
  const suites = new Map(
    readdirSync(join(CONTENT_DIR, "suites")).map((file) => {
      const manifest = parseSuiteManifest(file, readFileSync(join(CONTENT_DIR, "suites", file), "utf8"))
      return [manifest.probeHash, manifest] as const
    }),
  )
  return parseRun(path, text, Object.keys(loadFeatures(CONTENT_DIR)), suites)
}

const placedRuns = (prefix: string) =>
  readdirSync(APPS)
    .filter((name) => name.startsWith(prefix))
    .map((name) => join(APPS, name))

test("a hosted Warp run that would turn 79 served decided cells undecided is refused, naming the count", () => {
  const text = gunzipSync(readFileSync(join(ROOT, "packages/admin/fixtures/warp-44792556294-run.json.gz"))).toString(
    "utf8",
  )
  const run = loadRun("warp-44792556294-run.json", text)
  // The candidate descends from the placed reading's revision, so the projection's lineage pick takes it:
  // without this the test would not exercise the pick at all (@dev/luna3 case 1).
  expect(run.sourceRevision).toBe("92abecb3fccfc624ef1d35a7040612b879d75aa7")
  execFileSync("git", ["merge-base", "--is-ancestor", "c4b53b5f", run.sourceRevision], { cwd: ROOT })

  // The projection names, on stderr, a placed harness row it keeps over a changed probe; that note is not this test's.
  const notes = vi.spyOn(console, "error").mockImplementation(() => {})
  const report = placementDowngrades(run, corpusOf("warp", placedRuns("warp-v0.2026.10.14.08.27.stable_01-macos-")))
  notes.mockRestore()

  expect(report.downgrades).toHaveLength(79)
  expect(report.flips).toEqual([])
  expect(report.downgrades.slice(0, 2)).toEqual([
    { featureId: "charsets.dec-line-drawing", was: "supported", now: "probe-invalid" },
    { featureId: "charsets.dec-special", was: "supported", now: "probe-invalid" },
  ])
  expect(() => checkDowngrades("warp-run.json", report)).toThrow(
    /would turn 79 decided cell\(s\) of term:warp@macos undecided .*--accept-downgrades 79 --reason/,
  )
  expect(() =>
    checkDowngrades("warp-run.json", report, { count: 79, reason: "probe rework under review" }),
  ).not.toThrow()
}, 120_000)

test("a Cursor cohort run that selected 3 rows cannot displace the complete reading: 0 downgrades, same context", () => {
  const cohort = join(APPS, "cursor-3.30.14-macos-de27164be0a33da9b19859de868e93e2.json")
  const corpus = corpusOf(
    "cursor",
    placedRuns("cursor-3.30.14-macos-").filter((path) => path !== cohort),
  )

  const report = placementDowngrades(loadRun(cohort), corpus)

  expect(report.downgrades).toEqual([])
  expect(report.after).toBe(report.before)
  expect(() => checkDowngrades(cohort, report)).not.toThrow()
}, 120_000)
