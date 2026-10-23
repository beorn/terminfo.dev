/**
 * @failure A whole-run summary prints "0/273 supported (0%)" for a run whose every cell is TEST TODO
 *   or TEST FAILURE, so an unmeasured run reads exactly like one that was measured and failed, and the
 *   terminal page's SEO description publishes the same false zero to search results.
 * @level l1
 * @consumer Terminal page run summary, home backend score, OS page score column, terminal SEO description
 * @testonly none
 */
import type { CapabilityStatus } from "@terminfo/probe-defs"
import { describe, expect, it } from "vitest"
import {
  aggregateCurrentResults,
  currentSupportedShare,
  NOT_MEASURED_TEXT,
  runDecidedNothing,
  supportedShareText,
} from "../docs/data/release-scope.ts"

const counts = (entries: Partial<Record<CapabilityStatus, number>>): Record<CapabilityStatus, number> => ({
  supported: 0,
  unsupported: 0,
  untestable: 0,
  "test-todo": 0,
  "test-failure": 0,
  ...entries,
})

/** The aggregate a page builds from one sealed run: results + its frozen catalog. */
const run = (entries: Partial<Record<CapabilityStatus, number>>) => {
  const table = counts(entries)
  const results = (Object.entries(table) as Array<[CapabilityStatus, number]>).flatMap(([status, n]) =>
    Array.from({ length: n }, (_, index) => ({ featureId: `${status}.${index}`, status })),
  )
  return aggregateCurrentResults(
    results,
    results.map((result) => result.featureId),
  )
}

describe("#30784 whole-run readout", () => {
  it("prints the not-measured words for a run that decided nothing, and the same numbers for one that did", () => {
    // Windows Terminal's current run c4be39f3: 251 TEST TODO + 22 TEST FAILURE of 273, nothing decided.
    const held = run({ "test-todo": 251, "test-failure": 22 })
    expect(held.denominator).toBe(273)
    expect(runDecidedNothing(held.counts)).toBe(true)
    expect(currentSupportedShare(held)).toBe(NOT_MEASURED_TEXT)
    expect(currentSupportedShare(held)).not.toMatch(/%/)

    // A decided run keeps exactly the line it printed before the fix, including a genuine zero.
    const measuredFail = run({ unsupported: 273 })
    expect(runDecidedNothing(measuredFail.counts)).toBe(false)
    expect(currentSupportedShare(measuredFail)).toBe("0/273 supported (0%)")

    const mixed = run({ supported: 36, unsupported: 137, "test-todo": 100 })
    expect(currentSupportedShare(mixed)).toBe("36/273 supported (13%)")
  })

  it("keeps the SEO share token on the same rule, so a description cannot publish 0% for an undecided run", () => {
    // `docs/terminals/[id].paths.ts` passes "" when the run has no percentage; config.ts asks this
    // function rather than assembling `pct%` itself.
    expect(supportedShareText("")).toBe(NOT_MEASURED_TEXT.toLowerCase())
    expect(supportedShareText("13")).toBe("13%")
    expect(supportedShareText("0")).toBe("0%")
    expect(`Terminal feature support: ${supportedShareText("")} (0/273 features)`).not.toContain("0%")
    expect(`Terminal feature support: ${supportedShareText("0")} (0/273 features)`).toContain("0% (0/273 features)")
  })
})
