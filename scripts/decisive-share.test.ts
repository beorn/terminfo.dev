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
import {
  type ContextCandidate,
  barRowForContext,
  buildReport,
  decisiveShare,
  F2_MOVERS,
  formatBarRow,
  namedExceptionsLine,
  pickContextRun,
  INCLUDED_TIER1_COUNT,
  includedTierOneIds,
} from "./decisive-share.ts"
import { d3Verdict } from "../docs/data/release-scope.ts"

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
    suiteFreshness: "current suite",
    cells,
    ...overrides,
  }
}

describe("release 1 decisive-count reader", () => {
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

    const staleA = candidate({ key: "stale-a", suiteFreshness: "older suite (1 probes)" })
    const staleB = candidate({ key: "stale-b", suiteFreshness: "older suite (1 probes)" })
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
