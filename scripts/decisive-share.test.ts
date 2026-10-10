/**
 * @failure The Release 1 bar's instrument would read a missing row as a decisive 0, fold a
 *   present-but-error row into inconclusive, guess which of several site-selected profiles is the
 *   (terminal, os) row, or drift the included 52 away from the audited mover list — so the D3 verdict
 *   ("pass" at 90% decisive of the included 52, "with gaps" from 70%, "fail" below, the fraction
 *   beside the label) would report the wrong verdict or the wrong denominator.
 * @level l2
 * @consumer Release 1 decisive-count reader (scripts/decisive-share.ts)
 * @source-grep nothing but this fixture exercises the error and untested buckets, the ambiguous
 *   context and the mover-list assertion: real admitted runs fill all 62 tier-1 rows, and the one
 *   real tie (kitty/linux carries a stale permissions-free entry beside the current one plus a
 *   current clipboard override) is separated by suite freshness, not by the fixture's shapes.
 * @testonly none
 */
import { describe, expect, it } from "vitest"
import { join } from "node:path"
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { createHash } from "node:crypto"
import { parseSuiteManifest } from "@terminfo/run-parser"
import {
  type ContextCandidate,
  type CohortBarRow,
  categoryBlockHeader,
  barRowForContext,
  buildReport,
  categoryShares,
  cohortCategories,
  cohortRowForSelected,
  formatCategoryRow,
  formatCohortRow,
  parseReaderArgs,
  decisiveShare,
  F2_MOVERS,
  formatBarRow,
  namedExceptionsLine,
  pickContextRun,
  INCLUDED_TIER1_COUNT,
  includedTierOneIds,
} from "./decisive-share.ts"
import { d3Verdict } from "../docs/data/release-scope.ts"
import { loadCategories } from "../docs/data/categories.ts"

const IDS = ["a.supported", "b.supported", "c.unsupported", "d.inconclusive", "e.error", "f.missing"]

const cells = {
  "a.supported": { outcome: "supported", conclusive: true },
  "b.supported": { outcome: "supported", conclusive: true },
  "c.unsupported": { outcome: "unsupported", conclusive: true },
  "d.inconclusive": { outcome: "inconclusive" },
  "e.error": { outcome: "error" },
}

function candidate(overrides: Partial<ContextCandidate> = {}): ContextCandidate {
  return {
    key: "app:alacritty@[linux]",
    kind: "app",
    terminalId: "alacritty",
    os: "linux",
    permissions: null,
    runId: "72cd4dea4fd2866e829c0ad7f0f0d718",
    version: "0.17.0",
    measuredAt: "2026-10-07T04:42:46.018Z",
    suiteId: "c6ec4ee8f580",
    // The label is display text; the relation is the machine fact. A fixture that means "older" says
    // so through overrides — never by re-parsing the label the change removed.
    suiteFreshness: "tree suite 21739d9e768f",
    suiteRelation: "tree",
    cells,
    ...overrides,
  }
}

