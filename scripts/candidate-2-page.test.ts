/**
 * @failure The candidate-2 preview page could publish a fraction measured on an OLDER probe suite,
 *   claim capabilities the cohort does not include, divide over a basis no reader uses, name a row it
 *   never shows, or grow a second classifier beside the reader — each of which puts a number on a
 *   public page that `bun run decisive-share --cohort candidate2` does not print, on a surface whose
 *   whole claim is that the two agree.
 * @level l2
 * @consumer terminfo.dev /release/candidate-2 (bead 28018 AC4)
 * @source-grep the page and its loader are wired by text (the VitePress page imports its `.data`
 *   module and the nav names the route), so only a real site build exercises the render; every
 *   assertion below runs the loader itself against the real content tree.
 * @testonly none
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"
import * as reader from "./decisive-share.ts"
import { loadCandidate2Data } from "../docs/data/candidate-2.data.ts"
import { inconclusiveRows } from "./decisive-share.ts"
import type { Candidate2GroupShare } from "../docs/data/candidate-2.data.ts"

const root = join(import.meta.dirname, "..")
const data = loadCandidate2Data()

// An explicit historical witness, never a substitute for the live frozen suite's empty rows.
// Reuse the admitted run and the reader's classifier; the page mapping still runs in full.
const report = reader.buildReport({
  contentDir: join(root, "content"),
  cohort: reader.candidate2Cohort(join(root, "content")),
})
const currentCohort = report.cohort
if (!currentCohort) throw new Error("candidate2 cohort absent")
const historicalRun = report.admittedRuns.find((run) => run.runId === "dfd4cd08416fb5f3be3eaeed5acce782")
if (!historicalRun) throw new Error("historical kitty/linux admitted run absent")
const historicalCohort = { ...currentCohort, frozenSuiteId: "c3d1fbb77561" }
const historicalSelected = reader.barRowForContext({
  context: { terminalId: "kitty", os: "linux" },
  candidates: [historicalRun],
  tier62Ids: report.tier62Ids,
  tier52Ids: report.tier52Ids,
})
const historicalRow = reader.cohortRowForSelected(historicalSelected, historicalCohort)
const uncollectedCohort = { ...currentCohort, frozenSuiteId: "0fb194cf6cea" }
const historicalReport = vi.spyOn(reader, "buildReport").mockReturnValue({
  ...report,
  cohort: { ...historicalCohort, barRows: [historicalRow] },
})
let historicalData: ReturnType<typeof loadCandidate2Data>
let uncollectedData: ReturnType<typeof loadCandidate2Data>
try {
  historicalData = loadCandidate2Data()
  historicalReport.mockReturnValue({
    ...report,
    cohort: {
      ...uncollectedCohort,
      barRows: [reader.cohortRowForSelected(historicalSelected, uncollectedCohort)],
    },
  })
  uncollectedData = loadCandidate2Data()
} finally {
  historicalReport.mockRestore()
}

/** The catalog of record: a page that labelled a row with its own id would disagree with this. */
function catalogNames(): Record<string, string> {
  const raw = JSON.parse(readFileSync(join(root, "content", "features.json"), "utf8")) as Record<
    string,
    string | { name?: string }
  >
  const names: Record<string, string> = {}
  for (const [id, entry] of Object.entries(raw)) {
    if (id.startsWith("$")) continue
    const name = typeof entry === "string" ? entry : entry.name
    if (name) names[id] = name
  }
  return names
}

describe("candidate-2 page: names come from the catalog, never from the id", () => {
  it("labels every rendered row with the catalog's own name", () => {
    const names = catalogNames()
    const rows = [...data.groups.flatMap((group) => group.capabilities), ...data.libraryOnly, ...data.unavailable]
    expect(rows.length).toBeGreaterThan(data.ratifiedCount)
    for (const row of rows) {
      expect(names[row.id], `${row.id} is missing from content/features.json`).toBeTruthy()
      expect(row.name, `${row.id} is labelled with something other than its catalog name`).toBe(names[row.id])
    }
  })
})

