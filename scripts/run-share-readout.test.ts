/**
 * @failure A whole-run summary prints "0/273 supported (0%)" for a run whose every cell is TEST TODO
 *   or TEST FAILURE, so an unmeasured run reads exactly like one that was measured and failed, and the
 *   terminal page's SEO description publishes the same false zero to search results.
 * @level l1
 * @consumer Terminal page run summary, home backend score, OS page score column, terminal SEO description
 * @testonly none
 */
import type { CapabilityStatus } from "@terminfo/probe-defs"
import config from "../docs/.vitepress/config.ts"
import { describe, expect, it } from "vitest"
import {
  aggregateCurrentResults,
  currentSupportedShare,
  NOT_MEASURED_TEXT,
  runDecidedNothing,
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

  it("keeps the undecided terminal description honest through the real page transform", () => {
    // @cto S2: this drives the actual transformPageData the site build uses, so it fails if
    // config.ts ever goes back to interpolating params.pct itself. The terminal path passes pct: ""
    // when the run has no percentage (docs/terminals/[id].paths.ts:148).
    const describeTerminal = (pct: string, yes: string, total: string) => {
      const pageData = {
        relativePath: "terminals/windows-terminal.md",
        frontmatter: {} as Record<string, unknown>,
        params: { backendName: "Windows Terminal", pct, yes, total, backendDescription: "Microsoft's terminal." },
      }
      config.transformPageData(pageData as never)
      return (pageData as { description?: string }).description ?? ""
    }

    const undecided = describeTerminal("", "0", "273")
    expect(undecided).toBe(
      "Windows Terminal terminal emulator feature support: not measured yet. Microsoft's terminal.",
    )
    // Neither a percentage nor the unexplained 0/273 fraction may survive on the undecided branch.
    expect(undecided).not.toContain("%")
    expect(undecided).not.toContain("0/273")

    // A decided run keeps exactly the description it published before, a genuine zero included.
    expect(describeTerminal("0", "0", "273")).toBe(
      "Windows Terminal terminal emulator feature support: 0% (0/273 features). Microsoft's terminal.",
    )
    expect(describeTerminal("13", "36", "273")).toBe(
      "Windows Terminal terminal emulator feature support: 13% (36/273 features). Microsoft's terminal.",
    )
  })
})
