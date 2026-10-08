/**
 * @failure Release 1 pages would read as measuring the whole catalog, so an unmeasured feature looks like a pass.
 * @level l2
 * @consumer terminfo.dev front page and every terminal page
 * @source-grep the VitePress pages and the probes.data.ts loader are wired by text, and the browser-bundled release-scope
 *   helper must import no node:fs; only a full site build exercises either at runtime
 * @testonly none
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { loadReleaseScope } from "../docs/data/load-release-scope.ts"
import {
  barOverMeasured,
  coverageSentence,
  supportedShare,
  isStaleSuite,
  staleCaption,
  tierLine,
} from "../docs/data/release-scope.ts"

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
    expect(tierLine(scope)).toBe("62 of 270 features (tier 1), measured per terminal; next tiers in progress")
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
      "62 of 270 features (tier 1), measured per terminal; next tiers in progress · measured October 4, 2026",
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

  it("names each row's SUPPORTED share over the 62, never as the decisive share", () => {
    const firstMeasured = scope.measuredIds[0]
    if (!firstMeasured) throw new Error("release scope has no measured ids")
    const oneSupported = barOverMeasured(
      { [firstMeasured]: { outcome: "supported", conclusive: true } },
      scope.measuredIds,
    )
    expect(supportedShare(oneSupported)).toBe(`${oneSupported.fillPct}% supported of 62`)
    expect(supportedShare(barOverMeasured({}, scope.measuredIds))).toBe("0% supported of 62")
    expect(supportedShare({ ...oneSupported, denominator: 0 })).toBe("No selected run")
  })

  it("names coverage over the 62 so unmeasured catalog features are not inconclusive", () => {
    const cells: Record<string, { outcome: "supported" | "inconclusive"; conclusive?: boolean }> = {}
    for (const row of scope.unmeasured) cells[row.id] = { outcome: "inconclusive" }
    const firstMeasured = scope.measuredIds[0]
    if (!firstMeasured) throw new Error("release scope has no measured ids")
    cells[firstMeasured] = { outcome: "supported", conclusive: true }
    const bar = barOverMeasured(cells, scope.measuredIds)
    expect(coverageSentence(bar)).toBe("1 supported · 0 unsupported · 0 inconclusive · 0 errors · 61 untested")
    expect(coverageSentence(barOverMeasured({}, scope.measuredIds))).toBe(
      "0 supported · 0 unsupported · 0 inconclusive · 0 errors · 62 untested",
    )
  })

  it("prints the D3 verdict beside the label on the front page, every terminal page and the loader", () => {
    const home = readFileSync(join(root, "docs", "index.md"), "utf8")
    const terminal = readFileSync(join(root, "docs", "terminals", "[id].md"), "utf8")
    const loader = readFileSync(join(root, "docs", "data", "probes.data.ts"), "utf8")
    expect(home).toContain("data.releaseVerdicts[backendName]")
    expect(home).toContain("verdict.text")
    expect(terminal).toContain("barVerdict(barOverMeasured(")
    expect(terminal).toContain("includedTierOneIds(data.releaseScope.measuredIds)")
    expect(terminal).toContain("measuredVerdict.text")
    expect(loader).toContain("includedTierOneIds(release.measuredIds)")
    expect(loader).toContain("releaseVerdicts[key] = d3Verdict(")
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
    expect(home).toContain("coverageSentence")
    // The label is one owner: the loader computes it with supportedShare, the page only prints it.
    expect(home).toContain("data.releaseShares[backendName]")
    expect(home).not.toMatch(/function coverageLabel[\s\S]*selected\.counts/)
    expect(terminal).toContain("measuredBar.fillPct")
    expect(terminal).toContain("% supported of")
    // One word, one number: the D3 verdict owns "decisive"; the bar's fill is "supported".
    expect(terminal).not.toContain("% decisive of")
    expect(home).not.toContain("decisive of ${bar.denominator}")
    expect(terminal).toContain("measuredBar.supported")
    expect(terminal).toContain("measuredBar.inconclusive")
    expect(terminal).toContain("measuredBar.untested")
    const loader = readFileSync(join(root, "docs", "data", "probes.data.ts"), "utf8")
    expect(loader).toContain("isStaleSuite")
    expect(loader).toContain("staleCaption")
    expect(loader).toContain("releaseStale")
    expect(loader).toContain("releaseShares[key] = supportedShare(")
    const helper = readFileSync(join(root, "docs", "data", "release-scope.ts"), "utf8")
    expect(helper).not.toMatch(/from ["']node:fs["']/)
  })

  it("names the 208 unmeasured features on every terminal page, including pages with no selected run", () => {
    const terminal = readFileSync(join(root, "docs", "terminals", "[id].md"), "utf8")
    const unmeasuredStart = terminal.indexOf('class="unmeasured"')
    const scoreCardStart = terminal.indexOf('v-if="!isHistorical && selectedRun"')
    expect(unmeasuredStart).toBeGreaterThan(-1)
    expect(scoreCardStart).toBeGreaterThan(-1)
    expect(unmeasuredStart).toBeLessThan(scoreCardStart)
    expect(terminal).toContain("data.releaseScope.unmeasured")
  })
})
