/**
 * @failure Recorder checks lose their task, evaluate twice, stop at a soft mismatch, or reach the reporter before attachments finish.
 * @level l2
 * @consumer The approved Phase0 Terminfo recorder/check adapter on installed Vitest5.0.4.
 * @reach runs an isolated Vitest fixture with concurrent native soft failures and artifact/annotation delivery.
 * @testonly none
 */
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { expect, test } from "vitest"
import { createVitest, version, type Reporter } from "vitest/node"
import type { RuntimeArtifact } from "./fixtures/vitest-runtime.fixture.ts"

test("installed Vitest preserves task-owned checks and awaited reporter attachments", async () => {
  expect(version).toBe("5.0.4")
  const artifacts = new Map<string, RuntimeArtifact>()
  const artifactBytes = new Map<string, unknown>()
  const annotationBytes = new Map<string, unknown>()
  const completed: Array<{ id: string; name: string; state: string; attachmentsReady: boolean }> = []
  const directory = await mkdtemp(join(tmpdir(), "terminfo-vitest-runtime-"))
  const reporter: Reporter = {
    async onTestCaseArtifactRecord(task, artifact) {
      if (artifact.type !== "terminfo:runtime-proof") return
      const path = artifact.attachments?.[0]?.path
      if (!path) throw new Error("Vitest did not persist the recorded artifact attachment")
      artifacts.set(task.id, artifact)
      artifactBytes.set(task.id, JSON.parse(await readFile(path, "utf8")))
    },
    async onTestCaseAnnotate(task, annotation) {
      const path = annotation.attachment?.path
      if (!path) throw new Error("Vitest did not persist the annotation attachment")
      annotationBytes.set(task.id, JSON.parse(await readFile(path, "utf8")))
    },
    onTestCaseResult(task) {
      completed.push({
        id: task.id,
        name: task.name,
        state: task.result().state,
        attachmentsReady: artifactBytes.has(task.id) && annotationBytes.has(task.id),
      })
    },
  }
  const runtime = await createVitest({
    root: dirname(import.meta.filename),
    config: false,
    include: ["fixtures/vitest-runtime.fixture.ts"],
    reporters: [reporter],
    api: { allowWrite: true },
    attachmentsDir: directory,
    watch: false,
    maxWorkers: 1,
  })
  try {
    await runtime.start()
    expect(completed).toHaveLength(2)
    expect(new Set(completed.map((task) => task.id)).size).toBe(2)
    for (const [label, value] of [
      ["left", 10],
      ["right", 20],
    ] as const) {
      const task = completed.find((item) => item.name === `native soft continuation ${label}`)
      expect(task).toMatchObject({ state: "passed", attachmentsReady: true })
      if (!task) throw new Error(`Missing completed runtime fixture: ${label}`)
      const checks = [
        { taskId: task.id, label, received: value, expected: value + 1, ok: false },
        { taskId: task.id, label, received: value, expected: value, ok: true },
      ]
      expect(artifacts.get(task.id)).toMatchObject({ taskId: task.id, checks })
      expect(artifactBytes.get(task.id)).toEqual(checks)
      expect(annotationBytes.get(task.id)).toEqual(checks)
    }
    console.info(JSON.stringify({ vitest: version, completed, artifacts: [...artifacts.values()] }))
  } finally {
    await runtime.close()
    await rm(directory, { recursive: true, force: true })
  }
}, 60_000)
