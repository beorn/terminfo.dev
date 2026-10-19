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
import { darkSuitesForLineage, loadCandidate2Data } from "../docs/data/candidate-2.data.ts"
import { frozenSuiteIdFor } from "../docs/data/load-release-scope.ts"
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

  it("prints the reader's declared blocker, word for word, for a blocked context", () => {
    // @chief's acceptance condition: the dark contexts read NOT MEASURED with the cause, not a bare
    // suite refusal. The page prints the reader's reason verbatim, so this pins the two together.
    // Every live context now has a measurement. Keep the blocked branch exercised through the
    // existing historical witness, rather than require a terminal to remain unmeasured forever.
    const reason = "no collection on the required suite (27928)"
    const readerRow = reader.cohortRowForSelected(historicalSelected, uncollectedCohort, reason)
    const spy = vi.spyOn(reader, "buildReport").mockReturnValue({
      ...report,
      cohort: { ...uncollectedCohort, barRows: [readerRow] },
    })
    try {
      const [pageRow] = loadCandidate2Data().contexts
      expect(pageRow?.published).toBe(false)
      expect(pageRow?.reason).toBe(reason)
    } finally {
      spy.mockRestore()
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

  it("carries the ruled acceptance share only where a ruling puts library-only rows in the base", () => {
    const groupsByKey = new Map(data.groups.map((group) => [group.key, group]))
    for (const context of data.contexts.filter((row) => row.published)) {
      for (const share of context.groups) {
        const group = groupsByKey.get(share.key)
        if (!group) throw new Error(`${context.context} carries a group ${share.key} the page never claims`)
        // The base is a RULING per group, not a rule over `libraryOnly.length`. Scrollback's two
        // library-only rows are in its ruled 7/9 (chief 11cede0b); Reset's one is outside its
        // denominator (chief 450d65e4 (b)), which is what makes kitty and xterm 4/4 included.
        if (group.libraryOnly.length === 0 || !ACCEPTANCE_COUNTS_LIBRARY_ONLY.has(share.key)) {
          expect(share.acceptance, `${context.context} ${share.key}`).toBeNull()
          continue
        }
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
    // Re-pinned 2026-10-18 on 67ad: wezterm/linux is the published context this row reads for the
    // ruled 7/9 acceptance. The ruled basis does not move with the context.
    const wezterm = data.contexts.find((row) => row.context === "wezterm/linux")
    if (!wezterm?.published) throw new Error("wezterm/linux is not published; nothing to read")
    const scrollback = wezterm.groups.find((share) => share.key === "scrollback")
    if (!scrollback) throw new Error("wezterm/linux carries no scrollback group")
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

/**
 * The groups with per-context inclusion; other groups retain their global inclusion state. Reset
 * joined at @cto's c67af756 (2026-10-19): included per context on the contexts that clear 90, held
 * by name on those that do not, exactly as Editing 28022 and Character Sets 28025 closed.
 */
const PER_CONTEXT_INCLUDED = new Set(["editing", "charsets", "reset"])

/**
 * The groups whose RULED acceptance base counts their library-only rows: chief 11cede0b for
 * Scrollback (7/9). Reset is deliberately absent — @cto c67af756 (chief 450d65e4 (b)) keeps
 * reset.method outside its denominator, so its four scored rows are the basis.
 */
const ACCEPTANCE_COUNTS_LIBRARY_ONLY = new Set(["scrollback"])

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
      // Inclusion also requires that no context which held the group went dark: moving a holding
      // context out of the measurement may never improve the claim.
      expect(group.included).toBe(shares.length > 0 && below.length === 0 && group.darkHeldBy.length === 0)
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
    // The newly measured Kitty/macOS row holds every global group below the bar.
    expect(data.groups.filter((group) => group.included)).toEqual([])
    expect(data.groups.some((group) => !group.included)).toBe(true)
  })

  it("includes Editing, Character Sets and Reset on the contexts that clear the bar, and names the rest", () => {
    // Included per context on the measured contexts that clear 90 percent, every other measured
    // context held, and every context with no run on the required suite named not measured.
    // Linux-only until an all-platform collection lands on the live suite; see 30286. The required
    // suite is now f9450b3bc56a, which carries the five Linux contexts admitted on 2026-10-19 (28023)
    // and no macOS or Windows run at all, so the three darwin contexts that were held below the bar
    // on c24025ea22fc are unmeasured here rather than held, and the held set shrinks to the Linux
    // context that misses the bar. Charsets clears on all five Linux contexts; editing clears on four
    // and holds ghostty/linux. A collection that moves these numbers must change this table
    // deliberately, never loosen it.
    // Reset joined at @cto's c67af756 (2026-10-19): four scored rows, reset.method named outside
    // the denominator, so kitty and xterm read 4/4 included and the three contexts with an
    // inconclusive row (ghostty reset.decaln; wezterm, alacritty reset.sgr) are held by name.
    const clearing: Record<string, string[]> = {
      editing: ["kitty/linux", "wezterm/linux", "alacritty/linux", "xterm/linux"],
      charsets: ["kitty/linux", "ghostty/linux", "wezterm/linux", "alacritty/linux", "xterm/linux"],
      reset: ["kitty/linux", "xterm/linux"],
    }
    const below: Record<string, string[]> = {
      editing: ["ghostty/linux"],
      charsets: [],
      reset: ["ghostty/linux", "wezterm/linux", "alacritty/linux"],
    }
    const dark = [
      "terminal-app/macos",
      "iterm2/macos",
      "ghostty/macos",
      "alacritty/macos",
      "kitty/macos",
      "windows-terminal/windows",
    ]
    // The page must say all of it in the group's State cell, not only in its data.
    const page = readFileSync(join(root, "docs", "release", "candidate-2.md"), "utf8")
    expect(page).toContain("ruled for {{ group.ruledTotal }}, included on {{ group.includedOn.length }}")
    // The remainder only: a context that carries a dark hold is named in the hold clause with its
    // fraction, so listing it here as well would print it twice in one cell (30286 fix 2).
    expect(page).toContain("not measured: {{ unmeasuredWithoutHold(group).map((row) => row.context).join(', ') }}")
    for (const key of ["editing", "charsets", "reset"]) {
      const group = data.groups.find((entry) => entry.key === key)
      if (!group) throw new Error(`group ${key} is missing from the page`)
      expect(group.included, key).toBe(false)
      expect(group.includedOn, key).toEqual(clearing[key])
      expect(
        group.heldBy.map((row) => row.context),
        key,
      ).toEqual(below[key])
      // Every dark context is named, never counted, and carries its declared cause.
      expect(
        group.unmeasured.map((row) => row.context),
        key,
      ).toEqual(dark)
    }
  })

  it("never lets a public claim improve because a context went dark", () => {
    // @chief 2026-10-17: a public claim must never improve because data went dark. Re-pinned
    // 2026-10-18 after candidate 2 moved to c24025ea22fc, and re-pinned again after the hosted
    // c240 collection: three macOS contexts are now measured (and below the bar), so only
    // iterm2/macos and kitty/macos stay dark, and each group names the dark holds it keeps from
    // history and claims nothing on them. The rule itself is pinned by the mocked history test below ("reads a
    // dark context's hold from history..."); what is pinned here is the invariant that keeps the live
    // page honest — no group may name a dark context that is actually published, and a group held by
    // a below-bar context stays held and names it.
    for (const group of data.groups) {
      for (const row of group.darkHeldBy) {
        const context = data.contexts.find((entry) => entry.context === row.context)
        if (context?.published) throw new Error(`${group.key} names a published context as dark: ${row.context}`)
      }
    }
    const editing = data.groups.find((group) => group.key === "editing")
    if (!editing) throw new Error("editing group missing from the page")
    expect(editing.included).toBe(false)
    // Linux-only until an all-platform collection lands on the live suite; see 30286. On f9450b3bc56a
    // only the five Linux contexts have runs, so the three darwin contexts that were measured and held
    // below the bar on c24025ea22fc are dark here, and the held set is the one Linux context that misses
    // the bar. The invariant below is untouched: nothing dark is published and no claim improves.
    expect(editing.darkHeldBy.map((row) => row.context)).toEqual([
      "terminal-app/macos",
      "iterm2/macos",
      "ghostty/macos",
      "alacritty/macos",
      "kitty/macos",
      "windows-terminal/windows",
    ])
    expect(editing.heldBy.map((row) => row.context)).toEqual(["ghostty/linux"])

    const page = readFileSync(join(root, "docs", "release", "candidate-2.md"), "utf8")
    expect(page).toContain(
      "held by {{ group.darkHeldBy.map((row) => contextSentence(row.context) + ' (' + row.decisive + ' of ' + row.denominator + ')').join(', ') }}; that context is not measured, so the group is not claimed (30033)",
    )
    expect(page).toContain("ruled for {{ group.ruledTotal }}, included on {{ group.includedOn.length }}")
    expect(page).toContain("{{ darkRuledSentence(group) }} not measured (30033)")

    // Both ruled groups keep the ruling's six contexts: four included and the two macOS contexts the
    // ruling names. Linux-only until an all-platform collection lands on the live suite; see 30286. On
    // f9450b3bc56a those two macOS contexts have no run, so they are back to dark-ruled rather than held
    // below the bar, and the page names them as ruled-but-unmeasured. ruledTotal still carries the six,
    // so the page reads "ruled for six" instead of quietly shrinking to the contexts that clear (30033).
    const cleared: Record<string, string[]> = {
      editing: ["kitty/linux", "wezterm/linux", "alacritty/linux", "xterm/linux"],
      charsets: ["kitty/linux", "ghostty/linux", "wezterm/linux", "alacritty/linux", "xterm/linux"],
    }
    for (const key of ["editing", "charsets"]) {
      const group = data.groups.find((entry) => entry.key === key)
      if (!group) throw new Error(`group ${key} missing from the page`)
      expect(group.includedOn).toEqual(cleared[key])
      expect(group.darkRuled).toEqual(["ghostty/macos", "alacritty/macos"])
      // The ruled basis is six whether those two contexts are dark or measured below the bar: the
      // count may not shrink to the contexts that clear it.
      expect(group.ruledTotal).toBe(6)
      // Both ruled macOS contexts stay visible: with no run on the live suite they are named as
      // dark-ruled rather than held, and neither drops out of the page.
      expect(group.darkHeldBy.map((row) => row.context)).toEqual(
        expect.arrayContaining(["ghostty/macos", "alacritty/macos"]),
      )
    }
    // A new below-bar measurement can lower the global claim; it cannot be hidden as a dark context.
    const unicode = data.groups.find((group) => group.key === "unicode")
    if (!unicode) throw new Error("unicode group missing")
    expect(unicode.included).toBe(false)
    expect(unicode.heldBy.map((row) => row.context)).toEqual([])
    // The hold kitty/macos carried is kept in history and named as dark, never dropped.
    expect(unicode.darkHeldBy.map((row) => row.context)).toEqual(["kitty/macos"])
  })

  it("divides a group's acceptance basis once on both published and dark history rows", () => {
    // 30248: the ratified base already contains a group's library-only ids. Appending them again when
    // the acceptance basis is built counts those rows twice, which inflated Reset's denominator to 6
    // and Scrollback's to 12 on the dark history rows while the published rows read the correct 5 and 9.
    for (const group of data.groups) {
      if (group.libraryOnly.length === 0) continue
      // The held row's denominator is the group's RULED basis: the app-decidable rows, plus the
      // library-only rows only where a ruling puts them in the base (Scrollback 7/9). Reset divides
      // over 4, never 5 (c67af756).
      const expected =
        group.capabilities.length -
        group.unavailable.length -
        (ACCEPTANCE_COUNTS_LIBRARY_ONLY.has(group.key) ? 0 : group.libraryOnly.length)
      for (const row of [...group.heldBy, ...group.darkHeldBy]) {
        expect(row.denominator, `${group.key} ${row.context}`).toBe(expected)
      }
    }
    // The prose beside the basis must name the same numbers the rows carry: a page that still said
    // "reset over 5" would tell a reader Reset counts its library-only row, which c67af756 forbids.
    const page = readFileSync(join(root, "docs", "release", "candidate-2.md"), "utf8")
    expect(page).toContain("scrollback divides over 9")
    expect(page).toContain("Reset divides over 4")
    expect(page).not.toContain("reset over 5")
  })

  it("reads a dark context's hold from history when a newer off-freeze run takes selection", () => {
    const real = join(import.meta.dirname, "..", "content")
    const baseReport = reader.buildReport({ contentDir: real, cohort: reader.candidate2Cohort(real) })
    const cohort = baseReport.cohort
    if (!cohort) throw new Error("candidate2 cohort absent")
    // The predecessor the lineage names, not the frozen suite itself: candidate 2 reads c24025ea22fc
    // and the terminal-app run that holds Text is the 67ad1f1d1580 one the move left behind.
    const previous = "67ad1f1d1580"
    const hold = cohort.admittedRuns.find(
      (entry) => entry.run.suiteId === previous && entry.run.terminalId === "terminal-app" && entry.run.os === "macos",
    )
    if (!hold) throw new Error("previous-freeze terminal-app run absent")
    // A newer same-version capture at main takes selection, but it may not lift the hold: history
    // holds a group, it never claims one, and the selected run is never replaced.
    const displaced = { ...hold.run, suiteId: "45d6fda67445", runId: "displacing-run" }
    const barRows = cohort.barRows.map((row) =>
      row.context.terminalId === "terminal-app" && row.context.os === "macos"
        ? {
            context: row.context,
            measured: false as const,
            run: displaced,
            reason: "ineligible: selected run on suite 45d6fda67445, required c24025ea22fc",
          }
        : row,
    )
    const spy = vi.spyOn(reader, "buildReport").mockReturnValue({
      ...baseReport,
      cohort: { ...cohort, barRows, admittedRuns: [{ ...hold }, ...cohort.admittedRuns] },
    })
    try {
      const dataAtSelection = loadCandidate2Data()
      const text = dataAtSelection.groups.find((group) => group.key === "text")
      if (!text) throw new Error("text group missing")
      expect(text.included).toBe(false)
      expect(text.darkHeldBy.map((row) => row.context)).toEqual(["terminal-app/macos", "kitty/macos"])
      expect(text.darkHeldBy[0]).toMatchObject({ decisive: 17, denominator: 20 })
    } finally {
      spy.mockRestore()
    }
  })

  it("holds a dark context from a predecessor-suite run, not from the suite it reads", () => {
    const real = join(import.meta.dirname, "..", "content")
    const baseReport = reader.buildReport({ contentDir: real, cohort: reader.candidate2Cohort(real) })
    const cohort = baseReport.cohort
    if (!cohort) throw new Error("candidate2 cohort absent")
    const darkRun = cohort.admittedRuns.find(
      (entry) => entry.run.suiteId === "5753741410a9" && entry.run.terminalId === "wezterm" && entry.run.os === "linux",
    )
    if (!darkRun) throw new Error("predecessor-suite wezterm/linux admitted run absent")
    // The pointer suite's run for this context is not in the window, so the only history wezterm/linux
    // has is the predecessor suite's. A dark set read back from the current pointer would find no run
    // and silently drop this hold, which is exactly how the page would understate a dark group.
    const barRows = cohort.barRows.map((row) =>
      row.context.terminalId === "wezterm" && row.context.os === "linux"
        ? {
            context: row.context,
            measured: false as const,
            reason: "ineligible: selected run on suite 45d6fda67445, required c24025ea22fc",
          }
        : row,
    )
    const admittedRuns = cohort.admittedRuns.filter(
      (entry) =>
        !(entry.run.suiteId === "68847e4d5355" && entry.run.terminalId === "wezterm" && entry.run.os === "linux"),
    )
    const spy = vi
      .spyOn(reader, "buildReport")
      .mockReturnValue({ ...baseReport, cohort: { ...cohort, barRows, admittedRuns } })
    try {
      const scrollback = loadCandidate2Data().groups.find((group) => group.key === "scrollback")
      if (!scrollback) throw new Error("scrollback group missing")
      const ids = scrollback.capabilities.map((capability) => capability.id)
      // The acceptance basis is the app-decidable rows plus the library-only rows ONCE (30248): the
      // capability list already contains the library-only ids, so appending them again counted them twice.
      const decidableIds = ids.filter(
        (id) =>
          !scrollback.libraryOnly.some((capability) => capability.id === id) &&
          !scrollback.unavailable.some((capability) => capability.id === id),
      )
      const expected = reader.decisiveShare(darkRun.run.states, [
        ...decidableIds,
        ...scrollback.libraryOnly.map((capability) => capability.id),
      ])
      const held = scrollback.darkHeldBy.find((row) => row.context === "wezterm/linux")
      if (!held) throw new Error("wezterm/linux is not held by its predecessor-suite run")
      expect(held).toMatchObject({ decisive: expected.decisive, denominator: expected.denominator })
      expect(held.decisivePct).toBeLessThan(85)
    } finally {
      spy.mockRestore()
    }
  })

  it("a lineage never makes the suite the cohort reads dark", () => {
    // The reading suite can appear in the lineage itself after a pointer move onto it. Counting it as
    // history would let a claim rest on a run the same page also counts as measurement, so the filter
    // is the invariant, not an incidental subtraction.
    expect([...darkSuitesForLineage(["68847e4d5355", "c24025ea22fc", "5753741410a9"], "c24025ea22fc")]).toEqual([
      "68847e4d5355",
      "5753741410a9",
    ])
  })

  it("a run on the suite the cohort reads never holds a dark context, even when that suite is in the lineage", () => {
    // The cohort reads a lineage suite, as after a pointer move onto it: runs there are measurement,
    // so a context whose only history is there is not held from it. The page must subtract the suite
    // it reads, not only the helper.
    const real = join(import.meta.dirname, "..", "content")
    const baseReport = reader.buildReport({ contentDir: real, cohort: reader.candidate2Cohort(real) })
    const cohort = baseReport.cohort
    if (!cohort) throw new Error("candidate2 cohort absent")
    const isWezterm = (run: { terminalId: string; os: string }) => run.terminalId === "wezterm" && run.os === "linux"
    const below = cohort.admittedRuns.find((entry) => entry.run.suiteId === "5753741410a9" && isWezterm(entry.run))
    if (!below) throw new Error("predecessor-suite wezterm/linux admitted run absent")
    // The same below-bar states, on the suite the mocked cohort reads, and no other history.
    const onReadingSuite = { ...below, run: { ...below.run, suiteId: "68847e4d5355", runId: "reading-suite-run" } }
    const admittedRuns = [onReadingSuite, ...cohort.admittedRuns.filter((entry) => !isWezterm(entry.run))]
    const barRows = cohort.barRows.map((row) =>
      isWezterm(row.context)
        ? {
            context: row.context,
            measured: false as const,
            reason: "ineligible: selected run on suite 45d6fda67445, required 68847e4d5355",
          }
        : row,
    )
    const spy = vi.spyOn(reader, "buildReport").mockReturnValue({
      ...baseReport,
      cohort: { ...cohort, frozenSuiteId: "68847e4d5355", barRows, admittedRuns },
    })
    try {
      const scrollback = loadCandidate2Data().groups.find((group) => group.key === "scrollback")
      if (!scrollback) throw new Error("scrollback group missing")
      expect(scrollback.darkHeldBy.map((row) => row.context)).not.toContain("wezterm/linux")
    } finally {
      spy.mockRestore()
    }
  })

  it("prints a dark hold beside any head branch and never inside the measured denominator", () => {
    // 30286 fix (2), @cto ruling on ball 52d66ef8: the State cell head stops at includedOn or heldBy
    // for six of nine groups, so the history hold the reader already carries never reaches the page.
    // The clause is a sibling of the branch chain rather than a fifth head, and the measured
    // denominator never counts a context the same cell calls not measured.
    const page = readFileSync(join(root, "docs", "release", "candidate-2.md"), "utf8")
    expect(page).toContain("holding it on an earlier suite of this release, not measured on this suite")
    expect(page).toContain(
      'v-if="group.darkHeldBy.length > 0 && (group.included || group.includedOn.length > 0 || group.heldBy.length > 0)"',
    )
    expect(page).toContain("below the bar on {{ group.heldBy.length }} of {{ published.length }} measured contexts")
    expect(page).not.toContain("published.length + group.darkHeldBy")
    // The live case: Editing is included on four contexts and carries six dark holds, so the clause
    // has something to print exactly where the head stops at includedOn.
    const editing = data.groups.find((group) => group.key === "editing")
    if (!editing) throw new Error("editing group missing")
    expect(editing.includedOn.length).toBe(4)
    expect(editing.darkHeldBy.length).toBe(6)
    // And the other head that used to hide them: Scrollback stops at heldBy and carries six too.
    const scrollback = data.groups.find((group) => group.key === "scrollback")
    if (!scrollback) throw new Error("scrollback group missing")
    expect(scrollback.heldBy.length).toBeGreaterThan(0)
    expect(scrollback.darkHeldBy.length).toBe(6)
    // The "not measured" list is the remainder: a dark hold is always one of those contexts, so
    // printing both lists unchanged names each held context twice in the same cell.
    expect(page).toContain('v-if="unmeasuredWithoutHold(group).length > 0"')
    for (const group of data.groups) {
      const unmeasured = new Set(group.unmeasured.map((row) => row.context))
      for (const hold of group.darkHeldBy) {
        expect(unmeasured.has(hold.context), `${group.key} ${hold.context}`).toBe(true)
      }
    }
  })

  it("preserves global inclusion outside the per-context scope", () => {
    // The ruling names three groups (Reset joined at c67af756). A group outside it must not gain includedOn entries even where
    // its share clears the bar on a context: the page would then promote a held group.
    const outside = data.groups.filter((group) => !PER_CONTEXT_INCLUDED.has(group.key))
    expect(outside.length).toBeGreaterThan(0)
    for (const group of outside) expect(group.includedOn, group.key).toEqual([])
    const page = readFileSync(join(root, "docs", "release", "candidate-2.md"), "utf8")
    expect(page).toContain("Per-context inclusion is ruled for Editing, Character Sets and Reset")
    // The bottom scope bullet must agree with the lede and the State cells, not keep the old
    // page-wide-only definition that the per-context ruling replaced.
    expect(page).toContain("for Editing, Character Sets and Reset the page also says <strong>included on</strong>")
    expect(page).not.toContain("cleared the bar in every measured context")
    // An empty includedOn is a SCOPE result, never a measurement: a held group may clear some
    // contexts, so the page may not say no context clears the bar, and an included group must not
    // print an includedOn count that is empty by construction.
    expect(page).not.toContain("no context clears the bar")
    expect(page).toContain("below the bar on {{ group.heldBy.length }} of {{ published.length }} measured contexts")
    expect(page).not.toContain("every measured context ({{ group.includedOn.length }})")
    const measured = data.contexts.filter((row) => row.published).length
    expect(outside.filter((group) => group.heldBy.length < measured).length).toBeGreaterThan(0)
    // No measured context holds Unicode on the frozen suite c24025ea22fc: the one run that held it,
    // kitty/macos on 67ad1f1d1580, is ineligible now that candidate 2 reads c24025ea22fc. The
    // historical witness below still exercises an included group without a per-context claim.
    const unicode = data.groups.find((group) => group.key === "unicode")
    if (!unicode) throw new Error("unicode group is missing")
    expect(unicode.included).toBe(false)
    expect(unicode.heldBy.map((row) => row.context)).toEqual([])
    expect(unicode.includedOn).toEqual([])
    const historicalUnicode = historicalData.groups.find((group) => group.key === "unicode")
    expect(historicalUnicode?.included).toBe(true)
    expect(historicalUnicode?.includedOn).toEqual([])
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
