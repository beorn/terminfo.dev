/**
 * @failure A row's launch-settle witness is dropped on parse, or a witness with no settle record (or a negative one) is admitted.
 * @level l1
 * @consumer run-parser admission of hosted Warp runs (37225)
 * @reach probe and test attempt parsing against the run's rawReplies
 * @testonly none
 */
import { describe, expect, it } from "vitest"
import { parseProbeResults } from "./index.ts"

const settleRecord = { "collector.launchSettle": JSON.stringify({ declaredSeconds: 90, effectiveSeconds: 90 }) }
const row = (attempt: Record<string, unknown>) => ({
  featureId: "alpha",
  status: "probe-invalid",
  reason: "retained cause",
  attempt,
  tests: [{ id: "criterion", status: "probe-invalid", reason: "retained cause", attempt }],
})
const parse = (attempt: Record<string, unknown>, rawReplies: Record<string, string>) =>
  parseProbeResults([row(attempt)], "run.json", new Set(["alpha"]), rawReplies, [])

describe("launch-settle witness on attempts (37225)", () => {
  it("keeps msAfterLaunchSettle on the row and its tests", () => {
    const [result] = parse(
      { scope: "probe", startedAt: "2026-11-20T20:00:01.500Z", msAfterLaunchSettle: 1500 },
      settleRecord,
    )
    expect(result?.attempt).toEqual({
      scope: "probe",
      startedAt: "2026-11-20T20:00:01.500Z",
      msAfterLaunchSettle: 1500,
    })
    expect(result?.tests[0]?.attempt).toMatchObject({ msAfterLaunchSettle: 1500 })
  })

  it("parses an attempt without a witness exactly as before", () => {
    const [result] = parse({ scope: "probe", startedAt: "2026-11-20T20:00:01.500Z" }, {})
    expect(result?.attempt).toEqual({ scope: "probe", startedAt: "2026-11-20T20:00:01.500Z" })
  })

  it("refuses a witness on a run without its collector.launchSettle record", () => {
    expect(() =>
      parse({ scope: "probe", startedAt: "2026-11-20T20:00:01.500Z", msAfterLaunchSettle: 1500 }, {}),
    ).toThrow(/without the run's collector.launchSettle record/)
  })

  it.each([-1, 1.5, "1500"])("refuses a witness of %s", (value) => {
    expect(() =>
      parse({ scope: "probe", startedAt: "2026-11-20T20:00:01.500Z", msAfterLaunchSettle: value }, settleRecord),
    ).toThrow(/msAfterLaunchSettle must be a whole number/)
  })

  it("refuses a witness on an unstarted attempt", () => {
    expect(() =>
      parseProbeResults(
        [{ featureId: "alpha", status: "probe-todo", attempt: { scope: "none", msAfterLaunchSettle: 0 }, tests: [] }],
        "run.json",
        new Set(["alpha"]),
        settleRecord,
        [],
      ),
    ).toThrow(/unstarted attempt cannot carry execution facts/)
  })
})
