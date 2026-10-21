/**
 * @failure A worker crash loses its initialized 273 statuses, gets a second runId, or turns missing prerequisites into failures.
 * @level l2
 * @consumer Headless collection coordinator and delegated capture writer
 * @reach fs-walk <fixture-only: coordinator enumerates its owned temporary worker output>
 * @testonly none
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it, vi } from "vitest"
import type { RunDraft } from "@terminfo/probe-defs"
import { collectHeadlessRuns } from "./collect-headless.ts"
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
