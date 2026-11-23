import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { expect, test, vi } from "vitest"
import { initializeRunDraft, type CapturedRunDraft } from "@terminfo/probe-defs"
import type { SelectedProjection } from "../docs/data/selected-results.ts"
import {
  appTiers,
  parseSelectionArgs,
  readAsideRows,
  readRunReadInputs,
  refuseOutputUnderContent,
  runReads,
  selectionFile,
  workingRunRecord,
  writeSelection,
} from "../docs/data/write-selection.ts"
import { retainedSuiteManifestPath } from "../packages/admin/suite-retention.ts"
import { CONTENT_DIR } from "../packages/admin/corpus-placement.ts"
import { derivedSuiteManifest, probeSuiteSnapshot } from "../packages/admin/versions.ts"
import { finalizeCollectedDraft } from "../packages/terminfo.dev/src/capture-writer.ts"

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

// #33928: the status page lists every untestable result under its stored reason, so the file carries that reason on
// untestable cells only: the mux-input demotion's reason first, else the run's own, else null (shown as a gap, never dropped).
test("an untestable cell carries its stored reason, the demotion's first; other cells carry none", () => {
  const base = projection.contexts["term:screen"]!.cells["sgr.reset"]!
  const untestable = (result: object, extra: object = {}) =>
    selectionFile(
      {
        ...projection,
        contexts: { "term:screen": { cells: { "sgr.reset": { ...base, result, ...extra } } } },
      } as unknown as SelectedProjection,
      new Set(),
      "/repo/content",
    ).cells[0]!
  expect(untestable({ status: "untestable", reason: " the app owns this command " }).reason).toBe(
    "the app owns this command",
  )
  expect(untestable({ status: "untestable" }).reason).toBe(null)
  const outerAbsent = {
    terminalId: "kitty",
    version: "0.40",
    runId: "outer",
    measured: "unsupported",
    reason: "outer reads Unsupported",
  }
  expect(
    untestable({ status: "unsupported", reason: "own" }, { featureResult: { status: "untestable" }, outerAbsent })
      .reason,
  ).toBe("outer reads Unsupported")
  expect(selectionFile(projection, new Set(["working-run"]), "/repo/content").cells.some((c) => "reason" in c)).toBe(
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

// 33987 (@cto ruling C, @dev/15 delta read): an app, hosted or owned-app pass keeps its runs below its own directory,
// so a reader that looks only beside the raw file never finds the pass that recorded it. It then fell back to the
// committed manifest and silently swapped the run's trust source, or refused naming content/suites as the cure.
function appPass(
  levels: readonly string[],
  record: (raw: string) => unknown = (raw) => ({ contexts: [{ rawRun: raw }] }),
): { raw: string; pass: string; suiteId: string; content: string } {
  const suiteId = "aaaaaaaaaaaa"
  const base = mkdtempSync(join(tmpdir(), "write-selection-app-"))
  const pass = join(base, "pass-abc123")
  const raw = join(pass, ...levels, "raw", "v3-run.json")
  mkdirSync(dirname(raw), { recursive: true })
  writeFileSync(raw, "{}\n")
  mkdirSync(join(pass, "suites"), { recursive: true })
  writeFileSync(join(pass, "suites", `${suiteId}.json`), "{}\n")
  writeFileSync(
    join(pass, "pass.json"),
    JSON.stringify({ suiteManifest: `suites/${suiteId}.json`, ...(record(raw) as object) }),
  )
  return { raw, pass, suiteId, content: join(base, "content") }
}

test.each([
  ["Linux launcher", ["linux", "screen", "run-1"]],
  ["supplement launcher", ["linux", "screen.clipboard-bracketed", "run-1"]],
  ["owned-app launcher", ["owned-app", "screen", "run-1"]],
  // linuxRawRun also keeps an HTTP failure's draft at raw/artifacts/<runId>.draft.json, one level deeper.
  ["failed Linux launcher artifact", ["linux", "screen", "run-1", "raw", "artifacts"]],
] as const)("a %s run is read through the pass that recorded it", (_label, levels) => {
  const { raw, pass, suiteId, content } = appPass(levels)
  const record = workingRunRecord(raw, content)
  expect(record).toEqual({ directory: pass, recordPath: join(pass, "pass.json") })
  // The declaration the reader resolves is the one beside that pass — never content/suites.
  expect(retainedSuiteManifestPath(record!.directory, `suites/${suiteId}.json`, record!.recordPath)).toBe(
    join(pass, "suites", `${suiteId}.json`),
  )
})

// A supplement is recorded as its own row inside the context, so a supplemented run is named one level deeper.
test("a run a pass names only as a supplement is still recorded by that pass", () => {
  const { raw, pass, content } = appPass(["linux", "screen.clipboard-bracketed", "run-1"], (run) => ({
    contexts: [{ rawRun: `${run}.missing`, supplements: [{ name: "clipboard-profile", featureIds: [], rawRun: run }] }],
  }))
  expect(workingRunRecord(raw, content)).toEqual({ directory: pass, recordPath: join(pass, "pass.json") })
})

// A pass up the tree that does not name this run is another collection's: using it would swap the trust source.
test("a pass that names no such run refuses by name instead of falling back to the committed manifest", () => {
  const { raw, content } = appPass(["linux", "screen", "run-1"], () => ({
    contexts: [{ rawRun: "/elsewhere/raw/v3-run.json" }],
  }))
  expect(() => workingRunRecord(raw, content)).toThrow(
    /names no working run .*v3-run\.json; an app run is read through the pass/,
  )
})

// "No record found" is not "placed": only a run inside content/ carries committed trust on its own.
test("an unplaced run its producer recorded nowhere refuses by name instead of taking committed trust", () => {
  const base = mkdtempSync(join(tmpdir(), "write-selection-unplaced-"))
  const raw = join(base, "scratch", "raw", "v3-run.json")
  mkdirSync(dirname(raw), { recursive: true })
  writeFileSync(raw, "{}\n")
  expect(() => workingRunRecord(raw, join(base, "content"))).toThrow(
    /no collection record names this working run and it is not under .*content; an unplaced run is read through the record its producer wrote/,
  )
})

// A placed corpus original carries no collection record: its committed manifest is its own trust source.
test("a placed run under content/ is not given a pass's declaration", () => {
  const base = mkdtempSync(join(tmpdir(), "write-selection-placed-"))
  const content = join(base, "content")
  const raw = join(content, "runs", "screen", "raw", "v3-run.json")
  mkdirSync(dirname(raw), { recursive: true })
  writeFileSync(raw, "{}\n")
  expect(workingRunRecord(raw, content)).toBeUndefined()
})

// A headless collection keeps its record beside the runs it wrote, which is the custody that already worked.
test("a headless run is read through the collection written beside it", () => {
  const base = mkdtempSync(join(tmpdir(), "write-selection-headless-"))
  const raw = join(base, "headless", "screen.draft.json")
  mkdirSync(dirname(raw), { recursive: true })
  writeFileSync(raw, "{}\n")
  writeFileSync(join(dirname(raw), "collection.json"), JSON.stringify({ runs: [raw] }))
  expect(workingRunRecord(raw, join(base, "content"))).toEqual({
    directory: dirname(raw),
    recordPath: join(dirname(raw), "collection.json"),
  })
})

// #37673: the status page shows each terminal's completeness tier twice when they differ: the site's own, and the same
// rule with the results the page defers to a later release set aside. Both come from rollupTerminalStatuses here,
// never from a copy of its rule in the page builder.
test("an app's tiers: the site's rule, then the same rule with the set-aside results left out; aside counts only the open ones it removed", () => {
  const catalog = ["sgr.bold", "sgr.reset", "cursor.shape"]
  const cells = (statuses: string[]) =>
    Object.fromEntries(catalog.map((id, i) => [id, { status: statuses[i] as "supported" }]))
  expect(appTiers(cells(["supported", "unsupported", "untestable"]), catalog, new Set())).toEqual({
    completenessTier: 3,
    asideTier: 3,
    aside: 0,
  })
  expect(appTiers(cells(["supported", "probe-todo", "untestable"]), catalog, new Set(["sgr.reset"]))).toEqual({
    completenessTier: 1,
    asideTier: 3,
    aside: 1,
  })
  expect(appTiers(cells(["probe-invalid", "probe-todo", "supported"]), catalog, new Set(["sgr.reset"]))).toEqual({
    completenessTier: 1,
    asideTier: 2,
    aside: 1,
  })
  // A set-aside result a run has since decided lowers no tier, so it is not counted as set aside.
  expect(
    appTiers(cells(["supported", "probe-todo", "unsupported"]), catalog, new Set(["sgr.reset", "cursor.shape"])),
  ).toEqual({
    completenessTier: 1,
    asideTier: 3,
    aside: 1,
  })
})

test("--aside names a file of {id, os, probe} rows; a malformed row is refused by name", () => {
  expect(parseSelectionArgs(["--out", "/o.json", "--aside", "/aside.json"]).aside).toBe("/aside.json")
  expect(parseSelectionArgs(["--out", "/o.json"]).aside).toBeUndefined()
  const dir = mkdtempSync(join(tmpdir(), "aside-"))
  const good = join(dir, "good.json")
  writeFileSync(good, JSON.stringify([{ id: "terminal-app", os: "macos", probe: "cursor.shape" }]))
  expect(readAsideRows(good)).toEqual(new Set(["terminal-app/macos/cursor.shape"]))
  const bad = join(dir, "bad.json")
  writeFileSync(bad, JSON.stringify([{ id: "terminal-app", probe: "cursor.shape" }]))
  expect(() => readAsideRows(bad)).toThrow(/bad\.json row 0 .*id, os and probe/)
})

// #37686: a status page reads each earlier run alone through the selection's join; the run list is a file, and a run
// with no drafts or a malformed row is refused by name rather than read as an empty run.
test("--run-reads takes a file of {name, drafts} rows and no --working-run or --aside", () => {
  expect(parseSelectionArgs(["--out", "/o.json", "--run-reads", "/runs.json"]).runReads).toBe("/runs.json")
  expect(parseSelectionArgs(["--out", "/o.json"]).runReads).toBeUndefined()
  expect(() => parseSelectionArgs(["--out", "/o.json", "--run-reads", "/r.json", "--working-run", "a.json"])).toThrow(
    /--run-reads reads each run alone/,
  )
  expect(() => parseSelectionArgs(["--out", "/o.json", "--run-reads", "/r.json", "--aside", "/a.json"])).toThrow(
    /--run-reads reads each run alone/,
  )
  const dir = mkdtempSync(join(tmpdir(), "run-reads-"))
  const good = join(dir, "good.json")
  writeFileSync(good, JSON.stringify([{ name: "2026-11-20T08-00", drafts: ["/runs/a/raw/v3-run.draft.json"] }]))
  expect(readRunReadInputs(good)).toEqual([{ name: "2026-11-20T08-00", drafts: ["/runs/a/raw/v3-run.draft.json"] }])
  const notArray = join(dir, "object.json")
  writeFileSync(notArray, JSON.stringify({ name: "x", drafts: [] }))
  expect(() => readRunReadInputs(notArray)).toThrow(/object\.json: --run-reads takes a JSON array/)
  const badRow = join(dir, "bad.json")
  writeFileSync(badRow, JSON.stringify([{ name: "x", drafts: "/one.json" }]))
  expect(() => readRunReadInputs(badRow)).toThrow(/bad\.json: row 0 is not \{name: string, drafts: string\[\]\}/)
  const badDraft = join(dir, "draft.json")
  writeFileSync(badDraft, JSON.stringify([{ name: "x", drafts: [7] }]))
  expect(() => readRunReadInputs(badDraft)).toThrow(/draft\.json: row 0 \(x\) has a draft that is not a path/)
})

test("runReads refuses a run with no drafts before reading any", () => {
  expect(() => runReads({ content: CONTENT_DIR, runs: [{ name: "empty", drafts: [] }] })).toThrow(
    /empty: --run-reads names a run with no drafts/,
  )
})

// #35011 (gap from #34999 review 9b9466f6): prove writeSelection's own retainedEntryHashes call site uses
// sameRunEntryHashes rather than JSON.stringify — one raw run read twice through retained manifests whose
// catalogEntrySha256 keys differ only in order must build, while a different entry hash must refuse naming
// --working-run.
test("writeSelection builds when one working run is read twice through reordered retained manifests, and refuses a hash difference", () => {
  const base = mkdtempSync(join(tmpdir(), "write-selection-35011-"))
  try {
    const content = join(base, "content")
    mkdirSync(content)
    for (const file of ["features.json", "terminals.json"]) {
      copyFileSync(join(CONTENT_DIR, file), join(content, file))
    }
    writeFileSync(join(content, "archived-exclusions.json"), JSON.stringify({ archivedExclusions: [] }))
    writeFileSync(join(content, "reopened-cells.json"), JSON.stringify({ rows: [] }))
    writeFileSync(join(content, "declared-untestable.json"), JSON.stringify({ rows: [] }))
    writeFileSync(join(content, "legacy-entry-hashes.json"), JSON.stringify({}))
    for (const dir of ["probes-apps", "probes-libs", "probes-mux", "suites"]) {
      mkdirSync(join(content, dir))
    }

    const suiteId = "112233445566"
    const liveManifest = derivedSuiteManifest(probeSuiteSnapshot())
    const entryHashes = liveManifest.catalogEntrySha256
    if (entryHashes === undefined) throw new Error("live suite manifest is missing catalogEntrySha256")
    const reversedHashes = Object.fromEntries(Object.entries(entryHashes).reverse())
    const firstFeature = Object.keys(entryHashes)[0]
    if (firstFeature === undefined) throw new Error("live suite manifest has no catalogEntrySha256 keys")
    const differentHashes = { ...entryHashes, [firstFeature]: "0".repeat(64) }
    expect(JSON.stringify(reversedHashes)).not.toBe(JSON.stringify(entryHashes))

    const manifestA = { ...liveManifest, probeHash: suiteId, catalogEntrySha256: entryHashes }
    const manifestB = { ...liveManifest, probeHash: suiteId, catalogEntrySha256: reversedHashes }
    const manifestC = { ...liveManifest, probeHash: suiteId, catalogEntrySha256: differentHashes }

    const subject = {
      kind: "lib" as const,
      id: "xtermjs",
      version: "6.0.0",
      os: "linux",
      osVersion: null,
      outerTerminal: null,
      mux: null,
      config: null,
      permissions: null,
    }
    const draft = initializeRunDraft({
      runId: "35011-reordered-run",
      sourceRevision: "a".repeat(40),
      manifest: manifestA,
      source: { kind: "live" },
      intendedSubject: subject,
    })
    Object.assign(draft, {
      subject,
      identity: "verified",
      measuredAt: "2026-11-23T00:00:00.000Z",
      origin: { kind: "collector" },
      runtimeIdentity: {
        kind: "js",
        adapterVersion: "0.10.2",
        termlessRevision: "4b39770c169ec393cfd6ec7f59110e91c9c9d0c5",
        resolvedPath: "node_modules/@xterm/headless/lib-headless/xterm-headless.js",
        integrity: {
          kind: "registry",
          lockIntegrity:
            "sha512-5Yj1QINYCyzrZtf8OFIHi47iQtI+0qYFPHmouEfG8dHNxbZ9Tb9YGSuLcsEwj9Z+OL75GJqPyJbyoFer80a2Hw==",
        },
        runtimeFormat: "js",
        engineVersion: "6.0.0",
      },
    })
    const runBytes = JSON.stringify(finalizeCollectedDraft(draft as CapturedRunDraft))

    const writePass = (name: string, manifest: object): string => {
      const passDir = join(base, name)
      const rawPath = join(passDir, "headless", "xtermjs.draft.json")
      mkdirSync(dirname(rawPath), { recursive: true })
      mkdirSync(join(passDir, "suites"), { recursive: true })
      writeFileSync(rawPath, runBytes)
      writeFileSync(join(passDir, "suites", `${suiteId}.json`), JSON.stringify(manifest))
      writeFileSync(
        join(passDir, "pass.json"),
        JSON.stringify({ suiteManifest: `suites/${suiteId}.json`, contexts: [{ rawRun: rawPath }] }),
      )
      return rawPath
    }

    const rawA = writePass("pass-a", manifestA)
    const rawB = writePass("pass-b", manifestB)
    const rawC = writePass("pass-c", manifestC)

    const outOk = join(base, "selection-ok.json")
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {})
    let cellCount: number
    try {
      cellCount = writeSelection({ out: outOk, content, workingRuns: [rawA, rawB] })
      expect(cellCount).toBeGreaterThan(0)
      expect(logSpy).toHaveBeenCalledWith(`wrote ${cellCount} cells`)
    } finally {
      logSpy.mockRestore()
    }
    const written = JSON.parse(readFileSync(outOk, "utf8")) as { cells: unknown[]; apps: Record<string, unknown> }
    expect(written.cells.length).toBe(cellCount)
    expect(Object.keys(written.apps).length).toBeGreaterThan(0)

    const outBad = join(base, "selection-bad.json")
    expect(() => writeSelection({ out: outBad, content, workingRuns: [rawA, rawC] })).toThrow(
      /working run 35011-reordered-run was read twice through different retained manifests.*--working-run/,
    )
  } finally {
    // raw-delete-allow: base is an isolated mkdtempSync fixture created by this test.
    rmSync(base, { recursive: true, force: true })
  }
})
