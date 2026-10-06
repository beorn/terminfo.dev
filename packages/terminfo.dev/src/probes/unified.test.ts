/**
 * @failure A callback's explicit result or exact TTY reply bytes are discarded, or a failed owned restoration is graded as success.
 * @level l1
 * @consumer Real-terminal app, daemon, and inline probe batch
 * @testonly none
 * @reach fs-walk /tmp/terminfo-disposable-receipts
 */
import { createHash } from "node:crypto"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
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
    ...(batch.notTested.length ? { notTested: batch.notTested } : {}),
  }
}

// Callback-returned responses must survive without becoming measured evidence or changing legacy decoding.
it.each([
  { label: "sentinel", response: "nonsecret-callback-response" },
  { label: "empty", response: "" },
  { label: "absent", response: undefined },
])(
  "retains the $label explicit callback response and refuses an untyped legacy-shaped result",
  async ({ response }) => {
    const id = "modes.bracketed-paste"
    const definition = ALL_PROBES.find((probe) => probe.id === id)!
    expect(definition.termWrites).toBe("query")
    expect(definition.termNeedsGeometry).toBeUndefined()
    const original = definition.term
    const responseFields = response === undefined ? {} : { response }
    const note = "Deterministic callback response retention fixture"
    const observation = {
      outcome: "inconclusive" as const,
      reason: "insufficient-evidence" as const,
      evidence: "none" as const,
      note,
    }
    const trace = JSON.stringify({ writes: [], queries: [], events: [] })
    // The collector records its own disposable-ownership verdict beside the replies.
    const sharedOwnership = { "collector.disposableOwnership": JSON.stringify({ kind: "shared" }) }
    try {
      definition.term = async () => ({ pass: false, ...responseFields, observation })
      const explicit = await runProbeBatch({ ids: [id] })
      definition.term = (async () => ({ pass: false, ...responseFields, note })) as unknown as typeof definition.term
      const legacy = await runProbeBatch({ ids: [id] })
      const decodedExplicit = decodeCollectorRun(
        "explicit-callback-response.json",
        JSON.stringify(asRun(explicit)),
        manifest,
        sourceRevision,
      ).run
      const decodedLegacy = decodeCollectorRun(
        "legacy-callback-response.json",
        JSON.stringify(asRun(legacy)),
        manifest,
        sourceRevision,
      ).run
      const expectedObservation = { featureId: id, ...observation, rawReplyRef: id }
      expect(explicit.observations).toEqual([expectedObservation])
      expect(decodedExplicit.observations).toEqual([expectedObservation])
      expect(explicit.ungradedDiagnostics).toEqual({})
      expect(decodedExplicit.ungradedDiagnostics).toEqual({})
      expect(explicit.assertions).toEqual([])
      expect(decodedExplicit.assertions).toEqual([])
      expect(explicit.screenshotRefs).toEqual([])
      expect(decodedExplicit.screenshotRefs).toEqual([])
      expect(explicit.suiteComplete).toBe(false)
      expect(decodedExplicit.suiteComplete).toBe(false)
      expect(decodedExplicit.identity).toBe("unverified")
      expect(explicit.rawReplies[id]).toBe(trace)
      expect(decodedExplicit.rawReplies[id]).toBe(trace)

      // The one-path refactor deleted the legacy-callback record. A result that is neither a
      // measurement nor a coverage record is refused loudly instead of silently ungraded.
      const refusal = {
        kind: "collector-error",
        name: "Error",
        message: `Callback for ${id} returned neither an observation nor a not-tested coverage record; its conclusion cannot be graded`,
      }
      expect(legacy.observations).toEqual([])
      expect(decodedLegacy.observations).toEqual([])
      expect(legacy.ungradedDiagnostics).toEqual({ [id]: refusal })
      expect(decodedLegacy.ungradedDiagnostics).toEqual({ [id]: refusal })
      expect(legacy.rawReplies).toEqual({ [id]: trace, ...sharedOwnership })
      expect(decodedLegacy.rawReplies).toEqual({ [id]: trace, ...sharedOwnership })
      expect(legacy.assertions).toEqual([])
      expect(decodedLegacy.assertions).toEqual([])
      expect(legacy.screenshotRefs).toEqual([])
      expect(decodedLegacy.screenshotRefs).toEqual([])
      expect(legacy.suiteComplete).toBe(false)
      expect(decodedLegacy.suiteComplete).toBe(false)
      expect(decodedLegacy.identity).toBe("unverified")

      const expectedReplies = {
        [id]: trace,
        ...sharedOwnership,
        ...(response === undefined ? {} : { [`${id}.callbackResponse`]: response }),
      }
      expect(explicit.rawReplies).toEqual(expectedReplies)
      expect(decodedExplicit.rawReplies).toEqual(expectedReplies)
    } finally {
      definition.term = original
    }
  },
)

