/**
 * @failure Consumers disagree about admitted runs, unscoped annotations leak into commentary, or malformed metadata silently omits analysis sections.
 * @level l2
 * @consumer Site matrix, terminal paths, v3 API, frozen v1 bytes and generated analysis.
 * @reach fs-walk vendor/terminfo.dev/content/probes-apps/*.json vendor/terminfo.dev/content/probes-libs/*.json vendor/terminfo.dev/content/probes-mux/*.json
 * @testonly none
 */
import type { CapabilityResult, CapabilityStatus } from "@terminfo/probe-defs"
import { describe, expect, it, vi } from "vitest"
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  existsSync,
  mkdirSync,
  writeFileSync,
  cpSync,
  symlinkSync,
  readdirSync,
  statSync,
} from "node:fs"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type {
  CurrentSelectedVersion,
  HistoricalProjection,
  SelectedCell,
  SelectedVersion,
} from "../docs/data/selected-results.ts"
import { aggregateCurrentResults, classifyCells, type CellState } from "../docs/data/release-scope.ts"
import * as selectedResults from "../docs/data/selected-results.ts"
import { publicResults } from "../docs/data/public-results.ts"
import type { HistoricalPublicVersion as PublicVersion } from "../docs/data/public-results.ts"

const fixture = vi.hoisted(() => {
  const runSha256 = "a".repeat(64)
  const measuredAt = "2026-09-28T12:34:56.000Z"
  const target = {
    kind: "app",
    id: "kitty",
    version: "0.46.2",
    os: "macos",
    osVersion: "25.4.0",
    outerTerminal: null,
    mux: null,
    config: null,
    permissions: null,
  }
  const cells = {
    "sgr.bold": {
      featureId: "sgr.bold",
      outcome: "supported",
      evidence: "query",
      conclusive: true,
      note: "unchecked collector note /home/fixture/private",
      record: {
        rawReply: "\u001b[1;2R",
        assertions: [
          { featureId: "sgr.bold", kind: "positive", expected: "STORED_ASSERTION_EXPECTED", observed: "\u001b[1;2R" },
        ],
      },
      chain: {
        origin: { kind: "collector", appLaunch: { bundlePath: "/private/fixture/app" } },
        method: "query",
        runId: "kitty-reviewed",
        runSha256,
      },
    },
    "extensions.sixel": {
      featureId: "extensions.sixel",
      outcome: "unsupported",
      evidence: "behavior",
      conclusive: true,
      record: {
        assertions: [
          { featureId: "extensions.sixel", kind: "negative", expected: "sixel image", observed: "no image" },
        ],
      },
      chain: { origin: { kind: "collector" }, method: "behavior", runId: "kitty-reviewed", runSha256 },
    },
  }
  const selected = {
    schemaVersion: 2,
    runId: "kitty-reviewed",
    target,
    measuredAt,
    suiteId: "suite-v2",
    probeHash: "current",
    suiteFreshness: "current",
    sourceRevision: "rev",
    sha256: runSha256,
    identity: "verified",
    suite: { observed: 2, expected: 2, complete: true },
    cells,
    v1: { "sgr.bold": true, "extensions.sixel": false },
    counts: { catalog: 270, tested: 2, notTested: 268, conclusive: 2, supported: 1, unsupported: 1 },
    ungradedDiagnostics: {
      evidence: "legacy",
      label: "old callback result, unverified",
      results: { "sgr.bold": { kind: "collector-error", name: "PRIVATE_DIAGNOSTIC" } },
    },
    reviews: [
      { id: "kitty-review", reviewer: "reviewer", reason: "exact-run identity checked", sources: ["review://kitty"] },
    ],
  }
  const mux = {
    ...selected,
    runId: "tmux-reviewed",
    sha256: "b".repeat(64),
    suite: { observed: 1, expected: 1, complete: true },
    target: { ...target, kind: "mux", id: "tmux", outerTerminal: "kitty", mux: "tmux" },
    reviews: [
      { id: "tmux-review", reviewer: "reviewer", reason: "exact-run identity checked", sources: ["review://tmux"] },
    ],
    cells: {},
    v1: { "sgr.bold": true },
    counts: { catalog: 270, tested: 1, notTested: 269, conclusive: 1, supported: 1, unsupported: 0 },
  }
  const screen = {
    ...mux,
    runId: "screen-reviewed",
    sha256: "d".repeat(64),
    measuredAt: "2026-09-29T12:34:56.000Z",
    target: { ...mux.target, id: "screen", mux: "screen", version: "5.0" },
    cells: {
      "sgr.bold": {
        ...cells["sgr.bold"],
        outcome: "inconclusive",
        conclusive: false,
        chain: { origin: { kind: "collector" }, method: "query", runId: "screen-reviewed", runSha256: "d".repeat(64) },
      },
    },
    v1: {},
    counts: { catalog: 270, tested: 1, notTested: 269, conclusive: 0, supported: 0, unsupported: 0 },
  }
  const olderScreen = {
    ...selected,
    runId: "screen-older-reviewed",
    sha256: "c".repeat(64),
    suiteFreshness: "older suite (1 probes)",
    target: { ...screen.target, version: "4.9" },
    cells: Object.fromEntries(
      Object.entries(cells).map(([id, cell]) => [
        id,
        {
          ...cell,
          chain: { ...cell.chain, runId: "screen-older-reviewed", runSha256: "c".repeat(64) },
        },
      ]),
    ),
  }
  const alternateKitty = {
    ...selected,
    runId: "kitty-clipboard-reviewed",
    sha256: "e".repeat(64),
    target: { ...target, permissions: "clipboard: read=deny,write=allow" },
    cells: {},
    v1: {},
    counts: { catalog: 270, tested: 0, notTested: 270, conclusive: 0, supported: 0, unsupported: 0 },
  }
  return {
    runSha256,
    measuredAt,
    selected: selected as unknown as SelectedVersion,
    mux: mux as unknown as SelectedVersion,
    screen: screen as unknown as SelectedVersion,
    projection: {
      current: { "app:kitty": selected, "mux:tmux": mux, "mux:screen": screen },
      versions: {
        "app:kitty": [selected],
        "app:kitty:clipboard": [alternateKitty],
        "headless:kitty": [
          {
            ...alternateKitty,
            sha256: "f".repeat(64),
            target: { ...target, kind: "headless" },
          },
        ],
        "mux:tmux": [mux],
        "mux:screen": [screen, olderScreen],
      },
      history: { "app:kitty": [selected], "mux:tmux": [mux], "mux:screen": [screen] },
      exclusions: [],
    } as unknown as HistoricalProjection,
  }
})

vi.mock("../docs/data/current-results.ts", async () => {
  // The projection owns the ONE classified table every reader folds (28792 item 1), so the fixture
  // classifies its own runs with the same function `loadFullProbes` would read from the real reader.
  const { classifyCells } = await import("../docs/data/release-scope.ts")
  const { loadFeatures } = await import("@terminfo/catalog")
  const { loadDefaultContextPolicy, reviewedContextFor } = await vi.importActual<
    typeof import("../docs/data/current-results.ts")
  >("../docs/data/current-results.ts")
  const catalogIds = Object.keys(loadFeatures(join(import.meta.dirname, "..", "content")))
  // These are synthetic v3 fixtures, not a compatibility reader: production never promotes history.
  const sealedFixture = (run: SelectedVersion): CurrentSelectedVersion => {
    const ids = [...new Set([...catalogIds, ...Object.keys(run.cells)])]
    const results = ids.map((featureId): CapabilityResult => {
      const cell = run.cells[featureId as keyof typeof run.cells]
      const status: CapabilityStatus =
        cell?.outcome === "supported"
          ? "supported"
          : cell?.outcome === "unsupported"
            ? "unsupported"
            : cell?.outcome === "error"
              ? "test-failure"
              : "test-todo"
      return {
        featureId,
        status,
        attempt: status === "test-todo" ? { scope: "none" } : { scope: "probe", startedAt: run.measuredAt },
        checks: [],
        evidence: cell?.evidence,
        reason: cell?.note,
      }
    })
    const counts = { supported: 0, unsupported: 0, untestable: 0, "test-todo": 0, "test-failure": 0 }
    for (const result of results) counts[result.status]++
    return {
      schemaVersion: 3,
      runId: run.runId + "-sealed-" + run.sha256.slice(0, 8),
      target: run.target,
      measuredAt: run.measuredAt,
      suiteId: run.suiteId,
      probeHash: run.probeHash ?? "fixture",
      sourceRevision: run.sourceRevision ?? "fixture",
      sealedAt: run.measuredAt,
      sha256: run.sha256,
      identity: run.identity,
      catalogIds: ids,
      results,
      counts,
      score: { supported: counts.supported, all: ids.length },
      complete: counts["test-todo"] === 0,
      suiteRelation: "release",
      suiteFreshness: run.suiteFreshness,
      rawReplies: {},
      assertions: [],
      origin: { kind: "collector" },
      presentations: {},
    }
  }
  const build = () => {
    const runs = [
      ...Object.values(fixture.projection.current),
      ...Object.values(fixture.projection.versions).flat(),
      ...Object.values(fixture.projection.history).flat(),
      // The mock's targets are fixed, so a test that removes a run from the projection still needs a
      // classified row for the run its target names (28792 item 1).
      fixture.selected,
      fixture.mux,
      fixture.screen,
    ]
    const table: Record<string, Record<string, CellState>> = {}
    for (const run of runs) table[run.runId] = classifyCells(run.cells)
    const historical = { ...fixture.projection, table }
    const current = Object.fromEntries(
      Object.entries(fixture.projection.current).map(([key, run]) => [key, sealedFixture(run)]),
    )
    const groups = (group: Record<string, SelectedVersion[]>): Record<string, CurrentSelectedVersion[]> =>
      Object.fromEntries(Object.entries(group).map(([key, runs]) => [key, runs.map(sealedFixture)]))
    const allCurrent = [
      ...Object.values(current),
      ...Object.values(groups(fixture.projection.versions)).flat(),
      ...Object.values(groups(fixture.projection.history)).flat(),
    ]
    const currentTable = Object.fromEntries(
      allCurrent.map((run) => [
        run.runId,
        Object.fromEntries(run.results.map((result) => [result.featureId, result.status])),
      ]),
    )
    return {
      current,
      versions: groups(fixture.projection.versions),
      history: groups(fixture.projection.history),
      table: currentTable,
      historical,
      exclusions: [],
    }
  }
  return {
    loadDefaultContextPolicy,
    reviewedContextFor,
    loadCurrentResults: () => ({ projection: build() }),
    compatibilityTargets: () => {
      const projection = build()
      return new Map(
        Object.entries(projection.current).map(([key, selected]) => [
          selected.target.id,
          { contextKey: key, selected },
        ]),
      )
    },
    historicalCompatibilityTargets: () =>
      new Map([
        ["kitty", { contextKey: "app:kitty", selected: fixture.selected }],
        ["tmux", { contextKey: "mux:tmux", selected: fixture.mux }],
        ["screen", { contextKey: "mux:screen", selected: fixture.screen }],
      ]),
  }
})

