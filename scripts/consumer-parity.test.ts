/**
 * @failure Site, API and analysis disagree about one already-admitted run, its denominator or measurement time.
 * @level l2
 * @consumer Site matrix, terminal paths, v1/v2 API and generated analysis.
 * @testonly none
 */
import { describe, expect, it, vi } from "vitest"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

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
      record: {
        rawReply: "\u001b[1;2R",
        assertions: [{ featureId: "sgr.bold", kind: "positive", expected: "cursor response", observed: "\u001b[1;2R" }],
      },
      chain: { origin: { kind: "collector" }, method: "query", runId: "kitty-reviewed", runSha256 },
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
    runId: "kitty-reviewed",
    target,
    measuredAt,
    suiteId: "suite-v2",
    probeHash: "current",
    suiteFreshness: "current",
    sourceRevision: "rev",
    sha256: runSha256,
    suite: { observed: 2, expected: 2, complete: true },
    cells,
    v1: { "sgr.bold": true, "extensions.sixel": false },
    counts: { catalog: 270, tested: 2, notTested: 268, conclusive: 2, supported: 1, unsupported: 1 },
    ungradedDiagnostics: { evidence: "legacy", label: "old callback result, unverified", results: {} },
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
  return {
    runSha256,
    measuredAt,
    selected,
    mux,
    projection: {
      current: { "app:kitty": selected, "mux:tmux": mux },
      versions: { "app:kitty": [selected], "mux:tmux": [mux] },
      history: { "app:kitty": [selected], "mux:tmux": [mux] },
      exclusions: [],
    },
  }
})

vi.mock("../docs/data/current-results.ts", () => ({
  loadCurrentResults: () => ({ projection: fixture.projection }),
  compatibilityTargets: () =>
    new Map([
      ["kitty", { contextKey: "app:kitty", selected: fixture.selected }],
      ["tmux", { contextKey: "mux:tmux", selected: fixture.mux }],
    ]),
}))

import probesLoader from "../docs/data/probes.data.ts"
import terminalPaths from "../docs/terminals/[id].paths.ts"
import { generateApi } from "./generate-api.ts"
import { generateAnalysis } from "./generate-analysis.ts"

describe("selected-run consumer parity", () => {
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
      expect(site.selected.current["app:kitty"]?.sha256).toBe(fixture.runSha256)
      expect(site.stats.kitty).toMatchObject({ total: 2, yes: 1, no: 1 })
      expect(terminal?.params).toMatchObject({ generated: fixture.measuredAt, total: "2", yes: "1", no: "1" })
      expect(terminal?.params.runSha256).toBe(fixture.runSha256)
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
        counts: { conclusive: 2, supported: 1, unsupported: 1 },
      })
      expect(analyses["features-index"]?.analysis).toContain("<strong>1</strong> feature")
      expect(analyses["baseline/core"]?.analysis).toContain("<strong>0</strong> of 2")
      expect(analyses["framework/ink"]?.analysis).toContain("<strong>0</strong> of 2")
      expect(analyses["sgr/38-2-truecolor-fg"]?.analysis).toContain("awaiting verified measurements")
      expect(analyses.cursor?.analysis).toContain("awaiting verified measurements")
      expect(analyses.vt220?.analysis).toContain("awaiting verified measurements")
      expect(analyses["baseline/modern"]?.analysis).toContain("awaiting verified measurements")
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
})
