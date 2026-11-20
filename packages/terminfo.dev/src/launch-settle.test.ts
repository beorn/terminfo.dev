/**
 * @failure A hosted app whose frame moves after launch is judged before it settles, and the run cannot show how long each row waited.
 * @level l1
 * @consumer serve.ts collection (launch settle before the first probe), run.json readers
 * @reach the held wait, the run record and each row's witness (the app table is pinned by owned-terminal.hosted-darwin.test.ts)
 * @testonly none
 */
import { describe, expect, it } from "vitest"
import type { ProbeResult } from "@terminfo/probe-defs"
import {
  LAUNCH_SETTLE_KEY,
  holdLaunchSettle,
  stampMsAfterLaunchSettle,
  type LaunchSettleRecord,
} from "./launch-settle.ts"

describe("launch settle (37225, ruling C on 33774)", () => {
  it("holds the declared wait once and records declared, effective and source", async () => {
    const draft = { rawReplies: {} as Record<string, string> }
    const waits: number[] = []
    const released = await holdLaunchSettle(draft, { seconds: 90, reason: "measured" }, undefined, async (ms) => {
      waits.push(ms)
    })
    expect(waits).toEqual([90_000])
    const record = JSON.parse(draft.rawReplies[LAUNCH_SETTLE_KEY] ?? "null") as LaunchSettleRecord
    expect(record).toMatchObject({
      declaredSeconds: 90,
      effectiveSeconds: 90,
      source: "hosted app table",
      reason: "measured",
    })
    expect(Date.parse(record.endedAt)).toBe(released)
    expect(Date.parse(record.endedAt) - Date.parse(record.startedAt)).toBe(record.waitedMs)
  })

  it("stops at once when the collection is cancelled during the wait", async () => {
    const abort = new AbortController()
    const draft = { rawReplies: {} as Record<string, string> }
    const held = holdLaunchSettle(draft, { seconds: 90, reason: "measured" }, abort.signal)
    abort.abort()
    await expect(held).rejects.toMatchObject({ name: "AbortError" })
    expect(draft.rawReplies).not.toHaveProperty(LAUNCH_SETTLE_KEY)
  })

  it("refuses a declaration that is not whole seconds with a reason", async () => {
    const draft = { rawReplies: {} as Record<string, string> }
    await expect(holdLaunchSettle(draft, { seconds: 0.5, reason: "x" })).rejects.toThrow(/whole seconds >= 1/)
    await expect(holdLaunchSettle(draft, { seconds: 90, reason: " " })).rejects.toThrow(/with a reason/)
  })

  it("stamps every attempted row and test with its ms after the settle and leaves unattempted rows alone", () => {
    const settledAt = Date.parse("2026-11-20T20:00:00.000Z")
    const results: ProbeResult[] = [
      {
        featureId: "text.overwrite",
        status: "supported",
        attempt: { scope: "probe", startedAt: "2026-11-20T20:00:01.500Z" },
        tests: [
          { id: "criterion", status: "supported", attempt: { scope: "probe", startedAt: "2026-11-20T20:00:02.000Z" } },
        ],
      },
      { featureId: "sgr.bold", status: "probe-todo", attempt: { scope: "none" }, tests: [] },
    ]
    stampMsAfterLaunchSettle(results, settledAt)
    expect(results[0]?.attempt).toEqual({
      scope: "probe",
      startedAt: "2026-11-20T20:00:01.500Z",
      msAfterLaunchSettle: 1500,
    })
    expect(results[0]?.tests[0]?.attempt).toMatchObject({ msAfterLaunchSettle: 2000 })
    expect(results[1]?.attempt).toEqual({ scope: "none" })
  })

  it("refuses a row that started before the settle ended", () => {
    const results: ProbeResult[] = [
      {
        featureId: "early",
        status: "probe-invalid",
        attempt: { scope: "probe", startedAt: "2026-11-20T19:59:59.000Z" },
        tests: [],
      },
    ]
    expect(() => stampMsAfterLaunchSettle(results, Date.parse("2026-11-20T20:00:00.000Z"))).toThrow(
      /before the launch settle ended/,
    )
  })
})
