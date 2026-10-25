/**
 * @failure Recorder eagerly reads guarded getters or loses asynchronous timeout/callback replay evidence.
 * @level l0
 * @consumer Spike B private daemon context recorder and offline replay.
 * @testonly none
 */
import { expect, test } from "vitest"
import { createCallLog, withCallLog, type CallLog } from "./call-log.ts"

test("lazy geometry and nested callback/returned methods survive serialized offline replay", async () => {
  let reads = 0
  let liveCalls = 0
  const subject = {
    get cols(): number {
      throw new Error("unused geometry")
    },
    get rows() {
      return ++reads
    },
    get refused(): number {
      throw new RangeError("geometry refused")
    },
    returned: async () => ({
      read: async () => {
        liveCalls++
        return 31
      },
    }),
    fixture: async (work: (value: { read: () => Promise<number> }) => Promise<number>) =>
      work({
        read: async () => {
          liveCalls++
          return 29
        },
      }),
  }
  const exercise = async (context: typeof subject, adjustment = 0) => {
    const first = context.rows
    let refusal: unknown
    try {
      void context.refused
    } catch (error) {
      refusal = error
    }
    expect(refusal).toBeInstanceOf(RangeError)
    expect(refusal).toMatchObject({ name: "RangeError", message: "geometry refused" })
    return [
      first,
      context.rows,
      await (await context.returned()).read(),
      await context.fixture(async (value) => (await value.read()) + adjustment),
    ]
  }
  const log = createCallLog()
  const recording = withCallLog(subject, { mode: "record", log })
  expect(reads).toBe(0)
  expect(await exercise(recording.context)).toEqual([1, 2, 31, 29])
  recording.finish()
  const stored = JSON.parse(JSON.stringify(log)) as CallLog
  const replay = withCallLog<typeof subject>(null, { mode: "replay", log: stored })
  expect(await exercise(replay.context)).toEqual([1, 2, 31, 29])
  replay.finish()
  expect(reads).toBe(2)
  expect(liveCalls).toBe(2)
  const incomplete = withCallLog<typeof subject>(null, { mode: "replay", log: stored })
  expect(() => incomplete.finish()).toThrow(/unconsumed/)
  const changed = withCallLog<typeof subject>(null, { mode: "replay", log: stored })
  await expect(exercise(changed.context, 1)).rejects.toThrow(/callback outcome changed/)
  expect(() => changed.finish()).toThrow(/callback outcome changed/)
})

test("synthetic timeout preserves deadline and per-call replay clocks without a live wait", async () => {
  const timeout = { match: null, reason: "timeout" as const, raw: "", rawBase64: "" }
  const subject = {
    queryWithSentinelOutcome: async (_sequence: string, _pattern: RegExp, _deadline?: number) => timeout,
    queryWithSentinel: async (_sequence: string, _pattern: RegExp, _deadline?: number) => null,
    query: async (_sequence: string, _pattern: RegExp, _deadline?: number) => null,
    queryOutcome: async (_sequence: string, _pattern: RegExp, _deadline?: number) => timeout,
    readInput: async (_pattern: RegExp, _deadline?: number, inject?: () => Promise<void>) => {
      await inject?.()
      return ["a"]
    },
    input: { injectKey: async (_key: string) => {} },
  }
  const exercise = async (context: typeof subject) => {
    expect(await context.queryWithSentinelOutcome("request", /reply/, 60_000)).toEqual(timeout)
    await context.queryWithSentinelOutcome("request", /reply/)
    await context.queryWithSentinel("request", /reply/)
    await context.query("request", /reply/)
    await context.queryOutcome("request", /reply/)
    expect(await context.readInput(/^a/, undefined, () => context.input.injectKey("a"))).toEqual(["a"])
  }
  const log = createCallLog()
  const recording = withCallLog(subject, { mode: "record", log })
  await exercise(recording.context)
  recording.finish()
  expect(log.calls.map((call) => call.effectiveDeadlineMs)).toEqual([60_000, 2000, 2000, 1000, 1000, 1000, undefined])
  const replay = withCallLog<typeof subject>(null, { mode: "replay", log: JSON.parse(JSON.stringify(log)) as CallLog })
  await exercise(replay.context)
  replay.finish()
  expect(replay.replayTimings.map((call) => call.id)).toEqual(log.calls.map((call) => call.id))
  for (const call of log.calls) {
    expect(call.timing.startedAtMs).toBeGreaterThan(0)
    expect(call.timing.settledAtMs).toBeGreaterThanOrEqual(call.timing.startedAtMs)
    expect(call.timing.settledPerformanceMs).toBeGreaterThanOrEqual(call.timing.startedPerformanceMs)
  }
  for (const timing of replay.replayTimings) {
    expect(timing.startedAt).toBeGreaterThan(0)
    expect(timing.finishedAt).toBeGreaterThanOrEqual(timing.startedAt)
    expect(timing.finishedMonotonic).toBeGreaterThanOrEqual(timing.startedMonotonic)
  }
  const elapsed = replay.replayTimings[0]!.finishedMonotonic! - replay.replayTimings[0]!.startedMonotonic
  expect(elapsed).toBeLessThan(1000)
})