// A result-level note beside an explicit observation must reach the run document, and an
// observation's own note is never replaced by it; the legacy control keeps the result note.
it.each([
  {
    label: "result-note-beside-observation",
    resultNote: "Deterministic result-level note retention fixture",
    observationNote: undefined,
  },
  {
    label: "observation-own-note",
    resultNote: undefined,
    observationNote: "Deterministic observation-level note fixture",
  },
  {
    label: "both-notes",
    resultNote: "Deterministic legacy label",
    observationNote: "Deterministic observation-level note fixture",
  },
])(
  "retains the ProbeResult note for the $label case and refuses an untyped legacy-shaped result",
  async ({ resultNote, observationNote }) => {
    const id = "modes.bracketed-paste"
    const definition = ALL_PROBES.find((probe) => probe.id === id)!
    expect(definition.termWrites).toBe("query")
    expect(definition.termNeedsGeometry).toBeUndefined()
    const original = definition.term
    const resultNoteFields = resultNote === undefined ? {} : { note: resultNote }
    const observation = {
      outcome: "inconclusive" as const,
      reason: "insufficient-evidence" as const,
      evidence: "none" as const,
      ...(observationNote === undefined ? {} : { note: observationNote }),
    }
    const expectedNote = observationNote ?? resultNote
    const trace = JSON.stringify({ writes: [], queries: [], events: [] })
    // The collector records its own disposable-ownership verdict beside the replies.
    const sharedOwnership = { "collector.disposableOwnership": JSON.stringify({ kind: "shared" }) }
    try {
      definition.term = async () => ({ pass: false, ...resultNoteFields, observation })
      const explicit = await runProbeBatch({ ids: [id] })
      definition.term = (async () => ({ pass: false, ...resultNoteFields })) as unknown as typeof definition.term
      const legacy = await runProbeBatch({ ids: [id] })
      const decodedExplicit = decodeCollectorRun(
        "explicit-callback-note.json",
        JSON.stringify(asRun(explicit)),
        manifest,
        sourceRevision,
      ).run
      const decodedLegacy = decodeCollectorRun(
        "legacy-callback-note.json",
        JSON.stringify(asRun(legacy)),
        manifest,
        sourceRevision,
      ).run
      const expectedObservation = { featureId: id, ...observation, note: expectedNote, rawReplyRef: id }
      expect(explicit.observations).toEqual([expectedObservation])
      expect(decodedExplicit.observations).toEqual([expectedObservation])
      expect(explicit.ungradedDiagnostics).toEqual({})
      expect(decodedExplicit.ungradedDiagnostics).toEqual({})
      expect(explicit.assertions).toEqual([])
      expect(decodedExplicit.assertions).toEqual([])
      expect(explicit.rawReplies).toEqual({ [id]: trace, ...sharedOwnership })
      expect(decodedExplicit.rawReplies).toEqual({ [id]: trace, ...sharedOwnership })
      expect(explicit.suiteComplete).toBe(false)
      expect(decodedExplicit.suiteComplete).toBe(false)
      expect(decodedExplicit.identity).toBe("unverified")

      // The one-path refactor deleted the legacy-callback record; the untyped refusal replaces it.
      const refusal = {
        kind: "collector-error",
        name: "Error",
        message: `Callback for ${id} returned neither an observation nor a not-tested coverage record; its conclusion cannot be graded`,
      }
      expect(legacy.observations).toEqual([])
      expect(decodedLegacy.observations).toEqual([])
      expect(legacy.ungradedDiagnostics).toEqual({ [id]: refusal })
      expect(decodedLegacy.ungradedDiagnostics).toEqual({ [id]: refusal })
      expect(legacy.rawReplies).toEqual({ [id]: trace, ...sharedOwnership })
      expect(decodedLegacy.rawReplies).toEqual({ [id]: trace, ...sharedOwnership })
      expect(legacy.assertions).toEqual([])
      expect(decodedLegacy.assertions).toEqual([])
      expect(decodedLegacy.suiteComplete).toBe(false)
      expect(decodedLegacy.identity).toBe("unverified")
    } finally {
      definition.term = original
    }
  },
)

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
// F1 (27832): that sentinel answered alone through the grace window is now a measured negative, not an
// unknown — the terminal was alive and did not answer the query.
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
    {
      featureId: "device.xtversion",
      outcome: "unsupported",
      evidence: "query",
      note: "negative by sentinel",
    },
  ])
  expect(batch.assertions).toContainEqual({
    featureId: "device.xtversion",
    kind: "negative",
    expected: "complete XTVERSION DCS >| printable name/version ST",
    observed: expect.stringMatching(/DA1 answered at \+\d+ms; no reply through the \d+ ms window/),
    rawReplyRef: "device.xtversion",
  })
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
  for (const path of receiptDirectories.splice(0)) rmSync(path, { recursive: true, force: true })
  if (originalDisposableReceipt === undefined) delete process.env.TERMINFO_DISPOSABLE_RECEIPT
  else process.env.TERMINFO_DISPOSABLE_RECEIPT = originalDisposableReceipt
})

