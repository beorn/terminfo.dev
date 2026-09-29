/**
 * @failure A callback's explicit result or exact TTY reply bytes are discarded, or a failed owned restoration is graded as success.
 * @level l1
 * @consumer Real-terminal app, daemon, and inline probe batch
 * @testonly none
 */
import { afterEach, expect, it, vi } from "vitest"
import { ALL_PROBES, type ProbeRun, type ProbeSuiteManifest } from "@terminfo/probe-defs"
import { decodeCollectorRun } from "@terminfo/run-parser"
import * as terminalOwnership from "../owned-terminal.ts"
import { verifyTerminalIdentity } from "../identity-guard.ts"
import { runProbeBatch } from "./unified.ts"

const linuxGeometrySource = "stty size on a /proc/self/fd reopen of the verified output device" as const
const darwinGeometrySource = "stty size on a /dev/fd reopen of the verified output device" as const
const noGeometry = {
  status: "unavailable" as const,
  at: "2026-09-28T00:00:00.000Z",
  source: linuxGeometrySource,
  diagnostic: "No owned size read in fixture",
  stdout: "",
  stderr: "",
}

const probeHash = "f".repeat(12)
const sourceRevision = "e".repeat(40)
const manifest: ProbeSuiteManifest = {
  probeHash,
  sourceRevision,
  generatedAt: "2026-09-28T00:00:00.000Z",
  adapterVersion: "test",
  probes: { app: ALL_PROBES.filter((probe) => probe.term).map((probe) => probe.id), headless: [], mux: [] },
}
function asRun(batch: Awaited<ReturnType<typeof runProbeBatch>>): ProbeRun {
  return {
    schemaVersion: 2,
    runId: "a".repeat(32),
    target: {
      kind: "app",
      id: "kitty",
      version: "0.49.1",
      os: "linux",
      osVersion: null,
      outerTerminal: null,
      mux: null,
      config: null,
      permissions: null,
    },
    identity: "unverified",
    suiteId: probeHash,
    probeHash,
    suiteComplete: false,
    sourceRevision,
    measuredAt: "2026-09-28T00:00:00.000Z",
    origin: { kind: "collector" },
    rawReplies: batch.rawReplies,
    assertions: batch.assertions,
    screenshotRefs: [],
    observations: batch.observations,
    ungradedDiagnostics: batch.ungradedDiagnostics,
  }
}

// An unowned inline batch must refuse before a callback can send RIS or paint the user's TTY.
it("refuses an unowned mutating callback without sending terminal bytes", async () => {
  const writes: string[] = []
  process.stdout.write = ((text: string) => {
    writes.push(text)
    return true
  }) as typeof process.stdout.write
  const batch = await runProbeBatch({ ids: ["reset.ris"], captureRunId: "a".repeat(32) })
  expect(writes).toEqual([])
  expect(batch.observations).toMatchObject([
    { featureId: "reset.ris", outcome: "inconclusive", reason: "policy-refused", evidence: "none" },
  ])
  expect(JSON.parse(batch.rawReplies["reset.ris"]!)).toMatchObject({ writes: [], queries: [], events: [] })

  // A policy refusal must survive the real public/admin parser, not just this batch object.
  const run = asRun(batch)
  expect(
    decodeCollectorRun("test-run.json", JSON.stringify(run), manifest, sourceRevision).run.observations,
  ).toMatchObject([{ featureId: "reset.ris", outcome: "inconclusive", reason: "policy-refused" }])

  // Missing owned geometry also declines before a callback writes; the same exact zero-byte trace must parse.
  run.observations[0] = { ...run.observations[0]!, reason: "insufficient-evidence" }
  expect(
    decodeCollectorRun("geometry-unavailable.json", JSON.stringify(run), manifest, sourceRevision).run.observations,
  ).toMatchObject([{ featureId: "reset.ris", outcome: "inconclusive", reason: "insufficient-evidence" }])
})

