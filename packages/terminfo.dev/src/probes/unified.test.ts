/**
 * @failure A callback's explicit result or exact TTY reply bytes are discarded, or a failed owned restoration is graded as success.
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

it("binds an explicit DA1 observation to exact outbound and reply bytes", async () => {
  const received = Buffer.from([0xff, ...Buffer.from("\x1b[?62;4c")])
  process.stdout.write = (() => {
    process.stdin.emit("data", received)
    return true
  }) as typeof process.stdout.write
  const batch = await runProbeBatch({ ids: ["device.primary-da"] })
  expect(batch.observations).toEqual([
    expect.objectContaining({
      featureId: "device.primary-da",
      outcome: "supported",
      evidence: "query",
      rawReplyRef: "device.primary-da",
    }),
  ])
  expect(batch.assertions).toEqual([
    expect.objectContaining({ featureId: "device.primary-da", kind: "positive", rawReplyRef: "device.primary-da" }),
  ])
  expect(batch.ungradedDiagnostics["device.primary-da"]).toBeUndefined()
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

it("records an opted-in query callback exception as collector error, never support", async () => {
  process.stdout.write = (() => {
    throw new Error("TTY write failed")
  }) as typeof process.stdout.write
  const batch = await runProbeBatch({ ids: ["device.primary-da"] })
  expect(batch.observations).toEqual([
    expect.objectContaining({
      featureId: "device.primary-da",
      outcome: "error",
      reason: "collector-error",
      evidence: "query",
      note: "TTY write failed",
    }),
  ])
  expect(batch.ungradedDiagnostics["device.primary-da"]).toBeUndefined()
  expect(batch.suiteComplete).toBe(false)
})

// A live fixture must bind its independent X11 events to the same feature trace, after pixel checkpoints.
it("runs owned OSC 52 after pixels and retains timestamped independent clipboard operations", async () => {
  const writes: string[] = []
  const order: string[] = []
  process.stdout.write = ((text: string) => {
    writes.push(text)
    if (text.startsWith("\x1b]52;c;")) order.push("osc52")
    return true
  }) as typeof process.stdout.write
  const batch = await runProbeBatch({
    ids: ["extensions.osc52-write", "sgr.underline.curly"],
    capture: async ({ role, label }) => {
      order.push(`capture-${role}`)
      return { frame: { role, label, capturedAt: Date.now(), ref: `sha256:${"a".repeat(64)}` }, trace: {} }
    },
    clipboard: {
      profile: "allow",
      config: "fixture",
      permissions: "fixture",
      summary: "{}",
      dispose: async () => {},
      async withClipboardFixture(work, trace) {
        const at = new Date().toISOString()
        const result = await work({
          readText: async () => {
            const frame = writes.findLast((text) => text.startsWith("\x1b]52;c;"))
            const nonce = frame ? atob(/\x1b\]52;c;([^\x07]+)\x07/.exec(frame)?.[1] ?? "") : ""
            trace({ kind: "clipboard-read", at, sha256: "a".repeat(64), length: nonce.length })
            return nonce
          },
          writeText: async () => {},
        })
        trace({ kind: "clipboard-restore", at, sha256: "b".repeat(64), length: 8 })
        trace({ kind: "clipboard-verify", at, sha256: "b".repeat(64), length: 8 })
        return result
      },
    },
  })
  expect(order).toEqual(["capture-control", "capture-target", "osc52"])
  expect(batch.observations.find((item) => item.featureId === "extensions.osc52-write")).toMatchObject({
    outcome: "supported",
    rawReplyRef: "extensions.osc52-write",
  })
  const trace = JSON.parse(batch.rawReplies["extensions.osc52-write"]!) as {
    clipboard: Array<{ kind: string; at: string }>
  }
  expect(trace.clipboard.map((event) => event.kind)).toEqual([
    "clipboard-read",
    "clipboard-restore",
    "clipboard-verify",
  ])
})

it("records failed clipboard restoration as collector error rather than retaining callback success", async () => {
  process.stdout.write = (() => true) as typeof process.stdout.write
  const batch = await runProbeBatch({
    ids: ["extensions.osc52-write"],
    clipboard: {
      profile: "allow",
      config: "fixture",
      permissions: "fixture",
      summary: "{}",
      dispose: async () => {},
      async withClipboardFixture(_work, trace) {
        trace({ kind: "clipboard-restore", at: new Date().toISOString(), sha256: "b".repeat(64), length: 8 })
        throw new Error("Owned clipboard restoration failed")
      },
    },
  })
  expect(batch.observations).toEqual([
    expect.objectContaining({
      featureId: "extensions.osc52-write",
      outcome: "error",
      reason: "collector-error",
      rawReplyRef: "extensions.osc52-write",
    }),
  ])
  expect(batch.suiteComplete).toBe(false)
})

// AC1/AC3: images belong to the callback's run before it is sealed. Existing
// transport tests only observe replies and cannot detect a detached screenshot.
it("retains same-callback control and target frames without declaring visual support", async () => {
  const writes: string[] = []
  process.stdout.write = ((value: string) => {
    writes.push(value)
    if (value.includes("\x1b[6n")) process.stdin.emit("data", Buffer.from("\x1b[1;2R"))
    return true
  }) as typeof process.stdout.write
  const frames = [
    { role: "control" as const, ref: `sha256:${"a".repeat(64)}`, capturedAt: 1, label: "Unstyled X" },
    { role: "target" as const, ref: `sha256:${"b".repeat(64)}`, capturedAt: 2, label: "sgr.underline.curly" },
  ]
  const checkpoints: Array<{ featureId: string; role: string; writes: string }> = []
  const batch = await runProbeBatch({
    ids: ["sgr.underline.curly"],
    capture: async ({ featureId, role }) => {
      checkpoints.push({ featureId, role, writes: writes.join("") })
      const frame = frames[checkpoints.length - 1]
      if (!frame) throw new Error("Unexpected capture checkpoint")
      return { frame, trace: { windowId: "owned-window", geometry: "800x600", font: "fixture" } }
    },
  })
  expect(checkpoints.map(({ featureId, role }) => ({ featureId, role }))).toEqual([
    { featureId: "sgr.underline.curly", role: "control" },
    { featureId: "sgr.underline.curly", role: "target" },
  ])
  expect(checkpoints[0]?.writes).not.toContain("\x1b[4:3m")
  expect(checkpoints[1]?.writes).toContain("\x1b[4:3m")
  expect(batch.screenshotRefs).toEqual(frames.map(({ ref }) => ref))
  expect(batch.observations).toEqual([
    expect.objectContaining({
      featureId: "sgr.underline.curly",
      outcome: "inconclusive",
      evidence: "pixels",
      reason: "insufficient-evidence",
      screenshotRef: frames[1]?.ref,
      frames,
      rawReplyRef: "sgr.underline.curly",
    }),
  ])
  const trace = JSON.parse(batch.rawReplies["sgr.underline.curly"]!) as { captures: unknown[] }
  expect(trace.captures).toHaveLength(2)
  expect(batch.suiteComplete).toBe(false)
})

it("records an installed capture adapter failure as an error rather than quietly dropping pixels", async () => {
  process.stdout.write = ((value: string) => {
    if (value.includes("\x1b[6n")) process.stdin.emit("data", Buffer.from("\x1b[1;2R"))
    return true
  }) as typeof process.stdout.write
  const batch = await runProbeBatch({
    ids: ["sgr.underline.curly"],
    capture: () => Promise.reject(new Error("Owned window disappeared")),
  })
  expect(batch.observations).toEqual([
    expect.objectContaining({
      featureId: "sgr.underline.curly",
      outcome: "error",
      evidence: "pixels",
      reason: "collector-error",
      note: "Owned window disappeared",
    }),
  ])
  expect(batch.screenshotRefs).toEqual([])
  expect(batch.ungradedDiagnostics).toEqual({})
})