// These callback/capture contract tests exercise the post-authorization batch path;
// unmocked tests above independently prove a forged adapter cannot authorize it.
function verifiedBatchFixture() {
  vi.spyOn(terminalOwnership, "ownedTerminalVerifiedFor").mockReturnValue(true)
}

const receiptDirectories: string[] = []
const originalDisposableReceipt = process.env.TERMINFO_DISPOSABLE_RECEIPT

/** The host-authored half the collector can read: /out/host-measured.json plus the envelope. */
function validContainerReceipt() {
  return {
    schemaVersion: 1,
    kind: "linux-xvfb-container",
    runId: "b".repeat(32),
    collectedAt: "2026-10-06T22:00:00Z",
    runtime: {
      imageId: "sha256:" + "a".repeat(64),
      imageTarSha256: "a".repeat(64),
      arch: "x86_64",
      nixLockRevision: "c".repeat(40),
      sourceRevision: "d".repeat(40),
      sourceTreeStatus: "clean",
      rootRevision: "e".repeat(40),
      suiteHash: "f".repeat(12),
    },
    runnerArtifact: { frozenRunnerSha256: "1".repeat(64), buildReceiptSha256: "2".repeat(64) },
    declaredTarget: { kind: "app", id: "kitty", version: "0.49.2", os: "linux" },
    preset: "current",
    clipboardProfile: "default",
  }
}

// 27832 amendment 1: a mutating probe needs a verified disposable-ownership receipt, the collector
// checks it once before the first write, and the run records the kind and the digest.
it("refuses a mutating reset probe with no disposable receipt and writes nothing", async () => {
  verifiedBatchFixture()
  const writes: string[] = []
  process.stdout.write = ((text: string) => {
    writes.push(text)
    return true
  }) as typeof process.stdout.write
  const batch = await runProbeBatch({ ids: ["extensions.osc110-reset-fg"] })
  expect(writes).toEqual([])
  expect(JSON.parse(batch.rawReplies["collector.disposableOwnership"]!)).toEqual({ kind: "shared" })
  expect(batch.observations).toMatchObject([
    {
      featureId: "extensions.osc110-reset-fg",
      outcome: "inconclusive",
      reason: "policy-refused",
      evidence: "none",
      note: "Collector refused before sending bytes because no verified disposable-ownership receipt was presented",
    },
  ])
  expect(batch.assertions).toEqual([])
  expect(JSON.parse(batch.rawReplies["extensions.osc110-reset-fg"]!)).toEqual({ writes: [], queries: [], events: [] })
})