describe("candidate-2 page: publication rule (AC4)", () => {
  it("publishes a row exactly when its selected run sits on the frozen suite", () => {
    const published = data.contexts.filter((row) => row.published)
    const omitted = data.contexts.filter((row) => !row.published)
    // Live collection may advance: publication must follow the canonical eligible selection.
    expect(published.map((row) => row.runId)).toEqual(
      currentCohort.barRows.filter((row) => row.measured).map((row) => row.run.runId),
    )
    expect(data.contexts.length).toBeGreaterThan(0)
    // The same real historical run cannot become a measurement on the newer suite.
    expect(uncollectedData.contexts).toHaveLength(1)
    expect(uncollectedData.contexts.filter((row) => row.published)).toEqual([])
    expect(uncollectedData.measuredAt).toBe("")
    expect(uncollectedData.contexts[0]?.reason).toBe(
      "ineligible: selected run on suite c3d1fbb77561, required 0fb194cf6cea",
    )
    // review2: no published run means the group is held WITHOUT naming a context. The page names
    // that state in words instead of rendering "HOLD — 0 contexts below the bar".
    for (const group of uncollectedData.groups) {
      expect(group.included, group.key).toBe(false)
      expect(group.heldBy, group.key).toEqual([])
    }
    const historicalPublished = historicalData.contexts.filter((row) => row.published)
    expect(historicalPublished).toHaveLength(1)
    for (const row of [...published, ...historicalPublished]) {
      expect(row.suiteId, `${row.context} is published but names another suite`).toBe(
        historicalPublished.includes(row) ? historicalData.frozenSuiteId : data.frozenSuiteId,
      )
      expect(row.reason, `${row.context} is published and must carry no refusal reason`).toBeNull()
      expect(row.denominator).toBe(data.scoredCount)
    }
    for (const row of omitted) {
      // The reader's own reason, never a silent zero: a stale or absent run is named, not scored.
      expect(row.reason, `${row.context} is omitted without a reason`).toBeTruthy()
      expect(row.suiteId).toBeNull()
      expect(row.groups).toEqual([])
      expect(row.decisive).toBe(0)
    }
  })

  it("never publishes the same context twice", () => {
    const keys = data.contexts.map((row) => row.context)
    expect(new Set(keys).size).toBe(keys.length)
  })
})

