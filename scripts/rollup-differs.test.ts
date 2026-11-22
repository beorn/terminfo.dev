/**
 * @failure A cell two same-suite contexts disagree on stops the whole site build; is counted Supported or
 *           Unsupported; an app whose every decided cell differs reads as having judged nothing; the disagreement
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
  storedCounts,
  storedRollup,
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
    // #37341 Q4: a bar input names its catalogue, so a cell left unpublished folds as a result not yet decided.
    const inputs = rollupInputs("codimac", {
      catalogIds: ["sgr.bold"],
      featureResults: {
        "sgr.bold": { featureId: "sgr.bold", status: DIFFERS_BY_CONTEXT },
      },
    } as never)
    expect(inputs).toEqual([
      { featureId: "sgr.bold", status: DIFFERS_BY_CONTEXT, derived: undefined, declared: undefined },
    ])
  })

  it("states the denominator and keeps the differs cell out of the supported numerator", () => {
    const aggregate = bar(["supported", DIFFERS_BY_CONTEXT])
    expect(aggregate.supported).toBe(1)
    expect(aggregate.denominator).toBe(2)
    // #37341 D2: the share is a count of Supported, never a percentage.
    expect(currentSupportedShare(aggregate)).toBe("1 supported")
    expect(aggregate.counts[DIFFERS_BY_CONTEXT]).toBe(1)
    expect(aggregate.idsByState[DIFFERS_BY_CONTEXT]).toEqual(["sgr.italic"])
  })

  it("counts a disagreeing cell as tested: both contexts measured it", () => {
    // #37341 D2: tested = supported + unsupported + untestable + differs-by-context.
    expect(currentCoverageSentence(bar(["supported", DIFFERS_BY_CONTEXT]))).toBe("2 of 2 tested")
  })

  it("prints a count, never the not-measured words, when every decided cell differs", () => {
    const aggregate = bar([DIFFERS_BY_CONTEXT, DIFFERS_BY_CONTEXT])
    expect(runDecidedNothing(aggregate.counts, aggregate.derived)).toBe(false)
    expect(currentSupportedShare(aggregate)).toBe("0 supported")
    expect(currentCoverageSentence(aggregate)).toBe("2 of 2 tested")
  })

  it("prints no differs words for a bar with no disagreement", () => {
    expect(currentCoverageSentence(bar(["supported", "unsupported"]))).toBe("2 of 2 tested")
    expect(currentSupportedShare(bar(["supported", "unsupported"]))).toBe("1 supported")
    expect(completenessTierOf({ "sgr.bold": "supported", "sgr.italic": "untestable" })).toEqual({
      completenessTier: 3,
      todo: 0,
      failure: 0,
      positions: 2,
    })
  })
})

describe("the build's own chain, from the join to what a page reads", () => {
  it("renders two joined contexts' disagreement as one open PROBE CONFLICT naming both (33587)", () => {
    const cell = (status: FeatureResultStatus, runId: string) => ({
      status,
      version: "1.0",
      suite: "suite-a",
      entryHash: "entry-a",
      sourceRevision: "a".repeat(40),
      runId,
    })
    const primary: ContextFacts = {
      key: "term:codimac",
      cells: { "sgr.bold": cell("supported", "run-primary"), "sgr.italic": cell("supported", "run-primary") },
    }
    const other: ContextFacts = {
      key: "term:mac-mini",
      cells: { "sgr.bold": cell("unsupported", "run-other"), "sgr.italic": cell("supported", "run-other") },
    }
    const joined = joinContextCells(primary, [other], [...CATALOG], () => null, [...CATALOG])
    const summary = {
      catalogIds: [...CATALOG],
      featureResults: Object.fromEntries(
        Object.entries(joined.cells).map(([featureId, entry]) => [featureId, { featureId, status: entry.status }]),
      ),
    } as never
    const aggregate = aggregateCurrentResults(rollupInputs("codimac", summary), [...CATALOG])
    expect(aggregate.counts[DIFFERS_BY_CONTEXT]).toBe(0)
    expect(aggregate.counts["probe-conflict"]).toBe(1)
    expect(currentSupportedShare(aggregate)).toBe("1 supported")
    // The open conflict is not tested; the agreeing cell is.
    expect(currentCoverageSentence(aggregate, [...CATALOG])).toBe("1 of 2 tested")
    // The page points a reader at the open cell; the row itself names both contexts and grades.
    expect(aggregate.idsByState["probe-conflict"]).toEqual(["sgr.bold"])
    expect(joined.cells["sgr.bold"]?.from).toEqual([
      { context: "term:codimac", status: "supported", runId: "run-primary" },
      { context: "term:mac-mini", status: "unsupported", runId: "run-other" },
    ])
  })

  it("declares the differs segment on every page that draws a bar", () => {
    const root = join(import.meta.dirname, "..")
    const pages: Array<[string, string]> = [
      // #37761: the home page draws every bar through SupportBar, whose segments are the one category list.
      ["docs/data/result-categories.ts", 'id: "differs-by-context"'],
      ["docs/index.md", "categoryIds(bar)"],
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

describe("stored shapes drop the bucket at zero and refuse a nonzero one", () => {
  it("drops a zero derived bucket from a stored count set", () => {
    const rollup = rollupTerminalStatuses({ "sgr.bold": "supported" }, ["sgr.bold"])
    expect(Object.keys(storedCounts(rollup.counts, "summary.json rollup kitty"))).toEqual([
      "supported",
      "unsupported",
      "untestable",
      "probe-todo",
      "probe-invalid",
      "probe-conflict",
    ])
  })

  it("refuses a nonzero derived bucket, naming the key and the file it would have hidden", () => {
    const rollup = rollupTerminalStatuses({ "sgr.bold": DIFFERS_BY_CONTEXT }, ["sgr.bold"])
    expect(() => storedCounts(rollup.counts, "summary.json rollup kitty")).toThrow(
      /summary\.json rollup kitty: counts\.differs-by-context is 1/,
    )
    expect(() => storedRollup(rollup, "summary.json rollup kitty")).toThrow(/differs-by-context is 1/)
  })

  it("reads zero supported in the bar and in the rollup when every decided cell differs", () => {
    const rollup = rollupTerminalStatuses({ "sgr.bold": DIFFERS_BY_CONTEXT }, ["sgr.bold"])
    expect(rollup.supportedPct).toBe(0)
    expect(
      currentSupportedShare(
        aggregateCurrentResults([{ featureId: "sgr.bold", status: DIFFERS_BY_CONTEXT }], ["sgr.bold"]),
      ),
    ).toBe("0 supported")
  })

  it("still reads null when nothing was decided at all", () => {
    const rollup = rollupTerminalStatuses({ "sgr.bold": "probe-todo" }, ["sgr.bold"])
    expect(rollup.supportedPct).toBeNull()
  })
})

describe("a bar input refuses a status the rollup does not know", () => {
  it("throws loudly rather than folding an unknown string into a bucket", () => {
    expect(() =>
      rollupInputs("codimac", {
        catalogIds: ["sgr.bold"],
        featureResults: { "sgr.bold": { featureId: "sgr.bold", status: "probably-fine" } },
      } as never),
    ).toThrow(/unknown feature status/)
  })
})
