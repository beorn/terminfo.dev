/**
 * @failure A baseline row whose every cell is held or uncollected prints "0%", reading the same as
 *   a terminal that was measured and failed, while a decided-unsupported row loses its honest zero.
 * @level l1
 * @consumer Home baseline cards and /baseline/:id coverage rows through docs/data/release-scope.ts
 * @testonly none
 */
import type { CapabilityStatus } from "@terminfo/probe-defs"
import { describe, expect, it } from "vitest"
import { loadFullProbes } from "../docs/data/probes.data.ts"
import { decisiveCells, NOT_MEASURED_TEXT } from "../docs/data/release-scope.ts"

const counts = (entries: Partial<Record<CapabilityStatus, number>>): Record<CapabilityStatus, number> => ({
  supported: 0,
  unsupported: 0,
  untestable: 0,
  "test-todo": 0,
  "test-failure": 0,
  ...entries,
})

describe("#30763 baseline share readout", () => {
  it("names both shapes: zero decisive reads not measured, decisive-but-unsupported keeps 0%", () => {
    const held = counts({ "test-todo": 88, "test-failure": 11 })
    const judgedUnsupported = counts({ unsupported: 7, untestable: 12, "test-todo": 33, "test-failure": 47 })

    expect(decisiveCells(held)).toBe(0)
    expect(NOT_MEASURED_TEXT).not.toMatch(/%/)

    expect(decisiveCells(judgedUnsupported)).toBe(7)
  })

  it("lifts only the held rows and leaves every honest zero on the measured page", () => {
    const site = loadFullProbes()

    const statsOf = (backend: string, baseline: string) => {
      const stats = site.baselineStats[backend]?.[baseline]
      if (!stats) throw new Error(`Missing ${backend} ${baseline} baseline stats`)
      return stats
    }

    // Windows Terminal: the console host holds every verdict, so no baseline of that run has a
    // single decisive cell (a reviewed Untestable is not one).
    for (const baseline of Object.keys(site.baselineStats["windows-terminal"] ?? {})) {
      expect(decisiveCells(statsOf("windows-terminal", baseline).counts), baseline).toBe(0)
      expect(statsOf("windows-terminal", baseline).pct, baseline).toBe(0)
    }

    // Alacritty on Windows follows the same hold, except the one rich cell it genuinely supports.
    for (const baseline of ["core", "modern", "unicode", "legacy"]) {
      expect(decisiveCells(statsOf("app-alacritty", baseline).counts), baseline).toBe(0)
    }
    expect(decisiveCells(statsOf("app-alacritty", "rich").counts)).toBe(1)

    // The honest zeros: judged unsupported, so they keep their measured 0%.
    expect(decisiveCells(statsOf("vt220", "rich").counts)).toBe(36)
    expect(decisiveCells(statsOf("vt100", "rich").counts)).toBe(36)
    expect(decisiveCells(statsOf("vt100-rust", "rich").counts)).toBe(7)
    expect(statsOf("vt100-rust", "rich").counts.untestable).toBe(12)
    for (const backend of ["vt220", "vt100", "vt100-rust"]) {
      expect(statsOf(backend, "rich").pct, backend).toBe(0)
    }

    // No scoring change: every row that decides anything still prints supported/denominator.
    for (const [backend, baselines] of Object.entries(site.baselineStats)) {
      for (const [baseline, stats] of Object.entries(baselines)) {
        if (decisiveCells(stats.counts) === 0) continue
        expect(stats.pct, `${backend} ${baseline}`).toBe(Math.round((100 * stats.score.supported) / stats.score.all))
      }
    }
  }, 30_000)
})
