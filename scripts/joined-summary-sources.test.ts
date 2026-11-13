/**
 * @failure A joined app row whose grade comes from another context shows that context's evidence, but the
 *           published summary keeps only the primary's `sources`, so `sources[cell.origin.runId]` misses and
 *           the site's evidence cell throws "lacks source" during SSR (33979: 147 errors, Terminal.app 2.15 macOS).
 * @level    l1
 * @consumer terminfo.dev evidence cells (docs/.vitepress/theme/ResultEvidenceCell.vue) and the public API
 *           contract `context.sources[cell.origin.runId]` (docs/api.md).
 * @testonly none
 */
import { describe, expect, it } from "vitest"
import { joinContextCells, type ContextCellFacts, type ContextFacts } from "../docs/data/app-cells.ts"
import { composeJoinedSummary, type PublicContextSummary } from "../docs/data/public-results.ts"

const PRIMARY = 'app:terminal-app@["app","terminal-app","macos","25.4.0",null,null,null,null]'
const OTHER = 'app:terminal-app@["app","terminal-app","macos","26.0.0",null,null,null,null]'
const CATALOG = ["cursor.shape", "sgr.bold"]

const fact = (status: ContextCellFacts["status"], runId: string): ContextCellFacts => ({
  status,
  version: "2.15",
  suite: "suite-a",
  entryHash: "entry-a",
  sourceRevision: "a".repeat(40),
  runId,
})

/** The smallest public context the composer reads: its cells' origins and its sources. */
function context(key: string, runId: string, statuses: Record<string, string>): PublicContextSummary {
  return {
    contextKey: key,
    catalogIds: CATALOG,
    contributingRunIds: [runId],
    sources: { [runId]: { runId } },
    featureResults: Object.fromEntries(
      Object.entries(statuses).map(([featureId, status]) => [
        featureId,
        { featureId, status, origin: { runId, resultId: featureId } },
      ]),
    ),
    score: { supported: 0, all: CATALOG.length },
  } as unknown as PublicContextSummary
}

describe("a joined summary carries the receipt of every run its cells name", () => {
  it("adds the other context's source when that context decided a row the primary did not", () => {
    const primary = context(PRIMARY, "run-primary", { "cursor.shape": "probe-invalid", "sgr.bold": "supported" })
    const other = context(OTHER, "run-other", { "cursor.shape": "supported", "sgr.bold": "supported" })
    const facts = (summary: PublicContextSummary, runId: string): ContextFacts => ({
      key: summary.contextKey,
      cells: Object.fromEntries(
        Object.entries(summary.featureResults).map(([id, cell]) => [id, fact(cell.status as never, runId)]),
      ),
    })
    const app = joinContextCells(
      facts(primary, "run-primary"),
      [facts(other, "run-other")],
      CATALOG,
      () => null,
      CATALOG,
    )

    const summary = composeJoinedSummary(primary, app, { [PRIMARY]: primary, [OTHER]: other })

    expect(summary.featureResults["cursor.shape"]?.origin.runId).toBe("run-other")
    for (const [featureId, cell] of Object.entries(summary.featureResults)) {
      expect(summary.sources[cell.origin.runId], `${featureId} names ${cell.origin.runId}`).toBeDefined()
    }
    expect(Object.keys(summary.sources).sort()).toEqual(["run-other", "run-primary"])
    // The contributing list stays the primary's: the terminal page finds its analysis entry by exactly that list.
    expect(summary.contributingRunIds).toEqual(["run-primary"])
    // The primary's own decided row keeps the primary's evidence, and the primary keeps its own sources.
    expect(summary.featureResults["sgr.bold"]?.origin.runId).toBe("run-primary")
    expect(Object.keys(primary.sources)).toEqual(["run-primary"])
  })

  it("refuses by name when the other context cannot produce the receipt its cell names", () => {
    const primary = context(PRIMARY, "run-primary", { "cursor.shape": "probe-invalid", "sgr.bold": "supported" })
    const other = {
      ...context(OTHER, "run-other", { "cursor.shape": "supported", "sgr.bold": "supported" }),
      sources: {},
    }
    const app = joinContextCells(
      {
        key: PRIMARY,
        cells: { "cursor.shape": fact("probe-invalid", "run-primary"), "sgr.bold": fact("supported", "run-primary") },
      },
      [
        {
          key: OTHER,
          cells: { "cursor.shape": fact("supported", "run-other"), "sgr.bold": fact("supported", "run-other") },
        },
      ],
      CATALOG,
      () => null,
      CATALOG,
    )
    expect(() => composeJoinedSummary(primary, app, { [PRIMARY]: primary, [OTHER]: other })).toThrow(
      `Joined context ${OTHER} lacks source run-other for cursor.shape`,
    )
  })
})
