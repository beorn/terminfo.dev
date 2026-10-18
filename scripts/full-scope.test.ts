/**
 * @failure The project's one arithmetic owner could count an overlapping exclusion twice, score a
 *   missing definition as an exclusion, print a score over an empty denominator, or let the 90% bar
 *   and NOT COLLECTED drift into second copies.
 * @level l2
 * @consumer the full-273 project scope arithmetic (docs/data/full-scope.ts, step 7)
 * @source-grep the real-catalog case pins 273 rows, the 13 design exclusions and the three missing
 *   definitions, so catalog drift fails here instead of silently changing every context's ceiling.
 * @testonly none
 */
import { describe, expect, it } from "vitest"
import { join } from "node:path"
import { loadFeatures } from "@terminfo/catalog"
import {
  DESIGN_EXCLUSION_IDS,
  MISSING_DEFINITION_IDS,
  notCollected,
  scopeAggregate,
  type ScopeInput,
} from "../docs/data/full-scope.ts"

const cells = (entries: Record<string, "supported" | "unsupported" | "inconclusive" | "error" | "untested">) => entries

describe("full-catalog scope arithmetic", () => {
  it("prints score, denominator, ceiling and inclusion together over the whole catalog", () => {
    const result = scopeAggregate({
      scope: "kitty/linux",
      catalogIds: ["a.one", "a.two", "a.three", "b.one", "b.two", "b.three"],
      cells: cells({
        "a.one": "supported",
        "a.two": "unsupported",
        "a.three": "inconclusive",
        "b.one": "supported",
        "b.two": "supported",
      }),
      designExclusions: [],
      missingDefinitions: [],
    })
    expect(result.catalogRows).toBe(6)
    expect(result.denominator).toBe(6)
    expect(result.decisive).toBe(4)
    expect(result.fraction).toBe("4/6")
    expect(result.pct).toBe(67)
    expect(result.ceiling).toBe("6/6")
    expect(result.included).toBe(false)
  })

  it("counts a design and an instrument exclusion once and keeps both causes named", () => {
    const result = scopeAggregate({
      scope: "kitty/linux",
      catalogIds: ["a.one", "a.two", "a.three", "b.one"],
      cells: cells({ "a.one": "supported", "a.two": "supported", "a.three": "untested", "b.one": "supported" }),
      designExclusions: ["a.two"],
      instrumentLimits: [
        { id: "a.two", cause: "one reviewed limit" },
        { id: "b.one", cause: "second limit" },
      ],
      missingDefinitions: [],
    })
    expect(result.excluded.map((entry) => entry.id)).toEqual(["a.two", "b.one"])
    expect(result.denominator).toBe(2)
    expect(result.decisive).toBe(1)
    expect(result.fraction).toBe("1/2")
    expect(result.ceiling).toBe("2/4")
    expect(result.counts.untested).toBe(1)
    expect(result.excludedObservations).toEqual([
      { id: "a.two", cause: "design", state: "supported" },
      { id: "b.one", cause: "instrument", state: "supported" },
    ])
    expect(result.groups.find((group) => group.key === "b")).toMatchObject({
      denominator: 0,
      fraction: "",
      pct: null,
      ceiling: "0/1",
      verdict: null,
      included: false,
    })
  })

  it("keeps a missing definition in the denominator and names it as open work", () => {
    const result = scopeAggregate({
      scope: "kitty/linux",
      catalogIds: ["a.one", "a.two"],
      cells: cells({ "a.one": "supported" }),
      designExclusions: [],
      missingDefinitions: ["a.two"],
    })
    expect(result.denominator).toBe(2)
    expect(result.decisive).toBe(1)
    expect(result.missingDefinitions).toEqual(["a.two"])
    expect(result.counts.untested).toBe(1)
  })

  it("refuses a missing definition that was also excluded", () => {
    expect(() =>
      scopeAggregate({
        scope: "kitty/linux",
        catalogIds: ["a.one"],
        cells: cells({}),
        designExclusions: ["a.one"],
        missingDefinitions: ["a.one"],
      }),
    ).toThrow(/missing definition a\.one is excluded/)
  })

  it("refuses an exclusion that is not a catalog row, naming it", () => {
    expect(() =>
      scopeAggregate({
        scope: "kitty/linux",
        catalogIds: ["a.one"],
        cells: cells({}),
        designExclusions: ["a.two"],
        missingDefinitions: [],
      }),
    ).toThrow(/design exclusion a\.two is not a catalog row/)
  })

  it("refuses a zero denominator instead of printing an empty score", () => {
    expect(() =>
      scopeAggregate({
        scope: "kitty/linux",
        catalogIds: ["a.one"],
        cells: cells({}),
        designExclusions: ["a.one"],
        missingDefinitions: [],
      }),
    ).toThrow(/zero denominator/)
  })

  it("refuses an instrument limit with no cause", () => {
    expect(() =>
      scopeAggregate({
        scope: "kitty/linux",
        catalogIds: ["a.one"],
        cells: cells({}),
        designExclusions: [],
        instrumentLimits: [{ id: "a.one", cause: " " }],
        missingDefinitions: [],
      }),
    ).toThrow(/carries no cause/)
  })

  it("scores each group separately with its own ceiling", () => {
    const result = scopeAggregate({
      scope: "kitty/linux",
      catalogIds: ["a.one", "a.two", "b.one", "b.two", "b.three"],
      cells: cells({ "a.one": "supported", "a.two": "supported", "b.one": "supported", "b.two": "error" }),
      designExclusions: ["b.three"],
      missingDefinitions: [],
    })
    expect(result.groups.map((group) => [group.key, group.fraction, group.ceiling, group.included])).toEqual([
      ["a", "2/2", "2/2", true],
      ["b", "1/2", "2/3", false],
    ])
    expect(result.groups.find((group) => group.key === "b")?.counts).toEqual({
      supported: 1,
      unsupported: 0,
      inconclusive: 0,
      error: 1,
      untested: 0,
    })
  })

  it("passes only at or above the ninety percent bar", () => {
    const ids = Array.from({ length: 10 }, (_, index) => `a.row${index}`)
    const pass = scopeAggregate({
      scope: "pass",
      catalogIds: ids,
      cells: Object.fromEntries(ids.map((id, index) => [id, index === 0 ? "inconclusive" : "supported"])),
      designExclusions: [],
      missingDefinitions: [],
    })
    expect(pass.pct).toBe(90)
    expect(pass.included).toBe(true)
    const fail = scopeAggregate({
      scope: "fail",
      catalogIds: ids,
      cells: Object.fromEntries(ids.map((id, index) => [id, index < 2 ? "inconclusive" : "supported"])),
      designExclusions: [],
      missingDefinitions: [],
    })
    expect(fail.pct).toBe(80)
    expect(fail.included).toBe(false)
  })

  it("renders NOT COLLECTED with its cause and no score", () => {
    const row = notCollected("kitty/linux", "no selected run")
    expect(row).toEqual({ scope: "kitty/linux", collected: false, cause: "no selected run" })
    expect(() => notCollected("kitty/linux", " ")).toThrow(/must name its cause/)
  })

  it("covers the real catalog: 273 rows, 13 design exclusions, three missing definitions", () => {
    const catalog = loadFeatures(join(import.meta.dirname, "..", "content"))
    const catalogIds = Object.keys(catalog)
    expect(catalogIds).toHaveLength(273)
    const input: ScopeInput = {
      scope: "real catalog",
      catalogIds,
      cells: cells({}),
    }
    const result = scopeAggregate(input)
    expect(new Set(result.excluded.map((entry) => entry.id))).toEqual(new Set(DESIGN_EXCLUSION_IDS))
    expect(result.denominator).toBe(273 - DESIGN_EXCLUSION_IDS.length)
    expect(result.missingDefinitions).toEqual(MISSING_DEFINITION_IDS)
    expect(result.ceiling).toBe("260/273")
    expect(result.decisive).toBe(0)
    expect(result.included).toBe(false)
  })
})