it("records an owned default-profile OSC 52 refusal as unmeasured with an empty bound trace", async () => {
  verifiedBatchFixture()
  const writes: string[] = []
  process.stdout.write = ((text: string) => {
    writes.push(text)
    return true
  }) as typeof process.stdout.write
  const batch = await runProbeBatch({ ids: ["extensions.osc52-write"], captureRunId: "a".repeat(32) })
  expect(writes).toEqual([])
  expect(batch.observations).toMatchObject([
    {
      featureId: "extensions.osc52-write",
      outcome: "inconclusive",
      reason: "policy-refused",
      evidence: "none",
      rawReplyRef: "extensions.osc52-write",
    },
  ])
  expect(batch.assertions).toEqual([])
  expect(JSON.parse(batch.rawReplies["extensions.osc52-write"]!)).toEqual({ writes: [], queries: [], events: [] })
})

// A caller cannot manufacture ownership by satisfying the owner's public TypeScript shape.
it("refuses a structural terminal owner even with the same claimed capture ID", async () => {
  const writes: string[] = []
  process.stdout.write = ((text: string) => {
    writes.push(text)
    return true
  }) as typeof process.stdout.write
  const batch = await runProbeBatch({
    ids: ["reset.ris"],
    captureRunId: "a".repeat(32),
    ownedTerminal: geometryOwner(noGeometry),
  })
  expect(writes).toEqual([])
  expect(batch.observations).toMatchObject([
    { featureId: "reset.ris", outcome: "inconclusive", reason: "policy-refused" },
  ])
})

it("lets reviewed DECRPM queries run while refusing cursor and title-writing callbacks", async () => {
  const writes: string[] = []
  process.stdout.write = ((text: string) => {
    writes.push(text)
    if (text === "\x1b[?2004$p\x1b[c") process.stdin.emit("data", Buffer.from("\x1b[?2004;2$y"))
    if (text === "\x1b[?2031$p\x1b[c") process.stdin.emit("data", Buffer.from("\x1b[?2031;2$y"))
    return true
  }) as typeof process.stdout.write
  const batch = await runProbeBatch({
    ids: ["modes.bracketed-paste", "modes.color-scheme-reporting", "cursor.move.absolute", "device.xtwinops-20"],
  })
  expect(writes).toEqual(["\x1b[?2004$p\x1b[c", "\x1b[?2031$p\x1b[c"])
  expect(batch.observations.find((item) => item.featureId === "modes.bracketed-paste")).toMatchObject({
    outcome: "supported",
    evidence: "query",
  })
  expect(batch.observations.find((item) => item.featureId === "modes.color-scheme-reporting")).toMatchObject({
    outcome: "supported",
    evidence: "query",
  })
  for (const id of ["cursor.move.absolute", "device.xtwinops-20"]) {
    expect(batch.observations.find((item) => item.featureId === id)).toMatchObject({
      outcome: "inconclusive",
      reason: "policy-refused",
    })
    expect(JSON.parse(batch.rawReplies[id]!)).toMatchObject({ writes: [], queries: [], events: [] })
  }
})

