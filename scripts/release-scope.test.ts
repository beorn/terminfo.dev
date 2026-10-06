/**
 * @failure Release 1 pages would read as measuring the whole catalog, so an unmeasured feature looks like a pass.
 * @level l2
 * @consumer terminfo.dev front page and every terminal page
 * @testonly none
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { barOverMeasured, isStaleSuite, loadReleaseScope, staleCaption, tierLine } from "../docs/data/release-scope.ts"

const root = join(import.meta.dirname, "..")

function catalogNames(): Record<string, { name: string }> {
  const raw = JSON.parse(readFileSync(join(root, "content", "features.json"), "utf8")) as Record<string, unknown>
  const names: Record<string, { name: string }> = {}
  for (const [id, value] of Object.entries(raw)) {
    if (id.startsWith("$")) continue
    names[id] = { name: typeof value === "string" ? value : String((value as { name: string }).name) }
  }
  return names
}

describe("release 1 measurement scope", () => {
  const catalog = catalogNames()
  const scope = loadReleaseScope({
    catalog,
    declarationPath: join(root, "content", "release-scope.json"),
  })

  it("declares 62 of 270 features as tier 1 query/reply", () => {
    expect(scope.catalogCount).toBe(270)
    expect(scope.measuredCount).toBe(62)
    expect(scope.unmeasured).toHaveLength(208)
    expect(scope.tier).toBe(1)
    expect(scope.method).toBe("query/reply")
    expect(tierLine(scope)).toBe("62 of 270 features (tier 1, query/reply)")
  })

  it("names every unmeasured catalog feature as not measured in this release", () => {
    const measured = new Set(scope.measuredIds)
    expect(scope.unmeasured.every((row) => catalog[row.id] && !measured.has(row.id))).toBe(true)
    expect(new Set(scope.unmeasured.map((row) => row.id)).size).toBe(208)
    expect(scope.unmeasured.every((row) => row.status === "not measured in this release")).toBe(true)
    expect(scope.unmeasured.every((row) => row.name.length > 0)).toBe(true)
  })

  it("dates the tier line and records a stale measurement as not re-measured since that date", () => {
    expect(tierLine(scope, { measuredAt: "2026-10-04T17:46:58Z" })).toBe(
      "62 of 270 features (tier 1, query/reply) · measured October 4, 2026",
    )
    expect(staleCaption("2026-10-04T17:46:58Z")).toBe("not re-measured since October 4, 2026")
    expect(isStaleSuite("current suite")).toBe(false)
    expect(isStaleSuite("older suite (256 probes)")).toBe(true)
    expect(isStaleSuite("partial (10 of 256 probes)")).toBe(true)
  })

  it("does not let supported outcomes outside the 62 fill the bar", () => {
    const cells: Record<string, { outcome: "supported" | "unsupported"; conclusive: boolean }> = {}
    for (const row of scope.unmeasured) cells[row.id] = { outcome: "supported", conclusive: true }
    const firstMeasured = scope.measuredIds[0]
    if (!firstMeasured) throw new Error("release scope has no measured ids")
    cells[firstMeasured] = { outcome: "unsupported", conclusive: true }
    const bar = barOverMeasured(cells, scope.measuredIds)
    expect(bar.denominator).toBe(62)
    expect(bar.supported).toBe(0)
    expect(bar.unsupported).toBe(1)
    expect(bar.fillPct).toBe(0)
    expect(bar.untested).toBe(61)
  })

  it("scores fill percent over the 62 even when every measured cell is untested", () => {
    const bar = barOverMeasured({}, scope.measuredIds)
    expect(bar.denominator).toBe(62)
    expect(bar.conclusive).toBe(0)
    expect(bar.fillPct).toBe(0)
    expect(bar.untested).toBe(62)
  })

  it("puts the tier line on the front page and every terminal page", () => {
    const home = readFileSync(join(root, "docs", "index.md"), "utf8")
    const terminal = readFileSync(join(root, "docs", "terminals", "[id].md"), "utf8")
    for (const source of [home, terminal]) {
      expect(source).toContain("data.releaseScope.line")
      expect(source).toContain("not measured in this release")
    }
    expect(terminal).toContain("staleCaption")
    expect(terminal).toContain("barOverMeasured")
    expect(home).toContain("bar.fillPct")
    const loader = readFileSync(join(root, "docs", "data", "probes.data.ts"), "utf8")
    expect(loader).toContain("isStaleSuite")
    expect(loader).toContain("staleCaption")
    expect(loader).toContain("releaseStale")
  })
})
