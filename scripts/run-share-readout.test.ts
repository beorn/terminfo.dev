/**
 * @failure A whole-run summary prints "0/273 supported (0%)" for a run whose every cell is PROBE TODO
 *   or PROBE INVALID, so an unmeasured run reads exactly like one that was measured and failed, and the
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
  currentCoverageSentence,
  currentSupportedShare,
  runDecidedNothing,
} from "../docs/data/release-scope.ts"

const counts = (entries: Partial<Record<ProbeStatus, number>>): Record<ProbeStatus, number> => ({
  supported: 0,
  unsupported: 0,
  untestable: 0,
  "probe-todo": 0,
  "probe-invalid": 0,
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

/** The one readout every page prints (#37341 D2). */
const readout = (aggregate: ReturnType<typeof run>) =>
  `${currentSupportedShare(aggregate)} · ${currentCoverageSentence(aggregate)}`

describe("#30784 whole-run readout", () => {
  it("prints counts for a run that decided nothing, which never read like a run that was measured and failed", () => {
    // Windows Terminal's current run c4be39f3: 251 PROBE TODO + 22 PROBE INVALID of 273, nothing decided.
    const held = run({ "probe-todo": 251, "probe-invalid": 22 })
    expect(held.denominator).toBe(273)
    expect(runDecidedNothing(held.counts)).toBe(true)
    expect(readout(held)).toBe("0 supported · 0 of 273 tested")
    expect(readout(held)).not.toMatch(/%/)

    // A measured fail tested every feature, so its zero differs from the undecided run's in the tested count.
    const measuredFail = run({ unsupported: 273 })
    expect(runDecidedNothing(measuredFail.counts)).toBe(false)
    expect(readout(measuredFail)).toBe("0 supported · 273 of 273 tested")

    const mixed = run({ supported: 36, unsupported: 137, "probe-todo": 100 })
    expect(readout(mixed)).toBe("36 supported · 173 of 273 tested")
  })

  it("publishes honest terminal descriptions through the real page transform", () => {
    // @cto S2, peer-corrected (#dev/7 30784-7999d765-review): run the actual transformPageData the
    // site build calls, through the child-process config loader scripts/build-metadata.test.ts uses,
    // so this fails if config.ts ever publishes a measured-looking zero for an undecided run. A
    // static import would pull config.ts into the TypeScript program, which it is not part of today.
    const siteRoot = join(dirname(fileURLToPath(import.meta.url)), "..")
    const script = `
      const { default: config } = await import("./docs/.vitepress/config.ts")
      const describe = (readout) => {
        const pageData = {
          relativePath: "terminals/windows-terminal.md",
          frontmatter: {},
          params: { backendName: "Windows Terminal", readout, backendDescription: "Microsoft's terminal." },
        }
        config.transformPageData(pageData, {})
        return pageData.description
      }
      const multi = (relativePath, params) => {
        const pageData = { relativePath, frontmatter: {}, params }
        config.transformPageData(pageData, {})
        return { title: pageData.title, description: pageData.description }
      }
      console.log(JSON.stringify({
        undecided: describe(""),
        zero: describe("0 supported · 0 of 264 tested"),
        mixed: describe("36 supported · 173 of 264 tested"),
        app: multi("terminals/app-alacritty.md", {
          backendName: "Alacritty (Linux)", terminalName: "Alacritty",
          osBackends: '["alacritty","alacritty@macos"]',
          readout: "144 supported · 200 of 264 tested", backendDescription: "GPU terminal.",
        }),
        compare: multi("compare/app-alacritty-vs-ghostty.md", {
          termALabel: "Alacritty (Linux)", termBLabel: "Ghostty (Linux)",
          pairTitle: "Alacritty vs Ghostty",
          osBackends: '["alacritty","ghostty","alacritty@macos","ghostty@macos"]',
        }),
      }))
    `
    const observed = JSON.parse(
      execFileSync("bun", ["-e", script], { cwd: siteRoot, encoding: "utf8", timeout: 30_000 }),
    ) as {
      undecided: string
      zero: string
      mixed: string
      app: { title: string; description: string }
      compare: { title: string; description: string }
    }

    expect(observed.undecided).toBe("Windows Terminal terminal emulator feature support. Microsoft's terminal.")
    // A page with no selected run publishes no number and no placeholder (@cto f6a09e55).
    expect(observed.undecided).not.toMatch(/not measured/i)
    expect(observed.undecided).not.toContain("%")
    expect(observed.undecided).not.toContain("0/273")

    // #37341 D2: a page with a run publishes the page's own readout, counts and never a percentage.
    expect(observed.zero).toBe(
      "Windows Terminal terminal emulator feature support: 0 supported · 0 of 264 tested. Microsoft's terminal.",
    )
    expect(observed.mixed).toBe(
      "Windows Terminal terminal emulator feature support: 36 supported · 173 of 264 tested. Microsoft's terminal.",
    )
    // A shared app route must not advertise only its legacy OS or that OS's score.
    expect(observed.app.title).toBe("Alacritty — Terminal Feature Support")
    expect(observed.app.description).toContain("each operating system")
    expect(observed.app.description).not.toContain("144 supported")
    expect(observed.compare.title).toBe("Alacritty vs Ghostty — Selected Terminal Observations")
    expect(observed.compare.description).toContain("each operating system")
  }, 40_000)
})
