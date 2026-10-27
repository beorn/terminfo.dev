/**
 * @failure Current scores exclude unfinished capabilities, count Unsupported as support,
 *   or hide a group's TODO/failure behind a complete aggregate.
 * @level l1
 * @consumer Full273 page and batch collection through docs/data/full-scope.ts
 * @testonly none
 */
import { describe, expect, it } from "vitest"
import { join } from "node:path"
import { loadFeatures } from "@terminfo/catalog"
import type { ProbeResult, ProbeStatus } from "@terminfo/probe-defs"
import { scopeAggregate } from "../docs/data/full-scope.ts"
const results = (entries: Record<string, ProbeStatus>): ProbeResult[] =>
  Object.entries(entries).map(([featureId, status]) => ({
    featureId,
    status,
    tests: [],
    attempt: status === "test-todo" ? { scope: "none" } : { scope: "probe", startedAt: "2026-10-21T05:00:00.000Z" },
  }))
// Retired exclusion tests could pass while unfinished current rows disappeared from the denominator.
describe("current full-catalogue scope arithmetic", () => {
  it("counts every exact status over all capabilities, with only Supported in the numerator", () => {
    const entries = {
      "a.positive": "supported",
      "a.negative": "unsupported",
      "a.impossible": "untestable",
      "b.pending": "test-todo",
      "b.broken": "test-failure",
    } as const
    const value = scopeAggregate({ scope: "kitty/linux", catalogIds: Object.keys(entries), results: results(entries) })
    expect(value.fraction).toBe("1/5")
    expect(value.pct).toBe(20)
    expect(value.denominator).toBe(5)
    expect(value.counts).toEqual({ supported: 1, unsupported: 1, untestable: 1, "test-todo": 1, "test-failure": 1 })
    expect(value.complete).toBe(false)
    expect(value.groups.map((group) => [group.key, group.fraction, group.pct, group.complete])).toEqual([
      ["a", "1/3", 33, true],
      ["b", "0/2", 0, false],
    ])
  })
  it("finishes all Unsupported at zero Supported without removing a capability", () => {
    const value = scopeAggregate({
      scope: "negative",
      catalogIds: ["a.one", "b.two"],
      results: results({ "a.one": "unsupported", "b.two": "unsupported" }),
    })
    expect(value).toMatchObject({ fraction: "0/2", denominator: 2, pct: 0, complete: true })
    expect(value.groups.every((group) => group.complete)).toBe(true)
  })
  it.each(["test-todo", "test-failure"] as const)(
    "never completes with required %s even at ninety percent support",
    (status) => {
      const ids = Array.from({ length: 10 }, (_, index) => "a.row" + index)
      const value = scopeAggregate({
        scope: "unfinished",
        catalogIds: ids,
        results: results(Object.fromEntries(ids.map((id, index) => [id, index === 0 ? status : "supported"]))),
      })
      expect(value.fraction).toBe("9/10")
      expect(value.pct).toBe(90)
      expect(value.complete).toBe(false)
    },
  )
  it("keeps all 273 catalogue rows while the graded denominator is the 264 capabilities (D132 B)", () => {
    const ids = Object.keys(loadFeatures(join(import.meta.dirname, "..", "content")))
    expect(ids).toHaveLength(273)
    expect(ids).toContain("device.env-term")
    expect(ids).toContain("extensions.osc133-a")
    const value = scopeAggregate({
      scope: "full-catalogue",
      catalogIds: ids,
      results: results(Object.fromEntries(ids.map((id) => [id, "test-todo"]))),
    })
    // Every recorded position stays a catalogue row; the nine environment positions are ungraded.
    expect(value).toMatchObject({ catalogRows: 273, denominator: 264, fraction: "0/264", complete: false })
    expect(value.counts["test-todo"]).toBe(264)
    expect(value.groups.reduce((sum, group) => sum + group.catalogRows, 0)).toBe(273)
  })
  it("refuses absent, duplicate or foreign result membership instead of synthesizing a status", () => {
    const input = { scope: "membership", catalogIds: ["a.one", "b.two"] }
    for (const rows of [
      results({ "a.one": "supported" }),
      [...results({ "a.one": "supported" }), ...results({ "a.one": "unsupported" })],
      results({ "a.one": "supported", "c.foreign": "test-todo" }),
    ]) {
      expect(() => scopeAggregate({ ...input, results: rows })).toThrow(/frozen catalogue membership/)
    }
  })
})