import probesLoader from "../docs/data/probes.data.ts"
import { loadProbes } from "../docs/data/load-probes.ts"
import * as probeData from "../docs/data/load-probes.ts"
import { loadFullProbes } from "../docs/data/probes.data.ts"
import * as currentResults from "../docs/data/current-results.ts"
import terminalPaths from "../docs/terminals/[id].paths.ts"
import comparePaths from "../docs/compare/[id].paths.ts"
import baselinePaths from "../docs/baseline/[id].paths.ts"
import categoryPaths from "../docs/[id].paths.ts"
import featurePaths from "../docs/[category]/[id].paths.ts"
import { generateApi, assertDeploymentLimits } from "./generate-api.ts"
import { generateAnalysis } from "./generate-analysis.ts"
import { loadFullProjectData } from "../docs/data/full-project.data.ts"
import { probeHash } from "../packages/admin/versions.ts"

it("keeps the retained corpus consistent across unmocked site, API and analysis consumers", () => {
  // Fixtures above replace selection. Only real retained inputs expose admission/default-context drift.
  // A separate process uses the existing consumers without inheriting this module's vi.mock registry.
  const root = join(import.meta.dirname, "..")
  const out = mkdtempSync(join(tmpdir(), "terminfo-retained-parity-"))
  const entry = (path: string) => JSON.stringify(join(root, path))
  try {
    const result = spawnSync(
      process.execPath,
      [
        "--eval",
        `
      import assert from "node:assert/strict";
      import { createHash } from "node:crypto";
      import { readFileSync, readdirSync } from "node:fs";
      import { join } from "node:path";
      import { loadCurrentResults, compatibilityTargets } from ${entry("docs/data/current-results.ts")};
      import { loadFullProbes } from ${entry("docs/data/probes.data.ts")};
      import probesLoader from ${entry("docs/data/probes.data.ts")};
      import terminalPaths from ${entry("docs/terminals/[id].paths.ts")};
      import { generateApi } from ${entry("scripts/generate-api.ts")};
      import { generateAnalysis } from ${entry("scripts/generate-analysis.ts")};
      const started = performance.now();
      const content = ${JSON.stringify(join(root, "content"))};
      const out = ${JSON.stringify(out)};
      const frozenV1Dir = ${JSON.stringify(join(root, "docs/public/api/v1"))};
      // Each real loader retains the whole corpus; reclaim prior temporary parse objects between consumers.
      const { projection } = loadCurrentResults(content);
      Bun.gc(true);
      const compatibility = compatibilityTargets(projection, content);
      const site = loadFullProbes();
      const matrix = probesLoader.load();
      const pages = terminalPaths.paths();
      const analyses = generateAnalysis();
      generateApi(out);
      const v3 = JSON.parse(readFileSync(join(out, "api/v3/data.json"), "utf8"));
      const keys = value => Object.keys(value).sort();
      const digest = bytes => createHash("sha256").update(bytes).digest("hex");
      const raw = new Set();
      for (const dir of ["probes-apps", "probes-libs", "probes-mux"])
        for (const file of readdirSync(join(content, dir)).filter(name => name.endsWith(".json")))
          raw.add(digest(readFileSync(join(content, dir, file))));
      assert.deepEqual(keys(site.selected.current), keys(projection.current));
      assert.deepEqual(keys(v3.current), keys(projection.current));
      assert.equal(v3.currentRunCount, keys(projection.current).length);
      assert.deepEqual(matrix.stats, site.stats);
      assert.deepEqual(keys(site.selectedByBackend), [...compatibility.keys()].sort());
      const referenced = new Set();
      for (const [api, published] of [[v3,site.selected]]) {
        for (const group of ["current","versions","history"]) {
          assert.deepEqual(keys(api[group]),keys(published[group]));
          for (const [key,value] of Object.entries(published[group])) {
            const versions=group==="current"?[value]:value;
            const refs=group==="current"?[api[group][key]]:api[group][key];
            for (const [i,version] of versions.entries()) {
              const bytes=readFileSync(join(out,refs[i].url.slice(1)));
              assert.equal(digest(bytes),refs[i].documentSha256);
              assert.deepEqual(JSON.parse(bytes.toString()),version);
              assert.ok(raw.has(version.sha256));
              referenced.add(version.sha256);
            }
          }
        }
      }
      assert.ok(referenced.size>0,"history remains readable");
      for (const [key,{selected}] of compatibility) {
        assert.deepEqual(matrix.stats[key].score,selected.score);
        assert.equal(selected.score.all,selected.catalogIds.length);
        const page=pages.find(page=>page.params.backendId===key);
        assert.equal(page.params.total,String(selected.score.all));
        assert.equal(page.params.yes,String(selected.score.supported));
      }
      if (!v3.currentRunCount) {
        assert.deepEqual(site.stats,{});
        assert.deepEqual(v3.current,{});
        assert.match(v3.message,/No current/);
        assert.ok(pages.some(page=>JSON.parse(page.params.historicalRuns||"[]").length));
      }
      for (const entry of Object.values(analyses))
        if(entry.runSha256) assert.ok(Object.values(projection.current).some(run=>run.sha256===entry.runSha256));
      // @cto f71ed475: v1 is frozen bytes on disk, never a generator output.
      const frozenV1 = JSON.parse(readFileSync(join(frozenV1Dir, "data.json"), "utf8"));
      assert.equal(frozenV1.version,1);
      assert.ok(Object.keys(frozenV1.terminals).length>0,"frozen v1 bytes remain readable");
      let schema3Files = 0;
      for (const dir of ["probes-apps", "probes-libs", "probes-mux"])
        for (const file of readdirSync(join(content, dir)).filter(name => name.endsWith(".json")))
          if (JSON.parse(readFileSync(join(content, dir, file), "utf8")).schemaVersion === 3) schema3Files += 1;
      console.log(JSON.stringify({exactContexts:keys(projection.current).length,schema3Files,referencedRuns:referenced.size,milliseconds:performance.now()-started}));
    `,
      ],
      { cwd: root, encoding: "utf8", timeout: 60_000, maxBuffer: 2 * 1024 * 1024 },
    )
    expect(result.error).toBeUndefined()
    expect(result.status, result.stderr).toBe(0)
    // Missing conclusive measurements are expected and remain open, including real tmux/screen proof.
    expect(
      result.stderr
        .split("\n")
        .filter(Boolean)
        .every((line) => /^Warning: Terminal '.+' has no sealed current schema-3 runs$/.test(line)),
    ).toBe(true)
    const receipt = JSON.parse(result.stdout) as {
      exactContexts: number
      schema3Files: number
      compatibilityTargets: number
      referencedRuns: number
    }
    // Current contexts come from sealed schema-3 run files and from nothing else: none without a file,
    // at least one once a file exists, never more contexts than files.
    expect(receipt.exactContexts > 0).toBe(receipt.schema3Files > 0)
    expect(receipt.exactContexts).toBeLessThanOrEqual(receipt.schema3Files)
    expect(receipt.compatibilityTargets).toBeUndefined()
    expect(receipt.referencedRuns).toBeGreaterThan(0)
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
}, 65_000)

it("analysis rejects malformed required catalogs before replacing its output", () => {
  const out = mkdtempSync(join(tmpdir(), "terminfo-analysis-metadata-"))
  try {
    const sourceRoot = join(import.meta.dirname, "..")
    mkdirSync(join(out, "scripts"))
    mkdirSync(join(out, "content"))
    for (const dir of ["probes-apps", "probes-mux", "probes-libs"]) mkdirSync(join(out, "content", dir))
    for (const dir of ["docs", "node_modules"]) symlinkSync(join(sourceRoot, dir), join(out, dir), "dir")
    const script = join(out, "scripts", "generate-analysis.ts")
    cpSync(join(import.meta.dirname, "generate-analysis.ts"), script)
    cpSync(join(import.meta.dirname, "site-out.ts"), join(out, "scripts", "site-out.ts"))
    for (const name of [
      "features",
      "terminals",
      "categories",
      "standards",
      "baselines",
      "frameworks",
      "glossary",
      "annotations",
    ]) {
      cpSync(join(sourceRoot, "content", `${name}.json`), join(out, "content", `${name}.json`))
    }
    cpSync(join(sourceRoot, "content", "suites"), join(out, "content", "suites"), { recursive: true })
    const control = spawnSync(process.execPath, [script, "--dry-run"], { cwd: out, encoding: "utf8", timeout: 10_000 })
    expect(control.error).toBeUndefined()
    expect(control.status, control.stderr).toBe(0)
    expect(control.stdout).toContain("Would generate")
    const outputPath = join(out, "content", "analysis.json")
    writeFileSync(outputPath, "PRESERVE_PREVIOUS_ANALYSIS")
    for (const [name, invalid] of [
      ["features", "[]"],
      ["terminals", "[]"],
      ["categories", "[]"],
      ["standards", "[]"],
      ["baselines", "[]"],
      ["features", "null"],
    ] as const) {
      const path = join(out, "content", `${name}.json`)
      const original = readFileSync(path, "utf8")
      writeFileSync(path, invalid)
      const result = spawnSync(process.execPath, [script], { cwd: out, encoding: "utf8", timeout: 10_000 })
      expect(result.error).toBeUndefined()
      expect(result.status, `${name}: ${result.stderr}`).toBe(1)
      expect(result.stderr).toContain(path)
      expect(result.stdout).not.toContain("Generated ")
      expect(readFileSync(outputPath, "utf8")).toBe("PRESERVE_PREVIOUS_ANALYSIS")
      writeFileSync(path, original)
    }
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
})

it("analysis validation refuses stale live values and key drift but labels historical schema checks", () => {
  // --validate must prove current values, not merely presence; existing catalog-refusal coverage cannot detect this.
  const out = mkdtempSync(join(tmpdir(), "terminfo-analysis-validation-"))
  try {
    const sourceRoot = join(import.meta.dirname, "..")
    mkdirSync(join(out, "scripts"))
    mkdirSync(join(out, "content"))
    for (const dir of ["probes-apps", "probes-mux", "probes-libs"]) mkdirSync(join(out, "content", dir))
    for (const dir of ["docs", "node_modules"]) symlinkSync(join(sourceRoot, dir), join(out, dir), "dir")
    const script = join(out, "scripts", "generate-analysis.ts")
    cpSync(join(import.meta.dirname, "generate-analysis.ts"), script)
    cpSync(join(import.meta.dirname, "site-out.ts"), join(out, "scripts", "site-out.ts"))
    for (const name of [
      "features",
      "terminals",
      "categories",
      "standards",
      "baselines",
      "frameworks",
      "glossary",
      "annotations",
    ]) {
      cpSync(join(sourceRoot, "content", `${name}.json`), join(out, "content", `${name}.json`))
    }
    cpSync(join(sourceRoot, "content", "suites"), join(out, "content", "suites"), { recursive: true })
    const run = (args: string[]) =>
      spawnSync(process.execPath, [script, ...args], { cwd: out, encoding: "utf8", timeout: 10_000 })
    const generated = run([])
    expect(generated.status, generated.stderr).toBe(0)
    const outputPath = join(out, "content", "analysis.json")
    const original = readFileSync(outputPath, "utf8")
    // AC4: a wall-clock $generated stamp made two runs of the same inputs differ.
    const generatedAgain = run([])
    expect(generatedAgain.status, generatedAgain.stderr).toBe(0)
    expect(readFileSync(outputPath, "utf8")).toBe(original)
    expect(JSON.parse(original)).not.toHaveProperty("$generated")
    const isFixtureObject = (value: unknown): value is Record<string, unknown> =>
      value !== null && typeof value === "object" && !Array.isArray(value)
    const parseFixture = (): Record<string, unknown> => {
      const data: unknown = JSON.parse(original)
      if (!isFixtureObject(data)) throw new Error("Expected generated analysis fixture object")
      return data
    }
    const entry = (data: Record<string, unknown>, key: string): Record<string, unknown> => {
      const value = data[key]
      if (!isFixtureObject(value)) throw new Error(`Expected generated analysis fixture entry: ${key}`)
      return value
    }
    const control = parseFixture()
    const liveKey = "terminals/kitty"
    const historicalKey = "terminals/vt100-historical"
    const valid = run(["--validate"])
    expect(valid.status, valid.stderr).toBe(0)
    const cases: Array<[string, (data: typeof control) => void]> = [
      [
        liveKey,
        (data) => {
          entry(data, liveKey).analysis = "<p>Stale claimed support.</p>"
        },
      ],
      [
        liveKey,
        (data) => {
          entry(data, liveKey).date = "2000-01-01"
        },
      ],
      [
        liveKey,
        (data) => {
          entry(data, liveKey).probeCount = 123
        },
      ],
      [
        liveKey,
        (data) => {
          delete data[liveKey]
        },
      ],
      [
        "stale-extra",
        (data) => {
          data["stale-extra"] = data[liveKey]
        },
      ],
      [
        historicalKey,
        (data) => {
          entry(data, historicalKey).analysis = 42
        },
      ],
      [
        historicalKey,
        (data) => {
          entry(data, historicalKey).probeCount = 123
        },
      ],
    ]
    for (const [key, mutate] of cases) {
      const data = parseFixture()
      mutate(data)
      const bytes = JSON.stringify(data)
      writeFileSync(outputPath, bytes)
      const result = run(["--validate"])
      expect(result.status, `${key}: ${result.stderr}`).toBe(1)
      expect(result.stderr).toContain(key)
      expect(result.stdout).not.toContain("Validation passed")
      expect(readFileSync(outputPath, "utf8")).toBe(bytes)
    }
    expect(valid.stdout).toContain(`${liveKey}: current-value passed`)
    expect(valid.stdout).toContain(`${historicalKey}: historical-schema passed`)
    entry(control, historicalKey).analysis = "<p>Older historical reference.</p>"
    entry(control, historicalKey).date = "2000-01-01"
    writeFileSync(outputPath, JSON.stringify(control))
    const historical = run(["--validate"])
    expect(historical.status, historical.stderr).toBe(0)
    expect(historical.stdout).toContain(`${historicalKey}: historical-schema passed`)
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
}, 30_000)

describe("selected-run consumer parity", () => {
  it("publishes v3 run references that resolve to digest-verified full run documents", () => {
    const out = mkdtempSync(join(tmpdir(), "terminfo-run-documents-"))
    try {
      generateApi(out)
      type RunReference = {
        runId: string
        target: Record<string, unknown>
        measuredAt: string
        suiteId: string
        probeHash: string
        suiteFreshness: string
        sourceRevision: string
        sha256: string
        counts: Record<string, unknown>
        url: string
        documentSha256: string
      }
      const v3 = JSON.parse(readFileSync(join(out, "api", "v3", "data.json"), "utf8")) as {
        current: Record<string, RunReference>
        versions: Record<string, RunReference[]>
        history: Record<string, RunReference[]>
      }
      const refs = [
        ...Object.values(v3.current),
        ...Object.values(v3.versions).flat(),
        ...Object.values(v3.history).flat(),
      ]
      expect(refs.length).toBeGreaterThan(0)
      for (const ref of refs) {
        expect(ref).toMatchObject({
          runId: expect.any(String),
          target: expect.any(Object),
          measuredAt: expect.any(String),
          suiteId: expect.any(String),
          probeHash: expect.any(String),
          suiteFreshness: expect.any(String),
          sourceRevision: expect.any(String),
          sha256: expect.any(String),
          counts: expect.any(Object),
          url: expect.stringMatching(/^\/api\/v3\/runs\/[a-f0-9]{64}\.json$/),
          documentSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        })
        const documentBytes = readFileSync(join(out, ref.url))
        expect(createHash("sha256").update(documentBytes).digest("hex")).toBe(ref.documentSha256)
        const document = JSON.parse(documentBytes.toString("utf8")) as Record<string, unknown>
        expect(document).toMatchObject({ runId: ref.runId, sha256: ref.sha256, target: ref.target })
        expect(document.results).toBeDefined()
      }
    } finally {
      rmSync(out, { recursive: true, force: true })
    }
  })

  // 30565: a displayed run's trace is a lazy file beside its run document; a summary never holds one.
  it("writes each displayed run's trace beside its run document and reports trace bytes and files", () => {
    const out = mkdtempSync(join(tmpdir(), "terminfo-run-traces-"))
    try {
      generateApi(out)
      const listed = (dir: string) =>
        existsSync(join(out, dir)) ? readdirSync(join(out, dir)).map((name) => `/${dir}/${name}`) : []
      const read = (url: string) => readFileSync(join(out, url), "utf8")
      // Every published API version the build writes, so the check follows the build, not a fixed prefix.
      const versions = readdirSync(join(out, "api")).filter((name) => /^v\d+$/.test(name))
      const receipts: string[] = []
      for (const version of versions) {
        for (const url of listed(`api/${version}/runs`)) {
          const run = JSON.parse(read(url)) as { sha256: string; trace?: { url: string; sha256: string } }
          if (!run.trace) continue
          const bytes = readFileSync(join(out, run.trace.url))
          expect(createHash("sha256").update(bytes).digest("hex")).toBe(run.trace.sha256)
          expect(JSON.parse(bytes.toString("utf8"))).toMatchObject({ version: 1, runSha256: run.sha256 })
          receipts.push(run.trace.url)
        }
      }
      // Every trace file is exactly one run document's receipt.
      const traces = versions.flatMap((version) => listed(`api/${version}/traces`))
      expect(traces.sort()).toEqual(receipts.sort())
      const cellsOf = (url: string) => (JSON.parse(read(url)) as { cells: Record<string, unknown> }).cells
      const cell = (url: string, featureId: string) => cellsOf(url)[featureId]
      expect(cell(`/api/v3/traces/${fixture.selected.sha256}.json`, "sgr.bold")).toMatchObject({ status: "supported" })
      const report = assertDeploymentLimits(out)
      expect(report.traceFiles).toBe(traces.length)
      expect(report.traceBytes).toBe(traces.reduce((total, url) => total + statSync(join(out, url)).size, 0))
      const summaries = Object.keys(report.dataJsonBytes)
      expect(summaries).toContain("api/v3/data.json")
      for (const path of summaries) {
        const summary = read(path)
        expect(report.dataJsonBytes[path]).toBe(Buffer.byteLength(summary))
        // A summary may carry a run's receipt; it never carries the trace's records.
        for (const url of traces) expect(summary).not.toContain(JSON.stringify(cellsOf(url)))
      }
    } finally {
      rmSync(out, { recursive: true, force: true })
    }
  })

  it("ships current cells without global selection history while routes retain versions", () => {
    const site = probesLoader.load()
    expect(Object.hasOwn(site, "selected")).toBe(false)
    expect(site.historicalByBackend.screen?.selected.cells["sgr.bold"]?.outcome).toBe("inconclusive")

    const server = loadProbes()
    expect(server.selected.historical.versions["mux:screen"]?.map((version) => version.target.version)).toEqual([
      "5.0",
      "4.9",
    ])
    expect(server.selected.historical.history["mux:screen"]?.[0]?.runId).toBe(fixture.screen.runId)
  })

  it("keeps raw evidence and unchecked collector notes out of generated site and API summaries", () => {
    const out = mkdtempSync(join(tmpdir(), "terminfo-presentation-"))
    let selection: ReturnType<typeof vi.spyOn> | undefined
    let policy: ReturnType<typeof vi.spyOn> | undefined
    let imageReader: ReturnType<typeof vi.spyOn> | undefined
    try {
      const site = probesLoader.load()
      generateApi(out)
      const v3 = readFileSync(join(out, "api", "v3", "data.json"), "utf8")
      for (const serialized of [JSON.stringify(site), v3]) {
        for (const marker of [
          "STORED_ASSERTION_EXPECTED",
          "PRIVATE_DIAGNOSTIC",
          "/home/fixture/private",
          "/private/fixture/app",
        ]) {
          expect(serialized).not.toContain(marker)
        }
      }
      expect(site.results.kitty?.["sgr.bold"]).toBe("supported")
      expect(site.historicalByBackend.kitty?.selected.cells["sgr.bold"]?.chain.runSha256).toBe(fixture.runSha256)
      // Current v3 must preserve exact sealed status while publication independently controls bytes.
      const projection = currentResults.loadCurrentResults("").projection
      const current = projection.current["app:kitty"]
      if (!current) throw new Error("Missing sealed privacy fixture")
      const result = current.results.find((result) => result.featureId === "sgr.bold")
      if (!result) throw new Error("Missing sealed privacy result")
      result.rawReplyRef = "bold-reply"
      const screenshot = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
        "base64",
      )
      const screenshotSha256 = createHash("sha256").update(screenshot).digest("hex")
      result.screenshotRef = `sha256:${screenshotSha256}`
      result.reason = "UNAPPROVED_CURRENT_REASON /home/fixture/private"
      current.suiteId = probeHash()
      selection = vi.spyOn(currentResults, "loadCurrentResults").mockReturnValue({ projection })
      policy = vi.spyOn(currentResults, "loadDefaultContextPolicy").mockReturnValue({})
      current.rawReplies = { "bold-reply": "RETAINED_CURRENT_REPLY" }
      current.assertions = [
        { featureId: "sgr.bold", kind: "positive", expected: "expected criterion", observed: "actual response" },
      ]
      const targets = new Map([["kitty", { contextKey: "app:kitty", selected: current }]])
      const unpublished = publicResults(projection, targets)
      expect(JSON.stringify(unpublished.projection.current)).not.toContain("RETAINED_CURRENT_REPLY")
      // 30565: the displayed run's trace publishes the unreviewed result's allowlisted record only.
      const receipt = unpublished.selectedByBackend.kitty?.selected.trace
      if (!receipt) throw new Error("Missing trace receipt for the displayed current run")
      expect(receipt.url).toBe(`/api/v3/traces/${current.sha256}.json`)
      const trace = unpublished.documents.get(receipt.url)
      if (!trace) throw new Error(`Missing trace document ${receipt.url}`)
      expect(createHash("sha256").update(trace.bytes).digest("hex")).toBe(receipt.sha256)
      const { cells } = JSON.parse(trace.bytes) as { cells: Record<string, unknown> }
      expect(cells["sgr.bold"]).toEqual({
        status: "supported",
        ...(result.evidence && { evidence: result.evidence }),
        replyWithheld: true,
        assertions: [{ kind: "positive", expected: "expected criterion", observed: "actual response" }],
      })
      for (const marker of [
        "RETAINED_CURRENT_REPLY",
        "UNAPPROVED_CURRENT_REASON",
        "/home/fixture/private",
        screenshotSha256,
      ]) {
        expect(trace.bytes).not.toContain(marker)
      }
      const privateFullProject = loadFullProjectData()
      expect(privateFullProject.collected).toBe(1)
      expect(JSON.stringify(privateFullProject).includes("UNAPPROVED_CURRENT_REASON")).toBe(false)
      current.presentations = {
        "sgr.bold": {
          id: "present-current-bold",
          reviewer: "reviewer",
          reason: "reviewed retained evidence",
          sources: ["https://example.org/review"],
          presentsEvidence: true,
        },
      }
      const presented = publicResults(projection, targets)
      const approval = presented.selectedByBackend.kitty?.selected.results.find(
        (result) => result.featureId === "sgr.bold",
      )?.presentation
      if (approval?.state !== "presented") throw new Error("Current evidence was not presented")
      expect(approval.url).toBe(`/api/v3/evidence/${current.sha256}.json#sgr.bold`)
      // A presentation decision takes the result out of the trace.
      const traceAfter = presented.selectedByBackend.kitty?.selected.trace
      const tracedAfter = traceAfter && presented.documents.get(traceAfter.url)
      if (traceAfter && !tracedAfter) throw new Error(`Missing trace document ${traceAfter.url}`)
      const cellsAfter = tracedAfter ? (JSON.parse(tracedAfter.bytes) as { cells: Record<string, unknown> }).cells : {}
      expect(Object.keys(cellsAfter)).not.toContain("sgr.bold")
      const docUrl = approval.url.split("#")[0]!
      const document = presented.documents.get(docUrl)
      expect(document?.document).toMatchObject({
        version: 4,
        runId: current.runId,
        runSha256: current.sha256,
        cells: {
          "sgr.bold": {
            featureId: "sgr.bold",
            result: { status: "supported" },
            record: {
              rawReply: "RETAINED_CURRENT_REPLY",
              assertions: current.assertions,
              screenshot: { url: `/artifacts/${screenshotSha256}.png`, sha256: screenshotSha256 },
            },
          },
        },
      })
      expect(createHash("sha256").update(document!.bytes).digest("hex")).toBe(approval.sha256)
      expect(JSON.stringify(presented.projection.current)).not.toContain("RETAINED_CURRENT_REPLY")
      expect(JSON.stringify(loadFullProjectData()).includes("UNAPPROVED_CURRENT_REASON")).toBe(true)
      imageReader = vi.spyOn(selectedResults, "readVerifiedArtifact").mockReturnValue(screenshot)
      generateApi(out)
      expect(imageReader).toHaveBeenCalledWith(
        expect.any(String),
        `sha256:${screenshotSha256}`,
        current.runId,
        "screenshot",
      )
      expect(readFileSync(join(out, "artifacts", `${screenshotSha256}.png`))).toEqual(screenshot)
      expect(readFileSync(join(out, docUrl), "utf8")).toBe(document!.bytes)
    } finally {
      imageReader?.mockRestore()
      policy?.mockRestore()
      selection?.mockRestore()
      rmSync(out, { recursive: true, force: true })
    }
  })

  it("fails by path if copied static evidence was never owned by the generator", () => {
    const out = mkdtempSync(join(tmpdir(), "terminfo-unapproved-artifact-"))
    const path = join(out, "artifacts", `${"f".repeat(64)}.png`)
    try {
      mkdirSync(join(out, "artifacts"))
      writeFileSync(path, "UNAPPROVED_STATIC_IMAGE")
      expect(() => generateApi(out)).toThrow(path)
      expect(readFileSync(path, "utf8")).toBe("UNAPPROVED_STATIC_IMAGE")
    } finally {
      rmSync(out, { recursive: true, force: true })
    }
  })

  it("withdraws an owned run document after its last public projection reference is removed", () => {
    const out = mkdtempSync(join(tmpdir(), "terminfo-stale-run-"))
    const runPath = join(out, "api", "v2", "runs", `${fixture.runSha256}.json`)
    const current = fixture.projection.current["app:kitty"]
    const versions = fixture.projection.versions["app:kitty"]
    const history = fixture.projection.history["app:kitty"]
    try {
      generateApi(out)
      expect(existsSync(runPath)).toBe(true)
      Reflect.deleteProperty(fixture.projection.current, "app:kitty")
      fixture.projection.versions["app:kitty"] = []
      fixture.projection.history["app:kitty"] = []
      generateApi(out)
      expect(existsSync(runPath)).toBe(false)
    } finally {
      if (current) fixture.projection.current["app:kitty"] = current
      fixture.projection.versions["app:kitty"] = versions ?? []
      fixture.projection.history["app:kitty"] = history ?? []
      rmSync(out, { recursive: true, force: true })
    }
  })

  it("reports the real output path when the conservative file-count cap is exceeded", () => {
    const out = mkdtempSync(join(tmpdir(), "terminfo-api-file-count-"))
    try {
      for (let index = 0; index < 20_000; index++) {
        writeFileSync(join(out, `ordinary-${index}.txt`), "x")
      }
      let failure: unknown
      try {
        generateApi(out)
      } catch (error) {
        failure = error
      }
      expect(failure).toBeInstanceOf(Error)
      expect((failure as Error).message).toContain(out)
      expect((failure as Error).message).toMatch(/files exceeds the 20000-file Cloudflare Pages Free-plan limit/)
    } finally {
      rmSync(out, { recursive: true, force: true })
    }
  }, 30_000)

  it("refuses an API asset above the deployment byte limit before writing it", () => {
    const out = mkdtempSync(join(tmpdir(), "terminfo-api-size-"))
    const cell = fixture.selected.cells["sgr.bold"]!
    const originalNote = cell.note
    try {
      // A reviewed correction note is public run content. The raw UTF-8 body
      // exceeds the single-file cap even though string length alone would not.
      Object.assign(cell.chain, { correctionId: "large-reviewed-correction" })
      cell.note = "界".repeat(9 * 1024 * 1024)
      expect(() => generateApi(out)).toThrow(/api\/v[123]\/.*bytes.*26214400.*Cloudflare Pages/)
      expect(existsSync(join(out, "api", "v2", "data.json"))).toBe(false)
    } finally {
      Reflect.deleteProperty(cell.chain, "correctionId")
      cell.note = originalNote
      rmSync(out, { recursive: true, force: true })
    }
  })

  // An empty deployment directory is a wrong build target, not evidence of spare capacity.
  it("refuses an empty deployment tree instead of certifying the wrong directory", () => {
    const out = mkdtempSync(join(tmpdir(), "terminfo-empty-deploy-"))
    try {
      expect(() => assertDeploymentLimits(out)).toThrow(`${out}: deployment output contains no files`)
    } finally {
      rmSync(out, { recursive: true, force: true })
    }
  })

  // The renderer writes files outside the API writer; its final deployment check must cover them too.
  it.each(["oversized", "symlink"])("rejects %s site assets at the final deployment boundary", (kind) => {
    const out = mkdtempSync(join(tmpdir(), "terminfo-site-asset-limit-"))
    const path = join(out, "page.html")
    try {
      if (kind === "oversized") writeFileSync(path, Buffer.alloc(25 * 1024 * 1024 + 1))
      else symlinkSync("missing-page.html", path)
      let failure: unknown
      try {
        assertDeploymentLimits(out)
      } catch (error) {
        failure = error
      }
      expect(failure).toBeInstanceOf(Error)
      expect((failure as Error).message).toContain(path)
      expect((failure as Error).message).toContain(kind === "oversized" ? "26214401 bytes" : "symlink")
    } finally {
      rmSync(out, { recursive: true, force: true })
    }
  })

  it("keeps the same run, conclusive counts and measurement time in every consumer", () => {
    const warnings: string[] = []
    const warning = vi.spyOn(console, "warn").mockImplementation((message: unknown) => warnings.push(String(message)))
    const out = mkdtempSync(join(tmpdir(), "terminfo-api-parity-"))
    try {
      const site = probesLoader.load()
      const terminal = terminalPaths.paths().find((page) => page.params.id === "kitty")
      const analyses = generateAnalysis()
      const analysis = analyses["terminals/kitty"]
      generateApi(out)
      const v1 = JSON.parse(readFileSync(join(out, "api", "v1", "data.json"), "utf8")) as {
        results: Record<string, Record<string, string>>
        terminals: Record<string, { score: { total: number; pass: number } }>
        methodology: { contexts: Record<string, { contextKey: string; runSha256: string }> }
      }
      const v2 = JSON.parse(readFileSync(join(out, "api", "v2", "data.json"), "utf8")) as {
        current: Record<
          string,
          { sha256: string; counts: { conclusive: number; supported: number; unsupported: number } }
        >
      }
      expect(site.historicalByBackend.kitty?.selected.sha256).toBe(fixture.runSha256)
      expect(site.stats.kitty).toMatchObject({
        score: { all: 273, supported: 1 },
        counts: { supported: 1, unsupported: 1, "test-todo": 271 },
        complete: false,
      })
      expect(terminal?.params).toMatchObject({ generated: fixture.measuredAt, total: "273", yes: "1", no: "1" })
      expect(terminal?.params.runSha256).toBe(fixture.runSha256)
      const alternatives = JSON.parse(terminal!.params.otherRuns!) as PublicVersion[]
      expect(alternatives.map((run: { runId: string }) => run.runId)).toEqual([
        "kitty-clipboard-reviewed-sealed-eeeeeeee",
      ])
      expect(alternatives[0]?.target.permissions).toBe("clipboard: read=deny,write=allow")
      const screenPage = terminalPaths.paths().find((page) => page.params.backendId === "screen")!
      const olderRuns = JSON.parse(screenPage.params.otherRuns!) as PublicVersion[]
      expect(olderRuns.map((run) => run.target.version)).toEqual(["4.9"])
      expect(terminal?.params.terminalType).toBe("app")
      expect(v1.results.kitty).toEqual({ "sgr.bold": "yes", "extensions.sixel": "no" })
      expect(v1.terminals.kitty?.score).toMatchObject({ total: 2, pass: 1 })
      expect(v1.methodology.contexts.kitty).toMatchObject({ contextKey: "app:kitty", runSha256: fixture.runSha256 })
      expect(v2.current["app:kitty"]?.sha256).toBe(fixture.runSha256)
      expect(v2.current["mux:tmux"]?.sha256).toBe(fixture.mux.sha256)
      expect(v1.terminals.tmux).toBeUndefined()
      expect(v1.results.tmux).toBeUndefined()
      expect(v2.current["app:kitty"]?.counts).toMatchObject({ conclusive: 2, supported: 1, unsupported: 1 })
      expect(analysis).toMatchObject({
        runSha256: fixture.runSha256,
        measuredAt: fixture.measuredAt,
        score: { supported: 1, all: 273 },
      })
      expect(analyses["features-index"]?.analysis).toContain("recorded support")
      expect(analyses["baseline/core"]?.analysis).toContain("<strong>0</strong> of 3")
      expect(analyses["framework/ink"]?.analysis).toContain("<strong>0</strong> of 3")
      expect(analyses["framework/ink"]?.analysis).not.toContain("Known unsupported baseline results")
      expect(analyses["framework/ink"]?.analysis).toContain("Less than full recorded support")
      expect(analyses["sgr/38-2-truecolor-fg"]?.analysis).toContain("recorded support")
      expect(analyses.cursor?.analysis).toContain("covers 22 features")
      expect(analyses.vt220?.analysis).toBeDefined()
      expect(analyses["baseline/modern"]?.analysis).toContain("0</strong>")
      expect(warnings.some((message) => message.includes("historical analysis snapshot is not current evidence"))).toBe(
        false,
      )
      expect(warnings.every((message) => message.includes("no sealed current schema-3 runs"))).toBe(true)
    } finally {
      warning.mockRestore()
      rmSync(out, { recursive: true, force: true })
    }
  })

  it("names the canonical Legacy baseline for a measured legacy feature", () => {
    // Core-only fixtures would miss the generator's former fallback of every other baseline to Unicode.
    const warnings: string[] = []
    const warning = vi.spyOn(console, "warn").mockImplementation((message: unknown) => warnings.push(String(message)))
    const featureId = "modes.decsclm"
    const cells = fixture.selected.cells
    const results = fixture.selected.v1
    const bold = cells["sgr.bold"]
    if (!bold) throw new Error("Missing selected bold fixture cell")
    try {
      Object.assign(cells, {
        [featureId]: {
          ...bold,
          featureId,
          outcome: "unsupported",
          evidence: "behavior",
          conclusive: true,
          record: { assertions: [{ featureId, kind: "negative", expected: "smooth scroll", observed: "jump scroll" }] },
          chain: { ...bold.chain, method: "behavior" },
        },
      })
      Object.assign(results, { [featureId]: false })
      const analysis = generateAnalysis()["modes/decsclm-smooth-scroll"]?.analysis
      expect(analysis).toContain("Legacy")
      expect(analysis).not.toContain("Unicode")
      expect(warnings.every((message) => message.includes("no sealed current schema-3 runs"))).toBe(true)
    } finally {
      warning.mockRestore()
      Reflect.deleteProperty(cells, featureId)
      Reflect.deleteProperty(results, featureId)
    }
  })

  it("uses the merged category/tag feature scope for analysis and unsupported gaps", () => {
    // Unicode's category-only tab-stop feature used to disappear when tag prose overwrote the merged page.
    const id = "unicode.tab-stops"
    const cells = fixture.selected.cells
    const results = fixture.selected.v1
    const bold = cells["sgr.bold"]
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      Object.assign(cells, { [id]: { ...bold, featureId: id, outcome: "unsupported", conclusive: true } })
      Object.assign(results, { [id]: false })
      const page = categoryPaths.paths().find((entry) => entry.params.id === "unicode")!
      const rows = JSON.parse(page.params.features!) as Array<{ id: string }>
      expect(rows.map((row) => row.id)).toContain(id)
      const prose = generateAnalysis().unicode!.analysis
      expect(prose).toContain(`covers ${page.params.featureCount} features`)
      expect(prose).toContain("Tab Stops")
      expect(prose).not.toContain("awaiting verified measurements")
    } finally {
      Reflect.deleteProperty(cells, id)
      Reflect.deleteProperty(results, id)
      warning.mockRestore()
    }
  })

  it("keeps a sealed all-TODO target visible with its full catalog denominator", () => {
    const site = probesLoader.load()
    const terminal = terminalPaths.paths().find((page) => page.params.id === "gnu-screen")
    expect(site.backends.map((backend) => backend.name)).toContain("screen")
    expect(site.historicalByBackend.screen?.selected.cells["sgr.bold"]?.outcome).toBe("inconclusive")
    expect(site.stats.screen).toMatchObject({
      score: { all: 273, supported: 0 },
      counts: { "test-todo": 273 },
      complete: false,
    })
    expect(site.stats.screen?.pct).toBe(0)
    expect(terminal?.params).toMatchObject({
      generated: fixture.screen.measuredAt,
      runSha256: fixture.screen.sha256,
      pct: "0",
    })
    expect(JSON.parse(terminal?.params.versions ?? "[]")).toEqual([
      expect.objectContaining({ version: fixture.screen.target.version, pct: 0, suiteFreshness: "current" }),
      expect.objectContaining({ version: "4.9", pct: 0, suiteFreshness: "older suite (1 probes)" }),
    ])
    const comparison = comparePaths
      .paths()
      .find(
        (page) =>
          [page.params.termAId, page.params.termBId].includes("screen") &&
          [page.params.termAId, page.params.termBId].includes("kitty"),
      )
    expect(comparison?.params[comparison.params.termAId === "screen" ? "termATotal" : "termBTotal"]).toBe("273")
    expect(comparison?.params.comparableScope).toBe("false")
    const core = baselinePaths.paths().find((page) => page.params.id === "core")
    expect(JSON.parse(core?.params.scores ?? "[]")).toContainEqual(
      expect.objectContaining({ name: "screen", score: { all: 80, supported: 0 }, pct: 0 }),
    )
    const bold = featurePaths.paths().find((page) => page.params.featureId === "sgr.bold")
    expect(bold?.params).toMatchObject({ yesCount: "1", totalCount: "3" })
  })

  it("limits comparison claims to the same recorded scope and jointly conclusive evidence method", () => {
    const data = loadProbes()
    const kittyEntry = data.selectedByBackend.kitty
    const screenEntry = data.selectedByBackend.screen
    const tmuxEntry = data.selectedByBackend.tmux
    const kitty = kittyEntry?.selected
    const screen = screenEntry?.selected
    const tmux = tmuxEntry?.selected
    const bold = kitty?.results.find((result) => result.featureId === "sgr.bold")
    if (!screen || !tmux || !bold || !screenEntry || !tmuxEntry) throw new Error("Missing comparison fixtures")
    function requiredResult(run: import("../docs/data/public-results").PublicVersion, id: string) {
      const result = run.results.find((result) => result.featureId === id)
      if (!result) throw new Error(`Missing fixture result ${id}`)
      return result
    }
    function refresh(entry: NonNullable<ReturnType<typeof loadProbes>["selectedByBackend"][string]>) {
      entry.states = Object.fromEntries(entry.selected.results.map((result) => [result.featureId, result.status]))
      const aggregate = aggregateCurrentResults(entry.selected.results, entry.selected.catalogIds)
      entry.selected.complete = aggregate.complete
      entry.selected.counts = aggregate.counts
      entry.selected.score = { supported: aggregate.supported, all: aggregate.denominator }
    }
    const mixed = comparePaths
      .paths()
      .find(
        (page) =>
          [page.params.termAId, page.params.termBId].includes("screen") &&
          [page.params.termAId, page.params.termBId].includes("kitty"),
      )
    expect(mixed?.params.comparableScope).toBe("false")
    expect(mixed?.params.differ).toBe("")
    expect(mixed?.params.termAKind).toBeDefined()
    expect(mixed?.params.termBKind).toBeDefined()

    const originalScreen = structuredClone(screen)
    const originalTmux = structuredClone(tmux)
    try {
      screen.target.mux = tmux.target.mux
      for (const result of [...screen.results, ...tmux.results]) result.status = "unsupported"
      Object.assign(requiredResult(screen, "sgr.bold"), { ...structuredClone(bold), status: "unsupported" })
      Object.assign(requiredResult(tmux, "sgr.bold"), { ...structuredClone(bold), status: "supported" })
      Object.assign(requiredResult(screen, "extensions.sixel"), { status: "unsupported", evidence: "parser-state" })
      Object.assign(requiredResult(tmux, "extensions.sixel"), { status: "supported", evidence: "query" })
      refresh(screenEntry)
      refresh(tmuxEntry)
      const pair = comparePaths
        .paths()
        .find(
          (page) =>
            [page.params.termAId, page.params.termBId].includes("screen") &&
            [page.params.termAId, page.params.termBId].includes("tmux"),
        )
      expect(pair?.params.comparableScope).toBe("true")
      expect(pair?.params.jointConclusive).toBe("1")
      expect(pair?.params.differ).toBe("1")
      const rows = JSON.parse(pair?.params.categories ?? "[]") as Array<{
        features: Array<{ id: string; comparable: boolean }>
      }>
      const cells = rows.flatMap((category) => category.features)
      expect(cells.find((cell) => cell.id === "sgr.bold")?.comparable).toBe(true)
      expect(cells.find((cell) => cell.id === "extensions.sixel")?.comparable).toBe(false)

      screen.target.os = null
      const unknownOsPair = comparePaths
        .paths()
        .find(
          (page) =>
            [page.params.termAId, page.params.termBId].includes("screen") &&
            [page.params.termAId, page.params.termBId].includes("tmux"),
        )
      expect(unknownOsPair?.params.comparableScope).toBe("false")
    } finally {
      Object.assign(screen, originalScreen)
      Object.assign(tmux, originalTmux)
      refresh(screenEntry)
      refresh(tmuxEntry)
    }
  })

  it("scores baseline support over the full catalog and exposes test failures", () => {
    const site = probesLoader.load()
    const catalog = site.baselines.core?.length ?? 0
    expect(catalog).toBeGreaterThan(1)
    expect(site.baselineStats.kitty?.core).toMatchObject({
      score: { all: catalog, supported: 1 },
      pct: Math.round(100 / catalog),
      counts: { supported: 1, unsupported: 0, untestable: 0, "test-failure": 0, "test-todo": catalog - 1 },
    })
    expect(site.baselineStats.screen?.core).toMatchObject({
      score: { all: catalog, supported: 0 },
      pct: 0,
      counts: { supported: 0, unsupported: 0, untestable: 0, "test-failure": 0, "test-todo": catalog },
    })
    const core = baselinePaths.paths().find((page) => page.params.id === "core")
    const scores = JSON.parse(core?.params.scores || "[]") as Array<Record<string, unknown>>
    expect(scores.find((score) => score.name === "kitty")).toMatchObject({
      version: fixture.selected.target.version,
      score: { all: catalog, supported: 1 },
      pct: Math.round(100 / catalog),
    })
    const screenBold = fixture.screen.cells["sgr.bold"] as SelectedCell
    if (!screenBold) throw new Error("Missing screen error-count fixture cell")
    const originalScreenBold = structuredClone(screenBold)
    try {
      screenBold.outcome = "error"
      screenBold.reason = "collector-error"
      expect(probesLoader.load().baselineStats.screen?.core).toMatchObject({
        counts: { "test-failure": 1, "test-todo": catalog - 1 },
        score: { all: catalog, supported: 0 },
      })
    } finally {
      Object.assign(screenBold, originalScreenBold)
      if (originalScreenBold.reason === undefined) delete screenBold.reason
    }
  })

  it("keeps unscoped annotations out of feature analysis while retaining reviewed selected notes", () => {
    const warnings: string[] = []
    const warning = vi.spyOn(console, "warn").mockImplementation((message: unknown) => warnings.push(String(message)))
    const annotations = JSON.parse(
      readFileSync(join(import.meta.dirname, "..", "content", "annotations.json"), "utf8"),
    ) as Record<string, { note: string }>
    const unscoped = annotations["kitty:extensions.sixel"]?.note
    if (!unscoped) throw new Error("Missing Kitty sixel annotation fixture")
    const cell = fixture.selected.cells["extensions.sixel"] as SelectedCell
    const original = structuredClone(cell)
    try {
      const unreviewed = generateAnalysis()["extensions/sixel-graphics"]?.analysis
      expect(unreviewed).not.toContain(unscoped)
      expect(unreviewed).toContain("No recorded support among")
      expect(unreviewed).toContain("Not supported by:")
      cell.note = "Reviewed Kitty sixel observation note"
      cell.chain.correctionId = "reviewed-sixel"
      expect(probesLoader.load().historicalByBackend.kitty?.selected.cells["extensions.sixel"]?.note).toBe(
        "Reviewed Kitty sixel observation note",
      )
      const reviewed = generateAnalysis()["extensions/sixel-graphics"]?.analysis
      expect(reviewed).not.toContain(unscoped)
      expect(reviewed).not.toContain("Reviewed Kitty sixel observation note")
      expect(warnings.every((message) => message.includes("no sealed current schema-3 runs"))).toBe(true)
    } finally {
      warning.mockRestore()
      Object.assign(cell, original)
      if (original.note === undefined) delete cell.note
      if (original.chain.correctionId === undefined) Reflect.deleteProperty(cell.chain, "correctionId")
    }
  })

  it("uses selected public notes across routes without promoting unscoped annotations", () => {
    const data = loadProbes()
    const reviewed = data.selectedByBackend.kitty?.selected.results.find((result) => result.featureId === "sgr.bold")
    const inconclusive = data.selectedByBackend.screen?.selected.results.find(
      (result) => result.featureId === "sgr.bold",
    )
    if (!reviewed || !inconclusive) throw new Error("Missing selected bold cells in parity fixture")
    const originalNote = reviewed.reason
    const originalInconclusiveNote = inconclusive.reason
    const originalBoldAnnotation = data.annotations["kitty:sgr.bold"]
    const originalSixelAnnotation = data.annotations["kitty:extensions.sixel"]
    const originalScreenAnnotation = data.annotations["screen:sgr.bold"]
    const originalNotes = structuredClone(data.notes)
    reviewed.reason = "Reviewed Kitty bold note"
    data.notes.kitty = { ...data.notes.kitty, "sgr.bold": "Reviewed Kitty bold note" }
    data.notes.screen = { ...data.notes.screen, "sgr.bold": "Reviewed screen inconclusive note" }
    inconclusive.reason = "Reviewed screen inconclusive note"
    data.annotations["kitty:sgr.bold"] = {
      note: "Unscoped conflicting bold annotation",
      url: "https://example.org/unscoped-implementation",
    }
    data.annotations["kitty:extensions.sixel"] = { note: "Unreviewed sixel annotation" }
    data.annotations["screen:sgr.bold"] = { note: "Unscoped screen annotation" }

    const rowNote = (rows: string, featureId: string, backendName: string): string | undefined =>
      (JSON.parse(rows) as Array<{ id: string; results: Record<string, { note: string }> }>).find(
        (row) => row.id === featureId,
      )?.results[backendName]?.note

    try {
      const categories = categoryPaths.paths()
      const baselines = baselinePaths.paths()
      const terminals = terminalPaths.paths()
      const features = featurePaths.paths()
      const comparison = comparePaths
        .paths()
        .find(
          (entry) =>
            [entry.params.termAId, entry.params.termBId].includes("kitty") &&
            [entry.params.termAId, entry.params.termBId].includes("screen"),
        )
      const comparisonRows = JSON.parse(comparison?.params.categories ?? "[]") as Array<{
        features: Array<{ id: string; noteA: string; noteB: string }>
      }>
      const terminalNote = (backendName: string, featureId: string): string | undefined => {
        const page = terminals.find((entry) => entry.params.backendId === backendName)
        const groups = JSON.parse(page?.params.categories ?? "[]") as Array<{
          features: Array<{ id: string; note: string }>
        }>
        return groups.flatMap((group) => group.features).find((row) => row.id === featureId)?.note
      }
      for (const [backendName, featureId, categoryId, tagId, baselineId, expected] of [
        ["kitty", "sgr.bold", "sgr", "ecma-48", "core", "Reviewed Kitty bold note"],
        ["kitty", "extensions.sixel", "extensions", "sixel", "rich", ""],
        ["screen", "sgr.bold", "sgr", "ecma-48", "core", "Reviewed screen inconclusive note"],
      ] as const) {
        const category = categories.find((page) => page.params.id === categoryId)
        const tag = categories.find((page) => page.params.id === tagId)
        const baseline = baselines.find((page) => page.params.id === baselineId)
        const feature = features.find((page) => page.params.featureId === featureId)
        const featureRows = JSON.parse(feature?.params.backendResults ?? "[]") as Array<{ name: string; note: string }>
        const comparisonRow = comparisonRows.flatMap((group) => group.features).find((row) => row.id === featureId)
        expect(rowNote(category?.params.features ?? "[]", featureId, backendName)).toBe(expected)
        expect(rowNote(tag?.params.features ?? "[]", featureId, backendName)).toBe(expected)
        expect(rowNote(baseline?.params.features ?? "[]", featureId, backendName)).toBe(expected)
        expect(featureRows.find((row) => row.name === backendName)?.note).toBe(expected)
        expect(comparison?.params.termAId === backendName ? comparisonRow?.noteA : comparisonRow?.noteB).toBe(expected)
        expect(terminalNote(backendName, featureId)).toBe(expected)
      }
      expect(data.results.screen?.["sgr.bold"]).toBe("test-todo")
      const bold = features.find((page) => page.params.featureId === "sgr.bold")
      const boldResults = JSON.parse(bold?.params.backendResults ?? "[]") as Array<Record<string, unknown>>
      expect(boldResults.find((row) => row.name === "kitty")).not.toHaveProperty("url")
      expect(data.annotations["kitty:sgr.bold"]?.note).toBe("Unscoped conflicting bold annotation")
      expect(data.annotations["kitty:sgr.bold"]?.url).toBe("https://example.org/unscoped-implementation")
      expect(data.annotations["kitty:extensions.sixel"]?.note).toBe("Unreviewed sixel annotation")
      expect(data.annotations["screen:sgr.bold"]?.note).toBe("Unscoped screen annotation")
    } finally {
      data.notes = originalNotes
      if (originalNote === undefined) delete reviewed.reason
      else reviewed.reason = originalNote
      if (originalInconclusiveNote === undefined) delete inconclusive.reason
      else inconclusive.reason = originalInconclusiveNote
      if (originalBoldAnnotation === undefined) delete data.annotations["kitty:sgr.bold"]
      else data.annotations["kitty:sgr.bold"] = originalBoldAnnotation
      if (originalSixelAnnotation === undefined) delete data.annotations["kitty:extensions.sixel"]
      else data.annotations["kitty:extensions.sixel"] = originalSixelAnnotation
      if (originalScreenAnnotation === undefined) delete data.annotations["screen:sgr.bold"]
      else data.annotations["screen:sgr.bold"] = originalScreenAnnotation
    }
  })
})

it("keeps a historical native parser on its own route without promoting it to current", () => {
  const native = structuredClone(fixture.selected) as unknown as SelectedVersion
  native.target = { ...native.target, kind: "headless", id: "ghostty-native" }
  native.runId = "native-historical"
  const projection = currentResults.loadCurrentResults("").projection
  projection.historical.table = { ...projection.historical.table, [native.runId]: classifyCells(native.cells) }
  // A fresh map: the mocked projection shares the fixture's version groups, so writing into them leaks to later tests.
  projection.historical.versions = { ...projection.historical.versions, "headless:ghostty-native": [native] }
  const selection = vi.spyOn(currentResults, "loadCurrentResults").mockReturnValue({ projection })
  const targets = vi
    .spyOn(currentResults, "historicalCompatibilityTargets")
    .mockReturnValue(new Map([["ghostty-native", { contextKey: "headless:ghostty-native", selected: native }]]))
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {})
  let probes: ReturnType<typeof vi.spyOn> | undefined
  let analysis: ReturnType<typeof vi.spyOn> | undefined
  try {
    const data = loadFullProbes()
    probes = vi.spyOn(probeData, "loadProbes").mockReturnValue(data)
    analysis = vi.spyOn(probeData, "loadAnalysis").mockReturnValue(generateAnalysis())
    const pages = terminalPaths.paths()
    const page = pages.find((entry) => entry.params.backendId === "ghostty-native")
    expect(warning).toHaveBeenCalledWith("Warning: Terminal 'ghostty-native' has no sealed current schema-3 runs")
    for (const [message] of warning.mock.calls) {
      expect(message).toMatch(/^Warning: Terminal '.+' has no sealed current schema-3 runs$/)
    }
    expect(page?.params.id).toBe("headless-ghostty-native")
    expect(page?.params.total).toBe("")
    expect(data.selectedByBackend["ghostty-native"]).toBeUndefined()
    expect(data.historicalByBackend["ghostty-native"]?.selected.sha256).toBe(fixture.runSha256)
    expect(pages.find((entry) => entry.params.backendId === "ghostty")?.params.id).toBe("ghostty")
  } finally {
    probes?.mockRestore()
    analysis?.mockRestore()
    targets.mockRestore()
    selection.mockRestore()
    warning.mockRestore()
  }
})

