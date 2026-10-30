/**
 * @failure A caught unfinished recorder/replay attempt later becomes a completed replay, or strict replay changes captured effects.
 * @level l0
 * @consumer Phase0 runner-owned synchronous finalization of the generic call log.
 * @testonly none
 */
import { expect, test } from "vitest"
import { createCallLog, IncompleteReplay, readCallLog, withCallLog } from "../src/index.ts"

// readResponse hands start/cancel functions through its registration callback.
// Object-only callback fixtures cannot prove that invoking these effects is recorded and replayed.
test("deferred callback functions remain ordered operations after persistence", async () => {
  const subject = {
    listen(register: (start: () => void, cancel: () => void) => void): Promise<string> {
      return new Promise((resolve) =>
        register(
          () => resolve("reply"),
          () => resolve("cancelled"),
        ),
      )
    },
  }
  const log = createCallLog()
  const capture = withCallLog(subject, { mode: "record", log })
  let start: (() => void) | undefined
  const pending = capture.context.listen((begin) => {
    start = begin
  })
  if (!start) throw new Error("Registration did not provide a start function")
  start()
  expect(await pending).toBe("reply")
  capture.finish()
  const bytes = JSON.stringify(log)
  const replay = withCallLog<typeof subject>(null, { mode: "replay", log: readCallLog(JSON.parse(bytes)) })
  let replayStart: (() => void) | undefined
  const replayed = replay.context.listen((begin) => {
    replayStart = begin
  })
  if (!replayStart) throw new Error("Replay registration did not provide a start function")
  replayStart()
  expect(await replayed).toBe("reply")
  replay.finish()
  expect(JSON.stringify(readCallLog(JSON.parse(bytes)))).toBe(bytes)
  const skipped = withCallLog<typeof subject>(null, { mode: "replay", log: readCallLog(JSON.parse(bytes)) })
  expect(await skipped.context.listen(() => {})).toBe("reply")
  expect(() => skipped.finish()).toThrow(IncompleteReplay)
})

// The TTY host needs decoded display data without a second decoder or executable replay handles.
test("validated operation projection is ordered, inert and detached from canonical bytes", async () => {
  let getterReads = 0
  let functionCalls = 0
  const argument = {
    bytes: new Uint8Array([0, 255]),
    pattern: /reply/gi,
    values: new Set(["one", "two"]),
    callback: () => {
      functionCalls++
    },
    get lazy() {
      getterReads++
      return "not read"
    },
  }
  const log = createCallLog()
  const capture = withCallLog(
    {
      async inspect(_argument: typeof argument, _callback: () => void) {
        return { observed: true }
      },
      fail() {
        throw new TypeError("retained failure")
      },
    },
    { mode: "record", log },
  )
  await capture.context.inspect(argument, () => {
    functionCalls++
  })
  expect(() => capture.context.fail()).toThrow("retained failure")
  capture.finish()
  const bytes = JSON.stringify(log)
  const seen: unknown[] = []
  const loaded = readCallLog(JSON.parse(bytes), { onOperation: (operation) => seen.push(operation) })
  const timing = {
    startedAtMs: expect.any(Number),
    startedPerformanceMs: expect.any(Number),
    settledAtMs: expect.any(Number),
    settledPerformanceMs: expect.any(Number),
  }
  expect(seen).toEqual([
    {
      path: "context.inspect",
      args: [
        {
          bytes: { kind: "bytes", length: 2, base64: "AP8=" },
          pattern: { kind: "regexp", source: "reply", flags: "gi" },
          values: { kind: "set", values: ["one", "two"] },
          callback: { kind: "function" },
          lazy: { kind: "accessor" },
        },
        { kind: "function" },
      ],
      outcome: { asynchronous: true, value: { observed: true }, timing },
    },
    {
      path: "context.fail",
      args: [],
      outcome: { asynchronous: false, error: { name: "TypeError", message: "retained failure" }, timing },
    },
  ])
  expect(getterReads).toBe(0)
  expect(functionCalls).toBe(0)
  const mutate = (value: unknown): void => {
    if (value === null || typeof value !== "object") return
    expect(Object.isFrozen(value)).toBe(true)
    expect(Reflect.set(value, "projectionMutation", true)).toBe(false)
    for (const entry of Object.values(value)) mutate(entry)
  }
  for (const operation of seen) mutate(operation)
  expect(JSON.stringify(loaded)).toBe(bytes)
  expect(JSON.stringify(readCallLog(JSON.parse(bytes)))).toBe(bytes)
  expect(JSON.stringify(log)).toBe(bytes)
})