describe("release 1 decisive-count reader", () => {
  it("names required catalog, cohort and frozen manifest failures instead of returning an empty report", () => {
    const contentDir = mkdtempSync(join(tmpdir(), "reader-required-content-"))
    const real = join(import.meta.dirname, "..", "content")
    const load = () => buildReport({ contentDir, cohort: "candidate2" })
    try {
      const features = join(contentDir, "features.json")
      expect(load).toThrow(features)
      writeFileSync(features, "{")
      expect(load).toThrow(features)
      writeFileSync(features, readFileSync(join(real, "features.json")))
      const declaration = join(contentDir, "release-scope-candidate2.json")
      expect(load).toThrow(declaration)
      writeFileSync(declaration, readFileSync(join(real, "release-scope-candidate2.json")))
      const manifest = join(contentDir, "suites", "a8bafe49cdd4.json")
      expect(load).toThrow(manifest)
      mkdirSync(join(contentDir, "suites"))
      writeFileSync(manifest, "{}")
      expect(load).toThrow(manifest)
      const realManifest = join(real, "suites", "a8bafe49cdd4.json")
      const raw = parseSuiteManifest(realManifest, readFileSync(realManifest, "utf8"))
      writeFileSync(manifest, JSON.stringify({ ...raw, probeHash: "wrong-suite" }))
      expect(load).toThrow(/probeHash wrong-suite does not match required a8bafe49cdd4/)
      expect(load).toThrow(manifest)
    } finally {
      rmSync(contentDir, { recursive: true })
    }
  })

  it("preserves the default report and accepts only the named CLI selectors and positionals", () => {
    const contentDir = join(import.meta.dirname, "..", "content")
    expect(buildReport({ contentDir, cohort: "candidate1" })).toEqual(buildReport({ contentDir }))
    expect(parseReaderArgs([])).toEqual({ cohort: "candidate1", terminalIds: [] })
    expect(parseReaderArgs(["kitty", "--cohort", "candidate2", "xterm"])).toEqual({
      cohort: "candidate2",
      terminalIds: ["kitty", "xterm"],
    })
    expect(() => parseReaderArgs(["--cohort", "candidate3"])).toThrow(/candidate1, candidate2/)
    expect(() => parseReaderArgs(["--unknown"])).toThrow(/unknown/i)
    // Two complete real-data projections took 5.7s under measured host load; keep this bound local.
  }, 15_000)

  it("keeps the selected non-frozen run ineligible instead of replacing it with a competing frozen run", () => {
    const frozen = candidate({
      suiteId: "a8bafe49cdd4",
      suiteFreshness: "older suite (256 probes)",
      suiteRelation: "older",
      runId: "frozen-history",
    })
    const newer = candidate({ key: "app:alacritty@new", suiteId: "new-suite", runId: "selected-new" })
    const row = barRowForContext({
      context: { terminalId: "alacritty", os: "linux" },
      candidates: [frozen, newer],
      tier62Ids: IDS,
      tier52Ids: IDS,
    })
    const result = cohortRowForSelected(row, {
      name: "candidate2",
      frozenSuiteId: "a8bafe49cdd4",
      measuredIds: IDS,
      decidableIds: IDS,
    })
    expect(result).toMatchObject({
      measured: false,
      run: { runId: "selected-new", suiteId: "new-suite" },
      reason: "ineligible: selected run on suite new-suite, required a8bafe49cdd4",
    })
    expect(result).not.toHaveProperty("share")
  })

  it("grades all 125 frozen IDs through D3 rounding and preserves missing or ambiguous selection", () => {
    const ids = Array.from({ length: 125 }, (_, i) => `classic.${i}`)
    const cohort = { name: "candidate2" as const, frozenSuiteId: "a8bafe49cdd4", measuredIds: ids, decidableIds: ids }
    const frozen = candidate({
      suiteId: cohort.frozenSuiteId,
      cells: Object.fromEntries(ids.slice(0, 112).map((id) => [id, { outcome: "supported", conclusive: true }])),
    })
    const context = { terminalId: "alacritty", os: "linux" }
    const row = barRowForContext({ context, candidates: [frozen], tier62Ids: IDS, tier52Ids: IDS })
    expect(cohortRowForSelected(row, cohort)).toMatchObject({
      measured: true,
      share: { denominator: 125, decisive: 112, verdict: { text: "pass · 112/125", pct: 90 } },
    })
    for (const candidates of [[], [frozen, { ...frozen, key: "second" }]]) {
      const absent = barRowForContext({ context, candidates, tier62Ids: IDS, tier52Ids: IDS })
      expect(absent.measured).toBe(false)
      expect(cohortRowForSelected(absent, cohort)).toEqual(absent)
    }
  })

  it("reports the ratified Candidate 2 cohort without dropping overlaps or its unavailable scrollback ID", () => {
    // The existing 52-ID reader cases cannot catch a named cohort being ignored or intersected
    // with the frozen schedule, which would silently shrink the approved 125-ID denominator.
    const args = { contentDir: join(import.meta.dirname, "..", "content"), cohort: "candidate2" as const }
    const report = buildReport(args)
    expect(report).toHaveProperty("candidate2.name", "candidate2")
    expect(report).toHaveProperty("candidate2.frozenSuiteId", "a8bafe49cdd4")
    expect(report).toHaveProperty(
      "candidate2.measuredIds",
      expect.arrayContaining(["cursor.position-report", "editing.decrqcra", "scrollback.viewport-hold-output"]),
    )
    expect(report).toHaveProperty("candidate2.measuredIds.length", 125)
    expect(report).toHaveProperty("candidate2.unavailableIds", ["scrollback.viewport-hold-output"])
    if (!report.candidate2) throw new Error("Candidate 2 report absent")
    // Independent ratification snapshot: SHA256 of JSON.stringify(sorted 125 IDs), not a prefix census.
    expect(
      createHash("sha256")
        .update(JSON.stringify([...report.candidate2.measuredIds].sort()))
        .digest("hex"),
    ).toBe("1a2012751b148b0230b97e27c74c11868ec36f1b3dd202fb798d42ec8abda17a")
    report.candidate2.barRows.forEach((row, i) => {
      const original = report.barRows[i]
      expect(row.context).toEqual(original?.context)
      if (original?.measured) expect(row).toHaveProperty("run", original.run)
    })
    expect(report.candidate2.admittedRuns.map((row) => row.run)).toEqual(report.admittedRuns)
    for (const row of report.candidate2.admittedRuns) {
      expect(row.measured).toBe(row.run.suiteId === "a8bafe49cdd4")
      // The RELEASE share is the operator's D3 over the ratified cohort (125); only the per-category
      // block divides over the decidable basis (@chief 2026-10-10T15:56Z).
      if (row.measured) expect(row.share.denominator).toBe(125)
      else {
        expect(row).not.toHaveProperty("share")
        expect(row.reason).toBe(`ineligible: admitted run on suite ${row.run.suiteId}, required a8bafe49cdd4`)
      }
    }
  })

  it("splits a fixture run into decisive, inconclusive and named remainder buckets", () => {
    const share = decisiveShare(cells, IDS)
    expect(share.denominator).toBe(6)
    expect(share.decisive).toBe(3)
    expect(share.decisivePct).toBe(50)
    expect(share.inconclusive).toBe(1)
    expect(share.inconclusivePct).toBe(17)
    expect(share.remainder).toEqual([
      { featureId: "e.error", bucket: "error" },
      { featureId: "f.missing", bucket: "untested" },
    ])
    expect(share.verdict.text).toBe("fail · 3/6")
  })

  it("names every row of a 62-row remainder as untested when only a few cells exist", () => {
    const measured = Array.from({ length: 62 }, (_, index) => `f.${index}`)
    const share = decisiveShare({ "f.0": { outcome: "supported", conclusive: true } }, measured)
    expect(share.decisive).toBe(1)
    expect(share.decisivePct).toBe(2)
    expect(share.inconclusive).toBe(0)
    expect(share.remainder).toHaveLength(61)
    expect(share.remainder.every((entry) => entry.bucket === "untested")).toBe(true)
  })

  it("counts a supported outcome on non-measuring evidence as inconclusive, not decisive", () => {
    const share = decisiveShare({ "a.supported": { outcome: "supported", conclusive: false } }, ["a.supported"])
    expect(share.decisive).toBe(0)
    expect(share.inconclusive).toBe(1)
    expect(share.remainder).toEqual([])
  })

  it("labels the D3 verdict: pass from 90% decisive of the included 52, with gaps from 70%, fail below, the fraction beside the label", () => {
    // 47/52 = 90.4% -> pass (the || ruling's own example), 46/52 = 88.5% -> with gaps,
    // 37/52 = 71.2% -> with gaps, 36/52 = 69.2% -> fail. The label reads the same rounded
    // percentage the fraction prints, so the two can never disagree.
    expect(d3Verdict(52, 52)).toMatchObject({ label: "pass", pct: 100, text: "pass · 52/52" })
    expect(d3Verdict(47, 52)).toMatchObject({ label: "pass", pct: 90, text: "pass · 47/52" })
    expect(d3Verdict(46, 52)).toMatchObject({ label: "with gaps", pct: 88, text: "with gaps · 46/52" })
    expect(d3Verdict(37, 52)).toMatchObject({ label: "with gaps", pct: 71 })
    expect(d3Verdict(36, 52)).toMatchObject({ label: "fail", pct: 69, text: "fail · 36/52" })
    expect(d3Verdict(0, 52).label).toBe("fail")

    const allDecisive = Object.fromEntries(IDS.map((id) => [id, { outcome: "supported", conclusive: true }]))
    const pass = decisiveShare(allDecisive, IDS)
    expect(pass.decisivePct).toBe(100)
    expect(pass.verdict.text).toBe("pass · 6/6")
    // A verdict over zero included capabilities is not "fail" — it is not measured, and it refuses.
    expect(() => d3Verdict(0, 0)).toThrow(/positive denominator/)
    expect(() => d3Verdict(3, 2)).toThrow(/0 <= decisive <= denominator/)
  })

  it("takes the audited F2 movers out of the declared 62 and refuses a mismatched list", () => {
    const declared = ["device.primary-da", ...F2_MOVERS, ...Array.from({ length: 51 }, (_, i) => `f.${i}`)]
    const included = includedTierOneIds(declared)
    expect(included).toHaveLength(INCLUDED_TIER1_COUNT)
    expect(included).not.toContain(F2_MOVERS[0])
    expect(() => includedTierOneIds(declared.slice(1))).toThrow(/included tier-1 set is 51/)
    expect(() => includedTierOneIds(declared.filter((id) => id !== F2_MOVERS[0]))).toThrow(/27832|F2 movers/)
  })

  it("resolves a context with no selected run as not measured, never as a zero reading", () => {
    const row = barRowForContext({
      context: { terminalId: "wezterm", os: "linux" },
      candidates: [],
      tier62Ids: IDS,
      tier52Ids: IDS,
    })
    expect(row.measured).toBe(false)
    if (row.measured) throw new Error("expected the wezterm row to be not measured")
    expect(row.reason).toContain("no selected run")
    const printed = formatBarRow(row).join("\n")
    expect(printed).toContain("not measured")
    expect(printed).not.toContain("%")
  })

  it("picks the default profile when a context has several selected entries, and reports a real tie", () => {
    const plain = candidate()
    const allow = candidate({ key: "allow", permissions: "clipboard: read=allow,write=allow" })
    const deny = candidate({ key: "deny", permissions: "clipboard: read=deny,write=allow" })
    expect(pickContextRun([plain])).toEqual({ run: plain, selection: "only current" })
    expect(pickContextRun([allow, plain, deny])).toEqual({ run: plain, selection: "default profile" })
    expect(pickContextRun([allow, deny])).toEqual({ ambiguous: ["allow", "deny"] })
    expect(pickContextRun([])).toBeUndefined()
  })

  it("prefers the current-suite candidates for the fallbacks: kitty/linux's stale default cannot be the bar's row", () => {
    const staleDefault = candidate({
      key: "config-none-old-suite",
      suiteId: "e81b6548c1c7",
      suiteFreshness: "older suite (1 probes)",
      suiteRelation: "older",
    })
    const currentDefault = candidate({ key: "nix-store-kitty", suiteId: "4482b8eb5823" })
    const currentOverride = candidate({
      key: "clipboard-allow",
      suiteId: "4482b8eb5823",
      permissions: "clipboard: read=allow,write=allow",
    })
    // kitty/linux's real shape: two permissions-free entries (one stale, one current) plus a
    // current-suite clipboard override. An older-suite entry can never be the measured row, so only
    // the current-suite entries decide, and the single permissions-free one of those is the row.
    expect(pickContextRun([staleDefault, currentOverride, currentDefault])).toEqual({
      run: currentDefault,
      selection: "default profile",
    })
    // The same set on one suite keeps the old behaviour: a fresh clipboard override is not a default.
    expect(pickContextRun([staleDefault, currentDefault, currentOverride])).toEqual({
      run: currentDefault,
      selection: "default profile",
    })
  })

  it("keeps two current-suite permissions-free candidates ambiguous, and leaves an all-stale set unchanged", () => {
    const first = candidate({ key: "current-a" })
    const second = candidate({ key: "current-b" })
    expect(pickContextRun([first, second])).toEqual({ ambiguous: ["current-a", "current-b"] })

    const staleA = candidate({ key: "stale-a", suiteFreshness: "older suite (1 probes)", suiteRelation: "older" })
    const staleB = candidate({ key: "stale-b", suiteFreshness: "older suite (1 probes)", suiteRelation: "older" })
    // No current-suite candidate at all: the fallbacks see the whole set, exactly as before.
    expect(pickContextRun([staleA, staleB])).toEqual({ ambiguous: ["stale-a", "stale-b"] })
    expect(pickContextRun([staleA])).toEqual({ run: staleA, selection: "only current" })
  })

  it("resolves the three-context xterm/linux tie by the reviewed default-context row, and names the tie without one", () => {
    const store = (key: string) => candidate({ key, runId: `xterm-${key}` })
    const three = [store("store-a"), store("store-b"), store("store-c")]
    const review = {
      contextKey: "store-b",
      reviewer: "@dev/3",
      reason: "the reviewed row for xterm/linux",
      sources: ["content/default-contexts.json"],
    }
    expect(pickContextRun(three, review)).toEqual({ run: three[1], selection: "reviewed default-context row" })
    expect(pickContextRun(three)).toEqual({ ambiguous: ["store-a", "store-b", "store-c"] })
    expect(pickContextRun(three, { ...review, contextKey: "store-z" })).toEqual({
      ambiguous: ["store-a", "store-b", "store-c"],
    })
  })

  it("does not apply a review that names another (terminal id, os) group's context", () => {
    const mac = candidate({ key: "macos", os: "macos" })
    const linuxDefault = candidate({ key: "linux-default" })
    const linuxAllow = candidate({ key: "linux-allow", permissions: "clipboard: read=allow,write=allow" })
    const macReview = {
      contextKey: "macos",
      reviewer: "@dev/3",
      reason: "the macOS row",
      sources: ["content/default-contexts.json"],
    }
    // The site keys the review by terminal id; the bar keys by terminal id + os. The macOS row is not
    // a tie-break for the linux group, so the linux tie still resolves on its own single default.
    expect(pickContextRun([linuxDefault, linuxAllow], macReview)).toEqual({
      run: linuxDefault,
      selection: "default profile",
    })
    expect(pickContextRun([mac], macReview)).toEqual({ run: mac, selection: "reviewed default-context row" })
  })

  it("prints the reviewed row it used, and names both failures, on a bar row", () => {
    const store = (key: string) => candidate({ key, runId: `xterm-${key}` })
    const three = [store("store-a"), store("store-b"), store("store-c")]
    const args = { context: { terminalId: "xterm", os: "linux" }, candidates: three, tier62Ids: IDS, tier52Ids: IDS }

    const measured = barRowForContext({
      ...args,
      reviewed: {
        contextKey: "store-b",
        reviewer: "@dev/3",
        reason: "the reviewed row for xterm/linux",
        sources: ["content/default-contexts.json"],
      },
    })
    expect(measured.measured).toBe(true)
    if (!measured.measured) throw new Error("expected the reviewed xterm row to be measured")
    expect(measured.run.key).toBe("store-b")
    expect(formatBarRow(measured).join("\n")).toContain("selected by the reviewed default-context row · store-b")

    const tied = barRowForContext(args)
    expect(tied.measured).toBe(false)
    if (tied.measured) throw new Error("expected the unreviewed xterm row to be not measured")
    expect(tied.reason).toContain("ambiguous current selection for xterm/linux")
    expect(tied.reason).toContain("store-a, store-b, store-c")

    const stale = barRowForContext({
      ...args,
      reviewed: {
        contextKey: "store-z",
        reviewer: "@dev/3",
        reason: "a row that is no longer current",
        sources: ["content/default-contexts.json"],
      },
    })
    expect(stale.measured).toBe(false)
    if (stale.measured) throw new Error("expected the stale review to fall back to not measured")
    expect(stale.reason).toContain("ambiguous current selection for xterm/linux")
    expect(stale.reason).toContain("store-a, store-b, store-c")
  })

  it("prints the included-52 clauses, the D3 verdict on the 52, the 62 as labelled context and the suite id", () => {
    const row = barRowForContext({
      context: { terminalId: "alacritty", os: "linux" },
      candidates: [candidate()],
      tier62Ids: IDS,
      tier52Ids: IDS.slice(0, 4),
    })
    expect(row.measured).toBe(true)
    if (!row.measured) throw new Error("expected the alacritty row to be measured")
    const printed = formatBarRow(row).join("\n")
    expect(printed).toContain("suite c6ec4ee8f580")
    expect(printed).toContain("decisive/52     3/4 = 75%  (pass >= 90%)")
    expect(printed).toContain("inconclusive/52 1/4 = 25%")
    expect(printed).toContain("verdict         with gaps · 3/4  (75% decisive of the included 4)")
    expect(printed).toContain(
      "context/62      decisive 3/6 = 50%, inconclusive 1/6 = 17%  (context only, not the verdict)",
    )
    // The row verdict states the D3 rule's own truth and does not claim the reader excludes the named
    // exceptions; the header names them once, with their ruling ids, instead.
    expect(printed).not.toContain("excluded by name")
    expect(namedExceptionsLine()).toContain("kitty/macos - 31/52 by contract")
    expect(namedExceptionsLine()).toContain("windows-terminal/windows")
  })

  it("reads the verdict on the included 52, not the 62, so a row decisive on 52 reads pass", () => {
    // 4/4 decisive on the included 52, but only 4/6 on the declared 62 (e.error and f.missing remain).
    const cells52 = {
      "a.supported": { outcome: "supported", conclusive: true },
      "b.supported": { outcome: "supported", conclusive: true },
      "c.unsupported": { outcome: "unsupported", conclusive: true },
      "d.inconclusive": { outcome: "supported", conclusive: true },
      "e.error": { outcome: "error" },
    }
    const row = barRowForContext({
      context: { terminalId: "kitty", os: "linux" },
      candidates: [candidate({ cells: cells52 })],
      tier62Ids: IDS,
      tier52Ids: IDS.slice(0, 4),
    })
    expect(row.measured).toBe(true)
    if (!row.measured) throw new Error("expected the kitty row to be measured")
    const printed = formatBarRow(row).join("\n")
    expect(printed).toContain("decisive/52     4/4 = 100%")
    expect(printed).toContain("verdict         pass · 4/4")
    // The 62 line is context only: it differs from the 52 and does not decide the verdict.
    expect(printed).toContain("context/62      decisive 4/6 = 67%")
  })
})

