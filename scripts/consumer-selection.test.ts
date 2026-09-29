/**
 * @failure Legacy booleans or a malformed required run become current site/API scores.
 * @level l2
 * @consumer Site data and JSON API use the canonical reviewed-run selector.
 * @testonly none
 */
import { describe, expect, it, vi } from "vitest"
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { tmpdir } from "node:os"
import { join } from "node:path"
import probesLoader from "../docs/data/probes.data.ts"
import { generateApi } from "./generate-api.ts"
import { generateAnalysis } from "./generate-analysis.ts"
import terminalPaths from "../docs/terminals/[id].paths.ts"
import { compatibilityTargets, loadCurrentResults } from "../docs/data/current-results.ts"
import type { SelectedProjection } from "../docs/data/selected-results.ts"

function writeCatalog(content: string): void {
  writeFileSync(
    join(content, "terminals.json"),
    readFileSync(join(import.meta.dirname, "..", "content", "terminals.json")),
  )
}

describe("consumer selection", () => {
  it("checks freshness without changing inventory or treating unreviewed files as current", () => {
    const root = mkdtempSync(join(tmpdir(), "terminfo-freshness-"))
    const source = join(import.meta.dirname, "..")
    try {
      mkdirSync(join(root, "scripts"))
      mkdirSync(join(root, "content"))
      copyFileSync(join(source, "scripts", "sitefile.ts"), join(root, "scripts", "sitefile.ts"))
      symlinkSync(join(source, "docs"), join(root, "docs"), "dir")
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
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

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
      const v2 = JSON.parse(readFileSync(join(out, "api", "v2", "data.json"), "utf8")) as {
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
  })

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
