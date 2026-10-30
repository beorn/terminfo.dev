/**
 * @failure A caught unfinished recorder/replay attempt later becomes a completed replay, or strict replay changes captured effects.
 * @level l0
 * @consumer Phase0 runner-owned synchronous finalization of the generic call log.
 * @testonly none
 */
import { expect, test } from "vitest"
import { createCallLog, IncompleteReplay, withCallLog } from "../src/call-log.ts"

test("completed call logs expose no mutable storage and serialize with canonical tagged keys", () => {
  const subject = { z: 2, a: 1, read: () => ({ z: "last", a: "first" }) }
  const log = createCallLog()
  const capture = withCallLog(subject, { mode: "record", log })
  capture.context.read()
  capture.finish()
  expect.soft(Object.keys(log)).toEqual([])
  const serialized = JSON.stringify(log)
  expect.soft(JSON.parse(serialized)).toMatchObject({ format: "viprobe.call-log", version: 1 })
  const visit = (value: unknown) => {
    if (value === null || typeof value !== "object") return
    if (!Array.isArray(value)) expect.soft(Object.keys(value)).toEqual(Object.keys(value).sort())
    for (const child of Object.values(value)) visit(child)
  }
  visit(JSON.parse(serialized))
})

test("unfinished logs cannot be serialized as complete artifacts", async () => {
  const log = createCallLog()
  expect(() => JSON.stringify(log)).toThrow(IncompleteReplay)
  const capture = withCallLog({ read: async () => "value" }, { mode: "record", log })
  const pending = capture.context.read()
  expect(() => JSON.stringify(log)).toThrow(IncompleteReplay)
  await pending
  capture.finish()
  expect(() => JSON.stringify(log)).not.toThrow()
})

test.each(["record", "replay"] as const)("finished %s sessions cannot append operations", (mode) => {
  const subject = { read: () => "value" }
  const log = createCallLog()
  const capture = withCallLog(subject, { mode: "record", log })
  capture.context.read()
  capture.finish()
  const session = mode === "record" ? capture : withCallLog<typeof subject>(null, { mode: "replay", log })
  if (mode === "replay") {
    session.context.read()
    session.finish()
  }
  const bytes = JSON.stringify(log)
  expect(() => session.context.read()).toThrow(IncompleteReplay)
  expect(JSON.stringify(log)).toBe(bytes)
})

test("caught unencodable input keeps capture finalization incomplete", () => {
  const cycle: { self?: unknown } = {}
  cycle.self = cycle
  const capture = withCallLog({ write: (value: unknown) => String(value) }, { mode: "record", log: createCallLog() })
  let failure: unknown
  try {
    capture.context.write(cycle)
  } catch (error) {
    failure = error
  }
  expect.soft(failure).toBeInstanceOf(IncompleteReplay)
  let finished: unknown
  try {
    capture.finish()
  } catch (error) {
    finished = error
  }
  expect(finished).toBe(failure)
})

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
