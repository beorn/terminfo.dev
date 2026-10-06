/**
 * @failure Unreviewed runs become current scores, or refresh skips its release assessment and errors.
 * @level l2
 * @consumer Site data and JSON API use the canonical reviewed-run selector.
 * @testonly none
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
import { generateAnalysis } from "./generate-analysis.ts"
import terminalPaths from "../docs/terminals/[id].paths.ts"
import { compatibilityTargets, loadCurrentResults } from "../docs/data/current-results.ts"
import { publicResults } from "../docs/data/public-results.ts"
import type { PublicVersion } from "../docs/data/public-results.ts"
import type { SelectedProjection } from "../docs/data/selected-results.ts"

interface RunReference extends Pick<
  PublicVersion,
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

describe("consumer selection", () => {
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
      writeFileSync(join(root, "content", "features.json"), '{"sgr.bold":{"name":"Bold"}}')
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
      const expected = publicResults(projection, compatibilityTargets(projection, contentDir)).projection
      const v2 = JSON.parse(readFileSync(join(out, "api/v2/data.json"), "utf8")) as {
        current: Record<string, RunReference>
        versions: Record<string, RunReference[]>
        history: Record<string, RunReference[]>
        exclusions: unknown[]
      }
      const expectedRuns = new Map<string, PublicVersion>()
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
        expectedGroup: Record<string, PublicVersion> | Record<string, PublicVersion[]>,
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
        terminals: Record<string, { score?: { total: number } }>
        results: Record<string, Record<string, string>>
      }
      const v2Bytes = readFileSync(join(out, "api", "v2", "data.json"))
      // The full retained dataset must fit Cloudflare Pages' single-asset limit.
      expect(v2Bytes.byteLength).toBeLessThanOrEqual(25 * 1024 * 1024)
      const v2 = JSON.parse(v2Bytes.toString("utf8")) as {
        current: Record<string, unknown>
        history: Record<string, Array<{ suiteId: string; counts: { conclusive: number } }>>
      }
      const analysis = generateAnalysis()
      const legacy = Object.values(v2.history)
        .flat()
        .filter((entry) => entry.suiteId === "legacy")
      expect(legacy.length).toBeGreaterThan(0)
      expect(legacy.every((entry) => entry.counts.conclusive === 0)).toBe(true)
      if (!site.selectedByBackend.kitty) {
        expect(site.results.kitty).toBeUndefined()
        expect(site.stats.kitty).toBeUndefined()
        expect(api.results.kitty).toBeUndefined()
        expect(api.terminals.kitty?.score).toBeUndefined()
        expect(analysis["terminals/kitty"]?.analysis).toContain("awaiting verified measurements")
      }
      if (Object.keys(v2.current).length === 0) {
        expect(analysis["baseline/core"]?.analysis).toContain("awaiting verified measurements")
      }
      expect(terminalPaths.paths().some((page) => page.params.id === "kitty")).toBe(true)
      expect(warnings).toContainEqual(expect.stringContaining("historical analysis snapshot is not current evidence"))
      expect(
        warnings.every(
          (message) =>
            message.includes("historical analysis snapshot is not current evidence") ||
            message.includes("no reviewed current conclusive results"),
        ),
      ).toBe(true)
    } finally {
      warning.mockRestore()
      rmSync(out, { recursive: true, force: true })
    }
  }, 30_000)

  it("refuses a malformed required result with its path", () => {
    const content = mkdtempSync(join(tmpdir(), "terminfo-malformed-selection-"))
    try {
      writeFileSync(join(content, "features.json"), '{"sgr.bold":{"name":"Bold"}}')
      for (const dir of ["probes-apps", "probes-mux", "probes-libs"]) mkdirSync(join(content, dir))
      writeFileSync(join(content, "probes-apps", "bad.json"), "{")
      expect(() => loadCurrentResults(content)).toThrow(/bad\.json: invalid JSON/)
    } finally {
      rmSync(content, { recursive: true, force: true })
    }
  })

  it("requires a reviewed default row for two exact contexts of one terminal", () => {
    const mac = { target: { kind: "app", id: "kitty", os: "macos" } }
    const linux = { target: { kind: "app", id: "kitty", os: "linux" } }
    const projection = { current: { "app:kitty@mac": mac, "app:kitty@linux": linux } } as unknown as SelectedProjection
    const content = mkdtempSync(join(tmpdir(), "terminfo-context-selection-"))
    try {
      writeCatalog(content)
      expect(() => compatibilityTargets(projection, content)).toThrow(/Ambiguous current app:kitty/)
      writeFileSync(
        join(content, "default-contexts.json"),
        JSON.stringify({
          defaultContext: {
            "app:kitty": {
              contextKey: "app:kitty@linux",
              reviewer: "reviewer",
              reason: "controlled Linux context selected for default view",
              sources: ["review://linux"],
            },
          },
        }),
      )
      expect(compatibilityTargets(projection, content).get("kitty")?.contextKey).toBe("app:kitty@linux")
    } finally {
      rmSync(content, { recursive: true, force: true })
    }
  })

  it("keeps same-named app and headless runs in distinct compatibility rows", () => {
    const app = { target: { kind: "app", id: "kitty" } }
    const headless = { target: { kind: "headless", id: "kitty" } }
    const library = { target: { kind: "headless", id: "xtermjs" } }
    const projection = {
      current: { "app:kitty": app, "headless:kitty": headless, "headless:xtermjs": library },
      history: { "app:kitty": [app], "headless:kitty": [headless], "headless:xtermjs": [library] },
    } as unknown as SelectedProjection
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
    const projection = {
      current: {
        "headless:wezterm": headlessWezterm,
        "app:wezterm": appWezterm,
        "headless:alacritty": headlessAlacritty,
        "app:alacritty": appAlacritty,
      },
    } as unknown as SelectedProjection
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
      const projection = { current: {} } as SelectedProjection
      expect(() => compatibilityTargets(projection, content)).toThrow(
        /released key wezterm changed meaning from headless/,
      )
    } finally {
      rmSync(content, { recursive: true, force: true })
    }
  })
})
