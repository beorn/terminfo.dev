/**
 * @failure Recorder loses callback evidence, or the observer cannot activate with valid owned-terminal capture IDs.
 * @level l1
 * @consumer Spike B private daemon context recorder and offline replay.
 * @testonly none
 */
import { existsSync, mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ProbeResult, TermContext } from "@terminfo/probe-defs"
import { expect, test, vi } from "vitest"
import { createOwnedTerminal } from "../../packages/terminfo.dev/src/owned-terminal.ts"
import { createCallLog, withCallLog, type CallLog } from "./call-log.ts"
import { observeSpikeB } from "./observe.ts"

test("valid owned-terminal capture IDs activate each observer mode without changing ordinary runs", async () => {
  const directory = mkdtempSync(join(tmpdir(), "spike-b-observer-"))
  const writes: string[] = []
  const unused = async (): Promise<never> => {
    throw new Error("Unexpected observer fixture method")
  }
  const context: TermContext = {
    write: (text) => {
      writes.push(text)
    },
    queryCursorPosition: unused,
    measureRenderedWidth: unused,
    query: unused,
    queryWithSentinel: unused,
    queryOutcome: unused,
    queryWithSentinelOutcome: unused,
    queryMode: unused,
    cols: 80,
    rows: 24,
  }
  const result: ProbeResult = {
    pass: false,
    observation: {
      outcome: "inconclusive",
      reason: "insufficient-evidence",
      evidence: "none",
      note: "Observer fixture",
    },
  }
  try {
    for (const [code, mode] of [
      ["a", "selection"],
      ["b", "baseline"],
      ["c", "decorated"],
    ] as const) {
      const runId = `30923${code}${"0".repeat(26)}`
      await expect(
        createOwnedTerminal({ captureRunId: runId, expectedLaunchRunId: "f".repeat(32), out: process.stdout }),
      ).rejects.toThrow("Owned terminal requires exactly one platform receipt")
      vi.stubEnv("TERMINFO_CAPTURE_RUN_ID", runId)
      vi.stubEnv("TERMINFO_CAPTURE_DIRECTORY", join(directory, mode, "artifacts"))
      expect(
        await observeSpikeB(
          "sgr.bold",
          async (received) => {
            expect(received === context).toBe(mode !== "decorated")
            received.write(mode)
            return result
          },
          context,
          [],
        ),
      ).toBe(result)
      const recorded = JSON.parse(readFileSync(join(directory, mode, "spike-b", "sgr.bold.json"), "utf8")) as {
        mode: string
        runId: string
        result: ProbeResult
        log?: CallLog
      }
      expect(recorded).toMatchObject({ mode, runId, result })
      if (mode === "decorated") expect(recorded.log?.calls).toMatchObject([{ path: "context.write", args: [mode] }])
      else expect(recorded.log).toBeUndefined()
    }
    vi.stubEnv("TERMINFO_CAPTURE_RUN_ID", "f".repeat(32))
    vi.stubEnv("TERMINFO_CAPTURE_DIRECTORY", join(directory, "ordinary", "artifacts"))
    expect(
      await observeSpikeB(
        "sgr.bold",
        async (received) => {
          expect(received).toBe(context)
          received.write("ordinary")
          return result
        },
        context,
        [],
      ),
    ).toBe(result)
    expect(writes).toEqual(["selection", "baseline", "decorated", "ordinary"])
    expect(existsSync(join(directory, "ordinary", "spike-b"))).toBe(false)
  } finally {
    vi.unstubAllEnvs()
  }
})

test("lazy geometry and nested callback/returned methods survive serialized offline replay", async () => {
  let reads = 0
  let liveCalls = 0
  const subject = {
    get cols(): number {
      throw new Error("unused geometry")
    },
    get rows() {
      return ++reads
    },
    get refused(): number {
      throw new RangeError("geometry refused")
    },
    returned: async () => ({
      read: async () => {
        liveCalls++
        return 31
      },
    }),
    fixture: async (work: (value: { read: () => Promise<number> }) => Promise<number>) =>
      work({
        read: async () => {
          liveCalls++
          return 29
        },
      }),
  }
  const exercise = async (context: typeof subject, adjustment = 0) => {
    const first = context.rows
    let refusal: unknown
    try {
      void context.refused
    } catch (error) {
      refusal = error
    }
    expect(refusal).toBeInstanceOf(RangeError)
    expect(refusal).toMatchObject({ name: "RangeError", message: "geometry refused" })
    return [
      first,
      context.rows,
      await (await context.returned()).read(),
      await context.fixture(async (value) => (await value.read()) + adjustment),
    ]
  }
  const log = createCallLog()
  const recording = withCallLog(subject, { mode: "record", log })
  expect(reads).toBe(0)
  expect(await exercise(recording.context)).toEqual([1, 2, 31, 29])
  recording.finish()
  const stored = JSON.parse(JSON.stringify(log)) as CallLog
  const replay = withCallLog<typeof subject>(null, { mode: "replay", log: stored })
  expect(await exercise(replay.context)).toEqual([1, 2, 31, 29])
  replay.finish()
  expect(reads).toBe(2)
  expect(liveCalls).toBe(2)
  const incomplete = withCallLog<typeof subject>(null, { mode: "replay", log: stored })
  expect(() => incomplete.finish()).toThrow(/unconsumed/)
  const changed = withCallLog<typeof subject>(null, { mode: "replay", log: stored })
  await expect(exercise(changed.context, 1)).rejects.toThrow(/callback outcome changed/)
  expect(() => changed.finish()).toThrow(/callback outcome changed/)
})