it("labels the headless Ghostty cores libghostty-vt and keeps Ghostty for the app", () => {
  // Operator 2026-10-21 (30608): a headless Ghostty core is the library, never the app that embeds it.
  // The WASM core is measured under the app entry, so its label comes from that entry's headlessLabels.
  const projection = currentResults.loadCurrentResults("").projection
  const base = Object.values(projection.current)[0]
  if (!base) throw new Error("the fixture projection has no current run")
  const as = (contextKey: string, kind: CurrentSelectedVersion["target"]["kind"], id: string) => {
    const selected = structuredClone(base)
    selected.target = { ...selected.target, kind, id }
    // Public results cache mapped runs by run id and publish one trace per run sha, so each target needs
    // its own sealed run, sha and status row.
    selected.runId = `${base.runId}-${contextKey}`
    selected.sha256 = createHash("sha256").update(contextKey).digest("hex")
    projection.current[contextKey] = selected
    projection.table = { ...projection.table, [selected.runId]: projection.table[base.runId] ?? {} }
    return { contextKey, selected }
  }
  const selection = vi.spyOn(currentResults, "loadCurrentResults").mockReturnValue({ projection })
  const targets = vi.spyOn(currentResults, "compatibilityTargets").mockReturnValue(
    new Map([
      ["ghostty", as("app:ghostty", "app", "ghostty")],
      ["headless-ghostty", as("headless:ghostty", "headless", "ghostty")],
      ["ghostty-native", as("headless:ghostty-native", "headless", "ghostty-native")],
    ]),
  )
  try {
    const { meta } = loadFullProbes()
    expect(meta["headless-ghostty"]?.label).toBe("libghostty-vt (WASM)")
    expect(meta["ghostty-native"]?.label).toBe("libghostty-vt (native)")
    expect(meta.ghostty?.label).toBe("Ghostty")
  } finally {
    targets.mockRestore()
    selection.mockRestore()
  }
})

