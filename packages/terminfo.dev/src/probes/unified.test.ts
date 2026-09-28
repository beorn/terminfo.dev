/**
 * @failure A legacy callback is graded from its boolean or its exact TTY reply bytes are discarded.
 * @level l1
 * @consumer Real-terminal app, daemon, and inline probe batch
 * @testonly none
 */
import { afterEach, expect, it } from "vitest"
import { runProbeBatch } from "./unified.ts"

const originalWrite = process.stdout.write
afterEach(() => {
  process.stdout.write = originalWrite
  process.stdin.removeAllListeners("data")
})

it("keeps a successful old query as an ungraded diagnostic with exact outbound and reply bytes", async () => {
  const received = Buffer.from([0xff, ...Buffer.from("\x1b[?62;4c")])
  process.stdout.write = (() => {
    process.stdin.emit("data", received)
    return true
  }) as typeof process.stdout.write
  const batch = await runProbeBatch({ ids: ["device.primary-da"] })
  expect(batch.observations).toEqual([])
  expect(batch.assertions).toEqual([])
  expect(batch.ungradedDiagnostics["device.primary-da"]).toMatchObject({ kind: "legacy-callback", pass: true })
  expect(batch.suiteComplete).toBe(false)
  expect(batch.rawReplies["device.primary-da"]).toBe(received.toString())
  const trace = JSON.parse(batch.rawReplies["device.primary-da.trace"]!) as {
    queries: Array<{ sequence: string; reason: string; rawBase64: string }>
  }
  expect(trace.queries).toMatchObject([{ sequence: "\x1b[c", reason: "reply", rawBase64: received.toString("base64") }])
})

it("keeps the reply trace when stdin emits outside the callback's async context", async () => {
  let wrote: (() => void) | undefined
  const outbound = new Promise<void>((resolve) => {
    wrote = resolve
  })
  process.stdout.write = (() => {
    wrote?.()
    return true
  }) as typeof process.stdout.write
  const pending = runProbeBatch({ ids: ["device.primary-da"] })
  await outbound
  process.stdin.emit("data", Buffer.from("\x1b[?62;4c"))
  const batch = await pending
  const trace = JSON.parse(batch.rawReplies["device.primary-da.trace"]!) as {
    events: Array<{ kind: string; sequence: string }>
  }
  expect(trace.events).toMatchObject([{ kind: "query", sequence: "\x1b[c" }])
})

it("keeps an old callback exception outside observations and records no false result", async () => {
  process.stdout.write = (() => {
    throw new Error("TTY write failed")
  }) as typeof process.stdout.write
  const batch = await runProbeBatch({ ids: ["device.primary-da"] })
  expect(batch.observations).toEqual([])
  expect(batch.ungradedDiagnostics["device.primary-da"]).toMatchObject({
    kind: "collector-error",
    name: "Error",
    message: "TTY write failed",
  })
  expect(batch.suiteComplete).toBe(false)
})