// A real Terminal.app run returned DA1 as the XTVERSION query's sentinel; it was not an XTVERSION reply.
it("projects Terminal.app identity replies without mistaking the DA1 sentinel for XTVERSION", async () => {
  const da1 = "\x1b[?1;2c"
  const da2 = "\x1b[>1;95;0c"
  const sent: string[] = []
  process.stdout.write = ((sequence: string) => {
    sent.push(sequence)
    if (sequence === "\x1b[c") process.stdin.emit("data", Buffer.from(da1))
    if (sequence === "\x1b[>c\x1b[c") process.stdin.emit("data", Buffer.from(da2 + da1))
    if (sequence === "\x1b[>0q\x1b[c") process.stdin.emit("data", Buffer.from(da1))
    return true
  }) as typeof process.stdout.write

  const batch = await runProbeBatch({ ids: ["device.primary-da", "device.secondary-da", "device.xtversion"] })
  expect(sent).toEqual(["\x1b[c", "\x1b[>c\x1b[c", "\x1b[>0q\x1b[c"])
  expect(batch.observations).toMatchObject([
    { featureId: "device.primary-da", outcome: "supported" },
    { featureId: "device.secondary-da", outcome: "supported" },
    { featureId: "device.xtversion", outcome: "inconclusive", reason: "no-response" },
  ])
  expect(verifyTerminalIdentity("terminal-app", batch.rawReplies)).toMatchObject({ ok: true, checked: true })
  expect(batch.rawReplies["device.secondary-da"]).toBe(da2 + da1)
  expect(JSON.parse(batch.rawReplies["device.secondary-da.trace"]!)).toMatchObject({
    queries: [{ reason: "reply", raw: da2 + da1 }],
  })
  expect(batch.rawReplies["device.xtversion"]).toBe(da1)
  expect(JSON.parse(batch.rawReplies["device.xtversion.trace"]!)).toMatchObject({
    queries: [{ reason: "sentinel", match: null, raw: da1 }],
  })
})

const originalWrite = process.stdout.write
afterEach(() => {
  vi.restoreAllMocks()
  process.stdout.write = originalWrite
  process.stdin.removeAllListeners("data")
})

// These callback/capture contract tests exercise the post-authorization batch path;
// unmocked tests above independently prove a forged adapter cannot authorize it.
function verifiedBatchFixture() {
  vi.spyOn(terminalOwnership, "ownedTerminalVerifiedFor").mockReturnValue(true)
}

const measured = (
  rows: number,
  cols: number,
  source: typeof linuxGeometrySource | typeof darwinGeometrySource = linuxGeometrySource,
) => ({
  status: "measured" as const,
  at: "2026-09-28T00:00:00.000Z",
  source,
  rows,
  cols,
  stdout: `${rows} ${cols}\n`,
  stderr: "",
})

function geometryOwner(
  geometryAtGrant: typeof noGeometry | ReturnType<typeof measured>,
  readGeometry: () => Promise<typeof noGeometry | ReturnType<typeof measured>> = async () => geometryAtGrant,
) {
  return {
    geometrySource: geometryAtGrant.source,
    geometryAtGrant,
    summary: "{}",
    readGeometry,
    dispose: async () => {},
  }
}

it("declines a declared callback with missing or conflicting owned geometry before any feature bytes", async () => {
  verifiedBatchFixture()
  const definition = ALL_PROBES.find((item) => item.id === "reset.ris")!
  expect(definition.termNeedsGeometry).toBe(true)
  const writes: string[] = []
  process.stdout.write = ((text: string) => {
    writes.push(text)
    return true
  }) as typeof process.stdout.write
  const missing = await runProbeBatch({
    ids: ["reset.ris"],
    ownedTerminal: geometryOwner(noGeometry, async () => measured(24, 61)),
  })
  expect(missing.observations).toMatchObject([
    { outcome: "inconclusive", reason: "insufficient-evidence", evidence: "none" },
  ])
  expect(
    decodeCollectorRun("missing-geometry.json", JSON.stringify(asRun(missing)), manifest, sourceRevision).run
      .observations,
  ).toMatchObject([{ featureId: "reset.ris", outcome: "inconclusive", reason: "insufficient-evidence" }])
  expect(JSON.parse(missing.rawReplies["reset.ris"]!)).toEqual({ writes: [], queries: [], events: [] })
  expect(writes).toEqual([])
  const conflict = await runProbeBatch({
    ids: ["reset.ris"],
    ownedTerminal: geometryOwner(measured(24, 61, darwinGeometrySource), async () =>
      measured(24, 61, darwinGeometrySource),
    ),
    geometryCorroboration: {
      status: "conflict",
      rows: 25,
      cols: 61,
      query: {
        sequence: "\x1b[18t",
        outbound: "\x1b[18t\x1b[c",
        reason: "reply",
        raw: "\x1b[8;25;61t",
        rawBase64: Buffer.from("\x1b[8;25;61t").toString("base64"),
      },
    },
  })
  expect(conflict.observations).toMatchObject([
    { outcome: "inconclusive", reason: "insufficient-evidence", evidence: "none" },
  ])
  expect(writes).toEqual([])
  expect(JSON.parse(conflict.rawReplies["collector.geometry"]!)).toMatchObject({
    source: darwinGeometrySource,
    bindingReceiptRef: "collector.terminalOwnership",
    grant: { source: darwinGeometrySource },
    corroboration: {
      query: { sequence: "\x1b[18t", outbound: "\x1b[18t\x1b[c", reason: "reply" },
    },
    checks: [{ featureId: "reset.ris", diagnostic: expect.stringContaining("conflicts") }],
  })
})

