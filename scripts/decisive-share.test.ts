/**
 * @failure The Release 1 bar's instrument would read a missing row as a decisive 0, fold a
 *   present-but-error row into inconclusive, guess which of several site-selected profiles is the
 *   (terminal, os) row, or drift the ratified 52 away from the audited mover list — so "at least 95%
 *   decisive, at most 1% inconclusive, the rest named" would report the wrong rest.
 * @level l2
 * @consumer Release 1 decisive-count reader (scripts/decisive-share.ts)
 * @source-grep nothing but this fixture exercises the error and untested buckets, the ambiguous
 *   context and the mover-list assertion: real admitted runs fill all 62 tier-1 rows and every real
 *   Release 1 context has at most one permissions-free candidate.
 * @testonly none
 */
import { describe, expect, it } from "vitest"
import {
  type ContextCandidate,
  barRowForContext,
  decisiveShare,
  F2_MOVERS,
  formatBarRow,
  pickContextRun,
  RATIFIED_TIER1_COUNT,
  ratifiedTierOneIds,
  RELEASE_BAR,
} from "./decisive-share.ts"

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
    suiteFreshness: "current suite",
    cells,
    ...overrides,
  }
}

describe("release 1 decisive-count reader", () => {
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
    expect(share.pass).toBe(false)
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

  it("passes the bar only when decisive is at least 95% and inconclusive at most 1%", () => {
    const allDecisive = Object.fromEntries(IDS.map((id) => [id, { outcome: "supported", conclusive: true }]))
    const pass = decisiveShare(allDecisive, IDS)
    expect(pass.decisivePct).toBe(100)
    expect(pass.inconclusivePct).toBe(0)
    expect(pass.pass).toBe(true)
    expect(RELEASE_BAR).toEqual({ decisivePct: 95, inconclusivePct: 1 })
  })

  it("takes the audited F2 movers out of the declared 62 and refuses a mismatched list", () => {
    const declared = ["device.primary-da", ...F2_MOVERS, ...Array.from({ length: 51 }, (_, i) => `f.${i}`)]
    const ratified = ratifiedTierOneIds(declared)
    expect(ratified).toHaveLength(RATIFIED_TIER1_COUNT)
    expect(ratified).not.toContain(F2_MOVERS[0])
    expect(() => ratifiedTierOneIds(declared.slice(1))).toThrow(/ratified tier-1 set is 51/)
    expect(() => ratifiedTierOneIds(declared.filter((id) => id !== F2_MOVERS[0]))).toThrow(/27832|F2 movers/)
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
    expect(pickContextRun([plain])).toEqual({ run: plain })
    expect(pickContextRun([allow, plain, deny])).toEqual({ run: plain })
    expect(pickContextRun([allow, deny])).toEqual({ ambiguous: ["allow", "deny"] })
    expect(pickContextRun([])).toBeUndefined()
  })

  it("prints both denominators, the named remainder and the bar line for a measured context", () => {
    const row = barRowForContext({
      context: { terminalId: "alacritty", os: "linux" },
      candidates: [candidate()],
      tier62Ids: IDS,
      tier52Ids: IDS.slice(0, 4),
    })
    expect(row.measured).toBe(true)
    if (!row.measured) throw new Error("expected the alacritty row to be measured")
    const printed = formatBarRow(row).join("\n")
    expect(printed).toContain("decisive/62     3/6 = 50%")
    expect(printed).toContain("decisive/52     3/4 = 75%")
    expect(printed).toContain("inconclusive/62 1/6 = 17%")
    expect(printed).toContain("remainder    2 rows: e.error (error), f.missing (untested)")
    expect(printed).toContain("verdict         FAIL")
  })
})