test("synthetic timeout preserves deadline and per-call replay clocks without a live wait", async () => {
  const timeout = { match: null, reason: "timeout" as const, raw: "", rawBase64: "" }
  const subject = {
    queryWithSentinelOutcome: async (_sequence: string, _pattern: RegExp, _deadline?: number) => timeout,
    queryWithSentinel: async (_sequence: string, _pattern: RegExp, _deadline?: number) => null,
    query: async (_sequence: string, _pattern: RegExp, _deadline?: number) => null,
    queryOutcome: async (_sequence: string, _pattern: RegExp, _deadline?: number) => timeout,
    readInput: async (_pattern: RegExp, _deadline?: number, inject?: () => Promise<void>) => {
      await inject?.()
      return ["a"]
    },
    input: { injectKey: async (_key: string) => {} },
  }
  const exercise = async (context: typeof subject) => {
    expect(await context.queryWithSentinelOutcome("request", /reply/, 60_000)).toEqual(timeout)
    await context.queryWithSentinelOutcome("request", /reply/)
    await context.queryWithSentinel("request", /reply/)
    await context.query("request", /reply/)
    await context.queryOutcome("request", /reply/)
    expect(await context.readInput(/^a/, undefined, () => context.input.injectKey("a"))).toEqual(["a"])
  }
  const log = createCallLog()
  const recording = withCallLog(subject, { mode: "record", log })
  await exercise(recording.context)
  recording.finish()
  expect(log.calls.map((call) => call.effectiveDeadlineMs)).toEqual([60_000, 2000, 2000, 1000, 1000, 1000, undefined])
  const replay = withCallLog<typeof subject>(null, { mode: "replay", log: JSON.parse(JSON.stringify(log)) as CallLog })
  await exercise(replay.context)
  replay.finish()
  expect(replay.replayTimings.map((call) => call.id)).toEqual(log.calls.map((call) => call.id))
  for (const call of log.calls) {
    expect(call.timing.startedAtMs).toBeGreaterThan(0)
    expect(call.timing.settledAtMs).toBeGreaterThanOrEqual(call.timing.startedAtMs)
    expect(call.timing.settledPerformanceMs).toBeGreaterThanOrEqual(call.timing.startedPerformanceMs)
  }
  for (const timing of replay.replayTimings) {
    expect(timing.startedAt).toBeGreaterThan(0)
    expect(timing.finishedAt).toBeGreaterThanOrEqual(timing.startedAt)
    expect(timing.finishedMonotonic).toBeGreaterThanOrEqual(timing.startedMonotonic)
  }
  const elapsed = replay.replayTimings[0]!.finishedMonotonic! - replay.replayTimings[0]!.startedMonotonic
  expect(elapsed).toBeLessThan(1000)
})