it("keeps query-only and nongeometry callbacks runnable when owned size is unavailable", async () => {
  verifiedBatchFixture()
  const writes: string[] = []
  process.stdout.write = ((text: string) => {
    writes.push(text)
    if (text === "\x1b[?2004$p\x1b[c") process.stdin.emit("data", Buffer.from("\x1b[?2004;2$y"))
    if (text === "\x1b[6n") process.stdin.emit("data", Buffer.from("\x1b[1;2R"))
    return true
  }) as typeof process.stdout.write
  const batch = await runProbeBatch({
    ids: ["modes.bracketed-paste", "reset.decaln"],
    ownedTerminal: geometryOwner(noGeometry),
  })
  expect(batch.observations.find((item) => item.featureId === "modes.bracketed-paste")).toMatchObject({
    outcome: "supported",
    evidence: "query",
  })
  expect(batch.ungradedDiagnostics["reset.decaln"]).toMatchObject({ kind: "legacy-callback" })
  expect(writes).toContain("\x1b#8")
  expect(writes).toContain("\x1b[?2004$p\x1b[c")
})

it("keeps actual query evidence but downgrades its explicit result after a measured resize", async () => {
  verifiedBatchFixture()
  const definition = ALL_PROBES.find((item) => item.id === "device.primary-da")!
  const original = definition.termNeedsGeometry
  definition.termNeedsGeometry = true
  let reads = 0
  process.stdout.write = ((text: string) => {
    if (text === "\x1b[c") process.stdin.emit("data", Buffer.from("\x1b[?62;4c"))
    return true
  }) as typeof process.stdout.write
  try {
    const batch = await runProbeBatch({
      ids: ["device.primary-da"],
      ownedTerminal: geometryOwner(measured(24, 61), async () => (++reads === 1 ? measured(24, 61) : measured(31, 73))),
    })
    expect(batch.observations).toMatchObject([
      {
        featureId: "device.primary-da",
        outcome: "inconclusive",
        reason: "insufficient-evidence",
        evidence: "query",
      },
    ])
    expect(batch.assertions).toEqual([])
    expect(batch.rawReplies["device.primary-da"]).toBe("\x1b[?62;4c")
    expect(JSON.parse(batch.rawReplies["collector.geometry"]!)).toMatchObject({
      checks: [{ pre: { rows: 24, cols: 61 }, post: { rows: 31, cols: 73 } }],
    })
  } finally {
    definition.termNeedsGeometry = original
  }
})

