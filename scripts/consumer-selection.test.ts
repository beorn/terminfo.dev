/**
 * @failure Unreviewed runs become current scores, or refresh skips its release assessment and errors.
 * @level l2
 * @consumer Site data and JSON API use the canonical reviewed-run selector.
 * @reach fs-walk <fixture-only: walks temporary scratch fixtures for run selection>
 * @testonly none
 * @reach fs-walk vendor/terminfo.dev/content/probes-apps/ vendor/terminfo.dev/content/probes-mux/ vendor/terminfo.dev/content/probes-libs/
 */
import { describe, expect, it, vi } from "vitest"
import { createHash } from "node:crypto"
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { spawnSync } from "node:child_process"
import { tmpdir } from "node:os"
import { join } from "node:path"
import probesLoader from "../docs/data/probes.data.ts"
import { generateApi } from "./generate-api.ts"
import { loadAnalysis } from "../docs/data/load-probes.ts"
import terminalPaths from "../docs/terminals/[id].paths.ts"
import {
  compatibilityTargets,
  historicalCompatibilityTargets,
  loadCurrentResults,
} from "../docs/data/current-results.ts"
import { publicResults } from "../docs/data/public-results.ts"
import type { HistoricalPublicVersion } from "../docs/data/public-results.ts"
import { projectedContextKey, type SelectedProjection } from "../docs/data/selected-results.ts"
import type { CellState } from "../docs/data/release-scope.ts"

/** One synthetic current run: only the target fields the selection rule reads. */
type StubRun = { target: { kind: string; id: string; os?: string; permissions?: string | null } }

/**
 * A stub projection for the selection tests. The projection carries the ONE classified table
 * (28792 item 1), so each stub run gets a run id and an EMPTY classified row — the selection rule reads
 * no cells, and `compatibilityTargets` only needs a row to exist for every current run.
 */
function stubProjection(current: Record<string, StubRun>, history: Record<string, unknown[]> = {}): SelectedProjection {
  const table: Record<string, Record<string, import("@terminfo/probe-defs").CapabilityStatus>> = {}
  for (const [key, run] of Object.entries(current)) {
    const runId = `run:${key}`
    ;(run as StubRun & { runId?: string }).runId = runId
    table[runId] = {}
  }
  return { current, history, table } as unknown as SelectedProjection
}

interface RunReference extends Pick<
  HistoricalPublicVersion,
  | "runId"
  | "target"
  | "measuredAt"
  | "suiteId"
  | "probeHash"
  | "suiteFreshness"
  | "suite"
  | "sourceRevision"
  | "sha256"
  | "counts"
> {
  url: string
  documentSha256: string
}

function writeCatalog(content: string): void {
  writeFileSync(
    join(content, "terminals.json"),
    readFileSync(join(import.meta.dirname, "..", "content", "terminals.json")),
  )
}

/**
 * A features.json fixture that satisfies @terminfo/catalog's one shape. The selection consumers
 * these tests police read only the catalog ids, so the record fields are inert placeholders.
 */
function featureCatalog(...ids: string[]): string {
  return JSON.stringify(
    Object.fromEntries(
      ids.map((id) => [
        id,
        { name: id, slug: id.replaceAll(".", "-"), body: "fixture", probe: "fixture", baseline: "supported" },
      ]),
    ),
  )
}

/**
 * A suite manifest that freezes a release: `frozenSuiteIdFor` resolves a release's current suite from
 * the one manifest whose `freeze.release` names it, so every fixture content dir needs one.
 */
function writeFrozenSuite(content: string, probeHash: string): void {
  mkdirSync(join(content, "suites"), { recursive: true })
  writeFileSync(
    join(content, "suites", `${probeHash}.json`),
    JSON.stringify({
      probeHash,
      adapterVersion: "4.0.0",
      freeze: { release: "candidate2", at: "2026-10-12T03:33:42.000Z" },
      probes: { app: [], headless: [], mux: [] },
    }),
  )
}