it("a declared receipt that cannot be verified is loud before any byte, never a silent shared default", async () => {
  verifiedBatchFixture()
  const directory = mkdtempSync(join(tmpdir(), "terminfo-disposable-receipts-"))
  receiptDirectories.push(directory)
  const path = join(directory, "host-measured.json")
  writeFileSync(path, JSON.stringify({ ...validContainerReceipt(), kind: "a-person-s-laptop" }))
  process.env.TERMINFO_DISPOSABLE_RECEIPT = path
  const writes: string[] = []
  process.stdout.write = ((text: string) => {
    writes.push(text)
    return true
  }) as typeof process.stdout.write
  await expect(runProbeBatch({ ids: ["extensions.osc110-reset-fg"] })).rejects.toThrow(/unknown kind/)
  expect(writes).toEqual([])
})

it("a verified disposable receipt runs the reset exchange and records its kind and digest", async () => {
  verifiedBatchFixture()
  const directory = mkdtempSync(join(tmpdir(), "terminfo-disposable-receipts-"))
  receiptDirectories.push(directory)
  const bytes = JSON.stringify(validContainerReceipt())
  const path = join(directory, "host-measured.json")
  writeFileSync(path, bytes)
  process.env.TERMINFO_DISPOSABLE_RECEIPT = path
  const replies = ["\x1b]10;rgb:0000/0000/0000\x07", "\x1b]10;rgb:aa/bb/cc\x07", "\x1b]10;rgb:0000/0000/0000\x07"]
  let read = 0
  const writes: string[] = []
  process.stdout.write = ((text: string) => {
    writes.push(text)
    if (text === "\x1b]10;?\x07\x1b[c") process.stdin.emit("data", Buffer.from(replies[read++] ?? ""))
    return true
  }) as typeof process.stdout.write
  const batch = await runProbeBatch({ ids: ["extensions.osc110-reset-fg"] })
  expect(batch.observations).toMatchObject([
    { featureId: "extensions.osc110-reset-fg", outcome: "supported", evidence: "behavior" },
  ])
  expect(writes).toEqual([
    "\x1b]10;?\x07\x1b[c",
    "\x1b]10;rgb:aa/bb/cc\x07",
    "\x1b]10;?\x07\x1b[c",
    "\x1b]110\x07",
    "\x1b]10;?\x07\x1b[c",
  ])
  const recorded = JSON.parse(batch.rawReplies["collector.disposableOwnership"]!) as {
    kind: string
    runId: string
    receiptSha256: string
  }
  expect(recorded).toMatchObject({ kind: "linux-xvfb-container", runId: "b".repeat(32) })
  expect(recorded.receiptSha256).toBe(createHash("sha256").update(bytes).digest("hex"))
})

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
  expect(batch.observations.find((item) => item.featureId === "reset.decaln")).toMatchObject({
    outcome: "inconclusive",
    reason: "insufficient-evidence",
    evidence: "none",
  })
  expect(batch.ungradedDiagnostics["reset.decaln"]).toBeUndefined()
  expect(writes).not.toContain("\x1b#8")
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