it("names historical-only headless Ghostty cores libghostty-vt on the site", () => {
  // @chief 2026-10-21 (30608): every Ghostty run is historical-only, and the site names a headless
  // core as its own row, so one name has one home. v1 is frozen bytes and no longer generated.
  const projection = currentResults.loadCurrentResults("").projection
  const as = (contextKey: string, kind: SelectedVersion["target"]["kind"], id: string) => {
    const selected = structuredClone(fixture.selected) as unknown as SelectedVersion
    selected.target = { ...selected.target, kind, id }
    // Run documents are keyed by run id and sha, so each target needs its own run, sha and status row.
    selected.runId = `${selected.runId}-${contextKey}`
    selected.sha256 = createHash("sha256").update(contextKey).digest("hex")
    projection.historical.table = { ...projection.historical.table, [selected.runId]: classifyCells(selected.cells) }
    return { contextKey, selected }
  }
  const historical = new Map([
    ["ghostty", as("app:ghostty", "app", "ghostty")],
    ["headless-ghostty", as("headless:ghostty", "headless", "ghostty")],
    ["ghostty-native", as("headless:ghostty-native", "headless", "ghostty-native")],
  ])
  const selection = vi.spyOn(currentResults, "loadCurrentResults").mockReturnValue({ projection })
  const targets = vi.spyOn(currentResults, "historicalCompatibilityTargets").mockReturnValue(historical)
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {})
  try {
    const { meta, selectedByBackend } = loadFullProbes()
    expect(selectedByBackend["headless-ghostty"]).toBeUndefined()
    // Name and slug only: the app entry's description and body describe the app, not its core.
    expect(meta["headless-ghostty"]).toEqual({ label: "libghostty-vt (WASM)", slug: "headless-ghostty" })
    expect(meta["ghostty-native"]?.label).toBe("libghostty-vt (native)")
    expect(meta.ghostty?.label).toBe("Ghostty")
  } finally {
    warning.mockRestore()
    targets.mockRestore()
    selection.mockRestore()
  }
})

