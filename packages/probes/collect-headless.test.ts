/**
 * @failure A worker crash loses its initialized statuses or identity; successful collection seals a pending review.
 * @level l2
 * @consumer Headless collection coordinator and delegated capture writer
 * @reach fs-walk <fixture-only: coordinator enumerates its owned temporary worker output>
 * @testonly none
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, expect, it, vi } from "vitest"
import {
  HEADLESS_OBSERVABLE_REVIEW,
  readCollectorAttempt,
  SOURCE_NEGATIVE_REVIEW,
  type CapturedRunDraft,
  type RunDraft,
} from "@terminfo/probe-defs"
import { parseRun } from "@terminfo/run-parser"
import { collectHeadlessRuns } from "./collect-headless.ts"
import { OWNED_LAYOUT } from "./fixtures/owned-layout.fixture.ts"
import { probeSuiteSnapshot } from "../admin/versions.ts"
const dirs: string[] = []
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
const directory = () => {
  const path = mkdtempSync(join(tmpdir(), "terminfo-worker-contract-"))
  dirs.push(path)
  return path
}
const retainedDraft = (dir: string): RunDraft => {
  const file = readdirSync(dir).find((entry) => entry.endsWith(".draft.json"))
  if (!file) throw new Error("Expected initialized delegated draft")
  return JSON.parse(readFileSync(join(dir, file), "utf8")) as RunDraft
}
// AC1/AC3: the writer tests cannot catch lost pre-dispatch selection or a coordinator that seals before review.
it.each([true, false])(
  "retains the successful capture with pending review=%s through the shared writer",
  async (pendingReview) => {
    const dir = directory()
    let capturePath = ""
    let captureBytes = ""
    vi.spyOn(Bun, "spawn").mockImplementation(((_argv: unknown, options: { env: Record<string, string> }) => {
      const draft = JSON.parse(readFileSync(options.env.TERMINFO_DRAFT_PATH!, "utf8")) as RunDraft
      expect(draft.rawReplies["collector.selection"]).toBe(JSON.stringify({ ids: ["device.primary-da"] }))
      const run: CapturedRunDraft = {
        ...draft,
        subject: {
          kind: "lib",
          id: "xtermjs",
          version: "6.0.0",
          os: "linux",
          osVersion: null,
          outerTerminal: null,
          mux: null,
          config: null,
          permissions: null,
        },
        identity: "unverified",
        runtimeIdentity: {
          kind: "js",
          runtimeFormat: "js",
          engineVersion: "6.0.0",
          adapterVersion: "0.1.0",
          termlessRevision: "a".repeat(40),
          resolvedPath: "/fixture/xterm.js",
          integrity: { kind: "registry", lockIntegrity: "sha512-fixture" },
        },
        measuredAt: "2026-10-21T12:00:00.000Z",
        origin: { kind: "collector" },
        screenshotRefs: [],
      }
      if (pendingReview) {
        const result = run.results.find((row) => row.featureId === "device.primary-da")!
        result.tests = [
          { id: "review", status: "probe-todo", attempt: { scope: "none" }, reason: "Context review pending" },
        ]
        result.reason = "Context review pending"
      }
      capturePath = join(dir, `xtermjs-${run.runId}.capture.json`)
      captureBytes = JSON.stringify(run)
      writeFileSync(capturePath, captureBytes)
      return { stdout: new Blob([]).stream(), stderr: new Blob([]).stream(), exited: Promise.resolve(0), kill: vi.fn() }
    }) as never)
    const collection = await collectHeadlessRuns(["xtermjs"], dir, undefined, ["device.primary-da"])
    expect(collection.failures).toEqual([])
    expect(collection.runs).toHaveLength(1)
    const path = collection.runs[0]!
    const saved = JSON.parse(readFileSync(path, "utf8")) as CapturedRunDraft
    const original = JSON.parse(captureBytes) as CapturedRunDraft
    expect(saved.runId).toBe(original.runId)
    expect(saved.subject).toEqual(original.subject)
    expect(saved.sourceRevision).toBe(original.sourceRevision)
    expect(saved.probeHash).toBe(original.probeHash)
    expect(JSON.parse(saved.rawReplies["collector.collectionAttempt"]!)).toMatchObject({
      ids: ["device.primary-da"],
      result: "completed",
      startedAt: expect.any(String),
    })
    expect(readFileSync(capturePath, "utf8")).toBe(captureBytes)
    const suite = probeSuiteSnapshot()
    parseRun(path, readFileSync(path, "utf8"), suite.catalogIds!, new Map([[suite.probeHash, suite]]))
    // Raw collection is never END; existing writer tests cannot observe coordinator custody.
    expect(path).toMatch(/\.draft\.json$/)
    expect(saved).not.toHaveProperty("sealedAt")
    if (pendingReview) {
      expect(saved.results.find((row) => row.featureId === "device.primary-da")?.tests[0]?.status).toBe("probe-todo")
      expect(saved.rawReplies["collector.capture.device.primary-da"]).toBeUndefined()
    }
  },
)
// The real worker loads headless-identity.ts, which requires the owned vterm checkout beside this one;
// standalone component CI tests out terminfo.dev alone, so this runs wherever that layout exists.
// AC1: mocked coordinator tests cannot detect a worker still passing ALL_PROBES to the batch.
// This existing worker boundary measures one embedded fixture backend, never a Terminal app.
it.runIf(OWNED_LAYOUT)(
  "executes only selected callbacks in the real headless worker",
  async () => {
    const collection = await collectHeadlessRuns(["xtermjs"], directory(), undefined, ["sgr.bold"])
    expect(collection.failures).toEqual([])
    expect(collection.runs).toHaveLength(1)
    const draft = JSON.parse(readFileSync(collection.runs[0]!, "utf8")) as CapturedRunDraft
    expect(draft.results.filter((row) => row.attempt.scope !== "none").map((row) => row.featureId)).toEqual([
      "sgr.bold",
    ])
    expect(JSON.parse(draft.rawReplies["collector.selection"]!)).toEqual({ ids: ["sgr.bold"] })
    expect(readCollectorAttempt(draft.rawReplies)?.result).toBe("completed")
    expect(draft.results).toHaveLength(273)
  },
  30_000,
)
// Batch callback tests do not exercise worker creation/timeouts: these invoke the real coordinator
// with only its process actuator replaced, so no engine or terminal is launched.
it("initializes all 273 before worker launch and retains explicit missing prerequisites as TODO", async () => {
  const dir = directory()
  let captureRunId: string | undefined
  vi.spyOn(Bun, "spawn").mockImplementation(((_argv: unknown, options: { env: Record<string, string> }) => {
    captureRunId = options.env.TERMINFO_CAPTURE_RUN_ID
    const draft = retainedDraft(dir)
    expect(draft.runId).toBe(captureRunId)
    expect(draft.results).toHaveLength(273)
    expect(draft.results.every((result) => result.status === "probe-todo")).toBe(true)
    draft.rawReplies["collector.prerequisite"] = "Pinned engine package is not installed"
    writeFileSync(options.env.TERMINFO_DRAFT_PATH!, JSON.stringify(draft))
    return {
      stdout: new Blob([]).stream(),
      stderr: new Blob(["Error: missing pinned package"]).stream(),
      exited: Promise.resolve(1),
      kill: vi.fn(),
    }
  }) as never)
  const collection = await collectHeadlessRuns(["libvterm"], dir)
  const draft = retainedDraft(dir)
  expect(collection.runs).toEqual([])
  expect(collection.failures).toHaveLength(1)
  expect(draft.runId).toBe(captureRunId)
  expect(draft.results.every((result) => result.status === "probe-todo" && result.attempt.scope === "none")).toBe(true)
  expect(draft).not.toHaveProperty("target")
  expect(JSON.parse(draft.rawReplies["collector.selection"]!)).toEqual({ ids: probeSuiteSnapshot().probes.lib })
  const attempt = readCollectorAttempt(draft.rawReplies)
  expect(attempt).toMatchObject({ result: "failed", error: expect.stringContaining("missing pinned package") })
  expect(attempt).not.toHaveProperty("startedAt")
})
it.each([false, true])(
  "records an attempted selected worker timeout with finalization refusal=%s without changing unselected rows or suite membership",
  async (refused) => {
    vi.useFakeTimers()
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    const dir = directory()
    let captureRunId: string | undefined
    let unselectedRows: RunDraft["results"] = []
    vi.spyOn(Bun, "spawn").mockImplementation(((_argv: unknown, options: { env: Record<string, string> }) => {
      captureRunId = options.env.TERMINFO_CAPTURE_RUN_ID
      unselectedRows = retainedDraft(dir).results.filter((row) => row.featureId !== "device.primary-da")
      if (refused) {
        // A secondary custody refusal must not hide the original process failure.
        // Other timeout fixtures contain no host records and cannot reach that catch.
        const draft = retainedDraft(dir)
        draft.rawReplies["collector.collectionAttempt"] = JSON.stringify({
          ids: ["device.primary-da"],
          startedAt: new Date().toISOString(),
          result: "started",
        })
        draft.rawReplies["collector.hostRecipes.device.primary-da"] = "{}"
        draft.rawReplies["collector.failure"] = "original worker failure"
        writeFileSync(options.env.TERMINFO_DRAFT_PATH!, JSON.stringify(draft))
      }
      let finish!: (code: number) => void
      const exited = new Promise<number>((resolve) => {
        finish = resolve
      })
      return {
        stdout: new Blob([]).stream(),
        stderr: new Blob(["worker diagnostic"]).stream(),
        exited,
        kill: () => {
          killedAt ??= Date.now() - startedAt
          finish(143)
        },
      }
    }) as never)
    const ids = ["device.primary-da"]
    const startedAt = Date.now()
    let killedAt: number | undefined
    const pending = collectHeadlessRuns(["libvterm"], dir, undefined, ids)
    // 31693: kitty's full suite needs about 110-125 s at nice 10 under host load; the old 120 s ceiling killed it.
    await vi.advanceTimersByTimeAsync(120_000)
    expect(killedAt).toBeUndefined()
    await vi.advanceTimersByTimeAsync(480_000)
    expect(killedAt).toBe(600_000)
    const collection = await pending
    const draft = retainedDraft(dir)
    expect(collection.failures[0]?.error).toContain("exceeded")
    expect(draft.runId).toBe(captureRunId)
    expect(draft.results).toHaveLength(273)
    expect(draft.results.filter((row) => row.featureId !== "device.primary-da")).toEqual(unselectedRows)
    const delegated = new Set(ids)
    expect(JSON.parse(draft.rawReplies["collector.selection"]!)).toEqual({ ids })
    expect(JSON.parse(draft.rawReplies["collector.collectionAttempt"]!)).toMatchObject({
      ids,
      result: refused ? "started" : "failed",
      startedAt: expect.any(String),
      ...(!refused && { error: expect.stringContaining("exceeded") }),
    })
    if (refused) {
      expect(draft.rawReplies["collector.finalizationFailure"]).toMatch(/identity|expectations/)
      expect(
        stderr.mock.calls.some(
          ([message]) =>
            String(message).includes("Attempt finalization refused after") && String(message).includes("exceeded"),
        ),
      ).toBe(true)
      expect(draft.rawReplies["collector.hostRecipes.device.primary-da"]).toBe("{}")
    }
    expect(
      draft.results
        .filter((result) => delegated.has(result.featureId))
        .every((result) => result.status === "probe-invalid" && result.attempt.scope === "collection"),
    ).toBe(true)
    expect(
      draft.results
        .filter((result) => !delegated.has(result.featureId))
        .every((result) => result.status === "probe-todo" && result.attempt.scope === "none"),
    ).toBe(true)
    expect(draft.rawReplies["collector.failure"]).toContain(refused ? "original worker failure" : "exceeded")
    expect(draft).not.toHaveProperty("target")
  },
)
it("scrubs absolute host folder prefixes from recorded draft failures while keeping full paths in terminal errors", async () => {
  const dir = directory()
  const receiptPath = "/hh/var/wt/seat/vendor/termless/packages/libvterm/wasm/libvterm.wasm.receipt.json"
  const prereqPath = "/Users/alice/work/vendor/termless/packages/xtermjs/src/index.ts"
  const winPath = "C:\\Users\\alice\\work\\vendor\\termless\\packages\\xtermjs\\dist\\xterm.wasm"
  const sshUrl = "ssh://git@github.com/o/r"
  const httpsUrl = "https://terminfo.dev/docs/capture"
  vi.spyOn(Bun, "spawn").mockImplementation(((argv: string[], options: { env: Record<string, string> }) => {
    const backend = argv[3]
    if (backend === "xtermjs") {
      const draft = JSON.parse(readFileSync(options.env.TERMINFO_DRAFT_PATH!, "utf8")) as RunDraft
      const prereq = `Termless adapter @termless/xtermjs resolved to ${prereqPath} (win=${winPath}, upstream=${sshUrl}, docs=${httpsUrl}), which is not inside a Git checkout`
      draft.rawReplies["collector.prerequisite"] = prereq
      for (const result of draft.results) if (result.status === "probe-todo") result.reason = prereq
      writeFileSync(options.env.TERMINFO_DRAFT_PATH!, `${JSON.stringify(draft, null, 2)}\n`)
      return {
        stdout: new Blob([]).stream(),
        stderr: new Blob([`Error: ${prereq}\n`]).stream(),
        exited: Promise.resolve(1),
        kill: vi.fn(),
      }
    }
    return {
      stdout: new Blob([]).stream(),
      stderr: new Blob([
        `Error: libvterm build receipt is missing or does not match loaded WASM/JS: ${receiptPath}\n`,
      ]).stream(),
      exited: Promise.resolve(1),
      kill: vi.fn(),
    }
  }) as never)
  const collection = await collectHeadlessRuns(["xtermjs", "libvterm"], dir)
  expect(collection.failures).toHaveLength(2)
  // AC2: local terminal diagnostics and stderr files keep the full paths unchanged.
  expect(collection.failures[0]?.error).toContain(prereqPath)
  expect(collection.failures[0]?.error).toContain(winPath)
  expect(collection.failures[1]?.error).toContain(receiptPath)
  expect(collection.failures[1]?.error).toContain(join(dir, "libvterm.stderr.txt"))
  expect(readFileSync(join(dir, "libvterm.stderr.txt"), "utf8")).toContain(receiptPath)

  // AC1: recorded run drafts keep filenames without any host folder segments, and preserve URL schemes.
  const files = readdirSync(dir).filter((entry) => entry.endsWith(".draft.json"))
  expect(files).toHaveLength(2)
  const xtermFile = files.find((file) => file.startsWith("xtermjs-"))
  const libvtermFile = files.find((file) => file.startsWith("libvterm-"))
  if (!xtermFile || !libvtermFile) throw new Error("Expected both retained engine draft files")
  const xtermDraftBytes = readFileSync(join(dir, xtermFile), "utf8")
  const libvtermDraftBytes = readFileSync(join(dir, libvtermFile), "utf8")
  expect(xtermDraftBytes).toContain("index.ts")
  expect(xtermDraftBytes).toContain("win=xterm.wasm")
  expect(xtermDraftBytes).toContain(`upstream=${sshUrl}`)
  expect(xtermDraftBytes).toContain(`docs=${httpsUrl}`)
  expect(xtermDraftBytes).not.toContain("/Users/alice")
  expect(xtermDraftBytes).not.toContain("C:\\\\Users\\\\alice")
  expect(xtermDraftBytes).not.toContain("vendor/termless")
  expect(libvtermDraftBytes).toContain("libvterm.wasm.receipt.json")
  expect(libvtermDraftBytes).toContain("stderr=libvterm.stderr.txt")
  expect(libvtermDraftBytes).not.toContain("/hh/var")
  expect(libvtermDraftBytes).not.toContain(dir)
})
it.runIf(OWNED_LAYOUT)(
  "worker --one records a failure without host folders while throwing the unchanged path to stderr",
  () => {
    const root = fileURLToPath(new URL("../../", import.meta.url))
    const dir = directory()
    const missingKitty = "/Users/alice/local/bin/missing-kitty"
    const child = Bun.spawnSync([process.execPath, "packages/probes/collect-headless.ts", "--one", "kitty", dir], {
      cwd: root,
      env: { ...process.env, KITTY_BINARY: missingKitty },
      stdout: "pipe",
      stderr: "pipe",
    })
    const stderr = new TextDecoder().decode(child.stderr)
    expect(child.exitCode).toBe(1)
    // AC2: the thrown error reaches the operator's terminal unchanged with the full path.
    expect(stderr).toContain(`KITTY_BINARY does not exist: ${missingKitty}`)
    // AC1: the draft written by collectOne records the failure without the path's folders.
    const draft = retainedDraft(dir)
    const draftBytes = JSON.stringify(draft)
    expect(draft.rawReplies["collector.failure"]).toContain("KITTY_BINARY does not exist: missing-kitty")
    expect(draftBytes).not.toContain("/Users/alice")
    expect(draftBytes).not.toContain("/local/bin")
  },
)

// AC1/AC3: whole-suite worker tests previously dispatched even an explicitly empty/unknown list,
// and had no typed record for cancellation or a refusal before a process actually started.
it("retains explicit empty probe selection without starting a worker or inventing a collection start", async () => {
  const dir = directory()
  const spawn = vi.spyOn(Bun, "spawn").mockImplementation(() => {
    throw new Error("Unexpected empty-selection worker")
  })
  const collection = await collectHeadlessRuns(["libvterm"], dir, undefined, [])
  expect(spawn).not.toHaveBeenCalled()
  expect(collection.runs).toEqual([])
  expect(collection.failures).toEqual([])
  const draft = retainedDraft(dir)
  expect(JSON.parse(draft.rawReplies["collector.selection"]!)).toEqual({ ids: [] })
  expect(JSON.parse(draft.rawReplies["collector.collectionAttempt"]!)).toEqual({ ids: [], result: "empty" })
  expect(draft.results).toHaveLength(273)
  expect(draft.results.every((row) => row.status === "probe-todo" && row.attempt.scope === "none")).toBe(true)
  expect(draft.probeHash).toBe(probeSuiteSnapshot().probeHash)
})
it("rejects unknown exact probe IDs before any worker starts", async () => {
  const spawn = vi.spyOn(Bun, "spawn").mockImplementation(() => {
    throw new Error("Unexpected unknown-selection worker")
  })
  await expect(collectHeadlessRuns(["libvterm"], directory(), undefined, ["missing.probe"])).rejects.toThrow(
    "Unknown probe: missing.probe",
  )
  expect(spawn).not.toHaveBeenCalled()
})
it.each([
  { name: "pre-start failure", code: undefined, result: "failed", started: false },
  { name: "cancelled worker", code: 143, result: "cancelled", started: true },
  { name: "failed worker", code: 1, result: "failed", started: true },
])("retains original selection and diagnostics after $name", async ({ code, result, started }) => {
  const dir = directory()
  const ids = ["device.primary-da"]
  const originalError = "fixture worker unavailable"
  let runId: string | undefined
  vi.spyOn(Bun, "spawn").mockImplementation(((_argv: unknown, options: { env: Record<string, string> }) => {
    const draft = retainedDraft(dir)
    runId = options.env.TERMINFO_CAPTURE_RUN_ID
    expect(draft.runId).toBe(runId)
    if (code === undefined) throw new Error(originalError)
    return {
      stdout: new Blob([]).stream(),
      stderr: new Blob([`Error: ${originalError}`]).stream(),
      exited: Promise.resolve(code),
      kill: vi.fn(),
    }
  }) as never)
  const collection = await collectHeadlessRuns(["libvterm"], dir, undefined, ids)
  expect(collection.failures).toHaveLength(1)
  expect(collection.failures[0]?.error).toContain(originalError)
  const draft = retainedDraft(dir)
  expect(draft.runId).toBe(runId)
  const attempt = readCollectorAttempt(draft.rawReplies)
  expect(attempt).toMatchObject({ ids, result, error: expect.stringContaining(originalError) })
  if (started) expect(attempt?.startedAt).toEqual(expect.any(String))
  else expect(attempt).not.toHaveProperty("startedAt")
  expect(JSON.parse(draft.rawReplies["collector.selection"]!)).toEqual({ ids })
  if (result === "cancelled" || !started) {
    expect(draft.results.every((row) => row.attempt.scope === "none")).toBe(true)
  }
  expect(
    draft.results
      .filter((row) => !ids.includes(row.featureId))
      .every((row) => row.status === "probe-todo" && row.attempt.scope === "none"),
  ).toBe(true)
})
