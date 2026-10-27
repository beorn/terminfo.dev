/**
 * @failure A callback's explicit result or exact TTY reply bytes are discarded, or a failed owned restoration is graded as success.
 * @level l1
 * @consumer Real-terminal app, daemon, and inline probe batch
 * @testonly none
 * @reach fs-walk <fixture-only: /tmp/terminfo-disposable-receipts>
 */
import { createHash } from "node:crypto"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it, vi } from "vitest"
import { ALL_PROBES, type ProbeSuiteManifest, type TextQualification } from "@terminfo/probe-defs"
import { decodeHistoricalCollectorRun as decodeCollectorRun } from "@terminfo/run-parser"
import * as terminalOwnership from "../owned-terminal.ts"
import { verifyTerminalIdentity } from "../identity-guard.ts"
import { measureUtf8Decoding } from "../tty.ts"
import { captureAdapterEligible, runProbeBatch } from "./unified.ts"
import { calibrateCaptureOrigin } from "../capture-calibration.ts"
import { collectTextQualification } from "../text-qualification.ts"

// Most cases stub only decode-context measurement; its evidence owner below exercises the real
// round trip. Every other tty export stays real, so the batch path under test is unchanged.
vi.mock("../tty.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../tty.ts")>()
  return { ...actual, measureUtf8Decoding: vi.fn(actual.measureUtf8Decoding) }
})

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
// A callback that never returns must still have an actual attempt in the retained checkpoint.
it("checkpoints the native attempt before invoking its callback", async () => {
  const probe = ALL_PROBES.find((entry) => entry.id === "modes.bracketed-paste")!
  const original = probe.term
  let active: unknown
  let seen: unknown
  try {
    probe.term = async () => {
      seen = active
      return {
        pass: false,
        tests: [{ id: "criterion", status: "test-todo", reason: "Fixture callback completed" }],
      }
    }
    await runProbeBatch({
      ids: [probe.id],
      onCheckpoint: (batch) => {
        active = structuredClone(batch.results.find((result) => result.featureId === probe.id))
      },
    })
  } finally {
    probe.term = original
  }
  expect(seen).toMatchObject({
    featureId: probe.id,
    status: "test-todo",
    attempt: { scope: "probe", startedAt: expect.any(String) },
  })
})
const sourceRevision = "e".repeat(40)
const manifest: ProbeSuiteManifest = {
  schemaVersion: 4 as const,
  probeHash,
  sourceRevision,
  generatedAt: "2026-09-28T00:00:00.000Z",
  adapterVersion: "test",
  probes: { term: ALL_PROBES.filter((probe) => probe.term).map((probe) => probe.id), lib: [], mux: [] },
}
// Versioned fixture only: exercise the strict schema-2 decoder; never a production writer.
function asRun(batch: Awaited<ReturnType<typeof runProbeBatch>>) {
  const observations = batch.observations.map(({ assertionType, ...observation }) => ({
    ...observation,
    evidence:
      assertionType === "buffer_state"
        ? observation.frames?.some((frame) => frame.kind === "text-cells")
          ? "text"
          : "parser-state"
        : ({ query_reply: "query", screenshot: "pixels", input_bytes: "interaction", clipboard: "behavior" } as const)[
            assertionType
          ],
  }))
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
    assertions: batch.assertions.map(({ assertionType: _type, ...assertion }) => assertion),
    screenshotRefs: [],
    observations,
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
    const trace = JSON.stringify({ writes: [], queries: [], events: [] })
    // The collector records its own disposable-ownership verdict beside the replies.
    const sharedOwnership = { "collector.disposableOwnership": JSON.stringify({ kind: "shared" }) }
    try {
      definition.term = async () => ({
        pass: false,
        ...responseFields,
        tests: [{ id: "criterion", status: "test-todo", reason: note }],
      })
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
      expect(explicit.observations).toEqual([])
      expect(decodedExplicit.observations).toEqual([])
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
  "retains the ProbeCallbackResult note for the $label case and refuses an untyped legacy-shaped result",
  async ({ resultNote, observationNote }) => {
    const id = "modes.bracketed-paste"
    const definition = ALL_PROBES.find((probe) => probe.id === id)!
    expect(definition.termWrites).toBe("query")
    expect(definition.termNeedsGeometry).toBeUndefined()
    const original = definition.term
    const resultNoteFields = resultNote === undefined ? {} : { note: resultNote }
    const expectedNote = observationNote ?? resultNote
    const trace = JSON.stringify({ writes: [], queries: [], events: [] })
    // The collector records its own disposable-ownership verdict beside the replies.
    const sharedOwnership = { "collector.disposableOwnership": JSON.stringify({ kind: "shared" }) }
    try {
      definition.term = async () => ({
        pass: false,
        ...resultNoteFields,
        tests: [{ id: "criterion", status: "test-todo", reason: expectedNote! }],
      })
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
      expect(explicit.observations).toEqual([])
      expect(decodedExplicit.observations).toEqual([])
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
  expect(batch.observations).toEqual([])
  expect(batch.results.find((result) => result.featureId === "reset.ris")).toMatchObject({
    status: "test-todo",
    attempt: { scope: "none" },
  })
  expect(JSON.parse(batch.rawReplies["reset.ris"]!)).toEqual({ writes: [], queries: [], events: [] })
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
  expect(batch.results.filter((result) => ["extensions.osc52-write"].includes(result.featureId))).toMatchObject([
    { status: "test-todo", featureId: "extensions.osc52-write", rawReplyRef: "extensions.osc52-write" },
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
  expect(batch.results.filter((result) => ["reset.ris"].includes(result.featureId))).toMatchObject([
    { status: "test-todo", featureId: "reset.ris" },
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
    assertionType: "query_reply",
  })
  expect(batch.observations.find((item) => item.featureId === "modes.color-scheme-reporting")).toMatchObject({
    outcome: "supported",
    assertionType: "query_reply",
  })
  for (const id of ["cursor.move.absolute", "device.xtwinops-20"]) {
    expect(batch.results.find((item) => item.featureId === id)).toMatchObject({ status: "test-todo" })
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
      assertionType: "query_reply",
      note: "negative by sentinel",
    },
  ])
  expect(batch.assertions).toContainEqual({
    featureId: "device.xtversion",
    kind: "negative",
    assertionType: "query_reply",
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
function hostedLaunchReceipt() {
  const sample = (seed: string) => ({
    machineIdSha256: createHash("sha256").update(`${seed}-machine`).digest("hex"),
    productUuidSha256: createHash("sha256").update(`${seed}-uuid`).digest("hex"),
    bootIdSha256: createHash("sha256").update(`${seed}-boot`).digest("hex"),
  })
  return {
    schemaVersion: 1,
    kind: "github-hosted-runner",
    runId: "c".repeat(32),
    collectedAt: "2026-10-08T22:00:00Z",
    job: {
      repository: "beorn/terminfo.dev",
      workflow: "macos-measurement.yml",
      workflowRef: "beorn/terminfo.dev/.github/workflows/macos-measurement.yml@refs/heads/main",
      githubRunId: "1",
      githubRunAttempt: "1",
      job: "measure",
      jobId: "2",
    },
    runner: {
      environment: "github-hosted",
      name: "GitHub Actions 1",
      os: "macOS",
      arch: "ARM64",
      imageOS: "macos26",
      imageVersion: "20261001.1",
      trackingId: "a".repeat(32),
    },
    vm: { identityAtJobStart: sample("job"), identityAtCollection: sample("job") },
    appLaunch: {
      bundlePath: "/Applications/iTerm.app",
      cfBundleShortVersionString: "3.6.11",
      cfBundleVersion: "3.6.11",
      executablePath: "/Applications/iTerm.app/Contents/MacOS/iTerm2",
      executableSha256: createHash("sha256").update("fixture-iterm2-executable").digest("hex"),
      sourceArtifact: {
        path: "/Library/Caches/Homebrew/downloads/iterm2--3.6.11.zip",
        sha256: createHash("sha256").update("fixture-iterm2-installer").digest("hex"),
      },
    },
  }
}

function validContainerReceipt() {
  return {
    schemaVersion: 1,
    kind: "linux-xvfb-container",
    runId: "b".repeat(32),
    collectedAt: "2026-10-06T22:00:00Z",
    runtime: {
      imageId: "sha256:3f263739c9bebf6e015166eb0aa9c62dd37baf47384391d87875158eeae0bc8d",
      imageTarSha256: "22ab7b15460795eb0c774b68f0d8c5f853d87597bacbffdd809e0fcac9130333",
      arch: "amd64",
      nixLockRevision: "f2e16882cd75b5180bf14f77740fcb8643b35c10",
      sourceRevision: "d".repeat(40),
      sourceTreeStatus: "clean",
      rootRevision: "e".repeat(40),
      suiteHash: "f".repeat(12),
    },
    runnerArtifact: {
      frozenRunnerSha256: "d0a6b28177cce4be5dc241fe53adc636cbfba8a60e9362b38e5ccf3c5074d4c6",
      buildReceiptSha256: "63648108c641030f0d0cc0ee7ba92d27cb4627dc1da5ba953f0bd632f4de2044",
    },
    declaredTarget: { kind: "app", id: "kitty", version: "0.49.2", os: "linux" },
    preset: "current",
    clipboardProfile: "default",
  }
}

// 27832 amendment 1: a mutating probe needs a verified disposable-ownership receipt, the collector
// tests it once before the first write, and the run records the kind and the digest.
it("refuses a mutating reset probe with no disposable receipt and writes nothing", async () => {
  verifiedBatchFixture()
  const writes: string[] = []
  process.stdout.write = ((text: string) => {
    writes.push(text)
    return true
  }) as typeof process.stdout.write
  const batch = await runProbeBatch({
    ids: ["extensions.osc110-reset-fg"],
    subject: { kind: "term", id: "kitty", os: "linux" },
  })
  expect(writes).toEqual([])
  expect(JSON.parse(batch.rawReplies["collector.disposableOwnership"]!)).toEqual({ kind: "shared" })
  expect(batch.results.filter((result) => ["extensions.osc110-reset-fg"].includes(result.featureId))).toMatchObject([
    { status: "test-todo", featureId: "extensions.osc110-reset-fg" },
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
  await expect(
    runProbeBatch({ ids: ["extensions.osc110-reset-fg"], subject: { kind: "term", id: "kitty", os: "linux" } }),
  ).rejects.toThrow(/unknown kind/)
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
  const replies = [
    "\x1b]10;rgb:0000/0000/0000\x07\x1b[?62;c",
    "\x1b]10;rgb:aa/bb/cc\x07\x1b[?62;c",
    "\x1b]10;rgb:0000/0000/0000\x07\x1b[?62;c",
  ]
  let read = 0
  const writes: string[] = []
  process.stdout.write = ((text: string) => {
    writes.push(text)
    if (text === "\x1b]10;?\x07\x1b[c") process.stdin.emit("data", Buffer.from(replies[read++] ?? ""))
    return true
  }) as typeof process.stdout.write
  const batch = await runProbeBatch({
    ids: ["extensions.osc110-reset-fg"],
    subject: { kind: "term", id: "kitty", os: "linux" },
  })
  expect(batch.observations).toMatchObject([
    { featureId: "extensions.osc110-reset-fg", outcome: "supported", assertionType: "query_reply" },
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
    declaredTarget: { kind: string; id: string; os: string }
    identity: Record<string, string>
  }
  expect(recorded).toMatchObject({ kind: "linux-xvfb-container", runId: "b".repeat(32) })
  expect(recorded.receiptSha256).toBe(createHash("sha256").update(bytes).digest("hex"))
  // 27874 part 3: the identity the receipt names is recorded with the run, not only a digest of
  // bytes a reader on main cannot open.
  expect(recorded.declaredTarget).toEqual({ kind: "app", id: "kitty", os: "linux" })
  expect(recorded.identity).toEqual({
    imageId: "sha256:3f263739c9bebf6e015166eb0aa9c62dd37baf47384391d87875158eeae0bc8d",
    imageTarSha256: "22ab7b15460795eb0c774b68f0d8c5f853d87597bacbffdd809e0fcac9130333",
    arch: "amd64",
    nixLockRevision: "f2e16882cd75b5180bf14f77740fcb8643b35c10",
    frozenRunnerSha256: "d0a6b28177cce4be5dc241fe53adc636cbfba8a60e9362b38e5ccf3c5074d4c6",
    buildReceiptSha256: "63648108c641030f0d0cc0ee7ba92d27cb4627dc1da5ba953f0bd632f4de2044",
  })
})

// 28216: the apparatus measures the launch receipt and the collector only CARRIES it, so the block
// reaches origin.appLaunch with nothing rebuilt, added or edited on the measured side.
it("copies the apparatus-measured launch block the receipt carries onto the batch", async () => {
  const directory = mkdtempSync(join(tmpdir(), "terminfo-disposable-receipts-"))
  receiptDirectories.push(directory)
  const receipt = hostedLaunchReceipt()
  const path = join(directory, "host-measured.json")
  writeFileSync(path, JSON.stringify(receipt))
  process.env.TERMINFO_DISPOSABLE_RECEIPT = path
  process.stdout.write = (() => true) as typeof process.stdout.write
  const batch = await runProbeBatch({ ids: [], subject: { kind: "term", id: "iterm2", os: "macos" } })
  expect(batch.appLaunch).toEqual(receipt.appLaunch)
})

it("refuses a mutating probe when neither owned terminal nor disposable receipt is presented", async () => {
  const writes: string[] = []
  process.stdout.write = ((text: string) => {
    writes.push(text)
    return true
  }) as typeof process.stdout.write
  const batch = await runProbeBatch({
    ids: ["extensions.osc110-reset-fg"],
    subject: { kind: "term", id: "kitty", os: "linux" },
  })
  expect(writes).toEqual([])
  expect(JSON.parse(batch.rawReplies["collector.disposableOwnership"]!)).toEqual({ kind: "shared" })
  expect(batch.results.filter((result) => ["extensions.osc110-reset-fg"].includes(result.featureId))).toMatchObject([
    { status: "test-todo", featureId: "extensions.osc110-reset-fg" },
  ])
  expect(batch.assertions).toEqual([])
})

it("authorizes write probes and records receipt kind and digest when disposable-only receipt is presented", async () => {
  const directory = mkdtempSync(join(tmpdir(), "terminfo-disposable-receipts-"))
  receiptDirectories.push(directory)
  const bytes = JSON.stringify(validContainerReceipt())
  const path = join(directory, "host-measured.json")
  writeFileSync(path, bytes)
  process.env.TERMINFO_DISPOSABLE_RECEIPT = path
  const replies = [
    "\x1b]10;rgb:0000/0000/0000\x07\x1b[?62;c",
    "\x1b]10;rgb:aa/bb/cc\x07\x1b[?62;c",
    "\x1b]10;rgb:0000/0000/0000\x07\x1b[?62;c",
  ]
  let read = 0
  const writes: string[] = []
  process.stdout.write = ((text: string) => {
    writes.push(text)
    if (text === "\x1b]10;?\x07\x1b[c") process.stdin.emit("data", Buffer.from(replies[read++] ?? ""))
    return true
  }) as typeof process.stdout.write
  const batch = await runProbeBatch({
    ids: ["extensions.osc110-reset-fg"],
    subject: { kind: "term", id: "kitty", os: "linux" },
  })
  expect(batch.observations).toMatchObject([
    { featureId: "extensions.osc110-reset-fg", outcome: "supported", assertionType: "query_reply" },
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
    declaredTarget: { kind: string; id: string; os: string }
    identity: Record<string, string>
  }
  expect(recorded).toMatchObject({ kind: "linux-xvfb-container", runId: "b".repeat(32) })
  expect(recorded.receiptSha256).toBe(createHash("sha256").update(bytes).digest("hex"))
  // 27874 part 3: the identity the receipt names is recorded with the run, not only a digest of
  // bytes a reader on main cannot open.
  expect(recorded.declaredTarget).toEqual({ kind: "app", id: "kitty", os: "linux" })
  expect(recorded.identity).toEqual({
    imageId: "sha256:3f263739c9bebf6e015166eb0aa9c62dd37baf47384391d87875158eeae0bc8d",
    imageTarSha256: "22ab7b15460795eb0c774b68f0d8c5f853d87597bacbffdd809e0fcac9130333",
    arch: "amd64",
    nixLockRevision: "f2e16882cd75b5180bf14f77740fcb8643b35c10",
    frozenRunnerSha256: "d0a6b28177cce4be5dc241fe53adc636cbfba8a60e9362b38e5ccf3c5074d4c6",
    buildReceiptSha256: "63648108c641030f0d0cc0ee7ba92d27cb4627dc1da5ba953f0bd632f4de2044",
  })
})

it("gives the named geometry error for a geometry probe on disposable-only terminal", async () => {
  const directory = mkdtempSync(join(tmpdir(), "terminfo-disposable-receipts-"))
  receiptDirectories.push(directory)
  const bytes = JSON.stringify(validContainerReceipt())
  const path = join(directory, "host-measured.json")
  writeFileSync(path, bytes)
  process.env.TERMINFO_DISPOSABLE_RECEIPT = path

  const writes: string[] = []
  process.stdout.write = ((text: string) => {
    writes.push(text)
    return true
  }) as typeof process.stdout.write
  const batch = await runProbeBatch({ ids: ["cursor.shape"], subject: { kind: "term", id: "kitty", os: "linux" } })
  expect(writes).toEqual([])
  expect(batch.results.filter((result) => ["cursor.shape"].includes(result.featureId))).toMatchObject([
    { status: "test-todo", featureId: "cursor.shape", reason: "No verified owned terminal for geometry read" },
  ])
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
  expect(missing.results.find((result) => result.featureId === "reset.ris")).toMatchObject({ status: "test-todo" })
  expect(
    decodeCollectorRun("missing-geometry.json", JSON.stringify(asRun(missing)), manifest, sourceRevision).run
      .observations,
  ).toEqual([])
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
  expect(conflict.results.find((result) => result.featureId === "reset.ris")).toMatchObject({ status: "test-failure" })
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

it("prepares capture once before the first eligible callback and retains its calibration trace", async () => {
  verifiedBatchFixture()
  const ids = ["reset.ris", "reset.decaln"]
  const definitions = ids.map((id) => ALL_PROBES.find((item) => item.id === id)!)
  const originals = definitions.map(({ term, termNeedsGeometry, termWrites }) => ({
    term,
    termNeedsGeometry,
    termWrites,
  }))
  const order: string[] = []
  const writes: string[] = []
  let prepared = false
  const captureRef = `sha256:${"a".repeat(64)}`
  process.stdout.write = ((text: string) => {
    writes.push(text)
    return true
  }) as typeof process.stdout.write
  try {
    for (const [index, definition] of definitions.entries()) {
      if (index === 0) delete definition.termNeedsGeometry
      else definition.termNeedsGeometry = true
      if (index === 0) definition.termWrites = "query"
      definition.term = async (context) => {
        expect(prepared, `${ids[index]} must observe capture preparation`).toBe(true)
        expect(context.captureGeometry).toEqual({
          geometry: { cellWidth: 8, cellHeight: 16, textWidth: 640, textHeight: 384 },
          source: "measured by complete raster calibration",
        })
        order.push(`callback:${ids[index]}`)
        context.write(`fixture:${ids[index]}`)
        return {
          pass: false,
          tests: [
            { id: "criterion", status: "test-todo", reason: "Lifecycle fixture does not measure terminal support" },
          ],
        }
      }
    }
    const batch = await runProbeBatch({
      ids,
      ownedTerminal: geometryOwner(measured(24, 80)),
      prepareCapture: async ({ context, featureId, recordCapture }) => {
        expect(featureId).toBe("collector.captureCalibration")
        expect(prepared).toBe(false)
        order.push("prepare")
        context.write("calibration:paint-witness")
        prepared = true
        Object.assign(context, {
          captureGeometry: {
            geometry: { cellWidth: 8, cellHeight: 16, textWidth: 640, textHeight: 384 },
            source: "measured by complete raster calibration",
          },
        })
        recordCapture({
          frame: { role: "control", ref: captureRef, capturedAt: 1, label: "origin calibration" },
          trace: { captureCommand: "fixture-capture" },
        })
      },
    })
    expect(order).toEqual(["prepare", "callback:reset.ris", "callback:reset.decaln"])
    expect(writes).toContain("calibration:paint-witness")
    expect(writes.indexOf("calibration:paint-witness")).toBeLessThan(writes.indexOf("fixture:reset.ris"))
    expect(writes).not.toContain("calibration:paint-witness\n")
    expect(batch.screenshotRefs).toEqual([captureRef])
    expect(JSON.parse(batch.rawReplies["reset.ris"]!)).toMatchObject({
      writes: ["fixture:reset.ris"],
    })
    expect(JSON.parse(batch.rawReplies["reset.ris"]!)).not.toHaveProperty("captures")
    expect(JSON.parse(batch.rawReplies["collector.captureCalibration.trace"]!)).toMatchObject({
      writes: ["calibration:paint-witness"],
      captures: [{ frame: { ref: captureRef }, trace: { captureCommand: "fixture-capture" } }],
    })
    expect(JSON.parse(batch.rawReplies["reset.decaln"]!)).toMatchObject({
      writes: ["fixture:reset.decaln"],
    })
  } finally {
    definitions.forEach((definition, index) => Object.assign(definition, originals[index]))
  }
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
    assertionType: "query_reply",
  })
  expect(batch.results.find((item) => item.featureId === "reset.decaln")).toMatchObject({ status: "test-todo" })
  expect(batch.ungradedDiagnostics["reset.decaln"]).toBeUndefined()
  expect(writes).not.toContain("\x1b#8")
  expect(writes).toContain("\x1b[?2004$p\x1b[c")
})

// The width-helper trace must describe the actual output and retain every CPR reply, rather than an invented fixture.
it("retains actual width-helper writes and all four CPR query outcomes", async () => {
  verifiedBatchFixture()
  vi.mocked(measureUtf8Decoding).mockResolvedValue("utf8")
  const replies = ["\x1b[2;1R", "\x1b[1;2R", "\x1b[1;2R", "\x1b[1;3R"]
  const pending = [...replies]
  const emitted: string[] = []
  process.stdout.write = ((sequence: string) => {
    emitted.push(sequence)
    if (sequence === "\x1b[6n") process.stdin.emit("data", Buffer.from(pending.shift()!))
    return true
  }) as typeof process.stdout.write
  try {
    const id = "unicode.east-asian-ambiguous"
    const batch = await runProbeBatch({
      ids: [id],
      ownedTerminal: geometryOwner(measured(24, 61), async () => measured(24, 61)),
    })
    const trace = JSON.parse(batch.rawReplies[id]!)
    const writes = emitted.filter((sequence) => sequence !== "\x1b[6n")
    expect(pending).toEqual([])
    expect(writes).toHaveLength(6)
    expect(trace).toMatchObject({
      writes,
      queries: replies.map((raw) => ({
        sequence: "\x1b[6n",
        match: [...raw.match(/\x1b\[(\d+);(\d+)R/)!],
        reason: "reply",
        raw,
        rawBase64: Buffer.from(raw).toString("base64"),
      })),
      events: emitted.map((sequence) => ({ sequence })),
    })
    expect(batch.observations).toMatchObject([{ featureId: id, outcome: "supported", assertionType: "query_reply" }])
  } finally {
    vi.mocked(measureUtf8Decoding).mockRestore()
  }
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
        assertionType: "query_reply",
      },
    ])
    expect(batch.assertions).toMatchObject([
      {
        featureId: "device.primary-da",
        kind: "positive",
        observed: "\x1b[?62;4c",
        note: expect.stringContaining("resized"),
      },
    ])
    expect(JSON.parse(batch.rawReplies["device.primary-da.callbackObservation"]!)).toMatchObject({
      outcome: "supported",
      assertionType: "query_reply",
    })
    expect(batch.results.find((result) => result.featureId === "device.primary-da")).toMatchObject({
      status: "test-failure",
      criterionBranch: "resized-capture",
      tests: [{ id: "geometry", status: "test-failure", assertionRefs: [0] }],
    })
    expect(batch.rawReplies["device.primary-da"]).toBe("\x1b[?62;4c")
    expect(JSON.parse(batch.rawReplies["collector.geometry"]!)).toMatchObject({
      checks: [{ pre: { rows: 24, cols: 61 }, post: { rows: 31, cols: 73 } }],
    })
    const decoded = decodeCollectorRun("resized.json", JSON.stringify(asRun(batch)), manifest, sourceRevision).run
    expect(decoded.assertions).toEqual(batch.assertions)
    expect(decoded.observations).toEqual(batch.observations)
    expect(decoded.rawReplies["device.primary-da.callbackObservation"]).toBe(
      batch.rawReplies["device.primary-da.callbackObservation"],
    )
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
  const originalEvidence = definition.termAssertionType
  definition.termAssertionType = "query_reply"
  definition.term = (async () => ({
    pass: false,
    response: "\x1b[?62;4c",
    notTested: { reason: "no-semantic-observable", noObservable: "device attributes" },
    observation: {
      outcome: "error",
      reason: "collector-error",
      assertionType: "query_reply",
      note: "TTY write failed",
    },
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
    definition.termAssertionType = originalEvidence
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
    observation: { outcome: "supported", assertionType: "query_reply" },
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
  const originalEvidence = definition.termAssertionType
  definition.termNeedsGeometry = undefined
  definition.termAssertionType = "query_reply"
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
    definition.termAssertionType = originalEvidence
  }
})

it.each([
  "modes.left-right-margin",
  "modes.altscreen-47",
  "modes.altscreen-1047",
  "modes.xtpushsgr",
  "modes.xtpopsgr",
  "modes.xtsave",
  "modes.xtrestore",
  "modes.xtpushcolors",
  "modes.xtpopcolors",
  "extensions.truecolor",
  "extensions.sixel",
  "extensions.iterm2-images",
])("the real collector enforces the geometry declaration for %s", async (id) => {
  verifiedBatchFixture()
  const definition = ALL_PROBES.find((item) => item.id === id)!
  expect(definition.termNeedsGeometry, id).toBe(true)
  const original = definition.termNeedsGeometry
  const originalEvidence = definition.termAssertionType
  // Clearing the declaration must make the real collector seam refuse the callback's rows/cols read,
  // proving the declaration is load-bearing rather than only satisfied by a fake plain-number context.
  definition.termNeedsGeometry = undefined
  definition.termAssertionType = "screenshot"
  const writes: string[] = []
  process.stdout.write = ((text: string) => {
    writes.push(text)
    return true
  }) as typeof process.stdout.write
  try {
    const batch = await runProbeBatch({
      ids: [id],
      ownedTerminal: geometryOwner(measured(24, 80)),
      capture: async () => {
        throw new Error("capture checkpoint must not be reached without a geometry declaration")
      },
    })
    expect(batch.ungradedDiagnostics[id], id).toMatchObject({
      kind: "collector-error",
      name: "UndeclaredTerminalGeometry",
      message: expect.stringContaining(id),
    })
    expect(batch.observations, id).toEqual([])
    expect(writes, id).toEqual([])
  } finally {
    definition.termNeedsGeometry = original
    definition.termAssertionType = originalEvidence
  }
})

/**
 * editing.decsace compares the same measured 2x8 pixel cells across its seed and two extents.
 * The collector must supply owned geometry and retain the cell digests and crop rectangle through
 * canonical parsing, while keeping the completed observation in suiteComplete.
 *
 * The expected set is narrowed to this probe (the pattern the collector-error tests above use) so the
 * assertion is about the real completeness formula, `expected ⊆ observed ∪ notTested AND no
 * diagnostics`, without running every app probe through its real query timeouts.
 */
it("grades editing.decsace on measured pixel cells and keeps suiteComplete", async () => {
  verifiedBatchFixture()
  const others = ALL_PROBES.filter((probe) => probe.id !== "editing.decsace" && probe.term !== null)
  const originals = others.map((probe) => probe.term)
  let reads = 0
  const labels: string[] = []
  const geometry = { cellWidth: 8, cellHeight: 16, textWidth: 640, textHeight: 384 }
  const originalWrite = process.stdout.write
  process.stdout.write = (() => true) as typeof process.stdout.write
  try {
    for (const probe of others) probe.term = null
    const batch = await runProbeBatch({
      ownedTerminal: geometryOwner(measured(24, 80)),
      prepareCapture: async ({ context }) => {
        context.captureGeometry = { geometry, source: "measured by complete raster calibration" }
      },
      capture: async ({ role, label, cells, pixelGeometry }) => {
        expect(cells).toEqual({ top: 1, left: 1, bottom: 2, right: 8 })
        expect(pixelGeometry).toEqual(geometry)
        reads += 1
        labels.push(label)
        // The seed pair shares measured cells; encoded refs, whole frames and cells are distinct
        // facts, and only the two DECSACE extents change the compared cells.
        const measured = label.includes("rectangle") ? "b" : label.includes("stream") ? "c" : "a"
        const digest = (kind: string) => `sha256:${createHash("sha256").update(`${kind}:${measured}`).digest("hex")}`
        return {
          frame: {
            role,
            label,
            capturedAt: reads,
            ref: digest(`encoded:${reads}`),
            pixelsDigest: digest("whole"),
            regionDigest: digest("cells"),
            regionRectangle: { x: 0, y: 0, width: 64, height: 32 },
          },
          trace: {},
        }
      },
    })
    expect(batch.ungradedDiagnostics).toEqual({})
    expect(batch.suiteComplete).toBe(true)
    expect(batch.observations).toMatchObject([
      { featureId: "editing.decsace", outcome: "supported", assertionType: "screenshot" },
    ])
    expect(
      decodeCollectorRun(
        "decsace.json",
        JSON.stringify({ ...asRun(batch), screenshotRefs: batch.screenshotRefs }),
        manifest,
        sourceRevision,
      ).run.observations,
    ).toMatchObject([{ featureId: "editing.decsace", outcome: "supported", assertionType: "screenshot" }])
    expect(labels).toEqual([
      // The seed paint happens first, then the shared stability pair reads the seeded screen: its
      // second read IS the seed frame, so the extent frames follow.
      "editing.decsace: seed stability 1",
      "editing.decsace: seed stability 2",
      "editing.decsace: DECSACE 2 rectangle frame",
      "editing.decsace: DECSACE 0 stream frame",
    ])
  } finally {
    process.stdout.write = originalWrite
    others.forEach((probe, index) => {
      probe.term = originals[index] ?? null
    })
  }
})

// 27863: a feature whose app callback reads the measured grid must declare termNeedsGeometry; a
// missing declaration is a collector error that silently costs the feature every run.
it("grades cursor.shape and cursor.reverse-wrap when each declares its measured-grid read", async () => {
  verifiedBatchFixture()
  const replies = ["\x1b[1;1R", "\x1b[2;2R", "\x1b[1;61R"]
  process.stdout.write = ((text: string) => {
    if (text === "\x1b[6n") {
      const reply = replies.shift()
      if (reply) process.stdin.emit("data", Buffer.from(reply))
    }
    return true
  }) as typeof process.stdout.write
  const batch = await runProbeBatch({
    ids: ["cursor.shape", "cursor.reverse-wrap"],
    capture: async ({ role, label }) => ({
      frame: { role, label, capturedAt: Date.now(), ref: `sha256:${"a".repeat(64)}` },
      trace: {},
    }),
    ownedTerminal: geometryOwner(measured(24, 61)),
  })
  expect(batch.ungradedDiagnostics).toEqual({})
  expect(batch.observations.find((item) => item.featureId === "cursor.shape")).toMatchObject({
    outcome: "inconclusive",
    assertionType: "screenshot",
  })
  expect(batch.observations.find((item) => item.featureId === "cursor.reverse-wrap")).toMatchObject({
    outcome: "supported",
    assertionType: "query_reply",
  })
})

// A text adapter answers a cell-readback row where pixel geometry was refused, and its ref lands in
// the text list — never in `screenshotRefs`, whose every consumer assumes a PNG.
it("keeps a text frame's ref out of screenshotRefs on the row whose verdict reads cells", async () => {
  verifiedBatchFixture()
  let reads = 0
  const refs: string[] = []
  const written: string[] = []
  process.stdout.write = ((text: string) => {
    written.push(text)
    return true
  }) as typeof process.stdout.write
  const batch = await runProbeBatch({
    ids: ["erase.el-with-attrs"],
    captureKind: "text-cells",
    captureGeometryRefusal: "the app answers no cell geometry",
    capture: async ({ role, label }) => {
      reads += 1
      // A fresh screen each read: the paint witness must differ from its baseline, as it does on a
      // terminal that actually painted.
      const ref = `sha256:${String(reads).padStart(64, "0")}`
      refs.push(ref)
      return {
        frame: {
          kind: "text-cells",
          role,
          label,
          capturedAt: reads,
          ref,
          cellDigest: ref,
          frameDigest: ref,
          cellRectangle: { top: 1, left: 1, bottom: 24, right: 80 },
        },
        trace: { kind: "text-cells", retained: "snapshot.txt", source: "the terminal's own text snapshot" },
      }
    },
    ownedTerminal: geometryOwner(measured(24, 80)),
  })
  expect(reads).toBeGreaterThan(0)
  expect(written.length).toBeGreaterThan(0)
  expect(batch.screenshotRefs).toEqual([])
  expect(batch.textSnapshotRefs).toEqual([...new Set(refs)])
})

// 30055 AC4: the host a text capture actually recorded reaches the observation as image, path and
// digest. `pid` and `ppid` stay in the artifact trace, because they name one process instance rather
// than a host a reader can check (@cto ruling 6255e75d conditions 1 and 5).
it("carries the console host a text capture recorded onto the observation, without its pids", async () => {
  verifiedBatchFixture()
  let reads = 0
  process.stdout.write = (() => true) as typeof process.stdout.write
  const owner = {
    image: "OpenConsole.exe",
    pid: 7216,
    ppid: 4684,
    executablePath: "C:\\Windows\\System32\\OpenConsole.exe",
    executableSha256: `sha256:${"c".repeat(64)}`,
  }
  const batch = await runProbeBatch({
    ids: ["erase.el-with-attrs"],
    captureKind: "text-cells",
    captureGeometryRefusal: "the app answers no cell geometry",
    capture: async ({ role, label }) => {
      reads += 1
      const ref = `sha256:${String(reads).padStart(64, "0")}`
      return {
        frame: {
          kind: "text-cells" as const,
          role,
          label,
          capturedAt: reads,
          ref,
          cellDigest: ref,
          frameDigest: ref,
          cellRectangle: { top: 1, left: 1, bottom: 24, right: 80 },
        },
        trace: {
          kind: "text-cells",
          retained: "snapshot.txt",
          source: "the console host's buffer",
          bufferOwner: owner,
        },
      }
    },
    ownedTerminal: geometryOwner(measured(24, 80)),
  })
  const observation = batch.observations.find((item) => item.featureId === "erase.el-with-attrs")
  expect(observation).toMatchObject({ assertionType: "buffer_state" })
  expect(observation?.host).toEqual({
    image: "OpenConsole.exe",
    executablePath: owner.executablePath,
    executableSha256: owner.executableSha256,
  })
  // The artifact still carries the pids; the observation never does.
  expect(batch.rawReplies["erase.el-with-attrs"]).toContain('"pid":7216')
  expect(JSON.stringify(observation)).not.toContain("7216")
})

// Only the region readback can decide a row from cells. Every other consumer reads pixels, so a text
// run hands it no adapter at all and it takes its own named no-capture branch instead of recording a
// pixel claim over a text frame.
it("offers a text run's adapter to cell-readback probes alone and never gates it on pixel geometry", () => {
  const refused = "the app answers no cell geometry"
  expect(captureAdapterEligible({ cellReadback: true }, "text-cells", refused)).toBe(true)
  expect(captureAdapterEligible({ cellReadback: true }, "text-cells", undefined)).toBe(true)
  expect(captureAdapterEligible({}, "text-cells", undefined)).toBe(false)
  expect(captureAdapterEligible({}, "text-cells", refused)).toBe(false)
  expect(captureAdapterEligible({ cellReadback: true }, "pixels", refused)).toBe(false)
  expect(captureAdapterEligible({ cellReadback: true }, "pixels", undefined)).toBe(true)
  expect(captureAdapterEligible({}, undefined, undefined)).toBe(true)
})

it("hands no adapter to a non-cell-readback probe on a text run", async () => {
  verifiedBatchFixture()
  let reads = 0
  const written: string[] = []
  process.stdout.write = ((text: string) => {
    written.push(text)
    return true
  }) as typeof process.stdout.write
  const batch = await runProbeBatch({
    ids: ["cursor.shape"],
    captureKind: "text-cells",
    captureGeometryRefusal: "the app answers no cell geometry",
    capture: async () => {
      reads += 1
      throw new Error("a non-region probe must not be handed the text adapter")
    },
    ownedTerminal: geometryOwner(measured(24, 80)),
  })
  expect(reads).toBe(0)
  expect(batch.screenshotRefs).toEqual([])
  expect(batch.textSnapshotRefs ?? []).toEqual([])
  expect(batch.results.find((item) => item.featureId === "cursor.shape")).toMatchObject({ status: "test-failure" })
  expect(batch.observations.find((item) => item.featureId === "cursor.shape")?.assertionType).not.toBe("pixels")
})

// A callback that fails after its text read is a collector error about cells, not a pixel claim.
it("records a text run's collector throw as text evidence", async () => {
  verifiedBatchFixture()
  let reads = 0
  const batch = await runProbeBatch({
    ids: ["erase.el-with-attrs"],
    captureKind: "text-cells",
    captureGeometryRefusal: "the app answers no cell geometry",
    capture: async ({ role, label }) => {
      reads += 1
      if (reads > 1) throw new Error("the snapshot read failed after a frame")
      const ref = `sha256:${"e".repeat(64)}`
      return {
        frame: {
          kind: "text-cells",
          role,
          label,
          capturedAt: 1,
          ref,
          cellDigest: ref,
          frameDigest: ref,
          cellRectangle: { top: 1, left: 1, bottom: 24, right: 80 },
        },
        trace: { kind: "text-cells", retained: "snapshot.txt", source: "the terminal's own text snapshot" },
      }
    },
    ownedTerminal: geometryOwner(measured(24, 80)),
  })
  expect(batch.results.find((item) => item.featureId === "erase.el-with-attrs")).toMatchObject({
    status: "test-failure",
  })
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
    assertionType: "query_reply",
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
      assertionType: "query_reply",
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
  expect(batch.results.filter((result) => ["device.primary-da"].includes(result.featureId))).toMatchObject([
    { status: "test-failure", featureId: "device.primary-da", reason: "TTY write failed" },
  ])
  expect(batch.ungradedDiagnostics["device.primary-da"]).toMatchObject({
    kind: "collector-error",
    message: "TTY write failed",
  })
  expect(batch.suiteComplete).toBe(false)
})

it("retains a generated region callback's early write failure as a collector error", async () => {
  verifiedBatchFixture()
  const definition = ALL_PROBES.find((item) => item.id === "editing.insert-chars")!
  process.stdout.write = (() => {
    throw new Error("Region TTY write failed")
  }) as typeof process.stdout.write
  const batch = await runProbeBatch({
    ids: [definition.id],
    ownedTerminal: geometryOwner(measured(24, 80)),
    capture: async () => {
      throw new Error("A frame cannot precede the failed region write")
    },
  })
  expect(batch.results.filter((result) => [definition.id].includes(result.featureId))).toMatchObject([
    { status: "test-failure", featureId: definition.id, reason: "Region TTY write failed" },
  ])
  expect(batch.ungradedDiagnostics[definition.id]).toMatchObject({ kind: "collector-error" })
  expect(batch.suiteComplete).toBe(false)
})

it("does not use a headless-only marker to grade an app callback exception", async () => {
  const definition = ALL_PROBES.find((item) => item.id === "device.primary-da")!
  const originalApp = definition.termAssertionType
  const originalHeadless = definition.libAssertionType
  definition.termAssertionType = undefined
  definition.libAssertionType = "buffer_state"
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
    definition.termAssertionType = originalApp
    definition.libAssertionType = originalHeadless
  }
})

// A live fixture must bind its independent X11 events to the same feature trace, after pixel checkpoints.
it.each(["start", "read", "write"])(
  "keeps a transient clipboard %s custody refusal and stops the batch",
  async (site) => {
    verifiedBatchFixture()
    const refusal = new Error(`clipboard ${site} custody lost once`)
    let phase = "idle",
      refused = false
    const assertOwned = async () => {
      if (phase === site && !refused) {
        refused = true
        throw refusal
      }
    }
    const probes = ALL_PROBES.filter(
      (probe) => probe.term && probe.termNeedsGeometry && !probe.termNeedsDisposable,
    ).slice(0, 2)
    expect(probes).toHaveLength(2)
    const callbacks = vi.fn()
    const readGeometry = vi.fn(async () => measured(24, 80))
    const originals = probes.map((probe) => ({ probe, term: probe.term }))
    try {
      probes[0]!.term = async (context) => {
        callbacks()
        return context.withClipboardFixture!(async (fixture) => {
          await fixture.readText()
          await fixture.writeText("fixture")
          return { pass: true, observation: { outcome: "supported", assertionType: "query_reply" } }
        })
      }
      probes[1]!.term = async () => {
        callbacks()
        return { pass: true, observation: { outcome: "supported", assertionType: "query_reply" } }
      }
      await expect(
        runProbeBatch({
          ids: probes.map((probe) => probe.id),
          ownedTerminal: {
            ...geometryOwner(measured(24, 80)),
            readGeometry,
            clipboard: {
              profile: "allow",
              config: "fixture",
              permissions: "fixture",
              summary: "{}",
              assertOwned,
              dispose: async () => {},
              async withClipboardFixture(work, _trace, verify) {
                try {
                  phase = "start"
                  await verify()
                  return await work({
                    readText: async () => {
                      phase = "read"
                      await verify()
                      return "fixture"
                    },
                    writeText: async () => {
                      phase = "write"
                      await verify()
                    },
                  })
                } finally {
                  phase = "idle"
                }
              },
            },
          },
        }),
      ).rejects.toBe(refusal)
      expect(callbacks).toHaveBeenCalledTimes(1)
      // The catch must stop before the next probe's geometry callback, not only at the final check.
      expect(readGeometry).toHaveBeenCalledTimes(2)
    } finally {
      originals.forEach(({ probe, term }) => {
        probe.term = term
      })
    }
  },
)

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
        assertOwned: async () => {},
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
        assertOwned: async () => {},
        dispose: async () => {},
        async withClipboardFixture(_work, trace) {
          trace({ kind: "clipboard-restore", at: new Date().toISOString(), sha256: "b".repeat(64), length: 8 })
          throw new Error("Owned clipboard restoration failed")
        },
      },
    },
  })
  expect(batch.results.filter((result) => ["extensions.osc52-write"].includes(result.featureId))).toMatchObject([
    { status: "test-failure", featureId: "extensions.osc52-write", rawReplyRef: "extensions.osc52-write" },
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
  // The DECRQSS readback attempt writes the styled sequence to set the state it queries, so assert
  // on the rendered sample: the control frame renders it unstyled, the target frame styled.
  const styledSample = "\x1b[4:3mAaBb 0123456789 - terminal text"
  expect(checkpoints[0]?.writes).not.toContain(styledSample)
  expect(checkpoints[1]?.writes).toContain(styledSample)
  expect(batch.screenshotRefs).toEqual(frames.map(({ ref }) => ref))
  expect(batch.observations).toEqual([
    expect.objectContaining({
      featureId: "sgr.underline.curly",
      outcome: "inconclusive",
      assertionType: "screenshot",
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

// 27875: a controlled-Linux run with no capture directory cannot make a frame. A probe that needs
// one must say so by name, in its own result, and must not claim pixels that do not exist.
it("records a FrameUnavailable capture as a named collector error, never invented pixels", async () => {
  verifiedBatchFixture()
  process.stdout.write = (() => true) as typeof process.stdout.write
  const batch = await runProbeBatch({
    ids: ["sgr.underline.curly"],
    ownedTerminal: geometryOwner(measured(24, 80)),
    captureRunId: "a".repeat(32),
    capture: async () => {
      const error = new Error("This run has no capture directory, so no frame is available for a probe that needs one")
      error.name = "FrameUnavailable"
      throw error
    },
  })
  expect(batch.ungradedDiagnostics["sgr.underline.curly"]).toMatchObject({
    kind: "collector-error",
    name: "FrameUnavailable",
    message: expect.stringContaining("no capture directory"),
  })
  expect(batch.observations).toEqual([])
})

// The stub is installed only on a controlled-Linux run with no capture directory. Everywhere else
// no capture callback exists at all, and the row stays a graceful absence — but its label is the
// honest one: the DECSCUSR set and the DECRQSS query are written before the probe gives up, so the
// silence is query/no-response, never none (8753a5e2, implementing @cto 05101f84; supersedes 27875).
it("keeps today's graceful absence row when no capture callback is installed", async () => {
  verifiedBatchFixture()
  process.stdout.write = (() => true) as typeof process.stdout.write
  const batch = await runProbeBatch({
    ids: ["cursor.shape"],
    ownedTerminal: geometryOwner(measured(24, 80)),
    captureRunId: "a".repeat(32),
  })
  expect(batch.results.filter((result) => ["cursor.shape"].includes(result.featureId))).toMatchObject([
    {
      status: "test-failure",
      featureId: "cursor.shape",
      reason: "DECRQSS cursor-style report unanswered; no pixel readback for shape",
    },
  ])
  expect(batch.ungradedDiagnostics).toEqual({})
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
  expect(batch.results.filter((result) => ["sgr.underline.curly"].includes(result.featureId))).toMatchObject([
    { status: "test-failure", featureId: "sgr.underline.curly", reason: "Owned window disappeared" },
  ])
  expect(batch.screenshotRefs).toEqual([])
  expect(batch.ungradedDiagnostics).toEqual({})
})

// 27874 part 2: a receipt is bound to the run's own target BEFORE the first write. Checking it after
// the batch would mean a mismatched receipt had already authorized mutate+readback against the
// wrong app, so the refusal has to happen with nothing written.
it("refuses a receipt for another target before writing any byte", async () => {
  verifiedBatchFixture()
  const directory = mkdtempSync(join(tmpdir(), "terminfo-disposable-receipts-"))
  receiptDirectories.push(directory)
  const path = join(directory, "host-measured.json")
  writeFileSync(path, JSON.stringify(validContainerReceipt()))
  process.env.TERMINFO_DISPOSABLE_RECEIPT = path
  const writes: string[] = []
  process.stdout.write = ((text: string) => {
    writes.push(text)
    return true
  }) as typeof process.stdout.write
  await expect(
    runProbeBatch({
      ids: ["extensions.osc110-reset-fg"],
      subject: { kind: "term", id: "wezterm", os: "linux" },
    }),
  ).rejects.toThrow(/receipt declares target .*kitty.* but this run is .*wezterm/)
  expect(writes).toEqual([])
})

// A receipt that names a target cannot be bound to nothing: the caller must supply the run's own
// target, so a caller that forgot is loud rather than silently unbound.
it("refuses a receipt that names a target when the caller supplied no run target", async () => {
  verifiedBatchFixture()
  const directory = mkdtempSync(join(tmpdir(), "terminfo-disposable-receipts-"))
  receiptDirectories.push(directory)
  const path = join(directory, "host-measured.json")
  writeFileSync(path, JSON.stringify(validContainerReceipt()))
  process.env.TERMINFO_DISPOSABLE_RECEIPT = path
  const writes: string[] = []
  process.stdout.write = ((text: string) => {
    writes.push(text)
    return true
  }) as typeof process.stdout.write
  await expect(runProbeBatch({ ids: ["extensions.osc110-reset-fg"] })).rejects.toThrow(
    /no run target was supplied to bind it to/,
  )
  expect(writes).toEqual([])
})

// 28752: the run measures how its terminal decodes plain-written UTF-8 ONCE, records the fact
// beside the other collector facts, and hands every row the same answer — the context a
// plain-written oracle assumes is measured, never inherited from whatever locale launched it.
it("measures the decode context once per run and records it beside the other collector facts", async () => {
  verifiedBatchFixture()
  const actual = await vi.importActual<typeof import("../tty.ts")>("../tty.ts")
  vi.mocked(measureUtf8Decoding).mockImplementation(actual.measureUtf8Decoding)
  const replies = ["\x1b[2;1R", "\x1b[2;3R"]
  const pending = [...replies]
  const emitted: string[] = []
  process.stdout.write = ((sequence: string) => {
    emitted.push(sequence)
    if (sequence === "\x1b[6n") process.stdin.emit("data", Buffer.from(pending.shift()!))
    return true
  }) as typeof process.stdout.write
  const definition = ALL_PROBES.find((item) => item.id === "device.primary-da")!
  const originalTerm = definition.term
  const seen: Array<string | null> = []
  definition.term = async (ctx) => {
    if (!ctx.utf8Decoding) throw new Error("collector did not install the measured decode context")
    seen.push(await ctx.utf8Decoding())
    seen.push(await ctx.utf8Decoding())
    return {
      pass: false,
      observation: { outcome: "inconclusive", reason: "insufficient-evidence", assertionType: "query_reply" },
    }
  }
  try {
    const batch = await runProbeBatch({ ids: [definition.id] })
    expect(seen).toEqual(["8-bit", "8-bit"])
    expect(vi.mocked(measureUtf8Decoding)).toHaveBeenCalledTimes(1)
    expect(pending).toEqual([])
    const writes = emitted.filter((sequence) => sequence !== "\x1b[6n")
    expect(writes).toEqual(["\x1b7", "\x1b[2;1H", "\x1b[0më", "\x1b[2;1H\x1b[2X", "\x1b8"])
    expect(JSON.parse(batch.rawReplies["collector.utf8Decoding"]!)).toMatchObject({
      decoding: "8-bit",
      writes,
      queries: replies.map((raw) => ({
        sequence: "\x1b[6n",
        match: [...raw.match(/\x1b\[(\d+);(\d+)R/)!],
        reason: "reply",
        raw,
        rawBase64: Buffer.from(raw).toString("base64"),
      })),
      events: emitted.map((sequence) => ({ sequence })),
    })
    expect(batch.rawReplies[definition.id]).toBe("")
  } finally {
    definition.term = originalTerm
    vi.mocked(measureUtf8Decoding).mockRestore()
  }
})

// @dev/review2: the memo has to hold the ATTEMPT, not its fulfilled value. A row that asks again
// while the first round trip is still in flight must join it, not start a second one.
it("joins the in-flight attempt, so a row asking before it returns measures nothing twice", async () => {
  verifiedBatchFixture()
  const measured = vi.mocked(measureUtf8Decoding)
  const original = measured.getMockImplementation()
  let attempts = 0
  let release: (reading: "8-bit") => void = () => {}
  measured.mockImplementation(() => {
    attempts += 1
    return new Promise<"8-bit">((resolve) => {
      release = resolve
    })
  })
  const definition = ALL_PROBES.find((item) => item.id === "device.primary-da")!
  const originalTerm = definition.term
  definition.term = async (ctx) => {
    if (!ctx.utf8Decoding) throw new Error("collector did not install the measured decode context")
    const first = ctx.utf8Decoding()
    const second = ctx.utf8Decoding()
    release("8-bit")
    const seen = await Promise.all([first, second])
    expect(seen).toEqual(["8-bit", "8-bit"])
    return {
      pass: false,
      observation: { outcome: "inconclusive", reason: "insufficient-evidence", assertionType: "query_reply" },
    }
  }
  try {
    const batch = await runProbeBatch({ ids: [definition.id] })
    expect(attempts).toBe(1)
    expect(JSON.parse(batch.rawReplies["collector.utf8Decoding"]!)).toEqual({
      decoding: "8-bit",
      writes: [],
      queries: [],
      events: [],
    })
  } finally {
    definition.term = originalTerm
    if (original) measured.mockImplementation(original)
    else measured.mockReset()
  }
})

// @dev/review2: a failed attempt must stay failed for the batch. Retrying it per row would hide the
// failure behind a later, differently-contexted measurement and re-open the round trip every row.
it("keeps a failed attempt failed for the batch, so no later row re-measures the same context", async () => {
  verifiedBatchFixture()
  const actual = await vi.importActual<typeof import("../tty.ts")>("../tty.ts")
  const raw = "\x1b[2;1R"
  process.stdout.write = ((sequence: string) => {
    if (sequence === "\x1b[6n") process.stdin.emit("data", Buffer.from(raw))
    if (sequence === "\x1b[0më") throw new Error("the decode round trip failed")
    return true
  }) as typeof process.stdout.write
  const measured = vi.mocked(measureUtf8Decoding)
  const original = measured.getMockImplementation()
  let attempts = 0
  measured.mockImplementation(() => {
    attempts += 1
    return actual.measureUtf8Decoding()
  })
  const definition = ALL_PROBES.find((item) => item.id === "device.primary-da")!
  const originalTerm = definition.term
  const seen: string[] = []
  definition.term = async (ctx) => {
    if (!ctx.utf8Decoding) throw new Error("collector did not install the measured decode context")
    for (let ask = 0; ask < 2; ask += 1) {
      seen.push(await ctx.utf8Decoding().catch((error: Error) => `failed: ${error.message}`))
    }
    return {
      pass: false,
      observation: { outcome: "inconclusive", reason: "insufficient-evidence", assertionType: "query_reply" },
    }
  }
  try {
    const batch = await runProbeBatch({ ids: [definition.id] })
    expect(attempts).toBe(1)
    expect(seen).toEqual(["failed: the decode round trip failed", "failed: the decode round trip failed"])
    const retained = batch.rawReplies["collector.utf8Decoding"]
    expect(retained).toBeTruthy()
    expect(JSON.parse(retained!)).not.toHaveProperty("decoding")
    expect(JSON.parse(retained!)).toMatchObject({
      writes: ["\x1b7", "\x1b[2;1H", "\x1b[0më", "\x1b8"],
      queries: [
        {
          sequence: "\x1b[6n",
          reason: "reply",
          match: [raw, "2", "1"],
          raw,
          rawBase64: Buffer.from(raw).toString("base64"),
        },
      ],
    })
  } finally {
    definition.term = originalTerm
    if (original) measured.mockImplementation(original)
    else measured.mockReset()
  }
})

it.each(["CaptureRestoreFailed", "QueryTimeout", "QueryIOError", "CapturePermissionError", "OwnershipError"])(
  "a calibration %s aborts the batch before any callback",
  async (name) => {
    verifiedBatchFixture()
    const id = "modes.bracketed-paste"
    const definition = ALL_PROBES.find((probe) => probe.id === id)
    if (!definition) throw new Error("Missing existing bracketed-paste probe")
    const original = definition.term
    let callbacks = 0
    definition.term = async () => {
      callbacks++
      return {
        pass: false,
        tests: [{ id: "criterion", status: "test-todo", reason: "insufficient-evidence" }],
      }
    }
    const failure = Object.assign(new Error("Witnessed restore did not match the pre-paint frame"), {
      name,
    })
    try {
      await expect(
        runProbeBatch({
          ids: [id],
          ownedTerminal: geometryOwner(measured(24, 80)),
          prepareCapture: async () => {
            throw failure
          },
        }),
      ).rejects.toBe(failure)
      expect(callbacks).toBe(0)
    } finally {
      definition.term = original
    }
  },
)

it("capture preparation refuses unavailable counts instead of using output defaults", async () => {
  verifiedBatchFixture()
  let painted = false
  await expect(
    runProbeBatch({
      ids: ["modes.bracketed-paste"],
      ownedTerminal: geometryOwner(noGeometry),
      prepareCapture: async () => {
        painted = true
      },
    }),
  ).rejects.toThrow(/verified.*grid|grid.*unavailable/)
  expect(painted).toBe(false)
})

it("capture preparation refuses a changed owned grid before a query callback can paint a stale subset", async () => {
  verifiedBatchFixture()
  vi.spyOn(process.stdout, "write").mockReturnValue(true)
  let painted = false
  await expect(
    runProbeBatch({
      ids: ["modes.bracketed-paste"],
      ownedTerminal: geometryOwner(measured(24, 80), async () => measured(30, 120)),
      prepareCapture: async () => {
        painted = true
      },
    }),
  ).rejects.toThrow(/grid.*changed|grid.*disagree/)
  expect(painted).toBe(false)
})

it("a retained terminal grid reply supplies preparation counts when declared size is unavailable", async () => {
  verifiedBatchFixture()
  vi.spyOn(process.stdout, "write").mockReturnValue(true)
  let seen: number[] | undefined
  const raw = "\x1b[8;30;120t"
  await runProbeBatch({
    ids: ["modes.bracketed-paste"],
    ownedTerminal: geometryOwner(noGeometry),
    geometryCorroboration: {
      status: "uncorroborated",
      rows: 30,
      cols: 120,
      query: {
        sequence: "\x1b[18t",
        outbound: "\x1b[18t\x1b[c",
        reason: "reply",
        raw,
        rawBase64: Buffer.from(raw).toString("base64"),
      },
    },
    prepareCapture: async ({ context }) => {
      seen = [context.rows, context.cols]
    },
  })
  expect(seen).toEqual([30, 120])
})

it.each(["conflict", "malformed", "live mismatch"] as const)(
  "capture refuses %s without painting and retains the 18t evidence",
  async (fault) => {
    verifiedBatchFixture()
    vi.spyOn(process.stdout, "write").mockReturnValue(true)
    let painted = false
    const raw = "\x1b[8;30;120t"
    const batch = await runProbeBatch({
      ids: ["modes.bracketed-paste"],
      ownedTerminal: geometryOwner(measured(24, 80)),
      geometryCorroboration: {
        status: fault === "live mismatch" ? "agree" : fault,
        rows: 30,
        cols: 120,
        query: {
          sequence: "\x1b[18t",
          outbound: "\x1b[18t\x1b[c",
          reason: "reply",
          raw,
          rawBase64: Buffer.from(raw).toString("base64"),
        },
      },
      prepareCapture: async () => {
        painted = true
      },
    })
    expect(painted).toBe(false)
    expect(batch.rawReplies["collector.captureCalibration.trace"]).toContain(raw.replaceAll("\x1b", "\\u001b"))
    expect(JSON.parse(batch.rawReplies["collector.captureCalibration.trace"]!)).toMatchObject({
      refusal: expect.stringMatching(/grid.*disagree|grid.*malformed/),
    })
  },
)

it("an 18t timeout aborts capture preparation instead of recording a terminal refusal", async () => {
  verifiedBatchFixture()
  vi.spyOn(process.stdout, "write").mockReturnValue(true)
  let painted = false
  await expect(
    runProbeBatch({
      ids: ["modes.bracketed-paste"],
      ownedTerminal: geometryOwner(measured(24, 80)),
      geometryCorroboration: {
        status: "silent",
        query: {
          sequence: "\x1b[18t",
          outbound: "\x1b[18t\x1b[c",
          reason: "timeout",
          raw: "",
          rawBase64: "",
        },
      },
      prepareCapture: async () => {
        painted = true
      },
    }),
  ).rejects.toThrow(/18t.*timed out/)
  expect(painted).toBe(false)
})

// The unit owns mode classification; this boundary owns trace retention and gap
// propagation to real protocol and region callbacks after preparation refuses.
it.each(["unknown reply", "sentinel diagnostic reply", "sentinel diagnostic timeout"])(
  "a cursor-mode %s retains bytes and continues without pixel capture",
  async (fault) => {
    verifiedBatchFixture()
    vi.useFakeTimers()
    const da1 = "\x1b[?62;4c"
    const raw = fault === "unknown reply" ? `\x1b[?25;0$y${da1}` : da1
    const diagnostic = fault === "sentinel diagnostic reply" ? "\x1b[?25;1$y" : ""
    vi.spyOn(process.stdout, "write").mockImplementation(((text: string) => {
      if (text === "\x1b[?25$p\x1b[c") process.stdin.emit("data", Buffer.from(raw))
      if (text === "\x1b[?25$p" && diagnostic) process.stdin.emit("data", Buffer.from(diagnostic))
      if (text === "\x1b[c") process.stdin.emit("data", Buffer.from(da1))
      return true
    }) as typeof process.stdout.write)
    const capture = vi.fn()
    const captureRaw = vi.fn()
    const pending = runProbeBatch({
      ids: ["device.primary-da", "erase.line.all"],
      ownedTerminal: geometryOwner(measured(24, 80)),
      capture,
      prepareCapture: async ({ context }) => {
        await calibrateCaptureOrigin({ ctx: context, timeoutMs: 100, captureRaw })
      },
    })
    const [batch] = await Promise.all([pending, vi.runAllTimersAsync()])
    vi.useRealTimers()
    expect(batch.observations).toContainEqual(
      expect.objectContaining({ featureId: "device.primary-da", outcome: "supported", assertionType: "query_reply" }),
    )
    expect(batch.results.find((result) => result.featureId === "erase.line.all")).toMatchObject({
      status: "test-todo",
      reason: expect.stringMatching(/cursor visibility/),
    })
    const trace = JSON.parse(batch.rawReplies["collector.captureCalibration.trace"]!)
    expect(trace).toMatchObject({
      writes: [],
      captures: [],
      refusal: expect.stringMatching(/cursor visibility/),
      queries: [
        expect.objectContaining({
          raw,
          rawBase64: Buffer.from(raw).toString("base64"),
          reason: fault === "unknown reply" ? "reply" : "sentinel",
        }),
        ...(fault === "unknown reply"
          ? []
          : [
              expect.objectContaining({
                sequence: "\x1b[?25$p",
                raw: diagnostic,
                rawBase64: Buffer.from(diagnostic).toString("base64"),
                reason: diagnostic ? "reply" : "timeout",
              }),
            ]),
      ],
    })
    expect(captureRaw).not.toHaveBeenCalled()
    expect(capture).not.toHaveBeenCalled()
    expect(batch.ungradedDiagnostics).toEqual({})
  },
)

// 30035: unknown prior modes must retain the plain diagnostic outcomes through the actual
// preparation owner, without painting or promoting their replies into qualification state.
// Existing raw-outcome tests do not exercise this callback or its run-owned retained trace.
it.each([25, 7].flatMap((missing) => ["reply", "malformed", "timeout"].map((diagnostic) => ({ missing, diagnostic }))))(
  "text preparation retains $diagnostic diagnostics when prior mode $missing is unavailable",
  async ({ missing, diagnostic }) => {
    verifiedBatchFixture()
    vi.useFakeTimers()
    const da1 = "\x1b[?62;4c"
    const plain = ["\x1b[?25$p", "\x1b[?7$p"]
    const raw =
      diagnostic === "reply"
        ? ["\x1b[?25;4$y", "\x1b[?7;0$y"]
        : diagnostic === "malformed"
          ? ["\x1b[?25;5$y", "\x1b[?70;1$y"]
          : ["", ""]
    const sentAt = new Map<string, number>()
    vi.spyOn(process.stdout, "write").mockImplementation(((text: string) => {
      sentAt.set(text, Date.now())
      for (const mode of [25, 7]) {
        if (text === `\x1b[?${mode}$p\x1b[c`) {
          const prior = mode === missing ? (mode === 25 ? "" : `\x1b[?${mode};0$y`) : `\x1b[?${mode};1$y`
          process.stdin.emit("data", Buffer.from(prior + da1))
        }
      }
      const index = plain.indexOf(text)
      if (index >= 0 && raw[index]) process.stdin.emit("data", Buffer.from(raw[index]!))
      if (text === "\x1b[c") process.stdin.emit("data", Buffer.from(da1))
      return true
    }) as typeof process.stdout.write)
    const capture = vi.fn(async () => {
      throw new Error("unavailable prior modes must not capture")
    })
    let qualification: TextQualification | undefined
    let preparedAt: number | undefined
    try {
      const pending = runProbeBatch({
        ids: ["device.primary-da"],
        ownedTerminal: geometryOwner(measured(24, 80)),
        prepareCapture: async ({ context }) => {
          qualification = await collectTextQualification({ ctx: context, capture })
          preparedAt = Date.now()
        },
      })
      const [batch] = await Promise.all([pending, vi.runAllTimersAsync()])
      const trace = JSON.parse(batch.rawReplies["collector.captureCalibration.trace"]!)
      expect(trace).toMatchObject({
        writes: [],
        captures: [],
        queries: [
          { sequence: "\x1b[?25$p\x1b[c" },
          { sequence: "\x1b[?7$p\x1b[c" },
          ...plain.map((sequence, index) => ({
            sequence,
            raw: raw[index],
            rawBase64: Buffer.from(raw[index]!).toString("base64"),
            reason: diagnostic === "reply" ? "reply" : "timeout",
          })),
        ],
      })
      if (diagnostic !== "reply") {
        expect(sentAt.get(plain[1]!)! - sentAt.get(plain[0]!)!).toBe(5000)
        expect(preparedAt! - sentAt.get(plain[1]!)!).toBe(5000)
      }
      expect(qualification?.shapes).toEqual(
        ["mid-line-gap", "trailing-gap", "soft-wrap", "prior-scrollback", "empty-last-row"].map((shape) => ({
          shape,
          reason: `Prior cursor visibility or autowrap state is unavailable (DECTCEM=${missing === 25 ? "null" : "set"}, DECAWM=${missing === 7 ? "unknown" : "set"})`,
        })),
      )
      expect(capture).not.toHaveBeenCalled()
      expect(batch.observations).toContainEqual(
        expect.objectContaining({ featureId: "device.primary-da", outcome: "supported", assertionType: "query_reply" }),
      )
    } finally {
      vi.useRealTimers()
    }
  },
)

// The new execution contract requires the direct native batch to record status at its real
// callback attempt. Existing observation/coverage assertions cannot prove frozen-catalog TODOs.
it("records actual native callback failure and leaves an unscheduled frozen capability TODO", async () => {
  const { initializeRunDraft } = await import("@terminfo/probe-defs")
  const id = "modes.bracketed-paste"
  const definition = ALL_PROBES.find((probe) => probe.id === id)!
  const original = definition.term
  const draft = initializeRunDraft({
    source: { kind: "live" },
    runId: "native-status-attempt",
    sourceRevision,
    manifest: { ...manifest, schemaVersion: 4, catalogIds: [id, "unimplemented.capability"] },
    intendedSubject: { kind: "term", id: "kitty" },
  })
  try {
    definition.term = async () => {
      throw new Error("deterministic callback failure")
    }
    const batch = await runProbeBatch({ ids: [id], draft })
    expect(batch.results.find((result) => result.featureId === id)).toMatchObject({
      status: "test-failure",
      attempt: { scope: "probe" },
    })
    expect(batch.results.find((result) => result.featureId === "unimplemented.capability")).toMatchObject({
      status: "test-todo",
      attempt: { scope: "none" },
      tests: [],
    })
  } finally {
    definition.term = original
  }
})

// Existing native tests retained framed observations but never distinguished an attempted broken
// comparison from a still-unattempted required review at the callback-to-writer handoff.
it("forwards explicit callback tests through the actual native batch attempt without inferring review from frames", async () => {
  const { sgrCaptureFrames } = await import("../../../probe-defs/src/helpers.ts")
  const { cropPositionRefusal } = await import("../../../probe-defs/src/region-readback.ts")
  const id = "modes.bracketed-paste"
  const definition = ALL_PROBES.find((probe) => probe.id === id)!
  const original = definition.term
  const frames = [
    {
      role: "control" as const,
      label: "control",
      ref: `sha256:${"a".repeat(64)}`,
      capturedAt: 1,
      regionRectangle: { x: 0, y: 0, width: 10, height: 20 },
    },
    {
      role: "target" as const,
      label: "target",
      ref: `sha256:${"b".repeat(64)}`,
      capturedAt: 2,
      regionRectangle: { x: 0, y: 26, width: 10, height: 20 },
    },
  ]
  try {
    definition.term = async () =>
      cropPositionRefusal({
        id,
        compared: frames.map((frame) => ({ role: frame.role, rectangle: frame.regionRectangle })),
        response: "unequal crop positions",
        frames,
        screenshotRef: frames[1]!.ref,
      })!
    const failed = await runProbeBatch({ ids: [id] })
    expect(failed.results.find((result) => result.featureId === id)).toMatchObject({
      status: "test-failure",
      criterionBranch: "same-crop-comparison",
      tests: [{ id: "comparison", status: "test-failure", attempt: { scope: "probe" } }],
    })
    let next = 0
    definition.term = async () =>
      sgrCaptureFrames(
        {
          write() {},
          capture: async () => frames[next++]!,
        } as unknown as import("@terminfo/probe-defs").TermProbeSource,
        "control",
        "target",
        "visual target",
      )
    const pending = await runProbeBatch({ ids: [id] })
    const recorded = pending.results.find((result) => result.featureId === id)!
    expect(recorded.status).toBe("test-todo")
    expect(recorded.criterionBranch).toBe("visual-review")
    expect(recorded.tests.find((check) => check.id === "review")).toMatchObject({
      status: "test-todo",
      attempt: { scope: "none" },
    })
    expect(pending.assertions.find((assertion) => assertion.featureId === id)?.expected).toContain("visual target")
  } finally {
    definition.term = original
  }
})
