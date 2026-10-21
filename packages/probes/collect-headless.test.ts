/**
 * @failure A worker crash loses its initialized statuses or identity; successful collection seals a pending review.
 * @level l2
 * @consumer Headless collection coordinator and delegated capture writer
 * @reach fs-walk <fixture-only: coordinator enumerates its owned temporary worker output>
 * @testonly none
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { tmpdir } from "node:os"
import { join } from "node:path"
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