test("an invalid trailing operation cannot deliver a partial projection", () => {
  const log = createCallLog()
  const capture = withCallLog(
    {
      read(callback?: () => number) {
        callback?.()
        return "value"
      },
    },
    { mode: "record", log },
  )
  capture.context.read()
  capture.context.read(() => 1)
  capture.finish()
  for (const target of ["operation", "callback"]) {
    const raw = record(JSON.parse(JSON.stringify(log)))
    const call = storedCall(raw, 1)
    if (target === "operation") call.finished = false
    else {
      const callbacks = call.callbacks
      if (!Array.isArray(callbacks)) throw new Error("Expected retained callback list")
      record(callbacks[0]).finished = false
    }
    let projected = 0
    expect(() =>
      readCallLog(raw, {
        onOperation: () => {
          projected++
        },
      }),
    ).toThrow(IncompleteReplay)
    expect(projected).toBe(0)
  }
})

test("a projection observer error stops delivery without changing the artifact", () => {
  const log = createCallLog()
  const capture = withCallLog(
    {
      read() {
        return "value"
      },
    },
    { mode: "record", log },
  )
  capture.context.read()
  capture.context.read()
  capture.finish()
  const bytes = JSON.stringify(log)
  const failure = new Error("display projection failed")
  let projected = 0
  expect(() =>
    readCallLog(JSON.parse(bytes), {
      onOperation: () => {
        projected++
        throw failure
      },
    }),
  ).toThrow(failure)
  expect(projected).toBe(1)
  expect(JSON.stringify(readCallLog(JSON.parse(bytes)))).toBe(bytes)
})

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("expected fixture object")
  return value
}

function storedCall(value: Record<string, unknown>, index = 0): Record<string, unknown> {
  if (!Array.isArray(value.calls)) throw new Error("expected fixture calls")
  return record(value.calls[index])
}

async function capturedCallback() {
  const subject = {
    run: async (work: (input: { read(): Promise<string> }) => Promise<string>) => work({ read: async () => "cell" }),
  }
  const log = createCallLog()
  const capture = withCallLog(subject, { mode: "record", log })
  expect(await capture.context.run(async (input) => `${await input.read()}!`)).toBe("cell!")
  capture.finish()
  return { subject, bytes: JSON.stringify(log) }
}

test("canonical artifacts roundtrip byte-for-byte and replay real nested callbacks", async () => {
  const { subject, bytes } = await capturedCallback()
  const loaded = readCallLog(JSON.parse(bytes))
  expect(JSON.stringify(loaded)).toBe(bytes)
  let invoked = 0
  const replay = withCallLog<typeof subject>(null, { mode: "replay", log: loaded })
  const value = await replay.context.run(async (input) => {
    invoked++
    return `${await input.read()}!`
  })
  expect(value).toBe("cell!")
  expect(invoked).toBe(1)
  replay.finish()
  expect(JSON.stringify(loaded)).toBe(bytes)
})

test("array validation rejects getters without evaluating persisted code", async () => {
  const { bytes } = await capturedCallback()
  const stored = record(JSON.parse(bytes))
  if (!Array.isArray(stored.calls)) throw new Error("expected fixture calls")
  const first = stored.calls[0]
  let invoked = 0
  Object.defineProperty(stored.calls, "0", {
    configurable: true,
    enumerable: true,
    get() {
      invoked++
      return first
    },
  })
  expect.soft(() => readCallLog(stored)).toThrow(IncompleteReplay)
  expect(invoked).toBe(0)
})

test.each([null, false, 3, "scalar", { kind: "function" }])("rejects non-object root %j even without calls", (root) => {
  expect(() => readCallLog({ format: "viprobe.call-log", version: 1, root, calls: [] })).toThrow(IncompleteReplay)
})

test("a completed empty object remains a valid zero-call capture", () => {
  const log = createCallLog()
  withCallLog({}, { mode: "record", log }).finish()
  const bytes = JSON.stringify(log)
  const loaded = readCallLog(JSON.parse(bytes))
  withCallLog<object>(null, { mode: "replay", log: loaded }).finish()
  expect(JSON.stringify(loaded)).toBe(bytes)
})

test("recording a callable root cannot silently bypass capture", () => {
  expect(() => withCallLog(() => "uncaptured", { mode: "record", log: createCallLog() })).toThrow(IncompleteReplay)
})

