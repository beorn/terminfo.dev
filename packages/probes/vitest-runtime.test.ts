/**
 * @failure Recorder checks lose their task, evaluate twice, stop at a soft mismatch, or reach the reporter before attachments finish.
 * @level l2
 * @consumer The approved Phase0 Terminfo recorder/check adapter on installed Vitest5.0.4.
 * @reach runs an isolated Vitest fixture with concurrent native soft failures, TaskMeta and artifact delivery.
 * @testonly none
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { expect, test } from "vitest"
import { createVitest, version, type Reporter } from "vitest/node"
import type { RuntimeArtifact } from "./fixtures/vitest-runtime.fixture.ts"

test("installed Vitest preserves task-owned checks and awaited reporter attachments", async () => {
  expect(version).toBe("5.0.4")
  const artifacts = new Map<string, RuntimeArtifact>()
  const artifactBytes = new Map<string, unknown>()
  const finalRecordBytes = new Map<string, unknown>()
  const matcherEvaluations: number[] = []
  const contracts: unknown[] = []
  const completed: Array<{ id: string; name: string; state: string; errors: string[]; attachmentsReady: boolean }> = []
  const directory = await mkdtemp(join(tmpdir(), "terminfo-vitest-runtime-"))
  const reporter: Reporter = {
    onTestModuleCollected(module) {
      for (const error of module.errors()) console.error("runtime fixture collection: " + error.message)
    },
    async onTestCaseArtifactRecord(task, artifact) {
      if (artifact.type !== "terminfo:runtime-proof") return
      const path = artifact.attachments?.[0]?.path
      if (!path) throw new Error("Vitest did not persist the recorded artifact attachment")
      artifacts.set(task.id, artifact)
      artifactBytes.set(task.id, JSON.parse(await readFile(path, "utf8")))
    },
    // Public TaskMeta survives failed tasks; final records are persisted here, never through final annotate.
    async onTestCaseResult(task) {
      const contract = task.meta().terminfoCheckContract
      if (contract) {
        contracts.push({ ...contract, state: task.result().state })
        return
      }
      const finalRecord = task.meta().terminfoRuntimeProof
      const evaluations = task.meta().terminfoMatcherEvaluations
      if (typeof evaluations === "number") matcherEvaluations.push(evaluations)
      if (!finalRecord)
        throw new Error(
          "Vitest did not deliver the failed task's final metadata: " +
            task
              .result()
              .errors?.map((error) => error.message)
              .join("; "),
        )
      const path = join(directory, `${task.id}.final.json`)
      await writeFile(path, JSON.stringify(finalRecord))
      finalRecordBytes.set(task.id, JSON.parse(await readFile(path, "utf8")))
      completed.push({
        id: task.id,
        name: task.name,
        state: task.result().state,
        errors: task.result().errors?.map((error) => error.message) ?? [],
        attachmentsReady: artifactBytes.has(task.id) && finalRecordBytes.has(task.id),
      })
    },
  }
  const runtime = await createVitest({
    root: dirname(import.meta.filename),
    config: false,
    include: ["fixtures/vitest-runtime.fixture.ts"],
    reporters: [reporter],
    attachmentsDir: directory,
    watch: false,
    maxWorkers: 1,
  })
  try {
    await runtime.start()
    expect(completed).toHaveLength(2)
    expect(contracts).toEqual([{ finishThrew: true, prematureCount: null, state: "failed" }])
    expect(Math.max(...matcherEvaluations)).toBe(4)
    expect(new Set(completed.map((task) => task.id)).size).toBe(2)
    for (const [label, value] of [
      ["left", 10],
      ["right", 20],
    ] as const) {
      const task = completed.find((item) => item.name === `native soft continuation ${label}`)
      expect(task).toMatchObject({
        state: "failed",
        errors: ["runtime proof deliberately includes a soft mismatch"],
        attachmentsReady: true,
      })
      if (!task) throw new Error(`Missing completed runtime fixture: ${label}`)
      const checks = [
        { taskId: task.id, label, received: value, expected: value + 1, ok: false },
        { taskId: task.id, label, received: value, expected: value, ok: true },
      ]
      expect(artifacts.get(task.id)).toMatchObject({ taskId: task.id, checks })
      const retainedChecks = [
        {
          step: 1,
          kind: "assertion",
          matcher: "toRecorderRuntimeEqual",
          arguments: [value + 1],
          expected: value + 1,
          actual: value,
          ok: false,
        },
        {
          step: 2,
          kind: "precondition",
          matcher: "toRecorderRuntimeEqual",
          arguments: [value],
          expected: value,
          actual: value,
          ok: true,
        },
      ]
      expect(artifacts.get(task.id)?.retainedChecks).toEqual(retainedChecks)
      expect(artifactBytes.get(task.id)).toEqual(retainedChecks)
      expect(finalRecordBytes.get(task.id)).toEqual({ taskId: task.id, checks, retainedChecks })
    }
    console.info(JSON.stringify({ vitest: version, completed, artifacts: [...artifacts.values()] }))
  } finally {
    await runtime.close()
    await rm(directory, { recursive: true, force: true })
  }
}, 60_000)
