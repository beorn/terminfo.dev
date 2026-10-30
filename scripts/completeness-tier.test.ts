/**
 * @failure The hourly re-measure and the site grade a library's completeness by two copies of the four-way rule, or
 *   name it `tier` beside the Release 1 scope tier, so a library reads complete on one surface and broken on the other.
 * @level l1
 * @consumer tools/terminfo-remeasure.ts summary.json (imported from the pinned checkout) and the site's tier rendering
 * @testonly none
 */
import { describe, expect, it } from "vitest"
import { completenessTierOf } from "../docs/data/release-scope.ts"

describe("completenessTierOf: one four-way rule over the graded positions (#31733 A2, A3)", () => {
  it("reads each tier from the graded statuses alone", () => {
    expect(completenessTierOf({})).toEqual({ completenessTier: 0, todo: 0, failure: 0, positions: 0 })
    expect(
      completenessTierOf({ "sgr.bold": "test-todo", "sgr.faint": "test-failure", "sgr.italic": "supported" }),
    ).toEqual({ completenessTier: 1, todo: 1, failure: 1, positions: 3 })
    expect(completenessTierOf({ "sgr.bold": "test-failure", "sgr.faint": "unsupported" })).toEqual({
      completenessTier: 2,
      todo: 0,
      failure: 1,
      positions: 2,
    })
    expect(
      completenessTierOf({ "sgr.bold": "supported", "sgr.faint": "unsupported", "sgr.italic": "untestable" }),
    ).toEqual({ completenessTier: 3, todo: 0, failure: 0, positions: 3 })
  })

  it("puts an engine that recorded only environment rows at tier 0: nothing graded was measured", () => {
    const environmentOnly = { "device.env-term": "test-todo", "device.env-no-color": "test-failure" }
    expect(completenessTierOf(environmentOnly)).toEqual({ completenessTier: 0, todo: 0, failure: 0, positions: 0 })
    expect(completenessTierOf({ ...environmentOnly, "sgr.bold": "supported" })).toEqual({
      completenessTier: 3,
      todo: 0,
      failure: 0,
      positions: 1,
    })
  })

  it("never carries a `tier` field, which is the Release 1 scope tier", () => {
    expect(Object.keys(completenessTierOf({ "sgr.bold": "supported" })).sort()).toEqual([
      "completenessTier",
      "failure",
      "positions",
      "todo",
    ])
  })
})