// A dormant boundary the audit family exposed: an app coverage claim must be bound to a NONEMPTY raw
// trace, and the shared parser must accept the record rather than reject the whole run.
it("binds an app named coverage record to its own retained raw trace", async () => {
  verifiedBatchFixture()
  const definition = ALL_PROBES.find((item) => item.id === "device.primary-da")!
  const originalTerm = definition.term
  definition.term = async () => ({
    pass: false,
    response: "\x1b[?62;4c",
    notTested: { reason: "no-semantic-observable", noObservable: "device attributes" },
  })
  try {
    const batch = await runProbeBatch({ ids: [definition.id] })
    expect(batch.notTested).toEqual([
      {
        featureId: definition.id,
        reason: "no-semantic-observable",
        noObservable: "device attributes",
        rawReplyRef: definition.id,
      },
    ])
    expect(batch.rawReplies[`${definition.id}.callbackResponse`]).toBe("\x1b[?62;4c")
    expect(JSON.parse(batch.rawReplies[definition.id]!)).toEqual({ writes: [], queries: [], events: [] })
    const decoded = decodeCollectorRun(
      "app-named-coverage.json",
      JSON.stringify(asRun(batch)),
      manifest,
      sourceRevision,
    ).run
    expect(decoded.notTested).toMatchObject([
      { featureId: definition.id, reason: "no-semantic-observable", rawReplyRef: definition.id },
    ])
  } finally {
    definition.term = originalTerm
  }
})

// A mixed app result - named coverage beside its own returned failure - is a loud collector error,
// never coverage, and it cannot complete the suite.
it("refuses app named coverage that arrives beside its returned error observation", async () => {
  verifiedBatchFixture()
  const definition = ALL_PROBES.find((item) => item.id === "device.primary-da")!
  const originalTerm = definition.term
  const originalEvidence = definition.termObservationEvidence
  definition.termObservationEvidence = "query"
  definition.term = (async () => ({
    pass: false,
    response: "\x1b[?62;4c",
    notTested: { reason: "no-semantic-observable", noObservable: "device attributes" },
    observation: { outcome: "error", reason: "collector-error", evidence: "query", note: "TTY write failed" },
  })) as unknown as typeof definition.term
  try {
    const batch = await runProbeBatch({ ids: [definition.id] })
    expect(batch.notTested).toEqual([])
    expect(batch.observations.filter((item) => item.featureId === definition.id)).toEqual([])
    expect(batch.ungradedDiagnostics[definition.id]).toMatchObject({
      kind: "collector-error",
      name: "Error",
      message: expect.stringContaining("beside observation(outcome=error, reason=collector-error"),
    })
    expect(batch.rawReplies[`${definition.id}.callbackResponse`]).toBe("\x1b[?62;4c")
    const diagnostic = JSON.stringify(batch.ungradedDiagnostics[definition.id] ?? null)
    expect(diagnostic).toContain("TTY write failed")
    const decoded = decodeCollectorRun(
      "app-mixed-coverage.json",
      JSON.stringify(asRun(batch)),
      manifest,
      sourceRevision,
    ).run
    expect(JSON.stringify(decoded.ungradedDiagnostics?.[definition.id] ?? null)).toContain("TTY write failed")
    expect(batch.suiteComplete).toBe(false)
  } finally {
    definition.term = originalTerm
    definition.termObservationEvidence = originalEvidence
  }
})

