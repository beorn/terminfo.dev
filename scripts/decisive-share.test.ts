/**
 * @failure The Release 1 bar's instrument would read a missing row as a decisive 0, fold a
 *   present-but-error row into inconclusive, guess which of several site-selected profiles is the
 *   (terminal, os) row, or drift the included 52 away from the catalog's own tier1 labels — so the D3 verdict
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
  type CohortBarRow,
  categoryBlockHeader,
  barRowForContext,
  buildReport,
  candidate2Cohort,
  candidate4Cohort,
  COHORT_FACTORIES,
  categoryShares,
  cohortCategories,
  cohortHeaderLine,
  cohortRowForSelected,
  formatCategoryRow,
  formatCohortRow,
  parseReaderArgs,
  decisiveShare,
  formatBarRow,
  namedExceptionsLine,
  formatRefusedRun,
  refusedRunsSection,
  tierOneIds,
} from "./decisive-share.ts"
import { pickContextRun, type ContextCandidate } from "../docs/data/run-selection.ts"
import { frozenSuiteIdFor } from "../docs/data/load-release-scope.ts"
import { classifyCells, d3Verdict, tier1Included } from "../docs/data/release-scope.ts"
import { loadCategories } from "../docs/data/categories.ts"
import { loadFeatures } from "@terminfo/catalog"

const IDS = ["a.supported", "b.supported", "c.unsupported", "d.inconclusive", "e.error", "f.missing"]

const cells = {
  "a.supported": { outcome: "supported", conclusive: true },
  "b.supported": { outcome: "supported", conclusive: true },
  "c.unsupported": { outcome: "unsupported", conclusive: true },
  "d.inconclusive": { outcome: "inconclusive" },
  "e.error": { outcome: "error" },
}

function candidate(overrides: Partial<ContextCandidate> = {}): ContextCandidate {
  // The run's states are the ONE classification of its cells: a fixture that overrides `cells` gets the
  // matching `states` for free, so a reader cutting a bar over `states` sees the run the fixture names.
  const runCells = overrides.cells ?? cells
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
    cells: runCells,
    states: classifyCells(runCells),
    ...overrides,
  }
}

describe("release 1 decisive-count reader", () => {
  it("names required category, feature and frozen-suite failures instead of returning an empty report", () => {
    const contentDir = mkdtempSync(join(tmpdir(), "reader-required-content-"))
    const real = join(import.meta.dirname, "..", "content")
    const load = () => buildReport({ contentDir, cohort: candidate2Cohort(contentDir) })
    try {
      // The cohort's suite is passed EXPLICITLY by its spec, so the registry is the first required
      // resource: the reader never guesses which cohort a frozen suite belongs to.
      expect(load).toThrow(/the suite registry is required to name the current suite/)
      const suites = join(contentDir, "suites")
      mkdirSync(suites)
      expect(load).toThrow(/no suite manifest declares freeze.release "candidate4"/)
      // The site's selection projection resolves the release suite separately, so the fixture carries it.
      writeFileSync(join(suites, "5753741410a9.json"), readFileSync(join(real, "suites", "5753741410a9.json")))
      const realManifest = join(real, "suites", "c24025ea22fc.json")
      const raw = parseSuiteManifest(realManifest, readFileSync(realManifest, "utf8"))
      const manifest = join(suites, "c24025ea22fc.json")
      writeFileSync(manifest, JSON.stringify({ ...raw, freeze: { release: "candidate4", at: "not-a-date" } }))
      expect(load).toThrow(manifest)
      writeFileSync(
        manifest,
        JSON.stringify({ ...raw, freeze: { release: "candidate4", at: "2026-10-12T03:33:42.000Z" } }),
      )
      const categories = join(contentDir, "categories.json")
      expect(load).toThrow(categories)
      writeFileSync(categories, "{")
      expect(load).toThrow(categories)
      writeFileSync(categories, readFileSync(join(real, "categories.json")))
      const features = join(contentDir, "features.json")
      expect(load).toThrow(features)
      writeFileSync(features, "{")
      expect(load).toThrow(features)
      writeFileSync(features, readFileSync(join(real, "features.json")))
      for (const dir of ["probes-apps", "probes-mux", "probes-libs"]) mkdirSync(join(contentDir, dir))
      expect(buildReport({ contentDir, cohort: candidate2Cohort(contentDir) }).cohort?.frozenSuiteId).toBe(
        "c24025ea22fc",
      )
    } finally {
      rmSync(contentDir, { recursive: true })
    }
  })

  it("preserves the default report and accepts only the named CLI selectors and positionals", () => {
    const contentDir = join(import.meta.dirname, "..", "content")
    // The default run measures no cohort at all: not an empty one, and not a fallback to a named one.
    const baseline = buildReport({ contentDir })
    expect(baseline.cohort).toBeUndefined()
    expect(baseline.barRows.length).toBeGreaterThan(0)
    expect(parseReaderArgs([])).toEqual({ cohort: "candidate1", terminalIds: [] })
    expect(parseReaderArgs(["kitty", "--cohort", "candidate2", "xterm"])).toEqual({
      cohort: "candidate2",
      terminalIds: ["kitty", "xterm"],
    })
    expect(parseReaderArgs(["--cohort", "candidate4"])).toEqual({ cohort: "candidate4", terminalIds: [] })
    expect(() => parseReaderArgs(["--cohort", "candidate3"])).toThrow(/candidate1, candidate2/)
    expect(() => parseReaderArgs(["--unknown"])).toThrow(/unknown/i)
    // Two complete real-data projections took 5.7s under measured host load; keep this bound local.
  }, 15_000)

  it("maps every accepted cohort value to a factory, candidate 1 to none", () => {
    const contentDir = join(import.meta.dirname, "..", "content")
    // The mapper is the only place a cohort value becomes a spec. A value accepted by the CLI but
    // missing here would silently measure nothing, so each one is checked against the map.
    expect(Object.keys(COHORT_FACTORIES).sort()).toEqual(["candidate1", "candidate2", "candidate4"])
    expect(COHORT_FACTORIES.candidate1).toBeUndefined()
    expect(COHORT_FACTORIES.candidate2?.(contentDir)?.name).toBe("candidate2")
    expect(COHORT_FACTORIES.candidate4?.(contentDir)?.name).toBe("candidate4")
    for (const value of ["candidate1", "candidate2", "candidate4"] as const) {
      expect(parseReaderArgs(["--cohort", value]).cohort).toBe(value)
      expect(Object.hasOwn(COHORT_FACTORIES, value)).toBe(true)
    }
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
      scoredIds: IDS,
      libraryOnlyIds: [],
      decidableIds: IDS,
    })
    expect(result).toMatchObject({
      measured: false,
      run: { runId: "selected-new", suiteId: "new-suite" },
      reason: "ineligible: selected run on suite new-suite, required a8bafe49cdd4",
    })
    expect(result).not.toHaveProperty("share")
  })

  it("grades a suite-S run and keeps a historical H run ineligible once the declaration moves (28467)", () => {
    // 28467 AC1: the declaration's frozenSuiteId is the live suite-S tree hash, so a run on suite-S
    // grades over the ratified 125 while a run still on the historical H suite is named ineligible —
    // history never substitutes for the selected run.
    const cohort = {
      name: "candidate2" as const,
      frozenSuiteId: "db5558cf8d6c",
      measuredIds: IDS,
      scoredIds: IDS,
      libraryOnlyIds: [],
      decidableIds: IDS,
    }
    const context = { terminalId: "alacritty", os: "linux" }
    const successor = barRowForContext({
      context,
      candidates: [candidate({ suiteId: "db5558cf8d6c", runId: "suite-s-run" })],
      tier62Ids: IDS,
      tier52Ids: IDS,
    })
    expect(cohortRowForSelected(successor, cohort)).toMatchObject({
      measured: true,
      run: { runId: "suite-s-run", suiteId: "db5558cf8d6c" },
      share: { denominator: IDS.length },
    })
    const historical = barRowForContext({
      context,
      candidates: [candidate({ suiteId: "a8bafe49cdd4", runId: "historical-h-run" })],
      tier62Ids: IDS,
      tier52Ids: IDS,
    })
    expect(cohortRowForSelected(historical, cohort)).toMatchObject({
      measured: false,
      run: { runId: "historical-h-run", suiteId: "a8bafe49cdd4" },
      reason: "ineligible: selected run on suite a8bafe49cdd4, required db5558cf8d6c",
    })
  })

  it("keeps the historical H suite manifest byte-identical while the declaration points at suite-S", () => {
    // 28467 AC2/AC5: the move is one declaration field — the H manifest and the successor manifest are
    // both immutable evidence, so a byte-identical H manifest proves the transition dropped no history.
    const contentDir = join(import.meta.dirname, "..", "content")
    const historical = readFileSync(join(contentDir, "suites", "a8bafe49cdd4.json"))
    expect(createHash("sha256").update(historical).digest("hex")).toBe(
      "4cd7d1f916bf513248b6327a2077f354d013755e9e67d875f916b97d2ff9ddbe",
    )
    // AC4: the successor schedule still carries no probe for the viewport-hold id, so the decidable
    // basis keeps naming it unavailable rather than silently shrinking into a denominator.
    const successorPath = join(contentDir, "suites", "db5558cf8d6c.json")
    const successor = parseSuiteManifest(successorPath, readFileSync(successorPath, "utf8"))
    expect(successor.probeHash).toBe("db5558cf8d6c")
    expect(successor.probes.app).not.toContain("scrollback.viewport-hold-output")
  })

  it("grades all 125 frozen IDs through D3 rounding and preserves missing or ambiguous selection", () => {
    const ids = Array.from({ length: 125 }, (_, i) => `classic.${i}`)
    const cohort = {
      name: "candidate2" as const,
      frozenSuiteId: "a8bafe49cdd4",
      measuredIds: ids,
      scoredIds: ids,
      libraryOnlyIds: [],
      decidableIds: ids,
    }
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
    const contentDir = join(import.meta.dirname, "..", "content")
    const args = { contentDir, cohort: candidate2Cohort(contentDir) }
    const report = buildReport(args)
    expect(report).toHaveProperty("cohort.name", "candidate2")
    expect(report).toHaveProperty("cohort.frozenSuiteId", "c24025ea22fc")
    expect(report).toHaveProperty(
      "cohort.measuredIds",
      expect.arrayContaining(["cursor.position-report", "editing.decrqcra", "scrollback.viewport-hold-output"]),
    )
    expect(report).toHaveProperty("cohort.measuredIds.length", 125)
    expect(report).toHaveProperty("cohort.unavailableIds", ["scrollback.viewport-hold-output"])
    if (!report.cohort) throw new Error("Candidate 2 report absent")
    // Independent ratification snapshot: SHA256 of JSON.stringify(sorted 125 IDs), not a prefix census.
    expect(
      createHash("sha256")
        .update(JSON.stringify([...report.cohort.measuredIds].sort()))
        .digest("hex"),
    ).toBe("1a2012751b148b0230b97e27c74c11868ec36f1b3dd202fb798d42ec8abda17a")
    report.cohort.barRows.forEach((row, i) => {
      const original = report.barRows[i]
      expect(row.context).toEqual(original?.context)
      if (original?.measured) expect(row).toHaveProperty("run", original.run)
    })
    expect(report.cohort.admittedRuns.map((row) => row.run)).toEqual(report.admittedRuns)
    for (const row of report.cohort.admittedRuns) {
      expect(row.measured).toBe(row.run.suiteId === "c24025ea22fc")
      // The RELEASE share is the operator's D3 over the ratified cohort (125) MINUS the app-unobservable
      // rows the @chief option-B ruling moved out (three here, so 122); only the per-category block
      // divides over the decidable basis (@chief 2026-10-10T15:56Z).
      if (row.measured) expect(row.share.denominator).toBe(122)
      else {
        expect(row).not.toHaveProperty("share")
        expect(row.reason).toBe(`ineligible: admitted run on suite ${row.run.suiteId}, required c24025ea22fc`)
      }
    }
  })

  it("splits a fixture run into decisive, inconclusive and named remainder buckets", () => {
    const share = decisiveShare(classifyCells(cells), IDS)
    expect(share.denominator).toBe(6)
    expect(share.decisive).toBe(3)
    expect(share.decisivePct).toBe(50)
    expect(share.inconclusive).toBe(1)
    expect(share.inconclusivePct).toBe(17)
    expect(share.inconclusiveIds).toEqual(["d.inconclusive"])
    expect(share.remainder).toEqual([
      { featureId: "e.error", bucket: "error" },
      { featureId: "f.missing", bucket: "untested" },
    ])
    expect(share.verdict.text).toBe("fail · 3/6")
  })

  it("names every row of a 62-row remainder as untested when only a few cells exist", () => {
    const measured = Array.from({ length: 62 }, (_, index) => `f.${index}`)
    const share = decisiveShare(classifyCells({ "f.0": { outcome: "supported", conclusive: true } }), measured)
    expect(share.decisive).toBe(1)
    expect(share.decisivePct).toBe(2)
    expect(share.inconclusive).toBe(0)
    expect(share.remainder).toHaveLength(61)
    expect(share.remainder.every((entry) => entry.bucket === "untested")).toBe(true)
  })

  it("counts a supported outcome on non-measuring evidence as inconclusive, not decisive", () => {
    const share = decisiveShare(classifyCells({ "a.supported": { outcome: "supported", conclusive: false } }), [
      "a.supported",
    ])
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
    const pass = decisiveShare(classifyCells(allDecisive), IDS)
    expect(pass.decisivePct).toBe(100)
    expect(pass.verdict.text).toBe("pass · 6/6")
    // A verdict over zero included capabilities is not "fail" — it is not measured, and it refuses.
    expect(() => d3Verdict(0, 0)).toThrow(/positive denominator/)
    expect(() => d3Verdict(3, 2)).toThrow(/0 <= decisive <= denominator/)
  })

  it("takes the ten excluded tier-1 rows out of the declared 62 by their catalog label, never a list", () => {
    const contentDir = join(import.meta.dirname, "..", "content")
    const catalog = loadFeatures(contentDir)
    const declared = tierOneIds(contentDir)
    expect(declared).toHaveLength(62)
    const included = tier1Included(catalog, declared)
    expect(included).toHaveLength(52)
    expect(included).not.toContain("extensions.osc777-notify")
    expect(catalog["extensions.osc777-notify"]?.tier1).toBe("excluded")
    expect(catalog["device.primary-da"]?.tier1).toBe("included")
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
    expect(printed).toContain("inconclusive    1 rows: d.inconclusive")
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
    // unavailable id and its two library-only rows, Reset its one library-only row), so the derived
    // counts are 32/22/20/11/17/7/4/4/4 = 121.
    const report = buildReport({ contentDir, cohort: candidate2Cohort(contentDir) })
    if (!report.cohort) throw new Error("Candidate 2 report absent")
    expect(report.cohort.measuredIds.length).toBe(125)
    expect(report.cohort.decidableIds.length).toBe(121)
    const categories = cohortCategories(report.cohort.decidableIds, catalog)
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
    expect(categories.map((category) => category.ids.length)).toEqual([32, 22, 20, 11, 17, 7, 4, 4, 4])
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
    expect(assigned.length).toBe(121)
    expect(new Set(assigned).size).toBe(121)
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
    const shares = categoryShares(classifyCells(cells), categories)
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
    const shares = categoryShares(classifyCells(cells), categories)
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
    expect(decisiveShare(classifyCells(cells), ids)).toMatchObject({
      denominator: 10,
      decisive: 9,
      verdict: { label: "pass" },
    })
    const shares = categoryShares(classifyCells(cells), categories)
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
      share: decisiveShare(classifyCells(cells), ["sgr.a"]),
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
    const printed = formatCategoryRow(categories[0]!, decisiveShare(classifyCells(cells), ["sgr.a"]), 19)
    expect(printed[0]).toContain("SGR (Text Styling)")
    expect(printed[0]!.toLowerCase()).not.toContain("group")
  })

  it("names the unavailable id beside each fraction — the release line stays /122, the category line is /7", () => {
    const report = buildReport({ contentDir, cohort: candidate2Cohort(contentDir) })
    if (!report.cohort) throw new Error("Candidate 2 report absent")
    // The ratified cohort is still 125; the decidable basis is 121 and names its one unavailable id
    // and the three library-only rows the @chief option-B ruling moved out of the app denominator.
    expect(report.cohort.measuredIds).toHaveLength(125)
    expect(report.cohort.decidableIds).toHaveLength(121)
    expect(report.cohort.unavailableIds).toEqual(["scrollback.viewport-hold-output"])
    // In the cohort's own order — each category's `order`, the one category order the site prints.
    expect(report.cohort.libraryOnlyIds).toEqual(["scrollback.accumulate", "scrollback.total-lines", "reset.method"])
    expect(report.cohort.decidableIds).not.toContain("scrollback.viewport-hold-output")

    const categories = cohortCategories(report.cohort.decidableIds, catalog)
    const labelWidth = Math.max(...categories.map((category) => category.label.length))
    // Keep the real kitty/linux run selected before the freeze as an explicit historical witness.
    // The new suite has no selected run yet; history never substitutes for its current rows.
    const historical = report.admittedRuns.find((run) => run.runId === "dfd4cd08416fb5f3be3eaeed5acce782")
    if (!historical) throw new Error("historical kitty/linux admitted run absent")
    const selected = barRowForContext({
      context: { terminalId: "kitty", os: "linux" },
      candidates: [historical],
      tier62Ids: report.tier62Ids,
      tier52Ids: report.tier52Ids,
    })
    const row = cohortRowForSelected(selected, { ...report.cohort, frozenSuiteId: "c3d1fbb77561" })
    if (!row.measured || !("run" in row)) throw new Error("historical kitty/linux measured bar row absent")
    expect(row.run.suiteId).toBe("c3d1fbb77561")
    const printed = formatCohortRow(
      row,
      categories,
      labelWidth,
      report.cohort.unavailableIds,
      report.cohort.libraryOnlyIds,
    )
    const text = printed.join("\n")

    // The RELEASE line keeps the operator's D3 denominator — the app-observable cohort size — and
    // names the unavailable id and the library-only rows beside it.
    const releaseDenominator = report.cohort.scoredIds.length
    expect(
      printed.some(
        (line) =>
          line.includes(`decisive/${releaseDenominator} `) &&
          line.includes(`/${releaseDenominator} = `) &&
          line.includes(
            "(unavailable: scrollback.viewport-hold-output; library-only: scrollback.accumulate, scrollback.total-lines, reset.method)",
          ),
      ),
    ).toBe(true)
    expect(printed.some((line) => line.includes(`inconclusive/${releaseDenominator}`))).toBe(true)
    // The release basis retains the id, so its remainder still names it; the category block, on the
    // decidable basis, has already removed it from Scrollback. The selected suite-S run also records a
    // not-tested erase row, which is exactly what a remainder row reports, so erase keeps one row
    // instead of the all-empty remainders the H-era run produced.
    expect(printed.filter((line) => line.includes("remainder"))).toEqual([
      "    remainder    2 rows: erase.screen.scrollback (untested), scrollback.viewport-hold-output (untested)",
      ...categories.map((category) =>
        category.key === "erase"
          ? "      remainder    1 rows: erase.screen.scrollback (untested)"
          : "      remainder    0 rows",
      ),
    ])
    // The block header states the basis ONCE (the 125 ratified cohort, the 121 decidable).
    expect(
      printed.some(
        (line) =>
          line.includes("CATEGORIES OF THE 125") &&
          line.includes("n = 121 cohort ids with a probe in required suite c3d1fbb77561 and app-observable") &&
          line.includes("; 3 rows are library-only and not scored in apps"),
      ),
    ).toBe(true)
    // The Scrollback category divides by its DECIDABLE count and names its moved rows beside it.
    const scrollback = categories.find((category) => category.key === "scrollback")
    if (!scrollback) throw new Error("scrollback category absent")
    expect(scrollback.ids.length).toBeLessThan(releaseDenominator)
    expect(
      printed.some(
        (line) =>
          line.includes("Scrollback") &&
          line.includes(`7/${scrollback.ids.length} = 100% · pass`) &&
          line.includes(
            "(unavailable: scrollback.viewport-hold-output; library-only: scrollback.accumulate, scrollback.total-lines)",
          ),
      ),
    ).toBe(true)
    // Chief's nine-ID acceptance remains visible beside the app-only 7/7 projection.
    expect(text).toContain("Scrollback acceptance 7/9 = 78% · with gaps")
    expect(text).toContain("2 inconclusive: scrollback.accumulate, scrollback.total-lines")
    expect(text).toContain("group stays open below 90%")
    expect(printed.some((line) => line.includes("Reset") && line.includes("4/4 = 100%"))).toBe(true)
    // The two RELEASE lines (decisive, inconclusive) are the only cohort-size fractions; every category
    // line divides over its own decidable ids.
    expect(text.match(new RegExp(`\\d+/${releaseDenominator} =`, "g"))?.length).toBe(2)
  }, 15_000)

  it("moves no verdict label on today's runs — the only row the basis moves is Scrollback's denominator", () => {
    const report = buildReport({ contentDir, cohort: candidate2Cohort(contentDir) })
    if (!report.cohort) throw new Error("Candidate 2 report absent")
    const unavailable = new Set(report.cohort.unavailableIds)
    // Partition the FULL ratified cohort, so "before" is the retained-in-denominator basis.
    const categories = cohortCategories(report.cohort.measuredIds, catalog)
    let flips = 0
    for (const row of report.cohort.barRows) {
      if (!("run" in row) || !row.measured) continue
      for (const category of categories) {
        const before = decisiveShare(row.run.states, category.ids)
        const after = decisiveShare(
          row.run.states,
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

describe("the candidate-4 cohort reads the frozen suite its caller names", () => {
  const contentDir = join(import.meta.dirname, "..", "content")

  it("names candidate 4's slices, its suite and whose freeze declared that suite", () => {
    const spec = candidate4Cohort(contentDir)
    expect(spec.name).toBe("candidate4")
    expect(spec.slices).toEqual(["extensions", "input"])
    // The reader names the cohort's own frozen id explicitly, so this naming is a decision, not a
    // registry fallback, and a release nothing freezes still refuses.
    expect(spec.suiteId).toBe("c24025ea22fc")
    expect(spec.suiteFrozenFor).toBe("candidate4")
    expect(frozenSuiteIdFor(contentDir, "candidate4")).toBe("c24025ea22fc")
    expect(() => frozenSuiteIdFor(contentDir, "candidate9")).toThrow(
      /no suite manifest declares freeze\.release "candidate9"/,
    )
  }, 15_000)

  it("reports the 44 candidate-4 ids on the same buildReport path candidate 2 uses", () => {
    const candidate2 = buildReport({ contentDir, cohort: candidate2Cohort(contentDir) })
    const candidate4 = buildReport({ contentDir, cohort: candidate4Cohort(contentDir) })
    if (!candidate2.cohort || !candidate4.cohort) throw new Error("cohort report absent")
    // One shape, two DATA values: a per-cohort branch inside buildReport would show up here.
    expect(Object.keys(candidate4.cohort).sort()).toEqual(Object.keys(candidate2.cohort).sort())
    expect(candidate4.cohort.name).toBe("candidate4")
    expect(candidate4.cohort.measuredIds).toHaveLength(44)
    expect(candidate4.cohort.frozenSuiteId).toBe("c24025ea22fc")
    expect(candidate4.cohort.slices).toEqual(["extensions", "input"])
    expect(candidate4.cohort.suiteFrozenFor).toBe("candidate4")
    // Candidate 2's own numbers do not move because a second cohort exists.
    expect(candidate2.cohort.name).toBe("candidate2")
    expect(candidate2.cohort.measuredIds).toHaveLength(125)
    expect(candidate2.cohort.frozenSuiteId).toBe("c24025ea22fc")
    expect(candidate2.cohort.suiteFrozenFor).toBe("candidate4")
  }, 20_000)

  it("derives the cohort from its data, never from its name", () => {
    // The key-set comparison above proves the shape; this proves the PATH. A buildReport that chose
    // the tier-1 exclusion from the cohort's name would still pass every other row in this file.
    const expected = buildReport({ contentDir, cohort: candidate4Cohort(contentDir) }).cohort
    const renamed = { ...candidate4Cohort(contentDir), name: "candidate2" as const }
    const report = buildReport({ contentDir, cohort: renamed })
    if (!expected || !report.cohort) throw new Error("cohort report absent")
    expect(report.cohort.measuredIds).toHaveLength(44)
    expect(report.cohort.measuredIds).toEqual(expected.measuredIds)
    expect(report.cohort.decidableIds).toEqual(expected.decidableIds)
    expect(report.cohort.slices).toEqual(["extensions", "input"])
    expect(report.cohort.measuredIds).not.toContain("extensions.osc777-notify")
  }, 20_000)

  it("refuses a suite whose manifest is not frozen for the cohort it would print", () => {
    // The header says WHOSE freeze declared the suite. A spec that claims another cohort's suite as
    // its own must refuse, or the printed ownership is a claim nothing checked.
    const borrowed = { ...candidate4Cohort(contentDir), suiteFrozenFor: "candidate2" as const }
    expect(() => buildReport({ contentDir, cohort: borrowed })).toThrow(
      /freeze\.release is "candidate4", not "candidate2"/,
    )
  }, 20_000)

  it("prints the suite it read and whose freeze that is, for either cohort", () => {
    const candidate2 = buildReport({ contentDir, cohort: candidate2Cohort(contentDir) }).cohort
    const candidate4 = buildReport({ contentDir, cohort: candidate4Cohort(contentDir) }).cohort
    if (!candidate2 || !candidate4) throw new Error("cohort report absent")
    const line2 = cohortHeaderLine(candidate2)
    expect(line2).toContain("Candidate 2 classics · 125 IDs")
    expect(line2).toContain("required suite c24025ea22fc — frozen for candidate4, read here for candidate2 ids;")
    const line4 = cohortHeaderLine(candidate4)
    expect(line4).toContain("Candidate 4 extensions and input · 44 IDs")
    expect(line4).toContain("required suite c24025ea22fc;")
  }, 20_000)
})

describe("the reader separates admitted runs from the site's refusals (28018)", () => {
  const contentDir = join(import.meta.dirname, "..", "content")

  it("lists only runs the site admits, and names a refused run with the gate's own reason", () => {
    // d3c5c6a0 carries provenance.runtime.cleanTree=false and 6993f2ac is suite-incomplete, so the ONE
    // admission gate refuses both — they must never print under ADMITTED RUNS.
    const nativeProvenanceDirty = "d3c5c6a0bd41012bcb54abe044d9c5c3"
    const suiteIncomplete = "6993f2ac0b1831e525d12c95ab5e8bbe"
    const report = buildReport({ contentDir, cohort: candidate2Cohort(contentDir) })
    if (!report.cohort) throw new Error("Candidate 2 report absent")
    const admitted = report.cohort.admittedRuns.map((row) => row.run.runId)
    expect(admitted).not.toContain(nativeProvenanceDirty)
    expect(admitted).not.toContain(suiteIncomplete)
    // An admitted run the bar does not select stays visible by run id (the section's whole purpose).
    expect(admitted).toContain("08add735cbbccf6f87373c7e77d2cf47")
    const refused = new Map(report.cohort.refusedRuns.map((row) => [row.run.runId, row.reason]))
    expect(refused.get(nativeProvenanceDirty)).toBe("native-provenance-dirty")
    expect(refused.get(suiteIncomplete)).toBe("suite-incomplete")
    expect(report.refusedRuns.map((row) => row.run.runId)).toEqual(
      expect.arrayContaining([nativeProvenanceDirty, suiteIncomplete]),
    )
  }, 20_000)

  it("prints the refusals under their own header, and states an empty list instead of omitting it", () => {
    const empty = refusedRunsSection([]).join("\n")
    expect(empty).toContain("SITE-EXCLUDED RUNS")
    // The empty state is SCOPED to what this reader measures. "the site admits every run document it
    // read" would be a false universal claim: the projection refuses plenty this reader never names.
    expect(empty).toContain("none — no app run this reader measures is refused")
    expect(empty).not.toMatch(/every run document/i)
    const printed = refusedRunsSection([
      {
        run: candidate({ runId: "x", terminalId: "kitty", os: "linux", suiteId: "267a5d166f08" }),
        reason: "native-provenance-dirty",
      },
    ])
    expect(printed[0]).toContain("SITE-EXCLUDED RUNS")
    // The section names its own, narrower population: it is the app runs this reader measures, not
    // the header's wider "rejected" count, and a reader must not reconcile the two as one number.
    expect(printed[0]).toContain("every app run this reader measures")
    expect(printed.join("\n")).toContain(
      "kitty 0.17.0 linux x · suite 267a5d166f08 · excluded: native-provenance-dirty",
    )
  })

  it("states an empty refusal list as scoped to this reader, never as the site admitting everything", () => {
    // The reviewer's shape (28018 peer review, @dev/review2): a projection with ZERO app runs can still
    // refuse documents this reader never names, because the projection reads probes-libs and
    // probes-mux too. The empty line must be scoped or it asserts a universal admission that is false.
    const contentDir = mkdtempSync(join(tmpdir(), "reader-empty-refusals-"))
    const real = join(import.meta.dirname, "..", "content")
    try {
      for (const name of ["features.json", "terminals.json", "categories.json", "default-contexts.json"]) {
        writeFileSync(join(contentDir, name), readFileSync(join(real, name)))
      }
      mkdirSync(join(contentDir, "suites"))
      // The projection resolves the release suite; the cohort resolves its own frozen suite.
      writeFileSync(
        join(contentDir, "suites", "5753741410a9.json"),
        readFileSync(join(real, "suites", "5753741410a9.json")),
      )
      writeFileSync(
        join(contentDir, "suites", "c24025ea22fc.json"),
        readFileSync(join(real, "suites", "c24025ea22fc.json")),
      )
      for (const dir of ["probes-apps", "probes-mux", "probes-libs"]) mkdirSync(join(contentDir, dir))
      // One real lib run the projection refuses: a NON-app document, so this reader must not name it
      // here, while still not claiming the site admitted it.
      const libDoc = "alacritty-0.26.0-linux-4aab714c-77d4-4f71-ba28-266d98c4fa25.json"
      const libRun = JSON.parse(readFileSync(join(real, "probes-libs", libDoc), "utf8")) as { suiteId: string }
      writeFileSync(join(contentDir, "probes-libs", libDoc), readFileSync(join(real, "probes-libs", libDoc)))
      // The lib run's own suite manifest: parseRun refuses a suite it cannot resolve, so the fixture
      // carries the manifest and the run stays refused for its incomplete probe set, not for a
      // missing manifest.
      writeFileSync(
        join(contentDir, "suites", `${libRun.suiteId}.json`),
        readFileSync(join(real, "suites", `${libRun.suiteId}.json`)),
      )

      const report = buildReport({ contentDir, cohort: candidate2Cohort(contentDir) })
      expect(report.admittedRuns).toEqual([])
      expect(report.refusedRuns).toEqual([])
      expect(report.rejected).toBeGreaterThan(0)
      const printed = refusedRunsSection(report.refusedRuns).join("\n")
      expect(printed).toContain("none — no app run this reader measures is refused")
      expect(printed).not.toMatch(/admits every|every run document/i)
    } finally {
      rmSync(contentDir, { recursive: true })
    }
  }, 20_000)
})