it("reports undeclared geometry reads as collector errors without invented evidence", async () => {
  verifiedBatchFixture()
  const definition = ALL_PROBES.find((item) => item.id === "text.wrap")!
  const original = definition.termNeedsGeometry
  const originalEvidence = definition.termObservationEvidence
  definition.termNeedsGeometry = undefined
  definition.termObservationEvidence = "behavior"
  const writes: string[] = []
  process.stdout.write = ((text: string) => {
    writes.push(text)
    return true
  }) as typeof process.stdout.write
  try {
    const batch = await runProbeBatch({ ids: ["text.wrap"] })
    expect(batch.ungradedDiagnostics["text.wrap"]).toMatchObject({
      kind: "collector-error",
      name: "UndeclaredTerminalGeometry",
      message: expect.stringContaining("text.wrap"),
    })
    expect(batch.observations).toEqual([])
    expect(writes).toEqual([])
  } finally {
    definition.termNeedsGeometry = original
    definition.termObservationEvidence = originalEvidence
  }
})

// The public inline runner must put both callback writes and nested CPR queries on its selected TTY.
it("uses the injected TTY for callback writes, columns, and nested cursor queries", async () => {
  verifiedBatchFixture()
  const definition = ALL_PROBES.find((item) => item.id === "text.wrap")!
  const original = definition.termNeedsGeometry
  definition.termNeedsGeometry = true
  const writes: string[] = []
  const out = {
    columns: 12,
    write(chunk: string) {
      writes.push(chunk)
      if (chunk === "\x1b[6n") process.stdin.emit("data", Buffer.from("\x1b[2;2R"))
      return true
    },
  } as unknown as NodeJS.WriteStream
  process.stdout.write = (() => {
    throw new Error("probe traffic reached stdout")
  }) as typeof process.stdout.write

  let batch: Awaited<ReturnType<typeof runProbeBatch>>
  try {
    batch = await runProbeBatch({
      ids: ["text.wrap"],
      out,
      geometryCorroboration: {
        status: "silent",
        query: {
          sequence: "\x1b[18t",
          outbound: "\x1b[18t\x1b[c",
          reason: "sentinel",
          raw: "\x1b[?62c",
          rawBase64: Buffer.from("\x1b[?62c").toString("base64"),
        },
      },
      ownedTerminal: geometryOwner(measured(24, 12)),
    })
  } finally {
    definition.termNeedsGeometry = original
  }
  expect(writes).toEqual(["\x1b[1;1H\x1b[2K", `${"W".repeat(12)}X`, "\x1b[6n"])
  expect(batch.ungradedDiagnostics["text.wrap"]).toMatchObject({ kind: "legacy-callback", pass: true })
  expect(JSON.parse(batch.rawReplies["collector.geometry"]!)).toMatchObject({ corroboration: { status: "silent" } })
  const trace = JSON.parse(batch.rawReplies["text.wrap"]!) as { writes: string[]; queries: Array<{ sequence: string }> }
  expect(trace.writes).toEqual(writes.slice(0, 2))
  expect(trace.queries).toMatchObject([{ sequence: "\x1b[6n" }])
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
  verifiedBatchFixture()
  const writes: string[] = []
  const order: string[] = []
  process.stdout.write = ((text: string) => {
    writes.push(text)
    if (text.startsWith("\x1b]52;c;")) order.push("osc52")
    if (text === "\x1b[6n") process.stdin.emit("data", Buffer.from("\x1b[1;1R"))
    return true
  }) as typeof process.stdout.write
  const batch = await runProbeBatch({
    ids: ["extensions.osc52-write", "sgr.underline.curly"],
    capture: async ({ role, label }) => {
      order.push(`capture-${role}`)
      return { frame: { role, label, capturedAt: Date.now(), ref: `sha256:${"a".repeat(64)}` }, trace: {} }
    },
    ownedTerminal: {
      ...geometryOwner(noGeometry),
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
  verifiedBatchFixture()
  process.stdout.write = (() => true) as typeof process.stdout.write
  const batch = await runProbeBatch({
    ids: ["extensions.osc52-write"],
    ownedTerminal: {
      ...geometryOwner(noGeometry),
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
  verifiedBatchFixture()
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
  verifiedBatchFixture()
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
