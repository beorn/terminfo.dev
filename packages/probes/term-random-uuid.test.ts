/**
 * @failure A term callback draws randomness outside `TermProbeSource.randomUUID`, a replay returns different
 * identifiers than the live run did, a replay one draw short silently draws a fresh identifier, or a source
 * without `randomUUID` falls back to global crypto (#30932 AC1).
 * @level l1
 * @consumer `createTermProbeSource` (unified.ts) -> `sourceRandomUUID` -> probe-defs term callbacks ->
 * the #30932 call log -> term replay in stored-run-shadow.ts.
 * @reach fixture-only: a plain context object and a hand-written log; no terminal or collector starts
 * @testonly none
 */
import { expect, it } from "vitest"
import { SOURCE_RANDOM_MISSING, sourceRandomUUID } from "../probe-defs/src/source-clock.ts"
import { replayTermProbeSource } from "../probe-defs/src/testing/group-harness.ts"
import { IncompleteReplay, createCallLog, readCallLog, withCallLog } from "../viprobe/src/call-log.ts"

const context = () => ({ randomUUID: () => globalThis.crypto.randomUUID() })

const recordedLog = () => {
  const log = createCallLog()
  const session = withCallLog(context(), { mode: "record", log })
  const drawn = [sourceRandomUUID(session.context), sourceRandomUUID(session.context)]
  session.finish()
  return { drawn, stored: JSON.parse(JSON.stringify(log)) as { calls: unknown[] } }
}

it("a replay hands back the same term identifiers in the same order", () => {
  const { drawn, stored } = recordedLog()
  for (const value of drawn) expect(value).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  expect(new Set(drawn).size).toBe(2)
  const replay = withCallLog<ReturnType<typeof context>>(null, { mode: "replay", log: readCallLog(stored) })
  expect([sourceRandomUUID(replay.context), sourceRandomUUID(replay.context)]).toEqual(drawn)
  expect(() => replay.finish()).not.toThrow()
})

it("a replay one draw short refuses by name instead of drawing a fresh identifier", () => {
  const { stored } = recordedLog()
  stored.calls.pop()
  const replay = withCallLog<ReturnType<typeof context>>(null, { mode: "replay", log: readCallLog(stored) })
  sourceRandomUUID(replay.context)
  const error = (() => {
    try {
      sourceRandomUUID(replay.context)
      return undefined
    } catch (caught) {
      return caught
    }
  })()
  expect(error).toBeInstanceOf(IncompleteReplay)
  expect((error as Error).message).toMatch(/missing call 1: context\.randomUUID$/)
})

it("sourceRandomUUID refuses a source without randomUUID instead of falling back to global crypto", () => {
  let caught: unknown
  try {
    sourceRandomUUID({})
  } catch (error) {
    caught = error
  }
  expect(caught).toBeInstanceOf(Error)
  expect((caught as Error).name).toBe(SOURCE_RANDOM_MISSING)
})

it("replayTermProbeSource supplies deterministic distinct identifiers", () => {
  const source = replayTermProbeSource(new Map())
  const first = sourceRandomUUID(source)
  const second = sourceRandomUUID(source)
  expect(first).not.toBe(second)
  expect(first).toMatch(/^00000000-0000-4000-8000-\d{12}$/)
})
