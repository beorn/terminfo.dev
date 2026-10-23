/**
 * @failure A baseline row whose every cell is held or uncollected prints "0%", reading the same as
 *   a terminal that was measured and failed, while a decided-unsupported row loses its honest zero.
 * @level l1
 * @consumer Home baseline cards and /baseline/:id coverage rows through docs/data/release-scope.ts
 * @testonly none
 */
import type { CapabilityStatus } from "@terminfo/probe-defs"
import { describe, expect, it } from "vitest"
import { decisiveCells, NOT_MEASURED_TEXT, notMeasuredReadout } from "../docs/data/release-scope.ts"

const counts = (entries: Partial<Record<CapabilityStatus, number>>): Record<CapabilityStatus, number> => ({
  supported: 0,
  unsupported: 0,
  untestable: 0,
  "test-todo": 0,
  "test-failure": 0,
  ...entries,
})

describe("#30763 baseline row readout", () => {
  it("owns only the not-measured branch; a decided row is the page's own text", () => {
    // Windows Terminal's rich row: 88 TEST TODO + 11 TEST FAILURE, nothing decided.
    const held = counts({ "test-todo": 88, "test-failure": 11 })
    expect(decisiveCells(held)).toBe(0)
    expect(notMeasuredReadout(held)).toEqual({
      text: NOT_MEASURED_TEXT,
      title: "0 Supported · 0 Unsupported · 0 Untestable · 88 TEST TODO · 11 TEST FAILURE",
    })
    expect(NOT_MEASURED_TEXT).not.toMatch(/%/)

    // vt220.js rich: 36 judged unsupported, so its zero is a measured zero.
    const judged = counts({ unsupported: 36, untestable: 12, "test-todo": 33, "test-failure": 18 })
    expect(decisiveCells(judged)).toBe(36)
    expect(notMeasuredReadout(judged)).toBeUndefined()

    // Alacritty on Windows rich: the one rich cell it genuinely supports.
    const oneSupported = counts({ supported: 1, "test-todo": 81, "test-failure": 17 })
    expect(notMeasuredReadout(oneSupported)).toBeUndefined()
  })

  /**
   * #30764 M4 removed the second case that read these numbers off the live round. That round leaves
   * content/ on Friday, and a fixture round cannot reproduce it: with only the checked-in runs, two
   * alacritty platforms become one ambiguous current target, which the live `default-contexts.json`
   * rows resolve and a fixture may not invent. The row semantics stay proved above with the same
   * literal counts, and Saturday's admission re-establishes the live numbers.
   */
})