describe("per-category decisive share (28018 AC2)", () => {
  const contentDir = join(import.meta.dirname, "..", "content")
  const catalog = loadCategories(contentDir)

  it("partitions the real decidable cohort into the nine categories.json categories, in catalog order", () => {
    // The reader must NOT drop or double-count a class: the nine categories are the site's own
    // categories.json keys, partitioned over the decidable basis (Scrollback loses its one
    // unavailable id), so the derived counts are 32/22/20/11/17/9/5/4/4 = 124.
    const report = buildReport({ contentDir, cohort: "candidate2" })
    if (!report.candidate2) throw new Error("Candidate 2 report absent")
    expect(report.candidate2.measuredIds.length).toBe(125)
    expect(report.candidate2.decidableIds.length).toBe(124)
    const categories = cohortCategories(report.candidate2.decidableIds, catalog)
    expect(categories.map((category) => category.key)).toEqual([
      "sgr",
      "cursor",
      "text",
      "erase",
      "editing",
      "scrollback",
      "reset",
      "charsets",
      "unicode",
    ])
    expect(categories.map((category) => category.ids.length)).toEqual([32, 22, 20, 11, 17, 9, 5, 4, 4])
    expect(categories.map((category) => category.label)).toEqual([
      "SGR (Text Styling)",
      "Cursor",
      "Text",
      "Erase",
      "Editing",
      "Scrollback",
      "Reset",
      "Character Sets",
      "Unicode",
    ])
    // The union is exactly the cohort: no id falls in two categories, and none is left out.
    const assigned = categories.flatMap((category) => category.ids)
    expect(assigned.length).toBe(124)
    expect(new Set(assigned).size).toBe(124)
  }, 15_000)

  it("refuses a feature id whose prefix is not a categories.json key instead of dropping it", () => {
    expect(() => cohortCategories(["sgr.bold", "bogus.x"], catalog)).toThrow(/prefix "bogus"/)
  })

  it("loads the category catalog through the one typed loader and refuses a malformed catalog", () => {
    const dir = mkdtempSync(join(tmpdir(), "categories-loader-"))
    try {
      expect(() => loadCategories(join(dir, "absent"))).toThrow(/Missing required category catalog/)
      writeFileSync(join(dir, "categories.json"), JSON.stringify({ sgr: { order: 1, description: "x" } }))
      expect(() => loadCategories(dir)).toThrow(/category "sgr" is missing a label/)
      writeFileSync(join(dir, "categories.json"), "[]")
      expect(() => loadCategories(dir)).toThrow(/expected a category catalog object/)
    } finally {
      // raw-delete-allow: standalone component repository whose CI installs without hh's workspace, so removely is unavailable; dir is this test's own mkdtemp scratch root
      rmSync(dir, { recursive: true })
    }
  })

  it("prints one line per category — the fraction beside the label — with the remainder named beneath", () => {
    const categories = cohortCategories(["sgr.a", "sgr.b", "cursor.a", "erase.a"], catalog)
    expect(categories.map((category) => category.key)).toEqual(["sgr", "cursor", "erase"])
    const cells = {
      "sgr.a": { outcome: "supported", conclusive: true },
      "sgr.b": { outcome: "inconclusive" },
      "cursor.a": { outcome: "supported", conclusive: true },
      "erase.a": { outcome: "error" },
    }
    const labelWidth = Math.max(...categories.map((category) => category.label.length))
    const shares = categoryShares(cells, categories)
    const sgr = shares.find((entry) => entry.category.key === "sgr")
    if (!sgr) throw new Error("sgr share absent")
    expect(sgr.share).toMatchObject({ denominator: 2, decisive: 1, verdict: { label: "fail" } })
    const printed = formatCategoryRow(sgr.category, sgr.share, labelWidth).join("\n")
    expect(printed).toContain("SGR (Text Styling)")
    expect(printed).toContain("1/2 = 50% · fail")
    expect(printed).not.toContain("fail · 1/2")
    const erase = shares.find((entry) => entry.category.key === "erase")
    if (!erase) throw new Error("erase share absent")
    expect(erase.share.remainder).toEqual([{ featureId: "erase.a", bucket: "error" }])
    expect(formatCategoryRow(erase.category, erase.share, labelWidth).join("\n")).toContain(
      "remainder    1 rows: erase.a (error)",
    )
  })

  it("keeps each category's remainder disjoint — an error in one category never bleeds into another", () => {
    const categories = cohortCategories(["sgr.a", "cursor.a", "cursor.b"], catalog)
    const cells = { "sgr.a": { outcome: "error" }, "cursor.a": { outcome: "supported", conclusive: true } }
    const shares = categoryShares(cells, categories)
    const sgr = shares.find((entry) => entry.category.key === "sgr")
    const cursor = shares.find((entry) => entry.category.key === "cursor")
    if (!sgr || !cursor) throw new Error("category share absent")
    expect(sgr.share.remainder.map((row) => row.featureId)).toEqual(["sgr.a"])
    // cursor.b has no cell: untested, and it belongs to cursor, not sgr.
    expect(cursor.share.remainder.map((row) => row.featureId)).toEqual(["cursor.b"])
  })

  it("grades categories independently: a context passes overall while one of its categories fails", () => {
    const ids = [...Array.from({ length: 9 }, (_, index) => `sgr.${index}`), "cursor.0"]
    const categories = cohortCategories(ids, catalog)
    const cells = Object.fromEntries([
      ...Array.from({ length: 9 }, (_, index) => [`sgr.${index}`, { outcome: "supported", conclusive: true }]),
      ["cursor.0", { outcome: "error" }],
    ])
    expect(decisiveShare(cells, ids)).toMatchObject({ denominator: 10, decisive: 9, verdict: { label: "pass" } })
    const shares = categoryShares(cells, categories)
    expect(shares.find((entry) => entry.category.key === "sgr")?.share.verdict.label).toBe("pass")
    expect(shares.find((entry) => entry.category.key === "cursor")?.share.verdict.label).toBe("fail")
  })

  it("emits the per-category block for a measured context and none for a not-measured one", () => {
    const categories = cohortCategories(["sgr.a"], catalog)
    const labelWidth = Math.max(...categories.map((category) => category.label.length))
    const cells = { "sgr.a": { outcome: "supported", conclusive: true } }
    const measured: CohortBarRow = {
      context: { terminalId: "kitty", os: "linux" },
      selection: "only current",
      measured: true,
      run: candidate({ cells }),
      share: decisiveShare(cells, ["sgr.a"]),
    }
    const measuredLines = formatCohortRow(measured, categories, labelWidth)
    expect(
      measuredLines.some(
        (line) => line.includes("CATEGORIES OF THE") && line.includes("with a probe in required suite"),
      ),
    ).toBe(true)
    expect(measuredLines.some((line) => line.includes("SGR (Text Styling)"))).toBe(true)
    const absent: CohortBarRow = {
      context: { terminalId: "windows-terminal", os: "windows" },
      measured: false,
      reason: "not measured — no selected run",
    }
    const absentLines = formatCohortRow(absent, categories, labelWidth)
    expect(absentLines.some((line) => line.includes("CATEGORIES OF THE"))).toBe(false)
    expect(absentLines.join("\n")).toContain("not measured")
  })

  it("names the block 'categories' and never 'group' — features.json already owns 'group'", () => {
    // The guard is on the block's OWN header and label, not on remainder feature ids, so a future
    // feature id containing "group" cannot fail it (the @cto note).
    const header = categoryBlockHeader(125, 124, "a8bafe49cdd4")
    expect(header).toContain("CATEGORIES OF THE 125")
    expect(header.toLowerCase()).not.toContain("group")
    const categories = cohortCategories(["sgr.a"], catalog)
    const cells = { "sgr.a": { outcome: "supported", conclusive: true } }
    const printed = formatCategoryRow(categories[0]!, decisiveShare(cells, ["sgr.a"]), 19)
    expect(printed[0]).toContain("SGR (Text Styling)")
    expect(printed[0]!.toLowerCase()).not.toContain("group")
  })

  it("names the unavailable id beside each fraction — the release line stays /125, the category line is /9", () => {
    const report = buildReport({ contentDir, cohort: "candidate2" })
    if (!report.candidate2) throw new Error("Candidate 2 report absent")
    // The ratified cohort is still 125; the decidable basis is 124 and names its one absent id.
    expect(report.candidate2.measuredIds).toHaveLength(125)
    expect(report.candidate2.decidableIds).toHaveLength(124)
    expect(report.candidate2.unavailableIds).toEqual(["scrollback.viewport-hold-output"])
    expect(report.candidate2.decidableIds).not.toContain("scrollback.viewport-hold-output")

    const categories = cohortCategories(report.candidate2.decidableIds, catalog)
    const labelWidth = Math.max(...categories.map((category) => category.label.length))
    const row = report.candidate2.barRows.find(
      (entry) =>
        "run" in entry && entry.measured && entry.context.terminalId === "kitty" && entry.context.os === "linux",
    )
    if (!row || !("run" in row) || !row.measured) throw new Error("kitty/linux measured row absent")
    const printed = formatCohortRow(row, categories, labelWidth, report.candidate2.unavailableIds)
    const text = printed.join("\n")

    // The RELEASE line keeps the operator's D3 denominator — the cohort size — and names the id beside it.
    const releaseDenominator = report.candidate2.measuredIds.length
    expect(
      printed.some(
        (line) =>
          line.includes(`decisive/${releaseDenominator} `) &&
          line.includes(`/${releaseDenominator} = `) &&
          line.includes("(unavailable: scrollback.viewport-hold-output)"),
      ),
    ).toBe(true)
    expect(printed.some((line) => line.includes(`inconclusive/${releaseDenominator}`))).toBe(true)
    // The release basis retains the id, so its remainder still names the one untested row; the category
    // block, on the decidable basis, has no remainder row at all.
    expect(printed.filter((line) => line.includes("remainder"))).toEqual([
      "    remainder    1 rows: scrollback.viewport-hold-output (untested)",
      ...categories.map(() => "      remainder    0 rows"),
    ])
    // The block header states the basis ONCE (the 125 cohort, the 124 decidable).
    expect(
      printed.some(
        (line) =>
          line.includes("CATEGORIES OF THE 125") &&
          line.includes("n = 124 cohort ids with a probe in required suite a8bafe49cdd4"),
      ),
    ).toBe(true)
    // The Scrollback category divides by its DECIDABLE count and names the tenth beside them.
    const scrollback = categories.find((category) => category.key === "scrollback")
    if (!scrollback) throw new Error("scrollback category absent")
    expect(scrollback.ids.length).toBeLessThan(releaseDenominator)
    expect(
      printed.some(
        (line) =>
          line.includes("Scrollback") &&
          line.includes(`0/${scrollback.ids.length} = 0% · fail`) &&
          line.includes("(unavailable: scrollback.viewport-hold-output)"),
      ),
    ).toBe(true)
    // The two RELEASE lines (decisive, inconclusive) are the only cohort-size fractions; every category
    // line divides over its own decidable ids.
    expect(text.match(new RegExp(`\\d+/${releaseDenominator} =`, "g"))?.length).toBe(2)
  }, 15_000)

  it("moves no verdict label on today's runs — the only row the basis moves is Scrollback's denominator", () => {
    const report = buildReport({ contentDir, cohort: "candidate2" })
    if (!report.candidate2) throw new Error("Candidate 2 report absent")
    const unavailable = new Set(report.candidate2.unavailableIds)
    // Partition the FULL ratified cohort, so "before" is the retained-in-denominator basis.
    const categories = cohortCategories(report.candidate2.measuredIds, catalog)
    let flips = 0
    for (const row of report.candidate2.barRows) {
      if (!("run" in row) || !row.measured) continue
      for (const category of categories) {
        const before = decisiveShare(row.run.cells, category.ids)
        const after = decisiveShare(
          row.run.cells,
          category.ids.filter((id) => !unavailable.has(id)),
        )
        if (before.verdict.label !== after.verdict.label) flips++
        if (category.key === "scrollback") {
          expect(before.denominator).toBe(10)
          expect(after.denominator).toBe(9)
        }
      }
    }
    expect(flips).toBe(0)
  }, 20_000)
})
