/**
 * #37245: placement's downgrade check on real corpus data. Each case builds a small corpus of one app's placed runs
 * (everything else symlinked from content/, rows of the two cross-checked files kept for that app), so the site's own
 * projection runs over real readings in seconds rather than the whole corpus.
 *
 * Case 1 (must refuse): Warp hosted run 44792556294 (fixture, sha256 0ccbcf10…5c4e) over the original Warp macOS
 * readings pinned below: the projection serves 78 decided cells that would become undecided. Case 3 (must place): the Cursor
 * 3.30.14 cohort run de27164b over the other placed Cursor 3.30.14 macOS readings: 0 downgrades, same context served.
 *
 * @failure  a placement that downgrades served cells goes through silently, or a harmless partial run is refused
 * @level    l3
 * @consumer #37245 placement refusals: the 78-cell Warp downgrade of hosted run 44792556294
 * @reach    fs-walk vendor/terminfo.dev/content/**
 * @testonly none
 */
import { execFileSync } from "node:child_process"
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
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
  // raw-delete-allow: dirs holds only this test's own mkdtemp fixture directories
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** A corpus holding only `runs` of app `id`; the files that cross-check other apps' runs keep only rows of `id`. */
function corpusOf(id: string, runs: readonly string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "placement-37245-"))
  dirs.push(dir)
  for (const name of readdirSync(CONTENT_DIR)) {
    if (name === "probes-apps" || name === "probes-mux" || name === "probes-libs") mkdirSync(join(dir, name))
    else if (name === "reopened-cells.json" || name === "declared-untestable.json") {
      const doc = JSON.parse(readFileSync(join(CONTENT_DIR, name), "utf8")) as {
        rows: Array<{ id: string; replacesInvalid?: { runs: string[] } }>
      }
      // A row that replaces PROBE INVALID from named runs (#33774) belongs to a corpus holding one of those runs; this
      // snapshot of placed readings predates them, so such a row did not exist for it.
      const held = (row: { replacesInvalid?: { runs: string[] } }) =>
        row.replacesInvalid === undefined || row.replacesInvalid.runs.some((r) => runs.some((path) => path.includes(r)))
      writeFileSync(
        join(dir, name),
        JSON.stringify({ ...doc, rows: doc.rows.filter((row) => row.id === id && held(row)) }),
      )
    } else symlinkSync(join(CONTENT_DIR, name), join(dir, name))
  }
  for (const run of runs) symlinkSync(realpathSync(run), join(dir, "probes-apps", basename(run)))
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

test("a hosted Warp run that would turn 78 served decided cells undecided is refused, naming the count", () => {
  const text = gunzipSync(readFileSync(join(ROOT, "packages/admin/fixtures/warp-44792556294-run.json.gz"))).toString(
    "utf8",
  )
  const run = loadRun("warp-44792556294-run.json", text)
  // The candidate descends from the placed reading's revision, so the projection's lineage pick takes it:
  // without this the test would not exercise the pick at all (@dev/luna3 case 1).
  expect(run.sourceRevision).toBe("92abecb3fccfc624ef1d35a7040612b879d75aa7")
  execFileSync("git", ["merge-base", "--is-ancestor", "c4b53b5f", "92abecb3fccfc624ef1d35a7040612b879d75aa7"], {
    cwd: ROOT,
  })

  // The projection names, on stderr, a placed harness row it keeps over a changed probe; that note is not this test's.
  const notes = vi.spyOn(console, "error").mockImplementation(() => {})
  // These are the placed readings at d4d03fb0c that defined the #37245 fixture. Later placements change the served count.
  const warpRunIds = [
    "212a517ee8174ce0dc4b30d203615f31",
    "41ab1e8a4a9bf9c0e92f66af36479f39",
    "425b133dbb0e3c63e2b92d0118fff092",
    "5743e0c5f2d769deb4b746986c6b2901",
    "5fa98ad6f3d36a4036bbd1b01a51c428",
    "70c9b987db24a7ce69b4e85b9077df39",
    "8f9b407091f636190ab1807e08e54685",
    "b08f8f3df87e900215bb5355b0cd90ea",
    "b2af2bee53143f15d87b57503cfc0d57",
    "b87c3607dc208be956f61bf6424b796b",
    "bacc74c09a1228e3933fa0be8dfd6220",
    "eb336bbb11e439dbd7f2e884cb41c234",
    "fa54b2e2b75ef4692be6c996cabfa700",
  ]
  const warpRuns = warpRunIds.map((id) => join(APPS, `warp-v0.2026.10.14.08.27.stable_01-macos-${id}.json`))
  const report = placementDowngrades(run, corpusOf("warp", warpRuns))
  notes.mockRestore()

  expect(report.downgrades).toHaveLength(78)
  // #39009: SGR 59 needs its own observation. The SGR 58 result cannot supply a decision for it.
  expect(report.downgrades.map(({ featureId }) => featureId)).not.toContain("sgr.underline-color-reset")
  expect(report.flips).toEqual([])
  expect(report.downgrades.slice(0, 2)).toEqual([
    { featureId: "charsets.dec-line-drawing", was: "supported", now: "probe-invalid" },
    { featureId: "charsets.dec-special", was: "supported", now: "probe-invalid" },
  ])
  expect(() => checkDowngrades("warp-run.json", report)).toThrow(
    /would turn 78 decided cell\(s\) of term:warp@macos undecided .*--accept-downgrades 78 --reason/,
  )
  expect(() =>
    checkDowngrades("warp-run.json", report, { count: 78, reason: "probe rework under review" }),
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

test("a trimmed run is refused by the run parser, before any downgrade comparison (case 4)", () => {
  const text = gunzipSync(readFileSync(join(ROOT, "packages/admin/fixtures/warp-44792556294-run.json.gz"))).toString(
    "utf8",
  )
  const run = JSON.parse(text) as { results: unknown[] }
  run.results.pop()
  // placeCheckedRun parses through prepareCollectedRun first, so this refusal precedes placementDowngrades.
  expect(() => loadRun("trimmed-run.json", JSON.stringify(run))).toThrow(
    "results differ from frozen catalogue membership",
  )
}, 120_000)
