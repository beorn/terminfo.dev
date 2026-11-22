/**
 * @failure A baseline row whose every cell is held or uncollected prints "0%", reading the same as
 *   a terminal that was measured and failed, while a decided-unsupported row loses its honest zero.
 * @level l1
 * @consumer Home baseline cards and /baseline/:id coverage rows through docs/data/release-scope.ts
 * @testonly none
 */
import type { ProbeStatus } from "@terminfo/probe-defs"
import { describe, expect, it } from "vitest"
import { decisiveCells } from "../docs/data/release-scope.ts"
import { baselineReadout } from "../docs/data/baseline-readouts.ts"

const counts = (entries: Partial<Record<ProbeStatus, number>>): Record<ProbeStatus, number> => ({
  supported: 0,
  unsupported: 0,
  untestable: 0,
  "probe-todo": 0,
  "probe-invalid": 0,
  ...entries,
})

describe("#30763 baseline row readout", () => {
  it("prints counts on every row, so a row that decided nothing never reads as a measured zero (#37341 D2)", () => {
    // Windows Terminal's rich row: 88 PROBE TODO + 11 PROBE INVALID, nothing decided.
    const held = counts({ "probe-todo": 88, "probe-invalid": 11 })
    expect(decisiveCells(held)).toBe(0)
    expect(baselineReadout({ counts: held })).toEqual({ text: "0 supported · 0 of 99 tested", title: undefined })
    expect(baselineReadout({ counts: held }).text).not.toMatch(/%|PROBE/)

    // vt220.js rich: 36 judged unsupported, so its zero is a measured zero, and its tested count says so.
    const judged = counts({ unsupported: 36, untestable: 12, "probe-todo": 33, "probe-invalid": 18 })
    expect(decisiveCells(judged)).toBe(36)
    expect(baselineReadout({ counts: judged }).text).toBe("0 supported · 48 of 99 tested")

    // Alacritty on Windows rich: the one rich cell it genuinely supports.
    const oneSupported = counts({ supported: 1, "probe-todo": 81, "probe-invalid": 17 })
    expect(baselineReadout({ counts: oneSupported }).text).toBe("1 supported · 1 of 99 tested")
  })

  /**
   * #33441: the same predicate, asked by both pages. A row whose only decided cell is a derived Unsupported decided
   * nothing (#33019), so it must print the not-measured words rather than a measured-looking 0%.
   */
  it("a derived-only row prints counts with no percentage, the same on the home card and the baseline row", () => {
    const derivedOnly = {
      counts: counts({ unsupported: 1, "probe-todo": 5 }),
      derived: 1,
      pct: 0,
      score: { supported: 0, all: 6 },
    }
    expect(decisiveCells(derivedOnly.counts, derivedOnly.derived)).toBe(0)
    // #37341 D2: one readout serves both pages, so the two cannot disagree; a count never reads as a measured 0%.
    expect(baselineReadout(derivedOnly)).toEqual({ text: "0 supported · 1 of 6 tested", title: undefined })
    expect(baselineReadout(derivedOnly).text).not.toMatch(/%/)

    const decided = {
      counts: counts({ unsupported: 2, "probe-todo": 4 }),
      derived: 0,
      pct: 0,
      score: { supported: 0, all: 6 },
    }
    expect(baselineReadout(decided)).toEqual({ text: "0 supported · 2 of 6 tested", title: undefined })
  })

  /**
   * #30764 M4 removed the second case that read these numbers off the live round. That round leaves
   * content/ on Friday, and a fixture round cannot reproduce it: with only the checked-in runs, two
   * alacritty platforms become one ambiguous current target, which the live `default-contexts.json`
   * rows resolve and a fixture may not invent. The row semantics stay proved above with the same
   * literal counts, and Saturday's admission re-establishes the live numbers.
   */
})
