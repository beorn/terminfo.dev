/**
 * @failure A catalogue edit adds, renames or re-grades an environment position while the declared
 *   nine drift, so a run's graded denominator silently covers the wrong ids.
 * @level l2
 * @consumer every graded score: aggregateCurrentResults, the published score.all and the site bars
 * @testonly none
 */
import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { ENVIRONMENT_GROUP_IDS, scoredFeatureIds, isEnvironmentGroup } from "./environment-groups.ts"

/**
 * The drift guard for the D132 B partition, stated as a test rather than a runtime refusal (@cto
 * 74a0bd62): a load-time throw would be a new gate. What it proves, against the recorded catalogue
 * itself rather than against a second hand-kept list:
 * - each of the nine is recorded manual with the "manual by design" reason;
 * - the named-unavailable viewport position is NOT one of the nine;
 * - the union of graded + environment is the recorded 273 ids, and the two sets are disjoint.
 */
// 37341 (d388a6841) put these status reasons in plain words for the public page; this test pins
// the recorded text, so a reword must move both together.
const MANUAL_REASON = "no automatic test exists for this feature; it is checked by hand"

const features = JSON.parse(readFileSync(new URL("../../../content/features.json", import.meta.url), "utf8")) as Record<
  string,
  { probeStatus?: string; probeStatusReason?: string }
>

const recordedIds = Object.keys(features).filter((id) => !id.startsWith("$"))

describe("environment-group partition (D132 B)", () => {
  it("names exactly the nine catalogue positions recorded manual by design", () => {
    expect(ENVIRONMENT_GROUP_IDS).toHaveLength(9)
    for (const id of ENVIRONMENT_GROUP_IDS) {
      expect(features[id], `${id} must exist in the recorded catalogue`).toBeDefined()
      expect(features[id]?.probeStatus, `${id} must stay recorded manual`).toBe("manual")
      expect(features[id]?.probeStatusReason, `${id} must keep its recorded reason`).toBe(MANUAL_REASON)
    }
  })

  it("keeps partially measured viewport hold out of the environment group", () => {
    expect(features["scrollback.viewport-hold-output"]?.probeStatus).toBe("partial")
    expect(features["scrollback.viewport-hold-output"]?.probeStatusReason).toBe(
      "partial: the library test is unchanged; on Linux, Alacritty 0.17.0 and xterm 411/412 reuse the held-viewport reader, checking the processed output against observed references; other apps have no result yet",
    )
    expect(isEnvironmentGroup("scrollback.viewport-hold-output")).toBe(false)
  })

  it("partitions the recorded catalogue into 266 graded plus 9 environment ids", () => {
    const graded = scoredFeatureIds(recordedIds)
    const environment = recordedIds.filter(isEnvironmentGroup)
    expect(recordedIds).toHaveLength(275)
    expect(environment).toHaveLength(9)
    expect(graded).toHaveLength(266)
    expect(graded.length + environment.length).toBe(recordedIds.length)
    expect(graded.filter(isEnvironmentGroup)).toEqual([])
    expect([...graded, ...environment].sort()).toEqual([...recordedIds].sort())
  })

  it("derives from the ids it is given, so a historical cohort keeps its own count", () => {
    // A cohort recorded before one of the nine existed loses an UNGRADED id, so its graded count is
    // still 266 — the absent environment position never reduced the graded denominator.
    const withoutOneEnvironmentId = recordedIds.filter((id) => id !== "device.env-no-color")
    expect(scoredFeatureIds(withoutOneEnvironmentId)).toHaveLength(266)
    // A cohort missing a GRADED capability is one graded capability smaller, not silently padded.
    const withoutOneGradedId = recordedIds.filter((id) => id !== "sgr.bold")
    expect(scoredFeatureIds(withoutOneGradedId)).toHaveLength(265)
    expect(scoredFeatureIds([])).toEqual([])
  })
})
