/**
 * @failure A library callback draws randomness the call log does not hold, a replay returns different values than
 * the run did, or a replay short of a recorded draw silently draws a fresh one (#30932 AC1).
 * @level l1
 * @consumer `createLibProbeSource` (headless-batch.ts) -> probe-defs lib callbacks -> the #30932 S3 call log ->
 * lib replay in stored-run-shadow.ts; the row's `randomUUID` draws are recorded calls, not a side channel.
 * @reach fixture-only: a plain context object and a hand-written log; no backend, terminal or collector starts
 * @testonly none
 */
import { expect, it } from "vitest"
import { inertLibProbeSource } from "../probe-defs/src/testing/group-harness.ts"
import { IncompleteReplay, createCallLog, readCallLog, withCallLog } from "../viprobe/src/call-log.ts"

/** The shape `createLibProbeSource` hands a lib callback: a draw is a call the log records like any other. */
const context = () => ({ randomUUID: () => globalThis.crypto.randomUUID() })

const recordedLog = () => {
  const log = createCallLog()
  const session = withCallLog(context(), { mode: "record", log })
  const drawn = [session.context.randomUUID(), session.context.randomUUID()]
  session.finish()
  // Exactly what the collector stores: JSON.stringify of the log (headless-batch collectPass).
  return { drawn, stored: JSON.parse(JSON.stringify(log)) as { calls: unknown[] } }
}

it("a replay hands back the same identifiers in the same order", () => {
  const { drawn, stored } = recordedLog()
  for (const value of drawn) expect(value).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  expect(new Set(drawn).size).toBe(2)
  const replay = withCallLog<ReturnType<typeof context>>(null, { mode: "replay", log: readCallLog(stored) })
  expect([replay.context.randomUUID(), replay.context.randomUUID()]).toEqual(drawn)
  expect(() => replay.finish()).not.toThrow()
})

it("a replay one draw short refuses by name instead of drawing a fresh identifier", () => {
  const { stored } = recordedLog()
  stored.calls.pop()
  const replay = withCallLog<ReturnType<typeof context>>(null, { mode: "replay", log: readCallLog(stored) })
  replay.context.randomUUID()
  const error = (() => {
    try {
      replay.context.randomUUID()
      return undefined
    } catch (caught) {
      return caught
    }
  })()
  expect(error).toBeInstanceOf(IncompleteReplay)
  expect((error as Error).message).toMatch(/missing call 1: context\.randomUUID$/)
})

it("the inert fixture draws distinct identifiers in order, so a probe test can see both", () => {
  const source = inertLibProbeSource()
  const first = source.randomUUID()
  const second = source.randomUUID()
  expect(first).not.toBe(second)
  expect(first).toMatch(/^00000000-0000-4000-8000-\d{12}$/)
})