test("bundle consumer retains only the expected named draft and still refuses tampering and draft-only runs", async () => {
  const { createHash } = await import("node:crypto")
  const { spawnSync } = await import("node:child_process")
  const { mkdirSync, writeFileSync, unlinkSync } = await import("node:fs")
  const { fileURLToPath } = await import("node:url")
  const { ALL_PROBES, recordExecutedCapability } = await import("@terminfo/probe-defs")
  const directory = mkdtempSync(join(tmpdir(), "spike-b-bundle-"))
  const modes = ["selection", "baseline", "decorated"] as const
  const ids = ["device.tertiary-da", "erase.screen.scrollback", "sgr.bold"]
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jWZkAAAAASUVORK5CYII=",
    "base64",
  )
  const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex")
  const frameName = `${digest(png)}.png`
  const sourceRevision = "1".repeat(40)
  const roots = modes.map((mode) => join(directory, mode))
  for (const [index, mode] of modes.entries()) {
    const root = roots[index]!
    const runId = `${index + 1}`.repeat(32)
    mkdirSync(join(root, "artifacts"), { recursive: true })
    mkdirSync(join(root, "spike-b"))
    const run: import("@terminfo/probe-defs").CapturedRunDraft = {
      schemaVersion: 3,
      runId,
      suiteId: "1".repeat(12),
      probeHash: "1".repeat(12),
      sourceRevision,
      intendedContext: { kind: "app", id: "synthetic-bundle-fixture" },
      target: {
        kind: "app",
        id: "synthetic-bundle-fixture",
        version: "test",
        os: null,
        osVersion: null,
        outerTerminal: null,
        mux: null,
        config: null,
        permissions: null,
      },
      identity: "unverified",
      measuredAt: new Date().toISOString(),
      origin: { kind: "collector" },
      rawReplies: { "collector.selection": JSON.stringify({ ids }) },
      assertions: [],
      screenshotRefs: [],
      results: [],
    }
    for (const featureId of ids) {
      const original = ALL_PROBES.find((probe) => probe.id === featureId)?.term
      if (!original) throw new Error(`Missing fixture callback ${featureId}`)
      const unavailable = async (): Promise<never> => {
        throw new Error("Synthetic fixture has no terminal")
      }
      const subject: TermContext = {
        write: () => {},
        query: unavailable,
        queryOutcome: unavailable,
        queryWithSentinel: unavailable,
        queryWithSentinelOutcome: unavailable,
        queryCursorPosition: unavailable,
        measureRenderedWidth: unavailable,
        queryMode: unavailable,
        rows: 1,
        cols: 1,
      }
      const startedAt = Date.now()
      const startedMonotonic = performance.now()
      const log = createCallLog()
      const recording = withCallLog(subject, { mode: "record", log })
      let result: ProbeResult | undefined
      let failure: { name: string; message: string } | undefined
      try {
        result = await original(recording.context)
      } catch (error) {
        if (!(error instanceof Error)) throw error
        failure = { name: error.name, message: error.message }
      }
      recording.finish()
      const callback = {
        version: 1,
        runId,
        mode,
        featureId,
        pid: process.pid,
        startedAt,
        finishedAt: Date.now(),
        startedMonotonic,
        finishedMonotonic: performance.now(),
        firstEvent: 0,
        nextEvent: 0,
        events: [],
        log,
        result,
        failure,
      }
      writeFileSync(join(root, "spike-b", `${featureId}.json`), JSON.stringify(callback))
      run.rawReplies[featureId] = JSON.stringify({ events: [] })
      run.results.push(
        recordExecutedCapability({
          featureId,
          attempt: { scope: "probe", startedAt: new Date(startedAt).toISOString() },
          observation: result?.observation
            ? { featureId, ...result.observation }
            : {
                featureId,
                outcome: "error",
                reason: "collector-error",
                evidence: "none",
                note: failure?.message,
              },
          assertions: [],
        }),
      )
    }
    writeFileSync(join(root, "v3-capture.json"), JSON.stringify(run))
    writeFileSync(join(root, "artifacts", `${runId}.draft.json`), JSON.stringify(run) + "\n")
    writeFileSync(join(root, "artifacts", frameName), png)
  }
  const replayPath = fileURLToPath(new URL("./replay.ts", import.meta.url))
  const invoke = (label: string) =>
    spawnSync(process.execPath, [replayPath, ...roots, join(directory, label)], {
      encoding: "utf8",
      timeout: 10_000,
    })
  const accepted = invoke("accepted")
  expect(accepted.status, accepted.stderr).toBe(0)
  const bundle = JSON.parse(readFileSync(join(directory, "accepted", "bundle.json"), "utf8")) as {
    artifacts: Array<{ mode: string; filename: string; sha256: string; dataBase64: string }>
  }
  expect(bundle.artifacts).toHaveLength(6)
  for (const [index, mode] of modes.entries()) {
    const filename = `${index + 1}`.repeat(32) + ".draft.json"
    const bytes = readFileSync(join(roots[index]!, "artifacts", filename))
    expect(bundle.artifacts.find((artifact) => artifact.mode === mode && artifact.filename === filename)).toMatchObject(
      { sha256: digest(bytes), dataBase64: bytes.toString("base64") },
    )
  }
  const summary = JSON.parse(readFileSync(join(directory, "accepted", "summary.json"), "utf8")) as {
    frameShapeMeasured: boolean
  }
  expect(summary.frameShapeMeasured).toBe(false)
  const decoratedArtifacts = join(roots[2]!, "artifacts")
  writeFileSync(join(decoratedArtifacts, frameName), "tampered")
  const tampered = invoke("tampered")
  expect(tampered.status).not.toBe(0)
  expect(tampered.stderr).toContain(`Retained capture digest differs: decorated/${frameName}`)
  expect(existsSync(join(directory, "tampered", "bundle.json"))).toBe(false)
  writeFileSync(join(decoratedArtifacts, frameName), png)
  for (const filename of ["unrelated.txt", "unrelated.draft.json"]) {
    writeFileSync(join(decoratedArtifacts, filename), "unrecognized")
    const refused = invoke(filename)
    expect(refused.status).not.toBe(0)
    expect(refused.stderr).toContain(`Retained capture digest differs: decorated/${filename}`)
    unlinkSync(join(decoratedArtifacts, filename))
  }
  const failedDraft = {
    schemaVersion: 3,
    runId: "3".repeat(32),
    rawReplies: { "collector.prerequisite": "Synthetic prerequisite failure" },
    results: [],
  }
  writeFileSync(join(decoratedArtifacts, `${failedDraft.runId}.draft.json`), JSON.stringify(failedDraft))
  unlinkSync(join(roots[2]!, "v3-capture.json"))
  const incomplete = invoke("draft-only")
  expect(incomplete.status).not.toBe(0)
  expect(incomplete.stderr).toContain("v3-capture.json")
  expect(existsSync(join(directory, "draft-only", "bundle.json"))).toBe(false)
})
