/**
 * @failure A caught unfinished recorder/replay attempt later becomes a completed replay, or strict replay changes captured effects.
 * @level l0
 * @consumer Phase0 runner-owned synchronous finalization of the generic call log.
 * @testonly none
 */
import { expect, test } from "vitest"
import { createCallLog, IncompleteReplay, withCallLog } from "../src/call-log.ts"

test.each(["record", "replay"] as const)(
  "unfinished %s finalization stays Incomplete after settlement",
  async (mode) => {
    const subject = { read: async () => "recorded" }
    const log = createCallLog()
    if (mode === "replay") {
      const capture = withCallLog(subject, { mode: "record", log })
      await capture.context.read()
      capture.finish()
    }
    const session =
      mode === "record"
        ? withCallLog(subject, { mode: "record", log })
        : withCallLog<typeof subject>(null, { mode: "replay", log })
    const work = session.context.read()
    let first: unknown
    let second: unknown
    try {
      session.finish()
    } catch (error) {
      first = error
    }
    await work
    try {
      session.finish()
    } catch (error) {
      second = error
    }
    expect.soft(first).toBeInstanceOf(IncompleteReplay)
    expect(second).toBe(first)
  },
)

test("completed capture and strict replay preserve writes, nested paths and returned observations", () => {
  const writes: string[] = []
  const subject = {
    feed: (text: string) => {
      writes.push(text)
    },
    getCell: () => ({ char: "X", bold: true }),
    input: {
      send: (text: string) => {
        writes.push(text)
      },
    },
  }
  const log = createCallLog()
  const capture = withCallLog(subject, { mode: "record", log })
  capture.context.feed("seed")
  expect(capture.context.getCell()).toEqual({ char: "X", bold: true })
  capture.context.input.send("key")
  capture.finish()
  const replay = withCallLog<typeof subject>(null, { mode: "replay", log })
  replay.context.feed("seed")
  expect(replay.context.getCell()).toEqual({ char: "X", bold: true })
  replay.context.input.send("key")
  replay.finish()
  expect(writes).toEqual(["seed", "key"])
})