describe("consumer selection", () => {
  it("keeps an all-history corpus readable without inventing current schema-3 results", () => {
    const content = join(import.meta.dirname, "..", "content")
    const { projection } = loadCurrentResults(content)
    expect(Object.keys(projection.current)).toHaveLength(0)
    const published = publicResults(projection, compatibilityTargets(projection, content))
    expect(published.projection.current).toEqual({})
    expect(Object.values(published.projection.historical.history).flat().length).toBeGreaterThan(0)
    const out = mkdtempSync(join(tmpdir(), "terminfo-zero-current-"))
    try {
      const { dataPath } = generateApi(out)
      const current = JSON.parse(readFileSync(dataPath, "utf8")) as {
        currentRunCount: number
        current: Record<string, unknown>
        message: string
      }
      expect(current.currentRunCount).toBe(0)
      expect(current.current).toEqual({})
      expect(current.message).toContain("No current")
      const historical = JSON.parse(readFileSync(join(out, "api/v2/data.json"), "utf8")) as {
        history: Record<string, unknown[]>
      }
      expect(Object.values(historical.history).flat().length).toBeGreaterThan(0)
    } finally {
      rmSync(out, { recursive: true, force: true })
    }
  }, 30_000)

  it("refuses failed discovery and corrupt retained radar records without changing prior findings", () => {
    const root = mkdtempSync(join(tmpdir(), "terminfo-discovery-errors-"))
    const source = join(import.meta.dirname, "..")
    try {
      mkdirSync(join(root, "scripts"))
      mkdirSync(join(root, "content"))
      mkdirSync(join(root, "bin"))
      for (const name of ["explore.ts", "radar.ts"]) {
        copyFileSync(join(source, "scripts", name), join(root, "scripts", name))
      }
      const radarPath = join(root, "content", "radar.jsonl")
      const retained = JSON.stringify({
        id: "retained",
        type: "new-protocol",
        query_id: "prior",
        discovered: "2026-09-29",
      })
      const valid = `${retained}\n\n`
      writeFileSync(radarPath, valid)
      const bunShim = join(root, "bin", "bun")
      writeFileSync(bunShim, "#!/bin/sh\nexit 23\n")
      chmodSync(bunShim, 0o755)
      const invoke = (name: "explore" | "radar") => {
        const args = name === "explore" ? ["--query", "active-terminals"] : ["stats"]
        return spawnSync(process.execPath, [join(root, "scripts", `${name}.ts`), ...args], {
          encoding: "utf8",
          env: { ...process.env, PATH: `${join(root, "bin")}:${process.env.PATH}` },
        })
      }

      writeFileSync(radarPath, "\n  \n")
      const emptyRadar = invoke("radar")
      expect(emptyRadar.status, emptyRadar.stderr).toBe(0)
      expect(emptyRadar.stdout).toContain("no findings")
      writeFileSync(radarPath, valid)
      const validRadar = invoke("radar")
      expect(validRadar.status, validRadar.stderr).toBe(0)
      expect(validRadar.stdout).toContain("total      1")
      const failedQuery = invoke("explore")
      expect(failedQuery.stderr).toContain("Query failed")
      expect(failedQuery.status, failedQuery.stdout + failedQuery.stderr).toBe(1)
      expect(readFileSync(radarPath, "utf8")).toBe(valid)

      for (const bad of ["{", "[]", "{}"] as const) {
        const previous = `${valid}${bad}\n`
        writeFileSync(radarPath, previous)
        for (const name of ["radar", "explore"] as const) {
          const result = invoke(name)
          expect(result.status, `${name} ${bad}: ${result.stdout}${result.stderr}`).not.toBe(0)
          expect(result.stderr).toContain(`${radarPath}:3:`)
          expect(readFileSync(radarPath, "utf8")).toBe(previous)
        }
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("checks freshness without changing inventory or treating unreviewed files as current", () => {
    const root = mkdtempSync(join(tmpdir(), "terminfo-freshness-"))
    const source = join(import.meta.dirname, "..")
    try {
      mkdirSync(join(root, "scripts"))
      mkdirSync(join(root, "content"))
      copyFileSync(join(source, "scripts", "sitefile.ts"), join(root, "scripts", "sitefile.ts"))
      symlinkSync(join(source, "docs"), join(root, "docs"), "dir")
      symlinkSync(join(source, "node_modules"), join(root, "node_modules"), "dir")
      for (const dir of ["probes-apps", "probes-mux", "probes-libs"]) mkdirSync(join(root, "content", dir))
      writeCatalog(join(root, "content"))
      writeFileSync(join(root, "content", "features.json"), featureCatalog("sgr.bold"))
      writeFrozenSuite(join(root, "content"), "deadbeefcafe")
      writeFileSync(
        join(root, "content", "probes-apps", "kitty-0.46.2-linux.json"),
        JSON.stringify({
          backend: "kitty",
          version: "0.46.2",
          generated: new Date().toISOString(),
          results: { "sgr.bold": true },
        }),
      )
      const lock = join(root, "scripts", "sitefile.lock.json")
      const before = '{"unchanged":"a check does not regenerate inventory"}\n'
      writeFileSync(lock, before)
      const check = spawnSync(process.execPath, [join(root, "scripts", "sitefile.ts"), "--check"], { encoding: "utf8" })
      expect(check.stderr).toBe("")
      expect(check.status).toBe(1)
      expect(check.stdout).toContain("kitty — no reviewed current measurement")
      expect(readFileSync(lock, "utf8")).toBe(before)
      const generate = spawnSync(process.execPath, [join(root, "scripts", "sitefile.ts")], { encoding: "utf8" })
      expect(generate.stderr).toBe("")
      expect(generate.status).toBe(0)
      const inventory = JSON.parse(readFileSync(lock, "utf8")) as {
        sources: Array<{ lastChecked: string | null }>
        terminals: Array<{ terminalId: string; lastProbedVersion: string | null; lastProbedDate: string }>
      }
      expect(inventory.sources.every((entry) => entry.lastChecked === null)).toBe(true)
      expect(inventory.terminals.find((entry) => entry.terminalId === "kitty")).toMatchObject({
        lastProbedVersion: null,
        lastProbedDate: "never",
      })
      // The refresh command must preserve its child check's failure status.
      copyFileSync(join(source, "scripts", "update.ts"), join(root, "scripts", "update.ts"))
      writeFileSync(join(root, "scripts", "radar.ts"), 'console.log("radar fixture completed")\n')
      writeFileSync(join(root, "scripts", "explore.ts"), 'console.log("explore fixture completed")\n')
      writeFileSync(
        join(root, "scripts", "watch-releases.ts"),
        `
        import { writeFileSync } from "node:fs"
        writeFileSync("${join(root, "watch-args.json")}", JSON.stringify(process.argv.slice(2)))
        console.log(JSON.stringify([{ terminal: "kitty", disposition: "no-reviewed-current" }]))
        if (process.env.WATCH_FAIL === "1") process.exitCode = 1
      `,
      )
      writeFileSync(
        join(root, "package.json"),
        JSON.stringify({
          scripts: {
            sitefile: "bun scripts/sitefile.ts",
            radar: "bun scripts/radar.ts",
            explore: "bun scripts/explore.ts",
            "watch-releases": "bun scripts/watch-releases.ts",
          },
        }),
      )
      const started = Date.now()
      const update = spawnSync(process.execPath, [join(root, "scripts", "update.ts"), "--status"], { encoding: "utf8" })
      const finished = Date.now()
      expect(update.stdout).toContain("radar fixture completed")
      expect(update.stdout).toContain("PASS\u001b[0m  release-watch")
      const watchArgs = JSON.parse(readFileSync(join(root, "watch-args.json"), "utf8")) as string[]
      expect(watchArgs.slice(0, 2)).toEqual(["--json", "--at"])
      const runAt = watchArgs[2]
      expect(runAt).toBeDefined()
      expect(new Date(runAt!).toISOString()).toBe(runAt)
      expect(Date.parse(runAt!)).toBeGreaterThanOrEqual(started)
      expect(Date.parse(runAt!)).toBeLessThanOrEqual(finished)
      expect(update.stdout).toContain("1 step(s) failed")
      expect(update.status).toBe(1)
      const discover = spawnSync(process.execPath, [join(root, "scripts", "update.ts"), "--discover"], {
        encoding: "utf8",
      })
      expect(discover.stdout).toContain("PASS\u001b[0m  release-watch")
      expect(discover.stdout).toContain("explore fixture completed")
      expect(discover.status).toBe(1)
      const failedFull = spawnSync(process.execPath, [join(root, "scripts", "update.ts"), "--full", "--no-pause"], {
        encoding: "utf8",
        env: { ...process.env, WATCH_FAIL: "1" },
      })
      expect(failedFull.status).toBe(1)
      expect(failedFull.stdout).toContain("FAIL\u001b[0m  release-watch")
      expect(failedFull.stdout).not.toContain("Re-probe headless backends")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  // Exercises all consumers over retained history; this is a correctness check, not a latency assertion.
  it("reassembles all retained run documents from the exact public projection", () => {
    const out = mkdtempSync(join(tmpdir(), "terminfo-api-run-parity-"))
    try {
      generateApi(out)
      const contentDir = join(import.meta.dirname, "..", "content")
      const projection = loadCurrentResults(contentDir).projection
      const expected = publicResults(
        projection,
        compatibilityTargets(projection, contentDir),
        historicalCompatibilityTargets(projection.historical, contentDir),
      ).projection.historical
      const v2 = JSON.parse(readFileSync(join(out, "api/v2/data.json"), "utf8")) as {
        current: Record<string, RunReference>
        versions: Record<string, RunReference[]>
        history: Record<string, RunReference[]>
        exclusions: unknown[]
      }
      const expectedRuns = new Map<string, HistoricalPublicVersion>()
      const allExpectedVersions = [
        ...Object.values(expected.current),
        ...Object.values(expected.versions).flat(),
        ...Object.values(expected.history).flat(),
      ]
      for (const version of allExpectedVersions) expectedRuns.set(version.sha256, version)
      const retainedFiles = ["probes-apps", "probes-mux", "probes-libs"].flatMap((dir) =>
        readdirSync(join(contentDir, dir)).filter((name) => name.endsWith(".json") && name !== "unified.json"),
      )
      expect(expectedRuns.size).toBe(retainedFiles.length)

      const assertGroup = (
        actual: Record<string, RunReference> | Record<string, RunReference[]>,
        expectedGroup: Record<string, HistoricalPublicVersion> | Record<string, HistoricalPublicVersion[]>,
      ) => {
        expect(Object.keys(actual).sort()).toEqual(Object.keys(expectedGroup).sort())
        for (const [key, expectedValue] of Object.entries(expectedGroup)) {
          const actualValue = actual[key]
          const expectedVersions = Array.isArray(expectedValue) ? expectedValue : [expectedValue]
          const actualVersions = Array.isArray(actualValue) ? actualValue : [actualValue]
          expect(actualVersions).toHaveLength(expectedVersions.length)
          expectedVersions.forEach((version, index) => {
            const ref = actualVersions[index]
            if (!ref) throw new Error(`Missing run reference for ${version.runId}`)
            expect(ref).toMatchObject({
              runId: version.runId,
              target: version.target,
              measuredAt: version.measuredAt,
              suiteId: version.suiteId,
              probeHash: version.probeHash,
              suiteFreshness: version.suiteFreshness,
              suite: version.suite,
              sourceRevision: version.sourceRevision,
              sha256: version.sha256,
              counts: version.counts,
              url: `/api/v2/runs/${version.sha256}.json`,
            })
            const bytes = readFileSync(join(out, ref.url))
            expect(createHash("sha256").update(bytes).digest("hex")).toBe(ref.documentSha256)
            expect(JSON.parse(bytes.toString("utf8"))).toEqual(version)
          })
        }
      }
      assertGroup(v2.current, expected.current)
      assertGroup(v2.versions, expected.versions)
      assertGroup(v2.history, expected.history)
      expect(v2.exclusions).toEqual(expected.exclusions)
      expect(expectedRuns.size).toBeGreaterThan(0)
    } finally {
      rmSync(out, { recursive: true, force: true })
    }
  }, 30_000)

  it("does not score unreviewed legacy booleans as current results", () => {
    const warnings: string[] = []
    const warning = vi.spyOn(console, "warn").mockImplementation((message: unknown) => warnings.push(String(message)))
    const out = mkdtempSync(join(tmpdir(), "terminfo-api-selection-"))
    try {
      const site = probesLoader.load()
      const { dataPath } = generateApi(out)
      const api = JSON.parse(readFileSync(dataPath, "utf8")) as {
        current: Record<string, unknown>
        currentRunCount: number
      }
      const v2Bytes = readFileSync(join(out, "api", "v2", "data.json"))
      // The full retained dataset must fit Cloudflare Pages' single-asset limit.
      expect(v2Bytes.byteLength).toBeLessThanOrEqual(25 * 1024 * 1024)
      const v2 = JSON.parse(v2Bytes.toString("utf8")) as {
        current: Record<string, unknown>
        history: Record<string, Array<{ suiteId: string; counts: { conclusive: number } }>>
      }
      // Share the site's analysis loader with terminal paths, as the real site does.
      const analysis = loadAnalysis()
      const legacy = Object.values(v2.history)
        .flat()
        .filter((entry) => entry.suiteId === "legacy")
      expect(legacy.length).toBeGreaterThan(0)
      expect(legacy.every((entry) => entry.counts.conclusive === 0)).toBe(true)
      if (!site.selectedByBackend.kitty) {
        expect(site.results.kitty).toBeUndefined()
        expect(site.stats.kitty).toBeUndefined()
        expect(api.currentRunCount).toBe(0)
        expect(api.current).toEqual({})
        expect(analysis["terminals/kitty"]?.analysis).toContain("No current schema-3")
      }
      if (api.currentRunCount === 0) {
        expect(analysis["baseline/core"]?.analysis).toContain("No current schema-3")
      }
      expect(terminalPaths.paths().some((page) => page.params.id === "kitty")).toBe(true)
      expect(warnings.some((message) => message.includes("historical analysis snapshot is not current evidence"))).toBe(
        false,
      )
      expect(warnings.every((message) => message.includes("no sealed current schema-3 runs"))).toBe(true)
    } finally {
      warning.mockRestore()
      rmSync(out, { recursive: true, force: true })
    }
  }, 30_000)

  it("refuses a malformed required result with its path", () => {
    const content = mkdtempSync(join(tmpdir(), "terminfo-malformed-selection-"))
    try {
      writeFileSync(join(content, "features.json"), featureCatalog("sgr.bold"))
      writeFrozenSuite(content, "deadbeefcafe")
      for (const dir of ["probes-apps", "probes-mux", "probes-libs"]) mkdirSync(join(content, dir))
      writeFileSync(join(content, "probes-apps", "bad.json"), "{")
      expect(() => loadCurrentResults(content)).toThrow(/bad\.json: invalid JSON/)
    } finally {
      rmSync(content, { recursive: true, force: true })
    }
  })

  it("fails loudly when the suite registry freezes no suite for the release", () => {
    const content = mkdtempSync(join(tmpdir(), "terminfo-missing-declaration-"))
    try {
      writeFileSync(join(content, "features.json"), featureCatalog("sgr.bold"))
      for (const dir of ["probes-apps", "probes-mux", "probes-libs"]) mkdirSync(join(content, dir))
      expect(() => loadCurrentResults(content)).toThrow(/the suite registry is required to name the current suite/)
      mkdirSync(join(content, "suites"))
      expect(() => loadCurrentResults(content)).toThrow(/no suite manifest declares freeze.release "candidate2"/)
    } finally {
      rmSync(content, { recursive: true, force: true })
    }
  })

  it("requires a reviewed default row for two exact contexts of one terminal", () => {
    const mac = { target: { kind: "app", id: "kitty", os: "macos" } }
    const linux = { target: { kind: "app", id: "kitty", os: "linux" } }
    const macKey = projectedContextKey(
      {
        kind: "app",
        id: "kitty",
        version: "0.48.2",
        os: "macos",
        osVersion: "26.6.2",
        outerTerminal: null,
        mux: null,
        config: null,
        permissions: null,
      },
      2,
    )
    const linuxKey = projectedContextKey(
      {
        kind: "app",
        id: "kitty",
        version: "0.49.2",
        os: "linux",
        osVersion: "7.0.0-34-generic",
        outerTerminal: null,
        mux: null,
        config: "/nix/store/kitty/bin/kitty",
        permissions: null,
      },
      2,
    )
    const projection = stubProjection({ [macKey]: mac, [linuxKey]: linux })
    const content = mkdtempSync(join(tmpdir(), "terminfo-context-selection-"))
    try {
      writeCatalog(content)
      expect(() => compatibilityTargets(projection, content)).toThrow(/Ambiguous current app:kitty/)
      writeFileSync(
        join(content, "default-contexts.json"),
        JSON.stringify({
          defaultContext: {
            "app:kitty": {
              contextKey: linuxKey,
              reviewer: "reviewer",
              reason: "controlled Linux context selected for default view",
              sources: ["review://linux"],
            },
          },
        }),
      )
      expect(compatibilityTargets(projection, content).get("kitty")?.contextKey).toBe(linuxKey)
    } finally {
      rmSync(content, { recursive: true, force: true })
    }
  })

  it("keeps same-named app and headless runs in distinct compatibility rows", () => {
    const app = { target: { kind: "app", id: "kitty" } }
    const headless = { target: { kind: "headless", id: "kitty" } }
    const library = { target: { kind: "headless", id: "xtermjs" } }
    const projection = stubProjection(
      { "app:kitty": app, "headless:kitty": headless, "headless:xtermjs": library },
      { "app:kitty": [app], "headless:kitty": [headless], "headless:xtermjs": [library] },
    )
    const content = mkdtempSync(join(tmpdir(), "terminfo-kind-selection-"))
    try {
      writeCatalog(content)
      const rows = compatibilityTargets(projection, content)
      expect(rows.get("kitty")?.selected.target.kind).toBe("app")
      expect(rows.get("headless-kitty")?.selected.target.kind).toBe("headless")
      expect(rows.get("xtermjs")?.selected.target.kind).toBe("headless")
      delete projection.current["app:kitty"]
      expect(compatibilityTargets(projection, content).get("headless-kitty")?.contextKey).toBe("headless:kitty")
    } finally {
      rmSync(content, { recursive: true, force: true })
    }
  })

  it("keeps released headless keys when same-id app runs arrive", () => {
    const headlessWezterm = { target: { kind: "headless", id: "wezterm" } }
    const appWezterm = { target: { kind: "app", id: "wezterm" } }
    const headlessAlacritty = { target: { kind: "headless", id: "alacritty" } }
    const appAlacritty = { target: { kind: "app", id: "alacritty" } }
    const projection = stubProjection({
      "headless:wezterm": headlessWezterm,
      "app:wezterm": appWezterm,
      "headless:alacritty": headlessAlacritty,
      "app:alacritty": appAlacritty,
    })
    const content = mkdtempSync(join(tmpdir(), "terminfo-released-keys-"))
    try {
      writeCatalog(content)
      const rows = compatibilityTargets(projection, content)
      expect(rows.get("wezterm")?.selected.target.kind).toBe("headless")
      expect(rows.get("app-wezterm")?.selected.target.kind).toBe("app")
      expect(rows.get("alacritty")?.selected.target.kind).toBe("headless")
      expect(rows.get("app-alacritty")?.selected.target.kind).toBe("app")
      delete projection.current["headless:wezterm"]
      expect(compatibilityTargets(projection, content).get("app-wezterm")?.contextKey).toBe("app:wezterm")
    } finally {
      rmSync(content, { recursive: true, force: true })
    }
  })

  it("refuses a catalog edit that would change a released v1 key's meaning", () => {
    const content = mkdtempSync(join(tmpdir(), "terminfo-released-rename-"))
    try {
      writeCatalog(content)
      const catalog = JSON.parse(readFileSync(join(content, "terminals.json"), "utf8")) as Record<
        string,
        { headlessBackends: string[] }
      >
      const wezterm = catalog.wezterm
      if (!wezterm) throw new Error("Fixture lacks WezTerm")
      wezterm.headlessBackends = []
      writeFileSync(join(content, "terminals.json"), JSON.stringify(catalog))
      const projection = stubProjection({})
      expect(() => compatibilityTargets(projection, content)).toThrow(
        /released key wezterm changed meaning from headless/,
      )
    } finally {
      rmSync(content, { recursive: true, force: true })
    }
  })

  it("names the declared xterm app run as a compatibility target", () => {
    const appXterm = { target: { kind: "app", id: "xterm" } }
    const projection = stubProjection({ "app:xterm": appXterm })
    const content = mkdtempSync(join(tmpdir(), "terminfo-xterm-target-"))
    try {
      writeCatalog(content)
      const rows = compatibilityTargets(projection, content)
      expect(rows.get("xterm")?.contextKey).toBe("app:xterm")
      expect(rows.get("xterm")?.selected.target.kind).toBe("app")
    } finally {
      // raw-delete-allow: standalone component repository whose CI installs without hh's workspace, so removely is unavailable; content is this test's own mkdtemp scratch root
      rmSync(content, { recursive: true, force: true })
    }
  })
})