test("special values and array metadata survive persisted replay", () => {
  const subject = {
    read: () => ({
      negativeZero: -0,
      numbers: [NaN, Infinity, -Infinity],
      bigint: 42n,
      bytes: new Uint8Array([0, 255]),
      pattern: /x/gi,
      set: new Set([undefined, 2]),
      match: Object.assign(["x"], { index: 0, input: "x", groups: undefined }),
    }),
  }
  const inspect = (context: typeof subject) => {
    const value = context.read()
    expect.soft(Object.is(value.negativeZero, -0)).toBe(true)
    expect(Number.isNaN(value.numbers[0])).toBe(true)
    expect(value.numbers.slice(1)).toEqual([Infinity, -Infinity])
    expect(value.bigint).toBe(42n)
    expect(value.bytes[1]).toBe(255)
    expect(value.pattern.source).toBe("x")
    expect(value.pattern.flags).toBe("gi")
    expect(value.set.has(undefined)).toBe(true)
    expect(value.match.index).toBe(0)
    expect(value.match.input).toBe("x")
    expect(Object.hasOwn(value.match, "groups")).toBe(true)
    expect(value.match.groups).toBeUndefined()
  }
  const log = createCallLog()
  const capture = withCallLog(subject, { mode: "record", log })
  inspect(capture.context)
  capture.finish()
  const bytes = JSON.stringify(log)
  const replay = withCallLog<typeof subject>(null, { mode: "replay", log: readCallLog(JSON.parse(bytes)) })
  inspect(replay.context)
  replay.finish()
})

const invalidArtifacts: Array<[string, (value: Record<string, unknown>) => void]> = [
  [
    "sparse calls",
    (value) => {
      value.calls = new Array(2)
    },
  ],
  [
    "extra array fields",
    (value) => {
      if (!Array.isArray(value.calls)) throw new Error("expected fixture calls")
      Reflect.set(value.calls, "extra", true)
    },
  ],
  [
    "untagged private v1",
    (value) => {
      delete value.format
    },
  ],
  [
    "different format",
    (value) => {
      value.format = "private.call-log"
    },
  ],
  [
    "unknown version",
    (value) => {
      value.version = 2
    },
  ],
  [
    "unknown encoded root",
    (value) => {
      value.root = { kind: "unknown" }
    },
  ],
  [
    "duplicate encoded keys",
    (value) => {
      value.root = {
        kind: "object",
        entries: [
          ["run", { kind: "function" }],
          ["run", { kind: "function" }],
        ],
      }
    },
  ],
  [
    "invalid binary",
    (value) => {
      value.root = { kind: "bytes", value: "%%%" }
    },
  ],
  [
    "invalid regexp",
    (value) => {
      value.root = { kind: "regexp", value: "[", flags: "g" }
    },
  ],
  [
    "unfinished call",
    (value) => {
      storedCall(value).finished = false
    },
  ],
  [
    "missing outcome",
    (value) => {
      delete storedCall(value).value
    },
  ],
  [
    "invalid call index",
    (value) => {
      storedCall(value).id = 90
    },
  ],
  [
    "invalid async marker",
    (value) => {
      storedCall(value).asynchronous = "yes"
    },
  ],
  [
    "invalid argument encoding",
    (value) => {
      storedCall(value).args = [{ kind: "bad" }]
    },
  ],
  [
    "dangling method reference",
    (value) => {
      storedCall(value, 1).path = "context.run#99.callback0.arg0.read"
    },
  ],
  [
    "missing referenced method",
    (value) => {
      storedCall(value, 1).path = "context.run#0.callback0.arg0.missing"
    },
  ],
  [
    "malformed result reference",
    (value) => {
      storedCall(value, 1).path = "context.run#0.resultExtra.read"
    },
  ],
  [
    "callback argument",
    (value) => {
      const callbacks = storedCall(value).callbacks
      if (!Array.isArray(callbacks)) throw new Error("expected callbacks")
      record(callbacks[0]).argument = 90
    },
  ],
  [
    "callback path",
    (value) => {
      const callbacks = storedCall(value).callbacks
      if (!Array.isArray(callbacks)) throw new Error("expected callbacks")
      record(callbacks[0]).path = "context.different#0.callback0"
    },
  ],
]

test.each(invalidArtifacts)("rejects %s before making callbacks reachable", async (_name, mutate) => {
  const { bytes } = await capturedCallback()
  const stored = record(JSON.parse(bytes))
  mutate(stored)
  expect(() => readCallLog(stored)).toThrow(IncompleteReplay)
})

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