describe("candidate-2 page: the two bases", () => {
  it("claims exactly the ratified cohort, split over the catalog's own groups", () => {
    const ids = data.groups.flatMap((group) => group.capabilities.map((row) => row.id))
    expect(ids.length).toBe(data.ratifiedCount)
    expect(new Set(ids).size).toBe(data.ratifiedCount)
    for (const group of data.groups) {
      for (const row of group.capabilities) {
        expect(row.id.split(".")[0], `${row.id} is filed under ${group.key}`).toBe(group.key)
      }
    }
  })

  it("divides every per-group fraction over the ids the suite covers, and names the rest", () => {
    const denominators = data.groups.reduce((count, group) => count + group.denominator, 0)
    expect(denominators).toBe(data.decidableCount)
    for (const group of data.groups) {
      const named = [...group.libraryOnly, ...group.unavailable].map((row) => row.id)
      const shown = group.capabilities.map((row) => row.id)
      expect(group.denominator).toBe(shown.length - named.length)
      for (const id of named) expect(shown).toContain(id)
    }
  })

  it("carries the ruled acceptance share wherever a group has library-only rows, and nowhere else", () => {
    const groupsByKey = new Map(data.groups.map((group) => [group.key, group]))
    for (const context of data.contexts.filter((row) => row.published)) {
      for (const share of context.groups) {
        const group = groupsByKey.get(share.key)
        if (!group) throw new Error(`${context.context} carries a group ${share.key} the page never claims`)
        if (group.libraryOnly.length === 0) {
          expect(share.acceptance, `${context.context} ${share.key}`).toBeNull()
          continue
        }
        // The acceptance base is the ruled one: the decidable rows PLUS the defined library-only rows.
        expect(share.acceptance, `${context.context} ${share.key}`).not.toBeNull()
        expect(share.acceptance?.denominator, `${context.context} ${share.key}`).toBe(
          share.denominator + group.libraryOnly.length,
        )
        expect(share.acceptance?.decisive ?? -1).toBeGreaterThanOrEqual(share.decisive)
        expect((share.acceptance?.decisive ?? 0) + (share.acceptance?.inconclusive.length ?? 0)).toBeLessThanOrEqual(
          share.acceptance?.denominator ?? 0,
        )
      }
    }
  })

  it("reads the Scrollback group at its ruled 7/9 with gaps on the contexts that decide it", () => {
    const kitty = data.contexts.find((row) => row.context === "kitty/linux")
    if (!kitty?.published) throw new Error("kitty/linux is not published; nothing to read")
    const scrollback = kitty.groups.find((share) => share.key === "scrollback")
    if (!scrollback) throw new Error("kitty/linux carries no scrollback group")
    expect(scrollback.decisive).toBe(7)
    expect(scrollback.denominator).toBe(7)
    expect(scrollback.acceptance).toMatchObject({
      decisive: 7,
      denominator: 9,
      decisivePct: 78,
      verdictLabel: "with gaps",
    })
  })

  it("names every moved-out row in the page's own lists, with none left over or double-counted", () => {
    const named = new Set([...data.libraryOnly, ...data.unavailable].map((row) => row.id))
    const grouped = new Set(
      data.groups.flatMap((group) => [...group.libraryOnly, ...group.unavailable].map((row) => row.id)),
    )
    expect(grouped).toEqual(named)
    expect(named.size).toBeGreaterThan(0)
  })

  it("keeps every published row's group denominators equal to the page's own, and its buckets whole", () => {
    const expected = data.groups.map((group) => `${group.key}:${group.denominator}`)
    for (const row of [...data.contexts, ...historicalData.contexts].filter((entry) => entry.published)) {
      expect(
        row.groups.map((group) => `${group.key}:${group.denominator}`),
        row.context,
      ).toEqual(expected)
      // The three buckets the row prints must partition its denominator exactly; a row that lost a
      // cell, or counted one twice, would otherwise read as a share the reader never computed.
      expect(row.decisive + row.inconclusive.length + row.remainder.length, row.context).toBe(row.denominator)
      for (const group of row.groups) {
        expect(group.decisive + group.inconclusive.length).toBeLessThanOrEqual(group.denominator)
      }
    }
  })
})

describe("candidate-2 page: the reader stays the one classifier", () => {
  it("takes its report and its rows from scripts/decisive-share.ts, never a private copy", () => {
    const loader = readFileSync(join(root, "docs", "data", "candidate-2.data.ts"), "utf8")
    expect(loader).toContain('from "../../scripts/decisive-share.ts"')
    for (const symbol of ["buildReport", "cohortCategories", "categoryShares", "inconclusiveRows"]) {
      expect(loader, `loader must reuse the reader's ${symbol}`).toContain(symbol)
    }
  })

  it("carries every inconclusive row's own words, and refuses a row with no cell", () => {
    for (const row of [...data.contexts, ...historicalData.contexts].filter((entry) => entry.published)) {
      for (const entry of row.inconclusive) expect(entry.featureId).toBeTruthy()
    }
    expect(() => inconclusiveRows({}, { inconclusiveIds: ["sgr.bold"] } as never)).toThrow(/no cell/)
  })
})

/** The two groups with per-context inclusion; other groups retain their global inclusion state. */
const PER_CONTEXT_INCLUDED = new Set(["editing", "charsets"])

