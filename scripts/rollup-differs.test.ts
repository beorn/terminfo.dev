/**
 * @failure A cell two same-suite contexts disagree on stops the whole site build; is counted Supported or
 *           Unsupported; an app whose every decided cell differs prints "Not measured yet"; the disagreement
 *           bucket is dropped from a bar, a coverage sentence or a page segment; or the derived bucket leaks
 *           into the stored status union or a stored-status reader.
 * @level    l1
 * @consumer Site bars: release-scope rollup, probes.data stats, and the Home/terminal/baseline pages.
 * @testonly none
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { FEATURE_RESULT_STATUSES, type FeatureResultStatus } from "../packages/probe-defs/src/types.ts"
import {
  APP_CELL_STATUSES,
  DIFFERS_BY_CONTEXT,
  joinContextCells,
  type AppCellStatus,
  type ContextFacts,
} from "../docs/data/app-cells.ts"
import {
  aggregateCurrentResults,
  completenessTierOf,
  currentCoverageSentence,
  currentSupportedShare,
  rollupInputs,
  rollupTerminalStatuses,
  runDecidedNothing,
} from "../docs/data/release-scope.ts"

const CATALOG = ["sgr.bold", "sgr.italic"] as const

function bar(statuses: readonly AppCellStatus[]) {
  return aggregateCurrentResults(
    CATALOG.map((featureId, index) => ({ featureId, status: statuses[index] ?? "probe-todo" })),
    [...CATALOG],
  )
}

describe("the shared rollup carries one bucket per AppCellStatus", () => {
  it("counts the six stored statuses plus the derived disagreement bucket, and nothing else", () => {
    const rollup = rollupTerminalStatuses({ "sgr.bold": DIFFERS_BY_CONTEXT, "sgr.italic": "supported" }, [...CATALOG])
    expect(Object.keys(rollup.counts).sort()).toEqual([...APP_CELL_STATUSES].sort())
    expect(rollup.counts[DIFFERS_BY_CONTEXT]).toBe(1)
    expect(rollup.counts.supported).toBe(1)
  })

  it("never scores a differs cell Supported or Unsupported, and never treats it as open", () => {
    const rollup = rollupTerminalStatuses({ "sgr.bold": DIFFERS_BY_CONTEXT, "sgr.italic": DIFFERS_BY_CONTEXT }, [
      ...CATALOG,
    ])
    expect(rollup.counts.supported).toBe(0)
    expect(rollup.counts.unsupported).toBe(0)
    expect(rollup.decisive).toBe(0)
    expect(rollup.open).toBe(0)
    // Decided: both contexts measured, they disagreed. Nothing is left to look at.
    expect(rollup.decided).toBe(2)
    expect(rollup.donePct).toBe(100)
    expect(rollup.completenessTier).toBe(3)
  })

  it("group rollups fold a differs cell as decided, not as a supported share", () => {
    const rollup = rollupTerminalStatuses({ "sgr.bold": DIFFERS_BY_CONTEXT, "sgr.italic": "supported" }, [...CATALOG])
    const family = rollup.families.sgr
    expect(family?.counts[DIFFERS_BY_CONTEXT]).toBe(1)
    expect(family?.decided).toBe(2)
    expect(family?.open).toBe(0)
    expect(family?.donePct).toBe(100)
  })
})

describe("one real disagreement renders instead of stopping the build", () => {
  it("passes a differs cell through the bar input, naming the cell", () => {
    const inputs = rollupInputs("codimac", {
      featureResults: {
        "sgr.bold": { featureId: "sgr.bold", status: DIFFERS_BY_CONTEXT },
      },
    } as never)
    expect(inputs).toEqual([{ featureId: "sgr.bold", status: DIFFERS_BY_CONTEXT, derived: undefined }])
  })

  it("states the denominator and keeps the differs cell out of the supported numerator", () => {
    const aggregate = bar(["supported", DIFFERS_BY_CONTEXT])
    expect(aggregate.supported).toBe(1)
    expect(aggregate.denominator).toBe(2)
    expect(currentSupportedShare(aggregate)).toBe("1/2 supported (50%)")
    expect(aggregate.counts[DIFFERS_BY_CONTEXT]).toBe(1)
    expect(aggregate.idsByState[DIFFERS_BY_CONTEXT]).toEqual(["sgr.italic"])
  })

  it("names the disagreeing cells a page can point a reader at, not just a colour", () => {
    expect(currentCoverageSentence(bar(["supported", DIFFERS_BY_CONTEXT]))).toBe(
      "1 Supported · 0 Unsupported · 1 Differs by context · 0 Untestable · 0 PROBE TODO · 0 PROBE INVALID · 0 PROBE CONFLICT",
    )
  })

  it("prints a percentage, never the not-measured words, when every decided cell differs", () => {
    const aggregate = bar([DIFFERS_BY_CONTEXT, DIFFERS_BY_CONTEXT])
    expect(runDecidedNothing(aggregate.counts, aggregate.derived)).toBe(false)
    expect(currentSupportedShare(aggregate)).toBe("0/2 supported (0%)")
  })

  it("leaves today's corpus readouts byte-identical: a bar with no disagreement prints no differs words", () => {
    expect(currentCoverageSentence(bar(["supported", "unsupported"]))).toBe(
      "1 Supported · 1 Unsupported · 0 Untestable · 0 PROBE TODO · 0 PROBE INVALID · 0 PROBE CONFLICT",
    )
    expect(currentSupportedShare(bar(["supported", "unsupported"]))).toBe("1/2 supported (50%)")
    expect(completenessTierOf({ "sgr.bold": "supported", "sgr.italic": "untestable" })).toEqual({
      completenessTier: 3,
      todo: 0,
      failure: 0,
      positions: 2,
    })
  })
})

describe("the build's own chain, from the join to what a page reads", () => {
  it("renders one disagreement from two joined contexts instead of failing the bar", () => {
    const cell = (status: FeatureResultStatus, runId: string) => ({ status, version: "1.0", suite: "suite-a", runId })
    const primary: ContextFacts = {
      key: "term:codimac",
      cells: { "sgr.bold": cell("supported", "run-primary"), "sgr.italic": cell("supported", "run-primary") },
    }
    const other: ContextFacts = {
      key: "term:mac-mini",
      cells: { "sgr.bold": cell("unsupported", "run-other"), "sgr.italic": cell("supported", "run-other") },
    }
    const joined = joinContextCells(primary, [other], [...CATALOG], [...CATALOG])
    const summary = {
      featureResults: Object.fromEntries(
        Object.entries(joined.cells).map(([featureId, entry]) => [featureId, { featureId, status: entry.status }]),
      ),
    } as never
    const aggregate = aggregateCurrentResults(rollupInputs("codimac", summary), [...CATALOG])
    expect(aggregate.counts[DIFFERS_BY_CONTEXT]).toBe(1)
    expect(currentSupportedShare(aggregate)).toBe("1/2 supported (50%)")
    // The page points a reader at the disagreeing cell; the row itself names both contexts and grades.
    expect(aggregate.idsByState[DIFFERS_BY_CONTEXT]).toEqual(["sgr.bold"])
    expect(joined.cells["sgr.bold"]?.from).toEqual([
      { context: "term:codimac", status: "supported", runId: "run-primary" },
      { context: "term:mac-mini", status: "unsupported", runId: "run-other" },
    ])
  })

  it("declares the differs segment on every page that draws a bar", () => {
    const root = join(import.meta.dirname, "..")
    const pages: Array<[string, string]> = [
      ["docs/index.md", "id: 'differs-by-context'"],
      ["docs/baseline/[id].md", "id: 'differs-by-context'"],
      ["docs/terminals/[id].md", "counts['differs-by-context']"],
    ]
    for (const [page, needle] of pages) expect(readFileSync(join(root, page), "utf8")).toContain(needle)
  })
})

describe("the derived bucket never becomes a stored status", () => {
  it("is not a FeatureResultStatus and is absent from the stored status list", () => {
    expect(FEATURE_RESULT_STATUSES).not.toContain(DIFFERS_BY_CONTEXT)
    expect(FEATURE_RESULT_STATUSES).toHaveLength(6)
  })

  it("is refused by the stored-status reader the hourly re-measure writes through", () => {
    expect(() => completenessTierOf({ "sgr.bold": DIFFERS_BY_CONTEXT })).toThrow(
      /stored statuses only.*differs-by-context/,
    )
  })
})

describe("a bar input refuses a status the rollup does not know", () => {
  it("throws loudly rather than folding an unknown string into a bucket", () => {
    expect(() =>
      rollupInputs("codimac", {
        featureResults: { "sgr.bold": { featureId: "sgr.bold", status: "probably-fine" } },
      } as never),
    ).toThrow(/unknown feature status/)
  })
})
