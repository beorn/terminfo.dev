/**
 * @failure A whole-run summary prints "0/273 supported (0%)" for a run whose every cell is TEST TODO
 *   or TEST FAILURE, so an unmeasured run reads exactly like one that was measured and failed, and the
 *   terminal page's SEO description publishes the same false zero to search results.
 * @level l1
 * @consumer Terminal page run summary, home backend score, OS page score column, terminal SEO description
 * @testonly none
 */
import type { ProbeStatus } from "@terminfo/probe-defs"
import { execFileSync } from "node:child_process"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import {
  aggregateCurrentResults,
  currentSupportedShare,
  NOT_MEASURED_TEXT,
  runDecidedNothing,
} from "../docs/data/release-scope.ts"

const counts = (entries: Partial<Record<ProbeStatus, number>>): Record<ProbeStatus, number> => ({
  supported: 0,
  unsupported: 0,
  untestable: 0,
  "test-todo": 0,
  "test-failure": 0,
  ...entries,
})

/** The aggregate a page builds from one sealed run: results + its frozen catalog. */
const run = (entries: Partial<Record<ProbeStatus, number>>) => {
  const table = counts(entries)
  const results = (Object.entries(table) as Array<[ProbeStatus, number]>).flatMap(([status, n]) =>
    Array.from({ length: n }, (_, index) => ({
      featureId: `${status}.${index}`,
      status,
      attempt: { scope: "none" as const },
      tests: [],
    })),
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

  it("publishes honest terminal descriptions through the real page transform", () => {
    // @cto S2, peer-corrected (#dev/7 30784-7999d765-review): run the actual transformPageData the
    // site build calls, through the child-process config loader scripts/build-metadata.test.ts uses,
    // so this fails if config.ts ever publishes a measured-looking zero for an undecided run. A
    // static import would pull config.ts into the TypeScript program, which it is not part of today.
    const siteRoot = join(dirname(fileURLToPath(import.meta.url)), "..")
    const script = `
      const { default: config } = await import("./docs/.vitepress/config.ts")
      const describe = (pct, yes, total) => {
        const pageData = {
          relativePath: "terminals/windows-terminal.md",
          frontmatter: {},
          params: { backendName: "Windows Terminal", pct, yes, total, backendDescription: "Microsoft's terminal." },
        }
        config.transformPageData(pageData, {})
        return pageData.description
      }
      console.log(JSON.stringify({
        undecided: describe("", "0", "273"),
        zero: describe("0", "0", "273"),
        mixed: describe("13", "36", "273"),
      }))
    `
    const observed = JSON.parse(
      execFileSync("bun", ["-e", script], { cwd: siteRoot, encoding: "utf8", timeout: 30_000 }),
    ) as { undecided: string; zero: string; mixed: string }

    expect(observed.undecided).toBe(
      "Windows Terminal terminal emulator feature support: not measured yet. Microsoft's terminal.",
    )
    // Neither a percentage nor the unexplained 0/273 fraction may survive on the undecided branch.
    expect(observed.undecided).not.toContain("%")
    expect(observed.undecided).not.toContain("0/273")

    // A decided run keeps exactly the description it published before, a genuine zero included.
    expect(observed.zero).toBe(
      "Windows Terminal terminal emulator feature support: 0% (0/273 features). Microsoft's terminal.",
    )
    expect(observed.mixed).toBe(
      "Windows Terminal terminal emulator feature support: 13% (36/273 features). Microsoft's terminal.",
    )
  }, 40_000)
})
