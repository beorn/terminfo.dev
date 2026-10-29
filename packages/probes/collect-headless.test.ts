/**
 * @failure A worker crash loses its initialized statuses or identity; successful collection seals a pending review.
 * @level l2
 * @consumer Headless collection coordinator and delegated capture writer
 * @reach fs-walk <fixture-only: coordinator enumerates its owned temporary worker output>
 * @testonly none
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, expect, it, vi } from "vitest"
import type { CapturedRunDraft, RunDraft } from "@terminfo/probe-defs"
import { parseRun } from "@terminfo/run-parser"
import { collectHeadlessRuns } from "./collect-headless.ts"
import { probeSuiteSnapshot } from "../admin/versions.ts"
import { saveDaemonProbeRun } from "../terminfo.dev/src/daemon-client.ts"
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
          { id: "review", status: "test-todo", attempt: { scope: "none" }, reason: "Context review pending" },
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
      ids: ["device.primary-da"], result: "completed", startedAt: expect.any(String),
    })
    expect(readFileSync(capturePath, "utf8")).toBe(captureBytes)
    const suite = probeSuiteSnapshot()
    parseRun(
      path,
      readFileSync(path, "utf8"),
      suite.catalogIds!,
      new Map([[suite.probeHash, suite]]),
      pendingReview ? { mode: "capture" } : undefined,
    )
    if (pendingReview) {
      expect(path).toMatch(/\.draft\.json$/)
      expect(saved).not.toHaveProperty("sealedAt")
      expect(saved.rawReplies["collector.capture.device.primary-da"]).toBeTruthy()
      expect(saved.results.find((row) => row.featureId === "device.primary-da")?.tests[0]?.status).toBe("test-todo")
      const pendingBytes = readFileSync(path, "utf8")
      const review = JSON.stringify({
        id: "headless-context-review",
        runId: saved.runId,
        featureId: "device.primary-da",
        captureSha256: createHash("sha256")
          .update(saved.rawReplies["collector.capture.device.primary-da"]!)
          .digest("hex"),
        decision: "untestable",
        reviewed: true,
        reviewer: "reviewer",
        reason: "Fixture context has no reply channel",
        scope: {
          subject: { kind: "lib", id: "xtermjs" },
          versions: ["6.0.0", "6.0.0"],
          suites: [saved.probeHash, saved.probeHash],
        },
        sources: ["collector.capture.device.primary-da"],
        supersedes: [],
      })
      const resumed = saveDaemonProbeRun(saved, dir, undefined, {
        manifest: suite,
        decisions: [{ source: review, startedAt: "2026-10-21T13:00:00.000Z" }],
        origin: () => undefined,
      })
      const final = parseRun(
        resumed,
        readFileSync(resumed, "utf8"),
        suite.catalogIds!,
        new Map([[suite.probeHash, suite]]),
      )
      expect(final.runId).toBe(saved.runId)
      expect(final.results?.find((row) => row.featureId === "device.primary-da")?.status).toBe("untestable")
      expect(readFileSync(path, "utf8")).toBe(pendingBytes)
    } else {
      expect(path).not.toMatch(/\.draft\.json$/)
      expect(saved).toHaveProperty("sealedAt")
    }
  },
)
// The real worker loads headless-identity.ts, which requires the owned vterm checkout beside this one;
// standalone component CI tests out terminfo.dev alone, so this runs wherever that layout exists.
const OWNED_LAYOUT = existsSync(fileURLToPath(new URL("../../../vterm", import.meta.url)))
// The fixture tests above never send a collector-written draft through the decoder that admit-run uses;
// this one runs the real xtermjs worker and the real admit-run --review. Admission itself writes the suite
// manifest and receipts into content/, so one review stays pending here: admit-run retains the reviewed
// draft and refuses admission, and the last pending decision seals through the same writer in-process.
// #31072: 38 required 250ms sentinel grace waits measured 9.6s of a 9.9s collection span.
// Keep those late-reply checks; allow this real-worker round trip the root suite's 30s budget.
it.runIf(OWNED_LAYOUT)(
  "reviews a draft the real headless collector wrote through admit-run --review",
  async () => {
    const root = fileURLToPath(new URL("../../", import.meta.url))
    const dirtySources = execFileSync("git", ["status", "--porcelain", "--", ...probeSuiteSnapshot().sourcePaths], {
      cwd: root,
      encoding: "utf8",
    }).trim()
    if (dirtySources) {
      throw new Error(
        `admit-run binds HEAD to the draft's sourceRevision; commit the dirty suite sources first:\n${dirtySources}`,
      )
    }
    const dir = directory()
    const collection = await collectHeadlessRuns(["xtermjs"], dir)
    expect(collection.failures).toEqual([])
    const draftPath = collection.runs[0]!
    expect(draftPath).toMatch(/\.draft\.json$/)
    const draft = JSON.parse(readFileSync(draftPath, "utf8")) as CapturedRunDraft
    const draftBytes = readFileSync(draftPath, "utf8")
    const pending = draft.results
      .filter((row) => row.tests.some((check) => check.id === "review" && check.status === "test-todo"))
      .map((row) => row.featureId)
      .sort()
    // #30699: the proven reply path makes these silent colour queries measured negatives.
    const colourReadback = [
      "extensions.osc104-reset-palette",
      "extensions.osc110-reset-fg",
      "extensions.osc111-reset-bg",
      "extensions.osc112-reset-cursor",
      "extensions.osc113-reset-pointer-fg",
      "extensions.osc114-reset-pointer-bg",
      "extensions.osc30001-color-stack-push",
      "extensions.osc30101-color-stack-pop",
    ]
    for (const featureId of colourReadback) {
      expect(
        draft.results.find((row) => row.featureId === featureId),
        featureId,
      ).toMatchObject({
        status: "unsupported",
        reason: "negative by sentinel",
        tests: [expect.objectContaining({ id: "criterion", status: "unsupported" })],
      })
    }
    expect(pending).toEqual([
      "extensions.clipboard-paste",
      "extensions.osc133-a",
      "extensions.osc133-b",
      "extensions.osc133-c",
      "extensions.osc133-d",
      "extensions.osc133-p",
      "extensions.osc633-a",
      "extensions.osc633-b",
      "extensions.osc633-c",
      "extensions.osc633-d",
      "extensions.osc633-e",
      "extensions.osc633-p",
      "input.button-event-mouse",
      "input.kitty-click-events",
      "input.modify-other-keys",
      "input.modify-other-keys-3",
      "input.pixel-mouse",
      "input.urxvt-mouse",
      "input.x10-mouse",
      "input.xtest-click",
      "input.xtest-key",
      "input.xtest-wheel",
      "modes.alt-scroll-1007",
      "modes.application-keypad",
    ])
    const decision = (featureId: string, reason: string) =>
      JSON.stringify({
        id: `round-trip-${featureId}`,
        runId: draft.runId,
        featureId,
        captureSha256: createHash("sha256").update(draft.rawReplies[`collector.capture.${featureId}`]!).digest("hex"),
        decision: "untestable",
        reviewed: true,
        reviewer: "collect-headless round-trip test",
        reason,
        scope: {
          subject: { kind: "lib", id: "xtermjs" },
          versions: [draft.subject.version, draft.subject.version],
          suites: [draft.probeHash, draft.probeHash],
        },
        sources: [`collector.capture.${featureId}`],
        supersedes: [],
      })
    const reason = (featureId: string) =>
      `Embedded xterm.js injects no OS-level input, so ${featureId} has no path to the engine`
    const reviewed = pending.slice(0, -1)
    const sealing = pending[pending.length - 1]!
    const reviewPaths = reviewed.map((featureId, index) => {
      const path = join(dir, `review-${index}.json`)
      writeFileSync(path, decision(featureId, reason(featureId)))
      return path
    })
    const startedAt = new Date().toISOString()
    const result = Bun.spawnSync(
      [
        "bun",
        "scripts/admit-run.ts",
        "--for",
        draftPath,
        ...reviewPaths.flatMap((path) => ["--review", path]),
        "--review-started-at",
        startedAt,
      ],
      { cwd: root, stdout: "pipe", stderr: "pipe" },
    )
    const stdout = new TextDecoder().decode(result.stdout)
    const stderr = new TextDecoder().decode(result.stderr)
    expect(stderr, stdout).not.toContain("requires unverified measured identity")
    const retainedPath = /Retained reviewed capture (.+); original draft unchanged/.exec(stdout)?.[1]
    expect(retainedPath, `${stdout}\n${stderr}`).toBeTruthy()
    expect(stderr).toContain("Required reviews remain pending")
    expect(result.exitCode).toBe(1)
    expect(readFileSync(draftPath, "utf8")).toBe(draftBytes)
    const suite = probeSuiteSnapshot()
    const suites = new Map([[suite.probeHash, suite]])
    const retained = parseRun(retainedPath!, readFileSync(retainedPath!, "utf8"), suite.catalogIds!, suites, {
      mode: "capture",
    })
    for (const featureId of reviewed) {
      const row = retained.results?.find((entry) => entry.featureId === featureId)
      expect(row?.status, featureId).toBe("untestable")
      const check = row?.tests?.find((entry) => entry.id === "review")
      expect(check?.status, featureId).toBe("untestable")
      expect(check?.reviewRef, featureId).toBe(`collector.review.round-trip-${featureId}`)
    }
    expect(retained.results?.find((entry) => entry.featureId === sealing)?.status).toBe("test-todo")
    const sealedPath = saveDaemonProbeRun(
      JSON.parse(readFileSync(retainedPath!, "utf8")) as CapturedRunDraft,
      dir,
      undefined,
      {
        manifest: suite,
        origin: () => undefined,
        decisions: [
          {
            source: decision(sealing, reason(sealing)),

            startedAt,
          },
        ],
      },
    )
    expect(sealedPath).not.toMatch(/\.draft\.json$/)
    const sealed = parseRun(sealedPath, readFileSync(sealedPath, "utf8"), suite.catalogIds!, suites)
    expect(sealed.sealedAt).toBeTruthy()
    for (const featureId of pending) {
      expect(sealed.results?.find((entry) => entry.featureId === featureId)?.status, featureId).toBe("untestable")
    }
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
    expect(draft.results.every((result) => result.status === "test-todo")).toBe(true)
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
  expect(draft.results.every((result) => result.status === "test-todo" && result.attempt.scope === "none")).toBe(true)
  expect(draft).not.toHaveProperty("target")
  expect(JSON.parse(draft.rawReplies["collector.selection"]!)).toEqual({ ids: probeSuiteSnapshot().probes.lib })
  const attempt = JSON.parse(draft.rawReplies["collector.collectionAttempt"]!)
  expect(attempt).toMatchObject({ result: "failed", error: expect.stringContaining("missing pinned package") })
  expect(attempt).not.toHaveProperty("startedAt")
})
it("records an attempted selected worker timeout without changing unselected rows or suite membership", async () => {
  vi.useFakeTimers()
  const dir = directory()
  let captureRunId: string | undefined
  let unselectedRows: RunDraft["results"] = []
  vi.spyOn(Bun, "spawn").mockImplementation(((_argv: unknown, options: { env: Record<string, string> }) => {
    captureRunId = options.env.TERMINFO_CAPTURE_RUN_ID
    unselectedRows = retainedDraft(dir).results.filter((row) => row.featureId !== "device.primary-da")
    let finish!: (code: number) => void
    const exited = new Promise<number>((resolve) => {
      finish = resolve
    })
    return {
      stdout: new Blob([]).stream(),
      stderr: new Blob(["worker diagnostic"]).stream(),
      exited,
      kill: () => finish(143),
    }
  }) as never)
  const ids = ["device.primary-da"]
  const pending = collectHeadlessRuns(["libvterm"], dir, undefined, ids)
  await vi.advanceTimersByTimeAsync(120_000)
  const collection = await pending
  const draft = retainedDraft(dir)
  expect(collection.failures[0]?.error).toContain("exceeded")
  expect(draft.runId).toBe(captureRunId)
  expect(draft.results).toHaveLength(273)
  expect(draft.results.filter((row) => row.featureId !== "device.primary-da")).toEqual(unselectedRows)
  const delegated = new Set(ids)
  expect(JSON.parse(draft.rawReplies["collector.selection"]!)).toEqual({ ids })
  expect(JSON.parse(draft.rawReplies["collector.collectionAttempt"]!)).toMatchObject({
    ids, result: "failed", startedAt: expect.any(String), error: expect.stringContaining("exceeded"),
  })
  expect(
    draft.results
      .filter((result) => delegated.has(result.featureId))
      .every((result) => result.status === "test-failure" && result.attempt.scope === "collection"),
  ).toBe(true)
  expect(
    draft.results
      .filter((result) => !delegated.has(result.featureId))
      .every((result) => result.status === "test-todo" && result.attempt.scope === "none"),
  ).toBe(true)
  expect(draft.rawReplies["collector.failure"]).toContain("exceeded")
  expect(draft).not.toHaveProperty("target")
})
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
      for (const result of draft.results) if (result.status === "test-todo") result.reason = prereq
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
  const spawn = vi.spyOn(Bun, "spawn").mockImplementation(() => { throw new Error("Unexpected empty-selection worker") })
  const collection = await collectHeadlessRuns(["libvterm"], dir, undefined, [])
  expect(spawn).not.toHaveBeenCalled()
  expect(collection.runs).toEqual([])
  expect(collection.failures).toEqual([])
  const draft = retainedDraft(dir)
  expect(JSON.parse(draft.rawReplies["collector.selection"]!)).toEqual({ ids: [] })
  expect(JSON.parse(draft.rawReplies["collector.collectionAttempt"]!)).toEqual({ ids: [], result: "empty" })
  expect(draft.results).toHaveLength(273)
  expect(draft.results.every((row) => row.status === "test-todo" && row.attempt.scope === "none")).toBe(true)
  expect(draft.probeHash).toBe(probeSuiteSnapshot().probeHash)
})
it("rejects unknown exact probe IDs before any worker starts", async () => {
  const spawn = vi.spyOn(Bun, "spawn").mockImplementation(() => { throw new Error("Unexpected unknown-selection worker") })
  await expect(collectHeadlessRuns(["libvterm"], directory(), undefined, ["missing.probe"]))
    .rejects.toThrow("Unknown probe: missing.probe")
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
      stdout: new Blob([]).stream(), stderr: new Blob([`Error: ${originalError}`]).stream(),
      exited: Promise.resolve(code), kill: vi.fn(),
    }
  }) as never)
  const collection = await collectHeadlessRuns(["libvterm"], dir, undefined, ids)
  expect(collection.failures).toHaveLength(1)
  expect(collection.failures[0]?.error).toContain(originalError)
  const draft = retainedDraft(dir)
  expect(draft.runId).toBe(runId)
  const attempt = JSON.parse(draft.rawReplies["collector.collectionAttempt"]!)
  expect(attempt).toMatchObject({ ids, result, error: expect.stringContaining(originalError) })
  if (started) expect(attempt.startedAt).toEqual(expect.any(String))
  else expect(attempt).not.toHaveProperty("startedAt")
  expect(JSON.parse(draft.rawReplies["collector.selection"]!)).toEqual({ ids })
  if (result === "cancelled" || !started) {
    expect(draft.results.every((row) => row.attempt.scope === "none")).toBe(true)
  }
  expect(draft.results.filter((row) => !ids.includes(row.featureId))
    .every((row) => row.status === "test-todo" && row.attempt.scope === "none")).toBe(true)
})
