/**
 * @failure Legacy booleans or a malformed required run become current site/API scores.
 * @level l2
 * @consumer Site data and JSON API use the canonical reviewed-run selector.
 * @testonly none
 */
import { describe, expect, it, vi } from "vitest"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import probesLoader from "../docs/data/probes.data.ts"
import { generateApi } from "./generate-api.ts"
import { generateAnalysis } from "./generate-analysis.ts"
import terminalPaths from "../docs/terminals/[id].paths.ts"
import { compatibilityTargets, loadCurrentResults } from "../docs/data/current-results.ts"
import type { SelectedProjection } from "../docs/data/selected-results.ts"

describe("consumer selection", () => {
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
      expect(() => compatibilityTargets(projection, content)).toThrow(/Ambiguous current kitty/)
      writeFileSync(
        join(content, "default-contexts.json"),
        JSON.stringify({
          defaultContext: {
            kitty: {
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
})