it("terminalPaths.paths() refuses loudly when two pages mint one id", () => {
  // The guard 28047 adds, on the pair it was written for: before the fix the app 'ghostty' and the
  // headless parser 'ghostty-native' both minted page id 'ghostty', so VitePress wrote one run over
  // the other's URL and nothing failed. Restore that shape and require a build error naming both keys.
  const app = structuredClone(fixture.selected) as unknown as SelectedVersion
  app.target = { ...app.target, kind: "app", id: "ghostty" }
  const native = structuredClone(fixture.selected) as unknown as SelectedVersion
  native.target = { ...native.target, kind: "headless", id: "ghostty-native" }
  const targets = vi.spyOn(currentResults, "historicalCompatibilityTargets").mockReturnValue(
    new Map([
      ["ghostty", { contextKey: "app:ghostty", selected: app }],
      ["ghostty-native", { contextKey: "headless:ghostty-native", selected: native }],
    ]),
  )
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {})
  let probes: ReturnType<typeof vi.spyOn> | undefined
  let analysis: ReturnType<typeof vi.spyOn> | undefined
  try {
    const data = loadFullProbes()
    probes = vi.spyOn(probeData, "loadProbes").mockReturnValue({
      ...data,
      meta: { ...data.meta, "ghostty-native": { ...data.meta["ghostty-native"], slug: "ghostty" } },
    })
    analysis = vi.spyOn(probeData, "loadAnalysis").mockReturnValue({
      ...generateAnalysis(),
      "terminals/ghostty": { analysis: "<p>app</p>", date: "2026-09-28", changes: null, runSha256: fixture.runSha256 },
      "terminals/ghostty-native": {
        analysis: "<p>parser</p>",
        date: "2026-09-28",
        changes: null,
        runSha256: fixture.runSha256,
      },
    } as unknown as ReturnType<typeof probeData.loadAnalysis>)
    let message = ""
    try {
      terminalPaths.paths()
    } catch (cause) {
      message = cause instanceof Error ? cause.message : String(cause)
    }
    expect(message).toContain("mint the id 'ghostty'")
    expect(message).toContain("'ghostty-native'")
  } finally {
    probes?.mockRestore()
    analysis?.mockRestore()
    warning.mockRestore()
    targets.mockRestore()
  }
})
