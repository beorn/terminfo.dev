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
import { baselineRowReadout, decisiveCells, NOT_MEASURED_TEXT } from "../docs/data/release-scope.ts"

const counts = (entries: Partial<Record<CapabilityStatus, number>>): Record<CapabilityStatus, number> => ({
  supported: 0,
  unsupported: 0,
  untestable: 0,
  "test-todo": 0,
  "test-failure": 0,
  ...entries,
})

describe("#30763 baseline row readout", () => {
  it("names the three shapes in literal text", () => {
    // Windows Terminal's rich row: 88 TEST TODO + 11 TEST FAILURE, nothing decided.
    const held = counts({ "test-todo": 88, "test-failure": 11 })
    expect(decisiveCells(held)).toBe(0)
    expect(baselineRowReadout(held, { supported: 0, all: 99 }, 0)).toEqual({
      text: NOT_MEASURED_TEXT,
      title: "0 Supported · 0 Unsupported · 0 Untestable · 88 TEST TODO · 11 TEST FAILURE",
    })
    expect(NOT_MEASURED_TEXT).not.toMatch(/%/)

    // vt220.js rich: 36 judged unsupported, so its zero is a measured zero.
    const judged = counts({ unsupported: 36, untestable: 12, "test-todo": 33, "test-failure": 18 })
    expect(decisiveCells(judged)).toBe(36)
    expect(baselineRowReadout(judged, { supported: 0, all: 99 }, 0)).toEqual({ text: "0% · 0/99" })

    // Alacritty on Windows rich: the one rich cell it genuinely supports.
    const oneSupported = counts({ supported: 1, "test-todo": 81, "test-failure": 17 })
    expect(baselineRowReadout(oneSupported, { supported: 1, all: 99 }, 1)).toEqual({ text: "1% · 1/99" })
  })

  it("reads the real rows it was filed for, and no decided row lost its number", () => {
    const site = loadFullProbes()
    const row = (backend: string, baseline: string) => {
      const stats = site.baselineStats[backend]?.[baseline]
      if (!stats) throw new Error(`Missing ${backend} ${baseline} baseline stats`)
      return baselineRowReadout(stats.counts, stats.score, stats.pct)
    }
    expect(site.baselineStats["windows-terminal"]).toBeDefined()
    expect(row("windows-terminal", "rich")).toEqual({
      text: NOT_MEASURED_TEXT,
      title: "0 Supported · 0 Unsupported · 0 Untestable · 88 TEST TODO · 11 TEST FAILURE",
    })
    expect(row("vt220", "rich")).toEqual({ text: "0% · 0/99" })
    expect(row("vt100-rust", "rich")).toEqual({ text: "0% · 0/99" })
    expect(row("app-alacritty", "rich")).toEqual({ text: "1% · 1/99" })
  }, 30_000)
})