it("refuses app named coverage that arrives beside supported observation and assertions", async () => {
  verifiedBatchFixture()
  const definition = ALL_PROBES.find((item) => item.id === "device.primary-da")!
  const originalTerm = definition.term
  definition.term = (async () => ({
    pass: true,
    response: "\x1b[?62;4c",
    notTested: { reason: "no-semantic-observable", noObservable: "device attributes" },
    observation: { outcome: "supported", evidence: "query" },
    assertions: [{ kind: "positive", expected: "\x1b[?62;4c", observed: "\x1b[?62;4c" }],
  })) as unknown as typeof definition.term
  try {
    const batch = await runProbeBatch({ ids: [definition.id] })
    expect(batch.notTested).toEqual([])
    expect(batch.assertions).toEqual([])
    expect(batch.observations.filter((item) => item.featureId === definition.id)).toEqual([])
    expect(batch.ungradedDiagnostics[definition.id]).toMatchObject({
      kind: "collector-error",
      message: expect.stringContaining("assertion(kind=positive"),
    })
    expect(batch.rawReplies[`${definition.id}.callbackResponse`]).toBe("\x1b[?62;4c")
    const diagnostic = JSON.stringify(batch.ungradedDiagnostics[definition.id] ?? null)
    expect(diagnostic).toContain("expected=")
    expect(diagnostic).toContain("observed=")
    const decoded = decodeCollectorRun(
      "app-mixed-assertions.json",
      JSON.stringify(asRun(batch)),
      manifest,
      sourceRevision,
    ).run
    expect(JSON.stringify(decoded.ungradedDiagnostics?.[definition.id] ?? null)).toContain("assertion(kind=positive")
    expect(batch.suiteComplete).toBe(false)
  } finally {
    definition.term = originalTerm
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
  const cursorReplies = ["\x1b[1;1R", "\x1b[1;12R", "\x1b[2;2R"]
  const out = {
    columns: 12,
    write(chunk: string) {
      writes.push(chunk)
      if (chunk === "\x1b[?7$p\x1b[c") process.stdin.emit("data", Buffer.from("\x1b[?7;1$y\x1b[?62c"))
      if (chunk === "\x1b[6n") {
        const reply = cursorReplies.shift()
        if (reply) process.stdin.emit("data", Buffer.from(reply))
      }
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
  expect(writes).toEqual([
    "\x1b[?7$p\x1b[c",
    "\x1b[1;1H",
    "\x1b[6n",
    "\x1b[1;1H\x1b[2K",
    "W".repeat(11),
    "\x1b[6n",
    "\x1b[1;1H\x1b[2K",
    `${"W".repeat(12)}X`,
    "\x1b[6n",
  ])
  expect(batch.observations.find((item) => item.featureId === "text.wrap")).toMatchObject({
    outcome: "supported",
    evidence: "query",
  })
  expect(batch.ungradedDiagnostics["text.wrap"]).toBeUndefined()
  expect(JSON.parse(batch.rawReplies["collector.geometry"]!)).toMatchObject({ corroboration: { status: "silent" } })
  const trace = JSON.parse(batch.rawReplies["text.wrap"]!) as { writes: string[]; queries: Array<{ sequence: string }> }
  expect(trace.writes).toEqual([
    "\x1b[1;1H",
    "\x1b[1;1H\x1b[2K",
    "W".repeat(11),
    "\x1b[1;1H\x1b[2K",
    `${"W".repeat(12)}X`,
  ])
  expect(trace.queries).toMatchObject([
    { sequence: "\x1b[?7$p\x1b[c" },
    { sequence: "\x1b[6n" },
    { sequence: "\x1b[6n" },
    { sequence: "\x1b[6n" },
  ])
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

it("does not use a headless-only marker to grade an app callback exception", async () => {
  const definition = ALL_PROBES.find((item) => item.id === "device.primary-da")!
  const originalApp = definition.termObservationEvidence
  const originalHeadless = definition.termlessObservationEvidence
  definition.termObservationEvidence = undefined
  definition.termlessObservationEvidence = "parser-state"
  process.stdout.write = (() => {
    throw new Error("App TTY write failed")
  }) as typeof process.stdout.write
  try {
    const batch = await runProbeBatch({ ids: [definition.id] })
    expect(batch.observations).toEqual([])
    expect(batch.assertions).toEqual([])
    expect(batch.ungradedDiagnostics).toEqual({
      [definition.id]: { kind: "collector-error", name: "Error", message: "App TTY write failed" },
    })
  } finally {
    definition.termObservationEvidence = originalApp
    definition.termlessObservationEvidence = originalHeadless
  }
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
      ...geometryOwner(measured(24, 80)),
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
    ownedTerminal: geometryOwner(measured(24, 80)),
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
  expect(JSON.parse(batch.rawReplies["collector.geometry"]!)).toMatchObject({
    checks: [{ featureId: "sgr.underline.curly", pre: { rows: 24, cols: 80 }, post: { rows: 24, cols: 80 } }],
  })
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
    ownedTerminal: geometryOwner(measured(24, 80)),
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