describe("candidate-2 page: wiring", () => {
  // @chief cf1daa5a / review2 cd06b94c: the page may not claim a group included while a measured
  // context sits below the bar. Nothing else in this suite reads the inclusion state, so without
  // this the page could silently go back to a page-wide include claim.
  it("marks a group included only when every measured context clears its bar", () => {
    const publishedRows = data.contexts.filter((row) => row.published)
    for (const group of data.groups) {
      const shares = publishedRows.flatMap((row) =>
        row.groups.filter((entry) => entry.key === group.key).map((entry) => entry),
      )
      // The bar is the group's ruled acceptance basis where the reader carries one: the same basis
      // the loader uses, so the test cannot agree with a narrower app-observable fraction.
      const basis = (entry: Candidate2GroupShare) => entry.acceptance ?? entry
      const below = shares.filter((entry) => basis(entry).decisivePct < 90)
      expect(group.heldBy.map((row) => [row.context, row.decisive, row.denominator, row.decisivePct])).toEqual(
        below.map((entry) => [
          publishedRows.find((row) => row.groups.includes(entry))?.context,
          basis(entry).decisive,
          basis(entry).denominator,
          basis(entry).decisivePct,
        ]),
      )
      expect(group.included).toBe(shares.length > 0 && below.length === 0)
      // The per-context include is the SAME basis decision, not a second rule: for a group the
      // ruling names, a context is in includedOn exactly when its share clears the bar, and the two
      // lists partition the measured contexts. Every other group keeps its global state and carries no
      // per-context claim at all.
      const ruled = PER_CONTEXT_INCLUDED.has(group.key)
      expect(group.includedOn).toEqual(
        ruled
          ? shares
              .filter((entry) => basis(entry).decisivePct >= 90)
              .map((entry) => publishedRows.find((row) => row.groups.includes(entry))?.context)
          : [],
      )
      if (ruled) {
        expect(new Set([...group.includedOn, ...group.heldBy.map((row) => row.context)]).size).toBe(
          publishedRows.length,
        )
      }
      // A context with no published run is neither included nor held, and its own reason is kept.
      expect(group.unmeasured.map((row) => row.context)).toEqual(
        data.contexts.filter((row) => !row.published).map((row) => row.context),
      )
      for (const row of group.unmeasured) expect(row.reason, row.context).toBeTruthy()
    }
    expect(data.groups.some((group) => group.included)).toBe(true)
    expect(data.groups.some((group) => !group.included)).toBe(true)
  })

  it("includes Editing and Character Sets on the six ruled contexts and names the rest", () => {
    // Included per context on the six that clear 90 percent, every
    // other context held or named not measured, nothing claimed on ten. A new suite or collection
    // that moves these numbers must change this table deliberately, never loosen the assertion.
    const six = ["kitty/linux", "wezterm/linux", "alacritty/linux", "xterm/linux", "ghostty/macos", "alacritty/macos"]
    const below = ["ghostty/linux", "terminal-app/macos", "iterm2/macos", "windows-terminal/windows"]
    // The page must say all of it in the group's State cell, not only in its data.
    const page = readFileSync(join(root, "docs", "release", "candidate-2.md"), "utf8")
    expect(page).toContain("Included on {{ group.includedOn.length }} of")
    expect(page).toContain("not measured: {{ group.unmeasured.map((row) => row.context).join(', ') }}")
    for (const key of ["editing", "charsets"]) {
      const group = data.groups.find((entry) => entry.key === key)
      if (!group) throw new Error(`group ${key} is missing from the page`)
      expect(group.included, key).toBe(false)
      expect(group.includedOn, key).toEqual(six)
      expect(
        group.heldBy.map((row) => row.context),
        key,
      ).toEqual(below)
      // kitty/macOS carries a run the frozen suite does not admit: named, never counted.
      expect(
        group.unmeasured.map((row) => row.context),
        key,
      ).toEqual(["kitty/macos"])
      expect(group.unmeasured[0]?.reason, key).toContain(
        "ineligible: selected run on suite 9918f283121a, required 5753741410a9",
      )
    }
  })

  it("preserves global inclusion outside the two-group context scope", () => {
    // The ruling names two groups. A group outside it must not gain includedOn entries even where
    // its share clears the bar on a context: the page would then promote a held group.
    const outside = data.groups.filter((group) => !PER_CONTEXT_INCLUDED.has(group.key))
    expect(outside.length).toBeGreaterThan(0)
    for (const group of outside) expect(group.includedOn, group.key).toEqual([])
    const page = readFileSync(join(root, "docs", "release", "candidate-2.md"), "utf8")
    expect(page).toContain("Per-context inclusion is ruled for Editing and Character Sets only")
    // The bottom scope bullet must agree with the lede and the State cells, not keep the old
    // page-wide-only definition that the per-context ruling replaced.
    expect(page).toContain("for Editing and Character Sets the page also says <strong>included on</strong>")
    expect(page).not.toContain("cleared the bar in every measured context")
    // An empty includedOn is a SCOPE result, never a measurement: a held group may clear some
    // contexts, so the page may not say no context clears the bar, and an included group must not
    // print an includedOn count that is empty by construction.
    expect(page).not.toContain("no context clears the bar")
    expect(page).toContain("below the bar on {{ group.heldBy.length }} of {{ published.length }} measured contexts")
    expect(page).not.toContain("every measured context ({{ group.includedOn.length }})")
    const measured = data.contexts.filter((row) => row.published).length
    expect(outside.filter((group) => group.heldBy.length < measured).length).toBeGreaterThan(0)
    // The included branch still exists and reads truthfully: Unicode clears every measured context
    // even though it carries no per-context claim of its own.
    const unicode = data.groups.find((group) => group.key === "unicode")
    if (!unicode) throw new Error("unicode group is missing")
    expect(unicode.included).toBe(true)
    expect(unicode.includedOn).toEqual([])
    // Each prose surface must carry the corrected claim ITSELF: the note repeating it does not
    // excuse a lede that still lumps an included group into "every other group is held".
    const lede = page.match(/<p class="c2-lede">([\s\S]*?)<\/p>/)?.[1]
    const note = page.match(/<p class="c2-note">([\s\S]*?)<\/p>/)?.[1]
    if (!lede || !note) throw new Error("lede or note missing")
    expect(lede).toContain("keeps its previous state")
    expect(note).toContain("keeps its previous state")
    expect(lede).not.toContain("Every other group is <strong>held</strong>")
  })

  // review2: a published context must carry every included group's share (the loader now throws
  // rather than skipping it), and the page must name the no-measurement state instead of printing
  // "HOLD — 0 contexts below the bar". Both are read from the shipped tree, not a fixture.
  it("carries every group share in a published row and names the no-measurement state", () => {
    for (const row of data.contexts.filter((entry) => entry.published)) {
      for (const group of data.groups) {
        expect(
          row.groups.some((entry) => entry.key === group.key),
          `${row.context} is published without a ${group.key} share`,
        ).toBe(true)
      }
    }
    const page = readFileSync(join(root, "docs", "release", "candidate-2.md"), "utf8")
    expect(page).toContain("no eligible measured context yet")
    expect(page).not.toContain("left out of every fraction above")
    expect(page).not.toContain("included rows are decided by the parser surface")
  })

  it("the VitePress page reads its loader, and the nav names the route", () => {
    const page = readFileSync(join(root, "docs", "release", "candidate-2.md"), "utf8")
    expect(page).toContain("from '../data/candidate-2.data'")
    expect(page).toContain("terminfo v0.1 candidate 2")
    // The basis and the suite come from the loader: a literal hash typed into the page would be stale
    // the moment the declaration moves, which is the churn the epic already ruled against.
    expect(page).not.toMatch(/\b[0-9a-f]{12}\b/)
    const config = readFileSync(join(root, "docs", ".vitepress", "config.ts"), "utf8")
    expect(config).toContain('"/release/candidate-2"')
  })
})
