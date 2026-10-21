/**
 * @failure A worker crash loses its initialized statuses or identity; successful collection seals a pending review.
 * @level l2
 * @consumer Headless collection coordinator and delegated capture writer
 * @reach fs-walk <fixture-only: coordinator enumerates its owned temporary worker output>
 * @testonly none
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
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
// The writer tests cover review decisions, but cannot catch a coordinator that seals before them.
it.each([true, false])(
  "retains the successful capture with pending review=%s through the shared writer",
  async (pendingReview) => {
    const dir = directory()
    let capturePath = ""
    let captureBytes = ""
    vi.spyOn(Bun, "spawn").mockImplementation(((_argv: unknown, options: { env: Record<string, string> }) => {
      const draft = JSON.parse(readFileSync(options.env.TERMINFO_DRAFT_PATH!, "utf8")) as RunDraft
      const run: CapturedRunDraft = {
        ...draft,
        target: {
          kind: "headless",
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
        result.checks = [
          { id: "review", status: "test-todo", attempt: { scope: "none" }, reason: "Context review pending" },
        ]
        result.reason = "Context review pending"
      }
      capturePath = join(dir, `xtermjs-${run.runId}.capture.json`)
      captureBytes = JSON.stringify(run)
      writeFileSync(capturePath, captureBytes)
      return { stdout: new Blob([]).stream(), stderr: new Blob([]).stream(), exited: Promise.resolve(0), kill: vi.fn() }
    }) as never)
    const collection = await collectHeadlessRuns(["xtermjs"], dir)
    expect(collection.failures).toEqual([])
    expect(collection.runs).toHaveLength(1)
    const path = collection.runs[0]!
    const saved = JSON.parse(readFileSync(path, "utf8")) as CapturedRunDraft
    const original = JSON.parse(captureBytes) as CapturedRunDraft
    expect(saved.runId).toBe(original.runId)
    expect(saved.target).toEqual(original.target)
    expect(saved.sourceRevision).toBe(original.sourceRevision)
    expect(saved.probeHash).toBe(original.probeHash)
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
      expect(saved.results.find((row) => row.featureId === "device.primary-da")?.checks[0]?.status).toBe("test-todo")
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
          target: { kind: "headless", id: "xtermjs" },
          versions: ["6.0.0", "6.0.0"],
          suites: [saved.probeHash, saved.probeHash],
        },
        sources: ["collector.capture.device.primary-da"],
        supersedes: [],
      })
      const resumed = saveDaemonProbeRun(saved, dir, undefined, [
        { source: review, startedAt: "2026-10-21T13:00:00.000Z" },
      ])
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
// The fixture tests above never send a collector-written draft through the decoder that admit-run uses;
// this one runs the real xtermjs worker and the real admit-run --review. Admission itself writes the suite
// manifest and receipts into content/, so one review stays pending here: admit-run retains the reviewed
// draft and refuses admission, and the fourth decision seals through the same writer in-process.
it("reviews a draft the real headless collector wrote through admit-run --review", async () => {
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
    .filter((row) => row.checks.some((check) => check.id === "review" && check.status === "test-todo"))
    .map((row) => row.featureId)
    .sort()
  // #30547: xterm.js answers none of the colour reset/stack readbacks, so those eight wait on review too.
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
  expect(pending).toEqual([
    "extensions.clipboard-paste",
    ...colourReadback,
    "input.xtest-click",
    "input.xtest-key",
    "input.xtest-wheel",
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
        target: { kind: "headless", id: "xtermjs" },
        versions: [draft.target.version, draft.target.version],
        suites: [draft.probeHash, draft.probeHash],
      },
      sources: [`collector.capture.${featureId}`],
      supersedes: [],
    })
  const reviewed: ReadonlyArray<readonly [string, string]> = [
    ["input.xtest-key", "Embedded xterm.js has no X server, so XTEST key injection has no path to the engine"],
    ["input.xtest-click", "Embedded xterm.js has no X server, so XTEST click injection has no path to the engine"],
    ["input.xtest-wheel", "Embedded xterm.js has no X server, so XTEST wheel injection has no path to the engine"],
    ...colourReadback.map(
      (featureId) =>
        [
          featureId,
          "@xterm/headless exposes no colour readback: onColor is internal and the Termless backend has no colour getter",
        ] as const,
    ),
  ]
  const reviewPaths = reviewed.map(([featureId, reason], index) => {
    const path = join(dir, `review-${index}.json`)
    writeFileSync(path, decision(featureId, reason))
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
  for (const [featureId] of reviewed) {
    const row = retained.results?.find((entry) => entry.featureId === featureId)
    expect(row?.status, featureId).toBe("untestable")
    const check = row?.checks?.find((entry) => entry.id === "review")
    expect(check?.status, featureId).toBe("untestable")
    expect(check?.reviewRef, featureId).toBe(`collector.review.round-trip-${featureId}`)
  }
  expect(retained.results?.find((entry) => entry.featureId === "extensions.clipboard-paste")?.status).toBe("test-todo")
  const sealedPath = saveDaemonProbeRun(
    JSON.parse(readFileSync(retainedPath!, "utf8")) as CapturedRunDraft,
    dir,
    undefined,
    [
      {
        source: decision(
          "extensions.clipboard-paste",
          "Embedded xterm.js has no system clipboard, so an XTEST paste has nothing to paste from",
        ),
        startedAt,
      },
    ],
  )
  expect(sealedPath).not.toMatch(/\.draft\.json$/)
  const sealed = parseRun(sealedPath, readFileSync(sealedPath, "utf8"), suite.catalogIds!, suites)
  expect(sealed.sealedAt).toBeTruthy()
  for (const featureId of pending) {
    expect(sealed.results?.find((entry) => entry.featureId === featureId)?.status, featureId).toBe("untestable")
  }
})

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
})
it("records an attempted worker timeout as collection FAILURE with retained diagnostics and the same runId", async () => {
  vi.useFakeTimers()
  const dir = directory()
  let captureRunId: string | undefined
  vi.spyOn(Bun, "spawn").mockImplementation(((_argv: unknown, options: { env: Record<string, string> }) => {
    captureRunId = options.env.TERMINFO_CAPTURE_RUN_ID
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
  const pending = collectHeadlessRuns(["libvterm"], dir)
  await vi.advanceTimersByTimeAsync(120_000)
  const collection = await pending
  const draft = retainedDraft(dir)
  expect(collection.failures[0]?.error).toContain("exceeded")
  expect(draft.runId).toBe(captureRunId)
  expect(draft.results).toHaveLength(273)
  const delegated = new Set(probeSuiteSnapshot().probes.headless)
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
