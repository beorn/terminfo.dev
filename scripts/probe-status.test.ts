/**
 * @failure probeStatus drifts from the probe definitions again, or a row the definitions cannot
 *   settle silently reads automated — which is how the ten 27832 F2 movers wore a full-probe badge
 *   while the release contract excluded them.
 * @level l2
 * @consumer the feature pages, the terminal pages and the Release 1 front-page bars
 * @testonly none
 */
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { probe, type ProbeDefinition } from "@terminfo/probe-defs"
import { loadFeatures, type FeatureCatalog } from "@terminfo/catalog"
import { derivedProbeStatus, probeStatusOf, probeStatusSummary, rowsOnCuratedValue } from "../docs/data/probe-status.ts"

const termlessArm = (() => ({ pass: true })) as unknown as ProbeDefinition["termless"]
const termArm = (async () => ({ pass: true })) as unknown as ProbeDefinition["term"]

/** A definition with both arms, then whatever the case under test overrides. */
const definition = (over: Partial<ProbeDefinition> = {}): ProbeDefinition => ({
  ...probe("test.probe", termlessArm, termArm),
  ...over,
})

/** A catalog holding only the rows a case needs. */
const catalog = (rows: Record<string, string>): FeatureCatalog =>
  Object.fromEntries(
    Object.entries(rows).map(([id, probeStatus]) => [id, { probeStatus }]),
  ) as unknown as FeatureCatalog

describe("derivedProbeStatus", () => {
  it("reads automated only when every running arm declares measuring evidence", () => {
    expect(
      derivedProbeStatus(definition({ termObservationEvidence: "query", termlessObservationEvidence: "parser-state" })),
    ).toBe("automated")
  })

  it("reads partial when an arm is absent, even if the other arm measures", () => {
    expect(derivedProbeStatus(definition({ termless: null, termObservationEvidence: "query" }))).toBe("partial")
  })

  it("reads partial when a declared arm carries acceptance-only evidence", () => {
    expect(
      derivedProbeStatus(definition({ termObservationEvidence: "query", termlessObservationEvidence: "consumed" })),
    ).toBe("partial")
  })

  it("lets the consumption signal outrank an undeclared arm, so the row is partial and not unsettled", () => {
    expect(derivedProbeStatus(definition({ termlessObservationEvidence: "consumed" }))).toBe("partial")
  })

  it("cannot settle a row that leaves an arm undeclared", () => {
    expect(derivedProbeStatus(definition({ termlessObservationEvidence: "parser-state" }))).toBeNull()
  })
})

describe("probeStatusOf", () => {
  it("lets a reviewed value win, so a gate the definitions cannot express still reads partial", () => {
    const gated = definition({ termObservationEvidence: "behavior", termlessObservationEvidence: "query" })
    expect(derivedProbeStatus(gated)).toBe("automated")
    expect(probeStatusOf("test.probe", catalog({ "test.probe": "partial" }))).toBe("partial")
  })

  it("reads unprobed for a row with no probe definition at all", () => {
    expect(probeStatusOf("absent.probe", catalog({}))).toBe("unprobed")
  })

  it("refuses, loudly, a row the definitions leave unsettled and the catalog leaves unreviewed", () => {
    expect(() => probeStatusOf("extensions.truecolor", catalog({}))).toThrow(/leaves an arm undeclared/)
  })
})

describe("probeStatusSummary", () => {
  it("names each home of a curated value, and counts the gap", () => {
    const summary = probeStatusSummary(
      catalog({
        "sgr.bold": "", // settled by the definitions: automated
        "extensions.osc52-read": "partial", // gated: a review stands over a settled derivation
        "extensions.truecolor": "partial", // unsettled: the definitions leave an arm undeclared
        "device.env-term": "manual", // no definition at all, reviewed by hand
        "absent.probe": "", // no definition at all, unreviewed
      }),
    )
    expect(summary.counts).toEqual({ automated: 1, partial: 2, manual: 1, unprobed: 1 })
    expect(summary.unsettled).toEqual(["extensions.truecolor"])
    expect(summary.gated).toEqual(["extensions.osc52-read"])
    expect(summary.noDefinition).toEqual(["device.env-term"])
    expect(summary.unreviewed).toEqual([])
    expect(rowsOnCuratedValue(summary)).toBe(2)
  })

  it("names a row the definitions cannot settle and the catalog leaves unreviewed", () => {
    const summary = probeStatusSummary(catalog({ "extensions.truecolor": "" }))
    expect(summary.unreviewed).toEqual(["extensions.truecolor"])
    expect(rowsOnCuratedValue(summary)).toBe(0)
  })
})

describe("the real catalog", () => {
  const contentDir = join(dirname(fileURLToPath(import.meta.url)), "..", "content")

  it("settles or reviews every feature, leaving no row the definitions cannot account for", () => {
    const summary = probeStatusSummary(loadFeatures(contentDir))
    expect(summary.unreviewed).toEqual([])
    const total = summary.counts.automated + summary.counts.partial + summary.counts.manual + summary.counts.unprobed
    expect(total).toBe(Object.keys(loadFeatures(contentDir)).filter((id) => !id.startsWith("$")).length)
  })

  it("keeps the ten 27832 section F2 movers partial, as the release contract requires", () => {
    const features = loadFeatures(contentDir)
    const movers = [
      "extensions.osc22-pointer",
      "extensions.osc52-clipboard",
      "extensions.osc52-read",
      "extensions.osc52-write",
      "extensions.osc176-app-id",
      "extensions.osc3008-context",
      "extensions.osc440-audio",
      "extensions.osc555-flash",
      "extensions.osc666-termprop",
      "extensions.osc777-notify",
    ]
    for (const id of movers) expect(probeStatusOf(id, features), id).toBe("partial")
  })
})
